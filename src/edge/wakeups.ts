/**
 * The agent WAKE QUEUE — one durable place where "something this agent was waiting on has happened"
 * turns into a delivered message.
 *
 * ## Why this exists
 *
 * The completion poke used to decide, INLINE at fire time, how to reach the caller: type into its pane,
 * or `--resume` its transcript in a new run. Four bugs came out of that one decision, each the same
 * shape — the lane was chosen from whichever liveness question the author happened to ask:
 *
 *  - v0.307.0 — it hung off a task transition the delegate had to volunteer, so a delegate that died
 *    without `task_update` stranded 14% of hand-offs (fixed with a lifecycle sweep, which then became a
 *    SECOND caller of the same inline decision).
 *  - v0.334.1 — the lane was chosen on the row's `status`, which is not liveness; a caller that had
 *    `report`ed was read as dead and got a second claude on a transcript the first still held.
 *  - v0.334.2 — `isAlive` (status-folding) vs `reachable` (the pane): all ten call sites were wrong.
 *  - v0.354.1 — liveness was asked of the caller's TRANSCRIPT, never of the AGENT, so a poke resumed a
 *    2-day-old conversation while that agent was mid-run under another one. Both runs then worked the
 *    same support ticket (northwind, `check-resolve-tickets`, 2026-08-16).
 *
 * Each fix was correct and none of them fixed the class, because the class is "delivery is a decision
 * made once, in the dark, with no memory". So: **producers enqueue, one deliverer decides.**
 *
 * ## The contract
 *
 *  - **Enqueue is durable.** A wake-up is a row. If it cannot be delivered now it stays `pending` and the
 *    scheduler retries it — nothing is dropped because the destination was momentarily unreachable.
 *  - **Delivery is per AGENT, never per transcript.** All of an agent's sessions run out of ONE workspace
 *    folder, so the queue serialises on the agent: at most one claude per agent comes out of a wake-up.
 *  - **One priority order, in one function** ({@link WakeupQueue.deliver}):
 *      1. a live session on the wake-up's OWN transcript — the caller continues its own plan;
 *      2. any other live session of that agent — the message carries the task id, title and the
 *         delegate's note, so it needs no transcript context, and it beats starting a rival claude;
 *      3. nothing of this agent is live → `--resume` the transcript in a fresh `poke:` run.
 *  - **Pending wake-ups for one agent COALESCE.** Three delegates finishing while the caller is down wake
 *    it once, with all three results, instead of racing three resumes onto one transcript.
 *  - **Immediate, not tick-latent.** {@link WakeupQueue.enqueue} attempts delivery synchronously; the tick
 *    is the retry, not the schedule. A poke still lands in the same second it fires.
 *  - **Failure is visible.** After {@link MAX_ATTEMPTS} tries (or {@link MAX_AGE_MS}) a wake-up expires
 *    with an inbox card to the human who owns the run — a queue that silently drops is the bug we started
 *    from wearing a different hat.
 *
 * Deliberate difference from the v0.354.1 stopgap: when an inject into a SIBLING session fails, the
 * wake-up stays pending for the next tick instead of falling through to a resume. The fall-through was
 * only there because there was nowhere to keep the message; now there is, and "late" beats "a second
 * claude in a live workspace".
 */
import { newId } from '../id';
import { AgentOS } from '../kernel';
import { Db } from '../state/db';
import { TerminalManager } from '../terminal';

/** How many delivery attempts before a wake-up is given up on (and surfaced to a human). */
export const MAX_ATTEMPTS = 5;
/** How old a pending wake-up may get before it expires, whatever its attempt count. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Most agents woken in one sweep — bounds a backlog's blast radius on any single tick. */
export const MAX_AGENTS_PER_SWEEP = 10;

export interface WakeupInput {
  /** Caller agent id (bare, no `agent:` prefix). */
  agent: string;
  /** The caller's pinned claude transcript — the resume target of last resort. */
  transcript: string;
  /** Member the run acts as (identity passthrough from the hand-off). */
  runAs?: string;
  /** The message the agent will read. Must stand on its own: a sibling session has no shared context. */
  message: string;
  /** What woke it — a task id today. `(agent, source, kind)` is the dedupe key. */
  source: string;
  /** Wake-up class; today only `poke`. Kept so a future "your approval landed" wake reuses the queue. */
  kind?: string;
  /** Session title for the resume lane. */
  title?: string;
}

export type WakeupDelivery =
  | { ok: true; sessionId: string; tmux: string; via: 'inject' | 'inject-sibling' | 'resume' }
  | { ok: false; reason: string; queued: boolean };

