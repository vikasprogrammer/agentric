# Agentric — working notes for Claude

A generic, governed operating system for running autonomous agents safely. The one invariant:
**every side effect an agent has on the world passes through a single mediated gateway** where
Policy classifies, Approvals suspends for a human, Budget debits, Identity asserts, Idempotency
dedupes, and Audit records. Remove the gateway and all of that becomes docs. Keep the core generic
and open-sourceable: `src/core` and the kernel import contracts only from `src/types.ts`, never from
brand/plugin code.

## Naming — "Agentric" is the brand, `agent-os` is the plumbing

The product is **Agentric** (agentric.io). That name is the **brand layer only**: user-facing copy
(console, README, `docs/`, agent-facing prompts, chat/bot display names, systemd `Description=`) plus
the **GitHub repo**, which is now **`vikasprogrammer/agentric`** — always pass `--repo
vikasprogrammer/agentric` to `gh` (GitHub permanently redirects the old `agent-os` URL, so existing
remotes keep working; never let a new repo claim that old name or the redirect dies).

Everything load-bearing keeps the `agent-os` identifier and MUST NOT be renamed here — the CLI binary
and npm package `agent-os`, `AGENT_OS_*` env vars, the `AOS_*` prefix, the `AgentOS` class, the
`mcp__agentos__*` tool namespace, the `/agent-os <agent>` chat command, systemd/launchd unit names
(`agent-os.service`, `com.agentos.northwind`), data homes (`~/agent-os-data/…`), `agent-os.db`, the
local checkout paths (`~/Projects/agent-os`, `~/agent-os-live`, `~/aos-wt`), and the GitHub **App**
slug `agent-os-northwind` (renaming that one changes its installation URLs and breaks per-member
GitHub auth). Those are live across the tenant boxes and baked into absolute paths; a full internal
rename is a **migration**, folded into the next box move, never a standalone sweep.

## This repo is PUBLIC — no real infrastructure in a tracked file

Every host, IP, ssh target, personal path, tenant slug and owner email in this repo is a
**placeholder**: tenants are `northwind` / `globex` / `initech` / `umbrella`, hosts are
`your-box.tailnet.ts.net` / `*.example.com`, IPs come from the RFC 5737 documentation ranges
(`203.0.113.x`, `198.51.100.x`), homes are `/home/agent-os` or `~/…`. Keep it that way — when you
document a real incident, write the placeholder, not the box you actually sshed into.

The real values live OUTSIDE the repo, on this machine only:
- **`~/.claude/agentric-fleet.local.md`** — the decoder ring (placeholder → real tenant/host/IP/App slug).
- **`~/.agentric-live.env`** (0600) — the live deploy identity `scripts/make-live.sh` sources
  (`AOS_LIVE_TENANT`, `AOS_LIVE_LABEL`, `AOS_LIVE_LOG`, …). Without it the script falls back to the
  generic `acme` defaults and fails fast with "launchd job com.agentos.acme is not loaded".
- **`~/.claude/skills/fleet-insights/`** — the maintainer skill that reads the live tenant DBs over ssh.
  It used to ship here; it carries ssh targets, so it is personal-scope now and must not come back.

The decoder ring is imported below, so on a maintainer's machine the real values are in context without
ever entering the repo; on anyone else's clone the import is simply a missing file and this stays a
placeholder-only public manual. **Never inline what it resolves to** — write the placeholder here and let
the import do the decoding.

@~/.claude/agentric-fleet.local.md

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
  KeepAlive, home `~/agent-os-data/northwind` (kept OUTSIDE the repo checkout so a spawned agent's
  parent-dir CLAUDE.md walk can't pick up this repo's own CLAUDE.md; new tenants go alongside as
  `~/agent-os-data/<slug>`), on :3010, fronted by `tailscale serve` http→3010): **"make it live" is
  `scripts/make-live.sh`** — it syncs the dedicated live checkout (`~/agent-os-live`) to `origin/main`,
  installs only if a lockfile moved, builds both bundles, gates on `npm run test:governance`, restarts
  via `launchctl kickstart` (never `pkill`), and verifies `/health` reports the version it just built,
  printing the rollback command if it doesn't. `--dry-run` shows what would deploy. The manual
  equivalent is `npm run build && launchctl kickstart -k gui/$(id -u)/com.agentos.northwind`; logs at
  `~/agent-os-data/northwind/server.log`; load/unload with `launchctl load -w|unload <plist>`.)
