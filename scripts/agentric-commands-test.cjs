/* `/agentric` helper commands — the closed verb set answered by the server with no agent run
 * (src/edge/agentric-commands.ts + Automations.agentricCommand).
 *
 * Pins the grammar's strictness (a ClickUp comment that merely STARTS with "done" is text, not a close;
 * `/agentric <agent> …` still routes to the agent), each verb end to end on chat and on a ClickUp ticket,
 * that a helper command beats a `*`-scoped automation (no run spent on `/agentric tasks`), and that an
 * unmapped sender gets the fix instead of an anonymous edit to the shared board.
 *
 * Isolated home; createSession / the ClickUp API are stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agentric-cmd-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const cmds = require(path.join(ROOT, 'dist/edge/agentric-commands.js'));
const cu = require(path.join(ROOT, 'dist/connectors/clickup.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { ClickupIngress } = require(path.join(ROOT, 'dist/edge/clickup-ingress.js'));

// ── 1. grammar ──────────────────────────────────────────────────────────────────
console.log('\nGrammar: strict on purpose');
const P = cmds.parseAgentricCommand;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
assert(cmds.agentricBody('/agentric tasks') === 'tasks', '`/agentric tasks` → body "tasks"');
assert(cmds.agentricBody('/agentric@AcmeBot tasks') === 'tasks', "Telegram's `/agentric@Bot` form is the same command");
assert(cmds.agentricBody('/agentric-bot hi') === null && cmds.agentricBody('/support-ops hi') === null, 'other slash words are not the namespace');
assert(eq(P('help', 'slack'), { verb: 'help' }), 'help');
assert(eq(P('tasks', 'slack'), { verb: 'tasks', scope: 'open' }) && eq(P('tasks done', 'slack'), { verb: 'tasks', scope: 'done' }), 'tasks [open|done|all], open by default');
assert(P('tasks for the release', 'slack') === null, 'a sentence starting with "tasks" is not the verb');
assert(eq(P('task new Fix the login page @support-ops', 'slack'), { verb: 'new', title: 'Fix the login page', agent: 'support-ops' }), 'task new <title> @agent');
assert(eq(P('task new Fix the login page', 'slack'), { verb: 'new', title: 'Fix the login page' }), 'task new <title>');
assert(eq(P('task tsk_ab12 see the logs', 'slack'), { verb: 'say', id: 'tsk_ab12', text: 'see the logs' }), 'task <id> <text>');
assert(eq(P('done tsk_ab12', 'slack'), { verb: 'done', id: 'tsk_ab12' }) && eq(P('task done #tsk_ab12', 'slack'), { verb: 'done', id: 'tsk_ab12' }), 'done <id>, and the `task done` alias');
assert(eq(P('done', 'clickup'), { verb: 'done' }), 'on ClickUp a bare `done` targets the ticket\'s task');
assert(P('done testing, looks good', 'clickup') === null, 'but "done testing, looks good" is a COMMENT, not a close');
assert(P('status of the fix?', 'slack') === null, 'and "status of the fix?" is a question for an agent');
assert(eq(P('tasks', 'clickup'), { verb: 'unsupported', what: 'tasks' }) && eq(P('task new x', 'clickup'), { verb: 'unsupported', what: 'task new' }), 'chat-only verbs on ClickUp are answered, not treated as text');
assert(P('support-ops fix X', 'slack') === null, '`/agentric <agent> …` is not a helper command — it still routes to the agent');

(async () => {
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'), 'https://aos.example.com');
  const autos = new Automations(aos, tm);
  const AGENT_DIR = path.join(HOME, 'agent-ops');
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  aos.agents.set('support-ops', { id: 'support-ops', name: 'Support Ops', runtime: 'claude-code', dir: AGENT_DIR });
  const dana = aos.team.invite({ email: 'dana@example.com', role: 'member' }).member.id;

  let seq = 0;
  const spawned = [];
  tm.createSession = (agentId, title, task, spawnedBy) => {
    const id = `r${++seq}`;
    spawned.push({ agentId, spawnedBy, id });
    tm.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agentId, title || '', task || '', id, 'exited', 'x', Date.now(), Date.now());
    return { id, tmux: id };
  };
  aos.settings.autoRouteEnabled = () => false;

  // `null` = an unmapped sender (a default parameter would swallow an explicit `undefined`).
  const discord = (text, runAs = dana) => autos.fireDiscord({ eventType: 'MESSAGE_CREATE', channel: 'C1', messageId: `m${++seq}`, user: 'u1', actorLabel: 'Dana', text, raw: {} }, runAs || undefined);
  const slack = (text, runAs = dana) => autos.fireSlack({ eventType: 'app_mention', channel: 'S1', threadTs: '', user: 'U1', actorLabel: 'Dana', text, raw: {} }, runAs || undefined);

  // ── 2. chat, end to end ───────────────────────────────────────────────────────
  console.log('\nChat: create, list, discuss, close, reopen');
  let r = await discord('/agentric task new Fix the login page @support-ops');
  const task = aos.tasks.list({ tenant: aos.tenant, limit: 50 }).find((t) => t.title === 'Fix the login page');
  assert(!!task && /^Created: Fix the login page/.test(r.reply || ''), 'task new creates the task and says so', r.reply);
  assert(r.reply.includes(`https://aos.example.com/#/tasks/${task.id}`), 'with a link into the console');
  assert(task.createdBy === dana && task.owner === dana, 'filed and owned by the sender');
  assert(task.assignee === 'agent:support-ops' && spawned.some((s) => s.spawnedBy === `task:${task.id}`), 'naming an agent assigns and starts it');
  assert(r.fired === 0, 'and the chat message itself started no extra run');

  r = await discord('/agentric tasks');
  assert(/Your open tasks/.test(r.reply) && r.reply.includes('Fix the login page') && r.reply.includes(task.id), '`tasks` lists what I filed', r.reply);

  r = await discord(`/agentric task ${task.id} the error is a 502 on /auth`);
  const said = tm.discussionTimeline(task.id).filter((e) => e.kind === 'chat').map((e) => e.body);
  assert(/^Added to Fix the login page/.test(r.reply) && said.includes('the error is a 502 on /auth'), '`task <id> <text>` lands in the discussion', r.reply);

  r = await discord(`/agentric status ${task.id}`);
  assert(r.reply.startsWith('Fix the login page\n') && /support-ops/.test(r.reply), '`status <id>` reports state + assignee', r.reply);

  r = await discord(`/agentric done ${task.id}`);
  assert(aos.tasks.get(task.id).status === 'done' && /^Closed:/.test(r.reply), '`done <id>` closes it');
  r = await discord('/agentric tasks done');
  assert(r.reply.includes('Fix the login page'), '`tasks done` finds it again — for rework');
  r = await discord(`/agentric reopen ${task.id}`);
  assert(aos.tasks.get(task.id).status === 'todo' && /^Reopened:/.test(r.reply), '`reopen <id>` puts it back in play');

  r = await discord('/agentric done');
  assert(/Which task\?/.test(r.reply), 'a bare `done` in chat asks which task — there is no ticket to default to');
  r = await discord('/agentric task new Tweak copy @nobody');
  assert(/unassigned/.test(r.reply), 'an unknown @agent still files the task, unassigned, and says so', r.reply);

  // ── 3. identity + precedence ──────────────────────────────────────────────────
  console.log('\nIdentity and precedence');
  const before = aos.tasks.list({ tenant: aos.tenant, limit: 100 }).length;
  r = await discord('/agentric task new Anonymous task', null);
  assert(/can't tell who you are on Discord/.test(r.reply) && aos.tasks.list({ tenant: aos.tenant, limit: 100 }).length === before, 'an unmapped sender gets the fix, and nothing is written', r.reply);
  r = await discord('/agentric help', null);
  assert(/Agentric commands/.test(r.reply), 'help works for anyone');

  const auto = autos.add({ agentId: 'support-ops', name: 'every-message', type: 'slack', filter: '*', task: 'Handle it.' });
  const runs = spawned.length;
  r = await slack('/agentric tasks');
  assert(r.fired === 0 && spawned.length === runs && /Your open tasks/.test(r.reply), 'a helper command beats a `*` Slack automation — no run spent on `/agentric tasks`');
  autos.remove(auto.id);

  r = await slack('/agentric support-ops what broke?');
  assert(r.fired > 0 && !r.reply, '`/agentric <agent> …` still reaches the agent', JSON.stringify(r));

  r = await autos.fireTelegram({ eventType: 'message', chat: '77', messageThreadId: '', messageId: '1', user: '9', actorLabel: 'Dana', text: '/agentric@AcmeBot tasks', raw: {} }, dana);
  assert(/Your open tasks/.test(r.reply || ''), "Telegram's `/agentric@Bot tasks` works");

  // ── 4. ClickUp ────────────────────────────────────────────────────────────────
  console.log('\nClickUp: status / done / reopen act on the ticket\'s task');
  aos.settings.clickupToken = () => 'pk_test';
  aos.settings.clickupConfigured = () => true;
  const comments = [];
  cu.addComment = async (_t, taskId, text) => { comments.push({ taskId, text }); return { ok: true, id: `c${comments.length + 100}` }; };
  cu.addReaction = async () => ({ ok: true });
  cu.fetchTask = async (_t, id) => ({ id, customId: '', name: 'Checkout broken', description: 'd', url: `https://app.clickup.com/t/${id}` });
  let cid = 0;
  const say = async (text) => { cu.fetchLatestComment = async () => ({ id: `cm${++cid}`, text, userId: '9', userEmail: 'dana@example.com', files: [] }); return ingress.dispatch('T9', {}); };
  const ingress = new ClickupIngress(aos, autos, 'https://aos.example.com');
  const last = () => comments[comments.length - 1]?.text || '';

  await say('/agentric status');
  assert(/no Agentric task yet/.test(last()), 'status before any link says how to create one', last());
  await say('/agentric please track this');
  const tt = aos.tasks.byExternalKey(aos.tenant, 'clickup:T9');
  await say('/agentric status');
  assert(last().startsWith('#T9 Checkout broken\n'), '`/agentric status` reports the ticket\'s task', last());
  await say('/agentric done');
  assert(aos.tasks.get(tt.id).status === 'done' && /^Closed:/.test(last()), '`/agentric done` closes it');
  await say('/agentric done testing, looks good');
  assert(aos.tasks.get(tt.id).status === 'done', '"done testing, looks good" does not act on status…');
  assert(tm.discussionTimeline(tt.id).some((e) => e.body === 'done testing, looks good'), '…it is added to the discussion like any other text');
  await say('/agentric reopen');
  assert(aos.tasks.get(tt.id).status === 'todo' && /^Reopened:/.test(last()), '`/agentric reopen` reopens it');
  await say('/agentric tasks');
  assert(/works from Slack or Discord/.test(last()), 'a chat-only verb on ClickUp gets a pointer, not a silent comment', last());

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
