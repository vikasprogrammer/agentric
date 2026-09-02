/**
 * REQUEST METRICS — which endpoint actually costs the most, and whether it's the endpoint's fault.
 *
 * Built after an incident where "everything Agent OS does is slow" had nothing to do with the endpoint
 * being called: the 20s scheduler tick blocked the single-threaded event loop for 7.3s at a time, so a
 * `/health` that reads one string measured **9.06s**. A plain per-route latency table would have named
 * `/health` the slowest route in the system and sent the next person hunting in the wrong file.
 *
 * So this records TWO things per request and keeps them separate:
 *   - **handler** — time inside the route: its own queries, execs and awaits. This is the route's own cost.
 *   - **stall**   — event-loop lag at the moment the request arrived, sampled independently. Blame here is
 *                   shared by whatever else the process was doing, NOT by the route.
 * A route is slow because of ITSELF only when its handler time is high. High stall with low handler time
 * everywhere means look for a timer, not a route.
 *
 * Design constraints, both learned the hard way in this codebase:
 *   - **Nothing is written to SQLite.** A per-request INSERT would add a synchronous write to every request
 *     (the exact cost this module exists to find) and would grow a table forever — which is how
 *     `audit_events` reached 195 MB. Aggregates live in memory and reset on restart.
 *   - **Paths are bucketed by TEMPLATE**, not by URL. `/api/sessions/ses_abc/chain` and 5000 siblings must
 *     collapse to one row, or the table becomes the leak.
 *
 * Percentiles come from fixed buckets: constant memory, no sorting, no reservoir sampling. A bucketed p95
 * is reported as the bucket's upper bound, so it reads as "at most this", never as false precision.
 */

/** Upper bounds in ms. The last bucket is everything above the previous bound. */
const BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, Infinity];

/** How many distinct route templates to track before lumping the rest into `other`. */
const MAX_ROUTES = 300;

/** Lag at or above which a tick is recorded as a STALL (with its phase) rather than just binned. */
const STALL_MS = 1_000;
/** How many stalls to keep. Small on purpose: this is a lead, not a log. */
const STALL_RING = 20;
/** Closed phases kept for attribution — a stall that ends just before the tick still has a suspect. */
const RECENT_PHASES = 32;

/** Tools whose duration is a WAIT on something outside this process — a human, a delegate, or a spawned
 *  model — not work this process is doing. They are measured like everything else (hiding them would hide
 *  a wait that never ends) but flagged, so the table is never read as "`ask_human` is the slowest endpoint
 *  in the system".
 *
 *  `session_open:summary` is its own entry rather than the whole tool: with `summary` it spawns a
 *  throwaway `claude -p` (17.9 s on a live tenant), without it it is one indexed row-test. Flagging the
 *  tool outright would hide a real regression on the cheap path; the split label (see memory-mcp.ts)
 *  keeps both honest. */
const BLOCKING_TOOLS = new Set(['ask', 'ask_human', 'ask_agent', 'task_wait', 'session_open:summary']);

export interface RouteStat {
  /** `GET /api/sessions/:id` — method + normalized path template. */
  route: string;
  count: number;
  /** Summed handler time (ms). The honest answer to "which endpoint costs the most". */
  totalMs: number;
  /** Mean handler time (ms). */
  avgMs: number;
  /** Bucketed p50/p95 upper bounds (ms). */
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Worst event-loop lag observed on arrival of a request to this route (ms) — NOT this route's fault. */
  maxStallMs: number;
  /** Non-2xx/3xx responses. A fast route that mostly 500s is not a fast route. */
  errors: number;
}

export interface ToolStat extends RouteStat {
  /** The tool BLOCKS by design (`ask_human`, `task_wait`, …): its clock is a human/delegate, not code.
   *  Reported so a 40-minute `ask_human` is never read as a slow endpoint. */
  blocking: boolean;
}

/**
 * One event-loop stall, with the WORK that was in flight when it happened.
 *
 * The lag number alone ends the investigation at "something blocked the loop for 156 seconds" — which is
 * exactly where a real one left us: no route recorded a handler that long (so it wasn't a request), the
 * audit stream had no burst, the WAL was small, the disk idle, and nothing was in the journal. A number
 * with no subject is not a lead. So every long-running SYNCHRONOUS phase in the process now names itself
 * ({@link RequestMetrics.phase}), and a stall is attributed to whichever phase was open across it.
 */
