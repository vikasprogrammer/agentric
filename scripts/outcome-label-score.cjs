#!/usr/bin/env node
/* Score the derived outcome against the blind hand-labels (docs/insights-revisit.md, Step 1).
 *
 *   AGENT_OS_HOME=<snapshot> node scripts/outcome-label-score.cjs
 *
 * The bar is NOT "the rules agree with a human". It is that the derivation beats the thing it replaces.
 * Two baselines are printed alongside it, both of which the old metric effectively was:
 *   · always-success — what a 0.3%-failure self-report is, rounded;
 *   · the reported outcome alone — the actual old signal, with its unknowns.
 *
 * A disagreement is reported per pair so the failure mode is visible rather than summarised away, and the
 * `?` rows (no transcript on this box → no independent evidence) are excluded from the denominator instead
 * of being scored as agreement. Exit code is non-zero only if the derivation loses to a baseline. */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
if (!process.env.AGENT_OS_HOME) { console.error('refusing to run without AGENT_OS_HOME (use a snapshot, not the live home)'); process.exit(1); }

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { deriveRunOutcomes, foldConversations } = require(path.join(ROOT, 'dist/edge/outcome.js'));

// Which label set to score. Defaults to round 1; pass a path to score a later, independent round.
const LABELS = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'outcome-labels.json');
const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8')).labels;
console.log(`labels: ${path.basename(LABELS)}`);
const os = loadAgentOS();
const convos = new Map(foldConversations(deriveRunOutcomes(os)).map((c) => [c.convoId, c]));

const rows = [];
for (const [id, human] of Object.entries(labels)) {
  const c = convos.get(id);
  if (!c) { rows.push({ id, human, derived: '(missing)', basis: '-', reported: '-' }); continue; }
  rows.push({ id, human, derived: c.verdict, basis: c.basis });
}

// Three populations, kept apart on purpose:
//  · judged      — the OS claims a verdict and the labeller had evidence. The only accuracy number.
//  · unscorable  — the OS declares it can't judge (a person's own interactive session). Not an error, but
//                  NOT a free pass either: the labeller often COULD judge these, so they are reported as a
//                  coverage gap with the labels that were lost.
//  · skipped     — no transcript on this box, so no independent evidence existed to label against.
const labelled = rows.filter((r) => r.human !== '?' && r.derived !== '(missing)');
const unscorable = labelled.filter((r) => r.derived === 'abandoned');
const judged = labelled.filter((r) => r.derived !== 'abandoned');
const skipped = rows.length - labelled.length;

// Baseline 1: call everything a success (what a self-report with one failure in 329 amounts to).
const alwaysSuccess = judged.filter((r) => r.human === 'success').length;
// Baseline 2: the old signal — the agent's own report, `unknown` where it didn't call one.
const reportedOnly = judged.filter((r) => r.basis === 'reported' && r.human === r.derived).length;
const agree = judged.filter((r) => r.human === r.derived).length;

// A softer, arguably fairer read: did the derivation get the SIGN right — did work land or not?
const sign = (v) => (v === 'success' ? 'ok' : v === 'abandoned' ? 'n/a' : 'not-ok');
const signAgree = judged.filter((r) => sign(r.human) === sign(r.derived)).length;

const pct = (n) => `${Math.round((n / judged.length) * 100)}%`;

console.log(`\n\x1b[1mDerived outcome vs blind hand-labels\x1b[0m — ${judged.length} judged, ${unscorable.length} declared unscorable, ${skipped} skipped (no transcript ⇒ no independent evidence)\n`);
if (unscorable.length) {
  const spread = unscorable.reduce((m, r) => ({ ...m, [r.human]: (m[r.human] ?? 0) + 1 }), {});
  console.log(`  coverage gap: the OS declines to judge ${unscorable.length} conversations a human could label (${Object.entries(spread).map(([k, v]) => `${v} ${k}`).join(', ')})\n`);
}
console.log(`  exact agreement        ${agree}/${judged.length}  ${pct(agree)}`);
console.log(`  sign agreement         ${signAgree}/${judged.length}  ${pct(signAgree)}   (landed vs didn't)`);
console.log(`  baseline: always-success  ${alwaysSuccess}/${judged.length}  ${pct(alwaysSuccess)}`);
console.log(`  of which the report alone got right: ${reportedOnly}\n`);

const confusion = new Map();
for (const r of judged) {
  const k = `${r.human} → ${r.derived}`;
  confusion.set(k, (confusion.get(k) ?? 0) + 1);
}
console.log('  human → derived:');
for (const [k, n] of [...confusion].sort((a, b) => b[1] - a[1])) console.log(`    ${n}×  ${k}${k.split(' → ')[0] === k.split(' → ')[1] ? '' : '   ✗'}`);

const wrong = judged.filter((r) => r.human !== r.derived);
if (wrong.length) {
  console.log('\n  disagreements (basis that produced the derived verdict):');
  for (const r of wrong) console.log(`    ${r.id.slice(0, 8)}  human=${r.human}  derived=${r.derived}  via ${r.basis}`);
}

const beatsBaseline = agree > alwaysSuccess;
console.log(`\n  ${beatsBaseline ? '\x1b[32m✓' : '\x1b[31m✗'} derivation ${beatsBaseline ? 'beats' : 'does NOT beat'} the always-success baseline\x1b[0m\n`);
process.exit(beatsBaseline ? 0 : 1);
