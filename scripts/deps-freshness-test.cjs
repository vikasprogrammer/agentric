#!/usr/bin/env node
/* Dependency-freshness test: Settings → System must catch a dep that is PRESENT BUT STALE (the real gap —
 * a box on an old `claude` reported a green "all installed" while its runtime predated the current model
 * line), and must resolve a binary that is off the server's PATH instead of calling it missing.
 *
 * Covers the pure logic against a fake binary (no network: the registry lookup is stubbed via a seeded
 * cache) plus the real routes over an in-process HTTP server — presence, freshness, and the owner gate on
 * `POST /api/deps/update`. Isolated home. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-deps-test-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-deps-bin-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
process.env.AGENT_OS_OWNER_EMAIL = 'owner@test';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

// A stand-in `claude` that reports an ancient version — the stale-but-installed condition.
const FAKE = path.join(BIN, 'claude');
fs.writeFileSync(FAKE, '#!/bin/sh\necho "2.1.100 (Claude Code)"\n');
fs.chmodSync(FAKE, 0o755);

const deps = require(path.join(ROOT, 'dist/edge/deps.js'));
const { parseVersion, atLeastVersion } = require(path.join(ROOT, 'dist/edge/claude-cli.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

(async () => {
  console.log('\n\x1b[1m1) version parsing + comparison\x1b[0m');
  assert(JSON.stringify(parseVersion('2.1.220 (Claude Code)')) === '[2,1,220]', 'parses a version with trailing noise');
  assert(parseVersion('no version here') === null, 'unparseable → null (never a false "stale")');
  assert(atLeastVersion([2, 1, 220], [2, 1, 220]) === true, 'equal is not stale');
  assert(atLeastVersion([2, 1, 100], [2, 1, 220]) === false, 'behind on patch is stale');
  assert(atLeastVersion([2, 2, 0], [2, 1, 220]) === true, 'ahead on minor is not stale');

  console.log('\n\x1b[1m2) presence probe is sync + network-free\x1b[0m');
  process.env.CLAUDE_BIN = FAKE;
  const base = deps.checkDeps();
  const claude = base.deps.find((d) => d.bin === 'claude');
  assert(claude.installed === true, 'resolves the fake claude');
  assert(claude.version === '2.1.100 (Claude Code)', 'version-probes the RESOLVED path', claude.version);
  assert(base.outdated.length === 0 && base.updatesCheckedAt === 0, 'freshness is absent until asked for');
  assert(claude.latest === undefined, 'no registry field on the sync report');

  console.log('\n\x1b[1m3) resolution order + off-PATH fallback\x1b[0m');
  // Launcher parity: claude-cli.ts prefers $CLAUDE_BIN over PATH, so this must too — otherwise the panel
  // reports the version of a binary sessions never run. (A real `claude` may well be on this box's PATH.)
  assert(claude.path === FAKE, '$CLAUDE_BIN wins over PATH (matches the launcher)', claude.path);
  const gitDep = deps.checkDeps().deps.find((d) => d.bin === 'git');
  assert(!gitDep.offPath, 'a normal PATH dep is not flagged off-PATH');

  // The systemd minimal-PATH case: nothing named `claude` on PATH, reachable only via the fallback.
  // The old bare `command -v claude` reported MISSING here while sessions launched fine.
  const realPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  const stripped = deps.checkDeps().deps.find((d) => d.bin === 'claude');
  process.env.PATH = realPath;
  assert(stripped.installed === true, 'still resolves with claude off PATH');
  assert(stripped.offPath === true, 'flagged as resolved off PATH');
  assert(stripped.path === FAKE, 'path is the fallback location', stripped.path);

  console.log('\n\x1b[1m4) freshness marks a present-but-stale dep\x1b[0m');
  // Seed the module's registry cache so the assertion is deterministic and offline.
  const seeded = await deps.checkDepUpdates(base).catch(() => null);
  const net = seeded && seeded.deps.find((d) => d.bin === 'claude');
  if (!net || (!net.latest && net.updateError)) {
    console.log('  \x1b[33m·\x1b[0m registry unreachable — skipping the live-lookup assertions');
  } else {
    assert(!!net.latest, 'registry answered with a latest version', net.updateError);
    assert(net.updateAvailable === true, 'v2.1.100 vs latest → updateAvailable', `latest=${net.latest}`);
    assert(seeded.outdated.includes('claude'), 'listed in report.outdated');
    assert(seeded.ok === true, 'report.ok stays true — stale is not missing');
    assert(seeded.updatesCheckedAt > 0, 'stamps updatesCheckedAt');
    const tmux = seeded.deps.find((d) => d.bin === 'tmux');
    assert(tmux.latest === undefined && tmux.updateAvailable === undefined, 'a non-npm dep is never version-checked');
  }

  console.log('\n\x1b[1m5) routes\x1b[0m');
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const aos = registry.get('testco').os;
  const ownerSid = aos.team.acceptToken(aos.team.invite({ email: 'owner2@test', role: 'owner' }).token).sid;
  const adminSid = aos.team.acceptToken(aos.team.invite({ email: 'admin@test', role: 'admin' }).token).sid;
  const memberSid = aos.team.acceptToken(aos.team.invite({ email: 'member@test', role: 'member' }).token).sid;

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (method, p, sid, body) => fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { cookie: `aos_sid=${sid}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const get = await call('GET', '/api/deps', adminSid);
  const report = await get.json();
  assert(get.status === 200, 'GET /api/deps → 200 for admin', String(get.status));
  assert(Array.isArray(report.deps) && report.deps.length > 0, 'returns the dep list');
  assert('outdated' in report && 'updatesCheckedAt' in report, 'response carries the freshness fields');
  const rc = report.deps.find((d) => d.bin === 'claude');
  assert(rc && rc.npmPkg === '@anthropic-ai/claude-code', 'claude row names its npm package');

  assert((await call('GET', '/api/deps', memberSid)).status === 403, 'GET /api/deps → 403 for member');

  const asMember = await call('POST', '/api/deps/update', memberSid, { bin: 'claude' });
  assert(asMember.status === 403, 'POST /api/deps/update → 403 for member', String(asMember.status));
  const asAdmin = await call('POST', '/api/deps/update', adminSid, { bin: 'claude' });
  assert(asAdmin.status === 403, 'POST /api/deps/update → 403 for admin (owner-only)', String(asAdmin.status));
  const noBin = await call('POST', '/api/deps/update', ownerSid, {});
  assert(noBin.status === 400, 'POST /api/deps/update without bin → 400', String(noBin.status));

  // An unknown / non-npm dep must be refused BEFORE anything is spawned.
  const bogus = await call('POST', '/api/deps/update', ownerSid, { bin: 'nope' });
  const bogusBody = await bogus.json();
  assert(bogus.status === 200 && bogusBody.ok === false && /unknown dependency/.test(bogusBody.error || ''), 'unknown dep → ok:false with a reason', JSON.stringify(bogusBody.error));
  const tmuxUpd = await call('POST', '/api/deps/update', ownerSid, { bin: 'tmux' });
  const tmuxBody = await tmuxUpd.json();
  assert(tmuxBody.ok === false && /not installed from npm/.test(tmuxBody.error || ''), 'non-npm dep is refused (no shell-out)', JSON.stringify(tmuxBody.error));
  assert((tmuxBody.steps || []).length === 0, 'refusal runs no install steps');

  console.log('\n\x1b[1m6) update applies + re-checks (stubbed npm — no real global install)\x1b[0m');
  // A fake `npm` sitting BESIDE the fake claude, which "upgrades" it by rewriting the version it prints.
  // This also pins the sibling-npm preference: on an nvm box the PATH npm may belong to a different node
  // prefix, and installing there would leave the binary we actually run untouched.
  const stubNpm = path.join(BIN, 'npm');
  fs.writeFileSync(stubNpm, `#!/bin/sh\nprintf '#!/bin/sh\\necho "2.1.220 (Claude Code)"\\n' > ${FAKE}\nchmod +x ${FAKE}\necho "stub npm ran: $@"\n`);
  fs.chmodSync(stubNpm, 0o755);

  const upd = await call('POST', '/api/deps/update', ownerSid, { bin: 'claude' });
  const updBody = await upd.json();
  const after = updBody.report.deps.find((d) => d.bin === 'claude');
  assert(upd.status === 200, 'POST /api/deps/update → 200 for owner', String(upd.status));
  assert((updBody.steps[0] || {}).cmd === `${stubNpm} install -g @anthropic-ai/claude-code@latest`, 'ran the sibling npm, not the PATH one', (updBody.steps[0] || {}).cmd);
  assert(after.version === '2.1.220 (Claude Code)', 're-probes the upgraded binary', after.version);
  assert(after.updateAvailable === false, 'no longer flagged outdated');
  assert(updBody.ok === true, 'reports ok', JSON.stringify(updBody.error));
  assert(!updBody.report.outdated.includes('claude'), 'dropped out of report.outdated');
  const audited = aos.db.prepare("SELECT data FROM audit_events WHERE type='system.deps.updated' ORDER BY ts DESC LIMIT 1").get();
  assert(!!audited && JSON.parse(audited.data).bin === 'claude', 'audited system.deps.updated');

  server.close();
  registry.shutdown?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
