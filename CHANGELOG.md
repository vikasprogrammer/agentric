# Changelog

All notable changes to Agent OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

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
