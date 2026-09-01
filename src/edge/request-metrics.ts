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
  /** Event-loop lag sampled on a fixed interval, independent of any request. */
  loop: { samples: number; maxMs: number; p95Ms: number; overOneSecond: number };
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
    this.since = Date.now();
  }
}

/** One process-wide collector — the metrics are about the PROCESS (its event loop), not one tenant. */
export const requestMetrics = new RequestMetrics();
