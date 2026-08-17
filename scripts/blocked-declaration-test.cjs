#!/usr/bin/env node
/* Blocking without saying what you're blocked ON is refused, not guessed (`POST /api/tasks/update`).
 *
 * `blockedOn` decides who a blocked-task wake-up reaches: `human` alerts the task owner and skips resuming
 * the delegating agent, which cannot make a decision only a person can. Shipped as an optional field on
 * 2026-08-17 — and the fleet's first afternoon with it produced FOUR human blockers and ZERO declarations
 * ("Blocked on human approval for the merge only", "no deletions without founder sign-off", "blocked only
 * on the founder's merge decision", "blocked only on merge approval"), including one from a session
 * started well after the deploy, so the field was in its tool list and simply went unused. An optional
 * field on a tool agents call with minimal args is not a field.
 *
 * So the route refuses the update and says what to send. The refusal has to be aimed carefully: an MCP
 * server process outlives a server upgrade, so a live session's `task_update` may come from a client that
 * has never heard of `blockedOn`, and refusing THAT would leave a running agent unable to block at all.
 * The client therefore sends an explicit `null` when it has the field and the agent skipped it, which is
 * what the route keys on; an absent key stays accepted.
 *
 * Pins: declared → applied; omitted-by-a-current-client → refused, task untouched, guidance returned;
 * omitted-by-an-old-client → applied (no live session is ever locked out); and the refusal is scoped to
 * `blocked` alone, so `done` never needs one.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-blocked-decl-test-'));
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
  const { os: aos } = registry.get('testco');

  // A session row the loopback routes accept: they authenticate by session id + its secret.
  const SID = 'ses_decl1';
  const SECRET = 'sec-decl';
  aos.agents.set('engineer', { id: 'engineer', name: 'Engineer', runtime: 'claude-code', dir: HOME });
  aos.db.prepare(
    "INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(SID, 'engineer', 'run', 'work', 'aos-' + SID, 'running', 1, 0, SECRET, null, null, Date.now(), Date.now());

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const update = (body) =>
    fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aos-secret': SECRET },
      body: JSON.stringify({ session: SID, ...body }),
    }).then((r) => r.json());
  const mkTask = (title) => aos.tasks.create({ tenant: aos.tenant, title, assignee: 'agent:engineer', createdBy: 'agent:engineer' }).id;
  const statusOf = (id) => aos.tasks.get(id).status;

  console.log('\n\x1b[1m1) declared → applied\x1b[0m');
  {
    const id = mkTask('needs the founder');
    const r = await update({ id, status: 'blocked', blockedOn: 'human', note: 'merge approval' });
    assert(r.ok === true, 'the update goes through', r);
    assert(aos.tasks.get(id).blockedOn === 'human', 'and the declaration is stored', aos.tasks.get(id));
  }

  console.log('\n\x1b[1m2) a current client whose agent omitted it → refused, with instructions\x1b[0m');
  {
    const id = mkTask('blocked, unexplained');
    const r = await update({ id, status: 'blocked', blockedOn: null, note: 'stuck' });
    assert(r.ok === false, 'refused', r);
    assert(/blockedOn/.test(r.error || '') && /human/.test(r.error || ''), 'and told exactly what to send', r.error);
    assert(statusOf(id) === 'todo', 'the task is UNCHANGED — a refusal that half-applied would be worse than none', statusOf(id));
  }

  console.log('\n\x1b[1m3) an older MCP client (no such field) → still accepted\x1b[0m');
  {
    // An MCP process outlives a server upgrade: a session launched before the field existed sends no key
    // at all. Refusing it would leave a running agent with no way to block.
    const id = mkTask('blocked by a pre-upgrade client');
    const r = await update({ id, status: 'blocked', note: 'stuck' });
    assert(r.ok === true, 'accepted, exactly as before the field existed', r);
    assert(statusOf(id) === 'blocked', 'and it really blocked', statusOf(id));
    assert(aos.tasks.get(id).blockedOn === undefined, 'with nothing invented on its behalf', aos.tasks.get(id));
  }

  console.log('\n\x1b[1m4) the refusal is scoped to blocking\x1b[0m');
  {
    const id = mkTask('finished cleanly');
    const r = await update({ id, status: 'done', note: 'shipped' });
    assert(r.ok === true && statusOf(id) === 'done', 'done needs no blocker declaration', r);
  }

  server.close();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail === 0 ? 0 : 1);
})();
