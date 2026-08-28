#!/usr/bin/env node
/* Pin the two facts the new Inbox/roster surfacing keys on:
 *   1. an open `agent.update.proposed` card is returned by GET /api/messages with status 'open' and
 *      args.target — the fields the "Needs you" card and its deep-link read;
 *   2. the card's MESSAGE id is the proposal id the approve/reject routes accept, so the inline
 *      Approve & apply button can act straight off the inbox row;
 *   3. GET /api/agents/proposals (no target) returns every open proposal with its target — the roster
 *      badge's data source — and drops the card once it's approved.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-prop-inbox-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`));

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = (id, prompt) => {
    const dir = path.join(aos.paths.userAgents, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, version: '1.0.0', description: `${id} agent`, principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code' };
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), prompt);
    aos.registerAgent({ ...manifest, dir });
    return id;
  };
  const PROMPT = '# Release orchestrator\n\n## Absolute boundaries\n\nNever force-push.\n\n## The method\n\nCut the branch.\n';
  const EDITOR = mk('editor-bot', '# Editor\n\n## Method\n\nDo the work.\n');
  const TARGET = mk('release-orchestrator', PROMPT);

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const get = async (p) => (await fetch(base + p, { headers: { cookie: ownerCookie } })).json();
  const post = async (p) => (await fetch(base + p, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: '{}' })).json();

  const session = tm.createSession(EDITOR, 'edit test', 'task');
  // Middle band: propose-don't-apply, which is the lane that posts the review card.
  aos.settings.setAgentProposalTrust({ minMaturity: 0, autoApplyAt: 1, autoApply: false }, 'test');
  const proposed = tm.proposeAgentUpdate(session.id, EDITOR, { id: TARGET, rationale: 'tighten the boundaries', claudeMdAppend: '## Shipping\n\nHand off.\n' });
  assert(proposed.ok && proposed.outcome === 'pending_approval', 'the proposal is queued, not applied', proposed);

  console.log('\n\x1b[1m1) the inbox card an owner now sees in "Needs you"\x1b[0m');
  const msgs = await get('/api/messages');
  const list = Array.isArray(msgs) ? msgs : msgs.messages;
  const card = list.find((m) => m.type === 'agent.update.proposed');
  assert(!!card, 'the card reaches the owner inbox', list.map((m) => m.type));
  assert(card && card.status === 'open', 'with status open — the clause that promotes it to "Needs you"', card && card.status);
  assert(card && card.args && card.args.target === TARGET, 'and args.target, which the card deep-links to', card && card.args);

  console.log('\n\x1b[1m2) the message id IS the proposal id\x1b[0m');
  const all = await get('/api/agents/proposals');
  assert(all.proposals && all.proposals.length === 1, 'GET /api/agents/proposals lists it', all);
  assert(all.proposals[0].id === card.id, 'under the same id the inbox card carries', { proposal: all.proposals[0].id, card: card.id });
  assert(all.proposals[0].target === TARGET, 'with the target the roster badge counts by', all.proposals[0].target);

  console.log('\n\x1b[1m3) approving from the card resolves it\x1b[0m');
  const ok = await post(`/api/agents/proposals/${card.id}/approve`);
  assert(ok.ok === true, 'approve accepts the inbox card id', ok);
  const after = await get('/api/agents/proposals');
  assert((after.proposals ?? []).length === 0, 'the roster badge drops to zero', after);
  const msgs2 = await get('/api/messages');
  const card2 = (Array.isArray(msgs2) ? msgs2 : msgs2.messages).find((m) => m.id === card.id);
  assert(card2 && card2.status === 'approved', 'and the card leaves "Needs you" for Activity', card2 && card2.status);
  assert(fs.readFileSync(path.join(aos.paths.userAgents, TARGET, 'CLAUDE.md'), 'utf8').includes('## Shipping'), 'the edit really landed');

  server.close();
  await registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
