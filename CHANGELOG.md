# Changelog

All notable changes to Agent OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

## [0.95.0] — 2026-07-10
### Added
- **KB pages now count how often agents read them.** Every `kb_read` fetch by an agent bumps a
  per-page `read_count` and stamps `last_read_at` (new `kb_pages` columns, added additively for
  existing tenants). It's a cheap targeted `UPDATE` — the FTS reindex trigger is re-scoped to
  `UPDATE OF title, tags, body`, so a fetch never re-tokenizes the body. This is the signal a future
  auto-archive pass will use to retire never/rarely-read pages. Surfaced on `KbPage` as
  `readCount`/`lastReadAt`; only the agent fetch route (`GET /api/kb/read`) counts — console reads,
  history and revert don't (`src/state/kb.ts` `recordRead`, `src/server.ts`, `src/state/db.ts`).

## [0.94.1] — 2026-07-10
### Fixed
- **Memory migration now pre-flights the backend instead of failing mid-loop.** The
  `POST /api/settings/memory/migrate` route batched straight into writes, so an unreachable or
  auth-rejected external store surfaced only as a confusing `store failed after 0 migrated: … → 401`
  after the first row. The first batch now runs `os.memory.health()` first and, if the backend isn't
  ready, returns `503 backend not ready — <detail>. Fix it in Settings → Memory, then migrate.`
  (paired with the v0.91.1 authenticated automem health probe, so a bad/truncated automem token is
  reported as `token rejected (401)` before any migration starts). Only the first batch checks — once a
  store lands the token is proven, so later batches skip the extra round-trip.
### Added
- **Member avatars on a session's "started by" too.** The Sessions list (both the card grid and the
  list view) and the terminal-header facts now show the avatar of the member who started a session,
  instead of the generic person glyph. Automation-spawned runs keep the Bot/Play glyph
  (`memberOfPrincipal` returns nothing for `automation:`/`task:`/`chat:` provenance), and unmapped ids
  fall back to the person glyph — so nothing regresses. Client-only, reusing the raw `spawnedBy` id
  already on the session and the shared `memberOfPrincipal` resolver (`StartedBy`/`SessionFacts`,
  `web/src/App.tsx`). Completes avatar coverage across the Sessions page.

## [0.93.0] — 2026-07-10
### Added
- **"Run now" on an automation asks headless vs interactive.** Firing an automation once from the
  console now pops a small chooser: **Interactive** (opens an attachable terminal you can watch and
  steer, and drops you into it) or **Headless** (fire-and-forget `claude -p`, progress lands in the
  Inbox). The pick is a per-run override — it does **not** change the automation's saved default mode.
  The current default is labelled in the dialog. Server: `POST /api/automations/:id/run` accepts an
  optional `{ mode }`, threaded through `Automations.fire` (new `opts.mode`, falling back to `a.mode`);
  the `automation.fired` audit records the effective mode. Pairs with 0.91.0's headless "Take over".

## [0.92.0] — 2026-07-10
### Added
- **Member avatars now show on sessions and the inbox too.** A session's **"run as"** facet (in the
  terminal header) shows the acting member's avatar instead of the generic person glyph, and the
  inbox **Activity feed** shows the avatar of whoever **resolved an approval** ("· by …") or
  **answered a question**. Both fall back to the member's initial when they haven't uploaded a picture,
  and to text-only (no avatar) for non-member principals — an automation-run session, or a resolver
  that doesn't map to a loaded member — so nothing regresses. Purely client-side: the raw `runAs` id is
  already on the session and `resolvedBy`/`answeredBy` on the message, so the pages just load the team
  roster once and resolve id/email → member (`memberOfPrincipal` + a shared `PrincipalTag`,
  `web/src/App.tsx`). With this, avatars now appear on every people-naming surface in the console —
  sidebar, Team, Tasks, Sessions, Inbox.

## [0.91.1] — 2026-07-10
### Fixed
- **A bad automem token now fails loudly at Test/health time instead of mid-migration.** automem's
  `/health` endpoint is unauthenticated, so a wrong/stale token still reported "healthy · N memories" —
  the green backend badge, Settings → **Test connection**, and the drift banner all passed, and the bad
  token only surfaced on the first authenticated write as an opaque `store failed after 0 migrated:
  automem POST /memory → 401`. `AutomemMemoryProvider.health()` now follows the `/health` liveness probe
  with a cheap authenticated `GET /recall?limit=1`: a 401 there is reported as `token rejected (401) —
  check the token in Settings → Memory`, so a wrong token turns the badge red and blocks the confusing
  migrate attempt. The migrate route's own 401 error also now appends that hint.

## [0.91.0] — 2026-07-10
### Added
- **Take over a headless run — convert it to an interactive session you can watch and steer.** A
  headless run (cron/webhook/chat/task automation) is `claude -p` — non-interactive and unattended.
  From the console you can now promote one to a live, attachable interactive TUI: a **Take over
  (go interactive)** control sits over the live-streaming terminal, a **Continue interactively** button
  sits on a finished run's read-only transcript, and a **Take over** action appears on the run's row in
  every Sessions list. It re-launches the same run interactively under its pinned `--session-id`
  (`claude --resume`), so the conversation continues with full context; if the `-p` run is still
  streaming it's stopped first (the in-flight turn ends and resume picks up from the last completed
  turn). Reuses the existing resume/attach machinery — the relaunch writes the `session-<id>.env` the
  headless lane skips, so the run becomes resumable/attachable like any interactive session. New route
  `POST /api/sessions/:id/interactive` (same per-member gate as stop/resume) → `TerminalManager.goInteractive`;
  audited `session.interactive`. Only claude-code runs with a pinned session id qualify.

## [0.90.0] — 2026-07-10
### Added
- **Member avatars now show on the Tasks board too.** The profile pictures added in 0.88.0 are reused
  wherever a task names a person: the assignee badge on Kanban cards and list rows, and both "Assign to"
  dropdowns show the member's avatar (falling back to their initial when unset). Agents keep their own
  manifest icon and system/automation/unknown assignees keep the person glyph — the swap only applies to
  ids that resolve to a real member. Done via the existing `assigneeIcon` helper + the shared
  `MemberAvatar`, so no new data plumbing (`web/src/App.tsx`). Other people-naming surfaces
  (Sessions "started by"/"run as", Inbox attributions, Audit principal) still show label strings only —
  those receive a name from the server, not a member object, so they'd need API changes to gain avatars.

## [0.89.0] — 2026-07-10
### Added
- **File attachments on tasks.** A task can now carry files — screenshots, logs, PDFs, CSVs, generated
  deliverables — alongside its description and activity timeline. Humans upload from the Tasks detail
  drawer (a picker **or** drag-and-drop) with per-file download and delete; a working agent attaches a
  file from its own working folder with the new **`task_attach`** MCP tool (path resolved strictly under
  the agent folder, like `publish`, so it can't escape). Files snapshot immutably to disk under
  `<home>/task-attachments/<taskId>/` (the same model as the Artifacts gallery, keyed to a task); the
  DB gets a `task_attachments` table; each attach logs an `attach` event on the task timeline and audits
  `task.attached`, and deleting a task cascades its attachment rows + files. New routes: agent loopback
  `POST /api/tasks/attach` (+ attachments now returned by `task_get`), and member console
  `POST/GET/DELETE /api/tasks/:id/attachments[...]`. `task_get`'s output lists attachments too.

## [0.88.0] — 2026-07-10
### Added
- **Team members can attach a profile picture.** Each member now has an avatar that renders in the
  Team roster and the sidebar user badge, falling back to their initial when unset. You set your own
  from the Team page (hover your avatar → click to pick an image; a small ✕ removes it); owners/admins
  may set anyone's. The console down-scales + center-crops the picked image to a small square JPEG
  before upload, so avatars stay tiny in the DB and on every `/api/team` load. Stored as a
  self-contained `data:` URL in a new `members.avatar` column (no file store to serve from), so it
  survives restarts and travels with the member row. New routes `POST`/`DELETE /api/team/:id/avatar`
  (self-or-admin gated, audited `member.avatar`, base64-image + size validated). Types + store +
  server + web (`src/types.ts`, `src/state/db.ts`, `src/governance/team.ts`, `src/server.ts`,
  `web/src/lib/api.ts`, `web/src/App.tsx`).

## [0.87.0] — 2026-07-10
### Added
- **Video artifacts play inline in the deliverables gallery.** The artifact library now previews
  `video/*` deliverables (`.mp4`/`.m4v`/`.webm`/`.mov`/`.ogv`) in a real `<video>` player instead of
  falling through to a bare download link, with a first-frame thumbnail (Film icon) in the gallery list.
  The store learned those extensions (`mimeOf` in `src/state/artifacts.ts`), and — the part that makes
  playback actually work — the raw route (`GET /api/artifacts/:id/raw`) now honours HTTP **byte-range
  requests**: it answers `Range:` with `206 Partial Content` + `Content-Range`, advertises
  `Accept-Ranges: bytes` and `Content-Length` on the full response, and returns `416` for an
  unsatisfiable range. Scrubbing/seeking depends on this, and Safari refuses to play a video served
  without range support at all. Server + web (`src/server.ts`, `web/src/App.tsx`).

## [0.86.1] — 2026-07-10
### Fixed
- **Saving Slack/Discord tokens no longer looks like it needs a server restart.** The server already
  re-dials the Socket-Mode / Gateway connection live when tokens change (`SlackSocket.restart()` /
  `DiscordSocket.restart()` on the cached per-tenant runtime — no process restart), but the Integrations
  panel polled connection status only **once**, 1.2 s after saving. A Slack/Discord handshake (auth check →
  WebSocket → READY) routinely takes longer than that, so the panel showed "Disconnected" mid-reconnect and
  people restarted the whole box to fix a non-problem. The panel now polls with backoff (up to ~12 s) until
  the touched platform settles — connected, or intentionally cleared — so it reflects the live reconnect.
  Web-only change (`web/src/App.tsx`).

## [0.86.0] — 2026-07-10
### Added
- **`agent-os policy reconcile` — align agents' `policyContext` to the enforced ruleset.** The command
  that retires the manual `sed` sweeps needed whenever a tenant's enforced policy id changes (the drift the
  #136 warning reports). Rewrites every `<home>/agents/*/agent.json` whose `policyContext` diverges from the
  tenant's enforced id — `--tenant <slug>` or `--all` across the control plane, **dry-run by default**
  (`--yes` to apply). It only ever touches agent manifests, never the policy document (agents conform to the
  policy, not the reverse). Pure filesystem like `tenant remove` (no server, runs over SSH): the enforced id
  is read straight from each tenant's resolved policy file exactly as the runtime resolves it (home override
  else bundled), and the apex tenant maps to the un-nested home just like the registry. Rewrites are a JSON
  round-trip that preserves other fields + the on-disk format (no regex/`@`-interpolation footguns). New pure
  `reconcileTenant()` (`src/governance/policy-reconcile.ts`) is shared-ready for a future audited
  `POST /api/admin/policy/reconcile` + console banner. Test: `npm run test:policy-reconcile` (11/11).

## [0.85.0] — 2026-07-10
### Fixed
- **Enricher no longer flags a hyphenated flag/compound as `risky` shell (#139).** `RISKY_SHELL` matched
  its keywords (`delete`, `drop`, `deploy`, `prod`, …) anywhere in the command, so `gh pr merge
  --delete-branch` tripped on `--delete-branch` and multi-line blocks tripped on `deploy-preview`-style
  tokens — over-firing the `shell.exec risky → ask` gate on routine ops. The regex now excludes a
  leading/trailing `-` (and word char) via lookarounds, so a flag name isn't treated as a destructive
  verb, while real commands (`drop table`, `sudo systemctl restart`, `kubectl delete`) still match. The
  conformance runner gained an optional `expectRisky` fact assertion (the default posture no longer GATES
  `risky`, so this is invisible in the decision alone) with fixtures covering both the false positives and
  the true positives.

## [0.84.0] — 2026-07-10
### Fixed
- **Removing a built-in agent now sticks.** A built-in agent (`agent-author`, `engineer`, `support`,
  `marketer`, `researcher`) is seeded from the catalog into the data home on boot, so it lives under the
  home and always showed a delete button — but deleting its folder wasn't durable: the next server boot
  re-seeded it and the agent came back. Deleting a built-in now records a tombstone
  (`settings.suppressed_builtins`); `seedBuiltinAgents` skips any tombstoned id, so the removal survives a
  restart. Re-installing the agent from the agent library (`POST /api/agents/catalog/:id/install`) clears
  the tombstone, so it seeds normally again. The console's delete confirmation now tells you a built-in can
  be re-added later, and `agent.deleted` audit rows carry a `builtin` flag.

## [0.83.1] — 2026-07-10
### Added
- **Fail fast on an unsupported Node.** The OS depends on the built-in `node:sqlite` (`DatabaseSync`),
  which only exists on Node ≥ 22.5 — but running under older Node (e.g. a box whose default `/usr/bin/node`
  is v20 while the service uses nvm v22) crashed with a cryptic `ERR_UNKNOWN_BUILTIN_MODULE: No such
  built-in module: node:sqlite` from deep inside a store module. A new side-effect `src/preflight.ts`,
  imported first in `cli.ts` (before any `node:sqlite` import loads), now exits with one clear line:
  *"agent-os requires Node >= 22.5.0 (found vX) … switch to Node 22.5+"*. Also added `engines.node
  ">=22.5.0"` to `package.json` so `npm install` warns.

### Docs
- **Spec: `agent-os policy reconcile`** (`docs/policy-reconcile-plan.md`) — a governed command to align
  every agent's `policyContext` to the enforced ruleset id (per-tenant or `--all`, dry-run by default,
  audited + agent-revision snapshot), replacing the manual `sed` sweeps needed today when a tenant's
  enforced id changes. Follow-up to the #136 mismatch warning; not yet implemented.
