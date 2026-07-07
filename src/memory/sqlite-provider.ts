/**
 * SQLite memory provider — the zero-infra default backend of the memory plane.
 *
 * Stores memories in the per-workspace DB (`memories` table) and ranks recall with SQLite's
 * built-in FTS5 `bm25()` over content+tags. With NO external services and NO new dependencies it
 * gives every agent durable, ranked recall across sessions out of the box.
 *
 * Semantic recall, optionally: pass an `Embedder` and every memory also gets an embedding stored in
 * a `BLOB` column. Recall then becomes HYBRID — bm25 (keyword) ∪ cosine (meaning, computed in JS
 * over the agent's own small candidate set), blended by reciprocal rank fusion. Same ranking design
 * as the libsql backend; the only difference is the cosine runs in JavaScript instead of in-engine,
 * which keeps the zero-dependency `node:sqlite` stance. Omit the embedder → keyword-only, as before.
 *
 * Isolation: every query is scoped by (tenant, agent_id), so an agent only ever sees its own.
 */
import { randomUUID } from 'crypto';
import { Db } from '../state/db';
import {
  DeleteInput, MemoryMaintenance, MemoryMaintenanceResult, MemoryProvider, MemoryRanking,
  MemoryRecord, MemoryScope, RecallQuery, StoreInput, UpdateInput,
} from '../types';
import { ConsolidateRow, cosine, Embedder, fuse, packF32, planConsolidation, rerank, toFtsQuery, unpackF32 } from './embedding';

interface MemoryRow {
  id: string;
  tenant: string;
  agent_id: string;
  content: string;
  tags: string;
  type: string | null;
  importance: number | null;
  metadata: string | null;
  created_at: number;
  scope: string;
  recall_count?: number;
  last_recalled_at?: number | null;
  embedding?: Uint8Array | null;
  rank?: number;
}

/** Visibility predicate for recall: own rows, shared rows, or both (default). */
function scopeWhere(q: RecallQuery, p = ''): { sql: string; args: unknown[] } {
  const scope = q.scope ?? 'all';
  if (scope === 'agent') return { sql: `${p}tenant = ? AND ${p}agent_id = ?`, args: [q.tenant, q.agentId] };
  if (scope === 'tenant') return { sql: `${p}tenant = ? AND ${p}scope = 'tenant'`, args: [q.tenant] };
  return { sql: `${p}tenant = ? AND (${p}agent_id = ? OR ${p}scope = 'tenant')`, args: [q.tenant, q.agentId] };
}

export class SqliteMemoryProvider implements MemoryProvider {
  constructor(private readonly db: Db, private readonly embedder?: Embedder, private readonly ranking?: MemoryRanking) {}

  async store(input: StoreInput): Promise<MemoryRecord> {
    const rec: MemoryRecord = {
      id: randomUUID(),
      tenant: input.tenant,
      agentId: input.agentId,
      content: input.content,
      tags: input.tags ?? [],
      type: input.type,
      importance: input.importance,
      metadata: input.metadata,
      ts: Date.now(),
      scope: input.scope ?? 'agent',
    };
    const vec = this.embedder ? await this.embedder.embed(rec.content) : null;
    this.db
      .prepare('INSERT INTO memories (id, tenant, agent_id, content, tags, type, importance, metadata, created_at, scope, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        rec.id, rec.tenant, rec.agentId, rec.content, JSON.stringify(rec.tags),
        rec.type ?? null, rec.importance ?? null,
        rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null, rec.ts, rec.scope,
        vec ? packF32(vec) : null,
      );
    return rec;
  }

  /**
   * Upsert a record verbatim (id/ts preserved), used to MIRROR another backend's writes into the
   * local `memories` table so the OS's SQL-level readers — Dreaming, the consolidation gardener, the
   * Memory-hub overview counts — keep working no matter which recall backend is configured. No
   * embedding is stored (the mirror is never the recall path; recall goes to the real backend). The
   * FTS index is trigger-maintained, so INSERT OR REPLACE keeps it consistent. See MirroredMemoryProvider.
   */
  insertRecord(rec: MemoryRecord): void {
    this.db
      .prepare('INSERT OR REPLACE INTO memories (id, tenant, agent_id, content, tags, type, importance, metadata, created_at, scope, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        rec.id, rec.tenant, rec.agentId, rec.content, JSON.stringify(rec.tags ?? []),
        rec.type ?? null, rec.importance ?? null,
        rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null, rec.ts, rec.scope, null,
      );
  }

