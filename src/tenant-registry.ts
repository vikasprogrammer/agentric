/**
 * TenantRegistry — runs MANY tenants in ONE process. Each tenant gets a full, isolated runtime
 * (its own AgentOS + DB + tmux socket + ttyd + cron scheduler + Slack socket), exactly what
 * `startServer` used to build for a single tenant. The HTTP server resolves the tenant per request
 * (subdomain, or the loopback `x-aos-tenant` header) and dispatches into that tenant's runtime, so
 * all existing single-tenant logic runs unchanged inside each instance.
 *
 * The list of tenants lives in the control-plane DB (`src/state/control.ts`). The DEFAULT tenant
 * (config `tenant`) keeps the legacy un-nested home, so existing installs need no migration; every
 * other tenant nests under `<home>/tenants/<slug>/`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { AgentOS, loadAgentOS, readRootConfig, RootConfig } from './kernel';
import { exampleCapabilities } from './capabilities/examples';
import { TerminalManager, ApprovalNotice, QuestionNotice, MemberNotice, SessionEventNotice } from './terminal';
import { Automations } from './edge/automations';
import { AppSupervisor } from './edge/app-supervisor';
import { InsightAlert } from './edge/alerts';
import { SlackSocket } from './edge/slack-socket';
import { DiscordSocket } from './edge/discord-socket';
import { Member, Task } from './types';
import { TaskNotice } from './state/tasks';
import { Audience, approvalAudience, resolveRecipients } from './governance/recipients';
import { ChatPlatform, chatLink, consolePage } from './governance/chat-links';
import { controlHome, resolvePaths, resolveTenantPaths } from './home';
import { TenantRecord, TenantStore } from './state/control';

export interface TenantRuntime {
  record: TenantRecord;
  os: AgentOS;
  tm: TerminalManager;
  autos: Automations;
  apps: AppSupervisor;
  slack: SlackSocket;
  discord: DiscordSocket;
  ttyd: ChildProcess | null;
  ttydPort: number;
  /** The owner's one-time login token, set only when this build seeded a fresh tenant DB. */
  firstLogin?: string;
}

export class TenantRegistry {
  private readonly cfg: RootConfig;
  private readonly store: TenantStore;
  private readonly runtimes = new Map<string, TenantRuntime>();
  private readonly defaultSlug: string;
  /** Loopback base every in-session agent call hits; the tenant is carried in `x-aos-tenant`. */
  private readonly loopbackBase: string;
  /** Next ttyd port for a non-default tenant (default keeps PORT+1 / TTYD_PORT for back-compat). */
  private nextTtydPort: number;

  constructor(
    private readonly baseDir: string,
    private readonly basePort: number,
    private readonly configPath = 'config/agent-os.config.json',
  ) {
    this.cfg = readRootConfig(configPath, baseDir);
    // The process's tenant id. `AGENT_OS_TENANT` overrides the repo config's `tenant`, so the
    // process-per-tenant model can run many self-contained instances off one repo: each gets its
    // own AGENT_OS_HOME + AGENT_OS_TENANT + PORT (see docs/process-per-tenant.md). The registry is
    // dormant in that mode — one tenant at the apex host, no subdomain/path routing needed.
    this.defaultSlug = process.env.AGENT_OS_TENANT || this.cfg.tenant;
    this.store = new TenantStore(path.join(controlHome(baseDir, this.cfg), 'control.db'));
    this.loopbackBase = `http://127.0.0.1:${basePort}`;
    this.nextTtydPort = basePort + 1000;
  }

