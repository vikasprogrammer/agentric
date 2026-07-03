/**
 * Remote skill sources — install Claude Code Skills straight from a public GitHub repo, the de-facto
 * distribution channel for skills (a repo with `skills/<name>/SKILL.md` folders). This is also the
 * skills.sh integration: skills.sh is a directory of GitHub repos and `npx skills add owner/repo`
 * just copies that repo's skills — so "install from owner/repo" covers every skills.sh entry too.
 *
 * Zero-dependency: the Git **trees API** lists a whole repo in ONE unauthenticated call (60/hr/IP;
 * raise it with `GITHUB_TOKEN`), and file bytes come from `raw.githubusercontent.com`, which isn't
 * bound by that API budget. We detect a skill as ANY directory containing a `SKILL.md` (so it works
 * whether they live under `skills/`, `.claude/skills/`, or the repo root), exactly like the CLI.
 *
 * A remotely-installed skill is governed identically to a hand-authored one: it's just files in the
 * tenant's library, materialised into agents at launch, and every effect it drives still passes the
 * PreToolUse gate hook. Install is owner/admin-only. We cap file count/size so a hostile repo can't
 * balloon a tenant's home.
 */
import { parseFrontmatter, validSkillName } from './skills';

/** A featured one-click source shown in the console. The marketing set + a skills.sh starter. */
export const PRESET_SOURCES: { repo: string; label: string; description: string }[] = [
  {
    repo: 'coreyhaines31/marketingskills',
    label: 'Marketing Skills',
    description: '45 marketing playbooks — SEO, CRO, copywriting, ads, lifecycle & growth (Corey Haines, MIT, ⭐36k).',
  },
  {
    repo: 'OpenClaudia/openclaudia-skills',
    label: 'OpenClaudia Marketing',
    description: '67 open marketing skills — SEO, content, email, ads, analytics, growth (MIT).',
  },
  {
    repo: 'AgriciDaniel/claude-seo',
    label: 'Claude SEO',
    description: '31 deep-SEO skills — technical, E-E-A-T, schema, GEO/AEO, local & intl (MIT, ⭐10k).',
  },
  {
    repo: 'rampstackco/claude-skills',
    label: 'Rampstack Lifecycle',
    description: '103 website-lifecycle skills — brand, design, content, SEO, dev, ops, growth (MIT).',
  },
  {
    repo: 'alirezarezvani/claude-skills',
    label: 'Claude Skills (420)',
    description: 'Broad library — engineering, marketing, product, compliance, finance & ops (MIT, ⭐19k).',
  },
  {
    repo: 'anthropics/skills',
    label: 'Anthropic Official',
    description: 'Official Anthropic skills — docx/pdf/pptx/xlsx, artifacts & frontend design (⭐157k).',
  },
  {
    repo: 'mattpocock/skills',
    label: 'Matt Pocock · Engineering',
    description: 'Engineering craft — TDD, refactoring, debugging & architecture (MIT, ⭐151k).',
  },
];

