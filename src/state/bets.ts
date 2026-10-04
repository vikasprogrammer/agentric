/**
 * The Bets plane (`os.bets`) — the missing unit between a goal and the work.
 *
 * A goal says where to get to. A task says what to do. Neither can answer the only question that
 * matters to an autonomous loop: **did that change anything?** A bet is one falsifiable attempt at a
 * goal's number — a hypothesis, the things it put into the world (its ASSETS), a window, a predicted
 * lift, and at the end of that window a verdict computed from those assets' own measurements.
 *
 * ## Why assets, and not the goal's metric
 *
 * Whole-metric attribution cannot separate two bets running at once, and on any real goal several are.
 * The instapods growth trial ran three bets inside four days while the site-wide number drifted DOWN
 * for unrelated reasons; judged on the goal, all three would read as failures. So lift is measured on
 * the bet's own assets (`sum(value) − baseline`) and the goal's metric stays what it is: the outcome
 * nobody owns alone.
 *
 * ## Why this is not a task
 *
 * A task is done when the work is done; a bet is done when the number has been judged, usually weeks
 * later. Three concrete breakages from folding them together (and the reason `tasks.bet_id` is a
 * pointer rather than a parent row):
 *   - `todo → doing → blocked → done` has no state for "work shipped, still measuring";
 *   - an agent-assigned `auto_dispatch` task gets SPAWNED — a bet must never spawn a run, only its
 *     tasks should;
 *   - hypothesis / window / baseline / expected lift / verdict have no home on a task.
 *
 * ## Governance
 *
 * Auto-apply + audit, like Tasks and KB — the safety net is that every edit is an audited row and the
 * arithmetic half is not writable by the agent at all. The split is deliberate and load-bearing:
 *
 *   - **The server owns the number.** `judge()` computes `observedLift` and a `verdict` of
 *     `met | short | no_signal` from the assets, and nothing else may set those three fields.
 *   - **The agent owns the words.** `kept` / `expanded` / `killed` plus the `lesson` are a judgement
 *     someone commits to. An agent that disagrees with the arithmetic may still kill a `met` bet — the
 *     audit row carries both, so the divergence is visible instead of impossible.
 *
 * That is the lesson from Insights (a self-graded outcome drove ~zero action): a verdict an agent can
 * write about its own work is worth very little, and one it cannot write is worth having.
 */
import { newId } from '../id';
import { Db } from './db';
import { Bet, BetAsset, BetState, BetVerdict, BET_LIVE_STATES } from '../types';

/** Live bets per goal. Past this, a loop is running more experiments than it can attribute — and the
 *  trial's own operator hit exactly this ceiling, which is why it is a number and not a vibe. */
export const MAX_LIVE_BETS = 4;
/** A window shorter than this cannot show a search/content effect; longer than this is not a bet. */
export const MIN_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 60;
/** Assets per bet — enough for a page family, few enough that "measure them all" stays cheap. */
export const MAX_ASSETS = 60;
/** Reaching this share of the predicted lift counts as `met`. Below it the bet is `short`: the honest
 *  reading of "it did something, just not what we bet on" is still a kill decision, not a win. */
export const MET_FRACTION = 0.5;

const DAY = 86_400_000;

interface BetRow {
  id: string; tenant: string; goal_id: string; title: string; hypothesis: string; lever: string | null;
  state: string; expected_lift: number | null; window_days: number; baseline: number | null;
  observed_lift: number | null; verdict: string | null; verdict_note: string | null; lesson: string | null;
  started_at: number | null; judge_at: number | null; judged_at: number | null; parent_id: string | null;
  created_by: string; created_at: number; updated_at: number;
}

interface AssetRow {
  id: string; bet_id: string; task_id: string | null; kind: string; url: string; state: string;
  indexed: number | null; value: number | null; secondary: number | null; position: number | null;
  measured_at: number | null; published_at: number | null; created_at: number;
}

function toBet(r: BetRow): Bet {
  return {
    id: r.id, tenant: r.tenant, goalId: r.goal_id, title: r.title, hypothesis: r.hypothesis,
    state: r.state as BetState, windowDays: r.window_days, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.lever ? { lever: r.lever } : {}),
    ...(r.expected_lift !== null ? { expectedLift: r.expected_lift } : {}),
    ...(r.baseline !== null ? { baseline: r.baseline } : {}),
    ...(r.observed_lift !== null ? { observedLift: r.observed_lift } : {}),
    ...(r.verdict ? { verdict: r.verdict as BetVerdict } : {}),
    ...(r.verdict_note ? { verdictNote: r.verdict_note } : {}),
    ...(r.lesson ? { lesson: r.lesson } : {}),
    ...(r.started_at !== null ? { startedAt: r.started_at } : {}),
    ...(r.judge_at !== null ? { judgeAt: r.judge_at } : {}),
    ...(r.judged_at !== null ? { judgedAt: r.judged_at } : {}),
    ...(r.parent_id ? { parentId: r.parent_id } : {}),
  };
}

