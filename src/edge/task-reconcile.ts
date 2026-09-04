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
 *
 * {@link sweepStrandedTasks} runs the same reconciliation AUTOMATICALLY off the scheduler tick, because
 * the drift above isn't only a tidiness problem — it silently breaks agent→agent delegation. The
 * poke-back that wakes a delegating caller is wired to the TASK reaching done/blocked
 * (`maybePokeCaller`), not to the delegate's session ending, so a delegate that finishes its run without
 * calling `task_update` strands the task in `doing` AND leaves the caller waiting forever. Measured on the
 * globex tenant: 43 of 307 (14%) poke-on-done hand-offs over 30 days ended exactly that way, and 15 of 16
 * of those runs ended `outcome = 'unknown'` — the bucket `apply` deliberately never touches — so the
 * manual tile could not have rescued a single one.
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
const SAMPLE = 8;
// Only reconcile a task whose run ENDED at least this long ago — a grace so a just-finished run whose
// agent is about to post its `task_update(done)` isn't reconciled out from under it. Measured off the
// session's `updated_at` (stamped when it reaches a terminal state), not `created_at`: a long run that
// STARTED an hour ago but ended seconds ago has not settled, and gating on start time would sweep it.
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
  s_id: string; s_status: string; s_outcome: string | null; s_created: number; s_updated: number;
}

/** A dispatched task's run has ENDED (not running). `finished` = succeeded; `stalled` = failed/died. */
function classify(r: Row): 'finished' | 'stalled' | null {
  if (r.s_status === 'running') return null; // still working — not drift
  if (outcomeOf(r) === 'success') return 'finished';
  return 'stalled'; // failure | partial | unknown | crashed | stopped
}

function toItem(r: Row, now: number): TaskDriftItem {
  return {
    id: r.id, title: r.title, assignee: r.assignee, owner: r.owner,
    sessionId: r.s_id, sessionStatus: r.s_status,
    outcome: outcomeOf(r),
    endedDaysAgo: Math.floor((now - r.s_updated) / DAY),
  };
}

/** The run's effective outcome: its self-reported grade, else derived from how the row ended. A finished
 *  run that never called `report` reads `unknown` — "nobody closed the loop", not "it failed". */
function outcomeOf(r: Row): string {
  return (r.s_outcome || (r.s_status === 'done' ? 'success' : r.s_status) || 'unknown').toLowerCase();
}