export interface StallRecord {
  /** ms epoch when the blocked interval began (the tick that observed it, minus the lag). */
  at: number;
  /** How long the loop was blocked (ms). */
  ms: number;
  /** The phase open across the stall — `route:GET /api/sessions`, `upkeep:dreaming`, … or `unattributed`
   *  when nothing declared itself (which is itself a finding: the blocker is code with no marker). */
  phase: string;
}

export interface RequestMetricsSnapshot {
  /** When collection started (ms epoch) — every total is "since here". */
  since: number;
  requests: number;
  /** Routes ordered by the metric that answers the question: total time spent. */
  routes: RouteStat[];
  /** The same measurement keyed by the MCP TOOL an agent called, when the caller named one
   *  (`x-aos-tool`). One tool can span several routes and one route serves several tools, so this is a
   *  separate dimension, not a re-slice of `routes`. */
  tools: ToolStat[];
  /** Event-loop lag sampled on a fixed interval, independent of any request. `stalls` is the ring of the
   *  most recent attributed blocks — the answer to "what blocked it", which `maxMs` alone never gave. */
  loop: { samples: number; maxMs: number; p95Ms: number; overOneSecond: number; stalls: StallRecord[] };
}

interface Bucketed {
  count: number;
  totalMs: number;
  maxMs: number;
  maxStallMs: number;
  errors: number;
  hist: number[];
}

function emptyBucketed(): Bucketed {
  return { count: 0, totalMs: 0, maxMs: 0, maxStallMs: 0, errors: 0, hist: new Array(BUCKETS.length).fill(0) };
}

function record(b: Bucketed, ms: number, stallMs: number, status: number): void {
  b.count++;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  if (stallMs > b.maxStallMs) b.maxStallMs = stallMs;
  if (status >= 400) b.errors++;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (ms <= BUCKETS[i]) { b.hist[i]++; return; }
  }
}

/** The bucket bound at or above the `q` quantile. Reads as "at most this much". */
function quantile(hist: number[], count: number, q: number): number {
  if (!count) return 0;
  const target = q * count;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) return BUCKETS[i] === Infinity ? BUCKETS[i - 1] : BUCKETS[i];
  }
  return BUCKETS[BUCKETS.length - 2];
}

/**
 * Collapse a concrete path to a route TEMPLATE.
 *
 * Ids in this system are recognisable by shape (`ses_…`, `tsk_…`, `mem_…`, a hex/uuid blob, a pure number),
 * so we substitute those segments rather than maintaining a list of every route pattern — a list would
 * silently stop bucketing the moment someone adds an endpoint. Unknown-but-id-shaped wins over precision:
 * over-collapsing costs a little detail, under-collapsing unbounds the table.
 */
export function normalizePath(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean);
  const out = segs.map((s) => {
    if (/^[a-z]{2,12}_[A-Za-z0-9]{6,}$/.test(s)) return ':id';        // ses_… tsk_… msk_… (our id shape)
    if (/^\d+$/.test(s)) return ':n';                                  // numeric ids
    if (/^[0-9a-f]{8,}$/i.test(s)) return ':hex';                      // hashes, tokens, uuid chunks
    if (/^[0-9a-f-]{32,}$/i.test(s)) return ':uuid';
    return s;
  });
  return '/' + out.join('/');
}

/**
 * Event-loop lag monitor: a fixed-interval timer that reports how LATE it fired. A 20ms timer that fires
 * 7s late means the loop was blocked for ~7s — the measurement that separates "this route is slow" from
 * "this process was busy". Deliberately independent of request traffic, so an idle-but-blocked server
 * still shows the truth.
 */
