import { Db } from './db';

/**
 * The **unified activity feed** (`os.feed`) — a *read-only derived view*, not a stored table.
 *
 * Every line in the console's stream is one row already living in `term_sessions`, `approvals` or
 * `questions`; this store `UNION ALL`s them into a single time-ordered shape with attribution
 * (agent · run-as · provenance · goal) joined in, so the inbox/tasks/sessions/notifications split
 * collapses into one query. There is no `feed` table and nothing new is written here — the source
 * rows stay the system of record, and `messages` is no longer a read path.
 *
 * Tenancy: `os.db` is already one tenant's database (process-per-tenant, or a per-tenant runtime from
 * the registry), so there is no tenant column to filter on — the DB file IS the boundary. `term_sessions`
 * carries no tenant column at all, which is why none of the branches below filter by one.
 */

export type FeedFilter = 'all' | 'needsYou' | 'running' | 'done';

/** The viewer, reduced to what scoping needs: their member id and whether they see everything. */
export interface FeedViewer {
  id: string;
  isAdmin: boolean; // owner | admin — sees all rows, like canViewSpawn
}

export interface FeedItem {
  uid: string; // "<source>:<id>" — unique + the keyset-pagination tiebreak
  ts: number; // epoch ms, the sort key
  kind: string; // session.running | session.done | approval.pending | approval.approved | question.pending | …
  state: 'running' | 'done' | 'decision' | 'info';
  // attribution — always resolved, the thing the old inbox lacked
  runId: string;
  agent: string | null;
  runAs: string | null; // term_sessions.run_as (member id)
  spawnedBy: string | null; // raw provenance ("automation:xyz" | member id | null)
  goal: { id: string; title: string } | null;
  // the line
  title: string;
  ref: { table: string; id: string };
  // decision-only
  capability: string | null;
  level: string | null; // head | owner
  args: unknown | null;
  status: string | null; // pending | approved | rejected | cancelled | answered | (session status)
  // session enrichment
  costUsd: number | null;
  tokens: number | null; // input + output tokens (session lines only)
  outcome: string | null;
  rating: string | null;
  hasTrail: boolean; // resolved/finished → the step-by-step history is fetchable
  // the live object this line is ABOUT — so a click connects to it (a task card → its task, not a
  // dead "session" id). Decoded from provenance/session_id; null for a session-less notification.
  target: { kind: 'session' | 'task' | 'goal' | 'artifact'; id: string } | null;
  // for a RUNNING session: the newest thing the agent just did, so you can watch progress without
  // opening the terminal. Enriched by the route (classifyActivity over the audit tail); null otherwise.
  lastActivity?: { primitive: string; summary: string; ts: number } | null;
}

/** Decode the object a feed line points at from its kind + run id. Session/approval/question lines are
 *  about their session; a folded message card encodes its real target in `session_id` (`task:<id>`,
 *  `goal:<id>`, a real session id, or blank for a session-less notification). */
export function feedTarget(kind: string, runId: string): FeedItem['target'] {
  if (kind.startsWith('session') || kind.startsWith('approval') || kind.startsWith('question'))
    return runId ? { kind: 'session', id: runId } : null;
  // message.* — runId is the card's session_id
  if (runId.startsWith('task:')) return { kind: 'task', id: runId.slice(5) };
  if (runId.startsWith('goal:')) return { kind: 'goal', id: runId.slice(5) };
  if (runId && !runId.includes(':')) return { kind: 'session', id: runId }; // a real session (e.g. an update)
  return null;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null; // "<ts>:<uid>", pass back as ?cursor=
}

export interface FeedCounts {
  needsYou: number;
  running: number;
  doneToday: number;
}

export interface TrailStep {
  ts: number;
  source: 'audit' | 'task';
  kind: string; // audit_events.type, or "task.<kind>"
  author: string | null; // principal | task_events.author
  detail: unknown; // parsed audit data, or the task-event note
}

interface FeedRow {
  ts: number;
  uid: string;
  state: 'running' | 'done' | 'decision' | 'info';
  kind: string;
  run_id: string;
  ref_table: string;
  ref_id: string;
  agent: string | null;
  run_as: string | null;
  spawned_by: string | null;
  goal_id: string | null;
  goal_title: string | null;
  title: string | null;
  capability: string | null;
  level: string | null;
  args: string | null;
  status: string | null;
  cost_usd: number | null;
  tokens: number | null;
  outcome: string | null;
  rating: string | null;
  aud_member: string | null; // scope-only: a 'member'-audience card's target member id (never returned)
}

