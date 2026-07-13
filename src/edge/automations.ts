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
import { randomBytes, randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { Strategist } from './strategist';
import { AgentOS } from '../kernel';
import { Db } from '../state/db';
import { TerminalManager } from '../terminal';
import { Task } from '../types';

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
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord';
  /** How the fired session runs (interactive TUI vs headless `claude -p`). */
  mode: ExecMode;
  /** Cron expression (cron type only). */
  schedule?: string;
  /** One-shot fire time in epoch ms (`once` type only); disabled after it fires. */
  runAt?: number;
  /** Member id the fired session should act as (`once` type) — carried so a deferred task runs as the
   *  same identity that scheduled it. */
  runAs?: string;
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
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord';
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
  };
}

export interface AddAutomationInput {
  agentId: string;
  name: string;
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord';
  mode?: ExecMode;
  schedule?: string;
  /** composio: trigger slug to match. slack: event type / channel id to match. ('' / omitted = any). */
  filter?: string;
  task: string;
  createdBy?: string;
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
export const TASK_MAX_ATTEMPTS = 3;

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
 */
export function buildTaskPrompt(t: { id: string; title: string; body: string; criteria?: string }, opts: { goalMode?: boolean } = {}): string {
  const converging = !!(opts.goalMode && t.criteria);
  const close = converging
    ? `When you have satisfied the goal above, call task_update({ id: "${t.id}", status: "done", note: "<what you did>" }) in that same turn.\n`
    : `When finished, call task_update({ id: "${t.id}", status: "done", note: "<what you did>" }).\n`;
  const base =
    `You are working task ${t.id}: ${t.title}\n\n` +
    `${t.body || '(no description provided)'}\n\n` +
    close +
    `If you cannot proceed, call task_update({ id: "${t.id}", status: "blocked", note: "<why>" }).\n` +
    `Break large work into sub-tasks with task_create({ parentId: "${t.id}", ... }).`;
  return converging ? `/goal ${t.criteria}\n\n${base}` : base;
}

// `/goal` CLI support (v2.1.139+) is probed + cached in the shared claude-cli module; imported for use
// here and re-exported so existing importers (tests) keep their import path. See goals-plan.md §C.
import { claudeSupportsGoal } from './claude-cli';
export { claudeSupportsGoal };

export class Automations {
  private readonly db: Db;
  private timer?: NodeJS.Timeout;
  // Whole-box concurrency cap: the scheduler stops firing NEW cron/task spawns once this many sessions
  // are alive (defense-in-depth against an OOM-inducing burst — see #137). Interactive/chat spawns are
  // never gated (a human is waiting; a chat spawn has no natural retry). 0 = unlimited (opt-in per box).
  private readonly maxConcurrent = Number(process.env.AOS_MAX_CONCURRENT_SESSIONS) || 0;

  constructor(
    private readonly os: AgentOS,
    private readonly tm: TerminalManager,
  ) {
    this.db = os.db;
  }

