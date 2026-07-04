# Agent OS — working notes for Claude

A generic, governed operating system for running autonomous agents safely. The one invariant:
**every side effect an agent has on the world passes through a single mediated gateway** where
Policy classifies, Approvals suspends for a human, Budget debits, Identity asserts, Idempotency
dedupes, and Audit records. Remove the gateway and all of that becomes docs. Keep the core generic
and open-sourceable: `src/core` and the kernel import contracts only from `src/types.ts`, never from
brand/plugin code.

## Build / run / test

```bash
npm run build        # tsc → dist/   (npm run typecheck for --noEmit)
npm run serve        # web console + API → http://localhost:3010   (alias: agent-os serve)
npm run demo         # scripted governance demo over mock capabilities, prints the audit trail
cd web && npm run build   # the React console (web/dist is served by the Node server)
```

There is no test runner. Validate changes by: `npm run typecheck`, `cd web && npm run build`, running
`npm run demo`, and — for server/store logic — small in-process Node scripts that `require('./dist/...')`
(spin up `createHttpServer` on an ephemeral port and drive it with `fetch`; avoids tmux/ttyd and port
conflicts). Don't rely on backgrounding `agent-os serve` inside one shell call — it's flaky here.
**⚠ Isolate test scripts:** `loadAgentOS()` with no env resolves the home to **`./data` — the LIVE
default-tenant DB** (config `tenant` = `northwind`), NOT an ephemeral `:memory:` one (only the
demo/`AgentOS` with no `paths` is in-memory). A throwaway `loadAgentOS()` smoke test will therefore
write test rows into the real DB. Always `export AGENT_OS_HOME=<scratch dir>` (and `rm -rf` it) before
running such a script, or you will pollute live data.

**What a change needs to take effect (the long-running server holds old code in memory):**
- **Server/API or store code (`src/server.ts`, `src/state/*`, `src/kernel.ts`, loopback routes like
  `/api/publish`):** `npm run build` **+ restart** the server. Until you restart, a *new* loopback
  route 404s-then-falls-through to the member-login gate, so an agent's call comes back **401 "not
  authenticated"** — a stale-server symptom that masquerades as an auth bug. Quick check after
  restart: `curl -XPOST localhost:3010/api/<route> -d '{"session":"nope"}'` should give **404**
  (route present), not 401. (Prod Linux: `sudo systemctl restart agent-os`. **This Mac Mini** — the
  `northwind` tenant runs under launchd as `com.agentos.northwind` (`~/Library/LaunchAgents/com.agentos.northwind.plist`,
  KeepAlive, `./data` on :3010, fronted by `tailscale serve` http→3010): rebuild + bounce with
  `npm run build && launchctl kickstart -k gui/$(id -u)/com.agentos.northwind`; logs at `data/server.log`;
  load/unload with `launchctl load -w|unload <plist>`.)
- **Agent-facing MCP tools (`src/memory/memory-mcp.ts` — `recall`/`remember`/`revise`/`forget`, the
  `kb_*` tools, `ask`/`check_inbox`/`report`/`update`/`publish`/`artifacts_list`, `schedule`/`unschedule`,
  …; full list in `docs/agent-mcp-tools.md`):** changing a tool's SCHEMA needs `npm run build` **+ relaunch
  the session** (claude spawns the MCP server fresh per session, so a live session keeps the old tool list
  until respawned). Changing a tool's server-side `/api/*` HANDLER also needs the **server restart** above.
- **The web console (`web/src`):** `cd web && npm run build` (no server restart needed — the Node
  server serves `web/dist` off disk; just reload the browser).

Product pillars and their implementation maturity are tracked in `docs/PILLARS.md` — check it before
starting feature work, and update the status grades when a pillar's reality changes.

## Running locally on macOS (self-contained — no nginx)

The deploy box is Linux/systemd, but the default path runs on a Mac with no extra infrastructure:

