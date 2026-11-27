#!/usr/bin/env node
/* DM reply targeting on Slack and Telegram — the same fix dm-reply-target-test.cjs pins for Discord.
 *
 * A reply that POINTS AT one of our notifications goes to what that notification was about, not to
 * whatever we pinged the person about most recently. Each platform names the message its own way:
 *   - Slack: the reply is threaded UNDER the notification (`thread_ts` = its `ts`);
 *   - Telegram: swipe-to-reply (`reply_to_message.message_id`), keyed with the chat id because Telegram
 *     message ids are only unique within a chat.
 * The questions here are sent through the REAL notifier (`notifyQuestionAsked` → `deliverDM`), so the
 * test also pins that a notification is recorded at all — on Telegram that lane posts without a socket.
 *
 * Isolated home; fetch, deliver/revive and the router are stubbed so no tmux, claude or network is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chatdmreply-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { SlackSocket } = require(path.join(ROOT, 'dist/edge/slack-socket.js'));
const { TelegramSocket } = require(path.join(ROOT, 'dist/edge/telegram-socket.js'));
const { notifyQuestionAsked } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { parseSlackEvent } = require(path.join(ROOT, 'dist/connectors/slack.js'));
const { parseTelegramUpdate } = require(path.join(ROOT, 'dist/connectors/telegram.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
const slack = new SlackSocket(aos, autos);
const telegram = new TelegramSocket(aos, autos);
telegram.botId = '999';
const noDiscord = { dmUser: async () => ({ ok: false, error: 'off' }) };

// Both REST APIs, stubbed. Every post gets a fresh id and is logged with where it went.
let nextMsg = 1000;
const posted = [];
global.fetch = async (url, init) => {
  const u = String(url);
  const body = init && init.body ? JSON.parse(init.body) : {};
  if (u.includes('conversations.open')) return { ok: true, json: async () => ({ ok: true, channel: { id: 'DM_' + body.users } }) };
  if (u.includes('chat.postMessage')) {
    const ts = `17000${++nextMsg}.000100`;
    posted.push({ platform: 'slack', id: ts, content: body.text, thread: body.thread_ts || '' });
    return { ok: true, json: async () => ({ ok: true, ts }) };
  }
  if (u.includes('/sendMessage')) {
    const id = ++nextMsg;
    posted.push({ platform: 'telegram', id: String(id), content: body.text, chat: String(body.chat_id) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: id } }) };
  }
  return { ok: true, json: async () => ({ ok: true, messages: [] }) };
};

let live = new Set();
const delivered = [];
tm.deliverToResident = (id, text) => live.has(id) ? (delivered.push({ id, text }), true) : false;
tm.reviveResident = () => false;
const routed = [];
const router = (platform) => async (event, runAs, opts = {}) => { routed.push({ platform, text: event.text, fallbackAgent: opts.fallbackAgent }); return { fired: 0, sessions: [], agents: [] }; };
autos.fireSlack = router('slack');
autos.fireTelegram = router('telegram');

const { member } = aos.team.invite({ email: 'owner@testco.dev', role: 'owner' });
aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
for (const a of ['alpha', 'beta']) aos.agents.set(a, { id: a, name: a, dir: HOME, runtime: 'claude-code' });

let n = 0;
const mkSession = (agent, o = {}) => {
  const id = 'ts_' + (++n);
  const cols = {
    id, agent, title: 't', task: 'x', tmux: 'aos-' + id, status: 'running', spawned_by: member.id, run_as: member.id,
    claude_session_id: 'cs_' + id, archived_at: null, created_at: Date.now(), updated_at: Date.now(), ...o,
  };
  aos.db.prepare('INSERT INTO term_sessions (id,agent,title,task,tmux,status,spawned_by,run_as,claude_session_id,archived_at,created_at,updated_at) VALUES (@id,@agent,@title,@task,@tmux,@status,@spawned_by,@run_as,@claude_session_id,@archived_at,@created_at,@updated_at)').run(cols);
  return id;
};
const q = (id) => aos.db.prepare('SELECT status, answer FROM questions WHERE id = ?').get(id);
const approval = (id) => aos.db.prepare('SELECT status FROM approvals WHERE id = ?').get(id);

// One driver per platform: how a human's DM arrives, what a message key looks like, how the socket acks.
let mid = 0;
const PLATFORMS = {
  slack: {
    user: 'S_OWNER',
    key: (id) => id,
    setup: () => { aos.settings.setSlackBotToken('xoxb-test'); aos.team.setIdentity(member.id, 'slack', 'S_OWNER'); },
    teardown: () => { aos.settings.setSlackBotToken(''); aos.team.removeIdentity?.(member.id, 'slack'); },
    dm: async (text, replyTo) => {
      const ts = `18000${++mid}.000200`;
      await slack.dispatch({ payload: { event: {
        type: 'message', channel: 'DM_S_OWNER', channel_type: 'im', user: 'S_OWNER', text, ts,
        ...(replyTo ? { thread_ts: replyTo } : {}),
      } } });
      await tick();
    },
    agentSaid: (sid) => { const ts = '17999.000300'; tm.noteSlackThread(sid, 'DM_S_OWNER', ts); return ts; },
  },
  telegram: {
    user: '4242',
    key: (id) => `4242:${id}`,
    setup: () => { aos.settings.setTelegramBotToken('tg-test'); aos.team.setIdentity(member.id, 'telegram', '4242'); },
    teardown: () => {},
    dm: async (text, replyTo) => {
      await telegram.dispatch({ message: {
        message_id: 50000 + (++mid), chat: { id: 4242, type: 'private' }, from: { id: 4242, username: 'owner' }, text,
        ...(replyTo ? { reply_to_message: { message_id: Number(replyTo), from: { id: 999, is_bot: true } } } : {}),
      } });
      await tick();
    },
    // The agent's own `telegram_reply` is recorded by the socket; simulate the row it writes.
    agentSaid: (sid) => { tm.noteDm('telegram', '4242:77777', '4242', { kind: 'session', sessionId: sid }); return '77777'; },
  },
};

async function run(platform) {
  const P = PLATFORMS[platform];
  P.setup();
  const sockets = [platform === 'slack' ? slack : { dmUser: async () => ({ ok: false }), userIdForEmail: async () => null }, noDiscord];
  const last = () => posted.filter((p) => p.platform === platform).pop();
  // The real question notifier: DM → record what it was about → bind the recipient.
  const ask = async (sid, agent, prompt) => {
    const { id } = tm.askQuestion(sid, agent, prompt);
    await notifyQuestionAsked(aos, tm, sockets[0], sockets[1], 'http://console.test', { questionId: id, sessionId: sid, agent, prompt });
    return { id, msg: last().id };
  };
  const noteSession = (sid, msgId) => {
    tm.bindSessionDm(sid, platform, P.user, member.id);
    tm.noteDm(platform, P.key(msgId), P.user, { kind: 'session', sessionId: sid });
  };

  console.log(`\n\x1b[1m[${platform}] 1) two agents ask; the reply names which one\x1b[0m`);
  const sA = mkSession('alpha'), sB = mkSession('beta');
  const qA = await ask(sA, 'alpha', 'Which env?');
  await tick();
  const qB = await ask(sB, 'beta', 'Which region?');   // newer → what recipient-keyed routing always picks
  assert(qA.msg !== qB.msg && tm.dmReplyTarget(platform, P.user, 'DM_' + P.user, P.key(qA.msg))?.id === qA.id, 'the notifier recorded which message carried which question');
  await P.dm('staging', qA.msg);
  assert(q(qA.id).status === 'answered' && q(qA.id).answer === 'staging', 'replying to alpha\'s question answers ALPHA');
  assert(q(qB.id).status === 'pending', '…and beta\'s newer question is untouched');
  await P.dm('eu-west');
  assert(q(qB.id).answer === 'eu-west', 'a plain DM keeps the old behaviour: the newest pending question');

  console.log(`\n\x1b[1m[${platform}] 2) a reply to a run notice is not swallowed by a pending question\x1b[0m`);
  const sC = mkSession('alpha'), sD = mkSession('beta');
  noteSession(sC, '31001');
  const qD = await ask(sD, 'beta', 'Ship it?');
  live.add(sC);
  await P.dm('now do the other half', '31001');
  assert(delivered[delivered.length - 1]?.id === sC && delivered[delivered.length - 1].text === 'now do the other half', 'the reply reaches the run the notice was about');
  assert(q(qD.id).status === 'pending', '…beta\'s pending question was NOT answered with it');
  const ack = last();
  assert(/Sent to \*?alpha/.test(ack.content), 'the "Sent to alpha" ack was posted');
  if (platform === 'slack') assert(ack.thread === '31001', '…inside the thread the human replied in');

  console.log(`\n\x1b[1m[${platform}] 3) two run notices: the older one is still reachable\x1b[0m`);
  const sE = mkSession('alpha'), sF = mkSession('beta');
  noteSession(sE, '31002');
  await tick();
  noteSession(sF, '31003');
  live.add(sE); live.add(sF);
  await P.dm('retry it', '31002');
  assert(delivered[delivered.length - 1].id === sE, 'replying to the OLDER notice goes to its run, not the newest');
  aos.db.prepare('UPDATE session_dms SET created_at = ? WHERE session_id = ?').run(Date.now() - 48 * 3600_000, sE);
  await P.dm('and again', '31002');
  assert(delivered[delivered.length - 1].id === sE, 'an explicit reply ignores the 24h staleness window');
  const said = P.agentSaid(sF);
  await P.dm('thanks, also check logs', said);
  if (platform === 'telegram') assert(delivered[delivered.length - 1].id === sF, 'replying to something the agent itself said reaches that agent\'s run');
  else assert(tm.dmReplyTarget('slack', P.user, 'DM_S_OWNER', said)?.sessionId === sF, 'a thread under something the agent itself said resolves to that agent\'s run');

  console.log(`\n\x1b[1m[${platform}] 4) approvals\x1b[0m`);
  const mkApproval = (sid, cap, msgId) => {
    const id = aos.approvals.request({ runId: sid, tenant: aos.tenant, level: 'owner', reason: 'r', attempt: { capabilityId: cap, args: {}, reasoning: 'r' } }).req.id;
    tm.bindApprovalDm(id, platform, P.user, member.id);
    tm.noteDm(platform, P.key(msgId), P.user, { kind: 'approval', id, sessionId: sid });
    return id;
  };
  const sG = mkSession('alpha'), sH = mkSession('beta');
  const a1 = mkApproval(sG, 'shell.exec', '31004');
  await tick();
  const a2 = mkApproval(sH, 'net.fetch', '31005');
  await P.dm('approve', '31004');
  assert(approval(a1).status === 'approved' && approval(a2).status === 'pending', 'replying "approve" to the older request approves THAT one only');
  const before = posted.length;
  await P.dm('looks good, continue', '31002');
  assert(approval(a2).status === 'pending' && delivered[delivered.length - 1].text === 'looks good, continue', 'a reply to a run notice is not read as a yes/no for a pending approval');
  assert(!posted.slice(before).some((p) => /couldn't tell/.test(p.content)), '…and gets no "reply approve or deny" nag');
  live.add(sG);
  await P.dm('why did you need that?', '31004');
  assert(delivered[delivered.length - 1].id === sG, 'replying to an already-decided approval talks to the run that raised it');

  console.log(`\n\x1b[1m[${platform}] 5) nothing actionable behind the message\x1b[0m`);
  const sDead = mkSession('beta', { claude_session_id: null });
  tm.noteDm(platform, P.key('31006'), P.user, { kind: 'session', sessionId: sDead });
  let dBefore = delivered.length;
  await P.dm('you there?', '31006');
  assert(delivered.length === dBefore, 'an unresumable run is not continued, and no OTHER run is guessed');
  assert(routed[routed.length - 1].platform === platform && routed[routed.length - 1].fallbackAgent === 'beta', 'the request starts fresh with the SAME agent');
  tm.noteDm(platform, P.key('31007'), P.user);   // a bare notice (insight alert, overdue task)
  dBefore = delivered.length;
  await P.dm('what does this mean?', '31007');
  assert(delivered.length === dBefore && q(qD.id).status === 'pending' && approval(a2).status === 'pending', 'a reply to an agent-less notice touches no run, question or approval');
  assert(routed[routed.length - 1].text === 'what does this mean?' && !routed[routed.length - 1].fallbackAgent, '…it goes to the router');

  console.log(`\n\x1b[1m[${platform}] 6) the reference only counts for the person we sent it to\x1b[0m`);
  assert(tm.dmReplyTarget(platform, 'SOMEONE_ELSE', 'DM_X', P.key(qD.msg)) === undefined, 'another user pointing at our message resolves nothing');
  assert(tm.dmReplyTarget(platform, P.user, 'DM_' + P.user, P.key('404')) === undefined, 'an unknown message keeps the old recipient-keyed routing');

  // Leave nothing pending for the next platform's "newest pending" assertions.
  aos.db.prepare("UPDATE questions SET status='answered' WHERE status='pending'").run();
  aos.db.prepare("UPDATE approvals SET status='rejected' WHERE status='pending'").run();
  live = new Set();
}

(async () => {
  console.log('\n\x1b[1m0) what each platform\'s reply carries\x1b[0m');
  const s = (e) => parseSlackEvent({ payload: { event: { type: 'message', channel: 'D1', user: 'U1', text: 'x', ...e } } });
  assert(s({ ts: '5.1' }).replyToTs === '' && s({ ts: '5.1', thread_ts: '5.1' }).replyToTs === '', 'slack: a top-level message (or a thread root) points at nothing');
  assert(s({ ts: '5.2', thread_ts: '5.1' }).replyToTs === '5.1', 'slack: a threaded reply points at the thread root');
  const t = (m) => parseTelegramUpdate({ message: { message_id: 9, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'x', ...m } }, '999', 'bot');
  assert(t({ reply_to_message: { message_id: 7, from: { id: 999 } } }).replyToId === '7', 'telegram: a reply to OUR message points at it');
  assert(t({ reply_to_message: { message_id: 7, from: { id: 1 } } }).replyToId === '' && t({}).replyToId === '', 'telegram: a reply to someone else\'s message, or no reply, points at nothing');

  await run('slack');
  await run('telegram');

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}CHAT DM REPLY TARGET: ${pass}/${pass + fail} passed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
