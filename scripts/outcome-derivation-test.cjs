#!/usr/bin/env node
/* Derived-outcome rules (docs/insights-revisit.md, Step 1).
 *
 * Synthetic rows, so each rule and each precedence edge is exact. The live-corpus check is a separate,
 * manual pair — `outcome-label-sample.cjs` + `outcome-label-score.cjs` against a DB snapshot — because it
 * needs transcripts and a human read; this file is what CI can run.
 *
 * The property at the bottom is the one that matters most: the metric must move when real failures move
 * and NOT when reporting discipline does. That is the exact defect Step 0 deleted, restated as a test. */
const fs = require('fs');
const os_ = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-outcome-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { deriveRunOutcomes, foldConversations, summarize } = require(path.join(ROOT, 'dist/edge/outcome.js'));

const aos = loadAgentOS();
const NOW = Date.now();
let n = 0;

/** One terminated run. Everything the rules read is explicit — no hidden defaults to argue with later. */
function mkRun(o) {
  const id = 'ts_' + (++n);
  const at = o.at ?? NOW - 3600_000;
  aos.db.prepare(
    'INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at,' +
      'claude_session_id,rating,outcome,tool_calls,active_ms) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)',
  ).run(id, o.agent ?? 'worker', 't', 'x', 'aos-' + id, o.status ?? 'done', o.spawnedBy ?? 'automation:au_1',
    at, at + (o.activeMs ?? 300_000), o.convo ?? null, o.rating ?? null, o.outcome ?? null,
    o.toolCalls === undefined ? 20 : o.toolCalls, o.activeMs ?? 300_000);
  return id;
}
const verdictOf = (id) => deriveRunOutcomes(aos, { since: 0, until: NOW + 1 }).find((r) => r.runId === id);

console.log('\n\x1b[1mDerived outcome — rules over observed facts, not the agent\'s own grade\x1b[0m');

// ── each rule fires ────────────────────────────────────────────────────────────────────────────────
{
  const up = mkRun({ rating: 'up', outcome: 'failure' });        // human outranks the report
  const down = mkRun({ rating: 'down', outcome: 'success' });
  assert(verdictOf(up).verdict === 'success' && verdictOf(up).basis === 'human-rating', '👍 outranks a reported failure');
  assert(verdictOf(down).verdict === 'failure' && verdictOf(down).basis === 'human-rating', '👎 outranks a reported success');

  const crashed = mkRun({ status: 'crashed', outcome: 'success' });
  assert(verdictOf(crashed).verdict === 'failure' && verdictOf(crashed).basis === 'crashed', 'a crash outranks a reported success');

  const early = mkRun({ activeMs: 9_000, toolCalls: 2 });
  assert(verdictOf(early).basis === 'died-early' && verdictOf(early).verdict === 'failure', 'an automation run dead in 9s is a failure');

  const noop = mkRun({ toolCalls: 0, activeMs: 600_000 });
  assert(verdictOf(noop).verdict === 'noop' && verdictOf(noop).basis === 'no-tool-calls', 'zero tool calls is a noop, not an unknown');

  const reported = mkRun({ outcome: 'partial' });
  assert(verdictOf(reported).verdict === 'partial' && verdictOf(reported).basis === 'reported', 'the report is still used when it exists');

  const nothing = mkRun({});
  assert(verdictOf(nothing).verdict === 'unknown' && verdictOf(nothing).basis === 'no-evidence', 'no evidence stays honestly unknown');
}

// ── the guards that cost a wrong answer on live data ───────────────────────────────────────────────
{
  const shortTask = mkRun({ spawnedBy: 'task:tsk_short', activeMs: 8_000, toolCalls: 3 });
  assert(verdictOf(shortTask).basis !== 'died-early', 'a TASK run finishing in 8s is not a died-early failure (smoke tests are fast)');

  const chatty = mkRun({ activeMs: 5_000, toolCalls: 0 });
  assert(verdictOf(chatty).verdict === 'noop', 'a short automation run that called nothing is a noop, not a failure');

  const human = mkRun({ spawnedBy: 'm_alice', status: 'stopped', toolCalls: 40 });
  assert(verdictOf(human).verdict === 'abandoned' && verdictOf(human).basis === 'human-session', "a person's own interactive session is unscorable, not a failure");

  const chat = mkRun({ spawnedBy: 'chat:support' });
  assert(!verdictOf(chat), 'chat-triggered runs are excluded entirely');

  const stopped = mkRun({ spawnedBy: 'task:tsk_stop', status: 'stopped', toolCalls: 90 });
  assert(verdictOf(stopped).verdict === 'incomplete' && verdictOf(stopped).basis === 'stopped-midway', 'a killed unattended run is incomplete, never a success');
}

