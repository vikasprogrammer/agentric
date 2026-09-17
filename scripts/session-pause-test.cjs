#!/usr/bin/env node
/* Session PAUSE — suspend an agent (freeing its memory) without ending its run, then bring the same
 * conversation back.
 *
 * The feature is one status (`paused`) plus a promise: while a session holds it, NOTHING may give the
 * agent a process back except a deliberate resume. That promise is the whole test surface, because every
 * way it can break is silent — a Slack reply, a delegate finishing, a chat message or a stale browser tab
 * would each relaunch the agent and leave the row reading `paused` while its claude runs, which is
 * exactly the state the feature exists to make impossible.
 *
 * The other half is what a pause must NOT do. It is not an ending: no episode, no completion card, and a
 * status no roll-up scores — a paused run must not be graded `incomplete`, counted against the agent's
 * maturity, or archived by the stale-session tidy.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-pause-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

// ── stub backend: we control which panes are "alive" and record every effect ────────────────────
let livePanes = new Set();
// `launching` — not the backend's spawn list — is how we detect a relaunch: launchAgentRuntime stamps it
// SYNCHRONOUSLY and defers the actual spawn to a setImmediate, so counting spawns would make every
// "nothing relaunched" assertion below pass for the wrong reason.
const relaunching = (id) => tm.launching.has(id);
const killed = [];            // panes torn down
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux) => livePanes.has(tmux);
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { killed.push(tmux); livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

const row = (id) => aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const auditTypes = (id) => aos.db.prepare('SELECT type FROM audit_events WHERE run_id = ? ORDER BY ts').all(id).map((r) => r.type);

let n = 0;
/** A live claude-code session. `resumable` by construction: it has a pinned transcript id. */
const mkSession = (o = {}) => {
  const id = 'ses_pause_' + (++n);
  const cols = {
    id, agent: 'agent-author', title: 'run', task: 'do a thing', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claude_session_id: 'cs-' + id, secret: 'sec', spawned_by: 'm_alice',
    run_as: 'm_alice', busy_since: Date.now(), last_activity: Date.now(),
    created_at: Date.now(), updated_at: Date.now(), ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  livePanes.add(cols.tmux);
  return id;
};

console.log('\n\x1b[1m1) pausing kills the agent and keeps the run\x1b[0m');
{
  const id = mkSession();
  const r = tm.pauseSession(id, 'alice@example.com');
  assert(r.ok, 'pause succeeds on a live session');
  assert(!livePanes.has('aos-' + id), 'the pane (and with it the claude process) is killed');
  const after = row(id);
  assert(after.status === 'paused', `status is 'paused'`, after.status);
  assert(after.busy_since === null, 'busy_since is cleared — nothing is generating');
  assert(after.paused_by === 'alice@example.com', 'paused_by records who did it');
  assert(after.paused_at > 0, 'paused_at records when');
  assert(after.claude_session_id === 'cs-' + id, 'the conversation id survives — that is what resume replays');
  assert(auditTypes(id).includes('session.paused'), 'audited session.paused');
  // A pause is NOT an ending: an episode would tell Dreaming and the consolidator the run is over.
  assert(!auditTypes(id).includes('episode.stored'), 'no episode is written — the run is not over');
  const cards = aos.db.prepare("SELECT COUNT(*) c FROM messages WHERE session_id = ? AND type = 'completed'").get(id).c;
  assert(cards === 0, 'no completion card is posted');
  assert(tm.isPaused(id), 'isPaused() reports it');
  assert(!tm.reachable(id), 'reachable() refuses it — every keystroke path reads this');
}

console.log('\n\x1b[1m2) nothing may give a paused agent a process back\x1b[0m');
{
  const id = mkSession();
  tm.pauseSession(id, 'alice@example.com');
  // Each of these is a real wake path, and each would otherwise relaunch claude on the transcript.
  assert(tm.reviveResident(id, 'any news?') === false, 'a chat-thread reply (Slack/Discord/ClickUp/Telegram + DM continuity) is refused');
  assert(tm.chatSend(id, 'hello?') === 'paused', 'a console chat message reports paused rather than relaunching');
  assert(tm.deliverToResident(id, 'hi') === false, 'send-keys delivery is refused');
  assert(tm.injectToSession(id, 'hi', true, 'alice@example.com').ok === false, 'a Quick Shortcut inject is refused');
  assert(tm.takeoverRun(id, 'alice@example.com').ok === false, 'take-over is refused (it would resurrect it)');
  assert(tm.takeoverToTerminal(id, 'alice@example.com').ok === false, 'chat take-over is refused');
  assert(tm.reloadSession(id, 'alice@example.com').ok === false, 'reload is refused');

  assert(!relaunching(id), 'not one of them started a runtime launch');
  assert(row(id).status === 'paused', 'the row is still paused after all of it');
}

console.log('\n\x1b[1m3) a paused run holds no slot and is not counted as live\x1b[0m');
{
  const id = mkSession();
  const liveBefore = tm.aliveSessionCount();
  const admitBefore = tm.admissionSessionCount();
  tm.pauseSession(id, 'alice@example.com');
  assert(tm.aliveSessionCount() === liveBefore - 1, 'it stops counting toward the live-session count');
  assert(tm.admissionSessionCount() === admitBefore - 1, 'it releases its concurrency-cap work slot');
  assert(tm.runningSessionCount() === aos.db.prepare("SELECT COUNT(*) c FROM term_sessions WHERE status = 'running'").get().c,
    'the DB fallback count agrees');
}

console.log('\n\x1b[1m4) resuming brings the SAME conversation back\x1b[0m');
{
  const id = mkSession();
  tm.pauseSession(id, 'alice@example.com');
  const r = tm.resumeSession(id, 'alice@example.com');
  assert(r.ok, 'resume succeeds');
  assert(relaunching(id), 'a runtime launch is started — the agent gets its process back');
  const after = row(id);
  assert(after.status === 'running', 'the row is running again');
  assert(after.paused_at === null && after.paused_by === null, 'the paused stamp is cleared');
  assert(after.claude_session_id === 'cs-' + id, 'still the same conversation — context is restored from disk');
  assert(auditTypes(id).includes('session.unpaused'), 'audited session.unpaused');
  assert(!tm.isPaused(id), 'no longer paused');
  // Resume seeds no prompt, so an unattended run would have nothing to do and be idle-reaped within the
  // hour — the human who pressed Resume would watch it vanish. It comes back attended and claimed.
  assert(after.headless === 0 && after.claimed_by === 'alice@example.com', 'it comes back attended, claimed by whoever resumed it');
}

console.log('\n\x1b[1m5) a resident chat resumes resident, so its next message is warm\x1b[0m');
{
  const id = mkSession({ resident: 1, headless: 0, spawned_by: 'chat:agent-author' });
  tm.pauseSession(id, 'alice@example.com');
  tm.resumeSession(id, 'alice@example.com');
  assert(row(id).resident === 1, 'resident is preserved across the pause');
  assert(tm.reachable(id), 'and it is reachable again — a chat turn goes to the live pane');
}

console.log('\n\x1b[1m6) the edges of pause/resume themselves\x1b[0m');
{
  // Nothing to pause: no live agent means no memory to take away.
  const dead = mkSession({ status: 'stopped' });
  livePanes.delete('aos-' + dead);
  assert(tm.pauseSession(dead, 'alice@example.com').ok === false, 'a session with no live agent cannot be paused');

  // A run with no conversation cannot come back, so "pause" would be a one-way stop wearing the wrong word.
  const noConvo = mkSession({ claude_session_id: null });
  const r = tm.pauseSession(noConvo, 'alice@example.com');
  assert(r.ok === false && /stop it instead/.test(r.error || ''), 'a run with no resumable conversation is refused, and told to stop instead');
  assert(livePanes.has('aos-' + noConvo), 'and its pane is left alone — a refused pause kills nothing');

  const id = mkSession();
  assert(tm.resumeSession(id, 'alice@example.com').ok === false, 'resuming a session that is not paused is refused');
  tm.pauseSession(id, 'alice@example.com');
  assert(tm.pauseSession(id, 'alice@example.com').ok === true, 'pausing twice is idempotent, not an error');

  // Stop stays available on a paused run — "I'm not coming back" — and it ends it properly.
  tm.stopSession(id, 'alice@example.com');
  const after = row(id);
  assert(after.status === 'stopped', 'a paused session can still be stopped for good');
  assert(after.paused_at === null && after.paused_by === null, 'stopping clears the paused stamp rather than leaving it on the row forever');
  assert(tm.resumeSession(id, 'alice@example.com').ok === false, 'and it can no longer be resumed');
}

console.log('\n\x1b[1m7) no roll-up scores a paused run\x1b[0m');
{
  const id = mkSession();
  tm.pauseSession(id, 'alice@example.com');
  // The outcome roll-up: `paused` must be excluded with `running`, or the only branch it could reach
  // stamps it 'incomplete'/'stopped-midway' — the opposite of what the status means.
  const src = fs.readFileSync(path.join(ROOT, 'src/edge/outcome.ts'), 'utf8');
  assert(/status NOT IN \('running','paused'\)/.test(src), 'outcome.ts excludes paused rows from scoring');
  // The maturity roll-up: paused counts as in-flight, never as a finished or a stopped run.
  const stats = fs.readFileSync(path.join(ROOT, 'src/state/agent-stats.ts'), 'utf8');
  assert(/r\.status === 'running' \|\| r\.status === 'paused'/.test(stats), 'agent-stats counts paused as in-flight');
  // The stale-session tidy + the "ended recently" feed count both enumerate statuses, so paused is
  // excluded by construction — pin it, because adding it there would archive a live conversation.
  for (const [file, label] of [['src/edge/session-tidy.ts', 'the stale-session tidy'], ['src/edge/improvements.ts', 'the declutter tile']]) {
    const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert(!/IN \('stopped','crashed','paused'\)/.test(s) && !/'paused'/.test(s), `${label} never archives a paused session`);
  }
}

console.log('\n\x1b[1m8) a delegate finishing must not resume a paused caller\x1b[0m');
{
  // The wake-up resume lane does not type into a session — it starts a FRESH claude on the transcript,
  // which is the pause being undone by a delegate completing its work. The news must WAIT, not be lost.
  const src = fs.readFileSync(path.join(ROOT, 'src/edge/wakeups.ts'), 'utf8');
  assert(/pausedTranscript\(newest\.transcript\)/.test(src), 'the resume lane checks for a paused caller');
  assert(/status = 'paused'/.test(src), 'and it matches on the paused status');
  const guard = src.slice(src.indexOf('pausedTranscript(newest.transcript)'));
  assert(/this\.bump\(pending\)/.test(guard.slice(0, 300)) && /queued: true/.test(guard.slice(0, 400)),
    'the wake-up stays QUEUED for the resume rather than being dropped');
}

console.log('\n\x1b[1m9) the browser terminal cannot attach to a paused session\x1b[0m');
{
  // The ttyd WebSocket authz is the enforcement point: a direct terminal URL (a tab left open, a pasted
  // link) never passes through /api/sessions/:id/attach.
  const src = fs.readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8');
  const authz = src.slice(src.indexOf('function sharedTerminalAuthz'), src.indexOf('function sharedTerminalAuthz') + 1200);
  assert(/if \(tm\.isPaused\(id\)\) return false/.test(authz), 'sharedTerminalAuthz refuses a paused session id');
  assert(/this session is paused — resume it to use its terminal/.test(src), 'and the attach route says so in words');
  // The generic /resume route only lifts the stay-stopped sentinel; used on a paused row it would
  // resurrect the agent by the back door and leave the status lying.
  assert(/use resume \(unpause\) instead/.test(src), 'the stop-block /resume route refuses a paused session');
}

console.log('\n\x1b[1m10) end to end over real HTTP — the routes, the gate and the attach refusal\x1b[0m');
(async () => {
  // A second, registry-backed runtime on an ephemeral port: this is the only way to prove the routes are
  // WIRED (a handler that isn't reached 404s, then falls through to the login gate as a 401 — the
  // stale-server symptom that reads as an auth bug) and that the authz layer sits in front of them.
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: haos, tm: htm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let live = new Set();
  htm.backend.aliveNames = () => new Set(live);
  htm.backend.kill = (_s, tmux) => { live.delete(tmux); };
  htm.backend.spawn = (_s, o) => { live.add(o.tmuxName); };
  htm.backend.capturePane = () => '';
  htm.backend.hasClient = () => false;
  // The launch credential pre-flight reads the BOX's real login (~/.claude). This harness resumes over HTTP
  // and then awaits, so the deferred launch has run by the time we look — on a box whose default login has
  // no refresh token (every Linux deploy box) the resume is refused and the row reads `crashed`. That's the
  // pre-flight working, not pause; keep the test about pause.
  htm.assertCredentialsUsable = () => true;

  const post = (u, cookie) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: '{}' });

  // Unauthenticated: 401 means ROUTED and login-gated. A 404 would mean the route isn't there at all.
  assert((await post('/api/sessions/ses_nope/pause')).status === 401, 'POST /pause is routed and login-gated');
  assert((await post('/api/sessions/ses_nope/unpause')).status === 401, 'POST /unpause is routed and login-gated');

  const owner = haos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${haos.team.createSession(owner.id)}`;
  const sid = 'ses_http_pause';
  haos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',0,0,?,?,?,?,?,?)`)
    .run(sid, 'agent-author', 'run', 'task', 'aos-' + sid, 'cs-http', 'sec', owner.id, owner.id, Date.now(), Date.now());
  live.add('aos-' + sid);

  const paused = await post(`/api/sessions/${sid}/pause`, cookie).then((r) => r.json());
  assert(paused.ok === true, 'an authenticated owner can pause it over HTTP', paused);
  assert(haos.db.prepare('SELECT status FROM term_sessions WHERE id = ?').get(sid).status === 'paused', 'the row is paused');

  // The browser terminal must be refused while paused — this is the "readable, never usable" half.
  const attach = await fetch(base + `/api/sessions/${sid}/attach`, { headers: { cookie } });
  assert(attach.status === 409, 'GET /attach refuses a paused session (409)', attach.status);
  // …and the stop-block /resume route must not become a back door that resurrects it.
  assert((await post(`/api/sessions/${sid}/resume`, cookie)).status === 400, 'POST /resume refuses a paused session');
  // Take over would resurrect it too.
  assert((await post(`/api/sessions/${sid}/interactive`, cookie)).status === 400, 'POST /interactive refuses a paused session');
  // The transcript stays readable — that is what "see it by scrolling" means.
  assert((await fetch(base + `/api/sessions/${sid}/conversation`, { headers: { cookie } })).status === 200, 'the conversation is still readable while paused');

  const back = await post(`/api/sessions/${sid}/unpause`, cookie).then((r) => r.json());
  assert(back.ok === true, 'unpause succeeds over HTTP', back);
  assert(haos.db.prepare('SELECT status FROM term_sessions WHERE id = ?').get(sid).status === 'running', 'and the row is running again');

  server.close();
  try { registry.stopAll(); } catch { /* best effort */ }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
})();
