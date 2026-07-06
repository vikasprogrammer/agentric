# Changelog

All notable changes to Agent OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

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
