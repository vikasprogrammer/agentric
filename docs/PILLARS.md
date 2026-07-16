# Agent OS — Product Pillars & Implementation Status

The platform decomposes into these pillars. Status is graded against the code as of 2026-06-13;
pillars 6–13 re-verified against source on 2026-06-21. **Reconciled against the code again on
2026-06-29:** the summary table held, but two detail sections had drifted behind it and are now
rewritten to match — **§10 Dreaming** (the compounding self-learning engine had shipped; the section
still read 🌱 Seed) and **§15 Knowledge Base** (graded ✅ in the table but had no detail section). Then,
as the **chat-channels v1** work landed, **§4 Team** (added the `member_identities` identity map) and
**§7 Automations** (added native **Slack + Discord** ingress, run-as the sending member; regraded ✅)
were updated. **Updated 2026-07-11:** **§12 Skills** regraded 🟡 → ✅ — skill **import** (bundled
catalog + any GitHub repo / skills.sh + `.zip`), the **agent-driven, human-gated request flow**
(`skill_find`/`skill_request` → owner/admin install, never self-install), procedural `skill_propose`, and
**same-session delivery** (`/reload-skills` into a live interactive run) on BOTH gating paths — approve
*and* publish (`refreshAgentSkills` targets `headless = 0` sessions; the earlier `resident`-only filter
was a bug). **Added 2026-07-13:** **§17 Media** — a new pillar (graded ✅) covering the modalities Claude
lacks natively: image/video **generation** (`image_generate`, `video_generate` incl. image→video),
**editing** (`image_edit` — prompt edit · upscale · `remove-background`), and **understanding**
(`video_understand`, video→text), backed by Atlas Cloud and flowing into the Library (§14); all governed,
cost-metered, and hardened with timeouts + retry (`src/edge/vendor-fetch.ts`). All other grades +
narratives still hold. Live v1 milestone tracker: `docs/v1-mvp-scope.md`.

**Cross-cutting:** how agents are *granted* reach — the relationship between §3 Connectors, §5 Policy,
and §8 Secrets — is mapped in [`access-model.md`](./access-model.md) (`Creds → Connections →
Capabilities`), the taxonomy north-star that sits beside [`governance-model.md`](./governance-model.md).

- ✅ **Working** — usable end-to-end today
- 🟡 **Partial** — core exists, meaningful gaps remain
- 🌱 **Seed** — interface/reference impl only, nothing real wired
- ⬜ **Not started** — named here so it has a home, no code yet

| # | Pillar | Status | One-liner |
|---|--------|--------|-----------|
| 1 | Agents & Sessions | ✅ | Manifest-driven agents, real Claude in tmux, persisted sessions |
| 2 | Inbox | ✅ | Tasks · updates · approval/question cards, SQLite-backed, role-aware; per-member read/dismiss; out-of-band DMs for approvals **and** questions + chat-thread mirroring. See [`inbox-plan.md`](./inbox-plan.md) |
| 3 | Connectors | ✅ | MCP catalog → per-session `.mcp.json`, every call still gated |
| 4 | Team | ✅ | Roles (owner/admin/member), magic-link login, agent assignment, identity map (external accounts → member) |
| 5 | Policy | ✅ | JSON rule engine + console editor (owner-edit, live hot-reload, persisted). **Learnable from the Inbox** — an approval's owner-only "Always" adds an `allow` rule (safely, after all `never` rules). Single ruleset per workspace; no dry-run simulator |
| 6 | Audit Logs | ✅ | JSONL system-of-record + SQLite mirror + console **Audit** viewer (filter by session/type/principal) |
| 7 | Automations | ✅ | Cron + webhook + native **Slack & Discord** triggers spawn governed sessions, run-as the sending member; a **generic `/agent` chat router** reaches any agent by name with no per-agent automation (replies threaded); **agent-scheduled one-shots** (`schedule`/`unschedule` MCP tools → `type:'once'`, bounded + human-cancellable) let an agent defer a future run of itself; email inbound still out |
| 8 | Secrets | 🟡 | Encrypted-at-rest vault (AES-256-GCM) + console UI; connectors resolve `secret:` refs at launch; agents get shell env vars via manifest `shellSecrets` or per-secret agent assignment; no key rotation yet |
| 9 | Memory layer | 🟡 | Per-agent + **shared workspace-wide** `remember`/`recall` (+ agent self-correction via `revise`/`forget`, recall returns ids) MCP server + console **Memory hub** (the store; the self-learning surface moved to its own top-level **Insights** page) live; three backends — sqlite (keyword, or hybrid keyword+vector with embeddings), libsql (native vectors), automem — switchable live in Settings → Memory backend. **Episodic↔semantic encoding loop** ships: graded auto session-end **episodes** (salience-weighted by effort+friction+outcome), deliberate **lessons** (the `report` `lessons` field), **retrieval reinforcement** (rank ↑ frequently-recalled, recency from last-use, prune the never-recalled), prune+dedupe maintenance, and tenant-scoped sharing; ANN still pending. See [`memory-encoding-and-consolidation.md`](./memory-encoding-and-consolidation.md) |
| 10 | Dreaming / Self-learning | 🟡 | A periodic Dreamer reflects on recent episodes + outcomes + friction, **compounds** them into persisted cumulative state (growing KB page + shared memory Insight), and closes the loop two ways: (a) distilled **guidance injected into every agent's prompt** at launch, and (b) **approval-gated config recommendations** a human Applies/Dismisses. Plus the **consolidation gardener** (a governed headless `consolidator` agent that abstracts recent episodes+lessons into shared memories + KB pages) — now the second half of one **"reflect"** pass (deterministic tally then gardener), surfaced in the top-level **Insights** page (`#/insights`) via a single **Reflect now** button. The whole system is framed by four verbs (Capture · Recall · Distil · Apply) in [`memory-model.md`](./memory-model.md); mechanism in [`memory-encoding-and-consolidation.md`](./memory-encoding-and-consolidation.md) |
| 11 | Company Settings | 🟡 | Company context (markdown) edited in console, appended to every claude-code agent's system prompt. Tenant branding not folded in yet |
| 12 | Skills of agents | ✅ | Global skills library (native `.claude/skills`) edited in console, synced into claude-code agents at launch, with per-agent audience assignment. **Imported** from a bundled catalog or any public GitHub repo / the skills.sh directory. **Agent-driven, human-gated:** agents `skill_find` (own library + catalog + skills.sh) and `skill_request` a catalog/remote skill — an owner/admin installs it (agents never self-install); approval delivers **same-session** to a live interactive run (materialise + `/reload-skills`) or next launch. **Procedural memory (Lever 6):** the fleet drafts its OWN skills — `skill_propose` (+ the consolidation gardener) stages a `.aos-proposed` draft that `materialize()` skips until a human **Publishes** it (a `skill.proposed` inbox card notifies owner/admins). See [`procedural-skills-plan.md`](./procedural-skills-plan.md) |
| 13 | Tools / Apps | 🟡 | **Apps hosting + authoring shipped** ([`apps-plan.md`](./apps-plan.md)): small server-side apps (mini-CRM / mini-tools) run as supervised child Node+SQLite processes reached at `/apps/<slug>` via the existing terminal reverse-proxy — `AppStore` (disk manifest + base-path scaffold), `AppSupervisor` (spawn + readiness + scale-to-zero idle-reap + resident restart + per-launch `AOS_APP_TOKEN`), and a login-gated proxy that strips the mount prefix + injects trusted `X-Aos-Member`. **Authored by humans** (console **Apps** page — create · manifest + capability editor · source editor · publish/unpublish · open · stop · delete, owner/admin) **and agents** (`app_create`/`app_list`/`app_update`, single-file for v1, lands proposed → an owner publishes; editing a live app unpublishes it for re-review). Capabilities default-deny; a proposed app is inert until published; **no seed apps**. A dedicated **`app-builder`** library agent teaches the whole workflow. **Background dispatch** (`POST /api/app/dispatch`, per-app-secret gated): an app triggers an agent it declares in `capabilities.dispatchAgents` (default-deny) → a governed `TaskStore` task (`createdBy=app:<slug>`, run-as = the current UI member), auto-dispatched, optional synchronous `wait`; `GET /api/app/dispatches` polls results. **Multi-file apps** (an app is a normal Node project dir — the entry `require()`s siblings): sandboxed store file-ops + agent tools `app_files`/`app_write_file`/`app_delete_file` + a console **file-tree editor** and a **sandboxed pre-publish preview iframe** (owner/admin reach an unpublished app via the proxy). **Secrets** (default-deny `capabilities.secrets`): a value a human sets (Settings tab, sealed under `app:<slug>`) is injected as `process.env.KEY` at launch + re-readable via `POST /api/app/secret/get`; the value never leaves the vault into audit/GET. **Custom domains**: a published app binds hostnames (`my.tool.com`) — a request whose `Host` matches serves it at the domain **root**, a **separate origin** from the console, **public** (no login); `TenantRegistry.appForHost` resolves Host→app (cached, published-only), reserved-host + uniqueness guarded — this is also the separate-origin isolation for that path (DNS/TLS external). Follow-ups: Linux uid-isolation (`launcher.ts` `start_app`), `app_history`/`app_revert`, same-origin `/apps/<slug>` hardening |
| 14 | Library (Artifacts / Deliverables) | ✅ | Agents `publish` finished files (PDF/Markdown/image) to a governed gallery — surfaced as the **Library**; snapshotted, provenance-scoped, previewed in-console |
| 15 | Knowledge Base | ✅ | Shared, tenant-wide living wiki: `KbStore` (markdown-on-disk + SQLite/FTS), revision chain + revert, `kb_search`/`kb_read`/`kb_write` MCP tools, and a console **Knowledge** page (browse/view/edit/history/revert). Agents + humans co-author; every edit versioned + auditable. No deep hierarchy / diff view yet |
| 16 | Tasks / Work Queue | ✅ | Shared tenant-wide backlog humans + agents co-own: durable units of work (`todo→doing→blocked→done`, assignee, activity log) that **auto-dispatch a governed agent session** to work them, plus the agent MCP set (`task_create`/`task_list`/`task_get`/`task_claim`/`task_update`) + a console Kanban board. Task edits auto-apply + audit (KB-style); the dispatched run stays fully gated. The A2A delegation path (support→coding = a task assigned to `agent:<id>`). v1 cuts: pool auto-assignment, agent-triggered dispatch |
| 17 | Media (generate · edit · understand) | ✅ | Gives agents the senses Claude lacks natively, all through the gateway: **`image_generate`** (text→image), **`image_edit`** (prompt edit · upscale · `remove-background` preset), **`video_generate`** (text→video **and** image→video, async job model), and **`video_understand`** (video→text — an agent "watches" a clip). Backed by **Atlas Cloud** (one key, 400+ models; OpenRouter is the image fallback); outputs land in the **Library** (Pillar 14), cost-metered + audited. Model pickers show the live Atlas catalog + pricing; timeouts + bounded retry on every vendor call. See [`media-integrations-plan.md`](./media-integrations-plan.md) |

