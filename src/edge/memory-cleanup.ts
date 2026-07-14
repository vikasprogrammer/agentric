/**
 * Memory improvement tile — **"generate the fix" for the memory plane** (Memory domain of Insights v2).
 *
 * The tile detects noise (never-recalled aged memories + duplicates); this turns that into a REVIEWABLE
 * cleanup: a deterministic **preview** of exactly what a maintenance pass would prune + merge, so an owner
 * eyeballs it before anything is deleted — then **applies** it. The blind `os.memory.maintain` (Settings →
 * Memory) deletes on a schedule with no preview; this is the review-gated, on-demand counterpart.
 *
 * Pure over the local `memories` table (the SQL readers' source of truth — Dreaming/consolidation read it
 * the same way, and the mirror keeps it populated under an external backend), reusing `planConsolidation`
 * and mirroring `maintain`'s prune + merge SQL so preview and apply agree exactly. No LLM: pruning and
 * dedupe are a query + cosine, so unlike the Agents CLAUDE.md rewrite this needs no spawned agent.
 */
import type { AgentOS } from '../kernel';
import type { MemoryMaintenance } from '../types';
import { planConsolidation, unpackF32, type ConsolidateRow } from '../memory/embedding';

const DAY = 86_400_000;
const SAMPLE = 8; // items shown per section for eyeballing (apply acts on the FULL set, not the sample)

export interface CleanupOpts { pruneAfterDays: number; keepImportance: number; dedupeThreshold?: number }
export interface PruneItem { id: string; agent: string; snippet: string; ageDays: number; importance: number | null }
export interface MergeGroup { agent: string; keepSnippet: string; drop: number }
export interface MemoryCleanupPlan {
  opts: CleanupOpts;
  prune: { total: number; sample: PruneItem[] };
  merge: { groups: number; drops: number; sample: MergeGroup[] };
}

interface Row { id: string; agent_id: string; content: string; importance: number | null; recall_count: number; created_at: number; embedding: Uint8Array | null }

/** Resolve the cleanup policy: the saved maintenance config where set, else safe defaults (30d / 0.5). */
export function cleanupOpts(os: AgentOS): CleanupOpts {
  const m = os.settings.memoryConfig()?.maintenance;
  return {
    pruneAfterDays: m?.pruneAfterDays && m.pruneAfterDays > 0 ? m.pruneAfterDays : 30,
    keepImportance: m?.keepImportance ?? 0.5,
    dedupeThreshold: m?.dedupeThreshold ?? undefined, // undefined → exact-content duplicates only
  };
}

function snippet(s: string, n = 90): string {
  const one = s.trim().replace(/\s+/g, ' ');
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Compute the prune list + merge groups for this tenant WITHOUT mutating anything (the review artifact). */
export function planMemoryCleanup(os: AgentOS, opts = cleanupOpts(os), now = Date.now()): MemoryCleanupPlan {
  const db = os.db;
  const cutoff = now - opts.pruneAfterDays * DAY;
  const pruneRows = db
    .prepare('SELECT id, agent_id, content, importance, created_at FROM memories WHERE tenant = ? AND created_at < ? AND recall_count = 0 AND (importance IS NULL OR importance < ?) ORDER BY created_at')
    .all<Row>(os.tenant, cutoff, opts.keepImportance);
  const prune = {
    total: pruneRows.length,
    sample: pruneRows.slice(0, SAMPLE).map((r) => ({
      id: r.id, agent: r.agent_id, snippet: snippet(r.content),
      ageDays: Math.floor((now - r.created_at) / DAY), importance: r.importance,
    })),
  };

  // Merge groups, per agent (matches maintain's per-(tenant,agent) grouping). The pruned rows are excluded
  // so we never propose merging something that's about to be deleted.
  const pruneSet = new Set(pruneRows.map((r) => r.id));
  const rows = db
    .prepare('SELECT id, agent_id, content, importance, recall_count, created_at, embedding FROM memories WHERE tenant = ?')
    .all<Row>(os.tenant);
  const byAgent = new Map<string, Row[]>();
  for (const r of rows) {
    if (pruneSet.has(r.id)) continue;
    const arr = byAgent.get(r.agent_id) ?? [];
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, arr);
    arr.push(r);
  }
  const groups: MergeGroup[] = [];
  let drops = 0;
  for (const [agent, arr] of byAgent) {
    const consolidate: ConsolidateRow[] = arr.map((r) => ({
      id: r.id, content: r.content, importance: r.importance ?? undefined,
      recallCount: r.recall_count ?? 0, ts: r.created_at,
      vec: r.embedding ? unpackF32(r.embedding) : undefined,
    }));
    const byId = new Map(arr.map((r) => [r.id, r]));
    for (const op of planConsolidation(consolidate, opts.dedupeThreshold)) {
      drops += op.dropIds.length;
      groups.push({ agent, keepSnippet: snippet(byId.get(op.keepId)?.content ?? ''), drop: op.dropIds.length });
    }
  }
  groups.sort((a, b) => b.drop - a.drop);
  return { opts, prune, merge: { groups: groups.length, drops, sample: groups.slice(0, SAMPLE) } };
}

/** Execute the cleanup for real — same SQL as `maintain`, but scoped to this tenant + audited distinctly. */
export function applyMemoryCleanup(os: AgentOS, opts = cleanupOpts(os), by = 'system', now = Date.now()): { pruned: number; merged: number } {
  const db = os.db;
  let pruned = 0;
  let merged = 0;

  const cutoff = now - opts.pruneAfterDays * DAY;
  pruned = db
    .prepare('DELETE FROM memories WHERE tenant = ? AND created_at < ? AND recall_count = 0 AND (importance IS NULL OR importance < ?)')
    .run(os.tenant, cutoff, opts.keepImportance).changes;

  const rows = db
    .prepare('SELECT id, agent_id, content, importance, recall_count, created_at, embedding FROM memories WHERE tenant = ?')
    .all<Row>(os.tenant);
  const byAgent = new Map<string, ConsolidateRow[]>();
  for (const r of rows) {
    const arr = byAgent.get(r.agent_id) ?? [];
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, arr);
    arr.push({
      id: r.id, content: r.content, importance: r.importance ?? undefined,
      recallCount: r.recall_count ?? 0, ts: r.created_at,
      vec: r.embedding ? unpackF32(r.embedding) : undefined,
    });
  }
  for (const arr of byAgent.values()) {
    for (const op of planConsolidation(arr, opts.dedupeThreshold)) {
      db.prepare('UPDATE memories SET importance = ?, recall_count = ? WHERE id = ?').run(op.importance ?? null, op.recallCount, op.keepId);
      merged += db.prepare(`DELETE FROM memories WHERE id IN (${op.dropIds.map(() => '?').join(',')})`).run(...op.dropIds).changes;
    }
  }
  if (pruned || merged) {
    os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: by, type: 'memory.maintained', data: { pruned, merged, via: 'insights-cleanup', opts } });
  }
  return { pruned, merged };
}
