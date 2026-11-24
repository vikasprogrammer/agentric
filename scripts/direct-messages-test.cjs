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
  assert(aos.chatRooms.dm(alice.id, AGENT).sessionId === null && dms.thread(alice, AGENT).messages.length === n + 1, 'reset drops the session, keeps messages (+ a marker)');
  aos.chatRooms.hide(aos.chatRooms.dm(alice.id, AGENT).id);
  assert(dms.list(alice).contacts.length === 0 && dms.list(alice).directory.some((a) => a.id === AGENT), 'removed contact returns to the directory');
  aos.chatRooms.ensureDm(alice.id, AGENT);
  assert(dms.thread(alice, AGENT).messages.length === n + 1, 're-adding picks the conversation back up');
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

console.log('\n\x1b[1m8) /new starts a new session with a clean slate\x1b[0m');
{
  const before = dms.send(alice, AGENT, 'remember the word pineapple');
  await settle();
  const r = dms.send(alice, AGENT, '/new');
  assert(r.ok && r.sessionId === null && r.message.authorKind === 'system', '/new alone posts a marker and sends nothing');
  assert(aos.chatRooms.dm(alice.id, AGENT).sessionId === null, 'the room has no session');
  assert(dms.send(alice, AGENT, ' /NEW ').message.seq === r.message.seq, 'a second /new does not stack markers');
  const n = spawned.length;
  const r2 = dms.send(alice, AGENT, 'what word?');
  await settle();
  assert(r2.ok && r2.sessionId !== before.sessionId && spawned.length === n + 1, 'the next message launches a different session');
  const task = row(r2.sessionId).task;
  assert(!/pineapple/.test(task) && !/Earlier in this conversation/.test(task), 'which is told nothing from before the marker');
  assert(!dms.thread(alice, AGENT).messages.some((m) => m.authorKind === 'member' && /^\/new/i.test(m.body)), '/new is never stored as something I said');
  const r3 = dms.send(alice, AGENT, '/new summarise the roadmap');
  assert(r3.ok && r3.sessionId !== r2.sessionId && r3.message.body === 'summarise the roadmap', '/new <text> starts a session and sends the text');
  assert(!/\/new/.test(row(r3.sessionId).task), 'the command itself never reaches the agent');
  assert(dms.list(alice).contacts[0].unread === 0, 'markers do not count as unread');
}

