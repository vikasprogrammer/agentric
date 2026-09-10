#!/usr/bin/env node
/* Task proposals — a task an AGENT files without dispatching it waits for a person's accept.
 *
 * The defect it answers: on the live fleet agents file ~all tasks (instapods, 14 days: 140 of 140, 0 by a
 * human), and half are board items nobody agreed to — `engineer` alone left 31 unassigned `todo`s. They
 * are usually real findings, but they skipped triage and read as committed work.
 *
 * So a non-dispatching agent task lands `proposed`: never dispatched or claimed, grouped onto ONE Inbox
 * card per run, accepted (→ todo) or dismissed (→ cancelled) by the run's accountable human or an admin.
 *
 * What must NOT regress, and is asserted: an auto-dispatch hand-off (a caller may be blocked on it in
 * task_wait — holding it would hang the caller on a click), a goal-plan/goal-room run (a human asked for
 * that plan), a human's own task, and the whole lane switched off by the workspace setting.
 * Isolated home; no tmux, no claude, no ttyd — the routes are driven over real HTTP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-proposals-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const { os: aos, tm, autos } = registry.get('testco');

  aos.team.bootstrapOwner('owner@localhost', 'Owner');
  const owner = aos.team.getMemberByEmail('owner@localhost');
  const alice = aos.team.invite({ email: 'alice@example.com', role: 'member' }).member;
  const bob = aos.team.invite({ email: 'bob@example.com', role: 'member' }).member;
  const cookie = (m) => `aos_sid=${aos.team.createSession(m.id)}`;

  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  aos.agents.set('qa', { id: 'qa', name: 'QA', runtime: 'claude-code', dir: HOME });
  const addSession = (id, secret, runAs, spawnedBy) => aos.db.prepare(
    'INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(id, 'engineer', 'run', 'work', 'aos-' + id, 'running', 1, 0, secret, runAs, spawnedBy, Date.now(), Date.now());
  addSession('ses_a', 'sec-a', alice.id, alice.id);        // a run alice started — she is accountable
  addSession('ses_b', 'sec-b', null, 'automation:au_1');   // a company-identity cron run — admins decide
  addSession('ses_g', 'sec-g', alice.id, 'goal:gl_1');      // a goal-plan run a human asked for

  const dispatched = [];
  const realDispatch = autos.dispatchTask.bind(autos);
  autos.dispatchTask = (id, opts) => { dispatched.push(id); return { ok: true }; };

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const SECRETS = { ses_a: 'sec-a', ses_b: 'sec-b', ses_g: 'sec-g' };
  const agentPost = (route, session, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': SECRETS[session] },
    body: JSON.stringify({ session, ...body }),
  }).then((r) => r.json());
  const create = (session, body) => agentPost('/api/tasks/create', session, body);
  const member = async (m, method, route, body) => {
    const r = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', cookie: cookie(m) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const cards = (session) => aos.db.prepare("SELECT * FROM messages WHERE type = 'task.proposed' AND session_id = ? ORDER BY created_at").all(session);
  const taskCards = (taskId) => aos.db.prepare("SELECT * FROM messages WHERE type = 'task' AND session_id = ?").all(`task:${taskId}`);

  console.log('\n\x1b[1m1) an agent board item lands as a PROPOSAL, not work\x1b[0m');
  const r1 = await create('ses_a', { title: 'GET /api/pods caps at 20', body: 'found while fixing X' });
  {
    assert(r1.ok === true && r1.proposed === true, 'accepted by the route, flagged proposed', r1);
    const t = aos.tasks.get(r1.id);
    assert(t.status === 'proposed', 'status is proposed', t.status);
    assert(t.owner === alice.id, "owner = the run's accountable human", t.owner);
    const c = cards('ses_a');
    assert(c.length === 1 && c[0].status === 'open', 'one open Inbox card for the run', c.length);
    assert(c[0].audience_kind === 'member' && c[0].audience_id === alice.id, "addressed to the run-as human, not the whole admin tier", c[0]);
    const ev = aos.db.prepare("SELECT count(*) n FROM audit_events WHERE type = 'task.proposed'").get().n;
    assert(ev === 1, 'audited as task.proposed', ev);
  }

  console.log('\n\x1b[1m2) ONE card per run — a busy run does not flood the inbox\x1b[0m');
  const r2 = await create('ses_a', { title: 'Split the backfill skipped bucket', assignee: 'agent:qa' });
  const r3 = await create('ses_a', { title: 'Ask the team about env saves', assignee: bob.id });
  {
    const c = cards('ses_a');
    assert(c.length === 1, 'still one card after three filings', c.length);
    const args = JSON.parse(c[0].args);
    assert(args.tasks.length === 3, 'the card lists all three', args.tasks.map((x) => x.title));
    assert(/3 tasks/.test(c[0].title), 'and its title counts them', c[0].title);
    const rb = await create('ses_b', { title: 'cron finding' });
    const cb = cards('ses_b');
    assert(cb.length === 1 && cb[0].audience_kind === 'admins', 'a company-identity run gets its own card, addressed to admins', cb[0]);
    assert(rb.proposed === true, 'and is proposed too', rb);
  }

  console.log('\n\x1b[1m3) a proposal is not workable until accepted\x1b[0m');
  {
    assert(taskCards(r3.id).length === 0, 'the human assignee got NO "assigned to you" yet', taskCards(r3.id).length);
    const claim = await agentPost('/api/tasks/claim', 'ses_a', { id: r1.id });
    assert(claim.ok === false, 'an agent cannot claim it', claim);
    const can = autos.canDispatch(r2.id, { guard: false });
    assert(can.ok === false && can.code === 'proposed', 'no dispatch path runs it, a human console dispatch included', can);
    const up = await agentPost('/api/tasks/update', 'ses_a', { id: r1.id, status: 'todo' });
    assert(up.ok === false && /human/.test(up.error || ''), 'the agent cannot accept its own proposal', up);
    assert(aos.tasks.get(r1.id).status === 'proposed', 'and it is still proposed');
    const back = await agentPost('/api/tasks/update', 'ses_a', { id: r2.id, note: 'more detail' });
    assert(back.ok === true, 'but it may still refine it (a note / details)', back);
  }

  console.log('\n\x1b[1m4) what must NOT regress\x1b[0m');
  {
    const h = await create('ses_a', { title: 'verify PR 12', assignee: 'agent:qa', autoDispatch: true });
    assert(h.ok === true && !h.proposed, 'an auto-dispatch hand-off is NOT held — a caller may be waiting on it', h);
    assert(aos.tasks.get(h.id).status === 'todo', 'it is todo', aos.tasks.get(h.id).status);
    assert(dispatched.includes(h.id), 'and dispatches immediately');
    const g = await create('ses_g', { title: 'plan step 1', assignee: 'agent:qa' });
    assert(g.ok === true && !g.proposed && aos.tasks.get(g.id).status === 'todo', 'a goal-plan run files straight to the board', g);
    const mine = await member(alice, 'POST', '/api/tasks', { title: 'my own task' });
    assert(mine.body.task && mine.body.task.status === 'todo', "a human's own task is todo from birth", mine.body);
  }

  console.log('\n\x1b[1m5) deciding: who may, and what each verdict does\x1b[0m');
  {
    const deny = await member(bob, 'POST', '/api/tasks/proposals/decide', { ids: [r1.id], action: 'accept' });
    assert(deny.status === 403, 'a bystander member cannot decide someone else\'s proposal', deny);
    assert(aos.tasks.get(r1.id).status === 'proposed', 'and nothing moved');
    const patchDeny = await member(bob, 'PATCH', `/api/tasks/${r1.id}`, { status: 'todo' });
    assert(patchDeny.status === 403, 'the board PATCH is gated the same way — no side door', patchDeny);

    const ok = await member(alice, 'POST', '/api/tasks/proposals/decide', { ids: [r3.id], action: 'accept' });
    assert(ok.status === 200 && ok.body.decided.length === 1, 'the run-as human accepts one', ok);
    assert(aos.tasks.get(r3.id).status === 'todo', 'accepted → todo');
    assert(taskCards(r3.id).length === 1, 'NOW the human assignee gets "assigned to you"', taskCards(r3.id).length);
    assert(cards('ses_a')[0].status === 'open', 'the card stays open while others are undecided');

    const listed = tm.listMessages(alice, 'mine').find((m) => m.type === 'task.proposed');
    const st = Object.fromEntries(listed.args.tasks.map((x) => [x.id, x.status]));
    assert(st[r3.id] === 'todo' && st[r1.id] === 'proposed', 'the inbox card shows each task\'s LIVE status', st);

    await member(alice, 'POST', '/api/tasks/proposals/decide', { ids: [r1.id], action: 'dismiss' });
    assert(aos.tasks.get(r1.id).status === 'cancelled', 'dismissed → cancelled (the record survives)');
    // The last one decided on the BOARD, not the card — the card must still close.
    const viaBoard = await member(owner, 'PATCH', `/api/tasks/${r2.id}`, { status: 'todo' });
    assert(viaBoard.status === 200, 'an admin can accept from the board', viaBoard);
    assert(cards('ses_a')[0].status === 'approved', 'every task decided → the card closes, however they were decided', cards('ses_a')[0].status);
    const acc = aos.db.prepare("SELECT count(*) n FROM audit_events WHERE type IN ('task.proposal.accepted','task.proposal.dismissed')").get().n;
    assert(acc === 2, 'card decisions are audited', acc);
  }

  console.log('\n\x1b[1m6) "dismiss all" on a card, and a deleted proposal closes its card\x1b[0m');
  {
    const cb = cards('ses_b')[0];
    const all = await member(owner, 'POST', '/api/tasks/proposals/decide', { messageId: cb.id, action: 'dismiss' });
    assert(all.status === 200 && all.body.decided.length === 1, 'messageId decides every task on that card', all);
    assert(cards('ses_b')[0].status === 'rejected', 'all dismissed → the card reads rejected', cards('ses_b')[0].status);

    addSession('ses_d', 'sec-d', alice.id, alice.id); SECRETS.ses_d = 'sec-d';
    const d = await create('ses_d', { title: 'to be deleted' });
    const del = await member(owner, 'DELETE', `/api/tasks/${d.id}`);
    assert(del.status === 200, 'an admin deletes the proposal', del);
    assert(cards('ses_d')[0].status === 'rejected', 'and its card closes rather than asking about a task that is gone', cards('ses_d')[0].status);
  }

  console.log('\n\x1b[1m7) nothing moves INTO proposed; goals ignore it; the queue is capped\x1b[0m');
  {
    const td = aos.tasks.create({ tenant: 'testco', title: 'plain', createdBy: owner.id });
    const into = await member(owner, 'PATCH', `/api/tasks/${td.id}`, { status: 'proposed' });
    assert(into.status === 400, 'a human cannot park a real task as "proposed"', into);
    const intoA = await agentPost('/api/tasks/update', 'ses_a', { id: td.id, status: 'proposed' });
    assert(intoA.ok === false, 'nor can an agent', intoA);

    const goal = aos.goals.create({ tenant: 'testco', title: 'G', createdBy: owner.id });
    aos.tasks.create({ tenant: 'testco', title: 'real', goalId: goal.id, createdBy: owner.id });
    aos.tasks.create({ tenant: 'testco', title: 'maybe', goalId: goal.id, createdBy: 'agent:engineer', status: 'proposed' });
    const pg = aos.goals.progress(goal.id);
    assert(pg.counted === 1, 'an unaccepted proposal does not count against a goal', pg);

    addSession('ses_c', 'sec-c', alice.id, alice.id); SECRETS.ses_c = 'sec-c';
    let last;
    for (let i = 0; i < 30; i++) { last = await create('ses_c', { title: `flood ${i}` }); if (!last.ok) break; }
    assert(last.ok === false && /waiting for a human/.test(last.error || ''), 'past 25 open proposals the agent is told to stop', last);
    const open = aos.tasks.openProposals('testco', 'agent:engineer');
    assert(open <= 26, 'the queue stays bounded', open);
    const dup = cards('ses_c');
    assert(dup.length === 1, 'and 25 filings are still ONE card', dup.length);
  }

  console.log('\n\x1b[1m8) the workspace switch turns the lane off\x1b[0m');
  {
    const sw = await member(owner, 'PUT', '/api/settings/task-proposals', { enabled: false });
    assert(sw.status === 200 && sw.body.enabled === false, 'owner turns it off', sw);
    const swDeny = await member(alice, 'PUT', '/api/settings/task-proposals', { enabled: true });
    assert(swDeny.status === 403, 'a member cannot flip it', swDeny);
    addSession('ses_e', 'sec-e', alice.id, alice.id); SECRETS.ses_e = 'sec-e';
    const off = await create('ses_e', { title: 'straight on' });
    assert(off.ok === true && !off.proposed && aos.tasks.get(off.id).status === 'todo', 'off → an agent task is todo again', off);
    assert(cards('ses_e').length === 0, 'and no card is posted');
  }

  autos.dispatchTask = realDispatch;
  server.close();
  await registry.stopAll?.();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
