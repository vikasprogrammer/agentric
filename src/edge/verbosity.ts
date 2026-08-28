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
// by model and by task. So the flag shipped beside a query that was meant to falsify it —
// `verbositySavings()`, comparing the two arms' cost per turn on live traffic.
//
// THAT QUERY WAS THE WRONG INSTRUMENT, and it has been retired (v0.389.0, see `verbosityAdoption`
// below). What actually falsified the flag was a controlled experiment. `npm run bench:verbosity` (scripts/verbosity-benchmark.cjs) ran the brief as a paired,
// controlled A/B — 14 tool-free prompts, both arms, claude-sonnet-5, 2 reps, tools disallowed so the
// response is pure narration. The result: a mean per-prompt narration change of **-0.6% in a bare
// system prompt and -4.6% behind the real 14k-token company context**, with terse the shorter arm on
// 6/14 and 5/14 prompts — a coin flip. The treatment effect (13–18%) is SMALLER than the rep-to-rep
// spread WITHIN one arm (22–24%), so the brief's effect on narration length is not distinguishable
// from noise. Completeness was unharmed (terse 28/28 vs normal 26/28 minimal), so it is not trading
// brevity for substance either — it is simply not landing.
//
// Two things the benchmark also established, the first of which is why the live query had to go
// rather than be caveated:
//   - **`output_tokens` cannot measure narration.** Over 40 recent live transcripts the assistant's
//     output bytes are ~85% `tool_use` ARGUMENTS (file writes, commands, patches) and ~15% `text`.
//     Thinking is a further ~18% of the token counter. The brief compresses narration only, so even
//     total compliance could not move `output_tokens` more than ~15% — and the ±50–90% per-agent
//     swings the retired query reported on live data were tool-use volume, i.e. which task the agent
//     drew.
//   - **The brief spends 72% of its words telling the model NOT to compress.** 123 words instruct
//     brevity; 312 are carve-outs and reassurance ("terse is not vague", "completeness wins over
//     length every time"). For contrast the `caveman` project's SKILL.md — concrete drop-lists, a
//     pattern template, a worked before/after example — benchmarks at 65% on the same kind of
//     paired harness.
// Re-run the benchmark before changing the text below, and again after. There is no longer a live
// query that will give you a saving figure, and that is deliberate.
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

/**
 * Adoption of the terse flag over a trailing window — WHO is running which level, and nothing more.
 *
 * This replaces `verbositySavings()`, which reported output-tokens-per-turn and USD-per-turn deltas
 * between the two arms and presented them as a saving. That number was retired in v0.389.0 because it
 * cannot mean what it was read to mean, and it was read that way: against the live instapods DB it
 * called terse 28-92% WORSE on four of five agents, which was not evidence of anything.
 *
 * Three defects, none fixable from inside a query over `term_sessions`:
 *
 *  1. **Wrong quantity.** `output_tokens` is ~85% `tool_use` ARGUMENTS (file writes, commands,
 *     patches) and ~15% `text`, with thinking a further ~18% of the counter (measured over 40 live
 *     transcripts). The brief compresses narration only, so the metric barely contains the thing the
 *     flag acts on; the large per-agent swings were tool-use volume, i.e. which task the agent drew.
 *  2. **A denominator the treatment moves.** Terse changes turn SHAPE, so dividing by turns lets it
 *     inflate its own per-turn number — `marketing-manager` read 92% worse per turn and 25% cheaper
 *     per session, from the same rows.
 *  3. **A cutover, not a split.** Every normal session predated 2026-08-07 and every terse one
 *     followed it, so everything else that changed that day sat inside the treatment arm.
 *
 * The effect question is now answered by controlled experiment instead — `npm run bench:verbosity`
 * (single-turn) and `npm run bench:verbosity-turns` (multi-turn), both paired, both shipping a
 * bootstrap CI that refuses a verdict inside the noise. What they found: the brief is not
 * distinguishable from no brief at all; per-turn reinforcement IS (+6.8%, CI [+0.5, +13.3]) but is
 * worth ~$0.13/month fleet-wide, because narration is ~15% of output tokens and this moves ~7% of
 * that. Terse is a style preference with a ~1% ceiling on spend, not a cost lever, and no console
 * surface should imply otherwise.
 *
 * So what remains here is the honest half: how far the setting has actually spread. Useful for
 * "which agents am I running terse?" and safe to read literally, because a count of rows is exactly
 * what it claims to be.
 */
export interface VerbosityAdoption {
  windowDays: number;
  /** Sessions started in the window, by resolved level. `unstamped` are rows from before the flag
   *  existed (or runs that never resolved one) — attributable to neither level. */
  sessions: { normal: number; terse: number; unstamped: number };
  /** Per-agent counts, most terse runs first. An agent appears once it has run at either level. */
  byAgent: Array<{ agent: string; normal: number; terse: number }>;
}

/**
 * Count sessions by resolved verbosity over a trailing window. No cost, no tokens, no deltas — see
 * the note above for why those were removed rather than caveated.
 */
export function verbosityAdoption(db: DatabaseSync, windowDays = 30): VerbosityAdoption {
  const since = Date.now() - windowDays * 86_400_000;
  // No tenant predicate: the DB file IS the tenant boundary, and term_sessions has no tenant column.
  const rows = db
    .prepare(
      `SELECT agent, COALESCE(verbosity, '') AS verbosity, COUNT(*) AS n
         FROM term_sessions
        WHERE created_at >= ?
        GROUP BY agent, COALESCE(verbosity, '')`,
    )
    .all<{ agent: string; verbosity: string; n: number }>(since);

  const sessions = { normal: 0, terse: 0, unstamped: 0 };
  const perAgent = new Map<string, { normal: number; terse: number }>();
  for (const r of rows) {
    const level = r.verbosity === 'terse' ? 'terse' : r.verbosity === 'normal' ? 'normal' : 'unstamped';
    sessions[level] += r.n;
    if (level === 'unstamped') continue; // an unattributable row says nothing about adoption
    const bucket = perAgent.get(r.agent) ?? { normal: 0, terse: 0 };
    bucket[level] += r.n;
    perAgent.set(r.agent, bucket);
  }

  const byAgent = [...perAgent.entries()]
    .map(([agent, b]) => ({ agent, ...b }))
    .sort((a, b) => b.terse - a.terse || b.normal - a.normal || a.agent.localeCompare(b.agent));

  return { windowDays, sessions, byAgent };
}
