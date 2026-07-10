#!/usr/bin/env node
/**
 * Unit test for `reconcileTenant` — aligns agent manifests' `policyContext` to the enforced ruleset id.
 * Builds a throwaway agents dir with a matching agent, a drifted agent, and a context-less agent, then
 * asserts only the drifted one is rewritten (and only when NOT dry-run), formatting preserved.
 * Run: node scripts/test-policy-reconcile.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { reconcileTenant } = require(path.join(__dirname, '..', 'dist/governance/policy-reconcile'));

let pass = 0;
const ok = (cond, label) => {
  assert.ok(cond, `FAIL: ${label}`);
  pass++;
  console.log(`  ok  ${label}`);
};

// Build a scratch agents dir: <dir>/<id>/agent.json
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-reconcile-'));
const agentsDir = path.join(root, 'agents');
const write = (id, ctx) => {
  fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
  const m = { id, version: '1.0.0', principal: `svc-${id}`, runtime: 'claude-code' };
  if (ctx !== undefined) m.policyContext = ctx;
  fs.writeFileSync(path.join(agentsDir, id, 'agent.json'), JSON.stringify(m, null, 2) + '\n');
};
write('aligned-one', 'tenant@v2');
write('drifted-one', 'tenant@v1');
write('no-context', undefined);
// A stray non-agent dir (no agent.json) must be ignored, not crash.
fs.mkdirSync(path.join(agentsDir, 'not-an-agent'), { recursive: true });

const ENF = 'tenant@v2';

// 1) Dry-run classifies correctly and writes NOTHING.
const before = fs.readFileSync(path.join(agentsDir, 'drifted-one', 'agent.json'), 'utf8');
const dry = reconcileTenant(agentsDir, ENF, { dryRun: true });
ok(dry.enforced === ENF, 'reports enforced id');
ok(dry.changed.length === 1 && dry.changed[0].agent === 'drifted-one' && dry.changed[0].from === 'tenant@v1', 'dry-run flags only the drifted agent (with from)');
ok(dry.aligned.length === 1 && dry.aligned[0] === 'aligned-one', 'dry-run counts the already-aligned agent');
ok(dry.skipped.length === 1 && dry.skipped[0] === 'no-context', 'dry-run skips the context-less agent');
ok(fs.readFileSync(path.join(agentsDir, 'drifted-one', 'agent.json'), 'utf8') === before, 'dry-run writes nothing to disk');

// 2) Apply rewrites only the drifted agent, preserving other fields + format, and is then idempotent.
const applied = reconcileTenant(agentsDir, ENF, {});
ok(applied.changed.length === 1, 'apply rewrites exactly one agent');
const after = JSON.parse(fs.readFileSync(path.join(agentsDir, 'drifted-one', 'agent.json'), 'utf8'));
ok(after.policyContext === ENF, 'drifted agent now declares the enforced id');
ok(after.id === 'drifted-one' && after.principal === 'svc-drifted-one' && after.runtime === 'claude-code', 'other manifest fields preserved');
ok(fs.readFileSync(path.join(agentsDir, 'drifted-one', 'agent.json'), 'utf8').endsWith('}\n'), 'on-disk format preserved (2-space + trailing newline)');
const again = reconcileTenant(agentsDir, ENF, {});
ok(again.changed.length === 0 && again.aligned.length === 2, 're-run is idempotent (nothing left to change)');

// 3) A missing agents dir yields an empty result, not a throw.
const empty = reconcileTenant(path.join(root, 'nope'), ENF, {});
ok(empty.changed.length === 0 && empty.aligned.length === 0 && empty.skipped.length === 0, 'missing agents dir → empty result');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\npolicy-reconcile: ${pass}/11 checks passed`);
process.exit(0);
