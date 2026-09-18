#!/usr/bin/env node
/* The deploy lock — one `make-live.sh` at a time per box.
 *
 * Every live checkout is shared by whoever runs the deploy, so two concurrent runs are two
 * `git reset --hard`s racing each other's builds: the second one moves a checkout out from under the
 * first one's `npm run build`, and the first then restarts a service with a binary built from a commit
 * it never resolved — while reporting success, because it verifies /health against the version it was
 * told to expect. On 2026-09-17 two sessions ran this concurrently against all four tenants and it was
 * harmless ONLY because both happened to be deploying the same sha. Luck, not design.
 *
 * A lock that cannot be released is worse than no lock, so the other half of this is the escape hatches:
 * a dead holder is cleared automatically, an ancient one is cleared on the age ceiling, and --force-lock
 * breaks one on purpose. Each is pinned here, because each is the thing that would wedge every future
 * deploy if it regressed.
 *
 * Runs the real script with a scratch lock path and a deliberately bogus target, so every case fails
 * fast in preflight — after the lock has been taken and released. Nothing is deployed and no checkout is
 * touched. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/make-live.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-deploy-lock-'));
const LOCK = path.join(TMP, 'deploy.lock');

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + String(d).slice(0, 300) : ''}`));

// An env file naming one local tenant whose checkout does not exist: preflight fails within milliseconds,
// which is exactly what we want — the lock is acquired and released around a run that deploys nothing.
const ENV_FILE = path.join(TMP, 'live.env');
fs.writeFileSync(ENV_FILE, `AOS_LIVE_TARGETS="faketenant:${path.join(TMP, 'no-such-checkout')}:3999"\n`);

const run = (args = []) => spawnSync('bash', [SCRIPT, ...args], {
  encoding: 'utf8',
  env: { ...process.env, AOS_LIVE_ENV: ENV_FILE, AOS_LIVE_LOCK: LOCK },
});
const held = () => fs.existsSync(LOCK);
/** Plant a lock as if another run owned it. */
const plant = (pid, startedAgoSec = 0) => {
  fs.rmSync(LOCK, { recursive: true, force: true });
  fs.mkdirSync(LOCK);
  fs.writeFileSync(path.join(LOCK, 'meta'), `pid=${pid}\nuser=someone@otherbox\nstarted=planted\nargs=\n`);
  if (startedAgoSec) {
    const t = new Date(Date.now() - startedAgoSec * 1000);
    fs.utimesSync(LOCK, t, t);
  }
};
/** A PID that is alive for the duration of this test but is NOT a deploy. */
const sleeper = spawnSync === null ? null : require('child_process').spawn('sleep', ['120'], { stdio: 'ignore' });
const LIVE_PID = sleeper.pid;
const DEAD_PID = 999999; // far above any live pid on a desktop box

console.log('\n\x1b[1m1) an ordinary run takes the lock and always gives it back\x1b[0m');
{
  fs.rmSync(LOCK, { recursive: true, force: true });
  const r = run();
  // It must fail in PREFLIGHT (no checkout / no launchctl), never at the lock.
  assert(r.status !== 0, 'the run fails fast on the bogus target', r.status);
  assert(!/another deploy is already running/.test(r.stderr), 'and not because of the lock', r.stderr.slice(0, 200));
  assert(!held(), 'the lock is released even though the run FAILED — a crashed deploy must not wedge the next one');
}

console.log('\n\x1b[1m2) a second run is refused while a live holder has it\x1b[0m');
{
  plant(LIVE_PID);
  const r = run();
  assert(r.status === 1, 'it exits non-zero', r.status);
  assert(/another deploy is already running/.test(r.stderr), 'it says a deploy is already running', r.stderr.slice(0, 200));
  assert(r.stderr.includes(String(LIVE_PID)), 'it names the holding pid so you can go look at it');
  assert(/--force-lock/.test(r.stderr), 'and it prints the way out');
  assert(held(), 'the LOSER does not delete the winner\'s lock');
  // The refusal must come before any deploy work — the bogus-target error proves we never got to preflight.
  assert(!/no live checkout/.test(r.stderr), 'and it refuses BEFORE touching any target');
}

console.log('\n\x1b[1m3) a lock nobody holds never wedges the next deploy\x1b[0m');
{
  plant(DEAD_PID);
  const r = run();
  assert(/stale deploy lock/.test(r.stderr), 'a dead holder is cleared automatically', r.stderr.slice(0, 200));
  assert(!/another deploy is already running/.test(r.stderr), 'and the run proceeds past the lock');
  assert(!held(), 'and it is released again at exit');
}
{
  // A live PID can still be debris — it may be a REUSED pid, or a run wedged on an ssh that never
  // returns. The age ceiling is what stops either from blocking deploys forever.
  plant(LIVE_PID, 3 * 3600);
  const r = run();
  assert(/stale deploy lock/.test(r.stderr), 'a lock past the age ceiling is cleared even with a live pid', r.stderr.slice(0, 200));
  assert(!held(), 'and released at exit');
}
{
  // A meta we cannot read at all (an interrupted writer) must not be a permanent wedge either.
  fs.rmSync(LOCK, { recursive: true, force: true });
  fs.mkdirSync(LOCK);
  const r = run();
  assert(/stale deploy lock/.test(r.stderr), 'a lock with no readable meta is cleared', r.stderr.slice(0, 200));
}

console.log('\n\x1b[1m4) --force-lock breaks a live holder on purpose\x1b[0m');
{
  plant(LIVE_PID);
  const r = run(['--force-lock']);
  assert(/breaking the lock/.test(r.stderr), 'it says what it is doing', r.stderr.slice(0, 200));
  assert(!/another deploy is already running/.test(r.stderr), 'it is not refused');
  assert(!held(), 'and the forcing run releases the lock it took');
}

console.log('\n\x1b[1m5) the read-only paths are not blocked by a held lock\x1b[0m');
{
  plant(LIVE_PID);
  const r = run(['--dry-run']);
  assert(!/another deploy is already running/.test(r.stderr), 'a dry run is not refused — it changes nothing, and it is the tool you reach for to see what the other run is doing');
  assert(/deploy is in progress/.test(r.stderr), 'but it warns that it is reading checkouts another run is moving', r.stderr.slice(0, 200));
  assert(held(), 'and it leaves the holder\'s lock alone');

  const h = run(['--help']);
  assert(h.status === 0, '--help still works with a lock held', h.status);
  assert(/--force-lock/.test(h.stdout), 'and documents --force-lock');
  assert(held(), 'and touches nothing');
}

try { sleeper.kill(); } catch { /* best effort */ }
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
