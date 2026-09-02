/**
 * Audit — the append-only event store. This is the system of record, not a debug log.
 * Monitoring, Evaluation, the Console and Dreaming are all READERS of this stream.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent, AuditSink } from '../types';
import { Db } from '../state/db';
import { requestMetrics } from '../edge/request-metrics';

/** Keeps events in memory — handy for tests, demos, and the Console to read back. */
export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  append(event: AuditEvent): void {
    this.events.push(event);
  }
  forRun(runId: string): AuditEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }
}

/** Append-only JSONL per run, partitioned by tenant: <dir>/<tenant>/<runId>.jsonl */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly baseDir: string) {}
  append(event: AuditEvent): void {
    const dir = path.join(this.baseDir, event.tenant);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${event.runId}.jsonl`), JSON.stringify(event) + '\n');
  }
}

/** Longest string leaf kept in the SQLite MIRROR. The JSONL keeps the value whole. */
const MIRROR_STRING_MAX = 2_000;
/** Marker appended to a clipped leaf, so a reader can tell truncation from a genuinely short value. */
export const CLIP_MARK = '…[clipped — full value in the audit JSONL]';

/**
 * Shrink one event's `data` for the queryable mirror by truncating long STRING leaves in place.
 *
 * Keys and structure are preserved exactly, because every reader of this column indexes into it by name
 * (`data.capability`, `data.decision`, `data.brief`, …) — a size guard that dropped fields would break the
 * Audit page, Insights, agent-stats and the digest. Only oversized leaf text is cut.
 *
 * The bloat this exists for is real and lopsided: on the live fleet `gate.attempt` averaged 966 bytes but
 * reached **120 KB** for a single row (a pasted command / a large tool arg), and 4014 such rows held 30 MB
 * of a 153 MB table. Full fidelity for those lives in the JSONL system-of-record; the mirror only needs
 * enough to search and to render a row.
 */
export function clipForMirror(data: unknown, max = MIRROR_STRING_MAX): unknown {
  if (typeof data === 'string') return data.length > max ? data.slice(0, max) + CLIP_MARK : data;
  if (Array.isArray(data)) return data.map((v) => clipForMirror(v, max));
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = clipForMirror(v, max);
    return out;
  }
  return data;
}

/** A queryable mirror in the per-workspace SQLite DB (JSONL stays the durable system of record). */
export class SqliteAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}
  append(event: AuditEvent): void {
    this.db
      .prepare('INSERT INTO audit_events (ts, run_id, tenant, type, principal, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.ts, event.runId, event.tenant, event.type, event.principal ?? null, JSON.stringify(clipForMirror(event.data)));
  }
}

/**
 * Drop mirror rows older than `days`, oldest first, in bounded batches.
 *
 * Safe to prune because this table is a MIRROR: `JsonlAuditSink` holds every event forever, per run, and is
 * what "append-only system of record" refers to. Without a bound the mirror grows with the tenant's whole
 * lifetime — instawp wrote ~3 MB/day, reaching 195 MB of a 336 MB DB in 45 days, and the growth was
 * entirely open-ended.
 *
 * Deletes free pages for REUSE; they do not shrink the file (these DBs are created with `auto_vacuum=0`, and
 * a full `VACUUM` would lock a live server for the length of a 300 MB rewrite). So the honest promise is a
 * plateau, not a shrink — which is the actual goal.
 *
 * @param limit max rows per call, so one sweep can never hold the write lock for an unbounded stretch.
 * @returns how many rows were deleted.
 */
export function pruneAuditMirror(db: Db, days: number, now = Date.now(), limit = 20_000): number {
  if (!Number.isFinite(days) || days <= 0) return 0; // 0/absent = keep everything (explicit opt-out)
  const cutoff = now - days * 86_400_000;
  const r = db
    .prepare('DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE ts < ? ORDER BY ts LIMIT ?)')
    .run(cutoff, limit);
  return Number(r.changes ?? 0);
}

/** Fan an event out to several sinks (e.g. durable JSONL + in-memory for the Console). */
export class TeeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  append(event: AuditEvent): void {
    // NAMED for the loop-stall recorder: every sink here is synchronous (a SQLite insert, an
    // `appendFileSync` per run file), this runs on the path of every governed action, and an unnamed
    // block is exactly what the 156-second stall hunt could not attribute. Two array writes per event.
    requestMetrics.phase('audit:append', () => { for (const s of this.sinks) s.append(event); });
  }
}
