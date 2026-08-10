/**
 * **Derived run outcome** — Step 1 of `docs/insights-revisit.md`.
 *
 * Everything Insights ever claimed rested on one number the agent wrote about itself. On live northwind
 * that number had no variance and a large hole: **one** reported failure in 329 reports lifetime, and
 * ~40% of terminated runs never called `report` at all. So "success rate" measured whether `report()` was
 * called. Step 0 deleted every channel that broadcast it; this module is the replacement it has to earn.
 *
 * The rules below read only **facts the OS observed itself** — the process crashed, the run made no tool
 * calls, a task closed while this run held it, another run had to pick the same task up afterwards. The
 * agent's own `report` is kept as ONE input among several, never the only one, and a human's 👍/👎
 * outranks everything (it is the only ground truth in the system, and covers 1 run in 512 — which is
 * exactly why it can't be the metric).
 *
 * Two framing choices matter as much as the rules:
 *
 *  - **The unit is a conversation, not a run.** A `poke:`/resume run continues an existing transcript, so
 *    scoring each row separately counts one piece of work several times (the same folding `sessionChain`
 *    does — runs group by `claude_session_id`).
 *  - **Not everything is scorable.** A human who spawns an interactive session and closes it hasn't
 *    produced a failure; they walked away. Those fold to `abandoned` and leave the denominator entirely,
 *    rather than quietly counting as not-success the way the old rate did (45 of 443 conversations on the
 *    live 30-day corpus).
 *
 * **Pure, and evaluated as-of `now`.** Nothing is written or stamped: a task that reopens tomorrow should
 * change yesterday's verdict, and freezing a snapshot at teardown would lock in an answer taken before the
 * evidence existed. Callers that need stability must pass an explicit window.
 *
 * Live 30-day corpus at the time of writing (443 conversations): 259 success · 48 noop · 41 partial ·
 * 10 failure · 5 incomplete · 45 abandoned (unscored) · **35 unknown = 8.8% of the 398 scorable**, against
 * 40% before. Non-success is 26% where the self-report claimed 0.3% — the point of the exercise is that
 * the number can now MOVE.
 */
import fs from 'node:fs';

import type { AgentOS } from '../kernel';
import { findTranscript } from './conversation';

const DAY = 24 * 3_600_000;

/** Ordered loosely worst→best; `abandoned` is outside the ordering (it leaves the denominator). */
export type RunVerdict = 'success' | 'partial' | 'incomplete' | 'noop' | 'failure' | 'abandoned' | 'unknown';

/** Which observed fact decided the verdict. Carried everywhere so a number can always be traced back to
 *  the evidence that produced it — the thing the old success rate could not do. */
export type OutcomeBasis =
  | 'human-rating'      // a person pressed 👍/👎 — ground truth, outranks all
  | 'crashed'           // the pane/process died: infra failure, not a judgement of the work
  | 'died-early'        // an unattended run that "finished" in seconds — it never got going
  | 'no-tool-calls'     // the run took a turn and called nothing: it did no work at all
  | 'reported'          // the agent's own `report` outcome
  | 'stopped-midway'    // a person killed an unattended run while it was working
  | 'task-completed'    // a task closed while this run held it
  | 'task-retried'      // another run had to pick the same task up after this one ended
  | 'human-session'     // a person's own interactive session — the OS has no verdict on it
  // ── read from the transcript, only for runs the fields above can't decide (Step 1b) ──
  | 'runtime-death'     // the transcript ends in a quota / auth error: the runtime killed the run
  | 'interrupted'       // a person interrupted the turn mid-flight
  | 'finished-clean'    // ended with a substantive closing message and no error: the turn landed
  | 'no-evidence';      // nothing observable said anything: honestly unknown

export interface RunOutcome {
  runId: string;
  convoId: string;         // claude_session_id when present — the transcript this run belongs to
  agent: string;
  verdict: RunVerdict;
  basis: OutcomeBasis;
  at: number;              // run start
  taskId?: string;
}

export interface ConversationOutcome {
  convoId: string;
  agent: string;
  verdict: RunVerdict;
  basis: OutcomeBasis;
  runs: number;
  at: number;              // first run's start
}

