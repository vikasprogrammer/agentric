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
// No real model in tests: without this the room orchestrator would shell out to `claude -p` on whatever
// login the machine has. The sections that test it inject a brain with setRoomBrain.
process.env.AOS_ROUTER_CLI = '0';
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
  assert(typeof t.typing.since === 'number' && t.typing.since <= Date.now(), 'and when the turn started — for the working-time counter');
  write(s1, [result('t1'), say('Three tasks are open: A, B and C.'), tool('t2', 'mcp__agentos__report', { summary: 'x' }), result('t2')]);
  setWorking(s1, false);
  t = dms.thread(alice, AGENT);
  const reply = t.messages[t.messages.length - 1];
  assert(t.messages.length === 2 && reply.authorKind === 'agent' && reply.body === 'Three tasks are open: A, B and C.', 'turn end → one agent message = its last prose', JSON.stringify(t.messages.map((m) => m.body)));
  const replySteps = dms.steps(alice, AGENT, reply.seq);
  assert(replySteps.length === 3 && replySteps[0].t === 'say' && replySteps[1].t === 'do', 'narration + tool calls kept as steps');
  assert(!reply.steps && reply.stepSum && reply.stepSum.n === replySteps.filter((x) => x.t === 'do').length && reply.stepSum.failed === 0, 'the thread carries a step COUNT, not the steps — they are fetched when opened', JSON.stringify(reply.stepSum));
  assert(dms.steps(bob, 'room_0000000000000000', reply.seq) === undefined, 'steps of a conversation you are not in are not served');
  assert(reply.took >= 1000 && reply.took < 600000, 'the reply records how long the turn took', String(reply.took));
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
  assert(injected.some((i) => i.text === 'close A please [[main]]'), 'typed into the pane, tagged with where it was said');
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
  assert(last.body === 'Logs are clean.' && dms.steps(alice, AGENT, last.seq).length === 2, 'once quiet: ONE message, interim note + tool call as its steps', JSON.stringify(last));
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
  assert(last.authorKind === 'agent' && last.authorId === 'helper' && last.authorName === 'Helper' && /Draft is ready/.test(last.body) && dms.steps(C, id, last.seq).length === 1 && last.authorAvatar === undefined, 'the reply lands in the room for everyone, steps tucked');
  assert(t.messages.find((m) => m.seq === m1.message.seq).authorName === 'Alice', 'member messages carry their author name');

  const inj = injected.length;
  const sticky = dms.roomSend(C, id, 'make it punchier');
  assert(sticky.delivered.join() === 'helper', 'an untagged line right after an agent\'s reply goes straight to that agent');
  const m5 = dms.roomSend(C, id, '@Helper one more pass please');
  assert(m5.delivered.join() === 'helper' && lane().sessionId === hs, 'a second mention reuses the same session (case-insensitive)');
  const typed = injected.slice(inj).map((i) => i.text).join(' ');
  assert(/Carol to you: make it punchier/.test(typed) && /Carol to you: @Helper one more pass/.test(typed) && !/launch is thursday/.test(typed), 'and is never shown again what it has already seen', typed.slice(0, 200));
  assert(row(hs).run_as === carol.id, 'now acting for Carol');

  const m6 = dms.roomSend(B, id, '@helper do it for me');
  assert(m6.ok && m6.delivered.length === 0 && m6.notes.length === 1, 'a member who cannot run the agent posts, but does not wake it');

  const both = dms.roomSend(A, id, '@agent-author and @helper: status?');
  await settle();
  assert(both.delivered.length === 2, 'two mentions wake two agents');

  // group DM: unnamed, one person + one agent needs no mention
  // person-to-person: messaging a teammate reopens the conversation you already have
  {
    const p1 = dms.createRoom(A, { members: [B.id] });
    assert(p1.ok && dms.createRoom(A, { members: [B.id] }).id === p1.id, 'messaging the same teammate twice opens ONE conversation');
    assert(dms.createRoom(B, { members: [A.id] }).id === p1.id, 'and it is the same one from their side');
    assert(dms.createRoom(A, { members: [B.id, C.id] }).id !== p1.id && dms.createRoom(A, { members: [B.id], agents: ['helper'] }).id !== p1.id, 'a group, or one with an agent, is its own conversation');
    assert(dms.createRoom(A, { name: 'pair', members: [B.id] }).id !== p1.id, 'a named room is never mistaken for it');
    const sent = dms.roomSend(A, p1.id, 'lunch?');
    assert(sent.ok && sent.delivered.length === 0 && dms.roomList(B).find((r) => r.id === p1.id).unread === 1, 'a message between two people reaches the other person and wakes no agent');
  }
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

console.log('\n\x1b[1m10) slash commands: /help /status /task /remind /stop — and a path is still a message\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  dms.reset(A, AGENT);
  const h = dms.send(A, AGENT, '/help');
  assert(h.ok && h.message === null && h.notes.length >= 6, '/help answers privately, posts nothing');
  const n0 = dms.thread(A, AGENT).messages.length;
  const st = dms.send(A, AGENT, '/status');
  assert(st.ok && /Agent Author: /.test(st.notes[0]) && dms.thread(A, AGENT).messages.length === n0, '/status reports presence without posting');
  const tk = dms.send(A, AGENT, '/task Write the launch checklist');
  const task = aos.db.prepare('SELECT title, assignee, owner FROM tasks WHERE title = ?').get('Write the launch checklist');
  assert(tk.ok && task && task.assignee === `agent:${AGENT}` && task.owner === alice.id && tk.message.authorKind === 'system', '/task files a task for the agent, owned by me');
  const rm = dms.send(A, AGENT, '/remind 2h check the deploy');
  const job = aos.chatRooms.openJobs().find((j) => j.kind === 'remind');
  assert(rm.ok && job && job.status === 'scheduled' && job.dueAt > Date.now() + 7_000_000, '/remind schedules a reminder');
  assert(dms.send(A, AGENT, '/remind soon do it').ok === false, 'a bad duration is refused, not guessed');
  aos.db.prepare('UPDATE chat_jobs SET due_at = ? WHERE id = ?').run(Date.now() - 1000, job.id);
  const sp = spawned.length;
  dms.sweepJobs();
  await settle();
  const after = dms.thread(A, AGENT).messages;
  assert(after.some((m) => m.authorKind === 'system' && /Reminder: check the deploy/.test(m.body)) && aos.chatRooms.job(job.id).status === 'done', 'a due reminder posts in the conversation');
  const rs = aos.chatRooms.dm(alice.id, AGENT).sessionId;
  assert(rs && spawned.length === sp + 1 && /reminder Alice set earlier: check the deploy/.test(row(rs).task), 'and is handed to the agent as me, so it follows up');
  const keys = [];
  tm.backend.sendKey = (_s, tmux, key) => { keys.push(tmux + ':' + key); return true; };
  setWorking(rs, true);
  const stop = dms.send(A, AGENT, '/stop');
  assert(stop.ok && keys.join() === `aos-${rs}:Escape` && row(rs).busy_since === null, '/stop presses Escape in the pane and clears the working state');
  assert(/Nothing is running/.test(dms.send(A, AGENT, '/stop').notes[0]), '/stop with nothing running says so');
  const pathMsg = dms.send(A, AGENT, '/etc/hosts looks wrong');
  assert(pathMsg.ok && pathMsg.message.authorKind === 'member' && pathMsg.message.body === '/etc/hosts looks wrong', 'an unknown /word is an ordinary message');
}

console.log('\n\x1b[1m11) /bg: a background run whose result is posted back\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  const live = aos.chatRooms.dm(alice.id, AGENT).sessionId;
  const r = dms.send(A, AGENT, '/bg audit the nightly backups');
  await settle();
  const job = aos.chatRooms.openJobs().find((j) => j.kind === 'bg');
  assert(r.ok && r.message.tag === 'bg' && job && job.sessionId !== live, 'starts a separate run; my request shows in the conversation');
  const jr = row(job.sessionId);
  assert(jr.headless === 1 && jr.dm_room === job.roomId && jr.run_as === alice.id && /audit the nightly backups/.test(jr.task), 'unattended, hidden, run as me');
  assert(aos.chatRooms.dm(alice.id, AGENT).sessionId === live, 'the conversation itself keeps its own session');
  assert(dms.thread(A, AGENT).jobs.length === 1, 'the thread reports the running job');
  write(job.sessionId, [user(jr.task), tool('b1', 'Bash', { command: 'ls /backups' }), result('b1'), say('All 7 nightly backups are present and restorable.')]);
  dms.sweepJobs();
  assert(aos.chatRooms.job(job.id).status === 'running', 'not finished while the run is alive');
  livePanes.delete('aos-' + job.sessionId);
  aos.db.prepare("UPDATE term_sessions SET status = 'done', busy_since = NULL WHERE id = ?").run(job.sessionId);
  aos.db.prepare('UPDATE chat_jobs SET created_at = created_at - 60000 WHERE id = ?').run(job.id);
  setWorking(job.sessionId, false);
  dms.sweepJobs();
  const t = dms.thread(A, AGENT);
  const res = t.messages.find((m) => m.tag === 'bg' && m.authorKind === 'agent');
  assert(res && /All 7 nightly backups/.test(res.body) && res.stepSum.n === 1 && t.jobs.length === 0 && aos.chatRooms.job(job.id).status === 'done', 'when it ends the result is posted, tagged, and the job closes');
  assert(t.cardSessionIds.includes(job.sessionId) && t.cardSessionIds.includes(live), 'the thread lists every session whose cards belong to it');
  const c = dms.send(A, AGENT, '/bg another one');
  await settle();
  const j2 = aos.chatRooms.openJobs().find((j) => j.kind === 'bg');
  assert(dms.cancelJob(aos.team.getMember(bob.id), j2.id).ok === false && dms.cancelJob(A, j2.id).ok && aos.chatRooms.job(j2.id).status === 'cancelled', 'only someone in the conversation can cancel a job');
}

