/**
 * The **measurement loop** — "is it working?", answered honestly.
 *
 * Rewritten in Step 4 of `docs/insights-revisit.md`. Both halves of the original were broken in the same
 * way, and the audit that opened this rebuild named them:
 *
 *  - the **trend** counted a run as successful only if it self-reported `outcome: success`, so it moved
 *    when reporting discipline moved. Step 0 deleted every channel that broadcast that number; this now
 *    reads the **derived outcome** (`./outcome`), and carries the unknown share beside the rate so a
 *    reader can always tell "the work got worse" from "we stopped being able to tell".
 *  - the **interventions** were `recommendation.applied` audit events — of which the entire fleet had
 *    produced **one**, ever. It measured our own Apply clicks rather than anything about the world.
 *
 * What replaces it is the question the rebuild is actually built around: **a card was raised — did a
 * human do anything, and did the problem stop?** That admits the answer we most need to hear, `no-action`:
 * a card nobody acted on is a failed card, and no amount of rate arithmetic will say so.
 *
 * Correlational, not a controlled test. Sample sizes and window lengths ride along, and a verdict is
 * withheld when there hasn't been enough time. Pure over the DB; no writes.
 */
import type { AgentOS } from '../kernel';

import { deriveRunOutcomes, foldConversations, summarize } from './outcome';

const DAY = 24 * 3_600_000;
const TREND_WEEKS = 8;

/** A card needs at least this long after the action before its effect is worth judging. */
const SETTLE_MS = 2 * DAY;
/** How far back a card's "before" window reaches — matched to the card's own detection window. */
const BEFORE_MS = 2 * DAY;
/** Cards older than this aren't worth re-measuring; the page is about the recent past. */
const CARD_LOOKBACK_MS = 30 * DAY;

export interface TrendBucket {
  start: number;
  label: string;
  total: number;
  success: number;
  rate: number | null;
  /** Share of that week we couldn't decide. A rate without this is the old mistake. */
  unknownShare: number | null;
}

/**
 * One raised card, and what happened next. Deliberately counts **events**, not rates: "12 runs died, then
 * you replaced the account, then 0 died" is the claim a human can check, and a rate would hide it behind
 * a denominator that also moved.
 */
export interface CardEffect {
  key: string;
  title: string;
  postedAt: number;
  /** The first plausibly-remediating action after the card, if any. */
  actedAt: number | null;
  action: string | null;
  /** Occurrences of the signal in the window before the card, and since the action (or since the card). */
  before: number;
  after: number;
  afterDays: number;
  verdict: 'resolved' | 'ongoing' | 'no-action' | 'too-early';
}

export interface Measurement {
  trend: TrendBucket[];
  cards: CardEffect[];
  recent: { n: number; rate: number | null; unknownShare: number | null };  // last 7d
  prior: { n: number; rate: number | null; unknownShare: number | null };   // prior 7d (8–14d ago)
  deltaPp: number | null;
}

/** Derived-outcome summary for a window. One place, so trend / recent / prior can never diverge. */
function windowSummary(os: AgentOS, from: number, to: number) {
  const s = summarize(foldConversations(deriveRunOutcomes(os, { since: from, until: to })));
  return { n: s.scorable, rate: s.successRate, unknownShare: s.unknownShare, success: s.success };
}

/**
 * Which audit events count as *acting on* a card. Keyed by the card's prefix, because the answer is
 * signal-specific: replacing a runtime account is a real response to a wave of runtime deaths, and
 * nothing else in the audit log is.
 *
 * Only signals we can actually count appear here. A card whose recurrence we cannot measure is left out
 * entirely rather than shown with a made-up verdict — the whole point of Step 4 is to stop reporting
 * numbers the data doesn't support.
 */
const ACTIONS: { prefix: string; types: string[] }[] = [
  {
    prefix: 'runtime-deaths:',
    types: ['runtime.account.added', 'runtime.account.updated', 'runtime.account.removed', 'runtime.account.checked', 'runtime.login.completed'],
  },
];

