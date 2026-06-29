/**
 * Automem memory provider — the upgrade backend: a thin REST client over an automem deployment
 * (Flask API in front of FalkorDB graph + Qdrant vectors), the same memory the CEO agent uses.
 *
 * We keep ONE shared automem collection and isolate agents by tag: every store adds
 * `agent:<id>` + `tenant:<t>`, and every recall constrains to them (`tag_mode=all`, prefix
 * match) — so no per-agent container is needed. Verified against the live deployment.
 *
 * Endpoints used (see automem docs/API.md):
 *   POST /memory          { content, tags[], type, importance, metadata, timestamp } → { memory_id }
 *   GET  /recall?query=&tags=&tag_mode=all&limit=                                     → { results[] }
 *   GET  /health
 */
import { DeleteInput, MemoryProvider, MemoryRecord, RecallQuery, StoreInput, UpdateInput } from '../types';

const TIMEOUT_MS = 8000;

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
    const tags = [...(input.tags ?? []), ...this.ns(input.agentId, input.tenant)];
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
      // Scope isolation on automem is tag-based and still tracked as agent-private (tenant sharing is a
      // deferred Phase-0 follow-up: write without the agent tag + recall without the agent filter).
      scope: input.scope ?? 'agent',
    };
  }

  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const params = new URLSearchParams();
    if (q.query) params.set('query', q.query);
    params.set('limit', String(Math.max(1, Math.min(q.limit ?? 8, 100))));
    params.set('tag_mode', 'all');
    for (const t of [...(q.tags ?? []), ...this.ns(q.agentId, q.tenant)]) params.append('tags', t);

    const res = (await this.req('GET', '/recall', params)) as { results?: AutomemResult[] };
    return (res.results ?? []).map((r) => {
      const m = r.memory ?? {};
      return {
        id: String(r.id ?? m.id ?? ''),
        tenant: q.tenant,
        agentId: q.agentId,
        content: String(m.content ?? ''),
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
        type: m.type as MemoryRecord['type'],
        importance: typeof m.importance === 'number' ? m.importance : undefined,
        metadata: (m.metadata as Record<string, unknown> | undefined) ?? undefined,
        ts: m.timestamp ? Date.parse(String(m.timestamp)) : Date.now(),
        scope: 'agent',
        score: typeof r.final_score === 'number' ? r.final_score : undefined,
      };
    });
  }

  async update(input: UpdateInput): Promise<MemoryRecord | null> {
    const existing = await this.fetchOwned(input.id, input.agentId, input.tenant);
    if (!existing) return null;
    const body: Record<string, unknown> = {};
    if (input.content !== undefined) body.content = input.content;
    if (input.type !== undefined) body.type = input.type;
    if (input.importance !== undefined) body.importance = input.importance;
    if (input.tags !== undefined) body.tags = [...input.tags, ...this.ns(input.agentId, input.tenant)];
    if (Object.keys(body).length) await this.req('PATCH', `/memory/${input.id}`, undefined, body);
    return {
      ...existing,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      type: input.type ?? existing.type,
      importance: input.importance ?? existing.importance,
    };
  }

  async delete(input: DeleteInput): Promise<boolean> {
    if (!(await this.fetchOwned(input.id, input.agentId, input.tenant))) return false;
    await this.req('DELETE', `/memory/${input.id}`);
    return true;
  }

  /** Fetch a memory by id only if it carries this agent's namespace tags — else null (not ours). */
  private async fetchOwned(id: string, agentId: string, tenant: string): Promise<MemoryRecord | null> {
    let res: unknown;
    try {
      res = await this.req('GET', `/memory/${id}`);
    } catch {
      return null;
    }
    const m = (res as { memory?: AutomemResult['memory'] }).memory ?? (res as AutomemResult['memory']);
    if (!m) return null;
    const tags = Array.isArray(m.tags) ? m.tags.map(String) : [];
    if (!tags.includes(`agent:${agentId}`) || !tags.includes(`tenant:${tenant}`)) return null;
    return {
      id, tenant, agentId,
      content: String(m.content ?? ''),
      tags,
      type: m.type as MemoryRecord['type'],
      importance: typeof m.importance === 'number' ? m.importance : undefined,
      metadata: (m.metadata as Record<string, unknown> | undefined) ?? undefined,
      ts: m.timestamp ? Date.parse(String(m.timestamp)) : Date.now(),
      scope: 'agent',
    };
  }

  async health(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    try {
      const res = (await this.req('GET', '/health')) as { status?: string; memory_count?: number };
      return { ok: res.status === 'healthy', backend: 'automem', detail: `${res.memory_count ?? '?'} memories @ ${this.endpoint}` };
    } catch (e) {
      return { ok: false, backend: 'automem', detail: e instanceof Error ? e.message : String(e) };
    }
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
