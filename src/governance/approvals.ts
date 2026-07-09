/**
 * Approvals — the human-in-the-loop workflow. Policy CLASSIFIES; Approvals ROUTES and
 * CAPTURES THE DECISION. A run suspends to `waiting_approval` until a human resolves.
 *
 * In production the queue is durable and the Console / Slack resolves items. Here it's
 * in-memory with an optional auto-resolver so the demo can simulate a human.
 */
import { ApprovalRequest, Approvals } from '../types';
import { randomUUID } from 'crypto';
import { Db } from '../state/db';

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

  cancel(id: string, by: string): boolean {
    const req = this.items.get(id);
    if (!req || req.status !== 'pending') return false;
    req.status = 'cancelled';
    req.resolvedBy = by;
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(false); // deny — the gated effect must not proceed
      this.waiters.delete(id);
    }
    return true;
  }

  pending(tenant?: string): ApprovalRequest[] {
    return [...this.items.values()].filter(
      (r) => r.status === 'pending' && (!tenant || r.tenant === tenant),
    );
  }
}

interface ApprovalRow {
  id: string;
  run_id: string;
  tenant: string;
  level: 'head' | 'owner';
  capability: string;
  args: string;
  reasoning: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  resolved_by: string | null;
  created_at: number;
}

function toRequest(r: ApprovalRow): ApprovalRequest {
  return {
    id: r.id,
    runId: r.run_id,
    tenant: r.tenant,
    level: r.level,
    attempt: { capabilityId: r.capability, args: JSON.parse(r.args) as Record<string, unknown>, reasoning: r.reasoning ?? undefined },
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    resolvedBy: r.resolved_by ?? undefined,
  };
}

/**
 * Durable approvals. Records live in the per-workspace SQLite `approvals` table so the inbox
 * survives restarts; the blocking `decision` promise is necessarily in-memory (a waiter), so a
 * gate suspended across a restart simply stays pending and the gate-hook keeps polling its status.
 */
export class SqliteApprovals implements Approvals {
  private waiters = new Map<string, (approved: boolean) => void>();
  private autoResolver?: (req: ApprovalRequest) => boolean | undefined;

  constructor(private readonly db: Db) {}

  setAutoResolver(fn: (req: ApprovalRequest) => boolean | undefined): void {
    this.autoResolver = fn;
  }

  request(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): {
    req: ApprovalRequest;
    decision: Promise<boolean>;
  } {
    const req: ApprovalRequest = { ...input, id: randomUUID(), status: 'pending', createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO approvals (id, run_id, tenant, level, capability, args, reasoning, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.id, req.runId, req.tenant, req.level, req.attempt.capabilityId, JSON.stringify(req.attempt.args), req.attempt.reasoning ?? null, req.reason, 'pending', req.createdAt);

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
    const row = this.db.prepare('SELECT status FROM approvals WHERE id = ?').get<{ status: string }>(id);
    if (!row || row.status !== 'pending') return;
    this.db.prepare('UPDATE approvals SET status = ?, resolved_by = ? WHERE id = ?').run(approved ? 'approved' : 'rejected', by, id);
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(approved);
      this.waiters.delete(id);
    }
  }

  cancel(id: string, by: string): boolean {
    const row = this.db.prepare('SELECT status FROM approvals WHERE id = ?').get<{ status: string }>(id);
    if (!row || row.status !== 'pending') return false;
    this.db.prepare("UPDATE approvals SET status = 'cancelled', resolved_by = ? WHERE id = ?").run(by, id);
    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(false); // deny — the gated effect must not proceed
      this.waiters.delete(id);
    }
    return true;
  }

  /** Map a request id to its current status — for the gate hook (allow | deny | pending). A `cancelled`
   *  row falls through to deny below, so a still-polling gate-hook stops waiting and the effect is blocked. */
  statusOf(id: string): 'pending' | 'approved' | 'rejected' | 'cancelled' | undefined {
    return this.db.prepare('SELECT status FROM approvals WHERE id = ?').get<{ status: ApprovalRow['status'] }>(id)?.status;
  }

  get(id: string): ApprovalRequest | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get<ApprovalRow>(id);
    return r ? toRequest(r) : undefined;
  }

  pending(tenant?: string): ApprovalRequest[] {
    const rows = tenant
      ? this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND tenant = ? ORDER BY created_at").all<ApprovalRow>(tenant)
      : this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at").all<ApprovalRow>();
    return rows.map(toRequest);
  }
}