function toAsset(r: AssetRow): BetAsset {
  return {
    id: r.id, betId: r.bet_id, kind: r.kind as BetAsset['kind'], url: r.url,
    state: r.state as BetAsset['state'], createdAt: r.created_at,
    ...(r.task_id ? { taskId: r.task_id } : {}),
    ...(r.indexed !== null ? { indexed: r.indexed === 1 } : {}),
    ...(r.value !== null ? { value: r.value } : {}),
    ...(r.secondary !== null ? { secondary: r.secondary } : {}),
    ...(r.position !== null ? { position: r.position } : {}),
    ...(r.measured_at !== null ? { measuredAt: r.measured_at } : {}),
    ...(r.published_at !== null ? { publishedAt: r.published_at } : {}),
  };
}

export interface BetCreateInput {
  tenant: string;
  goalId: string;
  title: string;
  hypothesis?: string;
  lever?: string;
  expectedLift?: number;
  windowDays?: number;
  baseline?: number;
  parentId?: string;
  createdBy: string;
  /** Start it now (the default) or leave it `proposed` for a human to green-light. */
  start?: boolean;
}

export interface BetUpdateInput {
  state?: BetState;
  lesson?: string;
  hypothesis?: string;
  expectedLift?: number;
  baseline?: number;
  windowDays?: number;
  by: string;
}

export interface AssetInput {
  betId: string;
  url: string;
  kind?: BetAsset['kind'];
  taskId?: string;
  publishedAt?: number;
}

export interface AssetMeasureInput {
  value?: number;
  secondary?: number;
  position?: number;
  indexed?: boolean;
  state?: BetAsset['state'];
  at?: number;
}

/** What `judge()` worked out, for the card, the audit row and the test. */
export interface BetJudgement {
  bet: Bet;
  verdict: BetVerdict;
  observedLift: number;
  baseline: number;
  expected?: number;
  /** Assets that carry a measurement — the sample behind the number. */
  measured: number;
  assets: number;
  note: string;
}

export class BetStore {
  constructor(private db: Db) {}

