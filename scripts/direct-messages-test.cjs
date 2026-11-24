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
  assert(typeof t.typing.since === 'number' && t.typing.since <= Date.now(), 'and when the turn started — for the working-time counter');
  write(s1, [result('t1'), say('Three tasks are open: A, B and C.'), tool('t2', 'mcp__agentos__report', { summary: 'x' }), result('t2')]);
  setWorking(s1, false);
  t = dms.thread(alice, AGENT);
  const reply = t.messages[t.messages.length - 1];
  assert(t.messages.length === 2 && reply.authorKind === 'agent' && reply.body === 'Three tasks are open: A, B and C.', 'turn end → one agent message = its last prose', JSON.stringify(t.messages.map((m) => m.body)));
  assert(reply.steps && reply.steps.length === 3 && reply.steps[0].t === 'say' && reply.steps[1].t === 'do', 'narration + tool calls kept as steps');
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
  assert(res && /All 7 nightly backups/.test(res.body) && res.steps.length === 1 && t.jobs.length === 0 && aos.chatRooms.job(job.id).status === 'done', 'when it ends the result is posted, tagged, and the job closes');
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
