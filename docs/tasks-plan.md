# Agentric Tasks / Work Queue — Implementation Plan

> **Status (2026-07-02): SHIPPED (v1).** Built per the §8 build order — `tasks`/`task_events`/`tasks_fts`
> tables + `TaskStore` (`src/state/tasks.ts`, `os.tasks`), the tick-driven dispatcher
> (`Automations.dispatchTask` + `buildTaskPrompt`, provenance `task:<id>`), the agent-loopback +
> member-console `/api/tasks/*` routes, the five `task_*` MCP tools, and the console **Tasks** Kanban
> board. Run-as is **human passthrough**: a task's `owner` = the member the dispatched session acts as,
> defaulting to the creating agent's run-as, so a support→coding hand-off keeps the accountable human.
> Pillar 16 is regraded ✅. The §9 items (pool auto-assignment, agent-triggered `task_dispatch`, policy
> brake on dispatch) remain deliberate v1 cuts. The sections below are the as-built design of record.

Ship a **backlog the fleet works from**. Today Agentric has firing conditions (Automations), ephemeral
runs (Sessions), and a shared wiki (KB) — but no durable **unit of work**. A task's state lives nowhere:
it's implicit in a cron, a memory, or a human's head. The Tasks plane makes the *goal* a first-class,
persistent object with a lifecycle (`todo → doing → blocked → done`), an owner + assignee, an activity
timeline, and — the active part — the ability to **spawn an agent session that works it to completion**
and closes the loop by updating its own task.

## 0. Where Tasks sit relative to Automations, Sessions, and KB

Tasks are the missing **noun between "a trigger fired" and "a session ran"** — the persistent goal that
outlives any single session. They reuse the existing run engine rather than inventing a second one.

| | Automation | Session | KB | **Task** |
|---|---|---|---|---|
| What it is | a firing *condition* | an ephemeral *run* | a *document* | a durable *unit of work* |
| Lifetime | standing | dies when done | living, rewritten | **open → done, outlives sessions** |
| Scope | one agent | one spawn | tenant-wide | **tenant-wide, shared board** |
| Writers | owner/admin | — | many agents + humans | **many agents + humans** |
| State | enabled/disabled | running/idle | revision chain | **status machine + activity log** |
| Spawns work? | yes (its whole job) | — | no | **yes — auto-dispatch a session** |
| Governance | ungated create; **spawned run is gated** | gated (gateway) | ungated (auto-apply + audit) | **ungated task edits; spawned run is gated** |

The important line: **task edits are auto-apply + audit** (like KB — cheap, reversible via the activity
log, no approval gate), but a task **dispatching a session inherits the full gateway** — that session's
effects pass Policy/Approvals/Budget/Audit exactly like any other run. So the Tasks plane adds **no new
trust surface**: it's a durable to-do list bolted onto the run engine that already exists.

## Decisions (locked)

1. **Governance: task edits auto-apply + audit; dispatched work stays gated.** Creating/claiming/updating
   a task is ungated and audited, like KB writes — the safety net is the append-only activity log
   (`task_events`), not a human in the loop. When a task **dispatches an agent session**, that session
   runs through the normal PreToolUse gate + gateway, so every *effect* the agent has is still classified,
   approved, budgeted, and audited. We govern the *effects*, not the *intent to work*. *(An optional
   policy brake on dispatch — "this task may spend budget, needs approval to start" — is a one-line hook in
   the dispatcher; designed for, off in v1. See §9.)*
2. **Storage: SQLite-only, no on-disk mirror.** Unlike KB (markdown documents humans git-diff), a task is
   **structured state** — status, assignee, priority, an event log. There's no document to co-author on
   disk, so we skip the `<home>/kb/<section>/<slug>.md`-style mirror and keep everything in the workspace
   DB. `TaskStore`'s constructor is just `(db)`; no `paths.tasks`. (This is the one place we deliberately
   diverge from the KB pattern — noted so a future reader doesn't "fix" it.)
3. **Model: one shared board, statuses + labels, shallow hierarchy.** A task carries a `status`
   (`todo|doing|blocked|done|cancelled`), a `priority`, freeform `labels[]`, an optional single `assignee`
   (a member **or** an agent), an `owner` (the member the dispatched session runs *as*), a `mode`
   (`headless` default / `interactive`, governing how a dispatched session runs), and an optional
   `parent_id` for sub-tasks (one level in v1 UI; the column supports deeper). No projects/epics/swimlanes
   in v1.
4. **Active queue = assigned auto-dispatch + in-session claim.** Two ways work actually happens (§4):
   (a) a task with `assignee = agent:<id>` + `auto_dispatch = 1` is picked up by the scheduler tick and
   **spawned as a headless session**, guarded so it never double-fires; (b) a running agent session
   **claims** open tasks off the board via `task_claim` and drains them. Full *pool auto-assignment* of
   unassigned tasks to a worker agent is a deliberate v1 cut (§9) — it's the agent-spawns-agent frontier
   Automations also parks.

---

## 1. Data model

### 1.1 SQLite — `src/state/db.ts` `migrate()`

Add to the single idempotent `db.exec(\`...\`)` block in `migrate(db)` (`src/state/db.ts:27-340`, right
after the KB block at `:281-328`), following the exact conventions there — `CREATE TABLE IF NOT EXISTS`,
plus the FTS5 external-content table and its `_ai`/`_ad`/`_au` trigger trio copied from `kb_fts`
(`db.ts:315-328`). Older DBs pick up any later columns through the `addColumn()` helper (`db.ts:397-401`).

