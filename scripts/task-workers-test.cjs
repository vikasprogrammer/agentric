#!/usr/bin/env node
/* Task WORKERS read-model test — TerminalManager.taskWorkers(), the board/list card's answer to "who has
 * actually run this task?" (as opposed to `assignee`, which is only who it was handed to).
 *
 * What it pins down, all derived from rows that already exist (no new storage):
 *   - a task worked by ONE agent is absent — the assignee badge already says that, so shipping a row for
 *     it would be payload that renders nothing;
 *   - a task two agents ran IS returned, with a per-agent run count (a hand-off, not a retry);
 *   - a session that touched the task from elsewhere (a `task_events.session_id`, e.g. an agent's
 *     task_claim from its own run) counts as a worker — same two sources as taskRuns;
 *   - a session counted through BOTH sources is counted once;
 *   - liveness rides the tmux poll, and an unknown poll (launcher backend / failed poll) trusts the row;
 *   - tasks from the seed's other rows can't leak in through a NULL/short provenance string.
 * Isolated home; no tmux or claude needed (the roll-up is pure over the DB). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-workers-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const { member } = aos.team.invite({ email: 'owner@testco.dev', role: 'owner' });
aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);

const T0 = Date.now() - 3_600_000;
let n = 0;
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'done',
    spawned_by: member.id, run_as: member.id, created_at: T0 + n * 60_000, updated_at: T0 + n * 60_000, ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,created_at,updated_at)
                  VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@created_at,@updated_at)`).run(cols);
  return id;
};
const mkTask = (title) => aos.tasks.create({ tenant: aos.tenant, createdBy: 'agent:engineer', owner: member.id, title });
const link = (taskId, sessionId) => aos.db
  .prepare('INSERT INTO task_events (id, task_id, kind, body, author, session_id, created_at) VALUES (?,?,?,?,?,?,?)')
  .run('te_' + (++n), taskId, 'claim', null, 'agent:x', sessionId, Date.now());

// ── The shapes ───────────────────────────────────────────────────────────────
const solo = mkTask('one agent, three attempts');
mkRun({ spawned_by: `task:${solo.id}`, agent: 'engineer', status: 'crashed' });
mkRun({ spawned_by: `task:${solo.id}`, agent: 'engineer', status: 'crashed' });
mkRun({ spawned_by: `task:${solo.id}`, agent: 'engineer' });

const handoff = mkTask('support files it, engineering takes it');
mkRun({ spawned_by: `task:${handoff.id}`, agent: 'support' });
const engLive = mkRun({ spawned_by: `task:${handoff.id}`, agent: 'engineer', status: 'running' });
mkRun({ spawned_by: `task:${handoff.id}`, agent: 'engineer', status: 'running' });

const claimed = mkTask('claimed from a session of its own');
mkRun({ spawned_by: `task:${claimed.id}`, agent: 'engineer' });
const outside = mkRun({ spawned_by: member.id, agent: 'researcher' }); // a run of its own that claimed it
link(claimed.id, outside);
// The SAME session, reachable through both sources — must not be double counted.
const both = mkRun({ spawned_by: `task:${handoff.id}`, agent: 'support' });
link(handoff.id, both);

// Liveness is unknown on this backend unless we say otherwise — pin both branches explicitly.
tm.backend.aliveNames = () => null;
let w = tm.taskWorkers();

assert(!w[solo.id], 'a single-agent task is not returned (the assignee badge already says it)');
assert(!!w[handoff.id], 'a task two agents ran IS returned');
assert(w[handoff.id].agents.length === 2, 'both agents are listed', JSON.stringify(w[handoff.id]));
const eng = w[handoff.id].agents.find((a) => a.id === 'engineer');
const sup = w[handoff.id].agents.find((a) => a.id === 'support');
assert(eng.runs === 2, 'per-agent run counts are the agent\'s OWN runs', String(eng.runs));
assert(sup.runs === 2, 'a session counted through BOTH sources is counted once', String(sup.runs));
assert(eng.alive === true, 'an unknown tmux poll trusts the row status');
assert(!!w[claimed.id] && w[claimed.id].agents.some((a) => a.id === 'researcher'),
  'a session that only LINKED the task (task_events) counts as a worker', JSON.stringify(w[claimed.id]));

// With a real poll, only the panes tmux still has are live.
tm.backend.aliveNames = () => new Set(['aos-' + engLive]);
w = tm.taskWorkers();
assert(w[handoff.id].agents.find((a) => a.id === 'engineer').alive === true, 'a polled-live pane stays live');
tm.backend.aliveNames = () => new Set();
w = tm.taskWorkers();
assert(w[handoff.id].agents.every((a) => a.alive === false), 'a run whose pane is gone is not reported live');

// Provenance that is not a task must never manufacture a task id.
mkRun({ spawned_by: null, agent: 'ghost' });
mkRun({ spawned_by: 'task:', agent: 'ghost' });
w = tm.taskWorkers();
assert(!Object.keys(w).some((k) => !k), 'an empty provenance tail yields no task entry', JSON.stringify(Object.keys(w)));
assert(!Object.values(w).some((v) => v.agents.some((a) => a.id === 'ghost')), 'a non-task session is not a worker');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
try { tm.stopAll?.(); } catch {}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