```bash
brew install tmux ttyd     # the only native deps; everything else is Node built-ins
npm install && npm run build && (cd web && npm install && npm run build)
npm run serve              # → http://localhost:3010   (ttyd on :3011)
```

The single Node process fronts everything — app, JSON API, **and the browser terminal**: when the
uid-isolation flag is off (the macOS default), `src/server.ts` reverse-proxies `/terminal/` (HTTP +
the ttyd WebSocket upgrade) to the local ttyd itself, login-gated with the same per-session attach
authz nginx enforces in prod (`sharedTerminalProxy`/`sharedTerminalUpgrade`). So **nginx is only a
production concern** — locally nothing sits in front of the Node server. In prod nginx fronts
`/terminal/` and the app never receives those requests, so the shared proxy is inert there.

macOS gotchas already handled in `terminal/claude-launch.sh` (the deploy box's bash 4 / GNU coreutils
hid these): bash **3.2** errors on expanding an empty array under `set -u` — guard with
`"${ARR[@]+"${ARR[@]}"}"`, never a bare `"${ARR[@]}"` on an array that may be empty; and BSD `find`
has no GNU `-printf` — use a shell glob. Keep new per-session scripts portable to bash 3.2 + BSD
userland, or they'll pass on Linux and silently kill sessions on a Mac.

**Linux-only by design:** the Phase A per-user OS isolation (`src/edge/launcher.ts` — systemd
DynamicUser, `systemd-run`, slices, `/proc`) is gated behind `AOS_UID_ISOLATION` (off by default) and
has no macOS equivalent. On a Mac you run single-user **local mode** (`LocalSessionBackend`).

## Layout (software vs. data)

- **Software** = this repo: `src/`, `web/`, bundled example agents (`config/agents`) + default policy
  (`config/policy`).
- **Data home** = the user's state, resolved by `src/home.ts` (`$AGENT_OS_HOME` → config `home` → `./data`).
  Holds their agents, the **global skills library** (`skills/<name>/SKILL.md`), policy override,
  audit JSONL, tmux socket, and the **per-workspace SQLite DB**.
  One home + one `PORT` = one isolated instance; run several side by side.

### Multi-tenancy (the DB file is always the tenant boundary)

Two ways to run more than one tenant; both keep every store operating on one tenant's DB (no table
grew a `tenant`/`workspace_id` column):
- **Process-per-tenant (the deployment default).** Each tenant is its own `agent-os serve` process:
  distinct `AGENT_OS_HOME` + **`AGENT_OS_TENANT`** (overrides config `tenant`) + `PORT`. Fully isolated,
  simplest. `scripts/run-tenant.sh <slug> <home> <port> [owner]` wraps the env; `scripts/tailscale-serve.sh`
  fronts ≤3 of them on one Tailscale name (HTTPS 443/8443/10000 → separate origins). Runbook:
  `docs/process-per-tenant.md`.
- **Many tenants in one process** — `src/tenant-registry.ts` builds one isolated runtime per tenant
  (own DB/tmux/ttyd/cron/Slack), listed in a control plane (`src/state/control.ts` → `<home>/control/control.db`),
  routed by **subdomain** (`<slug>.<baseDomain>`, set `baseDomain` in config) or the loopback
  **`x-aos-tenant`** header (in-session agent calls have no Host — `terminal.ts` exports `AOS_TENANT`,
  the gate-hook/MCP forward it). Provisioning is superadmin-only: `agent-os tenant create` /
  `POST /api/admin/tenants` (gated by `AOS_SUPERADMIN_TOKEN`). The seed tenant (config `tenant`) keeps
  the legacy un-nested home. The registry is **dormant in process-per-tenant mode** (one tenant at the
  apex host). See `docs/scoping-model.md`.

Key modules:
- `src/types.ts` — all shared contracts (the only thing the core imports). `Role`, `Member`,
  `AgentAccess`, `canApprove()` live here.
