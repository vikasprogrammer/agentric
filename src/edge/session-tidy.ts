/**
 * Sessions improvement tile — **declutter the Sessions list** (Sessions domain of Insights v2).
 *
 * The run history grows without bound: every dispatched task, chat reply, and cron fire leaves a terminal
 * session row. Old finished runs bury the handful that still matter. This turns that into a REVIEWABLE
 * **soft-archive**: a deterministic preview of exactly which old, settled sessions would be hidden, then an
 * apply that sets `archived_at` (the row + transcript survive — one click restores it, and every by-id
 * reference stays intact: task-reconcile's `last_session_id` join, audit, cost). Same reversibility
 * posture as KB tidy / Library declutter — a hide, never a delete.
 *
 * Conservative on purpose:
 *  · **done**    — cleanly completed AND older than the floor → archivable (the run is over, nothing to see).
 *  · **stopped/crashed** — interrupted or failed AND old → surfaced for REVIEW (a failure may still be worth
 *    a look before it's hidden; never auto-archived).
 * NEVER touches running, blocked-on-a-human (pending ask/approval), or recent sessions. Pure over
 * `term_sessions`; no LLM.
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
const DEAD_AFTER_DAYS = 14;  // cleanly-done AND older than this → archivable
const SAMPLE = 8;

export interface SessionTidyItem { id: string; title: string; agent: string; status: string; outcome: string | null; ageDays: number }
export interface SessionTidyPlan {
  deadAfterDays: number;
  dead: { total: number; sample: SessionTidyItem[] };    // clean `done`, old → archivable
  stale: { total: number; sample: SessionTidyItem[] };   // stopped/crashed, old → review only
}

interface Row { id: string; title: string; agent: string; status: string; outcome: string | null; created_at: number }

function toItem(r: Row, now: number): SessionTidyItem {
  return { id: r.id, title: r.title || r.id, agent: r.agent, status: r.status, outcome: r.outcome, ageDays: Math.floor((now - r.created_at) / DAY) };
}

// Blocked-on-a-human rows are never clutter, even if old — exclude any with a pending ask/approval.
const NOT_BLOCKED =
  "id NOT IN (SELECT run_id FROM questions WHERE status = 'pending') " +
  "AND id NOT IN (SELECT run_id FROM approvals WHERE status = 'pending')";

/** Compute the archivable (done) + review (stopped/crashed) session lists WITHOUT mutating anything. */
export function planSessionTidy(os: AgentOS, now = Date.now()): SessionTidyPlan {
  const db = os.db;
  const cutoff = now - DEAD_AFTER_DAYS * DAY;
  const deadRows = db
    .prepare(`SELECT id, title, agent, status, outcome, created_at FROM term_sessions WHERE archived_at IS NULL AND status = 'done' AND created_at < ? AND ${NOT_BLOCKED} ORDER BY created_at`)
    .all<Row>(cutoff);
  const staleRows = db
    .prepare(`SELECT id, title, agent, status, outcome, created_at FROM term_sessions WHERE archived_at IS NULL AND status IN ('stopped','crashed') AND created_at < ? AND ${NOT_BLOCKED} ORDER BY created_at`)
    .all<Row>(cutoff);
  return {
    deadAfterDays: DEAD_AFTER_DAYS,
    dead: { total: deadRows.length, sample: deadRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
    stale: { total: staleRows.length, sample: staleRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
  };
}

/** Soft-archive the DEAD (clean `done`, aged) sessions — reversible (restore from the list). Audited. */
export function applySessionTidy(os: AgentOS, tm: { archiveSession(id: string, now?: number): boolean }, by = 'system', now = Date.now()): { archived: number } {
  const rows = os.db
    .prepare(`SELECT id FROM term_sessions WHERE archived_at IS NULL AND status = 'done' AND created_at < ? AND ${NOT_BLOCKED}`)
    .all<{ id: string }>(now - DEAD_AFTER_DAYS * DAY);
  let archived = 0;
  for (const r of rows) if (tm.archiveSession(r.id, now)) archived++;
  if (archived) {
    os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: by, type: 'sessions.tidied', data: { archived, via: 'insights-tidy', deadAfterDays: DEAD_AFTER_DAYS } });
  }
  return { archived };
}
