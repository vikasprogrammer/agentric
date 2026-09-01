#!/usr/bin/env node
/* Session cost + usage accounting — one BILLED REQUEST must be counted once.
 *
 * Claude Code writes one transcript line per content block of an assistant message. All those lines carry
 * the SAME `message.id` and a byte-identical `usage` object, so summing usage per LINE bills each request
 * once per block it happened to emit. Live instapods, a single engineer run: 36 usage-bearing lines for
 * 19 distinct ids — 47% counted twice — and the session row read $4.05 where the agent's own status line
 * showed $1.88.
 *
 * `toolCalls` is the opposite case and must NOT be deduped: the blocks are SPLIT across those lines
 * (`[thinking]`, `[tool_use]`, `[tool_use]`), so counting per line already counts each call once. Both
 * halves are pinned here, because a fix to one that broke the other would still look right on the total. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

// A transcript in the real shape: one assistant message split over three lines, then a second message.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cost-test-'));
const proj = path.join(HOME, 'projects', 'a-project');
fs.mkdirSync(proj, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = HOME;

const usage = (o) => ({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 1_000, ...o });
const line = (o) => JSON.stringify(o);
const CS = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
fs.writeFileSync(path.join(proj, CS + '.jsonl'), [
  line({ type: 'user', timestamp: '2026-09-01T10:00:00Z', message: { content: [{ type: 'text', text: 'do the thing' }] } }),
  // ONE billed request, three lines, identical usage, blocks SPLIT across them.
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:05Z', message: { id: 'msg_1', model: 'claude-opus-4', usage: usage(), content: [{ type: 'thinking' }] } }),
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:06Z', message: { id: 'msg_1', model: 'claude-opus-4', usage: usage(), content: [{ type: 'tool_use' }] } }),
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:07Z', message: { id: 'msg_1', model: 'claude-opus-4', usage: usage(), content: [{ type: 'tool_use' }] } }),
  // a SECOND billed request
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:09Z', message: { id: 'msg_2', model: 'claude-opus-4', usage: usage(), content: [{ type: 'tool_use' }] } }),
  // a line with no id at all — must still be billed rather than silently dropped
  line({ type: 'assistant', timestamp: '2026-09-01T10:00:11Z', message: { model: 'claude-opus-4', usage: usage(), content: [{ type: 'text' }] } }),
].join('\n') + '\n');

const { readSessionCost } = require(path.join(ROOT, 'dist/edge/session-cost.js'));
const r = readSessionCost(CS);

console.log('\nsession cost — one billed request counted once\n');
assert(!!r, 'the transcript is found and parsed');
// 3 distinct billed requests: msg_1 (once, not 3x), msg_2, and the id-less line.
assert(r.outputTokens === 150, 'usage is counted ONCE per message id, not once per line', `outputTokens=${r.outputTokens}, expected 150 (3 requests x 50)`);
assert(r.inputTokens === 300, 'input tokens likewise', `got ${r.inputTokens}`);
assert(r.cacheReadTokens === 30_000, 'cache reads likewise — this is what dominates the bill', `got ${r.cacheReadTokens}`);
// …while tool calls come from blocks, which are split across the lines rather than repeated.
assert(r.toolCalls === 3, 'tool calls are NOT deduped — the blocks are split, so per-line counting is right', `got ${r.toolCalls}, expected 3`);
assert(r.turns === 1, 'one user turn');
// The whole point: the total is the honest one.
const naive = 6 * (100 * 15 + 50 * 75 + 10_000 * 15 * 0.1 + 1_000 * 15 * 1.25) / 1e6; // what per-line summing would give
assert(r.costUsd > 0 && r.costUsd < naive, 'the cost is below what per-line summing would have produced', `cost=${r.costUsd.toFixed(4)} naive=${naive.toFixed(4)}`);

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
