# The unified activity feed (`os.feed`)

## Why

The console today asks a human to reconcile four separate surfaces — **inbox · tasks · sessions ·
notifications** — that are really the *same work* seen at different stages. The result is clutter: you
can't tell at a glance who is asking what, resolved items vanish (no history), and the inbox is dead
weight unless there's a live question.

The feed reframes all of that as **one time-ordered stream of work, read by time or by outcome**, where
a human is only ever pulled in for the decisions the fleet genuinely can't make itself. The stream *is*
the history — nothing disappears when you answer it.

## The one idea: a derived view, not a new store

There is **no `feed` table**. Every line in the stream is a row that already exists in `term_sessions`,
`approvals`, or `questions`. `FeedStore` (`src/state/feed.ts`) `UNION ALL`s them into one shape with
attribution joined in. Nothing is written here; the source rows stay the system of record. This is why
the change is small — the feed is a *query*, and the old `messages`-backed inbox stops being a read path.

## The join (right to left)

```
goals ←(tasks.goal_id)— tasks ←(tasks.last_session_id)— term_sessions ←(approvals.run_id / questions.run_id)— approvals · questions
```

Each source branch LEFT JOINs the session → its task (`last_session_id`) → the task's goal, so the goal
tag and run-as/provenance are populated on every line that has them.

| Source row | Becomes | `state` |
|---|---|---|
| `term_sessions` (running) | a live line | `running` |
| `term_sessions` (done/stopped/crashed) | a finished line (outcome, rating, cost) | `done` |
| `approvals` (pending) | a decision | `decision` |
| `approvals` (approved/rejected/cancelled) | resolved history | `done` |
| `questions` (pending) | a decision | `decision` |
| `questions` (answered) | resolved history | `done` |

## Attribution, always

The thing the old inbox lacked. Every `FeedItem` carries `agent` (`term_sessions.agent`), `runAs`
(`term_sessions.run_as` → the accountable human), `spawnedBy` (raw provenance — `automation:…`, `task:…`,
`chat:…`, a member id, or null), and `goal` (via `tasks.goal_id`). "Who is asking what" is answered in
the row itself.

## History that doesn't disappear

`FeedStore.trail(runId)` rebuilds the step-by-step past of a line from the **append-only** logs —
`audit_events` (keyed by `run_id`) unioned with `task_events` (keyed by `session_id`), oldest first.
Because nothing is stored on the card, a resolved decision keeps its full trail forever: *asked → you
decided → what happened*.

## Scoping

Mirrors `TerminalManager.canViewSpawn`/`canViewRow`: owner/admin see everything; otherwise a row is
visible when the viewer is its `run_as`, spawned it directly, or created the automation that did. Applied
in SQL so keyset pagination stays correct.

## API

- `GET /api/feed?filter=all|needsYou|running|done&goal=<id>&cursor=<c>&limit=<n>`
  → `{ items: FeedItem[], nextCursor, counts: { needsYou, running, doneToday } }`.
  The **goal lens** is the same endpoint with `?goal=`; the **"Needs you"** rail is `filter=needsYou`
  (= `approvals.status='pending' ∪ questions.status='pending'`), not a stored list.
- `GET /api/feed/:runId/trail` → `{ steps: TrailStep[] }`. 404 (no existence leak) when the caller can't
  view that run.

Pagination is keyset: `nextCursor` is `"<ts>:<uid>"`, and `uid` (`"<source>:<id>"`) is the stable
tiebreak across the union.

## Schema touched

- `approvals.resolved_at` (new) — questions already had `answered_at`; this brings approvals to parity so
  a resolved decision sorts by *when you decided*, not when it was raised. Stamped in `SqliteApprovals`
  `resolve()`/`cancel()`.
- Indices: `term_sessions(status, updated_at)`, `approvals(status, created_at)`,
  `questions(status, created_at)`, `tasks(last_session_id)`.

## Verification

`scripts/feed-smoke.cjs` (in `npm run test:governance`) drives `FeedStore` over an in-memory DB: union
ordering, attribution/goal joins, JSON arg parsing, counts, every filter, the goal lens, viewer scoping,
keyset pagination, and the trail.

## Folded: the `messages` notification class (v0.350.0)

A fourth union branch folds the notification/update cards from `messages` into the stream, so the old
inbox is no longer a separate read path:

- **Included** — `update` (an agent's progress note), `notification` (a session-less `notify`/system
  card), `task` (a Tasks notification), `artifact` (a published deliverable). All carry the new
  `state = 'info'` (neither a decision nor running/done — an ambient event).
- **Excluded** — `approval` and `question` (their own branches already cover them), and `completed`
  (it duplicates the session's own `done` line). Dismissed cards (`dismissed_at`) drop out.
- **Visibility** mirrors `TerminalManager.canViewMsg` = `canViewAudience` OR `canViewRow`. The branch
  projects an `aud_member` scope column (a `member`-audience card's target), and the outer non-admin
  scope ORs it with the session's `run_as`/`spawned_by` — exactly reproducing the rule in SQL.

## Live progress + connected lines (v0.352.0)

- **What a running session is doing right now.** The `/api/feed` handler enriches each `running` item
  with `lastActivity` — the newest legible thing the agent did, from `latestActivity()`: it scans the
  audit tail newest-first through the same `classifyActivity` the activity trail uses (first non-noise
  primitive wins), falling back to the latest `update` note. The console shows it as a live one-liner
  under the title, refreshed by the 4s poll — visibility without opening the terminal. On finish, the
  run's `report_summary` is already the line.
- **Every line connects to its object.** `FeedItem.target` (`feedTarget()`) decodes what a line is
  *about* from its kind + run id: session/approval/question → the session; a folded message card → its
  encoded `session_id` (`task:<id>` → the task, `goal:<id>` → the goal, a real id → the session). So a
  "Task done" card now opens its **task** and names it (the card's event + the task title, e.g.
  *"Task done — Write the API reference"*) instead of pointing at a dead run id.

## Hierarchical feed — folding the hand-off chain (v0.365.0)

The Feed lens groups session lines by the delegation chain instead of listing every run flat:

- **Fold a conversation** — runs sharing a `threadId` (`claude_session_id`, i.e. pokes/continuations)
  collapse to their newest line.
- **Nest a delegation** — a run whose `parentThreadId` is present nests under the caller conversation
  that spawned it. A root with descendants shows a **"N delegated runs"** toggle, collapsed by default.
- **Decisions stay flat** — only session lines fold. Pending approvals/questions and notifications remain
  top-level, so collapsing a chain never hides an action item.

Thread identity is enriched onto session-backed items in the `/api/feed` handler via
`TerminalManager.threadsFor(runIds)` — a thin public wrapper over the existing `chainLinks` (session →
its task → the task's `caller_claude_id`), so the feed and the sessions list/chain rail derive the tree
the same way. The client builds the forest from `threadId`/`parentThreadId` and renders it indented; the
grouping is within the loaded page (like the sessions list).

## Not in this slice

Retiring the `messages` read path entirely (it remains the write-ahead for notifier delivery) and any
per-member read/dismiss state on the feed itself.
