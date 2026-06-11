/**
 * Budget — per-run cost accounting with HARD stops. Non-negotiable for always-on.
 * The gateway checks before an effect and debits the actual after.
 */
import { BudgetLedger, Cost, Run } from '../types';

export class InMemoryBudgetLedger implements BudgetLedger {
  check(run: Run, cost: Cost): { ok: boolean; reason?: string } {
    const { usdCap, tokenCap } = run.budget;
    if (usdCap !== null && run.cost.usd + cost.usd > usdCap) {
      return { ok: false, reason: `usd cap ${usdCap} would be exceeded (spent ${run.cost.usd.toFixed(4)}, +${cost.usd})` };
    }
    if (tokenCap !== null && run.cost.tokens + cost.tokens > tokenCap) {
      return { ok: false, reason: `token cap ${tokenCap} would be exceeded (spent ${run.cost.tokens}, +${cost.tokens})` };
    }
    return { ok: true };
  }

  debit(run: Run, cost: Cost): void {
    run.cost.usd = +(run.cost.usd + cost.usd).toFixed(6);
    run.cost.tokens += cost.tokens;
    run.updatedAt = Date.now();
  }
}
