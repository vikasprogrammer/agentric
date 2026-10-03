#!/usr/bin/env node
/* Login expiry — admins are warned BEFORE a Claude Code login reaches the end of its fixed lifetime.
 *
 * Why this exists — 2026-10-02/03: the expresstech box default login died at its `refreshTokenExpiresAt`
 * while running 6–30 sessions a day, and the instapods `tools2-new` pool account died the same way a week
 * earlier. Use does not extend that date (instapods `tools` refreshed all day and its expiry did not move),
 * and both were found only by the refusal card, after runs had stopped.
 *
 * Pinned here:
 *  1. outside a week: silent;
 *  2. inside a week: ONE admin card naming the login, the date and the exact re-login command, linked to
 *     Settings → Runtime — and not re-raised while it stays in the same band (hourly sweep ≠ hourly card);
 *  3. crossing a nearer band (7 → 3 → 1 → expired) supersedes the card rather than stacking another;
 *  4. a renewed login (expiry jumps forward) closes the card and records runtime.login.renewed;
 *  5. pool accounts are watched too; disabled ones are not;
 *  6. the once-guard is the audit trail, so a fresh TerminalManager (a restart) does not re-alarm.
 *
 * File-based credentials so this runs identically on Linux CI. Isolated home; nothing is launched. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-login-expiry-test-'));
process.env.AGENT_OS_HOME = path.join(HOME, 'data');
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { reviewLoginExpiry, expiryStage, loginExpiry } = require(path.join(ROOT, 'dist/edge/login-expiry.js'));

const aos = loadAgentOS();
const mkTm = () => {
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  tm.backend.kill = () => {};
  tm.backend.hasClient = () => false;
  tm.backend.aliveNames = () => new Set();
  return tm;
};
let tm = mkTm();

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-03T12:00:00Z');
const writeCred = (dir, rtExp, withRefresh = true) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'sk-ant-oat01-x', ...(withRefresh ? { refreshToken: 'sk-ant-ort01-x' } : {}),
    expiresAt: T0 + 8 * 3_600_000, refreshTokenExpiresAt: rtExp, subscriptionType: 'max' } }));
};
const BOX = path.join(HOME, '.claude');
const RT = T0 + 10 * DAY;                      // the box default's fixed expiry
writeCred(BOX, RT);

const cards = (status) => aos.db.prepare("SELECT title, body, status FROM messages WHERE session_id LIKE 'system:login-expiry-%'" + (status ? ' AND status = ?' : '') + ' ORDER BY created_at').all(...(status ? [status] : []));
const audits = (type) => aos.db.prepare('SELECT data FROM audit_events WHERE type = ?').all(type).map((r) => JSON.parse(r.data));
const run = (atMs) => reviewLoginExpiry(aos, tm, atMs);
const pushed = [];
const hook = () => { tm.reviewNotifier = (n) => pushed.push(n); };
hook();

console.log('\n\x1b[1m0) Reading the expiry\x1b[0m');
{
  const e = loginExpiry(BOX, T0);
  assert(e && e.refreshExpiresAt === RT && e.dead === false, 'reads refreshTokenExpiresAt from the credential record', JSON.stringify(e));
  assert(expiryStage(T0 + 10 * DAY, T0) === null, '10 days out is outside every band');
  assert(expiryStage(T0 + 6 * DAY, T0) === 7 && expiryStage(T0 + 2 * DAY, T0) === 3 && expiryStage(T0 + 0.5 * DAY, T0) === 1, 'bands are 7 / 3 / 1 days');
  assert(expiryStage(T0 - 1, T0) === 0, 'past the expiry is band 0');
}

console.log('\n\x1b[1m1) Outside a week: silent\x1b[0m');
{
  const r = run(T0);
  assert(r.length === 1 && r[0].stage === null && !r[0].carded, 'the box default is seen and not carded', JSON.stringify(r));
  assert(cards().length === 0, 'no card');
}

console.log('\n\x1b[1m2) Inside a week: one card, and only one\x1b[0m');
{
  run(RT - 6 * DAY);
  const open = cards('open');
  assert(open.length === 1, 'one open card', String(open.length));
  assert(open[0] && /box's Claude Code login expires in 7 days or less/.test(open[0].title), 'the title says which login and how soon', open[0] && open[0].title);
  assert(open[0] && open[0].body.includes(`CLAUDE_CONFIG_DIR=${BOX} claude /login`), 'the body carries the exact re-login command');
  assert(open[0] && /fixed lifetime/.test(open[0].body) && /in 6 days/.test(open[0].body), 'it explains use does not extend it, and when', open[0] && open[0].body);
  const p = pushed.find((x) => /expires/.test(x.title));
  assert(p && p.link && p.link.detail === 'runtime' && p.audience.kind === 'admins', 'admins are DM\'d, linked to Settings → Runtime', JSON.stringify(p && { link: p.link, audience: p.audience }));
  for (let h = 1; h <= 24; h++) run(RT - 6 * DAY + h * 3_600_000);
  assert(cards().length === 1, 'a day of hourly sweeps in the same band raises nothing more', String(cards().length));
}

console.log('\n\x1b[1m3) A restart does not re-alarm\x1b[0m');
{
  tm = mkTm(); hook();
  run(RT - 5 * DAY);
  assert(cards().length === 1, 'a fresh TerminalManager in the same band posts nothing (the guard is the audit trail)');
}

console.log('\n\x1b[1m4) Nearer bands supersede\x1b[0m');
{
  run(RT - 2 * DAY);
  let open = cards('open');
  assert(open.length === 1 && /3 days or less/.test(open[0].title), 'crossing into 3 days replaces the card', open.map((c) => c.title).join(' | '));
  run(RT - 0.4 * DAY);
  open = cards('open');
  assert(open.length === 1 && /within a day/.test(open[0].title), 'then into the last day', open.map((c) => c.title).join(' | '));
  run(RT + 3_600_000);
  open = cards('open');
  assert(open.length === 1 && /has expired/.test(open[0].title), 'and once it lapses, says it has expired', open.map((c) => c.title).join(' | '));
  assert(audits('runtime.login.expiring').map((a) => a.stage).join(',') === '7,3,1,0', 'each band is audited exactly once', audits('runtime.login.expiring').map((a) => a.stage).join(','));
}

console.log('\n\x1b[1m5) Signing in again closes it\x1b[0m');
{
  const fresh = RT + 30 * DAY;
  writeCred(BOX, fresh);
  const r = run(RT + 2 * 3_600_000);
  assert(r[0] && r[0].renewed === true, 'the renewal is noticed');
  assert(cards('open').length === 0, 'no open card remains');
  assert(audits('runtime.login.renewed').length === 1, 'recorded as runtime.login.renewed');
  run(RT + 3 * 3_600_000);
  assert(audits('runtime.login.renewed').length === 1, 'and recorded once, not every hour');
}

console.log('\n\x1b[1m6) Pool accounts are watched; disabled ones are not\x1b[0m');
{
  const dir = path.join(HOME, 'accounts', 'tools');
  writeCred(dir, T0 + 0.5 * DAY);
  aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'tools', kind: 'oauth', configDir: dir });
  const off = path.join(HOME, 'accounts', 'old');
  writeCred(off, T0 + 0.5 * DAY);
  aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'old', kind: 'oauth', configDir: off });
  aos.runtimeAccounts.setEnabled('claude-code', 'old', false);
  const r = run(T0);
  const t = r.find((x) => x.account === 'tools');
  assert(t && t.carded && t.stage === 1, 'an enabled pool account inside a day is carded', JSON.stringify(t));
  assert(!r.some((x) => x.account === 'old'), 'a disabled account is not watched');
  const c = cards('open').find((x) => /"tools"/.test(x.title));
  assert(c && /within a day/.test(c.title) && /Rotation will skip it/.test(c.body), 'its card names the account and what losing it means', c && c.title);
}

console.log('\n\x1b[1m7) A wiped login is left to the launch path\x1b[0m');
{
  const dir = path.join(HOME, 'accounts', 'wiped');
  fs.mkdirSync(dir, { recursive: true });
  // The exact shape a failed refresh leaves: tokens gone, expiresAt 0, the lapsed refresh expiry still stated.
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { expiresAt: 0, refreshTokenExpiresAt: T0 - DAY } }));
  aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'wiped', kind: 'oauth', configDir: dir });
  const before = cards().length;
  const r = run(T0);
  assert(!r.some((x) => x.account === 'wiped') && cards().length === before, 'no card — rotation\'s "signed out" card already says this');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