  /** Build every known tenant's runtime. Seeds the default tenant on a fresh control plane. */
  bootAll(): void {
    if (!this.store.get(this.defaultSlug)) {
      const ownerEmail = process.env.AGENT_OS_OWNER_EMAIL || 'owner@localhost';
      this.store.create({ slug: this.defaultSlug, ownerEmail, displayName: this.defaultSlug, skipValidation: true });
    }
    for (const rec of this.store.list()) {
      try {
        this.runtimes.set(rec.slug, this.build(rec));
      } catch (e) {
        console.error(`[tenant:${rec.slug}] failed to start: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  get(slug: string): TenantRuntime | undefined {
    return this.runtimes.get(slug);
  }
  /** The default/seed tenant's runtime — the fallback when a request carries no tenant signal. */
  default(): TenantRuntime | undefined {
    return this.runtimes.get(this.defaultSlug);
  }
  isDefault(slug: string): boolean {
    return slug === this.defaultSlug;
  }

  /**
   * Map a request Host header to a tenant slug. With `baseDomain` configured, `<slug>.<base>` → slug
   * and the apex (or `www.`) → '' (the default tenant) — so the prod apex host is never mistaken for
   * a tenant. Without `baseDomain` (local dev), `<slug>.localhost` → slug and a bare host → default.
   * Returns '' to mean "no tenant signal → use the default tenant".
   */
  slugForHost(host: string): string {
    const hostname = String(host || '').split(':')[0].trim().toLowerCase();
    if (!hostname) return '';
    const base = this.cfg.baseDomain?.toLowerCase();
    if (base) {
      if (hostname === base || hostname === `www.${base}`) return '';
      if (hostname.endsWith(`.${base}`)) return hostname.slice(0, -(base.length + 1)).split('.')[0];
      return ''; // unrecognised host → default tenant
    }
    // No baseDomain configured = local dev: only `<slug>.localhost` is a tenant. An IP literal,
    // bare `localhost`, or any real domain → '' (default tenant). Prod MUST set baseDomain to route
    // by subdomain — this guard stops arbitrary Host headers from conjuring a tenant.
    if (hostname.endsWith('.localhost')) {
      const sub = hostname.slice(0, -'.localhost'.length);
      if (sub && sub !== 'www') return sub.split('.')[0];
    }
    return '';
  }
  list(): TenantRecord[] {
    return this.store.list();
  }
  forEach(fn: (rt: TenantRuntime) => void): void {
    for (const rt of this.runtimes.values()) fn(rt);
  }

  /** Provision a NEW tenant: persist it, build its runtime, and return its owner's one-time link. */
  create(input: { slug: string; ownerEmail: string; displayName?: string }): { record: TenantRecord; loginUrl?: string } {
    const rec = this.store.create(input); // throws on invalid/reserved/duplicate slug
    let runtime: TenantRuntime;
    try {
      runtime = this.build(rec);
    } catch (e) {
      this.store.remove(rec.slug); // don't leave a half-provisioned tenant in the registry
      throw e;
    }
    this.runtimes.set(rec.slug, runtime);
    return { record: rec, loginUrl: runtime.firstLogin ? this.loginUrl(rec.slug, runtime.firstLogin) : undefined };
  }

  /** Tear down a tenant's runtime (does NOT delete its data on disk — that stays for recovery). */
  remove(slug: string): boolean {
    if (this.isDefault(slug)) throw new Error('cannot remove the default tenant');
    const rt = this.runtimes.get(slug);
    if (rt) {
      try { rt.ttyd?.kill(); } catch { /* best-effort */ }
      try { rt.slack.stop(); } catch { /* best-effort */ }
      try { rt.discord.stop(); } catch { /* best-effort */ }
      try { rt.autos.stop(); } catch { /* best-effort */ }
      try { rt.apps.stop(); } catch { /* best-effort */ }
      this.runtimes.delete(slug);
    }
    return this.store.remove(slug);
  }

  /** Stop every tenant's background services + ttyd (process shutdown). */
  stopAll(): void {
    for (const rt of this.runtimes.values()) {
      try { rt.ttyd?.kill(); } catch { /* best-effort */ }
      try { rt.slack.stop(); } catch { /* best-effort */ }
      try { rt.discord.stop(); } catch { /* best-effort */ }
      try { rt.autos.stop(); } catch { /* best-effort */ }
      try { rt.apps.stop(); } catch { /* best-effort */ }
    }
  }

  /** Build one tenant's full runtime — the per-tenant half of what `startServer` once did inline. */
  private build(rec: TenantRecord): TenantRuntime {
    const isDefault = this.isDefault(rec.slug);
    const paths = isDefault ? resolvePaths(this.baseDir, this.cfg) : resolveTenantPaths(this.baseDir, this.cfg, rec.slug);
    fs.mkdirSync(paths.home, { recursive: true });
    fs.mkdirSync(paths.audit, { recursive: true });
    fs.mkdirSync(paths.skills, { recursive: true });

    // Human label: AGENT_OS_TENANT_NAME (process-per-tenant) wins, else the control-plane display name.
    const tenantName = process.env.AGENT_OS_TENANT_NAME || rec.displayName;
    const os = loadAgentOS(this.configPath, this.baseDir, { tenant: rec.slug, tenantName, paths });
    os.registerCapabilities(exampleCapabilities);

    const firstLogin = os.team.bootstrapOwner(rec.ownerEmail, 'Owner');
    if (firstLogin) {
      const link = this.loginUrl(rec.slug, firstLogin);
      console.log(`\n  ► First-run owner login (tenant ${rec.slug}, ${rec.ownerEmail}):\n    ${link}\n`);
      try { fs.appendFileSync(paths.logFile, `[${new Date().toISOString()}] owner login link: ${link}\n`); } catch { /* best-effort */ }
    }

    const ttydPort = isDefault ? (Number(process.env.TTYD_PORT) || this.basePort + 1) : this.nextTtydPort++;
    // The tenant's public console origin — resolved once here (no request Host in a background DM) and
    // closed over by every notifier so its deep-links point at the deployment's REAL external URL.
    const consoleOrigin = this.consoleOrigin(rec.slug);
    const tm = new TerminalManager(os, this.loopbackBase, paths.tmuxSocket, consoleOrigin);
    const autos = new Automations(os, tm);
    autos.start();
    // Hosted apps: the supervisor spawns each app on demand + idle-reaps it. In-session/app loopback
    // calls carry the tenant via x-aos-tenant, so it's exported into every app's env.
    const apps = new AppSupervisor(os.apps, { loopbackBase: this.loopbackBase, tenant: rec.slug });
    apps.start();
    const slack = new SlackSocket(os, autos);
    void slack.start();
    const discord = new DiscordSocket(os, autos);
    void discord.start();
    // Chat approval notifications (M5): when a risky action lands an approval card, DM whoever can
    // approve it — via their linked Slack/Discord account (identity map). Best-effort, off the hot path.
    tm.setApprovalNotifier((notice) => { void notifyApprovers(os, slack, discord, consoleOrigin, notice); });
    // Question notifications: when an agent asks the human a question, DM the person the run acts for so
    // a blocking `ask` doesn't sit unseen until it times out — the question-side twin of the above.
    tm.setQuestionNotifier((notice) => { void notifyQuestionAsked(os, tm, slack, discord, consoleOrigin, notice); });
    // Chat loop: mirror completions/questions/approvals back to the Slack/Discord thread a chat-triggered
    // run is bound to. `text` is a per-platform builder so an embedded deep-link uses each platform's
    // masked-link syntax. Both replies no-op when the session has no bound thread (non-chat runs).
    tm.setChatMirror((sessionId, text) => {
      const render = (p: ChatPlatform) => (typeof text === 'function' ? text(p) : text);
      void slack.reply(sessionId, render('slack'));
      void discord.reply(sessionId, render('discord'));
    });
    // Deadline notifications: when a task passes its due date, DM its owner (the human it runs as) once,
    // so a missed deadline surfaces off the board. Owner-less → owner/admins. Mirrors the question path.
    autos.setOverdueNotifier((task) => { void notifyTaskOverdue(os, slack, discord, consoleOrigin, task); });
    // Task lifecycle → Inbox: a create/assign/status change lands an audience-addressed inbox card for
    // the right human (assignee/owner) — routed via resolveRecipients — and DMs them. Fires for EVERY
    // mutation path (console, agent MCP, dispatcher) because the sink lives on the store, not the routes.
    os.tasks.setNotifier((notice) => {
      void notifyTaskEvent(os, tm, slack, discord, consoleOrigin, notice);
      // Async poke-back: a delegate that closed a `poke_on_done` hand-off resumes the CALLER agent's
      // transcript with the outcome, so a fire-and-forget delegation wakes the caller (no polling).
      maybePokeCaller(autos, os, notice);
    });
    // Agent → teammate: when an agent uses the `notify` tool, the inbox card is written inline (addressed
    // to the target member); this sink DMs that member on their linked Slack/Discord too.
    tm.setMemberNotifier((notice) => { void notifyMember(os, slack, discord, notice); });
    // Session lifecycle → chat: when one of a member's sessions starts waiting / finishes / crashes, DM
    // the run's owner IF they opted into `dm` notifications (default off — the inbox bell already covers
    // it). The complete/waiting/crashed twin of the always-on approval/question DMs above.
    tm.setSessionEventNotifier((notice) => { void notifySessionEvent(os, slack, discord, consoleOrigin, notice); });
    const ttyd = launchTtyd(paths.tmuxSocket, ttydPort, paths.connectors);
    console.log(`  [tenant:${rec.slug}] home=${paths.home}  ttyd=:${ttydPort}`);
    return { record: rec, os, tm, autos, apps, slack, discord, ttyd, ttydPort, firstLogin: firstLogin ?? undefined };
  }

  /** Build a tenant's accept-link. Default tenant → apex localhost; others → its subdomain. */
  loginUrl(slug: string, token: string): string {
    if (this.isDefault(slug)) return `http://localhost:${this.basePort}/accept?token=${token}`;
    if (this.cfg.baseDomain) return `https://${slug}.${this.cfg.baseDomain}/accept?token=${token}`;
    return `http://${slug}.localhost:${this.basePort}/accept?token=${token}`;
  }

  /**
   * The public origin (`scheme://host[:port]`, no trailing slash) of a tenant's console — the base for
   * deep-links in out-of-band chat DMs, which fire from a background scheduler/gate with no request Host
   * to derive from. Priority: `AGENT_OS_PUBLIC_URL` env / config `publicUrl` (the deployment's REAL
   * external URL, e.g. a Tailscale name) pins the seed tenant's origin; a `baseDomain` gives every other
   * tenant its own subdomain; otherwise a localhost dev fallback (links open only on the box but stay
   * clickable). Unlike `loginUrl`, this prefers the pinned URL for the default tenant so a deployed box
   * whose real host is NOT localhost still emits reachable links.
   */
  consoleOrigin(slug: string): string {
    const pinned = (process.env.AGENT_OS_PUBLIC_URL || this.cfg.publicUrl || '').trim().replace(/\/+$/, '');
    if (this.isDefault(slug)) return pinned || (this.cfg.baseDomain ? `https://${this.cfg.baseDomain}` : `http://localhost:${this.basePort}`);
    if (this.cfg.baseDomain) return `https://${slug}.${this.cfg.baseDomain}`;
    return pinned || `http://${slug}.localhost:${this.basePort}`;
  }
}

/**
 * Deliver one text to a resolved member set over each member's linked Slack/Discord account (identity
 * map), best-effort. The single copy of the identity-map DM loop the three notifiers used to inline;
 * returns the delivered-DM count for the caller's audit line. Recipient resolution is NOT done here —
 * callers pass an already-resolved set (see {@link resolveRecipients}) so WHO and HOW-to-reach stay
 * separate concerns.
 */
async function deliverDM(slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, os: AgentOS, recipients: Member[], text: string | ((platform: ChatPlatform) => string)): Promise<number> {
  // `text` may be a per-platform builder so a message can carry a masked deep-link, whose syntax differs
  // between Slack mrkdwn (`<url|label>`) and Discord markdown (`[label](url)`). A plain string is sent as-is.
  const render = (platform: ChatPlatform) => (typeof text === 'function' ? text(platform) : text);
  let dms = 0;
  for (const m of recipients) {
    const ids = os.team.externalIdsFor(m.id);
    const slackId = ids.find((i) => i.provider === 'slack')?.externalId;
    const discordId = ids.find((i) => i.provider === 'discord')?.externalId;
    if (slackId && (await slack.dmUser(slackId, render('slack'))).ok) dms++;
    if (discordId && (await discord.dmUser(discordId, render('discord'))).ok) dms++;
  }
  return dms;
}

/**
 * DM a member their own freshly-minted sign-in link, on their linked Slack/Discord account — the
 * delivery half of the self-service "email me a link" recovery path (server.ts `POST
 * /api/auth/request-link`). Best-effort; the caller ALSO logs the link to server.log so an owner with
 * box access can always recover even with no chat identity linked. Returns the delivered-DM count.
 */
export async function notifyLoginLink(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, member: Member, link: string): Promise<number> {
  const text =
    `🔑 Your Agent OS sign-in link (valid 7 days, single use):\n${link}\n` +
    `If you didn't request this, you can ignore it — the link is harmless until it's opened.`;
  const dms = await deliverDM(slack, discord, os, [member], text);
  os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'auth.link.notified', data: { member: member.id, dms } });
  return dms;
}

/**
 * DM everyone who can approve a freshly-raised approval, on their linked Slack/Discord account. Best-
 * effort: the approvers set comes from the {@link resolveRecipients} `approvers` audience
 * (`canApprove(role, level)`); `deliverDM` reaches them via the identity map. Off the gate's hot path
 * (the caller fires-and-forgets). Audited once.
 */
export async function notifyApprovers(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, notice: ApprovalNotice): Promise<void> {
  // Route to the SAME audience the inbox card uses (approvalAudience): the session owner alone when they
  // can clear this level (an admin self-approving their own run), else the full approver tier — so we
  // stop DMing every admin about every other admin's self-approvable session.
  const approvers = resolveRecipients(os, approvalAudience(os, notice.sessionId, notice.level));
  if (!approvers.length) return;
  // Plain text + backticks render fine in both Slack mrkdwn and Discord markdown (no */** ambiguity).
  const dot = notice.riskClass === 'red' ? '🔴' : '🟡';
  const inbox = consolePage(consoleOrigin, 'inbox');
  const text = (p: ChatPlatform) =>
    `${dot} ${notice.riskClass.toUpperCase()} approval needed — \`${notice.capability}\` (${notice.level}) requested by agent ${notice.agent}.` +
    (notice.reason ? `\nwhy: ${notice.reason}` : '') +
    `\nOpen the ${chatLink(p, inbox, 'Agent OS Inbox')} to approve or reject.`;
  const dms = await deliverDM(slack, discord, os, approvers, text);
  os.audit.append({ ts: Date.now(), runId: notice.sessionId, tenant: os.tenant, principal: 'system', type: 'approval.notified', data: { capability: notice.capability, level: notice.level, approvers: approvers.length, dms } });
}

/**
 * DM the human a blocking agent question is waiting on, on their linked Slack/Discord account — the
 * question-side twin of {@link notifyApprovers}. Targets the `sessionOwner` audience (the run's `run_as`,
 * else a member who spawned it); if the run has no human owner (a pure automation), falls back to the
 * `admins` audience so the question still reaches someone. Best-effort, off the ask hot path. Audited once.
 */
export async function notifyQuestionAsked(os: AgentOS, tm: Pick<TerminalManager, 'bindQuestionDm'>, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, notice: QuestionNotice): Promise<void> {
  // A question `ask`ed to a SPECIFIC teammate DMs that member; otherwise the run's operator.
  let targets = resolveRecipients(os, notice.to ? { kind: 'member', id: notice.to } : { kind: 'sessionOwner', id: notice.sessionId });
  if (!targets.length) targets = resolveRecipients(os, { kind: 'admins' });
  if (!targets.length) return;
  // Bind the question to each recipient's DM channel so they can answer by REPLYING to the DM (the reply
  // is matched back to this question on inbound — see TerminalManager.answerQuestionFromChat).
  for (const t of targets) {
    const ids = os.team.externalIdsFor(t.id);
    const slackId = ids.find((i) => i.provider === 'slack')?.externalId;
    const discordId = ids.find((i) => i.provider === 'discord')?.externalId;
    if (slackId) tm.bindQuestionDm(notice.questionId, 'slack', slackId, t.id);
    if (discordId) tm.bindQuestionDm(notice.questionId, 'discord', discordId, t.id);
  }
  const inbox = consolePage(consoleOrigin, 'inbox');
  const text = (p: ChatPlatform) =>
    `❓ Agent ${notice.agent} is waiting on your answer:\n${notice.prompt}` +
    `\n\n*Reply to this message to answer*, or open the ${chatLink(p, inbox, 'Agent OS Inbox')}.`;
  const dms = await deliverDM(slack, discord, os, targets, text);
  os.audit.append({ ts: Date.now(), runId: notice.sessionId, tenant: os.tenant, principal: 'system', type: 'question.notified', data: { agent: notice.agent, targets: targets.length, dms } });
}

/**
 * DM the owner of a task that just passed its due date, on their linked Slack/Discord account — the
 * deadline-side sibling of {@link notifyQuestionAsked}. Targets the task `owner` (the `member` audience);
 * an owner-less (or deleted-owner) task falls back to the `admins` audience so the miss still reaches
 * someone. Best-effort, fired once per task from the scheduler sweep (the once-guard lives in the DB).
 */
export async function notifyTaskOverdue(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, task: Task): Promise<void> {
  let targets = task.owner ? resolveRecipients(os, { kind: 'member', id: task.owner }) : [];
  if (!targets.length) targets = resolveRecipients(os, { kind: 'admins' });
  if (!targets.length) return;
  const due = task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 10) : 'its deadline';
  const url = consolePage(consoleOrigin, 'tasks', task.id);
  const text = (p: ChatPlatform) =>
    `⏰ Task overdue — \`${task.title}\` (${task.id}) passed ${due} and is still ${task.status}.` +
    `\nOpen it in the ${chatLink(p, url, 'Agent OS console')} to reprioritise, reassign, or extend it.`;
  const dms = await deliverDM(slack, discord, os, targets, text);
  os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'task.overdue.notified', data: { id: task.id, targets: targets.length, dms } });
}

