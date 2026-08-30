/**
 * Output styles — the runtime knob that decides an agent's ROLE, TONE and default response SHAPE.
 *
 * Claude Code ships this as a first-class system-prompt mechanism (`outputStyle` in a settings file,
 * plus custom styles as Markdown under `.claude/output-styles/`). It replaces the home-grown
 * `verbosity` / `TERSE_OUTPUT_BRIEF` knob, which is deleted. That deletion is evidence-led, so the
 * evidence is recorded here rather than lost with the file:
 *
 *   - `TERSE_OUTPUT_BRIEF` was a compression brief APPENDED to the system prompt. Two different
 *     wordings were benchmarked head to head against a shared control (`bench:verbosity`, 504 calls,
 *     6 reps) and BOTH landed inside the noise — every bootstrap CI spanned zero, and the rewrite with
 *     the better prior trended worse. Per-call narration length has a ~20-23% coefficient of variation
 *     whatever you put in the prompt, so the runs could rule out any effect above ~10%, and did.
 *   - The multi-turn harness (`bench:verbosity-turns`, 270 turns) then found the ONE mechanism that
 *     measured: re-injecting the same instruction next to the user's message each turn, +6.8%
 *     [+0.5, +13.3]. The gain was flat across turn index — 4.2% on turn ONE — so what it bought was
 *     PROXIMITY, not decay prevention: an instruction beside the user's message outweighs the same
 *     instruction 13k tokens up. It was never wired, because it is worth ~$0.13/month fleet-wide.
 *
 * An output style is the same lever done properly, from the other side of the boundary. It is not an
 * append — Claude Code puts it in the system prompt PROPER, and (per its docs) "also reminds Claude of
 * the style during the conversation", i.e. it owns the per-turn reinforcement channel our benchmark
 * identified and we declined to build. `Concise` is Anthropic's own tested wording for what the terse
 * brief was reaching for. So the trade is: delete 660 tokens of prompt that measured as nothing, and
 * gain a mechanism that has the only property the measurement said matters.
 *
 * THE SAME DISCIPLINE STILL APPLIES. No cost claim ships without a paired benchmark
 * (`npm run bench:output-style`), and this module deliberately exposes NO savings figure — only
 * {@link outputStyleAdoption}, a count of which agents ran under which style. Narration is ~15% of an
 * agent's output tokens (the rest is `tool_use` arguments), so the ceiling on any style's effect on
 * spend is ~1%: treat a style as an ANSWER-SHAPE feature, and measure completeness if you measure
 * anything. The retired `verbositySavings()` is the cautionary tale — it divided a treatment-moved
 * numerator by a treatment-moved denominator over a cutover rather than a split, and reported terse as
 * "92% worse" on live data, which was tool-use volume.
 *
 * Five traps, all verified against claude 2.1.251 rather than assumed:
 *
 *  1. **An unknown style name is SILENTLY IGNORED** — `--settings '{"outputStyle":"NoSuchStyleXYZ"}'`
 *     runs happily on the Default style, exit 0, no warning. Unlike `--model`, nothing fails. So the
 *     name is validated at SAVE time ({@link sanitizeRuntimeTuning} against {@link OutputStylesStore.names});
 *     that is the only place a typo is ever caught.
 *  2. **A custom style DROPS Claude Code's built-in software-engineering instructions** unless its
 *     frontmatter sets `keep-coding-instructions: true`, and the default is `false`. For a governed
 *     coding agent that is a silent quality cliff, so {@link starterOutputStyle} seeds it true and
 *     {@link OutputStylesStore.save} records what each style resolved to, for the console to show.
 *  3. **claude-code only.** codex and opencode have no equivalent, hence the `outputStyle` runtime
 *     capability — probe it, never compare runtime ids. The deleted terse brief did reach both
 *     runtimes via `buildCompanyMd`; since it measured as nothing on either, nothing measurable is lost.
 *  4. **Subagents do not inherit a style** (they run their own system prompt), so a style shapes the
 *     main conversation only.
 *  5. **A plugin can seize it.** A style shipped by an enabled plugin with `force-for-plugin: true`
 *     overrides the user's `outputStyle` outright — a fresh instance of the documented "`~/.claude` is
 *     an undeclared input to every agent" hazard, and one more reason to run
 *     `AOS_CLAUDE_CONFIG_ISOLATION=1`.
 *
 * What was verified to WORK, in a fresh untrusted directory (i.e. exactly an agent folder): the style
 * arrives through the `--settings` flag we already write, a project-level `.claude/output-styles/*.md`
 * is discovered without a trust dialog, and a style COEXISTS with `--append-system-prompt-file` — so
 * the company context, persona, dreaming guidance and `UNATTENDED_TURN_BRIEF` all still land.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { atLeastVersion, claudeVersion } from './claude-cli';

/** The style every agent gets when nothing is set anywhere — Claude Code's own system prompt. */
export const DEFAULT_OUTPUT_STYLE = 'Default';

