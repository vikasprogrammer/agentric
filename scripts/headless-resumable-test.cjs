#!/usr/bin/env node
/* Unattended runs are resumable too — the launch env is written for EVERY lane, and taking one over
 * un-marks it.
 *
 * Why this exists: `resumable` is derived from a FILE (`<home>/connectors/session-<id>.env`), and that
 * file used to be written only for interactive launches. So the flag quietly doubled as "this run is
 * attended", and a headless run taken over while its pane was still LIVE was stuck non-resumable forever:
 * `claimSession` marks the row and relaunches nothing, so nothing ever wrote the env, and the console's
 * Reload / Reload-on-another-account items stayed hidden for it (live instawp run, 2026-08-27 — claimed,
 * headless=0, a pinned claude_session_id, and still no Reload). Pinned here:
 *   1. an UNATTENDED launch persists the env (so the run reports `resumable`) and marks it UNATTENDED;
 *   2. taking it over strips that marker, so the next resurrect comes up attended rather than being
 *      handed straight back to the turn-end reaper;
 *   3. `blockResume` can now actually fence an unattended run off from ttyd's auto-reconnect.
 * Isolated home; the session backend is stubbed, so no tmux and no real `claude` are involved. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-headless-resumable-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

// ── stub backend: no tmux, no claude; we only care about what lands on disk / in the row ──────────
const livePanes = new Set();
tm.backend.aliveNames = () => new Set(livePanes);
tm.backend.spawn = (_s, o) => { livePanes.add(o.tmuxName); };
tm.backend.kill = (_s, tmux) => { livePanes.delete(tmux); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

const AGENT = 'agent-author';
const envPath = (id) => path.join(aos.paths.connectors, `session-${id}.env`);
const envText = (id) => (fs.existsSync(envPath(id)) ? fs.readFileSync(envPath(id), 'utf8') : '');
const listed = (id) => tm.listSessions().find((s) => s.id === id);
/** The launch is scheduled off the response path (see launchAgentRuntime), so let it land. */
const settle = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  console.log('\n\x1b[1m1) an UNATTENDED launch persists its resurrect env\x1b[0m');
  const s = tm.createSession(AGENT, 'nightly qa', 'run the suite', 'automation:a1', true);
  await settle();
  assert(fs.existsSync(envPath(s.id)), 'session-<id>.env written for a headless run', 'this is the whole bug');
  assert(/^export UNATTENDED='?1'?$/m.test(envText(s.id)), 'env marks the unattended lane');
  assert(listed(s.id)?.resumable === true, 'listSessions reports resumable:true → the console offers Reload');
  assert(listed(s.id)?.headless === true, 'still headless — resumable is not "attended"');

  console.log('\x1b[1m\n2) taking over a LIVE unattended run un-marks the lane\x1b[0m');
  const r = tm.claimSession(s.id, 'boss@example.com');
  assert(r.ok === true, 'claimSession ok', r.error);
  assert(!/UNATTENDED/.test(envText(s.id)), 'UNATTENDED stripped → a later reattach/Reload comes up attended');
  assert(/^export CLAUDE_SESSION_ID=/m.test(envText(s.id)), 'the rest of the launch context survives the patch');
  const row = aos.db.prepare('SELECT headless, claimed_by FROM term_sessions WHERE id = ?').get(s.id);
  assert(row.headless === 0 && row.claimed_by === 'boss@example.com', 'row reads attended + claimed');
  assert(listed(s.id)?.resumable === true, 'still resumable after the patch (Reload stays reachable)');

  console.log('\x1b[1m\n3) reloadSession accepts an unattended run now\x1b[0m');
  const s2 = tm.createSession(AGENT, 'cron', 'sweep', 'automation:a2', true);
  await settle();
  const rl = tm.reloadSession(s2.id, 'boss@example.com');
  assert(rl.ok === true, 'reload of a headless run is no longer refused', rl.error);
  assert(!fs.existsSync(path.join(aos.paths.connectors, `session-${s2.id}.stopped`)), 'no stay-stopped sentinel — it must resurrect on reattach');

  console.log('\x1b[1m\n4) the turn-end reaper still fences it off from ttyd auto-reconnect\x1b[0m');
  const s3 = tm.createSession(AGENT, 'cron', 'sweep', 'automation:a3', true);
  await settle();
  tm.markEnded(s3.id);
  assert(fs.existsSync(path.join(aos.paths.connectors, `session-${s3.id}.stopped`)), 'blockResume drops the sentinel for a reaped unattended run');

  console.log('\x1b[1m\n5) a run claimed while LIVE and stopped afterwards can still be brought back\x1b[0m');
  // The shape that had no way back at all: claimed while alive (so nothing relaunched → no env), then
  // stopped. `takeoverRun` must resurrect it — the console's Take over is wired straight to this.
  const s4 = tm.createSession(AGENT, 'qa', 'check the build', 'automation:a4', true);
  await settle();
  fs.rmSync(envPath(s4.id), { force: true });                 // pre-fix row: claimed live, never got an env
  tm.claimSession(s4.id, 'boss@example.com');
  tm.stopSession(s4.id, 'boss@example.com');
  assert(livePanes.has('aos-' + s4.id) === false, 'pane is gone');
  assert(listed(s4.id)?.resumable === false, 'no env → not resumable (the dead end)');
  const to = tm.takeoverRun(s4.id, 'boss@example.com');
  assert(to.ok === true, 'takeoverRun resurrects it', to.error);
  await settle();
  assert(fs.existsSync(envPath(s4.id)), 'and writes the env, so it is resumable from here on');
  assert(!fs.existsSync(path.join(aos.paths.connectors, `session-${s4.id}.stopped`)), 'the stop sentinel is lifted');
  assert(aos.db.prepare('SELECT status FROM term_sessions WHERE id = ?').get(s4.id).status === 'running', 'row back to running');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(fail ? 1 : 0);
})();
