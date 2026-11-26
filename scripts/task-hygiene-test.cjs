#!/usr/bin/env node
/* Board cleanup (src/edge/task-hygiene.ts) + the board-truth fixes that ride with it:
 *  A. archive rules — stale agent work, orphans of closed parents, expired proposals — and what is
 *     NEVER touched (a person's work, a live run, a future due date, anything fresh).
 *  B. stalled `doing` → todo, or → blocked when it would otherwise silently re-dispatch.
 *  C. the archive is silent, restorable, out of the board load and out of the counts.
 *  D. assignee normalization (store writes + the sweep over old rows).
 *  E. the agent lane: duplicate titles are pointed at the open task; unknown people are refused.
 *  F. the console board load returns every open task, not the first 500 rows.
 * Isolated home; no tmux, no claude, no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-hygiene-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { planTaskHygiene, applyTaskHygiene } = require(path.join(ROOT, 'dist/edge/task-hygiene.js'));

const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos, tm, autos } = registry.get('testco');
autos.dispatchTask = () => ({ ok: true });
const DAY = 86_400_000;
const NOW = Date.now();

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const janak = mkMember('janak@testco.dev', 'member');

let n = 0;
const mk = (o = {}, idleDays = 0) => {
  const t = aos.tasks.create({ tenant: aos.tenant, title: o.title ?? `task ${++n}`, body: '', createdBy: 'agent:engineer', ...o });
  if (o.statusAfter) aos.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(o.statusAfter, t.id);
  aos.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(NOW - idleDays * DAY, t.id);
  return t.id;
};
let sn = 0;
const mkSession = (taskId, status) => {
  const id = 'ses_' + (++sn);
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'engineer', 't', 'x', 'aos-' + id, status, 'task:' + taskId, NOW);
  aos.db.prepare('UPDATE tasks SET last_session_id = ? WHERE id = ?').run(id, taskId);
};
const get = (id) => aos.tasks.get(id);

// Count notifier fires: cleanup must be silent.
let notices = 0;
aos.tasks.setNotifier(() => { notices++; });

console.log('\n\x1b[1mA. what gets archived, and what never does\x1b[0m');
const stale = mk({ assignee: 'agent:engineer' }, 45);
const staleUnassigned = mk({}, 45);
const fresh = mk({ assignee: 'agent:engineer' }, 5);
const humanFiled = mk({ createdBy: owner.id }, 90);
const humanHeld = mk({ assignee: janak.id }, 90);
const futureDue = mk({ dueAt: NOW + 10 * DAY }, 60);
const liveRun = mk({ assignee: 'agent:engineer', statusAfter: 'doing' }, 60); mkSession(liveRun, 'running');
const parent = mk({ title: 'umbrella' }, 1); aos.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(parent);
const orphan = mk({ parentId: parent }, 10);
const freshOrphan = mk({ parentId: parent }, 2);
const oldProposal = mk({ status: 'proposed', suggestedAssignee: 'agent:engineer' }, 20);
const newProposal = mk({ status: 'proposed', suggestedAssignee: 'agent:engineer' }, 3);
const stalledTodo = mk({ assignee: 'agent:engineer', statusAfter: 'doing' }, 5); mkSession(stalledTodo, 'done');
const stalledAuto = mk({ assignee: 'agent:engineer', autoDispatch: true, statusAfter: 'doing' }, 5);
const humanDoing = mk({ createdBy: owner.id, assignee: owner.id, statusAfter: 'doing' }, 10);
const humanFiledAgentDoing = mk({ createdBy: owner.id, assignee: 'agent:engineer', statusAfter: 'doing' }, 60);

const plan = planTaskHygiene(aos, NOW);
const ruleOf = (id) => plan.archive.find((i) => i.id === id)?.rule;
assert(ruleOf(stale) === 'stale' && ruleOf(staleUnassigned) === 'stale', 'agent work idle 30+ days is planned as stale');
assert(ruleOf(orphan) === 'orphan', 'a child of a closed parent idle 7+ days is planned as an orphan');
assert(ruleOf(oldProposal) === 'proposal', 'a proposal undecided 14+ days is planned to expire');
for (const [id, name] of [[fresh, 'fresh agent work'], [humanFiled, 'a task a person filed'], [humanHeld, 'a task a person holds'],
  [futureDue, 'a task due in the future'], [liveRun, 'a task with a live run'], [freshOrphan, 'a just-filed child of a closed parent'],
  [newProposal, 'a recent proposal'], [humanDoing, "a person's own doing"]]) {
  assert(!ruleOf(id) && !plan.settle.some((i) => i.id === id), `never touched: ${name}`);
}
notices = 0;
const r = applyTaskHygiene(aos, {}, NOW);
assert(r.archived.stale === 2 && r.archived.orphan === 1 && r.archived.proposal === 1, 'apply archives exactly the planned set', JSON.stringify(r.archived));
assert(get(stale).status === 'cancelled' && get(stale).archivedAt && /no activity in 45 days/.test(get(stale).archivedReason), 'archived = cancelled + archivedAt + a reason');
assert(get(fresh).status === 'todo' && get(humanFiled).status === 'todo' && get(liveRun).status === 'doing', 'exempt tasks are untouched after apply');
assert(notices === 0, 'cleanup fires no notifier (no cards, DMs or caller wake-ups)', 'notices=' + notices);
const ev = aos.tasks.withEvents(stale).events.map((e) => e.body);
assert(ev.includes('todo→cancelled') && ev.some((b) => /archived by board cleanup/.test(b)), 'the timeline says what happened');
assert(aos.tasks.latestNote(stale) === undefined, 'the reason is not a comment (latestNote stays the real result)');

console.log('\n\x1b[1mB. "doing" with nobody doing it\x1b[0m');
assert(get(stalledTodo).status === 'todo' && r.settled.todo === 2, 'stalled doing → todo', JSON.stringify(r.settled));
assert(get(humanFiledAgentDoing).status === 'todo' && !get(humanFiledAgentDoing).archivedAt, 'a person-filed task an agent left in doing is corrected, never archived');
assert(get(stalledAuto).status === 'blocked' && r.settled.blocked === 1, 'stalled auto-dispatch doing → blocked (no silent respawn)');
assert(aos.tasks.dispatchable(aos.tenant).every((t) => t.id !== stalledAuto), 'the parked auto-dispatch task is not dispatchable');
const again = applyTaskHygiene(aos, {}, NOW);
assert(again.archived.stale + again.archived.orphan + again.archived.proposal === 0 && again.settled.todo + again.settled.blocked === 0, 'a second pass is a no-op');

console.log('\n\x1b[1mC. the archive: off the board, out of the counts, one click back\x1b[0m');
const board = aos.tasks.board(aos.tenant, { closedSince: NOW - 14 * DAY }).map((t) => t.id);
assert(!board.includes(stale) && board.includes(parent) && board.includes(fresh), 'board load leaves archived out, keeps recent done + open');
assert(aos.tasks.archivedCount(aos.tenant) === 4 && aos.tasks.counts(aos.tenant).cancelled === 0, 'archived counted apart from cancelled');
notices = 0;
const back = aos.tasks.restore(stale, owner.id);
assert(back && back.status === 'todo' && !back.archivedAt, 'restore puts it back where it was');
assert(notices === 1, 'a restore IS an ordinary, notified change');
assert(aos.tasks.restore(fresh, owner.id) === null, 'restore refuses a task that is not archived');
const prop = aos.tasks.restore(oldProposal, owner.id);
assert(prop.status === 'proposed', 'a restored proposal is a proposal again');
// A human cancelling an archived task from the board makes it a decision, not cleanup.
aos.tasks.update(orphan, { status: 'todo', by: owner.id });
aos.tasks.update(orphan, { status: 'cancelled', by: owner.id });
assert(!get(orphan).archivedAt, 'any status move clears the archive marker');

console.log('\n\x1b[1mD. one person, one assignee id\x1b[0m');
assert(aos.tasks.canonicalAssignee('janak@testco.dev') === janak.id, 'email → member id');
assert(aos.tasks.canonicalAssignee('member:JANAK@testco.dev') === janak.id, 'member:<email> → member id');
assert(aos.tasks.canonicalAssignee('janak') === janak.id, 'unique name → member id');
assert(aos.tasks.canonicalAssignee('null') === null && aos.tasks.canonicalAssignee(' ') === null, '"null" / blank → unassigned');
assert(aos.tasks.canonicalAssignee('agent:qa') === 'agent:qa', 'agent refs untouched');
assert(aos.tasks.canonicalAssignee('stranger@else.dev') === 'stranger@else.dev', 'an unknown person is kept as given, not destroyed');
const viaCreate = mk({ assignee: 'janak@testco.dev', createdBy: owner.id });
assert(get(viaCreate).assignee === janak.id, 'create stores the canonical id');
aos.tasks.update(viaCreate, { assignee: 'member:owner@testco.dev', by: owner.id });
assert(get(viaCreate).assignee === owner.id, 'update stores the canonical id');
const legacy = mk({ createdBy: owner.id });
aos.db.prepare("UPDATE tasks SET assignee = 'Janak' WHERE id = ?").run(legacy);
const legacyNull = mk({ createdBy: owner.id });
aos.db.prepare("UPDATE tasks SET assignee = 'null' WHERE id = ?").run(legacyNull);
const r2 = applyTaskHygiene(aos, {}, NOW);
assert(r2.normalized >= 2 && get(legacy).assignee === janak.id && get(legacyNull).assignee === undefined, 'the sweep rewrites old rows', JSON.stringify({ n: r2.normalized, a: get(legacy).assignee }));

console.log('\n\x1b[1mE + F. the agent lane and the board load (HTTP)\x1b[0m');
(async () => {
  // A live agent session row + secret so the loopback agent routes accept us.
  const sid = 'ses_agent';
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,secret,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sid, 'engineer', 't', 'x', 'aos-' + sid, 'running', owner.id, 'sekrit', NOW);
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  aos.agents.set('qa', { id: 'qa', name: 'QA', runtime: 'claude-code', dir: HOME });
  const srv = createHttpServer(registry);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const agentPost = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': 'sekrit' }, body: JSON.stringify({ session: sid, ...b }) }).then((r) => r.json());

  const openTitle = mk({ title: 'Fix the wizard controller tests', assignee: 'agent:engineer' });
  const dup = await agentPost('/api/tasks/create', { title: '  fix the WIZARD controller tests. ', assignee: 'agent:qa' });
  assert(dup.ok && dup.duplicate && dup.id === openTitle && /already open/.test(dup.message), 'a re-filed open title points at the existing task', JSON.stringify(dup));
  const nobody = await agentPost('/api/tasks/create', { title: 'something new', assignee: 'ghost@nowhere.dev' });
  assert(!nobody.ok && /not a member/.test(nobody.error), 'an assignee that is nobody is refused', JSON.stringify(nobody));
  const upd = await agentPost('/api/tasks/update', { id: openTitle, assignee: 'Nobody Atall' });
  assert(!upd.ok && /not a member/.test(upd.error), 'update refuses an unknown person too');

  // Board load: more than 500 open tasks all come back.
  const stmt = aos.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?");
  for (let i = 0; i < 520; i++) stmt.run(NOW, mk({ title: `bulk ${i}`, createdBy: owner.id }));
  const login = aos.team.createSession(owner.id);
  {
    const b = await fetch(base + '/api/tasks?q=', { headers: { cookie: `aos_sid=${login}` } }).then((r) => r.json());
    const open = b.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length;
    const total = aos.db.prepare("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done','cancelled')").get().n;
    assert(open === total && open > 500, `board returns every open task (${open}/${total})`);
    assert(typeof b.archivedCount === 'number', 'board payload carries the archived count');
    const plan = await fetch(base + '/api/tasks/hygiene', { headers: { cookie: `aos_sid=${login}` } }).then((r) => r.json());
    assert(plan.archive && typeof plan.archive.stale === 'number' && typeof plan.normalize === 'number', 'GET /api/tasks/hygiene is a dry run', JSON.stringify(plan).slice(0, 200));
    const asMember = await fetch(base + '/api/tasks/hygiene', { headers: { cookie: `aos_sid=${aos.team.createSession(janak.id)}` } });
    assert(asMember.status === 403, 'a plain member cannot run cleanup');
    const arch = await fetch(base + '/api/tasks?archived=1', { headers: { cookie: `aos_sid=${login}` } }).then((r) => r.json());
    const target = arch.tasks.find((t) => t.archivedAt);
    assert(target && arch.tasks.every((t) => t.archivedAt), 'the Archived lens lists only archived tasks');
    const rs = await fetch(base + `/api/tasks/${target.id}/restore`, { method: 'POST', headers: { cookie: `aos_sid=${login}` } }).then((r) => r.json());
    assert(rs.ok && !rs.task.archivedAt, 'POST /api/tasks/:id/restore brings it back');
  }
  srv.close();
  registry.stopAll?.();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