### Added
- **Scheduler concurrency cap `AOS_MAX_CONCURRENT_SESSIONS` (#137).** Defense-in-depth against the
  OOM bursts that drove the globex crash rate (49/113 sessions): when set, the automation scheduler
  stops firing NEW cron / one-shot / task-dispatch spawns once that many sessions are already alive on
  the box, and resumes as they finish. A deferred cron isn't stamped `lastFiredAt` (a `once` isn't
  disabled), so it simply re-fires on the next tick — no queue. **Interactive and chat spawns are never
  gated** (a human is waiting; a chat spawn has no natural retry) but they DO count toward the total, so
  the scheduler backs off when a human is already loading the box. Fail-open if tmux liveness can't be
  polled. Default **0 = unlimited** (opt-in; set per box to its RAM). Deferrals are audited as
  `scheduler.deferred`. NB: the "false `crashed` episodes pollute the learning loop" worry from the
  issue was unfounded — a spawn-death with zero work already skips the episode (`composeEpisode` returns
  null); only a run OOM-killed mid-work records `crashed`, which needs a kill-cause breadcrumb to
  distinguish infra-kill from a real crash (left as a follow-up).

## [0.82.0] — 2026-07-10
### Added
- **Human 👍/👎 verdict on a finished run — the ground-truth signal for the maturity score.** A member who
  oversaw a run can rate it from the Sessions list (grid + list views); the verdict becomes the
  **highest-confidence outcome layer** in `src/state/agent-stats.ts`, sitting above the agent's own
  self-report and even a task result (`up` → success, `down` → failure; clicking the active thumb clears
  it). So a run the agent optimistically self-reported `success` flips to a failure the moment a human
  thumbs it down. `POST /api/sessions/:id/rate` (`{rating: 'up'|'down'|null}`, gated by the same
  can-view-session rule as stop), persisted on `term_sessions` (`rating`/`rated_by`/`rated_at`), audited
  `session.rated`. `AgentStats` gains a `rated: {up, down}` tally, shown on the agent Trust card.
- **Maturity surfaced across the fleet.** Beyond the per-agent Trust card, each agent chip on the Agents
  page (grid + split rail) now carries a compact **maturity badge** (score + confidence, coloured by band,
  hidden until an agent has run) — trust-at-a-glance across the whole fleet, fed by `GET /api/agents/stats`.

## [0.81.1] — 2026-07-10
### Fixed
- **Host governance now applies on every tenant, not just fresh ones.** The `net.connect`/`ssh.exec`
  gating rules lived only in `config/policy/default.policy.json`, so a tenant with a **persisted policy**
  that predated them (i.e. any existing workspace) silently no-op'd — enabling "Govern host access" did
  nothing, and an ungranted `ssh` was allowed. Caught while dogfooding on the live tenant. The host
  verdict is now applied by the **engine** (`hostGovernanceDecision` in `host-match.ts`), combined
  most-restrictive with the editable policy's verdict in `TerminalManager.gate` — so enabling the feature
  works regardless of the tenant's policy document, while the policy still contributes the never-tier
  (`ssh box 'rm -rf /'` is still denied outright). The host rules were removed from the default policy
  JSON (they're redundant with the built-in). No behaviour change for a fresh tenant.

## [0.81.0] — 2026-07-10
### Added
- **Per-agent trust & maturity stats — "which agent can the system trust to run with less oversight?"**
  A read-side roll-up (`src/state/agent-stats.ts`, `GET /api/agents/:id/stats` + fleet `GET /api/agents/stats`,
  a Trust card on the agent page) over signals already flowing through the governed gateway — it invents
  no new bookkeeping. Each run gets a **governed** outcome (a human denial or a crash can't be papered over
  by an optimistic self-report): `failure` if the run crashed / hit a denial (reject, policy deny,
  killswitch, budget stop) / self-reported failure / its dispatching task ended `blocked`; `success` if the
  task ended `done` or the agent self-reported success on a clean, un-denied run; else `inconclusive`.
  **Maturity ≠ success rate** — it answers "trust to run alone": `autonomy × (1 − denialRate) ×
  volumeConfidence`, where autonomy = governed actions that ran without suspending for a human, denials
  multiply the score down hard, and small samples are discounted (5 clean runs can't outrank 200). So an
  agent with a 95% self-reported success rate that needs a human approval every run stays low-maturity by
  design. Stats are visibility-scoped (a member sees only agents they may run).

## [0.80.0] — 2026-07-10
### Changed
- **Unattended runs no longer strand on a blocking `ask`/approval (#138).** A headless run
  (automation/cron/task, `claude -p`) has no human at the terminal and — unlike a resident chat —
  no idle-reaper bound, so a blocking `ask` used to hang the session for ~1h and a gated approval
  hung it indefinitely, wasting the run and holding its memory (a contributor to the OOM crash rate
  in #137). Now, for headless runs only:
  - **`ask`** waits a short bounded window (`AOS_UNATTENDED_ASK_WAIT_S`, default 120s) in case an
    operator is live, then **parks**: the question is already in the operator's Inbox + DM'd, so it
    returns guidance to stop cleanly (report + end) rather than hang or guess on a risky call.
  - **Gated approvals** in the PreToolUse gate hook wait a bounded window
    (`AOS_UNATTENDED_APPROVAL_WAIT_S`, default 180s) then **fail closed** (deny) — never allow. The
    approval stays pending in the inbox for a human to resolve and re-run.
  Interactive sessions are unchanged (they keep the full ~1h / indefinite wait — a human is present).

## [0.79.1] — 2026-07-10
### Fixed
- **Warn on `policyContext` mismatch at agent registration.** An agent manifest's `policyContext` was
  silently ignored: the engine enforces a single loaded ruleset and `classify()` drops per-agent context,
  so an agent declaring a `policyContext` that names a *different* ruleset was governed by the enforced
  policy, not the one it claimed — with no signal. This is a footgun: relabel a tenant's policy (or point
  an agent at a ruleset lacking the red-line rules) and its guardrails vanish unnoticed. `registerAgent`
  now calls a pure `policyContextMismatch()` helper and `console.warn`s once per agent when its declared
  context diverges from `os.policy.id`, and the `AgentManifest.policyContext` doc now states it must match
  the enforced ruleset. No behavioural change to classification. Test: `npm run test:policy-context`.
- **Align the bundled defaults so a clean install is warning-free.** The bundled policy is `default@v3`
  but every bundled agent (`config/agents/*/agent.json`) and every hardcoded seed path
  (`src/init.ts`, `src/server.ts`, `src/edge/consolidation.ts`) still declared `policyContext:
  "default@v1"` — so the new warning above would fire for the product's own defaults on every fresh boot.
  Bumped them all to `default@v3` (the demo, which loads `demo.policy.json` = `default@v1`, is left as-is),
  so the warning now only signals genuine operator drift. Already-provisioned on-disk agents in a live
  data home are unaffected and will warn until re-pointed — which is the intended signal.

## [0.79.0] — 2026-07-10
### Added
- **Sessions list: a "My sessions / All" scope toggle.** Owner and admin see the whole workspace's
  sessions by default (their visibility is fleet-wide by design — `canViewSpawn` passes any session for
  those roles), so an admin- or automation-spawned run shows up in an owner's active list automatically.
  The new segmented toggle at the head of the Sessions filter bar narrows the view to the sessions the
  viewer is accountable for — ones they spawned directly or that run **as** them (the same rule as the
  sidebar switcher's "my sessions") — without changing who can *see* what. It persists in the URL hash
  query alongside the other session filters (so a refresh/deep-link restores it) and is shown only to
  owner/admin, since a member's list is already only their own.

## [0.78.0] — 2026-07-10
### Added
- **Host credential injection (Phase 2c) — a granted SSH host's key is now delivered to the agent's
  shell, so plain `ssh` just works.** When an agent session launches, each enabled SSH [Host
  connection](./docs/host-connections-plan.md) bound to it that carries a `secret:KEY` credential has
  its key resolved from the vault and materialised into a **session-scoped** `ssh_config` + an
  `ssh`/`scp` PATH shim (`TerminalManager.injectHostCredentials`). The key is written `0600` under the
  session's private dir and offered **only to its host** (`IdentitiesOnly` on the matched `Host`
  pattern), so an agent can `ssh deploy@box.prod.internal` without ever handling the key — and the prod
  key is never offered to other hosts. Cleaned up with the session; audited `host.secret.injected`.
  Local-lane only for now (uid-isolation is a follow-up); CIDR-matcher hosts are skipped (an ssh_config
  `Host` can't express a CIDR — governance still applies, the key just isn't auto-offered).

## [0.77.5] — 2026-07-10
### Fixed
- **Editing an automation now scrolls the form into view.** The create/edit form renders at the top of the
  Automations section, but the Edit buttons sit on cards further down — clicking Edit while scrolled down
  opened the populated form above the viewport, so it looked like "nothing happens." The form now scrolls
  itself into view when it opens or when switching which automation is being edited.

## [0.77.4] — 2026-07-10
### Added
- **`fleet-insights` maintainer skill** (`.claude/skills/fleet-insights/`). Mines agent sessions across
  all three tenants (northwind / globex / initech) read-only via a zero-dependency, schema-defensive
  `node:sqlite` collector, ranks the friction into product insights, and ships the safe wins as a PR. The
  Slack-egress fix below was the first change it produced.
### Changed
- **Slack egress gives agents an actionable error instead of a dead end.** When `slack_send`/`slack_reply`
  failed (e.g. `missing_scope` or `not_in_channel` posting to a private channel), the agent got back the
  raw Slack error code and no recourse — real fleet runs then stranded on repeated `ask`s to a human. Now
  `explainSlackError` maps the common codes to a one-line remedy ("ask a human to `/invite` the bot", "add
  the missing scope in Settings → Integrations and reinstall", …), `postMessage` surfaces the specific
  `needed` scope, and `slack_reply` joins-and-retries once on `not_in_channel` for parity with `slack_send`.

## [0.77.3] — 2026-07-10
### Changed
- **`npm run test:governance` refuses to run against a stale `dist/`.** The conformance suite exercises
  the compiled `dist/` gate, not `src/`, so running it without rebuilding after a governance edit
  validates old behaviour — which once made the host-governance rules look like "7 failures" that were
  really just an un-rebuilt tree. The runner now bails (exit 2) with a "run `npm run build` first"
  message when `dist/` is missing or older than any `src/*.ts`.

## [0.77.2] — 2026-07-10
### Fixed
- **Terminal "Using the terminal" help modal now matches the (light) dialog theme.** It was styled for a
  dark surface (`text-neutral-300` on white), so the descriptions rendered washed-out and the key chips
  looked heavy. Switched to the app's semantic tokens (`text-muted-foreground` / `bg-muted` /
  `border-border` / `text-foreground`) so it reads correctly.

## [0.77.1] — 2026-07-10
### Fixed
- **Terminal copy works over plain HTTP again.** The new first-party `<Xterm>` (v0.75.0) copied via
  `navigator.clipboard`, which browsers expose only in secure contexts (https / localhost) — so on a
  console served over plain http on a tailnet host, select-to-copy / ⌘-C / OSC 52 silently did nothing.
  Copy now falls back to a hidden-textarea `execCommand('copy')` inside the user gesture (the same
  technique ttyd used), so it works in insecure contexts too.

## [0.77.0] — 2026-07-10
### Added
- **Host governance (Phase 2b) — agents' SSH / internal-network / DB reaches are now gated by policy.**
  With **Settings → Governance → "Govern host access"** on (owner-only, off by default), the gate parses
  an agent's shell egress (`ssh`, `curl`, `psql`, `wget`, `nc`, …), extracts the destination host, and
  reclassifies `shell.exec` → **`net.connect`** / **`ssh.exec`** so the policy can gate it: a reach to a
  host that isn't a granted [Host connection](./docs/host-connections-plan.md) (or is internal-looking —
  private IPs, `.internal`) pauses for approval; a host with posture **never** is refused; an
  unparseable host (a variable/pipe) escalates rather than slips through. Per-agent **`netMode`** (agent
  config): `open` (default — public-internet egress runs freely, only internal/listed hosts are governed)
  or `allowlist` (lockdown — any un-granted reach pauses). New policy caps `net.connect`/`ssh.exec` rules.
  Best-effort command parsing — a governance + audit layer, **not** a firewall (see
  `docs/host-connections-plan.md` §2). Phase 2d (kernel egress enforcement) remains future work.

## [0.76.0] — 2026-07-10
### Changed
- **Automations speak human, not cron.** The Automations list now renders a schedule as friendly prose
  ("Every 30 minutes", "Weekdays at 9:00 AM", "Every Mon, Wed, Fri at 2:30 PM") instead of the raw
  `*/30 * * * *` — a new `cronToHuman()` describer covers the common shapes and falls back to the raw
  expression (kept on hover) for anything it can't phrase, so it never misstates a schedule. The New/Edit
  form gains more presets (every 5 min, every 2/12 hours, 6 PM daily, …) and, when you drop to a custom
  cron, a live **"▸ Every weekday at 9:00 AM"** preview under the box so you can see what you typed means.
- **Times are labelled with the server's timezone.** `/api/state` now returns the box's IANA zone
  (`serverTz`); cron fires in server-local time, so the console labels next-run and the schedule preview
  with it (e.g. `· server time (America/New_York)`) — a viewer in another zone no longer misreads "9 AM".

## [0.75.0] — 2026-07-10
### Changed
- **The browser terminal is now a first-party xterm.js client, not an embedded ttyd iframe.** A new
  `<Xterm>` component speaks ttyd's WebSocket protocol directly (over the same `/terminal/ws?arg=…`
  proxy, auth, tmux `attach.sh` resurrection and gate hook — the backend is unchanged), so the console
  finally *owns* the terminal frontend. That unlocks what the iframe couldn't: **select-to-copy** (drag
  copies to your clipboard with a ✓ flash, highlight kept), ⌘/Ctrl-C copy, native paste, **Esc cancels a
  selection**, clickable links, scrollback search, console-matched theming, and a live font stepper — plus
  a **⍰ Help** modal on the terminal pane documenting the gestures. The canvas renderer (on the stable
  xterm 5.5 line) removes the DOM-renderer selection "wobble". Session tmux gains `mouse on` +
  `copy-selection-no-clear` so the wheel scrolls scrollback at a shell prompt and drag-copy keeps its
  highlight. Adds a standalone terminal **test bed** (`scripts/termbed.mjs` + `web/termbed.html`) to
  iterate on the client in isolation.

