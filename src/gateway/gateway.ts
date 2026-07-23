/**
 * THE GATEWAY — the mediated effect boundary.
 *
 * Every side effect an agent has on the world passes through here. This single
 * chokepoint is what makes Policy, Budgets, Approvals, Identity, Idempotency and
 * Audit ENFORCEABLE rather than aspirational. Remove it and they all become docs.
 *
 * The 7 steps (in order):
 *   1. Policy.classify   → green | yellow | red | deny
 *   2. Approvals         → suspend the run for yellow/red until a human decides
 *   3. Budget            → hard-stop if the estimate would exceed the run's caps
 *   4. Identity          → assume the run's principal (least privilege)
 *   5. Idempotency       → dedupe a retried effect (exactly-once)
 *   6. Execute           → finally call the capability
 *   7. Audit             → record the result + actual cost
 *
 * Audit events are written at EVERY step, not just the end.
 */
import {
  Act,
  ActionAttempt,
  AuditEvent,
  Approvals,
  BudgetLedger,
  CapabilityResult,
  Cost,
  Identity,
  IdempotencyStore,
  PolicyEngine,
  RunContext,
} from '../types';
import { CapabilityRegistry } from '../capabilities/registry';
import { stableHash } from './idempotency';
import { enrichArgs } from '../governance/enricher';
import { briefFor } from '../governance/briefer';

export interface GatewayDeps {
  registry: CapabilityRegistry;
  policy: PolicyEngine;
  budget: BudgetLedger;
  approvals: Approvals;
  identity: Identity;
  idempotency: IdempotencyStore;
  /** Workspace emergency stop. When it returns true, every effect is denied before policy runs. */
  killSwitch?: () => boolean;
}

export class Gateway {
  constructor(private readonly deps: GatewayDeps) {}

  /** Bind the gateway to a single run's context, yielding the `act` an agent runtime uses. */
  actorFor(ctx: RunContext): Act {
    return (attempt: ActionAttempt) => this.invoke(attempt, ctx);
  }

  async invoke(attempt: ActionAttempt, ctx: RunContext): Promise<CapabilityResult> {
    const { run } = ctx;
    const emit = (type: string, data: Record<string, unknown>) =>
      ctx.audit.append(this.event(ctx, type, data));

    const cap = this.deps.registry.get(attempt.capabilityId);
    emit('action.attempt', { capability: attempt.capabilityId, args: attempt.args, reasoning: attempt.reasoning });

    // 0. KILL SWITCH — workspace emergency stop. Denies every effect before ANY other step (even an
    // unknown capability), so engaging it is an absolute, fleet-wide freeze.
    if (this.deps.killSwitch?.()) {
      emit('gate.killswitch', { capability: attempt.capabilityId });
      return { ok: false, error: 'denied: workspace emergency stop is engaged' };
    }

    if (!cap) {
      emit('action.error', { capability: attempt.capabilityId, error: 'unknown capability' });
      return { ok: false, error: `unknown capability: ${attempt.capabilityId}` };
    }

    // 1. POLICY — classify over ENRICHED facts (destructive/risky/amountUsd/deleteCount), the same
    // classifier the live gate-hook path uses, so there is one decision brain everywhere. Enrichment
    // feeds the decision only; execution, idempotency and audit below use the original attempt.args.
    const enriched = enrichArgs(attempt.capabilityId, attempt.args);
    const decision = this.deps.policy.classify({ ...attempt, args: enriched }, ctx);
    // One human-legible brief for this effect, on the audit row — same briefer the live gate uses.
    const brief = briefFor(attempt.capabilityId, enriched, decision);
    emit('policy.decision', { capability: cap.id, decision, brief, policy: this.deps.policy.id });
    if (decision.effect === 'deny') {
      return { ok: false, error: `denied by policy: ${decision.reason}` };
    }

    // 2. APPROVALS (yellow/red) — suspend the run until a human decides
    if (decision.effect === 'approve') {
      const { req, decision: settle } = this.deps.approvals.request({
        runId: run.id,
        tenant: run.tenant,
        level: decision.level,
        attempt,
        reason: decision.reason,
      });
      emit('approval.requested', { approvalId: req.id, level: decision.level, reason: decision.reason });
      run.status = 'waiting_approval';
      const approved = await settle;
      run.status = 'running';
      emit('approval.resolved', { approvalId: req.id, approved, by: req.resolvedBy });
      if (!approved) return { ok: false, error: `approval rejected (${decision.level})` };
    }

    // 3. BUDGET — hard stop on the estimate
    const estimate: Cost = { usd: 0, tokens: 0, ...(cap.estimateCost?.(attempt.args) ?? {}) };
    const check = this.deps.budget.check(run, estimate);
    if (!check.ok) {
      emit('budget.exceeded', { capability: cap.id, estimate, reason: check.reason });
      return { ok: false, error: `budget hard-stop: ${check.reason}` };
    }

    // 4. IDENTITY — act as the run's principal
    await this.deps.identity.assume(run.principal, run.tenant);

    // 5. IDEMPOTENCY — dedupe retried effects (exactly-once)
    const idemKey = `${run.trigger.idempotencyKey ?? run.id}:${cap.id}:${stableHash(attempt.args)}`;
    if (this.deps.idempotency.seen(idemKey)) {
      const cached = this.deps.idempotency.get(idemKey)!;
      emit('idempotency.hit', { capability: cap.id, key: idemKey });
      return cached;
    }

    // 6. EXECUTE
    let result: CapabilityResult;
    try {
      result = await cap.invoke(attempt.args, ctx);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      emit('action.error', { capability: cap.id, error });
      return { ok: false, error };
    }

    // debit ACTUAL cost (fall back to estimate)
    const actual: Cost = { usd: result.cost?.usd ?? estimate.usd, tokens: result.cost?.tokens ?? estimate.tokens };
    this.deps.budget.debit(run, actual);
    this.deps.idempotency.remember(idemKey, result);

    // 7. AUDIT result
    emit('action.result', { capability: cap.id, ok: result.ok, cost: actual, error: result.error });
    return result;
  }

  private event(ctx: RunContext, type: string, data: Record<string, unknown>): AuditEvent {
    return { ts: Date.now(), runId: ctx.run.id, tenant: ctx.run.tenant, principal: ctx.run.principal, type, data };
  }
}
