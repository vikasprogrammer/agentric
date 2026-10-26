#!/usr/bin/env node
/* "You keep typing this" (src/edge/standing-instructions.ts): recurring constraint clauses become personal-
 * context suggestions unless already in the member's context; the same request to the same agent on
 * several days becomes a routine suggestion — but not when only the link changes (a template). Shapes are
 * taken from the 2026-10-26 fleet mining; all text is synthetic. */
const path = require('path');
const { standingSuggestions } = require(path.join(__dirname, '..', 'dist/edge/standing-instructions.js'));
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const DAY = 86_400_000, T0 = Date.UTC(2026, 9, 1, 9);
const at = (d, h = 0) => T0 + d * DAY + h * 3_600_000;

// 1) a constraint clause retyped across sessions, with a different link each time
const investigate = Array.from({ length: 6 }, (_, i) => ({ agent: 'engineer', createdAt: at(i), task: `check task https://app.clickup.com/t/9000001/task${i}x. do not edit anything` }));
let s = standingSuggestions(investigate, '');
const c = s.find((x) => x.kind === 'context');
assert(c && /do not edit anything/i.test(c.text) && c.sessions === 6 && c.days === 6, 'recurring "do not edit anything" → a context suggestion with its counts', JSON.stringify(s));
assert(!s.some((x) => x.kind === 'routine'), 'same words with a different link each time is a template, not a routine');
assert(standingSuggestions(investigate, 'House rules:\n- Do not edit anything unless I say so').filter((x) => x.kind === 'context').length === 0, 'not suggested again once it is in the personal context');
assert(standingSuggestions(investigate.slice(0, 3), '').length === 0, 'below the session floor → nothing');
// a non-constraint clause, however frequent, is not a preference
const plain = Array.from({ length: 8 }, (_, i) => ({ agent: 'support-ops', createdAt: at(i), task: `Investigate ticket https://support.example.com/conversation/${3000 + i} and draft a reply.` }));
assert(standingSuggestions(plain, '').filter((x) => x.kind === 'context').length === 0, 'a frequent task clause without a constraint cue is not suggested');

// 2) the same request on many days → routine
const sends = Array.from({ length: 9 }, (_, i) => ({ agent: 'onboarding-assistant', createdAt: at(i, 10), task: i % 2 ? 'Send 15 from ana@ and 10 from sales@' : 'Send 10 more from ana@ and 10 more from sales@' }));
s = standingSuggestions([...sends, ...investigate], '');
const r = s.find((x) => x.kind === 'routine');
assert(r && r.agent === 'onboarding-assistant' && r.days === 9, 'daily "send N from ana@ and sales@" → a routine for that agent', JSON.stringify(s));
assert(standingSuggestions(sends.slice(0, 3), '').filter((x) => x.kind === 'routine').length === 0, 'fewer than 4 distinct days → no routine');
const sameDay = Array.from({ length: 6 }, (_, i) => ({ ...sends[0], createdAt: at(0, i) }));
assert(standingSuggestions(sameDay, '').filter((x) => x.kind === 'routine').length === 0, 'six times in ONE day is not a routine');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}STANDING INSTRUCTIONS: ${pass}/${pass + fail} passed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
