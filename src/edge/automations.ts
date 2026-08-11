/**
 * Automations — triggers that auto-invoke agent sessions. This is the pillar that turns the
 * console into an OS: an Automation = a trigger (cron schedule or inbound webhook) + an agent +
 * a task template. When it fires, it spawns a normal terminal session — so everything downstream
 * (Inbox task card, gate hook, approval cards, audit) just works, unattended.
 *
 * Vocabulary: an **Automation** is the user-facing object; its **trigger** is the firing condition
 * (`TriggerRef` in types.ts); the **Orchestrator** (core/orchestrator.ts) remains the internal run
 * engine. Zero-dependency cron: a minimal 5-field parser below (minute hour dom month dow).
 */
import { randomBytes } from 'crypto';
import { newId } from '../id';
import * as os from 'os';
import * as path from 'path';
import { Strategist } from './strategist';
import { AgentOS } from '../kernel';
import { Db } from '../state/db';
import { TerminalManager } from '../terminal';
import { CodingRuntimeId, isCodingRuntime, Task, TaskDiscussionDelivery, TaskTimelineEntry } from '../types';
import { chooseAgent, RouterCandidate } from './router';
import { classifyIntent, SOCIAL_REPLY } from './intent';
import { answerAsk } from './ask';
import { ensureConcierge, ensureOperator, CONCIERGE_ID, OPERATOR_ID } from './concierge';
import { sweepStrandedTasks } from './task-reconcile';

// ── minimal cron (5 fields: minute hour day-of-month month day-of-week) ──────────
// Supports: * , a-b , */n , a-b/n , lists. dow 0-7 (7 ≡ 0 = Sunday).

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid cron field "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`invalid cron step in "${part}"`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a); // "5/10" = every 10 starting at 5; bare "5" = just 5
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range in "${part}" (${min}-${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron needs 5 fields: minute hour day-of-month month day-of-week');
  const dow = parseField(parts[4], 0, 7);
  if (dow.has(7)) dow.add(0); // 7 ≡ Sunday
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow,
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  };
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes())) return false;
  if (!spec.hour.has(d.getHours())) return false;
  if (!spec.month.has(d.getMonth() + 1)) return false;
  // Standard cron semantics: if BOTH dom and dow are restricted, either may match.
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

/**
 * The next time (epoch ms) a 5-field cron expression fires at or after `from` (default now). Minute-
 * grained to match the scheduler tick, and scanned forward from the NEXT whole minute (a match in the
 * current minute has already fired or is firing). Returns null if nothing matches within ~13 months — a
 * defensive bound (a valid cron always fires within a year; an impossible combo like `0 0 30 2 *`,
 * Feb 30, never does). Cheap enough to call per-automation on a list render: worst case ≈ a year of
 * minute steps of Set lookups, and real schedules resolve in far fewer.
 */
export function nextCronRun(expr: string, from: Date = new Date()): number | null {
  const spec = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // start at the next whole minute
  const limit = d.getTime() + 400 * 86_400_000;
  for (let t = d.getTime(); t <= limit; t += 60_000) {
    if (cronMatches(spec, new Date(t))) return t;
  }
  return null;
}

/** How far back (minutes) a cron occurrence is still worth catching up. A cron fires in ONE scheduled
 *  minute; if that minute is skipped — over the concurrency cap, or the box was mid-restart/deploy — the
 *  old scheduler dropped it until the next day. The catch-up window lets `tick()` keep retrying that
 *  occurrence until headroom appears, bounded so a long outage never fires an ancient/absurdly-stale run
 *  (only the single most-recent occurrence is ever owed — no backlog replay). 2 h is generous enough to
 *  cover a deploy window and many cap-relief ticks, tight enough that a daily 09:00 report never fires in
 *  the afternoon. */
export const CRON_CATCHUP_MIN = 120;

/**
 * The most recent minute (epoch ms) at or before `from` that `spec` matches, scanned back at most
 * `windowMin` minutes; null if it didn't fire within the window. Minute-grained to match the tick. Used by
 * the scheduler to detect a cron occurrence it still owes (missed its exact minute) vs one already run —
 * combined with `lastFiredAt`, it fires at most once per occurrence.
 */
export function recentCronOccurrence(spec: CronSpec, from: Date, windowMin: number): number | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  const start = d.getTime();
  for (let i = 0; i <= windowMin; i++) {
    const t = start - i * 60_000;
    if (cronMatches(spec, new Date(t))) return t;
  }
  return null;
}

// ── the automation object ─────────────────────────────────────────────────────────

/**
 * How a fired automation runs its claude-code agent:
 *   - `headless`    — `claude -p`, runs to completion and exits (the pane dies, the session flips
 *     to idle, the pile-up guard releases). The unattended-correct default: no TUI, so the
 *     upstream interactive-scroll issues don't apply and cron re-fires cleanly.
 *   - `interactive` — a normal attachable claude TUI that stays open until closed. Good for
 *     automations you want to babysit, but a cron trigger won't re-fire while it's still running.
 */
export type ExecMode = 'interactive' | 'headless';

export interface Automation {
  id: string;
  agentId: string;
  name: string;
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord' | 'telegram' | 'clickup';
  /** How the fired session runs (interactive TUI vs headless `claude -p`). */
  mode: ExecMode;
  /** Cron expression (cron type only). */
  schedule?: string;
  /** One-shot fire time in epoch ms (`once` type only); disabled after it fires. */
  runAt?: number;
  /** Member id the fired session should act as (`once` type) — carried so a deferred task runs as the
   *  same identity that scheduled it. */
  runAs?: string;
  /** Claude session id the fired run should `--resume` (`once` type) — carried so a self-scheduled
   *  follow-up wakes up with the scheduling session's full transcript instead of a fresh one. */
  resumeClaudeId?: string;
  /** Shared key for POST /hooks/<id> (webhook type only). */
  secret?: string;
  /** Match filter. composio: the trigger slug (e.g. SLACK_DIRECT_MESSAGE_RECEIVED). slack: an event
   *  type (`app_mention`/`message`) or a channel id to scope to. '' / '*' = any event of that type. */
  filter?: string;
  /** Task template for the spawned session. Webhook payloads are appended at fire time. */
  task: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: number;
  lastFiredAt?: number;
  lastSessionId?: string;
}

interface AutomationRow {
  id: string;
  agent_id: string;
  name: string;
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord' | 'telegram' | 'clickup';
  mode: ExecMode | null;
  schedule: string | null;
  secret: string | null;
  filter: string | null;
  task: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  last_fired_at: number | null;
  last_session_id: string | null;
  run_at: number | null;
  run_as: string | null;
  resume_claude_id: string | null;
}

function toAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    agentId: r.agent_id,
    name: r.name,
    type: r.type,
    mode: r.mode === 'headless' ? 'headless' : 'interactive',
    schedule: r.schedule ?? undefined,
    secret: r.secret ?? undefined,
    filter: r.filter ?? undefined,
    task: r.task,
    enabled: !!r.enabled,
    createdBy: r.created_by ?? undefined,
    createdAt: r.created_at,
    lastFiredAt: r.last_fired_at ?? undefined,
    lastSessionId: r.last_session_id ?? undefined,
    runAt: r.run_at ?? undefined,
    runAs: r.run_as ?? undefined,
    resumeClaudeId: r.resume_claude_id ?? undefined,
  };
}

export interface AddAutomationInput {
  agentId: string;
  name: string;
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord' | 'telegram' | 'clickup';
  mode?: ExecMode;
  schedule?: string;
  /** composio: trigger slug to match. slack: event type / channel id to match. ('' / omitted = any). */
  filter?: string;
  task: string;
  createdBy?: string;
  /** Member id the fired session should act as — so a cron/webhook/etc. spawn binds THAT member's
   *  connectors/Composio (e.g. their personal ClickUp) instead of the company-only fallback. */
  runAs?: string;
}

export type FireResult =
  | { ok: true; sessionId: string; tmux: string }
  | { ok: false; reason: string };

const MAX_PAYLOAD_CHARS = 4000; // keep webhook payloads from flooding the task prompt

/** A concise, human session title from a chat message — the meaningful label for a Slack/Discord thread
 *  session (vs a generic "Chat → agent"). Strips a leading `/agent` prefix + mention tokens, collapses
 *  whitespace, and trims to ~60 chars. Falls back to "Chat → <agent>" when the message is empty. */