// ── the transcript layer (Step 1b) ─────────────────────────────────────────────────────────────────
{
  // A fake transcript store, so the rules are tested without depending on ~/.claude on this machine.
  const tdir = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-transcripts-'));
  const write = (id, lines) => {
    const p = path.join(tdir, `${id}.jsonl`);
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
    return p;
  };
  const asst = (text) => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const find = (id) => { const p = path.join(tdir, `${id}.jsonl`); return fs.existsSync(p) ? p : undefined; };
  const verdictWith = (id) => deriveRunOutcomes(aos, { since: 0, until: NOW + 1, findTranscript: find }).find((r) => r.runId === id);

  const summary = 'x'.repeat(400) + ' Watermark updated. Discord summary sent to the owner.';

  // A run that finished properly and simply never called `report` — the single largest error class in
  // round 2 (5 of 11). It is a success the OS was throwing away, not an unknown.
  const clean = mkRun({ convo: 'tr-clean', spawnedBy: 'automation:au_x' });
  write('tr-clean', [asst('starting'), asst(summary)]);
  assert(verdictWith(clean).verdict === 'success' && verdictWith(clean).basis === 'finished-clean',
    'a run that ended with a real closing summary and no error is a success, not an unknown');

  // Killed by the runtime. Round 2 scored these `noop`, because a run that dies on its first API call
  // also makes no tool calls.
  const dead = mkRun({ convo: 'tr-dead', spawnedBy: 'automation:au_x', toolCalls: 0, activeMs: 600_000 });
  write('tr-dead', [asst('I will start by loading my memory.'), asst('Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.')]);
  assert(verdictWith(dead).verdict === 'failure' && verdictWith(dead).basis === 'runtime-death',
    'a quota/auth death with zero tool calls is a failure, not a noop');

  const interrupted = mkRun({ convo: 'tr-int', spawnedBy: 'automation:au_x' });
  write('tr-int', [asst('working'), { message: { role: 'user', content: '[Request interrupted by user]' } }]);
  assert(verdictWith(interrupted).verdict === 'incomplete' && verdictWith(interrupted).basis === 'interrupted',
    'a turn a person interrupted is incomplete');

  // The guard that keeps the layer honest: an agent that answered and stopped is still a noop.
  const chatty = mkRun({ convo: 'tr-chatty', spawnedBy: 'automation:au_x', toolCalls: 0, activeMs: 600_000 });
  write('tr-chatty', [asst('Hi — looks like a test message. Tell me what you want built.')]);
  assert(verdictWith(chatty).verdict === 'noop', 'a short reply with no work is still a noop, not a death');

  // A stub closing line is not a hand-off.
  const stub = mkRun({ convo: 'tr-stub', spawnedBy: 'automation:au_x' });
  write('tr-stub', [asst('ok')]);
  assert(verdictWith(stub).verdict === 'unknown', 'a two-character closing message does not count as finishing clean');

  // The layer must never overrule a decided verdict — prose does not beat a report or a human.
  const reported = mkRun({ convo: 'tr-rep', spawnedBy: 'automation:au_x', outcome: 'partial' });
  write('tr-rep', [asst(summary)]);
  assert(verdictWith(reported).basis === 'reported' && verdictWith(reported).verdict === 'partial',
    'a reported outcome is not second-guessed by the transcript');

  const rated = mkRun({ convo: 'tr-rated', spawnedBy: 'automation:au_x', rating: 'down', toolCalls: 0 });
  write('tr-rated', [asst(summary)]);
  assert(verdictWith(rated).basis === 'human-rating', 'a human rating is not second-guessed by the transcript');

  // No transcript is a normal case, not an error.
  const noFile = mkRun({ convo: 'tr-absent', spawnedBy: 'automation:au_x' });
  assert(verdictWith(noFile).verdict === 'unknown' && verdictWith(noFile).basis === 'no-evidence',
    'a missing transcript leaves the verdict honestly unknown');

  fs.rmSync(tdir, { recursive: true, force: true });
}