/**
 * The three source branches, projected to one shape. A `term_sessions` row surfaces once at its current
 * state (running → its live line; finished → a done line); an `approvals`/`questions` row is its own line
 * (a decision while pending, history once resolved). Each LEFT JOINs the session → its task
 * (`tasks.last_session_id`) → the task's goal, so the goal tag is populated wherever the chain exists.
 */
const CTE = `
WITH feed AS (
  SELECT
    CASE WHEN s.status='running' THEN COALESCE(s.busy_since, s.last_activity, s.created_at) ELSE s.updated_at END AS ts,
    'session:' || s.id AS uid,
    CASE WHEN s.status='running' THEN 'running' ELSE 'done' END AS state,
    'session.' || CASE WHEN s.status='running' THEN 'running' ELSE s.status END AS kind,
    s.id AS run_id, 'term_sessions' AS ref_table, s.id AS ref_id,
    s.agent AS agent, s.run_as AS run_as, s.spawned_by AS spawned_by,
    t.goal_id AS goal_id, g.title AS goal_title,
    COALESCE(NULLIF(s.report_summary,''), s.title) AS title,
    NULL AS capability, NULL AS level, NULL AS args,
    s.status AS status, s.cost_usd AS cost_usd, (COALESCE(s.input_tokens,0) + COALESCE(s.output_tokens,0)) AS tokens, s.outcome AS outcome, s.rating AS rating,
    NULL AS aud_member
  FROM term_sessions s
  LEFT JOIN tasks t ON t.last_session_id = s.id
  LEFT JOIN goals g ON g.id = t.goal_id
  WHERE s.archived_at IS NULL

  UNION ALL
  SELECT
    COALESCE(a.resolved_at, a.created_at) AS ts,
    'approval:' || a.id AS uid,
    CASE WHEN a.status='pending' THEN 'decision' ELSE 'done' END AS state,
    'approval.' || a.status AS kind,
    a.run_id AS run_id, 'approvals' AS ref_table, a.id AS ref_id,
    s.agent AS agent, s.run_as AS run_as, s.spawned_by AS spawned_by,
    t.goal_id AS goal_id, g.title AS goal_title,
    a.reason AS title,
    a.capability AS capability, a.level AS level, a.args AS args,
    a.status AS status, NULL AS cost_usd, NULL AS tokens, NULL AS outcome, NULL AS rating,
    NULL AS aud_member
  FROM approvals a
  LEFT JOIN term_sessions s ON s.id = a.run_id
  LEFT JOIN tasks t ON t.last_session_id = s.id
  LEFT JOIN goals g ON g.id = t.goal_id

  UNION ALL
  SELECT
    COALESCE(q.answered_at, q.created_at) AS ts,
    'question:' || q.id AS uid,
    CASE WHEN q.status='pending' THEN 'decision' ELSE 'done' END AS state,
    'question.' || q.status AS kind,
    q.run_id AS run_id, 'questions' AS ref_table, q.id AS ref_id,
    q.agent AS agent, s.run_as AS run_as, s.spawned_by AS spawned_by,
    t.goal_id AS goal_id, g.title AS goal_title,
    q.prompt AS title,
    NULL AS capability, NULL AS level, NULL AS args,
    q.status AS status, NULL AS cost_usd, NULL AS tokens, NULL AS outcome, NULL AS rating,
    NULL AS aud_member
  FROM questions q
  LEFT JOIN term_sessions s ON s.id = q.run_id
  LEFT JOIN tasks t ON t.last_session_id = s.id
  LEFT JOIN goals g ON g.id = t.goal_id

  UNION ALL
  -- 4 ── MESSAGES: the notification/update class the other three don't cover — an agent's 'update' note,
  -- a session-less 'notification'/'task' card, a published 'artifact'. NOT 'approval'/'question' (their
  -- own branches) nor 'completed' (it duplicates the session's done line). Visibility mirrors canViewMsg:
  -- the session's human (run_as/spawned_by, like every branch) OR a 'member'-audience card's target
  -- (aud_member) — the outer scope ORs both. Dismissed cards drop out.
  SELECT
    m.created_at AS ts,
    'message:' || m.id AS uid,
    'info' AS state,
    'message.' || m.type AS kind,
    m.session_id AS run_id, 'messages' AS ref_table, m.id AS ref_id,
    m.agent AS agent,
    COALESCE(s.run_as, CASE WHEN m.audience_kind='member' THEN m.audience_id END) AS run_as,
    s.spawned_by AS spawned_by,
    t.goal_id AS goal_id, g.title AS goal_title,
    CASE
      WHEN m.type IN ('update','notification') THEN COALESCE(NULLIF(m.body,''), m.title)
      WHEN NULLIF(m.body,'') IS NOT NULL THEN m.title || ' — ' || m.body
      ELSE m.title END AS title,
    NULL AS capability, NULL AS level, NULL AS args,
    m.status AS status, NULL AS cost_usd, NULL AS tokens, m.outcome AS outcome, NULL AS rating,
    CASE WHEN m.audience_kind='member' THEN m.audience_id ELSE NULL END AS aud_member
  FROM messages m
  LEFT JOIN term_sessions s ON s.id = m.session_id
  LEFT JOIN tasks t ON t.last_session_id = s.id
  LEFT JOIN goals g ON g.id = t.goal_id
  WHERE m.type IN ('update','notification','task','artifact') AND m.dismissed_at IS NULL
)`;

