/**
 * The deliverables gallery — a curated, durable store of artifacts agents explicitly publish.
 *
 * An agent calls the OS-owned `publish` tool with a path in its working folder; the file is
 * SNAPSHOTTED (copied) into `<home>/artifacts/<id>/<filename>` so it's immutable even as the agent
 * keeps editing its working copy. One row per artifact, with full provenance (session + agent +
 * source) — the same shape as the inbox `messages` table, so the inbox's per-member visibility rule
 * scopes the gallery with no new logic.
 *
 * The per-artifact id-dir (rather than a flat file) is deliberate: a future multi-file artifact (a
 * small generated website — `kind:'site'`) is just MORE files in the same dir, served through the
 * same raw route via its `?file=` seam. No migration, no new storage shape.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from './db';

export interface Artifact {
  id: string;
  sessionId: string;
  agent: string;
  source?: string;
  kind: string;
  title: string;
  description?: string;
  filename: string;
  relPath: string;
  mime: string;
  bytes: number;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  agent: string;
  source: string | null;
  kind: string;
  title: string;
  description: string | null;
  filename: string;
  rel_path: string;
  mime: string;
  bytes: number;
  created_at: number;
}

export type PublishResult = { ok: true; artifact: Artifact } | { ok: false; error: string };

export class ArtifactStore {
  constructor(private readonly db: Db, private readonly dir?: string) {}

  /** Is a durable store available? (Needs a data home; off for demo/tests on `:memory:`.) */
  get enabled(): boolean {
    return !!this.dir;
  }

  /**
   * Snapshot a file from the agent's working folder into the gallery. `allowRoot` is the agent's
   * folder; `srcPath` (the path the agent gave) is resolved STRICTLY under it — lexically and after
   * symlink resolution — so an agent can't publish `/etc/passwd` or escape via a symlink.
   */
  publish(input: {
    sessionId: string;
    agent: string;
    source?: string;
    title: string;
    description?: string;
    allowRoot: string;
    srcPath: string;
    kind?: string;
  }): PublishResult {
    if (!this.dir) return { ok: false, error: 'no data home configured (artifacts disabled)' };
    const src = containedPath(input.allowRoot, input.srcPath);
    if (!src) return { ok: false, error: 'path escapes the agent folder or does not exist' };
    let st: fs.Stats;
    try {
      st = fs.statSync(src);
    } catch {
      return { ok: false, error: 'not found' };
    }
    if (!st.isFile()) return { ok: false, error: 'not a file' };

    const id = randomUUID().slice(0, 8);
    const filename = path.basename(src);
    const destDir = path.join(this.dir, id);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, filename));

    const row: ArtifactRow = {
      id,
      session_id: input.sessionId,
      agent: input.agent,
      source: input.source ?? null,
      kind: input.kind ?? 'file',
      title: input.title,
      description: input.description ?? null,
      filename,
      rel_path: path.join(id, filename),
      mime: mimeOf(filename),
      bytes: st.size,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, agent, source, kind, title, description, filename, rel_path, mime, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.session_id, row.agent, row.source, row.kind, row.title, row.description,
        row.filename, row.rel_path, row.mime, row.bytes, row.created_at,
      );
    return { ok: true, artifact: toArtifact(row) };
  }

  /** All artifacts, newest first. The server filters by viewer (inbox visibility rule). */
  list(): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC')
      .all<ArtifactRow>()
      .map(toArtifact);
  }

  get(id: string): Artifact | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get<ArtifactRow>(id);
    return r ? toArtifact(r) : undefined;
  }

  /**
   * Resolve an artifact's bytes for streaming. `file` (optional) selects a sibling inside the
   * id-dir — the seam a future `kind:'site'` uses to serve `/style.css` etc.; default = the entry
   * filename. Strictly contained to the artifact's own dir. null if missing/escaping.
   */
  readPath(id: string, file?: string): { absPath: string; mime: string; filename: string } | null {
    if (!this.dir) return null;
    const a = this.get(id);
    if (!a) return null;
    const idDir = path.join(this.dir, id);
    const rel = file && file.trim() ? file : a.filename;
    const abs = containedPath(idDir, rel);
    if (!abs) return null;
    try {
      if (!fs.statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
    return { absPath: abs, mime: mimeOf(abs), filename: path.basename(abs) };
  }

  /** Remove an artifact: its row and its on-disk id-dir. */
  remove(id: string): boolean {
    const a = this.get(id);
    if (!a) return false;
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    if (this.dir) fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }
}

function toArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    sessionId: r.session_id,
    agent: r.agent,
    source: r.source ?? undefined,
    kind: r.kind,
    title: r.title,
    description: r.description ?? undefined,
    filename: r.filename,
    relPath: r.rel_path,
    mime: r.mime,
    bytes: r.bytes,
    createdAt: r.created_at,
  };
}

/** Resolve `rel` under `root`, rejecting escapes lexically AND after symlink resolution. The
 *  target must already exist (you publish/serve real files). Mirrors server.ts `safeResolve`. */
function containedPath(root: string, rel: string): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  const target = path.resolve(realRoot, rel.replace(/^[/\\]+/, ''));
  if (!within(target)) return null;
  if (!fs.existsSync(target)) return null;
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  return within(real) ? real : null;
}

/** Content-type by extension — self-contained so the store has no server dependency. Covers the
 *  deliverable formats (Markdown/PDF/images/video/text) the gallery previews; default = octet-stream. */
function mimeOf(file: string): string {
  const e = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.ogv': 'video/ogg',
  };
  return map[e] || 'application/octet-stream';
}
