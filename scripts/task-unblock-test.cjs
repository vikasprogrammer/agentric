#!/usr/bin/env node
/* Blocked-task unblock path — the three halves of "Task blocked — needs you" being actionable:
 *  (A) routing: a block is only an ASK when it says it is on a `human`; a block behind unfinished
 *      dependencies notifies nobody (it clears itself), and any other park is a quiet card with no DM.
 *  (B) the settled-deps sweep: a task parked behind blockers goes back to `todo` once they all finish,
 *      which nothing did before — `dispatchable()` is todo-only, so it stayed blocked forever.
 *  (C) unblock-by-DM-reply: task_dms → TerminalManager.unblockTaskFromChat files the reply as the task's
 *      comment and returns it to the board, plus the card sync that closes the "needs you" card.
 * Isolated home; no tmux, no claude, no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-unblock-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { notifyTaskEvent } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
// The sweep re-dispatches what it un-parks; stub the spawn so no tmux/claude is needed.
const dispatched = [];
autos.dispatchTask = (id) => (dispatched.push(id), { ok: true, sessionId: 'ses_stub' });

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
aos.team.setIdentity(owner.id, 'slack', 'U_OWNER');

// The DM sinks, stubbed: we only care THAT a DM went out and what it said.
let dms = [];
const slack = { dmUser: async (user, text) => { dms.push({ user, text }); return true; }, userIdForEmail: async () => undefined };
const discord = { dmUser: async () => false };

let n = 0;
const mkTask = (o = {}) => aos.tasks.create({
  // `aos.tenant` (not the env var) is what every store scopes on — the sweep queries by it.
  tenant: aos.tenant, title: 'task ' + (++n), body: '', owner: owner.id, createdBy: owner.id,
  assignee: 'agent:engineer', autoDispatch: true, ...o,
});
const block = (id, blockedOn, note) => aos.tasks.update(id, { status: 'blocked', blockedOn, note, by: 'agent:engineer' });
const notice = (task) => ({ task, kind: 'status', by: 'agent:engineer', detail: 'doing→blocked' });
const cards = (taskId) => aos.db.prepare("SELECT id, title, status, args FROM messages WHERE type='task' AND session_id=?").all('task:' + taskId);

(async () => {
  console.log('\n\x1b[1mA. who a block is actually on decides who hears about it\x1b[0m');

  // 1. Blocked on a HUMAN → the ask: card + DM, and the DM carries the agent's own reason.
  const t1 = mkTask({ title: 'needs a decision' });
  block(t1.id, 'human', 'Which Turbo spec is right — 12 GB or 16 GB? The brief and the pricing card disagree.');
  await notifyTaskEvent(aos, tm, slack, discord, 'https://console.example.com', notice(aos.tasks.get(t1.id)));
  const c1 = cards(t1.id);
  assert(c1.length === 1 && /needs you/.test(c1[0].title), 'human block posts a "needs you" card', JSON.stringify(c1.map((c) => c.title)));
  assert(dms.length === 1, 'human block DMs the owner', 'dms=' + dms.length);
  assert(/Which Turbo spec is right/.test(dms[0]?.text ?? ''), 'the DM carries the agent’s reason, not just the title');
  assert(/Reply to this message to unblock/.test(dms[0]?.text ?? ''), 'the DM says how to answer it');
  assert(JSON.parse(c1[0].args).reason.startsWith('Which Turbo spec'), 'the card carries the reason too');
  const bound = aos.db.prepare('SELECT * FROM task_dms WHERE task_id=?').all(t1.id);
  assert(bound.length === 1 && bound[0].external_id === 'U_OWNER', 'the task is bound to the owner’s DM for a reply');

  // 2. Blocked behind an unfinished dependency → nobody is told. This is the live instapods case: an
  //    agent chained its work behind a revert PR and the owner got a "needs you" for a machine wait.
  dms = [];
  const blocker = mkTask({ title: 'the revert PR' });
  const t2 = mkTask({ title: 'chained behind the revert', dependsOn: [blocker.id] });
  block(t2.id, 'agent', 'Waiting on the revert to merge + deploy.');
  await notifyTaskEvent(aos, tm, slack, discord, 'https://console.example.com', notice(aos.tasks.get(t2.id)));
  assert(cards(t2.id).length === 0, 'a dependency-parked block posts no card');
  assert(dms.length === 0, 'a dependency-parked block sends no DM', 'dms=' + dms.length);

  // 3. Parked on an agent with no dependency edge → a card (somebody must eventually act) but no DM.
  dms = [];
  const t3 = mkTask({ title: 'parked, no blockers named' });
  block(t3.id, 'agent', 'Standing down.');
  await notifyTaskEvent(aos, tm, slack, discord, 'https://console.example.com', notice(aos.tasks.get(t3.id)));
  assert(cards(t3.id).length === 1 && /waiting on an agent/.test(cards(t3.id)[0].title), 'an undependent agent park still posts a card');
  assert(dms.length === 0, 'but it does not interrupt anyone with a DM', 'dms=' + dms.length);

  console.log('\n\x1b[1mB. a settled block returns to the board by itself\x1b[0m');
  // A human block with a finished dependency, and a task parked by the attempt ceiling: neither is the
  // sweep's business — one is a person's decision, the other is a failing task deliberately stopped.
  const t4 = mkTask({ title: 'failed too many times', dependsOn: [blocker.id] });
  block(t4.id, 'agent', 'giving up');
  aos.db.prepare('UPDATE tasks SET attempts = 4 WHERE id = ?').run(t4.id);
  const humanWithDep = mkTask({ title: 'human block behind a dep', dependsOn: [blocker.id] });
  block(humanWithDep.id, 'human', 'need sign-off');

  autos.sweepSettledBlocked();
  assert(aos.tasks.get(t2.id).status === 'blocked', 'not while its blocker is unfinished');
  assert(aos.tasks.settledBlocked(aos.tenant).length === 0, 'nothing is sweepable yet');

  aos.tasks.update(blocker.id, { status: 'done', by: owner.id });
  autos.sweepSettledBlocked();
  assert(aos.tasks.get(t2.id).status === 'todo', 'once every blocker is done it goes back on the board');
  assert(/Dependencies cleared/.test(aos.tasks.lastComment(t2.id) ?? ''), 'and says so in the task log');
  assert(aos.tasks.get(t3.id).status === 'blocked', 'a park with no blockers named is never swept (that would undo a decision)');
  assert(aos.tasks.get(humanWithDep.id).status === 'blocked', 'a human block is never swept, whatever its dependencies');
  assert(aos.tasks.get(t4.id).status === 'blocked', 'an attempt-ceiling park is never swept');

  console.log('\n\x1b[1mC. a DM reply unblocks it\x1b[0m');
  const r = tm.unblockTaskFromChat('slack', 'U_OWNER', 'Use 12 GB — the pricing card is right.');
  assert(r && r.taskId === t1.id, 'the reply is matched back to the task we DM’d them about');
  assert(aos.tasks.get(t1.id).status === 'todo', 'the task goes back on the board');
  const evs = aos.db.prepare("SELECT body, author FROM task_events WHERE task_id=? AND kind='comment' ORDER BY created_at DESC").all(t1.id);
  assert(/Use 12 GB/.test(evs[0]?.body ?? ''), 'the reply is filed as the task’s next comment');
  assert(evs[0]?.author === owner.id, 'attributed to the human who replied, not the agent');
  assert(tm.unblockTaskFromChat('slack', 'U_OWNER', 'and another thing') === null, 'a second reply claims nothing (the task is no longer blocked)');
  assert(tm.unblockTaskFromChat('slack', 'U_NOBODY', 'hello') === null, 'an unbound sender claims nothing');

  tm.syncTaskBlockedCards(t1.id);
  assert(cards(t1.id)[0].status !== 'open', 'unblocking closes the "needs you" card');
  tm.syncTaskBlockedCards(t3.id);
  assert(cards(t3.id)[0].status === 'open', 'a still-blocked task keeps its card');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
