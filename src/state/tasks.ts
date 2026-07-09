/**
 * The Tasks plane — the shared, tenant-wide, durable UNIT OF WORK the whole fleet drains from.
 *
 * Where Automations are firing *conditions* and Sessions are ephemeral *runs*, a Task is the persistent
 * *goal* that outlives any single session: a status machine (todo → doing → blocked → done | cancelled)
 * with an owner + assignee and an append-only activity log. Both humans and agents create, claim, and
 * close tasks off one board; a task assigned to an agent with `autoDispatch` spawns a governed session
 * that works it and updates its own task to close the loop (the dispatcher lives on the edge layer).
 *
 * Governance mirrors KB, not the gateway: task EDITS are auto-apply + audited (the safety net is the
 * append-only `task_events` log, not a human gate), while a task DISPATCHING a session inherits the full
 * gateway on that session's effects. So Tasks add no new trust surface — a durable to-do list bolted
 * onto the run engine that already exists.
 *
 * Unlike KbStore this is DB-only: a task is structured state, not a document to co-author on disk, so
 * there's no `<home>/…` markdown mirror and the constructor is just `(db)`. (Deliberate divergence from
 * the KB pattern — see docs/tasks-plan.md §Decision 2.)
 */
import { randomUUID } from 'crypto';
import { Db } from './db';
import { Task, TaskCreateInput, TaskEvent, TaskQuery, TaskStatus, TaskUpdateInput } from '../types';

interface TaskRow {
  id: string; tenant: string; title: string; body: string; status: string; priority: number;
  labels: string; assignee: string | null; owner: string | null; parent_id: string | null;
  mode: string; auto_dispatch: number; due_at: number | null; attempts: number; last_session_id: string | null;
  created_by: string; created_at: number; updated_at: number; updated_by: string;
  rank?: number;
}
interface EventRow {
  id: string; task_id: string; kind: string; body: string | null; author: string;
  session_id: string | null; created_at: number;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled']);
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done', 'cancelled'];
/** Sentinel body for the one-time "went overdue" event that dedupes the overdue notification. */
const OVERDUE_MARK = '⏰ went overdue';

export class TaskStore {
  constructor(private readonly db: Db) {}

  /** Create a task, log its opening `status` event, and (for a sub-task) `link` it on the parent. */
  create(input: TaskCreateInput): Task {
    const now = Date.now();
    const id = randomUUID().slice(0, 8);
    const labels = input.labels ?? [];
    const priority = clampPriority(input.priority);
    const mode = input.mode === 'interactive' ? 'interactive' : 'headless';
    this.db
      .prepare(`INSERT INTO tasks
        (id, tenant, title, body, status, priority, labels, assignee, owner, parent_id, mode, auto_dispatch,
         due_at, attempts, last_session_id, created_by, created_at, updated_at, updated_by)
        VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`)
      .run(
        id, input.tenant, input.title.trim() || 'Untitled task', input.body ?? '', priority,
        JSON.stringify(labels), input.assignee ?? null, input.owner ?? null, input.parentId ?? null,
        mode, input.autoDispatch ? 1 : 0, input.dueAt ?? null, input.createdBy, now, now, input.createdBy,
      );
    this.addEvent(id, 'status', '→todo', input.createdBy);
    if (input.parentId && this.get(input.parentId)) this.addEvent(input.parentId, 'link', `task:${id}`, input.createdBy);
    return this.get(id)!;
  }

  get(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get<TaskRow>(id);
    return r ? toTask(r) : undefined;
  }

  /** A task + its full activity timeline (oldest first). */
  withEvents(id: string): { task: Task; events: TaskEvent[] } | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    const events = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<EventRow>(id)
      .map(toEvent);
    return { task, events };
  }

