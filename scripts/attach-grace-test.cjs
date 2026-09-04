#!/usr/bin/env node
/**
 * attach.sh's launch-grace window — the falsifier for the "can't find session: aos-…" attach race.
 *
 * ttyd runs terminal/attach.sh instead of a bare `tmux attach`. When the browser opens a terminal the
 * instant a spawn returns, the pane may not exist yet, so the wrapper waits before deciding whether the
 * session is "coming up" or "genuinely gone". That wait used to be a fixed ~3s, which is really a guess
 * about how fast the BOX is — and on a loaded host the guess loses. Observed on instawp at load 76
 * (2026-08-13): row written 12:01:23.037, `tmux new-session` landed 12:01:36.324 — a 13.3s gap. The
 * wait expired, the resurrect branch found no env file (a brand-new run hasn't written one), and the
 * plain-attach tail greeted the user with tmux's raw "can't find session: aos-ses_04fbb19ed27833d2"
 * for a run that finished `success` four minutes later.
 *
 * The fix replaces the guess with a signal: the server holds `session-<id>.launching` in AOS_SESSION_DIR
 * for exactly the window between "row written" and "pane exists" (TerminalManager.markLaunching), and
 * the wrapper waits while it's there. What must stay true:
 *
 *   1. SLOW LAUNCH  — marker present, pane appears at +6s (past the old 3s guess) → attaches. Never
 *                     "can't find session". This is the live bug, reproduced.
 *   2. NO MARKER    — nothing launching, pane never appears → still gives up on the ~3s floor, so a
 *                     genuinely dead session doesn't hang the terminal. (Unchanged behaviour.)
 *   3. FAILED LAUNCH— marker present then cleared with no pane (the launch threw; `finally` releases it)
 *                     → stops waiting promptly instead of sitting out the 120s ceiling.
 *
 * Method: run attach.sh headless with no tty. Whichever branch it ends in, it ends in `exec tmux attach`,
 * and tmux's own stderr says which one — "can't find session" (gave up) vs "open terminal failed: not a
 * terminal" (found the session, then failed only for want of a tty). That discriminator IS the bug string,
 * so the test asserts on the exact text a user would have seen.
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ATTACH = path.join(__dirname, '..', 'terminal', 'attach.sh');
const GONE = /can't find session/i;      // the wrapper gave up and plain-attached a dead name
const NO_TTY = /not a terminal/i;        // the wrapper found the session (headless can't attach)

if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).error) {
  console.log('attach-grace: tmux not installed — skipped');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-attach-'));
const sock = path.join(dir, 'tmux.sock');
const cleanup = () => {
  spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' });
  fs.rmSync(dir, { recursive: true, force: true });
};

// Hold one unrelated pane open for the whole run. A real box always has other sessions on the socket,
// and tmux's message depends on that: attaching a dead name says "can't find session: <name>" when the
// server has sessions but "no sessions" when it has none. Without this the assertions would read
// differently depending on which case ran first — and we want to assert on the exact string the live
// incident produced, not on an artefact of an empty tmux server.
spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'aos-keepalive', 'sleep', '600'], { stdio: 'ignore' });

/** Run attach.sh against `name`, headless. Resolves with its stderr + how long it waited. */
const runAttach = (name) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('bash', [ATTACH, sock, name], { env: { ...process.env, AOS_SESSION_DIR: dir } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', () => {});
    p.on('close', () => resolve({ err, ms: Date.now() - t0 }));
  });

// attach.sh polls on a fixed tick, and this test has to age a pane past its floor in REAL time — at the
// shipped 0.25s tick that was 12.7s of every deploy spent sleeping. Run the script on a 5x faster tick
// and scale every wait here by the same factor: the floor (12 ticks) and ceiling (480 ticks) are
// unchanged in TICKS, so what's under test — "follow the marker, not a fixed guess" — is identical.
const TICK_S = 0.05;
const SCALE = TICK_S / 0.25;
const ms = (shipped) => Math.round(shipped * SCALE); // a duration expressed in shipped-tick terms
process.env.AOS_ATTACH_TICK_S = String(TICK_S);

const marker = (id) => path.join(dir, `session-${id}.launching`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL ' + msg); cleanup(); process.exit(1); };

(async () => {
  // ---- 1. Slow launch: the pane lands at +6s, twice the old fixed guess. -------------------------
  const slow = 'ses_slowlaunch';
  fs.writeFileSync(marker(slow), '');
  const slowRun = runAttach('aos-' + slow);
  await sleep(ms(6000));
  spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'aos-' + slow, 'sleep', '60'], { stdio: 'ignore' });
  fs.rmSync(marker(slow), { force: true }); // the server clears it once the pane exists
  const r1 = await slowRun;
  if (GONE.test(r1.err)) fail(`slow launch surfaced tmux's "can't find session" — the 13s-spawn bug is back:\n${r1.err.trim()}`);
  if (!NO_TTY.test(r1.err)) fail(`slow launch did not reach the pane (expected a no-tty attach failure), got:\n${r1.err.trim()}`);
  if (r1.ms < ms(6000)) fail(`slow launch returned in ${r1.ms}ms — it cannot have waited for a +6s pane`);
  console.log(`  ok  slow launch (pane at +6s in shipped ticks) attaches after ${(r1.ms / 1000).toFixed(1)}s — no "can't find session"`);

  // ---- 2. No marker, no pane: still a prompt ~3s give-up, so a dead session can't hang. ----------
  const r2 = await runAttach('aos-ses_neverexisted');
  if (!GONE.test(r2.err)) fail(`a genuinely dead session should end in tmux's not-found, got:\n${r2.err.trim()}`);
  if (r2.ms > ms(6000)) fail(`no-marker give-up took ${r2.ms}ms — the ~3s floor regressed into a long hang`);
  console.log(`  ok  no marker → gives up in ${(r2.ms / 1000).toFixed(1)}s (floor intact)`);

  // ---- 3. Failed launch: marker cleared, pane never came. Must not sit out the ceiling. ----------
  const bad = 'ses_launchfailed';
  fs.writeFileSync(marker(bad), '');
  const badRun = runAttach('aos-' + bad);
  await sleep(ms(2000));
  fs.rmSync(marker(bad), { force: true }); // launchAgentRuntime's `finally` — released on failure too
  const r3 = await badRun;
  if (!GONE.test(r3.err)) fail(`a failed launch should end in tmux's not-found, got:\n${r3.err.trim()}`);
  if (r3.ms > ms(15000)) fail(`failed launch waited ${r3.ms}ms — it sat toward the 120s ceiling instead of following the marker`);
  console.log(`  ok  failed launch → releases in ${(r3.ms / 1000).toFixed(1)}s (follows the marker, not the ceiling)`);

  cleanup();
  console.log('attach-grace: ok');
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
