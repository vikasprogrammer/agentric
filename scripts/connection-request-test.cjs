#!/usr/bin/env node
/* connection_request test: an agent asks a human to connect a Composio app. Verifies the store spine —
 * personal (default) is addressed to the run's OWN member; company is addressed to the admin tier; dedupe
 * per toolkit+scope; the open-list is member-scoped for non-admins; status resolves; and notifyReview
 * honours a per-member audience (personal → the member, not admins). Isolated home; backend stubbed. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-conn-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { resolveRecipients } = require(path.join(ROOT, 'dist/governance/recipients.js'));
const { notifyReview } = require(path.join(ROOT, 'dist/tenant-registry.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
tm.backend.aliveNames = () => new Set();
tm.backend.kill = () => {}; tm.backend.hasClient = () => false;
tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;

const mkMember = (id, email, name, role) => aos.db.prepare("INSERT INTO members (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)").run(id, email, name, role, 'active', Date.now());
mkMember('m_owner', 'owner@x.io', 'Owner', 'owner');
mkMember('m_admin', 'admin@x.io', 'Admin', 'admin');
mkMember('m_alice', 'alice@x.io', 'Alice', 'member');

const SID = 'ts_conn1';
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(SID, 'pod-bot', 'work', 'x', 'aos-'+SID, 'running', 'm_alice', 'm_alice', Date.now(), Date.now());

const notices = [];
tm.setReviewNotifier((n) => notices.push(n));
const openCards = () => aos.db.prepare("SELECT id, agent, title, audience_kind, audience_id, args FROM messages WHERE type='connection.request' AND status='open'").all();

console.log('\n\x1b[1m1) personal request (default) → member-addressed card + notifier\x1b[0m');
const r1 = tm.requestConnection(SID, 'pod-bot', { toolkit: 'gmail', scope: 'personal', member: 'm_alice', reasoning: 'read my inbox' });
assert(r1.ok && r1.status === 'requested', 'returns requested', JSON.stringify(r1));
const c1 = openCards();
assert(c1.length === 1 && c1[0].audience_kind === 'member' && c1[0].audience_id === 'm_alice', 'one member-addressed card for m_alice', JSON.stringify(c1[0]));
assert(JSON.parse(c1[0].args).toolkit === 'gmail' && JSON.parse(c1[0].args).scope === 'personal', 'args carry toolkit+scope');
assert(notices.length === 1 && notices[0].kind === 'connection.request' && notices[0].audience && notices[0].audience.kind === 'member' && notices[0].audience.id === 'm_alice', 'notifier carries member audience', JSON.stringify(notices[0] && notices[0].audience));

console.log('\n\x1b[1m2) dedupe — same toolkit+scope+agent while open\x1b[0m');
const r2 = tm.requestConnection(SID, 'pod-bot', { toolkit: 'gmail', scope: 'personal', member: 'm_alice' });
assert(r2.ok && r2.status === 'duplicate', 'second identical request is a duplicate', JSON.stringify(r2));
assert(openCards().length === 1, 'still one open card');

console.log('\n\x1b[1m3) company request → admin-addressed card\x1b[0m');
const r3 = tm.requestConnection(SID, 'pod-bot', { toolkit: 'slack', scope: 'company', reasoning: 'shared team slack' });
assert(r3.ok && r3.status === 'requested', 'company request ok', JSON.stringify(r3));
const company = openCards().find((c) => JSON.parse(c.args).scope === 'company');
assert(company && company.audience_kind === 'admins' && !company.audience_id, 'company card addressed to admins tier', JSON.stringify(company));

console.log('\n\x1b[1m4) a different scope for the same toolkit is NOT a duplicate\x1b[0m');
const r4 = tm.requestConnection(SID, 'pod-bot', { toolkit: 'gmail', scope: 'company' });
assert(r4.ok && r4.status === 'requested', 'gmail@company is a fresh request alongside gmail@personal', JSON.stringify(r4));

console.log('\n\x1b[1m5) openConnectionRequests scoping — admin sees all, member sees only own personal\x1b[0m');
const all = tm.openConnectionRequests();
assert(all.length === 3, 'admin (no filter) sees all 3 open', 'got ' + all.length);
const mine = tm.openConnectionRequests('m_alice');
assert(mine.length === 1 && mine[0].toolkit === 'gmail' && mine[0].scope === 'personal', "m_alice sees only her personal gmail request", JSON.stringify(mine.map((r) => r.toolkit + '/' + r.scope)));
const bob = tm.openConnectionRequests('m_owner');
assert(bob.length === 0, 'a member with no personal requests sees none');

console.log('\n\x1b[1m6) connectionRequestCard round-trip + resolve\x1b[0m');
const card = tm.connectionRequestCard(c1[0].id);
assert(card && card.toolkit === 'gmail' && card.scope === 'personal' && card.member === 'm_alice' && card.status === 'open', 'card reads back its payload', JSON.stringify(card));
tm.setConnectionRequestStatus(c1[0].id, 'fulfilled');
assert(tm.connectionRequestCard(c1[0].id).status === 'fulfilled', 'status flips to fulfilled');
assert(tm.openConnectionRequests('m_alice').length === 0, 'resolved card drops out of the open list');
// A resolved request no longer dedupes → the agent can re-ask.
const r6 = tm.requestConnection(SID, 'pod-bot', { toolkit: 'gmail', scope: 'personal', member: 'm_alice' });
assert(r6.ok && r6.status === 'requested', 're-request after resolution is allowed', JSON.stringify(r6));

console.log('\n\x1b[1m7) notifyReview honours a personal audience — DMs the member, not admins\x1b[0m');
const sent = [];
const slackStub = { dmUser: async (id, text) => { sent.push({ id, text }); return { ok: true }; }, userIdForEmail: async () => undefined };
const discordStub = { dmUser: async () => ({ ok: false }) };
(async () => {
  aos.team.setIdentity('m_alice', 'slack', 'U_ALICE', 'test');
  aos.team.setIdentity('m_owner', 'slack', 'U_OWNER', 'test');
  await notifyReview(aos, slackStub, discordStub, 'https://console.test',
    { sessionId: SID, agent: 'pod-bot', kind: 'connection.request', title: 'Connection requested — gmail (personal)', summary: 'read my inbox', audience: { kind: 'member', id: 'm_alice' } });
  assert(sent.length === 1 && sent[0].id === 'U_ALICE', 'personal request DMs the member (m_alice), not the admins', JSON.stringify(sent.map((s) => s.id)));
  assert(/console\.test\/#\/connectors/.test(sent[0].text), 'DM deep-links to Connections', sent[0].text);
  assert(/🔌/.test(sent[0].text), 'DM carries the connection icon');
  // A company request (no audience override) falls back to the admin tier.
  sent.length = 0;
  await notifyReview(aos, slackStub, discordStub, 'https://console.test',
    { sessionId: SID, agent: 'pod-bot', kind: 'connection.request', title: 'Connection requested — slack (company)', summary: 'shared', audience: { kind: 'admins' } });
  assert(sent.length === 1 && sent[0].id === 'U_OWNER', 'company request DMs the admin tier (owner)', JSON.stringify(sent.map((s) => s.id)));

  const adminsTier = resolveRecipients(aos, { kind: 'admins' }).map((m) => m.id).sort();
  assert(!adminsTier.includes('m_alice'), 'the plain member is never in the admins tier');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
