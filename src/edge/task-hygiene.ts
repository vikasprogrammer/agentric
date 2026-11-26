/**
 * Board cleanup — keep the shared task board TRUE without a human gardening it.
 *
 * The board drifts because agents file ~all of the work and close only some of it. Measured on the
 * busiest tenant (2026-11-26): 1,776 open tasks, 97% agent-filed, average ~90 days since anything
 * touched them; 863 of 878 `todo` idle 30+ days; 188 `doing` with not one live run behind them; 616
 * open children of a parent that had already finished; 182 proposals nobody decided, 48 days old on
 * average; and one person's assignments split across three spellings of their name. No filter or view
 * fixes that — the rows themselves are wrong. So this pass corrects them, conservatively:
 *
 *  · **assignees** — every stored assignee rewritten to its canonical form (`TaskStore.normalizeAssignees`).
 *  · **expired proposals** — `proposed` untouched for {@link PROPOSAL_DAYS}: nobody accepted it, so it
 *    isn't work. Archived (and its Inbox card resynced so it stops asking).
 *  · **stale** — agent-filed, held by an agent or nobody, untouched for {@link STALE_DAYS}, no live run,
 *    not due in the future. Archived.
 *  · **orphaned** — same ownership rule, its parent is done/cancelled, untouched for {@link ORPHAN_DAYS}.
 *    Archived. (The grace is deliberate: a child filed as the parent closes is often the follow-up.)
 *  · **stalled `doing`** — held by an agent or nobody (whoever FILED it), no live run, untouched for {@link STALLED_DAYS}.
 *    Nobody is doing it, so it stops saying so: back to `todo`, or `blocked` when it would auto-dispatch
 *    (silently respawning old work is a spend decision, not a tidy-up — a person re-dispatches it).
 *
 * What it never touches: anything a PERSON holds (assignee is a member), and it never ARCHIVES anything a
 * person filed — a human's backlog is theirs to prune; anything with a live session; anything due in the
 * future. "Archived" is `cancelled` + `archived_at`, silent (no cards, DMs or caller wake-ups — the store
 * primitives skip the notifier), one click to restore, and excluded from the board's default load.
 * Every pass is audited `tasks.hygiene`; a large pass also leaves one Inbox card for admins so a board
 * that suddenly shrank says why.
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
export const STALE_DAYS = 30;
export const ORPHAN_DAYS = 7;
export const PROPOSAL_DAYS = 14;
export const STALLED_DAYS = 3;
/** Archives per pass. Kept small so one pass is ~0.1 s on the event loop (measured: 1,000 rows ≈ 0.4 s
 *  on a copy of the busiest tenant); a neglected board drains over consecutive ticks (`more`). */
export const MAX_PER_PASS = 300;

export type HygieneRule = 'proposal' | 'stale' | 'orphan' | 'stalled';

export interface HygieneItem { id: string; title: string; status: string; assignee: string | null; idleDays: number; rule: HygieneRule }
export interface HygienePlan {
  normalize: number;                       // assignee rows that WOULD be rewritten
  archive: HygieneItem[];                  // proposal | stale | orphan
  settle: Array<HygieneItem & { to: 'todo' | 'blocked' }>;
}
export interface HygieneResult {
  normalized: number;
  archived: Record<'proposal' | 'stale' | 'orphan', number>;
  settled: { todo: number; blocked: number };
  /** More was due than one pass may archive — run again soon rather than in an hour. */
  more: boolean;
}

interface Row {
  id: string; title: string; status: string; assignee: string | null; created_by: string;
  updated_at: number; due_at: number | null; last_session_id: string | null; auto_dispatch: number;
  parent_status: string | null;
}

/** Sessions that are live right now, and the tasks they were dispatched for (`task:<id>` provenance). */
function liveRuns(os: AgentOS): { sessions: Set<string>; tasks: Set<string> } {
  const rows = os.db.prepare(`SELECT id, spawned_by FROM term_sessions WHERE status = 'running'`).all<{ id: string; spawned_by: string | null }>();
  const sessions = new Set<string>();
  const tasks = new Set<string>();
  for (const r of rows) {
    sessions.add(r.id);
    if (r.spawned_by?.startsWith('task:')) tasks.add(r.spawned_by.slice('task:'.length));
  }
  return { sessions, tasks };
}

/** Held by an agent or by nobody — a task a PERSON holds is never touched. */
const notHeldByPerson = (r: Row) => !r.assignee || r.assignee.startsWith('agent:');