export interface OutcomeSummary {
  /** Conversations with a verdict we can defend — excludes `abandoned`. The denominator. */
  scorable: number;
  success: number;
  partial: number;
  incomplete: number;
  noop: number;
  failure: number;
  /** Excluded from `scorable`: a human walked away from their own interactive session. */
  abandoned: number;
  /** Scorable but undecidable — the honest residual. */
  unknown: number;
  /** success / scorable, or null below `minSample`. Never derived from a denominator that includes
   *  `abandoned`, and never reported without `unknown` beside it. */
  successRate: number | null;
  /** Share of scorable conversations we could not decide. A rate is meaningless if this is large — the
   *  precise failure of the metric this module replaces. */
  unknownShare: number | null;
}

/** Below this many scorable conversations, `successRate` stays null — a rate needs a sample (the standing
 *  lesson from the 2026-07-31 approval-friction correction, applied up front this time). */
export const MIN_SAMPLE = 10;

interface Row {
  id: string; agent: string; status: string; spawned_by: string | null; claude_session_id: string | null;
  rating: string | null; outcome: string | null; tool_calls: number | null; active_ms: number | null;
  created_at: number; ended: number;
}

/**
 * An unattended run that terminated in under this much working time never got going. Not a guess — on the
 * live 30-day corpus, unattended runs split cleanly by wall-clock:
 *
 *     2m+       67 runs, 64 reported an outcome  (96%)
 *     30–120s   50 runs, 42 reported             (84%)
 *     <30s      44 runs,  0 reported             ( 0%)
 *
 * Nothing under 30 seconds has EVER reported. Reading the transcripts explains why: they die on the first
 * API call — `You've hit your weekly limit`, `401 OAuth access token has expired` — which is this fleet's
 * single most common real failure (see the weekly-limit zombie sessions we've chased repeatedly) and is
 * structurally invisible to the agent, since the agent is what stopped existing. The blind labels caught
 * four of these; the first version of these rules scored them `unknown` or `noop`.
 *
 * Two guards, both bought with a wrong answer:
 *  - **Automation runs only.** The statistic above is over `automation:`-spawned runs. Applied to every
 *    unattended run it mislabelled a poke-test ping, an engineer smoke test and a stand-down — task runs
 *    that legitimately finish in seconds — as failures.
 *  - **It must have called something.** A run that died mid-flight had started working; one that called
 *    nothing just answered and stopped (an agent replying "looks like a test message"). Zero tool calls
 *    falls through to `noop`, which is what it is.
 */
const DIED_EARLY_MS = 30_000;

/**
 * **The transcript layer** (Step 1b). Round 2 of the falsifier scored 52% out of sample against a 43%
 * always-success baseline, and 8 of its 11 errors came from two blind spots the session row cannot see:
 * runs the runtime killed (scored `noop`, because a run that dies on its first API call also makes no tool
 * calls) and runs that finished properly but never called `report` (scored `unknown`). Both are legible in
 * the transcript in one line, so this reads it — but only for the runs the observed fields could not
 * already decide, which is ~50 of 477 conversations on the live corpus.
 *
 * What the corpus says, scanning every transcript by current basis:
 *
 *     died-early     17 of 19 carry an auth/quota signature   (the rule was right about what it found)
 *     no-tool-calls  11 of 30 carry one                       (scored `noop`; they are deaths)
 *     no-evidence     0 of 22 carry one — and all 22 end with a 600–3300 char closing summary
 *
 * The last line is the useful surprise: there were no silent runs in the residual at all. Every one of
 * them finished, wrote a real hand-off, and simply never called `report`. That is a success the OS was
 * throwing away, not an unknown.
 *
 * Signatures are matched against the transcript TAIL only — a run that recovered from a rate limit
 * mid-way and carried on must not be called dead because the phrase appears somewhere in its history.
 */
const RUNTIME_DEATH = [
  /hit your weekly limit/i,
  /hit your session limit/i,
  /OAuth access token has expired/i,
  /Please run \/login/i,
  /Credit balance is too low/i,
];
const INTERRUPTED = /Request interrupted by user/i;
/** Tail window. Big enough to hold a closing summary (the longest seen is ~3.3KB), small enough that an
 *  error the run recovered from ten turns ago is out of frame. */
const TAIL_BYTES = 8_000;
/** A closing message shorter than this isn't a hand-off — it's an acknowledgement or a stub. */
const SUBSTANTIVE_CHARS = 200;

