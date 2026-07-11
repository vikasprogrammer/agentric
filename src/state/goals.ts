/**
 * The Goals plane — the strategic layer the fleet's work ladders up to (Goal → Task → Session).
 *
 * Where a Task is a durable *unit of work*, a Goal is the *direction* above it: a human-owned,
 * tenant-wide, persistent object the whole fleet orients to. Agents READ goals (goal_list/goal_get) and
 * PROPOSE drafts (goal_propose); only humans activate/edit them — strategy is a steering-wheel concern.
 *
 * Governance mirrors Tasks/KB, not the gateway: goal EDITS are auto-apply + audited (the safety net is
 * the append-only `goal_events` log, not a human gate). Slice 2 links a Task up via `tasks.goal_id` and
 * derives progress from linked-task status; v1 is the object plus its own timeline.
 *
 * DB-only, like TaskStore: a goal is structured state, not a document to co-author on disk, so there's
 * no `<home>/…` markdown mirror and the constructor is just `(db)`.
 */
import { randomUUID } from 'crypto';
import { Db } from './db';
import { Goal, GoalCreateInput, GoalEvent, GoalQuery, GoalStatus, GoalUpdateInput } from '../types';

interface GoalRow {
  id: string; tenant: string; title: string; body: string; status: string;
  target: string | null; owner: string | null; parent_id: string | null; labels: string;
  due_at: number | null; created_by: string; created_at: number; updated_at: number; updated_by: string;
  rank?: number;
}
interface EventRow {
  id: string; goal_id: string; kind: string; body: string | null; author: string; created_at: number;
}

const STATUSES: readonly GoalStatus[] = ['draft', 'active', 'achieved', 'abandoned'];

/**
 * What the {@link GoalStore} notifier sink receives on a meaningful goal change. The store stays db-only
 * and layer-clean — it fires a domain event; the edge wiring (tenant-registry) decides whether it merits
 * an inbox card, resolves the receiver via an `Audience`, and DMs them. Mirrors {@link TaskStore}'s notice.
 * `by` is the actor (member id | `agent:<id>`) so the wiring can suppress self-notification.
 */
export interface GoalNotice {
  goal: Goal;
  kind: 'created' | 'status' | 'proposed';
  by: string;
  detail?: string;
}

export class GoalStore {
  constructor(private readonly db: Db) {}

  private notifier?: (n: GoalNotice) => void;
  /** Register the sink fired on goal create / status change / proposal. Best-effort, post-construction
   *  (wired in tenant-registry), like the other notifier sinks. */
  setNotifier(fn: (n: GoalNotice) => void): void { this.notifier = fn; }
  private notify(n: GoalNotice): void { try { this.notifier?.(n); } catch { /* notifications are advisory */ } }