## [0.74.2] — 2026-07-10
### Changed
- **Session facts read as a subline under a smaller title.** Instead of sitting on the header's right
  edge (v0.74.1), the owner/agent/started-by/age/status cluster now stacks directly beneath the open
  session's title, which is dropped to a compact size. The facts row shows every fact and wraps on a
  narrow viewport rather than hiding them; the status pill leads.

## [0.74.1] — 2026-07-10
### Changed
- **Session facts moved to the page header.** The owner/agent/started-by/age/status cluster from v0.74.0
  now lives in the spare right-hand space of the main page header (next to the "All sessions" back button)
  instead of the terminal tab strip, where it was squeezing the session tabs out of view. Same facts and
  progressive hiding; the tab strip is back to full width.

## [0.74.0] — 2026-07-10
### Added
- **Session detail top bar shows owner + facts.** The open session's terminal header (`#/sessions/<id>`)
  now pins a right-aligned fact cluster next to the tab strip — owner (run-as member), agent, started-by,
  age, a colored status pill, and the session id — reusing the existing row height (no taller header).
  Facts hide progressively on narrower panes so the row never wraps; the status pill always stays visible.

## [0.73.1] — 2026-07-10
### Docs
- **README: "Running on macOS vs Linux" section.** Documents that agent sessions run in a tmux server
  that outlives a server restart (re-adopted via `<home>/tmux.sock`), and the two systemd unit settings
  that are **required** on Linux or a `systemctl restart` silently kills every session — `KillMode=process`
  and `PrivateTmp=false` (both already correct in the bundled `agent-os.service`) — plus the operational
  rule to never run `tmux` against the app socket as root. Captures the platform-difference lessons from
  the v0.72.1/0.72.2 fixes.

## [0.73.0] — 2026-07-09
### Added
- **Host connections — a new "Host" shape on the Connections page.** You can now register the hosts
  your agents reach — an SSH box, an internal service, a database — as first-class connections:
  name, a match pattern (hostname / wildcard / CIDR / `host:port`), protocol, an optional
  Secrets-vault credential (`secret:KEY`), and a default posture (allow / ask / never). Same
  org/personal/shared ownership and owner-admin management as MCP connectors; a `hosts` table +
  `/api/hosts` CRUD back it. **Phase 2a of the access model** (`docs/host-connections-plan.md`) —
  this is the registry + UI only; the gate does **not** govern reaches to these hosts yet (that's
  Phase 2b), and the UI says so.

## [0.72.3] — 2026-07-09
### Fixed
- **A naturally-finished session no longer auto-resurrects either** (follow-up to v0.72.0, which fixed
  it for the Stop button). When claude exits on its own, the launcher normally holds the pane on a
  "press [r] to resume" prompt — but if that pane dies (a detached/idle `read` bailing out, seen on the
  Linux boxes), ttyd's silent auto-reconnect re-ran `attach.sh` and `claude --resume`d the finished
  session back to life. `markEnded` now drops the same stay-stopped sentinel as a manual stop (inert
  while the holding pane lives, decisive if it dies); a deliberate re-open or **Resume** clears it. The
  idle reaper does the same, so a reaped resident session stays reaped instead of un-reaping itself on
  a still-open tab (a later Slack reply still revives it).

## [0.72.2] — 2026-07-09
### Fixed
- **`PrivateTmp=false` in `agent-os.service` — the other half of the restart-survival fix (v0.72.1).**
  With `KillMode=process` the tmux server now survives a restart, but the unit still shipped
  `PrivateTmp=true`, which hands every service *invocation* its own throwaway `/tmp`. On the first
  restart-after-fix the surviving tmux server stayed pinned to the previous invocation's now-torn-down
  `/tmp` namespace, so the `claude` CLI's `mkdir /tmp/claude-<uid>` failed with `ENOENT` and the session
  died anyway (`claude session ended`). `PrivateTmp=false` makes the service share the host's stable
  `/tmp`, which persists across restarts, so a surviving session keeps a valid `/tmp` — matching
  macOS/launchd. **Deploy note:** flip `PrivateTmp=true`→`false` in each live unit
  (`agent-os.service` on Initech, `agent-os-globex` on the jump-server), `daemon-reload`, then do
  one clean restart (kill any stale tmux server on the data socket first so no dead-namespace server
  lingers). Verified on both boxes: a session survives a restart and `/tmp` stays writable.

## [0.72.1] — 2026-07-09
### Fixed
- **Restarting the server no longer kills running agent sessions on Linux/systemd** (the
  Initech/Globex boxes). Sessions run in a tmux server that daemonises out of node's process
  tree, so a restart is meant to leave them alive and re-adopt them via the persistent
  `<home>/tmux.sock` — which is exactly what happens on macOS/launchd. But the systemd unit shipped
  `KillMode=mixed`: on stop, systemd SIGKILLs the **entire cgroup**, and a double-fork escapes the
  process tree but **not** the cgroup, so every `systemctl restart` took the tmux server (and all live
  sessions) down with it — they resurfaced as `crashed`. `agent-os.service` now uses
  `KillMode=process`, so systemd signals only the main node process and leaves the tmux server (and its
  sessions) running for the fresh process to re-adopt. **Deploy note:** the live unit files on each box
  must be updated too (`agent-os.service` on Initech, `agent-os-globex` on the jump-server), then
  `systemctl daemon-reload` + one restart.

## [0.72.0] — 2026-07-09
### Fixed
- **Stopping a session from the terminal no longer auto-resumes it.** When you Stop a session, ttyd
  (auto-reconnect on) silently re-dialled the moment the pane's tmux died, re-running the attach
  wrapper — which `claude --resume`d the session straight back to life ("reconnected… resumes").
  Most visible on the Linux boxes (Initech/Globex), where the local backend + `attach.sh` drive
  the terminal. `stopSession` now drops a per-session `.stopped` sentinel that `terminal/attach.sh`
  checks before resurrecting: a silent auto-reconnect stays disconnected, while a **deliberate**
  re-open (opening the terminal, or the **Resume** button → new `POST /api/sessions/:id/resume`) lifts
  the block so resume still works on demand. The sentinel is cleared on any deliberate attach and
  removed with the session's files on delete.

## [0.71.0] — 2026-07-09
### Added
- **Per-tenant console branding (Settings → Theme).** Give each tenant an **accent colour** and a
  **favicon badge** (an emoji or 1–3 initials) so several tenants running in parallel — even across
  machines — are distinguishable at a glance. The accent tints the sidebar strip, active nav item and
  focus rings; the badge is rendered client-side into an SVG data-URI favicon (no uploads, no
  storage), so the browser-tab icon differs per tenant. Branding is served from a **public**
  `GET /api/branding` so the login screen and tab favicon are already themed before sign-in, and it
  even tints the magic-link accept page. Owner/admin edits via `GET`/`PUT /api/settings/branding`
  (stored in the per-tenant `settings` table under `ui_branding`, audited `settings.branding.updated`);
  applies live without a reload. Foreground colours are auto-chosen (black/white by luminance) so text
  stays readable on any accent.

## [0.70.0] — 2026-07-09
### Changed
- **Stopping a session retires its open approvals too.** The v0.69.0 stop-cascade for questions now
  extends to pending **approvals**: when a session is stopped (or crashes, or is idle-reaped), its
  pending approval cards are cancelled (new `cancelled` status) — the agent blocked on the gate is
  gone, so approving would only clear an effect no one will perform. Cancelling settles the gateway's
  decision as *denied* (a still-suspended gate unblocks and the effect is blocked), the gate-hook's
  status poll returns `deny`, and the orphaned "Needs you" card drops into the dismissable Activity
  feed (labelled *cancelled*, not a rejection).
### Fixed
- **`deleteSession` no longer leaks approval rows.** Permanently deleting a session now cancels its
  pending approvals (settling any waiter) and removes its `approvals` rows, matching how it already
  cascades messages and questions.

## [0.69.0] — 2026-07-09
### Added
- **Dismiss an agent question from the Inbox.** A pending question card now has a **Dismiss** button
  next to Reply. It cancels the question (new `cancelled` status) so it leaves "Needs you" — and a
  still-live agent's blocking `ask` unblocks and proceeds instead of waiting out its poll timeout.
### Changed
- **Stopping a session retires its open questions.** When a session is stopped (or crashes, or is
  idle-reaped), the agent that asked is gone and no one can answer — so its pending questions are now
  cancelled automatically. The orphaned "Needs you" cards drop into the dismissable Activity feed
  (labelled *dismissed*) instead of hanging forever as unanswerable prompts.

## [0.68.0] — 2026-07-09
### Changed
- **Connectors → Connections, with a Creds sub-tab.** The **Connectors** page is now **Connections**,
  and the workspace platform-credential editor (Composio key, Slack/Discord tokens, chat-router
  toggle) moved out of **Settings → Integrations** into a **Creds** sub-tab on the same page — so
  "what an agent can reach" and "the keys that power it" live in one place (`#/connectors/creds`).
  The Settings → Integrations tab is gone; all prose/links now point to **Connections → Creds**. Creds
  stays owner/admin-only, as before. UI-only — no API, schema, or data change. First step of the
  access-model reframe (`docs/access-model.md`).

## [0.67.0] — 2026-07-09
### Added
- **Edit an existing automation.** Each automation card gains an **Edit** button (owner or creator)
  that reopens the form pre-filled, so you can change the **name, run mode, schedule/cron, trigger
  filter, and task** without deleting and recreating it. The **agent** and **trigger type** stay
  fixed (shown disabled) — changing those still means recreating. Backend `Automations.update` now
  also patches the trigger `filter` (composio slugs are upper-cased; ignored for cron/webhook).
- **Spent one-shots collapse out of the way.** A one-shot run scheduled by an agent (`once`) that has
  already fired will never run again; those now fold into a collapsible **"Spent one-shot runs (N)"**
  section at the bottom of the Automations page — hidden by default, with per-item delete and a
  **Clear all**. Live cron/webhook/Slack/Discord automations are unaffected.

## [0.66.1] — 2026-07-09
### Fixed
- **Inbox: dismissing a "Needs you" notification is now instant.** The section rendered
  `messages.filter(isActionRequired)` without honoring the optimistic `dismissed` set (the Activity
  feed below it did), so a dismissed notification lingered until the next 1.5s poll dropped it
  server-side — it felt stuck. It now hides the moment you click.
- **Inbox: added a "dismiss all" link to the "Needs you" section.** Clears every open waiting
  notification there in one click (pending approvals/questions are left in place — those must be
  resolved/answered, and the server refuses to dismiss them anyway).

## [0.66.0] — 2026-07-09
### Added
- **Close a terminal tab without killing its session.** Each tab in the session switcher now has a
  **✕ close** button that hides it from the strip while the session keeps running — reopen it any
  time from **All sessions** (or the sidebar). Closed tabs are remembered across a refresh
  (localStorage); closing the tab you're viewing falls back to another live tab, else the sessions
  list. Distinct from **stop** (kills the shell) and **delete** (removes the session + its files).
### Fixed
- **Waiting-bell 🔔 now visible on terminal tabs.** The "Claude is waiting for you" indicator used a
  dark indigo that was near-invisible against the dark tab strip; it now renders in a lighter tone on
  the tabs (sidebar/list unchanged).

## [0.65.0] — 2026-07-09
### Added
- **Self-service sign-in recovery — no admin needed to get back in.** The login screen gains an
  **"Email me a link"** field: a member who lost their session (new device, cleared cookies, expired
  window) enters their email and the server mints a fresh 7-day magic-link and delivers it out-of-band —
  DM'd to their linked **Slack/Discord** (identity map) and written to **server.log** (the always-
  available fallback, matching how the owner-seed link is surfaced). New public route
  `POST /api/auth/request-link`; **neutral response** always (`{ ok: true }` whether or not the email is
  a real member — no account enumeration); rate-limited per email + client IP (3 / 15 min). Closes the
  gap where the ONLY way into the portal was an owner/admin-minted token. Audited
  `auth.link.requested` / `auth.link.notified`.
### Changed
- **Sliding login sessions — active users stop getting logged out at the hard 30-day mark.**
  `TeamStore.resolveSession` now bumps the 30-day expiry on activity (throttled to ≤1 DB write/day/
  session), and `GET /api/auth/me` re-stamps the `aos_sid` cookie on every app load (the SPA calls it on
  mount) so the browser cookie never lapses either. A daily-active user now stays signed in indefinitely;
  the fixed-30-day cutoff only bites a genuinely idle session. The one-time invite/magic-link semantics
  are unchanged (single-use, 7-day TTL).

## [0.64.0] — 2026-07-09
### Added
- **Task lifecycle → Inbox notifications, routed to the right person.** Creating, (re)assigning, or
  changing a task's status now lands an inbox card for the human it concerns and DMs them on their
  linked Slack/Discord account: a **new/reassigned** task → its human **assignee** ("assigned to you");
  a task going **blocked** or **done** → its **owner**. Agent-assigned and self-made changes stay quiet
  (an agent-owned task announces itself by dispatching a session; nobody is notified of their own
  action). Fires on **every** mutation path — console, agent `task_*` MCP tools, and the auto-dispatcher
  — because the sink lives on `TaskStore`, not the routes.
- **Explicit recipient routing on the inbox feed (`audience`).** A message row can now name its
  **audience** (`audience_kind`/`audience_id`) instead of always inheriting visibility from its session's
  provenance — the mechanism that lets a **session-less** card (a task notification) reach exactly the
  right member. `canViewMessageRow` resolves the audience via the same `resolveRecipients` used to DM, so
  a card is visible to precisely whom it would be pinged (owner/admin still see all); rows without an
  audience are unchanged. Task cards use a `task:<id>` session sentinel and deep-link to the board.

