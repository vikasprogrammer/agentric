#!/usr/bin/env node
/* goal_update — the maturity-tiered agent write path over EXISTING goals.
 *
 * Goals are human-owned strategy: agents could only read (goal_list/goal_get) and draft new ones
 * (goal_propose). goal_update lets a proven agent edit an existing goal, on the same three-lane trust
 * model as agent_propose_update — but with a "shape beats score" rule tuned to strategy: the
 * steering-wheel transitions (activate / abandon / reopen-to-draft / claim-achieved-while-unfinished)
 * ALWAYS go to a human, whatever the proposer's maturity. Only ordinary edits and rubber-stamping an
 * already-100%-done goal as achieved auto-apply at the top tier.
 *
 * This pins those lanes end to end: the refusal below the floor, the always-gated steering transitions
 * even at a forced top tier, the auto-apply of a safe edit, the achieved-at-100% exception, the approve
 * route that applies a gated proposal, and dryRun writing nothing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-goal-update-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

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

  // A claude-code agent to act as the proposer.
  const dir = path.join(aos.paths.userAgents, 'planner-bot');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: 'planner-bot', version: '1.0.0', description: 'planner', principal: 'svc-planner-bot', policyContext: 'default@v3', runtime: 'claude-code' };
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Planner\n\nPlan the work.\n');
  aos.registerAgent({ ...manifest, dir });
  const AGENT = 'planner-bot';

  const session = tm.createSession(AGENT, 'goal edit test', 'task');
  const secret = aos.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get(session.id).secret;
  const call = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': secret }, body: JSON.stringify({ session: session.id, ...body }) });
    return res.json();
  };
  const statusOf = (id) => aos.goals.get(id).status;

  const draft = aos.goals.create({ tenant: aos.tenant, title: 'Grow signups', body: 'why', status: 'draft', createdBy: 'owner-seed' });
  const active = aos.goals.create({ tenant: aos.tenant, title: 'Ship the console', body: 'why', status: 'active', createdBy: 'owner-seed' });

  console.log('\n\x1b[1m1) below the trust floor — an unproven agent is refused\x1b[0m');
  {
    // Default trust floor is 0.4; a brand-new agent has maturity 0.
    const r = await call('/api/goals/update', { id: active.id, rationale: 'tweak the target', target: 'x' });
    assert(r.ok === false && r.outcome === 'refused' && /maturity/i.test(r.error || ''), 'refused, and the error explains maturity', r);
    assert(aos.goals.get(active.id).target === undefined, 'nothing was written', { target: aos.goals.get(active.id).target });
  }

  // Force the top tier so ONLY the shape rule can gate a change.
  aos.settings.setAgentProposalTrust({ minMaturity: 0, autoApplyAt: 0, autoApply: true }, 'test');

  console.log('\n\x1b[1m2) the steering-wheel transitions always wait for a human — even at the top tier\x1b[0m');
  {
    const r = await call('/api/goals/update', { id: draft.id, rationale: 'this is ready to steer the fleet', status: 'active' });
    assert(r.ok && r.outcome === 'pending_approval', 'activating a draft goal is held for review', r);
    assert(statusOf(draft.id) === 'draft', 'the goal is still a draft — nothing applied', { status: statusOf(draft.id) });
    assert(/NOTHING has changed yet/.test(r.message || ''), 'and the reply says so plainly', r.message);
  }
  {
    const r = await call('/api/goals/update', { id: active.id, rationale: 'we are dropping this bet', status: 'abandoned' });
    assert(r.ok && r.outcome === 'pending_approval', 'abandoning a goal is held for review', r);
    assert(statusOf(active.id) === 'active', 'still active — nothing applied');
  }
  {
    // active goal with no completed linked work → claiming "achieved" is premature → gated.
    const r = await call('/api/goals/update', { id: active.id, rationale: 'call it done', status: 'achieved' });
    assert(r.ok && r.outcome === 'pending_approval', 'a premature achieved is held for review', r);
    assert(statusOf(active.id) === 'active', 'still active — nothing applied');
  }

  console.log('\n\x1b[1m3) an ordinary edit from a trusted agent applies immediately\x1b[0m');
  {
    const r = await call('/api/goals/update', { id: active.id, rationale: 'sharpen the target', target: '20% MoM' });
    assert(r.ok && r.applied && r.outcome === 'applied', 'a non-status edit auto-applies', r);
    assert(aos.goals.get(active.id).target === '20% MoM', 'and the goal is actually updated', { target: aos.goals.get(active.id).target });
    assert(/APPLIED/.test(r.message) && /#\/goals\//.test(r.message), 'the reply is unambiguous it is LIVE and carries the goal URL', r.message);
  }

  console.log('\n\x1b[1m4) achieved auto-applies ONLY when the linked work is already 100% done\x1b[0m');
  {
    const done = aos.goals.create({ tenant: aos.tenant, title: 'Finish the migration', status: 'active', createdBy: 'owner-seed' });
    const t = aos.tasks.create({ tenant: aos.tenant, title: 'do it', goalId: done.id, createdBy: 'owner-seed' });
    aos.tasks.update(t.id, { status: 'done', by: 'owner-seed' });
    assert(aos.goals.progress(done.id).percent === 100, 'the goal is 100% done by its linked tasks', aos.goals.progress(done.id));
    const r = await call('/api/goals/update', { id: done.id, rationale: 'all filed work is complete', status: 'achieved' });
    assert(r.ok && r.outcome === 'applied', 'marking an already-complete goal achieved auto-applies', r);
    assert(statusOf(done.id) === 'achieved', 'and the goal is achieved');
  }

  console.log('\n\x1b[1m5) the approve route applies a gated proposal (owner sign-off)\x1b[0m');
  {
    const owner = aos.team.listMembers().find((m) => m.role === 'owner');
    const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
    const cards = await fetch(base + '/api/goals/proposals', { headers: { cookie } }).then((r) => r.json());
    const card = cards.proposals.find((c) => c.goalId === draft.id && c.fields && c.fields.status === 'active');
    assert(!!card, 'the activation proposal is in the owner review queue', { n: cards.proposals?.length });
    const approved = await fetch(base + `/api/goals/proposals/${card.id}/approve`, { method: 'POST', headers: { cookie } }).then((r) => r.json());
    assert(approved.ok && approved.status === 'active', 'approving it activates the goal', approved);
    assert(statusOf(draft.id) === 'active', 'and the goal is now active');
    // The event log records the human as the applying author, preserving the proposer in the note.
    const ev = aos.goals.withEvents(draft.id).events.find((e) => e.kind === 'status' && /→active/.test(e.body || ''));
    assert(!!ev && ev.author === owner.email, 'the applying author is the approving human, not the agent', ev);
  }

  console.log('\n\x1b[1m6) dryRun names the lane and writes nothing\x1b[0m');
  {
    const before = aos.goals.get(active.id).body;
    const openBefore = tm.openGoalUpdateProposals().length;
    const r = await call('/api/goals/update', { id: active.id, rationale: 'just checking', body: 'a rewritten body', dryRun: true });
    assert(r.ok && r.outcome === 'dry_run', 'dryRun reports the lane', r);
    assert(aos.goals.get(active.id).body === before, 'and writes absolutely nothing');
    assert(tm.openGoalUpdateProposals().length === openBefore, 'and queues no card');
  }

  console.log('\n\x1b[1m7) a no-op edit is refused, not silently "applied"\x1b[0m');
  {
    const r = await call('/api/goals/update', { id: active.id, rationale: 'no change', target: '20% MoM' });
    assert(r.ok === false && /nothing to change/i.test(r.error || ''), 'passing the goal\'s current values changes nothing', r);
  }

  server.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
