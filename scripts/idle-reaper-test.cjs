#!/usr/bin/env node
/* Idle-interactive reaper test — a detached member (headless=0) session idle past the configurable
 * timeout is closed (status→stopped), while recent/attached/claimed/disabled cases are left alone.
 * Isolated home; backend kill/hasClient stubbed so no real tmux is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-reap-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
// Stub the backend so the sweep is deterministic without a real tmux server.
let attached = new Set();               // tmux names with a "client" attached
const killed = [];
tm.backend.hasClient = (_space, tmux) => attached.has(tmux);
tm.backend.kill = (_space, tmux) => { killed.push(tmux); };
tm.backend.aliveNames = () => new Set(); // sweeps 1/2 no-op; we're testing sweep 3

const H = 3600_000;
let n = 0;
const mkSession = (o) => {
  const id = 'ts_' + (++n);
  const cols = { id, agent: 'website-bot', title: 't', task: 'x', tmux: 'aos-' + id, status: 'running',
    headless: 0, resident: 0, claimed_by: null, last_activity: null, spawned_by: 'm_alice',
    created_at: Date.now(), updated_at: Date.now(), ...o };
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,claimed_by,last_activity,spawned_by,created_at,updated_at) VALUES (@id,@agent,@title,@task,@tmux,@status,@headless,@resident,@claimed_by,@last_activity,@spawned_by,@created_at,@updated_at)").run(cols);
  return id;
};
const statusOf = (id) => aos.db.prepare("SELECT status s FROM term_sessions WHERE id=?").get(id).s;

console.log('\n\x1b[1m1) Settings.interactiveIdleTimeoutHours\x1b[0m');
assert(aos.settings.interactiveIdleTimeoutHours() === 48, 'unset → 48h default');
assert(aos.settings.setInteractiveIdleTimeoutHours(72) === 72, 'set 72 → 72');
assert(aos.settings.setInteractiveIdleTimeoutHours(0) === 0, 'set 0 → 0 (disabled)');
assert(aos.settings.setInteractiveIdleTimeoutHours(99999) === 24 * 30, 'clamps to 30 days max');

console.log('\n\x1b[1m2) reaper sweep (timeout = 48h)\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(48);

const stale = mkSession({ created_at: Date.now() - 96 * H });                 // 4 days idle → reap
const recent = mkSession({ created_at: Date.now() - 2 * H });                 // 2h → keep
const attachedStale = mkSession({ created_at: Date.now() - 96 * H, tmux: 'aos-ATTACHED' }); attached.add('aos-ATTACHED'); // in use → keep
const claimedStale = mkSession({ created_at: Date.now() - 96 * H, claimed_by: 'm_bob' }); // human owns it → keep
const unattended = mkSession({ created_at: Date.now() - 96 * H, headless: 1 });   // sweep-2 territory, not sweep 3 → keep here
const activeByLastAct = mkSession({ created_at: Date.now() - 96 * H, last_activity: Date.now() - 1 * H }); // recent turn → keep

tm.reapIdleSessions();

assert(statusOf(stale) === 'stopped', 'detached 4-day-idle member session → stopped');
assert(killed.includes('aos-' + stale), 'its pane was killed');
assert(statusOf(recent) === 'running', 'recent (2h) session → left running');
assert(statusOf(attachedStale) === 'running', 'attached session (client present) → left running');
assert(statusOf(claimedStale) === 'running', 'claimed take-over → left running');
assert(statusOf(unattended) === 'running', 'headless=1 unattended → not touched by sweep 3');
assert(statusOf(activeByLastAct) === 'running', 'old but recent last_activity → left running');

console.log('\n\x1b[1m3) disabled (timeout = 0) reaps nothing\x1b[0m');
aos.settings.setInteractiveIdleTimeoutHours(0);
const stale2 = mkSession({ created_at: Date.now() - 200 * H });
tm.reapIdleSessions();
assert(statusOf(stale2) === 'running', 'timeout 0 → even a 200h-idle session is left alone');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}IDLE REAPER: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
