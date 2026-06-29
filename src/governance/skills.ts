/**
 * Skills — a workspace-global library of Claude Code **Agent Skills** (the native `.claude/skills/`
 * format). One library per data home (`<home>/skills/<name>/SKILL.md`, + any supporting files),
 * editable from the console, **materialised into every claude-code agent at session launch** so the
 * CLI auto-discovers them — exactly like the Company context is one document injected into every agent.
 *
 * Discovery is filesystem-native: Claude Code reads `<cwd>/.claude/skills/<name>/SKILL.md` and
 * auto-selects a skill by its `description`. We run claude in the agent's own folder, so we sync the
 * global library into `<agentDir>/.claude/skills/` before launch. There's no per-invocation skills
 * flag, so this materialise step is the integration point.
 *
 * Per-agent customisation is just the filesystem: a hand-authored skill dropped in an agent's own
 * `.claude/skills/` (browsable via the console Files page) SHADOWS a same-named global one. To tell
 * the two apart we drop an `.aos-managed` marker in every skill we materialise, so a re-sync only ever
 * removes/refreshes OUR skills and never clobbers an agent's own.
 *
 * Like the gateway invariant: a skill's `allowed-tools` only suppresses claude's OWN permission
 * prompts — the PreToolUse gate hook still runs and still gates risky Bash. Skills don't widen what
 * an agent may DO; they package how it does it.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Marker file written into every skill we materialise, so a re-sync only touches our own. */
const MARKER = '.aos-managed';

/** A skill as listed in the library: its folder name + the frontmatter we surface in the UI. */
export interface SkillSummary {
  /** Folder name = the `/command-name` the CLI exposes. Lowercase, hyphenated. */
  name: string;
  /** Frontmatter `description` — what Claude matches on to auto-invoke. Empty if unset. */
  description: string;
  /** Bytes of the SKILL.md. */
  bytes: number;
  /** Last-modified epoch ms of the SKILL.md. */
  updatedAt: number;
  /** Extra files alongside SKILL.md (templates/scripts) — names only, for display. */
  files: string[];
}

/** A skill plus the full SKILL.md text (for the editor). */
export interface SkillDetail extends SkillSummary {
  content: string;
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  /** Full SKILL.md text. When omitted, a starter is composed from name + description. */
  content?: string;
}

/** id rules — the folder name is the CLI command name; keep it filesystem- and command-safe. */
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

export function validSkillName(name: string): boolean {
  return NAME_RE.test(name);
}

export class SkillsStore {
  /** `<home>/skills` — undefined in tests/demo (no data home), where the library is simply empty. */
  constructor(private readonly dir?: string) {}

  /** Is a real library configured (i.e. is there a data home)? */
  get enabled(): boolean {
    return !!this.dir;
  }

  // ── library CRUD ───────────────────────────────────────────────────────────
  list(): SkillSummary[] {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const out: SkillSummary[] = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const s = this.read(entry.name);
      if (s) out.push(summaryOf(s));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillDetail | undefined {
    if (!validSkillName(name)) return undefined;
    return this.read(name);
  }

  /** Create a new library skill. Throws on a bad name or a name that already exists. */
  create(input: CreateSkillInput): SkillDetail {
    if (!this.dir) throw new Error('a data home is required to create skills');
    const name = input.name.trim().toLowerCase();
    if (!validSkillName(name)) throw new Error('name must be lowercase letters, digits and hyphens (2–40 chars, starting with a letter)');
    const folder = path.join(this.dir, name);
    if (fs.existsSync(folder)) throw new Error(`a skill named "${name}" already exists`);
    const content = (input.content && input.content.trim())
      ? input.content
      : starterSkill(name, (input.description || '').trim());
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), content);
    return this.read(name)!;
  }

  /** Overwrite an existing skill's SKILL.md. Returns the updated detail, or undefined if unknown. */
  save(name: string, content: string): SkillDetail | undefined {
    if (!this.dir || !validSkillName(name)) return undefined;
    const file = path.join(this.dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) return undefined;
    fs.writeFileSync(file, content);
    return this.read(name);
  }

  /** Delete a library skill (its whole folder). Returns true if one was removed. */
  remove(name: string): boolean {
    if (!this.dir || !validSkillName(name)) return false;
    const folder = path.join(this.dir, name);
    if (!fs.existsSync(folder)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    return true;
  }

  // ── materialise into an agent at launch ──────────────────────────────────────
  /**
   * Sync the global library into `<claudeDir>/skills/` (claudeDir is the agent's `.claude`). Removes
   * any skill WE previously materialised (marked) that's no longer in the library, (re)writes every
   * current global skill, and never touches a skill the agent authored itself (no marker). A
   * hand-authored skill SHADOWS a same-named global one. Returns the names actually materialised.
   */
  materialize(claudeDir: string): string[] {
    if (!this.dir) return [];
    const target = path.join(claudeDir, 'skills');
    const managed = new Set<string>(); // names we own in the target right now
    const handAuthored = new Set<string>(); // agent's own — leave alone, they shadow globals
    if (fs.existsSync(target)) {
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (fs.existsSync(path.join(target, e.name, MARKER))) managed.add(e.name);
        else handAuthored.add(e.name);
      }
    }

    const library = this.list();
    const wanted = new Set(library.map((s) => s.name));

    // Drop managed skills that have left the library (or are now shadowed by a hand-authored one).
    for (const name of managed) {
      if (!wanted.has(name) || handAuthored.has(name)) {
        fs.rmSync(path.join(target, name), { recursive: true, force: true });
      }
    }

    const done: string[] = [];
    for (const s of library) {
      if (handAuthored.has(s.name)) continue; // agent's own copy wins
      this.copySkill(s.name, path.join(target, s.name));
      done.push(s.name);
    }
    return done;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private read(name: string): SkillDetail | undefined {
    if (!this.dir) return undefined;
    const folder = path.join(this.dir, name);
    const file = path.join(folder, 'SKILL.md');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const content = fs.readFileSync(file, 'utf8');
    const fm = parseFrontmatter(content);
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((e) => !(e.isFile() && e.name === 'SKILL.md') && e.name !== MARKER)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    return {
      name,
      description: fm.description ?? '',
      bytes: stat.size,
      updatedAt: stat.mtimeMs,
      files,
      content,
    };
  }

  /** Copy a library skill's whole folder into `dest`, then stamp the managed marker. */
  private copySkill(name: string, dest: string): void {
    const src = path.join(this.dir!, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARKER), '');
  }
}

function summaryOf(s: SkillDetail): SkillSummary {
  const { content: _content, ...rest } = s;
  return rest;
}

/**
 * Parse the leading YAML-ish frontmatter of a SKILL.md. We only need flat `key: value` pairs
 * (name, description) — no nesting — so a tiny line parser keeps the zero-dependency stance.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return out;
  const block = text.slice(text.indexOf('\n') + 1, end);
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** A minimal, valid SKILL.md to seed a new skill (the user edits it from there). */
function starterSkill(name: string, description: string): string {
  const desc = description || 'What this skill does and when Claude should use it.';
  return `---
name: ${name}
description: ${desc}
---

# ${name}

Use this skill when ${desc.charAt(0).toLowerCase() + desc.slice(1)}

## Steps
1. …
2. …

## Notes
- Keep instructions concrete and self-contained.
`;
}