interface Row {
  id: string;
  agent: string;
  source: string;
  kind: string;
  transcript: string;
  run_as: string | null;
  title: string | null;
  message: string;
  attempts: number;
  created_at: number;
}

export class WakeupQueue {
  constructor(private os: AgentOS, private tm: TerminalManager, private db: Db) {}

  /**
   * Record a wake-up and try to deliver it right now. Re-enqueuing the same `(agent, source, kind)` while
   * one is still pending REPLACES its message rather than stacking a second — a delegate that flips
   * done→blocked→done should wake its caller once, with the latest truth.
   */
  enqueue(input: WakeupInput, opts: { budget?: number } = {}): WakeupDelivery {
    const agent = input.agent.startsWith('agent:') ? input.agent.slice('agent:'.length) : input.agent;
    if (!this.os.agents.has(agent)) return { ok: false, reason: `unknown caller agent: ${agent}`, queued: false };
    if (!input.transcript) return { ok: false, reason: 'no caller transcript to resume', queued: false };
    const kind = input.kind ?? 'poke';
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT id FROM agent_wakeups WHERE agent = ? AND source = ? AND kind = ? AND status = 'pending'")
      .get<{ id: string }>(agent, input.source, kind);
    if (existing) {
      this.db
        .prepare('UPDATE agent_wakeups SET message = ?, title = ?, transcript = ?, run_as = ?, updated_at = ? WHERE id = ?')
        .run(input.message, input.title ?? null, input.transcript, input.runAs ?? null, now, existing.id);
    } else {
      this.db
        .prepare(`INSERT INTO agent_wakeups (id, tenant, agent, source, kind, transcript, run_as, title, message, status, attempts, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,'pending',0,?,?)`)
        .run(newId('wakeup'), this.os.tenant, agent, input.source, kind, input.transcript, input.runAs ?? null, input.title ?? null, input.message, now, now);
    }
    return this.deliver(agent, opts);
  }

  /**
   * Deliver every pending wake-up for ONE agent, coalesced, down the highest-priority reachable lane.
   * Undelivered work stays pending (attempts bumped) — never dropped, never doubled.
   */
  deliver(agentId: string, opts: { budget?: number } = {}): WakeupDelivery {
    const pending = this.pending(agentId);
    if (!pending.length) return { ok: false, reason: 'nothing pending', queued: false };
    const newest = pending[pending.length - 1];
    const message = this.coalesce(pending);
    const principal = newest.run_as ? `member:${newest.run_as}` : 'system';

    // Lane 1 + 2 — a live pane. Prefer one bound to a pending wake-up's own transcript (the caller
    // continues its own plan); otherwise any live session of this agent. Liveness is `reachable` (the
    // PANE), never the row's `status`: a session that called `report` still has the REPL we type into.
    const transcripts = new Set(pending.map((p) => p.transcript));
    const live = this.db
      .prepare('SELECT id, tmux, claude_session_id AS cs FROM term_sessions WHERE agent = ? ORDER BY created_at DESC LIMIT 50')
      .all<{ id: string; tmux: string; cs: string | null }>(agentId)
      .filter((r) => this.tm.reachable(r.id));
    const own = live.find((r) => r.cs && transcripts.has(r.cs));
    const dest = own ?? live[0];
    if (dest) {
      const via = own ? 'inject' : 'inject-sibling';
      const injected = this.tm.injectToSession(dest.id, message, true, principal);
      this.audit(dest.id, agentId, pending, { via, ok: injected.ok, principal });
      if (injected.ok) {
        this.settle(pending, 'delivered', via, dest.id);
        return { ok: true, sessionId: dest.id, tmux: dest.tmux, via };
      }
      this.bump(pending);
      // A wedged pane on the wake-up's OWN transcript is a dead end — that conversation can only be
      // continued by resuming it, so end the wedged run first (exactly as `chatSend` does) and fall
      // through. A wedged SIBLING is someone else's live work: leave it alone and retry next tick.
      if (own) this.tm.stopSession(dest.id, 'system');
      else return { ok: false, reason: 'sibling session did not accept the wake-up — queued for retry', queued: true };
    }

    // Lane 3 — nothing of this agent is live. Resume the transcript in a fresh `poke:` run. One session
    // for ALL pending wake-ups: they were coalesced above, so N completions cost one claude, not N.
    if (opts.budget !== undefined && opts.budget <= 0) {
      this.bump(pending);
      return { ok: false, reason: 'at the concurrency cap — queued for the next tick', queued: true };
    }
    const s = this.tm.createSession(
      agentId,
      newest.title ?? `Poke ← ${newest.source}`,
      message,
      `poke:${newest.source}`,
      true,
      undefined,
      undefined,
      newest.run_as ?? undefined,
      newest.transcript,
    );
    this.audit(s.id, agentId, pending, { via: 'resume', ok: true, principal });
    this.settle(pending, 'delivered', 'resume', s.id);
    return { ok: true, sessionId: s.id, tmux: s.tmux, via: 'resume' };
  }

