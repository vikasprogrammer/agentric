/**
 * Per-agent trust / maturity stats — the "which agent can the system trust to run with less
 * oversight" view. This is a READ-SIDE aggregator: it invents no new bookkeeping, it rolls up
 * signals already flowing through the governed gateway (audit_events), the sessions table, the
 * inbox self-reports (messages), the approvals plane, and the tasks board.
 *
 * A run's outcome is scored by the GOVERNED rule (a human denial or a crash can't be papered over
 * by an optimistic self-report):
 *
 *   failure       if the run crashed, hit a denial (human reject / policy deny / killswitch /
 *                 budget stop), self-reported failure, OR its dispatching task ended `blocked`
 *   success       if its dispatching task ended `done`, OR the agent self-reported success on a
 *                 clean, un-denied run
 *   inconclusive  otherwise (still running, or ended with no verdict either way)
 *
 * Maturity is NOT the success rate — it answers a different question ("trust to run alone"):
 *
 *   maturity = autonomy × (1 − denialRate) × volumeConfidence
 *
 *   autonomy         = (governed actions − human-gated actions) / governed actions
 *                      (how often the agent acted without suspending for a human approval)
 *   denialRate       = runs with a denial / total runs   (a human/policy saying "no" — the sharpest
 *                      "not ready" signal, so it multiplies down hard)
 *   volumeConfidence = runs / (runs + K)                 (5 clean runs must not outrank 200)
 */
import { Db } from './db';

/** Smoothing constant for volume confidence: at K runs, confidence is 0.5. */
const CONFIDENCE_K = 8;

export interface AgentStats {
  agentId: string;
  runs: { total: number; running: number; done: number; stopped: number; crashed: number };
  /** Governed per-run verdict (see the module header). `inconclusive` = running or no verdict. */
  outcomes: { success: number; failure: number; inconclusive: number };
  /** Governed-action tallies from the audit stream. */
  actions: {
    governed: number;      // gate.attempt — every governed action the agent tried
    humanGated: number;    // approval.requested — actions that suspended for a human
    autoApproved: number;  // approval.auto_approved — needed a level but an auto-approver cleared it
    denied: number;        // policy hard-deny (gate.decision effect=deny)
    rejected: number;      // approval.resolved with approved=false (a human said no)
    killswitch: number;    // gate.killswitch
    errors: number;        // session.error
    budgetStops: number;   // budget.exceeded
  };
  tasks: { done: number; blocked: number; cancelled: number };
  /** Distinct runs that hit any denial (reject / policy deny / killswitch / budget stop). */
  deniedRuns: number;
  /** question.asked — times the agent blocked on a human decision. */
  questions: number;
  firstRunAt: number | null;
  lastRunAt: number | null;
  // ── derived ──────────────────────────────────────────────────────────────────
  autonomy: number;          // 0..1
  denialRate: number;        // 0..1
  successRate: number | null; // success / (success + failure); null when nothing decided
  volumeConfidence: number;  // 0..1
  maturity: number;          // 0..1 — the headline trust score
  confidence: 'none' | 'low' | 'medium' | 'high';
}

interface SessionRow { id: string; agent: string; status: string; spawned_by: string | null; created_at: number; updated_at: number | null; }

