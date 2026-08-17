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
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
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

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
