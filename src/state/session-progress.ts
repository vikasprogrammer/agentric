/**
 * Session PROGRESS — the one-line "where is this run, and is it moving?" a human needs to watch a
 * session without reading its transcript.
 *
 * The problem it solves: a running session already surfaces two things, and neither answers the
 * question. `lastActivity` (see `latestActivity` in server.ts) says what the agent JUST did — a point
 * event, no position. The `update` tool posts agent-authored prose — position-free, and self-graded.
 * Watching a fleet agent, you cannot tell a run that is advancing from one re-reading the same file
 * for the fortieth time.
 *
 * The split this module enforces:
 *
 *   - The **denominator is the agent's**. Only it knows the work divides into 22 canary files. It
 *     declares `subject` / `step` / `total` on an `update` call.
 *   - The **verdict is NOT the agent's**. An agent that believes it is progressing is exactly the one
 *     going in circles, and a self-graded outcome is what made the Insights surface drive ~zero action.
 *     So `forward | stuck | circling | blocked` is derived HERE, from the audit stream and the claim
 *     history — never from anything the agent asserts about its own health.
 *
 * Same rule as {@link GoalStore.progress}, which derives a goal's completion from linked-task status
 * and refuses a hand-maintained number.
 *
 * Every verdict carries a `reason` — the evidence that produced it ("no activity for 12 min", "step
 * still 6 across 3 updates"). A status word with no evidence is not falsifiable, and an indicator
 * nobody can check is one people learn to ignore.
 *
 * Pure: the caller does the DB reads and passes them in (mirroring `session-activity.ts`, where the
 * classifier is pure and the route owns the query).
 */

/** How a run is moving. `blocked` is deliberately NOT a failure state — a run waiting on a human's
 *  approval is behaving correctly, and reporting it as `stuck` would cry wolf on the one signal that
 *  has to stay trustworthy. It is the HUMAN who is holding that run up. */
export type ProgressVerdict = 'forward' | 'stuck' | 'circling' | 'blocked';

/** No activity in the audit stream for this long ⇒ `stuck`. Also the staleness bound on a claim. */
export const STALL_MS = 5 * 60_000;
/** A `reliability.loop` this recent still counts as circling. Twice the monitor's own 5-min window, so
 *  the verdict does not flicker back to `forward` between two nudges of a loop that is still running. */
export const LOOP_WINDOW_MS = 10 * 60_000;
/** The window over which a stationary step count reads as circling. */
export const CIRCLE_WINDOW_MS = 10 * 60_000;
/** Claims needed inside {@link CIRCLE_WINDOW_MS} before a stationary step is called circling. Three, not
 *  two: two updates within one step is ordinary narration, not a loop. */
export const CIRCLE_MIN_CLAIMS = 3;

/** One agent-declared position, parsed from an `update` call. `step`/`total`/`subject` are all optional
 *  — an agent that just posts prose still gets a server-derived verdict, only without a bar. */
export interface ProgressClaim {
  ts: number;
  subject: string | null;
  step: number | null;
  total: number | null;
  note: string;
}

/** Everything the derivation needs, read by the caller. */
export interface ProgressInputs {
  now: number;
  /** The run's `update` claims, NEWEST FIRST. May be empty. */
  claims: ProgressClaim[];
  /** Timestamp of the newest non-noise audit event for the run (what `latestActivity` scans for). */
  lastActivityTs: number | null;
  /** Timestamp of the newest `reliability.loop` audit event, if any. */
  loopTs: number | null;
  /** Set when the run is parked on a person — a pending approval or an unanswered `ask`. */
  awaiting: 'approval' | 'question' | null;
  /** Repeat count carried by that newest loop event, for the reason line. */
  loopCount?: number | null;
}

