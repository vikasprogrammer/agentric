#!/usr/bin/env node
/* SESSION PROGRESS — the "where is this run, and is it moving?" line.
 *
 * The thing under test is the SPLIT. An agent owns the denominator (only it knows the job is 22 files);
 * it does NOT own the verdict, because an agent that believes it is progressing is exactly the one going
 * in circles. So every assertion here is really one of two claims:
 *
 *   - the agent's numbers survive intact (position, delta, subject inheritance, garbage tolerance);
 *   - nothing the agent says can talk the verdict into `forward`.
 *
 * Plus the precedence that keeps the indicator trustworthy: a run parked on a HUMAN's approval queue is
 * `blocked`, never `stuck` — mislabelling that is how a status light gets ignored. */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { deriveProgress, parseClaim, STALL_MS, CIRCLE_WINDOW_MS } = require(path.join(ROOT, 'dist/state/session-progress.js'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const eq = (a, b, name) => assert(a === b, name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const NOW = 1_700_000_000_000;
const mins = (n) => n * 60_000;
/** A claim n minutes ago. */
const claim = (agoMin, args, note = 'working') => parseClaim(NOW - mins(agoMin), note, args);
const derive = (o) => deriveProgress({ now: NOW, claims: [], lastActivityTs: NOW, loopTs: null, awaiting: null, ...o });

console.log('\n\x1b[1mparseClaim — the agent half, tolerantly\x1b[0m');
{
  const c = parseClaim(NOW, 'n', { subject: '  css-free theme.json  ', step: 6, of: 22 });
  eq(c.subject, 'css-free theme.json', 'subject trimmed');
  eq(c.step, 6, 'step kept');
  eq(c.total, 22, '`of` read as the total');
  eq(parseClaim(NOW, 'n', { total: 9 }).total, 9, '`total` accepted as an alias for `of`');
  eq(parseClaim(NOW, 'n', { step: '4', of: '8' }).step, 4, 'numeric strings coerced');
  eq(parseClaim(NOW, 'n', { step: 'banana' }).step, null, 'garbage step degrades to null, not a throw');
  eq(parseClaim(NOW, 'n', { of: 0 }).total, null, 'a zero denominator is dropped (never divide by it)');
  eq(parseClaim(NOW, 'n', { of: -3 }).total, null, 'a negative denominator is dropped');
  eq(parseClaim(NOW, 'n', { step: -1 }).step, null, 'a negative step is dropped');
  eq(parseClaim(NOW, 'n', { step: 6.7, of: 22 }).step, 6, 'a fractional step floors');
  // An agent that miscounts its own plan should not blank the line — clamp, do not discard.
  eq(parseClaim(NOW, 'n', { step: 30, of: 22 }).total, 30, 'step past total clamps the total up rather than dropping the position');
  eq(parseClaim(NOW, 'n', null).step, null, 'a prose-only update carries no position');
}

console.log('\n\x1b[1mposition + delta — what the human actually reads\x1b[0m');
{
  const p = derive({ claims: [claim(1, { step: 9, of: 22 }), claim(6, { step: 6, of: 22 })] });
  eq(p.step, 9, 'step is the newest claim');
  eq(p.total, 22, 'total carried');
  eq(p.pct, 9 / 22, 'pct = step/total');
  eq(p.delta, 3, 'delta is derived against the previous claim, not asserted');
  // The delta is the load-bearing half: a bar alone cannot tell movement from a frozen number.
  const prose = derive({ claims: [claim(1, { step: 9 }), claim(3, null), claim(6, { step: 6 })] });
  eq(prose.delta, 3, 'a prose-only update in between does not read as "no movement"');
  const first = derive({ claims: [claim(1, { step: 3, of: 10 })] });
  eq(first.delta, null, 'no delta until a second positioned claim exists');
  eq(derive({ claims: [claim(1, { step: 3 })] }).pct, null, 'no denominator ⇒ no bar (never invent one)');
  eq(derive({ claims: [claim(1, { step: 99, of: 10 }), claim(2, { step: 1, of: 10 })] }).pct, 1, 'pct clamps to 1');
  // Subject + denominator belong to the PLAN, not to one update.
  const inherit = derive({ claims: [claim(1, { step: 9 }), claim(8, { subject: 'canary sweep', of: 22 })] });
  eq(inherit.subject, 'canary sweep', 'subject inherited from the claim that set it');
  eq(inherit.total, 22, 'denominator inherited from the claim that set it');
}

console.log('\n\x1b[1mverdict — the half the agent may NOT assert\x1b[0m');
{
  eq(derive({ claims: [claim(1, { step: 9 }), claim(5, { step: 6 })] }).verdict, 'forward', 'rising step + live activity = forward');
  // stuck: the audit stream went quiet. Note the claim can still be recent and cheerful.
  const quiet = derive({ claims: [claim(1, { step: 6 })], lastActivityTs: NOW - STALL_MS - mins(7) });
  eq(quiet.verdict, 'stuck', 'no audit activity past the stall window = stuck');
  assert(/no activity for \d+ min/.test(quiet.reason), 'stuck reason names the silence, so it is checkable');
  // circling, source 1: the reliability monitor's existing loop detector.
  const loop = derive({ claims: [claim(1, { step: 6 })], loopTs: NOW - mins(2), loopCount: 7 });
  eq(loop.verdict, 'circling', 'a recent reliability.loop = circling');
  assert(loop.reason.includes('7'), 'circling reason carries the repeat count');
  eq(derive({ claims: [claim(1, { step: 6 })], loopTs: NOW - mins(45) }).verdict, 'forward', 'a stale loop event does not pin the run as circling forever');
  // circling, source 2: busy but not advancing. Three updates, step never rose.
  const stationary = derive({ claims: [claim(1, { step: 6 }), claim(3, { step: 6 }), claim(5, { step: 6 })] });
  eq(stationary.verdict, 'circling', 'three updates with a stationary step = circling');
  assert(stationary.reason.includes('6'), 'reason names the step that has not moved');
  eq(derive({ claims: [claim(1, { step: 6 }), claim(3, { step: 6 })] }).verdict, 'forward', 'TWO updates in one step is ordinary narration, not a loop');
  eq(derive({ claims: [claim(1, { step: 8 }), claim(3, { step: 7 }), claim(5, { step: 6 })] }).verdict, 'forward', 'three updates with a RISING step is forward');
  // A regressing step is circling too — it means the agent re-did work.
  eq(derive({ claims: [claim(1, { step: 4 }), claim(3, { step: 6 }), claim(5, { step: 5 })] }).verdict, 'circling', 'a step that went BACKWARDS over three updates is circling');
  // Claims outside the window cannot manufacture a stationary streak.
  const old = derive({ claims: [claim(1, { step: 6 }), claim(CIRCLE_WINDOW_MS / 60_000 + 5, { step: 6 }), claim(CIRCLE_WINDOW_MS / 60_000 + 9, { step: 6 })] });
  eq(old.verdict, 'forward', 'stationary claims older than the window do not count');
}

console.log('\n\x1b[1mprecedence — blocked is not a failure, and must not read as one\x1b[0m');
{
  // A run parked on a human's approval queue is behaving correctly. Calling that `stuck` blames the
  // agent for the human's backlog and trains people to ignore the indicator.
  const appr = derive({ claims: [claim(1, { step: 6 })], lastActivityTs: NOW - mins(40), awaiting: 'approval' });
  eq(appr.verdict, 'blocked', 'pending approval outranks a quiet audit stream');
  assert(/approval/.test(appr.reason), 'blocked reason names what it waits on');
  eq(derive({ claims: [claim(1, {})], awaiting: 'question' }).verdict, 'blocked', 'an unanswered question also blocks');
  assert(/answer/.test(derive({ awaiting: 'question' }).reason), 'question reason is distinguishable from approval');
  // Blocked outranks circling too: it is the reason the run stopped moving.
  const both = derive({ claims: [claim(1, { step: 6 })], loopTs: NOW - mins(1), awaiting: 'approval' });
  eq(both.verdict, 'blocked', 'blocked outranks circling');
  // …and circling outranks stuck: a run repeating an action is not silent, it is futile.
  eq(derive({ loopTs: NOW - mins(1), lastActivityTs: NOW - mins(40) }).verdict, 'circling', 'circling outranks stuck');
}

console.log('\n\x1b[1mstaleness — a frozen bar must not pretend to be current\x1b[0m');
{
  const fresh = derive({ claims: [claim(1, { step: 6, of: 22 })] });
  eq(fresh.stale, false, 'a recent claim is not stale');
  const old = derive({ claims: [claim(20, { step: 6, of: 22 })] });
  eq(old.stale, true, 'a claim older than the stall window is flagged stale');
  eq(old.step, 6, 'a stale claim still reports its position (dimmed, not hidden)');
  // The run that has done nothing legible at all yet.
  eq(derive({ claims: [], lastActivityTs: null }).verdict, 'forward', 'a just-started run is not stuck');
  eq(derive({ claims: [], lastActivityTs: null }).reason, 'just started', 'and says so');
  eq(derive({ claims: [] }).note, null, 'no claims ⇒ no note');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
