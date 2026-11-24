#!/usr/bin/env node
/* Direct messages (console "Messages") — one durable room per (member, agent) whose session is
 * plumbing: a turn folds into ONE agent message with its tool calls tucked into steps, human text is
 * never read back out of the transcript, and a dead/oversized session is replaced without the
 * conversation changing.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dm-test-')));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'claude');
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { DirectMessages } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
let livePanes = new Set();
const injected = [], spawned = [];
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return livePanes.has(tmux); };
tm.backend.spawn = (_s, o) => { spawned.push(o.tmuxName); livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

const dms = new DirectMessages(aos, tm);
const alice = aos.team.invite({ email: 'alice@example.com', role: 'admin' }).member;
const bob = aos.team.invite({ email: 'bob@example.com', role: 'member' }).member;
const AGENT = 'agent-author';

const row = (id) => aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const projects = path.join(HOME, 'claude', 'projects', 'p');
fs.mkdirSync(projects, { recursive: true });
let clock = Date.now();
const write = (sessionId, lines) => {
  const file = path.join(projects, `${row(sessionId).claude_session_id}.jsonl`);
  fs.appendFileSync(file, lines.map((l) => JSON.stringify({ ...l, timestamp: new Date(clock += 1000).toISOString() })).join('\n') + '\n');
};
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const setWorking = (id, on) => {
  aos.db.prepare('UPDATE term_sessions SET busy_since = ?, last_activity = ? WHERE id = ?').run(on ? Date.now() : null, on ? Date.now() - 5 : Date.now(), id);
  // A finished turn's transcript has gone quiet — age the file so the settle window has passed.
  if (!on) { const f = path.join(projects, `${row(id).claude_session_id}.jsonl`); if (fs.existsSync(f)) { const t = new Date(Date.now() - 10_000 - (aged++)); fs.utimesSync(f, t, t); } }
};
let aged = 0;

// A launch is scheduled, not synchronous — let it land before asserting on the pane.
const settle = () => new Promise((r) => setTimeout(r, 400));

(async () => {
console.log('\n\x1b[1m1) contacts: add, list, permission\x1b[0m');
{
  assert(dms.list(alice).contacts.length === 0, 'no contacts to begin with');
  assert(dms.list(alice).directory.some((a) => a.id === AGENT), 'the agent is in the directory');
  aos.chatRooms.ensureDm(alice.id, AGENT);
  const l = dms.list(alice);
  assert(l.contacts.length === 1 && l.contacts[0].agent === AGENT && l.contacts[0].presence === 'away', 'added contact is listed, away (no session yet)');
  assert(!l.directory.some((a) => a.id === AGENT), 'and leaves the directory');
  assert(typeof dms.canChat(bob, AGENT) === 'string', 'an unassigned member cannot DM the agent');
  assert(dms.send(bob, AGENT, 'hi').ok === false, 'nor send to it');
}

let s1;
console.log('\n\x1b[1m2) first message starts a hidden session; the turn folds into ONE reply\x1b[0m');
{
  const r = dms.send(alice, AGENT, 'what is on the board?');
  assert(r.ok && r.message.authorKind === 'member', 'send → ok, my message stored');
  s1 = r.sessionId;
  await settle();
  const sr = row(s1);
  assert(sr.resident === 1 && sr.spawned_by === `chat:${alice.id}` && sr.run_as === alice.id, 'resident session, provenance chat:<me>, run-as me');
  assert(/direct-message conversation/.test(sr.task) && /what is on the board\?/.test(sr.task), 'opening prompt frames the DM and carries the message');
  setWorking(s1, true);
  write(s1, [user(sr.task), say('Let me look at the board.'), tool('t1', 'Bash', { command: 'ls' })]);
  let t = dms.thread(alice, AGENT);
  assert(t.messages.length === 1 && t.typing && t.presence === 'working', 'mid-turn: only my message + a typing indicator', JSON.stringify(t.typing));
  assert(t.typing.steps.length === 2, 'typing carries the live steps');
  write(s1, [result('t1'), say('Three tasks are open: A, B and C.'), tool('t2', 'mcp__agentos__report', { summary: 'x' }), result('t2')]);
  setWorking(s1, false);
  t = dms.thread(alice, AGENT);
  const reply = t.messages[t.messages.length - 1];
  assert(t.messages.length === 2 && reply.authorKind === 'agent' && reply.body === 'Three tasks are open: A, B and C.', 'turn end → one agent message = its last prose', JSON.stringify(t.messages.map((m) => m.body)));
  assert(reply.steps && reply.steps.length === 3 && reply.steps[0].t === 'say' && reply.steps[1].t === 'do', 'narration + tool calls kept as steps');
  assert(!t.typing && t.presence === 'online', 'typing cleared; warm pane = online');
  assert(!t.messages.some((m) => /direct-message conversation/.test(m.body)), 'the opening prompt never appears as a message');
  assert(tm.listSessions().find((s) => s.id === s1).dm === true, 'the session is flagged dm (hidden from the Sessions lists)');
  assert(dms.thread(alice, AGENT).messages.length === 2, 're-sync is idempotent');
}

console.log('\n\x1b[1m3) unread + previews\x1b[0m');
{
  let c = dms.list(alice).contacts[0];
  assert(c.unread === 1 && /Three tasks/.test(c.lastText) && c.lastFromMe === false, 'one unread, preview is the reply');
  dms.thread(alice, AGENT, { read: true });
  c = dms.list(alice).contacts[0];
  assert(c.unread === 0, 'opening the thread marks it read');
}

console.log('\n\x1b[1m4) follow-up goes to the SAME session; injected user text is not a message\x1b[0m');
{
  const before = spawned.length;
  const r = dms.send(alice, AGENT, 'close A please');
  assert(r.ok && r.sessionId === s1 && spawned.length === before, 'delivered warm into the same session, no new launch');
  assert(injected.some((i) => i.text === 'close A please'), 'typed into the pane');
  setWorking(s1, true);
  write(s1, [user('close A please'), say('Closing A.'), user('<system-reminder>harness noise</system-reminder>'), say('Done — A is closed.')]);
  setWorking(s1, false);
  const t = dms.thread(alice, AGENT);
  const bodies = t.messages.map((m) => `${m.authorKind}:${m.body}`);
  assert(bodies.filter((b) => b.startsWith('member:')).length === 2, 'exactly my two messages on the human side', bodies.join(' | '));
  assert(!bodies.some((b) => /harness noise/.test(b)), 'harness-injected text never shows');
  assert(bodies[bodies.length - 1] === 'agent:Done — A is closed.', 'latest reply is last');
  assert(t.messages.every((m, i) => i === 0 || m.seq > t.messages[i - 1].seq), 'messages ordered');
  assert(dms.thread(alice, AGENT, { after: t.messages[1].seq }).messages.length === t.messages.length - 2, '`after` cursor returns only newer messages');
}

console.log('\n\x1b[1m5) a reaped session is resumed in place; a lost one is replaced with a recap\x1b[0m');
{
  livePanes.clear();
  assert(dms.list(alice).contacts[0].presence === 'away', 'pane gone → away');
  const before = spawned.length;
  const r = dms.send(alice, AGENT, 'still there?');
  await settle();
  assert(r.ok && r.sessionId === s1 && spawned.length === before + 1, 'cold resume of the same session');
  aos.db.prepare('DELETE FROM term_sessions WHERE id = ?').run(s1);
  const r2 = dms.send(alice, AGENT, 'and now?');
  assert(r2.ok && r2.sessionId !== s1, 'session row gone → a new session behind the same room');
  const task = row(r2.sessionId).task;
  assert(/Earlier in this conversation/.test(task) && /Done — A is closed\./.test(task) && /and now\?/.test(task), 'new session is seeded with the recent conversation');
  const t = dms.thread(alice, AGENT);
  assert(t.messages.filter((m) => m.authorKind === 'member').length === 4 && t.roomId === dms.list(alice).contacts[0].roomId, 'history is continuous across the swap');
  setWorking(r2.sessionId, true);
  write(r2.sessionId, [user(task), say('Yes, still here.')]);
  setWorking(r2.sessionId, false);
  assert(dms.thread(alice, AGENT).messages.slice(-1)[0].body === 'Yes, still here.', 'the new session syncs from turn 0');
}

console.log('\n\x1b[1m6) reset + remove contact keep history\x1b[0m');
{
  const n = dms.thread(alice, AGENT).messages.length;
  dms.reset(alice, AGENT);
  assert(aos.chatRooms.dm(alice.id, AGENT).sessionId === null && dms.thread(alice, AGENT).messages.length === n, 'reset drops the session, keeps messages');
  aos.chatRooms.hide(aos.chatRooms.dm(alice.id, AGENT).id);
  assert(dms.list(alice).contacts.length === 0 && dms.list(alice).directory.some((a) => a.id === AGENT), 'removed contact returns to the directory');
  aos.chatRooms.ensureDm(alice.id, AGENT);
  assert(dms.thread(alice, AGENT).messages.length === n, 're-adding picks the conversation back up');
}

console.log('\n\x1b[1m6b) `working` reading false mid-turn does not cut a reply in half\x1b[0m');
{
  const r = dms.send(alice, AGENT, 'check the logs');
  await settle();
  const id = r.sessionId;
  aos.db.prepare('UPDATE term_sessions SET busy_since = NULL WHERE id = ?').run(id); // the flag lies; the file is fresh
  write(id, [user('check the logs'), say('Looking now.'), tool('t9', 'Bash', { command: 'tail log' })]);
  let t = dms.thread(alice, AGENT);
  assert(t.messages.slice(-1)[0].authorKind === 'member' && !!t.typing, 'fresh transcript + not-working → still typing, nothing folded');
  write(id, [result('t9'), say('Logs are clean.')]);
  setWorking(id, false);
  t = dms.thread(alice, AGENT);
  const last = t.messages.slice(-1)[0];
  assert(last.body === 'Logs are clean.' && last.steps && last.steps.length === 2, 'once quiet: ONE message, interim note + tool call as its steps', JSON.stringify(last));
}

console.log('\n\x1b[1m7) a session that died before answering: stalled → retry replaces it, no duplicate\x1b[0m');
{
  dms.reset(alice, AGENT); // a brand-new session, so there is no transcript to fall back on
  const r = dms.send(alice, AGENT, 'are you there?');
  await settle();
  const dead = r.sessionId;
  livePanes.clear();
  aos.db.prepare("UPDATE term_sessions SET status = 'crashed', busy_since = NULL WHERE id = ?").run(dead);
  aos.db.prepare('UPDATE chat_messages SET created_at = created_at - 60000 WHERE seq = ?').run(r.message.seq);
  const t = dms.thread(alice, AGENT);
  assert(t.stalled === true, 'no transcript, no pane, no reply → stalled');
  const n = t.messages.length;
  const again = dms.send(alice, AGENT, '', { retry: true });
  assert(again.ok && again.sessionId !== dead, 'retry starts a new session (nothing to resume in the dead one)');
  assert(dms.thread(alice, AGENT).messages.length === n, 'and does not post the message twice');
  const task = row(again.sessionId).task;
  assert((task.match(/are you there\?/g) || []).length === 1, 'the retried message appears once in the new prompt');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* scratch */ }
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
})();
