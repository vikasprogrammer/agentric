/**
 * Capability gaps — the requests nobody on the fleet could take.
 *
 * The agent router (`src/edge/router.ts`) fails safe: a confident win routes, a near-tie asks, and
 * nothing-scored returns `kind: 'none'` — at which point both front doors (Cockpit's
 * `/api/router/preview` and the Slack/Discord `/agent` chat router) hand back the full roster and the
 * miss evaporates. That is the one outcome worth keeping: a request no agent matched is the cheapest
 * possible evidence of which agent to build next.
 *
 * So every `none` is recorded as a `router.gap` audit event (the durable accumulation — queryable on
 * the Audit page, `type=router.gap`) and summarised into ONE rolling admin inbox card. Rolling, not
 * one-card-per-miss, on purpose: an unmatched request is exactly the sort of high-volume, low-urgency
 * signal that turns the Inbox into noise, so repeat misses refresh the single card in place and only
 * the FIRST gap in the window pushes a DM.
 *
 * Advisory throughout — a failure here must never break the routing response the member is waiting on.
 */
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';

/** How far back the rolling card looks. Older gaps stay in the audit trail, they just stop being "open". */
export const GAP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How many distinct recent requests the card lists. Enough to see a theme, short enough to read. */
const CARD_SAMPLE = 8;
/** Requests are recorded verbatim (they're the evidence), clipped only so one paste can't bloat a row. */
const TEXT_MAX = 400;

export interface CapabilityGap {
  text: string;
  requester: string;
  /** Which front door the request came in through. */
  source: string;
  at: number;
}

/** Recent gaps, newest first — the rolling card's input, and the shape a future console view would read. */
export function recentGaps(os: AgentOS, since = Date.now() - GAP_WINDOW_MS, limit = 200): CapabilityGap[] {
  const rows = os.db
    .prepare(`SELECT ts, principal, data FROM audit_events WHERE tenant = ? AND type = 'router.gap' AND ts >= ? ORDER BY ts DESC LIMIT ?`)
    .all<{ ts: number; principal: string | null; data: string }>(os.tenant, since, limit);
  return rows.map((r) => {
    let d: { text?: unknown; source?: unknown } = {};
    try { d = JSON.parse(r.data) as typeof d; } catch { /* a malformed row is still a gap, just untitled */ }
    return { text: String(d.text ?? ''), requester: r.principal ?? 'unknown', source: String(d.source ?? 'unknown'), at: r.ts };
  });
}

/** Distinct request texts, newest first — the same ask typed twice is one line on the card, not two. */
function distinctTexts(gaps: CapabilityGap[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of gaps) {
    const key = g.text.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(g.text.trim());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Record one unmatched request and refresh the rolling admin card.
 *
 * `requester` is the member id (or `unknown` off a chat surface with no linked member) — it's the
 * audit principal, so who keeps hitting the wall is answerable later.
 */
export function recordCapabilityGap(
  os: AgentOS,
  tm: TerminalManager,
  input: { text: string; requester: string; source: 'cockpit' | 'chat' },
): void {
  const text = input.text.trim().slice(0, TEXT_MAX);
  if (!text) return;
  try {
    os.audit.append({
      ts: Date.now(), runId: '-', tenant: os.tenant, principal: input.requester,
      type: 'router.gap', data: { text, source: input.source },
    });
  } catch { return; /* nothing recorded → nothing to summarise */ }

  try {
    const gaps = recentGaps(os);
    const samples = distinctTexts(gaps, CARD_SAMPLE);
    const body = [
      `${gaps.length} request${gaps.length === 1 ? '' : 's'} in the last 30 days matched no agent on this fleet.`,
      '',
      ...samples.map((t) => `• ${t}`),
      '',
      'Each one is a candidate for a new agent (or a wider description on an existing one). Full list: Audit → `router.gap`.',
    ].join('\n');
    const id = tm.postSystemCard({
      topic: 'capability-gap',
      type: 'notification',
      title: gaps.length === 1 ? 'A request matched no agent' : `${gaps.length} requests matched no agent`,
      body,
      audience: { kind: 'admins' },
      args: { gaps: gaps.length },
      // Only the first gap in the window is worth a push — after that the card refreshes silently.
      notify: gaps.length === 1,
      link: { page: 'agents', label: 'Agents' },
    });
    tm.closeSystemCards('capability-gap', 'cancelled', id);
  } catch { /* the audit row is the system of record; the card is a convenience */ }
}
