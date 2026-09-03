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
 *   7 a wake-up that can never be delivered EXPIRES loudly — audit + an inbox card to the run's owner;
 *   8 a `poke-done` INJECTS into a live pane but never resurrects a cold caller — good news is not worth a
 *     claude, and resurrecting one is what fed the delegation loop (see the wakeups.ts module header);
 *   9 a hand-back (`poke-blocked`) still resumes, and one in a batch carries the completions along.
 *  12 the SIBLING lane refuses a run acting as a different member — 25% of live sibling injects were one,
 *     and the answer came back to the wrong human (see the wakeups.ts module header);
 *  13 …and refuses a sibling bound to its own Slack/Discord/DM conversation, for the same reason;
 *  14 a `poke-done` never takes the sibling lane at all — out of context is not cheap, it is misdelivered;
 *  15 a dropped completion leaves one line on the TASK, so the silence reads as a decision, not a loss.
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
const { MAX_ATTEMPTS, WAKE_KIND_DONE } = require(path.join(ROOT, 'dist/edge/wakeups.js'));

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

console.log('\n\x1b[1m8) a `poke-done` injects into a live caller but never RESUMES a cold one\x1b[0m');
{
  // Live caller: a completion is cheap and in-context — this lane is exactly what the poke was built for.
  idleAgent();
  const live = mkSession('cs-8', { status: 'done' });
  const hit = q.enqueue({ agent: 'caller', transcript: 'cs-8', runAs: alice.id, source: 'tsk_8a', message: '✅ Really done: shipped', kind: WAKE_KIND_DONE });
  assert(hit.ok && hit.sessionId === live && hit.via === 'inject', 'a live caller still hears it, in its own pane', hit);

  // Cold caller: nobody is stuck, the result is durable in the task, the human already has the card.
  idleAgent();
  mkSession('cs-8b', { status: 'done', pane: false });
  const before = spawned.length;
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-8b', runAs: alice.id, source: 'tsk_8b', message: '✅ Really done: shipped', kind: WAKE_KIND_DONE });
  assert(!r.ok && !r.queued, 'a cold caller is left cold — decided, not deferred', r);
  assert(spawned.length === before, 'NO claude spawned to deliver good news', spawned.slice(before));
  const row = aos.db.prepare("SELECT * FROM agent_wakeups WHERE source = 'tsk_8b'").get();
  assert(row.status === 'dropped', 'the row settles `dropped`, so it never expires into an inbox card', row);
  const skip = aos.db.prepare("SELECT * FROM audit_events WHERE type = 'agent.poke.skipped' ORDER BY id DESC LIMIT 1").get();
  assert(skip && JSON.parse(skip.data).reason === 'done-cold-caller', 'and the skip is audited next to the pokes that did fire', skip && skip.data);
  q.sweep(5);
  assert(spawned.length === before, 'and no tick resurrects it later', spawned.slice(before));
}

console.log('\n\x1b[1m9) a HAND-BACK still resumes — and carries any completions with it\x1b[0m');
{
  idleAgent();
  mkSession('cs-9', { status: 'done', pane: false });
  const before = spawned.length;
  // The hand-off that earns the resume is held first (no headroom); the completion lands while it waits.
  // Order matters and should: a completion arriving at a cold caller with nothing else pending is DECIDED
  // on arrival (case 8), not parked in the hope that a hand-back turns up later to pay for a session.
  q.enqueue({ agent: 'caller', transcript: 'cs-9', runAs: alice.id, source: 'tsk_9b', message: '⛔ Handed back: blocked on a key', kind: 'poke-blocked' }, { budget: 0 });
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-9', runAs: alice.id, source: 'tsk_9a', message: '✅ Really done: the easy half', kind: WAKE_KIND_DONE }, { budget: 5 });
  assert(r.ok && r.via === 'resume', 'the caller is the only one who can move a blocked hand-off', r);
  assert(spawned.length === before + 1, 'one session for the batch', spawned.slice(before));
  const task = spawned[spawned.length - 1].task;
  assert(task.includes('blocked on a key') && task.includes('the easy half'), 'the completion rides along free rather than being dropped', task.slice(0, 200));
  assert(rows('pending').length === 0, 'nothing left pending', rows('pending'));

  // A stranded delegate (its run died without closing) is the other resume-worthy class.
  idleAgent();
  mkSession('cs-9c', { status: 'done', pane: false });
  const n2 = spawned.length;
  const s = q.enqueue({ agent: 'caller', transcript: 'cs-9c', runAs: alice.id, source: 'tsk_9c', message: '⚠️ Ran out: it ended without closing', kind: 'poke-stranded' }, { budget: 5 });
  assert(s.ok && s.via === 'resume' && spawned.length === n2 + 1, 'a stranding wakes the caller too', s);
}

