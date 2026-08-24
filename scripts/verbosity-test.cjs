#!/usr/bin/env node
/* Verbosity (terse output) test — the flag, and the measurement that can contradict it.
 *
 * Two things need holding down. First the PRECEDENCE: verbosity rides the existing RuntimeTuning chain
 * (per-run override → agent manifest → workspace default → normal), and the agent level must be able to
 * opt OUT of a terse workspace default — otherwise an agent whose prose humans read gets compressed with
 * no way back. Second the MEASUREMENT: terse is a prompt instruction, not an enforced transform, so the
 * savings query is the only thing standing between "we flipped a flag" and "it worked". It is easy to
 * fool — a longer run costs more because it did more — so the per-turn denominator and the exclusion of
 * pre-flag / uncosted rows are load-bearing and tested directly.
 *
 * Isolated home; session rows are synthesized so the arms and ratios are exact. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-verbosity-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { resolveRuntimeTuning, sanitizeRuntimeTuning } = require(path.join(ROOT, 'dist/types.js'));
const { verbosityAdoption, TERSE_OUTPUT_BRIEF } = require(path.join(ROOT, 'dist/edge/verbosity.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

console.log('\n\x1b[1m1) precedence — override → agent → workspace → normal\x1b[0m');
assert(resolveRuntimeTuning({}, {}).verbosity === 'normal', 'unset everywhere resolves to normal');
assert(resolveRuntimeTuning({}, { verbosity: 'terse' }).verbosity === 'terse', 'workspace default reaches an agent that sets nothing');
assert(resolveRuntimeTuning({ verbosity: 'normal' }, { verbosity: 'terse' }).verbosity === 'normal',
  'an agent can opt OUT of a terse workspace default');
assert(resolveRuntimeTuning({ verbosity: 'normal' }, { verbosity: 'normal' }, { verbosity: 'terse' }).verbosity === 'terse',
  'a per-run override beats agent + workspace');
{
  // A model pinned for another runtime is dropped by resolve — that must not take verbosity with it.
  const r = resolveRuntimeTuning({ model: 'claude-opus-4-8', verbosity: 'terse' }, {}, undefined, 'codex');
  assert(r.model === undefined && r.verbosity === 'terse', 'survives the cross-runtime model drop');
}

console.log('\n\x1b[1m2) sanitize — the API edge\x1b[0m');
assert(sanitizeRuntimeTuning({ verbosity: 'terse' }).tuning.verbosity === 'terse', 'accepts terse');
assert(sanitizeRuntimeTuning({ verbosity: 'normal' }).tuning.verbosity === 'normal',
  'keeps an explicit normal (it is the only per-agent opt-out)');
{
  const r = sanitizeRuntimeTuning({ verbosity: '' });
  assert(!r.error && r.tuning.verbosity === undefined, 'empty string = inherit, not an error');
}
assert(/verbosity must be one of/.test(sanitizeRuntimeTuning({ verbosity: 'caveman' }).error || ''), 'rejects an unknown level');
assert(!sanitizeRuntimeTuning({ verbosity: 7 }).error, 'a non-string is ignored, not fatal');

console.log('\n\x1b[1m3) the brief names its carve-outs\x1b[0m');
// The carve-outs are what keep terse from degrading the artifacts the OS runs on: report feeds
// consolidation, remember feeds recall, kb_write and the chat replies are read by humans.
for (const tool of ['report', 'remember', 'kb_write', 'task_update', 'ask', 'slack_reply', 'discord_reply'])
  assert(TERSE_OUTPUT_BRIEF.includes(tool), `exempts ${tool}`);
assert(/[Ee]rror messages/.test(TERSE_OUTPUT_BRIEF) && /byte-for-byte/i.test(TERSE_OUTPUT_BRIEF), 'exempts error text verbatim');
// …and the carve-out must not read as a licence to be long. A terse engineer run answered a console
// question at essay length because "write them in full, ordinary prose" was the last word on the exempt
// lane. Compression stays off there; shape does not.
assert(/not a licence to be long/i.test(TERSE_OUTPUT_BRIEF), 'the exempt lane is still bound on SHAPE');
assert(/[Ll]ead with the answer/.test(TERSE_OUTPUT_BRIEF), 'tells the exempt lane to lead with the answer');
assert(/summary and then restate/i.test(TERSE_OUTPUT_BRIEF), 'bans the summary-then-restatement duplication');
// The whole point of the carve-out survives it: prose and caveats stay.
assert(/completeness wins over length/i.test(TERSE_OUTPUT_BRIEF), 'completeness still beats brevity');
assert(/ordinary prose/i.test(TERSE_OUTPUT_BRIEF), 'the exempt surfaces still keep ordinary prose');

const aos = loadAgentOS();
const db = aos.db;

console.log('\n\x1b[1m4) migration\x1b[0m');
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
assert(cols('term_sessions').includes('verbosity'), 'term_sessions.verbosity exists (the measurement join key)');
assert(cols('agent_revisions').includes('verbosity'), 'agent_revisions.verbosity exists (so a revert restores it)');

console.log('\n\x1b[1m5) prompt injection\x1b[0m');
{
  const tm = new TerminalManager(aos, { baseUrl: 'http://127.0.0.1:1', publicOrigin: '' });
  const head = '# Output style — terse';
  assert(tm.buildCompanyMd(undefined, undefined, 'terse').includes(head), 'terse appends the brief to the system prompt');
  assert(!tm.buildCompanyMd(undefined, undefined, 'normal').includes(head), 'normal appends nothing');
  assert(!tm.buildCompanyMd().includes(head), 'an un-migrated caller (no arg) appends nothing');
}

console.log('\n\x1b[1m6) adoption — counts, and only counts\x1b[0m');
// The predecessor of this section tested the savings math: output-per-turn, USD-per-turn, the
// under-powered-arm guard. Those assertions were removed with the query in v0.389.0. They were all
// PASSING — the arithmetic was correct — which is exactly the trap: a well-tested number can still be
// the wrong number. `output_tokens` is ~85% tool-call arguments, so no amount of per-turn hygiene made
// it a measure of the narration the brief compresses. What replaced it reports who ran which level,
// which is a claim a row count can actually support.
const DAY = 86_400_000;
let n = 0;
const mkRun = (agent, verbosity, ageDays = 1) => {
  const id = 'ts_' + (++n), at = Date.now() - ageDays * DAY;
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,verbosity)
              VALUES (?,?,'t','x',?,'done',?,?,10,10000,1.0,?)`)
    .run(id, agent, 'aos-' + id, at, at + 60_000, verbosity);
};
const agentRow = (agent, days = 30) => verbosityAdoption(db, days).byAgent.find((a) => a.agent === agent);

for (let i = 0; i < 6; i++) mkRun('alpha', 'normal');
for (let i = 0; i < 4; i++) mkRun('alpha', 'terse');
for (let i = 0; i < 9; i++) mkRun('beta', 'terse');
{
  const a = agentRow('alpha');
  assert(a && a.normal === 6 && a.terse === 4, 'counts each level per agent');
  const totals = verbosityAdoption(db).sessions;
  assert(totals.normal === 6 && totals.terse === 13, 'workspace totals sum every agent');
}
// An agent that only ever ran one way is still real adoption — unlike the old comparison, which had
// to drop it for want of a second arm.
assert(agentRow('beta').terse === 9 && agentRow('beta').normal === 0, 'a single-level agent is still listed');
// Sorted so the heaviest terse users lead — the question the panel exists to answer.
assert(verbosityAdoption(db).byAgent[0].agent === 'beta', 'ordered by terse runs, most first');
{
  // Pre-flag rows are attributable to neither level. They are counted as `unstamped` rather than
  // silently folded into `normal`, so the panel cannot overstate how far the flag has spread.
  for (let i = 0; i < 5; i++) mkRun('alpha', null);
  const s = verbosityAdoption(db).sessions;
  assert(s.unstamped === 5 && s.normal === 6, 'un-stamped rows are their own bucket, not normal');
  assert(agentRow('alpha').normal === 6 && agentRow('alpha').terse === 4, 'and they do not reach byAgent');
}
{
  // Cost is no longer read at all, so a live, unpriced row is ordinary adoption data.
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,verbosity)
              VALUES ('ts_live','alpha','t','x','aos-live','running',?,?,5,5000,NULL,'terse')`).run(Date.now(), Date.now());
  assert(agentRow('alpha').terse === 5, 'a running, uncosted run counts — adoption does not wait on a price');
}
for (let i = 0; i < 10; i++) mkRun('epsilon', 'terse', 90);
assert(!agentRow('epsilon', 30), 'the trailing window excludes older runs');
assert(!!agentRow('epsilon', 120), 'and a wider window finds them again');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