// ── conversation folding ───────────────────────────────────────────────────────────────────────────
{
  const cid = 'convo-1';
  mkRun({ convo: cid, at: NOW - 7200_000, spawnedBy: 'task:tsk_a' });                    // unknown
  mkRun({ convo: cid, at: NOW - 3600_000, spawnedBy: 'poke:tsk_a', outcome: 'success' }); // then finished
  const folded = foldConversations(deriveRunOutcomes(aos, { since: 0, until: NOW + 1 })).find((c) => c.convoId === cid);
  assert(folded && folded.runs === 2, 'resumes fold into one conversation, not two outcomes');
  assert(folded && folded.verdict === 'success', 'a hand-off that needed a poke and then landed is a success');

  const cid2 = 'convo-2';
  mkRun({ convo: cid2, at: NOW - 7200_000, status: 'crashed' });
  mkRun({ convo: cid2, at: NOW - 3600_000, outcome: 'success' });
  const f2 = foldConversations(deriveRunOutcomes(aos, { since: 0, until: NOW + 1 })).find((c) => c.convoId === cid2);
  assert(f2 && f2.verdict === 'failure', 'a later clean run does not erase an earlier crash');

  // Step 1b fold fix: a hand-off whose earlier attempts each read `incomplete` (each was followed by
  // another run — that is all `task-retried` means) is scored by its RESULT, not by its struggle.
  const cid3 = 'convo-3';
  mkRun({ convo: cid3, at: NOW - 10800_000, spawnedBy: 'task:tsk_multi' });
  mkRun({ convo: cid3, at: NOW - 7200_000, spawnedBy: 'poke:tsk_multi' });
  mkRun({ convo: cid3, at: NOW - 3600_000, spawnedBy: 'poke:tsk_multi', outcome: 'success' });
  const f3 = foldConversations(deriveRunOutcomes(aos, { since: 0, until: NOW + 1 })).find((c) => c.convoId === cid3);
  assert(f3 && f3.verdict === 'success' && f3.runs === 3, 'three attempts ending in success is a success, not an incomplete');
}

// ── the summary contract ───────────────────────────────────────────────────────────────────────────
{
  const all = summarize(foldConversations(deriveRunOutcomes(aos, { since: 0, until: NOW + 1 })));
  assert(all.scorable === all.success + all.partial + all.incomplete + all.noop + all.failure + all.unknown,
    'scorable is exactly the decided verdicts plus the honest unknowns', JSON.stringify(all));
  assert(!Number.isNaN(all.abandoned) && all.abandoned > 0 && all.scorable > 0, 'abandoned is tracked but sits outside scorable');
  const tiny = summarize([{ convoId: 'x', agent: 'a', verdict: 'success', basis: 'reported', runs: 1, at: NOW }]);
  assert(tiny.successRate === null, 'no success rate below the minimum sample');
  assert(tiny.unknownShare === 0, 'unknown share is still reported on a tiny sample');
}

// ── THE property: the metric must move with failures, not with reporting discipline ────────────────
{
  const base = () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({ convoId: 'c' + i, agent: 'a', verdict: 'success', basis: 'reported', runs: 1, at: NOW });
    return rows;
  };
  // Ten runs stop calling `report` — but nothing actually failed. Under the old metric this alone moved
  // the rate 50 points. Here they become `unknown`: the rate barely moves and the unknown SHARE shouts.
  const quiet = base();
  for (let i = 0; i < 10; i++) quiet[i] = { ...quiet[i], verdict: 'unknown', basis: 'no-evidence' };
  // Ten runs genuinely fail.
  const broken = base();
  for (let i = 0; i < 10; i++) broken[i] = { ...broken[i], verdict: 'failure', basis: 'crashed' };

  const b = summarize(base()), q = summarize(quiet), r = summarize(broken);
  assert(q.unknownShare === 50 && q.unknown === 10, 'ten silent runs show up as a 50% unknown share, not as failures', JSON.stringify(q));
  assert(r.failure === 10 && r.unknownShare === 0, 'ten real failures show up as failures with no unknowns', JSON.stringify(r));
  assert(b.successRate === 100 && r.successRate === 50, 'the rate moves when work actually fails');
  assert(q.successRate === 50 && q.unknownShare === 50,
    'when the rate moves for a REPORTING reason, the unknown share moves with it — the reader can always tell the two apart');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