```sql
-- A task: shared, tenant-wide, durable unit of work. One row per task.
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,          -- short uuid (8)
  tenant        TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',  -- markdown description / acceptance criteria
  status        TEXT NOT NULL DEFAULT 'todo',   -- todo | doing | blocked | done | cancelled
  priority      INTEGER NOT NULL DEFAULT 2,     -- 0 urgent … 3 low (sort key)
  labels        TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  assignee      TEXT,                      -- NULL (unassigned) | member id | 'agent:<id>'
  owner         TEXT,                      -- member id the dispatched session runs AS (run_as); NULL = company
  parent_id     TEXT,                      -- sub-task parent (nullable)
  mode          TEXT NOT NULL DEFAULT 'headless', -- how a dispatched session runs: headless | interactive
  auto_dispatch INTEGER NOT NULL DEFAULT 0,-- 1 = tick may spawn a session for it
  due_at        INTEGER,                   -- optional soft deadline (epoch ms)
  attempts      INTEGER NOT NULL DEFAULT 0,-- dispatch attempts (backoff / give-up guard)
  last_session_id TEXT,                    -- the session currently/last working it (pile-up guard)
  created_by    TEXT NOT NULL,             -- member id | 'agent:<id>'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(tenant, status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(tenant, assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

-- Append-only activity log: comments, status changes, claims, dispatches, links.
-- This is the Tasks analog of kb_revisions — a timeline, not full snapshots.
CREATE TABLE IF NOT EXISTS task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- comment | status | claim | dispatch | assign | link
  body       TEXT,                        -- note text, or "todo→doing", or "task:<child>"
  author     TEXT NOT NULL,               -- member id | 'agent:<id>' | 'automation:<id>' | 'system'
  session_id TEXT,                        -- the run that produced this event, when applicable
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, created_at);

-- FTS5 over title + body + labels (mirrors kb_fts exactly).
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, body, labels, content='tasks', content_rowid='rowid'
);
-- + tasks_ai / tasks_ad / tasks_au triggers keeping tasks_fts in sync (copy kb_ai/kb_ad/kb_au).
```

### 1.2 Types — `src/types.ts`

Add after the KB block (`types.ts:483-529`):

```ts
export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled';

export interface Task {
  id: string;
  tenant: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;              // 0 urgent … 3 low
  labels: string[];
  assignee?: string;             // member id | 'agent:<id>'
  owner?: string;                // member id → run_as of the dispatched session
  parentId?: string;
  mode: 'headless' | 'interactive';  // how a dispatched session runs (default headless)
  autoDispatch: boolean;
  dueAt?: number;
  attempts: number;
  lastSessionId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface TaskEvent {
  id: string; taskId: string;
  kind: 'comment' | 'status' | 'claim' | 'dispatch' | 'assign' | 'link';
  body?: string; author: string; sessionId?: string; createdAt: number;
}

export interface TaskCreateInput {
  tenant: string;
  title: string;
  body?: string;
  assignee?: string;
  owner?: string;
  priority?: number;
  labels?: string[];
  parentId?: string;
  mode?: 'headless' | 'interactive'; // default headless
  autoDispatch?: boolean;
  dueAt?: number;
  createdBy: string;             // member id | 'agent:<id>'
}

export interface TaskUpdateInput {
  status?: TaskStatus;
  assignee?: string | null;
  priority?: number;
  labels?: string[];
  note?: string;                 // free-text comment → appended as a task_event
  by: string;                    // author (member id | 'agent:<id>')
}

export interface TaskQuery {
  tenant: string;
  status?: TaskStatus;
  assignee?: string;             // member id | 'agent:<id>'
  label?: string;
  query?: string;                // FTS over title/body/labels
  limit?: number;
}
```

---

## 2. The store — `src/state/tasks.ts`

A `TaskStore` class mirroring `KbStore` (`src/state/kb.ts`) but **db-only** (no `dir`):

```ts
export class TaskStore {
  constructor(private readonly db: Db) {}
  // ...
}
```

Public surface:

- `create(input: TaskCreateInput): Task` — insert a row (rev-free), append a `task_events` `status`
  row (`→todo`), and if `parentId` is set append a `link` event on the parent. Returns the task.
- `get(id): Task | undefined` and `withEvents(id): { task, events }` — a task + its timeline.
- `list(q: TaskQuery): Task[]` — board query. FTS via `bm25(tasks_fts)` when `query` is set
  (mirroring `KbStore.search`, `kb.ts:81-100`); otherwise ordered by `status`, then `priority`, then
  `updated_at DESC`. `assignee`/`label`/`status` filter in SQL/JS.
- `update(id, input: TaskUpdateInput): Task | null` — the one mutating path for edits: apply changed
  fields, bump `updated_*`, and **append one `task_events` row per meaningful change** (a `status` event
  on transition, an `assign` event on reassignment, a `comment` event for `note`). Marking `done`/
  `cancelled` is just a status transition (no separate close call).
- `claim(id, agentId, sessionId): Task | null` — the pool-drain primitive. Atomically: if the task is
  `todo` (or already assigned to this agent) and not terminal, set `assignee = agent:<id>`,
  `status = doing`, `last_session_id = sessionId`, append a `claim` event. Returns null if it was already
  claimed by someone else (loser sees null and moves on — the race resolver).
- `markDispatched(id, sessionId): void` — set `last_session_id`, `status = doing`, `attempts += 1`,
  append a `dispatch` event. Called by the dispatcher (§4), not by agents.
- `remove(id): boolean` — hard delete (owner/admin at the route layer); the activity log makes soft-delete
  unnecessary, but cascade `task_events` on remove.
- `counts(tenant): Record<TaskStatus, number>` — for the board column headers.

FTS stays in sync **via the `tasks_ai/_ad/_au` triggers only** — the store never writes `tasks_fts`
directly (same as `KbStore`).