/** Compute the finished (auto-closable) + stalled (review) drift lists WITHOUT mutating anything. */
export function planTaskReconcile(os: AgentOS, now = Date.now()): TaskReconcilePlan {
  const rows = os.db
    .prepare(
      `SELECT t.id, t.title, t.assignee, t.owner, t.status, t.updated_at,
              s.id AS s_id, s.status AS s_status, s.outcome AS s_outcome, s.created_at AS s_created, s.updated_at AS s_updated
         FROM tasks t
         JOIN term_sessions s ON s.id = t.last_session_id
        WHERE t.tenant = ? AND t.status = 'doing' AND t.last_session_id IS NOT NULL
          AND s.status != 'running' AND s.updated_at < ?
        ORDER BY s.updated_at`,
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
              s.id AS s_id, s.status AS s_status, s.outcome AS s_outcome, s.created_at AS s_created, s.updated_at AS s_updated
         FROM tasks t
         JOIN term_sessions s ON s.id = t.last_session_id
        WHERE t.tenant = ? AND t.status = 'doing' AND t.last_session_id IS NOT NULL
          AND s.status != 'running' AND s.updated_at < ?`,
    )
    .all<Row>(os.tenant, now - SETTLE_MS);
  return rows.filter((r) => classify(r) === 'finished').map((r) => toItem(r, now));
}

// ── Automatic reconciliation (scheduler tick) ─────────────────────────────────────────────────────

/**
 * The wake-up hook the sweep reaches a delegating caller through — structurally {@link
 * Automations.pokeCaller}, passed IN rather than imported so this module keeps its pure-over-the-DB shape
 * and the edge keeps one owner of session spawning.
 */
export interface PokeHook {
  pokeCaller(input: {
    callerAgent: string; callerClaudeId: string; runAs?: string;
    message: string; source: string; title?: string; kind?: string;
  }): { ok: boolean };
}

/** Only wake a caller about a run that ended within this window. An older stranding still gets its marker
 *  (so it can never fire later) but stays SILENT: switching this sweep on must not stampede a backlog of
 *  month-old hand-offs into a burst of resumed caller sessions. */
const POKE_MAX_AGE_MS = 3 * DAY;
/** Wake-ups per tick. A poke to a caller that no longer has a live session RESUMES its transcript in a
 *  fresh run, so this is real load — drain the backlog a few at a time rather than all at once. */
const POKE_PER_TICK = 3;
/** Cap on the delegate's quoted note. The poke is TYPED INTO a live caller's pane (or becomes a resumed
 *  run's prompt), and a delegate's sign-off can run to thousands of characters. The message tells the
 *  caller to `task_get` for the rest, so the quote only has to be enough to orient it. */
const NOTE_MAX = 800;

export interface StrandedSweep {
  closed: number;   // run reported success, task left open → closed for it (normal done-poke follows)
  poked: number;    // caller woken: "your delegate's run ended without closing this"
  marked: number;   // strandings recorded this pass (poked + those with nobody to wake / too old)
}

interface StrandedRow extends Row {
  poke_on_done: number; caller_agent: string | null; caller_claude_id: string | null;
}

/**
 * Close the delegation loop when the DELEGATE'S RUN ends but the TASK doesn't — the gap that leaves a
 * caller waiting forever (see the module header). Runs off the scheduler tick over every non-terminal task
 * whose dispatched session has settled, and splits by what the run actually reported:
 *
 *  · **success** → close the task `done` (what the Insights tile does by hand, now automatic). The store
 *    notifier then fires the ORDINARY "✅ Really done" poke, so the caller hears the real result through
 *    the normal path instead of a second "it stalled" message — one wake-up, not two.
 *  · **anything else** (`unknown` — the common case, the agent closed neither loop — plus partial /
 *    failure / crashed / stopped) → leave the status ALONE and wake the caller with what the delegate last
 *    said, so a human or the caller decides. Never auto-marks done: a run can end mid-flight for good
 *    reasons (waiting on CI, a human go/no-go), and calling that "finished" would be a lie.
 *
 * Once per dead run (`markStranded`, keyed on the session), bounded by {@link POKE_PER_TICK} and
 * {@link POKE_MAX_AGE_MS}. A row that is over budget is left UNMARKED so the next tick still owes it.
 */
/**
 * Did a PERSON end this run? `TerminalManager.stopSession` audits `session.stopped` with its `by`
 * verbatim: `system` for the reaper, the agent's own id for a self-stop via the `stop` tool, and a
 * MEMBER'S EMAIL for the console kill button — so "is that principal a member" is the whole test. A
 * self-stop is deliberate too, but it is the agent's own call and it may well have left work behind for
 * the caller; only the human's veto suppresses the wake-up.
 */
function endedByHuman(os: AgentOS, sessionId: string): boolean {
  const row = os.db
    .prepare("SELECT principal FROM audit_events WHERE run_id = ? AND type = 'session.stopped' ORDER BY ts DESC LIMIT 1")
    .get<{ principal: string | null }>(sessionId);
  const by = row?.principal;
  if (!by || by === 'system') return false;
  return !!os.team.resolveMemberRef(by);
}

export function sweepStrandedTasks(
  os: AgentOS,
  poker: PokeHook,
  opts: { budget?: number; now?: number } = {},
): StrandedSweep {
  const now = opts.now ?? Date.now();
  const out: StrandedSweep = { closed: 0, poked: 0, marked: 0 };
  let budget = Math.max(0, Math.min(opts.budget ?? POKE_PER_TICK, POKE_PER_TICK));
  const rows = os.db
    .prepare(
      `SELECT t.id, t.title, t.assignee, t.owner, t.status, t.updated_at,
              t.poke_on_done, t.caller_agent, t.caller_claude_id,
              s.id AS s_id, s.status AS s_status, s.outcome AS s_outcome, s.created_at AS s_created, s.updated_at AS s_updated
         FROM tasks t
         JOIN term_sessions s ON s.id = t.last_session_id
        WHERE t.tenant = ? AND t.status IN ('todo','doing') AND t.last_session_id IS NOT NULL
          AND s.status != 'running' AND s.updated_at < ?
        ORDER BY s.updated_at DESC`,
    )
    .all<StrandedRow>(os.tenant, now - SETTLE_MS);

  for (const r of rows) {
    if (classify(r) === 'finished') {
      const closed = os.tasks.update(r.id, {
        status: 'done',
        note: `Auto-reconciled: dispatched run ${r.s_id} reported success but the task was left open.`,
        by: 'system',
      });
      if (closed) {
        out.closed++;
        os.audit.append({ ts: now, runId: r.s_id, tenant: os.tenant, principal: 'system', type: 'task.reconciled', data: { closed: 1, id: r.id, via: 'sweep' } });
      }
      continue;
    }
    // Stalled: the run is over and the work was NOT reported done. Decide whether anyone is owed a
    // wake-up BEFORE burning the one-time marker — a poke we skip for budget must stay owed next tick.
    const waiting = r.poke_on_done === 1 && !!r.caller_agent && !!r.caller_claude_id;
    const fresh = now - r.s_updated <= POKE_MAX_AGE_MS;
    // A run a HUMAN halted is not a stranding — it is a decision, made by someone who is present. Waking
    // the caller to recover work its owner just stopped hands the agent back the very thing the human took
    // away, and the wake-up is usually a resume (the halted agent is cold by definition). northwind
    // 2026-08-20: an engineer run was stopped from the console at 09:28 and this sweep spawned a caller
    // session at 09:38 that re-opened the work as a PR. Still MARKED (so it can never fire later), never
    // woken; the task card already tells the human it is open.
    const halted = waiting && fresh && endedByHuman(os, r.s_id);
    const owed = waiting && fresh && !halted;
    if (owed && budget <= 0) continue;
    if (!os.tasks.markStranded(r.id, r.s_id)) continue; // this dead run was already handled
    out.marked++;
    os.audit.append({
      ts: now, runId: r.s_id, tenant: os.tenant, principal: 'system', type: 'task.stranded',
      data: {
        id: r.id, status: r.status, outcome: outcomeOf(r), caller: r.caller_agent ?? null, poked: owed,
        ...(halted ? { reason: 'human-stopped' } : {}),
      },
    });
    if (!owed) continue; // nobody delegated this, it went cold, or a human halted it — marked, not woken
    budget--;
    const delegate = r.assignee?.startsWith('agent:') ? r.assignee.slice('agent:'.length) : (r.assignee ?? 'the delegate');
    const full = os.tasks.latestNote(r.id) || '(it left no note)';
    const note = full.length > NOTE_MAX ? `${full.slice(0, NOTE_MAX)}… (truncated — task_get for the rest)` : full;
    const shortTitle = r.title.length > 48 ? `${r.title.slice(0, 47)}…` : r.title;
    poker.pokeCaller({
      callerAgent: r.caller_agent!,
      callerClaudeId: r.caller_claude_id!,
      runAs: r.owner ?? undefined,
      source: r.id,
      // Not a completion: the work is unfinished and its worker is gone, so this one earns a resume if the
      // caller is cold. (`poke-done` does not — see `edge/wakeups.ts`.)
      kind: 'poke-stranded',
      title: `Poke ← ${delegate} ran out: ${shortTitle}`,
      message:
        `⚠️ Ran out: ${delegate}'s run on the task you handed off (${r.id}: "${r.title}") ENDED without closing it — ` +
        `the task is still "${r.status}" and its run finished ${outcomeOf(r)}.\n\n` +
        `The last thing it said on the task: ${note}\n\n` +
        `It may have done the work and forgotten to close the loop, or stopped partway. Read the task ` +
        `(task_get) before you assume either way, then decide: accept it and move on, hand it back with ` +
        `task_update, or pick the remaining work up yourself.`,
    });
    out.poked++;
  }
  return out;
}
