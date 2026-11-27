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
import { newId } from '../id';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from './db';
import { TASK_BLOCKED_ON, Task, TaskAttachment, TaskCreateInput, TaskEvent, TaskQuery, TaskStatus, TaskUpdateInput } from '../types';

interface TaskRow {
  id: string; tenant: string; title: string; body: string; status: string; priority: number;
  labels: string; assignee: string | null; suggested_assignee?: string | null; owner: string | null; parent_id: string | null;
  mode: string; model: string | null; effort: string | null; auto_dispatch: number; goal_id: string | null; bet_id?: string | null; criteria: string | null;
  caller_agent: string | null; caller_claude_id: string | null; poke_on_done: number;
  blocked_on: string | null;
  due_at: number | null; attempts: number; last_session_id: string | null;
  created_by: string; created_at: number; updated_at: number; updated_by: string;
  external_key?: string | null;
  archived_at?: number | null; archived_reason?: string | null; archived_from?: string | null;
  rank?: number;
}
interface EventRow {
  id: string; task_id: string; kind: string; body: string | null; author: string;
  session_id: string | null; created_at: number;
}
interface AttachmentRow {
  id: string; task_id: string; tenant: string; filename: string; rel_path: string;
  mime: string; bytes: number; uploaded_by: string; created_at: number;
}

export type AttachResult = { ok: true; attachment: TaskAttachment } | { ok: false; error: string };

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled']);
const STATUSES: readonly TaskStatus[] = ['proposed', 'todo', 'doing', 'blocked', 'done', 'cancelled'];
/** Sentinel body for the one-time "went overdue" event that dedupes the overdue notification. */
const OVERDUE_MARK = '⏰ went overdue';
/** Sentinel body for the one-time "its run ended without closing this" event, per stranding SESSION — so a
 *  task stranded twice (re-dispatched, stranded again) wakes its caller once per dead run, not once ever. */
const strandedMark = (sessionId: string): string => `⚠️ run ended without closing this (${sessionId})`;
/** Sentinel body for the one-time "the caller agent was not woken with this result" event. The completion
 *  poke is deliberately dropped when the caller is not running (see `edge/wakeups.ts`), and a drop with no
 *  trace reads exactly like a lost poke — this is where the silence becomes legible. */
const wakeDroppedMark = (agent: string): string => `💤 ${agent} was not woken — it had no live run, so the result stands here`;

/**
 * What the {@link TaskStore} notifier sink receives on a meaningful task change. The store stays
 * db-only and layer-clean — it just fires a domain event; the edge wiring (tenant-registry) decides
 * whether it merits an inbox card, resolves the receiver via an `Audience`, and DMs them. Mirrors
 * `Automations.setOverdueNotifier`. `by` is the actor (member id | `agent:<id>`) so the wiring can
 * suppress self-notification.
 */
export interface TaskNotice {
  task: Task;
  kind: 'created' | 'assigned' | 'status';
  by: string;
  detail?: string;
  /** The comment filed in the SAME update, if any — e.g. the answer typed on a blocked card. */
  note?: string;
}

export class TaskStore {
  /** `dir` = `<home>/task-attachments/`, where attached files snapshot to. Undefined (demo/tests on
   *  `:memory:`) disables attachments. Task ROWS are still db-only (§Decision 2); only files hit disk. */
  constructor(private readonly db: Db, private readonly dir?: string) {}

  /** Are file attachments available? (Needs a data home; off for demo/tests on `:memory:`.) */
  get attachmentsEnabled(): boolean { return !!this.dir; }

  private notifier?: (n: TaskNotice) => void;
  /** Register the sink fired on task create / (re)assignment / status change. Best-effort, post-construction
   *  (wired in tenant-registry once the TerminalManager exists), like the other notifier sinks. */
  setNotifier(fn: (n: TaskNotice) => void): void { this.notifier = fn; }
  private notify(n: TaskNotice): void { try { this.notifier?.(n); } catch { /* notifications are advisory */ } }