/** A style Claude Code ships itself. `minVersion` is the CLI version that introduced it — an older
 *  binary ignores the name silently (trap 1), so the console warns rather than pretending. */
export interface BuiltinOutputStyle {
  name: string;
  description: string;
  /** `[maj,min,patch]` the CLI must be at for this style to exist; absent ⇒ present in every version
   *  that has output styles at all. */
  minVersion?: readonly number[];
}

/**
 * Claude Code's built-in styles. Deliberately a static list: the CLI has no "list styles" command, and
 * a name that doesn't exist is a silent no-op, so guessing is worse than being a version behind.
 * Re-check this list against the output-styles docs whenever claude-code is upgraded — the same
 * standing instruction the gate hook's tool table carries.
 */
export const BUILTIN_OUTPUT_STYLES: readonly BuiltinOutputStyle[] = [
  { name: 'Default', description: "Claude Code's own system prompt — efficient software engineering." },
  {
    name: 'Concise',
    description: 'Leads with the result, skips preamble and narration, keeps replies short — while doing the engineering as thoroughly. Answers in full when asked to explain. Always keeps error reports, security warnings and destructive-action confirmations complete.',
    minVersion: [2, 1, 237],
  },
  {
    name: 'Proactive',
    description: 'Executes immediately and makes reasonable assumptions instead of pausing for routine decisions. Stronger autonomous-execution guidance than auto mode, and independent of permission mode — the gate still decides what runs.',
  },
  { name: 'Explanatory', description: 'Adds educational "Insights" between engineering steps. Longer replies by design.' },
  { name: 'Learning', description: 'Collaborative learn-by-doing: shares insights and leaves TODO(human) markers for you to implement. Longer replies by design.' },
];

const BUILTIN_NAMES = new Set(BUILTIN_OUTPUT_STYLES.map((s) => s.name));

/** Is `name` one of Claude Code's own styles? */
export function isBuiltinOutputStyle(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

/**
 * Why a style might not take effect on THIS box, or undefined when it will. Only ever a warning:
 * an unavailable style degrades to Default rather than failing, and boxes get upgraded — refusing to
 * save a style because today's binary is old would strand a fleet mid-rollout.
 */
export function outputStyleWarning(name: string): string | undefined {
  const b = BUILTIN_OUTPUT_STYLES.find((s) => s.name === name);
  if (!b?.minVersion) return undefined;
  const v = claudeVersion();
  if (!v || atLeastVersion(v, b.minVersion as number[])) return undefined;
  return `the "${name}" style needs Claude Code ${b.minVersion.join('.')} or later; this box has ${v.join('.')}, where it will silently fall back to Default.`;
}

/** A library style's file name is its style name — keep it a safe, DNS-ish token so it can never
 *  escape the library dir or collide with a built-in. */
export function validOutputStyleName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,48}[A-Za-z0-9]$/.test(name) && !name.includes('..');
}