/** Is `who` a human teammate (a member id) rather than an agent (`agent:<id>`) or nobody? */
function isHumanMember(who: string | undefined): who is string {
  return !!who && !who.startsWith('agent:');
}

/**
 * Map a {@link TaskNotice} to the inbox card it warrants — WHO should hear about it (an {@link Audience})
 * and the card copy — or `null` when the change doesn't merit a notification. The routing:
 * - **created / assigned** → the human assignee ("assigned to you"); agent/unassigned tasks notify nobody
 *   (an agent-owned task announces itself by dispatching a session, not a card).
 * - **status → blocked** → the owner ("needs you to unblock"); → **done** → the owner ("finished").
 * Actor-suppression (don't notify yourself) is applied by the caller against `notice.by`.
 */
function taskCard(n: TaskNotice): { audience: Audience; title: string; event: string } | null {
  const t = n.task;
  if ((n.kind === 'created' || n.kind === 'assigned') && isHumanMember(t.assignee)) {
    return { audience: { kind: 'member', id: t.assignee }, event: n.kind, title: n.kind === 'created' ? 'New task assigned to you' : 'Task assigned to you' };
  }
  if (n.kind === 'status' && isHumanMember(t.owner)) {
    if (t.status === 'blocked') return { audience: { kind: 'member', id: t.owner }, event: 'blocked', title: 'Task blocked — needs you' };
    if (t.status === 'done') return { audience: { kind: 'member', id: t.owner }, event: 'done', title: 'Task done' };
  }
  return null;
}

