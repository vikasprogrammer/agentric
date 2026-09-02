/**
 * Per-agent MCP tool-usage counters.
 *
 * ## Why this exists
 *
 * The `mcp__agentos__*` tools are loopback HTTP calls that sit BEFORE the member-auth gate, so the
 * PreToolUse gate hook never sees them — and only the tools that happen to write something leave an
 * audit trace. Every READ tool (`recall`, `kb_search`, `kb_read`, `task_list`, `check_inbox`,
 * `list_capabilities`, `session_history`, `directory_lookup`) records nothing at all.
 *
 * That blind spot is not academic. Asked in 2026-09 whether the 77 KB tool schema could be gated per
 * agent, the honest answer was no: write-tool usage was measurable (engineer 18 of 31 on instawp,
 * typical agents 5–13) but roughly half the schema was invisible, and gating on a measurement that
 * cannot see reads would have stripped the tools agents lean on most.
 *
 * ## Shape: counters, not events
 *
 * A count per `(tenant, agent, tool, day)` — deliberately NOT an audit event per call. The question is
 * "which tools does this agent actually use", not "what happened in that call". Auditing every read
 * would roughly double audit volume on a busy tenant (instapods already writes ~33k gate events a week)
 * to answer a question a four-column counter answers exactly.
 *
 * ## Never on the hot path
 *
 * `record()` bumps an in-memory Map; nothing touches SQLite until {@link flush}. `node:sqlite` is
 * synchronous, so a write per request would block the event loop on the one path every agent call goes
 * through — the same trap `markTurnBusy` throttles around. A crash loses at most one flush interval of
 * counts, which for a usage histogram is not worth a synchronous write.
 */
import type { DatabaseSync } from 'node:sqlite';

/** `YYYY-MM-DD` in UTC — the bucket key, so a day means the same thing on every box. */
export function usageDay(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Bound on distinct keys held between flushes. A tenant has tens of agents and ~70 tools, so a normal
 *  day is well under this; the cap stops a bug (or a hostile header) turning the accumulator into a leak. */
const MAX_KEYS = 20_000;

export interface ToolUsageRow { agent: string; tool: string; day: string; n: number }

export class ToolUsage {
  /** `tenant\0agent\0tool\0day` → count, pending flush. */
  private readonly pending = new Map<string, number>();
  private dropped = 0;

  /** Count one call. Cheap by construction: a Map bump, no I/O, no allocation beyond the key. */
  record(tenant: string, agent: string, tool: string, at = Date.now()): void {
    if (!tenant || !agent || !tool) return;
    // The header is advisory and agent-supplied, so bound what it can create: a tool name is an
    // identifier, never free text.
    if (tool.length > 64 || agent.length > 64) return;
    const key = `${tenant}\0${agent}\0${tool}\0${usageDay(at)}`;
    if (!this.pending.has(key) && this.pending.size >= MAX_KEYS) { this.dropped++; return; }
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }

  /** Number of counts waiting to be written (for tests and the flush log). */
  pendingCount(): number { return this.pending.size; }
  droppedCount(): number { return this.dropped; }

  /**
   * Write every pending count for ONE tenant into its own DB and forget them. Called per tenant because
   * the DB file IS the tenant boundary — there is no cross-tenant table to write to.
   * Best-effort: a failed flush drops that tenant's counts rather than retrying forever or throwing on a
   * timer. Returns how many rows were written.
   */
  flush(tenant: string, db: DatabaseSync): number {
    const mine: [string, number][] = [];
    for (const [k, n] of this.pending) if (k.startsWith(`${tenant}\0`)) mine.push([k, n]);
    if (!mine.length) return 0;
    try {
      const up = db.prepare(
        `INSERT INTO tool_usage (tenant, agent, tool, day, n) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant, agent, tool, day) DO UPDATE SET n = n + excluded.n`,
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [k, n] of mine) {
          const [t, agent, tool, day] = k.split('\0');
          up.run(t, agent, tool, day, n);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } catch {
      // Drop them: counts are a histogram, and a stuck accumulator would grow without bound.
      for (const [k] of mine) this.pending.delete(k);
      return 0;
    }
    for (const [k] of mine) this.pending.delete(k);
    return mine.length;
  }
}

/** Process-wide accumulator — one per box, flushed per tenant. */
export const toolUsage = new ToolUsage();

/** Read the counters back: per-agent tool usage over the last `days`, newest bucket inclusive. */
export function readToolUsage(db: DatabaseSync, tenant: string, days = 30): ToolUsageRow[] {
  const since = usageDay(Date.now() - days * 86_400_000);
  try {
    return db
      .prepare('SELECT agent, tool, day, n FROM tool_usage WHERE tenant = ? AND day >= ? ORDER BY n DESC')
      .all<ToolUsageRow>(tenant, since);
  } catch {
    return [];
  }
}
