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
const { TerminalManager, renderOptions, resolveOptionReply } = require(path.join(ROOT, 'dist/terminal.js'));
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
let sn = 0;
// A term_sessions row the task points at, so `taskAsk` can find the run's question.
const mkSession = (taskId) => {
  const id = 'ses_' + (++sn);
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'engineer', 't', 'x', 'aos-' + id, 'running', 'task:' + taskId, owner.id, 'cs_' + id, Date.now(), Date.now());
  aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(id, taskId);
  return id;
};
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

  console.log('\n\x1b[1mD. the block carries the ASK, not the progress log\x1b[0m');
  // The shape that made the first live block unanswerable: the run asked a four-option question, waited,
  // gave up, parked the task and ended — cancelling the question two minutes after DMing it.
  const OPTS = ['1. Fix disclosure + copy, then flip (recommended)', '2. Fix copy only; flag stays OFF', '3. Flip now, disclosure later', '4. Not now'];
  assert(renderOptions(OPTS).split('\n')[0] === '1. Fix disclosure + copy, then flip (recommended)', 'an already-numbered option is not numbered twice');
  assert(renderOptions(['Ship it', 'Hold'])[0] === '1', 'an unnumbered option gets its number');
  assert(resolveOptionReply('2', OPTS) === OPTS[1], 'a bare number picks that option');
  assert(resolveOptionReply('  4. ', OPTS) === OPTS[3], 'so does a number with its punctuation');
  assert(resolveOptionReply('fix copy only; flag stays off', OPTS) === OPTS[1], 'so does the option text, ordinal-stripped and case-insensitive');
  assert(resolveOptionReply('9', OPTS) === undefined, 'a number outside the list picks nothing');
  assert(resolveOptionReply('let me think about it', OPTS) === undefined, 'and free prose is left as the human\u2019s own words');

  dms = [];
  const t5 = mkTask({ title: 'flip the flag?' });
  const ses = mkSession(t5.id);
  aos.tasks.update(t5.id, { status: 'doing', by: 'agent:engineer' });
  tm.askQuestion(ses, 'engineer', 'Sending redacted customer logs to Anthropic — which do you want?', undefined, OPTS);
  block(t5.id, 'human', 'Part 1 complete. Part 2 re-asked in the owner Inbox; no answer within the run window. Unblock by answering the Inbox question.');
  await notifyTaskEvent(aos, tm, slack, discord, 'https://console.example.com', notice(aos.tasks.get(t5.id)));
  const dm = dms[0]?.text ?? '';
  assert(/which do you want\?/i.test(dm), 'the DM leads with the QUESTION, not the progress comment');
  assert(!/Unblock by answering the Inbox question/.test(dm), 'the progress comment is not what gets sent');
  assert(/1\. Fix disclosure/.test(dm) && /4\. Not now/.test(dm), 'and it lists every choice, numbered');
  assert(/just the number/.test(dm), 'and says a number is enough');
  const c5 = JSON.parse(cards(t5.id)[0].args);
  assert(Array.isArray(c5.options) && c5.options.length === 4, 'the card carries the choices for its one-click buttons');

  const r5 = tm.unblockTaskFromChat('slack', 'U_OWNER', '2');
  assert(r5 && r5.taskId === t5.id, 'replying "2" unblocks it');
  assert(aos.tasks.lastComment(t5.id) === OPTS[1], 'and the DECISION is filed, not the digit');

  // The ask outlives the run that raised it: ending the session cancels the question, which is right —
  // but the task it blocked keeps the text, so the human is not left holding a cancelled card.
  const t6 = mkTask({ title: 'second decision' });
  const ses6 = mkSession(t6.id);
  tm.askQuestion(ses6, 'engineer', 'Which region should the failover live in?', undefined, ['us-east', 'eu-west']);
  block(t6.id, 'human', 'waiting on the founder');
  tm.stopSession(ses6, 'system');
  assert(/Which region should the failover live in\?/.test(aos.tasks.lastComment(t6.id) ?? ''), 'a question cancelled at session end is filed onto its blocked task');
  assert(aos.db.prepare("SELECT status FROM questions WHERE run_id = ?").get(ses6).status === 'cancelled', 'the question itself is still cancelled (nobody can answer a dead pane)');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
