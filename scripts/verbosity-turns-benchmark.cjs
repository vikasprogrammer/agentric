#!/usr/bin/env node
/**
 * verbosity-turns-benchmark — does PER-TURN REINFORCEMENT make the terse brief land?
 *
 * The question, and why the other benchmark cannot answer it
 * ---------------------------------------------------------
 * `scripts/verbosity-benchmark.cjs` established that `TERSE_OUTPUT_BRIEF` is indistinguishable from no
 * brief at all (504 calls, sonnet, 6 reps: every 95% CI spanning zero), and that a rewrite with a much
 * better prior — concrete delete-lists, a worked example, 63% of words instructing brevity — did not
 * beat it either. Two very different texts both landed inside the noise, which stops being a wording
 * problem and starts being a MECHANISM problem.
 *
 * That benchmark is single-turn, so it structurally cannot test the mechanism. The hypothesis here is
 * about attention decay: an appended system prompt is read once, at the top of a conversation, and its
 * pull weakens as turns accumulate and other instructions arrive. If that is true, a single-turn
 * measurement is exactly the case where the system prompt should look BEST, and a multi-turn one is
 * where the difference shows.
 *
 * The `caveman` project reached the same conclusion from live use and says so in its own source:
 * "the SessionStart hook injects the full ruleset once, but models lose it when other plugins inject
 * competing style instructions every turn". Its fix is a `UserPromptSubmit` hook that re-emits a
 * compressed reminder as `additionalContext` on every user message. Verified here before building
 * this: the hook fires in `claude -p`, it fires again on every `--resume` turn, and `additionalContext`
 * reaches the model (a test reminder overrode the question outright).
 *
 * Design
 * ------
 *  - **Conversations, not prompts.** Five threads of six turns each, tool-free, mixing registers
 *    (debugging, review, incident, planning, teaching) because narration habits differ by register.
 *    A turn is one `claude -p --resume`, so each arm walks the same thread through the same turns.
 *  - **Three arms, one shared control.** `control` (no brief), `system` (the brief appended to the
 *    system prompt — today's production mechanism), `reinforced` (the same appended brief PLUS a
 *    short reminder injected every turn through a `UserPromptSubmit` hook). `reinforced` minus
 *    `system` is the mechanism's contribution; `system` minus `control` re-tests the finding on
 *    multi-turn data.
 *  - **The real system prompt.** `--company <file>` prepends a live `session-*.company.md` (~13k
 *    tokens), because the decay hypothesis is about a brief buried at the end of a long prompt. Any
 *    trailing terse brief in that file is stripped so `control` is genuinely untreated.
 *  - **The trend is the point.** Narration tokens are reported per turn INDEX, so decay is visible
 *    rather than averaged away. If `system` degrades across turns and `reinforced` holds flat, that
 *    is the finding — and it would be invisible in the per-conversation mean.
 *  - **Same guards as the single-turn harness.** Provider-reported narration tokens
 *    (`output_tokens - thinking_tokens`), a `mustMention` completeness guard per turn, a noise floor
 *    as a coefficient of variation, bootstrap CIs, and a verdict that refuses to call a winner when
 *    the interval spans zero. Those exist because earlier runs of the sibling benchmark were read as
 *    findings when the control arm alone drifted 21-28% between runs.
 *
 * Usage
 * -----
 *   npm run build
 *   node scripts/verbosity-turns-benchmark.cjs --model claude-sonnet-5 --reps 3 \
 *        --company ~/agent-os-data/<tenant>/connectors/session-<id>.company.md
 *
 *   --model <id>      model to benchmark (default claude-haiku-4-5)
 *   --reps <n>        repetitions of every conversation, per arm (default 2)
 *   --company <file>  prepend this real system prompt to every arm (recommended — it is the condition
 *                     the hypothesis is about)
 *   --only <ids>      comma-separated conversation ids, for a smoke run
 *   --out <file>      write the raw per-turn results as JSON
 *
 * Spends real tokens: calls = conversations x turns x arms x reps, and later turns carry the whole
 * thread. It prints the plan and the running cost.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------- the reminder

/**
 * What the hook re-emits every turn. Deliberately SHORT — a full re-injection of the 555-660 token
 * brief on every turn would cost more than any narration it could save, and caveman's equivalent is
 * ~30 words for the same reason. It restates only the instruction half; the carve-outs stay in the
 * system prompt, where they do not need repeating (they say what NOT to do, and forgetting them fails
 * safe — the model writes ordinary prose, which is the default anyway).
 */