  /** Create a task, log its opening `status` event, and (for a sub-task) `link` it on the parent. */
  create(input: TaskCreateInput): Task {
    const now = Date.now();
    const id = newId('task');
    const labels = input.labels ?? [];
    const priority = clampPriority(input.priority);
    const mode = input.mode === 'interactive' ? 'interactive' : 'headless';
    const model = input.model?.trim() || null;
    const effort = input.effort?.trim() || null;
    const status: TaskStatus = input.status === 'proposed' ? 'proposed' : 'todo';
    // A sub-task inherits its parent's goal when it doesn't name one — so a strategist's umbrella + its
    // sub-tasks all roll up to the same goal without the agent stamping goalId on every child.
    let goalId = input.goalId ?? null;
    let betId = input.betId ?? null;
    if (!goalId && !betId && input.parentId) {
      const parent = this.db.prepare('SELECT goal_id, bet_id FROM tasks WHERE id = ?').get<{ goal_id: string | null; bet_id: string | null }>(input.parentId);
      goalId = parent?.goal_id ?? null;
      betId = parent?.bet_id ?? null;
    }
    // A bet belongs to exactly one goal, so the bet decides it: a task can't serve a bet on goal A while
    // counting toward goal B. An unknown bet id is dropped rather than stored as a dangling pointer.
    if (betId) {
      const betGoal = this.betGoal(betId);
      if (betGoal) goalId = betGoal; else betId = null;
    }
    this.db
      .prepare(`INSERT INTO tasks
        (id, tenant, title, body, status, priority, labels, assignee, owner, parent_id, mode, model, effort, auto_dispatch,
         goal_id, criteria, caller_agent, caller_claude_id, poke_on_done, due_at, attempts, last_session_id,
         created_by, created_at, updated_at, updated_by, external_key, suggested_assignee, bet_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id, input.tenant, input.title.trim() || 'Untitled task', input.body ?? '', status, priority,
        JSON.stringify(labels), this.canonicalAssignee(input.assignee) ?? null, input.owner ?? null, input.parentId ?? null,
        mode, model, effort, input.autoDispatch ? 1 : 0, goalId, oneLine(input.criteria),
        input.callerAgent ?? null, input.callerClaudeId ?? null, input.pokeOnDone ? 1 : 0,
        input.dueAt ?? null, input.createdBy, now, now, input.createdBy, input.externalKey ?? null,
        this.canonicalAssignee(input.suggestedAssignee) ?? null, betId,
      );
    if (goalId && this.db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goalId)) {
      this.addEvent(id, 'link', `goal:${goalId}${input.linkedVia ? ` (from ${input.linkedVia})` : ''}`, input.createdBy);
    }
    if (betId) this.addEvent(id, 'link', `bet:${betId}`, input.createdBy);
    this.addEvent(id, 'status', `→${status}`, input.createdBy);
    if (input.parentId && this.get(input.parentId)) this.addEvent(input.parentId, 'link', `task:${id}`, input.createdBy);
    if (input.dependsOn && input.dependsOn.length) this.setDeps(id, input.dependsOn, input.createdBy);
    const task = this.get(id)!;
    this.notify({ task, kind: 'created', by: input.createdBy });
    return task;
  }

  /** The goal a bet belongs to, or undefined for an unknown bet. Read straight off the `bets` table so the
   *  store stays free of a BetStore dependency (the same way `create` checks `goals`). */
  private betGoal(betId: string): string | undefined {
    try {
      return this.db.prepare('SELECT goal_id FROM bets WHERE id = ?').get<{ goal_id: string }>(betId)?.goal_id ?? undefined;
    } catch { return undefined; }
  }

  /** Task counts per bet for a set of bets — the Bets board's "n of m tasks done" line. One query. */
  betTaskCounts(betIds: readonly string[]): Record<string, { total: number; done: number; open: number }> {
    const out: Record<string, { total: number; done: number; open: number }> = {};
    if (!betIds.length) return out;
    const rows = this.db
      .prepare(`SELECT bet_id AS bet, COUNT(*) AS total, SUM(status = 'done') AS done,
                       SUM(status IN ('todo','doing','blocked')) AS open
                FROM tasks WHERE bet_id IN (${betIds.map(() => '?').join(', ')}) AND status != 'cancelled' GROUP BY bet_id`)
      .all<{ bet: string; total: number; done: number; open: number }>(...betIds);
    for (const r of rows) out[r.bet] = { total: r.total, done: r.done ?? 0, open: r.open ?? 0 };
    return out;
  }

  get(id: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get<TaskRow>(id);
    return r ? this.withDeps(toTask(r)) : undefined;
  }

  /** A member's tasks — assigned to them, filed by them, or run as them — most recently active first.
   *  Backs `/agentric tasks`: "mine" has to cover what I asked for as well as what I was handed. */
  forMember(tenant: string, memberId: string, statuses: readonly TaskStatus[], limit: number): Task[] {
    const marks = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND (assignee = ? OR created_by = ? OR owner = ?)
                 AND status IN (${marks}) ORDER BY updated_at DESC LIMIT ?`)
      .all<TaskRow>(tenant, memberId, memberId, memberId, ...statuses, limit)
      .map(toTask);
  }

