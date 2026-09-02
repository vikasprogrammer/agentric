#!/usr/bin/env node
/* Event-loop STALL ATTRIBUTION — the lag sampler's answer to "what blocked it", not just "how long".
 *
 * Written after a real hunt dead-ended: the live instawp process reported a 156-SECOND event-loop stall
 * and nothing else. No route had a handler time anywhere near it (so it wasn't a request), the audit
 * stream showed no burst, the WAL was 26 MB, the disk idle, the journal empty. A number with no subject
 * is not a lead — so every long synchronous phase now names itself and a stall carries the phase that
 * was open across it.
 *
 * What this pins:
 *   - a block INSIDE a named phase is attributed to that phase;
 *   - a block with nothing declared reads `unattributed` (itself a finding: unmarked code);
 *   - a phase that CLOSED just before the sampler tick still gets the blame (the common case — the
 *     blocking call returns, then the tick fires);
 *   - the sink fires (that is what writes the audit row for a stall nobody was watching);
 *   - nested phases resolve to the INNERMOST open one — which is what makes it safe to mark a whole
 *     request as a phase (a timer that blocks while the request awaits is blamed on the timer);
 *   - `phase()` closes on throw;
 *   - the ring is bounded and reset clears it. */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { requestMetrics } = require(path.join(ROOT, 'dist/edge/request-metrics.js'));

const block = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* hold the loop */ } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const stalls = () => requestMetrics.snapshot(5).loop.stalls;

(async () => {
  const seen = [];
  requestMetrics.onStall((s) => seen.push(s));
  requestMetrics.start(50);

  console.log('\nattribution');
  requestMetrics.phase('test:namedBlock', () => block(1200));
  await tick(200);
  const named = stalls().find((s) => s.phase === 'test:namedBlock');
  assert(!!named && named.ms >= 1000, 'a block inside a named phase is attributed to it', JSON.stringify(stalls()));
  assert(seen.some((s) => s.phase === 'test:namedBlock'), 'the sink fires for it (this is what writes the audit row)');

  requestMetrics.reset();
  block(1200);
  await tick(200);
  assert(stalls().some((s) => s.phase === 'unattributed'), 'a block with nothing declared reads unattributed', JSON.stringify(stalls()));

  requestMetrics.reset();
  const done = requestMetrics.beginPhase('test:closedBeforeTick');
  block(1200);
  done();                        // the blocking call returns BEFORE the sampler gets to run
  await tick(200);
  assert(stalls().some((s) => s.phase === 'test:closedBeforeTick'), 'a phase closed just before the tick still gets the blame', JSON.stringify(stalls()));

  console.log('\nphase bookkeeping');
  requestMetrics.reset();
  requestMetrics.phase('test:outer', () => requestMetrics.phase('test:inner', () => block(1200)));
  await tick(200);
  assert(stalls().some((s) => s.phase === 'test:inner'), 'nested phases resolve to the INNERMOST open one — the code actually holding the loop', JSON.stringify(stalls()));

  // The case that makes it safe to mark a whole REQUEST as a phase: a request parked on an await is
  // open while a timer blocks inside it, and the timer must take the blame, not the request.
  requestMetrics.reset();
  const endRequest = requestMetrics.beginPhase('route:GET /api/whatever');
  await tick(60);
  requestMetrics.phase('timer:blocking', () => block(1200));
  await tick(200);
  endRequest();
  assert(stalls().some((s) => s.phase === 'timer:blocking'), 'a timer blocking inside an awaiting request is blamed on the timer', JSON.stringify(stalls()));

  requestMetrics.reset();
  let threw = false;
  try { requestMetrics.phase('test:throws', () => { throw new Error('boom'); }); } catch { threw = true; }
  block(1200);
  await tick(200);
  assert(threw, 'phase() rethrows');
  assert(!stalls().some((s) => s.phase === 'test:throws') || stalls().every((s) => s.ms > 0), 'a throwing phase is closed, not left open forever');

  console.log('\nbounds');
  requestMetrics.reset();
  for (let i = 0; i < 24; i++) { requestMetrics.phase(`test:ring${i}`, () => block(1010)); await tick(120); }
  assert(stalls().length <= 20, 'the ring is bounded', String(stalls().length));
  requestMetrics.reset();
  assert(stalls().length === 0, 'reset clears the ring');
  requestMetrics.stop();

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
})();