export class FeedStore {
  constructor(private db: Db) {}

  /** One page of the stream, newest first, scoped to what `viewer` may see. */
  list(opts: { viewer: FeedViewer; filter?: FeedFilter; goalId?: string; cursor?: string; limit?: number }): FeedPage {
    const limit = Math.max(1, Math.min(opts.limit ?? 40, 100));
    const where: string[] = [];
    const params: unknown[] = [];

    const filter = opts.filter ?? 'all';
    if (filter === 'needsYou') where.push("state = 'decision' AND status = 'pending'");
    else if (filter === 'running') where.push("state = 'running'");
    else if (filter === 'done') where.push("state = 'done'");

    if (opts.goalId) { where.push('goal_id = ?'); params.push(opts.goalId); }

    // Scope on the union: the session's human (run_as/spawned_by/own-automation) OR — for a folded
    // message row — a 'member'-audience card addressed to the viewer (aud_member). Together this is
    // exactly canViewSpawn/canViewRow OR canViewMsg's member branch. Owner/admin: no clause (see all).
    if (!opts.viewer.isAdmin) {
      const autos = this.myAutomations(opts.viewer.id);
      const parts = ['run_as = ?', 'spawned_by = ?', 'aud_member = ?'];
      const p: unknown[] = [opts.viewer.id, opts.viewer.id, opts.viewer.id];
      if (autos.length) { parts.push(`spawned_by IN (${autos.map(() => '?').join(',')})`); p.push(...autos); }
      where.push(`(${parts.join(' OR ')})`);
      params.push(...p);
    }

    const cur = parseCursor(opts.cursor);
    if (cur) { where.push('(ts < ? OR (ts = ? AND uid < ?))'); params.push(cur.ts, cur.ts, cur.uid); }

    const sql = `${CTE}
      SELECT * FROM feed
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ts DESC, uid DESC
      LIMIT ?`;
    const rows = this.db.prepare(sql).all<FeedRow>(...params, limit);
    const items = rows.map(mapRow);
    const last = items[items.length - 1];
    return { items, nextCursor: items.length === limit && last ? `${last.ts}:${last.uid}` : null };
  }

  /** The glance/filter-chip counters, scoped like the list. */
  counts(viewer: FeedViewer, dayStart: number): FeedCounts {
    const sBare = this.scopeSql('', viewer); // columns live directly on term_sessions
    const sJoin = this.scopeSql('s.', viewer); // approvals/questions join to the session as `s`

    const running = this.db
      .prepare(`SELECT COUNT(*) c FROM term_sessions WHERE status='running' AND archived_at IS NULL ${andClause(sBare.sql)}`)
      .get<{ c: number }>(...sBare.params)!.c;
    const doneToday = this.db
      .prepare(`SELECT COUNT(*) c FROM term_sessions WHERE status IN ('done','stopped','crashed') AND updated_at >= ? ${andClause(sBare.sql)}`)
      .get<{ c: number }>(dayStart, ...sBare.params)!.c;
    const pendA = this.db
      .prepare(`SELECT COUNT(*) c FROM approvals a LEFT JOIN term_sessions s ON s.id=a.run_id WHERE a.status='pending' ${andClause(sJoin.sql)}`)
      .get<{ c: number }>(...sJoin.params)!.c;
    const pendQ = this.db
      .prepare(`SELECT COUNT(*) c FROM questions q LEFT JOIN term_sessions s ON s.id=q.run_id WHERE q.status='pending' ${andClause(sJoin.sql)}`)
      .get<{ c: number }>(...sJoin.params)!.c;

    return { needsYou: pendA + pendQ, running, doneToday };
  }