  /** The task mirroring an outside record (`clickup:<ticket id>`), if one was ever linked. */
  byExternalKey(tenant: string, key: string): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE tenant = ? AND external_key = ?').get<TaskRow>(tenant, key);
    return r ? this.withDeps(toTask(r)) : undefined;
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
   * The newest free-text comment on a task — the closing "what I did" note a delegate leaves when it calls
   * task_update({ status:"done", note }). Ordered by insertion (created_at, then the monotonic rowid) so it
   * is unambiguous even when several events land in the same millisecond. Feeds the `task_wait` result.
   */
  latestNote(id: string): string | undefined {
    const r = this.db
      .prepare("SELECT body FROM task_events WHERE task_id = ? AND kind = 'comment' AND body IS NOT NULL AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get<{ body: string }>(id);
    return r?.body ?? undefined;
  }

  /**
   * Board query. FTS (bm25) when `query` is set, else ordered by status, then priority, then most-recently
   * updated. status/assignee/label filter in SQL/JS. Mirrors KbStore.search.
   */
  list(q: TaskQuery): Task[] {
    const limit = Math.max(1, Math.min(q.limit ?? 100, 500));
    const match = toFtsQuery(q.query);
    // `status`/`assignee` are pushed into SQL (assignee rides `idx_tasks_assignee(tenant, assignee)`), so
    // the LIMIT applies to rows that already match instead of over-fetching 5× the board and dropping
    // most of it in JS — the JS pass below stays as the exactness guard. `label` has no column of its own
    // (labels are a JSON array), so it keeps the over-fetch: a LIKE would match a substring of a
    // different label, and being wrong is worse than reading 5× rows for the one filter that needs it.
    const fetchN = q.label ? limit * 5 : limit;
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.assignee) { where.push('assignee = ?'); args.push(q.assignee); }
    let rows: TaskRow[];
    if (match) {
      const extra = where.map((w) => ` AND t.${w}`).join('');
      rows = this.db
        .prepare(`SELECT t.*, bm25(tasks_fts) AS rank FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid
                   WHERE tasks_fts MATCH ? AND t.tenant = ?${extra} ORDER BY rank LIMIT ?`)
        .all<TaskRow>(match, q.tenant, ...args, fetchN);
    } else {
      // status collation: proposed < todo < doing < blocked < done < cancelled (the natural board order).
      const extra = where.map((w) => ` AND ${w}`).join('');
      rows = this.db
        .prepare(`SELECT * FROM tasks WHERE tenant = ?${extra}
                   ORDER BY (CASE status WHEN 'proposed' THEN -1 WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 WHEN 'blocked' THEN 2
                             WHEN 'done' THEN 3 ELSE 4 END), priority, updated_at DESC LIMIT ?`)
        .all<TaskRow>(q.tenant, ...args, fetchN);
    }
    let tasks = rows.map(toTask);
    if (q.status) tasks = tasks.filter((t) => t.status === q.status);
    if (q.assignee) tasks = tasks.filter((t) => t.assignee === q.assignee);
    if (q.label) tasks = tasks.filter((t) => t.labels.includes(q.label!));
    return this.attachDeps(tasks.slice(0, limit));
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
    let statusChange: string | undefined;
    if (input.status && input.status !== t.status && STATUSES.includes(input.status)) {
      sets.push('status = ?'); vals.push(input.status);
      statusChange = `${t.status}→${input.status}`;
      this.addEvent(id, 'status', statusChange, input.by);
      // Any deliberate status move takes a task out of the cleanup archive — reopening an archived task
      // by dragging it back on the board is a restore, and a later human cancel is a decision, not cleanup.
      if (t.archivedAt) sets.push('archived_at = NULL', 'archived_reason = NULL', 'archived_from = NULL');
    }
    // `blocked_on` travels with the blocked state and only with it: an explicit value is kept when the task
    // is (or is becoming) blocked, and any move OFF blocked clears it, so a stale "waiting on the founder"
    // can never outlive the wait and misroute a later wake-up.
    const nextStatus = input.status && STATUSES.includes(input.status) ? input.status : t.status;
    if (nextStatus !== 'blocked') {
      if (t.blockedOn) { sets.push('blocked_on = ?'); vals.push(null); }
    } else if (input.blockedOn !== undefined) {
      const v = input.blockedOn && (TASK_BLOCKED_ON as readonly string[]).includes(input.blockedOn) ? input.blockedOn : null;
      if (v !== (t.blockedOn ?? null)) { sets.push('blocked_on = ?'); vals.push(v); }
    }
    // Accepting a proposal that has no assignee yet takes the proposing agent's suggestion — "accept" means
    // accept it as proposed. An explicit assignee in the same edit (the reviewer's own pick) wins.
    let assignee = input.assignee === undefined ? undefined : (this.canonicalAssignee(input.assignee) ?? null);
    if (assignee === undefined && t.status === 'proposed' && nextStatus !== 'proposed' && nextStatus !== 'cancelled'
      && !t.assignee && t.suggestedAssignee) assignee = t.suggestedAssignee;
    let reassigned = false;
    if (assignee !== undefined && (assignee ?? null) !== (t.assignee ?? null)) {
      sets.push('assignee = ?'); vals.push(assignee ?? null);
      reassigned = true;
      this.addEvent(id, 'assign', assignee ? `→${assignee}` : '→unassigned', input.by);
    }
    const suggested = input.suggestedAssignee === undefined ? undefined : (this.canonicalAssignee(input.suggestedAssignee) ?? null);
    if (suggested !== undefined && suggested !== (t.suggestedAssignee ?? null)) {
      sets.push('suggested_assignee = ?'); vals.push(suggested);
      this.addEvent(id, 'assign', suggested ? `suggested ${suggested}` : 'suggestion withdrawn', input.by);
    }
    if (input.priority !== undefined) { sets.push('priority = ?'); vals.push(clampPriority(input.priority)); }
    if (input.mode !== undefined) { sets.push('mode = ?'); vals.push(input.mode === 'interactive' ? 'interactive' : 'headless'); }
    // Goal and bet move together. Linking a bet sets the goal to the bet's own; re-pointing the goal
    // somewhere the current bet doesn't belong drops the bet (it would otherwise count toward two goals).
    let nextGoal = input.goalId === undefined ? (t.goalId ?? null) : (input.goalId ?? null);
    let nextBet = input.betId === undefined ? (t.betId ?? null) : (input.betId ?? null);
    if (input.betId) {
      const betGoal = this.betGoal(input.betId);
      if (betGoal) nextGoal = betGoal; else nextBet = t.betId ?? null; // unknown bet → leave as it was
    } else if (nextBet && input.goalId !== undefined && this.betGoal(nextBet) !== nextGoal) {
      nextBet = null;
    }
    if (nextGoal !== (t.goalId ?? null)) {
      sets.push('goal_id = ?'); vals.push(nextGoal);
      this.addEvent(id, 'link', nextGoal ? `goal:${nextGoal}` : 'unlinked from goal', input.by);
    }
    if (nextBet !== (t.betId ?? null)) {
      sets.push('bet_id = ?'); vals.push(nextBet);
      this.addEvent(id, 'link', nextBet ? `bet:${nextBet}` : 'unlinked from bet', input.by);
    }
    if (input.criteria !== undefined) { sets.push('criteria = ?'); vals.push(oneLine(input.criteria)); }
    if (input.dependsOn !== undefined) this.setDeps(id, input.dependsOn, input.by); // join table, not a task column
    if (input.labels !== undefined) { sets.push('labels = ?'); vals.push(JSON.stringify(input.labels)); }
    if (input.note && input.note.trim()) this.addEvent(id, 'comment', input.note.trim(), input.by);

    // Always stamp the editor even for a note-only edit, so "who touched this last" stays honest.
    sets.push('updated_at = ?'); vals.push(now);
    sets.push('updated_by = ?'); vals.push(input.by);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const task = this.get(id)!;
    // Fire the notices AFTER the write so the snapshot reflects the change. Reassignment first (the new
    // assignee's "assigned to you"), then any status transition (owner's "blocked"/"done"); the edge
    // wiring filters which merit a card + resolves the receiver.
    // …except when the same edit takes it OUT of `proposed`: the accept's status notice is what tells the
    // assignee (the "assigned to you" a proposal holds back), so a second one here would double it.
    if (reassigned && !statusChange?.startsWith('proposed→')) this.notify({ task, kind: 'assigned', by: input.by });
    if (statusChange) this.notify({ task, kind: 'status', by: input.by, detail: statusChange, ...(input.note?.trim() ? { note: input.note.trim() } : {}) });
    return task;
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
    // A proposal isn't work yet — nobody may pick it up until a human accepts it onto the board.
    if (t.status === 'proposed') return null;
    if (t.assignee && t.assignee !== me) return null; // someone else holds it
    // Guarded UPDATE (the race resolver): only succeeds if still unclaimed-or-mine and non-terminal.
    const res = this.db
      .prepare(`UPDATE tasks SET assignee = ?, status = 'doing', last_session_id = ?, updated_at = ?, updated_by = ?
                 WHERE id = ? AND (assignee IS NULL OR assignee = ?) AND status NOT IN ('done','cancelled','proposed')`)
      .run(me, sessionId, Date.now(), me, id, me);
    if (res.changes === 0) return null;
    this.addEvent(id, 'claim', `${me} claimed`, me, sessionId);
    return this.get(id)!;
  }