/** Decide what a pass would do, without writing anything. */
export function planTaskHygiene(os: AgentOS, now = Date.now()): HygienePlan {
  const live = liveRuns(os);
  const rows = os.db
    .prepare(`SELECT t.id, t.title, t.status, t.assignee, t.created_by, t.updated_at, t.due_at, t.last_session_id,
                     t.auto_dispatch, p.status AS parent_status
                FROM tasks t LEFT JOIN tasks p ON p.id = t.parent_id
               WHERE t.tenant = ? AND t.status NOT IN ('done','cancelled')
               ORDER BY t.updated_at ASC`)
    .all<Row>(os.tenant);
  const archive: HygieneItem[] = [];
  const settle: HygienePlan['settle'] = [];
  for (const r of rows) {
    if (live.tasks.has(r.id) || (r.last_session_id && live.sessions.has(r.last_session_id))) continue;
    const idle = now - r.updated_at;
    const item = (rule: HygieneRule): HygieneItem => ({ id: r.id, title: r.title, status: r.status, assignee: r.assignee, idleDays: Math.floor(idle / DAY), rule });
    if (r.status === 'proposed') {
      if (idle >= PROPOSAL_DAYS * DAY) archive.push(item('proposal'));
      continue;
    }
    if (!notHeldByPerson(r)) continue;
    if (r.due_at && r.due_at > now) continue;
    // ARCHIVING is for agent-filed work only: a person's backlog is theirs to prune, even when an agent holds it.
    if (r.created_by.startsWith('agent:')) {
      if (idle >= STALE_DAYS * DAY) { archive.push(item('stale')); continue; }
      if ((r.parent_status === 'done' || r.parent_status === 'cancelled') && idle >= ORPHAN_DAYS * DAY) { archive.push(item('orphan')); continue; }
    }
    // …but a `doing` nobody is doing is a false status whoever filed it, so that correction applies to all.
    if (r.status === 'doing' && idle >= STALLED_DAYS * DAY) {
      const wouldDispatch = r.auto_dispatch === 1 && !!r.assignee?.startsWith('agent:');
      settle.push({ ...item('stalled'), to: wouldDispatch ? 'blocked' : 'todo' });
    }
  }
  return { normalize: countUnnormalized(os), archive, settle };
}

function countUnnormalized(os: AgentOS): number {
  let n = 0;
  for (const col of ['assignee', 'suggested_assignee'] as const) {
    const rows = os.db
      .prepare(`SELECT ${col} AS v FROM tasks WHERE tenant = ? AND ${col} IS NOT NULL AND ${col} NOT LIKE 'agent:%'
                 AND ${col} NOT IN (SELECT id FROM members)`)
      .all<{ v: string }>(os.tenant);
    for (const r of rows) if (os.tasks.canonicalAssignee(r.v) !== r.v) n++;
  }
  return n;
}

const REASON: Record<'proposal' | 'stale' | 'orphan', (i: HygieneItem) => string> = {
  proposal: (i) => `proposal not accepted in ${i.idleDays} days`,
  stale: (i) => `no activity in ${i.idleDays} days and nobody on it`,
  orphan: (i) => `its parent task is closed and it has sat ${i.idleDays} days since`,
};

export interface HygieneHooks {
  /** Resync the Inbox proposal card once its task is archived (TerminalManager.syncTaskProposalCards). */
  syncProposalCard?(taskId: string): void;
}

/** Run one pass. One transaction for the writes; the plan's `updated_at` is re-checked per row so an
 *  edit that lands mid-pass wins over the pass. */
export function applyTaskHygiene(os: AgentOS, hooks: HygieneHooks = {}, now = Date.now(), by = 'system'): HygieneResult {
  const plan = planTaskHygiene(os, now);
  const out: HygieneResult = { normalized: 0, archived: { proposal: 0, stale: 0, orphan: 0 }, settled: { todo: 0, blocked: 0 }, more: plan.archive.length > MAX_PER_PASS };
  const proposals: string[] = [];
  os.db.exec('BEGIN');
  try {
    out.normalized = os.tasks.normalizeAssignees(os.tenant);
    for (const i of plan.archive.slice(0, MAX_PER_PASS)) {
      const rule = i.rule as 'proposal' | 'stale' | 'orphan';
      const cutoff = now - (rule === 'proposal' ? PROPOSAL_DAYS : rule === 'stale' ? STALE_DAYS : ORPHAN_DAYS) * DAY;
      if (os.tasks.archive(i.id, REASON[rule](i), { by, staleBefore: cutoff + 1 })) {
        out.archived[rule]++;
        if (rule === 'proposal') proposals.push(i.id);
      }
    }
    for (const i of plan.settle) {
      const mark = i.to === 'todo'
        ? `↩ moved back to To do by board cleanup — no run has worked it in ${i.idleDays} days`
        : `⏸ parked by board cleanup — no run has worked it in ${i.idleDays} days; re-dispatch it to try again`;
      if (os.tasks.settle(i.id, i.to, mark, { by, staleBefore: now - STALLED_DAYS * DAY + 1 })) out.settled[i.to]++;
    }
    os.db.exec('COMMIT');
  } catch (e) {
    os.db.exec('ROLLBACK');
    throw e;
  }
  for (const id of proposals) { try { hooks.syncProposalCard?.(id); } catch { /* card sync is advisory */ } }
  const archived = out.archived.proposal + out.archived.stale + out.archived.orphan;
  if (archived || out.normalized || out.settled.todo || out.settled.blocked) {
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: by, type: 'tasks.hygiene', data: { ...out, archivedTotal: archived } });
  }
  return out;
}

export const archivedTotal = (r: HygieneResult) => r.archived.proposal + r.archived.stale + r.archived.orphan;
