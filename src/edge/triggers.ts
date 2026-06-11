/**
 * Triggers — decide WHEN a run starts (cron, webhook, event). They emit a RunRequest;
 * they do not execute it (that's the Orchestrator). Comms-inbound (listening on
 * Gmail/Slack) is a sibling concern that also emits RunRequests.
 *
 * This file ships the interface + a manual trigger. Cron/webhook adapters plug in the
 * same way (a setInterval cron, an HTTP handler) and call `emit(req)`.
 */
import { RunRequest } from '../types';

export type Emit = (req: RunRequest) => void;

export interface Trigger {
  readonly id: string;
  start(emit: Emit): void;
  stop(): void;
}

/** Fire a run on demand — used by the demo and by an HTTP/webhook bridge. */
export class ManualTrigger implements Trigger {
  readonly id = 'manual';
  private emit?: Emit;
  start(emit: Emit): void {
    this.emit = emit;
  }
  stop(): void {
    this.emit = undefined;
  }
  fire(req: RunRequest): void {
    if (!this.emit) throw new Error('ManualTrigger not started');
    this.emit(req);
  }
}
