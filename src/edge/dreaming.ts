/**
 * The self-learning ("Dreaming") layer — now COMPOUNDING.
 *
 * Each pass reflects on activity since the last pass (the per-session **episodes** agents wrote, run
 * **outcomes**, and **friction** — approvals rejected, budget stops, errors) and **folds it into a
 * cumulative state** kept in settings (`dreaming_state`). It then re-renders, from that state, a living
 * KB page (`operations/fleet-learnings`) and a tenant-shared memory Insight. So the page is not a
 * per-window snapshot — it grows: cumulative totals, a deduped table of recurring topics (counts +
 * last-seen), and a rolling log of recent passes. Because the state lives in settings, the page is a
 * pure render of it and is rebuilt even if a human deletes it.
 *
 * Deterministic + zero-cost — the always-on baseline. The richer LLM "kb-gardener" (a scheduled agent
 * that distils prose via the kb_write tool) layers on top.
 */
import type { AgentOS } from '../kernel';
import type { Recommendation } from '../types';

export interface DreamResult {
  skipped: boolean;
  window: { since: number; until: number };
  passes?: number;
  sessions?: number; // this window
  episodes?: number; // this window
  kbPageId?: string;
  insightId?: string;
  guidance?: string;
  busy?: boolean; // another pass for this tenant was already running (M1) — this call no-opped
}

interface Tally { sessions: number; episodes: number; success: number; failure: number; partial: number; stopped: number; unknown: number; approved: number; rejected: number; budgetStops: number; errors: number }
interface RecentEntry { day: string; ts: number; sessions: number; success: number; failure: number; stopped: number; approved?: number; rejected: number; budgetStops: number; errors: number; topics: string[] }
interface DreamState {
  firstPass: number;
  passes: number;
  totals: Tally;
  topics: Record<string, { count: number; lastSeen: number }>;
  recent: RecentEntry[];
  /** High-water mark of the newest activity ts this loop has already consumed (H2). Kept SEPARATE from
   *  the run clock (`learning.dreamed` audit ts, which drives cadence) so a late-written episode can't
   *  fall into the gap between a pass's `until` and the next `since` and be silently skipped. Absent on
   *  states written before this field existed → we fall back to the old marker (see `dream`). */
  watermark?: number;
}

interface EpisodeRow { content: string; created_at: number }
interface OutcomeRow { run_id: string | null; ts: number; type: string; data: string }
interface FrictionRow { ts: number; type: string; data: string }

const DREAM_SECTION = 'operations';
const DREAM_SLUG = 'fleet-learnings';
const MAX_RECENT = 12;
const TOP_TOPICS = 15;
// Staleness controls (H4/M6/L2). Behavioral guidance + recommendations derive from a RECENT window (the
// last N per-pass tallies), NOT lifetime `totals` — so a friction signal that has since subsided stops
// nagging every agent's prompt. Topics decay by recency and are pruned so the stored map can't grow
// without bound and stale topics can't dominate "the fleet frequently works on …".
const RECENT_PASSES = 7;                       // window for guidance/recommendation signals
const TOPIC_HALFLIFE_MS = 21 * 24 * 3_600_000; // a topic's weight halves every 3 weeks since last seen (recency-favouring, so current work outranks an old burst)
const TOPIC_MAX_AGE_MS = 90 * 24 * 3_600_000;  // drop a topic entirely if unseen this long
const TOPIC_CAP = 300;                          // hard cap on stored topic keys (keep the top by recency-weight)
// A word only counts as something "the fleet frequently works on" once it has recurred across at least
// this many distinct episodes (topicCounts counts once per episode, so `count` = distinct-episode hits).
// Stops a one-off word — or a handful of near-identical test runs — from headlining the guidance line.
const MIN_TOPIC_COUNT = 3;
const STOP = new Set(['task', 'outcome', 'session', 'after', 'then', 'with', 'this', 'that', 'from', 'into', 'your', 'their', 'about', 'over', 'when', 'while', 'should', 'would', 'could', 'have', 'been', 'were', 'them', 'they', 'will', 'just', 'also', 'using', 'used', 'ran', 'run', 'done', 'made', 'make', 'need', 'needs', 'some', 'more', 'than', 'only', 'each', 'both', 'unknown', 'none',
  // Procedural / plumbing words — they describe HOW an agent worked, not WHAT the fleet works on, so they
  // drown the real topics ("slack, check, report, completed, summary" is a useless "frequently works on").
  'claude', 'publish', 'recall', 'remember', 'notify', 'slack', 'discord', 'chat', 'check', 'checked', 'report', 'reported', 'completed', 'complete', 'summary', 'daily', 'sent', 'posted', 'update', 'updated', 'dashboard', 'message', 'notified', 'agent', 'agents', 'human', 'review', 'reviewed', 'ended', 'started', 'verified', 'read',
  // Conversational filler from natural-language task prompts — a Task line is a human sentence ("lets check
  // the latest emails …"), so instruction/filler words outrank the real noun. Fleet data showed "working,
  // recent, lets, latest" topping "frequently works on"; drop them so the actual subject surfaces.
  'lets', 'please', 'want', 'wants', 'wanted', 'like', 'would', 'give', 'tell', 'know', 'here', 'there', 'what', 'which', 'where', 'whether', 'still', 'back', 'next', 'first', 'last', 'good', 'great', 'thing', 'things', 'stuff', 'working', 'work', 'going', 'getting', 'recent', 'recently', 'latest', 'today', 'yesterday', 'tomorrow', 'current', 'currently', 'again', 'once', 'above', 'below', 'help', 'lets', 'able', 'sure', 'okay', 'yeah', 'issue', 'issues', 'problem', 'problems', 'thanks', 'quick', 'quickly',
  // Imperative scaffolding from step-by-step test/QA prompts ("Test the … tools end-to-end, then STOP. Do
  // ONLY these steps … EXACTLY") — describes how a run was scripted, not a subject the fleet works on.
  'stop', 'exactly', 'step', 'steps', 'only', 'test', 'tests', 'tool', 'tools', 'end', 'ping', 'pls', 'else', 'anything', 'everything', 'something', 'nothing']);