  /**
   * A human's verdict on an agent's PROPOSED task: accept moves it onto the board (`todo`), dismiss drops it
   * (`cancelled`, so the record and its author survive — a dismissal is data about what an agent thought
   * was work). A plain status transition through {@link update}, so the notifier fires exactly as for any
   * other move: the Inbox proposal card closes and a human assignee gets their "assigned to you" only now.
   * Returns undefined when the task is gone or is no longer a proposal (someone already decided).
   */
  decideProposal(id: string, accept: boolean, by: string): Task | undefined {
    const t = this.get(id);
    if (!t || t.status !== 'proposed') return undefined;
    return this.update(id, { status: accept ? 'todo' : 'cancelled', note: accept ? 'accepted onto the board' : 'proposal dismissed', by }) ?? undefined;
  }

  /** Dispatcher-only: mark a task as spawned (status=doing, attempts++, last_session_id) + log it. */
  markDispatched(id: string, sessionId: string): void {
    this.db
      .prepare(`UPDATE tasks SET status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END,
                 attempts = attempts + 1, last_session_id = ?, updated_at = ?, updated_by = 'system' WHERE id = ?`)
      .run(sessionId, Date.now(), id);
    this.addEvent(id, 'dispatch', `dispatched session ${sessionId}`, 'system', sessionId);
  }

