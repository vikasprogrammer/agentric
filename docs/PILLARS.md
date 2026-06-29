# Agent OS — Product Pillars & Implementation Status

The platform decomposes into these pillars. Status is graded against the code as of 2026-06-13;
pillars 6–13 re-verified against source on 2026-06-21 (all grades + narratives still hold):

- ✅ **Working** — usable end-to-end today
- 🟡 **Partial** — core exists, meaningful gaps remain
- 🌱 **Seed** — interface/reference impl only, nothing real wired
- ⬜ **Not started** — named here so it has a home, no code yet

| # | Pillar | Status | One-liner |
|---|--------|--------|-----------|
| 1 | Agents & Sessions | ✅ | Manifest-driven agents, real Claude in tmux, persisted sessions |
| 2 | Inbox | ✅ | Tasks · updates · approval cards, SQLite-backed, role-aware |
| 3 | Connectors | ✅ | MCP catalog → per-session `.mcp.json`, every call still gated |
| 4 | Team | ✅ | Roles (owner/admin/member), magic-link login, agent assignment |
| 5 | Policy | ✅ | JSON rule engine + console editor (owner-edit, live hot-reload, persisted). Single ruleset per workspace; no dry-run simulator |
| 6 | Audit Logs | ✅/🟡 | JSONL system-of-record + SQLite mirror; no console viewer yet |
| 7 | Automations | ✅/🟡 | Cron + webhook triggers spawn governed sessions; no Slack/email inbound yet |
| 8 | Secrets | 🌱 | Env-lookup vault stub; connector creds sit in the workspace DB |
| 9 | Memory layer | 🟡 | Per-agent + **shared workspace-wide** `remember`/`recall` MCP server + console Memory page live; three backends — sqlite (keyword, or hybrid keyword+vector with embeddings), libsql (native vectors), automem — switchable live in Settings → Memory. Auto session-end episodes, recency/importance recall ranking, prune+dedupe maintenance, and tenant-scoped sharing land; ANN + a full KB (documents/revisions/wiki) still pending |
| 10 | Dreaming / Self-learning | 🟡 | A periodic Dreamer reflects on recent episodes + outcomes + friction, **compounds** them into persisted cumulative state (growing KB page + shared memory Insight), and closes the loop two ways: (a) distilled **guidance injected into every agent's prompt** at launch, and (b) **approval-gated config recommendations** (e.g. raise default effort) a human Applies/Dismisses — Apply makes a concrete, reversible, audited settings change. Both toggleable/visible in Settings → Self-learning. Deterministic; policy/budget recs are advisory. LLM gardener = richer follow-up |
| 11 | Company Settings | 🟡 | Company context (markdown) edited in console, appended to every claude-code agent's system prompt. Tenant branding not folded in yet |
| 12 | Skills of agents | 🟡 | Global skills library (native `.claude/skills`) edited in console, synced into every claude-code agent at launch. No per-agent grants UI yet |
| 13 | Tools / Apps | ⬜ | Agent-built tools don't exist (closest: hand-written capability registry) |
| 14 | Artifacts / Deliverables | ✅ | Agents `publish` finished files (PDF/Markdown/image) to a governed gallery; snapshotted, provenance-scoped, previewed in-console |
| 15 | Knowledge Base | ✅ | Shared, tenant-wide living wiki: `KbStore` (markdown-on-disk + SQLite/FTS), revision chain + revert, `kb_search`/`kb_read`/`kb_write` MCP tools, and a console **Knowledge** page (browse/view/edit/history/revert). Agents + humans co-author; every edit versioned + auditable. No deep hierarchy / diff view yet |

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

The OS-owned MCP server (`agentos`) carries `recall`/`remember`/`ask`/`report`, materialised into every
claude-code session. UI has read/unread (per-browser `lastSeen`) and an action-required count badge.

**Gaps.** Read/unread is client-side only (not per-member server state); no filtering by agent/type; no
notification push (Slack/email) when an action card lands — you still have to open the console. No
standalone surfacing of policy denials (folded into session outcome for now).

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

**Gaps.** Secrets are plaintext in the workspace DB (should move behind the Secrets vault) — and for
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

**Gaps.** No email delivery of invites (copy/paste links); single workspace per instance (no org →
multiple workspaces); no SSO/password option.

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

**Gaps.** One ruleset per workspace (no per-agent policy contexts despite `policyContext` existing on
manifests); no policy versioning/history; no dry-run "what would this classify as" simulator.

## 6. Audit Logs — ✅ pipeline / 🟡 surface

**Today.** Every gateway step and terminal gate decision emits an `AuditEvent`
(`src/governance/audit.ts`), composed as a `TeeAuditSink` (`src/kernel.ts`): append-only JSONL per run
(`<home>/audit/<tenant>/<runId>.jsonl`, the system of record) + SQLite `audit_events` mirror for
queries + in-memory for the demo console. Console mutations now emit through the same pipeline too
(`agent.created/deleted`, `skill.*`, `policy.updated`, `file.edited`, `memory.stored`, `session.ended`),
so the trail covers operator actions, not just agent effects. Approvals record who resolved (member email).

**Gaps.** No audit viewer in the web console for terminal sessions (only the legacy mock-run view);
no retention policy; JSONL and SQLite can drift if one write fails (no transactional tee).

## 7. Automations — ✅ cron + webhook / 🟡 inbound

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

