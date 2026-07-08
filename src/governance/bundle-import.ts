/**
 * Import an agent from an "AOS bundle" — the standard folder format documented in
 * `web/src/docs/import-into-aos.md`. A bundle is the losslessly-portable form of an agent: its manifest
 * + instructions + skills as files (which AOS stores as files anyway), plus its memory and knowledge as
 * replayable data (which AOS stores in SQLite, so they can't just be dropped on disk).
 *
 * This module is the PURE parser: it turns an uploaded `.zip` into a validated `ParsedBundle`. It does
 * no I/O and touches no stores — the server route applies the result (writes the agent folder, installs
 * skills, replays memories + KB pages). Keeping parse/apply split means the parser is trivially testable
 * and the route owns every side effect + audit line.
 *
 * Zero-dependency: it reuses the same hand-rolled `unzip` (and skill grouping) the skill uploader uses.
 */
import { unzip, isNoise, groupSkillsFromEntries, ZipEntry, ExtractedSkill } from './skill-zip';
import { MemoryType } from '../types';

/** One replayable memory line from `memory.jsonl` (see the bundle doc's format). */
export interface BundleMemory {
  content: string;
  tags?: string[];
  importance?: number;
  shared?: boolean;
  type?: MemoryType;
  metadata?: Record<string, unknown>;
}

/** One replayable KB page from `knowledge/<section>/<slug>.md`. */
export interface BundleKnowledge {
  section: string;
  slug: string;
  title?: string;
  body: string;
}

/** A fully parsed, ready-to-apply bundle. `manifest` is the raw parsed `agent.json` (route validates it). */
export interface ParsedBundle {
  agentId: string;
  manifest: Record<string, unknown>;
  claudeMd: string;
  memories: BundleMemory[];
  skills: ExtractedSkill[];
  knowledge: BundleKnowledge[];
  /** Non-fatal issues (a bad memory line, a knowledge file with no name) — surfaced to the operator. */
  warnings: string[];
}

const AGENT_MANIFEST = 'agent.json';

/** First markdown H1 in a doc, if any — used as a KB page title when the file leads with one. */
function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
    if (line.trim()) break; // stop at the first non-blank, non-heading line
  }
  return undefined;
}

/** Lowercase-hyphen a path segment into a url-safe KB section/slug (mirrors the KB store's normSeg). */
function slugify(s: string): string {
  return s.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Parse an uploaded bundle `.zip` into a `ParsedBundle`. Throws only on a fatally malformed bundle (not a
 * zip, or no `agent.json`); recoverable problems become `warnings`. The bundle's files may sit at the
 * archive root OR under a single `<agent-id>/` wrapper folder — we locate the `agent.json` and treat its
 * directory as the bundle root, so both shapes (and a stray wrapper) work.
 */
export function parseBundle(buf: Buffer): ParsedBundle {
  const entries = unzip(buf).filter((e) => !isNoise(e.name) && e.name.length > 0);
  const warnings: string[] = [];

  // The bundle root is the directory holding agent.json (the shallowest, if a stray copy exists deeper).
  const manifestEntry = entries
    .filter((e) => e.name === AGENT_MANIFEST || e.name.endsWith('/' + AGENT_MANIFEST))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!manifestEntry) throw new Error('bundle is missing agent.json — it is not an AOS bundle');
  const root = manifestEntry.name === AGENT_MANIFEST ? '' : manifestEntry.name.slice(0, -AGENT_MANIFEST.length);

  // Everything we care about is under the root prefix; rebase each entry's name to root-relative.
  const rel = (e: ZipEntry): string | null => (e.name.startsWith(root) ? e.name.slice(root.length) : null);
  const relEntries = entries
    .map((e) => ({ rel: rel(e), data: e.data }))
    .filter((e): e is { rel: string; data: Buffer } => e.rel !== null && e.rel.length > 0);

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('bundle agent.json is not valid JSON');
  }

  const claudeMd = relEntries.find((e) => e.rel === 'CLAUDE.md')?.data.toString('utf8') ?? '';
  if (!claudeMd.trim()) warnings.push('bundle has no CLAUDE.md — the agent will have empty instructions');

  // agentId: manifest.id wins, then the wrapper folder name, then a placeholder for the operator to fix.
  const rawId = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : root.replace(/\/$/, '');
  const agentId = slugify(rawId);

  // memory.jsonl — one JSON object per line; skip (with a warning) any line that isn't valid or lacks content.
  const memories: BundleMemory[] = [];
  const jsonl = relEntries.find((e) => e.rel === 'memory.jsonl');
  if (jsonl) {
    const lines = jsonl.data.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(t) as Record<string, unknown>; }
      catch { warnings.push(`memory.jsonl line ${i + 1}: not valid JSON — skipped`); return; }
      const content = typeof obj.content === 'string' ? obj.content.trim() : '';
      if (!content) { warnings.push(`memory.jsonl line ${i + 1}: no "content" — skipped`); return; }
      memories.push({
        content,
        tags: Array.isArray(obj.tags) ? obj.tags.map(String) : undefined,
        importance: typeof obj.importance === 'number' ? obj.importance : undefined,
        shared: obj.shared === true,
        type: typeof obj.type === 'string' ? (obj.type as MemoryType) : undefined,
        metadata: obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as Record<string, unknown>) : undefined,
      });
    });
  }

  // skills/ — reuse the exact skill-grouping the uploader uses, rebased under the skills/ subtree.
  const skillEntries: ZipEntry[] = relEntries
    .filter((e) => e.rel.startsWith('skills/') && e.rel.length > 'skills/'.length)
    .map((e) => ({ name: e.rel.slice('skills/'.length), data: e.data }));
  let skills: ExtractedSkill[] = [];
  if (skillEntries.length) {
    try { skills = groupSkillsFromEntries(skillEntries); }
    catch (e) { warnings.push(`skills/ ignored: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // knowledge/<section>/<slug>.md — section = first path segment, slug = the rest joined with hyphens.
  const knowledge: BundleKnowledge[] = [];
  for (const e of relEntries) {
    if (!e.rel.startsWith('knowledge/') || !e.rel.endsWith('.md')) continue;
    const parts = e.rel.slice('knowledge/'.length).split('/').filter(Boolean);
    if (parts.length === 0) continue;
    const section = parts.length > 1 ? slugify(parts[0]) : 'general';
    const slugParts = parts.length > 1 ? parts.slice(1) : parts;
    const slug = slugify(slugParts.join('-'));
    if (!section || !slug) { warnings.push(`knowledge/${e.rel.slice('knowledge/'.length)}: no url-safe name — skipped`); continue; }
    const body = e.data.toString('utf8');
    knowledge.push({ section, slug, title: firstHeading(body), body });
  }

  return { agentId, manifest, claudeMd, memories, skills, knowledge, warnings };
}
