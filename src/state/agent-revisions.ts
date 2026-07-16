/**
 * Agent config revision history — the rollback backbone for a self-editing agent.
 *
 * An agent can refine its own "listing" (description, starter prompts, category, icon, tuning) and its
 * CLAUDE.md system prompt via the `agent_update` MCP tool; humans do the same from the console. Neither
 * path is approval-gated — like the KB, safety comes from **reversibility**: every edit snapshots the
 * full prior + new state here, so any change (by the agent or a human) is auditable and one-click
 * revertable. Nothing the agent does to itself is ever truly lost.
 *
 * This store is DB-only (a snapshot is pure structured state). The manifest itself still lives on disk
 * (`agent.json` + `CLAUDE.md`); the server writes those files and calls `commit` to record the version.
 */
import { newId } from '../id';
import { Db } from './db';
import { Effort, PermissionMode } from '../types';

/** The full editable surface of an agent — everything a revert must restore. */
export interface AgentConfigSnapshot {
  description: string;
  category?: string;
  icon?: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  examplePrompts: string[];
  shellSecrets: string[];
  claudeMd: string;
}

/** A committed snapshot with its revision metadata. */
export interface AgentRevision extends AgentConfigSnapshot {
  id: string;
  rev: number;
  summary: string | null;
  author: string;
  createdAt: number;
}

interface RevRow {
  id: string; tenant: string; agent_id: string; rev: number;
  description: string; category: string | null; icon: string | null;
  model: string | null; effort: string | null; permission_mode: string | null;
  example_prompts: string; shell_secrets: string; claude_md: string;
  summary: string | null; author: string; created_at: number;
}

function toRevision(r: RevRow): AgentRevision {
  return {
    id: r.id, rev: r.rev,
    description: r.description,
    category: r.category ?? undefined,
    icon: r.icon ?? undefined,
    model: r.model ?? undefined,
    effort: (r.effort as Effort) ?? undefined,
    permissionMode: (r.permission_mode as PermissionMode) ?? undefined,
    examplePrompts: safeArray(r.example_prompts),
    shellSecrets: safeArray(r.shell_secrets),
    claudeMd: r.claude_md,
    summary: r.summary, author: r.author, createdAt: r.created_at,
  };
}

function safeArray(json: string): string[] {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Two snapshots are equal when every tracked field matches (so a no-op save records nothing). */
function sameSnapshot(a: AgentConfigSnapshot, b: AgentConfigSnapshot): boolean {
  return a.description === b.description
    && (a.category ?? '') === (b.category ?? '')
    && (a.icon ?? '') === (b.icon ?? '')
    && (a.model ?? '') === (b.model ?? '')
    && (a.effort ?? '') === (b.effort ?? '')
    && (a.permissionMode ?? '') === (b.permissionMode ?? '')
    && JSON.stringify(a.examplePrompts ?? []) === JSON.stringify(b.examplePrompts ?? [])
    && JSON.stringify(a.shellSecrets ?? []) === JSON.stringify(b.shellSecrets ?? [])
    && a.claudeMd === b.claudeMd;
}

export class AgentRevisions {
  constructor(private readonly db: Db) {}

  /** All revisions for an agent, newest first. */
  list(agentId: string): AgentRevision[] {
    return this.db
      .prepare('SELECT * FROM agent_revisions WHERE agent_id = ? ORDER BY rev DESC')
      .all<RevRow>(agentId)
      .map(toRevision);
  }

  /** One revision by number, or null. */
  get(agentId: string, rev: number): AgentRevision | null {
    const r = this.db
      .prepare('SELECT * FROM agent_revisions WHERE agent_id = ? AND rev = ?')
      .get<RevRow>(agentId, rev);
    return r ? toRevision(r) : null;
  }

  /**
   * Record an edit. `before` is the on-disk state just replaced, `after` the new state. On the FIRST
   * tracked edit we seed a baseline revision from `before` (so pre-feature state stays recoverable),
   * then append `after`. A no-op edit (after === latest) records nothing. Returns the new rev, or null
   * when nothing changed.
   */
  commit(tenant: string, agentId: string, before: AgentConfigSnapshot, after: AgentConfigSnapshot, summary: string, author: string): number | null {
    const now = Date.now();
    const maxRev = this.maxRev(agentId);
    let rev = maxRev;
    if (rev === 0) {
      this.insert(tenant, agentId, 1, before, 'baseline — captured before the first tracked edit', 'system', now);
      rev = 1;
    }
    if (sameSnapshot(before, after)) return null;
    rev += 1;
    this.insert(tenant, agentId, rev, after, summary, author, now);
    return rev;
  }

  private maxRev(agentId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(rev), 0) AS m FROM agent_revisions WHERE agent_id = ?').get<{ m: number }>(agentId);
    return r?.m ?? 0;
  }

  private insert(tenant: string, agentId: string, rev: number, s: AgentConfigSnapshot, summary: string, author: string, ts: number): void {
    this.db
      .prepare(`INSERT INTO agent_revisions
        (id, tenant, agent_id, rev, description, category, icon, model, effort, permission_mode, example_prompts, shell_secrets, claude_md, summary, author, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        newId('agentRevision'), tenant, agentId, rev,
        s.description, s.category ?? null, s.icon ?? null,
        s.model ?? null, s.effort ?? null, s.permissionMode ?? null,
        JSON.stringify(s.examplePrompts ?? []), JSON.stringify(s.shellSecrets ?? []), s.claudeMd,
        summary || null, author, ts,
      );
  }
}