/** What the transcript says about how a run ended. `undefined` when there is no transcript to read. */
export interface TranscriptEnd { died: boolean; interrupted: boolean; closingChars: number }

/** Read the tail of a conversation's transcript. Never throws: a missing or unreadable transcript is a
 *  normal case (95% coverage on the live box, and none on a machine that didn't run the agent). */
export function readTranscriptEnd(convoId: string, find = findTranscript): TranscriptEnd | undefined {
  const p = find(convoId);
  if (!p) return undefined;
  let tail: string;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }

  // The closing assistant text, for "did it end with a real hand-off". Lines are JSONL; the tail may start
  // mid-line, so a parse failure is expected and skipped rather than treated as absence.
  let closing = '';
  for (const line of tail.split('\n')) {
    try {
      const j = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
      if (j.message?.role !== 'assistant') continue;
      const c = j.message.content;
      const text = Array.isArray(c)
        ? (c as { type?: string; text?: string }[]).filter((x) => x.type === 'text').map((x) => x.text ?? '').join(' ')
        : String(c ?? '');
      if (text.trim()) closing = text.trim();
    } catch { /* partial or non-message line */ }
  }
  return {
    died: RUNTIME_DEATH.some((re) => re.test(tail)),
    interrupted: INTERRUPTED.test(tail),
    closingChars: closing.length,
  };
}

/** A run spawned by chat is conversational Q&A — it answers a person and rarely `report`s, so it is not
 *  work with an outcome. Matches the exclusion `insights.ts` and `measurement.ts` already apply. */
function isChat(spawnedBy: string | null): boolean {
  return (spawnedBy ?? '').startsWith('chat:');
}

/** A person (member id or email) spawned this, as opposed to an automation / task / poke / goal. */
function isHumanSpawned(spawnedBy: string | null): boolean {
  const s = spawnedBy ?? '';
  return s.startsWith('m_') || s.includes('@');
}

/** The task a run was dispatched for, if any. `task:<id>` is a first attempt, `poke:<id>` a resume. */
function taskIdOf(spawnedBy: string | null): string | undefined {
  const s = spawnedBy ?? '';
  if (s.startsWith('task:')) return s.slice(5);
  if (s.startsWith('poke:')) return s.slice(5);
  return undefined;
}

/**
 * Classify every terminated run in the window. First matching rule wins; the order is the point, so it is
 * spelled out rather than scored:
 *
 *  1. a human's verdict, when there is one — nothing we infer outranks a person who looked at the work;
 *  2. the process died — infra, and invisible to the agent, so it can never be self-reported;
 *  3. zero tool calls — the run did nothing. On the live corpus **all 56** such runs also reported nothing,
 *     which is why this sits above the report: there is no report to prefer, and "did nothing" read as
 *     "unknown" is how a broken automation stayed invisible (one agent produced 18 empty runs in 30 days);
 *  4. the agent's own report — trusted where it exists, just no longer alone;
 *  5. a task closed while this run held it — the strongest positive evidence the OS observes itself;
 *  6. another run picked the same task up afterwards — this one didn't finish it (`incomplete`, not
 *     `failure`: not finishing and failing are different, and the old metric conflated them);
 *  7. a person spawned it and closed it — `abandoned`, leaves the denominator;
 *  8. otherwise `unknown`. Honest, and the residual we are trying to shrink.
 */
