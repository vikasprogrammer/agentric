#!/usr/bin/env node
/* Pin the activity classifier's human summaries — the feed's live "currently…" line reads these, and a
 * bare capability id ("shell.exec") is not an answer to "what is it doing?". */
'use strict';
const assert = require('node:assert');
const { classifyActivity } = require('../dist/state/session-activity');

// gate.decision prefers the brief's human headline over the raw capability
const withBrief = classifyActivity('gate.decision', { capability: 'shell.exec', decision: { effect: 'allow' }, brief: { headline: 'Run: npm test' } });
assert.strictEqual(withBrief.summary, 'Run: npm test', `headline not used: ${withBrief && withBrief.summary}`);
assert.strictEqual(withBrief.primitive, 'shell.exec');

// no brief → a friendly capability label, never the bare id
const noBrief = classifyActivity('gate.decision', { capability: 'shell.exec', decision: { effect: 'allow' } });
assert.strictEqual(noBrief.summary, 'Ran a shell command', `fallback wrong: ${noBrief && noBrief.summary}`);
const unknown = classifyActivity('gate.decision', { capability: 'weird.thing', decision: { effect: 'allow' } });
assert.strictEqual(unknown.summary, 'weird.thing'); // unmapped shown as-is

// action.result: a success is redundant noise (dropped); a failure surfaces the error
assert.strictEqual(classifyActivity('action.result', { capability: 'shell.exec', ok: true }), null, 'successful action.result should be noise');
const failed = classifyActivity('action.result', { capability: 'shell.exec', ok: false, error: 'exit code 1' });
assert.strictEqual(failed.summary, 'exit code 1');
assert.strictEqual(failed.effect, 'error');

console.log('✓ activity-classify: 6 checks passed');