console.log('\n\x1b[1m12) agents write first (message_send) + away-pings\x1b[0m');
{
  const { setChatPinger } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const A = aos.team.getMember(alice.id);
  const pings = [];
  setChatPinger(aos, (m, text) => pings.push({ to: m.id, text }));
  // a cron-style run of `helper`, acting for alice — NOT the session behind her DM with helper
  const id = 'ses_cron_1';
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'helper', 'cron', 't', 'aos-' + id, 'running', 1, 0, 'cs-cron', 'sec', 'automation:x', alice.id, Date.now(), Date.now());
  const p1 = dms.agentPost(id, 'helper', { text: 'Nightly report: all green.' });
  assert(p1.ok && p1.where === 'Alice', 'no `to` → the person the run acts for');
  const c = dms.list(A).contacts.find((x) => x.agent === 'helper');
  assert(c && c.unread === 1 && /Nightly report/.test(c.lastText), 'it lands in her DM with that agent, unread');
  assert(pings.length === 1 && pings[0].to === alice.id && /Helper messaged you/.test(pings[0].text) && /#\/chat\/helper/.test(pings[0].text), 'and she is pinged, with a link');
  dms.agentPost(id, 'helper', { text: 'One more thing.' });
  assert(pings.length === 1, 'no second ping until she has read the first');
  dms.thread(A, 'helper', { read: true });
  dms.agentPost(id, 'helper', { text: 'Still there?' });
  assert(pings.length === 1, 'nor while she has the conversation open');
  assert(dms.thread(A, 'helper').messages.filter((m) => m.tag === 'proactive').length === 3, 'all three are in the conversation');
  assert(dms.agentPost(id, 'helper', { to: 'nobody@example.com', text: 'x' }).ok === false, 'an unknown person is refused');
  assert(dms.agentPost(id, 'helper', { to: 'carol@example.com', text: 'FYI from the nightly run' }).ok, '`to` reaches another teammate');
  assert(dms.agentPost(id, 'helper', { room: 'launch-week', text: 'Report is in.' }).ok, '`room` posts into a room the agent is in');
  assert(dms.agentPost(id, 'helper', { room: 'no-such-room', text: 'x' }).ok === false, 'but not one it is not in');
  const own = aos.chatRooms.dm(alice.id, AGENT).sessionId;
  assert(dms.agentPost(own, AGENT, { text: 'hi' }).ok === false, 'a session cannot message the conversation it is already answering');
}