/** A custom style in the workspace library. */
export interface OutputStyleSummary {
  name: string;
  /** Frontmatter `description`, shown in the picker. */
  description: string;
  /** Frontmatter `keep-coding-instructions`. False means this style REPLACES Claude Code's software
   *  engineering instructions — surfaced because it is trap 2 and invisible otherwise. */
  keepCodingInstructions: boolean;
  bytes: number;
  updatedAt: number;
}

/** A library style plus its full Markdown (for the editor). */
export interface OutputStyleDetail extends OutputStyleSummary {
  content: string;
}

/** Marker file naming the styles THIS process materialised into an agent folder, so a hand-authored
 *  style sitting beside them is never deleted (same contract as the skills library's marker). */
const MARKER = '.aos-managed';

/**
 * The workspace output-style library: `<home>/output-styles/<Name>.md`, materialised into each
 * claude-code agent's `<dir>/.claude/output-styles/` at launch, exactly like the skills library.
 *
 * Only the SELECTED style applies, so there is no per-agent allowlist here and none is needed —
 * materialising the whole library costs a few KB and makes every style selectable by any agent.
 */
export class OutputStylesStore {
  /** `<home>/output-styles` — undefined in tests/demo (no data home), where the library is empty. */
  constructor(private readonly dir?: string) {}

  /** Is a real library configured (i.e. is there a data home)? */
  get enabled(): boolean {
    return !!this.dir;
  }

  list(): OutputStyleSummary[] {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const out: OutputStyleSummary[] = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const s = this.read(entry.name.slice(0, -3));
      if (s) out.push({ name: s.name, description: s.description, keepCodingInstructions: s.keepCodingInstructions, bytes: s.bytes, updatedAt: s.updatedAt });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): OutputStyleDetail | undefined {
    return validOutputStyleName(name) ? this.read(name) : undefined;
  }

  /**
   * Every name a tuning field may legally carry: the built-ins plus whatever the library holds.
   * This is the allowlist `sanitizeRuntimeTuning` validates against — the only defence against a
   * typo that would otherwise run as Default with no signal at all.
   */
  names(): string[] {
    return [...BUILTIN_OUTPUT_STYLES.map((s) => s.name), ...this.list().map((s) => s.name)];
  }