export class RequestMetrics {
  private since = Date.now();
  private routes = new Map<string, Bucketed>();
  private tools = new Map<string, Bucketed>();
  private other = emptyBucketed();
  private total = 0;
  private loopSamples = 0;
  private loopMax = 0;
  private loopOverSecond = 0;
  private loopHist = new Array(BUCKETS.length).fill(0);
  /** Phases currently open, outermost first. A blocking phase is SYNCHRONOUS, so at most one is open
   *  when the loop is blocked — the stack exists so a nested marker can't orphan its parent. */
  private openPhases: Array<{ label: string; at: number; seq: number }> = [];
  /** Monotonic begin counter — the tie-break for "innermost" when two phases share a millisecond. */
  private phaseSeq = 0;
  /** Recently CLOSED phases, newest last — a stall that ended microseconds before the tick that saw it. */
  private closedPhases: Array<{ label: string; at: number; end: number; seq: number }> = [];
  private stalls: StallRecord[] = [];
  private stallSink?: (s: StallRecord) => void;
  /** Lag of the most recent loop sample — what a request arriving now was plausibly delayed by. */
  private lastLag = 0;
  private timer?: NodeJS.Timeout;

  /** Start the loop-lag sampler. `intervalMs` is the expected firing period; lag = actual − expected. */
  start(intervalMs = 200): void {
    this.stop();
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - last - intervalMs);
      last = now;
      this.lastLag = lag;
      this.loopSamples++;
      if (lag > this.loopMax) this.loopMax = lag;
      if (lag >= 1_000) this.loopOverSecond++;
      if (lag >= STALL_MS) this.recordStall(now - lag, lag);
      for (let i = 0; i < BUCKETS.length; i++) {
        if (lag <= BUCKETS[i]) { this.loopHist[i]++; break; }
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Mark a synchronous phase so a stall inside it has a NAME. Returns the closer; call it in a `finally`
   * (or use {@link phase}). Cheap by construction — two array writes, no timers, no allocation per tick —
   * because it wraps things that run on every request.
   */
  beginPhase(label: string): () => void {
    const entry = { label, at: Date.now(), seq: ++this.phaseSeq };
    this.openPhases.push(entry);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const i = this.openPhases.lastIndexOf(entry);
      if (i >= 0) this.openPhases.splice(i, 1);
      this.closedPhases.push({ label: entry.label, at: entry.at, end: Date.now(), seq: entry.seq });
      if (this.closedPhases.length > RECENT_PHASES) this.closedPhases.shift();
    };
  }

  /** {@link beginPhase} around a synchronous call. */
  phase<T>(label: string, fn: () => T): T {
    const done = this.beginPhase(label);
    try { return fn(); } finally { done(); }
  }

  /** Called for every recorded stall — the server wires this to an audit event so a block that happened
   *  while nobody was looking is still on the record after a restart (the ring is memory-only). */
  onStall(sink: (s: StallRecord) => void): void {
    this.stallSink = sink;
  }

  /**
   * Attribute a blocked interval to the phase that spanned it. The INNERMOST open phase wins, not the
   * outermost: phases nest by containment (a request is open while it awaits, and a timer that fires
   * during that await opens INSIDE it), so the newest one is the code actually holding the loop — and
   * for genuinely nested synchronous work it is also the more specific answer. Failing an open phase,
   * the most recent one that overlapped the interval (the common case: the blocking call returns, then
   * the tick fires). Failing both, nothing declared itself — which narrows the hunt to unmarked code.
   */
  private recordStall(at: number, ms: number): void {
    const end = at + ms;
    // Candidates: every phase that was open at any point inside the blocked interval — still open, or
    // closed during it (the common case, since the blocking call returns before the tick that sees it).
    let best: { label: string; seq: number } | undefined;
    const consider = (p: { label: string; at: number; end?: number; seq: number }) => {
      if (p.at > end) return;                        // began after the block ended
      if (p.end !== undefined && p.end < at) return; // ended before it began
      // Innermost = begun LAST. `seq` rather than `at`, because two nested phases routinely share a
      // millisecond and a timestamp comparison would then pick by iteration order — i.e. at random.
      if (!best || p.seq > best.seq) best = { label: p.label, seq: p.seq };
    };
    for (const p of this.openPhases) consider(p);
    for (const p of this.closedPhases) consider(p);
    const rec: StallRecord = { at, ms: Math.round(ms), phase: best?.label ?? 'unattributed' };
    this.stalls.push(rec);
    if (this.stalls.length > STALL_RING) this.stalls.shift();
    try { this.stallSink?.(rec); } catch { /* a sink must never break the sampler */ }
  }

