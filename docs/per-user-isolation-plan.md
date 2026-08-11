# Per-user isolation plan — running a session inside its owner's OS scope

Today a member's identity in the console (their `Member` row, `Role`, and agent assignments) is a
**label on top of a single shared Unix account**. When anyone runs a session it executes as
`User=vikas` (`agent-os.service`), in one `$HOME`, on one tmux socket, with one `~/.claude` identity,
and with the **whole** workspace connector pool — tokens and all — written into its `.mcp.json`. The
governance layer (who may launch/approve, and the PreToolUse gate) is real and per-member; the
**execution substrate is single-tenant**. This plan closes that gap without weakening the one
invariant: every side effect still passes through the single mediated gateway (Policy → Approvals →
Audit). It *adds* an OS boundary underneath that gateway so a session can only touch its owner's
files, credentials, and connectors.

> Scope note: this is a re-platforming of the **execution + attach** substrate, not a tweak to the
> launcher. The prerequisites (below) are independently valuable and ship first; the substrate
> (Tier A) is the large lift.

## Status

| Phase | Item | State |
|------|------|-------|
| 0 | Prereq: `0600` per-session secret files (close the world-readable leak) | **done (code)** |
| 0 | Prereq: authorize terminal attach per session (not just "logged in") | **done (code); needs nginx wiring** |
| 0 | Prereq: per-member connector scoping + move secrets to the vault | planned |
| 0 | Prereq: per-session bearer secret on `/api/gate` | **done (code)** |
| A | Privileged session launcher (the only privileged component) | planned |
| A | uid-per-member + provisioning | planned |
| A | per-uid `$HOME` / `~/.claude` | planned |
| A | per-uid tmux socket + per-uid ttyd + nginx routing | planned |
| A | per-uid resource slices + cross-uid lifecycle/cleanup | planned |
| B | container/namespace per session (only if hostile multi-tenant) | deferred |

---

## The one constraint that shapes everything

The execution substrate is **single-uid, single-socket, single-ttyd**:

- The service runs as one Unix user, `NoNewPrivileges=true` (`agent-os.service`). The main process has
  **dropped the ability to gain privilege** — it cannot `setuid` to anyone. Spawning as another uid
  therefore *must* move into a separate privileged helper.
- `launchTmux` puts every session on **one shared socket** (`src/terminal.ts:218`,
  `paths.tmuxSocket` from `src/home.ts`).
- **One** ttyd attaches to that socket with `-a`; the browser selects the session by passing the tmux
  name as `?arg=aos-xxxx` (`src/server.ts:100`, `web/src/App.tsx:485`).
- nginx `/terminal/` does `auth_request → /api/auth/me` only — it proves *login*, not *authorization to
  attach to this session* (`/etc/nginx/sites-available/<host>`).

Everything below follows from breaking those four assumptions.

---

## Phase 0 — prerequisites (independent of which tier; do first)

### 0a. `0600` the per-session secret files *(needed now)*

The OS writes `data/connectors/session-<id>.mcp.json` (carrying connector secrets — stdio `env`,
remote `headers`) and headless `session-<id>.log` transcripts. **They are currently `0644`
(world-readable).** Any local account can read every session's tokens today. The `.mcp.json` is built
in `writeMcpConfig` and the company file in `writeCompanyFile` (`src/terminal.ts:241`, `:263`).

- **Fix:** write these with mode `0600` (and `chmod 0700` the `connectors/` dir). One-liner per
  `writeFileSync`; no behavioral change.
- **Files:** `src/terminal.ts` (`writeMcpConfig`, `writeCompanyFile`, headless `LOG` path).

### 0b. Authorize terminal attach per session *(needed now)*

`auth_request` only validates the `aos_sid` cookie, so any logged-in member can attach to any session
by guessing its tmux name (`aos-<8hex>`). Add an authorization subrequest that resolves the cookie →
member and checks `canRun(member, sessionAgent(arg))` (or owner/admin) before proxying to ttyd.

- **Files:** `src/server.ts` (a new internal endpoint, e.g. `GET /api/terminal/authz?arg=…`, that
  returns 200/403); nginx `/terminal/` `auth_request` points at it instead of `/api/auth/me`. Needs
  the tmux name from the query — pass `$arg` through (`X-Original-URI` already forwarded).

