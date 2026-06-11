/**
 * Evaluation — did the action actually WORK? The outcome signal that feeds learning.
 * Distinct from Monitoring (is it alive?). This reads the authoritative audit stream
 * plus the run's self-reported outcome and produces a signal Dreaming can learn from.
 *
 * Today's seed in the existing orchestrator: agents emit `[OUTCOME:success|failure]`.
 * Here we corroborate that against what the audit log shows actually happened.
 */
import { AuditEvent, Run } from '../types';

export interface EvalSignal {
  runId: string;
  reportedOutcome: string;
  effectsAttempted: number;
  effectsSucceeded: number;
  approvalsRejected: number;
  budgetStops: number;
  /** Cheap corroboration: did the run claim success while effects failed/were blocked? */
  suspicious: boolean;
}

export function evaluate(run: Run, events: AuditEvent[]): EvalSignal {
  const attempts = events.filter((e) => e.type === 'action.attempt').length;
  const results = events.filter((e) => e.type === 'action.result' && e.data.ok === true).length;
  const dedups = events.filter((e) => e.type === 'idempotency.hit').length; // a dedup is a success, not a miss
  const succeeded = results + dedups;
  const approvalsRejected = events.filter((e) => e.type === 'approval.resolved' && e.data.approved === false).length;
  const budgetStops = events.filter((e) => e.type === 'budget.exceeded').length;
  const suspicious = run.outcome === 'success' && (approvalsRejected > 0 || budgetStops > 0 || succeeded < attempts);

  return {
    runId: run.id,
    reportedOutcome: run.outcome,
    effectsAttempted: attempts,
    effectsSucceeded: succeeded,
    approvalsRejected,
    budgetStops,
    suspicious,
  };
}
