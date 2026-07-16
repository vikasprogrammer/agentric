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
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from './db';

/** How long a public artifact link stays live before it auto-revokes (a "public forever" guard). */
export const PUBLIC_SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Artifact {
  id: string;
  sessionId: string;
  agent: string;
  source?: string;
  kind: string;
  title: string;
  description?: string;
  folder: string; // '/'-separated folder path ('' = root); organizes the gallery into a browsable tree
  filename: string;
  relPath: string;
  mime: string;
  bytes: number;
  /** USD this artifact cost to generate (image/video); undefined for published (non-generated) files. */
  costUsd?: number;
  /** Shared with the whole tenant — every member sees it in the Library, on top of the provenance rule. */
  sharedTeam: boolean;
  /** When set, the artifact has a public login-free link (`/shared/<token>`). undefined = not public. */
  shareToken?: string;
  /** Epoch ms when the public link auto-revokes (mint time + {@link PUBLIC_SHARE_TTL_MS}). */
  shareExpiresAt?: number;
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
  folder: string | null;
  filename: string;
  rel_path: string;
  mime: string;
  bytes: number;
  cost_usd: number | null;
  shared_team: number;
  share_token: string | null;
  share_expires_at: number | null;
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
    folder?: string;
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
      folder: normFolder(input.folder),
      filename,
      rel_path: path.join(id, filename),
      mime: mimeOf(filename),
      bytes: st.size,
      cost_usd: null, // published files aren't generated → no cost
      shared_team: 0, // published private to its producer until explicitly shared
      share_token: null,
      share_expires_at: null,
      created_at: Date.now(),
    };
    this.insertRow(row);
    return { ok: true, artifact: toArtifact(row) };
  }

  /** Single INSERT both publish + ingest share, so the column list lives in one place. */
  private insertRow(row: ArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, agent, source, kind, title, description, folder, filename, rel_path, mime, bytes, cost_usd, shared_team, share_token, share_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id, row.session_id, row.agent, row.source, row.kind, row.title, row.description,
        row.folder, row.filename, row.rel_path, row.mime, row.bytes, row.cost_usd,
        row.shared_team, row.share_token, row.share_expires_at, row.created_at,
      );
  }

  /**
   * Ingest bytes that originate SERVER-SIDE (not from an agent's working folder) straight into the
   * gallery — the path a generated image/video takes. Same table + id-dir shape as `publish`, but the
   * source is a Buffer we already hold, so there's no `allowRoot`/containment check (nothing the agent
   * named is being read from disk). The caller owns provenance (sessionId/agent/source) + title.
   */
  ingest(input: {
    sessionId: string;
    agent: string;
    source?: string;
    title: string;
    description?: string;
    folder?: string;
    filename: string;
    bytes: Buffer;
    kind?: string;
    costUsd?: number; // USD this artifact cost to generate (surfaced in the gallery)
  }): PublishResult {
    if (!this.dir) return { ok: false, error: 'no data home configured (artifacts disabled)' };
    const filename = path.basename(input.filename) || 'image.png';
    const id = randomUUID().slice(0, 8);
    const destDir = path.join(this.dir, id);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, filename), input.bytes);

    const row: ArtifactRow = {
      id,
      session_id: input.sessionId,
      agent: input.agent,
      source: input.source ?? null,
      kind: input.kind ?? 'file',
      title: input.title,
      description: input.description ?? null,
      folder: normFolder(input.folder),
      filename,
      rel_path: path.join(id, filename),
      mime: mimeOf(filename),
      bytes: input.bytes.length,
      cost_usd: typeof input.costUsd === 'number' ? input.costUsd : null,
      shared_team: 0,
      share_token: null,
      share_expires_at: null,
      created_at: Date.now(),
    };
    this.insertRow(row);
    return { ok: true, artifact: toArtifact(row) };
  }

  /** All artifacts, newest first. The server filters by viewer (inbox visibility rule). */
  list(): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC')
      .all<ArtifactRow>()
      .map(toArtifact);
  }

  /** Distinct non-empty folder paths in use (for agent discovery — file into the existing tree
   *  rather than inventing a new folder). Tenant-wide; the paths are organizing labels, not contents. */
  folders(): string[] {
    return this.db
      .prepare("SELECT DISTINCT folder FROM artifacts WHERE folder <> '' ORDER BY folder")
      .all<{ folder: string }>()
      .map((r) => r.folder);
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

  /**
   * Overwrite a TEXT artifact's entry file in place with new content — human curation of a published
   * deliverable (e.g. fixing a typo in a Markdown report). Refuses binaries (a write would corrupt them)
   * and a missing data home. The snapshot's id-dir + filename are unchanged, so every existing link
   * (Library, public `/shared/<token>`) keeps resolving; only the stored byte size is updated.
   */
  writeContent(id: string, content: string): PublishResult {
    if (!this.dir) return { ok: false, error: 'no data home configured (artifacts disabled)' };
    const a = this.get(id);
    if (!a) return { ok: false, error: 'not found' };
    if (!isTextEditable(a.mime)) return { ok: false, error: 'only text and markdown artifacts are editable' };
    const abs = containedPath(path.join(this.dir, id), a.filename);
    if (!abs) return { ok: false, error: 'file not found' };
    const buf = Buffer.from(content, 'utf8');
    fs.writeFileSync(abs, buf);
    this.db.prepare('UPDATE artifacts SET bytes = ? WHERE id = ?').run(buf.length, id);
    return { ok: true, artifact: { ...a, bytes: buf.length } };
  }

  /** Share (or unshare) an artifact with the whole tenant — every member then sees it in the Library. */
  setTeamShared(id: string, shared: boolean): boolean {
    const info = this.db.prepare('UPDATE artifacts SET shared_team = ? WHERE id = ?').run(shared ? 1 : 0, id);
    return info.changes > 0;
  }

  /**
   * Toggle the public login-free link. Turning it ON mints a crypto-random token (reusing the existing
   * one if already public, so the URL is stable across re-toggles) and (re)sets a fresh
   * {@link PUBLIC_SHARE_TTL_MS} expiry — so re-sharing an expired/lapsing link renews its 7 days. OFF
   * clears both (revokes the link). Returns the resulting token + expiry (nulls when off / missing). The
   * token is the sole credential the public route trusts, so it must be unguessable — `randomBytes`.
   */
  setPublic(id: string, on: boolean): { token: string | null; expiresAt: number | null } | null {
    const a = this.get(id);
    if (!a) return null;
    if (!on) {
      this.db.prepare('UPDATE artifacts SET share_token = NULL, share_expires_at = NULL WHERE id = ?').run(id);
      return { token: null, expiresAt: null };
    }
    const token = a.shareToken ?? randomBytes(18).toString('base64url');
    const expiresAt = Date.now() + PUBLIC_SHARE_TTL_MS;
    this.db.prepare('UPDATE artifacts SET share_token = ?, share_expires_at = ? WHERE id = ?').run(token, expiresAt, id);
    return { token, expiresAt };
  }

  /**
   * Resolve an artifact by its public share token (the `/shared/<token>` lookup). Returns undefined if
   * no such token OR the link has EXPIRED — so a lapsed link stops resolving the instant it expires, even
   * before the scheduler sweep clears the row. undefined = serve a 404.
   */
  getByToken(token: string): Artifact | undefined {
    if (!token) return undefined;
    const r = this.db.prepare('SELECT * FROM artifacts WHERE share_token = ?').get<ArtifactRow>(token);
    if (!r) return undefined;
    if (r.share_expires_at != null && r.share_expires_at < Date.now()) return undefined; // expired → gone
    return toArtifact(r);
  }

  /**
   * Auto-revoke public links past their expiry: clear the token + expiry from every lapsed row and return
   * the affected ids (for the caller to audit). Called from the scheduler tick; the link already stops
   * resolving at expiry (getByToken), this just makes the revocation durable so the token is truly gone.
   */
  expirePublicShares(now: number): string[] {
    const where = 'share_token IS NOT NULL AND share_expires_at IS NOT NULL AND share_expires_at < ?';
    const rows = this.db.prepare(`SELECT id FROM artifacts WHERE ${where}`).all<{ id: string }>(now);
    if (rows.length) this.db.prepare(`UPDATE artifacts SET share_token = NULL, share_expires_at = NULL WHERE ${where}`).run(now);
    return rows.map((r) => r.id);
  }

  /** Move an artifact into a folder (metadata only — the on-disk id-dir never moves). '' = root. */
  move(id: string, folder: string): boolean {
    const info = this.db.prepare('UPDATE artifacts SET folder = ? WHERE id = ?').run(normFolder(folder), id);
    return info.changes > 0;
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
    folder: r.folder ?? '',
    filename: r.filename,
    relPath: r.rel_path,
    mime: r.mime,
    bytes: r.bytes,
    costUsd: r.cost_usd ?? undefined,
    sharedTeam: r.shared_team === 1,
    shareToken: r.share_token ?? undefined,
    shareExpiresAt: r.share_expires_at ?? undefined,
    createdAt: r.created_at,
  };
}

/**
 * Normalize a folder into a '/'-separated path of url-safe segments ('' = root). Each segment is
 * lowercased to [a-z0-9-] and empties are dropped, so `..`/absolute paths collapse away — a folder
 * is pure organizing metadata and can never point at the filesystem. Mirrors KB's `normPath`.
 */
function normFolder(s?: string): string {
  return String(s || '')
    .split('/')
    .map((seg) => seg.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64))
    .filter(Boolean)
    .join('/');
}

/** Resolve `rel` under `root`, rejecting escapes lexically AND after symlink resolution. The
 *  target must already exist (you publish/serve real files). Mirrors server.ts `safeResolve`. */
export function containedPath(root: string, rel: string): string | null {
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

/** Whether an artifact's content may be edited in place — text-like mimes only, never a binary (an
 *  overwrite would corrupt it). HTML counts (it's text); images/PDF/video do not. */
export function isTextEditable(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json';
}

/** Content-type by extension — self-contained so the store has no server dependency. Covers the
 *  deliverable formats (Markdown/PDF/images/video/text) the gallery previews; default = octet-stream. */
export function mimeOf(file: string): string {
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
