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
import { buildInsights, RECENT_DAYS } from './insights';
import { deriveRunOutcomes } from './outcome';

const COOLDOWN_MS = 3 * 24 * 3_600_000; // don't re-alert the same key within 3 days
/** Clean work runs since the last crash that count as "recovered" — enough to not be a lucky single pass,
 *  small enough that a genuinely flaky agent (crash, pass, crash) never reaches it and keeps alerting. */
const RECOVERED_RUNS = 3;

export interface InsightAlert {
  key: string;
  severity: 'high' | 'medium';
  title: string;
  body: string;
  /** Where the card's action should take the human — an in-app route (+ optional sub-detail) rather than
   *  a session. Insight cards back NO session, so without this the console links "Open" to a phantom
   *  `insight:<key>` session id → a dead terminal. */
  route: string;
  detail?: string;
}

/** Detect the conditions worth a human's attention right now (pure — no dedup, no side effects). */
export function detectAlerts(os: AgentOS, now = Date.now()): InsightAlert[] {
  const ins = buildInsights(os, now);
  const out: InsightAlert[] = [];

  // ⛔ RETIRED (2026-08-08, docs/insights-revisit.md Step 0) — the `success-drop` alert. It was the fourth
  // and loudest broadcast of the same broken metric: `measureLearning` counts a run as successful only if it
  // self-reported `outcome: success`, so a week where more runs simply exited without calling `report` reads
  // as a "fleet success rate dropped N points" DM to a human. It fired twice on northwind, where agents have
  // reported failure exactly once in their entire history. Unlike `agent-low` below — which requires
  // `a.failed >= 2`, i.e. real reported failures — this one had no failure evidence at all behind it.
  // Restore it in Step 4, over an outcome derived from observable facts. (Dropping it also drops the
  // `measureLearning` call this tick made — a multi-query scan over 8 weeks of audit, run for one alert.)

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
        route: 'insights',
      });
    }
    // Crashing = the process/pane keeps dying (infra: too heavy / OOM / timeout) — a different fix than
    // "the agent does bad work". Kept distinct so it doesn't read as poor agent quality.
    //
    // Read the RECENT crash count, not the 30d total, and stand down once the agent has recovered. A crash
    // count over a fixed window only ever goes up: once a crash loop is FIXED, the 30d total stays over the
    // threshold for the rest of the window, so the alert re-fires every cooldown for weeks about a problem
    // that no longer exists — and the body's "scope its tasks smaller" sends the human to re-tune a healthy
    // agent. (Real case: the consolidator's tmux-overflow crash loop was fixed after 9 crashes and then ran
    // 12/12 green; the alert fired 3 more times across the next 10 days.) `agent-low` above needs no such
    // guard — it's a RATE, so incoming successes dilute it and it self-heals.
    else if (a.crashedRecent >= 3 && a.runsSinceCrash < RECOVERED_RUNS) {
      out.push({
        key: `agent-crash:${a.agent}`,
        severity: 'high',
        title: `${a.agent}'s runs keep crashing`,
        body: `${a.crashedRecent} of ${a.agent}'s runs crashed in the last ${RECENT_DAYS} days — the process died mid-run (usually too-heavy work, OOM, or a timeout), not a task failure. Scope its tasks smaller, or give it more headroom.`,
        route: 'insights',
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
        route: 'settings',
        detail: 'policy',
      });
    }
  }

  // Runs the RUNTIME killed — quota exhausted or a dead token — rather than work that failed.
  for (const d of runtimeDeaths(os, now)) out.push(d);

  // Scheduled work is not running at all, right now.
  const blocked = schedulerBlocked(os, now);
  if (blocked) out.push(blocked);

  // Approvals piling up on a human.
  const oldestH = ins.friction.oldestPendingAgeMs ? Math.round(ins.friction.oldestPendingAgeMs / 3_600_000) : 0;
  if (ins.friction.pendingApprovals >= 3 && oldestH >= 4) {
    out.push({
      key: 'pending-approvals',
      severity: 'medium',
      title: `${ins.friction.pendingApprovals} approvals waiting on a human`,
      body: `${ins.friction.pendingApprovals} approvals are pending (oldest ${oldestH}h). Agents are blocked until someone resolves them — see the Inbox.`,
      route: 'inbox',
    });
  }

  return out;
}

