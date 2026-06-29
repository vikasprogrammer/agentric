/**
 * Shared memory-recall helpers used by both the sqlite (in-JS cosine) and libsql (native vector)
 * backends: the embedding client, vector (de)serialization, cosine similarity, reciprocal-rank
 * fusion, and the FTS5 query sanitizer. Keeping them here means the two backends rank identically —
 * only WHERE the cosine runs differs (JavaScript vs. inside libSQL).
 */
import { EmbeddingsConfig, MemoryRanking, MemoryRecord } from '../types';

const RRF_K = 60; // reciprocal-rank-fusion damping; 60 is the conventional default.
const DAY_MS = 86_400_000;

/**
 * Re-rank a *scored* recall list by relevance × recency × importance, per a `MemoryRanking`. Returns
 * the input unchanged when ranking is off. A nudge, not a filter: weights are in (0,1], so they only
 * reorder. Pass only query results here — a no-query recency listing should rank by recency alone.
 */
export function rerank(records: MemoryRecord[], ranking: MemoryRanking | undefined, now: number): MemoryRecord[] {
  const half = ranking?.halfLifeDays && ranking.halfLifeDays > 0 ? ranking.halfLifeDays : 0;
  const byImportance = !!ranking?.weightByImportance;
  if (!half && !byImportance) return records;
  const ln2 = Math.log(2);
  return records
    .map((r) => {
      const base = Math.max(0, r.score ?? 0); // clamp: a negative (poor) match shouldn't flip sign under a weight
      let w = 1;
      if (byImportance) w *= 0.5 + 0.5 * Math.min(1, Math.max(0, r.importance ?? 0.5)); // unset → neutral 0.5
      if (half) w *= Math.exp((-ln2 * Math.max(0, now - r.ts)) / (half * DAY_MS)); // weight halves every `half` days
      return { ...r, score: base * w };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Blend two ranked lists with reciprocal rank fusion: score = Σ 1/(K + rank). Higher = better. */
export function fuse(lexical: MemoryRecord[], vector: MemoryRecord[]): MemoryRecord[] {
  const score = new Map<string, number>();
  const recs = new Map<string, MemoryRecord>();
  for (const list of [lexical, vector]) {
    list.forEach((rec, i) => {
      recs.set(rec.id, rec);
      score.set(rec.id, (score.get(rec.id) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  return [...recs.values()]
    .map((r) => ({ ...r, score: score.get(r.id) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: word tokens ORed as quoted terms
 * (quoting neutralises FTS5 operator characters). '' when no usable token (caller → recency).
 */
export function toFtsQuery(query?: string): string {
  if (!query) return '';
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || !tokens.length) return '';
  return [...new Set(tokens)].map((t) => `"${t}"`).join(' OR ');
}

/** A memory row reduced to what consolidation needs. `vec` present → eligible for near-dup merging. */
export interface ConsolidateRow {
  id: string;
  content: string;
  importance?: number;
  recallCount: number;
  ts: number;
  vec?: Float32Array;
}
/** One merge: keep `keepId`, delete `dropIds`, with the merged importance (max) + recallCount (sum). */
export interface MergeOp {
  keepId: string;
  dropIds: string[];
  importance?: number;
  recallCount: number;
}

/**
 * Plan duplicate merges within one agent's memories (pure — no I/O). Greedy: the highest-value row
 * (importance, then recall_count, then recency) anchors a cluster and absorbs later rows that are
 * either exact-content duplicates OR — when both carry a vector and `dedupeThreshold` is set —
 * cosine-similar at/above the threshold. Conservative: transitivity isn't chased (only similarity to
 * the anchor counts), and the anchor's content is kept verbatim. Returns only clusters with ≥1 drop.
 */
export function planConsolidation(rows: ConsolidateRow[], dedupeThreshold?: number): MergeOp[] {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const sorted = [...rows].sort((a, b) =>
    (b.importance ?? 0.5) - (a.importance ?? 0.5) || b.recallCount - a.recallCount || b.ts - a.ts);
  const taken = new Set<string>();
  const ops: MergeOp[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i];
    if (taken.has(anchor.id)) continue;
    const aContent = norm(anchor.content);
    const dups: ConsolidateRow[] = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const cand = sorted[j];
      if (taken.has(cand.id)) continue;
      const exact = norm(cand.content) === aContent;
      const near = dedupeThreshold != null && !!anchor.vec && !!cand.vec && cosine(anchor.vec, cand.vec) >= dedupeThreshold;
      if (exact || near) { dups.push(cand); taken.add(cand.id); }
    }
    if (dups.length) {
      taken.add(anchor.id);
      ops.push({
        keepId: anchor.id,
        dropIds: dups.map((d) => d.id),
        importance: Math.max(anchor.importance ?? 0.5, ...dups.map((d) => d.importance ?? 0.5)),
        recallCount: anchor.recallCount + dups.reduce((s, d) => s + d.recallCount, 0),
      });
    }
  }
  return ops;
}

/** Cosine similarity of two equal-length vectors (1 = identical direction, 0 = orthogonal). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** Pack an embedding into a little-endian Float32 BLOB for a sqlite `BLOB` column. */
export function packF32(vec: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vec).buffer);
}

/** Read a Float32 BLOB back into a vector. Copies, so a Buffer's offset/pooling can't corrupt it. */
export function unpackF32(blob: Uint8Array): Float32Array {
  const copy = blob.slice(); // detach from any shared/pooled ArrayBuffer
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

/**
 * Embedding client. Two lanes, same shape in/out:
 *   openai — POST {url}/embeddings  { model, input }  Bearer auth → data[0].embedding   (OpenAI, LM Studio, llamafile)
 *   ollama — POST {url}/api/embed   { model, input }  no auth     → embeddings[0]        (local, free, on-box)
 * embed() never throws — it returns null so recall/store degrade to lexical-only on any failure.
 */
export class Embedder {
  readonly dimensions: number;
  readonly label: string;
  private readonly provider: 'openai' | 'ollama';
  private readonly base: string;
  private static readonly TIMEOUT_MS = 8000;

  constructor(private readonly cfg: EmbeddingsConfig) {
    this.provider = cfg.provider ?? 'openai';
    this.dimensions = cfg.dimensions ?? 1536;
    this.base = cfg.url.replace(/\/$/, '');
    this.label = `${this.provider}:${cfg.model}`;
  }

  async embed(text: string): Promise<number[] | null> {
    try {
      return this.provider === 'ollama' ? await this.ollama(text) : await this.openai(text);
    } catch {
      return null;
    }
  }

  private async openai(text: string): Promise<number[]> {
    const body: Record<string, unknown> = { model: this.cfg.model, input: text };
    if (this.cfg.dimensions) body.dimensions = this.cfg.dimensions; // 3-series models can shorten output
    const json = await this.post(`${this.base}/embeddings`, body, this.cfg.apiKey);
    const v = (json as { data?: { embedding?: unknown }[] }).data?.[0]?.embedding;
    if (!Array.isArray(v)) throw new Error('no embedding in response');
    return v as number[];
  }

  private async ollama(text: string): Promise<number[]> {
    const json = await this.post(`${this.base}/api/embed`, { model: this.cfg.model, input: text });
    const j = json as { embeddings?: unknown[][]; embedding?: unknown[] };
    const v = j.embeddings?.[0] ?? j.embedding; // /api/embed → embeddings[]; older /api/embeddings → embedding
    if (!Array.isArray(v)) throw new Error('no embedding in response');
    return v as number[];
  }

  private async post(url: string, body: unknown, apiKey?: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Embedder.TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`embeddings ${url} → ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
