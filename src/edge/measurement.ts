/**
 * The **measurement loop** — the arm the four-verb model (Capture · Recall · Distil · Apply) was missing
 * (audit finding G1, the reason Pillar 10 sits at 🟡). The loop *runs*, but nothing checked whether
 * **Apply actually moved outcomes**: guidance could be useless — or harmful — and the OS would keep
 * injecting it forever.
 *
 * This computes, from REAL session outcomes:
 *  - a **success-rate trend** over recent weeks (is the fleet getting better?), and
 *  - per **intervention** (an applied recommendation), the success rate in the window BEFORE vs AFTER it,
 *    with a verdict (improved / declined / flat / insufficient).
 *
 * It is honest about being **correlational, not a controlled A/B** — sample sizes ride along so a thin
 * signal reads as thin, and a verdict is withheld below `MIN_N`. Pure over the DB; no writes. The Dreaming
 * page renders it as "Is it working?", closing the loop with a human in it.
 */
import type { AgentOS } from '../kernel';

type Db = AgentOS['db'];

const DAY = 24 * 3_600_000;
const TREND_WEEKS = 8;
const IA_WINDOW = 14 * DAY; // before/after window sized per intervention
const MIN_N = 8;            // fewer terminated sessions than this → no verdict (too little to tell)
const THRESH_PP = 5;        // ≥ this percentage-point move counts as improved/declined, else flat

export interface TrendBucket { start: number; label: string; total: number; success: number; rate: number | null }
export interface InterventionEffect {
  id: string;
  title: string;
  at: number;
  before: { n: number; rate: number | null };
  after: { n: number; rate: number | null };
  deltaPp: number | null;
  verdict: 'improved' | 'declined' | 'flat' | 'insufficient';
}
export interface Measurement {
  trend: TrendBucket[];
  interventions: InterventionEffect[];
  recent: { n: number; rate: number | null }; // last 7d
  prior: { n: number; rate: number | null };  // prior 7d (8–14d ago)
  deltaPp: number | null;
}

interface OutRow { run_id: string | null; ts: number; type: string; data: string }

// One canonical terminal row per session (same precedence as the reflect pass): the agent's reported
// outcome wins, then run.completed, ended, stopped. Prevents multi-event sessions from skewing the rate.
const RANK: Record<string, number> = { 'session.reported': 3, 'run.completed': 2, 'session.ended': 1, 'session.stopped': 0 };

/** Distinct terminated sessions in [from, to) as { ts, success } — one row per session. */
function outcomes(db: Db, from: number, to: number): { ts: number; success: boolean }[] {
  // Exclude chat-triggered sessions — they're conversational and rarely `report` a success outcome, so
  // they'd deflate the fleet success rate (matches the scorecard's chat exclusion).
  const rows = db
    .prepare("SELECT a.run_id, a.ts, a.type, a.data FROM audit_events a JOIN term_sessions s ON s.id = a.run_id WHERE a.ts >= ? AND a.ts < ? AND a.type IN ('session.reported','session.ended','session.stopped','run.completed') AND (s.spawned_by IS NULL OR s.spawned_by NOT LIKE 'chat:%') ORDER BY a.ts")
    .all<OutRow>(from, to);
  const bySession = new Map<string, OutRow>();
  for (const r of rows) {
    const key = r.run_id || `anon:${r.ts}`;
    const cur = bySession.get(key);
    if (!cur || (RANK[r.type] ?? -1) > (RANK[cur.type] ?? -1)) bySession.set(key, r);
  }
  return [...bySession.values()].map((r) => {
    let outcome = r.type === 'session.stopped' ? 'stopped' : 'unknown';
    try { outcome = String((JSON.parse(r.data) as { outcome?: unknown }).outcome ?? outcome); } catch { /* keep default */ }
    return { ts: r.ts, success: outcome === 'success' };
  });
}

function rateOf(list: { success: boolean }[]): { n: number; rate: number | null } {
  const n = list.length;
  return { n, rate: n ? Math.round((list.filter((x) => x.success).length / n) * 100) : null };
}

function recTitle(id: string | undefined): string {
  switch (id) {
    case 'runtime.effort.high': return 'Raised default effort to “high”';
    case 'policy.review': return 'Reviewed policy';
    case 'budget.review': return 'Reviewed budgets';
    default: return id ? `Applied “${id}”` : 'Applied a change';
  }
}

/** Compute the success-rate trend + per-intervention before/after effect. Pure read over the audit log. */
export function measureLearning(os: AgentOS, now = Date.now()): Measurement {
  const db = os.db;
  const all = outcomes(db, now - TREND_WEEKS * 7 * DAY, now);

  const trend: TrendBucket[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const start = now - (i + 1) * 7 * DAY;
    const end = now - i * 7 * DAY;
    const inWk = all.filter((o) => o.ts >= start && o.ts < end);
    const { n, rate } = rateOf(inWk);
    trend.push({ start, label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), total: n, success: inWk.filter((x) => x.success).length, rate });
  }

  const recent = rateOf(all.filter((o) => o.ts >= now - 7 * DAY));
  const prior = rateOf(all.filter((o) => o.ts >= now - 14 * DAY && o.ts < now - 7 * DAY));
  const deltaPp = recent.rate != null && prior.rate != null ? recent.rate - prior.rate : null;

  // Interventions = applied recommendations (the concrete, outcome-affecting changes a human made). For
  // each, the success rate BEFORE vs AFTER it — the honest "did that change help?" signal (M2/G1).
  const applied = db.prepare("SELECT ts, data FROM audit_events WHERE type = 'recommendation.applied' ORDER BY ts DESC LIMIT 10").all<{ ts: number; data: string }>();
  const interventions: InterventionEffect[] = applied.map((row) => {
    let id: string | undefined;
    try { id = String((JSON.parse(row.data) as { id?: unknown }).id ?? '') || undefined; } catch { /* ignore */ }
    const before = rateOf(outcomes(db, row.ts - IA_WINDOW, row.ts));
    const after = rateOf(outcomes(db, row.ts, Math.min(now, row.ts + IA_WINDOW)));
    const d = before.rate != null && after.rate != null ? after.rate - before.rate : null;
    const verdict: InterventionEffect['verdict'] =
      before.n < MIN_N || after.n < MIN_N || d == null ? 'insufficient'
        : d >= THRESH_PP ? 'improved' : d <= -THRESH_PP ? 'declined' : 'flat';
    return { id: id ?? 'recommendation', title: recTitle(id), at: row.ts, before, after, deltaPp: d, verdict };
  });

  return { trend, interventions, recent, prior, deltaPp };
}
