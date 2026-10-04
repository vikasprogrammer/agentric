/**
 * The goal **heartbeat** — why a measured goal stopped being measured.
 *
 * `goal-review.ts` already notices the silence: when no reading has landed for twice the metric's own
 * interval, `metricStatus` returns `unmeasured` and a card goes to the goal's owner. Live on the
 * instapods growth trial (2026-09-24 → 10-01) that card fired twice, DM'd both times, and changed
 * nothing — because "nobody is measuring this" describes the SYMPTOM, and the owner is reading it
 * beside a dozen other agent DMs. The loop had actually stopped for three unrelated mechanical
 * reasons in nine days: two launches refused on an expired runtime credential, three cron cycles
 * skipped behind a session a human had claimed and left open, and nothing at all for the rest.
 *
 * None of those are visible from the goal. They ARE visible one join away — the runner is whichever
 * agent posts the readings (`goal_readings.source`), and its sessions and automations carry the cause.
 * So this module answers the question the owner actually has: **what do I do?**
 *
 * Deliberately shaped like the review it feeds:
 *   - **Read-only arithmetic.** No spawning, no repair. A heartbeat that restarts things would hide
 *     the fault it exists to name, and the fixes here (re-login, stop a claimed session) are a human's.
 *   - **It names a cause only when the evidence is unambiguous**, and otherwise says plainly that it
 *     cannot tell. A confident wrong cause is worse than the symptom card we already had.
 *   - **The cause is part of the once-guard**, so a goal whose runner moves from "credential expired"
 *     to "blocked behind a claimed session" re-cards: the fix changed, so the owner needs telling again.
 */
import type { AgentOS } from '../kernel';
import type { Goal } from '../types';

const DAY = 86_400_000;

/** How far back to look for the runner's sessions. Beyond this a goal is a cold case, not a stall. */
const LOOKBACK_DAYS = 14;
/** An enabled trigger that has not fired in this long is not firing, whatever its schedule says. */
const TRIGGER_STALE_DAYS = 2;
/** A claimed/alive session older than this is parked, not working — the pile-up guard's blind spot. */
const PARKED_HOURS = 6;

export type HeartbeatCause =
  /** Launch was refused — an expired/absent runtime credential. The run never started. */
  | 'credential'
  /** Runs crash before taking a turn, for a reason other than a refused credential. */
  | 'crashing'
  /** A claimed or parked session is holding the runner's slot, so the schedule is being skipped. */
  | 'blocked'
  /** The runner has no enabled trigger left, so nothing is due to run at all. */
  | 'no-trigger'
  /** A trigger is enabled but has stopped firing, and no run was even attempted. */
  | 'not-firing'
  /** Runs are completing fine — the agent simply isn't recording a reading. */
  | 'not-reporting'
  /** Nothing has tried to run and nothing explains why. */
  | 'silent'
  /** Evidence is contradictory or missing; say so rather than guess. */
  | 'unknown';

export interface Heartbeat {
  /** The agent that has been posting this goal's readings, if any ever landed. */
  runner?: string;
  cause: HeartbeatCause;
  /** One sentence naming the mechanical fault, in the owner's words. */
  detail: string;
  /** What the human does about it. Empty when there is nothing to act on. */
  fix: string;
  /** Supporting counts, for the audit row and the test. */
  evidence: { refused: number; crashed: number; ok: number; lastRunAt?: number; blockedSession?: string; lastReadingAt?: number };
}

interface SessionRow { id: string; status: string; claimed_by: string | null; created_at: number; updated_at: number | null; turns: number | null }

/** The agent behind this goal's numbers: whoever posted the most recent `agent:` reading. */
function runnerOf(os: AgentOS, goalId: string): string | undefined {
  const row = os.db
    .prepare("SELECT source FROM goal_readings WHERE goal_id = ? AND source LIKE 'agent:%' ORDER BY at DESC LIMIT 1")
    .get<{ source: string }>(goalId);
  return row?.source ? row.source.slice('agent:'.length) : undefined;
}

