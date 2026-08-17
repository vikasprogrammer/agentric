#!/usr/bin/env node
/* A delivered keystroke is not a delivered TURN (`composerParked` + `LocalSessionBackend.injectText`).
 *
 * `injectText` used to return true whenever the two tmux calls exited 0. But an agent TUI collapses a big
 * send into a bracketed paste (`[Pasted text #N]`) and swallows a submit `Enter` that arrives while the
 * paste is still assembling — so the message sat in the composer, un-run, while the caller was told it had
 * landed. northwind 2026-08-17: 8 wake-ups parked across two agents, `check-resolve-tickets` showing
 * `❯ [Pasted text #4][Pasted text #5][Pasted text #6]` with a healthy idle claude in front of them, every
 * one recorded `delivered` and never retried. That false ack defeats the wake queue's whole guarantee.
 *
 * The fixtures below are REAL captures from that incident (parked) and from the same pane after a human
 * pressed Enter (submitted), trimmed to the last screenful. What this pins:
 *   - the paste chip on the prompt line reads as parked;
 *   - a cleared composer reads as submitted, even though the same text is echoed in the transcript above
 *     it — the check is anchored to the prompt line for exactly that reason;
 *   - a short typed message still on the prompt line reads as parked;
 *   - unrelated prompt content is not mistaken for our message.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-inject-submit-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
const { composerParked } = require(path.join(ROOT, 'dist/edge/session-backend.js'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 200) : ''}`));

const WAKE = '✅ Really done: engineer finished the task you handed off (tsk_2c220bafdd69cc55: "Uptime Kuma pods report the wrong installed version"). Result: fix merged and live. Pick your own work back up from here.';

// The pane as it actually looked, with three wake-ups stacked in the input box.
const PARKED = [
  '  a decision, includes the pod list) and `tsk_ca9a1ae868ab0ff3` ("Deployment success" over a dead app service.',
  '  on main meanwhile and overlaps it). Pick your own work back up from here.',
  '────────────────────────────────────────────────────────────────────────────────────────────',
  '❯ [Pasted text #4][Pasted text #5][Pasted text #6]save now writes a different file and restarts the app',
  '────────────────────────────────────────────────────────────────────────────────────────────',
  '   ◆ check-resolve-tickets #6271 · as Owner · Opus 5·high · ▓▓░░░░░░░░ 16% · wk 62% · $7.67  /rc',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

// The same pane after the Enter that finally submitted them: composer gone, text echoed in the transcript.
const SUBMITTED = [
  '  a decision, includes the pod list) and `tsk_ca9a1ae868ab0ff3` ("Deployment success" over a dead app service.',
  '  on main meanwhile and overlaps it). Pick your own work back up from here.',
  '────────────────────────────────────────────────────────────────────────────────────────────',
  '   ◆ check-resolve-tickets #6271 · as Owner · Opus 5·high · ▓▓░░░░░░░░ 16% · wk 62% · $7.67  /rc',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

console.log('\n\x1b[1m1) the incident, both ways round\x1b[0m');
assert(composerParked(PARKED, WAKE) === true, 'a paste chip on the prompt line is NOT a delivered turn');
assert(composerParked(SUBMITTED, WAKE) === false, 'a cleared composer is');

console.log('\n\x1b[1m2) the echo trap — why the check is anchored to the prompt line\x1b[0m');
{
  // After a real submit the message appears in the transcript. A naive "is the text on screen" check would
  // call every successful delivery parked, and the queue would then resume beside a working agent forever.
  const echoed = `  ${WAKE}\n────────────────────────────────\n  ⏵⏵ auto mode on`;
  assert(composerParked(echoed, WAKE) === false, 'the same text in the TRANSCRIPT is not the composer');
}

console.log('\n\x1b[1m3) a small message is typed, not pasted — still has to be checked\x1b[0m');
{
  const short = 'check the task status';
  assert(composerParked(`❯ ${short}\n  ⏵⏵ auto mode on`, short) === true, 'typed text left on the prompt line reads as parked');
  assert(composerParked('❯ ls -la\n  ⏵⏵ auto mode on', short) === false, 'somebody else\'s prompt content is not our message');
  assert(composerParked('❯\n  ⏵⏵ auto mode on', short) === false, 'a bare prompt is clear');
}

console.log('\n\x1b[1m4) degenerate input never reports a false failure\x1b[0m');
{
  assert(composerParked('', WAKE) === false, 'an empty capture is not evidence of parking');
  assert(composerParked('❯ x', 'hi') === false, 'a too-short head is not matched (no 2-char coincidences)');
}

// ── the caller policy: WHEN the check may be trusted ────────────────────────────────────────────────
// Verifying unconditionally cost a working run within the hour of shipping: a MID-TURN claude parks
// injected text in its composer on purpose and submits it at the next turn boundary — the documented
// contract of injectToSession — and that is indistinguishable from a failed submit by looking at the
// pane. northwind 2026-08-17: `ses_987f7efc` (fleet-janitor) was 3 minutes into a turn when a second
// wake-up arrived; the queued text read as "parked" and the same-transcript rule killed the run to
// resume it. So the composer check is only consulted when the row says no turn is in flight.
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const seen = [];
tm.backend.aliveNames = () => new Set(['aos-ses_busy', 'aos-ses_idle']);
tm.backend.injectText = (_s, tmux, text, submit, verify) => { seen.push({ tmux, verify }); return verify === false; };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;
aos.agents.set('a', { id: 'a', name: 'A', runtime: 'claude-code', dir: HOME });

const mk = (id, over) => {
  const now = Date.now();
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,created_at,updated_at,busy_since,last_activity)
    VALUES (?,?,?,?,?,?,1,0,'s',?,?,?,?)`).run(id, 'a', 't', 'x', 'aos-' + id, 'running', now - 60_000, now, over.busy_since, over.last_activity);
};
mk('ses_busy', { busy_since: Date.now() - 30_000, last_activity: null });   // mid-turn
mk('ses_idle', { busy_since: null, last_activity: Date.now() - 30_000 });   // sitting at the prompt

console.log('\n\x1b[1m5) a MID-TURN agent is never called a failure\x1b[0m');
{
  const r = tm.injectToSession('ses_busy', 'result of the task you handed off', true, 'system');
  const call = seen.find((c) => c.tmux === 'aos-ses_busy');
  assert(call && call.verify === false, 'the composer check is skipped while a turn is in flight', call);
  assert(r.ok === true, 'and a queued message counts as delivered — never kill a working run over it', r);
}

console.log('\n\x1b[1m6) an IDLE agent is still verified\x1b[0m');
{
  const r = tm.injectToSession('ses_idle', 'result of the task you handed off', true, 'system');
  const call = seen.find((c) => c.tmux === 'aos-ses_idle');
  assert(call && call.verify === true, 'nothing is running, so a full composer IS evidence of a failed submit', call);
  assert(r.ok === false && /composer/.test(r.error || ''), 'and the failure propagates, so the wake queue holds it', r);
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
