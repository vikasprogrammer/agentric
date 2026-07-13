# Daily Digest ("Today") — plan

A tenant-wide daily standup: **what the fleet did today**, browsable as a dashboard and posted to
Slack at end of day. One line or two per session, rolled up.

**Decisions locked:**
- Capture = automatic at session end (no agent action, no LLM) — already ships via `writeEpisode`.
- Audience = **tenant-wide** (one fleet digest to a shared channel).
- The digest is a **step in the Dreaming pass**, not a standalone timer — shares its tick, KB home, Slack seam.
- **One combined Slack post**, two sections: **📋 Today** (per-session changelog) + **🧠 Learned**
  (Dreaming guidance/recommendations). The changelog is the new render; the guidance is Dreaming's existing output.
- **EOD trigger:** post once per tenant-local day at `digestHour` (default 18), guarded by a
  `digest.posted` audit; the dashboard + KB page refresh on **every** pass, only the Slack post is gated.
- **Body thresholds on `episodeSalience.importance`** — salient episodes in the body, full tally in the
  header. (Live dry-run showed ~half a busy day is low-importance `stopped` test runs; without a
  threshold the digest reads as noise.)
- **Manual "Reflect now" refreshes only** — it does not post to Slack; the channel is pinged solely by
  the scheduled EOD trigger. (No surprise posts from a button.)
- **Empty day** → skip the Slack post, still write the dated KB page (keeps the record continuous).
- Config lives in a **new `Settings → Dreaming` section** (not under Memory) — houses the existing
  self-learning controls + the new digest config.

## The key insight: capture already ships

Every session already writes a deterministic "what this session did" line at end:

- `TerminalManager.writeEpisode` (`src/terminal.ts:2851`) fires on every teardown — the Stop-hook fast
  path (`markTurnIdle` → `teardownUnattended` → `markEnded`), the idle backstop, and `stop`/crash paths.
- `composeEpisode` (`src/terminal.ts:3238`) builds the line **with zero LLM cost**: it prefers the
  agent's own `report` summary; failing that it summarizes the audit stream into
  `"Task: … · Outcome: success · Activity: 3 edits, 1 pr.opened, 2 approvals."`. Graded by
  `episodeSalience` (effort + friction + outcome → `importance`).
- Stored via `os.memory.store({ tags: ['episode','session-end'], type:'Insight', importance,
  metadata:{ sessionId, outcome, source, salience } })`, which lands in the `memories` table (the
  provider mirrors external backends back into it — `MirroredMemoryProvider`).

So the per-session changelog line **exists today**. The digest is a pure **read + render** over
`memories` (episodes) joined to `term_sessions` (agent, title, run_as, start/end) and `audit_events`
(approvals, PRs, tasks closed, budget stops). No new capture, no new tool, no model call.

This is the same input the **Dreaming** pass already consumes (`src/edge/dreaming.ts` reads
`memories WHERE tags LIKE '%"episode"%'`) — the digest is Dreaming's daily-window sibling, but a flat
render rather than a compounding reflection.

## Data — nothing new required, one optional durable artifact

Query for "today" (tenant, `[dayStart, dayEnd)` in the tenant's local day):

```
episodes  = memories WHERE tags LIKE '%"episode"%' AND created_at IN [start,end)
sessions  = term_sessions WHERE started_at IN [start,end)   -- agent, task/title, run_as, status
signals   = audit_events IN [start,end): counts of approval.*, git.pr.opened, task.updated(done),
            budget stops, session.error/episode.error
```

Everything is already persisted and indexed by time. **No schema change.**

Optional (recommended): at EOD, render the digest into a **dated KB journal page** —
`KbStore.write({ section:'operations', slug:'daily/<YYYY-MM-DD>', … })` (`src/state/kb.ts:44`). That
makes each day a durable, revisioned, browsable artifact on the console **Knowledge** page and gives
the Slack post a permalink to "see the full day." Pure render of the query, so it's rebuildable.

## Render — deterministic, matches the Dreaming style

`renderDigest(os, day) → { markdown, slackBlocks, stats }` in a new `src/edge/digest.ts`:

- **Header:** `Fleet — Mon Jul 13 · 14 sessions · 11 success / 2 partial / 1 stopped`.
- **By agent:** group episodes by `agent`; per agent, its session lines (title + outcome emoji),
  most-salient first (`importance` desc). Cap N per agent, "+3 more" overflow.
- **Highlights:** cross-fleet counts from `signals` — PRs opened, approvals granted/rejected, tasks
  closed, budget stops, errors.
- Skip zero-signal noise (episodes that `composeEpisode` already returns `null` for never land).

No LLM. If we later want a one-paragraph narrative, that's an opt-in layer (a scheduled
`digest-writer` agent via `kb_write`), exactly how the "kb-gardener" layers on Dreaming.

## Fold into Dreaming — one "reflect" pass, three steps

The digest is **not** a second scheduler. It rides the pass that already exists:

- **Scheduled** (`src/server.ts:282`): `DreamingEngine.dream() → Consolidation.run()` fires every
  `dreamingEveryHours`. Add a third step: `renderDigest() → maybe post`. The chain becomes
  **reflect (dream) → learn (consolidate) → report (digest)**.
- **Manual** (`POST /api/dreaming/run`, `src/server.ts:2322`): same third step appended, so "Reflect
  now" also refreshes today's digest.

