#!/usr/bin/env node
/* Session search — `session_history` as a keyword search, and session links that resolve.
 *
 * The incident: a human asked an agent to find "the session where we fixed the PayPal webhook". That
 * work lived late in a long interactive run titled after its FIRST job, so the old tool — a substring
 * match over title + seed task, own agent only — could not see it. The agent opened the tenant DB with
 * `node:sqlite` from Bash, grepped other agents' transcripts, found the run, and then handed the human
 * `#/sessions/ses_…`, a link it had assembled itself and the console did not route (the detail segment
 * is the tmux name, `aos-ses_…`).
 *
 * Pinned here: the pure helpers; FTS over the row's own prose kept current by triggers (and NOT
 * re-tokenized by the constant activity writes); the transcript index finding what only the transcript
 * says, catching up when a run continues, and collapsing a resumed conversation to one hit; the two
 * scopes — own agent, or exactly what the run-as human can see in the console — through the real
 * loopback routes; and the `url` every result carries. Isolated home; no tmux, no claude. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-session-search-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'claude-config');
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`));

const { digestConversation, toSessionFtsQuery, normalizeSessionRef, sessionConsoleUrl } = require(path.join(ROOT, 'dist/edge/session-search.js'));

console.log('\n\x1b[1m1) pure helpers\x1b[0m');
assert(toSessionFtsQuery('PayPal webhook') === '"paypal" OR "webhook"', 'words are quoted and ORed', toSessionFtsQuery('PayPal webhook'));
assert(toSessionFtsQuery('a:b -c* NEAR(x)') === '"near"', 'operator characters cannot reach FTS5 (single letters dropped)', toSessionFtsQuery('a:b -c* NEAR(x)'));
assert(toSessionFtsQuery('  ') === '' && toSessionFtsQuery('!!') === '', 'no searchable word → empty (caller lists by recency)');
assert(toSessionFtsQuery('order 7') === '"order" OR "7"', 'a lone digit is kept (order numbers, versions)');
assert(normalizeSessionRef('ses_abc123') === 'ses_abc123', 'a bare id passes through');
assert(normalizeSessionRef('aos-ses_abc123') === 'ses_abc123', 'the tmux name is accepted');
assert(normalizeSessionRef('https://x.example.com/#/sessions/aos-ses_abc123?tab=chat') === 'ses_abc123', 'a full console URL is accepted');
assert(normalizeSessionRef('https://x.example.com/#/sessions/ses_abc123') === 'ses_abc123', 'and so is the broken link agents used to build');
assert(sessionConsoleUrl('https://x.example.com/', 'ses_1') === 'https://x.example.com/#/sessions/aos-ses_1', 'the console URL uses the tmux-name detail');

const turn = (kind, text) => ({ kind, text, ts: 0 });
const long = [turn('user', 'build the feature pages'), ...Array.from({ length: 400 }, (_, i) => turn('assistant', `step ${i} `.repeat(40))), turn('user', 'now fix the paypal webhook')];
const dig = digestConversation(long, 8 * 1024);
assert(dig.length <= 8 * 1024, 'the digest respects its cap', dig.length);
assert(dig.includes('feature pages') && dig.includes('paypal webhook'), 'squeezing keeps BOTH the first and the last topic of a long run');
assert(!digestConversation([{ kind: 'activity', tool: 'Bash', label: 'Ran a command', detail: 'curl /wp-json/edd/webhooks/v1/paypal', status: 'ok' }]).includes('undefined')
  && digestConversation([{ kind: 'activity', tool: 'Bash', label: 'Ran a command', detail: 'curl /wp-json/edd/webhooks/v1/paypal', status: 'ok' }]).includes('/wp-json/edd/webhooks'),
  'an action’s hint (a path, a URL) is searchable');

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // A claude-code agent, so its runs have a transcript reader (an unknown/mock runtime has none).
  aos.registerAgent({ id: 'ops', version: '1.0.0', description: 'ops', principal: 'svc-ops', policyContext: 'default@v3', runtime: 'claude-code', dir: HOME });
  const owner = aos.team.invite({ email: 'owner-test@example.com', role: 'owner' }).member;
  const alice = aos.team.invite({ email: 'alice@example.com', role: 'member' }).member;
  const bob = aos.team.invite({ email: 'bob@example.com', role: 'member' }).member;

  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-scratch');
  fs.mkdirSync(projects, { recursive: true });
  const writeTranscript = (uuid, lines) => fs.writeFileSync(path.join(projects, `${uuid}.jsonl`), lines.map((l, i) => JSON.stringify(
    l.role === 'user'
      ? { type: 'user', uuid: `${uuid}-${i}`, timestamp: new Date(1e12 + i).toISOString(), message: { role: 'user', content: l.text } }
      : { type: 'assistant', uuid: `${uuid}-${i}`, timestamp: new Date(1e12 + i).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: l.text }] } },
  )).join('\n') + '\n');

  const T0 = Date.now() - 86_400_000;
  let n = 0;
  const mkRun = (o = {}) => {
    const id = `ses_${(++n).toString(16).padStart(16, '0')}`;
    const cols = {
      id, agent: 'engineer', title: 'run ' + n, task: 'routine work', tmux: 'aos-' + id, status: 'done',
      spawned_by: null, run_as: null, claude_session_id: null, archived_at: null, secret: 's' + n,
      created_at: T0 + n * 60_000, updated_at: T0 + n * 60_000, last_activity: T0 + n * 60_000, ...o,
    };
    aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,secret,created_at,updated_at,last_activity)
      VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@secret,@created_at,@updated_at,@last_activity)`).run(cols);
    return id;
  };
  const ids = (hits) => hits.map((h) => h.session.id);

  console.log('\n\x1b[1m2) the row’s own prose — title, task, report summary\x1b[0m');
  const deploy = mkRun({ title: 'deploy the droplet' });
  const migrate = mkRun({ task: 'migrate the billing database to the new cluster' });
  const reported = mkRun();
  const sibling = mkRun({ agent: 'researcher', title: 'deploy notes for the droplet' });
  const archived = mkRun({ title: 'deploy something old', archived_at: Date.now() });
  assert(ids(tm.searchSessions({ query: 'droplet', agent: 'engineer' })).join() === deploy, 'a title word finds the run');
  assert(ids(tm.searchSessions({ query: 'deploying', agent: 'engineer' })).includes(deploy), 'stemmed: "deploying" finds "deploy"');
  assert(ids(tm.searchSessions({ query: 'billing cluster', agent: 'engineer' }))[0] === migrate, 'a seed-task word finds the run');
  // The real path: `report` writes a session.reported audit event, and the insights stamp copies its
  // summary onto the row the next time the row is listed.
  aos.audit.append({ ts: Date.now(), runId: reported, tenant: aos.tenant, principal: 'agent:engineer', type: 'session.reported', data: { outcome: 'success', summary: 'Rotated the Stripe webhook secret' } });
  tm.listSessions(undefined, undefined, [reported]);
  assert(ids(tm.searchSessions({ query: 'stripe', agent: 'engineer' })).join() === reported, 'a report summary written AFTER the row is searchable (update trigger)');
  aos.db.prepare('UPDATE term_sessions SET last_activity = ?, cost_usd = 1.5 WHERE id = ?').run(Date.now(), reported);
  assert(ids(tm.searchSessions({ query: 'stripe', agent: 'engineer' })).join() === reported, 'activity/cost writes leave the index intact');
  const own = ids(tm.searchSessions({ query: 'droplet deploy', agent: 'engineer' }));
  assert(!own.includes(sibling), 'agent scope never returns a sibling agent’s run');
  assert(!own.includes(archived), 'an archived run stays hidden');
  assert(tm.searchSessions({ query: 'droplet' }).length === 0, 'no agent and no viewer → nothing (never the whole tenant)');

  console.log('\n\x1b[1m3) what was said in the run — the transcript index\x1b[0m');
  const CONVO = '11111111-2222-3333-4444-555555555555';
  writeTranscript(CONVO, [
    { role: 'user', text: 'Build the accessible mobile menu feature pages' },
    { role: 'assistant', text: 'Built three feature pages.' },
  ]);
  const longRun = mkRun({ agent: 'ops', title: 'accessible-mobile-menu feature pages', claude_session_id: CONVO, run_as: alice.id, spawned_by: alice.id, status: 'stopped' });
  assert(tm.indexSessionText(5_000) > 0, 'the sweep indexes conversations it has not seen');
  assert(tm.searchSessions({ query: 'paypal', agent: 'ops' }).length === 0, 'nothing about PayPal yet');
  // The run continues days later on a different topic: same conversation, new activity.
  writeTranscript(CONVO, [
    { role: 'user', text: 'Build the accessible mobile menu feature pages' },
    { role: 'assistant', text: 'Built three feature pages.' },
    { role: 'user', text: 'Every PayPal IPN is failing with a 500 now, can you look?' },
    { role: 'assistant', text: 'The live PayPal client credentials were removed; restored them and the webhook retry succeeded.' },
  ]);
  aos.db.prepare('UPDATE term_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), longRun);
  tm.indexSessionText(5_000);
  const pp = tm.searchSessions({ query: 'paypal webhook', agent: 'ops' });
  assert(ids(pp).join() === longRun, 'a topic that exists ONLY in the transcript finds the run once it continues', ids(pp));
  assert(pp[0] && /«paypal»/i.test(pp[0].snippet || ''), 'with a snippet marking where it matched', pp[0] && pp[0].snippet);
  const resumed = mkRun({ agent: 'ops', title: 'poke: follow up', claude_session_id: CONVO, run_as: alice.id, spawned_by: alice.id });
  const both = ids(tm.searchSessions({ query: 'paypal', agent: 'ops' }));
  assert(both.length === 1 && (both[0] === longRun || both[0] === resumed), 'two runs of ONE conversation are one hit', both);
  tm.indexSessionText(5_000); // picks up the resumed row's conversation if it looks newer
  const before = aos.db.prepare('SELECT COUNT(*) AS c FROM session_text_fts').get().c;
  assert(tm.indexSessionText(5_000) === 0, 'a sweep with no new activity reads no transcript');
  assert(aos.db.prepare('SELECT COUNT(*) AS c FROM session_text_fts').get().c === before, 'and one conversation is one indexed row, however many runs it has');

  console.log('\n\x1b[1m4) the loopback routes — scopes, urls, session_open\x1b[0m');
  const bobRun = mkRun({ agent: 'ops', title: 'paypal refund for bob', run_as: bob.id, spawned_by: bob.id });
  const researcher = mkRun({ agent: 'researcher', title: 'strategy research', run_as: alice.id, spawned_by: alice.id, status: 'running', secret: 'caller-secret' });
  const unattended = mkRun({ agent: 'researcher', title: 'nightly digest', status: 'running', secret: 'nightly-secret' });
  const get = async (p, params, secret = 'caller-secret', session = researcher) => {
    const u = new URL(base + p);
    u.searchParams.set('session', session);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u, { headers: { 'x-aos-secret': secret } });
    return { status: r.status, body: await r.json() };
  };

  const ownScope = await get('/api/agent/sessions', { query: 'paypal' });
  assert(ownScope.status === 200 && ownScope.body.sessions.length === 0, 'default scope: the researcher has no PayPal runs of its own', ownScope.body);
  const mem = await get('/api/agent/sessions', { query: 'paypal webhook', scope: 'member' });
  const memIds = mem.body.sessions.map((s) => s.id);
  assert(memIds.includes(longRun) || memIds.includes(resumed), 'member scope finds the run its human was in, on another agent', mem.body);
  assert(!memIds.includes(bobRun), 'but never a run its human cannot see in the console (bob’s)', memIds);
  const hit = mem.body.sessions[0];
  assert(hit && hit.url === `${tm.sessionUrl(hit.id)}` && hit.url.includes(`/#/sessions/aos-${hit.id}`), 'every result carries the console url, in the routed aos- form', hit && hit.url);
  assert(hit && hit.agent === 'ops', 'and names the agent that ran it');
  const audited = aos.db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE type = 'session.searched'").get().c;
  assert(audited >= 1, 'a member-scope search is audited (session.searched)');
  const narrowed = await get('/api/agent/sessions', { scope: 'member', agent: 'researcher' });
  assert(narrowed.body.sessions.every((s) => s.agent === 'researcher') && !narrowed.body.sessions.some((s) => s.id === researcher), 'member scope + agent narrows; the calling run is excluded', narrowed.body.sessions.map((s) => s.id));
  const recent = await get('/api/agent/sessions', { scope: 'member' });
  assert(recent.body.sessions.length > 0 && !recent.body.sessions.some((s) => s.id === bobRun), 'member scope with no query lists what the human can see, newest first');
  const noHuman = await get('/api/agent/sessions', { scope: 'member', query: 'paypal' }, 'nightly-secret', unattended);
  assert(noHuman.body.error === 'no_member' && noHuman.body.sessions.length === 0, 'a run acting for nobody gets no member scope', noHuman.body);

  const open = await get('/api/agent/session', { id: `https://x.example.com/#/sessions/ses_${longRun.slice(4)}` });
  assert(open.status === 200 && open.body.meta && open.body.meta.id === longRun, 'session_open takes the broken-form URL and opens the run', open.body);
  assert(open.body.meta && open.body.meta.url && open.body.meta.agent === 'ops', 'and returns its url + agent');
  assert(aos.db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE type = 'session.opened'").get().c >= 1, 'opening another agent’s run is audited (session.opened)');
  const denied = await get('/api/agent/session', { id: bobRun });
  assert(denied.status === 403, 'session_open refuses a run the human cannot see');
  const deniedNoHuman = await get('/api/agent/session', { id: longRun }, 'nightly-secret', unattended);
  assert(deniedNoHuman.status === 403, 'and a run acting for nobody can still open only its own agent’s runs');
  const ownOpen = await get('/api/agent/session', { id: `aos-${unattended}` }, 'caller-secret', researcher);
  assert(ownOpen.status === 200, 'own-agent runs open as before (tmux-name form accepted)', ownOpen.body);
  const ownerView = aos.team.getMember(owner.id);
  assert(tm.memberCanViewSession(bobRun, ownerView) && !tm.memberCanViewSession(bobRun, alice), 'visibility is the console’s rule: owner sees all, a member sees their own');

  server.close();
  try { registry.stopAll && registry.stopAll(); } catch { /* best effort */ }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(fail ? `\nsession-search-test: ${fail} FAILED, ${pass} passed` : `\nsession-search-test: ok (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
