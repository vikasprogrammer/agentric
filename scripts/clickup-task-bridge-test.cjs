/* The `/agentric` ClickUp bridge — one ClickUp ticket, one Agentric task (docs/clickup-task-bridge-plan.md).
 *
 * Pins: the first `/agentric` comment on a ticket CREATES the task (`#<ref> <name>`, the description as its
 * body, keyed `clickup:<ticket>`); every later one lands in that task's DISCUSSION instead of creating
 * another; `/agentric <agent> …` dispatches that agent bound to the ticket (so it can `clickup_reply`) and
 * reopens a closed task; an unmapped commenter is recorded as `clickup`; and the unique key refuses a
 * second row for one ticket. Also pinned: `/agentric <agent>` now routes on the chat platforms that don't
 * strip it themselves (it used to be read as an agent called "agentric").
 *
 * Isolated home; createSession / the ClickUp API are stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cu-bridge-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const cu = require(path.join(ROOT, 'dist/connectors/clickup.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { ClickupIngress } = require(path.join(ROOT, 'dist/edge/clickup-ingress.js'));

(async () => {
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  const autos = new Automations(aos, tm);
  const AGENT_DIR = path.join(HOME, 'agent-ops');
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  aos.agents.set('support-ops', { id: 'support-ops', name: 'Support Ops', runtime: 'claude-code', dir: AGENT_DIR });
  const danaId = aos.team.invite({ email: 'dana@example.com', role: 'member' }).member.id;

  let seq = 0;
  const spawned = [];
  tm.createSession = (agentId, title, task, spawnedBy, headless, slack, discord, runAs, resume, resident, tuning, clickup) => {
    const id = `r${++seq}`;
    spawned.push({ agentId, title, task, spawnedBy, clickup, id });
    tm.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, agentId, title || '', task || '', id, 'exited', 'x', Date.now(), Date.now());
    return { id, tmux: id };
  };
  aos.settings.clickupToken = () => 'pk_test';
  aos.settings.clickupConfigured = () => true;
  aos.settings.autoRouteEnabled = () => false;

  const comments = [];
  cu.addComment = async (_t, taskId, text) => { comments.push({ taskId, text }); return { ok: true, id: `c${comments.length + 100}` }; };
  cu.addReaction = async () => ({ ok: true });
  cu.fetchTask = async (_t, id) => ({ id, customId: id === 'T1' ? 'ABC-1' : '', name: `Checkout broken on ${id}`, description: 'Customer cannot pay.\nSteps: …', url: `https://app.clickup.com/t/${id}` });
  let cid = 0;
  const say = (text, email = 'dana@example.com') => { cu.fetchLatestComment = async () => ({ id: `cm${++cid}`, text, userId: '9', userEmail: email, files: [] }); };

  const ingress = new ClickupIngress(aos, autos, 'https://aos.example.com');
  const byKey = (k) => aos.tasks.byExternalKey(aos.tenant, k);
  const discussion = (id) => tm.discussionTimeline(id).filter((e) => e.kind === 'chat').map((e) => e.body);

  // ── 1. first comment creates the task ─────────────────────────────────────────
  console.log('\nThe first /agentric comment creates the ticket\'s task');
  say('/agentric please track this');
  let out = await ingress.dispatch('T1', {});
  const t1 = byKey('clickup:T1');
  assert(!!t1, 'a task keyed clickup:T1 exists');
  assert(t1?.title === '#ABC-1 Checkout broken on T1', 'titled `#<custom id> <ticket name>`', t1?.title);
  assert(/app\.clickup\.com\/t\/T1/.test(t1?.body || '') && /Customer cannot pay/.test(t1?.body || ''), 'its body carries the ticket link + description');
  assert(t1?.createdBy === danaId && t1?.owner === danaId, 'filed by and owned by the commenting member', `${t1?.createdBy}/${t1?.owner}`);
  assert(t1?.labels.includes('clickup'), 'labelled clickup');
  assert(discussion(t1.id).includes('please track this'), 'the comment text lands in the task discussion');
  assert(out.status === 'agentric:discussed' && spawned.length === 0, 'and nothing is dispatched — no agent was named', out.status);
  assert(comments.length === 1 && comments[0].text.includes('https://aos.example.com/#/tasks/' + t1.id), 'ONE comment posts the Agentric task link back', comments[0]?.text);

  // ── 2. later comments go to the same task's discussion ────────────────────────
  console.log('\nLater /agentric comments land in the SAME task');
  say('/agentric here are the logs');
  out = await ingress.dispatch('T1', {});
  const count = aos.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE external_key = 'clickup:T1'").get().n;
  assert(count === 1, 'still exactly one task for the ticket', String(count));
  assert(discussion(t1.id).includes('here are the logs'), 'the new comment is in its discussion');
  assert(comments.length === 1, 'no second link comment — the 👀 reaction acknowledges a repeat');

  say('/agentric');
  out = await ingress.dispatch('T1', {});
  assert(out.status === 'agentric:linked', 'a bare /agentric just (re)links', out.status);

  // ── 3. naming an agent dispatches it, bound to the ticket ─────────────────────
  console.log('\n/agentric <agent> puts that agent on the task');
  say('/agentric support-ops find the root cause');
  out = await ingress.dispatch('T1', {});
  let t = aos.tasks.get(t1.id);
  const run = spawned[spawned.length - 1];
  assert(out.status === 'agentric:dispatched' && spawned.length === 1, 'the named agent is dispatched', out.status);
  assert(t.assignee === 'agent:support-ops', 'and assigned the task');
  assert(run?.spawnedBy === `task:${t1.id}`, 'as a run OF the task (so it shows in the task room)');
  assert(run?.clickup?.taskId === 'T1', 'bound to the ClickUp ticket, so clickup_reply answers there', JSON.stringify(run?.clickup));
  assert(/find the root cause/.test(run?.task || '') && /clickup_reply/.test(run?.task || ''), 'its prompt carries the request and how to reply');
  assert(discussion(t1.id).includes('find the root cause'), 'the request is on the record too');

  // ── 4. a closed task reopens for rework ───────────────────────────────────────
  console.log('\nA done task is reopened when an agent is asked to rework it');
  aos.db.prepare("UPDATE tasks SET status = 'done', last_session_id = NULL WHERE id = ?").run(t1.id);
  say('/agentric support-ops the fix regressed, rework it');
  out = await ingress.dispatch('T1', {});
  t = aos.tasks.get(t1.id);
  assert(t.status !== 'done' && out.status === 'agentric:dispatched', 'reopened and dispatched', `${t.status} / ${out.status}`);

  // ── 5. identity + fallbacks ───────────────────────────────────────────────────
  console.log('\nIdentity and fallbacks');
  say('/agentric from someone we do not know', 'stranger@elsewhere.test');
  await ingress.dispatch('T2', {});
  const t2 = byKey('clickup:T2');
  assert(t2?.createdBy === 'clickup' && !t2?.owner, 'an unmapped commenter files as `clickup`, ownerless', `${t2?.createdBy}/${t2?.owner}`);
  assert(t2?.title === '#T2 Checkout broken on T2', 'no custom id → the raw ticket id', t2?.title);

  cu.fetchTask = async () => null;
  say('/agentric ticket fetch failed');
  await ingress.dispatch('T3', {});
  assert(byKey('clickup:T3')?.title === '#T3 ClickUp ticket', 'a failed ticket fetch still links, with a placeholder title', byKey('clickup:T3')?.title);

  let threw = false;
  try { aos.tasks.create({ tenant: aos.tenant, title: 'dup', createdBy: 'x', externalKey: 'clickup:T1' }); } catch { threw = true; }
  assert(threw, 'the unique key refuses a second task for one ticket (a racing webhook re-reads instead)');

  say('/agentric-bot hello');
  out = await ingress.dispatch('T4', {});
  assert(!byKey('clickup:T4') && !String(out.status).startsWith('agentric'), '`/agentric-bot` is not the bridge', out.status);

  // ── 6. /agentric <agent> routes on the platforms that don't strip it ──────────
  console.log('\n/agentric <agent> is understood outside Slack');
  const norm = (s) => autos.normalizeChatCommand(s);
  assert(norm('/agentric support-ops fix X') === '/support-ops fix X', '`/agentric support-ops …` → `/support-ops …`', norm('/agentric support-ops fix X'));
  assert(norm('/agent-os support-ops fix X') === '/support-ops fix X', '`/agent-os …` still works');
  assert(autos.routeChat('/agentric support-ops fix X').agentId === 'support-ops', 'and the router picks the agent instead of answering "no agent named agentric"');

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
