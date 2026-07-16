/**
 * Policy revision history — the rollback backbone for governance edits.
 *
 * Every change to the live policy document (a human edit via `PUT /api/policy`, an "Always approve"
 * learn step, or an owner-approved agent proposal) snapshots the FULL document here before/after, so any
 * change is auditable and one-click revertable. Like the KB and agent-config history, safety comes from
 * reversibility: nothing done to the ruleset — by a human or via an approved agent proposal — is ever
 * truly lost.
 *
 * DB-only (a snapshot is pure structured state); the live document itself is the JSON override on disk.
 */
import { newId } from '../id';
import { Db } from './db';
import { PolicyDocument } from '../governance/policy';

/** A committed policy snapshot with its revision metadata. */
export interface PolicyRevision {
  id: string;
  rev: number;
  document: PolicyDocument;
  summary: string | null;
  author: string;
  createdAt: number;
}

interface RevRow {
  id: string; tenant: string; rev: number; document: string;
  summary: string | null; author: string; created_at: number;
}

function toRevision(r: RevRow): PolicyRevision {
  return { id: r.id, rev: r.rev, document: JSON.parse(r.document) as PolicyDocument, summary: r.summary, author: r.author, createdAt: r.created_at };
}

export class PolicyRevisions {
  constructor(private readonly db: Db) {}

  /** All revisions, newest first. */
  list(): PolicyRevision[] {
    return this.db.prepare('SELECT * FROM policy_revisions ORDER BY rev DESC').all<RevRow>().map(toRevision);
  }

  /** One revision by number, or null. */
  get(rev: number): PolicyRevision | null {
    const r = this.db.prepare('SELECT * FROM policy_revisions WHERE rev = ?').get<RevRow>(rev);
    return r ? toRevision(r) : null;
  }

  /**
   * Record an edit. On the FIRST tracked edit we seed a baseline revision from `before` (so the
   * pre-feature ruleset stays recoverable), then append `after`. A no-op edit (after deep-equals the
   * latest) records nothing. Returns the new rev number, or null when nothing changed.
   */
  commit(tenant: string, before: PolicyDocument, after: PolicyDocument, summary: string, author: string): number | null {
    const now = Date.now();
    let rev = this.maxRev();
    if (rev === 0) {
      this.insert(tenant, 1, before, 'baseline — captured before the first tracked edit', 'system', now);
      rev = 1;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return null;
    rev += 1;
    this.insert(tenant, rev, after, summary, author, now);
    return rev;
  }

  private maxRev(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM policy_revisions').get<{ m: number }>();
    return r?.m ?? 0;
  }

  private insert(tenant: string, rev: number, doc: PolicyDocument, summary: string, author: string, ts: number): void {
    this.db
      .prepare('INSERT INTO policy_revisions (id, tenant, rev, document, summary, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('policyRevision'), tenant, rev, JSON.stringify(doc), summary || null, author, ts);
  }
}