/** Occurrences of a card's underlying signal in `[from, to)`. */
function signalCount(os: AgentOS, key: string, from: number, to: number): number {
  if (key.startsWith('runtime-deaths:')) {
    const account = key.slice('runtime-deaths:'.length);
    const runs = deriveRunOutcomes(os, { since: from, until: to })
      .filter((r) => r.basis === 'runtime-death' || r.basis === 'died-early');
    if (!runs.length) return 0;
    const rows = os.db
      .prepare(`SELECT id, runtime_account FROM term_sessions WHERE id IN (${runs.map(() => '?').join(',')})`)
      .all<{ id: string; runtime_account: string | null }>(...runs.map((r) => r.runId));
    const acctOf = new Map(rows.map((r) => [r.id, r.runtime_account ?? '(box default)']));
    return runs.filter((r) => acctOf.get(r.runId) === account).length;
  }
  return 0;
}

/**
 * For each card raised recently: did anyone act, and did the signal stop? The verdicts are chosen so the
 * uncomfortable one is reachable — `no-action` is not an error state, it is the most common honest answer
 * about a notification nobody asked for.
 */
export function measureCards(os: AgentOS, now = Date.now()): CardEffect[] {
  const posted = os.db
    .prepare("SELECT ts, data FROM audit_events WHERE type = 'insights.alert' AND ts >= ? ORDER BY ts DESC")
    .all<{ ts: number; data: string }>(now - CARD_LOOKBACK_MS);

  const out: CardEffect[] = [];
  const seen = new Set<string>();
  for (const row of posted) {
    let key: string | undefined, title: string | undefined;
    try {
      const d = JSON.parse(row.data) as { key?: string; title?: string };
      key = d.key; title = d.title;
    } catch { /* malformed row */ }
    if (!key || seen.has(key)) continue;               // newest card per key only
    const spec = ACTIONS.find((a) => key!.startsWith(a.prefix));
    if (!spec) continue;                               // a signal we can't count → not shown at all
    seen.add(key);

    const act = os.db
      .prepare(`SELECT ts, type FROM audit_events WHERE ts > ? AND type IN (${spec.types.map(() => '?').join(',')}) ORDER BY ts LIMIT 1`)
      .get<{ ts: number; type: string }>(row.ts, ...spec.types);

    const before = signalCount(os, key, row.ts - BEFORE_MS, row.ts);
    // Measured from the ACTION when there was one — a signal that continued between the card and the fix
    // is not evidence the fix failed. With no action, measured from the card, which is the fair test of
    // "did telling someone help".
    const from = act?.ts ?? row.ts;
    const after = signalCount(os, key, from, now);
    const afterDays = Math.max(0, Math.round(((now - from) / DAY) * 10) / 10);

    const verdict: CardEffect['verdict'] =
      !act ? (now - row.ts < SETTLE_MS ? 'too-early' : 'no-action')
        : now - act.ts < SETTLE_MS ? 'too-early'
          : after === 0 ? 'resolved' : 'ongoing';

    out.push({
      key, title: title ?? key, postedAt: row.ts,
      actedAt: act?.ts ?? null, action: act?.type ?? null,
      before, after, afterDays, verdict,
    });
  }
  return out;
}

/** The success-rate trend + the card effects. Rendered by the Insights page as "Is it working?". */
export function measureLearning(os: AgentOS, now = Date.now()): Measurement {
  const trend: TrendBucket[] = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const start = now - (i + 1) * 7 * DAY;
    const end = now - i * 7 * DAY;
    const s = windowSummary(os, start, end);
    trend.push({
      start,
      label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      total: s.n, success: s.success, rate: s.rate, unknownShare: s.unknownShare,
    });
  }

  const recent = windowSummary(os, now - 7 * DAY, now);
  const prior = windowSummary(os, now - 14 * DAY, now - 7 * DAY);
  const deltaPp = recent.rate != null && prior.rate != null ? recent.rate - prior.rate : null;

  return {
    trend,
    cards: measureCards(os, now),
    recent: { n: recent.n, rate: recent.rate, unknownShare: recent.unknownShare },
    prior: { n: prior.n, rate: prior.rate, unknownShare: prior.unknownShare },
    deltaPp,
  };
}
