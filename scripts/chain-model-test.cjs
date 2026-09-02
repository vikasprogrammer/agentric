#!/usr/bin/env node
/* Chain read-model test — the tree behind the console's chain rail and the collapsed sessions list
 * (TerminalManager.sessionChain + the threadId/parentThreadId/taskId stamps on listSessions).
 *
 * What it pins down, all of it derived from rows that already exist (no new storage):
 *   - runs fold into CONVERSATIONS by claude transcript, so a poke-back is a resume, not a new node;
 *   - conversations nest under the caller that delegated them (tasks.caller_claude_id), from any seed;
 *   - a conversation's cost is the MAX of its runs (cost is per-transcript and cumulative — summing
 *     would multiply one bill by the number of resumes);
 *   - the folded verdict + summary come from the same reporting run;
 *   - a re-dispatch of the same work to the same agent is flagged, and a DIFFERENT task is not;
 *   - a delegate's pending ask/approval lands on that delegate's node (what the rail answers in place);
 *   - viewer scoping matches the sessions list — a member never sees another member's run through it;
 *   - self-parenting and cycles can't wedge the walk.
 * Isolated home; no tmux or claude needed (the walk is pure over the DB). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chain-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
const owner = mkMember('owner@testco.dev', 'owner');
const alice = mkMember('alice@testco.dev', 'member');
const bob = mkMember('bob@testco.dev', 'member');

const T0 = Date.now() - 3_600_000;
let n = 0;
/** One RUN. `claude` is the conversation it belongs to — several runs share it after a poke-back. */
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent: 'engineer', title: 't', task: 'x', tmux: 'aos-' + id, status: 'done',
    spawned_by: alice.id, run_as: alice.id, claude_session_id: 'cs_eng', archived_at: null,
    cost_usd: null, outcome: null, report_summary: null,
    created_at: T0 + n * 60_000, updated_at: T0 + n * 60_000, ...o,
  };
  aos.db.prepare(`INSERT INTO term_sessions
      (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,cost_usd,outcome,report_summary,created_at,updated_at)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@cost_usd,@outcome,@report_summary,@created_at,@updated_at)`).run(cols);
  return id;
};
const mkTask = (o) => aos.tasks.create({ tenant: aos.tenant, createdBy: 'agent:engineer', owner: alice.id, pokeOnDone: true, ...o });

// ── the fixture: engineer → qa, then engineer → release-orchestrator twice (the re-dispatch) ──
// The caller's own conversation: a member spawn plus two poke-back resumes, all one transcript.
const engRun1 = mkRun({ title: 'ship PR #1', cost_usd: 40, outcome: 'success', report_summary: 'opened PR #1' });
const tQa = mkTask({ title: 'QA: PR #1', assignee: 'agent:qa', callerAgent: 'agent:engineer', callerClaudeId: 'cs_eng' });
const tRel1 = mkTask({ title: 'Promote PR #1', assignee: 'agent:release', callerAgent: 'agent:engineer', callerClaudeId: 'cs_eng' });
const tRel2 = mkTask({ title: 'Promote PR #1', assignee: 'agent:release', callerAgent: 'agent:engineer', callerClaudeId: 'cs_eng' });
const tOther = mkTask({ title: 'Promote PR #2', assignee: 'agent:release', callerAgent: 'agent:engineer', callerClaudeId: 'cs_eng' });

const engRun2 = mkRun({ spawned_by: `poke:${tQa.id}`, title: 'Poke ← qa done: QA: PR #1', cost_usd: 70, outcome: 'unknown' });
const engRun3 = mkRun({ spawned_by: `poke:${tRel1.id}`, title: 'Poke ← release done: Promote PR #1', cost_usd: 95, outcome: 'unknown' });

const qaRun = mkRun({ agent: 'qa', claude_session_id: 'cs_qa', spawned_by: `task:${tQa.id}`, title: 'Task: QA: PR #1', cost_usd: 12, outcome: 'success', report_summary: 'QA PASS — 10/10 criteria' });
const relRun1 = mkRun({ agent: 'release', claude_session_id: 'cs_rel1', spawned_by: `task:${tRel1.id}`, title: 'Task: Promote PR #1', cost_usd: 9, outcome: 'success', report_summary: 'promotion PR opened' });
const relRun2 = mkRun({ agent: 'release', claude_session_id: 'cs_rel2', spawned_by: `task:${tRel2.id}`, title: 'Task: Promote PR #1', cost_usd: 6, outcome: 'success', report_summary: 'already open from a prior run' });
const relRun3 = mkRun({ agent: 'release', claude_session_id: 'cs_rel3', spawned_by: `task:${tOther.id}`, title: 'Task: Promote PR #2', cost_usd: 5, outcome: 'success', report_summary: 'PR #2 promoted' });
// A quick-answer run — an ephemeral delegate that never took the task over.
const askRun = mkRun({ agent: 'docs', claude_session_id: 'cs_ask', spawned_by: `ask:${tQa.id}`, title: 'Answer · QA: PR #1', cost_usd: 1, outcome: 'success', report_summary: 'answered in the discussion' });

