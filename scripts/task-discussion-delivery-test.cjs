#!/usr/bin/env node
/* A task-room reply REACHES the run working the task.
 *
 * The Discussion is where a human watches work happen, but a plain message posted there used to reach the
 * agent only when the agent happened to be BLOCKED on an `ask` — any other message sat in the timeline
 * until the agent next read `task_get`, which for a mid-turn run is never. `postTaskDiscussion` now routes
 * an unrouted human message into the live run: answering an open question when there is one, else typing
 * it into the pane. The one case it refuses to guess is TWO live runs — it delivers to neither and hands
 * the choice back, because the wrong pick talks to the wrong worker.
 *
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-task-delivery-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations, buildTaskPrompt, DISCUSSION_PREFIX } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

// ── stub backend: we control which panes are "alive" and record every keystroke delivery ────────
let livePanes = new Set();
const injected = [];
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux, text) => { injected.push({ tmux, text }); return livePanes.has(tmux); };
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

// A real agent id, so an `@builder` mention resolves to an agent (and not to a member handle).
aos.agents.set('builder', { id: 'builder', name: 'Builder', runtime: 'claude-code', dir: HOME });
aos.team.bootstrapOwner('alice@testco.dev', 'Alice');
const alice = aos.team.getMemberByEmail('alice@testco.dev');

let n = 0;
/** A session row bound to `taskId` by the `task:<id>` provenance the dispatcher stamps. */
const mkRun = (taskId, agent, opts = {}) => {
  const id = 'ses_tsk_' + (++n);
  const cols = {
    id, agent, title: 'run', task: 'do it', tmux: 'aos-' + id, status: 'running',
    headless: 1, resident: 0, claude_session_id: 'cs-' + id, secret: 'sec', spawned_by: `task:${taskId}`,
    run_as: alice.id, busy_since: null, last_activity: Date.now(), created_at: Date.now(), updated_at: Date.now(), ...opts,
  };
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,busy_since,last_activity,created_at,updated_at)
    VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claude_session_id,@secret,@spawned_by,@run_as,@busy_since,@last_activity,@created_at,@updated_at)`).run(cols);
  if (cols.status === 'running') livePanes.add(cols.tmux);
  return id;
};
const mkTask = (title) => aos.tasks.create({ tenant: aos.tenant, title, owner: alice.id, createdBy: alice.id });
const post = (taskId, body) => autos.postTaskDiscussion({ taskId, author: alice.id, body, runAs: alice.id });
const sentTo = (sessionId) => injected.filter((i) => i.tmux === 'aos-' + sessionId);

console.log('\n\x1b[1m1) no live run — the message is the record, nothing to deliver into\x1b[0m');
{
  const t = mkTask('quiet task');
  const before = injected.length;
  const r = post(t.id, 'any progress?');
  assert(r.ok && r.entry, 'message stored');
  assert(r.delivery && r.delivery.status === 'none', 'delivery: none', JSON.stringify(r.delivery));
  assert(injected.length === before, 'nothing typed into any pane');
}

console.log('\n\x1b[1m2) exactly one live run — the reply lands in its pane\x1b[0m');
{
  const t = mkTask('one worker');
  const s = mkRun(t.id, 'builder');
  aos.tasks.markDispatched(t.id, s);
  const r = post(t.id, 'stop after the current file');
  assert(r.delivery && r.delivery.status === 'delivered', 'delivery: delivered', JSON.stringify(r.delivery));
  assert(r.delivery.sessionId === s && r.delivery.agent === 'builder', 'names the run it reached');
  assert(sentTo(s).some((i) => i.text.includes('stop after the current file')), 'the body was typed into the pane');
  assert(sentTo(s)[0].text.includes('Alice'), 'attributed to the human who typed it');
  assert(sentTo(s)[0].text.startsWith(DISCUSSION_PREFIX), 'carries the room prefix the dispatch prompt taught');
  assert(sentTo(s)[0].text.includes('task_say'), 'and the way to reply back into the room');
  const a = aos.db.prepare("SELECT data FROM audit_events WHERE run_id = ? AND type = 'task.discussion.delivered'").all(s);
  assert(a.length === 1, 'one task.discussion.delivered audit event');
}

console.log('\n\x1b[1m3) the run is BLOCKED on an ask — the reply answers it instead of queueing behind it\x1b[0m');
{
  const t = mkTask('blocked worker');
  const s = mkRun(t.id, 'builder');
  aos.tasks.markDispatched(t.id, s);
  const q = tm.askQuestion(s, 'builder', 'Which branch should I push to?');
  assert(Boolean(q.id), 'question pending on the run');
  const before = injected.length;
  const r = post(t.id, 'push to main');
  assert(r.delivery && r.delivery.status === 'answered', 'delivery: answered', JSON.stringify(r.delivery));
  assert(injected.length === before, 'no send-keys — answering unblocks the turn on its own');
  const row = aos.db.prepare('SELECT status, answer FROM questions WHERE id = ?').get(q.id);
  assert(row.status === 'answered' && row.answer === 'push to main', 'the question carries the answer');
}

console.log('\n\x1b[1m4) TWO live runs — deliver to neither, ask the human which one\x1b[0m');
{
  const t = mkTask('two workers');
  const a = mkRun(t.id, 'builder');
  const b = mkRun(t.id, 'reviewer');
  aos.tasks.markDispatched(t.id, a);
  const before = injected.length;
  const r = post(t.id, 'hold on');
  assert(r.delivery && r.delivery.status === 'choose', 'delivery: choose', JSON.stringify(r.delivery));
  assert(r.delivery.runs.length === 2, 'both live runs offered');
  assert(injected.length === before, 'NOTHING delivered while the target is ambiguous');
  assert(r.entry && r.entry.body === 'hold on', 'the message is still on the record');

  // The human picks — only that run gets it.
  const d = autos.deliverDiscussionToRun(t.id, 'hold on', 'Alice', alice.id, b);
  assert(d.status === 'delivered' && d.sessionId === b, 'picked run receives it', JSON.stringify(d));
  assert(sentTo(b).some((i) => i.text.includes('hold on')), 'typed into the picked pane');
  assert(sentTo(a).length === 0, 'the other run was never written to');
}

console.log('\n\x1b[1m5) picking a run that has since ended reads as stale, not as a silent retarget\x1b[0m');
{
  const t = mkTask('ended pick');
  const a = mkRun(t.id, 'builder');
  const b = mkRun(t.id, 'reviewer');
  aos.tasks.markDispatched(t.id, a);
  livePanes.delete('aos-' + b);
  aos.db.prepare("UPDATE term_sessions SET status = 'done' WHERE id = ?").run(b);
  const before = injected.length;
  const d = autos.deliverDiscussionToRun(t.id, 'hold on', 'Alice', alice.id, b);
  assert(d.status === 'stale', 'delivery: stale', JSON.stringify(d));
  assert(injected.length === before, 'and it did NOT fall through to the surviving run');
}

console.log('\n\x1b[1m6) an @mention already routed the message — no second delivery\x1b[0m');
{
  const t = mkTask('mentioned');
  const s = mkRun(t.id, 'builder');
  aos.tasks.markDispatched(t.id, s);
  const before = sentTo(s).length;
  const r = post(t.id, '@builder can you rebase this?');
  assert(r.agentRuns && r.agentRuns.length === 1, 'the mention path handled it');
  assert(r.delivery === undefined, 'no separate delivery attempt', JSON.stringify(r.delivery));
  assert(sentTo(s).length === before + 1, 'the pane got the message exactly once');
}

console.log('\n\x1b[1m6b) the agent is TOLD the room exists — both directions\x1b[0m');
{
  for (const resuming of [false, true]) {
    const p = buildTaskPrompt({ id: 'tsk_x', title: 'ship it', body: 'do the thing' }, { resuming });
    const lane = resuming ? 'resuming' : 'fresh';
    assert(p.includes('task_say'), `${lane} prompt: how to speak into the room`);
    assert(p.includes(DISCUSSION_PREFIX), `${lane} prompt: how an incoming room message looks`);
    assert(p.includes('task_get'), `${lane} prompt: how to read the conversation so far`);
  }
}

console.log('\n\x1b[1m7) an AGENT posting into the discussion never routes back into a pane\x1b[0m');
{
  const t = mkTask('agent speaks');
  const s = mkRun(t.id, 'builder');
  aos.tasks.markDispatched(t.id, s);
  const before = injected.length;
  const r = autos.postTaskDiscussion({ taskId: t.id, author: `agent:builder`, agent: 'builder', body: 'done with step 1' });
  assert(r.ok && r.delivery === undefined, 'no delivery for an agent-authored message');
  assert(injected.length === before, 'nothing typed — an agent talking to itself is a loop');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
