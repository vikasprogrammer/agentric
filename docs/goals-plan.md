# Goals — implementation plan

The **Goals plane** (`os.goals`): a shared, tenant-wide, human-owned layer of *strategy* that the rest
of the fleet's work ladders up to. It's the missing top of the existing ladder:

```
Goal      strategic, persistent, revisioned, human-owned        ← this plan
  └─ Task   a unit of work, linked to a goal via goal_id
       └─ Session   a governed run that advances the task
            (Automation = the trigger that spawns the session)
```

Today the ladder starts at **Task** — there is no "why" above it. Goals supply that, and — critically —
they are not just another prose blob injected into prompts (we already have Company context, Dreaming
guidance, and the KB for that). A Goal is a **structured object work links to and is measured against**,
so we get alignment we can see: which tasks/sessions advanced which goal.

## Not the same as Claude Code's `/goal` (different altitude — they compose)

Claude Code's `/goal` slash command is a **session-scoped completion condition**: keep *one* agent working
across turns until a model-verified condition holds, then it clears. Tactical, ephemeral, one agent. Our
Goal is strategic, persistent, cross-agent, human-owned. Same word, non-overlapping altitude — and they
**compose**: a dispatched Task can *run under* a `/goal` condition equal to its acceptance criteria (Slice
2, workstream C). CC gives intra-session convergence; the OS gives the cross-session governed strategy it
plugs into.