const chain = tm.sessionChain(engRun1);
const node = (agent, i = 0) => chain.nodes.filter((x) => x.agent === agent)[i];

console.log('\n\x1b[1mchain shape\x1b[0m');
assert(chain && chain.rootThreadId === 'cs_eng', 'root is the caller conversation');
// 1 root + qa + 3 release + the quick answer = 6 conversations, NOT the 9 runs behind them.
assert(chain.nodes.length === 6, 'one node per conversation, not per run', `got ${chain.nodes.length}`);
assert(node('engineer').runs === 3, 'the caller\'s poke-back resumes fold into its own node', `runs=${node('engineer').runs}`);
assert(chain.nodes.filter((x) => x.depth === 0).length === 1, 'exactly one root');
assert(chain.nodes.filter((x) => x.depth === 1).length === 5, 'every delegate hangs off the caller');
assert(chain.agents === 4, 'distinct agents counted', `agents=${chain.agents}`);
assert(node('docs').kind === 'answer', 'an `ask:` run reads as a quick answer, not a hand-off');
assert(node('qa').kind === 'delegate' && node('engineer').kind === 'root', 'kinds resolve');
assert(node('qa').taskId === tQa.id && node('qa').taskTitle === 'QA: PR #1', 'the delegate carries its task');

console.log('\n\x1b[1mfolded facts\x1b[0m');
assert(node('engineer').costUsd === 95, 'conversation cost is the MAX of its runs, not the sum', `got ${node('engineer').costUsd}`);
assert(chain.totalCostUsd === 95 + 12 + 9 + 6 + 5 + 1, 'chain total sums the conversations', `got ${chain.totalCostUsd}`);
assert(node('engineer').title === 'ship PR #1', 'a poke\'s machine-written title never labels the conversation');
assert(node('engineer').summary === 'opened PR #1' && node('engineer').outcome === 'success',
  'verdict + summary come from the same reporting run (not "no report" beside a report)');
assert(node('engineer').createdAt === chain.startedAt, 'the chain starts when the caller did');

console.log('\n\x1b[1mre-dispatch\x1b[0m');
assert(node('release', 0).duplicateOf === undefined, 'the first hand-off is not a duplicate');
assert(node('release', 1).duplicateOf === tRel1.id, 'the same work re-handed to the same agent is flagged');
assert(node('release', 2).duplicateOf === undefined, 'a DIFFERENT task to the same agent is not a duplicate');

console.log('\n\x1b[1mseeded from anywhere\x1b[0m');
for (const [label, seed] of [['a delegate', qaRun], ['a poke-back run', engRun3], ['the re-dispatch', relRun2]]) {
  const c = tm.sessionChain(seed);
  assert(c && c.rootThreadId === 'cs_eng' && c.nodes.length === 6, `${label} resolves the same chain`, c && `${c.rootThreadId}/${c.nodes.length}`);
}
assert(tm.sessionChain('ts_nope') === null, 'an unknown session has no chain');

console.log('\n\x1b[1mwaiting on a human\x1b[0m');
const q = tm.askQuestion(qaRun, 'qa', 'Which browser matrix?');
const after = tm.sessionChain(engRun1);
const qaNode = after.nodes.find((x) => x.agent === 'qa');
assert(qaNode.pending.length === 1 && qaNode.pending[0].kind === 'question', 'a delegate\'s open ask lands on the delegate\'s node');
assert(qaNode.pending[0].id === q.id && qaNode.pending[0].text === 'Which browser matrix?', 'it carries the id the answer route takes');
assert(after.nodes.filter((x) => x.pending.length).length === 1, 'and only on that node');
tm.answerQuestion(q.id, 'chromium + firefox', owner.email);
assert(tm.sessionChain(engRun1).nodes.every((x) => !x.pending.length), 'answering clears it');

