#!/usr/bin/env node
/* Idle-interactive reaper test — a detached member (headless=0) session idle past the configurable
 * timeout is closed (status→stopped), while recent/attached/disabled cases are left alone.
 *
 * Section 7 covers the CLAIM CEILING. `claimed_by IS NULL` used to exempt a claimed session from this
 * sweep unconditionally, on the reasoning that a human owns its lifecycle. Nothing ever expired a claim,
 * so someone who took a session over and closed the tab created an immortal pane: live instawp had seven
 * sessions claimed by one member, idle 143-168h, skipped by the 72h reaper every tick for a week — until
 * they and their peers filled the concurrency cap and starved every scheduled run on the tenant for a
 * month. The exemption stays; it now has a ceiling, exactly like the blocked-on-a-human one above it.
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
const claimedStale = mkSession({ created_at: Date.now() - 96 * H, claimed_by: 'm_bob' }); // claim went stale → reap
const unattended = mkSession({ created_at: Date.now() - 96 * H, headless: 1 });   // sweep-2 territory, not sweep 3 → keep here
const activeByLastAct = mkSession({ created_at: Date.now() - 96 * H, last_activity: Date.now() - 1 * H }); // recent turn → keep

tm.reapIdleSessions();

assert(statusOf(stale) === 'stopped', 'detached 4-day-idle member session → stopped');
assert(killed.includes('aos-' + stale), 'its pane was killed');
assert(statusOf(recent) === 'running', 'recent (2h) session → left running');
assert(statusOf(attachedStale) === 'running', 'attached session (client present) → left running');
// Was 'left running' — an unconditional exemption, and the leak this file now pins against. 96h idle is
// past the default 72h claim ceiling, so the take-over is abandonment.
assert(statusOf(claimedStale) === 'stopped', 'claimed take-over idle past the ceiling → stopped');
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

/* Sweep 3 — the BLOCKED ceiling. An interactive session waiting on a question/approval is exempt from the
 * idle reaper, and nothing expires an Inbox card, so with no ceiling it waits for ever (live initech:
 * 66 h on a question raised three days earlier). Past `blockedMaxHours`, measured from when the card was
 * RAISED, it is closed and the card cancelled — but a recent block, and an attached session, are left. */
console.log('\n\x1b[1m5) sweep 3: the blocked-on-a-card ceiling\x1b[0m');
// Section 4 pinned aliveNames to its own two panes; restore the all-alive stub or sweep 0 (crash
// detection) marks every session created below as `crashed` before the idle sweep ever sees it.
tm.backend.aliveNames = () => new Set(aos.db.prepare('SELECT tmux FROM term_sessions').all().map((r) => r.tmux));
aos.settings.setInteractiveIdleTimeoutHours(48);
assert(aos.settings.blockedMaxHours() === 72, 'unset → 72h default');
assert(aos.settings.setBlockedMaxHours(0) === 0, 'set 0 → 0 (disabled)');
assert(aos.settings.setBlockedMaxHours(99999) === 24 * 30, 'clamps to 30 days max');
aos.settings.setBlockedMaxHours(72);

