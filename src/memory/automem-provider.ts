/**
 * Automem memory provider — the upgrade backend: a thin REST client over an automem deployment
 * (Flask API in front of FalkorDB graph + Qdrant vectors), the same memory the CEO agent uses.
 *
 * We keep ONE shared automem collection and isolate by tag: every store adds `agent:<id>` +
 * `tenant:<t>`; a workspace-SHARED memory (`scope:'tenant'`) additionally carries `scope:tenant`.
 * Recall constrains by scope (`tag_mode=all`): own = agent+tenant, shared = scope:tenant+tenant, and
 * the default 'all' unions the two. So no per-agent container is needed and tenant-shared knowledge
 * (the gardener's output, cross-agent recall) works — the Phase-0 tenant-sharing follow-up, now done.
 *
 * NOTE: automem is an EXTERNAL store, so the OS wraps this provider in a MirroredMemoryProvider that
 * copies every write into the local `memories` table — that's what keeps Dreaming, the consolidation
 * gardener, and the Memory-hub counts (all of which read the local table directly) working. See mirror.ts.
 *
 * Endpoints used (see automem docs/API.md):
 *   POST /memory          { content, tags[], type, importance, metadata, timestamp } → { memory_id }
 *   GET  /recall?query=&tags=&tag_mode=all&limit=                                     → { results[] }
 *   GET  /health
 */
import { DeleteInput, MemoryProvider, MemoryRecord, MemoryScope, RecallQuery, StoreInput, UpdateInput } from '../types';

const TIMEOUT_MS = 8000;
/** Marks a tenant-shared memory in the single collection: recall for `scope:'tenant'` matches on it. */
const SHARED_TAG = 'scope:tenant';

export class AutomemMemoryProvider implements MemoryProvider {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(cfg: { endpoint: string; token: string }) {
    this.endpoint = cfg.endpoint.replace(/\/$/, '');
    this.token = cfg.token;
  }

  /** The implicit namespace tags that scope a single shared collection to one agent. */
  private ns(agentId: string, tenant: string): string[] {
    return [`agent:${agentId}`, `tenant:${tenant}`];
  }

  async store(input: StoreInput): Promise<MemoryRecord> {
    const scope: MemoryScope = input.scope ?? 'agent';
    // Always tag agent (author provenance) + tenant; a SHARED memory ALSO carries `scope:tenant` so
    // other agents can recall it without the author filter. (Phase-0 tenant-sharing, now implemented.)
    const tags = [...(input.tags ?? []), ...this.ns(input.agentId, input.tenant)];
    if (scope === 'tenant') tags.push(SHARED_TAG);
    const ts = Date.now();
    const body = {
      content: input.content,
      tags,
      type: input.type,
      importance: input.importance,
      metadata: input.metadata,
      timestamp: new Date(ts).toISOString(),
    };
    const res = await this.req('POST', '/memory', undefined, body);
    return {
      id: String((res as { memory_id?: string }).memory_id ?? ''),
      tenant: input.tenant,
      agentId: input.agentId,
      content: input.content,
      tags,
      type: input.type,
      importance: input.importance,
      metadata: input.metadata,
      ts,
      scope,
    };
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const limit = Math.max(1, Math.min(q.limit ?? 8, 100));
    const scope = q.scope ?? 'all';
    const own = [...(q.tags ?? []), ...this.ns(q.agentId, q.tenant)];
    const shared = [...(q.tags ?? []), `tenant:${q.tenant}`, SHARED_TAG];
    if (scope === 'agent') return this.recallByTags(q, own, limit);
    if (scope === 'tenant') return this.recallByTags(q, shared, limit);
    // 'all' = the agent's own ∪ the tenant's shared. automem's `tag_mode=all` can't express OR, so we
    // union two constrained calls, dedupe by id, and re-rank by score.
    const [a, b] = await Promise.all([this.recallByTags(q, own, limit), this.recallByTags(q, shared, limit)]);
    const seen = new Set<string>();
    const merged: MemoryRecord[] = [];
    for (const r of [...a, ...b]) {
      if (r.id && seen.has(r.id)) continue;
      if (r.id) seen.add(r.id);
      merged.push(r);
    }
    merged.sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    return merged.slice(0, limit);
  }

  /** One `/recall` call constrained to `tags` (tag_mode=all), mapped to records. */
  private async recallByTags(q: RecallQuery, tags: string[], limit: number): Promise<MemoryRecord[]> {
    const params = new URLSearchParams();
    if (q.query) params.set('query', q.query);
    params.set('limit', String(limit));
    params.set('tag_mode', 'all');
    for (const t of tags) params.append('tags', t);
    const res = (await this.req('GET', '/recall', params)) as { results?: AutomemResult[] };
    return (res.results ?? []).map((r) => this.mapResult(r, q.tenant, r.id, q.agentId));
  }