- **Agent-facing MCP tools (`src/memory/memory-mcp.ts` — `recall`/`remember`/`revise`/`forget`, the
  `kb_*` tools, `ask`/`check_inbox`/`report`/`update`/`publish`/`library_list`, `schedule`/`unschedule`,
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
  PreToolUse gate hook (`terminal/gate-hook.sh`). **Two real runtimes** — `claude-code` and `codex`
  (`AgentManifest.runtime`; `CODING_RUNTIMES` in `src/types.ts` declares what each supports, probed via
  `runtimeSupports()` / `isCodingRuntime()` — never compare runtime ids). `launchAgentRuntime` picks
  `terminal/<runtime>-launch.sh`; the gate hook is SHARED and switches its tool→capability routing table
  on `$AOS_RUNTIME`. Codex holds the invariant differently (shell via the hook, writes via an OS sandbox,
  MCP server-side) and degrades on attach/resident-chat/cost/skills — see `docs/codex-runtime.md`. At launch it resolves each claude-code agent's
  **runtime tuning** (`resolveRuntimeTuning` in `src/types.ts`: agent manifest → workspace default → CLI
  default) and exports `CLAUDE_MODEL`/`CLAUDE_EFFORT`/`CLAUDE_PERMISSION_MODE`, which `claude-launch.sh`
  maps onto `--model`/`--effort`/`--permission-mode` (model+effort both lanes; permission-mode interactive
  only — headless keeps `--dangerously-skip-permissions`; unset → `auto`, which only tunes the fallback for
  tools the gate hook doesn't govern, never the gate itself). A fourth knob, **`verbosity`**
  (`normal` | `terse`, same precedence chain), is NOT a CLI flag — `terse` appends `TERSE_OUTPUT_BRIEF`
  (`src/edge/verbosity.ts`) to the system prompt via `buildCompanyMd`, so it reaches both runtimes. It
  compresses the agent's NARRATION only; code/errors and every durable artifact (`report`, `remember`,
  `kb_write`, task notes, chat replies) are explicitly exempt, because terse prose there would degrade the
  learning loop and the human-facing surface far from the flag that caused it. It's a prompt instruction,
  not an enforced transform, so it ships with its own falsifier: the resolved level is stamped onto
  `term_sessions.verbosity` and `verbositySavings()` compares terse vs normal **per turn, per agent**
  (Settings → Runtime defaults). Never quote a saving from the fleet-wide pair — it mixes different work.
  It also resolves the agent's opt-in
  **`shellSecrets`** (manifest list of vault keys, e.g. `["GH_TOKEN"]`) via `injectShellSecrets` and
  exports each as a shell env var (so a plain CLI like `gh` authenticates); connectors still get theirs
  via the MCP bag. Agent-scoped principal (widening to `*`), audited `shell.secret.injected`/`unresolved`.
  A **second, admin-driven path** exports the same way: `injectAssignedSecrets` reads the
  **`secret_assignments`** table — the inverse view of `shellSecrets`, managed from **Settings → Secrets**
  (assign a stored secret to agents rather than declaring keys in each manifest). An assignment names the
  secret by its `(owner-principal, key)`, so one canonical value fans out to many agents without a
  per-agent copy; injection resolves that owner's value and exports it (audited
  `shell.secret.injected`/`unresolved` with `via:'assignment'`). Both paths are **injection only** — an
  assignment never widens who can `secret_get` a value. Then
  **`injectMemberGithub`** runs right after: if the run's **run-as member** linked their own GitHub
  account (per-member OAuth — `src/edge/github-identity.ts`, `docs/per-member-github-plan.md`), THEIR
  vault-stored user token OVERRIDES the agent bot's `GH_TOKEN`/`GITHUB_TOKEN`, so git/PRs are authored as
  the actual human (bot = fallback). Token stored under the member principal (never shared `*`), refreshed
  on demand; audited `github.token.injected`.
