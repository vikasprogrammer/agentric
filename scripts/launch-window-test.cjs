#!/usr/bin/env node
/* A message that arrives while its session is still STARTING.
 *
 * `launchAgentRuntime` registers a session in `launching` synchronously and brings the pane up a few
 * seconds later (mints, materialisation, tmux). In that window `reachable` is true — deliberately, so a
 * second turn can't launch a competing claude on the same transcript — but there is no pane to type
 * into. So `deliverToResident` failed, `reviveResident` refused (the session IS reachable), and every
 * continuation caller (Slack/Discord/DM/ClickUp/Telegram threads) fell through to a FRESH spawn bound to
 * the same thread. Live on instawp 2026-10-23: a Slack reply landing ~0.8s after another one revived a
 * reaped thread got a second infra-ops session of its own.
 *
 * The fix queues the message and folds it into the launch prompt. Isolated home; backend stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-launchwin-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

const livePanes = new Set();
const spawns = [];
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.injectText = (_s, tmux) => livePanes.has(tmux);
tm.backend.spawn = (_s, o) => { spawns.push(o); livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

/** The task the launcher actually handed the runtime — by file on the local lane. */
const launchedTask = (o) => (o.env.TASK_FILE ? fs.readFileSync(o.env.TASK_FILE, 'utf8') : Buffer.from(o.env.TASK_B64 || '', 'base64').toString('utf8'));
/** Run the deferred launch to completion: the setImmediate, then its async body. */
const settle = async (id) => { for (let i = 0; i < 400 && tm.launching.has(id); i++) await new Promise((r) => setTimeout(r, 5)); };
const sessionCount = () => aos.db.prepare('SELECT COUNT(*) c FROM term_sessions').get().c;
const audits = (id, type) => aos.db.prepare('SELECT data FROM audit_events WHERE run_id = ? AND type = ? ORDER BY rowid').all(id, type).map((r) => JSON.parse(r.data));

let n = 0;
/** A REAPED resident chat session bound to a Slack thread: resumable, no pane. */
const mkReaped = (thread) => {
  const id = 'ses_lw_' + (++n);
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claude_session_id,secret,spawned_by,run_as,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'agent-author', 't', 'first ask', 'aos-' + id, 'stopped', 0, 1, 'cs-' + id, 'sec', 'chat:agent-author', null, Date.now(), Date.now());
  aos.db.prepare('INSERT INTO slack_threads (session_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)').run(id, 'C1', thread, Date.now());
  return id;
};

(async () => {
  console.log('\n\x1b[1m1) a follow-up during the launch is queued, not lost\x1b[0m');
  {
    const id = mkReaped('1.0');
    assert(tm.reviveResident(id, 'look at the other sites too'), 'the first message revives the reaped session');
    assert(tm.launching.has(id), 'which is now launching — no pane yet');
    assert(tm.deliverToResident(id, 'and check example.org\nfirst'), 'a second message during the boot window is ACCEPTED (it used to fail here)');
    const d = audits(id, 'chat.delivered').pop();
    assert(d && d.turn === 'launching' && d.queued === true, 'audited as queued behind the launch', JSON.stringify(d));
    assert(tm.reviveResident(id, 'x') === false, 'a revive while launching is still refused — one claude per transcript');
    await settle(id);
    const o = spawns.find((s) => s.sessionId === id);
    assert(!!o, 'the launch went ahead');
    const task = o ? launchedTask(o) : '';
    assert(/look at the other sites too/.test(task), 'the original message is the prompt');
    assert(/and check example\.org first/.test(task), 'and the queued follow-up rides in the same prompt', task);
    assert(task.indexOf('look at the other') < task.indexOf('example.org'), 'oldest first');
    assert(!tm.launchInbox.has(id), 'the queue is emptied by the fold');
    assert(tm.deliverToResident(id, 'third'), 'once the pane is up, delivery is the normal warm path');
    assert(audits(id, 'chat.delivered').pop().turn !== 'launching', 'and is no longer labelled as queued behind a launch');
  }

  console.log('\n\x1b[1m2) the Slack thread case end to end: no second session\x1b[0m');
  {
    const id = mkReaped('2.0');
    const before = sessionCount();
    const ev = (text) => ({ channel: 'C1', threadTs: '2.0', actorLabel: 'Owner', text, raw: {} });
    const a = autos.continueSlackThread(ev('its fine, but you only checked 1 site'));
    const b = autos.continueSlackThread(ev('there are many others in the original message'));
    assert(a.status === 'revived' && a.sessionId === id, 'the first reply revives the bound session', JSON.stringify(a));
    assert(b.status === 'delivered' && b.sessionId === id, 'the second, inside the boot window, joins it', JSON.stringify(b));
    assert(sessionCount() === before, 'and no new session row was created (the caller would have spawned one on `none`)');
    await settle(id);
    const task = launchedTask(spawns.find((s) => s.sessionId === id));
    assert(/only checked 1 site/.test(task) && /many others/.test(task), 'the agent starts with BOTH messages');
  }

  console.log('\n\x1b[1m3) a failed launch drops its queue\x1b[0m');
  {
    const id = mkReaped('3.0');
    const realSpawn = tm.backend.spawn;
    tm.backend.spawn = () => { throw new Error('tmux: no server'); };
    tm.reviveResident(id, 'go');
    tm.deliverToResident(id, 'queued');
    await settle(id);
    tm.backend.spawn = realSpawn;
    assert(!tm.launchInbox.has(id), 'nothing lingers to be folded into some later, unrelated launch');
    assert(aos.db.prepare('SELECT status FROM term_sessions WHERE id = ?').get(id).status === 'crashed', 'the row reads crashed, as before');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
