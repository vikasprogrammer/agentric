#!/usr/bin/env node
/**
 * Unit test for `policyContextMismatch` — the guard that surfaces an agent whose manifest `policyContext`
 * names a ruleset the engine isn't enforcing (a silent-footgun killer). Run: node scripts/test-policy-context.cjs
 */
const path = require('path');
const assert = require('assert');
const { policyContextMismatch } = require(path.join(__dirname, '..', 'dist/governance/policy'));

let pass = 0;
const ok = (cond, label) => {
  assert.ok(cond, `FAIL: ${label}`);
  pass++;
  console.log(`  ok  ${label}`);
};

// Match → no warning.
ok(policyContextMismatch('billing-ops', 'globex@v1', 'globex@v1') === null, 'declared === enforced → null');

// No context declared → no warning (nothing to reconcile).
ok(policyContextMismatch('a', undefined, 'globex@v1') === null, 'undefined context → null');
ok(policyContextMismatch('a', '', 'globex@v1') === null, 'empty context → null');

// Mismatch → a warning that names the agent, the declared context, and the enforced ruleset.
const w = policyContextMismatch('billing-ops', 'default@v2', 'globex@v1');
ok(typeof w === 'string' && w.length > 0, 'mismatch → non-empty warning');
ok(w.includes('billing-ops'), 'warning names the agent');
ok(w.includes('default@v2'), 'warning names the declared context');
ok(w.includes('globex@v1'), 'warning names the enforced ruleset');
ok(/NOT "default@v2"/.test(w), 'warning states which policy actually governs');

console.log(`\npolicy-context: ${pass}/8 checks passed`);
process.exit(0);