- `src/kernel.ts` — composition root. Builds the DB, all governance planes, gateway, orchestrator.
- `src/gateway/gateway.ts` — the 7-step mediated effect boundary. The heart of the trust layer.
- `src/server.ts` — zero-dependency Node `http` server: JSON API + serves `web/dist` + terminal sessions.
- `src/terminal.ts` — tmux-backed agent sessions; routes every effect through the same gateway via the
  PreToolUse gate hook (`terminal/gate-hook.sh`). At launch it resolves each claude-code agent's
  **runtime tuning** (`resolveRuntimeTuning` in `src/types.ts`: agent manifest → workspace default → CLI
  default) and exports `CLAUDE_MODEL`/`CLAUDE_EFFORT`/`CLAUDE_PERMISSION_MODE`, which `claude-launch.sh`
  maps onto `--model`/`--effort`/`--permission-mode` (model+effort both lanes; permission-mode interactive
  only — headless keeps `--dangerously-skip-permissions`).
- `src/governance/` — `policy.ts` (JSON rule engine), `approvals.ts`, `audit.ts`, `team.ts`,
  `settings.ts` (Company context **+ workspace runtime defaults**: the fleet-wide model/effort/permission
  fallback, `runtimeDefaults`/`setRuntimeDefaults`), `skills.ts` (global `.claude/skills` library,
  materialised into every claude-code agent at launch by `TerminalManager`), budget, identity.
- `src/edge/automations.ts` — Automations: cron/webhook/composio/**slack**/**discord** triggers that spawn
  agent sessions unattended (zero-dep cron parser, scheduler tick, pile-up guard via tmux liveness, public
  `/hooks/<id>?key=`). Naming: Automation = user-facing object; Trigger = firing condition; Orchestrator
  = internal run engine. `fireSlack`/`fireComposio` dispatch inbound events to matching automations. When
  a Slack/Discord message matches **no** automation, a **generic `/agent` chat router** (`routeChat` +
  `spawnChatAgent`, toggle `chatRouterEnabled`, default on) is the fallback: the sender addresses any
  claude-code agent by name (`/pod-troubleshooter …`) and it spawns as a one-off run (provenance
  `chat:<agent>`, run-as the sender, same gate); an unaddressed/unknown name posts a help list back. So the
  whole fleet is reachable **without** a per-agent automation — automations become optional overrides. Also
  hosts **agent-scheduled one-shots** (`type:'once'` + `run_at`/`run_as`): the `schedule`/`unschedule` MCP
  tools call `Automations.schedule`/`cancelScheduled` so an agent can defer a future run of itself (same
  agent + run-as identity); `tick()` fires it once when due then disables it. Bounded by `SCHEDULE_*`
  (1 min–30 days, ≤25 pending/agent) — see the governance note in `docs/agent-mcp-tools.md`.
- `src/edge/slack-socket.ts` + `src/connectors/slack.ts` — **native Slack via Socket Mode**: one company
  Slack app (app-level `xapp-…` + bot `xoxb-…` tokens in Settings → Integrations) opens an OUTBOUND
  WebSocket to Slack — **no public URL needed** (works on a Tailscale-private/on-prem box that can reach
  `*.slack.com` outbound). On @mention/DM it fires `slack` automations **as the member who sent the
  message** (run-as resolution: the **identity map** `slack` handle first, then Slack profile email →
  `getMemberByEmail`; unmapped → company identity). A leading bot-mention (`<@BOTID>`) is stripped before
  routing so the `/agent` prefix parses. The bot posts an immediate in-thread ack (replies thread on
  `thread_ts ?? ts`, so a mention starts a thread); the agent replies via its own Slack egress tools (the
  Composio company Slackbot). The socket re-dials when tokens change; uses the Node 22+ global `WebSocket`
  (no `ws` dep). Slack here is INGRESS-native; Composio remains the webhook ingress lane.
