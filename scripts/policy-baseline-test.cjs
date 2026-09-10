#!/usr/bin/env node
/**
 * Baseline-drift test — pins the mechanism that tells a tenant's OWN policy intent apart from stale
 * product text it merely inherited.
 *
 * Why: `<home>/policy/default.policy.json` is a full snapshot, so a tenant that has one stops tracking
 * the bundled default forever. The blunt `shell.exec`+`risky` → ask-owner rule was dropped from the
 * bundle in v0.17.0 and kept firing for over a year on three separate tenants, found each time only by
 * a human auditing the approvals table by hand. The fixtures below are the REAL fleet documents (tenant
 * names replaced with the repo's placeholders) — they are the actual shapes this has to classify.
 *
 * The load-bearing assertions are the NEGATIVE ones: a rule the owner authored, or edited, must never
 * be offered for removal. Dropping a retired rule LOOSENS governance, so a false positive here would
 * silently un-gate a live tenant.
 *
 *   npm run build && node scripts/policy-baseline-test.cjs
 */
const path = require('path');
const fs = require('fs');
const { baselineDrift, dropRetiredRules, RETIRED_RULES } =
  require(path.resolve(__dirname, '..', 'dist/governance/policy-baseline'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };

const BUNDLED = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config/policy/default.policy.json'), 'utf8'));

// The rule at the centre of all three incidents, exactly as it shipped.
const STALE = { match: { capability: 'shell.exec', when: { arg: 'risky', op: 'eq', value: true } }, action: 'ask', approver: 'owner' };

// ── 1. The ledger must not contradict the product ─────────────────────────────────────────────────
//     Declaring a rule retired while still shipping it would make every fresh tenant instantly "drifted".
for (const r of RETIRED_RULES) {
  check(`ledger entry (${r.rule.match.capability}, since v${r.since}) is NOT in the bundled default`,
    !BUNDLED.rules.some((b) => JSON.stringify(b) === JSON.stringify(r.rule)));
  check(`ledger entry (${r.rule.match.capability}) carries a reason`, typeof r.reason === 'string' && r.reason.length > 40);
}
check('the v0.17.0 shell.exec rule is declared', RETIRED_RULES.some((r) => JSON.stringify(r.rule) === JSON.stringify(STALE)));

// ── 2. A tenant tracking the bundle exactly has no drift ──────────────────────────────────────────
{
  const d = baselineDrift(JSON.parse(JSON.stringify(BUNDLED)), BUNDLED);
  check('bundled == bundled ⇒ clean', d.clean && !d.retired.length && !d.missing.length && !d.tenant.length);
}

// ── 3. instapods, as it actually was on 2026-09-07: baseline + the one stale rule at index 0 ──────
{
  const doc = { ...BUNDLED, rules: [STALE, ...BUNDLED.rules] };
  const d = baselineDrift(doc, BUNDLED);
  check('instapods shape: exactly one retired rule found', d.retired.length === 1);
  check('instapods shape: found at its real index (0)', d.retired[0].index === 0);
  check('instapods shape: carries the ledger receipt', d.retired[0].since === '0.17.0' && /false positives|MENTIONING/.test(d.retired[0].reason));
  check('instapods shape: nothing missing, nothing owner-authored', !d.missing.length && !d.tenant.length);
  check('instapods shape: not clean', !d.clean);

  const { doc: fixed, dropped } = dropRetiredRules(doc, [0], BUNDLED);
  check('drop removes exactly the stale rule', dropped.length === 1 && JSON.stringify(dropped[0]) === JSON.stringify(STALE));
  check('drop leaves the baseline intact', JSON.stringify(fixed.rules) === JSON.stringify(BUNDLED.rules));
  check('drop is idempotent (re-running finds nothing to drop)', dropRetiredRules(fixed, [0], BUNDLED).dropped.length === 0);
  check('drop never touches the default outcome', JSON.stringify(fixed.default) === JSON.stringify(BUNDLED.default));
}

// ── 4. initech's shape: the stale rule AND a genuine owner rule. Only the stale one is actionable ──
{
  const OWN = { match: { capability: 'customer.message' }, action: 'ask', approver: 'admin' };
  const doc = { ...BUNDLED, rules: [STALE, ...BUNDLED.rules.slice(0, 3), OWN, ...BUNDLED.rules.slice(3)] };
  const d = baselineDrift(doc, BUNDLED);
  check('initech shape: the owner rule is classified as tenant-authored', d.tenant.length === 1 && d.tenant[0].rule.match.capability === 'customer.message');
  check('initech shape: the owner rule is NOT offered for removal', !d.retired.some((r) => r.rule.match.capability === 'customer.message'));
  check('initech shape: the stale rule still is', d.retired.length === 1 && d.retired[0].rule.match.capability === 'shell.exec');

  // Asking to drop the owner's rule by index must be refused, not obeyed.
  const own = doc.rules.findIndex((r) => r.match.capability === 'customer.message');
  const { doc: after, dropped } = dropRetiredRules(doc, [own], BUNDLED);
  check('a non-retired index is IGNORED, not dropped', dropped.length === 0 && after.rules.length === doc.rules.length);
  const both = dropRetiredRules(doc, [0, own], BUNDLED);
  check('a mixed request drops only the retired one', both.dropped.length === 1 && both.doc.rules.some((r) => r.match.capability === 'customer.message'));
}

// ── 5. An EDITED copy of a retired rule is intent, not stale text — the safety property ───────────
{
  const variants = [
    ['approver retargeted', { ...STALE, approver: 'admin' }],
    ['action tightened', { ...STALE, action: 'never', approver: undefined }],
    ['condition narrowed', { ...STALE, match: { capability: 'shell.exec', when: { arg: 'destructive', op: 'eq', value: true } } }],
    ['capability narrowed', { ...STALE, match: { capability: 'ssh.exec', when: STALE.match.when } }],
  ];
  for (const [label, rule] of variants) {
    const d = baselineDrift({ ...BUNDLED, rules: [rule, ...BUNDLED.rules] }, BUNDLED);
    check(`edited retired rule (${label}) is tenant-authored, never retirable`,
      d.retired.length === 0 && d.tenant.length === 1);
  }
}

// ── 6. Key ORDER must not decide the verdict (documents are re-serialised by every save) ──────────
{
  const reordered = { approver: 'owner', action: 'ask', match: { when: { value: true, op: 'eq', arg: 'risky' }, capability: 'shell.exec' } };
  const d = baselineDrift({ ...BUNDLED, rules: [reordered, ...BUNDLED.rules] }, BUNDLED);
  check('a key-reordered retired rule still matches', d.retired.length === 1);
}

// ── 7. globex's shape: a wholly custom ruleset. Report, never accuse ──────────────────────────────
{
  const doc = { id: 'globex@v2', default: { action: 'allow' }, rules: [
    { match: { capability: '*', when: { arg: 'destructive', op: 'eq', value: true } }, action: 'never' },
    { match: { capability: 'shell.exec' }, action: 'allow' },
    { match: { capability: 'connector.connect' }, action: 'allow' },
  ] };
  const d = baselineDrift(doc, BUNDLED);
  check('globex shape: no retired rule (it never carried one)', d.retired.length === 0);
  check('globex shape: its own rules are reported as tenant-authored', d.tenant.length === 2);
  check('globex shape: absent baseline rules are reported as missing', d.missing.length >= 3);
  check('globex shape: missing is REPORT-only — drop can never add a rule',
    dropRetiredRules(doc, [0, 1, 2], BUNDLED).doc.rules.length <= doc.rules.length);
}

// ── 8. Removal can only ever shrink the document ──────────────────────────────────────────────────
{
  const doc = { ...BUNDLED, rules: [STALE, ...BUNDLED.rules] };
  for (const idx of [[], [-1], [99], [0, 0], [0, 1, 2, 3, 4, 5, 6]]) {
    const out = dropRetiredRules(doc, idx, BUNDLED);
    check(`indices ${JSON.stringify(idx)} never grow or reorder the ruleset`,
      out.doc.rules.length <= doc.rules.length &&
      out.doc.rules.every((r, i, arr) => arr.indexOf(r) === i) &&
      out.doc.rules.every((r) => doc.rules.includes(r)));
  }
}

console.log(`policy-baseline-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