export function deriveRunOutcomes(
  os: AgentOS,
  opts: { since?: number; until?: number; findTranscript?: typeof findTranscript } = {},
): RunOutcome[] {
  const db = os.db;
  const find = opts.findTranscript ?? findTranscript;
  const seen = new Map<string, TranscriptEnd | null>();   // one read per conversation, not per run
  const until = opts.until ?? Date.now();
  const since = opts.since ?? until - 30 * DAY;

  const rows = db
    .prepare(
      'SELECT id, agent, status, spawned_by, claude_session_id, rating, outcome, tool_calls, active_ms, created_at, ' +
        'COALESCE(updated_at, created_at) AS ended FROM term_sessions ' +
        "WHERE created_at >= ? AND created_at < ? AND status != 'running'",
    )
    .all<Row>(since, until);

  // Which runs closed a task, by run id — `task.completed` is the audit the dispatcher writes when an
  // agent closes its own loop, and unlike a `task_events` status row it carries the run that did it
  // (5 of 350 status rows have a session id; attribution has to come from the audit log).
  const closers = new Set<string>();
  for (const r of db.prepare("SELECT DISTINCT run_id FROM audit_events WHERE type = 'task.completed' AND run_id IS NOT NULL AND ts >= ?").all<{ run_id: string }>(since)) {
    closers.add(r.run_id);
  }

  // Task → the closing audit's timestamp, so a run can claim a close only if the task shut while it held
  // it. Without the time check, every earlier attempt on a since-completed task would read as a success.
  const taskDoneAt = new Map<string, number>();
  for (const r of db.prepare("SELECT id, status, updated_at FROM tasks WHERE status = 'done'").all<{ id: string; status: string; updated_at: number }>()) {
    taskDoneAt.set(r.id, r.updated_at);
  }

  // Task → the start of the LAST run dispatched for it. A run that ended before that had to be followed
  // by another attempt, i.e. it didn't finish the job.
  const lastRunFor = new Map<string, number>();
  for (const row of rows) {
    const tid = taskIdOf(row.spawned_by);
    if (!tid) continue;
    lastRunFor.set(tid, Math.max(lastRunFor.get(tid) ?? 0, row.created_at));
  }

  const out: RunOutcome[] = [];
  for (const r of rows) {
    if (isChat(r.spawned_by)) continue;                       // not work with an outcome
    const taskId = taskIdOf(r.spawned_by);
    const base = { runId: r.id, convoId: r.claude_session_id || r.id, agent: r.agent, at: r.created_at, taskId };

    let verdict: RunVerdict, basis: OutcomeBasis;
    const doneAt = taskId ? taskDoneAt.get(taskId) : undefined;
    // 5 minutes of slack: the audit lands as the run tears down, so an exact `<= ended` drops real closes.
    const closedByThisRun = doneAt != null && doneAt >= r.created_at && doneAt <= r.ended + 5 * 60_000;

    const unattended = !isHumanSpawned(r.spawned_by);

    if (r.rating === 'up') { verdict = 'success'; basis = 'human-rating'; }
    else if (r.rating === 'down') { verdict = 'failure'; basis = 'human-rating'; }
    // A person's own interactive session: they typed, they read, they closed the window. The OS observes
    // no verdict — closing a pane after getting your answer looks identical to walking away, and the blind
    // labels called four such runs successes that v1 scored `abandoned`. Same posture as chat: out of the
    // denominator, not counted as not-success.
    else if (!unattended) { verdict = 'abandoned'; basis = 'human-session'; }
    else if (r.status === 'crashed') { verdict = 'failure'; basis = 'crashed'; }
    // Above the report and above no-tool-calls: there is no report (0 of 44 such runs ever wrote one), and
    // "died on the first API call" is a truer account than "made no tool calls".
    else if ((r.spawned_by ?? '').startsWith('automation:') && r.active_ms != null && r.active_ms < DIED_EARLY_MS && (r.tool_calls ?? 0) > 0) { verdict = 'failure'; basis = 'died-early'; }
    else if (r.tool_calls === 0) { verdict = 'noop'; basis = 'no-tool-calls'; }
    else if (r.outcome === 'success' || r.outcome === 'completed') { verdict = 'success'; basis = 'reported'; }
    else if (r.outcome === 'partial' || r.outcome === 'progressed') { verdict = 'partial'; basis = 'reported'; }
    else if (r.outcome === 'failure' || r.outcome === 'blocked') { verdict = 'failure'; basis = 'reported'; }
    // Killed mid-flight outranks a task close: v1 scored two runs `success` because the task they held
    // shut inside their window, when the transcripts show both were cut off (session limit) and something
    // else closed the task. A run that was stopped did not finish.
    else if (r.status === 'stopped') { verdict = 'incomplete'; basis = 'stopped-midway'; }
    else if (closers.has(r.id) || closedByThisRun) { verdict = 'success'; basis = 'task-completed'; }
    else if (taskId && (lastRunFor.get(taskId) ?? 0) > r.created_at) { verdict = 'incomplete'; basis = 'task-retried'; }
    else { verdict = 'unknown'; basis = 'no-evidence'; }

    // The transcript layer, consulted ONLY where the observed fields gave up (`no-evidence`) or gave an
    // answer they cannot distinguish from a death (`no-tool-calls`: a run killed on its first API call
    // makes no tool calls either). Everything decided above keeps its verdict — a `reported` outcome or a
    // human rating is not second-guessed by prose. Lazy by construction: ~50 file reads, not 500.
    if (basis === 'no-evidence' || basis === 'no-tool-calls') {
      let end = seen.get(base.convoId);
      if (end === undefined) { end = readTranscriptEnd(base.convoId, find) ?? null; seen.set(base.convoId, end); }
      if (end) {
        if (end.died) { verdict = 'failure'; basis = 'runtime-death'; }
        else if (end.interrupted) { verdict = 'incomplete'; basis = 'interrupted'; }
        else if (basis === 'no-evidence' && end.closingChars >= SUBSTANTIVE_CHARS) { verdict = 'success'; basis = 'finished-clean'; }
      }
    }

    out.push({ ...base, verdict, basis });
  }
  return out;
}