- `src/edge/discord-socket.ts` + `src/connectors/discord.ts` — **native Discord via the Gateway**: a
  one-for-one mirror of the Slack path. One company bot (single `Bot …` token in Settings → Integrations)
  opens an OUTBOUND Gateway WebSocket — **no public URL** — handling the heartbeat/IDENTIFY/READY state
  machine (intents incl. the **privileged MESSAGE_CONTENT**). On @mention/DM it fires `discord`
  automations; run-as resolves the Discord user id via the **identity map** (`memberByExternalId('discord', …)`;
  unmapped → company identity — Discord exposes no user email, so there's no email fallback). A leading
  `<@BOTID>` mention is stripped before routing (so the `/agent` prefix parses). For a **guild @mention** the
  socket branches a real **thread** off the user's message (`startThread`), binds the *thread* to the session,
  and posts the ack + all `discord_reply` output **inside it** (DMs have no threads → reply-reference in the DM;
  thread-create failure → channel fallback). The `discord_reply` MCP tool is bound to `discord_threads`;
  `DISCORD_REPLY=1` exposes it. `discord.connected` records the READY guild count. Reconnect backoff + zombie
  detection mirror SlackSocket.
  Per-automation **execution mode**: `headless` (default) runs `claude -p --dangerously-skip-permissions`
  (the PreToolUse gate hook still runs + blocks risky Bash under that flag) and exits so the session goes
  `idle` and the guard releases; `interactive` keeps the attachable TUI (a cron won't re-fire while it's
  alive). `HEADLESS=1` selects the lane in `terminal/claude-launch.sh`.
- `src/memory/` — the **memory plane** (per-agent persistent recall). `index.ts` factory →
  `sqlite-provider.ts` (default; FTS5 bm25 keyword recall, **+ optional in-JS-cosine hybrid** when an
  embedder is set), `libsql-provider.ts` (native in-file vectors; opt-in `@libsql/client`),
  `automem-provider.ts` (REST; parked), shared `embedding.ts` (`Embedder` openai/ollama, cosine, RRF
  `fuse`, `planConsolidation`, the `rerank` recency/importance nudge). Backend + ranking + maintenance
  (prune/dedupe) + **shared `scope` (agent | tenant)** are all config in **Settings → Memory**, hot-swapped
  live. `memory-mcp.ts` = the OS-owned stdio MCP server injected into every session — 27 always-on tools
  + 2 chat-only. Memory: `recall`/`remember`/`revise`/`forget` (recall returns each memory's id, the
  handle for revise/forget). KB: `kb_search`/`kb_read`/`kb_write`/`kb_history`/`kb_revert`. Operator/inbox:
  `ask`/`check_inbox`/`report`/`update`/`publish`/`artifacts_list`. Scheduling: `schedule`/`unschedule`
  (one-shot deferred self-run via a `type:'once'` automation). Tasks (shared work queue):
  `task_create`/`task_list`/`task_get`/`task_claim`/`task_update` (file/claim/drain durable work; an
  agent-assigned `autoDispatch` task spawns a governed session — the A2A delegation path; per-task `mode`
  headless/interactive; owner = run-as passthrough so a hand-off keeps the accountable human). Plus
  `directory_lookup` (team/identity-map
  search), `list_capabilities`/`policy_check` (policy preview), and `slack_reply`/`discord_reply` when
  chat-triggered. Each tool is a session-secret-gated loopback call to an `/api/*` route that sits BEFORE
  the member-auth gate. Canonical tool↔route↔store matrix + the governance notes:
  `docs/agent-mcp-tools.md`. See also `docs/memory-layer-plan.md`.
- `src/state/kb.ts` — the **Knowledge Base plane** (`os.kb`): the shared, tenant-wide *living* wiki agents
  + humans co-author. Markdown on disk (`<home>/kb/<section>/<slug>.md`) + SQLite/FTS mirror, full
  **revision chain + revert**, auto-apply + audit (no gate). Agent tools `kb_search`/`kb_read`/`kb_write`/
  `kb_history`/`kb_revert`; console **Knowledge** page. See `docs/knowledge-base-plan.md`.
- `src/state/tasks.ts` — the **Tasks plane** (`os.tasks`): the shared, tenant-wide **work queue** humans +
  agents drain together — the durable *unit of work* between "a trigger fired" (Automation) and "a session
  ran" (Session). `TaskStore` is **db-only** (no on-disk mirror — a task is structured state: status machine
  `todo→doing→blocked→done|cancelled`, priority, labels, single assignee, `owner`=run-as, per-task `mode`
  headless/interactive, `parent_id`, `auto_dispatch`) over `tasks`/`task_events`/`tasks_fts`. Edits are
  **auto-apply + audit** (safety net = the append-only `task_events` log, like KB — no approval gate); the
  atomic `claim` is the multi-worker race resolver. The **dispatcher lives on the edge**
  (`Automations.dispatchTask` + `buildTaskPrompt`): an agent-assigned `auto_dispatch` task is spawned by the
  scheduler `tick()` as a governed session (provenance `task:<id>`, `run_as = owner`, `headless = mode !==
  'interactive'`), guarded by `isAlive` (pile-up) + a `TASK_MAX_ATTEMPTS` ceiling (park `blocked`), and the
  agent **closes its own loop** with `task_update(done)`. This is the **A2A delegation path** (support→coding
  = a task assigned to `agent:<id>`; run-as passthrough keeps the accountable human). Agent tools
  `task_create`/`task_list`/`task_get`/`task_claim`/`task_update` (author/assignee server-derived); console
  **Tasks** Kanban board (primary nav, under Agents). §9 futures: pool auto-assignment, agent-triggered
  `task_dispatch`, a policy brake on dispatch. See `docs/tasks-plan.md`.