/** How far back a death still counts as "happening". Deaths arrive in BURSTS — on the live corpus 22 of
 *  31 landed inside two days — so a 30-day window would keep shouting for a month about a token someone
 *  replaced on day three. */
/** The scheduler defers a spawn every tick it is over the cap, so "blocked" is a RATE, not a count. These
 *  bound the claim to the present: deferring in the last few minutes, for at least an hour, having fired
 *  nothing in that hour. */
const SCHED_FRESH_MS = 5 * 60_000;
const SCHED_BLOCKED_MS = 60 * 60_000;
const DEATH_WINDOW_MS = 48 * 3_600_000;
/** …and at least one must be this recent, or the condition is over. */
const DEATH_FRESH_MS = 12 * 3_600_000;
/** Below this it's noise: one expired token mid-run is normal and the pool already rotates around it. */
const DEATH_MIN = 3;

/**
 * **Runs the runtime killed** — the fleet's most common real failure and, until the derived outcome
 * existed, an invisible one: the agent cannot report "I hit my quota" because the agent is what stopped
 * existing, so these runs looked like silent successes.
 *
 * Grouped by the **runtime account** rather than by agent, because that is what a human acts on. The
 * per-agent view is misleading here: on the live corpus the top "offender" was simply the automation that
 * runs every two hours, while 23 of 31 deaths traced to one shared account.
 *
 * Present-tense by construction (the standing lesson from `alert-staleness-test.cjs`): a burst two weeks
 * ago is over, and a `died-early`/`runtime-death` count over a long window would keep re-firing about it.
 */
function runtimeDeaths(os: AgentOS, now: number): InsightAlert[] {
  const runs = deriveRunOutcomes(os, { since: now - DEATH_WINDOW_MS, until: now })
    .filter((r) => r.basis === 'runtime-death' || r.basis === 'died-early');
  if (!runs.length) return [];

  const rows = os.db
    .prepare(`SELECT id, runtime_account FROM term_sessions WHERE id IN (${runs.map(() => '?').join(',')})`)
    .all<{ id: string; runtime_account: string | null }>(...runs.map((r) => r.runId));
  const acctOf = new Map(rows.map((r) => [r.id, r.runtime_account]));

  const groups = new Map<string, { n: number; last: number; agents: Set<string> }>();
  for (const r of runs) {
    // No pool account → the box's own credentials. Still worth saying: it is the same outage, and the
    // fix ("add accounts so the fleet can rotate") is different from "replace this one".
    const key = acctOf.get(r.runId) ?? '(box default)';
    const g = groups.get(key) ?? { n: 0, last: 0, agents: new Set<string>() };
    g.n++; g.last = Math.max(g.last, r.at); g.agents.add(r.agent);
    groups.set(key, g);
  }

  const out: InsightAlert[] = [];
  for (const [account, g] of groups) {
    if (g.n < DEATH_MIN || now - g.last > DEATH_FRESH_MS) continue;
    const pool = account !== '(box default)';
    const who = [...g.agents].slice(0, 4).join(', ') + (g.agents.size > 4 ? `, +${g.agents.size - 4} more` : '');
    out.push({
      key: `runtime-deaths:${account}`,
      severity: 'high',
      title: `${g.n} runs killed by ${pool ? `the “${account}” account` : 'the box credentials'} in 48h`,
      body:
        `${g.n} unattended runs were killed by the runtime — a usage limit or an expired token — not by the work failing. ` +
        `Affected: ${who}. These runs did nothing and reported nothing, so they look like silence rather than failure.\n\n` +
        (pool
          ? `The pool parks a limited account automatically and drops one whose token is dead, so this clears itself IF another account can take the load. ${g.n} deaths in 48h means it could not — re-link “${account}” or add another account so the fleet can rotate.`
          : `There is no rotation pool on this box, so every agent shares one set of credentials and they all stop together. Adding a second runtime account is the fix.`),
      route: 'settings',
      detail: 'runtime',
    });
  }
  return out;
}