---

## 1. Agents & Sessions — ✅ Working

**Today.** Agents are folders with an `agent.json` manifest (`src/types.ts` → `AgentManifest`), loaded
from bundled examples (`config/agents/`) and the user's data home (`<home>/agents/`, user wins on id
collision). Two runtimes: `mock` (scripted demo) and `claude-code` (real Claude opened in the agent's
folder, governed by the PreToolUse gate hook — `terminal/claude-launch.sh` + `terminal/gate-hook.sh`).
Sessions are tmux shells (`src/terminal.ts`), attachable in the browser via ttyd, persisted in the
`term_sessions` table with who spawned them. Spawning is permission-checked (`TeamStore.canRun`), and
the same gate covers their lifecycle: **Stop** (`POST /api/sessions/:id/stop`) kills a runaway shell
and flips the row to `idle`; **Delete** (`DELETE /api/sessions/:id`) kills the shell and cascades the
row + its messages, questions and per-session on-disk files (`session-<id>.*`), keeping the audit JSONL.

A claude-code agent's **`CLAUDE.md`** (its system prompt) is editable from the console — the file-text
icon on each agent in the sidebar opens an editor (`GET/PUT /api/agents/:id/claude`, owner/admin) that
reads/writes the agent-folder file directly.

**Per-agent runtime tuning.** Each claude-code agent carries an optional **model / effort / permission-mode**
(`RuntimeTuning` in `src/types.ts`), edited on its page (`GET/PUT /api/agents/:id/config`, owner/admin) and
persisted to `agent.json`. A **workspace default** for all three lives in Settings → Runtime defaults
(`GET/PUT /api/settings/runtime-defaults`, `SettingsStore.runtimeDefaults`). At launch `TerminalManager`
resolves agent-value → workspace-default → CLI-default (`resolveRuntimeTuning`) and exports
`CLAUDE_MODEL`/`CLAUDE_EFFORT`/`CLAUDE_PERMISSION_MODE`; `claude-launch.sh` turns them into
`--model`/`--effort`/`--permission-mode`. Model+effort apply to both lanes; permission-mode only to the
interactive lane (headless keeps `--dangerously-skip-permissions`). Permission-mode is the agent's *own*
posture — the PreToolUse gate hook still gates risky effects underneath it, even under `bypassPermissions`.
The runtime registry stays a two-value union (`mock | claude-code`); a foreign-CLI runtime (Codex etc.) is
deliberately **parked** — its governance has no PreToolUse-hook equivalent (see Gaps).