- `src/governance/` — `policy.ts` (JSON rule engine; first-match, glob capability + `when` arg predicates.
  `withAlwaysAllow`/`hasHardDeny` back the Inbox **"Always approve"** — an owner appending a durable `allow`
  rule from an approval card, inserted AFTER every `never` so deny guardrails survive; `POST
  /api/approvals/:id/always`, audited `policy.rule.added`), `approvals.ts`, `audit.ts`, `team.ts`,
  `settings.ts` (Company context **+ workspace runtime defaults**: the fleet-wide model/effort/permission
  fallback, `runtimeDefaults`/`setRuntimeDefaults`), `skills.ts` (global `.claude/skills` library,
  materialised into every claude-code agent at launch by `TerminalManager`), budget, identity.
  The Inbox surface itself — its data model, the notifier/chat-mirror sinks, per-member read/dismiss, and
  the gap roadmap — is documented in `docs/inbox-plan.md`.
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
  Composio company Slackbot). **Thread continuity:** a follow-up message inside a thread already bound to a
  session (`slack_threads`) continues THAT conversation instead of re-triggering — `dispatch` calls
  `Automations.continueSlackThread` (finds the newest session for `channel`+`thread_ts` via
  `TerminalManager.sessionForSlackThread`, then spawns a run that `claude --resume`s the SAME transcript,
  keeping context; a still-busy agent gets a "pick this up next" note, no overlapping run). This needs the
  pinned claude id — headless runs now launch with `--session-id $CLAUDE_SESSION_ID` (stored in
  `term_sessions.claude_session_id`). Caveat: plain in-thread replies only reach the socket if the Slack app
  subscribes to `message.channels`/etc. AND the bot is in-channel (`app_mention` covers only @mentions). The
  socket re-dials when tokens change; uses the Node 22+ global `WebSocket`
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
  Per-automation **execution mode**: `headless` (default) and `interactive` now run the SAME way — an
  attachable interactive claude TUI (NOT `claude -p`) with `--dangerously-skip-permissions` (the PreToolUse
  gate hook still runs + blocks risky Bash under that flag). The difference is teardown: an `headless`
  (unattended) run is closed by the SERVER at turn-end — the Stop hook (`terminal/stop-hook.sh`) beacons
  `/api/turn-idle` → `TerminalManager.markTurnIdle` kills the pane so tmux drops and the pile-up guard
  releases (parity with the old `-p` exit) UNLESS a human has taken it over / is watching / it's blocked on
  a person; `interactive` stays live until closed. `UNATTENDED=1` (was `HEADLESS=1`) selects the lane in
  `terminal/claude-launch.sh`. **Take-over** is now lossless: `POST /api/sessions/:id/interactive` →
  `claimSession` just marks the live run claimed (sticky, no kill/resume) and the console attaches to the
  still-streaming pane. See `docs/attachable-sessions-plan.md`.
