/**
 * Owner **improvement tiles** — the intelligence layer pointing at *what to make better*, across the whole
 * OS, not just what happened. One deterministic tile per domain (agents · KB · goals · skills · memory ·
 * automations): it detects the top improvement opportunity, counts it, and offers a one-tap action into
 * the surface where you fix it (reusing existing pages/actions). Pure over the DB — cheap, always-on.
 *
 * v1 is detect + navigate/reuse; LLM "generate the fix" per domain (rewrite a weak CLAUDE.md, draft a
 * skill, merge duplicate memories) layers on later. Rendered on the Insights page + bundled into
 * `GET /api/insights`. See src/edge/insights.ts.
 */
import type { AgentOS } from '../kernel';
import type { Insights } from './insights';
import { BUILTIN_SEED_IDS } from './agent-catalog';
import { CONSOLIDATOR_ID } from './consolidation';
import { ANALYST_ID } from './diagnosis';
import { IMPROVER_ID } from './improver';
import { SCOUT_ID } from './skill-scout';
import { STRATEGIST_ID } from './strategist';

// The agents Agent OS provisions itself — never a "retire" candidate, however idle (they're on-demand
// helpers: the consolidator/scout/strategist/… only run when the self-learning loop needs them). Mirrors
// the `BUILT_IN_AGENT_IDS` set the server uses to mark agents read-only.
const BUILT_IN_AGENTS = new Set<string>([...BUILTIN_SEED_IDS, CONSOLIDATOR_ID, SCOUT_ID, STRATEGIST_ID, IMPROVER_ID, ANALYST_ID]);
const AGENT_IDLE_DAYS = 30;   // ran before but not in this long → idle (a retire candidate)

const DAY = 24 * 3_600_000;
type Db = AgentOS['db'];

export type ImprovementDomain = 'agents' | 'kb' | 'goals' | 'skills' | 'memory' | 'automations' | 'tasks' | 'library' | 'sessions' | 'idle-agents';
export interface ImprovementTile {
  domain: ImprovementDomain;
  count: number;                 // opportunities found (0 = nothing to improve)
  title: string;                 // "3 agents underperforming"
  detail: string;                // one-line explanation of the opportunity
  actionLabel: string;           // button label
  href: string;                  // where to act (console route)
}

function num(db: Db, sql: string, ...args: (number | string)[]): number {
  return db.prepare(sql).get<{ n: number }>(...args)?.n ?? 0;
}

