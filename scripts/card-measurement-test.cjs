#!/usr/bin/env node
/* "Is it working?" — the Step 4 measurement (docs/insights-revisit.md).
 *
 * The old version measured `recommendation.applied` events, of which the fleet had produced exactly one
 * in its history: it measured our own Apply clicks, not the world. This measures the question the rebuild
 * is built around — a card was raised, did a human do anything, did the problem stop — and the verdict
 * that matters most is the uncomfortable one, `no-action`.
 *
 * Also pinned: the trend now reads the DERIVED outcome and carries the undecidable share beside the rate,
 * so "the work got worse" can never again be confused with "we stopped being able to tell". */
const fs = require('fs');
const os_ = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-cardmeas-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { measureCards, measureLearning } = require(path.join(ROOT, 'dist/edge/measurement.js'));

const aos = loadAgentOS();
const NOW = Date.now();
const HOUR = 3600_000, DAY = 24 * HOUR;

const tdir = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-cardmeas-tr-'));
const asst = (t) => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
let n = 0;

/** A quota death on `account`, `hoursAgo`. Writes the transcript the derivation reads. */
function death(account, hoursAgo) {
  const id = 'ts_' + (++n), at = NOW - hoursAgo * HOUR, convo = 'c_' + n;
  aos.db.prepare(
    'INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at,' +
      'claude_session_id,tool_calls,active_ms,runtime_account) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)',
  ).run(id, 'worker', 't', 'x', 'aos-' + id, 'done', 'automation:au_1', at, at + 5_000, convo, 1, 5_000, account);
  fs.writeFileSync(path.join(tdir, `${convo}.jsonl`), [asst('starting'), asst("You've hit your weekly limit")].join('\n'));
}
const card = (key, hoursAgo, title) => aos.db
  .prepare("INSERT INTO audit_events (ts,tenant,run_id,principal,type,data) VALUES (?,?,'-','system','insights.alert',?)")
  .run(NOW - hoursAgo * HOUR, aos.tenant, JSON.stringify({ key, title, severity: 'high' }));
const action = (type, hoursAgo) => aos.db
  .prepare("INSERT INTO audit_events (ts,tenant,run_id,principal,type,data) VALUES (?,?,'-','owner',?,'{}')")
  .run(NOW - hoursAgo * HOUR, aos.tenant, type);

// The derivation finds transcripts through CLAUDE_CONFIG_DIR/projects; point it at the fixture dir.
const projects = path.join(HOME, 'cfg', 'projects', 'p');
fs.mkdirSync(projects, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'cfg');

console.log('\n\x1b[1mIs it working? — a card was raised; did anything change\x1b[0m');

// ── nobody acted ───────────────────────────────────────────────────────────────────────────────────
{
  for (let i = 0; i < 4; i++) death('acct-quiet', 100 + i);   // before the card
  card('runtime-deaths:acct-quiet', 96, '4 runs killed by the "acct-quiet" account in 48h');
  for (const f of fs.readdirSync(tdir)) fs.copyFileSync(path.join(tdir, f), path.join(projects, f));

  const c = measureCards(aos, NOW).find((x) => x.key === 'runtime-deaths:acct-quiet');
  assert(!!c, 'a raised card is measured at all');
  assert(c.verdict === 'no-action', 'a card nobody acted on reads `no-action` — the answer the old loop could not give', c && c.verdict);
  assert(c.actedAt === null && c.action === null, 'and it names no action, because there was none');
  assert(c.before === 4, 'it counts the signal before the card', c && String(c.before));
}

// ── acted, and the deaths stopped ──────────────────────────────────────────────────────────────────
{
  for (let i = 0; i < 5; i++) death('acct-fixed', 100 + i);
  card('runtime-deaths:acct-fixed', 96, '5 runs killed by the "acct-fixed" account in 48h');
  action('runtime.account.added', 90);                        // a human replaced it; no deaths after
  for (const f of fs.readdirSync(tdir)) fs.copyFileSync(path.join(tdir, f), path.join(projects, f));

  const c = measureCards(aos, NOW).find((x) => x.key === 'runtime-deaths:acct-fixed');
  assert(c.verdict === 'resolved', 'acted on and the signal stopped → resolved', c.verdict);
  assert(c.action === 'runtime.account.added', 'the action that plausibly fixed it is named', c.action);
  assert(c.after === 0, 'nothing since the fix');
}

// ── acted, and it kept happening ───────────────────────────────────────────────────────────────────
{
  for (let i = 0; i < 3; i++) death('acct-still', 100 + i);
  card('runtime-deaths:acct-still', 96, '3 runs killed by the "acct-still" account in 48h');
  action('runtime.account.checked', 90);
  for (let i = 0; i < 2; i++) death('acct-still', 40 + i);    // after the "fix"
  for (const f of fs.readdirSync(tdir)) fs.copyFileSync(path.join(tdir, f), path.join(projects, f));

  const c = measureCards(aos, NOW).find((x) => x.key === 'runtime-deaths:acct-still');
  assert(c.verdict === 'ongoing', 'acted on and it kept happening → ongoing, not resolved', c.verdict);
  assert(c.after === 2, 'the recurrence is counted, not rounded away', String(c.after));
}

// ── not enough time yet ────────────────────────────────────────────────────────────────────────────
{
  for (let i = 0; i < 3; i++) death('acct-new', 30 + i);
  card('runtime-deaths:acct-new', 6, '3 runs killed by the "acct-new" account in 48h');
  for (const f of fs.readdirSync(tdir)) fs.copyFileSync(path.join(tdir, f), path.join(projects, f));

  const c = measureCards(aos, NOW).find((x) => x.key === 'runtime-deaths:acct-new');
  assert(c.verdict === 'too-early', 'a card raised hours ago is not yet judged as ignored', c.verdict);
}

// ── signals we cannot count are not shown ──────────────────────────────────────────────────────────
{
  card('agent-crash:someone', 96, "someone's runs keep crashing");
  const c = measureCards(aos, NOW).find((x) => x.key === 'agent-crash:someone');
  assert(!c, 'a card whose recurrence we cannot measure is omitted rather than given a made-up verdict');
}

// ── the trend reads the derived outcome, with the undecidable share beside it ──────────────────────
{
  const m = measureLearning(aos, NOW);
  assert(Array.isArray(m.trend) && m.trend.length === 8, 'eight weekly buckets');
  assert(m.trend.every((b) => 'unknownShare' in b), 'every bucket carries its undecidable share');
  assert('unknownShare' in m.recent && 'unknownShare' in m.prior, 'so do the headline windows — a rate alone is the old mistake');
  assert(!('interventions' in m), 'the old Apply-click intervention list is gone');
  // The deaths above are real derived failures, so the window has signal rather than being empty.
  assert(m.recent.n > 0 || m.prior.n > 0 || m.trend.some((b) => b.total > 0), 'the trend is computed over derived outcomes');
}

fs.rmSync(tdir, { recursive: true, force: true });
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
