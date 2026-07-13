/**
 * Owner **insights** — Dreaming as an analyst for the human, not just a self-tuning loop. Where the
 * reflect pass distils guidance for *agents* and the measurement loop answers "is it working?", this
 * answers the two questions an owner asks first:
 *
 *  - **Per-agent scorecard** — who's my MVP, who's struggling, and what does each work on. (last 30d)
 *  - **Friction map** — which capabilities keep getting rejected at approval (deny them outright or
 *    auto-allow?), and how many approvals are piling up on a human.
 *
 * Deterministic + pure over the DB — the always-on baseline (the LLM gardener can layer qualitative
 * root-cause on top later). Rendered on the Dreaming page. See docs/PILLARS.md §10.
 */
import type { AgentOS } from '../kernel';

import { diagnosisSlug } from './diagnosis';

type Db = AgentOS['db'];

const DAY = 24 * 3_600_000;
const WINDOW_DAYS = 30;
const STOP = new Set(['task', 'outcome', 'session', 'with', 'this', 'that', 'from', 'into', 'your', 'their', 'about', 'over', 'when', 'while', 'should', 'would', 'could', 'have', 'been', 'were', 'them', 'they', 'will', 'just', 'also', 'using', 'used', 'ran', 'done', 'made', 'make', 'need', 'needs', 'some', 'more', 'than', 'only', 'each', 'both', 'unknown', 'none', 'then', 'call', 'test', 'once', 'stop', 'tool', 'tools', 'exactly', 'nothing', 'else']);

export interface AgentScore { agent: string; runs: number; success: number; failed: number; stopped: number; crashed: number; chats: number; rate: number | null; focus: string[]; diagnosis?: { at: number; slug: string } }
export interface RejectedCapability { capability: string; count: number }
export interface FrictionMap { rejections: RejectedCapability[]; pendingApprovals: number; oldestPendingAgeMs: number | null }
export interface Insights { windowDays: number; agents: AgentScore[]; friction: FrictionMap }

interface OutRow { run_id: string; agent: string; spawned_by: string | null; status: string; outcome: string | null }
interface EpRow { agent_id: string; content: string }

/** Top few focus keywords for one agent's episode first-lines (what it actually spends runs on). */
function focusFor(contents: string[]): string[] {
  const counts = new Map<string, number>();
  for (const c of contents) {
    const line = (c.split('\n').map((l) => l.trim()).find(Boolean) ?? '').replace(/^Task:\s*/i, '');
    const seen = new Set<string>();
    for (const w of line.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
      if (STOP.has(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
}

export function buildInsights(os: AgentOS, now = Date.now()): Insights {
  const db = os.db;
  const since = now - WINDOW_DAYS * DAY;

  // Base the tally on every TERMINATED session in the window (not just those that emitted a terminal
  // audit event) — so a HARD crash (process/pane died, no `session.ended`) is still counted; its outcome
  // comes from a per-session subquery, or falls back to the row's `status` (e.g. crashed). Excludes
  // still-running sessions.
  const rows = db
    .prepare(
      "SELECT s.id AS run_id, s.agent, s.spawned_by, s.status, " +
        "(SELECT CASE WHEN a.type = 'session.stopped' THEN 'stopped' ELSE COALESCE(json_extract(a.data,'$.outcome'),'unknown') END " +
        "   FROM audit_events a WHERE a.run_id = s.id AND a.type IN ('session.reported','session.ended','session.stopped','run.completed') " +
        "   ORDER BY CASE a.type WHEN 'session.reported' THEN 3 WHEN 'run.completed' THEN 2 WHEN 'session.ended' THEN 1 ELSE 0 END DESC LIMIT 1) AS outcome " +
        "FROM term_sessions s WHERE s.created_at >= ? AND s.status != 'running'",
    )
    .all<OutRow>(since);
  const tally = new Map<string, { runs: number; success: number; failed: number; stopped: number; crashed: number; chats: number }>();
  for (const r of rows) {
    const t = tally.get(r.agent) ?? { runs: 0, success: 0, failed: 0, stopped: 0, crashed: 0, chats: 0 };
    // Chat-triggered sessions are conversational Q&A — they don't call `report`, so counting them in the
    // success rate unfairly penalises chat-heavy agents (they'd all look like they're "failing"). Track
    // them separately and keep them OUT of the rate denominator.
    if ((r.spawned_by ?? '').startsWith('chat:')) { t.chats++; tally.set(r.agent, t); continue; }
    const outcome = r.outcome ?? 'unknown';
    t.runs++;
    if (r.status === 'crashed') t.crashed++;          // crash = infra died, surfaced distinctly from a `failure`
    else if (outcome === 'success') t.success++;
    else if (outcome === 'failure') t.failed++;
    else if (outcome === 'stopped') t.stopped++;
    tally.set(r.agent, t);
  }

  // Per-agent focus from this window's episodes.
  const eps = db.prepare("SELECT agent_id, content FROM memories WHERE created_at >= ? AND tags LIKE '%\"episode\"%'").all<EpRow>(since);
  const epByAgent = new Map<string, string[]>();
  for (const e of eps) { const a = epByAgent.get(e.agent_id) ?? []; a.push(e.content); epByAgent.set(e.agent_id, a); }

  const agents: AgentScore[] = [...tally.entries()]
    .map(([agent, t]) => {
      const dx = os.kb.read(os.tenant, 'operations', diagnosisSlug(agent)); // existing root-cause diagnosis, if any
      return { agent, runs: t.runs, success: t.success, failed: t.failed, stopped: t.stopped, crashed: t.crashed, chats: t.chats, rate: t.runs ? Math.round((t.success / t.runs) * 100) : null, focus: focusFor(epByAgent.get(agent) ?? []), diagnosis: dx ? { at: dx.updatedAt, slug: dx.slug } : undefined };
    })
    // Rank by activity — work runs, then chats — so a chat-only agent still appears.
    .sort((a, b) => (b.runs + b.chats) - (a.runs + a.chats))
    .slice(0, 12);

  // Friction: capabilities rejected at approval (deny or auto-allow?), + approvals waiting on a human.
  const rejections = db
    .prepare("SELECT capability, count(*) AS count FROM approvals WHERE status = 'rejected' GROUP BY capability ORDER BY count DESC LIMIT 8")
    .all<RejectedCapability>();
  const pending = db.prepare("SELECT count(*) AS n, MIN(created_at) AS oldest FROM approvals WHERE status = 'pending'").get<{ n: number; oldest: number | null }>();
  const friction: FrictionMap = {
    rejections,
    pendingApprovals: pending?.n ?? 0,
    oldestPendingAgeMs: pending?.oldest ? now - pending.oldest : null,
  };

  return { windowDays: WINDOW_DAYS, agents, friction };
}
