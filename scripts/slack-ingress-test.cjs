#!/usr/bin/env node
/* Slack ingress: attachments, untagged thread replies, and addressing an agent past the slash-command
 * interception. Three defects reported from a live tenant on 2026-09-03, all of which read to the human
 * on the other end as "the bot ignored me":
 *
 *   1. A message with a file attached carries `subtype: "file_share"`, and parseSlackEvent dropped EVERY
 *      subtyped message — so pasting a screenshot didn't just lose the image, it lost the whole message.
 *      And even on an app_mention (no subtype) the files were metadata only: Slack hands out an
 *      authenticated URL, never bytes, so an agent told "see the screenshot" had nothing to open.
 *   2. `slack_threads` is keyed by session_id — one reply target per run — so a thread the BOT opened
 *      (a cron report posted with slack_send) had no row at all, and a human replying under it was
 *      dropped as unaddressed channel chatter. Having spoken in a thread is the targeting signal.
 *   3. Slack intercepts a leading `/` as a slash command, so `/support-ops fix this` typed in a DM never
 *      leaves the client — the one syntax the help list advertised was the one that could not be sent.
 *
 * Isolated home; createSession/fire/postMessage/fetch stubbed so no tmux, claude or network is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-slackingress-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const slackApi = require(path.join(ROOT, 'dist/connectors/slack.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager, inboxFileName } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations, attachmentNote, threadNote } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { SlackSocket } = require(path.join(ROOT, 'dist/edge/slack-socket.js'));

const CH = 'C0OPS1234';

// ── 1. parsing: a message WITH files is still a message ──────────────────────────
console.log('\nparse: attachments');
const env = (ev) => ({ payload: { event: ev } });
const shared = slackApi.parseSlackEvent(env({
  type: 'message', subtype: 'file_share', channel: CH, channel_type: 'channel', user: 'U1', ts: '1.1',
  text: 'here is the crash', files: [{ id: 'F1', name: 'crash.png', mimetype: 'image/png', size: 1234, url_private_download: 'https://files.slack.com/f/F1' }],
}));
assert(!!shared, 'a `file_share` message is no longer dropped');
assert(shared && shared.text === 'here is the crash', 'its text survives (the whole message used to vanish, not just the file)');
assert(shared && shared.files.length === 1 && shared.files[0].name === 'crash.png', 'the file is normalized off the event');
assert(shared && shared.files[0].url === 'https://files.slack.com/f/F1', 'with the authenticated download URL, which is the only way to the bytes');
assert(slackApi.parseSlackEvent(env({ type: 'message', subtype: 'message_changed', channel: CH, user: 'U1', ts: '1.2', text: 'x' })) === null, 'other subtypes (edits/joins/deletes) are still dropped');
assert(slackApi.parseSlackEvent(env({ type: 'app_mention', channel: CH, user: 'U1', ts: '1.3', text: 'hi' })).files.length === 0, 'a plain mention has no files');
assert(slackApi.parseSlackFiles([{ name: 'gone.png' }]).length === 0, 'a file with no private URL is skipped, not half-described');

// ── 2. the download is authenticated, and refuses to be pointed elsewhere ────────
console.log('\ndownload');
(async () => {
  const realFetch = global.fetch;
  let sawAuth = '';
  global.fetch = async (url, init) => {
    sawAuth = (init && init.headers && init.headers.authorization) || '';
    return { ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  // Node's Headers has .get(); a Map does too, so the stub is enough.
  const got = await slackApi.downloadSlackFile('xoxb-test', 'https://files.slack.com/f/F1', 1024);
  assert(!('error' in got) && got.data.length === 4, 'a Slack file downloads to bytes');
  assert(sawAuth === 'Bearer xoxb-test', 'with the bot token — an unauthenticated fetch gets the login page, not the file');

  const evil = await slackApi.downloadSlackFile('xoxb-test', 'https://evilslack.com/f/F1', 1024);
  assert('error' in evil, 'a look-alike host is refused (the URL comes from an inbound event)');
  const other = await slackApi.downloadSlackFile('xoxb-test', 'https://example.com/f', 1024);
  assert('error' in other, 'so is any non-Slack host');

  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'text/html; charset=utf-8']]), arrayBuffer: async () => new Uint8Array().buffer });
  const html = await slackApi.downloadSlackFile('xoxb-test', 'https://files.slack.com/f/F2', 1024);
  assert('error' in html && /files:read/.test(html.error), 'Slack answering with HTML is reported as the missing scope it is, not saved as a "file"');

  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '99999']]), arrayBuffer: async () => new Uint8Array(99999).buffer });
  const big = await slackApi.downloadSlackFile('xoxb-test', 'https://files.slack.com/f/F3', 1024);
  assert('error' in big, 'and an oversize file is refused before it fills the agent folder');
  global.fetch = realFetch;

  // ── 3. wiring ─────────────────────────────────────────────────────────────────
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  const autos = new Automations(aos, tm);
  const AGENT_DIR = path.join(HOME, 'agent-ops');
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  aos.agents.set('support-ops', { id: 'support-ops', name: 'Support Ops', runtime: 'claude-code', dir: AGENT_DIR });
  aos.agents.set('release-bot', { id: 'release-bot', name: 'Release', runtime: 'claude-code', dir: AGENT_DIR });

  let seq = 0;
  const routed = [];
  tm.createSession = (agentId, title, task) => {
    const id = `r${++seq}`;
    routed.push({ agentId, title, task, id });
    tm.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agentId, title || '', task || '', id, 'running', 'x', Date.now(), Date.now());
    return { id, tmux: id };
  };
  aos.settings.slackBotToken = () => 'xoxb-test';
  aos.settings.autoRouteEnabled = () => false; // isolate explicit addressing from the intent router

  // ── 4. addressing: the forms Slack actually lets a human send ─────────────────
  console.log('\naddressing an agent (Slack eats a leading `/`)');
  const fireText = async (text, over = {}) => {
    const before = routed.length;
    const r = await autos.fireSlack({ eventType: 'message', channel: 'D0DM1', threadTs: '', user: 'U1', actorLabel: 'Dana', text, raw: { text }, ...over });
    return { agent: routed.length > before ? routed[routed.length - 1].agentId : undefined, reply: r.reply };
  };
  assert((await fireText('/support-ops check the queue')).agent === 'support-ops', '`/support-ops …` still routes (unchanged for channels, where `/` survives)');
  assert((await fireText('support-ops: check the queue')).agent === 'support-ops', '`support-ops: …` routes — the form a human types when the slash is eaten');
  assert((await fireText('@support-ops check the queue')).agent === 'support-ops', '`@support-ops …` routes');
  assert((await fireText('support-ops check the queue')).agent === 'support-ops', 'a bare leading agent name routes');
  assert((await fireText('/agent-os support-ops check')).agent === 'support-ops', 'the `/agent-os <agent>` namespace still collapses');
  const unknown = await fireText('hello is anyone there');
  assert(unknown.agent === undefined, 'an ordinary sentence is NOT read as addressing an agent named `hello`');
  assert(unknown.reply && !/`\/support-ops`/.test(unknown.reply), 'and the help list no longer advertises a `/name` form Slack refuses to send', String(unknown.reply).slice(0, 120));
  assert(unknown.reply && /support-ops/.test(unknown.reply), 'while still naming the roster');

  // ── 5. the slash command ──────────────────────────────────────────────────────
  console.log('\n/agentric slash command');
  const posts = [];
  slackApi.postMessage = async (_t, channel, text, thread) => { posts.push({ channel, text, thread }); return { ok: true, ts: '77.7' }; };
  const sock = new SlackSocket(aos, autos);
  let before = routed.length;
  await sock.dispatchSlashCommand({ payload: { command: '/agentric', text: 'support-ops check the queue', user_id: 'U1', channel_id: 'D0DM1' } });
  assert(routed.length === before + 1 && routed[routed.length - 1].agentId === 'support-ops', '`/agentric support-ops …` reaches the agent');
  const sid = routed[routed.length - 1].id;
  const bound = tm.db.prepare('SELECT channel, thread_ts FROM slack_threads WHERE session_id = ?').get(sid);
  assert(bound && bound.thread_ts === '77.7', "the run is re-bound to the ack's own ts, so its answer lands in a thread");
  assert(/support-ops/.test(posts[posts.length - 1].text), 'the ack NAMES the agent that picked it up — an anonymous "On it" leaves the sender unable to tell who answered', posts[posts.length - 1].text);
  assert(tm.knowsSlackThread('D0DM1', '77.7') === true, 'and that thread is now one we know, so follow-ups continue it');

  before = routed.length;
  await sock.dispatchSlashCommand({ payload: { command: '/agentric', text: '', user_id: 'U1', channel_id: 'D0DM1' } });
  assert(routed.length === before, 'a bare `/agentric` spawns nothing');
  assert(/support-ops/.test(posts[posts.length - 1].text), 'and answers with the roster instead');

  // ── 6. a reply in a thread WE started ─────────────────────────────────────────
  console.log('\nuntagged replies in our own thread');
  const REPORT_TS = '500.1';
  assert(tm.knowsSlackThread(CH, REPORT_TS) === false, 'a thread we have never spoken in is not ours');
  // The agent posts a daily report into the channel — this is what opens the thread.
  tm.db.prepare('INSERT OR REPLACE INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)').run(routed[0].id, CH, '', Date.now());
  slackApi.postMessage = async () => ({ ok: true, ts: REPORT_TS });
  await sock.sendToChannel(routed[0].id, CH, 'Daily report: 4 tickets closed.');
  assert(tm.knowsSlackThread(CH, REPORT_TS) === true, 'a proactive slack_send registers the thread it opened');
  const back = tm.sessionForSlackThread(CH, REPORT_TS);
  assert(!!back && back.sessionId === routed[0].id, 'and a reply under it resolves back to the run that wrote the report');

  slackApi.postMessage = async (_t, channel, text, thread) => { posts.push({ channel, text, thread }); return { ok: true, ts: '88.8' }; };
  before = routed.length;
  const p = posts.length;
  await sock.dispatch(env({ type: 'message', channel: CH, channel_type: 'channel', user: 'U1', ts: '500.2', thread_ts: REPORT_TS, text: 'which four?' }));
  assert(routed.length > before, 'an UNTAGGED reply in our own thread is acted on, not dropped as chatter');
  assert(posts.length > p && posts[posts.length - 1].thread === REPORT_TS, 'and is answered in that same thread');
  assert(/support-ops/.test(posts[posts.length - 1].text), 'by an ack naming the agent that took it');

  before = routed.length;
  const p2 = posts.length;
  await sock.dispatch(env({ type: 'message', channel: CH, channel_type: 'channel', user: 'U1', ts: '600.1', thread_ts: '600.0', text: 'unrelated chatter' }));
  assert(routed.length === before && posts.length === p2, 'a thread we have never spoken in is still ignored in full silence');

  // ── 7. attachments reach the agent as files it can open ───────────────────────
  console.log('\nattachments reach the agent');
  assert(inboxFileName('../../etc/passwd') === 'passwd', 'a traversing filename is reduced to a basename');
  assert(inboxFileName('.hidden') === 'hidden', 'a leading dot cannot hide the file from the agent');
  assert(inboxFileName('') === 'file', 'an empty name still yields something writable');
  assert(/\.inbox\/crash\.png/.test(attachmentNote([{ name: 'crash.png' }])), 'the prompt names the path the file WILL have');
  assert(attachmentNote([]) === '' && attachmentNote() === '', 'and says nothing when there is nothing attached');

  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });
  before = routed.length;
  await sock.dispatch(env({
    type: 'message', subtype: 'file_share', channel: 'D0DM1', channel_type: 'im', user: 'U1', ts: '900.1',
    text: 'support-ops what broke here?',
    files: [{ id: 'F9', name: 'crash.png', mimetype: 'image/png', size: 4, url_private_download: 'https://files.slack.com/f/F9' }],
  }));
  assert(routed.length === before + 1, 'a DM with an attachment routes like any other message');
  const withFile = routed[routed.length - 1];
  assert(/\.inbox\/crash\.png/.test(withFile.task), 'the agent is TOLD about the file, by the path it can read');
  assert(fs.existsSync(path.join(AGENT_DIR, '.inbox', 'crash.png')), 'and the bytes are actually on disk in its own folder');
  assert(fs.readFileSync(path.join(AGENT_DIR, '.inbox', 'crash.png')).length === 4, 'with the downloaded content, not a Slack HTML page');
  global.fetch = realFetch;

  // ── 8. the thread a mention landed in ────────────────────────────────────────
  // Reported 2026-09-04: tagging the bot midway through an existing thread got "I only receive the text
  // of the message that @-mentions me; the rest of this thread isn't visible to me" — true of the raw
  // event, and the agent then guessed at a cause. The history is one authenticated call away.
  console.log('\nthread history');
  assert(threadNote() === '' && threadNote('') === '', 'no thread → nothing added to the prompt');
  assert(/Alice: ship it/.test(threadNote('Alice: ship it')), 'a thread is handed over as plain text');

  const replies = [
    { ts: '700.0', user: 'U9', text: 'prod latency is up 4x since the deploy' },
    { ts: '700.1', user: '', bot_id: 'B1', bot_profile: { name: 'Beszel' }, text: 'ALERT web-3 cpu 98%' },
    { ts: '700.2', user: 'U9', text: 'x'.repeat(2000) },
    { ts: '700.3', user: 'U1', text: '<@BOT> can you triage this?' },
  ];
  let askedUrl = '';
  global.fetch = async (url, init) => {
    if (/conversations\.replies/.test(String(url))) {
      askedUrl = String(url); // users.info also runs here (name resolution) — only the history read matters
      assert((init && init.headers && init.headers.authorization) === 'Bearer xoxb-test', 'the history read is authenticated as the bot');
      return { ok: true, json: async () => ({ ok: true, messages: replies }) };
    }
    return { ok: true, json: async () => ({ ok: false, error: 'unexpected' }) };
  };
  sock.botUserId = 'BOT';
  before = routed.length;
  await sock.dispatch(env({ type: 'app_mention', channel: CH, channel_type: 'channel', user: 'U1', ts: '700.3', thread_ts: '700.0', text: '<@BOT> support-ops can you triage this?' }));
  assert(routed.length === before + 1, 'a mention inside an existing thread still routes');
  const threaded = routed[routed.length - 1].task;
  assert(/prod latency is up 4x/.test(threaded), 'the agent is given what was said BEFORE it was tagged — the whole point');
  assert(/Beszel: ALERT web-3 cpu 98%/.test(threaded), "including another app's posts, named by their bot profile");
  assert(!/x{900}/.test(threaded), 'a giant pasted blob is clipped, so one message cannot become the prompt');
  const block = threaded.slice(threaded.indexOf('The thread this arrived in'), threaded.indexOf("When you're done"));
  assert(block.length > 0 && !/can you triage this\?/.test(block), 'the triggering message is not repeated inside the history block');
  assert(/ts=700\.0/.test(askedUrl) && new RegExp(`channel=${CH}`).test(askedUrl), 'the read is scoped to that channel + thread');

  // A first message in a channel opens its own thread: `thread_ts` falls back to `ts`, and there is no
  // history to read — spending an API call per message would be pure cost.
  askedUrl = '';
  await sock.dispatch(env({ type: 'app_mention', channel: CH, channel_type: 'channel', user: 'U1', ts: '800.1', text: '<@BOT> support-ops hello' }));
  assert(askedUrl === '', 'a mention that OPENS a thread reads no history');

  // The failure that produced the report: an app created before `groups:history` was in the manifest.
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'missing_scope' }) });
  before = routed.length;
  const auditBefore = aos.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'slack.thread.unreadable'").get().c;
  await sock.dispatch(env({ type: 'app_mention', channel: CH, channel_type: 'channel', user: 'U1', ts: '900.9', thread_ts: '700.0', text: '<@BOT> support-ops triage' }));
  assert(routed.length === before + 1, 'an unreadable thread never blocks the run');
  const auditAfter = aos.db.prepare("SELECT COUNT(*) c FROM audit_events WHERE type = 'slack.thread.unreadable'").get().c;
  assert(auditAfter === auditBefore + 1, 'and the reason is audited, so the operator can see the missing scope');
  const blind = routed[routed.length - 1].task;
  assert(/missing_scope/.test(blind) && /groups:history/.test(blind), 'the agent is TOLD it is blind and why — it invented a reason for the human otherwise', blind.slice(0, 200));
  assert(/only see the message that mentioned you/.test(blind), 'and told to say so plainly instead of answering as if it had the thread');
  assert(/missing_scope/.test(String(aos.db.prepare("SELECT data FROM audit_events WHERE type = 'slack.thread.unreadable' ORDER BY ts DESC LIMIT 1").get().data)), 'verbatim — `missing_scope` is the one an operator must act on');
  global.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