  /** Hard delete + cascade the activity log, attachment rows, and the on-disk attachment dir. */
  remove(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    if (res.changes === 0) return false;
    this.db.prepare('DELETE FROM task_events WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM task_deps WHERE task_id = ? OR depends_on = ?').run(id, id);
    if (this.dir) fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  // ── Assignee identity ───────────────────────────────────────────────────────────────────────────
  // `assignee` is `agent:<id>` or a MEMBER ID — but nothing enforced the second half, so every path that
  // took a person from free text (an agent writing "vikas@…", "member:vikas@…", "janak", the string
  // "null", a member literally named "Owner") stored it verbatim. The board's "Mine" filter compares
  // against the member id, so one person's tasks were split across three spellings and most of them
  // never showed up as theirs. One resolver, applied on every write and swept over existing rows.

  /**
   * The canonical form of an assignee reference: `agent:<id>` untouched, a person resolved to their
   * member id (from an id, an email, `member:<id|email>`, or an unambiguous display name / email local
   * part), and the empty-ish spellings (`''`, `null`, `undefined`, `none`, `unassigned`) to `null`.
   * Something that resolves to nobody is returned AS GIVEN — the store never destroys data it can't
   * interpret; refusing an unresolvable assignee is the caller's job (see {@link resolvesToAssignee}).
   * `undefined` passes through so "field not in this edit" keeps meaning that.
   */
  canonicalAssignee(raw: string | null | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    let v = String(raw).trim();
    if (!v || /^(null|undefined|none|unassigned|nobody|-)$/i.test(v)) return null;
    if (v.startsWith('agent:')) return v;
    if (v.toLowerCase().startsWith('member:')) v = v.slice('member:'.length).trim();
    const byId = this.db.prepare('SELECT id FROM members WHERE id = ?').get<{ id: string }>(v);
    if (byId) return byId.id;
    const byEmail = this.db.prepare('SELECT id FROM members WHERE email = ?').get<{ id: string }>(v.toLowerCase());
    if (byEmail) return byEmail.id;
    // A bare name: match a display name or an email local part, but only when exactly one member fits —
    // guessing between two Janaks would assign the work to the wrong person, which is worse than leaving it.
    if (!v.includes('@')) {
      const hits = this.db
        .prepare(`SELECT id FROM members WHERE lower(name) = ? OR lower(substr(email, 1, instr(email, '@') - 1)) = ?`)
        .all<{ id: string }>(v.toLowerCase(), v.toLowerCase());
      const ids = [...new Set(hits.map((h) => h.id))];
      if (ids.length === 1) return ids[0];
    }
    return v;
  }

  /** Does this reference name somebody a task can actually be assigned to? Agents are checked by the
   *  caller (manifests aren't in the DB); this answers for people. */
  resolvesToMember(raw: string): boolean {
    const c = this.canonicalAssignee(raw);
    return !!c && !c.startsWith('agent:') && !!this.db.prepare('SELECT 1 FROM members WHERE id = ?').get(c);
  }

  /**
   * Rewrite every stored assignee / suggested assignee that isn't already canonical. Idempotent and cheap
   * after the first pass (only rows that are neither `agent:*` nor an existing member id are visited).
   * Logs an `assign` event on each rewritten task so the change is visible in its timeline.
   */
  normalizeAssignees(tenant: string): number {
    let changed = 0;
    for (const col of ['assignee', 'suggested_assignee'] as const) {
      const rows = this.db
        .prepare(`SELECT id, ${col} AS v FROM tasks WHERE tenant = ? AND ${col} IS NOT NULL
                   AND ${col} NOT LIKE 'agent:%' AND ${col} NOT IN (SELECT id FROM members)`)
        .all<{ id: string; v: string }>(tenant);
      for (const r of rows) {
        const c = this.canonicalAssignee(r.v);
        if (c === r.v) continue; // unresolvable — leave it for a human rather than guess
        this.db.prepare(`UPDATE tasks SET ${col} = ? WHERE id = ?`).run(c ?? null, r.id);
        this.addEvent(r.id, 'assign', `${col === 'assignee' ? '' : 'suggested '}${r.v} → ${c ?? 'unassigned'} (normalized)`, 'system');
        changed++;
      }
    }
    return changed;
  }

  // ── Cleanup archive ─────────────────────────────────────────────────────────────────────────────
  // See src/edge/task-hygiene.ts for WHICH tasks get archived. These are the write primitives. Both are
  // SILENT (no notifier): a cleanup pass touching a thousand dead tasks must not post a thousand Inbox
  // cards, DM a thousand owners, or wake a thousand callers. The audit line + timeline event carry it.

  /** Archive one open task (→ `cancelled`, remembering where it came from). False when it's already
   *  closed, gone, or was touched after `staleBefore` (a racing edit wins over a stale plan). */
  archive(id: string, reason: string, opts: { by?: string; staleBefore?: number } = {}): boolean {
    const by = opts.by ?? 'system';
    const now = Date.now();
    const res = this.db
      .prepare(`UPDATE tasks SET archived_from = status, status = 'cancelled', blocked_on = NULL,
                 archived_at = ?, archived_reason = ?, updated_at = ?, updated_by = ?
                 WHERE id = ? AND status NOT IN ('done','cancelled') AND updated_at < ?`)
      .run(now, reason, now, by, id, opts.staleBefore ?? now + 1);
    if (!res.changes) return false;
    const from = this.db.prepare('SELECT archived_from FROM tasks WHERE id = ?').get<{ archived_from: string }>(id)?.archived_from ?? 'todo';
    this.addEvent(id, 'status', `${from}→cancelled`, by);
    // The reason rides a non-milestone `status` row, NOT a comment: `latestNote` reads the newest comment
    // as the task's RESULT (what a waiting caller is told), and bookkeeping must never become an answer.
    this.addEvent(id, 'status', `🗄 archived by board cleanup: ${reason}`, by);
    return true;
  }

  /** Silently move an open task to another OPEN status with a timeline marker — the cleanup pass's
   *  correction of a status that stopped being true (`doing` with nobody doing it). */
  settle(id: string, to: 'todo' | 'blocked', mark: string, opts: { by?: string; staleBefore?: number } = {}): boolean {
    const by = opts.by ?? 'system';
    const now = Date.now();
    const cur = this.get(id);
    if (!cur || TERMINAL.has(cur.status) || cur.status === to) return false;
    const res = this.db
      .prepare(`UPDATE tasks SET status = ?, blocked_on = NULL, updated_at = ?, updated_by = ?
                 WHERE id = ? AND status = ? AND updated_at < ?`)
      .run(to, now, by, id, cur.status, opts.staleBefore ?? now + 1);
    if (!res.changes) return false;
    this.addEvent(id, 'status', `${cur.status}→${to}`, by);
    this.addEvent(id, 'status', mark, by);
    return true;
  }

  /** Put an archived task back where it was (a `doing` with no run comes back as `todo`). Goes through
   *  {@link update}, so it's an ordinary, notified status change — a person bringing work back is news. */
  restore(id: string, by: string): Task | null {
    const r = this.db.prepare('SELECT archived_at, archived_from FROM tasks WHERE id = ?').get<{ archived_at: number | null; archived_from: string | null }>(id);
    if (!r?.archived_at) return null;
    const from = (r.archived_from && STATUSES.includes(r.archived_from as TaskStatus) ? r.archived_from : 'todo') as TaskStatus;
    const to: TaskStatus = from === 'doing' || TERMINAL.has(from) ? 'todo' : from;
    return this.update(id, { status: to, note: 'restored from the cleanup archive', by });
  }

  /** Archived tasks, most recently archived first — the board's "Archived" lens. */
  archived(tenant: string, limit = 300): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE tenant = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC LIMIT ?')
      .all<TaskRow>(tenant, Math.max(1, Math.min(limit, 1000)))
      .map(toTask);
  }

  archivedCount(tenant: string): number {
    return this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE tenant = ? AND archived_at IS NOT NULL').get<{ n: number }>(tenant)?.n ?? 0;
  }

