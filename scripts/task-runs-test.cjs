#!/usr/bin/env node
/* Task run-history test (TerminalManager.taskRuns).
 *
 * A task is the durable unit of work; a session is ONE ATTEMPT at it. The relation has always been
 * one-to-many (a crash re-dispatches, an agent claims from its own run, a human takes over), but only
 * `tasks.last_session_id` was reachable, so a task that failed twice before succeeding read as a single
 * clean run. These assertions pin the recovery of the full list — including the parts that are easy to
 * regress: ordering, the `current` pointer, archived rows staying in the history, the dispatch/linked
 * distinction, and liveness surviving an unpollable backend.
 * Isolated home; the tmux backend is stubbed so no real pane is spawned.
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-runs-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

let aliveSet = new Set();
tm.backend.aliveNames = () => aliveSet;
tm.backend.kill = () => {};
tm.backend.hasClient = () => false;
tm.backend.spawn = () => {};
tm.backend.capturePane = () => null;

const T0 = Date.now() - 3_600_000;
let n = 0;
const mkSession = (o) => {
  const id = 'ts_' + (++n);
  const cols = { id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'done',
    headless: 1, resident: 0, run_as: null, spawned_by: null, created_at: T0 + n * 1000, updated_at: T0 + n * 1000 + 500,
    outcome: null, report_summary: null, cost_usd: null, turns: null, archived_at: null, ...o };
  aos.db.prepare(`INSERT INTO term_sessions
      (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,created_at,updated_at,outcome,report_summary,cost_usd,turns,archived_at)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@run_as,@spawned_by,@created_at,@updated_at,@outcome,@report_summary,@cost_usd,@turns,@archived_at)`).run(cols);
  return id;
};
const mk = (title) => aos.tasks.create({ tenant: aos.tenant, title, createdBy: 'm_alice' });

console.log('\n\x1b[1m1) a task with three attempts returns all three, oldest-first\x1b[0m');
const t1 = mk('Fix the billing webhook');
// #1 crashed, #2 partial, #3 still running — the shape a re-dispatched task actually has.
const r1 = mkSession({ spawned_by: `task:${t1.id}`, status: 'crashed', cost_usd: 8.61 });
const r2 = mkSession({ spawned_by: `task:${t1.id}`, outcome: 'partial', report_summary: 'got halfway', cost_usd: 5.5, turns: 12 });
const r3 = mkSession({ spawned_by: `task:${t1.id}`, status: 'running', updated_at: null });
aos.tasks.markDispatched(t1.id, r3);           // the console's single pointer lands on the newest
aliveSet = new Set([`aos-${r3}`]);

let runs = tm.taskRuns(t1.id);
assert(runs.length === 3, 'all three sessions are recovered', `got ${runs.length}`);
assert(runs.map((r) => r.id).join() === [r1, r2, r3].join(), 'ordered oldest-first');
assert(runs.filter((r) => r.current).length === 1 && runs[2].current, 'exactly the newest is `current` (the lastSessionId pointer)');
assert(runs.every((r) => r.link === 'dispatch'), 'runs spawned FOR the task are `dispatch`');
assert(runs[0].endedAt != null && runs[2].endedAt === undefined, 'a finished run has an endedAt; a running one does not');
assert(runs[1].summary === 'got halfway' && runs[1].costUsd === 5.5 && runs[1].turns === 12, 'per-run verdict/cost/turns ride along');
assert(runs[2].alive === true && runs[0].alive === false, 'liveness comes from the tmux poll, not the row alone');
// The point of the whole feature: the cost of a task is the SUM of its attempts, not the last one.
const total = runs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
assert(Math.abs(total - 14.11) < 0.001, 'earlier attempts carry cost the single pointer hid', `sum=${total}`);

console.log('\n\x1b[1m2) a session that touched the task from elsewhere is `linked`, not `dispatch`\x1b[0m');
const t2 = mk('Draft the release notes');
const own = mkSession({ spawned_by: `task:${t2.id}` });
// An agent working its OWN session claims the task — no `task:` provenance, only a task_event.
const claimer = mkSession({ spawned_by: 'automation:a1' });
aos.tasks.claim(t2.id, 'engineer', claimer);
runs = tm.taskRuns(t2.id);
assert(runs.length === 2, 'both the dispatched run and the claiming run appear', `got ${runs.length}`);
assert(runs.find((r) => r.id === own).link === 'dispatch', 'the dispatched one is `dispatch`');
assert(runs.find((r) => r.id === claimer).link === 'linked', 'the claiming one is `linked`');
assert(runs.find((r) => r.id === claimer).current, 'claim moves the current pointer to the claiming run');

console.log('\n\x1b[1m3) archiving declutters the Sessions list — it never rewrites a task\'s history\x1b[0m');
aos.db.prepare('UPDATE term_sessions SET archived_at = ? WHERE id = ?').run(Date.now(), r1);
runs = tm.taskRuns(t1.id);
assert(runs.length === 3, 'the archived attempt is still in the run history', `got ${runs.length}`);
assert(runs[0].archived === true, 'and is flagged archived so the UI can say so');
assert(tm.listSessions().every((s) => s.id !== r1), 'while the Sessions list does hide it (the control)');

console.log('\n\x1b[1m4) no double-counting, and an unpollable backend never claims a live run is dead\x1b[0m');
// A task whose lastSessionId IS also a dispatched run must not appear twice (three OR-ed predicates).
assert(new Set(tm.taskRuns(t1.id).map((r) => r.id)).size === 3, 'the OR-ed predicates dedupe to one row per session');
assert(tm.taskRuns(mk('Never dispatched').id).length === 0, 'a task that never ran has no runs');
tm.backend.aliveNames = () => null;   // launcher backend / failed poll → liveness unknown
assert(tm.taskRuns(t1.id).find((r) => r.id === r3).alive === true, 'a running row stays alive when the poll cannot run');
assert(tm.taskRuns(t1.id).find((r) => r.id === r2).alive === false, 'a terminal row is never claimed alive');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