/**
 * Task lifecycle → Inbox. Writes an audience-addressed inbox card for the human a task change concerns
 * (assignee/owner) and DMs them on their linked chat account. The card is written SYNCHRONOUSLY (before
 * the awaited DM) so it's durable even if the process exits right after; the DM is best-effort. Skips
 * entirely when the change warrants no card or the only recipient is the actor who made it.
 */
export async function notifyTaskEvent(os: AgentOS, tm: Pick<TerminalManager, 'postTaskCard'>, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, notice: TaskNotice): Promise<void> {
  const card = taskCard(notice);
  if (!card) return;
  // Resolve the receiver, then drop the actor themselves — nobody needs a card for their own action.
  const recipients = resolveRecipients(os, card.audience).filter((m) => m.id !== notice.by);
  if (!recipients.length) return;
  const t = notice.task;
  const agentLabel = t.assignee?.startsWith('agent:') ? t.assignee.slice('agent:'.length) : 'tasks';
  tm.postTaskCard({ taskId: t.id, agent: agentLabel, title: card.title, body: t.title, audience: card.audience, event: card.event });
  // Deep-link straight to the task's permalink (`#/tasks/<id>`), so the DM is one tap from the board.
  const url = consolePage(consoleOrigin, 'tasks', t.id);
  const text = (p: ChatPlatform) => `📋 ${card.title} — \`${t.title}\` (${t.id}).\nOpen it in the ${chatLink(p, url, 'Agent OS console')}.`;
  const dms = await deliverDM(slack, discord, os, recipients, text);
  os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'task.notified', data: { id: t.id, event: card.event, recipients: recipients.length, dms } });
}

