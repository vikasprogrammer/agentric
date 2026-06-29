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
import { AgentOS } from '../kernel';
import { Db } from '../state/db';
import { TerminalManager } from '../terminal';

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
  type: 'cron' | 'webhook' | 'composio' | 'slack';
  /** How the fired session runs (interactive TUI vs headless `claude -p`). */
  mode: ExecMode;
  /** Cron expression (cron type only). */
  schedule?: string;
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
  type: 'cron' | 'webhook' | 'composio' | 'slack';
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
  };
}

export interface AddAutomationInput {
  agentId: string;
  name: string;
  type: 'cron' | 'webhook' | 'composio' | 'slack';
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

export class Automations {
  private readonly db: Db;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly os: AgentOS,
    private readonly tm: TerminalManager,
  ) {
    this.db = os.db;
  }

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
    } else {
      throw new Error('type must be cron, webhook, composio, or slack');
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

  update(id: string, patch: { name?: string; mode?: ExecMode; schedule?: string; task?: string; enabled?: boolean }): Automation | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (patch.schedule !== undefined && a.type === 'cron') parseCron(patch.schedule);
    this.db
      .prepare('UPDATE automations SET name = ?, mode = ?, schedule = ?, task = ?, enabled = ? WHERE id = ?')
      .run(
        patch.name?.trim() || a.name,
        patch.mode ?? a.mode,
        a.type === 'cron' ? (patch.schedule?.trim() ?? a.schedule ?? null) : null,
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
  fire(a: Automation, opts: { guard: boolean; extra?: string; runAs?: string; slack?: { channel: string; threadTs: string } } = { guard: true }): FireResult {
    if (opts.guard && a.lastSessionId && this.tm.isAlive(a.lastSessionId)) {
      return { ok: false, reason: 'previous session still running' };
    }
    const task = opts.extra ? `${a.task}\n\n${opts.extra}` : a.task;
    // run-as: when a trigger resolves the actor to a member (e.g. the Slack user who @-mentioned the
    // bot), spawn the session AS that member so it binds their personal connectors + lands in their
    // inbox. Otherwise the system provenance `automation:<id>` (company entity, no personal creds).
    const spawnedBy = opts.runAs || `automation:${a.id}`;
    const s = this.tm.createSession(a.agentId, a.name, task, spawnedBy, a.mode === 'headless', opts.slack);
    this.db.prepare('UPDATE automations SET last_fired_at = ?, last_session_id = ? WHERE id = ?').run(Date.now(), s.id, a.id);
    this.os.audit.append({
      ts: Date.now(),
      runId: s.id,
      tenant: this.os.tenant,
      principal: opts.runAs ? `member:${opts.runAs}` : `automation:${a.id}`,
      type: 'automation.fired',
      data: { automation: a.id, name: a.name, agent: a.agentId, trigger: a.type, mode: a.mode, runAs: opts.runAs ?? null },
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
  ): { fired: number; sessions: string[] } {
    const sessions: string[] = [];
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'slack') continue;
      const f = (a.filter || '').trim().toLowerCase();
      if (f && f !== '*' && f !== event.eventType.toLowerCase() && f !== event.channel.toLowerCase()) continue;
      const extra =
        `Triggered from Slack by ${event.actorLabel} (${event.eventType}) in channel ${event.channel}` +
        (event.threadTs ? ` (thread ${event.threadTs})` : '') + `.\n` +
        `Message:\n${event.text}\n\n` +
        `When you're done, call the \`slack_reply\` tool with your answer — it posts back to this exact ` +
        `Slack thread (you don't need a channel id). Keep it concise.\n\n` +
        `Event payload:\n${JSON.stringify(event.raw, null, 2).slice(0, MAX_PAYLOAD_CHARS)}`;
      const r = this.fire(a, { guard: false, extra, runAs: runAsMember, slack: { channel: event.channel, threadTs: event.threadTs } });
      if (r.ok) sessions.push(r.sessionId);
    }
    return { fired: sessions.length, sessions };
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
    const minute = Math.floor(now.getTime() / 60_000);
    for (const a of this.list()) {
      if (!a.enabled || a.type !== 'cron' || !a.schedule) continue;
      let spec: CronSpec;
      try {
        spec = parseCron(a.schedule);
      } catch {
        continue; // validated at write time; never let one bad row kill the loop
      }
      if (!cronMatches(spec, now)) continue;
      if (a.lastFiredAt && Math.floor(a.lastFiredAt / 60_000) === minute) continue; // already fired this minute
      this.fire(a, { guard: true });
    }
  }
}