const askAt = (id, ageH) => {
  const qid = 'qst_b_' + id;
  aos.db.prepare('INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(qid, id, aos.tenant, 'website-bot', 'which one?', 'pending', Date.now() - ageH * H);
  return qid;
};
// All four are far past the 48h IDLE cutoff — the only thing that differs is the block.
const blockedOld = mkSession({ created_at: Date.now() - 96 * H });        // card raised 90h ago → reap
const qOld = askAt(blockedOld, 90);
const blockedFresh = mkSession({ created_at: Date.now() - 96 * H });      // card raised 2h ago → keep waiting
const qFresh = askAt(blockedFresh, 2);
const blockedAttached = mkSession({ created_at: Date.now() - 96 * H, tmux: 'aos-WATCHED' }); attached.add('aos-WATCHED');
askAt(blockedAttached, 90);                                              // someone is there to answer → keep
const blockedApproval = mkSession({ created_at: Date.now() - 96 * H });  // an APPROVAL counts the same way
const { req: oldApr } = aos.approvals.request({ runId: blockedApproval, tenant: aos.tenant, level: 'owner',
  reason: 'test', attempt: { capabilityId: 'shell.exec', args: {}, reasoning: '' } });
aos.db.prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(Date.now() - 90 * H, oldApr.id);
killed.length = 0;

tm.reapIdleSessions();

assert(statusOf(blockedOld) === 'stopped', 'blocked 90h on a 72h ceiling → closed');
assert(qStatus(qOld) === 'cancelled', '…and its question cancelled, so the card is dismissable');
assert(statusOf(blockedFresh) === 'running', 'blocked only 2h → still waiting');
assert(qStatus(qFresh) === 'pending', '…its question still open');
assert(statusOf(blockedAttached) === 'running', 'blocked 90h but a human is attached → left alone');
assert(statusOf(blockedApproval) === 'stopped', 'a 90h-old pending APPROVAL blocks the same way');
assert(aos.approvals.statusOf(oldApr.id) === 'cancelled', '…and is cancelled on teardown');

console.log('\n\x1b[1m6) blocked ceiling disabled (0) restores the old wait-for-ever\x1b[0m');
aos.settings.setBlockedMaxHours(0);
const blockedForever = mkSession({ created_at: Date.now() - 200 * H });
askAt(blockedForever, 150);
tm.reapIdleSessions();
assert(statusOf(blockedForever) === 'running', '0 → a 150h-old block is never cut');

console.log('\n\x1b[1m7) the claim ceiling — a take-over expires, it is not a permanent exemption\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(48);
aos.settings.setBlockedMaxHours(72);
assert(aos.settings.claimedMaxHours() === 72, 'unset → 72h default');
assert(aos.settings.setClaimedMaxHours(0) === 0, 'set 0 → 0 (permanent exemption restored)');
assert(aos.settings.setClaimedMaxHours(99999) === 24 * 30, 'clamps to 30 days max');

// 0 = the OLD behaviour, kept as an escape hatch for anyone who wants take-overs to be forever.
aos.settings.setClaimedMaxHours(0);
const claimedForever = mkSession({ created_at: Date.now() - 400 * H, claimed_by: 'm_bob' });
tm.reapIdleSessions();
assert(statusOf(claimedForever) === 'running', '0 → even a 400h-idle claim is never cut');

aos.settings.setClaimedMaxHours(72);
const claimedWeekOld = mkSession({ created_at: Date.now() - 168 * H, claimed_by: 'm_bob' });   // the live case
const claimedFresh = mkSession({ created_at: Date.now() - 10 * H, claimed_by: 'm_bob' });      // still theirs
const claimedAttached = mkSession({ created_at: Date.now() - 400 * H, claimed_by: 'm_bob', tmux: 'aos-CLAIMED-ATTACHED' });
attached.add('aos-CLAIMED-ATTACHED');
const claimedActive = mkSession({ created_at: Date.now() - 400 * H, claimed_by: 'm_bob', last_activity: Date.now() - 2 * H });
tm.reapIdleSessions();

assert(statusOf(claimedWeekOld) === 'stopped', 'claimed + idle a week → stopped (the instawp case)');
assert(statusOf(claimedFresh) === 'running', 'claimed + idle 10h → still theirs');
assert(statusOf(claimedActive) === 'running', 'claimed + a turn 2h ago → still theirs');
// The one rule that must never be overridden by a clock: someone is literally attached right now.
assert(statusOf(claimedAttached) === 'running', 'claimed + ATTACHED → never cut, whatever the age');

// The audit has to name the person, so a reaped take-over is traceable rather than looking like the
// janitor closing an ownerless pane.
const ev = aos.db.prepare("SELECT data FROM audit_events WHERE type='session.reaped' AND run_id=? ORDER BY ts DESC LIMIT 1").get(claimedWeekOld);
const parsed = ev ? JSON.parse(ev.data) : {};
assert(parsed.reason === 'claimed-abandoned', 'audited as claimed-abandoned, not idle-interactive', JSON.stringify(parsed));
assert(parsed.claimedBy === 'm_bob', 'and names who had claimed it');

// A ceiling SHORTER than the idle timeout must still see its own rows — the scan window is widened to the
// more permissive of the two clocks, so a claim can expire before an ordinary idle session would.
aos.settings.setInteractiveIdleTimeoutHours(200);
aos.settings.setClaimedMaxHours(24);
const claimedShortCeiling = mkSession({ created_at: Date.now() - 48 * H, claimed_by: 'm_bob' });
const unclaimedSameAge = mkSession({ created_at: Date.now() - 48 * H });
tm.reapIdleSessions();
assert(statusOf(claimedShortCeiling) === 'stopped', 'claim ceiling below the idle timeout still applies');
assert(statusOf(unclaimedSameAge) === 'running', '…and the longer idle timeout still protects unclaimed rows');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}IDLE REAPER: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