  /**
   * Board query. FTS (bm25) when `query` is set, else ordered by status, then priority, then most-recently
   * updated. status/assignee/label filter in SQL/JS. Mirrors KbStore.search.
   */
  list(q: TaskQuery): Task[] {
    const limit = Math.max(1, Math.min(q.limit ?? 100, 500));
    const match = toFtsQuery(q.query);
    const fetchN = q.assignee || q.label || q.status ? limit * 5 : limit;
    let rows: TaskRow[];
    if (match) {
      rows = this.db
        .prepare(`SELECT t.*, bm25(tasks_fts) AS rank FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid
                   WHERE tasks_fts MATCH ? AND t.tenant = ? ORDER BY rank LIMIT ?`)
        .all<TaskRow>(match, q.tenant, fetchN);
    } else {
      // status collation: todo < doing < blocked < done < cancelled (the natural board order).
      rows = this.db
        .prepare(`SELECT * FROM tasks WHERE tenant = ?
                   ORDER BY (CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'blocked' THEN 2
                             WHEN 'done' THEN 3 ELSE 4 END), priority, updated_at DESC LIMIT ?`)
        .all<TaskRow>(q.tenant, fetchN);
    }
    let tasks = rows.map(toTask);
    if (q.status) tasks = tasks.filter((t) => t.status === q.status);
    if (q.assignee) tasks = tasks.filter((t) => t.assignee === q.assignee);
    if (q.label) tasks = tasks.filter((t) => t.labels.includes(q.label!));
    return tasks.slice(0, limit);
  }

  /**
   * The one mutating path for edits. Apply changed fields, bump updated_*, and append one task_event per
   * meaningful change: a `status` event on transition, an `assign` event on reassignment, a `comment`
   * event for a note. Marking done/cancelled is just a status transition (no separate close call).
   */
  update(id: string, input: TaskUpdateInput): Task | null {
    const t = this.get(id);
    if (!t) return null;
    const now = Date.now();
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (input.title !== undefined && input.title.trim() && input.title.trim() !== t.title) {
      sets.push('title = ?'); vals.push(input.title.trim());
    }
    if (input.body !== undefined && input.body !== t.body) {
      sets.push('body = ?'); vals.push(input.body);
    }
    if (input.dueAt !== undefined && (input.dueAt ?? null) !== (t.dueAt ?? null)) {
      sets.push('due_at = ?'); vals.push(input.dueAt ?? null);
      this.addEvent(id, 'status', input.dueAt ? `due ${new Date(input.dueAt).toISOString().slice(0, 10)}` : 'due date cleared', input.by);
    }
    if (input.status && input.status !== t.status && STATUSES.includes(input.status)) {
      sets.push('status = ?'); vals.push(input.status);
      this.addEvent(id, 'status', `${t.status}→${input.status}`, input.by);
    }
    if (input.assignee !== undefined && (input.assignee ?? null) !== (t.assignee ?? null)) {
      sets.push('assignee = ?'); vals.push(input.assignee ?? null);
      this.addEvent(id, 'assign', input.assignee ? `→${input.assignee}` : '→unassigned', input.by);
    }
    if (input.priority !== undefined) { sets.push('priority = ?'); vals.push(clampPriority(input.priority)); }
    if (input.mode !== undefined) { sets.push('mode = ?'); vals.push(input.mode === 'interactive' ? 'interactive' : 'headless'); }
    if (input.labels !== undefined) { sets.push('labels = ?'); vals.push(JSON.stringify(input.labels)); }
    if (input.note && input.note.trim()) this.addEvent(id, 'comment', input.note.trim(), input.by);

    // Always stamp the editor even for a note-only edit, so "who touched this last" stays honest.
    sets.push('updated_at = ?'); vals.push(now);
    sets.push('updated_by = ?'); vals.push(input.by);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id)!;
  }

  /**
   * The pool-drain primitive. Atomically take an open task: if it's `todo` (or already assigned to this
   * agent) and not terminal, set assignee = agent:<id>, status = doing, last_session_id, and log a claim.
   * Returns null if it was already claimed by someone else (the loser sees null and moves on).
   */
  claim(id: string, agentId: string, sessionId: string): Task | null {
    const t = this.get(id);
    if (!t) return null;
    const me = `agent:${agentId}`;
    if (TERMINAL.has(t.status)) return null;
    if (t.assignee && t.assignee !== me) return null; // someone else holds it
    // Guarded UPDATE (the race resolver): only succeeds if still unclaimed-or-mine and non-terminal.
    const res = this.db
      .prepare(`UPDATE tasks SET assignee = ?, status = 'doing', last_session_id = ?, updated_at = ?, updated_by = ?
                 WHERE id = ? AND (assignee IS NULL OR assignee = ?) AND status NOT IN ('done','cancelled')`)
      .run(me, sessionId, Date.now(), me, id, me);
    if (res.changes === 0) return null;
    this.addEvent(id, 'claim', `${me} claimed`, me, sessionId);
    return this.get(id)!;
  }

  /** Dispatcher-only: mark a task as spawned (status=doing, attempts++, last_session_id) + log it. */
  markDispatched(id: string, sessionId: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
                 attempts = attempts + 1, last_session_id = ?, updated_at = ?, updated_by = 'system' WHERE id = ?`)
      .run(sessionId, Date.now(), id);
    this.addEvent(id, 'dispatch', `dispatched session ${sessionId}`, 'system', sessionId);
  }

  /** Hard delete + cascade the activity log (owner/admin at the route layer). */
  remove(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    if (res.changes === 0) return false;
    this.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(id);
    return true;
  }

  /** Per-status counts for the board column headers. */
  counts(tenant: string): Record<TaskStatus, number> {
    const out = { todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 } as Record<TaskStatus, number>;
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE tenant = ? GROUP BY status')
      .all<{ status: TaskStatus; n: number }>(tenant)) {
      if (r.status in out) out[r.status] = r.n;
    }
    return out;
  }

  /** Open tasks past their due date — the source for the overdue notification sweep. Soonest-due first. */
  overdue(tenant: string, now: number): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND due_at IS NOT NULL AND due_at < ?
                 AND status NOT IN ('done','cancelled') ORDER BY due_at`)
      .all<TaskRow>(tenant, now)
      .map(toTask);
  }

  /**
   * Record a one-time overdue marker in the activity log; returns true only the FIRST time so the sweep
   * DMs the owner exactly once (not every tick). The marker also shows in the timeline as "went overdue".
   */
  markOverdueNotified(id: string): boolean {
    const existing = this.db
      .prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'status' AND body = ? LIMIT 1`)
      .get<{ 1: number }>(id, OVERDUE_MARK);
    if (existing) return false;
    this.addEvent(id, 'status', OVERDUE_MARK, 'system');
    return true;
  }

  /** Tasks eligible for auto-dispatch: todo, assigned to an agent, auto_dispatch on. Priority-first. */
  dispatchable(tenant: string): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND status = 'todo' AND auto_dispatch = 1
                 AND assignee LIKE 'agent:%' ORDER BY priority, created_at`)
      .all<TaskRow>(tenant)
      .map(toTask);
  }

  /** Append one row to the append-only activity log. */
  private addEvent(taskId: string, kind: TaskEvent['kind'], body: string, author: string, sessionId?: string): void {
    this.db
      .prepare('INSERT INTO task_events (id, task_id, kind, body, author, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID().slice(0, 8), taskId, kind, body, author, sessionId ?? null, Date.now());
  }
}