/** Worst-wins ordering when a conversation's runs disagree. A resume that ends clean does not erase the
 *  crash before it, but a `noop` run inside a conversation that also did real work is just a quiet turn —
 *  hence `noop` ranks below `unknown` here and only survives when it is all there is. */
const SEVERITY: Record<RunVerdict, number> = { failure: 6, incomplete: 5, partial: 4, unknown: 3, noop: 2, success: 1, abandoned: 0 };

/**
 * Fold runs into conversations (`claude_session_id`) — one piece of work, however many resumes it took.
 * The verdict is the most severe run verdict, EXCEPT that any explicit success (reported or task-closing)
 * inside the conversation wins over `incomplete`/`noop`/`unknown`: a hand-off that needed three pokes and
 * then finished is a success that took three pokes, not three-quarters of a failure.
 */
export function foldConversations(runs: RunOutcome[]): ConversationOutcome[] {
  const byConvo = new Map<string, RunOutcome[]>();
  for (const r of runs) {
    const a = byConvo.get(r.convoId) ?? [];
    a.push(r);
    byConvo.set(r.convoId, a);
  }
  const out: ConversationOutcome[] = [];
  for (const [convoId, list] of byConvo) {
    list.sort((a, b) => a.at - b.at);
    const succeeded = list.find((r) => r.verdict === 'success');
    const hardFail = list.find((r) => r.verdict === 'failure' || r.verdict === 'partial');
    const worst = list.reduce((acc, r) => (SEVERITY[r.verdict] > SEVERITY[acc.verdict] ? r : acc), list[0]);
    // A conversation that ENDS in success is a success, whatever it took to get there. Without this, a
    // four-run hand-off where the first three attempts each look `incomplete` (each was followed by
    // another run, which is what `task-retried` means) is scored by its struggle instead of its result —
    // one of round 2's errors. A `failure`/`partial` before a later success still wins: that is a real
    // problem the conversation went through, not a bookkeeping artefact of being resumed.
    const last = list[list.length - 1];
    const pick = last.verdict === 'success' && !hardFail ? last : hardFail ?? succeeded ?? worst;
    out.push({ convoId, agent: pick.agent, verdict: pick.verdict, basis: pick.basis, runs: list.length, at: list[0].at });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Roll conversations up into the headline counts. `abandoned` is excluded from `scorable` by
 *  construction, and `successRate` is withheld below `MIN_SAMPLE` and always accompanied by
 *  `unknownShare` — a success rate sitting next to a 40% unknown share is how we got here. */
export function summarize(convos: ConversationOutcome[]): OutcomeSummary {
  const n = (v: RunVerdict) => convos.filter((c) => c.verdict === v).length;
  const abandoned = n('abandoned');
  const scorable = convos.length - abandoned;
  const success = n('success');
  return {
    scorable, success, partial: n('partial'), incomplete: n('incomplete'), noop: n('noop'),
    failure: n('failure'), abandoned, unknown: n('unknown'),
    successRate: scorable >= MIN_SAMPLE ? Math.round((success / scorable) * 100) : null,
    unknownShare: scorable ? Math.round((n('unknown') / scorable) * 100) : null,
  };
}

/** Convenience: window → summary + the folded conversations behind it. */
export function measureOutcomes(os: AgentOS, opts: { since?: number; until?: number } = {}): { summary: OutcomeSummary; conversations: ConversationOutcome[] } {
  const conversations = foldConversations(deriveRunOutcomes(os, opts));
  return { summary: summarize(conversations), conversations };
}
