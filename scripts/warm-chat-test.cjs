#!/usr/bin/env node
/* Warm chat sessions — a console chat turn goes to the LIVE pane by send-keys (no relaunch), falls back
 * to a cold in-place resume when the pane is gone, repairs a keystroke that never started a turn, and
 * keeps "working" honest now that a warm pane outlives the turn it answered.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-warm-chat-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

// ── stub backend: we control which panes are "alive" and record every effect ────────────────────
let livePanes = new Set();
const injected = [];          // send-keys deliveries  {tmux, text}
const spawned = [];           // runtime launches      {tmux}
const killed = [];            // panes torn down
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return livePanes.has(tmux); };
tm.backend.spawn = (_s, o) => { spawned.push({ tmux: o.tmuxName }); livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { killed.push(tmux); livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

const row = (id) => aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const audits = (id, type) => aos.db.prepare('SELECT data FROM audit_events WHERE run_id = ? AND type = ? ORDER BY ts').all(id, type).map((r) => JSON.parse(r.data));
let n = 0;
const mkChat = (o = {}) => {
  const id = 'ses_warm_' + (++n);
  const cols = {
    id, agent: 'agent-author', title: 'chat', task: 'hello', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 1, claude_session_id: 'cs-' + id, secret: 'sec', spawned_by: 'chat:m_alice',
    run_as: 'm_alice', busy_since: null, last_activity: Date.now(), created_at: Date.now(), updated_at: Date.now(), ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  return id;
};

console.log('\n\x1b[1m1) a live pane takes the turn warm — no relaunch\x1b[0m');
{
  const id = mkChat();
  livePanes.add('aos-' + id);
  const before = spawned.length;
  const r = tm.chatSend(id, 'and one more thing', 'm_alice');
  assert(r === 'sent', 'chatSend → sent');
  assert(injected.some((i) => i.tmux === 'aos-' + id && i.text === 'and one more thing'), 'delivered by send-keys');
  assert(spawned.length === before, 'NO runtime relaunch (this is the whole point)', `${spawned.length - before} spawns`);
  assert(audits(id, 'chat.turn').at(-1)?.mode === 'warm', 'audited mode:warm');
  assert(row(id).busy_since != null, 'busy_since set → the console shows "working"');
}

console.log('\x1b[1m\n2) no pane → cold in-place resume, still resident\x1b[0m');
{
  const id = mkChat({ status: 'stopped' });          // reaped while idle
  const before = spawned.length;
  const r = tm.chatSend(id, 'you there?', 'm_alice');
  assert(r === 'sent', 'chatSend → sent');
  assert(audits(id, 'chat.turn').at(-1)?.mode === 'cold', 'audited mode:cold');
  const after = row(id);
  assert(after.status === 'running', 'row back to running');
  assert(after.resident === 1 && after.headless === 0, 'relaunched RESIDENT — the next turn is warm again');
  assert(after.task === 'you there?', 'seeded with the message');
  // The launch is scheduled on the next tick (see launchAgentRuntime), so the pane does not exist yet…
  assert(spawned.length === before, 'launch deferred off the response path');
  // …and the session must still read as live meanwhile, or a fast second message would launch a rival
  // claude onto the same transcript.
  assert(tm.isAlive(id) === true, 'reported live while its launch is in flight');
}

console.log('\x1b[1m\n3) a report-ended chat (done row, live pane) still takes a warm turn\x1b[0m');
{
  const id = mkChat({ status: 'done' });
  livePanes.add('aos-' + id);
  const r = tm.chatSend(id, 'follow-up', 'm_alice');
  assert(r === 'sent', 'chatSend → sent');
  assert(audits(id, 'chat.turn').at(-1)?.mode === 'warm', 'warm — status was done, but claude is alive');
  assert(row(id).status === 'running', 'row flipped back to running');
}

console.log('\x1b[1m\n4) turn-end beacon keeps a warm session alive but stops "working"\x1b[0m');
{
  const id = mkChat({ busy_since: Date.now() });
  livePanes.add('aos-' + id);
  tm.markTurnIdle(id);
  assert(row(id).busy_since == null, 'busy_since cleared');
  assert(row(id).status === 'running', 'row still running');
  assert(!killed.includes('aos-' + id), 'pane NOT torn down (that is what makes the next turn warm)');
  assert(livePanes.has('aos-' + id), 'pane still alive');
  const listed = tm.listSessions().find((s) => s.id === id);
  assert(listed.alive === true && listed.working === false, 'alive:true + working:false — the honest pair');
}

console.log('\x1b[1m\n5) a turn in flight reports working; a dead pane never does\x1b[0m');
{
  const busyLive = mkChat({ busy_since: Date.now() });
  livePanes.add('aos-' + busyLive);
  const busyDead = mkChat({ busy_since: Date.now(), created_at: Date.now() - 60_000 });  // pane vanished mid-turn
  const list = tm.listSessions();
  assert(list.find((s) => s.id === busyLive).working === true, 'live + busy → working');
  assert(list.find((s) => s.id === busyDead).working === false, 'busy flag but no pane → NOT working (no perpetual spinner)');
}

console.log('\x1b[1m\n6) the idle reaper bounds the warm model\x1b[0m');
{
  aos.settings.setChatIdleTimeoutMinutes(30);
  const idle = mkChat({ last_activity: Date.now() - 60 * 60_000 });                       // quiet an hour
  const idleDone = mkChat({ status: 'done', last_activity: Date.now() - 60 * 60_000 });   // report-ended, pane still up
  const midTurn = mkChat({ last_activity: Date.now() - 60 * 60_000, busy_since: Date.now() - 60_000 }); // answering
  const fresh = mkChat({ last_activity: Date.now() });
  for (const id of [idle, idleDone, midTurn, fresh]) livePanes.add('aos-' + id);
  tm.reapIdleSessions();
  assert(row(idle).status === 'stopped', 'idle chat reaped — the pane goes back to the box');
  assert(row(idleDone).status === 'stopped', 'idle DONE chat reaped too (this pane used to leak forever)');
  assert(row(midTurn).status === 'running', 'a turn still generating is NOT killed mid-answer');
  assert(row(fresh).status === 'running', 'a fresh chat is left alone');
}

console.log('\x1b[1m\n7) a swallowed keystroke is repaired, not lost\x1b[0m');
{
  const id = mkChat();
  livePanes.add('aos-' + id);
  tm.chatSend(id, 'did this land?', 'm_alice');
  assert(audits(id, 'chat.turn').at(-1)?.mode === 'warm', 'delivered warm');
  // The transcript never grows (no real claude), so the confirmation check must call it unconfirmed and
  // relaunch cold with the same message. Drive it directly rather than waiting out the real timer.
  tm.warmChecks.get(id)?._onTimeout?.();
  assert(audits(id, 'chat.deliver.unconfirmed').length === 1, 'unconfirmed turn detected');
  assert(audits(id, 'chat.deliver.recovered').length === 1, 'recovered by relaunching cold');
  assert(audits(id, 'chat.turn').at(-1)?.mode === 'cold', 'the retry is a cold relaunch');
  assert(killed.includes('aos-' + id), 'the wedged pane was killed first — never two claudes on one transcript');
}

console.log('\x1b[1m\n8) a newer message cancels a stale confirmation\x1b[0m');
{
  const id = mkChat();
  livePanes.add('aos-' + id);
  tm.chatSend(id, 'first', 'm_alice');
  const stale = tm.warmChecks.get(id);
  tm.chatSend(id, 'second', 'm_alice');            // supersedes it
  stale?._onTimeout?.();
  assert(audits(id, 'chat.deliver.unconfirmed').length === 0, 'the superseded check does not fire a recovery');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