  /**
   * The step-by-step history behind one feed line — reconstructed from the append-only logs
   * (`audit_events` keyed by run_id, `task_events` keyed by session_id), oldest first. This is why a
   * resolved decision never loses its past: nothing is stored on the card, it is rebuilt on demand.
   */
  trail(runId: string): TrailStep[] {
    const rows = this.db
      .prepare(
        `SELECT ts, 'audit' AS source, type AS kind, principal AS author, data AS detail
           FROM audit_events WHERE run_id = ?
         UNION ALL
         SELECT created_at AS ts, 'task' AS source, 'task.'||kind AS kind, author, body AS detail
           FROM task_events WHERE session_id = ?
         ORDER BY ts ASC`,
      )
      .all<{ ts: number; source: 'audit' | 'task'; kind: string; author: string | null; detail: string | null }>(runId, runId);
    return rows.map((r) => ({
      ts: r.ts,
      source: r.source,
      kind: r.kind,
      author: r.author,
      detail: r.source === 'audit' ? safeParse(r.detail) : r.detail,
    }));
  }

  /**
   * Visibility, mirroring TerminalManager.canViewSpawn/canViewRow: owner/admin see all; otherwise a row is
   * visible when the viewer is its run-as, spawned it directly, or created the automation that did.
   * `prefix` is the column qualifier ('' for term_sessions itself, 's.' when joined as `s`).
   */
  private scopeSql(prefix: string, viewer: FeedViewer): { sql: string; params: unknown[] } {
    if (viewer.isAdmin) return { sql: '', params: [] };
    const autoIds = this.myAutomations(viewer.id);
    const parts = [`${prefix}run_as = ?`, `${prefix}spawned_by = ?`];
    const params: unknown[] = [viewer.id, viewer.id];
    if (autoIds.length) {
      parts.push(`${prefix}spawned_by IN (${autoIds.map(() => '?').join(',')})`);
      params.push(...autoIds);
    }
    return { sql: `(${parts.join(' OR ')})`, params };
  }

  /** The viewer's own automations, as `automation:<id>` provenance strings (for the scope clause). */
  private myAutomations(viewerId: string): string[] {
    return this.db
      .prepare('SELECT id FROM automations WHERE created_by = ?')
      .all<{ id: string }>(viewerId)
      .map((a) => `automation:${a.id}`);
  }
}

function andClause(scope: string): string {
  return scope ? `AND ${scope}` : '';
}

function parseCursor(cursor?: string): { ts: number; uid: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(':'); // uid itself contains ':', so split on the FIRST separator only
  if (i < 0) return null;
  const ts = Number(cursor.slice(0, i));
  const uid = cursor.slice(i + 1);
  return Number.isFinite(ts) && uid ? { ts, uid } : null;
}

function mapRow(r: FeedRow): FeedItem {
  return {
    uid: r.uid,
    ts: r.ts,
    kind: r.kind,
    state: r.state,
    runId: r.run_id,
    agent: r.agent,
    runAs: r.run_as,
    spawnedBy: r.spawned_by,
    goal: r.goal_id ? { id: r.goal_id, title: r.goal_title ?? '(untitled goal)' } : null,
    title: r.title ?? '',
    ref: { table: r.ref_table, id: r.ref_id },
    target: feedTarget(r.kind, r.run_id),
    capability: r.capability,
    level: r.level,
    args: r.args ? safeParse(r.args) : null,
    status: r.status,
    costUsd: r.cost_usd,
    tokens: r.tokens,
    outcome: r.outcome,
    rating: r.rating,
    hasTrail: r.state === 'done',
  };
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
