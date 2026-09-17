/**
 * DRIFT — "is this run still doing what it was asked to do?"
 *
 * The reliability monitor (`reliability.ts`) and the progress verdict (`session-progress.ts`) both judge
 * the SHAPE of a run: the same action repeated (`circling`), nothing happening (`stuck`). A rabbit hole
 * has neither shape. It is busy, varied, apparently productive work on the wrong thing — a side-bug, a
 * refactor nobody asked for, an investigation three levels below what the ask needed — and it reads as
 * `forward` on every shape signal we have. Catching it means comparing CONTENT against the ask, which is
 * a language judgement, so it takes a model.
 *
 * Three parts, each deliberately separate:
 *
 *  1. **A cheap deterministic trigger** ({@link DriftMonitor.observe}). The judge only runs once a run has
 *     done enough to wander — {@link DRIFT_FIRST_CHECK_ACTIONS} top-level allowed actions, then every
 *     {@link DRIFT_EVERY_ACTIONS} more, never more often than {@link DRIFT_MIN_INTERVAL_MS}. A short run
 *     never pays for a judgement.
 *  2. **A Haiku judge** ({@link judgeDrift}), run OUT OF BAND — never awaited inside the gate, which is on
 *     every tool call's hot path. It sees the ask, any later human redirections, and the recent tail of
 *     the transcript. The agent never grades itself: an agent in a rabbit hole believes it is progressing
 *     (same rule as the progress verdict).
 *  3. **Advisory delivery.** A `drifted` verdict parks a note that rides out on the run's NEXT allowed
 *     tool call as an `instruct` (allow + `additionalContext` — the one channel verified to reach the
 *     model mid-turn). The copy is branded, explains what was observed, and offers the constructive
 *     move — park the tangent as a task and return — rather than an order; coercive wording is flagged by
 *     the model as prompt injection (docs/decision-brief-layer-plan.md §8a). If a later check still says
 *     `drifted`, the run is escalated ONCE to a human. Drift never stops a run: the judge can be wrong, and
 *     hard stops stay on budget/approvals/`stopSession`.
 *
 * State is in-memory per session, like the loop detector: a restart forgets it, and a run that is still
 * drifting simply re-forms the verdict at the next check.
 */
import { chatComplete, LlmConfig } from './llm';
import { runClaudePrompt, classify, SummaryFailure } from './summarize';
import type { Conversation } from './conversation';

/** `off` — no judging. `observe` — judge + record the verdict (progress strip, audit) but never nudge the
 *  agent or post a card: the bake-in mode. `nudge` — the full loop. */
export type DriftMode = 'off' | 'observe' | 'nudge';
export const DRIFT_MODES: readonly DriftMode[] = ['off', 'observe', 'nudge'];

export type DriftVerdict = 'on_track' | 'supporting' | 'drifted';

export interface DriftJudgement {
  verdict: DriftVerdict;
  /** The judge's own 0..1 confidence. NOT calibrated (Haiku's self-reported number) — used only as a
   *  floor that throws out the judge's own shrugs, never as a probability. */
  confidence: number;
  /** A few words on what the recent work is actually about. */
  tangent: string;
  /** One sentence of evidence. */
  reason: string;
}

/** No judgement before a run has taken this many top-level allowed actions. */
export const DRIFT_FIRST_CHECK_ACTIONS = 20;
/** Then one judgement per this many further actions … */
export const DRIFT_EVERY_ACTIONS = 20;
/** … and never more often than this. */
export const DRIFT_MIN_INTERVAL_MS = 8 * 60_000;
/** A `drifted` vote below this self-reported confidence is recorded but not acted on. 0.8, not 0.7: on the
 *  live replay (2026-09-17, 90 checkpoints across 30 long instapods sessions) the two genuine rabbit holes
 *  confirmed at 0.90 and 0.95, and the one confirmed false positive at 0.75. Two hits is a small sample —
 *  re-derive this from `drift.judged` audit rows once a tenant has run in `observe` for a while. */