  /** Create or overwrite a custom style. A built-in name is refused: shadowing `Concise` with a local
   *  file would make two boxes disagree about what a stored tuning value means. */
  save(name: string, content: string): OutputStyleDetail {
    if (!this.dir) throw new Error('no output-style library configured');
    if (!validOutputStyleName(name)) throw new Error(`"${name}" is not a valid output-style name`);
    if (isBuiltinOutputStyle(name)) throw new Error(`"${name}" is a built-in Claude Code style — pick another name`);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, `${name}.md`), content.endsWith('\n') ? content : `${content}\n`);
    return this.read(name)!;
  }

  remove(name: string): boolean {
    if (!this.dir || !validOutputStyleName(name)) return false;
    const file = path.join(this.dir, `${name}.md`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /**
   * Sync the library into `<claudeDir>/output-styles/` (i.e. `<agent>/.claude/output-styles/`).
   * Returns the names written. Files the agent authored itself are left alone; ones this store wrote
   * on a previous launch and that have since left the library are removed.
   */
  materialize(claudeDir: string): string[] {
    const target = path.join(claudeDir, 'output-styles');
    const library = this.list();
    const managed = this.readMarker(target);

    if (!library.length && !managed.length) return [];
    fs.mkdirSync(target, { recursive: true });

    const wanted = new Set(library.map((s) => s.name));
    for (const name of managed) {
      if (!wanted.has(name)) fs.rmSync(path.join(target, `${name}.md`), { force: true });
    }

    const done: string[] = [];
    for (const s of library) {
      const src = path.join(this.dir!, `${s.name}.md`);
      const dest = path.join(target, `${s.name}.md`);
      // An agent's own hand-authored file wins, unless we are the ones who put it there.
      if (fs.existsSync(dest) && !managed.includes(s.name)) continue;
      fs.copyFileSync(src, dest);
      done.push(s.name);
    }
    fs.writeFileSync(path.join(target, MARKER), `${done.join('\n')}\n`);
    return done;
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private read(name: string): OutputStyleDetail | undefined {
    if (!this.dir) return undefined;
    const file = path.join(this.dir, `${name}.md`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return undefined;
    }
    const content = fs.readFileSync(file, 'utf8');
    const fm = parseStyleFrontmatter(content);
    return {
      // Frontmatter `name` wins over the file name, matching Claude Code's own resolution.
      name: fm.name || name,
      description: fm.description || '',
      keepCodingInstructions: /^true$/i.test(fm['keep-coding-instructions'] || ''),
      bytes: stat.size,
      updatedAt: stat.mtimeMs,
      content,
    };
  }

  private readMarker(target: string): string[] {
    try {
      return fs
        .readFileSync(path.join(target, MARKER), 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** Flat `key: value` frontmatter, same minimal parser the skills library uses. */
export function parseStyleFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** A valid starter style. `keep-coding-instructions: true` by default — see trap 2: leaving it out
 *  silently removes Claude Code's software-engineering instructions from a coding agent. */
export function starterOutputStyle(name: string, description = ''): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description || `The ${name} output style`}`,
    'keep-coding-instructions: true',
    '---',
    '',
    `Describe how the agent should sound and shape its replies under the ${name} style.`,
    '',
    'Keep it about ROLE, TONE and RESPONSE SHAPE. Project conventions belong in the agent prompt, and a',
    'reusable procedure belongs in a skill.',
    '',
  ].join('\n');
}

/**
 * Which styles the fleet is actually running, over a trailing window. Counts only — see the note at
 * the top of this file for why no saving figure is computed here, and why the query it replaces was
 * retired rather than caveated.
 */
export interface OutputStyleAdoption {
  windowDays: number;
  /** Sessions started in the window, by resolved style. `unstamped` are rows from before the knob
   *  existed (or runs on a runtime with no output-style support) — attributable to no style. */
  sessions: { byStyle: Array<{ style: string; count: number }>; unstamped: number };
  /** Per-agent counts, busiest agent first. */
  byAgent: Array<{ agent: string; styles: Array<{ style: string; count: number }> }>;
}

export function outputStyleAdoption(db: DatabaseSync, windowDays = 30): OutputStyleAdoption {
  const since = Date.now() - windowDays * 86_400_000;
  // No tenant predicate: the DB file IS the tenant boundary, and term_sessions has no tenant column.
  const rows = db
    .prepare(
      `SELECT agent, COALESCE(output_style, '') AS style, COUNT(*) AS n
         FROM term_sessions
        WHERE created_at >= ?
        GROUP BY agent, COALESCE(output_style, '')`,
    )
    .all<{ agent: string; style: string; n: number }>(since);

  const totals = new Map<string, number>();
  const perAgent = new Map<string, Map<string, number>>();
  let unstamped = 0;
  for (const r of rows) {
    if (!r.style) {
      unstamped += r.n; // an unattributable row says nothing about adoption
      continue;
    }
    totals.set(r.style, (totals.get(r.style) ?? 0) + r.n);
    const bucket = perAgent.get(r.agent) ?? new Map<string, number>();
    bucket.set(r.style, (bucket.get(r.style) ?? 0) + r.n);
    perAgent.set(r.agent, bucket);
  }

  const rank = (m: Map<string, number>) =>
    [...m.entries()].map(([style, count]) => ({ style, count })).sort((a, b) => b.count - a.count || a.style.localeCompare(b.style));

  const byAgent = [...perAgent.entries()]
    .map(([agent, m]) => ({ agent, styles: rank(m) }))
    .sort((a, b) => {
      const sum = (x: typeof a) => x.styles.reduce((n, s) => n + s.count, 0);
      return sum(b) - sum(a) || a.agent.localeCompare(b.agent);
    });

  return { windowDays, sessions: { byStyle: rank(totals), unstamped }, byAgent };
}