/**
 * Async poke-back. When a delegate closes a `poke_on_done` hand-off — the task reaches a terminal-for-now
 * state (done, or blocked and handed back) — resume the CALLER agent's transcript with the outcome, so a
 * fire-and-forget delegation wakes the caller instead of making it poll. No-op unless the task carries a
 * caller + its pinned claude id (only agent→agent hand-offs with poke opted in do). The delegate (assignee)
 * is the actor, so `maybePokeCaller` never wakes the caller for its own edits. Best-effort; the poke itself
 * is guarded (a still-live caller is skipped) inside {@link Automations.pokeCaller}.
 */
function maybePokeCaller(autos: Automations, os: AgentOS, notice: TaskNotice): void {
  if (notice.kind !== 'status') return;
  const t = notice.task;
  if (!t.pokeOnDone || !t.callerAgent || !t.callerClaudeId) return;
  if (t.status !== 'done' && t.status !== 'blocked') return;
  const delegate = t.assignee?.startsWith('agent:') ? t.assignee.slice('agent:'.length) : (t.assignee ?? 'the delegate');
  const note = os.tasks.latestNote(t.id) || '(no note left)';
  const goal = t.criteria ? ` — goal "${t.criteria}"` : '';
  const message = t.status === 'done'
    ? `✅ Really done: ${delegate} finished the task you handed off (${t.id}: "${t.title}")${goal}.\n\n` +
      `Result: ${note}\n\nPick your own work back up from here.`
    : `⛔ Handed back: ${delegate} is BLOCKED on the task you handed off (${t.id}: "${t.title}")${goal}.\n\n` +
      `Why: ${note}\n\nDecide how to proceed — unblock it, re-scope it, or take it on yourself.`;
  autos.pokeCaller({ callerAgent: t.callerAgent, callerClaudeId: t.callerClaudeId, runAs: t.owner, message, source: t.id });
}

