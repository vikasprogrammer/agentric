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
const os = require('os');

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
/**
 * UNGREPPABLE-SOURCE guard. A raw NUL byte in a .ts file compiles and runs fine, but `file` reports the
 * source as binary — so grep AND ripgrep skip it ENTIRELY, and every text search over the tree returns a
 * silent false negative. Five files carried them (a composite-key/sentinel separator written as a literal
 * NUL instead of the `\0` escape), including `enricher.ts`, `policy.ts` and `kernel.ts` — the three most
 * search-relevant files in the governance stack. Concretely: `grep -rn computeHostFacts src/` reported
 * only the declaration and never the call site, which reads as "nothing uses this". Write the escape,
 * never the byte. Runs before the dist checks so a stale build can't mask it.
 */
const nulSources = [];
(function scanForNul(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) scanForNul(p);
    else if (e.name.endsWith('.ts') && fs.readFileSync(p).includes(0)) nulSources.push(path.relative(ROOT, p));
  }
})(path.join(ROOT, 'src'));
if (nulSources.length) {
  console.error('governance-conformance: raw NUL byte in source — grep/rg treat these files as binary and skip them:');
  for (const f of nulSources) console.error(`  ${f}`);
  console.error("  Use the two-character escape '\\0' in the literal instead of an embedded NUL byte.");
  process.exit(2);
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
const { resolveRuntimeTuning } = require(path.join(ROOT, 'dist/types.js'));
const { fileGovernanceDecision } = require(path.join(ROOT, 'dist/governance/file-guard.js'));
const { hostGovernanceDecision, stricterDecision } = require(path.join(ROOT, 'dist/governance/host-match'));
const { resolveCapability } = require(path.join(ROOT, 'dist/capabilities/normalize'));

/**
 * The file-guard cases assert that a write under the SERVICE USER's home is denied, and
 * `sensitiveWriteRoots` resolves that home with `os.homedir()` at call time. A fixture can therefore
 * not hardcode a home path: three cases baked in `~/…`, so they passed on the author's Mac
 * and failed on every Linux box — CI included, which went red for weeks while the guard itself was
 * working correctly (verified on a Linux host: `$HOME/.ssh/authorized_keys` → deny). Fixtures write
 * `${HOME}` and it is expanded here, per platform, before enrichment.
 */
const expandHome = (v) => (typeof v === 'string' ? v.split('${HOME}').join(os.homedir())
  : Array.isArray(v) ? v.map(expandHome)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandHome(x)]))
  : v);

const fixture = expandHome(JSON.parse(fs.readFileSync(path.join(ROOT, 'test/governance/conformance.json'), 'utf8')));
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
  // Mirror tm.gate: capability normalization (§4.2) — a generic connector.call resolves to its canonical
  // capability by tool name (STRIPE_REFUND → payments.refund). No-op for non-connector caps.
  capability = resolveCapability(capability, typeof args.tool === 'string' ? args.tool : undefined);
  let decision = engine.classify({ capabilityId: capability, args, reasoning: '' }, ctx);
  // Mirror tm.gate: host governance is applied by the engine (not the JSON), combined most-restrictive.
  if (c.hostGrants && (capability === 'net.connect' || capability === 'ssh.exec')) {
    decision = stricterDecision(decision, hostGovernanceDecision(capability, args));
  }
  // Mirror tm.gate: the file-write guard is engine-level too (default@v3 has no file.write rules, and a
  // tenant with a persisted policy override would never see a new JSON one). Tier 1 (crown-jewel paths)
  // is unconditional; tier 2 is per-case via `askOutsideWorkdir`.
  if (capability === 'file.write') {
    decision = stricterDecision(decision, fileGovernanceDecision(capability, args, {
      dataHome: c.dataHome, askOutsideWorkdir: c.askOutsideWorkdir === true,
    }));
  }
  const got = tag(decision);
  if (got === c.expect) pass++;
  else failures.push(`decision  ✗ ${c.name}\n            expected ${c.expect}, got ${got}  (facts: destructive=${args.destructive} risky=${args.risky} amountUsd=${args.amountUsd} deleteCount=${args.deleteCount})`);
  // Optional fact-level assertion: the default posture no longer GATES `risky`, so a change in what the
  // enricher classifies as risky is invisible in the decision alone — assert the fact directly (#139).
  if (typeof c.expectRisky === 'boolean') {
    if (!!args.risky === c.expectRisky) pass++;
    else failures.push(`risky     ✗ ${c.name}\n            expected risky=${c.expectRisky}, got ${!!args.risky}`);
  }
  // Optional direct fact assertions (e.g. a custom `prodBuild` pattern that no bundled policy rule reads).
  if (c.expectFacts && typeof c.expectFacts === 'object') {
    for (const [k, v] of Object.entries(c.expectFacts)) {
      if (!!args[k] === !!v) pass++;
      else failures.push(`fact      ✗ ${c.name}\n            expected ${k}=${v}, got ${args[k]}`);
    }
  }
}

for (const c of fixture.context) {
  const got = autoClearsApproval(c.level, c.ctx);
  if (got === c.expectAutoClear) pass++;
  else failures.push(`context   ✗ ${c.name}\n            expected autoClear=${c.expectAutoClear}, got ${got}`);
}

const riskyChecks = fixture.decisions.filter((c) => typeof c.expectRisky === 'boolean').length;
const factChecks = fixture.decisions.reduce((n, c) => n + (c.expectFacts ? Object.keys(c.expectFacts).length : 0), 0);
// Runtime tuning: a model belonging to another runtime must never reach a CLI. The per-agent route
// rejects one outright; INHERITANCE from the workspace default (which spans every runtime and so can't
// be right for all of them) silently drops it instead, so the run falls back to the CLI default rather
// than dying. Regression-guards a live failure where a Codex run inherited `opus`.
for (const c of fixture.tuning || []) {
  const got = resolveRuntimeTuning(c.agent || {}, c.defaults || {}, c.override, c.runtime);
  const want = c.expectModel === null ? undefined : c.expectModel;
  if (got.model === want) pass++;
  else failures.push(`tuning    ✗ ${c.name}\n            expected model=${want}, got ${got.model}`);
}

const total = fixture.decisions.length + fixture.context.length + riskyChecks + factChecks + (fixture.tuning || []).length;
if (failures.length) {
  console.error(`\nGOVERNANCE CONFORMANCE: ${pass}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error('  ' + f);
  console.error('');
  process.exit(1);
}
console.log(`GOVERNANCE CONFORMANCE: ${pass}/${total} passed ✓`);