- `src/edge/dreaming.ts` — the **self-learning ("Dreaming")** engine: a periodic deterministic pass that
  reflects on recent episodes + outcomes + friction, **compounds** them into `settings: dreaming_state`,
  emits a living KB page + a tenant-shared memory Insight, and **closes the loop** — distilled guidance is
  injected into every agent's prompt (`buildCompanyMd`, toggleable) and config **recommendations** are
  proposed for a human to Apply/Dismiss (`/api/dreaming*`). See `docs/self-learning-plan.md`.
- `src/edge/consolidation.ts` — the **consolidation gardener** (lever 4 of the learning loop): selects
  recent fleet **episodes + lessons** since a watermark (`learning.consolidated` audit) and spawns a
  governed **headless `consolidator` agent** (provisioned into `<home>/agents/consolidator`) that
  abstracts the recurring, durable patterns into SHARED memories + KB pages via its own tools. Manual
  (`POST /api/dreaming/consolidate`) or opt-in after each dream pass (`consolidate_auto`). The wider
  **episodic↔semantic learning loop** — graded episodes (`episodeSalience` in `terminal.ts`), deliberate
  `report` **lessons**, and **retrieval reinforcement** (`rerank` `weightByUsage` + last-use recency in
  `src/memory/embedding.ts`) — is documented in `docs/memory-encoding-and-consolidation.md`.
- `src/state/db.ts` — the per-workspace SQLite database + migrations.
- `src/tenant-registry.ts` — the **multi-tenant registry**: builds + caches one full runtime per tenant
  (`AgentOS` + `TerminalManager` + `Automations` + `SlackSocket` + ttyd) and resolves the request's
  tenant (`x-aos-tenant` header → `slugForHost` subdomain → default). `startServer` builds it;
  `createHttpServer(registry)` dispatches into the right runtime via the unchanged `handle()`. `launchTtyd`
  lives here. `AGENT_OS_TENANT` overrides the seed slug (process-per-tenant). See the Multi-tenancy section above.
- `src/state/control.ts` — the **control plane** (`TenantStore`): the only NON-per-tenant store, a tiny
  separate DB at `<home>/control/control.db` listing tenants `{slug, ownerEmail, status}` with DNS-safe
  slug validation. Read at boot to build runtimes; written by superadmin provisioning.