Agents have full **console CRUD** (owner/admin): **create** (`POST /api/agents` writes a `claude-code`
folder — `agent.json` + `CLAUDE.md` — under the data home and registers it live), **edit** the
`CLAUDE.md`, and **delete** (`DELETE /api/agents/:id` deregisters + removes the folder + clears the
assignment, refusing while a session runs). Only agents under the data home are deletable — the bundled
examples are read-only (`deletable` flag on each agent).

**Gaps.** Session cleanup is manual only (no retention sweep / auto-archive of old idle sessions); no
per-agent run history view tying sessions to audit. **Swappable foreign CLIs (Codex/Gemini/etc.) are not
implemented** — the runtime seam (manifest `runtime`, env→flag launcher) is general enough to add one, but
the gateway invariant ("every side effect through the gateway") relies on Claude Code's PreToolUse hook,
which foreign CLIs lack; bringing one in needs an MCP-fronted-only or sandbox-based enforcement model first.

## 2. Inbox — ✅ Working

**Model.** The Inbox is where the agent fleet reaches the human, split two ways: **Action required**
(an agent is blocked on you) pinned above an **Activity** feed (what the fleet is doing). It's the live
projection of every session's lifecycle (spawned → working → [needs approval / needs input] → done) plus
governance events.

**Today.** Unified feed (`messages` table) with card types:
- **approval** — risky action gated; live status via JOIN on `approvals`; role-gated Approve/Reject. *(action)*
- **question** — the ask-human channel: an agent calls the `ask` MCP tool, which posts a question and
  **blocks (polling) until a human replies in the inbox**; status/answer derive live via JOIN on the
  `questions` table. *(action)*
- **completed** — emitted when a session ends: the agent's `report` tool gives outcome (success/failure/
  partial) + a one-line summary; otherwise the launcher's end-signal posts a generic "ended" card. The
  `markEnded`/`report` pair dedupes so there's exactly one completion per session.
- **task (started)** — now carries **provenance** (`source`): manual vs `automation:<id>`.
- **update** — agent progress notes.

The OS-owned MCP server (`agentos`) carries 57 always-on tools + 11 conditional (chat-reply / egress /
media, each exposed only when its env flag is set), spanning memory, KB, tasks, goals, the operator/inbox,
skills, secrets, scheduling, agent self-editing, and app-building — materialised into every claude-code
session. Canonical, per-tool matrix (routes + stores + governance notes): `docs/agent-mcp-tools.md`. Read/unread **and** dismiss are **per-member, server-backed**
(a `message_state(message_id, member_id, read_at, dismissed_at)` join keyed to the viewer) — one admin
dismissing no longer hides a row for everyone, and unread syncs across a member's devices. Plus an
action-required count badge.

**Chat notifications.** When an approval card lands, the OS DMs everyone who can approve it
(`canApprove(role, level)`) on their linked **Slack/Discord** account (identity map → `dmUser`), so an
approver is pinged out-of-band. Agent **questions** get the same treatment (`notifyQuestionAsked` → the
run-as human, else owner/admins; audited `question.notified`), so a blocking `ask` isn't missed. And a
**chat-triggered** run mirrors its completion / question / approval back into the Slack/Discord thread it
came from (`chatMirror` over the `slack_threads`/`discord_threads` bindings), so the person who @mentioned
the agent sees the outcome where they asked. Best-effort + audited; the Inbox card stays the source of truth.

**Always approve (policy learning).** An approval card carries an owner-only **Always** action: it approves
the attempt AND writes a persistent `allow` rule for that capability into policy (`withAlwaysAllow`), so the
capability stops prompting. The rule is inserted **after** all `never` rules, so deny guardrails (destructive
/ over-cap / bulk-delete) still fire — the inbox becomes the policy-authoring surface. See §5 and
`docs/inbox-plan.md`.

**Gaps.** No filtering by agent/type; no server-side `ask` timeout/expiry (a late answer reaches a run that
already gave up) and no reminder/escalation on stale approvals/questions; still polling, not push (see
`docs/inbox-plan.md` for the batch roadmap).

## 3. Connectors — ✅ Working

**Today.** `src/connectors/connectors.ts`: a catalog of ready MCP servers over two transports —
**stdio** (local `npx` servers: Slack, GitHub, GDrive, custom escape hatch) and **remote http/sse**
(a URL + auth headers; a custom-remote escape hatch). **Composio** is a remote connector with a twist:
its Tool Router endpoint is a per-user, pre-signed session URL, so the user supplies only their API
key and `src/connectors/composio.ts` mints a fresh session URL at each launch — scoped to the
spawning member's email (`TerminalManager.composioUserId`), falling back to a stable per-agent id for
automations. That one connector fronts 850+ apps with OAuth handled on Composio's side. Stored in the
`connectors` table including their secrets (env for stdio, headers for remote); enabled connectors are
materialised into a per-session `.mcp.json` handed to claude via `--mcp-config` (dynamic ones layered
on at launch so the API key never lands in the file). Connector tool calls genuinely pass the gate:
the PreToolUse matcher covers `mcp__*`, and `gate-hook.sh` classifies each call as `connector.call` —
mutation verbs (create/send/update/delete/…) route to approval, reads auto-allow; the OS-owned
`mcp__agentos__*` tools pass straight through. Add/enable/disable/remove from the console (owner/admin only).

**Ownership scopes.** A connector is `org` (company-wide, fanned into every session — one shared
identity) or `personal` (owned by one member, `ownerMemberId`, injected only into that member's
sessions). A personal connector can also be **shared** (`connectors.shared`): the owner shares it
team-wide, so it's injected into everyone's sessions **acting as the owner** (the stored creds are
theirs) — `boundTo` resolves org → all, personal+shared → all, private personal → owner only.
Toggled from the console (**Share with team**); `removeByOwner` still purges a departing member's
personal connectors, shared or not.