console.log('\n\x1b[1mlive state\x1b[0m');
// The rail draws its dot with the sessions list's semantics, so the node has to carry the same two
// facts: unattended vs. driven, and blocked-on-a-human vs. working.
aos.db.prepare("UPDATE term_sessions SET status='running', headless=1 WHERE id=?").run(relRun1);
let live = tm.sessionChain(engRun1).nodes.find((x) => x.threadId === 'cs_rel1');
assert(live.status === 'running' && live.headless === true, 'a live unattended delegate reports running + headless');
assert(live.blocked === false, 'and is not blocked while nothing waits on a human');
const q2 = tm.askQuestion(relRun1, 'release', 'Merge to main?');
live = tm.sessionChain(engRun1).nodes.find((x) => x.threadId === 'cs_rel1');
assert(live.blocked === true && live.pending.length === 1, 'asking a question flips it to blocked');
tm.answerQuestion(q2.id, 'yes', owner.email);
assert(tm.sessionChain(engRun1).nodes.find((x) => x.threadId === 'cs_rel1').blocked === false, 'answering clears blocked');
aos.db.prepare("UPDATE term_sessions SET status='done', headless=0 WHERE id=?").run(relRun1);
assert(tm.sessionChain(engRun1).nodes.find((x) => x.threadId === 'cs_rel1').blocked === false, 'an ended run is never blocked');

console.log('\n\x1b[1mvisibility\x1b[0m');
assert(tm.sessionChain(engRun1, owner).nodes.length === 6, 'owner sees the whole chain');
assert(tm.sessionChain(engRun1, alice).nodes.length === 6, 'the member who owns the runs sees it');
assert(tm.sessionChain(engRun1, bob) === null, 'a member who can\'t see the seed gets no chain');
// A delegate that ran as someone else drops out of alice's view — with its subtree, never leaked.
aos.db.prepare("UPDATE term_sessions SET run_as=? WHERE id=?").run(bob.id, relRun3);
assert(tm.sessionChain(engRun1, alice).nodes.length === 5, 'a run she can\'t see is omitted from her chain');
assert(tm.sessionChain(engRun1, owner).nodes.length === 6, 'and still present for the owner');

console.log('\n\x1b[1mcycle guards\x1b[0m');
// A task whose caller is its OWN delegate — the shape a cycle would take.
const tLoop = mkTask({ title: 'loop', assignee: 'agent:qa', callerAgent: 'agent:qa', callerClaudeId: 'cs_loop' });
const loopRun = mkRun({ agent: 'qa', claude_session_id: 'cs_loop', spawned_by: `task:${tLoop.id}`, title: 'Task: loop' });
const loop = tm.sessionChain(loopRun);
assert(loop && loop.nodes.length === 1 && loop.rootThreadId === 'cs_loop', 'a self-parented conversation is its own root, once', loop && `${loop.nodes.length}`);

console.log('\n\x1b[1mlist stamps (the collapse)\x1b[0m');
const rows = tm.listSessions(owner);
const row = (id) => rows.find((r) => r.id === id);
assert(row(engRun2).threadId === 'cs_eng' && row(engRun1).threadId === 'cs_eng', 'runs of one transcript share a threadId');
assert(new Set(rows.filter((r) => r.agent === 'engineer').map((r) => r.threadId)).size === 1, 'so the caller collapses to one entry');
assert(row(qaRun).parentThreadId === 'cs_eng' && row(qaRun).taskId === tQa.id, 'a delegate points at its caller + task');
assert(row(engRun2).parentThreadId === 'cs_eng', 'a poke resolves to its OWN thread (no parent = not a hand-off)');
assert(row(engRun1).parentThreadId === undefined && row(engRun1).taskId === undefined, 'a member-spawned run has no chain edge');