console.log('\n\x1b[1m9) rooms: membership, @-addressing, a session per agent, context catch-up\x1b[0m');
{
  const carol = aos.team.invite({ email: 'carol@example.com', role: 'admin' }).member;
  aos.db.prepare("UPDATE members SET status = 'active', name = CASE id WHEN ? THEN 'Alice' WHEN ? THEN 'Carol' ELSE 'Bob' END").run(alice.id, carol.id);
  const A = aos.team.getMember(alice.id), C = aos.team.getMember(carol.id), B = aos.team.getMember(bob.id);
  // a second agent to talk to
  const dir = path.join(HOME, 'agents', 'helper');
  fs.mkdirSync(dir, { recursive: true });
  const src = aos.agents.get(AGENT);
  aos.registerAgent({ ...src, id: 'helper', description: 'A second agent', dir, category: undefined });

  assert(dms.createRoom(A, { members: [], agents: [] }).ok === false, 'a room needs someone besides you');
  const made = dms.createRoom(A, { name: '#launch', members: [C.id, B.id], agents: [AGENT, 'helper'] });
  assert(made.ok, 'room created', JSON.stringify(made));
  const id = made.id;
  const sum = dms.roomList(A)[0];
  assert(sum.name === 'launch' && sum.members.length === 3 && sum.agents.length === 2, 'named, 3 people + 2 agents');
  assert(dms.roomList(C).length === 1 && dms.roomList(B).length === 1, 'every member sees it');
  const dave = aos.team.invite({ email: 'dave@example.com', role: 'admin' }).member;
  assert(dms.roomThread(dave, id).ok === false && dms.roomSend(dave, id, 'hi').ok === false, 'a non-member can neither read nor post');

  const n0 = spawned.length;
  const m1 = dms.roomSend(A, id, 'morning all, launch is thursday');
  assert(m1.ok && m1.delivered.length === 0 && spawned.length === n0, 'people talking: no agent runs');
  const m2 = dms.roomSend(C, id, 'works for me');
  assert(dms.roomList(A)[0].unread === 1 && dms.roomList(A)[0].lastAuthor === 'Carol', "Carol's message is unread for Alice");

  const m3 = dms.roomSend(A, id, '@helper can you draft the announcement?');
  await settle();
  const lane = () => aos.chatRooms.participants(id).find((p) => p.id === 'helper');
  const hs = lane().sessionId;
  assert(m3.ok && m3.delivered.join() === 'helper' && spawned.includes('aos-' + hs), 'an @mention runs exactly that agent', JSON.stringify([m3.delivered, spawned.length - n0]));
  const task = row(hs).task;
  assert(/room "#launch"/.test(task) && /launch is thursday/.test(task) && /Carol: works for me/.test(task) && /Alice to you: @helper can you draft/.test(task), 'its first prompt carries the room so far', task.slice(0, 200));
  assert(row(hs).run_as === alice.id && row(hs).dm_room === id, 'runs as the person who addressed it; session flagged hidden');
  assert(!aos.chatRooms.participants(id).find((p) => p.id === AGENT).sessionId, 'the other agent was not woken');

  setWorking(hs, true);
  write(hs, [user(task), tool('h1', 'Bash', { command: 'ls' }), result('h1'), say('Draft is ready: "We launch Thursday."')]);
  let t = dms.roomThread(C, id);
  assert(t.typing.length === 1 && t.typing[0].agent === 'helper', 'the room shows who is typing');
  setWorking(hs, false);
  t = dms.roomThread(C, id, { read: true });
  const last = t.messages.slice(-1)[0];
  assert(last.authorKind === 'agent' && last.authorId === 'helper' && last.authorName === 'Helper' && /Draft is ready/.test(last.body) && last.steps.length === 1, 'the reply lands in the room for everyone, steps tucked');
  assert(t.messages.find((m) => m.seq === m1.message.seq).authorName === 'Alice', 'member messages carry their author name');

  dms.roomSend(C, id, 'make it punchier');
  const inj = injected.length;
  const m5 = dms.roomSend(C, id, '@Helper one more pass please');
  assert(m5.delivered.join() === 'helper' && lane().sessionId === hs, 'a second mention reuses the same session (case-insensitive)');
  const typed = injected.slice(inj).map((i) => i.text).join(' ');
  assert(/Carol: make it punchier/.test(typed) && /Carol to you: @Helper one more pass/.test(typed) && !/launch is thursday/.test(typed), 'and is shown only what it missed', typed.slice(0, 200));
  assert(row(hs).run_as === carol.id, 'now acting for Carol');

  const m6 = dms.roomSend(B, id, '@helper do it for me');
  assert(m6.ok && m6.delivered.length === 0 && m6.notes.length === 1, 'a member who cannot run the agent posts, but does not wake it');

  const both = dms.roomSend(A, id, '@agent-author and @helper: status?');
  await settle();
  assert(both.delivered.length === 2, 'two mentions wake two agents');

  // group DM: unnamed, one person + one agent needs no mention
  const g = dms.createRoom(A, { agents: ['helper'] });
  const gs = dms.roomSend(A, g.id, 'quick question');
  await settle();
  assert(g.ok && gs.delivered.join() === 'helper' && dms.roomList(A).find((r) => r.id === g.id).name === null, 'one person + one agent: no @ needed');

  // membership changes
  assert(dms.roomAdd(A, id, { members: [dave.id] }).ok === false, 'cannot add a member who has not joined the team');
  aos.db.prepare("UPDATE members SET status = 'active', name = 'Dave' WHERE id = ?").run(dave.id);
  assert(dms.roomAdd(A, id, { members: [dave.id] }).ok && dms.roomList(aos.team.getMember(dave.id)).some((r) => r.id === id), 'adding a member gives them the room');
  assert(dms.roomRemove(B, id, 'member', carol.id).ok === false, 'a plain member cannot remove someone else');
  assert(dms.roomRemove(B, id, 'member', bob.id).ok && !dms.roomList(B).some((r) => r.id === id), 'but can leave');
  assert(dms.roomRename(C, id, 'launch-week').ok && dms.roomList(C).find((r) => r.id === id).name === 'launch-week', 'rename');
  const nr = dms.roomSend(A, id, '/new');
  assert(nr.ok && nr.message.authorKind === 'system' && !lane().sessionId, '/new in a room resets every agent there');
  assert(dms.roomRemove(A, g.id, 'member', alice.id).deleted === true && !aos.chatRooms.get(g.id), 'the last person leaving deletes the room');
  assert(dms.list(A).contacts.every((c) => c.agent !== ''), 'rooms never leak into the DM contact list');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* scratch */ }
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
})();