/**
 * **Nothing scheduled is running.** The whole-box concurrency cap defers a spawn whenever the box is at
 * its ceiling, which is correct as backpressure and catastrophic as a steady state: the deferral is
 * recorded to audit and nowhere else, so a tenant can lose every cron — reviews, health sweeps, billing
 * jobs — and the only trace is a row nobody reads.
 *
 * That is not hypothetical. One tenant deferred continuously for **a month**: 31,570 `scheduler.deferred`
 * events, not one automation fired, discovered only because someone went looking for an unrelated bug.
 * The condition was trivially detectable the whole time. This makes it arrive instead.
 *
 * Present-tense by construction (the standing lesson from `alert-staleness-test.cjs`): it fires only if
 * the scheduler is deferring **now** (within `SCHED_FRESH_MS`), has been for at least `SCHED_BLOCKED_MS`,
 * and has fired **nothing** in that window. Recovery silences it with no bookkeeping — one successful
 * fire, or one tick that isn't over the cap, and the condition is simply false. So the honest question
 * "what makes this alert stop?" has a real answer: the scheduler running again.
 */
function schedulerBlocked(os: AgentOS, now: number): InsightAlert | null {
  const since = now - SCHED_BLOCKED_MS;
  const latest = os.db
    .prepare("SELECT ts, data FROM audit_events WHERE type = 'scheduler.deferred' ORDER BY ts DESC LIMIT 1")
    .get<{ ts: number; data: string }>();
  if (!latest || now - latest.ts > SCHED_FRESH_MS) return null; // not deferring right now

  const oldest = os.db
    .prepare("SELECT MIN(ts) AS t FROM audit_events WHERE type = 'scheduler.deferred' AND ts >= ?")
    .get<{ t: number | null }>(since);
  if (!oldest?.t || latest.ts - oldest.t < SCHED_BLOCKED_MS * 0.9) return null; // a brief burst, not a stall

  // If anything actually fired in the window the scheduler is coping, however loaded it looks.
  const fired = os.db
    .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE type = 'automation.fired' AND ts >= ?")
    .get<{ c: number }>(since)!.c;
  if (fired > 0) return null;

  let cap = 0, running = 0, deferred = 0;
  try {
    const d = JSON.parse(latest.data) as { cap?: number; running?: number; deferred?: number };
    cap = d.cap ?? 0; running = d.running ?? 0; deferred = d.deferred ?? 0;
  } catch { /* shape drift must not cost us the alert */ }

  const hours = Math.round((now - oldest.t) / 3_600_000);
  return {
    key: 'scheduler-blocked',
    severity: 'high',
    title: `No scheduled work has run for ${hours}h — the box is at its session cap`,
    body:
      `Every cron, one-shot and auto-dispatched task has been deferred for ${hours}h: ${running} sessions are ` +
      `open against a cap of ${cap}, and ${deferred} automations are waiting each tick. Nothing has fired in ` +
      `that time, so daily reviews, health sweeps and scheduled reports have simply not happened — silently, ` +
      `because a deferral is not a failure and nothing errored.\n\n` +
      `The usual cause is not real load: interactive sessions stay open until someone closes them, and ` +
      `abandoned ones keep their slot. Open Sessions, sort by last activity, and close the ones nobody is ` +
      `using. Raising the cap in Settings → Concurrency also clears it, but if the slots are held by parked ` +
      `sessions rather than work, it will fill up again.`,
    route: 'sessions',
  };
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
