#!/usr/bin/env node
/* runtime-update watch test — the `claude` CLI sibling of the self-update watcher.
 *
 * The mechanism (registry probe + `npm install -g …@latest`) already existed; what was missing was
 * anyone asking on a timer, so a box pinned to a months-old runtime reported a green "all dependencies
 * installed" and looked healthy.
 *
 * What makes this NOT a copy of the OS watcher, and what these checks are mostly about: a CLI upgrade
 * can add TOOLS the gate hook has no routing row for, which fall to its `*) exit 0` arm and run
 * ungoverned (claude 2.1.224's cross-session messaging). So:
 *   • there is no unattended tier — the strongest mode is `ask`, floored at owner even under a policy
 *     that would `allow`,
 *   • the card names the version the gate routing was last signed off against, so "assume new channels"
 *     is a diff someone can actually do,
 *   • approving STAMPS the landed version as signed-off — and a manual console upgrade stamps it too,
 *     so the two paths can't disagree,
 *   • the stamp records what LANDED, not what the card was raised about (an upgrade races the registry).
 * Also pins the shared watcher shape: dedupe per version, supersede-not-stack, retire on up-to-date,
 * failure carded, policy deny killing the lane but not the warning, `off` silent.
 * The deps module is stubbed: this tests the watcher's decisions, not npm. Isolated home; no ttyd. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-runtime-watch-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const check = (name, ok, d) => ok ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const deps = require(path.join(ROOT, 'dist/edge/deps.js'));
const { RuntimeUpdateWatch, __resetRuntimeWatch } = require(path.join(ROOT, 'dist/edge/runtime-update-watch.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));

// ── stub the npm-facing half ───────────────────────────────────────────────────────────────────────
let DEP = null;
let upgrades = [];
let UPGRADE = null; // (bin) => InstallResult
deps.checkDeps = () => ({ deps: [DEP], ok: true, installable: [], manager: null, installCommand: null, shortcut: '', platform: 'test', outdated: [], updatesCheckedAt: Date.now() });
deps.checkDepUpdates = async (r) => r;
deps.updateNpmDep = async (bin) => { upgrades.push(bin); return UPGRADE(bin); };
const dep = (over = {}) => ({ bin: 'claude', label: 'Claude Code', purpose: '', required: true, npmPkg: '@anthropic-ai/claude-code', installed: true, version: '2.1.200', latest: '2.1.230', updateAvailable: true, ...over });

(async () => {
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const TENANT = aos.tenant;
  tm.backend.aliveNames = () => new Set();
  tm.backend.kill = () => {}; tm.backend.hasClient = () => false;
  tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;
  const dms = []; tm.setReviewNotifier((n) => dms.push(n));
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const post = (p, body, c = cookie) => fetch(base + p, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  const cards = () => aos.db.prepare("SELECT id, type, title, body, status, approval_id, level, args FROM messages WHERE session_id = 'system:runtime-update' ORDER BY created_at").all()
    .map((r) => ({ ...r, args: JSON.parse(r.args || '{}') }));
  const open = () => cards().filter((c) => c.status === 'open' || c.status === 'pending');
  const watch = () => new RuntimeUpdateWatch(aos, tm);
  const setMode = (mode) => aos.settings.setRuntimeWatch({ mode }, 'test');
  const audits = () => aos.db.prepare("SELECT type FROM audit_events WHERE run_id = 'system:runtime-update'").all().map((r) => r.type);
  UPGRADE = () => ({ ok: true, steps: [], report: { deps: [dep({ version: '2.1.230', updateAvailable: false })] } });

  console.log('\n\x1b[1m1) default is notify, on its own slower beat\x1b[0m');
  const cfg = aos.settings.runtimeWatch();
  check('a fresh workspace watches the runtime in notify mode', cfg.mode === 'notify', JSON.stringify(cfg));
  check('...separately from the OS watcher, so a box can pin its runtime and still update itself',
    aos.settings.updateWatch().mode === 'notify' && cfg.everyHours !== aos.settings.updateWatch().everyHours, JSON.stringify([cfg, aos.settings.updateWatch()]));

  console.log('\n\x1b[1m2) a stale CLI cards, and the card names the governance risk\x1b[0m');
  DEP = dep();
  const r1 = await watch().run();
  check('reports notified', r1.action === 'notified', JSON.stringify(r1));
  check('one card', open().length === 1);
  const c1 = open()[0];
  check('...naming both versions', c1.body.includes('2.1.200') && c1.body.includes('2.1.230'));
  check('...warning that a new CLI can add ungoverned tools', /ungoverned/.test(c1.body), c1.body.slice(0, 80));
  check('...citing the real precedent rather than an abstraction', c1.body.includes('2.1.224'));
  check('...saying nothing has been signed off yet on a fresh box', /No version has been signed off/.test(c1.body));
  check('...and that running sessions keep their CLI', /NEXT session/.test(c1.body));
  check('a DM went out', dms.length === 1 && dms[0].kind === 'system.update');
  check('audited runtime.update.available', audits().includes('runtime.update.available'));

  console.log('\n\x1b[1m3) dedupe per version; a newer one supersedes\x1b[0m');
  check('the same latest does not card twice', (await watch().run()).action === 'duplicate');
  DEP = dep({ latest: '2.1.240' });
  await watch().run();
  check('a newer version cards again', open().length === 1 && open()[0].args.latest === '2.1.240', JSON.stringify(open().map((c) => c.args.latest)));
  check('...retiring the old card rather than stacking', cards().filter((c) => c.args.latest === '2.1.230' && c.status === 'cancelled').length === 1);

  console.log('\n\x1b[1m4) up to date / not installed\x1b[0m');
  DEP = dep({ updateAvailable: false, version: '2.1.240', latest: '2.1.240' });
  check('reports up-to-date', (await watch().run()).action === 'up-to-date');
  check('...and retires the stale card', open().length === 0);
  DEP = dep({ installed: false, version: undefined });
  check('a missing CLI is left to Settings → System, not double-reported', (await watch().run()).action === 'not-installed');
  check('...and posts nothing', open().length === 0);

  console.log('\n\x1b[1m5) ask mode: OWNER approval, and approving IS the review\x1b[0m');
  setMode('ask');
  DEP = dep({ latest: '2.1.250' });
  const r2 = await watch().run();
  check('reports requested', r2.action === 'requested', JSON.stringify(r2));
  const ap = aos.approvals.pending(TENANT);
  check('one approval pending for runtime.update', ap.length === 1 && ap[0].attempt.capabilityId === 'runtime.update');
  check('...at OWNER level', ap[0].level === 'owner', ap[0].level);
  check('...bound to an approval card', open()[0].type === 'approval' && open()[0].approval_id === ap[0].id);
  check('nothing upgraded yet', upgrades.length === 0);
  check('nothing signed off yet', aos.settings.gateReviewedRuntimeVersion() === '');

  // The upgrade lands on something NEWER than the card was raised about — the registry moved underneath.
  UPGRADE = () => ({ ok: true, steps: [], report: { deps: [dep({ version: '2.1.251', updateAvailable: false })] } });
  aos.approvals.resolve(ap[0].id, true, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  check('approving upgrades the CLI', upgrades.length === 1 && upgrades[0] === 'claude');
  check('...stamping what LANDED, not what was carded', aos.settings.gateReviewedRuntimeVersion() === '2.1.251', aos.settings.gateReviewedRuntimeVersion());
  check('...and carding the outcome', cards().some((c) => /upgraded/i.test(c.title) && c.args.latest === '2.1.251'), JSON.stringify(cards().map((c) => c.title)));
  check('audited applying + applied', audits().includes('runtime.update.applying') && audits().includes('runtime.update.applied'));

  console.log('\n\x1b[1m6) the next card reports the signed-off version, not a standing warning\x1b[0m');
  DEP = dep({ version: '2.1.251', latest: '2.1.260' });
  __resetRuntimeWatch(); setMode('notify');
  await watch().run();
  check('the card says what was last signed off', open()[0].body.includes('last signed off against **v2.1.251**'), open()[0].body.slice(0, 200));

  console.log('\n\x1b[1m7) the ROUTES — a manual console upgrade stamps the same version\x1b[0m');
  aos.settings.setGateReviewedRuntimeVersion('0.0.0', 'test');
  UPGRADE = () => ({ ok: true, steps: [], report: { deps: [dep({ version: '2.1.260', updateAvailable: false })] } });
  const manual = await (await post('/api/deps/update', { bin: 'claude' })).json();
  check('POST /api/deps/update upgrades via the route', manual.ok === true, JSON.stringify(manual).slice(0, 120));
  check('...and a hand upgrade records the review too, so the two paths cannot disagree',
    aos.settings.gateReviewedRuntimeVersion() === '2.1.260', aos.settings.gateReviewedRuntimeVersion());
  aos.db.prepare("INSERT INTO members (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)")
    .run('m_adm', 'adm@x.io', 'Adm', 'admin', 'active', Date.now());
  const adminCookie = `aos_sid=${aos.team.createSession('m_adm')}`;
  check('an admin cannot change the watcher (it can widen what runs ungoverned)',
    (await post('/api/runtime/watch', { mode: 'off' }, adminCookie)).status === 403);
  check('an owner can', (await post('/api/runtime/watch', { mode: 'notify' })).status === 200);
  check('a bogus mode is refused', (await post('/api/runtime/watch', { mode: 'auto' })).status === 400);
  check('an unauthenticated call is refused', (await fetch(base + '/api/runtime/watch', { method: 'POST' })).status === 401);
  const depsView = await (await fetch(base + '/api/deps', { headers: { cookie } })).json();
  check('GET /api/deps carries the watch config + signed-off version for the console',
    depsView.watch?.mode === 'notify' && depsView.gateReviewedVersion === '2.1.260', JSON.stringify({ w: depsView.watch, g: depsView.gateReviewedVersion }));

  console.log('\n\x1b[1m8) a failed upgrade is carded and signs nothing off\x1b[0m');
  __resetRuntimeWatch(); setMode('ask'); upgrades = [];
  aos.settings.setGateReviewedRuntimeVersion('2.1.260', 'test');
  DEP = dep({ version: '2.1.260', latest: '2.1.270' });
  UPGRADE = () => ({ ok: false, error: 'EACCES: permission denied', steps: [{ cmd: 'npm install -g', ok: false, out: 'EACCES' }], report: { deps: [dep({ version: '2.1.260' })] } });
  await watch().run();
  aos.approvals.resolve(aos.approvals.pending(TENANT)[0].id, true, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  check('the failure is carded', cards().some((c) => /FAILED/.test(c.title)), JSON.stringify(cards().slice(-2).map((c) => c.title)));
  check('...and a failed upgrade signs NOTHING off', aos.settings.gateReviewedRuntimeVersion() === '2.1.260', aos.settings.gateReviewedRuntimeVersion());
  check('audited runtime.update.failed', audits().includes('runtime.update.failed'));

  console.log('\n\x1b[1m9) no unattended tier — an ALLOW policy still only asks\x1b[0m');
  __resetRuntimeWatch(); upgrades = [];
  UPGRADE = () => ({ ok: true, steps: [], report: { deps: [dep({ version: '2.1.280' })] } });
  aos.applyPolicyDocument({ id: 'permissive@v1', default: { action: 'allow' }, rules: [{ match: { capability: 'runtime.update' }, action: 'allow' }] }, owner.email);
  DEP = dep({ version: '2.1.260', latest: '2.1.280' });
  const r3 = await watch().run();
  check('a policy that would ALLOW still only asks', r3.action === 'requested', JSON.stringify(r3));
  check('...at owner level', aos.approvals.pending(TENANT)[0].level === 'owner');
  check('...and upgraded nothing on its own', upgrades.length === 0);
  aos.approvals.resolve(aos.approvals.pending(TENANT)[0].id, false, owner.email);
  await new Promise((r) => setTimeout(r, 40));
  check('rejecting upgrades nothing', upgrades.length === 0);

  console.log('\n\x1b[1m10) a DENY policy stops the upgrade but not the warning\x1b[0m');
  aos.applyPolicyDocument({ id: 'deny@v1', default: { action: 'allow' }, rules: [{ match: { capability: 'runtime.update' }, action: 'never' }] }, owner.email);
  DEP = dep({ version: '2.1.260', latest: '2.1.290' });
  const r4 = await watch().run();
  check('the upgrade lane is refused', r4.action === 'denied', JSON.stringify(r4));
  check('...no approval raised', aos.approvals.pending(TENANT).length === 0);
  check('...but the box still says the runtime is stale', open().some((c) => c.body.includes('2.1.290')));

  console.log('\n\x1b[1m11) off is silent\x1b[0m');
  setMode('off');
  const before = cards().length;
  DEP = dep({ version: '2.1.260', latest: '2.1.300' });
  check('off does nothing', (await watch().run()).action === 'off');
  check('...and posts no card', cards().length === before);
  check('force still runs it', (await watch().run({ force: true })).action !== 'off');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  server.close(); registry.stopAll();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
