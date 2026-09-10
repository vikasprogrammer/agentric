/**
 * The performance review — the deterministic half of "is this goal working?".
 *
 * `sweepStuckGoals` already asks whether a goal has been ACTIVE lately, and that is the wrong question:
 * a goal can be busy and failing, or quiet and succeeding. This pass asks whether its NUMBER moved
 * ({@link GoalStore.metricStatus}) and raises one inbox card per goal when the answer is actionable.
 *
 * Three deliberate constraints, all learned from surfaces that turned into noise:
 *
 *   - **It spawns nothing.** A review that costs a session every tick would bill a tenant for the
 *     privilege of being told nothing changed. The judgement here is arithmetic; the RESPONSE (re-plan,
 *     retire, adjust the target) is the human's, and reaches an agent through the existing Plan button.
 *   - **One card per goal, superseded, and only on a CHANGE of verdict.** A goal that has been flat for
 *     a month is one standing card, not thirty. The guard is the `goal.reviewed` audit event, so a
 *     restart never re-alarms and the history of a goal's verdicts is queryable after the fact.
 *   - **It never claims a goal is failing on thin evidence.** Every "not working" verdict needs a
 *     sample and a time span (see MIN_READINGS / FLAT_BAND in the store); "nobody is measuring this"
 *     is reported as its own finding rather than dressed up as failure.
 */
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { Goal, GoalMetricStatus } from '../types';

/** Verdicts worth a human's attention. `measuring` and `new` are the quiet, healthy states. */
const ACTIONABLE = new Set<GoalMetricStatus['verdict']>(['flat', 'regressing', 'unmeasured', 'achieved']);

function fmt(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
}

/** The card's headline + body for one verdict. Written as what the reader should DO, not as a status. */
function compose(goal: Goal, st: GoalMetricStatus): { title: string; body: string } {
  const m = st.metric;
  const unit = m.unit ? ` ${m.unit}` : '';
  const now = st.latest ? `${fmt(st.latest.value)}${unit}` : '—';
  const target = m.target !== undefined ? `${fmt(m.target)}${unit}` : 'no target set';
  const since = st.moved !== undefined ? `${st.moved >= 0 ? '+' : ''}${fmt(st.moved)}${unit} since the first reading` : 'no movement to compare';

  switch (st.verdict) {
    case 'unmeasured':
      return {
        title: `Nobody is measuring "${goal.title}"`,
        body: st.latest
          ? `${m.name} was last measured ${st.staleDays} days ago at ${now}; a reading was due every ${m.everyDays}.\n\n`
            + `Until it is measured again, nothing can say whether the work under this goal is working. Take a reading, or have an agent post one with \`goal_measure\`.`
          : `This goal has a metric (${m.name}) but no reading has ever been taken, and one was due ${m.everyDays} days after it was set.\n\n`
            + `A goal with an unmeasured metric is judged on activity alone — which is what having a metric was meant to fix.`,
      };
    case 'flat':
      return {
        title: `"${goal.title}" is not moving`,
        body: `${m.name} is ${now} against a target of ${target} — ${since}, across ${st.readings} readings.\n\n`
          + `The work is running; the number is not responding. Worth deciding between a different approach, a different target, or retiring the goal — rather than continuing to pay for the current one.`,
      };
    case 'regressing':
      return {
        title: `"${goal.title}" is going the wrong way`,
        body: `${m.name} is ${now}, ${since}, against a target of ${target}.\n\n`
          + `This is the case for looking before the next cycle of work is filed.`,
      };
    case 'achieved':
      return {
        title: `"${goal.title}" hit its target`,
        body: `${m.name} reached ${now} against a target of ${target}.\n\n`
          + `Close the goal, or raise the target — and consider whether the automations feeding it should keep running.`,
      };
    default:
      return { title: goal.title, body: '' };
  }
}

/** The verdict this goal was last carded with, from the audit trail (the once-guard). */
function lastVerdict(os: AgentOS, goalId: string): string | undefined {
  const row = os.db
    .prepare("SELECT data FROM audit_events WHERE tenant = ? AND type = 'goal.reviewed' AND data LIKE ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get<{ data: string }>(os.tenant, `%"goalId":"${goalId}"%`);
  if (!row) return undefined;
  try { return String((JSON.parse(row.data) as { verdict?: unknown }).verdict ?? ''); } catch { return undefined; }
}

export interface ReviewOutcome {
  goalId: string;
  title: string;
  verdict: GoalMetricStatus['verdict'];
  carded: boolean;
}

/**
 * Review every active goal that has a metric. Returns what each one's verdict was and whether this run
 * raised a card for it — the shape a console "review now" route and the test both read.
 */
export function reviewGoals(os: AgentOS, tm: TerminalManager, now = Date.now()): ReviewOutcome[] {
  const out: ReviewOutcome[] = [];
  for (const goal of os.goals.measured(os.tenant)) {
    let st: GoalMetricStatus | undefined;
    try { st = os.goals.metricStatus(goal.id, now); } catch { continue; }
    if (!st) continue;
    const verdict = st.verdict;
    let carded = false;
    // Re-card only when the verdict CHANGES. A goal that recovers and lapses again is worth saying twice;
    // a goal that has been flat since last month is not.
    if (ACTIONABLE.has(verdict) && lastVerdict(os, goal.id) !== verdict) {
      try {
        const { title, body } = compose(goal, st);
        const id = tm.postSystemCard({
          topic: `goal-review-${goal.id}`,
          type: 'notification',
          title,
          body,
          // The person accountable for the goal, falling back to the admins when nobody owns it — an
          // unowned failing goal is precisely the one that needs someone told.
          audience: goal.owner ? { kind: 'member', id: goal.owner } : { kind: 'admins' },
          args: { goalId: goal.id, verdict, value: st.latest?.value, readings: st.readings },
          link: { page: 'goals', detail: goal.id, label: 'Goals' },
        });
        tm.closeSystemCards(`goal-review-${goal.id}`, 'cancelled', id);
        carded = true;
      } catch { /* a card is a convenience; the audit row below is the record */ }
      os.audit.append({
        ts: now, runId: '-', tenant: os.tenant, principal: 'system', type: 'goal.reviewed',
        data: { goalId: goal.id, title: goal.title, verdict, value: st.latest?.value ?? null, readings: st.readings, moved: st.moved ?? null },
      });
    }
    out.push({ goalId: goal.id, title: goal.title, verdict, carded });
  }
  return out;
}