  /**
   * The scheduler pass: retry every agent with pending wake-ups, and expire the ones that have run out of
   * road. `budget` is the whole-box concurrency headroom — the resume lane spends it, the inject lanes
   * don't. Returns how many resume sessions were spawned so the tick can debit its own budget.
   */
  sweep(budget: number = Infinity): number {
    let spawned = 0;
    try {
      this.expire();
      const agents = this.db
        .prepare("SELECT DISTINCT agent FROM agent_wakeups WHERE status = 'pending' ORDER BY agent LIMIT ?")
        .all<{ agent: string }>(MAX_AGENTS_PER_SWEEP)
        .map((r) => r.agent);
      for (const agent of agents) {
        const r = this.deliver(agent, { budget: budget - spawned });
        if (r.ok && r.via === 'resume') spawned++;
      }
    } catch {
      // never let the wake queue take down the automation scheduler
    }
    return spawned;
  }

  /** Pending wake-ups for an agent, oldest first. */
  pending(agentId: string): Row[] {
    return this.db
      .prepare("SELECT id, agent, source, kind, transcript, run_as, title, message, attempts, created_at FROM agent_wakeups WHERE agent = ? AND status = 'pending' ORDER BY created_at ASC")
      .all<Row>(agentId);
  }

  /**
   * One message from N wake-ups. A single wake reads exactly as it always did (no wrapper, so an agent's
   * prompt-matching on "Really done" keeps working); several get a header that says how many, because an
   * agent woken with three results must not act on only the first.
   */
  private coalesce(rows: Row[]): string {
    if (rows.length === 1) return rows[0].message;
    return `You have ${rows.length} updates waiting on work you handed off — all of them, in order:\n\n` +
      rows.map((r, i) => `— ${i + 1} of ${rows.length} —\n${r.message}`).join('\n\n') +
      `\n\nHandle every one of them before you pick your own work back up.`;
  }

  private settle(rows: Row[], status: 'delivered' | 'expired', via: string, sessionId: string | null): void {
    const now = Date.now();
    for (const r of rows) {
      this.db
        .prepare('UPDATE agent_wakeups SET status = ?, delivered_via = ?, delivered_session = ?, updated_at = ? WHERE id = ?')
        .run(status, via, sessionId, now, r.id);
    }
  }

  private bump(rows: Row[]): void {
    const now = Date.now();
    for (const r of rows) this.db.prepare('UPDATE agent_wakeups SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now, r.id);
  }

  /**
   * Give up on wake-ups that have exhausted their attempts or aged out — and TELL SOMEONE. A queue whose
   * failure mode is a silent row is the same silence this whole plane was built to end, so each one posts
   * an inbox card to the run's owner with the message that never landed.
   */
  private expire(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    const dead = this.db
      .prepare("SELECT id, agent, source, kind, transcript, run_as, title, message, attempts, created_at FROM agent_wakeups WHERE status = 'pending' AND (attempts >= ? OR created_at < ?)")
      .all<Row>(MAX_ATTEMPTS, cutoff);
    for (const r of dead) {
      this.settle([r], 'expired', 'none', null);
      this.os.audit.append({
        ts: Date.now(),
        runId: '-',
        tenant: this.os.tenant,
        principal: 'system',
        type: 'agent.wakeup.expired',
        data: { agent: r.agent, source: r.source, kind: r.kind, attempts: r.attempts },
      });
      try {
        this.tm.postWakeupExpired(r.agent, r.source, r.run_as ?? null, r.message);
      } catch {
        // the card is the courtesy; the audit event above is the record
      }
    }
  }

  private audit(runId: string, agent: string, rows: Row[], d: { via: string; ok: boolean; principal: string }): void {
    this.os.audit.append({
      ts: Date.now(),
      runId,
      tenant: this.os.tenant,
      principal: d.principal,
      // Unchanged event type: `agent.poked` is what every dashboard, doc and test in the fleet reads.
      type: 'agent.poked',
      data: {
        caller: agent,
        source: rows[rows.length - 1].source,
        sources: rows.length > 1 ? rows.map((r) => r.source) : undefined,
        runAs: rows[rows.length - 1].run_as ?? null,
        via: d.via,
        transcript: rows[rows.length - 1].transcript,
        ok: d.ok,
      },
    });
  }
}
