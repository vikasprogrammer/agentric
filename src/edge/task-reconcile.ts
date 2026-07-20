/**
 * Tasks improvement tile — **reconcile the board against what sessions actually did** (Tasks domain of
 * Insights v2). The shared work queue drifts from reality in two ways once a task is dispatched to an
 * agent: the run FINISHES SUCCESSFULLY but the agent forgets to `task_update(done)` (so a completed task
 * sits in `doing` forever), or the run DIES (crash/stop/`unknown` outcome) and the task is stranded in
 * `doing` with nobody looking. Nothing surfaces either today — `task_update` is agent self-report only.
 *
 * This detects both by joining each non-terminal task to its dispatched session (`tasks.last_session_id`
 * → `term_sessions`) and reading the session's real end `status`/`outcome`:
 *  · **finished**  — session ended with a `success` outcome, task still `doing` and untouched since → the
 *    agent completed the work but didn't close the loop. SAFELY auto-closable (a close is reversible —
 *    the task can be reopened — and it only fires when the run genuinely succeeded).
 *  · **stalled**   — session ended `crashed`/`stopped` or `failure`/`unknown`, task still `doing` → the
 *    work did NOT complete. Surfaced for REVIEW only (never auto-touched — the fix is a human's call:
 *    re-dispatch, reassign, or block).
 *
 * `apply` only closes the `finished` set; `stalled` is informational. Pure over `tasks` ⋈ `term_sessions`;
 * no LLM (like Memory cleanup / KB tidy). Goals are already covered by the stuck-goal detector, so this
 * is the tasks half of "reconcile the plan against reality".
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
const SAMPLE = 8;
// Only reconcile a task whose run ended at least this long ago — a grace so a just-finished run whose
// agent is about to post its `task_update(done)` isn't reconciled out from under it.
const SETTLE_MS = 10 * 60_000;

export interface TaskDriftItem {
  id: string;
  title: string;
  assignee: string | null;
  owner: string | null;
  sessionId: string;
  sessionStatus: string;
  outcome: string;
  endedDaysAgo: number;
}
export interface TaskReconcilePlan {
  finished: { total: number; sample: TaskDriftItem[] };  // succeeded but left open → auto-closable
  stalled: { total: number; sample: TaskDriftItem[] };   // run failed/died, task stuck → review only
}

interface Row {
  id: string; title: string; assignee: string | null; owner: string | null;
  status: string; updated_at: number;
  s_id: string; s_status: string; s_outcome: string | null; s_created: number;
}

/** A dispatched task's run has ENDED (not running). `finished` = succeeded; `stalled` = failed/died. */
function classify(r: Row): 'finished' | 'stalled' | null {
  if (r.s_status === 'running') return null; // still working — not drift
  const outcome = (r.s_outcome || (r.s_status === 'done' ? 'success' : r.s_status) || 'unknown').toLowerCase();
  if (outcome === 'success') return 'finished';
  return 'stalled'; // failure | partial | unknown | crashed | stopped
}

function toItem(r: Row, now: number): TaskDriftItem {
  return {
    id: r.id, title: r.title, assignee: r.assignee, owner: r.owner,
    sessionId: r.s_id, sessionStatus: r.s_status,
    outcome: (r.s_outcome || (r.s_status === 'done' ? 'success' : r.s_status) || 'unknown').toLowerCase(),
    endedDaysAgo: Math.floor((now - r.s_created) / DAY),
  };
}

/** Compute the finished (auto-closable) + stalled (review) drift lists WITHOUT mutating anything. */
export function planTaskReconcile(os: AgentOS, now = Date.now()): TaskReconcilePlan {
  const rows = os.db
    .prepare(
      `SELECT t.id, t.title, t.assignee, t.owner, t.status, t.updated_at,
              s.id AS s_id, s.status AS s_status, s.outcome AS s_outcome, s.created_at AS s_created
         FROM tasks t
         JOIN term_sessions s ON s.id = t.last_session_id
        WHERE t.tenant = ? AND t.status = 'doing' AND t.last_session_id IS NOT NULL
          AND s.status != 'running' AND s.created_at < ?
        ORDER BY s.created_at`,
    )
    .all<Row>(os.tenant, now - SETTLE_MS);
  const finished: TaskDriftItem[] = [];
  const stalled: TaskDriftItem[] = [];
  for (const r of rows) {
    const kind = classify(r);
    if (kind === 'finished') finished.push(toItem(r, now));
    else if (kind === 'stalled') stalled.push(toItem(r, now));
  }
  return {
    finished: { total: finished.length, sample: finished.slice(0, SAMPLE) },
    stalled: { total: stalled.length, sample: stalled.slice(0, SAMPLE) },
  };
}

/** Close the FINISHED tasks (run succeeded, agent never closed the loop). Reversible (reopenable), each
 *  logged as a task event + a `task.reconciled` audit line. Never touches the `stalled` set. */
export function applyTaskReconcile(os: AgentOS, by = 'system', now = Date.now()): { closed: number } {
  const plan = planTaskReconcile(os, now);
  let closed = 0;
  for (const t of plan.finished.total > plan.finished.sample.length ? allFinished(os, now) : plan.finished.sample) {
    const updated = os.tasks.update(t.id, { status: 'done', note: `Auto-reconciled: dispatched run ${t.sessionId} finished successfully but the task was left open.`, by });
    if (updated) closed++;
  }
  if (closed) {
    os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: by, type: 'task.reconciled', data: { closed, via: 'insights-reconcile' } });
  }
  return { closed };
}

/** The full finished set (not just the preview sample) — for apply when there are more than SAMPLE. */
function allFinished(os: AgentOS, now: number): TaskDriftItem[] {
  const rows = os.db
    .prepare(
      `SELECT t.id, t.title, t.assignee, t.owner, t.status, t.updated_at,
              s.id AS s_id, s.status AS s_status, s.outcome AS s_outcome, s.created_at AS s_created
         FROM tasks t
         JOIN term_sessions s ON s.id = t.last_session_id
        WHERE t.tenant = ? AND t.status = 'doing' AND t.last_session_id IS NOT NULL
          AND s.status != 'running' AND s.created_at < ?`,
    )
    .all<Row>(os.tenant, now - SETTLE_MS);
  return rows.filter((r) => classify(r) === 'finished').map((r) => toItem(r, now));
}