## Persistence — per-workspace SQLite (`<home>/agent-os.db`)

Everything the live console touches persists in one SQLite DB per data home, via Node's **built-in
`node:sqlite`** (keeps the zero-dependency stance; `@types/node` v20 lacks the types, so
`src/state/sqlite.d.ts` declares the subset we use). Tables: `members`, `invites`, `auth_sessions`,
`assignments`, `member_identities` (external accounts → member, the chat run-as join key; PK
`(provider, external_id)`), `connectors`, `term_sessions`, `messages` (the inbox feed), `questions`,
`approvals`, `automations`, `slack_threads`, `discord_threads`, `artifacts`, `audit_events`,
`settings` (key→value: company context,
runtime defaults, memory config, **self-learning state/guidance/recommendations**, …), `memories`
(+ `memories_fts`; columns incl. `embedding`, `recall_count`, `last_recalled_at`, `scope`), and the
KB: `kb_pages` (+ `kb_fts`) + `kb_revisions`.

Conventions when touching the DB:
- `AgentOS` always has `this.db` (real file when `paths` is set, else ephemeral `:memory:` for demo/tests).
- Each store owns its tables (`TeamStore`, `ConnectorStore`, `SqliteApprovals`, `SqliteAuditSink`,
  `TerminalManager`). Keep public method signatures stable — many callers depend on them.
- Approval **records** persist, but the blocking `decision` promise is an in-memory waiter; a gate
  suspended across a restart stays pending and the gate-hook keeps polling. The inbox derives an
  approval message's status from the `approvals` table at read time (a JOIN), so it self-heals.
- JSONL remains the durable system-of-record for audit; the `audit_events` table is a queryable mirror,
  surfaced read-only at `GET /api/audit` (owner/admin; filter by session/type/principal) + the console
  **Audit** page. Approval cards also DM whoever can approve them via Slack/Discord
  (`TerminalManager.setApprovalNotifier` → `notifyApprovers` → identity map → `dmUser`; audited `approval.notified`).

## Team / roles / login

Identity behind the policy's approval levels. Roles: **owner** (runs everything, approves `owner`/red,
manages team), **admin** (approves `head`/yellow, manages team & assignments, runs any agent),
**member** (runs only assigned agents, never approves). Mapping is enforced by `canApprove(role, level)`
in `src/types.ts` and `TeamStore.canRun()`.

- **Login is invite-token / magic-link.** Owner is seeded on first `serve` (`AGENT_OS_OWNER_EMAIL`,
  default `owner@localhost`); the one-time link is printed to the console + `data/server.log`. Others
  get a link from the Team page or the CLI (`agent-os invite|login-link|members`). Accepting a token
  (`GET /accept?token=…`) mints a 30-day `aos_sid` cookie session.
- **Identity map (chat run-as).** A member can be linked to external accounts — `member_identities`
  (provider ∈ `slack|discord|email|github`), edited on the Team page (**Chat IDs**) or via
  `POST /api/team/:id/identities` + `DELETE …/:provider`. `TeamStore.memberByExternalId(provider, id)`
  is the join key chat triggers use to run a session AS the right person (one handle per provider; PK
  `(provider, external_id)` keeps it unambiguous; cascades on member removal). Discord depends on it
  (no email); Slack prefers it, then falls back to profile-email matching.
- **Run-as vs provenance (P2).** A session row separates **`spawned_by`** (PROVENANCE — `automation:<id>`
  or the console member that triggered it) from **`run_as`** (the IDENTITY it acts under). `createSession`
  takes an explicit `runAs`; identity = `runAs ?? memberOf(spawnedBy)` drives connectors/Composio/the
  isolation uid, and `canViewRow` grants the run-as member inbox/session/artifact visibility on top of
  the provenance rule (automation creator + owner/admin). So a chat-triggered run is owned by the
  automation for provenance yet acts as — and is visible to — the member who sent the message.
