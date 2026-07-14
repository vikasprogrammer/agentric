/**
 * KB improvement tile — **"generate the fix" for the knowledge base** (KB domain of Insights v2).
 *
 * The tile detects clutter (never-read aged pages + long-unread pages); this turns it into a REVIEWABLE
 * archive: a deterministic **preview** of exactly which DEAD pages (never read, aged past a floor) would be
 * archived, so an owner eyeballs them before removal — then **applies** it. Removal is soft: `kb.remove`
 * deletes the live page + its file but the `kb_revisions` history survives, so an archived page is
 * recoverable via revert — the same reversibility posture as the other v2 fixes.
 *
 * Conservative on purpose. Only NEVER-read pages are archivable; pages that were read but have gone stale
 * are surfaced for MANUAL review (linked, not deleted) — a once-useful reference shouldn't vanish on a
 * timer. Pure over `kb_pages`; no LLM (like Memory cleanup, unlike the Agents/Skills spawns).
 */
import type { AgentOS } from '../kernel';

const DAY = 86_400_000;
const DEAD_AFTER_DAYS = 30;  // never-read AND older than this → archivable clutter
const STALE_AFTER_DAYS = 90; // was read, but not since this → surface for review (never auto-archived)
const SAMPLE = 8;

export interface KbTidyItem { id: string; section: string; slug: string; title: string; ageDays: number; lastReadDays: number | null }
export interface KbTidyPlan {
  deadAfterDays: number;
  staleAfterDays: number;
  dead: { total: number; sample: KbTidyItem[] };   // archivable now (never read)
  stale: { total: number; sample: KbTidyItem[] };   // review-only (read once, long ago)
}

interface Row { id: string; section: string; slug: string; title: string; created_at: number; read_count: number; last_read_at: number | null }

function toItem(r: Row, now: number): KbTidyItem {
  return {
    id: r.id, section: r.section, slug: r.slug, title: r.title || `${r.section}/${r.slug}`,
    ageDays: Math.floor((now - r.created_at) / DAY),
    lastReadDays: r.last_read_at ? Math.floor((now - r.last_read_at) / DAY) : null,
  };
}

/** Compute the archivable (dead) + review (stale) page lists WITHOUT mutating anything (the review artifact). */
export function planKbTidy(os: AgentOS, now = Date.now()): KbTidyPlan {
  const db = os.db;
  const deadRows = db
    .prepare('SELECT id, section, slug, title, created_at, read_count, last_read_at FROM kb_pages WHERE tenant = ? AND read_count = 0 AND created_at < ? ORDER BY created_at')
    .all<Row>(os.tenant, now - DEAD_AFTER_DAYS * DAY);
  const staleRows = db
    .prepare('SELECT id, section, slug, title, created_at, read_count, last_read_at FROM kb_pages WHERE tenant = ? AND last_read_at IS NOT NULL AND last_read_at < ? ORDER BY last_read_at')
    .all<Row>(os.tenant, now - STALE_AFTER_DAYS * DAY);
  return {
    deadAfterDays: DEAD_AFTER_DAYS,
    staleAfterDays: STALE_AFTER_DAYS,
    dead: { total: deadRows.length, sample: deadRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
    stale: { total: staleRows.length, sample: staleRows.slice(0, SAMPLE).map((r) => toItem(r, now)) },
  };
}

/** Archive the DEAD (never-read, aged) pages — soft remove (history survives, revertable). Audited. */
export function applyKbTidy(os: AgentOS, by = 'system', now = Date.now()): { archived: number } {
  const db = os.db;
  const rows = db
    .prepare('SELECT id, section, slug FROM kb_pages WHERE tenant = ? AND read_count = 0 AND created_at < ?')
    .all<{ id: string; section: string; slug: string }>(os.tenant, now - DEAD_AFTER_DAYS * DAY);
  let archived = 0;
  for (const r of rows) if (os.kb.remove(r.id)) archived++;
  if (archived) {
    os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: by, type: 'kb.tidied', data: { archived, via: 'insights-tidy', deadAfterDays: DEAD_AFTER_DAYS } });
  }
  return { archived };
}