  /** Create a goal, log its opening `status` event, and (for a sub-goal) `link` it on the parent. */
  create(input: GoalCreateInput): Goal {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    const labels = input.labels ?? [];
    const status: GoalStatus = input.status && STATUSES.includes(input.status) ? input.status : 'active';
    this.db
      .prepare(`INSERT INTO goals
        (id, tenant, title, body, status, target, owner, parent_id, labels, due_at,
         created_by, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, input.tenant, input.title.trim() || 'Untitled goal', input.body ?? '', status,
        input.target ?? null, input.owner ?? null, input.parentId ?? null, JSON.stringify(labels),
        input.dueAt ?? null, input.createdBy, now, now, input.createdBy,
      );
    this.addEvent(id, 'status', `→${status}`, input.createdBy);
    if (input.parentId && this.get(input.parentId)) this.addEvent(input.parentId, 'link', `goal:${id}`, input.createdBy);
    const goal = this.get(id)!;
    this.notify({ goal, kind: status === 'draft' ? 'proposed' : 'created', by: input.createdBy });
    return goal;
  }

  get(id: string): Goal | undefined {
    const r = this.db.prepare('SELECT * FROM goals WHERE id = ?').get<GoalRow>(id);
    return r ? toGoal(r) : undefined;
  }

  /** A goal + its full activity timeline (oldest first). */
  withEvents(id: string): { goal: Goal; events: GoalEvent[] } | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    const events = this.db
      .prepare('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
      .all<EventRow>(id)
      .map(toEvent);
    return { goal, events };
  }

  /**
   * List query. FTS (bm25) when `query` is set, else ordered by status (draft < active < achieved <
   * abandoned), then most-recently updated. status/owner/parent filter in SQL/JS. Mirrors TaskStore.list.
   */
  list(q: GoalQuery): Goal[] {
    const limit = Math.max(1, Math.min(q.limit ?? 200, 500));
    const match = toFtsQuery(q.query);
    const fetchN = q.status || q.ownerId || q.parentId ? limit * 5 : limit;
    let rows: GoalRow[];
    if (match) {
      rows = this.db
        .prepare(`SELECT g.*, bm25(goals_fts) AS rank FROM goals_fts JOIN goals g ON g.rowid = goals_fts.rowid
                   WHERE goals_fts MATCH ? AND g.tenant = ? ORDER BY rank LIMIT ?`)
        .all<GoalRow>(match, q.tenant, fetchN);
    } else {
      rows = this.db
        .prepare(`SELECT * FROM goals WHERE tenant = ?
                   ORDER BY (CASE status WHEN 'draft' THEN 0 WHEN 'active' THEN 1 WHEN 'achieved' THEN 2
                             ELSE 3 END), updated_at DESC LIMIT ?`)
        .all<GoalRow>(q.tenant, fetchN);
    }
    let goals = rows.map(toGoal);
    if (q.status) goals = goals.filter((g) => g.status === q.status);
    if (q.ownerId) goals = goals.filter((g) => g.owner === q.ownerId);
    if (q.parentId) goals = goals.filter((g) => g.parentId === q.parentId);
    return goals.slice(0, limit);
  }

  /** Just the currently-active goals, most-recently-updated first — the set injected into agent prompts. */
  active(tenant: string): Goal[] {
    return this.db
      .prepare("SELECT * FROM goals WHERE tenant = ? AND status = 'active' ORDER BY updated_at DESC")
      .all<GoalRow>(tenant)
      .map(toGoal);
  }

  /**
   * The one mutating path for edits. Apply changed fields, bump updated_*, and append one goal_event per
   * meaningful change: a `status` event on transition, a `comment` for a note, an `edit` otherwise.
   */
  update(id: string, input: GoalUpdateInput): Goal | null {
    const g = this.get(id);
    if (!g) return null;
    const now = Date.now();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let edited = false;

    if (input.title !== undefined && input.title.trim() && input.title.trim() !== g.title) {
      sets.push('title = ?'); vals.push(input.title.trim()); edited = true;
    }
    if (input.body !== undefined && input.body !== g.body) { sets.push('body = ?'); vals.push(input.body); edited = true; }
    if (input.target !== undefined && (input.target ?? null) !== (g.target ?? null)) {
      sets.push('target = ?'); vals.push(input.target ?? null); edited = true;
    }
    if (input.owner !== undefined && (input.owner ?? null) !== (g.owner ?? null)) {
      sets.push('owner = ?'); vals.push(input.owner ?? null); edited = true;
    }
    if (input.parentId !== undefined && (input.parentId ?? null) !== (g.parentId ?? null)) {
      sets.push('parent_id = ?'); vals.push(input.parentId ?? null); edited = true;
    }
    if (input.labels !== undefined) { sets.push('labels = ?'); vals.push(JSON.stringify(input.labels)); edited = true; }
    if (input.dueAt !== undefined && (input.dueAt ?? null) !== (g.dueAt ?? null)) {
      sets.push('due_at = ?'); vals.push(input.dueAt ?? null); edited = true;
    }
    let statusChange: string | undefined;
    if (input.status && input.status !== g.status && STATUSES.includes(input.status)) {
      sets.push('status = ?'); vals.push(input.status);
      statusChange = `${g.status}→${input.status}`;
      this.addEvent(id, 'status', statusChange, input.by);
    }
    if (input.note && input.note.trim()) this.addEvent(id, 'comment', input.note.trim(), input.by);
    // Record a plain `edit` event only when a non-status field changed and there's no other event carrying it.
    if (edited && !statusChange && !(input.note && input.note.trim())) this.addEvent(id, 'edit', 'edited', input.by);

    if (!sets.length && !statusChange && !(input.note && input.note.trim())) return g; // nothing changed
    sets.push('updated_at = ?'); vals.push(now);
    sets.push('updated_by = ?'); vals.push(input.by);
    this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const goal = this.get(id)!;
    if (statusChange) this.notify({ goal, kind: 'status', by: input.by, detail: statusChange });
    return goal;
  }

  /** Hard delete + cascade the activity log. (Detaches children by clearing their parent_id.) */
  remove(id: string): boolean {
    const res = this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    if (res.changes === 0) return false;
    this.db.prepare('DELETE FROM goal_events WHERE goal_id = ?').run(id);
    this.db.prepare('UPDATE goals SET parent_id = NULL WHERE parent_id = ?').run(id);
    return true;
  }

  /** Per-status counts for the Goals page headers. */
  counts(tenant: string): Record<GoalStatus, number> {
    const out = { draft: 0, active: 0, achieved: 0, abandoned: 0 } as Record<GoalStatus, number>;
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM goals WHERE tenant = ? GROUP BY status')
      .all<{ status: GoalStatus; n: number }>(tenant)) {
      if (r.status in out) out[r.status] = r.n;
    }
    return out;
  }

  /** Append one row to the append-only activity log. */
  private addEvent(goalId: string, kind: GoalEvent['kind'], body: string, author: string): void {
    this.db
      .prepare('INSERT INTO goal_events (id, goal_id, kind, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID().slice(0, 8), goalId, kind, body, author, Date.now());
  }
}

/** Word tokens ORed as quoted FTS5 terms (quoting neutralises operator chars). '' → caller uses recency. */
function toFtsQuery(query?: string): string {
  if (!query) return '';
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || !tokens.length) return '';
  return [...new Set(tokens)].map((t) => `"${t}"`).join(' OR ');
}

function toGoal(r: GoalRow): Goal {
  return {
    id: r.id, tenant: r.tenant, title: r.title, body: r.body, status: r.status as GoalStatus,
    target: r.target ?? undefined, owner: r.owner ?? undefined, parentId: r.parent_id ?? undefined,
    labels: JSON.parse(r.labels) as string[], dueAt: r.due_at ?? undefined,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

function toEvent(r: EventRow): GoalEvent {
  return {
    id: r.id, goalId: r.goal_id, kind: r.kind as GoalEvent['kind'], body: r.body ?? undefined,
    author: r.author, createdAt: r.created_at,
  };
}