## [0.63.1] — 2026-07-09
### Changed
- **One global recipient resolver for notifications.** "Who is the receiver of a notification?" was
  re-derived in each of the three DM notifiers (approvals, questions, task-overdue), each with its own
  owner→admins fallback chain and its own copy of the identity-map DM loop. Introduced a single
  `Audience` vocabulary + `resolveRecipients` (`src/governance/recipients.ts`) — `approvers` (by level),
  `admins` (the escalation tier), `member`, and `sessionOwner` (a run's `run_as`, else a member spawner)
  — and a shared `deliverDM` helper. The notifiers now declare WHO should hear about a thing and never
  hand-resolve members. Pure refactor: recipient sets and audit lines are unchanged (verified against
  the old logic). Groundwork for routing session-less notifications (e.g. Tasks) to the right person.

## [0.63.0] — 2026-07-09
### Added
- **Ownership guard on automation delete/edit.** Admins and members can now only delete or edit
  automations **they created**; the owner keeps a break-glass override for anyone's (and for legacy
  automations with no recorded creator). Prevents one teammate from clobbering another's automation.
  Enforced server-side on `DELETE`/`PATCH /api/automations/:id` and mirrored in the console — the
  mode/enable/delete controls are hidden (with a "created by another member" note) on automations you
  can't manage, via a new `canManage` flag on the automation view.

## [0.62.2] — 2026-07-09
### Fixed
- **Word-wrap the task description.** Long lines and preformatted/code blocks in a task body now wrap
  (and long unbroken tokens break) inside the detail modal instead of stretching the width — scoped to the
  task description so the shared markdown styles (KB, artifacts) are unchanged.

## [0.62.1] — 2026-07-09
### Fixed
- **Tasks board responsiveness + a roomier detail modal.** The task detail modal was capped too narrow
  (`max-w-lg`) — widened to `2xl`/`3xl` so the body, controls, and activity have room. The board now
  reflows at more breakpoints (2-up at `sm`, 4-up at `lg` instead of only `xl`), the new-task form drops to
  2 columns on small screens, and the modal's control rows stack on the narrowest widths.

## [0.62.2] — 2026-07-09
### Added
- **Explicit risk class on every decision.** A policy `Decision` now carries a first-class
  `riskClass` — 🟢 green (allow) / 🟡 yellow (admin approval) / 🔴 red (owner approval) / ⛔ deny — so
  the four buckets the gate already used are now a named, legible signal instead of something each
  consumer re-derived from the approver level. The engine also builds a human `reason` that names the
  *condition* that tripped the rule (e.g. `deleteCount > 25`, `destructive`, `connector.connect`) rather
  than "matched rule 3". The class + reason are surfaced on the **inbox approval card** (a coloured
  RED/YELLOW badge + a "why:" line), the **approver DM** (Slack/Discord), the **chat-thread mirror**, and
  the **audit trail** (`gate.decision`). Additive and backward-compatible — pre-`riskClass` rows fall back
  to the approver level (head→yellow, owner→red).

## [0.62.1] — 2026-07-09
### Fixed
- **Inbox action cards preserve line breaks in agent prose.** Question, notification, and approval bodies
  now render with `whitespace-pre-line`, so an agent's multi-line question or description keeps its
  paragraph/list breaks instead of collapsing into one run-on paragraph.

## [0.62.0] — 2026-07-09
### Added
- **Task detail is a shareable permalink.** Opening a task now updates the URL to `#/tasks/<id>`, and
  pasting that link opens the task straight away — the detail is addressable, so it can be shared in chat
  or bookmarked.
### Changed
- **Task detail opens in a modal** instead of a side panel — a focused, centered dialog over the board
  (closes on Esc / backdrop / ✕), so it reads the same from the board or the list view and there's room
  for the full body + activity.
- **Assignee icons come from the agent's own manifest icon** (not a generic 🤖) on cards, list rows, and
  the assign dropdowns — a task assigned to an agent shows that agent's icon; humans show a person glyph.
- **Surface task deadlines in the agent tool prose.** The `task_create` / `task_update` MCP tool
  descriptions now mention the `due` date (added in 0.60.0) in their headline text, not only the parameter
  schema — so an agent skimming the tools is prompted to attach a deadline to time-sensitive work and knows
  the owner is DMed once if it slips.

## [0.61.1] — 2026-07-09
### Fixed
- **Bash risk classification no longer reads the `description` field.** The enricher classified a
  `shell.exec` call's `destructive`/`risky` facts over the whole tool input — including the human-written
  `description` label. A read-only command whose description happened to mention a gated word (a `gh run
  list` described as *"Check deploy status"*, or a benign command whose note said *"rm -rf"*) was flagged
  and, on tenants that gate `risky`/`destructive` shell, funneled a needless approval to the owner (or was
  outright blocked). Shell calls now classify on the `command` only; connector calls still scan their input
  values (those are the effect). Regression-pinned in the governance conformance fixture.

## [0.61.0] — 2026-07-09
### Changed
- **Sessions now default to most-recently-active first.** The sessions list's default sort switched
  from newest-*created* to newest-*updated* (last status change), so the sessions you've most recently
  touched surface at the top. Still overridable per column, and the default stays omitted from the URL.

## [0.60.0] — 2026-07-09
### Added
- **Tasks board — a real board, not a form.** The Tasks page gains drag-and-drop between columns (drop a
  card to change its status), a **Board ⇄ List** view toggle (the list is sortable by priority / due date /
  updated), and a **filter bar**: My tasks / All, by assignee, by label, by priority, and an **Overdue**
  quick filter. Priority now shows as a colored left edge on each card, and the board **auto-refreshes**
  (~5s) so an agent closing its own loop moves the card without a manual reload.
- **Task due dates end-to-end.** A task can carry a soft deadline: set it on the create form or in the
  detail drawer (and via the `task_create`/`task_update` MCP tools with a `due` ISO date). Cards and list
  rows show a relative badge ("Due today", "3d overdue") with amber/red tone. When a task passes its
  deadline and is still open, the scheduler DMs its owner **once** on their linked Slack/Discord account
  (owner-less → owner/admins), audited `task.overdue` / `task.overdue.notified`.
- **Drawer polish.** The task body now renders as **markdown** and the title + body are **inline-editable**;
  assignees, owners, and activity authors show **real member names** (and agents by name) instead of raw
  ids; tasks can be assigned to **humans**, not only agents; and deleting a task now takes a **confirm**.

## [0.59.0] — 2026-07-08
### Added
- **Warm, resident Slack thread sessions — one session per thread, fast follow-ups.** A Slack thread now
  runs a single long-lived agent session kept alive between turns, instead of cold-starting a fresh
  `claude -p` (and a new Sessions row) for every reply. The first message spawns an interactive claude that
  stays warm; each follow-up is **delivered by typing into the running session** (tmux send-keys) — no
  reload of MCP servers / transcript, so replies come back fast. It stays **one row per thread** (no more
  new entry per reply), and the session is attachable from the console like any other. Unattended, so it
  runs with `--dangerously-skip-permissions` — the PreToolUse gate hook still governs every side effect.
- **Configurable idle keep-alive (default 30 min).** Settings → Integrations → "Keep Slack threads warm
  for N minutes". An idle reaper frees the held claude after the window; a later reply **revives the same
  row**, resuming the transcript (context preserved) and seeded with the new message. `0` disables
  residence (every reply cold-starts). Backed by new `term_sessions.resident` / `last_activity` columns.
- **Meaningful session titles for Slack/Discord threads.** A thread session is now titled from the first
  message (e.g. "why is pod X down?") instead of a generic "Chat → agent".
### Changed
- Thread continuity no longer spawns a per-reply run; `continueSlackThread` **delivers** to the live
  session or **revives** the reaped one. (Discord threads still cold-spawn per message for now.)

## [0.58.0] — 2026-07-08
### Added
- **Sessions grid view shows the last-updated time too.** Each card now displays its relative "updated
  N ago" next to who started it, matching the list view's Updated column (which was already there).

## [0.57.0] — 2026-07-08
### Added
- **Sessions list: an "Updated" column you can sort by.** Sessions now track a `updated_at` timestamp
  that bumps on every status transition (report / end / stop / resume / crash). The list view shows it
  as a relative "Updated" column (e.g. "3m ago") that's sortable like the others, so you can surface
  the most-recently-active runs, not just the newest-created. Persisted in the URL sort param; existing
  rows backfill to their creation time.

## [0.56.1] — 2026-07-08
### Changed
- **No "On it — continuing this thread" ack on a Slack thread follow-up.** The continuation's own
  `slack_reply` is the feedback; an "On it…" line before every answer was just noise in a back-and-forth.
  The `busy` note (message deferred while the agent is still working the previous turn) still posts, since
  there the user would otherwise see nothing.
- **In-app Slack manifest now includes the `message.*` events.** Settings → Integrations → the Slack setup
  manifest (and the create-from-manifest deep link) now requests `message.channels`/`message.groups`/
  `message.im`/`message.mpim` plus the matching `*:history` scopes (and `channels:read`/`channels:join`/
  `groups:read`/`im:write`) — so a **plain reply inside a thread** reaches the bot, not just @mentions.
  The setup copy now reminds you to invite the bot to the channel (`message.channels` only fires where it's
  a member). Existing apps: reinstall after adding the scopes/events.

## [0.56.0] — 2026-07-08
### Added
- **Sort the sessions list by column.** The list (table) view's column headings — Session, Agent, ID,
  Started by, Status — are now clickable to sort; clicking the active column flips ascending/
  descending (a caret shows which). The order applies to the grid view too, and, like the filters, is
  persisted in the URL hash (`?sort=agent&dir=asc`) so a refresh or shared link keeps it. Default stays
  newest-first; equal keys tie-break on recency.

## [0.55.0] — 2026-07-08
### Added
- **Sessions filters persist in the URL, and the list view gets column headings.** The Sessions
  filter state (search + status/agent/source/owner) is now written to the URL hash query
  (`#/sessions?q=…&status=…&owner=…`), so a refresh or a shared deep-link restores exactly what you
  were looking at; the hash router became query-aware and preserves filters when you open/close a
  session's terminal. The list (table) view also gained a **Session / Agent / ID / Started by /
  Status** heading row, aligned to the columns.

## [0.54.0] — 2026-07-08
### Added
- **Talk to an agent inside a Slack thread.** A follow-up message in a thread the bot already replied
  in now **continues the same conversation** instead of being treated as a brand-new trigger (which
  answered a plain "ok, now do X" with the `/agent` help list). The socket resolves the most recent
  session bound to that thread and spawns a continuation run that **resumes the same claude transcript**
  (`claude --resume`), so the agent keeps full context; its `slack_reply` lands back in the same thread.
  If the bound agent is still working the previous turn, the bot posts a short "still on it — I'll pick
  this up next" note and drops the duplicate (no overlapping runs on one thread).
### Changed
- Headless chat/automation runs now **pin their claude session id** (`--session-id`) so they can be
  resumed later — the backbone of the thread-continuity above. New `term_sessions.claude_session_id`
  column (NULL for older/non-claude runs, which fall back to a fresh spawn).
### Note
- Requires the Slack app to receive thread replies: subscribe to `message.channels` (and
  `message.groups`/`message.im`/`message.mpim` as needed) and keep the bot in the channel. `app_mention`
  alone only delivers explicit @mentions, not plain in-thread replies.

## [0.53.2] — 2026-07-08
### Fixed
- **Agent library modal now scrolls.** The catalog list overflowed the dialog instead of scrolling
  (the grid `DialogContent` clipped it with no bounded height on the list). Gave the list its own
  `max-h-[60vh] overflow-y-auto` so long catalogs scroll within the modal.

## [0.53.1] — 2026-07-08
### Changed
- **The agent library moved behind a button.** The Agents page no longer shows the library as an
  always-present section up top — it's now a **Library** button in the page's toolbar (and in the
  empty-state actions) that opens the catalog in a modal. Same install flow; less clutter on the
  primary "run an agent" surface.