Wire into the kernel exactly like KB (`src/kernel.ts`):

```ts
import { TaskStore } from './state/tasks';   // near :34
readonly tasks: TaskStore;                    // near :79
this.tasks = new TaskStore(this.db);          // near :115 — note: no paths arg (§Decision 2)
```

No `src/home.ts` change (db-only). Consumers reach it as **`os.tasks`**.

---

## 3. The dispatcher — reusing the run engine

The "active" half. A task becomes work by **spawning a governed session** whose provenance is the task.
We reuse the existing spawn seam rather than a parallel engine.

### 3.1 The spawn call

`TerminalManager.createSession(agent, title, task, spawnedBy?, headless?, slack?, discord?, runAs?)`
(`src/terminal.ts:468`) already takes a **free-form `spawnedBy`** string. So the dispatcher calls:

```ts
tm.createSession(
  t.assignee!.replace(/^agent:/, ''),        // the agent id
  `Task: ${t.title}`,                        // session title
  buildTaskPrompt(t),                        // §3.2
  `task:${t.id}`,                            // provenance — flows through cleanly (only 'automation:' is special-cased at terminal.ts:478)
  t.mode !== 'interactive',                  // headless (default): work-to-completion, then the pane dies → session idle.
                                             //   interactive: an attachable TUI a human drives; the isAlive guard blocks re-dispatch while it lives
  undefined, undefined,
  t.owner,                                   // run_as = the task owner (member); undefined → company identity
);
```

Provenance `task:<id>` is new. **As built:** `spaceFor` (`terminal.ts`) was extended to treat a `task:`
prefix like `automation:` — an ownerless task spawn shares the `automations` system space rather than
minting a per-task uid (a `task:<id>` is unique per task, so bucketing by it would leak a space per task);
a task WITH an owner passes `run_as` there, so its space keys off the member. Visibility: `canViewSpawn`
grants owner/admin, and the P2 run_as rule grants the task **owner**. To make sure a non-admin creator can
always see the run, the member-console create route **defaults `owner` to the creator** — so a human-filed
task dispatches as them AND stays visible to them (agent-filed tasks default `owner` to the caller's run-as,
the delegation passthrough). `spawnedByLabel` renders `task:<id>` as "Task · <id>".

Two implementation options, in order of preference:

- **Preferred — a `Tasks.dispatch(id)` method** on the Automations/edge layer that calls `createSession`
  directly with `spawnedBy = task:<id>`, reusing `TerminalManager.isAlive` (`terminal.ts:355-362`) for the
  pile-up guard and appending a `task.dispatched` audit event. This keeps Tasks self-contained.
- **Alternative — extend `Automations.fire`** with an optional `spawnedBy` override (today hardcoded to
  `automation:${a.id}` at `automations.ts:331`). That inherits the guard + `last_session_id` tracking +
  audit for free, but bends a task through an automation row it doesn't have. Only worth it if we want
  tasks to share the `once`/cron scheduler verbatim. **Recommendation: the dedicated `Tasks.dispatch`** —
  it's ~15 lines and avoids overloading the automation record.

### 3.2 The prompt — closing the loop

`buildTaskPrompt(t)` hands the agent the task **and** the tools to close it:

```
You are working task <id>: <title>

<body>

When finished, call task_update({ id: "<id>", status: "done", note: "<what you did>" }).
If you cannot proceed, call task_update({ id: "<id>", status: "blocked", note: "<why>" }).
Break large work into sub-tasks with task_create({ parentId: "<id>", ... }).
```

So the dispatched agent updates its own task — the loop is self-closing, exactly like the KB gardener
writes back what it learned.

### 3.3 When dispatch fires