/**
 * DM the admins about a proactive insight alert (the Inbox card is posted separately by the tick). The
 * intelligence layer coming to the human — a struggling agent, a capability that keeps getting rejected.
 */
export async function notifyInsightAlert(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, alert: InsightAlert): Promise<void> {
  const recipients = resolveRecipients(os, { kind: 'admins' });
  if (!recipients.length) return;
  const url = consolePage(consoleOrigin, 'insights');
  const icon = alert.severity === 'high' ? '🚨' : '⚠️';
  const text = (p: ChatPlatform) => `${icon} ${alert.title}\n${alert.body}\nOpen ${chatLink(p, url, 'Insights')}.`;
  const dms = await deliverDM(slack, discord, os, recipients, text);
  os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'insights.alert.notified', data: { key: alert.key, recipients: recipients.length, dms } });
}

/**
 * DM the one teammate an agent deliberately notified via the `notify` tool. The inbox card is already
 * written (addressed to that member) by {@link TerminalManager.notifyMember}; this is the out-of-band
 * push to their linked Slack/Discord. Single named recipient — never a broadcast. Best-effort, audited.
 */
export async function notifyMember(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, notice: MemberNotice): Promise<void> {
  const targets = resolveRecipients(os, { kind: 'member', id: notice.to });
  if (!targets.length) return;
  const bell = notice.important ? '❗' : '📨';
  const text = `${bell} Message from agent ${notice.agent}:\n${notice.message}\nOpen the Agent OS console → Inbox.`;
  const dms = await deliverDM(slack, discord, os, targets, text);
  os.audit.append({ ts: Date.now(), runId: notice.sessionId, tenant: os.tenant, principal: 'system', type: 'member.notified', data: { to: notice.to, important: notice.important, dms } });
}

