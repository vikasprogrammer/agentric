# Agent OS Apps — Implementation Plan

> **Status: BUILDING (2026-07-14).** Design of record for the **Apps** plane — hosting small
> server-side apps (a mini-CRM, an internal mini-tool) inside a tenant, built **by agents and humans
> only** (no bundled seed apps — the fleet writes them). Reuses two primitives Agent OS already ships:
> the `/terminal/` reverse-proxy machinery and the `launcher.ts` DynamicUser isolation daemon. Nothing
> here is a PaaS: an App is a supervised, uid-isolated Node process reached through the same
> authenticated proxy the terminal uses, and its only channel out is the same pre-auth loopback the
> agent MCP tools already use — so **every effect an App has (the HTTP into it, the agent it triggers,
> the data it writes) stays inside the gateway boundary.**
>
> **Shipped so far:**
> - **v0.196.0 — hosting core** (§1–3): `AppStore`, `AppSupervisor` (spawn + readiness + scale-to-zero
>   + resident restart + per-launch `AOS_APP_TOKEN`), and the login-gated `/apps/<slug>` HTTP+WS proxy
>   with trusted identity injection.
> - **v0.197.0 — authoring** (§6): the human console **Apps page** (create · manifest + capability
>   editor · source editor · publish/unpublish · open · stop · delete, owner/admin, `/api/apps/*`) and
>   the agent tools **`app_create` / `app_list` / `app_update`** (single-file `server.js` for v1, lands
>   proposed, posts an `app.proposed` review card; editing a live app unpublishes it for re-review).
>
> **Still to build:** `/api/app/dispatch` (§4), secrets (§4.1), Linux uid-isolation (§3.3),
> `app_history`/`app_revert` revisions, multi-file bundles (§6).

## 0. Where Apps sit relative to Sessions, Automations, Tasks, and the Library

Agent OS already hosts two kinds of running code: **sessions** (tmux-backed agent runs, proxied via
ttyd) and **triggers** (Automations firing sessions). It already *renders* one kind of app: a
published `.html` artifact in a **sandboxed, null-origin iframe** (`ArtifactBody`,
`web/src/App.tsx:3904`). That covers *static, client-side* mini-tools — but a null-origin sandbox
can't persist (localStorage throws), can't reload data, and can't reach the API. A **mini-CRM needs a
backend**: durable records + server logic.

Apps are the missing **long-lived, addressable, server-side unit** — a Node process + its own SQLite,
reachable at a stable URL, that humans use through a UI and that can trigger agents in the background.

| | Session | Automation | Artifact (HTML) | **App** |
|---|---|---|---|---|
| What it is | an ephemeral *run* | a firing *condition* | a *static render* | a **hosted server-side app** |
| Lifetime | dies when done | standing | snapshot at publish | **installed → running (scale-to-zero), long-lived** |
| Code | agent + claude | — | client-side JS only | **Node stdlib + SQLite** |
| Reached at | ttyd proxy | — | Library preview | **`/apps/<slug>/…` authed proxy** |
| Persistence | — | — | none (null origin) | **own `data.db`** |
| Isolation | per-member uid (Phase A) | — | iframe sandbox | **per-app DynamicUser + slice** |
| Effects out | gateway (gate hook) | gateway | none | **gateway via `/api/app/*` loopback** |
| Built by | — | owner/admin | agent `publish` | **agents + humans (`app_*` tools / console)** |

The design principle throughout: **Apps invent no new trust boundary and no new run engine.** Hosting
= the terminal reverse-proxy pointed at a supervised process. Isolation = the launcher daemon.
Background work = an enqueue into the existing Tasks/Automations machinery under a new provenance.

## 1. The two primitives being reused

**Routing — `sharedTerminalProxy` / `pipeUpgradeToTtyd` (`src/server.ts:4671+`).** The main Node
server already reverse-proxies a subpath (HTTP *and* the WebSocket upgrade) to a locally-listening
port, cookie-gated with the same authz nginx enforces in prod. Apps get a sibling `/apps/<slug>/…`
branch that proxies the same way.

