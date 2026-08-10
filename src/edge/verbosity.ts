// Terse output — the prompt brief that implements `RuntimeTuning.verbosity`, and the measurement that
// tells you whether it actually paid for itself.
//
// The idea is borrowed from the "caveman" prompt-compression skill: most of what an agent emits is
// connective prose no one reads, and output tokens are both the priciest per token AND re-billed as
// input + cache-write on every subsequent turn — so trimming narration compounds across a long run.
//
// What makes this safe is the carve-out list. Agentric runs on the artifacts its agents write: `report`
// lessons feed consolidation, `remember` feeds recall, `kb_write` is a wiki humans read, `slack_reply`
// is a message to a person. Compressed prose in any of those quietly degrades the learning loop and the
// human-facing surface, and it degrades them somewhere far from the flag that caused it. So the brief
// compresses the transcript's NARRATION only and names the exempt surfaces explicitly.
//
// It is a prompt instruction, not an enforced transform: the model can ignore it, and compliance drifts
// by model and by task. That is exactly why `verbositySavings` exists — the flag ships with the query
// that can falsify it.

import type { DatabaseSync } from 'node:sqlite';

/** Appended to the system prompt (via `buildCompanyMd`) when the resolved verbosity is `terse`. */
export const TERSE_OUTPUT_BRIEF =
  '# Output style — terse\n\n' +
  'This workspace runs you in **terse** mode. Your commentary is a cost: every token you emit is billed ' +
  'at the output rate and then re-billed as input on each following turn. Spend it only where it carries ' +
  'information.\n\n' +
  '**Compress your narration.** Drop preamble ("Great question!", "Let me look at that"), drop the ' +
  'restatement of what you were just asked, drop the recap of what you just did when the tool output ' +
  'already shows it, and drop closing summaries of a single-step action. Prefer a sentence to a ' +
  'paragraph and a fragment to a sentence. Say the finding, not the journey to it. No filler adverbs, no ' +
  'hedging you do not mean, no bulleted restatement of a bulleted list.\n\n' +
  '**Never compress these — reproduce them exactly:**\n' +
  '- Code, diffs, commands, file paths, identifiers, URLs, and any literal you are quoting.\n' +
  '- Error messages, stack traces, logs, and test output. Byte-for-byte, never paraphrased.\n' +
  '- Numbers, units, and counts.\n\n' +
  '**Never compress what you write for a human or for the future — these are artifacts, not chatter:**\n' +
  'the arguments you pass to `report`, `remember`, `revise`, `kb_write`, `task_create`/`task_update`, ' +
  '`ask`, `notify`, `publish`, `skill_propose`, and any chat reply (`slack_reply`/`slack_send`/`slack_dm`, ' +
  '`discord_reply`/`discord_send`/`discord_dm`, `clickup_reply`, `telegram_reply`). Those are read by ' +
  'teammates, or feed memory and consolidation, and terse phrasing there costs far more than it saves. ' +
  'Write them in full, ordinary prose.\n\n' +
  '**Terse is not vague, and not curt.** If brevity would drop a caveat, a risk, or a reason a person ' +
  'needs, keep it — completeness wins over length every time. A human who asks you to explain something ' +
  'is asking for the explanation; give it to them properly. This is about cutting words that carry ' +
  'nothing, never about withholding substance or being blunt with people.';

/** One arm of the comparison: what a set of sessions cost, per turn. */
export interface VerbosityArm {
  /** Sessions with usable cost data (a parsed transcript). */
  sessions: number;
  /** Conversation turns across them — the denominator. A run with more turns costs more for reasons
   *  that have nothing to do with verbosity, so totals are not comparable; per-turn is. */
  turns: number;
  /** Mean output tokens per turn — the metric the brief acts on DIRECTLY. */
  outputPerTurn: number;
  /** Mean total USD per turn — what actually lands on the bill (output is a minority of it). */
  usdPerTurn: number;
}

export interface VerbosityComparison {
  normal: VerbosityArm;
  terse: VerbosityArm;
  /** Percent reduction terse vs normal, positive = cheaper. Null when either arm is under-powered. */
  outputDelta: number | null;
  usdDelta: number | null;
  /** True when both arms clear {@link MIN_SESSIONS_PER_ARM} — i.e. the deltas are worth reading. */
  comparable: boolean;
}