  /**
   * The board's default load: EVERY open task plus what closed recently — not "the first 500 rows in
   * status order", which on a tenant with thousands of tasks handed the console an arbitrary slice
   * (the done column ate the budget, or open work past row 500 silently didn't exist). Archived tasks
   * are left out; they have their own lens.
   */
  board(tenant: string, opts: { closedSince: number; openLimit?: number; closedLimit?: number }): Task[] {
    const open = this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND status NOT IN ('done','cancelled')
                 ORDER BY (CASE status WHEN 'proposed' THEN -1 WHEN 'todo' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END), priority, updated_at DESC LIMIT ?`)
      .all<TaskRow>(tenant, opts.openLimit ?? 2000);
    const closed = this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND status IN ('done','cancelled') AND archived_at IS NULL
                 AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
      .all<TaskRow>(tenant, opts.closedSince, opts.closedLimit ?? 300);
    return this.attachDeps([...open, ...closed].map(toTask));
  }

  /**
   * An OPEN task with the same title, if one exists — so an agent re-filing work that's already on the
   * board gets pointed at it instead of adding a copy (one live tenant had the same test-fix task open
   * eight times). Title compared case- and whitespace-insensitively; archived tasks don't count.
   */
  findOpenDuplicate(tenant: string, title: string): Task | undefined {
    const norm = normTitle(title);
    if (!norm) return undefined;
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE tenant = ? AND status NOT IN ('done','cancelled') AND lower(trim(title)) LIKE ? ORDER BY created_at ASC LIMIT 20`)
      .all<TaskRow>(tenant, norm.slice(0, 24).replace(/[%_]/g, '') + '%');
    const hit = rows.find((r) => normTitle(r.title) === norm);
    return hit ? this.withDeps(toTask(hit)) : undefined;
  }

  /** How many of one author's proposals are still awaiting a human — the per-agent queue cap. */
  openProposals(tenant: string, createdBy: string): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE tenant = ? AND status = 'proposed' AND created_by = ?`)
      .get<{ n: number }>(tenant, createdBy)?.n ?? 0;
  }

  /** Per-status counts for the board column headers. */
  counts(tenant: string): Record<TaskStatus, number> {
    const out = { proposed: 0, todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 } as Record<TaskStatus, number>;
    for (const r of this.db
      // Archived tasks are cancelled in status but not in meaning — they get their own count
      // (`archivedCount`), so a cleanup pass doesn't swell the Done column by a thousand.
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE tenant = ? AND archived_at IS NULL GROUP BY status')
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

  /**
   * Record a one-time "the dispatched run ended with this task still open" marker for `sessionId`; returns
   * true only the FIRST time, so the stranded sweep wakes the delegating caller exactly once per dead run
   * (not every tick). Keyed on the SESSION, not the task, so a re-dispatch that strands again is a fresh
   * signal. The marker also reads in the task timeline as the reason the board stopped moving.
   */
  markStranded(id: string, sessionId: string): boolean {
    const mark = strandedMark(sessionId);
    const existing = this.db
      .prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'status' AND body = ? LIMIT 1`)
      .get<{ 1: number }>(id, mark);
    if (existing) return false;
    this.addEvent(id, 'status', mark, 'system', sessionId);
    return true;
  }

  /**
   * Record a one-time "the caller was not woken with this outcome" marker; returns true only the FIRST
   * time so a re-fired hand-off writes one line, not a column of them. Written as a `status` event rather
   * than a `comment` deliberately: {@link latestNote} reads the newest comment as THE result of the task,
   * and a piece of delivery bookkeeping must never become the answer a later poke quotes.
   */
  markWakeDropped(id: string, agent: string): boolean {
    const mark = wakeDroppedMark(agent);
    const existing = this.db
      .prepare(`SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'status' AND body = ? LIMIT 1`)
      .get<{ 1: number }>(id, mark);
    if (existing) return false;
    this.addEvent(id, 'status', mark, 'system');
    return true;
  }

  /** Tasks eligible for auto-dispatch: todo, assigned to an agent, auto_dispatch on, and with every
   *  dependency satisfied (done/cancelled). The unmet-dep exclusion is what walks a plan in pipeline
   *  order — a dependent stays out of the candidate set until its blockers finish. Priority-first. */
  dispatchable(tenant: string): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks t WHERE t.tenant = ? AND t.status = 'todo' AND t.auto_dispatch = 1
                 AND t.assignee LIKE 'agent:%'
                 AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.depends_on
                                  WHERE d.task_id = t.id AND b.status NOT IN ('done','cancelled'))
                 ORDER BY t.priority, t.created_at`)
      .all<TaskRow>(tenant)
      .map(toTask);
  }

  /** All tasks linked to a goal (newest-updated first) — feeds the goal's derived progress + detail view. */
  tasksForGoal(goalId: string): Task[] {
    // Creation order = the order the strategist filed the plan (its pipeline order), so a numbered plan
    // reads top-to-bottom. attachDeps so the goal detail can show each task's blockers / "waiting" state.
    return this.attachDeps(
      this.db
        .prepare('SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at ASC')
        .all<TaskRow>(goalId)
        .map(toTask),
    );
  }

  // ── Dependencies ─────────────────────────────────────────────────────────────────────────────────
  // A task_deps edge (task_id → depends_on) means task_id is BLOCKED BY depends_on. A task is ready to
  // dispatch only when every blocker is done/cancelled (see dispatchable + dispatchTask). Set by the
  // strategist's plan (and editable in the console) to turn an implicit sequence into an enforced pipeline.

  /** The task ids this task is blocked by. */
  deps(id: string): string[] {
    return this.db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?').all<{ depends_on: string }>(id).map((r) => r.depends_on);
  }

  /** The task ids blocked by this one (its dependents) — "what this unblocks". */
  dependents(id: string): string[] {
    return this.db.prepare('SELECT task_id FROM task_deps WHERE depends_on = ?').all<{ task_id: string }>(id).map((r) => r.task_id);
  }

  /**
   * The tasks this one SPAWNED — its direct `parent_id` children, newest last. The hand-off edge, not a
   * dependency: an agent working a task calls `task_create`, and the child records who it came out of.
   *
   * Served from here rather than derived on the client because the board ships a bounded page of tasks,
   * so a client-side `filter(t => t.parentId === id)` silently under-counts a wide fan-out — and a
   * "spawned · 6" that is really 12 is worse than no number at all.
   */
  children(id: string): Array<Pick<Task, 'id' | 'title' | 'status' | 'assignee'>> {
    return this.db
      .prepare(`SELECT id, title, status, assignee FROM tasks WHERE parent_id = ? ORDER BY created_at ASC`)
      .all<{ id: string; title: string; status: string; assignee: string | null }>(id)
      .map((r) => ({ id: r.id, title: r.title, status: r.status as TaskStatus, assignee: r.assignee ?? undefined }));
  }

  /**
   * Blocked tasks whose wait is over: every blocker they named is done/cancelled and the park was not on a
   * HUMAN. These are the self-clearing blocks — an agent chained its work behind another task, so nobody
   * ever has to be told about them and nobody has to come back and flip them. Nothing swept them before:
   * `dispatchable()` is todo-only, so a task parked `blocked` behind a dependency stayed blocked forever
   * after its blocker landed, and the only way back onto the board was a human noticing and hand-flipping
   * the status. Requires at least one dependency edge — a bare `blocked` with no blockers named is somebody
   * parking the task deliberately, and clearing that would undo their decision.
   */
  settledBlocked(tenant: string): Task[] {
    return this.db
      .prepare(`SELECT * FROM tasks t WHERE t.tenant = ? AND t.status = 'blocked'
                 AND (t.blocked_on IS NULL OR t.blocked_on != 'human')
                 AND EXISTS (SELECT 1 FROM task_deps d WHERE d.task_id = t.id)
                 AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.depends_on
                                  WHERE d.task_id = t.id AND b.status NOT IN ('done','cancelled'))
                 ORDER BY t.priority, t.created_at`)
      .all<TaskRow>(tenant)
      .map(toTask);
  }

  /**
   * The most recent comment on a task — the WHY behind its current state. A blocked task's notification
   * used to carry only the title, which is the one thing the reader already knows; the agent's own
   * explanation of what it is waiting for was sitting right here in the event log, unread.
   */
  lastComment(id: string): string | undefined {
    const r = this.db
      .prepare(`SELECT body FROM task_events WHERE task_id = ? AND kind = 'comment' AND body IS NOT NULL AND body != ''
                 ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get<{ body: string }>(id);
    return r?.body ?? undefined;
  }

  /** The subset of this task's blockers that are NOT yet done/cancelled (a missing blocker counts as met). */
  unmetDeps(id: string): string[] {
    return this.db
      .prepare(`SELECT d.depends_on FROM task_deps d JOIN tasks b ON b.id = d.depends_on
                 WHERE d.task_id = ? AND b.status NOT IN ('done','cancelled')`)
      .all<{ depends_on: string }>(id)
      .map((r) => r.depends_on);
  }

  /**
   * Replace a task's dependency set. Skips a dep that is missing, self, a duplicate, or would create a
   * cycle (so the graph stays a DAG). Logs a `link` event; returns the applied dependency ids.
   */
  setDeps(taskId: string, depIds: string[], by: string): string[] {
    if (!this.get(taskId)) return [];
    const applied: string[] = [];
    for (const raw of depIds) {
      const dep = String(raw ?? '').trim();
      if (!dep || dep === taskId || applied.includes(dep)) continue;
      if (!this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(dep)) continue; // blocker must exist
      if (this.wouldCycle(taskId, dep)) continue; // dep already (transitively) depends on taskId
      applied.push(dep);
    }
    this.db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
    const ins = this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)');
    for (const dep of applied) ins.run(taskId, dep);
    this.addEvent(taskId, 'link', applied.length ? `depends on ${applied.join(', ')}` : 'dependencies cleared', by);
    return applied;
  }

  /** Would adding taskId→dep create a cycle? True iff `dep` already reaches `taskId` via depends_on edges. */
  private wouldCycle(taskId: string, dep: string): boolean {
    const seen = new Set<string>();
    const stack = [dep];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of this.db.prepare('SELECT depends_on FROM task_deps WHERE task_id = ?').all<{ depends_on: string }>(cur)) stack.push(r.depends_on);
    }
    return false;
  }

  /** Attach `dependsOn` to a task DTO (single read). */
  private withDeps(task: Task): Task {
    const d = this.deps(task.id);
    if (d.length) task.dependsOn = d;
    return task;
  }

  /** Attach `dependsOn` to a batch of task DTOs in one query (the board path). */
  private attachDeps(tasks: Task[]): Task[] {
    if (!tasks.length) return tasks;
    const ids = tasks.map((t) => t.id);
    const rows = this.db
      .prepare(`SELECT task_id, depends_on FROM task_deps WHERE task_id IN (${ids.map(() => '?').join(',')})`)
      .all<{ task_id: string; depends_on: string }>(...ids);
    const byTask = new Map<string, string[]>();
    for (const r of rows) {
      const arr = byTask.get(r.task_id) ?? [];
      arr.push(r.depends_on);
      byTask.set(r.task_id, arr);
    }
    for (const t of tasks) {
      const d = byTask.get(t.id);
      if (d && d.length) t.dependsOn = d;
    }
    return tasks;
  }

  // ── Attachments ────────────────────────────────────────────────────────────────────────────────
  // Files attached to a task, snapshotted onto disk under <home>/task-attachments/<taskId>/<id>-<name>
  // (the same immutable-copy model as ArtifactStore). Both humans (console upload → raw bytes) and
  // agents (task_attach → a path in their working folder) land here through attachBytes / attachFromPath.

  /** Attach a file from raw bytes (the console upload path). Logs an `attach` event on the task. */
  attachBytes(input: { taskId: string; filename: string; bytes: Buffer; uploadedBy: string }): AttachResult {
    if (!this.dir) return { ok: false, error: 'no data home configured (attachments disabled)' };
    if (!this.get(input.taskId)) return { ok: false, error: 'task not found' };
    const filename = sanitizeName(input.filename);
    if (!filename) return { ok: false, error: 'invalid file name' };
    return this.writeAttachment(input.taskId, filename, input.bytes, input.uploadedBy);
  }

  /**
   * Attach a file the agent names in its working folder (the `task_attach` MCP path). `allowRoot` is the
   * agent's folder; `srcPath` is resolved STRICTLY under it (lexically + after symlink resolution), so an
   * agent can't attach `/etc/passwd` or escape via a symlink. Mirrors ArtifactStore.publish.
   */
  attachFromPath(input: { taskId: string; allowRoot: string; srcPath: string; uploadedBy: string }): AttachResult {
    if (!this.dir) return { ok: false, error: 'no data home configured (attachments disabled)' };
    if (!this.get(input.taskId)) return { ok: false, error: 'task not found' };
    const src = containedPath(input.allowRoot, input.srcPath);
    if (!src) return { ok: false, error: 'path escapes the agent folder or does not exist' };
    let st: fs.Stats;
    try { st = fs.statSync(src); } catch { return { ok: false, error: 'not found' }; }
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    return this.writeAttachment(input.taskId, path.basename(src), fs.readFileSync(src), input.uploadedBy);
  }

  /** Shared writer: copy bytes to disk, insert the row, log the `attach` event. */
  private writeAttachment(taskId: string, filename: string, bytes: Buffer, uploadedBy: string): AttachResult {
    const id = newId('taskAttachment');
    const rel = path.join(taskId, `${id}-${filename}`);
    const dest = path.join(this.dir!, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
    } catch (e) {
      return { ok: false, error: `write failed: ${(e as Error).message}` };
    }
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO task_attachments (id, task_id, tenant, filename, rel_path, mime, bytes, uploaded_by, created_at)
                 VALUES (?, ?, (SELECT tenant FROM tasks WHERE id = ?), ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId, taskId, filename, rel, mimeOf(filename), bytes.length, uploadedBy, now);
    this.addEvent(taskId, 'attach', filename, uploadedBy);
    return { ok: true, attachment: toAttachment(this.db.prepare('SELECT * FROM task_attachments WHERE id = ?').get<AttachmentRow>(id)!) };
  }

  /** All attachments on a task, oldest first (upload order). */
  attachments(taskId: string): TaskAttachment[] {
    return this.db
      .prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC, id ASC')
      .all<AttachmentRow>(taskId)
      .map(toAttachment);
  }

  getAttachment(id: string): TaskAttachment | undefined {
    const r = this.db.prepare('SELECT * FROM task_attachments WHERE id = ?').get<AttachmentRow>(id);
    return r ? toAttachment(r) : undefined;
  }

  /** Resolve an attachment's bytes for streaming/download. null if missing or the dir is disabled. */
  readAttachment(id: string): { absPath: string; mime: string; filename: string } | null {
    if (!this.dir) return null;
    const a = this.getAttachment(id);
    if (!a) return null;
    const abs = path.join(this.dir, a.relPath);
    try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
    return { absPath: abs, mime: a.mime, filename: a.filename };
  }

  /** Remove one attachment: its row, its on-disk file, and a `comment` event noting the removal. */
  removeAttachment(id: string, by: string): boolean {
    const a = this.getAttachment(id);
    if (!a) return false;
    this.db.prepare('DELETE FROM task_attachments WHERE id = ?').run(id);
    if (this.dir) fs.rmSync(path.join(this.dir, a.relPath), { force: true });
    this.addEvent(a.taskId, 'comment', `removed attachment ${a.filename}`, by);
    return true;
  }

  /** Append one row to the append-only activity log. */
  private addEvent(taskId: string, kind: TaskEvent['kind'], body: string, author: string, sessionId?: string): void {
    this.db
      .prepare('INSERT INTO task_events (id, task_id, kind, body, author, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId('taskEvent'), taskId, kind, body, author, sessionId ?? null, Date.now());
  }
}

