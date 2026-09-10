#!/usr/bin/env node
/* Pasting a file into an open terminal must work on every session whose PANE is alive — including the
 * `done`-but-still-running shape.
 *
 * The bug this pins: `attachFile` gated on `status === 'running'`, the status-folding liveness rule
 * `reachable()` exists to replace. An agent that calls `report` is stamped `done` while its claude keeps
 * running (on northwind at the time of the fix, 3 of 8 live panes were `done` rows), and the console
 * shows exactly those sessions green + attachable — so a human pasting a screenshot into the pane in
 * front of them got "session is not live", most of the time. Same defect class as the poke-back one
 * `injectToSession` already fixed.
 *
 * Isolated home, backend stubbed — no real tmux, no live data. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-attachfile-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 200) : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const agent = [...aos.agents.values()].find((a) => a.dir);
if (!agent) { console.log('attach-file-liveness: no agent with a working folder — skipped'); process.exit(0); }

const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const livePanes = new Set();
const injected = [];
tm.backend.aliveNames = () => livePanes;
tm.backend.injectText = (_space, tmux, text) => { injected.push({ tmux, text }); return true; };

let n = 0;
/** A session row + whether its tmux pane is alive right now (the two axes that used to be conflated). */
const mkSession = (status, paneAlive) => {
  const id = 'ts_' + (++n);
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,run_as,created_at,updated_at)
    VALUES (@id,@agent,'t','x',@tmux,@status,0,0,'m_alice',NULL,@t,@t)`)
    .run({ id, agent: agent.id, tmux: 'aos-' + id, status, t: Date.now() });
  if (paneAlive) livePanes.add('aos-' + id);
  return id;
};
const DATA = Buffer.from('\x89PNG\r\n\x1a\nfake');

console.log('\n\x1b[1m1) liveness is the PANE, not the row status\x1b[0m');
{
  const running = tm.attachFile(mkSession('running', true), 'a@b.co', DATA, 'png', 'shot.png');
  assert(running.ok === true, 'running + live pane → attached', running);

  // The regression itself.
  const reported = tm.attachFile(mkSession('done', true), 'a@b.co', DATA, 'png', 'shot.png');
  assert(reported.ok === true, 'REPORTED (`done`) but the pane is still alive → attached', reported);
  assert(/^\.inbox\//.test(reported.path || ''), '…saved into the agent\'s .inbox/', reported.path);
  assert(fs.existsSync(path.join(agent.dir, reported.path || 'x')), '…the bytes are on disk');
  assert(injected.some((i) => i.text.trim() === reported.path), '…and its path is typed into the pane', injected.at(-1));
}

console.log('\n\x1b[1m2) a session with no pane to paste into is still refused\x1b[0m');
{
  const dead = tm.attachFile(mkSession('done', false), 'a@b.co', DATA, 'png');
  assert(dead.ok === false && /not live/.test(dead.error || ''), 'ended run, pane gone → refused', dead);
  const stopped = tm.attachFile(mkSession('stopped', true), 'a@b.co', DATA, 'png');
  assert(stopped.ok === false, 'deliberately stopped → refused even if a leftover pane lingers', stopped);
  const crashed = tm.attachFile(mkSession('crashed', true), 'a@b.co', DATA, 'png');
  assert(crashed.ok === false, 'crashed → refused likewise', crashed);
  const unknown = tm.attachFile('ts_nope', 'a@b.co', DATA, 'png');
  assert(unknown.ok === false && /unknown session/.test(unknown.error || ''), 'unknown session → refused', unknown);
}

console.log('\n\x1b[1m3) the source no longer carries a status-based liveness gate here\x1b[0m');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/terminal.ts'), 'utf8');
  const body = /attachFile\(sessionId: string[\s\S]*?\n  }\n/.exec(src)[0];
  assert(/this\.reachable\(sessionId\)/.test(body), 'attachFile asks reachable()');
  assert(!/row\.status !== 'running'/.test(body), '…and never re-derives liveness from the row status');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