function blank(agentId: string): AgentStats {
  return {
    agentId,
    runs: { total: 0, running: 0, done: 0, stopped: 0, crashed: 0 },
    outcomes: { success: 0, failure: 0, inconclusive: 0 },
    actions: { governed: 0, humanGated: 0, autoApproved: 0, denied: 0, rejected: 0, killswitch: 0, errors: 0, budgetStops: 0 },
    tasks: { done: 0, blocked: 0, cancelled: 0 },
    deniedRuns: 0,
    questions: 0,
    firstRunAt: null,
    lastRunAt: null,
    autonomy: 1,
    denialRate: 0,
    successRate: null,
    volumeConfidence: 0,
    maturity: 0,
    confidence: 'none',
  };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Compute per-agent maturity stats over the whole workspace history.
 * @param agentIds when provided, agents with zero runs are still included (blank rows), so the
 *   console can show a freshly-created agent at `confidence: 'none'` rather than omitting it.
 */
export function computeAgentStats(db: Db, agentIds?: string[]): AgentStats[] {
  const by = new Map<string, AgentStats>();
  const get = (agent: string): AgentStats => {
    let s = by.get(agent);
    if (!s) { s = blank(agent); by.set(agent, s); }
    return s;
  };
  for (const id of agentIds ?? []) get(id);

  // ── 1. sessions → runs, status counts, activity window; and the run_id → agent join map ──
  const sessions = db.prepare(
    'SELECT id, agent, status, spawned_by, created_at, COALESCE(updated_at, created_at) AS updated_at FROM term_sessions'
  ).all() as unknown as SessionRow[];
  const agentOf = new Map<string, string>();      // session id → agent
  const spawnedByOf = new Map<string, string | null>();
  const statusOf = new Map<string, string>();
  for (const r of sessions) {
    agentOf.set(r.id, r.agent);
    spawnedByOf.set(r.id, r.spawned_by);
    statusOf.set(r.id, r.status);
    const s = get(r.agent);
    s.runs.total++;
    if (r.status === 'running') s.runs.running++;
    else if (r.status === 'stopped') s.runs.stopped++;
    else if (r.status === 'crashed') s.runs.crashed++;
    else s.runs.done++;
    if (s.firstRunAt === null || r.created_at < s.firstRunAt) s.firstRunAt = r.created_at;
    const last = r.updated_at ?? r.created_at;
    if (s.lastRunAt === null || last > s.lastRunAt) s.lastRunAt = last;
  }

  // ── 2. self-reported outcomes (the agent grading its own homework) — latest 'completed' per run ──
  const selfOutcome = new Map<string, string>();
  const completed = db.prepare(
    "SELECT session_id, outcome FROM messages WHERE type = 'completed' AND outcome IS NOT NULL ORDER BY created_at ASC"
  ).all() as unknown as Array<{ session_id: string; outcome: string }>;
  for (const c of completed) selfOutcome.set(c.session_id, c.outcome); // ASC → last write wins

  // ── 3. task outcomes (ground truth for dispatched work) ──
  const taskStatus = new Map<string, string>();
  const tasks = db.prepare('SELECT id, status, assignee FROM tasks').all() as unknown as Array<{ id: string; status: string; assignee: string | null }>;
  for (const t of tasks) {
    taskStatus.set(t.id, t.status);
    if (t.assignee && t.assignee.startsWith('agent:')) {
      const s = get(t.assignee.slice('agent:'.length));
      if (t.status === 'done') s.tasks.done++;
      else if (t.status === 'blocked') s.tasks.blocked++;
      else if (t.status === 'cancelled') s.tasks.cancelled++;
    }
  }

  // ── 4. governed-action tallies from the audit stream, joined to the agent via run_id ──
  const deniedRunSet = new Set<string>();
  const audit = db.prepare(
    `SELECT run_id, type, data FROM audit_events WHERE type IN
      ('gate.attempt','approval.requested','approval.resolved','approval.auto_approved',
       'gate.decision','gate.killswitch','session.error','budget.exceeded','question.asked')`
  ).all() as unknown as Array<{ run_id: string; type: string; data: string }>;
  for (const ev of audit) {
    const agent = agentOf.get(ev.run_id);
    if (!agent) continue; // an audit row whose session we can't resolve (e.g. '-' housekeeping) — skip
    const s = get(agent);
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(ev.data) as Record<string, unknown>; } catch { /* keep {} */ }
    switch (ev.type) {
      case 'gate.attempt': s.actions.governed++; break;
      case 'approval.requested': s.actions.humanGated++; break;
      case 'approval.auto_approved': s.actions.autoApproved++; break;
      case 'approval.resolved':
        if (d.approved === false) { s.actions.rejected++; deniedRunSet.add(ev.run_id); }
        break;
      case 'gate.decision': {
        const eff = (d.decision as { effect?: string } | undefined)?.effect;
        if (eff === 'deny') { s.actions.denied++; deniedRunSet.add(ev.run_id); }
        break;
      }
      case 'gate.killswitch': s.actions.killswitch++; deniedRunSet.add(ev.run_id); break;
      case 'session.error': s.actions.errors++; break;
      case 'budget.exceeded': s.actions.budgetStops++; deniedRunSet.add(ev.run_id); break;
      case 'question.asked': s.questions++; break;
    }
  }

  // ── 5. governed per-run outcome + derived scores ──
  for (const r of sessions) {
    const s = get(r.agent);
    const denied = deniedRunSet.has(r.id);
    const crashed = r.status === 'crashed';
    const self = selfOutcome.get(r.id);
    const sb = spawnedByOf.get(r.id) ?? null;
    const taskStat = sb && sb.startsWith('task:') ? taskStatus.get(sb.slice('task:'.length)) : undefined;
    if (crashed || denied || self === 'failure' || taskStat === 'blocked') s.outcomes.failure++;
    else if (taskStat === 'done' || (self === 'success' && !denied && r.status === 'done')) s.outcomes.success++;
    else s.outcomes.inconclusive++;
  }

  for (const s of by.values()) {
    s.deniedRuns = 0; // recount from the set per agent
  }
  for (const runId of deniedRunSet) {
    const agent = agentOf.get(runId);
    if (agent) get(agent).deniedRuns++;
  }

  for (const s of by.values()) {
    const runs = s.runs.total;
    s.autonomy = s.actions.governed > 0 ? clamp01((s.actions.governed - s.actions.humanGated) / s.actions.governed) : 1;
    s.denialRate = runs > 0 ? clamp01(s.deniedRuns / runs) : 0;
    s.volumeConfidence = runs > 0 ? runs / (runs + CONFIDENCE_K) : 0;
    const decided = s.outcomes.success + s.outcomes.failure;
    s.successRate = decided > 0 ? s.outcomes.success / decided : null;
    s.maturity = clamp01(s.autonomy * (1 - s.denialRate) * s.volumeConfidence);
    s.confidence = runs === 0 ? 'none' : runs < 10 ? 'low' : runs < 40 ? 'medium' : 'high';
  }

  return [...by.values()].sort((a, b) => b.maturity - a.maturity || b.runs.total - a.runs.total);
}

/** Convenience: stats for one agent (blank row when it has no history). */
export function computeAgentStat(db: Db, agentId: string): AgentStats {
  return computeAgentStats(db, [agentId]).find((s) => s.agentId === agentId) ?? blank(agentId);
}
