/**
 * libSQL memory provider — the local semantic backend.
 *
 * libSQL (Turso's production C fork of SQLite) ships native vector search IN THE FILE:
 * `vector32()` parses an embedding into an `F32_BLOB`, `vector_distance_cos()` ranks by meaning.
 * So this backend gives an agent BOTH lexical recall (FTS5 bm25, like the sqlite backend) AND
 * semantic recall (nearest embeddings) out of one local `.db` file — no Qdrant/FalkorDB container,
 * the thing that otherwise pushes you to automem.
 *
 * Embeddings are pluggable and OPTIONAL. Configure `embeddings` to vectorize content+query via an
 * OpenAI-compatible API (OpenAI, LM Studio, llamafile…) or a local Ollama. Omit it and recall
 * degrades to pure bm25 — identical behaviour to the sqlite backend, just on a libSQL file.
 *
 * Recall is HYBRID: run bm25 and cosine independently, then blend their rankings with reciprocal
 * rank fusion (RRF) — keyword precision for IDs/error-codes, semantic reach for synonyms.
 *
 * Isolation: every query is scoped by (tenant, agent_id), so an agent only ever sees its own.
 *
 * `@libsql/client` is an OPTIONAL dependency, lazily imported only when this backend is selected —
 * the core stays zero-dependency. If the backend is chosen without it installed, init throws with
 * an install hint.
 */
import { randomUUID } from 'crypto';
import {
  DeleteInput, LibsqlMemoryConfig, MemoryMaintenance, MemoryMaintenanceResult, MemoryProvider,
  MemoryRanking, MemoryRecord, RecallQuery, StoreInput, UpdateInput,
} from '../types';
import { ConsolidateRow, Embedder, fuse, planConsolidation, rerank, toFtsQuery } from './embedding';

/** The subset of `@libsql/client` we use — declared locally so typecheck passes without the dep. */
interface LibsqlClient {
  execute(stmt: { sql: string; args?: unknown[] } | string): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }>;
  executeMultiple(sql: string): Promise<void>;
  close(): void;
}

/** All scalar columns of a memory row (no embedding blob — we never ship it back out). */
const COLS = 'id, tenant, agent_id, content, tags, type, importance, metadata, created_at, scope';

/** Visibility predicate for recall: own rows, shared rows, or both (default). Mirrors the sqlite backend. */
function scopeWhere(q: RecallQuery, p = ''): { sql: string; args: unknown[] } {
  const scope = q.scope ?? 'all';
  if (scope === 'agent') return { sql: `${p}tenant = ? AND ${p}agent_id = ?`, args: [q.tenant, q.agentId] };
  if (scope === 'tenant') return { sql: `${p}tenant = ? AND ${p}scope = 'tenant'`, args: [q.tenant] };
  return { sql: `${p}tenant = ? AND (${p}agent_id = ? OR ${p}scope = 'tenant')`, args: [q.tenant, q.agentId] };
}

export class LibsqlMemoryProvider implements MemoryProvider {
  private client: LibsqlClient | null = null;
  private readonly embedder?: Embedder;
  private readonly dim: number;
  private ready?: Promise<void>;

  constructor(private readonly cfg: LibsqlMemoryConfig, private readonly ranking?: MemoryRanking) {
    if (cfg.embeddings) this.embedder = new Embedder(cfg.embeddings);
    // Vector column width is fixed at table-creation; keep it stable across runs.
    this.dim = Math.max(1, Math.floor(this.embedder?.dimensions ?? 1536));
  }

  /** Lazily import the client and create the schema, exactly once. */
  private init(): Promise<void> {
    if (!this.ready) this.ready = this.doInit();
    return this.ready;
  }