  /** Best-effort sink DMed once when a task passes its due date (wired in the tenant registry). */
  private overdueNotifier?: (task: Task) => void;
  setOverdueNotifier(fn: (task: Task) => void): void { this.overdueNotifier = fn; }

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
    } else {
      throw new Error('type must be cron, webhook, composio, slack, or discord');
    }
    const a: Automation = {
      id: 'au_' + randomUUID().slice(0, 8),
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
    };
    this.db
      .prepare('INSERT INTO automations (id, agent_id, name, type, mode, schedule, secret, filter, task, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.name, a.type, a.mode, a.schedule ?? null, a.secret ?? null, a.filter ?? null, a.task, 1, a.createdBy ?? null, a.createdAt);
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
   */
  schedule(input: { agentId: string; name: string; task: string; runAt: number; runAs?: string; createdBy?: string }): Automation {
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
      id: 'au_' + randomUUID().slice(0, 8),
      agentId: input.agentId,
      name: input.name.trim() || 'Scheduled task',
      type: 'once',
      mode: 'headless', // deferred runs are unattended
      task: input.task,
      runAt: input.runAt,
      runAs: input.runAs,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: now,
    };
    this.db
      .prepare('INSERT INTO automations (id, agent_id, name, type, mode, schedule, secret, filter, task, enabled, created_by, created_at, run_at, run_as) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.name, a.type, a.mode, null, null, null, a.task, 1, a.createdBy ?? null, a.createdAt, a.runAt!, a.runAs ?? null);
    return a;
  }

  /** Cancel a pending one-shot, scoped to its agent (an agent may only cancel its own schedules). Returns
   *  false if it doesn't exist, isn't a one-shot for that agent, or has already fired. */
  cancelScheduled(id: string, agentId: string): boolean {
    const a = this.get(id);
    if (!a || a.type !== 'once' || a.agentId !== agentId || a.lastFiredAt) return false;
    return this.remove(id);
  }

  update(id: string, patch: { name?: string; mode?: ExecMode; schedule?: string; filter?: string; task?: string; enabled?: boolean }): Automation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (patch.schedule !== undefined && a.type === 'cron') parseCron(patch.schedule);
    // `filter` is only meaningful for the event-driven triggers; ignore it on cron/webhook/once so an
    // edit can't stamp a stray filter onto a type that never reads one. composio uppercases its slug.
    const filterTypes = a.type === 'composio' || a.type === 'slack' || a.type === 'discord';
    const nextFilter = !filterTypes
      ? a.filter ?? null
      : patch.filter === undefined
        ? a.filter ?? null
        : a.type === 'composio'
          ? patch.filter.trim().toUpperCase()
          : patch.filter.trim();
    this.db
      .prepare('UPDATE automations SET name = ?, mode = ?, schedule = ?, filter = ?, task = ?, enabled = ? WHERE id = ?')
      .run(
        patch.name?.trim() || a.name,
        patch.mode ?? a.mode,
        a.type === 'cron' ? (patch.schedule?.trim() ?? a.schedule ?? null) : null,
        nextFilter,
        patch.task ?? a.task,
        (patch.enabled ?? a.enabled) ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
  }

  // ── firing ─────────────────────────────────────────────────────────────────────
  /**
   * Spawn the automation's session. `guard: true` skips when the previous spawn is still alive —
   * the no-pile-ups rule for cron/webhook; "Run now" from the console passes guard: false.
   */
  fire(a: Automation, opts: { guard: boolean; extra?: string; runAs?: string; mode?: ExecMode; slack?: { channel: string; threadTs: string }; discord?: { channel: string; messageId: string } } = { guard: true }): FireResult {
    if (opts.guard && a.lastSessionId && this.tm.isAlive(a.lastSessionId)) {
      return { ok: false, reason: 'previous session still running' };
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
    const s = this.tm.createSession(a.agentId, a.name, task, spawnedBy, mode === 'headless', opts.slack, opts.discord, opts.runAs);
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
    const agentId = (t.assignee || '').startsWith('agent:') ? t.assignee!.slice('agent:'.length) : '';
    if (!agentId) return { ok: false, reason: 'task has no agent assignee' };
    if (!this.os.agents.has(agentId)) return { ok: false, reason: `unknown agent: ${agentId}` };
    if (guard && t.lastSessionId && this.tm.isAlive(t.lastSessionId)) {
      return { ok: false, reason: 'a session is already working this task' };
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
    const s = this.tm.createSession(agentId, `Task: ${t.title}`, buildTaskPrompt(t, { goalMode }), `task:${t.id}`, t.mode !== 'interactive', undefined, undefined, t.owner);
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
  private routeChat(text: string): { agentId?: string; help?: string } {
    const chatAgents = [...this.os.agents.values()].filter((a) => a.runtime === 'claude-code').map((a) => a.id);
    const m = (text || '').trim().match(/^\/([A-Za-z0-9][\w-]*)\b\s*([\s\S]*)$/);
    if (m && chatAgents.includes(m[1])) return { agentId: m[1] };
    const list = chatAgents.length ? chatAgents.map((id) => `• \`/${id}\``).join('\n') : '_(no agents available)_';
    const help = m
      ? `I don't have an agent named \`/${m[1]}\`. Address one with \`/<agent>\` and your request:\n${list}`
      : `👋 Address an agent with \`/<agent>\` followed by your request. Available:\n${list}`;
    return { help };
  }

  /**
   * Spawn a one-off chat run for an explicitly-addressed agent (the `/name` router) — no automation row.
   * Same governance path as fire(): provenance `chat:<agent>`, run-as the sender, reply bound to the
   * thread, every effect still gated. Audited as `chat.routed`.
   */
  private spawnChatAgent(
    agentId: string,
    task: string,
    opts: { runAs?: string; slack?: { channel: string; threadTs: string }; discord?: { channel: string; messageId: string }; title?: string; resident?: boolean },
  ): FireResult {
    // `resident` (Slack chat) → a warm interactive session (headless off) kept alive for fast follow-ups;
    // otherwise the classic one-shot headless run. `title` is the meaningful, message-derived label.
    const s = this.tm.createSession(
      agentId, opts.title || `Chat → ${agentId}`, task, `chat:${agentId}`,
      !opts.resident, opts.slack, opts.discord, opts.runAs, undefined, !!opts.resident,
    );
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: opts.runAs ? `member:${opts.runAs}` : 'chat',
      type: 'chat.routed',
      data: { agent: agentId, runAs: opts.runAs ?? null, channel: opts.slack?.channel ?? opts.discord?.channel ?? null, resident: !!opts.resident },
    });
    return { ok: true, sessionId: s.id, tmux: s.tmux };
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
  fireSlack(
    event: { eventType: string; channel: string; threadTs: string; user: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { fired: number; sessions: string[]; reply?: string } {
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
    // No specific automation matched → the generic `/agent` router (if enabled) makes the whole fleet
    // reachable without one. A named agent runs; an unaddressed/unknown name gets a help list to post back.
    let reply: string | undefined;
    if (sessions.length === 0 && this.os.settings.chatRouterEnabled()) {
      const routed = this.routeChat(event.text);
      if (routed.agentId) {
        const r = this.spawnChatAgent(routed.agentId, extra, { runAs: runAsMember, slack: { channel: event.channel, threadTs: event.threadTs }, title: chatTitle(event.text, routed.agentId), resident: true });
        if (r.ok) sessions.push(r.sessionId);
      } else {
        reply = routed.help;
      }
    }
    return { fired: sessions.length, sessions, reply };
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

  /** Strip a leading `/agent` router prefix (only when it names a known agent) and any `<@…>` mention
   *  tokens from a follow-up before it's typed into a live claude — so a re-mention doesn't land as a
   *  slash command. Returns the cleaned message (never undefined). */
  private stripChatPrefix(text: string): string {
    const t = (text || '').replace(/<@[^>]+>/g, '').trim();
    const m = t.match(/^\/([A-Za-z0-9][\w-]*)\s+([\s\S]*)$/);
    if (m && this.os.agents.has(m[1])) return m[2].trim();
    return t;
  }

  /**
   * Inbound native Discord message (Gateway; the bot was @-mentioned or DMed). The exact analogue of
   * `fireSlack`: fire every enabled `discord` automation whose `filter` matches the event type or
   * channel ('' / '*' = any). `runAsMember` runs the session AS that member; absent → the company
   * identity (the current default for Discord — see DiscordSocket.resolveMember). No pile-up guard.
   */
  fireDiscord(
    event: { eventType: string; channel: string; messageId: string; user: string; actorLabel: string; text: string; raw: unknown },
    runAsMember?: string,
  ): { fired: number; sessions: string[]; reply?: string } {
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
    // No specific automation matched → the generic `/agent` router (if enabled). See fireSlack.
    let reply: string | undefined;
    if (sessions.length === 0 && this.os.settings.chatRouterEnabled()) {
      const routed = this.routeChat(event.text);
      if (routed.agentId) {
        const r = this.spawnChatAgent(routed.agentId, extra, { runAs: runAsMember, discord: { channel: event.channel, messageId: event.messageId }, title: chatTitle(event.text, routed.agentId) });
        if (r.ok) sessions.push(r.sessionId);
      } else {
        reply = routed.help;
      }
    }
    return { fired: sessions.length, sessions, reply };
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

  /** One scheduler pass — public so tests (and a future "catch-up" boot pass) can drive it. */
  tick(now: Date): void {
    // Advance any in-flight async video renders (poll → ingest on completion). Fire-and-forget: it's
    // async, tick is sync, and a poll error must never break the scheduler loop.
    void this.tm.pollVideoJobs().catch(() => {});
    const minute = Math.floor(now.getTime() / 60_000);
    // Whole-box concurrency cap (#137). When set, count sessions already alive and stop firing NEW
    // scheduler spawns once we hit the ceiling — a deferred cron/one-shot isn't stamped `lastFiredAt`
    // (and a `once` isn't disabled), so it simply RE-FIRES next tick. No queue needed. 0 = unlimited.
    const cap = this.maxConcurrent;
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
          this.fire(a, { guard: false, runAs: a.runAs });
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
      if (!cronMatches(spec, now)) continue;
      if (a.lastFiredAt && Math.floor(a.lastFiredAt / 60_000) === minute) continue; // already fired this minute
      if (overCap()) { deferred++; continue; } // over cap → not stamped, so it re-fires next tick
      const r = this.fire(a, { guard: true });
      if (r.ok) running++;
    }
    // Tasks share the same budget — dispatch only up to the remaining headroom (Infinity when uncapped).
    this.dispatchTasks(cap > 0 ? Math.max(0, cap - running) : Infinity);
    if (deferred > 0) {
      this.os.audit.append({ ts: Date.now(), runId: '-', tenant: this.os.tenant, principal: 'scheduler', type: 'scheduler.deferred', data: { deferred, cap, running } });
    }
    this.sweepOverdue(now);
    this.sweepStuckGoals(now);
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
      const cap = this.maxConcurrent;
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
   * The deadline half of the tick: DM the owner of each newly-overdue task, exactly once. The once-guard
   * lives in the DB (`markOverdueNotified`), so a restart never re-alarms. Wrapped so a bad row never
   * kills the scheduler; a no-op when no overdue notifier is wired.
   */
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
      // Agents already running a task session (their `task:<id>` spawn is still alive) — skip this tick.
      const busy = new Set<string>();
      for (const r of this.db
        .prepare("SELECT id, agent FROM term_sessions WHERE spawned_by LIKE 'task:%' AND status = 'running'")
        .all<{ id: string; agent: string }>()) {
        if (this.tm.isAlive(r.id)) busy.add(r.agent);
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
