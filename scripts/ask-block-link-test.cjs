#!/usr/bin/env node
/* One decision, two cards: an agent that `ask`s and then parks its task `blocked` raises "needs your
 * input" AND "task blocked — needs you". Answering EITHER must resolve both.
 *  (1) answer the question → the answer is filed on the task, the task returns to the board (its blocked
 *      card closes) and the task is dispatched with the Q/A in its prompt.
 *  (2) the asking run's pane is still winding down → the dispatch retries until it's gone (never two runs).
 *  (3) unblock the task with a note → the question is answered with that note; with no note → cancelled.
 *  (4) the agent leaving its own block settles nothing; a dependency park is never unblocked by an answer.
 * Real tenant wiring (TenantRegistry), isolated home; createSession + liveness stubbed — no tmux/claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-block-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.AOS_ANSWER_RETRY_MS = '40';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');

  const alive = new Set();
  tm.backend.aliveNames = () => alive;
  let sn = 0;
  const spawned = [];
  const mkRun = (taskId) => {
    const id = 'ses_ab' + (++sn);
    aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,headless,claude_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)')
      .run(id, 'engineer', 't', 'x', 'aos-' + id, 'running', 'task:' + taskId, owner.id, 'cs_' + id, Date.now(), Date.now());
    aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(id, taskId);
    return id;
  };
  tm.createSession = (agent, title, task, spawnedBy) => {
    const id = mkRun(spawnedBy.slice('task:'.length));
    alive.add('aos-' + id);
    spawned.push({ id, task });
    return { id, tmux: 'aos-' + id };
  };
  const end = (sid) => { alive.delete('aos-' + sid); aos.db.prepare("UPDATE term_sessions SET status='done' WHERE id=?").run(sid); };

  let n = 0;
  const mkTask = (o = {}) => aos.tasks.create({ tenant: aos.tenant, title: 'task ' + (++n), body: '', owner: owner.id, createdBy: owner.id, assignee: 'agent:engineer', ...o });
  // The live shape: the run asks, then parks the task.
  const askThenBlock = (task, blockedOn = 'human') => {
    const sid = mkRun(task.id);
    const q = tm.askQuestion(sid, 'engineer', 'Sweep now or wait for the 24h cutoff?', undefined, ['Now', 'Wait']);
    aos.tasks.update(task.id, { status: 'blocked', blockedOn, note: 'waiting on the sweep decision', by: 'agent:engineer' });
    return { sid, qid: q.id };
  };
  const blockedCardOpen = (taskId) => !!aos.db.prepare("SELECT 1 FROM messages WHERE type='task' AND status='open' AND session_id=? AND args LIKE '%\"event\":\"blocked\"%'").get('task:' + taskId);
  const qrow = (id) => aos.db.prepare('SELECT status, answer FROM questions WHERE id = ?').get(id);
  const questionNeedsYou = (id) => tm.listMessages(owner, 'all').some((m) => m.type === 'question' && m.questionId === id && m.status === 'pending');

  console.log('\n\x1b[1m1) answering the question resolves the blocked task\x1b[0m');
  const t1 = mkTask();
  const a1 = askThenBlock(t1);
  end(a1.sid);
  assert(blockedCardOpen(t1.id) && questionNeedsYou(a1.qid), 'both cards are up', { card: blockedCardOpen(t1.id), q: questionNeedsYou(a1.qid) });
  tm.answerQuestion(a1.qid, 'Wait', owner.email);
  assert(['todo', 'doing'].includes(aos.tasks.get(t1.id).status), 'the task is unblocked (and picked straight back up)', aos.tasks.get(t1.id).status);
  assert(/Answered: Wait/.test(aos.tasks.lastComment(t1.id) ?? ''), 'the answer is filed on the task', aos.tasks.lastComment(t1.id));
  assert(!blockedCardOpen(t1.id), 'the blocked card closed');
  assert(!questionNeedsYou(a1.qid), 'the question card left "needs you"');
  assert(spawned.length === 1 && /A: Wait/.test(spawned[0].task), 'the task was dispatched with the Q/A in its prompt', spawned.map((s) => s.task.slice(-200)));

  console.log('\n\x1b[1m2) the asking pane is still up → wait for it, never a second run\x1b[0m');
  const t2 = mkTask();
  const a2 = askThenBlock(t2);
  alive.add('aos-' + a2.sid); // turn-end reap hasn't happened yet
  const before = spawned.length;
  tm.answerQuestion(a2.qid, 'Now', owner.email);
  await sleep(120);
  assert(spawned.length === before, 'no dispatch while the asking run is live', spawned.length - before);
  end(a2.sid);
  await sleep(150);
  assert(spawned.length === before + 1 && /A: Now/.test(spawned.at(-1).task), 'dispatched once the pane is gone', spawned.length - before);

  console.log('\n\x1b[1m3) unblocking the task settles the question\x1b[0m');
  const t3 = mkTask();
  const a3 = askThenBlock(t3);
  end(a3.sid);
  aos.tasks.update(t3.id, { status: 'todo', note: 'Wait for the cutoff', by: owner.id });
  assert(qrow(a3.qid).status === 'answered' && qrow(a3.qid).answer === 'Wait for the cutoff', 'a note on the unblock IS the answer', qrow(a3.qid));
  assert(!questionNeedsYou(a3.qid) && !blockedCardOpen(t3.id), 'both cards are gone');
  const t4 = mkTask();
  const a4 = askThenBlock(t4);
  end(a4.sid);
  aos.tasks.update(t4.id, { status: 'todo', by: owner.id });
  assert(qrow(a4.qid).status === 'cancelled', 'no note → the question is cancelled', qrow(a4.qid));
  assert(!questionNeedsYou(a4.qid), 'and leaves "needs you"');

  console.log('\n\x1b[1m4) what does NOT link\x1b[0m');
  const t5 = mkTask();
  const a5 = askThenBlock(t5);
  aos.tasks.update(t5.id, { status: 'doing', by: 'agent:engineer' });
  assert(qrow(a5.qid).status === 'pending', 'the agent leaving its own block is not an answer to its own question', qrow(a5.qid));
  const dep = mkTask({ title: 'blocker' });
  const t6 = mkTask({ dependsOn: [dep.id] });
  const a6 = askThenBlock(t6, 'agent');
  end(a6.sid);
  tm.answerQuestion(a6.qid, 'Now', owner.email);
  assert(aos.tasks.get(t6.id).status === 'blocked', 'a park behind an unfinished dependency stays parked', aos.tasks.get(t6.id).status);

  console.log(`\n${pass} passed, ${fail} failed`);
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