  private async doInit(): Promise<void> {
    let createClient: (cfg: { url: string; authToken?: string }) => LibsqlClient;
    try {
      const pkg = '@libsql/client'; // variable specifier → not resolved at compile time (stays zero-dep)
      ({ createClient } = (await import(pkg)) as { createClient: typeof createClient });
    } catch {
      throw new Error("memory.backend=libsql needs the optional '@libsql/client' package — run: npm install @libsql/client");
    }
    this.client = createClient({ url: this.cfg.url, authToken: this.cfg.authToken });
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL,
        type TEXT,
        importance REAL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        scope TEXT NOT NULL DEFAULT 'agent',
        embedding F32_BLOB(${this.dim})
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(tenant, agent_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, tags, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
    `);
  }

  private db(): LibsqlClient {
    if (!this.client) throw new Error('libsql memory provider not initialised');
    return this.client;
  }

  async store(input: StoreInput): Promise<MemoryRecord> {
    await this.init();
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
    const vec = await this.embedder?.embed(rec.content);
    const base = [
      rec.id, rec.tenant, rec.agentId, rec.content, JSON.stringify(rec.tags),
      rec.type ?? null, rec.importance ?? null,
      rec.metadata !== undefined ? JSON.stringify(rec.metadata) : null, rec.ts, rec.scope,
    ];
    // vector32(?) parses the JSON array text into the F32_BLOB; NULL when we have no embedding.
    const sql = vec
      ? `INSERT INTO memories (${COLS}, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?))`
      : `INSERT INTO memories (${COLS}, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    await this.db().execute({ sql, args: [...base, vec ? JSON.stringify(vec) : null] });
    return rec;
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    await this.init();
    const limit = Math.max(1, Math.min(q.limit ?? 8, 100));
    // Over-fetch so an optional tag filter (applied in JS) still returns up to `limit`.
    const fetchN = q.tags?.length ? limit * 5 : limit;

    // Visibility: by default own rows ∪ tenant-shared rows.
    const vis = scopeWhere(q);
    const visM = scopeWhere(q, 'm.');

    const match = toFtsQuery(q.query);
    if (!match) {
      // No usable query text → most recent visible rows (cosine needs a query to compare against).
      const rs = await this.db().execute({
        sql: `SELECT ${COLS} FROM memories WHERE ${vis.sql} ORDER BY created_at DESC LIMIT ?`,
        args: [...vis.args, fetchN],
      });
      return this.tagFilter(rs.rows.map(mapRow), q.tags).slice(0, limit);
    }

    // Lexical list (bm25). Always available.
    const lexRs = await this.db().execute({
      sql: `SELECT ${COLS.split(', ').map((c) => `m.${c}`).join(', ')}, bm25(memories_fts) AS rank
              FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
             WHERE memories_fts MATCH ? AND ${visM.sql}
             ORDER BY rank LIMIT ?`,
      args: [match, ...visM.args, fetchN],
    });
    const lexical = lexRs.rows.map(mapRow);

    // Semantic list (cosine), only when an embedder is configured and the query embeds successfully.
    let vector: MemoryRecord[] = [];
    const qvec = q.query ? await this.embedder?.embed(q.query) : undefined;
    if (qvec) {
      const vecRs = await this.db().execute({
        sql: `SELECT ${COLS.split(', ').map((c) => `m.${c}`).join(', ')},
                     vector_distance_cos(m.embedding, vector32(?)) AS dist
                FROM memories m
               WHERE ${visM.sql} AND m.embedding IS NOT NULL
               ORDER BY dist ASC LIMIT ?`,
        args: [JSON.stringify(qvec), ...visM.args, fetchN],
      });
      vector = vecRs.rows.map(mapRow);
    }

    const merged = rerank(vector.length ? fuse(lexical, vector) : lexical, this.ranking, Date.now());
    const out = this.tagFilter(merged, q.tags).slice(0, limit);
    // Usage tracking (this branch always has a query) — count what a real query surfaced.
    if (out.length) {
      const ids = out.map((r) => r.id);
      await this.db().execute({
        sql: `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        args: [Date.now(), ...ids],
      });
    }
    return out;
  }

  async maintain(opts: MemoryMaintenance): Promise<MemoryMaintenanceResult> {
    await this.init();
    let pruned = 0;
    let merged = 0;
    if (opts.pruneAfterDays && opts.pruneAfterDays > 0) {
      const cutoff = Date.now() - opts.pruneAfterDays * 86_400_000;
      const keep = opts.keepImportance ?? 0.5;
      const res = await this.db().execute({
        sql: 'DELETE FROM memories WHERE created_at < ? AND recall_count = 0 AND (importance IS NULL OR importance < ?)',
        args: [cutoff, keep],
      });
      pruned = res.rowsAffected;
    }
    if (opts.dedupeThreshold != null) {
      // Exact-content consolidation only here — near-dup needs the in-engine vectors loaded to JS
      // (deferred; sqlite is the near-dup path). No embeddings → planner merges identical text only.
      const rs = await this.db().execute('SELECT id, tenant, agent_id, content, importance, recall_count, created_at, scope FROM memories');
      const groups = new Map<string, ConsolidateRow[]>();
      for (const r of rs.rows) {
        const key = `${String(r.tenant)} ${String(r.agent_id)} ${String(r.scope)}`; // by scope too: private + shared never merge
        const arr = groups.get(key) ?? [];
        if (!groups.has(key)) groups.set(key, arr);
        arr.push({
          id: String(r.id), content: String(r.content ?? ''),
          importance: r.importance == null ? undefined : Number(r.importance),
          recallCount: Number(r.recall_count ?? 0), ts: Number(r.created_at),
        });
      }
      for (const arr of groups.values()) {
        for (const op of planConsolidation(arr)) {
          await this.db().execute({ sql: 'UPDATE memories SET importance = ?, recall_count = ? WHERE id = ?', args: [op.importance ?? null, op.recallCount, op.keepId] });
          const res = await this.db().execute({ sql: `DELETE FROM memories WHERE id IN (${op.dropIds.map(() => '?').join(',')})`, args: op.dropIds });
          merged += res.rowsAffected;
        }
      }
    }
    return { pruned, merged };
  }

  async update(input: UpdateInput): Promise<MemoryRecord | null> {
    await this.init();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (input.content !== undefined) {
      sets.push('content = ?'); vals.push(input.content);
      const vec = await this.embedder?.embed(input.content); // re-embed when the text changes
      if (vec) { sets.push('embedding = vector32(?)'); vals.push(JSON.stringify(vec)); }
    }
    if (input.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(input.tags)); }
    if (input.type !== undefined) { sets.push('type = ?'); vals.push(input.type); }
    if (input.importance !== undefined) { sets.push('importance = ?'); vals.push(input.importance); }
    // Author-scoped by default; admin (human curation) matches by (tenant, id) only.
    const guard = input.admin ? 'id = ? AND tenant = ?' : 'id = ? AND tenant = ? AND agent_id = ?';
    const guardArgs = input.admin ? [input.id, input.tenant] : [input.id, input.tenant, input.agentId];
    if (sets.length) {
      const res = await this.db().execute({ sql: `UPDATE memories SET ${sets.join(', ')} WHERE ${guard}`, args: [...vals, ...guardArgs] });
      if (!res.rowsAffected) return null;
    }
    const rs = await this.db().execute({ sql: `SELECT ${COLS} FROM memories WHERE ${guard}`, args: guardArgs });
    return rs.rows[0] ? mapRow(rs.rows[0]) : null;
  }

  async delete(input: DeleteInput): Promise<boolean> {
    await this.init();
    const res = input.admin
      ? await this.db().execute({ sql: 'DELETE FROM memories WHERE id = ? AND tenant = ?', args: [input.id, input.tenant] })
      : await this.db().execute({ sql: 'DELETE FROM memories WHERE id = ? AND tenant = ? AND agent_id = ?', args: [input.id, input.tenant, input.agentId] });
    return res.rowsAffected > 0;
  }

  async forgetAgent(tenant: string, agentId: string): Promise<number> {
    await this.init();
    // Private memories only; shared (scope='tenant') stays as company knowledge.
    const res = await this.db().execute({ sql: "DELETE FROM memories WHERE tenant = ? AND agent_id = ? AND scope = 'agent'", args: [tenant, agentId] });
    return res.rowsAffected ?? 0;
  }

  async health(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    try {
      await this.init();
      const rs = await this.db().execute('SELECT COUNT(*) AS n FROM memories');
      const n = Number(rs.rows[0]?.n ?? 0);
      const mode = this.embedder ? `hybrid:${this.embedder.label}` : 'lexical-only';
      return { ok: true, backend: 'libsql', detail: `${n} memories @ ${this.cfg.url} (${mode})` };
    } catch (e) {
      return { ok: false, backend: 'libsql', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private tagFilter(recs: MemoryRecord[], tags?: string[]): MemoryRecord[] {
    if (!tags?.length) return recs;
    const want = new Set(tags);
    return recs.filter((r) => r.tags.some((t) => want.has(t)));
  }
}

function mapRow(r: Record<string, unknown>): MemoryRecord {
  return {
    id: String(r.id),
    tenant: String(r.tenant),
    agentId: String(r.agent_id),
    content: String(r.content ?? ''),
    tags: r.tags ? (JSON.parse(String(r.tags)) as string[]) : [],
    type: (r.type ?? undefined) as MemoryRecord['type'],
    importance: r.importance == null ? undefined : Number(r.importance),
    metadata: r.metadata ? (JSON.parse(String(r.metadata)) as Record<string, unknown>) : undefined,
    ts: Number(r.created_at),
    scope: r.scope === 'tenant' ? 'tenant' : 'agent',
  };
}
