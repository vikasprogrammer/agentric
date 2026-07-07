# Changelog

All notable changes to Agent OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

### Added
- **GitHub App token minter (foundation for native GitHub).** New zero-dependency connector
  ([`src/connectors/github.ts`](src/connectors/github.ts)) that signs a short-lived App JWT (RS256, via
  `node:crypto`) and exchanges it for a **1 h installation access token** — the single credential that
  will drive both the shell (`GH_TOKEN` for `gh`/`git`) and a governed GitHub MCP connector, so a user
  connects GitHub once in the browser instead of pasting a static PAT. Includes `appJwt`,
  `listInstallations`, `mintInstallationToken` (optional repo/permission narrowing for least-privilege)
  and an in-memory `InstallationTokenCache` (reuse until ~5 min before expiry). Not wired into launch
  yet — see [`docs/github-integration-plan.md`](docs/github-integration-plan.md) for the phased plan
  (mint-at-launch injection + Settings → Integrations install flow land next).

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
