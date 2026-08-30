#!/usr/bin/env node
/**
 * output-style-benchmark — a PAIRED, CONTROLLED measurement of what a Claude Code OUTPUT STYLE does.
 *
 * Lineage, because it is the whole argument for this file
 * ------------------------------------------------------
 * This harness was built to measure `TERSE_OUTPUT_BRIEF`, the appended compression brief that the
 * `verbosity` knob used to inject. It found nothing: two quite different wordings, 504 calls, 6 reps,
 * and every bootstrap CI spanned zero — per-call narration length has a ~20-23% coefficient of
 * variation whatever you put in the prompt, so an effect above ~10% would have shown and did not. The
 * brief and the knob were deleted in v0.406.0 and replaced by Claude Code's own output styles, which
 * put the instruction in the system prompt PROPER and re-assert it each turn rather than appending it
 * once. The harness is re-pointed rather than retired, because the discipline it enforces outlives the
 * feature it was built for: **no style ships with a cost or quality claim that this has not measured.**
 *
 * It also inherits the reason `verbositySavings()` was retired. That query compared terse and normal
 * sessions as they happened on a live tenant, and reported terse as 28-92% WORSE on four of five
 * agents — none of it evidence, for three reasons no query can fix from the inside:
 *
 *  1. **The wrong quantity.** `term_sessions.output_tokens` is the raw provider counter, and over 40
 *     live transcripts the assistant's output splits ~85% `tool_use` arguments (file writes, commands,
 *     patches) / ~15% `text`. Thinking is a further ~18% of the counter. A style shapes NARRATION, so
 *     even total compliance could not move `output_tokens` more than ~15%; the ±50-90% swings were
 *     tool-use volume, i.e. which task the agent drew.
 *  2. **A denominator the treatment moves.** A style changes turn SHAPE, so dividing by turns lets it
 *     inflate its own per-turn number: one live agent read 92% worse per turn and 25% cheaper per
 *     session, from the same rows.
 *  3. **A cutover, not a split.** Every treated session followed the flag day, so everything else that
 *     changed that day sits inside the treatment arm.
 *
 * Design
 * ------
 *  - **Paired.** Every prompt runs through every arm; the statistic is the per-prompt delta, so a
 *    prompt that is simply long cancels out instead of loading one arm.
 *  - **One variable.** All arms are identical `claude -p` invocations. The only difference is
 *    `--settings '{"outputStyle":"<name>"}'` — the exact mechanism `terminal/claude-launch.sh` uses,
 *    so the thing measured is the thing shipped. A CUSTOM style is measured by pointing `--cwd-styles`
 *    at a directory of `.md` files, the same way the library is materialised into an agent folder.
 *  - **Tools off.** The prompts are answerable from their own text and every tool is disallowed, so the
 *    response is pure narration and the 85% a style cannot touch is excluded by construction.
 *  - **Narration tokens, provider-reported.** `output_tokens - thinking_tokens`. Not an estimate, and
 *    not contaminated by reasoning no style makes a claim on.
 *  - **A completeness guard.** Each prompt declares `mustMention` literals a correct answer must still
 *    contain. Brevity that drops them is degradation, not saving. This matters more than the token
 *    delta: the one durable finding from the terse work was that per-turn reinforcement made answers
 *    shorter AND more complete (60/90 vs 48/90, p=0.036) — i.e. an answer-SHAPE effect worth having,
 *    on a mechanism whose cost saving was ~$0.13/month. Read the completeness column first.
 *  - **Two conditions.** `minimal` runs the style against a bare prompt: the ceiling. `production`
 *    (via `--company <file>`) prepends a real `session-*.company.md` — on the live fleet ~14k tokens —
 *    which is the dilution a style has to survive. Unlike an appended brief, an output style is
 *    injected by the CLI ABOVE that context and re-asserted per turn, so this gap is the thing most
 *    worth watching.
 *
 * WARNING — an unknown style name is SILENTLY ignored (exit 0, runs as Default). A typo here does not
 * fail; it quietly makes both arms the control and reports "no effect". Names are checked against the
 * built-ins and `--cwd-styles` before any call is spent.
 *
 * `claude -p` exposes no temperature, so a cell is repeated `--reps` times and averaged. Runs are
 * sequential and ordered; nothing here uses randomness.
 *
 * Usage
 * -----
 *   node scripts/output-style-benchmark.cjs --style Concise --reps 3
 *   node scripts/output-style-benchmark.cjs --style Concise --style Proactive \
 *        --company ~/agent-os-data/<tenant>/connectors/session-<id>.company.md
 *   node scripts/output-style-benchmark.cjs --style Housevoice --cwd-styles ~/agent-os-data/<tenant>/output-styles
 *
 *   --style <name>     a style to measure, repeatable (default: Concise). Every candidate shares ONE
 *                      control arm, so N styles cost 1+N arms rather than 2N — and they are compared
 *                      against the same control sample, the only way to tell two apart honestly.
 *   --cwd-styles <dir> a directory of custom style .md files, copied into the run's `.claude/output-styles`
 *   --model <id>       model to benchmark (default claude-haiku-4-5 — pin the one you actually run)
 *   --reps <n>         repetitions per cell (default 2)
 *   --company <file>   also run the `production` condition with this system prompt prepended
 *   --only <ids>       comma-separated prompt ids, for a smoke run
 *   --out <file>       write the raw per-call results as JSON
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
  const out = { model: 'claude-haiku-4-5', reps: 2, company: null, only: null, outFile: null, styles: [], cwdStyles: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--reps') out.reps = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.outFile = argv[++i];
    // `--style <name>`, repeatable. Candidates share ONE control arm, so comparing two styles costs
    // 1 + N arms rather than 2N — and they are compared against the same control sample, which is the
    // only way to tell two candidates apart without re-paying for the baseline.
    else if (a === '--style') out.styles.push(argv[++i]);
    else if (a === '--cwd-styles') out.cwdStyles = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// ------------------------------------------------------------------- the styles under test

/** Claude Code's built-ins, mirrored from `src/edge/output-styles.ts`. A name outside this set must be
 *  a file in `--cwd-styles`, or the run would silently measure Default against Default. */