| | Trigger | Lifetime | Scope | Owner |
|---|---|---|---|---|
| CC `/loop` | time interval | one session (≤7d) | one agent | — |
| CC `/goal` | model-verified condition | one session | one agent | — |
| **OS Goal** (this plan) | — (it's a *state object*) | persistent, revisioned | tenant-wide, all agents | human |

---

## Data model

A Goal mirrors the shape of `Task` (`src/types.ts` / `src/state/tasks.ts`) — db-only structured state with
an append-only event log as the safety net (auto-apply + audit, **no approval gate** for human edits, same
posture as KB and Tasks).

```ts
// src/types.ts
export type GoalStatus = 'draft' | 'active' | 'achieved' | 'abandoned';

export interface Goal {
  id: string;
  tenant: string;
  title: string;
  body: string;              // the "what / why" narrative
  status: GoalStatus;
  target?: string;           // free-text target caption for v1 (e.g. "grow globex signups")
  owner?: string;            // member id accountable for the goal
  parentId?: string;         // hierarchy: strategy → objective → key result
  labels: string[];
  dueAt?: number;            // epoch ms soft horizon
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}
```

Progress is **derived, not hand-maintained** wherever possible: once Slice 2 links tasks, a goal's % comes
from the status of its linked tasks (`GoalStore.progress()`), so the object can't rot into a stale number.
v1's `target` is a caption only; real numeric metrics are a later move (see Out of scope).

---

## Slice 1 — Goals plane + context injection (first PR)

Ship the object and make agents *aware* of it. This alone gives the shared source of truth and the passive
"every agent knows the current strategy" win, and lets us dogfood the primitive before building the
measurement half.

### 1. `GoalStore` — `src/state/goals.ts`
Model on `TaskStore` (`src/state/tasks.ts`): db-only, owns its tables, stable public methods.
- `create` / `get` / `list({status?, ownerId?, parentId?})` / `update` / `search(q)`.
- Status transitions `draft → active → achieved | abandoned` (guard illegal jumps).
- Every mutation appends to `goal_events` (the KB/Tasks-style audit trail) and emits an audit event.
- A `setNotifier` hook (wired in `tenant-registry.ts` like `TaskStore.setNotifier`) so goal
  create/(re)assign/status lands an audience-addressed Inbox card + DM for the `owner` via
  `notifyGoalEvent` → `postGoalCard` + `resolveRecipients` (reuse `src/governance/recipients.ts`).

### 2. Schema — `src/state/db.ts`
New migration adding `goals`, `goal_events`, and `goals_fts` (FTS5 over title/body, mirroring
`tasks`/`tasks_fts`). Follow the existing migration numbering convention.

### 3. API routes — `src/server.ts`
`GET/POST /api/goals`, `GET/PATCH /api/goals/:id`, `GET /api/goals/:id/events`. Mutations gated
owner/admin (strategy is a steering-wheel concern); reads allowed to any authenticated member.
**Server code → `npm run build` + restart** to take effect.

### 4. Agent MCP tools — `src/memory/memory-mcp.ts` (+ `/api/*` handlers)
- `goal_list` / `goal_get` — **always-on, read-only**, so any agent can orient to current strategy.
- `goal_propose` — an agent *drafts* a goal (lands as `status:'draft'` + a `goal.proposed` inbox card for
  owner/admin to publish). Gated exactly like `skill_propose`. **Agents read and propose; humans decide.**
  No agent authority to `active`-ate or edit a goal in v1.
- Update `docs/agent-mcp-tools.md` (the tool↔route↔store matrix).
- **Tool-schema change → `npm run build` + relaunch the session** (MCP server is spawned per session).

### 5. Context injection — `buildCompanyMd`
Render the **active** goals (title + target, hierarchy-aware) into every agent's prompt, behind a
toggle in Settings alongside the Dreaming-guidance toggle. This is the passive-direction channel.

### 6. Console — `web/src`
A **Goals** page (primary nav, above Tasks — it's the top of the ladder): list/create/edit, status,
owner, parent (nested display), and the event history. `cd web && npm run build`; no server restart.

### 7. Ship
Bump **minor** in `package.json` + move a CHANGELOG "Unreleased" line into the new version heading in the
same commit (per repo convention). Branch → one PR → squash-merge (`--repo vikasprogrammer/agent-os`);
CI = `npm run test:governance` from repo root.

---

## Slice 2 — Linkage, the loop, and `/goal`-driven convergence (second PR)

Where goals stop being decoration and start steering + measuring work.

> **Status (v0.108.0):** **A (linkage + derived progress)** and **C (`/goal` convergence)** shipped —
> they're the tightly-coupled core (linkage enables progress; `/goal` enables convergence) and C was
> already spiked. **B (the Dreaming goal-lens)** is deferred to a fast-follow: it reasons over linkage
> data that only exists once A is in use, and it touches the self-learning engine's config-recommendation
> semantics (a separable, riskier surface). Section B below is the remaining work.

### A. Goal ↔ Task linkage
- Add nullable `goal_id` to `tasks` (`src/state/tasks.ts` + `db.ts` migration).
- `TaskStore.tasksForGoal(goalId)`; `GoalStore.progress(goalId)` derives % from linked-task status.
- `task_create` (MCP + console) gains optional `goal_id`; the Tasks Kanban gains a goal filter/label; the
  Goals page expands each goal to its linked tasks.

### B. The Dreaming loop
- The deterministic Dreaming pass (`src/edge/dreaming.ts`) gains a **goal lens**: "goal G has had no linked-
  task activity in N days", "sessions X/Y/Z advanced G" — emitted as **Apply/Dismiss recommendations** on
  the existing `/api/dreaming*` rail. No new UI rail; reuse the recommendation surface.
- Optionally add a contribution-to-goal axis to agent stats (`src/state/agent-stats.ts`) — nice-to-have,
  can trail.

### C. `/goal`-as-task-convergence  ✅ *viability confirmed by spike (see below)*

Reuse Claude Code's `/goal` primitive as the bottom rung: a dispatched Task runs under a `/goal` completion
condition equal to its acceptance criteria, so the agent **autonomously converges** (an independent Haiku
evaluator judges the transcript each turn via a Stop hook) instead of running once and hoping.

**Spike result (2026-07-11, `claude` 2.1.207).** Ran
`claude -p $'/goal <condition>\n\n<prose>' --dangerously-skip-permissions`. Debug log confirmed:
- the Stop-hook fired (`hook_event_name:"Stop"`) and an **independent evaluator ran**
  (`Hooks: Model response: {"ok":true,"reason":"…contains the exact token…"}`);
- `/goal` consumed **line 1 as the condition** (evaluator quoted exactly that, not the trailing prose);
- the **trailing prose still took effect** as the work directive (agent obeyed it) — so condition *and*
  task context both land in one `-p`;
- `--dangerously-skip-permissions` engaged the hook with **no trust dialog** (`permission_mode:"bypassPermissions"`).

So the mixed `command + prose` shape parses. **C stays in Slice 2 — no fallback path needed.**

**Implementation:**

1. **New task field `criteria?: string`** (nullable) — `Task`/`TaskRow` in `src/types.ts` +
   `src/state/tasks.ts` + a `tasks` column migration. There is no acceptance-criteria field today
   (`body` is prose, not a verifiable condition). `/goal` is **opt-in per task**: only tasks with
   `criteria` set run under it — keeps the extra evaluator turns/cost off simple tasks.
   **Validate single-line** (strip newlines) on the editor: `/goal` delimits its condition at the first
   newline, so a multi-line criterion would spill into the prose body.

2. **`buildTaskPrompt()` — `src/edge/automations.ts:221`** (the one assembly point; the string flows
   base64 → `TASK_B64` env → `claude -p "$TASK"` verbatim, no sanitization). When `criteria` is set,
   `mode === 'headless'`, and the fleet `claude` supports `/goal`, prepend the confirmed shape:

   ```
   /goal <task.criteria>          ← line 1: the completion condition

   You are working task <id>: <title>
   <body>
   When finished, call task_update({ id:"<id>", status:"done", note:"…" }) in the same turn you satisfy it.
   If you cannot proceed, call task_update({ id:"<id>", status:"blocked", note:"<why>" }).
   ```

   Otherwise emit today's plain prompt unchanged.

3. **Feature-detect the version.** `/goal` is CC ≥ **2.1.139**; read `claude --version` at launch (or cache
   it on the `TerminalManager`) and only emit the `/goal` line when supported — else fall back to the plain
   prompt rather than shipping a dead command to an older binary.

4. **Reconcile the two completion models.** `/goal` clears on the *evaluator*; the OS closes its loop on
   `task_update(done)`. Keep **`task_update(done)` as the system-of-record** and fold the OS closure *into
   the condition's turn* (the "in the same turn you satisfy it" instruction), so there's no window where the
   goal clears before the task is recorded. If a session clears the goal but exits without `task_update`, the
   **existing safety net** (`guard`/`isAlive` pile-up brake + `TASK_MAX_ATTEMPTS` ceiling → park `blocked`)
   already re-dispatches or parks it — no new failure mode.

5. **Console / observability.** Criteria field on the task editor; a "converging (◎)" badge on tasks running
   under `/goal`. The evaluator's per-turn reasons live only in the CC session transcript — surface nothing
   new in v1.

**Deliberately out of C's scope:** `/goal` on `interactive` tasks (a cron won't re-fire while an interactive
session is alive; convergence there stays manual).

---

## Out of scope (both slices)

- **Agent-authored strategy with real authority.** Humans own goals + acceptance criteria; agents `goal_list`/
  `goal_get`/`goal_propose` only. No `goal_update`/activation by agents.
- **Structured numeric metrics.** v1 uses task-completion-derived progress + a free-text `target` caption.
  Real metrics (a number an automation writes, dashboards) come later, once we know what's worth measuring.
- **Per-agent missions.** If direction turns out to be role-specific rather than company-wide, that's the
  agent manifest — a separate later move; don't conflate it with tenant strategy now.

## Open decisions

1. **Metric model** — confirm v1 stays task-completion-derived + free-text target (recommended), deferring
   real numeric metrics.
2. **Sequencing** — ship Slice 1 solo to dogfood goals-as-context before building linkage + the loop
   (recommended, matches the minor-per-feature cadence), or land both together.