/** One skills.sh search hit — a skill in some repo, with its install count and source `owner/repo`. */
export interface SkillshHit {
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

/**
 * Search the skills.sh directory across ALL indexed repos. Returns the raw hits (the install route
 * resolves a hit's folder path by name at install time). skills.sh exposes `/api/search?q=` as JSON;
 * an empty query yields nothing, so callers must pass a term.
 */
export async function searchSkillsh(query: string): Promise<SkillshHit[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch('https://skills.sh/api/search?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'agent-os', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`skills.sh search failed (${res.status})`);
  const j: any = await res.json();
  const out: SkillshHit[] = [];
  for (const s of j.skills || []) {
    if (!s.source || !s.skillId) continue;
    out.push({ skillId: String(s.skillId), name: String(s.name || s.skillId), installs: Number(s.installs) || 0, source: String(s.source) });
  }
  return out;
}

/** One skill discovered in a remote repo. `path` is its folder path within the repo (the install key). */
export interface RemoteSkill {
  name: string;
  description: string;
  path: string;
  /** Supporting file paths relative to the skill folder (excludes SKILL.md), for display. */
  files: string[];
}

export interface RemoteCatalog {
  repo: string;
  ref: string;
  /** The repo's own description, when GitHub returns one. */
  repoDescription: string;
  skills: RemoteSkill[];
}

/** A fetched file ready to be written into the library: path relative to the skill folder + bytes. */
export interface FetchedFile {
  rel: string;
  data: Buffer;
}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MAX_FILES = 200; // per skill — guards against a hostile/huge folder
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // 8 MB per skill install
const SKILL_FILE = 'SKILL.md';

/** `owner/repo` (optionally a github URL or `owner/repo@ref`) → `{ owner, repo, ref? }`. */
export function parseRepo(input: string): { owner: string; repo: string; ref?: string } {
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  let ref: string | undefined;
  const at = s.indexOf('@');
  if (at !== -1) { ref = s.slice(at + 1); s = s.slice(0, at); }
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('expected owner/repo (e.g. coreyhaines31/marketingskills)');
  const [owner, repo] = parts;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('invalid owner/repo');
  return { owner, repo, ref };
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-os' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) throw new Error('repository not found (or private)');
  if (res.status === 403) throw new Error('GitHub rate limit hit — set GITHUB_TOKEN to raise it, or retry later');
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return res.json();
}

/** Run async mappers with a small concurrency cap (no deps), preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * List every skill in a public GitHub repo. One trees-API call enumerates the repo; SKILL.md bodies
 * are read from raw (off the API budget) to surface each skill's `description`. `ref` defaults to the
 * repo's default branch.
 */
export async function browseRepo(input: string): Promise<RemoteCatalog> {
  const { owner, repo, ref: wantRef } = parseRepo(input);
  const meta = await ghJson(`${API}/repos/${owner}/${repo}`);
  const ref = wantRef || meta.default_branch || 'main';
  const tree = await ghJson(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (tree.truncated) {
    // Too large to enumerate in one shot — extremely rare for a skills repo.
    throw new Error('repo tree is too large to enumerate');
  }
  const blobs: string[] = (tree.tree as any[]).filter((t) => t.type === 'blob').map((t) => t.path);

  // A skill = a folder containing a SKILL.md. name = the folder's basename. Dedupe by name (first wins).
  const skillDirs: { name: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const path of blobs) {
    if (!path.endsWith('/' + SKILL_FILE) && path !== SKILL_FILE) continue;
    const dir = path === SKILL_FILE ? '' : path.slice(0, -(SKILL_FILE.length + 1));
    const name = (dir.split('/').pop() || repo).toLowerCase();
    if (!validSkillName(name) || seen.has(name)) continue;
    seen.add(name);
    skillDirs.push({ name, path: dir });
  }

  const skills = await mapPool(skillDirs, 8, async ({ name, path }) => {
    const prefix = path ? path + '/' : '';
    const files = blobs
      .filter((b) => b.startsWith(prefix) && b !== prefix + SKILL_FILE)
      .map((b) => b.slice(prefix.length))
      .filter((f) => !f.includes('node_modules/'));
    let description = '';
    try {
      const md = await rawText(owner, repo, ref, prefix + SKILL_FILE);
      description = parseFrontmatter(md).description ?? '';
    } catch { /* description is best-effort */ }
    return { name, description, path, files } as RemoteSkill;
  });

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { repo: `${owner}/${repo}`, ref, repoDescription: meta.description || '', skills };
}

async function rawText(owner: string, repo: string, ref: string, path: string): Promise<string> {
  const url = `${RAW}/${owner}/${repo}/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url, { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined });
  if (!res.ok) throw new Error(`raw fetch ${res.status} for ${path}`);
  return res.text();
}

/**
 * Fetch every file of one remote skill (SKILL.md + supporting files), ready to write into the library.
 * Re-reads the tree to know the skill's blobs, then pulls each from raw. Enforces file-count/size caps.
 */
export async function fetchSkill(input: string, skillPath: string, name?: string): Promise<FetchedFile[]> {
  const { owner, repo, ref: wantRef } = parseRepo(input);
  const meta = await ghJson(`${API}/repos/${owner}/${repo}`);
  const ref = wantRef || meta.default_branch || 'main';
  const tree = await ghJson(`${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  // skills.sh hits give a name but no path — resolve the folder by basename (shortest match wins).
  let resolved = skillPath;
  if (!resolved && name) {
    const want = name.trim().toLowerCase();
    const dirs = (tree.tree as any[])
      .filter((t) => t.type === 'blob' && (t.path === SKILL_FILE || t.path.endsWith('/' + SKILL_FILE)))
      .map((t) => (t.path === SKILL_FILE ? '' : t.path.slice(0, -(SKILL_FILE.length + 1))))
      .filter((d) => (d.split('/').pop() || repo).toLowerCase() === want)
      .sort((a, b) => a.length - b.length);
    if (dirs.length === 0) throw new Error(`no skill named "${name}" in ${owner}/${repo}`);
    resolved = dirs[0];
  }
  const prefix = resolved ? resolved.replace(/\/$/, '') + '/' : '';
  const blobs: { path: string; size: number }[] = (tree.tree as any[])
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && !t.path.slice(prefix.length).includes('node_modules/'))
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
  if (!blobs.some((b) => b.path === prefix + SKILL_FILE)) throw new Error('no SKILL.md at that path');
  if (blobs.length > MAX_FILES) throw new Error(`skill has too many files (${blobs.length} > ${MAX_FILES})`);
  const total = blobs.reduce((n, b) => n + b.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error('skill exceeds the size limit');

  return mapPool(blobs, 8, async (b) => {
    const url = `${RAW}/${owner}/${repo}/${ref}/${b.path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : undefined });
    if (!res.ok) throw new Error(`raw fetch ${res.status} for ${b.path}`);
    const data = Buffer.from(await res.arrayBuffer());
    return { rel: b.path.slice(prefix.length), data };
  });
}