export const DRIFT_MIN_CONFIDENCE = 0.8;
/** Consecutive judge failures after which a session stops being judged (no key, CLI missing, quota). */
export const DRIFT_MAX_FAILURES = 3;
/** A `drifted` verdict this recent still shows as `drifting` on the progress strip. Longer than two check
 *  intervals so the strip doesn't flicker back to `forward` between checks of a run that is still off. */
export const DRIFT_WINDOW_MS = 30 * 60_000;

/** What recording a judgement means for the caller. */
export type DriftOutcome =
  /** Not drifting (and wasn't). */
  | 'none'
  /** First drifted verdict of a streak — nudge the agent. */
  | 'detected'
  /** Still drifted after a nudge — tell a human (once per streak). */
  | 'escalated'
  /** Still drifted, human already told — record only. */
  | 'persisting'
  /** A drifted streak ended: the run came back to the ask (or a human redirected it). */
  | 'cleared';

interface SessionDriftState {
  actions: number;
  lastCheckActions: number;
  lastCheckAt: number;
  inflight: boolean;
  failures: number;
  streak: number;
  escalated: boolean;
  pendingNote?: string;
}

export class DriftMonitor {
  private readonly sessions = new Map<string, SessionDriftState>();

  private state(sessionId: string): SessionDriftState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { actions: 0, lastCheckActions: 0, lastCheckAt: 0, inflight: false, failures: 0, streak: 0, escalated: false };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Count one allowed top-level action. Returns true when a judgement is due NOW — the caller then runs
   *  the judge out of band and reports back via {@link record} or {@link abort}. At most one judgement is
   *  in flight per session. */
  observe(sessionId: string, now: number): boolean {
    const s = this.state(sessionId);
    s.actions++;
    if (s.inflight || s.failures >= DRIFT_MAX_FAILURES) return false;
    const due = s.lastCheckAt === 0
      ? s.actions >= DRIFT_FIRST_CHECK_ACTIONS
      : s.actions - s.lastCheckActions >= DRIFT_EVERY_ACTIONS && now - s.lastCheckAt >= DRIFT_MIN_INTERVAL_MS;
    if (!due) return false;
    s.inflight = true;
    s.lastCheckAt = now;
    s.lastCheckActions = s.actions;
    return true;
  }

  /** The judge could not run (or had nothing to read). Frees the slot; the interval still applies, so a
   *  failing backend is retried at the normal cadence, and given up on after {@link DRIFT_MAX_FAILURES}. */
  abort(sessionId: string, failed = true): void {
    const s = this.state(sessionId);
    s.inflight = false;
    if (failed) s.failures++;
  }

  /** Fold a judgement into the session's streak. `note` is the advisory text to park for the next tool
   *  call when the outcome warrants a nudge (pass undefined in `observe` mode). */
  record(sessionId: string, j: DriftJudgement, note?: string): DriftOutcome {
    const s = this.state(sessionId);
    s.inflight = false;
    s.failures = 0;
    const drifted = j.verdict === 'drifted' && j.confidence >= DRIFT_MIN_CONFIDENCE;
    if (!drifted) {
      if (s.streak === 0) return 'none';
      s.streak = 0;
      s.escalated = false;
      s.pendingNote = undefined;
      return 'cleared';
    }
    s.streak++;
    if (s.streak === 1) {
      s.pendingNote = note;
      return 'detected';
    }
    if (!s.escalated) {
      s.escalated = true;
      s.pendingNote = note; // one more nudge alongside the human being told
      return 'escalated';
    }
    return 'persisting';
  }