  /** Lag observed by the most recent sampler tick — attach it to a request as CONTEXT, never as its cost. */
  currentStallMs(): number {
    return this.lastLag;
  }

  /** Record one finished request. `ms` is handler time; `stallMs` is loop lag when it arrived. */
  observe(method: string, pathname: string, status: number, ms: number, stallMs: number): void {
    this.total++;
    const key = `${method} ${normalizePath(pathname)}`;
    let b = this.routes.get(key);
    if (!b) {
      // Past the ceiling, everything new lands in `other` rather than growing the map without bound.
      if (this.routes.size >= MAX_ROUTES) { record(this.other, ms, stallMs, status); return; }
      b = emptyBucketed();
      this.routes.set(key, b);
    }
    record(b, ms, stallMs, status);
  }

  /**
   * Record one finished MCP tool call. The agent-facing tools are the surface an AGENT waits on, and a
   * tool is not the same unit as a route (`recall` is one route; `skill_find` fans out to a second
   * service), so they get their own map rather than a slice of `routes`. Same cost model: `ms` is
   * handler time, `stallMs` is context.
   */
  observeTool(tool: string, status: number, ms: number, stallMs: number): void {
    const key = tool.slice(0, 64);
    let b = this.tools.get(key);
    if (!b) {
      if (this.tools.size >= MAX_ROUTES) return; // a forged header can't grow the map without bound
      b = emptyBucketed();
      this.tools.set(key, b);
    }
    record(b, ms, stallMs, status);
  }

  /** Ordered by total time spent — a 20ms route called 10k times outranks a 2s route called once. */
  snapshot(limit = 40): RequestMetricsSnapshot {
    const rows: RouteStat[] = [];
    const push = (route: string, b: Bucketed) => {
      if (!b.count) return;
      rows.push({
        route,
        count: b.count,
        totalMs: Math.round(b.totalMs),
        avgMs: Math.round((b.totalMs / b.count) * 100) / 100,
        p50Ms: quantile(b.hist, b.count, 0.5),
        p95Ms: quantile(b.hist, b.count, 0.95),
        maxMs: Math.round(b.maxMs),
        maxStallMs: Math.round(b.maxStallMs),
        errors: b.errors,
      });
    };
    for (const [route, b] of this.routes) push(route, b);
    push('other (over route cap)', this.other);
    rows.sort((a, z) => z.totalMs - a.totalMs);
    const tools: ToolStat[] = [];
    for (const [tool, b] of this.tools) {
      const before = rows.length;
      push(tool, b);
      // `push` appends to `rows`; move it across rather than duplicating the stats math.
      if (rows.length > before) tools.push({ ...rows.pop()!, blocking: BLOCKING_TOOLS.has(tool) });
    }
    // Blocking tools last: their clock is a human, so they would otherwise head a table about code.
    tools.sort((a, z) => (Number(a.blocking) - Number(z.blocking)) || (z.totalMs - a.totalMs));
    return {
      since: this.since,
      requests: this.total,
      routes: rows.slice(0, limit),
      tools: tools.slice(0, limit),
      loop: {
        samples: this.loopSamples,
        maxMs: Math.round(this.loopMax),
        p95Ms: quantile(this.loopHist, this.loopSamples, 0.95),
        overOneSecond: this.loopOverSecond,
        stalls: [...this.stalls].sort((a, z) => z.ms - a.ms),
      },
    };
  }

  /** Clear all counters (an operator starting a fresh measurement window). */
  reset(): void {
    this.routes.clear();
    this.tools.clear();
    this.other = emptyBucketed();
    this.total = 0;
    this.loopSamples = 0;
    this.loopMax = 0;
    this.loopOverSecond = 0;
    this.loopHist = new Array(BUCKETS.length).fill(0);
    this.stalls = [];
    this.since = Date.now();
  }
}

/** One process-wide collector — the metrics are about the PROCESS (its event loop), not one tenant. */
export const requestMetrics = new RequestMetrics();
