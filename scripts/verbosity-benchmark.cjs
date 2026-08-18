#!/usr/bin/env node
/**
 * verbosity-benchmark — a PAIRED, CONTROLLED measurement of what `TERSE_OUTPUT_BRIEF` actually does.
 *
 * Why this exists, and why it is not `verbositySavings`
 * ----------------------------------------------------
 * `verbositySavings()` (src/edge/verbosity.ts) compares terse and normal sessions as they happened on a
 * live tenant. Run against the real instapods DB it reports terse as 28–92% WORSE on four of five
 * comparable agents — and none of that is evidence, because of three defects the query cannot fix from
 * the inside:
 *
 *  1. **It measures the wrong quantity.** `term_sessions.output_tokens` is the raw provider counter, and
 *     over 40 recent live transcripts the assistant's output bytes split ~85% `tool_use` arguments
 *     (file writes, bash commands, patches) / ~15% `text` (narration). Thinking is a further ~18% of the
 *     token counter. The brief compresses NARRATION ONLY. So even a brief that deleted every word of
 *     narration could not move `output_tokens` by more than ~15%, and the ±50–90% swings the query
 *     reports are tool-use volume — i.e. which task the agent happened to draw — not verbosity.
 *  2. **The denominator moves with the treatment.** Terse changes turn SHAPE (fewer, denser turns), so
 *     dividing by turns lets the treatment inflate its own per-turn number. On the live data
 *     `marketing-manager` is 92% worse per turn and 25% cheaper per session, from the same rows.
 *  3. **It is a cutover, not a split.** Every normal session predates 2026-08-07 and every terse one
 *     follows it, so anything else that changed that day is inside the treatment arm.
 *
 * The fix is not a better query. It is to stop inferring causation from production and measure the
 * brief directly, the way the `caveman` project does: same prompts, same model, one variable.
 *
 * Design
 * ------
 *  - **Paired.** Every prompt is run through both arms; the statistic is the per-prompt delta, so a
 *    prompt that is simply long cancels out instead of loading one arm.
 *  - **One variable.** Both arms are identical `claude -p` invocations. The treatment appends
 *    `TERSE_OUTPUT_BRIEF` — read from `dist/` at run time, so the thing measured is always the thing
 *    shipped (the same reason caveman's benchmark reads its SKILL.md rather than a copy).
 *  - **Tools off.** The prompts are answerable from their own text and every tool is disallowed, so the
 *    response is pure narration and the 85% that terse cannot touch is excluded by construction rather
 *    than averaged over.
 *  - **Narration tokens, provider-reported.** `output_tokens - thinking_tokens`. Not an estimate, and
 *    not contaminated by reasoning the brief has no claim on.
 *  - **A completeness guard.** Each prompt declares `mustMention` literals a correct answer must still
 *    contain. Brevity that drops them is degradation, not saving, and the report scores it as such —
 *    without this the benchmark rewards an empty response.
 *  - **Two conditions.** `minimal` puts the brief in a bare system prompt: the CEILING, what it is worth
 *    when the model can actually see it. `production` (via `--company <file>`) prepends a real
 *    `session-*.company.md` first, which on the live fleet is ~14k tokens of which the brief is the last
 *    660. The gap between the two conditions IS the dilution hypothesis, measured.
 *
 * `claude -p` exposes no temperature, so a cell is repeated `--reps` times and averaged. Runs are
 * sequential and ordered; nothing here uses randomness, so a re-run with the same arguments is
 * comparable to the last one.
 *
 * Usage
 * -----
 *   npm run build                                  # the brief is read from dist/
 *   node scripts/verbosity-benchmark.cjs --model claude-haiku-4-5 --reps 2
 *   node scripts/verbosity-benchmark.cjs --company ~/agent-os-data/<tenant>/connectors/session-<id>.company.md
 *
 *   --model <id>      model to benchmark (default claude-haiku-4-5 — pin the one you actually run)
 *   --reps <n>        repetitions per cell (default 2)
 *   --company <file>  also run the `production` condition with this system prompt prepended
 *   --only <ids>      comma-separated prompt ids, for a smoke run
 *   --out <file>      write the raw per-call results as JSON
 *
 * Spends real tokens: calls = prompts x arms x conditions x reps. It prints the plan and the running
 * cost as it goes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { model: 'claude-haiku-4-5', reps: 2, company: null, only: null, outFile: null, briefs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--reps') out.reps = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.outFile = argv[++i];
    // `--brief <label>=<file>`, repeatable. Candidate briefs share ONE control arm, so comparing two
    // rewrites costs 1 + N arms rather than 2N — and they are compared against the same control
    // sample, which is the only way to tell two candidates apart without re-paying for the baseline.
    else if (a === '--brief') {
      const [label, file] = argv[++i].split('=');
      out.briefs.push({ label, file });
    }
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// ---------------------------------------------------------------------------- the brief under test

/** Read the SHIPPED brief, so the benchmark can never drift from the prompt production uses. */
function loadBrief() {
  const distPath = path.join(ROOT, 'dist', 'edge', 'verbosity.js');
  if (!fs.existsSync(distPath)) {
    console.error('error: dist/edge/verbosity.js not found — run `npm run build` first.');
    console.error('       (the brief is read from the build so the benchmark measures what ships)');
    process.exit(1);
  }
  const { TERSE_OUTPUT_BRIEF } = require(distPath);
  if (!TERSE_OUTPUT_BRIEF) {
    console.error('error: dist/edge/verbosity.js exports no TERSE_OUTPUT_BRIEF.');
    process.exit(1);
  }
  return TERSE_OUTPUT_BRIEF;
}

