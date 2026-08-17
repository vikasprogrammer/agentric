#!/usr/bin/env node
/* Goal room test — running a goal's work from the goal, and the goal's activity telling that story.
 *
 * What it pins down:
 *   - GoalStore.timeline merges the goal's own events with the MILESTONES of its linked tasks
 *     (filed / started / blocked / done / cancelled / reopened), oldest-first, and nothing else: a comment,
 *     an assignment, a due-date change, the overdue mark and the stranded-run marker all stay on the task;
 *   - the NOTE that came with a blocked/done transition rides along as the entry's body (the reason is the
 *     one thing a goal reader wants), and a note attached to a plain `filed` entry does not;
 *   - a task's milestones stop counting toward a goal the moment it is unlinked, and are attributed to
 *     whoever moved it;
 *   - Automations.canDispatch is a PURE predicate over the same cascade dispatchTask enforces — every
 *     refusal carries a code the console can react to — while the attempt-ceiling PARK stays on
 *     dispatchTask (the path that actually tried);
 *   - TerminalManager.liveTaskRuns answers per-task liveness in one shot, and agrees with `reachable`
 *     (a stopped/crashed run is not live, a running one is);
 *   - GET /api/goals/:id carries per-task run state + the chat binding, so the room can offer a Run button
 *     that can't disagree with what the server would do;
 *   - the goal chat route is owner/admin-only and refuses an unknown goal.
 * Isolated home; no tmux, no claude (session rows are inserted directly, as in chain-model-test). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-goalroom-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos, tm, autos } = registry.get('testco');
// Two agents the plan below assigns to. Registered directly (no manifest on disk) — nothing here launches.
aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
aos.agents.set('designer', { id: 'designer', name: 'Designer', runtime: 'claude-code', dir: HOME });

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const member = mkMember('mem@testco.dev', 'member');

let n = 0;
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running',
    spawned_by: owner.id, run_as: owner.id, claude_session_id: null, archived_at: null,
    resident: 0, created_at: Date.now(), updated_at: Date.now(), ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions
      (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,resident,created_at,updated_at)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@resident,@created_at,@updated_at)`).run(cols);
  return id;
};

// ── fixture: one goal with a small plan under it ──────────────────────────────────
const goal = aos.goals.create({ tenant: aos.tenant, title: 'Cut onboarding time in half', createdBy: owner.id });
const other = aos.goals.create({ tenant: aos.tenant, title: 'Unrelated goal', createdBy: owner.id });
const mkTask = (o) => aos.tasks.create({ tenant: aos.tenant, createdBy: owner.id, owner: owner.id, goalId: goal.id, ...o });

const tDone = mkTask({ title: '1. Measure the current funnel', assignee: 'agent:engineer' });
const tBlocked = mkTask({ title: '2. Rewrite the welcome flow', assignee: 'agent:engineer' });
const tOpen = mkTask({ title: '3. Ship the new flow', assignee: 'agent:engineer' });
const tDep = mkTask({ title: '4. Announce it', assignee: 'agent:engineer', dependsOn: [tOpen.id] });
const tUnassigned = mkTask({ title: '5. Decide the pricing copy' });
const tElsewhere = aos.tasks.create({ tenant: aos.tenant, createdBy: owner.id, title: 'Not this goal', goalId: other.id });

// Milestones + the noise that must NOT reach the goal's timeline.
aos.tasks.update(tDone.id, { status: 'doing', by: 'agent:engineer' });
aos.tasks.update(tDone.id, { status: 'done', note: 'funnel measured: 41 min median', by: 'agent:engineer' });
aos.tasks.update(tBlocked.id, { status: 'blocked', blockedOn: 'human', note: 'need the brand copy sign-off', by: 'agent:engineer' });
aos.tasks.update(tOpen.id, { priority: 0, labels: ['ship'], by: owner.id }); // no event worth a goal line
aos.tasks.update(tOpen.id, { assignee: 'agent:designer', by: owner.id }); // assign — task-level only
aos.tasks.update(tOpen.id, { note: 'chatting about approach', by: owner.id }); // comment — task-level only
aos.tasks.update(tOpen.id, { dueAt: Date.now() + 86_400_000, by: owner.id }); // due date — task-level only
aos.tasks.markOverdueNotified(tOpen.id); // overdue mark — not a milestone
aos.tasks.markStranded(tOpen.id, 'ts_none'); // stranded marker — not a milestone
aos.tasks.update(tOpen.id, { assignee: 'agent:engineer', by: owner.id }); // put it back for the dispatch tests

console.log('\n\x1b[1mgoal timeline\x1b[0m');
const tl = aos.goals.timeline(goal.id);
const taskLines = tl.filter((e) => e.kind === 'task');
const lineFor = (id, verb) => taskLines.find((e) => e.task.id === id && e.task.verb === verb);
assert(tl.some((e) => e.kind === 'status' && e.body === '→active'), "the goal's own events are still there");
assert(taskLines.length > 0, 'linked-task milestones reach the goal timeline');
assert(taskLines.every((e) => e.task && e.task.title), 'every task entry names its task');
assert(!!lineFor(tDone.id, 'filed') && !!lineFor(tDone.id, 'started') && !!lineFor(tDone.id, 'done'), 'filed → started → done all land');
assert(lineFor(tDone.id, 'done').body === 'funnel measured: 41 min median', 'the note on a done transition becomes the reason', lineFor(tDone.id, 'done').body);
assert(lineFor(tBlocked.id, 'blocked').body === 'need the brand copy sign-off', 'the note on a blocked transition becomes the reason');
assert(!lineFor(tDone.id, 'filed').body, 'a filed entry carries no body (the title is the line)');
assert(lineFor(tDone.id, 'done').author === 'agent:engineer', 'attribution is whoever moved the task');
assert(!taskLines.some((e) => e.task.id === tElsewhere.id), "another goal's task never appears");
assert(!taskLines.some((e) => (e.body || '').includes('chatting about approach')), 'task discussion stays on the task');
assert(!tl.some((e) => (e.body || '').includes('went overdue')), 'the overdue mark is not a goal milestone');
assert(!tl.some((e) => (e.body || '').includes('run ended without closing')), 'the stranded marker is not a goal milestone');
assert(tl.every((e, i) => i === 0 || tl[i - 1].createdAt <= e.createdAt), 'oldest first, across both sources');
assert(new Set(tl.map((e) => e.id)).size === tl.length, 'ids are unique across the merge (React keys)');
assert(aos.goals.events(goal.id).every((e) => e.kind !== 'task'), 'nothing was written into goal_events');
// Unlinking a task takes its history off the goal with it — the timeline is a live join, not a copy.
aos.tasks.update(tElsewhere.id, { status: 'done', by: owner.id });
const beforeUnlink = aos.goals.timeline(goal.id).filter((e) => e.kind === 'task').length;
aos.tasks.update(tBlocked.id, { goalId: null, by: owner.id });
const afterUnlink = aos.goals.timeline(goal.id).filter((e) => e.kind === 'task').length;
assert(afterUnlink < beforeUnlink, 'unlinking a task removes its milestones from the goal', `${beforeUnlink} → ${afterUnlink}`);
aos.tasks.update(tBlocked.id, { goalId: goal.id, by: owner.id }); // relink for the rest
assert(aos.goals.timeline(other.id).some((e) => e.kind === 'task' && e.task.id === tElsewhere.id), 'the other goal has its own task line');
// A goal with no work at all still reads: its own events, and no crash on the empty join.
const bare = aos.goals.create({ tenant: aos.tenant, title: 'Nothing filed yet', createdBy: owner.id });
assert(aos.goals.timeline(bare.id).length === 1, 'an unplanned goal shows just its opening event');

console.log('\n\x1b[1mdispatch pre-flight (canDispatch)\x1b[0m');
const code = (id, guard) => (autos.canDispatch(id, { guard }) || {}).code;
assert(autos.canDispatch(tOpen.id, { guard: false }).ok, 'an agent-assigned open task can run');
assert(code(tUnassigned.id, false) === 'unassigned', 'no agent assignee → unassigned');
assert(code(tDone.id, false) === 'closed', 'a done task is closed to dispatch');
assert(code(tDep.id, false) === 'deps', 'an unfinished blocker holds a dependent back, even for a human');
assert((autos.canDispatch(tDep.id, { guard: false }).reason || '').includes(tOpen.id), 'the refusal names the blocker');
assert(code('tsk_nope', false) === 'missing', 'an unknown task is missing, not a crash');
assert(code(tBlocked.id, true) === 'blocked', 'the scheduler respects a deliberate block');
assert(autos.canDispatch(tBlocked.id, { guard: false }).ok, 'a human forcing it un-parks a blocked task');
// Purity: asking must not move anything (the console asks on every render).
const beforeAsk = JSON.stringify(aos.tasks.get(tBlocked.id));
autos.canDispatch(tBlocked.id, { guard: true });
autos.canDispatch(tBlocked.id, { guard: false });
assert(JSON.stringify(aos.tasks.get(tBlocked.id)) === beforeAsk, 'canDispatch writes nothing');
// The attempt ceiling: reported by the predicate, PARKED only by the path that tried.
const tCeiling = mkTask({ title: '6. Flaky work', assignee: 'agent:engineer' });
aos.db.prepare('UPDATE tasks SET attempts = 99 WHERE id = ?').run(tCeiling.id);
assert(code(tCeiling.id, false) === 'attempts', 'the ceiling is a refusal code');
assert(aos.tasks.get(tCeiling.id).status !== 'blocked', 'asking about the ceiling does not park the task');
const ceilTry = autos.dispatchTask(tCeiling.id, { guard: false });
assert(!ceilTry.ok && /ceiling/.test(ceilTry.reason || ''), 'dispatch refuses at the ceiling');
assert(aos.tasks.get(tCeiling.id).status === 'blocked', 'dispatching at the ceiling parks it blocked');

console.log('\n\x1b[1mlive runs, batched\x1b[0m');
const liveId = mkRun({ status: 'running' });
const deadId = mkRun({ status: 'stopped' });
aos.tasks.markDispatched(tOpen.id, liveId);
aos.tasks.markDispatched(tDep.id, deadId);
// There is no tmux pane behind these rows, so the liveness poll is stubbed to report the live one's pane
// — the same seam `reachable` reads, which is why the two agree below.
tm.backend.aliveNames = () => new Set(['aos-' + liveId]);
const live = tm.liveTaskRuns([tOpen.id, tDep.id, tUnassigned.id]);
assert(!!live[tOpen.id] && live[tOpen.id].sessionId === liveId, 'a running session is live for its task');
assert(!live[tDep.id], 'a stopped session is not live');
assert(!live[tUnassigned.id], 'a task with no run has no entry');
assert(live[tOpen.id].agent === 'engineer' && typeof live[tOpen.id].since === 'number', 'the live entry carries the agent + start');
assert(Object.keys(tm.liveTaskRuns([])).length === 0, 'an empty set is an empty answer (no SQL built)');
assert(!!live[tOpen.id] === tm.reachable(liveId), 'agrees with reachable() on the live run');
assert(!live[tDep.id] === !tm.reachable(deadId), 'agrees with reachable() on the dead run');
assert(!autos.canDispatch(tOpen.id, { guard: true }).ok, 'the pile-up guard sees the same live run');
// The task's dispatch also shows up as a `started` milestone on the goal.
assert(aos.goals.timeline(goal.id).some((e) => e.kind === 'task' && e.task.id === tOpen.id && e.task.verb === 'started' && e.task.sessionId === liveId),
  'a dispatch lands on the goal timeline with its session');

console.log('\n\x1b[1mHTTP: the room payload\x1b[0m');
(async () => {
  const srv = createHttpServer(registry);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const memberCookie = `aos_sid=${aos.team.createSession(member.id)}`;
  const get = async (p, cookie) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { cookie } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const post = async (p, cookie, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const detail = await get(`/api/goals/${goal.id}`, ownerCookie);
  assert(detail.status === 200 && detail.body.goal, 'goal detail loads');
  assert(Array.isArray(detail.body.events) && detail.body.events.some((e) => e.kind === 'task'), 'the payload carries the merged timeline');
  assert(detail.body.runs && typeof detail.body.runs === 'object', 'the payload carries per-task run state');
  assert(detail.body.runs[tOpen.id] && detail.body.runs[tOpen.id].live && detail.body.runs[tOpen.id].live.sessionId === liveId, 'a live run is reported on its row');
  assert(detail.body.runs[tOpen.id].can === false && detail.body.runs[tOpen.id].code === 'live', 'a live run offers no second dispatch');
  assert(detail.body.runs[tUnassigned.id].can === false && detail.body.runs[tUnassigned.id].code === 'unassigned', 'an unassigned task says so');
  assert(detail.body.runs[tDep.id].code === 'deps', 'a dependent task says what it waits on');
  assert(typeof detail.body.runs[tDone.id].attempts === 'number', 'attempts ride along (the retry label)');
  assert(detail.body.chat === null, 'no chat conversation until someone starts one');
  // A member who is not assigned to the agent is not offered a button that could only 403.
  const asMember = await get(`/api/goals/${goal.id}`, memberCookie);
  assert(asMember.status === 200, 'a member can read a goal');
  assert(asMember.body.runs[tDep.id].can === false, 'a member unassigned to the agent gets no run affordance');

  const chatBad = await post(`/api/goals/goal_nope/chat`, ownerCookie, { message: 'hi' });
  assert(chatBad.status === 404, 'goal chat on an unknown goal is a 404', `got ${chatBad.status}`);
  const chatNoMsg = await post(`/api/goals/${goal.id}/chat`, ownerCookie, {});
  assert(chatNoMsg.status === 400, 'goal chat needs a message');
  const chatAsMember = await post(`/api/goals/${goal.id}/chat`, memberCookie, { message: 'hi' });
  assert(chatAsMember.status === 403, 'goal chat is owner/admin only (it can file and run work)');
  // The chat binding is the newest RESIDENT run under this goal — a plan run (headless) is not it.
  mkRun({ spawned_by: `goal:${goal.id}`, agent: 'strategist', resident: 0, status: 'done' });
  assert(tm.goalChatSession(goal.id) === undefined, 'a plan run is not mistaken for the chat');
  const chatRun = mkRun({ spawned_by: `goal:${goal.id}`, agent: 'strategist', resident: 1, status: 'running' });
  tm.backend.aliveNames = () => new Set(['aos-' + liveId, 'aos-' + chatRun]); // its pane, same stubbed seam
  const bound = tm.goalChatSession(goal.id);
  assert(bound && bound.sessionId === chatRun, 'the resident run under the goal IS the chat');
  assert(bound.alive === true, 'a running chat reads as alive');
  const withChat = await get(`/api/goals/${goal.id}`, ownerCookie);
  assert(withChat.body.chat && withChat.body.chat.sessionId === chatRun, 'the room payload carries the chat binding');
  assert(tm.goalChatSession(other.id) === undefined, "another goal's room has no chat");

  srv.close();
  registry.stopAll(); // the only thing that kills a per-tenant ttyd — a leaked one pins a core
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})();
