#!/usr/bin/env node
/* Agent self-query scoping + the board query's filters — the two reads an AGENT waits on mid-run.
 *
 * Both were measured against a copy of a live 1k-session tenant before this test existed:
 *   - `session_history` resolved the agent's own runs by building the ENTIRE tenant's session list
 *     (every row, full `task` prose, tmux liveness, up to 20 transcript parses for cost backfill,
 *     insights stamping) and then filtering it in JS — 19ms of handler time to return ≤20 rows, growing
 *     with the tenant, not with the answer. `session_open` did the same work just to test one id.
 *   - `task_list` over-fetched 5× the limit and applied `status`/`assignee` in JS, with
 *     `idx_tasks_assignee(tenant, assignee)` sitting unused.
 * Both are now SQL-first. The properties pinned here are the ones a "make it faster" rewrite can break:
 * scope (never a sibling agent's run), order, the archived rule, the limit, and result PARITY with the
 * naive filter it replaced. Isolated home; pure over the DB — no tmux, no claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agent-history-test-'));
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

const T0 = Date.now() - 7_200_000;
let n = 0;
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'engineer', title: 'run ' + n, task: 'do the thing', tmux: 'aos-' + id, status: 'done',
    spawned_by: null, run_as: null, claude_session_id: null, archived_at: null,
    created_at: T0 + n * 60_000, updated_at: T0 + n * 60_000, ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions
      (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,created_at,updated_at)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@created_at,@updated_at)`).run(cols);
  return id;
};

const mine = [mkRun(), mkRun({ title: 'deploy the droplet' }), mkRun()];
const current = mkRun();
const archived = mkRun({ archived_at: Date.now() });
const sibling = mkRun({ agent: 'researcher' });

// ── scope: an agent sees its OWN runs and nothing else ──────────────────────────────────────────────
const own = tm.sessionsForAgent('engineer');
const ownIds = own.map((s) => s.id);
assert(!ownIds.includes(sibling), 'a sibling agent’s run is never returned');
assert(!ownIds.includes(archived), 'an archived run stays hidden (as it is in the console list)');
assert(ownIds.includes(current), 'the caller’s own current run is present until the route excludes it');
assert(own.every((s) => s.agent === 'engineer'), 'every row belongs to the caller’s agent');

// ── parity with the naive implementation it replaced ────────────────────────────────────────────────
const naive = tm.listSessions().filter((s) => s.agent === 'engineer');
assert(JSON.stringify(naive.map((s) => s.id)) === JSON.stringify(ownIds),
  'same rows, same order as listSessions().filter(agent) — the fast path changed cost, not the answer',
  `${JSON.stringify(naive.map((s) => s.id))} vs ${JSON.stringify(ownIds)}`);

// ── newest first, and the limit bounds the work, not just the output ────────────────────────────────
assert(own[0].createdAt >= own[own.length - 1].createdAt, 'newest first');
assert(tm.sessionsForAgent('engineer', { limit: 2 }).length === 2, 'limit is honoured');

// ── the route’s filters, now pushed into SQL ────────────────────────────────────────────────────────
const excl = tm.sessionsForAgent('engineer', { excludeId: current }).map((s) => s.id);
assert(!excl.includes(current), 'excludeId drops the calling run');
const q = tm.sessionsForAgent('engineer', { query: 'DEPLOY' });
assert(q.length === 1 && q[0].title === 'deploy the droplet', 'query is a case-insensitive substring over title/task');

// ── session_open’s ownership check ──────────────────────────────────────────────────────────────────
assert(tm.sessionBelongsToAgent(mine[0], 'engineer') === true, 'own session passes the ownership check');
assert(tm.sessionBelongsToAgent(sibling, 'engineer') === false, 'a sibling’s session is refused');
assert(tm.sessionBelongsToAgent(archived, 'engineer') === false, 'an archived session is refused, as before');
assert(tm.sessionBelongsToAgent('ts_nope', 'engineer') === false, 'an unknown id is refused');

// ── task board: SQL filters must return exactly what the JS filter did ──────────────────────────────
const mk = (o) => aos.tasks.create({ tenant: aos.tenant, createdBy: 'agent:engineer', ...o });
for (let i = 0; i < 12; i++) mk({ title: `task ${i}`, assignee: i % 2 ? 'agent:engineer' : 'agent:researcher', labels: i % 3 ? ['ops'] : [] });
const all = aos.tasks.list({ tenant: aos.tenant, limit: 500 });
const byAssignee = aos.tasks.list({ tenant: aos.tenant, assignee: 'agent:engineer', limit: 500 });
assert(byAssignee.length === all.filter((t) => t.assignee === 'agent:engineer').length, 'assignee filter matches the JS filter');
assert(byAssignee.every((t) => t.assignee === 'agent:engineer'), 'assignee filter is exact (never a prefix match)');
aos.tasks.update(all[0].id, { status: 'doing', by: 'agent:engineer' });
const doing = aos.tasks.list({ tenant: aos.tenant, status: 'doing', limit: 500 });
assert(doing.length === all.filter((t) => t.id === all[0].id).length, 'status filter matches the JS filter');
assert(aos.tasks.list({ tenant: aos.tenant, assignee: 'agent:engineer', limit: 2 }).length === 2, 'limit still bounds a filtered board');
const labelled = aos.tasks.list({ tenant: aos.tenant, label: 'ops', limit: 500 });
assert(labelled.length > 0 && labelled.every((t) => t.labels.includes('ops')), 'label filter still works (it stays a JS filter by design)');
const q2 = aos.tasks.list({ tenant: aos.tenant, query: 'task', assignee: 'agent:engineer', limit: 500 });
assert(q2.length > 0 && q2.every((t) => t.assignee === 'agent:engineer'), 'FTS search composes with the assignee filter');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(fail ? `\nagent-history-scope-test: ${fail} FAILED, ${pass} passed` : `\nagent-history-scope-test: ok (${pass} checks)`);
process.exit(fail ? 1 : 0);