**Isolation — `launcher.ts` (`AOS_UID_ISOLATION`, Linux).** The privileged, argv-only, zero-dep daemon
that already runs sessions as a **DynamicUser** in a **per-principal slice** (mem/cpu/pids caps, 0700
home). It gains one verb, `start_app`, to run an app process as its own isolated uid. On macOS (no
`AOS_UID_ISOLATION`) apps run as plain child processes in local mode — best-effort isolation, same
honest gap the per-user isolation plan already documents.

**Callback — the pre-auth loopback (`src/server.ts:522+`).** Agent MCP tools reach the OS over
loopback with no cookie, gated by a **per-session secret** (`x-aos-secret`, `verifySessionSecret`),
on routes that sit *before* the member-auth gate. Apps get the exact same posture with a **per-app
secret**.

## 2. The App object

An **App** is an installable, governed, versioned bundle — the fourth member of the
library→install→manifest→govern→version→nav family that Agents, Skills, and Automations already
belong to.

```
<home>/apps/<slug>/
  app.json          # manifest (see below)
  app/              # the Node source the app process runs (entry = app/server.js)
  data.db           # the app's own SQLite, owned by the app uid — NOT the agent-os DB
```

### 2.1 Manifest (`app.json`)

```jsonc
{
  "id": "mini-crm",                 // DNS-safe slug; the /apps/<slug> segment
  "name": "Mini CRM",
  "icon": "contact",                // lucide name or raw SVG, same as agents
  "entry": "app/server.js",         // node entry; must bind process.env.PORT, honor X-Forwarded-Prefix
  "runtime": { "node": ">=22" },
  "lifecycle": "scale-to-zero",     // or "resident"
  "idleTimeoutSec": 900,            // scale-to-zero teardown after N idle seconds
  "capabilities": {                 // the governance contract — default-deny
    "dispatchAgents": ["support-bot"],   // which agents this app may trigger in bg ([] = none)
    "egress": false,                      // outbound network (default false → PrivateNetwork/deny)
    "secrets": [],                        // vault keys injected into the app env at launch
    "dependencies": "stdlib"              // "stdlib" | "vendored" | "npm" (npm = reviewed capability)
  },
  "owner": "vikas@…",               // accountable human; default run-as for bg dispatch
  "createdBy": "agent:app-builder", // provenance of authorship
  "version": 3                       // bumped per revision (see §6)
}
```

**Capabilities are default-deny and enforced at the boundary, not by trust.** An App can only trigger
the agents it names, only reach the network if `egress:true`, only read the vault keys it declares.
This is the manifest that makes hosted app code safe: the process is uid-isolated *and*
egress-denied, and its one privileged channel (`/api/app/*`) enforces `capabilities` per call.

## 3. Hosting — how the process runs and gets reached

### 3.1 `AppSupervisor` (new — peer of `TerminalManager`)

Per tenant, owns the running-app table and lifecycle. Modeled on `TerminalManager` + `launchTtyd`.

```
slug → { pid, port, status: 'cold'|'starting'|'ready'|'crashed', lastHit, secret }
```

- **Launch (cold → ready):** allocate an ephemeral **loopback** port; start the app process (via
  `launcher.start_app` on Linux, or a plain `child_process.spawn` on macOS) with env:
  `PORT`, `AOS_APP_TOKEN` (the per-app secret), `AOS_APP_SLUG`, `AOS_LOOPBACK` (the OS base URL),
  `AOS_APP_HOME` (its dir), plus any declared `secrets`. **Health-check** readiness (poll `GET /` or a
  `/__health`) before marking `ready` and releasing proxied requests.
- **Scale-to-zero:** a tick idle-kills any app past `idleTimeoutSec` with no hits — the same teardown
  discipline `TerminalManager.markTurnIdle` applies to headless sessions. `resident` apps skip this
  (KeepAlive, restart-with-backoff on crash — mirror `SlackSocket`).
- **Crash/backoff:** capped restart backoff; a repeatedly-crashing app parks `crashed` and the proxy
  serves a 502 status page instead of hot-looping.

### 3.2 The proxy branch (`src/server.ts`)

A sibling to the `/terminal/` branch, reusing the same helpers:

```
if (p.startsWith('/apps/')) return appProxy(rt, req, res)      // HTTP
// and in server.on('upgrade'):
if (req.url?.startsWith('/apps/')) return appUpgrade(rt, req, socket, head)   // WS
```

