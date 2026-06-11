/**
 * Monitoring / health — is it alive? Heartbeats + stale-run detection. This catches the
 * SILENT failure mode (a wedged run, a dead daemon) that Evaluation never sees because
 * the action simply never happened.
 */
export interface Heartbeat {
  runId: string;
  agentId: string;
  ts: number;
}

export class HealthMonitor {
  private beats = new Map<string, Heartbeat>();

  beat(runId: string, agentId: string): void {
    this.beats.set(runId, { runId, agentId, ts: Date.now() });
  }

  clear(runId: string): void {
    this.beats.delete(runId);
  }

  /** Runs whose last heartbeat is older than `staleMs` — candidates for kill/alert. */
  stale(staleMs: number): Heartbeat[] {
    const cutoff = Date.now() - staleMs;
    return [...this.beats.values()].filter((b) => b.ts < cutoff);
  }

  live(): Heartbeat[] {
    return [...this.beats.values()];
  }
}