**Gaps.** Connector creds are plaintext in the workspace DB by default — though a value can now be written
as a `secret:KEY` reference resolved from the encrypted Secrets vault at launch (Pillar 8), a one-click
"move into vault" action is still TODO — and for
Composio the OAuth grants additionally live in Composio's cloud; the per-app OAuth connect step still
happens on composio.dev (we don't yet initiate it from our own UI); no health check ("is this token
still valid?"); no per-agent connector scoping (all enabled connectors go to every session);
write/read classification is by tool-name verb, so an oddly-named mutating tool could read as a
read — tighten per-connector if that bites.

## 4. Team — ✅ Working

**Today.** `src/governance/team.ts` over the workspace DB: members with roles **owner / admin /
member**, invite-token magic-link login (7-day links, 30-day cookie sessions), owner seeded on first
boot, CLI recovery path (`agent-os invite|login-link|members`). Agent assignment per role/member;
members only see and run assigned agents. Approval authority: `head`→admin+, `owner`→owner only
(`canApprove` in `src/types.ts`). Team page in the console for all of it.

**Identity map.** Members carry external-account links — `member_identities` (provider ∈
`slack|discord|email|github`), edited on the Team page (**Chat IDs**). `memberByExternalId(provider, id)`
is the join key chat triggers (Pillar 7) use to run a session AS the right person — one handle per
provider, PK `(provider, external_id)` so it's unambiguous, cascades on member removal. This is what
makes Slack/Discord ingress *per-member* rather than always-company.

**Gaps.** No email delivery of invites (copy/paste links); single workspace per instance (no org →
multiple workspaces); no SSO/password option. The identity map has no per-provider OAuth verify (an
admin asserts the handle — trusted input).

## 5. Policy — ✅ Working

**Today.** `src/governance/policy.ts`: declarative JSON ruleset (`config/policy/default.policy.json`,
user override at `<home>/policy/`), glob capability matching + arg conditions (`when: amountUsd > 1000`),
risk classes green/yellow/red/deny, approval routing yellow→head red→owner. Enforced at both the
gateway (`src/gateway/gateway.ts`) and the terminal gate (`src/terminal.ts`). A console **Policy editor**
(Settings → Policy) edits defaults, routing, and rules (capability glob + optional condition + risk,
reorderable). `GET /api/policy` (owner/admin); `PUT /api/policy` (**owner only** — policy governs who
must approve, so admins can't downgrade a red rule). On save the engine is **hot-reloaded in place**
(the gateway + terminal gate share the instance, so it applies to running sessions immediately) and
written to the home override file, surviving restart. `validatePolicyDocument` rejects malformed docs.
Policy can also be **learned from the Inbox**: an approval card's owner-only **Always** action calls
`withAlwaysAllow`, which appends an `allow` rule for the capability (inserted *after* every `never` rule so
deny guardrails survive) and hot-reloads — `POST /api/approvals/:id/always`, audited `policy.rule.added`.

**Gaps.** One ruleset per workspace (no per-agent policy contexts despite `policyContext` existing on
manifests); no policy versioning/history; no dry-run "what would this classify as" simulator.

## 6. Audit Logs — ✅ Working

**Today.** Every gateway step and terminal gate decision emits an `AuditEvent`
(`src/governance/audit.ts`), composed as a `TeeAuditSink` (`src/kernel.ts`): append-only JSONL per run
(`<home>/audit/<tenant>/<runId>.jsonl`, the system of record) + SQLite `audit_events` mirror for
queries + in-memory for the demo console. Console mutations now emit through the same pipeline too
(`agent.created/deleted`, `skill.*`, `policy.updated`, `file.edited`, `memory.stored`, `session.ended`),
so the trail covers operator actions, not just agent effects. Approvals record who resolved (member email).

**Console viewer.** An **Audit** page (Manage nav, owner/admin) queries the `audit_events` mirror via
`GET /api/audit` — filter by session / type-prefix / principal, newest-first, capped, with a distinct-types
dropdown. So the trail is now browsable in-app, not just on disk.

**Gaps.** No retention policy / archival; no CSV export or time-range filter yet; JSONL and SQLite can
drift if one write fails (no transactional tee).

## 7. Automations — ✅ cron + webhook + chat ingress

Naming: an **Automation** = a trigger + an agent + a task template (the user-facing object); a
**Trigger** is its firing condition (`TriggerRef` in `types.ts`); the **Orchestrator**
(`src/core/orchestrator.ts`) stays the internal run engine.

**Today.** `src/edge/automations.ts` + the `automations` table: **cron** automations (zero-dependency
5-field parser, ~20s scheduler tick, at-most-once per matching minute) and **webhook** automations
(`POST /hooks/<id>?key=<secret>`, public, payload appended to the task). Firing spawns a normal
terminal session — Inbox card, gate hook, approvals, audit (`automation.fired`) all apply, unattended.
A pile-up guard skips firing while the previous spawn's tmux session is still alive (sessions now get
lazy liveness checks — dead ones flip to `idle`). Console page: list/create/enable/disable/run-now,
webhook URL copy; owner/admin mutate, run-now follows `canRun`.

**Chat ingress (native, no public URL).** Two more trigger types spawn sessions from chat, each over an
OUTBOUND WebSocket so a Tailscale-private box works with zero ingress: **`slack`** (Socket Mode,
`src/edge/slack-socket.ts`) and **`discord`** (the Gateway, `src/edge/discord-socket.ts`, a one-for-one
mirror). On @mention/DM the matching automations fire **as the member who sent the message** — resolved
through the **identity map** (`member_identities`, Pillar 4): Slack by `slack` handle then profile email,
Discord by `discord` handle (no email on Discord). Unmapped → company identity. The bot acks in-thread;
the agent replies via the `slack_reply` / `discord_reply` MCP tools bound to its `*_threads` row. Tokens
live in Settings → Integrations (one Slack app: `xapp-`+`xoxb-`; one Discord bot token — with an
**auto-detected invite button**: a bot's user id is its application id, so once connected the console renders
a ready invite URL). Composio remains the webhook ingress lane.

**Generic `/agent` chat router.** A message that matches **no** automation falls through to the router
(`Automations.routeChat`/`spawnChatAgent`, workspace toggle `chatRouterEnabled`, default on): the sender
addresses any claude-code agent by name (`/pod-troubleshooter why is pod X down?`) and it spawns a one-off
governed run — provenance `chat:<agent>` (labeled "Chat · <agent> · as <member>" in the console), run-as the
sender, reply bound to the thread, every effect still gated. An unaddressed/unknown name posts a help list of
available agents. A leading bot-mention is stripped first so the `/agent` prefix parses. So connecting the bot
once makes the **whole fleet reachable without a per-agent automation** — automations become optional
per-channel/mention overrides. **Threading:** Slack replies thread on `thread_ts ?? ts` (a mention starts a
thread); for a Discord **guild** @mention the socket branches a real thread off the message (`startThread`) and
keeps the ack + all replies inside it (DMs reply-reference in the DM; thread-create failure → channel fallback).

**Execution mode** (per automation, chosen at creation): **headless** (default, recommended) runs
`claude -p --dangerously-skip-permissions` in the agent folder — works the task to completion and
exits, so the pane dies → session flips to `idle` → the pile-up guard releases and the next cron
firing isn't skipped. The SAME PreToolUse gate hook still runs and still blocks risky Bash for inbox
approval even under that flag (Bash stays governed; the flag only removes the prompts claude can't
answer non-interactively). **Interactive** keeps the attachable TUI that stays open until closed —
good for babysitting, but a cron trigger won't re-fire while its last run is still alive (flagged in
the UI). Mode is `terminal.createSession(..., headless)` → `HEADLESS=1` to `claude-launch.sh`, which
branches to the `-p` lane and tees a transcript to `<home>/connectors/session-<id>.log`.