export class DreamingEngine {
  constructor(private readonly os: AgentOS) {}

  /** Team-member name tokens to exclude from topic extraction — each member's name split into ≥4-char
   *  words (matching `topicCounts`'s tokenizer), lowercased. So "Vikas Singhal" asking about pods doesn't
   *  make "vikas"/"singhal" read as things the fleet works ON. Rebuilt per pass (cheap; roster is small). */
  private memberNameStop(): Set<string> {
    const stop = new Set<string>();
    for (const m of this.os.team.listMembers()) {
      for (const w of (m.name || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) stop.add(w);
    }
    // Agent ids are WHO did the work, not WHAT the fleet works on — same reasoning as member names. A
    // report that names the agent it delegated to ("routed infra-ops…") shouldn't make "infra-ops" a topic.
    // Only the WHOLE id is stopped, never its parts: "migration-ops" is an agent, "migration" is a topic.
    try {
      for (const a of this.os.db.prepare('SELECT DISTINCT agent FROM term_sessions').all<{ agent: string }>()) {
        if (a.agent) stop.add(a.agent.toLowerCase());
      }
    } catch { /* advisory — a missing table just means no agent stop-words */ }
    return stop;
  }

  /** Serialize passes per tenant (M1). A manual "Review now" and the scheduler tick both call `dream()`,
   *  which does read-modify-write on `dreaming_state` with an `await` in the middle — concurrently they'd
   *  lose an update and double the `learning.dreamed` marker. One pass in flight per tenant; the loser
   *  no-ops with `busy`. In-memory is enough: within one process both callers share this set. */
  private static inFlight = new Set<string>();
  async dream(by = 'automation:dreamer'): Promise<DreamResult> {
    if (DreamingEngine.inFlight.has(this.os.tenant)) {
      this.markPass(by, { skipped: 'busy' });
      return { skipped: true, busy: true, window: { since: 0, until: Date.now() }, passes: this.load()?.passes };
    }
    DreamingEngine.inFlight.add(this.os.tenant);
    try {
      return await this.dreamInner(by);
    } catch (err) {
      // A reflect pass that THREW used to vanish (the scheduler `.catch`es it silently), so "ran and
      // errored" looked identical to "never ran". Leave a durable marker either way.
      this.markPass(by, { error: String((err as Error)?.message ?? err) });
      throw err;
    } finally {
      DreamingEngine.inFlight.delete(this.os.tenant);
    }
  }

  /** One durable audit line per reflect pass that did NOT complete — skipped (no activity / busy) or
   *  errored — so the Insights history distinguishes "ran, found nothing" and "errored" from "never ran".
   *  A completed pass emits its own richer `learning.dreamed`; this only covers the no-op/failure tails. */
  private markPass(by: string, data: Record<string, unknown>): void {
    try {
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: by, type: 'learning.skipped', data });
    } catch { /* best-effort telemetry — never let it break the pass */ }
  }

  /** Run one reflection pass: fold activity since the last pass into the cumulative state, re-render. */
  private async dreamInner(by = 'automation:dreamer'): Promise<DreamResult> {
    const db = this.os.db;
    const until = Date.now();
    const prior = this.load();
    // H2: window on a durable **data watermark** — the newest activity ts we've already consumed —
    // NOT the run clock. Migration-safe: states written before `watermark` existed fall back to the old
    // `learning.dreamed` marker, then to a 7-day cold start.
    const lastMark = db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.dreamed'").get<{ t: number | null }>();
    const since = prior?.watermark ?? lastMark?.t ?? until - 7 * 24 * 3_600_000;
    const window = { since, until };

    const episodes = db
      .prepare("SELECT content, created_at FROM memories WHERE created_at > ? AND tags LIKE '%\"episode\"%' ORDER BY created_at")
      .all<EpisodeRow>(since);
    // Exclude CHAT sessions from the outcome tally (parity with the scorecard/measurement/alerts): a chat
    // reply rarely calls `report`, so it lands as `unknown`/`ended` and drags the success RATE down — the
    // rate that drives guidance ("slow down") + the effort recommendation. Work sessions only. Friction
    // (rejections/budget/errors) below is left whole — a rejected approval is friction whoever hit it.
    const outcomeRows = db
      .prepare("SELECT run_id, ts, type, data FROM audit_events WHERE ts > ? AND type IN ('session.reported','session.ended','session.stopped','run.completed') AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM term_sessions WHERE spawned_by LIKE 'chat:%')) ORDER BY ts")
      .all<OutcomeRow>(since);
    const frictionRows = db
      .prepare("SELECT ts, type, data FROM audit_events WHERE ts > ? AND type IN ('budget.exceeded','session.error','approval.resolved')")
      .all<FrictionRow>(since);

    if (!episodes.length && !outcomeRows.length) {
      this.markPass(by, { skipped: 'no-activity', window });
      return { skipped: true, window, passes: prior?.passes };
    }

    // H3: collapse the terminal-event rows to ONE canonical row per session — a single session emits
    // several (`session.reported` AND `session.ended`, plus crash sweeps), which otherwise inflates the
    // session count and double-tallies the outcome, skewing the success rate that drives guidance +
    // recommendations. Prefer the agent's own reported outcome (it carries the real outcome), then
    // run.completed, then ended, then stopped.
    const OUTCOME_RANK: Record<string, number> = { 'session.reported': 3, 'run.completed': 2, 'session.ended': 1, 'session.stopped': 0 };
    const bySession = new Map<string, OutcomeRow>();
    for (const r of outcomeRows) {
      const key = r.run_id || `anon:${r.ts}`;
      const cur = bySession.get(key);
      if (!cur || (OUTCOME_RANK[r.type] ?? -1) > (OUTCOME_RANK[cur.type] ?? -1)) bySession.set(key, r);
    }
    const outcomes = [...bySession.values()];

    // ── this window's tallies ──
    const win: Tally = { sessions: outcomes.length, episodes: episodes.length, success: 0, failure: 0, partial: 0, stopped: 0, unknown: 0, approved: 0, rejected: 0, budgetStops: 0, errors: 0 };
    for (const e of outcomes) {
      const o = e.type === 'session.stopped' ? 'stopped' : String(parse(e.data).outcome ?? 'unknown');
      if (o in win) (win as unknown as Record<string, number>)[o]++; else win.unknown++;
    }
    for (const f of frictionRows) {
      if (f.type === 'budget.exceeded') win.budgetStops++;
      else if (f.type === 'session.error') win.errors++; // L3: real run errors, not memory-store (`episode.error`) failures
      else if (parse(f.data).approved === false) win.rejected++;
      else win.approved++; // the DENOMINATOR: friction is the rejection RATE, not the raw count (a busy day approves hundreds)
    }
    const winTopics = topicCounts(episodes, this.memberNameStop());

    // H2: advance the watermark to the newest ts we actually consumed (never `until`), so anything that
    // landed between that ts and now is picked up next pass instead of falling into a gap.
    let watermark = since;
    for (const e of episodes) if (e.created_at > watermark) watermark = e.created_at;
    for (const r of outcomeRows) if (r.ts > watermark) watermark = r.ts;
    for (const f of frictionRows) if (f.ts > watermark) watermark = f.ts;

    // ── fold into the cumulative state ──
    const state = prior ?? { firstPass: until, passes: 0, totals: zeroTally(), topics: {}, recent: [], watermark: since };
    state.passes += 1;
    state.watermark = watermark;
    for (const k of Object.keys(win) as (keyof Tally)[]) state.totals[k] += win[k];
    for (const [topic, n] of winTopics) {
      const cur = state.topics[topic] ?? { count: 0, lastSeen: 0 };
      state.topics[topic] = { count: cur.count + n, lastSeen: until };
    }
    state.topics = pruneTopics(state.topics, until); // M6: bound the map + drop long-unseen topics
    const day = new Date(until).toISOString().slice(0, 10);
    state.recent.unshift({ day, ts: until, sessions: win.sessions, success: win.success, failure: win.failure, stopped: win.stopped, approved: win.approved, rejected: win.rejected, budgetStops: win.budgetStops, errors: win.errors, topics: [...winTopics].slice(0, 6).map(([t]) => t) });
    state.recent = state.recent.slice(0, MAX_RECENT);

    this.os.settings.setDreamingState(state as unknown as Record<string, unknown>, by);

    // ── close the loop: distil actionable guidance → injected into every agent's prompt at launch ──
    const guidance = deriveGuidance(state);
    this.os.settings.setLearnedGuidance(guidance, by);

    // ── config loop: propose runtime/policy/budget tuning from friction (human Applies/Dismisses) ──
    const prevRecs = this.os.settings.recommendations();
    const candidates = deriveRecommendations(state, this.os.settings.runtimeDefaults().effort, until);
    const open = candidates.filter((c) => !prevRecs.dismissed.includes(c.id));
    this.os.settings.setRecommendations({ open, dismissed: prevRecs.dismissed }, by);

    // ── render the cumulative page from state ──
    const body = renderPage(state);
    let kbPageId: string | undefined;
    try {
      const page = this.os.kb.write({ tenant: this.os.tenant, section: DREAM_SECTION, slug: DREAM_SLUG, title: 'Fleet learnings', body, tags: ['dreaming', 'operations'], summary: `self-learning pass ${state.passes} (${day})`, author: by });
      kbPageId = page.id;
      this.os.audit.append({ ts: until, runId: '-', tenant: this.os.tenant, principal: by, type: 'kb.written', data: { id: page.id, section: page.section, slug: page.slug, rev: page.rev } });
    } catch { /* best-effort */ }

    // ── tenant-shared memory Insight (cumulative summary) ──
    let insightId: string | undefined;
    try {
      const t = state.totals;
      const rate = t.sessions ? Math.round((t.success / t.sessions) * 100) : 0;
      const topTopics = topTopicList(state.topics, 6).filter(([, v]) => v.count >= MIN_TOPIC_COUNT).map(([k]) => k).join(', ') || '—';
      const summary = `Fleet self-learning (pass ${state.passes}, since ${new Date(state.firstPass).toISOString().slice(0, 10)}): ${t.sessions} sessions, ${rate}% success. Recurring topics: ${topTopics}. Friction so far: ${t.rejected} approvals rejected, ${t.budgetStops} budget stops, ${t.errors} errors. Details: [[${DREAM_SECTION}/${DREAM_SLUG}]].`;
      const rec = await this.os.memory.store({ tenant: this.os.tenant, agentId: 'dreamer', content: summary, tags: ['dreaming', 'learned'], type: 'Insight', importance: 0.6, scope: 'tenant', metadata: { passes: state.passes, window, sessions: win.sessions } });
      insightId = rec.id;
    } catch { /* best-effort */ }

    this.os.audit.append({ ts: until, runId: '-', tenant: this.os.tenant, principal: by, type: 'learning.dreamed', data: { pass: state.passes, sessions: win.sessions, episodes: win.episodes, kbPageId, insightId } });
    return { skipped: false, window, passes: state.passes, sessions: win.sessions, episodes: win.episodes, kbPageId, insightId, guidance };
  }

  private load(): DreamState | null {
    const raw = this.os.settings.dreamingState();
    return raw ? normalizeState(raw as Record<string, unknown>) : null;
  }
}