`appProxy`:
1. **Auth** — resolve the session cookie → `me` (being logged in is enough to *view*; per-app
   access lists are a §9 extension). Reject 401 if absent, mirroring the terminal `auth_request`.
2. **Resolve** — `slug` from the path; `AppSupervisor.ensureReady(slug)` (launch-if-cold, await
   readiness).
3. **Proxy** — pipe HTTP (and the WS upgrade via `pipeUpgrade`-style) to the app's loopback port,
   **stripping `/apps/<slug>`** and injecting:
   - `X-Forwarded-Prefix: /apps/<slug>` — so the app builds correct absolute URLs (the exact
     `X-Forwarded-*` discipline the nginx note in CLAUDE.md already warns about),
   - `X-Aos-Member: <me.email>` and `X-Aos-Role: <role>` — trusted because the proxy injects them
     **after stripping any client-supplied copy**. This is how the app knows *who* is using it
     without holding the session cookie.

In the multi-tenant registry the tenant resolves first (host/`x-aos-tenant`), then `/apps/<slug>`
within that runtime; in process-per-tenant it's purely the path. In prod, nginx forwards `/apps/` to
the Node server (which sub-proxies) so the single authenticated path is preserved — same reason
`/terminal/` goes through the app and not straight to ttyd.

### 3.3 Isolation (`launcher.ts` gains `start_app`)

On Linux (`AOS_UID_ISOLATION`), the app runs as its **own DynamicUser** in its **own slice**:
- home = `<home>/apps/<slug>/` at 0700 → apps are mutually unreadable; the app uid owns `data.db`.
- slice caps (mem/cpu/pids) reuse the per-member slice-cap machinery.
- **`egress:false` ⇒ `PrivateNetwork` / outbound-deny**, loopback-only. This matters because *agents
  wrote this Node code* — it is semi-trusted, so the OS seatbelt is the point, and the only way out is
  the loopback the OS controls. `egress:true` is an explicit, reviewed capability.

`start_app` validates argv/paths exactly like `start_session` (the launcher stays small, argv-only, no
shell — it is the box's one privileged component). On macOS there is no equivalent: `child_process`
with a separate cwd/home/port, isolation best-effort. Gate identically to `AOS_UID_ISOLATION` and
document the gap.

## 4. Triggering agents in the background — `/api/app/*` loopback

The app has **no ambient authority**. To trigger an agent it POSTs to a **new pre-auth loopback route**
gated by its per-app secret — the same shape as the agent MCP tool routes (`src/server.ts:522+`):

```
POST /api/app/dispatch          headers: x-aos-app-secret: $AOS_APP_TOKEN
  { agent: "support-bot", goal: "…", input: {…}, mode: "headless"|"interactive",
    wait?: boolean, runAsMember?: "<email-from X-Aos-Member>" }
```

Handler (before the member gate):
1. `verifyAppSecret(slug, header)` → 403 on mismatch.
2. **Capability check** — `agent ∈ manifest.capabilities.dispatchAgents`, else 403. This is where
   default-deny is enforced per call.
3. Create the work through the **existing engine** — a `TaskStore` autoDispatch task (or a direct
   `Automations` spawn) with:
   - **`spawned_by = app:<slug>`** — a new provenance source alongside `automation:<id>`,
     `chat:<agent>`, `task:<id>`. It slots straight into `canViewRow`, the pile-up guard,
     `TASK_MAX_ATTEMPTS`, and audit.
   - **`run_as`** = the current UI member (from `X-Aos-Member`, validated as a real member) if the app
     forwards it, else `manifest.owner`. So the accountable identity is the actual human using the
     app — the same run-as/provenance split chat already uses.
4. `wait:true` → block on the task like `task_wait` and return the delegate's result to the app (a
   synchronous "run this agent and give me the answer" call from inside the UI).

Companion read routes (all per-app-secret gated): `GET /api/app/dispatches` (this app's runs +
status), `POST /api/app/notify` (post an Inbox card / DM to the owner via `resolveRecipients`). Every
one is audited (`app.dispatch`, `app.notify`) — an App is a first-class principal in the audit log.

## 4.1 Secrets — the vault is available to Apps