Three triggers, all guarded by `isAlive(t.lastSessionId)` (never double-spawn a live task) and an
`attempts` ceiling (give up + `blocked` after N, so a failing task doesn't spin):

1. **Scheduler tick.** Piggyback the Automations `tick()` cadence (~20s, `automations.ts:449-475`): scan
   `tasks` where `status='todo' AND assignee LIKE 'agent:%' AND auto_dispatch=1 AND` no live session,
   respecting a **per-agent concurrency cap** (don't spawn a 2nd session for an agent already running one
   for a task). Dispatch the highest-priority eligible task per agent per tick.
2. **On create**, when `auto_dispatch=1` and an agent assignee is set — dispatch immediately rather than
   waiting for the tick.
3. **Console "Dispatch" / "Run now"** button (§6) — manual kick, owner/admin or a member with `canRun` on
   the assignee agent.

Agents do **not** get a dispatch MCP tool in v1 (spawning a *new* session is the agent-spawns-agent
frontier). They participate by `task_claim`-ing work into their *own* running session and by `task_create`
for sub-tasks. Pool auto-assignment + agent-triggered dispatch are §9 futures.

### 3.4 When the loop does NOT close itself — the stranded sweep

§3.2's self-closing loop rests on the delegate actually calling `task_update`. When it doesn't, the damage
is bigger than an untidy board: **the poke-back that wakes a delegating caller hangs off the TASK reaching
`done`/`blocked`** (`maybePokeCaller`, `tenant-registry.ts`), not off the delegate's session ending. So a
delegate whose run ends with the task still open strands the task in `doing` *and* leaves the caller
waiting forever — the delegation silently never completes. Nothing re-dispatches it either:
`dispatchable()` only selects `status='todo'`, so once a task is `doing` with a dead session it is inert.

Measured on the globex tenant (30 days): **43 of 307 poke-on-done hand-offs (14%)** ended that way, and
15 of the 16 stranded runs ended `outcome='unknown'` — the bucket the Insights reconcile tile deliberately
never touches — so the manual tile could not have rescued one of them.

`sweepStrandedTasks` (`edge/task-reconcile.ts`, run each tick) is the fallback. Over every non-terminal
task whose dispatched session has settled (`SETTLE_MS` after the session's **end**, not its start):

- **run reported `success`** → close the task `done`. This is the Insights tile's `apply`, now automatic;
  the store notifier then fires the ordinary "✅ Really done" poke, so the caller hears the real result
  through the normal path — one wake-up, not two.
- **anything else** (`unknown` / partial / failure / crashed / stopped) → leave the status **alone** and
  wake the caller with the delegate's last note. Never auto-marks done: a run legitimately ends mid-flight
  (waiting on CI, a human go/no-go), and calling that "finished" would be a lie.

Bounded so switching it on can't stampede a backlog: once per dead *run* (`markStranded`, keyed on the
session id, so a re-dispatch that strands again is a fresh signal), ≤3 wake-ups per tick sharing the
dispatcher's concurrency headroom, and nothing older than 3 days is ever woken — a cold stranding gets its
marker silently so it can never fire later. A row skipped for budget stays **unmarked**, so the next tick
still owes it. Replayed over the live globex backlog: settles in 3 ticks (~60s), 8 callers woken, 1 task
auto-closed, 12 cold ones marked silently.

### 3.5 Where the poke LANDS — the pane, never the status column

`pokeCaller` has two lanes: type the wake-up into the caller's live pane, or `--resume` its transcript in a
new session. Which one it takes is the whole correctness question, because the resume lane is only safe
when nothing else holds that transcript.

It used to choose on the session row's `status`, and **`status` is not liveness**. An agent that calls
`report` is stamped `done` (`reportSession`) while its claude keeps running — and that is the *normal*
shape for a caller: hand off, report, keep working while the delegate finishes minutes later. Every one of
those pokes took the resume lane and opened a second claude on a transcript the first still held. Live on
northwind 2026-08-10: `ses_f4535e8f` reported at 16:13 and worked through 16:34; its 16:31 poke spawned
`ses_441cec`, which died 28s later, and the caller — never woken — re-derived the delegate's result by
shelling out to `gh pr view`.

Liveness is therefore asked of the **pane**: `TerminalManager.reachable(sessionId)`. It refuses a run a
human `stop`ped or the sweep marked `crashed` — a surviving pane there is a leftover, not a destination —
and falls back to the row under the launcher backend, which cannot poll panes. Delivery puts the row back
to `running` + `busy_since` so the console stops reading idle through work it just triggered, and an inject
that fails on a wedged pane kills that pane before the resume, mirroring `chatSend`.

**`reachable` is the only liveness predicate; there is deliberately no second one.** It shipped beside the
older status-folding `isAlive`, and a sweep of that method's ten call sites found every one of them wrong
in the same direction — the take-over paths (`takeOverSession` / `openChatSession`) relaunched over a live
pane instead of claiming it, `agentAskStatus` graded a still-running delegate `failed`, `maybeHoldDelegate`
decided there was "nothing running to interrupt", `refreshAgentSkills` skipped the very session whose human
had just approved the skill, and the dispatch pile-up guards called a busy agent free. Their shared shape:
the fallback for "dead" is almost always `claude --resume`, so a false negative costs a rival claude on a
live transcript. So `isAlive` was deleted rather than fixed — with two predicates a nine-tenths-correct
choice is always available, and this is the class of bug that recurs (the `resident` gate on
`deliverToResident`, northwind 2026-08-06, was the previous instance).

Widening the pile-up guards is bounded, not open-ended: the idle sweep's DONE-ORPHAN branch exists exactly
to reap an unattended `done` row still holding a pane, and a human forcing work through passes
`guard: false`. Pinned by `scripts/poke-warm-caller-test.cjs`.

### 3.6 The wake QUEUE — producers enqueue, one deliverer decides (`src/edge/wakeups.ts`)

§3.5 fixed *which* liveness question to ask. It did not fix **where the question is asked**, and that was
the actual defect: the lane was chosen inline, at fire time, by whichever producer happened to be firing,
with no record that an attempt had been made. Four bugs came out of that one decision — the stranded
hand-offs of §3.4 (a transition the delegate had to volunteer), the `status`-vs-pane lane of §3.5,
`isAlive`'s ten wrong call sites, and finally liveness asked of the **transcript** instead of the **agent**:
northwind 2026-08-16, task `tsk_f2d63c5f` closed while `check-resolve-tickets` had been running since 12:36
under transcript `a2182167`, so the poke resumed its 2-day-old caller transcript `83bc1aa7` and both runs
worked the same support ticket. Every fix was correct; none of them touched the class.

So the decision moved behind a durable queue. Producers (`maybePokeCaller`, `sweepStrandedTasks`, anything
later) only **enqueue** an `agent_wakeups` row; `WakeupQueue.deliver` is the only code that picks a
destination, and it does so **per AGENT, never per transcript** — because all of an agent's sessions run
out of one workspace folder, so the agent is the real unit of exclusion:

1. a live session on the wake-up's **own transcript** — the caller continues its own plan;
2. any other live session of that agent — the message carries the task id, title and the delegate's note,
   so it stands alone, and it beats starting a rival claude;
3. nothing of that agent is live → `--resume` the transcript in a fresh `poke:` run.

What the row buys, beyond one code path: **enqueue still delivers synchronously** (the tick is the retry,
not the schedule, so a poke lands in the same second it fires); an undeliverable wake-up **stays pending**
instead of being decided-and-forgotten — a wedged sibling is left alone rather than resumed past, and the
concurrency cap defers the resume lane rather than dropping it; a hand-off re-fired while pending
(done→blocked→done) wakes the caller **once**, with the latest message; several pending wake-ups
**coalesce** into one resume carrying all of them, so N delegates finishing while the caller is down cost
one claude and lose nothing. And it fails **loudly**: after 5 attempts (or 24h) the wake-up expires with an
`agent.wakeup.expired` audit and an inbox card to the run's owner quoting the message that never landed —
a queue whose failure mode is a silent row would be the original bug wearing a different hat.

Pinned by `scripts/wakeup-queue-test.cjs`.

### 3.7 Who a `blocked` wake-up is FOR — `blockedOn`

The poke fires on `blocked` as well as `done`, which is right whenever the caller can act: re-scope the
work, route around the blocker, chase whoever owes it. It is waste when the blocker is a person. Twice on
northwind 2026-08-17: `tsk_f81b27d7` ("Blocked on human approval for the merge only") woke `prod-monitor`,
which answered *"Leaving this blocked. @engineer stopped in the right place — I am not merging it and
neither should any agent"* and ended; `tsk_5aa0fd20` ("no deletions without founder sign-off") woke
`agent-author` identically. Both agents were right, and neither could have been anything else — each wake
was a `--resume` on a large transcript (~$8-10 a turn at that size) that moved nothing.

So the delegate declares what it is waiting on: `task_update({ status:'blocked', blockedOn })`, one of
`human` | `agent` | `external`. `human` skips the caller wake entirely — the owner already gets the
"Task blocked — needs you" card + DM from `taskCard`, so nothing is lost — and audits
`agent.poke.skipped` with `reason: 'blocked-on-human'`. `agent`/`external` wake the caller exactly as
before, and an **unstated** blocker also keeps the old behaviour: this only ever narrows on an explicit
declaration.

Declared, never inferred. A heuristic over the note's prose would misroute precisely when the wording is
unusual, and the delegate already knows which of the three it is. And declared means REQUIRED: the field
shipped optional, and the fleet's first afternoon with it produced four human blockers and zero
declarations — including one from a session started after the deploy, so the field was in its tool list and
simply went unused. An optional field on a tool agents call with minimal args is not a field. `POST
/api/tasks/update` now refuses `status:'blocked'` without a blocker and returns the three choices; the MCP
client sends an explicit `null` when the agent omitted it, so the refusal can be aimed at CURRENT clients
only — an MCP process outlives a server upgrade, and refusing a pre-upgrade client would leave a running
agent unable to block at all (`scripts/blocked-declaration-test.cjs`). The flag is cleared whenever the task
leaves `blocked`, so a stale "waiting on the founder" can't mute a later done-poke. Pinned by
`scripts/blocked-routing-test.cjs`; the board shows it as a `waiting on …` chip, since the column header
("Needs you") is only true for one of the three.

---

## 4. Agent-facing MCP tools — `src/memory/memory-mcp.ts`

Five tools on the OS-owned MCP server (every claude-code session already gets `agentos` injected — no new
server wiring). Each is a `TOOLS` declaration (`memory-mcp.ts:71-407`) + an async handler doing a loopback
`fetch` with the session-secret header `H(...)` (`memory-mcp.ts:24-26`), injecting `session: SESSION`, +
a branch in the `tools/call` dispatch ternary (`memory-mcp.ts:808-835`). They follow the `kb_*` / `schedule`
pattern verbatim.

| Tool | Input | Does |
|---|---|---|
| **`task_create`** | `{ title, body?, assignee?, priority?, labels?, parentId?, autoDispatch?, mode? }` | Create a task. "File durable work others (or you) will pick up." Author = the calling agent, server-derived; owner = the caller's run-as (delegation passthrough). `mode` = headless (default) / interactive for a dispatched session. |
| **`task_list`** | `{ status?, assignee?, label?, query?, limit? }` | Query the board. `assignee: "me"` resolves server-side to the calling agent. "Check the queue before starting or duplicating work." (`readOnlyHint`) |
| **`task_get`** | `{ id }` | Full task + activity timeline. (`readOnlyHint`) |
| **`task_claim`** | `{ id }` | Atomically take an open task (assign to me + `doing`). Returns the task, or an already-claimed error. "Claim before working so two agents don't collide." |
| **`task_update`** | `{ id, status?, note?, assignee?, priority?, labels? }` | Update status/fields + append a comment. Marking `done`/`blocked` is how a dispatched agent closes its loop. |

The **assignee/author are always server-derived** from the session row via `tm.sessionAgent(session)`
(`terminal.ts:601-603`) — the agent id the MCP process claims in its body is never trusted for authz,
exactly as the `kb_write`/`schedule` routes do it. `task_claim` records the claimer from that
server-resolved agent; the human run-as (for `owner`) comes from `tm.sessionRunAs(session)`
(`terminal.ts:607-609`).

Tool descriptions must draw the **Task-vs-Memory-vs-KB line** so agents don't conflate them: *Memory = my
private notes; KB = shared canonical knowledge; **Task = a unit of work with a lifecycle someone will
act on**.* Reinforce in agent `CLAUDE.md` guidance.

> **Rebuild rules (CLAUDE.md).** New tool **schemas** need `npm run build` + **session relaunch** (claude
> spawns the MCP server fresh per session). New `/api/*` **routes/handlers** need `npm run build` + **server
> restart**. Since these are both-new, until the server restarts the loopback call 404-falls-through to the
> member gate and returns **401 "not authenticated"** — the stale-server symptom, not an auth bug. Sanity
> check after restart: `curl -XPOST localhost:3010/api/tasks/create -d '{"session":"nope"}'` → **404**.

---

## 5. Server routes — `src/server.ts`

Two tiers, identical to KB/Memory. Agent loopback routes go in the pre-auth block (`server.ts:265-654`,
before the member gate at `:656`); each does `readBody` → `tm.sessionAgent(session)` (404 unknown) →
`sessionSecretOk(session)` (403 bad secret) → validate → store call → `os.audit.append` → `sendJson`.

### 5.1 Session-scoped loopback (agents — `x-aos-secret`)

```
POST /api/tasks/create   { session, title, body?, assignee?, priority?, labels?, parentId?, autoDispatch?, mode? }
                                                         → { ok, id }            + audit 'task.created'
GET  /api/tasks/list?session=&status=&assignee=&label=&q=&limit=   → { tasks }
GET  /api/tasks/get?session=&id=                          → { task, events }
POST /api/tasks/claim    { session, id }                  → { ok, task } | { error:'already claimed' }
                                                                                  + audit 'task.claimed'
POST /api/tasks/update   { session, id, status?, note?, assignee?, priority?, labels? }
                                                         → { ok, task }          + audit 'task.updated' | 'task.completed'
```

`author`/`assignee:"me"` are derived server-side (`agent:<agentId>`), never trusted from the agent.

### 5.2 Member-scoped console (humans — cookie session)

```
GET    /api/tasks                     → { tasks, counts, agents, enabled }   (any logged-in member)
GET    /api/tasks/:id                 → { task, events }
POST   /api/tasks          { title, body?, assignee?, owner?, priority?, labels?, parentId?, autoDispatch?, mode? }
                                                          → human create (author = member id; owner defaults to the creator)
PATCH  /api/tasks/:id      { status?, assignee?, priority?, labels?, mode?, note? }   → human edit
POST   /api/tasks/:id/comment  { body }                   → append a comment event
POST   /api/tasks/:id/dispatch                            → spawn the session now  + audit 'task.dispatched'
DELETE /api/tasks/:id      (owner/admin only)             → audit 'task.deleted'
```

Tasks are tenant-wide, so **reads are open to any member of the tenant** (like KB — no `canRun`/
`canViewSpawn` filter; those are per-agent/per-spawn). Writes/claims are open to any member; **dispatch**
follows `canRun` on the assignee agent (spawning a session is a run); **delete** is owner/admin.

Audit event types (→ the same `TeeAuditSink`, JSONL + `audit_events` mirror): `task.created`,
`task.updated`, `task.claimed`, `task.dispatched`, `task.completed`, `task.deleted`.

---

## 6. The autonomy loop — "the fleet drains its own backlog"

Three mechanisms make the board self-working:

1. **In-flight capture.** Any agent doing real work files follow-ups with `task_create` and closes its own
   task with `task_update(done)`. A dispatched session is prompted to do exactly this (§3.2) — the steady
   drip that keeps the queue honest.
2. **Assigned auto-dispatch.** A task with `assignee = agent:<id>` + `auto_dispatch = 1` is spawned by the
   tick (§3.3), works headless to completion, and idles — the pile-up guard + `attempts` ceiling keep it
   from thrashing.
3. **A long-running "worker" session drains the pool.** A manually-started (or automation-started) agent
   session loops `task_list({ status:'todo' }) → task_claim → …work… → task_update(done)`, pulling open
   items off the shared board. The atomic `claim` (§2) is the race resolver when two workers reach for the
   same task.

Humans engage only to triage (create/prioritise/assign), to unblock a `blocked` task, or when they spot
something in the activity log. Everything else drains autonomously — and because a dispatched session is
fully gated, "let agents work the queue" is safe without a per-task approval.

---

## 7. Console UI — `web/src`

A new **Tasks** page (a Kanban board), added to the single-file SPA `web/src/App.tsx`. Five touch points
(mirroring how the Knowledge page is wired):

1. `Route` union — add `'tasks'` (`App.tsx:15`).
2. Hash-parser whitelist — add `|| h === 'tasks'` (`App.tsx:112`, inside `useHashRoute`).
3. Nav item — a `<NavItem>` in the "Manage" nav next to Knowledge (`App.tsx:328`); add to `manageRoutes`
   (`App.tsx:154`) so the section auto-expands. Pick a `lucide-react` icon (e.g. `ListChecks`).
4. Header title map — `route === 'tasks' ? 'Tasks' : …` (`App.tsx:369`).
5. View render — `{route === 'tasks' && <TasksPage me={me} agents={state?.agents ?? []} />}`
   (`App.tsx:373-389`).

Client calls in `web/src/lib/api.ts` — add a `Task`/`AddTaskReq` interface near the `Automation` block
(`api.ts:172-197`) and one-line methods in the `api` object (`api.ts:497-667`) in the existing `call<T>()`
style (`api.ts:488-495`): `tasks()`, `task(id)`, `addTask(b)`, `patchTask(id,b)`, `commentTask(id,b)`,
`dispatchTask(id)`, `deleteTask(id)`. Auth is the session cookie — no client-side token handling.

`TasksPage` component (`App.tsx`) — a Kanban board in the **primary** sidebar nav directly under **Agents**
(not the Manage group — Tasks is a working surface). Layout: **columns by status** (Todo / Doing / Blocked /
Done; cancelled folds under Done) of priority-sorted cards (title · assignee · labels · id); a **detail
drawer** with the markdown body, the **activity timeline** (`task_events`), status/assignee/priority controls,
a **Run mode** selector (headless / interactive — shown when the assignee is an agent), a **Dispatch now**
button (only for `todo` / `blocked`, so it doesn't linger after auto-dispatch flips a task to `doing`; reads
"Re-dispatch" on a `blocked` task), and the **run history** (see below). The create form exposes title /
details / assignee / priority / auto-dispatch / run mode.
Reuse the imported `Card`/`Input`/`Textarea`/`Button`/`Badge`/`Field`/`Select` primitives.

### Run history — a task has MANY sessions

The task↔session relation is one-to-**many** and always was: a task is the durable unit of work, a session
is one **attempt** at it. A crash re-dispatches, an agent `task_claim`s from its own run, a `@mention`
spawns, a human takes over. Only the newest attempt was ever reachable — `tasks.last_session_id`, the
pointer the pile-up guard and `task-reconcile` keep — so a task that failed twice before succeeding read as
one clean run, and its cost read as the last attempt's rather than the sum. (Measured on the live northwind
tenant: 7 tasks with more than one run, 5 of them with a bad earlier attempt, **$60.33** of attempt cost the
console never linked.)