console.log('\n\x1b[1m10) a FINISHED run is not a delivery target for good news\x1b[0m');
{
  idleAgent();
  // `report` is the agent saying it is done. Its pane stays reachable (that is the attachable lane), which
  // is why 55% of live injects landed in one — a resurrection in place of a run that had already finished.
  const reported = (id) => aos.audit.append({ ts: Date.now(), runId: id, tenant: aos.tenant, principal: 'caller', type: 'session.reported', data: {} });

  const fin = mkSession('cs-fin');
  reported(fin);
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-fin', runAs: alice.id, source: 'tsk_fin', message: '✅ done', title: 'p', kind: 'poke-done' });
  assert(!r.ok, 'good news is NOT injected into a run that already reported', r);
  const row = aos.db.prepare("SELECT * FROM agent_wakeups WHERE source = 'tsk_fin'").get();
  assert(row.status === 'dropped', 'it drops, exactly as it would for a cold caller', row);
  assert(aos.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE run_id = ? AND type = 'session.inject'").get(fin).n === 0, 'the finished pane was never typed into');

  // …but a STRANDING still reaches it: somebody is stuck, and an inject beats spending a resume.
  const r2 = q.enqueue({ agent: 'caller', transcript: 'cs-fin', runAs: alice.id, source: 'tsk_str', message: '⛔ handed back', title: 'p', kind: 'poke-stranded' });
  assert(r2.ok && r2.via === 'inject' && r2.sessionId === fin, 'a hand-back still injects into the finished pane', r2);
  assert(spawned.filter((x) => x.spawnedBy === 'poke:tsk_str').length === 0, 'and costs no resume');
}

console.log('\n\x1b[1m11) a still-working session is preferred over a finished one\x1b[0m');
{
  idleAgent();
  const reported = (id) => aos.audit.append({ ts: Date.now(), runId: id, tenant: aos.tenant, principal: 'caller', type: 'session.reported', data: {} });
  const older = mkSession('cs-old');           // finished, but NEWER in creation order below
  reported(older);
  const working = mkSession('cs-work');        // still running, no report
  // The sibling lane picks the newest live session; `working` is newest here, so prove the preference by
  // making the FINISHED one newest instead.
  const newestFinished = mkSession('cs-new-fin');
  reported(newestFinished);
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-absent', runAs: alice.id, source: 'tsk_sib', message: '⛔ handed back', title: 'p', kind: 'poke-stranded' });
  assert(r.ok && r.via === 'inject-sibling', 'delivered to a sibling', r);
  assert(r.sessionId === working, 'the STILL-WORKING sibling wins over two finished ones', { got: r.sessionId, working, older, newestFinished });
}

console.log('\n\x1b[1m12) the sibling lane refuses a run acting as a DIFFERENT member\x1b[0m');
{
  idleAgent();
  const bob = aos.team.invite({ email: 'bob@testco.dev', role: 'member' }).member;
  mkSession('cs-12', { pane: false });                              // the caller's own transcript: cold
  const other = mkSession('cs-12-sib', { run_as: bob.id, spawned_by: bob.id });
  const before = spawned.length;
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-12', runAs: alice.id, source: 'tsk_12', message: '⚠️ handed back', title: 'p', kind: 'poke-stranded' });
  assert(r.ok && r.via === 'resume', 'it resumes the caller\'s OWN transcript instead', r);
  assert(spawned.length === before + 1 && spawned[spawned.length - 1].resumeClaudeId === 'cs-12', 'on the right transcript', spawned[spawned.length - 1]);
  assert(!injected.some((i) => i.tmux === 'aos-' + other), 'Bob\'s run was never typed into', other);
}

console.log('\n\x1b[1m13) …nor a sibling that answers into its own conversation\x1b[0m');
{
  idleAgent();
  mkSession('cs-13', { pane: false });
  const chat = mkSession('cs-13-sib');                               // same member, but Slack-bound
  aos.db.prepare('INSERT INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?,?,?,?)')
    .run(chat, 'C123', '1725.0001', Date.now());
  const before = spawned.length;
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-13', runAs: alice.id, source: 'tsk_13', message: '⚠️ handed back', title: 'p', kind: 'poke-stranded' });
  assert(r.ok && r.via === 'resume', 'a thread-bound sibling would reply to the wrong audience', r);
  assert(!injected.some((i) => i.tmux === 'aos-' + chat), 'so it is never typed into', chat);
  assert(spawned.length === before + 1, 'and the wake-up still lands, on its own transcript');
}

console.log('\n\x1b[1m14) a `poke-done` never takes the sibling lane at all\x1b[0m');
{
  idleAgent();
  mkSession('cs-14', { pane: false });                              // own transcript cold
  const sib = mkSession('cs-14-sib');                               // a perfectly eligible sibling
  const before = spawned.length;
  const r = q.enqueue({ agent: 'caller', transcript: 'cs-14', runAs: alice.id, source: 'tsk_14', message: '✅ Really done: shipped', title: 'p', kind: WAKE_KIND_DONE });
  assert(!r.ok && !r.queued, 'good news out of context is misdelivery, not a cheap delivery', r);
  assert(!injected.some((i) => i.tmux === 'aos-' + sib), 'the sibling was left alone', sib);
  assert(spawned.length === before, 'and nothing was resumed either');
  assert(livePanes.has('aos-' + sib), 'nor was the sibling\'s run ended');
}

console.log('\n\x1b[1m15) a dropped completion leaves one line on the TASK\x1b[0m');
{
  idleAgent();
  const t = aos.tasks.create({ tenant: aos.tenant, title: 'ship the thing', assignee: 'agent:worker', createdBy: 'agent:caller', owner: alice.id });
  mkSession('cs-15', { pane: false });
  q.enqueue({ agent: 'caller', transcript: 'cs-15', runAs: alice.id, source: t.id, message: '✅ Really done: shipped', title: 'p', kind: WAKE_KIND_DONE });
  const ev = aos.db.prepare("SELECT * FROM task_events WHERE task_id = ? AND kind = 'status' AND body LIKE '%not woken%'").all(t.id);
  assert(ev.length === 1, 'the drop is legible on the board, not a lost poke', ev.map((e) => e.body));
  assert(aos.tasks.latestNote(t.id) === undefined, 'and it is NOT a comment — latestNote is the task RESULT', aos.tasks.latestNote(t.id));
  // Re-fired: still one line, never a column of them.
  q.enqueue({ agent: 'caller', transcript: 'cs-15', runAs: alice.id, source: t.id, message: '✅ Really done: shipped again', title: 'p', kind: WAKE_KIND_DONE });
  assert(aos.db.prepare("SELECT COUNT(*) n FROM task_events WHERE task_id = ? AND body LIKE '%not woken%'").get(t.id).n === 1, 'written once');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