export function chatTitle(text: string, agentId: string): string {
  const clean = (text || '').replace(/^\s*\/[A-Za-z0-9][\w-]*\s*/, '').replace(/<@[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return `Chat → ${agentId}`;
  return clean.length > 60 ? `${clean.slice(0, 59).trimEnd()}…` : clean;
}

// Bounds for agent-scheduled one-shot tasks (`type: 'once'`). A scheduled run is a time-shift of work
// the agent is already authorized to do, so it needs no fresh approval — but it is bounded so an agent
// can't schedule into the far future or pile up unbounded pending runs.
export const SCHEDULE_MIN_MS = 60_000;            // ≥ 1 minute (the scheduler tick is minute-grained)
export const SCHEDULE_MAX_MS = 30 * 86_400_000;   // ≤ 30 days out
export const SCHEDULE_MAX_PENDING = 25;           // per agent: pending (enabled, unfired) one-shots

// A task that fails to complete N times stops being auto-dispatched and is parked `blocked` for a human,
// so a broken task can't spin the scheduler forever (the Tasks analog of the automation pile-up guard).
// 4 (was 3) leaves room for the resume ladder below: fresh → resume → resume → fresh-escape → park, so the
// LAST attempt before parking is a clean slate rather than a third reload of a wedged transcript.
export const TASK_MAX_ATTEMPTS = 4;

// How many times a re-dispatch will `--resume` a task's SAME transcript before starting fresh. After this
// many resumes that didn't close the task, dispatchTask spawns a clean session (new transcript) to escape a
// poisoned/looping context; a fresh start resets the count. See dispatchTask + resumableTaskTranscript.
export const MAX_TASK_RESUMES = 2;

// Goal auto-planner (Phase 2) bounds. A "stuck" active goal (no open work) is auto-planned by the
// strategist — but only after it's sat idle past the grace window (so a just-created goal you're still
// editing isn't grabbed), no more than a few per tick, and not again within the cooldown.
const GOAL_AUTOPLAN_GRACE_MS = Number(process.env.AOS_GOAL_AUTOPLAN_GRACE_MS) || 5 * 60_000; // 5 min
const GOAL_REPLAN_COOLDOWN_MS = Number(process.env.AOS_GOAL_REPLAN_COOLDOWN_MS) || 6 * 3_600_000; // 6 h
const GOAL_AUTOPLAN_MAX_PER_TICK = Number(process.env.AOS_GOAL_AUTOPLAN_MAX_PER_TICK) || 2;

/**
 * The prompt a dispatched session runs: the task, plus the tools to close its own loop. Mirrors how the
 * KB gardener writes back what it learned — the run is self-closing, so no human has to reconcile status.
 *
 * When `goalMode` is set (a headless task WITH single-line acceptance `criteria`, on a `claude` that
 * supports `/goal`), the prompt opens with `/goal <criteria>` as line 1 — an independent evaluator then
 * drives the session across turns until the criteria hold (autonomous convergence; spiked viable, see
 * goals-plan.md §C). `task_update(done)` stays the OS system-of-record, folded into the same turn so the
 * goal clearing and the task closing are atomic; the existing attempt-ceiling/guard net covers a miss.
 *
 * The `claude` CLI hard-rejects a `/goal` condition over `GOAL_MAX_CHARS` (it errors and the run never
 * starts). Critically, the CLI counts EVERYTHING after `/goal ` as the condition — the criteria AND the
 * base prompt we append below (not just the first line; see code.claude.com/docs/en/goal). So the guard
 * measures the WHOLE emitted payload, not `criteria` alone: a criteria that fits on its own still blows
 * the limit once the boilerplate is appended (the "got 4463" the criteria-only check missed). When the
 * full payload won't fit, we fall back to plain mode with the acceptance condition embedded in the body —
 * the run still knows what "done" means, it just isn't evaluator-driven.
 */
/** One earlier session that already worked this task — the slice of `TaskRun` the prompt needs. */
export type PriorRun = { agent: string; outcome?: string; summary?: string };

/** How many earlier attempts we name individually before collapsing the rest to a count. Keeps a
 *  much-retried task's prompt from turning into a wall of history. */
const PRIOR_RUNS_SHOWN = 3;

/**
 * The "you are not the first" preamble for a re-dispatched task.
 *
 * A task is the unit of work and a session is one ATTEMPT at it, so a re-dispatch used to hand the next
 * agent a prompt identical to the first one's — no signal that anyone had been here, which invites
 * redoing work that already landed (or re-hitting a wall a predecessor already documented). Each prior
 * run is one line: who ran it, what it reported, and the one-liner it left behind. The pointer to
 * `task_get` matters as much as the lines — the notes and discussion hold the detail this can't.
 */
function priorRunsBlock(taskId: string, runs?: PriorRun[]): string {
  if (!runs?.length) return '';
  const shown = runs.slice(-PRIOR_RUNS_SHOWN);
  const earlier = runs.length - shown.length;
  const line = (r: PriorRun, i: number) =>
    `  ${earlier + i + 1}. ${r.agent} — ${r.outcome || 'no report'}${r.summary ? `: ${r.summary}` : ''}`;
  return (
    `This is attempt ${runs.length + 1} — ${runs.length} earlier session${runs.length === 1 ? '' : 's'} already worked this task` +
    `${earlier > 0 ? ` (${earlier} older one${earlier === 1 ? '' : 's'} not listed)` : ''}:\n` +
    shown.map(line).join('\n') + '\n' +
    `Pick up where they left off rather than starting over — call task_get({ id: "${taskId}" }) for the full notes and discussion first.\n\n`
  );
}

/** The prefix every message delivered from a task room carries INTO a run. It is the only marker the
 *  agent gets that a line of input came from a human watching the room rather than from its own
 *  orchestration, so it names the channel, the task, and the way back. Kept to ONE line: delivery types
 *  it into a live TUI, where a newline would submit early. */
export const DISCUSSION_PREFIX = '[task discussion]';

/**
 * What every task-working agent must know about the room its work is watched from — appended to the
 * dispatch prompt (fresh AND resuming), because the channel is useless if only one side knows it exists.
 *
 * A human sitting in the task room sees the Discussion, NOT the agent's terminal narration: everything
 * the agent "says" while working is invisible there. And a message they type in the room is now typed
 * straight into this run mid-turn, arriving prefixed with {@link DISCUSSION_PREFIX}. Both halves have to
 * be stated or the loop is one-way in practice — the agent goes quiet in the only place anyone is
 * looking, and reads a live human interrupt as stray input.
 */
function roomBlock(taskId: string): string {
  return (
    `This task has a DISCUSSION — the room where its humans watch this work. They do NOT see your terminal ` +
    `output; the discussion is the only thing they read, and the only place they can answer you.\n` +
    `- Say anything you want a human to see with task_say({ id: "${taskId}", message: "…" }) — a heads-up ` +
    `when you start, when you change approach, when something looks wrong, and a short summary at the end.\n` +
    `- A message they type in the room is delivered straight into this session, prefixed ` +
    `"${DISCUSSION_PREFIX} <name>: …". Treat it as a live instruction from that person, acknowledge it in the ` +
    `room with task_say, and act on it — including "stop" or "wait", which override what you were doing.\n` +
    `- Read the conversation so far any time with task_get({ id: "${taskId}" }) (its \`discussion\`).`
  );
}

export function buildTaskPrompt(
  t: { id: string; title: string; body: string; criteria?: string },
  opts: { goalMode?: boolean; priorRuns?: PriorRun[]; resuming?: boolean } = {},
): string {
  const history = priorRunsBlock(t.id, opts.priorRuns);
  const buildBase = (converging: boolean) => {
    const close = converging
      ? `When you have satisfied the goal above, call task_update({ id: "${t.id}", status: "done", note: "<what you did>" }) in that same turn.\n`
      : `When finished, call task_update({ id: "${t.id}", status: "done", note: "<what you did>" }).\n`;
    // Resuming your OWN transcript: the full task context and everything you already did is above in this
    // same conversation, so re-stating the body would just be noise — orient to "continue and finish".
    if (opts.resuming) {
      return (
        `You are RESUMING your own earlier session on task ${t.id}: ${t.title}.\n` +
        `Your previous turn ended without closing it (it crashed, ran out, or stopped mid-way). Everything ` +
        `you already did is above in this same conversation — review where you left off, continue from there ` +
        `rather than redoing it, and finish the task.\n\n` +
        close +
        `If you cannot proceed, call task_update({ id: "${t.id}", status: "blocked", note: "<why>" }).\n\n` +
        roomBlock(t.id)
      );
    }
    // Criteria we want to honour but can't route through `/goal` still belongs in the prompt.
    const embedCriteria = !!t.criteria && !converging;
    return (
      `You are working task ${t.id}: ${t.title}\n\n` +
      `${t.body || '(no description provided)'}\n\n` +
      (embedCriteria ? `Acceptance criteria (the definition of done): ${t.criteria}\n\n` : '') +
      history +
      close +
      `If you cannot proceed, call task_update({ id: "${t.id}", status: "blocked", note: "<why>" }).\n` +
      `Break large work into sub-tasks with task_create({ parentId: "${t.id}", ... }).\n\n` +
      roomBlock(t.id)
    );
  };
  // The `/goal` condition is the criteria PLUS the appended base — gate on the full payload's length.
  const converging = !!(opts.goalMode && t.criteria) && `${t.criteria}\n\n${buildBase(true)}`.length <= GOAL_MAX_CHARS;
  const base = buildBase(converging);
  return converging ? `/goal ${t.criteria}\n\n${base}` : base;
}

// `/goal` CLI support (v2.1.139+) is probed + cached in the shared claude-cli module; imported for use
// here and re-exported so existing importers (tests) keep their import path. See goals-plan.md §C.
import { claudeSupportsGoal, GOAL_MAX_CHARS } from './claude-cli';
export { claudeSupportsGoal };

/** RAM-derived default concurrency cap: ~1 session per 1.5 GB of host memory, floored at 3. Adapts to the
 *  box (2 GB droplet → 3; 32 GB Mac Mini → ~21) so the cap protects small boxes without throttling big ones.
 *  Parameterized for testing. See docs/concurrency-cap-plan.md Phase 1. */
export function derivedConcurrencyCap(totalBytes = os.totalmem()): number {
  const gb = totalBytes / (1024 ** 3);
  return Math.max(3, Math.floor(gb / 1.5));
}

export class Automations {
  private readonly db: Db;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly os: AgentOS,
    private readonly tm: TerminalManager,
  ) {
    this.db = os.db;
  }

  /** Best-effort sink DMed once when a task passes its due date (wired in the tenant registry). */
  private overdueNotifier?: (task: Task) => void;
  setOverdueNotifier(fn: (task: Task) => void): void { this.overdueNotifier = fn; }

  /** Best-effort sweep run each tick that re-nudges stale pending approvals/questions (wired in the
   *  tenant registry to `TerminalManager.escalateStalePrompts`). Given the tick's `now` in epoch ms. */
  private stalePromptSweeper?: (now: number) => void;
  setStalePromptSweeper(fn: (now: number) => void): void { this.stalePromptSweeper = fn; }

  // ── CRUD ───────────────────────────────────────────────────────────────────────
  list(): Automation[] {
    return this.db.prepare('SELECT * FROM automations ORDER BY created_at').all<AutomationRow>().map(toAutomation);
  }
  get(id: string): Automation | undefined {
    const r = this.db.prepare('SELECT * FROM automations WHERE id = ?').get<AutomationRow>(id);
    return r ? toAutomation(r) : undefined;
  }

  add(input: AddAutomationInput): Automation {
    if (!this.os.agents.has(input.agentId)) throw new Error(`unknown agent: ${input.agentId}`);
    if (!input.name.trim()) throw new Error('a name is required');
    if (!input.task.trim()) throw new Error('a task is required');
    let schedule: string | undefined;
    let secret: string | undefined;
    let filter: string | undefined;
    let mode: ExecMode = input.mode === 'headless' ? 'headless' : 'interactive';
    if (input.type === 'cron') {
      schedule = (input.schedule || '').trim();
      parseCron(schedule); // throws with a useful message on a bad expression
    } else if (input.type === 'webhook') {
      secret = randomBytes(24).toString('hex');
    } else if (input.type === 'composio') {
      filter = (input.filter || '').trim().toUpperCase(); // '' = any Composio trigger
      if (input.mode === undefined) mode = 'headless'; // event-driven runs are unattended by default
    } else if (input.type === 'slack') {
      filter = (input.filter || '').trim(); // event type (app_mention/message) or channel id; '' = any
      if (input.mode === undefined) mode = 'headless'; // event-driven runs are unattended by default
    } else if (input.type === 'discord') {
      filter = (input.filter || '').trim(); // event type (mention/direct_message) or channel id; '' = any
      if (input.mode === undefined) mode = 'headless'; // event-driven runs are unattended by default
    } else if (input.type === 'telegram') {
      filter = (input.filter || '').trim(); // event type (mention/direct_message) or chat id; '' = any
      if (input.mode === undefined) mode = 'headless'; // event-driven runs are unattended by default
    } else {
      throw new Error('type must be cron, webhook, composio, slack, discord, or telegram');
    }
    const a: Automation = {
      id: newId('automation'),
      agentId: input.agentId,
      name: input.name.trim(),
      type: input.type,
      mode,
      schedule,
      secret,
      filter,
      task: input.task,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: Date.now(),
      runAs: input.runAs?.trim() || undefined,
    };
    this.db
      .prepare('INSERT INTO automations (id, agent_id, name, type, mode, schedule, secret, filter, task, enabled, created_by, created_at, run_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.name, a.type, a.mode, a.schedule ?? null, a.secret ?? null, a.filter ?? null, a.task, 1, a.createdBy ?? null, a.createdAt, a.runAs ?? null);
    return a;
  }

  /** How many pending (enabled, not-yet-fired) one-shot tasks an agent has — the runaway cap. */
  pendingScheduled(agentId: string): number {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM automations WHERE agent_id = ? AND type = 'once' AND enabled = 1 AND last_fired_at IS NULL")
      .get<{ n: number }>(agentId)!.n;
  }

  /**
   * Schedule a one-shot deferred task: a single future run of `agentId`, at `runAt` (epoch ms), acting
   * as `runAs` (the identity that scheduled it). Stored as a `once` automation so it shows up in the
   * console, is auditable, and a human can cancel it. Bounded by SCHEDULE_* and the per-agent cap.
   * When `resumeClaudeId` is given, the fired run `--resume`s that claude transcript instead of starting
   * fresh — so an agent deferring its own follow-up wakes back up with its full prior context.
   */
  schedule(input: { agentId: string; name: string; task: string; runAt: number; runAs?: string; resumeClaudeId?: string; createdBy?: string }): Automation {
    if (!this.os.agents.has(input.agentId)) throw new Error(`unknown agent: ${input.agentId}`);
    if (!input.task.trim()) throw new Error('a task is required');
    const now = Date.now();
    if (!Number.isFinite(input.runAt)) throw new Error('a valid fire time is required');
    if (input.runAt < now + SCHEDULE_MIN_MS) throw new Error('schedule must be at least 1 minute from now');
    if (input.runAt > now + SCHEDULE_MAX_MS) throw new Error('schedule must be within 30 days');
    if (this.pendingScheduled(input.agentId) >= SCHEDULE_MAX_PENDING) {
      throw new Error(`too many pending scheduled tasks (max ${SCHEDULE_MAX_PENDING}) — cancel one first`);
    }
    const a: Automation = {
      id: newId('automation'),
      agentId: input.agentId,
      name: input.name.trim() || 'Scheduled task',
      type: 'once',
      mode: 'headless', // deferred runs are unattended
      task: input.task,
      runAt: input.runAt,
      runAs: input.runAs,
      resumeClaudeId: input.resumeClaudeId,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.db
      .prepare('INSERT INTO automations (id, agent_id, name, type, mode, schedule, secret, filter, task, enabled, created_by, created_at, run_at, run_as, resume_claude_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.name, a.type, a.mode, null, null, null, a.task, 1, a.createdBy ?? null, a.createdAt, a.runAt!, a.runAs ?? null, a.resumeClaudeId ?? null);
    return a;
  }

  /** Cancel a pending one-shot, scoped to its agent (an agent may only cancel its own schedules). Returns
   *  false if it doesn't exist, isn't a one-shot for that agent, or has already fired. */
  cancelScheduled(id: string, agentId: string): boolean {
    const a = this.get(id);
    if (!a || a.type !== 'once' || a.agentId !== agentId || a.lastFiredAt) return false;
    return this.remove(id);
  }

  /**
   * Wake a CALLER agent with a completion poke — the "really done" signal a delegate sends back when it
   * finishes a `poke_on_done` hand-off. Two delivery paths, chosen by whether the caller's transcript
   * still has a LIVE session:
   *
   *  - **Live caller → inject** (the common interactive/resident case). The caller ended its turn and is
   *    sitting IDLE at the prompt — it will NOT observe the delegate's completion on its own (the bug this
   *    fixes: an interactive session had to be told "check that task status" by hand). So we type the poke
   *    into its live pane (`injectToSession`, submit): an idle claude runs it immediately, a mid-turn
   *    claude queues it to the next turn boundary — never a competing `--resume` on one conversation.
   *  - **Dead caller → resume** (a headless caller that exited at turn-end). Nothing to type into, so we
   *    `--resume` `callerClaudeId` in a fresh `poke:` run with `message` as the next turn, and the caller
   *    continues its OWN plan with full context.
   *
   * Fires IMMEDIATELY (unlike schedule(), whose 1-min floor makes it a scheduler, not a wake). The delegate
   * (task assignee) is always the actor, never the caller, so this can't self-wake. Audited `agent.poked`.
   */
  pokeCaller(input: { callerAgent: string; callerClaudeId: string; runAs?: string; message: string; source: string; title?: string }): FireResult {
    const agentId = input.callerAgent.startsWith('agent:') ? input.callerAgent.slice('agent:'.length) : input.callerAgent;
    if (!this.os.agents.has(agentId)) return { ok: false, reason: `unknown caller agent: ${agentId}` };
    if (!input.callerClaudeId) return { ok: false, reason: 'no caller transcript to resume' };
    // Prefer delivering into the caller's OWN live session if it still has one bound to this transcript —
    // an idle interactive/resident caller would otherwise never learn the delegate finished.
    //
    // Liveness is `reachable` (the pane), NOT the row's `status`. A caller that handed off work and then
    // called `report` is stamped `done` with its claude still running — the common shape, since a delegate
    // usually finishes minutes after the caller last reported. Filtering on `status = 'running'` here sent
    // every one of those down the resume lane, starting a SECOND claude on a transcript the first was
    // still holding. Newest row first: a transcript resumed before now spans several rows and only the
    // latest can own the pane.
    const liveSession = this.db
      .prepare('SELECT id, tmux FROM term_sessions WHERE claude_session_id = ? ORDER BY created_at DESC')
      .all<{ id: string; tmux: string }>(input.callerClaudeId)
      .find((r) => this.tm.reachable(r.id));
    if (liveSession) {
      const injected = this.tm.injectToSession(liveSession.id, input.message, true, input.runAs ? `member:${input.runAs}` : 'system');
      this.os.audit.append({
        ts: Date.now(),
        runId: liveSession.id,
        tenant: this.os.tenant,
        principal: input.runAs ? `member:${input.runAs}` : 'system',
        type: 'agent.poked',
        data: { caller: agentId, source: input.source, runAs: input.runAs ?? null, via: 'inject', ok: injected.ok },
      });
      // Keystrokes landed → the caller has (or will imminently have) the result. On the rare inject failure
      // (a wedged TUI, an unreadable socket) fall through to a resume so the poke is never silently
      // dropped — but kill the pane first, exactly as `chatSend` does: resuming a transcript that another
      // claude still holds is worse than a late poke.
      if (injected.ok) return { ok: true, sessionId: liveSession.id, tmux: liveSession.tmux };
      this.tm.stopSession(liveSession.id, 'system');
    }
    const s = this.tm.createSession(agentId, input.title ?? `Poke ← ${input.source}`, input.message, `poke:${input.source}`, true, undefined, undefined, input.runAs, input.callerClaudeId);
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: input.runAs ? `member:${input.runAs}` : 'system',
      type: 'agent.poked',
      data: { caller: agentId, source: input.source, runAs: input.runAs ?? null, via: 'resume' },
    });
    return { ok: true, sessionId: s.id, tmux: s.tmux };
  }

  update(id: string, patch: { name?: string; mode?: ExecMode; schedule?: string; filter?: string; task?: string; enabled?: boolean; runAs?: string | null }): Automation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (patch.schedule !== undefined && a.type === 'cron') parseCron(patch.schedule);
    // `filter` is only meaningful for the event-driven triggers; ignore it on cron/webhook/once so an
    // edit can't stamp a stray filter onto a type that never reads one. composio uppercases its slug.
    const filterTypes = a.type === 'composio' || a.type === 'slack' || a.type === 'discord' || a.type === 'telegram';
    const nextFilter = !filterTypes
      ? a.filter ?? null
      : patch.filter === undefined
        ? a.filter ?? null
        : a.type === 'composio'
          ? patch.filter.trim().toUpperCase()
          : patch.filter.trim();
    // `runAs`: undefined = leave as-is; a member id sets it; null/'' clears it (back to company identity).
    const nextRunAs = patch.runAs === undefined ? a.runAs ?? null : (patch.runAs || '').trim() || null;
    this.db
      .prepare('UPDATE automations SET name = ?, mode = ?, schedule = ?, filter = ?, task = ?, enabled = ?, run_as = ? WHERE id = ?')
      .run(
        patch.name?.trim() || a.name,
        patch.mode ?? a.mode,
        a.type === 'cron' ? (patch.schedule?.trim() ?? a.schedule ?? null) : null,
        nextFilter,
        patch.task ?? a.task,
        (patch.enabled ?? a.enabled) ? 1 : 0,
        nextRunAs,
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
  }

  // ── firing ─────────────────────────────────────────────────────────────────────
  /** Is the account pool for this agent's runtime fully exhausted right now? Returns the runtime + earliest
   *  reset when yes, else null. An EMPTY pool is never exhausted (rotation inert → scheduled work runs exactly
   *  as today), so this only ever fires on a box that has opted into rotation and burned through every account.
   *  The scheduler uses it to DEFER rather than spawn a doomed, zombie-prone run. */
  private runtimePoolExhausted(agentId: string): { runtime: CodingRuntimeId; until: number | null } | null {
    const manifest = this.os.agents.get(agentId);
    const runtime: CodingRuntimeId = isCodingRuntime(manifest?.runtime) ? manifest!.runtime : 'claude-code';
    const state = this.os.runtimeAccounts.allLimited(runtime);
    return state.limited ? { runtime, until: state.until } : null;
  }

  /**
   * Spawn the automation's session. `guard: true` skips when the previous spawn is still alive —
   * the no-pile-ups rule for cron/webhook; "Run now" from the console passes guard: false.
   */
  fire(a: Automation, opts: { guard: boolean; extra?: string; runAs?: string; mode?: ExecMode; slack?: { channel: string; threadTs: string }; discord?: { channel: string; messageId: string }; telegram?: { chat: string; messageThreadId?: string; messageId: string }; clickup?: { taskId: string; commentId: string }; resumeClaudeId?: string } = { guard: true }): FireResult {
    if (opts.guard && a.lastSessionId && this.tm.reachable(a.lastSessionId)) {
      return { ok: false, reason: 'previous session still running' };
    }
    // Don't spawn a scheduled/triggered run into an exhausted quota — it would just hit the usage limit and
    // zombie. Defer (retry a later tick, firing once an account's limit resets). A human "Run now"
    // (guard:false) is never deferred. Inert when no pool is configured (allLimited → false).
    if (opts.guard) {
      const dry = this.runtimePoolExhausted(a.agentId);
      if (dry) return { ok: false, reason: `all ${dry.runtime} accounts limited${dry.until ? ` until ${new Date(dry.until).toISOString()}` : ''}` };
    }
    const task = opts.extra ? `${a.task}\n\n${opts.extra}` : a.task;
    // Provenance is ALWAYS the automation (`spawned_by`); the run-as member (when a trigger resolved
    // one, e.g. the Slack user who @-mentioned the bot) is passed separately so the session binds their
    // connectors/Composio + lands in their inbox, while the audit/label still show what fired it.
    const spawnedBy = `automation:${a.id}`;
    // A one-off "Run now" from the console may override the automation's saved mode — run it headless
    // (fire-and-forget) or interactive (watch/steer it live). Scheduled/trigger firings pass no mode
    // and keep the automation's own `a.mode`.
    const mode: ExecMode = opts.mode ?? a.mode;
    // `resumeClaudeId` (a self-scheduled follow-up) makes the run `--resume` the scheduling session's
    // transcript — the launcher's UNATTENDED lane restores it and injects `task` as the next turn.
    const s = this.tm.createSession(a.agentId, a.name, task, spawnedBy, mode === 'headless', opts.slack, opts.discord, opts.runAs, opts.resumeClaudeId, false, undefined, opts.clickup, opts.telegram);
    this.db.prepare('UPDATE automations SET last_fired_at = ?, last_session_id = ? WHERE id = ?').run(Date.now(), s.id, a.id);
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: opts.runAs ? `member:${opts.runAs}` : `automation:${a.id}`,
      type: 'automation.fired',
      data: { automation: a.id, name: a.name, agent: a.agentId, trigger: a.type, mode, runAs: opts.runAs ?? null },
    });
    return { ok: true, sessionId: s.id, tmux: s.tmux };
  }

  // ── tasks ────────────────────────────────────────────────────────────────────────
  /**
   * Dispatch a task: spawn a governed headless session that works it to completion. Provenance is
   * `task:<id>` (visible to the task owner + owner/admin); the session runs AS the task `owner` (run_as —
   * human passthrough, so budget/approvals ladder to the accountable person), or the company identity when
   * ownerless. The dispatched agent closes its own loop via `task_update` (see buildTaskPrompt). Guarded
   * against pile-ups (never two live sessions for one task) and an attempts ceiling (park `blocked` after
   * TASK_MAX_ATTEMPTS so a failing task can't spin). Every effect the session has still passes the gateway,
   * so "start work" adds no new trust surface. Audited `task.dispatched`.
   */
  dispatchTask(id: string, opts: { guard?: boolean; by?: string } = {}): FireResult {
    const guard = opts.guard ?? true;
    const t = this.os.tasks.get(id);
    if (!t) return { ok: false, reason: 'task not found' };
    if (t.status === 'done' || t.status === 'cancelled') return { ok: false, reason: `task is ${t.status}` };
    // `blocked` means someone parked this deliberately. The tick never selects it (dispatchable() is
    // todo-only), but every DIRECT path — task_dispatch, task_wait's polling kick, an app dispatch —
    // used to sail past, re-spawning work a human or a caller had just stopped. A human forcing it from
    // the console (guard:false) is still allowed: that IS the un-park.
    if (guard && t.status === 'blocked') return { ok: false, reason: 'task is blocked — unblock it before dispatching' };
    const agentId = (t.assignee || '').startsWith('agent:') ? t.assignee!.slice('agent:'.length) : '';
    if (!agentId) return { ok: false, reason: 'task has no agent assignee' };
    if (!this.os.agents.has(agentId)) return { ok: false, reason: `unknown agent: ${agentId}` };
    if (guard && t.lastSessionId && this.tm.reachable(t.lastSessionId)) {
      return { ok: false, reason: 'a session is already working this task' };
    }
    // Defer a guarded (scheduler-driven) dispatch when the agent's runtime pool is exhausted — retried next
    // tick, fires once an account resets. Attempts are NOT incremented (see below), so deferral costs no
    // retry budget. A direct console/task_dispatch (guard:false) is never deferred.
    if (guard) {
      const dry = this.runtimePoolExhausted(agentId);
      if (dry) return { ok: false, reason: `all ${dry.runtime} accounts limited${dry.until ? ` until ${new Date(dry.until).toISOString()}` : ''}` };
    }
    if (t.attempts >= TASK_MAX_ATTEMPTS) {
      this.os.tasks.update(id, { status: 'blocked', note: `auto-dispatch gave up after ${t.attempts} attempts`, by: 'system' });
      return { ok: false, reason: `attempt ceiling reached (${TASK_MAX_ATTEMPTS})` };
    }
    // Pipeline gate: never spawn a task whose dependencies aren't finished. dispatchable() already
    // excludes these from the tick; this guards the direct paths (console dispatch / task_dispatch /
    // task_wait). The task stays todo and becomes dispatchable once its blockers reach done/cancelled.
    const unmet = this.os.tasks.unmetDeps(id);
    if (unmet.length) return { ok: false, reason: `waiting on ${unmet.length} unfinished ${unmet.length === 1 ? 'dependency' : 'dependencies'} (${unmet.join(', ')})` };
    // A headless task with acceptance criteria runs under a `/goal` convergence condition (when the
    // installed claude supports it); interactive tasks keep the plain prompt (a human drives those).
    const goalMode = t.mode !== 'interactive' && !!t.criteria && claudeSupportsGoal();
    // A delegator can pin the dispatched session's model / reasoning effort (e.g. a cheap background
    // sweep, or max effort for a hard task); undefined fields fall back to the agent + workspace default.
    const tuning = (t.model || t.effort) ? { model: t.model, effort: t.effort } : undefined;
    // Tell a re-dispatched run that it isn't the first — see priorRunsBlock. Only sessions that actually
    // finished carry a verdict worth reporting; a still-alive one can't be a predecessor anyway (the
    // pile-up guard above already refused that case).
    const priorRuns = this.tm.taskRuns(t.id).filter((r) => !r.alive).map((r) => ({ agent: r.agent, outcome: r.outcome, summary: r.summary }));
    // Resume the SAME transcript when the last dispatched run was THIS agent and pinned one — so a
    // retry/reopen CONTINUES the conversation (files read, decisions made, half-done work) instead of
    // re-deriving it from a summary, the way every other re-entry path already does. Cap it: after
    // MAX_TASK_RESUMES resumes that still didn't close the task, start FRESH to escape a wedged transcript
    // — a fresh run mints a new `claude_session_id`, so the streak resets and the LAST attempt before the
    // ceiling is a clean slate. A changed assignee / no transcript ⇒ `resumable` undefined ⇒ fresh.
    const resumable = this.tm.resumableTaskTranscript(t.id, agentId);
    const resuming = !!resumable && resumable.uses < 1 + MAX_TASK_RESUMES;
    const resumeId = resuming ? resumable!.claudeSessionId : undefined;
    const s = this.tm.createSession(agentId, `Task: ${t.title}`, buildTaskPrompt(t, { goalMode, priorRuns, resuming }), `task:${t.id}`, t.mode !== 'interactive', undefined, undefined, t.owner, resumeId, false, tuning);
    this.os.tasks.markDispatched(t.id, s.id);
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: t.owner ? `member:${t.owner}` : 'task',
      type: 'task.dispatched',
      data: { task: t.id, title: t.title, agent: agentId, mode: t.mode, runAs: t.owner ?? null, by: opts.by ?? 'system' },
    });
    return { ok: true, sessionId: s.id, tmux: s.tmux };
  }

  /**
   * Generic chat router (no per-agent automation). Parse a leading `/agent-name` from the message; if
   * it names a known claude-code agent, return it, else return a help list of addressable agents. This
   * is the fallback used by fireSlack/fireDiscord when NO automation matched, so connecting the bot once
   * makes the whole fleet reachable ("/pod-troubleshooter why is X down?").
   */
  /** Normalise the optional `/agent-os` namespace prefix: `/agent-os engineer …` (or `/agentos …`, with
   *  an optional second slash) collapses to `/engineer …`, so a namespaced invocation and the bare
   *  `/<agent>` form route identically. Useful in shared spaces (ClickUp task comments) where a bare
   *  `/name` is ambiguous; a no-op for a plain `/<agent>`. */
  private normalizeChatCommand(text: string): string {
    return (text || '').replace(/^(\s*)\/agent-?os\s+\/?/i, '$1/');
  }

  private routeChat(text: string): { agentId?: string; help?: string } {
    // Exclude the code-provisioned System machinery (concierge/operator/consolidator/…) — not user-facing
    // teammates, so never addressable or listed in the help roster.
    const claudeAgents = [...this.os.agents.values()].filter((a) => isCodingRuntime(a.runtime) && a.category !== 'System');
    // Only agents opted-in to the open chat front door (`chatReachable !== false`) are addressable here.
    const chatAgents = claudeAgents.filter((a) => a.chatReachable !== false).map((a) => a.id);
    const m = this.normalizeChatCommand(text).trim().match(/^\/([A-Za-z0-9][\w-]*)\b\s*([\s\S]*)$/);
    if (m && chatAgents.includes(m[1])) return { agentId: m[1] };
    // A real agent deliberately kept OFF the chat router → say so, don't pretend it doesn't exist.
    if (m && claudeAgents.some((a) => a.id === m[1])) return { help: `The \`${m[1]}\` agent isn't reachable from chat.` };
    const list = chatAgents.length ? chatAgents.map((id) => `• \`/${id}\``).join('\n') : '_(no agents available)_';
    const help = m
      ? `I don't have an agent named \`/${m[1]}\`. Address one with \`/agent-os <agent>\` (or just \`/<agent>\`) and your request:\n${list}`
      : `👋 Address an agent with \`/agent-os <agent>\` (or just \`/<agent>\`) followed by your request. Available:\n${list}`;
    return { help };
  }

  /**
   * Spawn a one-off chat run for a routed agent (explicit `/name`, auto-inference, or a resolved
   * disambiguation) — no automation row. Same governance path as fire(): provenance `chat:<agent>`,
   * run-as the sender, reply bound to the thread, every effect still gated. Audited as `chat.routed`,
   * tagged with HOW it was routed (`route.by` + score + runner-up) so mis-routes are measurable.
   */
  private spawnChatAgent(
    agentId: string,
    task: string,
    opts: {
      runAs?: string;
      slack?: { channel: string; threadTs: string };
      discord?: { channel: string; messageId: string };
      telegram?: { chat: string; messageThreadId?: string; messageId: string };
      clickup?: { taskId: string; commentId: string };
      title?: string;
      resident?: boolean;
      route?: { by: 'explicit' | 'auto' | 'auto-llm' | 'auto-disambiguated'; score?: number; runnerUp?: string };
    },
  ): FireResult {
    // `resident` (Slack chat) → a warm interactive session (headless off) kept alive for fast follow-ups;
    // otherwise the classic one-shot headless run. `title` is the meaningful, message-derived label.
    const s = this.tm.createSession(
      agentId, opts.title || `Chat → ${agentId}`, task, `chat:${agentId}`,
      !opts.resident, opts.slack, opts.discord, opts.runAs, undefined, !!opts.resident, undefined, opts.clickup, opts.telegram,
    );
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: opts.runAs ? `member:${opts.runAs}` : 'chat',
      type: 'chat.routed',
      data: {
        agent: agentId,
        runAs: opts.runAs ?? null,
        channel: opts.slack?.channel ?? opts.discord?.channel ?? opts.telegram?.chat ?? opts.clickup?.taskId ?? null,
        resident: !!opts.resident,
        routedBy: opts.route?.by ?? 'explicit',
        score: opts.route?.score ?? null,
        runnerUp: opts.route?.runnerUp ?? null,
      },
    });
    return { ok: true, sessionId: s.id, tmux: s.tmux };
  }

  // ── auto-router: pending disambiguation (in-memory, per thread) ──────────────────
  // When the router is uncertain it asks the human ("did you mean A or B?"). The reply arrives as a
  // fresh thread message with NO session bound yet, so we stash the shortlist + the ORIGINAL request
  // here keyed by thread; the next message in that thread resolves the choice and routes the original
  // task. In-memory (like the approval decision waiter) — a restart just makes the human re-ask.
  private pendingRoute = new Map<string, { candidates: string[]; text: string; extra: string; runAs?: string; expires: number }>();
  private static readonly PENDING_TTL_MS = 15 * 60 * 1000;

  private putPending(key: string, v: { candidates: string[]; text: string; extra: string; runAs?: string }): void {
    const now = Date.now();
    for (const [k, p] of this.pendingRoute) if (p.expires <= now) this.pendingRoute.delete(k); // opportunistic prune
    this.pendingRoute.set(key, { ...v, expires: now + Automations.PENDING_TTL_MS });
  }
  private takePending(key: string): { candidates: string[]; text: string; extra: string; runAs?: string } | undefined {
    const p = this.pendingRoute.get(key);
    if (!p) return undefined;
    this.pendingRoute.delete(key);
    return p.expires > Date.now() ? p : undefined;
  }

  /** Interpret a disambiguation reply against the offered shortlist: a 1-based number, or an agent id /
   *  name token appearing in the text. `undefined` → unresolved (treat the message as a fresh route). */
  private matchDisambiguation(text: string, candidates: string[]): string | undefined {
    const t = (text || '').toLowerCase().replace(/<@[^>]+>/g, '').trim();
    const num = t.match(/(?:^|\s)([1-9])(?:\s|$|[.)])/);
    if (num) {
      const i = Number(num[1]) - 1;
      if (i >= 0 && i < candidates.length) return candidates[i];
    }
    for (const id of candidates) {
      if (t.includes(id.toLowerCase())) return id;
      if (id.toLowerCase().split(/[-_]+/).some((tok) => tok.length >= 3 && t.includes(tok))) return id;
    }
    return undefined;
  }

  private disambiguationPrompt(candidates: RouterCandidate[]): string {
    const lines = candidates.map((c, i) => {
      const a = this.os.agents.get(c.agentId);
      const desc = a?.description ? ` — ${a.description.split('\n')[0].slice(0, 120)}` : '';
      return `${i + 1}. \`/${c.agentId}\`${desc}`;
    });
    return `I'm not sure which agent fits — reply with a number (or the name):\n${lines.join('\n')}`;
  }

  /**
   * The shared front door for a chat message that matched no automation: resolve a pending
   * disambiguation, else honour an explicit `/name`, else auto-route (route silently / ask to
   * disambiguate / fall back to the help list). Used by both fireSlack and fireDiscord. `key` scopes
   * the pending-disambiguation store to the thread (Slack: channel+thread; Discord: channel).
   */
  private async routeUnmatched(opts: {
    key: string;
    text: string;
    extra: string;
    runAs?: string;
    slack?: { channel: string; threadTs: string };
    discord?: { channel: string; messageId: string };
    telegram?: { chat: string; messageThreadId?: string; messageId: string };
    clickup?: { taskId: string; commentId: string };
  }): Promise<{ sessions: string[]; reply?: string }> {
    const sessions: string[] = [];
    const spawn = (agentId: string, task: string, route: NonNullable<Parameters<Automations['spawnChatAgent']>[2]['route']>, text: string, runAs?: string) => {
      const r = this.spawnChatAgent(agentId, task, { runAs, slack: opts.slack, discord: opts.discord, telegram: opts.telegram, clickup: opts.clickup, title: chatTitle(text, agentId), resident: true, route });
      if (r.ok) sessions.push(r.sessionId);
    };

    // 1) A reply to a disambiguation we asked in this thread → route the ORIGINAL request to the choice.
    const pend = this.takePending(opts.key);
    if (pend) {
      const chosen = this.matchDisambiguation(opts.text, pend.candidates);
      if (chosen) {
        spawn(chosen, pend.extra, { by: 'auto-disambiguated' }, pend.text, pend.runAs ?? opts.runAs);
        return { sessions };
      }
      // Unresolved reply → fall through and treat this message as a fresh routing attempt.
    }

    // The whole chat front door off → nothing to do (no help list either).
    if (!this.os.settings.chatRouterEnabled()) return { sessions };

    // 2) Explicit `/name` always wins over inference.
    const explicit = this.routeChat(opts.text);
    if (explicit.agentId) {
      spawn(explicit.agentId, opts.extra, { by: 'explicit' }, opts.text, opts.runAs);
      return { sessions };
    }

    // 3) Auto-route (when enabled) — the intent layer, mirrored from Cockpit. For `ask`/`action` we hand
    //    off to the read-only concierge / action operator as THREAD-BOUND chat sessions: they do the work
    //    and reply IN-THREAD via the same chat-mirror primitive every chat agent uses (the "poke the
    //    thread"), not a bespoke client poll. `work` routes to the best-fit teammate. Fails safe.
    if (this.os.settings.autoRouteEnabled()) {
      const intent = classifyIntent(opts.text).intent;

      if (intent === 'social') {
        // A bare "hey"/"thanks" — reply conversationally instead of routing or dumping the roster.
        return { sessions, reply: SOCIAL_REPLY };
      }

      if (intent === 'ask') {
        // A question ABOUT the workspace: answer INLINE first (fast, no session) — state lookup → direct
        // Claude. Only when there's no fast inline answer do we spawn the concierge to answer in-thread.
        const me = opts.runAs ? this.os.team.getMember(opts.runAs) : undefined;
        const inline = await answerAsk(this.os, this.tm, this, me, opts.text);
        if (inline) {
          this.os.audit.append({ ts: Date.now(), runId: opts.key, tenant: this.os.tenant, principal: opts.runAs ? `member:${opts.runAs}` : 'chat', type: 'chat.answered', data: { source: inline.source, chars: inline.answer.length, runAs: opts.runAs ?? null } });
          return { sessions, reply: inline.answer };
        }
        ensureConcierge(this.os);
        if (this.os.agents.get(CONCIERGE_ID)?.dir) {
          spawn(CONCIERGE_ID, opts.extra, { by: 'auto' }, opts.text, opts.runAs);
          return { sessions };
        }
        // Concierge unavailable → fall through to work routing (an agent can still answer conversationally).
      } else if (intent === 'action') {
        // "schedule … / create a task …" → the governed operator: task_create (filed) / automation_propose
        // (a draft an owner approves). Bound to the thread; it confirms in-thread. Falls back to routing.
        ensureOperator(this.os);
        if (this.os.agents.get(OPERATOR_ID)?.dir) {
          spawn(OPERATOR_ID, opts.extra, { by: 'auto' }, opts.text, opts.runAs);
          return { sessions };
        }
      }

      // `work` (or a concierge/operator that couldn't be provisioned) → route to the best-fit teammate.
      const decision = await chooseAgent(this.os, opts.text);
      if (decision.kind === 'route') {
        spawn(decision.agentId, opts.extra, { by: decision.method === 'llm' ? 'auto-llm' : 'auto', score: decision.score, runnerUp: decision.runnerUp?.agentId }, opts.text, opts.runAs);
        return { sessions };
      }
      if (decision.kind === 'disambiguate') {
        this.putPending(opts.key, { candidates: decision.candidates.map((c) => c.agentId), text: opts.text, extra: opts.extra, runAs: opts.runAs });
        return { sessions, reply: this.disambiguationPrompt(decision.candidates) };
      }
      // decision.kind === 'none' → fall back to the classic help list.
    }
    return { sessions, reply: explicit.help };
  }

  /** Inbound webhook: validate id + key, append the payload to the task, fire (guarded). */
  fireWebhook(id: string, key: string, payload: unknown): { status: number; body: Record<string, unknown> } {
    const a = this.get(id);
    if (!a || a.type !== 'webhook') return { status: 404, body: { error: 'not found' } };
    if (!a.secret || key !== a.secret) return { status: 403, body: { error: 'bad key' } };
    if (!a.enabled) return { status: 409, body: { error: 'automation is disabled' } };
    let extra: string | undefined;
    if (payload !== undefined && payload !== null && Object.keys(payload as object).length > 0) {
      extra = 'Webhook payload:\n' + JSON.stringify(payload, null, 2).slice(0, MAX_PAYLOAD_CHARS);
    }
    const r = this.fire(a, { guard: true, extra });
    if (!r.ok) return { status: 429, body: { error: r.reason } };
    return { status: 200, body: { ok: true, sessionId: r.sessionId } };
  }

  /**
   * Inbound Composio trigger (signature already verified upstream): fire every enabled `composio`
   * automation whose `filter` matches the event's trigger slug ('' or '*' = any). Event-driven, so
   * it does NOT apply the pile-up guard (each message fires its own run). Returns the sessions started.
   */
  fireComposio(event: { triggerSlug: string; summary: string; raw: unknown }): { fired: number; sessions: string[] } {
    const slug = (event.triggerSlug || '').toUpperCase();
    const sessions: string[] = [];
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'composio') continue;
      const f = (a.filter || '').toUpperCase();
      if (f && f !== '*' && f !== slug) continue;
      const extra =
        `Composio trigger: ${slug || 'event'}\n${event.summary}\n\n` +
        `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
      const r = this.fire(a, { guard: false, extra });
      if (r.ok) sessions.push(r.sessionId);
    }
    return { fired: sessions.length, sessions };
  }

  /**
   * Inbound native Slack message (Socket Mode; the bot was @-mentioned or DMed). Fire every enabled
   * `slack` automation whose `filter` matches the event type or channel ('' / '*' = any). `runAsMember`
   * (resolved from the Slack user's email upstream) runs the session AS that member — per-member tools
   * + inbox; absent → the company identity. Event-driven, so no pile-up guard. Returns sessions started.
   */
  async fireSlack(
    event: { eventType: string; channel: string; threadTs: string; user: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): Promise<{ fired: number; sessions: string[]; reply?: string }> {
    const sessions: string[] = [];
    const extra =
      `Triggered from Slack by ${event.actorLabel} (${event.eventType}) in channel ${event.channel}` +
      (event.threadTs ? ` (thread ${event.threadTs})` : '') + `.\n` +
      `Message:\n${event.text}\n\n` +
      `When you're done, call the \`slack_reply\` tool with your answer — it posts back to this exact ` +
      `Slack thread (you don't need a channel id). Keep it concise.\n\n` +
      `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'slack') continue;
      const f = (a.filter || '').trim().toLowerCase();
      if (f && f !== '*' && f !== event.eventType.toLowerCase() && f !== event.channel.toLowerCase()) continue;
      const r = this.fire(a, { guard: false, extra, runAs: runAsMember, slack: { channel: event.channel, threadTs: event.threadTs } });
      if (r.ok) sessions.push(r.sessionId);
    }
    // No specific automation matched → the shared chat front door: resolve a pending disambiguation,
    // honour an explicit `/name`, else auto-route (route / ask / help list) — reachable fleet-wide.
    let reply: string | undefined;
    if (sessions.length === 0) {
      const r = await this.routeUnmatched({
        key: `slack:${event.channel}:${event.threadTs || event.channel}`,
        text: event.text,
        extra,
        runAs: runAsMember,
        slack: { channel: event.channel, threadTs: event.threadTs },
      });
      sessions.push(...r.sessions);
      reply = r.reply;
    }
    return { fired: sessions.length, sessions, reply };
  }

  /**
   * Post a message into a task's **Discussion** and fan out its `@mentions` (the one entry point shared by
   * the console route and the `task_say` MCP tool — see `docs/task-rooms-plan.md`). Stores the message
   * (quiet — excluded from the Inbox feed), then for each mention: an **agent** is resumed/spawned bound to
   * the task ({@link continueTaskThread}); a **member** gets an addressed Inbox card + DM. Returns the stored
   * entry plus what escalation happened, so the caller can report it.
   */
  postTaskDiscussion(input: { taskId: string; author: string; agent?: string; body: string; runAs?: string }):
    { ok: boolean; error?: string; entry?: TaskTimelineEntry; mentionedMembers?: string[]; agentRuns?: { agent: string; status: string; sessionId?: string }[]; delivery?: TaskDiscussionDelivery } {
    const t = this.os.tasks.get(input.taskId);
    if (!t) return { ok: false, error: 'task not found' };
    const body = (input.body || '').trim();
    if (!body) return { ok: false, error: 'message is required' };
    const entry = this.tm.postTaskMessage({ taskId: input.taskId, author: input.author, agent: input.agent, body });
    const byAgent = input.agent ?? 'system';
    const authorLabel = input.agent ?? (this.os.team.getMember(input.author)?.name ?? input.author);
    const mentionedMembers: string[] = [];
    const agentRuns: { agent: string; status: string; sessionId?: string }[] = [];
    const mentions = entry.kind === 'chat' ? entry.mentions : [];
    for (const tok of mentions) {
      if (this.os.agents.has(tok)) {
        if (input.agent && tok === input.agent) continue; // don't pull an agent into its own message
        // Continue the agent ALREADY on this task (its own live/resumable session); otherwise it's a
        // NON-owner agent — don't spawn silently, ask the human (Quick answer vs New session).
        const boundAgent = t.lastSessionId ? this.tm.sessionAgent(t.lastSessionId) : undefined;
        if (boundAgent === tok) {
          const r = this.continueTaskThread(input.taskId, authorLabel, body, tok, input.runAs ?? t.owner ?? undefined);
          agentRuns.push({ agent: tok, status: r.status, sessionId: r.sessionId });
        } else {
          const human = input.author.includes(':') ? (t.owner ?? '') : input.author;
          this.tm.postMentionChoice(input.taskId, tok, body, human);
          agentRuns.push({ agent: tok, status: 'asked' });
        }
        continue;
      }
      const m = this.tm.memberForMention(tok);
      if (m && m.id !== input.author && !mentionedMembers.includes(m.id)) {
        this.tm.mentionMember(input.taskId, byAgent, m.id, body);
        mentionedMembers.push(m.id);
      }
    }
    // A human's plain reply REACHES the agent working the task — not just the discussion log. An @mention
    // already routed this message itself (continueTaskThread / a mention choice), so only an unrouted
    // message falls through to here.
    const delivery = input.agent || agentRuns.length ? undefined
      : this.deliverDiscussionToRun(input.taskId, body, authorLabel, input.author);
    return { ok: true, entry, mentionedMembers, agentRuns, delivery };
  }

  /**
   * The sessions a task-discussion message can be delivered INTO right now: every run bound to the task
   * whose pane is still alive. Usually 0 or 1 — the dispatcher's pile-up guard keeps one worker per task —
   * but >1 is reachable (a second agent pulled in by an `@mention`, or a human-started run alongside the
   * dispatched one), which is exactly the case the caller has to ask a human about rather than guess.
   */
  liveTaskRuns(taskId: string): { sessionId: string; agent: string; blocked: boolean }[] {
    return this.tm.taskRuns(taskId)
      .filter((r) => r.alive && !r.archived)
      .map((r) => ({ sessionId: r.id, agent: r.agent, blocked: Boolean(this.tm.pendingQuestionFor(r.id)) }));
  }

  /**
   * Route a plain human discussion message into the run that's actually working the task.
   *
   * Before this, a reply typed into the room only reached the agent when it happened to be BLOCKED on an
   * `ask` — any other message sat in the timeline until the agent next read `task_get`, which for a
   * mid-turn run is never. The room is where the work is watched, so the reply has to reach the worker.
   *
   * - a **pending question** on the target run is answered (that unblocks the turn; typing free text
   *   would just queue behind the still-open ask),
   * - otherwise the message is typed into the live pane ({@link TerminalManager.deliverToResident} —
   *   an idle claude runs it now, a busy one queues it to the next turn boundary),
   * - **two or more live runs** → deliver to NONE of them and hand the choice back to the caller, who
   *   asks the human which run they meant; the pick comes back as `deliverTo`.
   *
   * The discussion entry is stored either way — delivery is a side channel onto the durable record, so a
   * failed or declined delivery never loses the message. That's also why the human's pick comes back
   * through THIS method with an explicit `deliverTo` (via `POST /api/tasks/:id/deliver`) rather than by
   * re-posting the message: the message is already on the record, only the delivery was deferred.
   */
  deliverDiscussionToRun(taskId: string, body: string, authorLabel: string, author: string, deliverTo?: string): TaskDiscussionDelivery {
    const live = this.liveTaskRuns(taskId);
    if (!live.length) return { status: 'none' };
    // An explicit pick that has since ended: say so rather than silently retargeting the other run.
    const target = deliverTo ? live.find((r) => r.sessionId === deliverTo) : live.length === 1 ? live[0] : undefined;
    if (!target) return deliverTo ? { status: 'stale' } : { status: 'choose', runs: live };
    const emit = (status: string) => this.os.audit.append({
      ts: Date.now(), runId: target.sessionId, tenant: this.os.tenant, principal: author,
      type: 'task.discussion.delivered', data: { taskId, agent: target.agent, session: target.sessionId, status, chars: body.length },
    });
    const qid = this.tm.pendingQuestionFor(target.sessionId);
    if (qid) {
      this.tm.answerQuestion(qid, body, this.os.team.getMember(author)?.email ?? author);
      emit('answered');
      return { status: 'answered', sessionId: target.sessionId, agent: target.agent };
    }
    // Same prefix the dispatch prompt taught this agent to recognise (roomBlock), so a message arriving
    // mid-turn is unambiguously "a human in the room said this", not stray input.
    if (this.tm.deliverToResident(target.sessionId, `${DISCUSSION_PREFIX} ${authorLabel}: ${body} (reply with task_say({ id: "${taskId}", message: "…" }))`)) {
      emit('delivered');
      return { status: 'delivered', sessionId: target.sessionId, agent: target.agent };
    }
    emit('undeliverable');
    return { status: 'undeliverable', sessionId: target.sessionId, agent: target.agent };
  }

  /**
   * A QUICK, out-of-band answer from a non-owner agent (the "Answer" choice on an @mention) — an ephemeral
   * headless delegate (provenance `ask:<taskId>`, NOT bound to the task) that reads the task + discussion,
   * posts a concise answer via `task_say`, and exits. It does NOT take over the task (no `markDispatched`).
   */
  quickAnswer(taskId: string, agentId: string, text: string, runAsMember?: string): { ok: boolean; sessionId?: string; reason?: string } {
    const t = this.os.tasks.get(taskId);
    if (!t) return { ok: false, reason: 'task not found' };
    if (!this.os.agents.has(agentId)) return { ok: false, reason: `unknown agent: ${agentId}` };
    const prompt = `You've been asked for a QUICK ANSWER on task ${t.id} ("${t.title}") — you are NOT taking over the task, just answering a question.\n\n` +
      `Read it first with task_get({ id: "${t.id}" }) — it carries the full discussion for context. A teammate asked:\n\n${text}\n\n` +
      `Post a concise, direct answer with task_say({ id: "${t.id}", message: "…" }), then stop. Do not start doing the work.`;
    const s = this.tm.createSession(agentId, `Answer · ${t.title}`, prompt, `ask:${t.id}`, true, undefined, undefined, t.owner, undefined, false);
    this.os.audit.append({ ts: Date.now(), runId: s.id, tenant: this.os.tenant, principal: runAsMember ? `member:${runAsMember}` : 'system', type: 'task.mention.answer', data: { taskId, agent: agentId, session: s.id } });
    return { ok: true, sessionId: s.id };
  }

  /**
   * `@agent` in a task Discussion → put that agent on the task, reusing the thread-continuity engine
   * (the task's `last_session_id` is the binding a Slack/Discord thread table provides). Live session for
   * this agent → deliver into it; a dead-but-resumable one → revive the SAME transcript; otherwise spawn a
   * fresh governed session bound to the task (`task:<id>` provenance, run-as the owner). The agent replies
   * back into the Discussion via `task_say` / its rerouted `report`/`update`. Sibling of
   * {@link continueSlackThread}.
   */
  continueTaskThread(taskId: string, authorLabel: string, text: string, agentId: string, runAsMember?: string):
    { status: 'delivered' | 'revived' | 'spawned' | 'none'; sessionId?: string } {
    const t = this.os.tasks.get(taskId);
    if (!t || !this.os.agents.has(agentId)) return { status: 'none' };
    const runAs = runAsMember ?? t.owner ?? undefined;
    const liveMsg = `${DISCUSSION_PREFIX} ${authorLabel}: ${text} (reply with task_say({ id: "${taskId}", message: "…" }))`;
    const boundId = t.lastSessionId;
    const boundAgent = boundId ? this.tm.sessionAgent(boundId) : undefined;
    const emit = (mode: string, session: string) => this.os.audit.append({
      ts: Date.now(), runId: session, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'system', type: 'task.mention',
      data: { mode, taskId, agent: agentId, session },
    });
    if (boundId && boundAgent === agentId) {
      if (this.tm.deliverToResident(boundId, liveMsg)) { emit('delivered', boundId); return { status: 'delivered', sessionId: boundId }; }
      if (this.tm.reviveResident(boundId, liveMsg, runAs)) { emit('revived', boundId); return { status: 'revived', sessionId: boundId }; }
      // Delivery failed but the run is STILL WORKING: spawning a second agent onto the same task is how a
      // "stand down" ends up executed by a fresh run while the original keeps building (northwind
      // 2026-08-06). Report the failure instead of duplicating the worker.
      if (this.tm.reachable(boundId)) { emit('undeliverable', boundId); return { status: 'none', sessionId: boundId }; }
    }
    const seed = buildTaskPrompt({ id: t.id, title: t.title, body: t.body, criteria: t.criteria }) +
      `\n\nA teammate pulled you into the discussion:\n${authorLabel}: ${text}\n\nReply in the discussion with task_say({ id: "${t.id}", message: "…" }).`;
    const s = this.tm.createSession(agentId, `Task: ${t.title}`, seed, `task:${t.id}`, t.mode !== 'interactive', undefined, undefined, t.owner, undefined, false);
    this.os.tasks.markDispatched(t.id, s.id);
    emit('spawned', s.id);
    return { status: 'spawned', sessionId: s.id };
  }

  /**
   * Thread continuity: a follow-up message inside a Slack thread already bound to a session CONTINUES
   * that conversation with the same agent — not the `/agent` router (which would answer a plain "ok, now
   * do X" with a help list). We keep ONE warm resident session per thread:
   *   - **delivered**: the session is live → type the message straight into the running claude (send-keys).
   *     Fast (no cold reload), and no new Sessions row.
   *   - **revived**:   the session was reaped/ended (idle) → revive the SAME row, `--resume`ing the claude
   *     transcript, seeded with the message. Still one row per thread; context preserved.
   *   - **none**:      nothing resumable is bound (the first message in a thread) → the caller falls through
   *     to the normal fireSlack path (fresh spawn / router).
   * The socket posts no ack — the agent's own `slack_reply` is the feedback.
   */
  continueSlackThread(
    event: { channel: string; threadTs: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { status: 'delivered' | 'revived' | 'none'; sessionId?: string } {
    if (!event.threadTs) return { status: 'none' };
    const bound = this.tm.sessionForSlackThread(event.channel, event.threadTs);
    if (!bound || !bound.claudeSessionId) return { status: 'none' }; // unbound / unresumable → fresh spawn
    // Explicit `/other-agent …` in the thread overrides continuity → let the caller spawn it fresh.
    if (this.redirectsToOtherAgent(event.text, bound.agent)) return { status: 'none' };
    // Continuation identity is whoever sent THIS follow-up (accountable human for this turn), falling back
    // to the original run-as when the sender is unmapped.
    const runAs = runAsMember ?? bound.runAs;
    // The delivered message goes straight into a live TUI — strip a leading `/agent` (a re-mention) so
    // claude doesn't see it as a slash command, and drop mention tokens.
    const msg = this.stripChatPrefix(event.text);
    if (!msg) return { status: 'none' };
    const emit = (mode: 'delivered' | 'revived') => this.os.audit.append({
      ts: Date.now(), runId: bound.sessionId, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'chat', type: 'chat.continued',
      data: { mode, agent: bound.agent, session: bound.sessionId, channel: event.channel, thread: event.threadTs, runAs: runAs ?? null },
    });
    // Warm path: live resident session → deliver by typing into it.
    if (this.tm.deliverToResident(bound.sessionId, msg)) { emit('delivered'); return { status: 'delivered', sessionId: bound.sessionId }; }
    // Cold path: reaped/ended → revive the SAME row (resume transcript, seeded with the message).
    if (this.tm.reviveResident(bound.sessionId, msg, runAs)) { emit('revived'); return { status: 'revived', sessionId: bound.sessionId }; }
    return { status: 'none' };
  }

  /**
   * DM continuity: a reply to a DM the OS sent someone ABOUT a run goes back INTO that run. The
   * thread-continuity engine ({@link continueSlackThread}) keyed on channel+thread; in a DM there is no
   * thread, so the `session_dms` binding written when we pinged them is the key.
   *
   * This closes the last one-way notification channel. `ask_human` and approvals were already answerable
   * from the DM (`answerQuestionFromChat` / `decideApprovalFromChat`), but every OTHER push — an agent's
   * `notify`, "your run finished / crashed" — left the human pinged with nowhere to reply: their answer
   * either vanished or, worse, spawned a FRESH session that knew nothing about the run that asked. Same
   * three outcomes as its sibling:
   *   - **delivered**: the session is live → type the message straight into the running claude.
   *   - **revived**:   reaped/ended → revive the SAME row, `--resume`ing the transcript, seeded with it.
   *   - **none**:      nothing bound / stale / unresumable / an explicit `/other-agent` redirect → the
   *     caller falls through to the approval, question and router paths exactly as before.
   * The caller acks on success: unlike a thread (where the agent's own `slack_reply` is the visible
   * feedback) a console-spawned run has no chat egress until it relaunches, so silence would read as the
   * reply being swallowed all over again.
   */
  continueSessionDm(
    provider: 'slack' | 'discord' | 'telegram',
    externalId: string,
    event: { actorLabel: string; text: string; channel: string },
    runAsMember?: string,
  ): { status: 'delivered' | 'revived' | 'none'; sessionId?: string; agent?: string } {
    const bound = this.tm.sessionForDm(provider, externalId);
    if (!bound || !bound.claudeSessionId) return { status: 'none' };
    // An explicit `/other-agent …` is the human starting something else, not continuing this — let the
    // router have it (same override thread continuity honours).
    if (this.redirectsToOtherAgent(event.text, bound.agent)) return { status: 'none' };
    const runAs = runAsMember ?? bound.runAs;
    const msg = this.stripChatPrefix(event.text);
    if (!msg) return { status: 'none' };
    const emit = (mode: 'delivered' | 'revived') => this.os.audit.append({
      ts: Date.now(), runId: bound.sessionId, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'chat', type: 'chat.continued',
      data: { mode, via: 'dm', platform: provider, agent: bound.agent, session: bound.sessionId, runAs: runAs ?? null },
    });
    // Point the run's chat egress at this DM so its answer lands where the human is talking (no-op if it
    // already replies somewhere). Warm path: bind after the fact — the mirror reads the binding at send
    // time. Cold path: bind BEFORE the revive, because `reviveResident` derives the session's
    // `slack_reply`/`discord_reply` env flags from exactly these tables, and env can't be changed after
    // launch. Only a run we actually continue gets bound.
    if (this.tm.deliverToResident(bound.sessionId, msg)) {
      this.tm.bindReplyChannel(bound.sessionId, provider, event.channel);
      emit('delivered');
      return { status: 'delivered', sessionId: bound.sessionId, agent: bound.agent };
    }
    this.tm.bindReplyChannel(bound.sessionId, provider, event.channel);
    if (this.tm.reviveResident(bound.sessionId, msg, runAs)) { emit('revived'); return { status: 'revived', sessionId: bound.sessionId, agent: bound.agent }; }
    return { status: 'none' };
  }

  /**
   * Discord thread continuity — the exact analogue of {@link continueSlackThread}. A message inside a
   * guild thread already bound to a session CONTINUES that conversation (deliver into the live claude, or
   * revive the row) instead of hitting the `/agent` router with a fresh spawn. Keyed on the thread's
   * channel id (the socket binds the session to the thread it branched at spawn). `none` → nothing
   * resumable is bound → the caller falls through to a fresh spawn. The socket posts no ack; the agent's
   * own `discord_reply` is the feedback.
   */
  continueDiscordThread(
    event: { channel: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { status: 'delivered' | 'revived' | 'none'; sessionId?: string } {
    const bound = this.tm.sessionForDiscordThread(event.channel);
    if (!bound || !bound.claudeSessionId) return { status: 'none' }; // unbound / unresumable → fresh spawn
    // Explicit `/other-agent …` in the thread overrides continuity → let the caller spawn it fresh.
    if (this.redirectsToOtherAgent(event.text, bound.agent)) return { status: 'none' };
    const runAs = runAsMember ?? bound.runAs;
    const msg = this.stripChatPrefix(event.text);
    if (!msg) return { status: 'none' };
    const emit = (mode: 'delivered' | 'revived') => this.os.audit.append({
      ts: Date.now(), runId: bound.sessionId, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'chat', type: 'chat.continued',
      data: { mode, platform: 'discord', agent: bound.agent, session: bound.sessionId, channel: event.channel, runAs: runAs ?? null },
    });
    // Warm path: live resident session → deliver by typing into it.
    if (this.tm.deliverToResident(bound.sessionId, msg)) { emit('delivered'); return { status: 'delivered', sessionId: bound.sessionId }; }
    // Cold path: reaped/ended → revive the SAME row (resume transcript, seeded with the message).
    if (this.tm.reviveResident(bound.sessionId, msg, runAs)) { emit('revived'); return { status: 'revived', sessionId: bound.sessionId }; }
    return { status: 'none' };
  }

  /**
   * Inbound native ClickUp comment (webhook; a `/agentname` comment was posted on a task). ClickUp's
   * Automation webhook carries NO comment text, so the caller (the `/hooks/clickup` route) fetches the
   * latest comment via the API and passes it here. The webhook-source analogue of {@link fireSlack}: fire
   * every enabled `clickup` automation whose `filter` matches the task id ('' / '*' = any), else the shared
   * `/agentname` chat front door (so any agent is reachable — `/ceoagent <request>` — with no per-agent
   * automation). `runAsMember` (the commenter's email → member, resolved upstream) runs the session AS that
   * member; absent → the company identity. Event-driven, so no pile-up guard. Returns sessions started.
   */
  async fireClickup(
    event: { taskId: string; commentId: string; text: string; taskUrl: string; actorLabel: string; raw: unknown },
    runAsMember?: string,
  ): Promise<{ fired: number; sessions: string[]; reply?: string }> {
    const sessions: string[] = [];
    const bind = { taskId: event.taskId, commentId: event.commentId };
    const extra =
      `Triggered from ClickUp by ${event.actorLabel} on task ${event.taskId} (${event.taskUrl}).\n` +
      `Comment (the user's request):\n${event.text}\n\n` +
      `Do this IN ORDER:\n` +
      `1. FIRST fetch the FULL task details for context — the ClickUp task DESCRIPTION holds the real ` +
      `content (customer email / "Cx:" fields, issue details, links, stack traces), not just this comment. ` +
      `Use your ClickUp tooling / the ClickUp API on task ${event.taskId}.\n` +
      `2. Do the work the comment asks, honouring your CLAUDE.md workflow + all guardrails.\n` +
      `3. Post your result back by calling the \`clickup_reply\` tool — it comments on THIS exact task ` +
      `(you don't pass a task id). ClickUp comments are plain text (no markdown). Keep it concise.\n` +
      `This task already exists and IS your tracking task — comment on it; do NOT create a new/duplicate task.\n\n` +
      `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'clickup') continue;
      const f = (a.filter || '').trim().toLowerCase();
      if (f && f !== '*' && f !== event.taskId.toLowerCase()) continue;
      const r = this.fire(a, { guard: false, extra, runAs: runAsMember, clickup: bind });
      if (r.ok) sessions.push(r.sessionId);
    }
    // No specific automation matched → the shared chat front door (explicit `/name` / auto-route / help).
    let reply: string | undefined;
    if (sessions.length === 0) {
      const r = await this.routeUnmatched({ key: `clickup:${event.taskId}`, text: event.text, extra, runAs: runAsMember, clickup: bind });
      sessions.push(...r.sessions);
      reply = r.reply;
    }
    return { fired: sessions.length, sessions, reply };
  }

  /**
   * ClickUp thread continuity — the analogue of {@link continueSlackThread}, keyed on the task id (the
   * natural ClickUp "thread"). A follow-up `/agentname` comment on a task already bound to a session
   * CONTINUES that conversation (deliver into the live claude, or revive the row) instead of a fresh spawn.
   * `none` → nothing resumable is bound (the first command on the task) → the caller falls through to
   * {@link fireClickup}. The route posts no ack — the agent's own `clickup_reply` is the feedback.
   */
  continueClickupThread(
    event: { taskId: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { status: 'delivered' | 'revived' | 'none'; sessionId?: string } {
    const bound = this.tm.sessionForClickupThread(event.taskId);
    if (!bound || !bound.claudeSessionId) return { status: 'none' }; // unbound / unresumable → fresh spawn
    // Explicit `/other-agent …` on a shared task overrides continuity → let the caller spawn it fresh.
    if (this.redirectsToOtherAgent(event.text, bound.agent)) return { status: 'none' };
    const runAs = runAsMember ?? bound.runAs;
    const msg = this.stripChatPrefix(event.text);
    if (!msg) return { status: 'none' };
    const emit = (mode: 'delivered' | 'revived') => this.os.audit.append({
      ts: Date.now(), runId: bound.sessionId, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'chat', type: 'chat.continued',
      data: { mode, platform: 'clickup', agent: bound.agent, session: bound.sessionId, task: event.taskId, runAs: runAs ?? null },
    });
    // Warm path: live resident session → deliver by typing into it.
    if (this.tm.deliverToResident(bound.sessionId, msg)) { emit('delivered'); return { status: 'delivered', sessionId: bound.sessionId }; }
    // Cold path: reaped/ended → revive the SAME row (resume transcript, seeded with the comment).
    if (this.tm.reviveResident(bound.sessionId, msg, runAs)) { emit('revived'); return { status: 'revived', sessionId: bound.sessionId }; }
    return { status: 'none' };
  }

  /**
   * Inbound DM that might be answering a pending `ask_human` question: if the sender (`provider` + their
   * `externalId`) has a still-pending question we DM'd them, record the reply as its answer and return the
   * asking agent. `null` → nothing pending is bound to them, so the caller falls through to the normal chat
   * router (a DM that isn't answering a question is just a chat). The socket posts the ack.
   */
  answerQuestionFromChat(provider: 'slack' | 'discord' | 'telegram', externalId: string, text: string): { agent: string } | null {
    return this.tm.answerQuestionFromChat(provider, externalId, text);
  }

  /**
   * Inbound DM that might be resolving a pending approval: if the sender has a still-pending approval we
   * DM'd them, read the reply as an approve/deny and settle the gate. The approval-side twin of
   * {@link answerQuestionFromChat}. `null` → nothing bound (fall through to the question/chat router);
   * `unclear`/`forbidden` → bound but the socket should nudge instead of falling through. The socket posts
   * the ack. See {@link TerminalManager.decideApprovalFromChat}.
   */
  decideApprovalFromChat(provider: 'slack' | 'discord' | 'telegram', externalId: string, text: string) {
    return this.tm.decideApprovalFromChat(provider, externalId, text);
  }

  /** Strip a leading `/agent` router prefix (only when it names a known agent) and any `<@…>` mention
   *  tokens from a follow-up before it's typed into a live claude — so a re-mention doesn't land as a
   *  slash command. Returns the cleaned message (never undefined). */
  private stripChatPrefix(text: string): string {
    const t = this.normalizeChatCommand((text || '').replace(/<@[^>]+>/g, '')).trim();
    const m = t.match(/^\/([A-Za-z0-9][\w-]*)\s+([\s\S]*)$/);
    if (m && this.os.agents.has(m[1])) return m[2].trim();
    return t;
  }

  /** True when a follow-up explicitly addresses a DIFFERENT known agent than the one bound to this
   *  thread — a deliberate hand-off. Continuity must then DECLINE so the caller spawns the named agent
   *  fresh, rather than delivering "/other-agent …" into the wrong live session. Critical in ClickUp's
   *  SHARED comment space, where `/infra-ops …` and `/migration-ops …` land on the same task; a plain
   *  follow-up (no `/agent` prefix, or one naming the SAME agent / a non-agent slash) still continues. */
  private redirectsToOtherAgent(text: string, boundAgent: string): boolean {
    const m = this.normalizeChatCommand((text || '').replace(/<@[^>]+>/g, '')).trim().match(/^\/([A-Za-z0-9][\w-]*)\b/);
    return !!m && m[1] !== boundAgent && this.os.agents.has(m[1]);
  }

  /**
   * Inbound native Discord message (Gateway; the bot was @-mentioned or DMed). The exact analogue of
   * `fireSlack`: fire every enabled `discord` automation whose `filter` matches the event type or
   * channel ('' / '*' = any). `runAsMember` runs the session AS that member; absent → the company
   * identity (the current default for Discord — see DiscordSocket.resolveMember). No pile-up guard.
   */
  async fireDiscord(
    event: { eventType: string; channel: string; messageId: string; user: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): Promise<{ fired: number; sessions: string[]; reply?: string }> {
    const sessions: string[] = [];
    const extra =
      `Triggered from Discord by ${event.actorLabel} (${event.eventType}) in channel ${event.channel}.\n` +
      `Message:\n${event.text}\n\n` +
      `When you're done, call the \`discord_reply\` tool with your answer — it posts back to this exact ` +
      `Discord channel as a reply (you don't need a channel id). Keep it concise.\n\n` +
      `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'discord') continue;
      const f = (a.filter || '').trim().toLowerCase();
      if (f && f !== '*' && f !== event.eventType.toLowerCase() && f !== event.channel.toLowerCase()) continue;
      const r = this.fire(a, { guard: false, extra, runAs: runAsMember, discord: { channel: event.channel, messageId: event.messageId } });
      if (r.ok) sessions.push(r.sessionId);
    }
    // No specific automation matched → the shared chat front door (auto-route / disambiguate / help).
    // See fireSlack. Discord threads are keyed by channel id (the socket binds the branched thread).
    let reply: string | undefined;
    if (sessions.length === 0) {
      const r = await this.routeUnmatched({
        key: `discord:${event.channel}`,
        text: event.text,
        extra,
        runAs: runAsMember,
        discord: { channel: event.channel, messageId: event.messageId },
      });
      sessions.push(...r.sessions);
      reply = r.reply;
    }
    return { fired: sessions.length, sessions, reply };
  }

  /**
   * Inbound native Telegram message (long poll; the bot was @-mentioned / commanded in a group or sent a
   * private-chat message). The exact analogue of {@link fireDiscord}: fire every enabled `telegram`
   * automation whose `filter` matches the event type or chat id ('' / '*' = any). `runAsMember` runs the
   * session AS that member (Telegram user id → member via the identity map); absent → the company identity.
   * No pile-up guard. Telegram bots can't branch a thread off a message, so the run is bound to the chat
   * (+ forum topic) and replies land there as a reply to the triggering message.
   */
  async fireTelegram(
    event: { eventType: string; chat: string; messageThreadId: string; messageId: string; user: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): Promise<{ fired: number; sessions: string[]; reply?: string }> {
    const sessions: string[] = [];
    const bind = { chat: event.chat, messageThreadId: event.messageThreadId, messageId: event.messageId };
    const extra =
      `Triggered from Telegram by ${event.actorLabel} (${event.eventType}) in chat ${event.chat}.\n` +
      `Message:\n${event.text}\n\n` +
      `When you're done, call the \`telegram_reply\` tool with your answer — it posts back to this exact ` +
      `Telegram chat as a reply (you don't need a chat id). Keep it concise.\n\n` +
      `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'telegram') continue;
      const f = (a.filter || '').trim().toLowerCase();
      if (f && f !== '*' && f !== event.eventType.toLowerCase() && f !== event.chat.toLowerCase()) continue;
      const r = this.fire(a, { guard: false, extra, runAs: runAsMember, telegram: bind });
      if (r.ok) sessions.push(r.sessionId);
    }
    // No specific automation matched → the shared chat front door (auto-route / disambiguate / help).
    // Telegram threads are keyed by chat id (+ forum topic); a plain follow-up continues via continueTelegramThread.
    let reply: string | undefined;
    if (sessions.length === 0) {
      const r = await this.routeUnmatched({
        key: `telegram:${event.chat}:${event.messageThreadId}`,
        text: event.text,
        extra,
        runAs: runAsMember,
        telegram: bind,
      });
      sessions.push(...r.sessions);
      reply = r.reply;
    }
    return { fired: sessions.length, sessions, reply };
  }

  /**
   * Telegram thread continuity — the analogue of {@link continueDiscordThread}, keyed on the chat id (+
   * forum topic id). A follow-up message in a group chat already bound to a session CONTINUES that
   * conversation (deliver into the live claude, or revive the row) instead of hitting the `/agent` router
   * with a fresh spawn. `none` → nothing resumable is bound → the caller falls through to a fresh spawn.
   * The socket posts no ack; the agent's own `telegram_reply` is the feedback. (Requires Group Privacy
   * disabled in @BotFather for the plain follow-up to reach the bot at all.)
   */
  continueTelegramThread(
    event: { chat: string; messageThreadId: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { status: 'delivered' | 'revived' | 'none'; sessionId?: string } {
    const bound = this.tm.sessionForTelegramThread(event.chat, event.messageThreadId);
    if (!bound || !bound.claudeSessionId) return { status: 'none' }; // unbound / unresumable → fresh spawn
    if (this.redirectsToOtherAgent(event.text, bound.agent)) return { status: 'none' };
    const runAs = runAsMember ?? bound.runAs;
    const msg = this.stripChatPrefix(event.text);
    if (!msg) return { status: 'none' };
    const emit = (mode: 'delivered' | 'revived') => this.os.audit.append({
      ts: Date.now(), runId: bound.sessionId, tenant: this.os.tenant,
      principal: runAs ? `member:${runAs}` : 'chat', type: 'chat.continued',
      data: { mode, platform: 'telegram', agent: bound.agent, session: bound.sessionId, chat: event.chat, runAs: runAs ?? null },
    });
    if (this.tm.deliverToResident(bound.sessionId, msg)) { emit('delivered'); return { status: 'delivered', sessionId: bound.sessionId }; }
    if (this.tm.reviveResident(bound.sessionId, msg, runAs)) { emit('revived'); return { status: 'revived', sessionId: bound.sessionId }; }
    return { status: 'none' };
  }

  /**
   * End the conversation bound to a Telegram chat (+ forum topic) — the `/new` reset. Stops any live run
   * and detaches every reply binding for the chat, so the caller's NEXT message starts a FRESH session
   * instead of continuing/reviving the last one. Returns whether a session was actually closed (for the ack).
   */
  resetTelegramChat(chat: string, messageThreadId: string): { closed: boolean; agent?: string } {
    const bound = this.tm.sessionForTelegramThread(chat, messageThreadId || '');
    if (bound) {
      try { this.tm.stopSession(bound.sessionId, 'telegram', 'user started a new conversation'); } catch { /* going away regardless */ }
    }
    this.tm.clearTelegramBinding(chat, messageThreadId || '');
    return { closed: !!bound, agent: bound?.agent };
  }

  // ── scheduler ──────────────────────────────────────────────────────────────────
  /** Check every ~20s; fire each due cron automation at most once per matching minute. */
  start(intervalMs = 20_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(new Date()), intervalMs);
    this.timer.unref?.(); // never keep the process alive just for the scheduler
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The effective whole-box concurrency cap, resolved LIVE each tick so an operator change takes effect
   * without a restart. Order: `AOS_MAX_CONCURRENT_SESSIONS` env override → operator Settings value →
   * RAM-derived default. Returns `0` for UNLIMITED (env or Settings explicitly set to 0). Single source
   * of truth — the scheduler cap AND the Settings observability route both read this. Phase 2 will reuse
   * it for the chat/webhook admission gate (`admit()`). See docs/concurrency-cap-plan.md.
   */
  concurrencyCap(): number {
    const env = process.env.AOS_MAX_CONCURRENT_SESSIONS;
    if (env !== undefined && env.trim() !== '') {
      const n = Number(env);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n); // env wins; 0 = unlimited
    }
    const setting = this.os.settings.maxConcurrentSessions();
    if (setting != null) return setting;                      // operator value; 0 = unlimited
    return derivedConcurrencyCap();                           // RAM-based default
  }

  /** One scheduler pass — public so tests (and a future "catch-up" boot pass) can drive it. */
  tick(now: Date): void {
    // Advance any in-flight async video renders (poll → ingest on completion). Fire-and-forget: it's
    // async, tick is sync, and a poll error must never break the scheduler loop.
    void this.tm.pollVideoJobs().catch(() => {});
    // Whole-box concurrency cap (#137). Count sessions already alive and stop firing NEW scheduler spawns
    // once we hit the ceiling. A deferred spawn isn't stamped `lastFiredAt` (and a `once` isn't disabled),
    // so it retries next tick: a `once`/`task` stays due indefinitely; a `cron` is retried only within its
    // catch-up window (see the cron branch below). No queue needed. 0 = unlimited. The cap is now ON by
    // default (RAM-derived) rather than opt-in — resolved live so a Settings change needs no restart.
    const cap = this.concurrencyCap();
    let running = cap > 0 ? this.tm.aliveSessionCount() : 0;
    let deferred = 0;
    const overCap = (): boolean => cap > 0 && running >= cap;
    for (const a of this.list()) {
      if (!a.enabled) continue;
      // One-shot deferred tasks: fire once when due, then disable so they never re-fire.
      if (a.type === 'once') {
        if (!a.runAt || a.lastFiredAt || now.getTime() < a.runAt) continue;
        if (overCap()) { deferred++; continue; } // over cap → leave enabled; retry next tick
        try {
          this.fire(a, { guard: false, runAs: a.runAs, resumeClaudeId: a.resumeClaudeId });
          running++;
        } catch {
          // a one-shot that errors on spawn shouldn't loop forever — fall through and disable it
        }
        this.db.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(a.id);
        continue;
      }
      if (a.type !== 'cron' || !a.schedule) continue;
      let spec: CronSpec;
      try {
        spec = parseCron(a.schedule);
      } catch {
        continue; // validated at write time; never let one bad row kill the loop
      }
      // Which scheduled occurrence (if any) is currently OWED — usually this very minute, but an OLDER one
      // when a prior tick deferred it over the cap or the box was down through its minute. Without this a
      // cron only ever fires in its exact minute: hit the cap or a restart there and it's silently dropped
      // until the next day (the real cause of the "not firing for 3 days" report on a chronically over-cap
      // box). The catch-up window bounds the retry so a long outage can't unleash stale/backlogged runs.
      const due = recentCronOccurrence(spec, now, CRON_CATCHUP_MIN);
      if (due == null) continue;                                                   // nothing due within the window
      if (a.lastFiredAt && Math.floor(a.lastFiredAt / 60_000) >= Math.floor(due / 60_000)) continue; // that occurrence already ran
      if (overCap()) { deferred++; continue; } // over cap → not stamped; retried next tick until the window closes
      // Bind the automation's run-as member (like the `once` branch) so a cron spawn acts under that
      // identity — its personal Composio/connectors are injected instead of the company-only fallback.
      const r = this.fire(a, { guard: true, runAs: a.runAs });
      if (r.ok) running++;
    }
    // Tasks share the same budget — dispatch only up to the remaining headroom (Infinity when uncapped).
    this.dispatchTasks(cap > 0 ? Math.max(0, cap - running) : Infinity);
    if (deferred > 0) {
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'scheduler', type: 'scheduler.deferred', data: { deferred, cap, running } });
    }
    this.sweepOverdue(now);
    this.sweepStranded(now, cap > 0 ? Math.max(0, cap - running) : Infinity);
    this.sweepStuckGoals(now);
    this.sweepCompletedGoals();
    this.sweepExpiredShares(now);
    // Re-nudge stale human-in-the-loop prompts (approvals/questions blocking an agent) so a missed ask
    // doesn't strand the run forever. Wrapped so a bad row can't take down the scheduler.
    try { this.stalePromptSweeper?.(now.getTime()); } catch { /* best-effort, never kills the tick */ }
  }

  /**
   * Auto-revoke public artifact links past their 7-day TTL — the "public forever" guard. The link
   * already stops resolving at expiry (ArtifactStore.getByToken rejects it); this clears the token from
   * the row so it's genuinely gone (and can be re-minted fresh). Wrapped so a bad row never kills the loop.
   */
  private sweepExpiredShares(now: Date): void {
    try {
      for (const id of this.os.artifacts.expirePublicShares(now.getTime())) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'system', type: 'artifact.share.expired', data: { id } });
      }
    } catch {
      // never let the share-expiry sweep take down the automation scheduler
    }
  }

  /**
   * Phase 2 — the goal auto-planner. When opted in (Settings), find active goals with no open work that
   * have sat idle past the grace window and run the strategist to draft/refresh a plan (file-only — it
   * never dispatches). Bounded by a per-tick cap, a per-goal cooldown (the last `goal.planned` audit),
   * and the whole-box concurrency cap, so it can't spam or burst sessions. Wrapped so a bad row never
   * kills the scheduler; a no-op unless the toggle is on. Decoupled from Dreaming — a plain data check.
   */
  private sweepStuckGoals(now: Date): void {
    if (!this.os.settings.autoPlanGoals()) return;
    try {
      const cap = this.concurrencyCap();
      let spawned = 0;
      for (const g of this.os.goals.stuck(this.os.tenant, GOAL_AUTOPLAN_GRACE_MS, now.getTime())) {
        if (spawned >= GOAL_AUTOPLAN_MAX_PER_TICK) break;
        if (cap > 0 && this.tm.aliveSessionCount() >= cap) break; // respect the whole-box concurrency cap
        const last = this.db
          .prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'goal.planned' AND data LIKE ?")
          .get<{ t: number | null }>(`%"goalId":"${g.id}"%`);
        if (last?.t && now.getTime() - last.t < GOAL_REPLAN_COOLDOWN_MS) continue; // recently planned — cool down
        spawned++; // count optimistically to bound the per-tick burst
        void new Strategist(this.os, this.tm)
          .plan(g.id, 'automation:goal-planner', g.owner)
          .then((r) => {
            if (r.spawned) {
              this.os.audit.append({ ts: Date.now(), runId: r.sessionId ?? '-', tenant: this.os.tenant, principal: 'automation:goal-planner', type: 'goal.autoplanned', data: { goalId: g.id, title: g.title } });
            }
          })
          .catch(() => { /* a failed auto-plan must never take down the scheduler */ });
      }
    } catch {
      // never let the goal sweep take down the automation scheduler
    }
  }

  /**
   * The completion half of the goal sweep: a goal whose every linked task has finished is DONE-in-fact but
   * still says `active`, because only a human closes a goal. Announce it exactly once (the once-guard lives
   * in `goal_events`, so a restart never re-alarms) so the owner gets an inbox card + DM rather than having
   * to notice a full progress bar on a page nobody visits daily.
   *
   * Always on and cheap — unlike {@link sweepStuckGoals} this spawns nothing, it just tells a human their
   * goal is finished. Wrapped so a bad row never kills the scheduler.
   */
  private sweepCompletedGoals(): void {
    try {
      for (const g of this.os.goals.readyToClose(this.os.tenant)) {
        if (!this.os.goals.announceReady(g.id)) continue; // already announced this completion streak
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'system', type: 'goal.ready', data: { goalId: g.id, title: g.title } });
      }
    } catch {
      // never let the completion sweep take down the automation scheduler
    }
  }

  /**
   * The deadline half of the tick: DM the owner of each newly-overdue task, exactly once. The once-guard
   * lives in the DB (`markOverdueNotified`), so a restart never re-alarms. Wrapped so a bad row never
   * kills the scheduler; a no-op when no overdue notifier is wired.
   */
  /**
   * Close the delegation loop when a delegate's RUN ends but its TASK doesn't. The poke-back that wakes a
   * delegating caller hangs off the task reaching done/blocked, so a delegate that finishes (or dies)
   * without calling `task_update` strands the task AND leaves the caller waiting forever — 14% of
   * agent→agent hand-offs on a busy tenant. This is the fallback: reconcile a run that reported success,
   * and wake the caller for everything else. Shares the tick's concurrency headroom, since a poke to a
   * caller with no live session resumes it in a fresh run. See {@link sweepStrandedTasks}.
   */
  private sweepStranded(now: Date, budget: number): void {
    try {
      const r = sweepStrandedTasks(this.os, this, { now: now.getTime(), budget });
      if (r.poked || r.closed) {
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'scheduler', type: 'tasks.reconciled', data: { closed: r.closed, poked: r.poked, marked: r.marked } });
      }
    } catch {
      // never let the stranded-task sweep take down the automation scheduler
    }
  }

  private sweepOverdue(now: Date): void {
    if (!this.overdueNotifier) return;
    try {
      for (const t of this.os.tasks.overdue(this.os.tenant, now.getTime())) {
        if (!this.os.tasks.markOverdueNotified(t.id)) continue;
        this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'system', type: 'task.overdue', data: { id: t.id, title: t.title, dueAt: t.dueAt ?? null } });
        try { this.overdueNotifier(t); } catch { /* notifier best-effort */ }
      }
    } catch {
      // never let the overdue sweep take down the automation scheduler
    }
  }

  /**
   * The Tasks half of the tick: auto-dispatch eligible work off the shared board. Scan `todo` tasks with
   * an agent assignee + `auto_dispatch`, highest-priority first, and spawn at most ONE session per agent
   * per tick (don't stack a second on an agent already running a task session — the per-agent concurrency
   * cap). Guarded + attempt-ceilinged inside dispatchTask. Wrapped so a bad row never kills the scheduler.
   */
  private dispatchTasks(budget: number = Infinity): void {
    try {
      if (budget <= 0) return; // whole-box concurrency cap already reached — dispatch nothing this tick
      // Agents already running a task session (their `task:<id>` spawn still has a live claude) — skip this
      // tick. Liveness is the PANE (`reachable`), not the row: a task run that called `report` and is still
      // wrapping up holds the agent's workspace, and stacking a second session on it is the pile-up this
      // guard exists to prevent. Bounded — the idle sweep's DONE-ORPHAN branch reaps exactly these panes,
      // and a human forcing a dispatch passes `guard: false`.
      const busy = new Set<string>();
      for (const r of this.db
        .prepare("SELECT id, agent FROM term_sessions WHERE spawned_by LIKE 'task:%' AND status IN ('running','done')")
        .all<{ id: string; agent: string }>()) {
        if (this.tm.reachable(r.id)) busy.add(r.agent);
      }
      for (const t of this.os.tasks.dispatchable(this.os.tenant)) {
        if (budget <= 0) break; // hit the concurrency cap mid-drain — the rest retry next tick
        const agentId = t.assignee!.slice('agent:'.length);
        if (busy.has(agentId)) continue;
        const r = this.dispatchTask(t.id, { guard: true });
        if (r.ok) { busy.add(agentId); budget--; } // one per agent per tick, and one off the cap budget
      }
    } catch {
      // never let the task sweep take down the automation scheduler
    }
  }
}
