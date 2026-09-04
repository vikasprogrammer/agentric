#!/usr/bin/env node
/* Discord ingress: attachments and untagged replies to what an agent posted. The Discord half of the
 * Slack ingress work (scripts/slack-ingress-test.cjs), with the two platforms differing in how each
 * defect has to be fixed:
 *
 *   1. Attachments. Discord never dropped the message (there is no `file_share` subtype), but
 *      `attachments[]` went into the raw payload and nowhere else — the agent was told "see the
 *      screenshot" and had no screenshot. Unlike Slack the CDN URL is signed and needs NO Authorization
 *      header (and must not be sent one), but it EXPIRES, which is why the bytes are fetched at dispatch.
 *   2. Untagged replies. Slack could key continuity on a thread root; Discord's `discord_threads` is
 *      keyed by CHANNEL, which works for a branched thread and not at all for a proactive `discord_send`
 *      — that posts into a channel with no thread, and binding the whole channel would drag every
 *      unrelated message in it into the run. The signal is Discord's own `message_reference`: a reply to
 *      a message an agent wrote is addressed to that agent, @mention or not.
 *
 * The third Slack defect (a leading `/` swallowed by the client) has no Discord analogue — an unknown
 * slash command sends as plain text there — but the shared `normalizeChatCommand` aliases are asserted
 * here too, since Discord routes through the same front door.
 *
 * Isolated home; createSession/postMessage/fetch stubbed so no tmux, claude or network is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-discordingress-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const api = require(path.join(ROOT, 'dist/connectors/discord.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { DiscordSocket } = require(path.join(ROOT, 'dist/edge/discord-socket.js'));

const BOT = 'B0BOT';
const GUILD = 'G1';
const CH = 'C0OPS';

// ── 1. parsing ───────────────────────────────────────────────────────────────────
console.log('\nparse: attachments and reply references');
const msg = (over = {}) => ({ id: 'M1', channel_id: CH, guild_id: GUILD, author: { id: 'U1', username: 'dana' }, content: 'hi', ...over });
const withFile = api.parseDiscordMessage(msg({
  content: 'what broke here?',
  attachments: [{ id: 'A1', filename: 'crash.png', content_type: 'image/png', size: 4, url: 'https://cdn.discordapp.com/attachments/1/2/crash.png?ex=1&is=2&hm=3' }],
}), BOT);
assert(withFile.files.length === 1 && withFile.files[0].name === 'crash.png', 'an attachment is normalized off the message');
assert(withFile.files[0].url.includes('cdn.discordapp.com'), 'with its signed CDN url, which is the only handle on the bytes');
assert(api.parseDiscordMessage(msg({}), BOT).files.length === 0, 'a plain message has no files');
assert(api.parseDiscordFiles([{ filename: 'gone.png' }]).length === 0, 'an attachment with no url is skipped, not half-described');
const replying = api.parseDiscordMessage(msg({ id: 'M2', message_reference: { message_id: 'M-BOT' } }), BOT);
assert(replying.replyToId === 'M-BOT', 'a reply carries the id of the message it answers');
assert(api.parseDiscordMessage(msg({}), BOT).replyToId === '', 'and a non-reply carries none');
assert(replying.mentioned === false, 'a reply without an @mention is still NOT a fresh trigger by itself');

(async () => {
  // ── 2. the download ────────────────────────────────────────────────────────────
  console.log('\ndownload');
  const realFetch = global.fetch;
  let sawAuth = 'unset';
  global.fetch = async (url, init) => {
    sawAuth = (init && init.headers && init.headers.authorization) || '';
    return { ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
  };
  const got = await api.downloadDiscordFile('https://cdn.discordapp.com/attachments/1/2/crash.png', 1024);
  assert(!('error' in got) && got.data.length === 4, 'a Discord attachment downloads to bytes');
  assert(sawAuth === '', 'with NO Authorization header — the bot token has no business reaching the CDN host');

  assert('error' in await api.downloadDiscordFile('https://cdn.discordapp.com.evil.test/x', 1024), 'a look-alike host is refused (the url arrives inside an untrusted event)');
  assert('error' in await api.downloadDiscordFile('https://example.com/x', 1024), 'so is any non-Discord host');

  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '99999']]), arrayBuffer: async () => new Uint8Array(99999).buffer });
  assert('error' in await api.downloadDiscordFile('https://cdn.discordapp.com/x', 1024), 'and an oversize file is refused before it fills the agent folder');

  // ── 3. wiring ─────────────────────────────────────────────────────────────────
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  const autos = new Automations(aos, tm);
  const AGENT_DIR = path.join(HOME, 'agent-ops');
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  aos.agents.set('support-ops', { id: 'support-ops', name: 'Support Ops', runtime: 'claude-code', dir: AGENT_DIR });

  let seq = 0;
  const routed = [];
  tm.createSession = (agentId, title, task) => {
    const id = `r${++seq}`;
    routed.push({ agentId, title, task, id });
    tm.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agentId, title || '', task || '', id, 'running', 'x', Date.now(), Date.now());
    return { id, tmux: id };
  };
  aos.settings.discordBotToken = () => 'Bot-test';
  aos.settings.autoRouteEnabled = () => false; // isolate explicit addressing from the intent router

  // ── 4. the shared addressing aliases reach Discord too ────────────────────────
  console.log('\naddressing (shared front door)');
  const fireText = async (text) => {
    const before = routed.length;
    await autos.fireDiscord({ eventType: 'direct_message', channel: 'D1', messageId: 'm', user: 'U1', actorLabel: 'Dana', text, raw: { content: text } });
    return routed.length > before ? routed[routed.length - 1].agentId : undefined;
  };
  assert(await fireText('/support-ops check the queue') === 'support-ops', '`/support-ops …` routes (Discord sends an unknown slash command as plain text)');
  assert(await fireText('support-ops: check the queue') === 'support-ops', '`support-ops: …` routes');
  assert(await fireText('@support-ops check the queue') === 'support-ops', '`@support-ops …` routes');
  assert(await fireText('hello is anyone there') === undefined, 'an ordinary sentence is not read as addressing an agent named `hello`');

  // ── 5. a reply to what an agent posted ────────────────────────────────────────
  console.log('\nuntagged replies to what an agent posted');
  const posts = [];
  let nextId = 100;
  api.postMessage = async (_t, channel, content, replyTo) => { const id = `M${++nextId}`; posts.push({ channel, content, replyTo, id }); return { ok: true, id }; };
  const sock = new DiscordSocket(aos, autos);
  const SESSION = routed[0].id;

  assert(tm.knowsDiscordMessage(CH, 'M101') === false, 'a message we never posted is not ours');
  const sent = await sock.sendToChannel(SESSION, CH, 'Daily report: 4 tickets closed.');
  assert(sent.ok === true, 'a proactive discord_send posts');
  const reportId = posts[posts.length - 1].id;
  assert(tm.knowsDiscordMessage(CH, reportId) === true, 'and the message it wrote is remembered');
  assert(autos.agentForDiscordMessage(CH, reportId) === 'support-ops', 'resolving back to the agent that wrote it');

  let before = routed.length, p = posts.length;
  await sock.dispatch(msg({ id: 'M9', content: 'which four?', message_reference: { message_id: reportId } }));
  assert(routed.length > before, 'an UNTAGGED reply to it is acted on, not dropped as guild chatter');
  assert(routed[routed.length - 1].agentId === 'support-ops', 'and stays with the agent that wrote the report, not the roster');
  assert(posts.length > p, 'and is acknowledged');
  assert(/support-ops/.test(posts[posts.length - 1].content), 'by an ack that NAMES the agent — an anonymous "On it" leaves the sender unable to tell who answered', posts[posts.length - 1].content);
  assert(tm.knowsDiscordMessage(CH, posts[posts.length - 1].id) === true, 'and the ack itself is remembered, so replying to IT reaches the run too');

  before = routed.length; p = posts.length;
  await sock.dispatch(msg({ id: 'M10', content: 'unrelated chatter' }));
  assert(routed.length === before && posts.length === p, 'a plain guild message with no @mention is still ignored in full silence');

  before = routed.length; p = posts.length;
  await sock.dispatch(msg({ id: 'M11', content: 'replying to a human', message_reference: { message_id: 'M-SOMEONE-ELSE' } }));
  assert(routed.length === before && posts.length === p, 'and so is a reply to somebody else — only OUR messages are the signal');

  // ── 6. attachments reach the agent ────────────────────────────────────────────
  console.log('\nattachments reach the agent');
  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });
  before = routed.length;
  await sock.dispatch(msg({
    id: 'M12', guild_id: undefined, channel_id: 'D1', content: 'support-ops what broke here?',
    attachments: [{ id: 'A9', filename: 'crash.png', content_type: 'image/png', size: 4, url: 'https://cdn.discordapp.com/attachments/1/2/crash.png' }],
  }));
  assert(routed.length === before + 1, 'a DM with an attachment routes like any other message');
  assert(/\.inbox\/crash\.png/.test(routed[routed.length - 1].task), 'the agent is TOLD about the file, by the path it can read');
  assert(fs.existsSync(path.join(AGENT_DIR, '.inbox', 'crash.png')), 'and the bytes are on disk in its own folder');
  assert(fs.readFileSync(path.join(AGENT_DIR, '.inbox', 'crash.png')).length === 4, 'with the downloaded content');
  global.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
