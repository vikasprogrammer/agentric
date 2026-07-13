/**
 * Proactive **insight alerts** — the intelligence layer coming to the owner instead of waiting to be
 * looked at. On the hourly tick it re-derives the scorecard / friction / measurement and, when something
 * genuinely warrants a human's attention, pushes an **Inbox card** (+ out-of-band DM) to the admins.
 *
 * Deliberately quiet: each alert has a stable `key` and a **cooldown** (a prior `insights.alert` audit for
 * that key within `COOLDOWN_MS` suppresses a repeat), so a persistent condition pings once, not every hour.
 * Thresholds are conservative — this is "something's wrong, go look", not a firehose. Pure detection here;
 * the tick posts the card + DMs. See src/edge/insights.ts, docs/inbox-plan.md.
 */
import type { AgentOS } from '../kernel';
import { buildInsights } from './insights';
import { measureLearning } from './measurement';

const COOLDOWN_MS = 3 * 24 * 3_600_000; // don't re-alert the same key within 3 days

export interface InsightAlert { key: string; severity: 'high' | 'medium'; title: string; body: string }

/** Detect the conditions worth a human's attention right now (pure — no dedup, no side effects). */
export function detectAlerts(os: AgentOS, now = Date.now()): InsightAlert[] {
  const ins = buildInsights(os, now);
  const m = measureLearning(os, now);
  const out: InsightAlert[] = [];

  // Fleet success rate fell sharply week-over-week (enough runs to be real).
  if (m.deltaPp != null && m.deltaPp <= -15 && m.recent.n >= 10) {
    out.push({
      key: 'success-drop',
      severity: 'high',
      title: `Fleet success rate dropped ${Math.abs(m.deltaPp)} points`,
      body: `Success fell to ${m.recent.rate}% this week (${m.recent.n} runs) from ${m.prior.rate}% the week before. Check the Insights page for which agents regressed.`,
    });
  }

  // An individual agent is failing badly.
  for (const a of ins.agents) {
    // Struggling = genuinely FAILING its work. Rate is over work runs (chat excluded upstream); require
    // real failures so a chat-heavy or crash-heavy agent doesn't trip a false "struggling" alarm.
    if (a.rate != null && a.rate <= 30 && a.runs >= 4 && a.failed >= 2) {
      out.push({
        key: `agent-low:${a.agent}`,
        severity: 'high',
        title: `${a.agent} is failing (${a.rate}% success)`,
        body: `${a.agent} succeeded on only ${a.rate}% of ${a.runs} work runs in the last ${ins.windowDays} days (${a.failed} failed). Open Insights and "Diagnose" it to see the root cause.`,
      });
    }
    // Crashing = the process/pane keeps dying (infra: too heavy / OOM / timeout) — a different fix than
    // "the agent does bad work". Kept distinct so it doesn't read as poor agent quality.
    else if (a.crashed >= 3) {
      out.push({
        key: `agent-crash:${a.agent}`,
        severity: 'high',
        title: `${a.agent}'s runs keep crashing`,
        body: `${a.crashed} of ${a.agent}'s runs crashed in the last ${ins.windowDays} days — the process died mid-run (usually too-heavy work, OOM, or a timeout), not a task failure. Scope its tasks smaller, or give it more headroom.`,
      });
    }
  }

  // A capability keeps getting rejected at approval — decide once.
  for (const r of ins.friction.rejections) {
    if (r.count >= 5) {
      out.push({
        key: `friction:${r.capability}`,
        severity: 'medium',
        title: `"${r.capability}" keeps getting rejected`,
        body: `${r.count} approvals for \`${r.capability}\` were rejected. If it should never run, deny it outright in Policy; if it's fine, auto-allow it — either way agents stop wasting runs asking.`,
      });
    }
  }

  // Approvals piling up on a human.
  const oldestH = ins.friction.oldestPendingAgeMs ? Math.round(ins.friction.oldestPendingAgeMs / 3_600_000) : 0;
  if (ins.friction.pendingApprovals >= 3 && oldestH >= 4) {
    out.push({
      key: 'pending-approvals',
      severity: 'medium',
      title: `${ins.friction.pendingApprovals} approvals waiting on a human`,
      body: `${ins.friction.pendingApprovals} approvals are pending (oldest ${oldestH}h). Agents are blocked until someone resolves them — see the Inbox.`,
    });
  }

  return out;
}

/** Detected alerts minus any whose key fired within the cooldown — the ones to actually push now. */
export function pendingAlerts(os: AgentOS, now = Date.now()): InsightAlert[] {
  return detectAlerts(os, now).filter((a) => {
    const last = os.db
      .prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'insights.alert' AND data LIKE ?")
      .get<{ t: number | null }>(`%"key":"${a.key}"%`);
    return !last?.t || now - last.t >= COOLDOWN_MS;
  });
}