/** Title as compared for duplicates: lowercased, whitespace collapsed, trailing punctuation dropped. */
function normTitle(t: string): string {
  return String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s.!?:;,]+$/, '');
}

function clampPriority(p?: number): number {
  if (p === undefined || !Number.isFinite(p)) return 2;
  return Math.max(0, Math.min(3, Math.round(p)));
}

/** Collapse to a single trimmed line (or null). A `/goal` condition delimits at the first newline, so a
 *  multi-line acceptance criterion would spill into the prose body — keep it one line. undefined → leave. */
function oneLine(s: string | null | undefined): string | null {
  if (s === undefined) return null;
  if (s === null) return null;
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean || null;
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
    blockedOn: (TASK_BLOCKED_ON as readonly string[]).includes(r.blocked_on ?? '') ? (r.blocked_on as Task['blockedOn']) : undefined,
    priority: r.priority, labels: JSON.parse(r.labels) as string[], assignee: r.assignee ?? undefined,
    suggestedAssignee: r.suggested_assignee ?? undefined,
    owner: r.owner ?? undefined, parentId: r.parent_id ?? undefined,
    mode: r.mode === 'interactive' ? 'interactive' : 'headless',
    model: r.model ?? undefined, effort: (r.effort ?? undefined) as Task['effort'],
    autoDispatch: r.auto_dispatch === 1,
    goalId: r.goal_id ?? undefined, ...(r.bet_id ? { betId: r.bet_id } : {}), criteria: r.criteria ?? undefined,
    callerAgent: r.caller_agent ?? undefined, callerClaudeId: r.caller_claude_id ?? undefined,
    pokeOnDone: r.poke_on_done === 1,
    dueAt: r.due_at ?? undefined, attempts: r.attempts, lastSessionId: r.last_session_id ?? undefined,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by,
    externalKey: r.external_key ?? undefined,
    ...(r.archived_at ? { archivedAt: r.archived_at, archivedReason: r.archived_reason ?? undefined } : {}),
  };
}

