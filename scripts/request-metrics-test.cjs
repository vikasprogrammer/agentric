#!/usr/bin/env node
/**
 * Falsifier for per-endpoint request metrics (see CHANGELOG 0.364.0).
 *
 * The trap this guards against is the reason the feature is shaped the way it is. During the 2026-08-17
 * incident the scheduler tick blocked the event loop for 7.3s at a time, so `GET /health` — a route that
 * reads one string — measured 9.06s from outside. A naive per-route table would have crowned `/health` the
 * slowest endpoint in the system and pointed the next investigation at the wrong file entirely.
 *
 * So the pinned properties are:
 *   1. Handler time and event-loop stall stay SEPARATE. Stall is never folded into a route's cost.
 *   2. Ranking is by TOTAL time, because that is the question "which API costs the most" actually asks —
 *      a 20ms route called 10k times beats a 2s route called once.
 *   3. Paths collapse to templates, so an id-bearing route can't unbound the table (the leak that this
 *      module must not become).
 *   4. It is wired into the REAL server: a live request through `startServer` shows up in the snapshot.
 *   5. The TOOL dimension (`x-aos-tool`, sent by the MCP server) is recorded separately from routes, and a
 *      by-design-blocking tool (`ask_human`, `task_wait`) is FLAGGED and sorted below real work — a
 *      40-minute wait on a human is not a slow endpoint, and must never be ranked as one.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-reqmetrics-test-'));
process.env.AGENT_OS_HOME = home;      // never touch the live ./data home
process.env.AOS_NO_TTYD = '1';         // no browser terminal in a test (v0.362.0)
process.env.AGENT_OS_OWNER_EMAIL = 'owner@test.local';

const { RequestMetrics, normalizePath, requestMetrics } = require('../dist/edge/request-metrics');

// ── 3: path templating ─────────────────────────────────────────────────────────────────────────────────
assert.strictEqual(normalizePath('/api/sessions/ses_47852f6b5f3b7400/chain'), '/api/sessions/:id/chain');
assert.strictEqual(normalizePath('/api/tasks/tsk_8e8acc4ead7485ac'), '/api/tasks/:id');
assert.strictEqual(normalizePath('/api/team/42/identities'), '/api/team/:n/identities');
assert.strictEqual(normalizePath('/api/artifacts/9f8e7d6c5b4a3210'), '/api/artifacts/:hex');
assert.strictEqual(normalizePath('/api/state'), '/api/state', 'a plain route is left alone');
assert.strictEqual(normalizePath('/health'), '/health');

// ── 1 + 2: cost accounting ─────────────────────────────────────────────────────────────────────────────
const m = new RequestMetrics();
// A cheap route called often must outrank a slow route called once.
for (let i = 0; i < 100; i++) m.observe('GET', '/api/sessions', 200, 20, 0);
m.observe('GET', '/api/audit', 200, 900, 0);
// A route that was merely QUEUED behind a blocked loop: 1ms of its own work, 7s of stall.
m.observe('GET', '/health', 200, 1, 7_000);

let snap = m.snapshot();
assert.strictEqual(snap.routes[0].route, 'GET /api/sessions', 'ranking is by total time, not by max');
assert.strictEqual(snap.routes[0].totalMs, 2_000);
assert.strictEqual(snap.routes[1].route, 'GET /api/audit');

const health = snap.routes.find((r) => r.route === 'GET /health');
assert.strictEqual(health.totalMs, 1, "a queued request's cost is its OWN work, not the stall it waited on");
assert.strictEqual(health.maxMs, 1, 'stall must never inflate handler time');
assert.strictEqual(health.maxStallMs, 7_000, 'the stall is still reported — as context, on its own field');

// Quantiles come from buckets and read as upper bounds.
assert.ok(snap.routes[0].p95Ms >= 20 && snap.routes[0].p95Ms <= 25, `p95 should bound 20ms, got ${snap.routes[0].p95Ms}`);
assert.strictEqual(snap.requests, 102);

// Errors are counted, so a "fast" route that mostly fails is visible as such.
m.observe('POST', '/api/tasks', 500, 5, 0);
snap = m.snapshot();
assert.strictEqual(snap.routes.find((r) => r.route === 'POST /api/tasks').errors, 1);

// ── 5: the tool dimension ──────────────────────────────────────────────────────────────────────────────
const t = new RequestMetrics();
for (let i = 0; i < 10; i++) t.observeTool('recall', 200, 260, 0);   // remote memory backend, real work
t.observeTool('task_wait', 200, 900_000, 0);                          // 15 min waiting on a delegate
t.observeTool('kb_read', 200, 2, 0);
const tsnap = t.snapshot();
assert.strictEqual(tsnap.routes.length, 0, 'a tool call must not be counted as a route by this path');
assert.strictEqual(tsnap.tools[0].route, 'recall', 'tools rank by total time, blocking ones excluded from the top');
assert.strictEqual(tsnap.tools[0].totalMs, 2_600);
assert.strictEqual(tsnap.tools[0].blocking, false);
const wait = tsnap.tools.find((r) => r.route === 'task_wait');
assert.strictEqual(wait.blocking, true, 'a by-design-blocking tool is flagged');
assert.strictEqual(tsnap.tools[tsnap.tools.length - 1].route, 'task_wait', 'blocking tools sort last');
const capped2 = new RequestMetrics();
for (let i = 0; i < 500; i++) capped2.observeTool(`tool-${i}`, 200, 1, 0);
assert.ok(capped2.snapshot(500).tools.length <= 300, 'a forged tool header cannot grow the map without bound');

// The route map is capped — an unbounded key space is the failure mode this module must not have.
const capped = new RequestMetrics();
for (let i = 0; i < 500; i++) capped.observe('GET', `/api/thing-${i}`, 200, 1, 0);
assert.ok(capped.snapshot(500).routes.some((r) => r.route.startsWith('other')), 'overflow lands in `other`');

// ── 4: wired into the real server ──────────────────────────────────────────────────────────────────────
const { startServer } = require('../dist/server');
const server = startServer(0);
server.on('listening', async () => {
  const { port } = server.address();
  for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  // A request carrying the MCP tool header lands in the tool dimension, through the real server.
  await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-aos-tool': 'kb_read' } }).then((r) => r.json());
  const live = requestMetrics.snapshot();
  const toolRow = live.tools.find((r) => r.route === 'kb_read');
  assert.ok(toolRow && toolRow.count === 1, 'x-aos-tool must bucket a live request by tool');
  const row = live.routes.find((r) => r.route === 'GET /health');
  assert.ok(row, 'a real request must reach the collector');
  assert.strictEqual(row.count, 4, `expected 4 recorded requests, got ${row && row.count}`); // 3 plain + 1 tool-tagged
  assert.ok(row.count > toolRow.count, 'a tool-tagged request is recorded in BOTH dimensions, not moved out of routes');
  assert.ok(row.totalMs >= 0, 'handler time is recorded');
  assert.ok(live.loop.samples >= 0, 'the loop sampler is running');
  requestMetrics.stop();
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log('request-metrics-test: ok (stall separated, ranked by total, paths templated, per-tool dimension, wired live)');
  process.exit(0);
});
setTimeout(() => { console.error('request-metrics-test: server never listened'); process.exit(1); }, 20_000).unref();
