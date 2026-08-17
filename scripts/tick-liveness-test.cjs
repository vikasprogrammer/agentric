#!/usr/bin/env node
/**
 * Falsifier for the scheduler-tick stall (see CHANGELOG 0.362.0).
 *
 * The defect: `Automations.dispatchTasks` called `tm.reachable()` once per `task:` session row, and every
 * `reachable()` fork+exec'd `tmux list-sessions`. `done` rows are never deleted, so the loop grew with the
 * tenant's whole history — 924 rows on the live fleet meant ~900 tmux spawns per 20s tick and **7.3s** of a
 * single-threaded server blocked, every 20s, forever. `/health` measured max 9s.
 *
 * What this pins, both about the COUNT of tmux execs (the thing that broke), never about wall-clock:
 *   1. N calls to `aliveNames()` inside the TTL cost ONE exec, not N.
 *   2. `spawn`/`kill` invalidate it, so a pane we just changed is never read from a stale poll.
 *   3. `dispatchTasks` no longer calls the per-row `reachable()` at all.
 *
 * Counting is done with a PATH shim: a fake `tmux` that appends a line to a file. No tmux server, no real
 * sessions, no timing assumptions.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-tick-test-'));
const counter = path.join(tmp, 'calls.log');
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
// Fake tmux: record the invocation, then answer like a server with no sessions (exit 1, no output).
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${counter}\nexit 1\n`);
fs.chmodSync(path.join(bin, 'tmux'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0);

const { LocalSessionBackend } = require('../dist/edge/session-backend');
const backend = new LocalSessionBackend(path.join(tmp, 'tmux.sock'), () => {});

// (1) 200 liveness reads inside the TTL = one exec. Pre-fix this was 200.
for (let i = 0; i < 200; i++) backend.aliveNames();
assert.strictEqual(calls(), 1, `200 aliveNames() calls should exec tmux once, got ${calls()}`);

// (2) a kill changes the world, so the next read must NOT come from the cache.
backend.kill('space', 'aos-ses_nope');
const afterKill = calls(); // the kill-session exec itself
backend.aliveNames();
assert.strictEqual(calls(), afterKill + 1, 'kill() must invalidate the cached liveness poll');
backend.aliveNames();
assert.strictEqual(calls(), afterKill + 1, 'the poll after a kill should itself be cached again');

// (3) the per-row loop must not come back. `dispatchTasks` is the exact site that froze the tick; it now
// reads the batched `busyTaskAgents()`, and a future `reachable()` in there would restore the stall
// silently (correct behaviour, quadratic cost — the failure mode no test catches by observing output).
const autos = fs.readFileSync(path.join(__dirname, '..', 'src', 'edge', 'automations.ts'), 'utf8');
const body = autos.slice(autos.indexOf('private dispatchTasks('));
const end = body.indexOf('\n  }\n');
assert.ok(end > 0, 'could not isolate dispatchTasks body');
// Comments are stripped first: the body documents the defect by name, so a raw grep would match its own
// warning rather than a real call.
const dispatchBody = body.slice(0, end).replace(/\/\/[^\n]*/g, '');
assert.ok(!/tm\.reachable\(/.test(dispatchBody), 'dispatchTasks must use the batched busyTaskAgents(), not per-row tm.reachable()');
assert.ok(/busyTaskAgents\(\)/.test(dispatchBody), 'dispatchTasks should read busyTaskAgents()');

// (4) etime parsing, the janitor's age guard — a misparse would make everything look old enough to kill.
const { parseEtime } = require('../dist/edge/process-janitor');
assert.strictEqual(parseEtime('01:30'), 90_000, 'MM:SS');
assert.strictEqual(parseEtime('02:00:00'), 7_200_000, 'HH:MM:SS');
assert.strictEqual(parseEtime('3-04:00:00'), (3 * 24 + 4) * 3_600_000, 'D-HH:MM:SS');
assert.strictEqual(parseEtime('garbage'), 0, 'unparseable must read as age 0 (too young to reap)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('tick-liveness-test: ok (1 tmux exec per TTL window, invalidation on kill, no per-row reachable, etime parse)');
