/**
 * MirroredMemoryProvider — the decoupling seam that lets a non-SQLite recall backend (automem /
 * libsql) coexist with the OS's own SQL-level machinery.
 *
 * The problem: parts of the OS read the local `memories` table DIRECTLY, not through the
 * MemoryProvider interface — the Dreaming pass (`src/edge/dreaming.ts`) scans episodes, the
 * consolidation gardener (`src/edge/consolidation.ts`) scans episodes + lessons, and the Memory-hub
 * overview counts (`GET /api/memory/overview`) tally memories/episodes/lessons/shared. If the recall
 * backend is anything other than SQLite, those writes land in the external store and the local table
 * is empty — so the whole self-learning loop goes dark.
 *
 * The fix (no rewrite of every reader): keep RECALL on the real backend (its whole point — better
 * hybrid/graph retrieval), but MIRROR every write into the local `memories` table via a bare
 * SqliteMemoryProvider. The self-learning loop and console counts then work under any backend, while
 * agents still recall from the upgraded store. When the backend already IS SQLite the provider *is*
 * the local table, so the factory skips the wrapper entirely (no double-writes).
 *
 * The mirror is best-effort: a mirror failure never fails the underlying store/recall. Ids and
 * timestamps are preserved (we mirror the record the backend RETURNS, not the input), so revise/forget
 * stay aligned by id. Maintenance prunes the local mirror with the same policy the backend self-applies.
 */
import {
  DeleteInput, MemoryMaintenance, MemoryMaintenanceResult, MemoryProvider, MemoryRecord,
  RecallQuery, StoreInput, UpdateInput,
} from '../types';
import { SqliteMemoryProvider } from './sqlite-provider';

export class MirroredMemoryProvider implements MemoryProvider {
  constructor(private readonly backend: MemoryProvider, private readonly mirror: SqliteMemoryProvider) {}

  async store(input: StoreInput): Promise<MemoryRecord> {
    const rec = await this.backend.store(input);
    try { this.mirror.insertRecord(rec); } catch { /* mirror is best-effort */ }
    return rec;
  }

  /**
   * Recall is the backend's job — the reason to run a non-SQLite store at all. But the reinforcement
   * signal (recall_count/last_recalled_at) lands only in the external store, while the OS's SQL-level
   * machinery — prune, Dreaming, consolidation, the Memory-hub counts — reads the local mirror table.
   * So we mirror the usage bump too: reinforce the returned ids in the mirror (same gate as the sqlite
   * provider — a real query with results, not a blank recency listing). Without this the mirror shows
   * EVERY memory as never-recalled forever, and `maintain()`'s prune (`WHERE recall_count = 0`) could
   * delete memories recalled hundreds of times in the backend. Best-effort: never fail a recall.
   */
  async recall(q: RecallQuery): Promise<MemoryRecord[]> {
    const out = await this.backend.recall(q);
    if (q.query && out.length) {
      try { this.mirror.reinforce(out.map((r) => r.id)); } catch { /* mirror is best-effort */ }
    }
    return this.withCanonicalContent(out);
  }

  /**
   * The backend RANKS; the mirror is the record of what the agent actually wrote.
   *
   * A recall backend is free to transform the text it was handed, and automem does: over
   * `MEMORY_CONTENT_SOFT_LIMIT` (500 chars by default) with an LLM configured, `MEMORY_AUTO_SUMMARIZE`
   * replaces `content` with a ~300-char LLM summary and DISCARDS the original. On the live instawp
   * tenant — average memory 1305 chars — that hit most of the store: 81% of sampled recall hits existed
   * nowhere in the mirror, and the specifics that made them useful were gone. What an agent stored as
   *
   *   "Bunny edge-rule QA cannot be done on a *.instawp.site sandbox — it resolves to the PPU/OVH origin
   *    and never traverses Bunny's edge, so every probe returns 200 …"
   *
   * came back as "Bunny edge-rule QA limitations. Testing on *.instawp.site fails…". Same id, same
   * ranking, no `.env` names, no exact commands. Worse, the two stores then disagreed: Dreaming, the
   * consolidation gardener and the Memory-hub all read the mirror's original while agents recalled the
   * paraphrase.
   *
   * So content is served from the mirror whenever the mirror has that id. Ranking, ordering and score
   * stay entirely the backend's — this restores fidelity without touching retrieval quality (the
   * embedding is computed over whatever the backend holds either way). A row the mirror doesn't know
   * (stored before mirroring, or written directly to the backend) keeps the backend's own copy, so this
   * can only ever add fidelity, never drop a result. Best-effort: a mirror failure returns the backend's
   * records unchanged.
   */
  private withCanonicalContent(out: MemoryRecord[]): MemoryRecord[] {
    if (!out.length) return out;
    try {
      const canonical = this.mirror.contentByIds(out.map((r) => r.id));
      if (!canonical.size) return out;
      return out.map((r) => {
        const content = canonical.get(r.id);
        return content != null && content !== r.content ? { ...r, content } : r;
      });
    } catch {
      return out; // mirror is best-effort — never fail a recall over it
    }
  }