/** Why one session never produced anything, read off its launch audit. */
function refusalReason(os: AgentOS, sessionId: string): string | undefined {
  const row = os.db
    .prepare("SELECT data FROM audit_events WHERE tenant = ? AND run_id = ? AND type = 'session.launch.refused' ORDER BY ts DESC LIMIT 1")
    .get<{ data: string }>(os.tenant, sessionId);
  if (!row) return undefined;
  try { return String((JSON.parse(row.data) as { reason?: unknown }).reason ?? 'launch refused'); } catch { return 'launch refused'; }
}

/**
 * Diagnose why `goal` has gone quiet. Safe to call for any goal: a goal that is being measured on time
 * comes back `cause: 'silent'` with no detail, and the caller is expected to ignore it — the review only
 * asks once the metric itself says `unmeasured`.
 */
export function heartbeat(os: AgentOS, goal: Goal, now = Date.now()): Heartbeat {
  // Everything below is bounded by `now`: a reading may be recorded with an explicit `at` (goal_measure
  // takes one), so a future-dated row must not make the stall look measured — and bounding makes the
  // diagnosis replayable against a past moment, which is how its first two ordering bugs were found.
  const lastReading = os.db
    .prepare('SELECT at FROM goal_readings WHERE goal_id = ? AND at <= ? ORDER BY at DESC LIMIT 1')
    .get<{ at: number }>(goal.id, now)?.at;
  const runner = runnerOf(os, goal.id);
  const evidence: Heartbeat['evidence'] = { refused: 0, crashed: 0, ok: 0, lastReadingAt: lastReading };

  if (!runner) {
    return {
      cause: 'silent', evidence,
      detail: 'No agent has ever posted a reading for this goal, so there is no runner to diagnose.',
      fix: 'Point an agent at this goal — give it the goal id and have it call `goal_measure` on a schedule.',
    };
  }

  // Count evidence only since the last reading we HAVE: that is the window the stall lives in. A run
  // that succeeded before the number went stale explains nothing, and letting it count was enough to
  // hide a real credential failure behind a healthy run five days older (live, 2026-09-27).
  const since = Math.max(now - LOOKBACK_DAYS * DAY, lastReading ?? 0);
  const rows = os.db
    // `term_sessions` carries no tenant column — the DB file IS the tenant boundary.
    .prepare('SELECT id, status, claimed_by, created_at, updated_at, turns FROM term_sessions WHERE agent = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC')
    .all<SessionRow>(runner, since, now);
  evidence.lastRunAt = rows[0]?.created_at;

  // A session still alive (or paused) and long past any plausible turn is the pile-up guard's blind
  // spot: the scheduler keeps skipping the cron and records nothing, so silence is all the owner sees.
  const parked = rows.find((r) => (r.status === 'running' || r.status === 'paused') && now - (r.updated_at ?? r.created_at) > PARKED_HOURS * 3_600_000);
  for (const r of rows) {
    if (r.status === 'crashed' || (r.status === 'stopped' && !r.turns)) {
      if (refusalReason(os, r.id)) evidence.refused++; else evidence.crashed++;
    } else if (r.status === 'done') evidence.ok++;
  }

  // Order matters: the first cause that fully explains the silence wins, and each one has a different
  // fix. Credential first — it is the only one where nothing ever ran, so no other signal can exist.
  if (evidence.refused > 0 && !evidence.ok) {
    const why = rows.map((r) => refusalReason(os, r.id)).find(Boolean) ?? 'launch refused';
    return {
      runner, cause: 'credential', evidence,
      detail: `${runner} could not start ${evidence.refused === 1 ? 'its last run' : `its last ${evidence.refused} runs`}: ${why}.`,
      fix: `Re-login the runtime account this agent uses (Settings → Runtime → Accounts), then the next scheduled run will take a reading.`,
    };
  }
  if (parked) {
    const age = Math.round((now - (parked.updated_at ?? parked.created_at)) / 3_600_000);
    evidence.blockedSession = parked.id;
    return {
      runner, cause: 'blocked', evidence,
      detail: `${runner} has a ${parked.claimed_by ? 'taken-over' : 'live'} session (${parked.id}) idle for ${age}h, so every scheduled run since has been skipped rather than piling up.`,
      fix: `Stop that session (Sessions → ${parked.id} → Stop). The schedule resumes on its next tick.`,
    };
  }
  if (evidence.crashed > 0 && !evidence.ok) {
    return {
      runner, cause: 'crashing', evidence,
      detail: `${runner} started ${evidence.crashed === 1 ? 'once' : `${evidence.crashed} times`} and died before taking a turn.`,
      fix: `Open the newest ${runner} session and read its pane — a launch that dies before turn one is environment, not prompt.`,
    };
  }
  const trig = os.db
    .prepare('SELECT COUNT(*) AS n, MAX(COALESCE(MIN(last_fired_at, ?), 0)) AS fired FROM automations WHERE agent_id = ? AND enabled = 1')
    .get<{ n: number; fired: number }>(now, runner);
  const triggers = trig?.n ?? 0;
  if (!triggers) {
    return {
      runner, cause: 'no-trigger', evidence,
      detail: `${runner} has no enabled trigger, so nothing is due to run and no reading can land.`,
      fix: `Re-enable (or re-create) the automation that runs ${runner}.`,
    };
  }
  if (evidence.ok > 0 && lastReading !== undefined && (evidence.lastRunAt ?? 0) > lastReading) {
    return {
      runner, cause: 'not-reporting', evidence,
      detail: `${runner} has completed ${evidence.ok === 1 ? 'a run' : `${evidence.ok} runs`} since the last reading, so it is working but not recording the number.`,
      fix: `Tell ${runner} to call \`goal_measure\` on goal ${goal.id} every run — the work is happening, the measurement is not.`,
    };
  }
  // Nothing even tried to run, yet a trigger is enabled and overdue. This is the shape the scheduler's
  // pile-up guard leaves behind: it skips a cycle and records nothing, so the DB shows neither a run nor
  // a failure. Deliberately phrased as "stopped firing" — the heartbeat can see THAT, not always why.
  if (!rows.length) {
    const quietDays = trig?.fired ? Math.floor((now - trig.fired) / DAY) : undefined;
    if (quietDays === undefined || quietDays >= TRIGGER_STALE_DAYS) {
      return {
        runner, cause: 'not-firing', evidence,
        detail: `${runner}'s trigger is enabled but has not fired ${quietDays === undefined ? 'at all' : `in ${quietDays} days`}, and no run has been attempted since the last reading.`,
        fix: `Check for one of ${runner}'s sessions still alive (a live or taken-over session makes the scheduler skip each cycle), then confirm its schedule is due.`,
      };
    }
    return {
      runner, cause: 'silent', evidence,
      detail: `${runner} has not started a run since the last reading, though its trigger fired recently.`,
      fix: `Check the newest ${runner} session and whether its schedule is due (Automations → its schedule).`,
    };
  }
  return {
    runner, cause: 'unknown', evidence,
    detail: `${runner} ran recently (${evidence.ok} completed, ${evidence.crashed + evidence.refused} failed) but the reading is still stale.`,
    fix: `Open the newest ${runner} session and check whether its \`goal_measure\` call failed.`,
  };
}

/** The lines the review card appends under its own body. Empty when there is nothing useful to add. */
export function heartbeatLines(hb: Heartbeat): string {
  if (!hb.fix) return '';
  return `**Why it stopped:** ${hb.detail}\n\n**Fix:** ${hb.fix}`;
}

/** A card title that names the fault instead of the symptom, so the DM is actionable at a glance. */
export function heartbeatTitle(goal: Goal, hb: Heartbeat): string | undefined {
  switch (hb.cause) {
    case 'credential': return `"${goal.title}" stopped: ${hb.runner}'s runtime login expired`;
    case 'blocked': return `"${goal.title}" stopped: a parked session is blocking ${hb.runner}`;
    case 'crashing': return `"${goal.title}" stopped: ${hb.runner} is crashing at launch`;
    case 'no-trigger': return `"${goal.title}" stopped: ${hb.runner} has no enabled trigger`;
    case 'not-firing': return `"${goal.title}" stopped: ${hb.runner}'s trigger is not firing`;
    case 'not-reporting': return `"${goal.title}" is running but not recording its number`;
    default: return undefined; // 'silent' / 'unknown' keep the review's own symptom title
  }
}
