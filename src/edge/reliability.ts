/**
 * The RELIABILITY MONITOR — the online, behavioural-failure counterpart to Dreaming's offline
 * reflection (docs/decision-brief-layer-plan.md §8). Where Policy governs a single effect, this watches
 * a RUN for failure PATTERNS across effects. Two detectors ship today:
 *
 *  - **loop** — the same action repeated over and over in a short window, making no progress.
 *  - **detached-work** — a shell command that backgrounds a job whose cleanup can never run.
 *
 * Both return an advisory NOTE, delivered to the agent as an `instruct` — an ALLOW that also injects the
 * note into the model's next context (via the PreToolUse hook's `additionalContext`, the one channel
 * verified to reach the model — §8a). It is a NUDGE, not a control: the model can, and sometimes should,
 * ignore it; anything that must actually stop an effect stays on deny/approve. Notes are framed as
 * legitimate, branded, purpose-explained advisory copy — NOT a coercive "you MUST" override, which the
 * spike showed the model correctly flags as prompt-injection (§8a).
 *
 * The detectors sit HERE and not in `terminal/gate-hook.sh` on purpose: the hook is dumb transport
 * (governance PR #2) — it routes a tool to a capability and ships the input, and every riskiness judgement
 * is made server-side. A shell-shape regex in the hook would put classification back in bash, where it
 * could not be tested and would drift per runtime.
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

/** A backgrounded job whose cleanup cannot survive the tool call ending, and the note to inject. */
export interface DetachedWorkSignal {
  kind: 'detached-work';
  /** `cleanup` = an explicit kill that only runs on the happy path; `spin` = an unbounded busy loop. */
  reason: 'cleanup' | 'spin';
  note: string;
}

export type ReliabilitySignal = LoopSignal | DetachedWorkSignal;

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

/**
 * DETACHED BACKGROUND WORK — the shape that took a live box to load 29 on 12 cores (2026-08-20).
 *
 * An agent shook out a flaky test under deliberate CPU contention:
 *   `(for i in $(seq 1 24); do (while :; do :; done) & done; go test …; jobs -p | xargs kill)`
 * The tool call died (timeout/reap) before the trailing `kill`, so 24 spinner subshells were reparented
 * to init and burned ~30% CPU each for a day and a half. `ProcessJanitor` now reaps that class, but the
 * cleanest fix is upstream: the command itself should have been crash-safe.
 *
 * The rule is deliberately narrow, because a nagging steer is a steer the model learns to ignore. All
 * three must hold:
 *   1. the command backgrounds a job (a bare `&`, not `&&` / `2>&1` / `&>`),
 *   2. it has NO `trap` — an author who wrote one has already solved this,
 *   3. AND it either kills its own jobs on the happy path (`kill %1`, `kill $!`, `jobs -p | xargs kill`)
 *      or spawns an unbounded busy loop (`while :; do :; done` with no `sleep` in the body).
 *
 * Clause 3 is what keeps this quiet on the common, legitimate `npm run dev &`: no self-cleanup and no
 * spin means nothing was promised that the tool call's death could break. Clause 3's first arm is the
 * strongest signal we can get — the author has ALREADY decided these processes must not outlive the
 * command, and has written the one form of cleanup that a killed shell skips.
 */
const BACKGROUNDS = /[^&>|]&(?![&>])/;
const HAS_TRAP = /\btrap\b/;
const SELF_KILL = /\bkill\s+(?:-\w+\s+)*(?:%|\$!)|\bjobs\s+-p\b[\s\S]*?\bkill\b/;
/** `while :`/`while true` whose body never sleeps — a hot spin rather than a poll. */
const SPIN = /\bwhile\s+(?::|true)\s*;?\s*do\b((?:(?!\bdone\b)[\s\S]){0,200}?)\bdone\b/;

function detectDetachedWork(command: string): DetachedWorkSignal | undefined {
  if (!BACKGROUNDS.test(command) || HAS_TRAP.test(command)) return undefined;
  const spin = SPIN.exec(command);
  const spins = !!spin && !/\bsleep\b/.test(spin[1]);
  if (!spins && !SELF_KILL.test(command)) return undefined;
  const reason = spins ? 'spin' : 'cleanup';
  return { kind: 'detached-work', reason, note: detachedNote(reason) };
}

/** Same advisory framing as the loop note: names what was observed, why it matters here, and the one
 *  concrete change that fixes it. No imperative, no threat — the model is free to decide it's fine. */
function detachedNote(reason: 'cleanup' | 'spin'): string {
  const observed = reason === 'spin'
    ? 'this command backgrounds an unbounded busy loop (a `while` with no `sleep`)'
    : 'this command backgrounds a job and then cleans it up with a `kill` on the last line';
  return (
    `Agentric reliability monitor: ${observed}, and there's no \`trap\`. Worth knowing on this box — ` +
    `if the tool call ends early (timeout, or the turn being reaped) the cleanup line never runs, the ` +
    `background jobs are reparented to init, and nothing you can reach afterwards will stop them. That ` +
    `exact shape left 24 spinners burning a core each for a day and a half here on 2026-08-20. Adding ` +
    `\`trap 'kill 0' EXIT;\` at the front of the command makes the cleanup survive any exit path, ` +
    `including being killed. If these processes are meant to outlive the command, ignore this.`
  );
}

/** Branded, advisory, non-coercive — the framing the spike (§8a) showed the model heeds rather than
 *  flags as injection. No imperatives, no tokens; explains the observation and offers a way out. */
function loopNote(count: number, headline: string): string {
  return (
    `Agentric reliability monitor: this is about the ${count}× near-identical action in a short ` +
    `window (“${headline}”) with no apparent progress — a possible loop. If you're stuck, it ` +
    `usually helps to pause and try a different approach, or use the \`ask\` tool to reach a human, ` +
    `rather than repeating the same step.`
  );
}

export class ReliabilityMonitor {
  private readonly sessions = new Map<string, Map<string, { count: number; lastTs: number; nudgedAt: number }>>();
  /** Command shapes already steered on, per session — the detached-work note fires once per shape. */
  private readonly steered = new Map<string, Set<string>>();
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
  observe(sessionId: string, capability: string, args: Record<string, unknown>, headline: string, now: number): ReliabilitySignal | undefined {
    const key = loopKey(capability, args);
    if (!key) return undefined;
    // Shape check first: it is about THIS command, so unlike the loop streak it is worth saying on the
    // very first occurrence — by the fifth repeat the orphans are already spun up. Deduped per session by
    // the normalised key, so a retried command steers once rather than every attempt.
    const detached = this.detached(sessionId, capability, args, key);
    if (detached) return detached;
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

  /** The detached-work steer for a shell command, at most once per session per command shape. */
  private detached(sessionId: string, capability: string, args: Record<string, unknown>, key: string): DetachedWorkSignal | undefined {
    if (capability !== 'shell.exec') return undefined;
    const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : args;
    const command = typeof args.command === 'string' ? args.command : typeof input.command === 'string' ? input.command : '';
    if (!command) return undefined;
    const sig = detectDetachedWork(command);
    if (!sig) return undefined;
    let seen = this.steered.get(sessionId);
    if (!seen) { seen = new Set(); this.steered.set(sessionId, seen); }
    if (seen.has(key)) return undefined;
    seen.add(key);
    return sig;
  }

  /** Drop a session's streak state when its run ends. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.steered.delete(sessionId);
  }
}