/** L1: repair a partial / schema-drifted / corrupt `dreaming_state` into a well-formed shape, so the
 *  fold's `state.totals[k] += win[k]` can never hit an `undefined` field and spew `NaN` into every
 *  downstream number (rate, guidance, the page). Non-numeric fields fall back to safe defaults. */
function normalizeState(raw: Record<string, unknown>): DreamState {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const rt = (raw.totals ?? {}) as Record<string, unknown>;
  const totals = zeroTally();
  for (const k of Object.keys(totals) as (keyof Tally)[]) totals[k] = num(rt[k], 0);
  const topics: DreamState['topics'] = {};
  for (const [k, v] of Object.entries((raw.topics ?? {}) as Record<string, unknown>)) {
    const o = (v ?? {}) as { count?: unknown; lastSeen?: unknown };
    if (Number.isFinite(Number(o.count))) topics[k] = { count: num(o.count, 0), lastSeen: num(o.lastSeen, 0) };
  }
  const recent = Array.isArray(raw.recent) ? (raw.recent as RecentEntry[]) : [];
  const watermark = Number.isFinite(Number(raw.watermark)) ? Number(raw.watermark) : undefined;
  return { firstPass: num(raw.firstPass, Date.now()), passes: num(raw.passes, 0), totals, topics, recent, watermark };
}

