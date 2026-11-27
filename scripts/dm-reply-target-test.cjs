#!/usr/bin/env node
/* DM reply targeting — a reply that POINTS AT one of our notifications goes to what that notification
 * was about, not to whatever we pinged the person about most recently.
 *
 * The four DM lanes (approval / question / blocked task / run notice) each match on the SENDER alone and
 * are tried in a fixed order. With two agents pinging one human that produced two wrong-agent failures:
 *   - a reply to agent A's notice was delivered to agent B, because B pinged later;
 *   - a reply to a "run finished" notice was swallowed as the ANSWER to an unrelated pending question,
 *     because the question lane runs first.
 * Discord's reply arrow carries `message_reference.message_id`; every DM we send is recorded in `dm_refs`
 * with what it was about, and a referenced reply runs ONLY that lane, pinned to that target.
 *
 * Isolated home; fetch, deliver/revive and the router are stubbed so no tmux, claude or network is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dmreply-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { DiscordSocket } = require(path.join(ROOT, 'dist/edge/discord-socket.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
const socket = new DiscordSocket(aos, autos);
aos.settings.setDiscordBotToken('test-token');

// Discord REST, stubbed: opening a DM returns the user's DM channel, every post gets a fresh message id.
let nextMsg = 1000;
const posted = [];
global.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : {};
  if (String(url).endsWith('/users/@me/channels')) return { ok: true, json: async () => ({ id: 'DM_' + body.recipient_id }) };
  const id = 'BOT' + (++nextMsg);
  posted.push({ id, content: body.content });
  return { ok: true, json: async () => ({ id }) };
};

let live = new Set();
const delivered = [];
tm.deliverToResident = (id, text) => live.has(id) ? (delivered.push({ id, text }), true) : false;
tm.reviveResident = () => false;
const routed = [];
autos.fireDiscord = async (event, runAs, opts = {}) => { routed.push({ text: event.text, fallbackAgent: opts.fallbackAgent }); return { fired: 0, sessions: [], agents: [] }; };

const { member } = aos.team.invite({ email: 'owner@testco.dev', role: 'owner' });
aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
aos.team.setIdentity(member.id, 'discord', 'D_OWNER');
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
let mid = 0;
// The socket's acks are fire-and-forget; let them post (and be recorded) before the next message, as
// they always have by the time a human types a reply.
const dm = async (text, replyTo) => {
  await socket.dispatch({
    id: 'U' + (++mid), channel_id: 'DM_D_OWNER', author: { id: 'D_OWNER', username: 'owner' }, content: text,
    ...(replyTo ? { message_reference: { message_id: replyTo } } : {}),
  });
  await new Promise((r) => setTimeout(r, 5));
};
// What the notifiers do after DMing: bind the recipient (old key) AND record the message (new key).
const notifyQuestion = (sid, agent, prompt, msgId) => {
  const { id } = tm.askQuestion(sid, agent, prompt);
  tm.bindQuestionDm(id, 'discord', 'D_OWNER', member.id);
  tm.noteDm('discord', msgId, 'D_OWNER', { kind: 'question', id, sessionId: sid });
  return id;
};
const notifySession = (sid, msgId) => {
  tm.bindSessionDm(sid, 'discord', 'D_OWNER', member.id);
  tm.noteDm('discord', msgId, 'D_OWNER', { kind: 'session', sessionId: sid });
};

(async () => {
  console.log('\n\x1b[1m1) two agents ask; the reply names which one\x1b[0m');
  const sA = mkSession('alpha'), sB = mkSession('beta');
  const qA = notifyQuestion(sA, 'alpha', 'Which env?', 'N_QA');
  await new Promise((r) => setTimeout(r, 5));
  const qB = notifyQuestion(sB, 'beta', 'Which region?', 'N_QB');   // newer → what the old code always picked
  await dm('staging', 'N_QA');
  assert(q(qA).status === 'answered' && q(qA).answer === 'staging', 'replying to alpha\'s question answers ALPHA');
  assert(q(qB).status === 'pending', '…and beta\'s newer question is untouched');
  await dm('eu-west');
  assert(q(qB).answer === 'eu-west', 'a plain (unreferenced) DM keeps the old behaviour: the newest pending question');

  console.log('\n\x1b[1m2) a reply to a run notice is not swallowed by a pending question\x1b[0m');
  const sC = mkSession('alpha'), sD = mkSession('beta');
  notifySession(sC, 'N_DONE');                       // "alpha finished" notice
  const qD = notifyQuestion(sD, 'beta', 'Ship it?', 'N_QD');
  live.add(sC);
  await dm('now do the other half', 'N_DONE');
  assert(delivered.length === 1 && delivered[0].id === sC && delivered[0].text === 'now do the other half', 'the reply reaches the run the notice was about');
  assert(q(qD).status === 'pending', '…beta\'s pending question was NOT answered with it');

  console.log('\n\x1b[1m3) two run notices: the older one is still reachable\x1b[0m');
  const sE = mkSession('alpha'), sF = mkSession('beta');
  notifySession(sE, 'N_E');
  await new Promise((r) => setTimeout(r, 5));
  notifySession(sF, 'N_F');
  live.add(sE); live.add(sF);
  await dm('retry it', 'N_E');
  assert(delivered[delivered.length - 1].id === sE, 'replying to the OLDER notice goes to its run, not the newest');
  aos.db.prepare('UPDATE session_dms SET created_at = ? WHERE session_id = ?').run(Date.now() - 48 * 3600_000, sE);
  await dm('and again', 'N_E');
  assert(delivered[delivered.length - 1].id === sE, 'an explicit reply ignores the 24h staleness window');

  console.log('\n\x1b[1m4) the ack and the agent\'s own messages are reply targets too\x1b[0m');
  const ack = posted.filter((p) => /Sent to \*\*alpha\*\*/.test(p.content)).pop();
  assert(!!ack, 'the "Sent to alpha" ack was posted');
  await dm('one more thing', ack.id);
  assert(delivered[delivered.length - 1].id === sE && delivered[delivered.length - 1].text === 'one more thing', 'replying to the ack keeps talking to the same run');
  tm.noteDiscordMessage(sF, 'DM_D_OWNER', 'AGENT_SAID');   // beta's discord_reply posted into the DM
  await dm('thanks, also check logs', 'AGENT_SAID');
  assert(delivered[delivered.length - 1].id === sF, 'replying to something the agent itself said reaches that agent\'s run');

  console.log('\n\x1b[1m5) approvals\x1b[0m');
  const mkApproval = (sid, cap) => aos.approvals.request({
    runId: sid, tenant: aos.tenant, level: 'owner', reason: 'r',
    attempt: { capabilityId: cap, args: {}, reasoning: 'r' },
  }).req.id;
  const sG = mkSession('alpha'), sH = mkSession('beta');
  const a1 = mkApproval(sG, 'shell.exec'); tm.bindApprovalDm(a1, 'discord', 'D_OWNER', member.id);
  tm.noteDm('discord', 'N_A1', 'D_OWNER', { kind: 'approval', id: a1, sessionId: sG });
  await new Promise((r) => setTimeout(r, 5));
  const a2 = mkApproval(sH, 'net.fetch'); tm.bindApprovalDm(a2, 'discord', 'D_OWNER', member.id);
  tm.noteDm('discord', 'N_A2', 'D_OWNER', { kind: 'approval', id: a2, sessionId: sH });
  await dm('approve', 'N_A1');
  assert(approval(a1).status === 'approved' && approval(a2).status === 'pending', 'replying "approve" to the older request approves THAT one only');
  // A reply to a run notice while an approval is pending is chat for that run, not an unclear decision.
  const before = posted.length;
  await dm('looks good, continue', 'N_E');
  assert(approval(a2).status === 'pending' && delivered[delivered.length - 1].text === 'looks good, continue', 'a reply to a run notice is not read as a yes/no for a pending approval');
  assert(!posted.slice(before).some((p) => /couldn't tell/.test(p.content)), '…and gets no "reply approve or deny" nag');
  // A settled approval's DM now leads to the run behind it.
  live.add(sG);
  await dm('why did you need that?', 'N_A1');
  assert(delivered[delivered.length - 1].id === sG, 'replying to an already-decided approval talks to the run that raised it');

  console.log('\n\x1b[1m6) nothing actionable behind the message\x1b[0m');
  const sDead = mkSession('beta', { claude_session_id: null });
  tm.noteDm('discord', 'N_DEAD', 'D_OWNER', { kind: 'session', sessionId: sDead });
  let dBefore = delivered.length;
  await dm('you there?', 'N_DEAD');
  assert(delivered.length === dBefore, 'an unresumable run is not continued, and no OTHER run is guessed');
  assert(routed[routed.length - 1].fallbackAgent === 'beta', 'the request starts fresh with the SAME agent');
  tm.noteDm('discord', 'N_ALERT', 'D_OWNER');   // a bare notice (insight alert, overdue task)
  dBefore = delivered.length;
  await dm('what does this mean?', 'N_ALERT');
  assert(delivered.length === dBefore && q(qD).status === 'pending' && approval(a2).status === 'pending', 'a reply to an agent-less notice touches no run, question or approval');
  assert(routed[routed.length - 1].text === 'what does this mean?' && !routed[routed.length - 1].fallbackAgent, '…it goes to the router');

  console.log('\n\x1b[1m7) the reference only counts for the person we sent it to\x1b[0m');
  assert(tm.dmReplyTarget('discord', 'D_SOMEONE_ELSE', 'DM_X', 'N_QD') === undefined, 'another user quoting our message id resolves nothing');
  assert(tm.dmReplyTarget('discord', 'D_OWNER', 'DM_D_OWNER', 'NEVER_SEEN') === undefined, 'an unknown message keeps the old recipient-keyed routing');

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}DM REPLY TARGET: ${pass}/${pass + fail} passed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
