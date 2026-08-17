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
import { newId } from '../id';
import { Db } from './db';
import { Goal, GoalCreateInput, GoalEvent, GoalEventTask, GoalProgress, GoalQuery, GoalStatus, GoalUpdateInput, TaskStatus } from '../types';

/** How close a task NOTE has to sit to a status transition to be read as that transition's reason.
 *  `TaskStore.update` writes both rows inside one call, so in practice they share a millisecond; the
 *  window only tolerates a slow write, never an unrelated later comment.
 *
 *  The lookup that uses this orders by the comment's OWN columns, never by a correlated expression over
 *  the outer row (`ABS(c.created_at - e.created_at)`): older SQLite builds — including the one bundled with
 *  the Node that CI runs — reject a correlated reference inside a subquery's ORDER BY with a bare
 *  "no such column", while newer ones accept it. Inside a 2s window "newest in the window" and "closest to
 *  the transition" are the same row anyway. */
const NOTE_WINDOW_MS = 2_000;

interface GoalRow {
  id: string; tenant: string; title: string; body: string; status: string;
  target: string | null; owner: string | null; parent_id: string | null; labels: string;
  due_at: number | null; created_by: string; created_at: number; updated_at: number; updated_by: string;
  rank?: number;
}
interface EventRow {
  id: string; goal_id: string; kind: string; body: string | null; author: string; created_at: number;
}
/** One linked-task event joined to its task — the raw shape {@link GoalStore.timeline} derives from. */
interface TaskEventRow {
  id: string; kind: string; body: string | null; author: string; created_at: number;
  session_id: string | null; task_id: string; task_title: string; task_status: string; note: string | null;
}

/**
 * Normalise a task event to the goal timeline's verb, or null when it isn't a milestone.
 *
 * Two paths mean "work started" and only one of them is a status row: `markDispatched` moves the task to
 * `doing` with a bare UPDATE + a `dispatch` event (no status row), while a human dragging the card writes
 * `todo→doing`. Both collapse to `started`. Everything else with an arrow in its body maps by destination;
 * a status row WITHOUT one (a due-date change, the overdue mark, a stranded-run marker) is not a milestone.
 */
