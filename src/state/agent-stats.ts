/**
 * Per-agent trust / maturity stats — the "which agent can the system trust to run with less
 * oversight" view. This is a READ-SIDE aggregator: it invents no new bookkeeping, it rolls up
 * signals already flowing through the governed gateway (audit_events), the sessions table, the
 * inbox self-reports (messages), the approvals plane, and the tasks board.
 *
 * A run's outcome is scored best-available-source-wins, so an optimistic self-report can't paper over
 * a human's judgement or a crash:
 *
 *   1. HUMAN VERDICT (ground truth) — a 👍/👎 a person gave the finished run trumps everything:
 *      rating 'up' → success, 'down' → failure. This is the only true signal; when present, use it.
 *   2. Otherwise the GOVERNED rule:
 *        failure       run crashed, hit a denial (human reject / policy deny / killswitch / budget
 *                      stop), self-reported failure, OR its dispatching task ended `blocked`
 *        success       its dispatching task ended `done`, OR the agent self-reported success on a
 *                      clean, un-denied run
 *        inconclusive  otherwise (still running, or ended with no verdict either way)
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

/** Learning-velocity windowing (all in RUNS, not wall-clock — a quiet agent isn't a stalled one). */
const VELOCITY_WINDOW = 10; // runs per bucket; matches the "recent activity" grain of volumeConfidence
const VELOCITY_MIN = 4;     // need this many runs EACH side before we'll name a trend (else 'unproven')
const TREND_EPS = 0.05;     // dead-band so run-to-run noise doesn't flip warming/cooling

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
  /** Human 👍/👎 verdicts on this agent's runs — the ground-truth outcome signal. */
  rated: { up: number; down: number };
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
  /** Direction-of-travel: is maturity's underlying competence rising, flat, or falling? */
  velocity: AgentVelocity;
}

/**
 * Learning velocity — is this agent getting BETTER, plateaued, or regressing?
 *
 * Maturity answers "trust it to run alone right now"; velocity answers "which way is it moving". It's
 * the derivative of the volume-FREE competence core (autonomy × (1 − denialRate)) — deliberately NOT of
 * `maturity`, which folds in volumeConfidence and therefore only ever rises as runs accrue, so its slope
 * would read "improving" for an agent that's merely busy. Windowed by run count (see the constants).
 */
export interface AgentVelocity {
  /** Runs in the trailing (recent) window — the sample behind `recent`. 0..VELOCITY_WINDOW. */
  window: number;
  /** Competence = autonomy × (1 − denialRate) over the recent window. null → window empty. */
  recent: number | null;
  /** Same competence over the window BEFORE that — the baseline `recent` is measured against. */
  prior: number | null;
  /** recent − prior. >0 improving · <0 regressing · ~0 plateaued · null when either side is empty. */
  delta: number | null;
  /** Ground-truth cross-check: recent successRate − prior successRate (decided runs only). */
  outcomeDelta: number | null;
  /** Denial signatures (the denied capability) that recur in the recent window after already appearing
   *  earlier — the "same wall twice" count. High = lessons aren't sticking. */
  repeatFriction: number;
  /** Band for prompt injection / dashboards. warming=improving · steady=plateaued · cooling=regressing
   *  · unproven=too little windowed signal to judge. */
  trend: 'warming' | 'steady' | 'cooling' | 'unproven';
}

interface SessionRow { id: string; agent: string; status: string; spawned_by: string | null; created_at: number; updated_at: number | null; rating: string | null; }