  /** Drop a mirrored record by (tenant, id) — the delete counterpart of `insertRecord`. */
  removeRecord(tenant: string, id: string): void {
    this.db.prepare('DELETE FROM memories WHERE tenant = ? AND id = ?').run(tenant, id);
  }

  /** How many memories this tenant has in the table (for the backend-switch drift banner). */
  async count(tenant: string): Promise<number> {
    return Number(this.db.prepare('SELECT count(*) AS n FROM memories WHERE tenant = ?').get<{ n: number }>(tenant)?.n ?? 0);
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(q.limit ?? 8, 100));
    // Over-fetch so an optional tag filter (applied in JS) still returns up to `limit`.
    const fetchN = q.tags?.length ? limit * 5 : limit;
    const match = toFtsQuery(q.query);

    // Visibility: by default an agent sees its own rows ∪ the tenant's shared rows.
    const vis = scopeWhere(q, 'm.');
    const visBare = scopeWhere(q); // for queries on `memories` with no alias

    // Lexical list (bm25) — when the query yields usable tokens.
    let lexical: MemoryRecord[] = [];
    if (match) {
      const rows = this.db
        .prepare(
          `SELECT m.*, bm25(memories_fts) AS rank
             FROM memories_fts
             JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ? AND ${vis.sql}
            ORDER BY rank
            LIMIT ?`,
        )
        .all<MemoryRow>(match, ...vis.args, fetchN);
      lexical = rows.map(toRecord);
    }

