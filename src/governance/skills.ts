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
import { Db } from '../state/db';

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
  /**
   * Agent ids this skill is scoped to (the `skill_assignments` join table). EMPTY = every agent
   * (the default & today's behavior); non-empty = only these agents get it materialised at launch.
   */
  agents: string[];
}

/** A skill plus the full SKILL.md text (for the editor). */
export interface SkillDetail extends SkillSummary {
  content: string;
}

/**
 * A skill in the BUNDLED catalog (the software's `config/skills`), as offered for install. Mirrors
 * `SkillSummary` minus the per-agent `agents` audience (catalog skills have no assignments — that's a
 * property of an installed skill), plus `installed`: whether the tenant's library already has it.
 */
export interface CatalogSkill {
  name: string;
  description: string;
  bytes: number;
  /** Extra files alongside SKILL.md (templates/scripts) — names only, for display. */
  files: string[];
  /** True when the tenant's library already contains a skill of this name. */
  installed: boolean;
  /**
   * `default: true` in the catalog SKILL.md frontmatter — a fleet-wide DEFAULT skill. These
   * materialise into every agent automatically (no per-tenant install), unless a library or
   * hand-authored skill of the same name shadows them. See `materialize`.
   */
  isDefault: boolean;
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
  /**
   * `<home>/skills` — undefined in tests/demo (no data home), where the library is simply empty.
   * `db` backs the per-agent assignment join table (`skill_assignments`); when absent (no db), every
   * skill is treated as "all agents" — the assignment feature is simply inert.
   * `catalogDir` = the SOFTWARE's bundled skill catalog (`config/skills`), read-only and shared across
   * tenants; a tenant `install`s a catalog skill into its own `dir`. Undefined ⇒ empty catalog.
   */
  constructor(
    private readonly dir?: string,
    private readonly db?: Db,
    private readonly catalogDir?: string,
  ) {}

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
    this.db?.prepare('DELETE FROM skill_assignments WHERE skill = ?').run(name); // drop orphan assignment rows
    return true;
  }

  // ── bundled catalog (the software's config/skills) → install into the library ─
  /**
   * The bundled skill catalog: every skill that ships with the software, each flagged with whether
   * the tenant's library already has it. Empty when no catalog dir is configured (tests/demo) or the
   * dir is absent. Read-only — the catalog is software, not user data.
   */
  catalog(): CatalogSkill[] {
    if (!this.catalogDir || !fs.existsSync(this.catalogDir)) return [];
    const installed = new Set(this.list().map((s) => s.name));
    const out: CatalogSkill[] = [];
    for (const entry of fs.readdirSync(this.catalogDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
      const c = this.readCatalog(entry.name);
      if (c) out.push({ ...c, installed: installed.has(entry.name) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Install a bundled catalog skill into the tenant's library (a deep copy of its folder, minus any
   * `node_modules`/marker). Throws on a bad/unknown name or if the library already has it. The fresh
   * copy reaches agents on their next session via `materialize`. Returns the installed detail.
   */
  install(name: string): SkillDetail {
    if (!this.dir) throw new Error('a data home is required to install skills');
    if (!this.catalogDir) throw new Error('no skill catalog is configured');
    if (!validSkillName(name)) throw new Error('invalid skill name');
    const src = path.join(this.catalogDir, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`"${name}" is not in the skill catalog`);
    const dest = path.join(this.dir, name);
    if (fs.existsSync(dest)) throw new Error(`a skill named "${name}" already exists`);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (s) => path.basename(s) !== 'node_modules' && path.basename(s) !== MARKER,
    });
    return this.read(name)!;
  }

  /**
   * Install a skill from an in-memory set of files (used by the remote-repo installer in
   * `skill-registry.ts`). `files` are paths relative to the skill folder; one must be `SKILL.md`.
   * Throws on a bad/duplicate name or a missing/escaping path. Returns the installed detail.
   */
  installFiles(name: string, files: { rel: string; data: Buffer }[]): SkillDetail {
    if (!this.dir) throw new Error('a data home is required to install skills');
    name = name.trim().toLowerCase();
    if (!validSkillName(name)) throw new Error('invalid skill name');
    if (!files.some((f) => f.rel === 'SKILL.md')) throw new Error('the skill is missing a SKILL.md');
    const dest = path.join(this.dir, name);
    if (fs.existsSync(dest)) throw new Error(`a skill named "${name}" already exists`);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) {
      // Defend against path traversal: every file must resolve inside dest.
      const target = path.resolve(dest, f.rel);
      if (target !== dest && !target.startsWith(dest + path.sep)) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw new Error(`unsafe path in skill: ${f.rel}`);
      }
      if (path.basename(f.rel) === MARKER) continue; // never import a managed marker
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    return this.read(name)!;
  }

  // ── materialise into an agent at launch ──────────────────────────────────────
  /**
   * Sync the global library into `<claudeDir>/skills/` (claudeDir is the agent's `.claude`). Removes
   * any skill WE previously materialised (marked) that's no longer in the library, (re)writes every
   * current global skill, and never touches a skill the agent authored itself (no marker). A
   * hand-authored skill SHADOWS a same-named global one. Returns the names actually materialised.
   *
   * When `agent` is given, only skills scoped to it (empty assignment ⇒ all agents, or its id is in
   * the list) are materialised — and a skill that was previously synced but is no longer assigned to
   * this agent is pruned by the same managed-skill cleanup below. When `agent` is undefined, every
   * library skill is synced (back-compat for non-agent callers).
   */
  materialize(claudeDir: string, agent?: string): string[] {
    if (!this.dir && !this.catalogDir) return [];
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

    // Only skills targeting this agent (empty audience ⇒ all agents). Undefined agent ⇒ keep all.
    const library = this.list().filter(
      (s) => agent === undefined || s.agents.length === 0 || s.agents.includes(agent),
    );
    const libNames = new Set(library.map((s) => s.name));

    // Fleet-wide DEFAULT catalog skills (`default: true`) materialise into EVERY agent with no
    // per-tenant install — always on. A library skill of the same name (the tenant installed/edited
    // its own copy) shadows the default, so we skip those. Hand-authored copies win over both below.
    const defaults = this.defaultSkillNames().filter((n) => !libNames.has(n));
    const wanted = new Set<string>([...libNames, ...defaults]);

    // Drop managed skills that have left the library/defaults (or are now shadowed by hand-authored).
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
    for (const name of defaults) {
      if (handAuthored.has(name)) continue; // agent's own copy wins
      this.copyFrom(this.catalogDir!, name, path.join(target, name));
      done.push(name);
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
      agents: this.assignmentsFor(name),
      content,
    };
  }

  /** Read a catalog skill's frontmatter + file list from the bundled catalog dir. */
  private readCatalog(name: string): Omit<CatalogSkill, 'installed'> | undefined {
    if (!this.catalogDir) return undefined;
    const folder = path.join(this.catalogDir, name);
    const file = path.join(folder, 'SKILL.md');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const files = fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((e) => !(e.isFile() && e.name === 'SKILL.md') && e.name !== MARKER && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    return { name, description: fm.description ?? '', bytes: stat.size, files, isDefault: fm.default === 'true' };
  }

  /** Names of the fleet-wide DEFAULT catalog skills (`default: true`) — always materialised. */
  private defaultSkillNames(): string[] {
    if (!this.catalogDir || !fs.existsSync(this.catalogDir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(this.catalogDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
      const c = this.readCatalog(entry.name);
      if (c?.isDefault) out.push(entry.name);
    }
    return out;
  }

  // ── per-agent assignment (skill_assignments join table) ──────────────────────
  /** Agent ids this skill is scoped to. Empty ⇒ all agents (no rows / no db). */
  assignmentsFor(name: string): string[] {
    if (!this.db) return [];
    return this.db
      .prepare('SELECT agent FROM skill_assignments WHERE skill = ? ORDER BY agent')
      .all<{ agent: string }>(name)
      .map((r) => r.agent);
  }

  /** Set the skill's audience. An empty list clears all rows ⇒ "all agents". No-op without a db. */
  setAssignment(name: string, agents: string[]): void {
    if (!this.db || !validSkillName(name)) return;
    const ids = [...new Set(agents.map((a) => a.trim()).filter(Boolean))];
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM skill_assignments WHERE skill = ?').run(name);
      const ins = this.db.prepare('INSERT OR IGNORE INTO skill_assignments (skill, agent) VALUES (?, ?)');
      for (const agent of ids) ins.run(name, agent);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Copy a library skill's whole folder into `dest`, then stamp the managed marker. */
  private copySkill(name: string, dest: string): void {
    const src = path.join(this.dir!, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, MARKER), '');
  }

  /**
   * Copy a skill folder from an arbitrary source dir (the bundled catalog) into `dest`, skipping
   * `node_modules` and any stale marker, then stamp our managed marker. Used for the always-on
   * DEFAULT catalog skills — the per-agent copy is refreshed from the software on every launch, so a
   * skill's own first-run step reinstalls deps as needed (as `design-review` already does).
   */
  private copyFrom(srcDir: string, name: string, dest: string): void {
    const src = path.join(srcDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, {
      recursive: true,
      filter: (s) => path.basename(s) !== 'node_modules' && path.basename(s) !== MARKER,
    });
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
