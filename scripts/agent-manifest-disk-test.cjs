#!/usr/bin/env node
/* Agent manifests — born on the tenant's enforced ruleset, and never reverted by the next edit.
 *
 * Two defects that compounded (issues #903, #904):
 *
 *   1. Every agent-creation path hardcoded `policyContext: 'default@v3'`. On a tenant whose enforced
 *      ruleset has another id, each new agent was born with a `policyContextMismatch` drift warning — a
 *      false alarm per agent that trains operators to ignore the real one.
 *   2. The natural fix-by-hand (edit agent.json) didn't stick: every writer built the next manifest from
 *      the IN-MEMORY copy, which never saw the out-of-band edit, and wrote it back over disk. The same
 *      revert silently dropped a hand-added `shellSecrets` — and `agent_create` offered no way to declare
 *      one, so hand-editing was the only agent-side route.
 *
 * Pins: creation stamps `os.policy.id`; `agent_create` carries `shellSecrets`; the self-edit lane, the
 * console config route and a revert all build on the manifest ON DISK.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agent-manifest-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

// A tenant whose enforced ruleset is NOT the bundled label.
const RULESET = 'acme@v2';
const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/policy/default.policy.json'), 'utf8'));
fs.mkdirSync(path.join(HOME, 'policy'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'policy', 'default.policy.json'), JSON.stringify({ ...bundled, id: RULESET }, null, 2));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`));

console.log('\n\x1b[1m1) agent_create exposes shellSecrets\x1b[0m');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/memory/memory-mcp.ts'), 'utf8');
  const start = src.indexOf("name: 'agent_create'");
  const block = src.slice(start, src.indexOf("name: 'agent_get'", start));
  assert(/shellSecrets:\s*\{/.test(block), 'the tool schema declares shellSecrets');
  const handler = src.slice(src.indexOf('async function agentCreate('), src.indexOf('async function agentCreate(') + 2000);
  assert(/shellSecrets:/.test(handler), 'and the handler forwards it to the create route');
}

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert(aos.policy.id === RULESET, `the tenant enforces ${RULESET}`, aos.policy.id);

  // The authoring agent.
  const authorDir = path.join(aos.paths.userAgents, 'agent-author-bot');
  fs.mkdirSync(authorDir, { recursive: true });
  const authorManifest = { id: 'agent-author-bot', version: '1.0.0', description: 'author', principal: 'svc-agent-author-bot', policyContext: RULESET, runtime: 'claude-code' };
  fs.writeFileSync(path.join(authorDir, 'agent.json'), JSON.stringify(authorManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(authorDir, 'CLAUDE.md'), '# Author\n');
  aos.registerAgent({ ...authorManifest, dir: authorDir });

  const asSession = (agentId) => {
    const s = tm.createSession(agentId, 'manifest test', 'task');
    const secret = aos.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get(s.id).secret;
    return async (p, body) => {
      const res = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aos-secret': secret },
        body: JSON.stringify({ session: s.id, ...body }),
      });
      return res.json();
    };
  };
  const NEW = 'db-reporter';
  const file = path.join(aos.paths.userAgents, NEW, 'agent.json');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  console.log('\n\x1b[1m2) creation stamps the enforced ruleset and carries shellSecrets\x1b[0m');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  const created = await asSession('agent-author-bot')('/api/agents/create', {
    id: NEW, description: 'Reports from the read replica', claudeMd: '# DB reporter\n\n## Method\n\nQuery, then report.\n',
    shellSecrets: ['DB_RO_PASS'],
  });
  console.warn = origWarn;
  assert(created.ok, 'agent_create succeeds', created);
  assert(disk().policyContext === RULESET, `agent.json policyContext = ${RULESET}, not the bundled label`, disk().policyContext);
  assert(aos.agents.get(NEW).policyContext === RULESET, 'and so does the live registry');
  assert(!warnings.some((w) => w.includes(`"${NEW}"`) && w.includes('policyContext')), 'no drift warning at registration', warnings);
  assert(JSON.stringify(disk().shellSecrets) === '["DB_RO_PASS"]', 'shellSecrets declared at creation land in agent.json', disk().shellSecrets);

  console.log('\n\x1b[1m3) a self-edit builds on the manifest ON DISK\x1b[0m');
  // Out-of-band: a human adds a second secret and an extra key the in-memory copy never sees.
  fs.writeFileSync(file, JSON.stringify({ ...disk(), shellSecrets: ['DB_RO_PASS', 'REPORT_TOKEN'], handNote: 'kept' }, null, 2) + '\n');
  assert(!aos.agents.get(NEW).handNote, '(precondition) memory has not seen the hand edit');
  const self = asSession(NEW);
  const got = await self('/api/agents/get', {});
  const upd = await self('/api/agents/update', { baseHash: got.baseHash, claudeMdAppend: '## Output\n\nA short table.' });
  assert(upd.ok, 'agent_update succeeds', upd);
  assert(JSON.stringify(disk().shellSecrets) === '["DB_RO_PASS","REPORT_TOKEN"]', 'the hand-added secret survives the self-edit', disk().shellSecrets);
  assert(disk().handNote === 'kept' && disk().policyContext === RULESET, 'as does every other on-disk key', disk());
  assert(JSON.stringify(aos.agents.get(NEW).shellSecrets) === '["DB_RO_PASS","REPORT_TOKEN"]', 'and the registry now matches disk');
  assert(fs.readFileSync(path.join(aos.paths.userAgents, NEW, 'CLAUDE.md'), 'utf8').includes('## Output'), 'while the edit itself applied');

  console.log('\n\x1b[1m4) the console config route and a revert do too\x1b[0m');
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  fs.writeFileSync(file, JSON.stringify({ ...disk(), handNote: 'kept-2' }, null, 2) + '\n');
  const cfg = await fetch(base + `/api/agents/${NEW}/config`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ effort: 'high' }) }).then((r) => r.json());
  assert(cfg.ok && disk().effort === 'high', 'the config PUT applied', cfg);
  assert(disk().handNote === 'kept-2', 'without reverting the out-of-band edit', disk());

  fs.writeFileSync(file, JSON.stringify({ ...disk(), handNote: 'kept-3' }, null, 2) + '\n');
  const hist = await self('/api/agents/history', {});
  const first = hist.revisions && hist.revisions[hist.revisions.length - 1];
  const rev = await self('/api/agents/revert', { rev: first && first.rev });
  assert(rev.ok, 'agent_revert runs', { hist, rev });
  assert(disk().handNote === 'kept-3', 'a revert keeps on-disk keys a snapshot does not carry', disk());

  console.log('\n\x1b[1m5) built-in and system agents are stamped too\x1b[0m');
  const builtin = JSON.parse(fs.readFileSync(path.join(aos.paths.userAgents, 'agent-author', 'agent.json'), 'utf8'));
  assert(builtin.policyContext === RULESET, 'the seeded agent-author names the enforced ruleset', builtin.policyContext);
  for (const id of ['concierge', 'consolidator']) {
    const a = aos.agents.get(id);
    if (a) assert(a.policyContext === RULESET, `system agent "${id}" registers on the enforced ruleset`, a.policyContext);
  }

  server.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