    // Semantic list (cosine in JS) — when an embedder is set and the query embeds. Brute-force over
    // the visible embedded rows (own + shared); the set is small, so a full scan is cheap.
    let vector: MemoryRecord[] = [];
    const qvec = this.embedder && q.query ? await this.embedder.embed(q.query) : null;
    if (qvec) {
      const qf = Float32Array.from(qvec);
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE ${visBare.sql} AND embedding IS NOT NULL`)
        .all<MemoryRow>(...visBare.args);
      vector = rows
        .map((r) => ({ rec: toRecord(r), sim: cosine(qf, unpackF32(r.embedding!)) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, fetchN)
        .map((x) => ({ ...x.rec, score: x.sim }));
    }

    let recs: MemoryRecord[];
    if (vector.length && lexical.length) recs = rerank(fuse(lexical, vector), this.ranking, Date.now());
    else if (vector.length) recs = rerank(vector, this.ranking, Date.now());
    else if (lexical.length) recs = rerank(lexical, this.ranking, Date.now());
    else {
      // No usable query (or nothing matched) → most recent visible rows (already recency-ranked).
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE ${visBare.sql} ORDER BY created_at DESC LIMIT ?`)
        .all<MemoryRow>(...visBare.args, fetchN);
      recs = rows.map(toRecord);
    }

    if (q.tags?.length) {
      const want = new Set(q.tags);
      recs = recs.filter((r) => r.tags.some((t) => want.has(t)));
    }
    const out = recs.slice(0, limit);
    // Usage tracking for maintenance: count a memory as "used" when an actual query surfaces it (not a
    // blank recency listing), so prune can safely target the never-recalled.
    if (q.query && out.length) {
      const ids = out.map((r) => r.id);
      this.db
        .prepare(`UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(Date.now(), ...ids);
    }
    return out;
  }

  async maintain(opts: MemoryMaintenance): Promise<MemoryMaintenanceResult> {
    let pruned = 0;
    let merged = 0;

    // Prune: old AND never recalled AND not important. Conservative by construction.
    if (opts.pruneAfterDays && opts.pruneAfterDays > 0) {
      const cutoff = Date.now() - opts.pruneAfterDays * 86_400_000;
      const keep = opts.keepImportance ?? 0.5;
      pruned = this.db
        .prepare('DELETE FROM memories WHERE created_at < ? AND recall_count = 0 AND (importance IS NULL OR importance < ?)')
        .run(cutoff, keep).changes;
    }

    // Consolidate duplicates per (tenant, agent_id). Only when opted in via a dedupe threshold.
    if (opts.dedupeThreshold != null) {
      const rows = this.db
        .prepare('SELECT id, tenant, agent_id, content, importance, recall_count, created_at, scope, embedding FROM memories')
        .all<MemoryRow & { tenant: string; recall_count: number }>();
      const groups = new Map<string, ConsolidateRow[]>();
      for (const r of rows) {
        const key = `${r.tenant} ${r.agent_id} ${r.scope}`; // by scope too: a private + shared copy never merge
        const arr = groups.get(key) ?? [];
        if (!groups.has(key)) groups.set(key, arr);
        arr.push({
          id: r.id, content: r.content, importance: r.importance ?? undefined,
          recallCount: r.recall_count ?? 0, ts: r.created_at,
          vec: r.embedding ? unpackF32(r.embedding) : undefined,
        });
      }
      for (const arr of groups.values()) {
        for (const op of planConsolidation(arr, opts.dedupeThreshold)) {
          this.db.prepare('UPDATE memories SET importance = ?, recall_count = ? WHERE id = ?')
            .run(op.importance ?? null, op.recallCount, op.keepId);
          merged += this.db
            .prepare(`DELETE FROM memories WHERE id IN (${op.dropIds.map(() => '?').join(',')})`)
            .run(...op.dropIds).changes;
        }
      }
    }
    return { pruned, merged };
  }

  async update(input: UpdateInput): Promise<MemoryRecord | null> {
    // Author-scoped by default; admin (human curation) matches by (tenant, id) only.
    const guard = input.admin ? 'id = ? AND tenant = ?' : 'id = ? AND tenant = ? AND agent_id = ?';
    const guardArgs = input.admin ? [input.id, input.tenant] : [input.id, input.tenant, input.agentId];
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.content !== undefined) {
      sets.push('content = ?'); vals.push(input.content);
      const vec = this.embedder ? await this.embedder.embed(input.content) : null; // re-embed on content change
      if (vec) { sets.push('embedding = ?'); vals.push(packF32(vec)); }
    }
    if (input.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(input.tags)); }
    if (input.type !== undefined) { sets.push('type = ?'); vals.push(input.type); }
    if (input.importance !== undefined) { sets.push('importance = ?'); vals.push(input.importance); }
    if (sets.length) {
      const res = this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE ${guard}`).run(...vals, ...guardArgs);
      if (!res.changes) return null;
    }
    const row = this.db.prepare(`SELECT * FROM memories WHERE ${guard}`).get<MemoryRow>(...guardArgs);
    return row ? toRecord(row) : null;
  }

  async delete(input: DeleteInput): Promise<boolean> {
    const res = input.admin
      ? this.db.prepare('DELETE FROM memories WHERE id = ? AND tenant = ?').run(input.id, input.tenant)
      : this.db.prepare('DELETE FROM memories WHERE id = ? AND tenant = ? AND agent_id = ?').run(input.id, input.tenant, input.agentId);
    return res.changes > 0;
  }

  async forgetAgent(tenant: string, agentId: string): Promise<number> {
    // Private memories only; shared (scope='tenant') stays as company knowledge. FTS is kept in sync
    // by the AFTER DELETE trigger on `memories`.
    const res = this.db
      .prepare("DELETE FROM memories WHERE tenant = ? AND agent_id = ? AND scope = 'agent'")
      .run(tenant, agentId);
    return Number(res.changes);
  }

  async health(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get<{ n: number }>()!.n;
    const mode = this.embedder ? `hybrid:${this.embedder.label}` : 'keyword-only';
    return { ok: true, backend: 'sqlite', detail: `${n} memories (${mode})` };
  }
}

function toRecord(r: MemoryRow): MemoryRecord {
  return {
    id: r.id,
    tenant: r.tenant,
    agentId: r.agent_id,
    content: r.content,
    tags: JSON.parse(r.tags) as string[],
    type: (r.type ?? undefined) as MemoryRecord['type'],
    importance: r.importance ?? undefined,
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    ts: r.created_at,
    scope: (r.scope === 'tenant' ? 'tenant' : 'agent') as MemoryScope,
    recallCount: r.recall_count ?? 0,
    lastRecalledAt: r.last_recalled_at ?? undefined,
    // bm25 returns lower = better; flip the sign so a higher `score` means more relevant.
    score: r.rank !== undefined ? -r.rank : undefined,
  };
}