An App needs credentials (a Stripe key, an external API token, a DB URL) the same way agents and shell
tools do. Apps reuse the **existing secrets vault** (`src/edge/secret-crypto.ts`, encrypted at rest,
value kept out of audit/approval-card/policy args) — no new secret store. Three paths, mirroring the
agent model exactly, all **injection/read only — none widens who can decrypt a value**:

1. **Declared in the manifest (launch-time env injection).** `capabilities.secrets: ["STRIPE_KEY"]`
   resolves each key via the vault and exports it into the app process env at launch — the direct
   parallel to an agent manifest's `shellSecrets` + `injectShellSecrets`. Sealed under the app's own
   principal (`app:<slug>`) or tenant-wide `*`; audited `shell.secret.injected` / `unresolved` with
   `via:'app-manifest'`. Default-deny: a key not listed is never injected.

2. **Admin-assigned (central grant).** **Settings → Secrets** can *assign* a stored secret to an app
   (the `secret_assignments` table gains `app:<slug>` as an assignee alongside agents) — the
   central-grant inverse of the manifest list, so one canonical value fans out without a per-app copy.
   Injection only; `via:'assignment'`.

3. **Runtime read + request (`/api/app/*`, per-app-secret gated).** Env-at-launch isn't enough for a
   key rotated mid-run or fetched on demand, so an App gets loopback parallels to `secret_get` /
   `secret_request`:
   - `POST /api/app/secret/get { key }` → returns the value **only if** `key ∈ capabilities.secrets`
     or an assignment grants it (read at call time, so a rotated value is picked up); 403 otherwise.
     Audited `app.secret.read` (never the value).
   - `POST /api/app/secret/request { key, reason }` → the ASK counterpart: carries only key + reason
     (never a value, so nothing lands anywhere logged), posts a `secret.request` card to owner/admins
     (Inbox + **Settings → Secrets → App requests**), auto-detecting the same **provide** (key absent →
     human types it, sealed under `app:<slug>` or `*`) vs **access** (key exists but scoped away →
     human grants, server re-scopes the sealed value to the app, no re-type) modes the agent
     `secret_request` uses. Resolved via `POST /api/secrets/requests/:id/fulfill`, which can also
     inject into the app's env on next launch. Audited `secret.requested` / `.fulfilled` / `.granted`.

The invariant holds: an assignment or a manifest declaration is **injection only**, never a widening of
`secret_get`; and because reads go through the capability-gated loopback, a secret the app wasn't
granted is unreachable even though the app runs its own Node code.

## 5. Data

`<home>/apps/<slug>/data.db` — the app's own SQLite, owned by the app uid, **deliberately not the
agent-os DB** (keeps app rows out of the OS tables and keeps the tenant boundary clean). The app owns
its schema and migrations; the OS never reaches into it.

Agents that need to work *on* app data do it **through the app's own HTTP endpoints or a dispatched
task**, never by touching the file — that encapsulation is what makes it an App and not a shared table.
An App that wants to expose data to agents publishes an endpoint the dispatched agent calls (looping
back in through the authed proxy, or a dedicated app-internal API the agent is handed).

## 6. Lifecycle — authored by agents and humans, no seeds

**No bundled seed apps.** The library is empty until someone builds an app. Two authoring paths, both
landing the same `<home>/apps/<slug>/` bundle:

**Agent-authored (`app_*` MCP tools — parallel to `agent_create` / `skill_propose`):**
- `app_scaffold({ name, capabilities })` — writes a minimal base-path-aware Node template into the
  agent's working folder (`server.js` that binds `PORT`, honors `X-Forwarded-Prefix`, reads
  `AOS_APP_TOKEN`, opens `data.db`) + a stub `app.json`.
- `app_propose({ slug, dir })` — like `skill_propose`: lands a **NOT-YET-PUBLISHED** app +
  a `app.proposed` inbox card for an owner/admin to review the code + capabilities and publish. An app
  that can `dispatchAgents` or `egress` should not self-activate.
- `app_update` / `app_history` / `app_revert` — **self-only**, snapshotting each change to the
  existing revisions backbone (`agent-revisions.ts` style / a `app_revisions` table), so a bad edit
  rolls back. No app edits another app.

**Human-authored (console → Apps page):** upload/edit the bundle, edit the manifest + capabilities,
Publish. Publishing (the governance gate) is what makes an app routable and lets the supervisor launch
it; it appears in nav.