- `src/memory/` — the **memory plane** (per-agent persistent recall). `index.ts` factory →
  `sqlite-provider.ts` (default; FTS5 bm25 keyword recall, **+ optional in-JS-cosine hybrid** when an
  embedder is set), `libsql-provider.ts` (native in-file vectors; opt-in `@libsql/client`),
  `automem-provider.ts` (REST to a FalkorDB+Qdrant automem deployment; opt-in — tag-isolated single
  collection, tenant-shared scope supported), shared `embedding.ts` (`Embedder` openai/ollama, cosine, RRF
  `fuse`, `planConsolidation`, the `rerank` recency/importance nudge). **Decoupling note:** Dreaming,
  the consolidation gardener, and the Memory-hub overview counts read the local `memories` **table**
  directly (not via the provider), so an EXTERNAL backend (automem/libsql) is wrapped by
  `mirror.ts` (`MirroredMemoryProvider`) which copies every write into that table — recall goes to the
  upgraded store, the self-learning loop keeps working. The `sqlite` backend IS the table (no wrap).
  Backend + ranking + maintenance (prune/dedupe) + **shared `scope` (agent | tenant)** are all config in
  **Settings → Memory**, hot-swapped live. `memory-mcp.ts` = the OS-owned stdio MCP server injected into every session — 60 always-on tools
  + 11 conditional (chat-reply / egress / media, each exposed only when its env flag is set; full list
  in `docs/agent-mcp-tools.md`). Memory: `recall`/`remember`/`revise`/`forget` (recall returns each memory's id, the
  handle for revise/forget). Episodic self-query (the run-history companion to semantic memory):
  `session_history` lists the agent's OWN past sessions (id/title/status/rating, own-scoped, "have I done
  this before?") and `session_open` reopens any one — the friendly transcript timeline (`readConversation`)
  or a `summary:true` recap — gated server-side to the caller's own agent. KB:
  `kb_search`/`kb_read`/`kb_write`/`kb_history`/`kb_revert`. Operator/inbox:
  `ask`/`check_inbox`/`report`/`update`/`notify`/`publish`/`library_list` (session cards are
  **owner-scoped** — addressed to the run's `run_as`/spawner via the `sessionOwner` audience — so the
  Inbox default `mine` view isn't flooded; `notify({to,message})` is the escape hatch to loop in ONE
  named teammate, and owner/admin flip to `?scope=all` for oversight). Skills: `skill_propose` (draft a
  reusable playbook — Lever 6 procedural memory; lands as a NOT-YET-PUBLISHED `.aos-proposed` skill +
  a `skill.proposed` inbox card, gated behind an owner/admin publish), plus `skill_find` (discover the
  installed library + bundled catalog, and — with a `query` — matching community skills from the skills.sh
  directory) / `skill_request` (ASK an owner/admin to install a skill — never self-installs; `source`
  omitted ⇒ bundled catalog, `source:'owner/repo'` ⇒ a remote GitHub repo resolved at request time; posts a
  `skill.request` card, human installs via `POST /api/skills/requests/:id/approve` — catalog install or
  `fetchSkill`+`installFiles`. Delivery: next launch normally, but if the requesting agent has a LIVE
  interactive (resident) session, `TerminalManager.refreshAgentSkills` materialises the skill into its
  watched `.claude/skills` + injects `/reload-skills` (claude ≥2.1.152) so it's usable same-session —
  headless runs, which exit, still get it next run. `.claude/skills` is always created at launch even for
  a zero-skill agent, since claude only watches a dir that existed at startup). Scheduling: `schedule`/`unschedule`
  (one-shot deferred self-run via a `type:'once'` automation) + `stop` (the session ENDS ITSELF —
  loopback to `/api/agent/stop` → the same `TerminalManager.stopSession` halt the console kill button
  performs, `by` = the agent id). Tasks (shared work queue):
  `task_create`/`task_list`/`task_get`/`task_claim`/`task_update`/`task_wait`/`task_dispatch`/`task_attach`
  (file/claim/drain durable work + attach a file from the agent's folder onto a task; an
  agent-assigned `autoDispatch` task spawns a governed session — the A2A delegation path; per-task `mode`
  headless/interactive; owner = run-as passthrough so a hand-off keeps the accountable human). `task_dispatch`
  kicks an agent-assigned task into a session NOW instead of waiting on the tick (`guard:true` pile-up brake +
  `TASK_MAX_ATTEMPTS` ceiling); **`task_wait`** (or `task_create({ wait:true })`) makes the hand-off
  SYNCHRONOUS — the caller BLOCKS until the delegate finishes and resumes with its result, each poll kicking
  the same guarded dispatch so waiting drives the work (and retries a crashed run). An agent `task_create` now
  also dispatches an `autoDispatch` hand-off immediately (parity with the console) instead of waiting for the tick. Secrets
  (shared credential handoff): `secret_put`/`secret_get`/`secret_list`/`secret_request` — an agent stores a password/key
  tenant-wide under a KEY (approval-gated `secret.put`; value kept out of audit/approval-card/policy args,
  encrypted at rest), hands the key NAME to another agent, who `secret_get`s it read-once. `secret_request`
  is the ASK counterpart for a credential the agent needs — it carries only the key + reason, never a
  value, so nothing lands in the session transcript, and **auto-detects two modes**: `provide` (the key
  isn't in the vault → a human types the value into a password field, sealed under the agent's principal
  or tenant-wide `*`) and `access` (the key EXISTS but is scoped away from the agent → a human GRANTS it;
  the server re-scopes the existing sealed value to the agent, no re-type, agent-scoped not widened). Posts
  a `secret.request` card to owner/admins (Inbox + **Settings → Secrets → Agent requests**); resolved via
  `POST /api/secrets/requests/:id/fulfill` (either mode can also inject into the agent's shell);
  short-circuits `exists`/`duplicate`, audited `secret.requested` (+`mode`) / `secret.request.fulfilled` /
  `secret.request.granted` / `secret.request.dismissed` (never the value). (Complementary,
  admin-side: **Settings → Secrets** can *assign* a stored secret to agents — `PUT /api/secrets/agents`,
  the `secret_assignments` table — so it's injected into each assigned agent's shell at launch, the
  central-grant inverse of manifest `shellSecrets`. Injection only, not a `secret_get` grant.) GitHub
  self-recovery: `github_refresh` — an agent whose injected `GH_TOKEN` (the run-as member's ~8h user
  token) goes bad mid-run (`git`/`gh` → "Bad credentials") FORCES a token refresh (`GithubIdentity.forceRefresh`
  via the stored `ghr_`, unlike launch-time `ensureFresh` which only fires within the expiry skew) and
  gets the fresh token back to `export GH_TOKEN=…` (env can't be mutated externally; the git credential
  helper + `gh` re-read `$GH_TOKEN` at call time). Its own identity, already injected — no new exposure;
  typed statuses tell it to stop retrying + have the human re-link when there's no refresh token. Agents
  (build + self-improve): `agent_create` (spin up a new governed teammate) and the **self-only**
  `agent_update`/`agent_history`/`agent_revert` — an agent refines its OWN listing (description, starter
  prompts, tuning) + CLAUDE.md system prompt and can roll back a bad self-edit; every change snapshots a
  reversible revision (`src/state/agent-revisions.ts`, the KB-style rollback backbone). To edit ANOTHER
  agent, `agent_propose_update` is the cross-agent path, and what a proposal is worth is decided by the
  **proposer's maturity** (`src/state/agent-stats.ts`) against the workspace `AgentProposalTrust` tiers
  (Settings → Runtime → Cross-agent edits): below `minMaturity` (0.4) it's **refused** outright; in the
  middle band it's propose-don't-apply — writes nothing, posts an owner-addressed `agent.update.proposed`
  card, applies only when an **owner who can run the target** approves (`POST /api/agents/proposals/:id/approve`)
  and an admin can't; at/above `autoApplyAt` (0.8, `autoApply:false` disables the tier) it **applies
  immediately** with the owner notified after the fact. All three lanes share one write path —
  `applyAgentEdit` in `src/state/agent-edit.ts` — so every outcome snapshots a revertable revision (author
  `agent:<proposer>` on the auto lane, the approver on the gated one). The top tier is the only place an
  agent changes another agent with no human in the loop; it's hard to reach by construction (maturity is
  damped by `volumeConfidence`, so ~32+ clean autonomous runs), and it's revertable, not undoable-only.
  **`claudeMd` REPLACES the whole prompt**, which produced two clobbering incidents in one live session
  (a *fragment* submitted over a teammate's 9.5KB prompt; a hand-retyped self-edit that dropped a
  section). So both write lanes now share the guards in `src/state/agent-edit.ts`: a read counterpart
  (`agent_get`, returning the prompt verbatim + a `baseHash`), anchored **patch mode**
  (`claudeMdEdits`/`claudeMdAppend` — `resolveClaudeMd`, harness-`Edit` uniqueness), a `baseHash`
  precondition so a stale read is a **conflict** not a clobber, `dryRun`, and `assessClaudeMdEdit` — a
  rewrite deleting >20% or dropping a `#` heading needs `confirmRewrite` on the self lane and **forces
  the gated lane whatever the maturity tier** on the cross-agent one (as does a proposer's first edit of
  that target: maturity predicts intent, not correctness of transcription). Both tools echo the
  **server-composed `message`** rather than writing their own outcome sentence — an MCP process outlives
  a server upgrade, which is how a live session reported "NOTHING changes until an owner approves" about
  an already-applied edit. Pinned by `scripts/agent-edit-guard-test.cjs`. Governance (propose, don't apply): `policy_propose` — an agent that spots a weak
  guardrail proposes a **TIGHTEN-ONLY** ruleset change (`tighten` a rule stricter, `reorder` a conditional
  rule above the unconditional allows — the first-match ordering fix, or `add` a new `ask`/`never`
  guardrail). `applyProposal` (`src/governance/policy.ts`) refuses any loosening (by construction + an
  exhaustive monotonicity sweep), hard-deny edit, default change, or added `allow`; a valid proposal posts
  an owner-addressed `policy.proposal` card and applies NOTHING until an **owner** approves
  (`POST /api/policy/proposals/:id/approve`, re-validated). Every applied policy edit (console,
  always-approve, approved proposal) snapshots to `policy_revisions` via `AgentOS.applyPolicyDocument` and
  is one-click revertable (owner). Plus
  `directory_lookup` (team/identity-map
  search), `list_capabilities`/`policy_check` (policy preview), `slack_reply`/`discord_reply` when
  chat-triggered, and **proactive egress** `slack_send`/`slack_dm`/`discord_send`/`discord_dm` (exposed
  whenever that platform is configured — `SLACK_EGRESS`/`DISCORD_EGRESS`) to post to ANY channel (by
  id/name, auto-joining public Slack channels) or DM ANY person (Slack: user id / email; Discord: user
  id), off-thread and unattended; audit-only (`slack.send`/`slack.dm`/`discord.send`/`discord.dm`), no
  policy gate — same posture as `slack_reply`. Each tool is a session-secret-gated loopback call to an `/api/*` route that sits BEFORE
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
  **Tasks** Kanban board (primary nav, under Agents). A `TaskStore` notifier (`setNotifier`, wired in
  tenant-registry like `setOverdueNotifier`) fires on create/(re)assign/status so **every** mutation path
  (console, MCP, dispatcher) lands an **audience-addressed Inbox card + DM** for the right human —
  assignee on create/assign, owner on blocked/done — via `notifyTaskEvent` → `postTaskCard` +
  `resolveRecipients`/`deliverDM` (agent-assigned & self-actions stay quiet). §9 futures: pool
  auto-assignment, agent-triggered `task_dispatch`, a policy brake on dispatch. See `docs/tasks-plan.md`.
- `src/edge/dreaming.ts` — the **self-learning ("Dreaming")** engine: a periodic deterministic pass that
  reflects on recent episodes + outcomes + friction, **compounds** them into `settings: dreaming_state`,
  emits a living KB page + a tenant-shared memory Insight, and **closes the loop** — distilled guidance is
  injected into every agent's prompt (`buildCompanyMd`, toggleable) and config **recommendations** are
  proposed for a human to Apply/Dismiss (`/api/dreaming*`). See `docs/self-learning-plan.md`.
- `src/edge/consolidation.ts` — the **consolidation gardener** (lever 4 of the learning loop): selects
  recent fleet **episodes + lessons** since a watermark (`learning.consolidated` audit) and spawns a
  governed **headless `consolidator` agent** (provisioned into `<home>/agents/consolidator`) that
  abstracts the recurring, durable patterns into SHARED memories + KB pages via its own tools. Not a
  separate action anymore — it's the second half of one **"reflect"** pass: `POST /api/dreaming/run`
  (and the scheduled tick) runs the deterministic Dreaming pass then this gardener over new material
  (no-ops below `MIN_ITEMS`). One button ("Reflect now"), one concept. The wider
  **episodic↔semantic learning loop** — graded episodes (`episodeSalience` in `terminal.ts`), deliberate
  `report` **lessons**, and **retrieval reinforcement** (`rerank` `weightByUsage` + last-use recency in
  `src/memory/embedding.ts`) — is documented in `docs/memory-encoding-and-consolidation.md`.
- `src/terminal.ts` also derives the **hand-off chain** (`sessionChain` → `GET /api/sessions/:id/chain`,
  the console's chain rail): runs fold into CONVERSATIONS by `claude_session_id` (a `poke:` run RESUMES a
  transcript, so several rows are one conversation), and conversations nest under the caller that
  delegated them (`tasks.caller_claude_id` → the `task:`/`ask:` runs dispatched for it). Nothing new is
  stored. Two folding rules the live data forced: a conversation's cost is the **max** of its runs (cost
  is per-transcript and cumulative — summing multiplies one bill by the number of resumes), and its
  verdict + summary come from the SAME reporting run. `listSessions` stamps `threadId`/`parentThreadId`/
  `taskId` on every row (one batched query) so the sessions list can collapse the same way. Tested by
  `scripts/chain-model-test.cjs`.
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
`(provider, external_id)`), `connectors`, `term_sessions`, `messages` (the inbox feed; a row may carry an
explicit `audience_kind`/`audience_id` to route a session-less card — e.g. a Tasks notification — to a
member, else visibility falls back to its session's provenance), `questions`,
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
  Agent **questions** get the same out-of-band ping (`setQuestionNotifier` → `notifyQuestionAsked` → the
  run-as human, else owner/admins; audited `question.notified`), so a blocking `ask` isn't missed. **Who
  receives an out-of-band notification is resolved in ONE place** — `resolveRecipients(os, audience)` in
  `src/governance/recipients.ts` (the `Audience` vocabulary: `approvers`/`admins`/`member`/`sessionOwner`);
  every notifier declares an audience and shares `deliverDM` (identity-map → `dmUser`) rather than
  re-deriving members. And a
  chat-triggered run mirrors its completion/question/approval back into the Slack/Discord thread it came
  from (`setChatMirror` → `slack.reply`/`discord.reply` over the `slack_threads`/`discord_threads` bindings;
  no-op for non-chat runs) — read/dismiss on the shared feed are **per-member** (`message_state` join).

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
  (webhooks carry their own secret key), `/api/auth/me`, `/api/auth/logout`, `/api/auth/request-link`
  (self-service recovery — see below); every other `/api/*` requires a session (else 401). Role gates:
  approvals → `canApprove`; spawn → `canRun`; team/connector/automation mutations → owner/admin (role
  changes & member removal → owner only). Resolver identity is the member's email, not the old hardcoded
  `console-user`.
- **Getting in without an admin (self-service recovery).** Login is still invite-token / magic-link, but
  a member who lost their session no longer needs an owner to mint a fresh one: the login screen's
  **"Email me a link"** posts to public `POST /api/auth/request-link`, which mints a fresh 7-day
  magic-link for the known member and delivers it out-of-band — DM'd to their linked Slack/Discord
  (`notifyLoginLink` in `tenant-registry.ts` → `deliverDM`, identity map) AND written to `server.log`
  (the always-available fallback). The response is **always neutral** (`{ ok: true }` regardless of
  whether the email is a real member — no account enumeration) and rate-limited per email + client IP
  (`allowLinkRequest`, 3 / 15 min). Sessions **slide**: `resolveSession` bumps the 30-day expiry on
  activity (≤1 write/day) and `/api/auth/me` re-stamps the cookie on each app load, so an active user
  never hits the hard cutoff. Owner recovery of last resort is still the CLI (`agent-os login-link`).
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
- **nginx gotcha that bit the umbrella deploy (2026-07-15) — conditional `Connection: upgrade`.** The
  Node server both proxies WebSockets (the terminal) and serves plain HTTP through the SAME port, so a
  hardcoded `proxy_set_header Connection "upgrade";` makes **every non-WebSocket request 502** with
  `upstream prematurely closed connection while reading response header` (the server reads `Connection:
  upgrade` on a plain request as a socket-upgrade attempt and destroys it). Fix = the standard
  `map $http_upgrade $connection_upgrade { default upgrade; "" close; }` + `proxy_set_header Connection
  $connection_upgrade;` so plain requests get `Connection: close`. Symptom is deceptive: `curl` straight
  to `127.0.0.1:3010` (and a raw `nc` HTTP/1.1 request) both return 200, only the nginx hop 502s.
- **nginx gotcha that bit umbrella again (2026-07-16) — a literal backslash before every `$variable`.**
  If the site config was generated through a shell heredoc/`sed` that escaped the `$` and the backslash
  leaked onto disk (`proxy_set_header Host \$host;`, `Upgrade \$http_upgrade;`, …), nginx emits the value
  **with a leading backslash** — `Host: \aos.example.com` — and a bogus non-empty `Upgrade: \` on EVERY
  request (empty `$http_upgrade` still yields `\`). The Node app tolerates the malformed `Host` so the
  console loads normally, but **ttyd/libwebsockets strictly validates it and 403s the WebSocket
  handshake**, so ONLY the browser terminal breaks: it renders **blank** and the access log shows
  `GET /terminal/ws → 403`, while sessions otherwise spawn fine (live tmux pane, working API — a spawn
  bug that isn't one). Nail it by tcpdumping the nginx→ttyd hop
  (`tcpdump -i lo -A 'tcp port 3011'`): healthy shows `Host: aos.example.com`, broken shows
  `Host: \aos.example.com` — the header-value backslash is the only diff (direct `curl` to ttyd with a
  clean Host = 200, through nginx = 403). Fix = strip them: `sudo sed -i 's/\\$/$/g' <site.conf>` (leaves
  a legit no-backslash `$connection_upgrade` from the conf.d map untouched), `nginx -t`, `reload`. Verify
  `/terminal/`+cookie → 200, no-cookie → 401, WS handshake (`Upgrade` + `Sec-WebSocket-Protocol: tty`) →
  101. Was isolated to umbrella (that one config was hand-written differently); jump-server + initech
  configs were clean.
- **Hardened-unit gotcha — `ReadWritePaths=` dirs must pre-exist.** Under `ProtectHome=read-only` the
  unit fails to start with `status=226/NAMESPACE` (`Failed to set up mount namespacing: <path>: No such
  file or directory`) if any carve-out path is missing. On a fresh box `~/.config`/`~/.cache`/`~/.claude`
  often don't exist yet — `mkdir -p` them before the first `systemctl start`.
- **⚠ `ProtectHome=read-only` silently HANGS every interactive session on the trust dialog (umbrella,
  2026-07-15).** `terminal/claude-launch.sh` pre-accepts Claude Code's one-time folder-trust dialog by
  seeding `hasTrustDialogAccepted` into **`~/.claude.json`** — a file in the HOME ROOT, written via
  atomic temp-file + rename, so it needs the home **directory** writable, not just `~/.claude`. With
  `ProtectHome=read-only` + `ReadWritePaths=…/.claude` (the sub-dir only), that write fails and is
  swallowed by the seeder's `|| true`, so trust is never recorded and every run — **interactive AND
  unattended alike** — parks forever on "Do you trust the files in this folder?". (Correction, verified
  2026-07-20: `--dangerously-skip-permissions` does NOT dodge this — it suppresses per-tool permission
  PROMPTS, not the folder-trust dialog; only the `~/.claude.json` pre-seed does. The pre-attachable
  `claude -p` headless lane sidestepped it because print-mode never shows the dialog, but the current
  UNATTENDED lane is an attachable interactive TUI, so a failed seed hangs it exactly like interactive.
  Same seed also silently misses when the home is a **symlink** — macOS `os.tmpdir()` returns
  `/var/folders/…`, a link to `/private/var/…`: Claude opens the workspace by its REAL path, so the trust
  key must be seeded under the real path (`realpathSync` the home) or the dialog still fires. This bites
  in-process test harnesses on scratch homes; prod homes are real paths.) **Deceptive symptom:** the
  session row is `running` and the tmux pane is alive, `capture-pane` shows the trust prompt. **Fix:** make the service user's home writable
  (`ReadWritePaths=/home/<svc>`) and re-lock persistence vectors (`ReadOnlyPaths=/home/<svc>/.ssh`),
  keeping `ProtectSystem=strict`. The bundled `agent-os.service` now ships this pattern.

## Multi-session development (git worktrees)

Several Claude sessions (and the fleet) edit this ONE checkout **concurrently** — two sessions writing
the same files, or one running `git switch` under another, silently clobber each other (on 2026-07-07 a
commit landed on the wrong branch this way). So the **primary checkout `~/Projects/agent-os`
is kept on `main`, clean, and never edited directly** — it exists only to sync with origin, integrate
finished work, and run the live service. **All development happens in per-session worktrees.**

`scripts/wt.sh` wraps the loop (worktrees live under `~/aos-wt/<name>`; override with `AOS_WT_HOME`):
- `scripts/wt.sh new <name>` — create `~/aos-wt/<name>` on `feat/<name>` off `origin/main`, with the
  primary checkout's `node_modules` symlinked in so typecheck/build run without an install. Develop and
  commit **there**, never in the primary checkout.
- `scripts/wt.sh list` · `scripts/wt.sh sync` (ff-pull `main` in the primary) · `scripts/wt.sh done <name>`
  (remove the worktree + delete `feat/<name>`).
- `scripts/wt.sh integrate <name…>` — spin up a fresh `batch/<ts>` worktree off `origin/main` and merge
  the named feature branches into it. Then, **merge locally, push once**: bump the version + CHANGELOG
  a single time for the whole batch, `npm run build && (cd web && npm run build) && npm run test:governance`,
  push the batch branch, and open **one consolidated PR** (`gh … --repo vikasprogrammer/agentric`,
  `gh pr merge --squash`). Never `switch`/branch the primary checkout to integrate.

"Make it live" still runs from the primary checkout after `wt.sh sync` (build + `launchctl kickstart` —
see Versioning / the macOS section).

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

**Bump with `npm version`, never by hand-editing `package.json`.** The lockfile also records the root
version (in `.version` AND `.packages[""].version`), and npm rewrites both on the next `npm install`.
So a hand bump leaves `package-lock.json` behind, and the drift surfaces on the DEPLOY box:
`scripts/make-live.sh` runs `npm install`, npm rewrites the lock, and the live checkout is suddenly
"dirty" — the deploy refuses until it's re-run with `--force`, which trains everyone to force past a
guard whose only job is to notice that someone edited the live checkout. `scripts/version-sync-test.cjs`
(first in `npm run test:governance`, no build needed) is the falsifier: it fails the deploy gate on
drift and prints the one-line fix.

## Gotchas

- **Claude Code ships side-effect channels the gate hook doesn't know about — assume new ones.** The gate
  hook's tool→capability table ends in `*) exit 0` ("any other built-in isn't a world side effect"), which
  is right for `Read`/`Glob`/`Grep` and wrong the moment a release adds a tool that reaches outside the
  session. **Cross-session messaging** (2.1.224) is the live example: each session binds an inbox socket
  and `SendMessage`/`ListAgents` address any session owned by the same OS user on the same machine — i.e.
  the whole fleet, across tenants, on one box — with no policy check, no audit event, and none of the
  run-as identity/owner/provenance that `task_create`/`task_wait`/`notify`/poke-back carry. Its delivery
  default keys off permission MODE, so `--dangerously-skip-permissions` (every unattended run) is the
  bypass class and a bypass→bypass pair delivers with no dialog. Shut off at the settings layer in
  `terminal/claude-launch.sh` (`crossSessionInbound: "refuse"` + `isolatePeerMachines: true`) rather than
  by denying the tools, since the same `SendMessage` also serves subagents/agent teams inside one session.
  When claude-code updates, diff the tools reference against that routing table.
- **The box owner's `~/.claude` is an undeclared input to every agent.** A session runs as the same OS user
  as the human who owns the machine, so it loads their user-scope `settings.json` — `enabledPlugins` above
  all, which drags in a plugin's subagent types, skills, slash commands and **SessionStart prompt hooks**.
  Installing a plugin for your own use silently changes how every fleet agent behaves (live example: the
  `caveman` plugin turning up as `caveman:cavecrew-reviewer(…)` subagent calls inside northwind runs, its
  prompt hook reshaping their output). `--settings` only ADDS a layer; it doesn't replace the user one.
  Fix is `AOS_CLAUDE_CONFIG_ISOLATION=1` (default off) → `CLAUDE_CONFIG_DIR=<tenant home>/claude-config`
  (`src/edge/config-isolation.ts`). Two things MUST ride along or it's worse than the leak:
  `.credentials.json` (an empty dir doesn't fall back to the box login — it hangs on the login picker) and
  `projects/` (the server resolves transcripts from ITS own env, so moving them blanks the conversation
  view + chain), both as symlinks back to `~/.claude`. Rotation wins over it — a pooled account already is
  an isolated config dir. Watch `claude.config.isolated` for `credentials: detached`.
- `node:sqlite` emits an `ExperimentalWarning` on first use; `src/cli.ts` filters just that one line.
- WAL mode creates `agent-os.db-wal`/`-shm` sidecars — all `*.db*` and `connectors/` are gitignored in
  `data/.gitignore`.
- `Date.now()`/`Math.random()`/argless `new Date()` are fine in app code, but tokens/sids use
  `crypto.randomBytes`.
- **Secrets vault master key** (`src/edge/secret-crypto.ts`): `$AGENT_OS_SECRET_KEY` (32 bytes hex/base64)
  wins; else an auto-generated `0600` `<home>/secret.key` (gitignored). **Don't lose/rotate it** — every
  value sealed under the old key fails to decrypt (and the vault fails closed → reads as unset). For tests,
  isolate `AGENT_OS_HOME` (a `loadAgentOS()` with no env writes `secret.key` into the LIVE `./data` home).