**Gaps.** Email inbound (Mailgun) still out; agent-spawns-agent;
retry/backoff policies; catch-up for schedules missed while the server was down; firing history view
(today: `lastFiredAt` + the audit stream); a long headless run blocked on an approval holds the guard
until resolved or the hook times out.

## 8. Secrets — 🟡 Partial

**Today.** A real **encrypted-at-rest vault**. `src/edge/secrets.ts`: `SqliteSecretsVault` stores
credentials in the `secrets` table sealed with **AES-256-GCM** (per-value random IV + auth tag) under a
workspace master key resolved by `src/edge/secret-crypto.ts` — `$AGENT_OS_SECRET_KEY` (32 bytes hex/base64,
prod-injectable) else an auto-generated `0600` `<home>/secret.key` (zero-config local). `get(tenant,
principal, key)` widens principal-specific → tenant-wide (`*`) → the `EnvSecretsVault` fallback (so the old
`<TENANT>__<PRINCIPAL>__<KEY>` env vars still resolve); a stored value wins over env, and a blob that won't
decrypt (wrong/rotated key, tamper) **fails closed** rather than falling through. Capabilities read secrets
inside the gateway; agents never see raw keys. Owner/admin CRUD at `/api/secrets` (GET lists metadata only —
never values; POST sets, DELETE removes; `secret.set`/`secret.deleted` audited) and a **Settings → Secrets**
console panel (set/replace/delete; values are write-only, never shown back).

**Connectors behind the vault.** A connector `env`/`header` value written as `secret:KEY` (or
`secret:PRINCIPAL/KEY`) is a *reference*, not a literal. `TerminalManager.buildMcpConfigJson` resolves it via
`secrets.getSync` at session launch (`resolveVaultRefs`) — the DB holds only the reference, and the plaintext
lives solely in the connector subprocess's env for the session's life. Principal defaults to the acting member
(widening to `*`); an unresolved reference is blanked + audited (`connector.secret.unresolved`), never leaking
the `secret:…` marker. So agents still get *tools*, never raw keys — the cred is decrypted inside the boundary.

**Secrets into an agent's shell.** Distinct from connector refs (which reach a subprocess), a claude-code
agent's *own* shell can get vault values as env vars at launch — so a plain CLI (`gh`, `psql`) authenticates —
via two injection paths, both audited `shell.secret.injected`/`unresolved` and **injection only** (never a
`secret_get` read grant): (1) the agent's manifest **`shellSecrets`** list (`injectShellSecrets`, self-declared
per agent); and (2) **agent assignment** (`injectAssignedSecrets` over the `secret_assignments` table) — the
inverse view, where an owner/admin assigns a stored secret to agents from **Settings → Secrets** (`PUT
/api/secrets/agents`) instead of editing each manifest. An assignment names the secret by its `(owner-principal,
key)`, so one canonical value fans out to many agents without a per-agent copy.

**Gaps.** Master-key **rotation + re-encryption** (rotating today invalidates sealed values). A one-click
"migrate this connector's raw creds into the vault" console action (today the admin sets the secret + edits
the connector value to `secret:KEY` by hand). Rotating/short-lived creds minted per run (ties into the
Identity stub). External KMS option.

## 9. Memory layer — 🟡 Partial

**Plan: [`memory-layer-plan.md`](./memory-layer-plan.md).** Phase 1 shipped.