// ── steering a live hand-off: the northwind 2026-08-06 incident (tsk_67de2dfe) ──
// A manager put its own delegated task on HOLD. The stand-down reached a NEWLY SPAWNED run while the
// agent actually executing kept going for 25+ minutes, and the manager poked itself for the transition.
console.log('\n\x1b[1msteering a live delegate\x1b[0m');
{
  const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
  const autos = new Automations(aos, tm);
  const injected = [];
  tm.backend.injectText = (space, tmuxName, body) => { injected.push({ tmux: tmuxName, body }); return true; };
  // `reachable` is the one liveness predicate — delivery AND the dispatch pile-up guards read it.
  // Only the delegate is up.
  tm.reachable = (id) => id === liveDelegate;

  const held = mkTask({ title: 'ship batch 1', assignee: 'agent:builder', callerAgent: 'agent:manager', callerClaudeId: 'cs_mgr' });
  var liveDelegate = mkRun({ agent: 'builder', claude_session_id: 'cs_build', spawned_by: `task:${held.id}`, status: 'running', title: 'Task: ship batch 1' });
  aos.db.prepare('UPDATE term_sessions SET headless = 1, resident = 0 WHERE id = ?').run(liveDelegate);   // unattended: the case that was unreachable
  aos.tasks.markDispatched(held.id, liveDelegate);

  // An unattended run is an attachable TUI — delivery must reach it (this is what was broken).
  assert(tm.deliverToResident(liveDelegate, 'stand down') === true, 'a live UNATTENDED run can be messaged');
  assert(tm.deliverToResident(mkRun({ status: 'done' }), 'x') === false, 'a run with no live pane cannot');

  // A HOLD by the caller reaches the run that is doing the work.
  injected.length = 0;
  const notices = [];
  aos.tasks.setNotifier((n) => notices.push(n));
  aos.tasks.update(held.id, { status: 'blocked', note: 'HOLD - auto-dispatch was unintended', by: 'agent:manager' });
  const notice = notices.find((n) => n.kind === 'status');
  assert(!!notice && notice.by === 'agent:manager', 'the notice names the actor');
  // (the tenant-registry wiring is what calls maybeHoldDelegate; assert the pieces it depends on)
  assert(aos.tasks.get(held.id).lastSessionId === liveDelegate, 'the task still points at the RUNNING delegate');
  assert(aos.tasks.latestNote(held.id).startsWith('HOLD'), 'the reason is available to forward');

  // A parked task is not re-dispatchable by any guarded path.
  const blocked = autos.dispatchTask(held.id, { guard: true, by: 'test' });
  assert(blocked.ok === false && /blocked/.test(blocked.reason), 'a blocked task refuses a guarded dispatch', blocked.reason);
  // …but a human forcing it from the console still gets PAST the park (it stops on this scratch home's
  // missing agent manifest, not on the block — spawning a real one would start a real tmux session).
  tm.reachable = () => false;
  const forced = autos.dispatchTask(held.id, { guard: false, by: 'human' });
  assert(!/blocked/.test(forced.reason || ''), 'a human forcing it is not refused for being blocked', forced.reason);

  // And a still-working delegate is never given a rival by the discussion path.
  tm.reachable = (id) => id === liveDelegate;
  tm.deliverToResident = () => false;   // simulate an undeliverable pane
  tm.reviveResident = () => false;
  const before = aos.db.prepare('SELECT COUNT(*) AS c FROM term_sessions').get().c;
  const r = autos.continueTaskThread(held.id, 'manager', 'stand down', 'builder');
  assert(r.status === 'none', 'an undeliverable LIVE run is reported, not duplicated', r.status);
  assert(aos.db.prepare('SELECT COUNT(*) AS c FROM term_sessions').get().c === before, 'no rival session was spawned');
}

// ── the walk's three lookups must be INDEXED ─────────────────────────────────────────────────────
// Each one was a full scan of `term_sessions`/`tasks`, and the walk repeats them per node — measured
// 63 ms per chain on the live instawp tenant (4,193 sessions), 1.4 ms with these indexes. A future
// migration dropping one would put that straight back with nothing failing.
{
  console.log('\nchain lookups are indexed');
  const idx = aos.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_sessions_claude','idx_sessions_spawned_by','idx_tasks_caller')").all().map((r) => r.name).sort();
  assert(idx.join() === 'idx_sessions_claude,idx_sessions_spawned_by,idx_tasks_caller', 'migration creates all three chain indexes', idx.join());
  const plan = (sql, ...args) => aos.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail).join(' ');
  assert(/USING (COVERING )?INDEX idx_sessions_claude/.test(plan("SELECT * FROM term_sessions WHERE claude_session_id = 'x' OR (claude_session_id IS NULL AND id = 'x')")), 'a conversation is found by index, not a scan');
  assert(/USING (COVERING )?INDEX idx_sessions_spawned_by/.test(plan("SELECT * FROM term_sessions WHERE spawned_by = 'a' OR spawned_by = 'b'")), 'the runs dispatched for a task are found by index');
  assert(/USING (COVERING )?INDEX idx_tasks_caller/.test(plan("SELECT id FROM tasks WHERE caller_claude_id = 'x'")), 'the caller one level up is found by index');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
