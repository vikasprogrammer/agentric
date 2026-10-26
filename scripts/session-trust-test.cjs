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

  console.log('\n\x1b[1m3) draft-only / read-only session mode\x1b[0m');
  const { sessionModeDecision } = require(path.join(ROOT, 'dist/governance/session-mode.js'));
  const D = (mode, cap, tool, cmd, targets) => sessionModeDecision(mode, cap, tool, cmd || '', targets).effect;
  assert(D('normal', 'email.send') === 'allow', 'normal mode restricts nothing');
  const outward = [
    ['email.send', undefined, ''], ['repo.pr.create', undefined, ''],
    ['connector.call', 'mcp__composio__CLICKUP_CREATE_TASK_COMMENT', ''], ['connector.call', 'mcp__composio-company__GMAIL_REPLY_TO_THREAD', ''],
    ['connector.call', 'mcp__agentos__slack_send', ''], ['connector.call', 'mcp__agentos__discord_dm', ''],
    ['shell.exec', undefined, 'git push origin fix/x'], ['shell.exec', undefined, 'gh pr comment 12 --body "LGTM"'], ['shell.exec', undefined, 'gh pr create --fill'],
    ['shell.exec', undefined, "curl -X POST https://api.clickup.com/api/v2/task/1/comment -d '{}'"],
  ];
  for (const [cap, tool, cmd] of outward) assert(D('draft', cap, tool, cmd) === 'deny', `draft blocks ${tool || cmd || cap}`);
  const fine = [
    ['connector.call', 'mcp__composio__CLICKUP_GET_TASK', ''], ['connector.call', 'mcp__agentos__slack_reply', ''], ['connector.call', 'mcp__agentos__task_create', ''],
    ['shell.exec', undefined, 'gh pr view 12 --comments'], ['shell.exec', undefined, 'curl -s https://example.com/health'], ['shell.exec', undefined, 'git commit -m wip'],
    ['file.write', undefined, ''],
  ];
  for (const [cap, tool, cmd] of fine) assert(D('draft', cap, tool, cmd) === 'allow', `draft allows ${tool || cmd || cap}`);
  assert(D('readonly', 'file.write', undefined, '', ['/repo/app/x.php']) === 'deny', 'read-only blocks a code edit');
  assert(D('readonly', 'file.write', undefined, '', [require('os').tmpdir() + '/notes.md']) === 'allow', 'read-only allows a scratch note in the temp dir');
  for (const cmd of ['git commit -am fix', 'rm -rf build', "sed -i '' s/a/b/ x.php", 'npm install lodash', 'echo hi > src/x.ts', "mysql -e 'UPDATE users SET plan=1'"]) assert(D('readonly', 'shell.exec', undefined, cmd) === 'deny', `read-only blocks: ${cmd}`);
  for (const cmd of ['git log --oneline -5', 'grep -rn foo src', 'cat x | head > /tmp/out.txt', 'ls 2>/dev/null', 'git diff main...HEAD']) assert(D('readonly', 'shell.exec', undefined, cmd) === 'allow', `read-only allows: ${cmd}`);
  // through the real gate
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,spawned_by,run_as,created_at,updated_at) VALUES ('ses_mode','engineer','t','x','aos-ses_mode','running',0,0,'s',?,?,?,?)").run(alice.id, alice.id, Date.now(), Date.now());
  live.add('aos-ses_mode');
  const set = tm.setSessionMode('ses_mode', 'draft', { id: alice.id, email: alice.email, name: 'Alice' });
  assert(set.ok && tm.sessionMode('ses_mode') === 'draft', 'mode is stored');
  assert(typed.some((t) => t.tmux === 'aos-ses_mode' && /DRAFT-ONLY/.test(t.text)), 'the live agent is told in its pane');
  const g = tm.gate('ses_mode', 'engineer', 'connector.call', { tool: 'mcp__composio__CLICKUP_CREATE_TASK_COMMENT', input: { task_id: '1', comment_text: 'hi' } }, '');
  assert(g.decision === 'deny' && /DRAFT-ONLY/.test(g.reason || ''), 'the gate denies a ticket comment in a draft-only session', g);
  tm.setSessionMode('ses_mode', 'normal', { id: alice.id, email: alice.email });
  const g2 = tm.gate('ses_mode', 'engineer', 'connector.call', { tool: 'mcp__composio__CLICKUP_GET_TASK', input: { task_id: '1' } }, '');
  assert(g2.decision !== 'deny', 'back to normal: reads pass', g2);

  console.log('\n\x1b[1m4) /handoff\x1b[0m');
  tm.setSessionMode('ses_mode', 'readonly', { id: alice.id, email: alice.email });
  assert(!tm.handoffSession('ses_mode', 'too short', { by: 'engineer' }).ok, 'a note too short to act on is refused');
  const note = '- Goal: ship the MCP safety framework\n- Done: PR https://github.com/acme/app/pull/12 (branch feat/x)\n- Next: re-run QA on the head';
  const h = tm.handoffSession('ses_mode', note, { by: 'engineer' });
  assert(h.ok && h.sessionId && h.url, 'handoff opens a new session', h);
  const child = aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(h.sessionId);
  assert(child.agent === 'engineer' && child.run_as === alice.id, 'same agent, acting as the same person');
  assert(child.task.includes(note) && child.task.includes('ses_mode') && child.task.includes('x'), 'seeded with the note, a link back and the original request');
  assert(h.sessionId !== 'ses_mode' && child.claude_session_id === null, 'a FRESH conversation, not a resume of the old one');
  assert(child.mode === 'readonly', 'the working mode carries over');
  assert(tm.handoffChild('ses_mode') === h.sessionId, 'the console can find where the work went');
  assert(tm.supportsHandoffCommand('ses_mode') === true, 'claude-code sessions have the /handoff command');

  console.log('\n\x1b[1m5) who is speaking in a shared session\x1b[0m');
  const bob = aos.team.invite({ email: 'bob@example.com', role: 'member' }).member;
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,spawned_by,run_as,claude_session_id,created_at,updated_at) VALUES ('ses_shared','engineer','t','review PR 12','aos-ses_shared','running',0,0,'s',?,?,'cs-shared',?,?)").run(alice.id, alice.id, Date.now(), Date.now());
  live.add('aos-ses_shared');
  assert(tm.attributeTurn('ses_shared', 'hello') === null, 'no beacon → nothing attributed');
  tm.noteTyper('ses_shared', alice.id, 'terminal');
  assert(tm.attributeTurn('ses_shared', 'merge it') === null, 'the run-as member speaking → no extra context');
  assert(aos.db.prepare("SELECT speaker FROM term_sessions WHERE id='ses_shared'").get().speaker === alice.id, '…but the turn is attributed');
  tm.noteTyper('ses_shared', bob.id, 'terminal');
  const ctx = tm.attributeTurn('ses_shared', 'post the comment from my account');
  assert(typeof ctx === 'string' && /bob@example\.com/.test(ctx) && /started as/.test(ctx), 'a teammate speaking → the agent is told who it acts for', ctx);
  assert(aos.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type='turn.speaker' AND run_id='ses_shared'").get().n === 2, 'every attributed turn is audited turn.speaker');
  // GitHub follows the speaker when they have linked it
  assert(tm.githubMemberFor('ses_shared') === alice.id, 'speaker without a linked GitHub → run-as identity');
  gh.save(bob.id, { token: 'ghu_BOB', expiresAt: Date.now() + 8 * hour, login: 'bob', connectedAt: Date.now() });
  assert(tm.githubMemberFor('ses_shared') === bob.id, 'speaker with a linked GitHub → gh/git act as them');
  // a poke typed by the server right after someone pressed Enter is not that person speaking
  tm.noteTyper('ses_shared', alice.id, 'terminal');
  tm.injectToSession('ses_shared', '✅ Really done: qa finished the task you handed off', true, 'system');
  assert(tm.attributeTurn('ses_shared', '✅ Really done: qa finished the task you handed off') === null, 'a poke after an Enter is not attributed to the person');
  // composer text is server-typed on the person's behalf → attributed
  tm.noteTyper('ses_shared', bob.id, 'composer');
  tm.injectToSession('ses_shared', 'deploy it on staging', true, 'bob@example.com');
  assert(typeof tm.attributeTurn('ses_shared', 'deploy it on staging') === 'string', 'composer text sent by a teammate is attributed to them');
  // the hook turns { context } into claude's additionalContext
  {
    const srv2 = http.createServer((req, res) => { let d = ''; req.on('data', (c) => d += c).on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, context: '[Agentric] This message is from Bob.' })); }); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    const hr = await run('/bin/bash', [path.join(ROOT, 'terminal/lifecycle-hook.sh')], { ...process.env, AOS_URL: `http://127.0.0.1:${srv2.address().port}`, SESSION: 'ses_shared', AOS_SECRET: 's', AOS_TENANT: 'testco' }, JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }));
    let j = null; try { j = JSON.parse(hr.out); } catch {}
    assert(j && j.hookSpecificOutput && j.hookSpecificOutput.hookEventName === 'UserPromptSubmit' && /Bob/.test(j.hookSpecificOutput.additionalContext), 'the hook hands the context to claude as additionalContext', hr.out);
    srv2.close();
  }

  console.log('\n\x1b[1m6) waiting on\x1b[0m');
  aos.db.prepare("INSERT INTO tasks (id, tenant, title, status, assignee, caller_claude_id, created_by, updated_by, created_at, updated_at) VALUES ('tsk_qa', ?, 'QA: PR 12', 'doing', 'agent:qa', 'cs-shared', 'agent:engineer', 'agent:engineer', ?, ?)").run(aos.tenant, Date.now(), Date.now());
  aos.db.prepare("INSERT INTO tasks (id, tenant, title, status, assignee, caller_claude_id, created_by, updated_by, created_at, updated_at) VALUES ('tsk_old', ?, 'QA: PR 9', 'done', 'agent:qa', 'cs-shared', 'agent:engineer', 'agent:qa', ?, ?)").run(aos.tenant, Date.now() - 86400000, Date.now() - 86400000);
  const w = tm.waitingOn('ses_shared');
  assert(w.length === 1 && w[0].taskId === 'tsk_qa' && w[0].status === 'doing', 'open hand-offs from this conversation are listed; long-finished ones are not', w);

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}SESSION TRUST: ${pass}/${pass + fail} passed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(fakeBin, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
