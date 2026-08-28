#!/usr/bin/env node
/**
 * DETACHED-WORK STEER — pins the reliability monitor's second detector.
 *
 * A steer that fires on ordinary commands is a steer the model learns to ignore, so the false-positive
 * half of this file matters more than the true-positive half. The shape it must catch is the one that
 * took the Mac Mini to load 29 on 12 cores (2026-08-20): background jobs cleaned up by a trailing `kill`
 * that a killed tool call never reaches.
 *
 * Run: node scripts/detached-work-steer-test.cjs   (needs `npm run build` first)
 */
const assert = require('assert');
const { ReliabilityMonitor } = require('../dist/edge/reliability');

const NOW = 1_700_000_000_000;
let seq = 0;
/** One shell.exec observation in its own session, so per-session dedup never masks a case. */
function steer(command, sessionId = `s${++seq}`) {
  const mon = new ReliabilityMonitor();
  return mon.observe(sessionId, 'shell.exec', { tool: 'Bash', input: { command } }, 'headline', NOW);
}
const fires = (cmd) => { const s = steer(cmd); return s && s.kind === 'detached-work' ? s.reason : null; };

// ------------------------------------------------------------------- catches
// The incident, verbatim in shape: 24 backgrounded spinners + a trailing group kill, no trap.
assert.strictEqual(
  fires("cd /tmp/p && (for i in $(seq 1 24); do (while :; do :; done) & done; go test ./internal/git/ -race -count=40; jobs -p | xargs kill 2>/dev/null; true)"),
  'spin', 'the incident command must steer');
// Its sibling from the same session, which used job specs instead of `jobs -p`.
assert.strictEqual(
  fires("(for i in 1 2 3 4; do (while :; do :; done) & done; go test ./... ; kill %1 %2 %3 %4 2>/dev/null)"),
  'spin', 'kill %n cleanup must steer');
// No spin, but the author promised cleanup on the happy path only — the strongest signal we get.
assert.strictEqual(
  fires("./stress-load.sh & LOAD=$!; pytest tests/; kill $!"),
  'cleanup', 'a happy-path `kill $!` after backgrounding must steer');
assert.strictEqual(
  fires("server --port 9000 & sleep 2; curl localhost:9000/health; jobs -p | xargs kill"),
  'cleanup', 'jobs -p | xargs kill must steer even with no spin loop');

// -------------------------------------------------------------- stays quiet
const quiet = [
  // The whole point of clause 2: an author who wrote a trap has already solved this.
  ["trap 'kill 0' EXIT; (while :; do :; done) & go test ./...", 'a command with a trap'],
  // Clause 3: backgrounding alone promises nothing that a dead tool call could break.
  ['npm run dev &', 'a deliberately daemonised dev server'],
  ['nohup ./worker.sh > /tmp/w.log 2>&1 &', 'a nohup worker meant to outlive the call'],
  // `&` that is not a background operator at all — the regex trap this detector had to avoid.
  ['npm run build && npm test', '&& is not backgrounding'],
  ['make 2>&1 | tee build.log', '2>&1 is not backgrounding'],
  ['./configure &> /tmp/conf.log', '&> is not backgrounding'],
  ['git log --format=%H && kill %1', '&& with a kill but no backgrounded job'],
  // A polling loop is not a hot spin, and nothing is backgrounded.
  ['while true; do sleep 5; curl -sf localhost:3010/health && break; done', 'a sleep-paced poll loop'],
  // Backgrounded poll WITH a sleep: not a spinner. No self-kill either, so nothing was promised.
  ['(while true; do sleep 30; echo tick >> /tmp/hb; done) &', 'a backgrounded heartbeat that sleeps'],
  // Ordinary work must never trip it.
  ['kill -9 12345', 'killing an unrelated pid'],
  ['ps aux | grep node', 'a plain read'],
];
for (const [cmd, why] of quiet) {
  assert.strictEqual(fires(cmd), null, `must stay quiet: ${why} — ${cmd}`);
}

// ------------------------------------------------------------ note + framing
{
  const s = steer("(while :; do :; done) & go test ./...; jobs -p | xargs kill");
  assert.match(s.note, /Agentric reliability monitor:/, 'branded, like the loop note');
  assert.match(s.note, /trap 'kill 0' EXIT/, 'names the concrete fix');
  assert.match(s.note, /ignore this/, 'leaves the model an out — advisory, not coercive');
  assert.doesNotMatch(s.note, /\b(?:you MUST|DO NOT|NEVER|REQUIRED)\b/,
    'no coercive framing — the spike showed the model flags that as prompt-injection');
}

// -------------------------------------------------------------------- scope
{
  const mon = new ReliabilityMonitor();
  const cmd = "(while :; do :; done) & go test ./...; jobs -p | xargs kill";
  // Fires once per session per shape: a retried command must not nag.
  assert.ok(mon.observe('sess', 'shell.exec', { tool: 'Bash', input: { command: cmd } }, 'h', NOW), 'first occurrence steers');
  assert.strictEqual(mon.observe('sess', 'shell.exec', { tool: 'Bash', input: { command: cmd } }, 'h', NOW + 1000), undefined,
    'the same shape does not steer twice in one session');
  // A different run starts clean.
  assert.ok(mon.observe('other', 'shell.exec', { tool: 'Bash', input: { command: cmd } }, 'h', NOW), 'another session steers again');
  // forget() clears it, so a resumed id is not permanently muted.
  mon.forget('sess');
  assert.ok(mon.observe('sess', 'shell.exec', { tool: 'Bash', input: { command: cmd } }, 'h', NOW), 'forget() clears the steer memory');
}
{
  // Not a shell capability → never inspected, whatever the payload looks like.
  const mon = new ReliabilityMonitor();
  const sig = mon.observe('s', 'connector.call', { tool: 'GMAIL_SEND', input: { command: '(while :; do :; done) & kill %1' } }, 'h', NOW);
  assert.strictEqual(sig, undefined, 'only shell.exec is shape-checked');
}

// ------------------------------------------------- the loop detector still works
{
  const mon = new ReliabilityMonitor();
  let last;
  for (let i = 0; i < 5; i++) last = mon.observe('s', 'shell.exec', { tool: 'Bash', input: { command: 'curl -s localhost:3010/health' } }, 'curl health', NOW + i * 1000);
  assert.ok(last && last.kind === 'loop' && last.count === 5, 'the no-progress loop detector is unchanged');
}

console.log('✓ detached-work steer: the incident shape steers once, traps/daemons/&&/2>&1 stay quiet, loop detector intact');
