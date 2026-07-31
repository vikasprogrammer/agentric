#!/usr/bin/env node
/**
 * Tier-A policy-engine test — set membership (`in`/`nin`) + cross-arg compare (`argRef`).
 *
 * Runs the BUILT gate (dist/), like governance-conformance. Covers three things:
 *   1. runtime semantics — evalWhen via classify for in/nin and argRef.
 *   2. validation — the two new `when` shapes accept the valid forms and reject the malformed ones.
 *   3. the monotonicity SWEEP reaches the new-op decision boundaries — the soundness linchpin. If
 *      sampleArgDomains failed to emit enum members / pair argRef args, describeProposal would report
 *      "no effective change" for a real tightening, and applyProposal could mis-sweep. We assert the
 *      sweep both SEES a genuine new-op tightening and does NOT spuriously reject it as a loosening.
 *
 *   npm run build && node scripts/tier-a-policy-test.cjs
 */
const path = require('path');
const { JsonPolicyEngine, validatePolicyDocument, applyProposal, describeProposal } =
  require(path.resolve(__dirname, '..', 'dist/governance/policy'));

const ctx = { run: { id: 'r', tenant: 't', principal: 'a' } };
let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

// A Decision → compact tag.
const tag = (d) => (d.effect === 'allow' ? 'allow' : d.effect === 'deny' ? 'never' : `ask:${d.level}`);
const classify = (doc, cap, args) => {
  const e = new JsonPolicyEngine(doc);
  e.setThresholds(() => ({}));
  return tag(e.classify({ capabilityId: cap, args, reasoning: '' }, ctx));
};

// ── 1. runtime semantics ───────────────────────────────────────────────────────────────────────
const runtimeDoc = {
  id: 'tierA-runtime',
  default: { action: 'allow' },
  rules: [
    { match: { capability: 'order.setStatus', when: { arg: 'status', op: 'nin', value: ['paid', 'shipped', 'refunded'] } }, action: 'never' },
    { match: { capability: 'payout.send', when: { arg: 'payee', op: 'ne', argRef: 'buyer' } }, action: 'ask', approver: 'owner' },
    { match: { capability: 'refund.issue', when: { arg: 'amount', op: 'gt', argRef: 'orig' } }, action: 'ask', approver: 'admin' },
  ],
};
// set membership
check('nin: valid enum → allow', classify(runtimeDoc, 'order.setStatus', { status: 'paid' }) === 'allow');
check('nin: invalid enum → never', classify(runtimeDoc, 'order.setStatus', { status: 'probably shipped' }) === 'never');
check('nin: missing arg → never (fail-closed for a never guard)', classify(runtimeDoc, 'order.setStatus', {}) === 'never');
// cross-arg equality
check('argRef ne: payee == buyer → allow', classify(runtimeDoc, 'payout.send', { payee: 'A', buyer: 'A' }) === 'allow');
check('argRef ne: payee != buyer → ask:owner', classify(runtimeDoc, 'payout.send', { payee: 'A', buyer: 'B' }) === 'ask:owner');
check('argRef ne: missing referenced arg → allow (rule fails closed = does not fire)', classify(runtimeDoc, 'payout.send', { payee: 'A' }) === 'allow');
// cross-arg numeric ordering (approver `admin` maps to the internal level `head`, per toLevel)
check('argRef gt: amount > orig → ask:head', classify(runtimeDoc, 'refund.issue', { amount: 100, orig: 50 }) === 'ask:head');
check('argRef gt: amount <= orig → allow', classify(runtimeDoc, 'refund.issue', { amount: 50, orig: 100 }) === 'allow');

// ── 2. validation ──────────────────────────────────────────────────────────────────────────────
check('validate: valid tierA doc', validatePolicyDocument(runtimeDoc) === null);
check('validate: in with argRef is rejected', !!validatePolicyDocument({
  id: 'x', default: { action: 'allow' },
  rules: [{ match: { capability: 'c', when: { arg: 'a', op: 'in', argRef: 'b' } }, action: 'never' }],
}));
check('validate: in with non-array value is rejected', !!validatePolicyDocument({
  id: 'x', default: { action: 'allow' },
  rules: [{ match: { capability: 'c', when: { arg: 'a', op: 'in', value: 'paid' } }, action: 'never' }],
}));
check('validate: in with empty array is rejected', !!validatePolicyDocument({
  id: 'x', default: { action: 'allow' },
  rules: [{ match: { capability: 'c', when: { arg: 'a', op: 'in', value: [] } }, action: 'never' }],
}));
check('validate: argRef + value together is rejected', !!validatePolicyDocument({
  id: 'x', default: { action: 'allow' },
  rules: [{ match: { capability: 'c', when: { arg: 'a', op: 'ne', value: 1, argRef: 'b' } }, action: 'never' }],
}));

// ── 3. the sweep reaches the new-op boundaries (soundness linchpin) ───────────────────────────────
// A doc that allows the capability unconditionally; propose ADDing a new-op guardrail (a strict tighten).
// describeProposal must SEE the tightening (not "no effective change"), and applyProposal must ACCEPT it
// (not falsely flag a loosening). Both fail loudly if sampleArgDomains doesn't emit the new-op values.
const allowPayout = { id: 't', default: { action: 'allow' }, rules: [{ match: { capability: 'payout.send' }, action: 'allow' }] };
const argRefDelta = { kind: 'add', match: { capability: 'payout.send', when: { arg: 'payee', op: 'ne', argRef: 'buyer' } }, outcome: { action: 'ask', approver: 'owner' } };
const argRefDesc = describeProposal(allowPayout, argRefDelta, {});
check('sweep sees argRef tightening (not "no effective change")',
  'preview' in argRefDesc && /payout\.send/.test(argRefDesc.preview) && /ask owner/.test(argRefDesc.preview));
check('sweep accepts argRef tightening (no false loosening)', 'doc' in applyProposal(allowPayout, argRefDelta, {}));

const allowStatus = { id: 't', default: { action: 'allow' }, rules: [{ match: { capability: 'order.setStatus' }, action: 'allow' }] };
const ninDelta = { kind: 'add', match: { capability: 'order.setStatus', when: { arg: 'status', op: 'nin', value: ['paid', 'shipped'] } }, outcome: { action: 'never' } };
const ninDesc = describeProposal(allowStatus, ninDelta, {});
check('sweep sees nin tightening (not "no effective change")',
  'preview' in ninDesc && /order\.setStatus/.test(ninDesc.preview) && /never/.test(ninDesc.preview));
check('sweep accepts nin tightening (no false loosening)', 'doc' in applyProposal(allowStatus, ninDelta, {}));

// A proposal cannot ADD an allow (loosening) — still refused with a new-op when clause.
check('add allow with in-clause is refused (tighten-only)',
  'error' in applyProposal(allowStatus, { kind: 'add', match: { capability: 'order.setStatus', when: { arg: 'status', op: 'in', value: ['x'] } }, outcome: { action: 'allow' } }, {}));

const total = pass + failures.length;
if (failures.length) {
  console.error(`\nTIER-A POLICY: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`TIER-A POLICY: ${pass}/${total} passed ✓`);