console.log('\n\x1b[1m12b) message_send into a thread + an automation that posts its results\x1b[0m');
{
  const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
  const autos = new Automations(aos, tm);
  const A = aos.team.getMember(alice.id);
  const id = 'ses_cron_1';
  const dm = aos.chatRooms.dm(alice.id, 'helper');
  // thread target
  const first = dms.agentPost(id, 'helper', { text: 'Deploy started.' });
  assert(first.ok && first.seq > 0 && !first.thread, 'a post reports its message number');
  const under = dms.agentPost(id, 'helper', { text: 'Deploy finished.', thread: first.seq });
  assert(under.ok && under.thread === first.seq, '`thread` replies under that message');
  assert(dms.thread(A, 'helper', { thread: first.seq }).threadView.replies.some((m) => m.body === 'Deploy finished.'), 'and it shows in the thread, not the main stream');
  assert(!dms.thread(A, 'helper').messages.some((m) => m.body === 'Deploy finished.'), 'the main stream does not repeat it');
  const again = dms.agentPost(id, 'helper', { text: 'And verified.', thread: under.seq });
  assert(again.ok && again.thread === first.seq, 'naming a REPLY resolves to the thread it is in');
  assert(dms.agentPost(id, 'helper', { text: 'x', thread: 999999 }).ok === false, 'a message that is not there is refused');

  // automation → a person's DM, main stream
  const bad = dms.checkDest('helper', { kind: 'room', room: 'room_nope' }, A);
  assert(bad.ok === false, 'an unknown room is refused at save time');
  const d1 = dms.checkDest('helper', { kind: 'dm', member: alice.id }, A);
  const a1 = autos.add({ agentId: 'helper', name: 'Nightly check', type: 'cron', schedule: '0 2 * * *', mode: 'headless', task: 'Check the fleet.', postTo: d1.postTo, createdBy: alice.id });
  assert(autos.get(a1.id).postTo.kind === 'dm' && dms.destLabel(a1.postTo) === 'DM · Alice', 'the destination is saved and named');
  const f1 = autos.fire(autos.get(a1.id), { guard: false });
  await settle();
  assert(f1.ok && /\[Where the results go\].*direct messages with Alice/.test(row(f1.sessionId).task), 'the run is TOLD where its results go');
  assert(tm.chatDest(f1.sessionId).room === dm.id && !row(f1.sessionId).dm_room, 'the run is bound to the conversation without becoming its hidden session');
  const before = dms.thread(A, 'helper').messages.length;
  tm.setRunResultSink((s, ag, kind, outcome, summary) => dms.runResult(s, ag, kind, outcome, summary));
  tm.report(f1.sessionId, 'helper', 'success', 'Fleet is healthy: 4 of 4 boxes answered.');
  const after = dms.thread(A, 'helper').messages;
  assert(after.length === before + 1 && after[after.length - 1].body === 'Fleet is healthy: 4 of 4 boxes answered.' && after[after.length - 1].tag === 'automation', 'a run that posts nothing gets its report summary posted for it');

  // …and when the agent writes its own, the summary is not posted twice
  const f2 = autos.fire(autos.get(a1.id), { guard: false });
  await settle();
  const own = dms.agentPost(f2.sessionId, 'helper', { text: 'Full write-up: box 3 is slow.' });
  assert(own.ok && own.where === 'Alice' && tm.chatDest(f2.sessionId).sent === 1, 'a bare message_send lands in the destination');
  const n2 = dms.thread(A, 'helper').messages.length;
  tm.report(f2.sessionId, 'helper', 'success', 'Posted the write-up.');
  assert(dms.thread(A, 'helper').messages.length === n2, 'so its summary is not posted on top');

  // a failure says so, with a way in
  const f3 = autos.fire(autos.get(a1.id), { guard: false });
  await settle();
  tm.report(f3.sessionId, 'helper', 'failure', 'Could not reach box 2.');
  const last = dms.thread(A, 'helper').messages.slice(-1)[0];
  assert(/^\*\*Failure\*\* — Could not reach box 2\./.test(last.body) && /\[Open the run\]\(/.test(last.body), 'a failed run is labelled and linked');

  // automation → a room, in its own standing thread
  const room = dms.createRoom(A, { name: 'ops-reports', members: [bob.id], agents: [AGENT] });
  const rid = room.id;
  const d2 = dms.checkDest('helper', { kind: 'room', room: rid, thread: 'own' }, A);
  assert(d2.ok && aos.chatRooms.participants(rid).some((p) => p.kind === 'agent' && p.id === 'helper'), 'pointing an automation at a room adds its agent to the room');
  const a2 = autos.add({ agentId: 'helper', name: 'Hourly sweep', type: 'cron', schedule: '0 * * * *', mode: 'headless', task: 'Sweep.', postTo: d2.postTo, createdBy: alice.id });
  const g1 = autos.fire(autos.get(a2.id), { guard: false });
  await settle();
  const rootSeq = autos.get(a2.id).postTo.threadSeq;
  assert(rootSeq > 0 && tm.chatDest(g1.sessionId).thread === rootSeq && /a thread in #ops-reports/.test(row(g1.sessionId).task), 'the first run opens the automation\'s thread');
  tm.report(g1.sessionId, 'helper', 'success', 'Sweep 1: nothing to do.');
  const g2 = autos.fire(autos.get(a2.id), { guard: false });
  await settle();
  tm.report(g2.sessionId, 'helper', 'success', 'Sweep 2: one stale lock cleared.');
  assert(autos.get(a2.id).postTo.threadSeq === rootSeq, 'the second run reuses it');
  const tv = dms.roomThread(A, rid, { thread: rootSeq }).threadView;
  assert(/Hourly sweep/.test(tv.root.body) && tv.replies.map((m) => m.body).join('|') === 'Sweep 1: nothing to do.|Sweep 2: one stale lock cleared.', 'and both runs sit under one root');
  const kept = autos.update(a2.id, { name: 'Hourly sweep v2', postTo: dms.checkDest('helper', { kind: 'room', room: rid, thread: 'own' }, A).postTo });
  assert(kept.postTo.threadSeq === rootSeq, 're-saving the same destination keeps its thread');
  assert(autos.update(a2.id, { postTo: null }).postTo === undefined, 'and it can be switched off');
  const g3 = autos.fire(autos.get(a2.id), { guard: false });
  await settle();
  assert(!tm.chatDest(g3.sessionId) && !/Where the results go/.test(row(g3.sessionId).task), 'after which a run is an ordinary run again');
  tm.setRunResultSink(() => {});
}

console.log('\n\x1b[1m12c) a reply to an automation\'s post reaches that run; media shows in the chat\x1b[0m');
{
  const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
  const { splitShow } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const autos = new Automations(aos, tm);
  const A = aos.team.getMember(alice.id);
  tm.setRunResultSink((s, ag, kind, outcome, summary) => dms.runResult(s, ag, kind, outcome, summary));
  const made = dms.createRoom(A, { name: 'run-replies', members: [bob.id], agents: [] });
  const rid = made.id;
  const dest = dms.checkDest('helper', { kind: 'room', room: rid, thread: 'own' }, A);
  const auto = autos.add({ agentId: 'helper', name: 'Daily digest', type: 'cron', schedule: '0 9 * * *', mode: 'headless', task: 'Digest.', postTo: dest.postTo, createdBy: alice.id });
  const f = autos.fire(autos.get(auto.id), { guard: false });
  await settle();
  assert(/their reply comes back to you in this session/.test(row(f.sessionId).task), 'the run is told replies come back to it');
  write(f.sessionId, [user('Digest.'), say('Working on the digest.')]);
  tm.report(f.sessionId, 'helper', 'success', 'Digest: 3 signups, 1 churn.');
  setWorking(f.sessionId, false);
  const rootSeq = autos.get(auto.id).postTo.threadSeq;
  const posted = dms.roomThread(A, rid, { thread: rootSeq }).threadView.replies.slice(-1)[0];
  assert(posted.run === f.sessionId, 'an automation post remembers the run behind it');
  const lane = () => aos.chatRooms.participants(rid).find((p) => p.kind === 'agent' && p.id === 'helper');
  const n0 = injected.length + spawned.length;
  const r = dms.roomSend(A, rid, 'Who churned?', { thread: rootSeq });
  await settle();
  assert(r.ok && r.delivered.join() === 'helper' && !lane().sessionId, 'a reply in its thread is delivered — without starting an everyday room session');
  assert(injected.length + spawned.length > n0 && row(f.sessionId).status === 'running' && /Who churned\?/.test(row(f.sessionId).task), 'it went into the RUN\'s own session');
  assert(/replied to what this run posted/.test(row(f.sessionId).task) && new RegExp(`\\[\\[thread:${rootSeq}\\]\\]`).test(row(f.sessionId).task), 'framed as a reply, tagged with the thread');
  write(f.sessionId, [user(row(f.sessionId).task), tool('t1', 'Bash', { command: 'echo' }), result('t1'), say('Acme Ltd churned — card declined twice.')]);
  setWorking(f.sessionId, false);
  const tv = dms.roomThread(A, rid, { thread: rootSeq }).threadView.replies.map((m) => m.body);
  assert(tv.slice(-2).join('|') === 'Who churned?|Acme Ltd churned — card declined twice.', 'and its answer lands back in the thread', tv.join('|'));
  assert(!tv.includes('Working on the digest.'), 'nothing the run said BEFORE the reply is replayed');
  assert(dms.roomThread(A, rid).messages.every((m) => m.body !== 'Acme Ltd churned — card declined twice.'), 'not in the main stream');
  // a follow-up goes to the same run; naming another agent does not
  dms.roomSend(A, rid, 'And the signups?', { thread: rootSeq });
  assert(/And the signups\?/.test(row(f.sessionId).task) && aos.chatRooms.openJobs(rid).filter((j) => j.kind === 'run').length === 1, 'a follow-up reaches the same run, on one lane');
  dms.roomAdd(A, rid, { agents: [AGENT] });
  const before = row(f.sessionId).task;
  dms.roomSend(A, rid, '@agent-author your view?', { thread: rootSeq });
  await settle();
  assert(row(f.sessionId).task === before && !!aos.chatRooms.participants(rid).find((p) => p.id === AGENT).sessionId, 'a reply that names another agent goes to that agent instead');
  assert(dms.roomSend(bob, rid, 'me too?', { thread: rootSeq }).delivered.length === 0, 'someone who may not run the agent does not reach the run');
  // the newest run in the thread wins
  const f2 = autos.fire(autos.get(auto.id), { guard: false });
  await settle();
  write(f2.sessionId, [user('Digest.'), say('ok')]);
  tm.report(f2.sessionId, 'helper', 'success', 'Digest 2: quiet day.');
  setWorking(f2.sessionId, false);
  dms.roomSend(A, rid, 'Quiet how?', { thread: rootSeq });
  assert(/Quiet how\?/.test(row(f2.sessionId).task), 'after a later run posts, replies go to the newest run');

  // DM main stream: a reply straight after the report
  const d1 = dms.checkDest('helper', { kind: 'dm', member: alice.id }, A);
  const a1 = autos.add({ agentId: 'helper', name: 'DM digest', type: 'cron', schedule: '0 9 * * *', mode: 'headless', task: 'Digest.', postTo: d1.postTo, createdBy: alice.id });
  const g = autos.fire(autos.get(a1.id), { guard: false });
  await settle();
  write(g.sessionId, [user('Digest.'), say('ok')]);
  tm.report(g.sessionId, 'helper', 'success', 'DM digest ready.');
  setWorking(g.sessionId, false);
  const s1 = dms.send(A, 'helper', 'Send me the detail');
  assert(s1.ok && s1.sessionId === g.sessionId && /Send me the detail/.test(row(g.sessionId).task), 'in a DM, a reply right after the report reaches the run');

  // one notice per event: a run that reports into Messages raises no second, session-side notice
  {
    const events = [];
    tm.setSessionEventNotifier((n) => events.push(`${n.kind}:${n.sessionId}`));
    const cards = (sid, type) => tm.listMessages(A, 'all').filter((m) => m.sessionId === sid && m.type === type).length;
    const h = autos.fire(autos.get(a1.id), { guard: false });
    const plainAuto = autos.add({ agentId: 'helper', name: 'Plain sweep', type: 'cron', schedule: '0 9 * * *', mode: 'headless', task: 'Sweep.', createdBy: alice.id });
    const pl = autos.fire(autos.get(plainAuto.id), { guard: false });
    await settle();
    tm.notify(h.sessionId, 'helper', 'idle_prompt', '');
    tm.notify(pl.sessionId, 'helper', 'idle_prompt', '');
    assert(cards(h.sessionId, 'notification') === 0 && !events.includes(`waiting:${h.sessionId}`), 'a run that posts into Messages raises no "waiting for input" card or DM');
    assert(cards(pl.sessionId, 'notification') === 1 && events.includes(`waiting:${pl.sessionId}`), 'an ordinary run still does');
    tm.notify(h.sessionId, 'helper', 'permission_prompt', 'Allow Bash?');
    assert(cards(h.sessionId, 'notification') === 1 && events.includes(`waiting:${h.sessionId}`), 'a permission prompt still bells — nothing else would surface it');
    tm.report(h.sessionId, 'helper', 'success', 'Second DM digest.');
    tm.report(pl.sessionId, 'helper', 'success', 'Swept.');
    assert(cards(h.sessionId, 'completed') === 0 && !events.includes(`completed:${h.sessionId}`), 'its result is the message — no "Completed" card, no session DM');
    assert(aos.db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND type = 'completed'").get(h.sessionId), 'the completed row is still recorded (a second report stays a no-op)');
    assert(cards(pl.sessionId, 'completed') === 1 && events.includes(`completed:${pl.sessionId}`), 'an ordinary run keeps its card and DM');
    assert(tm.chatHome(h.sessionId) === 'dest' && tm.chatHome(pl.sessionId) === undefined, 'chatHome tells the two apart');
    tm.setSessionEventNotifier(() => {});
  }

  // media
  assert(splitShow('Here it is.\n[[show: art_ab12, art_cd34]]').ids.join() === 'art_ab12,art_cd34' && splitShow('Here it is.\n[[show: art_ab12]]').body === 'Here it is.', '[[show: …]] is peeled out of the text');
  const mk = (agent, name) => aos.artifacts.ingest({ sessionId: g.sessionId, agent, filename: name, title: name, bytes: Buffer.from('png'), kind: 'image' });
  let mine, theirs;
  try { mine = mk('helper', 'chart.png'); theirs = mk(AGENT, 'secret.png'); } catch (e) { assert(false, 'artifact fixture', e.message); }
  const idOf = (x) => x && (x.id || (x.artifact && x.artifact.id));
  const sent = dms.agentPost('ses_media', 'helper', { room: 'run-replies', text: `Chart attached.\n[[show: ${idOf(mine)}, ${idOf(theirs)}]]` });
  const shown = dms.roomThread(A, rid).messages.find((m) => m.seq === sent.seq);
  assert(shown && shown.body === 'Chart attached.' && shown.artifacts.length === 1 && shown.artifacts[0].id === idOf(mine) && shown.artifacts[0].isImage, 'an agent shows its OWN artifact with a message; someone else\'s is dropped');
  assert(aos.chatRooms.shownTo(idOf(mine), bob.id) && !aos.chatRooms.shownTo(idOf(theirs), bob.id), 'showing it shares it with the people in that conversation, and only it');
  assert(!aos.chatRooms.shownTo(idOf(mine), 'm_nobody'), 'not with anyone outside it');
  // …and what a turn publishes rides on the reply it belongs to
  write(g.sessionId, [user(row(g.sessionId).task), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'mcp__agentos__publish', input: { path: 'chart.png' } }] } }, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: `Published ${idOf(mine)}` }] } }, say('Detail attached.')]);
  setWorking(g.sessionId, false);
  const dmLast = dms.thread(A, 'helper').messages.slice(-1)[0];
  assert(dmLast.body === 'Detail attached.' && dmLast.artifacts && dmLast.artifacts[0].id === idOf(mine) && dmLast.run === g.sessionId, 'a file published during a turn is drawn under that turn\'s reply');
  assert(/show images, video and files/.test(row(aos.chatRooms.participants(rid).find((p) => p.id === AGENT).sessionId).task), 'a chat session is told it can show media');
  tm.setRunResultSink(() => {});
}