function milestoneVerb(kind: string, body: string | null): GoalEventTask['verb'] | null {
  if (kind === 'dispatch') return 'started';
  const to = /→(\w+)$/.exec(body ?? '')?.[1];
  switch (to) {
    case 'todo': return body?.startsWith('→') ? 'filed' : 'reopened'; // '→todo' = created; 'done→todo' = reopened
    case 'doing': return 'started';
    case 'blocked': return 'blocked';
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
    default: return null;
  }
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
  kind: 'created' | 'status' | 'proposed' | 'ready';
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
    const id = newId('goal');
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

  /** A goal + its full activity timeline (oldest first) — {@link timeline}, so the goal's own history and
   *  the milestones of the work under it read as ONE story. */
  withEvents(id: string): { goal: Goal; events: GoalEvent[] } | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    return { goal, events: this.timeline(id) };
  }

  /** Just the goal's OWN events (no task milestones) — the raw `goal_events` rows. */
  events(id: string): GoalEvent[] {
    return this.db
      .prepare('SELECT * FROM goal_events WHERE goal_id = ? ORDER BY created_at ASC, id ASC')
      .all<EventRow>(id)
      .map(toEvent);
  }

  /**
   * The goal's activity timeline: its own `goal_events` MERGED with the milestones of every task linked to
   * it, oldest first.
   *
   * A goal whose only stored events are "→draft" and "draft→active" reads as dead even while eight tasks
   * are being planned, dispatched, blocked and finished underneath it — the work IS the goal's story, and
   * it was all one table away. Task milestones are therefore DERIVED here, not copied into `goal_events`
   * on write: nothing can drift out of sync, and a goal that predates this code gets its whole history
   * retroactively (which is what an empty Activity tab on a busy goal actually needed).
   *
   * "Milestone" is deliberately narrow — filed / started / blocked / done / cancelled / reopened, plus a
   * dispatch (a run starting). Comments, assignments, attachments, dependency edits and due-date changes
   * stay on the task where they belong; a goal timeline that mirrored the whole board would be unreadable.
   * The exception is the NOTE that came with a blocked/done transition (same author, same instant): that
   * note is the *reason*, which is the one thing a person reading the goal wants, so it rides along as the
   * entry's body.
   */
  timeline(id: string): GoalEvent[] {
    const own = this.events(id);
    const rows = this.db
      .prepare(
        `SELECT e.id AS id, e.kind AS kind, e.body AS body, e.author AS author, e.created_at AS created_at,
                e.session_id AS session_id, t.id AS task_id, t.title AS task_title, t.status AS task_status,
                (SELECT c.body FROM task_events c
                  WHERE c.task_id = e.task_id AND c.kind = 'comment' AND c.author = e.author
                    AND c.created_at >= e.created_at - ${NOTE_WINDOW_MS}
                    AND c.created_at <= e.created_at + ${NOTE_WINDOW_MS}
                  ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS note
           FROM task_events e JOIN tasks t ON t.id = e.task_id
          WHERE t.goal_id = ? AND (e.kind = 'dispatch' OR (e.kind = 'status' AND e.body LIKE '%→%'))
          ORDER BY e.created_at ASC, e.id ASC`,
      )
      .all<TaskEventRow>(id);
    const derived: GoalEvent[] = [];
    for (const r of rows) {
      const verb = milestoneVerb(r.kind, r.body);
      if (!verb) continue; // a non-milestone status row (due date, overdue mark, stranded marker)
      derived.push({
        id: `task:${r.id}`, // namespaced so it can't collide with a goal_events id in a React key
        goalId: id,
        kind: 'task',
        // The reason, when the mover left one. Only for the states where "why" is the point — a `filed`
        // or `started` entry with a stray note attached would just repeat the task title.
        body: (verb === 'blocked' || verb === 'done' || verb === 'cancelled') && r.note ? r.note : undefined,
        author: r.author,
        createdAt: r.created_at,
        task: {
          id: r.task_id, title: r.task_title, status: r.task_status as TaskStatus, verb,
          sessionId: r.session_id ?? undefined,
        },
      });
    }
    return [...own, ...derived].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
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
   * The auto-planner's trigger set: active goals with **no work filed at all** (never planned, or every
   * linked task cancelled) that haven't been edited within `graceMs` — so a goal you're still writing
   * isn't grabbed. Oldest-idle first.
   *
   * Deliberately EXCLUDES a goal whose filed work is all *done*: that isn't stalled, it's finished and
   * waiting on a human to sign it off ({@link readyToClose}). Planning it would invent fresh work for a
   * completed goal, which is what the old "no OPEN task" predicate did.
   */
  stuck(tenant: string, graceMs: number, now: number): Goal[] {
    return this.db
      .prepare(
        `SELECT * FROM goals g WHERE g.tenant = ? AND g.status = 'active' AND g.updated_at < ?
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status != 'cancelled')
         ORDER BY g.updated_at ASC`,
      )
      .all<GoalRow>(tenant, now - graceMs)
      .map(toGoal);
  }

  /**
   * Goals whose work is COMPLETE but whose status still says `active` — every leaf task linked to them is
   * done (and there's at least one), matching {@link progress}'s 100%. Completion is *derived*; the goal
   * does NOT self-close, because "all the filed tasks are done" is not the same claim as "the outcome was
   * achieved" — the plan may simply have been incomplete. So this is a proposal set: the console flags it
   * and the owner confirms (or plans the gap). Oldest-idle first.
   */
  readyToClose(tenant: string): Goal[] {
    return this.db
      .prepare(
        `SELECT * FROM goals g WHERE g.tenant = ? AND g.status = 'active'
           AND EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status != 'cancelled'
                        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id))
           AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.status NOT IN ('done','cancelled')
                        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id))
         ORDER BY g.updated_at ASC`,
      )
      .all<GoalRow>(tenant)
      .map(toGoal);
  }

  /**
   * Announce that a goal's work is complete — append the `ready` timeline event and fire the notifier, so
   * the owner learns their goal finished instead of having to notice a full progress bar. Idempotent per
   * *completion streak*: returns false when a `ready` event already sits newer than the most recently
   * touched linked task. If more work is later filed under the goal and finished, that task's `updated_at`
   * moves past the old event and the goal announces again — one notice per time it actually completes.
   */
  announceReady(goalId: string, by = 'system'): boolean {
    const goal = this.get(goalId);
    if (!goal) return false;
    const last = this.db
      .prepare(
        `SELECT (SELECT MAX(created_at) FROM goal_events WHERE goal_id = ? AND kind = 'ready') AS announced,
                (SELECT MAX(updated_at) FROM tasks WHERE goal_id = ?) AS worked`,
      )
      .get<{ announced: number | null; worked: number | null }>(goalId, goalId);
    if (last?.announced && last.announced >= (last.worked ?? 0)) return false; // already announced this streak
    this.addEvent(goalId, 'ready', 'all linked work is done — ready to close', by);
    this.notify({ goal, kind: 'ready', by });
    return true;
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

  /**
   * Hard delete + cascade the activity log. Detaches (never deletes) related work: child GOALS lose their
   * parent_id, and linked TASKS lose their goal_id — a task is real work that may still be valid, so
   * deleting its goal unlinks it (leaving it on the board) rather than destroying it. Each detached task
   * gets a timeline note so the unlink is traceable.
   */
  remove(id: string): boolean {
    const res = this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    if (res.changes === 0) return false;
    this.db.prepare('DELETE FROM goal_events WHERE goal_id = ?').run(id);
    this.db.prepare('UPDATE goals SET parent_id = NULL WHERE parent_id = ?').run(id);
    for (const t of this.db.prepare('SELECT id FROM tasks WHERE goal_id = ?').all<{ id: string }>(id)) {
      this.db
        .prepare('INSERT INTO task_events (id, task_id, kind, body, author, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId('goalEvent'), t.id, 'link', 'goal deleted — detached', 'system', null, Date.now());
    }
    this.db.prepare('UPDATE tasks SET goal_id = NULL WHERE goal_id = ?').run(id);
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

  /**
   * Derive a goal's progress from the tasks linked to it (tasks.goal_id) — never a hand-maintained number,
   * so it can't rot. `percent` = done ÷ (non-cancelled linked tasks); 0 when nothing is linked yet.
   */
  progress(goalId: string): GoalProgress {
    const byStatus = { todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 } as Record<TaskStatus, number>;
    // Count LEAF linked tasks only — a task that has sub-tasks is a grouping/umbrella (its children carry
    // the real work), so counting both it and its children would double-count and lag the bar.
    for (const r of this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM tasks t WHERE t.goal_id = ?
                 AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id) GROUP BY status`)
      .all<{ status: TaskStatus; n: number }>(goalId)) {
      if (r.status in byStatus) byStatus[r.status] = r.n;
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const counted = total - byStatus.cancelled; // cancelled work doesn't count against the goal
    const done = byStatus.done;
    const percent = counted > 0 ? Math.round((done / counted) * 100) : 0;
    return { total, done, counted, percent, byStatus };
  }

  /** Append one row to the append-only activity log. */
  private addEvent(goalId: string, kind: GoalEvent['kind'], body: string, author: string): void {
    this.db
      .prepare('INSERT INTO goal_events (id, goal_id, kind, body, author, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('goalEvent'), goalId, kind, body, author, Date.now());
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

/** A stored `goal_events` row → the shared {@link GoalEvent} shape (no `task`; that's timeline-derived). */
function toEvent(r: EventRow): GoalEvent {
  return {
    id: r.id, goalId: r.goal_id, kind: r.kind as GoalEvent['kind'], body: r.body ?? undefined,
    author: r.author, createdAt: r.created_at,
  };
}