const TURN_REMINDER =
  'TERSE MODE ACTIVE. Say the finding, not the journey. No preamble, no restating the question, no ' +
  'recap of what the tool output already shows, no closing summary. Code, errors and numbers verbatim; ' +
  'ordinary prose in reports and messages to people.';

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
    // Re-report a finished run without re-running it. A 270-turn run costs ~$19 and an hour, and the
    // first one nearly went to waste when the scratchpad holding its results was cleaned — recovering
    // it meant reconstructing arms from claude's own transcripts. Results should outlive their run.
    else if (a === '--analyze') out.analyze = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadBrief() {
  const distPath = path.join(ROOT, 'dist', 'edge', 'verbosity.js');
  if (!fs.existsSync(distPath)) {
    console.error('error: dist/edge/verbosity.js not found — run `npm run build` first.');
    process.exit(1);
  }
  const { TERSE_OUTPUT_BRIEF } = require(distPath);
  if (!TERSE_OUTPUT_BRIEF) {
    console.error('error: dist/edge/verbosity.js exports no TERSE_OUTPUT_BRIEF.');
    process.exit(1);
  }
  return TERSE_OUTPUT_BRIEF;
}

// ---------------------------------------------------------------------------- one turn

const NO_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'Agent', 'SlashCommand',
];

/**
 * One turn. `sessionId` pins the conversation on the first turn and `resume` continues it, so all six
 * turns of an arm share one transcript — which is the only way the decay under test can accumulate.
 * `settingsFile` is what carries the per-turn hook (null for the arms without reinforcement).
 * stdin is closed explicitly: `claude -p` waits ~3s for piped input otherwise, which across hundreds
 * of turns is pure wall-clock.
 */
function runTurn({ model, prompt, systemFile, settingsFile, sessionId, resume, cwd }) {
  const args = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disallowed-tools', ...NO_TOOLS,
  ];
  if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  if (systemFile) args.push('--append-system-prompt-file', systemFile);
  if (settingsFile) args.push('--settings', settingsFile);

  let raw;
  try {
    raw = execFileSync('claude', args, {
      cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { error: (e && e.message ? String(e.message) : 'spawn failed').slice(0, 160) };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: 'unparseable JSON from claude -p' };
  }
  if (json.is_error) return { error: String(json.result || 'is_error').slice(0, 160) };
  const u = json.usage || {};
  const outputTokens = u.output_tokens || 0;
  const thinking = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
  const text = String(json.result || '');
  return {
    narrationTokens: Math.max(0, outputTokens - thinking),
    outputTokens,
    thinkingTokens: thinking,
    costUsd: json.total_cost_usd || 0,
    chars: text.length,
    text,
  };
}

