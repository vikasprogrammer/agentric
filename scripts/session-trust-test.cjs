#!/usr/bin/env node
/* Session trust (fleet chat mining, 2026-10-26, round 2):
 *  1) ONE claude per conversation — a resume of a transcript a live pane holds is typed into that pane;
 *  2) live GitHub token — the `gh` shim and git credential helper fetch the member's CURRENT token from
 *     the server on every call (executed for real against a fake server + a fake `gh`), and a refresh never
 *     rotates a token another session refreshed moments ago.
 * Isolated home; tmux stubbed. */
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-session-trust-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco'; process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { GithubIdentity } = require(path.join(ROOT, 'dist/edge/github-identity.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const live = new Set(); const typed = [];
tm.backend.aliveNames = () => new Set(live);
tm.backend.injectText = (_s, tmux, text) => { typed.push({ tmux, text }); return live.has(tmux); };
tm.backend.spawn = (_s, o) => { live.add(o.tmuxName); };
tm.backend.kill = (_s, t) => { live.delete(t); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;
const alice = aos.team.listMembers()[0] || aos.team.invite({ email: 'alice@example.com', role: 'owner' }).member;

const run = (cmd, args, env, stdin) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env });
  let out = '', err = ''; p.stdout.on('data', (c) => out += c); p.stderr.on('data', (c) => err += c);
  p.on('close', (code) => resolve({ code, out, err }));
  if (stdin !== undefined) p.stdin.end(stdin); else p.stdin.end();
});

(async () => {
  console.log('\n\x1b[1m1) one claude per conversation\x1b[0m');
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,created_at,updated_at) VALUES ('ses_hold','engineer','drain','drain the box','aos-ses_hold','running',0,0,'cs-drain','s',?,?,?,?)").run(alice.id, alice.id, Date.now(), Date.now());
  live.add('aos-ses_hold');
  const before = aos.db.prepare('SELECT COUNT(*) n FROM term_sessions').get().n;
  const s = tm.createSession('engineer', 'check the drain', 'Check the drain runner again.', 'automation:au_once', true, undefined, undefined, alice.id, 'cs-drain');
  assert(s.id === 'ses_hold', 'a resume of a live transcript returns the session that holds it', s.id);
  assert(aos.db.prepare('SELECT COUNT(*) n FROM term_sessions').get().n === before, 'no second session row (no second claude)');
  assert(typed.some((t) => t.tmux === 'aos-ses_hold' && t.text === 'Check the drain runner again.'), 'the request was typed into the live pane');
  assert(aos.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type='session.resume.redirected'").get().n === 1, 'audited session.resume.redirected');
  live.delete('aos-ses_hold');
  aos.db.prepare("UPDATE term_sessions SET status='done' WHERE id='ses_hold'").run();
  const s2 = tm.createSession('engineer', 'check again', 'Check again.', 'automation:au_once', true, undefined, undefined, alice.id, 'cs-drain');
  assert(s2.id !== 'ses_hold', 'once nothing holds the transcript, a resume starts a new run as before', s2.id);

  console.log('\n\x1b[1m2) live GitHub token\x1b[0m');
  const gh = new GithubIdentity(aos);
  const hour = 3_600_000;
  gh.save(alice.id, { token: 'ghu_LAUNCH', refreshToken: 'ghr_x', expiresAt: Date.now() + 8 * hour, login: 'alice', connectedAt: Date.now() });
  // fake `gh` that prints the token it received
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-fake-gh-'));
  fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\necho "GH_TOKEN=$GH_TOKEN ARGS=$*"\n', { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${fakeBin}:${oldPath}`;
  const env = {};
  const ok = tm.installLiveGithub(env, 'engineer', alice.id, 'ses_live');
  process.env.PATH = oldPath;
  assert(ok && env.AOS_SHIM_DIR && fs.existsSync(path.join(env.AOS_SHIM_DIR, 'gh')), 'a linked member gets a gh shim on PATH', env);
  let served = 'ghu_CURRENT';
  const srv = http.createServer((req, res) => { let d = ''; req.on('data', (c) => d += c).on('end', () => { res.setHeader('content-type', 'application/json'); res.end(served ? JSON.stringify({ status: 'ok', token: served }) : JSON.stringify({ status: 'none' })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = { PATH: `${env.AOS_SHIM_DIR}:${fakeBin}:/usr/bin:/bin`, AOS_URL: `http://127.0.0.1:${srv.address().port}`, AOS_SECRET: 's', AOS_TENANT: 'testco', SESSION: 'ses_live', GH_TOKEN: 'ghu_LAUNCH' };
  let r = await run('/bin/sh', ['-c', 'gh pr view 12'], base);
  assert(/GH_TOKEN=ghu_CURRENT ARGS=pr view 12/.test(r.out), 'gh runs with the CURRENT token, not the launch one', r.out + r.err);
  served = '';
  r = await run('/bin/sh', ['-c', 'gh pr view 12'], base);
  assert(/GH_TOKEN=ghu_LAUNCH/.test(r.out), 'server says none → falls back to the launch token', r.out);
  r = await run('/bin/sh', ['-c', 'gh api user'], { ...base, AOS_URL: 'http://127.0.0.1:1' });
  assert(/GH_TOKEN=ghu_LAUNCH/.test(r.out), 'server unreachable → falls back to the launch token', r.out);

  // git credential helper, executed by real git
  const genv = { GH_TOKEN: 'ghu_LAUNCH' };
  tm.configureGitCredentials(genv, { live: true });
  served = 'ghu_CURRENT';
  const gitEnv = { ...base, ...genv, HOME, GIT_TERMINAL_PROMPT: '0' };
  r = await run('git', ['credential', 'fill'], gitEnv, 'protocol=https\nhost=github.com\npath=acme/app.git\n\n');
  assert(/password=ghu_CURRENT/.test(r.out) && /username=x-access-token/.test(r.out), 'git gets the CURRENT token from the helper', r.out + r.err);
  served = '';
  r = await run('git', ['credential', 'fill'], gitEnv, 'protocol=https\nhost=github.com\n\n');
  assert(/password=ghu_LAUNCH/.test(r.out), 'git falls back to $GH_TOKEN when the server has none', r.out + r.err);
  srv.close();

  // a token another session refreshed in the last hour is not rotated again
  const fr = await gh.forceRefresh(alice.id);
  assert(fr.status === 'ok' && fr.refreshed === false && fr.blob.token === 'ghu_LAUNCH', 'forceRefresh hands back a just-minted token instead of rotating it', fr);
  assert(tm.installLiveGithub({}, 'engineer', undefined, 'ses_x') === false, 'no run-as member → no shim');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}SESSION TRUST: ${pass}/${pass + fail} passed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(fakeBin, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