**Implemented (code):** `GET /api/terminal/authz` resolves the `aos_sid` cookie → member (the generic
`/api/*` guard, so unauthenticated → 401) and returns `204` only when that member may see the targeted
session — `TerminalManager.canViewSession` (own session, or owner/admin). It reads the tmux name from
`?arg=` or, when absent, from the `X-Original-URI` header; a request with no target (ttyd's own static
assets) returns `204` on a valid login; an unknown session name returns `403` (so there's no
attach-to-most-recent). **Remaining (ops):** point nginx at it:

```nginx
location = /api/terminal/authz {
    internal;
    proxy_pass http://127.0.0.1:3010;          # the agent-os server (PORT)
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;  # carries ?arg=aos-xxxx
    proxy_set_header Cookie $http_cookie;          # so it can resolve the member
}

location /terminal/ {
    auth_request /api/terminal/authz;          # was: /api/auth/me (login-only)
    # …existing proxy_pass to the ttyd port + websocket upgrade headers…
}
```

### 0c. Per-member connector scoping + vault *(planned)*

`mcpConfig()` returns **every** enabled connector with no member filter (`src/connectors/connectors.ts:264`),
and `writeMcpConfig` fans the whole pool into every session (`src/terminal.ts:241`). Secrets sit in
plaintext in the `connectors` table (the code comment already flags this as the single-user
compromise, `connectors.ts:19`).

- Add `owner_member_id` to the `connectors` table; `mcpConfig(memberId)` filters to that owner's
  connectors. `writeMcpConfig` takes the spawning member (already available as `spawnedBy`).
- Stop persisting raw tokens in SQLite; resolve them per-session from `os.secrets`
  (`EnvSecretsVault`) at launch.
- **Why before Tier A:** this is the boundary Tier A then *enforces* at the OS level — without it,
  per-uid file perms isolate sessions that are still all carrying the same shared tokens.
- **Files:** `src/state/db.ts` (migration), `src/connectors/connectors.ts` (`mcpConfig(memberId)`),
  `src/terminal.ts` (pass member), `src/server.ts` (connector CRUD records owner).

### 0d. Per-session bearer secret on the gate *(planned)*

The gate hook curls `AOS_URL/api/gate` with `SESSION`/`AGENT` from env (`terminal/gate-hook.sh`); the
server trusts the session id. Over one loopback uid that's fine, but once uids are mutually untrusted
the id is a forgeable bearer — one session could gate as another. Mint a per-session secret at spawn,
export it into the session env, require it on `/api/gate` and the session-scoped `/api/agent/*`,
`/api/memory/*`, `/api/ask`, `/api/report` endpoints.

- **Files:** `src/terminal.ts` (`createSession` mints + stores secret, `envFragment` exports it),
  `src/server.ts` (verify on session-scoped endpoints), `terminal/gate-hook.sh` +
  `terminal/claude-launch.sh` + `src/memory/memory-mcp.ts` (carry the secret).

---

## Phase A — uid-per-member (recommended substrate)

> **Build spec: `docs/phase-a-scope.md`.** Decided (2026-06-16): account model = systemd
> **DynamicUser** (per-member "holder" service owns the uid + home; sessions are scopes into it),
> Claude identity = **one shared company Anthropic account** copied into each member's home. The spec
> supersedes the "managed `aos-u*` pool *or* DynamicUser" wording below with the DynamicUser variant.

Strong isolation of **filesystem, credentials, and processes** without a container runtime. stdio MCP
servers (`npx …server-slack`) are spawned by claude and inherit the member-uid, so connector tokens
are isolated for free. Everything this needs is installed on the box (`systemd-run`, `runuser`,
`setpriv`, systemd 256).

### A1. Privileged session launcher — the new trust root

Because the main app is `NoNewPrivileges`, all uid-switching moves into a small, separate, audited
helper the app talks to over a unix socket. It exposes exactly four operations and nothing else:

```
launcher.start(member_uid, session_id, tmux_socket, env, cmd)   -> spawn tmux session as member_uid
launcher.stop(member_uid, tmux_socket, tmux_name)               -> kill that session
launcher.ttyd_up(member_uid, port, tmux_socket)                 -> start a ttyd as member_uid
launcher.ttyd_down(member_uid, port)                            -> stop it
```

- **Mechanism:** `systemd-run --uid=<member> --scope --slice=aos-<member>.slice … tmux -S <sock> …`
  (or `runuser -u`). systemd 256 gives per-scope sandboxing + slices for free.
- Keep it tiny and side-effect-free beyond these calls; it is the only thing with privilege. The
  gate, policy, audit, and DB all stay in the unprivileged app.
