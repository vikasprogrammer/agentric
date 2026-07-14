# Changelog

All notable changes to Agent OS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

## [0.193.2] — 2026-07-14
### Fixed
- **Sidebar "All" session badge now counts only genuinely live runs.** It was keyed off `isLive`, which
  is deliberately broad — an interactive session that reported `done` but keeps an attachable pane reads
  live so its dot stays green and reattachable. That inflated the badge with finished sessions whose tmux
  panes were never reaped (some days old), so the count could read ~10 when only a handful were actually
  running. The badge now mirrors the server's canonical `aliveSessionCount`: a session with stored status
  `running` and a live (or unpollable) pane. Per-session dots/reattach affordances are unchanged.

## [0.193.1] — 2026-07-14
### Fixed
- **Chat replies no longer stall on "thinking…" forever.** The v1 Chat surface delivered a follow-up by
  typing it into a warm resident TUI pane (`deliverToResident`); when that pane had been reaped or the
  keystrokes didn't trigger a turn, the message was silently lost and the UI spun indefinitely (the DB row
  still read `running`). Replies now go through **`TerminalManager.chatSend`** — every turn is a clean,
  self-terminating **headless resume** run seeded with the message as the prompt (reliable turn trigger,
  not injected keystrokes), and `chat/start` is likewise a headless one-shot. The run tears down at
  turn-end, so the UI's "thinking…" is driven by *real* pane liveness and can't hang; a genuinely stalled
  turn shows a **Resend**, and a reply sent while the prior turn is still generating returns `busy` (the
  draft is kept). Trade: a cold start per turn — removed properly by the SDK runtime (see below). The
  PreToolUse gate still governs every effect. (`src/terminal.ts`, `src/server.ts`, `web/src/App.tsx`,
  `web/src/lib/api.ts`.)
### Added
- **`docs/sdk-chat-runtime-plan.md`** — the proposed v2: drive the chat surface via the Claude Agent SDK
  (`query()` + `includePartialMessages` + `canUseTool` → the existing gateway) for token streaming and a
  first-class approval hook, running beside the CLI/tmux runtime. Not started; greenlight before building.

## [0.193.0] — 2026-07-14
### Added
- **Transfer a session to another owner.** A session's accountable human — its `run_as` — can now be
  reassigned from the Sessions list. Each session's action row gains a **Transfer** control (a member
  picker; labeled button in the grid view, icon in the list view) that hands the run to another teammate:
  ownership, the "mine" filter, the owner chip, and connectors/identity of any future effect all follow
  the new `run_as`, while provenance (`spawned_by` — what originally triggered the run) is left untouched.
  Gated to an owner/admin or the session's current owner (mirrored server-side), and every transfer is
  audited `session.transferred` (`{from, to, agent}`). New `TerminalManager.transferSession` +
  `POST /api/sessions/:id/transfer`; no schema change (`run_as` already existed).

## [0.192.0] — 2026-07-14
### Changed
- **The browser terminal now selects and clicks like a web page — no more Option-drag, and links work.**
  claude's fullscreen TUI turns on mouse tracking, which made xterm hand every click/drag to the app: a
  plain drag wouldn't select (you had to hold Option), and links couldn't be clicked. But claude only ever
  uses the *wheel* (it runs with `DISABLE_MOUSE_CLICKS`) — so our first-party `<Xterm>` client now strips
  just the mouse-*tracking* DECSET modes (1000–1003) out of the PTY output stream before xterm sees them
  (native drag-select + clickable links come back), and forwards **only the wheel** back to claude as SGR
  events so its conversation still scrolls. Uses documented xterm API only (no internals), so it survives
  xterm upgrades. (`web/src/Xterm.tsx` `stripMouseTracking` + the custom wheel handler.)
- **Links no longer need a scheme to be clickable.** Replaced the stock `WebLinksAddon` (full `https://…`
  only) with custom link providers that also match bare domains (`example.com`), subdomains, `www.…`,
  `localhost:PORT`/`127.0.0.1:PORT`, and OSC-8 hyperlinks — opening the right target in a new tab — while
  deliberately *not* underlining `file.tsx:42`-style tokens. (`web/src/Xterm.tsx` `makeLinkProvider`.)
- Test bed: `scripts/mouse-tui.mjs` reproduces claude's mouse-reporting condition (plain bash never did),
  and `TERMBED_CMD=…` points the test bed at it — so selection/links/wheel can be verified against a real
  mouse-mode app. (`scripts/termbed.mjs`, `web/src/termbed.tsx`.)

## [0.191.0] — 2026-07-14
### Added
- **Chat — a plain-language window onto a claude-code run for non-technical teammates.** A new **Chat**
  page (nav next to Agents) renders a session as a messaging app instead of a terminal: message bubbles,
  friendly activity cards ("Sent a Slack message" ✓ / "Read a file"), and **inline approvals/questions**
  as Approve/Decline buttons — the governance surface in language support/sales/marketing can act on. It
  reads the session's claude transcript (`GET /api/sessions/:id/conversation`, parsed by
  `src/edge/conversation.ts`) and drives the human's turns via `POST /api/sessions/:id/reply` and
  `POST /api/chat/start` — reusing the **exact** resident-deliver / transcript-resume path Slack
  thread-continuity already uses (`deliverToResident`/`reviveResident`), so no governance, gate, or DB
  changes: the gate hook + approvals still mediate every effect. Message-level polling (2s), no terminal.
  (`src/edge/conversation.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`.)

## [0.190.0] — 2026-07-14
### Added
- **Callee agents can poke the caller back when they're really done — async delegation, no polling.** A
  delegate now closes an agent→agent hand-off by RESUMING the caller's own transcript with the outcome,
  so a fire-and-forget delegation wakes the caller instead of making it block on `task_wait`. Opt in with
  `task_create({ assignee:"agent:<id>", goal:"…", poke_on_done:true })`: the caller stamps its agent id +
  pinned claude transcript on the task (`caller_agent`/`caller_claude_id`), ends its turn, and is
  `--resume`d the moment the delegate marks the task **done** (`✅ Really done: …`) or hands it back
  **blocked** (`⛔ Handed back: …`). The wake fires immediately via `Automations.pokeCaller` (not the
  1-min-floored `schedule()`), is guarded so it never spawns a competing run on a still-live caller, gets
  provenance `poke:<task>` (console badge "Poke · …"), and is audited `agent.poked`. The async counterpart
  to `wait` (which blocks). `poke_on_done` implies `autoDispatch`.
- **State a GOAL when delegating to an agent — with or without a task in between.** `task_create` /
  `task_dispatch` take `goal` as the ergonomic synonym for `criteria` (the single-line objective that runs
  a headless delegate under a `/goal` convergence condition until it holds). `ask_agent` gains the same
  optional `goal`, so a taskless synchronous consult can hand the delegate an objective it works to before
  answering — one vocabulary across both delegation surfaces.
  (`src/state/{db,tasks}.ts`, `src/types.ts`, `src/edge/automations.ts`, `src/terminal.ts`,
  `src/server.ts`, `src/tenant-registry.ts`, `src/memory/memory-mcp.ts`, `docs/agent-mcp-tools.md`.)