`TerminalManager.taskRuns(taskId)` returns the whole list, oldest-first, on `GET /api/tasks/:id` as `runs:
TaskRun[]`. **Nothing new is stored** — the runs are recovered from the two traces they already leave:

- **`dispatch`** — provenance `spawned_by = 'task:<id>'`: the session was spawned FOR this task.
- **`linked`** — a session that touched the task from elsewhere and logged a `task_events` row against it
  (an agent's `task_claim` from its own run, a Discussion-continued thread).

Each run carries its own verdict (`outcome`/`summary` from its `report`), wall duration, cost, turns,
`current` (is this the `lastSessionId` the guard tracks), `alive` (one tmux poll for the whole list), and
`archived`. **Archived rows stay in the history** — the soft-archive declutters the Sessions list, it does
not rewrite what happened to a task. The drawer renders them as a **Runs · N** list (collapsed to the last
three); in the full-page room, picking a run swaps the **Session** tab to that run's pane, so a much-retried
task can be read attempt by attempt. Reads are tenant-wide like the rest of the detail payload; *attaching*
to any run is still gated by the terminal's own authz. Pinned by `scripts/task-runs-test.cjs`.

> Web-only changes: `cd web && npm run build`, reload — no server restart. But Tasks needs new `/api/*`
> routes, so a full `npm run build` + server bounce is required regardless (locally
> `npm run build && launchctl kickstart -k gui/$(id -u)/com.agentos.northwind`).

---

## 8. Build order & validation

1. `db.ts` migration (`tasks`, `task_events`, `tasks_fts` + triggers) → `src/types.ts` types.
2. `src/state/tasks.ts` `TaskStore` (+ kernel wiring; **no** home path).
3. `Tasks.dispatch(id)` + the tick sweep + `buildTaskPrompt` (edge layer, reusing `createSession` +
   `isAlive`). Verify `canViewSpawn`/`spaceFor` treat `task:<id>` provenance correctly (§3.1).
4. Server routes — session loopback tier + member console tier + audit events.
5. MCP tools in `memory-mcp.ts` (`task_create/list/get/claim/update`) + launcher tool-allow (mirror how
   `kb_*` are allowlisted in `claude-launch.sh`).
6. Console **Tasks** board + api client methods.
7. Agent `CLAUDE.md` guidance (the Task-vs-Memory-vs-KB line) + a doc row in `docs/agent-mcp-tools.md`
   (update the always-on tool count) + regrade Pillar 16 in `docs/PILLARS.md`.

Validate the usual way (no test runner): `npm run typecheck`, `cd web && npm run build`, `npm run demo`,
and a small in-process Node script that spins `createHttpServer` on an ephemeral port and drives the
`/api/tasks/*` routes with `fetch` — **create → list → claim → update(done) → get(events)** — plus a
dispatch smoke test (create an `auto_dispatch` task assigned to an agent, tick once, assert a `task:<id>`
session spawned and the pile-up guard blocks a second). **Isolate `AGENT_OS_HOME`** to a scratch dir first
(a bare `loadAgentOS()` writes into the live `./data`).

---

## 9. Future (not v1)

> **Update (2026-07-09, v0.60.0): board UX + due dates shipped.** The "Richer board" and part of
> "Dependencies & scheduling" below are now real: the console board has drag-and-drop, a Board⇄List toggle,
> a filter bar (My/assignee/label/priority/overdue), a per-member "my tasks" lens, rendered-markdown +
> inline-editable bodies, real member/agent names, and human assignees. **Due dates** are wired end-to-end
> — `due_at` set on create/edit and via `task_create`/`task_update` (`due` ISO date), relative due/overdue
> badges, list sort-by-due, and a scheduler **overdue sweep** that DMs the task owner once (owner-less →
> owner/admins; audited `task.overdue` / `task.overdue.notified`). Still open below: **blocked_by
> dependencies**, projects/epics/swimlanes, a burndown, pool auto-assignment, agent-triggered dispatch,
> the policy brake, and the recurring-task Automation.

> **Update (2026-07-10, v0.89.0): file attachments shipped.** A task now carries files. `TaskStore` gained
> the on-disk attachment dir (`<home>/task-attachments/<taskId>/`, snapshot model borrowed from
> `ArtifactStore` — so the store is no longer strictly db-only, but task ROWS still are per §Decision 2)
> plus `attachBytes`/`attachFromPath`/`attachments`/`readAttachment`/`removeAttachment` over a
> `task_attachments` table. Humans upload from the drawer (picker + drag-and-drop, download + delete);
> agents attach from their working folder via the `task_attach` MCP tool → `TerminalManager.attachTaskFile`
> → `TaskStore.attachFromPath` (strict-contained path resolution). Each attach logs an `attach` timeline
> event + audits `task.attached`; `task_get` and the console detail both list attachments; deleting a task
> cascades its attachment rows + files. Routes: agent loopback `POST /api/tasks/attach`; member console
> `POST/GET-raw/DELETE /api/tasks/:id/attachments`.

> **Update (2026-08-10, v0.333.0): the Discussion became a two-way channel to the running agent.** The room
> was a log: a human's plain message sat in the timeline until the agent next called `task_get` — which,
> mid-turn, is never — so the only message that ever reached a working agent was one that happened to
> answer a pending `ask`. Now `Automations.postTaskDiscussion` routes an unrouted human message into the
> run: **`answered`** when that run is blocked on a question (answering unblocks the turn; free text would
> only queue behind the open ask), else **`delivered`** by typing it into the live pane
> (`deliverToResident` — idle claude runs it now, busy claude queues it to the next turn boundary).
> **Two or more live runs → `choose`**: it delivers to NONE of them and hands the live runs back, because
> the wrong guess talks to the wrong worker; the human picks in the room and the pick comes back through
> `POST /api/tasks/:id/deliver` (delivery only — the message is already on the record, so a declined or
> failed delivery never loses it). Statuses `none`/`stale`/`undeliverable` cover the rest and are all
> surfaced in the composer. Both halves of the channel are taught to the agent, or it's one-way in
> practice: `buildTaskPrompt` (fresh AND resuming) now states that humans see the Discussion and NOT its
> terminal output, that a room message arrives mid-run prefixed `[task discussion] <name>:` and is a live
> instruction — including "stop" — and that `task_say` is the way back. Falsifier:
> `scripts/task-discussion-delivery-test.cjs` (in `npm run test:governance`), which pins the ambiguity
> refusal, the no-double-send when an `@mention` already routed the message, and the prompt's own
> both-directions text.

- **Pool auto-assignment.** Route unassigned `auto_dispatch` tasks to a workspace **default worker agent**
  (or a small pool), so a human can drop tasks on the board with no assignee and the fleet picks them up.
  This is the agent-spawns-agent frontier Automations also parks — needs a concurrency budget + a
  fairness/round-robin story first.
- ~~**Agent-triggered dispatch.** A `task_dispatch` MCP tool letting an agent spawn a worker for a task
  (today agents only `claim` into their own session). Gate it hard — it's how a runaway loop spawns
  sessions.~~ **SHIPPED (v0.96.0):** `task_dispatch` → `POST /api/tasks/dispatch` → `Automations.dispatchTask`
  with `guard:true` (the pile-up guard the console's explicit-human dispatch skips), so an agent can kick an
  agent-assigned task into a session immediately instead of waiting for the tick. Runaway brakes = the
  pile-up guard (never two live sessions per task) + the `TASK_MAX_ATTEMPTS` ceiling (parks a failing task
  `blocked`); the spawned session runs-as the task owner and every effect still passes the gateway. Still
  open: per-run **budget attribution** + **recursion-depth** limiting on this spawn path.

> **Update (2026-07-10, v0.98.0): synchronous hand-off shipped (`task_wait`).** `task_dispatch` (above)
> spawns a worker and returns; this adds the *waiting* half, so delegation can now BLOCK on the result: a
> caller hands a task to another agent and waits until it finishes, then resumes with the delegate's closing
> note — the A2A analog of `ask`. `task_wait(id)` (or `task_create({ wait:true })` in one call) long-polls
> `POST /api/tasks/wait`; each poll kicks a **guarded immediate dispatch** when the task is stalled (not
> terminal, not `blocked`, agent-assigned, nothing live on it), so waiting DRIVES the work and auto-retries a
> crashed run — self-limited by the same `dispatchTask` guard + `TASK_MAX_ATTEMPTS` ceiling, so a re-polled
> crash-loop parks `blocked` rather than spinning. The caller's session stays alive on the pending tool call
> and resumes on its own; no session revival needed. The closing note is `TaskStore.latestNote` (newest
> `comment` event, ordered by insertion so it's unambiguous within a millisecond). Headless callers park after
> `AOS_TASK_WAIT_S` (default 900s) with a "still running, check back" message; interactive wait longer. Also:
> an agent `task_create` now dispatches an `autoDispatch` hand-off **immediately** (parity with the console
> route) instead of leaving it for the ≤20s scheduler tick. Still gated below: the hard policy brake, plus
> per-run budget attribution + recursion-depth limiting on the spawn path.
- **Optional policy brake on dispatch.** Run `Policy.classify('task.dispatch', {task})` in the dispatcher:
  green auto-spawns, yellow (a `budget`/`protected` label, or an estimated cost) suspends for approval, red
  needs owner — turning "start work" into a gated capability without touching the store. Designed for, off
  in v1 (mirrors the KB policy-brake future).
- **Dependencies & scheduling.** `blocked_by` edges (a task can't dispatch until its blockers are `done`),
  `due_at`-driven prioritisation, recurring tasks (a cron Automation that files a task).
- **Richer board.** Projects/epics, swimlanes, saved filters, per-member "my tasks" lens, a burndown.
  *(The Task→Sessions direction shipped — see "Run history" in §7. The reverse leg, a Task backlink on a
  session row in the Sessions list, is still open; `sourceKind`/`task:<id>` already support it.)*
- **Concurrent runs on one task.** The run history is retrospective — one live session per task is still
  enforced by the pile-up guard. Fanning a task out across several simultaneous sessions (sharded work)
  needs `last_session_id` to become a set, and an answer to which run's `task_update(done)` closes it.
- **Inbox integration.** A `blocked` task surfaces an Inbox card (like an approval) so a human is pinged to
  unblock, reusing the Slack/Discord approver-notify path.
</content>
</invoke>
