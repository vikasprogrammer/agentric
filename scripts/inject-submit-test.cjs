#!/usr/bin/env node
/* Injected text reaches a live pane AS A SUBMITTED LINE (`LocalSessionBackend.injectText`), against real tmux.
 *
 * The bug this guards: `send-keys -l <text>` followed immediately by `send-keys Enter` loses the Enter when
 * the text is large enough that the receiving TUI reads it as a bracketed paste — the Enter is swallowed by
 * the still-assembling paste and the message sits unsent in the composer. northwind 2026-08-17: 8 wake-ups
 * parked across two agents' input boxes, every one recorded `delivered` and never retried, until a human
 * pressed Enter and all of them ran at once. `injectText` now settles before pressing Enter, and presses it
 * twice with a longer pause the second time — the automated version of that human's late Enter.
 *
 * What this test does NOT do, deliberately: judge from the pane whether a turn started. Two builds tried
 * (v0.355.1, v0.356.2) and both were wrong in production — a claude TUI renders a SUBMITTED message with
 * the same `❯` glyph and paste chip as a parked one, and a mid-turn agent parks injected text on purpose.
 * Acting on that guess stopped two working runs. A real verdict needs the transcript, not the screen; until
 * that exists, `injectText` reports keystroke delivery and nothing more.
 *
 * Uses a real tmux pane running `cat`, which echoes what it receives and re-prints each COMPLETED line — so
 * "the line was submitted" is observable without a claude in the loop. Skips (exit 0) where tmux is absent.
 *
 * Scope limit, stated rather than faked: `cat` reads in canonical mode (MAX_CANON), so it cannot stand in
 * for a TUI's bracketed-paste handling and this test does not cover the multi-kilobyte case that produced
 * the incident. What it pins is that the submit Enter is delivered as its own keypress and completes the
 * line — the half that is testable off-production.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0) {
  console.log('inject-submit: tmux not installed — skipped');
  process.exit(0);
}

const { LocalSessionBackend } = require(path.join(ROOT, 'dist/edge/session-backend.js'));
const SOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aos-inject-test-')), 'tmux.sock');
const NAME = 'aos-inject-test';
const tmux = (...a) => spawnSync('tmux', ['-S', SOCK, ...a], { encoding: 'utf8' });
const pane = () => tmux('capture-pane', '-p', '-J', '-S', '-', '-t', NAME).stdout || '';   // full history: a long line scrolls off the screen
const cleanup = () => { tmux('kill-server'); try { fs.rmSync(path.dirname(SOCK), { recursive: true, force: true }); } catch { /* best effort */ } };

tmux('new-session', '-d', '-s', NAME, '-x', '200', '-y', '50', 'cat');
const backend = new LocalSessionBackend(SOCK, () => {});

console.log('\n\x1b[1m1) a short message is typed AND submitted\x1b[0m');
{
  const ok = backend.injectText('', NAME, 'check the task status', true);
  const p = pane();
  assert(ok === true, 'keystrokes delivered', ok);
  // `cat` echoes the typed characters, then re-prints the line once Enter completes it. Two occurrences
  // means the newline actually landed; one means it is still sitting on the input line unsent.
  assert((p.match(/check the task status/g) || []).length >= 2, 'the line was SUBMITTED, not left on the input line', p.slice(-200));
}

console.log('\n\x1b[1m2) submit:false types without sending\x1b[0m');
{
  const before = (pane().match(/draft only/g) || []).length;
  backend.injectText('', NAME, 'draft only', false);
  const after = (pane().match(/draft only/g) || []).length;
  assert(after === before + 1, 'it appears once (echoed), not twice (echoed + submitted)', { before, after });
}

cleanup();
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