**Today.** A pluggable `MemoryProvider` (`src/types.ts`) backs persistent, per-agent memory, namespaced
by `(tenant, agentId)`. Three drivers (`src/memory/`): `SqliteMemoryProvider` — zero-infra default, a
`memories` table in the workspace DB with FTS5 `bm25()` keyword recall, **plus optional hybrid semantic
recall** (an `embedding` BLOB + in-JS cosine, fused with bm25 by reciprocal rank — still zero-dependency);
`LibsqlMemoryProvider` — a local libSQL file with **native in-engine vector search** (`F32_BLOB` /
`vector_distance_cos`), or a remote/Turso-Cloud URL for multi-box; and `AutomemMemoryProvider` — REST
client to an automem deployment (FalkorDB + Qdrant), one shared collection isolated by an `agent:<id>`
tag. Embeddings (sqlite/libsql) come from a pluggable `Embedder` — an OpenAI-compatible API **or a local
Ollama** (free, on-box). The backend is chosen in **Settings → Memory** and **hot-swapped live** (no
restart) — persisted in the DB, overriding the config-file default, with a Test (health-check) and live
Ollama status. Memory is delivered **purely as an MCP server** (`src/memory/memory-mcp.ts`): every
claude-code session gets it materialised into its `.mcp.json`, exposing `recall`/`remember` (pre-allowed
in the launcher, `recall` returning ranked results **with relevance scores**) scoped server-side to the
session's agent via the public `/api/memory/{recall,remember}` routes. The orchestrator injects nothing
into the prompt — when/whether to recall or remember is the agent's own decision, guided by the tools'
descriptions and the agent's `CLAUDE.md`. A console **Memory page** (web) browses, searches (same hybrid
`recall`, with a per-result **relevance badge**), **edits and deletes** per agent (member-auth
`GET/POST /api/memory`, `PATCH/DELETE /api/memory/:id`, scoped to the agent), with a backend-health badge.
The four bundled claude-code agents carry recall/remember guidance in their `CLAUDE.md`, editable from the
console (see Pillar 1). **Automatic session-end episodes** also land now: when a claude-code session ends
(`TerminalManager.markEnded` ← the launcher's `/api/ended`), the OS distils it into one `Insight` memory
for that agent — the agent's own `report` summary when it left one, else a heuristic from the session's
audit stream — skipping sessions that did nothing, idempotent per session. So agents accrue memory of
*what they did* without being asked.

**Upkeep.** Recall ranking can nudge by **recency + importance** (config-gated; a re-rank over relevance,
never a hard filter), and the `remember` tool guides agents to set `importance`. **Maintenance** then keeps
the store healthy: every query bumps a memory's `recall_count`/`last_recalled_at`, and a prune+consolidate
pass (Settings → Memory, scheduled or **Run now**) deletes stale memories (old AND never recalled AND not
important) and merges duplicates — exact-content always, plus **near-duplicates by cosine** on the
sqlite/libsql backends with embeddings. Conservative and opt-in; every change is audited (`memory.maintained`).

**Shared knowledge.** Memory now has a **scope**: `agent` (private, default) or `tenant` (shared
workspace-wide). An agent recalls its own memories ∪ the tenant's shared ones; it shares a fact via
`remember(shared: true)` (audited, authorship-tracked), and the console Memory page filters by
*This agent / Shared / All* with a share-on-add checkbox + a "shared" badge. Phase 0 toward a KB
(`docs/shared-memory-phase0-plan.md`) — shared facts, not documents.

**Curation + governance.** Owners/admins can **edit or remove any** memory (incl. another agent's shared
one) from the console — the per-author guard relaxes for admins (`UpdateInput/DeleteInput.admin`, set
server-side from role). Shared writes default to **open** (any agent, audited) but a workspace can switch to
**curated** (`memory.sharedWrites`) — then an agent's `remember(shared)` is stored private and only humans
publish workspace-wide. Full approval-gating (a blocking approval card per shared write) isn't wired; the
curated setting is the lighter control.

**Gaps.** Near-duplicate consolidation runs on **sqlite** (in-JS cosine); **libSQL** does exact-content only
for now (its vectors live in-engine). Semantic recall is brute-force cosine — no ANN index yet (libSQL is the
path at scale). No full **KB plane** (documents, revisions, multi-writer editing, wiki UI) — shared-scope
memory is the cheaper bet until that demand is real. automem is **parked** (carries `scope` but doesn't share);
its ops doc is unwritten.

## 10. Dreaming / Self-learning — 🟡 Partial

**Plan: [`self-learning-plan.md`](./self-learning-plan.md).**

**Today.** `src/edge/dreaming.ts` is a periodic, deterministic, **compounding** pass. Each run reflects
on activity since the last pass — the per-session **episodes** agents wrote, run **outcomes**
(corroborated against the audit stream by `src/observability/evaluation.ts`), and **friction**
(approvals rejected, budget stops, errors) — and **folds it into a cumulative state** persisted in
`settings: dreaming_state`. From that state it re-renders a living KB page (`operations/fleet-learnings`)
and a tenant-shared memory **Insight**, so the page grows (cumulative totals, a deduped table of
recurring topics with counts + last-seen, a rolling log of recent passes) rather than snapshotting one
window. It then **closes the loop two ways**: (a) distilled **guidance is injected into every agent's
prompt** at launch (`buildCompanyMd`, toggleable), and (b) **approval-gated config recommendations**
(e.g. raise default effort) are proposed for a human to Apply/Dismiss — Apply makes a concrete,
reversible, audited settings change. Both are visible/toggleable in the **Insights** page;
driven by `GET/PUT /api/dreaming` + `POST /api/dreaming/run`. Deterministic and zero-cost — the
always-on baseline. `HealthMonitor` (`src/observability/monitor.ts`) tracks liveness separately.

**Gaps.** The deterministic pass only counts/dedupes/recommends from structured signals — it doesn't
write prose insight. The richer **LLM "kb-gardener"** (a scheduled agent that distils narrative
learnings via `kb_write`) is the planned follow-up. Policy/budget recommendations are advisory; no
auto-apply.

## 11. Company Settings — 🟡 Partial

**Today.** A `settings` table (`SettingsStore`, `src/governance/settings.ts`) holds the workspace
**Company context** — one markdown document edited from the console **Settings** page (owner/admin
only, `GET /api/settings` + `PUT /api/settings/company`). At spawn, `TerminalManager` materialises it
to a per-session file and the launcher appends it to claude's system prompt via
`--append-system-prompt-file` — so every claude-code agent inherits it without per-agent duplication.
This is also the right home for cross-agent memory-usage guidance (recall/remember conventions).

**Gaps.** Tenant name/branding still live in `config/agent-os.config.json` (the *seed* tenant) — fold
them in here. No markdown preview in the editor. Mock-runtime agents don't receive it (they're scripted).

> **Multi-tenant (2026-06-25):** one process now serves many tenants via `src/tenant-registry.ts` —
> each a fully isolated runtime (own DB/tmux/ttyd/cron/Slack), routed by subdomain, listed in the
> control plane (`src/state/control.ts`), provisioned superadmin-only (`agent-os tenant create` /
> `POST /api/admin/tenants`). The DB file remains the tenant boundary. See `docs/scoping-model.md`.

## 12. Skills of agents — ✅ Working

**The idea.** Reusable, named playbooks an agent can reach for ("write release notes", "knows our
refund SOP") — shareable across agents rather than buried in each CLAUDE.md.

**Today.** A workspace-global skills library lives in the data home (`<home>/skills/<name>/SKILL.md`
+ supporting files) in Claude Code's native `.claude/skills` format (`src/governance/skills.ts`,
`SkillsStore`). A console **Skills page** (Manage nav, owner/admin) lists/creates/edits/deletes/duplicates
library skills — each SKILL.md edited as text, with its `description` driving auto-invocation. At session
launch `TerminalManager.materializeSkills` syncs the library into the claude-code agent's project
`.claude/skills/` (discovery is filesystem-native — no per-invocation flag), so the agent auto-selects by
description (or you call `/name`). **Per-agent audience:** a `skill_assignments` table scopes a skill to
specific agents (an "Assign" control per skill; empty = every agent) — so a skill need not be global.
Managed skills carry an `.aos-managed` marker so a re-sync never clobbers a **per-agent** skill
hand-placed in the agent's own folder, and a same-named agent skill **shadows** the global one. The
gateway invariant holds: a skill's `allowed-tools` only suppresses claude's own permission prompts; the
PreToolUse gate hook still gates risky Bash.

**Import (marketplace).** The library is filled from three sources, all owner/admin, all landing as plain
files re-governed like any other skill: a **bundled catalog** that ships with the software
(`config/skills` → `install`); **any public GitHub repo** (the Git trees API + `raw`, zero-dep —
`src/governance/skill-registry.ts`), which also covers the **skills.sh** directory (`npx skills add
owner/repo`); and a **`.zip` upload/drag-drop**. Featured one-click preset repos are shown in the console.

**Agent-driven, human-gated (the request flow).** Agents don't just receive skills — they can **ask** for
them and never install one themselves. Two always-on MCP tools: `skill_find` discovers what's installable
(the agent's own library with an `active` flag, the bundled catalog, and — with a `query` — matching
community skills from skills.sh); `skill_request` raises an owner/admin **`skill.request`** inbox card for
a named catalog skill or a remote `owner/repo` (resolved against the repo at request time so a typo fails
fast). The human **Installs** it from the Skills page's "Requested by agents" section (all agents, or
scoped to just the requester) or **Dismisses** it; audited `skill.requested` → `skill.installed`
(`source: agent-request`); on approval it delivers **same-session** (below).

**Same-session delivery** (shared by both human-gating paths — approve above, publish below). A newly
installed/published skill normally reaches agents on their next launch, but if the agent has a LIVE
session it lands *in that run*: `TerminalManager.refreshAgentSkills` materialises the skill into the
agent's watched `.claude/skills` and injects **`/reload-skills`** (claude ≥ 2.1.152). It targets any
INTERACTIVE session (`headless = 0` — a console TUI *or* a resident chat session; the earlier `resident`
filter was a bug that skipped console runs) and reports `reloaded`. A headless `claude -p` run has no REPL
and has exited anyway, so it gets the skill next launch. Enabling detail: `materialize` now always creates
`.claude/skills` at launch — even for a zero-skill agent — because Claude Code only watches a directory
that existed at startup.