function toEvent(r: EventRow): TaskEvent {
  return {
    id: r.id, taskId: r.task_id, kind: r.kind as TaskEvent['kind'], body: r.body ?? undefined,
    author: r.author, sessionId: r.session_id ?? undefined, createdAt: r.created_at,
  };
}

function toAttachment(r: AttachmentRow): TaskAttachment {
  return {
    id: r.id, taskId: r.task_id, tenant: r.tenant, filename: r.filename, relPath: r.rel_path,
    mime: r.mime, bytes: r.bytes, uploadedBy: r.uploaded_by, createdAt: r.created_at,
  };
}

/** Collapse an uploaded name to a single safe basename (no path separators, no `.`/`..`). */
function sanitizeName(name: string): string {
  const base = path.basename(String(name ?? '').trim().replace(/[/\\]+/g, '/'));
  return base === '.' || base === '..' ? '' : base;
}

/** Resolve `rel` under `root`, rejecting escapes lexically AND after symlink resolution. The target
 *  must already exist (you attach a real file). Mirrors ArtifactStore.containedPath. */
function containedPath(root: string, rel: string): string | null {
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  const target = path.resolve(realRoot, rel.replace(/^[/\\]+/, ''));
  if (!within(target) || !fs.existsSync(target)) return null;
  let real: string;
  try { real = fs.realpathSync(target); } catch { return null; }
  return within(real) ? real : null;
}

/** Content-type by extension — self-contained (no server dependency). Mirrors ArtifactStore.mimeOf. */
function mimeOf(file: string): string {
  const e = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.zip': 'application/zip',
  };
  return map[e] || 'application/octet-stream';
}