export interface VerbositySavings extends VerbosityComparison {
  /** Per-agent breakdown, only for agents that have run BOTH ways (the only fair comparison — see the
   *  note on `verbositySavings`). Sorted by the agent with the most terse turns first. */
  byAgent: Array<{ agent: string } & VerbosityComparison>;
}

/** Below this, an arm is noise: a couple of runs of different tasks say nothing about verbosity. */
const MIN_SESSIONS_PER_ARM = 5;

function arm(row: { sessions: number; turns: number; output: number; usd: number } | undefined): VerbosityArm {
  const turns = row?.turns ?? 0;
  return {
    sessions: row?.sessions ?? 0,
    turns,
    outputPerTurn: turns ? Math.round((row?.output ?? 0) / turns) : 0,
    usdPerTurn: turns ? +((row?.usd ?? 0) / turns).toFixed(4) : 0,
  };
}

function compare(normal: VerbosityArm, terse: VerbosityArm): VerbosityComparison {
  const comparable = normal.sessions >= MIN_SESSIONS_PER_ARM && terse.sessions >= MIN_SESSIONS_PER_ARM;
  const pct = (a: number, b: number) => (comparable && a > 0 ? +(((a - b) / a) * 100).toFixed(1) : null);
  return {
    normal,
    terse,
    outputDelta: pct(normal.outputPerTurn, terse.outputPerTurn),
    usdDelta: pct(normal.usdPerTurn, terse.usdPerTurn),
    comparable,
  };
}

/**
 * Compare what terse and normal sessions actually cost, per turn, over a trailing window.
 *
 * This is deliberately an OBSERVATIONAL comparison, not a claim of causation, and it is easy to fool
 * yourself with. Two guards are built in:
 *
 *  - **Per-turn, not per-session.** A long run costs more because it did more, not because it was
 *    wordy. Turns are the denominator (the same reasoning as any rate metric — a raw counter over a
 *    growing corpus tells you nothing about the present).
 *  - **`byAgent` only lists agents that ran BOTH ways.** The fleet-wide numbers are still confounded:
 *    if you flip your cron-heavy agents to terse, the terse arm is made of different WORK, and the
 *    delta measures that instead. The per-agent rows hold the agent fixed, so they are the numbers to
 *    trust; the top-line pair is context, not evidence.
 *
 * Even then, the model is different between the arms if you also changed it, and a flip is not
 * randomised. Read this as "did anything move", not as a verified saving.
 *
 * Reads only terminal, costed sessions (`turns > 0`), so a still-running row can't half-count.
 */
export function verbositySavings(db: DatabaseSync, windowDays = 30): VerbositySavings {
  const since = Date.now() - windowDays * 86_400_000;
  // No tenant predicate: the DB file IS the tenant boundary, and term_sessions has no tenant column.
  // A row predating this feature has verbosity NULL and cannot be attributed — it is neither arm.
  const rows = db
    .prepare(
      `SELECT agent, verbosity,
              COUNT(*)               AS sessions,
              SUM(turns)             AS turns,
              SUM(output_tokens)     AS output,
              SUM(cost_usd)          AS usd
         FROM term_sessions
        WHERE created_at >= ? AND verbosity IN ('normal','terse')
          AND cost_usd IS NOT NULL AND turns > 0
        GROUP BY agent, verbosity`,
    )
    .all<{ agent: string; verbosity: string; sessions: number; turns: number; output: number; usd: number }>(since);

  const perAgent = new Map<string, { normal?: typeof rows[number]; terse?: typeof rows[number] }>();
  const totals: { normal?: { sessions: number; turns: number; output: number; usd: number }; terse?: { sessions: number; turns: number; output: number; usd: number } } = {};
  for (const r of rows) {
    const key = r.verbosity === 'terse' ? 'terse' : 'normal';
    const bucket = perAgent.get(r.agent) ?? {};
    bucket[key] = r;
    perAgent.set(r.agent, bucket);
    const t = totals[key] ?? { sessions: 0, turns: 0, output: 0, usd: 0 };
    t.sessions += r.sessions; t.turns += r.turns; t.output += r.output ?? 0; t.usd += r.usd ?? 0;
    totals[key] = t;
  }

  const byAgent = [...perAgent.entries()]
    .filter(([, b]) => b.normal && b.terse) // both arms, or the row would compare an agent to itself
    .map(([agent, b]) => ({ agent, ...compare(arm(b.normal), arm(b.terse)) }))
    .sort((a, b) => b.terse.turns - a.terse.turns);

  return { ...compare(arm(totals.normal), arm(totals.terse)), byAgent };
}