/** Build the six improvement tiles from current OS state (agents come from the already-computed scorecard). */
export function buildImprovements(os: AgentOS, insights: Insights, now = Date.now()): ImprovementTile[] {
  const db = os.db;
  const tiles: ImprovementTile[] = [];

  // 1) Agents — underperformers whose instructions (CLAUDE.md / starter prompts / tuning) likely need work.
  const weak = insights.agents.filter((a) => a.rate != null && a.rate < 50 && a.runs >= 3);
  tiles.push({
    domain: 'agents', count: weak.length,
    title: weak.length ? `${weak.length} agent${weak.length === 1 ? '' : 's'} underperforming` : 'Agents are healthy',
    detail: weak.length ? `Below 50% success: ${weak.slice(0, 3).map((a) => `${a.agent} (${a.rate}%)`).join(', ')}${weak.length > 3 ? '…' : ''}. Diagnose them, then tune their CLAUDE.md / starter prompts.` : 'No agent is below 50% success over the last 30 days.',
    actionLabel: 'Review agents', href: '#/agents',
  });

  // 2) KB — dead pages (never read) + stale pages (long unread) to archive or refresh.
  const kbDead = num(db, "SELECT count(*) AS n FROM kb_pages WHERE read_count = 0 AND created_at < ?", now - 30 * DAY);
  const kbStale = num(db, "SELECT count(*) AS n FROM kb_pages WHERE last_read_at IS NOT NULL AND last_read_at < ?", now - 90 * DAY);
  tiles.push({
    domain: 'kb', count: kbDead + kbStale,
    title: kbDead + kbStale ? `${kbDead + kbStale} KB page${kbDead + kbStale === 1 ? '' : 's'} to tidy` : 'Knowledge base is fresh',
    detail: kbDead + kbStale ? `${kbDead} never read (30+ days old), ${kbStale} unread in 90+ days — archive the dead ones, refresh the stale.` : 'No dead or long-stale pages.',
    actionLabel: 'Open Knowledge', href: '#/kb',
  });

  // 3) Goals — active goals with no progress recently (stuck) that a human/strategist should nudge.
  const stuck = num(db,
    "SELECT count(*) AS n FROM goals g WHERE g.status = 'active' AND COALESCE((SELECT MAX(created_at) FROM goal_events e WHERE e.goal_id = g.id), g.created_at) < ?",
    now - 7 * DAY);
  tiles.push({
    domain: 'goals', count: stuck,
    title: stuck ? `${stuck} goal${stuck === 1 ? '' : 's'} stuck` : 'Goals are moving',
    detail: stuck ? `${stuck} active goal${stuck === 1 ? '' : 's'} with no progress in 7+ days — plan the next tasks or re-scope.` : 'Every active goal has recent progress.',
    actionLabel: 'Open Goals', href: '#/goals',
  });

  // 4) Skills — proposals the fleet drafted, awaiting an owner to publish (or refine).
  const proposed = os.skills.list().filter((s) => s.proposed).length;
  tiles.push({
    domain: 'skills', count: proposed,
    title: proposed ? `${proposed} skill${proposed === 1 ? '' : 's'} proposed` : 'No skills waiting',
    detail: proposed ? `${proposed} agent-drafted skill${proposed === 1 ? '' : 's'} awaiting review — publish the good ones so the whole fleet can use them.` : 'No proposed skills to review right now.',
    actionLabel: 'Review skills', href: '#/skills',
  });

  // 5) Memory — never-recalled aged memories that just add noise; prune to sharpen recall.
  const prunable = num(db, "SELECT count(*) AS n FROM memories WHERE recall_count = 0 AND created_at < ?", now - 30 * DAY);
  tiles.push({
    domain: 'memory', count: prunable,
    title: prunable ? `${prunable} memories to prune` : 'Memory is tidy',
    detail: prunable ? `${prunable} memories never recalled in 30+ days — pruning noise sharpens what recall surfaces.` : 'No stale never-recalled memories.',
    actionLabel: 'Open Memory', href: '#/memory',
  });

  // 6) Automations — enabled ones whose last run errored, or cron that has gone quiet.
  const failing = num(db, "SELECT count(*) AS n FROM automations a WHERE a.enabled = 1 AND a.last_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events e WHERE e.run_id = a.last_session_id AND e.type = 'session.error')");
  const idle = num(db, "SELECT count(*) AS n FROM automations a WHERE a.enabled = 1 AND a.type = 'cron' AND (a.last_fired_at IS NULL OR a.last_fired_at < ?)", now - 14 * DAY);
  tiles.push({
    domain: 'automations', count: failing + idle,
    title: failing + idle ? `${failing + idle} automation${failing + idle === 1 ? '' : 's'} need attention` : 'Automations are healthy',
    detail: failing + idle ? `${failing} whose last run errored, ${idle} enabled but quiet for 14+ days — fix or retire them.` : 'No failing or idle automations.',
    actionLabel: 'Open Automations', href: '#/automations',
  });

  // 7) Tasks — reconcile the board against reality: dispatched runs that finished but left the task open,
  // or died and stranded it in `doing`. See src/edge/task-reconcile.ts (the settle-grace lives there).
  const tSettle = now - 10 * 60_000;
  const tFinished = num(db, "SELECT count(*) AS n FROM tasks t JOIN term_sessions s ON s.id = t.last_session_id WHERE t.status = 'doing' AND s.status != 'running' AND s.created_at < ? AND LOWER(COALESCE(s.outcome, CASE WHEN s.status = 'done' THEN 'success' ELSE s.status END)) = 'success'", tSettle);
  const tStalled = num(db, "SELECT count(*) AS n FROM tasks t JOIN term_sessions s ON s.id = t.last_session_id WHERE t.status = 'doing' AND s.status != 'running' AND s.created_at < ? AND LOWER(COALESCE(s.outcome, CASE WHEN s.status = 'done' THEN 'success' ELSE s.status END)) != 'success'", tSettle);
  tiles.push({
    domain: 'tasks', count: tFinished + tStalled,
    title: tFinished + tStalled ? `${tFinished + tStalled} task${tFinished + tStalled === 1 ? '' : 's'} to reconcile` : 'Task board is in sync',
    detail: tFinished + tStalled ? `${tFinished} finished but still open (auto-closable), ${tStalled} stalled after a failed run — review the board.` : 'Every dispatched task matches its run.',
    actionLabel: 'Open Tasks', href: '#/tasks',
  });

  // 8) Library — declutter orphaned/never-shared artifacts (soft-archive, reversible). See library-tidy.ts.
  const libDead = num(db, "SELECT count(*) AS n FROM artifacts WHERE archived_at IS NULL AND shared_team = 0 AND share_token IS NULL AND session_id NOT IN (SELECT id FROM term_sessions) AND created_at < ?", now - 30 * DAY);
  const libStale = num(db, "SELECT count(*) AS n FROM artifacts WHERE archived_at IS NULL AND shared_team = 0 AND share_token IS NULL AND session_id IN (SELECT id FROM term_sessions) AND created_at < ?", now - 60 * DAY);
  tiles.push({
    domain: 'library', count: libDead + libStale,
    title: libDead + libStale ? `${libDead + libStale} artifact${libDead + libStale === 1 ? '' : 's'} to declutter` : 'Library is tidy',
    detail: libDead + libStale ? `${libDead} orphaned (run gone, never shared — archivable), ${libStale} old &amp; private — review the gallery.` : 'No orphaned or long-stale artifacts.',
    actionLabel: 'Open Library', href: '#/artifacts',
  });

  // 9) Sessions — declutter the run history: old cleanly-done runs (archivable) + old failed/stopped runs
  // (review). Never counts blocked-on-a-human or recent runs. See src/edge/session-tidy.ts.
  const notBlocked = "id NOT IN (SELECT run_id FROM questions WHERE status = 'pending') AND id NOT IN (SELECT run_id FROM approvals WHERE status = 'pending')";
  const sessDead = num(db, `SELECT count(*) AS n FROM term_sessions WHERE archived_at IS NULL AND status = 'done' AND created_at < ? AND ${notBlocked}`, now - 14 * DAY);
  const sessStale = num(db, `SELECT count(*) AS n FROM term_sessions WHERE archived_at IS NULL AND status IN ('stopped','crashed') AND created_at < ? AND ${notBlocked}`, now - 14 * DAY);
  tiles.push({
    domain: 'sessions', count: sessDead + sessStale,
    title: sessDead + sessStale ? `${sessDead + sessStale} old session${sessDead + sessStale === 1 ? '' : 's'} to archive` : 'Session list is tidy',
    detail: sessDead + sessStale ? `${sessDead} cleanly done 14d+ ago (archivable), ${sessStale} stopped/crashed — review before hiding.` : 'No old settled sessions.',
    actionLabel: 'Open Sessions', href: '#/sessions',
  });

  // 10) Idle agents — user-created claude-code agents that RAN before but have gone quiet (no run in
  // 30+ days). Retiring an agent is destructive (and its automations/assignments would need handling),
  // so this is DETECT + NAVIGATE only — surface the candidates and let a human decide on the Agents page.
  // "Ran before" (in the map) is the age proxy — it avoids flagging a brand-new, never-run agent — and
  // never flags the OS's own built-in helpers (on-demand by design).
  const lastRun = new Map(db.prepare("SELECT agent, MAX(created_at) AS m FROM term_sessions GROUP BY agent").all<{ agent: string; m: number }>().map((r) => [r.agent, r.m]));
  const idleAgents = [...os.agents.values()].filter((a) => {
    const last = lastRun.get(a.id);
    return a.runtime === 'claude-code' && !BUILT_IN_AGENTS.has(a.id) && last != null && last < now - AGENT_IDLE_DAYS * DAY;
  });
  tiles.push({
    domain: 'idle-agents', count: idleAgents.length,
    title: idleAgents.length ? `${idleAgents.length} idle agent${idleAgents.length === 1 ? '' : 's'}` : 'No idle agents',
    detail: idleAgents.length ? `No run in ${AGENT_IDLE_DAYS}+ days: ${idleAgents.slice(0, 3).map((a) => a.id).join(', ')}${idleAgents.length > 3 ? '…' : ''}. Retire the ones you no longer need to keep the roster focused.` : 'Every agent has run recently.',
    actionLabel: 'Review agents', href: '#/agents',
  });

  return tiles;
}
