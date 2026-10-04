/**
 * The bet review — closing the loop a bet opened.
 *
 * `goal-review.ts` asks whether a goal's number moved; this asks whether one ATTEMPT at it worked, which
 * is the question an autonomous loop needs answered to choose what to do next. It runs off the same
 * scheduler tick, is spawn-free, and keeps the same division of labour as every other review surface
 * here: the arithmetic is the server's, the response is a human's (or the agent's, in words).
 *
 * Three constraints, all learned:
 *
 *   - **The verdict is computed, never reported.** `BetStore.judge` reads the bet's own assets. An agent
 *     grading its own experiment is the Insights failure again (self-graded outcomes drove ~zero action),
 *     so the agent cannot write `observedLift`/`verdict` at all — only the `lesson` and the final state.
 *   - **It never auto-kills.** The sweep moves a due bet to `judging` and raises ONE card. Retiring work
 *     is a judgement with context the arithmetic does not have (a page may be right but early), and an
 *     agent that is still running gets told through the wake queue so it can close its own loop.
 *   - **One card per bet, ever.** The guard is the `bet.judged` audit event, so a restart cannot re-alarm
 *     and the history of what each bet was judged on stays queryable.
 */
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { BetJudgement } from '../state/bets';

/** What the judging sweep did, for the tick's audit and the test. */
export interface BetReviewOutcome {
  betId: string;
  verdict: BetJudgement['verdict'];
  carded: boolean;
  /** The whole judgement, so the caller (the scheduler sweep) can tell the agent that ran the bet —
   *  delivery is the wake queue's job and lives with the thing that owns it, not here. */
  judgement: BetJudgement;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** The card's title + body. Written as the decision the reader now owns, not as a status. */
function compose(os: AgentOS, j: BetJudgement): { title: string; body: string } {
  const goal = os.goals.get(j.bet.goalId);
  const unit = goal?.metric?.unit ? ` ${goal.metric.unit}` : '';
  const head = {
    met: `Bet worked: "${j.bet.title}"`,
    short: `Bet fell short: "${j.bet.title}"`,
    no_signal: `Bet untested: "${j.bet.title}"`,
  }[j.verdict];
  const action = {
    met: `Keep it, and decide whether to expand the same lever. ${j.bet.lesson ? '' : 'Write down why it worked — that is what the next bet is chosen from.'}`,
    short: `The honest options are kill it or give it a stated reason to continue. "Leave it running and see" is how a loop fills every slot with bets nobody judges.`,
    no_signal: `Nothing was learned, so there is nothing to keep or kill on the merits: fix what stopped it being measured (indexing, a missing measurement) or retire it.`,
  }[j.verdict];
  return {
    title: head,
    body: `${j.bet.hypothesis ? `**Hypothesis:** ${j.bet.hypothesis}\n\n` : ''}`
      + `**Measured:** ${j.observedLift >= 0 ? '+' : ''}${fmt(j.observedLift)}${unit} across ${j.measured} of ${j.assets} assets`
      + `${j.expected !== undefined ? `, against ${fmt(j.expected)}${unit} expected` : ''}. Window: ${j.bet.windowDays} days.\n\n`
      + `${j.note}\n\n${action}`,
  };
}

/** Has this bet already been carded? The once-guard, read off the audit trail. */
function alreadyJudged(os: AgentOS, betId: string): boolean {
  const row = os.db
    .prepare("SELECT 1 AS hit FROM audit_events WHERE tenant = ? AND type = 'bet.judged' AND data LIKE ? LIMIT 1")
    .get<{ hit: number }>(os.tenant, `%"betId":"${betId}"%`);
  return !!row;
}

/**
 * Judge every bet whose window has closed. Returns one outcome per bet the sweep touched — the shape a
 * console "judge now" route and the test both read.
 */
export function reviewBets(os: AgentOS, tm: TerminalManager, now = Date.now()): BetReviewOutcome[] {
  const out: BetReviewOutcome[] = [];
  for (const due of os.bets.due(os.tenant, now)) {
    if (alreadyJudged(os, due.id)) continue;
    let j: BetJudgement | undefined;
    try { j = os.bets.judge(due.id, now); } catch { continue; }
    if (!j) continue;
    const goal = os.goals.get(j.bet.goalId);
    let carded = false;
    try {
      const { title, body } = compose(os, j);
      const id = tm.postSystemCard({
        topic: `bet-${j.bet.id}`,
        type: 'notification',
        title,
        body,
        // The goal's owner decides what happens to a bet against their number; an unowned goal falls to
        // the admins, same as the goal review.
        audience: goal?.owner ? { kind: 'member', id: goal.owner } : { kind: 'admins' },
        args: { betId: j.bet.id, goalId: j.bet.goalId, verdict: j.verdict, observedLift: j.observedLift },
        link: { page: 'goals', detail: j.bet.goalId, label: 'Goals' },
      });
      tm.closeSystemCards(`bet-${j.bet.id}`, 'cancelled', id);
      carded = true;
    } catch { /* the card is a convenience; the audit row below is the record */ }
    os.audit.append({
      ts: now, runId: '-', tenant: os.tenant, principal: 'system', type: 'bet.judged',
      data: {
        betId: j.bet.id, goalId: j.bet.goalId, title: j.bet.title, verdict: j.verdict,
        observedLift: j.observedLift, expected: j.expected ?? null, baseline: j.baseline,
        measured: j.measured, assets: j.assets, windowDays: j.bet.windowDays,
      },
    });
    // The agent that ran the bet closes its own loop — it writes the lesson and picks kept/killed. The
    // caller wakes it (see Automations.sweepBets); doing it here would put wake-queue knowledge in a
    // review that is otherwise pure arithmetic.
    out.push({ betId: j.bet.id, verdict: j.verdict, carded, judgement: j });
  }
  return out;
}
