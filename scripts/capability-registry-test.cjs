#!/usr/bin/env node
/**
 * Capability-registry test (§4.2) — normalization of a raw tool name to a canonical, provider-
 * independent capability, and the moat proof: ONE policy rule governs the same action across surfaces.
 *
 * Runs the BUILT dist/, like governance-conformance.
 *
 *   npm run build && node scripts/capability-registry-test.cjs
 */
const path = require('path');
const { resolveCapability, capabilityDescriptor, knownCapabilities } =
  require(path.resolve(__dirname, '..', 'dist/capabilities/normalize'));
const { JsonPolicyEngine } = require(path.resolve(__dirname, '..', 'dist/governance/policy'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };
const R = (cap, tool) => resolveCapability(cap, tool);

// ── 1. normalization: a generic connector.call → canonical capability by tool name ───────────────
check('STRIPE_REFUND → payments.refund', R('connector.call', 'mcp__composio-company__STRIPE_REFUND') === 'payments.refund');
check('payout → payments.payout', R('connector.call', 'mcp__stripe__STRIPE_CREATE_PAYOUT') === 'payments.payout');
check('charge → payments.charge', R('connector.call', 'mcp__stripe__create_payment_intent') === 'payments.charge');
check('create_pull_request → repo.pr.create', R('connector.call', 'mcp__github__create_pull_request') === 'repo.pr.create');
check('create_issue → repo.issue.create', R('connector.call', 'mcp__github__create_issue') === 'repo.issue.create');
check('slack post → messaging.post', R('connector.call', 'mcp__slack__chat_postMessage') === 'messaging.post');

// ── 2. safety: only a generic connector.call is ever reinterpreted; unmapped falls through ───────
check('shell.exec is never reinterpreted (Bash echoing "refund")', R('shell.exec', 'Bash') === 'shell.exec');
check('a shell.exec whose tool literally contains refund stays shell.exec', R('shell.exec', 'refund_helper.sh') === 'shell.exec');
check('email.send is left as-is', R('email.send', 'mcp__composio__GMAIL_SEND_EMAIL') === 'email.send');
check('unmapped connector tool falls through unchanged', R('connector.call', 'mcp__notion__query_database') === 'connector.call');
check('no tool name → unchanged', R('connector.call', undefined) === 'connector.call');
check('already-canonical id is untouched', R('payments.refund', 'mcp__x__whatever') === 'payments.refund');

// ── 3. descriptors / catalog ─────────────────────────────────────────────────────────────────────
check('payments.refund descriptor is high-risk financial', (() => {
  const d = capabilityDescriptor('payments.refund');
  return d && d.risk === 'high' && d.effects.includes('financial');
})());
check('unknown id has no descriptor', capabilityDescriptor('nope.nope') === undefined);
check('catalog lists the seeded capabilities', knownCapabilities().length >= 7);

// ── 4. the moat: ONE rule governs the same action across Composio / REST / SDK surfaces ──────────
const ctx = { run: { id: 'r', tenant: 't', principal: 'a' } };
const tag = (d) => (d.effect === 'allow' ? 'allow' : d.effect === 'deny' ? 'never' : `ask:${d.level}`);
const policy = { id: 'moat', default: { action: 'allow' }, rules: [{ match: { capability: 'payments.refund' }, action: 'ask', approver: 'owner' }] };
const engine = new JsonPolicyEngine(policy); engine.setThresholds(() => ({}));
const surfaces = [
  'mcp__composio-company__STRIPE_REFUND', // Composio slug
  'mcp__stripe__refund_payment',          // a REST-shaped connector tool
  'stripe.Refund.create',                 // an SDK-shaped tool name
];
const decisions = surfaces.map((tool) => {
  const cap = R('connector.call', tool);
  return { tool, cap, tag: tag(engine.classify({ capabilityId: cap, args: {}, reasoning: '' }, ctx)) };
});
check('all three surfaces normalize to payments.refund', decisions.every((d) => d.cap === 'payments.refund'));
check('one payments.refund rule governs all three identically (ask:owner)', decisions.every((d) => d.tag === 'ask:owner'));
// And the control: WITHOUT normalization the same rule would NOT match a raw connector.call.
check('a raw connector.call is NOT caught by the payments.refund rule (normalization is what enables it)',
  tag(engine.classify({ capabilityId: 'connector.call', args: {}, reasoning: '' }, ctx)) === 'allow');

const total = pass + failures.length;
if (failures.length) {
  console.error(`\nCAPABILITY REGISTRY: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`CAPABILITY REGISTRY: ${pass}/${total} passed ✓`);
