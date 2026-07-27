/**
 * The AUTO-APPROVAL list — a durable, legible registry of "always approve THIS action" decisions.
 *
 * The capability-wide "Always approve" (a policy `allow <capability>` rule) is too blunt for the
 * recurring-benign-approval problem — allowing all `connector.connect` or all `net.connect` is a huge
 * grant. This list is keyed on the decision-brief SIGNATURE (`capability|verb|targetKind|key`), so an
 * owner can silence exactly one recurring action shape (e.g. "reach host 198.51.100.42", "use Stripe
 * refund") and nothing broader. At gate time a pending APPROVE whose signature is on the list is cleared
 * automatically (audited `approval.auto_approved` via `auto-approve-list`) — no card, no notification.
 *
 * Safety: this only ever short-circuits an `approve` (yellow/red). A `deny` (never-tier: destructive /
 * over-cap / prod-build) is a different decision the list never sees, so it stays blocked regardless.
 *
 * Every row records WHAT is auto-approved (a human `label` + the raw `signature`), an `example` of the
 * action, WHO added it, and how many times it has fired — so the Settings surface is fully legible and
 * revocable. Per-workspace DB = the tenant boundary (no tenant column, like HostStore).
 */
import { Db } from './db';
import { newId } from '../id';

export interface AutoApproval {
  id: string;
  /** The decision-brief signature this rule matches (the auto-approve key). */
  signature: string;
  capability: string;
  /** Human phrase for the Settings list ("Reach host 198.51.100.42", "Use stripe refund"). */
  label: string;
  /** An example headline from the approval it was created from (concrete illustration). */
  example: string;
  addedBy: string;
  addedAt: number;
  /** How many pending approvals this rule has auto-cleared, and when it last fired. */
  hits: number;
  lastHitAt?: number;
}

interface Row {
  id: string;
  signature: string;
  capability: string;
  label: string;
  example: string | null;
  added_by: string;
  added_at: number;
  hits: number;
  last_hit_at: number | null;
}

const toRule = (r: Row): AutoApproval => ({
  id: r.id,
  signature: r.signature,
  capability: r.capability,
  label: r.label,
  example: r.example ?? '',
  addedBy: r.added_by,
  addedAt: r.added_at,
  hits: r.hits,
  lastHitAt: r.last_hit_at ?? undefined,
});

export class AutoApprovalStore {
  constructor(private readonly db: Db) {}

  list(): AutoApproval[] {
    return this.db.prepare('SELECT * FROM auto_approvals ORDER BY added_at DESC').all<Row>().map(toRule);
  }

  /** Add a signature to the list (idempotent on signature). Returns the rule + whether it was new. */
  add(input: { signature: string; capability: string; label: string; example?: string; addedBy: string }): { rule: AutoApproval; added: boolean } {
    const sig = (input.signature || '').trim();
    if (!sig) throw new Error('a signature is required');
    const existing = this.db.prepare('SELECT * FROM auto_approvals WHERE signature = ?').get<Row>(sig);
    if (existing) return { rule: toRule(existing), added: false };
    const rule: AutoApproval = {
      id: newId('autoApproval'), signature: sig, capability: input.capability, label: input.label,
      example: input.example ?? '', addedBy: input.addedBy, addedAt: Date.now(), hits: 0,
    };
    this.db
      .prepare('INSERT INTO auto_approvals (id, signature, capability, label, example, added_by, added_at, hits) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(rule.id, rule.signature, rule.capability, rule.label, rule.example, rule.addedBy, rule.addedAt);
    return { rule, added: true };
  }

  /**
   * If `signature` is on the list, record a hit (count + timestamp) and return the rule — the caller
   * then clears the pending approval. Returns undefined when not listed. Called on the gate hot path only
   * for an `approve` decision, so the write is rare.
   */
  match(signature: string): AutoApproval | undefined {
    const r = this.db.prepare('SELECT * FROM auto_approvals WHERE signature = ?').get<Row>(signature);
    if (!r) return undefined;
    this.db.prepare('UPDATE auto_approvals SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(Date.now(), r.id);
    return toRule(r);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM auto_approvals WHERE id = ?').run(id).changes > 0;
  }
}