function zeroTally(): Tally {
  return { sessions: 0, episodes: 0, success: 0, failure: 0, partial: 0, stopped: 0, unknown: 0, approved: 0, rejected: 0, budgetStops: 0, errors: 0 };
}

function parse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

/** Count topic keywords across the window's episode task/summary lines. `nameStop` holds team-member
 *  name tokens (built per-pass from the roster) — a person's name describes WHO asked, not WHAT the fleet
 *  works on, so "the fleet frequently works on … vikas, singhal" is noise; drop them alongside STOP. */
function topicCounts(episodes: EpisodeRow[], nameStop: Set<string> = new Set()): [string, number][] {
  const proper = properNouns(episodes);
  const counts = new Map<string, number>();
  for (const e of episodes) {
    const line = firstLine(e);
    const seen = new Set<string>();
    for (const w of line.toLowerCase().match(/[a-z][a-z0-9.-]{3,}/g) ?? []) {
      const t = w.replace(/[.-]+$/, '');
      // A filename is stopped by its base name, so `claude.md` is caught by the `claude` stop-word.
      const base = t.replace(/\.[a-z0-9]{1,4}$/, '');
      if (t.length < 4 || STOP.has(t) || STOP.has(base) || nameStop.has(t) || nameStop.has(base) || seen.has(t)) continue; // once per episode
      if (!isEntity(t, proper)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** The first meaningful line of an episode, with the `Task:` prefix stripped. */
function firstLine(e: EpisodeRow): string {
  return (e.content.split('\n').map((l) => l.trim()).find((l) => l) ?? '').replace(/^Task:\s*/i, '');
}

const WORD_RE = /[A-Za-z][A-Za-z0-9.-]{3,}/g;

const CAPS_RUN_MAX = 1;    // ≥2 adjacent ALL-CAPS words = shouting, not an acronym
const TITLE_CASE_RATIO = 0.6;  // a line this capitalized is a heading — its case carries no signal
const ACRONYM_MAX = 6;     // FreeScout/SSL/FPM/ASE are short; a long ALL-CAPS word is emphasis
const NAME_CONSISTENCY = 0.6;  // share of a token's non-forced occurrences that must be capitalized

/**
 * Tokens the corpus itself writes as a **name** — capitalized away from a sentence start, or written as
 * a short acronym. Case is the one strong, maintenance-free signal for "this is a thing, not an English
 * word", and the old lowercase-first tokenizer threw it away before anything could use it.
 *
 * Case is only a signal where the writer was *choosing* it word by word. Two constructions break that,
 * and both are common in agent prompts — a first pass on live data returned "automated, incremental,
 * sweep, drafts", every one of them from a single automation prompt repeated ten times whose first line
 * was `AUTOMATED INCREMENTAL SUPPORT SWEEP — runs every 2h, unattended, DRAFTS ONLY`:
 *  - **Shouting.** A run of adjacent ALL-CAPS words is emphasis. A real acronym sits among lowercase
 *    words ("the FPM worker", "valid SSL cert"), so require an isolated, short one.
 *  - **Title Case / headings.** If most of a line's words are capitalized, capitalization distinguishes
 *    nothing within it; the whole line is skipped for the capitalized-word signal.
 */
function properNouns(episodes: EpisodeRow[]): Set<string> {
  const cap = new Map<string, number>();    // written as a name
  const lower = new Map<string, number>();  // written as an ordinary word
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  // Case evidence is counted per DISTINCT line. The corpus is dominated by automation prompts repeated
  // dozens of times verbatim, and re-reading one template 40× is not 40 independent writers choosing a
  // capital — it let a single prompt's emphasis words ("WAIT for it to finish", "Read-only.") outweigh
  // every real name. `topicCounts` still counts per episode, so frequency itself is unaffected.
  const lines = [...new Set(episodes.map(firstLine))];
  for (const line of lines) {
    const words = [...line.matchAll(/[A-Za-z][A-Za-z0-9.-]*/g)];
    const alpha = words.filter((w) => w[0].length > 1);
    const capitalized = alpha.filter((w) => /^[A-Z]/.test(w[0])).length;
    // A heading / Title Case line: case is uniform, so it separates nothing. Skipped entirely — it must
    // not contribute to the lowercase side of the ratio either.
    if (alpha.length >= 4 && capitalized / alpha.length >= TITLE_CASE_RATIO) continue;

    const isCaps = (w: string) => w === w.toUpperCase() && /[A-Z]{2,}/.test(w);
    for (let i = 0; i < words.length; i++) {
      const raw = words[i][0].replace(/[.-]+$/, '');
      if (raw.length < 4) continue;
      const key = raw.toLowerCase();
      const before = line.slice(0, words[i].index).trimEnd();
      // A "sentence start" is anywhere the capital is forced. Beyond punctuation that means: nothing but
      // symbols before it — the OS's own poke-back templates open with an emoji ("✅ Really done:",
      // "⛔ Handed back:"), and treating those as mid-sentence made "really"/"handed" read as names.
      const sentenceStart = before === '' || /[.!?:;•(\[\-—]$/.test(before) || !/[A-Za-z]/.test(before);
      if (isCaps(words[i][0])) {
        // An acronym is short and stands alone; a run of caps is a shouted header.
        const neighbours = [words[i - 1], words[i + 1]].filter((w) => w && isCaps(w[0])).length;
        if (raw.length <= ACRONYM_MAX && neighbours <= CAPS_RUN_MAX - 1) bump(cap, key);
        continue;
      }
      if (/^[A-Z]/.test(raw)) {
        // An enumerated label — "Phase 1", "Tier 2", "Step 3". The capital marks a section heading, not a
        // name, so it must not count as evidence of one.
        const after = line.slice((words[i].index ?? 0) + words[i][0].length);
        if (/^\s+\d/.test(after)) continue;
        // Sentence-start capitalization is forced by grammar — it says nothing either way, so it counts
        // toward neither side of the ratio.
        if (!sentenceStart) bump(cap, key);
      } else bump(lower, key);
    }
  }

  // A real name is *consistently* capitalized: "Composio", "DataForSEO", "Globex". A word the corpus
  // also writes in lowercase is an ordinary word that happened to start a clause — this is what separates
  // "Phase 1"/"Publish the draft" (also written "phase"/"publish") from a product name. Corpus-internal,
  // so it needs no list to maintain.
  const proper = new Set<string>();
  for (const [k, n] of cap) {
    if (n / (n + (lower.get(k) ?? 0)) >= NAME_CONSISTENCY) proper.add(k);
  }
  return proper;
}

/**
 * Whether a token is a THING the fleet works on rather than an ordinary English word. The old filter was a
 * hand-maintained blocklist, which is unwinnable — fleet data produced "the fleet frequently works on:
 * globex, handed, client-app, read-only, really", and every such word had to be discovered in production
 * and then patched in. This inverts it to an ALLOW test on shape: a topic must be written as a name
 * somewhere (`properNouns`), or carry a digit or a dot (`v3`, `php8`, `globex.com`). Deliberately
 * precision-over-recall — an always-lowercase repo name is missed, but nothing embarrassing gets through,
 * and the guidance line only prints at all when ≥2 topics survive.
 */
function isEntity(token: string, proper: Set<string>): boolean {
  // A FILENAME qualifies on its base name, never its extension — otherwise the dot rule (meant for
  // hostnames and versions) admits every path an agent mentions, including format placeholders like
  // `yyyy-mm-dd.md`. `.com`/`.io` are not code extensions, so real hostnames still pass below.
  const m = /^(.*)\.(md|json|jsonl|ts|tsx|js|jsx|sh|ya?ml|txt|log|csv|sql|php|py|rb|go|html?|css|toml|ini|env|lock)$/.exec(token);
  if (m) return isEntity(m[1], proper);
  return proper.has(token) || /\d/.test(token) || token.includes('.');
}

/** A recency-decayed weight for a topic — `count` halved for every `TOPIC_HALFLIFE_MS` since last seen,
 *  so a topic the fleet worked hard on months ago sinks below one it's touching now (L2/L1). */
function topicWeight(v: { count: number; lastSeen: number }, now: number): number {
  return v.count * Math.pow(0.5, Math.max(0, now - (v.lastSeen || 0)) / TOPIC_HALFLIFE_MS);
}

function topTopicList(topics: Record<string, { count: number; lastSeen: number }>, n: number, now = Date.now()): [string, { count: number; lastSeen: number }][] {
  return Object.entries(topics)
    .sort((a, b) => topicWeight(b[1], now) - topicWeight(a[1], now))
    .slice(0, n);
}

/** Drop long-unseen topics, then cap the map to the top `TOPIC_CAP` by recency weight — so "compounding"
 *  sharpens and forgets instead of accumulating forever (M6). Pure. */
function pruneTopics(topics: Record<string, { count: number; lastSeen: number }>, now: number): Record<string, { count: number; lastSeen: number }> {
  const kept = Object.entries(topics)
    .filter(([, v]) => now - (v.lastSeen || 0) <= TOPIC_MAX_AGE_MS)
    .sort((a, b) => topicWeight(b[1], now) - topicWeight(a[1], now))
    .slice(0, TOPIC_CAP);
  const out: Record<string, { count: number; lastSeen: number }> = {};
  for (const [k, v] of kept) out[k] = v;
  return out;
}

/** Sum the RECENT window (last `RECENT_PASSES` per-pass tallies) — the honest "recent" signal for
 *  guidance + recommendations, vs. the ever-growing lifetime `totals` (H4). */
function recentTally(s: DreamState): { sessions: number; success: number; approved: number; rejected: number; budgetStops: number; errors: number } {
  const r = { sessions: 0, success: 0, approved: 0, rejected: 0, budgetStops: 0, errors: 0 };
  for (const e of (s.recent ?? []).slice(0, RECENT_PASSES)) {
    r.sessions += e.sessions || 0;
    r.success += e.success || 0;
    r.approved += e.approved || 0;
    r.rejected += e.rejected || 0;
    r.budgetStops += e.budgetStops || 0;
    r.errors += e.errors || 0;
  }
  return r;
}

/**
 * Approval friction is a **rate**, not a count. Gating on "≥3 rejections" fired on tenants whose approvals
 * are ~100% approved — 3 rejections out of 400 is a healthy gate, and telling the owner their policy is
 * over-rejecting (and telling every agent to expect rejection) was simply wrong. Both the guidance line
 * and the recommendation now need the raw count AND this share of human decisions.
 *
 * Legacy `recent` entries have no `approved` field → they read as 0, so a stale state can still fire once;
 * it self-corrects on the next pass, which records the denominator.
 */
const REJECTION_RATE = 0.2;
function rejectionRate(t: { approved: number; rejected: number }): number {
  const n = t.approved + t.rejected;
  return n ? t.rejected / n : 0;
}

// Cadence is OFF (everyHours 0) → learned guidance goes stale after this long unrefreshed. When a cadence
// IS set, staleness is 2× that interval (one missed cycle is fine; two means reflection has stalled).
const GUIDANCE_STALE_OFF_MS = 7 * 24 * 3_600_000;

/**
 * Whether the distilled learned guidance is too old to still present as "what's been recurring". Guards
 * both the prompt injection and the Insights UI so a stalled/disabled reflect loop stops re-serving a
 * frozen snapshot as if it were current (the "old insights reported again and again" failure). `never
 * run` → not stale (there's no guidance to serve anyway); a real last-pass ts is compared to 2× the
 * cadence, or a 7-day floor when the cadence is off. Pure.
 */
export function guidanceStale(lastDreamedAtMs: number | undefined | null, everyHours: number, now = Date.now()): boolean {
  if (!lastDreamedAtMs) return false;
  const maxAgeMs = everyHours > 0 ? everyHours * 3_600_000 * 2 : GUIDANCE_STALE_OFF_MS;
  return now - lastDreamedAtMs > maxAgeMs;
}

/**
 * Distil the cumulative state into a few **actionable imperatives** for agents — the behavioral output
 * (vs. renderPage's descriptive stats). Kept short: it rides in EVERY agent's system prompt. Returns ''
 * only when there's genuinely nothing to say (there's always the baseline recall/KB nudge once we've run).
 */
export function deriveGuidance(s: DreamState): string {
  const t = recentTally(s); // H4: recent window, not lifetime totals — so subsided friction stops nagging
  const lines: string[] = [];
  lines.push('Before non-trivial work, `recall` your memory and `kb_search` the knowledge base — the fleet may have already solved this; build on it rather than redoing it.');
  const topics = topTopicList(s.topics, 5).filter(([, v]) => v.count >= MIN_TOPIC_COUNT).map(([k]) => k);
  if (topics.length >= 2) lines.push(`The fleet frequently works on: ${topics.join(', ')}. For these, read the KB runbook first (kb_read) and update it (kb_write) when you learn something new.`);
  if (t.rejected >= 2 && rejectionRate(t) >= REJECTION_RATE) lines.push('Recent actions were rejected at human approval — `policy_check` before risky effects, and never retry an action a human already rejected.');
  if (t.budgetStops >= 1) lines.push('Budget limits have been hit — scope work tightly, avoid broad scans / long loops, and `ask` rather than burn budget guessing.');
  if (t.errors >= 2) lines.push('Some sessions ended in errors — verify your work before finishing, and `report` the real outcome (including failures) honestly.');
  const rate = t.sessions ? t.success / t.sessions : 1;
  if (t.sessions >= 5 && rate < 0.7) lines.push(`Recent success rate is ${Math.round(rate * 100)}% — slow down, confirm assumptions, and prefer asking over guessing on anything ambiguous.`);
  const top = lines.slice(0, 6);
  if (!top.length) return '';
  return [
    '# Learned operating guidance',
    "_Auto-derived from this workspace's recent runs by the self-learning pass — these reflect what has actually been recurring or going wrong. Follow them:_",
    ...top.map((l) => `- ${l}`),
  ].join('\n');
}

/**
 * Whether an OPEN recommendation's condition is already resolved, so it should no longer be shown.
 * Recommendations are regenerated only when a full reflect pass runs; between passes a leftover can
 * linger after a human has already acted (e.g. they set effort to `high` in Settings). This drops those
 * at read time so a stale card can't nag. Only recs with a clean "resolved?" signal are pruned; advisory
 * ones (policy/budget) clear on the next pass.
 */
export function recommendationResolved(rec: Recommendation, currentEffort: string | undefined): boolean {
  if (rec.id === 'runtime.effort.high') return currentEffort === 'high' || currentEffort === 'xhigh' || currentEffort === 'max';
  return false;
}

/**
 * Propose config tuning from cumulative friction — each is a human-gated suggestion, never auto-applied.
 * `apply` present → directly applyable (a reversible runtime-defaults change); otherwise advisory.
 */
export function deriveRecommendations(s: DreamState, currentEffort: string | undefined, now: number): Recommendation[] {
  const t = recentTally(s); // H4: propose from RECENT friction, not lifetime — a subsided problem stops re-proposing
  const recs: Recommendation[] = [];
  const rate = t.sessions ? t.success / t.sessions : 1;
  const effortAlreadyHigh = currentEffort === 'high' || currentEffort === 'xhigh' || currentEffort === 'max';
  if (t.sessions >= 5 && rate < 0.7 && !effortAlreadyHigh) {
    recs.push({
      id: 'runtime.effort.high', kind: 'runtime',
      title: 'Raise the workspace default reasoning effort to “high”',
      rationale: `Recent success rate is ${Math.round(rate * 100)}% over ${t.sessions} sessions${t.errors ? `, with ${t.errors} errored` : ''}. More reasoning effort often helps agents get it right the first time. Reversible in Settings → Runtime defaults.`,
      apply: { runtimeDefaults: { effort: 'high' } }, createdAt: now,
    });
  }
  if (t.rejected >= 3 && rejectionRate(t) >= REJECTION_RATE) {
    recs.push({
      id: 'policy.review', kind: 'policy',
      title: 'Review your policy — actions are often rejected at approval',
      rationale: `${t.rejected} of ${t.approved + t.rejected} approvals were rejected (${Math.round(rejectionRate(t) * 100)}%). If a capability is always rejected it may belong on the deny list; if always approved, the gate is just friction. (Advisory — edit in Settings → Policy.)`,
      link: '#/settings', createdAt: now,
    });
  }
  if (t.budgetStops >= 2) {
    recs.push({
      id: 'budget.review', kind: 'budget',
      title: 'Review default budgets — limits are being hit',
      rationale: `${t.budgetStops} runs hit a budget limit. Either raise the caps (if work legitimately needs more) or tighten agent scope — check whether agents are looping. (Advisory.)`,
      link: '#/settings', createdAt: now,
    });
  }
  return recs;
}

function renderPage(s: DreamState): string {
  const t = s.totals;
  const rate = t.sessions ? Math.round((t.success / t.sessions) * 100) : 0;
  const top = topTopicList(s.topics, TOP_TOPICS);
  return [
    `_Auto-maintained and **compounding** — each self-learning pass folds new activity into this page (a pure render of the OS's cumulative state; it rebuilds even if deleted). Edit it and the next pass will overwrite._`,
    ``,
    `**Pass ${s.passes}** · learning since ${new Date(s.firstPass).toISOString().slice(0, 10)}`,
    ``,
    `## Cumulative totals`,
    `- Sessions/runs: **${t.sessions}** — ${t.success} succeeded, ${t.failure} failed, ${t.partial} partial, ${t.stopped} stopped, ${t.unknown} unknown · **${rate}% success**.`,
    `- Episodes captured: **${t.episodes}**.`,
    `- Friction (all-time): ${t.rejected} approvals rejected · ${t.budgetStops} budget stops · ${t.errors} episode errors.`,
    ``,
    `## Recurring topics`,
    ...(top.length ? top.map(([k, v]) => `- **${k}** — ${v.count}× (last seen ${new Date(v.lastSeen).toISOString().slice(0, 10)})`) : ['- (none yet)']),
    ``,
    `## Recent passes`,
    ...(s.recent.length
      ? s.recent.map((r) => `- **${r.day}** — ${r.sessions} sessions (${r.success} ok, ${r.failure} failed, ${r.stopped} stopped)${r.rejected || r.budgetStops || r.errors ? ` · friction: ${r.rejected}/${r.budgetStops}/${r.errors}` : ''}${r.topics.length ? ` · topics: ${r.topics.join(', ')}` : ''}`)
      : ['- (none)']),
  ].join('\n');
}