- **Auth in `server.ts`:** public routes are the app/assets, `/health`, `/accept`, `/hooks/<id>`
  (webhooks carry their own secret key), `/api/auth/me`, `/api/auth/logout`; every other `/api/*`
  requires a session (else 401). Role gates: approvals → `canApprove`; spawn → `canRun`;
  team/connector/automation mutations → owner/admin (role changes & member removal → owner only).
  Resolver identity is the member's email, not the old hardcoded `console-user`.
- Generated links (invites, webhook URLs) are built from the request's `Host` + `X-Forwarded-Proto`
  headers at read time. The cookie is `HttpOnly; SameSite=Lax`, 30 days.

## Production deployment (Linux / systemd)

> The current deployment is the **Mac Mini over Tailscale** (`your-box.tailnet.ts.net`,
> launchd `com.agentos.northwind` → `tailscale serve` http→3010; see the macOS section above and
> `docs/process-per-tenant.md`). The Linux/systemd + nginx runbook below stays as the reference for a
> hardened multi-user box — the code's prod behavior (the nginx `auth_request`, `X-Original-URI`,
> `X-Forwarded-*` handling) is built around it. Substitute your own `<host>` for the example domain.

- Hosted behind nginx at **https://`<host>`** — nginx config `/etc/nginx/sites-available/<host>`;
  app runs as the `agent-os` systemd service on port 3010 (ttyd on 3011), data home `./data`.
  Deploy = `npx tsc` + `cd web && npm run build` + `sudo systemctl restart agent-os` (restart also
  (re)starts the Automations scheduler).
- No basic auth — the app's own cookie login covers everything. ttyd does NOT pass through the app,
  so nginx gates `/terminal/` with `auth_request` → an internal location proxying `/api/auth/me`
  (200 → proxy, 401 → blocked). Don't remove that block: without it the writable terminals are open
  to the internet.
- **nginx gotcha that already bit us:** `proxy_set_header` inherits from the server level ONLY if a
  location sets none of its own. Every location there sets `Upgrade`/`Connection`, so each must
  repeat `Host`/`X-Forwarded-*` explicitly — otherwise the app sees `Host: 127.0.0.1:3010` and mints
  wrong invite/webhook links. There's a comment in the config; keep it.

## Versioning

Root `package.json` `version` is the single source of truth (`src/version.ts` reads it once at
boot). It surfaces at `GET /health`, `GET /api/state`, the console sidebar (next to the tenant
name), and `agent-os version`. Pre-beta convention: bump the **minor** for each feature merge and
the **patch** for fixes, in the same PR (`npm version <x.y.z> --no-git-tag-version` — never let npm
tag; tags come later with releases). Every feature/fix PR adds a line under **Unreleased** in
`CHANGELOG.md` (Keep-a-Changelog style), and the PR that bumps the version moves those entries into
a new version heading in the same commit. The sidebar version therefore tells you exactly which
build a long-running server is holding in memory — the first thing to check when a change "isn't
taking".

## Gotchas

- `node:sqlite` emits an `ExperimentalWarning` on first use; `src/cli.ts` filters just that one line.
- WAL mode creates `agent-os.db-wal`/`-shm` sidecars — all `*.db*` and `connectors/` are gitignored in
  `data/.gitignore`.
- `Date.now()`/`Math.random()`/argless `new Date()` are fine in app code, but tokens/sids use
  `crypto.randomBytes`.
- **Secrets vault master key** (`src/edge/secret-crypto.ts`): `$AGENT_OS_SECRET_KEY` (32 bytes hex/base64)
  wins; else an auto-generated `0600` `<home>/secret.key` (gitignored). **Don't lose/rotate it** — every
  value sealed under the old key fails to decrypt (and the vault fails closed → reads as unset). For tests,
  isolate `AGENT_OS_HOME` (a `loadAgentOS()` with no env writes `secret.key` into the LIVE `./data` home).