  create(input: BetCreateInput): Bet {
    const title = input.title.trim();
    if (!title) throw new Error('a bet needs a title');
    if (!input.goalId) throw new Error('a bet needs a goal');
    const live = this.liveCount(input.tenant, input.goalId);
    if (live >= MAX_LIVE_BETS) throw new Error(`that goal already has ${live} live bets (max ${MAX_LIVE_BETS}) — judge or kill one first`);
    const windowDays = Math.min(Math.max(Math.round(input.windowDays ?? 21), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
    const now = Date.now();
    const start = input.start !== false;
    const id = newId('bet');
    this.db
      .prepare(`INSERT INTO bets (id, tenant, goal_id, title, hypothesis, lever, state, expected_lift, window_days, baseline, parent_id, started_at, judge_at, created_by, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.tenant, input.goalId, title, (input.hypothesis ?? '').trim(), input.lever?.trim() || null,
        start ? 'running' : 'proposed',
        Number.isFinite(input.expectedLift as number) ? input.expectedLift! : null,
        windowDays,
        Number.isFinite(input.baseline as number) ? input.baseline! : null,
        input.parentId ?? null,
        start ? now : null, start ? now + windowDays * DAY : null,
        input.createdBy, now, now);
    return this.get(id)!;
  }

  get(id: string): Bet | undefined {
    const r = this.db.prepare('SELECT * FROM bets WHERE id = ?').get<BetRow>(id);
    return r ? toBet(r) : undefined;
  }

  /** Bets for a tenant, newest first; `goalId`/`state` narrow it. */
  list(tenant: string, opts: { goalId?: string; state?: BetState | 'live'; limit?: number } = {}): Bet[] {
    const where = ['tenant = ?'];
    const args: unknown[] = [tenant];
    if (opts.goalId) { where.push('goal_id = ?'); args.push(opts.goalId); }
    if (opts.state === 'live') where.push(`state IN (${BET_LIVE_STATES.map((s) => `'${s}'`).join(',')})`);
    else if (opts.state) { where.push('state = ?'); args.push(opts.state); }
    const rows = this.db
      .prepare(`SELECT * FROM bets WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all<BetRow>(...args, Math.min(Math.max(opts.limit ?? 50, 1), 200));
    return rows.map(toBet);
  }

  liveCount(tenant: string, goalId: string): number {
    return this.db
      .prepare(`SELECT COUNT(*) AS n FROM bets WHERE tenant = ? AND goal_id = ? AND state IN (${BET_LIVE_STATES.map((s) => `'${s}'`).join(',')})`)
      .get<{ n: number }>(tenant, goalId)?.n ?? 0;
  }

  /**
   * Edit a bet. The three arithmetic fields (`observedLift`, `verdict`, `verdictNote`) are absent from
   * {@link BetUpdateInput} on purpose — only {@link judge} writes those, so an agent cannot grade its own
   * work. Starting a bet (→ `running`) stamps the window; a terminal state stamps `judgedAt`.
   */
  update(id: string, input: BetUpdateInput): Bet | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const args: unknown[] = [now];
    if (input.state && input.state !== cur.state) {
      sets.push('state = ?'); args.push(input.state);
      if (input.state === 'running' && !cur.startedAt) {
        const windowDays = Math.min(Math.max(Math.round(input.windowDays ?? cur.windowDays), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
        sets.push('started_at = ?', 'judge_at = ?'); args.push(now, now + windowDays * DAY);
      }
      if (input.state === 'kept' || input.state === 'killed' || input.state === 'expanded') {
        sets.push('judged_at = ?'); args.push(now);
      }
    }
    if (input.lesson !== undefined) { sets.push('lesson = ?'); args.push(input.lesson.trim() || null); }
    if (input.hypothesis !== undefined) { sets.push('hypothesis = ?'); args.push(input.hypothesis.trim()); }
    if (input.expectedLift !== undefined && Number.isFinite(input.expectedLift)) { sets.push('expected_lift = ?'); args.push(input.expectedLift); }
    if (input.baseline !== undefined && Number.isFinite(input.baseline)) { sets.push('baseline = ?'); args.push(input.baseline); }
    if (input.windowDays !== undefined && Number.isFinite(input.windowDays)) {
      const windowDays = Math.min(Math.max(Math.round(input.windowDays), MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
      sets.push('window_days = ?'); args.push(windowDays);
      // Re-stamp the deadline off the ORIGINAL start, so stretching a window cannot be used to postpone
      // a judgement indefinitely by restarting the clock.
      if (cur.startedAt) { sets.push('judge_at = ?'); args.push(cur.startedAt + windowDays * DAY); }
    }
    this.db.prepare(`UPDATE bets SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return this.get(id);
  }

  // ── assets ────────────────────────────────────────────────────────────────────────────────────────
  /** Record something the bet shipped. Idempotent on (bet, url): re-recording updates rather than
   *  duplicating, because an agent re-running its own publish step is normal. */
  addAsset(tenant: string, input: AssetInput): BetAsset {
    const url = input.url.trim();
    if (!url) throw new Error('an asset needs a url');
    const bet = this.get(input.betId);
    if (!bet) throw new Error(`no bet "${input.betId}"`);
    const existing = this.db.prepare('SELECT id FROM bet_assets WHERE bet_id = ? AND url = ?').get<{ id: string }>(input.betId, url);
    const now = Date.now();
    if (existing) {
      this.db.prepare('UPDATE bet_assets SET kind = ?, task_id = COALESCE(?, task_id), published_at = COALESCE(?, published_at) WHERE id = ?')
        .run(input.kind ?? 'page', input.taskId ?? null, input.publishedAt ?? null, existing.id);
      return this.asset(existing.id)!;
    }
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM bet_assets WHERE bet_id = ?').get<{ n: number }>(input.betId)?.n ?? 0;
    if (count >= MAX_ASSETS) throw new Error(`that bet already has ${count} assets (max ${MAX_ASSETS})`);
    const id = newId('asset');
    this.db
      .prepare('INSERT INTO bet_assets (id, tenant, bet_id, task_id, kind, url, state, published_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, tenant, input.betId, input.taskId ?? null, input.kind ?? 'page', url, 'live', input.publishedAt ?? now, now);
    return this.asset(id)!;
  }

  asset(id: string): BetAsset | undefined {
    const r = this.db.prepare('SELECT * FROM bet_assets WHERE id = ?').get<AssetRow>(id);
    return r ? toAsset(r) : undefined;
  }

  assets(betId: string): BetAsset[] {
    return this.db.prepare('SELECT * FROM bet_assets WHERE bet_id = ? ORDER BY created_at').all<AssetRow>(betId).map(toAsset);
  }

  /** Attach this measurement cycle's numbers to one asset, by url within its bet (the handle an agent
   *  naturally has). Absent fields are left alone — a run that only checked indexing says only that. */
  measureAsset(betId: string, url: string, m: AssetMeasureInput): BetAsset | undefined {
    const row = this.db.prepare('SELECT id FROM bet_assets WHERE bet_id = ? AND url = ?').get<{ id: string }>(betId, url.trim());
    if (!row) return undefined;
    const sets: string[] = [];
    const args: unknown[] = [];
    if (m.value !== undefined && Number.isFinite(m.value)) { sets.push('value = ?'); args.push(m.value); }
    if (m.secondary !== undefined && Number.isFinite(m.secondary)) { sets.push('secondary = ?'); args.push(m.secondary); }
    if (m.position !== undefined && Number.isFinite(m.position)) { sets.push('position = ?'); args.push(m.position); }
    if (m.indexed !== undefined) { sets.push('indexed = ?'); args.push(m.indexed ? 1 : 0); }
    if (m.state) { sets.push('state = ?'); args.push(m.state); }
    if (!sets.length) return this.asset(row.id);
    sets.push('measured_at = ?'); args.push(m.at ?? Date.now());
    this.db.prepare(`UPDATE bet_assets SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
    return this.asset(row.id);
  }

  // ── the arithmetic ────────────────────────────────────────────────────────────────────────────────
  /** Bets whose window has closed and that nobody has judged yet — what the sweep picks up. */
  due(tenant: string, now = Date.now()): Bet[] {
    return this.db
      .prepare("SELECT * FROM bets WHERE tenant = ? AND state = 'running' AND judge_at IS NOT NULL AND judge_at <= ? ORDER BY judge_at")
      .all<BetRow>(tenant, now)
      .map(toBet);
  }

  /**
   * Compute the verdict from the bet's own assets and move it to `judging`.
   *
   * `no_signal` before anything else: a bet whose assets carry no measurement, or whose pages Google
   * never indexed, has not been tested — calling that a failure would teach the loop the wrong lesson
   * (and on the live trial, "11 of 15 posts never indexed" was exactly the distinction that mattered).
   * Then `met` at {@link MET_FRACTION} of the predicted lift, else `short`.
   *
   * Idempotent: judging an already-judged bet recomputes nothing and returns undefined.
   */
  judge(id: string, now = Date.now()): BetJudgement | undefined {
    const bet = this.get(id);
    if (!bet || (bet.state !== 'running' && bet.state !== 'judging')) return undefined;
    const assets = this.assets(id).filter((a) => a.state !== 'removed');
    const measured = assets.filter((a) => a.value !== undefined);
    const total = measured.reduce((s, a) => s + (a.value ?? 0), 0);
    const baseline = bet.baseline ?? 0;
    const observedLift = +(total - baseline).toFixed(3);
    const everUnindexed = assets.length > 0 && assets.every((a) => a.indexed === false);
    let verdict: BetVerdict;
    let note: string;
    if (!assets.length) {
      verdict = 'no_signal';
      note = 'The bet shipped nothing — no assets were recorded, so there is nothing to measure.';
    } else if (!measured.length) {
      verdict = 'no_signal';
      note = `${assets.length} asset${assets.length === 1 ? '' : 's'} shipped but none carries a measurement, so the window closed untested.`;
    } else if (everUnindexed) {
      verdict = 'no_signal';
      note = `None of the ${assets.length} assets is indexed, so the hypothesis was never actually put in front of anyone.`;
    } else if (bet.expectedLift === undefined) {
      // No prediction to test against: report the movement, claim nothing about it.
      verdict = observedLift > 0 ? 'met' : 'short';
      note = `No expected lift was set, so this is the measured movement only: ${observedLift >= 0 ? '+' : ''}${observedLift} across ${measured.length} of ${assets.length} assets.`;
    } else {
      const bar = bet.expectedLift * MET_FRACTION;
      verdict = observedLift >= bar ? 'met' : 'short';
      note = `${observedLift >= 0 ? '+' : ''}${observedLift} measured across ${measured.length} of ${assets.length} assets, against ${bet.expectedLift} expected `
        + `(${Math.round(MET_FRACTION * 100)}% of it, ${+bar.toFixed(3)}, is the bar). Baseline was ${baseline}.`;
    }
    this.db
      .prepare("UPDATE bets SET state = 'judging', observed_lift = ?, verdict = ?, verdict_note = ?, updated_at = ? WHERE id = ?")
      .run(observedLift, verdict, note, now, id);
    return { bet: this.get(id)!, verdict, observedLift, baseline, expected: bet.expectedLift, measured: measured.length, assets: assets.length, note };
  }

  /** Bets linked to a task, and the reverse — the pointer that keeps work attributable. */
  linkTask(taskId: string, betId: string | null): void {
    this.db.prepare('UPDATE tasks SET bet_id = ? WHERE id = ?').run(betId, taskId);
  }

  counts(tenant: string, goalId?: string): Record<string, number> {
    const rows = goalId
      ? this.db.prepare('SELECT state, COUNT(*) AS n FROM bets WHERE tenant = ? AND goal_id = ? GROUP BY state').all<{ state: string; n: number }>(tenant, goalId)
      : this.db.prepare('SELECT state, COUNT(*) AS n FROM bets WHERE tenant = ? GROUP BY state').all<{ state: string; n: number }>(tenant);
    return Object.fromEntries(rows.map((r) => [r.state, r.n]));
  }
}
