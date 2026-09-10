#!/usr/bin/env node
/* Telegram DM lane test.
 *
 * Telegram was a first-class INGRESS (its own socket, its own identity-map provider, and inbound
 * handlers that already accepted 'telegram' for approvals/questions/session-continuation) but not a
 * DELIVERY lane: `deliverDM` sent only to Slack + Discord and `bindDmRecipients` bound only those two.
 * So a member reachable ONLY on Telegram got every push silently dropped, and — worse — could never
 * resolve an approval by replying, because no approval_dms row was ever written for them.
 *
 * Pins both halves, plus the property that made this cheap: outbound Telegram takes no socket, so the
 * lane lights up in every notifier at once rather than being threaded through twelve signatures.
 * Isolated home; `fetch` stubbed so nothing leaves the box. */
const fs = require('fs'); const osMod = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(osMod.tmpdir(), 'aos-tg-dm-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { notifyLoginLink, notifyApprovers } = require(path.join(ROOT, 'dist/tenant-registry.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
tm.backend.aliveNames = () => new Set();
tm.backend.kill = () => {}; tm.backend.hasClient = () => false;
tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;

// Stub Telegram's wire. `sendMessage` is a bare fetch to api.telegram.org, so intercepting fetch is the
// whole seam — no socket, no polling loop.
const tgCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    tgCalls.push({ url: u, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1000 + tgCalls.length } }) };
  }
  return realFetch(url, init);
};

// Slack/Discord stubs: record what they'd send, and never auto-link (no email lookup hit).
const slackSent = [], discordSent = [];
const slackStub = { dmUser: async (id, text) => (slackSent.push({ id, text }), { ok: true }), userIdForEmail: async () => null };
const discordStub = { dmUser: async (id, text) => (discordSent.push({ id, text }), { ok: true }) };

const mkMember = (id, email, name, role) => aos.db.prepare("INSERT INTO members (id,email,name,role,status,created_at) VALUES (?,?,?,?,?,?)").run(id, email, name, role, 'active', Date.now());
mkMember('m_owner', 'owner@x.io', 'Owner', 'owner');
mkMember('m_tina', 'tina@x.io', 'Tina', 'admin');
// Tina is reachable ONLY on Telegram — the member the old code dropped every push for.
aos.team.setIdentity('m_tina', 'telegram', '778899', 'test');
// The owner is on Slack, so a mixed audience proves the lanes are additive, not either/or.
aos.team.setIdentity('m_owner', 'slack', 'U_OWNER', 'test');

(async () => {
  console.log('\n\x1b[1m1) no bot token → Telegram lane is a silent no-op\x1b[0m');
  let dms = await notifyLoginLink(aos, slackStub, discordStub, aos.team.getMember('m_tina'), 'https://console.test/accept?token=abc');
  assert(dms === 0, 'unconfigured Telegram delivers nothing', String(dms));
  assert(tgCalls.length === 0, 'and never touches the wire', String(tgCalls.length));

  console.log('\n\x1b[1m2) sign-in link reaches a Telegram-only member\x1b[0m');
  aos.settings.setTelegramBotToken('123:TESTTOKEN', 'test');
  dms = await notifyLoginLink(aos, slackStub, discordStub, aos.team.getMember('m_tina'), 'https://console.test/accept?token=abc');
  assert(dms === 1, 'one DM delivered', String(dms));
  assert(tgCalls.length === 1 && tgCalls[0].body.chat_id === '778899', 'sent to the identity-map chat id', JSON.stringify(tgCalls[0] && tgCalls[0].body));
  assert(!!tgCalls[0] && /accept\?token=abc/.test(tgCalls[0].body.text), 'carrying the sign-in link', tgCalls[0] && tgCalls[0].body.text);
  assert(slackSent.length === 0 && discordSent.length === 0, 'and not misrouted to the other lanes');
  // The token embeds in the URL path — assert we never log it anywhere the audit can see.
  const auditRow = aos.db.prepare("SELECT data FROM audit_events WHERE type='auth.link.notified' ORDER BY ts DESC LIMIT 1").get();
  assert(auditRow && !/TESTTOKEN/.test(auditRow.data), 'the bot token never lands in the audit row', auditRow && auditRow.data);

  console.log('\n\x1b[1m3) lanes are additive across a mixed audience\x1b[0m');
  tgCalls.length = 0; slackSent.length = 0;
  const s = tm.createSession('pod-bot', 'work', 'task');
  await notifyApprovers(aos, tm, slackStub, discordStub, 'https://console.test', {
    approvalId: 'ap_1', sessionId: s.id, agent: 'pod-bot', capability: 'email.send', level: 'head', riskClass: 'yellow', reason: 'external mail',
  });
  assert(tgCalls.length === 1 && tgCalls[0].body.chat_id === '778899', 'the Telegram-only approver is DMed', String(tgCalls.length));
  assert(slackSent.length === 1 && slackSent[0].id === 'U_OWNER', 'the Slack approver still is too', String(slackSent.length));
  // Telegram messages go out with no parse_mode, so the deep-link must be plain, never Slack's <url|label>.
  assert(!!tgCalls[0] && !/<https?:/.test(tgCalls[0].body.text) && /console\.test/.test(tgCalls[0].body.text),
    'rendered with the telegram (plain-text) link syntax', tgCalls[0] && tgCalls[0].body.text);

  console.log('\n\x1b[1m4) the DM is BOUND, so "approve" by reply resolves it\x1b[0m');
  const bound = aos.db.prepare("SELECT provider, external_id, member_id FROM approval_dms WHERE approval_id='ap_1' ORDER BY provider").all();
  const providers = bound.map((b) => b.provider);
  assert(providers.includes('telegram'), 'a telegram approval_dms row exists', JSON.stringify(providers));
  const tg = bound.find((b) => b.provider === 'telegram');
  assert(tg && tg.external_id === '778899' && tg.member_id === 'm_tina', 'keyed on the telegram user id + member', JSON.stringify(tg));

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
