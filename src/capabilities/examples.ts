/**
 * Example capabilities — stand-ins so the demo runs with zero external dependencies.
 * In a real deployment these are brand-private plugins (Slack, Stripe, your DB…),
 * each just an object implementing `Capability`.
 *
 * Note: the `defaultRisk` here is only a hint; the POLICY file is authoritative and
 * can override per-context (e.g. refund > $1000 → red).
 */
import { Capability } from '../types';

export const echoCapability: Capability = {
  id: 'echo.run',
  description: 'Print a message. Harmless — always green.',
  defaultRisk: 'green',
  async invoke(args, ctx) {
    const message = String(args.message ?? '');
    ctx.log(`echo: ${message}`);
    return { ok: true, data: { message }, cost: { usd: 0, tokens: 0 } };
  },
};

export const slackPostCapability: Capability = {
  id: 'slack.post',
  description: 'Post a message to a Slack channel (mock).',
  defaultRisk: 'green',
  estimateCost: () => ({ usd: 0, tokens: 0 }),
  async invoke(args, ctx) {
    const channel = String(args.channel ?? '#general');
    const text = String(args.text ?? '');
    ctx.log(`slack → ${channel}: ${text}`);
    return { ok: true, data: { channel, ts: '1700000000.000100' } };
  },
};

export const stripeRefundCapability: Capability = {
  id: 'stripe.refund',
  description: 'Refund a customer (mock). Risk escalates with amount via policy.',
  defaultRisk: 'yellow',
  estimateCost: () => ({ usd: 0.01, tokens: 0 }), // an API call costs a little
  async invoke(args, ctx) {
    const amountUsd = Number(args.amountUsd ?? 0);
    const customer = String(args.customer ?? 'unknown');
    ctx.log(`stripe.refund: $${amountUsd} → ${customer}`);
    return { ok: true, data: { refundId: 're_mock_123', amountUsd, customer } };
  },
};

export const prodRestartCapability: Capability = {
  id: 'prod.restart',
  description: 'Restart a production service (mock). Denied outright by the default policy.',
  defaultRisk: 'deny',
  async invoke(args, ctx) {
    // Never reached under the default policy — the gateway blocks it at the policy step.
    ctx.log(`prod.restart ${args.service}`);
    return { ok: true, data: { restarted: args.service } };
  },
};

/** A green capability that costs money — used to demonstrate the budget hard-stop. */
export const paidActionCapability: Capability = {
  id: 'paid.action',
  description: 'A benign action that costs $0.01 each call. Demonstrates budget caps.',
  defaultRisk: 'green',
  estimateCost: () => ({ usd: 0.01, tokens: 1000 }),
  async invoke(args, ctx) {
    ctx.log(`paid.action #${args.n ?? '?'}`);
    return { ok: true, data: { n: args.n }, cost: { usd: 0.01, tokens: 1000 } };
  },
};

export const exampleCapabilities: Capability[] = [
  echoCapability,
  slackPostCapability,
  stripeRefundCapability,
  prodRestartCapability,
  paidActionCapability,
];
