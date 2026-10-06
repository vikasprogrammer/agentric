#!/usr/bin/env node
/* "Unblock & run" must never put two sessions on one task.
 *  (A) a human's console dispatch (guard:false) still refuses while the task's current run is live —
 *      the live double-click (tsk_ad11e51…: two sessions two seconds apart) and the click while the run
 *      that raised the block is still up. It still un-parks a `blocked` task, which is its point.
 *  (B) the blocked-task Inbox card carries that run's state (`args.run`: alive or ended), so the console
 *      can offer "Open session" instead of a second spawn.
 * Isolated home; no tmux, no claude, no network — createSession and the liveness poll are stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-unblock-run-test-'));
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
aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

// The tmux server, stubbed: a Set of live pane names that a test flips by hand.
const alive = new Set();
tm.backend.aliveNames = () => alive;
// Spawning, stubbed: write the row a real launch would, and bring its pane up.
let sn = 0;
const spawned = [];
tm.createSession = (agent, title, task, spawnedBy, headless, _s, _d, runAs) => {
  const id = 'ses_' + (++sn);
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,headless,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, agent, title, task, 'aos-' + id, 'running', spawnedBy, runAs ?? null, headless ? 1 : 0, Date.now(), Date.now());
  alive.add('aos-' + id);
  spawned.push(id);
  return { id, tmux: 'aos-' + id };
};
const kill = (id, status = 'done') => { alive.delete('aos-' + id); aos.db.prepare('UPDATE term_sessions SET status=? WHERE id=?').run(status, id); };

const { member } = aos.team.invite({ email: 'owner@testco.dev', role: 'owner' });
aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
const owner = aos.team.getMember(member.id);
const quiet = { dmUser: async () => false, userIdForEmail: async () => undefined };

let n = 0;
const mkTask = () => aos.tasks.create({
  tenant: aos.tenant, title: 'task ' + (++n), body: '', owner: owner.id, createdBy: owner.id,
  assignee: 'agent:engineer', autoDispatch: true,
});
const block = async (id) => {
  aos.tasks.update(id, { status: 'blocked', blockedOn: 'human', note: 'merge PR #883?', by: 'agent:engineer' });
  await notifyTaskEvent(aos, tm, quiet, quiet, 'https://console.example.com', { task: aos.tasks.get(id), kind: 'status', by: 'agent:engineer', detail: 'doing→blocked' });
};
// "Unblock & run" from the card = PATCH status→todo, then POST /dispatch (guard:false).
const unblockAndRun = (id) => {
  aos.tasks.update(id, { status: 'todo', by: owner.id });
  return autos.dispatchTask(id, { guard: false, by: owner.email });
};
const card = (taskId) => tm.listMessages(owner, 'all').find((m) => m.type === 'task' && m.args?.taskId === taskId && m.args?.event === 'blocked');

(async () => {
  console.log('\n\x1b[1mA. one live run per task, on the human path too\x1b[0m');
  const t = mkTask();
  const first = autos.dispatchTask(t.id, { guard: true });
  assert(first.ok, 'the first dispatch runs');
  await block(t.id);

  // The run that raised the block is still up → a human dispatch must not stack a second session.
  const whileLive = unblockAndRun(t.id);
  assert(!whileLive.ok && /already working/.test(whileLive.reason || ''), 'unblock & run while the blocking run is live is refused', JSON.stringify(whileLive));
  assert(spawned.length === 1, 'no second session was spawned', 'spawned=' + spawned.length);
  assert(tm.liveTaskRuns([t.id])[t.id]?.sessionId === first.sessionId, 'the live run is the one the route hands back');

  // That run ends → the human dispatch goes through (and un-parks, which is what it is for).
  kill(first.sessionId);
  await block(t.id);
  const afterEnd = unblockAndRun(t.id);
  assert(afterEnd.ok, 'once the run has ended, unblock & run dispatches', JSON.stringify(afterEnd));
  // The live double-click: the same action two seconds later.
  const second = unblockAndRun(t.id);
  assert(!second.ok, 'a second click on the same card does not spawn again', JSON.stringify(second));
  assert(spawned.length === 2, 'exactly one session per click-that-should-run', 'spawned=' + spawned.length);

  // guard:false still un-parks a blocked task (the scheduler's guard:true does not).
  kill(afterEnd.sessionId);
  aos.tasks.update(t.id, { status: 'blocked', by: 'agent:engineer' });
  assert(!autos.dispatchTask(t.id, { guard: true }).ok, 'the scheduler still respects a blocked park');
  assert(autos.dispatchTask(t.id, { guard: false, by: owner.email }).ok, 'a human dispatch still un-parks it');

  console.log('\n\x1b[1mB. the blocked card says whether that run is still up\x1b[0m');
  const u = mkTask();
  const run = autos.dispatchTask(u.id, { guard: true });
  await block(u.id);
  let c = card(u.id);
  assert(c?.args?.run?.sessionId === run.sessionId && c.args.run.alive === true, 'live run → args.run.alive = true', JSON.stringify(c?.args?.run));
  kill(run.sessionId, 'crashed');
  c = card(u.id);
  assert(c?.args?.run?.alive === false && c.args.run.status === 'crashed', 'ended run → alive = false, with its status', JSON.stringify(c?.args?.run));
  const v = mkTask();
  await block(v.id);
  assert(card(v.id) && card(v.id).args.run === undefined, 'a task that never ran carries no run');

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