**Procedural memory (Lever 6 of the learning loop).** The fleet turns its own repeated successes into
skills: any agent post-task (and the consolidation gardener across a batch) `skill_propose`s a `SKILL.md`
from a recurring, reusable procedure. A proposal is staged as a `.aos-proposed` draft that `materialize()`
**skips** — invisible to agents until a human reviews and **Publishes** it from the Skills page (a
`skill.proposed` card notifies owner/admins), reusing the Dreaming recommendations' approval pattern.
Publishing gets the **same same-session delivery** as an approved request (above) — the just-published
skill lands in the proposing agent's live session immediately, not just on its next launch.
Spec: [`procedural-skills-plan.md`](./procedural-skills-plan.md).

**Gaps.** Mock-runtime agents don't receive skills (they're scripted); the console's Files page can't yet
create skill folders and supporting-file editing there is view-only (edit SKILL.md text in the Skills
page, richer assets via Files); same-session delivery reaches only live *interactive* sessions (headless
= next launch). Remote import is rate-limited by the unauthenticated GitHub API unless `GITHUB_TOKEN` is
set.
This is the natural extension of Pillar 10 (Distil now emits facts → memories/KB; Lever 6 adds procedures → skills).

## 13. Tools / Apps — ⬜ Not started

**The idea.** Tools *built by agents* (or users) for specific/general use — the
`/home/agent-os/tools/`-style standalone apps, but registered, governed, and surfaced in the console.

**Closest today.** The hand-written capability registry (`src/capabilities/registry.ts` + examples) —
governed native effects, but authored in TypeScript by the platform, not by agents. A path: an agent
builds a tool in its folder → registers a manifest (command/port/UI) → appears as a card in the console
→ its side effects route through the gateway like everything else.

---

## 14. Library (Artifacts / Deliverables) — ✅ Working

> **Naming.** User-facing this pillar is the **Library** (the console nav label + page title). The code,
> DB table, routes, MCP payloads, and inbox card type stay `artifact*` (`ArtifactStore`, the `artifacts`
> table, `/api/artifacts`, `kind`, the `artifact` inbox card) — "Library" is the surface name, "artifact"
> the internal noun for one published deliverable.

**The idea.** A curated gallery of the *deliverables* agents produce — distinct from the raw **Files**
browser (which exposes the whole data home, owner/admin-only, full of scratch). An agent **explicitly
publishes** a finished file via the OS-owned `publish` MCP tool (`mcp__agentos__publish`), so nothing
junky leaks in.

**How it works.** `publish` is the twin of `report`: the agentos MCP server (`src/memory/memory-mcp.ts`)
→ session-secret `POST /api/publish` → `TerminalManager.publishArtifact()` → `ArtifactStore`
(`src/state/artifacts.ts`). The file is **snapshotted** (copied) into `<home>/artifacts/<id>/<filename>`
— immutable even as the agent keeps editing its working copy; the source path is resolved strictly under
the agent's own folder (no `/etc/passwd`). Publishing posts an **inbox** `artifact` card and writes an
`artifact.published` audit event. The `artifacts` table carries full provenance (session + agent +
source), the same shape as `messages`, so the inbox's `canViewSpawn` rule scopes the gallery for free:
members see only their own sessions' artifacts; owner/admin see all. The console **Library** page
(`web/src/App.tsx`) renders Markdown (react-markdown), PDFs (iframe), images (thumbnails), and video
(inline player), streamed by `GET /api/artifacts/:id/raw`.

**Generated media lands here too.** Image/video from **Pillar 17** (`image_generate`/`image_edit`/
`video_generate`) doesn't go through `publish` — it's `ingest`ed **server-side from bytes** into the same
`artifacts` table (`kind:'image'`/`'video'`, folders `generated-images`/`edited-images`/`generated-videos`,
carrying `cost_usd`), so the gallery previews and cost-meters generated deliverables alongside published
files with identical provenance/visibility rules.

**Not yet.** Multi-file/interactive artifacts (a generated `kind:'site'`/`app` served into an iframe) —
the per-`<id>` dir, the `kind` column, and the `?file=` raw seam are in place for it, but `publish` only
takes a single file today. No versioning/dedupe (republish = new artifact). No per-session lens in the
Sessions page yet (the data supports it).

---

## 15. Knowledge Base — ✅ Working

**Plan: [`knowledge-base-plan.md`](./knowledge-base-plan.md).**

**The idea.** A shared, tenant-wide **living wiki** agents and humans co-author — distinct from Memory
(private, per-agent scratch). The company accumulates up-to-date knowledge that's rewritten in place
over time, without humans touching it unless something needs review.

**Today.** `src/state/kb.ts` (`KbStore`): each page is markdown stored both as the `kb_pages` body
column (feeding an FTS5 mirror + the API) and, when a data home exists, as a `kb/<section>/<slug>.md`
file on disk (human/git-friendly) — written together on the single mutating path so they never diverge.
Safety is by **reversibility, not approval**: every `write` snapshots a full revision into
`kb_revisions`, so any edit (agent or human) is auditable and one-click revertable; auto-apply + audit,
no gate. Agents reach it through the OS-owned MCP tools `kb_search` / `kb_read` / `kb_write`
(`src/memory/memory-mcp.ts`), materialised into every claude-code session. The console **Knowledge**
page browses/views/edits/history/reverts. The Dreaming engine (Pillar 10) is one of its authors —
it renders `operations/fleet-learnings` from cumulative state.

**Gaps.** No deep hierarchy (flat section/slug); no diff view between revisions (revert is whole-page);
no inbound-link/backlink graph; mock-runtime agents don't get the tools.

---

## 16. Tasks / Work Queue — ✅ Shipped (v1)

**Plan: [`tasks-plan.md`](./tasks-plan.md).** Built per the plan's build order: `tasks`/`task_events`/`tasks_fts`
tables + `TaskStore` (`src/state/tasks.ts`, `os.tasks`), the tick-driven dispatcher (`Automations.dispatchTask`
+ `buildTaskPrompt`, provenance `task:<id>`, run-as = `owner`, pile-up + attempt-ceiling guarded), the agent
loopback + member-console `/api/tasks/*` routes, the five `task_*` MCP tools, and the console **Tasks** Kanban
board. The v1 cuts below (pool auto-assignment, agent-triggered `task_dispatch`, policy brake) remain §9 futures.

**The idea.** The missing **noun between "a trigger fired" (Automation) and "a session ran" (Session)** —
a durable *unit of work* that outlives any single run. Today a task's state lives nowhere: implicit in a
cron, a memory, or a human's head. The Tasks plane makes the *goal* first-class: a shared, tenant-wide
**board** humans and agents co-own, where each task has a lifecycle (`todo → doing → blocked → done`), an
owner + assignee, a labelled priority, and an append-only activity log. It's an **active work queue**, not
a passive tracker — a task can **auto-dispatch a governed agent session** to work it, and the dispatched
agent closes its own loop (`task_update(done)`).