export interface SessionProgress {
  subject: string | null;
  step: number | null;
  total: number | null;
  /** step/total clamped to 0..1. Null when the agent declared no denominator — the UI then shows the
   *  verdict alone rather than inventing a bar. */
  pct: number | null;
  /** step − the previous claim's step. The load-bearing half: a bar alone cannot distinguish real
   *  movement from a number that has not budged. Null until two claims carry a step. */
  delta: number | null;
  verdict: ProgressVerdict;
  /** The evidence behind `verdict`, one line. */
  reason: string;
  /** The agent's latest one-liner. */
  note: string | null;
  ts: number | null;
  /** The newest claim is older than {@link STALL_MS} — the position may no longer be true, so the UI
   *  should dim the bar instead of implying it is current. */
  stale: boolean;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parse the position fields an agent may attach to an `update` (stored in the message's `args` blob
 *  and mirrored into the `session.progress` audit row). Tolerant: garbage degrades to null rather than
 *  throwing, and a `step` past its `total` is clamped up rather than dropped — the agent miscounting
 *  its own plan should not blank the whole line. */
export function parseClaim(ts: number, note: string, args: Record<string, unknown> | null | undefined): ProgressClaim {
  const a = args ?? {};
  const step = num(a.step);
  let total = num(a.of ?? a.total);
  if (total != null && total <= 0) total = null;
  if (step != null && total != null && step > total) total = step;
  const subject = typeof a.subject === 'string' && a.subject.trim() ? a.subject.trim() : null;
  return {
    ts,
    subject,
    step: step != null && step >= 0 ? Math.floor(step) : null,
    total: total != null ? Math.floor(total) : null,
    note,
  };
}

/**
 * Derive the progress line. Precedence is deliberate:
 *
 *   1. `blocked` — parked on a person. Never blame the agent for a human's queue.
 *   2. `circling` — the reliability monitor caught a repeat loop, OR the agent has posted several
 *      updates without the step moving. Busy is not the same as advancing.
 *   3. `stuck` — the audit stream has gone quiet.
 *   4. `forward` — everything else.
 */
export function deriveProgress(inp: ProgressInputs): SessionProgress {
  const { now, claims } = inp;
  const latest = claims[0] ?? null;
  // The newest claim that actually carried a subject — an agent narrating step 7 with no subject should
  // keep the heading it set at step 1 rather than losing it.
  const subject = claims.find((c) => c.subject)?.subject ?? null;
  const step = latest?.step ?? null;
  // Same for the denominator: it belongs to the plan, not to one update.
  const total = claims.find((c) => c.total != null)?.total ?? null;
  const pct = step != null && total != null && total > 0 ? Math.max(0, Math.min(1, step / total)) : null;

  // Delta against the previous claim that carried a step (not merely the previous claim — a prose-only
  // update in between must not read as "no movement").
  let delta: number | null = null;
  if (step != null) {
    const prev = claims.slice(1).find((c) => c.step != null);
    if (prev?.step != null) delta = step - prev.step;
  }

  const stale = latest != null && now - latest.ts > STALL_MS;
  const quietFor = inp.lastActivityTs != null ? now - inp.lastActivityTs : null;

  // Stationary step: >= CIRCLE_MIN_CLAIMS updates inside the window and the step never rose across them.
  const inWindow = claims.filter((c) => now - c.ts <= CIRCLE_WINDOW_MS && c.step != null);
  const stationary =
    inWindow.length >= CIRCLE_MIN_CLAIMS && inWindow[0].step! <= inWindow[inWindow.length - 1].step!;

  let verdict: ProgressVerdict;
  let reason: string;
  if (inp.awaiting) {
    verdict = 'blocked';
    reason = inp.awaiting === 'approval' ? 'waiting on an approval decision' : 'waiting on an answer to its question';
  } else if (inp.loopTs != null && now - inp.loopTs <= LOOP_WINDOW_MS) {
    verdict = 'circling';
    const n = inp.loopCount ?? null;
    reason = n ? `repeated the same action ${n}× in a short window` : 'repeated the same action in a short window';
  } else if (stationary) {
    verdict = 'circling';
    reason = `${inWindow.length} updates and step is still ${inWindow[0].step}`;
  } else if (quietFor != null && quietFor > STALL_MS) {
    verdict = 'stuck';
    reason = `no activity for ${Math.round(quietFor / 60_000)} min`;
  } else if (quietFor == null && latest == null) {
    // Nothing legible has happened yet — a run that just started. Not stuck; just silent so far.
    verdict = 'forward';
    reason = 'just started';
  } else {
    verdict = 'forward';
    reason = delta != null && delta > 0 ? `step +${delta} since the last update`
      : quietFor != null ? `active in the last ${Math.max(1, Math.round(quietFor / 60_000))} min`
      : 'active';
  }

  return {
    subject, step, total, pct, delta, verdict, reason,
    note: latest?.note ?? null,
    ts: latest?.ts ?? null,
    stale,
  };
}

/** The optional position an agent attaches to an `update` call — the agent-owned half of the line. */
export interface ProgressPosition {
  subject?: string;
  step?: number;
  of?: number;
}