  /** Map an automem result to a MemoryRecord; author + scope are recovered from the namespace tags. */
  private mapResult(r: AutomemResult, tenant: string, id: unknown, querier: string): MemoryRecord {
    const m = r.memory ?? {};
    const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
    const authorTag = tags.find((t) => t.startsWith('agent:'));
    return {
      id: String(id ?? m.id ?? ''),
      tenant,
      agentId: authorTag ? authorTag.slice('agent:'.length) : querier, // author provenance from the tag
      content: String(m.content ?? ''),
      tags,
      type: m.type as MemoryRecord['type'],
      importance: typeof m.importance === 'number' ? m.importance : undefined,
      metadata: (m.metadata as Record<string, unknown> | undefined) ?? undefined,
      ts: m.timestamp ? Date.parse(String(m.timestamp)) : Date.now(),
      scope: tags.includes(SHARED_TAG) ? 'tenant' : 'agent',
      score: typeof r.final_score === 'number' ? r.final_score : undefined,
    };
  }

  async update(input: UpdateInput): Promise<MemoryRecord | null> {
    const existing = await this.fetchOwned(input.id, input.agentId, input.tenant, input.admin);
    if (!existing) return null;
    const body: Record<string, unknown> = {};
    if (input.content !== undefined) body.content = input.content;
    if (input.type !== undefined) body.type = input.type;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.tags !== undefined) {
      // Re-attach the namespace + preserve the shared marker so a tag edit can't silently un-share it.
      const authorTag = existing.tags.find((t) => t.startsWith('agent:')) ?? `agent:${existing.agentId}`;
      const next = [...input.tags, authorTag, `tenant:${input.tenant}`];
      if (existing.scope === 'tenant') next.push(SHARED_TAG);
      body.tags = next;
    }
    if (Object.keys(body).length) await this.req('PATCH', `/memory/${input.id}`, undefined, body);
    return {
      ...existing,
      content: input.content ?? existing.content,
      tags: (body.tags as string[] | undefined) ?? existing.tags,
      type: input.type ?? existing.type,
      importance: input.importance ?? existing.importance,
    };
  }

  async delete(input: DeleteInput): Promise<boolean> {
    if (!(await this.fetchOwned(input.id, input.agentId, input.tenant, input.admin))) return false;
    await this.req('DELETE', `/memory/${input.id}`);
    return true;
  }

  /**
   * Fetch a memory by id, guarding authorship: it must carry this `tenant:` tag, and — unless `admin`
   * (human curation) — this agent's `agent:` tag. Returns null when the guard fails (not ours / unknown).
   */
  private async fetchOwned(id: string, agentId: string, tenant: string, admin = false): Promise<MemoryRecord | null> {
    let res: unknown;
    try {
      res = await this.req('GET', `/memory/${id}`);
    } catch {
      return null;
    }
    const m = (res as { memory?: AutomemResult['memory'] }).memory ?? (res as AutomemResult['memory']);
    if (!m) return null;
    const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
    if (!tags.includes(`tenant:${tenant}`)) return null;
    if (!admin && !tags.includes(`agent:${agentId}`)) return null;
    const authorTag = tags.find((t) => t.startsWith('agent:'));
    return {
      id, tenant,
      agentId: authorTag ? authorTag.slice('agent:'.length) : agentId,
      content: String(m.content ?? ''),
      tags,
      type: m.type as MemoryRecord['type'],
      importance: typeof m.importance === 'number' ? m.importance : undefined,
      metadata: (m.metadata as Record<string, unknown> | undefined) ?? undefined,
      ts: m.timestamp ? Date.parse(String(m.timestamp)) : Date.now(),
      scope: tags.includes(SHARED_TAG) ? 'tenant' : 'agent',
    };
  }

  /** Whole-instance memory count from /health (exact per-tenant on a dedicated instance). */
  async count(): Promise<number | null> {
    try {
      const res = (await this.req('GET', '/health')) as { memory_count?: number };
      return typeof res.memory_count === 'number' ? res.memory_count : null;
    } catch {
      return null;
    }
  }

  async health(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    let count: number | undefined;
    try {
      const res = (await this.req('GET', '/health')) as { status?: string; memory_count?: number };
      if (res.status !== 'healthy') return { ok: false, backend: 'automem', detail: `unhealthy @ ${this.endpoint}` };
      count = res.memory_count;
    } catch (e) {
      return { ok: false, backend: 'automem', detail: e instanceof Error ? e.message : String(e) };
    }
    // `/health` is UNAUTHENTICATED on automem, so a wrong/stale token still reports "healthy" here — and only
    // surfaces as a 401 on the first authenticated write (store / migrate). Validate the token with a cheap
    // authenticated read so a bad token fails loudly at Test/health time (green badge, Settings → Test, the
    // drift banner) instead of mid-migration as an opaque `store failed → 401`.
    try {
      await this.req('GET', '/recall', new URLSearchParams({ limit: '1' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Only a 401 means the token is bad; any other read quirk (e.g. a query-less 400) shouldn't mask a live
      // server that `/health` already confirmed up.
      if (msg.includes('→ 401')) return { ok: false, backend: 'automem', detail: 'token rejected (401) — check the token in Settings → Memory' };
    }
    return { ok: true, backend: 'automem', detail: `${count ?? '?'} memories @ ${this.endpoint}` };
  }

  private async req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathName: string, params?: URLSearchParams, body?: unknown): Promise<unknown> {
    const url = this.endpoint + pathName + (params ? `?${params}` : '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`automem ${method} ${pathName} → ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

interface AutomemResult {
  id?: string;
  final_score?: number;
  memory?: {
    id?: string;
    content?: string;
    tags?: unknown[];
    type?: string;
    importance?: number;
    metadata?: unknown;
    timestamp?: string;
  };
}
