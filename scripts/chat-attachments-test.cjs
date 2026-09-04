#!/usr/bin/env node
/* ClickUp + Telegram attachments — the last two ingress lanes where a file a human sent reached the
 * agent as nothing. Same defect as Slack (#775) and Discord (#776), a different mechanism in each:
 *
 *   • ClickUp — `comment_text` is FLATTENED text, so a screenshot dropped on a task leaves no trace in
 *     it at all. The files live only in the structured `comment` block array, behind a presigned URL
 *     that EXPIRES, which is why the bytes are taken at dispatch rather than kept as a link.
 *   • Telegram — worse than any of the others: `parseTelegramUpdate` returned null for a message with no
 *     text, and an UNCAPTIONED photo is the most natural way a person reports a bug, so the message was
 *     dropped whole. Telegram also hands out an opaque `file_id` rather than a URL, so each file costs a
 *     `getFile` first — and the resulting download URL embeds the bot token, which must never be logged.
 *
 * Also pinned here: ClickUp's ack. A task's comment section is a SHARED space, so a dispatch the
 * commenter steered (`/support-ops …`) still posts no "on it" comment — the 👀 reaction is enough and a
 * second comment is noise. But when the ROUTER picked the agent, the commenter has no way to know who
 * took it, so that case names them.
 *
 * Isolated home; createSession / the ClickUp + Telegram API calls / fetch all stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chatfiles-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const cu = require(path.join(ROOT, 'dist/connectors/clickup.js'));
const tg = require(path.join(ROOT, 'dist/connectors/telegram.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { ClickupIngress } = require(path.join(ROOT, 'dist/edge/clickup-ingress.js'));
const { TelegramSocket } = require(path.join(ROOT, 'dist/edge/telegram-socket.js'));

// ── 1. ClickUp parsing ───────────────────────────────────────────────────────────
console.log('\nClickUp: attachments live in the blocks, not the text');
const cuComment = {
  id: 'c1', comment_text: 'this is broken', user: { id: '9', email: 'Dana@Example.com' },
  comment: [
    { type: 'text', text: 'this is broken' },
    { type: 'attachment', attachment: { id: 'a1', title: 'crash', extension: 'png', mimetype: 'image/png', size: 4, url_w_query: 'https://t123-attachments.clickup.com/a1?sig=x' } },
  ],
};
let files = cu.parseClickupAttachments(cuComment);
assert(files.length === 1, 'an attachment block is found even though comment_text mentions nothing');
assert(files[0].name === 'crash.png', "ClickUp's title drops the extension, so it is put back — the agent needs to know what it is looking at");
assert(cu.parseClickupAttachments({ comment_text: 'plain' }).length === 0, 'a plain comment has no files');
assert(cu.parseClickupAttachments({ comment: [{ type: 'attachment', attachment: { id: 'a2', title: 'x.pdf' } }] }).length === 0, 'an attachment with no url is skipped, not half-described');
const dup = cu.parseClickupAttachments({
  comment: [{ type: 'attachment', attachment: { id: 'a3', title: 'x.png', url: 'https://x.clickup.com/a3' } }],
  attachments: [{ id: 'a3', title: 'x.png', url: 'https://x.clickup.com/a3' }],
});
assert(dup.length === 1, 'the same file listed in both shapes is counted once');

// ── 2. Telegram parsing ──────────────────────────────────────────────────────────
console.log('\nTelegram: an uncaptioned photo is a message, not nothing');
const tgMsg = (m) => tg.parseTelegramUpdate({ message: { message_id: 5, chat: { id: '77', type: 'private' }, from: { id: '9', username: 'dana' }, ...m } }, 'B1', 'agentricbot');
const photoOnly = tgMsg({ photo: [{ file_id: 'small', file_unique_id: 'u1', file_size: 100 }, { file_id: 'big', file_unique_id: 'u2', file_size: 900 }] });
assert(!!photoOnly, 'a message with a photo and NO caption is no longer dropped');
assert(photoOnly.files.length === 1 && photoOnly.files[0].fileId === 'big', 'and the LARGEST of the photo sizes is the one taken');
assert(/\.jpg$/.test(photoOnly.files[0].name), 'with a synthesized filename (Telegram gives a photo none)');
assert(tgMsg({ text: 'hi' }).files.length === 0, 'a plain text message has no files');
assert(tgMsg({ document: { file_id: 'd1', file_name: 'log.txt', mime_type: 'text/plain' } }).files[0].name === 'log.txt', 'a document keeps its real filename');
assert(tgMsg({ voice: { file_id: 'v1' } }).files[0].name === 'voice.ogg', 'voice/audio/video each get a sensible name');
assert(tgMsg({ sticker: { file_id: 's1' } }) === null, 'a sticker is still nothing to route');

(async () => {
  // ── 3. downloads ───────────────────────────────────────────────────────────────
  console.log('\ndownloads');
  const realFetch = global.fetch;
  let sawAuth = 'unset';
  global.fetch = async (url, init) => {
    sawAuth = (init && init.headers && init.headers.authorization) || '';
    return { ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
  };
  const got = await cu.downloadClickupFile('https://t123-attachments.clickup.com/a1?sig=x', 1024);
  assert(!('error' in got) && got.data.length === 4, 'a ClickUp attachment downloads to bytes');
  assert(sawAuth === '', 'with NO Authorization header — the API token has no business at the attachment host');
  assert('error' in await cu.downloadClickupFile('https://clickup.com.evil.test/a', 1024), 'a look-alike host is refused');
  assert('error' in await cu.downloadClickupFile('https://example.com/a', 1024), 'so is any non-ClickUp host');
  assert('error' in await cu.downloadClickupFile('not a url', 1024), 'and an unparseable url is refused rather than probed');

  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('getFile')) return { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/f.jpg', file_size: 4 } }) };
    return { ok: true, headers: new Map([['content-type', 'image/jpeg'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  const tgGot = await tg.downloadTelegramFile('TOKEN', 'big', 1024);
  assert(!('error' in tgGot) && tgGot.data.length === 4, 'a Telegram file resolves through getFile then downloads');
  assert(urls.length === 2 && urls[1].includes('/file/botTOKEN/photos/f.jpg'), 'two calls by design — the update carries no URL', urls.join(' | '));

  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'file is too big' }) });
  assert('error' in await tg.downloadTelegramFile('TOKEN', 'x', 1024), 'a getFile refusal is reported, not retried blindly');

  global.fetch = async (url) => String(url).includes('getFile')
    ? { ok: true, json: async () => ({ ok: true, result: { file_path: 'p', file_size: 99999 } }) }
    : { ok: true, headers: new Map(), arrayBuffer: async () => new Uint8Array(99999).buffer };
  assert('error' in await tg.downloadTelegramFile('TOKEN', 'x', 1024), 'and an oversize file is refused before it is even fetched');

  // ── 4. wiring ─────────────────────────────────────────────────────────────────
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
  aos.settings.clickupToken = () => 'pk_test';
  aos.settings.clickupConfigured = () => true;
  aos.settings.telegramBotToken = () => 'TOKEN';
  aos.settings.autoRouteEnabled = () => false;

  // ── 5. ClickUp end to end ─────────────────────────────────────────────────────
  console.log('\nClickUp: the file reaches the agent, and the ack stays quiet when the commenter chose');
  const comments = [];
  cu.addComment = async (_t, taskId, text) => { comments.push({ taskId, text }); return { ok: true, id: `c${comments.length + 100}` }; };
  cu.addReaction = async () => ({ ok: true });
  global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });

  const ingress = new ClickupIngress(aos, autos);
  cu.fetchLatestComment = async () => ({
    id: 'cmd1', text: '/support-ops what broke here?', userId: '9', userEmail: 'dana@example.com',
    files: [{ id: 'a1', name: 'crash.png', mimetype: 'image/png', size: 4, url: 'https://t123-attachments.clickup.com/a1' }],
  });
  let before = routed.length, c0 = comments.length;
  const out = await ingress.dispatch('T1', {});
  assert(routed.length === before + 1, 'a `/agent` comment with an attachment dispatches');
  assert(/\.inbox\/crash\.png/.test(routed[routed.length - 1].task), 'the agent is TOLD about the file, by the path it can read');
  assert(fs.existsSync(path.join(AGENT_DIR, '.inbox', 'crash.png')), 'and the bytes are on disk in its own folder');
  assert(comments.length === c0, 'no "on it" comment — the commenter named the agent, and the 👀 reaction says the rest');
  assert(out.status === 'dispatched', 'and the webhook reports it');

  // Router-chosen agent → the commenter has no idea who took it, so name them.
  aos.settings.autoRouteEnabled = () => false;
  cu.fetchLatestComment = async () => ({ id: 'cmd2', text: '/nobody-by-that-name please help', userId: '9', userEmail: 'dana@example.com', files: [] });
  c0 = comments.length;
  await ingress.dispatch('T2', {});
  assert(comments.length === c0 + 1 && /support-ops/.test(comments[comments.length - 1].text), 'an unroutable command still answers with the roster', comments[comments.length - 1]?.text);

  // A clickup AUTOMATION fires on the task regardless of which name was typed — the same position the
  // auto-router is in. The commenter cannot know who took it, so this is the case that names them.
  const auto = autos.add({ agentId: 'support-ops', name: 'task-watch', type: 'clickup', filter: '*', task: 'Handle it.' });
  autos.fire = (a) => { const id = `f${++seq}`; routed.push({ agentId: a.agentId, id, task: '' }); return { ok: true, sessionId: id, tmux: id }; };
  cu.fetchLatestComment = async () => ({ id: 'cmd3', text: '/triage please look', userId: '9', userEmail: 'dana@example.com', files: [] });
  c0 = comments.length;
  await ingress.dispatch('T3', {});
  assert(comments.length === c0 + 1 && /support-ops/.test(comments[comments.length - 1].text),
    'when the ROUTER picked the agent, the ack NAMES it — the commenter typed a different name and would otherwise never know who took it', comments[comments.length - 1]?.text);
  autos.remove(auto.id);

  // ── 6. Telegram end to end ────────────────────────────────────────────────────
  console.log('\nTelegram: an uncaptioned photo reaches the agent');
  const sent = [];
  tg.sendMessage = async (_t, chat, text) => { sent.push({ chat, text }); return { ok: true, id: '1' }; };
  global.fetch = async (url) => String(url).includes('getFile')
    ? { ok: true, json: async () => ({ ok: true, result: { file_path: 'photos/f.jpg', file_size: 4 } }) }
    : { ok: true, headers: new Map([['content-type', 'image/jpeg'], ['content-length', '4']]), arrayBuffer: async () => new Uint8Array([9, 9, 9, 9]).buffer };

  const sock = new TelegramSocket(aos, autos);
  before = routed.length;
  await sock.dispatch({ message: {
    message_id: 7, chat: { id: '77', type: 'private' }, from: { id: '9', username: 'dana' },
    caption: 'support-ops what broke here?',
    photo: [{ file_id: 'big', file_unique_id: 'u2', file_size: 4 }],
  } });
  assert(routed.length === before + 1, 'a captioned photo routes');
  const task = routed[routed.length - 1].task;
  assert(/\.inbox\/photo-u2\.jpg/.test(task), 'the agent is told the path of the photo', task.slice(0, 200));
  assert(fs.existsSync(path.join(AGENT_DIR, '.inbox', 'photo-u2.jpg')), 'and the bytes are on disk in its own folder');
  assert(fs.readFileSync(path.join(AGENT_DIR, '.inbox', 'photo-u2.jpg')).length === 4, 'with the downloaded content');
  global.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
