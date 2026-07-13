#!/usr/bin/env node
/* Phase-1 concurrency-cap logic test — isolated home, no server/tmux/claude.
 * Covers: derivedConcurrencyCap math, Settings get/set/clear semantics, the
 * Automations.concurrencyCap() resolution order (env → setting → derived), and
 * TerminalManager.runningSessionCount / aliveSessionCount DB fallback. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-conc-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;

let pass = 0, fail = 0;
const assert = (cond, name, detail) => cond ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ' — ' + detail : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations, derivedConcurrencyCap } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
const GB = 1024 ** 3;

console.log('\n\x1b[1m1) derivedConcurrencyCap (RAM → cap)\x1b[0m');
assert(derivedConcurrencyCap(2 * GB) === 3, '2 GB → 3 (floor)');
assert(derivedConcurrencyCap(1 * GB) === 3, '1 GB → 3 (floor, never below 3)');
assert(derivedConcurrencyCap(32 * GB) === 21, '32 GB → 21');
assert(derivedConcurrencyCap(48 * GB) === 32, '48 GB → 32');

console.log('\n\x1b[1m2) Settings.maxConcurrentSessions get/set/clear\x1b[0m');
assert(aos.settings.maxConcurrentSessions() === null, 'unset → null');
aos.settings.setMaxConcurrentSessions(7, 'tester');
assert(aos.settings.maxConcurrentSessions() === 7, 'set 7 → 7');
aos.settings.setMaxConcurrentSessions(0, 'tester');
assert(aos.settings.maxConcurrentSessions() === 0, 'set 0 → 0 (explicit unlimited)');
aos.settings.setMaxConcurrentSessions(null, 'tester');
assert(aos.settings.maxConcurrentSessions() === null, 'clear (null) → null again');
aos.settings.setMaxConcurrentSessions(-4, 'tester');
assert(aos.settings.maxConcurrentSessions() === null, 'negative → cleared (null)');
aos.settings.setMaxConcurrentSessions(12.9, 'tester');
assert(aos.settings.maxConcurrentSessions() === 12, 'floors 12.9 → 12');
aos.settings.setMaxConcurrentSessions(null, 'tester'); // reset for the resolver tests

console.log('\n\x1b[1m3) Automations.concurrencyCap() resolution order\x1b[0m');
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;
assert(autos.concurrencyCap() === derivedConcurrencyCap(), 'no env, no setting → derived default');
aos.settings.setMaxConcurrentSessions(5, 'tester');
assert(autos.concurrencyCap() === 5, 'setting 5 (no env) → 5');
aos.settings.setMaxConcurrentSessions(0, 'tester');
assert(autos.concurrencyCap() === 0, 'setting 0 (no env) → 0 (unlimited)');
process.env.AOS_MAX_CONCURRENT_SESSIONS = '9';
assert(autos.concurrencyCap() === 9, 'env 9 overrides setting 0 → 9');
process.env.AOS_MAX_CONCURRENT_SESSIONS = '0';
assert(autos.concurrencyCap() === 0, 'env 0 → 0 (explicit unlimited, wins)');
process.env.AOS_MAX_CONCURRENT_SESSIONS = '   ';
aos.settings.setMaxConcurrentSessions(4, 'tester');
assert(autos.concurrencyCap() === 4, 'blank/whitespace env is ignored → falls to setting 4');
process.env.AOS_MAX_CONCURRENT_SESSIONS = 'abc';
assert(autos.concurrencyCap() === 4, 'non-numeric env ignored → setting 4');
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;
aos.settings.setMaxConcurrentSessions(null, 'tester');

console.log('\n\x1b[1m4) runningSessionCount / aliveSessionCount fallback\x1b[0m');
assert(typeof tm.runningSessionCount() === 'number', 'runningSessionCount returns a number');
assert(tm.runningSessionCount() === 0, 'no sessions → 0');
// aliveSessionCount on the local backend with no live tmux: aliveNames() returns a Set (empty) → 0,
// and with no running rows the DB fallback is also 0. Either way it must be a finite number ≥ 0.
const ac = tm.aliveSessionCount();
assert(Number.isFinite(ac) && ac >= 0, `aliveSessionCount finite ≥ 0 (got ${ac})`);

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}PHASE-1 CONCURRENCY: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
