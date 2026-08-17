#!/usr/bin/env node
/* Self-dispatch guard — an agent may not auto-dispatch a task to ITSELF.
 *
 * The defect: an agent filing `task_create({ assignee: 'me', autoDispatch: true })` is not delegating.
 * It ends its turn and immediately respawns itself with an empty context to do work the session it just
 * left was already holding the context for. Measured on the live instawp fleet over 7 days: 104 such
 * tasks, 70 dispatched within 2 minutes of being filed, $1,330 of sessions rebuilding a context their
 * own caller still had.
 *
 * There is no deferral being taken away: `dueAt` is a soft deadline that `dispatchable()` never reads,
 * so a self-assigned auto-dispatch task always runs ~now. `schedule` is the real "run me later" path and
 * `autoDispatch:false` is the real "put it on the board" path — the refusal names both.
 *
 * What must NOT regress, and is asserted here: a hand-off to a DIFFERENT agent (the whole delegation
 * feature), a self-assigned task WITHOUT auto-dispatch (a personal board item), and the goal-plan lane
 * where the server force-stamps auto-dispatch onto a deliberate multi-step plan.
 * Isolated home; no tmux, no claude — the loopback route is driven over real HTTP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-self-dispatch-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 250) : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const { os: aos, tm } = registry.get('testco');

  const SID = 'ses_selfd1';
  const SECRET = 'sec-selfd';
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  aos.agents.set('infra-ops', { id: 'infra-ops', name: 'Infra', runtime: 'claude-code', dir: HOME });
  aos.db.prepare(
    "INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(SID, 'engineer', 'run', 'work', 'aos-' + SID, 'running', 1, 0, SECRET, null, null, Date.now(), Date.now());

  // Never actually spawn: the point is which calls REACH a dispatch, not what a pane does.
  const dispatched = [];
  const { autos } = registry.get('testco');
  autos.dispatchTask = (id, opts) => { dispatched.push({ id, by: opts && opts.by }); return { ok: true }; };

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const create = (body) =>
    fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aos-secret': SECRET },
      body: JSON.stringify({ session: SID, ...body }),
    }).then((r) => r.json());
  const countTasks = () => aos.db.prepare('SELECT count(*) n FROM tasks').get().n;

  console.log('\n\x1b[1m1) THE DEFECT: self-assigned + autoDispatch is refused\x1b[0m');
  {
    const before = countTasks();
    const r = await create({ title: 'carry on with the import', assignee: 'me', autoDispatch: true });
    assert(r.ok === false, 'refused', r);
    assert(countTasks() === before, 'and NOTHING was written — a half-applied refusal is worse than none', countTasks());
    assert(dispatched.length === 0, 'and nothing was dispatched');
    // The message has to be actionable inside the turn that still holds the context.
    assert(/this turn/i.test(r.error || ''), 'it tells the agent to just do it now', r.error);
    assert(/schedule/.test(r.error || ''), 'names `schedule` for a genuinely later run', r.error);
    assert(/autoDispatch:false/.test(r.error || ''), 'and autoDispatch:false for a board item', r.error);
  }

  console.log('\n\x1b[1m2) the explicit agent id form is the same thing\x1b[0m');
  {
    const r = await create({ title: 'again', assignee: 'agent:engineer', autoDispatch: true });
    assert(r.ok === false, "`assignee:'agent:<self>'` is refused too, not just the 'me' alias", r);
    const r2 = await create({ title: 'string flag', assignee: 'me', autoDispatch: 'true' });
    assert(r2.ok === false, "and the string 'true' the MCP layer can send", r2);
  }

  console.log('\n\x1b[1m3) what must NOT regress\x1b[0m');
  {
    const r = await create({ title: 'deploy it', assignee: 'agent:infra-ops', autoDispatch: true });
    assert(r.ok === true, 'a hand-off to a DIFFERENT agent still works — this is the delegation feature', r);
    assert(dispatched.length === 1, 'and it still dispatches immediately', dispatched);

    const r2 = await create({ title: 'my own backlog item', assignee: 'me' });
    assert(r2.ok === true, 'a self-assigned task WITHOUT autoDispatch is fine (a board item)', r2);
    assert(aos.tasks.get(r2.id).autoDispatch === false, 'and it is not auto-dispatching', aos.tasks.get(r2.id));
    assert(dispatched.length === 1, 'so nothing new was spawned for it', dispatched);

    const r3 = await create({ title: 'unassigned' , autoDispatch: true });
    assert(r3.ok === true, 'an unassigned auto-dispatch task is untouched by the guard', r3);
  }

  console.log('\n\x1b[1m4) the goal-plan lane is exempt\x1b[0m');
  {
    // A plan step for the planner itself is a structure the human opted into and the tick drains in
    // dependsOn order — not a turn boundary the agent invented for itself.
    tm.isPlanAutoDispatch = (s) => s === SID;
    const r = await create({ title: 'plan step for myself', assignee: 'me' });
    assert(r.ok === true, 'a plan run may still stamp auto-dispatch on a step for itself', r);
    assert(aos.tasks.get(r.id).autoDispatch === true, 'and the stamp really landed', aos.tasks.get(r.id));
    tm.isPlanAutoDispatch = () => false;
  }

  console.log('\n\x1b[1m5) the refusal is audited\x1b[0m');
  {
    const n = aos.db.prepare("SELECT count(*) n FROM audit_events WHERE type = 'task.self_dispatch.refused'").get().n;
    assert(n >= 3, 'every refusal leaves a row, so the saving is measurable rather than asserted', n);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