// ---------------------------------------------------------------------------- one call

// Everything that could put a `tool_use` block in the response. Narration is what we are measuring;
// a single Read call would swamp it (tool arguments are ~85% of real output tokens).
const NO_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'Agent', 'SlashCommand',
];

/**
 * One `claude -p` call. Returns provider-reported usage plus the answer text, or null on failure
 * (a failed cell is dropped from the averages rather than counted as zero — see the note in `main`).
 * `cwd` is a scratch dir with no CLAUDE.md, so no project memory leaks into either arm.
 */
function runOne({ model, prompt, systemFile, cwd }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowed-tools', ...NO_TOOLS,
  ];
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  let raw;
  try {
    raw = execFileSync('claude', args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    return { error: (e && e.message ? String(e.message) : 'spawn failed').slice(0, 200) };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'unparseable JSON from claude -p' };
  }
  if (json.is_error) return { error: String(json.result || 'is_error').slice(0, 200) };
  const u = json.usage || {};
  const outputTokens = u.output_tokens || 0;
  const thinking = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  const text = String(json.result || '');
  return {
    // The metric. Thinking is billed as output but is reasoning, not narration — the brief makes no
    // claim on it, so counting it would credit or blame terse for something it does not touch.
    narrationTokens: Math.max(0, outputTokens - thinking),
    outputTokens,
    thinkingTokens: thinking,
    costUsd: json.total_cost_usd || 0,
    chars: text.length,
    text,
  };
}

