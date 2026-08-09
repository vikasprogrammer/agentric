#!/usr/bin/env node
/* Blind-labelling sampler for the derived outcome (docs/insights-revisit.md, Step 1).
 *
 * The derivation must be checked against something it cannot see. This dumps the EVIDENCE for a sample of
 * conversations — the task it was given and what the agent actually said in the transcript — and writes the
 * derived verdicts to a SEPARATE file the labeller is not meant to open first. Label from the evidence,
 * then run `outcome-label-score.cjs` to get the confusion counts.
 *
 * Selection is stratified by basis (up to `PER_BASIS` each) so rare rules — a crash, a task close, a
 * retry — actually appear in 30 rows instead of being drowned by the reported majority. Stratifying the
 * SELECTION is fine; the labelling stays blind because the evidence file carries no verdict, no basis, and
 * none of the fields the rules key on (status, tool_calls, rating, the reported outcome).
 *
 *   AGENT_OS_HOME=<snapshot> node scripts/outcome-label-sample.cjs <outdir>
 *
 * ⚠ Point AGENT_OS_HOME at a SNAPSHOT (`sqlite3 live.db ".backup snap.db"`), never the live home — this
 * opens the DB through the kernel, which migrates on open.
 * ⚠ The evidence file quotes real transcripts. It is written outside the repo and must not be committed;
 * only the labels (a verdict per opaque conversation id) belong in git.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'aos-outcome-sample');
const PER_BASIS = 5;
const TAIL_CHARS = 1400;   // how much of the transcript tail to quote per conversation

if (!process.env.AGENT_OS_HOME) { console.error('refusing to run without AGENT_OS_HOME (use a snapshot, not the live home)'); process.exit(1); }

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { deriveRunOutcomes, foldConversations } = require(path.join(ROOT, 'dist/edge/outcome.js'));
const { readConversation } = require(path.join(ROOT, 'dist/edge/conversation.js'));

const os = loadAgentOS();
let convos = foldConversations(deriveRunOutcomes(os));

// `--exclude <labels.json>` drops conversations already labelled in an earlier round. A re-validation is
// only worth running on rows the rules were NOT tuned against: the first round's errors bought two rules,
// so scoring those same rows again measures the fitting, not the derivation.
const exArg = process.argv.indexOf('--exclude');
if (exArg > -1 && process.argv[exArg + 1]) {
  const prior = new Set(Object.keys(JSON.parse(fs.readFileSync(process.argv[exArg + 1], 'utf8')).labels));
  const before = convos.length;
  convos = convos.filter((c) => !prior.has(c.convoId));
  console.log(`excluding ${before - convos.length} already-labelled conversations`);
}

// Stratify: up to PER_BASIS per basis, taken evenly across each stratum so it isn't just the newest rows.
const byBasis = new Map();
for (const c of convos) { const a = byBasis.get(c.basis) ?? []; a.push(c); byBasis.set(c.basis, a); }
const picked = [];
for (const [, list] of [...byBasis].sort((a, b) => a[0].localeCompare(b[0]))) {
  const stride = Math.max(1, Math.floor(list.length / PER_BASIS));
  for (let i = 0; i < list.length && picked.length % PER_BASIS !== PER_BASIS - 1 + 1; i += stride) {
    picked.push(list[i]);
    if (picked.filter((p) => p.basis === list[i].basis).length >= PER_BASIS) break;
  }
}

// Deterministic shuffle (no Math.random — the sample must be reproducible), so adjacent rows in the
// evidence file don't share a basis and give the game away.
picked.sort((a, b) => (a.convoId + a.agent).localeCompare(b.convoId + b.agent));

const evidence = [];
const truth = [];
for (const c of picked) {
  const runs = os.db.prepare('SELECT id, title, task, spawned_by, created_at FROM term_sessions WHERE COALESCE(claude_session_id, id) = ? ORDER BY created_at').all(c.convoId);
  const first = runs[0] ?? {};
  let tail = '';
  try {
    const conv = readConversation(c.convoId);
    const text = (conv.turns ?? conv.messages ?? [])
      .map((t) => `${t.role ?? t.kind ?? '?'}: ${String(t.text ?? t.content ?? '').replace(/\s+/g, ' ')}`)
      .join('\n');
    tail = text.slice(-TAIL_CHARS);
  } catch { tail = '(no transcript on this box)'; }

  evidence.push({
    id: c.convoId,
    agent: c.agent,
    runs: c.runs,
    spawn: String(first.spawned_by ?? '').replace(/^(task|poke):.*/, '$1:…'), // kind only, not the task id
    title: first.title ?? '',
    task: String(first.task ?? '').slice(0, 700),
    transcriptTail: tail,
  });
  truth.push({ id: c.convoId, verdict: c.verdict, basis: c.basis });
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
fs.writeFileSync(path.join(OUT, 'derived.json'), JSON.stringify(truth, null, 2));
console.log(`${evidence.length} conversations → ${OUT}/evidence.json  (derived verdicts held in derived.json — label first)`);
console.log(`bases sampled: ${[...new Set(truth.map((t) => t.basis))].join(', ')}`);
