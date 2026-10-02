#!/usr/bin/env node
/* A signed-out pool account is skipped by rotation, not handed out to be refused.
 *
 * Why this exists — instapods, 2026-09-26 → 10-02: the `tools2-new` account's refresh token expired and
 * Claude Code wiped its Keychain record down to `expiresAt: 0`. `pick()` only knew `enabled`/`status`, so
 * least-recently-used rotation kept handing it out every other launch; the launch pre-flight then refused
 * each of those runs — 53 in a week — and re-raised "Agent runs are blocked … Review it on Settings →
 * Updates" every half hour, while the healthy `tools` account sat idle half the time.
 *
 * Pinned here:
 *  1. a dead credential-dir account is never selected while a healthy one exists — no refusals;
 *  2. the skip is audited, badged on the account, and raises ONE admin card (linked to Settings →
 *     Runtime, not Updates);
 *  3. a pool with nothing alive falls back to the box default (no CLAUDE_CONFIG_DIR) as an empty pool does;
 *  4. signing the account back in returns it to rotation with no other step, and retires its card;
 *  5. the summarizer's out-of-band pick skips it too;
 *  6. `pick({ exclude: [...] })` takes a list.
 *
 * File-based credentials (`.credentials.json`) so this runs identically on a Linux CI box. Isolated home;
 * nothing is launched. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-pool-signed-out-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.HOME = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
tm.backend.kill = () => {};
tm.backend.hasClient = () => false;
tm.backend.aliveNames = () => new Set();
const pushed = [];
tm.reviewNotifier = (n) => pushed.push(n);

const DAY = 86_400_000;
const GOOD = () => JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-x', expiresAt: Date.now() + DAY } });
// The exact shape the live record was left in: tokens gone, `expiresAt: 0`, a lapsed refresh expiry.
const DEAD = JSON.stringify({ claudeAiOauth: { expiresAt: 0, refreshTokenExpiresAt: Date.now() - 6 * DAY, scopes: ['user:inference'], subscriptionType: 'max' } });

const addAccount = (name, cred) => {
  const dir = path.join(HOME, 'accounts', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), cred);
  aos.runtimeAccounts.add({ runtime: 'claude-code', name, kind: 'oauth', configDir: dir });
  return dir;
};

let n = 0;
const mkSession = () => {
  const id = 'ts_' + (++n);
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',1,0,'m_alice',?,?)")
    .run(id, 'support-ops', 't', 'x', 'aos-' + id, Date.now(), Date.now());
  return id;
};
const launchEnv = () => {
  const id = mkSession();
  const env = {};
  tm.applyRuntimeAccount(env, id, 'support-ops', 'claude-code', false);
  return { id, env };
};
const audits = (type) => aos.db.prepare('SELECT data FROM audit_events WHERE type=?').all(type).map((r) => JSON.parse(r.data));
const signedOutCards = (status) => aos.db.prepare("SELECT * FROM messages WHERE session_id LIKE 'system:runtime-account-signed-out:%'" + (status ? ' AND status=?' : '')).all(...(status ? [status] : []));

const deadDir = addAccount('tools2-new', DEAD);
const liveDir = addAccount('tools', GOOD());

console.log('\n\x1b[1m1) Rotation never hands out the signed-out account\x1b[0m');
{
  const dirs = [];
  for (let i = 0; i < 6; i++) dirs.push(launchEnv().env.CLAUDE_CONFIG_DIR);
  assert(dirs.every((d) => d === liveDir), 'six launches in a row all run on the healthy account', JSON.stringify(dirs.map((d) => d && path.basename(d))));
  const selected = audits('runtime.account.selected').map((a) => a.account);
  assert(!selected.includes('tools2-new'), 'the dead account is never recorded as selected');
  assert(audits('session.launch.refused').length === 0, 'and no run is refused');
}

console.log('\n\x1b[1m2) The skip is visible — audited, badged, one card\x1b[0m');
{
  const skipped = audits('runtime.account.skipped');
  assert(skipped.length > 0 && skipped.every((s) => s.account === 'tools2-new' && s.expiredAt === 0), 'audited as runtime.account.skipped with the expiry it saw', JSON.stringify(skipped[0]));
  const acct = aos.runtimeAccounts.list().find((a) => a.name === 'tools2-new');
  assert(acct && acct.enabled, 'the account is NOT disabled — signing it back in must be the only step');
  const row = aos.db.prepare("SELECT check_ok, check_note FROM runtime_accounts WHERE name='tools2-new'").get();
  assert(row.check_ok === 0 && /signed out/.test(row.check_note), 'Settings → Runtime badges it as signed out', row.check_note);
  const cards = signedOutCards('open');
  assert(cards.length === 1, 'exactly one admin card across all those launches', String(cards.length));
  assert(cards[0] && /tools2-new/.test(cards[0].title) && /skipping/.test(cards[0].title), 'the card names the account and says it is being skipped', cards[0] && cards[0].title);
  assert(cards[0] && cards[0].body.includes(`CLAUDE_CONFIG_DIR=${deadDir} claude /login`), 'the card carries the exact re-login command');
  assert(cards[0] && !/1970/.test(cards[0].body), 'expiresAt: 0 never renders as a 1970 date');
  const push = pushed.find((p) => /tools2-new/.test(p.title));
  assert(push && push.link && push.link.detail === 'runtime', 'its DM links to Settings → Runtime, not Settings → Updates', JSON.stringify(push && push.link));
}

console.log('\n\x1b[1m3) Nothing alive in the pool → the box default, as with an empty pool\x1b[0m');
{
  fs.writeFileSync(path.join(liveDir, '.credentials.json'), DEAD);
  const { env } = launchEnv();
  assert(!env.CLAUDE_CONFIG_DIR, 'no pool dir is exported — the launch falls through to the box default', env.CLAUDE_CONFIG_DIR);
  fs.writeFileSync(path.join(liveDir, '.credentials.json'), GOOD());
}

console.log('\n\x1b[1m4) Signing it back in returns it to rotation and retires the card\x1b[0m');
{
  fs.writeFileSync(path.join(deadDir, '.credentials.json'), GOOD());
  const dirs = [];
  for (let i = 0; i < 4; i++) dirs.push(launchEnv().env.CLAUDE_CONFIG_DIR);
  assert(dirs.includes(deadDir) && dirs.includes(liveDir), 'both accounts rotate again', JSON.stringify(dirs.map((d) => d && path.basename(d))));
  assert(signedOutCards('open').length === 0, 'its signed-out card is closed');
}

console.log('\n\x1b[1m5) The summarizer\'s out-of-band pick skips it too\x1b[0m');
{
  fs.writeFileSync(path.join(deadDir, '.credentials.json'), DEAD);
  const picks = [];
  for (let i = 0; i < 4; i++) { const r = tm.outOfBandCredentialEnv('claude-code'); picks.push(r && r.account); }
  assert(picks.every((a) => a === 'tools'), 'every out-of-band call lands on the healthy account', JSON.stringify(picks));
}

console.log('\n\x1b[1m6) pick() takes an exclusion list\x1b[0m');
{
  addAccount('spare', GOOD());
  const a = aos.runtimeAccounts.pick('claude-code', Date.now(), { exclude: ['tools', 'tools2-new'] });
  assert(a && a.name === 'spare', 'a list excludes every name in it', a && a.name);
  const b = aos.runtimeAccounts.pick('claude-code', Date.now(), { exclude: ['tools', 'tools2-new', 'spare'] });
  assert(b === null, 'excluding everything is an honest null');
  const c = aos.runtimeAccounts.pick('claude-code', Date.now(), { exclude: 'spare' });
  assert(c && c.name !== 'spare', 'a single name still works');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
