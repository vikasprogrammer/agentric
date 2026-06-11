/**
 * Approvals — the human-in-the-loop workflow. Policy CLASSIFIES; Approvals ROUTES and
 * CAPTURES THE DECISION. A run suspends to `waiting_approval` until a human resolves.
 *
 * In production the queue is durable and the Console / Slack resolves items. Here it's
 * in-memory with an optional auto-resolver so the demo can simulate a human.
 */
import { ApprovalRequest, Approvals } from '../types';
import { randomUUID } from 'crypto';

export class InMemoryApprovals implements Approvals {
  private items = new Map<string, ApprovalRequest>();
  private waiters = new Map<string, (approved: boolean) => void>();
  private autoResolver?: (req: ApprovalRequest) => boolean | undefined;

  /** Demo/automation hook: return true/false to auto-decide, or undefined to leave pending. */
  setAutoResolver(fn: (req: ApprovalRequest) => boolean | undefined): void {
    this.autoResolver = fn;
  }

  request(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): {
    req: ApprovalRequest;
    decision: Promise<boolean>;
  } {
    const req: ApprovalRequest = { ...input, id: randomUUID(), status: 'pending', createdAt: Date.now() };
    this.items.set(req.id, req);

    let resolveFn!: (approved: boolean) => void;
    const decision = new Promise<boolean>((res) => (resolveFn = res));
    this.waiters.set(req.id, resolveFn);

    if (this.autoResolver) {
      const verdict = this.autoResolver(req);
      if (verdict !== undefined) queueMicrotask(() => this.resolve(req.id, verdict, 'auto-resolver'));
    }
    return { req, decision };
  }

  resolve(id: string, approved: boolean, by: string): void {
    const req = this.items.get(id);
    if (!req || req.status !== 'pending') return;
    req.status = approved ? 'approved' : 'rejected';
    req.resolvedBy = by;
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(approved);
      this.waiters.delete(id);
    }
  }

  pending(tenant?: string): ApprovalRequest[] {
    return [...this.items.values()].filter(
      (r) => r.status === 'pending' && (!tenant || r.tenant === tenant),
    );
  }
}
