#!/usr/bin/env node
/* automem health: `degraded` is a lag, not an outage.
 *
 * automem reports `degraded` / `sync_status: drift_detected` whenever its graph and its vector store
 * disagree — the normal state DURING a bulk write, since the node lands before the vector and a worker
 * reconciles on a timer. Reads and writes keep working throughout. The provider used to fail the health
 * check on it, which meant the memory migration (which pre-flights health before every batch) refused to
 * write into the very store it was importing into, batch after batch, and Settings → Memory went red
 * mid-import. Observed while migrating instapods onto a local automem, 2026-08-30.
 *
 * Pinned here against a stub automem: degraded is usable and SAYS so; unhealthy and unreachable are not. */
const assert = require('assert');
const http = require('http');

const { AutomemMemoryProvider } = require('../dist/memory/automem-provider');

let state = { status: 'healthy', memory_count: 7, sync_status: 'synced' };
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/health')) return res.end(JSON.stringify(state));
  if (req.url.startsWith('/recall')) return res.end(JSON.stringify({ results: [] }));
  res.statusCode = 404; res.end('{}');
});

server.listen(0, '127.0.0.1', async () => {
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const p = new AutomemMemoryProvider({ endpoint, token: 'tok' });

  let h = await p.health();
  assert.strictEqual(h.ok, true, 'healthy is usable');
  assert.ok(h.detail.includes('7 memories'), 'the count is reported');

  state = { status: 'degraded', memory_count: 9, sync_status: 'drift_detected' };
  h = await p.health();
  assert.strictEqual(h.ok, true, 'degraded is a lag, not an outage — it must stay USABLE');
  assert.ok(/degraded/.test(h.detail) && /drift_detected/.test(h.detail), `degraded is still reported in the detail, got: ${h.detail}`);

  state = { status: 'unhealthy', memory_count: 0 };
  h = await p.health();
  assert.strictEqual(h.ok, false, 'unhealthy is a stop');

  server.close();
  const dead = new AutomemMemoryProvider({ endpoint: 'http://127.0.0.1:1', token: 'tok' });
  const h2 = await dead.health();
  assert.strictEqual(h2.ok, false, 'an unreachable endpoint is a stop');

  console.log('automem-health-test: ok (degraded usable + reported; unhealthy and unreachable fail)');
  process.exit(0);
});
setTimeout(() => { console.error('automem-health-test: timed out'); process.exit(1); }, 20_000).unref();
