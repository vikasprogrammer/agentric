#!/usr/bin/env node
/* "Edit with agent" — an agent proposes an EDIT to an existing automation; a human approves it.
 *
 * What must hold: proposing changes nothing; the edit merges only the fields sent; a proposal that could
 * not be applied is refused when made; approval updates THAT automation (never creates a second one);
 * a human edit made while the proposal waited blocks approval instead of being silently reverted; and the
 * "Edit with agent" route opens a session briefed with the live config and the editOf id.
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-autoedit-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm, autos } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = path.join(aos.paths.userAgents, 'reporter');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: 'reporter', version: '1.0.0', description: 'reporter', principal: 'svc-reporter', policyContext: 'default@v3', runtime: 'claude-code' };
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# reporter\n');
  aos.registerAgent({ ...manifest, dir });

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, ...(await r.json()) }; };
  const get = async (p) => (await fetch(base + p, { headers: { cookie } })).json();

  const auto = autos.add({ agentId: 'reporter', name: 'Daily digest', type: 'cron', schedule: '0 9 * * *', task: 'Post the digest.', createdBy: owner.id });
  const hook = autos.add({ agentId: 'reporter', name: 'Inbound', type: 'webhook', task: 'Handle it.', createdBy: owner.id });
  const session = tm.createSession('reporter', 'edit test', 'task');
  const secret = aos.db.prepare('SELECT secret FROM term_sessions WHERE id = ?').get(session.id)?.secret;
  const propose = async (body) => {
    const r = await fetch(base + '/api/agent/automation/propose', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-aos-secret': secret } : {}) }, body: JSON.stringify({ session: session.id, ...body }) });
    return { status: r.status, ...(await r.json()) };
  };

  console.log('\n\x1b[1m1) "Edit with agent" opens a briefed session\x1b[0m');
  const opened = await post(`/api/automations/${auto.id}/edit-with-agent`, { note: 'run at 8 instead' });
  assert(opened.ok && opened.id, 'the route spawns a session', opened);
  const row = aos.db.prepare('SELECT agent, task FROM term_sessions WHERE id = ?').get(opened.id);
  assert(row && row.agent === 'reporter', 'with the automation\'s own agent', row);
  assert(row && row.task.includes(`editOf: "${auto.id}"`), 'the brief names the editOf id to propose against');
  assert(row && row.task.includes('Post the digest.') && row.task.includes('0 9 * * *'), 'and carries the current task + schedule verbatim');
  assert(row && row.task.includes('run at 8 instead'), 'and the member\'s note');

  console.log('\n\x1b[1m2) Proposing an edit changes nothing, and refuses what could not apply\x1b[0m');
  const probe = await propose({ editOf: auto.id, schedule: '0 8 * * 1-5', rationale: 'weekdays at 8' });
  if (probe.status === 403) { console.log('  (session secret header not accepted — check sessionSecretOk)'); }
  assert(probe.ok, 'a schedule edit is accepted', probe);
  assert(/schedule: `0 9 \* \* \*` → `0 8 \* \* 1-5`/.test(probe.preview || ''), 'the preview shows before → after', probe.preview);
  assert(autos.get(auto.id).schedule === '0 9 * * *', 'and the automation is untouched');
  assert(autos.list().length === 2, 'and nothing new is created');
  const dup = await propose({ editOf: auto.id, schedule: '0 8 * * 1-5' });
  assert(!dup.ok && /already awaiting review/.test(dup.error || ''), 'an identical open edit is deduped', dup);
  const noop = await propose({ editOf: auto.id, schedule: '0 9 * * *' });
  assert(!noop.ok && /changes nothing/.test(noop.error || ''), 'a no-op edit is refused', noop);
  const badCron = await propose({ editOf: auto.id, schedule: 'every morning' });
  assert(!badCron.ok && /invalid cron/.test(badCron.error || ''), 'a bad cron is refused when proposed', badCron);
  const wrongField = await propose({ editOf: hook.id, schedule: '0 8 * * *' });
  assert(!wrongField.ok && /only applies to a cron/.test(wrongField.error || ''), 'a schedule on a webhook trigger is refused', wrongField);
  const ghost = await propose({ editOf: 'auto-nope', task: 'x' });
  assert(!ghost.ok && ghost.status === 404, 'an unknown automation id is a 404', ghost);

  console.log('\n\x1b[1m3) Approving updates THAT automation\x1b[0m');
  const proposals = (await get('/api/automations/proposals')).proposals;
  const card = proposals.find((p) => p.editOf === auto.id);
  assert(card && card.changes.join() === 'schedule', 'the card surfaces as an edit with its changed fields', card);
  const ok = await post(`/api/automations/proposals/${card.id}/approve`, {});
  assert(ok.ok && ok.edited, 'approve succeeds as an edit', ok);
  assert(autos.get(auto.id).schedule === '0 8 * * 1-5', 'the schedule changed');
  assert(autos.get(auto.id).task === 'Post the digest.', 'fields not in the edit are kept');
  assert(autos.list().length === 2, 'no second automation was created');

  console.log('\n\x1b[1m4) A human edit made meanwhile blocks approval\x1b[0m');
  const t = await propose({ editOf: auto.id, task: 'Post the digest, then a one-line summary in #general.' });
  assert(t.ok && /task prompt: rewritten/.test(t.preview || ''), 'a task rewrite is proposed', t);
  autos.update(auto.id, { name: 'Morning digest' }); // the human renames it while the card waits
  const staleId = (await get('/api/automations/proposals')).proposals.find((p) => p.editOf === auto.id).id;
  const stale = await post(`/api/automations/proposals/${staleId}/approve`, {});
  assert(stale.status === 409 && /changed after this edit/.test(stale.error || ''), 'approval refuses with 409', stale);
  assert(autos.get(auto.id).name === 'Morning digest' && autos.get(auto.id).task === 'Post the digest.', 'and the human\'s change survives');
  autos.update(auto.id, { enabled: false });
  const t2 = await propose({ editOf: auto.id, task: 'Post the digest twice.' });
  autos.update(auto.id, { enabled: true }); // toggling enabled must NOT invalidate
  const t2Id = (await get('/api/automations/proposals')).proposals.find((p) => p.editOf === auto.id && p.after.task === 'Post the digest twice.').id;
  const ok2 = await post(`/api/automations/proposals/${t2Id}/approve`, {});
  assert(t2.ok && ok2.ok && autos.get(auto.id).task === 'Post the digest twice.', 'pausing/resuming meanwhile does not block approval', ok2);

  console.log('\n\x1b[1m5) Creating still works as before\x1b[0m');
  const create = await propose({ name: 'Weekly', task: 'weekly thing', type: 'cron', schedule: '0 9 * * 1' });
  assert(create.ok && !create.edit, 'a proposal without editOf is still a create proposal', create);

  server.close();
  registry.stopAll();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
