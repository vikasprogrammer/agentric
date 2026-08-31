#!/usr/bin/env node
/**
 * WAITING_BRIEF — the falsifier for "short polls, never one long sleep".
 *
 * Two agents were caught blocking inside a single tool call within four days: watchdog (headless,
 * a 600 s wait) and shield-optimizer (interactive, a 600 s wait plus an `until` loop). The existing
 * UNATTENDED_TURN_BRIEF forbids idling, but only on the unattended lane and only as a statement about
 * the turn boundary — an agent that stays inside its turn and sleeps has obeyed it.
 *
 * What must hold:
 *   1. The brief ships on BOTH lanes. shield-optimizer was interactive; a lane-gated brief misses it.
 *   2. It states both enforced limits, because both were violated for different reasons — the ~2-min
 *      Bash kill (a `sleep 240` lost its whole call) and the ~5-min cache TTL (a 600 s wait tripled
 *      cache_write and RAISED cost on FEWER tool calls).
 *   3. It does NOT read as "batch less". The measured win from pushing loops into scripts was the
 *      largest of the whole exercise (103 -> 29 tool calls); a brief that walked that back would trade
 *      a big win for a small one. This is the property most likely to rot in a future edit.
 *
 *   npm run build && node scripts/waiting-brief-test.cjs
 */
const path = require('path');
const { WAITING_BRIEF, UNATTENDED_TURN_BRIEF } = require(path.resolve(__dirname, '..', 'dist/edge/background-work'));

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond) pass++; else failures.push(name); };
const B = String(WAITING_BRIEF || '');

check('the brief exists and is substantial', B.length > 800);
check('names the ~2 minute Bash kill', /2 minutes?/.test(B) && /kill/i.test(B));
check('names sleep 240 as the concrete loss', /sleep 240/.test(B));
check('says an until/while loop is not the fix either', /until/.test(B) && /while/.test(B));
check('names the ~5 minute cache TTL', /5 minutes?/.test(B) && /cach/i.test(B));
check('explains that one long wait can cost MORE than many short polls', /MORE/.test(B));
check('gives a concrete upper bound on a single wait', /60-90 seconds|60–90 seconds/.test(B));
check('shows a bounded early-exit poll, not a bare sleep', /break/.test(B) && /seq 1/.test(B));
check('tells the agent to do work between polls', /earn its turn/i.test(B));

// The property most likely to be lost in a later edit: this must not contradict the batching advice
// that produced the largest measured win.
check('explicitly does NOT read as "batch less"', /batch less/i.test(B));
check('reaffirms pushing loops into scripts', /300/.test(B) && /still right|still the largest/i.test(B));
check('scopes the rule to a SINGLE call, not to batching', /SINGLE/.test(B));

// Lane independence: it must not be phrased as an unattended-only rule, and must not duplicate the
// turn-boundary framing that already misses the interactive case.
check('is not phrased as unattended-only', !/unattended/i.test(B));
check('is a distinct brief, not a copy of the turn brief', B !== String(UNATTENDED_TURN_BRIEF || ''));

// The turn brief must keep its own job — this test would otherwise pass on a merge that deleted it.
check('UNATTENDED_TURN_BRIEF still exists', String(UNATTENDED_TURN_BRIEF || '').length > 800);
check('...and still owns the turn-boundary rule', /turn ends/i.test(String(UNATTENDED_TURN_BRIEF || '')));

// Wiring: the brief has to actually reach the prompt on both lanes. buildCompanyMd is private, so
// assert against the source that it is appended outside the `unattended ?` ternary.
const fs = require('fs');
const term = fs.readFileSync(path.resolve(__dirname, '..', 'src/terminal.ts'), 'utf8');
const line = term.split('\n').find((l) => l.includes('preamble, learned, lane'));
check('appended to the composed prompt', !!line && line.includes('WAITING_BRIEF'));
check('appended UNCONDITIONALLY (not inside the lane ternary)', !!line && !/unattended \?[^\n]*WAITING_BRIEF/.test(line));

console.log(failures.length ? `\n${pass} passed, ${failures.length} FAILED` : `\nWAITING_BRIEF: ${pass} passed`);
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