- **Files:** new `src/edge/launcher.ts` (client) + a standalone privileged unit (`launcher` binary +
  its own `.service` with the minimal `CAP_SETUID`/`CAP_SETGID` or root). `src/terminal.ts`
  `launchTmux`/`killTmux` call the launcher instead of spawning tmux directly.

### A2. uid per principal + provisioning

Map each `Member` to a dedicated Unix user (a managed `aos-u*` pool, or `systemd-run` `DynamicUser`
with a persistent `StateDirectory`). The **automations lane** also spawns sessions
(`spawnedBy = automation:<id>`, `src/terminal.ts:171`) — assign those the automation owner's uid, or a
dedicated `aos-automations` service user.

- **Files:** `src/governance/team.ts` (member → uid mapping + provisioning hook), `src/state/db.ts`
  (store the uid on the member row), `src/edge/automations.ts` (owner uid for triggered runs).

### A3. Per-uid `$HOME` / `~/.claude` *(the biggest item)*

One `~/.claude` is shared by every run today; it holds `.credentials.json` (the single Anthropic
identity every agent runs under) and `history.jsonl` / `file-history/` / `projects/` (the full
cross-session transcript history, readable by all). Each uid needs its **own** `$HOME` with its own
`~/.claude` (its own login). The systemd unit's `ReadWritePaths=/home/user/.claude` becomes per-uid
state dirs instead.

- **Files:** launcher sets `HOME` per uid; `terminal/claude-launch.sh` already respects `HOME`/PATH;
  first-run per-uid `claude` login flow (doc + ops runbook). Update `agent-os.service` RW paths.

### A4. Per-uid tmux socket + per-uid ttyd + routing

tmux sockets are uid-owned, so one socket can't host multiple uids. Give each uid its own socket
(`0700` under its state dir) and **one ttyd per uid** running *as* that uid on its own loopback port.
nginx routes `/terminal/<member>/ → that uid's ttyd`, and the attach authz from 0b checks the cookie's
member matches `<member>`.

- **Files:** `src/server.ts` (`launchTtyd` becomes per-uid, port allocation, lifecycle/reap per uid),
  `src/home.ts` (`tmuxSocket` becomes per-uid), nginx (per-member `/terminal/<member>/` location or a
  routing map), `web/src/App.tsx` (terminal `src` includes the member segment).

### A5. Resource slices + cross-uid lifecycle

Put each uid in a systemd slice (CPU/Memory/Tasks) so one runaway agent can't starve the box (today
`LimitNPROC`/`NOFILE` are global). `stopSession`/`deleteSession`/`killTmux` (`src/terminal.ts:418`,
`:435`, `:448`) must route through the launcher — signaling another uid's processes needs privilege.

- **Files:** launcher (`--slice=`), `src/terminal.ts` (stop/delete/kill via launcher), per-session
  file cleanup (`removeSessionFiles`, `src/terminal.ts:453`) runs as / on behalf of the owner uid.

---

## Phase B — container/namespace per session *(deferred)*

Strongest isolation (filesystem + network + PID namespace), but **not readily available on this box**:
`podman`/`bwrap`/`newuidmap` are absent, and `kernel.apparmor_restrict_unprivileged_userns=1`
(Ubuntu 24.04) restricts unprivileged user namespaces, so rootless sandboxing needs an AppArmor
profile. Docker exists but is a root daemon and heavy, and the container must still reach the host's
`:3010` for the gate. Only pursue this against genuinely hostile tenants where Tier A's shared-kernel,
shared-network model is insufficient. Revisit if `podman` + an AppArmor userns profile are added.

---

## What we are NOT changing

- The gateway invariant and the PreToolUse gate stay exactly as they are — this plan adds an OS
  boundary *beneath* them, it does not replace them.
- The loopback gate model (agent → `AOS_URL/api/gate`) is preserved; it works from any uid because
  it's HTTP to localhost. 0d only adds a bearer secret so a uid can act only as itself.
- The per-workspace SQLite DB stays owned by the unprivileged app; agents never touch it directly
  (they write only via the loopback API), so it needs no per-uid access.

## Sequencing

Phase 0 (0a + 0b now; 0c + 0d next) → A1 launcher → A2 uids → A3 HOME/.claude → A4 sockets/ttyd/routing
→ A5 slices/cleanup. Phase 0 is small and high-value and is a prerequisite for A regardless; ship it
first and the worst current leaks (world-readable tokens, attach-any-session, shared Claude identity
exposure) are closed before the substrate work lands.