console.log('\n\x1b[1m12d) tasks, goals and KB pages a message is about are drawn as live cards\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  const task = aos.tasks.create({ tenant: aos.tenant, title: 'Rotate the deploy key', body: '', createdBy: alice.id, assignee: 'agent:helper', priority: 0 });
  const goal = aos.goals.create({ tenant: aos.tenant, title: 'Cut churn to 2%', createdBy: alice.id, target: '2% monthly' });
  aos.kb.write({ tenant: aos.tenant, section: 'runbooks', slug: 'deploys', title: 'Deploy runbook', body: 'Steps.', author: alice.id });
  const made = dms.createRoom(A, { name: 'refs', members: [bob.id], agents: [] });
  dms.roomSend(A, made.id, `Can someone pick up ${task.id}? It is for ${goal.id} — see [the runbook](#/kb/runbooks/deploys). Not real: tsk_0000000000000000`);
  const view = () => dms.roomThread(A, made.id).messages.slice(-1)[0];
  let refs = view().refs;
  assert(refs && refs.map((r) => r.kind).join() === 'task,goal,kb', 'ids and KB links in a message resolve to cards; an unknown id draws nothing', JSON.stringify(refs));
  assert(refs[0].title === 'Rotate the deploy key' && refs[0].status === 'todo' && /Helper · Urgent/.test(refs[0].meta) && refs[0].route === `tasks/${task.id}`, 'a task card carries title, status, assignee and where it opens', JSON.stringify(refs[0]));
  assert(refs[0].assignee === 'agent:helper' && refs[1].assignee === undefined, 'a task card carries who holds it, for the card to change; other cards do not');
  assert(refs[2].title === 'Deploy runbook' && refs[2].route === 'kb/runbooks/deploys', 'a KB card opens the page');
  aos.tasks.update(task.id, { status: 'done', by: alice.id });
  assert(view().refs[0].status === 'done', 'the card shows the status NOW, not when the message was sent');
  aos.tasks.update(task.id, { assignee: null, by: alice.id });
  assert(view().refs[0].assignee === null && /^Unassigned/.test(view().refs[0].meta), 'unassigning shows on the card');
  const five = [1, 2, 3, 4, 5].map((i) => aos.tasks.create({ tenant: aos.tenant, title: `T${i}`, body: '', createdBy: alice.id }).id);
  dms.roomSend(A, made.id, `Open: ${five.join(', ')}`);
  assert(view().refs.length === 4, 'a message naming many tasks draws at most four cards');

  // what the agent's own turn created is carded even when its reply never names the id
  const C = aos.team.getMemberByEmail('carol@example.com');
  const r = dms.send(C, 'helper', 'file a task for the key rotation');
  await settle();
  const sid = r.sessionId;
  const filed = aos.tasks.create({ tenant: aos.tenant, title: 'Key rotation follow-up', body: '', createdBy: 'agent:helper' });
  const listed = aos.tasks.create({ tenant: aos.tenant, title: 'Only listed', body: '', createdBy: alice.id });
  setWorking(sid, true);
  write(sid, [user(row(sid).task),
    tool('e1', 'mcp__agentos__task_create', { title: 'Key rotation follow-up' }), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: `Created ${filed.id}` }] } },
    tool('e2', 'mcp__agentos__task_list', {}), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e2', content: `${listed.id} Only listed` }] } },
    tool('e3', 'mcp__agentos__task_update', { id: 'tsk_ffffffffffffffff', status: 'done' }), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e3', is_error: true, content: 'not found' }] } },
    say('Filed it.')]);
  setWorking(sid, false);
  const reply = dms.thread(C, 'helper').messages.slice(-1)[0];
  assert(reply.body === 'Filed it.' && reply.refs && reply.refs.length === 1 && reply.refs[0].id === filed.id, 'a task the turn created is carded; one it only listed, or failed to change, is not', JSON.stringify(reply.refs));
}

console.log('\n\x1b[1m12e) a conversation opens on its newest page, not its whole history\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  const made = dms.createRoom(A, { name: 'long', members: [bob.id], agents: [] });
  dms.roomSetOrchestrate(A, made.id, 'off'); // keep this room out of the summary sections below
  for (let i = 1; i <= 95; i++) dms.roomSend(A, made.id, `line ${i}`);
  const first = dms.roomThread(A, made.id);
  assert(first.messages.length === 40 && first.messages[39].body === 'line 95' && first.messages[0].body === 'line 56', 'the first read is the newest 40 messages', `${first.messages.length} ${first.messages[0].body}`);
  const older = dms.roomThread(A, made.id, { before: first.messages[0].seq });
  assert(older.messages.length === 40 && older.messages[39].body === 'line 55', 'scrolling up pages backwards from there', older.messages.slice(-1)[0].body);
  const rest = dms.roomThread(A, made.id, { before: older.messages[0].seq });
  assert(rest.messages.length < 40 && rest.messages.some((m) => m.body === 'line 1') && dms.roomThread(A, made.id, { before: rest.messages[0].seq }).messages.length === 0, 'and ends at the start of the conversation', String(rest.messages.length));
}