**Design (locked with the user, not yet built).** Active queue · one shared board (humans + agents) · full
agent MCP set. `TaskStore` (`src/state/tasks.ts`, db-only — no on-disk mirror, since tasks are structured
state not co-authored documents) over new `tasks` / `task_events` / `tasks_fts` tables, wired as `os.tasks`.
**Governance mirrors KB with a twist:** task edits are auto-apply + audit (the safety net is the activity
log, not an approval gate), but **dispatch reuses the existing run engine** — `TerminalManager.createSession`
with a free-form `spawnedBy = task:<id>` provenance and `run_as = task.owner`, guarded against pile-up by
`isAlive`. So the *effects* an agent has while working a task pass the normal PreToolUse gate + gateway;
the Tasks plane adds **no new trust surface**. Five OS-owned MCP tools (`task_create`/`task_list`/`task_get`/
`task_claim`/`task_update`, author/assignee server-derived from the session — never trusted from the agent)
let agents file, claim, drain, and close work; a console **Tasks** Kanban board lets humans triage. Two work
paths: assigned `auto_dispatch` tasks spawned by the scheduler tick, and a long-running worker session that
`claim`s open tasks off the pool (the atomic claim is the race resolver).

**Deliberate v1 cuts (see plan §9).** Pool auto-assignment of unassigned tasks to a default worker, and an
agent-triggered `task_dispatch` tool — both are the **agent-spawns-agent frontier** Automations also parks
(needs a concurrency budget + fairness story). Also future: an optional policy brake on dispatch,
`blocked_by` dependencies, and an Inbox card when a task goes `blocked`.

---

## 17. Media (generate · edit · understand) — ✅ Working

**Plan: [`media-integrations-plan.md`](./media-integrations-plan.md).**

**The idea.** Give agents the modalities Claude can't do natively — draw, film, and *watch* — as
first-class **governed** capabilities, not a side-channel. Every media call is an effect through the same
gateway as everything else: policy-classified with a dollar estimate (the money-cap `never` rule applies),
audited, run-as a real human, and its output stored in the **Library** (Pillar 14).

**The tools (all OS-owned MCP → session-secret loopback `/api/agent/*` → `TerminalManager`).**

- **`image_generate`** — text→image. Each image is `ingest`ed into the Library (`kind:'image'`, folder
  `generated-images`), audited `image.generated` with the **real** cost when the vendor reports it
  (OpenRouter `usage.cost`), else the estimate.
- **`image_edit`** — transform an existing image (source never mutated → a NEW Library image). Three modes,
  precedence `operation` → `scale` → `prompt`: a prompt-guided **edit** (image-to-image), **upscale**
  (`scale` 2/4), or the **`remove-background`** preset (→ a transparent PNG). Audited `image.edited`.
- **`video_generate`** — text→video **and** image→video. Video is **async**: submit → persist an opaque
  handle to `video_jobs` → a brief in-call poll catches the fast case, else the **Automations-tick poller**
  (`pollVideoJobs`) finishes it — downloads the mp4, `ingest`s it (`kind:'video'`, `generated-videos`),
  posts an inbox card, audits `video.generated`. Survives the poll cap and a restart. An optional `image`
  seed (Library id / working-folder file / URL) switches it to image-to-video.
- **`video_understand`** — video→text. Claude can't see video, so this delegates to an Atlas **multimodal
  LLM** (chat endpoint, a `video_url` content part) and returns the text answer directly (no artifact).
  Audited `video.understood`.

The `image`/`video` source for edit/understand/seed is any of a **Library artifact id**, a **working-folder
file** (a file the agent wrote *or* one uploaded into the terminal session, resolved strictly under the
agent folder), or an **http(s) URL** — local inputs are inlined as base64 so nothing needs public hosting.

**Backends.** A swappable `ImageBackend` / `VideoBackend` interface picked by whichever key is set
(`resolveImageBackend`/`resolveVideoBackend`). **Atlas Cloud** is primary — one key covers image + video +
understanding across 400+ models; **OpenRouter** is the image fallback, **fal.ai** the widest video catalog.
Settings → Integrations has one **Media generation** card: the Atlas key drives all of it, with the live
Atlas catalog + per-model pricing shown in the default-model pickers. A **bad/half-typed default model**
falls back to a built-in and warns, rather than silently breaking every run.

**Resilience.** Every vendor call goes through `src/edge/vendor-fetch.ts` — explicit `AbortSignal.timeout`
(30s submit, 15s poll, 60s download) + bounded retry (3×, backoff+jitter) on transient failures
(network/timeout, 429, 5xx). A 4xx / content-policy rejection / explicit vendor `failed` status is a real
answer, surfaced as-is; a transient poll blip keeps the job rendering (image: until the render deadline;
video: the next tick re-polls) instead of failing a paid render. Failures name the actual tool + vendor +
whether a retry is worthwhile. See [`agent-mcp-tools.md`](./agent-mcp-tools.md) → "Media tool resilience".

**Not yet.** Proprietary-suite features some vertical products layer on top of raw model calls — persistent
character consistency, virality scoring, viral-clip auto-cutting. Atlas also exposes categories we don't
surface yet (`TEXT-TO-SPEECH`, `IMAGE-TO-3D`, `VIDEO-TO-VIDEO`). Cost for token-priced calls
(`video_understand`) is a gate estimate unless the vendor returns usage.

---

## Suggested build order (dependency-aware)

1. ~~**Automations** (cron + webhook → terminal sessions)~~ — ✅ shipped; inbound chat listeners remain (see `docs/v1-mvp-scope.md`).
2. ~~**Company Settings** (one file + injection point)~~ — ✅ shipped.
3. ~~**Memory persistence + injection**~~ — ✅ shipped (Pillar 9); episodes auto-distilled off the audit stream.
4. ~~**Dreaming v1**~~ — ✅ shipped (Pillar 10, deterministic compounding pass + Inbox config recommendations).
5. ~~**Knowledge Base**~~ — ✅ shipped (Pillar 15).
6. ~~**Secrets vault** (encrypted in DB) + move connector creds behind it~~ — ✅ shipped (Pillar 8, AES-256-GCM + Settings → Secrets UI; connectors resolve `secret:` refs at launch). Still to do: master-key rotation + a one-click connector→vault migrate action.
7. **Chat channels + identity (v1)** — Slack (Socket Mode, ✅) + Discord + act-as-member + audit viewer; tracked in `docs/v1-mvp-scope.md`.
8. **Tools/Apps, per-agent grants** — bigger product surfaces; design after the above settle.
