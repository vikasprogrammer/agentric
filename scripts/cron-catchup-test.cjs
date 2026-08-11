#!/usr/bin/env node
/* Cron catch-up test — proves a cron occurrence missed in its exact minute (over the concurrency cap, or
 * a restart) is retried within a bounded window instead of dropped until the next day, while never
 * double-firing or replaying a stale backlog. Isolated home; fire() is stubbed so no real session spawns. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cron-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations, parseCron, recentCronOccurrence, CRON_CATCHUP_MIN } = require(path.join(ROOT, 'dist/edge/automations.js'));

// Local-time occurrence helpers so cronMatches (which reads LOCAL hours/minutes) is TZ-independent.
const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0).getTime();       // 2026-01-15 hh:mm local
const dayBefore = (ms) => ms - 24 * 3600 * 1000;

console.log('\n\x1b[1m1) recentCronOccurrence (the catch-up detector)\x1b[0m');
const spec9 = parseCron('0 9 * * *');
assert(recentCronOccurrence(spec9, new Date(at(9, 0)), 120) === at(9, 0), 'exact minute → that minute');
assert(recentCronOccurrence(spec9, new Date(at(9, 30)), 120) === at(9, 0), '30 min late → still 09:00 (owed)');
assert(recentCronOccurrence(spec9, new Date(at(11, 0)), 120) === at(9, 0), 'exactly 120 min late → 09:00 (window edge)');
assert(recentCronOccurrence(spec9, new Date(at(11, 1)), 120) === null, '121 min late → null (window closed)');
assert(recentCronOccurrence(spec9, new Date(at(8, 59)), 120) === null, 'before the occurrence → null');
const specMin = parseCron('* * * * *');
assert(recentCronOccurrence(specMin, new Date(at(9, 37)), 120) === at(9, 37), 'every-minute cron → current minute');

console.log('\n\x1b[1m2) tick() end-to-end: catch-up under the concurrency cap\x1b[0m');
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
aos.settings.setMaxConcurrentSessions(8, 'tester'); // cap = 8 (matches the globex box)

const ID = 'au_test';
aos.db.prepare("INSERT INTO automations (id, agent_id, name, type, mode, schedule, task, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(ID, 'compass', 'Daily Support Quality Review', 'cron', 'headless', '0 9 * * *', 'Review support quality.', 1, at(9, 0) - 5 * 86400000);
const setLF = (ms) => aos.db.prepare("UPDATE automations SET last_fired_at = ? WHERE id = ?").run(ms, ID);
const getLF = () => aos.db.prepare("SELECT last_fired_at l FROM automations WHERE id = ?").get(ID).l;

// Stub fire() to record the call + stamp last_fired_at like the real one, without spawning a session.
let fired = [];
let simNow = 0;
autos.fire = function (a) { fired.push(a.id); aos.db.prepare("UPDATE automations SET last_fired_at = ? WHERE id = ?").run(simNow, a.id); return { ok: true, session: 'stub' }; };
const runTick = (ms, alive) => { simNow = ms; tm.aliveSessionCount = () => alive; fired = []; autos.tick(new Date(ms)); return fired.includes(ID); };

// Baseline: fired yesterday at 09:00.
setLF(dayBefore(at(9, 0)));
assert(runTick(at(9, 0), 3) === true, 'on time + headroom (3<8) → fires');
assert(getLF() === at(9, 0), 'last_fired_at stamped to 09:00');
assert(runTick(at(9, 0) + 30_000, 3) === false, 'same occurrence, later tick → no double-fire');

// The bug scenario: over cap during the 09:00 minute, then headroom appears later.
setLF(dayBefore(at(9, 0)));                    // reset: owed today's 09:00
assert(runTick(at(9, 0), 9) === false, 'over cap at 09:00 (9>=8) → deferred, not fired');
assert(getLF() === dayBefore(at(9, 0)), 'deferred → last_fired_at NOT advanced');
assert(runTick(at(9, 5), 9) === false, 'still over cap at 09:05 → still deferred');
assert(runTick(at(9, 20), 4) === true, 'headroom at 09:20 → CATCH-UP fires (was dropped before the fix)');
assert(runTick(at(9, 21), 4) === false, 'caught-up occurrence → not fired again');

// Window bound: if headroom never comes within CRON_CATCHUP_MIN, the stale occurrence is abandoned.
setLF(dayBefore(at(9, 0)));
assert(runTick(at(11, 1), 3) === false, `past the ${CRON_CATCHUP_MIN}-min window (121 min late) → abandoned, not fired late`);

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}CRON CATCH-UP: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
