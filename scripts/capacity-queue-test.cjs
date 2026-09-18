#!/usr/bin/env node
/* The capacity queue — a launch parked because every runtime account is rate-limited, instead of crashed.
 *
 * Why this exists — instawp, 2026-09-17: 21 of the tenant's last 22 `crashed` sessions were not crashes.
 * Both pool accounts hit their 5-hour session limit within an hour of each other, a third was at its
 * weekly cap and a fourth was disabled, so rotation had nothing to hand out and every launch fell through
 * to the box default `~/.claude` — a login that had never been used and held no tokens at all. The
 * pre-flight refused each run (correctly: it could not authenticate) and reported it as a crashed session
 * whose card told an admin to re-login a credential that was not the problem, while the accounts that
 * WERE the problem reset themselves within the hour. Two humans re-clicked take-over and got the same
 * card twice.
 *
 * Pinned here:
 *  1. exhausted-but-recovering pool + unusable fallback → `queued`, audited, with a card that names the
 *     reset time — and NOT a crash;
 *  2. the same block with no reset to wait for (empty pool / all disabled) still crashes, because there
 *     is no moment to retry at;
 *  3. the retry sweep launches the parked run once an account frees up, and resolves its card;
 *  4. a wait past the ceiling gives up and crashes with the ORIGINAL credential reason — late, never
 *     silent;
 *  5. a `queued` row this process holds no spec for (a restart mid-wait) is reported, not left waiting;
 *  6. stop works on a queued run (there is no pane to kill, but there is a wait to call off);
 *  7. `expiresAt: 0` never renders as "expired on 1970-01-01" — that is a record with no token in it.
 *
 * Isolated home; the backend and the actual launch are stubbed, so no tmux and no claude are needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-capacity-test-'));
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
tm.backend.kill = () => {};
tm.backend.hasClient = () => false;
tm.backend.aliveNames = () => new Set();

// The launch itself is the one thing we never want to actually do — record the spec instead.
const launched = [];
tm.launchAgentRuntime = (spec) => { launched.push(spec.id); };

const MIN = 60_000;
// A credential dir in the shape the instawp box's `~/.claude` was in: a record with neither token, which
// stores `expiresAt: 0` — present enough to be read, dead enough to authenticate nothing.
const deadDir = path.join(HOME, 'dead-claude');
fs.mkdirSync(deadDir, { recursive: true });
fs.writeFileSync(path.join(deadDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { expiresAt: 0, scopes: ['user:inference'] } }));

let n = 0;
const mkSession = () => {
  const id = 'ts_' + (++n);
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',0,0,'m_alice',?,?)")
    .run(id, 'support-ops', 't', 'x', 'aos-' + id, Date.now(), Date.now());
  return id;
};
const spec = (id) => ({
  id, agent: 'support-ops', task: 'x', secret: 's', hasSlack: false, hasDiscord: false, hasClickup: false,
  hasTelegram: false, headless: false, resident: false, resume: false, claudeSessionId: null,
});
const statusOf = (id) => aos.db.prepare('SELECT status s FROM term_sessions WHERE id=?').get(id).s;
const cardsFor = (id) => aos.db.prepare('SELECT type,title,body,status,outcome FROM messages WHERE session_id=? ORDER BY created_at').all(id);
const auditTypes = (id) => aos.db.prepare('SELECT type FROM audit_events WHERE run_id=?').all(id).map((r) => r.type);
const preflight = (id) => tm.assertCredentialsUsable({ CLAUDE_CONFIG_DIR: deadDir }, spec(id), 'claude-code');

const addLimited = (name, untilMs) => {
  const dir = path.join(HOME, 'acct-' + name);
  fs.mkdirSync(dir, { recursive: true });
  aos.runtimeAccounts.add({ runtime: 'claude-code', name, kind: 'oauth', configDir: dir });
  aos.runtimeAccounts.markLimited('claude-code', name, untilMs);
};

console.log('\n\x1b[1m1) An exhausted pool parks the run — it does not crash it\x1b[0m');
addLimited('tools', Date.now() + 40 * MIN);
addLimited('tools2', Date.now() + 46 * MIN);
const parked = mkSession();
{
  const proceed = preflight(parked);
  assert(proceed === false, 'the launch does not proceed (there is still nothing to authenticate with)');
  assert(statusOf(parked) === 'queued', 'the session is queued, not crashed', statusOf(parked));
  const types = auditTypes(parked);
  assert(types.includes('session.launch.queued'), 'audited as session.launch.queued', types.join(','));
  assert(!types.includes('session.launch.refused'), 'NOT audited as a refusal — nothing is wrong with this box');
  const card = cardsFor(parked).find((c) => c.title.startsWith('Waiting for capacity'));
  assert(Boolean(card), 'its owner gets a "Waiting for capacity" card');
  assert(card && card.outcome !== 'crashed', 'the card does not claim the run crashed');
  assert(card && /rate limit/.test(card.body) && /starts on its own/.test(card.body), 'the card says why and that it self-starts', card && card.body);
  assert(card && /in about 40 min/.test(card.body), 'the card names how long the wait is', card && card.body);
}

console.log('\n\x1b[1m2) With no reset to wait for, a dead credential still crashes\x1b[0m');
{
  // Same dead fallback, but the pool can offer no moment to retry at: every account disabled.
  aos.runtimeAccounts.setEnabled('claude-code', 'tools', false);
  aos.runtimeAccounts.setEnabled('claude-code', 'tools2', false);
  const doomed = mkSession();
  const proceed = preflight(doomed);
  assert(proceed === false, 'the launch does not proceed');
  assert(statusOf(doomed) === 'crashed', 'an all-disabled pool is a refusal, not a queue', statusOf(doomed));
  assert(auditTypes(doomed).includes('session.launch.refused'), 'audited as a refusal');
  aos.runtimeAccounts.setEnabled('claude-code', 'tools', true);
  aos.runtimeAccounts.setEnabled('claude-code', 'tools2', true);
}

console.log('\n\x1b[1m3) The retry sweep launches the parked run once an account frees up\x1b[0m');
{
  tm.retryCapacityQueue();
  assert(statusOf(parked) === 'queued' && launched.length === 0, 'still limited → still waiting, nothing launched');
  aos.runtimeAccounts.clearLimit('claude-code', 'tools');
  tm.retryCapacityQueue();
  assert(launched.includes(parked), 'an available account launches it');
  assert(statusOf(parked) === 'running', 'and the row goes back to running', statusOf(parked));
  assert(auditTypes(parked).includes('session.launch.dequeued'), 'audited as session.launch.dequeued');
  const card = cardsFor(parked).find((c) => c.title.startsWith('Waiting for capacity'));
  assert(card && card.status === 'resolved', 'the waiting card is resolved — the wait is over', card && card.status);
  tm.retryCapacityQueue();
  assert(launched.filter((x) => x === parked).length === 1, 'and it is launched exactly once');
}

console.log('\n\x1b[1m4) A wait past the ceiling gives up — late, but never silent\x1b[0m');
{
  aos.runtimeAccounts.markLimited('claude-code', 'tools', Date.now() + 7 * 24 * 3600_000);   // a WEEKLY cap
  aos.runtimeAccounts.markLimited('claude-code', 'tools2', Date.now() + 7 * 24 * 3600_000);
  const stale = mkSession();
  preflight(stale);
  assert(statusOf(stale) === 'queued', 'parked first');
  const entry = tm.capacityQueue.get(stale);
  entry.queuedAt = Date.now() - 7 * 3600_000;                                                 // waited 7h
  tm.retryCapacityQueue();
  assert(statusOf(stale) === 'crashed', 'past the 6h ceiling the run crashes', statusOf(stale));
  const types = auditTypes(stale);
  assert(types.includes('session.launch.queue.expired'), 'audited as session.launch.queue.expired', types.join(','));
  assert(types.includes('session.launch.refused'), 'and it falls back to the original credential refusal');
  assert(!tm.capacityQueue.has(stale), 'and it leaves the queue');
}

console.log('\n\x1b[1m5) A queued row with no spec in memory (a restart mid-wait) is reported\x1b[0m');
{
  const orphan = mkSession();
  aos.db.prepare("UPDATE term_sessions SET status='queued' WHERE id=?").run(orphan);
  tm.retryCapacityQueue();
  assert(statusOf(orphan) === 'crashed', 'it is not left waiting forever', statusOf(orphan));
  assert(auditTypes(orphan).includes('session.launch.queue.orphaned'), 'audited as orphaned');
  const card = cardsFor(orphan).find((c) => c.title.startsWith('Did not start'));
  assert(Boolean(card) && /never started/.test(card.body), 'its owner is told it never started', card && card.body);
  assert(card && /nothing was billed/.test(card.body), 'and that nothing was billed');
}

console.log('\n\x1b[1m6) Stop works on a queued run\x1b[0m');
{
  const waiting = mkSession();
  preflight(waiting);
  assert(statusOf(waiting) === 'queued', 'parked first');
  assert(tm.stopSession(waiting, 'alice@example.com') === true, 'stop returns true');
  assert(statusOf(waiting) === 'stopped', 'the row is stopped, not left queued', statusOf(waiting));
  assert(!tm.capacityQueue.has(waiting), 'and dropped from the queue');
  const before = launched.length;
  tm.retryCapacityQueue();
  assert(launched.length === before, 'a stopped run is never launched by a later sweep');
  assert(statusOf(waiting) === 'stopped', 'and is not re-reported as a crash by the orphan pass', statusOf(waiting));
}

console.log('\n\x1b[1m7) A credential with no tokens is not a 1970 expiry\x1b[0m');
{
  const crashed = aos.db.prepare("SELECT session_id id, body FROM messages WHERE body LIKE '%no usable login%' OR body LIKE '%1970%'").all();
  assert(crashed.length > 0, 'the refusal cards are on the record to check');
  assert(!crashed.some((c) => /1970/.test(c.body)), 'no card claims an expiry on 1970-01-01', JSON.stringify(crashed.map((c) => c.body.slice(0, 90))));
  assert(crashed.every((c) => /holds no usable login/.test(c.body)), 'they say the credential holds no usable login instead');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
