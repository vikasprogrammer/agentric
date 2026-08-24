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
//
// AND IT DID. `npm run bench:verbosity` (scripts/verbosity-benchmark.cjs) ran the brief as a paired,
// controlled A/B — 14 tool-free prompts, both arms, claude-sonnet-5, 2 reps, tools disallowed so the
// response is pure narration. The result: a mean per-prompt narration change of **-0.6% in a bare
// system prompt and -4.6% behind the real 14k-token company context**, with terse the shorter arm on
// 6/14 and 5/14 prompts — a coin flip. The treatment effect (13–18%) is SMALLER than the rep-to-rep
// spread WITHIN one arm (22–24%), so the brief's effect on narration length is not distinguishable
// from noise. Completeness was unharmed (terse 28/28 vs normal 26/28 minimal), so it is not trading
// brevity for substance either — it is simply not landing.
//
// Two things the benchmark also established, both of which invalidate reading `verbositySavings` as
// evidence about this brief:
//   - **`output_tokens` cannot measure narration.** Over 40 recent live transcripts the assistant's
//     output bytes are ~85% `tool_use` ARGUMENTS (file writes, commands, patches) and ~15% `text`.
//     Thinking is a further ~18% of the token counter. The brief compresses narration only, so even
//     total compliance could not move `output_tokens` more than ~15% — and the ±50–90% per-agent
//     swings the query reports on live data are tool-use volume, i.e. which task the agent drew.
//   - **The brief spends 72% of its words telling the model NOT to compress.** 123 words instruct
//     brevity; 312 are carve-outs and reassurance ("terse is not vague", "completeness wins over
//     length every time"). For contrast the `caveman` project's SKILL.md — concrete drop-lists, a
//     pattern template, a worked before/after example — benchmarks at 65% on the same kind of
//     paired harness.
// Re-run the benchmark before changing the text below, and again after. Do not quote a saving from
// `verbositySavings` alone.
//
// A REWRITE WAS TRIED AND REJECTED (v0.371.0). The obvious fix for the 72/28 ratio was written — a
// named delete-list of filler words and constructions instead of "prefer a sentence to a paragraph",
// one worked verbose/terse example, the carve-outs compressed to hard lists rather than paragraphs of
// reassurance, 63% of words instructing brevity, 555 tokens instead of 660. Head-to-head against this
// text over a shared control (504 calls, claude-sonnet-5, 6 reps, $15):
//
//     old brief  minimal -4.8% [-15.8, +5.2]   production -0.4% [-11.1, +9.0]
//     new brief  minimal -4.0% [-15.7, +5.4]   production -9.6% [-22.2, +0.1]
//
// Every interval spans zero, so neither text is distinguishable from no brief at all, and the rewrite
// trended WORSE in production (shorter on 5/14 prompts against the old text's 9/14). It was reverted
// rather than shipped on a prior. What the run does establish is the size of the effect it can rule
// out: per-call narration length has a ~20-23% coefficient of variation whatever you put in the
// prompt, so an effect above ~10% would have shown at this power and did not.
//
// So the open question is no longer "which wording" — two quite different texts both land inside the
// noise. It is whether an APPENDED SYSTEM PROMPT is the right lever at all. The next thing worth
// measuring is a different mechanism (per-turn reinforcement through the gate hook's
// `additionalContext`, which is the only channel that reaches the model mid-turn), not a third
// rewording. Do not spend another rewrite without that.
//
// THAT MECHANISM WAS THEN MEASURED (v0.388.0), and it is REAL BUT NOT WORTH WIRING FOR COST.
// `npm run bench:verbosity-turns` walks five six-turn threads through three arms — no brief, the
// brief in the system prompt, and the brief PLUS a 61-token reminder re-injected every turn via a
// `UserPromptSubmit` hook. 270 turns, sonnet, 3 reps, the live ~13k company prompt underneath
// (raw rows kept in `scripts/verbosity-turns-result.json`; re-read them with `--analyze`):
//
//     system     vs control    +1.0%  [-7.1, +7.8]   still nothing, now confirmed multi-turn
//     reinforced vs system     +6.8%  [+0.5, +13.3]  CI EXCLUDES ZERO — the mechanism works
//     reinforced vs control    +8.4%  [-0.4, +16.6]  end to end, still inside the noise
//
// Three things follow, and the second and third are why nothing was wired:
//
//  1. **The decay hypothesis was WRONG.** Every arm gets MORE verbose across turns (slopes +4.2,
//     +6.9, +8.1 tokens/turn) and `reinforced` grows fastest of the three. There is no decay for a
//     reminder to prevent. The gain is roughly flat across turn index — 4.2% on turn ONE — so what
//     the hook actually buys is PROXIMITY: an instruction next to the user's message outweighs the
//     same instruction 13k tokens up, from the very first turn. Worth knowing for any future steer,
//     not just this one.
//  2. **The money is not there.** 26.4 output tokens saved per turn against 61 input tokens spent on
//     the reminder nets ~$0.00017/turn — about **$0.13/month** across instapods' 780 terse turns.
//     That is the whole prize, and it is consistent with the ceiling established earlier: narration
//     is ~15% of output tokens and this moves ~7% of that, i.e. ~1% of spend.
//  3. **It was tested on the wrong lane for the fleet's spend.** `UserPromptSubmit` fires on a USER
//     message, so this result covers chat / resident / thread-continuation sessions. The unattended
//     lane — which is where most fleet spend lives — has almost no user prompts; its turns are driven
//     by tool calls, and the analogous channel there is PreToolUse `additionalContext`, which this
//     did NOT test. Do not generalise the +6.8% to unattended runs.
//
// One genuine non-cost finding, and the only reason to revisit any of this: the reinforced arm was
// also MORE COMPLETE — it answered with the required facts on 60/90 turns against control's 48/90
// (paired, discordant 20 vs 8, exact binomial p=0.036). Against the system-prompt arm it is a trend
// only (17 vs 7, p=0.064). So the reminder makes answers shorter AND better, which is a quality
// argument rather than a cost one. If terse is ever revisited, revisit it as an answer-shape feature
// and measure completeness, not tokens.
//
// The carve-out has a failure mode of its own, and it showed up live: a terse `engineer` run answered a
// console question at essay length, and the owner had to reply "explain to me in 1 liner". Nothing was
// broken — the answer landed in the exempt lane, and "write them in full, ordinary prose" reads as a
// LICENCE to be long. So the exemption now says what it always meant: exempt from compression is not
// exempt from shape. Those surfaces keep their prose and every caveat; they still lead with the answer
// and still don't say a thing twice. That is a discipline the artifacts want anyway — a `report` whose
// first line is the outcome is a better input to consolidation than one that arrives at it in paragraph
// four.

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
  '**Exempt from compression is not a licence to be long.** Those surfaces keep ordinary prose and every ' +
  'caveat, but the same discipline applies to their SHAPE. Lead with the answer, the finding or the ' +
  'outcome in the first sentence, then give only what a reader needs in order to act on it or trust it. ' +
  'Do not write a summary and then restate the same content as detail. Do not recount the steps you took ' +
  'to reach a finding the finding already implies. Do not pad a section so it looks complete, and do not ' +
  'add a closing paragraph that repeats the opening one. Every extra sentence has to earn its place with ' +
  'content a reader would miss if it were cut. When someone asks a narrow question, answer THAT question ' +
  'first — offer the wider context after it, or not at all.\n\n' +
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
  /** Mean output tokens per turn. NOT a measure of narration length — see the correction on
   *  {@link verbositySavings}. `output_tokens` is dominated by tool-call arguments and thinking, both
   *  of which the brief leaves untouched. */
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
