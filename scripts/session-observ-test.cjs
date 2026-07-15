#!/usr/bin/env node
/* Session-observability test: (1) timer-driven crash detection in reapIdleSessions (sweepCrashed),
 * (2) the server-authoritative `blocked` field on listSessions, (3) the 'started' lifecycle event for
 * delegated (automation/task) runs. Isolated home; backend stubbed so no real tmux is needed. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-observ-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

let aliveSet = new Set();
tm.backend.aliveNames = () => aliveSet;
tm.backend.kill = () => {};
tm.backend.hasClient = () => false;
tm.backend.spawn = () => {};        // createSession mock-runtime path
tm.backend.capturePane = () => null; // captureTranscript / residentTurnState no-op
const events = [];
tm.setSessionEventNotifier((n) => events.push(n));
aos.settings.setInteractiveIdleTimeoutHours(0); // disable sweep-3 so it can't interfere with the crash test

let n = 0;
const mkSession = (o) => {
  const id = 'ts_' + (++n);
  const cols = { id, agent: 'website-bot', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claimed_by: null, last_activity: null, run_as: 'm_alice', spawned_by: 'm_alice',
    claude_session_id: null, created_at: Date.now(), updated_at: Date.now(), ...o };
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claimed_by,last_activity,run_as,spawned_by,claude_session_id,created_at,updated_at) VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claimed_by,@last_activity,@run_as,@spawned_by,@claude_session_id,@created_at,@updated_at)").run(cols);
  return id;
};
const statusOf = (id) => aos.db.prepare("SELECT status s FROM term_sessions WHERE id=?").get(id).s;
const addQuestion = (runId, status) => aos.db.prepare("INSERT INTO questions (id,run_id,tenant,agent,prompt,status,created_at) VALUES (?,?,?,?,?,?,?)").run('q_'+runId, runId, aos.tenant, 'website-bot', 'ok?', status, Date.now());

console.log('\n\x1b[1m1) timer-driven crash detection (sweepCrashed via reapIdleSessions)\x1b[0m');
const dead = mkSession({ tmux: 'aos-DEAD', created_at: Date.now() - 60_000 }); // pane gone, past 10s grace → crash
const liveOk = mkSession({ tmux: 'aos-LIVE' });                                 // pane alive → keep
const fresh = mkSession({ tmux: 'aos-FRESH', created_at: Date.now() - 2_000 }); // pane gone but within grace → keep
aliveSet = new Set(['aos-LIVE']);
tm.reapIdleSessions();
assert(statusOf(dead) === 'crashed', 'running row w/ vanished pane (past grace) → crashed on the timer', statusOf(dead));
assert(statusOf(liveOk) === 'running', 'running row w/ live pane → left running');
assert(statusOf(fresh) === 'running', 'vanished pane within 10s grace → left running (no false crash)');
assert(events.some((e) => e.kind === 'crashed' && e.sessionId === dead), 'crash fired a "crashed" session-event (drives the always-on DM)');
assert(!events.some((e) => e.kind === 'crashed' && e.sessionId === liveOk), 'live row did not fire a crash event');

console.log('\n\x1b[1m2) server-authoritative `blocked` field (listSessions)\x1b[0m');
const bQ = mkSession({ tmux: 'aos-BQ' });   addQuestion(bQ, 'pending');   // running + pending ask → blocked
const bNone = mkSession({ tmux: 'aos-BN' });                              // running, nothing → not blocked
const bAns = mkSession({ tmux: 'aos-BA' });  addQuestion(bAns, 'answered'); // answered question → not blocked
const bDone = mkSession({ tmux: 'aos-BD', status: 'done' }); addQuestion(bDone, 'pending'); // pending but not running → not blocked (running-gate)
aliveSet = new Set(['aos-BQ', 'aos-BN', 'aos-BA', 'aos-BD', 'aos-LIVE']); // keep them alive so listSessions won't crash them
const list = tm.listSessions();
const byId = Object.fromEntries(list.map((s) => [s.id, s]));
assert(byId[bQ].blocked === true, 'running + pending question → blocked:true');
assert(byId[bNone].blocked === false, 'running + no block → blocked:false');
assert(byId[bAns].blocked === false, 'answered question → blocked:false');
assert(byId[bDone].blocked === false, 'pending question on a DONE run → blocked:false (running-gate)');

console.log('\n\x1b[1m3) `started` lifecycle event — delegated runs only\x1b[0m');
const before = events.length;
const sAuto = tm.createSession('teambot', 'A', 'nightly digest', 'automation:cron1', true);
const sTask = tm.createSession('teambot', 'B', 'do work', 'task:t1', true);
const sConsole = tm.createSession('teambot', 'C', 'manual run', 'm_alice', false);
const sChat = tm.createSession('teambot', 'D', 'chat run', 'chat:teambot', false);
const started = events.slice(before).filter((e) => e.kind === 'started').map((e) => e.sessionId);
assert(started.includes(sAuto.id), 'automation: run fired a "started" event');
assert(started.includes(sTask.id), 'task: run fired a "started" event');
assert(!started.includes(sConsole.id), 'console (member) run did NOT fire "started" (operator is present)');
assert(!started.includes(sChat.id), 'chat run did NOT fire "started" (thread already acks)');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}SESSION OBSERV: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
