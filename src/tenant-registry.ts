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
import { TerminalManager, ApprovalNotice } from './terminal';
import { Automations } from './edge/automations';
import { SlackSocket } from './edge/slack-socket';
import { DiscordSocket } from './edge/discord-socket';
import { canApprove } from './types';
import { controlHome, resolvePaths, resolveTenantPaths } from './home';
import { TenantRecord, TenantStore } from './state/control';

export interface TenantRuntime {
  record: TenantRecord;
  os: AgentOS;
  tm: TerminalManager;
  autos: Automations;
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
    const tm = new TerminalManager(os, this.loopbackBase, paths.tmuxSocket);
    const autos = new Automations(os, tm);
    autos.start();
    const slack = new SlackSocket(os, autos);
    void slack.start();
    const discord = new DiscordSocket(os, autos);
    void discord.start();
    // Chat approval notifications (M5): when a risky action lands an approval card, DM whoever can
    // approve it — via their linked Slack/Discord account (identity map). Best-effort, off the hot path.
    tm.setApprovalNotifier((notice) => { void notifyApprovers(os, slack, discord, notice); });
    const ttyd = launchTtyd(paths.tmuxSocket, ttydPort, paths.connectors);
    console.log(`  [tenant:${rec.slug}] home=${paths.home}  ttyd=:${ttydPort}`);
    return { record: rec, os, tm, autos, slack, discord, ttyd, ttydPort, firstLogin: firstLogin ?? undefined };
  }

  /** Build a tenant's accept-link. Default tenant → apex localhost; others → its subdomain. */
  loginUrl(slug: string, token: string): string {
    if (this.isDefault(slug)) return `http://localhost:${this.basePort}/accept?token=${token}`;
    if (this.cfg.baseDomain) return `https://${slug}.${this.cfg.baseDomain}/accept?token=${token}`;
    return `http://${slug}.localhost:${this.basePort}/accept?token=${token}`;
  }
}

/**
 * DM everyone who can approve a freshly-raised approval, on their linked Slack/Discord account. Best-
 * effort: resolves approvers by `canApprove(role, level)`, looks up each one's chat handle in the
 * identity map, and DMs them. Off the gate's hot path (the caller fires-and-forgets). Audited once.
 */
export async function notifyApprovers(os: AgentOS, slack: Pick<SlackSocket, 'dmUser'>, discord: Pick<DiscordSocket, 'dmUser'>, notice: ApprovalNotice): Promise<void> {
  const approvers = os.team.listMembers().filter((m) => m.status === 'active' && canApprove(m.role, notice.level));
  if (!approvers.length) return;
  // Plain text + backticks render fine in both Slack mrkdwn and Discord markdown (no */** ambiguity).
  const text =
    `🔔 Approval needed — \`${notice.capability}\` (${notice.level}) requested by agent ${notice.agent}.` +
    (notice.reason ? `\n${notice.reason}` : '') +
    `\nOpen the Agent OS console → Inbox to approve or reject.`;
  let dms = 0;
  for (const m of approvers) {
    const ids = os.team.externalIdsFor(m.id);
    const slackId = ids.find((i) => i.provider === 'slack')?.externalId;
    const discordId = ids.find((i) => i.provider === 'discord')?.externalId;
    if (slackId && (await slack.dmUser(slackId, text)).ok) dms++;
    if (discordId && (await discord.dmUser(discordId, text)).ok) dms++;
  }
  os.audit.append({ ts: Date.now(), runId: notice.sessionId, tenant: os.tenant, principal: 'system', type: 'approval.notified', data: { capability: notice.capability, level: notice.level, approvers: approvers.length, dms } });
}

/** Launch a ttyd bound to one tenant's tmux socket on `ttydPort`. (Moved verbatim from server.ts.) */
export function launchTtyd(tmuxSocket: string, ttydPort: number, sessionDir: string): ChildProcess | null {
  try {
    const attach = path.resolve(__dirname, '../terminal/attach.sh');
    const child = spawn(
      'ttyd',
      ['-p', String(ttydPort), '-i', '127.0.0.1', '-b', '/terminal', '-a', '-W',
       '-t', 'disableReconnect=true', '-t', 'disableLeaveAlert=true', '-t', 'fontSize=14',
       'bash', attach, tmuxSocket],
      { stdio: 'ignore', env: { ...process.env, AOS_SESSION_DIR: sessionDir } },
    );
    child.on('error', () => console.log('  (ttyd failed to start — browser terminal disabled)'));
    return child;
  } catch {
    return null;
  }
}
