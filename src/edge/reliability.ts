/**
 * The RELIABILITY MONITOR — the online, behavioural-failure counterpart to Dreaming's offline
 * reflection (docs/decision-brief-layer-plan.md §8). Where Policy governs a single effect, this watches
 * a RUN for failure PATTERNS across effects. Phase 3 ships the first, most unambiguous detector: a
 * no-progress LOOP — the same action repeated over and over in a short window.
 *
 * On a loop it returns an advisory NOTE, delivered to the agent as an `instruct` — an ALLOW that also
 * injects the note into the model's next context (via the PreToolUse hook's `additionalContext`, the one
 * channel verified to reach the model — §8a). It is a NUDGE, not a control: the model can, and sometimes
 * should, ignore it; anything that must actually stop an effect stays on deny/approve. The note is framed
 * as legitimate, branded, purpose-explained advisory copy — NOT a coercive "you MUST" override, which the
 * spike showed the model correctly flags as prompt-injection (§8a).
 *
 * State is in-memory per session (like the approval waiters) — it does not survive a restart, which is
 * fine: a loop that matters will re-form. `forget()` drops a session's history when its run ends.
 */

/** A detected no-progress loop and the advisory note to inject. */
export interface LoopSignal {
  kind: 'loop';
  count: number;
  note: string;
}

export interface ReliabilityOptions {
  /** Repeats within this window count toward a loop; a longer gap resets the streak. Default 5 min. */
  windowMs?: number;
  /** Nudge once the same action has repeated this many times in-window. Default 5. */
  threshold?: number;
  /** After nudging, stay quiet until this many further repeats accrue (avoids nagging). Default 5. */
  renudge?: number;
}

/** Normalise a shell command / connector input into a loop key: same action → same key, so a genuine
 *  retry loop collapses while distinct work stays distinct. We lowercase, collapse whitespace, and
 *  replace digit runs with `#` so volatile bits (a `?v=$RANDOM` cache-buster, a timestamp, a pid) don't
 *  make two otherwise-identical calls look different. Deliberately coarse on digits — a poll of the same
 *  URL and a retry of the same command are exactly what we want to catch. */
function loopKey(capability: string, args: Record<string, unknown>): string {
  const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : args;
  let payload = '';
  const command = typeof args.command === 'string' ? args.command : typeof input.command === 'string' ? input.command : '';
  if (command) payload = command;
  else if (typeof args.tool === 'string') {
    // A connector call: the tool name + its input (minus the human `description`) identifies the action.
    const { description: _d, ...rest } = input as Record<string, unknown> & { description?: unknown };
    payload = `${args.tool} ${JSON.stringify(rest)}`;
  } else return '';
  const norm = payload.toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim();
  return norm ? `${capability}|${norm}` : '';
}

/** Branded, advisory, non-coercive — the framing the spike (§8a) showed the model heeds rather than
 *  flags as injection. No imperatives, no tokens; explains the observation and offers a way out. */
function loopNote(count: number, headline: string): string {
  return (
    `Agent OS reliability monitor: this is about the ${count}× near-identical action in a short ` +
    `window (“${headline}”) with no apparent progress — a possible loop. If you're stuck, it ` +
    `usually helps to pause and try a different approach, or use the \`ask\` tool to reach a human, ` +
    `rather than repeating the same step.`
  );
}

export class ReliabilityMonitor {
  private readonly sessions = new Map<string, Map<string, { count: number; lastTs: number; nudgedAt: number }>>();
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly renudge: number;

  constructor(opts: ReliabilityOptions = {}) {
    this.windowMs = opts.windowMs ?? 5 * 60_000;
    this.threshold = opts.threshold ?? 5;
    this.renudge = opts.renudge ?? 5;
  }

  /**
   * Record an ALLOWED effect and, if it completes a no-progress loop, return the nudge. Call only on the
   * allow path (an approve/deny already interrupts the run). Pure aside from the in-memory streak state.
   */
  observe(sessionId: string, capability: string, args: Record<string, unknown>, headline: string, now: number): LoopSignal | undefined {
    const key = loopKey(capability, args);
    if (!key) return undefined;
    let m = this.sessions.get(sessionId);
    if (!m) { m = new Map(); this.sessions.set(sessionId, m); }
    const prev = m.get(key);
    const inWindow = prev && now - prev.lastTs <= this.windowMs;
    const count = inWindow ? prev!.count + 1 : 1;
    const nudgedAt = inWindow ? prev!.nudgedAt : 0;
    if (count >= this.threshold && (nudgedAt === 0 || count - nudgedAt >= this.renudge)) {
      m.set(key, { count, lastTs: now, nudgedAt: count });
      return { kind: 'loop', count, note: loopNote(count, headline) };
    }
    m.set(key, { count, lastTs: now, nudgedAt });
    return undefined;
  }

  /** Drop a session's streak state when its run ends. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