**Governance of the *code itself*** is the honest hard part: an owner publishing an app is vouching for
its Node source. Surface a diff on publish (revisions make this free) and keep capabilities
default-deny so an unreviewed app is inert (no agents, no egress, no secrets) even if published.

## 7. The dependency question (the one real policy call)

"A Node app" implies `npm install` → supply-chain + disk + the egress you denied in §3.3. Tier it in
the manifest:
- **`stdlib`** (default) — Node built-ins + a small provided helper lib (a `data.db` wrapper, the
  `/api/app/*` client). Zero third-party code, matches the OS's own zero-dep stance. Most mini-tools
  fit here.
- **`vendored`** — a curated, OS-shipped allowlist of vetted packages, materialized at launch.
- **`npm`** — arbitrary deps. An **explicit reviewed capability**: install happens at **build/publish
  time under review** (egress open only then), never at runtime; runtime stays egress-denied.

## 8. Build order

1. **`AppSupervisor`** (`src/state/apps.ts` or `src/edge/app-supervisor.ts`): manifest load, port
   table, `child_process` launch + readiness + scale-to-zero idle-kill + crash backoff. macOS-first
   (plain spawn) so it's testable without the launcher.
2. **Proxy branch** in `src/server.ts`: `appProxy` + `appUpgrade`, cookie auth, `X-Forwarded-Prefix` +
   `X-Aos-Member` injection. Reuse the ttyd pipe helpers.
3. **`/api/app/dispatch`** loopback route + per-app secret (`verifyAppSecret`) + capability check +
   `spawned_by = app:<slug>` provenance into `TaskStore`. Wire `app:<slug>` into `canViewRow`/audit.
   Same slice: **secrets** (§4.1) — manifest `capabilities.secrets` launch injection (reuse
   `injectShellSecrets`), `app:<slug>` as a `secret_assignments` assignee, and the
   `/api/app/secret/get` + `/api/app/secret/request` loopback routes.
4. **`launcher.ts` `start_app`** verb (Linux isolation) behind `AOS_UID_ISOLATION`; DynamicUser +
   slice + `PrivateNetwork` when `egress:false`.
5. **Authoring**: `app_scaffold`/`app_propose`/`app_update`/`app_history`/`app_revert` MCP tools + the
   `/api/apps/*` console routes + `app_revisions`. Publish gate (owner/admin) + `app.proposed` inbox
   card.
6. **Console Apps page**: install/list, manifest + capability editor, publish/diff, per-app status
   (cold/ready/crashed), logs, open-in-new-tab to `/apps/<slug>`.
7. **Dependency tiers** (§7): `stdlib` first; `vendored`/`npm` as follow-ups.

## 9. Deliberate cuts / futures

- **Per-app access lists** — v1: any logged-in member can open any app. Later: an app's `access` names
  members/roles, enforced in `appProxy` (like `canRun` for agents).
- **Custom domains / subdomain-per-app** — v1 is path-based `/apps/<slug>`. The registry already
  resolves tenants by subdomain; an app-subdomain is a later routing extension.
- **Shared app data ↔ KB/Tasks bridges** — an app reading/writing the OS's own KB or Tasks via
  `/api/app/*` (capability-gated) rather than only its private `data.db`.
- **`npm`/`vendored` dependency tiers** beyond `stdlib`.
- **App marketplace / export-import** — apps are per-tenant bundles; a cross-tenant catalog (like the
  agent library) is a future, but there are still **no first-party seed apps** — the catalog would only
  ever hold community/agent-authored apps.

---

**One-paragraph summary.** An App is a supervised, uid-isolated Node+SQLite process reached at
`/apps/<slug>/` through the same authenticated reverse-proxy the terminal uses, and allowed out only
through the same pre-auth loopback the agent tools use — where a default-deny capability manifest
decides which agents it can trigger, whether it has network, and which vault secrets it sees (injected
at launch or read/requested at runtime through the same capability gate). Hosting reuses
`sharedTerminalProxy`; isolation reuses `launcher.ts`; background work reuses Tasks/Automations under a
new `app:<slug>` provenance. Apps are built only by agents (`app_*` tools, proposed-then-published) and
humans (console) — nothing ships seeded. No PaaS, no second trust boundary: every effect an App has
still passes through the one gateway.
