#!/usr/bin/env node
/* update-watch test — Tier 0 (drift alarm) + Tier 1 (one-tap approve) of the self-update watcher.
 *
 * The failure this exists to prevent is SILENCE: `checkForUpdate` only ever ran when a human had the
 * console open, so headless boxes drifted 13+ versions behind with no signal anywhere. So the checks
 * here are mostly about "did anyone get told", and about the two ways telling can go wrong — saying it
 * every tick (noise) or not saying it when apply is impossible (the dirty-tree box that silently stops
 * updating).
 *
 * Pins:
 *   • behind → one card, addressed to owners, DM'd; the SAME upstream head never cards twice; a NEW
 *     head supersedes the old card rather than stacking,
 *   • a dirty tree cards as BLOCKED and names the files — even in ask mode, where there is nothing to
 *     approve,
 *   • up-to-date retires a stale card,
 *   • ask mode raises an OWNER approval; approving it applies, rejecting it does not,
 *   • the decision is FLOORED at ask/owner — a policy that would `allow` os.update still only asks,
 *     which is the property that keeps a permissive policy from self-applying,
 *   • a policy that DENIES os.update kills the apply lane but still notifies (knowing you are behind is
 *     not permission to change the box),
 *   • off = silent.
 * The updater module is stubbed: this tests the watcher's decisions, not git. Isolated home; no ttyd. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-update-watch-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const check = (name, ok, d) => ok ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const updater = require(path.join(ROOT, 'dist/edge/updater.js'));
const { UpdateWatch, __resetUpdateWatch } = require(path.join(ROOT, 'dist/edge/update-watch.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

// ── stub the git-facing half; the watcher's decisions are what's under test ────────────────────────
let STATUS = null;
let applied = [];
let APPLY_RESULT = { ok: true, steps: [], restarting: true };
updater.checkForUpdate = async () => STATUS;
updater.applyUpdate = async (tenant) => { applied.push(tenant); return APPLY_RESULT; };
const status = (over = {}) => ({
  current: '1.0.0', latest: '1.1.0', behind: 3, updateAvailable: true, branch: 'main',
  upstream: 'origin/main', dirty: false, dirtyFiles: [], head: 'aaaa111', checkedAt: Date.now(),
  log: ['feat: a thing', 'fix: another'], ...over,
});

(async () => {
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  tm.backend.aliveNames = () => new Set();
  tm.backend.kill = () => {}; tm.backend.hasClient = () => false;
  tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;
  const dms = [];
  tm.setReviewNotifier((n) => dms.push(n));

  // `loadAgentOS()` resolves the tenant from config, NOT AGENT_OS_TENANT (only the registry reads that
  // env), so ask the runtime rather than assuming the slug this file exported.
  const TENANT = aos.tenant;
  // `loadAgentOS()` doesn't seed the owner either (that happens in `serve`), so make one.
  aos.db.prepare("INSERT INTO members (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)")
    .run('m_owner', 'owner@x.io', 'Owner', 'owner', 'active', Date.now());
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cards = () => aos.db.prepare("SELECT id, type, title, body, status, approval_id, level, audience_kind, audience_id, args FROM messages WHERE session_id = 'system:update' ORDER BY created_at").all()
    .map((r) => ({ ...r, args: JSON.parse(r.args || '{}') }));
  const openCards = () => cards().filter((c) => c.status === 'open' || c.status === 'pending');
  const watch = () => new UpdateWatch(aos, tm);
  const setMode = (mode) => aos.settings.setUpdateWatch({ mode }, 'test');
  const auditTypes = () => aos.db.prepare("SELECT type FROM audit_events WHERE run_id = 'system:update'").all().map((r) => r.type);

  console.log('\n\x1b[1m1) default mode is notify — silence was the failure, so the safe half is on\x1b[0m');
  check('a fresh workspace watches in notify mode', aos.settings.updateWatch().mode === 'notify', JSON.stringify(aos.settings.updateWatch()));

  console.log('\n\x1b[1m2) behind → exactly one owner-addressed card + a DM\x1b[0m');
  STATUS = status();
  const r1 = await watch().run();
  check('reports it notified', r1.action === 'notified', JSON.stringify(r1));
  check('one card posted', openCards().length === 1, JSON.stringify(openCards().map((c) => c.title)));
  const c1 = openCards()[0];
  check('...as a plain notification (nothing to approve in notify mode)', c1.type === 'notification' && !c1.approval_id);
  check('...addressed to owners, not to a session', c1.audience_kind === 'approvers' && c1.audience_id === 'owner', `${c1.audience_kind}/${c1.audience_id}`);
  check('...naming the version it would move to', c1.title.includes('1.1.0'));
  check('...carrying the changelog preview', c1.body.includes('feat: a thing'));
  check('a DM went out — the whole point on a headless box', dms.length === 1 && dms[0].kind === 'system.update', JSON.stringify(dms[0] && dms[0].kind));
  const inbox = tm.listMessages(owner).filter((m) => m.sessionId === 'system:update');
  check('it reaches the OWNER inbox — a session-less card routed purely by audience', inbox.length === 1, JSON.stringify(inbox.map((m) => m.title)));
  const admin = { id: 'm_admin', email: 'admin@x.io', name: 'Admin', role: 'admin', status: 'active', createdAt: Date.now() };
  check('...and an admin sees it too (oversight), but only the owner can approve it', tm.listMessages(admin, 'all').some((m) => m.sessionId === 'system:update'));
  check('audited update.available', auditTypes().includes('update.available'));

  console.log('\n\x1b[1m3) the same upstream commit never cards twice\x1b[0m');
  const r2 = await watch().run();
  check('a second tick on the same head is a duplicate', r2.action === 'duplicate', JSON.stringify(r2));
  check('...and posts nothing new', openCards().length === 1);
  check('...and sends no second DM', dms.length === 1);

  console.log('\n\x1b[1m4) origin moves on → supersede, do not stack\x1b[0m');
  STATUS = status({ head: 'bbbb222', latest: '1.2.0', behind: 5 });
  const r3 = await watch().run();
  check('a new head cards again', r3.action === 'notified', JSON.stringify(r3));
  check('still exactly one OPEN card', openCards().length === 1, JSON.stringify(openCards().map((c) => c.title)));
  check('...the new one', openCards()[0].args.head === 'bbbb222');
  check('...and the old one was retired, not deleted', cards().filter((c) => c.args.head === 'aaaa111' && c.status === 'cancelled').length === 1);

  console.log('\n\x1b[1m5) up to date → the stale card is retired\x1b[0m');
  STATUS = status({ updateAvailable: false, behind: 0, current: '1.2.0', latest: '1.2.0' });
  const r4 = await watch().run();
  check('reports up-to-date', r4.action === 'up-to-date', JSON.stringify(r4));
  check('no open card is left asking for an update that landed', openCards().length === 0);

  console.log('\n\x1b[1m6) a dirty tree BLOCKS — and says so, naming the files\x1b[0m');
  STATUS = status({ head: 'cccc333', dirty: true, dirtyFiles: ['web/src/Xterm.tsx', 'src/server.ts'] });
  const r5 = await watch().run();
  check('reports blocked', r5.action === 'blocked', JSON.stringify(r5));
  const blocked = openCards()[0];
  check('the card says it cannot be applied', /blocked/i.test(blocked.title), blocked.title);
  check('...and NAMES the file in the way', blocked.body.includes('web/src/Xterm.tsx'), blocked.body.slice(0, 120));
  check('audited update.blocked', auditTypes().includes('update.blocked'));

  console.log('\n\x1b[1m7) ask mode: a dirty tree still blocks — there is nothing to approve\x1b[0m');
  setMode('ask');
  STATUS = status({ head: 'dddd444', dirty: true, dirtyFiles: ['src/server.ts'] });
  const r6 = await watch().run();
  check('blocked wins over ask', r6.action === 'blocked', JSON.stringify(r6));
  check('...so no approval was raised', aos.approvals.pending(TENANT).length === 0);

  console.log('\n\x1b[1m8) ask mode: an OWNER approval whose resolution applies the update\x1b[0m');
  STATUS = status({ head: 'eeee555', latest: '1.3.0' });
  const r7 = await watch().run();
  check('reports requested', r7.action === 'requested', JSON.stringify(r7));
  const ap = aos.approvals.pending(TENANT);
  check('one approval is pending', ap.length === 1, JSON.stringify(ap.map((a) => a.attempt && a.attempt.capabilityId)));
  check('...for the os.update capability', ap[0].attempt.capabilityId === 'os.update');
  check('...at OWNER level — an admin must not be able to update the box', ap[0].level === 'owner', ap[0].level);
  const card = openCards()[0];
  check('the inbox card is an approval card bound to it', card.type === 'approval' && card.approval_id === ap[0].id);
  check('...and warns that live sessions are interrupted', /interrupted/i.test(card.body));
  check('nothing has been applied yet', applied.length === 0);

  aos.approvals.resolve(ap[0].id, true, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  check('approving applies the update', applied.length === 1 && applied[0] === TENANT, JSON.stringify(applied));
  check('audited update.applying + update.applied', auditTypes().includes('update.applying') && auditTypes().includes('update.applied'));

  console.log('\n\x1b[1m9) rejecting applies nothing\x1b[0m');
  __resetUpdateWatch(); applied = [];
  STATUS = status({ head: 'ffff666', latest: '1.4.0' });
  await watch().run();
  const ap2 = aos.approvals.pending(TENANT)[0];
  aos.approvals.resolve(ap2.id, false, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  check('a rejected update is not applied', applied.length === 0, JSON.stringify(applied));
  check('...and is audited as rejected', auditTypes().includes('update.rejected'));

  console.log('\n\x1b[1m10) a failed apply is CARDED — a silent failure looks like a current box\x1b[0m');
  __resetUpdateWatch(); applied = [];
  APPLY_RESULT = { ok: false, error: 'git pull failed', steps: [{ cmd: 'git pull --ff-only', ok: false, out: 'conflict' }], restarting: false };
  STATUS = status({ head: 'aaaa777', latest: '1.5.0' });
  await watch().run();
  const ap3 = aos.approvals.pending(TENANT)[0];
  aos.approvals.resolve(ap3.id, true, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  const failCard = cards().filter((c) => /FAILED/.test(c.title));
  check('the failure gets its own card', failCard.length === 1, JSON.stringify(cards().map((c) => c.title)));
  check('...naming the failing step', failCard[0].body.includes('git pull'), failCard[0].body.slice(0, 100));
  check('...and is audited', auditTypes().includes('update.failed'));
  APPLY_RESULT = { ok: true, steps: [], restarting: true };

  console.log('\n\x1b[1m11) built-but-not-restarted gets its own card (looks fine, is not)\x1b[0m');
  __resetUpdateWatch();
  APPLY_RESULT = { ok: true, steps: [], restarting: false };
  STATUS = status({ head: 'bbbb888', latest: '1.6.0' });
  await watch().run();
  aos.approvals.resolve(aos.approvals.pending(TENANT)[0].id, true, owner.email);
  await new Promise((r) => setTimeout(r, 60));
  check('a build with no restart tells the human to restart', cards().some((c) => /restart this box by hand/i.test(c.title)), JSON.stringify(cards().map((c) => c.title)));
  APPLY_RESULT = { ok: true, steps: [], restarting: true };

  console.log('\n\x1b[1m12) the decision is FLOORED at ask/owner — policy can tighten, never loosen\x1b[0m');
  __resetUpdateWatch(); applied = [];
  const permissive = { id: 'permissive@v1', default: { action: 'allow' }, rules: [{ match: { capability: 'os.update' }, action: 'allow' }] };
  aos.applyPolicyDocument(permissive, owner.email);
  STATUS = status({ head: 'cccc999', latest: '1.7.0' });
  const r8 = await watch().run();
  check('a policy that would ALLOW os.update still only asks', r8.action === 'requested', JSON.stringify(r8));
  check('...at owner level', aos.approvals.pending(TENANT)[0].level === 'owner');
  check('...and applied nothing on its own', applied.length === 0);
  aos.approvals.resolve(aos.approvals.pending(TENANT)[0].id, false, owner.email);
  await new Promise((r) => setTimeout(r, 40));

  console.log('\n\x1b[1m13) a policy that DENIES os.update stops the apply but not the warning\x1b[0m');
  const denying = { id: 'denying@v1', default: { action: 'allow' }, rules: [{ match: { capability: 'os.update' }, action: 'never' }] };
  aos.applyPolicyDocument(denying, owner.email);
  STATUS = status({ head: 'dddd000', latest: '1.8.0' });
  const r9 = await watch().run();
  check('the apply lane is refused', r9.action === 'denied', JSON.stringify(r9));
  check('...no approval is raised', aos.approvals.pending(TENANT).length === 0);
  check('...but the box still says it is behind', openCards().some((c) => c.title.includes('1.8.0')), JSON.stringify(openCards().map((c) => c.title)));
  check('...explaining that policy disabled self-update', openCards()[0].body.includes('os.update'));
  check('audited update.denied', auditTypes().includes('update.denied'));

  console.log('\n\x1b[1m14) off is silent\x1b[0m');
  setMode('off');
  const before = cards().length;
  STATUS = status({ head: 'eeee111', latest: '1.9.0' });
  const r10 = await watch().run();
  check('an off watcher does nothing', r10.action === 'off', JSON.stringify(r10));
  check('...and posts no card', cards().length === before);
  const r11 = await watch().run({ force: true });
  check('force still runs it (the "does this work here" button)', r11.action !== 'off', JSON.stringify(r11));

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