function complete(text, mustMention) {
  const hay = text.toLowerCase();
  const missing = (mustMention || []).filter((m) => !hay.includes(String(m).toLowerCase()));
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------- stats

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (from, to) => (from > 0 ? ((from - to) / from) * 100 : 0);
const fmtPct = (n) => (Number.isFinite(n) ? `${n.toFixed(1)}%` : 'n/a');

/** Seeded so two readings of the same results file agree. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

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

/** Least-squares slope of narration tokens against turn index — the decay the hypothesis predicts. */
function slope(points) {
  if (points.length < 2) return NaN;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : NaN;
}

// ---------------------------------------------------------------------------- report

const ARMS = ['control', 'system', 'reinforced'];

function report(rows) {
  const turnIdx = [...new Set(rows.map((r) => r.turn))].sort((a, b) => a - b);
  const convIds = [...new Set(rows.map((r) => r.conversation))];
  const at = (arm, filter = () => true) => rows.filter((r) => r.arm === arm && filter(r));

  // Noise floor from this run's own data: CV within a cell (same conversation, same turn, same arm).
  // A coefficient of variation, not a range — range grows with rep count, so a range-based floor
  // implies more data makes the noise worse.
  const cvs = [];
  for (const c of convIds) {
    for (const t of turnIdx) {
      for (const arm of ARMS) {
        const v = at(arm, (r) => r.conversation === c && r.turn === t).map((r) => r.narrationTokens);
        if (v.length < 2) continue;
        const m = mean(v);
        if (!m) continue;
        cvs.push((Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)) / m) * 100);
      }
    }
  }

  console.log(`\n${'='.repeat(100)}`);
  console.log('NARRATION TOKENS BY TURN INDEX — the decay the hypothesis predicts');
  console.log('='.repeat(100));
  console.log(`noise floor (within-cell CV): ${fmtPct(mean(cvs))} — nothing below this is a finding\n`);
  console.log('turn'.padEnd(8) + ARMS.map((a) => a.padStart(13)).join('') + '     system vs ctl   reinf vs system');
  console.log('-'.repeat(100));
  for (const t of turnIdx) {
    const m = {};
    for (const arm of ARMS) m[arm] = mean(at(arm, (r) => r.turn === t).map((r) => r.narrationTokens));
    console.log(
      `${t + 1}`.padEnd(8) + ARMS.map((a) => String(Math.round(m[a])).padStart(13)).join('') +
      `${fmtPct(pct(m.control, m.system)).padStart(17)}${fmtPct(pct(m.system, m.reinforced)).padStart(18)}`,
    );
  }
  console.log('-'.repeat(100));
  for (const arm of ARMS) {
    const pts = turnIdx.map((t) => ({ x: t, y: mean(at(arm, (r) => r.turn === t).map((r) => r.narrationTokens)) }));
    console.log(`  ${arm.padEnd(12)} slope ${slope(pts) >= 0 ? '+' : ''}${slope(pts).toFixed(1)} tokens/turn` +
      `   (positive = growing more verbose as the thread lengthens)`);
  }

  // Paired comparisons. The pairing unit is (conversation, turn) — 30 pairs at 5 conversations x 6
  // turns, which is the n the CI is computed over.
  console.log(`\n${'='.repeat(100)}`);
  console.log('PAIRED COMPARISONS — unit is (conversation, turn)');
  console.log('='.repeat(100));
  const summaries = [];
  for (const [label, base, treat] of [
    ['system vs control        (does the appended brief work at all, multi-turn?)', 'control', 'system'],
    ['reinforced vs system     (what per-turn reinforcement ADDS)', 'system', 'reinforced'],
    ['reinforced vs control    (the whole mechanism, end to end)', 'control', 'reinforced'],
  ]) {
    const reductions = [];
    for (const c of convIds) {
      for (const t of turnIdx) {
        const b = mean(at(base, (r) => r.conversation === c && r.turn === t).map((r) => r.narrationTokens));
        const x = mean(at(treat, (r) => r.conversation === c && r.turn === t).map((r) => r.narrationTokens));
        if (b > 0 && x > 0) reductions.push(pct(b, x));
      }
    }
    if (!reductions.length) continue;
    const [lo, hi] = bootstrapCI(reductions);
    const wins = reductions.filter((r) => r > 0).length;
    const resolvable = Number.isFinite(lo) && (lo > 0 || hi < 0);
    const comp = (arm) => {
      const rs = at(arm);
      return `${rs.filter((r) => r.complete).length}/${rs.length}`;
    };
    console.log(`\n  ${label}`);
    console.log(`    mean reduction   ${fmtPct(mean(reductions)).padStart(8)}   95% CI [${fmtPct(lo)}, ${fmtPct(hi)}]`);
    console.log(`    median reduction ${fmtPct(median(reductions)).padStart(8)}`);
    console.log(`    sign test        shorter on ${wins}/${reductions.length} (conversation, turn) pairs (coin flip = ${(reductions.length / 2).toFixed(1)})`);
    console.log(`    completeness     ${treat} ${comp(treat)}  vs  ${base} ${comp(base)}`);
    console.log(
      resolvable
        ? `    VERDICT: CI excludes zero — real effect, direction ${mean(reductions) > 0 ? 'SHORTER' : 'LONGER'}.`
        : '    VERDICT: CI SPANS ZERO — this run cannot tell them apart. Do not ship on it.',
    );
    summaries.push({ label, mean: mean(reductions), ci: [lo, hi], resolvable });
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

  // Re-report a saved run and stop — no spend, no claude calls.
  if (args.analyze) {
    const saved = JSON.parse(fs.readFileSync(args.analyze, 'utf8'));
    console.log(`re-analyzing ${args.analyze} — ${saved.rows.length} turns, model ${saved.model}, ${saved.reps} rep(s)`);
    report(saved.rows);
    return;
  }

  const brief = loadBrief();
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'verbosity-conversations.json'), 'utf8'));
  let convs = spec.conversations;
  if (args.only) convs = convs.filter((c) => args.only.includes(c.id));
  if (!convs.length) {
    console.error('error: no conversations selected');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-turnbench-'));

  // Base system prompt shared by every arm. Any trailing terse brief in a live company.md is stripped
  // so `control` is genuinely untreated and `system` gets exactly the text under test.
  let base = '';
  if (args.company) {
    const company = fs.readFileSync(args.company, 'utf8');
    const idx = company.indexOf('# Output style — terse');
    base = (idx === -1 ? company : company.slice(0, idx)).trimEnd();
    console.log(`base system prompt: ${args.company}`);
    console.log(`  ${base.length.toLocaleString()} chars (~${Math.round(base.length / 4).toLocaleString()} tokens)`);
  }

  const controlFile = base ? path.join(work, 'control.md') : null;
  if (controlFile) fs.writeFileSync(controlFile, base);
  const briefFile = path.join(work, 'brief.md');
  fs.writeFileSync(briefFile, base ? `${base}\n\n${brief}` : brief);

  // The reinforcement arm's hook. A tiny node script writing the UserPromptSubmit `additionalContext`
  // envelope — the same shape caveman's mode-tracker emits, and the only channel that reaches the
  // model mid-conversation.
  const hookFile = path.join(work, 'turn-hook.js');
  fs.writeFileSync(
    hookFile,
    'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",' +
      `additionalContext:${JSON.stringify(TURN_REMINDER)}}}));\n`,
  );
  const settingsFile = path.join(work, 'reinforced-settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${hookFile}`, timeout: 10 }] }] },
    }),
  );

  const armSpec = {
    control: { systemFile: controlFile, settingsFile: null },
    system: { systemFile: briefFile, settingsFile: null },
    reinforced: { systemFile: briefFile, settingsFile },
  };

  const turns = Math.max(...convs.map((c) => c.turns.length));
  const calls = convs.reduce((a, c) => a + c.turns.length, 0) * ARMS.length * args.reps;
  console.log(`\nmodel ${args.model} | ${convs.length} conversations | up to ${turns} turns | ${ARMS.length} arms | ${args.reps} rep(s) | ${calls} calls`);
  console.log(`brief ${brief.length} chars (~${Math.round(brief.length / 4)} tok) | per-turn reminder ${TURN_REMINDER.length} chars (~${Math.round(TURN_REMINDER.length / 4)} tok)\n`);

  const rows = [];
  let done = 0, spend = 0, failures = 0;
  for (const conv of convs) {
    for (const arm of ARMS) {
      for (let rep = 0; rep < args.reps; rep++) {
        // One transcript per (conversation, arm, rep) — the turns must accumulate in it for the decay
        // under test to exist at all. A UUID because `--session-id` requires one.
        const sessionId = crypto.randomUUID();
        for (let t = 0; t < conv.turns.length; t++) {
          const turn = conv.turns[t];
          const res = runTurn({
            model: args.model, prompt: turn.prompt,
            systemFile: armSpec[arm].systemFile, settingsFile: armSpec[arm].settingsFile,
            sessionId, resume: t > 0, cwd: work,
          });
          done++;
          if (res.error) {
            failures++;
            process.stdout.write(`  [${done}/${calls}] ${conv.id}/${arm}/r${rep}/t${t + 1} FAILED: ${res.error}\n`);
            // A broken turn breaks the thread — abandon this transcript rather than measure turns whose
            // history has a hole in it.
            break;
          }
          const c = complete(res.text, turn.mustMention);
          spend += res.costUsd;
          rows.push({
            conversation: conv.id, category: conv.category, arm, rep, turn: t,
            narrationTokens: res.narrationTokens, outputTokens: res.outputTokens,
            thinkingTokens: res.thinkingTokens, costUsd: res.costUsd, chars: res.chars,
            complete: c.ok, missing: c.missing, text: res.text,
          });
          process.stdout.write(
            `  [${done}/${calls}] ${conv.id}/${arm}/r${rep}/t${t + 1} ${String(res.narrationTokens).padStart(5)} tok` +
            `${c.ok ? '' : ` INCOMPLETE (${c.missing.join(', ')})`}  $${spend.toFixed(3)}\n`,
          );
        }
      }
    }
  }

  report(rows);
  console.log(`\ntotal spend $${spend.toFixed(4)}${failures ? ` | ${failures} turn(s) failed` : ''}`);
  if (args.outFile) {
    fs.writeFileSync(args.outFile, JSON.stringify({ model: args.model, reps: args.reps, reminder: TURN_REMINDER, briefChars: brief.length, rows }, null, 2));
    console.log(`raw results → ${args.outFile}`);
  }
  console.log(`scratch dir: ${work}`);
}

main();
