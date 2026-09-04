#!/usr/bin/env node
/* AutoMem health diagnostics — what an operator can see without an ssh session.
 *
 * The provider used to collapse the backend's whole /health body into one `detail` string. Sweeping the
 * fleet by hand on 2026-09-02 found, from that discarded body: 25% of instawp's memories truncated at the
 * backend's cap, a 775-row store/mirror gap, and an enrichment queue nobody could see — none of it visible
 * in the product. This pins the fields through, and pins that a backend which cannot answer is not
 * reported as zero. */
const http = require('http');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { AutomemMemoryProvider } = require(path.join(ROOT, 'dist/memory/automem-provider.js'));

// A stand-in automem: the real /health shape, plus an authenticated /recall the provider probes.
let body = {
  status: 'healthy', memory_count: 13920, vector_count: 13920, sync_status: 'synced',
  falkordb: 'connected', qdrant: 'connected', graph: 'agentos_instawp',
  vector_dimensions: { collection: 1536, configured: 1536, effective: 1536, mismatch: false },
  enrichment: { failed: 0, inflight: 0, pending: 0, processed: 1948, status: 'running' },
};
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/health')) return res.end(JSON.stringify(body));
  if (req.url.startsWith('/recall')) return res.end(JSON.stringify({ results: [] }));
  res.statusCode = 404; res.end('{}');
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = 'http://127.0.0.1:' + srv.address().port;
  const p = new AutomemMemoryProvider({ endpoint, token: 't' });

  console.log('\nautomem health — the vitals reach the console\n');
  let h = await p.health();
  assert(h.ok === true, 'a healthy backend reports ok');
  const d = h.diagnostics || {};
  assert(d.memoryCount === 13920 && d.vectorCount === 13920, 'memory + vector counts are surfaced', JSON.stringify(d));
  assert(d.syncStatus === 'synced', 'sync status is surfaced');
  assert(d.services && d.services.falkordb === 'connected' && d.services.qdrant === 'connected', 'dependency reachability is surfaced', JSON.stringify(d.services));
  assert(!d.services.status && !d.services.timestamp, 'known scalar fields are not mistaken for services', JSON.stringify(d.services));
  assert(d.vectorDimensions && d.vectorDimensions.mismatch === false, 'embedding width is surfaced');
  assert(d.enrichment && d.enrichment.processed === 1948, 'the enrichment queue is surfaced');
  assert(typeof d.latencyMs === 'number', 'round-trip latency is measured');
  assert(h.detail && h.detail.includes('13920'), 'the original one-line detail still works — nothing regressed');

  // A backend mid-reindex: vectors behind memories, and automem calls that `degraded`, which is NOT down.
  body = { ...body, status: 'degraded', sync_status: 'syncing', vector_count: 13000 };
  h = await p.health();
  assert(h.ok === true, 'degraded is reported, not failed — it is the normal state during a bulk write');
  assert(h.diagnostics.vectorCount === 13000 && h.diagnostics.syncStatus === 'syncing', 'the lag is visible rather than hidden behind "degraded"');

  // A backend that answers almost nothing must not be rendered as a store full of zeros.
  body = { status: 'healthy' };
  h = await p.health();
  assert(h.diagnostics.memoryCount === undefined && h.diagnostics.vectorCount === undefined, 'fields the backend omits stay undefined, never 0', JSON.stringify(h.diagnostics));

  // Unreachable: still a structured answer, still carrying the latency it took to find out.
  await new Promise((r) => srv.close(r));
  h = await p.health();
  assert(h.ok === false, 'an unreachable backend reports not-ok');
  assert(h.diagnostics && typeof h.diagnostics.latencyMs === 'number', '…and still reports how long it waited');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