  async update(input: UpdateInput): Promise<MemoryRecord | null> {
    const rec = await this.backend.update(input);
    if (rec) { try { this.mirror.insertRecord(rec); } catch { /* best-effort */ } }
    return rec;
  }

  async delete(input: DeleteInput): Promise<boolean> {
    const ok = await this.backend.delete(input);
    if (ok) { try { this.mirror.removeRecord(input.tenant, input.id); } catch { /* best-effort */ } }
    return ok;
  }

  async forgetAgent(tenant: string, agentId: string): Promise<number> {
    const n = this.backend.forgetAgent ? await this.backend.forgetAgent(tenant, agentId) : 0;
    try { await this.mirror.forgetAgent?.(tenant, agentId); } catch { /* best-effort */ }
    return n;
  }

  health(): Promise<{ ok: boolean; backend: string; detail?: string }> {
    return this.backend.health();
  }

  /** Report the EXTERNAL backend's count (what the drift banner compares the local mirror against). */
  count(tenant: string): Promise<number | null> {
    return this.backend.count ? this.backend.count(tenant) : Promise.resolve(null);
  }

  /**
   * Upkeep across BOTH stores. The local mirror decides what to drop — it is the only side that holds the
   * SQL-level signals prune and dedupe key off (age, `recall_count`, importance, exact-content grouping)
   * — and every id it removed is then deleted from the external backend, so the two stay in step.
   *
   * This used to trust the backend to look after itself ("automem self-maintains") and prune the mirror
   * silently alongside. Neither half held: automem's enrichment/consolidation does NOT remove exact
   * duplicates (a live tenant carried the SAME episode 177 times, 7% of its whole store, and it ranked in
   * recall probes), and because the result came from the backend, the API reported `pruned: 0` while rows
   * really did vanish from the mirror. So enabling upkeep on an external backend made the two stores
   * diverge — agents kept recalling exactly what the console had been told was pruned.
   *
   * Order is mirror-first, backend-second: the backend delete is per-id over the network and some of them
   * can fail, and a mirror row left behind for a backend row that IS gone is the worse failure (the local
   * ledger, which Dreaming and the hub counts read, would claim memories that recall can never return).
   * Failures are counted into `backendFailures` rather than swallowed.
   */
  async maintain(opts: MemoryMaintenance): Promise<MemoryMaintenanceResult> {
    const backendRes = this.backend.maintain ? await this.backend.maintain(opts) : { pruned: 0, merged: 0 };
    let local: MemoryMaintenanceResult = { pruned: 0, merged: 0 };
    try { local = (await this.mirror.maintain?.(opts)) ?? local; } catch { /* best-effort */ }

    let backendFailures = 0;
    for (const r of local.removed ?? []) {
      // `admin` bypasses the author guard: upkeep is the workspace's own housekeeping, not one agent
      // reaching into another agent's memories.
      try {
        const ok = await this.backend.delete({ tenant: r.tenant, agentId: r.agentId, id: r.id, admin: true });
        if (!ok) backendFailures++;
      } catch { backendFailures++; }
    }

    return {
      pruned: local.pruned + backendRes.pruned,
      merged: local.merged + backendRes.merged,
      removed: local.removed,
      backendFailures,
    };
  }
}