function blank(agentId: string): AgentStats {
  return {
    agentId,
    runs: { total: 0, running: 0, done: 0, stopped: 0, crashed: 0 },
    outcomes: { success: 0, failure: 0, inconclusive: 0 },
    actions: { governed: 0, humanGated: 0, autoApproved: 0, denied: 0, rejected: 0, killswitch: 0, errors: 0, budgetStops: 0 },
    tasks: { done: 0, blocked: 0, cancelled: 0 },
    rated: { up: 0, down: 0 },
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
    velocity: { window: 0, recent: null, prior: null, delta: null, outcomeDelta: null, repeatFriction: 0, trend: 'unproven' },
  };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Per-run facts, bucketed so the whole-history aggregates can be re-folded over a recent window. */
interface RunFacts {
  agent: string;
  at: number;                          // created_at → the sort key for windowing
  governed: number;
  humanGated: number;
  denied: boolean;
  denialSigs: Set<string>;             // denied capabilities — the "which wall" of a friction event
  outcome: 'success' | 'failure' | null; // filled in step 5; decided runs only (inconclusive → null)
}

/** Competence over a slice — the SAME shape as headline maturity, MINUS volumeConfidence (which only
 *  climbs with run count and would pollute a derivative). null when the slice is empty. */
function windowCompetence(runs: RunFacts[]): number | null {
  if (runs.length === 0) return null;
  let gov = 0, gated = 0, denied = 0;
  for (const r of runs) { gov += r.governed; gated += r.humanGated; if (r.denied) denied++; }
  const autonomy = gov > 0 ? clamp01((gov - gated) / gov) : 1; // parity with the whole-history default
  const denialRate = clamp01(denied / runs.length);
  return clamp01(autonomy * (1 - denialRate));
}

/** Ground-truth companion to competence: success / (success+failure) over decided runs in the slice. */
function windowSuccessRate(runs: RunFacts[]): number | null {
  const decided = runs.filter((r) => r.outcome);
  return decided.length ? decided.filter((r) => r.outcome === 'success').length / decided.length : null;
}

/** Fold a per-agent, oldest→newest run list into its velocity: recent window vs the window before it. */
function computeVelocity(mine: RunFacts[]): AgentVelocity {
  const recent = mine.slice(-VELOCITY_WINDOW);
  const prior = mine.slice(-2 * VELOCITY_WINDOW, -VELOCITY_WINDOW);
  const rc = windowCompetence(recent), pc = windowCompetence(prior);
  const delta = rc !== null && pc !== null ? rc - pc : null;
  const rs = windowSuccessRate(recent), ps = windowSuccessRate(prior);
  // "same wall twice": a denial signature in the recent window that was already seen earlier.
  const priorSigs = new Set(prior.flatMap((r) => [...r.denialSigs]));
  const repeatFriction = recent.reduce(
    (n, r) => n + [...r.denialSigs].filter((sig) => priorSigs.has(sig)).length, 0);
  const enough = recent.length >= VELOCITY_MIN && prior.length >= VELOCITY_MIN;
  const trend: AgentVelocity['trend'] =
    !enough || delta === null ? 'unproven'
    : delta > TREND_EPS ? 'warming'
    : delta < -TREND_EPS ? 'cooling'
    : 'steady';
  return {
    window: recent.length, recent: rc, prior: pc, delta,
    outcomeDelta: rs !== null && ps !== null ? rs - ps : null,
    repeatFriction, trend,
  };
}

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
    'SELECT id, agent, status, spawned_by, rating, created_at, COALESCE(updated_at, created_at) AS updated_at FROM term_sessions'
  ).all() as unknown as SessionRow[];
  const agentOf = new Map<string, string>();      // session id → agent
  const spawnedByOf = new Map<string, string | null>();
  const statusOf = new Map<string, string>();
  const perRun = new Map<string, RunFacts>();     // session id → windowable per-run facts (for velocity)
  for (const r of sessions) {
    agentOf.set(r.id, r.agent);
    spawnedByOf.set(r.id, r.spawned_by);
    statusOf.set(r.id, r.status);
    perRun.set(r.id, { agent: r.agent, at: r.created_at, governed: 0, humanGated: 0, denied: false, denialSigs: new Set(), outcome: null });
    const s = get(r.agent);
    s.runs.total++;
    if (r.rating === 'up') s.rated.up++;
    else if (r.rating === 'down') s.rated.down++;
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
    const run = perRun.get(ev.run_id); // same run, windowable mirror of the aggregate tallies below
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(ev.data) as Record<string, unknown>; } catch { /* keep {} */ }
    const cap = typeof d.capability === 'string' ? d.capability : 'unknown';
    switch (ev.type) {
      case 'gate.attempt': s.actions.governed++; if (run) run.governed++; break;
      case 'approval.requested': s.actions.humanGated++; if (run) run.humanGated++; break;
      case 'approval.auto_approved': s.actions.autoApproved++; break;
      case 'approval.resolved':
        if (d.approved === false) { s.actions.rejected++; deniedRunSet.add(ev.run_id); if (run) { run.denied = true; run.denialSigs.add(`reject:${cap}`); } }
        break;
      case 'gate.decision': {
        const eff = (d.decision as { effect?: string } | undefined)?.effect;
        if (eff === 'deny') { s.actions.denied++; deniedRunSet.add(ev.run_id); if (run) { run.denied = true; run.denialSigs.add(`deny:${cap}`); } }
        break;
      }
      case 'gate.killswitch': s.actions.killswitch++; deniedRunSet.add(ev.run_id); if (run) { run.denied = true; run.denialSigs.add('killswitch'); } break;
      case 'session.error': s.actions.errors++; break;
      case 'budget.exceeded': s.actions.budgetStops++; deniedRunSet.add(ev.run_id); if (run) { run.denied = true; run.denialSigs.add('budget'); } break;
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
    // 1. A human's explicit verdict is ground truth — it trumps the governed heuristics below.
    let verdict: 'success' | 'failure' | null;
    if (r.rating === 'up') verdict = 'success';
    else if (r.rating === 'down') verdict = 'failure';
    // 2. Otherwise fall back to the governed rule.
    else if (crashed || denied || self === 'failure' || taskStat === 'blocked') verdict = 'failure';
    else if (taskStat === 'done' || (self === 'success' && !denied && r.status === 'done')) verdict = 'success';
    else verdict = null;
    if (verdict === 'success') s.outcomes.success++;
    else if (verdict === 'failure') s.outcomes.failure++;
    else s.outcomes.inconclusive++;
    const run = perRun.get(r.id);
    if (run) run.outcome = verdict; // feeds windowSuccessRate — the ground-truth arm of velocity
  }

  for (const s of by.values()) {
    s.deniedRuns = 0; // recount from the set per agent
  }
  for (const runId of deniedRunSet) {
    const agent = agentOf.get(runId);
    if (agent) get(agent).deniedRuns++;
  }

  // Group runs by agent, oldest→newest, so velocity can window the trailing slices.
  const runsByAgent = new Map<string, RunFacts[]>();
  for (const run of perRun.values()) {
    const list = runsByAgent.get(run.agent);
    if (list) list.push(run); else runsByAgent.set(run.agent, [run]);
  }
  for (const list of runsByAgent.values()) list.sort((a, b) => a.at - b.at);

  for (const s of by.values()) {
    const runs = s.runs.total;
    s.autonomy = s.actions.governed > 0 ? clamp01((s.actions.governed - s.actions.humanGated) / s.actions.governed) : 1;
    s.denialRate = runs > 0 ? clamp01(s.deniedRuns / runs) : 0;
    s.volumeConfidence = runs > 0 ? runs / (runs + CONFIDENCE_K) : 0;
    const decided = s.outcomes.success + s.outcomes.failure;
    s.successRate = decided > 0 ? s.outcomes.success / decided : null;
    s.maturity = clamp01(s.autonomy * (1 - s.denialRate) * s.volumeConfidence);
    s.confidence = runs === 0 ? 'none' : runs < 10 ? 'low' : runs < 40 ? 'medium' : 'high';
    s.velocity = computeVelocity(runsByAgent.get(s.agentId) ?? []);
  }

  return [...by.values()].sort((a, b) => b.maturity - a.maturity || b.runs.total - a.runs.total);
}

/** Convenience: stats for one agent (blank row when it has no history). */
export function computeAgentStat(db: Db, agentId: string): AgentStats {
  return computeAgentStats(db, [agentId]).find((s) => s.agentId === agentId) ?? blank(agentId);
}