const BUILTIN = ['Default', 'Concise', 'Proactive', 'Explanatory', 'Learning'];

/**
 * Copy `--cwd-styles` into the scratch workspace's `.claude/output-styles/` and return the names it
 * provides. This is exactly what `TerminalManager.materializeOutputStyles` does at launch, so a custom
 * style is measured through the same discovery path it will actually run through.
 */
function installCustomStyles(dir, work) {
  if (!dir) return [];
  const target = path.join(work, '.claude', 'output-styles');
  fs.mkdirSync(target, { recursive: true });
  const names = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    fs.copyFileSync(path.join(dir, f), path.join(target, f));
    names.push(f.slice(0, -3));
  }
  return names;
}

/** Refuse a name nothing will honour. The CLI accepts an unknown style, exits 0 and runs Default — so
 *  without this the benchmark spends real money comparing the control against itself and reports 0%. */
function assertStylesExist(styles, available) {
  const missing = styles.filter((s) => !available.includes(s));
  if (missing.length) {
    console.error(`error: unknown output style(s): ${missing.join(', ')}`);
    console.error(`       known: ${available.join(', ')}`);
    console.error('       (claude would accept these silently and run Default — the result would be a fake 0%)');
    process.exit(1);
  }
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
function runOne({ model, prompt, systemFile, cwd, outputStyle }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowed-tools', ...NO_TOOLS,
  ];
  // The treatment. `Default` (the control arm) sends no setting at all, which is what the launcher does
  // — naming Default is a no-op there, so naming it here would not be the same call.
  if (outputStyle && outputStyle !== 'Default') args.push('--settings', JSON.stringify({ outputStyle }));
  // The CONDITION: the company context, identical across arms. A style is not injected through this
  // channel, so unlike the brief this harness used to measure, the two are genuinely orthogonal.
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
    for (const arm of ['Default', ...treatments.map((t) => t.label)]) {
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

  const header = 'prompt'.padEnd(24) + 'Default'.padStart(8) + treatments.map((t) => t.label.padStart(10)).join('') + '   completeness';
  console.log(header);
  console.log('-'.repeat(96));

  const reductions = new Map(treatments.map((t) => [t.label, []]));
  const complete = new Map([['Default', [0, 0]], ...treatments.map((t) => [t.label, [0, 0]])]);
  const spend = new Map([['Default', 0], ...treatments.map((t) => [t.label, 0])]);

  for (const p of promptIds) {
    const n = cell(p, 'Default');
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
    for (const [label, rs] of [['Default', n], ...treatments.map((t) => [t.label, cell(p, t.label)])]) {
      const cur = complete.get(label);
      complete.set(label, [cur[0] + rs.filter((r) => r.complete).length, cur[1] + rs.length]);
      spend.set(label, spend.get(label) + rs.reduce((a, r) => a + r.costUsd, 0));
    }
    console.log(
      p.padEnd(24) + String(Math.round(nTok)).padStart(8) + cells.map((c) => String(c).padStart(10)).join('') +
      `   ${complete.get('Default') ? '' : ''}${n.filter((r) => r.complete).length}/${n.length}` +
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
    const [nOk, nTot] = complete.get('Default');
    console.log(`\n  ${t.label}`);
    console.log(`    mean reduction   ${fmtPct(mean(red)).padStart(8)}   95% CI [${fmtPct(lo)}, ${fmtPct(hi)}]`);
    console.log(`    median reduction ${fmtPct(median(red)).padStart(8)}   (prefer the median when they disagree — outliers)`);
    console.log(`    sign test        terse shorter on ${wins}/${red.length} prompts (coin flip = ${(red.length / 2).toFixed(1)})`);
    console.log(`    completeness     ${cOk}/${cTot}  (control ${nOk}/${nTot})`);
    console.log(`    spend            $${spend.get(t.label).toFixed(4)}  (control $${spend.get('Default').toFixed(4)})`);
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

  const candidates = (args.styles.length ? args.styles : ['Concise']).map((name) => ({ label: name }));

  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'output-style-prompts.json'), 'utf8'));
  let prompts = spec.prompts;
  if (args.only) prompts = prompts.filter((p) => args.only.includes(p.id));
  if (!prompts.length) {
    console.error('error: no prompts selected');
    process.exit(1);
  }

  // Scratch dir with no CLAUDE.md — a project memory file would load into EVERY arm and add thousands
  // of tokens of instructions that are not the thing under test.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-osbench-'));

  // Custom styles are discovered from the working directory, exactly as an agent discovers the ones the
  // server materialised for it. Built-ins need no file.
  const custom = installCustomStyles(args.cwdStyles, work);
  assertStylesExist(candidates.map((c) => c.label), [...BUILTIN, ...custom]);

  // The system prompt is now the CONDITION alone — the same file for every arm, because the style rides
  // `--settings`, not this channel. That is the structural difference from the appended brief this
  // harness used to measure, and it is why there is no per-arm file any more.
  const conditions = [{ name: 'minimal', systemFile: null }];
  if (args.company) {
    const company = fs.readFileSync(args.company, 'utf8').trimEnd();
    const prod = path.join(work, 'prod-company.md');
    fs.writeFileSync(prod, company);
    conditions.push({ name: 'production', systemFile: prod });
    console.log(`production condition: ${args.company}`);
    console.log(`  base system prompt ${company.length.toLocaleString()} chars (~${Math.round(company.length / 4).toLocaleString()} tokens)`);
  }

  const arms = ['Default', ...candidates.map((c) => c.label)];
  const calls = prompts.length * arms.length * conditions.length * args.reps;
  console.log(`\nmodel ${args.model} | ${prompts.length} prompts | ${arms.length} arms (${arms.join(', ')}) | ${conditions.length} condition(s) | ${args.reps} rep(s) | ${calls} calls`);
  if (custom.length) console.log(`  custom styles installed: ${custom.join(', ')}`);
  console.log();

  const rows = [];
  let done = 0, spend = 0, failures = 0;
  for (const cond of conditions) {
    for (const p of prompts) {
      for (const arm of arms) {
        for (let rep = 0; rep < args.reps; rep++) {
          const res = runOne({ model: args.model, prompt: p.prompt, systemFile: cond.systemFile, cwd: work, outputStyle: arm });
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
    console.log('DILUTION — the same style in a bare prompt vs behind the real company context');
    console.log('='.repeat(96));
    for (const m of minimal) {
      const p = production.find((x) => x.label === m.label);
      if (p) console.log(`  ${m.label.padEnd(12)} minimal ${fmtPct(m.mean).padStart(8)}   production ${fmtPct(p.mean).padStart(8)}   lost ${fmtPct(m.mean - p.mean)}`);
    }
  }

  console.log(`\ntotal spend $${spend.toFixed(4)}${failures ? ` | ${failures} call(s) failed and were dropped` : ''}`);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, JSON.stringify({ model: args.model, reps: args.reps, styles: candidates.map((c) => c.label), rows }, null, 2));
    console.log(`raw results → ${args.outFile}`);
  }
  console.log(`scratch dir (system prompts + custom styles used): ${work}`);
}

main();