/**
 * DM the owner of a session that just changed state (started waiting / finished / crashed), on their
 * linked Slack/Discord — the lifecycle twin of {@link notifyMember}. Unlike approvals/questions this is
 * OPT-IN: only fires when the run's owner set their `dm` notification preference, since the inbox bell
 * already surfaces every one of these. Targets the `sessionOwner` audience only — a pure automation/task
 * run with no human owner pings nobody (there's no one whose bell it belongs to). Best-effort, audited.
 */
export async function notifySessionEvent(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, consoleOrigin: string, notice: SessionEventNotice): Promise<void> {
  const targets = resolveRecipients(os, { kind: 'sessionOwner', id: notice.sessionId })
    .filter((m) => os.team.notificationPrefs(m.id).dm);
  if (!targets.length) return;
  const icon = notice.kind === 'waiting' ? '🔔' : notice.kind === 'crashed' ? '💥' : '✅';
  const url = consolePage(consoleOrigin, 'sessions');
  const text = (p: ChatPlatform) => `${icon} ${notice.title}\n${notice.message}\nOpen it in the ${chatLink(p, url, 'Agent OS console')}.`;
  const dms = await deliverDM(slack, discord, os, targets, text);
  os.audit.append({ ts: Date.now(), runId: notice.sessionId, tenant: os.tenant, principal: 'system', type: 'session.event.notified', data: { kind: notice.kind, agent: notice.agent, targets: targets.length, dms } });
}

