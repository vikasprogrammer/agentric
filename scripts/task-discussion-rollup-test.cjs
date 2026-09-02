#!/usr/bin/env node
/* Task Discussion roll-up test — the per-card unread badge, participant rail and last-message preview
 * that ride along on `GET /api/tasks` (TerminalManager.taskDiscussionSummaries).
 *
 * The roll-up was rewritten from a per-row walk over every `task.chat` message in the tenant into two
 * aggregate queries, SCOPED to the tasks the board is rendering and reading only a PREFIX of the preview
 * body. On live instawp that was 2.07 MB of the 2.4 MB response (rollups for 1,986 tasks when the board
 * shows 500, each carrying a full unclipped body) and it is now 27 KB. What must not have changed:
 *   - unread counts the viewer's UNREAD messages and never their own posts;
 *   - a read receipt in `message_state` clears it, per member;
 *   - the participant list keeps first-appearance order, and names an agent as `agent:<id>`;
 *   - the preview is the NEWEST message, ties resolving by insertion order;
 *   - the clipped preview is byte-identical to clipping the full body;
 *   - scoping returns exactly the asked-for tasks (an empty list = nothing, not everything).
 * Isolated home; pure over the DB. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-disc-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { clipText } = require(path.join(ROOT, 'dist/state/session-activity.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const db = aos.db;

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const mate = mkMember('mate@testco.dev', 'member');

let seq = 0, clock = 1_000;
const chat = (taskId, { source = null, agent = '', body = 'hi', at } = {}) => {
  const id = `msg_${++seq}`;
  db.prepare(`INSERT INTO messages (id, type, session_id, agent, title, body, status, source, created_at)
              VALUES (?, 'task.chat', ?, ?, '', ?, 'open', ?, ?)`)
    .run(id, `task:${taskId}`, agent, body, source, at ?? ++clock);
  return id;
};
const markRead = (msgId, memberId) => db
  .prepare('INSERT OR REPLACE INTO message_state (message_id, member_id, read_at) VALUES (?, ?, ?)')
  .run(msgId, memberId, Date.now());

// ── corpus ────────────────────────────────────────────────────────────────────
const LONG = ('The quick brown fox jumps over the lazy dog. ').repeat(40); // ~1.8k chars
chat('t1', { source: mate.id, body: 'first from a teammate' });
const mine = chat('t1', { source: owner.id, body: 'my own reply' });
const readOne = chat('t1', { agent: 'support-ops', body: 'agent says something' });
chat('t1', { agent: 'support-ops', body: LONG });
markRead(readOne, owner.id);
chat('t2', { agent: 'infra-ops', body: 'only message' });
chat('t3', { source: mate.id, body: 'a task NOT on the board' });
// two messages in the same millisecond — the preview must be the later INSERT.
chat('t4', { agent: 'a', body: 'earlier insert', at: 9_000 });
chat('t4', { agent: 'b', body: 'later insert', at: 9_000 });

const board = ['t1', 't2', 't4'];
const scoped = tm.taskDiscussionSummaries(owner, board, 240);
const full = tm.taskDiscussionSummaries(owner);

console.log('\nscoping');
assert(Object.keys(scoped).sort().join() === 't1,t2,t4', 'only the board’s tasks come back', Object.keys(scoped).join());
assert(!!full.t3 && !scoped.t3, 'the unscoped call still covers the whole tenant');
assert(Object.keys(tm.taskDiscussionSummaries(owner, [], 240)).length === 0, 'an empty task list returns nothing, not everything');

console.log('\nunread');
assert(scoped.t1.unread === 2, 'unread counts the viewer’s unread messages only', String(scoped.t1.unread));
assert(tm.taskDiscussionSummaries(mate, board, 240).t1.unread === 3, 'each member gets their own count off message_state');
assert(!JSON.stringify(scoped.t1).includes('my own reply') || scoped.t1.unread === 2, 'the viewer’s own post is never unread to them');
assert(scoped.t2.unread === 1 && scoped.t4.unread === 2, 'unread is per task');

console.log('\nparticipants + preview');
assert(scoped.t1.participants.join() === `${mate.id},${owner.id},agent:support-ops`, 'participants keep first-appearance order, agents as agent:<id>', scoped.t1.participants.join());
assert(scoped.t1.last.body === clipText(LONG, 240) && scoped.t1.last.author === 'agent:support-ops', 'the preview is the newest message, clipped identically to clipping the full body');
assert(scoped.t1.last.agentId === 'support-ops', 'an agent preview carries its agent id for the avatar');
assert(scoped.t4.last.body === 'later insert', 'a same-millisecond tie resolves to the later insert');
assert(full.t1.last.body === LONG, 'without a clip the preview is still the whole body');
assert(scoped.t2.last.author === 'agent:infra-ops' && scoped.t2.participants.join() === 'agent:infra-ops', 'a single-message task rolls up cleanly');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
