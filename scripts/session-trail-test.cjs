#!/usr/bin/env node
/* Session-trail test: the /api/sessions/:id/activity endpoint now (1) classifies secrets/skills/policy
 * effects and (2) attaches each object's LIVE status resolved from its store (task todo→done, KB rev,
 * proposal pending→approved, secret stored). Boots a real in-process HTTP server + registry, seeds one
 * session's audit stream + the live objects, and asserts the endpoint's output. Isolated home. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-trail-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
process.env.AGENT_OS_OWNER_EMAIL = 'owner@test';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const rt = registry.get('testco');
  const { os: aos } = rt;
  const T = aos.tenant;

  // owner cookie — invite + accept mints a real auth session id
  const { token } = aos.team.invite({ email: 'tester@test', role: 'owner' });
  const sid = aos.team.acceptToken(token).sid;
  const cookie = `aos_sid=${sid}`;

  // a session row (owner is run_as so canViewSession trivially passes)
  const SID = 'ts_trail1';
  aos.db.prepare(
    "INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(SID, 'website-bot', 'trail run', 'do stuff', 'aos-' + SID, 'running', 1, 0, null, null, Date.now(), Date.now());

  // audit stream for the run — one effect per plane we care about
  let t = Date.now();
  const audit = (type, data) => aos.db
    .prepare("INSERT INTO audit_events (ts,run_id,tenant,type,principal,data) VALUES (?,?,?,?,?,?)")
    .run(t++, SID, T, type, 'website-bot', JSON.stringify(data));
  audit('task.created',   { id: 'tk1', title: 'migrate the DB' });
  audit('task.updated',   { id: 'tk1', status: 'doing' });
  audit('task.dispatched', { task: 'tk1', title: 'migrate the DB', agent: 'website-bot' }); // id lives in data.task
  audit('task.dispatched', { title: 'orphan (no id)' }); // no task id → must NOT resolve to "deleted"
  audit('secret.put',     { key: 'STRIPE_KEY', principal: '*' });
  audit('secret.requested', { key: 'OPENAI_KEY', mode: 'provide' });
  audit('skill.proposed', { name: 'triage-flow', description: 'triage playbook' });
  audit('policy.proposed', { kind: 'tighten', capability: 'Bash' });
  audit('kb.written',     { section: 'engineering', slug: 'deploy', rev: 1 });

  // live objects the statuses resolve against
  const now = Date.now();
  aos.db.prepare("INSERT INTO tasks (id,tenant,title,body,status,priority,labels,created_by,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run('tk1', T, 'migrate the DB', '', 'doing', 2, '[]', 'agent:website-bot', now, now, 'agent:website-bot');
  aos.db.prepare("INSERT INTO secrets (tenant,principal,key,value_enc,updated_at,updated_by) VALUES (?,?,?,?,?,?)")
    .run(T, '*', 'STRIPE_KEY', 'x', now, 'agent:website-bot');
  aos.db.prepare("INSERT INTO kb_pages (id,tenant,section,slug,title,tags,body,rel_path,rev,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('kp1', T, 'engineering', 'deploy', 'Deploy', '[]', '# deploy', 'kb/engineering/deploy.md', 3, now, now, 'agent:website-bot');
  // proposal cards carry their own live status; secret-request approved, skill/policy still pending(open)
  const addMsg = (id, type, status, args) => aos.db
    .prepare("INSERT INTO messages (id,type,session_id,agent,title,body,status,args,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, type, SID, 'website-bot', 't', 'b', status, JSON.stringify(args), now);
  addMsg('m_sec', 'secret.request', 'approved', { key: 'OPENAI_KEY', mode: 'provide' });
  addMsg('m_skl', 'skill.proposed', 'open', { skill: 'triage-flow' });
  addMsg('m_pol', 'policy.proposal', 'open', { delta: { kind: 'tighten', match: { capability: 'Bash' } } });

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SID}/activity`, { headers: { cookie } });
  const body = await res.json();

  console.log('\n\x1b[1mSession activity trail — coverage + live status\x1b[0m');
  assert(res.status === 200, 'endpoint returns 200', `${res.status} ${JSON.stringify(body)}`);
  const ev = body.events || [];
  const by = (prim) => ev.find((e) => e.primitive === prim) || {};

  // (1) coverage — the new categories surface (were previously 'other')
  assert(by('secret_put').category === 'secrets', 'secret.put → secrets category');
  assert(by('secret_request').category === 'secrets', 'secret.requested → secrets category');
  assert(by('skill_propose').category === 'skills', 'skill.proposed → skills category');
  assert(by('policy_propose').category === 'policy', 'policy.proposed → policy category');

  // (2) live status resolution
  assert(by('task_create').status === 'doing' && by('task_create').statusTone === 'open', 'task → live status "doing" (open)', JSON.stringify(by('task_create')));
  assert(by('task_update').status === 'doing', 'task_update entry also resolves to current "doing"');
  // task.dispatched keys the id under data.task; an id-bearing dispatch resolves, an orphan stays blank
  const disp = ev.filter((e) => e.primitive === 'task_dispatch');
  assert(disp.some((e) => e.target && e.target.id === 'tk1' && e.status === 'doing'), 'task_dispatch (data.task=tk1) → resolves to "doing"', JSON.stringify(disp));
  assert(disp.some((e) => !e.status && !(e.target && e.target.id)), 'task_dispatch with no id → no target, no misleading "deleted" status');
  assert(by('secret_put').status === 'stored', 'secret → "stored" (exists in vault)', JSON.stringify(by('secret_put')));
  assert(by('kb_write').status === 'rev 3' && by('kb_write').statusTone === 'muted', 'kb_write → current "rev 3"', JSON.stringify(by('kb_write')));
  assert(by('secret_request').status === 'approved' && by('secret_request').statusTone === 'done', 'secret_request → card status "approved" (done)', JSON.stringify(by('secret_request')));
  assert(by('skill_propose').status === 'pending' && by('skill_propose').statusTone === 'open', 'skill_propose → card "pending" (open)', JSON.stringify(by('skill_propose')));
  assert(by('policy_propose').status === 'pending' && by('policy_propose').statusTone === 'open', 'policy_propose → card "pending" (open)', JSON.stringify(by('policy_propose')));

  // summary still groups counts
  assert((body.summary || []).some((s) => s.category === 'policy'), 'summary includes the policy category');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}SESSION TRAIL: ${pass}/${pass + fail} passed\x1b[0m`);
  server.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(1); });
