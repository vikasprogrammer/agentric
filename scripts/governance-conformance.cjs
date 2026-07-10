#!/usr/bin/env node
/**
 * Governance conformance runner — the golden test that pins what the gate decides.
 *
 * It drives the SAME brain `tm.gate` uses: `enrichArgs()` → `JsonPolicyEngine.classify()` for the
 * decision tier, and `autoClearsApproval()` for the attended-approver shortcut. If this passes, the
 * live gate behaves as the fixture says; when you change the enricher or the default policy, update
 * test/governance/conformance.json in the same commit. No test runner needed — `node` + dist.
 *
 *   npm run build && node scripts/governance-conformance.cjs
 *
 * Exits 0 when every case matches, 1 on a mismatch, 2 if dist/ is missing or stale (CI-friendly).
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// Stale-dist guard. This suite exercises the BUILT `dist/` — the same compiled gate the live server
// runs — NOT `src/`. So if you edit the enricher/policy in src/ and run this WITHOUT rebuilding, you
// validate the OLD behaviour and get a false result (this exact trap once masked the host-governance
// rules as "7 failures"). Refuse to run when dist/ is missing or older than any src/*.ts change, and
// point at the fix. Walk mtimes: the newest src/*.ts must not be newer than the newest dist/*.js.
function newestMtime(dir, ext) {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(ext)) { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return newest;
}
const DIST = path.join(ROOT, 'dist');
const newestDist = newestMtime(DIST, '.js');
if (newestDist === 0) {
  console.error('governance-conformance: dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const newestSrc = newestMtime(path.join(ROOT, 'src'), '.ts');
if (newestSrc > newestDist) {
  console.error('governance-conformance: STALE dist/ — a src/*.ts is newer than the newest dist/*.js.');
  console.error('  The suite runs the compiled gate, so a stale build validates old behaviour. Run `npm run build` first.');
  process.exit(2);
}

const { enrichArgs, autoClearsApproval } = require(path.join(ROOT, 'dist/governance/enricher'));
const { JsonPolicyEngine } = require(path.join(ROOT, 'dist/governance/policy'));
const { hostGovernanceDecision, stricterDecision } = require(path.join(ROOT, 'dist/governance/host-match'));

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/governance/conformance.json'), 'utf8'));
const policyDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/policy/default.policy.json'), 'utf8'));

/** Map a Decision to the fixture's compact expectation string. */
function tag(decision) {
  if (decision.effect === 'allow') return 'allow';
  if (decision.effect === 'deny') return 'never';
  return `ask:${decision.level}`;
}

const ctx = { run: { id: 'r', tenant: 't', principal: 'a' } };
let pass = 0;
const failures = [];

for (const c of fixture.decisions) {
  const engine = new JsonPolicyEngine(policyDoc);
  const thresholds = c.thresholds || fixture.thresholdsDefault;
  engine.setThresholds(() => thresholds);
  const args = enrichArgs(c.capability, c.args, c.orgDomains || [], c.workdir, c.patterns || [], c.hostGrants || null);
  // Mirror tm.gate: an email send is reclassified to its own capability so the recipient-aware rules apply.
  let capability = args.emailSend === true ? 'email.send' : c.capability;
  // Mirror tm.gate host reclassification (Phase 2b): shell.exec → net.connect/ssh.exec per netMode.
  if (c.hostGrants && args.netEgress === true) {
    const netMode = c.netMode === 'allowlist' ? 'allowlist' : 'open';
    const govern = netMode === 'allowlist' ? true : (args.hostUnknown === true || args.hostInternal === true || args.hostListed === true);
    if (govern) capability = args.netProtocol === 'ssh' ? 'ssh.exec' : 'net.connect';
  }
  let decision = engine.classify({ capabilityId: capability, args, reasoning: '' }, ctx);
  // Mirror tm.gate: host governance is applied by the engine (not the JSON), combined most-restrictive.
  if (c.hostGrants && (capability === 'net.connect' || capability === 'ssh.exec')) {
    decision = stricterDecision(decision, hostGovernanceDecision(capability, args));
  }
  const got = tag(decision);
  if (got === c.expect) pass++;
  else failures.push(`decision  ✗ ${c.name}\n            expected ${c.expect}, got ${got}  (facts: destructive=${args.destructive} risky=${args.risky} amountUsd=${args.amountUsd} deleteCount=${args.deleteCount})`);
}

for (const c of fixture.context) {
  const got = autoClearsApproval(c.level, c.ctx);
  if (got === c.expectAutoClear) pass++;
  else failures.push(`context   ✗ ${c.name}\n            expected autoClear=${c.expectAutoClear}, got ${got}`);
}

const total = fixture.decisions.length + fixture.context.length;
if (failures.length) {
  console.error(`\nGOVERNANCE CONFORMANCE: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ' + f);
  console.error('');
  process.exit(1);
}
console.log(`GOVERNANCE CONFORMANCE: ${pass}/${total} passed ✓`);
