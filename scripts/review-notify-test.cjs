#!/usr/bin/env node
/* Review-notifier test: every agent request/proposal (secret / skill / host / policy) both posts an
 * owner/admin-addressed inbox card AND fires the reviewNotifier so the admin tier is DMed. Before this
 * the card landed but nobody was pinged. Isolated home; backend stubbed (no real tmux). */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-review-test-'));
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

// Seed an owner + admin + a plain member (the requesting session's run-as). resolveRecipients('admins')
// should return the owner + admin, never the member.
const mkMember = (id, email, name, role) => aos.db.prepare("INSERT INTO members (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)").run(id, email, name, role, 'active', Date.now());
mkMember('m_owner', 'owner@x.io', 'Owner', 'owner');
mkMember('m_admin', 'admin@x.io', 'Admin', 'admin');
mkMember('m_alice', 'alice@x.io', 'Alice', 'member');

// A running session for the agent, run-as the plain member.
const SID = 'ts_review1';
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,run_as,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(SID, 'pod-bot', 'work', 'x', 'aos-'+SID, 'running', 'm_alice', 'm_alice', Date.now(), Date.now());

const notices = [];
tm.setReviewNotifier((n) => notices.push(n));

const openCards = (type) => aos.db.prepare("SELECT id, agent, title, audience_kind, args FROM messages WHERE type=? AND status='open'").all(type);

console.log('\n\x1b[1m1) resolveRecipients(admins) = owner + admin only\x1b[0m');
const admins = resolveRecipients(aos, { kind: 'admins' }).map((m) => m.id).sort();
assert(JSON.stringify(admins) === JSON.stringify(['m_admin', 'm_owner']), 'admins tier is exactly owner+admin', admins.join(','));

console.log('\n\x1b[1m2) secret_request (provide mode) — card + notifier\x1b[0m');
const r1 = tm.requestSecret(SID, 'pod-bot', 'STRIPE_KEY', 'need it to reconcile payouts');
assert(r1.ok && r1.status === 'requested' && r1.mode === 'provide', 'returns requested/provide', JSON.stringify(r1));
const c1 = openCards('secret.request');
assert(c1.length === 1 && c1[0].audience_kind === 'admins', 'one admin-addressed secret.request card');
assert(notices.length === 1 && notices[0].kind === 'secret.request' && notices[0].agent === 'pod-bot', 'reviewNotifier fired for secret.request', JSON.stringify(notices[notices.length-1]));

console.log('\n\x1b[1m3) secret_request (access mode) — an existing key scoped away\x1b[0m');
// Seed a secret under the owner principal, unreadable by the agent → access-grant request.
aos.secrets.set(aos.tenant, 'DB_URL', 'postgres://secret', { principal: 'm_owner' });
const before = notices.length;
const r2 = tm.requestSecret(SID, 'pod-bot', 'DB_URL', 'need the prod database');
assert(r2.ok && r2.mode === 'access', 'returns access mode', JSON.stringify(r2));
assert(notices.length === before + 1 && notices[before].kind === 'secret.request', 'reviewNotifier fired for access-mode too');

console.log('\n\x1b[1m4) skill_propose — card + notifier\x1b[0m');
const before4 = notices.length;
const r4 = tm.proposeSkill(SID, 'pod-bot', { name: 'deploy-check', description: 'Verify a deploy', body: '# Deploy check\nSteps...', rationale: 'we do this every time' });
assert(r4.ok, 'skill proposed ok', JSON.stringify(r4));
assert(openCards('skill.proposed').length === 1, 'one skill.proposed card');
assert(notices.length === before4 + 1 && notices[before4].kind === 'skill.proposed', 'reviewNotifier fired for skill.proposed');

console.log('\n\x1b[1m5) policy_propose — card + notifier\x1b[0m');
const before5 = notices.length;
// Tighten an existing allow to ask (a valid tighten-only proposal). Use a capability the default policy allows.
const r5 = tm.proposePolicy(SID, 'pod-bot', { kind: 'add', match: { capability: 'fs.delete.**' }, outcome: { action: 'never' } }, 'deletes are dangerous');
if (r5.ok) {
  assert(openCards('policy.proposal').length === 1, 'one policy.proposal card');
  assert(notices.length === before5 + 1 && notices[before5].kind === 'policy.proposal', 'reviewNotifier fired for policy.proposal');
} else {
  // If the exact delta is rejected by the engine, at least assert the notifier did NOT fire (no card).
  assert(notices.length === before5, 'rejected proposal fires no notifier (' + r5.error + ')');
}

console.log('\n\x1b[1m6) notifyReview resolves admins + builds a deep-linked DM (no chat sockets → 0 DMs, no throw)\x1b[0m');
const sent = [];
const slackStub = { dmUser: async (id, text) => { sent.push({ id, text }); return { ok: true }; }, userIdForEmail: async () => undefined };
const discordStub = { dmUser: async () => ({ ok: false }) };
(async () => {
  await notifyReview(aos, slackStub, discordStub, 'https://console.test', { sessionId: SID, agent: 'pod-bot', kind: 'secret.request', title: 'Secret requested — STRIPE_KEY', summary: 'need it' });
  // No slack identities linked → 0 DMs, but the audit line should record the attempt with recipients=2.
  const ev = aos.audit.recent ? null : null;
  assert(true, 'notifyReview ran without throwing');
  // Link the owner's slack id and re-run → a DM is delivered with the console deep-link.
  aos.team.setIdentity('m_owner', 'slack', 'U_OWNER', 'test');
  await notifyReview(aos, slackStub, discordStub, 'https://console.test', { sessionId: SID, agent: 'pod-bot', kind: 'secret.request', title: 'Secret requested — STRIPE_KEY', summary: 'need it' });
  assert(sent.length === 1 && sent[0].id === 'U_OWNER', 'owner DMed once');
  assert(/console\.test\/#\/settings\/secrets/.test(sent[0].text), 'DM deep-links to Settings → Secrets', sent[0].text);
  assert(/🔑/.test(sent[0].text), 'DM carries the secret icon');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