New module `src/edge/digest.ts` exports `renderDigest(os, day)` (pure read+render, above) and a thin
`Digest.run(os, slack)` that renders today, writes the dated KB page, and — if it's time — posts to
Slack. Delivery, all reusing existing seams:

1. **Console "Today" dashboard** — new page (primary nav, near Audit) reading `GET /api/digest/today`
   (owner/admin). Live view of the current day; date-picker pages back via the KB journal pages.
2. **EOD Slack post — combined with Dreaming's learnings in one message.** Dreaming already produces a
   distilled guidance string (`DreamResult.guidance`) + a `fleet-learnings` KB page but posts nothing to
   Slack today. The digest supplies the delivery both halves ride:
   > **Today** — 14 sessions · 11 ✓ / 2 partial / 1 stopped … *(digest render)*
   > **Learned** — recurring friction: approvals on `git.push`; recommend auto-allow … *(dreaming guidance)*

   `Digest.run` composes `renderDigest(today).slack` + the `guidance` returned by the same pass's
   `dream()`, `postMessage` (`src/connectors/slack.ts:38`) to the configured channel, writes the KB
   page, and stamps `digest.posted` as the **once-per-day idempotency guard** (mirrors `learning.dreamed`).

### The cadence tension (needs a decision — see Open questions)

Dreaming runs every `dreamingEveryHours` (may be <24h or >24h); the digest's Slack post is a
**once-a-day, at-a-set-hour** event. So the digest step must gate its *Slack post* independently of the
pass firing: render/refresh the dashboard + KB page on **every** pass (cheap), but only `postMessage`
when (a) the tenant-local hour ≥ `digestHour` and (b) no `digest.posted` audit exists for today. The
dashboard is always current; the Slack ping happens once, at EOD.

## Config — Settings → Digest

Stored in `settings` (hot-read via `settings.ts`): `digestEnabled`, `digestChannel` (Slack id/name),
`digestHour` (tenant-local EOD, default 18), `digestScope` (fixed `tenant` for now). If `digestChannel`
is unset → skip the Slack post, still render dashboard + KB page (fail-soft, no hard Slack dependency).

## Endpoints / surfaces (all reuse existing patterns)

- `GET /api/digest/today?date=YYYY-MM-DD` — owner/admin, returns `{ markdown, stats, byAgent }`.
- Digest refresh is driven by the Dreaming pass — no separate `/api/digest/run`; "Reflect now" covers it.
  (A "Post digest to Slack now" button, if wanted, is a small `POST /api/digest/post`.)
- Settings read/write via the existing `settings.ts` plane.

## Build / ship notes

- New: `src/edge/digest.ts` (`renderDigest` + `Digest.run`), a `GET /api/digest/*` handler, a Settings
  block, and the console **Today** page (`web/src`). Append the digest step to **both** the scheduled
  chain (`src/server.ts:282`) and the manual `/api/dreaming/run` (`src/server.ts:2322`).
- Server/API + tick = `npm run build` **+ restart** to take effect; web = `cd web && npm run build`.
- No new scheduler, no new MCP tool, no schema migration, no model dependency.

## What shipped (v0.146.0)

- `src/edge/digest.ts` — `buildDigest` (pure read) + `renderSlack`/`renderMarkdown` + `Digest`
  (`today`/`refresh`/`postNow`/`maybePostEod`). Validated against a copy of the live northwind data:
  20 sessions rendered correctly, low-value test runs thresholded out, engineer's 3 PRs + the staged
  newsletter surfaced.
- **Salience rule (refined against real data):** body = episodes with `importance ≥ 0.5` **OR** any
  `done` session with a substantive (non-placeholder, ≥5-char) report title. The `OR` matters — several
  real `done` sessions ("Shipped PR #333") carried no end-of-session episode (importance 0) yet are
  exactly what the digest is for; a pure importance threshold dropped them.
- **Timezone = server-local** (the deploy box's tz). A per-tenant tz can layer on later.
- **UI:** digest config + a live "today so far" preview live in the existing **Settings → Learning**
  (Dreaming) tab — no new nav tab. A standalone **"Today" dashboard** page is deferred (the KB
  `operations/daily/<date>` page already gives a browsable daily record, and the preview covers the
  at-a-glance need).
- Wired into both the hourly upkeep tick (`maybePostEod`) and manual `/api/dreaming/run` (KB refresh, no
  Slack). Routes: `GET /api/digest/today`, `POST /api/digest/post`, digest fields on `/api/dreaming`.

## Open questions

- **EOD trigger vs. every-pass** — post once at a set `digestHour` (needs a tenant tz + once-per-day
  `digest.posted` guard), or just let the last Dreaming pass of the day carry the post? The former is a
  real "end of day summary"; the latter is simpler but fires whenever the cadence lands.
- **One message or two** — combine digest + Dreaming guidance in a single Slack post (lean: yes), or
  keep "what happened" and "what we learned" as separate messages?
- **Manual "Reflect now" → Slack?** Should hitting `/api/dreaming/run` also *post* to Slack, or only
  refresh the dashboard/KB page and leave the Slack ping to the scheduled EOD trigger? (lean: refresh
  only; never surprise the channel from a manual button.)
- **Day boundary / timezone** — tenant's configured tz (fallback server local). "today" = `[00:00,
  24:00)` local.
- **Empty day** — post a terse "quiet day, 0 sessions" or skip the Slack post entirely? (lean: skip
  Slack, still write the KB page so the date exists).