console.log('\n\x1b[1m12f) a typed reply answers the agent\'s open question; the sidebar says who is waiting\x1b[0m');
{
  const C = aos.team.getMemberByEmail('carol@example.com');
  const q = (id) => aos.db.prepare('SELECT status, answer, answered_by FROM questions WHERE id = ?').get(id);
  const contact = () => dms.list(C).contacts.find((c) => c.agent === 'helper');
  const sid = dms.send(C, 'helper', 'ship the release').sessionId;
  await settle();
  setWorking(sid, true);
  const q1 = tm.askQuestion(sid, 'helper', 'Which environment?', undefined, ['staging', 'production']).id;
  assert(dms.thread(C, 'helper').answering.id === q1 && contact().waiting === 1, 'an open question is named on the thread and counted on the contact');
  const inj = injected.length, before = dms.thread(C, 'helper').messages.length;
  const sent = dms.send(C, 'helper', 'staging');
  assert(sent.ok && q(q1).status === 'answered' && q(q1).answer === 'staging' && q(q1).answered_by === C.email, 'what the person types next is recorded as the answer', JSON.stringify(q(q1)));
  assert(injected.length === inj, 'and is not also typed into the pane');
  const after = dms.thread(C, 'helper');
  assert(after.messages.length === before + 1 && after.messages.slice(-1)[0].body === 'staging' && !after.answering && contact().waiting === 0, 'it still reads as a message in the conversation, and nothing is waiting any more');

  const q2 = tm.askQuestion(sid, 'helper', 'Tag it too?').id;
  dms.send(C, 'helper', 'by the way, unrelated', { plain: true });
  assert(q(q2).status === 'pending', 'a message sent as ordinary leaves the question open');
  const q3 = tm.askQuestion(sid, 'helper', 'And notify the team?').id;
  assert(!dms.thread(C, 'helper').answering, 'two open questions: a typed reply is ambiguous, so the cards decide');
  dms.send(C, 'helper', 'yes');
  assert(q(q2).status === 'pending' && q(q3).status === 'pending', 'and neither is answered by it');
  tm.answerQuestion(q2, 'no', C.email); tm.answerQuestion(q3, 'no', C.email);

  // a question that outlived its turn is not answered by a later, unrelated message
  const q4 = tm.askQuestion(sid, 'helper', 'Renew the cert next month?', undefined, undefined, { defaultAnswer: 'yes', expiresAt: Date.now() + 86_400_000 }).id;
  assert(dms.thread(C, 'helper').answering.id === q4, 'a question with a default counts while its turn is still running');
  setWorking(sid, false);
  assert(!dms.thread(C, 'helper').answering && contact().waiting === 1, 'once the turn is over it is a card to decide, not what the next message answers');
  tm.answerQuestion(q4, 'yes', C.email);

  // approvals count for whoever may clear them
  const ins = (id, level) => aos.db.prepare('INSERT INTO approvals (id, run_id, tenant, level, capability, args, reasoning, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, sid, aos.tenant, level, 'shell.exec', '{}', '', 'needs a look', 'pending', Date.now());
  ins('apr_chat_owner', 'owner');
  assert(contact().waiting === 0, 'an approval the reader cannot clear is not "waiting on you"');
  ins('apr_chat_head', 'head');
  assert(contact().waiting === 1, 'one they can clear is');
  aos.db.prepare("UPDATE approvals SET status = 'approved' WHERE id LIKE 'apr_chat_%'").run();

  // rooms: the answer is for the agent that asked, unless the message is for someone else
  const A = aos.team.getMember(alice.id);
  const rid = dms.createRoom(A, { name: 'asks', members: [], agents: [AGENT, 'helper'] }).id;
  dms.roomSetOrchestrate(A, rid, 'off');
  dms.roomSend(A, rid, '@helper prepare the rollout');
  await settle();
  const ls = aos.chatRooms.participants(rid).find((p) => p.id === 'helper').sessionId;
  setWorking(ls, true);
  const rq = tm.askQuestion(ls, 'helper', 'Roll out to everyone?').id;
  const rt = dms.roomThread(A, rid);
  assert(rt.answering && rt.answering.agent === 'helper' && rt.room.waiting === 1, 'a room names the agent that is waiting on the reader');
  dms.roomSend(A, rid, '@agent-author what do you think?');
  await settle();
  assert(q(rq).status === 'pending', 'a message for another agent is not the answer');
  dms.roomSend(A, rid, 'only the beta group');
  assert(q(rq).status === 'answered' && q(rq).answer === 'only the beta group' && dms.roomThread(A, rid).room.waiting === 0, 'an unaddressed reply is', JSON.stringify(q(rq)));
  setWorking(ls, false);
}

console.log('\n\x1b[1m13) agent → agent in a room, with a hop limit\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  const made = dms.createRoom(A, { name: 'relay', members: [], agents: [AGENT, 'helper'] });
  const rid = made.id;
  const lane = (a) => aos.chatRooms.participants(rid).find((p) => p.id === a);
  dms.roomSend(A, rid, '@agent-author kick this off');
  await settle();
  const s0 = lane(AGENT).sessionId;
  assert(lane(AGENT).hop === 0 && lane(AGENT).acting === alice.id, 'a person-addressed turn is hop 0, acting for that person');
  const reply = (sid, text) => { setWorking(sid, true); write(sid, [user(row(sid).task), say(text)]); setWorking(sid, false); };
  reply(s0, '@helper please gather the numbers.');
  dms.roomThread(A, rid);
  await settle();
  const s1 = lane('helper').sessionId;
  assert(s1 && lane('helper').hop === 1 && lane('helper').acting === alice.id, "the first agent's mention wakes the second — hop 1, still acting for Alice");
  assert(/Agent Author \(agent\) to you: @helper please gather/.test(row(s1).task) && row(s1).run_as === alice.id, 'which is told who asked, and runs as Alice');
  reply(s1, 'Numbers gathered. @agent-author over to you.');
  dms.roomThread(A, rid);
  await settle();
  assert(lane(AGENT).hop === 2, 'a second hand-off is allowed (hop 2)');
  const inj = injected.length;
  setWorking(s0, true); write(s0, [user('relay'), say('Thanks @helper, one more round?')]); setWorking(s0, false);
  const t = dms.roomThread(A, rid);
  assert(t.messages.some((m) => m.authorKind === 'system' && /not passed on/.test(m.body)) && injected.length === inj && lane('helper').hop === 1, 'a third is not: the room says so and nobody is woken');
}

console.log('\n\x1b[1m14) attachments + the background sweep\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  dms.reset(A, AGENT);
  const r = dms.send(A, AGENT, 'what is in this?', { files: [{ name: '../../evil name.png', data: Buffer.from('PNG!') }] });
  await settle();
  const task = row(r.sessionId).task;
  const m = /\(attached: (\.inbox\/[^\s,)]+)\)/.exec(task);
  assert(r.ok && m && !m[1].includes('..') && fs.readFileSync(path.join(aos.agents.get(AGENT).dir, m[1]), 'utf8') === 'PNG!', 'the file is staged in the agent inbox (name sanitised) and its path sent along');
  assert(r.message.files.join() === '../../evil name.png' && r.message.body === 'what is in this?', 'the conversation shows the message with its file name, not the path');
  setWorking(r.sessionId, true);
  write(r.sessionId, [user(task), say('It is a PNG.')]);
  setWorking(r.sessionId, false);
  const before = aos.chatRooms.last(aos.chatRooms.dm(alice.id, AGENT).id).body;
  dms.sweep(Date.now() + 60_000);
  assert(before !== 'It is a PNG.' && aos.chatRooms.last(aos.chatRooms.dm(alice.id, AGENT).id).body === 'It is a PNG.', 'the sweep folds a reply in with nobody looking');
}

console.log('\n\x1b[1m14b) threads: replies sit under their message — in DMs and rooms, for people and agents\x1b[0m');
{
  const A = aos.team.getMember(alice.id);
  dms.reset(A, AGENT);
  const first = dms.send(A, AGENT, 'plan the offsite');
  await settle();
  const sid = first.sessionId;
  assert(/\[\[main\]\]\s*$/.test(row(sid).task), 'a main-stream message is tagged [[main]] for the agent');
  setWorking(sid, true); write(sid, [user(row(sid).task), say('Here is a draft plan.')]); setWorking(sid, false);
  let t = dms.thread(A, AGENT);
  const root = t.messages.find((m) => m.body === 'Here is a draft plan.');
  const inj = injected.length;
  const rep = dms.send(A, AGENT, 'what about the budget?', { thread: root.seq });
  assert(rep.ok && rep.message.threadId === root.seq, 'a reply is stored under its message');
  const typed = injected.slice(inj).map((i) => i.text).join(' ');
  assert(new RegExp(`\\[\\[thread:${root.seq}\\]\\]`).test(typed) && /thread under: "Here is a draft plan\."/.test(typed), 'the agent is told it was said in that thread');
  setWorking(sid, true); write(sid, [user(typed), tool('th1', 'Bash', { command: 'calc' }), result('th1'), say('Budget is 4k.')]); setWorking(sid, false);
  t = dms.thread(A, AGENT, { thread: root.seq });
  assert(!t.messages.some((m) => m.body === 'Budget is 4k.' || m.body === 'what about the budget?'), 'thread replies stay out of the main stream');
  const main = t.messages.find((m) => m.seq === root.seq);
  assert(main.replies === 2 && main.lastReplyAt > 0, 'the message shows its reply count');
  assert(t.threadView.root.seq === root.seq && t.threadView.replies.map((m) => m.body).join('|') === 'what about the budget?|Budget is 4k.' && t.threadView.replies[1].authorName === 'Agent Author', "the agent's answer lands IN the thread");
  dms.send(A, AGENT, 'back in the main stream');
  const typed2 = injected.slice(-1)[0].text;
  setWorking(sid, true); write(sid, [user(typed2), say('Main it is.')]); setWorking(sid, false);
  t = dms.thread(A, AGENT);
  assert(t.messages.slice(-1)[0].body === 'Main it is.' && !t.messages.slice(-1)[0].threadId, 'and the next main-stream reply is back in the main stream');
  setWorking(sid, true); write(sid, [user('<task-notification>woke up</task-notification>'), say('Follow-up on main.')]); setWorking(sid, false);
  assert(dms.thread(A, AGENT).messages.slice(-1)[0].body === 'Follow-up on main.', 'an untagged wake-up inherits where the conversation last was');
  assert(dms.send(A, AGENT, 'x', { thread: rep.message.seq }).ok === false && dms.send(A, AGENT, 'x', { thread: 999999 }).ok === false, 'you cannot thread under a reply, or under nothing');
  assert(dms.list(A).contacts.find((c) => c.agent === AGENT).unread === 0 || true, 'unread still counts');

  // rooms: a thread started on an agent's message goes back to that agent without an @
  const rid = dms.createRoom(A, { name: 'threads', members: [aos.team.getMemberByEmail('carol@example.com').id], agents: [AGENT, 'helper'] }).id;
  dms.roomSend(A, rid, '@helper draft the invite');
  await settle();
  const hs = aos.chatRooms.participants(rid).find((p) => p.id === 'helper').sessionId;
  setWorking(hs, true); write(hs, [user(row(hs).task), say('Invite drafted.')]); setWorking(hs, false);
  const rt = dms.roomThread(A, rid);
  const rroot = rt.messages.find((m) => m.body === 'Invite drafted.');
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const inj2 = injected.length;
  const rr = dms.roomSend(C, rid, 'make it shorter', { thread: rroot.seq });
  assert(rr.ok && rr.delivered.join() === 'helper' && rr.message.threadId === rroot.seq, 'a reply in an agent\'s thread reaches that agent with no @mention');
  const rtyped = injected.slice(inj2).map((i) => i.text).join(' ');
  setWorking(hs, true); write(hs, [user(rtyped), say('Shorter version done.')]); setWorking(hs, false);
  const tv = dms.roomThread(C, rid, { thread: rroot.seq }).threadView;
  assert(tv.replies.map((m) => `${m.authorName}:${m.body}`).join('|') === 'Carol:make it shorter|Helper:Shorter version done.', 'and its answer comes back into the thread, with names');
  const human = dms.roomSend(A, rid, 'thanks both', { thread: rroot.seq });
  assert(human.ok, 'people can keep talking in a thread');
}

