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

  /** Recall is the backend's job — the reason to run a non-SQLite store at all. */
  recall(q: RecallQuery): Promise<MemoryRecord[]> {
    return this.backend.recall(q);
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

  async maintain(opts: MemoryMaintenance): Promise<MemoryMaintenanceResult> {
    // The backend self-maintains (automem) or prunes its own store (libsql); either way, keep the
    // local mirror bounded with the same policy so it doesn't grow forever behind an external store.
    const res = this.backend.maintain ? await this.backend.maintain(opts) : { pruned: 0, merged: 0 };
    try { await this.mirror.maintain?.(opts); } catch { /* best-effort */ }
    return res;
  }
}