**Execution mode** (per automation, chosen at creation): **headless** (default, recommended) runs
`claude -p --dangerously-skip-permissions` in the agent folder — works the task to completion and
exits, so the pane dies → session flips to `idle` → the pile-up guard releases and the next cron
firing isn't skipped. The SAME PreToolUse gate hook still runs and still blocks risky Bash for inbox
approval even under that flag (Bash stays governed; the flag only removes the prompts claude can't
answer non-interactively). **Interactive** keeps the attachable TUI that stays open until closed —
good for babysitting, but a cron trigger won't re-fire while its last run is still alive (flagged in
the UI). Mode is `terminal.createSession(..., headless)` → `HEADLESS=1` to `claude-launch.sh`, which
branches to the `-p` lane and tees a transcript to `<home>/connectors/session-<id>.log`.

**Gaps.** Connector-inbound listeners (Slack mention → run, email → run); agent-spawns-agent;
retry/backoff policies; catch-up for schedules missed while the server was down; firing history view
(today: `lastFiredAt` + the audit stream); a long headless run blocked on an approval holds the guard
until resolved or the hook times out.

## 8. Secrets — 🌱 Seed

**Today.** `src/edge/secrets.ts`: `EnvSecretsVault` resolves `<TENANT>__<PRINCIPAL>__<KEY>` → env vars.
Capabilities read secrets inside the gateway; agents never see raw keys. Connector creds bypass this
and live in the `connectors` table directly.

**Gaps.** A real vault (encrypted at rest in the workspace DB, or external KMS); secrets UI; rotating/
short-lived creds minted per run (ties into the Identity stub); migrate connector env creds behind it.

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

## 10. Dreaming / Self-learning — 🌱 Seed

**Today.** `src/observability/evaluation.ts` corroborates an agent's claimed outcome against the audit
stream (effects attempted/succeeded, rejections, budget stops, `suspicious` flag). Shown on the legacy
run view. `HealthMonitor` (`src/observability/monitor.ts`) tracks liveness separately.

**Gaps.** The loop itself: periodically read eval signals + episodes → propose CLAUDE.md/knowledge/
policy improvements → land them as *approval cards in the Inbox* (human-gated self-improvement, reusing
the existing approvals plane). Nothing consumes the eval signal today.

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

## 12. Skills of agents — 🟡 Partial

**The idea.** Reusable, named playbooks an agent can reach for ("write release notes", "knows our
refund SOP") — shareable across agents rather than buried in each CLAUDE.md.

**Today.** A workspace-global skills library lives in the data home (`<home>/skills/<name>/SKILL.md`
+ supporting files) in Claude Code's native `.claude/skills` format (`src/governance/skills.ts`,
`SkillsStore`). A console **Skills page** (Manage nav, owner/admin) lists/creates/edits/deletes
library skills — each SKILL.md edited as text, with its `description` driving auto-invocation. Like the
Company context, skills are **global**: at session launch `TerminalManager.materializeSkills` syncs the
whole library into the claude-code agent's project `.claude/skills/` (there's no per-invocation skills
flag — discovery is filesystem-native), so every agent gets them and the CLI auto-selects by
description (or you call `/name`). Managed skills carry an `.aos-managed` marker so a re-sync never
clobbers a **per-agent** skill hand-placed in the agent's own folder — and a same-named agent skill
**shadows** the global one. Per-agent skills are inspected via the **Files** page
(`agents/<id>/.claude/skills/`). The gateway invariant holds: a skill's `allowed-tools` only suppresses
claude's own permission prompts; the PreToolUse gate hook still gates risky Bash.

**Gaps.** No per-agent grants matrix (every global skill goes to every agent — per-agent customisation
is filesystem-only via Files, and Files can't yet create skill folders); no skill marketplace/import;
mock-runtime agents don't receive skills (they're scripted); supporting-file editing is view-only in
the console (edit SKILL.md text; richer assets via Files). A future step mirrors agent↔member
assignment: a `skill_grants` table for per-agent scoping.

## 13. Tools / Apps — ⬜ Not started

**The idea.** Tools *built by agents* (or users) for specific/general use — the
`/home/agent-os/tools/`-style standalone apps, but registered, governed, and surfaced in the console.

**Closest today.** The hand-written capability registry (`src/capabilities/registry.ts` + examples) —
governed native effects, but authored in TypeScript by the platform, not by agents. A path: an agent
builds a tool in its folder → registers a manifest (command/port/UI) → appears as a card in the console
→ its side effects route through the gateway like everything else.

---

## 14. Artifacts / Deliverables — ✅ Working

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
members see only their own sessions' artifacts; owner/admin see all. The console **Artifacts** page
(`web/src/App.tsx`) renders Markdown (react-markdown), PDFs (iframe), and images (thumbnails), streamed
by `GET /api/artifacts/:id/raw`.

**Not yet.** Multi-file/interactive artifacts (a generated `kind:'site'`/`app` served into an iframe) —
the per-`<id>` dir, the `kind` column, and the `?file=` raw seam are in place for it, but `publish` only
takes a single file today. No versioning/dedupe (republish = new artifact). No per-session lens in the
Sessions page yet (the data supports it).

---

## Suggested build order (dependency-aware)

1. ~~**Automations** (cron + webhook → terminal sessions)~~ — ✅ shipped (v1); inbound listeners remain.
2. **Company Settings** — cheap (one file + injection point), immediately improves every agent.
3. **Memory persistence + injection** — the DB layer now exists; episodes are nearly free off the audit stream.
4. **Secrets vault** (encrypted in DB) + move connector creds behind it — debt that gets worse the longer it waits.
5. **Dreaming v1** — eval → proposed improvements as Inbox approval cards (reuses pillars 2, 5, 9).
6. **Skills, Tools/Apps** — bigger product surfaces; design after the above settle.
