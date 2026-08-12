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
const { verbositySavings, TERSE_OUTPUT_BRIEF } = require(path.join(ROOT, 'dist/edge/verbosity.js'));
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
assert(/ordinary prose/.test(TERSE_OUTPUT_BRIEF), 'the exempt surfaces still keep ordinary prose');

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

console.log('\n\x1b[1m6) savings — per-turn, and hard to fool\x1b[0m');
const DAY = 24 * 3600_000;
let n = 0;
/** One costed, terminal session. `verbosity` null = a run from before the flag existed. */
const mkRun = (agent, verbosity, turns, output, usd, ageDays = 1) => {
  const id = 'ts_' + (++n), at = Date.now() - ageDays * DAY;
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,verbosity)
              VALUES (?,?,'t','x',?,'done',?,?,?,?,?,?)`)
    .run(id, agent, 'aos-' + id, at, at + 60_000, turns, output, usd, verbosity);
};
const agentRow = (agent, days = 30) => verbositySavings(db, days).byAgent.find((a) => a.agent === agent);

// alpha: terse halves output per turn and is 20% cheaper per turn.
for (let i = 0; i < 6; i++) mkRun('alpha', 'normal', 10, 10_000, 1.0);
for (let i = 0; i < 6; i++) mkRun('alpha', 'terse', 10, 5_000, 0.8);
{
  const a = agentRow('alpha');
  assert(a && a.normal.outputPerTurn === 1000 && a.terse.outputPerTurn === 500, 'output/turn is computed per turn');
  assert(a.outputDelta === 50 && a.usdDelta === 20, 'reports −50% output, −20% USD');
}

// beta: identical per-turn economics, but the terse runs are 5× LONGER. Totals would call that a
// regression; per-turn must not.
for (let i = 0; i < 6; i++) mkRun('beta', 'normal', 2, 2_000, 0.2);
for (let i = 0; i < 6; i++) mkRun('beta', 'terse', 10, 5_000, 0.8);
assert(agentRow('beta').outputDelta === 50, 'a longer terse run does not fake a regression');

// gamma: a spectacular ratio off one run per arm — noise, and must not be reported as a delta.
mkRun('gamma', 'normal', 10, 10_000, 1.0);
mkRun('gamma', 'terse', 10, 1_000, 0.1);
{
  const g = agentRow('gamma');
  assert(g.comparable === false && g.outputDelta === null, 'an under-powered arm reports no delta');
}

// delta: terse only. Comparing it to itself would be meaningless, so it is not a row at all.
for (let i = 0; i < 8; i++) mkRun('delta', 'terse', 10, 5_000, 0.5);
assert(!agentRow('delta'), 'an agent that only ran one way is excluded from byAgent');

{
  const before = verbositySavings(db);
  for (let i = 0; i < 20; i++) mkRun('alpha', null, 10, 999_999, 99);  // pre-flag rows, wildly expensive
  const after = verbositySavings(db);
  assert(after.normal.turns === before.normal.turns && after.terse.turns === before.terse.turns,
    'pre-flag (NULL verbosity) rows count toward neither arm');
}
{
  const before = verbositySavings(db).normal.sessions;
  db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at,turns,output_tokens,cost_usd,verbosity)
              VALUES ('ts_live','alpha','t','x','aos-live','running',?,?,5,5000,NULL,'normal')`).run(Date.now(), Date.now());
  assert(verbositySavings(db).normal.sessions === before, 'a live/uncosted row is excluded until it is priced');
}

// epsilon: real both-arm data, but outside the window.
for (let i = 0; i < 10; i++) mkRun('epsilon', 'normal', 10, 10_000, 1.0, 90);
for (let i = 0; i < 10; i++) mkRun('epsilon', 'terse', 10, 5_000, 0.5, 90);
assert(!agentRow('epsilon', 30), 'the trailing window excludes older runs');
assert(!!agentRow('epsilon', 120), 'and a wider window finds them again');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
