#!/usr/bin/env node
/* Idle-interactive reaper test — a detached member (headless=0) session idle past the configurable
 * timeout is closed (status→stopped), while recent/attached/claimed/disabled cases are left alone.
 * Isolated home; backend kill/hasClient stubbed so no real tmux is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-reap-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
// Stub the backend so the sweep is deterministic without a real tmux server.
let attached = new Set();               // tmux names with a "client" attached
const killed = [];
tm.backend.hasClient = (_space, tmux) => attached.has(tmux);
tm.backend.kill = (_space, tmux) => { killed.push(tmux); };
// Every session's pane reports ALIVE by default. `reapIdleSessions` runs crash detection first (sweep 0),
// so a stub returning an empty set marks every row `crashed` before the idle sweeps ever look at it — the
// whole file went red that way when that sweep was folded in. Sections that care override this.
tm.backend.aliveNames = () => new Set(aos.db.prepare('SELECT tmux FROM term_sessions').all().map((r) => r.tmux));

const H = 3600_000;
let n = 0;
const mkSession = (o) => {
  const id = 'ts_' + (++n);
  const cols = { id, agent: 'website-bot', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claimed_by: null, last_activity: null, spawned_by: 'm_alice',
    created_at: Date.now(), updated_at: Date.now(), ...o };
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claimed_by,last_activity,spawned_by,created_at,updated_at) VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claimed_by,@last_activity,@spawned_by,@created_at,@updated_at)").run(cols);
  return id;
};
const statusOf = (id) => aos.db.prepare("SELECT status s FROM term_sessions WHERE id=?").get(id).s;

console.log('\n\x1b[1m1) Settings.interactiveIdleTimeoutHours\x1b[0m');
assert(aos.settings.interactiveIdleTimeoutHours() === 48, 'unset → 48h default');
assert(aos.settings.setInteractiveIdleTimeoutHours(72) === 72, 'set 72 → 72');
assert(aos.settings.setInteractiveIdleTimeoutHours(0) === 0, 'set 0 → 0 (disabled)');
assert(aos.settings.setInteractiveIdleTimeoutHours(99999) === 24 * 30, 'clamps to 30 days max');

console.log('\n\x1b[1m2) reaper sweep (timeout = 48h)\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(48);
// Isolate sweep 3: the unattended backstops (24h hard ceiling, 30m no-progress) would otherwise claim
// this section's 96h-old headless control row themselves, which is sweep 2's job, not what we assert here.
aos.settings.setUnattendedMaxHours(0);
aos.settings.setUnattendedNoProgressMinutes(0);

const stale = mkSession({ created_at: Date.now() - 96 * H });                 // 4 days idle → reap
const recent = mkSession({ created_at: Date.now() - 2 * H });                 // 2h → keep
const attachedStale = mkSession({ created_at: Date.now() - 96 * H, tmux: 'aos-ATTACHED' }); attached.add('aos-ATTACHED'); // in use → keep
const claimedStale = mkSession({ created_at: Date.now() - 96 * H, claimed_by: 'm_bob' }); // human owns it → keep
const unattended = mkSession({ created_at: Date.now() - 96 * H, headless: 1 });   // sweep-2 territory, not sweep 3 → keep here
const activeByLastAct = mkSession({ created_at: Date.now() - 96 * H, last_activity: Date.now() - 1 * H }); // recent turn → keep

tm.reapIdleSessions();

assert(statusOf(stale) === 'stopped', 'detached 4-day-idle member session → stopped');
assert(killed.includes('aos-' + stale), 'its pane was killed');
assert(statusOf(recent) === 'running', 'recent (2h) session → left running');
assert(statusOf(attachedStale) === 'running', 'attached session (client present) → left running');
assert(statusOf(claimedStale) === 'running', 'claimed take-over → left running');
assert(statusOf(unattended) === 'running', 'headless=1 unattended → not touched by sweep 3');
assert(statusOf(activeByLastAct) === 'running', 'old but recent last_activity → left running');

console.log('\n\x1b[1m3) disabled (timeout = 0) reaps nothing\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(0);
const stale2 = mkSession({ created_at: Date.now() - 200 * H });
tm.reapIdleSessions();
assert(statusOf(stale2) === 'running', 'timeout 0 → even a 200h-idle session is left alone');

/* Sweep 2 — the done-orphan pane leak. An unattended run whose gate hit the fail-closed deny (or whose
 * `ask` parked) wraps up with `report`: the row goes 'done' while the approval/question stays pending
 * forever, because nothing expires an unanswered card. The block-skip used to fire on that finished run
 * and pin its tmux pane + `claude` process open indefinitely. A done run cannot consume an answer, so it
 * is reaped and its card cancelled; a still-RUNNING blocked run is untouched. */
console.log('\n\x1b[1m4) sweep 2: a done orphan blocked on an unanswered card\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(48);
const pendingApprovalFor = (id) => {
  const { req } = aos.approvals.request({ runId: id, tenant: aos.tenant, level: 'owner', reason: 'test',
    attempt: { capabilityId: 'ssh.exec', args: {}, reasoning: '' } });
  return req.id;
};
const pendingQuestionFor = (id) => {
  const qid = 'qst_' + id;
  aos.db.prepare('INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(qid, id, aos.tenant, 'website-bot', 'which one?', 'pending', Date.now());
  return qid;
};
const qStatus = (qid) => aos.db.prepare('SELECT status s FROM questions WHERE id=?').get(qid).s;

const doneOrphan = mkSession({ headless: 1, status: 'done', spawned_by: 'automation:a1', last_activity: Date.now() - 5 * H });
const apr = pendingApprovalFor(doneOrphan);
const runningBlocked = mkSession({ headless: 1, status: 'running', spawned_by: 'automation:a1', last_activity: Date.now() - 5 * H });
const qst = pendingQuestionFor(runningBlocked);
// Sweep 2 only reaps a done orphan whose pane is genuinely still alive, so report both as live.
tm.backend.aliveNames = () => new Set(['aos-' + doneOrphan, 'aos-' + runningBlocked]);
killed.length = 0;

tm.reapIdleSessions();

assert(killed.includes('aos-' + doneOrphan), 'done orphan with a pending approval → pane killed');
assert(statusOf(doneOrphan) === 'done', 'its outcome is preserved (stays done)');
assert(aos.approvals.statusOf(apr) === 'cancelled', 'the undeliverable approval is cancelled, not left hanging');
assert(!killed.includes('aos-' + runningBlocked), 'a still-running run blocked on a question → left alone');
assert(statusOf(runningBlocked) === 'running', '…and still running');
assert(qStatus(qst) === 'pending', '…with its question still open for an answer');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}IDLE REAPER: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
