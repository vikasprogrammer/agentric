# Changelog

All notable changes to Agentric are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver
(pre-beta: minor per feature merge, patch per fix — see CLAUDE.md → Versioning).
Every PR that bumps `package.json` moves its entries from **Unreleased** into a
new version heading in the same commit.

## [Unreleased]

## [0.378.0] - 2026-08-20

### Added
- **Download as PDF** for Markdown deliverables — a button in the Library detail pane and in the
  full-screen viewer, backed by `GET /api/artifacts/:id/pdf` (same visibility gate as `/raw`, audited
  `artifact.pdf.exported`). The PDF is rendered **on demand and never stored**, so editing the Markdown
  can't leave a stale PDF beside it, and the `.md` stays the source of truth.
  `src/edge/md-pdf.ts` is a dependency-free renderer: it uses only the 14 standard PDF fonts, so nothing
  is embedded and no headless browser is needed on a box that already runs agents. It covers headings,
  paragraphs, lists (with hanging indents), fenced code on a tint, block quotes, rules, tables as
  monospaced rows, and inline bold/italic/code/links — links as real PDF annotations, so they stay
  clickable. Text is laid out with the fonts' actual AFM metrics rather than an estimate, curly quotes /
  en–em dashes / bullets keep their real WinAnsi glyphs, accented Latin survives, and anything a standard
  font can't draw degrades to an ASCII stand-in instead of corrupting the stream. Markdown only for now —
  the button promises exactly what the renderer delivers. Pinned by `scripts/md-pdf-test.cjs` (48
  assertions incl. xref offsets that really point at their objects, and no run extending past the margin).

## [0.377.1] - 2026-08-20

### Fixed
- Guided runtime sign-in (Settings → Runtime accounts, and the setup wizard) kept rejecting valid codes.
  Two causes, both ours. `injectText` presses Enter **twice** — right for an agent composer that can
  swallow the first, wrong for a one-shot CLI prompt: the second press landed on claude's
  `Press Enter to retry` screen, which silently re-runs the whole login with a **new PKCE challenge**,
  so the link the human already had open no longer matched what the CLI was waiting for and every
  subsequent code failed with `OAuth error: Request failed with status code 400`. The code is now
  submitted with exactly one Enter (`injectText` takes an `enterPresses` count). And a rejected code is
  treated as **recoverable** rather than fatal: the flow presses the retry prompt deliberately, waits for
  the CLI's fresh authorize URL, and republishes it with a notice saying the earlier link is dead —
  instead of telling the operator to "start again" while the pane re-armed behind their back. Bounded at
  three rejections, then it hands over the manual `CLAUDE_CONFIG_DIR=… claude` path. Audited
  `runtime.account.login.code.rejected`. Both sign-in surfaces now also say the code is the whole
  string including its `#…` tail, and that each link is single-use.

## [0.377.0] - 2026-08-20

### Changed
- `scripts/make-live.sh` deploys **every configured tenant on the box**, not just one. Targets come from
  `AOS_LIVE_TARGETS="<tenant>:<checkout>:<port>[:<label>] …"` in the untracked env file (the older
  single-tenant `AOS_LIVE_TENANT`/`CHECKOUT`/`LABEL`/`PORT`/`LOG` form still works when it's unset), and
  `--only <tenant>` deploys one. Tenants sharing a checkout are synced and built once, then each service
  restarted — which is why the phases are now build-everything-then-restart-everything: a broken commit
  leaves EVERY server untouched instead of only the first one. Restarts run one tenant at a time and stop
  at the first failed health check, naming the tenants that already moved plus the rollback command.
  Fixes the standing footgun where a second tenant on the same box silently kept running old code because
  the deploy script only ever kicked one launchd label.

## [0.376.0] - 2026-08-20

### Added
- **Setup wizard** — a post-install checklist at `#/setup` (owner/admin), opened once automatically on
  a new install and reachable afterwards from Settings → Setup checklist, plus a dismissible one-line
  banner while work is outstanding. Six steps in the order they matter: sign in to a coding runtime
  (drives the same guided login as Settings → Runtime accounts), write the company context (with a
  starter outline, because an empty textarea reliably produces nothing), add a Composio API key,
  connect Slack/Discord/Telegram, invite teammates with a role explainer, and install a first agent
  from the catalog. `GET /api/setup` + `POST /api/setup/skip|dismiss` (`src/edge/setup.ts`).
  Every step is **derived** from the store that owns its setting and fixed through that setting's
  existing endpoint — so a step completed by CLI or another admin ticks itself, and the checklist can
  never disagree with the Settings page behind it. Skipping is recorded as a decision (the step keeps
  reporting its true status while it stops blocking), and dismissing hides the banner without faking
  completion. Runtime-credential detection covers the pool, the box's `.credentials.json`, the **macOS
  Keychain** (a signed-in Mac has no credentials file, so a file-only check would tell every Mac
  operator to sign in again) and `ANTHROPIC_API_KEY` (reported as `unknown`, since the interactive TUI
  may still want a subscription login). Pinned by `scripts/setup-wizard-test.cjs` (38 assertions, wired
  into `npm run test:governance`).

### Documentation
- Deployment: document the ttyd `-b /terminal` base-path gotcha — a trailing slash on the
  `/terminal/` `proxy_pass` strips the prefix, ttyd 404s the WebSocket upgrade, and the browser
  terminal renders as a black pane with `GET /terminal/ws → 502` while sessions run normally
  (reads as "sessions won't spawn"). Added to the CLAUDE.md nginx gotcha list and the tenant
  box-migration checklist, with the probe that distinguishes it from the backslash-403 and the
  unconditional-`Connection: upgrade` 502, plus the cookie-jar false-401 diagnostic trap.
- Deployment: note that Ubuntu's `ttyd` apt package auto-enables `ttyd.service`, a **root** login
  shell on `:7681` separate from the app-spawned ttyd — disable it on any apt-installed box.

## [0.375.0]
### Changed
- **A completion no longer resurrects a cold caller — the poke-back's resume lane is priced by what the
  wake is FOR.** The wake queue's three lanes are not equally expensive: injecting into a live pane is
  free and in-context, while `--resume`ing an exited caller costs a session in which the agent re-derives
  the whole situation from a blank context and re-decides what to tell the human. Measured on a live
  tenant over 14 days: 140 wake-ups, 71 injected and 69 resumed (~$11.60 marginal each, 6.2 turns, ~15%
  of that tenant's spend) — and **45 of the 69 resumes were plain "your delegate finished"**, while 21 of
  the 69 filed a NEW task, which dispatches a run, which wakes a caller. One wrong first analysis rode
  that loop into eight Discord messages in 68 minutes, three of them the same agent correcting its own
  earlier correction. So a wake-up now carries a `kind`: `poke-done` injects into a live caller exactly as
  before but is **dropped** at a cold one (audited `agent.poke.skipped`, `reason: 'done-cold-caller'`) —
  nobody is stuck, the result is durable on the task and the owner already has the `task.notified` card;
  `poke-blocked` (handed back) and `poke-stranded` (the delegate's run died) keep the full ladder, since
  there the caller is the only one who can move the work. A mixed batch resumes and carries the
  completions along free. `task_create`'s `poke_on_done` description now states this rather than promising
  a wake-up it may not deliver. `docs/tasks-plan.md` §3.8; pinned by `scripts/wakeup-queue-test.cjs`.

### Fixed
- **Stopping a run from the console no longer spawns another agent 10 minutes later.** The stranded-task
  sweep treated "the delegate's run ended without closing its task" as always meaning nobody is coming —
  including when a human had just hit stop, which is the case where somebody very much is. On the live
  fleet a founder killed a delegate at 09:28 and the sweep woke its caller at 09:38, which re-opened the
  stopped work as a PR. `sweepStrandedTasks` now reads the `session.stopped` principal (`system` = the
  reaper, an agent id = a self-stop, a member's email = a person) and a human halt is recorded but never
  woken; a self-stop still wakes the caller, since the agent may have left work behind. New pin:
  `scripts/stranded-human-stop-test.cjs`.

## [0.374.0]
### Added
- **`/v2` session viewer — our own, not the terminal or a chat box.** Clicking a recent session opens a
  read-only, human-readable timeline built on `/api/sessions/:id/conversation`: the person's prompts,
  the agent's replies (rendered as markdown), and each governed **activity** (tool action with an
  ok/running/error status) — with inline cards for any artifacts, KB pages, or apps the run produced. A
  header carries the title, status/verdict, cost, duration, turns and model; live runs still link out to
  the classic terminal, and runs with no persisted transcript get a friendly empty state. Reuses the
  shared `react-markdown` dependency (code-split, so the v2 core stays small).

## [0.373.4]
### Added
- **`/v2` per-agent live-session count.** Each agent row in the rail now shows a small badge with how
  many sessions that agent has live right now (green, or amber when it's the one waiting on a human).
  Hidden when the agent has none. Complements the fleet summary above it.

## [0.373.3]
### Added
- **`/v2` fleet glance in the rail.** Under the Fleet header, a compact summary shows how many sessions
  are **live** and **running** right now, plus a **waiting** count (only when something is blocked on a
  human). Derived from the sessions already loaded — no extra request.

## [0.373.2]
### Changed
- **`/v2` Overview slimmed down.** Dropped the "everything about this agent lives here" blurb and moved
  the four stat tiles (Runs·7d, Cost·7d, Live now, Needs you) onto the **Insights** tab, so Overview is
  just the chat console + recent sessions. The agent description in the workspace header is now clamped
  to two lines instead of taking over the header.
### Fixed
- **`/v2` button styling.** Buttons rendered as links (Run agent, the send arrow, the console chips, New
  agent) were showing underlines and the send `↑` wasn't centered — the links are now styled as proper
  buttons (no underline, flex-centered content).

## [0.373.1]
### Changed
- **`/v2` polish:** the fleet rail is now ordered by **maturity, most mature first** (agents with no
  track record sink to the bottom), and the most mature agent is selected by default. Maturity comes
  from a single `/api/agents/stats` call on load, which also seeds the per-agent Insights cache so that
  tab opens instantly. The light theme now sits on a **white** background instead of the warm-gray
  ground.

## [0.373.0]
### Added
- **The `/v2` agent-first console is now wired to live data.** The mock fleet is gone: the rail loads
  the real roster from `/api/state`, each agent's status dot is derived from its live sessions
  (`running` / `waiting on you` / `idle`), and Overview shows real 7-day stats + recent sessions from
  `/api/sessions`. The per-agent tabs lazy-load on open and cache: Automations (`/api/automations`,
  filtered to the agent), Memory (`/api/memory`), Insights (the agent's real maturity/gate track record
  from `/api/agents/:id/stats`, framed per-agent), and Settings (live model/effort/verbosity +
  CLAUDE.md from `/api/agents/:id/{config,claude}`, read-only this cut). Not signed in → a sign-in
  prompt back to `/`; empty/loading/error states throughout. Reads only for now — send, run, and edit
  link back to the classic console; those become native in the next increment. The classic app at `/`
  is still untouched, and v2 reuses the shared typed client (`web/src/lib/api.ts`) rather than
  duplicating it.

## [0.372.0]
### Added
- **A new agent-first console at `/v2`, isolated from the classic app.** A minimal, x.ai-style
  surface where the agent — not a global page — is the unit: the left rail is just the fleet, and
  selecting an agent opens a workspace with everything about it on one sub-nav — a chat-first
  Overview, plus Automations, Insights, Memory and Settings. Insights that used to live on a
  fleet-wide page are scoped into each agent. Built as its own Vite entry (`web/v2.html` →
  `web/src/v2/`) with its own tokens and reset — no shared code with `App.tsx`, no change to the
  classic console at `/`, which is untouched. Served at `/v2` by `src/server.ts`. This first cut
  renders a mock fleet; the next increment wires it to live `/api/state` + `/api/sessions`.

## [0.371.0]
### Changed
- **The terse brief was rewritten, measured head-to-head, and reverted — and the benchmark grew the
  statistics that make that call possible.** The obvious fix for the previous finding (72% of the
  brief's words tell the model NOT to compress) was written: a named delete-list of filler words and
  constructions in place of "prefer a sentence to a paragraph", one worked verbose/terse example, the
  carve-outs compressed to hard lists rather than paragraphs of reassurance — 63% of words instructing
  brevity, 555 tokens instead of 660, every guarantee still pinned by `scripts/verbosity-test.cjs`.
  Head-to-head against the shipped text over a shared control (504 calls, claude-sonnet-5, 6 reps,
  $15): old `-4.8%` minimal / `-0.4%` production, new `-4.0%` / `-9.6%`, **every 95% CI spanning
  zero**, and the rewrite shorter on 5/14 prompts against the old text's 9/14. Neither text is
  distinguishable from no brief at all, so the rewrite was reverted rather than shipped on a prior.
  The open question is no longer which wording — two very different texts both land inside the noise —
  but whether an appended system prompt is the right lever; the note on `TERSE_OUTPUT_BRIEF` says to
  measure a different mechanism next, not a third rewording.
### Added
- **`--brief <label>=<file>`, repeatable** — candidate briefs share ONE control arm, so comparing two
  rewrites costs 1+N arms instead of 2N and both are scored against the same baseline sample.
### Fixed
- **The benchmark now refuses to declare a winner inside its own noise.** It reports a bootstrap 95%
  CI and the median alongside the mean, a sign test, and a `VERDICT` line that says outright when the
  interval spans zero. This was not academic: the first two runs (2 reps) were read as findings, and
  re-analysis showed the CONTROL arm alone — same prompts, same system prompt, nothing changed —
  drifted 21–28% between them, so nothing below ~25% had been resolvable. Per-call narration length
  carries a **~20–23% coefficient of variation** whatever is in the prompt; an effect above ~10% would
  have shown at 6 reps and did not.
- **The noise floor is a coefficient of variation, not `(max - min) / mean`.** Range grows with sample
  size, so the range-based floor read 22% at 2 reps and 60% at 6 on the same harness — implying more
  data made the noise worse. CV is stable across rep counts (15.8% → 22.9%), which is the only way a
  floor is comparable between runs.

## [0.370.4] — 2026-08-18
### Fixed
- **Folded notification/update lines get a real icon + label, not the raw kind.** A `message.update`
  card rendered a generic muted dot whose tooltip/aria-label leaked the internal kind string
  (`"message.update"`). Now an agent progress **update** shows a note icon labelled "Progress update", a
  notification a bell, a published artifact a package, etc.; other lines' glyphs label as
  "Approval" / "Question" / "Session" instead of the dotted id.

## [0.370.3] — 2026-08-18
### Fixed
- **A done session in the feed now shows its verdict, not an empty dot.** The feed was rendering a
  finished session with the neutral "ended" glyph (a tiny muted circle) regardless of how it went — so
  even a successful run looked empty. It now shows the run's **verdict** like the sessions list and chain
  rail do: a green check for success, red ✕ for failure/crash, amber slash for partial; a run that ended
  without calling `report` gets a dashed ring ("done — no report") — clearer than a bare pip, still
  claiming nothing. Live sessions are unchanged (working / ready / needs-you).

## [0.370.2] — 2026-08-18
### Fixed
- **No more blank line after the live-activity dot.** The running-session "currently…" line sometimes
  rendered a blinking green dot with nothing after it — the newest classified event had an empty summary.
  `latestActivity` now skips empty-summary events and keeps scanning for the newest one that actually says
  something (and the console guards the render on a non-empty summary too).
- **More breathing room between feed items** (a touch more vertical spacing per line).

## [0.370.1] — 2026-08-18
### Fixed
- **The feed no longer lists a delegated task twice.** A delegated run appears nested in its hand-off
  chain; its "Task done" notification card was *also* shown flat at top level — the same work listed
  twice. The Feed lens now drops a `message.task` card when that task's delegated run is already present
  on the page (its session line, matched by `spawned_by = task:<id>`) — the run is the real thing, the
  card is redundant. A task card with no run in view (done elsewhere / pruned by the window) still shows.

## [0.370.0]
### Added
- **`npm run bench:verbosity` — a paired, controlled benchmark for `TERSE_OUTPUT_BRIEF`, and the
  negative result it returned.** `verbositySavings()` compares terse and normal sessions as they
  happened on a live tenant; run against the real instapods DB it calls terse 28–92% WORSE on four of
  five comparable agents. None of that was evidence, for three reasons the query cannot fix from the
  inside: `term_sessions.output_tokens` is ~85% `tool_use` arguments and ~18% thinking (measured over 40
  live transcripts), so it barely contains the narration the brief compresses; dividing by turns lets
  the treatment move its own denominator (`marketing-manager` is 92% worse per turn and 25% cheaper per
  session, from the same rows); and the arms are a 2026-08-07 cutover, not a split. So the brief is now
  measured directly instead — `scripts/verbosity-benchmark.cjs` runs 14 tool-free prompts through both
  arms of an otherwise identical `claude -p`, tools disallowed so the response is pure narration,
  scoring provider-reported narration tokens (`output_tokens - thinking_tokens`) and a `mustMention`
  completeness guard so brevity bought by dropping required facts scores as degradation. The brief is
  read from `dist/`, so the text measured is always the text shipped. Two conditions — the brief alone,
  and the brief behind a real ~14k-token `company.md` — put a number on dilution.
  **The result: -0.6% and -4.6% mean narration change, terse shorter on 6/14 and 5/14 prompts.** The
  treatment effect (13–18%) is smaller than the rep-to-rep spread within a single arm (22–24%), so the
  brief's effect is not distinguishable from noise; completeness was unharmed, so it is not trading
  substance for brevity either. Dilution is real but minor (4 points) and was not the cause — the brief
  does not land even in a bare prompt. Contributing factor recorded in the source: 72% of its words tell
  the model NOT to compress (312 words of carve-out and reassurance vs 123 instructing brevity).

## [0.369.1] — 2026-08-18
### Fixed
- **The feed's live activity line no longer reads a bare capability id like `shell.exec`.** Two classifier
  fixes in `session-activity.ts`: a `gate.decision` now uses its **brief headline** ("Run: npm test",
  "Reach 203.0.113.5 (ssh)") as the summary — the human one-liner was already computed and audited, just
  ignored (fallback to a friendly capability label like "Ran a shell command" for old rows without a
  brief). And a **successful** `action.result` is now treated as noise (it's the redundant paired half of
  the gate decision, which already names the action), so the newest-event scan lands on the command, not
  a second "shell.exec" line; a **failed** `action.result` still surfaces its error. Fixes both the feed's
  "currently…" line and the session activity trail. Pinned by `scripts/activity-classify-test.cjs`.
### Documented
- **`docs/insights-revisit.md` Step 5 gains its top-ranked candidate: "agent shape"** — a card naming
  delegates that do not need to be agents. Carries the measured case (instawp, 7 days: $8,640 of
  agent→agent spend vs $1,027 human-started; 815 tasks filed by agents, 3 by humans; one line-question
  → 19 sessions, $600), the skill / sub-agent / agent tier table, and the six signals the OS already
  stores to compute it. Records the two things that make it hard: three agents hand-classified from
  real data were **all wrong on the first pass** (`qa` looked like ceremony but averages 20.6 min
  provisioning sandboxes; `apidocs-bot` owns a webhook; `code-reviewer` needed a sub-agent, not a
  skill), and the gate audit **cannot** classify read-vs-write (8,573 of 9,139 decisions are
  `shell.exec`). Explicitly not-to-be-built: a one-click "fold agent → skill" button — same reasoning
  as Step 2's refusal to put buttons on the runtime-death card, plus the destination tier is usually
  sub-agent, and a fold isn't done until every *caller's* prompt stops delegating.

## [0.369.0] — 2026-08-18
### Added
- **PR count on the board cards.** "Did this task ship anything, and did it land?" now reads off the
  board and list rows, not just the open task: a chip showing how many pull requests the task references,
  coloured by the worst outstanding state — violet when everything merged, emerald while anything is
  still open, red when they all closed unmerged — with the split in its tooltip. `GET /api/tasks` returns
  `prCounts` from **two extra queries for the whole board** (~9 ms and +9 KB on a 1.3 MB payload,
  measured on a copy of the live 408-task northwind board) and **no GitHub calls** — refreshing 500 cards
  on a 5-second poll would burn the rate limit to render a number, so a chip shows the status that task's
  own detail view last fetched.
### Fixed
- **The bulk PR parse undercounted 10 of 408 live tasks.** Its SQL prefilter (`LIKE '%/pull/%'`) dropped
  the `api.github.com/…/pulls/<n>` form and every bare `PR #n` written in a note that carried no URL of
  its own — so a card could show fewer PRs than the task's own sidebar listed, with nothing to say so.
  Caught before shipping by a parity assertion that now runs over the whole board in
  `scripts/task-pr-links-test.cjs`: bulk and per-task must return identical refs for every task.

## [0.368.0] — 2026-08-18
### Added
- **A task filed as a draft can now be finished — or binned — where you're reading it.** The room's
  **Description** tab is editable in place (wide editor, title + markdown, Save/Cancel); before this its
  only affordance was an "Add one" link that flipped the 320px sidebar into an edit form, and a task that
  already had a description offered no edit control in the room at all. A pencil in the room header opens
  it from any tab.
- **Its author can delete a draft — no admin needed.** A *draft* is a task nothing has acted on: no
  dispatch attempt, no `lastSessionId`, no session linked to it (`isDraftTask`). Deleting was owner/admin-
  only, so a member who filed a task to refine later needed someone else to bin their own note, and dead
  drafts piled up on the board. The moment a session touches the task it stops being a draft, permanently
  — a run history is evidence, not the author's to erase — and one member still can't delete another's.
  The room and sidebar label the state (`draft` chip) so the looser rule reads as deliberate. Pinned by
  `scripts/task-draft-delete-test.cjs`.

## [0.367.0] — 2026-08-17
### Added
- **A task now shows the pull requests it produced, and whether they landed.** The run history said how
  many attempts a task took but never what those attempts shipped — even though the answer was already
  written down: an agent that ships code pastes the PR URL into its closing note (on the live northwind
  tenant, **121 of 404 tasks** already carried one; 94 of them in the activity log or Discussion, only 11
  in the description). So the links are **parsed, not attached** — no new agent tool, no new instruction,
  and it works retroactively on every task ever filed. The task detail lists them under **Pull requests ·
  N** with an open / draft / merged / closed chip, the PR title, and a refresh button. Status comes from
  the GitHub API (`GET /api/tasks/:id/prs`, 5-minute cache in the new `github_prs` table), authenticated
  with the viewing member's linked token, then the App's bot token, then anonymously — so a public repo
  works with no GitHub setup at all, and with none of it the links still render. `merged` is tracked apart
  from `closed`, since GitHub reports a merged PR as closed and showing it that way reads as abandoned;
  a PR whose status can't be fetched shows as a plain link rather than a guessed state. The parser
  refuses to guess in the other direction too: a bare `#12` is never a PR, and `PR #12` resolves only when
  the task's own links agree on exactly one repo. Pinned by `scripts/task-pr-links-test.cjs`.

## [0.366.1] — 2026-08-17
### Fixed
- **Leaving a room now returns you where you came from.** Opening a task from a goal's task list and
  pressing back dropped you on the Tasks board — a page you were never on — losing the goal you were
  working. The task and goal rooms' back buttons follow a short in-app trail instead of a hardcoded list
  page, and **name their destination** ("Goal", "Feed", "Inbox"). Going back *pops* the trail, and a
  destination that equals the last entry is treated as a pop too — that's the only signal the browser's
  own back button gives — so the two rooms can't bounce between each other. A deep link with no trail
  still falls back to the list.

## [0.366.0] — 2026-08-17
### Added
- **The goal room: plan it, run it, watch it and talk about it without leaving the goal.** Operating a goal
  used to mean a tour of the console — file the plan on the goal, dispatch each task on the Tasks board,
  watch it on Sessions, come back to see whether the bar moved.
  - **Run any linked task from the goal's task list.** Each row carries its own control, driven by the new
    **`Automations.canDispatch`** — the guard cascade extracted out of `dispatchTask` as a *pure* predicate,
    so the console asks exactly the question the dispatcher enforces rather than re-deriving it. Refusals
    carry a **code** (`unassigned` · `deps` · `closed` · `attempts` · `live` · `pool`), each a different next
    action for the person on the row, and the member's own `canRun` is folded in so nobody is offered a
    button that could only 403. `GET /api/goals/:id` now returns a per-task `runs` map. The attempt-ceiling
    park stays on `dispatchTask` — asking must not mutate.
  - **A live run shows itself on the row** — a ticking elapsed clock that links into the session, never a
    second dispatch button (that's the pile-up the guard refuses). Liveness for the whole task set is one
    query + one tmux poll (`TerminalManager.liveTaskRuns`), not a per-row `reachable()` on a 5s refresh.
  - **"Run all ready · N"** starts the whole dispatchable front of a plan, sequentially, behind a two-step
    confirm that names N before anything fires — dependencies still gate themselves server-side.
  - **A goal's Activity tab now tells the work's story.** `GoalStore.timeline` merges the goal's own events
    with the **milestones** of its linked tasks (filed / started / blocked / done / cancelled / reopened),
    derived at read time — so nothing can drift out of sync and every existing goal gets its history
    retroactively. A live goal with 7 tasks under it used to show two status flips and read as dead. The
    note attached to a blocked/done transition rides along as the entry's reason; task comments,
    assignments, due-date edits and the overdue/stranded markers stay on the task. Agent `goal_get` sees
    the same merged timeline.
  - **A chat inside the goal** — one warm conversation with the strategist about this goal (`POST
    /api/goals/:id/chat`, a resident session with provenance `goal:<id>`, run-as you). Ask what's missing,
    or tell it to file / run / re-prioritise / drop work; it acts through the same governed tools, and the
    Tasks tab next to it reflects what it did. Follow-ups continue the same transcript, so context
    accumulates. Owner/admin, like every other goal action.
### Changed
- **Dispatching a headless task no longer navigates you to its terminal** (Tasks board and goal room). A
  headless run works to completion and exits — there is nothing to drive — so opening it pulled you off the
  board you were working; an interactive dispatch, which exists to be driven, still opens. The card's live
  tape and the run history are how you follow background work.

## [0.365.0] — 2026-08-17
### Added
- **The feed is now hierarchical — it folds the hand-off chain.** Session lines no longer sprawl: runs of
  one conversation collapse to a single line (by `threadId`), and a delegated run nests under the caller
  that spawned it (`parentThreadId`) — the same chain the sessions list and chain rail already derive,
  now mapped onto the feed. A root line with delegated work shows a **"N delegated runs"** toggle and is
  **collapsed by default**, so a delegation burst reads as one entry you can expand. Crucially the fold
  applies to **session lines only** — pending approvals/questions and notifications stay flat at top
  level, so collapsing a chain never hides something that needs you. Thread identity is enriched onto
  session-backed feed items in the `/api/feed` handler via the new `TerminalManager.threadsFor` (reuses
  `chainLinks`; `FeedItem.threadId`/`parentThreadId`). See `docs/feed-plan.md`.
### Added
- **Per-endpoint timings — "which API is taking the most time", answered in the console.** Settings → System
  → **Endpoint timings**, plus `GET /api/metrics/requests` (owner/admin) and a reset. Ranked by **total**
  handler time, because that is what the question means: a 20 ms route called 10k times costs more than a
  2 s route called once. Paths collapse to templates (`/api/sessions/:id/chain`) so an id-bearing route
  can't unbound the table, and it is **in-memory only** — a per-request INSERT would add the very cost this
  is meant to find, and would grow a table forever (the `audit_events` lesson).
  - The load-bearing column is **stall**: event-loop lag observed when a request ARRIVED, kept strictly
    separate from the route's own time and sampled independently of traffic. In the v0.362.0 incident a
    blocking 20 s timer made `/health` — one string — measure **9.06 s**; a plain latency table would have
    crowned `/health` the slowest endpoint and sent the next investigation into the wrong file. High stall
    with low handler times everywhere means look for a timer, not an endpoint.

### Fixed
- **Memory was reported as ~98% used on a box with plenty free — on every platform.** Both the new sidebar
  chip and the older Settings → System panel derived "used" from `os.freemem()`, which counts only pages
  free *right now*; both kernels deliberately spend spare RAM on reclaimable cache. The Mac Mini read
  `freemem` 0.08 GB of 24 GB (**98%**) while `memory_pressure` put availability at 59%; instawp would read
  90% used where the kernel reports 46 of 62 GB *available* (26%). Now both read the kernel's own
  availability estimate from one place (`availableBytes()` in `host-metrics.ts`): `MemAvailable` on Linux,
  reclaimable `vm_stat` pages on macOS, cached 5s so open tabs can't exec per poll. The chip's tooltip
  states the raw figure ("7.6 of 24 GB RAM available") rather than only a percentage.

## [0.363.0] — 2026-08-17
### Added
- **The audit MIRROR is now bounded — it used to grow with a tenant's whole lifetime.** `audit_events` in
  SQLite is a queryable copy; `JsonlAuditSink` is the append-only system of record (verified on the live
  box: 4498 per-run files, 211 MB, full payloads). The copy had no age or size bound, so on instawp it
  reached **337k rows / 195 MB of a 336 MB DB in 45 days** at ~3 MB/day, entirely open-ended. Two bounds,
  neither of which touches the JSONL:
  - **Retention** (`Settings.auditRetentionDays`, default **90 days**, `0` = keep everything) swept hourly
    per tenant, deleted oldest-first in ≤20k-row batches so one pass can't hold the write lock, audited
    `audit.mirror.pruned`. Owner-settable via `PUT /api/settings/audit-retention` (applies immediately;
    API-only for now, no console field yet). Deletes free pages for reuse rather than shrinking the file —
    these DBs are `auto_vacuum=0` and a full `VACUUM` would lock a live server through a 300 MB rewrite —
    so the promise is a plateau, not a shrink.
  - **A per-row cap**: long string leaves are clipped to 2 KB in the mirror only, marked `…[clipped — full
    value in the audit JSONL]`. Keys, structure and non-string types are preserved exactly, because every
    reader indexes into `data` by name. `gate.attempt` averaged 966 bytes but reached **120 KB** for one
    row; 4014 such rows held 30 MB.

### Fixed
- **`audit_events` had no index on `type` or `ts` alone**, only `(run_id, type, ts)` — useless to the many
  callers that ask "when did this type last happen" / "how many since T" with no run: the digest, alert
  staleness, dreaming's watermark, measurement, the Audit page's type filter. Each was a full scan of the
  largest table in the DB, on a timer, inside the single-threaded event loop. Added `(type, ts)` and `(ts)`.
  Measured on a copy of the live 336 MB DB, warm cache: a type+window count **12 ms → 0.4 ms**, a
  time-window type scan 2 ms → 0.07 ms, `DISTINCT type` 56 ms → 22 ms; +15 MB of index, 0.5 s to build.

## [0.362.0] — 2026-08-17
### Fixed
- **The scheduler tick froze the whole server for 7.3s out of every 20s — and the freeze grew with the
  tenant's task history.** `Automations.dispatchTasks` built its per-agent pile-up guard by calling
  `tm.reachable()` once per row of `spawned_by LIKE 'task:%' AND status IN ('running','done')`, and each
  `reachable()` fork+exec'd `tmux list-sessions`. `done` rows are never deleted, so the loop only ever
  grew: instawp reached **924 rows (918 long-finished) → ~900 tmux spawns per tick**. tmux itself answered
  in ~0ms each; the cost was 900 fork+execs on a single-threaded server. Measured on the live box:
  `GET /health` — a route that only reads a version string — ran p50 **0.6ms**, max **9.06s**, with 7.3s
  stalls landing on every :00/:20/:40 boundary. Every governed effect (a gate check, a task write, an MCP
  tool call, a console load) queued behind them, which is what "Agent OS is slow" actually was. Two
  changes: `TerminalManager.busyTaskAgents()` answers the same question for the whole board in ONE query
  and ONE liveness poll, and `LocalSessionBackend.aliveNames()` is now memoized for 1s (invalidated on
  spawn/kill) so no other per-row caller can reintroduce the same shape. Pinned by
  `scripts/tick-liveness-test.cjs`, which counts real tmux execs through a PATH shim.
- **A leaked `ttyd` per in-process test run — 86 of them, 1604% CPU, load 92 on 12 cores.** A harness
  following the documented recipe passes port `0` for an ephemeral port; the registry derives
  `basePort + 1`, so ttyd was launched with **`-p 1`** — privileged, never bindable — and busy-looped
  retrying instead of exiting, then outlived the test process and even its `rm -rf`'d scratch home (ttyd
  teardown only ran via `TenantRegistry.stopAll()`, which is wired into `startServer` alone). `launchTtyd`
  now refuses a port it cannot bind, honours `AOS_NO_TTYD=1`, and kills its child on process exit.

### Added
- **A process janitor** (`src/edge/process-janitor.ts`): every 5 min, reap `ttyd`/`tmux` processes bound to
  a tmux socket that no longer exists on disk — provably unreachable, since nothing can connect to an
  unlinked socket. Own-uid + own-command-shape only, never a socket a live runtime declares, and only
  after two consecutive sightings past a 10-min grace. Audited `orphan.reaped` with the counts, so it
  can't quietly paper over the next leak.
- **CPU/RAM chip in the console sidebar**, under the tenant · version line (`56% cpu · 42% ram`,
  colour-coded, load-per-core in the tooltip) via `GET /api/host`. The box that was 8x oversubscribed
  looked perfectly healthy in the console; the product said nothing about the pressure underneath it.

## [0.361.0] — 2026-08-17
### Added
- **`subagentOnly` on an agent manifest — a delegate that exists only to give a FRESH CONTEXT no longer
  costs a whole governed session.** Some delegates are separate for a reason a sub-agent already
  satisfies: a reviewer, a critic, a second opinion needs its own context and must not see the caller's
  reasoning — and a sub-agent has exactly that, in-process, with no launch, MCP boot, CLAUDE.md reload or
  tmux pane. Live evidence: instawp's `code-reviewer` is documented in engineer's *own* prompt as
  `Agent(subagent_type: code-reviewer)` and **still took 12 task hand-offs in 7 days → 8 sessions, $111**,
  for reviews the sub-agent path performs for a fraction of that. Setting `subagentOnly: true` makes the
  agent lane (`POST /api/tasks/create`) refuse a task hand-off and name the cheap path instead; audited
  `task.subagent_only.refused`. Readable/settable via `GET`/`PATCH /api/agents/:id`.
- The flag is **deliberately narrow**, and the doc says when NOT to use it: not for a delegate that needs
  its own credentials (a sub-agent runs under the caller's principal and budget), that runs long or on
  shared infrastructure (it would hold the caller's turn open — instawp's `qa` averages 20 min
  provisioning sandboxes and contending for a devX lock), that must outlive the caller's turn, or that
  must observe work independently over time. Fresh context must be the *only* thing the split buys.
- Human dispatch from the console is unaffected — a person choosing to run a session is a considered act,
  not the reflex this guards.

## [0.360.0] — 2026-08-17
### Changed
- **An agent can no longer auto-dispatch a task to itself.** `task_create({ assignee:'me',
  autoDispatch:true })` is not delegation — it ends the agent's turn and immediately respawns it with an
  empty context to do work the session it just left was still holding the context for. Measured on the
  live instawp fleet over 7 days: **104 such tasks, 70 of them dispatched within 2 minutes of being
  filed, $1,330** of sessions rebuilding a context their own caller already had. The route now refuses at
  CREATE (so the agent learns inside the turn that can still act on it), writes nothing, and names the
  three real alternatives: do it now, `schedule` it for genuinely later, or file it `autoDispatch:false`
  for the board. Audited `task.self_dispatch.refused`, so the saving is measurable rather than asserted.
  Nothing is given up — there was no deferral to preserve, because `dueAt` is a soft deadline that
  `dispatchable()` never reads, so a self-assigned auto-dispatch task always ran ~now anyway.
  Cross-agent hand-offs, self-assigned board items (`autoDispatch:false`), unassigned tasks and the
  goal-plan lane (where the server deliberately stamps auto-dispatch on a multi-step plan) are all
  untouched — each pinned by `scripts/self-dispatch-guard-test.cjs`, now in the governance gate.

## [0.359.0] — 2026-08-17
### Added
- **`unless` — a webhook filter can now reject a *conjunction*.** v0.358.0 gave `filter` a `when` clause,
  but `when` can only negate one property at a time, and what you actually need to drop is usually a
  combination. Measured on 100 classifiable FreeScout deliveries (one week, instawp), keyed by the
  triggering thread's type + source: `customer api/customer` 0 exits / 26 real, `note web/user` 3 / 20,
  `customer email/customer` 10 / 10, **`note api/user` 15 / 0**, **`message api/user` 3 / 0**. The echo is
  the last two — the agent's own note posted over the API. `source.type != "api"` alone would have killed
  26 genuine customer tickets; `source.via != "user"` alone would have killed 20 human notes. Only the
  pair identifies the agent talking to itself. `unless <p> and <p>` says exactly that, without inventing
  operator precedence: `when` requires every predicate, `unless` rejects only when every predicate holds.
  Both clauses are optional, may appear in either order, and a filter with neither is unchanged.
- A rejecting `unless` names the **whole conjunction** in the `filtered` audit row, not one half of it.
### Documented
- Two ways a payload predicate looks obviously right and is wrong, both hit while building this: the same
  field name at conversation level vs. triggering-thread level means different things (`source.type` is
  `api` for genuine customer submissions too), and `state != "deleted"` drops real work because agents
  legitimately work merged-away conversations. Plus **shared identities**: instawp's agent posts through
  the owner's FreeScout token, so `createdBy.id` is the owner's own user for both the echo and anything
  the owner types by hand — filtering on it would have silenced the owner.

## [0.358.0] — 2026-08-17
### Added
- **A webhook filter can now test the payload, not just the event name** — `filter` accepts an optional
  `when <path> <op> <value> [and …]` clause (`==` `!=` `~` `!~`, dot paths, quoted values,
  case-insensitive). The defect it closes: an event-name filter cannot express the **echo**, which is the
  dominant cost on a real hook. The agent posts a note on a ticket → the source emits
  `convo.note.created` → the automation fires → a whole session spawns, reads the thread, finds the note
  was *its own*, and exits. Measured on instawp's live FreeScout hook over 7 days: **93 of 177 runs (53%)
  did no work at all**, **79 of them triggered by the agent's own note**, $224 spent to produce nothing.
  A gate written into the agent's *prompt* cannot fix this — it runs after the spawn it was meant to
  prevent, so it can shorten a session but never avoid one. The decision had to move to the ingress.
  Existing automations parse to zero predicates and are unaffected.
- `filtered` audit rows now carry `by: 'event' | 'payload'` and name the rejecting `predicate`, so an
  over-eager clause reads as a count per predicate instead of an agent that mysteriously went quiet.
  A malformed clause **fails open** (fires, plus a `filter-invalid` audit row) — losing a real customer
  ticket costs far more than one extra session — and is refused at save time by `validateFilter` instead.

## [0.357.0] — 2026-08-17
### Changed
- **A finished session's output is now a readable conversation, not a raw terminal dump.** The done-session
  pane used to render the raw tmux/TUI capture (`/api/sessions/:id/transcript`) into a `<pre>`, so a
  read-only run showed terminal soup: box-drawing chars, the live claude prompt line, `bypass permissions`,
  the cost footer and the `Tip: Run Claude Code locally` chrome — none of it meaningful after the fact, on
  black, unwrapped, barely scrollable. `EndedSession` now renders the SAME structured timeline the Chat
  view uses (`/api/sessions/:id/conversation` → user/assistant markdown bubbles + friendly activity cards
  with inline artifact/KB/app deliverables), on the app's own surface with ordinary wrapped-DOM scrolling.
  A **"Raw" toggle** still exposes the exact terminal output on demand, and is the automatic fallback for a
  headless run that only tee'd a pane log with no structured transcript; when neither exists the pane falls
  back to the reported outcome via `RunReport`, so it always answers "what came of it".

## [0.356.4] — 2026-08-17
### Changed
- **`blockedOn` is now required when an agent blocks a task.** It shipped optional in 0.356.0, and the
  fleet's first afternoon with it produced four human blockers and **zero** declarations ("Blocked on
  human approval for the merge only", "no deletions without founder sign-off", "blocked only on the
  founder's merge decision", "blocked only on merge approval") — including one from a session started
  after the deploy, so the field was in its tool list and simply went unused. An optional field on a tool
  agents call with minimal args is not a field, and the wake-up routing it feeds stays inert. `POST
  /api/tasks/update` now refuses `status:'blocked'` without a blocker and returns the three choices with
  what each one does. The refusal is aimed only at CURRENT clients: the MCP tool sends an explicit `null`
  when the agent omitted the field, while an older MCP process (which outlives a server upgrade and has
  never heard of it) sends no key and is accepted exactly as before — refusing that would leave a live
  agent unable to block at all. Pinned by `scripts/blocked-declaration-test.cjs`.

## [0.356.3] — 2026-08-17
### Fixed
- **Reverted the pane-based submit verdict (v0.355.1, narrowed in v0.356.2); it cannot tell a delivered
  message from a parked one.** A claude TUI renders a SUBMITTED message with the same `❯` prompt glyph —
  and the same `[Pasted text #N]` chip — that an unsent one has, so a single capture cannot distinguish
  them; and a mid-turn agent parks injected text on purpose until its turn boundary. Acting on that guess
  stopped **two working runs** (`ses_987f7efc`, `ses_1171820b`) to `--resume` them. `injectText` now
  reports keystroke delivery only, as it did before v0.355.1.
  **What is KEPT is the part that actually fixed the original bug:** the settle before the submit `Enter`,
  and a second Enter after a longer pause — the automated version of the human Enter that unstuck 8 parked
  wake-ups. A silent late delivery is recoverable; killing a live run is not, so the verdict is gone until
  it can be read from the transcript (where a submitted turn is unambiguous) rather than the screen.
  `scripts/inject-submit-test.cjs` is now a real-tmux test of the mechanism (text + Enter reach the pane
  and complete the line), and states plainly that `cat` in canonical mode cannot stand in for a TUI's
  paste handling, instead of pretending to cover it.

## [0.356.2] — 2026-08-17
### Fixed
- **The v0.355.1 submit check no longer kills a working run.** Verifying that injected text became a turn
  is only meaningful when the agent was IDLE when we typed: a MID-TURN claude parks injected text in its
  composer on purpose and submits it at the next turn boundary — the documented contract of
  `injectToSession` — and from the outside that is indistinguishable from a failed submit. Within an hour
  of shipping, `ses_987f7efc` (fleet-janitor) was 3 minutes into a turn when a second wake-up arrived; the
  queued text read as "parked", `injectText` returned false, and the same-transcript rule stopped a
  working run to `--resume` it (one occurrence, work continued on the same transcript). `injectToSession`
  now asks `isWorking` first and passes `verify: false` while a turn is in flight, so a queued message
  counts as delivered; the settle + Enter still run either way, since that is what makes the paste land as
  a queued message rather than loose keys. Idle sessions are verified exactly as before. Pinned by two new
  cases in `scripts/inject-submit-test.cjs`.

## [0.356.1] — 2026-08-17
### Fixed
- **Removing a runtime account from the console made its name unusable again.** `DELETE
  /api/runtime-accounts/…` drops the row but (rightly) leaves the credential dir on disk, so the next
  guided login for the same name hit the "already holds a login" guard and there was no way out of the
  console — the operator had to ssh to the box and delete a directory. Hit live on instawp re-adding its
  `instawp` claude account. The guard now distinguishes the two cases: a dir an account in the pool still
  points at is refused **by that account's name** (removing it, or choosing another name, is the fix),
  while an **orphaned** dir — no account references it — is moved aside to `<dir>.orphan-<ts>` and the
  login continues into a clean dir. Moved, never deleted: the dir also holds the transcripts of the runs
  made under that account. Audited `runtime.account.login.orphan.archived`.

## [0.356.0] — 2026-08-17
### Added
- **A delegate can now say what it is blocked ON, and a human blocker no longer wakes the delegating
  agent.** `task_update({ status:'blocked', blockedOn })` takes `human` | `agent` | `external`. The
  completion poke fires on `blocked` as well as `done`, which is right when the caller can re-scope or
  chase the blocker — and waste when only a person can act. Twice on the live fleet 2026-08-17:
  `tsk_f81b27d7` ("Blocked on human approval for the merge only") woke `prod-monitor`, which replied
  "Leaving this blocked — I am not merging it and neither should any agent" and ended; `tsk_5aa0fd20`
  ("no deletions without founder sign-off") woke `agent-author` the same way. Each was a `--resume` on a
  large transcript that moved nothing. Now `human` routes to the task **owner** alone — who already gets
  the "Task blocked — needs you" card + DM, so nothing is lost — and audits `agent.poke.skipped`
  (`reason: 'blocked-on-human'`); `agent`/`external` wake the caller as before; an **unstated** blocker
  keeps the old behaviour, so this only narrows on an explicit declaration. Declared, never inferred from
  the note's prose. The flag clears whenever the task leaves `blocked`, so it can't mute a later
  done-poke. Board shows a `waiting on …` chip (the "Needs you" column header is only true for one of the
  three). Pinned by `scripts/blocked-routing-test.cjs`; docs/tasks-plan.md §3.7.

## [0.355.2] — 2026-08-17
### Fixed
- **A task re-dispatched as `interactive` now actually gets its prompt.** `claude --resume` serves two
  callers with opposite needs: a **browser reattach** (`attach.sh`, `RESUMED_FROM_ENV=1`), where `$TASK` is
  the original prompt already sitting in the transcript and re-seeding it would re-run the whole run; and a
  **server-driven** relaunch, where `$TASK` is a genuinely new prompt. The unattended lane in
  `terminal/claude-launch.sh` had learned that split; the interactive lane dropped `$TASK`
  unconditionally. So a task re-dispatch with `mode: interactive` resumed the transcript and opened the TUI
  on an **empty composer** — the "you are RESUMING … continue and finish it" prompt was never delivered.
  Found on instapods 2026-08-17 (`fleet-janitor`, `tsk_5aa0fd20887a2d79`): a healthy claude parked at `❯ `
  behind a session the console insisted was working.
- **A launch that never became a turn stops reading as "working".** `createSession` stamps
  `busy_since = created_at` because a launch normally seeds a prompt — but that is a *prediction*, and the
  stamp was neither `NULL` nor stale, so it **shadowed every signal of the first turn**: `UserPromptSubmit`
  and the first 40 tool calls were all no-ops against it, and a row looked byte-identical whether the
  runtime was working hard or had opened on an empty composer and never started. An unconfirmed prediction
  therefore rode the full 2h `MID_TURN_MAX_MS` ceiling, which is the class of bug the case above surfaced —
  and the same class a rate-limited or trust-dialog-hung start produces. `markTurnBusy` now **promotes** the
  launch stamp on the first real turn signal (at most once per run, so mid-turn idempotence is untouched),
  which makes "unconfirmed" a decidable state; `isWorking` gives an unpromoted stamp
  `LAUNCH_TURN_GRACE_MS` (5 min — real turns promote within ~30s on 96% of fleet runs) and then stops
  believing it. Honesty only: the pane is left alive and attachable.
- Pinned by `scripts/resume-seed-test.cjs` (24 assertions; runs the real dispatch blocks lifted out of the
  live launch script, both lanes, with `claude` stubbed) and 9 new assertions in
  `scripts/turn-lifecycle-test.cjs`.

## [0.355.1] — 2026-08-17
### Fixed
- **An injected message that never became a turn is no longer reported as delivered.**
  `LocalSessionBackend.injectText` returned `true` whenever its two tmux calls exited 0 — but an agent TUI
  collapses a large `send-keys` into a bracketed paste (`[Pasted text #N]`) and swallows a submit `Enter`
  that arrives while the paste is still assembling. The message then sits untouched in the composer while
  the caller is told it landed. Found on the live fleet 2026-08-17 while watching the new wake queue: **8
  wake-ups parked across two agents' input boxes** (`check-resolve-tickets` showing
  `❯ [Pasted text #4][Pasted text #5][Pasted text #6]` with a healthy idle claude in front of them), every
  one recorded `delivered` and therefore never retried — a false ack that defeats the queue's durability
  guarantee. `injectText` now settles before the Enter, LOOKS at the composer (`composerParked`, anchored
  to the prompt line so the post-submit echo in the transcript isn't mistaken for parked text), retries
  once with a longer settle, and returns **false** if the text is still sitting there. That failure
  propagates through `injectToSession` to the wake queue, which holds the message, retries it, and falls
  back to `--resume` — the behaviour it was built for. Where the pane can't be captured (the launcher
  backend's uid-private socket) the check is skipped and the old optimistic `true` stands: unverifiable is
  not the same as failed. Pinned by `scripts/inject-submit-test.cjs` against real captures from the
  incident.

## [0.355.0] — 2026-08-16
### Changed
- **Agent wake-ups are now a durable queue instead of a fire-time decision** (`src/edge/wakeups.ts`, new
  `agent_wakeups` table). `pokeCaller` used to pick its delivery lane inline — type into the caller's pane,
  or `--resume` its transcript — with no record that an attempt had been made, and four bugs came out of
  that single decision (v0.307.0 stranded hand-offs, v0.334.1 status-vs-pane, v0.334.2 `isAlive`, v0.354.1
  transcript-vs-agent liveness). Producers now only enqueue; one deliverer picks the destination **per
  agent** (own pane → any pane of that agent → resume), because all of an agent's sessions share one
  workspace folder. Consequences: an undeliverable wake-up stays `pending` and the scheduler retries it
  (a wedged sibling is left alone rather than resumed past; the concurrency cap defers the resume lane
  instead of dropping it); the same hand-off re-fired while pending wakes the caller **once**, with the
  latest message; several pending wake-ups **coalesce** into one resume carrying all of them; and a
  wake-up that can never land expires with an `agent.wakeup.expired` audit plus an inbox card to the run's
  owner quoting what never arrived. Delivery is still synchronous on enqueue, so a poke lands in the same
  second it fires. Pinned by `scripts/wakeup-queue-test.cjs`; docs/tasks-plan.md §3.6.

## [0.354.1] — 2026-08-16
### Fixed
- **A completion poke no longer starts a second claude in a workspace the agent is already working in.**
  `Automations.pokeCaller` chose between "inject into the live pane" and "`--resume` the transcript" by
  looking only at the CALLER'S TRANSCRIPT. A caller whose own conversation had exited took the resume
  lane even when the same agent was mid-run under a *different* transcript — and all of an agent's
  sessions share one workspace folder, so that put two claudes in the same directory (northwind
  2026-08-16: `check-resolve-tickets` running since 12:36 got a poke that resumed its 2-day-old caller
  transcript; both runs then worked the same support ticket). The poke was the only dispatch lane with no
  per-agent guard — `dispatchTasks`, `dispatchTask({guard})` and chat-thread continuation all had one.
  There is now a third lane between the two: cold transcript + a live session elsewhere on that agent →
  deliver the poke into that session (the message already carries the task id, title and the delegate's
  note, so it needs no transcript context). A wedged sibling is never killed — it is doing unrelated
  work — so a failed inject falls through to the resume rather than ending someone else's run. Audited
  `agent.poked via:'inject-sibling'` with the transcript it stood in for; pinned by
  `scripts/poke-warm-caller-test.cjs` case 7.

## [0.354.0] — 2026-08-16
### Changed
- **Reopening an ended session from the feed now warns + confirms.** Opening a *live* session attaches to
  it (nothing happens to the run); opening one that has **ended** relaunches it (`claude --resume`) as a
  fresh run. The feed used to do this silently. Now a line whose session has ended shows an amber
  **"Reopen (relaunch)"** control (instead of the plain "Open"), and clicking it asks for confirmation
  ("…has ended. Reopening relaunches it as a new run and attaches you to the terminal.") before spending
  the run. Live sessions still open in one click, and non-session targets (task/goal) just navigate.

## [0.353.0] — 2026-08-16
### Added
- **Feed time window (default last 24h) for fast loading.** A window selector — Last 24 hours / 2 days /
  7 days / 30 days — bounds the stream, defaulting to **24h** so the first paint is small and quick. The
  window is persisted in the URL (`?win=`) alongside lens/filter, and `since` is computed fresh on every
  load/poll from the token (the URL stores the window, not a frozen timestamp). Crucially the window
  prunes only the **done/info history** — a `running` session or an **open decision** (a pending approval
  from days ago) always shows regardless of window, so speeding up the load never hides live work or
  something that needs you (`FeedStore.list({ since })` → `ts >= since OR state='running' OR
  status='pending'`; `feed-smoke` covers it).
### Changed
- **`· via task` (and `· via automation`) is now a link** that opens the originating task/automation in a
  new tab, so a run's provenance connects to what triggered it.

## [0.352.0] — 2026-08-16
### Added
- **See what a running session is doing, and connect every feed line to its object.** Two related feed
  improvements:
  - **Live progress on running sessions.** Each `running` line now shows a one-liner of the newest thing
    the agent just did — derived automatically from the audit tail via the same `classifyActivity` the
    activity trail uses (with the un-audited `update` note as a fallback), refreshed by the 4s poll. You
    can watch a session advance ("Ran: npm test", "Edited src/…", "Reported: …") without opening its
    terminal; on finish the run's report summary is the line. Exposed as `FeedItem.lastActivity`,
    enriched in the `/api/feed` handler and bounded to the page's running items.
  - **Lines connect to what they're about.** New `FeedItem.target` decodes the real object behind a line
    (`feedTarget`): a session/approval/question → its session; a folded message card → its encoded
    `session_id` (`task:<id>` → the task, `goal:<id>` → the goal). So a *"Task done"* card now opens its
    **task** and names it — *"Task done — Write the API reference"* — instead of a generic headline
    pointing at a dead run id. The console's Open action routes by target kind (task/goal/session/artifact).
  `feed-smoke` covers the target decode + combined task title. See `docs/feed-plan.md`.

## [0.351.0] — 2026-08-14
### Changed
- **Feed page polish from live use.** Several refinements to how a line reads and how the page remembers you:
  - **Session status now matches the Sessions page exactly.** A session line renders through the same
    `SessionStatus`/`sessionState` (reading the shared `WaitingCtx`) as the Sessions list, so *working /
    ready / needs-you / stopped / crashed* agree everywhere instead of the feed showing a blanket
    "running". The status word appears in the line's metadata in its matching tone.
  - **Lens + filter live in the URL** (`?lens=&filter=`). There is no forced default anymore — the page
    opens on whatever you last selected, and a refresh restores it (parity with the Sessions filters).
  - **Open the associated session** from any line — its live terminal when the run is still around, else
    the Sessions page.
  - **Show history removed** — the trail expander wasn't earning its space (the endpoint stays for now).
  - **Leaner lines:** the agent is shown once (a chip), not repeated in the sentence; the activity snippet
    clamps to two lines with a **More/Less** toggle; and cost is shown as a **token count** (`12.3k tok`)
    rather than a dollar figure. `FeedItem` gains a `tokens` field (input + output); `feed-smoke` covers it.
  See `docs/feed-plan.md`.

## [0.350.0] — 2026-08-14
### Added
- **The feed folds in the `messages` notification class, and the Goals lens is the default.** Two changes
  to the activity feed (v0.348/0.349):
  - **Notifications/updates now appear in the stream.** A fourth `UNION` branch in `FeedStore` folds the
    surviving `messages` cards — `update` (an agent's progress note), `notification` (a session-less
    `notify`/system card), `task` (a Tasks notification) and `artifact` (a published deliverable) — into
    the feed under a new `state='info'` (an ambient event, neither a decision nor running/done). It
    deliberately excludes `approval`/`question` (their own branches) and `completed` (it duplicates the
    session's `done` line), and drops dismissed cards. Visibility reproduces `TerminalManager.canViewMsg`
    exactly in SQL — the branch projects a `member`-audience target (`aud_member`) and the non-admin scope
    ORs it with the session's `run_as`/`spawned_by`, so a card is visible to its addressed member OR the
    session's human, owner/admin see all. So the old inbox is no longer a separate read surface — the one
    stream carries it. `scripts/feed-smoke.cjs` gains coverage for the fold + the audience scope.
  - **Goals is now the default lens, collapsed.** Opening the Feed shows the outcome-first view with every
    goal section collapsed (a clean overview — title, progress, count), plus a one-click **Expand all /
    Collapse all** toggle. The Feed (by-time) lens and its filters are one click away.
  See `docs/feed-plan.md`.

## [0.349.0] — 2026-08-14
### Added
- **The Feed page — the console surface for the unified activity stream (v0.348.0 backend).** A new
  primary nav item (pinned by default) that renders `/api/feed` as one time-ordered stream, read two
  ways via a lens toggle: **Feed** (by time) and **Goals** (the same lines grouped by outcome, each goal
  collapsible with its rolled-up progress bar). Every line leads with attribution — the agent, the human
  it runs as (avatar + name), a provenance hint (*via automation/task/chat*), and a clickable goal tag —
  so "who is asking what" is answered in the row itself. Decisions are highlighted inline (amber for
  approvals, sky for questions) and actioned in place: **Approve/Deny** (gated by `canApprove`, else a
  "waiting on an owner-level approver" note) and **Reply** to a question, both resolving optimistically
  and dropping off the 4s poll. A resolved/finished line carries a **Show history** toggle that lazy-loads
  its step-by-step trail from `/api/feed/:runId/trail` (the append-only `audit_events` ⋃ `task_events`).
  Filter chips (All · Needs you · Running · Done) carry live counts and, in the Feed lens, scope the
  stream; keyset **Load more** paginates. Reuses the cross-domain status glyph, role-tinted chips, and
  member-avatar primitives, so it reads as part of the existing console. `api.feed()` / `api.feedTrail()`
  added to the client. The surviving `messages` cases (`update`, session-less notifications) folding into
  the stream come next. See `docs/feed-plan.md`.

## [0.348.0] — 2026-08-14
### Added
- **A unified activity feed (`os.feed`) — one stream to replace the inbox/tasks/sessions/notifications
  split.** The console makes a human reconcile four surfaces that are really the *same work* at different
  stages, so you can't tell at a glance who is asking what, resolved items vanish, and the inbox is dead
  weight unless something is actively blocked on a person. This is the backend for a single time-ordered
  stream, read by **time** or by **outcome (goal)**, where a human is pulled in only for the decisions the
  fleet can't make itself — and the stream *is* the history, so nothing disappears once you answer it.
  The key move: there is **no `feed` table**. `FeedStore` (`src/state/feed.ts`) is a read-only view that
  `UNION ALL`s rows already living in `term_sessions`, `approvals` and `questions`, LEFT JOINing each
  session → its task (`tasks.last_session_id`) → the task's goal so **attribution is on every line**:
  `agent`, `run_as` (the accountable human), `spawned_by` (raw provenance), and the goal tag. A session
  surfaces at its current state (running → a live line; finished → a done line with outcome/rating/cost);
  an approval/question is its own line — a `decision` while pending, resolved `history` once answered.
  New endpoints: `GET /api/feed?filter=all|needsYou|running|done&goal=<id>&cursor=<c>` →
  `{ items, nextCursor, counts:{ needsYou, running, doneToday } }` (the **goal lens** is the same endpoint
  with `?goal=`; the **"Needs you"** rail is just `filter=needsYou` = pending approvals ∪ pending
  questions, a query not a stored list), and `GET /api/feed/:runId/trail` →
  `{ steps }`, the step-by-step past rebuilt from the append-only logs (`audit_events` ⋃ `task_events`,
  oldest first) so a resolved decision keeps its full trail forever. Visibility mirrors
  `canViewSpawn`/`canViewRow` (owner/admin see all; else run-as / own-provenance / own-automation),
  applied in SQL so keyset pagination stays correct. Adds `approvals.resolved_at` (parity with
  `questions.answered_at`, so a resolved decision sorts by when you decided, stamped in
  `resolve()`/`cancel()`) plus feed indices. `scripts/feed-smoke.cjs` (in `test:governance`) pins union
  ordering, the attribution/goal joins, counts, every filter, the goal lens, scoping, keyset pagination,
  and the trail. The React console surface and folding the surviving `messages` cases into the union come
  next. See `docs/feed-plan.md`.

## [0.347.0] — 2026-08-14
### Added
- **`skill_propose` can update a skill, not just create one.** Lever 6 gave the fleet a way to write its
  own playbooks and a human gate in front of them — but the tool was create-only: an agent that had just
  learned the `wp-version-upgrade` skill was missing a step could only be told *"a skill named
  wp-version-upgrade already exists"*. There was no `skill_update`, no propose-an-update path, and no
  supported way to fix a skill short of a human editing it in the console. So the fleet could author
  procedural memory but never *revise* it — the half of learning that matters most once a library exists.
  `skill_propose` is now **create-or-update, chosen by the name**. A new name behaves exactly as before
  (a `.aos-proposed` draft, invisible until published). An existing name proposes an **edit**: the full
  replacement text is parked at `<home>/skills/.proposed-edits/<name>.json` and the **live skill is left
  untouched** until an owner/admin applies it (Skills page → *Edits proposed by agents*, a side-by-side
  live-vs-proposed review with Apply / Discard; `POST /api/skills/:name/edit/apply` | `…/edit/discard`).
  The parking spot is outside the skill folder on purpose: `copySkill` ships a skill's whole folder into
  every agent, so a marker file *inside* it would hand the un-reviewed text to the fleet — exactly what
  the gate exists to prevent. `scripts/skill-edit-proposal-test.cjs` (in `test:governance`) pins that:
  after a proposal, a materialise must still deliver the old text byte for byte.
  Two guards come from the `agent_get` / CLAUDE.md clobbering lessons, since an edit REPLACES the whole
  SKILL.md: a new read tool **`skill_get`** returns a skill's current text (plus whether it's active for
  the caller and whether an edit is already pending), so a revision starts from the real thing rather than
  a rewrite from memory; and there is **one pending edit per skill** — the same agent may replace its own,
  a different agent is refused rather than silently overwriting a teammate's un-reviewed draft. An agent
  refining its OWN unpublished draft rewrites it in place (nothing is live, so there is nothing to gate).
  A body sent without frontmatter inherits the skill's current `description`, so an edit to the steps
  can't blank what agents match on. The outcome sentence the agent sees is composed **server-side** and
  echoed by the tool, because an MCP process outlives a server upgrade. Audited `skill.edit.proposed` /
  `skill.edit.applied` / `skill.edit.dismissed` / `skill.draft.updated`.

## [0.346.0] — 2026-08-14
### Added
- **Runtime-account usage refreshes itself.** The pool's *limit* state already self-healed (`recover()`
  runs inside `list()`/`get()`/`pick()`, so a parked account un-parks the moment its reset passes), but the
  usage snapshot — the `wk 96%` / `5h 35%` on Settings → Runtime accounts — was written only at add-time
  and by a human clicking **Refresh**. So the percentages were a frozen reading from whenever someone last
  clicked, and an account that hit its wall in a way our teardown detector missed (or under another
  process) still showed a comfortable number.
  Reading the pool now kicks a background re-probe of every enabled Claude account whose snapshot is older
  than 10 minutes (`src/edge/runtime-account-usage.ts`), applying the result exactly like the manual
  Refresh: an exhausted window parks the account, a clean authentication clears a stale limit. One 1-token
  Haiku call per account, in-flight probes de-duped across readers, at most 8 per sweep — so the cost is
  bounded by the staleness window, not by how often the page is polled. `GET /api/runtime-accounts`
  returns `refreshing: ["<runtime>/<name>", …]`; the console shows `checking…` on those rows and re-reads
  once they land, and each usage cell now carries its `lastCheckedAt` as a tooltip so a snapshot never
  reads as a live number. Audited (`runtime.account.checked`, `auto: true`) only when the probe actually
  changes health or status — a healthy sweep is silent.
  Deliberately **not** included: reviving a disabled account. `enabled = 0` means a human pulled it or a
  live 401 auto-disabled it; the manual Refresh stays the way back into rotation.
- `scripts/runtime-usage-refresh-test.cjs` (17 assertions, in `npm run test:governance`) pins the
  selection rules, limit reconciliation, audit quietness, in-flight de-dupe, and that a failing probe
  leaves the last known snapshot intact.

## [0.345.0] — 2026-08-13
### Fixed
- **Claiming a session made it immortal.** The idle-interactive reaper skipped `claimed_by IS NOT NULL`
  rows unconditionally — "a human owns that lifecycle" — but nothing ever expires a claim, so anyone who
  hit "take over" and then closed the tab left a pane running forever. Live instawp: seven sessions
  claimed by one member, idle **143–168 h**, skipped by the 72 h reaper every tick for a week. Together
  with their peers they filled the concurrency cap and starved every scheduled run on the tenant for a
  month (see v0.344.0, the other half of the same outage).
  The exemption stays; it now has a **ceiling**, exactly like the blocked-on-a-human exemption directly
  above it in the same sweep — which was unconditional for the same reason and got the same treatment.
  New `claimedMaxHours` (Settings, default **72 h**, `0` restores the permanent exemption). A session
  someone is **actually attached to** is still never cut, whatever the clock says: that is what "a human
  owns it" should have meant. Reaped rows audit as `claimed-abandoned` and name who had claimed them, so
  it reads as a traceable take-over expiry rather than the janitor closing an ownerless pane.
- **`PUT /api/settings/concurrency` silently ignored `blockedMaxHours`.** The key was declared in the
  request type and echoed back in the response, but had no handler — so setting it returned 200 with the
  value unchanged. Now applied and audited like its siblings.

### Changed
- `scripts/idle-reaper-test.cjs` grows a claim-ceiling section (41 assertions total). Note one existing
  assertion **inverted**: a 96 h-old claimed session used to be pinned as "left running", which was the
  bug being asserted as correct.

## [0.344.2] — 2026-08-13
### Fixed
- **A runtime account stayed stuck on "limited · resets …" long after it was usable again.** The
  console reads accounts through `RuntimeAccountStore.list()`, but the lapsed-limit self-heal
  (`recover()`) only ran inside `pick()`/`allLimited()` — i.e. on an actual launch. On an idle runtime
  nothing called it, so a limit whose reset had already passed showed frozen indefinitely. `list()` (and
  `get()`) now run `recover()` first, so an expired limit clears on the next console load.
- **The Refresh button couldn't clear a stale limit.** `recordCheck` only updates the usage snapshot and
  the `/check` handler re-parked an account limited *only* when the probe reported an exhausted window —
  so a Refresh that authenticated and found the account healthy (e.g. weekly 75% / session 46%, nowhere
  near the cap) refreshed the Usage cell but left the "limited" badge untouched. A healthy probe with no
  exhausted window now clears the limit via the new `RuntimeAccountStore.clearLimit()`.

## [0.344.1] — 2026-08-13
### Fixed
- **Opening a session on a busy box greeted you with tmux's raw `can't find session: aos-…`** — for a run
  that was launching perfectly normally. The ttyd attach wrapper waited a fixed ~3s for the pane to
  appear before concluding the session was dead, which is really a guess about how fast the host is. On
  a loaded tenant the guess loses: at load average 76 a spawn took **13.3s** (row written 12:01:23.037,
  `tmux new-session` at 12:01:36.324). The wait expired, the resurrect branch found no env file — a
  brand-new run hasn't written one — and the plain-attach tail printed tmux's not-found error. The
  session itself was fine and reported `success` four minutes later, so the only damage was to trust:
  the console said a healthy run had vanished.
  The wrapper no longer guesses. The server now holds a `session-<id>.launching` marker for exactly the
  window between "row written" and "pane exists" (mirroring the in-memory `TerminalManager.launching`
  set that `attach.sh` can't see from its own process), and the wrapper waits as long as a launch is
  actually in flight — showing `starting session…` instead of a blank pane. The marker is released in
  the launch's `finally`, so a **failed** launch stops the wait immediately rather than stalling it;
  stale markers are swept at boot; and a 120s ceiling bounds the `kill -9`-mid-launch case. With no
  marker at all — an older session, a resurrect, a mock pane — the original ~3s floor is unchanged, so a
  genuinely dead session still gives up promptly. Pinned by `scripts/attach-grace-test.cjs`, which
  reproduces the live symptom (exact error string) against the old wrapper.

## [0.344.0] — 2026-08-13
### Fixed
- **Abandoned browser tabs could silently switch off every scheduled run on a tenant.** The whole-box
  concurrency cap counted every live pane, but an **interactive** session stays alive until a human
  closes it *by design* — so parked TUIs accumulate and hold cap slots forever. One live tenant reached
  ~13 parked sessions (nine claimed by one person, seven untouched for over a week), sat permanently
  above its ceiling, and deferred **every cron for a month**: 31,570 consecutive `scheduler.deferred`
  events, not one automation fired. Daily support reviews, fleet-health sweeps and billing jobs simply
  did not happen, and nothing said so.
  The cap now compares against `TerminalManager.admissionSessionCount()` — sessions actually holding a
  **work** slot: headless runs, sessions with a turn in flight (the same `isWorking` predicate the
  console's spinner uses), and interactive sessions active within the last 30 minutes. A parked TUI is
  still alive and attachable; it just stops blocking scheduled work. Raising the cap was never the fix —
  parked panes keep accumulating, so it only buys weeks.

### Added
- **A `scheduler-blocked` alert**, because the condition above was detectable the whole month and only
  ever written to an audit row nobody reads. Fires when the scheduler is deferring **now**, has been for
  at least an hour, and has fired nothing in that window — then names the cap, the numbers, and parked
  sessions as the usual cause. Present-tense by construction: one successful fire, or one tick under the
  cap, and it is simply false again, so recovery needs no bookkeeping.
- Settings → Concurrency now reports `admitted` and `parked` alongside `alive`, so "34 running against a
  cap of 25" can explain itself instead of reading as genuine overload.
- `scripts/scheduler-admission-test.cjs` (18 assertions) pins both halves, including that admission never
  reaps and that a stale burst of deferrals does not keep alerting.

## [0.343.0] — 2026-08-13
### Added
- **Choose whether a goal plan auto-dispatches.** "Plan this goal" was hardcoded file-only — the strategist
  filed tasks and a human dispatched each one. The Plan modal now has an **"Auto-dispatch the planned
  tasks"** checkbox (**off by default**, so today's review-first behaviour is unchanged). When on, the
  tasks the plan files run on their own — each agent-assigned task dispatches the moment it becomes
  eligible, in `dependsOn` order, with no human step. Enforcement is **deterministic, not prompt-honoured**:
  `Strategist.plan({ autoDispatch })` flags the plan session (`TerminalManager.markPlanAutoDispatch`), and
  `/api/tasks/create` stamps `auto_dispatch=1` on every task that session files regardless of what the agent
  passed — so it never depends on the model obeying an instruction. Plan tasks route through the ~20s
  scheduler tick (`dispatchable()`) rather than the immediate create-time dispatch, so the whole plan drains
  in pipeline order, one session per agent. The strategist's prompt is told the plan will auto-run (so it
  scopes tasks and orders `dependsOn` accordingly); its default file-only prompt is unchanged. Audited on
  `goal.planned` / `goal.plan.requested` (`autoDispatch`). Scoped to the manual "Plan this goal" button —
  the opt-in goal auto-planner stays file-only.
### Added
- **Reload a session onto another runtime account.** A run that hits "You've hit your session limit ·
  resets …" had no way back except starting over: credentials bind ONCE, at launch (`applyRuntimeAccount`
  writes them into `session-<id>.env`, which `attach.sh` replays verbatim on every resurrect), so the
  existing Reload always came back on the same exhausted account and rotation only ever happened on a
  brand-new session. Operations → **"Reload on another account"** (`POST /api/sessions/:id/reload`
  `{rotate:true}`) picks the next available pooled account, **carries the conversation across**, rewrites
  the persisted launch env and comes back on the new login — same session, same `claude --resume`. The
  conversation part is the load-bearing half: each pooled account is a whole `CLAUDE_CONFIG_DIR` with its
  OWN `projects/`, so resuming under a different dir would otherwise hit "No conversation found with
  session ID …". The transcript is COPIED (the old account keeps its history, and a rotation that can't be
  completed changes nothing). Best-effort by design — with no second account free the session still
  reloads, on the account it had, and the toast says why. Audited `runtime.account.rotated`.
- `pick(runtime, now, { exclude })` on `RuntimeAccountStore` — the LRU order alone doesn't guarantee a
  *different* account (with a pool of one it hands back the very account being rotated away from).

### Fixed
- **A session that ran under a pooled account read back as having no transcript.** The reader resolved
  `projects/` from the SERVER's own environment only, but a rotated session writes under its account's
  config dir — so the console's conversation view came up blank and `detectUsageLimit`'s transcript
  fallback (the durable half of limit detection, added precisely for these runs) never found anything.
  Pool credential dirs are now registered as transcript roots, refreshed before each read so an account
  added after boot isn't invisible for the life of the process.

## [0.341.2] — 2026-08-13
### Fixed
- **A task Discussion rendered agent messages as raw markdown.** Agents write markdown, but the Discussion
  body was drawn as plain text (only `@mentions` were pulled out), so `**bold**`, `` `inline code` ``
  (branch names, `/code-review ultra 630`, `develop`/`master`), and numbered/bulleted lists all showed
  their literal syntax. `DiscussionBody` now renders through `ReactMarkdown` (same `remarkGfm` +
  `[[wiki]]`/entity linking + `mdComponents` as every other markdown surface), with a small `remarkMentions`
  plugin so `@mentions` keep their highlight — and it no longer mistakes the `@` inside an email like
  `user@example.com` for a mention.

## [0.341.1] — 2026-08-13
### Fixed
- **Guided runtime-account login failed hard on the first partial capture of the authorize URL.** The
  poll scraped the CLI's `oauth/authorize?…` line and, the instant it saw a URL without a `state=` tail,
  permanently failed the login with "the sign-in link came back incomplete from the runtime" — so a poll
  that merely caught the line *mid-render*, or a URL the CLI wrapped across rows inside a fixed-width box
  (real newlines `capture-pane -J` won't rejoin), killed the whole flow with no retry. Now an incomplete
  URL is treated as transient: the poll keeps waiting for a whole one and only gives up after an 8s settle
  window, and `extractAuthorizeUrl` reassembles a URL split across rows (conservatively — a row with a
  space or prose, like the "Paste code" prompt, ends the URL and can never be fused into the query string).

## [0.341.0] — 2026-08-13
### Added
- **The task hand-off chain is visible.** `parentId` — set whenever an agent spawns work out of work it
  was already doing — reached the client and was rendered nowhere, so a board where ~40% of tasks have a
  parent read as a flat pile of siblings. Three surfaces now show it: a **Group: Chain** lens on the list
  view that nests each task under the one that started it (depth-first, siblings in the list's own sort
  order); a **fan-out badge** on every row that spawned others, in *all* grouping modes; and a **Chain**
  block in the task room with the ancestor breadcrumb ("spawned by") plus the tasks this one spawned.
  A task whose parent is off the current board surfaces as a root rather than vanishing — narrowing the
  board must never hide work.
- `TaskStore.children()` + `children` on `GET /api/tasks/:id`. The room resolves subtasks server-side
  because the board ships a bounded page: deriving them client-side under-counted a wide fan-out, and a
  "spawned · 6" that is really 12 is worse than no number.
- The list view's grouping choice is sticky (`aos_tasks_group`), like the view mode beside it.

### Changed
- **The sessions list gave two fixed columns to data that mostly isn't there, and the title paid.** On
  instawp only 41% of sessions record a cost and 41% a duration (32% for task-spawned runs), so `Took`
  and `Cost` were `—` on most rows while every session title truncated. `Agent` moved into the title
  cell as a chip (it's short and low-variance, and the chain strip only ever named the *children*, so the
  root's own agent was the one thing a chained row didn't say); `Took` merged into the metrics cell as
  `2m · $0.14`. That returns ~11rem to the title at laptop widths. Sorting by agent is now the "All
  agents" filter's job; duration sort folded into cost.
- The chain strip in a session row is capped and clips on one line instead of wrapping — an uncapped
  4-agent chain ate the title down to a few characters, and a wrapped strip made that one row twice as
  tall as its neighbours.

## [0.340.0] — 2026-08-12
### Fixed
- **A webhook fired at a busy agent silently lost the event.** `fireWebhook` spawned with
  `guard: true`, so any delivery arriving while the previous run was still alive came back **429** with
  nothing queued — and a product webhook does not retry a 4xx, so the event was simply gone. The busier
  the agent, the more it dropped. The guard is a *cron* rule (the next occurrence is equivalent to this
  one) and does not hold for webhooks, where two events are two different pieces of work. Deliveries now
  spawn unguarded, and volume is handled before spawning instead of by refusing to spawn.
- **Webhook automations defaulted to `interactive`** — every other event-driven trigger defaults to
  `headless`. A hook-created automation therefore opened a TUI nothing would ever attach to, which then
  blocked the next delivery, because an interactive pane never exits. Now `headless` like its siblings.
- **`Automations.add()` rejected `type: 'clickup'` outright** ("type must be cron, webhook, composio,
  slack, discord, or telegram") despite it being a valid type everywhere else, so a per-task ClickUp
  automation could not be created. Accepted now, and wired into the console's trigger picker, filter
  field, summary and icon.
- **`update()` ignored `filter` on webhook automations**, so the one trigger type that most needs
  scoping was the only one you could not scope after creating it.

### Added
- **Webhook ingress: event filter, dedupe, body signatures, conversation continuity**
  (`docs/webhook-ingress.md`, `src/edge/webhook-ingress.ts`). Three new per-automation fields, all
  optional, all defaulting to the previous behaviour so existing hooks are untouched:
  `filter` (comma-separated event names, `prefix.*` for a family), `threadPath` (dot path to the
  source's conversation id — a follow-up continues the run already handling that ticket instead of
  racing a second agent onto it), and a write-only `signingSecret` (HMAC over the raw body; configured
  ⇒ unsigned deliveries are refused, so a key in a URL stops being the only credential).
  Vendor-neutral by construction — the event name, delivery id and signature are matched by *shape*
  (`x-…-event`, `x-…-delivery`, `x-…-signature`, in either algorithm and either encoding), so a source
  nobody here has seen needs no code.
- Everything declined now answers **200** with a reason (`skipped: 'filter' | 'duplicate'`) rather than
  a 4xx a sender would read as "retry or disable me", and every delivery appends a `trigger.webhook`
  audit event with its outcome — so "did that event reach an agent, and if not why not" is one query.
- `scripts/webhook-ingress-test.cjs` (58 assertions) pins all of it, including the regression itself:
  a second ticket arriving during a live run still gets its own session.

### Security
- `signingSecret` is stripped in `automationView` alongside the hook key — a bare spread would have
  shipped it to every admin's browser. The console only ever learns `signed: true|false`.

## [0.339.0] — 2026-08-12
### Changed
- **"Is it working?" now measures the world instead of our own clicks** (`docs/insights-revisit.md`
  Step 4). Both halves were broken the same way.
  The **trend** counted a run as successful only if it self-reported `outcome: success` — the number
  Step 0 deleted from every broadcast channel, still quietly driving the page. It now reads the derived
  outcome and carries the **undecidable share beside the rate**, so "the work got worse" can never again
  be read off a number that moved because reporting discipline moved. On the live corpus it produces a
  usable trend for the first time: 58% → 54% → 75% → 58% → 80% over recent weeks, undecidable 0–3%.
  The **interventions** were `recommendation.applied` events — one in the fleet's entire history, so the
  block could never answer anything. Replaced by: a card was raised, did a human do anything, did the
  problem stop. It counts **events, not rates** ("12 runs died, you replaced the account, 0 since" is
  checkable; a rate hides it behind a denominator that also moved), and the verdicts are chosen so the
  uncomfortable one is reachable — **`no-action`**, because a card nobody acts on is a failed card, next
  to `resolved`, `ongoing` and `too-early`. A card whose recurrence cannot be counted is omitted rather
  than given a made-up verdict, so today only Step 2's runtime-death signal appears.
  Pinned by `scripts/card-measurement-test.cjs` (16 assertions).
## [0.338.1] — 2026-08-12
### Fixed
- **An expired GitHub token is no longer injected into a session's env, where it shadowed a working box
  credential.** `injectMemberGithub` read the run-as member's vault blob synchronously at launch and
  exported it as `GH_TOKEN`/`GITHUB_TOKEN` regardless of whether it was still alive — the fire-and-forget
  refresh it kicks only helps the NEXT launch. Those user tokens live ~8 h and nothing refreshes them
  proactively, so any run starting after a quiet gap got a corpse. That is strictly worse than no token:
  `gh` prefers the env over its keyring, and `configureGitCredentials` resets the inherited git helper for
  github.com, so a dead string made every `git`/`gh` call hard-fail with *"GITHUB_TOKEN in the environment
  is invalid and overrides your good keyring credential"* until the agent stripped the var by hand. Both
  injection paths now withhold an already-expired blob (new `GithubIdentity.isExpired` — the harder
  condition `needsRefresh` deliberately doesn't distinguish, since a merely-stale token is still usable),
  leaving the env unset exactly as `injectShellSecrets` does for an unresolved key so both tools fall back
  cleanly; the refresh still fires so the next launch is whole. Audited `github.token.expired` /
  `github.bot_token.expired`. On the live instapods tenant this fired on ~10% of launches
  (54 `github.token.stale` events against 554 injections). Note this does NOT rescue a session whose token
  dies *mid-run* — env can't be mutated from outside the process, so a run outliving its token (60 of 611
  in the last 30 days) still needs the `github_refresh` tool.
- `scripts/github-per-member-test.cjs` now runs in `npm run test:governance`, pinning the guard along with
  the rest of the per-member GitHub credential path.

## [0.338.0] — 2026-08-12
### Added
- **The sidebar session switcher grew the same "⋯" actions menu the sessions list has.** Every row in
  the sidebar's session list now reveals a `RowActionsMenu` on hover (and on keyboard focus, and while
  the menu is open) — Resume, Take over, Fork, Stop, Delete, Transfer to…, each gated exactly as it is
  on the list page. Until now those actions were only reachable by leaving the sidebar for **All
  sessions**, even though the sidebar is where you actually live while a run is going. The trigger is a
  SIBLING of the row's link, not a child (a button nested in an `<a>` is invalid interactive content and
  swallows navigation), and it holds its place at `opacity-0` so hovering reveals it without reflowing
  the title. `RowActionsMenu`'s `onActivity` is now optional: the inspect panel it opens belongs to
  SessionsPage, so the sidebar mounts the same menu minus that one item.

## [0.337.2] — 2026-08-12
### Fixed
- **The terse brief's carve-out no longer reads as a licence to be long.** A terse `engineer` run
  answered a console question at essay length and the owner had to reply "explain to me in 1 liner" —
  which looked like the verbosity flag failing, and wasn't: the session was stamped `verbosity=terse`
  and the workspace default is terse, but human-facing prose (`report`, `ask`, the chat replies) is
  deliberately EXEMPT from compression so terse phrasing can't degrade memory, consolidation and the
  surfaces teammates read. The exemption ended on "write them in full, ordinary prose", and that is the
  half the model acted on. `TERSE_OUTPUT_BRIEF` now separates the two axes: those surfaces stay
  uncompressed, keep their caveats and stay ordinary prose, but they must lead with the answer, must not
  summarise and then restate the same content as detail, must not recount the steps to a finding the
  finding implies, and must answer a narrow question narrowly before widening. Compression is still off
  there; shape is not. Pinned by new assertions in `scripts/verbosity-test.cjs` that hold BOTH halves —
  the brevity clauses and the "completeness wins over length" guarantee they must not eat.

## [0.337.1] — 2026-08-11
### Docs
- **`docs/journal-plan.md`** — Step 3 of the Insights rebuild, planned concretely. The day-by-day
  changelog already exists (`buildDigest` + a dated KB page per day) and is the only Insights block with
  sustained use — 26 `digest.posted` against ~one human action from the other thirteen. So the work is a
  promotion, not a build: give it its own **Journal** nav surface, let it read backwards in time from the
  frozen KB pages, rewire its verdicts off the agent's own `report()` onto the derived outcome from Step
  1b, and only then add one bounded human-facing paragraph per day over the deterministic model
  (~$0.005/tenant/day at the Haiku default). Four gated steps, each independently shippable, each with a
  falsifier — including "if only today is ever opened, drop the day picker and stop". Names three
  correctness traps found while writing it: re-rendering a past day would staple *today's* learned
  guidance onto it, the per-agent line caps live in the model rather than the chat render (so the console
  preview is truncated too), and `signals.costUsd` sums a per-transcript cumulative cost across resumed
  runs. `docs/insights-revisit.md` Step 3 now points at it.

## [0.337.0] — 2026-08-11
### Fixed
- **Runtime-death remediation was firing on ~10% of the events it exists for.** `detectUsageLimit` parks
  an exhausted runtime account and retires one with a dead token, so the pool rotates away from it — but
  it reads the **tmux pane**, which a run killed on its first API call has usually already lost. On the
  live corpus the derived outcome finds **31** quota/auth deaths in 30 days; the detector had fired on
  **3**, and the pool recorded **zero** `runtime.account.limited`/`.invalid` events. The machinery was
  right and was not being reached. It now falls back to the transcript tail — durable, unlike the pane —
  and every detection audit carries `via: 'pane' | 'transcript'` so the coverage this claims to fix is
  itself measurable. The `usage` vs `auth` split is preserved end to end, and **auth wins a tie**: both
  banners often appear together, and parking a dead token is the dangerous mistake — it "self-heals" at a
  reset that will never fix it, then rejoins the pool still broken.

### Added
- **A card for runs the runtime killed** (`docs/insights-revisit.md` Step 2 — the first end-to-end signal
  of the rebuild). These are the fleet's most common real failure and were invisible until the derived
  outcome existed: an agent cannot report "I hit my quota" when the agent is what stopped existing, so the
  runs looked like silence. Grouped by **runtime account**, not by agent — that is what a human acts on,
  and the per-agent view misleads (the top "offender" was just the automation that runs every two hours,
  while 23 of 31 deaths traced to one shared account). Fires at ≥3 deaths in 48h with one in the last 12h,
  and says something different when there is no pool account at all (add rotation, rather than re-link
  this one). Present tense by construction: deaths arrive in bursts (22 of 31 inside two days), so a long
  window would re-alert for a month about a token replaced on day three — verified against the live
  corpus, where the card fires when evaluated during the burst and is silent when evaluated today.
  No buttons on the card: it deep-links to Settings → Runtime where the actions already live, because
  building a bespoke action API before knowing whether anyone clicks through is the mistake this rebuild
  exists to stop. Pinned by `scripts/runtime-death-alert-test.cjs` (13 assertions).

## [0.336.0] — 2026-08-11
### Fixed
- **An unattended run that launches background work is no longer killed while it's still working.** The
  turn-end teardown (`markTurnIdle`) treated a turn boundary as the end of the run, which it is —
  unless the agent launched a subagent, a forked skill (`/code-review …`), or a `run_in_background`
  command and handed the turn back to be woken when that finishes. Claude Code does wake it, but the
  pane was already gone: the run and its children died mid-work and it never reached `report`. Live
  case (instapods `ses_11dd20920d30aae4`, $12.34): PR pushed, review forked, "I'll fold in whatever it
  finds before closing the task out", reaped 300ms later — the review killed with it, the task left
  `doing` for ten minutes until the stranded sweep poked the caller, which cost another $18.99 to work
  out what had happened. 49 unattended runs were reaped at turn-end with no report in the preceding 14
  days. Teardown now defers while children are outstanding (`pendingBackgroundWork` reads the
  transcript's launch acks vs `<task-notification>` completions), bounded by a 15-minute grace measured
  from the FIRST defer and audited both ways (`session.turnend.deferred`, then a
  `turn-end-grace-expired` reap) — so a never-ending `sleep` loop costs one window, once. A run that
  has already called `report` is torn down regardless: `report` means finished, whatever it left
  running. Fails open on any unreadable transcript. Pinned by `scripts/turn-idle-background-guard-test.cjs`.

- **The governance gate is green on CI again.** `claude-config-isolation-test.cjs` §7 called
  `applyConfigIsolation`, which reads the real `os.homedir()` — and isolation correctly no-ops when
  that home has no `.credentials.json`. A maintainer's laptop is logged in, so it passed locally and
  failed on every CI run since the test landed (2 checks, red on `main` for 5+ commits — a gate that
  said nothing about the code). §7 points `$HOME` at its own fixture box home now, so it asserts the
  wiring rather than the runner's login state, and the no-login case it used to depend on by accident
  is asserted deliberately.

### Added
- **Unattended runs are told that their turn boundary is a run boundary.** The server-side grace alone
  would have let the same agent idle rather than finish — it invented `until [ -f … ]; do sleep 15`
  loops because nothing said waiting wasn't available to it. `UNATTENDED_TURN_BRIEF` rides the system
  prompt on the headless, non-resident lane only (where it's true) and names the alternatives the OS
  already provides — `task_wait` for a delegate, `ask` for a person, `schedule` for a future run,
  `task_create` to park the rest — plus `report` before stopping, always.

## [0.335.5] — 2026-08-11
### Changed
- **CLAUDE.md imports the maintainer's decoder ring instead of expecting it to be read by hand.** The
  public manual documents that the real tenants/hosts/IPs live in `~/.claude/agentric-fleet.local.md`,
  but nothing loaded that file, so a session had the placeholders and not the mapping. It's an
  `@~/.claude/agentric-fleet.local.md` import now: resolved on a maintainer's machine, a no-op missing
  file on anyone else's clone. The manual itself stays committed and placeholder-only — the alternative
  (gitignoring CLAUDE.md) would strip the repo's operating manual from every fresh clone while leaving
  it in history anyway.

## [0.335.4] — 2026-08-11
### Fixed
- **The two remaining external image links are committed assets now.** `docs/ARCHITECTURE.md` embedded
  the architecture diagram from a CleanShot share URL — which serves an HTML page, so the image was
  broken on GitHub — and the README's "Full size" link pointed at another one. The diagram lives at
  `docs/assets/architecture.jpg`; the README link is gone (the screenshot beside it is already local).
  Also the last third-party host in a tracked file, ahead of the history rewrite.

## [0.335.3] — 2026-08-11
### Changed
- **Public-repo hygiene: no real infrastructure in a tracked file.** The repo is public, and it named
  the boxes it runs on — ssh targets (`user@203.0.113.x` were live droplets), a Tailscale MagicDNS
  name, private tenant hostnames, `/Users/<me>/…` paths, an owner email, and the four real tenant
  slugs across 75 files including every incident note in this changelog. All of it is now placeholder:
  tenants are `northwind` / `globex` / `initech` / `umbrella`, hosts are `your-box.tailnet.ts.net` and
  `*.example.com`, IPs come from the RFC 5737 documentation ranges, service homes are `/home/agent-os`.
  No credential was ever committed; this is reconnaissance surface, not a leak.
- **`scripts/make-live.sh` takes its deploy identity from an untracked env file**
  (`~/.agentric-live.env`, override with `AOS_LIVE_ENV`) instead of hardcoding one box's launchd label,
  tenant slug and log path. Falls back to generic `acme` defaults and fails fast when the file is absent.
- **`terminal/claude-settings.json`** no longer hardcodes one machine's absolute path to the gate hook
  (`${AOS_REPO:-/path/to/agent-os}/terminal/gate-hook.sh`), and `agent-os.service` ships a neutral
  `agent-os` service user rather than the author's account.

### Removed
- **The `fleet-insights` maintainer skill** (`.claude/skills/fleet-insights/`). It exists to read the
  live tenant databases over ssh, so its whole value was the ssh targets it listed. It is personal-scope
  now (`~/.claude/skills/`), not something a public checkout should carry.

## [0.335.2] — 2026-08-11
### Fixed
- **An "Edit proposed for X" DM now links to X's own settings page.** The review DM for an
  `agent_propose_update` said "Review it in the Agentric console" and pointed at the Agents index, so a
  reviewer landing there had to find the target agent themselves — five proposals in one batch meant five
  identical links. `ReviewNotice` gained an optional `link` (page + detail + label) that overrides the
  kind's default page, and the agent-edit proposal sets it to `#/agent/<target>`, where the review card
  actually lives (parity with the inbox row, which has deep-linked by target all along). Pinned by
  `scripts/review-notify-test.cjs`, now part of `npm run test:governance`.

## [0.335.1] — 2026-08-11
### Changed
- **README rewritten, and the feature list is now complete.** The old README documented roughly a third
  of what ships (no Goals, Tasks, Apps, Library, Media, Skills, Insights, Codex, self-editing agents,
  chat egress, per-member GitHub, multi-tenancy…). It now carries a grouped feature index — governance
  and trust · running agents · work · knowledge and learning · integrations · operations — that a reader
  can check against `docs/PILLARS.md`. The prose is also de-AI-ified against the
  [humanizer](https://github.com/blader/humanizer) pattern list: no em dashes, no decorative emoji,
  sentence-case headings, no promotional inflation, actors restored to passive sentences.
- **A second README screenshot** (`docs/assets/console-session.jpg`): a live agent session in the browser
  terminal, so the "watch it, take it over, hand it back" claim has a picture.
- **README hero screenshot.** The README now leads with a shot of the console Overview (live sessions,
  what's blocked on a human, who's online) — committed to `docs/assets/` rather than hotlinked, since
  the share link it came from serves a signed URL that expires.

## [0.335.0] — 2026-08-11
### Added
- **A governed session no longer reads the box owner's personal claude config.** Every Agentric run is a
  `claude` process owned by the same OS user as the human who owns the machine, so it loads that human's
  user-scope `~/.claude/settings.json` — including `enabledPlugins`, and with it a plugin's extra subagent
  types, skills, slash commands and **SessionStart prompt hooks**. On the Mac Mini this surfaced as
  northwind sessions calling a `caveman:cavecrew-reviewer(…)` subagent nobody had given them, with the
  plugin's prompt hook quietly reshaping fleet output. It is a behavioural channel into every agent that
  no manifest declares, the gateway never sees, and that changes whenever the owner installs something.

  Behind **`AOS_CLAUDE_CONFIG_ISOLATION=1`** (default off), a claude-code session now launches with
  `CLAUDE_CONFIG_DIR=<tenant home>/claude-config` — a user-scope layer Agentric owns. Two things are
  carried across as symlinks back to the box dir, because without them the cure is worse than the disease:
  `.credentials.json` (an empty config dir does not fall back to the box login, it drops the run on the
  interactive login picker, where an unattended session hangs until the reaper) and `projects/` (the
  server resolves transcripts from its own environment, so a session writing them elsewhere would blank
  the conversation timeline and the hand-off chain). One credential file behind one link means a refresh
  can never leave one side stale.

  Fail-open throughout, like account rotation: no box credential, or any error preparing the dir, and the
  session launches on the box config unchanged (`claude.config.isolation.skipped`). Rotation still wins —
  a pooled account already **is** an isolated config dir. `claude.config.isolated` records the dir and the
  two ways it can degrade silently: `credentials: detached` (claude replaced the symlink on a refresh, so
  the dirs can diverge — the newer token is left alone rather than clobbered) and `projects: own`.
- The unattended lane now declares **`skipDangerousModePermissionPrompt`** in its own `--settings` layer.
  It runs `--dangerously-skip-permissions`, and claude's one-time acceptance of that mode was being
  inherited from the box owner's user settings — the exact state config isolation removes, which would
  have parked every unattended run on a dialog with nobody there to answer it. Not a governance change:
  the PreToolUse gate hook remains the authority on every effect regardless of permission mode.

## [0.334.2] — 2026-08-11
### Fixed
- **One liveness predicate, and it asks the pane.** v0.334.1 fixed the poke-back's `status = 'running'`
  liveness test by adding `TerminalManager.reachable`, and left the older status-folding `isAlive` in
  place for the pile-up guards. A sweep of that method's remaining ten call sites found **every one of
  them wrong in the same direction** — it calls a session with a live REPL dead:
  - `takeOverSession` / `openChatSession` — a take-over of a run that had already `report`ed took the
    "dead → resurrect" branch and relaunched claude **over its own live pane** instead of claiming it.
  - `agentAskStatus` — a delegate that answered and was still wrapping up got graded `failed`, so the
    caller unblocked on a false "your delegate died".
  - `maybeHoldDelegate` — a HOLD or cancel aimed at a reported-but-working delegate decided there was
    "nothing running to interrupt" and never reached it (the 2026-08-06 incident's remaining half).
  - `refreshAgentSkills` — a just-approved skill install skipped the very session whose human approved
    it, which then kept insisting it had no such skill until its next run.
  - the dispatch pile-up guards (`fire`, `dispatchTask`, `dispatchTasks`, `task_wait`, the app-trigger
    poll) — a busy agent read as free, so a second session stacked onto work already in flight.

  Their shared shape is why this was worth doing as one pass rather than site by site: the fallback for
  "dead" is almost always `claude --resume`, so a false negative doesn't degrade — it puts a **second
  claude on a transcript the first still holds**. All ten now use `reachable`, and `isAlive` is
  **deleted** rather than kept as a synonym: with two predicates, a nine-tenths-correct choice is always
  available, and this class of bug already recurred once (the `resident` gate on `deliverToResident`).
  Widening the pile-up guards stays bounded — the idle sweep's DONE-ORPHAN branch reaps exactly the
  unattended `done`-with-a-pane rows they now count, and a human forcing work through passes
  `guard: false`. `scripts/poke-warm-caller-test.cjs` grew cases 7–9 (no status-folding predicate
  survives; the dispatch guard sees a warm worker; a skill install reaches a reported session).

## [0.334.1] — 2026-08-10
### Fixed
- **A poke-back now wakes the caller that is still running, instead of starting a second claude beside
  it.** When a delegate closed a `poke_on_done` hand-off, the OS chose between typing into the caller's
  live pane and `--resume`ing its transcript in a new session — and it made that choice on the session
  row's `status`. `status` is not liveness: an agent that calls `report` is stamped `done` while its
  claude keeps running, which is the *normal* shape for a caller (hand off work, report, carry on while
  the delegate finishes). So those pokes all took the resume lane and opened a **second claude on a
  transcript the first still held** — what `chatSend` calls "the one outcome worse than a slow turn".
  Observed on northwind 2026-08-10: `ses_f4535e8f` reported at 16:13 and worked until 16:34; its 16:31
  poke spawned `ses_441cec`, which died 28s later, and the caller never saw the result — it re-derived it
  by shelling out to `gh pr view`. Liveness is now asked of the **pane** (`TerminalManager.reachable`),
  which delivers into a reported-but-warm session, still refuses a run a human `stop`ped or the sweep
  marked `crashed`, puts the row back to `running` + busy when text lands, and — if the inject fails on a
  wedged pane — kills it before falling back to the resume. The same test now backs console injection and
  task-room delivery, which shared the `status = 'running'` gate. Pinned by
  `scripts/poke-warm-caller-test.cjs`.

## [0.334.0] — 2026-08-10
### Added
- **A bare entity id is now a link wherever it is displayed.** Agents constantly reference a row by its
  id in prose ("tsk_dcde91f9e81af705 is in progress with an engineer") — which left the reader holding a
  token they could only follow by hand-searching a list. `tsk_…`, `goal_…` and `art_…` now render as
  clickable links to that task / goal / deliverable in rendered markdown (including an id written in
  `backticks`, which is how agents usually write one), in raw-text surfaces like Inbox cards and memory
  notes, and **in the terminal itself** — the xterm linkifier gained an entity-id matcher alongside its
  URL ones, so an id printed in an agent's narration is clickable in the live pane. In-app markdown links
  (`#/…`) also stop opening a pointless new tab. Session ids are deliberately excluded: a session's route
  is keyed by its tmux name, not `ses_…`.

## [0.333.0] — 2026-08-10
### Added
- **A task room's Discussion is now a two-way channel to the agent actually working the task.** It used to
  be a log: a plain message a human typed there sat in the timeline until the agent next called `task_get`
  — which, mid-turn, is never — so the only reply that ever reached a working agent was one that happened
  to answer a pending `ask`. Now an unrouted human message is routed into the live run: it **answers** the
  run's open question when there is one (answering unblocks the turn; free text would only queue behind
  the ask), otherwise it is **typed into the live pane** (an idle agent reads it now, a busy one at the
  next turn boundary). With **two or more live runs it deliberately delivers to none of them** and asks
  which one the human meant — the wrong guess talks to the wrong worker — and the pick routes the
  already-posted message via `POST /api/tasks/:id/deliver`, so a declined or failed delivery never loses
  it. The composer says where a message is about to go, and what became of the last one.
- **Both halves of that channel are now told to the agent**, or it stays one-way in practice: the task
  dispatch prompt (fresh and resuming) states that humans watching the room see the Discussion and *not*
  its terminal narration, that a room message arrives mid-run prefixed `[task discussion] <name>:` and is
  a live instruction — including "stop" — and that `task_say` is the way back. The `task_say` tool
  description says the same. New `scripts/task-discussion-delivery-test.cjs` in `npm run test:governance`
  pins the ambiguity refusal, the no-double-send when an `@mention` already routed the message, and the
  prompt's own both-directions text.
- **The task room's details sidebar collapses**, so the discussion or an attached session gets the full
  width — which is usually why the room was opened. Sticky across rooms (`lg`+; below that the layout
  already stacks).

## [0.332.0] — 2026-08-10
### Added
- **A task now shows the goal it belongs to, and the goal is one click away.** The task drawer (and the
  task room's sidebar) leads with a "Part of goal" banner — goal title, its status when it isn't
  `active`, and the goal's derived progress bar — that navigates straight to the goal's detail page.
  The goal chip on Kanban cards and list rows became a real anchor (`#/goals/<id>`) rather than a dead
  badge, so ⌘/middle-click opens the goal in a new tab and a plain click routes in place without also
  opening the task behind it; the list's group-by-goal headers link the same way. The Goal `<Select>`
  stays what it always was — the way to RE-link a task — since a picker can't double as a way out to
  the thing it points at. Re-linking or completing a task also refreshes the goal list, so the banner's
  progress bar reflects the edit instead of the pre-edit state.

## [0.331.2] — 2026-08-10
### Fixed
- **`package-lock.json` is back in sync with `package.json`, and a test keeps it that way.** The lock
  had been stuck at 0.330.0 while the package moved on, because the last few bumps edited
  `package.json` directly instead of running `npm version`. npm rewrites the lock's two version fields
  on the next `npm install` — which happens on the deploy box — so every `scripts/make-live.sh` run
  found the live checkout "dirty" and had to be re-run with `--force`. That is a safety guard (someone
  edited the live checkout) degraded into noise by a bookkeeping miss, and force-deploying past it was
  becoming routine. New `scripts/version-sync-test.cjs` runs FIRST in `npm run test:governance` (no
  build needed), so the drift now fails the deploy's own gate and prints the one-line fix. CLAUDE.md →
  Versioning states the rule: bump with `npm version <x.y.z> --no-git-tag-version`, never by hand.

## [0.331.1] — 2026-08-10
### Changed
- **The GitHub repo is now `vikasprogrammer/agentric`.** Follow-through on the Agentric rebrand: the
  repo slug is a public brand surface, and GitHub keeps a permanent redirect so existing clones,
  remotes and issue links keep resolving (don't ever let a new repo claim the old `agent-os` name, or
  that redirect dies). Swept the hardcoded slug out of the README clone block, `FEEDBACK_URL`, the
  `gh --repo …` lines in CLAUDE.md / TODO.md / `scripts/wt.sh` / `docs/goals-plan.md` / the
  fleet-insights skill, and both service `Documentation=` URLs (which still pointed at the wrong org).
  Still `agent-os` on purpose: the npm package + CLI, `AGENT_OS_*`, the units, the data homes, the
  local checkout paths, and the GitHub **App** slug `agent-os-northwind` — renaming that one changes
  its installation URLs and breaks per-member GitHub auth.

## [0.331.0] — 2026-08-10
### Changed
- **The product is now called Agentric (agentric.io).** Brand-layer rename only: every user-facing
  surface — the console title/sidebar/copy, the bundled Docs pages, the agent-facing operating notes
  and launch banners, the Slack/Discord app manifests, README, `docs/`, the landing page, systemd
  `Description=` — says *Agentric* instead of *Agent OS*. The bundled doc page moved from
  `what-is-agent-os` to `what-is-agentric`.
  Every load-bearing identifier is deliberately untouched, because renaming it is a live-box migration
  and not a copy edit: the `agent-os` CLI/npm package, `AGENT_OS_*` env vars, the `AOS_*` prefix, the
  `AgentOS` class, the `mcp__agentos__*` tool namespace, the `/agent-os <agent>` chat command, unit
  names (`agent-os.service`, `com.agentos.northwind`), data homes and `agent-os.db`, and the GitHub
  repo. See CLAUDE.md → Naming for the rule.

## [0.330.0] — 2026-08-10
### Added
- **The derived outcome reads the transcript for the runs the session row cannot decide, and Step 1 of
  `docs/insights-revisit.md` closes at 89% out-of-sample.** Round 2 scored 52% and put Step 1 back to
  open; 8 of its 11 errors were two blind spots. Scanning every transcript in the corpus by basis showed
  the evidence was already on disk: `died-early` runs carry an auth/quota signature 17 times in 19,
  11 of 30 `noop`s carry one (a run killed on its first API call makes no tool calls either), and **all
  22 `no-evidence` conversations end with a 600–3300 character closing summary** — there were no silent
  runs in the residual at all. They had finished and simply never called `report`.
  So the deferred Stop-hook is not built, again and for a better reason: three read-time rules —
  `runtime-death` (a quota/auth signature in the transcript TAIL → failure), `finished-clean` (a ≥200
  char closing message and no error → success), `interrupted` — plus a fold fix so a conversation that
  ENDS in success is a success rather than being scored by the `task-retried` attempts before it. The
  layer is consulted only where the observed fields gave up, ~50 of 477 conversations, and never
  overrules a reported outcome or a human rating. Whole pass: 40ms.
  **Round 3 — 33 conversations neither earlier round touched, labelled blind, scored once, no rule
  changed after: 89% exact / 93% sign against a 46% always-success baseline** (rounds: 50 → 52 → 89).
  The three disagreements are narrow: an `ask` run whose entire answer was "Answered: 42" (under the
  substantive floor), one run with no assistant output where the OS says `noop` and the labeller says
  failure, and one where the agent reported `partial` and the labeller read it as success.
  Corpus: **unknown 1 of 328 scorable (0.3%)**, failure 39, noop 19, success 218.
  Rounds 1 and 2 are permanently in-sample now; any future rule change needs a round 4 on rows none of
  the three touched. Pinned by `scripts/outcome-derivation-test.cjs` (32 assertions), including that the
  transcript layer must not second-guess a report or a rating, and that a chatty zero-work reply is
  still a `noop` rather than a death.

## [0.330.1] — 2026-08-09
### Fixed
- **Cross-session messaging is refused on governed runs.** Claude Code 2.1.224 shipped a per-session
  inbox socket plus `SendMessage`/`ListAgents`, so any session can address any other session owned by
  the same OS user on the same machine — which is every Agent OS run, across tenants, on one box. That
  channel bypasses the gateway entirely: the gate hook's tool→capability table has no row for
  `SendMessage`, so it falls through the `*)` "not a world side effect" arm — no policy check, no audit
  event, none of the run-as identity, owner or provenance the governed A2A path
  (`task_create`/`task_wait`/`notify`/poke-back) records. The delivery default made it worse rather
  than safer: it keys off permission MODE, and an unattended run's `--dangerously-skip-permissions`
  puts it in the bypass class, where a bypass→bypass pair is delivered with no approval dialog at all.
  `terminal/claude-launch.sh` now writes `"crossSessionInbound": "refuse"` (Claude Code still binds the
  socket, and drops everything arriving on it) and `"isolatePeerMachines": true` into every session's
  `--settings` file. The `SendMessage`/`ListAgents` tools are deliberately NOT denied — the same
  `SendMessage` serves subagents and agent teams within one session — so outbound remains available and
  simply lands nowhere, since every governed session refuses. Governing the channel properly, as an
  `agent.message` capability in the gate hook's routing table, is the follow-up.

## [0.330.0] — 2026-08-09
### Added
- **Five new featured skill sources in the console's "Install from GitHub" dialog** — engineering and
  design libraries alongside the existing marketing set: `addyosmani/agent-skills` (24), `google/skills`
  (88), `emilkowalski/skills` (9), `Nutlope/hallmark` (anti-AI-slop design) and `tt-a1i/archify`
  (architecture diagrams). A preset is only a POINTER — nothing is vendored, `browseRepo` lists the
  repo's `SKILL.md` folders at click time and an owner/admin picks what to install — so this is reach,
  not new trust surface. All five verified to resolve through `browseRepo` before being added; a repo of
  agent *personas* (0 `SKILL.md` folders, e.g. `msitarzewski/agency-agents`) was rejected by that check.
- **`scripts/skill-presets-test.cjs`** (wired into `npm run test:governance`) — pins the two mechanical
  ways a featured source breaks: a `repo` that isn't the plain `owner/repo` form (dead button) and a
  duplicate entry. Offline by design; live resolution stays a documented manual check, since it needs
  GitHub's unauthenticated 60/hr budget.

### Fixed
- **Featured-source skill counts were stale or overstated.** The hand-written counts had drifted
  (`anthropics/skills` ⭐157k→167k, `mattpocock/skills` ⭐151k→211k) and, more usefully, the raw
  `SKILL.md` count overstates what a user actually gets: `browseRepo` dedupes skills by folder name,
  so `alirezarezvani/claude-skills` is 439 installable, not 798. Every count is now the deduped figure
  the browse dialog itself shows.


## [0.329.1] — 2026-08-09
### Changed
- **Round 2 of the derived-outcome falsifier: the honest out-of-sample number is 52%, not 63%, and
  Step 1 is reopened** (`docs/insights-revisit.md`). Round 1 tuned two rules on the rows it had just
  scored, so its 63% measured the fitting. This round samples 32 conversations round 1 never touched
  (`outcome-label-sample.cjs --exclude`), labelled blind, scored against the rules exactly as shipped in
  v0.323.0: **52% exact against a 43% always-success baseline** (78% on sign — did work land or not).
  Nine points over the trivial baseline is not enough to build Step 2 on. The 11 errors cluster into
  three causes, one of which reverses a Step 1 decision: **5 of them are the `no-evidence` residual the
  Stop-hook half was deferred over** — 6% of the corpus, but 45% of the mistakes, because those
  conversations are concentrated in exactly the runs a human judges instantly and the OS cannot.
  Measuring a residual by its share rather than by its share of the errors is the mistake; the hook is
  back in scope. The other two: quota deaths with zero tool calls fall through `died-early`'s
  `tool_calls > 0` guard and read as `noop` (3×), and `task-retried` beat a later success in one 4-run
  conversation (a fold-order bug). No rule was changed in response — that is what round 3 is for.
- `outcome-label-score.cjs` takes a labels-file argument; `outcome-label-sample.cjs` takes `--exclude` so
  a re-validation can only draw rows an earlier round never saw.

## [0.329.0] — 2026-08-08
### Changed
- **The status grammar reaches the last four surfaces** (Inbox, Approvals, Agents, Cockpit), finishing the
  sweep started in v0.328.0.
  - **Decision cards resolved in the card TYPE's colour, so "applied" and "rejected" looked identical** —
    every proposal (policy, agent edit, goal edit, automation, skill, secret) rendered its outcome as the
    same violet/indigo/amber outlined badge whatever the human decided. The per-type verb stays (it says
    more than "approved": `installed`, `granted`, `applied`), but the ROLE behind it is now shared
    (`RESOLUTION_ROLE` / `ResolutionChip`), so approved is green, rejected is red and `cancelled` — the
    session ended before anyone decided — is neutral, on every card type alike.
  - **A THIRD private outcome map** (`OUTCOME_STYLE`, after `runVerdict` and `OUTCOME_TONE` in v0.328.0)
    carried the same synonym gap: a run that reported `completed`/`progressed`/`blocked` read `ended`, as
    if it had never reported. Worse, the card's own icon keyed off a bare `=== 'failure'`, so **a run that
    reported the synonym `blocked` announced its failure with a green tick**. Both go through
    `verdictOf` / `VERDICT_META` now.
  - A **question** card is amber (`needsHuman`) rather than sky — it is blocked on a person, exactly like
    every other such signal. Sky stays what it always meant elsewhere: chat/unread.
  - The last "in progress = sky" in the app (a task-event card that is neither blocked nor done) is
    emerald.

### Added
- **The Agents roster says which agents are busy right now** — the first thing you want when deciding who
  to give work to, and something it never showed. Newest live run per agent, off the feed the console
  already polls, rendered through the same `SessionStatus` (so an agent whose run needs a human rings the
  same bell here as in the sidebar). Both the roster rail and the grid card.
- **Cockpit candidates show whether that agent is already running**, so you can see before dispatching
  that your best-fit agent is mid-run. The Cockpit has no status vocabulary of its own — it is a
  dispatcher — so this is the only status-shaped thing on the page.

## [0.328.0] — 2026-08-08
### Changed
- **One status grammar across the whole console.** Session status was unified in v0.320–0.327; everything
  else still spoke its own dialect. There were **seven private colour maps**, and `blocked` alone was rose
  on the Kanban board, amber on the goal page and red in the task drawer — for the same value. "In
  progress" was emerald in Sessions and blue in Tasks, so nothing transferred between pages.
  A role is now a MEANING, not a domain (`ROLE` / `RoleIcon`): sessions, tasks, goals and automations all
  answer "is it running / does it need me / did it land" the same way, icon-first. Two rules hold it
  together — **motion means NOW** (only `busy` and `needsHuman` animate; `active` is the static twin, since
  a task in Doing isn't necessarily generating this second), and **a check is a claim** (`ended` claims
  nothing, because a finished run may well have failed).
  - **Tasks**: the four disagreeing renderers (`TASK_COLUMNS`, `taskStatusTone`, `StatusDot`,
    `TaskStatusPill`) now derive from one `TASK_ROLE` map. `blocked` reads **"Needs you"** with the same
    amber bell a blocked session gets — it means the same thing to the reader: this stopped and won't
    restart on its own. The board's "Live" column is **"In progress"**.
  - **Goals**: `active` is emerald rather than sky (matching every other "in progress"), and `abandoned`
    is muted rather than red — a goal someone deliberately dropped is not a failure, and spending the
    alarm colour on it means red stops meaning "something went wrong".
  - **Overview** stopped deriving its own `live | headless | blocked` state with a private pill. It
    couldn't tell WORKING from READY, and it mixed a *mode* (unattended) into a state axis, so an
    unattended run that needed you read "Unattended". State comes from `sessionState`; mode keeps
    `ModeBadge`.
  - **`runVerdict` and `OUTCOME_TONE`** were two more private outcome maps with the same synonym gap fixed
    in the chain rail in v0.327.0 — a task run that reported `completed`/`progressed`/`blocked` printed
    its raw word in grey. Both now go through `verdictOf` / `VERDICT_META`.
  - `LiveBars` (the animated equaliser) is gone with its last caller: it claimed "streaming" for every
    live run, including one parked on an approval. The spinner/bell pair says which.

### Added
- **Automation cards say when a run is in flight.** The card showed enabled/paused only — you could not
  see that an automation was running right now without opening it. A run carries `automation:<id>`
  provenance, so the live feed the console already polls answers it with no new endpoint: the newest live
  run renders through the same `SessionStatus`, so an automation whose run needs a human rings the same
  bell here as in the sidebar, and the chip opens the run.

## [0.327.0] — 2026-08-08
### Fixed
- **Agents that reported a verdict were shown as if they had said nothing.** The `report` tool's enum is
  `success | failure | partial`, but the loopback route stores whatever it is handed
  (`String(b.outcome || 'success')`), so **`completed`**, **`progressed`** and **`blocked`** are all in
  the live data — `src/edge/outcome.ts` already folds them in as synonyms when deriving a verdict. The
  console mapped none of them: a chain node that reported `completed` fell through to its process status
  and rendered **`done`**, identical to a run that never reported, and `blocked` — a failure — rendered
  grey instead of red. One shared outcome vocabulary (`VERDICT_OF` / `VERDICT_META`) now backs both the
  sessions list and the chain rail, and an unrecognised value prints verbatim in a neutral tone rather
  than being forced into a bucket (the agent's own account beats a guess).
- **`report()` did not clear `busy_since` when the run left a usable summary.** That branch also renames
  the row from the summary, and it was missed when every other terminal transition was fixed in v0.324.0
  — so the most common way a run ends kept the "working" flag latched.

### Changed
- **The chain rail stopped speaking its own dialect.** It said `pass` / `failed` where the sessions list
  said `success` / `failure` for the identical fact — and `pass` misread as "parse" often enough to be
  reported. Both surfaces now use the same words. `duplicate` stays rail-only: it is a property of the
  chain, not of the run, and nothing else can say it.
- **`report` normalises the outcome at the WRITE** (`normalizeOutcome`), so the column stops accumulating
  synonyms and the downstream folding is belt-and-braces rather than load-bearing. It also fixes the chat
  mirror sending ☑️ for a run that plainly succeeded. Unrecognised words are still stored verbatim.
- `scripts/outcome-vocabulary-test.cjs`, wired into `npm run test:governance` (14 assertions).

## [0.326.0] — 2026-08-08
### Fixed
- **A session that was visibly generating could read `ready`.** The inverse of the v0.324.0 bug, and the
  half that had no backstop: `isWorking` self-healed against a *stale* flag, but nothing could set the
  flag back. Hook settings are written into the agent folder **at launch**, so a session launched before
  `UserPromptSubmit` was wired never fires it — once its `busy_since` was cleared it could never regain
  it. Observed live on `ses_c63f1492dc12ce06`: pane showing `Germinating… (1m 2s)`, gate events every few
  seconds, `busy_since` NULL, console reading `ready`.
  The heartbeat now lives on the **gate hook**, which is wired into every session that exists and is the
  one thing that cannot be missing — it *is* the invariant. A tool call is proof a turn is running, so it
  stamps `busy_since` too:
  - with `answered: false`, so a tool call never retires a "waiting on you" card — only a human
    submitting a prompt does (and a session blocked on an approval reads `needs you` regardless, since
    that outranks `working`);
  - re-stamping a flag older than `MID_TURN_MAX_MS`, which turns that ceiling from a dumb timer into an
    honest **activity** test: a long turn still calling tools keeps its spinner, a wedged one emits
    nothing and ages out. Without this a real 2h+ turn would have silently read `ready`.
  - throttled to one write per 30s per session (in-memory, dropped by `clearTurnBusy` so the first tool
    call of the next turn is never swallowed). The gate is a hot path and `node:sqlite` is synchronous —
    a lock-taking write there is the event-loop blocking that has made a busy box feel unresponsive
    before, and the statement is a no-op mid-turn anyway.

## [0.325.1] — 2026-08-08
### Changed
- **Session status glyphs: `ready` takes the check, `done` takes a dim dot.** The dashed circle read as
  visual noise rather than a state. More importantly the swap fixes a claim the old set made: a check on
  `done` reads "succeeded", and a finished run may well have failed — the verdict belongs to the Result
  column, which has the outcome to say it with. On a LIVE session the check is a plain fact: the turn
  landed, your move. So `done` goes back to the quiet dot it had before icons and claims nothing, and the
  chain rail's `no report` fallback follows it.

## [0.325.0] — 2026-08-08
### Fixed
- **An INTERRUPTED turn (Esc / Ctrl-C) kept reading "working".** Claude Code fires **nothing** on a user
  interrupt — no `Stop`, no `StopFailure`, no `SessionEnd`; a `UserInterrupt` event has been requested
  ([anthropics/claude-code#9516](https://github.com/anthropics/claude-code/issues/9516)) and does not
  exist. So the turn never ended server-side and the session spun until the 2h wedged-turn ceiling.
  The signal we *do* get is the `Notification` hook: the TUI parks at its prompt — including
  `Interrupted · What should Claude do instead?` — and claude raises `idle_prompt` (159 of them on the
  live northwind box). `notify()` now **ends the turn** as well as ringing the bell, for all three
  human-blocked kinds (`idle_prompt`, `permission_prompt`, `agent_needs_input`) — being blocked on a
  human is by definition not generating. The session reads **`needs you`**, which is the honest state.
- **The other half of that loop:** `markTurnBusy` (a submitted prompt) now retires the open waiting card.
  Without it a session that had been interrupted would keep reading `needs you` — which outranks
  `working` — through the entire next turn.


## [0.324.0] — 2026-08-08
### Fixed
- **Sessions that had finished showed the "working" spinner.** `term_sessions.busy_since` — the flag the
  console spins on — was a **one-way latch**: it was cleared in exactly one place, the `resident` branch
  of `markTurnIdle`, and a member's own interactive session returns before that branch (`!r.headless`), so
  its flag was never cleared. Live northwind carried a stale `busy_since` on **72 of 520 rows, 66 of them
  `done`/`stopped`/`crashed`** — a finished run whose pane lingered read live *and* working, i.e. a
  spinner on a session that ended hours ago. Every turn-end path now clears it, and `isWorking` gained
  four more conditions so no missed signal can strand a spinner: a terminal row is never working, a dead
  pane is never working, a turn-END recorded after the start wins (`last_activity > busy_since` — this is
  what heals rows latched by older builds), and a turn older than the 2h wedged-turn ceiling is wedged,
  not working. A one-time migration NULLs the already-latched rows; a genuinely in-flight turn is
  untouched. On the live corpus this takes 72 stale flags down to 5, and all 5 were verified genuinely
  mid-turn against their live panes.

### Added
- **Agent OS now listens to the rest of the Claude Code turn/session state machine** (`terminal/lifecycle-hook.sh`
  → `POST /api/session-event` → `TerminalManager.recordLifecycle`), instead of inferring status from a
  latched flag plus a tmux poll. New in `docs/session-lifecycle-hooks.md`, which maps every hook event to
  the state it drives:
  - **`UserPromptSubmit`** — the turn-**START** signal, which Agent OS simply did not have. `busy_since`
    was stamped only when the *server* delivered a message, so a human typing straight into an attached
    TUI ran whole turns the console could not see.
  - **`StopFailure`** — a turn killed by an API error (`rate_limit`, `overloaded`, …). Claude fires **no
    `Stop`** in that case, so the turn never ended server-side: the run kept reading "working", the
    automations pile-up guard kept holding its slot, and an unattended run parked as a zombie until a 24h
    reaper found it — the shape behind the recurring weekly-limit zombie sessions. It now ends the turn
    exactly as `Stop` does (including the unattended teardown) and audits `session.turn.failed` with the
    `error_type`.
  - **`SessionEnd`** — the run is over, with claude's own `reason`. Only `prompt_input_exit` (the human
    quit the TUI), `logout` and `bypass_permissions_disabled` are treated as terminal; `clear`, `resume`
    and `compact` are mid-run events, so a `/clear` no longer looks like a finished session.
- `scripts/turn-lifecycle-test.cjs`, wired into `npm run test:governance` (32 assertions): the
  interactive-lane clear, the turn-start signal, `StopFailure` teardown, each `SessionEnd` reason, all
  five `isWorking` clauses, and the ignore-unknown-events rule.

## [0.323.0] — 2026-08-08
### Added
- **A run outcome derived from what the OS observed, not from the agent's grade of its own homework**
  (`src/edge/outcome.ts`, `docs/insights-revisit.md` Step 1). Step 0 deleted every channel that broadcast
  the old self-reported rate; this is the replacement it had to earn. Ordered rules over observed facts —
  the process crashed, the run made no tool calls, an unattended run died in seconds, a task closed while
  this run held it, another run had to pick the same task up — each carrying the `basis` that decided it,
  so a number can always be traced to its evidence. `report` stays one input among several; a human's
  👍/👎 outranks everything. Two framing calls did more work than any rule: **the unit is a conversation**
  (a `poke:` resume continues a transcript, so scoring rows counts one job several times) and **not
  everything is scorable** (a person closing their own pane is not a failure — those leave the denominator
  instead of quietly counting as not-success).
  On the live 30-day northwind corpus (443 conversations): **unknown 6%**, down from ~40%, and **28
  failures against the 1** the fleet self-reported over the same window.
  Two rules were bought by the falsifier rather than designed: **`died-early`** — unattended runs split by
  wall-clock at 2m+ → 96% report, 30–120s → 84%, **<30s → 0 of 44**, which are quota/auth deaths
  (`You've hit your weekly limit`, `401 … token has expired`), this fleet's most common real failure and
  structurally impossible to self-report since the agent is what stopped existing (19 found in 30 days);
  and **`human-session`**, after v1 scored four completed interactive sessions as `abandoned`.
  Falsifier: 35 conversations sampled stratified by basis and labelled blind from transcripts
  (`scripts/outcome-label-sample.cjs`, `outcome-labels.json`, `outcome-label-score.cjs`). **v1: 50% exact
  vs a 43% always-success baseline. After the two rules above: 63% vs 32%** — with the caveat, stated in
  the doc, that the rules were revised after seeing v1's errors, so the unfitted number is 50% and a fresh
  blind sample is owed before Step 2 leans on it. Pinned by `scripts/outcome-derivation-test.cjs`
  (23 assertions, in `test:governance`), including the property that the metric must move when work fails
  and *not* when reporting discipline changes.
  Nothing consumes this yet and nothing is stamped or written — it is a pure read, evaluated as-of a time,
  so a task that reopens tomorrow changes yesterday's verdict. The Stop-hook half of the plan was **not**
  built: once runs were classified, most of the hole was unscorable or already decidable, leaving 6%
  without touching the teardown path. Deferred with the reasoning recorded, not cancelled.
## [0.322.0] — 2026-08-08
### Changed
- **Session status is an ICON now, not a coloured dot + a word.** v0.321.0 unified the vocabulary but
  still spelled it out — six dots differing only in hue and fill asked the eye to learn a colour key, and
  colour alone cannot carry "a turn is running right now", which is the thing people actually scan for.
  Each state carries a glyph that says it by itself: `working` a spinning `LoaderCircle`, `waiting` a
  pulsing `Bell`, `idle` ("ready") a dashed circle, `stopped` a stop circle, `crashed` an alert triangle,
  `done` a check. Colour and motion stay as reinforcement, never as the only channel; the tooltip still
  carries the word plus what it means, and the icon carries an `aria-label`.
  - The status WORDS added to the sidebar subline and the terminal tab strip in v0.321.0 are gone — the
    glyph replaced them, so the sidebar reads title + agent again and the strip stays narrow.
  - The chain rail's per-node verdicts became icons too (`pass` → circle-check, `failed` → circle-x,
    `partial` → circle-slash, `duplicate` → copy), keeping its word beside them since the rail has room.
  - `STATE_META.dot` survives for the ROLL-UP badges (the Chain toggle), where the signal is a count of
    sessions in a state rather than one session's status and an 8px pip is the right mark.

## [0.321.0] — 2026-08-08
### Changed
- **One session-status vocabulary, rendered identically everywhere.** The console had three parallel
  dialects — a dot that only knew live-vs-dead, a "waiting" bell threaded by prop to two surfaces, and the
  chain rail's own words — so the same run could read *green* in the sidebar, *bell* in the terminal tab
  strip and *running* in the rail while the honest answer was "it finished its turn ten minutes ago".
  There is now a single `SessionState` (`waiting` → `working` → `idle` → `stopped` / `crashed` / `done`,
  priority-ordered by what needs a human) and a single `<SessionStatus>` renderer used by the sidebar,
  the terminal tab strip, the session cards + rows, the session header, the chat rail, the chain rail and
  chips, the standalone terminal page and the automation run list.
  - **`working` vs `idle` is the new distinction, and the one that was missing.** The server already
    computed `working` (a turn in flight, from `busy_since`, cleared by the runtime's turn-end beacon) and
    only the Chat rail used it — everywhere else a live pane mid-generation and a live pane that finished
    its turn an hour ago drew the *same* solid green dot. `working` now pulses emerald, `idle` ("ready")
    is a hollow emerald ring.
  - **The bell is part of the vocabulary, not a separate widget**, so "needs you" shows on every surface
    including the sidebar. The blocked set (server `blocked` ∪ open notification cards) moved from a prop
    to `WaitingCtx`, which is why surfaces that never received the prop can show it at all.
  - **The state WORD ships with the dot** on the sidebar (on the agent subline) and the tab strip
    (inactive tabs), so a strip of six terminals says which one is generating.
  - `headless` left the dot — the hollow ring now means "not busy". The unattended/interactive axis keeps
    its own marker (the Headless badge / the sidebar's `Cpu` glyph).
  - Sessions filter: added **Working**; **Blocked** renamed **Needs you** to match the word on the rows.
- `ChainNode` gained `working` (same `busy_since` rule as the session list) so the hand-off rail can tell
  a delegate that is generating from one that is merely warm.

## [0.320.1] — 2026-08-08
### Removed
- **The fleet-wide "success rate" is gone from every channel that broadcast it** (`docs/insights-revisit.md`
  Step 0). `success / sessions` divided *self-reported* successes by ALL sessions, so its complement was
  dominated by runs that simply never called `report`: live northwind logged 334 `session.ended` with no
  outcome against 302 `session.reported` in 30 days, and **one** reported failure in 329 reports lifetime
  (globex: 6 in 1830). Both tenants computed ~55% and broadcast it four ways — retired all four:
  - the `deriveGuidance` line telling **every agent, in every system prompt, permanently** to "slow down"
    about a failure rate that isn't in the data;
  - the `runtime.effort.high` recommendation, which stood ready to raise the whole workspace's reasoning
    effort (and cost) on the same evidence — `recommendationResolved` now retires any persisted one at read
    time rather than waiting for the next pass;
  - the tenant-shared memory Insight agents `recall`, which now reports raw counts including how many runs
    **never reported an outcome**;
  - the `success-drop` alert, which DM'd a human whenever reporting discipline dipped (it fired twice on
    northwind); dropping it also drops a full 8-week `measureLearning` scan per alert tick.
  `agent-low` is kept — it gates on real reported failures (`failed >= 2`), which `success-drop` never had.
  The KB fleet-learnings page keeps its counts, derives no percentage from them, and now says outcome is
  self-reported. Pinned by `scripts/insights-signal-test.cjs` (19 assertions, in `npm run test:governance`),
  verified to fail 10 of them against the pre-fix build. A rate returns only when Step 1 derives an outcome
  from observable facts.

### Added
- **`docs/insights-revisit.md`** — audit of the Insights surface against live northwind + globex data,
  and a from-scratch rebuild sequenced one step at a time. Findings: the stack rests on a self-graded
  outcome signal with 1 reported failure in 329 reports and ~40% of terminated runs never reporting, so
  the "57% success rate" injected into every agent's prompt actually measures whether `report()` was
  called; 40 of 48 alerts on globex are five crash-looping agents that produced zero recommendations
  (detection and proposal are disconnected engines); `recommendation.applied` is 1 event fleet-wide, so
  the measurement loop measures its own never-taken actions. Rebuild starts at Step 0 (delete the wrong
  guidance line) and Step 1 (an outcome derived from observable facts), each gated on live evidence.
- **`docs/sops-plan.md`** — plan for SOPs: pre-learned department playbooks (engineering, marketing,
  sales, support, research) with server-enforced stage order, peer review and evidence gates. `SOP.md`
  frontmatter + prose (not YAML), stages compiled to child tasks over the `blocked_by` dependency edge
  (no new run engine), and an `advisory → enforced` adoption ramp measured by stage-skip rate.

## [0.320.0] — 2026-08-08
### Changed
- **A task re-dispatch now RESUMES the prior transcript instead of restarting.** A task is the durable
  unit of work; a session is one attempt. Every other re-entry path (chat threads, DM replies, poke-back,
  self-schedule) already `--resume`d the prior transcript — task re-dispatch was the lone exception,
  spawning a fresh session with only a text *summary* of the last run's outcome, so a retried or reopened
  task re-derived everything it had already worked out. `dispatchTask` now resumes the same transcript when
  the task's latest run was the **same assignee agent** and pinned one (`TerminalManager.resumableTaskTranscript`),
  seeded with a "continue, don't restart" prompt. It's bounded: after `MAX_TASK_RESUMES` (2) resumes that
  still don't close the task it starts **fresh** to escape a wedged/looping transcript — a fresh run mints a
  new `claude_session_id`, so the streak resets and the *last* attempt before parking is a clean slate.
  `TASK_MAX_ATTEMPTS` is bumped **3 → 4** so the ladder (fresh → resume → resume → fresh-escape → park) fits
  before the block. A changed assignee can't resume another agent's transcript (→ fresh). A side benefit:
  because a resumed dispatch reuses the transcript id, retries now collapse into ONE conversation in the
  chain/cost view (cost = max) instead of N separate ones. Pinned by `scripts/task-resume-test.cjs`.
### Added
- **Jump from a session to its attached task.** The session view's facts row now shows a clickable task
  chip (when the run works a task — `task:`/`poke:`/`ask:` provenance) that deep-links to the board card,
  completing the edge that only existed in the other direction (task room → its runs).

## [0.319.0] — 2026-08-07
### Added
- **A re-dispatched task tells the next run it isn't the first.** A task is the unit of work and a
  session is one ATTEMPT at it, but every attempt got a prompt byte-identical to the first one's — no
  signal that anyone had been here, which invites redoing work that already landed or re-hitting a wall
  a predecessor already documented. `buildTaskPrompt` now takes the task's prior runs and opens with
  `This is attempt N — M earlier sessions already worked this task`, one line each (agent, reported
  outcome, its one-line summary), plus a pointer to `task_get` for the notes and discussion the
  summaries can't hold. The last three attempts are named and the rest collapse to a count, so a
  much-retried task doesn't turn its prompt into a wall of history. It sits inside the text the `/goal`
  length gate measures, so a converging task can't ship a payload the CLI rejects.
- **"Run again" on a task that's already `doing`.** Dispatch was offered only for `todo`/`blocked`, but a
  `doing` task whose run has ENDED — the normal shape, since headless runs exit at turn-end — is exactly
  the one that needs another go, and the server has always allowed it (`dispatchTask` refuses only
  done/cancelled plus a live-session pile-up guard). The button now appears for any non-terminal task
  with no live run, labelled with the attempt number it will start.

### Fixed
- **A finished run with no transcript now shows what it REPORTED instead of a bare error.** A pane log is
  best-effort — an older session may never have written one — but the verdict, summary, cost, duration
  and turn count live on the session row, so the pane can still answer "what came of it" even when it
  can't answer "what happened". Replaces the `⚠ no transcript for this session` dead end, on every
  surface that shows a finished run.

## [0.318.1] — 2026-08-07
### Fixed
- **A task's Session tab showed tmux's `can't find session: aos-…` instead of the run's transcript.**
  The room handed `TerminalFrame` a session row only while the run was still ALIVE (`liveOf`), so for a
  finished run the pane had no row, couldn't tell ended from live, and blind-attached to a tmux session
  that no longer exists. Task runs are headless by default and leave no resumable pane, so this hit
  essentially every completed task — 111 of the northwind board's tasks were in that state. The tab now
  resolves the run's row regardless of liveness (fetching it by id when the board's own
  `lastSessionId`-scoped fetch doesn't carry it, which is also what makes picking an EARLIER attempt out
  of the run history work), so an ended run renders its read-only transcript — the same thing the
  Sessions page and the `#/term/<tmux>` popout already did. Live runs still attach as before.

## [0.318.0] — 2026-08-07
### Added
- **`goal_update` — agents can now edit an EXISTING goal, on a maturity tier.** Until now the agent goal
  surface was read + propose-a-draft only (`goal_list`/`goal_get`/`goal_propose`); there was no way for an
  agent to change a live goal's status or fields. `goal_update` adds that on the **same three-lane trust
  model as `agent_propose_update`** (the shared `agentProposalTrust` config): below `minMaturity` → refused;
  middle band → a `goal.update.proposed` review card that applies nothing until an owner/admin approves
  (`POST /api/goals/proposals/:id/approve`); at/above `autoApplyAt` → applied immediately via
  `GoalStore.update`, owner notified after. A **"shape beats score"** rule (mirroring the agent path's
  destructive-rewrite demotion) keeps the steering-wheel transitions — **activating, abandoning, or
  reopening a goal, or claiming an unfinished one is `achieved`** — in the human-review lane at *every*
  tier; the only status change a top-tier agent auto-applies is marking a goal `achieved` whose linked work
  is already 100% done. Every applied edit (auto or approved) is event-logged in `goal_events` (author =
  the agent on the auto lane, the approving human on the gated one), so it's revertable; `dryRun` names the
  lane without writing. Console: an owner/admin review card in the Goal room sidebar + a `goal.update.proposed`
  inbox card. Pinned by `scripts/goal-update-guard-test.cjs` (wired into `test:governance`).
- **Goal console deep-links in the agent tools.** `goal_get`, `goal_propose`, and `goal_update` now return
  the `…/#/goals/<id>` console link, so an agent can hand a human a clickable pointer to the goal it read,
  proposed, or edited.

## [0.317.0] — 2026-08-06
### Added
- **`agent_get` — agents can finally READ a prompt before replacing it.** `agent_update` /
  `agent_propose_update` require `claudeMd` to be the complete new system prompt, and there was no tool
  that returned the current one. Safe editing was therefore impossible *by construction* unless an agent
  happened to know the on-disk path and have filesystem access — incidental knowledge, not part of the
  tool contract. `agent_get` returns the full CLAUDE.md, the listing fields and a `baseHash`; it defaults
  to the caller and accepts any user-home claude-code agent (the same set `agent_propose_update` can
  target), auditing cross-agent reads as `agent.config.read`.
- **Patch mode on both edit lanes.** `claudeMdEdits: [{oldString, newString}]` (harness-`Edit` semantics —
  each anchor must match exactly once, else refused as ambiguous or stale) and `claudeMdAppend`. The
  overwhelmingly common edit is "add a section", which previously had to be expressed as "retype 20KB
  perfectly"; full replacement is now the escape hatch rather than the only door.
- **`baseHash` preconditions and `dryRun`.** Passing the `baseHash` from `agent_get` turns a stale or
  concurrent read into a **conflict** instead of a silent clobber; the cross-agent lane also pins it onto
  the review card, so approving a proposal whose target has since moved returns `staleBase` + a warning
  rather than quietly reverting the newer text. `dryRun: true` reports the fields, the diff stat and the
  lane the call would take while writing nothing.
- `scripts/agent-edit-guard-test.cjs` (wired into `npm run test:governance`) replays both incidents and
  pins every guard.

### Changed
- **A destructive prompt rewrite is now judged by its SHAPE, not just the proposer's maturity.**
  `assessClaudeMdEdit` flags a rewrite that deletes >20% of a prompt or drops an existing `#` heading —
  the fingerprint of a caller that submitted a fragment. On the self-edit lane it is refused unless
  `confirmRewrite: true`; on the cross-agent lane it **forces the owner-review lane regardless of the
  maturity tier**, as does a proposer's first-ever edit of that particular target. Maturity predicts
  *intent*, not correctness of transcription: a maxed-out proposer submitting a fragment is
  indistinguishable from an accident by score alone. Approval cards now carry the diff stat and the names
  of the dropped sections, so a human sees `−6,348 chars` without opening the document.
- **The edit tools now echo a server-composed `message` instead of writing their own outcome sentence,
  and return a typed `outcome`** (`applied` | `pending_approval` | `dry_run` | `refused`) with
  `bytesBefore`/`bytesAfter`/`rev`. An MCP server is spawned per session and lives as long as it, while
  the lane is decided by the long-running server — so a client that composes its own text keeps asserting
  the *old* behaviour after a server upgrade. That is exactly how a live session reported "NOTHING changes
  until an owner approves it" about an edit the newer server had already applied (the truthful branch had
  shipped in 0.312.0; that session's MCP process predated it). Composing the sentence where the decision
  is made means a stale session can only be silent about a new outcome, never wrong about it.
- The agent self-edit route now shares `applyAgentEdit` with the approve and auto-apply lanes, so all
  three validate, write and snapshot identically.

## [0.316.0] — 2026-08-06
### Changed
- **Console chat keeps the runtime warm between turns — a follow-up no longer pays a cold start.** Every
  console chat turn relaunched `claude` (a headless `--resume` seeded with the message): measured on the
  live tenant, 3.7–6.7s to first token, paid again for every "and one more thing". Chat sessions now spawn
  **resident** (the warm lane Slack threads already used) and a turn is delivered into the live pane by
  send-keys; only a session whose pane is gone (idle-reaped, crashed) relaunches, and it relaunches
  resident, so the turn after that is warm again.

  The cold-per-turn design was a deliberate trade, not an accident — it bought two properties, and both
  are kept by other means rather than given back:
  - **"Working" is no longer inferred from "a pane exists."** A warm pane outlives the turn it answered,
    which is exactly how the 2026-07-14 stuck-"thinking…" bug happened. The runtime now says so directly:
    `term_sessions.busy_since` is set when a turn starts and cleared by the Stop-hook turn-end beacon
    (`markTurnIdle`, which for a resident run stamps and returns instead of tearing the pane down),
    surfacing as `Session.working`. The chat window spins on that; `alive` goes back to meaning only
    "there is a pane".
  - **A keystroke that doesn't take is repaired, not lost.** `confirmWarmTurn` re-checks the transcript
    12s after delivery; if nothing was written the turn never started, so the pane is killed and the
    message relaunched cold (audited `chat.deliver.unconfirmed` / `chat.deliver.recovered`). A newer
    message, a growing transcript, or a deliberate teardown all cancel it, so it can only fire on a turn
    that genuinely went nowhere.

  Two consequences worth stating plainly. A warm chat holds a live `claude` (hundreds of MB) between
  turns, so the **idle reaper is what bounds it** (Settings → chat idle timeout, default 30 min); that
  sweep now also reaps a `done` resident row — a chat that ended its turn with `report` kept a live pane
  that no sweep owned, which would have leaked one process per conversation. And a message typed while a
  turn is generating is now **delivered and queued** by claude rather than refused with "still working —
  resend", matching how Slack threads have always behaved.

  `chat.turn` is audited with `mode: warm | cold`, so the split is measurable rather than assumed.
  `scripts/warm-chat-test.cjs` (in `npm run test:governance`) covers all of it against a stubbed backend.

## [0.315.2] — 2026-08-06
### Added
- **`scripts/make-live.sh` — the northwind deploy, as a script instead of a retyped sequence.** "Make it
  live" was five manual steps against the dedicated live checkout (`~/agent-os-live`), and the manual
  version skipped verification often enough to matter: nothing checked that the running process actually
  reported the version just built — the difference between "the change is live" and "a long-running
  server is still holding the old code in memory". The script syncs to `origin/main` (refusing to
  `reset --hard` over local changes without `--force`), installs dependencies only when a lockfile
  actually moved, builds both bundles, gates on `npm run test:governance`, restarts with
  `launchctl kickstart` — never `pkill -f "dist/cli.js serve"`, which is shared by every tenant on the
  box and took prod down on 2026-08-01 — then polls `/health` until it reports the built version, and
  prints the exact rollback command if it never does. A build or test failure aborts BEFORE the restart,
  so a bad commit leaves the running server untouched. `--dry-run` shows what would deploy.
  Northwind-specific by design (paths/label/port are env-overridable); other tenants have their own
  service and home.

## [0.315.1] — 2026-08-06
### Fixed
- **Starting a chat no longer blocks — on the server or on screen.** Sessions and tasks got fast; chat
  didn't. Three causes, measured on the live northwind tenant (time from `session.created` to the first
  assistant block: 3.7–16.3s, median ~6s):
  - **~1.5s of the wait happened before the HTTP response, with the event loop stopped.** A launch mints
    a Composio Tool Router session per identity (personal + company, plus any shared), and each mint was a
    **blocking `spawnSync curl`** run one after another, inside the request handler. So `POST
    /api/chat/start` couldn't answer until every mint had, and — this being a single-threaded server —
    *no other request could be served either*: one chat start briefly froze the whole console. Mints now
    run **concurrently over `fetch`** (`mintToolRouterSessionAsync`), and the runtime launch as a whole is
    **scheduled rather than awaited** — the caller writes the session row and returns. Measured with an
    800ms-per-mint stub: `createSession` **1678ms → 1ms**, same two mints, same `.mcp.json`.
  - **The launch window could be misread as a crash.** A scheduled launch leaves a `running` row with no
    tmux pane for a moment, and a re-launch (a chat turn, a revive) reuses an old row, so the crash
    sweep's `created_at` grace didn't cover it. Launching sessions are now tracked in memory: `isAlive`
    counts them as live (so a fast second turn can't start a competing run on the same transcript) and
    both crash sweeps skip them.
  - **The window looked empty even once it had started.** The timeline was polled every 2s and a new chat
    showed neither the message just sent nor a working indicator until the transcript existed — several
    seconds of a chat that looked like it hadn't started. The sent turn now appears immediately (retired
    when the transcript echoes it back), and the poll runs at 600ms while waiting on a first transcript
    or a pending reply, falling back to 2s once the conversation is idle.

  What this does **not** fix: every chat turn is still a full runtime cold start by design
  (`TerminalManager.chatSend`), which is the remaining ~3–5s and the reason follow-ups take 3.7–6.7s.
## [0.315.0] — 2026-08-06
### Fixed
- **A running delegate was unreachable, so "stand down" spawned a second agent instead of stopping the
  first.** Caught live on northwind (`tsk_67de2dfe`, 2026-08-06): `marketing-manager` auto-dispatched a
  build it hadn't meant to, put the task on **HOLD** 35 s later — and the hold reached a *newly spawned*
  `marketing-site` run, which stood down, while the run actually building kept going for 25+ minutes.
  Root cause: `deliverToResident` refused any session with `resident = 0`, so every unattended
  (task/automation) run was unreachable even though those are attachable TUIs now, not `claude -p`. The
  task-discussion path then fell through to spawning a rival worker and re-pointed the task's
  `last_session_id` at it, orphaning the live run from its own task. Now:
  - any LIVE claude pane can be delivered into, unattended or not;
  - a turn-end teardown is deferred while a message delivered in the last 90 s is still unread
    (`DELIVERY_GRACE_MS`), so a HOLD typed a second before the Stop hook isn't swallowed;
  - a task moved to `blocked`/`cancelled` by anyone other than the executing agent now **injects the
    reason into the live run** (`task.hold.delivered`), so the row and the work stop together;
  - the discussion path reports an undeliverable live run instead of spawning a rival onto the same task.
- **A caller no longer pokes itself.** The poke-back fires when a task reaches `done`/`blocked`; the code
  assumed the delegate is always the actor ("so this can't self-wake"), which a caller parking its own
  hand-off falsifies — 14 spurious wake-up sessions across the fleet in 30 days. The actor decides now.
- **A parked task can no longer be re-dispatched by a guarded path.** `dispatchTask` refused
  `done`/`cancelled` but not `blocked`, so `task_dispatch`, `task_wait`'s polling kick and app dispatch
  all sailed past a deliberate stop (45 tasks dispatched 2+ times in 30 days, 23 of them within 60 s). A
  human forcing it from the console is still allowed — that is the un-park.
### Added
- **Message a delegate from the chain rail.** Any live node gets a composer that types straight into that
  agent's session (`POST /api/sessions/:id/inject`) — steering a run you aren't attached to, without
  opening its terminal or filing a task comment that reaches the wrong run.

## [0.314.0] — 2026-08-06
### Added
- **A task's full run history — every session that worked it, not just the last one.** The task↔session
  relation has always been one-to-**many** (a task is the durable unit of work; a session is one *attempt*
  at it — a crash re-dispatches, an agent `task_claim`s from its own run, a `@mention` spawns, a human
  takes over), but only `tasks.last_session_id` was reachable. So a task that crashed, was re-dispatched
  and then succeeded read as a single clean run, and its cost read as the last attempt's rather than the
  sum. On the live northwind tenant that hid **7** multi-run tasks — 5 with a bad earlier attempt — and
  **$60.33** of attempt cost the console never linked (one task: `unknown $8.41` then `success $15.52`,
  showing only the second).
  - `TerminalManager.taskRuns(taskId)` returns the list oldest-first on `GET /api/tasks/:id` as `runs`.
    **Nothing new is stored** — runs are recovered from traces that already existed: `dispatch` (provenance
    `task:<id>`, spawned FOR the task) and `linked` (a session that touched it from elsewhere and logged a
    `task_events` row). Each carries its own verdict (`outcome`/`summary`), duration, cost, turns, `current`
    (the pointer the pile-up guard tracks), `alive` (one tmux poll for the whole list) and `archived`.
  - **Archived runs stay in a task's history** — the soft-archive declutters the Sessions list, it does not
    rewrite what happened to a task.
  - Console: the single **View session** button becomes a **Runs · N** list (collapsed to the last three,
    each with its verdict, duration and cost). In the full-page task room, picking a run swaps the
    **Session** tab to that run's pane, so a much-retried task can be read attempt by attempt.
  - Reads stay tenant-wide like the rest of the task detail; *attaching* to a run is still gated by the
    terminal's own authz. One live session per task is unchanged — this is retrospective, not concurrency.
  - Pinned by `scripts/task-runs-test.cjs` (19 assertions, in `npm run test:governance`): ordering, the
    `current` pointer, dispatch-vs-linked, archived rows surviving, no double-counting across the OR-ed
    predicates, and liveness not claiming a running row is dead when the tmux poll can't run.

## [0.313.0] — 2026-08-06
### Added
- **A cross-agent edit is now worth what the proposing agent has earned — `agent_propose_update` is
  tiered by the proposer's maturity.** Any agent could already propose an edit to any other agent's
  listing/CLAUDE.md, and every proposal landed the same way: an owner card, regardless of whether the
  proposer had 200 clean runs or was on its first. Both ends of that were wrong — a brand-new agent could
  fill an owner's queue with prompt rewrites for teammates, and a long-proven one couldn't fix an obvious
  stale instruction without a human round-trip. The proposer's **maturity score**
  (`src/state/agent-stats.ts` — autonomy × (1 − denialRate) × volumeConfidence) now routes the call
  against workspace-configurable tiers (`AgentProposalTrust`, **Settings → Runtime → Cross-agent edits**,
  `GET`/`PUT /api/settings/agent-proposal-trust`):
  - **below `minMaturity`** (default 0.40) — refused, with a message telling the agent what earns the
    right and to raise it with a human instead. No write, and no card either. Audited
    `agent.update.proposal.blocked`.
  - **middle band** — unchanged propose-don't-apply: an owner-addressed `agent.update.proposed` card,
    applied only by an **owner who can run the target**. The card now also carries the proposer's maturity,
    so the reviewer weighs the proposal against its author's record, not the prose alone.
  - **at/above `autoApplyAt`** (default 0.80) — **applied immediately, with no human in the loop**; an
    admin-addressed notice reports it after the fact and names the revision to revert. Audited
    `agent.update.applied`. This tier is the deliberate trade: it's hard to reach by construction (maturity
    is damped by `volumeConfidence = runs/(runs+8)`, so 0.80 needs ~32+ runs at near-perfect autonomy with
    a clean denial record), it's fully revertable, and `autoApply:false` turns it off entirely — which
    restores exactly the old owner-gated behaviour while keeping the floor.
  All three lanes were unified onto ONE write path, `applyAgentEdit` in the new `src/state/agent-edit.ts`
  (extracted verbatim from the owner-approve route: same sanitizers, same `agent.json`/`CLAUDE.md` write,
  same `os.registerAgent`, same `AgentRevisions.commit`) — so an auto-applied edit is validated and
  snapshotted exactly like a human-approved one, and shows up in the same Revision history panel.
  Authorship distinguishes them (`agent:<proposer>` vs the approving owner). `src/types.ts`
  (`AgentProposalTrust` + `sanitizeAgentProposalTrust`), `src/governance/settings.ts`, `src/terminal.ts`,
  `src/server.ts`, `src/memory/memory-mcp.ts` (the tool now tells the agent which tier it landed in),
  `web/src/App.tsx`. Docs: `docs/agent-mcp-tools.md`, CLAUDE.md.

## [0.312.0] — 2026-08-06
### Added
- **The sessions list now advertises hand-off chains instead of hiding them, and the rail says what's
  running.** v0.311.0 shipped the chain rail but no way to *find* it: the rail lives inside an opened
  session, renders nothing for a solo run (~72% of rows), and its only in-list signal was `lg:`-gated —
  so on a narrower window nothing pointed at the 28% of sessions (122 of 437 on northwind) that are part
  of a chain. Four fixes:
  - a **Hand-offs** option in the sessions status filter — narrows to sessions that delegated or were
    delegated to, resolved over the whole list so a delegate whose caller is filtered out still matches;
  - the chain chip strip shows at **every width** and leads with a `⑂ N` hand-off count;
  - that count also joins the **Activity** cluster, so it reads on every grid card and in the list column;
  - a **Chain N** toggle in the session's top bar — present only when the session actually handed work
    off, so it doubles as the signal that there is a chain, and badges amber when something waits on a
    human / emerald when a delegate is working. It replaces the 32px collapsed spine, so a hidden rail
    now gives the terminal its full width back.
- **Live state in the rail.** A chain node carries `headless` + `blocked`, so its dot uses the sessions
  list's exact semantics — a live unattended run is a hollow ring, a live driven one is filled, blocked
  pulses amber — and a working node reads `running` with `unattended · 12m in` rather than a bare word.
  The rail header counts what's running alongside the agents and cost.

## [0.311.1] — 2026-08-05
### Fixed
- **A partial agent-config save no longer wipes the tuning knobs it didn't mention.** `PUT
  /api/agents/:id/config` replaced model/effort/permissionMode/verbosity **wholesale** while every other
  field on the same route patched by presence (`'examplePrompts' in b ? … : ag.examplePrompts`). So any
  body that omitted a knob silently cleared it: a one-knob `{verbosity:'terse'}` save unpinned the
  agent's model and dropped it onto the fleet default, and — wider than it first looked — so did a
  **description-only save**, since that carries no tuning either. Nothing in the response said so; the
  agent just quietly started running on a different model. Caught on the live northwind consolidator,
  which is pinned to `opus` and for a few minutes wasn't.
  The contract is now the same as the rest of the route: **absent key → keep, present key → replace,
  `''` → clear to inherit**. Clearing is therefore explicit rather than a side effect of omission, which
  matters over the wire because `JSON.stringify` drops `undefined` — the console's runtime card now
  states all four knobs (empties included) instead of spreading a `RuntimeTuning` whose cleared fields
  would vanish from the payload. The merge lives in one place (`runtimeTuningPatch` in `src/types.ts`)
  and is shared by the owner/admin route, the agent self-edit, and the cross-agent proposal apply — the
  latter two already had these semantics hand-rolled. A runtime switch still drops a pinned model the
  body doesn't re-state, so moving an agent to Codex doesn't 400 on the `claude-*` model it's leaving.
  `npm run test:tuning-patch` (20 assertions, in `test:governance`) covers the merge and drives the real
  route end to end; it fails 5 ways against the old code.

## [0.311.0] — 2026-08-05
### Added
- **Agent-to-agent work reads as one thread: the chain rail + a collapsed sessions list.** A delegated
  run was its own session row, so a three-agent delivery scattered across the list — and every
  poke-back added one more row for a conversation that already existed. Shipping client-app PR #2773
  on the globex tenant produced **nine rows across three agents in 70 minutes**, interleaved with
  unrelated work, four of them the same engineer transcript resumed with machine-written titles
  (`Poke ← release-orchestrator done: …`). Nobody could see that release-orchestrator had been
  dispatched **twice** for the same promotion — the second run's own summary reads "PR #2778 was
  already open from a prior run".
  Two surfaces, one read model, no new storage — the console simply reads three identities the DB
  already records: a **run** (`term_sessions.id`), a **conversation** (every run sharing a
  `claude_session_id` — a poke RESUMES a transcript), and the **chain** (`tasks.caller_claude_id` →
  the runs dispatched for that task).
  - **Chain rail** (`GET /api/sessions/:id/chain` → `TerminalManager.sessionChain`): the hand-off tree
    beside the terminal — each conversation once with its own verdict, cost and run count, a
    re-dispatch of the same work to the same agent flagged, and **anything waiting on a human**
    (a delegate's open `ask`, an approval gate) answerable **in place**, instead of being hunted down
    in the Inbox detached from the work that raised it. Renders nothing for a solo run; collapsible to
    a spine, persisted per browser. Viewer-scoped by the same rule as the sessions list.
  - **Sessions list collapse**: rows fold into conversations, and delegates nest under the caller that
    dispatched them, with an inline chain strip (`qa · release-orch ×2`) so a stalled or duplicated
    hand-off is visible without opening anything. Grouping runs over the FILTERED set, so a delegate
    whose caller is filtered out is promoted rather than hidden; a row's checkbox now selects every run
    behind it.
  Two folding rules the live data forced: a conversation's cost is the **max** of its runs, not the sum
  (cost is per-transcript and cumulative, so summing multiplies one bill by the number of resumes), and
  its verdict + summary come from the **same** reporting run (else a conversation whose last resume
  ended quietly reads "no report" beside the report it filed). Covered by
  `scripts/chain-model-test.cjs` (36 assertions, wired into `npm run test:governance`).

## [0.310.0] — 2026-08-05
### Added
- **Terse output — a verbosity knob on the runtime-tuning chain, with the measurement that can
  contradict it.** `RuntimeTuning.verbosity` (`normal` | `terse`) joins model/effort/permission-mode, so
  it inherits the precedence that already exists: per-run override → agent manifest → workspace default
  (Settings → Runtime defaults) → `normal`. An agent can pin `normal` to opt OUT of a terse fleet default,
  which matters for the ones whose prose people actually read. Unlike the others it is not a CLI flag —
  `terse` appends a compression brief to the system prompt (`buildCompanyMd`), so it applies to Claude
  Code and Codex alike. It compresses NARRATION only: code, commands, errors and logs stay byte-exact,
  and every durable artifact (`report`, `remember`, `kb_write`, task notes, `ask`, and every chat reply)
  is explicitly exempt — those feed consolidation, recall, and human readers, where terse phrasing costs
  far more than it saves. Deliberately not per-member: a member is the identity a run acts *as*, and
  unattended runs frequently have no `run_as` at all, so a per-member flag would silently miss exactly
  the runs that burn the tokens.
- **Verbosity savings (`GET /api/settings/verbosity-savings`, owner/admin).** Terse is a prompt
  instruction, not an enforced transform, so the flag ships with its own falsifier rather than a claimed
  percentage. The resolved level is stamped onto `term_sessions.verbosity` (from the `session.tuning`
  audit, alongside model/effort), and the query compares the two arms **per turn** — a longer run costs
  more because it did more, not because it was wordy. Surfaced in Settings → Runtime defaults, with the
  per-agent rows (an agent that has run BOTH ways) called out as the numbers to trust; the fleet-wide
  pair is labelled confounded, since flipping particular agents makes the two sides different *work*.
  Pre-flag rows (NULL verbosity) and uncosted/live rows count toward neither arm. `npm run test:verbosity`
  (32 assertions, wired into `test:governance`) covers the precedence, the brief's carve-outs, and the
  ways the comparison could be fooled.

## [0.309.2] — 2026-08-04
### Fixed
- **First-run inheritance no longer copies the box account's identity.** v0.309.1 gap-fills a credential
  dir's `.claude.json` from the box's so a rotated session inherits every "seen/dismissed" flag. A dir
  written by `claude login` carries its own `oauthAccount`/`userID`, so those were already left alone — but
  a dir holding only a `.credentials.json` has none, and would have taken the box's identity while
  authenticating as a different account, labelling the session with the wrong account and keying its
  per-account caches off the wrong uuid. Both are now never inherited; claude repopulates them from the
  token, so absent beats guessed. Caught by probing the deployed seeder against a bare dir.


## [0.309.1] — 2026-08-04
### Fixed
- **A rotated session no longer parks on claude's first-run prompts.** Claude keeps its UI state in
  `.claude.json` **inside `$CLAUDE_CONFIG_DIR`**, falling back to the home root only when that isn't set.
  Account rotation sets `CLAUDE_CONFIG_DIR` per session, which moved that file out from under the
  launcher's pre-seed: the seed kept writing `~/.claude.json` while claude read the account's copy. So the
  first session on a credential-dir account met the theme picker, then the folder-trust dialog, then the
  current upsell — and an unattended TUI has nobody to answer any of them, so it sat there until the
  reaper. Hit globex live, minutes after its first credential-dir account went in. (The bug is as old as
  the `oauth` account kind; nothing had reached it before, because until v0.308.0 every pooled account on
  every box was a `token` account that never took effect.)
  - The seed now targets `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json` — the file claude will actually read —
    and covers all three gates: `hasCompletedOnboarding`, per-folder `hasTrustDialogAccepted`, and the
    "seen/dismissed" counters.
  - Those counters are **inherited from the box's own config** rather than set from a known list:
    `fullscreenUpsellSeenCount`, `effortCalloutDismissed`, `remoteDialogSeen` … the list grows with every
    claude release, and a missed key is another hung session. Gap-fill only — a key the target already has
    always wins, so the account's identity (`oauthAccount`, `userID`, per-account caches) is untouched, and
    `projects`/`mcpServers` are skipped as per-directory/server config rather than UI state.
  - Seeding moved out of an inline `node -e` in `claude-launch.sh` into `terminal/seed-config.js` so it can
    be tested: `scripts/claude-config-seed-test.cjs` (18 assertions) in `npm run test:governance`, the first
    of which is "the seed lands in the file claude will read". Nothing tested it against a config dir,
    which is exactly how this shipped. Existing credential dirs heal themselves on the next launch.


## [0.309.0] — 2026-08-04
### Added
- **Add a runtime account by signing in from the console** — Settings → Runtime accounts now runs the
  runtime's own login for you and keeps the credential directory it produces. v0.308.0 established that a
  credential dir is the only credential a session can actually launch with, but producing one still meant
  ssh'ing to the box and running `CLAUDE_CONFIG_DIR=<dir> claude` by hand — which is precisely why the
  paste-a-token box, the one that silently did nothing, was the path everyone took. Now: type a name, hit
  **Sign in**, open the link it shows, paste the code back. Adding a dir by path stays available under
  **Add by path** for a login you ran yourself or a runtime with no guided flow.
  - It **drives the real CLI** rather than speaking OAuth itself. We could mint our own PKCE pair and
    write `.credentials.json` directly, but that means owning an undocumented client id, token endpoint
    and file shape — and getting any of them wrong reproduces this whole bug class: a credential file the
    runtime silently rejects. The runtime's own binary performs the exchange and writes its own file; the
    console only relays the URL out and the code back.
  - Completion is therefore a **filesystem fact** — the credential file appearing — never a screen scrape.
    Scraping decides only when to press Enter and which URL to show, so a future change to the CLI's
    prompts times the flow out with the manual instructions instead of registering a broken account.
  - Fails closed everywhere else too: a dead pane, a rejected code, a name already in the pool, a name
    that would escape the accounts dir, or a directory that already holds someone else's login are all
    refused, and an abandoned attempt has its pane killed and its half-built dir removed. The pasted
    OAuth code is a one-time credential — it goes straight into the waiting pane and is never audited,
    logged or stored. Owner-only, like every pool mutation.
  - `CodingRuntimeSpec.guidedLogin` gates it per runtime (claude-code only — codex's login has its own
    prompt sequence nobody has walked yet), and it's unavailable under `AOS_UID_ISOLATION`, whose
    uid-private tmux socket the app can't read.
  - `SpawnSpec.cols` lets a pane the app only ever READS be spawned wide. Found by running the flow
    against the real CLI, not by the stubbed test: a TUI hard-wraps to its terminal width and emits real
    newlines, which `capture-pane -J` cannot rejoin, so at the default 203 columns the ~400-char authorize
    URL came back truncated. The pane is now 900 columns, and a URL that still arrives clipped (no
    trailing `state=`) is refused rather than shown — sending someone to a truncated authorize request
    fails in the browser and reads as a product bug.
  - New `scripts/runtime-login-test.cjs` (32 assertions, stubbed backend — offline and deterministic) in
    `npm run test:governance`; the live path was verified separately against the real `claude`.

## [0.308.0] — 2026-08-04
### Fixed
- **Account rotation only ever hands a session a credential the runtime will actually authenticate with.**
  `claude` honours `CLAUDE_CODE_OAUTH_TOKEN` in **print mode only**. The interactive TUI the OS launches —
  which is every lane now, unattended included — ignores it and runs on the box's own
  `~/.claude/.credentials.json`, while its splash still prints "Claude API" and the console still showed
  the pooled account as selected. So a pool of pasted `claude setup-token` accounts was a silent no-op:
  on the globex box every session for a day drained one account that was already at **weekly 100%**,
  and only the busiest agent surfaced it by hitting the limit. Verified with a discriminating pair
  (pool token at weekly 9%, box account at 100%): `claude -p` + the token answered; the TUI + the same
  token refused with the *box* account's limit and reset time; token plus an empty config dir dropped to
  the login picker, so there is no env-token auth path at all. Three changes:
  - `CodingRuntimeSpec.liveCredentialKinds` declares, per runtime, which account kinds its launch lane
    can authenticate with (claude-code: credential dirs only; codex keeps its api-key lane, which its own
    launcher wires). `pick()` and `allLimited()` filter on it centrally, so no caller can widen it — and
    an unusable-but-available row no longer masks an exhausted pool from the scheduler.
  - Adding such a credential is refused up front, with the command that works
    (`CLAUDE_CONFIG_DIR=<dir> claude login`), instead of being accepted and then ignored. Add-time
    validation probing the provider proves Anthropic accepts a value, never that the launcher can use it.
    A credential *dir* with no login inside it is refused the same way — pointing a session at one doesn't
    fall back to the box login, it hangs the run on the CLI's login picker.
  - `term_sessions.runtime_account` is stamped only once the credential is really in the session env; a
    launch that fell through to the box default is left unstamped and audited (`runtime.account.unusable`
    / `.unresolved`). It's read back as ground truth — a false stamp hid the box account being drained and
    would have parked the limit on the wrong row. Existing pool rows of an unusable kind are badged
    "never used" in Settings → Runtime accounts rather than silently disappearing.
  - New `scripts/runtime-account-test.cjs` (24 assertions) in `npm run test:governance`.

## [0.307.2] — 2026-08-04
### Fixed
- **The `run_as` cleanup now also catches the email-shaped rows.** v0.307.1 swept provenance strings out
  of the identity column, but a second shape survives it: an **email** (a caller handed `createSession`
  an email as provenance). It has no colon, so the sweep missed it, and it matches no member id — the
  same silent identity loss. Found while verifying the 0.307.1 deploy: 2 rows on northwind
  (`owner@localhost`), 1 on personal. The human is recoverable here, so the migration canonicalises
  rather than NULLs — email → member id, lowercased to match `TeamStore.getMemberByEmail`. An email
  resolving to nobody is left alone: it may be the only trace of a since-removed member, and unlike a
  provenance string it isn't structurally impossible for a human to have owned that run. New rows were
  already prevented by `resolveActingMember`, which canonicalises an id-or-email `runAs`.

## [0.307.1] — 2026-08-04
### Fixed
- **A session's provenance can no longer leak into its identity column, silently costing the run its
  human's credentials.** `spawned_by` is provenance (a bare member id OR a prefixed system trigger —
  `automation:` / `task:` / `chat:` / `poke:` / `ask:` / `goal:`); `run_as` is the accountable human.
  `createSession` derived the second from the first with a one-entry blocklist — anything not starting
  `automation:` was taken as the identity — so a chat-routed run or an ownerless task stored
  `run_as = 'chat:triage'` / `'task:<id>'`: a value no consumer can match. The failure is entirely
  silent. That run loses the run-as member's GitHub token (its PRs land as the App bot instead of the
  human), Composio/connector identity, member-scoped secret resolution (`ref.principal ?? actingMember`),
  granted SSH host keys, and inbox ownership — with no error anywhere. Measured on the globex tenant:
  **23 sessions** carrying `chat:docs-bot`, `chat:triage`, `task:tsk_…`, plus a matching
  `github.token.refresh_failed` logged against `principal: "chat:triage"`.
  The fallback now resolves against the team (`resolveActingMember` — the single place `run_as` is
  derived, shared by `createSession`/`forkSession`/`reviveResident`/`chatSend`) instead of blocklisting
  prefixes, so a future provenance kind can't leak by being forgotten, and an explicit `runAs` is
  canonicalised (id or email → id). No accountable human now correctly yields NULL — the company
  identity — rather than a string that impersonates one. A one-time migration NULLs the colon-bearing
  `run_as` rows already on disk (`spawned_by` untouched); `scripts/run-as-identity-test.cjs` covers it.

## [0.307.0] — 2026-08-04
### Fixed
- **A delegate that ends its run without closing the task no longer strands the caller forever.** The
  poke-back that wakes a delegating agent hangs off the TASK reaching `done`/`blocked`, not off the
  delegate's session ending — so a delegate that finished (or died) without calling `task_update` left
  the task inert in `doing` **and** the caller waiting with no signal, ever. Nothing re-dispatched it
  either (`dispatchable()` only selects `todo`). Measured on the globex tenant: **43 of 307 (14%)** of
  agent→agent hand-offs over 30 days ended exactly that way — `engineer → qa`, `engineer →
  release-orchestrator`, `qa → engineer`. The existing Insights reconcile tile could not have rescued
  one of them: it only auto-closes runs graded `success`, and 15 of the 16 stranded runs ended
  `outcome = 'unknown'` (the agent closed neither loop), which it parks in a review-only bucket.
  A new `sweepStrandedTasks` runs each scheduler tick over every non-terminal task whose dispatched
  session has settled, and splits on what the run actually reported:
  - **`success`** → close the task `done` (the Insights tile's `apply`, now automatic). The store
    notifier then fires the ordinary "✅ Really done" poke, so the caller hears the real result through
    the normal path — one wake-up, not two.
  - **anything else** → leave the status **alone** and wake the caller with the delegate's last note.
    Never auto-marks done: a run legitimately ends mid-flight (waiting on CI, a human go/no-go), and
    calling that "finished" would be a lie.

  Bounded so enabling it can't stampede a backlog: once per dead *run* (marker keyed on the session, so
  a re-dispatch that strands again is a fresh signal), ≤3 wake-ups per tick sharing the dispatcher's
  concurrency headroom, nothing older than 3 days ever woken (cold strandings are marked silently), and
  a row skipped for budget stays unmarked so the next tick still owes it. Replayed over the live globex
  backlog: settles in 3 ticks (~60s) — 8 callers woken, 1 task auto-closed, 12 cold ones marked quietly.
  Audited `task.stranded` / `task.reconciled` / `tasks.reconciled`.
- **Reconcile settles on when a run ENDED, not when it started.** `planTaskReconcile`/`applyTaskReconcile`
  gated their 10-minute grace on the session's `created_at`, so a long run that started an hour ago but
  ended seconds ago counted as settled and could be reconciled out from under an agent about to post its
  `task_update`. Both now gate on `updated_at` (stamped when the session reaches a terminal state), as
  does the new sweep; `endedDaysAgo` in the Insights tile is now genuinely the end date.

## [0.306.0] — 2026-08-04
### Changed
- **Context-engineering pass, part 2 — trim the always-on operating notes.** Follow-up to #554. The
  `AGENT_OS_OPERATING_NOTES` block rides in every session's system prompt (~2k tokens); this relocates
  the mechanical file-plumbing out of it. The `publish`/scratchpad rule (a ~150-word paragraph) is
  shortened to the one instruction that matters and its mechanics moved into the `publish` tool's own
  description — where the model reads them at call time, not on every launch (MCP tool descriptions load
  with the tool, so nothing is lost). The PR-linkback section is tightened to the instruction. No
  guidance removed; ~8% (~160 tokens) off every session, fleet-wide on next launch.

## [0.305.0] — 2026-08-04
### Added
- **Telegram helper commands: `/help`, `/agents`, `/whoami`.** The bot is now self-explanatory — all
  read-only, reply-and-return, detected before routing so they're never mistaken for an agent:
  - **`/help`** (and Telegram's implicit **`/start`**) — how to drive the bot.
  - **`/agents`** — the reachable fleet as tappable `/name` commands + one-line descriptions.
  - **`/whoami`** — which member the sender resolves to for run-as, or the unmapped-→-company-identity
    fallback (with the Telegram id to map).
  All four (plus `/new`) are registered in the `/command` menu ahead of the agents, and seeded into the
  dedupe set so an agent can't shadow a helper. `src/edge/telegram-socket.ts`.

## [0.304.0] — 2026-08-04
### Added
- **Telegram `/new` — end the current conversation and start a fresh one.** Now that a Telegram DM is
  threaded (a follow-up continues the last run), there was no way to reset it — a console Stop even got
  *revived* on the next message. `/new` (aliases `/reset`, `/newchat`) stops the live run bound to the
  chat and detaches its reply bindings, so the next message starts a brand-new session
  (`Automations.resetTelegramChat` + `TerminalManager.clearTelegramBinding`). `/new` alone acks and
  waits; `/new <request>` resets and immediately starts the new thing. Registered in the bot's `/command`
  menu (first entry) so it's discoverable. Audited `telegram.chat.reset`. `src/edge/telegram-socket.ts`,
  `src/edge/automations.ts`, `src/terminal.ts`.

## [0.303.0] — 2026-08-04
### Added
- **Mark a Composio connection "available to the team" — or take it back to just me.** Connections →
  Mine now carries a **Share with team / Just me** toggle on each of your Composio apps, and shared apps
  appear in the Company section attributed to their owner (`shared by alice@…`). Nothing moves on
  composio.dev in either direction, so the switch is instant and reversible with no re-authorisation.
  - **Why it isn't a move.** A connected account's `user_id` is immutable (the update endpoint exposes
    `alias`, credentials and the shared-ACL block — no owner field), and a Tool Router session may only
    pin accounts belonging to its own `user_id`. Both verified against the live API.
  - **How it's enforced.** Sharing records a local marker (`composio_shares`); at launch the fleet mints
    one extra Tool Router session per sharing owner — under **that owner's** entity but allowlisted to
    the shared toolkits, pinned to the shared account ids, and with connection management disabled. A
    borrower therefore reaches exactly what was shared, **not** the rest of that person's Composio
    account, and can neither add nor revoke connections under an entity that isn't theirs. Verified
    live: asked to "list files in Google Drive", an unrestricted session offers `googledrive` tools
    while the borrowed one can only offer the shared `gmail`.
  - **Governance.** Only the owner may grant (the account is verified to be theirs first, so no one can
    publish a teammate's or the company's connection by guessing an id); owner or admin may revoke.
    Revoking is local-only and never gated on the Composio key, so a cleared key can't strand a share.
    A share dies with its connection, dies with its owner (member removal), and is pruned when the
    account is revoked straight on composio.dev. Audited `connector.shared` / `connector.unshared`, and
    each borrowed mint records its toolkit allowlist on `connector.minted`.
  - New: `src/connectors/composio-shares.ts`, the `composio_shares` table, `MintOptions` on
    `mintToolRouterSession`, `POST /api/connections/share`, `teamShared` on `GET /api/connections`.

## [0.302.0] — 2026-08-04
### Changed
- **Context-engineering pass on the launch prompt — trim redundant tokens from what every session
  inherits.** Two changes, following the just-in-time / "smallest high-signal set" guidance from
  Anthropic's *Effective context engineering for AI agents*:
  - **Fleet roster is now bounded (just-in-time).** `buildCompanyMd` injected the FULL fleet roster with
    every agent's full description on every launch, even though `list_agents` is the live equivalent. It
    now injects a stable (id-sorted) slice capped at 25, clips each description to 140 chars, and points
    at `list_agents` for the tail (`…and N more`) — so a large fleet with long descriptions can't flood
    every prompt. No change for workspaces under the cap.
  - **Bundled personas de-duplicated against the operating notes (DRY).** The 13 catalog agents
    (`config/agents/*`) each re-explained the OS gate and re-listed the generic OS tools
    (`recall`/`remember`, `kb_*`, `task_*`, `ask`/`report`) that `AGENT_OS_OPERATING_NOTES` already
    covers canonically — two copies of the same mechanics in the same final prompt. Removed the generic
    `## Your tools` sections and the generic "every side effect passes the gate" boundary bullet, keeping
    every role-specific tool (`agent_*`/`app_*`), boundary (engineer's code-vs-ops, finance's
    no-payments, …), and nuance (support's chat-reply, folded into its Method). ~6.3 KB lighter across
    the seeds (generalists −20–30% each); affects newly installed agents, not live self-edited ones.

## [0.301.0] — 2026-08-04
### Added
- **Telegram: the fleet now shows up as native `/commands`, and DMs are threaded.** Two follow-ups to the
  Telegram integration (#552):
  - **`/command` menu.** On connect the bot registers its chat-reachable claude-code agents via
    `setMyCommands`, so typing `/` in Telegram lists them (name + description). Telegram command names are
    limited to `[a-z0-9_]{1,32}`, so a hyphenated id like `agent-author` is normalised to `agent_author`
    for the menu (`telegramCommandName`) and reversed on an inbound tap (`resolveCommand`), so
    `/agent_author …` reaches the real `agent-author`. Deduped on collision, capped at Telegram's 100.
    Re-runs on every (re)connect, so re-saving the token refreshes the menu after the roster changes.
    Audited `telegram.commands.synced` / `.failed`.
  - **DM threading.** A Telegram private chat is one persistent 1:1 conversation (chat id == user id), so
    a plain follow-up now CONTINUES the last run in that chat (deliver into the live claude / revive the
    row) instead of spawning a fresh session every message — the group thread-continuity path, now applied
    to DMs too. `src/connectors/telegram.ts`, `src/edge/telegram-socket.ts`.

## [0.300.0] — 2026-08-04
### Added
- **Native Telegram integration (ingress + reply) — the third chat channel alongside Slack and Discord.**
  One company bot (a single `<botid>:<hash>` token from @BotFather) connects by **long polling** — the
  server dials OUT to `api.telegram.org`, so no public URL is needed (works on the Tailscale-private box,
  the same posture as Slack Socket Mode / the Discord Gateway). DM the bot or @-mention it in a group and
  matching `telegram` automations run as governed sessions; unmatched messages fall through to the generic
  `/agent` chat router. Thread continuity is keyed on the chat id (+ forum-topic id), the Discord
  per-channel model — Telegram bots can't branch a thread, so replies post back into the same chat as a
  reply to the triggering message. The agent answers with the new **`telegram_reply`** MCP tool
  (exposed only for Telegram-triggered sessions, `TELEGRAM_REPLY=1`), bound server-side to
  `telegram_threads` so it can't be handed (or spoof) a chat id. Run-as resolves the Telegram user id via
  the identity map (`member_identities` provider `telegram`; no email, so an unmapped sender → company
  identity — the Discord model). Configured in **Settings → Integrations** (token field, live connection
  badge, `@BotFather` setup guide) and surfaced in Connections → the native-bot rows. Chat-mirror also
  reflects a chat-triggered run's completions/questions back into the Telegram chat.
  - New: `src/connectors/telegram.ts` (Bot API client), `src/edge/telegram-socket.ts` (`TelegramSocket`
    long-poll loop), `telegram_threads` table.
  - Wired through: `settings.ts` (token accessor), `types.ts` (identity provider + trigger unions),
    `automations.ts` (`telegram` trigger, `fireTelegram`, `continueTelegramThread`), `terminal.ts`
    (session binding, `sessionForTelegramThread`, `TELEGRAM_REPLY` env, `bindReplyChannel`),
    `memory-mcp.ts` (`telegram_reply`), `server.ts` (`/api/agent/telegram/reply`, settings save +
    status), `tenant-registry.ts` (socket lifecycle + chat-mirror), `chat-links.ts`, and the web console.
  - **Setup note:** for group thread continuity on plain follow-ups, turn **Group Privacy OFF** in
    @BotFather — with it on the bot still receives @mentions and `/commands`, just not plain replies.
  - Not yet included (follow-up): proactive egress (`telegram_send`/`telegram_dm`), the end-of-day digest
    to Telegram, and the approval/question/task notifier fan-out over Telegram DMs.

## [0.299.0] — 2026-08-04
### Added
- **Settings → System now catches a dependency that is present but STALE, not just missing.** Found the
  hard way: a tenant's box sat on `claude` 2.1.216 for weeks, so `/model` couldn't list Opus 5 and the
  `opus` family alias resolved to 4.8 — while the console showed a green *"All required dependencies are
  installed."* the whole time. Presence was the only thing `checkDeps()` ever asked, and the `claude` dep
  deliberately carries no package-manager `pkg`, so it sat outside the install path entirely.
  Deps may now name an `npmPkg`; the new `checkDepUpdates()` (`src/edge/deps.ts`) asks the npm registry
  for `latest` via the abbreviated `/latest` endpoint (global `fetch`, no `npm` shell-out, no new dep),
  caches for an hour, and flags a behind-version install. `checkDeps()` stays sync + network-free, so
  freshness is a layer on top rather than a slower probe: `GET /api/deps` (`?force=1` re-asks) annotates
  the report, and a stale row goes amber with the published version, an owner-only **Update** button, and
  a note that live sessions keep their binary until they restart. `POST /api/deps/update` runs
  `npm install -g <pkg>@latest` — owner-gated, audited `system.deps.updated`, never via sudo (a
  permissions failure surfaces the manual command instead of leaving root-owned files in the prefix), and
  it prefers the `npm` beside the resolved binary so an nvm box can't install into a different prefix
  than the one it runs from. CLI parity: `agent-os deps` shows `↑ … → v2.1.220 available`, and
  `agent-os deps update <bin>` applies it.

### Fixed
- **A `claude` reachable only off PATH no longer reports as MISSING.** `deps.ts` resolved binaries with a
  bare `command -v`, but `claude-cli.ts` walks `$CLAUDE_BIN` → PATH → `~/.local/bin/claude` because a
  launchd/systemd parent ships a minimal PATH — so on such a box the panel claimed the runtime was absent
  while sessions launched fine. Both now share `claudeBinCandidates()` and honour the same order
  (`$CLAUDE_BIN` first — resolving PATH first would report the version of a binary sessions never run).
  A dep found only via a fallback is version-probed at its resolved path and marked `offPath` in the UI.
- New `scripts/deps-freshness-test.cjs` (38 assertions: version comparison, resolution order, the
  off-PATH case, stale detection, the route authz — owner-only update, non-npm deps refused before any
  shell-out — and a full update round-trip against a stubbed `npm`, which also pins the sibling-npm
  preference) wired into `npm run test:governance`.

## [0.298.0] — 2026-08-04
### Added
- **Chat front door: greetings get a friendly reply, and the help/`/name` roster drops System agents.**
  A bare "hey" / "thanks" / "good morning" (a new `social` intent — short, no OS noun, no task) now gets a
  one-line "👋 Happy to help — ask me a question about your workspace, or tell me what you need done"
  instead of dumping the whole agent list. A greeting that wraps a real request ("hello, I need help
  reviewing a PR") still routes as work (length + OS-noun guards). And the addressable/help roster now
  excludes `category:'System'` machinery (concierge/operator/consolidator) — they were being listed as
  `/agent`-addressable. Applies to Slack/Discord (`routeUnmatched`/`routeChat`) and Cockpit web
  (`/api/router/preview` renders the greeting inline like an `ask` answer). `src/edge/intent.ts`,
  `src/edge/automations.ts`, `src/server.ts`.

## [0.297.1] — 2026-08-03
### Fixed
- **Insight alerts kept re-firing about problems that were already fixed.** Both repeat-offender alerts
  were monotonic counters over a fixed window, so once a condition healed the count stayed above the
  threshold and the alert re-fired every 3-day cooldown until the rows aged out — training the owner to
  ignore the channel, and pointing them at healthy agents to "fix".
  - `agent-crash:<agent>` counted crashes over **30 days**. On the live northwind tenant the consolidator
    crashed 9× between 2026-07-20 and 07-24 (the `TASK_B64` tmux-overflow bug fixed in v0.265.2), then ran
    **12/12 green** — and the alert still fired on 07-28, 07-31 and 08-03, with a body telling the owner to
    scope its tasks smaller. It now reads a 7-day `crashedRecent` count and stands down once the agent has
    logged 3 clean runs since its last crash (`runsSinceCrash`), so a fixed crash loop goes quiet
    immediately instead of ~4 weeks later. The 30d `crashed` total stays on the scorecard — that surface
    is history, and only the alert claims the present tense.
  - `friction:<capability>` counted rejections over **all time** — no window at all, so it could never
    stop. `stripe.refund` (30 rejections, all between 2026-06-12 and 07-04) had alerted 7× in the previous
    30 days and would have kept going forever. Rejections are now windowed to the same 30 days as the
    scorecard, which also drops stale entries off the Insights **Friction** card.
  - `agent-low` is deliberately left alone: it's a *rate*, so incoming successes dilute it and it
    self-heals. New `scripts/alert-staleness-test.cjs` (in `npm run test:governance`) pins all of it —
    ongoing loops still alert, healed ones don't.

## [0.297.0] — 2026-08-03
### Added
- **DM continuity — a reply to a DM the OS sent you about a run goes back INTO that run.** `ask_human`
  and approvals were already answerable from the DM (`question_dms` / `approval_dms`); every other push
  was one-way. An agent's `notify` and the session-lifecycle DMs (finished / crashed / waiting) pinged a
  human who then had nowhere to reply — the Inbox card is an `update` with no reply box, and a DM reply
  fell through to the intent router, spawning a **fresh** session that knew nothing about the run that
  asked. Reported from the field: an agent asked for a design decision via `notify`, said it was holding
  the PR, and the answer had no way back.
  New `session_dms` binding (`src/state/db.ts`) written by `notifyMember`/`notifySessionEvent`, plus
  `Automations.continueSessionDm` on the way back in — the DM-keyed analogue of thread continuity:
  deliver into the live claude, else revive the SAME transcript. Checked after the approval and question
  paths (a pending decision is the more specific claim on the same reply) and before the router. Guards,
  since a session has no "no longer pending" state to expire against: a **24h window**
  (`SESSION_DM_WINDOW_MS`) so an old run can't swallow an unrelated DM, archived/unresumable rows
  excluded, visibility re-checked against the current member, and an explicit `/other-agent …` still
  redirects. On success the run's chat egress is pointed at the DM (`bindReplyChannel`, `INSERT OR
  IGNORE` — never steals a run already answering in a thread) so its reply lands where the human is
  talking, and the socket acks by agent name. Both platforms (`slack-socket.ts`, `discord-socket.ts`).
  New `scripts/dm-continuity-test.cjs` (29 assertions) in `npm run test:governance`.
### Fixed
- **DM bindings skipped anyone auto-linked by the delivery they were part of.** All three
  (`question_dms`, `approval_dms`, `session_dms`) were written BEFORE `deliverDM` — but `deliverDM` is
  where a member with no linked Slack handle gets discovered from their email and persisted to the
  identity map. So a first-time recipient was DM'd a question or approval whose reply then matched
  nothing. The bind loop now runs after delivery, via one shared `bindDmRecipients`
  (`src/tenant-registry.ts`).

## [0.296.0] — 2026-08-03
### Changed
- **The console's 1.5 s poll stops shipping the full ~950-row session list on most routes**
  (Sessions-pagination Phase 2; plan in `docs/sessions-pagination-plan.md`). A new
  **`GET /api/sessions/summary`** returns only what the always-on surfaces need — every LIVE session +
  the viewer's most-recent **ended** tail (capped 60) + a global **`doneToday`** count — built from
  `aliveNames()` + a bounded id query + `listSessions(ids)`, all viewer-scoped, **never rebuilding the
  whole table**. The global poll now switches source by route: the Sessions & Chat *list* views still
  fetch the full `/api/sessions` (they render it), but **every other route polls the summary** — so
  navigating the Inbox / Tasks / Overview / Agents / Settings etc. no longer pulls ~950 rows every tick.
  Measured on a live globex snapshot (950 rows): the poll payload drops **950 → ~68 rows** off the list
  routes, and the summary builds **~23–33 % faster** than the full list even before the row-count win.
  `openNotification` falls back to the Phase-1 by-id fetch for an older session not in the summary;
  Overview's "Done today" reads the summary count (it's owner-only, so a global count is correct). Badge
  and per-session bells are unaffected (badge derives from `messages`; bells from `blocked`, which is a
  subset of live and always present). `src/terminal.ts`, `src/server.ts`, `web/src/lib/api.ts`,
  `web/src/App.tsx`. Verified with an in-process endpoint test (bounded / viewer-scoped / 304 / doneToday)
  and a headless-browser smoke test (inbox polls summary with zero full-list calls; the sessions route
  switches to the full list and renders all 950; Overview KPI renders; no console errors).
## [0.295.0] — 2026-08-03
### Added
- **Discord/Slack: `action` requests go to the governed operator, freeform questions to the concierge —
  answered IN-THREAD via the chat-mirror ("poke the thread"), not a client poll.** The chat front door
  (`routeUnmatched`) now runs the full intent layer: `ask` is answered inline (state/direct Claude) or,
  when there's no fast answer, handed to the **concierge** (a Claude session with the OS tools); `action`
  ("schedule the churn report every morning", "create a task to …") is handed to the **operator**
  (`task_create` filed / `automation_propose` a draft an owner approves); `work` routes to the best-fit
  teammate. The concierge/operator are spawned as THREAD-BOUND chat sessions and reply in-thread through
  the same chat-mirror primitive every chat agent uses — reusing agent-os's existing comms path instead
  of the bespoke web spawn-and-poll. Personas updated to call `slack_reply`/`discord_reply` when in a
  thread. Previously `action`/unanswered-`ask` fell through to a generic work agent. `src/edge/automations.ts`,
  `src/edge/concierge.ts`.
## [0.294.1] — 2026-08-03
### Fixed
- **Slack DMs from the OS were unanswerable — the app manifest never enabled the Messages tab.** Slack
  ships an app with **App Home → Messages Tab OFF**, which replaces the DM composer with a dead
  *"Sending messages to this app has been turned off."* banner. Every inbound DM path the OS has arrives
  as a `message.im`: answering a blocking `ask_human`, approving/denying a gate inline
  (`decideApprovalFromChat`/`answerQuestionFromChat`), or chatting 1:1 with an agent. So a human could be
  DM'd a question or an approval and physically could not reply — the scopes and event subscriptions were
  right, the tab was the missing half. The bundled manifest now sets
  `features.app_home.messages_tab_enabled: true` (+ `messages_tab_read_only_enabled: false`), and the
  Settings → Integrations setup guide calls out the toggle for **already-installed apps**, which a
  manifest change does not reach (`web/src/App.tsx`).
- **The `notify` tool no longer reads as a way to ask someone a question.** Its description offered
  itself for "progress/updates/**questions**" to another teammate, but `notify` is strictly one-way (an
  Inbox `update` card + a DM, with no reply affordance on either) — so an agent that used it to ask for a
  design decision and then held its work waited forever. It now states the one-way contract explicitly
  and points at `ask_human` with `to`, which blocks and is answerable from the Inbox or the DM
  (`src/memory/memory-mcp.ts`). Schema change — a live session picks it up after a relaunch.

## [0.294.0] — 2026-08-03
### Added
- **By-id session fetch — `GET /api/sessions/:id` and `GET /api/sessions?ids=a,b,c`** (Sessions-pagination
  Phase 1; plan in `docs/sessions-pagination-plan.md`). The console had no way to read a single session —
  every by-id lookup came from the full ~950-row list the 1.5 s poll ships. These return the same
  derived-row shape (clipped `task`, `blocked`/`alive`/labels), reuse `listSessions`' `canViewRow` scoping
  (an id the caller can't see → 404 / omitted, no existence leak), and match by id **regardless of
  `archived_at`** so a notification-open resolves an archived run too. `listSessions` gained an optional
  `ids` filter; `src/terminal.ts`, `src/server.ts`, `web/src/lib/api.ts`.
### Changed
- **The Tasks board stops re-fetching the whole sessions list every 5 s.** It only needs the sessions its
  visible tasks point at (`lastSessionId`, to light a card up as live via `liveOf`); it now fetches exactly
  those ids via `sessionsByIds` instead of all ~950 rows. First step of splitting the session poll from the
  list — the global 1.5 s poll still ships the full list until Phase 2 (a cheap summary feed). `web/src/App.tsx`.

## [0.293.1] — 2026-08-03
### Fixed
- **Router LLM pick now handles meta-phrased routing questions.** "which agent can help me build a
  feature?" still disambiguated wrongly because `llmPick` read it as a question ABOUT routing (→ UNSURE)
  rather than a task to route. Its prompt now tells the model that a message may be a task OR a "which/who
  agent for X" question, and to route to the agent best suited for the underlying work either way — so
  "which agent can help me build a feature" → `engineer`, matching the bare "build a feature". This is
  what Cockpit's "Route to an agent instead" sends. `src/edge/router.ts`.
## [0.293.0] — 2026-08-03
### Added
- **A ceiling on how long a session may sit blocked on an unanswered question.** The idle janitor skips a
  session that's waiting on a person — rightly, that wait is real — but nothing expires an Inbox card, so
  the exemption had no floor and the wait could be permanent. Live initech was holding a `support`
  session **66 hours** after its question was asked, alongside two more questions unanswered since 07-28;
  each such session pins a `claude` process (~300 MB) and a concurrency-cap slot indefinitely. New setting
  **Settings → Runtime → "Close a session waiting on an unanswered question after (hours)"**, default
  **72 h** — the same age at which `escalateStalePrompts` already gives up nagging and treats a prompt as
  dead. Past it the session is closed and its card **cancelled**, which is also what makes the card
  dismissable instead of hanging in the Inbox. `0` restores the old wait-for-ever.
  - The clock runs from when the **oldest pending card was raised**, not from session idleness — the claim
    being made is "nobody answered this in three days", and a blocked session is quiet by definition.
  - A session with **someone attached is never cut**: a human is right there and can answer.
  - Applies to the interactive lane. Unattended runs already had a ceiling (`unattendedMaxHours`, 24 h)
    that overrides a pending block.
  - Audited as `session.reaped` with `reason: 'blocked-timeout'` and how long it had waited, so this is
    distinguishable from an ordinary idle reap. `blockedMaxHours` on `GET`/`PUT /api/settings/concurrency`.

## [0.292.5] — 2026-08-03
### Changed
- **The router now uses the LLM to pick from the FULL roster when keyword routing isn't confident — not
  just to re-rank a near-tie shortlist.** Without an embedder the keyword scorer is weak (a task's words
  rarely match an agent's description verbatim — "build a feature" doesn't lexically hit `engineer`), so it
  disambiguated to the wrong few or fell through to the whole-fleet list. Now, on any low-confidence
  keyword result (`disambiguate`/`none`), if an LLM is configured (Anthropic key or an OpenAI-compatible
  endpoint) it picks the single best-fit agent from *every* agent's description — e.g. "build a feature" /
  "which agent can help me build a feature" → `engineer`. A confident keyword `route` is left alone (no
  LLM cost); UNSURE keeps the keyword decision; no LLM configured → unchanged keyword-only behavior. This
  fixes the wrong list behind Cockpit's "Route to an agent instead" and lifts routing quality across
  Cockpit, Discord, and Slack (verified with a stubbed model: keyword-weak → full-roster LLM pick;
  confident keyword → 0 LLM calls). `src/edge/router.ts` (`llmTieBreak` → `llmPick`).

## [0.292.4] — 2026-08-03
### Changed
- **`GET /api/sessions` clips the `task` prompt IN THE QUERY** instead of `SELECT *`-ing the full text
  and throwing it away. The list has always shipped `task` clipped to `LIST_CLIP` (240) — but the server
  still pulled every session's *complete* prompt out of SQLite first (**up to 53 KB/row on globex; 2.1 MB
  materialised per poll**) only for `server.ts` to clip it. `listSessions`/`listArchivedSessions` now take
  an optional `taskClip`; when set (the list endpoint only) the SELECT projects `substr(task,1,241) AS task`
  via a schema-derived column list, so SQLite stops materialising the overflow text. Measured on a live
  globex snapshot (950 rows): task bytes **2.10 MB → 201 KB**, the raw query **5.23 → 3.53 ms (−33%)**, and
  full `listSessions(owner)` **13.3 → 11.1 ms (−17%)** per poll, plus ~1.9 MB less string allocation each
  1.5 s tick. Byte-identical output — the existing `clipText` still runs as the ellipsis-preserving finisher
  on the ≤241-char string (verified across all 950 rows, 746 of them >240 chars). Internal callers that read
  the whole prompt (`sessionsForAgent`, the Cockpit context) pass no clip and keep the full `SELECT *`.
  `src/terminal.ts`, `src/server.ts`. Follow-on to #530/#532/#533; the structural fix (pagination) is still open.

## [0.292.3] — 2026-08-03
### Fixed
- **Cockpit `ask`: "which agent can help me build a feature?" dumped the whole roster instead of
  recommending one.** The band-1 state lookup's agent-list rule fired on any `which/what/list/how many` +
  "agents", so a *recommendation* question got a raw 16-agent list that ignored the task. It now only
  fires for genuine **enumeration** ("list my agents", "how many agents", "what agents do I have", "which
  agents are available"); a "which agent can help with / handles / for <task>" question falls through to
  the LLM (which sees the agents' descriptions and recommends the right one — e.g. `engineer`). Verified
  8/8. `src/edge/ask.ts`.

## [0.292.2] — 2026-08-03
### Fixed
- **`listSessions` re-queried the members and automations tables once per row.** v0.291.6 made the
  1.5 s console poll cheap on the wire (a 304 with no body), but the server still paid the full rebuild
  before it could decide to send that 304 — a 304 measured exactly as slow as the full response. The
  rebuild's single largest cost turned out to be the four per-row helpers (`spawnedByLabel`,
  `sourceKind`, `runAsLabel` and `canViewSpawn`), each of which issued its own point lookup per row: on
  the live globex tenant that was **~1900 SQLite queries per poll to resolve 14 members and 40
  automations**. The lookup tables are tiny and bounded; the row count (950 and growing) is not.
  A `withRowCache` scope now loads each table **once per list call** and the helpers read from it —
  two queries in place of ~1900.
  - `tm.listSessions(owner)` **35 ms → 14 ms (−60%)**; internal/no-viewer 43 → 22 ms; archived 1.5 → 0.6 ms.
  - End-to-end `GET /api/sessions` **51 ms → 32 ms**, and the idle-poll 304 path **50 ms → 30 ms** —
    which is the one that runs 40×/minute per open tab.

  The cache lives only for the duration of one **synchronous** call (no await, so nothing can interleave)
  and nothing inside the scope mutates either table, so it cannot go stale. Outside such a scope the
  helpers take exactly the old direct-query path, leaving every other caller untouched. The scope is
  re-entrant and restored in a `finally`, so an exception can't strand a stale cache on the instance.

  Complements #532, which stops the *client* re-rendering on an unchanged tick: together an idle poll now
  neither rebuilds on the server nor re-renders in the browser.
### Changed
- **gzip level is now split by how often the same bytes get compressed.** A static asset is compressed
  once per build and cached, so it keeps level 6. A live JSON payload is re-compressed on nearly every
  poll (`/api/sessions` changes whenever any run does), so it drops to level 4: measured on that 1.2 MB
  payload, **15.8 ms → 10.1 ms for 5.9% more bytes** (level 1 would be 6.5 ms but 18.8% more). The
  compression time had become comparable to the entire list rebuild.

## [0.292.1] — 2026-08-03
### Changed
- **The console's global 1.5 s poll now skips the re-render on unchanged ticks (client-side 304).**
  #530 gave every response a wire-level ETag + gzip, so an idle tab already stops re-*downloading* the
  ~1.65 MB sessions list. But browser auto-revalidation still hands the *cached* body back to JS, so the
  console kept re-parsing and re-rendering the whole list every 1.5 s regardless. The global feed poll
  now sends its last ETag explicitly (`sessionsFeed`/`messagesFeed` → `callFeed`, `cache: 'no-store'`)
  and, on a **304**, resolves `notModified` so the poll **skips `setState`** — no re-parse, no React
  re-render. The tag covers the fully-computed response, so a derived change (a run going
  `blocked`/`crashed`, a cost backfill, a new inbox card) still flips it and the tab-title badge /
  waiting bells never go stale. Complements #530 (which keeps the transfer + gzip on the ticks that *do*
  change). `web/src/lib/api.ts`, `web/src/App.tsx`.

## [0.292.0] — 2026-08-03
### Added
- **Questions in Slack/Discord now get answered inline — no session spawned.** The chat front door
  (`Automations.routeUnmatched`, behind fireSlack/fireDiscord/fireClickup) now runs the Cockpit **intent
  layer**: a message classified `ask` ("how do automations work?", "which agents are idle?") is answered
  in-thread via the *same* backend Cockpit uses — a deterministic state lookup, else a direct Claude call
  (Haiku by default) — and posted back as a threaded reply in ~1–2s, instead of routing the question to an
  agent (a whole session). `action`/`work` messages, and an `ask` when no LLM is configured, still route to
  an agent as before (graceful fallback). Audited `chat.answered` (source `state`/`llm`, no session row).
  The `ask` engine is now a shared `answerAsk` in `src/edge/ask.ts` (with `cockpitWorkspaceContext` moved
  there from `src/server.ts`), used by BOTH `/api/router/preview` and the chat front door so they answer
  identically. `src/edge/ask.ts`, `src/edge/automations.ts`, `src/server.ts`.
### Fixed
- **The intent classifier mis-read questions about automations as create-requests.** "what's the
  difference between a task and an automation" classified as **action** (→ Automations) because the bare
  noun "automation" tripped the schedule regex. It now requires a scheduling **verb** or recurrence
  (`schedule …`, `automate …`, `every morning`, `daily`), or an explicit "create/set up an automation/cron"
  — so the noun alone in a question stays an **ask**. Legit action requests ("schedule the churn report
  every morning", "create a cron job") are unaffected (verified 11/11). `src/edge/intent.ts`.

## [0.291.6] — 2026-08-03
### Fixed
- **The console served every byte uncompressed and uncacheable.** Opening a detail page
  (`#/tasks/<id>`, a session, an artifact) felt slow, but the detail endpoints were never the problem —
  `GET /api/tasks/tsk_…` answers in **3 ms / 6.5 KB**. The cost was the shell around it. Measured on the
  live globex tenant: the app bundle is **1.13 MB of JavaScript** (plus 592 KB of xterm and 100 KB of
  CSS) sent with **no `content-encoding` and no `cache-control` at all**, so every reload re-downloaded
  ~1.8 MB, and the SPA then polls `/api/sessions` (3.07 MB) + `/api/messages` every **1.5 s** forever —
  twice over on the Tasks page, which polls sessions again on its own 5 s timer. Nothing in front covered
  it: the Mac Mini tenants run behind `tailscale serve` with no nginx, and the nginx box has `gzip on`
  but left `gzip_types` commented out, which defaults to `text/html` only.
  `sendJson`/`sendFile` now funnel through one `sendBody` that:
  - **gzips** responses over ~1 MTU whose type is worth compressing — app bundle **1115 KB → 299 KB
    (−73%)**, `/api/sessions` 3.0 MB → 851 KB, `/api/tasks` 1.25 MB → 453 KB;
  - attaches an **ETag** to cacheable GETs, so the 1.5 s poll answers **304 with an empty body** when
    nothing changed instead of re-sending a megabyte;
  - marks Vite's content-hashed `/assets/*` **`immutable` for a year** (they can't change under their own
    URL) while `index.html` stays `no-cache`, so a deploy is still picked up on the next load;
  - reads and compresses each static asset **once per build**, keyed by `path:mtime:size`.

  Compression is **opt-in by the client** — we only gzip when the request advertised
  `accept-encoding: gzip`. The gate hook's loopback calls, the MCP tools and plain `curl` send no such
  header and keep receiving identity bytes, so nothing on the agent side changes. `no-cache` (not
  `no-store`) pairs with the ETag: a client may reuse a body only after revalidating, never stale.

## [0.291.5] — 2026-08-03
### Fixed
- **Talking to `localhost` no longer raises an owner approval.** Host governance treated loopback as
  egress, so an agent curling its own dev server — or the Agent OS API — paused for a human at
  owner/admin tier. It bought nothing: anything listening on loopback is already reachable by the shell
  the agent is holding, and `shell.exec` governs that. It cost a great deal, though — on live northwind,
  `127.0.0.1` + `localhost` were **35 of the 49** host approvals ever raised. `computeHostFacts` now
  reports `netEgress: false` for a pinned loopback target (`localhost`, `127.0.0.0/8`, `::1`), in
  `allowlist` lockdown as well as `open`. Private, internal and unpinnable hosts are governed exactly as
  before. Known limit, unchanged: an `ssh -L` tunnel on a loopback port is invisible to a policy layer.
- **IPv6 hosts were being compared as the single character `:`.** Host normalisation stripped a `:port`
  suffix with a regex that eats the tail of a bare IPv6 literal (`'::1'` → `':'`), so every v6 address
  collapsed to the same string — `hostMatches('::1', '::2')` returned **true**, and a granted v6 matcher
  would have matched any other v6 host. Normalisation is now one shared helper that unwraps `[…]`, keeps
  a bare v6 literal intact, and strips a port only where there is one. Relatedly, `parseAuthority` failed
  on a bracketed v6 URL with a path (`https://[::1]:9000/x`) and pinned the host as the literal `[`.
### Changed
- Four new conformance cases pin the loopback exemption (localhost, `127.0.0.1`, lockdown mode, and a
  private non-loopback address that must still be governed) — 159/159.

## [0.291.4] — 2026-08-03
### Fixed
- **Removing a runtime-account `token` account now deletes its vaulted token** instead of leaving an
  orphaned `runtime-token:<runtime>:<name>` secret behind. `DELETE /api/runtime-accounts/:runtime/:name`
  drops the value the add-handler sealed (a `token` account OWNS it); an `apikey` account, which only
  REFERENCES a user-managed vault key, and an `oauth` account, which has none, are left untouched.
  `src/server.ts`.

## [0.291.3] — 2026-08-03
### Fixed
- **Console detail pages (task · session · artifact) took seconds to open.** The detail endpoints were
  never the problem — `GET /api/tasks/:id` answers in **1.7 ms**. The cost was the list payloads the SPA
  loads alongside them: on the globex tenant `GET /api/sessions` was **3.02 MB** (946 rows, of which
  **2.1 MB was the full `task` prompt of every session**) and `GET /api/tasks` was **1.24 MB** (471 rows,
  **887 KB of it task `body`**) — ~4.3 MB of prose per console load that no list view renders. Both list
  endpoints now clip those fields to 240 chars (`LIST_CLIP`), which is all the console uses them for: a
  client-side search haystack and a `line-clamp-2` fallback caption. Full text is untouched on the detail
  fetches (`GET /api/tasks/:id` still returns the whole `body`, and the Tasks description tab already read
  it from there). **Measured on live production data: 4.26 MB → 1.65 MB, −61%.**

## [0.291.2] — 2026-08-03
### Fixed
- **Five source files were invisible to `grep` and `ripgrep`.** They used a raw NUL byte as a
  composite-key/sentinel separator (`` `${a.owner}<NUL>${a.key}` ``) instead of the two-character `\0`
  escape. It compiles and runs identically — but `file` reports such a source as binary, and both grep
  and rg then skip it **entirely and silently**. The affected files were `governance/enricher.ts`,
  `governance/policy.ts`, `kernel.ts`, `edge/secrets.ts` and `memory/sqlite-provider.ts` — the classifier,
  the policy engine and the composition root among them, so a search like `grep -rn computeHostFacts src/`
  returned the declaration and never the call site, which reads as "nothing uses this". Now written as
  `\0`; the compiled output is byte-identical once NUL and `\0` are normalised (verified against a
  pre-change build), so this is pure source hygiene with zero behaviour change. `test:governance` gained a
  guard that fails the build if a NUL byte reappears in `src/**/*.ts`.

## [0.291.1] — 2026-08-03
### Fixed
- **An unanswered approval no longer pins a finished run's terminal open forever.** Nothing expires an
  Inbox card, and that was load-bearing in the wrong place: an unattended run whose gate hit the 180s
  fail-closed deny (or whose `ask` parked) is told to wrap up, calls `report` — the row flips to `done`
  while the approval stays `pending`. Every teardown path then skipped it as "blocked on a person":
  `markTurnIdle` bailed, the idle backstop bailed, and neither force-reap could reach it because both
  require `status = 'running'`. Live northwind was holding **five `done` sessions with a live tmux pane
  and ~430MB of `claude` each, the oldest three days old** — ~2.1GB pinned by cards nobody could deliver
  an answer to. A finished run cannot consume an answer, so the done-orphan sweep now reaps it and
  cancels the card (which is also what makes it dismissable in the Inbox instead of hanging). A
  still-*running* blocked run is untouched — that wait is real.
- **The egress parser no longer reads the word `ssh` in a grep pattern as an ssh.** Verbs were matched
  anywhere in the command line, so `grep -i "cmd\|exec\|ssh\|sprintf"` and `ssh -i ~/.ssh/id_rsa` both
  registered as egress with an unpinnable host — an owner approval for a local grep. 10 of the last 15
  host approvals on northwind were this "host could not be identified" shape. `host-match.ts` now splits
  the line into command invocations (quote-aware, so a `|` inside a quoted pattern is data) and matches
  the verb against the **head token**, seeing through wrapper prefixes (`sudo -u deploy ssh box`),
  leading paths (`/usr/bin/ssh`) and one level of quoted assignment / `sh -c` / `find -exec` nesting.
  Real egress keeps escalating, and `SSH="ssh … root@box"` now *pins* `box` instead of escalating as
  unknown — so it can be granted in Settings → Connections and stop asking.
### Changed
- `npm run test:governance` (what CI runs) now also runs the idle-reaper suite, and that suite's tmux
  stub reports panes as alive — an empty stub made crash detection claim every row first, which had
  quietly left 8 of its 12 assertions failing.

## [0.291.0] — 2026-08-03
### Fixed
- **A resident chat no longer hits `/login` mid-session when it launched under a rotation paste-token.**
  A `token` (setup-token) / `apikey` account is injected as a static `CLAUDE_CODE_OAUTH_TOKEN` with no
  refresh token in the process, so after its access window (~hours) a long-lived session can't renew it —
  claude prints "OAuth access token has expired · Please run /login" and wedges. Short unattended runs
  exit each turn and never live long enough to hit it, but a **resident** Slack/Discord chat (kept warm
  for days) does. Fix: resident sessions rotate ONLY onto **refresh-capable** `oauth` credential-dir
  accounts (claude refreshes within `CLAUDE_CONFIG_DIR`); with none available they fall through to the
  box default, which carries its own refresh token. Unattended/one-off runs still rotate across ALL
  account kinds (the zombie-during-weekly-limit protection is unchanged). `pick()` gains an optional
  `kinds` filter; `applyRuntimeAccount` passes the session's `resident` flag. `src/state/runtime-accounts.ts`,
  `src/terminal.ts`, `web/src/App.tsx` (panel note).

## [0.290.0] — 2026-08-01
### Added
- **Quick filters on the Tasks board — a status lens and an "Unassigned" chip, both with live counts.**
  The board could filter by assignee, label, priority, goal, live-session and overdue, but **not by
  status** — so the list showed every finished task forever (on the live northwind board that's 73 of 126
  tasks, 58% of it terminal, with 7 blocked tasks buried in the middle). A leading segmented control now
  collapses the status machine into the three questions a list actually gets asked — **Open** (anything
  unfinished), **Blocked** (stuck, needs a human — tinted red when active), **Done** (done + cancelled) —
  and an **Unassigned** chip finds work nobody has picked up. Every quick filter carries a **facet count**:
  the number computed with its *own* dimension ignored, so "Blocked 7" narrows to "Blocked 2" once you add
  Unassigned and each count promises exactly what clicking it yields. Overdue gained a count for parity.
  Defaults are unchanged (**All**), so the view opens the way it always has. `web/src/App.tsx`.

## [0.289.0] — 2026-08-01
### Changed
- **The goal detail is a full-page room, not a modal.** A goal has too much going on for a dialog —
  linked tasks, the strategist plan step, a timeline you scroll, and a sign-off decision — and the modal
  made all of it compete inside one scrolling box. It now opens the same way a task does: a header with a
  back-to-Goals control, status chip and id; the work as the main column under **Tasks / Description /
  Activity** tabs; and the goal's own state (sign-off box, status, owner, target, due, progress, delete)
  as a 320px sidebar. The active tab lives in the URL (`#/goals/<id>/activity`), so a permalink opens
  where you meant it to. Editing takes over the main column instead of stacking another layer, and the
  Activity tab pins its comment box to the bottom the way a discussion does. `web/src/App.tsx`.

## [0.288.0] — 2026-08-01
### Added
- **Cockpit `ask` + router tie-break can answer via first-party Claude — configured from the web UI.**
  When an Anthropic API key is set, the `ask` tier and the router's near-tie tie-break call Claude directly
  (`POST /v1/messages`, raw `fetch` — no SDK dependency), defaulting to **`claude-haiku-4-5`** (fastest +
  cheapest; ample for a workspace Q&A). This is the fast, session-free middle rung between the free state
  lookups and the key-free concierge run: **state → direct Claude (if a key is set) → concierge fallback**.
  The key + model are set in **Settings → Integrations → "Cockpit answers (Anthropic)"**, stored in the
  per-tenant settings table like every other integration key — **masked/write-only** (the API only ever
  returns `{ set, source, model }`, never the key). `ANTHROPIC_API_KEY` in the server env also works (the
  Settings value wins; the panel shows which source is active). Billed to the Anthropic org — separate from
  any Claude Code subscription (which only the concierge, a real Claude Code session, can use). The
  tie-break gate now fires for **any** resolvable LLM (Anthropic key or an OpenAI-compatible endpoint), not
  just `router_config.llm`. `src/edge/llm.ts` (tagged Anthropic/OpenAI backends + `ANTHROPIC_BASE_URL`
  override), `src/governance/settings.ts` (`anthropicKey`/`anthropicModel`/`anthropicMeta`), `src/server.ts`
  (integrations view + PUT), `src/edge/router.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`.

## [0.287.0] — 2026-08-01
### Changed
- **Runtime-account validation now reads real weekly/session usage for `setup-token` accounts too — not
  just login credential-dirs.** The previous check hit `GET /api/oauth/usage`, which requires the
  `user:profile` scope a `claude setup-token` doesn't carry (403 → usage always blank for the fleet's
  paste-tokens). Switched to the method that works for every subscription token: a minimal
  `POST /v1/messages` (cheapest model, `max_tokens:1`) whose `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}`
  response headers carry the subscription usage — readable with the `user:inference` scope every token has,
  and present even on a 429 (at-limit) response. So the **Usage** column now populates for setup-tokens
  (e.g. `weekly 0% · session 1%`), and a window reported `rejected`/≥100% parks the account limited until
  its reset. Validation is unchanged (401 → rejected on add). Costs one 1-token inference per add/Refresh
  (a fraction of a cent), which mirrors Claude Code's own startup probe. `src/edge/runtime-account-check.ts`.

## [0.286.0] — 2026-08-01
### Added
- **Capability Registry (§4.2) — normalize connector tool names to canonical, provider-independent
  capabilities** (`src/capabilities/normalize.ts`). The gate hook collapses every MCP/connector call
  to the structural id `connector.call`, with the real vendor action surviving only in `args.tool`
  (`mcp__composio-company__STRIPE_REFUND`, …), so the same action wears a different name on every
  surface and policy can't target it portably. `resolveCapability(capability, toolName)` maps that raw
  name to ONE canonical capability (`payments.refund`, `repo.pr.create`, `messaging.post`, …) so a
  single policy rule governs a Stripe refund across a Composio slug / a REST-shaped tool / an SDK-shaped
  name identically. First-match table keyed on `connector.call` only; an unmapped tool falls through
  unchanged, so this only ADDS granularity, never removes governance. Seeded narrowly (payments.*,
  repo.*, messaging.post) per the plan — grow as coverage grows; plus `capabilityDescriptor()` /
  `knownCapabilities()` (id + effects + risk + example providers) for a future catalog view. Wired into
  `TerminalManager.gate()` **after** `enrichArgs` (so the enricher's connector-mutation facts are still
  set off `connector.call`) and after the email/host promotions, mirrored in `policyCheck()` and the
  conformance runner. New test `scripts/capability-registry-test.cjs` (18 cases incl. the moat proof:
  one `payments.refund` rule governs three surfaces identically), wired into `npm run test:governance`;
  +1 conformance fixture pinning that an over-cap refund is STILL `never` after the rename. Suite
  138/138 — backward-compatible (the bundled default policy gains no new rules; normalization preserves
  every existing decision). The in-process demo `Gateway` (execution-registry path) is intentionally
  untouched.

## [0.285.0] — 2026-08-01
### Added
- **Goals can now finish.** `progress()` has always derived 100% from linked tasks and *nothing consumed
  it* — `achieved` was reachable only by hand-picking it from a dropdown inside the goal drawer, so a
  completed goal sat `active` indefinitely (on the live globex tenant, one had been 6/6 done for 19
  days). Completion is now **derived, announced, and human-confirmed** — never auto-flipped, because "every
  task I filed is done" is a weaker claim than "the outcome was achieved". New `GoalStore.readyToClose()`
  (every non-cancelled *leaf* linked task done) drives: a **Ready to close** chip + page banner + drawer
  sign-off box on the Goals page, offering **Mark achieved** with an optional outcome note (patched
  alongside the status, so the timeline records *why*) or **Not yet — plan the gap** (hands it back to the
  strategist). `src/state/goals.ts`, `web/src/App.tsx`, `docs/goals-plan.md` §Slice 4.
- **A goal whose work completes now reaches its owner.** `GoalStore.setNotifier` existed with **no
  consumer** — every goal status change was silent. `notifyGoalEvent` (mirroring `notifyTaskEvent`) routes
  `ready` → the goal's owner (else admins) and `achieved`/`abandoned` → the owner as an inbox card
  (`goal.ready`) + DM. Driven by a new always-on `sweepCompletedGoals` tick, announced exactly once per
  completion streak via a `ready` goal_event guard (later work that also completes announces again).
  `src/tenant-registry.ts`, `src/edge/automations.ts`, `src/terminal.ts`.

### Fixed
- **The goal auto-planner filed fresh work for goals that were already done.** `GoalStore.stuck()` selected
  active goals with no *open* task — true both for "never planned" and for "all work finished", so with
  Auto-plan on the strategist was spawned to invent new tasks for a completed goal. `stuck()` now means
  **no work filed at all** (never planned, or every task cancelled); the finished case routes to the owner
  for sign-off instead. The Insights "unstick" list excludes finished goals for the same reason, and the
  goals tile now separates *ready to close* / *no work planned* / *no progress in 7+ days* rather than
  calling all three "stuck". `src/state/goals.ts`, `src/server.ts`, `src/edge/improvements.ts`.
- **A finished goal kept steering the whole fleet.** `buildCompanyMd` injects active goals into every
  agent's prompt as "the direction your work serves" — including goals whose work was complete but
  unclosed, indefinitely. Completed-but-unsigned-off goals are now filtered out of that set (they're
  awaiting a human, not directing work); `goal_list` still returns them live. `src/terminal.ts`.
## [0.284.1] — 2026-08-01
### Fixed
- **Codex's "Update available" banner is now suppressed** (`check_for_update_on_startup = false` in the
  generated config). It is an INTERACTIVE prompt drawn at TUI startup that waits on a keypress — on an
  unattended run nobody answers it, which is the same permanent-hang class as the folder-trust and
  hook-review prompts already pre-empted. It also silently swallows the first keystroke sent to a fresh
  pane, which is how it was spotted. Agent OS pins the CLI deliberately, so an in-pane self-update was
  never wanted.

### Changed
- Hook-trust hash **verified compatible with Codex 0.146.0** (derived against 0.145.0): the computed hash
  is still accepted with no review prompt, the hook still fires, `tool_name` is still `Bash`, an allow is
  still correctly expressed as silence, and a deny still blocks. Documented as a per-upgrade check.

## [0.284.0] — 2026-07-31
### Added
- **Runtime-account tokens are validated against the provider before they enter the pool, and their
  weekly/session usage is shown per key.** A mis-pasted Claude subscription token used to be vaulted
  as-is, then silently sent every future session to `/login` (an invalid `CLAUDE_CODE_OAUTH_TOKEN` — the
  exact outage seen on northwind). Now `POST /api/runtime-accounts` probes the token against Claude's own
  `GET /api/oauth/usage` endpoint (the source Claude Code's status line uses; no quota consumed) and
  **rejects a definitive 401 with a clear message** instead of storing it. A valid token is accepted; a
  transient network/429 is added and badged "could not verify" rather than blocked. `src/edge/runtime-account-check.ts` (new),
  `src/server.ts`.
- **Per-key usage in Settings → Runtime accounts.** The pool table gains a **Usage** column (weekly 7d +
  session 5h utilization, coloured amber ≥80% / red ≥100%, reset time on hover) and a **Refresh** action
  to re-probe on demand; the add form echoes the validation result ("added · valid · weekly 13% used").
  Usage is populated for accounts whose token carries the `user:profile` scope — an interactive-login
  **credential-dir** (`oauth` kind). A `claude setup-token` (the paste-token kind) is validated the same
  way but **can't report usage** (Anthropic scopes it out of the profile endpoint) — shown honestly as
  "valid · usage n/a (setup-token lacks the user:profile scope)". New columns on `runtime_accounts`
  (`last_checked_at`/`check_ok`/`check_note`/`usage_json`); `POST /api/runtime-accounts/:runtime/:name/check`.
  `web/src/App.tsx`, `web/src/lib/api.ts`, `src/state/runtime-accounts.ts`, `src/state/db.ts`.
### Fixed
- **A pool token that goes bad mid-life now rotates itself out instead of trapping every launch.** The
  launch-time backstop to add-time validation: when an unattended run's pane shows a credential-rejection
  banner ("invalid bearer token" / "oauth token expired" / "failed to authenticate") — as opposed to a
  usage-limit — the account it launched under is **auto-disabled** (`markInvalid`), since an invalid token
  won't self-heal at a reset the way a usage limit does. It drops out of the pool (a `Refresh` that
  re-authenticates re-enables it) so the launcher falls back to another account / the box default rather
  than sending run after run to `/login`. `src/terminal.ts` (`detectUsageLimit` now distinguishes
  auth-failure from usage-limit), `src/state/runtime-accounts.ts` (`markInvalid`/`recordCheck`).

## [0.283.2] — 2026-07-31
### Changed
- **System-agent runs (the Cockpit concierge/operator, consolidator, …) are hidden from the Chat +
  Sessions lists.** These `category:'System'` machinery runs are spawned run-as the member (provenance
  `chat:<member>`), so they were cluttering the member's Chat list and the Sessions list as if they were
  conversations the member started. `listSessions` now derives a `system` flag from the agent's category;
  the console filters it out of the Chat list, the Sessions list, and the running-count badge. The rows
  still exist — openable by id (Cockpit's "Open full session" still works) and in the Audit log — they're
  just out of the everyday lists. `src/terminal.ts` (`Session.system`), `web/src/App.tsx`,
  `web/src/lib/api.ts`.

## [0.283.1] — 2026-07-31
### Fixed
- **Every allowed Codex tool call logged `PreToolUse hook (failed)`.** Codex's parser acts on `deny` but
  **rejects `allow`** (`unsupported permissionDecision:allow`) and then runs the tool anyway. Governance
  was never at risk — deny genuinely blocks, verified live (`PreToolUse hook (blocked)`, command never
  ran) — but the pane showed a hook FAILURE on every allowed call, which reads as "the gate is broken"
  to anyone watching. The audit trail looked identical either way, which is why it survived several
  releases: it is only visible in the pane. The gate now expresses an allow on Codex as **silence +
  exit 0**, the same way it already expresses "not my business" for `Read`/`Glob`/`Grep`; Claude Code
  still gets the explicit `allow` it needs (there it is what bypasses Claude's own permission engine).
  The `instruct` verb survives — Codex makes `permissionDecision` optional, so an allow-with-note is sent
  as `additionalContext` alone; verified end to end (`hook (completed)`, note reached the model, model
  acted on it).

## [0.281.5] — 2026-07-31
### Fixed
- **The approval-friction signal no longer divides by a denominator that isn't there.** v0.280.0 started
  recording the `approved` count so friction could be a rate; per-pass entries written before that carry
  rejections with **no denominator**, and `recentTally` summed them anyway — so a window of mostly-legacy
  entries read as ~100% rejection. Live northwind was nagging every agent that "recent actions were
  rejected at human approval" while its true 7-day rate was **5.4%** (35 approved / 2 rejected). Entries
  lacking the denominator now contribute to neither side of the ratio (their budget/error signals still
  count), so the signal stays quiet until real evidence exists rather than inventing it. Verified against
  both live tenants' actual window shapes: the false northwind nag stops; genuine friction with a real
  sample still fires.

## [0.281.4] — 2026-07-31
### Fixed
- **Bump `TOPICS_VERSION` to 3.** v0.281.3 tightened the topic extractor (opaque hex ids) without bumping
  the version counter added in v0.281.2, so ids already written into a workspace's cumulative topic map
  stayed there — the exact failure that counter exists to prevent. Bumped, and the requirement to bump it
  alongside any extractor change is now stated at the constant.

## [0.281.3] — 2026-07-31
### Fixed
- **Opaque identifiers are no longer "things the fleet works on".** The digit rule that admits `v3`/`php8`
  also admitted hex handles — after the topic-map rebuild, live globex surfaced `f90fc16d7fb9a19` in the
  guidance line. A long hex/base36 run (or a `tsk_…`-style prefixed id) is a handle, not a name.
- **The approval-friction signal now needs a sample, not just a rate.** v0.280.0 replaced a raw-count gate
  with a ≥20% rejection rate; on live globex that fired off **3 decisions** (0 approved, 3 rejected =
  100%) — directionally true for the window but far too thin to tell an owner their policy is
  miscalibrated, or to tell every agent to expect rejection. Both the guidance line and the
  `policy.review` recommendation now also require at least 8 human approval decisions in the window.

## [0.281.2] — 2026-07-31
### Fixed
- **A fixed topic extractor now actually reaches workspaces that have already been running.** `topics` is a
  CUMULATIVE map — counts compound across passes and decay only on a 21-day half-life — so v0.281.1's
  extractor fix changed nothing for an existing tenant: the words the old extractor admitted kept their
  (large) counts and kept headlining the guidance line in every agent's prompt. Live northwind held 300
  topics led by `drafts(61)`, `sweep(59)`, `automated(58)`, all artefacts of one shouted prompt header.
  `DreamState` now carries a `topicsVersion`; a state written by an older extractor has its map cleared and
  rebuilt from the current corpus. The reset runs **before** the no-activity early return, so a quiet
  workspace stops serving the stale line immediately rather than at its next busy pass. Audited
  `learning.topics.reset`. Every tenant self-heals on its next pass — no hand-edited databases.

## [0.281.1] — 2026-07-31
### Fixed
- **Self-learning topic extraction: the case signal is now read the way a writer meant it.** v0.280.0
  replaced the unwinnable stop-list with an allow-test on shape (a topic must be written as a name), but
  running a real pass on two live tenants showed case alone is not enough — the guidance line, which rides
  in **every agent's system prompt**, came back as "the fleet frequently works on: claude.md, drafts,
  support, sweep, automated" on northwind and still carried "handed, really" on globex. Every one of those
  came from a construction where the capital was not a choice:
  - **Shouted headers.** One automation prompt repeated ten times opened `AUTOMATED INCREMENTAL SUPPORT
    SWEEP — …`. ALL-CAPS was admitted as an acronym signal (for `SSL`/`FPM`/`ASE`); now an acronym must be
    short and **isolated**, since a real one sits among lowercase words while a run of capitals is emphasis.
  - **Title Case / headings.** A line where most words are capitalized is skipped — case separates nothing
    within it.
  - **Emoji-prefixed templates.** The OS's own poke-back cards open `✅ Really done:` / `⛔ Handed back:`;
    an emoji wasn't recognized as a sentence start, so "really"/"handed" read as names. Anything with no
    letters before it now counts as a sentence start.
  - **Enumerated labels.** `Phase 1`, `Tier 2` — a capital followed by a number is a section heading.
  - **Words the corpus also writes lowercase.** A real name is *consistently* capitalized (`Composio`,
    `DataForSEO`); a word appearing both ways is an ordinary word that happened to open a clause. Evidence
    is counted per distinct line, so one template repeated verbatim can't outweigh every real name.
  - **Filenames** qualify on their base name, not the `.md`/`.ts` extension — the dot rule (meant for
    hostnames and versions) was admitting `claude.md` and even the placeholder `yyyy-mm-dd.md`.
  Also stop-worded the OS's own tool vocabulary (`publish`/`recall`/`remember`/`notify`, alongside the
  existing `report`/`update`) and `claude`, which describe **how** an agent worked, not what it worked on.
  Measured on the live corpora: northwind now yields `composio, dataforseo, monday, library, northwind.com`
  (previously nothing usable); globex yields `freescout, bunny, shield` among five (previously one).

## [0.284.0] — 2026-07-31
### Added
- **Policy v2, Tier A — set-membership and cross-arg conditions in the pure rule engine**
  (`src/governance/policy.ts`). A rule's `when` clause gains two shapes beyond the existing
  one-arg-vs-one-constant compare, both still stateless and still JSON:
  - **`in` / `nin`** — set membership against an array value, e.g.
    `{ arg: "status", op: "nin", value: ["paid","shipped","refunded"] }` → `never` (invalid-enum guard).
  - **`argRef`** — compare one arg to *another arg* instead of a constant, e.g.
    `{ arg: "payee", op: "ne", argRef: "buyer" }` → `ask` owner (wrong-recipient guard).
  The `applyProposal` tighten-only safety proof stays sound: `sampleArgDomains` now emits every enum
  member and seeds both sides of a cross-arg pair with one shared domain, and `firstLoosening`'s rare
  fallback path gets explicit joint coverage of each `argRef` pair (independent variation can't see
  `arg == argRef`). New test `scripts/tier-a-policy-test.cjs` (runs under `npm run test:governance`);
  the 130-case conformance suite is unchanged (backward-compatible — the bundled default policy uses
  no new ops).

## [0.283.0] — 2026-07-31
### Fixed
- **A Codex run silently inherited a Claude model from the workspace default and died.** Found on the
  first live attachable Codex session: the fleet default is `model: "opus"`, `codex-scout` pins no model
  of its own, so the launcher passed `opus` to Codex, which answered *"The 'opus' model is not supported
  when using Codex with a ChatGPT account."* Two holes, both now closed:
  - The cross-runtime model guard only matched full ids (`^claude`), so bare **aliases** — `opus`,
    `sonnet`, `haiku`, `fable` — sailed through. The patterns are now anchored on a word boundary and
    cover aliases both ways (`gpt`/`o<n>`/`codex`/`glm`/`kimi`/`deepseek` are refused for Claude Code).
  - Nothing validated **inheritance**. `PUT /api/agents/:id/config` rejects a foreign model, but the
    workspace default spans every runtime and therefore *cannot* be right for all of them at once — an
    agent with no model of its own picked one up silently. `resolveRuntimeTuning` now takes the runtime
    and **drops** a model that runtime can't run, so the session falls back to the CLI's own default (a
    working run) instead of failing outright.
  7 new conformance fixtures pin the inheritance matrix; suite is 137/137.

## [0.282.0] — 2026-07-31
### Added
- **Cockpit `action` tier now *executes* — a governed operator carries it out (auto-router Phase 3).**
  A detected action ("create a task to migrate the acme site", "run the churn report every morning") no
  longer just deep-links — clicking **Set it up** spawns the **operator**: an ephemeral System agent
  (`src/edge/concierge.ts`, sibling to the read-only concierge), run-as the member, that carries out the
  request via the **governed** tools and nothing else — `task_create` (filed immediately, audited) for a
  task, `automation_propose` (a DRAFT an owner must approve — it never fires unattended) for a scheduled
  job. Cockpit polls its transcript and shows the one-line confirmation inline ("✓ Created task: …" /
  "✓ Proposed automation … — pending an owner's approval"), with a link to Tasks / the Inbox. Explicit
  consent by design: nothing executes until **Set it up** is clicked; the operator can't bypass the gate
  hook, and an automation still needs a human approval — so this adds no ungoverned power. The card keeps
  "Open Automations/Tasks" (do it yourself) and "Route to an agent" as alternatives. New endpoint
  `POST /api/router/act`; the operator is `category:'System'` so it's never a route target.
  `src/edge/concierge.ts` (`ensureOperator`/`OPERATOR_ID` + shared provisioner), `src/server.ts`,
  `web/src/App.tsx`, `web/src/lib/api.ts`.
### Fixed
- **Governance conformance passes off the author's Mac again.** Three `file-guard` fixtures hardcoded
  `~/.ssh/…` as "the service user's home", but `sensitiveWriteRoots` resolves the home with
  `os.homedir()` at call time — so those cases only ever exercised the guard on one machine and asserted
  `allow`-shaped nonsense everywhere else. CI (Linux) had been red on exactly these 3 for weeks, which
  meant the governance gate was giving **no signal on merges**. Fixtures now write `${HOME}` and the
  runner expands it per platform. The guard itself was never wrong — verified on a Linux host that
  `$HOME/.ssh/authorized_keys` and `$HOME/.codex/auth.json` are denied.

## [0.282.0] — 2026-07-31
### Added
- **Codex sessions are attachable, and support warm resident chat.** Every lane is now the interactive
  TUI, matching the Claude lane: an unattended run can be taken over mid-run by simply attaching (no
  kill, no resume, no lost turn) and is torn down at turn end by the server via a `Stop` hook →
  `/api/turn-idle`; a chat run stays warm for send-keys follow-ups. `attachableUnattended` and
  `residentChat` flip to true, giving Codex parity with Claude Code on every capability except pinned
  session ids, native skills/sub-agents, the status line and permission mode.
- **Hook trust is pre-seeded**, which is what made the above possible. Codex refuses to run a hook whose
  hash it hasn't recorded as trusted, and `--dangerously-bypass-hook-trust` is ignored in TUI mode
  (openai/codex#24093) — so the TUI previously ran with no gate at all and Codex was locked to
  `codex exec`. The launcher now computes the hash itself and writes it into `config.toml`
  (`[hooks.state."<hooks.json>:<event>:<i>:<j>"] trusted_hash`). Algorithm, from the Codex sources and
  verified against hashes Codex itself wrote: identity → **TOML→JSON** → **recursively sorted keys** →
  compact JSON → sha256. The traps: it is TOML→JSON and not JSON; the serde name is `timeout` (default
  **600**, baked in even when absent from `hooks.json`); and `matcher` is part of the identity for
  `PreToolUse` but **dropped for `Stop`**.
- **Pane guard (`TerminalManager.guardHookTrust`).** The trust hash is derived from Codex internals, so a
  future release could stale it. That fails *loudly* — the TUI blocks on "Hooks need review" rather than
  skipping the hook — but a human could still answer it with *"continue without trusting"* and get an
  ungoverned agent. The existing 60s liveness sweep now captures the pane of every live Codex session and
  stops any that shows that prompt, with a card naming the cause. Verified by pre-seeding a deliberately
  stale hash. Codex-only; one `capture-pane` per live Codex session per sweep.

## [0.281.0] — 2026-07-31
### Changed
- **Cockpit `ask` tier now works with no LLM key — deterministic lookups + an ephemeral concierge run,
  not a bolt-on API.** The `ask` path previously needed a separately-configured `router_config.llm`
  (which the deployment doesn't have), so it was inert. Rebuilt in two bands that use what the workspace
  already has:
  - **Band 1 — structured lookups answered from live state**, instant, no LLM/session/key: "which agents
    are idle?", "what's running?", "how many open tasks?", "list my automations", "what agents do I have?"
    (`src/edge/ask.ts` `answerFromState`, deterministic over `tm.listSessions`/`os.tasks.counts`/
    `autos.list`).
  - **Band 2 — freeform** ("how do automations work?", "why did X fail?"): a fast direct LLM **if one is
    configured**, else a governed **ephemeral concierge run** — the native LLM in Agent OS is a claude
    session, so a new System agent (`src/edge/concierge.ts`, `concierge`) answers using the OS tools
    (`kb_search`/`recall`/`session_history`/…), run-as the asker; Cockpit polls its transcript and renders
    the reply inline, so it still feels session-free. No API key required.
  Also: the agent **router now excludes `category:'System'` agents** (concierge/consolidator/strategist/…)
  — you can never be routed to the machinery for work. `POST /api/router/preview` returns `source`
  (`state`/`llm`/`concierge`) and, for a concierge answer, `run.sessionId` to poll. `src/edge/ask.ts` +
  `src/edge/concierge.ts` (new), `src/edge/router.ts`, `src/server.ts`, `web/src/App.tsx`,
  `web/src/lib/api.ts`.

## [0.280.0] — 2026-07-31
### Changed
- **The daily digest is now a synthesis, not a log grouped by author.** On a 94-session day the posted
  digest listed ~60 lines across 19 agents with no cross-agent structure, and the day's real story — one
  migration bug and one support ticket — was told nine separate times by four agents, several of the lines
  explicitly correcting each other and every one of them marked ✓. Four fixes:
  - **A blocked run no longer reads as a success.** `outcome` is whatever the agent passed to `report()` —
    its grade of its own *effort* — so runs ended `success` while their summary said "push is BLOCKED: no
    token can push". Lines whose own text says a person must act are reclassified `⏳ blocked` and hoisted
    into a new **"⏳ Needs you"** section at the top of the digest — the only part of it that is a to-do
    rather than a record.
  - **Cross-agent threads collapse.** Lines sharing a ticket / PR / task id / host (`refsOf` →
    `clusterIncidents`, transitive union over typed refs) are grouped across agents into a **"🔗 Threads"**
    section showing the *latest* word on each, plus the update count so revision stays visible. Blocked
    lines still link a thread together but never headline it.
  - **The header reconciles.** `tally()` omitted the `other` bucket, so a 94-session day printed 76. Every
    bucket now prints, the day's **cost** is shown, and the count of sessions with no reportable line is
    stated ("N routine runs not shown") instead of silently dropped.
  - **A line must come from a real `report`.** `status === 'done'` and a salient episode were two other ways
    in, but with no report the only available text is the session title — derived from the incoming task —
    so those lines printed the human's *prompt* as if it were the day's result ("the backend is too slow",
    "can you check why this happened?"). They now land in the stated hidden count.
  Also: digest lines clip at 280 chars rather than 200, which was cutting mid-outcome.
- **Self-learning: topic extraction now allows by shape instead of blocking by word.** The guidance line
  injected into every agent's prompt read "The fleet frequently works on: globex, handed, client-app,
  read-only, really" — a hand-maintained stop-list is unwinnable, and each leaked word had to be found in
  production and patched in. Tokenization now preserves case and admits a topic only if the corpus writes it
  as a name (capitalized away from a sentence start, or ALL-CAPS) or it carries a digit or a dot. Agent ids
  join member names as stop-words (who did the work, not what the fleet works on).
- **Self-learning: approval friction is gated on the rejection RATE, not the raw count.** "≥3 rejections"
  fired on tenants whose approvals are ~100% approved — 3 rejections out of 200 is a healthy gate — telling
  the owner their policy over-rejects and telling every agent to expect rejection. Both the guidance line and
  the `policy.review` recommendation now need the count **and** ≥20% of human approval decisions; the
  recommendation states the rate. The per-pass tally records the approved denominator.

## [0.278.2] — 2026-07-30
### Changed
- **New agents now default to the `opus` model alias instead of a pinned `claude-opus-4-8`.** The sample
  manifest (`agent-os init`), the console's create-agent form default + placeholder, and the import doc
  example all baked in `claude-opus-4-8`, so every agent created since pinned that exact version and would
  not follow a newer Opus. Default to the `opus` alias, which tracks the latest Opus. Existing agents are
  unaffected (their manifests keep whatever they pinned); this only changes the default for *newly* created
  agents. A specific version can still be typed in explicitly, and the model dropdown still suggests pinned
  version ids for anyone who wants to pin.

## [0.278.1] — 2026-07-28
### Fixed
- **A `token` rotation account was silently ignored — never selected, its token never injected.** The
  row→object mapper (`toAccount`) only special-cased `apikey` and collapsed every other kind, including the
  new `token`, to `oauth`. So at launch `applyRuntimeAccount` took the oauth branch, found no `configDir`,
  and early-returned — no `CLAUDE_CODE_OAUTH_TOKEN` injected, no `runtime.account.selected` audit, the row's
  `runtime_account` left blank (the session just ran on the box default). Map `token` through correctly.

## [0.278.0] — 2026-07-28
### Added
- **Connect a Claude account by pasting a subscription token — no CLI wrangling on the box.** The rotation
  pool gains a **token** account kind: run `claude setup-token` on your own computer (the browser
  authorization completes there via the CLI's localhost loopback — no code to copy back), paste the printed
  ~1-year token into Settings → Runtime → Runtime accounts, and it's sealed in the vault and injected as
  `CLAUDE_CODE_OAUTH_TOKEN` at launch. This is the cleanest rotation credential — no `CLAUDE_CONFIG_DIR` to
  build, works identically on local and remote boxes (the box never needs a browser or a reachable
  callback), and the token value never touches the account row, audit, or logs. Runtimes declare an optional
  `tokenVar` in `CodingRuntimeSpec.credentialEnv`; a runtime without one (codex, no OAuth-token env) simply
  doesn't offer the option and stays dir/key-based. NB: Claude Code's OAuth redirect URI is hardcoded to
  localhost loopback and not configurable, and it has no device-code flow, so a server-driven in-browser
  "connect" that redirects back to the console isn't possible — pasting the token is the robust path.

## [0.276.1] — 2026-07-28
### Fixed
- **OAuth-backed MCP connectors could never work under Codex.** Codex keeps remote-MCP OAuth tokens in
  `$CODEX_HOME/mcp_oauth.age`, and Agent OS points `$CODEX_HOME` at a throwaway per-session dir — so every
  run started with an empty store, the server answered 401, and rmcp logged
  `AuthRequired … token is null or empty` into the pane while that connector's tools silently went
  missing. Same shape as the `auth.json` bug in 0.272.2, and equally invisible: the run still succeeds,
  just without those tools. The launcher now symlinks the OAuth store back to the real `$CODEX_HOME`
  alongside `auth.json`, and makes the link even when the target doesn't exist yet — writing through a
  dangling symlink creates the real file, so a `codex mcp login` lands in the shared home instead of
  being discarded with the session. Surfaced by a live DataForSEO connector that works under Claude Code
  (which has its own persisted OAuth store) but 401'd under Codex.

## [0.277.0] — 2026-07-28
### Added
- **Settings → Runtime → "Runtime accounts" panel.** The per-runtime credential pool (v0.276.0's
  launch-time rotation) is now manageable in the console, owner-only: a table of accounts per runtime
  (name, credential, `available` / `limited · resets …`, last used) with add / enable-disable / remove,
  driven by `/api/runtime-accounts`. An empty pool shows an explicit "inert — box default" state, and the
  add-form adapts its credential field to the chosen runtime's env vars and account kind (subscription dir
  vs vault key ref). The **no-progress reaper** knob (`unattendedNoProgressMinutes`) also gets a field
  alongside the concurrency / idle / max-runtime controls.

## [0.276.0] — 2026-07-28
### Added
- **File-write guard — closes a fleet-wide hole where agents could write anywhere.** `default@v3` ships
  **no `file.write` rules at all** and defaults to allow, so every agent on every runtime (Claude
  included) could write to `~/.ssh`, the workspace DB, or another tenant's data with no gate. Adding a
  JSON rule wouldn't have fixed it — a tenant with a persisted policy override never picks up new
  `default.policy.json` rules — so this is applied by the ENGINE and folded in with `stricterDecision`,
  like host governance and the semantic guard, reaching every tenant regardless of its stored policy.
  Two tiers:
  - **Crown-jewel paths → denied, always on, no switch.** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude`
    (+ `~/.claude.json`), `~/.codex`, `~/.config/gcloud`, `<home>/agent-os.db*`, `connectors/`,
    `control/`, `tenants/`, `secret.key`. Credential and control-plane tampering with no legitimate
    workflow, so there is nothing to bake and nothing to break. (The Claude launcher already blocked
    *reads* of these via `permissions.deny`; the write side was uncovered.)
  - **Any other write outside the agent's own folder → ask, OFF by default** behind a new
    Settings → Governance toggle (owner-only). Agents legitimately write to cloned repos and scratch
    dirs, so this can create real approvals; the `outsideWorkdir` fact is recorded either way, so the
    audit shows what it *would* have paused before you switch it on. Same posture as the semantic guard.
  The enricher now emits a `writeTargets` fact (resolved absolute paths, including those parsed out of a
  Codex `apply_patch` envelope), so the guard can name the offending path rather than only knowing that
  a write went somewhere else. 11 new conformance cases; suite is 130/130.

## [0.276.0] — 2026-07-28
### Added
- **Per-runtime account pool + launch-time credential rotation.** A box authenticates each coding runtime
  with ONE credential set (`claude` via a Max-subscription OAuth token, `codex` via `~/.codex/auth.json`),
  and a subscription plan has a WEEKLY cap. When it's exhausted every spawned session gets a "you've hit
  your limit" refusal, does no work, and hangs — and during a limit window every cron tick spawns another
  zombie. Operators can now register more than one account **per runtime** (Settings → owner-only
  `/api/runtime-accounts`); the launcher hands each session an available account and points its credentials
  there via the runtime's own env vars — declared generically in `CodingRuntimeSpec.credentialEnv`
  (`CLAUDE_CONFIG_DIR`/`ANTHROPIC_API_KEY` for claude-code, `AOS_REAL_CODEX_HOME`/`OPENAI_API_KEY` for
  codex; a future runtime slots in by declaring its two vars, no rotation-code change). On a detected limit
  the account is parked until its reset and the next launch rotates to another; only when a runtime's whole
  pool is dry does the scheduler DEFER (retry a later tick) instead of spawning a doomed run. **Inert by
  default**: with an empty pool nothing changes — the CLI uses the box's single default account exactly as
  today.
### Fixed
- **A headless run that never started leaked for up to 24h.** A usage-limit refusal / trust-dialog hang /
  lost prompt makes an unattended run complete no turn (so no Stop beacon, `last_activity` stays NULL) and
  make no tool call — indistinguishable to the idle reaper from a mid-turn run, so it lingered until the
  24h `unattendedMaxHours` ceiling, holding a ~500MB claude process + a concurrency-cap slot the whole
  time (the globex pile-up). A new no-progress backstop reaps a headless running row past
  `unattendedNoProgressMinutes` (default 30m; Settings → Runtime) that has made zero `gate.attempt` — a
  busy long first turn fires one on its first tool, so it's never cut. 48× faster than the old ceiling.

## [0.275.0] — 2026-07-28
### Added
- **Codex transcript reader — cost, engaged time and the chat timeline now work for Codex runs**
  (`src/edge/codex-transcript.ts`). Codex sessions previously showed `cost_usd`/`activeMs`/`turns` as
  null and an empty conversation view, because the readers only understood Claude Code's JSONL. Four
  things differ and each was a trap: the rollout lives in the run's OWN `$CODEX_HOME` (not a global
  projects tree); records are `{timestamp, type, payload}` with the interesting variants nested under
  `payload.type`; **`token_count` is CUMULATIVE**, so the last one is taken rather than summed (summing
  would multiply the bill by the turn count); and `input_tokens` INCLUDES the cached portion, so uncached
  input is `input_tokens - cached_input_tokens`. `TerminalManager` gained `sessionConversation()` and an
  internal cost dispatcher, so the sweep and all three `/conversation` routes are runtime-agnostic.
  The `transcript` capability flips to true.

## [0.274.0] — 2026-07-28
### Added
- **Runtime picker on the agent config card.** An agent's runtime was manifest-only — you had to hand-edit
  `agent.json` and rescan. It's now a dropdown (owner/admin, `PUT /api/agents/:id/config` accepts
  `runtime`), which also surfaces what the chosen runtime can't do ("Codex does not support: take-over,
  warm chat, cost + timeline, skills, sub-agents — every effect is still governed by the same gate") and
  warns that a runtime change starts a new conversation.
- **Per-runtime model validation.** Agents carry a pinned `model`, so switching a Claude agent to Codex
  used to hand `claude-opus-4-8` straight to `codex --model` and break every run. `sanitizeRuntimeTuning`
  now takes the runtime and rejects a model belonging to another family (deliberately a narrow guard, not
  an allowlist — custom/newer ids still work), the console offers per-runtime model suggestions via a
  datalist and flags a foreign id inline, and switching runtimes in the picker clears a now-foreign model
  so it lands on "inherit" rather than something broken. A `permissionMode` set on a runtime that has none
  is refused too, instead of being silently stored and never applied.

## [0.273.0] — 2026-07-28
### Fixed
- **Codex sessions were running UNGOVERNED — two independent silent failures.** Found by driving a real
  Codex run on the live box and watching the audit stay empty while it executed `git status` and wrote to
  `/tmp`.
  1. **The tool→capability routing table used the wrong names.** Codex's PreToolUse actually reports
     Claude Code's exact spellings — `Bash`, `apply_patch`, `mcp__<server>__<tool>` — not the
     `shell`/`local_shell` names its internal protocol uses. The Codex-specific table keyed on `shell`
     matched nothing, so every shell command fell through the allow-by-default arm. There is now ONE
     routing table for all runtimes: a runtime whose names diverge fails loudly at the `*)` arm instead
     of silently allowing.
  2. **Hook trust.** Codex silently SKIPS a hook whose hash it hasn't recorded as trusted, and
     `--dangerously-bypass-hook-trust` is ignored in TUI mode (openai/codex#24093) — so an interactive
     Codex session ran with no PreToolUse hook at all. Every Codex run now uses `codex exec`, the one
     lane where the gate provably fires. A Codex session is therefore not attachable; an ungoverned
     interactive session would be a security hole, and we take the feature gap.
  Also removed `[features] codex_hooks = true` from the generated config — there is no such key (the
  flag is `hooks`, already stable and on), so it was silently ignored and implied hooks had been enabled.
- **Codex `apply_patch` writes were mis-classified.** Codex carries the target path inside the patch
  envelope (`*** Add File: …`) rather than a `file_path` field, so the enricher saw no path and fail-safed
  `outsideWorkdir = true` for EVERY edit — safe, but it would have paused a human approval on every file
  an agent writes. New `applyPatchTargets()` parses the `Add`/`Update`/`Delete File:` and `Move to:`
  verbs, so in-folder edits pass and an escape (absolute path, `..`, or a move out of the workdir) is
  still caught.

### Changed
- Codex capabilities corrected now that the gate is proven: `fileWriteGate` and `mcpGate` are **true**
  (PreToolUse covers `apply_patch` and `mcp__*`), making the OS sandbox defence in depth rather than the
  only line. `attachableUnattended`/`residentChat` stay false, now for the hook-trust reason above.

## [0.272.2] — 2026-07-28
### Fixed
- **A Codex session with no credentials dropped into an interactive login menu inside the agent pane.**
  Codex's fallback when it finds no auth is a "Sign in with ChatGPT" picker that waits on a keypress —
  harmful in both lanes. Unattended, nobody is there to answer, so the run parked forever (the same
  permanent-hang class as the Claude lane's folder-trust dialog). Interactive, a human COULD complete it,
  but `codex login` writes `auth.json` into whatever `$CODEX_HOME` is current — here the **per-session**
  dir — so the credential was discarded with the session's files and the next run prompted again, making
  it look like the login "didn't take". The launcher now **pre-flights auth and fails closed** with the
  fix spelled out (`codex login` once, from a normal shell), exiting non-zero on an unattended run so
  tmux drops the pane and the pile-up guard releases, and holding the pane — never dropping to an
  ungoverned shell — on an interactive one. An injected `OPENAI_API_KEY` satisfies the check too
  (API-key mode needs no `auth.json`).

## [0.272.1] — 2026-07-28
### Fixed
- **Codex sessions stored a meaningless transcript id, breaking resume/fork.** `createSession` (and
  `forkSession`) unconditionally pre-filled `claude_session_id` with a fresh `randomUUID()` — correct for
  Claude Code, which PINS that id via `--session-id`, but wrong for Codex, which mints its own rollout
  UUID. Because `recordRuntimeSessionId` is first-write-wins, the pre-filled random id then **rejected the
  real id the launcher reported**, so the column held a UUID matching no transcript and a later
  `codex exec resume <id>` / `codex fork <id>` would silently fall back to a fresh conversation. The id is
  now only minted for a runtime with the `pinnedSessionId` capability; Codex leaves it NULL so the
  launcher's report is the first write. Caught on the live box on the first real Codex run (stored
  `712b2de7-…` vs the actual rollout `019fa7a4-…`).

## [0.272.0] — 2026-07-28
### Added
- **A second coding runtime: OpenAI Codex.** An agent manifest can now declare `"runtime": "codex"`
  alongside `claude-code` and `mock`, and it launches as a real, governed `codex` session in the agent's
  folder (`terminal/codex-launch.sh`). The gateway invariant is unchanged, but the *mechanism* differs
  because Codex's PreToolUse hook doesn't reliably cover file writes and MCP calls: shell (and therefore
  all `curl`/`git`/`npm` egress) goes through the SAME `terminal/gate-hook.sh` → `/api/gate`; writes are
  contained structurally by the OS sandbox (`sandbox_mode = workspace-write`, `writable_roots` = the
  agent folder); MCP/connector calls stay governed server-side at the loopback API; and
  `approval_policy = "never"` makes Agent OS the sole authority (the mirror of
  `--dangerously-skip-permissions`). The launcher generates a per-session `$CODEX_HOME` holding a fresh
  `config.toml` (model/effort, sandbox, MCP servers translated to Codex's TOML schema incl. Composio's
  `http_headers`, and a `trust_level = "trusted"` seed for the agent folder), a `hooks.json` wiring the
  gate, and an `AGENTS.md` composed from the agent persona + Company context (Codex has no
  `--append-system-prompt-file`). See `docs/codex-runtime.md`.
- **Runtime capability matrix.** `CODING_RUNTIMES` / `RuntimeCapabilities` / `runtimeSupports()` /
  `isCodingRuntime()` in `src/types.ts` declare what each CLI actually supports (pinned session ids,
  resume, fork, attachable-unattended, resident chat, transcript parsing, native skills/sub-agents,
  status line, permission mode, file-write & MCP gating, allow-time steering). The ~20 scattered
  `runtime === 'claude-code'` checks — which had quietly become the shorthand for "is this a real agent"
  — now probe a named capability or `isCodingRuntime()`, so a Codex agent is first-class where it is
  supported and cleanly refused (with a reason) where it is not.
- `POST /api/runtime-session` — session-secret-gated loopback route for a runtime that mints its OWN
  transcript id. Codex has no `--session-id` to pin, so the launcher discovers the rollout UUID from its
  per-session `$CODEX_HOME` and reports it back; first write wins, so a resume can't re-point an existing
  conversation at a different transcript.

### Fixed
- **Shell commands sent as an argv array were classified against an empty string.** The enricher (and the
  briefer) only accepted a `command` of type `string` — Claude Code's `Bash` shape. Codex's `shell` tool
  sends `["bash","-lc","…"]`, so `typeof` fell through to `''`: no destructive/risky pattern could ever
  match and the gate **allowed `rm -rf /`**. `commandText()` in `src/governance/enricher.ts` now
  normalises both shapes (and any future runtime that sends argv arrays); approval cards no longer render
  an empty command either. Found by the Codex gate smoke test.
- An unknown `runtime` string in a manifest (a typo, or a manifest from a newer build) used to fail
  silently — every capability check returned false and the agent quietly ran the scripted mock runner.
  `registerAgent` now warns once, naming the known runtimes.
## [0.271.1] — 2026-07-28
### Fixed
- **Explicit `/agent` overrides thread continuity when it names a different agent.** In a chat "thread"
  already bound to a session, a follow-up that explicitly addresses a *different* known agent
  (`/infra-ops …` on a task previously handled by `/migration-ops`) was being delivered into the bound
  session instead of spawning the named agent — so the wrong agent replied. This bit ClickUp hardest,
  where a task's comment section is a **shared** space and two agents are routinely addressed on the same
  task. Continuity now declines when the follow-up redirects to another agent, and the caller spawns it
  fresh; a plain follow-up (no prefix, the same agent, or a non-agent slash) still continues as before.
  Applied consistently across ClickUp, Slack, and Discord continuity.

## [0.271.0] — 2026-07-27
### Added
- **Agent-driven Composio connection requests — default to personal (`connection_request`).** An agent
  that needs a Composio app it isn't connected to can now ask for it through the governed spine (the
  connection twin of `secret_request`): it carries only the toolkit slug + reason + scope, never a
  credential — a human finishes the browser OAuth. **Scope defaults to `personal`** (connected under the
  human the run acts as, for their own account); `company` is a shared connection every agent can use, and
  the tool steers the agent to reserve it for genuine org-wide resources. Personal requests are addressed
  to (and completed by) the run's own member — only they can OAuth their own account — while company
  requests go to the owner/admin tier. The console surfaces open requests on the **Connections** page
  (admins see all; a member sees their own personal ones), where **Connect** opens the hosted OAuth link.
  Short-circuits when the app is already connected or an identical request is open; audited
  `connection.requested` / `connection.request.fulfilled` / `connection.request.dismissed`. New loopback
  route `POST /api/agent/connection/request` + console `GET/POST /api/connections/requests[...]`. Plan:
  `docs/composio-connection-request-plan.md`. (`postReviewCard` gained an optional `audience` so a review
  card can target a specific member, not only the admin tier.)

## [0.270.0] — 2026-07-27
### Added
- **Goal planning: a "steer the plan" step before the strategist runs.** "Plan this goal" now opens a
  short pre-plan form instead of spawning immediately — the requester can add free-text **guidance**
  (focus areas, constraints, which specialists to prefer) and a **max tasks** cap. Both optional; blank
  = plan with no constraints. The steering is injected into the strategist's opening prompt as a binding
  constraint (`POST /api/goals/:id/plan` now takes `{ guidance?, maxTasks? }`), audited via
  `goal.planned { steered }`.

## [0.269.1] — 2026-07-27
### Changed
- **Descriptive titles for delegation poke-back sessions.** When a delegate finishes a `poke_on_done`
  hand-off and the caller agent has already exited, the resume-path session that wakes the caller now
  gets a human-readable title — `Poke ← <delegate> done: <task title>` (or `blocked`, task title
  truncated at 48 chars) — instead of the opaque `Poke ← <task-id>`. Provenance (`poke:<id>`) and the
  `agent.poked` audit `source` field are unchanged; only the console-facing title improved.

## [0.269.0] — 2026-07-27
### Added
- **Semantic guard (Tier 1) — prompt-injection / secret-exfiltration screening.** A new pure, synchronous
  classifier (`src/governance/semantic-guard.ts`) that sits beside the enricher: it sets one boolean fact,
  `injectionSuspect`, when a shell/connector action carries a **clear-cut** exfiltration or injection shape
  — a `.env`/`id_rsa`/`*.credentials` read (or `printenv`) piped to an outbound transfer (`curl`/`nc`/`scp`…),
  or a remote script piped straight into a shell (`curl … | bash`). Softer signals ("ignore all previous
  instructions", base64-decode-to-shell) set `injectionUncertain` — the hook for a later model-assisted pass,
  with no consumer yet. Enforcement is **engine-level** (combined into the gate decision via `stricterDecision`,
  like host governance, so it reaches every tenant regardless of a persisted policy override) and is always an
  **`ask`, never a hard block** — a heuristic false positive must be recoverable by a human; the `never` tier
  (a destructive exfil) still wins and stays denied. Screens the **raw** command (payloads intact, unlike
  `sanitizeForIntent`) and **skips `file.write`** (a file whose content mentions `curl … | bash` is not an
  exfil the agent is performing). New **Settings → Governance → Semantic guard** toggle, **OFF by default**
  (owner-only): the fact is computed always but inert until enabled, so the patterns bake against the audit
  trail before they start pausing work. 7 new governance-conformance cases (119/119). See
  `docs/semantic-guard-plan.md`. Origin: a comparative analysis of Prismor (which we are *not* adopting — its
  one idea worth having, the hybrid heuristic→LLM guard, re-implemented natively).

## [0.268.1] — 2026-07-27
### Fixed
- **Generated media now reliably lands in the Library instead of the scratchpad.** Agents (esp. via the
  `dataviz`/`artifact-design` skills) were rendering charts/images/PDFs into the Claude Code harness
  scratchpad (`/private/tmp/.../scratchpad/`), following the harness's emphatic "put ALL temporary files
  in the scratchpad" instruction. Those files sit **outside** the agent's working folder, so
  `publishArtifact` (which resolves paths strictly under `manifest.dir`) can't reach them — the media
  never reaches the Library and is deleted when the session ends. Strengthened the launch operating-notes
  guidance (`AGENT_OS_OPERATING_NOTES` in `src/terminal.ts`) to explicitly override the harness rule: throwaway
  intermediates → scratchpad, but any deliverable a human should see → the working folder, then `publish`.

## [0.268.0] — 2026-07-27
### Added
- **Auto-approval list — "always approve THIS action", by decision-brief signature.** The old "Always"
  button on an approval card added a capability-wide `allow` policy rule (allowing *all* `connector.connect`
  / `net.connect` — far too broad). It now adds the approval's **brief signature**
  (`capability|verb|targetKind|key`) to a dedicated **auto-approval list**, so it silences exactly one
  recurring action shape (e.g. "Reach 198.51.100.42", "Grant Composio initiate connection") and nothing
  broader. At gate time a pending `approve` whose signature is listed clears automatically (audited
  `approval.auto_approved` via `auto-approve-list`) — no card, no notification. **Safety:** the list is
  only ever consulted for an `approve`; a `deny` (never-tier: destructive / over-cap / prod-build) is a
  different decision the list never sees, so it stays blocked (verified end-to-end). New
  **Settings → Governance → Auto-approvals** panel shows the full, legible registry — what each rule
  auto-approves (human label + raw signature), who added it, an example, and how many times it has fired —
  with one-click **Revoke** (owner). New `src/state/auto-approvals.ts` (`AutoApprovalStore` + `auto_approvals`
  table), `describeBrief()` in the briefer, and `GET`/`DELETE /api/auto-approvals`. Owner-only to add/revoke.

## [0.267.0] — 2026-07-27
### Added
- **Automations can run as a member, so a scheduled/headless run reaches that person's personal Composio
  apps (e.g. their Gmail) — and the agent that proposes an automation now knows it.** A fired automation
  defaults to the *company* identity, which sees only the shared company Composio + org/shared connectors,
  never one person's personal connections; the fix isn't new mechanism (the console form already had a
  "Run as" selector) but closing the discoverability gap that hid it:
  - `automation_propose` (the agent-facing MCP tool) gains a `runAs` field and its description now spells
    out the identity→connector rule — an agent proposing e.g. a daily Gmail triage suggests the member to
    act as (by id or email, resolved at propose time) instead of silently landing a company-identity run
    with no Gmail. `proposeAutomation` validates the member and surfaces *whose* credentials will be used
    in the proposal preview.
  - The **Inbox → Proposed-by-agents** approval card gains a **Run as** picker, so the approving owner/admin
    confirms or changes the identity at approval time (`POST /api/automations/proposals/:id/approve` accepts
    an optional validated `runAs` override); the automations form's "Run as" help now names Gmail and states
    it's the only way an unattended run reaches a personal app.
### Fixed
- **Fresh-DB boot crash (`no such column: archived_at`) — broke new-tenant provisioning and every
  scratch-home test harness.** The hot-path `idx_sessions_live` index is built on
  `term_sessions(archived_at, …)`, but that column's `addColumn` runs LATER in the same migration pass,
  so on a brand-new database the index create ran before the column existed and threw at `openDb`.
  Existing DBs already had the column, so it only bit fresh ones. The column is now ensured (idempotently)
  immediately before the index block.

## [0.266.2] — 2026-07-27
### Fixed
- **Two approval-noise fixes: benign `MANAGE_CONNECTIONS` reads no longer owner-gated, and the Slack/Discord
  approval DM now leads with the decision-brief headline.** A fleet review found approval notifications were
  dominated by false positives that were always approved: (1) the gate routed any Composio
  `*MANAGE_CONNECTION*` tool to the owner-approval `connector.connect`, but in practice agents call
  `COMPOSIO_MANAGE_CONNECTIONS` to LIST/check connection status (`{toolkits:["gmail"]}`) — a benign read
  (26 such approvals across the fleet in 14 days, 0 rejected). The gate-hook now routes only
  `*INITIATE_CONNECTION*` (the actual OAuth grant) to `connector.connect`; `MANAGE_CONNECTIONS` falls
  through to `connector.call` (allowed). (2) The out-of-band approval DM said only
  `` `shell.exec` (owner) … why: shell.exec: risky `` — the raw capability + terse rule. It now leads with
  the **decision-brief headline** (e.g. "Deploy the marketing site to production via the deploy script"),
  with the capability/reason as secondary detail (falls back to the old line when no brief is present).

## [0.266.1] — 2026-07-25
### Fixed
- **Resuming a resident chat session (Slack/Discord/`/agent`) from the web no longer replays the trigger
  message, nor gets reaped seconds later.** When the browser reattaches to a stopped resident session,
  `attach.sh` resurrects it via `RESUME=1 ENV_FILE=…`, sourcing the persisted env — which carries the
  *original* launch `TASK` (e.g. the Discord message that started it). The unattended/resident resume branch
  re-seeded that `$TASK` on `claude --resume`, so the resumed pane replayed the first prompt. Fixed: the
  launcher now marks an env-file resurrect (`RESUMED_FROM_ENV`) and skips re-seeding the original task on the
  primary resume (the fallback still seeds so a lost transcript gets a prompt); a genuine server-driven
  follow-up (`reviveResident`/`chatSend`) spawns a fresh pane with no env file, so its new message is still
  seeded. Second bug on the same path: `markResumed` refreshed only `updated_at`, leaving `last_activity`
  stale, so the resurrected resident session tripped the 30-min resident idle reaper on the very next 60 s
  sweep and was killed "shortly after resumption" — it now refreshes `last_activity` too, giving a
  deliberately re-opened session a fresh idle window.

## [0.266.0] — 2026-07-24
### Added
- **Hard max-runtime backstop for headless/unattended runs — the stuck-mid-turn session leak.** An
  automation/task/chat run is an attachable interactive TUI torn down at turn-end by the Stop beacon; if it
  hangs mid-turn it never beacons, so `last_activity` stays NULL and the idle-straggler sweep (which requires
  a beacon) never touches it, and the idle-interactive janitor skips it (headless). Such a run lingered for
  **days** holding a ~500 MB `claude` process + a concurrency-cap slot — observed on globex as unattended
  runs stuck at 60 h+, a primary driver of the box's memory pressure. New sweep reaps a headless run purely on
  wall-clock age once it exceeds the ceiling (**Settings → Runtime → "Force-close headless runs after"**,
  default **24 h**, `0` = off; clamped 1 h–30 d), regardless of the beacon — cancelling any dangling
  question/approval and staying Resumable. Guards preserved: never reaps a pane a human is attached to, and
  **headed (interactive member) sessions are never cut mid-work** — they keep the separate idle-based janitor,
  which only closes a *detached* one. Audited `session.reaped` `reason:'max-runtime'`.

## [0.265.3] — 2026-07-24
### Fixed
- **Inbox/session polling no longer degrades on data-heavy tenants.** The console polls `/api/messages`
  (`listMessages`) and `/api/sessions` (`listSessions`) every 1.5s per open tab, and `node:sqlite` is
  synchronous — a slow query on either blocks the entire server event loop, which surfaced as laggy
  approval/inbox notifications (and contributed to the server feeling unresponsive) on tenants with a large
  history. Added hot-path indexes matching each poll's `WHERE` + `ORDER BY`
  (`messages(dismissed_at, created_at)`, `term_sessions(archived_at, created_at)`,
  `audit_events(run_id, type, ts)` for the per-session insight tallies), so each poll is now an indexed
  range scan instead of a full-table scan + sort. Also bounded the inbox feed query to the newest 500
  non-dismissed cards (owner/admin see all, `mine` narrows further) so a pathological undismissed backlog
  can't grow the per-poll cost without limit. Indexes apply to existing DBs on next boot.

## [0.265.2] — 2026-07-24
### Fixed
- **The `consolidator` (memory gardener) crashed at launch on every tenant — and so could any run with a
  large task prompt.** `LocalSessionBackend` puts every launch env var on the `tmux new-session` command
  line, and tmux hard-caps that command at ~16KB (`command too long`). The consolidator embeds up to 40
  recent episodes/lessons in its task (18–46KB), which — base64'd into `TASK_B64` — overflowed the cap, so
  `new-session` failed **silently**: no pane, no transcript, no `.log`, and the liveness sweep then flipped
  the never-launched row to `crashed` (~11s in, `turns=null`). Only the single small-task run ever
  succeeded. The task now rides as a **file** (`TASK_FILE`, like `mcp.json`/`company.md` already do) instead
  of a giant env var, keeping the command line tiny regardless of task size; `claude-launch.sh` reads
  `TASK_FILE` (falling back to `TASK_B64` for pre-existing resume envs). Fixes the consolidation half of the
  self-learning loop and any chat/automation run whose prompt exceeded ~10KB.

## [0.265.1] — 2026-07-24
### Fixed
- **Task room sidebar no longer overlaps/cramps its Status/Assignee/Goal/Criteria controls.** Select
  triggers were `w-fit`/`whitespace-nowrap` (long goal titles / agent names blew out the control), and a
  viewport-based `sm:grid-cols-2` forced two selects into the ~320px sidebar. Triggers are now
  `w-full`/`min-w-0` (the value line-clamps) and the narrow room sidebar stacks fields single-column (the
  wider inline/Focus panel keeps two columns).

## [0.265.0] — 2026-07-24
### Changed
- **@mentioning a non-owner agent now asks first (quick answer vs. new session).** Pulling in an agent that
  isn't already working the task no longer silently spawns a session. Instead the Discussion shows a choice:
  - **Quick answer** — an ephemeral, out-of-band delegate (`ask:<taskId>`, headless, *not* bound to the
    task) reads the task + discussion and posts a concise answer via `task_say`, then exits.
  - **New session** — starts the governed session on the task (the previous behaviour).
  Mentioning the agent that's *already* on the task still just continues its own session.
- **A human's plain reply answers a pending question on the task's live session.** When an agent asked a
  question (`ask_human`) and its session is live on the task, a human reply in the Discussion is fed to the
  agent as the answer — replies only feed the session when a question is actually open.

## [0.264.4] — 2026-07-24
### Added
- **@mention autocomplete in the task Discussion composer.** Typing `@` opens a suggestion menu
  **grouped by type** (Agents, People) and **ranked by name**, filtered as you type. Arrow keys navigate,
  Enter/Tab or click inserts the handle (an agent id, or the member's email local-part — which the server
  resolves), Esc closes.

## [0.264.3] — 2026-07-24
### Fixed
- **Enricher: `rm -rf` inside the agent's OWN workdir (via an absolute path) is no longer hard-denied.**
  A post-deploy fleet scan surfaced a residual false positive: an agent cleaning up a dir inside its own
  home by absolute path — `rm -rf /home/<u>/…/agents/<a>/work/client-app/broken` — was still `destructive`,
  because the v0.260 path-safety only whitelisted `/tmp` + relative paths, not the agent's own workdir
  subtree. `isSafeDeletePath` now treats a strict SUBPATH of the workdir as safe (mirrors the
  `outsideWorkdir` fact used for file writes). The workdir ROOT itself, a SIBLING agent's home, a `..`
  escape, and any unrelated absolute/system path all stay denied — verified. 4 new golden cases (102/102).

## [0.264.2] — 2026-07-24
### Changed
- **Task room tabs are deep-linked in the URL.** The hash detail becomes `<taskId>/<tab>`
  (`discussion` | `description` | `session`), so refreshing or sharing a task URL lands on the right tab.
  The tabs are real links and the active tab derives from the URL (a `/session` link on a task with no
  session falls back to Discussion).

## [0.264.1] — 2026-07-24
### Fixed
- **The embedded Session terminal now fills the Session tab.** `TerminalFrame` is `flex-1`/`min-h-0` and
  needs a flex-column parent with height; the room's Session-tab wrapper was a plain block, so the pane
  collapsed to almost nothing. Wrapped it in `flex h-full flex-col`.

## [0.264.0] — 2026-07-24
### Added
- **Private (owner-only) agents — a tier below the owner+admin default.** Until now the tightest an
  agent could be shared was the empty-assignment floor: owners **and** admins. `AgentAccess` gains an
  `ownerOnly` flag so an owner can restrict an agent to the **owner role only** — admins are excluded and
  the role/member grants are void (`canRun` returns true iff `role === 'owner'`). Owner-settable only: an
  admin's assignment write preserves the flag but can't toggle it, and a private agent is filtered out of
  the admin's `/api/team` agent + assignment lists entirely (invisible, not just un-runnable). Surfaced in
  the Share dialog as a "Private — owners only" switch (shown to owners), which disables the All-members /
  per-member controls while on. New `assignments.owner_only` column (idempotent migration; existing rows
  default to the unchanged owner+admin floor).
### Fixed
- **Enricher: two more content-vs-intent false positives (`gh api -f body=` PR bodies, `grep`/`echo`
  trigger words).** A live docs-bot session was still hard-denied post-v0.260 because `sanitizeForIntent`
  missed two data forms: (1) `gh api … -f body="…" -f title="…"` — the `-f key=value` PR-body form (only
  `--body`/`-m`/`--title` flags were stripped), so a docs PR mentioning `npm run build`/`app.globex.io`
  in its body still tripped `prodBuild`; and (2) `grep -E "…reboot…systemctl…"` / `echo "…rm -rf…"` — a
  search pattern or echoed note *containing* a trigger word tripped `serverReboot`/`destructive` (the
  agent was literally grepping the governance source to see why it was blocked, and the grep tripped the
  gate). `sanitizeForIntent` now also strips `-f`/`-F`/`--field`/`--raw-field key=value` values and blanks
  quoted strings on lines whose command is `echo`/`printf`/`grep`/`rg`/… — while deliberately leaving
  string-executing lines (`sh -c`, `eval`, `xargs`) intact so a real op is never hidden. Stripping only
  ever removes DATA: a real `rm -rf /etc` on such a line stays destructive (verified). 8 new golden cases.

## [0.263.5] — 2026-07-24
### Changed
- **Task room: tabs + a Slack-style pinned composer + an in-place Session tab.** The room's main column now
  has **Discussion / Description / Session** tabs — the description no longer sits above the chat eating
  vertical space. The Discussion is Slack-style: the message list scrolls and the **composer stays pinned to
  the bottom** (with autoscroll), so you can always send. The **Session tab embeds the live terminal**
  in-place, so you work a task's run without opening a separate Sessions tab. The right-hand detail sidebar
  is de-cluttered: the redundant Activity list is gone (the Discussion already shows state events inline),
  along with the now-duplicate live-attach / View-session buttons.

## [0.263.4] — 2026-07-24
### Added
- **Per-agent `chatReachable` flag — control which agents the open chat router can reach.** By default any
  claude-code agent is addressable via `/agent-os <id>` / `/<id>` on Slack, Discord, or a ClickUp task
  comment. A new **Reachable from chat** toggle (Agent → config, owner/admin) sets `chatReachable:false` to
  keep an agent OFF that open front door — excluded from `routeChat` + the help list, so a comment can't
  invoke it; a `/<id>` for it replies "isn't reachable from chat". It stays runnable from the console,
  tasks, delegation, and explicitly-configured automations. Use for supervisor/ops personas (e.g. a `ceo`
  triage agent) you don't want spawned from a shared thread.
### Changed
- **Task room renders inside the content area, not as a full-page overlay.** The Discussion room now
  replaces the board *within* the main content column (the app nav/sidebar stays visible), instead of a
  fixed full-screen layer over everything.

## [0.263.3] — 2026-07-24
### Changed
- **Task room renders inside the content area, not as a full-page overlay.** The Discussion room now
  replaces the board *within* the main content column (the app nav/sidebar stays visible), instead of a
  fixed full-screen layer over everything.

## [0.263.2] — 2026-07-24
### Added
- **`/agent-os <agent>` namespace prefix for the chat router.** `/agent-os engineer fix X` (or `/agentos …`)
  now routes identically to the bare `/engineer fix X` — the `/agent-os` prefix is normalised away in
  `routeChat`/`stripChatPrefix`, so it works on every channel (Slack/Discord/ClickUp). Clearer in shared
  spaces like ClickUp task comments (a bare `/name` is ambiguous there); the bare form still works.

## [0.263.1] — 2026-07-24
### Changed
- **ClickUp: 👀 reaction instead of an "on it" comment.** When a `/agentname` comment is picked up, the
  ingress now reacts 👀 (`eyes`) on the triggering comment as the "read / processing" signal, and no
  longer posts a "🤖 On it…" ack comment (noise) — the reaction + the agent's eventual `clickup_reply`
  are enough. (Routing help / disambiguation still posts a comment, since it carries text.) New
  `addReaction()` connector fn (ClickUp reactions take an emoji SHORTCODE array, e.g. `{reactions:["eyes"]}`).
## [0.263.0] — 2026-07-24
### Changed
- **Task Discussions now match the redesign — a full-page room, not a modal panel.** Opening a task from the
  board/list shows a **full-page two-column room**: the Discussion (merged chat + state timeline, mention
  composer) as the main column, the task's state controls (status/assignee/priority/deps/dispatch/
  attachments) as a sidebar — replacing the old modal drawer. Board/list **cards gain Discussion
  affordances**: an unread badge, a last-message preview, and a participant avatar stack, backed by a new
  per-task rollup (`TaskDiscussionSummary` via `tm.taskDiscussionSummaries`, returned on `GET /api/tasks`).
  (The Focus view keeps its inline master-detail.)

## [0.262.1] — 2026-07-24
### Fixed
- **ClickUp loop-guard broke personal API tokens (agents ignored your own comments).** The guard skipped
  comments authored by the token's ClickUp user — but a ClickUp API token is usually a **personal** token,
  so the human running `/agentname` IS the token user, and their commands were silently dropped as "own
  comment". Now the ingress guards by **comment id** (the ids it has acted on or posted itself), not user
  identity: personal-token-safe, still drops our own acks/replies, and dedupes a racing duplicate webhook.

## [0.262.0] — 2026-07-24
### Added
- **Task Discussions — every task is now a threaded conversation.** A task is no longer just a card with a
  state machine: its detail is a **Discussion** where the task's humans and agents talk, hand off, and
  narrate work in place (design: `docs/task-rooms-plan.md`). Built entirely on existing machinery — no new
  store, no new trust surface:
  - A Discussion message is a `messages` row (`type='task.chat'`, new `task` **Audience**) on the
    `task:<id>` sentinel, **excluded from the Inbox feed** so the Discussion is its own quiet surface.
  - **Quiet by default; mention-based escalation** — a plain message notifies no one. `@mention` a
    teammate → an addressed Inbox card + DM; `@mention` an `agent:<id>` → that agent is **resumed on the
    task** (live/dead-but-resumable session) or spawned fresh bound to it, reusing the thread-continuity
    engine (`continueTaskThread`, sibling of `continueSlackThread`). A dispatched agent's `report`/`update`
    now narrate **into the task Discussion** instead of the owner's Inbox.
  - **`task_say`** MCP tool (post + @mention); `task_get` returns the `discussion`. Console: a full
    timeline (chat + state events interleaved) with a mention-aware composer, unread badges, and mark-read;
    routes `/api/tasks/say`, `/api/tasks/:id/messages`, `/api/tasks/:id/read`.
- **Tasks board/list polish.** Removed the colored priority/live left-edge bands from board cards (the
  priority pips already carry that signal); the List **Group by** gains a **Goal** option.

## [0.261.2] — 2026-07-24
### Changed
- **ClickUp ingress hardening (every comment hits the webhook).** A ClickUp task's comment section is a
  shared space and the Automation fires on *every* comment, so the dispatcher now **gates on `/agentname`
  first** — a plain comment is ignored, never delivered into a session bound to that task (only a
  `/command` acts, matching the old agent-orch behaviour + the bot-comment loop-guard). The task prompt
  now mirrors the jump-server orchestrator's `/ceoagent`: **fetch the full ClickUp task details first**
  (the description holds the real content — customer email/`Cx:` fields, issue details, links) before
  acting, then reply via `clickup_reply`, commenting on the existing task (no duplicate). Console + docs
  show ClickUp's real `task_id={id}` merge-field syntax (was `{{task.id}}`). Invocations surface on the
  **Sessions** page ("Chat · <agent> · as <member>") + `trigger.clickup`/`chat.routed`/`clickup.reply` in **Audit**.

## [0.261.1] — 2026-07-24
### Fixed
- **Dispatch no longer hard-rejects a `/goal` when the criteria fits but the whole prompt doesn't.**
  The `claude` CLI counts *everything* after `/goal ` as the goal condition — the acceptance criteria
  **plus** the task/ask boilerplate we append, not just the first line (per
  code.claude.com/docs/en/goal). The v0.247.1 guard measured only `criteria.length`, so a criteria well
  under 4000 chars still blew the limit once the base prompt was appended, and the run failed at launch
  with `Goal condition is limited to 4000 characters (got 4463)`. Both `/goal` emitters
  (`buildTaskPrompt` for dispatched tasks, `buildAskAgentPrompt` for `ask_agent` delegates) now gate on
  the **full emitted payload's** length and fall back to plain mode (criteria embedded in the body) when
  it won't fit — the run still knows the definition of done, it just isn't evaluator-driven.

## [0.261.0] — 2026-07-24
### Added
- **Native ClickUp ingress (comment → agent).** A ClickUp Automation ("comment posted" → `POST
  /hooks/clickup?key=…&task_id={id}`) now reaches any agent from a task comment:
  `/agent-name your request` spawns a governed session that works the task and posts its answer back as a
  comment; follow-up comments **continue the same conversation** (a `clickup_threads` task→session binding
  + `--resume`, the exact twin of `slack_threads`). This is the direct in-platform replacement for the old
  agent-orch `/ceoagent` ClickUp command — but on the mediated gateway (every effect gated/audited),
  run-as the commenter (their email → member, else company identity), and reachable fleet-wide with no
  per-agent automation. New: `src/connectors/clickup.ts` (API), `src/edge/clickup-ingress.ts` (webhook
  dispatch + reply, loop-guarded against the bot's own comments), a `clickup_reply` MCP tool (gated by
  `CLICKUP_REPLY=1` for ClickUp-triggered sessions), a `clickup` automation trigger type, and a
  **Settings → Integrations → ClickUp** card (API token + the webhook URL to paste into ClickUp).

## [0.260.0] — 2026-07-24
### Fixed
- **Enricher no longer hard-denies on payload text or scratch deletes (content-vs-intent false
  positives).** A fleet audit of globex found ~67% of hard denials were false positives with no
  recourse: (1) the `destructive` tier blocked routine `rm -rf` of `/tmp`/scratch/relative dirs (agents
  cleaning their own scratchpad, re-cloning a repo, clearing a build cache), and (2) custom guards like
  `prodBuild` fired on **documentation content** — docs-bot's `gh pr create --body "…npm run build … on
  app.globex.io"` read as an executed production build, systematically blocking its PRs. Root cause: the
  enricher matched intent signals inside DATA payloads (PR bodies, commit messages, file heredocs) and
  couldn't tell a scratch delete from a system delete. Now:
  - `rm -rf` is destructive **only** when a target is a real system/absolute path, `~`/home, a `..`
    escape, or an unresolvable variable — a `/tmp`/scratch/relative delete is allowed. Resolves inline
    `VAR=…` assignments so the `SCRATCH=/tmp/x … rm -rf "$SCRATCH"` idiom is recognised. A genuine
    `rm -rf /etc`, `~/web/public_html`, `..` escape, or unknown-var delete is **still denied**.
  - New `sanitizeForIntent()` strips message/body CLI values (`-m`/`--body`/`--title`/…) and file-sink
    heredocs (`cat`/`tee`/`>`) before intent-matching (built-in destructive/risky **and** custom
    patterns), so a PR body / commit message / heredoc'd file can't trip a guard. **Interpreter**
    heredocs (`bash <<`, `python <<`) are kept — a real destructive op inside one is still caught.
  - Credential-looking tokens (GitHub PAT/OAuth, OpenAI/Anthropic keys, Slack tokens, AWS keys, JWTs) are
    now **redacted** from the command before it is persisted to the audit trail / approval card
    (`redactSecrets`) — a hardcoded `GH_TOKEN=gho_…` inline no longer sits in cleartext in the log.
  - 15 new golden conformance cases pin both directions (false positives now allowed; real destructive /
    real prod-build still gated); the runner gained direct `expectFacts` assertions.

## [0.259.0] — 2026-07-23
### Added
- **Loop detection + the `instruct` verb (phase 3 of the decision-brief layer — the behavioural-failure
  plane).** Agent OS now watches a RUN for failure patterns across effects, not just individual effects.
  The first detector catches a **no-progress loop** — the same action repeated ≥5× in a 5-minute window.
  On a loop the gate lets the effect through but attaches an advisory **`instruct`**: an `allow` that also
  injects a note into the agent's next context (via the PreToolUse hook's `additionalContext` — the one
  channel verified to reach the model; `permissionDecisionReason` on allow is audit-only). The note is
  branded, non-coercive advisory copy ("this is about the 5× near-identical action… if you're stuck, try
  a different approach or `ask` a human") — the framing a spike showed the model heeds rather than flagging
  as prompt-injection. It's a **nudge, not a control**: the model may ignore it; anything that must stop an
  effect still routes through deny/approve. New `src/edge/reliability.ts` (`ReliabilityMonitor`,
  in-memory per session); the loop key folds digit runs so a `?v=$RANDOM` cache-buster or timestamp
  doesn't mask a real poll loop, while distinct commands never accumulate. Realised as an `allow` + a
  `GateResult.note` overlay — **not** a new policy `Decision` variant, so `classify`/the gateway are
  untouched. Audited `reliability.loop`; disable with `AOS_RELIABILITY=0`. See
  `docs/decision-brief-layer-plan.md` §8/§8a.

## [0.258.0] — 2026-07-23
### Added
- **Host-trust learning — "Trust host" on an approval card (phase 2 of the decision-brief layer).**
  The fleet study found that nearly all human-in-the-loop friction is host identification — an agent
  reaches a legitimate new host (a deploy target, `curl` to its own site, `ssh` to an infra box) and the
  gate escalates "host is not a granted connection", the owner approves, and the *same host escalates
  again next run*. Now, when the decision brief identifies a host, the owner sees a **"Trust host"**
  button (`POST /api/approvals/:id/trust-host`): it approves this attempt AND adds a durable org host
  grant (`posture: allow`, scoped to that exact host + protocol) so future reaches pass the gate without
  a card. Owner-only (it loosens the gate durably, like "always approve"); it replaces the too-broad
  "Always" button for host approvals (Always would allow the entire `net.connect`/`ssh.exec` capability —
  trust is scoped to the one host). Idempotent (already-trusted → approve once + note); the never-tier
  still binds, so `ssh box 'rm -rf /'` stays denied regardless of host trust. Verified end-to-end:
  `approve(host not granted) → allow` after trusting. Audited `host.trusted`. See
  `docs/decision-brief-layer-plan.md` §7.

## [0.257.0] — 2026-07-23
### Added
- **Decision briefs on approval cards + the audit trail (phase 1 of the unified decision-brief layer).**
  A gated effect no longer shows the raw `{tool,input}` JSON blob on its Inbox approval card. The gate now
  computes a **`DecisionBrief`** once, next to `classify()` — a human-legible account of the effect:
  a **headline** (for a shell call, Claude's own one-line command description), the **target** it acts on
  (host `198.51.100.42 (ssh)`, file `deploy.yml`, `$42.00`, `3 rows`), a humanised **why** (e.g. "The
  target host isn't on the trusted list yet" instead of "host could not be identified"), a risk badge, and
  a stable action **signature**. The console renders this as the card body (raw facts demoted to a
  collapsed "raw" disclosure); the brief also rides on the `gate.decision` / `approval.requested` audit
  rows, making the audit trail legible, and enriches the Slack/Discord approval mirror. New pure
  `src/governance/briefer.ts` (sibling of the enricher — facts in, story out; no I/O, no model call),
  wired into both the live gate (`TerminalManager.gate`) and the in-process gateway. Backward-compatible:
  cards without a brief fall back to the previous rendering. Groundwork for host-trust learning (phase 2)
  and the behavioural-failure plane (phase 3). See `docs/decision-brief-layer-plan.md`.

## [0.256.0] — 2026-07-23
### Added
- **Upcoming automations on the Overview.** The owner Overview page now surfaces an **"Upcoming"** card
  in the right rail: the scheduled automations queued to fire next (enabled crons + pending one-shots),
  soonest first, each with the agent icon, trigger summary, and a live "in 3h" / "in 2d" countdown.
  Runs firing before end-of-day are highlighted and counted ("N scheduled today"); the countdown's
  tooltip shows the exact time in the server timezone. Event-only triggers (webhook/Slack/Discord) and
  disabled crons have no next-fire time, so they naturally drop out. Reads the `nextRunAt` already
  computed per automation by `/api/automations` — presentation only, no new server surface.

## [0.255.0] — 2026-07-21
### Added
- **Take over an ENDED headless run.** "Take over" now works on a headless session that already exited
  (an automation/cron/task/chat turn that ran to `done`/`stopped`/`crashed`), not just a still-live one.
  The unified take-over (`POST /api/sessions/:id/interactive` → `TerminalManager.takeoverRun`) attaches to
  the streaming pane when the run is live, and otherwise **resurrects it in place** — `claude --resume` the
  same transcript as a claimed, non-resident interactive TUI (writes the launch env so it becomes resumable
  and reattachable from there on, marks it sticky so the reapers leave it alone). The human lands straight
  in the resumed conversation to steer it. Requires a claude-code runtime and a pinned claude session id
  (headless runs persist one via `--session-id`); a run with no conversation to resume returns a clear
  error. The console now offers "Take over" on any unattended run — live OR ended — with a state-aware
  tooltip. `web/src/App.tsx` (`canGoInteractive`/`takeOverTip`), `src/terminal.ts`, `src/server.ts`.

## [0.254.0] — 2026-07-21
### Added
- **Cockpit intent layer + Chat/Terminal launch choice (auto-router Phase 2).** Cockpit no longer always
  spawns a session — a deterministic, LLM-free classifier (`src/edge/intent.ts`) first decides *what kind*
  of ask a message is and does the right thing:
  - **work** → the auto-router picks the best-fit agent, and you choose **Chat or Terminal** to launch it
    (a remembered toggle; Terminal spawns the attachable TUI via `/api/sessions`, Chat via `/api/chat/start`
    — both run-as you, both gated). This is the "let me pick where it opens" ask.
  - **ask** (a question *about* the workspace — "which agents are idle?", "how many tasks are open?") →
    answered **inline, no session**, by an LLM constrained to a compact live-workspace context
    (`cockpitWorkspaceContext`: agents + session/task/automation counts + KB sections — the only ground it
    may answer from). Degrades gracefully to routing when no LLM is configured, with a Settings hint.
  - **action** ("schedule the churn report every morning", "create a task to…") → a safe **deep-link** into
    that primitive's surface (Automations/Tasks), or "have an agent do it" — no ungoverned auto-execution
    (that's Phase 3's governed meta-agent).
  Classification is fail-safe (default `work`; a `force:'work'` escape hatch on every ask/action result).
  New: `src/edge/intent.ts`, `src/edge/llm.ts` (shared OpenAI-compatible chat helper — the router's near-tie
  tie-break now reuses it too), extended `POST /api/router/preview` (intent + inline `answer`/`surface`),
  `web/src/App.tsx` (`CockpitPage` intents + launch toggle). Same governance throughout — the classifier
  only decides routing; every spawned effect still passes the gate hook.

## [0.253.0] — 2026-07-21
### Added
- **Cockpit — the natural-language front door in the web console (auto-router Phase 1).** A new primary
  nav tab (default-pinned): one big box where a member types what they need in plain words and the
  auto-router — the *same* inference the Slack/Discord chat front door uses (`chooseAgent`) — picks the
  best-fit agent and drops them straight into a chat with it, no agent-picker required. Fail-safe, mirrored
  in the UI: a confident match shows the **suggested** agent (with a % match + a *semantic*/*AI-picked*
  provenance hint) plus any runner-up as one-click alternatives; a near-tie shows a **"which one?"**
  shortlist; nothing-matched offers the **runnable fleet** to pick from. Picking dispatches via the
  existing `/api/chat/start` (reusing the whole Chat conversation view + governance — provenance
  `chat:<member>`, run-as the member, gate hook), so Cockpit is a thin router front-end, not a new engine.
  New read-only, member-scoped `POST /api/router/preview` (only offers agents the member `canRun`; dispatch
  re-enforces it). This is the surface the "launch agents / ask about agent-os / invoke primitives" vision
  builds on. `src/server.ts` (`/api/router/preview`), `web/src/App.tsx` (`CockpitPage`), `web/src/lib/api.ts`
  (`routerPreview` + `RouterPreviewResp`).

## [0.252.2] — 2026-07-21
### Added
- **`#/agent/<id>/edit` is now an accepted alias for the agent page.** The agent detail/editor lives at
  `#/agent/<id>`; a trailing `/edit` segment now resolves to the same page (agent ids never contain a
  slash, so it's unambiguous), so an explicit edit URL can be linked or bookmarked. `web/src/App.tsx`.

## [0.252.1] — 2026-07-21
### Fixed
- **Auto-router: semantic matching now works on any memory backend, and confident routes stop
  collapsing into "ask".** Two issues surfaced dogfooding the router over the real northwind fleet.
  (1) The embedding blend + LLM tie-break only read `memory.sqlite.embeddings`, so a tenant on the
  `automem`/`libsql` backend (whose embeddings aren't a local `Embedder`) got **keyword-only** routing —
  and terse agent descriptions (`pod-troubleshooter`: *"Checks why a pod has errored out"*) starve keyword
  matching, so real support intents ("I want a refund, I was double charged" → the billing/support agent)
  scored 0 and fell to the help list. Added a **router-owned** `router_config.embeddings` (+ the `llm`
  endpoint/key falls back to it), so semantic routing works regardless of the memory backend; verified
  end-to-end that "refund/double charged" now reaches the support agent via cosine when keyword scores 0.
  (2) Scores are now on a stable **0..1 confidence** via *smooth* saturation (`raw/(raw+K)`) instead of a
  hard clamp — the clamp pinned every strong candidate to 1.0, so two strong-but-different agents tied and
  a clear winner became a disambiguation. Decisions use a **three-band** model: a viability floor
  (`minScore`), a **route-confidence** gate (`routeConfidence`, new — a weak-but-relatively-ahead match now
  *asks* instead of silently mis-routing), and the top-vs-second **margin judged on the raw score** (where
  the true separation survives saturation). Also caches per-agent profile vectors (keyed by embedder +
  agent + profile hash), so steady-state routing is **one** embed call (the message), not one-per-agent.
  `src/edge/router.ts`, `src/types.ts` (`RouterConfig.embeddings`/`routeConfidence`).

## [0.252.0] — 2026-07-21
### Added
- **Code review policy — a first-class, fleet-wide steer for how agents review a diff/PR.** Settings →
  Company now has a dedicated **Code review policy** document (its own `code_review_md` setting +
  `PUT /api/settings/review`), injected into every claude-code agent's prompt as its own section by
  `buildCompanyMd`. Left blank, it emits a **built-in default**: prefer a cheap cross-model second
  opinion (the `glm-review` skill, named concretely only when the workspace has it installed) and
  **never** trigger a paid/cloud-billed review such as `/code-review ultra` on the agent's own
  initiative — a free local review is the default. The steer rides the prompt, so it reaches existing
  tenants immediately (no tenant re-seed). Owners can override the default with their own standard.
- **`glm-review` is now a bundled skill.** The fast cross-model (z.ai GLM) diff/PR review previously
  living only in the globex tenant ships in the software's skill catalog (`config/skills/glm-review`),
  so every tenant can one-click install it from Skills. Requires `ZAI_API_KEY` in the agent's shell
  (assign it in Settings → Secrets).

## [0.251.2] — 2026-07-21
### Fixed
- **`agent.update.proposed` inbox card now deep-links to the target agent's page, and its review card
  sits at the top of that page.** Following v0.250.0, an owner who got the "proposed an edit to X" inbox
  notification had no way to reach the review UI — clicking the card fell through to the proposer's
  session terminal, and even on the right page the "Proposed edits from other agents" card was buried
  below the tuning + CLAUDE.md editor. The inbox card now routes to `#/agent/<target>` (click and
  new-tab both), and the proposals card renders at the **top** of the agent page (mirroring the
  PolicyEditor's atop-the-editor review queue), so the deep-link lands the owner right on the pending
  approval. `web/src/App.tsx`.

## [0.251.1] — 2026-07-21
### Fixed
- **Long memories are no longer silently dropped by the automem backend.** automem hard-rejects any
  content over 2000 chars (`POST /memory → 400 "Content exceeds maximum length"`), and end-of-session
  **episodes** routinely run longer (3–9k chars) — so the store THREW and the memory was lost from BOTH
  automem AND the local mirror (the mirror only copies a record the backend *returns*). A 7-day fleet
  review found this dropping **22–46% of episodes** (globex 141/165 = 46%), starving the self-learning
  loop of its richest input. The automem provider now **truncates content to fit** (1980-char cap + a
  `… [truncated]` marker) on both `store` and `update`, and returns the fitted content so the local
  mirror matches what the backend holds. Memory is truncated-and-kept, never rejected-and-lost.
### Added
- **Automatic agent routing — a chat/ticket message reaches the right agent without anyone naming one.**
  The `/agent` chat router already made the whole fleet reachable, but only if the sender knew the agent and
  prefixed `/name`; an unaddressed message just got a help list. The new router (`src/edge/router.ts`,
  `chooseAgent`) *infers* the best-fit claude-code agent from the message itself — useful for Slack/Discord
  (and, via the same shared front door, support-ticket triage) where you want to start an agent but not pick
  one. Matching is **deterministic first** — idf-weighted token overlap over each agent's `id + description +
  examplePrompts`, so rare-to-the-fleet terms ("billing", "kubernetes") discriminate and fleet-common terms
  contribute ~0 — with two opt-in upgrades that only run when configured: an **embedding blend** (reuses the
  Settings → Memory embedder; cosine(message, agent-profile) min-max blended with the keyword score) and an
  **LLM tie-break** on a near-tie (cheap OpenAI-compatible `/chat/completions`, endpoint/key default to the
  memory embedder's). The design **fails safe**: a clear winner routes silently, a near-tie or weak match asks
  the human to **disambiguate** ("reply with a number"), and nothing-scored falls back to the classic help
  list — a wrong *silent* route is the only bad outcome and it's gated behind a score margin. Explicit `/name`
  still short-circuits inference. Disambiguation is stateful per thread (an in-memory shortlist keyed by
  channel+thread; the reply routes the **original** request to the chosen agent). Routing carries no
  privilege — it only picks an id; the spawn stays fully governed (provenance `chat:<agent>`, run-as the
  sender, gate hook). Every route is audited `chat.routed` with `routedBy` (`explicit`/`auto`/`auto-llm`/
  `auto-disambiguated`) + score + runner-up, so mis-routes are measurable. Wired into `fireSlack`/`fireDiscord`
  via a shared `routeUnmatched` handler. Config: `router_config` (JSON `RouterConfig` — `enabled`/`minScore`/
  `margin`/`llm`); `autoRouteEnabled()` defaults on, riding the `/agent` chat-router master switch.
  `src/edge/router.ts` (new), `src/edge/automations.ts`, `src/governance/settings.ts`, `src/types.ts`.

## [0.250.0] — 2026-07-21
### Added
- **Agents can now propose edits to *other* agents — gated, never applied unattended (`agent_propose_update`).**
  The self-only `agent_update` stays as-is (an agent edits its own listing/CLAUDE.md, no approval). The new
  tool is its cross-agent counterpart, kept deliberately *gated* rather than a widening of `agent_update`:
  rewriting another agent's system prompt is a side effect on a different principal (a lateral-privilege /
  prompt-injection vector), so it follows the propose-don't-apply pattern of `policy_propose` /
  `automation_propose`. The agent's call writes **nothing** — it posts an owner-addressed
  `agent.update.proposed` review card carrying the field delta + rationale. Application is **owner-only, and
  the owner must be able to run the target** (`os.team.canRun`) — an admin cannot approve. On approval the
  server runs the same apply path as the self-edit route (sanitizers + disk write + `AgentRevisions.commit`,
  author = the approving owner, summary naming the proposer), so it's accountable to both parties and
  one-click revertable in the existing Revision history panel. Guards mirror `agent_update` (user-home
  claude-code targets only, never self) plus a 10-open queue cap and identical-delta dedupe. Console: an
  owner-only **"Proposed edits from other agents"** card on the agent page with a full CLAUDE.md before→after;
  an inbox card links there. `src/memory/memory-mcp.ts` (`agent_propose_update`), `src/terminal.ts`
  (`proposeAgentUpdate` + card store), `src/server.ts` (`/api/agent/agent/propose`, `/api/agents/proposals`
  + `:id/approve`/`reject`), `web/src/App.tsx`. Audited `agent.update.proposed` /
  `agent.update.proposal.approved` / `agent.update.proposal.rejected`. See `docs/agent-mcp-tools.md`.

## [0.249.0] — 2026-07-21
### Added
- **Insights now surfaces idle agents to retire — a 10th improvement tile.** A user-created agent that
  ran before but has gone quiet (no run in 30+ days) clutters the roster and the spawn picker. The new
  **idle-agents** tile detects them off `MAX(created_at)` per agent and points to the Agents page. It
  never flags the OS's own built-in helpers (consolidator / skill-scout / strategist / … — on-demand by
  design) or a brand-new agent that has simply never run (the "ran before" check is the age proxy).
  Detect + navigate only — retiring an agent is destructive and its automations/assignments would need
  handling, so the human makes the call (no auto-delete). `src/edge/improvements.ts`; rides the existing
  `GET /api/insights` tile grid (now 10 tiles: agents · kb · goals · skills · memory · automations ·
  tasks · library · sessions · idle-agents).
  - *Deferred, by design:* a destructive `agent_merge` primitive (fold two redundant agents into one) —
    it needs an explicit decision on what happens to the merged agent's sessions/tasks/automations/memory,
    so it's left for a human to green-light separately rather than shipped autonomously.

## [0.248.0] — 2026-07-20
### Added
- **Insights can now declutter the Sessions list — a 9th improvement tile.** The run history grows
  without bound (every dispatched task, chat reply, and cron fire leaves a terminal session row), burying
  the handful that still matter. The new **Sessions** tile soft-archives the clutter: **done** runs 14+
  days old are archivable (the run is over); **stopped/crashed** old runs are surfaced for review (a
  failure may be worth a look before it's hidden), never auto-archived. It **never** touches running,
  blocked-on-a-human (pending ask/approval), or recent sessions. Archiving is a soft `archived_at` — the
  row **and transcript survive**, so it's reversible AND every by-id reference stays intact (task
  reconcile's `last_session_id` join, audit, cost); the Sessions list grows a **"N archived · Restore"**
  section and `POST /api/sessions/:id/unarchive` restores. Preview → "Archive N done" mirrors the other
  declutter tiles. `src/edge/session-tidy.ts` + `GET`/`POST /api/insights/sessions/tidy` +
  `GET /api/sessions?archived=1`; audited `sessions.tidied` / `session.unarchived`. Completes the
  consolidation/declutter set (memory · KB · library · sessions).

## [0.247.1] — 2026-07-20
### Fixed
- **A dispatched task with a long acceptance criterion no longer fails to launch.** Task dispatch put the
  task's single-line `criteria` on line 1 as `/goal <criteria>`, but the `claude` CLI hard-rejects any
  `/goal` condition over 4000 characters ("Goal condition is limited to 4000 characters"), so the run
  never started. `buildTaskPrompt` now falls back gracefully when the criteria exceeds the ceiling
  (`GOAL_MAX_CHARS` in `src/edge/claude-cli.ts`): it drops `/goal` mode and embeds the full criteria in
  the prompt body as an "Acceptance criteria (the definition of done)" section — the run still knows what
  done means, it just isn't evaluator-driven. Short criteria keep the `/goal` convergence treatment. The
  same guard covers the `ask_agent`-with-goal delegation path in `src/terminal.ts`.

## [0.247.0] — 2026-07-20
### Added
- **Insights can now declutter the Library — an 8th improvement tile.** The artifacts gallery accumulates
  throwaway output (a generated test image, a scratch file, a one-off render from a run that's since been
  deleted) with nothing to prune it. The new **Library** tile detects clutter and soft-archives it: the
  **dead** set — **orphaned** (produced by a session that no longer exists) AND never shared (no team
  share, no public link) AND 30+ days old — is safely archivable (an artifact whose run is gone and nobody
  ever shared is throwaway by definition); **old-but-still-owned** private artifacts are surfaced for
  manual review, never auto-touched. Archiving is a **soft `archived_at`** (row + files retained, hidden
  from the gallery) so it's fully reversible — the Library grows a collapsible **"N archived · Restore"**
  section, and `POST /api/artifacts/:id/unarchive` restores. Preview → "Archive N" mirrors the KB-tidy /
  task-reconcile generative tiles. `src/edge/library-tidy.ts` + `GET`/`POST /api/insights/library/tidy` +
  `GET /api/artifacts?archived=1`; audited `library.tidied` / `artifact.unarchived`.

## [0.246.0] — 2026-07-20
### Added
- **Insights now reconciles the Tasks board against what sessions actually did — a 7th improvement tile.**
  Once a task is dispatched to an agent, the board drifts from reality in two ways that nothing surfaced:
  the run FINISHES SUCCESSFULLY but the agent forgets to `task_update(done)` (a completed task sits in
  `doing` forever), or the run DIES and strands the task in `doing`. The new **Tasks** tile joins each
  non-terminal task to its dispatched session (`tasks.last_session_id` → `term_sessions.status/outcome`)
  and splits the drift: **finished** (run succeeded, left open — safely **auto-closable**, reversible) vs
  **stalled** (run failed/died — surfaced for review, never auto-touched). Preview → "Close N finished"
  mirrors the KB-tidy/Memory-cleanup generative tiles; a 10-min settle grace avoids reconciling a run
  whose agent is about to close it. Pure over the DB, no LLM. `src/edge/task-reconcile.ts` +
  `GET`/`POST /api/insights/tasks/reconcile`; closes are audited `task.reconciled` and logged as a task
  event. Goals are already covered by the stuck-goal detector, so this is the tasks half of "reconcile
  the plan against reality".

## [0.245.0] — 2026-07-20
### Added
- **Agents can now PROPOSE a new automation for a human to approve — a fourth propose lane.** Alongside
  `skill_propose`/`policy_propose`/`host_propose`, a new agent tool **`automation_propose`** lets an agent
  that notices recurring work (a daily report, a periodic audit, a reaction to an inbound event) suggest a
  scheduled/triggered automation instead of only running when asked. It's a **draft**: nothing is created
  and nothing can ever fire until an owner/admin approves it — the spec rides in an `automation.proposed`
  review card (mirrors the policy-proposal pattern; no DB migration), and only on approve does
  `Automations.add` create + enable it (cron validity checked at approve time). Same 10-deep queue cap +
  identical-spec dedupe as the other lanes. Owner/admin approve/reject at **Automations → "Proposed by
  agents"** (`GET /api/automations/proposals`, `POST …/:id/approve|reject`), with an inbox review card + DM.
  Audited `automation.proposed` / `automation.proposal.approved` / `automation.proposal.rejected`.

## [0.244.0] — 2026-07-20
### Added
- **Stale self-learning guidance is no longer served (or injected) as if current.** When the reflect
  loop is off or has fallen behind, the last distilled guidance snapshot used to keep riding in every
  agent's prompt and showing on the Insights page indefinitely — a 2-week-old "recent success rate is
  28%" presented as live. New `guidanceStale` guard (2× the cadence, or a 7-day floor when the cadence
  is off): past that age the guidance **stops being injected** into agent prompts (`buildCompanyMd`), and
  the Insights page shows a **"these insights are stale — Review now"** banner (`GET /api/dreaming` now
  returns a `stale` flag). Better no guidance than frozen guidance.
### Fixed
- **Self-learning "recurring topics" is sturdier against noise.** On top of the filler/name stop-list
  (0.243.3), a word must now recur across **≥3 distinct episodes** to headline the "the fleet frequently
  works on…" line, so a handful of near-identical test runs can't promote scaffolding words — and the
  stop-list gained the imperative leftovers those step-by-step test prompts leave behind ("stop",
  "exactly", "step", "only", "test", "tool", …). `dreaming.ts` topic extraction only.
### Fixed
- **Share-agent dialog footer no longer bleeds outside the rounded card.** The footer (the "Runnable
  by …" summary + Done button) used shadcn `DialogFooter`'s default `-mx-4 -mb-4` negative margins,
  which assume the dialog body has `p-4` padding to absorb them — but the Share dialog sets `p-0` on
  `DialogContent` (its header/body/footer own their padding), so the bar hung ~16px past the popup's
  left/right/bottom edges as a detached-looking strip. Neutralised with `mx-0 mb-0` so it sits flush
  inside the rounded container.

## [0.243.3] — 2026-07-20
### Fixed
- **Self-learning "recurring topics" no longer surfaces conversational filler or people's names.** Live
  Insights guidance read *"the fleet frequently works on: check, working, recent, emails, influencers"* —
  a Task line is a human sentence ("lets check the latest emails…"), so instruction/filler words
  ("lets", "working", "recent", "latest", "today", …) and the asker's own name ("vikas", "singhal")
  outranked the real subject. Expanded the topic-extraction stop-list with those fillers, and now exclude
  **team-member name tokens** (built per pass from the roster) — a person's name says WHO asked, not WHAT
  the fleet works on. `dreaming.ts` topic extraction only; the guidance/recommendation copy is unchanged.
### Fixed
- **The Agents-page "N Automations" shortcut now counts only standing automations, not spent one-shots.**
  A `once` automation that an agent scheduled and that has already fired (`lastFiredAt` set) is inert — it
  lives in the collapsed "spent" section of the Automations page. The composer-header count was including
  those, overstating the number; it now excludes them, matching what the filtered page actually shows.

## [0.243.1] — 2026-07-20
### Fixed
- **A member's own interactive ("headed") console session no longer gets killed out from under them
  when its agent calls `report`.** Many fleet agents end a run by calling the `report` tool, which flips
  the session row to `done` mid-turn. The 60-second idle sweep's **done-orphan** backstop (`reapIdleSessions`
  sweep 2) then treated *any* unclaimed non-resident `done` row as an orphaned pane and reaped it on sight —
  including a member-spawned interactive session the human was actively using. Result: you'd open a headed
  session, the agent would finish and `report`, and within a minute the live TUI was torn down
  (`session.reaped reason=done-orphan`) even though nobody had walked away. The done-orphan reap is now
  scoped to genuinely **unattended-lane** runs (chat/automation/task/ask provenance — a colon in
  `spawned_by`); a member's own interactive session (bare member-id `spawned_by`, `headless=0`) is left to
  the **idle-interactive janitor** (sweep 3) instead, which now also reclaims a member's `done` session but
  only after the long idle timeout (Settings → default 48h) and with its `done` outcome preserved. So a
  headed session stays live for follow-ups and is only reclaimed once truly idle.

## [0.243.0] — 2026-07-20
### Changed
- **Agent access ("who can run this agent") moved from the Team page to the Agents page**, next to the
  agent it governs. Each agent's composer header now carries a **Share** button (owner/admin) that opens
  a focused, Google-Docs-style **Share dialog**: an "All members" master switch (globe/lock affordance)
  to open the agent to everyone, per-member toggle switches for individual grants, and a read-only
  "Always has access" row for owners/admins (who can always run every agent). Edits persist optimistically
  through the unchanged `PUT /api/team/assignments/:id`, and a live footer summarises who can run it.
  Unlike the old Team surface (claude-code gear only), Share is available for **every agent regardless of
  runtime**. The Team page keeps a short pointer to the new location. No server/API changes.

## [0.242.0] — 2026-07-20
### Added
- **Stale human-in-the-loop prompts now get re-nudged once, so a missed ask doesn't strand an agent
  forever.** Fleet-usage mining across all three tenants showed the biggest governance friction isn't a
  bad rule — it's *abandonment*: agents that raise an approval gate or `ask` a question and are never
  answered (globex alone: 24 approvals + 32 questions sitting pending; every tenant had unanswered
  questions). Only overdue **tasks** had a reminder sweep; approvals/questions had a single ask-time DM
  and then silence. Now the scheduler tick runs `TerminalManager.escalateStalePrompts`: an approval or
  question that has blocked a **still-running** session past a threshold (`AOS_STALE_PROMPT_MIN_MS`,
  default 3h) gets its out-of-band DM fired a **second time** — through the *same* approval/question
  notifiers, so the reminder re-binds the reply-to-decide/answer DM channel and reaches the same
  audience. Fires **exactly once per item** (durable `escalated_at` marker on `approvals`/`questions`,
  like the overdue-task guard, so a restart never re-alarms), skips prompts older than
  `AOS_STALE_PROMPT_MAX_MS` (default 3 days — a long-abandoned gate is treated as dead, and the floor
  stops the first sweep bursting on history) and prompts whose session already ended. Audited
  `approval.escalated` / `question.escalated`. Wired in the tenant registry
  (`Automations.setStalePromptSweeper`) reusing the existing notifier path.

## [0.241.0] — 2026-07-20
### Added
- **Agents page now shows a per-agent "N Automations" shortcut.** When a claude-code agent has one or
  more automations wired to it, its task composer header shows an outlined **⚡ N Automations** button
  that jumps to the Automations page pre-filtered to just that agent (a filter banner with **Show all**
  clears it, and opening the New-automation form there defaults to that agent). Makes the automations
  attached to an agent discoverable from where you run it, instead of hunting the full Automations list.

## [0.240.0] — 2026-07-20
### Changed
- **Sessions list: row actions moved into a "⋯" dropdown, mode shown as a single icon, and the money
  column is now workspace-configurable.** The per-row lifecycle actions (Resume, Take over, Fork,
  Activity, Stop, Delete, Transfer) collapse from a row of hover icon-buttons into one compact icon
  dropdown — less width, and the natural place to add future per-session actions. The launch **mode** is
  now an icon-only badge (a tinted terminal/bolt glyph, still tooltip'd) instead of a full "Interactive"
  /"Headless" pill, reclaiming width for the session title. And a new **Settings → Theme → Sessions
  list** control chooses what the money column shows — **Cost**, **Tokens**, or **Cost + tokens** —
  workspace-wide (persisted server-side, in `/api/state`), so a whole team sees the same view. Grid
  cards follow the same money preference; their primary action (Resume/Take over) stays a labelled
  button with the rest in the shared dropdown.

## [0.239.0] — 2026-07-20
### Changed
- **Sub-agents are now available fleet-wide by default, with a per-agent opt-out.** Previously an agent
  could spawn a teammate as a native sub-agent (0.234.0) only if its `usableSubagents` list named it —
  invisible until configured. Now a new workspace setting **`subagentDefault`** (`'all'` default |
  `'none'`, Settings → Agents/Runtime) governs the posture: under `'all'`, every claude-code agent may
  spawn every *willing* teammate with no per-agent config. `usableSubagents` becomes a **narrowing
  override** (pick specific teammates), and a new per-agent manifest flag **`spawnableAsSubagent`**
  (default `true`) is the **absolute opt-out** — set it `false` to mark an agent *internal* and it is
  never materialised into anyone else's `.claude/agents/`, even if another agent lists it explicitly
  (for governance-sensitive personas — trust & safety, a destructive migrator — you don't want run
  under someone else's identity + budget). Membership is decided by `resolveSubagents`
  (`src/edge/subagents.ts`): eligible = a different, claude-code, non-opted-out teammate; explicit list
  narrows; else the default posture applies. The gateway invariant is unchanged — every sub-agent
  effect is still gated under the parent's principal + budget with the capped toolset. Wired through the
  agent config route (`spawnableAsSubagent`) and a new `GET`/`PUT /api/settings/subagent-default`, with
  a workspace select on Settings → Runtime defaults and an "others may spawn this agent" checkbox on the
  agent page. See `docs/subagents-plan.md`.

## [0.238.1] — 2026-07-20
### Fixed
- **Sessions list columns no longer collapse the title / overlap on laptop-width screens.** The tier-1/2
  insight columns (Took, Activity, wider Cost·tokens) plus the always-reserved `w-40` row-action block
  pushed the total fixed width past the row below ~1700px, squeezing the flex Session title to zero so
  data drifted out from under its headers. Fixed two ways: the hover row-actions now overlay absolutely
  (reserving no layout width) instead of a fixed cell, and the columns widen with the viewport — always
  Session/Started/Mode/Updated/Result, `lg` adds Cost·tokens, `xl` adds Agent+Took, `2xl` adds
  ID+Activity — with a title floor so it never disappears. The trailing spacer now matches the row's
  rating cell, so every column lines up under its header at all widths.

## [0.238.0] — 2026-07-20
### Changed
- **Token totals now sit next to cost in the sessions list.** The per-run token count (uncached input +
  output + cache read + cache write) was tooltip-only behind cost; it now shows as a dim compact figure
  (`12M`, `340k`) right beside the dollar amount — in the list's `Cost · tokens` column and on each grid
  card (`$22.53 · 12M tok`) — with the four-way breakdown still on hover. It shares the cost cell rather
  than taking a column of its own, so the session title keeps its width.

## [0.237.0] — 2026-07-20
### Added
- **Console UI to pick an agent's sub-agents.** The agent settings (Runtime tuning) card now renders a
  toggle-chip multi-select of fleet teammates under a new **Sub-agents** field — the missing UI for
  `usableSubagents` (0.234.0), which until now was only settable by editing `agent.json` or `PUT`ing the
  config route. Lists every other claude-code agent (self + mock agents excluded), round-trips through
  the existing `GET`/`PUT /api/agents/:id/config` (already `usableSubagents`-aware), and stays
  owner/admin-gated like the rest of that card. Explains the guarantee inline: sub-agent actions are
  still gated under this agent's identity + budget, toolset capped to read/search + gated shell/file
  edits + memory recall. Web-only (`web/src/App.tsx`, `web/src/lib/api.ts`) — no server change.

## [0.236.0] — 2026-07-20
### Added
- **Tier-2 session insights — runtime tuning, human-wait latency, and deliverables on every row.**
  Extends the result/duration/activity columns (0.232.0) with four more signals, all derived from
  data the OS already records and stamped once when a run goes terminal (live rows re-derived per
  poll). **model · effort** — the runtime tuning the run launched with (from its `session.tuning`
  audit event), a muted pill leading the activity cluster, so "what ran this, how hard" reads next to
  cost now that both lanes are per-task overridable. **Blocked-on-human time** — a ⏳ chip totalling
  how long the run sat waiting on a person: approval gates (paired `approval.requested`→`resolved`
  audit spans, since the approvals table keeps no resolved timestamp) plus `ask` questions; the
  governed-OS latency nothing else surfaced, and a big value next to a small engaged time is a run
  that mostly waited on people. **Artifacts published** — a 📎 chip counting the Library deliverables
  the run produced. The stamp guard now retires a row only when both tiers are present, so rows
  stamped by the 0.232.0 build re-stamp once to backfill the new columns rather than being skipped.

## [0.235.0] — 2026-07-20
### Changed
- **The session status dot now reflects the state that needs you, not just "live vs not".** The little
  dot on every session row (`statusDot` in `web/src/App.tsx`) used to have four colours — emerald=live,
  amber=stopped, red=crashed, muted=done — so a run sitting on a pending approval or `ask` looked
  identical to one happily working. It now surfaces the two derived flags the server already computes
  (`Session.blocked`/`headless`) with a priority-ordered mapping: **blocked wins** and shows an
  amber **pulsing** dot (the only animated one — the state you must act on); a live run is emerald,
  **filled** for your own interactive session and a **hollow ring** for an unattended (headless) run, so
  "the fleet is doing this on its own" reads differently from "I'm driving this" without spending a
  second colour; stopped/crashed/done are unchanged. `statusLabel` reads "waiting" for a blocked run so
  the word next to the dot never contradicts it. Purely presentational — no data model or API change.

## [0.234.0] — 2026-07-20
### Added
- **An agent can spawn fleet teammates as native in-process sub-agents.** A parent agent's manifest
  gains `usableSubagents: string[]` — an opt-in list of OTHER fleet agent ids it may invoke through
  Claude Code's built-in `Agent`/Task tool. At launch each named teammate's manifest + persona (its
  `CLAUDE.md`) is materialised into the parent's `.claude/agents/<id>.md` (`src/edge/subagents.ts`,
  mirroring how the skills library syncs into `.claude/skills` — idempotent, refreshes only our managed
  files via an `.aos-managed.json` index, preserves hand-authored ones). The running claude can then
  delegate a slice of its OWN turn to a teammate in-process (sub-second, no separate governed session) —
  the lightweight counterpart to `task_dispatch`, which stays the path for delegating to a *separately
  accountable* citizen. **The gateway invariant holds:** a native sub-agent runs in the parent's
  process, so the PreToolUse gate hook fires for its tool calls too — every effect is still classified/
  approved/budgeted/audited, under the parent session's principal + budget. Claude Code tags the hook
  input with `agent_type`/`agent_id`; `terminal/gate-hook.sh` forwards them (via a U+001F field
  separator — a tab would collapse the empty fields of a normal top-level call) and `gate()` stamps
  `gate.attempt`/`gate.decision` with `subagent`/`subagentId`, so the audit trail attributes a governed
  effect to which sub-agent produced it. The sub-agent's toolset is capped to a conservative allow-list
  (`SUBAGENT_DEFAULT_TOOLS`: read/search + gated Bash/Edit/Write + memory recall) — never proactive
  egress, the vault, `publish`, or the operator/inbox surface. Settable from the owner/admin agent
  config route (`GET`/`PUT /api/agents/:id/config`, `sanitizeUsableSubagents`); a self-editing agent
  cannot widen its own reach. See `docs/subagents-plan.md`.

## [0.233.0] — 2026-07-20
### Added
- **Approve or reject a gated action straight from the Slack/Discord DM — the approval round-trip.**
  Until now the approval ping was one-way: the DM told approvers to open the web Inbox to decide.
  Approvals now close the loop the way `ask` questions already did. When an approval is raised,
  `notifyApprovers` (`src/tenant-registry.ts`) binds it to each approver's DM channel in a new
  `approval_dms` table (the twin of `question_dms`), and the DM now reads *"Reply 'approve' or 'deny' to
  decide."* An inbound DM reply is matched back to the newest still-pending approval bound to that sender
  by `TerminalManager.decideApprovalFromChat` (`src/terminal.ts`): it reads the reply as an approve/deny
  intent (`parseApprovalIntent` — first-token/emoji match, conservative — ambiguous text prompts for a
  clear yes/no instead of guessing on a governance decision), **re-checks the replier can still clear that
  level** (`canApprove`, defense in depth), and settles the same gate the console resolves — attributed to
  their member email, audited `approval.decided.viaDm`. The Slack/Discord socket DM handlers check this
  before the question path; unknown senders fall through to chat unchanged. Purely additive — the console
  approve/reject flow is untouched. Multi-approver safe (the binding is keyed per approver) and races with
  the console cleanly (`resolve` no-ops once decided).

## [0.232.0] — 2026-07-20
### Added
- **Session insights in the sessions list — result, engaged duration, and an activity fingerprint.**
  The list could only say a run was `done`, which means the process exited, not that the work landed.
  Every row (and grid card) now carries: **Result** — the agent's own verdict from its end-of-session
  `report` (`success`/`failure`/`partial`), with the summary as a tooltip and as the card's one-liner;
  a finished run that never reported reads **"no report"**, since nobody closing the loop is itself a
  finding. **Took** — ENGAGED time read from the transcript with idle gaps excluded, because wall-clock
  is not a usable duration (an interactive session idles between turns, so a 7-minute run routinely
  spans 13 hours of `updated_at - created_at`). **Activity** — tool calls, approvals needed, denials
  and errors, with tool calls leading since governed actions only count the subset the gate mediates.
  Both new columns are sortable. Timing and volume fall out of the same transcript walk that already
  prices a run; outcome and the governance counts are indexed lookups on the audit stream. Everything
  stamps once when a run goes terminal and is never recomputed — live rows re-tally each poll, and a
  pruned transcript stamps zeros instead of being re-probed on every list call forever.

## [0.231.1] — 2026-07-20
### Removed
- **Reverted the agent learning-`velocity` metric (0.231.0).** Reverted because it was shipped a step
  ahead of its need: nothing consumed the field yet (the value was entirely in the planned
  prompt-injection / consolidation-routing follow-ups), and a read of the live fleet showed only 3 of
  ~21 agents have enough runs (≥14) to leave the `unproven` band — the rest are a long tail of
  low-volume agents. An un-consumed metric that fires for a handful of agents is surface area, not a
  feature. The idea stands and the approach was sound; it should return **with its consumer**, not
  before. `AgentStats` is back to maturity-only.

## [0.231.0] — 2026-07-20
### Added
- **Agent learning velocity.** _(Reverted in 0.231.1 — shipped ahead of a consumer; see above.)_

## [0.230.0] — 2026-07-20
### Added
- **Delegate a task at a chosen model / effort tier.** `task_create` now takes optional `model` and
  `effort` (low…max) that pin the runtime tuning of the *dispatched* session — the highest-priority
  layer over the assignee agent's manifest and the workspace default
  (`resolveRuntimeTuning(agent, defaults, taskOverride)`). So an agent handing off background work can
  run it on a small/cheap model, or force `max` effort for a hard task, without touching the delegate
  agent's own configuration. Validated at the API edge with `sanitizeRuntimeTuning` (unknown effort
  rejected; model free-form), stored on the task (`tasks.model`/`tasks.effort`), and threaded through
  `dispatchTask` → `createSession` → `launchClaudeCode` as a per-launch tuning override. Nullable —
  omit either field to inherit as before.

## [0.227.8] — 2026-07-20
### Fixed
- **Insight-alert cards in the Inbox had no useful action — clicking "Open" landed on a dead session
  terminal.** The intelligence layer posts proactive alerts (a struggling agent, a capability that keeps
  getting rejected, approvals piling up) as session-less `notification` cards keyed `insight:<key>`. The
  console's `ActionItem` renderer treated every `notification` as "Claude is waiting in a session" and
  hardcoded its button to `#/sessions/aos-insight:<key>` — a tmux name no session ever has, so the
  session lookup returned null and the user got an empty/dead terminal. Alerts now carry a real in-app
  target (`args.route`/`args.detail`): success-drop / struggling-agent / crashing-agent → **Insights**,
  a rejected capability → **Settings › Policy**, pending approvals → **Inbox**. The card renders a
  lightbulb "insight" style with a **View <page>** button that deep-links there (both the Inbox card and
  the notification-bell/toast click path), and legacy cards with no route fall back to the Insights page.

## [0.227.7] — 2026-07-20
### Fixed
- **Live notifications went stale in an already-open tab — the inbox only updated after a page reload,
  and the tab-title 🔔 badge / per-session "waiting" bells stopped lighting up.** The whole console's
  live feed rides one 1.5s `setInterval` that refills sessions + messages; everything (tab badge,
  waiting bells, sidebar counts) derives from those. Two flaws froze it: (1) the two fetches ran
  sequentially and unguarded, so a single transient failure of the first (`api.sessions()`) blocked
  the message refresh; and (2) browsers throttle/freeze `setInterval` in a backgrounded tab — exactly
  when the tab badge matters most. The poll now runs both fetches independently (`Promise.allSettled`,
  ignoring non-array error payloads so a blip can't clobber good state) and re-polls immediately on
  tab `focus`/`visibilitychange`, so switching back to the console shows current state at once.

## [0.227.6] — 2026-07-20
### Fixed
- **Collapsed sidebar hid the "Update available" pill too.** The self-update notice only rendered in
  the expanded sidebar, so a collapsed rail gave no sign the box was behind origin. The rail now shows
  an amber download icon (with a pip) at its foot when an update is available, opening the same
  update-and-restart dialog.

## [0.229.1] — 2026-07-20
### Fixed
- **Memory recall reinforcement was invisible under an external backend — every mirrored memory read
  as never-recalled forever.** All three production tenants run the `automem` backend, so recall is
  served by automem while the OS's SQL-level machinery (prune, Dreaming, the consolidation gardener,
  the Memory-hub "never recalled" count) reads the local `memories` **mirror** table. But
  `MirroredMemoryProvider.recall` delegated straight to the backend and never bumped the mirror's
  `recall_count`/`last_recalled_at` — so fleet-wide the mirror showed **100% of memories as
  never-recalled** (235/235, 692/692, 144/144; avg recall 0). Two consequences: the Memory-hub health
  metric was meaningless, and `maintain()`'s prune (`DELETE … WHERE recall_count = 0 AND importance <
  keep`) would delete memories recalled hundreds of times in the real store. Recall now reinforces the
  mirror for the returned ids (same gate as the SQLite provider — a real query with results, not a
  blank recency listing), via a new public `SqliteMemoryProvider.reinforce(ids)`. Best-effort: a mirror
  failure never fails a recall.
- **`automem` request failures swallowed the response body, making the recurring `→ 400` opaque.** The
  fleet logged 140+ `episode.error` events of the bare form `automem POST /memory → 400` with no clue
  *why* automem rejected the write. The thrown error now appends a snippet of the response body (where a
  4xx validation reject spells out the reason), so the store-failure/`episode.error` audit becomes
  diagnosable.

## [0.229.0] — 2026-07-20
### Added
- **Agent review requests now DM the owner/admin tier, not just the Inbox.** When an agent files a
  `secret_request` (both *provide* — enter a new value — and *access* — grant an existing but
  scoped-away key), a `skill_propose`/`skill_request`, a `host_propose`, or a `policy_propose`, the
  review card landed in the Inbox but **nobody was ever pinged** — the request sat unseen until an
  owner happened to open Settings. These now fire an out-of-band Slack/Discord DM to the admins,
  reaching parity with how approvals, questions, and task events already surface. The DM carries the
  card's own title + a deep-link to the right console page (Secrets / Skills / Connections / Policy).
### Changed
- **Centralised the whole "agent asks a human to approve X" family onto one path.** Every review
  request/proposal used to call `addMessage` directly (which wrote the card but fired no notifier);
  they now route through one `TerminalManager.postReviewCard` helper + a single `reviewNotifier` sink
  (wired in `tenant-registry.ts` to `notifyReview`), so the inbox card and the DM are emitted in ONE
  place — the review-side twin of the approval/question/member notifiers. New audit event
  `review.notified`. (`src/terminal.ts`, `src/tenant-registry.ts`; `npm run test:review`.)

## [0.228.0] — 2026-07-20
### Changed
- **Manage nav is now a grouped flyout instead of an inline footer expander.** The pinnable secondary
  nav had grown to ~16 items; expanding "Manage" inline overflowed the sidebar's *fixed* footer, which
  has no scroll of its own, so the list fought the sessions area above it and the profile row below it
  (the "weird scrolling"). Clicking **Manage** now opens a floating panel above the button, splitting the
  unpinned items into **Workspace** / **Admin** groups in a compact two-column grid, capped at 62vh with
  its own internal scroll, and closing on outside-click / Escape / navigation. Per-item "pin to Main"
  (hover) is preserved; the footer stays a constant height regardless of how many nav items exist.
  (`ManageFlyout`/`ManageFlyoutItem` in `web/src/App.tsx`.)

## [0.227.5] — 2026-07-20
### Fixed
- **Collapsed sidebar showed no notifications.** The 48px rail dropped every signal the expanded
  sidebar carries — pending approvals, live runs, "Claude is waiting on you" — so collapsing it hid
  the fact that anything needed you. The rail's Inbox and Sessions icons now carry corner pips: an
  amber count for items awaiting your decision (a plain dot when there's unread-but-nothing-to-decide),
  and on Sessions an indigo count of your sessions blocked on you, falling back to the emerald
  running-run count.

## [0.227.4] — 2026-07-20
### Documentation
- **Deploy runbook: the "blank browser terminal / `/terminal/ws → 403`" nginx gotcha.** Documented a
  config artifact that hit umbrella — a literal backslash before every `$variable` in `proxy_set_header`
  (a leaked shell-heredoc escape, e.g. `Host \$host;`) makes nginx send `Host: \example.com` and a bogus
  non-empty `Upgrade: \` on every request. The Node app tolerates it so the console loads, but
  ttyd/libwebsockets 403s the WebSocket handshake — so only the browser terminal breaks (blank), while
  sessions otherwise spawn fine. Added diagnosis (tcpdump the nginx→ttyd hop) and the one-line fix
  (`sed -i 's/\\$/$/g'` + reload) to `README.md` and `CLAUDE.md`.

## [0.227.3] — 2026-07-17
### Fixed
- **Cron automations now honor `run_as` — personal Composio/connectors are injected.** The scheduler
  `tick()` cron branch fired with `this.fire(a, { guard: true })`, dropping the automation's `run_as`, so
  every cron spawn ran with `actingMember = undefined` and saw only the shared company Composio. A daily
  cron for a member's personal ClickUp therefore couldn't reach it and raised an owner-gated RED
  `connector.connect` on the company account. The cron branch now passes `runAs: a.runAs` (mirroring the
  `once` branch), so a cron session binds that member's identity and their personal connectors are minted —
  no connect prompt. The `run_as` column on a cron row was previously dead.
### Added
- **"Run as" selector on the automation editor.** The create/edit form (and `POST`/`PATCH
  /api/automations`) now expose a Run-as member picker, persisted to `automations.run_as`, so a cron/webhook/
  event automation can be bound to a member from the console — the reason `run_as` was silently always empty.

## [0.227.2] — 2026-07-17
### Fixed
- **`agent-browser` cleanup now handles agents that relocate the socket dir (follow-up to 0.227.1).**
  End-to-end testing on a real `qa` session revealed 0.227.1's exit trap was ineffective for the very
  agents that leak: `agent-browser close --all` keys off the **socket dir**, not the namespace, and
  several agents (`qa`/`engineer`/`site-porter`/`website-bot`) export a custom
  **`AGENT_BROWSER_SOCKET_DIR`** to a writable per-session dir (their HOME is read-only under systemd
  `ProtectHome`), so the trap's plain `close --all` — which only had the server's default socket dir —
  found "No active sessions" and left the daemon running. Fix (`terminal/claude-launch.sh`): the trap
  now finds **this session's** daemons by the `AGENT_BROWSER_NAMESPACE` env they reliably inherit,
  **recovers each one's own `AGENT_BROWSER_SOCKET_DIR` from its `/proc` environ**, and runs `close --all`
  scoped to it (with a `SIGTERM` straggler fallback). Still namespace-scoped, so it never touches another
  session's browser; the plain `close --all` runs first to cover the default-socket-dir / macOS case.

## [0.227.1] — 2026-07-17
### Fixed
- **`agent-browser` daemon leak — sessions now clean up their own browser (root-cause fix, not a GC).**
  The `agent-browser` skill starts a persistent headless-Chrome daemon that **double-forks (`setsid`) out
  of the session's tmux process group**, so `tmux kill-session` at teardown never reached it and it
  survived — burning CPU (its `swiftshader-webgl` software renderer spins helpers at ~100%) and RAM — for
  **days**, until reboot or OOM. On the globex box this had accumulated 6 orphaned daemons (one agent
  leaked 4) driving load average to ~25; killing them dropped it to ~1. Two changes make each session own
  its browser lifecycle:
  - `src/terminal.ts` (`sessionEnv`) now exports **`AGENT_BROWSER_NAMESPACE=aos-<session-id>`** (isolates
    each session's daemon + socket + saved state) and **`AGENT_BROWSER_IDLE_TIMEOUT_MS`** (default 5 min,
    operator-overridable — the vendor's self-shutdown, kept only as the last-resort net for the one exit a
    trap can't catch: an un-trappable SIGKILL/OOM).
  - `terminal/claude-launch.sh` adds an **exit trap** (`EXIT`/`HUP`/`TERM`/`INT`) that runs
    `agent-browser close --all` — the vendor's clean shutdown — so the session tears its browser down on
    **any trappable exit, including the SIGHUP `tmux kill-session` sends**. Scoped to the session's
    namespace, so it can never touch another live session's browser. The launcher already stays claude's
    parent (never `exec`s it), so the trap is live for interactive, unattended, and resident lanes.
  Upstream-acknowledged gap (vercel-labs/agent-browser #885/#1334/#1371/#1401): the daemon has idle
  self-shutdown but nothing cleaned up after abnormal termination — now agent-os does, at the source.

## [0.227.0] — 2026-07-17
### Added
- **Slack chat IDs now auto-link from a member's email.** When a notification (task assignment, approval,
  question, session event, …) needs to DM a member who has **no linked Slack handle**, `deliverDM`
  (`tenant-registry.ts`) now looks their Slack user up by their (verified) account email via
  `users.lookupByEmail` (new `SlackSocket.userIdForEmail`, in-process hit/miss cache), **DMs them, and
  persists the discovered `U…` id to the identity map** (`created_by = auto:slack-email`, audited
  `identity.autolinked`). So the first notification reaches an unlinked-but-in-Slack member AND every
  later run-as/DM lookup is already resolved — no manual **Team → Chat IDs** step. Slack only: Discord
  exposes no email, so an unlinked Discord member stays manual (see below). Needs the `users:read.email`
  bot scope (already required for the reverse run-as lookup).
- **"Complete your profile" checklist on the Profile page.** A live, self-dismissing card at the top of
  **Profile** derived from what the member has already filled in — profile picture, a linked chat account
  (Slack/Discord), a connected GitHub, and their working context. Each unfinished step shows a one-line
  why and **scroll-jumps** to the relevant section below; the card hides once all four are done. This is
  the manual fallback for what auto-link can't cover — chiefly **Discord**, which has no email to resolve
  from — nudging members to link it themselves so task/approval DMs reach them.
## [0.226.0] — 2026-07-16
### Added
- **Distraction-free terminal + "Pop out" to its own tab.** The individual terminal view gets two new
  affordances in its top-right toolbar. **Focus** (⤢) lifts the pane to a full-viewport overlay (`fixed
  inset-0`, above the sidebar + tab strip) so nothing but the terminal is on screen — **Esc** or the
  **Exit** button returns to the console; the pane refits automatically (its `ResizeObserver`). **Pop out**
  (↗) opens the same pane on its own at a new chrome-less route `#/term/<tmux>` in a fresh browser tab —
  rendered OUTSIDE the console shell (a slim title bar + "← Console" link, then just the terminal), reusing
  the same `<TerminalFrame>` and the login cookie, so it's a real anchor (⌘/middle-click works). The
  standalone view fetches the session row too, so an ended run still shows its transcript and file-attach
  still works. Mirrors the existing chrome-less artifact viewer (`#/view/<id>`).
### Fixed
- **Operations → Activity now works in the terminal-tabs view.** The v0.224.0 Activity shortcut set the
  panel state via `setInspect`, but `SessionsPage` early-returns the terminal-tabs view before the
  `{inspect && <SessionActivity>}` render, which lived only in the session-list branch — so opening a
  session's terminal and choosing Operations → Activity did nothing. Mount the `SessionActivity` panel in
  the terminal-view branch too, so the shortcut opens the trail from both views.

## [0.225.0] — 2026-07-16
### Fixed
- **Delegation loop closes itself: the caller is woken when the delegate finishes.** Two gaps meant an
  agent that dispatched a task to another agent never learned it was done unless a human told it to "check
  that task status": (1) `poke_on_done` was opt-in and defaulted off, and no agent ever set it, so the
  caller was never recorded (`caller_agent` was null on every task in prod) and never woken — only the
  human owner got a `task.notified` DM; (2) even when a poke did fire, `pokeCaller` *skipped* a caller
  whose session was still alive, assuming it "will see the result itself" — but an interactive/resident
  caller sits IDLE at the prompt after ending its turn and observes nothing. Now: `task_create` defaults
  the async wake **ON** for an agent→agent hand-off (opt out with `poke_on_done:false`; `wait:true` still
  supersedes with a synchronous block; self-assignment never wakes), and `pokeCaller` delivers into a live
  caller by **injecting** the result into its pane (idle → runs now, mid-turn → queues to the next turn
  boundary) instead of skipping — falling back to a `--resume` only when the caller has already exited.

## [0.224.0] — 2026-07-16
### Added
- **"Activity" shortcut in the per-session Operations menu.** The session activity trail side panel
  (objects the run opened + their live status, v0.221.0) was only reachable from the Sessions list rows.
  Added it as the top item of the terminal-view **Operations** dropdown (`OperationsMenu`), so while
  you're watching a live run you can open the trail in one click. Threaded a new `onActivity` callback
  through `SessionOps` to `setInspect`, opening the same `SessionActivity` panel.

## [0.223.0] — 2026-07-16
### Added
- **"Operations" menu on every session terminal.** A new dropdown pinned top-right of the live terminal,
  next to Files, gathers the session-lifecycle actions in one place: **Reload**, **Fork**, **Stop**,
  **Delete**, and **Transfer** (hand the run-as to a teammate). **Reload** is new — it restarts the agent
  process IN PLACE (kill the pane, then `claude --resume` the same session id) so a newly-connected MCP
  server is picked up; MCP servers only spawn at claude launch, so a running session otherwise can't see
  one added mid-run. The conversation is preserved and, unlike Stop, no "stopped" episode is written, so
  the real end-of-run episode still fires. New `POST /api/sessions/:id/reload` → `TerminalManager.reloadSession`
  (gated only for resumable claude-code sessions); the console remounts the terminal to re-attach and
  resurrect via attach.sh. **Fork** moves here from the terminal tab-strip hover controls (still available
  on the session cards/rows).

## [0.222.1] — 2026-07-16
### Fixed
- **Session trail: `task_dispatch` no longer mis-reads as "deleted".** The `task.dispatched` audit event
  keys the task id under `data.task` (not `data.id`), so the activity classifier resolved an empty id and
  the trail showed the dispatch as `deleted` with a blank summary. It now reads `data.task` (falling back
  to `data.id`), so a dispatch shows the task title + its live status; the endpoint also guards
  empty-id targets so a missing id yields no status rather than a misleading "deleted". Follow-up to the
  v0.221.0 session activity trail.
### Added
- **Chat renders KB pages and hosted apps inline too.** Extends the inline-deliverable cards (v0.220.0)
  beyond Library artifacts: when an agent writes a Knowledge Base page (`kb_write`) or builds/changes a
  hosted app (`app_create`/`app_update`) mid-conversation, the Chat window now shows a titled tile for it
  — the KB tile deep-links to `#/kb/<section>/<slug>`, the app tile to `#/apps/<id>` plus an **Open** link
  to the live app when it's published. Unlike artifact ids (minted server-side, parsed from the tool
  result), the KB `section`/`slug` and app `id` come straight from the tool **input**, captured
  optimistically and dropped if the write comes back an error. The `/api/sessions/:id/conversation` route
  resolves them into viewer-safe `ChatKbRef`/`ChatAppRef` cards (KB pages and apps are tenant-wide surfaces
  every member can already browse; an unknown/deleted ref is dropped). Also gave those tools clearer
  activity labels ("Updated the knowledge base", "Built an app", "Updated an app").

## [0.221.0] — 2026-07-16
### Added
- **Session activity trail — every object a run opened, with live status.** The per-session activity
  panel (`GET /api/sessions/:id/activity` + the `SessionActivity` component) now answers "what is this
  session doing / done?", not just "which primitives did it touch". Two changes: (1) **coverage** — the
  classifier (`src/state/session-activity.ts`) gained `secrets` / `skills` / `policy` categories, so
  `secret.put`/`secret.get`/`secret.requested`, `skill.proposed`/`skill.requested` and `policy.proposed`
  surface as first-class trail entries instead of falling into `other`; (2) **live status** — each
  object-bearing entry carries an `ActivityTarget` (`{kind,id}`), and the route resolves that target's
  CURRENT state from its live store (a task's `todo→doing→done`, a KB page's `rev N`, a secret's
  `stored`, a proposal card's `pending→approved/rejected`) and returns it as `status`/`statusTone`. The
  console panel is now a right-docked **side panel** with an **Objects | Timeline** toggle: Objects
  collapses the trail to one row per live object (outstanding ones first) with a status chip; Timeline is
  the full chronological feed. It **polls while the run is alive**, so a task's status updates in place.
  Audit stays the single spine — no new tables, no migration; adding a plane is one classifier case + one
  resolver.

## [0.220.0] — 2026-07-16
### Added
- **Chat renders Library deliverables inline.** When an agent produces a Library artifact mid-conversation
  — `publish` a report/file, `image_generate`/`image_edit` a picture, `video_generate` a clip — the plain-language
  Chat window now shows it **inline** instead of a generic "Posted an update" line: an image thumbnail, a
  video player, or a titled file tile, each deep-linking into the Library (`#/artifacts/<id>`). The transcript
  parser (`src/edge/conversation.ts`) tags those activities with the artifact id(s) it finds in the tool
  result (prefixed `art_…` ids), and the `/api/sessions/:id/conversation` route resolves them into
  viewer-safe preview cards (`ChatArtifactRef`) — filtered by the same visibility gate as the Library, so a
  card only shows a deliverable the viewer may already see. Also gave those tools distinct activity labels
  ("Published to the Library", "Created an image", "Created a video") so the inline card reads naturally.

## [0.219.1] — 2026-07-16
### Removed
- **Dead `randomId` helper in the control plane.** `src/state/control.ts` exported a legacy
  `randomId(prefix)` id generator that had zero callers since the prefixed-id migration
  (`src/id.ts` / `newId`) took over entity id minting. Removed it and its now-unused `randomBytes`
  import — no behavior change.

## [0.219.0] — 2026-07-16
### Added
- **Episodic self-query — an agent can read its own history of past sessions, and reopen any one.** Two
  read-only MCP tools land as the run-history companion to the (semantic) memory plane: `session_history`
  lists the agent's OWN past sessions (id, title, status, human 👍/👎 rating, seed task — newest first,
  optional `query` over title/task), and `session_open` reopens a chosen one to read what happened — the
  friendly transcript **timeline** (user/assistant messages + friendly activity cards via
  `readConversation`, tail-capped at 60 turns), or with `summary:true` a throwaway-claude **recap** of the
  whole run. Both are **own-scoped server-side**: the loopback routes (`GET /api/agent/sessions` /
  `GET /api/agent/session`) resolve the caller's agent from its session secret and only ever surface that
  agent's sessions — opening another agent's run is a 403. Answers "have I done this before, and how did it
  go?" alongside `recall`. Falls back to the raw `session-<id>.log` pane tail for a headless run with no
  structured transcript; a summary is audited `session.summarized` under `principal: agent:<id>`.
  (`TerminalManager.sessionsForAgent`; closes the "Episodic self-query" gap in `docs/agent-mcp-tools.md`.)

## [0.218.0] — 2026-07-16
### Added
- **Per-session cost tracking, surfaced on the sessions list and automation runs.** Every claude-code
  session now records what it cost — computed from its transcript's per-request token `usage`
  (input / output / cache-read / cache-write, each cache tier priced at its own 5-min vs 1-hour rate)
  × per-model sticker rates (`src/edge/session-cost.ts`). Cost is derived once a run reaches a terminal
  state, then cached on the `term_sessions` row (new `cost_usd` + token-breakdown columns) — filled
  lazily on first read in `listSessions` (bounded per call so a long history doesn't stall the first
  load) and persisted, so neither the sessions list nor automation-run history re-parses the transcript
  each poll. The console shows a sortable **Cost** column on the sessions list (with a token-breakdown
  tooltip) and the per-run cost in an automation's run history.

## [0.217.0] — 2026-07-16
### Changed
- **Agents are now always aware of the Goals & Tasks primitives**, not just when active goals happen to
  be injected. The always-present operating notes gain a proper mental model — **Goal → Task → this
  session** — with the full verb set: `task_list` to check work isn't already filed before starting (not
  just for pulling shared work), `task_create` reframed from delegation-only to also parking/​tracking
  your own multi-step work, `task_update` to close the loop, and a dedicated **Goals** bullet
  (`goal_list`/`goal_get` to see direction, link work with `task_create({ goalId })`, `goal_propose` a
  new direction for a human to approve). Previously the only mention of the goal verbs lived inside the
  dynamic active-goals injection, so an agent with goal-injection off or an empty goal list had no idea
  goals existed as a primitive. The live active-goals section is slimmed to pure data + a pointer (its
  mechanics now live in the always-present note), so total prompt size stays roughly flat.

## [0.216.0] — 2026-07-16
### Changed
- **Stripe-style prefixed entity ids across the board.** Every referenceable persisted entity now mints a
  namespaced, self-describing id via a single source of truth — the new `src/id.ts` (`newId('session')` →
  `ses_a1b2c3…`, 64 bits of entropy vs the old 8-char `randomUUID().slice(0,8)`). Prefixes: `ses_`
  (sessions), `tsk_`/`tev_`/`tatt_` (tasks/events/attachments), `goal_`/`gev_` (goals/events), `msg_`
  (inbox), `qst_` (ask-human questions), `ask_` (agent-asks), `apr_` (approvals), `art_` (artifacts),
  `vid_` (video jobs), `mem_` (memories), `kbp_`/`kbr_` (KB pages/revisions), `arev_`/`prev_`
  (agent/policy revisions); `m_` (members) and `au_` (automations) keep their existing prefixes, now
  routed through the same helper. Rollout is **forward-only** — pre-existing bare-hex ids stay valid and
  keep working; nothing parses an id prefix (the new `parseId`/`isId` helpers are introspection-only, not
  a gate). Deliberately left unprefixed: bearer secrets (auth-session sid, invite/webhook/session
  secrets, artifact share token), the `claudeSessionId` UUID (`claude --session-id` format), numeric
  `audit_events.id`, and human slugs (`connectors.id`, `tenants.slug`). The core governance `Run`
  (`src/core/run.ts`) keeps its raw UUID to preserve the "core imports only from `types.ts`" invariant.

## [0.215.0] — 2026-07-16
### Changed
- **Re-publishing a deliverable now updates it in place instead of creating a duplicate.** `publish` is
  now an upsert keyed on `(agent, folder, filename)`: when an agent publishes the same file, from the
  same folder, again, the existing artifact is overwritten — its id (and hence every Library deep-link
  and public `/shared/<token>`), plus its team-share/public flags, are preserved; only the bytes,
  title/description, provenance, and `created_at` (bumped so the refresh surfaces at the top) are
  refreshed. Previously every `publish` minted a fresh id + on-disk dir + row + inbox card, so a living
  deliverable accreted duplicate gallery entries. A different agent, folder, or filename still creates a
  new artifact. New event `artifact.updated` (vs `artifact.published`) drives the audit trail, the inbox
  card title, and the session activity summary; the `publish` tool now tells the agent it updated in
  place, and its schema documents the refresh behaviour. `ArtifactStore.publish` returns `updated`.
  (`ArtifactStore.ingest` generated artifacts and the human `writeContent` edit path are unchanged.)

## [0.214.1] — 2026-07-16
### Fixed
- **Closing a session tab no longer jumps to a teammate's session.** When you closed the open tab (or
  stopped the session you were viewing), the fallback that picks the "next" tab scanned the *entire*
  fleet list — which, for an owner/admin, includes every member's sessions — so it could open an
  unowned session that flickers until you click one of your own tabs. Both fallbacks (`closeTab` and
  `stopSession` in `web/src/App.tsx`) now scope the pick to sessions that are mine (spawned by or run
  as me), mirroring the "mine"-scoped sidebar/strip.

## [0.214.0] — 2026-07-16
### Added
- **Edit a text/Markdown deliverable in place in the Library.** A published artifact used to be a
  read-only snapshot; now owner/admin — or the member whose session produced it — can fix a typo or
  update a Markdown report without republishing. An **Edit** (pencil) button in the detail panel opens
  an inline editor (Save/Cancel); it overwrites the snapshot's file in place, so its id-dir/filename are
  unchanged and every existing link (Library deep-link, public `/shared/<token>`) keeps resolving. New
  `ArtifactStore.writeContent` (text-only guard — binaries are refused so a write can't corrupt them),
  `PUT /api/artifacts/:id/content` (same gate as move/delete/share), audited `artifact.edited`.

## [0.213.0] — 2026-07-16
### Changed
- **"Open" on a Library deliverable renders markdown instead of showing raw source.** The Open button
  now routes markdown/text through a chrome-less full-screen viewer at `#/view/<id>` that reuses the
  console's markdown pipeline (remark-gfm + wiki-links), so opening a `.md` reads as formatted prose in
  the new tab rather than the browser's raw `text/markdown` dump. Binary/native types (image/PDF/video/
  HTML) still open their raw URL, which the browser renders full-screen itself. The viewer is auth-gated
  like every other view and bypasses the console shell (`FullArtifactView` in `web/src/App.tsx`).

## [0.212.0] — 2026-07-16
### Added
- **Agents link every PR back to their session by default.** A new `AOS_SESSION_URL` env var carries a
  human-facing console deep-link to the run (`<publicOrigin>/#/sessions/aos-<id>`), injected into every
  session's shell and persisted in the resurrect env. The OS operating notes now instruct agents to drop
  that link into any pull request (or similar external deliverable) they raise, so a reviewer can trace
  the change back to the audited run that produced it (`src/terminal.ts`).

## [0.211.0] — 2026-07-16
### Added
- **Open a deliverable full-screen in a new tab.** The Library detail panel gains an **Open** button
  next to Download — opens the artifact's raw URL in a new tab (`target="_blank"`), so a PDF/HTML/image
  gets the whole viewport instead of the preview pane.
### Changed
- **Public Library links now auto-revoke after 7 days.** A protection so a shared link can't stay
  world-reachable forever. Minting a public link stamps a 7-day expiry (`artifacts.share_expires_at`);
  the public `/shared/<token>` route rejects an expired token immediately (404), and the scheduler tick
  sweeps expired rows — clearing the token durably (audited `artifact.share.expired`). Re-toggling the
  Public link renews the 7 days on the same URL. The detail panel shows when a link auto-revokes.
- **Markdown preview fills the Library pane width.** The md/text preview was capped at `max-w-3xl`, so it
  never widened with the pane (most visible after collapsing the sidebar); other artifact types are
  already full-width. Markdown now matches (`web/src/App.tsx`).

## [0.210.0] — 2026-07-16
### Added
- **Native-dependency check + one-shot install.** A fresh box needs a few native commands Agent OS shells
  out to (`tmux` backs every session pane, `ttyd` serves the in-browser terminal, `claude` is the agent
  runtime, `git` powers self-update) — previously undocumented beyond a prose line in CLAUDE.md, and the
  classic "why won't a session start?" gap.
  - **Settings → System → Native dependencies** — a new panel (`GET /api/deps`) showing each tool's
    present/missing state, version, and purpose. When something's missing it surfaces the exact install
    command (copyable) and the `npm run install-deps` shortcut; the owner gets an **Install now** button
    (`POST /api/deps/install`, owner-gated, audited `system.deps.installed`) that runs the box's package
    manager (brew on macOS; apt/dnf/yum/pacman/zypper on Linux) and re-checks, streaming each step's log.
  - **`npm run install-deps`** (and `npm run check-deps`) — a zero-dependency bootstrap shell script
    (`scripts/install-deps.sh`) that works on a fresh checkout *before* `npm run build`, portable to
    bash 3.2 + BSD userland. Detects the package manager and installs the still-missing tools.
  - **`agent-os deps` / `agent-os install-deps`** — the same check/install from the built CLI, for a box
    where the server is already running.
  Deps installed another way (`claude`, via npm) are never auto-installed — their manual hint is shown
  instead. New module `src/edge/deps.ts` (`checkDeps`/`installDeps`), modeled on the self-update path.

## [0.209.0] — 2026-07-16
### Added
- **Quick Shortcuts on every terminal session** — a `⚡ Shortcuts` menu in the terminal chrome with:
  - **Summarize this session** — an *out-of-band* summary. Reads the run's already-written transcript
    and summarizes it in a throwaway `claude -p`, shown in a modal. The target session's own context is
    never touched, so asking "what's this run doing?" doesn't pollute the agent. Degrades to a
    deterministic transcript summary if the summarizer can't run (`POST /api/sessions/:id/summarize`).
  - **Check now** / **Update yourself** — built-in canned prompts typed straight into the live session.
  - **Personal shortcuts** — members save their own label+prompt canned prompts (Profile → *My
    shortcuts*, or inline from the menu). Stored per member in `member_prefs`
    (`GET`/`PUT /api/me/shortcuts`), capped/sanitized.
  - Firing a shortcut injects text into the live pane exactly as if the attached human typed it
    (`POST /api/sessions/:id/inject`, `TerminalManager.injectToSession`) — same trust as attaching and
    typing, and every resulting effect is still mediated by the PreToolUse gate. Audited
    `session.inject` / `session.summarized`.

## [0.208.2] — 2026-07-16
### Fixed
- **Agent-emitted console deep-links now use the tenant's real FQDN, not `127.0.0.1:<port>`.** Links an
  agent handed to a human (e.g. a `publish` "View it: …" Library link) were built from `AOS_URL`, which
  is the **loopback** base the OS-owned MCP tools call the API on — correct for requests, unusable for a
  human. The launcher now also exports `AOS_PUBLIC_URL` (the tenant's `consoleOrigin` —
  `AGENT_OS_PUBLIC_URL`/config `publicUrl`/subdomain), and `memory-mcp`'s `consoleLink` prefers it,
  falling back to the loopback base only in dev/demo where no public origin is configured. Out-of-band
  notifier links (already built server-side from `consoleOrigin`) were unaffected; this closes the same
  gap for anything the agent itself prints.

## [0.208.1] — 2026-07-16
### Changed
- **Connections → Creds → GitHub: OAuth creds now sit above the company-bot creds.** The per-member OAuth
  **Client ID / secret** (the essential setup that drives Connect GitHub) is shown first; the optional
  **company-bot** App ID / private key (the safety-net baseline) moved below it — reflecting that the bot is
  an add-on, not the primary credential. Card ordering only. (`web/src/App.tsx`)

## [0.208.0] — 2026-07-16
### Added
- **Share a Library deliverable with the team and the web.** An artifact was previously visible only to
  its producer (plus owner/admin) and reachable only behind the console login. The detail panel now has a
  Share section (owner/admin, or the member whose session produced it) with two independent toggles:
  - **Shared with workspace** — flips tenant-wide visibility; every member then sees the deliverable in
    their Library (on top of the existing provenance rule).
  - **Public link** — mints an unguessable, revocable `/shared/<token>` URL served **before** the member
    gate, so anyone with the link can view/download it with no login (the same secret-in-URL model as
    inbound `/hooks`). Toggling it off revokes the link. The URL is copy-to-clipboard (insecure-context
    fallback for the plain-HTTP tailnet).
  New `artifacts.shared_team`/`share_token` columns (unique partial index on the token), store methods
  `setTeamShared`/`setPublic`/`getByToken`, `POST /api/artifacts/:id/share`, and the public
  `GET /shared/:token` route. The public route is hardened: HTML/SVG is served under
  `Content-Security-Policy: sandbox` (opaque origin — a shared page's scripts can't read cookies or call
  same-origin `/api`) plus `X-Content-Type-Options: nosniff`, mirroring the console's iframe sandbox. The
  byte-range/streaming logic is shared with the authenticated raw route. Every share change and public
  view is audited (`artifact.shared`, `artifact.share.viewed`).

## [0.207.2] — 2026-07-15
### Fixed
- **Bundled `agent-os.service` no longer hangs every interactive session on a fresh hardened box.** The
  unit shipped `ProtectHome=read-only` carving out only `~/.claude`, but the launch script's
  folder-trust seeder writes `~/.claude.json` (a home-root file, atomic temp+rename → needs the home
  *directory* writable). The write failed silently, so trust was never recorded and interactive sessions
  parked forever on Claude Code's "Do you trust the files in this folder?" prompt. The unit now makes the
  service user's home writable and re-locks `~/.ssh` (`ReadOnlyPaths`), keeping `ProtectSystem=strict`.
### Docs
- **Documented three deploy gotchas hit provisioning a fresh Linux/systemd tenant.** (1) nginx: a
  hardcoded `proxy_set_header Connection "upgrade";` 502s **every** non-WebSocket request (the Node
  server treats it as a socket-upgrade attempt and drops the connection) — front the app with the
  conditional `map $http_upgrade $connection_upgrade` instead. (2) systemd: every `ReadWritePaths=`/
  `ReadOnlyPaths=` path must already exist under `ProtectHome=read-only` or the unit dies with
  `status=226/NAMESPACE`; on a fresh box `mkdir -p ~/.config ~/.cache ~/.claude` first. (3) the
  trust-dialog hang above. README + `agent-os.service` comments + CLAUDE.md.

## [0.207.1] — 2026-07-15
### Fixed
- **The Chat window now only ever shows chat-started sessions.** The chat *list* already filtered to
  `sourceKind === 'chat'`, but the open-conversation view keyed off the URL, so a deep-link to a
  non-chat session id (a terminal/automation/task run) could still render inside the Chat window. It now
  bounces such a selection back to the composer — the Chat surface stays strictly for sessions started as
  chat. (`web/src/App.tsx`.)

## [0.207.0] — 2026-07-15
### Added
- **Delegated runs announce themselves — a "picked up" beat.** When an **automation/task** run spawns
  (its owner isn't watching the console), it now fires a `started` lifecycle event → an **opt-in DM** to
  the run's owner (🚀, gated on their `dm` pref; no inbox card, so the feed stays agent-authored). Before,
  a human learned nothing about a delegated run until it finished, asked, or crashed. Deliberately scoped:
  console-spawned runs (the operator is right there) and chat runs (their thread already gets an "on it"
  ack) skip it, so it's a signal, not noise. (`src/terminal.ts`, `src/tenant-registry.ts`)
- **"Blocked" is a first-class session state.** `GET /api/sessions` now returns a server-authoritative
  **`blocked`** flag per live run (a pending `ask` question or approval gate), instead of the console
  re-deriving "waiting on you" from the message feed in three different places. New **"Blocked" filter**
  on the Sessions list; the per-session waiting bell and the Overview blocked-count now read the one
  authoritative field (the bell unions it with the old notification-card signal, so a governed block that
  wrote no card still lights up). (`src/terminal.ts`, `web/src/lib/api.ts`, `web/src/App.tsx`)

### Fixed
- **Crashes surface on the timer, not just on page load.** Crash detection (a `running` row whose tmux
  pane vanished with no end signal) ran only *lazily* — when someone read the sessions list — so an
  unattended run that OOM'd with no console open stayed `running` in the DB, and its crash card + (now
  always-on) owner/admin notification didn't fire until the next UI poll. The detection now also runs on
  the process-wide 60s sweep (`sweepCrashed`, sharing the sweep's single liveness poll), so a crash and
  its alert land promptly regardless of who's watching. Detection logic is factored into one `markCrashed`
  path shared by the lazy read and the timer. (`src/terminal.ts`)

## [0.206.1] — 2026-07-15
### Fixed
- **Interactive sessions that `report` done no longer leak their pane forever.** A `headless=0`
  (member/chat) run ends by calling `report`, which flips its row to `status='done'` while its interactive
  TUI pane is still live. `markTurnIdle` bails on non-headless runs and the idle-interactive reaper (sweep 3)
  only touches `running` rows, so the `done`+`headless=0` combination was caught by **no** reaper branch —
  its `claude` process (~350 MB RSS) lingered indefinitely. Over days these piled up until a box's RAM/CPU
  was exhausted (observed on the globex tenant: 19 orphaned tmux/`claude` processes, some 5 days old, swap
  full, load avg 100). The done-orphan backstop (reaper sweep 2) is now **lane-agnostic** — it reaps a live
  `done` pane of *either* lane on sight, keeping the existing "human attached / blocked on a person" guards
  so an actively-watched pane is never killed. The unattended idle-straggler rule stays `headless=1`-only.
  (`src/terminal.ts`.)

## [0.206.0] — 2026-07-15
### Added
- **"Open in Terminal" from a Chat session.** A chat conversation can now be handed off to the raw
  Terminal in one click — for when a technical teammate needs to watch or steer the run hands-on. Since a
  chat session is headless per-turn (no live pane between turns), the take-over is two-mode: if a turn is
  mid-flight it **claims the live pane**; if the chat is idle it **resurrects it as an interactive resident
  session that resumes the same transcript** (no seed prompt — drops you straight into a steerable claude),
  writes the launch env so ttyd can attach, and marks it claimed/sticky. Then the console opens the
  terminal on it. New `TerminalManager.takeoverToTerminal` + `POST /api/sessions/:id/takeover-terminal`;
  the launcher's resident-resume now omits an empty seed (`${TASK:+…}`) so a no-prompt resume lands in the
  interactive TUI. Same session, same governance — just the raw view. (`src/terminal.ts`, `src/server.ts`,
  `terminal/claude-launch.sh`, `web/src/App.tsx`, `web/src/lib/api.ts`.)

## [0.205.0] — 2026-07-14
### Added
- **Apps — custom domains (point `my.tool.com` at any app).** A published app can bind one or more
  custom domains in its **Settings** tab; a request whose `Host` matches serves that app **at the domain
  root** — on a **separate origin** from the console and **without a console login** (public). New
  `TenantRegistry.appForHost` resolves `Host → { tenant, app }` (10s-cached, **published-only**,
  invalidated on edit/publish), checked before tenant routing; `serveAppDomain` proxies root-mounted
  (empty `X-Forwarded-Prefix`) and strips any identity header (the app is on its own for auth). Owner/
  admin only; **reserved hosts** (the base domain, tenant subdomains, `localhost`, IP literals, the
  pinned public-URL host) and **cross-app collisions** are rejected, and a domain can't shadow the
  console. Because a domain-served app is **cross-origin**, this is also the **separate-origin isolation**
  for that path — the app's JS can't reach the console cookie/API. **DNS + TLS are external**: point an
  A/CNAME at the box and terminate TLS in front; Agent OS routes by the `Host` header. Audited
  `app.domains.set`. Verified end-to-end (bind → publish → served at root, public, console-API isolated,
  reserved + uniqueness guards, unbind, console host never shadowed); governance CI 68/68. (`src/types.ts`,
  `src/state/apps.ts`, `src/tenant-registry.ts`, `src/server.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`;
  [`docs/apps-plan.md`](docs/apps-plan.md) §9.)

## [0.204.0] — 2026-07-14
### Added
- **Apps — secrets (an app can hold a real credential).** A hosted app can now use API keys / tokens
  without hard-coding them. A key declared in the manifest's **default-deny `capabilities.secrets`**
  whose value a human sets — in the app's **Settings** tab, sealed under `app:<slug>` in the existing
  encrypted vault — is **injected as `process.env.KEY` into the app process at launch** (reuses the
  agent-`shellSecrets` machinery: `AppSupervisor` resolves via `os.secrets.getSync`, principal
  `app:<slug>` widening to tenant-wide `*`). An app can also **re-read** one on demand (e.g. after
  rotation) via **`POST /api/app/secret/get`** — both paths **capability-gated** (an app only reads keys
  it declares) and per-app-secret authenticated. The **value never leaves the vault** into audit,
  GET responses, or the console (write-only field; audit records the key + found, never the value).
  Console Settings shows **set/unset per declared key** with a masked value field; setting/clearing
  bounces the app so it picks up the change. Routes: `PUT/DELETE /api/apps/:slug/secret`,
  `POST /api/app/secret/get`; audited `app.secret.set`/`.cleared`/`.read`/`.injected`/`.unresolved`.
  The scaffold + `app-builder` agent document the pattern. Verified end-to-end (set → injected as
  `process.env` → read → undeclared-key denied 403 → value never leaked); governance CI 68/68.
  Follow-ups: `secret_request`/admin-assignment for apps. (`src/edge/app-supervisor.ts`,
  `src/tenant-registry.ts`, `src/server.ts`, `src/state/apps.ts`, `config/agents/app-builder/CLAUDE.md`,
  `web/src/App.tsx`, `web/src/lib/api.ts`.)

## [0.203.1] — 2026-07-14
### Changed
- **`policy_propose` success response now spells out propagation.** It tells the agent that an approved
  policy change hot-reloads and applies LIVE to every running session at its next gated action — no
  restart/respawn — contrasted with an MCP tool-schema change, which a live session only picks up on
  respawn. Removes the ambiguity about when a tightened guardrail takes effect. (`src/memory/memory-mcp.ts`.)

## [0.203.0] — 2026-07-14
### Added
- **Agents can propose governance-policy changes — owner-approved, tighten-only.** A new `policy_propose`
  MCP tool lets an agent that spots a weak guardrail *propose* fixing it, without ever holding the pen:
  it can `tighten` an existing rule to a stricter outcome, `reorder` a conditional rule above the
  unconditional allow rules (the first-match ordering hole that let `./iwp stripe-refund` run un-gated),
  or `add` a new `ask`/`never` guardrail. The safety story is that a proposal may only ever **tighten** —
  `applyProposal` (`src/governance/policy.ts`) refuses anything that would loosen a guardrail (verified
  both by construction and by an exhaustive monotonicity sweep over the ruleset's finite arg space),
  remove/shadow a hard-deny `never`, change the default, or add an `allow`. A valid proposal posts an
  owner-addressed `policy.proposal` inbox card carrying the delta + a computed before→after preview and
  **applies nothing** until an **owner** approves (admins may see, not apply — same guard as
  `PUT /api/policy`). Approval re-validates against the current doc, then persists + hot-reloads.
- **Policy revision history + one-click revert.** Every edit path — the console editor, the "Always
  approve" learn step, and an approved agent proposal — now snapshots the full document to a new
  `policy_revisions` table via `AgentOS.applyPolicyDocument`, so any change rolls back from
  **Settings → Governance** (owner). Agents can read the raw `rules` (`GET /api/agent/policy`) to craft a
  precise delta. Routes: `POST /api/agent/policy/propose`, `GET /api/policy/proposals`,
  `POST /api/policy/proposals/:id/{approve,reject}`, `GET /api/policy/revisions`,
  `POST /api/policy/revisions/:rev/revert`. Audited `policy.proposed` / `policy.proposal.approved` /
  `policy.proposal.rejected` / `policy.reverted`. See `docs/agent-mcp-tools.md`.

## [0.202.0] — 2026-07-14
### Added
- **Apps are permalinkable — `#/apps/<slug>`.** Selecting an app now deep-links to it (the URL is the
  source of truth, like Tasks/KB/Goals), so an app's editor is shareable + bookmarkable and opening
  `…/#/apps/mini-calculator` jumps straight to it. (`web/src/App.tsx`.)
### Changed
- **Apps editor: Preview is now the first/default tab** (Preview · Source · Settings), so opening an app
  shows it running first. (`web/src/App.tsx`.)
- **The `app-builder` agent moved to the `System` category** (alongside `agent-author`), since it's an
  OS-provided builder, not a department generalist. (`config/agents/app-builder/agent.json`.)

## [0.201.1] — 2026-07-14
### Changed
- **Apps editor: the right pane is now tabbed — Source · Preview · Settings** — instead of the three
  panels stacked vertically. The app header (name, status, publish, menu) stays pinned above the tabs;
  the Source tab holds the file-tree editor, the Preview tab the sandboxed iframe (+ the run log), and
  the Settings tab the manifest + capability editor. Just a layout change — no behaviour difference.
  (`web/src/App.tsx`.)

## [0.201.0] — 2026-07-14
### Added
- **Apps — multi-file authoring + pre-publish preview.** An app is now a normal Node project directory:
  the entry can `require('./lib/…')`, read sibling templates, serve static assets — Node runs it from
  its folder, so relative requires just work (the runtime always allowed this; now the *authoring*
  surfaces do too). `AppStore` gains **sandboxed file ops** (`listFiles`/`readFile`/`writeFile`/
  `deleteFile`, blocking path traversal + protecting the manifest and `data.db`/`app.log`), exposed as
  **console file routes** (`GET /api/apps/:slug/files`, `GET/PUT/DELETE /api/apps/:slug/file`) and
  **agent tools `app_files` / `app_write_file` / `app_delete_file`** — so the fleet can scaffold
  `routes/`, `lib/`, `templates/` instead of cramming one string. The console **Apps** page is rebuilt
  around a **file-tree editor** (open/add/delete files, per-file save) and a **sandboxed pre-publish
  preview iframe**: an owner/admin can reach an *unpublished* app through the proxy
  (`AppSupervisor.ensureReady({allowUnpublished})`) to see it before publishing — the iframe is
  opaque-origin (`sandbox` without `allow-same-origin`) so a previewed app can't touch the console.
  Editing any file bounces the app so the next preview/open reflects it; editing a live app unpublishes
  it for re-review. Audited `app.file.written`/`app.file.deleted`. Verified end-to-end (multi-file
  `require()` runs in preview; traversal + manifest + entry-delete guarded); governance CI 68/68.
  **Security note:** apps still render same-origin as the console — the preview iframe is sandboxed, but
  a top-level "Open" of a published app runs at the app-os origin; separate-origin isolation is tracked
  in `docs/apps-plan.md` §9. (`src/state/apps.ts`, `src/edge/app-supervisor.ts`, `src/server.ts`,
  `src/memory/memory-mcp.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`.)

## [0.200.0] — 2026-07-14
### Added
- **Discord thread continuity — parity with Slack.** A follow-up message inside a Discord thread already
  bound to a session now *continues that conversation* (resumes the same agent + transcript) instead of
  firing a brand-new run. Before this, every message in a Discord thread re-triggered a fresh,
  duplicate-and-competing session; only Slack had continuity. The Discord message parser now surfaces
  plain (non-@mention) guild messages — flagged `mentioned:false` — so a thread reply like "ok, now do X"
  reaches the dispatcher, which routes it to the bound session via the new
  `Automations.continueDiscordThread` / `TerminalManager.sessionForDiscordThread` (line-for-line analogues
  of the proven Slack path); a non-mention message that isn't a live-thread continuation is dropped, so
  ordinary channel chatter never spawns a run. The `/agent` router also spawns Discord chat sessions
  **resident** (warm) now, matching Slack, so follow-ups deliver into the live pane. (`src/connectors/discord.ts`,
  `src/edge/discord-socket.ts`, `src/edge/automations.ts`, `src/terminal.ts`)

### Fixed
- **Unattended-run crashes are no longer silent.** A crash of a session with *no human owner* (a pure
  `automation:`/`task:` run — e.g. a nightly cron agent that dies at 3am) used to notify **nobody**: its
  crash card was addressed to `sessionOwner`, which resolves to empty, so it was invisible in every
  member's inbox and DM'd no one. `notifySessionEvent` now treats a **crash as an always-on failure
  signal**: the owner is DM'd regardless of their opt-in `dm` preference, and an ownerless run **escalates
  to the `admins` tier** — so an unattended crash always reaches a person. Routine `waiting`/`completed`
  beats stay opt-in owner-only (no flood). (`src/tenant-registry.ts`)
- **Chat-triggered runs no longer leave their thread hanging on crash or no-report completion.** The
  Slack/Discord chat-mirror only fired on an explicit agent `report`. A chat-spawned run that **crashed**,
  or that **exited cleanly without calling `report`**, posted its outcome to the console inbox but never
  back to the originating chat thread — the human who pinged it saw silence. Both end paths now mirror a
  finish/crash line into the bound thread (no-op for non-chat runs). (`src/terminal.ts`)

## [0.199.0] — 2026-07-14
### Added
- **Apps — background dispatch (apps trigger agents).** A hosted app can now hand work to an agent in
  the background — a CRM's "draft a follow-up" button asking a writer agent, say. New loopback route
  **`POST /api/app/dispatch`**, authenticated by the app's per-launch `AOS_APP_TOKEN` (header
  `x-aos-app-secret`, verified by the supervisor) and gated by the manifest's **default-deny
  `capabilities.dispatchAgents`** — an app may only trigger agents it declares. A dispatch becomes a
  governed **`TaskStore` task** (`createdBy = app:<slug>` provenance, **run-as = the current UI member**
  forwarded from the trusted `X-Aos-Member`, else the app's owner), auto-dispatched via the existing
  task engine (pile-up guard + attempts ceiling), so the agent's work still passes the gateway — no new
  trust surface. Optional bounded synchronous **`wait`** blocks until the delegate finishes; otherwise
  the app polls **`GET /api/app/dispatches?slug=…`** for results. The scaffold template + the
  `app-builder` agent's CLAUDE.md now document the protocol. Audited `app.dispatch`. Verified
  end-to-end: a hosted app calls back with its own token → capability gate denies undeclared agents
  (403) → an allowed dispatch creates the task with the right provenance/assignee/run-as; governance CI
  68/68. Follow-ups: vault secrets, Linux uid-isolation, `app_history`/`app_revert`, `/api/app/notify`.
  (`src/server.ts`, `src/state/apps.ts`, `config/agents/app-builder/CLAUDE.md`;
  [`docs/apps-plan.md`](docs/apps-plan.md).)

## [0.198.0] — 2026-07-14
### Added
- **`app-builder` — a dedicated hosted-apps agent in the library.** A ready-made catalog agent
  (`config/agents/app-builder/`, Engineering, install-on-demand from the agent Library like the
  department generalists) whose CLAUDE.md teaches the whole Apps workflow: the single-file Node
  contract (bind `process.env.PORT`, honour `X-Forwarded-Prefix`, persist to `$AOS_APP_HOME/data.db`
  via `node:sqlite`, trust the `X-Aos-Member` header, zero deps), the `app_create`/`app_list`/
  `app_update` tools, the **proposed → a human publishes** review flow, and a worked mini-CRM shape. So
  "build me a little tool / CRM / internal form" now has an agent that knows how — instead of relying on
  a generalist stumbling into the `app_*` tools. Install it from **Agents → Library**. (No code change —
  the catalog auto-scans the bundle folder.) See [`docs/apps-plan.md`](docs/apps-plan.md).

## [0.197.0] — 2026-07-14
### Added
- **Apps — authoring (agents + humans build hosted apps).** Building on the v0.196.0 hosting core, apps
  can now be *created and managed* — by humans in the console and by agents via MCP tools, with **no seed
  apps** (the fleet writes them). **Console Apps page** (owner/admin, `Blocks` nav, Beta): list apps with
  live status (proposed / running / idle / crashed), create (slug + name → scaffold), a manifest +
  **default-deny capability** editor (egress · lifecycle · agents-it-may-trigger · vault secrets) and a
  `server.js` source editor, **publish/unpublish** (the code-review gate that makes an app routable),
  open-in-tab, stop, delete, and a run-log tail — over `GET/POST /api/apps`, `GET/PUT/DELETE
  /api/apps/:slug`, `POST /api/apps/:slug/{publish,unpublish,stop}`. **Agent tools** `app_create` /
  `app_list` / `app_update` (loopback, session-secret gated): an agent builds a single-file app by
  passing the `server.js` source (like `agent_create`'s `claudeMd`); it lands **proposed** and posts an
  `app.proposed` inbox card for an owner/admin to review + publish. Editing a **live** app via
  `app_update` **unpublishes it for re-review** — app code never goes live without human sign-off.
  Audited `app.created`/`app.updated`/`app.published`/`app.unpublished`/`app.deleted`. Follow-ups:
  `/api/app/dispatch` (background agent triggers), vault secrets, Linux uid-isolation,
  `app_history`/`app_revert` revisions, multi-file bundles. (`src/server.ts`,
  `src/memory/memory-mcp.ts`, `src/terminal.ts`, `web/src/App.tsx`, `web/src/lib/api.ts`;
  [`docs/apps-plan.md`](docs/apps-plan.md), [`docs/agent-mcp-tools.md`](docs/agent-mcp-tools.md).)

## [0.196.3] — 2026-07-14
### Changed
- **Standardized browser-tab titles across the whole console.** The tab title now leads with the current
  page — `<page> · <tenant> · Agent OS` (e.g. `Tasks · northwind · Agent OS`) — instead of just
  `<tenant> · Agent OS`, so pinned/duplicated tabs are distinguishable at a glance. An open session or
  agent-detail page uses its own name (`<session title>` / `Agent · <id>`), and the unread-notification
  `🔔 (N)` prefix is preserved. Page names now come from one `ROUTE_TITLES` map that also drives the
  header `<h1>`, so the tab and the on-screen heading can never drift. (`web/src/App.tsx`.)

## [0.196.2] — 2026-07-14
### Added
- **`ask_human` can offer one-click choices.** The tool takes an optional `options` list (up to 8); the
  question then renders as **clickable buttons** in the human's Inbox and in Chat, and their reply is the
  option they pick (they can still type a different answer). This is the governed, works-everywhere
  answer to Claude's native multiple-choice picker (which is denied — it hangs unattended runs, v0.195.1):
  same delightful UX, real tool result, no native-tool interception. (`src/memory/memory-mcp.ts`,
  `src/server.ts` `/api/ask`, `src/terminal.ts` `askQuestion` → message `args.options`, `web/src/App.tsx`
  Chat + Inbox question cards.) Also folds the siteboon/claudecodeui (Agent SDK `canUseTool` +
  interactive-tool bridge) findings into `docs/sdk-chat-runtime-plan.md`.
### Changed
- **Chat is now a pinnable nav item, hidden by default, tagged Beta.** Moved out of the hardwired sidebar
  into the pin-customizable nav (not in the default pin set) — it lives under **Manage** until a member
  pins it to Main, so the console isn't cluttered for people who don't use it — and carries a small
  **Beta** badge. (`web/src/App.tsx`.)
- **New-chat screen no longer buries the message box.** With many agents the composer was pushed off the
  bottom of the screen. The agent list now scrolls in a capped area while the heading and the message box
  stay fixed and visible, plus a filter box appears when there are more than six agents. (`web/src/App.tsx`.)

## [0.196.1] — 2026-07-14
### Fixed
- **Sessions filters now survive leaving the page and coming back.** The sessions list's filters
  (status / agent / source / mode / owner / search / My-All / sort) were mirrored only to the URL hash
  query — a refresh or deep-link restored them, but clicking the sidebar's **Sessions** link routes to a
  bare `#/sessions` with no query, so every filter snapped back to its default. They're now also mirrored
  to `localStorage` (`aos_sessions_filters`) on every change and seeded from there when the URL carries no
  query, so the last-used filter is restored when you navigate away and return. (`web/src/App.tsx`.)

## [0.196.0] — 2026-07-14
### Added
- **Apps — hosting core (first slice).** The foundation for hosting small server-side apps (a mini-CRM,
  an internal mini-tool) inside a tenant, built by agents + humans (never seeded). An **App** is a folder
  under `<home>/apps/<slug>/` (`app.json` manifest + Node source + its own private `data.db`), reached at
  **`/apps/<slug>/…`** through the same authenticated reverse-proxy the terminal uses. This slice ships
  the runtime spine: the `AppStore` (disk-backed manifest CRUD + a base-path-aware scaffold), the
  `AppSupervisor` (spawns each app as a supervised child Node process on an ephemeral loopback port,
  polls readiness, **scale-to-zero** idle-reaps it, restarts `resident` apps with backoff, mints a
  per-launch `AOS_APP_TOKEN`), and the `/apps/<slug>` HTTP + WebSocket proxy (login-gated, strips the
  mount prefix, injects a **trusted** `X-Forwarded-Prefix` + `X-Aos-Member`/`X-Aos-Role` after stripping
  any client-supplied spoof). Capabilities are **default-deny** (`dispatchAgents`/`egress`/`secrets`,
  `dependencies:'stdlib'`); a proposed app is inert until published. Reuses the terminal-proxy machinery
  and needs no new trust boundary — an App can't do anything the gateway doesn't mediate. Background
  agent-dispatch (`/api/app/dispatch`), vault secrets, Linux uid-isolation (`launcher.ts` `start_app`),
  the `app_*` agent tools, and the console Apps page land in follow-ups. Design of record:
  [`docs/apps-plan.md`](docs/apps-plan.md); pillar 13 in [`docs/PILLARS.md`](docs/PILLARS.md).
  (`src/state/apps.ts`, `src/edge/app-supervisor.ts`, `src/server.ts`, `src/kernel.ts`,
  `src/tenant-registry.ts`, `src/home.ts`, `src/types.ts`.)

## [0.195.1] — 2026-07-14
### Fixed
- **Agents can no longer hang a run on the native `AskUserQuestion` picker.** Claude's built-in
  `AskUserQuestion` tool renders an interactive multiple-choice prompt in the terminal TUI and blocks the
  turn until someone presses Enter at the keyboard — but an Agent OS run has no human at the terminal
  (chat/automation/task/Slack runs are unattended). So an agent that reached for it (e.g. asked to "ask a
  question") would **hang forever**: no turn output, nothing in the Inbox, a stuck pane — and in the new
  Chat surface it looked like the question tool "wasn't rendering." The launcher now **denies
  `AskUserQuestion`** (`terminal/claude-launch.sh`; deny rules apply even under
  `--dangerously-skip-permissions`), and the operating notes steer agents to **`ask_human`** (governed →
  Inbox card + DM, blocks for the reply) or plain prose — both work in every surface, including Chat.
  This was a latent bug for all unattended runs, surfaced by the Chat work. (`terminal/claude-launch.sh`,
  `src/terminal.ts`.)

## [0.195.0] — 2026-07-14
### Fixed
- **Plain-text links in the terminal are now clickable — no scheme needed, and OSC-8 markdown links work
  too.** Two gaps from the v0.192.0 rework:
  - The custom link matchers were too narrow: a bare domain only clicked if its TLD was in a short list,
    and a `host/path` with an unusual TLD didn't match at all. Rewrote them — a broad common-TLD list for
    bare `example.com`/`my-shop.store`, and **any multi-label host that carries a `/path` is treated as a
    URL** (`foo.bar/baz`, `docs.github.io/xterm`) since the slash is a strong signal — while still NOT
    linking `Component.tsx`, `src/main.rs`, or version strings. The provider is now registered after the
    renderer and wrapped so a bad row can't break linkification. (`web/src/Xterm.tsx`.)
  - **tmux was silently stripping every OSC-8 hyperlink** (claude's markdown links) before they reached
    the browser, because the outer terminal wasn't advertised as hyperlink-capable. Added `hyperlinks` to
    tmux's `terminal-features`, so OSC-8 links now flow through and open on click via `<Xterm>`'s
    `linkHandler`. (`src/edge/session-backend.ts`, `scripts/termbed.mjs`.)
- Test bed: `scripts/mouse-tui.mjs` now prints the realistic link cases (trailing punctuation, in a
  sentence, parenthesised, uncommon TLD, an OSC-8 link, non-link tokens), and `termbed.html?strict=0`
  renders without React StrictMode so the prod single-run behaviour can be reproduced. Verified 13/13 via
  Playwright against the mouse-reporting harness in both StrictMode configs. (`web/src/termbed.tsx`.)

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