/** Did the answer keep the facts a correct answer needs? Brevity that drops these is not a saving. */
function complete(text, mustMention) {
  const hay = text.toLowerCase();
  const missing = (mustMention || []).filter((m) => !hay.includes(String(m).toLowerCase()));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------- reporting

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (from, to) => (from > 0 ? ((from - to) / from) * 100 : 0);
const fmtPct = (n) => `${n >= 0 ? '' : ''}${n.toFixed(1)}%`;

// Deterministic PRNG so a re-analysis of the same rows gives the same interval. Seeded LCG; the
// benchmark must never depend on wall-clock or unseeded randomness or two people reading the same
// results file get two different verdicts.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Bootstrap 95% CI for the mean of the per-prompt reductions.
 *
 * This exists because the first two runs of this benchmark were read as if a headline number meant
 * something, and it did not: with 2 reps the CONTROL arm alone — same prompts, same system prompt,
 * nothing changed between runs — drifted 21–28% (max 73%). An effect smaller than that is unresolvable,
 * so the report must say so rather than print a number that invites a decision.
 */
function bootstrapCI(values, iterations = 4000) {
  if (values.length < 2) return [NaN, NaN];
  const rand = lcg(0x5eed);
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

/**
 * Report one condition, comparing every candidate brief against the SAME control sample.
 *
 * Paired throughout: the headline is the mean of the PER-PROMPT reductions, not the reduction of the
 * pooled means — pooling would let one long prompt dominate. Every number is reported next to the
 * noise floor and a bootstrap CI, because the first two runs of this benchmark were read as findings
 * and were not: at 2 reps the control arm alone drifted 21-28% between runs.
 */
function report(condition, rows, treatments) {
  console.log(`\n${'='.repeat(96)}`);
  console.log(`CONDITION: ${condition}`);
  console.log('='.repeat(96));

  const promptIds = [...new Set(rows.map((r) => r.promptId))];
  const cell = (p, arm) => rows.filter((r) => r.promptId === p && r.arm === arm);
  const toks = (rs) => rs.map((r) => r.narrationTokens);

  // The noise floor, measured from this run's own data: how far two reps of the SAME cell sit apart.
  // Same prompt, same arm, same system prompt, nothing changed. Reported FIRST so it is read first —
  // any headline smaller than this is not a finding.
  const spreads = [];
  for (const p of promptIds) {
    for (const arm of ['normal', ...treatments.map((t) => t.label)]) {
      const t = toks(cell(p, arm));
      if (t.length < 2) continue;
      const m = mean(t);
      // Coefficient of variation, NOT (max - min)/mean. Range grows with the sample size, so a
      // range-based floor rises as you add reps — it read 22% at 2 reps and 60% at 6 on the same
      // harness, implying more data made the noise worse. CV is stable across rep counts, which is
      // the whole point of a floor you compare runs against.
      if (m > 0) {
        const sd = Math.sqrt(t.reduce((a, x) => a + (x - m) ** 2, 0) / (t.length - 1));
        spreads.push((sd / m) * 100);
      }
    }
  }
  const noiseFloor = mean(spreads);
  console.log(`noise floor (same-cell rep spread): ${fmtPct(noiseFloor)} — nothing below this is a finding\n`);

  const header = 'prompt'.padEnd(24) + 'normal'.padStart(8) + treatments.map((t) => t.label.padStart(10)).join('') + '   completeness';
  console.log(header);
  console.log('-'.repeat(96));

  const reductions = new Map(treatments.map((t) => [t.label, []]));
  const complete = new Map([['normal', [0, 0]], ...treatments.map((t) => [t.label, [0, 0]])]);
  const spend = new Map([['normal', 0], ...treatments.map((t) => [t.label, 0])]);

  for (const p of promptIds) {
    const n = cell(p, 'normal');
    if (!n.length) continue;
    const nTok = mean(toks(n));
    const cells = [];
    for (const t of treatments) {
      const c = cell(p, t.label);
      if (!c.length) { cells.push('—'); continue; }
      const red = pct(nTok, mean(toks(c)));
      reductions.get(t.label).push(red);
      cells.push(`${Math.round(mean(toks(c)))}`);
    }
    for (const [label, rs] of [['normal', n], ...treatments.map((t) => [t.label, cell(p, t.label)])]) {
      const cur = complete.get(label);
      complete.set(label, [cur[0] + rs.filter((r) => r.complete).length, cur[1] + rs.length]);
      spend.set(label, spend.get(label) + rs.reduce((a, r) => a + r.costUsd, 0));
    }
    console.log(
      p.padEnd(24) + String(Math.round(nTok)).padStart(8) + cells.map((c) => String(c).padStart(10)).join('') +
      `   ${complete.get('normal') ? '' : ''}${n.filter((r) => r.complete).length}/${n.length}` +
      treatments.map((t) => { const c = cell(p, t.label); return ` ${c.filter((r) => r.complete).length}/${c.length}`; }).join(''),
    );
  }

  console.log('-'.repeat(96));
  const summaries = [];
  for (const t of treatments) {
    const red = reductions.get(t.label);
    if (!red.length) continue;
    const [lo, hi] = bootstrapCI(red);
    const wins = red.filter((r) => r > 0).length;
    const resolvable = Number.isFinite(lo) && (lo > 0 || hi < 0);
    const [cOk, cTot] = complete.get(t.label);
    const [nOk, nTot] = complete.get('normal');
    console.log(`\n  ${t.label}`);
    console.log(`    mean reduction   ${fmtPct(mean(red)).padStart(8)}   95% CI [${fmtPct(lo)}, ${fmtPct(hi)}]`);
    console.log(`    median reduction ${fmtPct(median(red)).padStart(8)}   (prefer the median when they disagree — outliers)`);
    console.log(`    sign test        terse shorter on ${wins}/${red.length} prompts (coin flip = ${(red.length / 2).toFixed(1)})`);
    console.log(`    completeness     ${cOk}/${cTot}  (control ${nOk}/${nTot})`);
    console.log(`    spend            $${spend.get(t.label).toFixed(4)}  (control $${spend.get('normal').toFixed(4)})`);
    console.log(
      resolvable
        ? `    VERDICT: CI excludes zero — a real effect, direction ${mean(red) > 0 ? 'SHORTER' : 'LONGER'}.`
        : '    VERDICT: CI SPANS ZERO — this run cannot tell it from the control. Do not ship on it.',
    );
    if (cTot && nTot && cOk / cTot < nOk / nTot)
      console.log('    WARNING: answered LESS completely than the control — a reduction bought by dropping');
    summaries.push({ condition, label: t.label, mean: mean(red), median: median(red), ci: [lo, hi], resolvable, noiseFloor });
  }
  return summaries;
}

// ---------------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  // Candidate briefs. With no --brief the shipped one is measured, labelled `terse` — the original
  // behaviour. With --brief each candidate becomes its own arm sharing the one control.
  const candidates = args.briefs.length
    ? args.briefs.map((b) => ({ label: b.label, text: fs.readFileSync(b.file, 'utf8') }))
    : [{ label: 'terse', text: loadBrief() }];

  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'verbosity-prompts.json'), 'utf8'));
  let prompts = spec.prompts;
  if (args.only) prompts = prompts.filter((p) => args.only.includes(p.id));
  if (!prompts.length) {
    console.error('error: no prompts selected');
    process.exit(1);
  }

  // Scratch dir with no CLAUDE.md — a project memory file would load into EVERY arm and add thousands
  // of tokens of instructions that are not the thing under test.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vbench-'));

  // Written once per (condition, arm) and reused, so the provider can cache the prefix.
  const conditions = [];
  const armFiles = (base) => {
    const files = { normal: null };
    for (const c of candidates) {
      const f = path.join(work, `${base}-${c.label}.md`);
      fs.writeFileSync(f, base === 'minimal' ? c.text : `${companyBase}\n\n${c.text}`);
      files[c.label] = f;
    }
    return files;
  };

  let companyBase = '';
  conditions.push({ name: 'minimal', files: armFiles('minimal') });

  if (args.company) {
    const company = fs.readFileSync(args.company, 'utf8');
    // The live file already ENDS with a terse brief when the tenant default is terse. Strip it so the
    // control arm is genuinely untreated, then rebuild each treatment arm from its candidate text.
    const idx = company.indexOf('# Output style — terse');
    companyBase = (idx === -1 ? company : company.slice(0, idx)).trimEnd();
    const files = armFiles('prod');
    const prodNormal = path.join(work, 'prod-normal.md');
    fs.writeFileSync(prodNormal, companyBase);
    files.normal = prodNormal;
    conditions.push({ name: 'production', files });
    console.log(`production condition: ${args.company}`);
    console.log(`  base system prompt ${companyBase.length.toLocaleString()} chars (~${Math.round(companyBase.length / 4).toLocaleString()} tokens)`);
  }

  const arms = ['normal', ...candidates.map((c) => c.label)];
  const calls = prompts.length * arms.length * conditions.length * args.reps;
  console.log(`\nmodel ${args.model} | ${prompts.length} prompts | ${arms.length} arms (${arms.join(', ')}) | ${conditions.length} condition(s) | ${args.reps} rep(s) | ${calls} calls`);
  for (const c of candidates) console.log(`  candidate ${c.label}: ${c.text.length} chars (~${Math.round(c.text.length / 4)} tokens)`);
  console.log();

  const rows = [];
  let done = 0, spend = 0, failures = 0;
  for (const cond of conditions) {
    for (const p of prompts) {
      for (const arm of arms) {
        for (let rep = 0; rep < args.reps; rep++) {
          const res = runOne({ model: args.model, prompt: p.prompt, systemFile: cond.files[arm], cwd: work });
          done++;
          if (res.error) {
            failures++;
            process.stdout.write(`  [${done}/${calls}] ${cond.name}/${p.id}/${arm} FAILED: ${res.error}\n`);
            continue;
          }
          const c = complete(res.text, p.mustMention);
          spend += res.costUsd;
          rows.push({
            condition: cond.name, promptId: p.id, category: p.category, arm, rep,
            narrationTokens: res.narrationTokens, outputTokens: res.outputTokens,
            thinkingTokens: res.thinkingTokens, costUsd: res.costUsd, chars: res.chars,
            complete: c.ok, missing: c.missing, text: res.text,
          });
          process.stdout.write(
            `  [${done}/${calls}] ${cond.name}/${p.id}/${arm} ${String(res.narrationTokens).padStart(5)} tok` +
            `${c.ok ? '' : ` INCOMPLETE (missing ${c.missing.join(', ')})`}  $${spend.toFixed(3)}\n`,
          );
        }
      }
    }
  }

  const treatments = candidates.map((c) => ({ label: c.label }));
  const all = [];
  for (const cond of conditions) all.push(...report(cond.name, rows.filter((r) => r.condition === cond.name), treatments));

  const minimal = all.filter((s) => s.condition === 'minimal');
  const production = all.filter((s) => s.condition === 'production');
  if (minimal.length && production.length) {
    console.log(`\n${'='.repeat(96)}`);
    console.log('DILUTION — the same brief in a bare prompt vs behind the real company context');
    console.log('='.repeat(96));
    for (const m of minimal) {
      const p = production.find((x) => x.label === m.label);
      if (p) console.log(`  ${m.label.padEnd(12)} minimal ${fmtPct(m.mean).padStart(8)}   production ${fmtPct(p.mean).padStart(8)}   lost ${fmtPct(m.mean - p.mean)}`);
    }
  }

  console.log(`\ntotal spend $${spend.toFixed(4)}${failures ? ` | ${failures} call(s) failed and were dropped` : ''}`);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, JSON.stringify({ model: args.model, reps: args.reps, candidates: candidates.map((c) => ({ label: c.label, chars: c.text.length })), rows }, null, 2));
    console.log(`raw results → ${args.outFile}`);
  }
  console.log(`scratch dir (system prompts used): ${work}`);
}

main();