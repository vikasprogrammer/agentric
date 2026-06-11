/**
 * Audit — the append-only event store. This is the system of record, not a debug log.
 * Monitoring, Evaluation, the Console and Dreaming are all READERS of this stream.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent, AuditSink } from '../types';

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

/** Fan an event out to several sinks (e.g. durable JSONL + in-memory for the Console). */
export class TeeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}
  append(event: AuditEvent): void {
    for (const s of this.sinks) s.append(event);
  }
}