## [0.189.0] — 2026-07-14
### Fixed
- **One-click "Create GitHub App" now actually works — the manifest was invalid.** Every attempt failed on
  GitHub with *"Invalid GitHub App configuration … 'url' wasn't supplied"*, forcing manual App creation.
  Root cause: the manifest sent `hook_attributes: { active: false }` to disable the webhook, but
  [GitHub requires `hook_attributes.url` whenever the object is present](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
  (even with `active:false`) — so GitHub rejected the whole manifest, and the "url" it meant was the
  *webhook* url, not our (present) top-level one. Fix: **omit `hook_attributes` entirely** — that's an App
  with no webhook, exactly what we want, and no required url. (`src/server.ts` `githubAppManifest`;
  `scripts/github-per-member-test.cjs` now 79/79.)
## [0.188.0] — 2026-07-14
### Added
- **Set the GitHub App slug by hand when it can't be auto-detected.** The "Install the App" button needs
  the App's slug; normally it's auto-resolved (one-click flow, bot creds via `GET /app`, or a connected
  member's install). When none of those apply — e.g. an OAuth-only setup with no bot creds and nobody
  installed yet — the **Connections → Creds → GitHub** install section now shows an **App slug** input
  (accepts the bare slug or a full `github.com/apps/<slug>` URL, normalized) so an admin can enable the
  install link directly. Previously there was no way to set it, so the button just never appeared.
  (`src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`; `scripts/github-per-member-test.cjs` now 78/78.)

## [0.187.0] — 2026-07-14
### Fixed
- **The GitHub "Install the App" button/link now shows for hand-configured Apps, regardless of install
  state.** The App slug (needed to build the `github.com/apps/<slug>/installations/new` link) is resolved
  from `GET /app` whenever the bot creds are present — not only in the authorized-but-not-installed case.
  So the **Connections → Creds → GitHub** admin install button appears even when the App is already
  installed (for adding more orgs/repos), and it self-heals on any admin Creds view / member GitHub-panel
  view / bot-creds save — not just when a member is stuck uninstalled. (`src/server.ts` — resolve in
  `GET/PUT /api/settings/integrations` + ungate `/api/github/me`; `scripts/github-per-member-test.cjs` now 76/76.)

## [0.186.1] — 2026-07-14
### Changed
- **Sharpened the `engineer` ↔ `ops` boundary** so the two generalists stop overlapping. Both used to say
  they "investigate systems" / "investigate incidents". Now the line is explicit: **engineer owns the
  code** (reads/writes/reviews code, debugs, ships changes; hands live-systems work — alerts, prod
  restarts, key rotations, runbooks — to ops), **ops owns the running system** (monitors, responds to
  incidents, runs routine reversible operations, mitigates; files the durable *code* fix to engineer
  instead of editing the codebase). Reworded both descriptions + CLAUDE.md intros, methods, and boundaries.

## [0.186.0] — 2026-07-14
### Added
- **`secret_request` — an agent asks a human about a credential KEY, without a paste into the session.**
  When an agent needs a password/API key/token, it now `secret_request`s the KEY (with a reason) rather
  than a human pasting the raw value into chat — where it would persist in the transcript. The request
  carries only the key + reason (never a value) and **auto-detects two modes** so the agent doesn't have
  to know which case it's in:
  - **provide** (the inverse of `secret_put`) — the vault doesn't have the key: a human types the value
    into a password field (`POST …/fulfill`), sealed into the vault under the requesting agent's principal
    (default — only that agent can `secret_get` it — or tenant-wide `*`).
  - **access** — the key already EXISTS but is scoped away from the agent (owned by another agent or a
    person): a human **grants** access and the existing sealed value is re-scoped to the agent
    server-side — no value is re-typed or shown. Grant is agent-scoped (not widened to everyone).

  Either mode can also inject the value into the agent's shell at launch (reusing `secret_assignments`),
  short-circuits `exists` if the agent can already resolve the key or `duplicate` on an open request, and
  posts a `secret.request` card to owner/admins (Inbox + a new **Settings → Secrets → Agent requests**
  review section). The value never touches the transcript, the card, or the audit trail; audited
  `secret.requested` (with `mode`) / `secret.request.fulfilled` / `secret.request.granted` /
  `secret.request.dismissed` by key only. New MCP tool `secret_request`, loopback
  `POST /api/agent/secret/request`, admin routes `GET /api/secrets/requests` +
  `POST /api/secrets/requests/:id/{fulfill,dismiss}`, and `TerminalManager.requestSecret` /
  `secretRequestCard` / `setSecretRequestStatus` / `openSecretRequests`.

## [0.185.0] — 2026-07-14
### Changed
- **Reworked the default agent fleet — generalists are now install-on-demand, System = OS-provided.**
  - **Only `agent-author` seeds on boot.** `BUILTIN_SEED_IDS` dropped from
    `['agent-author','engineer','support','marketer','researcher']` to just `['agent-author']`, so a fresh
    home comes up able to *build* its own team but with no fixed department roster — every generalist
    (engineer/support/marketer/researcher/ops/sales + the new ones) is installed on demand from the agent
    library. **No impact on existing tenants:** `seedBuiltinAgents` leaves any on-disk agent folder
    untouched, so an already-installed + edited generalist survives unchanged — it simply stops being a
    protected built-in and becomes a normal, deletable agent (verified via an isolated seed/install test).
  - **No more hard model pins.** Removed `model: 'claude-opus-4-8'` from `agent-author` and every System
    machinery agent (consolidator, skill-scout, strategist, improver, analyst); they now inherit the
    workspace runtime default like the generalists.
- **`System` category now means "OS-provided"** (agent-author + the five code-provisioned machinery agents),
  not "auto-spawned" — `agent-author` stays in System deliberately.

### Added
- **Five new department generalists in the agent library** (all install-on-demand): **designer** (Design),
  **data-analyst** (Data), **product-manager** (Product), **writer** (Content), **finance** (Finance) —
  each an `<id>/{agent.json,CLAUDE.md}` catalog entry mirroring the existing generalists. Brings the
  `config/agents` catalog to 12 entries (agent-author + 11 department generalists). Full fleet =
  6 System OS-provided (agent-author + the 5 code-provisioned machinery agents) + 11 generalists.

## [0.184.0] — 2026-07-14
### Changed
- **The "authorized but not installed" GitHub warning now links straight to the install page.** The amber
  banner on the per-member GitHub card (Connections → Mine / Profile) that appears when a member has
  authorized but the App isn't installed anywhere used to just say "install the App (Connections → Creds)" —
  now **"install the App ↗"** is a real link to `github.com/apps/<slug>/installations/new`. For Apps
  configured by hand (no slug from the one-click manifest flow), the slug is **resolved on demand** from
  `GET /app` (new `appMetadata` + `GithubIdentity.ensureAppSlug`, self-healed when `/api/github/me` is
  viewed) so the link works regardless of how the App was set up; if the slug still can't be resolved it
  falls back to the previous text. (`src/connectors/github.ts`, `src/edge/github-identity.ts`,
  `src/server.ts`, `web/src/connectors.tsx`, `web/src/lib/api.ts`; `scripts/github-per-member-test.cjs` now 74/74.)

## [0.183.1] — 2026-07-14
### Fixed
- **Flag the System machinery agents as built-in.** The code-provisioned System agents spawned by the
  edge loops — `skill-scout`, `strategist`, `improver`, `analyst` — were missing from `BUILT_IN_AGENT_IDS`,
  so (unlike `consolidator` and the seeded generalists) they showed in the console *without* the "built-in"
  badge and were **deletable** — letting an admin remove OS infrastructure a learning/goals loop depends on.
  Added all four to the set so the whole System fleet is consistently flagged + delete-protected. No change
  to `BUILTIN_SEED_IDS` (they're code-provisioned on first use, not boot-seeded from `config/agents/`);
  their manifests already carry `category: 'System'`.

## [0.183.0] — 2026-07-14
### Added
- **`github_refresh` agent tool — recover a live run whose GitHub token expired mid-flight.** An agent's
  injected `GH_TOKEN` is the run-as member's ~8h GitHub user-to-server token; it's refreshed only at launch
  (fire-and-forget, within the expiry skew) and can't be mutated in the running process, so a long or
  resumed run that outlives it hits "Bad credentials" with no recovery. The new tool (`POST
  /api/agent/github/refresh`, session-secret loopback) FORCES a refresh now via the stored `ghr_` refresh
  token (`GithubIdentity.forceRefresh`) and returns the fresh token for the agent to `export GH_TOKEN=…`
  (the git credential helper + `gh` re-read `$GH_TOKEN` at call time). Run-as-scoped; the returned token is
  the run's own identity, already injected at launch (no new exposure). Typed statuses
  (`not_connected`/`no_refresh_token`/`not_configured`/`failed`) tell the agent to stop retrying and have
  the human re-link GitHub. Audited `github.token.refreshed` / `github.token.refresh_failed` (never the
  token value).

## [0.182.0] — 2026-07-14
### Added
- **Insights improvement tiles v2 — Automations domain ("triage").** Completes the v2 set (all six tiles
  now actionable). The Automations tile expands the enabled automations needing attention in place — the
  ones whose **last run errored** (shown WITH the extracted error text) and **cron gone idle** (14+ days
  quiet, with days-since) — each with **run now** (idle) and **disable** (retire) actions. Deterministic,
  no spawned agent: the fix is to see WHY and act. The list is surfaced in `/api/insights` +
  `/api/dreaming` (`troubledAutomations`); actions reuse the existing `PATCH /api/automations/:id` +
  `POST /api/automations/:id/run` routes.
### Added
- **Insights improvement tiles v2 — Goals domain ("unstick").** The Goals tile expands the actual stuck
  goals in place (active, no progress in 7+ days), each with a **plan** action that spawns the existing
  governed **strategist** (`Strategist.plan` — reused wholesale, no new spawn or apply surface) to file the
  next tasks under the goal for a human to review + dispatch. The stuck-goal list is surfaced in the
  `/api/insights` + `/api/dreaming` payloads (`stuckGoals`); planning reuses `POST /api/goals/:id/plan`.
### Added
- **Insights improvement tiles v2 — KB domain ("preview tidy").** The KB tile gains a **Preview tidy**
  action: a deterministic preview of exactly which DEAD pages (never read, 30d+ old) would be archived —
  real counts + sample — **without removing anything**, so an owner eyeballs them before applying. **Apply**
  archives them via `kb.remove`, which is soft: the `kb_revisions` history survives, so an archived page is
  recoverable via revert. Long-unread-but-once-read (STALE) pages are surfaced for MANUAL review (linked,
  never auto-archived) — a once-useful reference shouldn't vanish on a timer. Deterministic, no LLM (like
  Memory cleanup). `src/edge/kb-tidy.ts`; route `GET|POST /api/insights/kb/tidy`; audited `kb.tidied`.
### Added
- **Insights improvement tiles v2 — Skills domain ("draft a skill").** Completes the first v2 batch
  (Agents · Memory · Skills). The Skills tile gains a **Draft a skill** action that spawns a governed
  headless **skill-scout** (`src/edge/skill-scout.ts`, same shape as the analyst / improver) which mines a
  slice of the fleet's recent SUCCESSFUL runs, finds a recurring multi-step procedure the fleet keeps doing
  by hand (checking `skill_find` so it never duplicates an existing skill), and drafts ONE reusable skill
  via `skill_propose` — landing on the **existing** proposed-skill review queue (published from the Skills
  page), so there's no new apply surface. It's told to draft nothing rather than force a weak skill. The
  tile keeps a **Review N →** link to the queue alongside. Route `POST /api/insights/skills/draft`; audited
  `insights.skill.scout`.
### Added
- **Insights improvement tiles v2 — Memory domain ("preview cleanup").** The Memory tile is now generative:
  a **Preview cleanup** action shows exactly what a maintenance pass would prune (never-recalled aged
  memories) and merge (duplicates) — the real counts + sample items, per agent — **without deleting
  anything**, so an owner reviews before applying. **Apply** then runs the same plan; **Cancel** discards
  it. The review-gated, on-demand counterpart to the blind scheduled `maintain` in Settings → Memory.
  Deterministic (a query + cosine via the existing `planConsolidation`, no spawned agent — unlike the
  Agents CLAUDE.md rewrite): `src/edge/memory-cleanup.ts` reads the local `memories` table (the SQL
  readers' source of truth) and mirrors `maintain`'s prune + merge SQL so preview and apply agree exactly.
  Route `GET|POST /api/insights/memory/cleanup`; audited `memory.maintained` (`via: 'insights-cleanup'`).
### Fixed
- **Improver proposals now surface in the scorecard.** The KB store normalizes a slug's `/` to `-`, so the
  improver's `proposed/<agent>` page is stored as `proposed-<agent>`; `pendingProposals` matched the raw
  `proposed/` prefix and so never listed any draft (Apply/Dismiss buttons never appeared). Match the
  normalized prefix. Apply/Dismiss themselves were already correct (read normalizes identically). Caught on
  the first live northwind dry-run — the improver ran and wrote the draft, but the UI couldn't see it.

## [0.177.0] — 2026-07-14
### Added
- **Insights improvement tiles v2 — "generate the fix" (Agents domain).** The scorecard already says an
  agent is underperforming (which) and Diagnose says why; a new **draft fix** action closes the loop. It
  spawns a governed headless **improver** agent (`src/edge/improver.ts`, same shape as the analyst /
  consolidation gardener) that reads the target's current CLAUDE.md + its recent failed/stopped runs + any
  diagnosis, then writes a **revised CLAUDE.md as a review-gated proposal** — a KB page at
  `operations/proposed/<agent>` whose body IS the proposed system prompt. Nothing changes live: the owner
  reviews the draft in Knowledge and **Applies** it (committed as a reversible agent revision) or
  **Dismisses** it, from the Fleet scorecard. Reuses existing rails end to end — KB stores/versions the
  draft, agent-revisions applies + can roll it back, `report` posts the owner Inbox card. Routes:
  `POST /api/insights/improve`, `POST /api/insights/proposal/:agent/{apply,dismiss}`; pending proposals are
  surfaced in the `/api/insights` + `/api/dreaming` payloads. (Skills + Memory domains follow.)
### Fixed
- **Reflect-pass honesty** (`src/edge/dreaming.ts`) — two gaps in what Insights reports about itself:
  - **Chat sessions no longer dilute the self-learning success rate.** The reflect pass tallied every
    terminal session, but a chat reply rarely calls `report`, so it landed as `unknown`/`ended` and dragged
    the RATE down — the same rate that drives the "slow down" guidance and the raise-effort recommendation.
    Now the outcome tally excludes `spawned_by LIKE 'chat:%'` sessions (parity with the scorecard /
    measurement / alerts, which were already fixed). Friction counts (rejections/budget/errors) stay whole.
    On live globex this dropped the 7-day denominator 194→183.
  - **Skipped and errored reflect passes are now audited** (`learning.skipped`). Previously a pass that
    found no activity, no-opped as `busy`, or *threw* vanished silently (the scheduler `.catch`es it), so
    "ran and found nothing" / "ran and errored" looked identical to "never ran" in the Insights history.

## [0.176.2] — 2026-07-13
### Changed
- **Hero product visual + template polish on the landing page** (`public/landing.html`). Replaced the plain
  hero fleet card with a realistic **browser-framed console mockup**: browser chrome (traffic-light dots +
  an address bar), an icon **sidebar nav** (Fleet · Tasks · Inbox · Knowledge · Library · Insights ·
  Automations), the live **"Your fleet"** panel (keeps its idle↔running animation), and a **floating
  "Approval needed / owner" governance card** (`ssh.exec host=prod-db-1`, Approve/Reject) overlapping for
  depth — putting the governance story in the hero. Added a subtle **dot-grid texture** behind the hero and
  rebalanced the hero columns to give the visual more room. The mockup reflows on small screens (sidebar
  hides, the approval card drops below the panel). Re-reviewed with the design-review harness in light **and**
  dark at desktop/tablet/mobile: no overflow and **zero axe-core accessibility violations** (decorative
  sidebar nav items made non-focusable so they don't trip `aria-hidden-focus`).

## [0.176.1] — 2026-07-13
### Changed
- **Digest drops agent self-maintenance lines.** A report about an agent editing its OWN prompt (e.g.
  *"Rewrote my CLAUDE.md rev 5…"*) is self-maintenance, not fleet work, so it no longer clutters the "what
  got done" changelog (still counted in the header tally). Detected on the reported **line** — `\b(my|its|
  their|own) (claude.md|system prompt|starter prompts|instructions)\b` — not the `agent.config.updated`
  audit event, because a session that did real work AND incidentally touched its config (e.g. a "QA PASS on
  PR #2613" run) would otherwise be wrongly dropped. `src/edge/digest.ts`.

## [0.176.0] — 2026-07-13
### Changed
- **Daily digest — links + cleaner formatting, and two accuracy fixes.**
  - **Links.** The Slack/Discord post now links the header + each **agent name** to the console
    (`/#/agents/<agent>`) and adds an **"Open the full report in Agent OS →"** footer — sourced from the
    tenant's public URL (`consoleOrigin` for the scheduled post, the request origin for "Post now"). The KB
    journal page links agents too. Blank line between agents for readability.
  - **"N errors" no longer inflated by memory-store failures.** The header counted `episode.error` (a
    flaky-memory-backend signal) as fleet errors — a tenant on an external backend showed e.g. "26 errors"
    on a clean day. Now counts only `session.error` (real run errors).
  - **"Frequently works on" topics de-noised.** The Dreaming topic extraction now filters procedural words
    (slack, check, report, completed, summary, …) so guidance surfaces real work areas, not plumbing.
  `src/edge/digest.ts`, `src/edge/dreaming.ts`, `src/server.ts`.

## [0.175.2] — 2026-07-13
### Changed
- **Visuals/icons across the landing page** (`public/landing.html`). Added tasteful inline-SVG iconography
  to the previously text-only sections, matching the existing line-icon style: an accent-tinted icon on each
  **hero stat** (connector link · generation sparkles · governance shield · 24/7 clock); an icon on every
  **ladder rung** (Goal target · Tasks board · Sessions terminal); a per-step icon on each **governance-gate**
  row (scales · check · database · fingerprint · loop · audit-doc, alongside the sequence number); and a
  header icon on every **integration card** plus recognizable monochrome **brand marks** in the key chips
  (Slack, Discord, GitHub, Google Drive). All icons inherit the accent color so they adapt in dark mode.
  Re-reviewed with the design-review harness: no overflow at desktop/tablet/mobile and **zero axe-core
  accessibility violations**, in both light and dark themes.

## [0.175.1] — 2026-07-13
### Fixed
- **Generic end-cards no longer leak into the digest (or episodes).** The no-report detection matched only
  the literal `'Session ended.'`, but the launcher actually writes **"The session ended."** and **"The
  session ended unexpectedly (the process died)."** — so those (and their `×N` dedupes) were showing up as
  digest lines for agents that didn't `report`. Detection is now a robust `isRealReport` check applied in
  the digest AND in `composeEpisode` (the same bug polluted episode memories). No-report sessions fall back
  to their title (then get task/placeholder-filtered) instead of surfacing "The session ended."
  `src/edge/digest.ts`, `src/terminal.ts`.

## [0.175.0] — 2026-07-13
### Changed
- **Comprehensive rewrite of the marketing landing page** (`public/landing.html`, served off disk at
  `/landing`). Expanded from eight capability cards into a full product story while staying a landing page,
  not a spec sheet — and keeping the existing warm palette, light/dark theming, ambient glow, live fleet
  card, and scroll fade-ins. New sections: a **Goal → Tasks → Sessions** "how it works" ladder (put in your
  company's goals and the strategist plans and runs the work); a hero **stat strip** (1,000+ Composio
  connectors · 400+ media models · one gate · 24/7 unattended); three themed **capability clusters**
  (stand up a workforce · they work as a team · they remember and compound) covering the agent author,
  agent-to-agent delegation, ask-a-human, tasks, knowledge base, awareness/inbox, Library, memory,
  Insights self-learning, and skills; a dedicated **governance-gate** visual (Policy → Approvals → Budget →
  Identity → Idempotency → Audit); and an **integrations** grid (native Slack & Discord, automations,
  Composio, media generate/edit/understand, secrets vault, team/identity). Reviewed with the design-review
  harness: no horizontal overflow at desktop/tablet/mobile and **zero axe-core accessibility violations**.

## [0.174.0] — 2026-07-13
### Fixed
- **Success-rate metric no longer misjudges chat agents or conflates crashes with failures** (found via a
  false "docs-bot is struggling (14%)" alert). Three corrections across the scorecard, measurement, and
  alerts:
  1. **Chat sessions excluded from the success rate.** Chat-triggered (`chat:`) sessions are conversational
     Q&A that don't call `report`, so they were dragging chat-heavy agents to a fake-low rate. They're now
     kept out of the rate denominator and surfaced separately as a **chats** count.
  2. **Crashes distinguished from failures.** A `crashed` session (process/pane died — infra) is surfaced
     as its own **crashed** count, not lumped into failures; the scorecard is now based on all terminated
     sessions so hard crashes (which emit no terminal event) are actually counted.
  3. **Alerts split accordingly.** The "struggling" alert now requires **real failures** (≥2), so a chat- or
     crash-heavy agent won't trip it; a new **"runs keep crashing"** alert (≥3 crashes) points at infra /
     task-scoping instead of blaming the agent. On real data docs-bot flips from a misleading "14% struggling"
     to an accurate "6 runs crashing." `src/edge/insights.ts`, `measurement.ts`, `alerts.ts`.

## [0.173.0] — 2026-07-13
### Added
- **Improvement tiles on Insights — what to make better across the whole OS.** A grid of six deterministic
  tiles (`src/edge/improvements.ts`), one per domain, each detecting the top opportunity + a one-tap action
  into the surface where you fix it: **Agents** (underperformers → review CLAUDE.md / prompts), **KB**
  (dead + long-stale pages), **Goals** (active goals with no progress in 7+ days), **Skills** (proposals
  awaiting publish), **Memory** (never-recalled aged memories to prune), **Automations** (last run errored,
  or enabled-but-idle cron). Opportunities sort first; a healthy domain shows a ✓. Bundled into
  `GET /api/insights` so the owner dashboard gets them too. v1 is detect + navigate/reuse-existing-actions;
  per-domain LLM "generate the fix" can layer on later. Validated on live data (flagged the 3 underperforming
  agents; other domains clean). `src/server.ts`, `web/src/App.tsx`.

## [0.172.0] — 2026-07-13
### Added
- **"Clear & refresh today" for the daily digest.** A button on the Insights digest card (and
  `POST /api/digest/refresh`) that regenerates today's digest from current data — re-renders the dated KB
  journal page and **resets the once-per-day post guard** so the scheduled EOD post re-sends the fresh
  version. Useful right after tuning the digest, or to rebuild a stale day. The reset is append-only: it
  writes a `digest.cleared` marker, and the post/​retry guard now floors on the later of midnight and the
  last clear (`Digest.clearAndRefresh` / `postFloor`). `src/edge/digest.ts`, `src/server.ts`.

## [0.171.0] — 2026-07-13
### Added
- **Tasks: "Live" filter** — a toggle in the Tasks filter bar (beside Overdue) that narrows every view to
  only the tasks with a **running session** (a task whose `lastSessionId` resolves to an alive session).
  The pill carries the current live count and a pulsing dot; works across Board, List and Focus, and
  clears with the other filters. Complements the board's Live column and the fleet strip — one click to
  see just what's executing right now.

## [0.170.0] — 2026-07-13
### Changed
- **Daily digest — much higher signal per line.** Three fixes from real fleet output:
  1. **Richer lines.** Each line was the 72-char session *title*, which kept chopping the outcome
     (*"…Root cause was…"*). It now uses the first sentence(s) of the agent's actual `report`, clipped at a
     sentence/word boundary near 200 chars — so the result survives.
  2. **Routine repeats collapse.** Near-identical scheduled runs (e.g. 3× *"PPU fleet sweep — all healthy"*,
     3× *"Daily GSC report"*) fold into one line with a **×N** count, via token-similarity + leading-word
     clustering. Distinct work (six different PRs) stays separate.
  3. **Outcome over task.** Sessions with no report fell back to their incoming task (*"Task: verify…"*),
     and inter-agent `ask` sessions leaked in (*"Ask ← foo"*) — both are now dropped from the changelog
     (still counted in the header). Validated against the reported globex digest. `src/edge/digest.ts`.

## [0.169.1] — 2026-07-13
### Changed
- **Overview "Online now": people and agents now share one presence-row UI.** Agents render as the same
  avatar-circle + online-dot + name + subline (`N live sessions`) + status row as people (each its own
  labelled "People" / "Agents" group), instead of the pill chips — so the widget reads as one list.

## [0.169.0] — 2026-07-13
### Changed
- **Tasks — List and Focus views redesigned** (completing the Board redesign from 0.167.0; the three now
  share one visual language — state dots, priority pips, the live-session treatment). **List** is now a
  dense, grouped triage queue instead of a flat table: a **Group by** control (Priority / Status /
  Assignee / None) pivots the whole list, each row carries a state dot + priority pips + inline goal/
  blocker/label chips, a live row shows an inline **live · m:ss** marker, and hovering an agent-assigned
  queued/blocked task reveals a **quick-dispatch** (`↻ dispatch`) action; live rows one-click **attach**.
  **Focus** is a new master–detail mode (third view toggle, `PanelLeftOpen`): a queue rail on the left,
  the full task record inline on the right — no modal — so selecting a task swaps the record in place.
  The detail's **Activity** is now a **typed timeline** (dispatch = amber, status/claim = sky, comment =
  slate) with a live-session banner + attach at the top. The modal drawer (Board/List) and the Focus
  panel render the **same** detail body, so a task edits identically in both. The remembered view
  persists per browser. `web/src/App.tsx` only; motion is `motion-safe`.

## [0.168.2] — 2026-07-13
### Fixed
- **Insights page now uses the full content width.** It carried a `max-w-5xl` cap with no `mx-auto`, so it
  sat left-aligned and left the right side empty — worse when the sidebar was collapsed. Removed the cap so
  it fills the available width, and the card masonry now scales to a **third column on very wide screens**
  (`columns-1 md:columns-2 2xl:columns-3`).

## [0.168.1] — 2026-07-13
### Changed
- **Overview layout refinements.** The four KPI tiles are now compact single-row cards (icon · figure ·
  label). The "Online now" widget moves into the right rail (replacing the Fleet-now donut) and lists
  **only online people** (no offline members). Agent names now render with their agent icon everywhere
  they appear — working-now cards, the online-agents chips, and the best-agents leaderboard.

## [0.168.0] — 2026-07-13
### Added
- **Overview: "Online now" panel + human/agent presence.** The owner Overview now shows who's around at a
  glance — human members with a live/offline presence dot ("Online" / "3m ago"), and the agents that are
  online (≥1 active session) as click-through chips with a live-session count. Backed by lightweight
  presence: a new `last_seen_at` on `auth_sessions` stamped ≤1×/min in `TeamStore.resolveSession` (folded
  into the existing sliding-expiry write, so no new hot-path cost), a `TeamStore.presence()` roll-up, and
  a new any-member `GET /api/presence` (`{ now, lastSeen }`) polled every 15s; "online" = seen in the last
  3 minutes, computed client-side against the server clock.
### Changed
- **Overview visual polish.** A greeting header with a one-line fleet status, KPI tiles reworked with
  tinted semantic icon badges (Active/Idle/Blocked/Done), and tightened spacing/hierarchy throughout.

## [0.167.1] — 2026-07-13
### Fixed
- **Resolved recommendations no longer linger on Insights.** Recommendations regenerate only when a full
  reflect pass runs, so a card could persist after a human already acted between passes — e.g. "Raise
  default effort to high" kept showing after effort was set to `high` in Settings (no pass had run since
  it was proposed). `/api/dreaming` now drops any open recommendation whose condition is already resolved
  (`recommendationResolved` — currently the effort rec when effort is already high/xhigh/max) and persists
  the cleanup, so a stale card can't nag between passes. `src/edge/dreaming.ts`, `src/server.ts`.

## [0.167.0] — 2026-07-13
### Changed
- **Tasks Board, redesigned around live sessions.** The Kanban is reframed as a dispatch board — columns
  read **Queued / Live / Blocked / Done** (the machine's lifecycle, not the raw status names) with tinted
  rails. A **fleet strip** heads the board as an operations readout (live now / queued / blocked / done).
  The headline change: the **running session is shown inside the task**. A `doing` card whose
  `lastSessionId` resolves to an alive session (`api.sessions()` × `isLive`) grows a **live tape** — an
  animated equalizer, a ticking elapsed clock, the acceptance `criteria` as the target, attempt count +
  run-as owner, and a one-click **attach** to the tmux pane; a `doing` card whose session has ended shows
  a re-dispatch affordance instead. A **live dock** along the bottom is a transport bar for the fleet —
  every running session named with the task it lives in, one click to attach. Priority now reads as
  **pips** (urgent → all lit) rather than a text label. Cards, drag-to-status, filters, blocker chips,
  the create form, the List view and the detail drawer are unchanged. `web/src/App.tsx` only; motion is
  `motion-safe` (stills for reduced-motion).

## [0.166.1] — 2026-07-13
### Changed
- **Insights page uses a responsive 2-column (masonry) layout** so more of the intelligence fits above the
  fold — the status hero stays full-width, then the cards (Is it working?, scorecard, friction, guidance,
  recommendations, review history, digest, settings) flow into two columns on wide screens and a single
  column on narrow ones. `break-inside-avoid` keeps each card whole; page widened `max-w-3xl` → `max-w-5xl`.

## [0.166.0] — 2026-07-13
### Added
- **Proactive insight alerts — the intelligence layer comes to you.** Instead of waiting for someone to
  open Insights, the hourly tick now detects notable conditions and pushes each to the **admins' Inbox**
  (+ a Slack/Discord DM): a **struggling agent** (≤25% success over ≥4 runs), a **capability that keeps
  getting rejected** (≥5×), a **fleet success-rate drop** (≥15 points week-over-week), and **approvals
  piling up** (≥3 pending, oldest ≥4h). New `src/edge/alerts.ts`; each alert has a stable key and a
  **3-day per-key cooldown** (a persistent problem pings once, not every hour). On by default, toggle on
  the Insights page (`insights_alerts`); a session-less `notification` card via `TerminalManager.postInsightAlert`;
  DM via `notifyInsightAlert`; audited `insights.alert` / `insights.alert.notified`. Validated on live data
  (flags agent-author at 13% and stripe.refund's repeated rejections; the cooldown suppresses a re-fire).

## [0.165.0] — 2026-07-13
### Added
- **Root-cause diagnosis on the Insights scorecard.** The scorecard says *which* agent is struggling; a
  **Diagnose** button (on any agent below 50% with ≥2 failed/stopped runs) now answers *why*. New
  `src/edge/diagnosis.ts` spawns a governed headless **analyst** agent that reads that agent's recent
  FAILED / STOPPED / PARTIAL runs, finds the recurring failure pattern, hypothesizes the root cause, and
  writes a short **Pattern · Likely cause · Suggested fix · Evidence** page to the Knowledge Base
  (`operations/diagnosis/<agent>`) + reports — same governed pattern as the consolidation gardener, on
  demand (it costs a run). The scorecard then shows a **diagnosis →** link for any agent that has one.
  `POST /api/insights/diagnose`; audited `insights.diagnose`. Gardener-powered half of the intelligence
  layer, on top of the deterministic scorecard/friction/measurement.

## [0.164.0] — 2026-07-13
### Added
- **Answer an agent's question by replying to the Slack/Discord DM.** When an agent uses `ask_human`, the
  out-of-band DM is now a real reply surface, not just a heads-up + link: the notifier binds the question
  to each recipient's DM (`question_dms` table), and an inbound DM reply from that user is matched to their
  newest still-pending bound question and recorded as the answer — attributed to their member email,
  `canViewQuestion`-gated, audited `question.answered.viaDm`, then acked in-thread. The blocking agent
  picks it up through the existing `ask` poll (no agent-side change). A DM that isn't answering a pending
  question still falls through to the normal chat router. The DM copy now says "*Reply to this message to
  answer*, or open the Inbox." `src/edge/slack-socket.ts`, `src/edge/discord-socket.ts`,
  `src/edge/automations.ts`, `src/terminal.ts`, `src/tenant-registry.ts`, `src/state/db.ts`.

## [0.163.1] — 2026-07-13
### Changed
- **The "Dreaming" nav is renamed "Insights"** (route `#/dreaming` → `#/insights`, 🌙 → 💡). The surface
  evolved this release from a self-learning loop into the OS's **owner-intelligence layer** (fleet
  scorecard, friction map, "is it working?" measurement, plus the guidance/recommendations) — so the nav,
  the page content, and the new `GET /api/insights` endpoint now all say the same thing. The internal
  engine vocabulary is unchanged (Dreamer / reflect / `dreaming_state` / the reflect pass); only the
  user-facing surface renamed. Docs' console-location refs updated to the Insights page.

## [0.162.0] — 2026-07-13
### Added
- **Owner Overview page** — a new owner-only Home (`#/overview`, top of the sidebar) that answers "what is
  the fleet doing right now, and which agents are pulling their weight" at a glance:
  - **Sessions summary** — Active / Idle / Blocked / Done-today tiles derived live from the sessions feed
    (blocked = runs with a pending approval/question awaiting a human).
  - **Working now** — every live session as a rich card: agent, one-line task, live/unattended/blocked
    state, the accountable run-as human (`PrincipalTag`), origin chip (Discord/Cron/Task/Manual…), and how
    long it's been running; click to attach.
  - **Fleet-now donut** — active/idle/blocked agent split.
  - **Best agents** — a trust leaderboard ranked by the real agent-stats `maturity` score (autonomy ×
    (1 − denial) × volume), with run volume and 👍/👎 outcomes.
  - Pure-props off the data the console already polls, so it live-updates on the 1.5s tick with no new
    server route; visibility is gated to `owner` (nav anchor + route render).

## [0.161.0] — 2026-07-13
### Added
- **Dreaming as an owner-intelligence layer — per-agent scorecard + friction map.** Beyond the
  agent-facing guidance, Dreaming now surfaces the two questions an owner asks first. New
  `src/edge/insights.ts` computes deterministically over the audit log: a **fleet scorecard** (each
  agent's runs, success rate, and what it actually works on, last 30 days — session outcomes joined to
  the real agent, not the run-as principal) and a **friction map** (capabilities that keep getting
  rejected at approval → deny or auto-allow; approvals waiting on a human). Rendered as two cards high on
  the Dreaming page. Also exposed standalone at **`GET /api/insights`** (with the measurement bundle) so
  an owner dashboard can consume the intelligence directly, decoupled from the page. On live data it
  flags e.g. `stripe.refund` rejected 30× and each agent's win rate.

### Changed
- **`docs/PILLARS.md`: added Pillar 17 — Media (generate · edit · understand).** The media capabilities had
  shipped but weren't reflected in the pillar map. Added the summary-table row + a full detail section
  covering `image_generate` (text→image), `image_edit` (prompt edit · upscale · `remove-background`),
  `video_generate` (text→video **and** image→video, async job model), and `video_understand` (video→text),
  the Atlas-primary backend model, the shared timeout/retry resilience (`src/edge/vendor-fetch.ts`), and a
  cross-reference from Pillar 14 (Library) noting generated media is `ingest`ed there. Docs only.

### Fixed
- **Same timeout/retry resilience now applies to `video_generate`.** The video backend
  (`src/edge/video-gen.ts`, fal + Atlas) previously had no timeouts and would mark a whole render
  **failed** on a single transient poll blip. The image resilience helpers were extracted to a shared
  `src/edge/vendor-fetch.ts` (`timedFetch` + `withRetry` + `VendorError`) and applied to video:
  - **Timeouts** on every call — 30s submit, 15s per poll, 60s mp4 download.
  - **Bounded retry** (3×, backoff + jitter) around the submit and the mp4 download on transient failures
    (network/timeout, 429, 5xx).
  - **Poll blips no longer kill the job.** A transient poll error now returns `rendering`, so the job
    survives and the **next Automations tick re-polls** (bounded by `VIDEO_MAX_POLLS`/TTL) instead of a
    one-off network hiccup marking a paid render `failed`. An explicit vendor `failed`/`cancelled` status
    or a 4xx still fails as-is.
  - **Error attribution**: a submit failure now carries the vendor + retryable flag out to
    `video_generate error: …` (not `memory error: …`), telling the agent whether to retry.
  Docs updated in `docs/agent-mcp-tools.md`. Verified live: normal submit, transient submit → retryable
  error, transient poll → `rendering` (not `failed`), and the image path still passes through the shared
  helpers with no regression.

## [0.159.0] — 2026-07-13
### Added
- **Dreaming "Is it working?" — the measurement loop (closes audit finding G1, the reason Pillar 10 was
  🟡).** The self-learning loop ran, but nothing proved that injected guidance / applied recommendations
  actually moved outcomes. New `src/edge/measurement.ts` computes, from real session outcomes: a
  **success-rate trend** over the last 8 weeks (distinct-session counting, matching the reflect pass) and,
  per **applied recommendation**, the success rate in the window **before vs after** it — with sample
  sizes and a verdict (improved / declined / flat / too-early). Surfaced as an "Is it working?" card on
  the Dreaming page (trend bars + "did your changes help?"). Honest about being correlational, not a
  controlled A/B. On live data it shows the fleet's success rate climbing and the one applied
  recommendation ("raise effort to high") correlating with +18 pts. `/api/dreaming` returns `measurement`.

### Added
- **`ask_agent` — synchronous agent→agent Q&A.** An agent can now ask ANOTHER agent a question (or to
  solve something) and block inline on the answer, without filing a task. `ask_agent({ agent, question })`
  spawns the target agent as a one-off headless governed session (provenance `ask:<caller>`, run-as
  passthrough, every effect still gated), primed with the question; the caller long-polls until the
  delegate returns its result via the new delegate-only `answer` tool, then resumes with it. An ephemeral
  request/response backed by the new `agent_asks` table — no task board / inbox surface. Self-heals: a
  delegate that dies without answering (past a grace) fails the caller out instead of hanging. Same wait
  envelope as `task_wait` (`AOS_TASK_WAIT_S`, max 6h). New routes `POST /api/ask-agent` + `GET
  /api/ask-agent/:id` + `POST /api/agent/answer`; audited `agent.asked`/`agent.answered`.
  `src/memory/memory-mcp.ts`, `src/terminal.ts`, `src/server.ts`, `src/state/db.ts`, `docs/agent-mcp-tools.md`.
### Changed
- **`ask` renamed to `ask_human`** to disambiguate it from `ask_agent` — it asks a *person* and DMs them
  on Slack/Discord (the human answers from the web console Inbox; the DM is a heads-up + deep link). `ask`
  is still accepted as a hidden alias so in-flight prompts don't break. `src/memory/memory-mcp.ts`.

## [0.157.4] — 2026-07-13
### Fixed
- **Dreaming robustness batch** (third of the sequenced audit fixes, after timing v0.150.2 + staleness v0.157.1):
  - **M1 — no lost-update race.** A manual "Review now" and the scheduler tick both call `dream()`, which
    read-modify-writes `dreaming_state` with an `await` in the middle; concurrently they'd lose a pass's
    counts and double the marker. Now serialized per tenant (one in-flight pass; the loser no-ops `busy`).
  - **M3 — bounded digest retry.** `digest.posted` is written only on success, so a day-long Slack/Discord
    outage re-attempted every hour (flooding audit + rewriting the KB page). Now caps at 3 attempts/day.
  - **M4 — consolidation no longer drops a failed batch.** The watermark advanced at gardener *kickoff*, so
    a crashed/killed run lost its episodes+lessons forever. The next run now re-includes a previous run's
    window if it never reported, and skips if the previous run is still running (no stacking).
  - **L1 — corrupt state can't spread NaN.** A partial/schema-drifted `dreaming_state` is now normalized on
    load (numeric totals, object topics, array recent), so the fold's `+=` can't propagate `NaN`.
  - **L3 — accurate error friction.** The friction "errors" signal now counts `session.error` (real run
    errors) instead of `episode.error` (memory-store failures), so guidance reflects actual run outcomes.
  `src/edge/dreaming.ts`, `src/edge/digest.ts`, `src/edge/consolidation.ts`.

## [0.157.3] — 2026-07-13
### Fixed
- **Select triggers showed a raw id after picking an owner/assignee/goal.** On the Goals and Tasks
  pages the owner/assignee/goal dropdowns rendered options with a friendly name but, once selected,
  the trigger fell back to base-ui's raw value and displayed the internal id (e.g. `m_9178…`). Each
  now passes a render-function `SelectValue` (matching the sessions owner-filter pattern) that maps the
  id back to a display name — Goals **Owner** (create + detail), Tasks **Assignee**/**Goal** (create +
  detail). `web/src/App.tsx`.

## [0.157.2] — 2026-07-13
### Fixed
- **Internal links open in the same tab, not a new one.** The markdown renderer's `<a>` hardcoded
  `target="_blank"` for every link, so a `[[wiki]]`/`#/route` link inside a KB page, task/goal body,
  artifact, or doc spawned a new tab instead of navigating in place via the hash router. It now only
  opens external `http(s)` URLs in a new tab; in-app `#…` links stay in the same tab — matching the
  `InlineLinks` behaviour already used in inbox cards and memory notes. `web/src/App.tsx`.

## [0.157.1] — 2026-07-13
### Fixed
- **Dreaming staleness — guidance and topics no longer nag or accumulate forever.**
  - **Guidance + recommendations now derive from a RECENT window (H4).** They read the last ~7 per-pass
    tallies instead of ever-growing lifetime totals, so a friction signal that has since subsided (a
    budget stop or rejection months ago) stops riding in every agent's prompt and stops re-proposing.
    Verified: a state with heavy lifetime friction but a clean recent window emits none of the friction
    lines/recs; a recent window with friction emits them.
  - **Topics decay by recency + are pruned (M6/L2).** "The fleet frequently works on …" ranked topics by
    all-time count, so an old burst dominated forever and the map grew unbounded. Topics now rank by a
    recency-decayed weight (3-week half-life) so current work wins, drop after 90 days unseen, and are
    hard-capped at 300 keys. Verified on live data (topic map capped from a larger accumulated set).
  Second of the sequenced Dreaming audit fixes (after timing, v0.150.2). `src/edge/dreaming.ts`.

## [0.157.0] — 2026-07-13
### Added
- **Connect GitHub from your profile.** The per-member GitHub connection (the `GithubMineCard` — Connect/
  Disconnect + live install status) now also appears on the **Profile** page, in a **My git identity**
  section right above **My chat identities** — the natural, discoverable home for "link my own account"
  (it also auto-fills your `github` handle below on connect). Same component as Connections → Mine, so one
  implementation. The OAuth round-trip now **returns you to the page you started on** (profile or
  Connections) instead of always dumping you on Connections: `/api/github/connect` takes a `return` hash
  that the callback restores, open-redirect-guarded to safe in-app routes. (`web/src/App.tsx`,
  `web/src/connectors.tsx` — `GithubMineCard` exported, `src/server.ts` — return-path in the OAuth state;
  `scripts/github-per-member-test.cjs` now 73/73.)

## [0.156.0] — 2026-07-13
### Fixed
- **`image_generate`/`image_edit` no longer fail ~1-in-3 on a transient hiccup — and the error names the
  right subsystem.** Three defects in the image path (`src/edge/image-gen.ts`, `src/memory/memory-mcp.ts`):
  - **Timeouts.** Every vendor `fetch` now has an explicit `AbortSignal.timeout` — 30s submit, 15s per
    poll, 60s image download — so a hung socket can't hang the tool.
  - **Retry on transient failures.** Submit + download retry up to 3× with exponential backoff + jitter on
    a network error/timeout, **429**, or **5xx**; a single poll that blips is tolerated until the render
    deadline. **Not** retried (a real answer): any 4xx / content-policy rejection or an explicit vendor
    `failed` status. Retryability lives in one place (`VendorError.retryable`), and the existing
    model-fallback path keys off the same signal, so a bad model still falls back instead of blind-retrying.
  - **Correct error attribution.** A network failure during image generation used to report itself as
    `memory error: fetch failed` (wrong subsystem). The tool wrapper now names the actual tool
    (`image_generate error: …`) and appends the **vendor** + whether the failure is **transient**, so the
    agent retries the retryable ones and fixes input on the rest instead of guessing.
  - The 90s render timeout is now actionable — it says how long it waited and that the prediction may still
    be in flight (check the Library before regenerating), not a bare "timed out".
  See `docs/agent-mcp-tools.md` → "Media tool resilience". Verified live (normal gen, transient-retry with
  correct `retryable`/`vendor`, and the model-fallback path all pass).

## [0.155.0] — 2026-07-13
### Changed
- **Dreaming page — plain-language, outcomes-first redesign.** The page read like a settings screen
  (it led with "reflect every N hours" + jargon: *reflect / gardener / episodes / Distil · Apply*). It
  now leads with **what the OS learned and did**: a one-sentence explainer + a live status line (last
  review, runs reviewed, success rate, next review, **Review now**), then **What it figured out** (the
  lessons steering agents, with the on/off toggle), **Things to consider** (the config suggestions),
  **Review history** (per-review from the cumulative state), the **Daily digest**, and finally
  **Settings** (cadence) at the bottom. Internal vocabulary is gone from the UI (it stays in the docs).
  New: `/api/dreaming` returns a compact `state` summary (passes/totals/recent) to power the header +
  history; the raw episode/lesson activity feed and its jargon labels are removed from this page (that
  granularity lives in Memory). No behaviour change to the engine. `web/src/App.tsx`, `src/server.ts`.

## [0.154.0] — 2026-07-13
### Added
- **Clickable links to KB pages, the Library, and other console areas — everywhere a reference is
  written.** A single `[[section/slug]]` wiki-link convention (the syntax the KB editor already
  advertised but never rendered) now resolves to a real link, and a bare `[[library]]` / `[[tasks]]`
  etc. links to that nav area.
  - **Markdown surfaces** (KB pages, task/goal bodies, artifacts, docs): a new `remarkWikiLinks` remark
    plugin rewrites `[[…]]` → `#/kb/…` (or an area route) alongside remark-gfm's existing URL autolink;
    code spans are left untouched. `web/src/App.tsx`.
  - **Raw-text surfaces** (inbox cards — notification/approval/question bodies — and memory notes,
    which render pre-formatted, not markdown): a new `InlineLinks` renderer linkifies markdown links,
    `[[wiki]]` refs, bare URLs, and in-app `#/route` paths inline. Previously these were plain,
    non-clickable text. `web/src/App.tsx`.
  - **Terminal**: MCP tool responses now carry **absolute** console URLs — `kb_write`/`kb_read`/
    `kb_search` return the page's `#/kb/…` link, `publish` returns the artifact link, `library_list`
    a Library link — built from `AOS_URL`, so the browser terminal's WebLinks addon renders them
    clickable with no terminal-side change. `src/memory/memory-mcp.ts`.
  - **Dreaming** now emits its KB reference as `[[operations/fleet-learnings]]`, clickable in the
    Memory card via `InlineLinks`. `src/edge/dreaming.ts`.
  - Not covered (need a public base URL threaded into edge engines, which have none today): the daily
    **digest** Slack/Discord overflow footer and the session-activity primitive inspector still show
    plain `section/slug` text.

## [0.153.0] — 2026-07-13
### Added
- **Company-bot GitHub token — every session can push, no per-agent PAT needed.** Add the GitHub App's
  **App ID** + a generated **private key** (Connections → Creds → GitHub → *Company-bot token*) and the OS
  mints short-lived, org-scoped **installation access tokens** (acting as the App bot) that `git push` /
  open PRs on every installed repo. Injected as `GH_TOKEN` at launch for any session that doesn't already
  have a credential — so the per-agent `GH_TOKEN` PATs (and shared fallback PATs) can be **retired**: remove
  them and those agents fall through to the bot automatically. **Precedence:** a connected member's own
  token > an explicit agent `GH_TOKEN` (shellSecret/assigned) > the bot baseline — so human attribution and
  curated per-agent creds still win where they exist. The token is vault-cached (`github_bot_token`) so the
  synchronous launch path reads it without a network call, auto-refreshed near expiry; saving the creds
  mints once to validate + pre-warm (audited `github.bot_token.minted`/`.failed`), and the card shows a
  **Company-bot token: active** badge. Reuses the existing minter (`appJwt`/`mintInstallationToken`/
  `InstallationTokenCache`). (`src/connectors/github.ts`, `src/edge/github-identity.ts`, `src/terminal.ts`,
  `src/governance/settings.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`;
  `scripts/github-per-member-test.cjs` now 70/70. See `docs/per-member-github-plan.md`.)

## [0.152.0] — 2026-07-13
### Added
- **Fork a session.** A new **Fork** action (⑃) on the Sessions list branches any claude-code session with
  a conversation into a NEW, independent session that inherits the parent's full context — like
  `claude --resume` but into a separate branch rather than continuing in place, so the original transcript
  is left completely untouched and the two diverge from the branch point. The fork gets its own session id,
  tmux pane, and a new claude session id; it runs in the SAME agent folder (the transcript is keyed to it)
  and inherits the parent's run-as identity, with the forking member as provenance. Works on a finished or
  in-flight run alike (forking reads the transcript, not the live pane). Verified empirically that
  `claude --resume <parent> --fork-session --session-id <new>` honors our chosen id and preserves context.
  (`forkSession` + `forkable` flag in `src/terminal.ts`, the `FORK_FROM` launch path in
  `terminal/claude-launch.sh` — checked AFTER `RESUME` so a reattach resumes the branch instead of
  re-forking, `POST /api/sessions/:id/fork` in `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`.)

## [0.150.2] — 2026-07-13
### Fixed
- **Dreaming timing — three correctness bugs in the reflect loop's windowing (audit-driven).**
  1. **Cadence survives restarts (H1).** The scheduler's `lastDream` clock was in-memory, so every
     restart (frequent — each build/deploy) reset it and the next tick fired a pass immediately,
     turning "reflect every 24 h" into "reflect on every restart" — and each pass spawns a **billed**
     consolidator agent. The clock now seeds from the durable `learning.dreamed` audit ts (mirroring the
     digest's `digest.posted` guard). `src/server.ts`.
  2. **No more skipped episodes at the window edge (H2).** The pass windowed on the run clock, but
     episodes are stored asynchronously, so one landing just after a pass could fall into the gap and be
     counted by neither pass. The window now advances a separate **data high-water mark** (newest ts
     actually consumed), kept distinct from the cadence clock. Migration-safe (falls back to the old
     marker). `src/edge/dreaming.ts`.
  3. **Accurate session count (H3).** A single session emits several terminal audit rows
     (`session.reported` + `session.ended` + crash sweeps); the pass counted rows, inflating the session
     total — on live data **106 rows → 70 real sessions** (+51%), which skewed the success rate that
     drives guidance + the "raise effort" recommendation. Now collapses to one canonical row per session
     (prefers the agent's reported outcome). `src/edge/dreaming.ts`.
  Validated against a copy of live data. First of a sequenced set of Dreaming audit fixes.

## [0.151.0] — 2026-07-13
### Fixed
- **Per-member GitHub: "Connect" no longer shows a false green when the App isn't installed.** Authorizing
  a GitHub App (the OAuth step our Connect flow runs) and *installing* it on repos are two separate acts —
  so a member could connect, see "connected as @them," and have a token that can't touch a single repo
  because the App was never installed. `GET /api/github/me` now reports the token's **real installation
  status** (`GET /user/installations`): the *Mine* card shows "the App can act on N repos (accounts…)"
  when installed, or an amber **"authorized, but the App isn't installed on any repositories yet — pushes
  will fail; an owner needs to install it"** when not. Best-effort (a GitHub hiccup leaves status unknown
  rather than false-alarming). Turns a confusing silent failure into an actionable prompt.
  (`userInstallationStatus` in `src/connectors/github.ts`, `src/server.ts`, `web/src/connectors.tsx`,
  `web/src/lib/api.ts`; `scripts/github-per-member-test.cjs` now 59/59.)

## [0.150.2] — 2026-07-13
### Fixed
- **A goal's Target field couldn't be edited** from the goal-detail dialog. The inline `<Input>`'s
  `onChange` optimistically wrote each keystroke into `detail.goal.target` — the same value its `onBlur`
  save-guard (`v !== detail.goal.target`) compared against — so the guard was always false and the PATCH
  never fired. Made the input uncontrolled (`defaultValue` keyed to the goal id, dropping the
  self-defeating `onChange`) so blur compares the typed value against the unchanged server value and saves.

## [0.150.1] — 2026-07-13
### Changed
- **The "Learnings" nav is renamed "Dreaming"**, matching the established vocabulary (Pillar 10 is
  "Dreaming / Self-learning"; the engine is the *Dreamer*, the action is *Reflect*). "Learnings" was a
  one-off coinage. Route `#/learnings` → `#/dreaming` (safe — it only shipped in 0.150.0), icon 💡→🌙
  (`Moon`), and the page gains a one-line intro framing it as the *Distil · Apply* half of the four-verb
  memory loop (`memory-model.md`). Docs realigned to the new top-level location: `PILLARS.md` §9/§10 +
  the Self-learning toggle note, `self-learning-plan.md`, `daily-digest-plan.md`, `procedural-skills-plan.md`
  no longer point at the old "Memory hub → Self-learning tab" / "Settings → Self-learning".


## [0.150.0] — 2026-07-13
### Changed
- **"Learnings" is now its own top-level nav.** The self-learning surface — reflect cadence, distilled
  guidance + the Apply toggle, config recommendations, the **daily digest** (config + live preview), and
  recent learning activity — was buried as a second tab inside **Memory**. It had outgrown that: Memory is
  the *store*, Learnings is *what the OS does with it + how it reports*. Promoted to a top-level
  admin-only nav item (`Lightbulb` icon, `/learnings`); Memory goes back to single-purpose (the
  Self-learning tab is removed, not duplicated). `DreamingSettings` renders unchanged at the new route.

## [0.149.0] — 2026-07-13
### Added
- **Daily digest now posts to Discord too (and Slack, and both).** The end-of-day digest was Slack-only,
  but a tenant may run Discord instead — the live northwind tenant has a Discord bot and no Slack, so the
  digest couldn't post at all there. `Digest.postNow` now fans out to **every configured chat platform**:
  Slack (if a bot token + `digestChannel`) and/or Discord (if a bot token + `digestDiscordChannel`, a
  channel id — Discord posts by id, no name lookup). New `renderDiscord` uses Discord markdown and honours
  the 2000-char cap (trims to the daily KB page). The once-per-day `digest.posted` guard and EOD hour gate
  are unchanged and cover both platforms; per-platform failures are audited (`digest.error`) without
  blocking the other. Settings → Learning shows a channel field per configured platform. New setting
  `digestDiscordChannel`; `discordChannel`/`discordConfigured` added to `GET`/`PUT /api/dreaming`.

## [0.148.0] — 2026-07-13
### Added
- **Task blocker chips on the Kanban board cards.** A card now shows the tasks it's *blocked by* directly —
  each blocker as a small chip resolved to its title, amber `⏳` when the blocker isn't finished yet and a
  struck-through muted `✓` once it's `done`/`cancelled`, unmet ones sorted first. Clicking a chip opens that
  blocker; a card with more than three blockers shows a `+N` that opens the task's Dependencies drawer. This
  replaces the bare `⏳ waiting on N` count that used to sit in the card's meta row, so the dependency chain
  is legible at a glance without opening each task (the drawer's full "Depends on" / "Blocks" editor is
  unchanged). No API change — chips resolve titles from the board data already loaded.

## [0.147.0] — 2026-07-13
### Added
- **Daily digest — an end-of-day "what got done today" standup, posted to Slack.** A tenant-wide summary
  in two halves: **📋 Today** (the per-session changelog, grouped by agent) + **🧠 Learned** (Dreaming's
  distilled guidance + open recommendations). The changelog needs no new capture — every session end
  already writes a deterministic episode (`writeEpisode` → `composeEpisode`), so the digest is a pure
  read + render (no LLM). The body thresholds on `episodeSalience` importance so a busy day of low-value
  test runs doesn't drown the real work; a `done` session with a substantive report title is always
  included (it may carry no episode yet still shipped a PR). Rides the **Dreaming pass**, not a new timer:
  the dashboard/KB render live on demand, and only the Slack post is time-gated — once per server-local day
  past `digestHour` (default 18), guarded by a `digest.posted` audit. Manual **Reflect now** / **Post now**
  refresh the KB page but the channel is pinged solely by the scheduled end-of-day run. Each day lands a
  dated, revisioned KB journal page (`operations/daily/<date>`). New config in **Settings → Learning**
  (enable, channel, hour) with a live "today so far" preview; endpoints `GET /api/digest/today` +
  `POST /api/digest/post`, and digest fields on `GET`/`PUT /api/dreaming`. See `docs/daily-digest-plan.md`.

## [0.146.0] — 2026-07-13
### Added
- **Assign a secret to agents from the Secrets page — no manifest edit, no re-entering the value.** Granting
  an agent a stored credential used to mean two manual steps: store the value under that agent's principal
  AND add the key to its manifest `shellSecrets`. Now each secret on **Settings → Secrets** has an
  **"assign to agents"** control: toggle agents on/off and the OS injects that secret as a shell env var
  (named after its key) into each assigned agent's session at launch — the inverse view of `shellSecrets`,
  managed centrally. A single canonical value backs all assignees (new `secret_assignments (tenant, owner,
  key, agent)` join table); assigning references the secret by its `(principal, key)` so one shared value can
  fan out to many agents without duplication. **Injection only** — an assignment never widens who can
  `secret_get` a value (unchanged, non-breaking). `injectAssignedSecrets` runs alongside the manifest path at
  launch (audited `shell.secret.injected`/`unresolved` with `via:'assignment'`); assignments are cleaned up
  when the secret is deleted. New route `PUT /api/secrets/agents` (owner/admin; unknown agent ids dropped),
  and `GET /api/secrets` now returns each secret's assignment list. Audited `secret.assigned`.
- **Daily digest — an end-of-day "what got done today" standup, posted to Slack.** A tenant-wide summary
  in two halves: **📋 Today** (the per-session changelog, grouped by agent) + **🧠 Learned** (Dreaming's
  distilled guidance + open recommendations). The changelog needs no new capture — every session end
  already writes a deterministic episode (`writeEpisode` → `composeEpisode`), so the digest is a pure
  read + render (no LLM). The body thresholds on `episodeSalience` importance so a busy day of low-value
  test runs doesn't drown the real work; a `done` session with a substantive report title is always
  included (it may carry no episode yet still shipped a PR). Rides the **Dreaming pass**, not a new timer:
  the dashboard/KB render live on demand, and only the Slack post is time-gated — once per server-local day
  past `digestHour` (default 18), guarded by a `digest.posted` audit. Manual **Reflect now** / **Post now**
  refresh the KB page but the channel is pinged solely by the scheduled end-of-day run. Each day lands a
  dated, revisioned KB journal page (`operations/daily/<date>`). New config in **Settings → Learning**
  (enable, channel, hour) with a live "today so far" preview; endpoints `GET /api/digest/today` +
  `POST /api/digest/post`, and digest fields on `GET`/`PUT /api/dreaming`. See `docs/daily-digest-plan.md`.

## [0.145.0] — 2026-07-13
### Added
- **Idle member sessions now auto-close (configurable, default 48 h).** A member's own attachable session
  holds a `claude` process like any other, but — unlike a resident chat (idle-reaped in minutes) or an
  unattended automation run (torn down at turn-end) — nothing ever reaped it. A forgotten, detached one
  lingered for days, wasting RAM and (now that the concurrency cap is on) permanently occupying a cap slot,
  so scheduled work starved. `reapIdleSessions` gains a third sweep: a member (`headless=0`, non-resident,
  unclaimed) session idle past the timeout — nobody attached, not blocked on a person — is closed
  (`status=stopped`), and it stays **Resumable** (a deliberate console re-open clears the block), so it's a
  janitor, not a guillotine. Tunable at **Settings → Runtime defaults → "Auto-close idle sessions after
  (hours)"** (`interactiveIdleTimeoutHours`, default 48, `0` = off; clamped 1 h–30 days) via the extended
  `GET/PUT /api/settings/concurrency` (audited `settings.interactiveIdle.updated`). New
  `scripts/idle-reaper-test.cjs` (12 assertions: reaps a stale detached session; leaves recent / attached /
  claimed / unattended / recently-active / disabled cases alone).

## [0.144.0] — 2026-07-13
### Added
- **`ask` can now address a SPECIFIC teammate, not just the run's operator.** An agent could already `notify`
  any member with fire-and-forget info; now `ask({ question, to })` routes a BLOCKING question — "ask for a
  detail", "get a confirmation before a risky step" — to a named teammate (name/email) and waits for THEIR
  answer. Omit `to` and it behaves exactly as before (asks the session operator). The question card + the
  out-of-band DM target that member (`{ kind: 'member' }` audience via `notifyQuestionAsked`), and
  `canViewQuestion` now grants the addressed member (plus owner/admin oversight) the right to answer it — so
  a question sent to someone who is neither the run's owner nor an admin actually reaches a person who can
  reply. New nullable `questions.audience_id` column records the addressee (NULL = the default operator
  routing). Reuses the existing questions/inbox/DM machinery end-to-end.

## [0.143.1] — 2026-07-13
### Fixed
- **A cron automation missed in its scheduled minute is no longer silently dropped for the whole day.** A
  cron fires in exactly ONE minute (`cronMatches(now)`); if that minute was skipped — the box was over the
  concurrency cap, or mid-restart/deploy — the scheduler deferred it but, unlike a `once`/`task`, by the next
  tick `cronMatches` was false so the occurrence was lost until the next day. On a chronically over-cap box
  this dropped a daily report every single day (observed: globex's "Daily Support Quality Review" hadn't
  fired for 3 days — each 09:00 UTC minute the box sat at 9–10 alive sessions against a cap of 8). `tick()`
  now fires the most-recent *owed* occurrence within a bounded catch-up window (`CRON_CATCHUP_MIN`, 2 h),
  retrying each tick until headroom appears or the window closes — so a cap-deferral or a deploy over the
  scheduled minute self-heals, while a long outage never replays a stale backlog (only the single latest
  occurrence is owed, and it's abandoned once older than the window). New `recentCronOccurrence()` helper +
  `scripts/cron-catchup-test.cjs` (15 assertions incl. the exact over-cap→catch-up path).

## [0.143.0] — 2026-07-13
### Added
- **Whole-box concurrency cap is now ON by default (Phase 1 of `docs/concurrency-cap-plan.md`).** Every live
  session holds a `claude` process (hundreds of MB), so an unbounded burst of scheduled work can OOM the box.
  The scheduler cap — previously opt-in via `AOS_MAX_CONCURRENT_SESSIONS` and **0 (unlimited) by default** —
  now defaults to a **RAM-derived** value: `max(3, floor(totalGB / 1.5))` (a 2 GB droplet → 3; a 32 GB Mac
  Mini → ~21). Resolved live as **env override → operator Settings value → derived default** by the new
  `Automations.concurrencyCap()` (single source of truth; the old static `maxConcurrent` field is gone), so a
  change takes effect on the next scheduler tick with no restart.
- **Settings → Runtime defaults → "Concurrency cap".** A new owner/admin panel shows the live running-session
  count and the effective cap + where it came from (env / operator / box default), and lets you set it: blank
  = the RAM-derived default, `0` = unlimited, `N` = cap at N. Env-pinned installs show the value read-only.
  Backed by `GET/PUT /api/settings/concurrency` (audited `settings.concurrency.updated`).
### Fixed
- **The concurrency cap no longer silently disables itself when tmux liveness can't be polled.**
  `aliveSessionCount()` used to fail-open to `0` when `aliveNames()` returned null (always on the Linux
  `LauncherSessionBackend`; transient local hiccups) — turning the cap off under exactly the load it exists
  for. It now falls back to a pure DB count of `running` rows (new `runningSessionCount()`); the crash sweep
  keeps that set honest, so it's a safe proxy.

## [0.142.0] — 2026-07-13
### Added
- **Settings → System → Host resources now breaks down RAM by agent session.** Alongside the host
  totals, the panel lists each live session's resident memory — its process tree (shell → `claude`/node →
  MCP subprocesses) — plus a fleet total (e.g. "4.6 GB · 8 live"), sorted heaviest-first. So you can see
  exactly how much of the box's RAM the running agents are holding, and which session is the hog. Backed
  by a new `SessionBackend.sessionRss()` (one `tmux list-panes` + one `ps -Ao pid,ppid,rss` snapshot,
  summed over each pane's process subtree — portable across macOS/Linux), surfaced via `sessionMemory()`
  on `TerminalManager` and the existing `GET /api/system`. RSS is approximate (shared library pages are
  counted per process, so the sum slightly over-reports). Not measurable under the Linux uid-isolation
  launcher backend (uid-private sockets) → shown as "not measurable here."

## [0.141.2] — 2026-07-13
### Fixed
- **Slack: a plain message in a channel the bot sits in no longer gets the `/agent` help list.** The app
  subscribes to `message.channels` so plain in-thread follow-ups reach thread-continuity — but that also
  delivers a `message` event for *every* channel post, and a non-continuation one fell through to
  `fireSlack` → the `/agent` router, which replied "👋 Address an agent…" to ordinary channel chatter. The
  socket now only starts a fresh run on an explicit **@mention** (`app_mention`) or a **DM** (`im`/`mpim`);
  a plain channel message matters only as a thread continuation, otherwise it's dropped silently. Brings
  Slack to parity with Discord, whose parser already ignores non-mention guild messages.

## [0.141.1] — 2026-07-13
### Fixed
- **Unattended (automation/cron/task) sessions no longer leak a live pane after they finish.** An agent that
  ends by calling `report` flips its row to `done` mid-turn, so by the time the turn-end Stop beacon reached
  `markTurnIdle` the status was already terminal and the teardown bailed on `status !== 'running'` — the
  interactive TUI kept running forever (observed: dozens of orphaned tmux panes + claude processes, some 20h+
  old, all belonging to `done` sessions; `session.reaped` had fired only once). `markTurnIdle` now reaps an
  unattended run whose pane is still alive even when `report` already marked it `done` (still honoring
  claimed / attached / blocked-on-human), skipping an already-dead pane via a liveness poll so a stray second
  beacon can't re-reap. The idle backstop (`reapIdleSessions`) likewise sweeps `done` unattended rows that
  still hold a live pane — cleaning up any that predate the fix or whose Stop beacon never landed. Net: a
  finished background run stops for real, and the session list stops showing it as "live".

## [0.141.0] — 2026-07-13
### Added
- **Settings → System now shows live host resources.** A new "Host resources" panel reports memory
  used/free/total with a usage bar, CPU utilization (sampled server-side) + core count + model + load
  average, Node process RSS/heap, process & host uptime, running-session count, and host platform/arch —
  polled every 4s. Backed by a new owner/admin-gated `GET /api/system` (Node `os` + `process.memoryUsage`).
- **"Stop all sessions" button in Settings → System.** One click halts every running agent session
  tenant-wide via `POST /api/sessions/stop-all` (owner/admin, audited `sessions.stop_all`) — a softer
  sibling of the Governance kill switch: it stops the fleet but leaves the gate open, so new runs can still
  be launched. Reuses the existing `TerminalManager.stopAllRunning`, so each session's inbox/audit reflect
  the halt.

## [0.140.0] — 2026-07-13
### Added
- **`video_understand`: agents can now "watch" a video (video → text).** Claude can't see video natively;
  this new governed MCP tool delegates to an Atlas **multimodal LLM** (the ~10 catalog models with video
  input — qwen3.5, glm-5v, kimi-k2…) via the OpenAI-compatible chat endpoint and returns a **text**
  answer directly (no artifact). Pass `video` (a Library artifact id — e.g. one `video_generate` just made
  — a working-folder file written *or* terminal-uploaded, or an http(s) URL) and an optional `prompt`
  ("summarise", "transcribe on-screen text", "what happens at the end?"); omit it for a general
  description. Local files are inlined as base64 (no hosting needed). Also handles stills with
  `kind:"image"`. Governed like the other media calls: classified `video.understand` with a cost estimate
  (money-cap applies), audited `video.understood`. New backend `src/edge/media-understand.ts`, route
  `POST /api/agent/video/understand`, default model `qwen/qwen3.5-27b`; exposed whenever Atlas is
  configured (`VIDEO_UNDERSTAND`). Verified live (correctly described a test clip).
- **`image_edit` gains a `remove-background` preset.** Alongside prompt-guided edit and upscale, agents can
  now cut out an image's subject with `image_edit({ image, operation: "remove-background" })` — no prompt
  needed. It returns a **transparent PNG** saved as a new Library image (source untouched), via Atlas's
  dedicated `youchuan/v8.1/remove-background` model. Same governed `generateImage` submit+poll as the other
  edit modes (`operation` takes precedence over `scale`/`prompt`), classified `image.edit` (money-capped),
  audited `image.edited` (op=remove-background). Verified live (→ 822 KB transparent PNG).
- **An invalid/partial default image model no longer silently breaks generation.** A half-typed default
  (e.g. `google/` left in the Settings field) used to fail every `image_generate`/`image_edit` with a
  cryptic Atlas "not found". Now guarded two ways: (1) **console warning** — the default-model fields flag
  a value that isn't a known Atlas catalog id ("⚠ isn't a known Atlas model…"), for both image and video;
  (2) **graceful fallback** — if Atlas rejects a model id as not-found/invalid, the image backend retries
  once with the built-in default (`google/nano-banana-2/text-to-image` for generate, `…/edit` for edit,
  the upscaler for upscale) and the tool response + audit note which bad model was replaced (`fallbackFrom`),
  so the run succeeds and the operator sees a clear "fix the default" message instead of a dead end.
  (`AtlasBackend.withModelFallback` in `src/edge/image-gen.ts`; verified live — bad `google/` → auto-retry
  → success.)

## [0.138.3] — 2026-07-13
### Added
- **Docs: three new end-user Docs pages covering recently shipped surfaces.** The console **Docs**
  section lagged the last ~20 releases — whole feature areas (media generation, Goals, per-member
  GitHub/identity) had zero coverage. Added:
  - **Goals** — set the outcome, the fleet plans the work: goal vs. task, **Plan this goal** (the
    strategist drafts linked tasks), the opt-in **Auto-plan stuck goals** toggle, sub-goals/roll-up,
    and detach-on-delete.
  - **Media & the Library** — the Library as the deliverables gallery (live HTML rendering, PDF,
    per-artifact cost), `image_generate`/`video_generate`/image-to-video/image edit, and that
    generation is budget-metered + audited.
  - **Your identity, chat & GitHub** — **My context** (per-member prompt injection), **Chat IDs**
    (run-as via Slack/Discord), and **Connect GitHub** (commits/PRs authored as you) with the
    owner-once GitHub-App setup step.
  Wired into `web/src/docs/index.ts` between Automations→Shared-planes→Governance. Docs-only web copy;
  no API or schema change.

## [0.138.2] — 2026-07-13
### Fixed
- **Taking over an unattended session no longer breaks file attach with "session is not live."** Take-over
  (`claimSession`, `POST /api/sessions/:id/interactive`) flipped `headless→0`, set `claimed_by`, and cleared
  the resume sentinel — but, unlike the resume path (`markResumed`), it never set `status = 'running'`. A
  take-over can race the Stop-hook turn-end teardown, which may have already moved the run to `done`; the
  claimed-and-attached run then kept a terminal status, so everything gated on `status === 'running'` —
  notably `attachFile` — rejected the now-live, steerable session as "not live." Take-over now forces
  `status = 'running'` (the pane resurrects on re-open via the already-cleared sentinel), matching resume.
  The console's 📎 attach/drag/paste gate also now keys off the pane being **attached/live** (the same
  `isLive` rule the green dot uses, plus the just-took-over override) instead of raw `status`, so it stops
  lagging a poll behind a take-over; the server stays the hard authority.
  (`TerminalManager.claimSession`, `ImageDropZone` in `web/src/App.tsx`.)

## [0.138.1] — 2026-07-13
### Fixed
- **The Profile page now loads instead of bouncing to the Inbox.** `profile` was added to the `Route`
  type but not to the runtime `ROUTES` allow-list the hash router validates against, so navigating to
  `#/profile` fell through to the unknown-route fallback (`inbox`). Added `profile` to `ROUTES`. (`web/src/App.tsx`.)

## [0.138.0] — 2026-07-13
### Added
- **`image_edit`: agents can now edit or upscale an existing image, not just generate from scratch.** A new
  governed MCP tool takes a source **`image`** (a Library artifact id, a working-folder file path — written
  *or* terminal-uploaded — or an http(s) URL) and either a **`prompt`** (prompt-guided image-to-image edit,
  e.g. "make it a watercolor", "remove the background") or a **`scale`** of 2/4 (upscale). The result is
  saved as a **new** Library image (the source is never mutated) + an inbox card. Same governance as
  `image_generate`: classified `image.edit` with a cost estimate (money-cap applies), audited `image.edited`.
  Reuses the shared image-ref resolver (local files/artifacts sent inline as base64) and Atlas's
  `generateImage` submit+poll. Defaults: edit → `google/nano-banana-2/edit`, upscale → `atlascloud/image-upscaler`
  (override via `model`). Atlas-only (OpenRouter's image API is text-to-image). New route
  `POST /api/agent/image/edit`. Verified against the live Atlas API (edit + upscale both return images).
- **Per-member personal context + a self-service Profile page.** Each member can now add free-text
  **"My context"** that is injected into the system prompt of every session that runs **as them** (their
  working style, standing preferences, domain notes) — read at launch by `buildCompanyMd` and labelled as
  the operator's standing instructions, secondary to the task and the operating notes. Stored in the
  `member_prefs` blob (trimmed, capped at 8,000 chars), edited at `GET`/`PUT /api/me/context` (self-service,
  no role gate; audited `member.context.set`). A new **Profile** page (reachable from the sidebar profile
  row and the bell's gear) collects the member's *own* settings in one place: avatar + name, My context,
  notification preferences (moved off the notification bell, which is now feed-only), and their chat
  identities (Slack/Discord/email/GitHub run-as handles — a member may now edit their **own** handles; the
  `/api/team/:id/identities` routes accept self as well as admin). The **Team** page stays focused on
  managing *other* people (roster, roles, invites, agent access). (`ProfilePage`/`NotificationsBell` in
  `web/src/App.tsx`; `TeamStore.memberContext`/`setMemberContext`; `buildCompanyMd` in `src/terminal.ts`.)

## [0.136.1] — 2026-07-13
### Added
- **Docs: "Company context" concept in the console Docs → Core concepts page.** Explains what the
  fleet-wide Company context is and, in answer to a recurring question, that it's **flat text** — it
  can't `@import` or read other markdown files. Points reference docs to **Knowledge**, procedures to
  **Skills**, and one-agent context to that agent's own `CLAUDE.md`.

## [0.136.0] — 2026-07-13
### Changed
- **Attach ANY file to a live session, not just images.** The terminal's 📎 attach button, drag-and-drop,
  and Cmd/Ctrl+V paste now accept a file of any type (PDF, log, CSV, zip, …) instead of rejecting
  everything that isn't `image/*`. The file lands in the agent's `.inbox/` and its path is typed into the
  running claude exactly as before — the agent's Read tool opens it. The **original filename is now
  preserved** (basename sanitized, timestamp-prefixed to stay unique) so the agent sees `.inbox/<ts>-report.pdf`
  rather than an opaque `pasted-<ts>.png`; a nameless paste still falls back to `pasted-<ts>.<ext>`. The
  extension is derived from the filename first (then the MIME subtype). Backend storage was already
  type-agnostic; this drops the frontend `image/*` gate and threads the filename through
  (`api.attachFile`, `POST /api/sessions/:id/attach-file`, `TerminalManager.attachFile`). The ~12 MB size
  cap is unchanged.

## [0.135.0] — 2026-07-13
### Added
- **Image-to-video: agents can now animate an image, not just text→video.** The `video_generate` tool
  takes an optional **`image`** that accepts **any** place a session's image lives:
  a **Library artifact id** (e.g. from a prior `image_generate`), a **file path in the agent's working
  folder** (a file it wrote *or* one uploaded into the terminal session — resolved strictly under the
  agent folder via the same containment `publish` uses), or an **http(s) URL** (passed through to the
  vendor to fetch). Local files/artifacts are read and sent inline as a base64 data URL (no public hosting
  needed); when an image is supplied without a named model, an **image-to-video model** is chosen
  automatically (Atlas `bytedance/seedance-2.0/image-to-video`, fal `…/veo3/fast/image-to-video`). Fixes the
  Atlas seed field (`image`, not `image_url`) so the seed actually applies. Same governance as text→video
  (cost-metered, audited, async job → Library). Verified against the live Atlas API (base64 seed → prediction id).

## [0.134.0] — 2026-07-13
### Added
- **The Library now renders published HTML files as a live page**, not as raw source. HTML deliverables
  (dashboards, reports, one-off pages an agent builds) were already stored and served with the right
  `text/html` Content-Type — but the console preview pane showed their escaped source in a `<pre>` because
  `text/html` matched the generic text path. HTML artifacts now render in an `<iframe>` (same treatment as
  PDF), with an "Open full page ↗" link to view them standalone. The frame is **sandboxed to a null origin**
  (`allow-scripts allow-popups allow-forms`, deliberately *not* `allow-same-origin`): interactive HTML/JS
  runs, but the page can't reach the parent DOM, the session cookie, or the same-origin API. HTML artifacts
  also get a distinct code-file icon in the gallery. (`ArtifactBody`/`ArtifactIcon` in `web/src/App.tsx`.)

## [0.133.0] — 2026-07-13
### Added
- **`schedule` now resumes the scheduling conversation by default.** When an agent defers a follow-up
  with the `schedule` MCP tool (the "check back later" one-shot), the fired run used to start a **fresh**
  session with no memory of what it was waiting on — the agent had to cram all context into the task text.
  It now carries the scheduling session's pinned claude id (`resume_claude_id` on the `once` automation)
  through `tick → fire → createSession`, so the deferred run `--resume`s the SAME transcript: it wakes up
  with full context and reads the task as its next turn. This makes the "waiting on a Gmail reply / an
  external event" pattern actually work — finish now, and the future run picks up where you left off. Pass
  `resume: false` for a clean-slate run (unrelated future work, or a far-off schedule where reloading a
  stale transcript isn't worth it). Reuses the exact resume mechanism the Slack thread-continuity path
  already relies on; the console Automations page still lists and can cancel the scheduled run.
  (`Automations.schedule`/`fire`, `TerminalManager.sessionClaudeId`, `POST /api/agent/schedule`.)

## [0.132.0] — 2026-07-13
### Added
- **Model dropdowns show pricing (Settings → Integrations → Media generation).** The live Atlas catalog
  route (`GET /api/integrations/atlas/models`) now returns each model's effective (post-discount) base
  price — **per image** for text-to-image, **per second** for text-to-video — parsed from Atlas's
  `price.actual.base_price`. The console appends it to each dropdown option (e.g. `Nano Banana 2 — $0.04/image`,
  `Seedance 2.0 — $0.045/sec`) and shows a hint line under the field when the current value matches a
  catalog model. Free text + per-call override unchanged; console/route only, no schema change.

## [0.131.0] — 2026-07-13
### Added
- **Plain `git` now authenticates with the injected token, not just `gh`.** The GitHub token is exported
  as `GH_TOKEN`/`GITHUB_TOKEN` (which `gh` reads natively), but `git push`/`clone` over HTTPS doesn't use
  those on its own — so previously only half the toolchain was authenticated. Launch now also installs a
  **github.com-scoped git credential helper** via `GIT_CONFIG_*` env vars (no file writes, session-scoped,
  reads `$GH_TOKEN` at call time so a rotated token still works; resets any inherited helper first, uses the
  `x-access-token` username GitHub expects). So a session that has a token — a member's own or the agent
  bot's — can `git push` **and** `gh pr create` transparently. No-op when no token is present or for non-
  github.com/SSH remotes. (`TerminalManager.configureGitCredentials`; verified against real `git`.)
- **Sessions now nudge an unconnected member to link their GitHub.** When a session runs **as** someone
  who hasn't linked their own GitHub account, the launch context tells the agent so — so if the task
  involves pushing code or opening a PR, the agent `ask`s the right person to fix it instead of silently
  committing as the shared bot (or failing auth). Two cases, two messages: if the workspace **GitHub App is
  configured**, it points them at the **1-click Connect GitHub** (Connections → Connected → Mine); if **no
  App is set up**, it asks an **owner/admin** to create one first (Connections → Creds → GitHub → Create
  GitHub App). Fires only when acting as a real member who isn't connected — a connected member's token is
  injected and just works, and a pure automation (no run-as person) gets no personal steer. Contextual, so
  it only reaches a human when git is actually relevant. (`TerminalManager.buildCompanyMd`;
  `scripts/github-per-member-test.cjs` now 53/53.)

## [0.130.0] — 2026-07-13
### Added
- **Default-model pickers are now live dropdowns (Settings → Integrations → Media generation).** The image
  and video "Default model" fields became comboboxes backed by the **live Atlas catalog** — a new
  admin-only `GET /api/integrations/atlas/models` fetches `GET /api/v1/models` with the stored key, filters
  to `TEXT-TO-IMAGE` (~47) and `TEXT-TO-VIDEO` (~47) models, and caches per-key for 5 min. The console
  renders them as native `<datalist>` suggestions on the model inputs, so you can **pick from the current
  catalog or still type any id** (free text preserved). The list refreshes when the Atlas key changes; a
  fetch failure or missing key falls back to a plain free-text field. Agents can still override the model
  per call — this only sets the fleet default.

## [0.129.0] — 2026-07-13
### Added
- **One-click GitHub App setup — no more manual walkthrough.** The **Connections → Creds → GitHub** card
  now creates the company GitHub App for you via GitHub's **App-manifest flow**: click **Create GitHub App**
  (optionally naming an org), GitHub opens a pre-filled confirmation (name, this server's callback URL,
  least-privilege Contents + Pull-requests write, webhook off, private), and on confirm it creates the App
  and hands its **client id + secret straight back** — persisted automatically (client id → setting, secret
  → vault), so nobody copies a credential or mis-types the callback URL. The card then surfaces an
  **Install the App** button (`github.com/apps/<slug>/installations/new`) for the one remaining step, plus a
  clear "what's next" guide and a **success banner** on return. A collapsible **manual** path still accepts a
  hand-entered client id + secret (for an OAuth App or an existing App). New routes
  `GET /api/github/manifest` + `GET /api/github/manifest-callback` (owner/admin, CSRF-stated), audited
  `github.app.created`. (`src/connectors/github.ts` `convertAppManifest`, `src/edge/github-identity.ts`,
  `src/governance/settings.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`;
  `scripts/github-per-member-test.cjs` now 48/48.)
### Changed
- **Background (headless) runs no longer auto-open a terminal tab.** A headless session runs to
  completion unattended — it isn't something you sit and watch — so it no longer auto-pops into the
  terminal tab strip while you're viewing another session. It still appears in the sessions list and
  can be opened explicitly (or taken over), either of which pins its tab. Interactive runs are
  unchanged. Also adds a small **bg marker** (a `Cpu` glyph) beside headless sessions in the sidebar
  Sessions list so background runs are distinguishable at a glance. Console-only, no API change.

## [0.128.4] — 2026-07-13
### Changed
- **Settings → Integrations: one "Media generation" card for image + video.** The two separate cards
  (each re-explaining the shared Atlas Cloud key, the video one awkwardly pointing back to "the Image
  section above") are merged into a single card: the **Atlas Cloud key** sits at the top since one key
  powers both, then an **Images** subsection (default image model) and a **Video** subsection (default
  video model + the optional fal.ai wider-catalog key) hang off it. Status now reads as two chips
  (`image · on`, `video · Atlas`/`fal.ai`). Also fixes a JSX whitespace bug that rendered
  "Library​with" (missing space) in the old video blurb. Console copy/layout only — no API or schema change.
### Changed
- **Docs say "Library" (not "Artifacts").** Finishes the Artifacts→Library rename (v0.122.0, v0.128.2) by
  updating the prose that lagged: the in-console **Docs** pages (core-concepts, getting-started,
  shared-planes, working-with-agents, automations) now call the deliverables surface the **Library**, and
  the engineering docs (`docs/PILLARS.md` §14 + `docs/agent-mcp-tools.md`) note that "Library" is the
  user-facing name while `artifact*` (the `ArtifactStore`, `artifacts` table, `/api/artifacts` route, and
  `artifact` inbox card) stays the internal identifier. Copy only — no code or schema change.

## [0.128.2] — 2026-07-13
### Changed
- **Media copy says "Library" (not "Artifacts").** Aligned the video generation strings that lagged the
  Artifacts→Library rename: the `video_generate` tool description + its return messages, the Settings →
  Integrations image/video card copy, and the `publish` operating note now all say **Library**. Internal
  identifiers (`ArtifactStore`, the `artifacts` route) are unchanged — display copy only.
  (`src/memory/memory-mcp.ts`, `src/terminal.ts`, `web/src/App.tsx`)

## [0.128.1] — 2026-07-13
### Changed
- **Image integrations UI is Atlas-only now.** The Settings → Integrations image card no longer shows the
  OpenRouter key field — a single Atlas Cloud key powers both image and video. The default-model field is
  scoped to Atlas (placeholder shows real Atlas image ids; catalog at `GET /api/v1/models`), and the video
  card drops the OpenRouter mention. OpenRouter remains supported in the backend (`resolveImageBackend`
  falls back to it if a key is set) — it's just hidden from the console for now. (`web/src/App.tsx`)

## [0.128.0] — 2026-07-13
### Added
- **Per-member GitHub — git that runs as the actual human (Phase 2 of `docs/github-integration-plan.md`).**
  A member links their **own** GitHub account once in the browser, and thereafter any session that runs
  **as that member** (run-as) gets *their* credential injected as `GH_TOKEN`/`GITHUB_TOKEN` — so
  `git push` / `gh pr create` are authored as the real person, not a shared bot. The one-for-one mirror of
  Slack/Discord run-as, on the git egress lane. **Setup:** an owner/admin registers one company **GitHub
  App** (or OAuth App) and pastes its **client id + secret** in **Connections → Creds → GitHub** (callback
  URL `<host>/api/github/callback`); each member then clicks **Connect GitHub** under Connections →
  Connected → *Mine* (user-to-server OAuth). The user token is stored **encrypted in the vault under the
  member's principal** (never in the shared `*` scope, so no agent can read another member's token) and its
  GitHub login is recorded as the member's `github` identity. At launch, `injectMemberGithub` runs after the
  agent-scoped `injectShellSecrets`, so the **member's token overrides** the company-bot `GH_TOKEN` (bot
  stays the fallback when the human hasn't connected); expiring tokens are refreshed on demand. New routes
  `GET /api/github/{connect,callback,me}` + `POST /api/github/disconnect`, audited
  `github.user.connected` / `github.token.injected`. Offline+HTTP test: `scripts/github-per-member-test.cjs`.

## [0.127.0] — 2026-07-13
### Changed
- **Atlas Cloud is now the primary media backend — one interface for image AND video.** When an Atlas
  key is set it's used for image generation ahead of OpenRouter (fal still leads for video), so a single
  Atlas key powers both. (`resolveImageBackend`, `SettingsStore.imageGenBackend`)
### Fixed
- **Atlas image generation now works.** The adapter used a wrong OpenAI-style `/v1/images/generations`
  endpoint; Atlas actually uses a custom **async** API — `POST /api/v1/model/generateImage` → a
  prediction id → poll `GET /api/v1/model/prediction/{id}` until `data.status` is completed, image URL at
  `data.outputs[0]`. Rewrote the adapter to submit + poll-to-completion (bounded; image renders in
  seconds) and download the result. Default model is a real id (`google/nano-banana-2/text-to-image`);
  validated live end-to-end. (`src/edge/image-gen.ts`)
- **Atlas video no longer hangs on a failed/finished render.** The poll read a top-level `status`, but
  Atlas nests the prediction under **`data`** (`data.status`/`data.error`/`data.outputs`) — so a `failed`
  render (e.g. a content-policy block) was mis-read as still `rendering` until it timed out, and a
  completed one wasn't detected. Now reads the nested object, treats failed/error/cancelled as terminal
  (surfacing Atlas's message), and takes the video URL from `data.outputs[0]` directly. Atlas errors are
  carried in a `msg` field, now parsed. (`src/edge/video-gen.ts`)

## [0.126.0] — 2026-07-13
### Added
- **Video generation — agents can now produce video.** New `video_generate` MCP tool: an agent gives a
  prompt (optionally an image URL to animate), and the finished clip lands in the **Artifacts** gallery
  (`kind:'video'`, folder `generated-videos`) with an owner inbox card — cost-metered + audited, exactly
  like images. Because video renders **asynchronously** (minutes), it uses a durable **job model**: the
  vendor job is persisted to a new `video_jobs` table, a brief in-call poll catches fast renders, and a
  **background poller on the Automations tick** (`TerminalManager.pollVideoJobs`) finishes the rest —
  surviving the poll cap AND a server restart. On completion the mp4 is downloaded and ingested. Governed
  as capability `video.generate` with the estimated `amountUsd` (per-second × duration), so the money-cap
  rule applies. Backend behind a swappable `VideoBackend` (`src/edge/video-gen.ts`): **fal.ai** (default —
  the verified queue contract + the widest catalog: Veo, Kling, Seedance…) or **Atlas Cloud** (the shared
  image key). **OpenRouter doesn't do video**, so a fal.ai/Atlas key is required (Settings → Integrations →
  Video; `VIDEO_GEN=1` exposes the tool). The gallery already previews video, so no new UI there.
  (`src/edge/video-gen.ts`, `src/state/video-jobs.ts`, `src/state/db.ts`, `src/kernel.ts`,
  `src/terminal.ts`, `src/edge/automations.ts`, `src/server.ts`, `src/governance/settings.ts`,
  `src/memory/memory-mcp.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`)

## [0.125.0] — 2026-07-13
### Added
- **Agents can propose Host connections — the `host_propose` MCP tool.** When an agent finds it needs to
  reach a host that isn't granted yet, it can propose one (name + match + optional protocol/posture +
  rationale). The proposal lands as an **inactive, credential-less org host** (`proposed=1, enabled=0`,
  **excluded from every grant set until published** — the safety line) plus a **`host.proposed` inbox card**
  to the owner/admins. An owner/admin reviews it on the **Connections** page (a violet "Proposed by agents"
  section) and **Publishes** it (`POST /api/hosts/:id/publish` → active) or **Dismisses** it (delete). The
  agent **cannot attach a credential** — a secret is the admin's to add at/after publish. Mirrors
  `skill_propose`. Audited `host.proposed` / `host.published`. (Deferred item from `docs/host-connections-plan.md`.)

## [0.124.1] — 2026-07-13
### Fixed
- **Closing a terminal tab now removes the session from the left sidebar too.** Closing a tab detaches it
  from the terminal strip but leaves the session running — however the sidebar's "Sessions" switcher never
  consulted `hiddenTabs`, so a "closed" session lingered there (and could be reopened from it), out of sync
  with the strip. The sidebar list now applies the same `hiddenTabs` filter the strip does (keeping the
  currently-open session visible), so a closed tab leaves both viewports while staying alive and reopenable
  from **All sessions**.

## [0.124.0] — 2026-07-13
### Added
- **Pinnable sidebar nav — each member curates their own Main.** Every secondary nav item is now pinnable:
  hover a row and click the pin to promote it into the top **Main** section, or unpin it back down to
  **Manage**. Main = your pinned set, Manage = everything else, with **Inbox + Agents** as permanent anchors
  (the app's spine — never unpinnable). Goals, Tasks, and Library join the pinnable set (they were hardwired
  into Main before), so a tenant that doesn't use Goals can reclaim the slot; they stay pinned by default so
  nothing changes until you customize.
  - **Per member, not per workspace** — pins are stored in the member's `member_prefs` blob (alongside
    notification prefs, without clobbering them) and ride in on `/api/auth/me` so the sidebar renders your
    layout at first paint (no flash). Saved through `PUT /api/me/nav`.
  - **Role-aware** — you can only pin pages you're allowed to see (Skills/Files/Audit/Settings stay
    admin-only), and the collapsed icon rail reflects your pins too.

## [0.123.1] — 2026-07-13
### Changed
- **`deliverToResident` now resolves and audits the target's turn state before typing a chat follow-up
  into it — the reliance on claude's message queue is intentional, not incidental.** Typing into a live
  resident TUI is always safe (an idle claude runs the message now; a mid-turn claude *queues* it and
  drains it at the next turn boundary — verified against the live TUI: injected keystrokes land as "queued
  messages" and never interrupt), so delivery is unchanged. What's new is that we now classify the state
  and record it on the `chat.delivered` audit event as `{ turn, queued }`:
  - **`blocked`** — authoritative from the DB: a pending `ask`/approval whose turn can't end until a human
    responds, so the follow-up necessarily queues behind it (`hasPendingHumanBlock`). This wins over any
    pane reading, so a session that merely *looks* idle while parked on a human is never mislabeled.
  - **`busy` / `idle`** — a best-effort read of the live pane (`residentTurnState`) that keys on claude's
    working chrome (the "esc to interrupt" hint, the live `↓ N tokens` / `(12s …)` counter, or follow-ups
    already queued). It only *labels* the audit — no delivery behaviour depends on it.
  - **`unknown`** — the pane couldn't be read (launcher backend / unreachable socket); delivers as before.

## [0.123.0] — 2026-07-13
### Changed
- **"Artifacts" → "Library" (agent-facing rename).** Claude Code ships its own native `Artifact` tool, so
  the fleet saw two "artifact" surfaces inside a running session and couldn't tell them apart. Our governed,
  operator-visible deliverables gallery is now **the Library** everywhere the model and operator read it:
  the MCP tool `artifacts_list` → **`library_list`**, all "Artifacts gallery" prose → "the Library", and the
  console nav/page label → **Library**. Native Artifacts stay usable and are now unambiguous.
  - **No migration.** Internals are untouched — the `artifacts` table, the `#/artifacts` route, the
    `/api/agent/artifacts` API, and the `publish` tool keep their names. Only agent-facing strings + the one
    read-only tool name changed (rebuild + session relaunch picks up the new tool; existing tenants need
    nothing). `publish` is unchanged — it reads fine as "publish to the Library".

## [0.122.0] — 2026-07-13
### Added
- **Generation cost shows on each artifact in the gallery.** A generated image (and, later, video) now
  records the USD it cost to produce (`artifacts.cost_usd`, new nullable column) — the per-request cost
  the backend reports, split evenly across the images in the request so the gallery total sums back to
  what was spent. The **Artifacts** page shows it inline on each card and the detail pane (`$0.0336` for
  sub-cent amounts, `$0.42` otherwise). Published (non-generated) files carry no cost.
  (`src/state/db.ts`, `src/state/artifacts.ts`, `src/terminal.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`)
### Fixed
- **Generated images are saved with their true format.** The base64 return path hardcoded `.png`/`image/png`,
  so a model that returned JPEG (e.g. OpenRouter's Gemini image models) was persisted as a mislabeled
  `.png`. `image-gen` now sniffs the real format from the bytes' magic numbers (JPEG/PNG/WebP/GIF) and
  names the file + mime from that, falling back to the content-type/URL hint only when the bytes are
  unrecognized. (`src/edge/image-gen.ts`)

## [0.121.0] — 2026-07-13
### Added
- **Goals Phase 2 — the goal auto-planner ("set the goal, the fleet keeps it moving").** When opted in, the
  scheduler now notices a **stuck** active goal and runs the strategist to draft a plan on its own — no more
  clicking "Plan this goal" for every goal. See `docs/goals-plan.md` §Slice 3 / Phase 2.
  - **Detects** an active goal with **no open work** (no non-terminal linked task — never planned, or all its
    tasks finished but it isn't achieved) that has sat idle past a grace window (so a goal you're still
    editing isn't grabbed) — `GoalStore.stuck()`.
  - **Acts** via `Automations.sweepStuckGoals()` on the scheduler tick: runs the strategist **file-only**
    (drafts tasks for review; never auto-dispatches), **as the goal's owner** (human passthrough). Bounded by
    a per-tick cap (`GOAL_AUTOPLAN_MAX_PER_TICK`), a per-goal cooldown (`GOAL_REPLAN_COOLDOWN_MS`, keyed on
    the last `goal.planned` audit), and the whole-box concurrency cap — so it can't spam or burst sessions.
    Audited `goal.autoplanned`.
  - **Opt-in**: an **"Auto-plan stuck goals"** toggle on the Goals page (owner/admin), **default OFF**
    (`settings.autoPlanGoals`) since it spawns agent sessions. Decoupled from Dreaming — a plain deterministic
    check on the goal's own data, not AI "sensing". Activity-based stall (open-but-stale tasks) is a
    documented future knob.

## [0.120.0] — 2026-07-11
### Added
- **Image generation — agents can now draw.** Claude can't create images natively, so `image_generate`
  is a new OS-owned MCP tool: an agent gives a prompt, the image(s) land in the **Artifacts** gallery
  (folder `generated-images`, `kind:'image'`) + an owner-scoped inbox card, and the tool returns the
  artifact ids. Fully governed — the run is policy-classified as `image.generate` with the estimated
  `amountUsd`, so the default **money-cap** rule gates a runaway spend for free, and it's audited
  `image.generated` with the **real** per-image cost when the backend reports it. The vendor sits behind
  a swappable `ImageBackend` (`src/edge/image-gen.ts`): **OpenRouter** (default — one Bearer POST reaches
  30+ models and returns `usage.cost` for exact metering) or **Atlas Cloud** (OpenAI-compatible; the
  future video lane too). URL-or-base64 vendor output is normalised to bytes and snapshotted immediately
  (vendor URLs can expire in minutes) via the new `ArtifactStore.ingest` (server-side bytes → gallery).
  Backend keys + optional default model live in **Settings → Integrations** (`IMAGE_GEN=1` exposes the
  tool when a key is set). Design + provider research in `docs/media-integrations-plan.md`.
  (`src/edge/image-gen.ts`, `src/state/artifacts.ts`, `src/terminal.ts`, `src/server.ts`,
  `src/governance/settings.ts`, `src/memory/memory-mcp.ts`, `web/src/App.tsx`)

## [0.119.0] — 2026-07-11
### Added
- **The strategist numbers task titles.** It now prefixes each task it files with its step number in run
  order ("1. …", "2. …"), so a plan's sequence is visible at a glance on the board (instruction lives in
  its per-run prompt, so the already-provisioned agent picks it up).
- **Dependencies are visible in the Goal detail modal.** The goal's "Linked tasks" list now shows a
  **"⏳ waiting on N"** chip on any task with unfinished blockers (matching the Tasks board), and the linked
  tasks read in **creation/pipeline order** — `TaskStore.tasksForGoal` now attaches `dependsOn` and orders
  by `created_at` (it previously did neither, so the modal couldn't show gating).
### Changed
- **Deleting a goal detaches its tasks instead of orphaning them.** `GoalStore.remove` now clears
  `goal_id` on every linked task (with a timeline note) rather than leaving a dangling reference — a task
  is real work, so it survives on the board, unlinked. (Child goals already detached this way.)

## [0.118.0] — 2026-07-11
### Added
- **Feedback shortcut in the sidebar.** The console's **Manage** group now has a **Feedback** link (under
  Docs) that opens the project's GitHub issues tab (`vikasprogrammer/agent-os/issues`) in a new tab — a
  one-click path to report a bug or request a feature.

## [0.117.1] — 2026-07-11
### Fixed
- **Self-update no longer blocks itself on lockfile churn.** The in-console "Update & restart" button ran
  `npm install`, which routinely rewrites `package-lock.json` (registry metadata / lockfile-format drift) —
  leaving the tree dirty so the *next* update refused with "The box has uncommitted changes — commit or stash
  them before updating". The updater now treats the regenerable lockfiles (`package-lock.json`,
  `web/package-lock.json`) as non-blocking: it discards their churn (`git checkout --`) before the ff-pull and
  excludes them from the dirty check (so the button isn't disabled either). Edits to any *other* tracked file
  still block, as before.

## [0.117.0] — 2026-07-11
### Added
- **Task dependencies — plans become enforced pipelines, not just ordered to-do lists.** A task can now
  be **blocked by** other tasks (`dependsOn`); a dependency is satisfied when the blocker is done/cancelled.
  - New `task_deps` join table + `Task.dependsOn`; set via the console task editor and the
    `task_create`/`task_update` MCP tools (`dependsOn`). Integrity-guarded: self-deps, missing blockers, and
    cycles are rejected (the graph stays a DAG); deleting a task cleans up edges pointing at it.
  - **Dispatch is gated on dependencies** — `TaskStore.dispatchable()` excludes any task with an unfinished
    blocker, and `Automations.dispatchTask` refuses one directly (console dispatch / `task_dispatch` /
    `task_wait`). So the scheduler **walks a plan in order**: a dependent stays `todo` until its blockers
    finish, then becomes dispatchable on the next tick.
  - The **strategist** now sets `dependsOn` when it files a plan (instruction lives in its per-run prompt, so
    the already-provisioned agent picks it up), turning its implicit sequence into a real pipeline.
  - Console: a **Dependencies** section on the task detail (blockers + what it blocks, with an editor) and a
    **"waiting on N"** chip on the board when a task has unmet blockers. `goal_get`/`task_get` surface deps too.

## [0.116.1] — 2026-07-11
### Fixed
- **Publishing a proposed skill now delivers same-session too.** Same-session delivery (materialise +
  `/reload-skills` into a live interactive run) was wired only into the `skill_request` **approve** path,
  so publishing a `skill_propose` draft — the human-gated procedural-skills flow — only reached agents on
  their next launch, an inconsistency an audit surfaced. `POST /api/skills/:name/publish` now calls
  `TerminalManager.refreshAgentSkills` for the **proposing agent** (captured before publish drops the
  `.aos-proposed` marker) and returns `reloaded`. Bounded to the proposer — console catalog/remote installs
  stay next-launch by design (they install for the whole fleet, so a broadcast reload would be disruptive).

## [0.116.0] — 2026-07-11
### Changed
- **Automations page redesign — compact, scannable cards.** The old layout put a full-width six-control
  toolbar (Runs · Run now · mode-select · Disable · Edit · trash) plus three badges on every card, which
  read as clutter once more than a couple of automations existed. Each automation is now a tight row: the
  trigger type is a **glyph** (schedule/webhook/Slack/Discord/Composio) instead of a badge, the agent ·
  trigger-summary · run-mode collapse into one meta line, and the status line shows just **next-in** +
  **last-fired**. The only always-visible action is **Run now**; everything secondary (Past runs,
  Enable/Disable, switch run-mode, Edit, Delete) moves into a **kebab (⋯) menu**. Paused automations dim.
  New reusable `web/src/components/ui/dropdown-menu.tsx` (Base UI `menu`). (`web/src/App.tsx`)

## [0.115.3] — 2026-07-11
### Changed
- **Landing page reflects what's shipped.** The public `/landing` capability grid gains two cards for
  recent work — **Goals** ("Set the goal; the fleet plans the work" — the strategist agent that reads the
  gap to a target and files the tasks to close it) and **Awareness** ("Know the moment one needs you" —
  the in-app notification bell/toasts + opt-in Slack/Discord DMs). Goals is also woven into the hero pitch,
  and the section count moves from "Six things" to "Eight". (`public/landing.html`)

## [0.115.2] — 2026-07-11
### Fixed
- **Same-session skill delivery now reaches console-spawned interactive sessions.** Phase 3's
  `TerminalManager.refreshAgentSkills` filtered on `resident = 1`, but a console-spawned interactive TUI
  is `headless = 0, resident = 0` (the `resident` flag marks chat-continuity sessions, not console runs) —
  so approving a skill for an agent with a live interactive session returned `reloaded: 0` and delivered
  nothing until the next launch. Filter is now `headless = 0` (any live claude REPL we can inject into),
  which covers both console TUIs and resident chat sessions. Found by dogfooding the request→approve flow
  with a real `engineer` agent on the live instance.

## [0.115.1] — 2026-07-11
### Added
- **"Go to session" link after planning a goal.** When "Plan this goal" spawns the strategist, the
  confirmation banner now shows a **Go to session →** link (using the returned `sessionId`) so you can jump
  straight into the strategist's run instead of only waiting for its filed tasks to appear.

## [0.115.0] — 2026-07-11
### Added
- **In-app session notifications — a Facebook-style bell + toasts.** The console now surfaces when one of
  your sessions changes state: it's **waiting** on you (permission prompt / idle / `agent_needs_input`),
  it **finished**, it **crashed**, or it needs an **approval / answer**. A new header bell shows an
  unread count and a dropdown of recent notifications (click one to jump to the session or Inbox);
  fresh events also **toast** in from the bottom-right with an optional chime. Per-member
  **notification settings** (in the bell's gear) let each person choose which events ping them, toggle
  toasts/sound, and opt into a **Slack/Discord DM** for complete/waiting events. Completions and crashes
  now always leave a feed card — a run that exits without calling `report` gets a "Finished" fallback, and
  a crashed session gets a "Crashed" card — so nothing finishes silently. Prefs persist per member in a new
  `member_prefs` table (`GET`/`PUT /api/me/prefs`); the browser-tab 🔔 badge now reflects the full unread
  count. (`src/types.ts`, `src/state/db.ts`, `src/governance/team.ts`, `src/terminal.ts`,
  `src/tenant-registry.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`)

## [0.114.0] — 2026-07-11
### Added
- **Goals — the strategy agent ("goal steward"): the outbound edge (goal → work).** Goals could be linked
  to and measured (Slices 1–2), but nothing turned a goal *into* work — you had to hand-file and hand-link
  every task. Now a goal can plan itself. See `docs/goals-plan.md`.
  - **"Plan this goal"** on the Goal page (owner/admin) spawns a governed, headless **`strategist`** agent
    (`src/edge/strategist.ts`, provisioned on first use like the consolidation gardener; `POST
    /api/goals/:id/plan`, audited `goal.planned`). It reads the goal + its current progress + already-linked
    tasks, works out the GAP to the target, and **files** the tasks needed to close it — linked to the goal,
    assigned to the right specialists (`list_agents`). **File-only**: it produces a reviewable plan that
    lands in the goal's linked-tasks section; a human dispatches. It proposes sub-goals (`goal_propose`) but
    never activates them, and is idempotent on re-run (fills gaps, doesn't duplicate).
  - **`goalId` inheritance** — a sub-task (`task_create({ parentId })`) now inherits its parent's goal when
    it doesn't name one, so an umbrella + its sub-tasks all roll up to the same goal automatically.
  - **Leaf-progress** — `GoalStore.progress()` now counts only *leaf* linked tasks (a task with sub-tasks is
    a grouping), so an umbrella no longer inflates or lags the progress bar.
  - Deliberately **decoupled from Dreaming**: today's self-learning pass is a deterministic tally aggregator
    with no goal awareness, so it can't act as a "this goal is stalled → plan it" sensor. The strategist is
    human-triggered and stands alone; a deterministic goal-stall auto-trigger is a separate later phase.

## [0.113.1] — 2026-07-11
### Fixed
- **Stopping the open session no longer strands you on a dead terminal.** When you stop the session
  you're currently viewing in the terminal view, the console now hops to the next open (live) session,
  or falls back to the all-sessions list when none remain — mirroring the existing "close tab"
  behaviour. Stopping a session from the list or a background tab leaves your current view untouched.

## [0.113.0] — 2026-07-11
### Changed
- **Take-over is now lossless — unattended runs are an attachable TUI, not `claude -p`.** Automation/cron/
  task runs launch as a real interactive claude in a detached tmux pane (`--dangerously-skip-permissions`;
  the PreToolUse gate still governs every effect), so "take over" (`POST /api/sessions/:id/interactive` →
  `TerminalManager.claimSession`) just marks the live run **claimed** and the console attaches to the
  still-streaming pane — no kill, no `--resume`, no discarded turn (the old `goInteractive` killed the
  in-flight `-p` turn and resumed from the last completed one, which read as the run "stopping"). A claimed
  run is **sticky** (never auto-closed). See `docs/attachable-sessions-plan.md`.
  - **Server-driven teardown.** A new **Stop hook** (`terminal/stop-hook.sh`) beacons `/api/turn-idle` when
    claude finishes a turn; `markTurnIdle` closes an unattended run at turn-end — capturing its pane to the
    transcript log, marking it `done`, and killing the pane so tmux drops and the automations pile-up guard
    releases (parity with the old `-p` exit) — UNLESS it's claimed, a human is attached, or it's blocked on
    a person. The idle sweep (`reapIdleResidents` → `reapIdleSessions`) gains a backstop for beaconless
    stragglers (only ones that have seen a turn-end beacon, so a long first turn is never reaped mid-run).
  - **New:** `term_sessions.claimed_by`/`claimed_at`; `SessionBackend.hasClient()` (attach detection) +
    `capturePane()` (transcript snapshot, replacing the `-p` stdout tee); launch env `UNATTENDED=1`
    (was `HEADLESS=1`), honored by the gate hook's bounded approval wait and the memory MCP's `ask`/
    `task_wait` parking.
## [0.112.0] — 2026-07-11
### Added
- **Same-session skill delivery (Phase 3).** When an owner/admin approves an agent's `skill_request`
  and that agent has a LIVE interactive (resident) session, the skill is now usable *in that session*
  instead of only on its next launch. On approve, `TerminalManager.refreshAgentSkills` re-materialises
  the library into the agent's watched `.claude/skills` (so the new skill lands as a folder Claude Code's
  file-watcher detects) and injects **`/reload-skills`** into the live tmux session to force a re-scan +
  re-surface skill descriptions. The approve response returns `reloaded` (how many live sessions were
  refreshed).
  - **Enabling fix:** `SkillsStore.materialize` now always creates `<agent>/.claude/skills` at launch,
    even for an agent with zero skills — Claude Code only *watches* a skills dir that existed at startup,
    so without this the very first skill added mid-session wouldn't be picked up until a restart.
  - **Scope / safety:** delivery targets only `resident` + running + alive sessions; a headless
    `claude -p` run has no REPL and exits anyway, so it gets the skill on its next run (unchanged). The
    `/reload-skills` inject is gated on `claude` ≥ 2.1.152 — on an older binary the re-materialise still
    happens (the watcher exposes the skill as `/name` next turn), only the forced rescan is skipped. New
    audit event `skills.reloaded`.
  - Refactored the cached `claude --version` feature-probe into a shared `src/edge/claude-cli.ts`
    (`claudeVersion`/`claudeSupportsGoal`/`claudeSupportsReloadSkills`).

## [0.111.0] — 2026-07-11
### Added
- **A session can now stop itself.** New always-on MCP tool `stop` lets an agent end its OWN run when
  the work is done or it's blocked with no point waiting (defer with `schedule` first if it should
  resume later). It loops back to `POST /api/agent/stop`, which runs the same `TerminalManager.stopSession`
  halt the console kill button performs — kills the tmux, cancels the session's pending questions/approvals,
  blocks auto-resume, and records a `stopped` episode — but with `by` = the agent id and an optional
  `reason` in the audit trail. The server acks first and halts ~150ms later so the tool's reply flushes
  before the process is torn down (`src/memory/memory-mcp.ts`, `src/server.ts`, `src/terminal.ts`).

## [0.110.1] — 2026-07-11
### Fixed
- **Session tabs no longer look "grabbed" on hover.** The drag-reorderable tabs used a `cursor-grab`
  (open-hand) cursor on hover, which over the tab's black padding read as if a drag had already started.
  Dropped it — hovering shows the normal cursor, and the grabbing cursor only appears while you're
  actually pressing/dragging a tab. Drag-to-reorder itself is unchanged (`web/src/App.tsx`).

## [0.110.0] — 2026-07-11
### Added
- **Agent skill-requests reach beyond the bundled catalog — the whole skills.sh / GitHub universe
  (Phase 2).** `skill_find` and `skill_request` (shipped in 0.108.0 for the bundled catalog) now cover
  remote community skills, still human-gated end to end:
  - **`skill_find({ query })`** — with a `query`, discovery also searches the public **skills.sh**
    directory (thousands of community skills across GitHub repos). Each remote hit comes back with its
    `source` (`owner/repo`). Without a query it's unchanged (library + bundled catalog only), and a
    skills.sh outage degrades gracefully to no remote hits rather than failing local discovery.
  - **`skill_request({ name, source })`** — pass a hit's `source` to request a **remote** skill. The
    server resolves it against the repo at request time (`browseRepo`) so a typo or missing skill fails
    fast, and stashes the resolved path so approval installs cleanly. Omitting `source` still means the
    bundled catalog.
  - **Approval** branches on the source: a catalog request installs via `SkillsStore.install`; a remote
    request installs via `fetchSkill` + `installFiles` (the same governed remote-install path the console
    uses). Audited `skill.installed` now records `from` (catalog or `owner/repo`). The "Requested by
    agents" review card shows the source. Dedupe keys on skill **+ source**.
  - Phase 3 (same-session delivery) remains deferred — an approved skill still arrives on the agent's
    next session.

## [0.109.0] — 2026-07-11
### Added
- **Goals — Slice 2: task linkage, derived progress, and `/goal`-driven convergence.** Goals stop being
  decoration and start *steering + measuring* work. See `docs/goals-plan.md`.
  - **Goal ↔ Task linkage.** Tasks gain a nullable `goal_id` — a task can ladder up to the strategic goal
    it advances (`tasks.goal_id`, `TaskStore.tasksForGoal`). Set/changed via the console task form and the
    `task_create`/`task_update` MCP tools (`goalId`).
  - **Derived progress.** `GoalStore.progress()` computes a goal's % from the status of its linked tasks
    (done ÷ non-cancelled) — never a hand-maintained number, so it can't rot. Surfaced on the Goals page
    (per-goal progress bar + a linked-tasks section on the detail) and in `goal_get`.
  - **`/goal`-driven task convergence.** Tasks gain an optional single-line `criteria`. When a headless
    auto-dispatched task carries criteria — and the installed `claude` supports it (v2.1.139+, probed once
    via `claude --version` and cached) — its dispatched session now runs under a Claude Code `/goal`
    completion condition (`buildTaskPrompt` prepends `/goal <criteria>`), so an independent evaluator
    drives the worker to convergence instead of a single best-effort pass. `task_update(done)` stays the
    system-of-record (folded into the converging turn); the existing attempt-ceiling/guard net covers a
    miss. Interactive tasks keep the plain prompt. Criteria is stored single-line (a `/goal` condition
    delimits at the newline).
- Deferred to a fast-follow: **B — the Dreaming goal-lens** (reasoning over goal progress in the
  self-learning pass), which is most useful once linkage data accrues. See `docs/goals-plan.md` §B.

## [0.108.2] — 2026-07-11
### Added
- **Drag to rearrange session tabs.** The live tabs in the terminal switcher bar can now be dragged into
  any order — grab a tab and drop it where you want; the strip reflows as you cross each sibling and the
  dragged tab dims while held. The arrangement persists per browser (`localStorage: aos_tab_order`), so
  it survives refreshes. Newly-spawned sessions land at the end of your arrangement; ended tabs (behind
  the "N ended" toggle) keep their natural order (`web/src/App.tsx`, `orderTabs`/`reorderTabs`).

## [0.108.1] — 2026-07-11
### Changed
- **Session tab strip no longer shows an ugly native horizontal scrollbar.** When more session tabs are
  open than fit the switcher bar, the chunky OS scrollbar is hidden (`.no-scrollbar`) and replaced with
  a soft 24px edge fade that appears only on the side(s) with off-screen tabs — a subtle "there's more"
  hint that matches the slim dark toolbar. The strip still scrolls via trackpad/shift-wheel; the "N
  ended" toggle stays pinned right as before (`web/src/App.tsx`, `edgeFadeMask`).

## [0.108.0] — 2026-07-11
### Added
- **Agents can ask a human to install a skill — and only ask.** An agent can now discover and request
  skills from the workspace's integrated library on the fly, but it can never install one itself; a
  human approves every install. Two new always-on MCP tools:
  - **`skill_find`** (read-only) — lists what's installable: the agent's own library (each flagged
    whether it's `active` for that agent) plus the bundled catalog of ready-made skills. The agent
    calls this when a task looks like it has an established procedure it lacks.
  - **`skill_request`** — asks an owner/admin to install a named catalog skill. It validates the name
    against the catalog (a typo fails fast), dedupes an already-open request, and posts a
    `skill.request` inbox card addressed to owner/admins. The agent is told it's requested and will be
    available on its next session — it does NOT install anything.
  - **Human review** on the Skills page (a new "Requested by agents" section) and in the Inbox: an
    owner/admin **Installs** the skill into the Library (all agents, or scoped to just the requester via
    a toggle) or **Dismisses** the request. Routes `GET /api/skills/requests`,
    `POST /api/skills/requests/:id/approve`, `POST /api/skills/requests/:id/dismiss` (all owner/admin);
    the loopback `GET /api/skills/discover` + `POST /api/skills/request` are session-secret-gated like
    the other agent tools. Audited `skill.requested` (agent asked) and `skill.installed`
    (`source: 'agent-request'`, human approved). Delivery is next-session; live same-session delivery
    is a later phase.

## [0.107.0] — 2026-07-11
### Added
- **Goals — the strategic layer work ladders up to (Slice 1).** The fleet's ladder started at Task —
  there was no "why" above it. Goals add a human-owned, tenant-wide, persistent object the whole fleet
  orients to (Goal → Task → Session). Deliberately *not* another prose blob: a structured object agents
  read + propose and humans own. See `docs/goals-plan.md`.
  - New **Goals plane**: `GoalStore` (`src/state/goals.ts`) + `goals`/`goal_events`/`goals_fts` tables,
    mirroring the Tasks shape — db-only structured state, an append-only event log as the audit/rollback
    backbone (auto-apply + audited, no gate), FTS search, status machine `draft → active → achieved |
    abandoned`, and `parent_id` hierarchy (strategy → objective → key result). Wired as `os.goals`.
  - **Console routes** (`/api/goals*`): list + per-status counts, detail + timeline, create/edit/delete
    (owner/admin — strategy is a steering-wheel concern), and per-member comments.
  - **Agent MCP tools**: `goal_list` / `goal_get` (always-on, read-only) so any agent can orient to the
    current strategy, and `goal_propose` — an agent drafts a NOT-YET-ACTIVE goal + a `goal.proposed`
    inbox card for an owner/admin to activate (gated like `skill_propose`; agents read + propose, humans
    decide — no agent write path to an active goal).
  - **Context injection**: the active goals now ride in every agent's prompt (`buildCompanyMd`), so
    "why am I doing this" is answerable straight from the prompt. Toggleable in Settings
    (`settings.injectGoals`, default on), capped so a long goal list can't dominate the prompt.
  - New **Goals** page in the console (primary nav, above Tasks — the top of the ladder).

## [0.106.0] — 2026-07-11
### Added
- **A public marketing landing page at `/landing`.** A standalone, self-contained static HTML page
  (no auth, no React, no external requests) that introduces Agent OS as an operating system for a
  fleet of autonomous agents — the fleet, memory, shared knowledge/tasks, chat, governance, and
  self-improvement — with governance as one capability rather than the whole pitch. "Soft Ambient"
  visual identity: warm plush neutrals, rounded display type, soft cards, a faint dawn glow, a live
  fleet roster, and full light/dark theming. Served straight off disk from `public/landing.html`
  (`src/server.ts` → `LANDING_HTML`, a public route above the member-auth gate) so it can be iterated
  on without a web build. First cut — copy and design to be refined.

## [0.105.0] — 2026-07-11
### Added
- **Agents can now discover the existing folder tree before filing into it.** #178 taught agents the
  folder *syntax* (nested KB `section` paths, a `folder` on `publish`), but nothing let them see what
  folders already existed — so an agent could file into `eng` when the tree already had
  `engineering/backend`. Now the "look before you write" tools return the taxonomy:
  - `kb_search` also returns the existing KB **sections** (`GET /api/kb/search` → `sections`, via
    `KbStore.sections`) and lists them in the tool output — shown even when the query matches nothing.
  - `artifacts_list` also returns the tenant-wide gallery **folders** (`GET /api/agent/artifacts` →
    `folders`, via a new `ArtifactStore.folders()`) so a `publish` can reuse an existing folder; the
    artifact list itself stays scoped to the agent's own outputs.
  - `kb_write` / `publish` folder-arg descriptions now nudge reuse over invention; the stale flat
    `kb_history` / `kb_revert` `section` examples were updated to show nesting.

## [0.104.0] — 2026-07-11
### Added
- **Deep-link permalinks for Knowledge Base pages and Artifacts.** Opening a KB page or an artifact
  was in-memory only — the URL stayed at `#/kb` / `#/artifacts`, so a page/deliverable couldn't be
  bookmarked, shared, or reopened by link, and a browser reload lost the selection. Now the URL is the
  source of truth for what's open:
  - **KB:** `#/kb/<section>/<slug>` — with nested sections rendered readably
    (`#/kb/engineering/backend/deploy-runbook`). Selecting a page navigates; loading that URL (or
    back/forward) resolves and opens it. Sidebar page rows are now real `<a>` anchors (right-click "copy
    link", ⌘/ctrl/middle-click open-in-new-tab), and the page header's `section/slug` is a self-permalink.
  - **Artifacts:** `#/artifacts/<id>` — gallery cards are anchors, the selection round-trips through the
    URL, and the Inbox 'artifact' card now deep-links straight to the specific deliverable (previously it
    could only reach the gallery).
  - **Routing:** the hash-route `detail` codec now encodes/decodes **per path segment**, so a nested
    detail (KB `section/slug`, Files `agents/<name>`) keeps real `/`s in the URL instead of `%2F`.
    Backward-compatible — old whole-encoded `%2F` links still resolve.

## [0.103.0] — 2026-07-10
### Added
- **Folders & sub-folders in the Artifacts gallery and the Knowledge Base.** Both surfaces were flat
  lists (the KB grouped by a single-level `section`; Artifacts had no grouping at all), which doesn't
  scale as they fill. Now items organize into a browsable, nested folder tree — for humans in the
  console and for agents via their MCP tools:
  - **Model: implicit path-strings** (no folder tables, no folder CRUD). A folder exists because an
    item lives in it, exactly like KB sections already worked. **KB** `section` now accepts a nested
    path (`engineering/backend`) — the `kb/<section>/<slug>.md` disk mirror and `(tenant,section,slug)`
    index nest unchanged, so there's **no KB migration**. **Artifacts** gain a `folder` column
    (`addColumn(db,'artifacts','folder',…)`, default `''` = root); the on-disk `<id>/<filename>`
    layout is untouched — folder is pure organizing metadata.
  - **Agents:** `kb_write`/`kb_search`/`kb_read` take nested section paths; `publish` gains an optional
    `folder` (e.g. `reports/2024`). Every segment is normalized to `[a-z0-9-]` and `..`/absolute paths
    collapse away, so a section/folder can never escape its root.
  - **Console:** a shared collapsible `FolderNav` tree (with per-folder counts) drives both the KB
    sidebar and the Artifacts gallery — select a folder to filter to its subtree. The new-page form
    takes a nested section (with a datalist of existing folders); artifacts can be filed/moved via a new
    `PATCH /api/artifacts/:id` (same gate as delete; audited `artifact.moved`).
  - **Back-compat:** existing single-level KB sections render as root-level folders; existing artifacts
    (empty `folder`) show under "All".

## [0.102.0] — 2026-07-10
### Added
- **Console navigation is now made of real links — right-click "open in new tab", ⌘/ctrl/middle-click,
  shift-click-new-window, and hover URL preview all work.** Every navigational element was a `<button>`
  (or a `<div onClick>`) that mutated `window.location.hash`, so the browser saw no destination and
  offered none of its native link affordances. They're now real `<a href="#/…">` anchors across the
  whole app: the sidebar (primary + Manage nav, the collapsed icon rail, the session switcher, the
  team/profile card), agent cards, session rows and terminal tabs, task board cards + list rows, inbox
  action/feed items, docs, breadcrumbs, and the Connections/Settings tab strips. A plain left-click
  still routes in place (preserving the existing query/filter semantics); only modified/middle clicks
  fall through to the browser. Two module-level helpers back it — `navHref(route, detail)` builds the
  hash and `onNavClick(cb)` intercepts unmodified left-clicks — and Base UI `Button`s opt in via
  `render={<a href=… />}`. Rows with their own inner controls (inbox feed cards, task cards) use a
  stretched-link overlay / title anchor so the row is openable without swallowing the nested buttons.

## [0.101.1] — 2026-07-10
### Fixed
- **The terminal tab strip no longer auto-pops tabs for other people's sessions.** An owner/admin
  can see the whole fleet via `/api/sessions`, and the live-tab strip was built from that unfiltered
  list — so every time any teammate (admin or member) spawned a session, a new terminal tab appeared
  for the viewer. The strip now shows only the viewer's own runs (`spawnedBy`/`runAs` === me), matching
  every other session surface (sidebar switcher, "My sessions" grid filter). The currently-open session
  stays force-visible, so explicitly opening someone else's run (e.g. an admin taking over) still works.

## [0.101.0] — 2026-07-10
### Added
- **The sessions list now shows how each run was initiated — and whether it's headed or headless.**
  Origin used to collapse to a single "Started by" label with a coarse icon (member avatar / Bot /
  generic person), so a task-dispatched run and a chat-router run were visually identical, and
  headed-vs-headless wasn't surfaced or even stored. Now:
  - Every session carries a server-resolved **`sourceKind`** — the full taxonomy of ways a session
    starts: `manual` (a console member), the automation family split by trigger
    (`cron`/`webhook`/`slack`/`discord`/`composio`/`scheduled`), `task` (the Tasks dispatcher), `chat`
    (the `/agent` router), and `system` (an internal principal, e.g. the consolidation gardener). The
    automation sub-type is resolved by joining the triggering automation's `type` — the raw
    `automation:<id>` provenance can't tell the client that alone.
  - A distinct **origin badge** (per-kind icon + label) replaces the old generic glyph; a manual run
    still shows the starting member's avatar.
  - Run **mode** (`headless` vs `interactive`) is now **persisted** on the session row (previously a
    launch-only argument) and shown as a compact colored pill in both grid and list views, with a new
    **Mode** filter (Any / Interactive / Headless).

## [0.100.0] — 2026-07-10
### Added
- **Slack/Discord notifications now carry a one-tap deep-link back to the console.** The out-of-band
  DMs and thread mirrors used to end with a flat instruction ("Open the Agent OS console → Tasks"); they
  now embed a clickable masked link straight to the relevant page — a task's permalink (`#/tasks/<id>`)
  for task-assigned / blocked / done / overdue notices, and the Inbox (`#/inbox`) for approval and
  question pings. Rendered per platform (Slack mrkdwn `<url|label>`, Discord markdown `[label](url)`)
  because a single DM fans out to both. A tenant's public origin is resolved once from the new
  `AGENT_OS_PUBLIC_URL` env / config `publicUrl` (a background DM has no request Host to derive from);
  unset falls back to `baseDomain` subdomains or localhost. New `src/governance/chat-links.ts`
  (`consolePage` + `chatLink`); `deliverDM` and the chat-mirror sink now take a per-platform text
  builder; `TenantRegistry.consoleOrigin(slug)` pins the URL. **Deploy note:** set
  `AGENT_OS_PUBLIC_URL` to the box's real external URL (e.g. the Tailscale name) or the links point at
  localhost.

## [0.99.1] — 2026-07-10
### Fixed
- **Memory-backend migration is now resume-safe and can't duplicate or lose rows.** The migrate loop
  used a per-run `Date.now()` horizon threaded through the browser, so leaving the tab halted it
  mid-run, and re-clicking to finish couldn't tell an un-migrated orphan from an already-mirrored row —
  it could re-migrate rows as duplicates, or (via a count-based `backendCount >= localCount` guard)
  falsely report "already consistent" while real orphans remained. Migration now anchors to a **stable
  backend-switch timestamp** (`memory_backend_switched_at`, stamped only on a real backend *type* change,
  not a token/ranking re-save): orphans = local rows written before the switch, so each is migrated
  exactly once (re-mirrored with a fresh `created_at` that leaves the orphan set) and post-switch rows
  are never touched. Leaving the tab and clicking **Migrate** again cleanly resumes where it stopped.
  The drift banner/count and the "already consistent" guard are now orphan-based too, and the banner
  explains that migration is resume-safe. (Follow-up to the automem 401 work — #162/#167.)

## [0.99.0] — 2026-07-10
### Added
- **Synchronous task hand-off — a delegating agent can now wait for the result.** `task_dispatch`
  (v0.96.0) spawns a worker and returns immediately; this adds the *waiting* half. New `task_wait(id)`
  MCP tool (or `task_create({ …, wait:true })` in one call) long-polls until the task reaches
  `done`/`cancelled`/`blocked`, then returns the delegate's closing note — the agent-to-agent analog of
  `ask`. The caller's session stays alive on the pending tool call and resumes on its own; no session
  revival needed. Each poll of the new `POST /api/tasks/wait` route kicks a **guarded immediate dispatch**
  when the task is stalled (not terminal, not `blocked`, agent-assigned, nothing live on it), so waiting
  *drives* the work and auto-retries a crashed run — self-limited by the existing `dispatchTask` guard +
  `TASK_MAX_ATTEMPTS` ceiling (a re-polled crash-loop parks `blocked`, it can't spin). Headless callers
  park after `AOS_TASK_WAIT_S` (default 900s) with a "still running, check back" message; interactive
  callers wait up to an hour. The result note is `TaskStore.latestNote` — the newest `comment` event,
  ordered by insertion (`rowid`) so it's unambiguous even for same-millisecond events. 37 always-on MCP
  tools now.
- **An agent-filed `autoDispatch` hand-off now dispatches immediately** instead of waiting for the next
  ≤20s scheduler tick — parity with the console `POST /api/tasks` route, which already dispatched on
  create. So a delegated task begins the moment it's filed, and a `task_wait` caller makes progress at
  once (`src/server.ts`, `src/memory/memory-mcp.ts`, `src/state/tasks.ts`, `docs/tasks-plan.md`,
  `docs/agent-mcp-tools.md`).

## [0.98.0] — 2026-07-10
### Changed
- **Inbox notifications are now scoped to a session's owner instead of flooding every owner/admin.**
  An owner used to be DMed and inbox-carded about *every* member's and admin's session, and every
  approval broadcast to *all* approvers (so admins pinged each other about runs they could self-approve).
  Root cause: session cards were written with no audience, so visibility fell through to the
  "owner/admin see everything" rule. Now:
  - Every session card (`question`/`update`/`completed`/`notification`/`artifact`) is addressed to the
    session's owner (`run_as`/spawner) via the `sessionOwner` audience.
  - Approval cards **and** their Slack/Discord DMs share one `approvalAudience` rule — the session owner
    alone when they can clear that level (an admin self-approving their own run), otherwise escalate to
    the full approver tier (owners+admins for yellow, owners for red).
  - The Inbox feed (`GET /api/messages`) defaults to a **`mine`** scope (only cards addressed to you);
    owner/admin can flip to **All** (`?scope=all`) for the fleet-wide oversight view. A **My activity /
    All** toggle appears on the Inbox for owner/admin. Visibility itself is unchanged — overseers can
    still see everything, they're just no longer flooded by default.
### Added
- **`notify` agent tool** — an agent can deliberately loop in ONE named teammate (`notify({ to, message,
  important? })`, `to` = name or email) when a run concerns someone other than its owner: an inbox card
  addressed to that member plus a Slack/Discord DM. The escape hatch from owner-scoping; one recipient
  only (no team-wide broadcast), allow+audit (`member.notified`). See `docs/agent-mcp-tools.md`.

## [0.97.0] — 2026-07-10
### Added
- **KB page view now shows how often agents read it.** The page metadata line (under the title) now
  reads `… · read N× by agents` (or `never read by agents`), with the last-read timestamp on hover —
  surfacing the `readCount`/`lastReadAt` added in v0.95.0 so a human can spot dead pages at a glance
  before the eventual auto-archive pass exists (`MemoryBrowse`/KB viewer in `web/src/App.tsx`,
  `KbPage` in `web/src/lib/api.ts`). Console-only, no server change.

## [0.96.0] — 2026-07-10
### Added
- **Agents can now dispatch tasks, not just create them.** New `task_dispatch` MCP tool (→
  `POST /api/tasks/dispatch` → `Automations.dispatchTask`) lets an agent kick an agent-assigned task
  into a governed session immediately, instead of only filing it and waiting on the scheduler tick. This
  closes the tasks-plan §9 "agent-triggered dispatch" future: file work with `task_create({
  assignee:"agent:<id>" })`, then `task_dispatch` it to spawn the worker now. Distinct from `task_claim`
  (which pulls a task into the caller's OWN session) — dispatch spawns a NEW session that runs the task to
  completion and closes its own loop via `task_update`. Runaway brakes: `guard:true` (the pile-up guard
  the console's explicit-human dispatch skips, so an agent can't stack parallel sessions on one task) plus
  the existing `TASK_MAX_ATTEMPTS` ceiling; the spawned session runs-as the task `owner` (human
  passthrough) and every effect still passes the gateway. Audited `task.dispatched` with `by:agent:<id>`.
  35 always-on MCP tools now.

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
