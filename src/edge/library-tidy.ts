/**
 * Library improvement tile — **declutter the artifacts gallery** (Library domain of Insights v2).
 *
 * The Library accumulates throwaway output: a generated test image, a scratch file, a one-off render from
 * a run that's since been deleted. Nothing prunes it, so the gallery fills with dead weight. This turns
 * that into a REVIEWABLE **soft-archive**: a deterministic preview of exactly which artifacts would be
 * hidden, then an apply that sets `archived_at` (the row + files survive — an archived artifact is one
 * click from restored, `ArtifactStore.unarchive`). Same reversibility posture as KB tidy.
 *
 * Conservative on purpose. Only **orphaned** artifacts — produced by a session that no longer exists — that
 * are old AND were never shared (no team-share, no public link) are archivable: an artifact whose run is
 * gone and that nobody ever shared is throwaway by definition. Old-but-still-owned artifacts are surfaced
 * for MANUAL review (never auto-archived) — a deliverable shouldn't vanish on a timer. Pure over
 * `artifacts` (⋈ `term_sessions` for the orphan test); no LLM.
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
const DEAD_AFTER_DAYS = 30;  // orphaned + never-shared + older than this → archivable clutter
const STALE_AFTER_DAYS = 60; // never-shared, older than this, session still exists → surface for review
const SAMPLE = 8;

export interface LibraryTidyItem { id: string; title: string; kind: string; agent: string; ageDays: number; bytes: number }
export interface LibraryTidyPlan {
  deadAfterDays: number;
  staleAfterDays: number;
  dead: { total: number; bytes: number; sample: LibraryTidyItem[] };   // archivable now (orphaned, never shared)
  stale: { total: number; sample: LibraryTidyItem[] };                  // review-only (old, still owned)
}

interface Row { id: string; title: string; kind: string; agent: string; created_at: number; bytes: number }

function toItem(r: Row, now: number): LibraryTidyItem {
  return { id: r.id, title: r.title || r.id, kind: r.kind, agent: r.agent, ageDays: Math.floor((now - r.created_at) / DAY), bytes: r.bytes };
}

// Never-shared = no team share AND no (live) public link. Orphaned = its producing session is gone;
// OWNED = the producing session still exists (the review set that must NOT be auto-archived).
const NEVER_SHARED = "shared_team = 0 AND share_token IS NULL";
const ORPHANED = "session_id NOT IN (SELECT id FROM term_sessions)";
const OWNED = "session_id IN (SELECT id FROM term_sessions)";

/** Compute the archivable (dead) + review (stale) artifact lists WITHOUT mutating anything. */
export function planLibraryTidy(os: AgentOS, now = Date.now()): LibraryTidyPlan {
  const db = os.db;
  const deadRows = db
    .prepare(`SELECT id, title, kind, agent, created_at, bytes FROM artifacts WHERE archived_at IS NULL AND ${NEVER_SHARED} AND ${ORPHANED} AND created_at < ? ORDER BY created_at`)
    .all<Row>(now - DEAD_AFTER_DAYS * DAY);
  const staleRows = db
    .prepare(`SELECT id, title, kind, agent, created_at, bytes FROM artifacts WHERE archived_at IS NULL AND ${NEVER_SHARED} AND ${OWNED} AND created_at < ? ORDER BY created_at`)
    .all<Row>(now - STALE_AFTER_DAYS * DAY);
  return {
    deadAfterDays: DEAD_AFTER_DAYS,
    staleAfterDays: STALE_AFTER_DAYS,
    dead: { total: deadRows.length, bytes: deadRows.reduce((s, r) => s + (r.bytes || 0), 0), sample: deadRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
    stale: { total: staleRows.length, sample: staleRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
  };
}

/** Soft-archive the DEAD (orphaned, never-shared, aged) artifacts — reversible (restore from Library). Audited. */
export function applyLibraryTidy(os: AgentOS, by = 'system', now = Date.now()): { archived: number } {
  const rows = os.db
    .prepare(`SELECT id FROM artifacts WHERE archived_at IS NULL AND ${NEVER_SHARED} AND ${ORPHANED} AND created_at < ?`)
    .all<{ id: string }>(now - DEAD_AFTER_DAYS * DAY);
  let archived = 0;
  for (const r of rows) if (os.artifacts.archive(r.id, now)) archived++;
  if (archived) {
    os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: by, type: 'library.tidied', data: { archived, via: 'insights-tidy', deadAfterDays: DEAD_AFTER_DAYS } });
  }
  return { archived };
}
