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

  await new Promise((r) => server.close(r));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
