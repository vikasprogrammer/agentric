#!/usr/bin/env node
/* Per-agent MCP tool-usage counters (src/edge/tool-usage.ts).
 *
 * The reason this exists: the `mcp__agentos__*` tools are loopback calls sitting BEFORE the member-auth
 * gate, so the PreToolUse hook never sees them, and only the tools that WRITE something audit anything.
 * Every read tool — recall, kb_search, task_list, check_inbox — was invisible. Asked in 2026-09 whether
 * the 77 KB tool schema could be gated per agent, the honest answer was no: half the schema could not be
 * measured, and gating on a blind measurement would strip the tools agents lean on most.
 *
 * What is pinned here: reads are counted like writes; counting never touches SQLite; a flush is
 * per-tenant (the DB file is the tenant boundary); and the accumulator cannot grow without bound. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-toolusage-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { ToolUsage, readToolUsage, usageDay } = require(path.join(ROOT, 'dist/edge/tool-usage.js'));
const aos = loadAgentOS();

console.log('\ntool usage — reads are counted, and counting is free\n');
{
  const u = new ToolUsage();
  // A READ tool: the whole point. Nothing else in the system records these.
  u.record('testco', 'engineer', 'recall');
  u.record('testco', 'engineer', 'recall');
  u.record('testco', 'engineer', 'kb_search');
  u.record('testco', 'qa', 'recall');
  assert(u.pendingCount() === 3, 'distinct (agent, tool, day) keys accumulate separately', `got ${u.pendingCount()}`);

  // Counting must not touch the DB — that is what lets it sit on the request path.
  const before = aos.db.prepare('SELECT COUNT(*) n FROM tool_usage').get().n;
  assert(before === 0, 'nothing is written before a flush');

  const wrote = u.flush('testco', aos.db);
  assert(wrote === 3, 'flush writes one row per key', `got ${wrote}`);
  assert(u.pendingCount() === 0, 'and clears what it wrote');

  const rows = readToolUsage(aos.db, 'testco', 30);
  const recall = rows.find((r) => r.agent === 'engineer' && r.tool === 'recall');
  assert(recall && recall.n === 2, 'repeat calls add up within a day bucket', JSON.stringify(recall));
  assert(rows.some((r) => r.agent === 'qa' && r.tool === 'recall'), 'the same tool is counted per agent, not pooled');

  // A second flush of the same day must ADD, not replace — the UPSERT is what makes a 60s timer safe.
  u.record('testco', 'engineer', 'recall');
  u.flush('testco', aos.db);
  const again = readToolUsage(aos.db, 'testco', 30).find((r) => r.agent === 'engineer' && r.tool === 'recall');
  assert(again && again.n === 3, 'a later flush adds to the same bucket rather than overwriting it', JSON.stringify(again));
}

console.log('\nboundaries\n');
{
  const u = new ToolUsage();
  // The DB file IS the tenant boundary — a flush must not carry another tenant's counts into it.
  u.record('testco', 'engineer', 'recall');
  u.record('othertenant', 'engineer', 'recall');
  u.flush('testco', aos.db);
  assert(u.pendingCount() === 1, "the other tenant's counts stay pending, not written here", `got ${u.pendingCount()}`);
  assert(!readToolUsage(aos.db, 'othertenant', 30).length, "and nothing lands under the other tenant's name");

  // The headers are agent-supplied and advisory. Bound what they can create.
  const v = new ToolUsage();
  v.record('testco', 'engineer', 'x'.repeat(200));
  v.record('testco', 'y'.repeat(200), 'recall');
  v.record('', 'engineer', 'recall');
  v.record('testco', '', 'recall');
  v.record('testco', 'engineer', '');
  assert(v.pendingCount() === 0, 'over-long or empty identifiers are refused, not stored');

  // A day bucket is UTC so it means the same thing on every box.
  assert(usageDay(Date.parse('2026-09-02T23:59:59Z')) === '2026-09-02', 'day buckets are UTC dates');
  assert(usageDay(Date.parse('2026-09-03T00:00:01Z')) === '2026-09-03', '…and roll at UTC midnight');
}

// END TO END: a real request carrying the headers the MCP client sends must be counted. This is the
// part that would silently regress — the module can be perfect while the hook is never called.
(async () => {
  console.log('\nend to end — a loopback request is counted\n');
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { toolUsage } = require(path.join(ROOT, 'dist/edge/tool-usage.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: rtOs } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const before = toolUsage.pendingCount();
  // A READ tool's request. It 4xxs (no valid session) — and must STILL be counted: the question is what
  // the agent reached for, not whether that call succeeded.
  await fetch(`${base}/api/recall`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aos-secret': 'nope', 'x-aos-tool': 'recall', 'x-aos-agent': 'engineer', 'x-aos-tenant': rtOs.tenant },
    body: JSON.stringify({ session: 'ses_none', query: 'x' }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 120));   // the counter runs on the response 'finish' event
  assert(toolUsage.pendingCount() > before, 'a request carrying x-aos-tool + x-aos-agent is counted', `pending ${before} -> ${toolUsage.pendingCount()}`);

  // A browser request carries neither header and must not pollute the histogram.
  const b2 = toolUsage.pendingCount();
  await fetch(`${base}/health`).catch(() => {});
  await new Promise((r) => setTimeout(r, 120));
  assert(toolUsage.pendingCount() === b2, 'a request without the headers is not counted');

  // ONE COUNT PER TOOL CALL. A blocking tool polls a route in a loop under a single label — `task_wait`
  // hits /api/tasks/wait every 3s inside one call, and `task_create({wait:true})` runs that same loop
  // under its own name. Counting requests therefore measured how long an agent WAITED, not what it chose
  // to do: the first live read (2026-09-04) showed `task_create: 1848` on a tenant that had created 311
  // tasks. `x-aos-tool-seq` is the request's position within its call; only the first is counted.
  const call = async (tool, seq) => {
    const headers = { 'content-type': 'application/json', 'x-aos-secret': 'nope', 'x-aos-tool': tool, 'x-aos-agent': 'poller', 'x-aos-tenant': rtOs.tenant };
    if (seq !== undefined) headers['x-aos-tool-seq'] = String(seq);
    await fetch(`${base}/api/tasks/wait`, { method: 'POST', headers, body: JSON.stringify({ session: 'ses_none', id: 't1' }) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
  };
  // One tool call that polled five times.
  for (let i = 1; i <= 5; i++) await call('task_wait', i);
  toolUsage.flush(rtOs.tenant, rtOs.db);
  const waited = readToolUsage(rtOs.db, rtOs.tenant, 30).find((r) => r.agent === 'poller' && r.tool === 'task_wait');
  assert(waited && waited.n === 1, 'a tool that polls 5 times counts as ONE call', `got ${waited ? waited.n : 'nothing'}`);

  // A second, separate call of the same tool is its own count — the fix must not collapse real repeats.
  await call('task_wait', 1);
  toolUsage.flush(rtOs.tenant, rtOs.db);
  const twice = readToolUsage(rtOs.db, rtOs.tenant, 30).find((r) => r.agent === 'poller' && r.tool === 'task_wait');
  assert(twice && twice.n === 2, 'but a second tool call counts again', `got ${twice ? twice.n : 'nothing'}`);

  // No header at all = 1. An MCP process outlives a server upgrade, so the old client that stamps no seq
  // must keep being counted rather than silently vanishing from the data.
  await call('recall', undefined);
  toolUsage.flush(rtOs.tenant, rtOs.db);
  const unstamped = readToolUsage(rtOs.db, rtOs.tenant, 30).find((r) => r.agent === 'poller' && r.tool === 'recall');
  assert(unstamped && unstamped.n === 1, 'a request with no seq header still counts (older MCP client)', `got ${unstamped ? unstamped.n : 'nothing'}`);

  await new Promise((r) => server.close(r));

  // THE OTHER HALF. Everything above sends `x-aos-tool-seq` by hand; none of it proves the MCP client
  // still stamps one. If it stops, the server keeps counting every request exactly as before and the
  // data quietly goes back to being wrong — no error, no failing assertion anywhere else. So drive the
  // real client: spawn it against a stub that never returns terminal, and watch one `task_wait` call
  // poll under an increasing seq.
  console.log('\nthe client half — the MCP stamps the sequence\n');
  const http = require('http');
  const { spawn } = require('child_process');
  const seen = [];
  let settle;
  const done = new Promise((r) => (settle = r));
  const stub = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ tool: req.headers['x-aos-tool'], seq: req.headers['x-aos-tool-seq'] });
      if (seen.length >= 2) settle();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'doing', terminal: false }));   // never terminal → it polls
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/memory/memory-mcp.js')], {
    env: { ...process.env, AOS_URL: `http://127.0.0.1:${stub.address().port}`, SESSION: 'ses_x', AGENT: 'probe', AOS_SECRET: 's', UNATTENDED: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_wait', arguments: { id: 't1', timeoutSeconds: 30 } } }) + '\n');
  await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
  child.kill();
  await new Promise((r) => stub.close(r));
  const polls = seen.filter((x) => x.tool === 'task_wait');
  assert(polls.length >= 2, 'one task_wait call makes repeated loopback requests', `saw ${polls.length}`);
  assert(polls[0] && polls[0].seq === '1', 'the first carries seq 1 — the one that gets counted', JSON.stringify(polls[0]));
  assert(polls[1] && polls[1].seq === '2', 'and each poll after it increments', polls.map((p) => p.seq).join(','));

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
