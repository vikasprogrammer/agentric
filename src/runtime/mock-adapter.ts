/**
 * Mock runtime — a deterministic stand-in for a real agent so the OS can be demoed
 * end-to-end with no model calls. A "behavior" is just code that requests side effects
 * through `act` (which is the gateway, bound to this run). Everything it does is
 * therefore policed, budgeted, approved and audited exactly like a real agent.
 */
import { Act, AgentManifest, Outcome, Run, RunContext, RuntimeAdapter } from '../types';

export type MockBehavior = (ctx: RunContext, act: Act, run: Run) => Promise<{ outcome: Outcome; result?: unknown }>;

export class MockAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  private behaviors = new Map<string, MockBehavior>();

  register(agentId: string, behavior: MockBehavior): this {
    this.behaviors.set(agentId, behavior);
    return this;
  }

  async run(run: Run, ctx: RunContext, act: Act, manifest: AgentManifest) {
    const behavior = this.behaviors.get(manifest.id);
    if (!behavior) return { outcome: 'failure' as Outcome, result: `no mock behavior registered for ${manifest.id}` };
    return behavior(ctx, act, run);
  }
}

// ── Example agent behaviors ──────────────────────────────────────────────────

/** All-green happy path. Posts the same Slack message twice to show idempotency. */
export const greeterBehavior: MockBehavior = async (ctx, act) => {
  const name = String(ctx.run.inputs.name ?? 'world');
  await act({ capabilityId: 'echo.run', args: { message: `Hello, ${name}!` }, reasoning: 'greet the user' });

  const post = { capabilityId: 'slack.post', args: { channel: '#general', text: `:wave: Hello, ${name}!` } };
  await act({ ...post, reasoning: 'announce greeting' });
  await act({ ...post, reasoning: 'retry — should be deduped, effect fires once' });

  return { outcome: 'success' };
};

/** Refunds: a small one (yellow → head approves) and a large one (red → owner decides). */
export const refunderBehavior: MockBehavior = async (ctx, act) => {
  const customer = String(ctx.run.inputs.customer ?? 'cus_demo');

  const small = await act({
    capabilityId: 'stripe.refund',
    args: { customer, amountUsd: 49 },
    reasoning: 'duplicate charge, small amount',
  });

  const large = await act({
    capabilityId: 'stripe.refund',
    args: { customer, amountUsd: 5000 },
    reasoning: 'goodwill refund, large amount',
  });

  const outcome: Outcome = small.ok && large.ok ? 'success' : 'failure';
  return { outcome, result: { small: small.ok, large: large.ok } };
};

/** Spends $0.01 per call until the run's budget hard-stops it. */
export const spenderBehavior: MockBehavior = async (_ctx, act) => {
  let done = 0;
  for (let n = 1; n <= 5; n++) {
    const r = await act({ capabilityId: 'paid.action', args: { n }, reasoning: `work item ${n}` });
    if (!r.ok) break; // budget hard-stop
    done++;
  }
  return { outcome: done > 0 ? 'success' : 'failure', result: { completed: done } };
};

/** Issues ONE refund for the amount you pass in — lets you watch policy route by amount
 *  (≤$1000 → yellow → head; >$1000 → red → owner). Used by the `refund-desk` agent. */
export const refundDeskBehavior: MockBehavior = async (ctx, act) => {
  const customer = String(ctx.run.inputs.customer ?? 'cus_demo');
  const amountUsd = Number(ctx.run.inputs.amountUsd ?? 0);
  const r = await act({
    capabilityId: 'stripe.refund',
    args: { customer, amountUsd },
    reasoning: 'refund requested via console',
  });
  return { outcome: r.ok ? 'success' : 'failure', result: r.ok ? r.data : r.error };
};

/** Tries to restart a production service (denied by policy), then a harmless echo. */
export const opsBehavior: MockBehavior = async (ctx, act) => {
  const service = String(ctx.run.inputs.service ?? 'api');
  const denied = await act({ capabilityId: 'prod.restart', args: { service }, reasoning: 'restart prod service' });
  await act({ capabilityId: 'echo.run', args: { message: `carrying on after ${denied.ok ? 'restart' : 'the denial'}` } });
  return { outcome: denied.ok ? 'success' : 'failure', result: { prodRestart: denied.ok } };
};
