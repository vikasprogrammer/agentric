#!/usr/bin/env node
/* The agent WAKE QUEUE (src/edge/wakeups.ts) — durability, coalescing, and the one priority order.
 *
 * `pokeCaller` used to decide inline how to reach a caller, with no memory of the attempt. Four bugs came
 * out of that (v0.307.0 stranded hand-offs, v0.334.1 status-vs-pane, v0.334.2 `isAlive`, v0.354.1
 * transcript-vs-agent liveness), each a correct fix that left the class alone. The queue replaces the
 * decision with a row: producers enqueue, ONE deliverer picks the lane, and anything undeliverable is
 * retried by the scheduler instead of being decided-and-forgotten.
 *
 * Pins the contract that makes that worth having:
 *   1 delivery is recorded, not just performed;
 *   2 the same hand-off re-fired while pending wakes the caller ONCE, with the latest message;
 *   3 several pending wake-ups COALESCE into one resume — N results, one claude, none lost;
 *   4 a wedged sibling holds the wake-up (never a rival claude, never a drop) and the retry delivers it;
 *   5 a wedged OWN transcript is still killed before resuming — that conversation has no other door;
 *   6 the concurrency cap defers the resume lane instead of dropping it;
 *   7 a wake-up that can never be delivered EXPIRES loudly — audit + an inbox card to the run's owner.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-wakeup-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { MAX_ATTEMPTS } = require(path.join(ROOT, 'dist/edge/wakeups.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

// ── stub backend: we choose which panes are alive and record every delivery ──────────────────────
const livePanes = new Set();
const injected = [];
let injectWorks = true;
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return injectWorks && livePanes.has(tmux); };
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

aos.agents.set('caller', { id: 'caller', name: 'Caller', runtime: 'claude-code', dir: HOME });
aos.team.bootstrapOwner('alice@testco.dev', 'Alice');
const alice = aos.team.getMemberByEmail('alice@testco.dev');

let n = 0, clock = Date.now() - 3_600_000;
const spawned = [];
tm.createSession = (agent, title, task, spawnedBy, headless, slack, discord, runAs, resumeClaudeId) => {
  const id = 'ses_wk_' + (++n);
  spawned.push({ id, agent, spawnedBy, resumeClaudeId: resumeClaudeId ?? null, task, runAs: runAs ?? null });
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,claude_session_id,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',1,0,?,?,?,?,?)`)
    .run(id, agent, title || 't', task || 'x', 'aos-' + id, runAs ?? null, spawnedBy ?? null, resumeClaudeId ?? ('cuid_' + id), (clock += 1000), clock);
  livePanes.add('aos-' + id);   // a spawned session HAS a pane — the real launcher's behaviour, and what
  return { id, tmux: 'aos-' + id };   // makes a wake-up arriving right after a resume land in it, not beside it.
};

const mkSession = (cs, opts = {}) => {
  const id = 'ses_s_' + (++n);
  const { pane, ...over } = opts;
  const cols = {
    id, agent: 'caller', title: 'sweep', task: 'sweep', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claude_session_id: cs, secret: 'sec', spawned_by: alice.id,
    run_as: alice.id, busy_since: null, last_activity: null, created_at: (clock += 1000), updated_at: clock, ...over,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  if (pane !== false) livePanes.add(cols.tmux);
  return id;
};
const idleAgent = () => { for (const r of aos.db.prepare("SELECT tmux FROM term_sessions WHERE agent = 'caller'").all()) livePanes.delete(r.tmux); };

const autos = new Automations(aos, tm);
const q = autos.wakeups;
const wake = (transcript, source, message) =>
  q.enqueue({ agent: 'caller', transcript, runAs: alice.id, source, message: message ?? `✅ Really done: ${source}`, title: `Poke ← ${source}` });
const rows = (status) => aos.db.prepare('SELECT * FROM agent_wakeups WHERE status = ? ORDER BY created_at').all(status);

console.log('\n\x1b[1m1) a delivered wake-up is RECORDED, not just performed\x1b[0m');
{
  const s = mkSession('cs-1', { status: 'done' });           // reported, claude still up
  const r = wake('cs-1', 'tsk_1');
  assert(r.ok && r.sessionId === s && r.via === 'inject', 'delivered into the caller\'s own pane', r);
  assert(rows('pending').length === 0, 'nothing left pending', rows('pending'));
  const done = aos.db.prepare("SELECT * FROM agent_wakeups WHERE source = 'tsk_1'").get();
  assert(done.status === 'delivered' && done.delivered_via === 'inject' && done.delivered_session === s, 'the row says where it went', done);
}

console.log('\n\x1b[1m2) the same hand-off re-fired while pending wakes the caller ONCE, with the latest message\x1b[0m');
{
  idleAgent();
  mkSession('cs-2', { status: 'done', pane: false });
  injectWorks = false;                                       // force it to stay queued
  const live = mkSession('cs-2b', { status: 'running' });     // a wedged sibling holds everything
  wake('cs-2', 'tsk_2', 'first: blocked on review');
  wake('cs-2', 'tsk_2', 'second: actually done');
  injectWorks = true;
  const pending = rows('pending');
  assert(pending.length === 1, 'one row, not two — (agent, source, kind) is the dedupe key', pending);
  assert(/actually done/.test(pending[0].message), 'and it carries the LATEST truth', pending[0].message);
  livePanes.delete('aos-' + live);
  idleAgent();
  q.sweep();
  assert(spawned[spawned.length - 1].task.includes('actually done'), 'which is what the caller is finally told', spawned[spawned.length - 1].task);
  assert(rows('pending').length === 0, 'queue drained');
}

console.log('\n\x1b[1m3) several pending wake-ups COALESCE — N results, ONE claude\x1b[0m');
{
  idleAgent();
  mkSession('cs-3', { status: 'done', pane: false });
  const before = spawned.length;
  // Both arrive while delivery is impossible (here: no concurrency headroom), so both sit in the queue.
  // The point of the queue is that they then leave it TOGETHER — two delegates finishing while the caller
  // is down must not race two claudes onto one transcript.
  q.enqueue({ agent: 'caller', transcript: 'cs-3', runAs: alice.id, source: 'tsk_3a', message: 'delegate A: shipped' }, { budget: 0 });
  q.enqueue({ agent: 'caller', transcript: 'cs-3', runAs: alice.id, source: 'tsk_3b', message: 'delegate B: blocked on a key' }, { budget: 0 });
  assert(rows('pending').length === 2, 'both held', rows('pending').length);
  q.sweep(5);
  assert(spawned.length === before + 1, 'exactly ONE new session for the pair', spawned.slice(before));
  const s = spawned[spawned.length - 1];
  assert(s.task.includes('delegate A: shipped') && s.task.includes('delegate B: blocked on a key'), 'carrying BOTH results', s.task.slice(0, 200));
  assert(/2 updates/.test(s.task), 'and told how many there are, so it cannot act on only the first', s.task.slice(0, 120));
  assert(rows('pending').length === 0, 'both rows settled', rows('pending'));
}

console.log('\n\x1b[1m3b) a wake-up arriving just after a resume lands IN that run, not beside it\x1b[0m');
{
  idleAgent();
  mkSession('cs-3b', { status: 'done', pane: false });
  const before = spawned.length;
  wake('cs-3b', 'tsk_3c');                       // nothing live → resume; the new run now owns the transcript
  const first = spawned[spawned.length - 1];
  const r = wake('cs-3b', 'tsk_3d');             // seconds later, another delegate finishes
  assert(spawned.length === before + 1, 'no second claude — the first resume is the destination now', spawned.slice(before));
  assert(r.ok && r.sessionId === first.id && r.via === 'inject', 'it was typed into that run', r);
}

console.log('\n\x1b[1m4) a wedged SIBLING holds the wake-up — never a rival claude, never a drop\x1b[0m');
{
  idleAgent();
  mkSession('cs-4', { status: 'done', pane: false });          // the caller's own conversation, exited
  const sib = mkSession('cs-other', { status: 'running' });    // same agent, different transcript, working
  injectWorks = false;
  const before = spawned.length;
  const r = wake('cs-4', 'tsk_4');            // the sibling stays wedged for the whole case
  assert(!r.ok && r.queued, 'held, and it says so', r);
  assert(spawned.length === before, 'NOTHING spawned into a workspace an agent is live in', spawned.slice(before));
  assert(livePanes.has('aos-' + sib), 'the sibling pane is untouched — it is someone else\'s work');
  assert(rows('pending')[0].attempts === 1, 'the attempt is counted', rows('pending'));
  q.sweep();
  assert(spawned.length === before, 'a retry while it is STILL live stays held', spawned.slice(before));
  livePanes.delete('aos-' + sib);             // the sibling finally exits
  q.sweep();
  injectWorks = true;
  assert(spawned.length === before + 1, 'and delivers the moment the agent is free', spawned[spawned.length - 1]);
  assert(spawned[spawned.length - 1].resumeClaudeId === 'cs-4', 'onto the caller\'s OWN transcript', spawned[spawned.length - 1]);
}

console.log('\n\x1b[1m5) a wedged OWN transcript is killed before resuming — that conversation has no other door\x1b[0m');
{
  idleAgent();
  const c = mkSession('cs-5', { status: 'done' });   // live pane bound to the wake-up's own transcript
  injectWorks = false;
  const before = spawned.length;
  wake('cs-5', 'tsk_5');
  injectWorks = true;
  assert(!livePanes.has('aos-' + c), 'the wedged run was ended (never two claudes on one transcript)');
  assert(spawned.length === before + 1, 'and the wake-up resumed the transcript in its place', spawned[spawned.length - 1]);
  assert(rows('pending').length === 0, 'nothing left behind', rows('pending'));
}

console.log('\n\x1b[1m6) the concurrency cap DEFERS the resume lane, it does not drop it\x1b[0m');
{
  idleAgent();
  mkSession('cs-6', { status: 'done', pane: false });
  const before = spawned.length;
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-6', runAs: alice.id, source: 'tsk_6', message: 'done' }, { budget: 0 });
  assert(!r.ok && r.queued, 'over cap → queued', r);
  assert(spawned.length === before, 'no session spawned past the cap');
  q.sweep(5);
  assert(spawned.length === before + 1, 'the next tick with headroom delivers it', spawned[spawned.length - 1]);
}

console.log('\n\x1b[1m7) a wake-up that can never land EXPIRES loudly\x1b[0m');
{
  idleAgent();
  mkSession('cs-7', { status: 'done', pane: false });
  const sib = mkSession('cs-live', { status: 'running' });     // permanently wedged sibling
  injectWorks = false;
  wake('cs-7', 'tsk_7');
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) q.sweep();
  injectWorks = true;
  const dead = aos.db.prepare("SELECT * FROM agent_wakeups WHERE source = 'tsk_7'").get();
  assert(dead.status === 'expired', `given up on after ${MAX_ATTEMPTS} attempts`, dead);
  const audited = aos.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE type = 'agent.wakeup.expired'").get();
  assert(audited.n === 1, 'audited exactly once', audited);
  const card = aos.db.prepare("SELECT * FROM messages WHERE type = 'task' AND session_id = 'task:tsk_7'").get();
  assert(!!card, 'and a human is told what never landed — a silent pending row is the bug we started from', card);
  assert(card && card.audience_kind === 'member' && card.audience_id === alice.id, 'addressed to the run\'s owner', card);
  assert(livePanes.has('aos-' + sib), 'expiring never ends somebody else\'s run');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
