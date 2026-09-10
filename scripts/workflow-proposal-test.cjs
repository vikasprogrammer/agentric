#!/usr/bin/env node
/* Workflow proposals — several automations reviewed and approved as ONE unit.
 *
 * The dangerous half of this feature is not the proposing, it is the approving: a human presses one
 * button and N triggers come into existence. So the assertions here are mostly about what must NOT
 * happen — a part that fails validation must leave NOTHING behind (half a function running, with no
 * card explaining which half, is worse than no function), a proposal must be refused at the point it is
 * made if it could not be approved, and a single-automation proposal — including a card written by an
 * older build that only stored `spec` — must keep behaving exactly as it always did.
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-wf-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { classifyIntent } = require(path.join(ROOT, 'dist/edge/intent.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm, autos } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = (id) => {
    const dir = path.join(aos.paths.userAgents, id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { id, version: '1.0.0', description: `${id} agent`, principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code' };
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# ${id}\n`);
    aos.registerAgent({ ...manifest, dir });
    return id;
  };
  const SUPPORT = mk('support-ops');
  const ENGINEER = mk('engineer');

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  const get = async (p) => (await fetch(base + p, { headers: { cookie: ownerCookie } })).json();

  const session = tm.createSession(SUPPORT, 'wf test', 'task');
  const cardCount = () => aos.db.prepare("SELECT COUNT(*) c FROM messages WHERE type = 'automation.proposed'").get().c;
  const autoCount = () => autos.list().length;

  const TICKET = { name: 'New ticket', task: 'Classify the ticket, answer easy ones, escalate bugs to the engineer with task_create.', type: 'webhook', agentId: SUPPORT };
  const SWEEP = { name: '30-minute sweep', task: 'Re-check for tickets nothing picked up.', type: 'cron', schedule: '*/30 * * * *', agentId: SUPPORT };

  console.log('\n\x1b[1m1) A function is proposed as ONE card\x1b[0m');
  const before = cardCount();
  const p1 = tm.proposeWorkflow(session.id, SUPPORT, [TICKET, SWEEP], 'Tickets are being missed overnight.', 'Support triage');
  assert(p1.ok, 'the two-part proposal is accepted', p1);
  assert(cardCount() === before + 1, 'exactly ONE review card for the whole function');
  assert(autoCount() === 0, 'and NOTHING is created — a proposal creates no automation');
  const listed = (await get('/api/automations/proposals')).proposals;
  const wf = listed.find((x) => x.workflow === 'Support triage');
  assert(!!wf, 'the proposal surfaces with its function name');
  assert(wf.specs.length === 2, 'both parts ride on the card');
  assert(wf.spec.name === 'New ticket', '`spec` is still the first part, so single-automation readers are unaffected');
  assert(wf.preview.split('\n').length === 2, 'the preview names every part — the approver sees the whole set before one button');

  console.log('\n\x1b[1m2) Approving creates every part, under the approver\'s chosen identity\x1b[0m');
  const ok = await post(`/api/automations/proposals/${wf.id}/approve`, { runAs: owner.id });
  assert(ok.ok === true, 'approve succeeds', ok);
  assert(ok.automations.length === 2, 'both automations come back');
  assert(autoCount() === 2, 'both exist in the store');
  assert(autos.list().every((a) => a.runAs === owner.id), 'the run-as override applies to every part, not just the first');
  assert(autos.list().some((a) => a.type === 'webhook') && autos.list().some((a) => a.type === 'cron'), 'each part keeps its own trigger type');
  assert((await get('/api/automations/proposals')).proposals.every((x) => x.id !== wf.id), 'the card leaves the queue');

  console.log('\n\x1b[1m3) A part that fails at approve time leaves NOTHING behind\x1b[0m');
  const bad = tm.proposeWorkflow(session.id, SUPPORT, [
    { name: 'Good part', task: 'do a thing', type: 'cron', schedule: '0 9 * * *', agentId: SUPPORT },
    { name: 'Bad part', task: 'do another', type: 'cron', schedule: '0 9 * * *', agentId: ENGINEER },
  ], 'two parts', 'Half broken');
  assert(bad.ok, 'the proposal is valid when made', bad);
  const badId = (await get('/api/automations/proposals')).proposals.find((x) => x.workflow === 'Half broken').id;
  // Break part 2 the way reality does: the agent it names is deleted between proposal and approval.
  aos.agents.delete(ENGINEER);
  const wasCount = autoCount();
  const r = await post(`/api/automations/proposals/${badId}/approve`, {});
  assert(!r.ok && /part 2 of 2/.test(r.error || ''), 'approve fails and says which part', r);
  assert(/nothing was created/.test(r.error || ''), 'and says nothing was created', r);
  assert(autoCount() === wasCount, 'the good part was rolled back — no half-built function');
  assert((await get('/api/automations/proposals')).proposals.some((x) => x.id === badId), 'the proposal stays open for the human to fix or reject');

  console.log('\n\x1b[1m4) A proposal that could not be approved is refused when it is made\x1b[0m');
  const cards = cardCount();
  const unknown = tm.proposeWorkflow(session.id, SUPPORT, [TICKET, { name: 'Ghost', task: 'x', type: 'cron', schedule: '0 9 * * *', agentId: 'no-such-agent' }]);
  assert(!unknown.ok && /part 2/.test(unknown.error || ''), 'an unknown agent in part 2 is named', unknown);
  const noCron = tm.proposeWorkflow(session.id, SUPPORT, [{ name: 'Cron', task: 'x', type: 'cron', agentId: SUPPORT }]);
  assert(!noCron.ok && /schedule/.test(noCron.error || ''), 'a cron part with no schedule is refused', noCron);
  const empty = tm.proposeWorkflow(session.id, SUPPORT, []);
  assert(!empty.ok, 'an empty proposal is refused');
  const tooMany = tm.proposeWorkflow(session.id, SUPPORT, Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, task: 'x', type: 'cron', schedule: '0 9 * * *', agentId: SUPPORT })));
  assert(!tooMany.ok && /at most 6/.test(tooMany.error || ''), 'a flowchart-shaped proposal is refused at 7 parts', tooMany);
  assert(cardCount() === cards, 'none of those posted a card');

  console.log('\n\x1b[1m5) Duplicates and the single-automation path\x1b[0m');
  const dup1 = tm.proposeWorkflow(session.id, SUPPORT, [SWEEP], undefined, 'Sweeper');
  assert(dup1.ok, 'a one-part workflow is just an automation proposal', dup1);
  const dup2 = tm.proposeWorkflow(session.id, SUPPORT, [SWEEP], undefined, 'Sweeper');
  assert(!dup2.ok && /already awaiting review/.test(dup2.error || ''), 'an identical open proposal is deduped', dup2);
  const single = tm.proposeAutomation(session.id, SUPPORT, { name: 'Daily digest', task: 'post the digest', type: 'cron', schedule: '0 9 * * *', agentId: SUPPORT }, 'why');
  assert(single.ok && single.preview.split('\n').length === 1, 'proposeAutomation still takes one spec and previews one line', single);

  console.log('\n\x1b[1m6) A card written by an older build (spec only, no specs) still approves\x1b[0m');
  const legacyId = (await get('/api/automations/proposals')).proposals.find((x) => x.spec.name === 'Daily digest').id;
  const args = JSON.parse(aos.db.prepare('SELECT args FROM messages WHERE id = ?').get(legacyId).args);
  delete args.specs; // exactly what a pre-0.427 card looks like on disk
  aos.db.prepare('UPDATE messages SET args = ? WHERE id = ?').run(JSON.stringify(args), legacyId);
  const n = autoCount();
  const legacy = await post(`/api/automations/proposals/${legacyId}/approve`, {});
  assert(legacy.ok === true, 'a legacy single-spec card approves', legacy);
  assert(autoCount() === n + 1, 'and creates exactly one automation');

  console.log('\n\x1b[1m7) A function description reaches the operator, not a work agent\x1b[0m');
  assert(classifyIntent('every time a support ticket comes in, classify it and escalate bugs').intent === 'action', '"every time …" is an action (a function to set up)');
  assert(classifyIntent('whenever a PR is opened, review it').intent === 'action', '"whenever …" too');
  assert(classifyIntent('set up a workflow for support triage').intent === 'action', 'so is an explicit "set up a workflow"');
  assert(classifyIntent('my pod is down').intent === 'work', 'an ordinary request is still work');
  assert(classifyIntent('check every pod in the cluster').intent === 'work', 'a bare "every" as a quantifier is NOT a schedule');

  server.close();
  registry.stopAll();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
