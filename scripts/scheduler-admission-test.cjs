#!/usr/bin/env node
/* Scheduler admission test — a parked interactive TUI must not hold a spawn-cap slot, and a scheduler
 * that has been fully blocked must not stay silent about it.
 *
 * The defect this pins: the whole-box concurrency cap counted every live pane. An interactive session
 * stays alive until a human closes it BY DESIGN, so abandoned TUIs accumulate and permanently occupy the
 * cap. On the live fleet one tenant reached ~13 parked sessions, sat above its ceiling, and deferred
 * every cron for a month — 31,570 consecutive `scheduler.deferred` events, zero automations fired, no
 * alert, found only by accident. Raising the cap would have bought weeks, not fixed it.
 *
 * Covered: which sessions count toward admission (headless, mid-turn, recently active) vs which are
 * parked; that the cap uses the admission count; and that the blocked-scheduler alert is strictly
 * present-tense — it fires while blocked, and goes away the moment anything fires or the deferral stops.
 * Isolated home; tmux liveness stubbed so no real panes are needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-admission-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { detectAlerts } = require(path.join(ROOT, 'dist/edge/alerts.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const MIN = 60_000;
const now = Date.now();

// Every row we insert is "alive" as far as the backend is concerned — so anything the admission count
// excludes, it excludes on the merits, not because the pane was missing.
const panes = new Set();
tm.backend.aliveNames = () => panes;

let seq = 0;
/** Insert a running session row directly — createSession would need tmux + claude. */
const mkSession = (o) => {
  const id = `ses_${++seq}`;
  panes.add(`aos-${id}`);
  aos.db
    .prepare(
      "INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, secret, created_at, headless, busy_since, last_activity) " +
        "VALUES (?, 'a', 't', 'k', ?, 'running', 'm_1', 's', ?, ?, ?, ?)",
    )
    .run(id, `aos-${id}`, o.createdAt ?? now, o.headless ? 1 : 0, o.busySince ?? null, o.lastActivity ?? null);
  return id;
};

console.log('\nwhat holds a work slot');
// Headless: unattended work, always counts while alive.
mkSession({ headless: true, busySince: now - 5 * MIN });
assert(tm.admissionSessionCount() === 1, 'a headless run counts');

// Interactive, mid-turn: a human is actively driving it — real load.
mkSession({ headless: false, busySince: now - 2 * MIN });
assert(tm.admissionSessionCount() === 2, 'an interactive session mid-turn counts');

// Interactive, between turns but recent: don't yank a slot out from under someone thinking.
mkSession({ headless: false, busySince: now - 20 * MIN, lastActivity: now - 10 * MIN });
assert(tm.admissionSessionCount() === 3, 'an interactive session active 10 min ago still counts');

// Interactive, parked: the bug. Alive, costing nothing, must not block scheduled work.
const parked1 = mkSession({ headless: false, busySince: now - 8 * 24 * 3_600_000, lastActivity: now - 7 * 24 * 3_600_000 });
assert(tm.admissionSessionCount() === 3, 'an interactive session idle 7 DAYS does not count');

// Parked and never active at all (opened, never used).
mkSession({ headless: false, createdAt: now - 3 * 24 * 3_600_000 });
assert(tm.admissionSessionCount() === 3, 'an interactive session that was never used does not count');

// …but it is still ALIVE. The cap ignores it; nothing here kills it.
assert(tm.aliveSessionCount() === 5, 'all five are still alive — admission is not reaping');
assert(tm.parkedSessionCount() === 2, 'the two parked ones are reported as parked');

// A pane that died leaves a lying `running` row; it must not count either.
panes.delete(`aos-${parked1}`);
assert(tm.admissionSessionCount() === 3, 'a row whose pane is gone counts for nothing');

console.log('\nthe scheduler uses the admission count');
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const autos = new Automations(aos, tm);
aos.agents.set('worker', { id: 'worker', name: 'Worker', runtime: 'claude-code', dir: HOME });
aos.settings.setMaxConcurrentSessions(4, 'test');
const fired = [];
autos.fire = (a) => { fired.push(a.id); return { ok: true, sessionId: `s${fired.length}`, tmux: 't' }; };
const cron = autos.add({ agentId: 'worker', name: 'Every minute', type: 'cron', schedule: '* * * * *', task: 'go' });
autos.tick(new Date());
assert(fired.length === 1, 'with 3 admitted against a cap of 4, the cron fires', `fired=${fired.length}`);
// Had the old count been used, 5 alive ≥ 4 would have deferred it — that is the month-long outage.
assert(tm.aliveSessionCount() >= 4 && tm.admissionSessionCount() < 4,
  'and it fired despite MORE live panes than the cap — which is the whole point');

console.log('\nthe blocked-scheduler alert is present-tense');
const HOUR = 3_600_000;
const deferral = (ts) => aos.db
  .prepare("INSERT INTO audit_events (ts, run_id, tenant, principal, type, data) VALUES (?, '-', 'testco', 'scheduler', 'scheduler.deferred', ?)")
  .run(ts, JSON.stringify({ deferred: 7, cap: 25, running: 34 }));
const alertNow = () => detectAlerts(aos, Date.now()).find((a) => a.key === 'scheduler-blocked');

assert(!alertNow(), 'no deferrals → no alert');

// Deferring steadily for the last 2 hours, right up to now, having fired nothing.
for (let t = Date.now() - 2 * HOUR; t <= Date.now(); t += 5 * MIN) deferral(t);
const a1 = alertNow();
assert(!!a1, 'blocked for 2h with nothing fired → alert');
assert(a1 && a1.severity === 'high' && /cap/i.test(a1.body), 'it names the cap as the cause');
assert(a1 && /interactive sessions stay open/i.test(a1.body), 'and points at parked sessions, the usual cause');

// Recovery #1: something fired. The scheduler is coping, whatever the load looks like.
aos.db.prepare("INSERT INTO audit_events (ts, run_id, tenant, principal, type, data) VALUES (?, '-', 'testco', 'scheduler', 'automation.fired', '{}')")
  .run(Date.now() - 10 * MIN);
assert(!alertNow(), 'one successful fire silences it — no bookkeeping needed');
aos.db.prepare("DELETE FROM audit_events WHERE type = 'automation.fired'").run();
assert(!!alertNow(), '(and removing that fire brings it back, so the check is really doing the work)');

// Recovery #2: the deferrals stop. A stale burst must never keep alerting — the alert-staleness lesson.
aos.db.prepare("DELETE FROM audit_events WHERE type = 'scheduler.deferred' AND ts > ?").run(Date.now() - 30 * MIN);
assert(!alertNow(), 'deferrals that stopped 30 min ago do not alert — the claim is about NOW');

// A brief burst is not a stall.
aos.db.prepare("DELETE FROM audit_events WHERE type = 'scheduler.deferred'").run();
for (let t = Date.now() - 4 * MIN; t <= Date.now(); t += MIN) deferral(t);
assert(!alertNow(), 'a 4-minute burst of backpressure is normal, not an outage');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