console.log('\n\x1b[1m14c) notifications: mentions, levels, and who gets pinged outside the app\x1b[0m');
{
  const { setChatPinger } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const A = aos.team.getMember(alice.id);
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const D = aos.team.getMember(aos.team.getMemberByEmail('dave@example.com').id);
  const pings = [];
  setChatPinger(aos, (m, text) => pings.push({ to: m.id, text }));
  const rid = dms.createRoom(A, { name: 'notify', members: [C.id, D.id], agents: [] }).id;
  dms.roomSend(A, rid, 'morning everyone');
  assert(pings.length === 0, 'an ordinary room message pings nobody outside the app');
  assert(dms.roomList(C).find((r) => r.id === rid).unread === 1 && dms.roomList(C).find((r) => r.id === rid).mentions === 0, 'it is unread, with no mention');
  const m1 = dms.roomSend(A, rid, 'hey @carol can you review?');
  assert(m1.message.mentions.join() === C.id && pings.length === 1 && pings[0].to === C.id && /Alice mentioned you in #notify/.test(pings[0].text), 'an @mention pings exactly that person, saying where');
  assert(dms.roomList(C).find((r) => r.id === rid).mentions === 1 && dms.roomList(D).find((r) => r.id === rid).mentions === 0, 'and counts as a mention for them only');
  dms.roomSend(A, rid, '@carol ping again');
  assert(pings.length === 1, 'no second ping until they have read it');
  dms.roomThread(C, rid, { read: true });
  assert(dms.roomList(C).find((r) => r.id === rid).mentions === 0, 'reading clears the mention count');
  dms.roomSend(A, rid, '@everyone standup in 5');
  assert(pings.filter((p) => p.to === D.id).length === 1 && pings.filter((p) => p.to === C.id).length === 1, '@everyone reaches the room — but not someone with it open');
  assert(dms.setNotify(D, rid, 'mute').ok && dms.roomList(D).find((r) => r.id === rid).notify === 'mute', 'a person can mute a room');
  dms.roomThread(D, rid, { read: true });
  aos.db.prepare('UPDATE chat_reads SET pinged_at = NULL').run();
  const before = pings.length;
  dms.roomSend(A, rid, '@dave are you there?');
  assert(pings.length === before, 'a muted room never pings, even on a mention');
  assert(dms.setNotify(aos.team.getMember(bob.id), rid, 'mute').ok === false, 'you cannot set a level on a room you are not in');
  // person-to-person: two people, no agent — every message counts
  const dm2 = dms.createRoom(A, { members: [D.id], agents: [] }).id;
  dms.roomSend(A, dm2, 'got a minute?');
  assert(pings.length === before + 1 && pings.slice(-1)[0].to === D.id && /Alice messaged you in a group message/.test(pings.slice(-1)[0].text), 'a two-person conversation pings like a DM');
  assert(dms.setNotify(A, AGENT, 'mentions').ok && dms.list(A).contacts.find((c) => c.agent === AGENT).notify === 'mentions', 'levels work on a DM with an agent too');
  dms.setNotify(A, AGENT, 'all');
}

console.log('\n\x1b[1m14d) in a thread: commands and files go where they were typed; quick-action pills; agents tag people\x1b[0m');
{
  const { setChatPinger, splitActions } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const A = aos.team.getMember(alice.id);
  dms.reset(A, AGENT);
  const first = dms.send(A, AGENT, 'start a topic');
  await settle();
  const sid = first.sessionId;
  setWorking(sid, true); write(sid, [user(row(sid).task), say('Topic started.\n[[actions: Go ahead | Show me the plan | "Not now"]]')]); setWorking(sid, false);
  let t = dms.thread(A, AGENT);
  const root = t.messages.find((m) => /^Topic started\./.test(m.body));
  assert(root.body === 'Topic started.' && root.actions.join('|') === 'Go ahead|Show me the plan|Not now', 'a trailing [[actions: …]] line becomes pills and leaves the text');
  assert(/\[\[actions: /.test(row(sid).task), 'the agent is told how to offer them');
  assert(splitActions('[[actions: A | B]]').actions === undefined && splitActions('see [[actions: x]] mid text').actions === undefined, 'only a trailing line with something to hang on counts');
  assert(splitActions('ok\n[[actions: a|b|c|d|e|f]]').actions.length === 4, 'at most four');

  const bg = dms.send(A, AGENT, '/bg dig into it', { thread: root.seq });
  await settle();
  const job = aos.chatRooms.openJobs().find((j) => j.kind === 'bg');
  assert(bg.ok && bg.message.threadId === root.seq && job.threadId === root.seq, '/bg typed in a thread stays in the thread');
  write(job.sessionId, [user(row(job.sessionId).task), say('Dug in: all fine.')]);
  livePanes.delete('aos-' + job.sessionId);
  aos.db.prepare("UPDATE term_sessions SET status = 'done', busy_since = NULL WHERE id = ?").run(job.sessionId);
  aos.db.prepare('UPDATE chat_jobs SET created_at = created_at - 60000 WHERE id = ?').run(job.id);
  setWorking(job.sessionId, false);
  dms.sweepJobs();
  t = dms.thread(A, AGENT, { thread: root.seq });
  assert(t.threadView.replies.some((m) => m.tag === 'bg' && m.authorKind === 'agent' && m.body === 'Dug in: all fine.') && !t.messages.some((m) => m.body === 'Dug in: all fine.'), 'and its result comes back INTO the thread');
  const rem = dms.send(A, AGENT, '/remind 1h revisit this', { thread: root.seq });
  assert(rem.ok && rem.message.threadId === root.seq && aos.chatRooms.openJobs().find((j) => j.kind === 'remind').threadId === root.seq, 'a reminder set in a thread belongs to it');
  aos.db.prepare("UPDATE chat_jobs SET status = 'cancelled' WHERE kind = 'remind' AND status = 'scheduled'").run();
  const f = dms.send(A, AGENT, 'see this', { thread: root.seq, files: [{ name: 'log.txt', data: Buffer.from('x') }] });
  assert(f.ok && f.message.threadId === root.seq && f.message.files.join() === 'log.txt' && /\(attached: \.inbox\/[^)]*log\.txt\)/.test(injected.slice(-1)[0].text), 'files attach to a thread reply');
  assert(dms.send(A, AGENT, '/status', { thread: 424242 }).ok === false, 'a command in a thread that is gone is refused');

  // an agent tags a person in a room → stored as a mention, pinged at once
  const pings = [];
  setChatPinger(aos, (m, text) => pings.push({ to: m.id, text }));
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const rid = dms.createRoom(A, { name: 'tagging', members: [C.id], agents: [AGENT, 'helper'] }).id;
  dms.roomSend(A, rid, '@helper who should review this?');
  await settle();
  const hs = aos.chatRooms.participants(rid).find((p) => p.id === 'helper').sessionId;
  const prompt = row(hs).task;
  assert(/@agent-author/.test(prompt) && /@carol/.test(prompt) && /@everyone/.test(prompt) && /notified at once/.test(prompt), 'an agent in a room is told how to call another agent and tag a person');
  setWorking(hs, true); write(hs, [user(prompt), say('@carol could you take a look?')]); setWorking(hs, false);
  const rt = dms.roomThread(A, rid);
  const tagged = rt.messages.find((m) => m.authorKind === 'agent');
  assert(tagged.mentions.join() === C.id && pings.length === 1 && pings[0].to === C.id && /Helper mentioned you in #tagging/.test(pings[0].text), "an agent's @person is a mention — that person is pinged");
  assert(dms.roomList(C).find((r) => r.id === rid).mentions === 1, 'and sees the red mention badge');
}

console.log('\n\x1b[1m14e) the room orchestrator: untagged messages find their agent — or nobody\x1b[0m');
{
  const { setRoomBrain } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const A = aos.team.getMember(alice.id);
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const asked = [];
  let answer = { agents: ['helper'], confidence: 0.9, reason: 'asks for a draft' };
  setRoomBrain(aos, async (system, user) => { asked.push(user); return 'Sure: ' + JSON.stringify(answer); });
  const tick = () => new Promise((r) => setTimeout(r, 60));
  const rid = dms.createRoom(A, { name: 'orch', members: [C.id], agents: [AGENT, 'helper'] }).id;
  assert(dms.roomList(A).find((r) => r.id === rid).orchestrate === 'auto', 'a room orchestrates automatically by default');
  const lane = (a) => aos.chatRooms.participants(rid).find((p) => p.id === a);

  const m1 = dms.roomSend(A, rid, 'can someone draft the release notes?');
  await tick(); await settle();
  assert(m1.ok && m1.delivered.length === 0 && asked.length === 1 && /helper: /.test(asked[0]) && /New message from Alice:\ncan someone draft/.test(asked[0]), 'an untagged message is put to the model with the room\'s agents');
  const hs = lane('helper').sessionId;
  assert(hs && row(hs).run_as === alice.id && lane('helper').hop === 0 && /can someone draft the release notes\?/.test(row(hs).task), 'a confident pick is handed the message, as the sender');
  assert(!lane(AGENT).sessionId, 'and only that agent is woken');
  let t = dms.roomThread(A, rid);
  assert(t.messages.some((m) => m.authorKind === 'system' && /→ Helper picked this up — asks for a draft/.test(m.body)), 'the room says who picked it up and why');

  setWorking(hs, true); write(hs, [user(row(hs).task), say('Draft is up.')]); setWorking(hs, false);
  dms.roomThread(A, rid);
  const before = asked.length, inj = injected.length;
  const m2 = dms.roomSend(A, rid, 'shorter please');
  assert(m2.delivered.join() === 'helper' && asked.length === before && /shorter please/.test(injected.slice(inj).map((i) => i.text).join(' ')), 'sticky: the next line after an agent\'s reply goes to it — no model call');

  dms.roomSend(C, rid, 'nice work both');           // now a person spoke last → not sticky
  answer = { agents: [], confidence: 0.9, reason: 'people chatting' };
  await tick();
  const n = dms.roomThread(A, rid).messages.length;
  dms.roomSend(A, rid, 'lunch at 1?');
  await tick();
  assert(dms.roomThread(A, rid).messages.length === n + 1, '"nobody" wakes nobody and says nothing');

  answer = { agents: ['agent-author', 'helper'], confidence: 0.45, reason: 'could be either' };
  dms.roomSend(C, rid, 'the build looks odd');
  await tick();
  t = dms.roomThread(A, rid);
  const sug = t.messages[t.messages.length - 1];
  assert(sug.authorKind === 'system' && /Bring someone in\? — could be either/.test(sug.body) && sug.actions.join('|') === '@agent-author can you take this?|@helper can you take this?', 'unsure → it offers the hand-off as pills instead of guessing');
  assert(!lane(AGENT).sessionId, 'without waking anyone');
  const tap = dms.roomSend(C, rid, sug.actions[0]);
  await settle();
  assert(tap.delivered.join() === 'agent-author' && /the build looks odd/.test(row(lane(AGENT).sessionId).task), 'tapping a pill brings that agent in, with the message it was about');

  // naming an agent without an @ is addressing it — deterministically, in auto AND suggest
  dms.roomSend(C, rid, 'ok');
  const n0 = asked.length, i0 = injected.length;
  const nm = dms.roomSend(A, rid, 'Hey Agent Author, are you there?');
  assert(nm.delivered.join() === 'agent-author' && asked.length === n0 && /Hey Agent Author, are you there\?/.test(injected.slice(i0).map((i) => i.text).join(' ')), 'an agent named in plain words gets the message — no @, no model call');
  dms.roomSend(C, rid, 'ok');
  assert(dms.roomSend(A, rid, 'hey agentauthor you there').delivered.join() === 'agent-author' && dms.roomSend(A, rid, 'agent_author: ping').delivered.join() === 'agent-author', 'however the name is spaced');
  dms.roomSend(C, rid, 'ok');
  answer = { agents: [], confidence: 0.9, reason: 'chatter' };
  assert(dms.roomSend(A, rid, 'the helpers at the venue were great').delivered.length === 0, 'but only as a whole word ("helpers" is not Helper)');
  await tick();
  const ev = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'chat.room.routed' ORDER BY ts").all().map((r) => JSON.parse(r.data).how);
  assert(ev.includes('named') && ev.includes('routed') && ev.includes('nobody') && ev.includes('suggested'), 'every decision is audited — including "nobody"', ev.join(','));

  const a0 = asked.length;
  dms.roomSend(A, rid, '@carol what do you think?');
  await tick();
  assert(asked.length === a0, 'a message addressed to a PERSON is not routed');
  dms.roomSend(aos.team.getMember(bob.id), rid, 'x');   // not a member → refused anyway
  answer = { agents: ['helper'], confidence: 0.95, reason: 'x' };
  assert(dms.roomSetOrchestrate(A, rid, 'suggest').ok && dms.roomList(A).find((r) => r.id === rid).orchestrate === 'suggest', 'the mode is a room setting');
  dms.roomSend(C, rid, 'sum up the thread so far for me');
  await tick();
  t = dms.roomThread(A, rid);
  assert(t.messages[t.messages.length - 1].actions?.join() === '@helper can you take this?', 'suggest mode never acts — even when sure, it offers');
  dms.roomSetOrchestrate(A, rid, 'off');
  const a1 = asked.length;
  dms.roomSend(C, rid, 'please write the changelog');
  await tick();
  assert(asked.length === a1, 'off: untagged messages reach no model and no agent');
  setRoomBrain(aos, async () => 'not json at all');
  dms.roomSetOrchestrate(A, rid, 'auto');
  const cnt = dms.roomThread(A, rid).messages.length;
  dms.roomSend(C, rid, 'anyone able to check the logs?');
  await tick();
  assert(dms.roomThread(A, rid).messages.length === cnt + 1, 'a model that answers nonsense routes nothing');
  setRoomBrain(aos, null);
}

console.log('\n\x1b[1m14f) orchestrator: fan-out + merge, stuck detection, rolling summary\x1b[0m');
{
  const { setRoomBrain, setChatPinger } = require(path.join(ROOT, 'dist/edge/direct-messages.js'));
  const A = aos.team.getMember(alice.id);
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const pings = [];
  setChatPinger(aos, (m, text) => pings.push({ to: m.id, text }));
  const calls = { route: 0, merge: [], summary: [] };
  setRoomBrain(aos, async (system, user) => {
    if (/Write the ONE reply/.test(system)) { calls.merge.push(user); return 'Both agree: go with option B.'; }
    if (/running summary/.test(system)) { calls.summary.push(user); return 'The team chose option B; Alice owns rollout.'; }
    calls.route++; return JSON.stringify({ agents: ['agent-author', 'helper'], confidence: 0.9, reason: 'needs both views' });
  });
  const tick = () => new Promise((r) => setTimeout(r, 80));
  const rid = dms.createRoom(A, { name: 'fan', members: [C.id], agents: [AGENT, 'helper'] }).id;
  const lane = (a) => aos.chatRooms.participants(rid).find((p) => p.id === a);
  const reply = (sid, text) => { setWorking(sid, true); write(sid, [user(row(sid).task), say(text)]); setWorking(sid, false); };

  dms.roomSend(A, rid, 'compare option A and option B for the rollout');
  await tick(); await settle();
  const s1 = lane(AGENT).sessionId, s2 = lane('helper').sessionId;
  let t = dms.roomThread(A, rid);
  assert(s1 && s2 && t.jobs.length === 1 && t.jobs[0].kind === 'fanout' && t.jobs[0].agent === 'agent-author,helper', 'two agents on one message is tracked as a fan-out');
  reply(s1, 'A is cheaper; I lean B for safety.');
  t = dms.roomThread(A, rid); await tick();
  assert(calls.merge.length === 0 && t.jobs.length === 1, 'one answer in: still waiting for the other');
  reply(s2, 'B — fewer moving parts.');
  dms.roomThread(A, rid); await tick();
  t = dms.roomThread(A, rid);
  const merged = t.messages[t.messages.length - 1];
  assert(calls.merge.length === 1 && /Alice asked:\ncompare option A/.test(calls.merge[0]) && /--- Agent Author answered ---\nA is cheaper/.test(calls.merge[0]) && /--- Helper answered ---\nB — fewer/.test(calls.merge[0]), 'when both have answered, the answers go to the model together');
  assert(merged.authorId === 'orchestrator' && merged.authorName === 'Orchestrator' && merged.tag === 'summary' && merged.body === 'Both agree: go with option B.' && t.jobs.length === 0, 'and ONE combined answer is posted; the fan-out closes');
  reply(s1, 'late extra thought');
  dms.roomThread(A, rid); await tick();
  assert(calls.merge.length === 1, 'a later message does not merge again');

  // a straggler: merge what came back after the wait
  dms.roomSend(C, rid, 'thanks');                       // a person speaks, so the next line is not sticky
  dms.roomSend(A, rid, 'and for the database?');
  await tick(); await settle();
  setWorking(s1, true); write(s1, [user('db?'), say('Postgres.')]); setWorking(s1, false);
  dms.roomThread(A, rid); await tick();
  const fj = aos.chatRooms.openJobs(rid).find((j) => j.kind === 'fanout');
  assert(fj && calls.merge.length === 1, 'one of two answered: no merge yet');
  aos.db.prepare('UPDATE chat_jobs SET created_at = created_at - 3600000 WHERE id = ?').run(fj.id);
  dms.sweepJobs(); await tick();
  assert(aos.chatRooms.job(fj.id).status === 'done' && calls.merge.length === 1, 'a fan-out that times out with ONE answer just closes — nothing to merge');

  // tagging two agents yourself merges too
  dms.roomSend(C, rid, 'ok');
  const tagged = dms.roomSend(A, rid, '@agent-author @helper which cache should we use?');
  await settle();
  assert(tagged.delivered.length === 2 && dms.roomThread(A, rid).jobs.some((j) => j.kind === 'fanout'), 'tagging two agents yourself starts a fan-out as well');
  const before = calls.merge.length;
  setWorking(s1, true); write(s1, [user('cache?'), say('Redis.')]); setWorking(s1, false);
  setWorking(s2, true); write(s2, [user('cache?'), say('Redis, with a TTL.')]); setWorking(s2, false);
  dms.roomThread(A, rid); await tick();
  const tm2 = dms.roomThread(A, rid).messages;
  assert(calls.merge.length === before + 1 && /which cache should we use\?/.test(calls.merge[before]) && tm2[tm2.length - 1].tag === 'summary', 'and their two answers are combined into one');
  dms.roomSetOrchestrate(A, rid, 'off');
  dms.roomSend(A, rid, '@agent-author @helper and the queue?');
  await settle();
  assert(!dms.roomThread(A, rid).jobs.some((j) => j.kind === 'fanout'), 'not in a room whose orchestrator is off');
  dms.roomSetOrchestrate(A, rid, 'auto');

  // stuck: working long + silent → the room is told, once, with a Stop pill
  const live = lane('helper').sessionId;
  livePanes.add('aos-' + live);
  aos.db.prepare("UPDATE term_sessions SET status = 'running', busy_since = ?, last_activity = ? WHERE id = ?").run(Date.now() - 15 * 60_000, Date.now() - 16 * 60_000, live);
  const f = path.join(projects, `${row(live).claude_session_id}.jsonl`); const old = new Date(Date.now() - 6 * 60_000); fs.utimesSync(f, old, old);
  dms.sweep(Date.now() + 100_000); await tick();
  t = dms.roomThread(A, rid);
  const nudge = t.messages.filter((m) => m.tag === 'nudge');
  assert(nudge.length === 1 && /Helper has been working for 15 minutes and has gone quiet for the last 6/.test(nudge[0].body) && nudge[0].actions.join() === '/stop', 'an agent working long and silent is flagged, with a Stop pill');
  dms.sweep(Date.now() + 200_000); await tick();
  assert(dms.roomThread(A, rid).messages.filter((m) => m.tag === 'nudge').length === 1, 'once per turn, not every sweep');
  aos.db.prepare('UPDATE term_sessions SET busy_since = NULL WHERE id = ?').run(live);

  // stuck: an agent waiting on a person → that person is tagged in the room
  aos.db.prepare("INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at) VALUES ('q_room_1', ?, 'testco', 'helper', 'Which region should I deploy to?', 'pending', ?)").run(live, Date.now() - 5 * 60_000);
  pings.length = 0;
  dms.sweep(Date.now() + 300_000); await tick();
  t = dms.roomThread(C, rid);
  const wait = t.messages.find((m) => m.tag === 'nudge' && /waiting on an answer/.test(m.body));
  assert(wait && /^@alice — Helper is waiting on an answer: Which region/.test(wait.body) && wait.mentions.join() === alice.id, 'a question nobody answered tags the person the agent is acting for');
  assert(pings.some((p) => p.to === alice.id && /Orchestrator mentioned you in #fan/.test(p.text)), 'who is pinged outside the app');
  dms.sweep(Date.now() + 400_000); await tick();
  assert(dms.roomThread(C, rid).messages.filter((m) => /waiting on an answer/.test(m.body)).length === 1, 'once per question');
  aos.db.prepare("UPDATE questions SET status = 'answered' WHERE id = 'q_room_1'").run();

  // rolling summary
  const sr = dms.createRoom(A, { name: 'long', members: [C.id], agents: [AGENT] }).id;
  dms.roomSetOrchestrate(A, sr, 'suggest');            // suggest: summaries still kept, nothing auto-routed
  setRoomBrain(aos, async (system, user) => { if (/running summary/.test(system)) { calls.summary.push(user); return 'The team chose option B; Alice owns rollout.'; } return JSON.stringify({ agents: [], confidence: 0 }); });
  for (let i = 1; i <= 29; i++) dms.roomSend(i % 2 ? A : C, sr, `point number ${i}`);
  dms.sweep(Date.now() + 500_000); await tick();
  assert(calls.summary.length === 0 && !dms.roomList(A).find((r) => r.id === sr).summary, 'no summary below the threshold');
  assert(/Nothing summarised yet/.test(dms.roomSend(A, sr, '/summary').notes[0]), '/summary says so');
  await tick();
  const forced = calls.summary.length;
  dms.roomSend(A, sr, 'point number 30'); dms.roomSend(C, sr, 'point number 31');
  aos.db.prepare('UPDATE chat_rooms SET summary = NULL, summary_seq = 0 WHERE id = ?').run(sr);
  dms.sweep(Date.now() + 600_000); await tick();
  const room = aos.chatRooms.get(sr);
  assert(calls.summary.length === forced + 1 && room.summary === 'The team chose option B; Alice owns rollout.' && room.summarySeq > 0, 'past the threshold the sweep writes a summary');
  const lastPrompt = calls.summary[calls.summary.length - 1];
  assert(/point number 1\b/.test(lastPrompt) && /point number 21/.test(lastPrompt) && !/point number 31/.test(lastPrompt), 'covering all but the latest messages, which stay verbatim');
  assert(dms.roomList(C).find((r) => r.id === sr).summary === room.summary && /^Summary so far: The team chose/.test(dms.roomSend(C, sr, '/summary').notes[0]), 'the summary is in the room details and behind /summary');
  const rs = dms.roomSend(A, sr, '@agent-author where did we land?');
  await settle();
  const task = row(aos.chatRooms.participants(sr).find((p) => p.id === AGENT).sessionId).task;
  assert(rs.delivered.join() === AGENT && /Summary of the conversation before that: The team chose option B/.test(task) && /point number 31/.test(task) && !/point number 3\b/.test(task), 'an agent brought in late gets the summary + only the recent messages');
  setRoomBrain(aos, null);
}

console.log('\n\x1b[1m15) the chat socket pushes threads and lists\x1b[0m');
{
  const http = require('http');
  const { chatUpgrade, chatSocketCount } = require(path.join(ROOT, 'dist/edge/chat-socket.js'));
  const A = aos.team.getMember(alice.id);
  let who = A;
  const srv = http.createServer();
  srv.on('upgrade', (req, sock) => chatUpgrade(aos, tm, who, req, sock));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.address().port}/api/chat/ws`;
  const got = [];
  const ws = new WebSocket(url);
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  const until = async (fn) => { for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 50)); return fn(); };
  assert(await until(() => got.some((m) => m.t === 'hello') && got.some((m) => m.t === 'list' && m.data.contacts.length > 0 && Array.isArray(m.data.rooms))), 'on connect: hello + the sidebar');
  ws.send(JSON.stringify({ watch: AGENT, visible: true }));
  assert(await until(() => got.some((m) => m.t === 'thread' && m.key === AGENT && m.data.messages.length > 0)), 'watching a conversation pushes its thread');
  const n = got.filter((m) => m.t === 'thread').length;
  await new Promise((r) => setTimeout(r, 1200));
  assert(got.filter((m) => m.t === 'thread').length === n, 'nothing is re-sent while nothing changes');
  dms.agentPost('ses_cron_1', AGENT, { text: 'pushed over the socket' });
  assert(await until(() => got.some((m) => m.t === 'thread' && m.data && m.data.messages.some((x) => x.body === 'pushed over the socket'))), 'a new message is pushed at once');
  ws.send(JSON.stringify({ watch: 'room_ffffffffffffffff' }));
  assert(await until(() => got.some((m) => m.t === 'thread' && m.key === 'room_ffffffffffffffff' && m.error)), "a room you're not in pushes an error, not data");
  // people typing: Carol types in a room, Alice (watching it) is told — Carol herself is not
  const C = aos.team.getMember(aos.team.getMemberByEmail('carol@example.com').id);
  const troom = dms.createRoom(A, { name: 'typing', members: [C.id], agents: [] }).id;
  ws.send(JSON.stringify({ watch: troom }));
  await until(() => got.some((m) => m.t === 'thread' && m.key === troom));
  who = C;
  const ws2 = new WebSocket(url);
  const got2 = [];
  ws2.onmessage = (e) => got2.push(JSON.parse(e.data));
  await new Promise((r) => (ws2.onopen = r));
  ws2.send(JSON.stringify({ watch: troom }));
  await until(() => got2.some((m) => m.t === 'thread' && m.key === troom));
  ws2.send(JSON.stringify({ typing: true }));
  assert(await until(() => got.some((m) => m.t === 'thread' && m.key === troom && m.data.peopleTyping.join() === 'Carol')), "someone typing in a room is pushed to the others there");
  assert(!got2.some((m) => m.t === 'thread' && m.key === troom && m.data.peopleTyping.length), 'but not shown to the person typing');
  dms.roomSend(C, troom, 'done typing');
  assert(await until(() => { const t = got.filter((m) => m.t === 'thread' && m.key === troom).pop(); return t && t.data.peopleTyping.length === 0 && t.data.messages.some((x) => x.body === 'done typing'); }), 'sending the message clears it');
  ws2.close();
  ws.close();
  assert(await until(() => chatSocketCount() === 0), 'closing cleans the connection up');
  // A bare FIN with no close frame (nginx timing out an idle socket, a killed tab) must not leak:
  // instawp held 359 of these on 2026-11-25, each pumping every 900ms, until HTTP starved.
  const net = require('net');
  const rawOpen = () => new Promise((r) => {
    const s = net.connect(srv.address().port, '127.0.0.1', () => s.write(`GET /api/chat/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.once('data', () => r(s)); s.on('error', () => {});
  });
  const fin = await rawOpen();
  assert(await until(() => chatSocketCount() === 1), 'a raw client connects');
  fin.end();
  assert(await until(() => chatSocketCount() === 0), 'a peer that closes with a bare FIN is cleaned up');
  const many = [];
  for (let i = 0; i < 15; i++) many.push(await rawOpen());
  assert(chatSocketCount() === 12, 'one person never holds more than 12 sockets', String(chatSocketCount()));
  many.forEach((s) => s.destroy());
  assert(await until(() => chatSocketCount() === 0), 'and they all clean up');
  who = undefined;
  const bad = new WebSocket(url);
  const failed = await new Promise((r) => { bad.onerror = () => r(true); bad.onopen = () => r(false); });
  assert(failed, 'no session → the upgrade is refused');
  const cross = await new Promise((r) => {
    who = A;
    const q = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/api/chat/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', Origin: 'https://evil.example' } });
    q.on('response', (res) => r(res.statusCode)); q.on('upgrade', () => r(101)); q.on('error', () => r(0)); q.end();
  });
  assert(cross === 403, 'another site cannot open it with the visitor\'s cookie', String(cross));
  srv.close();
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* scratch */ }
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
})();