## [0.53.0] — 2026-07-08
### Added
- **Filter the sessions list by owner.** The Sessions filter bar gained an **Owner** dropdown that
  narrows to the member a run acts as (run-as identity) — so you can see just your own sessions, or
  everything a given teammate's automations/tasks/chats spawned. Options are the distinct owners
  present (shown by name), and the dropdown only appears when more than one owner exists. Backed by a
  new `runAsLabel` on the session API (the run-as member's display name), which the search box now
  matches too.

## [0.52.0] — 2026-07-08
### Added
- **Agents get a "what you already know" head start.** New **Settings → Memory → Session preload**
  toggle (off by default): when on, each new session's system prompt is seeded with the agent's most
  salient memories (its own + tenant-shared, ranked by importance then recency-of-use, top N configurable
  1–25), so a cold run isn't blind instead of relying on it to call `recall`. Backed by a new
  `MemoryConfig.preload`; the preamble reads the local `memories` ledger directly and is best-effort
  (never blocks a launch), never leaks another agent's private memories.
- **Agents are told to self-improve.** The OS operating notes now teach the memory-vs-CLAUDE.md
  distinction: `remember` a per-task fact, `agent_update` your own standing instructions (CLAUDE.md) when
  a recurring gap in your setup shows up, and when to do both.
- **Native Slack/Discord steer.** When a workspace has native Slack/Discord configured, the prompt now
  tells the agent to reach for the built-in `slack_*`/`discord_*` tools first (they post as the company
  bot) and fall back to a Composio action only when no native tool covers the need — per-platform, only
  listed when actually configured.
### Changed
- **Every OS-owned MCP tool is now friction-free in interactive sessions.** `claude-launch.sh` pre-allowed
  only 17 of the 34 OS tools by name, so the rest (`revise`/`forget`/`update`/`check_inbox`/`schedule`/
  `agent_*`/`secret_*`/…) prompted for permission mid-task even though the gate hook already governs them.
  Replaced the partial list with the `mcp__agentos` server wildcard (covers present + future tools; real
  governance stays server-side).
- Brought the `discord_dm` tool description to parity with `slack_dm` (was a terse one-liner), and
  trimmed the `remember`/`kb_write` descriptions that duplicated the operating notes.
- New `npm run test:context` — an isolated harness asserting exactly what a session receives at launch
  (system prompt, MCP tool list + conditional gating, recall preamble scoping, the allow-list wildcard).

## [0.51.0] — 2026-07-08
### Added
- **An agent library you install from — and the built-in fleet is now data, not code.** A workspace
  ships with a browsable catalog of ready-made agents (`config/agents/`), the agent-side twin of the
  bundled skills catalog. Owners see an **Agent library** section on the Agents page and install an
  agent with one click — a copy into the data home, where it becomes a normal editable/tunable/deletable
  agent. The library is **distribution-only**: its entries are fixed by what ships (users install *from*
  it, not *into* it — a one-off agent still arrives via the bundle importer). New `src/edge/agent-catalog.ts`
  (`readAgentCatalog`/`installAgentFromCatalog`/`seedBuiltinAgents`), routes `GET /api/agents/catalog` +
  `POST /api/agents/catalog/:id/install` (owner/admin, audited `agent.installed`), and the `AgentLibrary`
  console section. Ships two install-on-demand agents (`sales`, `ops`) alongside the built-in five.
### Changed
- **The five built-in agents moved out of TypeScript into catalog data.** `agent-author`, `engineer`,
  `support`, `marketer`, `researcher` now live as `config/agents/<id>/{agent.json,CLAUDE.md}` instead of
  string literals in `src/edge/generalists.ts` / `src/edge/agent-author.ts` (both deleted). Boot seeds the
  built-in fleet from the catalog (`seedBuiltinAgents`) with the same contract as before — a fresh home is
  useful immediately, user edits survive, a deleted built-in is restored on the next boot — and no longer
  auto-registers `config/agents/` entries into the live fleet (they're install-on-demand); `rescanAgents`
  scans the data home only.
### Docs
- Plan for the agent library — `docs/agent-library-plan.md` (Phase 1 shipped).

## [0.50.0] — 2026-07-08
### Added
- **Filter the sessions list.** The Sessions page gained a filter bar — a free-text search (over
  title / agent / id / task / started-by) plus three dropdowns: **status** (All / Live / Done /
  Stopped / Crashed), **agent** (auto-derived from the sessions present), and **source** (Member /
  Automation / Task / Chat, read from each run's provenance). Filters apply client-side over the
  already-fetched list; the count reads "N of M sessions" while narrowed, a **Clear filters** button
  and a "no matches" empty state appear, and select-all / bulk stop+delete now act on the filtered
  view so a hidden row is never touched.

## [0.49.0] — 2026-07-08
### Added
- **Duplicate an installed skill.** Each skill in the library (Skills page) now has a **Duplicate**
  action next to Edit/Delete: it deep-copies the skill's folder (SKILL.md + any supporting files)
  under a new name, strips the managed/proposed markers, and rewrites the copy's frontmatter `name:`
  so it lists and invokes as `/newName`. Handy for forking a bundled or installed playbook before
  tweaking it. Assignments are **not** carried over — a copy defaults to all agents, like a fresh
  install. Owner/admin only; audited `skill.duplicated`. New store method `SkillsStore.duplicate` +
  route `POST /api/skills/:name/duplicate`.
### Docs
- Embed an architecture diagram at the top of `docs/ARCHITECTURE.md`.

## [0.48.0] — 2026-07-08
### Added
- **See what a finished headless run did — no more dead terminal.** A headless automation runs
  `claude -p` and exits, so its tmux pane is gone; opening the session later showed an empty, broken
  terminal even though the full transcript was already captured on disk (`claude-launch.sh` tee's it to
  `<home>/connectors/session-<id>.log`, 0600). The session view now detects an ended, non-resumable run
  (headless/crashed — interactive ended sessions stay resumable and keep the normal attach/resume path)
  and renders that captured transcript read-only instead of attaching a dead pane. New authz-gated
  `GET /api/sessions/:id/transcript` (same `canViewSession` check as attach; tails the last 512KB of a
  long run) + `api.sessionTranscript`.
### Changed
- **"Run Now" on a headless automation lands on the sessions list, not a terminal.** Firing a headless
  automation used to navigate straight into a terminal that dies moments later. It now refreshes and
  drops the operator on the Sessions list where the new run appears; interactive automations still open
  the attachable TUI as before. (Both paths already ran headless correctly — this is purely where the UI
  takes you afterward.)

## [0.47.0] — 2026-07-08
### Added
- **Files shortcut on the agent detail page.** An agent's page (`#/agents/<id>`) now has a **Files**
  button (next to the back-to-Agents link) that opens the Files browser scoped to that agent's folder
  (`#/files/agents/<id>`), so you can jump straight into its `agent.json`/`CLAUDE.md`/skills. Shown only
  for agents that live under the data home (`deletable`) — bundled examples live outside it and aren't
  browsable there; the existing deep-link fallback already drops to the home root for anything missing.

## [0.46.0] — 2026-07-08
### Added
- **One-shot agent import — the importer behind the "Import into AOS" doc.** The doc described a portable
  "AOS bundle" (`agent.json` + `CLAUDE.md` + `skills/` as files, `memory.jsonl` + `knowledge/` as
  replayable data) but shipped no importer — the operator was told to have the agent replay its own
  memory by hand. Now **Agents → Import bundle** (owner/admin) takes the whole `.zip` and reconstructs
  the agent in one step: writes + live-registers the agent folder, installs skills into the global
  library, and **replays** every memory line (`os.memory.store`, `"shared": true` → tenant-wide) and
  knowledge page (`os.kb.write`, authored as the agent) through the same stores an agent writes to.
  Bundle files may sit at the archive root or under a single `<agent-id>/` wrapper (both work). Recoverable
  issues (a malformed memory line, a name-clashing skill) become **warnings**, never a failed import;
  omitted manifest fields get safe defaults (`principal`/`policyContext`/`budget`). New pure parser
  `src/governance/bundle-import.ts` (reuses the skill uploader's zip + grouping), `POST /api/agents/import`
  (raw zip, `agent.imported` audited), and `api.importAgentBundle`. Doc updated to lead with the importer.
- **Upload a whole folder in the Files browser.** Alongside **Upload** (files), a new **Upload folder**
  button uses the OS folder picker (`webkitdirectory`) and recreates the folder's subtree under the
  current directory — `/api/files/upload` now accepts a `rel` (the file's `webkitRelativePath`) and
  `mkdir -p`s intermediate directories, with each path segment sanitised and re-checked against the data
  home (double-guarded against traversal, like every Files route).

## [0.45.0] — 2026-07-08
### Added
- **Agents can proactively DM anyone and post to any channel — Slack + Discord.** Until now the only
  outbound chat tools (`slack_reply`/`discord_reply`) posted back to the *triggering* thread, so an agent
  could only speak where it was spoken to. Four new native egress tools change that: `slack_send` /
  `discord_send` post to ANY channel, and `slack_dm` / `discord_dm` DM ANY person — off-thread and
  unattended (e.g. a cron automation posting a daily summary or nudging a teammate). Slack resolves a
  channel by **id or name** (auto-joining a public channel the bot isn't in on `not_in_channel`) and a
  recipient by **Slack user id or email** (`users.lookupByEmail`); Discord takes channel/user **ids**
  (no email lookup exists). Exposed to **any** session whenever that platform is configured
  (`SLACK_EGRESS`/`DISCORD_EGRESS`), not just chat-triggered ones. Audit-only posture — every send/DM is
  audited (`slack.send`/`slack.dm`/`discord.send`/`discord.dm`, plus `.failed`) but not policy-gated,
  matching `slack_reply`. New connector helpers (`lookupUserByEmail`/`lookupChannelByName`/`joinChannel`
  in `connectors/slack.ts`), `SlackSocket.sendToChannel`/`dmMember` + `DiscordSocket.sendToChannel`/
  `dmMember`, and session-secret-gated loopback routes `POST /api/agent/{slack,discord}/{send,dm}`.

## [0.44.1] — 2026-07-08
### Fixed
- **Creating a new agent now lands on the agents list with that agent selected**, instead of jumping
  straight into its edit/settings page. `NewAgentPage`'s `onCreated` navigates to `nav('agents', id)`
  (agents list, new agent highlighted via the URL detail param) rather than `openAgent(id)`.

## [0.44.0] — 2026-07-08
### Added
- **Custom governance patterns — teach the enricher your own dangerous ops, as config not code.** A
  workspace can now define `regex → boolean fact` rules (`EnrichPattern[]`) in Settings; the enricher
  applies them on every classify and sets the fact, and policy rules gate on it — so operator-specific
  red-lines (a prod-deploy path, a `suspend-user` CLI, a money-moving command, a "never send" reply)
  become **data**, keeping `enricher.ts` brand-free and open-core. Patterns carry a `scope`
  (`shell` | `connector` | `any`, default `any` = shell+connector; never `file.write`, whose haystack
  is file content). Backed by `SettingsStore.enrichPatterns()`/`setEnrichPatterns()` (invalid regex
  rejected at save; ignored at match — never throws in the gate) and owner-gated
  `GET/PUT /api/settings/enrich-patterns` (`settings.enrich_patterns.updated` audited). Wired into both
  terminal-gate `enrichArgs` call sites; read live per classify (hot, no restart). Unit-tested in
  `scripts/test-enrich-patterns.cjs`. (Console editor is a follow-up; set via the API meanwhile.)

## [0.43.0] — 2026-07-08
### Added
- **Agents can improve their own listing — reversibly.** An agent can now refine its OWN description,
  starter prompts, category, icon, runtime tuning, and CLAUDE.md system prompt via `agent_update`, inspect
  its edit history with `agent_history`, and roll back a bad self-edit with `agent_revert` (all self-only —
  the target is always the calling session's agent). This is the self-improvement loop: when an agent
  notices a recurring gap in its instructions, it can fix it, and the change takes effect on its next
  session. Safety is **reversibility, not an approval gate** (like the Knowledge Base): every edit — by the
  agent OR a human console edit — snapshots a full revision into a new `agent_revisions` table
  (`src/state/agent-revisions.ts`), so any change is auditable (`agent.config.updated` /
  `agent.config.reverted`) and one-click revertable from the console **agent page → Revision history**
  panel. Two new MCP tools (`agent_history`, `agent_revert`) → 33 always-on tools; new console routes
  `GET /api/agents/:id/revisions` + `POST /api/agents/:id/revert` (owner/admin).
### Changed
- **`agent_update` is now self-only.** It previously took the target agent id from the request body, so
  any agent could rewrite any other editable agent's prompt/tuning with no approval — a side effect that
  skipped the gate. The target is now always the calling session's agent (a supplied `id` must match it).
  Agents can still *create* other agents with `agent_create`; they just can't silently edit each other.
  Humans edit any agent from the console as before.

## [0.42.2] — 2026-07-08
### Fixed
- **Stop tracking the `node_modules` symlink (regression from 0.42.1) + harden `.gitignore`.** `scripts/wt.sh`
  symlinks `node_modules` into each worktree, and the `node_modules/` ignore pattern (trailing slash) matches
  only a *directory* — so the symlink slipped past the ignore and a `git add -A` committed it to the repo. Any
  checkout that pulled it had its real `node_modules` replaced by a self-referential symlink, breaking dependency
  resolution until `npm install`. Untracked the symlink (`git rm --cached node_modules`) and changed the ignore
  patterns for both worktree/deploy symlinks — `node_modules/` → `/node_modules` and (from 0.42.1) `data/` →
  `/data` — to name-only so a *symlink* is ignored too, not just a directory.

## [0.42.1] — 2026-07-08
### Fixed
- **Self-update no longer blocks on untracked files.** The updater flagged the tree "dirty" whenever
  `git status --porcelain` reported anything, including *untracked* files — but untracked files never
  break a `git pull --ff-only` (only modified tracked files do). On a live box that always includes the
  `data` home symlink, `*.log`, and stray docs, so the update button and the manual `wt.sh sync` deploy
  path both refused with "commit or stash them first" when nothing was actually in the way. The dirty
  check now passes `--untracked-files=no` (`hasTrackedChanges()` in `src/edge/updater.ts`); if an incoming
  commit ever collides with an untracked path, `git pull --ff-only` still aborts cleanly and we surface it.
- **`.gitignore` now ignores a `data` symlink at the repo root, not just a `data/` directory.** The deploy
  convention symlinks the data home (kept outside the checkout) in as `data`; the trailing-slash `data/`
  pattern only matched a directory, so the symlink showed as untracked and tripped the check above. Changed
  to `/data`.

## [0.42.0] — 2026-07-08
### Added
- **Next-fire timing on the Automations page.** Each cron automation now shows **when it fires next** —
  "next in 3h · <local time>" — computed by a new `nextCronRun(expr)` helper (`src/edge/automations.ts`,
  the forward companion to `cronMatches`: scans minute-by-minute from the next whole minute, null for an
  impossible expression like Feb 30) and surfaced as `nextRunAt` on the automation view. A disabled cron
  reads "paused — won't fire"; event triggers (webhook/slack/discord) read "fires on … — no schedule";
  last-fired is now the compact "last fired 2h ago".
### Changed
- **Automations UX: the New-automation form is collapsed behind a button.** The page led with a permanent
  form; now a **New automation** button sits in the Configured header and reveals the form on demand (with
  a Cancel, and auto-collapse on create), so the page opens on the list of what's configured — the runs,
  schedules, and next-fire timings — instead of an empty form.

## [0.41.0] — 2026-07-08
### Added
- **Automation Runs — see every time an automation fired.** Each automation card on the Automations page
  grows a **Runs** toggle that lists the sessions that automation has spawned, newest first — status dot
  (live / done / stopped / crashed), timestamp, and the run-as/provenance label, each row one click into
  its session terminal. Backed by a new `GET /api/automations/:id/runs` route (`tm.listRunsFor` filters
  `listSessions` by provenance `automation:<id>`, so runs carry live status + the same per-viewer
  visibility as `/api/sessions`: owner/admin see all, a member sees runs of automations they can view).
  Closes the gap where an automation's history lived only in the audit log — the automation row still
  tracks just `lastFiredAt`/`lastSessionId`; the full run list is now reconstructed from the session rows
  that carry the `automation:<id>` provenance.
### Added
- **"Always approve" — teach policy from the inbox.** An approval card grows an owner-only **Always**
  button next to Approve/Reject: it approves the current attempt **and** writes a persistent `allow` rule
  for that capability into the policy override (`POST /api/approvals/:id/always`, hot-reloaded), so future
  matching attempts pass the gate without a card. The inbox becomes the policy-authoring surface — the
  place to codify "we've decided this is fine." Safety is by rule **placement**: since `classify` is
  first-match and the deny guardrails are conditional `never` rules (`destructive` / over-`$moneyCapUsd` /
  bulk-delete), the new allow is inserted **after** all `never` rules, so a routine attempt stops
  prompting while a destructive or over-cap attempt of the same capability **still denies**. Owner-only
  (adding a rule is a policy edit, same guard as `PUT /api/policy`); refuses to shadow an unconditional
  `never` (approves once, doesn't add the rule); idempotent; audited `policy.rule.added` + `policy.updated`.
  New `withAlwaysAllow`/`hasHardDeny` helpers in `src/governance/policy.ts`.
- **`docs/inbox-plan.md`** — the standing inbox audit: the spine, ranked gaps with status, the
  "Always approve" safety design, and the batch roadmap.

## [0.39.0] — 2026-07-08
### Added
- **Questions ping the human out-of-band.** When an agent `ask`s a question it no longer sits silently in
  the console until its ~1h poll times out: a new **question notifier** DMs the person the run acts for
  (its `run_as`, else the spawning member; a pure automation falls back to owner/admins) on their linked
  Slack/Discord account — the question-side twin of the existing approval notifier. Audited `question.notified`.
- **The chat loop closes.** A Slack/Discord-triggered run now mirrors its **completion, questions, and
  approval gates back into the thread it was triggered from**, instead of only the console Inbox — the
  person who @mentioned the agent sees the outcome where they asked. Best-effort via a new `chatMirror`
  sink over the existing `slack_threads`/`discord_threads` bindings; a no-op for non-chat runs. The agent's
  own `slack_reply`/`discord_reply` still work for finer replies.
### Changed
- **Inbox read + dismiss are now per-member.** The feed is shared (every owner/admin sees the same rows),
  so a single `dismissed_at` column meant one admin dismissing an item hid it for everyone, and unread was
  a browser-local `localStorage` timestamp that didn't sync across a member's devices. Both now live in a
  new `message_state(message_id, member_id, read_at, dismissed_at)` join keyed to the viewer: each member
  has their own read-line and dismissed set, server-backed. Legacy global `messages.dismissed_at` is still
  honored as a dismissed-for-all fallback. New routes `POST /api/messages/:id/read` and `/api/messages/read-all`.

## [0.38.0] — 2026-07-08
### Added
- **Files shortcut from a session.** The live terminal's top-right toolbar grows a **Files** button next to
  "Attach image": it jumps to the Files browser opened straight at the running agent's own folder
  (`agents/<id>`) — a one-click way to inspect what the agent is reading and writing. `FilesPage` now honours
  a deep link (`#/files/<path>`) and falls back to the home root (with a hint) when the folder isn't under
  the data home (e.g. a bundled agent).

## [0.37.0] — 2026-07-08
### Added
- **Procedural skills — the fleet drafts its own skills (`skill_propose`, Lever 6 of the learning loop).**
  Agents (and the consolidation gardener) can now propose a reusable **skill** — a multi-step playbook —
  the same way they `remember` a fact or keep a `report` lesson, closing the episodic→procedural gap. A
  new always-on `skill_propose` MCP tool drafts the skill into the library flagged **`.aos-proposed`**:
  it's a real, editable skill folder that `materialize()` deliberately **skips**, so it is invisible to
  every agent until a human publishes it. Each proposal posts a **`skill.proposed` card to the owner/admin
  Inbox** (violet, "review in Skills") and audits `skill.proposed`. The console **Skills** page grows a
  **"Proposed by self-learning"** section — Review (opens the draft in an editor, editable), **Publish**
  (drops the marker → materialises to agents next session; `POST /api/skills/:name/publish`, owner/admin,
  audited `skill.published`), or **Dismiss** (deletes the draft; audited `skill.proposal.dismissed`).
  Human-gated only — nothing an agent proposes changes how the fleet works without a person's ok, and the
  PreToolUse gate still governs every effect a published skill drives. Operating-notes + gardener remit
  updated to encode procedures as skills (vs facts as memories/KB). See `docs/procedural-skills-plan.md`.

## [0.36.0] — 2026-07-08
### Added
- **Files → New file.** The Files browser grows a **New file** button beside "New folder": it prompts for a
  name, creates an empty file in the current folder, and opens it straight into the editor. Backed by a new
  `POST /api/files/create` route that refuses to clobber an existing path (`409`) and audits `file.created`
  (the existing `/api/files/write` still declines to create files, so this is the dedicated create path).

## [0.35.0] — 2026-07-08
### Added
- **Agents can share credentials through the secrets vault — without the value ever touching a durable
  plane.** Three new always-on MCP tools give the fleet an A2A credential-handoff path: `secret_put`
  stores a password / API key / token in the vault under a KEY, `secret_get` fetches it back read-once,
  and `secret_list` shows the available keys (metadata only). Agents pass the key **name** to each other
  (in a task, message, or report) and never the raw value. Design invariant: the plaintext lives only in
  the encrypted vault row and the live `secret_get` response — it is deliberately kept out of the audit
  trail, the approval card, and the policy args (all of which persist), so a secret can't leak through the
  governance planes. Storing is **approval-gated**: `secret.put` classifies as `ask`/admin in the default
  policy and blocks the call until a human approves (auto-cleared when an owner/admin is already attending
  the run, per governance P5). Reads are allow+audit (a workspace can tighten a specific key to `deny`).
  Scope is **shared/tenant-wide** (any agent can read a stored key) — the pragmatic choice for a trusted
  fleet; agent-written keys surface on the console **Secrets** page stamped `updated_by = agent:<id>` for
  human oversight/rotation. Backed by `TerminalManager.putSecret/getSecret/listSecrets` +
  `/api/agent/secret/{put,get,list}` loopback routes (session-secret gated). Not yet done: generic
  cross-plane redaction (scrubbing a value out of memory/KB/inbox if an agent ignores the read-once
  guidance) — tracked as a follow-up.

## [0.34.1] — 2026-07-08
### Changed
- **Settings → Integrations: one Composio card.** The separate "Composio API key" and "Composio webhook
  secret" cards are merged into a single **Composio** card (matching how the Slack/Discord cards already
  group an integration's credentials): API key + optional webhook secret as two fields under one intro,
  a single Save, and per-credential Remove links (they stay independent — connectors work without a webhook).
### Fixed
- **Connectors page links now deep-link to the right settings tab.** The native chat-bot (Slack/Discord)
  row's "Settings" link and the Secrets-vault reference pointed at the bare `#/settings` (landing on Company
  context); they now open `#/settings/integrations` and `#/settings/secrets` respectively.

## [0.34.0] — 2026-07-08
### Added
- **Session activity — see which agent-os primitives a run used, visually.** Every session card (grid +
  list) grows an **Activity** button that opens a modal timeline built from the run's audit stream:
  grouped counts (`Bash ×12 · remember ×3 · ask ×1 · report ×1`) over a chronological feed, each event
  classified into its OS plane (governed action · operator · memory · knowledge · tasks · scheduling ·
  agents · approval) with the gate's `allow`/`approve`/`deny` verdict shown as a badge. Backed by a new
  `GET /api/sessions/:id/activity` route (gated by `canViewSession`, so a member sees the activity of the
  runs they can attach to — not just owner/admin). Classification lives in a pure, testable
  `src/state/session-activity.ts`; session plumbing (lifecycle, paired gate halves, secret/skill
  materialisation) is filtered out so the feed reads as intent, and the one un-audited primitive
  (progress `update`s) is folded in from the inbox so the timeline is complete. Read-only tools (`recall`,
  searches, inbox checks) leave no audit trace and so don't appear — called out in the empty state.

## [0.33.0] — 2026-07-08
### Added
- **Docs: "Import into AOS" console page** — a master-prompt guide for bringing an agent over from
  another system (raw Claude Code project, CrewAI/LangGraph, a folder of prompts) by emitting a
  file-based bundle that mirrors how AOS stores agents, so the manifest/instructions/skills need no
  importer. Wired into the Docs section (`web/src/docs`).

## [0.32.2] — 2026-07-07
### Fixed
- **`agent-os tenant remove` now respects `AGENT_OS_TENANT`.** The remove guard (and the login-URL
  branch) compared the slug against `cfg.tenant` only, while `TenantRegistry` resolves the default/apex as
  `AGENT_OS_TENANT || cfg.tenant`. In a process-per-tenant deployment that overrides the seed (e.g.
  `AGENT_OS_TENANT=initech` with a config default of `northwind`), this got it backwards: the CLI
  refused to remove the stale config-default tenant and would have guarded the wrong (real apex) one. Both
  now resolve the default the same way as the registry.

## [0.32.1] — 2026-07-07
### Fixed
- **Browser terminal: auto-reconnect instead of dying on a dropped WebSocket.** ttyd was launched with
  `disableReconnect=true` (both the per-tenant shared terminal and the Phase-A per-member terminal), so a
  transient WebSocket blip — laptop sleep, a network hiccup, or CPU starvation on a small box — blanked the
  terminal permanently until a full page reload, which reads as "the session got killed" even though the
  tmux-backed agent keeps running. Now reconnect is enabled and ttyd sends a keepalive ping every 30s, so
  the terminal re-attaches to the live session after a blip (the backend already supports resuming claude
  in-place on reconnect).

## [0.32.0] — 2026-07-07

### Added
- **Duplicate an agent — deep-copy a definition under a new id.** The Agents page gains a **Copy**
  action (owner/admin, any claude-code agent) that clones the whole agent folder (`agent.json` +
  `CLAUDE.md` + any sibling files) into `<home>/agents/<new-id>/`, rewriting `id`/`principal` from
  the authoritative in-memory manifest. The clone is a **fresh** agent with its own id, so none of
  the source's runtime history rides along (no memories, sessions, assignments, automations, skill
  scoping, artifacts, audit) — which is exactly why duplicate is the safe answer to "rename an
  agent" (a new id owns new references instead of orphaning the old ones). The **source** may be a
  read-only bundled example — a clean way to customise a built-in — while only the **destination**
  must live under the data home. New `POST /api/agents/:id/duplicate` route (admin-gated), audited
  as `agent.duplicated`.

## [0.31.0] — 2026-07-07

### Added
- **Agents now see the team roster in their prompt — the human counterpart of the fleet roster.** Every
  session's company context gains a **"Your team — the people in this workspace"** block listing each
  member's name, role (owner/admin/member → who can approve what), email, and any linked Slack/Discord
  identities, so an agent can loop in the right person via `ask` without a `directory_lookup` round-trip.
  Capped at 30 members — past that it stays tool-only (a one-line pointer to `directory_lookup`) so a
  large org doesn't bloat every prompt. Mirrors the agent-roster injection from v0.29.0.

## [0.30.0] — 2026-07-07

### Added
- **Cron automations now offer schedule presets — no cron expression required.** The New-automation
  **Schedule** field is a dropdown of common cadences (every 15/30 min, hourly, every 6h, daily at
  midnight/9 AM, weekdays at 9 AM, Mondays, first of the month), with a **Custom cron expression…**
  option that reveals the raw 5-field input for advanced schedules. The backend is unchanged — each
  preset just sets the same cron string, still validated by `parseCron()`.

### Fixed
- **Dropdowns now show the selected option's label, not its raw value.** Base UI's `Select.Value`
  renders the underlying value unless the root is given an `items` (value → label) map, so any select
  whose value differed from its label (Trigger showed `cron` instead of *Schedule (cron)*; Priority,
  Assignee, Run-mode, and the Audit type filter likewise) displayed the wrong text in the collapsed
  trigger. Added `items` maps across the affected selects in the console.

## [0.29.2] — 2026-07-07

### Added
- **Docs: a dedicated "Automations" page in the in-console Docs section.** The `/#/docs` guide now
  has a full Automations page (between "Working with agents" and "Governance & approvals") covering the
  five triggers (cron/webhook/Composio/Slack/Discord), how an automated run stays governed (provenance
  vs. run-as, approvals still pause it), headless vs. interactive execution + the pile-up guard, the
  no-automation-needed chat router, agent self-scheduling, and agent→agent delegation via auto-dispatch
  tasks. Previously Automations only got a one-line mention in Core concepts and Working with agents.

## [0.29.1] — 2026-07-07

### Fixed
- **Docs sub-pages are now URL-addressable (`#/docs/<slug>`).** The console **Docs** page tracked the
  open manual page in local state, so `#/docs` always reset to the first page and a refresh or shared
  link lost the selection. It now reads/writes the hash router's detail segment (like Agents and
  Settings), so each page has its own URL (`#/docs/governance`, `#/docs/getting-started`, …) that
  survives a reload and can be linked directly.

## [0.29.0] — 2026-07-07

### Added
- **Agent discovery + delegation wiring — the fleet can hand work to the right peer instead of guessing.**
  A new `list_agents` MCP tool (backed by `GET /api/agent/roster`) returns the other claude-code agents
  in the workspace (id, description, category) so an agent can pick the right specialist to delegate to;
  every session's company context now injects a **"Your fleet — who you can delegate to"** roster with
  the `task_create({ assignee: "agent:<id>", autoDispatch: true })` hand-off pattern; and `task_create`
  now **rejects an `agent:<id>` assignee that doesn't exist** (returning the valid roster) instead of
  silently filing an inert task that never dispatches. Motivated by a 36-run primitive-use eval where
  agents, told to hand work off, filed unassigned tasks (5/6) or shelled out to the filesystem to
  discover peers; with this change delegation goes from 1/6 to 6/6 agents producing a dispatchable
  hand-off, with no regression on the other primitives.

## [0.28.0] — 2026-07-07

### Fixed
- **Magic-link invites no longer die with "invalid or expired" before the invitee clicks.** `GET
  /accept` was a one-time token *consumer*, so any link preview / unfurl / mail-security scanner
  (Slack, WhatsApp, Outlook Safe-Links, Gmail's proxy, corporate gateways) that fetched the URL burned
  the token first — the human then landed on "invalid or expired". `/accept` is now a two-step landing:
  the **GET only peeks** and renders a "Continue" confirm page (no side effect), and the token is
  consumed only by the **POST** the button fires — which bots don't do. One-time, single-use semantics
  are preserved; the interstitial is self-contained and theme-aware so it works before the session
  exists. (`TeamStore.peekToken`, `acceptLandingHtml`.)

### Changed
- **Team page redesign + per-person agent assignment for any member.** Agent access previously showed
  individual chips only for plain `member`-role people, so a team of all-admins saw no way to scope
  agents — "can't assign individually". The redesigned **Agent access** section now lists every member
  per agent: owners/admins render as static *full-access* pills (they run everything by role), plain
  members are individually toggleable, and an **All members** toggle opens an agent to everyone. Each
  agent shows a one-line "who can run this" summary. The page also gains a roles legend and tidied
  member cards.

### Added
- **`scripts/wt.sh` — the git-worktree workflow for this shared checkout** (dev tooling; no runtime
  change). Multiple Claude sessions edit this one checkout concurrently and clobber each other; the
  helper keeps the primary checkout clean on `main` and moves all development into per-session
  worktrees under `~/aos-wt/<name>` (`new`/`list`/`sync`/`integrate`/`done`). Finished branches are
  batch-merged in a fresh `batch/<ts>` worktree and shipped as **one consolidated PR**. Documented in
  CLAUDE.md → "Multi-session development (git worktrees)".

## [0.27.1] — 2026-07-07

### Changed
- **The agent chooser defaults to the list (split) view** instead of the gallery — the compact
  list-rail + detail layout is the quicker default for picking an agent. The gallery is still one
  toggle away and the choice persists.
- **In the gallery view the task composer now docks to the bottom of the viewport** once the cards
  overflow, so it stays reachable without scrolling past every card. It's clamped to its container, so
  a short fleet shows the composer right under the cards with no gap.

## [0.27.0] — 2026-07-07

### Changed
- **Reimagined the agent chooser with two switchable layouts.** The single dropdown is replaced by a
  picker you can flip between a **gallery** (a responsive grid of agent cards, each with icon, name,
  runtime + built-in badges, and a two-line description) and a **split** view (a grouped, scrollable
  list rail on the left, the selected agent's detail + task composer on the right). The layout choice
  persists across visits, and a **search box** (id / description / category) appears once the fleet
  grows past a glance. The task composer, starter-prompt chips, and per-agent Edit/Delete actions are
  shared by both layouts.
- **The agent chooser now labels built-in agents.** Every agent that ships with Agent OS — the
  department generalists (engineer/support/marketer/researcher), the agent-author, and the
  consolidator — carries a **"built-in"** badge, so it reads apart from agents the team authored.
  Built-in is derived by id server-side (`builtIn` on the agents API), which also flags homes
  provisioned before the badge existed, since those agents materialise under the user's agents folder
  and can't be told apart by path.
- **The selected agent keeps its icon + badges.** The old dropdown used Radix `<SelectValue/>`, which
  mirrors only the item's plain text, so the runtime ("claude") and icon vanished the moment you
  picked an agent. The redesigned picker renders the selected agent's icon, name, runtime, and
  built-in badge directly in its detail header.

## [0.26.0] — 2026-07-07

### Changed
- **The open session's title leads the console header.** When you're in a terminal, the page header
  now shows that session's title (truncated to fit) instead of the generic "Sessions" — so you can tell
  which run you're looking at at a glance. The redundant "All sessions" back button *inside* the terminal
  view is removed, since the header already pins one next to the title.

## [0.25.0] — 2026-07-07

### Added
- **Backend-switch reconcile — Phase 2: at-switch prompt + batched migration.** Changing the memory
  backend (Settings → Memory) now pops an **interstitial** the moment you save, when the switch leaves
  local memories the new store lacks — Migrate / Start fresh / Later — instead of relying only on the
  passive drift banner. And migration is now **batched**: `POST /api/settings/memory/migrate` moves one
  batch per call over a fixed `before` horizon (rows created *strictly before* the run; the mirror's
  re-inserts land after it and are never re-picked, even on a same-millisecond store), returning
  `{ migrated, skipped, remaining, done }`; the console loops it with a live *"N moved, M left"* count so
  a large ledger never blocks a single request, and a failed batch is safely resumable (rows stay put).
  The idempotency guard (no-op when already consistent) and the "durable only — skip episodes" filter
  carry over. See `docs/memory-backend-migration-plan.md`.

## [0.24.0] — 2026-07-07

### Added
- **Backend-switch migrate-or-clear** (Settings → Memory). Switching to an external memory backend
  (automem/libsql) leaves the pre-switch memories in the local ledger but not in the new store — the
  Memory-hub counts then overstate what agents can actually recall. Settings → Memory now detects this
  **drift** (local rows vs. active backend count) and shows a banner with two actions: **Migrate** —
  replay the local ledger into the new store (preserving author/scope/tags/type/importance/metadata),
  with an opt-in *"durable only — skip raw episodes"* filter, then drop the migrated-out originals; and
  **Clear** — empty the local ledger to match a fresh start. Migrate is idempotent (no-ops when already
  consistent, so it can't duplicate) and gated (a partial migration deletes nothing). New endpoints
  `POST /api/settings/memory/migrate` + `/clear`, a `count()` probe on the memory providers, and
  `memory.migrated`/`memory.cleared` audit events. See `docs/memory-backend-migration-plan.md`.

## [0.23.0] — 2026-07-07

### Changed
- **Session lists tidy away ended runs.** The terminal switcher bar and the sidebar "Sessions" list
  now keep live sessions pinned and collapse stopped/done/crashed ones behind a **"N ended"** toggle,
  so a workspace full of past runs no longer buries the ones you're actually working in. The currently
  open session always stays visible even after it ends (with its Resume affordance intact), and a new
  **All sessions** button sits next to the page title while a terminal is open, giving a second one-click
  way back to the full list.

## [0.22.0] — 2026-07-07

### Added
- **Per-agent / workspace permission mode is a knob again — default `auto`.** `RuntimeTuning` gains a
  `permissionMode` field (`auto`/`plan`/`acceptEdits`/`manual`/`dontAsk`/`bypassPermissions`, the exact
  set the CLI accepts), settable per-agent (agent.json) with a workspace fallback (Settings → Runtime
  defaults) and exposed in the console's runtime-tuning fields. `claude-launch.sh` maps it to
  `--permission-mode` on the **interactive lane only** — the headless/automation lane keeps
  `--dangerously-skip-permissions` untouched. It does **not** weaken governance or enable the OS
  sandbox (a separate, still-off switch): for `Bash`/`Edit`/`Write`/`mcp__*` the PreToolUse gate hook
  still returns an authoritative decision that bypasses Claude's own permission engine, so the mode
  only governs the *fallback* for tools the hook leaves alone (Read/WebFetch/…). `auto` lets Claude's
  classifier auto-approve the safe ones instead of hanging an idle tmux pane on a native prompt no one
  answers. Unset resolves to `auto` at every level (including resumes of pre-knob sessions).

## [0.21.0] — 2026-07-07

### Added
- **External memory backends no longer break the self-learning loop** (prep for adopting AutoMem).
  Dreaming, the consolidation gardener, and the Memory-hub overview counts read the local SQLite
  `memories` table directly, so switching a tenant to an external store (automem/libsql) would have
  left those readers empty. A new `MirroredMemoryProvider` (`src/memory/mirror.ts`) now wraps any
  non-SQLite backend and copies every write into the local table — recall still goes to the upgraded
  store, but the learning loop and counts keep working. The SQLite default is unchanged (it *is* the
  table, so it's never wrapped). Also **implemented tenant/shared scope in the automem provider** (the
  deferred Phase-0 follow-up): `scope:'tenant'` memories are tagged and recalled workspace-wide, with
  author provenance recovered from the `agent:` tag — so shared knowledge and cross-agent recall work
  on automem. Prerequisite for piloting automem on a tenant; no behavior change for SQLite tenants.

## [0.20.0] — 2026-07-07

### Added
- **Built-in department generalists — a starter fleet every workspace boots with.** Four
  code-provisioned agents (`engineer`, `support`, `marketer`, `researcher`) are now materialised into
  every data home on boot the same idempotent way as the `agent-author` — an isolated
  `<home>/agents/<id>/{agent.json,CLAUDE.md}` folder, grouped under its department category
  (Engineering / Support / Marketing / Research). Each is a broad "do-anything within this function"
  generalist (not a narrow single-task bot — the agent-author spins those up on demand), so a fresh
  home is useful immediately without hand-authoring a manifest. User edits to either file are
  preserved (written only when absent); delete a folder and boot restores it
  ([`src/edge/generalists.ts`](src/edge/generalists.ts), wired in
  [`src/kernel.ts`](src/kernel.ts)).

### Fixed
- **First interactive launch no longer shows the "Do you trust the files in this folder?" dialog.**
  Freshly-created agent folders had never been trusted, so an interactive claude opened with the
  workspace-trust prompt (headless already dodged it via `--dangerously-skip-permissions`). The
  launcher now pre-seeds the per-directory trust flag
  (`~/.claude.json` → `projects["<AGENT_DIR>"].hasTrustDialogAccepted`) keyed off the real `$HOME` of
  whatever lane/user runs the session — idempotent (writes only on an agent's first launch), atomic
  (temp + rename), and never fatal to launch. This suppresses only the one-time trust gate; the
  PreToolUse gate hook and deny rules still govern every effect, so the security posture is unchanged
  ([`terminal/claude-launch.sh`](terminal/claude-launch.sh)).

## [0.19.1] — 2026-07-07

### Fixed
- **Self-update no longer fails with `sh: tsc: not found` on a production box.** The in-console updater's
  `npm install` inherited the service environment — and the systemd/launchd units run with
  `NODE_ENV=production`, which makes npm **omit devDependencies**. Since `typescript` (the `tsc` the build
  step needs) is a devDependency, the very next `npm run build` had no compiler and the update aborted at
  "server build failed". Both the server and web installs now pass `--include=dev` so the build always has
  its toolchain regardless of `NODE_ENV` ([`src/edge/updater.ts`](src/edge/updater.ts)).

## [0.19.0] — 2026-07-07

### Added
- **The Agents page remembers where you were.** Extending the URL-routing work: the picked agent is now
  a hash detail (`#/agents/<id>`) so a **refresh keeps the selected agent** — and a bare `#/agents`
  restores the **last agent you used** (remembered in `localStorage` across visits) instead of always
  resetting to the first. The task box is also **draft-persisted per agent**: whatever you'd typed is
  saved as you type and **restored after an accidental refresh**, then cleared on a successful spawn
  (falling back to the agent's starter prompt when there's no draft). The agent **editor** deep-links
  too (`#/agent/<id>`), fixing a blank page on refresh ([`web/src/App.tsx`](web/src/App.tsx)).
## [0.18.1] — 2026-07-07

### Fixed
- **Stale `package-lock.json` no longer dirties every box's working tree.** The committed lockfile
  still pinned `@libsql/client` (the opt-in native-vectors memory provider) at its root `dependencies`,
  even though `package.json` had dropped it to make it opt-in. Any box running `npm install` reconciled
  the lock down to match `package.json`, leaving the tree dirty and **blocking the self-update's
  fast-forward pull**. Regenerated the lockfile so it matches `package.json` — installs are now a no-op
  against a clean tree.

## [0.18.0] — 2026-07-07

### Added
- **Settings sub-tab is deep-linkable (`#/settings/<tab>`).** Continuing the URL-routing work from
  v0.16.0, the active Settings sub-tab (Company context, Runtime defaults, Integrations, Secrets,
  Memory backend, Governance, Policy, System) is now a hash detail segment instead of local component
  state — a **refresh or shared link lands on the same tab** instead of resetting to Company context.
  `SettingsPage` resolves the tab from the URL against a shared `SETTINGS_TABS` list and writes it back
  via `nav('settings', tab)` ([`web/src/App.tsx`](web/src/App.tsx)).

## [0.17.0] — 2026-07-07

### Changed
- **Default policy super-simplified — local work runs freely, only outward/irreversible effects pause.**
  The old default gated `file.write` whenever the target sat outside the agent's *home folder*
  (`outsideWorkdir`). But coding agents almost never edit inside their home dir — they clone repos and
  work in git worktrees under `/tmp`, `~/code`, etc. So `outsideWorkdir` was `true` for essentially all
  real work, and the `file.write outsideWorkdir → ask` rule fired an approval prompt on *every single
  edit* (observed live in session `1603ccea`: a worktree at `/tmp/feat-umami-1click` triggered a `head`
  approval on each `Edit`). The new [`config/policy/default.policy.json`](config/policy/default.policy.json)
  (`default@v2`) keeps only the guardrails that carry real weight — **never**: destructive ops, spend over
  `$moneyCapUsd`, bulk deletes over `$bulkDeleteCount`; **ask**: external email, granting a new OAuth
  connection (`connector.connect`) — and **allows everything else** (all file writes anywhere, shell,
  connector calls; `default` flips from `ask` to `allow`). A local, reversible file edit is not a side
  effect "on the world," so it no longer interrupts. Existing tenants with a saved policy override keep it
  until re-saved from Settings → Governance (or replaced on disk).

### Fixed
- **Task/chat-triggered sessions now show in their owner's sidebar.** The left "my sessions" switcher
  keyed only off `spawnedBy === me.id`, so a session an auto-dispatched **Task** (or a chat message)
  spawned — whose provenance is `task:<id>`/`automation:<id>` but which *runs as* the owning member —
  was hidden from that member's sidebar even though they own it. The session DTO now carries **`runAs`**
  ([`src/terminal.ts`](src/terminal.ts), [`web/src/lib/api.ts`](web/src/lib/api.ts)) and the sidebar
  includes sessions where `spawnedBy === me.id` **or** `runAs === me.id`
  ([`web/src/App.tsx`](web/src/App.tsx)) — matching the run-as visibility rule the inbox already used.

## [0.16.0] — 2026-07-07

### Added
- **Deep-linkable pages — the open terminal now lives in the URL.** The hash router gained an optional
  detail segment (`#/sessions/<tmux>`): opening a session terminal pushes its id into the address bar,
  so a **refresh or back/forward reopens the same terminal** instead of dropping you back on the list.
  `selected` is now derived from the URL (single source of truth) rather than component state
  ([`web/src/App.tsx`](web/src/App.tsx)) — the foundation other pages' selections can reuse.
- **GitHub App token minter (foundation for native GitHub).** New zero-dependency connector
  ([`src/connectors/github.ts`](src/connectors/github.ts)) that signs a short-lived App JWT (RS256, via
  `node:crypto`) and exchanges it for a **1 h installation access token** — the single credential that
  will drive both the shell (`GH_TOKEN` for `gh`/`git`) and a governed GitHub MCP connector, so a user
  connects GitHub once in the browser instead of pasting a static PAT. Includes `appJwt`,
  `listInstallations`, `mintInstallationToken` (optional repo/permission narrowing for least-privilege)
  and an in-memory `InstallationTokenCache` (reuse until ~5 min before expiry). Not wired into launch
  yet — see [`docs/github-integration-plan.md`](docs/github-integration-plan.md) for the phased plan
  (mint-at-launch injection + Settings → Integrations install flow land next).

### Fixed
- **The Audit page survives a refresh.** `audit` was missing from the hash router's allow-list, so a
  reload of `#/audit` silently fell back to Inbox; the router now validates against the full `ROUTES`
  set ([`web/src/App.tsx`](web/src/App.tsx)).

## [0.15.1] — 2026-07-07

### Fixed
- **Clicking in a live terminal clears its waiting bell.** Previously a session's "needs you"
  alert only cleared when you *opened* the session; a new alert raised while you were already
  watching it stuck around. Now any click **inside the terminal** (or on the console chrome around
  it) dismisses that session's open notification, matching the mental model that interacting with a
  session means you're attending to it. The click is caught on the same-origin ttyd iframe's own
  document (clicks there don't bubble to our page), passive + capture so xterm's selection is
  untouched ([`web/src/App.tsx`](web/src/App.tsx)).

## [0.15.0] — 2026-07-06

### Added
- **Status line: current folder + weekly usage limit.** The session bar
  ([`terminal/statusline.js`](terminal/statusline.js)) gains two segments: the current working
  **folder** (compacted — `~` for `$HOME`, collapsed to the last two path segments when deep) and the
  **weekly usage limit** (`wk 41%`, color-graded green→yellow→red) from Claude's `rate_limits.seven_day`.
  Both skip silently when absent — the folder when there's no cwd, the weekly meter for non-Pro/Max
  accounts or before the first API response of a session.

## [0.14.0] — 2026-07-06

### Added
- **Session status line (info bar in every governed claude TUI).** Each interactive agent session now
  renders a persistent bottom bar via Claude Code's native `statusLine` — a zero-dependency Node
  renderer ([`terminal/statusline.js`](terminal/statusline.js)) wired in by `claude-launch.sh`. It
  blends Claude's live session JSON (model·effort, a context-window usage bar, session cost, diff
  churn) with the two signals only Agent OS knows: **which human identity the run acts as** and **how
  many approvals it's blocked on** (`⏸ N waiting`), pulled from a new session-secret-gated loopback
  route [`GET /api/agent/status`](src/server.ts) (pending approvals for the run + run-as name). Polled
  on a 5 s refresh so the "waiting" indicator stays live while a gate is suspended; the governance
  fetch is best-effort with a tight timeout, so an old/slow server just drops to the local metrics.
  Inspired by [ccstatusline](https://github.com/sirmalloc/ccstatusline), built on the same underlying
  Claude Code mechanism rather than vendoring the tool.

## [0.13.0] — 2026-07-06

### Added
- **Agent operating notes: fleet-coordination section + a read-only viewer in Settings → System.** The
  OS-owned orientation appended to every claude-code agent's system prompt
  ([`AGENT_OS_OPERATING_NOTES`](src/terminal.ts)) gains a **"You are one agent in a fleet"** section, so
  agents stop treating the shared planes as isolated tools and understand how to coordinate: **Tasks**
  (`task_*`) as the shared work queue + hand-off path (delegate specialist work by assigning a task),
  the **Knowledge Base** (`kb_*`) as the fleet's shared living wiki, **shared memory**
  (`remember` with `shared: true`) for fleet-wide facts, and `directory_lookup` for reaching teammates.
  The notes were previously invisible — hardcoded in source, in no UI. They're now surfaced **read-only**
  in **Settings → System** (the constant is exported, rides the existing `/api/state` payload, and
  renders in a read-only textarea beside Company context) so operators can see exactly what the whole
  fleet is told about running inside Agent OS. Company context stays the tenant-editable half; these
  notes stay OS-owned.

### Added
- **Per-agent shell secrets — vault credentials that reach the agent's terminal.** An agent manifest
  can now carry an opt-in `shellSecrets: ["GH_TOKEN"]` list ([`src/types.ts`](src/types.ts)). At launch,
  each named key is resolved from the encrypted vault — principal = the agent, widening to the
  tenant-wide `*` default — and exported as a shell env var into that agent's claude-code session
  ([`TerminalManager.injectShellSecrets`](src/terminal.ts)), so a plain CLI like `gh` (via `GH_TOKEN`)
  authenticates without baking the credential into the server process env. Each resolution is audited
  (`shell.secret.injected` / `shell.secret.unresolved`); a missing value leaves the var **unset** (not
  blanked) so the tool sees "no token" cleanly. This is the **only** path a vault secret reaches the
  interactive shell — connectors still get theirs via the MCP bag — so exposure stays explicit and
  opt-in per agent. Store the value in **Settings → Secrets** (set its principal to the agent id for a
  per-agent token, or leave tenant-wide) and list the key in the agent's config editor
  (**Runtime tuning → Shell secrets**). Settable via `POST /api/agents`, the agent config PUT, and the
  agent-facing `agent_create` / `agent_update` tools.

## [0.11.0] — 2026-07-06

### Added
- **The agent-author — a default *System* agent that builds other agents.** Agent OS now ships a
  meta-agent ([`src/edge/agent-author.ts`](src/edge/agent-author.ts)) provisioned into every data home
  under the **System** category (like the consolidator): it interviews you about a role, drafts a
  manifest + CLAUDE.md, and **creates the agent for real** via two new agent-facing MCP tools —
  `agent_create` and `agent_update` (`memory-mcp.ts`). These are session-secret-gated loopback routes
  (`POST /api/agents/create|update`) sitting before the member gate, following the same **auto-apply +
  audited** posture as `kb_write` / `task_create` (`agent.created` / `agent.config.updated`,
  `principal: agent:<id>`). A new agent is live in the console immediately — no restart. Creating a
  *definition* escalates nothing: the new agent still passes every effect through the gate, and only a
  human can run or assign it. `agent_update` edits only user-home agents (bundled examples stay
  read-only). Docs: [`docs/agent-mcp-tools.md`](docs/agent-mcp-tools.md) (now 27 always-on + 2
  conditional tools).

## [0.10.0] — 2026-07-06

### Changed
- **Simplified the memory/self-learning surface.** The whole system is now framed by one four-verb
  mental model — **Capture · Recall · Distil · Apply** ([`docs/memory-model.md`](docs/memory-model.md),
  the canonical entry point). The two overlapping learning actions ("Run reflection" + "Consolidate
  knowledge", with a separate auto-consolidate toggle) collapse into **one "Reflect" pass**: `POST
  /api/dreaming/run` (and the scheduled tick) run the deterministic tally then the memory-gardener over
  new material. The Memory hub drops from three tabs to **two** (Memories · Self-learning) under a slim
  stats strip; the "Lever N" and "Dreaming vs Consolidation" jargon is retired from the product surface.

## [0.9.0] — 2026-07-06

### Added
- **Settings → System now surfaces the build + self-update + restart.** The System tab gains a
  **Software** panel showing the running version, the checkout's branch → upstream, and a cached
  `git fetch` status: **Up to date** or **Update available** with the changelog preview. Owners get a
  one-click **Update & restart** (pull + rebuild + bounce, then wait for `/health` and reload) and a
  plain **Restart** (bounce only — no pull/rebuild, for picking up an on-disk change or recovering a
  wedged runtime) backed by a new owner-only `POST /api/restart` (`restartService` in
  `src/edge/updater.ts`). The sidebar "Update available" pill stays; this makes the same controls
  reachable from Settings and adds restart-without-update.
- **Tenant name in the browser-tab title.** The document title now leads with the tenant name
  (`<tenant> · Agent OS`, still prefixed with the 🔔 + count when a session is waiting), so several
  instances open in different tabs are distinguishable at a glance.

## [0.8.0] — 2026-07-06

### Added
- **`engineering-discipline` skill in the bundled catalog.** A single, tone-neutral coding-conduct skill
  — surface assumptions before coding, keep the solution minimal (reuse before you write), make surgical
  changes, leave a verifiable check, and a "never simplify away" safety floor (validation / error
  handling / security / a11y / tests / anything asked for). Distilled from the best of the public
  Karpathy-guidelines and Ponytail skills, with the personas/comment-conventions stripped and a
  **headless override** added so unattended runs (cron / Slack / Discord / dispatched tasks) make the
  most reasonable assumption and proceed instead of stalling on a clarifying question. Opt-in per tenant
  from the Skills catalog (`config/skills/engineering-discipline`); once installed it materialises into
  every claude-code agent at launch like any other library skill.

## [0.7.0] — 2026-07-05

### Added
- **Agent icons.** Every agent can now carry a visual icon — pick one from a curated built-in library
  (a lucide subset spanning engineering / comms / ops / finance roles) or **upload a custom SVG**. The
  icon shows everywhere an agent is listed (the spawn picker + its trigger, the assignments page, and
  the task/schedule pickers), with a Bot glyph as the default fallback. It's a single cosmetic `icon`
  field on the manifest (`AgentManifest.icon`) — a library id like `"Bot"` or raw `<svg>` markup —
  persisted in `agent.json` and edited from both the New-agent and per-agent settings forms. Uploaded
  SVGs are sanitised server-side (`sanitizeIcon`/`sanitizeSvgIcon`: strips scripts, `on*` handlers,
  `javascript:` links and `<foreignObject>`, 20 KB cap) and rendered via an `<img>` data-URI so any
  residual markup can't execute.

## [0.6.0] — 2026-07-05

### Added
- **Self-update from the console**: Agent OS now tells you when the deployed checkout is behind
  `origin` and can update itself. The server compares HEAD against the tracking branch via a cached
  `git fetch` (`GET /api/update`) — no GitHub API, so it works on the private Tailscale box — and the
  sidebar shows an **"Update available · vX.Y.Z"** pill with a changelog preview of the commits that
  would land. An owner clicks **Update & restart** (`POST /api/update/apply`, owner-only): the box does
  an ff-only `git pull` → `npm install`+`npm run build` (server + web) → restart via launchd/systemd
  (override with `AOS_RESTART_CMD`), streaming each step's log; the console waits for `/health` to
  report the new version and reloads. Refuses on a dirty working tree; the apply is audited
  (`update.applied`). New module `src/edge/updater.ts`.

## [0.5.0] — 2026-07-05

### Added
- **Adjustable terminal font size**: an A−/A+ stepper (top-left of the browser terminal) resizes the
  live xterm.js text without a reload or ttyd relaunch — the console reaches into the same-origin ttyd
  iframe (`window.term`), sets `fontSize`, and reflows via ttyd's `fit()`. The choice is persisted
  (`localStorage`) and re-applied on every reconnect. Range 8–40, default 14.

## [0.4.0] — 2026-07-04

### Added
- **In-app Docs** (#13): a bundled product manual — *What is Agent OS?*, *Getting started*,
  *Core concepts*, *Working with agents*, *Governance & approvals*, *Memory/Knowledge/Tasks* —
  at a new **Docs** sidebar route (one click away for every role, outside the Manage group).
  Ships WITH the software (Markdown bundled via Vite `?raw`, versioned with the code), so it's
  identical for every tenant — distinct from the per-tenant Knowledge base. Adding a page = drop
  a `.md` in `web/src/docs` + one entry in its `index.ts`.

## [0.3.0] — 2026-07-04

### Added
- This changelog (#11).
- **Resumable sessions surfaced to the console**: session rows now carry `resumable`
  (a persisted `session-<id>.env` exists, i.e. an interactive claude-code session the
  ttyd attach wrapper can resurrect via `claude --resume`). Completes the loop for the
  already-shipped console Resume button, which never appeared because the server didn't
  send the flag. Headless automation runs correctly report `resumable: false`.

## [0.2.0] — 2026-07-04

### Added
- **Agents rescan** (#9): `POST /api/agents/rescan` + a console button syncs the live
  registry with the agents folder on disk — agents dropped in via git pull/scp/another
  agent register without a server restart. Removal is registry-only (assignments and
  memories are kept in case the folder returns); audited as `agents.rescanned`.
- **Version system** (#10): root `package.json` is the single source of truth
  (`src/version.ts`), surfaced at `GET /health`, `GET /api/state`, the console sidebar,
  and `agent-os version`. The sidebar version doubles as a stale-server detector.

### Changed
- A malformed `agent.json` no longer aborts boot — the folder is skipped with a logged
  error and every healthy agent still loads (#9).

## [0.1.0] — 2026-07-03

The pre-versioning baseline (2026-06-11 → 2026-07-03, PRs #1–#8): the governed gateway
(policy / approvals / budget / identity / idempotency / audit) with fail-closed never-tier
and gateway enricher; tmux-backed claude-code sessions behind the PreToolUse gate hook;
the web console + JSON API + browser terminal; team/roles/magic-link login with the
identity map; multi-tenant registry + process-per-tenant deploys; automations (cron /
webhook / Composio / native Slack + Discord sockets) with the `/agent` chat router; the
memory plane (recall/remember/revise/forget + consolidation), knowledge base, tasks
queue, skills library, secrets vault, artifacts gallery; self-learning ("Dreaming") with
the consolidation gardener; kill switch; governance-conformance CI (44 checks).

[Unreleased]: https://github.com/vikasprogrammer/agent-os/compare/main...HEAD
[0.3.0]: https://github.com/vikasprogrammer/agent-os/pull/12
[0.2.0]: https://github.com/vikasprogrammer/agent-os/pull/10
[0.1.0]: https://github.com/vikasprogrammer/agent-os/commits/895bf26
