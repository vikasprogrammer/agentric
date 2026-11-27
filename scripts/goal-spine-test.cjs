#!/usr/bin/env node
/* Goals as the spine — Goal → Bet → Task (docs/tasks-plan.md §8d).
 *
 * The defect: agents almost never pass `goalId` (globex, 60 days: 44 of 1,981 agent-filed tasks carried
 * one), so goal progress counted only work a strategist planned from the goal room. And `tasks.bet_id`
 * existed as a column nothing read or wrote, so a bet's work was invisible from the bet.
 *
 * Asserted:
 *  1. a task can point at a bet; the bet decides the goal; unlinking/re-pointing the goal keeps them
 *     consistent; a sub-task inherits its parent's bet; per-bet counts.
 *  2. `workContextFor` resolves a session's goal from goal:/task:/automation:/bet:/poke: provenance and
 *     NOTHING for a member's chat run (no guessing).
 *  3. over real HTTP: a task an agent files inherits its run's goal (and bet), an explicit goalId wins, a
 *     parentId wins over the session, an automation's goal is settable/clearable and validated, and the
 *     bets board carries task counts.
 * Isolated home; no tmux, no claude, no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-goal-spine-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { workContextFor } = require(path.join(ROOT, 'dist/edge/work-context.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const { os: aos, autos } = registry.get('testco');
  aos.team.bootstrapOwner('owner@localhost', 'Owner');
  const owner = aos.team.getMemberByEmail('owner@localhost');
  const alice = aos.team.invite({ email: 'alice@example.com', role: 'member' }).member;
  const cookie = (m) => `aos_sid=${aos.team.createSession(m.id)}`;
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  aos.agents.set('qa', { id: 'qa', name: 'QA', runtime: 'claude-code', dir: HOME });
  autos.dispatchTask = () => ({ ok: true }); // never spawn

  const T = aos.tenant;
  const gA = aos.goals.create({ tenant: T, title: 'Grow signups', createdBy: owner.id });
  const gB = aos.goals.create({ tenant: T, title: 'Cut churn', createdBy: owner.id });
  const bet1 = aos.bets.create({ tenant: T, goalId: gA.id, title: 'Comparison pages', createdBy: owner.id });
  const bet2 = aos.bets.create({ tenant: T, goalId: gB.id, title: 'Exit survey', createdBy: owner.id });

  console.log('\n\x1b[1m1) a task points at a bet; the bet decides the goal\x1b[0m');
  {
    const t = aos.tasks.create({ tenant: T, title: 'Write vs-X page', betId: bet1.id, goalId: gB.id, createdBy: owner.id });
    assert(t.betId === bet1.id, 'betId stored', t.betId);
    assert(t.goalId === gA.id, "goal set to the BET's goal, not the conflicting explicit one", t.goalId);
    const ghost = aos.tasks.create({ tenant: T, title: 'ghost bet', betId: 'bet_nope', createdBy: owner.id });
    assert(!ghost.betId && !ghost.goalId, 'an unknown bet id is dropped, not stored dangling', ghost);

    const child = aos.tasks.create({ tenant: T, title: 'Screenshot for vs-X', parentId: t.id, createdBy: owner.id });
    assert(child.betId === bet1.id && child.goalId === gA.id, "a sub-task inherits its parent's bet and goal", child);

    let u = aos.tasks.update(t.id, { betId: bet2.id, by: owner.id });
    assert(u.betId === bet2.id && u.goalId === gB.id, 're-pointing the bet moves the goal with it', u);
    u = aos.tasks.update(t.id, { goalId: gA.id, by: owner.id });
    assert(u.goalId === gA.id && !u.betId, 'moving the goal off the bet’s goal drops the bet', u);
    u = aos.tasks.update(t.id, { betId: bet1.id, by: owner.id });
    u = aos.tasks.update(t.id, { goalId: gA.id, title: 'Write vs-X page (v2)', by: owner.id });
    assert(u.betId === bet1.id, 're-saving the same goal keeps the bet', u);
    u = aos.tasks.update(t.id, { goalId: null, by: owner.id });
    assert(!u.goalId && !u.betId, 'unlinking the goal unlinks the bet', u);
    u = aos.tasks.update(t.id, { betId: bet1.id, by: owner.id });
    u = aos.tasks.update(t.id, { betId: null, by: owner.id });
    assert(!u.betId && u.goalId === gA.id, 'unlinking only the bet keeps the goal', u);
    const ev = aos.tasks.withEvents ? null : null; void ev;

    aos.tasks.update(t.id, { betId: bet1.id, status: 'done', by: owner.id });
    const counts = aos.tasks.betTaskCounts([bet1.id, bet2.id]);
    assert(counts[bet1.id] && counts[bet1.id].total === 2 && counts[bet1.id].done === 1 && counts[bet1.id].open === 1, 'per-bet counts: 2 tasks, 1 done, 1 open', counts);
    assert(!counts[bet2.id], 'a bet with no tasks has no row', counts);
  }

  console.log('\n\x1b[1m2) workContextFor — the run knows its goal, or says nothing\x1b[0m');
  const goalTask = aos.tasks.create({ tenant: T, title: 'Dispatched under bet1', betId: bet1.id, assignee: 'agent:engineer', createdBy: owner.id });
  const plainTask = aos.tasks.create({ tenant: T, title: 'Unlinked work', assignee: 'agent:engineer', createdBy: owner.id });
  const au = autos.add({ agentId: 'engineer', name: 'Translation QA', type: 'cron', schedule: '0 9 * * 1', task: 'check', goalId: gB.id, createdBy: owner.id });
  const auPlain = autos.add({ agentId: 'engineer', name: 'Canary', type: 'cron', schedule: '0 * * * *', task: 'check', createdBy: owner.id });
  {
    const db = aos.db;
    let c = workContextFor(db, `goal:${gA.id}`);
    assert(c.goalId === gA.id && c.via === 'goal room', 'goal: provenance → that goal', c);
    c = workContextFor(db, `task:${goalTask.id}`);
    assert(c.goalId === gA.id && c.betId === bet1.id && c.via === `task:${goalTask.id}`, "task: provenance → the task's goal AND bet", c);
    c = workContextFor(db, `task:${plainTask.id}`);
    assert(!c.goalId, 'an unlinked task gives no context', c);
    c = workContextFor(db, `automation:${au.id}`);
    assert(c.goalId === gB.id, "automation: provenance → the automation's goal", c);
    c = workContextFor(db, `automation:${auPlain.id}`);
    assert(!c.goalId, 'an automation with no goal is operational work — no context', c);
    c = workContextFor(db, `bet:${bet2.id}`);
    assert(c.goalId === gB.id && c.betId === bet2.id, 'bet: → the bet and its goal', c);
    c = workContextFor(db, `poke:task:${goalTask.id}`);
    assert(c.goalId === gA.id && c.betId === bet1.id, "poke: resolves through to the delegate's context", c);
    c = workContextFor(db, alice.id);
    assert(!c.goalId, "a member's chat run is NOT given a guessed goal", c);
    c = workContextFor(db, `goal:gl_missing`);
    assert(!c.goalId, 'a deleted goal resolves to nothing', c);
  }

  console.log('\n\x1b[1m3) over HTTP — filed work lands under the run’s goal\x1b[0m');
  const addSession = (id, secret, runAs, spawnedBy) => aos.db.prepare(
    'INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, 'engineer', 'run', 'work', 'aos-' + id, 'running', 1, 0, secret, runAs, spawnedBy, Date.now(), Date.now());
  addSession('ses_task', 'sec-t', alice.id, `task:${goalTask.id}`);
  addSession('ses_auto', 'sec-u', null, `automation:${au.id}`);
  addSession('ses_chat', 'sec-c', alice.id, alice.id);
  const SECRETS = { ses_task: 'sec-t', ses_auto: 'sec-u', ses_chat: 'sec-c' };

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = (session, body) => fetch(`${base}/api/tasks/create`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': SECRETS[session] },
    body: JSON.stringify({ session, ...body }),
  }).then((r) => r.json());
  const member = async (m, method, route, body) => {
    const r = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', cookie: cookie(m) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    let r = await create('ses_task', { title: 'Follow-up from the dispatched run', suggestedAssignee: 'agent:qa' });
    let t = aos.tasks.get(r.id);
    assert(r.ok && t.goalId === gA.id && t.betId === bet1.id, "a task-run's filing inherits that task's goal + bet", { r, t });
    const ev = aos.db.prepare("SELECT body FROM task_events WHERE task_id = ? AND kind = 'link' ORDER BY created_at").all(r.id).map((e) => e.body);
    assert(ev.some((b) => b === `goal:${gA.id} (from task:${goalTask.id})`), 'the link event names where the goal came from', ev);

    r = await create('ses_auto', { title: 'Fix the German strings', suggestedAssignee: 'agent:qa' });
    t = aos.tasks.get(r.id);
    assert(r.ok && t.goalId === gB.id && !t.betId, "an automation run's filing inherits the automation's goal", t);

    r = await create('ses_task', { title: 'Explicitly elsewhere', goalId: gB.id, suggestedAssignee: 'agent:qa' });
    t = aos.tasks.get(r.id);
    assert(t.goalId === gB.id && !t.betId, 'an explicit goalId wins over the session context', t);

    r = await create('ses_auto', { title: 'Child of the bet1 task', parentId: goalTask.id, suggestedAssignee: 'agent:qa' });
    t = aos.tasks.get(r.id);
    assert(t.goalId === gA.id && t.betId === bet1.id, "a parentId wins over the session (parent's goal + bet)", t);

    r = await create('ses_chat', { title: 'Something alice mentioned', suggestedAssignee: 'agent:qa' });
    t = aos.tasks.get(r.id);
    assert(r.ok && !t.goalId && !t.betId, "a member chat run's filing stays unlinked", t);

    r = await create('ses_chat', { title: 'Linked by the agent', betId: bet2.id, suggestedAssignee: 'agent:qa' });
    t = aos.tasks.get(r.id);
    assert(t.betId === bet2.id && t.goalId === gB.id, 'an agent can link a bet directly (task_create betId)', t);

    // Console: task create/patch with betId.
    let m = await member(owner, 'POST', '/api/tasks', { title: 'Console task on bet2', betId: bet2.id });
    assert(m.status === 200 && m.body.task.betId === bet2.id && m.body.task.goalId === gB.id, 'console create takes betId', m.body);
    m = await member(owner, 'PATCH', `/api/tasks/${m.body.task.id}`, { betId: null });
    assert(m.status === 200 && !m.body.task.betId && m.body.task.goalId === gB.id, 'console patch unlinks the bet, keeps the goal', m.body);

    // Automations: goal validated, set, cleared.
    m = await member(owner, 'POST', '/api/automations', { agentId: 'engineer', name: 'Bad goal', type: 'cron', schedule: '0 9 * * *', task: 'x', goalId: 'gl_nope' });
    assert(m.status === 400, 'creating an automation with an unknown goal is refused', m);
    m = await member(owner, 'POST', '/api/automations', { agentId: 'engineer', name: 'Weekly docs sweep', type: 'cron', schedule: '0 9 * * 1', task: 'x', goalId: gA.id });
    assert(m.status === 200 && m.body.goalId === gA.id, 'automation created with a goal', m.body);
    const aid = m.body.id;
    m = await member(owner, 'PATCH', `/api/automations/${aid}`, { name: 'Weekly docs sweep (renamed)' });
    assert(m.status === 200 && m.body.goalId === gA.id, 'an unrelated edit keeps the goal', m.body);
    m = await member(owner, 'PATCH', `/api/automations/${aid}`, { goalId: null });
    assert(m.status === 200 && !m.body.goalId, 'goalId:null clears it', m.body);
    m = await member(owner, 'PATCH', `/api/automations/${aid}`, { goalId: 'gl_nope' });
    assert(m.status === 400, 'patching to an unknown goal is refused', m);

    // Bets board carries task counts.
    m = await member(owner, 'GET', `/api/bets?goal=${gA.id}`);
    const b1 = (m.body.bets || []).find((b) => b.id === bet1.id);
    assert(b1 && b1.tasks && b1.tasks.total >= 3 && b1.tasks.done === 1, 'GET /api/bets returns per-bet task counts', b1 && b1.tasks);
  } finally {
    server.close();
    registry.stopAll?.();
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