/** Launch a ttyd bound to one tenant's tmux socket on `ttydPort`. (Moved verbatim from server.ts.) */
export function launchTtyd(tmuxSocket: string, ttydPort: number, sessionDir: string): ChildProcess | null {
  try {
    const attach = path.resolve(__dirname, '../terminal/attach.sh');
    const child = spawn(
      'ttyd',
      ['-p', String(ttydPort), '-i', '127.0.0.1', '-b', '/terminal', '-a', '-W',
       // Keep the WS alive through idle proxies (nginx/the app proxy) and auto-reattach after a blip:
       // the tmux session persists, so on reconnect ttyd re-attaches to the live session (the backend
       // even resumes claude in-place — see terminal.ts). Leaving disableReconnect on meant a single
       // dropped socket (laptop sleep, network hiccup, CPU starvation) blanked the terminal until a full
       // page reload, which reads as "the session got killed" even though the agent is still running.
       '-P', '30', '-t', 'disableReconnect=false', '-t', 'disableLeaveAlert=true', '-t', 'fontSize=14',
       // Pass-through xterm.js option: while claude has mouse events active (we keep the wheel for
       // in-app scroll via CLAUDE_CODE_DISABLE_MOUSE_CLICKS), xterm.js disables selection unless the
       // user holds the force-selection modifier — on macOS that's Option, and ONLY when this option
       // is on. Without it there's no way to select text on a Mac, so copy is impossible. ttyd forwards
       // any unknown -t key onto terminal.options[key], so this reaches xterm.js directly.
       '-t', 'macOptionClickForcesSelection=true',
       'bash', attach, tmuxSocket],
      { stdio: 'ignore', env: { ...process.env, AOS_SESSION_DIR: sessionDir } },
    );
    child.on('error', () => console.log('  (ttyd failed to start — browser terminal disabled)'));
    return child;
  } catch {
    return null;
  }
}