function clampPriority(p?: number): number {
  if (p === undefined || !Number.isFinite(p)) return 2;
  return Math.max(0, Math.min(3, Math.round(p)));
}

/** Word tokens ORed as quoted FTS5 terms (quoting neutralises operator chars). '' → caller uses recency. */
function toFtsQuery(query?: string): string {
  if (!query) return '';
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || !tokens.length) return '';
  return [...new Set(tokens)].map((t) => `"${t}"`).join(' OR ');
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id, tenant: r.tenant, title: r.title, body: r.body, status: r.status as TaskStatus,
    priority: r.priority, labels: JSON.parse(r.labels) as string[], assignee: r.assignee ?? undefined,
    owner: r.owner ?? undefined, parentId: r.parent_id ?? undefined,
    mode: r.mode === 'interactive' ? 'interactive' : 'headless', autoDispatch: r.auto_dispatch === 1,
    dueAt: r.due_at ?? undefined, attempts: r.attempts, lastSessionId: r.last_session_id ?? undefined,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

function toEvent(r: EventRow): TaskEvent {
  return {
    id: r.id, taskId: r.task_id, kind: r.kind as TaskEvent['kind'], body: r.body ?? undefined,
    author: r.author, sessionId: r.session_id ?? undefined, createdAt: r.created_at,
  };
}