  /** Take (and clear) the parked note, if any. */
  takeNote(sessionId: string): string | undefined {
    const s = this.sessions.get(sessionId);
    const note = s?.pendingNote;
    if (s) s.pendingNote = undefined;
    return note;
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

// ─── The judge ──────────────────────────────────────────────────────────────────────────────────────

/** Char budgets for the judge's input. The tail matters most — that's where a rabbit hole lives. */
const ASK_CAP = 2500;
const RECENT_CAP = 9000;
const RECENT_TURNS = 60;

export const DRIFT_SYSTEM = [
  "You check whether an autonomous agent's recent work still serves the task it was given.",
  'You get the ORIGINAL REQUEST, any LATER HUMAN MESSAGES (each shown with the agent message it replied to), and the RECENT WORK: the agent\'s own messages plus a "·" log of the tools it used.',
  '',
  'First work out the CURRENT ASK: the original request as amended by every later human message. A human who redirected the agent, approved a proposal, or asked for more has changed the ask — the original request may be long superseded.',
  '',
  'Then classify the RECENT WORK against the CURRENT ASK:',
  '- "on_track": it is directly doing the ask.',
  '- "supporting": not literally named in the ask, but plausibly needed to get the ask done — finding a root cause, setting up or repairing the environment, unblocking a failing step, verifying the result, reading context. Give the benefit of the doubt here.',
  '- "drifted": it is pursuing something the ask does not need — an unrelated bug or system, a refactor or cleanup nobody asked for, polishing far beyond the ask, or digging into a sub-problem well past what the ask requires.',
  '',
  'Rules:',
  '- Anything a human asked for or agreed to is NEVER drift. A short human reply ("go", "yes", "merge both", "build and ship") approves whatever the agent proposed just before it — that proposal is shown with the reply, and it becomes part of the ask.',
  '- Handling fallout from the agent\'s own work (a deploy it shipped broke production, CI it triggered failed, a review found defects) is "supporting".',
  '- Judge the overall direction of the recent work, not one step. A single unexplained command is not drift.',
  '- Be conservative: only say "drifted" when a teammate who read the ask and the human messages would clearly say "that\'s not what you were asked to do". Many legitimate tasks take detours.',
  'Reply with ONLY a JSON object, no prose, no code fence:',
  '{"current_ask":"<=20 words","verdict":"on_track|supporting|drifted","confidence":0.0-1.0,"tangent":"<=12 words: what the recent work is about","reason":"<=25 words: the evidence"}',
].join('\n');

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
/** Keep both ends of a long message. An agent's proposal — what a following "go" / "ship it" approves —
 *  is usually its LAST paragraph, so a head-only clip cut exactly the part the reply refers to. */
const headTail = (s: string, head: number, tail: number) => (s.length > head + tail + 3 ? `${s.slice(0, head)} … ${s.slice(-tail)}` : s);

/**
 * Is this `user` turn something a PERSON typed? A transcript's user role also carries harness injections —
 * background-task notifications, a skill's body when it loads, slash-command plumbing. Found on the live
 * replay: counted as "human messages", they pushed the real redirections ("merge both", "build and ship")
 * out of the judge's view, and it called human-directed work drift.
 */
export function isHumanText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return !/^(?:<task-notification>|<system-reminder>|<command-(?:name|message|args)>|<local-command-|Base directory for this skill:|Caveat: |\[Request interrupted|\[task discussion\])/.test(t);
}

/** Drop a leading `[Image: …]` marker (a pasted screenshot) so the words the human typed are what's quoted. */
const humanWords = (text: string) => text.replace(/^\s*\[Image:[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();

/** Build the judge's user message. Null when there's nothing to judge (no ask, no transcript). */
export function buildDriftInput(ask: string, convo: Conversation): string | null {
  const askText = (ask || '').trim();
  if (!askText || !convo.found || convo.turns.length === 0) return null;
  // Real human turns after the ask (the first one IS the ask), each paired with the agent message it
  // answered: a bare "go" only means something next to the proposal it approved.
  const later: string[] = [];
  let seenAsk = false;
  let lastAgent = '';
  for (const t of convo.turns) {
    if (t.kind === 'assistant') { lastAgent = t.text; continue; }
    if (t.kind !== 'user' || !isHumanText(t.text)) continue;
    if (!seenAsk) { seenAsk = true; continue; }
    const words = humanWords(t.text) || '[sent an image]';
    later.push(lastAgent
      ? `- replying to the agent's “${headTail(lastAgent.replace(/\s+/g, ' '), 160, 440)}”, the human said: ${clip(words, 400)}`
      : `- the human said: ${clip(words, 400)}`);
  }
  const lines: string[] = [];
  for (const t of convo.turns.slice(-RECENT_TURNS)) {
    if (t.kind === 'user') { if (isHumanText(t.text)) lines.push(`HUMAN: ${clip(humanWords(t.text) || '[sent an image]', 300)}`); }
    else if (t.kind === 'assistant') lines.push(`AGENT: ${clip(t.text.replace(/\s+/g, ' '), 300)}`);
    else lines.push(`· ${t.label}${t.detail ? ` — ${clip(t.detail.replace(/\s+/g, ' '), 160)}` : ''}${t.status === 'error' ? ' [failed]' : ''}`);
  }
  let recent = lines.join('\n');
  if (recent.length > RECENT_CAP) recent = '…(earlier work truncated)\n' + recent.slice(recent.length - RECENT_CAP);
  return [
    `ORIGINAL REQUEST:\n${clip(askText, ASK_CAP)}`,
    later.length ? `LATER HUMAN MESSAGES (oldest first — these amend the request):\n${later.slice(-6).join('\n')}` : '',
    `RECENT WORK (oldest first):\n${recent}`,
  ].filter(Boolean).join('\n\n');
}

/** Parse the judge's reply. Tolerant of a code fence or stray prose around the object; null on anything
 *  that isn't a well-formed verdict (an unparseable judge must never read as "drifted"). */
export function parseDriftJudgement(text: string | null | undefined): DriftJudgement | null {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const verdict = o.verdict;
  if (verdict !== 'on_track' && verdict !== 'supporting' && verdict !== 'drifted') return null;
  const c = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence);
  const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? clip(v.trim().replace(/\s+/g, ' '), n) : '');
  return { verdict, confidence, tangent: str(o.tangent, 120), reason: str(o.reason, 240) };
}

/** Model for the judge. Haiku: the question is narrow and it runs on a timer across the whole fleet. */
export const DRIFT_MODEL = (): string => process.env.AOS_DRIFT_MODEL || 'claude-haiku-4-5';

export interface DriftJudgeResult {
  judgement: DriftJudgement | null;
  /** Every vote cast, in order (`drifted`/`on_track`/`supporting`, or `fail`). One entry unless the first
   *  vote said drifted and confirmation votes ran. */
  votes?: string[];
  via: 'api' | 'cli';
  /** Why no judgement came back, when it didn't. */
  reason?: SummaryFailure | 'unparseable';
  account?: string;
}

/**
 * Run the judge. Backend order: the tenant's own LLM config when present (an Anthropic key → the Messages
 * API, pinned to Haiku; an OpenAI-compatible endpoint → its configured model), else a throwaway
 * `claude -p --model <haiku>` on the pooled runtime credentials — the same out-of-band lane the session
 * summarizer uses, so a subscription-only box still gets a judge. Never throws.
 */
export async function judgeDrift(
  input: string,
  deps: { llm: LlmConfig | null; credentials?: Record<string, string>; account?: string; timeoutMs?: number },
): Promise<DriftJudgeResult> {
  if (deps.llm) {
    const llm: LlmConfig = deps.llm.provider === 'anthropic' ? { ...deps.llm, model: DRIFT_MODEL() } : deps.llm;
    const text = await chatComplete(llm, [{ role: 'system', content: DRIFT_SYSTEM }, { role: 'user', content: input }], { maxTokens: 200, temperature: 0, timeoutMs: deps.timeoutMs ?? 20_000 });
    const judgement = parseDriftJudgement(text);
    return { judgement, via: 'api', ...(judgement ? {} : { reason: text ? 'unparseable' : 'error' }) };
  }
  try {
    const out = await runClaudePrompt(DRIFT_SYSTEM, input, { credentials: deps.credentials, model: DRIFT_MODEL(), timeoutMs: deps.timeoutMs ?? 60_000 });
    const judgement = parseDriftJudgement(out);
    return { judgement, via: 'cli', account: deps.account, ...(judgement ? {} : { reason: out.trim() ? 'unparseable' : 'empty_output' }) };
  } catch (err) {
    return { judgement: null, via: 'cli', account: deps.account, reason: classify(err) };
  }
}

/** Extra votes cast when the first one says `drifted`. */
export const DRIFT_CONFIRM_VOTES = 2;

const isDrifted = (j: DriftJudgement | null | undefined) => !!j && j.verdict === 'drifted' && j.confidence >= DRIFT_MIN_CONFIDENCE;

/**
 * The judge as the monitor uses it: one vote, and — only when that vote says `drifted` — two more in
 * parallel, acting on the majority. Measured on the live replay (2026-09-17): the same transcript cut
 * judged twice flipped between `drifted` and `on_track` on 3 of 42 checkpoints (the CLI lane has no
 * temperature control), while the one genuine rabbit hole held on every run. A nudge interrupts a real
 * agent, so a single noisy vote is not enough; a confirmation costs two extra calls on the ~5% of
 * checks that come back drifted, and nothing on the rest.
 */
export async function judgeDriftConfirmed(
  input: string,
  deps: Parameters<typeof judgeDrift>[1],
): Promise<DriftJudgeResult> {
  const first = await judgeDrift(input, deps);
  if (!isDrifted(first.judgement)) return { ...first, votes: [first.judgement?.verdict ?? 'fail'] };
  const more = await Promise.all(Array.from({ length: DRIFT_CONFIRM_VOTES }, () => judgeDrift(input, deps)));
  const all = [first, ...more];
  const votes = all.map((r) => (r.judgement ? (isDrifted(r.judgement) ? 'drifted' : r.judgement.verdict) : 'fail'));
  const drifted = all.filter((r) => isDrifted(r.judgement));
  if (drifted.length * 2 > all.length) {
    const confidence = drifted.reduce((a, r) => a + r.judgement!.confidence, 0) / drifted.length;
    return { ...first, votes, judgement: { ...first.judgement!, confidence } };
  }
  // Not confirmed: report the first dissenting vote as the verdict (a failed vote can't overturn — if
  // every confirmation failed, 1 of 3 is still not a majority, so the run is simply not called drifting).
  const dissent = more.find((r) => r.judgement && !isDrifted(r.judgement))?.judgement;
  return { ...first, votes, judgement: dissent ?? { ...first.judgement!, verdict: 'supporting', reason: `unconfirmed: ${first.judgement!.reason}` } };
}

// ─── Copy ───────────────────────────────────────────────────────────────────────────────────────────

/** The gist of an ask for a one-line quote: first non-empty line, clipped. */
export function askGist(ask: string): string {
  const first = (ask || '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return clip(first.replace(/\s+/g, ' '), 140);
}

/** The advisory note injected into the agent. Framing is load-bearing (§8a): branded, says what was
 *  observed and why it's being mentioned, offers a constructive way out, and explicitly allows "this is
 *  needed, carry on". No imperatives, no tokens. */
export function driftNote(ask: string, j: DriftJudgement): string {
  const about = j.tangent ? `about ${j.tangent}` : 'about something other than the ask';
  return (
    `Agentric focus check: this run was asked to “${askGist(ask)}”. An independent look at your recent ` +
    `steps suggests they're ${about}${j.reason ? ` (${j.reason.replace(/\.$/, '')})` : ''}. If that work is ` +
    `genuinely needed for the ask, carry on — this is only a check-in, and the check can be wrong. If it's ` +
    `a side-finding, a good move is to record it with \`task_create\` (a human can pick it up later) and ` +
    `return to the ask, so the person waiting on this run gets what they asked for.`
  );
}

/** The one-time human escalation, for the Inbox card. */
export function driftEscalationBody(ask: string, j: DriftJudgement): string {
  return [
    `Asked: “${askGist(ask)}”`,
    `Now working on: ${j.tangent || 'something else'}${j.reason ? ` — ${j.reason}` : ''}`,
    'The agent was given a focus check and is still off the ask. Open the session to redirect it, or stop it if the tangent isn\'t worth the run.',
  ].join('\n');
}
