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
  const out = { model: 'claude-haiku-4-5', reps: 2, company: null, only: null, outFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--reps') out.reps = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--company') out.company = argv[++i];
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out.outFile = argv[++i];
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
const pct = (from, to) => (from > 0 ? ((from - to) / from) * 100 : 0);
const fmtPct = (n) => `${n >= 0 ? '' : ''}${n.toFixed(1)}%`;

/**
 * Report one condition. Paired throughout: the headline is the mean of the PER-PROMPT reductions, not
 * the reduction of the pooled means — pooling would let one long prompt dominate the result.
 */
function report(condition, rows) {
  const byPrompt = new Map();
  for (const r of rows) {
    if (!byPrompt.has(r.promptId)) byPrompt.set(r.promptId, { normal: [], terse: [] });
    byPrompt.get(r.promptId)[r.arm].push(r);
  }

  console.log(`\n${'='.repeat(96)}`);
  console.log(`CONDITION: ${condition}`);
  console.log('='.repeat(96));
  console.log(
    'prompt'.padEnd(26) + 'normal'.padStart(9) + 'terse'.padStart(9) + 'reduction'.padStart(12) +
    '  completeness (normal → terse)',
  );
  console.log('-'.repeat(96));

  const reductions = [];
  let nOk = 0, nTot = 0, tOk = 0, tTot = 0;
  let normalCost = 0, terseCost = 0;

  for (const [id, arms] of byPrompt) {
    const nTok = mean(arms.normal.map((r) => r.narrationTokens));
    const tTok = mean(arms.terse.map((r) => r.narrationTokens));
    if (!arms.normal.length || !arms.terse.length) continue;
    const red = pct(nTok, tTok);
    reductions.push(red);
    for (const r of arms.normal) { nTot++; if (r.complete) nOk++; normalCost += r.costUsd; }
    for (const r of arms.terse) { tTot++; if (r.complete) tOk++; terseCost += r.costUsd; }
    const nC = `${arms.normal.filter((r) => r.complete).length}/${arms.normal.length}`;
    const tC = `${arms.terse.filter((r) => r.complete).length}/${arms.terse.length}`;
    const flag = arms.terse.some((r) => !r.complete) && arms.normal.every((r) => r.complete) ? '  <-- terse dropped required facts' : '';
    console.log(
      id.padEnd(26) + String(Math.round(nTok)).padStart(9) + String(Math.round(tTok)).padStart(9) +
      fmtPct(red).padStart(12) + `  ${nC} → ${tC}${flag}`,
    );
  }

  console.log('-'.repeat(96));
  const headline = mean(reductions);
  const wins = reductions.filter((r) => r > 0).length;
  console.log(`mean per-prompt narration reduction : ${fmtPct(headline)}   (terse shorter on ${wins}/${reductions.length} prompts)`);
  console.log(`completeness                        : normal ${nOk}/${nTot}, terse ${tOk}/${tTot}`);
  console.log(`spend this condition                : normal $${normalCost.toFixed(4)}, terse $${terseCost.toFixed(4)}`);
  if (tTot && tOk / tTot < nOk / Math.max(1, nTot)) {
    console.log('WARNING: terse answered LESS completely than normal. A reduction bought by dropping');
    console.log('         required facts is degradation, not saving — do not quote the headline alone.');
  }
  return { condition, headline, wins, total: reductions.length, normalComplete: nOk / Math.max(1, nTot), terseComplete: tOk / Math.max(1, tTot) };
}

// ---------------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  const brief = loadBrief();
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'verbosity-prompts.json'), 'utf8'));
  let prompts = spec.prompts;
  if (args.only) prompts = prompts.filter((p) => args.only.includes(p.id));
  if (!prompts.length) {
    console.error('error: no prompts selected');
    process.exit(1);
  }

  // Scratch dir with no CLAUDE.md — a project memory file would load into BOTH arms and add thousands
  // of tokens of instructions that are not the thing under test.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vbench-'));

  // The system prompts, written once and reused so the provider can cache the prefix.
  const conditions = [];
  const minimalNormal = ''; // no --append-system-prompt-file at all: the CLI's own default, untouched
  const minimalTerse = path.join(work, 'minimal-terse.md');
  fs.writeFileSync(minimalTerse, brief);
  conditions.push({ name: 'minimal', normal: null, terse: minimalTerse });

  if (args.company) {
    const company = fs.readFileSync(args.company, 'utf8');
    // The live file already ENDS with the brief when the tenant default is terse. Strip it so the
    // control arm is genuinely untreated, then rebuild the treatment arm from the shipped text.
    const idx = company.indexOf('# Output style — terse');
    const base = (idx === -1 ? company : company.slice(0, idx)).trimEnd();
    const prodNormal = path.join(work, 'prod-normal.md');
    const prodTerse = path.join(work, 'prod-terse.md');
    fs.writeFileSync(prodNormal, base);
    fs.writeFileSync(prodTerse, `${base}\n\n${brief}`);
    conditions.push({ name: 'production', normal: prodNormal, terse: prodTerse });
    console.log(`production condition: ${args.company}`);
    console.log(`  base system prompt ${base.length.toLocaleString()} chars (~${Math.round(base.length / 4).toLocaleString()} tokens)` +
      `, brief adds ${brief.length.toLocaleString()} chars (~${Math.round(brief.length / 4).toLocaleString()} tokens)`);
  }

  const calls = prompts.length * 2 * conditions.length * args.reps;
  console.log(`\nmodel ${args.model} | ${prompts.length} prompts | ${conditions.length} condition(s) | ${args.reps} rep(s) | ${calls} calls`);
  console.log(`brief under test: ${brief.length} chars (from dist/)\n`);

  const rows = [];
  let done = 0, spend = 0, failures = 0;
  for (const cond of conditions) {
    for (const p of prompts) {
      for (const arm of ['normal', 'terse']) {
        for (let rep = 0; rep < args.reps; rep++) {
          const res = runOne({ model: args.model, prompt: p.prompt, systemFile: cond[arm], cwd: work });
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
            `  [${done}/${calls}] ${cond.name}/${p.id}/${arm} ` +
            `${String(res.narrationTokens).padStart(5)} tok${c.ok ? '' : ` INCOMPLETE (missing ${c.missing.join(', ')})`}` +
            `  $${spend.toFixed(3)}\n`,
          );
        }
      }
    }
  }

  const summaries = [];
  for (const cond of conditions) summaries.push(report(cond.name, rows.filter((r) => r.condition === cond.name)));

  if (summaries.length === 2) {
    const [min, prod] = summaries;
    console.log(`\n${'='.repeat(96)}`);
    console.log('DILUTION — what the same brief is worth in a bare prompt vs behind the real company context');
    console.log('='.repeat(96));
    console.log(`  minimal    ${fmtPct(min.headline)}`);
    console.log(`  production ${fmtPct(prod.headline)}`);
    console.log(`  the gap is what position and surrounding context cost the brief: ${fmtPct(min.headline - prod.headline)} of reduction lost.`);
  }

  console.log(`\ntotal spend $${spend.toFixed(4)}${failures ? ` | ${failures} call(s) failed and were dropped` : ''}`);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, JSON.stringify({ model: args.model, reps: args.reps, briefChars: brief.length, rows }, null, 2));
    console.log(`raw results → ${args.outFile}`);
  }
  console.log(`scratch dir (system prompts used): ${work}`);
}

main();
