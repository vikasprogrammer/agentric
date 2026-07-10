/**
 * The Knowledge Base — the shared, tenant-wide, LIVING wiki agents and humans co-author.
 *
 * Unlike Memory (private, per-agent scratch) the KB is shared and rewritten in place over time, so the
 * company accumulates up-to-date knowledge without humans touching it unless something needs review.
 * Safety comes not from approvals but from **reversibility**: every `write` snapshots a full revision
 * into `kb_revisions`, so any edit (by an agent or a human) is auditable and one-click revertable —
 * nothing is ever truly lost.
 *
 * Storage mirrors Artifacts/Skills: the page body is the markdown column (feeds FTS5 + serves the API)
 * AND, when a data home exists, a `kb/<section>/<slug>.md` file on disk (human/git-friendly). The two
 * are written together on the single mutating path (`write`), so they never diverge.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from './db';
import { KbPage, KbRevision, KbSearchQuery, KbWriteInput } from '../types';

interface PageRow {
  id: string; tenant: string; section: string; slug: string; title: string; tags: string;
  body: string; rel_path: string; rev: number; created_at: number; updated_at: number; updated_by: string;
  read_count: number; last_read_at: number | null;
  rank?: number;
}
interface RevRow {
  id: string; page_id: string; rev: number; title: string; tags: string; body: string;
  summary: string | null; author: string; created_at: number;
}

export class KbStore {
  constructor(private readonly db: Db, private readonly dir?: string) {}

  /** Is the on-disk mirror available? (Needs a data home; off for demo/tests on `:memory:`.) */
  get enabled(): boolean {
    return !!this.dir;
  }

  /**
   * The one mutating path. Upsert by (tenant, section, slug): create at rev 1, or bump rev on edit.
   * Always appends a full snapshot to `kb_revisions` (so every version stays retrievable), updates the
   * page row + FTS (via triggers), and mirrors the body to disk when a home is configured.
   */
  write(input: KbWriteInput): KbPage {
    const section = normPath(input.section);
    const slug = normSeg(input.slug);
    if (!section || !slug) throw new Error('section and slug must be url-safe (letters, digits, hyphens; section may nest with "/")');

    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM kb_pages WHERE tenant = ? AND section = ? AND slug = ?')
      .get<PageRow>(input.tenant, section, slug);
    const id = existing?.id ?? randomUUID().slice(0, 8);
    const rev = existing ? existing.rev + 1 : 1;
    const title = (input.title ?? existing?.title ?? slug).trim() || slug;
    const tags = input.tags ?? (existing ? (JSON.parse(existing.tags) as string[]) : []);
    const relPath = path.posix.join('kb', section, `${slug}.md`);

    if (existing) {
      this.db
        .prepare('UPDATE kb_pages SET title = ?, tags = ?, body = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(title, JSON.stringify(tags), input.body, rev, now, input.author, id);
    } else {
      this.db
        .prepare(`INSERT INTO kb_pages (id, tenant, section, slug, title, tags, body, rel_path, rev, created_at, updated_at, updated_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.tenant, section, slug, title, JSON.stringify(tags), input.body, relPath, rev, now, now, input.author);
    }
    // Snapshot this version — the rollback + audit backbone.
    this.db
      .prepare('INSERT INTO kb_revisions (id, page_id, rev, title, tags, body, summary, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID().slice(0, 8), id, rev, title, JSON.stringify(tags), input.body, input.summary ?? null, input.author, now);
    // Mirror to disk (best-effort; the column is the source of record for the API + FTS).
    const abs = this.contained(section, slug);
    if (abs) {
      try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, input.body); } catch { /* disk mirror is best-effort */ }
    }
    return this.get(id)!;
  }

  /** Ranked search (bm25 over title+tags+body), optional section/tags filter. Empty query → recently updated. */
  search(q: KbSearchQuery): KbPage[] {
    const limit = Math.max(1, Math.min(q.limit ?? 12, 100));
    const fetchN = q.tags?.length || q.section ? limit * 5 : limit;
    const match = toFtsQuery(q.query);
    let rows: PageRow[];
    if (match) {
      rows = this.db
        .prepare(`SELECT p.*, bm25(kb_fts) AS rank FROM kb_fts JOIN kb_pages p ON p.rowid = kb_fts.rowid
                   WHERE kb_fts MATCH ? AND p.tenant = ? ORDER BY rank LIMIT ?`)
        .all<PageRow>(match, q.tenant, fetchN);
    } else {
      rows = this.db
        .prepare('SELECT * FROM kb_pages WHERE tenant = ? ORDER BY updated_at DESC LIMIT ?')
        .all<PageRow>(q.tenant, fetchN);
    }
    let pages = rows.map(toPage);
    if (q.section) pages = pages.filter((p) => p.section === normPath(q.section!));
    if (q.tags?.length) { const want = new Set(q.tags); pages = pages.filter((p) => p.tags.some((t) => want.has(t))); }
    return pages.slice(0, limit);
  }

  read(tenant: string, section: string, slug: string): KbPage | null {
    const r = this.db
      .prepare('SELECT * FROM kb_pages WHERE tenant = ? AND section = ? AND slug = ?')
      .get<PageRow>(tenant, normPath(section), normSeg(slug));
    return r ? toPage(r) : null;
  }

  /**
   * Record that an agent fetched a page: bump `read_count` and stamp `last_read_at`. Cheap targeted
   * UPDATE (the FTS trigger is scoped to content columns, so this never re-tokenizes the body). A page
   * with a low/stale count is a future auto-archive candidate. Best-effort — never fails a read.
   */
  recordRead(id: string, at: number = Date.now()): void {
    try {
      this.db.prepare('UPDATE kb_pages SET read_count = read_count + 1, last_read_at = ? WHERE id = ?').run(at, id);
    } catch { /* counting is telemetry — a failure must not break the fetch */ }
  }

  get(id: string): KbPage | undefined {
    const r = this.db.prepare('SELECT * FROM kb_pages WHERE id = ?').get<PageRow>(id);
    return r ? toPage(r) : undefined;
  }

  /** All pages for a tenant (newest-updated first), optionally one section. */
  list(tenant: string, section?: string): KbPage[] {
    const rows = section
      ? this.db.prepare('SELECT * FROM kb_pages WHERE tenant = ? AND section = ? ORDER BY updated_at DESC').all<PageRow>(tenant, normPath(section))
      : this.db.prepare('SELECT * FROM kb_pages WHERE tenant = ? ORDER BY updated_at DESC').all<PageRow>(tenant);
    return rows.map(toPage);
  }

  /** Distinct sections present in a tenant's KB (for the console tree). */
  sections(tenant: string): string[] {
    return this.db
      .prepare('SELECT DISTINCT section FROM kb_pages WHERE tenant = ? ORDER BY section')
      .all<{ section: string }>(tenant)
      .map((r) => r.section);
  }

  /** Full revision history for a page, newest first. */
  history(pageId: string): KbRevision[] {
    return this.db
      .prepare('SELECT * FROM kb_revisions WHERE page_id = ? ORDER BY rev DESC')
      .all<RevRow>(pageId)
      .map(toRev);
  }

  /** Revert a page to an earlier revision — itself a new (auditable, revertable) write. */
  revert(pageId: string, rev: number, author: string): KbPage | null {
    const page = this.get(pageId);
    if (!page) return null;
    const target = this.db.prepare('SELECT * FROM kb_revisions WHERE page_id = ? AND rev = ?').get<RevRow>(pageId, rev);
    if (!target) return null;
    return this.write({
      tenant: page.tenant, section: page.section, slug: page.slug,
      title: target.title, body: target.body, tags: JSON.parse(target.tags) as string[],
      summary: `revert to rev ${rev}`, author,
    });
  }

  /** Remove a page: drop the row + on-disk file. Revision history is retained (recoverable). */
  remove(id: string): boolean {
    const page = this.get(id);
    if (!page) return false;
    this.db.prepare('DELETE FROM kb_pages WHERE id = ?').run(id);
    const abs = this.contained(page.section, page.slug);
    if (abs) { try { fs.rmSync(abs, { force: true }); } catch { /* best-effort */ } }
    return true;
  }

  /** Resolve `<dir>/<section>/<slug>.md`, guaranteed under the KB root. null when no home. */
  private contained(section: string, slug: string): string | null {
    if (!this.dir) return null;
    const root = path.resolve(this.dir);
    const abs = path.resolve(root, section, `${slug}.md`);
    return abs === root || abs.startsWith(root + path.sep) ? abs : null; // section is normPath'd (per-segment [a-z0-9-]), so always true — defense in depth
  }
}

/** Lowercase to a single url-safe path segment ([a-z0-9-]); '' if nothing usable. */
function normSeg(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/**
 * Normalize a section into a nested folder PATH: '/'-joined url-safe segments ('' if nothing usable).
 * Each segment is normSeg'd, so `..`/absolute paths collapse to empty and are dropped — a section can
 * never escape the KB root. A plain single-level section (`engineering`) round-trips unchanged.
 */
function normPath(s: string): string {
  return String(s || '').split('/').map(normSeg).filter(Boolean).join('/');
}

/** Word tokens ORed as quoted FTS5 terms (quoting neutralises operator chars). '' → caller uses recency. */
function toFtsQuery(query?: string): string {
  if (!query) return '';
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || !tokens.length) return '';
  return [...new Set(tokens)].map((t) => `"${t}"`).join(' OR ');
}

function toPage(r: PageRow): KbPage {
  return {
    id: r.id, tenant: r.tenant, section: r.section, slug: r.slug, title: r.title,
    tags: JSON.parse(r.tags) as string[], body: r.body, relPath: r.rel_path, rev: r.rev,
    createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    readCount: r.read_count ?? 0, lastReadAt: r.last_read_at ?? undefined,
  };
}

function toRev(r: RevRow): KbRevision {
  return {
    id: r.id, pageId: r.page_id, rev: r.rev, title: r.title, tags: JSON.parse(r.tags) as string[],
    body: r.body, summary: r.summary ?? undefined, author: r.author, createdAt: r.created_at,
  };
}
