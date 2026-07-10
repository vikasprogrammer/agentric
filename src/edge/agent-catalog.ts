/**
 * The **agent library** — the catalog of ready-made agents that ships *with the software* and can be
 * installed into a workspace, the agent-side twin of the bundled skills catalog (`config/skills` →
 * `SkillsStore.catalog()`/`install()`). Entries live as plain bundle folders under `config/agents/`
 * (`paths.bundledAgents`): each is an `<id>/{agent.json,CLAUDE.md}` directory — the same on-disk shape
 * a user agent has, and the same the one-shot bundle importer produces.
 *
 * Two ways an entry reaches a running workspace, both a plain **copy of the catalog folder into the data
 * home** (`<home>/agents/<id>/`), where it becomes a normal editable agent:
 *   - **seeded** — the built-in fleet (`BUILTIN_SEED_IDS`) is copied on boot so a fresh home is useful
 *     immediately, idempotently, preserving any user edits (folder present ⇒ left alone) and restoring a
 *     deleted one on the next boot. This replaces the old code-provisioned `ensureGeneralists` /
 *     `ensureAgentAuthor` (their manifests + prompts now live as data in `config/agents/`).
 *   - **install-on-demand** — every other catalog entry is copied only when an owner/admin installs it
 *     from the console (`POST /api/agents/catalog/:id/install`).
 *
 * The library is **distribution-only**: its entries are fixed by what ships in `config/agents/`; users
 * install *from* it but cannot add to it (a one-off agent still arrives via the bundle importer). So a
 * catalog agent is trusted software — we copy its manifest as-is rather than re-sanitising it the way the
 * untrusted bundle-import path does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentOS } from '../kernel';
import type { AgentManifest } from '../types';

/** The built-in fleet: the catalog entries seeded into every home on boot (the department generalists
 *  plus the System agent-author). Everything else in `config/agents/` is install-on-demand. */
export const BUILTIN_SEED_IDS: readonly string[] = ['agent-author', 'engineer', 'support', 'marketer', 'researcher'];

/** One catalog entry as offered to the console: the manifest's display fields plus whether this workspace
 *  already has it installed and whether it's part of the always-seeded built-in fleet. */
export interface CatalogAgent {
  id: string;
  description: string;
  category?: string;
  icon?: string;
  model?: string;
  effort?: string;
  examplePrompts?: string[];
  /** True when `<home>/agents/<id>/` exists (the agent is live in this workspace). */
  installed: boolean;
  /** True for the built-in fleet (seeded on boot, restored if deleted) vs an install-on-demand entry. */
  builtin: boolean;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

/** Read one catalog folder's manifest, or undefined if it has no valid `agent.json`. */
function readCatalogManifest(catalogDir: string, id: string): AgentManifest | undefined {
  const manifestPath = path.join(catalogDir, id, 'agent.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const m = readJson<AgentManifest>(manifestPath);
    return m && typeof m.id === 'string' && m.id ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * List the agent catalog: every `<catalogDir>/<id>/agent.json`, flagged with whether it's already
 * installed in this home and whether it's a seeded built-in. Empty when no catalog dir is configured
 * (demo/tests) or the dir is absent — the catalog is software, not user data.
 */
export function readAgentCatalog(catalogDir: string | undefined, userAgentsDir: string): CatalogAgent[] {
  if (!catalogDir || !fs.existsSync(catalogDir)) return [];
  const out: CatalogAgent[] = [];
  for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readCatalogManifest(catalogDir, entry.name);
    if (!m) continue;
    out.push({
      id: m.id,
      description: m.description,
      category: m.category,
      icon: m.icon,
      model: m.model,
      effort: m.effort,
      examplePrompts: m.examplePrompts,
      installed: fs.existsSync(path.join(userAgentsDir, m.id)),
      builtin: BUILTIN_SEED_IDS.includes(m.id),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Deep-copy a catalog agent's folder into the data home and return its manifest tagged with the new
 *  (home) folder. Pure filesystem — the caller registers it live + audits. Throws if the id isn't in the
 *  catalog or a folder already exists in the home (installed already). */
export function installAgentFromCatalog(catalogDir: string | undefined, userAgentsDir: string, id: string): AgentManifest {
  if (!catalogDir) throw new Error('no agent catalog is configured');
  const manifest = readCatalogManifest(catalogDir, id);
  if (!manifest) throw new Error(`"${id}" is not in the agent library`);
  const dest = path.join(userAgentsDir, manifest.id);
  if (fs.existsSync(dest)) throw new Error(`an agent named "${manifest.id}" already exists`);
  fs.cpSync(path.join(catalogDir, id), dest, { recursive: true });
  return { ...manifest, dir: dest };
}

/**
 * Provision the built-in fleet into the data home on boot and register each live. For every seed id whose
 * home folder is absent, deep-copy it out of the catalog (`config/agents/<id>/`); a folder already present
 * (a prior boot, or one a user has edited) is left untouched. No-op in the in-memory demo/test build
 * (no data home to write into) or when the catalog is missing.
 */
export function seedBuiltinAgents(os: AgentOS): void {
  if (!os.paths) return; // demo/tests run in-memory with no agents home to write into
  const catalogDir = os.paths.bundledAgents;
  // A built-in an admin deleted is tombstoned so its removal is durable — don't restore it. Re-installing
  // it from the agent library clears the tombstone (POST /api/agents/catalog/:id/install).
  const suppressed = new Set(os.settings.suppressedBuiltins());
  for (const id of BUILTIN_SEED_IDS) {
    if (suppressed.has(id)) continue;
    const dest = path.join(os.paths.userAgents, id);
    if (fs.existsSync(dest)) {
      // Already on disk — loadAgentsFrom(userAgents) has registered it; nothing to seed.
      continue;
    }
    try {
      const manifest = installAgentFromCatalog(catalogDir, os.paths.userAgents, id);
      os.registerAgent(manifest);
    } catch (e) {
      console.error(`[agents] could not seed built-in "${id}": ${e instanceof Error ? e.message : e}`);
    }
  }
}
