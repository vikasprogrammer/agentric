/**
 * Agent OS — local web tool. Zero-dependency HTTP server (Node's built-in `http`) that
 * exposes the OS as a JSON API, serves the browser console, and now hosts terminal-native
 * agent sessions: each session is a real tmux shell, attachable in the browser via ttyd,
 * with every side effect gated through the same Agent OS gateway.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as nodeOs from 'node:os';
import { AgentOS, loadAgentOS } from './kernel';
import { VERSION } from './version';
import { TenantRegistry, TenantRuntime, notifyLoginLink, notifyInsightAlert } from './tenant-registry';
import { pendingAlerts } from './edge/alerts';
import { exampleCapabilities } from './capabilities/examples';
import { evaluate } from './observability/evaluation';
import { TerminalManager, AGENT_OS_OPERATING_NOTES } from './terminal';
import { classifyActivity, clipText, ActivityCategory, ActivityEffect, ActivityTarget } from './state/session-activity';
import { readConversation, type ChatArtifactRef, type ChatKbRef, type ChatAppRef } from './edge/conversation';
import { summarizeConversation } from './edge/summarize';
import { Automation, Automations, nextCronRun, derivedConcurrencyCap, chatTitle } from './edge/automations';
import { SlackSocket } from './edge/slack-socket';
import { DiscordSocket } from './edge/discord-socket';
import { AppSupervisor } from './edge/app-supervisor';
import { DreamingEngine, recommendationResolved } from './edge/dreaming';
import { Consolidation, CONSOLIDATOR_ID } from './edge/consolidation';
import { Digest } from './edge/digest';
import { measureLearning } from './edge/measurement';
import { buildInsights } from './edge/insights';
import { buildImprovements } from './edge/improvements';
import { Diagnosis, ANALYST_ID } from './edge/diagnosis';
import { Improver, proposalSlug, IMPROVER_ID } from './edge/improver';
import { planMemoryCleanup, applyMemoryCleanup, cleanupOpts } from './edge/memory-cleanup';
import { SkillScout, SCOUT_ID } from './edge/skill-scout';
import { planKbTidy, applyKbTidy } from './edge/kb-tidy';
import { Strategist, STRATEGIST_ID } from './edge/strategist';
import { readAgentCatalog, installAgentFromCatalog, BUILTIN_SEED_IDS } from './edge/agent-catalog';
import { checkForUpdate, applyUpdate, restartService } from './edge/updater';
import { checkDeps, installDeps } from './edge/deps';
import { CATALOG, redact } from './connectors/connectors';
import { GithubIdentity } from './edge/github-identity';
import { convertAppManifest, userInstallationStatus } from './connectors/github';
import { redactHost, type HostProtocol, type HostPosture } from './hosts/hosts';
import { listConnectedAccounts, deleteConnectedAccount, listToolkits, serviceUserId, initiateConnection, verifyComposioWebhook, parseComposioEvent } from './connectors/composio';
import { JsonPolicyEngine, PolicyDocument, applyProposal, validatePolicyDocument, withAlwaysAllow } from './governance/policy';
import { PRESET_SOURCES, browseRepo, fetchSkill, searchSkillsh } from './governance/skill-registry';
import { extractSkillsFromZip } from './governance/skill-zip';
import { parseBundle } from './governance/bundle-import';
import { AgentManifest, AppManifest, ApprovalRequest, Branding, EmbeddingsConfig, ENV_NAME, IDENTITY_PROVIDERS, IdentityProvider, isValidAppSlug, Member, MemoryConfig, MemoryMaintenance, MemoryPreload, MemoryRanking, MemoryType, Role, Run, sanitizeAppDomains, sanitizeBranding, sanitizeCategory, sanitizeExamplePrompts, sanitizeIcon, sanitizeRuntimeTuning, sanitizeShellSecrets, TaskStatus, GoalStatus } from './types';
import { AgentConfigSnapshot } from './state/agent-revisions';
import { computeAgentStats, computeAgentStat } from './state/agent-stats';

/** Sum busy + idle CPU tick counters across all cores (for a sampled utilization %). */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of nodeOs.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** Host resource snapshot for Settings → System. Samples CPU over ~120ms to get a real busy %. */
async function systemMetrics(tm: TerminalManager): Promise<Record<string, unknown>> {
  const a = cpuTicks();
  await new Promise((r) => setTimeout(r, 120));
  const b = cpuTicks();
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  const cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(1, 1 - idleDelta / totalDelta)) : 0;
  const cpus = nodeOs.cpus();
  const total = nodeOs.totalmem();
  const free = nodeOs.freemem();
  const mem = process.memoryUsage();
  return {
    mem: { total, free, used: total - free, usedPct: total > 0 ? (total - free) / total : 0 },
    cpu: {
      count: cpus.length,
      model: cpus[0]?.model?.trim() || 'unknown',
      usagePct: cpuUsage,
      loadAvg: nodeOs.loadavg(), // [1, 5, 15] min — always 0 on Windows
    },
    process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, uptime: process.uptime() },
    host: {
      platform: nodeOs.platform(),
      arch: nodeOs.arch(),
      release: nodeOs.release(),
      hostname: nodeOs.hostname(),
      uptime: nodeOs.uptime(),
    },
    runningSessions: tm.aliveSessionCount(),
    sessions: tm.sessionMemory(),
  };
}

/** Settings → Memory view: stored backend config with secrets redacted to `…Set` booleans. */
interface EmbeddingsView { provider: 'openai' | 'ollama'; url: string; model: string; dimensions?: number; apiKeySet: boolean }
interface MemorySettingsView {
  backend: 'sqlite' | 'libsql' | 'automem';
  sqlite?: { embeddings?: EmbeddingsView };
  libsql?: { url: string; authTokenSet: boolean; embeddings?: EmbeddingsView };
  automem?: { endpoint: string; tokenSet: boolean };
  ranking?: { halfLifeDays?: number; weightByImportance?: boolean; weightByUsage?: boolean };
  maintenance?: { pruneAfterDays?: number; keepImportance?: number; dedupeThreshold?: number; everyHours?: number };
  sharedWrites?: 'open' | 'curated';
  preload?: { enabled: boolean; count?: number };
  updatedAt?: number;
  updatedBy?: string;
}

const CONSOLE_HTML = path.resolve(__dirname, '../public/console.html');
const LANDING_HTML = path.resolve(__dirname, '../public/landing.html');
const WEB_DIST = path.resolve(__dirname, '../web/dist');

/** The agents Agent OS ships with: the boot-seeded fleet (department generalists + agent-author) plus
 *  the code-provisioned System machinery spawned by the edge loops (consolidator, skill-scout,
 *  strategist, improver, analyst). We flag these by id rather than by disk location because they
 *  materialise UNDER the user's agents home, so the `deletable` path check can't tell them apart from a
 *  hand-authored agent — and homes provisioned before this flag existed carry no marker in their on-disk
 *  manifests. The flag drives the console "built-in" badge + delete protection (a System agent is OS
 *  infrastructure a loop depends on, not a user teammate). */
const BUILT_IN_AGENT_IDS = new Set<string>([
  ...BUILTIN_SEED_IDS, CONSOLIDATOR_ID,
  SCOUT_ID, STRATEGIST_ID, IMPROVER_ID, ANALYST_ID,
]);

/** The full editable state of an agent, from its manifest + on-disk CLAUDE.md — the unit revisions snapshot. */
function manifestToSnapshot(ag: AgentManifest, claudeMd: string): AgentConfigSnapshot {
  return {
    description: ag.description ?? '',
    category: ag.category, icon: ag.icon,
    model: ag.model, effort: ag.effort, permissionMode: ag.permissionMode,
    examplePrompts: ag.examplePrompts ?? [], shellSecrets: ag.shellSecrets ?? [],
    claudeMd,
  };
}

/** Agent ids that currently have an improver-drafted CLAUDE.md proposal awaiting review (Apply/Dismiss).
 *  Derived from the KB proposal pages — no extra table. NB: the KB store normSeg's a slug's `/` to `-`, so
 *  `proposalSlug()`'s `proposed/<agent>` is stored as `proposed-<agent>`; match that normalized form (the
 *  read-based apply/dismiss are unaffected — they normalize the same way). */
function pendingProposals(os: AgentOS): string[] {
  return os.kb.list(os.tenant, 'operations')
    .filter((pg) => pg.slug.startsWith('proposed-'))
    .map((pg) => pg.slug.slice('proposed-'.length))
    .filter((id) => !!os.agents.get(id));
}

/** Active goals with no progress (no goal_event) in 7+ days — the Insights Goals tile's "plan"-able list.
 *  Matches the tile's stuck-count query; each can be nudged with the existing strategist plan route. */
function stuckGoals(os: AgentOS, now = Date.now()): Array<{ id: string; title: string; days: number }> {
  const cutoff = now - 7 * 86_400_000;
  return os.db
    .prepare("SELECT g.id, g.title, COALESCE((SELECT MAX(created_at) FROM goal_events e WHERE e.goal_id = g.id), g.created_at) AS last FROM goals g WHERE g.tenant = ? AND g.status = 'active' AND COALESCE((SELECT MAX(created_at) FROM goal_events e WHERE e.goal_id = g.id), g.created_at) < ? ORDER BY last")
    .all<{ id: string; title: string; last: number }>(os.tenant, cutoff)
    .map((g) => ({ id: g.id, title: g.title, days: Math.floor((now - g.last) / 86_400_000) }));
}

/** Enabled automations that need attention — last run ERRORED (with the error text) or a cron gone IDLE
 *  (14+ days quiet). Matches the tile's failing+idle count; each can be disabled with the existing
 *  updateAutomation route. The fix here is deterministic: see WHY, then retire it — no spawned agent. */
function troubledAutomations(os: AgentOS, now = Date.now()): Array<{ id: string; name: string; type: string; reason: 'errored' | 'idle'; detail: string }> {
  const out: Array<{ id: string; name: string; type: string; reason: 'errored' | 'idle'; detail: string }> = [];
  const errored = os.db
    .prepare("SELECT a.id, a.name, a.type, (SELECT e.data FROM audit_events e WHERE e.run_id = a.last_session_id AND e.type = 'session.error' ORDER BY e.ts DESC LIMIT 1) AS err FROM automations a WHERE a.enabled = 1 AND a.last_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM audit_events e WHERE e.run_id = a.last_session_id AND e.type = 'session.error')")
    .all<{ id: string; name: string; type: string; err: string | null }>();
  for (const a of errored) {
    let msg = 'last run errored';
    try { const d = JSON.parse(a.err || '{}') as { error?: unknown }; if (d.error) msg = String(d.error); } catch { /* keep default */ }
    out.push({ id: a.id, name: a.name, type: a.type, reason: 'errored', detail: msg.replace(/\s+/g, ' ').slice(0, 160) });
  }
  const idle = os.db
    .prepare("SELECT id, name, type, last_fired_at FROM automations WHERE enabled = 1 AND type = 'cron' AND (last_fired_at IS NULL OR last_fired_at < ?)")
    .all<{ id: string; name: string; type: string; last_fired_at: number | null }>(now - 14 * 86_400_000);
  for (const a of idle) {
    const detail = a.last_fired_at ? `no run in ${Math.floor((now - a.last_fired_at) / 86_400_000)} days` : 'never fired';
    out.push({ id: a.id, name: a.name, type: a.type, reason: 'idle', detail });
  }
  return out;
}

/** Read the agent's current on-disk snapshot (manifest fields + CLAUDE.md), to record as the "before". */
function readAgentSnapshot(ag: AgentManifest): AgentConfigSnapshot {
  const file = ag.dir ? path.join(ag.dir, 'CLAUDE.md') : '';
  const claudeMd = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return manifestToSnapshot(ag, claudeMd);
}

/** Re-apply a full snapshot to disk (agent.json + CLAUDE.md) and re-register — the shared revert primitive. */
function applyAgentSnapshot(os: AgentOS, ag: AgentManifest, snap: AgentConfigSnapshot): AgentManifest {
  const next: AgentManifest = {
    ...ag,
    description: snap.description, category: snap.category, icon: snap.icon,
    model: snap.model, effort: snap.effort, permissionMode: snap.permissionMode,
    examplePrompts: snap.examplePrompts.length ? snap.examplePrompts : undefined,
    shellSecrets: snap.shellSecrets.length ? snap.shellSecrets : undefined,
  };
  const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
  fs.writeFileSync(path.join(ag.dir!, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
  fs.writeFileSync(path.join(ag.dir!, 'CLAUDE.md'), snap.claudeMd);
  os.registerAgent(next);
  return next;
}

/** Agents available for terminal sessions = whatever manifests this instance loaded.
 *  `deletable` = lives under the data home (user-created), so it can be removed; the bundled
 *  examples that ship with the software are read-only. `builtIn` = one of the agents Agent OS
 *  provisions itself, so the console can label it as shipped-with-the-software vs. user-authored. */
function terminalAgents(os: AgentOS): { id: string; description: string; category?: string; runtime: string; deletable: boolean; builtIn: boolean; model?: string; effort?: string; examplePrompts?: string[]; icon?: string }[] {
  const userRoot = os.paths ? path.resolve(os.paths.userAgents) + path.sep : null;
  return [...os.agents.values()].map((a) => ({
    id: a.id,
    description: a.description,
    // Organisational grouping label (Engineering / Marketing / …); undefined = uncategorised.
    category: a.category,
    runtime: a.runtime,
    deletable: !!userRoot && !!a.dir && (path.resolve(a.dir) + path.sep).startsWith(userRoot),
    // A code-provisioned agent that ships with Agent OS (generalist / agent-author / consolidator).
    builtIn: BUILT_IN_AGENT_IDS.has(a.id),
    // Per-agent runtime tuning (claude-code only) — surfaced so the console can show/edit it.
    model: a.model,
    effort: a.effort,
    // Suggested first tasks for the spawn card (clickable chips that prefill the box).
    examplePrompts: a.examplePrompts,
    // Cosmetic per-agent icon: a library id (lucide name) or raw custom SVG markup.
    icon: a.icon,
  }));
}

export function bootstrap(baseDir: string = path.resolve(__dirname, '..')): AgentOS {
  const os = loadAgentOS('config/agent-os.config.json', baseDir);
  os.registerCapabilities(exampleCapabilities);
  return os;
}

/** Phase A: when on, the app reverse-proxies /terminal/<member>/ to that member's own ttyd. */
const UID_ISOLATION = process.env.AOS_UID_ISOLATION === '1';
/** How long `/api/app/dispatch { wait:true }` blocks for the delegate to finish before telling the app
 *  to poll `/api/app/dispatches`. Kept short so a proxied HTTP request never hangs near client timeouts. */
const APP_DISPATCH_WAIT_MS = 20_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Resolve which tenant runtime a request belongs to: explicit `x-aos-tenant` (loopback agent calls)
 *  wins, else the Host subdomain; no signal → the default tenant. */
function resolveRuntime(registry: TenantRegistry, req: http.IncomingMessage): TenantRuntime | undefined {
  const explicit = String(req.headers['x-aos-tenant'] || '').trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  const slug = explicit || registry.slugForHost(host);
  return slug ? registry.get(slug) : registry.default();
}

/** The process's registry, so a request handler can invalidate the app-domain cache after an edit
 *  (there's one registry per process). Set in {@link createHttpServer}. */
let currentRegistry: TenantRegistry | undefined;

export function createHttpServer(registry: TenantRegistry): http.Server {
  currentRegistry = registry;
  const server = http.createServer((req, res) => {
    // Superadmin control plane — host-independent (bearer-gated), so it sits before tenant routing.
    if ((req.url || '').split('?')[0].startsWith('/api/admin/')) {
      handleControl(registry, req, res).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    // Custom app domains: a request whose Host is bound to a published app serves that app at the domain
    // ROOT — a separate origin from the console, reached WITHOUT a console login (public). Checked before
    // tenant routing so a foreign domain never falls through to the default tenant's console.
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
    const appHit = registry.appForHost(host);
    if (appHit) {
      serveAppDomain(appHit.rt.apps, appHit.slug, req, res).catch(() => { if (!res.headersSent) sendJson(res, 502, { error: 'app unavailable' }); });
      return;
    }
    const rt = resolveRuntime(registry, req);
    if (!rt) return sendJson(res, 404, { error: 'no such workspace' });
    handle(rt.os, rt.tm, rt.autos, req, res, rt.ttydPort, rt.slack, rt.discord, rt.apps).catch((err) =>
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
  // Terminal (ttyd) WebSocket upgrades, routed into the request's tenant runtime. Flag on (Phase A):
  // route to each member's OWN ttyd, authz-checked. Flag off (local, no nginx): the app reverse-proxies
  // that tenant's shared ttyd itself, so the browser terminal is self-contained. In production nginx
  // fronts /terminal/ and the app never receives these upgrades, so the shared branch is inert there.
  server.on('upgrade', (req, socket, head) => {
    // Custom-domain app WebSocket upgrades route to the bound app at its root (public), before tenant routing.
    const uHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
    const uHit = registry.appForHost(uHost);
    if (uHit) return void serveAppDomainUpgrade(uHit.rt.apps, uHit.slug, req, socket, head);
    const rt = resolveRuntime(registry, req);
    if (!rt) return void socket.destroy();
    // Hosted-app WebSocket upgrades (e.g. an app's live channel) route to the app's own port.
    if ((req.url || '').startsWith('/apps/')) return void appUpgrade(rt.os, rt.apps, req, socket, head);
    if (UID_ISOLATION) terminalUpgrade(rt.os, rt.tm, req, socket, head);
    else sharedTerminalUpgrade(rt.os, rt.tm, rt.ttydPort, req, socket, head);
  });
  return server;
}

/** Superadmin tenant provisioning (CLI/API only). Gated by `AOS_SUPERADMIN_TOKEN`; 503 until set. */
async function handleControl(registry: TenantRegistry, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const want = process.env.AOS_SUPERADMIN_TOKEN || '';
  if (!want) return sendJson(res, 503, { error: 'tenant admin API disabled (set AOS_SUPERADMIN_TOKEN)' });
  const got = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  // Constant-time compare (equal-length guard first; timingSafeEqual throws on length mismatch).
  const ok = got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return sendJson(res, 401, { error: 'bad superadmin token' });

  const p = (req.url || '').split('?')[0];
  const method = req.method || 'GET';
  if (method === 'GET' && p === '/api/admin/tenants') {
    return sendJson(res, 200, { tenants: registry.list() });
  }
  if (method === 'POST' && p === '/api/admin/tenants') {
    const b = await readBody(req);
    const slug = String(b.slug || '');
    const ownerEmail = String(b.ownerEmail || b.owner || '');
    if (!slug || !ownerEmail) return sendJson(res, 400, { error: 'slug and ownerEmail are required' });
    try {
      const { record, loginUrl } = registry.create({ slug, ownerEmail, displayName: b.displayName ? String(b.displayName) : undefined });
      return sendJson(res, 200, { tenant: record, loginUrl });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const del = p.match(/^\/api\/admin\/tenants\/([\w-]+)$/);
  if (method === 'DELETE' && del) {
    try {
      const removed = registry.remove(del[1]);
      return sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such tenant' });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

export function startServer(port = Number(process.env.PORT) || 3010): http.Server {
  // Multi-tenant: one process serves many tenants, each a fully isolated runtime (own AgentOS/DB/
  // tmux socket/ttyd/cron/Slack). The registry builds them; requests route by subdomain. The seed
  // (config `tenant`) keeps the legacy un-nested home, so existing single-tenant installs just work.
  const baseDir = path.resolve(__dirname, '..');
  const registry = new TenantRegistry(baseDir, port);
  registry.bootAll();

  // Shared, process-wide upkeep timers — each fans out across every tenant runtime.
  // Idle GC (A5): reclaim idle members' uids/ttyds. No-op under the local backend, so always-on is safe.
  const reaper = setInterval(() => registry.forEach((rt) => {
    try { rt.tm.reapIdleSpaces(); } catch { /* never let the sweep crash */ }
    try { rt.tm.reapIdleSessions(); } catch { /* idle reaper (warm chat + unattended backstop) — never crash the sweep */ }
  }), 60_000);
  reaper.unref?.();
  // Memory upkeep + self-learning: hourly check per tenant; each is a no-op unless that tenant opted in.
  const lastMaint = new Map<string, number>();
  const lastDream = new Map<string, number>();
  const upkeep = setInterval(() => registry.forEach((rt) => {
    const { os } = rt;
    const m = os.settings.memoryConfig()?.maintenance;
    if (m && (m.pruneAfterDays || m.dedupeThreshold != null)) {
      const everyMs = (m.everyHours && m.everyHours > 0 ? m.everyHours : 24) * 3_600_000;
      if (Date.now() - (lastMaint.get(os.tenant) || 0) >= everyMs) {
        lastMaint.set(os.tenant, Date.now());
        void os.runMemoryMaintenance('scheduler').catch(() => { /* never let upkeep crash the server */ });
      }
    }
    const everyHours = os.settings.dreamingEveryHours();
    if (everyHours) {
      // H1: DURABLE cadence. `lastDream` is in-memory, so before this fix a restart (frequent on this box
      // — every build/deploy) emptied it and the next tick fired a pass immediately, turning "reflect
      // every 24h" into "reflect on every restart" — each pass spawns a BILLED consolidator agent. Seed
      // the clock once per process from the last real pass (the `learning.dreamed` audit ts) so cadence
      // survives restarts. (Mirrors how the digest gates on its durable `digest.posted` audit.)
      if (!lastDream.has(os.tenant)) {
        const last = os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.dreamed'").get<{ t: number | null }>();
        lastDream.set(os.tenant, last?.t ?? 0);
      }
      if (Date.now() - (lastDream.get(os.tenant) || 0) >= everyHours * 3_600_000) {
        lastDream.set(os.tenant, Date.now());
        // One "reflect" concept, whether manual or scheduled: the cheap deterministic pass, then the
        // memory-gardener over new material (it no-ops when there's too little to be worth an agent run).
        void new DreamingEngine(os).dream('scheduler')
          .then(() => new Consolidation(os, rt.tm).run('automation:consolidation'))
          .catch(() => { /* never let the scheduler crash the server */ });
      }
    }
    // Daily digest — the "what got done today" standup. Rides this same hourly tick but gates its own
    // Slack post (enabled + channel + past digestHour + not yet posted today); the dashboard/KB render
    // live on demand, so nothing here is needed to keep them fresh. No-op unless the tenant opted in.
    void new Digest(os).maybePostEod(new Date(), registry.consoleOrigin(os.tenant)).catch(() => { /* never let the digest crash the scheduler */ });
    // Proactive intelligence alerts — the OS comes to the owner. Detect notable conditions (struggling
    // agent, recurring rejections, success drop), push each NEW one (past its per-key cooldown) as an
    // admins' Inbox card + DM. No-op if disabled or nothing warrants attention.
    if (os.settings.insightsAlertsEnabled()) {
      try {
        const origin = registry.consoleOrigin(os.tenant);
        for (const alert of pendingAlerts(os)) {
          rt.tm.postInsightAlert(alert);
          os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'insights.alert', data: { key: alert.key, severity: alert.severity } });
          void notifyInsightAlert(os, rt.slack, rt.discord, origin, alert).catch(() => { /* DM is best-effort */ });
        }
      } catch { /* never let alerting crash the scheduler */ }
    }
  }), 3_600_000);
  upkeep.unref?.();

  const server = createHttpServer(registry);
  server.listen(port, () => {
    console.log(`\n  Agent OS console → http://localhost:${port}`);
    console.log(`  tenants: ${registry.list().map((t) => t.slug).join(', ') || '(none)'}\n`);
  });
  // Reap every tenant's ttyd + background services on graceful close AND systemd's SIGINT/SIGTERM.
  server.on('close', () => registry.stopAll());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      registry.stopAll();
      process.exit(0);
    });
  }
  return server;
}

async function handle(os: AgentOS, tm: TerminalManager, autos: Automations, req: http.IncomingMessage, res: http.ServerResponse, ttydPort?: number, slack?: SlackSocket, discord?: DiscordSocket, appSup?: AppSupervisor): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  // /terminal/ → the ttyd browser terminal. Flag-on (Phase A): proxy to the member's OWN ttyd
  // (/terminal/<space>/…), authz-checked. Flag-off (local, no nginx): proxy the single shared ttyd so
  // the terminal works self-contained, with the same cookie + per-session attach authz nginx enforces.
  if (UID_ISOLATION && p.startsWith('/terminal/')) return terminalProxy(os, tm, req, res);
  if (!UID_ISOLATION && ttydPort && p.startsWith('/terminal/')) return sharedTerminalProxy(os, tm, ttydPort, req, res);

  // /apps/<slug>/… → the hosted-app reverse proxy. Login-gated (any member may open an app in v1),
  // cold-starts the app if needed, strips the /apps/<slug> prefix, and injects the trusted identity
  // headers. See docs/apps-plan.md §3.2.
  if (appSup && p.startsWith('/apps/')) return appProxy(os, appSup, req, res);

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const idx = path.join(WEB_DIST, 'index.html');
    return sendFile(res, fs.existsSync(idx) ? idx : CONSOLE_HTML, 'text/html; charset=utf-8');
  }
  if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, tenant: os.tenant, name: os.tenantName, version: VERSION });
  // Public marketing landing page — a standalone static HTML doc (no auth, no React). Served straight
  // off disk from public/landing.html so it can be iterated on without a web build. Distinct from the
  // console SPA at '/', which stays the app.
  if (method === 'GET' && p === '/landing') {
    if (fs.existsSync(LANDING_HTML)) return sendFile(res, LANDING_HTML, 'text/html; charset=utf-8');
    return end(res, 404);
  }
  // static assets from the built React app (web/dist)
  if (method === 'GET' && (p.startsWith('/assets/') || /\.(js|css|svg|png|ico|woff2?|json|map)$/.test(p))) {
    const file = path.join(WEB_DIST, p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, mime(file));
    return end(res, 404);
  }
  if (method === 'GET' && p === '/favicon.ico') return end(res, 204);

  // ── auth: magic-link landing + session introspection (the only PUBLIC /api routes) ──────────
  // Magic links use a two-step landing so a link preview / scanner / mail-gateway that GETs the
  // URL can't burn the one-time token before the human clicks. GET only PEEKS (renders a confirm
  // page); the token is consumed only by the POST the "Continue" button fires — which bots don't do.
  if (method === 'GET' && p === '/accept') {
    const token = url.searchParams.get('token') || '';
    const peek = os.team.peekToken(token);
    if (!peek) return redirect(res, '/?login=invalid');
    return sendHtml(res, 200, acceptLandingHtml(peek.email, token, os.settings.branding().accentColor));
  }
  if (method === 'POST' && p === '/accept') {
    const accepted = os.team.acceptToken(url.searchParams.get('token') || '');
    if (!accepted) return redirect(res, '/?login=invalid');
    res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(accepted.sid) });
    res.end();
    return;
  }
  if (method === 'GET' && p === '/api/auth/me') {
    const m = memberFor(os, req);
    if (!m) return sendJson(res, 401, { error: 'not authenticated' });
    // Sliding session: re-stamp the cookie on every app load (the SPA GETs this on mount) so an active
    // user's 30-day browser cookie never lapses. Pairs with the DB-side slide in TeamStore.resolveSession
    // — restamping the cookie alone would outlive the server row, sliding the row alone would outlive the
    // cookie; both together keep an active user logged in indefinitely.
    const sid = parseCookies(req)['aos_sid'];
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (sid) headers['set-cookie'] = sessionCookie(sid);
    res.writeHead(200, headers);
    // navPins rides along on the auth payload (not a separate fetch) so the sidebar's pinned layout is
    // known at first shell paint — no flash of the default nav before a follow-up request lands.
    res.end(JSON.stringify({ member: m, navPins: os.team.navPins(m.id) }));
    return;
  }
  // Per-tenant console branding (accent colour + favicon badge). PUBLIC + display-only (no secrets):
  // the SPA fetches this on mount — before any session exists — so the login screen and the browser-tab
  // favicon are already tenant-coloured. `tenantName` lets the favicon fall back to the tenant's initial.
  if (method === 'GET' && p === '/api/branding') {
    const b = os.settings.branding();
    return sendJson(res, 200, { tenant: os.tenant, tenantName: os.tenantName, accentColor: b.accentColor, badge: b.badge });
  }
  // Self-service recovery: a member who lost their session (new device, cleared cookies, expired
  // window) asks for a fresh sign-in link WITHOUT needing an admin to mint one. Public + neutral: we
  // ALWAYS return { ok: true } regardless of whether the email is a real member, so this can't be used
  // to enumerate accounts. A known member gets a fresh 7-day magic-link delivered out-of-band — DM'd to
  // their linked Slack/Discord (identity map) AND written to server.log (the always-available fallback,
  // matching how the owner-seed link is surfaced). Rate-limited per email + client IP.
  if (method === 'POST' && p === '/api/auth/request-link') {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (email && email.includes('@') && allowLinkRequest(email, req)) {
      const issued = os.team.issueLoginLink(email); // null when no such member — stays silent
      if (issued) {
        const link = linkFor(req, issued.token);
        let dms = 0;
        if (slack && discord) dms = await notifyLoginLink(os, slack, discord, issued.member, link);
        console.log(`[auth] sign-in link requested for ${email} — ${dms} DM(s) sent: ${link}`);
        os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: email, type: 'auth.link.requested', data: { member: issued.member.id, dms } });
      } else {
        os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: email, type: 'auth.link.requested', data: { unknown: true } });
      }
    }
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/auth/logout') {
    const sid = parseCookies(req)['aos_sid'];
    if (sid) os.team.destroySession(sid);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': clearCookie() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── inbound webhooks (PUBLIC — authenticated by the automation's own secret key) ────────────
  const hookMatch = p.match(/^\/hooks\/([\w-]+)$/);
  if (method === 'POST' && hookMatch) {
    const key = url.searchParams.get('key') || String(req.headers['x-hook-key'] || '');
    const payload = await readBody(req);
    const out = autos.fireWebhook(hookMatch[1], key, payload);
    return sendJson(res, out.status, out.body);
  }

  // ── public artifact share (PUBLIC — authenticated by the artifact's own unguessable token) ──────
  // An owner/admin/producer mints a login-free link to ONE published deliverable; anyone with the URL
  // views/downloads it. Sits BEFORE the member gate like /hooks, and is authenticated the same way — by
  // an unguessable secret in the URL rather than a cookie. Host-scoped to this tenant (the registry has
  // already routed us into the right runtime), so a token only resolves within its own tenant's gallery.
  // Serves bytes inline; `?file=` selects a sibling (future multi-file `kind:'site'`).
  const sharedMatch = p.match(/^\/shared\/([A-Za-z0-9_-]+)$/);
  if (method === 'GET' && sharedMatch) {
    const a = os.artifacts.getByToken(sharedMatch[1]);
    if (!a) return end(res, 404);
    const resolved = os.artifacts.readPath(a.id, url.searchParams.get('file') || undefined);
    if (!resolved) return end(res, 404);
    // Audit only the primary (non-range) fetch — media scrubbing fires many range requests for one view.
    if (!req.headers['range']) os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: 'public', type: 'artifact.share.viewed', data: { id: a.id, file: resolved.filename } });
    return streamArtifactFile(req, res, resolved, { sandbox: true });
  }

  // ── Composio ingress (PUBLIC — verified by the Composio webhook signing secret) ───────────────
  // Composio Webhook Triggers V2 POST app events (Slack message/DM, …) here. Verify the Svix-style
  // signature, parse the event, and fire matching `composio` automations → governed agent sessions.
  if (method === 'POST' && p === '/triggers/composio') {
    const secret = os.settings.composioWebhookSecret();
    if (!secret) return sendJson(res, 503, { error: 'composio webhook secret not configured (Settings → Integrations)' });
    const raw = await readRawBody(req);
    if (!verifyComposioWebhook(secret, req.headers, raw)) return sendJson(res, 401, { error: 'invalid signature' });
    let body: unknown;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
    const event = parseComposioEvent(body);
    const out = autos.fireComposio(event);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'composio', type: 'trigger.composio', data: { trigger: event.triggerSlug, toolkit: event.toolkit, fired: out.fired } });
    return sendJson(res, 200, { ok: true, ...out });
  }

  // ── session-scoped agent endpoints (PUBLIC, like /hooks) ─────────────────────
  // Called by in-session hooks / the memory MCP server AS THE AGENT, over loopback, with no
  // cookie — so they must sit before the member gate. Each is scoped to a REAL session row
  // (and memory derives the agent from that row, never trusting a client-supplied id), the same
  // loopback-trust model the gate-hook was always meant to use.
  //
  // 0d: each also verifies the per-session bearer secret (header `X-AOS-Secret`), minted at spawn and
  // exported into the session env. So a forged/guessed session id alone can't gate, recall/remember,
  // ask, or report AS another session — the caller must hold that session's secret.
  const sessionSecretOk = (sessionId: string): boolean => tm.verifySessionSecret(sessionId, String(req.headers['x-aos-secret'] || ''));
  if (method === 'POST' && p === '/api/gate') {
    const b = await readBody(req);
    const sessionId = String(b.sessionId || '');
    if (!tm.hasSession(sessionId)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(sessionId)) return sendJson(res, 403, { error: 'bad session secret' });
    const result = tm.gate(
      sessionId,
      String(b.agent || ''),
      String(b.capability || ''),
      (b.args && typeof b.args === 'object') ? b.args : {},
      String(b.reasoning || ''),
    );
    return sendJson(res, 200, result);
  }
  const gateMatch = p.match(/^\/api\/gate\/([\w-]+)$/);
  if (method === 'GET' && gateMatch) return sendJson(res, 200, { status: tm.gateStatus(gateMatch[1]) });

  // Policy preview: the agent asks what it's allowed to do BEFORE attempting it. Pure dry-run of the
  // same classify() the gate uses — no approval card, no audit, no side effect.
  // Directory lookup (the `directory_lookup` OS tool): a session resolves teammates by name/email →
  // member + their external accounts (slack/discord/github/email), so an agent knows who to reach on
  // which channel. Session-secret gated like the other agent loopback routes; read-only.
  if (method === 'GET' && p === '/api/agent/directory') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const q = url.searchParams.get('q') || '';
    const members = os.team.searchMembers(q, Number(url.searchParams.get('limit')) || 10).map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      identities: os.team.externalIdsFor(m.id).map((i) => ({ provider: i.provider, externalId: i.externalId })),
    }));
    return sendJson(res, 200, { members });
  }
  // Fleet roster — the OTHER agents this session can hand work to (the agent-discovery primitive backing
  // `list_agents`). Session-secret gated like the other agent loopback routes; read-only. Excludes the
  // caller and non-claude-code (mock) agents, so an agent only sees peers it can actually delegate to.
  if (method === 'GET' && p === '/api/agent/roster') {
    const session = url.searchParams.get('session') || '';
    const self = tm.sessionAgent(session);
    if (!self) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const agents = [...os.agents.values()]
      .filter((a) => a.runtime === 'claude-code' && a.id !== self)
      .map((a) => ({ id: a.id, description: a.description, category: a.category }));
    return sendJson(res, 200, { agents });
  }
  // Status line (the `statusline.js` bar in a governed claude TUI): live governance for THIS run —
  // how many approvals it's blocked on and which human identity it acts as. Session-secret gated like
  // the other agent loopback routes; read-only. Kept cheap: it's polled on the TUI refreshInterval.
  if (method === 'GET' && p === '/api/agent/status') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const pending = os.approvals.pending(os.tenant).filter((a) => a.runId === session).length;
    const runAsId = tm.sessionRunAs(session);
    const runAs = runAsId ? os.team.getMember(runAsId)?.name ?? null : null;
    return sendJson(res, 200, { agent, pending, runAs });
  }
  if (method === 'GET' && p === '/api/agent/policy') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const capabilities = os.registry.list().map((c) => {
      const d = tm.policyCheck(session, agent, c.id, {});
      return {
        id: c.id,
        description: c.description,
        defaultRisk: c.defaultRisk,
        effect: d.effect,
        level: d.effect === 'approve' ? d.level : undefined,
      };
    });
    // Expose the raw ruleset + default so an agent can craft a precise `policy_propose` delta (which rule
    // to tighten/reorder, or where a new guardrail fits). Read-only; it's the agent's own governing policy.
    const doc = os.policy instanceof JsonPolicyEngine ? os.policy.document : undefined;
    return sendJson(res, 200, { policy: os.policy.id, capabilities, rules: doc?.rules, default: doc?.default, editable: !!doc });
  }
  if (method === 'POST' && p === '/api/agent/policy/check') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const capability = String(b.capability || '').trim();
    if (!capability) return sendJson(res, 400, { error: 'capability is required' });
    const args = b.args && typeof b.args === 'object' ? (b.args as Record<string, unknown>) : {};
    return sendJson(res, 200, { decision: tm.policyCheck(String(b.session), agent, capability, args) });
  }
  // Agent PROPOSES a constrained, TIGHTEN-ONLY policy change (`policy_propose`) — the governance sibling of
  // skill_propose/host_propose. Validated up front (applyProposal refuses any loosening); a valid proposal
  // posts an owner-addressed 'policy.proposal' card and applies NOTHING until an owner approves. Pre-auth
  // loopback, session-secret gated (agent resolved from the session row, never trusted from the body).
  if (method === 'POST' && p === '/api/agent/policy/propose') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const kind = String(b.kind || '').trim();
    if (!['tighten', 'reorder', 'add'].includes(kind)) return sendJson(res, 400, { error: 'kind must be tighten, reorder, or add' });
    const capability = String(b.capability || '').trim();
    if (!capability) return sendJson(res, 400, { error: 'capability is required' });
    const when = b.when && typeof b.when === 'object'
      ? { arg: String((b.when as Record<string, unknown>).arg || ''), op: String((b.when as Record<string, unknown>).op || '') as never, value: (b.when as Record<string, unknown>).value as never }
      : undefined;
    const outcome = b.action
      ? { action: String(b.action) as never, ...(String(b.action) === 'ask' ? { approver: String(b.approver || 'admin') as never } : {}) }
      : undefined;
    const delta = { kind: kind as never, match: { capability, ...(when ? { when } : {}) }, ...(outcome ? { outcome } : {}) };
    const out = tm.proposePolicy(session, agent, delta, b.rationale != null ? String(b.rationale) : undefined);
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  // ── Secrets vault, agent-facing (loopback, session-scoped) — the A2A credential-handoff path ──
  // Shared-scope model: writes land tenant-wide (`*`) so any agent can read them; the value NEVER
  // touches audit/approval-card/policy args (see TerminalManager.putSecret/getSecret). `put` is
  // approval-gated (policy `secret.put`) and BLOCKS this request until the human decides; `get`/`list`
  // are allow+audit reads. Agents pass key HANDLES to each other, never the raw value.
  if (method === 'POST' && p === '/api/agent/secret/put') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const key = String(b.key || '').trim();
    const value = b.value != null ? String(b.value) : '';
    if (!ENV_NAME.test(key) || key.length > 64) return sendJson(res, 400, { error: 'key must be a letter/underscore then letters, digits or underscores, ≤64 chars (e.g. PROD_DB_URL)' });
    if (!value) return sendJson(res, 400, { error: 'value is required' });
    const reasoning = String(b.reasoning || `store shared secret ${key}`);
    const out = await tm.putSecret(session, agent, key, value, reasoning);
    return sendJson(res, 200, out);
  }
  if (method === 'POST' && p === '/api/agent/secret/get') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const key = String(b.key || '').trim();
    if (!key) return sendJson(res, 400, { error: 'key is required' });
    return sendJson(res, 200, tm.getSecret(session, agent, key));
  }
  if (method === 'GET' && p === '/api/agent/secret/list') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    return sendJson(res, 200, { secrets: tm.listSecrets() });
  }
  // agent ASKS a human to PROVIDE a credential it lacks (`secret_request`) — the inverse of secret/put:
  // it carries only the KEY + reason, never a value, so the raw secret is typed into a secure form
  // instead of pasted into the transcript. Posts an owner/admin 'secret.request' card; a human fulfills
  // it via POST /api/secrets/requests/:id/fulfill. Pre-auth loopback, session-secret gated.
  if (method === 'POST' && p === '/api/agent/secret/request') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const key = String(b.key || '').trim();
    if (!ENV_NAME.test(key) || key.length > 64) return sendJson(res, 400, { error: 'key must be a letter/underscore then letters, digits or underscores, ≤64 chars (e.g. STRIPE_API_KEY)' });
    const out = tm.requestSecret(session, agent, key, b.reasoning != null ? String(b.reasoning) : undefined);
    return sendJson(res, out.ok ? 200 : 400, out);
  }

  // ── Per-member GitHub token refresh, agent-facing (loopback, session-scoped) ──────────────────────
  // An agent's injected GH_TOKEN is the run-as member's user-to-server token (~8h life). It's refreshed
  // only at launch (fire-and-forget, within the expiry skew) and can't be mutated in the running
  // process — so a long/resumed run that outlives its token hits "Bad credentials" with no recovery.
  // This lets the agent force a refresh NOW and get the fresh token back to re-export as GH_TOKEN (the
  // git credential helper reads $GH_TOKEN at call time, so a re-export flows through to git + gh). The
  // token returned is the run's OWN identity — already injected at launch — so this is no new exposure.
  if (method === 'POST' && p === '/api/agent/github/refresh') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const member = tm.sessionRunAs(session);
    if (!member) return sendJson(res, 200, { status: 'no_member' });
    const gh = new GithubIdentity(os);
    const out = await gh.forceRefresh(member).catch((e) => ({ status: 'failed' as const, detail: e instanceof Error ? e.message : String(e) }));
    if (out.status === 'ok') {
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'github.token.refreshed', data: { login: out.blob.login, principal: member, refreshed: out.refreshed, via: 'agent' } });
      return sendJson(res, 200, { status: 'ok', token: out.blob.token, login: out.blob.login, expiresAt: out.blob.expiresAt, refreshed: out.refreshed });
    }
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'github.token.refresh_failed', data: { principal: member, reason: out.status, via: 'agent' } });
    return sendJson(res, 200, out);
  }

  if (method === 'GET' && p === '/api/memory/recall') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const limit = Number(url.searchParams.get('limit')) || 8;
    try {
      const memories = await os.memory.recall({ tenant: os.tenant, agentId: agent, query: url.searchParams.get('q') || '', limit });
      return sendJson(res, 200, { memories });
    } catch (e) {
      // Recall is best-effort context, never a hard dependency — degrade to empty on backend error.
      return sendJson(res, 200, { memories: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (method === 'POST' && p === '/api/memory/remember') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!b.content) return sendJson(res, 400, { error: 'content is required' });
    try {
      // `shared: true` (or scope: 'tenant') publishes workspace-wide; default stays agent-private.
      // When the workspace is 'curated', an agent's shared write is downgraded to private (humans curate).
      const wantShared = b.shared === true || b.scope === 'tenant';
      const curated = os.settings.memoryConfig()?.sharedWrites === 'curated';
      const downgraded = wantShared && curated;
      const rec = await os.memory.store({
        tenant: os.tenant,
        agentId: agent,
        content: String(b.content),
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        type: typeof b.type === 'string' ? (b.type as MemoryType) : undefined,
        importance: typeof b.importance === 'number' ? b.importance : undefined,
        metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : undefined,
        scope: wantShared && !curated ? 'tenant' : 'agent',
      });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'memory.stored', data: { id: rec.id, tags: rec.tags, scope: rec.scope } });
      return sendJson(res, 200, { ok: true, id: rec.id, scope: rec.scope, downgraded });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // agent revises one of its OWN memories (correct a fact that turned out wrong / sharpen it). The
  // provider's author guard means a session can only edit a memory it authored.
  if (method === 'POST' && p === '/api/memory/revise') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim();
    if (!id) return sendJson(res, 400, { error: 'id is required' });
    try {
      const rec = await os.memory.update({
        tenant: os.tenant, agentId: agent, id,
        content: typeof b.content === 'string' ? b.content : undefined,
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        type: typeof b.type === 'string' ? (b.type as MemoryType) : undefined,
        importance: typeof b.importance === 'number' ? b.importance : undefined,
      });
      if (!rec) return sendJson(res, 200, { ok: false, error: 'no such memory of yours to revise' });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'memory.revised', data: { id: rec.id } });
      return sendJson(res, 200, { ok: true, id: rec.id, scope: rec.scope });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // agent forgets one of its OWN memories (a stale/wrong fact). Author-guarded like revise.
  if (method === 'POST' && p === '/api/memory/forget') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim();
    if (!id) return sendJson(res, 400, { error: 'id is required' });
    try {
      const deleted = await os.memory.delete({ tenant: os.tenant, agentId: agent, id });
      if (deleted) os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'memory.forgotten', data: { id } });
      return sendJson(res, 200, { ok: true, deleted });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // agent reads back ITS OWN inbox feed (answers to questions it asked, approvals/updates/reports on
  // its run) — a non-blocking pull, vs `ask` which blocks. Session-scoped server-side.
  if (method === 'GET' && p === '/api/inbox') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
    return sendJson(res, 200, { messages: tm.sessionInbox(session, limit) });
  }
  // agent lists the deliverables IT has already published (its own agent id) — to build on prior work
  // or avoid re-publishing. Metadata only; the file lives in the agent's own working folder.
  if (method === 'GET' && p === '/api/agent/artifacts') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
    const artifacts = os.artifacts.list().filter((a) => a.agent === agent).slice(0, limit);
    // `folders` is the tenant-wide folder taxonomy (all agents) so a publisher can file into the
    // existing tree instead of inventing a new folder; the artifact LIST stays own-scoped.
    return sendJson(res, 200, { artifacts, folders: os.artifacts.folders(), enabled: os.artifacts.enabled });
  }
  // agent reads back ITS OWN past sessions (episodic self-query — "have I done this before, how did it
  // go?"), the run-history companion to the semantic memory plane. Own-scoped server-side to the caller's
  // agent id; metadata only (id/title/status/rating/dates), never a transcript — that's `session_open`.
  if (method === 'GET' && p === '/api/agent/sessions') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
    const q = (url.searchParams.get('query') || '').trim().toLowerCase();
    let mine = tm.sessionsForAgent(agent).filter((s) => s.id !== session); // exclude the current run
    if (q) mine = mine.filter((s) => `${s.title} ${s.task}`.toLowerCase().includes(q));
    const sessions = mine.slice(0, limit).map((s) => ({
      id: s.id, title: s.title, task: s.task, status: s.status,
      createdAt: s.createdAt, updatedAt: s.updatedAt, rating: s.rating, headless: s.headless, source: s.sourceKind,
    }));
    return sendJson(res, 200, { sessions });
  }
  // agent OPENS one of its own past sessions to read what happened — the friendly transcript timeline, or
  // (summary=1) a throwaway-claude recap of the whole run. Own-scoped: the target must belong to the
  // caller's agent (resolved via `sessionsForAgent`), else 403. Falls back to the raw pane log for a
  // headless run that tee'd only `session-<id>.log` and has no structured transcript.
  if (method === 'GET' && p === '/api/agent/session') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = url.searchParams.get('id') || '';
    const target = tm.sessionsForAgent(agent).find((s) => s.id === id);
    if (!target) return sendJson(res, 403, { error: 'not one of your sessions' });
    const meta = { id: target.id, title: target.title, task: target.task, status: target.status, createdAt: target.createdAt, updatedAt: target.updatedAt, rating: target.rating };
    const claudeId = tm.sessionClaudeId(id);
    const convo = claudeId ? readConversation(claudeId) : { turns: [], found: false };
    if (url.searchParams.get('summary') === '1') {
      const out = await summarizeConversation(convo);
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'session.summarized', data: { target: id, via: out.via, found: out.found } });
      return sendJson(res, 200, { meta, ...out });
    }
    // No structured transcript (a headless run tee'd only a raw pane log) → serve the tail of that.
    let log: string | undefined;
    if (!convo.found && os.paths) {
      try {
        const buf = fs.readFileSync(path.join(os.paths.connectors, `session-${id}.log`));
        const CAP = 64 * 1024;
        log = buf.length > CAP ? '…(earlier output truncated)\n' + buf.subarray(buf.length - CAP).toString('utf8') : buf.toString('utf8');
      } catch { /* no log either — the run wrote nothing readable */ }
    }
    return sendJson(res, 200, { meta, turns: convo.turns, found: convo.found, log });
  }
  // agent schedules a ONE-SHOT deferred run of itself (a follow-up / "check back later"). Stored as a
  // `once` automation that runs the same agent under the same run-as identity, bounded by the SCHEDULE_*
  // caps. Provenance stays the automation; shows in the console Automations page (human-cancellable).
  if (method === 'POST' && p === '/api/agent/schedule') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const task = String(b.task || '').trim();
    if (!task) return sendJson(res, 400, { error: 'task is required' });
    // Accept either a relative delay (inMinutes) or an absolute time (at: ISO string or epoch ms).
    let runAt: number;
    if (typeof b.inMinutes === 'number') runAt = Date.now() + b.inMinutes * 60_000;
    else if (b.at !== undefined) runAt = typeof b.at === 'number' ? b.at : Date.parse(String(b.at));
    else return sendJson(res, 400, { error: 'provide inMinutes or at' });
    if (!Number.isFinite(runAt)) return sendJson(res, 400, { error: 'could not parse the schedule time' });
    // By default the deferred run RESUMES this session's transcript, so the agent wakes back up with its
    // full context. `resume: false` opts into a clean-slate run (unrelated future work, or a far-off
    // schedule where re-loading a stale transcript isn't worth it).
    const resume = b.resume !== false;
    const resumeClaudeId = resume ? tm.sessionClaudeId(session) : undefined;
    try {
      const a = autos.schedule({ agentId: agent, name: String(b.name || '').trim() || `Scheduled: ${task.slice(0, 40)}`, task, runAt, runAs: tm.sessionRunAs(session), resumeClaudeId, createdBy: 'automation' });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'automation.scheduled', data: { id: a.id, runAt, agent, resume: !!resumeClaudeId } });
      return sendJson(res, 200, { ok: true, id: a.id, runAt, resume: !!resumeClaudeId });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // agent cancels one of ITS OWN pending scheduled tasks (scoped to its agent).
  if (method === 'POST' && p === '/api/agent/schedule/cancel') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim();
    if (!id) return sendJson(res, 400, { error: 'id is required' });
    const cancelled = autos.cancelScheduled(id, agent);
    if (cancelled) os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'automation.cancelled', data: { id } });
    return sendJson(res, 200, { ok: true, cancelled });
  }
  // agent ENDS ITS OWN session — the self-stop escape hatch (work is done / blocked with no point
  // waiting). Same halt the console kill button performs (stopSession: kills tmux, cancels pending
  // questions/approvals, blocks auto-resume, records a `stopped` episode), but `by` = the agent id.
  if (method === 'POST' && p === '/api/agent/stop') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const reason = String(b.reason || '').trim() || undefined;
    // Ack first, halt just after: stopSession kills the tmux that is running THIS caller, so deferring
    // the kill a beat lets the 200 flush back to the agent before its process group is torn down.
    setTimeout(() => { try { tm.stopSession(session, agent, reason); } catch { /* best effort — the session is going away regardless */ } }, 150);
    return sendJson(res, 200, { ok: true });
  }

  // ask-human: the agent posts a question (→ inbox) and polls until a human answers it. Optional `to`
  // addresses it to a SPECIFIC teammate (name/email/id) instead of the run's operator.
  if (method === 'POST' && p === '/api/ask') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const question = String(b.question || '').trim();
    if (!question) return sendJson(res, 400, { error: 'question is required' });
    const to = b.to ? String(b.to).trim() : undefined;
    const options = Array.isArray(b.options)
      ? (b.options as unknown[]).map((o) => String(o).trim()).filter(Boolean).slice(0, 8)
      : undefined;
    const out = tm.askQuestion(session, agent, question, to, options?.length ? options : undefined);
    return sendJson(res, out.error ? 400 : 200, out);
  }
  const askMatch = p.match(/^\/api\/ask\/([\w-]+)$/);
  if (method === 'GET' && askMatch) return sendJson(res, 200, tm.questionStatus(askMatch[1]));

  // ask-agent: a live agent delegates a question/task to ANOTHER agent and polls until it answers. The
  // server spawns a one-off headless delegate (run-as passthrough, still gated); the delegate closes the
  // loop with the `answer` tool. Machine-facing sibling of /api/ask — no task row, no board/inbox surface.
  if (method === 'POST' && p === '/api/ask-agent') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const target = String(b.agent || '').trim();
    const question = String(b.question || '').trim();
    if (!question) return sendJson(res, 400, { error: 'question is required' });
    const goal = typeof b.goal === 'string' && b.goal.trim() ? b.goal.trim() : undefined;
    const out = tm.askAgent(session, agent, target, question, goal);
    return sendJson(res, out.error ? 400 : 200, out);
  }
  const askAgentMatch = p.match(/^\/api\/ask-agent\/([\w-]+)$/);
  if (method === 'GET' && askAgentMatch) return sendJson(res, 200, tm.agentAskStatus(askAgentMatch[1]));

  // The delegate returns its answer (its `answer` tool) — resolved to the ask bound to THIS session.
  if (method === 'POST' && p === '/api/agent/answer') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const answer = String(b.answer || '').trim();
    if (!answer) return sendJson(res, 400, { error: 'answer is required' });
    const out = tm.answerAgentAsk(session, agent, answer);
    return sendJson(res, out.error ? 400 : 200, out);
  }

  // agent self-reports completion (→ inbox card with outcome + summary).
  if (method === 'POST' && p === '/api/report') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.report(session, agent, String(b.outcome || 'success'), String(b.summary || ''), b.lessons ? String(b.lessons) : undefined);
    return sendJson(res, 200, { ok: true });
  }
  // agent posts a mid-task progress note (→ inbox feed 'update' card; `important` highlights it).
  if (method === 'POST' && p === '/api/update') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const message = String(b.message || '').trim();
    if (!message) return sendJson(res, 400, { error: 'message is required' });
    tm.progress(session, agent, message, b.important === true || b.important === 'true');
    return sendJson(res, 200, { ok: true });
  }
  // agent deliberately notifies a specific teammate (the `notify` tool) — the escape hatch from the
  // session-owner-scoped default: an inbox card addressed to that member + an out-of-band DM.
  if (method === 'POST' && p === '/api/notify') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const to = String(b.to || '').trim();
    const message = String(b.message || '').trim();
    if (!to) return sendJson(res, 400, { error: 'to is required' });
    if (!message) return sendJson(res, 400, { error: 'message is required' });
    const out = tm.notifyMember(session, agent, to, message, b.important === true || b.important === 'true');
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // agent publishes a deliverable to the Artifacts gallery (→ snapshot + inbox card + audit). The
  // file path is resolved under the agent's own folder by the store; only that session may publish.
  if (method === 'POST' && p === '/api/publish') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const filePath = String(b.path || '').trim();
    if (!filePath) return sendJson(res, 400, { error: 'path is required' });
    const out = tm.publishArtifact(session, { path: filePath, title: String(b.title || ''), description: b.description ? String(b.description) : undefined, folder: b.folder ? String(b.folder) : undefined });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // agent proposes a new skill (Lever 6 — procedural memory). Drafts a NOT-YET-PUBLISHED skill in the
  // library (`materialize()` skips it) and posts a 'skill.proposed' inbox card for an owner/admin to
  // review + publish. Pre-auth loopback like the other agent tools; gated by the session secret.
  if (method === 'POST' && p === '/api/skills/propose') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const name = String(b.name || '').trim();
    const description = String(b.description || '').trim();
    const body = String(b.body || '').trim();
    if (!name || !description || !body) return sendJson(res, 400, { error: 'name, description, and body are required' });
    const out = tm.proposeSkill(session, agent, { name, description, body, rationale: b.rationale ? String(b.rationale) : undefined });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // An agent proposes a Host connection (`host_propose`) — a credential-less, inactive org host that an
  // owner/admin reviews + publishes. Session-secret gated (agent resolved from the session row, never trusted).
  if (method === 'POST' && p === '/api/hosts/propose') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const name = String(b.name || '').trim();
    const match = String(b.match || '').trim();
    if (!name || !match) return sendJson(res, 400, { error: 'name and match are required' });
    const out = tm.proposeHost(session, agent, {
      name, match,
      protocol: b.protocol ? String(b.protocol) : undefined,
      posture: b.posture ? String(b.posture) : undefined,
      rationale: b.rationale ? String(b.rationale) : undefined,
    });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // agent discovers what's installable (`skill_find`) — its own library (with an `active` flag) + the
  // bundled catalog, and (when `q` is given) matching skills from the skills.sh directory (remote repos).
  // Read-only; the counterpart to `skill_request`. Pre-auth loopback, session-secret gated.
  if (method === 'GET' && p === '/api/skills/discover') {
    const session = String(url.searchParams.get('session') || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const local = tm.requestableSkills(agent);
    const q = String(url.searchParams.get('q') || '').trim();
    let remote: { name: string; source: string; installs: number; installed: boolean }[] = [];
    if (q) {
      try {
        const have = new Set(os.skills.list().map((s) => s.name));
        remote = (await searchSkillsh(q)).map((h) => ({ name: h.name, source: h.source, installs: h.installs, installed: have.has(h.name.toLowerCase()) }));
      } catch { /* a skills.sh outage must not break local discovery — just return no remote hits */ }
    }
    return sendJson(res, 200, { ...local, remote });
  }
  // agent ASKS a human to install an existing catalog skill (`skill_request`) — it never installs
  // itself. Posts an owner/admin 'skill.request' card; the install happens only when a human approves
  // (POST /api/skills/requests/:id/approve). Pre-auth loopback, session-secret gated.
  if (method === 'POST' && p === '/api/skills/request') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const name = String(b.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'name is required' });
    const out = await tm.requestSkill(session, agent, { name, source: b.source ? String(b.source) : undefined, rationale: b.rationale ? String(b.rationale) : undefined });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // native Slack egress: the agent posts its reply back to the thread that triggered the session.
  // Channel/thread come from the server-side binding (slack_threads) — the agent only sends text.
  if (method === 'POST' && p === '/api/agent/slack/reply') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!slack) return sendJson(res, 503, { error: 'slack not available' });
    const out = await slack.reply(session, String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // native Discord egress: the analogue of slack/reply. Channel/message come from the server-side
  // binding (discord_threads) — the agent only sends text.
  if (method === 'POST' && p === '/api/agent/discord/reply') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!discord) return sendJson(res, 503, { error: 'discord not available' });
    const out = await discord.reply(session, String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // native Slack egress (proactive): post to any channel by id/name. Not thread-bound — the agent
  // supplies the channel. Audited as `slack.send`. Available to any session when Slack is configured.
  if (method === 'POST' && p === '/api/agent/slack/send') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!slack) return sendJson(res, 503, { error: 'slack not available' });
    const out = await slack.sendToChannel(session, String(b.channel || ''), String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // OS-owned image generation (`image_generate` MCP tool): govern → vendor call → snapshot each image
  // into the Artifacts gallery. Pre-auth loopback, session-secret gated like the other agent tools;
  // TerminalManager.generateImage owns the gate/backend/artifact/audit path.
  if (method === 'POST' && p === '/api/agent/image/generate') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const out = await tm.generateImage(session, {
      prompt: String(b.prompt || ''),
      model: b.model ? String(b.model) : undefined,
      size: b.size ? String(b.size) : undefined,
      n: b.n !== undefined ? Number(b.n) : undefined,
    });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // OS-owned image EDIT/upscale (`image_edit` MCP tool): edit or upscale an existing image → a new
  // artifact. Same loopback/gate posture as image/generate; TerminalManager.editImage owns the path.
  if (method === 'POST' && p === '/api/agent/image/edit') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const out = await tm.editImage(session, {
      image: String(b.image || ''),
      prompt: b.prompt ? String(b.prompt) : undefined,
      scale: b.scale !== undefined ? Number(b.scale) : undefined,
      model: b.model ? String(b.model) : undefined,
      operation: b.operation === 'remove-background' ? 'remove-background' : undefined,
    });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // OS-owned VIDEO generation (`video_generate` MCP tool). Async: submits + persists a job, briefly
  // polls, then the tick poller finishes it. Pre-auth loopback, session-secret gated like the others.
  if (method === 'POST' && p === '/api/agent/video/generate') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const out = await tm.generateVideo(session, {
      prompt: String(b.prompt || ''),
      model: b.model ? String(b.model) : undefined,
      durationSec: b.durationSec !== undefined ? Number(b.durationSec) : undefined,
      image: b.image ? String(b.image) : b.imageUrl ? String(b.imageUrl) : undefined,
    });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // OS-owned video/image UNDERSTANDING (`video_understand` MCP tool): delegate to an Atlas multimodal LLM
  // and return the text answer. Same loopback/gate posture; TerminalManager.understandVideo owns the path.
  if (method === 'POST' && p === '/api/agent/video/understand') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const out = await tm.understandVideo(session, {
      video: String(b.video || b.image || ''),
      prompt: b.prompt ? String(b.prompt) : undefined,
      model: b.model ? String(b.model) : undefined,
      kind: b.kind === 'image' ? 'image' : 'video',
    });
    return sendJson(res, out.ok ? 200 : 400, out);
  }
  // native Slack egress (proactive): DM a person by Slack user id or email. Audited as `slack.dm`.
  if (method === 'POST' && p === '/api/agent/slack/dm') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!slack) return sendJson(res, 503, { error: 'slack not available' });
    const out = await slack.dmMember(session, String(b.to || ''), String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // native Discord egress (proactive): post to any channel by id. Audited as `discord.send`.
  if (method === 'POST' && p === '/api/agent/discord/send') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!discord) return sendJson(res, 503, { error: 'discord not available' });
    const out = await discord.sendToChannel(session, String(b.channel || ''), String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // native Discord egress (proactive): DM a person by Discord user id. Audited as `discord.dm`.
  if (method === 'POST' && p === '/api/agent/discord/dm') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!discord) return sendJson(res, 503, { error: 'discord not available' });
    const out = await discord.dmMember(session, String(b.to || ''), String(b.text || ''));
    return sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true } : { ok: false, error: out.error });
  }
  // launcher signal that the claude process exited (→ completion fallback + mark idle).
  if (method === 'POST' && p === '/api/ended') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.markEnded(session);
    return sendJson(res, 200, { ok: true });
  }
  // Claude Code Stop hook (stop-hook.sh): claude finished a turn. For an UNATTENDED (automation/task)
  // run this is the end-of-run signal — the server closes it now UNLESS a human has taken it over / is
  // watching / it's blocked on a person (see markTurnIdle). Best-effort, session-secret gated.
  if (method === 'POST' && p === '/api/turn-idle') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.markTurnIdle(session);
    return sendJson(res, 200, { ok: true });
  }
  // Claude Code Notification hook (notify-hook.sh): the session is blocked waiting on the human
  // (permission prompt / idle). Surface a per-session inbox bell. Session-secret gated like the rest.
  if (method === 'POST' && p === '/api/notify') {
    const b = await readBody(req);
    const session = String(b.sessionId || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.notify(session, String(b.agent || ''), String(b.kind || ''), String(b.message || ''));
    return sendJson(res, 200, { ok: true });
  }
  // attach-wrapper signal that a stopped session was resurrected (→ mark running again).
  if (method === 'POST' && p === '/api/resumed') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.markResumed(session);
    return sendJson(res, 200, { ok: true });
  }

  // ── knowledge base, agent-facing (loopback, session-scoped). author = agent:<id>, derived server-side ──
  if (method === 'GET' && p === '/api/kb/search') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const tags = (url.searchParams.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean);
    const pages = os.kb.search({
      tenant: os.tenant, query: url.searchParams.get('q') || '',
      section: url.searchParams.get('section') || undefined,
      tags: tags.length ? tags : undefined, limit: Number(url.searchParams.get('limit')) || 12,
    });
    // `sections` is the full folder tree (all existing section paths) so an agent can file a new page
    // into the existing structure instead of inventing an inconsistent folder name.
    return sendJson(res, 200, { pages, sections: os.kb.sections(os.tenant) });
  }
  if (method === 'GET' && p === '/api/kb/read') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const page = os.kb.read(os.tenant, url.searchParams.get('section') || '', url.searchParams.get('slug') || '');
    if (page) os.kb.recordRead(page.id); // an agent opened it — bump the fetch counter (auto-archive signal)
    return sendJson(res, page ? 200 : 404, page ? { page } : { error: 'page not found' });
  }
  if (method === 'POST' && p === '/api/kb/write') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!b.section || !b.slug || b.body === undefined) return sendJson(res, 400, { error: 'section, slug and body are required' });
    try {
      const page = os.kb.write({
        tenant: os.tenant, section: String(b.section), slug: String(b.slug),
        title: typeof b.title === 'string' ? b.title : undefined, body: String(b.body),
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        summary: typeof b.summary === 'string' ? b.summary : undefined, author: `agent:${agent}`,
      });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'kb.written', data: { id: page.id, section: page.section, slug: page.slug, rev: page.rev } });
      return sendJson(res, 200, { ok: true, id: page.id, rev: page.rev, section: page.section, slug: page.slug });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // KB revision history for a page (the agent can see what a write would clobber / what to revert to).
  if (method === 'GET' && p === '/api/kb/history') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const page = os.kb.read(os.tenant, url.searchParams.get('section') || '', url.searchParams.get('slug') || '');
    if (!page) return sendJson(res, 404, { error: 'page not found' });
    return sendJson(res, 200, { current: page.rev, revisions: os.kb.history(page.id) });
  }
  // Revert a KB page to an earlier revision — itself a new, auditable, revertable write.
  if (method === 'POST' && p === '/api/kb/revert') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const page = os.kb.read(os.tenant, String(b.section || ''), String(b.slug || ''));
    if (!page) return sendJson(res, 404, { error: 'page not found' });
    const rev = Number(b.rev);
    if (!Number.isInteger(rev) || rev < 1) return sendJson(res, 400, { error: 'a valid rev (>=1) is required' });
    try {
      const reverted = os.kb.revert(page.id, rev, `agent:${agent}`);
      if (!reverted) return sendJson(res, 200, { ok: false, error: `no such revision ${rev}` });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'kb.reverted', data: { id: page.id, section: page.section, slug: page.slug, toRev: rev, rev: reverted.rev } });
      return sendJson(res, 200, { ok: true, section: reverted.section, slug: reverted.slug, rev: reverted.rev });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Tasks (agent loopback) ───────────────────────────────────────────────────
  // The shared work queue, reached by an in-session agent AS ITSELF: author/assignee:"me" are derived
  // server-side from the session row (never trusted from the body), like kb_write/schedule. Edits are
  // auto-apply + audited; a dispatched session is separately gated. See docs/tasks-plan.md.
  if (method === 'POST' && p === '/api/tasks/create') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const title = String(b.title || '').trim();
    if (!title) return sendJson(res, 400, { error: 'title is required' });
    // Resolve the assignee, then validate an `agent:<id>` target actually exists — a task assigned to a
    // non-existent agent silently never dispatches (it just rots on the board), so reject it up front
    // with the valid roster instead of accepting an inert hand-off.
    const assignee = b.assignee === 'me' ? `agent:${agent}` : (typeof b.assignee === 'string' && b.assignee ? b.assignee : undefined);
    if (assignee && assignee.startsWith('agent:')) {
      const targetId = assignee.slice('agent:'.length);
      if (!os.agents.get(targetId)) {
        const valid = [...os.agents.values()].filter((a) => a.runtime === 'claude-code').map((a) => a.id).join(', ');
        return sendJson(res, 200, { ok: false, error: `no agent "${targetId}" — assign to one of: ${valid} (call list_agents to see the roster)` });
      }
    }
    // Poke-back: an agent delegating to ANOTHER agent is woken when the delegate finishes (the MCP layer
    // defaults this ON for agent→agent hand-offs so the delegation loop closes itself). We stamp the
    // caller's agent id + pinned claude transcript so the task notifier can wake this session on
    // done/blocked. Only for a hand-off to a DIFFERENT agent — a self-assignment has no separate caller to
    // wake (and waking your own transcript from its own delegate would loop), so we drop the self-poke.
    const pokeOnDone = (b.pokeOnDone === true || b.pokeOnDone === 'true')
      && !!assignee && assignee.startsWith('agent:') && assignee !== `agent:${agent}`;
    try {
      // owner defaults to the creating session's run-as member — HUMAN PASSTHROUGH: a task filed by an
      // agent acting as Alice dispatches (later) as Alice too, so accountability ladders to the person.
      const task = os.tasks.create({
        tenant: os.tenant, title, body: b.body !== undefined ? String(b.body) : '',
        assignee,
        owner: tm.sessionRunAs(session),
        priority: typeof b.priority === 'number' ? b.priority : undefined,
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        parentId: typeof b.parentId === 'string' ? b.parentId : undefined,
        mode: b.mode === 'interactive' ? 'interactive' : 'headless',
        autoDispatch: b.autoDispatch === true || b.autoDispatch === 'true',
        goalId: typeof b.goalId === 'string' && b.goalId ? b.goalId : undefined,
        criteria: typeof b.criteria === 'string' && b.criteria ? b.criteria : undefined,
        dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : undefined,
        callerAgent: pokeOnDone ? `agent:${agent}` : undefined,
        callerClaudeId: pokeOnDone ? tm.sessionClaudeId(session) : undefined,
        pokeOnDone: pokeOnDone || undefined,
        dueAt: typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined,
        createdBy: `agent:${agent}`,
      });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'task.created', data: { id: task.id, title: task.title, assignee: task.assignee ?? null } });
      // Immediate dispatch (parity with the console route above): an agent-assigned auto-dispatch hand-off
      // starts NOW rather than waiting for the next ~20s scheduler tick, so a delegated task begins the
      // moment it's filed — and a waiting caller (task_wait / wait:true) makes progress at once.
      if (task.autoDispatch && (task.assignee || '').startsWith('agent:')) autos.dispatchTask(task.id, { guard: true, by: `agent:${agent}` });
      return sendJson(res, 200, { ok: true, id: task.id });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (method === 'GET' && p === '/api/tasks/list') {
    const session = url.searchParams.get('session') || '';
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const rawAssignee = url.searchParams.get('assignee') || undefined;
    const tasks = os.tasks.list({
      tenant: os.tenant,
      status: (url.searchParams.get('status') as TaskStatus) || undefined,
      assignee: rawAssignee === 'me' ? `agent:${agent}` : rawAssignee,
      label: url.searchParams.get('label') || undefined,
      query: url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    });
    return sendJson(res, 200, { tasks });
  }
  if (method === 'GET' && p === '/api/tasks/get') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const found = os.tasks.withEvents(url.searchParams.get('id') || '');
    if (!found) return sendJson(res, 404, { error: 'task not found' });
    return sendJson(res, 200, { ...found, attachments: os.tasks.attachments(found.task.id), dependents: os.tasks.dependents(found.task.id) });
  }
  if (method === 'POST' && p === '/api/tasks/claim') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const task = os.tasks.claim(String(b.id || ''), agent, session);
    if (!task) return sendJson(res, 200, { ok: false, error: 'task not found, already claimed, or closed' });
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'task.claimed', data: { id: task.id } });
    return sendJson(res, 200, { ok: true, task });
  }
  if (method === 'POST' && p === '/api/tasks/update') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '');
    const task = os.tasks.update(id, {
      status: typeof b.status === 'string' ? (b.status as TaskStatus) : undefined,
      assignee: b.assignee === null ? null : (b.assignee === 'me' ? `agent:${agent}` : (typeof b.assignee === 'string' ? b.assignee : undefined)),
      priority: typeof b.priority === 'number' ? b.priority : undefined,
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      mode: b.mode === 'headless' || b.mode === 'interactive' ? b.mode : undefined,
      goalId: b.goalId === null ? null : (typeof b.goalId === 'string' ? b.goalId : undefined),
      criteria: b.criteria === null ? null : (typeof b.criteria === 'string' ? b.criteria : undefined),
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : undefined,
      dueAt: b.dueAt === null ? null : (typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined),
      note: typeof b.note === 'string' ? b.note : undefined,
      by: `agent:${agent}`,
    });
    if (!task) return sendJson(res, 200, { ok: false, error: 'task not found' });
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: task.status === 'done' ? 'task.completed' : 'task.updated', data: { id: task.id, status: task.status } });
    return sendJson(res, 200, { ok: true, task });
  }
  // A delegating agent long-polls this until a handed-off task finishes (the `task_wait` tool). Each poll,
  // if the task is stalled — not terminal, not deliberately `blocked`, assigned to an agent, and nothing
  // live is on it — kick a guarded immediate dispatch so WAITING drives the work forward and auto-retries a
  // crashed run. dispatchTask is guarded (no double-spawn while alive) + attempt-ceilinged (parks `blocked`
  // after TASK_MAX_ATTEMPTS), so re-polling a crash-looping child self-limits. Returns a compact snapshot;
  // no new trust surface — the dispatched session is still fully gated. Auto-apply + audited via dispatchTask.
  if (method === 'POST' && p === '/api/tasks/wait') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const t = os.tasks.get(String(b.id || ''));
    if (!t) return sendJson(res, 200, { ok: false, error: 'task not found' });
    const terminal = t.status === 'done' || t.status === 'cancelled';
    if (!terminal && t.status !== 'blocked' && (t.assignee || '').startsWith('agent:') && !(t.lastSessionId && tm.isAlive(t.lastSessionId))) {
      autos.dispatchTask(t.id, { guard: true, by: `wait:${agent}` });
    }
    // The delegate's closing "what I did" — the newest comment (task_update writes the done note as one).
    const note = os.tasks.latestNote(t.id) ?? null;
    return sendJson(res, 200, { ok: true, status: t.status, terminal, note, assignee: t.assignee ?? null });
  }
  // agent attaches a file from its own working folder onto a task (→ snapshot + `attach` event + audit).
  // The path is resolved strictly under the agent folder by the store; only that session may attach.
  if (method === 'POST' && p === '/api/tasks/attach') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim();
    const filePath = String(b.path || '').trim();
    if (!id || !filePath) return sendJson(res, 200, { ok: false, error: 'id and path are required' });
    const out = tm.attachTaskFile(session, id, filePath);
    return sendJson(res, 200, out.ok ? { ok: true, id: out.id, filename: out.filename } : { ok: false, error: out.error });
  }
  // Agent-triggered dispatch: spawn a governed session to work an agent-assigned task NOW, rather than
  // waiting on the scheduler tick (the async delegation kick). Same engine as the console "Dispatch" and
  // the tick — `autos.dispatchTask` — but guarded (guard:true), so a runaway agent can't pile up parallel
  // sessions on one task: if a session is already working it, this no-ops with a clear reason, and the
  // TASK_MAX_ATTEMPTS ceiling still parks a task that keeps failing. The spawned session runs AS the task
  // owner (human passthrough) and every effect it has still passes the gateway.
  if (method === 'POST' && p === '/api/tasks/dispatch') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim();
    if (!id) return sendJson(res, 200, { ok: false, error: 'id is required' });
    const r = autos.dispatchTask(id, { guard: true, by: `agent:${agent}` });
    return sendJson(res, 200, r.ok ? { ok: true, sessionId: r.sessionId } : { ok: false, error: r.reason });
  }

  // ── Goals (agent loopback) ───────────────────────────────────────────────────
  // Agents READ the strategic layer (goal_list/goal_get) and PROPOSE drafts (goal_propose). They cannot
  // activate or edit a goal — that stays a human owner/admin action on the console. See docs/goals-plan.md.
  if (method === 'GET' && p === '/api/goals/list') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const goals = os.goals.list({
      tenant: os.tenant,
      status: (url.searchParams.get('status') as GoalStatus) || undefined,
      query: url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit')) || undefined,
    });
    return sendJson(res, 200, { goals });
  }
  if (method === 'GET' && p === '/api/goals/get') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const found = os.goals.withEvents(url.searchParams.get('id') || '');
    if (!found) return sendJson(res, 404, { error: 'goal not found' });
    return sendJson(res, 200, { ...found, tasks: os.tasks.tasksForGoal(found.goal.id), progress: os.goals.progress(found.goal.id) });
  }
  // agent proposes a new goal — drafts a NOT-YET-ACTIVE goal (status 'draft') + posts a 'goal.proposed'
  // inbox card for an owner/admin to review and activate. Auto-apply + audited, like skill_propose.
  if (method === 'POST' && p === '/api/goals/propose') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const title = String(b.title || '').trim();
    if (!title) return sendJson(res, 400, { error: 'title is required' });
    try {
      const goal = os.goals.create({
        tenant: os.tenant, title, body: b.body !== undefined ? String(b.body) : '',
        status: 'draft',
        target: typeof b.target === 'string' && b.target ? b.target : undefined,
        owner: tm.sessionRunAs(session),
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        createdBy: `agent:${agent}`,
      });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'goal.proposed', data: { id: goal.id, title: goal.title } });
      tm.postGoalCard({ goalId: goal.id, agent, title: `Goal proposed — ${goal.title}`, body: goal.body || '(no description)', audience: { kind: 'admins' } });
      return sendJson(res, 200, { ok: true, id: goal.id });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Agents (agent loopback) ──────────────────────────────────────────────────
  // The agent-author (and any agent, as the delegation surface) creates/refines agents AS ITSELF. Like
  // the tasks/kb tools this is auto-apply + audited (creating a definition escalates nothing — every
  // effect the new agent later has still passes the gate, and only a human can run/assign it). Mirrors
  // the member-facing POST /api/agents + /:id/config routes below, minus the admin gate.
  if (method === 'POST' && p === '/api/agents/create') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!os.paths) return sendJson(res, 200, { ok: false, error: 'creating agents requires a data home' });
    const id = String(b.id || '').trim().toLowerCase();
    const description = String(b.description || '').trim();
    const claudeMd = String(b.claudeMd ?? '');
    const { tuning, error: tErr } = sanitizeRuntimeTuning(b);
    if (tErr) return sendJson(res, 200, { ok: false, error: tErr });
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return sendJson(res, 200, { ok: false, error: 'id must be lowercase letters, digits and hyphens (2–40 chars, starting with a letter)' });
    if (os.agents.get(id)) return sendJson(res, 200, { ok: false, error: `an agent named "${id}" already exists` });
    if (!claudeMd.trim()) return sendJson(res, 200, { ok: false, error: 'a CLAUDE.md is required' });
    const folder = path.join(os.paths.userAgents, id);
    if (fs.existsSync(folder)) return sendJson(res, 200, { ok: false, error: `folder "${id}" already exists in the agents home` });
    const examplePrompts = sanitizeExamplePrompts(b.examplePrompts);
    const category = sanitizeCategory(b.category);
    const icon = sanitizeIcon(b.icon);
    const shellSecrets = sanitizeShellSecrets(b.shellSecrets);
    const manifest: AgentManifest = {
      id, version: '1.0.0', description,
      ...(category ? { category } : {}),
      principal: `svc-${id}`, policyContext: 'default@v3', runtime: 'claude-code',
      ...tuning,
      ...(examplePrompts ? { examplePrompts } : {}),
      ...(shellSecrets ? { shellSecrets } : {}),
      ...(icon ? { icon } : {}),
      budget: { usdCap: 2.0, tokenCap: 400000, wallClockMs: 1800000 },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), claudeMd);
    os.registerAgent({ ...manifest, dir: folder });
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'agent.created', data: { agent: id, runtime: 'claude-code', dir: folder, by: `agent:${agent}` } });
    return sendJson(res, 200, { ok: true, id });
  }
  if (method === 'POST' && p === '/api/agents/update') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!os.paths) return sendJson(res, 200, { ok: false, error: 'editing agents requires a data home' });
    // Self-only: an agent edits ITS OWN listing. The target is the session's agent, never a body id —
    // no agent can rewrite another agent's prompt/tuning (that side effect would skip the gate). A
    // human edits any agent from the console (the owner/admin routes below).
    const id = agent;
    if (b.id !== undefined && String(b.id).trim().toLowerCase() !== id)
      return sendJson(res, 200, { ok: false, error: `you can only edit your own listing ("${id}"), not "${String(b.id).trim().toLowerCase()}"` });
    const ag = os.agents.get(id);
    if (!ag?.dir) return sendJson(res, 200, { ok: false, error: `unknown agent "${id}"` });
    if (ag.runtime !== 'claude-code') return sendJson(res, 200, { ok: false, error: 'only claude-code agents can be edited' });
    // Only agents that live under the data home are editable (the read-only bundled examples are not).
    const userRoot = path.resolve(os.paths.userAgents) + path.sep;
    if (!(path.resolve(ag.dir) + path.sep).startsWith(userRoot)) return sendJson(res, 200, { ok: false, error: 'built-in agents cannot be edited' });
    const { tuning, error: tErr } = sanitizeRuntimeTuning({ model: 'model' in b ? b.model : ag.model, effort: 'effort' in b ? b.effort : ag.effort });
    if (tErr) return sendJson(res, 200, { ok: false, error: tErr });
    const before = readAgentSnapshot(ag);
    // Only fields present in the body are changed; everything else is preserved.
    const description = 'description' in b ? String(b.description ?? '').trim() : ag.description;
    const category = 'category' in b ? sanitizeCategory(b.category) : ag.category;
    const icon = 'icon' in b ? sanitizeIcon(b.icon) : ag.icon;
    const examplePrompts = 'examplePrompts' in b ? sanitizeExamplePrompts(b.examplePrompts) : ag.examplePrompts;
    const shellSecrets = 'shellSecrets' in b ? sanitizeShellSecrets(b.shellSecrets) : ag.shellSecrets;
    const next: AgentManifest = { ...ag, description, model: tuning.model, effort: tuning.effort, category, icon, examplePrompts, shellSecrets };
    const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
    fs.writeFileSync(path.join(ag.dir, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
    if ('claudeMd' in b) fs.writeFileSync(path.join(ag.dir, 'CLAUDE.md'), String(b.claudeMd ?? ''));
    os.registerAgent(next);
    const after = manifestToSnapshot(next, 'claudeMd' in b ? String(b.claudeMd ?? '') : before.claudeMd);
    const rev = os.agentRevisions.commit(os.tenant, id, before, after, 'agent self-edit', `agent:${agent}`);
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'agent.config.updated', data: { agent: id, model: tuning.model, effort: tuning.effort, category, claudeMd: 'claudeMd' in b, rev, by: `agent:${agent}` } });
    return sendJson(res, 200, { ok: true, id, rev });
  }
  // Agent reads its OWN revision history (self-scoped) — pick a rev to revert to.
  if (method === 'POST' && p === '/api/agents/history') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const revisions = os.agentRevisions.list(agent).map((r) => ({
      rev: r.rev, author: r.author, summary: r.summary, createdAt: r.createdAt,
      description: r.description, claudeChars: r.claudeMd.length,
    }));
    return sendJson(res, 200, { ok: true, agent, revisions });
  }
  // Agent reverts ITS OWN listing to a prior revision (self-scoped) — the rollback for a bad self-edit.
  if (method === 'POST' && p === '/api/agents/revert') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!os.paths) return sendJson(res, 200, { ok: false, error: 'editing agents requires a data home' });
    const ag = os.agents.get(agent);
    if (!ag?.dir) return sendJson(res, 200, { ok: false, error: `unknown agent "${agent}"` });
    const rev = Number(b.rev);
    const target = os.agentRevisions.get(agent, rev);
    if (!target) return sendJson(res, 200, { ok: false, error: `no revision ${b.rev} for "${agent}"` });
    const before = readAgentSnapshot(ag);
    const next = applyAgentSnapshot(os, ag, target);
    const newRev = os.agentRevisions.commit(os.tenant, agent, before, manifestToSnapshot(next, target.claudeMd), `revert to rev ${rev}`, `agent:${agent}`);
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'agent.config.reverted', data: { agent, toRev: rev, rev: newRev, by: `agent:${agent}` } });
    return sendJson(res, 200, { ok: true, id: agent, toRev: rev, rev: newRev });
  }

  // ── Apps (agent loopback) ────────────────────────────────────────────────────
  // An agent builds a hosted app AS ITSELF. Like agents/skills this is auto-apply + audited, but the
  // app lands PROPOSED (published:false) — a human reviews the code + capabilities and publishes it
  // (the review gate; see docs/apps-plan.md §6). Single-file for v1: the agent passes the server.js
  // source directly (like agent_create's claudeMd); multi-file bundles are a follow-up.
  if (method === 'POST' && p === '/api/apps/create') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    if (!os.apps.enabled) return sendJson(res, 200, { ok: false, error: 'hosting apps requires a data home' });
    const id = String(b.id || '').trim().toLowerCase();
    const name = String(b.name || '').trim() || id;
    if (!isValidAppSlug(id)) return sendJson(res, 200, { ok: false, error: 'id must be a DNS-safe slug: lowercase letters, digits and single hyphens (1–32 chars)' });
    if (os.apps.get(id)) return sendJson(res, 200, { ok: false, error: `an app named "${id}" already exists` });
    try {
      const manifest = os.apps.scaffold(id, {
        name, icon: b.icon !== undefined ? String(b.icon) : undefined,
        owner: tm.sessionRunAs(session), createdBy: `agent:${agent}`,
        capabilities: b.capabilities,
      });
      if (typeof b.serverJs === 'string' && b.serverJs.trim()) {
        fs.writeFileSync(path.join(manifest.dir!, 'app', 'server.js'), String(b.serverJs));
      }
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'app.created', data: { app: id, by: `agent:${agent}` } });
      tm.postAppCard({ slug: id, agent, title: `App proposed — ${name}`, body: `${agent} built a hosted app "${name}" (\`${id}\`). Review its code + capabilities and publish it to make it live.` });
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // An agent lists the apps in this workspace + their live status (to build on / avoid duplicating).
  if (method === 'GET' && p === '/api/apps/list') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const appList = os.apps.list().map((a) => ({ id: a.id, name: a.name, published: !!a.published, createdBy: a.createdBy, status: appSup?.statusOf(a.id).status ?? 'cold' }));
    return sendJson(res, 200, { ok: true, apps: appList });
  }
  // An agent edits an app's manifest/source. Edits to a PUBLISHED app flip it back to proposed and post
  // a re-review card — an agent can't push code into a live app without a human re-publishing it.
  if (method === 'POST' && p === '/api/apps/update') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim().toLowerCase();
    const cur = os.apps.get(id);
    if (!cur) return sendJson(res, 200, { ok: false, error: `unknown app "${id}"` });
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'icon', 'lifecycle'] as const) if (b[k] !== undefined) patch[k] = b[k];
    if (b.idleTimeoutSec !== undefined) patch.idleTimeoutSec = Number(b.idleTimeoutSec);
    if (b.capabilities !== undefined) patch.capabilities = b.capabilities;
    const saved = os.apps.save(id, patch);
    if (typeof b.serverJs === 'string') fs.writeFileSync(path.join(cur.dir!, cur.entry), String(b.serverJs));
    const wasPublished = !!cur.published;
    if (wasPublished) { os.apps.setPublished(id, false); appSup?.kill(id, 'edited — needs re-publish'); }
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'app.updated', data: { app: id, by: `agent:${agent}`, unpublished: wasPublished } });
    if (wasPublished) tm.postAppCard({ slug: id, agent, title: `App edited — ${cur.name}`, body: `${agent} changed the live app "${cur.name}" (\`${id}\`); it was unpublished for review. Re-publish to make the change live.` });
    return sendJson(res, 200, { ok: true, id, rev: saved?.version, unpublished: wasPublished });
  }
  // Multi-file authoring (agent loopback): an agent lists / reads / writes / deletes an app's source
  // files, so it can build a structured app (routes/, lib/, templates/) not just a single server.js.
  // Same session-secret gate as the other app tools; the store sandboxes every path.
  if (method === 'GET' && p === '/api/apps/files') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(url.searchParams.get('id') || '').trim().toLowerCase();
    if (!os.apps.get(id)) return sendJson(res, 200, { ok: false, error: `unknown app "${id}"` });
    const rel = url.searchParams.get('path');
    if (rel) {
      const content = os.apps.readFile(id, rel);
      return sendJson(res, 200, content === null ? { ok: false, error: 'no such file' } : { ok: true, path: rel, content });
    }
    return sendJson(res, 200, { ok: true, files: os.apps.listFiles(id) });
  }
  if (method === 'POST' && p === '/api/apps/file/write') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim().toLowerCase();
    const cur = os.apps.get(id);
    if (!cur) return sendJson(res, 200, { ok: false, error: `unknown app "${id}"` });
    const rel = String(b.path || '');
    if (!os.apps.writeFile(id, rel, typeof b.content === 'string' ? b.content : '')) return sendJson(res, 200, { ok: false, error: 'invalid or protected path' });
    const wasPublished = !!cur.published;
    if (wasPublished) { os.apps.setPublished(id, false); appSup?.kill(id, 'edited — needs re-publish'); }
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'app.file.written', data: { app: id, path: rel, by: `agent:${agent}`, unpublished: wasPublished } });
    if (wasPublished) tm.postAppCard({ slug: id, agent, title: `App edited — ${cur.name}`, body: `${agent} edited \`${rel}\` in the live app "${cur.name}" (\`${id}\`); it was unpublished for review. Re-publish to make the change live.` });
    return sendJson(res, 200, { ok: true, id, path: rel, unpublished: wasPublished });
  }
  if (method === 'POST' && p === '/api/apps/file/delete') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const id = String(b.id || '').trim().toLowerCase();
    const cur = os.apps.get(id);
    if (!cur) return sendJson(res, 200, { ok: false, error: `unknown app "${id}"` });
    const rel = String(b.path || '');
    if (!os.apps.deleteFile(id, rel)) return sendJson(res, 200, { ok: false, error: 'cannot delete (missing, protected, or the entry file)' });
    if (cur.published) { os.apps.setPublished(id, false); appSup?.kill(id, 'edited — needs re-publish'); }
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'app.file.deleted', data: { app: id, path: rel, by: `agent:${agent}` } });
    return sendJson(res, 200, { ok: true, id, path: rel });
  }

  // ── App runtime callbacks (`/api/app/*`) ─────────────────────────────────────
  // A HOSTED APP calls these over loopback. It has no cookie and no session secret — it authenticates
  // with its per-launch app token (header `x-aos-app-secret`, exported as AOS_APP_TOKEN), verified by the
  // supervisor. These sit before the member gate, like the agent loopback routes, and enforce the app's
  // DEFAULT-DENY capabilities per call — so an app can only reach what its manifest declares. See
  // docs/apps-plan.md §4.
  const appSecretOk = (slug: string): boolean => !!appSup && appSup.verifyAppSecret(slug, String(req.headers['x-aos-app-secret'] || ''));
  if (method === 'POST' && p === '/api/app/dispatch') {
    const b = await readBody(req);
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!appSecretOk(slug)) return sendJson(res, 403, { error: 'bad app secret' });
    const manifest = os.apps.get(slug);
    if (!manifest || !manifest.published) return sendJson(res, 404, { error: 'app not found or not published' });
    const agent = String(b.agent || '').trim().toLowerCase();
    // Capability gate (default-deny): the app may only trigger agents its manifest names.
    const allowed = manifest.capabilities.dispatchAgents ?? [];
    if (!agent || !allowed.includes(agent)) return sendJson(res, 403, { error: `app "${slug}" is not allowed to dispatch "${agent}" (declare it in capabilities.dispatchAgents)` });
    if (!os.agents.has(agent)) return sendJson(res, 400, { error: `unknown agent: ${agent}` });
    const goal = String(b.goal || b.input || '').trim();
    if (!goal) return sendJson(res, 400, { error: 'goal is required' });
    // Run-as: the human currently using the app (forwarded from the trusted X-Aos-Member the app got),
    // else the app's accountable owner. Validate it resolves to a real member; unknown → ownerless.
    const wantRunAs = String(b.runAsMember || manifest.owner || '').trim();
    const runAsMember = wantRunAs ? os.team.getMemberByEmail(wantRunAs) : undefined;
    const owner = runAsMember?.email;
    const mode = b.mode === 'interactive' ? 'interactive' : 'headless';
    const task = os.tasks.create({
      tenant: os.tenant, title: goal.slice(0, 80), body: goal, assignee: `agent:${agent}`,
      owner, autoDispatch: true, mode, createdBy: `app:${slug}`,
    });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: `app:${slug}`, type: 'app.dispatch', data: { app: slug, agent, task: task.id, runAs: owner ?? null, mode } });
    const fire = autos.dispatchTask(task.id, { guard: true, by: `app:${slug}` });
    // Synchronous convenience: bounded server-side wait until the delegate reaches a terminal state,
    // re-kicking dispatch as needed (mirrors task_wait). On timeout the app polls /api/app/dispatches.
    if (b.wait) {
      const deadline = Date.now() + APP_DISPATCH_WAIT_MS;
      for (;;) {
        const cur = os.tasks.get(task.id);
        if (!cur) break;
        const terminal = cur.status === 'done' || cur.status === 'cancelled';
        if (terminal || cur.status === 'blocked' || Date.now() >= deadline) {
          return sendJson(res, 200, { ok: true, taskId: task.id, status: cur.status, terminal, note: os.tasks.latestNote(task.id) ?? null });
        }
        if (!(cur.lastSessionId && tm.isAlive(cur.lastSessionId))) autos.dispatchTask(task.id, { guard: true, by: `app:${slug}` });
        await sleep(1500);
      }
    }
    return sendJson(res, 200, { ok: true, taskId: task.id, status: 'todo', dispatched: fire.ok, sessionId: fire.ok ? fire.sessionId : undefined });
  }
  // An app lists the background runs IT triggered + their status (to poll for completion).
  if (method === 'GET' && p === '/api/app/dispatches') {
    const slug = String(url.searchParams.get('slug') || '').trim().toLowerCase();
    if (!appSecretOk(slug)) return sendJson(res, 403, { error: 'bad app secret' });
    const runs = os.tasks.list({ tenant: os.tenant, limit: 200 }).filter((t) => t.createdBy === `app:${slug}`).slice(0, 50).map((t) => ({
      taskId: t.id, title: t.title, agent: (t.assignee || '').replace(/^agent:/, ''), status: t.status,
      terminal: t.status === 'done' || t.status === 'cancelled', note: os.tasks.latestNote(t.id) ?? null,
      createdAt: t.createdAt,
    }));
    return sendJson(res, 200, { ok: true, dispatches: runs });
  }
  // An app reads one of ITS declared vault secrets at runtime (e.g. a key rotated since launch). Gated
  // by the per-app secret AND the manifest's default-deny `capabilities.secrets` — an app can only read
  // keys it declares. Value returned to the app only; audit records the key + found, never the value.
  if (method === 'POST' && p === '/api/app/secret/get') {
    const b = await readBody(req);
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!appSecretOk(slug)) return sendJson(res, 403, { error: 'bad app secret' });
    const manifest = os.apps.get(slug);
    if (!manifest || !manifest.published) return sendJson(res, 404, { error: 'app not found or not published' });
    const key = String(b.key || '').trim();
    if (!key || !(manifest.capabilities.secrets ?? []).includes(key)) return sendJson(res, 403, { error: `app "${slug}" may not read "${key}" (declare it in capabilities.secrets)` });
    const value = os.secrets.getSync(os.tenant, `app:${slug}`, key);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: `app:${slug}`, type: 'app.secret.read', data: { app: slug, key, found: value !== undefined } });
    return sendJson(res, 200, value === undefined ? { ok: false, error: 'not set' } : { ok: true, key, value });
  }

  // Every other /api/* route requires a logged-in member.
  const member = memberFor(os, req);
  if (p.startsWith('/api/') && !member) return sendJson(res, 401, { error: 'not authenticated' });
  const me = member as Member; // safe below: all /api handlers past here are guarded

  if (method === 'GET' && p === '/api/state') {
    // Members see only the agents they're allowed to run; owner/admin see all.
    const agents = terminalAgents(os).filter((a) => os.team.canRun(me, a.id));
    return sendJson(res, 200, {
      tenant: os.tenant,
      tenantName: os.tenantName,
      version: VERSION,
      // The IANA zone the box runs in — cron schedules fire in this local time, so the console labels
      // times/next-run with it (a browser in another zone would otherwise misread "9 AM").
      serverTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      policy: os.policy.id,
      home: os.paths?.home,
      me,
      terminalAgents: agents.map((a) => a.id), // back-compat: existing UI lists ids
      agents, // richer: { id, description, runtime }
      capabilities: os.registry.list().map((c) => ({ id: c.id, description: c.description, defaultRisk: c.defaultRisk })),
      // OS-owned orientation appended to every claude-code agent's system prompt (after Company
      // context). Surfaced read-only in Settings → System so operators can see what the fleet is told.
      operatingNotes: AGENT_OS_OPERATING_NOTES,
    });
  }

  // ── agent trust / maturity stats ───────────────────────────────────────────────
  // "Which agent can the system trust to run with less oversight?" A read-side roll-up of signals
  // already flowing through the gateway (autonomy, denials), the sessions/tasks tables, and the
  // agents' own self-reports. See src/state/agent-stats.ts for the scoring rules.
  if (method === 'GET' && p === '/api/agents/stats') {
    // Members see stats only for agents they may run; owner/admin see the whole fleet. Passing the
    // visible ids includes freshly-created, zero-run agents (confidence: 'none') instead of hiding them.
    const visible = terminalAgents(os).filter((a) => os.team.canRun(me, a.id)).map((a) => a.id);
    const allow = new Set(visible);
    const stats = computeAgentStats(os.db, visible).filter((s) => allow.has(s.agentId));
    return sendJson(res, 200, { stats });
  }
  const agentStatMatch = p.match(/^\/api\/agents\/([\w.-]+)\/stats$/);
  if (method === 'GET' && agentStatMatch) {
    const id = agentStatMatch[1];
    if (!os.team.canRun(me, id)) return sendJson(res, 403, { error: 'forbidden' });
    return sendJson(res, 200, { stats: computeAgentStat(os.db, id) });
  }

  // ── presence ─────────────────────────────────────────────────────────────────
  // Who's online now: the most-recent activity per member (stamped ≤1/min in resolveSession). The
  // client decides the "online" threshold from `now` vs each `lastSeen`. Any member may read it.
  if (method === 'GET' && p === '/api/presence') {
    const lastSeen: Record<string, number> = {};
    for (const r of os.team.presence()) lastSeen[r.memberId] = r.lastSeenAt;
    return sendJson(res, 200, { now: Date.now(), lastSeen });
  }

  // ── self-update ────────────────────────────────────────────────────────────────
  // The deploy is a git checkout; "update available?" = "is the checkout behind origin?". Any member
  // can SEE the notification (cached fetch), only the owner can APPLY it (pull + rebuild + restart).
  if (method === 'GET' && p === '/api/update') {
    const force = url.searchParams.get('force') === '1' && (me.role === 'owner' || me.role === 'admin');
    const status = await checkForUpdate(force);
    return sendJson(res, 200, { ...status, canApply: me.role === 'owner' });
  }
  if (method === 'POST' && p === '/api/update/apply') {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const pre = await checkForUpdate();
    if (!pre.updateAvailable) return sendJson(res, 200, { ok: false, steps: [], restarting: false, error: 'already up to date' });
    os.audit.append({ ts: Date.now(), runId: 'update', tenant: os.tenant, principal: me.email, type: 'update.applied', data: { from: pre.current, to: pre.latest, behind: pre.behind } });
    const result = await applyUpdate(os.tenant);
    return sendJson(res, 200, result);
  }
  // Plain restart (no pull/rebuild) — owner only. Bounces the process the service manager respawns.
  if (method === 'POST' && p === '/api/restart') {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    os.audit.append({ ts: Date.now(), runId: 'restart', tenant: os.tenant, principal: me.email, type: 'service.restarted', data: {} });
    return sendJson(res, 200, restartService(os.tenant));
  }

  // ── terminal attach authorization (nginx auth_request for /terminal/) ──────────
  // nginx calls this before proxying to ttyd. Being logged in is NOT enough (the generic /api/*
  // guard above already enforced that): a member may attach ONLY to a session they can see — their
  // own, or any if owner/admin. The targeted tmux name arrives as ?arg=aos-xxxx, on both the page
  // request and the websocket upgrade; nginx forwards the original request URI as X-Original-URI.
  // Requests with no session target (ttyd's own static assets) only need the valid login.
  if (method === 'GET' && p === '/api/terminal/authz') {
    const orig = String(req.headers['x-original-uri'] || '');
    const argFromOrig = orig.includes('?') ? new URLSearchParams(orig.slice(orig.indexOf('?') + 1)).get('arg') : null;
    const tmux = url.searchParams.get('arg') || argFromOrig || '';
    if (!tmux) return end(res, 204); // ttyd asset / no target → a valid login (already checked) is enough
    const sid = tm.sessionIdByTmux(tmux);
    if (!sid) return end(res, 403); // unknown session name → deny (no attach-to-most-recent)
    return end(res, tm.canViewSession(sid, me) ? 204 : 403);
  }

  // ── team / members / assignments ─────────────────────────────────────────────
  if (method === 'GET' && p === '/api/team') {
    return sendJson(res, 200, {
      me,
      members: os.team.listMembers(),
      assignments: os.team.listAssignments(),
      identities: os.team.identitiesByMember(), // member id → external accounts (chat run-as join keys)
      agents: terminalAgents(os), // ALL agents, so owner/admin can assign access
    });
  }
  if (method === 'POST' && p === '/api/team/invite') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const role = roleOf(b.role) ?? 'member';
    if (!email) return sendJson(res, 400, { error: 'email is required' });
    // Only an owner may mint another owner or an admin.
    if (role !== 'member' && me.role !== 'owner') return sendJson(res, 403, { error: 'only an owner can invite owners/admins' });
    const { member: invited, token } = os.team.invite({ email, role, invitedBy: me.id });
    return sendJson(res, 200, { member: invited, link: linkFor(req, token) });
  }
  const teamRole = p.match(/^\/api\/team\/([\w-]+)\/role$/);
  if (method === 'POST' && teamRole) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const b = await readBody(req);
    const role = roleOf(b.role);
    if (!role) return sendJson(res, 400, { error: 'valid role required' });
    const updated = os.team.setRole(teamRole[1], role);
    return sendJson(res, updated ? 200 : 404, updated ?? { error: 'not found' });
  }
  const teamLink = p.match(/^\/api\/team\/([\w-]+)\/login-link$/);
  if (method === 'POST' && teamLink) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const target = os.team.getMember(teamLink[1]);
    if (!target) return sendJson(res, 404, { error: 'not found' });
    const issued = os.team.issueLoginLink(target.email)!;
    return sendJson(res, 200, { link: linkFor(req, issued.token) });
  }
  // Identity map: link/unlink the external accounts a member is known by (Slack/Discord/email/github),
  // the join key chat triggers use for run-as. Admins manage anyone; a member may edit their OWN handles
  // (the self-service Chat IDs on the Profile page). The id segment excludes the literal
  // "identities"-suffixed paths from the single-segment member routes below.
  const teamIdentSet = p.match(/^\/api\/team\/([\w-]+)\/identities$/);
  if (method === 'POST' && teamIdentSet) {
    if (!isAdmin(me) && me.id !== teamIdentSet[1]) return sendJson(res, 403, { error: 'not allowed' });
    const b = await readBody(req);
    const provider = String(b.provider || '') as IdentityProvider;
    if (!IDENTITY_PROVIDERS.includes(provider)) return sendJson(res, 400, { error: 'unknown provider' });
    const externalId = String(b.externalId || '').trim();
    if (!os.team.getMember(teamIdentSet[1])) return sendJson(res, 404, { error: 'not found' });
    // Empty externalId clears the handle (the UI sends '' on blur of an emptied field).
    if (!externalId) {
      os.team.clearIdentity(teamIdentSet[1], provider);
    } else {
      const out = os.team.setIdentity(teamIdentSet[1], provider, externalId, me.email);
      if (!out) return sendJson(res, 400, { error: 'could not link identity' });
    }
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'identity.linked', data: { member: teamIdentSet[1], provider, set: !!externalId } });
    return sendJson(res, 200, { ok: true, identities: os.team.externalIdsFor(teamIdentSet[1]) });
  }
  const teamIdentDel = p.match(/^\/api\/team\/([\w-]+)\/identities\/([\w-]+)$/);
  if (method === 'DELETE' && teamIdentDel) {
    if (!isAdmin(me) && me.id !== teamIdentDel[1]) return sendJson(res, 403, { error: 'not allowed' });
    const provider = teamIdentDel[2] as IdentityProvider;
    if (!IDENTITY_PROVIDERS.includes(provider)) return sendJson(res, 400, { error: 'unknown provider' });
    os.team.clearIdentity(teamIdentDel[1], provider);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'identity.unlinked', data: { member: teamIdentDel[1], provider } });
    return sendJson(res, 200, { ok: true, identities: os.team.externalIdsFor(teamIdentDel[1]) });
  }
  // Profile picture: a member sets their OWN avatar; owners/admins may set anyone's. The value is a
  // self-contained data-URL image (the console resizes to a small square before upload), so there's no
  // file store to serve from. Placed above the single-segment member routes so the /avatar suffix wins.
  const teamAvatar = p.match(/^\/api\/team\/([\w-]+)\/avatar$/);
  if ((method === 'POST' || method === 'DELETE') && teamAvatar) {
    const targetId = teamAvatar[1];
    if (targetId !== me.id && !isAdmin(me)) return sendJson(res, 403, { error: 'you can only change your own avatar' });
    if (!os.team.getMember(targetId)) return sendJson(res, 404, { error: 'not found' });
    let avatar: string | null = null;
    if (method === 'POST') {
      const b = await readBody(req);
      const err = validateAvatar(b.avatar);
      if (err) return sendJson(res, 400, { error: err });
      avatar = String(b.avatar);
    }
    const updated = os.team.setAvatar(targetId, avatar);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'member.avatar', data: { member: targetId, set: !!avatar } });
    return sendJson(res, 200, { ok: true, member: updated });
  }
  const teamMember = p.match(/^\/api\/team\/([\w-]+)$/);
  if (method === 'DELETE' && teamMember) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const out = os.team.removeMember(teamMember[1]);
    if (!out.ok) return sendJson(res, 400, out);
    // Close the residue loophole: a removed member's PERSONAL connectors (their own credentials) must
    // not outlive the account. Sessions, invites and assignment grants were cleared in removeMember.
    const connectorsRemoved = os.connectors.removeByOwner(teamMember[1]).length;
    const hostsRemoved = os.hosts.removeByOwner(teamMember[1]).length;
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'member.removed', data: { member: teamMember[1], connectorsRemoved, hostsRemoved } });
    return sendJson(res, 200, { ...out, connectorsRemoved, hostsRemoved });
  }
  const teamAssign = p.match(/^\/api\/team\/assignments\/([\w.-]+)$/);
  if (method === 'PUT' && teamAssign) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const allowedRoles = (Array.isArray(b.allowedRoles) ? b.allowedRoles : []).map(roleOf).filter(Boolean) as Role[];
    const allowedMembers = (Array.isArray(b.allowedMembers) ? b.allowedMembers : []).map(String);
    os.team.setAssignment(teamAssign[1], { allowedRoles, allowedMembers });
    return sendJson(res, 200, { ok: true, assignment: os.team.getAssignment(teamAssign[1]) });
  }

  // ── automations (cron / webhook → spawn agent sessions) ──────────────────────
  if (method === 'GET' && p === '/api/automations') {
    return sendJson(res, 200, { automations: autos.list().map((a) => automationView(a, req, isAdmin(me), canManageAuto(me, a))) });
  }
  if (method === 'POST' && p === '/api/automations') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    try {
      const type = b.type === 'webhook' ? 'webhook' : b.type === 'composio' ? 'composio' : b.type === 'slack' ? 'slack' : b.type === 'discord' ? 'discord' : 'cron';
      // Optional "Run as": the fired session acts as this member so its connectors/Composio (e.g. their
      // personal ClickUp) are injected. Validate it's a real member; '' clears it (company identity).
      const runAs = b.runAs ? String(b.runAs) : '';
      if (runAs && !os.team.getMember(runAs)) return sendJson(res, 400, { error: 'unknown run-as member' });
      const created = autos.add({
        agentId: String(b.agentId || ''),
        name: String(b.name || ''),
        type,
        mode: b.mode === 'headless' ? 'headless' : b.mode === 'interactive' ? 'interactive' : undefined,
        schedule: b.schedule ? String(b.schedule) : undefined,
        filter: b.filter !== undefined ? String(b.filter) : undefined,
        task: String(b.task || ''),
        createdBy: me.id,
        runAs: runAs || undefined,
      });
      return sendJson(res, 200, automationView(created, req, true));
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const autoRun = p.match(/^\/api\/automations\/([\w-]+)\/run$/);
  if (method === 'POST' && autoRun) {
    const a = autos.get(autoRun[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!os.team.canRun(me, a.agentId)) return sendJson(res, 403, { error: `you are not assigned to run "${a.agentId}"` });
    // Optional one-off mode override: the "Run now" dialog lets the human pick headless (fire-and-forget)
    // or interactive (watch/steer live) for THIS run without changing the automation's saved default.
    const b = await readBody(req);
    const mode = b.mode === 'headless' ? 'headless' : b.mode === 'interactive' ? 'interactive' : undefined;
    const r = autos.fire(a, { guard: false, mode }); // explicit human action — no pile-up guard
    return sendJson(res, 200, r);
  }
  const autoRuns = p.match(/^\/api\/automations\/([\w-]+)\/runs$/);
  if (method === 'GET' && autoRuns) {
    const a = autos.get(autoRuns[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    // Runs = every session this automation spawned (provenance `automation:<id>`). Visibility follows
    // the same rule as /api/sessions — the caller sees only what they're allowed to.
    return sendJson(res, 200, { runs: tm.listRunsFor(`automation:${a.id}`, me) });
  }
  const autoMatch = p.match(/^\/api\/automations\/([\w-]+)$/);
  if (autoMatch && (method === 'PATCH' || method === 'DELETE')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    // Ownership guard: admins/members may only delete or edit automations THEY created; the owner keeps
    // a break-glass override for anyone's (incl. legacy automations with no recorded creator). Prevents
    // one teammate clobbering another's automation. `createdBy` is a member id (or `agent:`/`automation`
    // for machine-created ones — those are owner-only to manage).
    const existing = autos.get(autoMatch[1]);
    if (existing && !canManageAuto(me, existing)) {
      return sendJson(res, 403, { error: 'you can only delete or edit automations you created' });
    }
    if (method === 'DELETE') {
      const ok = autos.remove(autoMatch[1]);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    const b = await readBody(req);
    // "Run as" edit: undefined leaves it, a member id sets it (validated), '' clears it to company identity.
    let runAs: string | null | undefined;
    if (b.runAs !== undefined) {
      const id = String(b.runAs || '');
      if (id && !os.team.getMember(id)) return sendJson(res, 400, { error: 'unknown run-as member' });
      runAs = id || null;
    }
    try {
      const updated = autos.update(autoMatch[1], {
        name: b.name !== undefined ? String(b.name) : undefined,
        mode: b.mode === 'headless' ? 'headless' : b.mode === 'interactive' ? 'interactive' : undefined,
        schedule: b.schedule !== undefined ? String(b.schedule) : undefined,
        filter: b.filter !== undefined ? String(b.filter) : undefined,
        task: b.task !== undefined ? String(b.task) : undefined,
        enabled: b.enabled !== undefined ? !!b.enabled : undefined,
        runAs,
      });
      return sendJson(res, updated ? 200 : 404, updated ? automationView(updated, req, true) : { error: 'not found' });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── terminal-native sessions ────────────────────────────────────────────────
  if (method === 'GET' && p === '/api/sessions') return sendJson(res, 200, tm.listSessions(me));
  if (method === 'POST' && p === '/api/sessions') {
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    const task = String(b.task || '').trim();
    if (!agent || !task) return sendJson(res, 400, { error: 'agent and task are required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to run "${agent}"` });
    const s = tm.createSession(agent, String(b.title || task), task, me.id);
    return sendJson(res, 200, { id: s.id, tmux: s.tmux });
  }
  // ─── Native chat surface (non-technical) — a plain-language window onto a claude-code run, an
  //     alternative to the ttyd terminal. Governance is UNCHANGED: the gate hook + approvals still
  //     mediate every effect; this only reads the transcript and drives replies via the same
  //     resident deliver/revive path Slack thread-continuity uses.
  //
  // Start a chat: spawn a RESIDENT interactive session (kept warm for fast follow-ups, like Slack chat).
  if (method === 'POST' && p === '/api/chat/start') {
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    const message = String(b.message || '').trim();
    if (!agent || !message) return sendJson(res, 400, { error: 'agent and message are required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to run "${agent}"` });
    // Provenance chat:me, runAs=me (accountable human). HEADLESS one-shot (not resident): the greeting
    // turn runs then tears itself down, so every subsequent turn is a clean headless resume (chatSend) —
    // no warm pane to race/reap, and `alive` stays honest. See TerminalManager.chatSend.
    const s = tm.createSession(agent, chatTitle(message, agent), message, `chat:${me.id}`, true, undefined, undefined, me.id, undefined, false);
    return sendJson(res, 200, { id: s.id, tmux: s.tmux });
  }
  // Read the friendly conversation timeline for a session (poll this like the rest of the console).
  const convoMatch = p.match(/^\/api\/sessions\/([\w-]+)\/conversation$/);
  if (method === 'GET' && convoMatch) {
    const id = convoMatch[1];
    const agent = tm.sessionAgent(id);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to view this session' });
    const claudeId = tm.sessionClaudeId(id);
    const convo = claudeId ? readConversation(claudeId) : { turns: [], found: false };
    // Resolve the deliverables an activity produced (a Library artifact, a KB page, a hosted app) into
    // viewer-safe preview cards the chat UI renders inline — dropping anything the viewer may not see or
    // that no longer exists. The viewer already passed canViewSession, so their own run's outputs resolve;
    // KB pages and apps are tenant-wide surfaces every member can already browse.
    for (const t of convo.turns) {
      if (t.kind !== 'activity') continue;
      if (t.artifactIds?.length) {
        const refs: ChatArtifactRef[] = [];
        for (const aid of t.artifactIds) {
          const a = os.artifacts.get(aid);
          if (!a) continue;
          if (!tm.canViewSpawn(a.source ?? null, me) && !a.sharedTeam) continue;
          refs.push({
            id: a.id,
            title: a.title || a.filename,
            kind: a.kind,
            mime: a.mime,
            filename: a.filename,
            isImage: a.mime.startsWith('image/'),
            isVideo: a.mime.startsWith('video/'),
            raw: `/api/artifacts/${a.id}/raw`,
          });
        }
        if (refs.length) t.artifacts = refs;
      }
      if (t.kbRefs?.length) {
        const refs: ChatKbRef[] = [];
        for (const r of t.kbRefs) {
          const page = os.kb.read(os.tenant, r.section, r.slug);
          if (page) refs.push({ section: page.section, slug: page.slug, title: page.title });
        }
        if (refs.length) t.kbPages = refs;
      }
      if (t.appIds?.length) {
        const refs: ChatAppRef[] = [];
        for (const aid of t.appIds) {
          const app = os.apps.get(aid);
          if (app) refs.push({ id: app.id, name: app.name, icon: app.icon, published: !!app.published });
        }
        if (refs.length) t.apps = refs;
      }
    }
    return sendJson(res, 200, { agent, ...convo });
  }
  // Reply into a chat session (the human's next turn) as a clean, self-terminating headless resume run
  // seeded with the message. `busy` (409) means the prior turn is still generating — the caller keeps the
  // draft and asks the human to resend shortly. The replier is the accountable run-as for this turn.
  const chatReplyMatch = p.match(/^\/api\/sessions\/([\w-]+)\/reply$/);
  if (method === 'POST' && chatReplyMatch) {
    const id = chatReplyMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to reply to this session' });
    const b = await readBody(req);
    const message = String(b.message || '').trim();
    if (!message) return sendJson(res, 400, { error: 'message is required' });
    const r = tm.chatSend(id, message, me.id);
    if (r === 'busy') return sendJson(res, 409, { status: 'busy', error: 'the agent is still working on the previous message — resend in a moment' });
    if (r === 'error') return sendJson(res, 409, { error: 'this session could not accept the message' });
    return sendJson(res, 200, { status: 'sent' });
  }
  // Take a chat session over into the Terminal: make it a live, attachable interactive TUI (claim the
  // live pane, or resurrect an idle chat as an interactive resident resume). The client then opens the
  // terminal on aos-<id>.
  const takeoverMatch = p.match(/^\/api\/sessions\/([\w-]+)\/takeover-terminal$/);
  if (method === 'POST' && takeoverMatch) {
    const id = takeoverMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to take over this session' });
    const out = tm.takeoverToTerminal(id, me.email);
    return sendJson(res, out.ok ? 200 : 409, out);
  }
  // Session activity: "which agent-os primitives did this run use?" — the session's audit stream,
  // classified into a chronological timeline + a grouped count summary. Same visibility as the terminal
  // (canViewSession), so a member sees the activity of the runs they can attach to, not just admins.
  const activityMatch = p.match(/^\/api\/sessions\/([\w-]+)\/activity$/);
  if (method === 'GET' && activityMatch) {
    const id = activityMatch[1];
    const agent = tm.sessionAgent(id);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to view this session' });
    const rows = os.db
      .prepare('SELECT ts, type, data FROM audit_events WHERE tenant = ? AND run_id = ? ORDER BY ts ASC, id ASC')
      .all<{ ts: number; type: string; data: string }>(os.tenant, id);
    type StatusTone = 'open' | 'done' | 'blocked' | 'denied' | 'muted';
    type Row = { ts: number; category: ActivityCategory; primitive: string; summary: string; effect?: ActivityEffect; target?: ActivityTarget; status?: string; statusTone?: StatusTone };
    const events: Row[] = [];
    for (const r of rows) {
      const d = classifyActivity(r.type, safeJson(r.data));
      if (d) events.push({ ts: r.ts, ...d });
    }
    // Progress `update`s are the one primitive not audited (they only write an inbox message) — fold
    // them in so the timeline is complete.
    const ups = os.db
      .prepare("SELECT created_at AS ts, body FROM messages WHERE session_id = ? AND type = 'update' ORDER BY created_at ASC")
      .all<{ ts: number; body: string }>(id);
    for (const u of ups) events.push({ ts: u.ts, category: 'operator', primitive: 'update', summary: clipText(u.body) });
    events.sort((a, b) => a.ts - b.ts);

    // Attach each object-bearing entry's CURRENT status — audit is point-in-time ("task created"), so
    // this is what turns the trail into "what is it doing/done" (a task's todo→done, a proposal's
    // pending→approved). Resolved from the live stores; cached per target so a task touched by several
    // events is queried once.
    const statusCache = new Map<string, { status: string; tone: StatusTone } | null>();
    const msgTone = (s: string): { status: string; tone: StatusTone } =>
      s === 'approved' ? { status: 'approved', tone: 'done' }
      : s === 'rejected' ? { status: 'rejected', tone: 'denied' }
      : s === 'resolved' ? { status: 'resolved', tone: 'muted' }
      : { status: 'pending', tone: 'open' };
    // Proposal cards (secret-request / skill / policy) are `messages` rows that carry their own live
    // status — load this session's once, indexed by the discriminator the classifier stored as target.id.
    const skillProp = new Map<string, string>(); // skill name → status
    const secretReq = new Map<string, string>(); // secret key → status
    const policyProp: Array<{ cap: string; status: string }> = []; // capability → status (in order)
    for (const m of os.db
      .prepare("SELECT type, status, args FROM messages WHERE session_id = ? AND type IN ('secret.request','skill.proposed','policy.proposal')")
      .all<{ type: string; status: string; args: string | null }>(id)) {
      const a = safeJson(m.args ?? '') as Record<string, unknown>;
      if (m.type === 'skill.proposed' && typeof a.skill === 'string') skillProp.set(a.skill, m.status);
      else if (m.type === 'secret.request' && typeof a.key === 'string') secretReq.set(a.key, m.status);
      else if (m.type === 'policy.proposal') {
        const cap = (a.delta as { match?: { capability?: unknown } } | undefined)?.match?.capability;
        if (typeof cap === 'string') policyProp.push({ cap, status: m.status });
      }
    }
    const resolveStatus = (t: ActivityTarget): { status: string; tone: StatusTone } | null => {
      const ck = `${t.kind}:${t.id}`;
      const cached = statusCache.get(ck);
      if (cached !== undefined) return cached;
      let out: { status: string; tone: StatusTone } | null = null;
      if (t.kind === 'task') {
        const row = os.db.prepare('SELECT status FROM tasks WHERE tenant = ? AND id = ?').get<{ status: string }>(os.tenant, t.id);
        out = !row ? { status: 'deleted', tone: 'muted' }
          : { status: row.status, tone: row.status === 'done' ? 'done' : row.status === 'blocked' || row.status === 'cancelled' ? 'blocked' : 'open' };
      } else if (t.kind === 'kb') {
        const slash = t.id.indexOf('/');
        const section = slash >= 0 ? t.id.slice(0, slash) : t.id, slug = slash >= 0 ? t.id.slice(slash + 1) : '';
        const row = os.db.prepare('SELECT rev FROM kb_pages WHERE tenant = ? AND section = ? AND slug = ?').get<{ rev: number }>(os.tenant, section, slug);
        out = row ? { status: `rev ${row.rev}`, tone: 'muted' } : { status: 'deleted', tone: 'muted' };
      } else if (t.kind === 'approval') {
        const row = os.db.prepare('SELECT status FROM approvals WHERE tenant = ? AND id = ?').get<{ status: string }>(os.tenant, t.id);
        if (row) out = row.status === 'approved' ? { status: 'approved', tone: 'done' } : row.status === 'rejected' ? { status: 'rejected', tone: 'denied' } : { status: 'pending', tone: 'open' };
      } else if (t.kind === 'secret') {
        const row = os.db.prepare('SELECT 1 AS ok FROM secrets WHERE tenant = ? AND key = ? LIMIT 1').get<{ ok: number }>(os.tenant, t.id);
        out = row ? { status: 'stored', tone: 'muted' } : { status: 'removed', tone: 'muted' };
      } else if (t.kind === 'secret-request') {
        const s = secretReq.get(t.id); out = s ? msgTone(s) : null;
      } else if (t.kind === 'skill-proposal') {
        const s = skillProp.get(t.id); out = s ? msgTone(s) : null;
      } else if (t.kind === 'policy-proposal') {
        const s = policyProp.find((p) => p.cap === t.id)?.status; out = s ? msgTone(s) : null;
      }
      statusCache.set(ck, out);
      return out;
    };
    for (const e of events) {
      if (!e.target || !e.target.id) continue; // no id to locate the object → nothing to resolve (not "deleted")
      const r = resolveStatus(e.target);
      if (r) { e.status = r.status; e.statusTone = r.tone; }
    }
    // Grouped count summary (primitive → how many times), most-used first.
    const byPrim = new Map<string, { primitive: string; category: ActivityCategory; count: number }>();
    for (const e of events) {
      const cur = byPrim.get(e.primitive) ?? { primitive: e.primitive, category: e.category, count: 0 };
      cur.count += 1;
      byPrim.set(e.primitive, cur);
    }
    const summary = [...byPrim.values()].sort((a, b) => b.count - a.count || a.primitive.localeCompare(b.primitive));
    return sendJson(res, 200, { events, summary, total: events.length });
  }
  // A finished headless run has no live tmux to attach to, but claude-launch.sh tee'd its full `-p`
  // transcript to <home>/connectors/session-<id>.log. Serve that (same authz as attach) so the console
  // can show what the run did instead of a dead terminal. Tail the last 512KB of a long run.
  const transcriptMatch = p.match(/^\/api\/sessions\/([\w-]+)\/transcript$/);
  if (method === 'GET' && transcriptMatch) {
    const id = transcriptMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to view this session' });
    if (!os.paths) return sendJson(res, 404, { error: 'no transcript' });
    const file = path.join(os.paths.connectors, `session-${id}.log`);
    try {
      const buf = fs.readFileSync(file);
      const CAP = 512 * 1024;
      const text = buf.length > CAP ? '…(earlier output truncated)\n' + buf.subarray(buf.length - CAP).toString('utf8') : buf.toString('utf8');
      return sendJson(res, 200, { text });
    } catch {
      return sendJson(res, 404, { error: 'no transcript' });
    }
  }
  // Prepare a browser attach: authz, then (under the flag) ensure the member's ttyd is up. Returns
  // the iframe URL — the shared /terminal/?arg=… (flag off) or per-member /terminal/<space>/?arg=… (on).
  const attachMatch = p.match(/^\/api\/sessions\/([\w-]+)\/attach$/);
  if (method === 'GET' && attachMatch) {
    const id = attachMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to attach to this session' });
    try {
      const attachUrl = await tm.attachUrl(id);
      return sendJson(res, attachUrl ? 200 : 404, attachUrl ? { url: attachUrl } : { error: 'unknown session' });
    } catch (e) {
      return sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const sayMatch = p.match(/^\/api\/sessions\/([\w-]+)\/say$/);
  if (method === 'POST' && sayMatch) {
    const b = await readBody(req);
    tm.say(sayMatch[1], String(b.body || ''));
    return sendJson(res, 200, { ok: true });
  }
  // Operator pasted/dropped/picked a file (ANY type) onto the open terminal: save it into the session's
  // working folder and type its path into the running claude. Body: { dataB64, ext, name? }. Capped to
  // keep a stray huge paste from buffering unbounded (readBody has no limit of its own).
  const attachFileMatch = p.match(/^\/api\/sessions\/([\w-]+)\/attach-file$/);
  if (method === 'POST' && attachFileMatch) {
    const id = attachFileMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to attach to this session' });
    if (Number(req.headers['content-length'] || 0) > 16 * 1024 * 1024) return sendJson(res, 413, { error: 'attachment too large (max ~12MB)' });
    const b = await readBody(req);
    const dataB64 = String(b.dataB64 || '');
    if (!dataB64) return sendJson(res, 400, { error: 'dataB64 is required' });
    const data = Buffer.from(dataB64, 'base64');
    if (!data.length) return sendJson(res, 400, { error: 'empty or invalid attachment' });
    const r = tm.attachFile(id, me.email, data, String(b.ext || 'bin'), b.name ? String(b.name) : undefined);
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  // Quick Shortcuts — type text into a LIVE session's pane as if the attached human typed it (e.g.
  // "Check now", a saved prompt). Same trust as attaching + typing, so the gate at canViewSession, not a
  // policy check; every effect the resulting turn triggers is still mediated by the gate hook. Body:
  // { text, submit? } (submit defaults true — the shortcut runs immediately).
  const injectMatch = p.match(/^\/api\/sessions\/([\w-]+)\/inject$/);
  if (method === 'POST' && injectMatch) {
    const id = injectMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to send to this session' });
    const b = await readBody(req);
    const text = String(b.text || '');
    if (!text.trim()) return sendJson(res, 400, { error: 'text is required' });
    const submit = b.submit === undefined ? true : Boolean(b.submit);
    const r = tm.injectToSession(id, text, submit, me.email);
    return sendJson(res, r.ok ? 200 : 409, r);
  }
  // Out-of-band session summary — reads the run's existing transcript and summarizes it in a THROWAWAY
  // claude, so the target session's own context is never touched (no pollution). Same visibility gate as
  // the terminal/transcript. Returns { summary, via, found }; never blocks the session.
  const summarizeMatch = p.match(/^\/api\/sessions\/([\w-]+)\/summarize$/);
  if (method === 'POST' && summarizeMatch) {
    const id = summarizeMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to view this session' });
    const claudeId = tm.sessionClaudeId(id);
    const convo = claudeId ? readConversation(claudeId) : { turns: [], found: false };
    const out = await summarizeConversation(convo);
    os.audit.append({ ts: Date.now(), runId: id, tenant: os.tenant, principal: me.email, type: 'session.summarized', data: { via: out.via, found: out.found } });
    return sendJson(res, 200, out);
  }
  // Stop a running session (kill its tmux, keep the row). Per-member: only the session's owner, or
  // an owner/admin — agents are shared, so canRun would let a peer stop another member's session.
  const stopMatch = p.match(/^\/api\/sessions\/([\w-]+)\/stop$/);
  if (method === 'POST' && stopMatch) {
    const id = stopMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    return sendJson(res, 200, { ok: tm.stopSession(id, me.email) });
  }
  // Take over an unattended run: CLAIM its live TUI so the caller can attach and steer — no kill, no
  // resume, nothing interrupted (the run is already an attachable interactive session). Marks it sticky so
  // it isn't auto-closed at turn-end. The frontend opens ttyd right after. Same per-member gate as stop.
  const interactiveMatch = p.match(/^\/api\/sessions\/([\w-]+)\/interactive$/);
  if (method === 'POST' && interactiveMatch) {
    const id = interactiveMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    const r = tm.claimSession(id, me.email);
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  // Fork a session: branch it into a NEW independent session that inherits the parent's full conversation
  // (claude --resume <parent> --fork-session), leaving the parent untouched. Optionally seeded with a
  // follow-up task. Same per-member gate as stop/take-over — you can fork any run you're allowed to see.
  const forkMatch = p.match(/^\/api\/sessions\/([\w-]+)\/fork$/);
  if (method === 'POST' && forkMatch) {
    const id = forkMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to fork this session' });
    const b = await readBody(req);
    const r = tm.forkSession(id, me.id, b.task ? String(b.task) : undefined);
    return sendJson(res, r.ok ? 200 : 400, r.ok ? { id: r.session!.id, tmux: r.session!.tmux } : { error: r.error });
  }
  // Human verdict on a finished run — 👍/👎 (or null to clear). The ground-truth signal for the agent
  // maturity score. Same per-member gate as stop: you can rate any run you're allowed to see.
  const rateMatch = p.match(/^\/api\/sessions\/([\w-]+)\/rate$/);
  if (method === 'POST' && rateMatch) {
    const id = rateMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    const b = await readBody(req);
    const rating = b.rating;
    if (rating !== 'up' && rating !== 'down' && rating !== null) return sendJson(res, 400, { error: "rating must be 'up', 'down', or null" });
    return sendJson(res, 200, tm.rateSession(id, me, rating));
  }
  // Rename a session — give it a human-chosen display title. Same per-member gate as rate/stop: you can
  // rename any run you're allowed to see.
  const renameMatch = p.match(/^\/api\/sessions\/([\w-]+)\/rename$/);
  if (method === 'POST' && renameMatch) {
    const id = renameMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    const b = await readBody(req);
    const r = tm.renameSession(id, me, String((b as { title?: unknown }).title ?? ''));
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  // Transfer a session to another owner — reassign its run-as (the accountable human). Beyond the view
  // gate, this changes accountability, so restrict it to an owner/admin OR the session's current owner
  // (a member handing off their own run). The target is any real member; the tm method validates it.
  const transferMatch = p.match(/^\/api\/sessions\/([\w-]+)\/transfer$/);
  if (method === 'POST' && transferMatch) {
    const id = transferMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    if (!isAdmin(me) && tm.sessionRunAs(id) !== me.id) return sendJson(res, 403, { error: 'only an owner/admin or the current owner can transfer this session' });
    const b = await readBody(req);
    const to = String((b as { to?: unknown }).to ?? '').trim();
    if (!to) return sendJson(res, 400, { error: 'to (member id) is required' });
    const r = tm.transferSession(id, me, to);
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  // Deliberately resume a stopped session: lift the stop-block so the ttyd attach wrapper resurrects it
  // (`claude --resume`) on the next reconnect. The actual relaunch happens in attach.sh when the terminal
  // (re)connects; this just clears the "stay stopped" sentinel. Same per-member gate as stop.
  const resumeMatch = p.match(/^\/api\/sessions\/([\w-]+)\/resume$/);
  if (method === 'POST' && resumeMatch) {
    const id = resumeMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    tm.allowResume(id);
    return sendJson(res, 200, { ok: true });
  }
  // Reload a session: restart its agent process in place (kill the pane, keep the transcript) so a
  // newly-connected MCP server is picked up — MCP servers spawn at claude launch, so a running session
  // can't see one added mid-run. The frontend remounts the terminal right after, and attach.sh
  // resurrects via `claude --resume <same id>`. Same per-member gate as stop/resume.
  const reloadMatch = p.match(/^\/api\/sessions\/([\w-]+)\/reload$/);
  if (method === 'POST' && reloadMatch) {
    const id = reloadMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    const r = tm.reloadSession(id, me.email);
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  // Permanently delete a session (kill tmux + cascade messages/questions/files) — same gate.
  const sessMatch = p.match(/^\/api\/sessions\/([\w-]+)$/);
  if (method === 'DELETE' && sessMatch) {
    const id = sessMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    return sendJson(res, 200, { ok: tm.deleteSession(id, me.email) });
  }

  // Inbox feed. `scope=all` is the oversight view (owner/admin only — resolved server-side); the
  // default `mine` narrows to cards addressed to the viewer so owner/admin aren't flooded.
  if (method === 'GET' && p === '/api/messages') return sendJson(res, 200, tm.listMessages(me, inboxScope(url, me)));

  // This member's own notification preferences (which session events ping them, toasts/sound/DM). Per
  // person, not workspace-wide — every role reads/writes their OWN, so it's not admin-gated.
  if (method === 'GET' && p === '/api/me/prefs') return sendJson(res, 200, os.team.notificationPrefs(me.id));
  if (method === 'PUT' && p === '/api/me/prefs') {
    const b = await readBody(req);
    return sendJson(res, 200, os.team.setNotificationPrefs(me.id, b));
  }
  // This member's personal context — free-text they inject into every session that runs AS them
  // (buildCompanyMd reads it at launch). Per person, self-service, not admin-gated. Edited on Profile.
  if (method === 'GET' && p === '/api/me/context') return sendJson(res, 200, { context: os.team.memberContext(me.id) });
  if (method === 'PUT' && p === '/api/me/context') {
    const b = await readBody(req);
    const context = os.team.setMemberContext(me.id, (b as { context?: unknown }).context);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'member.context.set', data: { chars: context.length } });
    return sendJson(res, 200, { context });
  }
  // This member's Quick Shortcuts — saved canned prompts they fire into a live terminal session with one
  // click. Personal, self-service (no role gate); the payload is `{ shortcuts: PromptShortcut[] }`.
  if (method === 'GET' && p === '/api/me/shortcuts') return sendJson(res, 200, { shortcuts: os.team.promptShortcuts(me.id) });
  if (method === 'PUT' && p === '/api/me/shortcuts') {
    const b = await readBody(req);
    return sendJson(res, 200, { shortcuts: os.team.setPromptShortcuts(me.id, (b as { shortcuts?: unknown }).shortcuts) });
  }
  // This member's pinned sidebar nav (which secondary items sit up in Main). Per person, not admin-gated
  // — everyone customizes their own. The initial value ships on /api/auth/me; this saves changes.
  if (method === 'PUT' && p === '/api/me/nav') {
    const b = await readBody(req);
    return sendJson(res, 200, { pinned: os.team.setNavPins(me.id, (b as { pinned?: unknown }).pinned) });
  }

  // Dismiss the whole Activity feed at once (soft hide). Leaves action-required items (pending
  // approvals/questions, waiting notifications) in place. Same per-viewer visibility as the feed.
  if (method === 'POST' && p === '/api/messages/dismiss-all') {
    return sendJson(res, 200, { ok: true, dismissed: tm.dismissAllMessages(me, inboxScope(url, me)) });
  }

  // Mark every message the viewer can see as read (per-member) — clears the unread badge.
  if (method === 'POST' && p === '/api/messages/read-all') {
    return sendJson(res, 200, { ok: true, read: tm.markAllRead(me, inboxScope(url, me)) });
  }

  // Mark one message read for this member (per-member state; the shared feed is unaffected for others).
  const readMatch = p.match(/^\/api\/messages\/([\w-]+)\/read$/);
  if (method === 'POST' && readMatch) {
    const ok = tm.markRead(readMatch[1], me);
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'unknown message' });
  }

  // Dismiss a message from the inbox (soft hide; the row is kept for audit). Same visibility rule as
  // the feed; a pending approval/question can't be dismissed (resolve/answer it instead).
  const dismissMatch = p.match(/^\/api\/messages\/([\w-]+)\/dismiss$/);
  if (method === 'POST' && dismissMatch) {
    const r = tm.dismissMessage(dismissMatch[1], me);
    if (r === 'not_found') return sendJson(res, 404, { error: 'unknown message' });
    if (r === 'forbidden') return sendJson(res, 403, { error: 'not allowed to dismiss this message' });
    if (r === 'pending') return sendJson(res, 409, { error: 'resolve or answer this item before dismissing it' });
    return sendJson(res, 200, { ok: true });
  }

  // answer a pending agent question from the inbox. Same visibility rule as the inbox itself:
  // owner/admin or the member who owns the session (so you can't answer a question you can't see).
  const answerMatch = p.match(/^\/api\/questions\/([\w-]+)$/);
  if (method === 'POST' && answerMatch) {
    const b = await readBody(req);
    const answer = String(b.answer ?? '').trim();
    if (!answer) return sendJson(res, 400, { error: 'answer is required' });
    if (!tm.canViewQuestion(answerMatch[1], me)) return sendJson(res, 403, { error: 'not allowed to answer this question' });
    const ok = tm.answerQuestion(answerMatch[1], answer, me.email);
    return sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'already answered or not found' });
  }

  // Dismiss a pending question without answering it (the inbox "dismiss" on a question card). Cancels
  // the question — it leaves "Needs you" and a still-live agent's blocking `ask` unblocks. Same
  // visibility gate as answering.
  const cancelQMatch = p.match(/^\/api\/questions\/([\w-]+)\/cancel$/);
  if (method === 'POST' && cancelQMatch) {
    if (!tm.canViewQuestion(cancelQMatch[1], me)) return sendJson(res, 403, { error: 'not allowed to dismiss this question' });
    const ok = tm.cancelQuestion(cancelQMatch[1], me.email);
    return sendJson(res, ok ? 200 : 409, ok ? { ok: true } : { error: 'already resolved or not found' });
  }

  // ── memory (console: browse / curate an agent's persistent memory) ───────────
  if (method === 'GET' && p === '/api/memory/health') return sendJson(res, 200, await os.memory.health());
  // The learning-system Overview: pipeline counts + a recent learning-activity feed. Owner/admin —
  // it spans the whole fleet (all agents), like the audit/dreaming surfaces.
  if (method === 'GET' && p === '/api/memory/overview') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const one = (sql: string, ...args: unknown[]) => Number(os.db.prepare(sql).get<{ n: number }>(...args)?.n ?? 0);
    const counts = {
      memories: one('SELECT count(*) AS n FROM memories WHERE tenant = ?', os.tenant),
      episodes: one("SELECT count(*) AS n FROM memories WHERE tenant = ? AND tags LIKE '%\"episode\"%'", os.tenant),
      lessons: one("SELECT count(*) AS n FROM memories WHERE tenant = ? AND tags LIKE '%\"lesson\"%'", os.tenant),
      shared: one("SELECT count(*) AS n FROM memories WHERE tenant = ? AND scope = 'tenant'", os.tenant),
      kbPages: one('SELECT count(*) AS n FROM kb_pages WHERE tenant = ?', os.tenant),
    };
    const rows = os.db
      .prepare(
        "SELECT ts, run_id, type, principal, data FROM audit_events WHERE tenant = ? " +
          "AND type IN ('episode.stored','lesson.stored','learning.dreamed','learning.consolidated') " +
          'ORDER BY ts DESC, id DESC LIMIT 30',
      )
      .all<{ ts: number; run_id: string; type: string; principal: string | null; data: string }>(os.tenant);
    const activity = rows.map((r) => ({ ts: r.ts, runId: r.run_id, type: r.type, principal: r.principal ?? undefined, data: safeJson(r.data) }));
    return sendJson(res, 200, { counts, activity });
  }
  if (method === 'GET' && p === '/api/memory') {
    const agent = url.searchParams.get('agent') || '';
    if (!agent) return sendJson(res, 400, { error: 'agent is required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to "${agent}"` });
    const limit = Number(url.searchParams.get('limit')) || 20;
    const sp = url.searchParams.get('scope');
    const scope = sp === 'agent' || sp === 'tenant' ? sp : 'all'; // filter: This agent / Shared / All
    const memories = await os.memory.recall({ tenant: os.tenant, agentId: agent, query: url.searchParams.get('q') || '', limit, scope });
    return sendJson(res, 200, { memories });
  }
  if (method === 'POST' && p === '/api/memory') {
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    if (!agent || !b.content) return sendJson(res, 400, { error: 'agent and content are required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to "${agent}"` });
    const rec = await os.memory.store({
      tenant: os.tenant,
      agentId: agent,
      content: String(b.content),
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      type: typeof b.type === 'string' ? (b.type as MemoryType) : undefined,
      importance: typeof b.importance === 'number' ? b.importance : undefined,
      scope: b.shared === true || b.scope === 'tenant' ? 'tenant' : 'agent',
    });
    return sendJson(res, 200, { ok: true, id: rec.id, scope: rec.scope });
  }
  const memId = p.match(/^\/api\/memory\/([\w-]+)$/);
  if (memId && method === 'PATCH') {
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    if (!agent) return sendJson(res, 400, { error: 'agent is required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to "${agent}"` });
    // owner/admin curate ANY memory (incl. another agent's shared); members only their assigned agent's own.
    const rec = await os.memory.update({
      tenant: os.tenant,
      agentId: agent,
      id: memId[1],
      content: b.content !== undefined ? String(b.content) : undefined,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      type: typeof b.type === 'string' ? (b.type as MemoryType) : undefined,
      importance: typeof b.importance === 'number' ? b.importance : undefined,
      admin: isAdmin(me),
    });
    return sendJson(res, rec ? 200 : 404, rec ? { ok: true, memory: rec } : { error: 'memory not found' });
  }
  if (memId && method === 'DELETE') {
    const agent = url.searchParams.get('agent') || '';
    if (!agent) return sendJson(res, 400, { error: 'agent is required' });
    if (!os.team.canRun(me, agent)) return sendJson(res, 403, { error: `you are not assigned to "${agent}"` });
    const ok = await os.memory.delete({ tenant: os.tenant, agentId: agent, id: memId[1], admin: isAdmin(me) });
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ── knowledge base, console (the shared company wiki — readable by any member; writes audited) ──
  if (method === 'GET' && p === '/api/kb') {
    const pages = os.kb.search({ tenant: os.tenant, query: url.searchParams.get('q') || '', section: url.searchParams.get('section') || undefined, limit: 200 });
    return sendJson(res, 200, { pages, sections: os.kb.sections(os.tenant), enabled: os.kb.enabled });
  }
  const kbId = p.match(/^\/api\/kb\/page\/([\w-]+)$/);
  const kbHist = p.match(/^\/api\/kb\/page\/([\w-]+)\/history$/);
  const kbRevert = p.match(/^\/api\/kb\/page\/([\w-]+)\/revert$/);
  if (kbId && method === 'GET') {
    const page = os.kb.get(kbId[1]);
    return sendJson(res, page ? 200 : 404, page ? { page } : { error: 'page not found' });
  }
  if (kbHist && method === 'GET') {
    return sendJson(res, 200, { revisions: os.kb.history(kbHist[1]) });
  }
  if (method === 'POST' && p === '/api/kb/page') {
    const b = await readBody(req);
    if (!b.section || !b.slug || b.body === undefined) return sendJson(res, 400, { error: 'section, slug and body are required' });
    try {
      const page = os.kb.write({ tenant: os.tenant, section: String(b.section), slug: String(b.slug), title: typeof b.title === 'string' ? b.title : undefined, body: String(b.body), tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined, summary: typeof b.summary === 'string' ? b.summary : undefined, author: me.id });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'kb.written', data: { id: page.id, section: page.section, slug: page.slug, rev: page.rev } });
      return sendJson(res, 200, { ok: true, page });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (kbId && method === 'PATCH') {
    const b = await readBody(req);
    const cur = os.kb.get(kbId[1]);
    if (!cur) return sendJson(res, 404, { error: 'page not found' });
    const page = os.kb.write({ tenant: os.tenant, section: cur.section, slug: cur.slug, title: typeof b.title === 'string' ? b.title : cur.title, body: b.body !== undefined ? String(b.body) : cur.body, tags: Array.isArray(b.tags) ? b.tags.map(String) : cur.tags, summary: typeof b.summary === 'string' ? b.summary : undefined, author: me.id });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'kb.written', data: { id: page.id, rev: page.rev } });
    return sendJson(res, 200, { ok: true, page });
  }
  if (kbRevert && method === 'POST') {
    const b = await readBody(req);
    const page = os.kb.revert(kbRevert[1], Number(b.rev), me.id);
    if (!page) return sendJson(res, 404, { error: 'page or revision not found' });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'kb.reverted', data: { id: page.id, toRev: Number(b.rev), rev: page.rev } });
    return sendJson(res, 200, { ok: true, page });
  }
  if (kbId && method === 'DELETE') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ok = os.kb.remove(kbId[1]);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'kb.deleted', data: { id: kbId[1] } });
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ── Tasks (member console) ───────────────────────────────────────────────────
  // Tenant-wide board: reads open to any member (like KB); writes/claims open to any member; dispatch
  // follows canRun on the assignee agent (spawning a session is a run); delete is owner/admin.
  const taskId = p.match(/^\/api\/tasks\/([\w-]+)$/);
  const taskComment = p.match(/^\/api\/tasks\/([\w-]+)\/comment$/);
  const taskDispatch = p.match(/^\/api\/tasks\/([\w-]+)\/dispatch$/);
  const taskAttachments = p.match(/^\/api\/tasks\/([\w-]+)\/attachments$/);
  const taskAttachmentRaw = p.match(/^\/api\/tasks\/[\w-]+\/attachments\/([\w-]+)\/raw$/);
  const taskAttachment = p.match(/^\/api\/tasks\/[\w-]+\/attachments\/([\w-]+)$/);
  if (method === 'GET' && p === '/api/tasks') {
    const tasks = os.tasks.list({ tenant: os.tenant, status: (url.searchParams.get('status') as TaskStatus) || undefined, query: url.searchParams.get('q') || undefined, limit: 500 });
    return sendJson(res, 200, { tasks, counts: os.tasks.counts(os.tenant), agents: terminalAgents(os).map((a) => a.id) });
  }
  if (taskId && method === 'GET') {
    const found = os.tasks.withEvents(taskId[1]);
    if (!found) return sendJson(res, 404, { error: 'task not found' });
    return sendJson(res, 200, { ...found, attachments: os.tasks.attachments(found.task.id), dependents: os.tasks.dependents(found.task.id) });
  }
  // Upload a file onto a task (raw bytes in the body; original name in ?name=). Any member, like a task edit.
  if (taskAttachments && method === 'POST') {
    if (!os.tasks.get(taskAttachments[1])) return sendJson(res, 404, { error: 'task not found' });
    const name = url.searchParams.get('name') || '';
    if (!name.trim()) return sendJson(res, 400, { error: 'a file name (?name=) is required' });
    const buf = await readRawBuffer(req);
    if (buf.length === 0) return sendJson(res, 400, { error: 'empty upload' });
    const out = os.tasks.attachBytes({ taskId: taskAttachments[1], filename: name, bytes: buf, uploadedBy: me.id });
    if (!out.ok) return sendJson(res, 400, { error: out.error });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'task.attached', data: { taskId: taskAttachments[1], id: out.attachment.id, filename: out.attachment.filename, bytes: out.attachment.bytes } });
    return sendJson(res, 200, { ok: true, attachment: out.attachment });
  }
  // Stream an attachment's bytes (inline; browser previews images/pdf, downloads the rest). Any member.
  if (taskAttachmentRaw && method === 'GET') {
    const resolved = os.tasks.readAttachment(taskAttachmentRaw[1]);
    if (!resolved) return sendJson(res, 404, { error: 'attachment not found' });
    const st = fs.statSync(resolved.absPath);
    const stream = fs.createReadStream(resolved.absPath);
    stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read failed' }); else res.end(); });
    res.writeHead(200, {
      'content-type': resolved.mime,
      'content-length': String(st.size),
      'content-disposition': `inline; filename="${resolved.filename.replace(/"/g, '')}"`,
    });
    stream.pipe(res);
    return;
  }
  // Remove an attachment. Any member (like a task edit); the removal is logged on the task timeline.
  if (taskAttachment && method === 'DELETE') {
    const ok = os.tasks.removeAttachment(taskAttachment[1], me.id);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'task.attachment.removed', data: { id: taskAttachment[1] } });
    return sendJson(res, ok ? 200 : 404, { ok });
  }
  if (method === 'POST' && p === '/api/tasks') {
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    if (!title) return sendJson(res, 400, { error: 'title is required' });
    try {
      const task = os.tasks.create({
        tenant: os.tenant, title, body: b.body !== undefined ? String(b.body) : '',
        assignee: typeof b.assignee === 'string' && b.assignee ? b.assignee : undefined,
        // owner = the member the dispatched session runs AS (run_as). Default to the creator, so a
        // human-filed task dispatches as them (human passthrough) AND its session stays visible to them
        // (the run_as visibility rule) — not only to owner/admin.
        owner: typeof b.owner === 'string' && b.owner ? b.owner : me.id,
        priority: typeof b.priority === 'number' ? b.priority : undefined,
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        parentId: typeof b.parentId === 'string' ? b.parentId : undefined,
        mode: b.mode === 'interactive' ? 'interactive' : 'headless',
        autoDispatch: b.autoDispatch === true,
        goalId: typeof b.goalId === 'string' && b.goalId ? b.goalId : undefined,
        criteria: typeof b.criteria === 'string' && b.criteria ? b.criteria : undefined,
        dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : undefined,
        dueAt: typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined,
        createdBy: me.id,
      });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'task.created', data: { id: task.id, title: task.title, assignee: task.assignee ?? null } });
      // Immediate dispatch when it's an auto-dispatch task assigned to an agent (§3.3 trigger 2) — the
      // tick would pick it up anyway; kicking it now is snappier. Guarded (won't double-fire).
      if (task.autoDispatch && (task.assignee || '').startsWith('agent:')) autos.dispatchTask(task.id, { guard: true, by: me.email });
      return sendJson(res, 200, { ok: true, task: os.tasks.get(task.id) });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (taskId && method === 'PATCH') {
    const b = await readBody(req);
    const task = os.tasks.update(taskId[1], {
      title: typeof b.title === 'string' ? b.title : undefined,
      body: typeof b.body === 'string' ? b.body : undefined,
      status: typeof b.status === 'string' ? (b.status as TaskStatus) : undefined,
      assignee: b.assignee === null ? null : (typeof b.assignee === 'string' ? b.assignee : undefined),
      priority: typeof b.priority === 'number' ? b.priority : undefined,
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      mode: b.mode === 'headless' || b.mode === 'interactive' ? b.mode : undefined,
      goalId: b.goalId === null ? null : (typeof b.goalId === 'string' ? b.goalId : undefined),
      criteria: b.criteria === null ? null : (typeof b.criteria === 'string' ? b.criteria : undefined),
      dependsOn: Array.isArray(b.dependsOn) ? b.dependsOn.map(String) : undefined,
      dueAt: b.dueAt === null ? null : (typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined),
      note: typeof b.note === 'string' ? b.note : undefined,
      by: me.id,
    });
    if (!task) return sendJson(res, 404, { error: 'task not found' });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: task.status === 'done' ? 'task.completed' : 'task.updated', data: { id: task.id, status: task.status } });
    return sendJson(res, 200, { ok: true, task });
  }
  if (taskComment && method === 'POST') {
    const b = await readBody(req);
    const note = String(b.body || '').trim();
    if (!note) return sendJson(res, 400, { error: 'a comment body is required' });
    const task = os.tasks.update(taskComment[1], { note, by: me.id });
    if (!task) return sendJson(res, 404, { error: 'task not found' });
    return sendJson(res, 200, { ok: true, task });
  }
  if (taskDispatch && method === 'POST') {
    const task = os.tasks.get(taskDispatch[1]);
    if (!task) return sendJson(res, 404, { error: 'task not found' });
    const agentId = (task.assignee || '').startsWith('agent:') ? task.assignee!.slice('agent:'.length) : '';
    if (!agentId) return sendJson(res, 400, { error: 'assign an agent before dispatching' });
    if (!os.team.canRun(me, agentId)) return sendJson(res, 403, { error: `you are not assigned to run "${agentId}"` });
    const r = autos.dispatchTask(task.id, { guard: false, by: me.email }); // explicit human action — no pile-up guard
    return sendJson(res, r.ok ? 200 : 409, r.ok ? { ok: true, sessionId: r.sessionId } : { ok: false, error: r.reason });
  }
  if (taskId && method === 'DELETE') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ok = os.tasks.remove(taskId[1]);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'task.deleted', data: { id: taskId[1] } });
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ── Goals (console) ──────────────────────────────────────────────────────────
  // The strategic layer humans own. Reads are any-member; mutations are owner/admin (strategy is a
  // steering-wheel concern). Auto-apply + audited; the append-only goal_events log is the safety net.
  const goalId = p.match(/^\/api\/goals\/([\w-]+)$/);
  const goalComment = p.match(/^\/api\/goals\/([\w-]+)\/comment$/);
  const goalPlan = p.match(/^\/api\/goals\/([\w-]+)\/plan$/);
  // "Plan this goal" — spawn the strategist (a governed headless agent) to turn the goal into a reviewable
  // task plan linked to it. File-only: it files tasks, a human dispatches. Owner/admin, like goal edits.
  if (goalPlan && method === 'POST') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const goal = os.goals.get(goalPlan[1]);
    if (!goal) return sendJson(res, 404, { error: 'goal not found' });
    const r = await new Strategist(os, tm).plan(goal.id, me.email, me.id);
    if (r.spawned) os.audit.append({ ts: Date.now(), runId: r.sessionId ?? '-', tenant: os.tenant, principal: me.email, type: 'goal.plan.requested', data: { goalId: goal.id } });
    return sendJson(res, r.spawned ? 200 : 409, r.spawned ? { ok: true, sessionId: r.sessionId } : { ok: false, error: r.reason });
  }
  if (method === 'GET' && p === '/api/goals') {
    const goals = os.goals.list({ tenant: os.tenant, status: (url.searchParams.get('status') as GoalStatus) || undefined, query: url.searchParams.get('q') || undefined, limit: 500 });
    // Derived progress per goal (from its linked tasks) for the page's progress bars — keyed by id.
    const progress = Object.fromEntries(goals.map((g) => [g.id, os.goals.progress(g.id)]));
    return sendJson(res, 200, { goals, counts: os.goals.counts(os.tenant), progress, autoPlan: os.settings.autoPlanGoals() });
  }
  // Toggle the goal auto-planner (Phase 2) — opt-in, owner/admin. When on, the scheduler drafts a plan for
  // any stuck active goal (file-only). Placed before the /:id routes so "autoplan" isn't read as a goal id.
  if (method === 'POST' && p === '/api/goals/autoplan') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const on = b.on === true || b.on === 'true';
    os.settings.setAutoPlanGoals(on, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'goals.autoplan.set', data: { on } });
    return sendJson(res, 200, { ok: true, autoPlan: on });
  }
  if (goalComment && method === 'POST') {
    const b = await readBody(req);
    const note = String(b.body || '').trim();
    if (!note) return sendJson(res, 400, { error: 'a comment body is required' });
    const goal = os.goals.update(goalComment[1], { note, by: me.id });
    if (!goal) return sendJson(res, 404, { error: 'goal not found' });
    return sendJson(res, 200, { ok: true, goal });
  }
  if (goalId && method === 'GET') {
    const found = os.goals.withEvents(goalId[1]);
    if (!found) return sendJson(res, 404, { error: 'goal not found' });
    return sendJson(res, 200, { ...found, tasks: os.tasks.tasksForGoal(found.goal.id), progress: os.goals.progress(found.goal.id) });
  }
  if (method === 'POST' && p === '/api/goals') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const title = String(b.title || '').trim();
    if (!title) return sendJson(res, 400, { error: 'title is required' });
    try {
      const goal = os.goals.create({
        tenant: os.tenant, title, body: b.body !== undefined ? String(b.body) : '',
        status: typeof b.status === 'string' ? (b.status as GoalStatus) : 'active',
        target: typeof b.target === 'string' && b.target ? b.target : undefined,
        owner: typeof b.owner === 'string' && b.owner ? b.owner : undefined,
        parentId: typeof b.parentId === 'string' && b.parentId ? b.parentId : undefined,
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        dueAt: typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined,
        createdBy: me.id,
      });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'goal.created', data: { id: goal.id, title: goal.title, status: goal.status } });
      return sendJson(res, 200, { ok: true, goal });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (goalId && method === 'PATCH') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const goal = os.goals.update(goalId[1], {
      title: typeof b.title === 'string' ? b.title : undefined,
      body: typeof b.body === 'string' ? b.body : undefined,
      status: typeof b.status === 'string' ? (b.status as GoalStatus) : undefined,
      target: b.target === null ? null : (typeof b.target === 'string' ? b.target : undefined),
      owner: b.owner === null ? null : (typeof b.owner === 'string' ? b.owner : undefined),
      parentId: b.parentId === null ? null : (typeof b.parentId === 'string' ? b.parentId : undefined),
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      dueAt: b.dueAt === null ? null : (typeof b.dueAt === 'number' && Number.isFinite(b.dueAt) ? b.dueAt : undefined),
      note: typeof b.note === 'string' ? b.note : undefined,
      by: me.id,
    });
    if (!goal) return sendJson(res, 404, { error: 'goal not found' });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'goal.updated', data: { id: goal.id, status: goal.status } });
    return sendJson(res, 200, { ok: true, goal });
  }
  if (goalId && method === 'DELETE') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ok = os.goals.remove(goalId[1]);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'goal.deleted', data: { id: goalId[1] } });
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  // ── self-learning (Dreaming): reflect on recent runs → a KB page + a shared memory Insight ──
  if (method === 'GET' && p === '/api/dreaming') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const last = os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.dreamed'").get<{ t: number | null }>();
    const lastPosted = os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'digest.posted'").get<{ t: number | null }>();
    // The cumulative self-learning state powers the "reviewed N runs / X% success" header + the review
    // history on the Dreaming page. Topics are omitted (large); pass the compact bits the UI renders.
    const raw = os.settings.dreamingState() as { firstPass?: number; passes?: number; totals?: Record<string, number>; recent?: unknown[] } | null;
    const state = raw ? { firstPass: raw.firstPass, passes: raw.passes, totals: raw.totals, recent: raw.recent } : undefined;
    // Drop any open recommendation whose condition is already resolved (e.g. effort set to "high" in
    // Settings after the pass proposed it) — recs regenerate only on a full pass, so this prevents a stale
    // card lingering between passes. Persist the cleanup so it's actually cleared, not just hidden.
    const recsStored = os.settings.recommendations();
    const effort = os.settings.runtimeDefaults().effort;
    const openRecs = recsStored.open.filter((r) => !recommendationResolved(r, effort));
    if (openRecs.length !== recsStored.open.length) os.settings.setRecommendations({ open: openRecs, dismissed: recsStored.dismissed }, 'system');
    const dreamInsights = buildInsights(os);
    return sendJson(res, 200, {
      everyHours: os.settings.dreamingEveryHours(), lastDreamedAt: last?.t ?? undefined,
      applyLearnings: os.settings.applyLearnings(), guidance: os.settings.learnedGuidance(), recommendations: openRecs, state, alertsEnabled: os.settings.insightsAlertsEnabled(),
      measurement: measureLearning(os), // "Is it working?" — success-rate trend + per-intervention before/after (G1)
      insights: dreamInsights, improvements: buildImprovements(os, dreamInsights), // scorecard + friction + improvement tiles
      proposals: pendingProposals(os), // agents with a drafted-CLAUDE.md proposal awaiting Apply/Dismiss
      stuckGoals: stuckGoals(os), // active goals with no progress in 7+ days — plan-able from the Goals tile
      troubledAutomations: troubledAutomations(os), // errored/idle automations — triage from the Automations tile
      digest: { enabled: os.settings.digestEnabled(), channel: os.settings.digestChannel(), discordChannel: os.settings.digestDiscordChannel(), hour: os.settings.digestHour(), slackConfigured: os.settings.slackConfigured(), discordConfigured: os.settings.discordConfigured(), lastPostedAt: lastPosted?.t ?? undefined },
    });
  }
  // The OS intelligence layer, standalone — per-agent scorecard + friction map + improvement tiles + the
  // "is it working?" measurement, decoupled from the Dreaming page so an owner dashboard can consume it.
  if (method === 'GET' && p === '/api/insights') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ins = buildInsights(os);
    return sendJson(res, 200, { insights: ins, improvements: buildImprovements(os, ins), measurement: measureLearning(os), proposals: pendingProposals(os), stuckGoals: stuckGoals(os), troubledAutomations: troubledAutomations(os) });
  }
  // Root-cause diagnosis: spawn the analyst to work out WHY a struggling agent keeps failing, into a KB page.
  if (method === 'POST' && p === '/api/insights/diagnose') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    if (!agent) return sendJson(res, 400, { error: 'agent required' });
    try {
      const r = await new Diagnosis(os, tm).run(agent, me.email);
      return sendJson(res, r.spawned ? 200 : 400, { ok: r.spawned, ...r });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Generate-the-fix: spawn the improver to DRAFT a better CLAUDE.md for an underperforming agent. The
  // draft lands as a review-gated KB proposal (`operations/proposed/<agent>`) — nothing changes live until
  // an owner Applies it below. The counterpart to Diagnose ("why") — this is "here's the fix, your call".
  if (method === 'POST' && p === '/api/insights/improve') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    if (!agent) return sendJson(res, 400, { error: 'agent required' });
    try {
      const r = await new Improver(os, tm).improveAgent(agent, me.email);
      return sendJson(res, r.spawned ? 200 : 400, { ok: r.spawned, ...r });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Apply / dismiss the improver's drafted CLAUDE.md proposal for an agent (owner/admin — nothing
  // auto-applies). Apply commits the KB draft as a new agent revision (reversible in the agent's history);
  // both actions discard the proposal page.
  const propMatch = p.match(/^\/api\/insights\/proposal\/([\w.-]+)\/(apply|dismiss)$/);
  if (propMatch && method === 'POST') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const [, agentId, action] = propMatch;
    const page = os.kb.read(os.tenant, 'operations', proposalSlug(agentId));
    if (!page) return sendJson(res, 404, { error: 'no pending proposal for this agent' });
    if (action === 'dismiss') {
      os.kb.remove(page.id);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'insights.improve.dismissed', data: { agent: agentId } });
      return sendJson(res, 200, { ok: true });
    }
    // apply — write the proposed body as the agent's CLAUDE.md, snapshot a revision, drop the draft page.
    if (!os.paths) return sendJson(res, 200, { ok: false, error: 'editing agents requires a data home' });
    const ag = os.agents.get(agentId);
    if (!ag?.dir) return sendJson(res, 404, { error: `unknown agent "${agentId}"` });
    const proposed = page.body;
    if (!proposed.trim()) return sendJson(res, 400, { error: 'proposal is empty' });
    const before = readAgentSnapshot(ag);
    const next = applyAgentSnapshot(os, ag, { ...before, claudeMd: proposed });
    const rev = os.agentRevisions.commit(os.tenant, agentId, before, manifestToSnapshot(next, proposed), `applied improver proposal (by ${me.email})`, me.email);
    tm.refreshAgentSkills?.(agentId); // if it has a live resident session, no-op otherwise
    os.kb.remove(page.id);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'insights.improve.applied', data: { agent: agentId, rev, chars: proposed.length } });
    return sendJson(res, 200, { ok: true, agent: agentId, rev });
  }
  // Memory domain "generate the fix": PREVIEW exactly what a cleanup would prune + merge (deterministic,
  // no mutation) so the owner reviews before deleting; POST applies the same plan. The review-gated
  // counterpart to the blind scheduled maintain in Settings → Memory.
  if (p === '/api/insights/memory/cleanup' && (method === 'GET' || method === 'POST')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (method === 'GET') return sendJson(res, 200, { ok: true, plan: planMemoryCleanup(os) });
    const r = applyMemoryCleanup(os, cleanupOpts(os), me.email);
    return sendJson(res, 200, { ok: true, ...r });
  }
  // KB domain "generate the fix": PREVIEW which dead (never-read, aged) pages would be archived (no
  // mutation), then POST archives them — soft remove, history survives + revertable. Review-gated tidy.
  if (p === '/api/insights/kb/tidy' && (method === 'GET' || method === 'POST')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (method === 'GET') return sendJson(res, 200, { ok: true, plan: planKbTidy(os) });
    const r = applyKbTidy(os, me.email);
    return sendJson(res, 200, { ok: true, ...r });
  }
  // Skills domain "generate the fix": spawn the skill-scout to mine recent successful fleet runs for a
  // recurring procedure and draft it as a skill via skill_propose — lands on the existing proposed-skill
  // review queue (published from the Skills page); no new apply surface.
  if (method === 'POST' && p === '/api/insights/skills/draft') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const r = await new SkillScout(os, tm).draft(me.email);
      return sendJson(res, r.spawned ? 200 : 400, { ok: r.spawned, ...r });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Apply / dismiss a config recommendation (human-gated — nothing auto-applies).
  const recMatch = p.match(/^\/api\/dreaming\/recommendation\/([\w.-]+)\/(apply|dismiss)$/);
  if (recMatch && method === 'POST') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const [, recId, action] = recMatch;
    const recs = os.settings.recommendations();
    const rec = recs.open.find((r) => r.id === recId);
    if (!rec) return sendJson(res, 404, { error: 'recommendation not found' });
    if (action === 'dismiss') {
      os.settings.setRecommendations({ open: recs.open.filter((r) => r.id !== recId), dismissed: [...new Set([...recs.dismissed, recId])] }, me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'recommendation.dismissed', data: { id: recId } });
      return sendJson(res, 200, { ok: true });
    }
    // apply
    if (!rec.apply?.runtimeDefaults) return sendJson(res, 400, { error: 'this recommendation is advisory — review it manually' });
    const merged = { ...os.settings.runtimeDefaults(), ...rec.apply.runtimeDefaults };
    const { tuning, error } = sanitizeRuntimeTuning(merged);
    if (error) return sendJson(res, 400, { error });
    os.settings.setRuntimeDefaults(tuning, me.email);
    os.settings.setRecommendations({ open: recs.open.filter((r) => r.id !== recId), dismissed: recs.dismissed }, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'recommendation.applied', data: { id: recId, runtimeDefaults: rec.apply.runtimeDefaults } });
    return sendJson(res, 200, { ok: true, applied: rec.apply.runtimeDefaults });
  }
  if (method === 'PUT' && p === '/api/dreaming') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    if (b.everyHours !== undefined) os.settings.setDreamingEveryHours(Number(b.everyHours) || 0, me.email);
    if (typeof b.applyLearnings === 'boolean') os.settings.setApplyLearnings(b.applyLearnings, me.email);
    if (typeof b.alertsEnabled === 'boolean') os.settings.setInsightsAlertsEnabled(b.alertsEnabled, me.email);
    if (b.digest && typeof b.digest === 'object') {
      const d = b.digest as { enabled?: boolean; channel?: string; discordChannel?: string; hour?: number };
      if (typeof d.enabled === 'boolean') os.settings.setDigestEnabled(d.enabled, me.email);
      if (d.channel !== undefined) os.settings.setDigestChannel(String(d.channel), me.email);
      if (d.discordChannel !== undefined) os.settings.setDigestDiscordChannel(String(d.discordChannel), me.email);
      if (d.hour !== undefined) os.settings.setDigestHour(Number(d.hour), me.email);
    }
    return sendJson(res, 200, { ok: true, everyHours: os.settings.dreamingEveryHours(), applyLearnings: os.settings.applyLearnings(), digest: { enabled: os.settings.digestEnabled(), channel: os.settings.digestChannel(), discordChannel: os.settings.digestDiscordChannel(), hour: os.settings.digestHour() } });
  }
  // The daily digest — today's model for the console dashboard (owner/admin), live from the DB.
  if (method === 'GET' && p === '/api/digest/today') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, new Digest(os).today());
  }
  // Post today's digest to Slack now (manual "post now" button). Refreshes the KB page even on a quiet day.
  if (method === 'POST' && p === '/api/digest/post') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const r = await new Digest(os).postNow(me.email, new Date(), publicOrigin(req));
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Clear & refresh today's digest: re-render the KB page from current data + reset the once-per-day post
  // guard (so the scheduled EOD post re-fires). Returns the fresh model for the console preview.
  if (method === 'POST' && p === '/api/digest/refresh') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { ok: true, ...new Digest(os).clearAndRefresh(me.email) });
  }
  // One "reflect" action: the cheap deterministic pass, then the memory-gardener over new material
  // (spawns a headless agent that grows shared memories + KB; no-ops when there's too little).
  if (method === 'POST' && p === '/api/dreaming/run') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const dream = await new DreamingEngine(os).dream(me.email);
      let consolidation;
      try {
        consolidation = await new Consolidation(os, tm).run('automation:consolidation');
      } catch (e) {
        consolidation = { spawned: false, reason: e instanceof Error ? e.message : String(e) };
      }
      // Refresh today's digest KB page off the freshly-updated guidance — but never post to Slack from a
      // manual reflect (the channel is pinged only by the scheduled EOD trigger).
      try { new Digest(os).refresh(me.email); } catch { /* best-effort */ }
      return sendJson(res, 200, { ok: true, ...dream, consolidation });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── create a new claude-code agent: a folder under the data home with agent.json + CLAUDE.md ──
  if (method === 'POST' && p === '/api/agents') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'creating agents requires a data home' });
    const b = await readBody(req);
    const id = String(b.id || '').trim().toLowerCase();
    const description = String(b.description || '').trim();
    const claudeMd = String(b.claudeMd ?? '');
    // model/effort are per-agent overrides — each optional (omit → inherit the workspace default at
    // launch). Validate effort against the CLI's value set.
    const { tuning, error: tErr } = sanitizeRuntimeTuning(b);
    if (tErr) return sendJson(res, 400, { error: tErr });
    // No forced model default: a blank field means "inherit the workspace default" (Settings →
    // Runtime defaults), same as effort/permission. The create form pre-fills claude-opus-4-8, so the
    // common case still pins a model explicitly; clearing it opts the agent into the fleet default.
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return sendJson(res, 400, { error: 'id must be lowercase letters, digits and hyphens (2–40 chars, starting with a letter)' });
    if (os.agents.get(id)) return sendJson(res, 409, { error: `an agent named "${id}" already exists` });
    if (!claudeMd.trim()) return sendJson(res, 400, { error: 'a CLAUDE.md is required' });
    const folder = path.join(os.paths.userAgents, id);
    if (fs.existsSync(folder)) return sendJson(res, 409, { error: `folder "${id}" already exists in the agents home` });

    const examplePrompts = sanitizeExamplePrompts(b.examplePrompts);
    const category = sanitizeCategory(b.category);
    const icon = sanitizeIcon(b.icon);
    const shellSecrets = sanitizeShellSecrets(b.shellSecrets);
    const manifest: AgentManifest = {
      id,
      version: '1.0.0',
      description,
      ...(category ? { category } : {}),
      principal: `svc-${id}`,
      policyContext: 'default@v3',
      runtime: 'claude-code',
      ...tuning,
      ...(examplePrompts ? { examplePrompts } : {}),
      ...(shellSecrets ? { shellSecrets } : {}),
      ...(icon ? { icon } : {}),
      budget: { usdCap: 2.0, tokenCap: 400000, wallClockMs: 1800000 },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), claudeMd);
    os.registerAgent({ ...manifest, dir: folder });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.created', data: { agent: id, runtime: 'claude-code', dir: folder } });
    return sendJson(res, 200, { ok: true, id });
  }

  // ── rescan the agent folders: pick up agents added/edited/removed on disk outside the console
  //    (git pull, scp, an agent writing a sibling) without a restart — owner/admin only. Removal
  //    here is registry-only (assignments + memories kept, in case the folder comes back); the
  //    DELETE route below stays the full-cleanup path.
  if (method === 'POST' && p === '/api/agents/rescan') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'rescanning agents requires a data home' });
    const diff = os.rescanAgents();
    if (diff.added.length || diff.updated.length || diff.removed.length) {
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agents.rescanned', data: { added: diff.added, updated: diff.updated, removed: diff.removed } });
    }
    return sendJson(res, 200, { ok: true, ...diff });
  }

  // ── import an agent from an "AOS bundle" .zip — owner/admin only ──────────────────
  //    The one-shot, lossless counterpart to the "Import into AOS" doc: a bundle carries the agent's
  //    files (manifest + CLAUDE.md + skills) AND its non-file state (memory.jsonl, knowledge/) so we
  //    replay the latter through the SAME stores an agent would (os.memory.store / os.kb.write). Raw
  //    zip bytes in the body. The agent's brain lands on disk + registers live (no rescan needed);
  //    memories/KB pages replay under the imported agent's identity. Recoverable issues → `warnings`.
  if (method === 'POST' && p === '/api/agents/import') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'importing agents requires a data home' });
    const buf = await readRawBuffer(req);
    if (buf.length === 0) return sendJson(res, 400, { error: 'empty upload' });
    let bundle;
    try { bundle = parseBundle(buf); }
    catch (e) { return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    const warnings = [...bundle.warnings];

    const id = bundle.agentId;
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return sendJson(res, 400, { error: `bundle agent id "${id}" is invalid (need lowercase letters, digits and hyphens, 2–40 chars, starting with a letter)` });
    if (os.agents.get(id)) return sendJson(res, 409, { error: `an agent named "${id}" already exists` });
    const folder = path.join(os.paths.userAgents, id);
    if (fs.existsSync(folder)) return sendJson(res, 409, { error: `folder "${id}" already exists in the agents home` });

    // Rebuild the manifest from safe defaults + the bundle's declared fields (principal/policy/budget
    // are always OS-assigned; a bad model/effort is a warning, not a failed import).
    const m = bundle.manifest;
    const { tuning, error: tErr } = sanitizeRuntimeTuning(m);
    if (tErr) warnings.push(`runtime tuning ignored: ${tErr}`);
    const examplePrompts = sanitizeExamplePrompts((m as { examplePrompts?: unknown }).examplePrompts);
    const category = sanitizeCategory((m as { category?: unknown }).category);
    const icon = sanitizeIcon((m as { icon?: unknown }).icon);
    const shellSecrets = sanitizeShellSecrets((m as { shellSecrets?: unknown }).shellSecrets);
    const manifest: AgentManifest = {
      id,
      version: typeof m.version === 'string' && m.version ? m.version : '1.0.0',
      description: typeof m.description === 'string' ? m.description.trim() : '',
      ...(category ? { category } : {}),
      principal: `svc-${id}`,
      policyContext: 'default@v3',
      runtime: 'claude-code',
      ...(tErr ? {} : tuning),
      ...(examplePrompts ? { examplePrompts } : {}),
      ...(shellSecrets ? { shellSecrets } : {}),
      ...(icon ? { icon } : {}),
      budget: { usdCap: 2.0, tokenCap: 400000, wallClockMs: 1800000 },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), bundle.claudeMd);
    os.registerAgent({ ...manifest, dir: folder });

    // Skills → the global library (skip a same-named existing one rather than failing the import).
    let skillsInstalled = 0;
    for (const s of bundle.skills) {
      try { os.skills.installFiles(s.name, s.files); skillsInstalled++; }
      catch (e) { warnings.push(`skill "${s.name}" not installed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Memory → replay each line under the imported agent (shared lines publish tenant-wide).
    let memoriesReplayed = 0;
    for (const mem of bundle.memories) {
      try {
        await os.memory.store({
          tenant: os.tenant, agentId: id, content: mem.content, tags: mem.tags,
          type: mem.type, importance: mem.importance, metadata: mem.metadata,
          scope: mem.shared ? 'tenant' : 'agent',
        });
        memoriesReplayed++;
      } catch (e) { warnings.push(`memory not replayed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Knowledge → replay each page into the shared KB, authored as the imported agent.
    let knowledgeReplayed = 0;
    for (const k of bundle.knowledge) {
      try {
        os.kb.write({ tenant: os.tenant, section: k.section, slug: k.slug, title: k.title, body: k.body, author: `agent:${id}` });
        knowledgeReplayed++;
      } catch (e) { warnings.push(`knowledge "${k.section}/${k.slug}" not replayed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.imported', data: { agent: id, dir: folder, skills: skillsInstalled, memories: memoriesReplayed, knowledge: knowledgeReplayed, warnings: warnings.length } });
    return sendJson(res, 200, { ok: true, id, skills: skillsInstalled, memories: memoriesReplayed, knowledge: knowledgeReplayed, warnings });
  }

  // ── the agent library: the catalog of ready-made agents that ships with the software — owner/admin ──
  //    Browse what's available and install one into this workspace (a copy of the catalog folder into the
  //    data home, where it becomes a normal editable agent). Distribution-only: users install FROM the
  //    catalog, they can't add to it (a one-off agent still arrives via the bundle importer above). The
  //    GET must precede the by-id agent matchers below so "catalog" isn't read as an agent id.
  if (method === 'GET' && p === '/api/agents/catalog') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const catalog = os.paths ? readAgentCatalog(os.paths.bundledAgents, os.paths.userAgents) : [];
    return sendJson(res, 200, { catalog });
  }
  const agentInstall = p.match(/^\/api\/agents\/catalog\/([\w.-]+)\/install$/);
  if (method === 'POST' && agentInstall) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'installing agents requires a data home' });
    try {
      const manifest = installAgentFromCatalog(os.paths.bundledAgents, os.paths.userAgents, agentInstall[1]);
      os.registerAgent(manifest);
      // Installing a built-in clears any deletion tombstone, so it seeds normally again on future boots.
      os.settings.unsuppressBuiltin(manifest.id, me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.installed', data: { agent: manifest.id, source: 'catalog', dir: manifest.dir } });
      return sendJson(res, 200, { ok: true, id: manifest.id });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── duplicate an agent: deep-copy its folder under a NEW id — owner/admin only ──
  //    A clone is a FRESH agent (its own id + `svc-<id>` principal), so it starts clean: none of
  //    the source's runtime history rides along (no memories, sessions, assignments, automations,
  //    skill scoping, artifacts, audit). That's the whole point of duplicate vs. an id-rename — a
  //    new id owns new references instead of orphaning the old ones. The SOURCE may be a built-in
  //    example (customise a read-only bundled agent); only the DESTINATION must live under the data
  //    home. Everything in the folder (agent.json + CLAUDE.md + any sibling files) is copied, then
  //    agent.json is rewritten with the new id/principal from the authoritative in-memory manifest.
  const agentDup = p.match(/^\/api\/agents\/([\w.-]+)\/duplicate$/);
  if (method === 'POST' && agentDup) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'duplicating agents requires a data home' });
    const b = await readBody(req);
    const srcId = agentDup[1];
    const src = os.agents.get(srcId);
    if (!src?.dir) return sendJson(res, 404, { error: `unknown agent "${srcId}"` });
    if (src.runtime !== 'claude-code') return sendJson(res, 400, { error: 'only claude-code agents can be duplicated' });
    const newId = String(b.newId || `${srcId}-copy`).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(newId)) return sendJson(res, 400, { error: 'id must be lowercase letters, digits and hyphens (2–40 chars, starting with a letter)' });
    if (os.agents.get(newId)) return sendJson(res, 409, { error: `an agent named "${newId}" already exists` });
    const folder = path.join(os.paths.userAgents, newId);
    if (fs.existsSync(folder)) return sendJson(res, 409, { error: `folder "${newId}" already exists in the agents home` });
    fs.cpSync(src.dir, folder, { recursive: true });
    const next: AgentManifest = { ...src, id: newId, principal: `svc-${newId}` };
    const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
    os.registerAgent({ ...next, dir: folder });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.duplicated', data: { agent: newId, from: srcId, dir: folder } });
    return sendJson(res, 200, { ok: true, id: newId });
  }

  // ── delete an agent: deregister + remove its folder — owner/admin only ──
  //    Any agent that lives UNDER the data home can be deleted. A seeded built-in lives there too, so
  //    it's deletable — but deleting its folder alone wouldn't stick (boot re-seeds it), so we also
  //    tombstone its id in settings (suppressedBuiltins) to make the removal durable. Re-installing it
  //    from the agent library clears that tombstone. An agent whose folder is OUTSIDE the home (a
  //    bundled example registered straight from the catalog) stays read-only.
  const agentDel = p.match(/^\/api\/agents\/([\w.-]+)$/);
  if (method === 'DELETE' && agentDel) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.paths) return sendJson(res, 400, { error: 'deleting agents requires a data home' });
    const id = agentDel[1];
    const ag = os.agents.get(id);
    if (!ag) return sendJson(res, 404, { error: `unknown agent "${id}"` });
    const userRoot = path.resolve(os.paths.userAgents) + path.sep;
    const dir = ag.dir ? path.resolve(ag.dir) : '';
    if (!dir || !(dir + path.sep).startsWith(userRoot)) {
      return sendJson(res, 403, { error: 'built-in agents cannot be deleted' });
    }
    if (tm.listSessions().some((s) => s.agent === id && s.status === 'running')) {
      return sendJson(res, 409, { error: 'this agent has a running session — stop it first' });
    }
    os.deregisterAgent(id);
    os.team.clearAssignment(id);
    // Close the residue loophole: an agent's PRIVATE memories must not outlive it. Shared
    // (tenant-scoped) memories it authored persist as company knowledge. Best-effort — a memory
    // backend error must never block deleting the agent itself.
    let memoriesForgotten = 0;
    try { memoriesForgotten = (await os.memory.forgetAgent?.(os.tenant, id)) ?? 0; } catch { /* best-effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
    // Deleting a built-in's folder isn't durable on its own (boot re-seeds it) — tombstone the id so the
    // removal survives a restart. A user-created agent isn't seeded, so it needs no tombstone.
    const builtin = BUILTIN_SEED_IDS.includes(id);
    if (builtin) os.settings.suppressBuiltin(id, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.deleted', data: { agent: id, dir, memoriesForgotten, builtin } });
    return sendJson(res, 200, { ok: true, memoriesForgotten });
  }

  // ── per-agent CLAUDE.md (the agent's system prompt) — owner/admin only ──
  const agentClaude = p.match(/^\/api\/agents\/([\w.-]+)\/claude$/);
  if (agentClaude && (method === 'GET' || method === 'PUT')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ag = os.agents.get(agentClaude[1]);
    if (!ag?.dir) return sendJson(res, 404, { error: 'agent not found or has no folder' });
    const file = path.join(ag.dir, 'CLAUDE.md');
    if (method === 'GET') {
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      return sendJson(res, 200, { agent: ag.id, runtime: ag.runtime, exists: fs.existsSync(file), content });
    }
    const b = await readBody(req);
    const before = readAgentSnapshot(ag);
    const content = String(b.content ?? '');
    fs.writeFileSync(file, content);
    const rev = os.agentRevisions.commit(os.tenant, ag.id, before, manifestToSnapshot(ag, content), 'edited CLAUDE.md', me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.claude.updated', data: { agent: ag.id, bytes: content.length, rev } });
    return sendJson(res, 200, { ok: true, rev });
  }

  // ── per-agent runtime tuning (model / effort / permission-mode) — owner/admin only ──
  //    GET returns the agent's current tuning; PUT rewrites agent.json and re-registers the manifest
  //    so the next session launches with the new values. Each field is nullable: send "" / null to
  //    clear an override (→ inherit the workspace default). Only claude-code agents with a folder.
  const agentConfig = p.match(/^\/api\/agents\/([\w.-]+)\/config$/);
  if (agentConfig && (method === 'GET' || method === 'PUT')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ag = os.agents.get(agentConfig[1]);
    if (!ag?.dir) return sendJson(res, 404, { error: 'agent not found or has no folder' });
    if (ag.runtime !== 'claude-code') return sendJson(res, 400, { error: 'runtime tuning applies to claude-code agents only' });
    if (method === 'GET') {
      return sendJson(res, 200, { agent: ag.id, description: ag.description, model: ag.model, effort: ag.effort, permissionMode: ag.permissionMode, examplePrompts: ag.examplePrompts, shellSecrets: ag.shellSecrets, netMode: ag.netMode ?? 'open', category: ag.category, icon: ag.icon });
    }
    const b = await readBody(req);
    const { tuning, error: tErr } = sanitizeRuntimeTuning(b);
    if (tErr) return sendJson(res, 400, { error: tErr });
    const before = readAgentSnapshot(ag);
    // Replace the tuning fields wholesale (sanitize already dropped empties to undefined → those
    // become "inherit"). Starter prompts + shell secrets + category + icon are only touched when the
    // body carries the field (a tuning-only save from the runtime card leaves them as-is). Preserve
    // everything else.
    const prompts = 'examplePrompts' in b ? sanitizeExamplePrompts(b.examplePrompts) : ag.examplePrompts;
    const shellSecrets = 'shellSecrets' in b ? sanitizeShellSecrets(b.shellSecrets) : ag.shellSecrets;
    // netMode is governance-sensitive (only owner/admin reach this route; a self-editing agent CANNOT
    // change it). 'allowlist' locks the agent to its granted hosts; anything else → 'open'. Undefined
    // ('open') is left off the manifest to keep it clean.
    const netMode = 'netMode' in b ? (b.netMode === 'allowlist' ? 'allowlist' : 'open') : ag.netMode;
    const category = 'category' in b ? sanitizeCategory(b.category) : ag.category;
    const icon = 'icon' in b ? sanitizeIcon(b.icon) : ag.icon;
    const description = 'description' in b ? String(b.description ?? '').trim() : ag.description;
    const next: AgentManifest = { ...ag, description, model: tuning.model, effort: tuning.effort, permissionMode: tuning.permissionMode, examplePrompts: prompts, shellSecrets, netMode: netMode === 'open' ? undefined : netMode, category, icon };
    const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
    fs.writeFileSync(path.join(ag.dir, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
    os.registerAgent(next);
    const rev = os.agentRevisions.commit(os.tenant, ag.id, before, manifestToSnapshot(next, before.claudeMd), 'edited config', me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.config.updated', data: { agent: ag.id, model: tuning.model, effort: tuning.effort, permissionMode: tuning.permissionMode, category, shellSecrets: shellSecrets ?? [], netMode: netMode ?? 'open', rev } });
    return sendJson(res, 200, { ok: true, description, model: tuning.model, effort: tuning.effort, permissionMode: tuning.permissionMode, examplePrompts: prompts, shellSecrets, netMode: netMode ?? 'open', category, icon });
  }

  // ── agent config revision history + revert (owner/admin) — the human rollback for a self-editing agent ──
  const agentRevs = p.match(/^\/api\/agents\/([\w.-]+)\/revisions$/);
  if (agentRevs && method === 'GET') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ag = os.agents.get(agentRevs[1]);
    if (!ag) return sendJson(res, 404, { error: 'agent not found' });
    return sendJson(res, 200, { agent: ag.id, revisions: os.agentRevisions.list(ag.id) });
  }
  const agentRevert = p.match(/^\/api\/agents\/([\w.-]+)\/revert$/);
  if (agentRevert && method === 'POST') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const ag = os.agents.get(agentRevert[1]);
    if (!ag?.dir) return sendJson(res, 404, { error: 'agent not found or has no folder' });
    if (ag.runtime !== 'claude-code') return sendJson(res, 400, { error: 'only claude-code agents can be reverted' });
    const b = await readBody(req);
    const rev = Number(b.rev);
    const target = os.agentRevisions.get(ag.id, rev);
    if (!target) return sendJson(res, 404, { error: `no revision ${b.rev} for "${ag.id}"` });
    const before = readAgentSnapshot(ag);
    const next = applyAgentSnapshot(os, ag, target);
    const newRev = os.agentRevisions.commit(os.tenant, ag.id, before, manifestToSnapshot(next, target.claudeMd), `revert to rev ${rev}`, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.config.reverted', data: { agent: ag.id, toRev: rev, rev: newRev } });
    return sendJson(res, 200, { ok: true, id: ag.id, toRev: rev, rev: newRev });
  }

  // ── workspace runtime defaults (the fleet-wide model/effort/permission fallback) — owner/admin only ──
  if (method === 'GET' && p === '/api/settings/runtime-defaults') {
    return sendJson(res, 200, { ...os.settings.runtimeDefaults(), ...os.settings.runtimeDefaultsMeta() });
  }
  if (method === 'PUT' && p === '/api/settings/runtime-defaults') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const { tuning, error: tErr } = sanitizeRuntimeTuning(b);
    if (tErr) return sendJson(res, 400, { error: tErr });
    const saved = os.settings.setRuntimeDefaults(tuning, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.runtimeDefaults.updated', data: { ...tuning } });
    return sendJson(res, 200, { ok: true, ...saved });
  }

  // ── whole-box concurrency cap (docs/concurrency-cap-plan.md Phase 1) ──
  // The effective cap resolves env → operator Settings → RAM-derived default (single source of truth =
  // Automations.concurrencyCap). Reports the resolved value + its source + the live running count so the
  // console can show "N / cap running" and whether an env var is pinning it.
  if (method === 'GET' && p === '/api/settings/concurrency') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const env = process.env.AOS_MAX_CONCURRENT_SESSIONS;
    const envLocked = env !== undefined && env.trim() !== '' && Number.isFinite(Number(env)) && Number(env) >= 0;
    const value = os.settings.maxConcurrentSessions(); // operator override (null = unset)
    const resolved = autos.concurrencyCap();           // effective cap the scheduler enforces (0 = unlimited)
    const source = envLocked ? 'env' : value != null ? 'setting' : 'derived';
    return sendJson(res, 200, { value, resolved, derived: derivedConcurrencyCap(), source, envLocked, alive: tm.aliveSessionCount(), idleHours: os.settings.interactiveIdleTimeoutHours() });
  }
  if (method === 'PUT' && p === '/api/settings/concurrency') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req) as { value?: unknown; idleHours?: unknown };
    // Cap: `null`/'' clears the override (→ derived default); 0 = unlimited; N>0 = cap. Only touched when the
    // key is present, so a PUT that only sets idleHours leaves the cap alone.
    if ('value' in b) {
      const raw = b.value;
      const clear = raw === null || raw === '';
      const n = clear ? null : Number(raw);
      if (!clear && (!Number.isFinite(n as number) || (n as number) < 0)) return sendJson(res, 400, { error: 'value must be a non-negative integer, 0 (unlimited), or null (use default)' });
      const saved = os.settings.setMaxConcurrentSessions(clear ? null : (n as number), me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.concurrency.updated', data: { value: saved } });
    }
    // Idle-interactive reaper timeout (hours): 0 = off; else clamped 1h–30d. Present-only, same as above.
    if ('idleHours' in b) {
      const h = Number(b.idleHours);
      if (!Number.isFinite(h) || h < 0) return sendJson(res, 400, { error: 'idleHours must be a non-negative number (0 = off)' });
      const savedH = os.settings.setInteractiveIdleTimeoutHours(h, me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.interactiveIdle.updated', data: { idleHours: savedH } });
    }
    return sendJson(res, 200, { ok: true, value: os.settings.maxConcurrentSessions(), resolved: autos.concurrencyCap(), derived: derivedConcurrencyCap(), idleHours: os.settings.interactiveIdleTimeoutHours() });
  }

  // ── UI branding (per-tenant accent colour + favicon badge) — owner/admin edits ──
  // The public read is GET /api/branding (above the member gate); this is the admin editor surface.
  if (method === 'GET' && p === '/api/settings/branding') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { ...os.settings.branding(), ...os.settings.brandingMeta() });
  }
  if (method === 'PUT' && p === '/api/settings/branding') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const saved = os.settings.setBranding(sanitizeBranding(b as Partial<Record<keyof Branding, unknown>>), me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.branding.updated', data: { ...saved } });
    return sendJson(res, 200, { ok: true, ...saved });
  }

  // ── governance thresholds (the numeric caps the never-tier policy rules read) ──
  if (method === 'GET' && p === '/api/settings/governance') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { ...os.settings.governanceThresholds(), hostGovernanceEnabled: os.settings.hostGovernanceEnabled(), ...os.settings.governanceMeta() });
  }
  if (method === 'PUT' && p === '/api/settings/governance') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const saved = os.settings.setGovernanceThresholds(
      { moneyCapUsd: Number(b.moneyCapUsd), bulkDeleteCount: Number(b.bulkDeleteCount), emailBulkCap: Number(b.emailBulkCap) },
      me.email,
    );
    // Host-egress governance master switch (owner-only, since it changes WHAT gates). Only touched when
    // the field is present, so a thresholds-only save leaves it unchanged.
    if (typeof b.hostGovernanceEnabled === 'boolean') {
      if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required to change host governance' });
      os.settings.setHostGovernanceEnabled(b.hostGovernanceEnabled, me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.host_governance.updated', data: { enabled: b.hostGovernanceEnabled } });
    }
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.governance.updated', data: { ...saved } });
    return sendJson(res, 200, { ok: true, ...saved, hostGovernanceEnabled: os.settings.hostGovernanceEnabled() });
  }

  // ── custom governance patterns (operator regex → boolean fact the enricher sets, policy gates on) ──
  if (method === 'GET' && p === '/api/settings/enrich-patterns') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { patterns: os.settings.enrichPatterns() });
  }
  if (method === 'PUT' && p === '/api/settings/enrich-patterns') {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' }); // patterns govern what gates → owner only
    const b = await readBody(req);
    try {
      const saved = os.settings.setEnrichPatterns(Array.isArray(b.patterns) ? b.patterns : [], me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.enrich_patterns.updated', data: { count: saved.length } });
      return sendJson(res, 200, { ok: true, patterns: saved });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── email org domains (internal recipients → email.send is green; external → yellow) ──
  if (method === 'GET' && p === '/api/settings/email-domains') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { orgDomains: os.settings.emailOrgDomains(), ...os.settings.emailOrgDomainsMeta() });
  }
  if (method === 'PUT' && p === '/api/settings/email-domains') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const input = Array.isArray(b.orgDomains)
      ? (b.orgDomains as unknown[]).map(String)
      : typeof b.orgDomains === 'string'
        ? b.orgDomains.split(',')
        : [];
    const saved = os.settings.setEmailOrgDomains(input, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.email_domains.updated', data: { orgDomains: saved } });
    return sendJson(res, 200, { ok: true, orgDomains: saved });
  }

  // ── kill switch (workspace emergency stop — gate denies everything while engaged) ──
  if (method === 'GET' && p === '/api/settings/kill-switch') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, os.settings.killSwitch());
  }
  if (method === 'POST' && p === '/api/settings/kill-switch') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const engaged = b.engaged === true;
    const state = os.settings.setKillSwitch(engaged, typeof b.reason === 'string' ? b.reason : undefined, me.email);
    // On engage, optionally halt running sessions (default true) so nothing keeps running mid-task —
    // a frozen gate only stops the NEXT gated action. Releasing leaves sessions stopped; respawn to resume.
    let halted = 0;
    if (engaged && b.haltSessions !== false) halted = tm.stopAllRunning(me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: engaged ? 'killswitch.engaged' : 'killswitch.released', data: { reason: state.reason, halted } });
    return sendJson(res, 200, { ok: true, ...state, halted });
  }

  // ── host resource metrics (Settings → System: RAM / CPU / uptime) ──
  if (method === 'GET' && p === '/api/system') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, await systemMetrics(tm));
  }
  // ── native system dependencies (tmux/ttyd/claude/git) — "is the box set up to run sessions?" ──
  if (method === 'GET' && p === '/api/deps') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, checkDeps());
  }
  // Install the still-missing, package-manager-installable deps (brew/apt/…). Owner-gated (it runs a
  // privileged system install), same posture as the self-update apply below.
  if (method === 'POST' && p === '/api/deps/install') {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const result = installDeps();
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'system.deps.installed', data: { ok: result.ok, steps: result.steps.map((s) => ({ cmd: s.cmd, ok: s.ok })) } });
    return sendJson(res, 200, result);
  }
  // ── stop every running session (softer sibling of the kill switch; leaves the gate open) ──
  if (method === 'POST' && p === '/api/sessions/stop-all') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const halted = tm.stopAllRunning(me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'sessions.stop_all', data: { halted } });
    return sendJson(res, 200, { ok: true, halted });
  }

  // ── company settings (workspace-wide context injected into every claude-code agent) ──
  if (method === 'GET' && p === '/api/settings') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, os.settings.company());
  }
  if (method === 'PUT' && p === '/api/settings/company') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const updated = os.settings.setCompany(String(b.companyMd ?? ''), me.email);
    return sendJson(res, 200, { ok: true, ...updated });
  }

  // ── integration credentials (Composio now; Slack app etc. later) — instance-wide secrets ──
  if (method === 'GET' && p === '/api/settings/integrations') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    // Self-heal the App slug (→ the Creds "Install the App" button) for a hand-configured App that never
    // got one from the manifest flow. Resolves once from GET /app whenever the bot creds are present.
    const ghv = new GithubIdentity(os);
    if (ghv.botConfigured() && !ghv.appSlug()) await ghv.ensureAppSlug(me.email).catch(() => { /* best-effort */ });
    return sendJson(res, 200, integrationsView(os));
  }
  // Live Atlas catalog for the default-model pickers (dropdown + free text). Fetched with the stored
  // key, filtered to text-to-image / text-to-video, cached briefly so the settings page stays snappy.
  if (method === 'GET' && p === '/api/integrations/atlas/models') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const key = os.settings.atlasKey();
    if (!key) return sendJson(res, 200, { configured: false, image: [], video: [] });
    const cat = await fetchAtlasModels(key);
    return sendJson(res, 200, { configured: true, ...cat });
  }
  if (method === 'PUT' && p === '/api/settings/integrations') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    // Only touch a field when the client sends it as a string; '' clears the key.
    if (typeof b.composioApiKey === 'string') os.settings.setComposioApiKey(b.composioApiKey, me.email);
    if (typeof b.composioWebhookSecret === 'string') os.settings.setComposioWebhookSecret(b.composioWebhookSecret, me.email);
    // Slack tokens: changing either re-dials (or tears down) the Socket-Mode connection.
    const slackTouched = typeof b.slackAppToken === 'string' || typeof b.slackBotToken === 'string';
    if (typeof b.slackAppToken === 'string') os.settings.setSlackAppToken(b.slackAppToken, me.email);
    if (typeof b.slackBotToken === 'string') os.settings.setSlackBotToken(b.slackBotToken, me.email);
    // Removing the Slack integration orphans its automations (slack triggers can never fire
    // again). Sweep them so the Automations list doesn't show dead rules. Only when the change
    // left Slack fully unconfigured — editing one token while it stays connected keeps them.
    let removedSlackAutomations = 0;
    if (slackTouched && !os.settings.slackConfigured()) {
      for (const a of autos.list()) {
        if (a.type === 'slack' && autos.remove(a.id)) removedSlackAutomations++;
      }
    }
    if (slackTouched && slack) void slack.restart();
    // Discord bot token: the analogue of the Slack tokens — changing it re-dials (or tears down) the
    // Gateway connection, and clearing it orphans discord automations the same way.
    const discordTouched = typeof b.discordBotToken === 'string';
    if (typeof b.discordBotToken === 'string') os.settings.setDiscordBotToken(b.discordBotToken, me.email);
    let removedDiscordAutomations = 0;
    if (discordTouched && !os.settings.discordConfigured()) {
      for (const a of autos.list()) {
        if (a.type === 'discord' && autos.remove(a.id)) removedDiscordAutomations++;
      }
    }
    if (discordTouched && discord) void discord.restart();
    // Per-member GitHub App OAuth credentials: client id → setting, client secret → vault. '' clears.
    if (typeof b.githubClientId === 'string') {
      os.settings.setGithubClientId(b.githubClientId, me.email);
      // Clearing the client id detaches the App entirely — drop the stale install-link slug too.
      if (!b.githubClientId.trim()) os.settings.setGithubAppSlug('', me.email);
    }
    if (typeof b.githubClientSecret === 'string') new GithubIdentity(os).setClientSecret(b.githubClientSecret, me.email);
    // App slug — manual override for the "Install the App" link when it can't be auto-resolved (no bot
    // creds + no member installation to read it from). Accept the bare slug or a full github.com/apps/<slug>
    // URL; keep only the slug-safe part.
    if (typeof b.githubAppSlug === 'string') {
      const slug = (b.githubAppSlug.trim().match(/[\w.-]+$/)?.[0] || '').toLowerCase();
      os.settings.setGithubAppSlug(slug, me.email);
    }
    // Company-bot (installation-token) credentials: App ID → setting, RSA private key → vault. When both
    // are set, pre-warm + VALIDATE by minting a bot token now, so the admin gets immediate feedback and
    // the first session doesn't have to wait on a cold mint. Audited github.bot_token.minted / .failed.
    if (typeof b.githubAppId === 'string') new GithubIdentity(os).setAppId(b.githubAppId, me.email);
    if (typeof b.githubPrivateKey === 'string') new GithubIdentity(os).setPrivateKey(b.githubPrivateKey, me.email);
    if (typeof b.githubAppId === 'string' || typeof b.githubPrivateKey === 'string') {
      const ghb = new GithubIdentity(os);
      if (ghb.botConfigured()) {
        const bot = await ghb.ensureBotToken(Date.now(), me.email).catch(() => undefined);
        // Also resolve the App slug now → the "Install the App" link/button (a hand-set App has no slug yet).
        if (!ghb.appSlug()) await ghb.ensureAppSlug(me.email).catch(() => { /* best-effort */ });
        os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: bot ? 'github.bot_token.minted' : 'github.bot_token.failed', data: { installationId: os.settings.githubInstallationId() || null } });
      }
    }
    // Image generation backend keys (OpenRouter default / Atlas alt) + optional default model.
    if (typeof b.openRouterKey === 'string') os.settings.setOpenRouterKey(b.openRouterKey, me.email);
    if (typeof b.atlasKey === 'string') os.settings.setAtlasKey(b.atlasKey, me.email);
    if (typeof b.imageDefaultModel === 'string') os.settings.setImageDefaultModel(b.imageDefaultModel, me.email);
    // Video generation backend key (fal.ai default; Atlas is the shared image key) + optional default model.
    if (typeof b.falKey === 'string') os.settings.setFalKey(b.falKey, me.email);
    if (typeof b.videoDefaultModel === 'string') os.settings.setVideoDefaultModel(b.videoDefaultModel, me.email);
    // Generic `/agent` chat router toggle (Slack + Discord fallback when no automation matches).
    if (typeof b.chatRouter === 'boolean') os.settings.setChatRouterEnabled(b.chatRouter, me.email);
    // Warm (resident) Slack thread session idle-kill, minutes (0 = disable residence → cold replies).
    if (b.chatIdleTimeoutMin !== undefined && Number.isFinite(Number(b.chatIdleTimeoutMin))) os.settings.setChatIdleTimeoutMinutes(Number(b.chatIdleTimeoutMin), me.email);
    return sendJson(res, 200, { ok: true, removedSlackAutomations, removedDiscordAutomations, ...integrationsView(os) });
  }
  // Live Slack Socket-Mode connection status (owner/admin) — for the Integrations panel.
  if (method === 'GET' && p === '/api/settings/slack/status') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, slack ? slack.status() : { configured: os.settings.slackConfigured(), connected: false, botUserId: '' });
  }
  // Live Discord Gateway connection status (owner/admin) — for the Integrations panel.
  if (method === 'GET' && p === '/api/settings/discord/status') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, discord ? discord.status() : { configured: os.settings.discordConfigured(), connected: false, botUserId: '' });
  }

  // ── per-member GitHub (user-to-server OAuth) — any member links their OWN account ──────────────
  // See docs/per-member-github-plan.md. Once linked, a run-as session injects THIS member's token as
  // GH_TOKEN so git/PRs are authored as the actual human (not the company bot).
  if (method === 'GET' && p === '/api/github/me') {
    const gh = new GithubIdentity(os);
    // Opening the panel is a good moment to refresh a soon-to-expire token so the next launch is fresh.
    const blob = await gh.ensureFresh(me.id).catch(() => gh.load(me.id));
    // Authorizing (OAuth) and installing the App are TWO separate steps — a token with zero installations
    // is "connected" but can't touch a single repo. Surface the real installation status so the UI can
    // warn instead of showing a false green. Best-effort: on any GitHub hiccup, `install` stays undefined
    // (= "connected, status unknown") rather than a false alarm.
    let install: { installed: boolean; count: number; accounts: string[]; repos: number } | undefined;
    if (blob) {
      const st = await userInstallationStatus(blob.token).catch(() => null);
      if (st && !('error' in st)) install = st;
    }
    // Self-heal the install link: a hand-configured App has no slug from the manifest flow, so resolve it
    // once (from GET /app) whenever the bot creds are present — regardless of install state, so the link is
    // ready both for the not-installed warning AND the admin's "install on more repos" button.
    if (gh.botConfigured() && !gh.appSlug()) {
      await gh.ensureAppSlug(me.email).catch(() => { /* best-effort; the text guidance still shows */ });
    }
    return sendJson(res, 200, { configured: gh.configured(), connected: !!blob, login: blob?.login, expiresAt: blob?.expiresAt, install, installUrl: gh.installUrl() });
  }
  if (method === 'GET' && p === '/api/github/connect') {
    const gh = new GithubIdentity(os);
    if (!gh.configured()) return sendJson(res, 400, { error: 'GitHub is not set up — an owner/admin must add the App client id + secret in Connections → Creds' });
    // Remember where the member started (the profile page or Connections) so the callback returns there.
    const state = newGithubState(os.tenant, me.id, url.searchParams.get('return') || undefined);
    const redirectUrl = gh.authorizeUrl(githubRedirectUri(req), state);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.connect.initiated', data: {} });
    return sendJson(res, 200, { redirectUrl });
  }
  // GitHub redirects the browser here after the member authorizes. The aos_sid cookie rides along
  // (SameSite=Lax allows top-level GET navigation), so `me` is the same member who initiated.
  if (method === 'GET' && p === '/api/github/callback') {
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (url.searchParams.get('error')) return redirect(res, '/#/connectors?github=denied');
    const st = code ? takeGithubState(state, os.tenant, me.id) : null;
    if (!st) return redirect(res, '/#/connectors?github=error');
    const gh = new GithubIdentity(os);
    const r = await gh.completeConnect(me.id, code, githubRedirectUri(req), me.email);
    if ('error' in r) {
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.user.connect_failed', data: { error: r.error } });
      return redirect(res, githubReturnRedirect(st.returnTo, 'error'));
    }
    // Record the login as this member's `github` identity — the queryable, non-secret handle for
    // attribution + the Team page's Chat-IDs row.
    os.team.setIdentity(me.id, 'github', r.login, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.user.connected', data: { login: r.login } });
    return redirect(res, githubReturnRedirect(st.returnTo, 'connected'));
  }
  if (method === 'POST' && p === '/api/github/disconnect') {
    const gh = new GithubIdentity(os);
    const removed = gh.clear(me.id);
    os.team.clearIdentity(me.id, 'github');
    if (removed) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.user.disconnected', data: {} });
    return sendJson(res, 200, { ok: true });
  }
  // ── one-click App setup via GitHub's App-manifest flow (owner/admin) ────────────────────────────
  // Returns the pre-filled manifest + the GitHub form-POST target; the browser posts it, GitHub creates
  // the App and redirects to /manifest-callback with a code we convert into the App's credentials — so
  // the admin never hand-copies a client id/secret or mis-types the callback URL.
  if (method === 'GET' && p === '/api/github/manifest') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const org = (url.searchParams.get('org') || '').trim();
    const state = newGithubState(os.tenant, me.id);
    const postUrl = (org
      ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
      : 'https://github.com/settings/apps/new') + `?state=${encodeURIComponent(state)}`;
    return sendJson(res, 200, { postUrl, manifest: JSON.stringify(githubAppManifest(req, os)) });
  }
  // GitHub redirects here after the admin confirms App creation. Convert the temporary code into the
  // App's credentials and persist them (client id → setting, secret → vault, slug → the install link).
  if (method === 'GET' && p === '/api/github/manifest-callback') {
    if (!isAdmin(me)) return redirect(res, '/#/connectors/creds?github=error');
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    if (!code || !takeGithubState(state, os.tenant, me.id)) return redirect(res, '/#/connectors/creds?github=error');
    const conv = await convertAppManifest(code);
    if ('error' in conv) {
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.app.create_failed', data: { error: conv.error } });
      return redirect(res, '/#/connectors/creds?github=error');
    }
    new GithubIdentity(os).saveApp({ clientId: conv.clientId, clientSecret: conv.clientSecret, slug: conv.slug }, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'github.app.created', data: { slug: conv.slug, appId: conv.appId } });
    return redirect(res, '/#/connectors/creds?github=created');
  }

  // ── memory backend (sqlite / libsql / automem) — owner/admin, applied live without a restart ──
  if (method === 'GET' && p === '/api/settings/memory') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    // Drift: local `memories` rows the ACTIVE backend doesn't have (only meaningful for an external
    // backend — for sqlite the local table IS the store). Drives the migrate-or-clear banner.
    const localCount = Number(os.db.prepare('SELECT count(*) AS n FROM memories WHERE tenant = ?').get<{ n: number }>(os.tenant)?.n ?? 0);
    const external = (os.settings.memoryConfig()?.backend ?? 'sqlite') !== 'sqlite';
    const backendCount = external && os.memory.count ? await os.memory.count(os.tenant) : null;
    // Drift = local rows written BEFORE the current backend became active (the true orphans not in it),
    // anchored to the stable switch horizon rather than a count heuristic. No horizon on record (never
    // switched, or switched pre-feature) → 0, so we never flag/duplicate an already-consistent ledger.
    const horizon = external ? memoryOrphanHorizon(os) : null;
    const drift = horizon != null ? countOrphans(os, horizon) : 0;
    return sendJson(res, 200, { ...memoryView(os), health: await os.memory.health(), localCount, backendCount, drift });
  }
  // Probe a (local) Ollama for the embeddings UI: is it reachable, which models are pulled, and —
  // if unreachable — is the binary at least installed (so we can say "not running" vs "not installed").
  if (method === 'GET' && p === '/api/settings/memory/ollama') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, await probeOllama(url.searchParams.get('url') || 'http://localhost:11434'));
  }
  // Dry-run: build the candidate backend and health-check it WITHOUT swapping the live one.
  if (method === 'POST' && p === '/api/settings/memory/test') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const cfg = buildMemoryConfig(await readBody(req), os.settings.memoryConfig());
      return sendJson(res, 200, { ok: true, health: await os.buildMemory(cfg).health() });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Save: build → hot-swap the live provider → persist. New recall/remember calls use it immediately.
  if (method === 'PUT' && p === '/api/settings/memory') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    let cfg: MemoryConfig;
    try {
      cfg = buildMemoryConfig(await readBody(req), os.settings.memoryConfig());
      os.applyMemory(cfg); // throws on missing required fields → 400 below, before persisting
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
    const prevBackend = os.settings.memoryConfig()?.backend ?? 'sqlite';
    os.settings.setMemoryConfig(cfg, me.email);
    // A real backend TYPE switch resets the orphan horizon (existing local rows are from the OLD store, so
    // they're the ones to migrate up). A same-backend re-save (token/endpoint/ranking edit) must NOT move it,
    // or already-migrated rows would look like orphans again and re-migrate as duplicates.
    if (cfg.backend !== prevBackend) {
      os.settings.stampMemorySwitch(Date.now(), me.email);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'memory.backend.changed', data: { backend: cfg.backend, from: prevBackend } });
    } else {
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'memory.config.updated', data: { backend: cfg.backend } });
    }
    return sendJson(res, 200, { ok: true, ...memoryView(os), health: await os.memory.health() });
  }
  // Run a maintenance pass now (prune + consolidate), using the saved policy. Owner/admin.
  if (method === 'POST' && p === '/api/settings/memory/maintain') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const result = await os.runMemoryMaintenance(me.email);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ── backend-switch reconcile: migrate the local `memories` ledger into the active external store, or
  //    clear it, so the Memory-hub counts stop overstating what agents can actually recall (see
  //    docs/memory-backend-migration-plan.md). Owner/admin. ──
  if (method === 'POST' && p === '/api/settings/memory/migrate') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if ((os.settings.memoryConfig()?.backend ?? 'sqlite') === 'sqlite') {
      return sendJson(res, 400, { error: 'migration applies only when an external backend is active (sqlite IS the local table)' });
    }
    const b = await readBody(req);
    const skipEpisodes = b.skipEpisodes === true;
    const limit = Math.max(1, Math.min(Number(b.limit) || 50, 500)); // rows migrated per batch (progress-friendly)
    // The migration horizon is the STABLE backend-switch timestamp, not a per-run `Date.now()`. Orphans =
    // local rows written before the switch (from the old store, absent from the current one). This makes the
    // loop resume-safe across a closed tab / stray double-click: each migrated orphan is deleted and
    // re-mirrored with created_at = now (≥ horizon, so it leaves the orphan set), and rows agents write
    // post-switch are ≥ horizon too — so a fresh call can never re-migrate an already-moved row (no
    // duplicates) nor falsely report "done" while true orphans remain.
    const horizon = memoryOrphanHorizon(os);
    if (horizon == null) {
      return sendJson(res, 200, { ok: true, done: true, migrated: 0, skipped: 0, remaining: 0, note: 'no backend-switch on record — nothing to migrate' });
    }
    if (countOrphans(os, horizon) === 0) {
      return sendJson(res, 200, { ok: true, done: true, migrated: 0, skipped: 0, remaining: 0, note: 'already consistent — nothing to migrate' });
    }
    // Pre-flight the backend so a doomed batch fails FAST with an actionable message instead of a partial
    // `store failed after 0 migrated` (catches a token automem's public /health can't — see AutomemProvider).
    const h = await os.memory.health();
    if (!h.ok) return sendJson(res, 503, { error: `backend not ready — ${h.detail ?? 'health check failed'}. Fix it in Settings → Memory, then migrate.` });
    // One batch of the oldest orphans. Delete each as we go (migrated → re-mirrored with a new id/created_at;
    // skipped episode → simply dropped), so it won't resurface next batch.
    const rows = os.db
      .prepare('SELECT id, agent_id, content, tags, type, importance, metadata, scope FROM memories WHERE tenant = ? AND created_at < ? ORDER BY created_at, id LIMIT ?')
      .all<{ id: string; agent_id: string; content: string; tags: string | null; type: string | null; importance: number | null; metadata: string | null; scope: string }>(os.tenant, horizon, limit);
    const del = os.db.prepare('DELETE FROM memories WHERE tenant = ? AND id = ?');
    let migrated = 0, skipped = 0;
    for (const r of rows) {
      if (skipEpisodes && (r.tags ?? '').includes('"episode"')) { del.run(os.tenant, r.id); skipped++; continue; }
      try {
        await os.memory.store({
          tenant: os.tenant, agentId: r.agent_id, content: r.content,
          tags: parseTags(r.tags), type: (r.type as MemoryType) ?? undefined,
          importance: r.importance ?? undefined,
          metadata: r.metadata ? safeJson(r.metadata) : undefined,
          scope: r.scope === 'tenant' ? 'tenant' : 'agent',
        });
      } catch (e) {
        // Stop cleanly: this orphan stays put (not deleted). A retry (same horizon) resumes from here.
        const raw = e instanceof Error ? e.message : String(e);
        // A 401 here is the backend rejecting our token (automem's /health is unauthenticated, so a bad token
        // passes the Test/health check and only bites on this first write) — point the operator at the fix.
        const hint = raw.includes('→ 401') ? ' — backend rejected the token; check the token in Settings → Memory' : '';
        return sendJson(res, 500, { error: `store failed after ${migrated} migrated: ${raw}${hint}`, migrated, skipped, remaining: countOrphans(os, horizon) });
      }
      del.run(os.tenant, r.id); migrated++;
    }
    const remaining = countOrphans(os, horizon);
    const done = remaining === 0;
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'memory.migrated', data: { backend: os.settings.memoryConfig()?.backend, migrated, skipped, remaining, done } });
    return sendJson(res, 200, { ok: true, done, migrated, skipped, remaining });
  }
  if (method === 'POST' && p === '/api/settings/memory/clear') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const cleared = Number(os.db.prepare('SELECT count(*) AS n FROM memories WHERE tenant = ?').get<{ n: number }>(os.tenant)?.n ?? 0);
    os.db.prepare('DELETE FROM memories WHERE tenant = ?').run(os.tenant);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'memory.cleared', data: { count: cleared } });
    return sendJson(res, 200, { ok: true, cleared });
  }

  // ── skills (the global Claude Code Skills library, materialised into claude-code agents) ──
  //    Owner/admin only — skills package HOW agents work. By default a skill reaches EVERY agent at
  //    launch; assign it to specific agents via PUT /api/skills/:name/agents (the skill_assignments
  //    table). Hand-authored per-agent skills are still just files in the agent's folder (Files page).
  if (method === 'PUT' && /^\/api\/skills\/([\w.-]+)\/agents$/.test(p)) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const name = p.match(/^\/api\/skills\/([\w.-]+)\/agents$/)![1];
    if (!os.skills.get(name)) return sendJson(res, 404, { error: 'skill not found' });
    const b = await readBody(req);
    const agents = Array.isArray(b.agents) ? b.agents.map((a: unknown) => String(a)) : [];
    os.skills.setAssignment(name, agents);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.assigned', data: { skill: name, agents } });
    return sendJson(res, 200, { ok: true, skill: os.skills.get(name) });
  }
  if (method === 'GET' && p === '/api/skills') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { enabled: os.skills.enabled, skills: os.skills.list() });
  }
  // Publish a proposed skill (drop its `.aos-proposed` marker → it materialises to agents next launch).
  // Owner/admin only. Dismiss reuses DELETE /api/skills/:name (removes the draft folder outright).
  if (method === 'POST' && /^\/api\/skills\/([\w.-]+)\/publish$/.test(p)) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const name = p.match(/^\/api\/skills\/([\w.-]+)\/publish$/)![1];
    // Capture the proposing agent BEFORE publish drops the `.aos-proposed` marker (which clears `proposal`).
    const proposer = os.skills.get(name)?.proposal?.agent;
    const ok = os.skills.publish(name);
    if (!ok) return sendJson(res, 404, { error: 'no such proposed skill' });
    // Same-session delivery (mirrors the skill_request approve path): if the proposing agent has a live
    // interactive session, materialise the now-published skill into it + `/reload-skills` instead of
    // waiting for next launch. Bounded to the proposer — a broadcast to the whole fleet would be disruptive.
    const reloaded = proposer ? tm.refreshAgentSkills(proposer).reloaded : 0;
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.published', data: { skill: name, reloaded } });
    return sendJson(res, 200, { ok: true, skill: os.skills.get(name), reloaded });
  }
  // List open agent skill-requests for the Skills page review section (owner/admin).
  if (method === 'GET' && p === '/api/skills/requests') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { requests: tm.openSkillRequests() });
  }
  // Approve an agent's skill.request card (owner/admin): install the requested catalog skill into the
  // library, optionally scope it to just the requesting agent, and mark the card resolved. The install
  // is the human's act — the agent only ever asked. Audited `skill.installed` (source agent-request).
  const skillReqApprove = p.match(/^\/api\/skills\/requests\/([\w.-]+)\/approve$/);
  if (method === 'POST' && skillReqApprove) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'installing skills requires a data home' });
    const card = tm.skillRequestCard(skillReqApprove[1]);
    if (!card) return sendJson(res, 404, { error: 'no such skill request' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this request was already resolved' });
    const b = await readBody(req);
    try {
      // Install from wherever the request pointed: the bundled catalog, or the remote GitHub repo the
      // agent named (owner/repo, resolved to `path` at request time). Idempotent if already installed.
      let s = os.skills.get(card.skill);
      if (!s) {
        if (card.source === 'catalog') {
          s = os.skills.install(card.skill);
        } else {
          const files = await fetchSkill(card.source, card.path, card.skill);
          s = os.skills.installFiles(card.skill, files);
        }
      }
      if (b.scope === 'agent') os.skills.setAssignment(s.name, [card.agent]); // else stays all-agents
      tm.setSkillRequestStatus(skillReqApprove[1], 'approved');
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.installed', data: { skill: s.name, source: 'agent-request', from: card.source, requestedBy: card.agent, scope: b.scope === 'agent' ? 'agent' : 'all' } });
      // Phase 3: if the requesting agent has a live interactive session, deliver the skill NOW
      // (materialise into its watched .claude/skills + `/reload-skills`) instead of waiting for next launch.
      const { reloaded } = tm.refreshAgentSkills(card.agent);
      return sendJson(res, 200, { ok: true, skill: s, reloaded });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Dismiss an agent's skill.request card (owner/admin) without installing — marks it resolved.
  const skillReqReject = p.match(/^\/api\/skills\/requests\/([\w.-]+)\/dismiss$/);
  if (method === 'POST' && skillReqReject) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const card = tm.skillRequestCard(skillReqReject[1]);
    if (!card) return sendJson(res, 404, { error: 'no such skill request' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this request was already resolved' });
    tm.setSkillRequestStatus(skillReqReject[1], 'rejected');
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.request.dismissed', data: { skill: card.skill, requestedBy: card.agent } });
    return sendJson(res, 200, { ok: true });
  }
  // Duplicate an installed skill under a new name — a deep copy (markers stripped, assignments reset
  // to all-agents). Owner/admin only. MUST precede the generic /api/skills/:name route (the trailing
  // /duplicate keeps them distinct, but keep it grouped with the other sub-path routes).
  const skillDup = p.match(/^\/api\/skills\/([\w.-]+)\/duplicate$/);
  if (method === 'POST' && skillDup) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'duplicating skills requires a data home' });
    const from = skillDup[1];
    const b = await readBody(req);
    try {
      const s = os.skills.duplicate(from, String(b.name ?? ''));
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.duplicated', data: { skill: s.name, from } });
      return sendJson(res, 200, { ok: true, skill: s });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // The bundled catalog — skills that ship with the software, installable into this tenant's library.
  // MUST precede the generic /api/skills/:name route below (else "catalog" reads as a skill name).
  if (method === 'GET' && p === '/api/skills/catalog') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { catalog: os.skills.catalog() });
  }
  const installMatch = p.match(/^\/api\/skills\/catalog\/([\w.-]+)\/install$/);
  if (method === 'POST' && installMatch) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'installing skills requires a data home' });
    try {
      const s = os.skills.install(installMatch[1]);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.installed', data: { skill: s.name, source: 'catalog' } });
      return sendJson(res, 200, { ok: true, skill: s });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ── remote sources: install skills straight from a public GitHub repo (covers skills.sh too) ──
  if (method === 'GET' && p === '/api/skills/sources') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { presets: PRESET_SOURCES });
  }
  // skills.sh directory search — across every indexed repo (a hit installs via the route below).
  if (method === 'GET' && p === '/api/skills/sources/search') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return sendJson(res, 200, { query: '', hits: [] });
    try {
      const hits = await searchSkillsh(q);
      const have = new Set(os.skills.list().map((s) => s.name));
      return sendJson(res, 200, { query: q, hits: hits.map((h) => ({ ...h, installed: have.has(h.name.toLowerCase()) })) });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (method === 'GET' && p === '/api/skills/sources/browse') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const repo = url.searchParams.get('repo') || '';
    if (!repo.trim()) return sendJson(res, 400, { error: 'repo is required (owner/repo)' });
    try {
      const cat = await browseRepo(repo);
      const have = new Set(os.skills.list().map((s) => s.name));
      const skills = cat.skills.map((s) => ({ ...s, installed: have.has(s.name) }));
      return sendJson(res, 200, { ...cat, skills });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (method === 'POST' && p === '/api/skills/sources/install') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'installing skills requires a data home' });
    const b = await readBody(req);
    const repo = String(b.repo ?? '');
    const skillPath = String(b.path ?? '');
    const name = String(b.name ?? (skillPath.split('/').pop() || ''));
    if (!repo.trim()) return sendJson(res, 400, { error: 'repo is required' });
    try {
      const files = await fetchSkill(repo, skillPath, name);
      const s = os.skills.installFiles(name, files);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.installed', data: { skill: s.name, source: repo } });
      return sendJson(res, 200, { ok: true, skill: s });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (method === 'POST' && p === '/api/skills') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'creating skills requires a data home' });
    const b = await readBody(req);
    try {
      const s = os.skills.create({ name: String(b.name ?? ''), description: String(b.description ?? ''), content: b.content !== undefined ? String(b.content) : undefined });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.created', data: { skill: s.name } });
      return sendJson(res, 200, { ok: true, skill: s });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Drag-and-drop / "Upload skill" — install one or more skills from an uploaded .zip. Raw zip bytes
  // in the body; optional `?name=` (the dropped filename) seeds the name for a root-level SKILL.md.
  if (method === 'POST' && p === '/api/skills/upload') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.skills.enabled) return sendJson(res, 400, { error: 'installing skills requires a data home' });
    const buf = await readRawBuffer(req);
    if (buf.length === 0) return sendJson(res, 400, { error: 'empty upload' });
    try {
      const fallbackName = path.basename(url.searchParams.get('name') || '');
      const extracted = extractSkillsFromZip(buf, fallbackName);
      const installed = extracted.map((e) => os.skills.installFiles(e.name, e.files));
      for (const s of installed) {
        os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.installed', data: { skill: s.name, source: 'upload' } });
      }
      return sendJson(res, 200, { ok: true, skills: installed });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const skillMatch = p.match(/^\/api\/skills\/([\w.-]+)$/);
  if (skillMatch && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const name = skillMatch[1];
    if (method === 'GET') {
      const s = os.skills.get(name);
      return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: 'skill not found' });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const s = os.skills.save(name, String(b.content ?? ''));
      if (!s) return sendJson(res, 404, { error: 'skill not found' });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.updated', data: { skill: name, bytes: String(b.content ?? '').length } });
      return sendJson(res, 200, { ok: true, skill: s });
    }
    // DELETE — also the "dismiss" action for a proposal (drops the draft folder). Audit the intent.
    const wasProposed = !!os.skills.get(name)?.proposed;
    const ok = os.skills.remove(name);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: wasProposed ? 'skill.proposal.dismissed' : 'skill.deleted', data: { skill: name } });
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'skill not found' });
  }

  // ── file browser — owner/admin, strictly contained to the data home ──────────────
  //    Every path is resolved under os.paths.home and rejected (lexically AND after
  //    symlink resolution) if it escapes it. View + edit + save only — no create/delete.
  if (p.startsWith('/api/files/')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const root = os.paths?.home;
    if (!root) return sendJson(res, 400, { error: 'no data home configured' });

    if (method === 'GET' && p === '/api/files/list') {
      const dir = safeResolve(root, url.searchParams.get('path') || '');
      if (!dir) return sendJson(res, 400, { error: 'path escapes the data home' });
      let st: fs.Stats;
      try { st = fs.statSync(dir); } catch { return sendJson(res, 404, { error: 'not found' }); }
      if (!st.isDirectory()) return sendJson(res, 400, { error: 'not a directory' });
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
        let size = 0;
        try { if (d.isFile()) size = fs.statSync(path.join(dir, d.name)).size; } catch { /* unreadable — leave 0 */ }
        return { name: d.name, type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other', size };
      }).sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
      return sendJson(res, 200, { root, path: relOf(root, dir), entries });
    }

    if (method === 'GET' && p === '/api/files/read') {
      const file = safeResolve(root, url.searchParams.get('path') || '');
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
      if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
      if (st.size > 2_000_000) return sendJson(res, 200, { path: relOf(root, file), size: st.size, tooLarge: true });
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) return sendJson(res, 200, { path: relOf(root, file), size: st.size, binary: true });
      return sendJson(res, 200, { path: relOf(root, file), size: st.size, content: buf.toString('utf8') });
    }

    if (method === 'PUT' && p === '/api/files/write') {
      const b = await readBody(req);
      const file = safeResolve(root, String(b.path ?? ''));
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'file not found (creating files is disabled)' }); }
      if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
      const content = String(b.content ?? '');
      fs.writeFileSync(file, content);
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'file.edited', data: { path: relOf(root, file), bytes: content.length } });
      return sendJson(res, 200, { ok: true });
    }

    // Download any file as an attachment (streams raw bytes; binaries included).
    if (method === 'GET' && p === '/api/files/download') {
      const file = safeResolve(root, url.searchParams.get('path') || '');
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
      if (!st.isFile()) return sendJson(res, 400, { error: 'not a file' });
      const stream = fs.createReadStream(file);
      stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read failed' }); else res.end(); });
      res.writeHead(200, {
        'content-type': mime(file),
        'content-length': String(st.size),
        'content-disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"`,
      });
      stream.pipe(res);
      return;
    }

    // Upload (create/overwrite a file). Raw bytes in the body; target dir in `path`, name in `name`.
    // Folder upload: pass `rel` = the file's path WITHIN the dropped folder (its browser
    // `webkitRelativePath`, e.g. `runbooks/escalation.md`); intermediate directories are created so a
    // whole nested tree lands in one call-per-file. `rel` wins over `name` when present; each segment is
    // sanitised and the resolved target is re-checked against the home so it can't escape.
    if (method === 'POST' && p === '/api/files/upload') {
      const dirRel = url.searchParams.get('path') || '';
      const rawRel = url.searchParams.get('rel') || '';
      // Sanitise into safe segments (drop '', '.', '..'); `rel` may carry subdirs, `name` never does.
      const segs = (rawRel || url.searchParams.get('name') || '')
        .split('/').map((s) => s.trim()).filter((s) => s && s !== '.' && s !== '..');
      if (segs.length === 0) return sendJson(res, 400, { error: 'invalid file name' });
      const dir = safeResolve(root, dirRel);
      if (!dir) return sendJson(res, 400, { error: 'path escapes the data home' });
      try { if (!fs.statSync(dir).isDirectory()) return sendJson(res, 400, { error: 'not a directory' }); }
      catch { return sendJson(res, 404, { error: 'directory not found' }); }
      const file = safeResolve(root, [dirRel, ...segs].filter(Boolean).join('/'));
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      const buf = await readRawBuffer(req);
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); }
      catch (e) { return sendJson(res, 500, { error: `write failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'file.uploaded', data: { path: relOf(root, file), bytes: buf.length } });
      return sendJson(res, 200, { ok: true, path: relOf(root, file) });
    }

    // Create a new (empty, or seeded) file. Refuses to clobber an existing path.
    if (method === 'POST' && p === '/api/files/create') {
      const b = await readBody(req);
      const file = safeResolve(root, String(b.path ?? ''));
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      const rel = relOf(root, file);
      if (rel === '') return sendJson(res, 400, { error: 'invalid file name' });
      if (fs.existsSync(file)) return sendJson(res, 409, { error: 'a file or folder already exists here' });
      const parent = path.dirname(file);
      try { if (!fs.statSync(parent).isDirectory()) return sendJson(res, 400, { error: 'parent is not a directory' }); }
      catch { return sendJson(res, 404, { error: 'directory not found' }); }
      const content = String(b.content ?? '');
      try { fs.writeFileSync(file, content, { flag: 'wx' }); }
      catch (e) { return sendJson(res, 500, { error: `create failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'file.created', data: { path: rel, bytes: content.length } });
      return sendJson(res, 200, { ok: true, path: rel });
    }

    // Create a folder (recursive; no-op if it already exists).
    if (method === 'POST' && p === '/api/files/mkdir') {
      const b = await readBody(req);
      const dir = safeResolve(root, String(b.path ?? ''));
      if (!dir) return sendJson(res, 400, { error: 'path escapes the data home' });
      if (relOf(root, dir) === '') return sendJson(res, 400, { error: 'invalid folder' });
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) { return sendJson(res, 500, { error: `mkdir failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'folder.created', data: { path: relOf(root, dir) } });
      return sendJson(res, 200, { ok: true, path: relOf(root, dir) });
    }

    // Delete a file or folder (folders recursively). Refuses to delete the home root.
    if (method === 'DELETE' && p === '/api/files/delete') {
      const target = safeResolve(root, url.searchParams.get('path') || '');
      if (!target) return sendJson(res, 400, { error: 'path escapes the data home' });
      const rel = relOf(root, target);
      if (rel === '') return sendJson(res, 400, { error: 'refusing to delete the data home root' });
      let st: fs.Stats;
      try { st = fs.statSync(target); } catch { return sendJson(res, 404, { error: 'not found' }); }
      try { fs.rmSync(target, { recursive: st.isDirectory(), force: true }); }
      catch (e) { return sendJson(res, 500, { error: `delete failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: st.isDirectory() ? 'folder.deleted' : 'file.deleted', data: { path: rel } });
      return sendJson(res, 200, { ok: true });
    }

    // Rename / move within the home.
    if (method === 'POST' && p === '/api/files/rename') {
      const b = await readBody(req);
      const from = safeResolve(root, String(b.from ?? ''));
      const to = safeResolve(root, String(b.to ?? ''));
      if (!from || !to) return sendJson(res, 400, { error: 'path escapes the data home' });
      if (relOf(root, from) === '') return sendJson(res, 400, { error: 'invalid source' });
      try { if (fs.existsSync(from) === false) return sendJson(res, 404, { error: 'not found' }); } catch { /* noop */ }
      if (fs.existsSync(to)) return sendJson(res, 409, { error: 'destination already exists' });
      try { fs.renameSync(from, to); }
      catch (e) { return sendJson(res, 500, { error: `rename failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'file.renamed', data: { from: relOf(root, from), to: relOf(root, to) } });
      return sendJson(res, 200, { ok: true, path: relOf(root, to) });
    }

    return sendJson(res, 404, { error: 'unknown files route' });
  }

  // ── apps (hosted apps — the console management surface) ───────────────────────
  //    Owner/admin only: an App runs server-side code, so who can create/edit/publish/delete one is a
  //    privileged action (the publish step is the code-review gate). Reads include live runtime status
  //    from the supervisor. See docs/apps-plan.md.
  if (method === 'GET' && p === '/api/apps') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const apps = os.apps.list().map((a) => appView(a, appSup));
    return sendJson(res, 200, { apps, enabled: os.apps.enabled });
  }
  if (method === 'POST' && p === '/api/apps') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.apps.enabled) return sendJson(res, 400, { error: 'hosting apps requires a data home' });
    const b = await readBody(req);
    const id = String(b.id || '').trim().toLowerCase();
    const name = String(b.name || '').trim() || id;
    if (!isValidAppSlug(id)) return sendJson(res, 400, { error: 'id must be a DNS-safe slug: lowercase letters, digits and single hyphens (1–32 chars)' });
    if (os.apps.get(id)) return sendJson(res, 400, { error: `an app named "${id}" already exists` });
    try {
      const m = os.apps.scaffold(id, { name, icon: b.icon !== undefined ? String(b.icon) : undefined, owner: me.email, createdBy: me.email, capabilities: b.capabilities });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.created', data: { app: id, by: me.email } });
      return sendJson(res, 200, { ok: true, app: appView(m, appSup) });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const appMatch = p.match(/^\/api\/apps\/([a-z0-9-]+)$/);
  if (appMatch) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const slug = appMatch[1];
    const app = os.apps.get(slug);
    if (!app) return sendJson(res, 404, { error: 'no such app' });
    if (method === 'GET') {
      // Return the manifest, the file tree, the entry source (for the editor's initial file), a tail of
      // the run log, + live status.
      const files = os.apps.listFiles(slug);
      let source = '';
      try { source = fs.readFileSync(path.join(app.dir!, app.entry), 'utf8'); } catch { /* new/renamed entry */ }
      let log = '';
      try { log = fs.readFileSync(path.join(app.dir!, 'app.log'), 'utf8').split('\n').slice(-200).join('\n'); } catch { /* no log yet */ }
      // Which DECLARED secrets currently resolve to a stored value (metadata only, never the value) — so
      // the Settings tab can show set/unset per key.
      const secretsSet = (app.capabilities.secrets ?? []).filter((k) => os.secrets.getSync(os.tenant, `app:${slug}`, k) !== undefined);
      return sendJson(res, 200, { app: appView(app, appSup), files, source, log, secretsSet });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'icon', 'lifecycle'] as const) if (b[k] !== undefined) patch[k] = b[k];
      if (b.idleTimeoutSec !== undefined) patch.idleTimeoutSec = Number(b.idleTimeoutSec);
      if (b.capabilities !== undefined) patch.capabilities = b.capabilities;
      if (b.domains !== undefined) {
        const wanted = sanitizeAppDomains(b.domains);
        // Reject a host that would shadow the console (base domain / tenant subdomain / localhost / IP)
        // or one already bound to a DIFFERENT app in this tenant (a domain maps to exactly one app).
        const reserved = wanted.filter((d) => currentRegistry?.isReservedDomain(d));
        if (reserved.length) return sendJson(res, 400, { error: `these hosts are reserved and can't be used: ${reserved.join(', ')}` });
        const taken = os.apps.list().filter((a) => a.id !== slug).flatMap((a) => a.domains ?? []);
        const clash = wanted.filter((d) => taken.includes(d));
        if (clash.length) return sendJson(res, 400, { error: `already bound to another app: ${clash.join(', ')}` });
        patch.domains = wanted;
      }
      const saved = os.apps.save(slug, patch) ?? app;
      if (typeof b.source === 'string') { try { fs.writeFileSync(path.join(app.dir!, saved.entry), String(b.source)); } catch (e) { return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) }); } }
      // A manifest/source change to a live app takes effect on the next cold-start — bounce it.
      if (app.published) appSup?.kill(slug, 'edited via console');
      if (b.domains !== undefined) { currentRegistry?.invalidateAppDomains(); os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.domains.set', data: { app: slug, domains: saved.domains ?? [], by: me.email } }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.updated', data: { app: slug, by: me.email } });
      return sendJson(res, 200, { ok: true, app: appView(os.apps.get(slug)!, appSup) });
    }
    if (method === 'DELETE') {
      appSup?.kill(slug, 'deleted');
      os.apps.remove(slug);
      if ((app.domains ?? []).length) currentRegistry?.invalidateAppDomains();
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.deleted', data: { app: slug, by: me.email } });
      return sendJson(res, 200, { ok: true });
    }
  }
  // Per-app source files (multi-file authoring): list the tree, read/write/delete one file. Owner/admin.
  // The store sandboxes every path under the app folder and protects the manifest + runtime state.
  const appFiles = p.match(/^\/api\/apps\/([a-z0-9-]+)\/files$/);
  if (method === 'GET' && appFiles) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!os.apps.get(appFiles[1])) return sendJson(res, 404, { error: 'no such app' });
    return sendJson(res, 200, { files: os.apps.listFiles(appFiles[1]) });
  }
  const appFile = p.match(/^\/api\/apps\/([a-z0-9-]+)\/file$/);
  if (appFile) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const slug = appFile[1];
    const app = os.apps.get(slug);
    if (!app) return sendJson(res, 404, { error: 'no such app' });
    if (method === 'GET') {
      const rel = String(url.searchParams.get('path') || '');
      const content = os.apps.readFile(slug, rel);
      if (content === null) return sendJson(res, 404, { error: 'no such file' });
      return sendJson(res, 200, { path: rel, content });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const rel = String(b.path || '');
      if (!os.apps.writeFile(slug, rel, typeof b.content === 'string' ? b.content : '')) return sendJson(res, 400, { error: 'invalid or protected path' });
      if (app.published) appSup?.kill(slug, 'file edited via console'); // bounce so the change shows next open
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.file.written', data: { app: slug, path: rel, by: me.email } });
      return sendJson(res, 200, { ok: true, files: os.apps.listFiles(slug) });
    }
    if (method === 'DELETE') {
      const rel = String(url.searchParams.get('path') || '');
      if (!os.apps.deleteFile(slug, rel)) return sendJson(res, 400, { error: 'cannot delete (missing, protected, or the entry file)' });
      if (app.published) appSup?.kill(slug, 'file deleted via console');
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.file.deleted', data: { app: slug, path: rel, by: me.email } });
      return sendJson(res, 200, { ok: true, files: os.apps.listFiles(slug) });
    }
  }
  // Store/clear a value for one of an app's declared secrets (owner/admin), sealed under `app:<slug>` in
  // the vault. Write-only: the value is never returned or audited, only the key. The app reads it via
  // launch injection or /api/app/secret/get.
  const appSecret = p.match(/^\/api\/apps\/([a-z0-9-]+)\/secret$/);
  if (appSecret) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const slug = appSecret[1];
    const app = os.apps.get(slug);
    if (!app) return sendJson(res, 404, { error: 'no such app' });
    if (method === 'PUT') {
      const b = await readBody(req);
      const key = String(b.key || '').trim();
      const value = b.value != null ? String(b.value) : '';
      if (!key) return sendJson(res, 400, { error: 'key is required' });
      if (!value) return sendJson(res, 400, { error: 'value is required' });
      os.secrets.set(os.tenant, key, value, { principal: `app:${slug}`, updatedBy: me.email });
      if (app.published) appSup?.kill(slug, 'secret changed'); // bounce so injection picks up the new value
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.secret.set', data: { app: slug, key, by: me.email } });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      const key = String(url.searchParams.get('key') || '').trim();
      if (!key) return sendJson(res, 400, { error: 'key is required' });
      os.secrets.delete(os.tenant, key, `app:${slug}`);
      if (app.published) appSup?.kill(slug, 'secret cleared');
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'app.secret.cleared', data: { app: slug, key, by: me.email } });
      return sendJson(res, 200, { ok: true });
    }
  }
  const appPub = p.match(/^\/api\/apps\/([a-z0-9-]+)\/(publish|unpublish|stop)$/);
  if (method === 'POST' && appPub) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const [, slug, action] = appPub;
    if (!os.apps.get(slug)) return sendJson(res, 404, { error: 'no such app' });
    if (action === 'stop') { appSup?.kill(slug, 'stopped via console'); return sendJson(res, 200, { ok: true }); }
    const published = action === 'publish';
    os.apps.setPublished(slug, published);
    if (!published) appSup?.kill(slug, 'unpublished');
    // Publish state gates which domains are live (only published apps route by Host) → refresh the index.
    if ((os.apps.get(slug)?.domains ?? []).length) currentRegistry?.invalidateAppDomains();
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: published ? 'app.published' : 'app.unpublished', data: { app: slug, by: me.email } });
    return sendJson(res, 200, { ok: true, app: appView(os.apps.get(slug)!, appSup) });
  }

  // ── artifacts (the deliverables gallery) ──────────────────────────────────────
  //    Any member, but scoped exactly like the inbox: owner/admin see all; a member sees only
  //    artifacts from sessions they spawned (or an automation they created). Unlike the raw file
  //    browser this exposes only curated, published deliverables — never the whole data home.
  if (method === 'GET' && p === '/api/artifacts') {
    // A member sees an artifact if it's from a session they own (provenance) OR it's shared with the
    // whole tenant. The public share TOKEN is a credential, not display data — surface it (and the
    // resolved link) only to whoever may manage sharing (owner/admin/producer); everyone else gets a
    // plain `public` boolean so the UI can badge it without leaking the URL.
    const visible = os.artifacts.list().filter((a) => tm.canViewSpawn(a.source ?? null, me) || a.sharedTeam);
    const shaped = visible.map((a) => {
      const mine = isAdmin(me) || a.source === me.id;
      return {
        ...a,
        public: !!a.shareToken,
        shareToken: mine ? a.shareToken : undefined,
        shareExpiresAt: mine ? a.shareExpiresAt : undefined,
        shareUrl: mine && a.shareToken ? sharedLinkFor(req, a.shareToken) : undefined,
      };
    });
    return sendJson(res, 200, { artifacts: shaped, enabled: os.artifacts.enabled });
  }
  const artRawMatch = p.match(/^\/api\/artifacts\/([\w-]+)\/raw$/);
  if (method === 'GET' && artRawMatch) {
    const a = os.artifacts.get(artRawMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!tm.canViewSpawn(a.source ?? null, me) && !a.sharedTeam) return sendJson(res, 403, { error: 'forbidden' });
    const resolved = os.artifacts.readPath(a.id, url.searchParams.get('file') || undefined);
    if (!resolved) return sendJson(res, 404, { error: 'file not found' });
    return streamArtifactFile(req, res, resolved);
  }
  const artMatch = p.match(/^\/api\/artifacts\/([\w-]+)$/);
  // Move an artifact into a folder ('' = root). Same gate as delete: owner/admin, or the member whose
  // session produced it. Auto-apply + audited (`artifact.moved`) — folders are organizing metadata.
  if (method === 'PATCH' && artMatch) {
    const a = os.artifacts.get(artMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!isAdmin(me) && a.source !== me.id) return sendJson(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    const folder = String(b.folder ?? '');
    os.artifacts.move(a.id, folder);
    const moved = os.artifacts.get(a.id);
    os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: me.email, type: 'artifact.moved', data: { id: a.id, from: a.folder, to: moved?.folder ?? '' } });
    return sendJson(res, 200, { ok: true, artifact: moved });
  }
  if (method === 'DELETE' && artMatch) {
    const a = os.artifacts.get(artMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    // Owner/admin delete any; a member may delete only their own session's artifacts.
    if (!isAdmin(me) && a.source !== me.id) return sendJson(res, 403, { error: 'forbidden' });
    os.artifacts.remove(a.id);
    os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: me.email, type: 'artifact.deleted', data: { id: a.id, filename: a.filename } });
    return sendJson(res, 200, { ok: true });
  }
  // Share an artifact beyond its producer — same gate as move/delete (owner/admin, or the producing
  // member). `team` toggles whole-tenant Library visibility; `public` mints/revokes the login-free
  // `/shared/<token>` link. Either field is optional; only the ones present are applied. Auto-apply +
  // audited (`artifact.shared`). Returns the updated artifact incl. the resolved public link (if any).
  const artShareMatch = p.match(/^\/api\/artifacts\/([\w-]+)\/share$/);
  if (method === 'POST' && artShareMatch) {
    const a = os.artifacts.get(artShareMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!isAdmin(me) && a.source !== me.id) return sendJson(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    if (typeof b.team === 'boolean') os.artifacts.setTeamShared(a.id, b.team);
    if (typeof b.public === 'boolean') os.artifacts.setPublic(a.id, b.public);
    const updated = os.artifacts.get(a.id)!;
    os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: me.email, type: 'artifact.shared', data: { id: a.id, team: updated.sharedTeam, public: !!updated.shareToken } });
    return sendJson(res, 200, { ok: true, artifact: { ...updated, public: !!updated.shareToken, shareUrl: updated.shareToken ? sharedLinkFor(req, updated.shareToken) : undefined } });
  }
  // Edit a TEXT/markdown deliverable's content in place — human curation of a published artifact. Same
  // gate as move/delete/share (owner/admin, or the producing member). The store refuses non-text mimes.
  // Auto-apply + audited (`artifact.edited`); the snapshot id-dir/filename are unchanged so links persist.
  const artContentMatch = p.match(/^\/api\/artifacts\/([\w-]+)\/content$/);
  if (method === 'PUT' && artContentMatch) {
    const a = os.artifacts.get(artContentMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!isAdmin(me) && a.source !== me.id) return sendJson(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    if (typeof b.content !== 'string') return sendJson(res, 400, { error: 'content (string) required' });
    const r = os.artifacts.writeContent(a.id, b.content);
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: me.email, type: 'artifact.edited', data: { id: a.id, filename: a.filename, bytes: r.artifact.bytes, was: a.bytes } });
    return sendJson(res, 200, { ok: true, artifact: r.artifact });
  }

  // ── policy (the risk ruleset). Read: owner/admin. Edit: OWNER only — it governs what needs
  //    approval, so an admin must not be able to downgrade a red rule to bypass owner sign-off. ──
  if (method === 'GET' && p === '/api/policy') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (!(os.policy instanceof JsonPolicyEngine)) return sendJson(res, 200, { editable: false, id: os.policy.id });
    return sendJson(res, 200, { editable: true, document: os.policy.document, canEdit: me.role === 'owner' });
  }
  if (method === 'PUT' && p === '/api/policy') {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    if (!(os.policy instanceof JsonPolicyEngine)) return sendJson(res, 400, { error: 'active policy engine is not editable' });
    const b = await readBody(req);
    const err = validatePolicyDocument(b.document);
    if (err) return sendJson(res, 400, { error: err });
    const doc = b.document as PolicyDocument;
    os.applyPolicyDocument(doc, me.email, 'edited in the console'); // snapshot + persist + hot reload
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.updated', data: { id: doc.id, rules: doc.rules.length } });
    return sendJson(res, 200, { ok: true, document: os.policy.document });
  }
  // Agent policy proposals — the owner-approved fine-tuning path (tighten-only). Review list is owner/admin;
  // approve/reject/revert are OWNER only (same guard as PUT /api/policy — an admin may see but not rewrite).
  if (method === 'GET' && p === '/api/policy/proposals') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { proposals: tm.openPolicyProposals(), canApply: me.role === 'owner' });
  }
  const propApprove = p.match(/^\/api\/policy\/proposals\/([\w.-]+)\/approve$/);
  if (method === 'POST' && propApprove) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required — applying a policy change is an owner act' });
    if (!(os.policy instanceof JsonPolicyEngine)) return sendJson(res, 400, { error: 'active policy engine is not editable' });
    const card = tm.policyProposalCard(propApprove[1]);
    if (!card) return sendJson(res, 404, { error: 'no such policy proposal' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this proposal was already resolved' });
    // Re-evaluate against the CURRENT doc (it may have changed since the proposal was filed) so we never
    // apply a stale delta, and the tighten-only guarantee is re-checked at apply time.
    const thresholds = os.settings.governanceThresholds() as unknown as Record<string, number>;
    const result = applyProposal(os.policy.document, card.delta, thresholds);
    if ('error' in result) return sendJson(res, 400, { error: `can't apply — the policy changed since this was proposed (${result.error}). Ask the agent to re-propose.` });
    const rev = os.applyPolicyDocument(result.doc, me.email, `approved ${card.agent}'s proposal: ${card.preview ?? card.delta.kind}`);
    tm.setPolicyProposalStatus(propApprove[1], 'approved');
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.proposal.approved', data: { by: me.email, agent: card.agent, kind: card.delta.kind, capability: card.delta.match.capability, preview: card.preview, rev } });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.updated', data: { id: result.doc.id, rules: result.doc.rules.length } });
    return sendJson(res, 200, { ok: true, rev, document: os.policy.document });
  }
  const propReject = p.match(/^\/api\/policy\/proposals\/([\w.-]+)\/reject$/);
  if (method === 'POST' && propReject) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const card = tm.policyProposalCard(propReject[1]);
    if (!card) return sendJson(res, 404, { error: 'no such policy proposal' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this proposal was already resolved' });
    const b = await readBody(req);
    tm.setPolicyProposalStatus(propReject[1], 'rejected');
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.proposal.rejected', data: { by: me.email, agent: card.agent, kind: card.delta.kind, capability: card.delta.match.capability, note: b.note ? String(b.note) : undefined } });
    return sendJson(res, 200, { ok: true });
  }
  // Policy revision history + one-click revert (owner). Every edit path (console, always-approve, approved
  // proposal) snapshots here, so a bad change rolls back to any prior full document.
  if (method === 'GET' && p === '/api/policy/revisions') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { revisions: os.policyRevisions.list(), canRevert: me.role === 'owner' });
  }
  const polRevert = p.match(/^\/api\/policy\/revisions\/(\d+)\/revert$/);
  if (method === 'POST' && polRevert) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    if (!(os.policy instanceof JsonPolicyEngine)) return sendJson(res, 400, { error: 'active policy engine is not editable' });
    const target = os.policyRevisions.get(Number(polRevert[1]));
    if (!target) return sendJson(res, 404, { error: 'no such revision' });
    const rev = os.applyPolicyDocument(target.document, me.email, `reverted to rev ${target.rev}`);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.reverted', data: { to: target.rev, rev, id: target.document.id } });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.updated', data: { id: target.document.id, rules: target.document.rules.length } });
    return sendJson(res, 200, { ok: true, rev, document: os.policy.document });
  }

  // ── connectors (user-registered MCP servers: Slack / Gmail / GitHub / …) ─────
  // Live Composio connections (read from composio.dev): the member's own apps + the company entity's.
  if (method === 'GET' && p === '/api/connections') {
    const key = os.settings.composioApiKey();
    if (!key) return sendJson(res, 200, { keySet: false, company: [], mine: [] });
    const [company, mine] = await Promise.all([
      listConnectedAccounts(key, serviceUserId(os.tenant)),
      listConnectedAccounts(key, me.email),
    ]);
    return sendJson(res, 200, { keySet: true, company, mine, me: me.email, companyEntity: serviceUserId(os.tenant) });
  }
  // Read-only company-integration overview (any member): what's wired at the COMPANY level —
  // Composio company apps, the native Slack app, and org-scoped custom MCP servers. No secrets, just
  // names + status, so everyone can see what their agents have access to without editing rights.
  if (method === 'GET' && p === '/api/integrations/overview') {
    const key = os.settings.composioApiKey();
    const apps = key ? await listConnectedAccounts(key, serviceUserId(os.tenant)) : [];
    const slackMeta = os.settings.slackMeta();
    return sendJson(res, 200, {
      composio: {
        keySet: !!key,
        entity: serviceUserId(os.tenant),
        apps: apps.map((a) => ({ id: a.id, toolkit: a.toolkit, status: a.status })),
      },
      slack: {
        configured: os.settings.slackConfigured(),
        connected: slack ? slack.status().connected : false,
        botUserId: slack ? slack.status().botUserId : '',
      },
      discord: {
        configured: os.settings.discordConfigured(),
        connected: discord ? discord.status().connected : false,
        botUserId: discord ? discord.status().botUserId : '',
      },
      custom: os.connectors
        .list()
        .filter((c) => c.scope === 'org')
        .map((c) => ({ label: c.label, type: c.type, enabled: c.enabled })),
    });
  }
  // The full Composio toolkit catalog (cached) for the connect autocomplete. Any member; needs a key.
  if (method === 'GET' && p === '/api/composio/toolkits') {
    const key = os.settings.composioApiKey();
    const toolkits = key ? await listToolkits(key) : [];
    return sendJson(res, 200, { toolkits });
  }
  // Initiate connecting an app via Composio → returns a hosted OAuth link to complete.
  // COMPANY scope (service entity) is owner/admin-only; personal scope is the member's own.
  if (method === 'POST' && p === '/api/connections/connect') {
    const b = await readBody(req);
    const toolkit = String(b.toolkit || '').trim().toLowerCase();
    const scope = b.scope === 'personal' ? 'personal' : 'company';
    if (!toolkit) return sendJson(res, 400, { error: 'toolkit is required' });
    if (scope === 'company' && !isAdmin(me)) return sendJson(res, 403, { error: 'only an owner or admin can add company connections' });
    const key = os.settings.composioApiKey();
    if (!key) return sendJson(res, 400, { error: 'set a Composio API key in Settings → Integrations first' });
    const userId = scope === 'company' ? serviceUserId(os.tenant) : me.email;
    const r = await initiateConnection(key, userId, toolkit);
    if ('error' in r) return sendJson(res, 502, { error: r.error });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'connector.connect', data: { toolkit, scope, userId } });
    return sendJson(res, 200, { redirectUrl: r.redirectUrl });
  }
  // Disconnect a Composio connected account. COMPANY scope is owner/admin-only; PERSONAL is the
  // member's own. We verify the id actually belongs to that entity before deleting, so a member can
  // never disconnect a company account (or someone else's) by guessing an id.
  if (method === 'POST' && p === '/api/connections/disconnect') {
    const b = await readBody(req);
    const id = String(b.id || '').trim();
    const scope = b.scope === 'personal' ? 'personal' : 'company';
    if (!id) return sendJson(res, 400, { error: 'id is required' });
    if (scope === 'company' && !isAdmin(me)) return sendJson(res, 403, { error: 'only an owner or admin can disconnect a company app' });
    const key = os.settings.composioApiKey();
    if (!key) return sendJson(res, 400, { error: 'no Composio API key' });
    const entity = scope === 'company' ? serviceUserId(os.tenant) : me.email;
    const owned = await listConnectedAccounts(key, entity);
    if (!owned.some((a) => a.id === id)) return sendJson(res, 404, { error: 'connection not found for this scope' });
    const r = await deleteConnectedAccount(key, id);
    if ('error' in r) return sendJson(res, 502, { error: r.error });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'connector.disconnect', data: { id, scope, entity } });
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/api/connectors') {
    return sendJson(res, 200, {
      // A member sees every company (org) connector + their own personal ones; owner/admin see all.
      connectors: os.connectors.listForConsole(me.id, isAdmin(me)).map(redact),
      catalog: CATALOG,
      // Native capabilities are the built-in, hand-written governed effects (the hybrid side).
      native: os.registry.list().map((c) => ({ id: c.id, description: c.description, defaultRisk: c.defaultRisk })),
    });
  }
  if (method === 'POST' && p === '/api/connectors') {
    const b = await readBody(req);
    if (!b.type) return sendJson(res, 400, { error: 'type is required' });
    const type = String(b.type);
    // Company (org) connectors are owner/admin-managed; personal ones any member adds for themselves.
    const scope = b.scope === 'personal' ? 'personal' : 'org';
    if (scope === 'org' && !isAdmin(me)) return sendJson(res, 403, { error: 'only an owner or admin can add a company connector' });

    // A non-admin adding a PERSONAL connector may only instantiate a known catalog template
    // (Slack/Gmail/GitHub/Drive/Composio) with their OWN credentials — never a free-form `custom`
    // command/url, and never an override of the template's command/args/transport. Otherwise a
    // member could run an arbitrary local command under the shared service account (which holds the
    // owner's Claude creds, the DB, and every session's tokens). So for them we take only the
    // credential fields (env/headers) and derive the rest from the template. Admins keep full control.
    const memberControlled = scope === 'personal' && !isAdmin(me);
    if (memberControlled && !CATALOG.some((t) => t.type === type && t.type !== 'custom' && t.type !== 'custom-remote')) {
      return sendJson(res, 403, { error: 'you can only add connectors from the catalog (Slack, Gmail, GitHub, Drive, Composio)' });
    }
    try {
      const created = os.connectors.add({
        type,
        label: b.label ? String(b.label) : undefined,
        description: b.description ? String(b.description) : undefined,
        // For member-controlled connectors, command/args/url/transport come from the catalog template
        // (add() fills them) — only credentials are accepted from the client.
        transport: memberControlled ? undefined : (b.transport === 'http' || b.transport === 'sse' || b.transport === 'stdio' ? b.transport : undefined),
        command: memberControlled ? undefined : (b.command ? String(b.command) : undefined),
        args: memberControlled ? undefined : (Array.isArray(b.args) ? b.args.map(String) : undefined),
        url: memberControlled ? undefined : (b.url ? String(b.url) : undefined),
        headers: b.headers && typeof b.headers === 'object' ? b.headers : undefined,
        env: b.env && typeof b.env === 'object' ? b.env : undefined,
        // The owner is always the caller — never trust a client-supplied owner id.
        scope,
        ownerMemberId: scope === 'personal' ? me.id : undefined,
      });
      return sendJson(res, 200, redact(created));
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const connMatch = p.match(/^\/api\/connectors\/([\w-]+)$/);
  if (connMatch) {
    const id = connMatch[1];
    if (method === 'DELETE' || method === 'PATCH') {
      const c = os.connectors.get(id);
      if (!c) return sendJson(res, 404, { error: 'not found' });
      // Org connectors: owner/admin only. Personal: the owner, or an owner/admin (oversight).
      const canManage = isAdmin(me) || (c.scope === 'personal' && c.ownerMemberId === me.id);
      if (!canManage) return sendJson(res, 403, { error: 'not allowed to manage this connector' });
    }
    if (method === 'DELETE') {
      const ok = os.connectors.remove(id);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      // Share/un-share a personal connector with the team (owner or admin, enforced by canManage above).
      if (typeof b.shared === 'boolean') {
        const c = os.connectors.get(id);
        if (c && c.scope !== 'personal') return sendJson(res, 400, { error: 'only personal connectors can be shared' });
        const updated = os.connectors.setShared(id, b.shared);
        if (updated) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'connector.shared', data: { connector: id, shared: b.shared } });
        return sendJson(res, updated ? 200 : 404, updated ? redact(updated) : { error: 'not found' });
      }
      const updated = os.connectors.setEnabled(id, !!b.enabled);
      return sendJson(res, updated ? 200 : 404, updated ? redact(updated) : { error: 'not found' });
    }
  }

  // ── host connections (Host shape of the access model — docs/host-connections-plan.md, Phase 2a) ──
  // Governed reachable destinations (SSH / internal HTTP / DB). Same org/personal/shared ownership +
  // auth as connectors. The governance that reads these rows is Phase 2b (not wired yet).
  if (method === 'GET' && p === '/api/hosts') {
    return sendJson(res, 200, { hosts: os.hosts.listForConsole(me.id, isAdmin(me)).map(redactHost) });
  }
  if (method === 'POST' && p === '/api/hosts') {
    const b = await readBody(req);
    // Company (org) hosts are owner/admin-managed; personal ones any member adds for themselves.
    const scope = b.scope === 'personal' ? 'personal' : 'org';
    if (scope === 'org' && !isAdmin(me)) return sendJson(res, 403, { error: 'only an owner or admin can add a company host' });
    try {
      const created = os.hosts.add({
        name: b.name ? String(b.name) : '',
        match: b.match ? String(b.match) : '',
        protocol: b.protocol ? (b.protocol as HostProtocol) : undefined,
        credential: b.credential ? String(b.credential) : undefined,
        posture: b.posture ? (b.posture as HostPosture) : undefined,
        // The owner is always the caller — never trust a client-supplied owner id.
        scope,
        ownerMemberId: scope === 'personal' ? me.id : undefined,
      });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'host.added', data: { host: created.id, scope, match: created.match, protocol: created.protocol } });
      return sendJson(res, 200, redactHost(created));
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Publish a proposed host (owner/admin) → active (enabled, no longer proposed). Reject = DELETE.
  const hostPublish = p.match(/^\/api\/hosts\/([\w-]+)\/publish$/);
  if (method === 'POST' && hostPublish) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const id = hostPublish[1];
    const before = os.hosts.get(id);
    if (!before?.proposed) return sendJson(res, 404, { error: 'no such proposed host' });
    const published = os.hosts.publish(id);
    if (published) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'host.published', data: { host: id, match: published.match, protocol: published.protocol, proposedBy: before.proposedBy } });
    return sendJson(res, published ? 200 : 404, published ? redactHost(published) : { error: 'not found' });
  }
  const hostMatch = p.match(/^\/api\/hosts\/([\w-]+)$/);
  if (hostMatch) {
    const id = hostMatch[1];
    const h = os.hosts.get(id);
    if (!h) return sendJson(res, 404, { error: 'not found' });
    // Org hosts: owner/admin only. Personal: the owner, or an owner/admin (oversight). Same as connectors.
    const canManage = isAdmin(me) || (h.scope === 'personal' && h.ownerMemberId === me.id);
    if (!canManage) return sendJson(res, 403, { error: 'not allowed to manage this host' });
    if (method === 'DELETE') {
      const ok = os.hosts.remove(id);
      if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'host.removed', data: { host: id } });
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      try {
        // Share/un-share a personal host with the team.
        if (typeof b.shared === 'boolean') {
          if (h.scope !== 'personal') return sendJson(res, 400, { error: 'only personal hosts can be shared' });
          const updated = os.hosts.setShared(id, b.shared);
          if (updated) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'host.shared', data: { host: id, shared: b.shared } });
          return sendJson(res, updated ? 200 : 404, updated ? redactHost(updated) : { error: 'not found' });
        }
        // Enable/disable.
        if (typeof b.enabled === 'boolean') {
          const updated = os.hosts.setEnabled(id, b.enabled);
          return sendJson(res, updated ? 200 : 404, updated ? redactHost(updated) : { error: 'not found' });
        }
        // Edit fields. A blank credential means "leave as-is" (the browser only ever sees a redacted
        // value, so echoing it back must NOT overwrite the stored secret ref).
        const patch: Record<string, unknown> = {};
        if (typeof b.name === 'string') patch.name = b.name;
        if (typeof b.match === 'string') patch.match = b.match;
        if (typeof b.protocol === 'string') patch.protocol = b.protocol as HostProtocol;
        if (typeof b.posture === 'string') patch.posture = b.posture as HostPosture;
        if (typeof b.credential === 'string' && b.credential.trim() !== '') patch.credential = b.credential;
        const updated = os.hosts.update(id, patch);
        if (updated) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'host.updated', data: { host: id, match: updated.match, protocol: updated.protocol } });
        return sendJson(res, updated ? 200 : 404, updated ? redactHost(updated) : { error: 'not found' });
      } catch (e) {
        return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // ── secrets vault (owner/admin): encrypted-at-rest credentials. Values are NEVER returned ──
  if (method === 'GET' && p === '/api/secrets') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { secrets: os.secrets.list(os.tenant) });
  }
  if (method === 'POST' && p === '/api/secrets') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const key = b.key ? String(b.key).trim() : '';
    const value = b.value != null ? String(b.value) : '';
    if (!key) return sendJson(res, 400, { error: 'key is required' });
    if (!value) return sendJson(res, 400, { error: 'value is required' });
    const principal = b.principal ? String(b.principal).trim() : '*';
    os.secrets.set(os.tenant, key, value, { principal, updatedBy: me.email });
    // Audit the act, never the value.
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.set', data: { secretPrincipal: principal, key } });
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'DELETE' && p === '/api/secrets') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const key = b.key ? String(b.key).trim() : '';
    if (!key) return sendJson(res, 400, { error: 'key is required' });
    const principal = b.principal ? String(b.principal).trim() : '*';
    const ok = os.secrets.delete(os.tenant, key, principal);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.deleted', data: { secretPrincipal: principal, key } });
    return sendJson(res, ok ? 200 : 404, { ok });
  }
  // Assign a secret to agents — each assigned agent gets it as a shell env var at launch (the inverse
  // view of a manifest's `shellSecrets`). Full-set replace, like PUT /api/skills/:name/agents. Unknown
  // agent ids are dropped (the picker only offers real ones). Injection only — never a read grant.
  if (method === 'PUT' && p === '/api/secrets/agents') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const key = b.key ? String(b.key).trim() : '';
    if (!key) return sendJson(res, 400, { error: 'key is required' });
    const principal = b.principal ? String(b.principal).trim() : '*';
    const known = new Set(os.agents.keys());
    const agents = Array.isArray(b.agents)
      ? b.agents.map((a: unknown) => String(a).trim()).filter((a: string) => known.has(a))
      : [];
    os.secrets.setAssignedAgents(os.tenant, principal, key, agents);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.assigned', data: { secretPrincipal: principal, key, agents } });
    return sendJson(res, 200, { ok: true, agents });
  }
  // List open agent secret-requests for the Secrets settings review section (owner/admin). Each is an
  // agent that ran `secret_request`, tagged `mode`: 'provide' (the key isn't in the vault — a human must
  // enter a value) or 'access' (the key exists but the agent can't read it — a human grants access).
  if (method === 'GET' && p === '/api/secrets/requests') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { requests: tm.openSecretRequests() });
  }
  // Fulfill an agent's secret.request card (owner/admin). Two paths keyed by the card's `mode`:
  //  • provide — the human types the value into a secure form (it arrives here, never touching the
  //    session transcript); we seal it into the vault under the chosen principal.
  //  • access — the key already exists under a principal the agent can't read; NO value is typed. We
  //    re-scope the existing sealed value to the requesting agent server-side (read it via the vault,
  //    write a copy under the agent's principal) so it can secret_get — the value is never returned.
  // Either path optionally injects it into the agent's shell at launch. The VALUE is never audited.
  const secretReqFulfill = p.match(/^\/api\/secrets\/requests\/([\w.-]+)\/fulfill$/);
  if (method === 'POST' && secretReqFulfill) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const card = tm.secretRequestCard(secretReqFulfill[1]);
    if (!card) return sendJson(res, 404, { error: 'no such secret request' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this request was already resolved' });
    const b = await readBody(req);
    const inject = b.inject === true || b.inject === 'true';
    if (card.mode === 'access') {
      // Grant access to an EXISTING vault secret: find where it lives (any principal but this agent),
      // resolve its current value inside the process, and copy it under the agent's own principal.
      const src = os.secrets.list(os.tenant).find((s) => s.key === card.key && s.principal !== card.agent);
      if (!src) return sendJson(res, 404, { error: `"${card.key}" is no longer in the vault to grant` });
      const val = os.secrets.getSync(os.tenant, src.principal, card.key);
      if (val === undefined) return sendJson(res, 404, { error: `could not resolve "${card.key}" to grant` });
      const grantRead = b.grantRead !== false && b.grantRead !== 'false'; // default: enable secret_get
      if (grantRead) os.secrets.set(os.tenant, card.key, val, { principal: card.agent, updatedBy: me.email });
      // Inject reads the owner's value at launch — use the agent's fresh copy if we made one, else the source.
      if (inject) os.secrets.setAssignedAgents(os.tenant, grantRead ? card.agent : src.principal, card.key, [card.agent]);
      if (!grantRead && !inject) return sendJson(res, 400, { error: 'grant read access, inject into the shell, or both' });
      tm.setSecretRequestStatus(secretReqFulfill[1], 'fulfilled');
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.request.granted', data: { key: card.key, from: src.principal, grantedTo: card.agent, read: grantRead, injected: inject } });
      return sendJson(res, 200, { ok: true, granted: true, injected: inject });
    }
    // provide mode: a human-entered value seals into the vault.
    const value = b.value != null ? String(b.value) : '';
    if (!value) return sendJson(res, 400, { error: 'value is required' });
    // Default scope: the requesting agent's own principal (only it can secret_get). `*` = tenant-wide.
    const principal = b.principal ? String(b.principal).trim() : card.agent;
    os.secrets.set(os.tenant, card.key, value, { principal, updatedBy: me.email });
    if (inject) os.secrets.setAssignedAgents(os.tenant, principal, card.key, [card.agent]);
    tm.setSecretRequestStatus(secretReqFulfill[1], 'fulfilled');
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.request.fulfilled', data: { key: card.key, secretPrincipal: principal, requestedBy: card.agent, injected: inject } });
    return sendJson(res, 200, { ok: true, injected: inject });
  }
  // Dismiss an agent's secret.request card (owner/admin) without providing — marks it resolved.
  const secretReqReject = p.match(/^\/api\/secrets\/requests\/([\w.-]+)\/dismiss$/);
  if (method === 'POST' && secretReqReject) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const card = tm.secretRequestCard(secretReqReject[1]);
    if (!card) return sendJson(res, 404, { error: 'no such secret request' });
    if (card.status !== 'open') return sendJson(res, 409, { error: 'this request was already resolved' });
    tm.setSecretRequestStatus(secretReqReject[1], 'rejected');
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'secret.request.dismissed', data: { key: card.key, requestedBy: card.agent } });
    return sendJson(res, 200, { ok: true });
  }

  // ── approvals (shared with the console) ──────────────────────────────────────
  // ── audit viewer (owner/admin): the queryable SQLite mirror of the JSONL system-of-record ──
  if (method === 'GET' && p === '/api/audit') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const session = url.searchParams.get('session') || '';
    const type = url.searchParams.get('type') || '';
    const principal = url.searchParams.get('principal') || '';
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 1000));
    const where = ['tenant = ?'];
    const params: unknown[] = [os.tenant];
    if (session) { where.push('run_id = ?'); params.push(session); }
    if (type) { where.push('type LIKE ?'); params.push(type.replace(/[%_]/g, (c) => '\\' + c) + '%'); }
    if (principal) { where.push('principal = ?'); params.push(principal); }
    const rows = os.db
      .prepare(`SELECT id, ts, run_id, type, principal, data FROM audit_events WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all<{ id: number; ts: number; run_id: string; type: string; principal: string | null; data: string }>(...params, limit);
    const events = rows.map((r) => ({ id: r.id, ts: r.ts, runId: r.run_id, type: r.type, principal: r.principal ?? undefined, data: safeJson(r.data) }));
    // Distinct types (capped) for the filter dropdown.
    const types = os.db.prepare('SELECT DISTINCT type FROM audit_events WHERE tenant = ? ORDER BY type LIMIT 200').all<{ type: string }>(os.tenant).map((t) => t.type);
    return sendJson(res, 200, { events, types });
  }
  if (method === 'GET' && p === '/api/approvals') return sendJson(res, 200, os.approvals.pending(os.tenant).filter((a) => tm.canViewSession(a.runId, me)).map(approvalView));
  // "Always approve": approve THIS attempt AND teach the policy an `allow` rule for its capability, so
  // future matching attempts pass the gate without a card. Adding a rule is a POLICY EDIT, so it's
  // OWNER-ONLY — the same guard as PUT /api/policy (an admin can approve once but must not rewrite the
  // ruleset to bypass future owner sign-off). The rule is inserted AFTER all `never` rules, so deny
  // guardrails (destructive / over-cap) stay in force; a capability under an unconditional `never` is
  // refused (approved once, rule not added, with a note). Audited `policy.rule.added` + `policy.updated`.
  const alwaysMatch = p.match(/^\/api\/approvals\/([\w-]+)\/always$/);
  if (method === 'POST' && alwaysMatch) {
    const ap = os.approvals.get(alwaysMatch[1]);
    if (!ap) return sendJson(res, 404, { error: 'approval not found' });
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required — “always approve” edits policy' });
    if (!(os.policy instanceof JsonPolicyEngine)) return sendJson(res, 400, { error: 'active policy engine is not editable' });
    const cap = ap.attempt.capabilityId;
    const result = withAlwaysAllow(os.policy.document, cap);
    // The run is waiting — approve this attempt regardless of whether the durable rule lands.
    os.approvals.resolve(alwaysMatch[1], true, me.email);
    if ('error' in result) return sendJson(res, 200, { ok: true, ruleAdded: false, note: result.error });
    if (result.added) {
      os.applyPolicyDocument(result.doc, me.email, `always-approve ${cap}`); // snapshot + persist + hot reload
      os.audit.append({ ts: Date.now(), runId: ap.runId, tenant: os.tenant, principal: me.email, type: 'policy.rule.added', data: { capability: cap, effect: 'allow', from: 'inbox.always_approve' } });
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.updated', data: { id: result.doc.id, rules: result.doc.rules.length } });
    }
    return sendJson(res, 200, { ok: true, ruleAdded: result.added, note: result.added ? undefined : `“${cap}” is already always-allowed` });
  }
  const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
  if (method === 'POST' && apMatch) {
    const ap = os.approvals.get(apMatch[1]);
    if (!ap) return sendJson(res, 404, { error: 'approval not found' });
    if (!os.team.canApprove(me, ap.level)) {
      return sendJson(res, 403, { error: ap.level === 'owner' ? 'owner approval required' : 'owner or admin approval required' });
    }
    const b = await readBody(req);
    os.approvals.resolve(apMatch[1], !!b.approved, me.email);
    return sendJson(res, 200, { ok: true });
  }

  // ── classic mock runs (kept for the demo) ────────────────────────────────────
  if (method === 'GET' && p === '/api/runs') return sendJson(res, 200, os.orchestrator.listRuns().map(runView));
  const runMatch = p.match(/^\/api\/runs\/([\w-]+)$/);
  if (method === 'GET' && runMatch) {
    const run = os.orchestrator.getRun(runMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'run not found' });
    const events = os.memoryAudit.forRun(run.id);
    return sendJson(res, 200, { run: runView(run), events, eval: evaluate(run, events) });
  }

  sendJson(res, 404, { error: 'not found' });
}

function runView(r: Run) {
  return { id: r.id, agent: r.agent.id, status: r.status, outcome: r.outcome, cost: r.cost, createdAt: r.createdAt };
}

/** Parse a stored JSON column, degrading to a `{ raw }` wrapper rather than throwing on bad data. */
function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { value: v }; } catch { return { raw: s }; }
}
/** Resolve the requested inbox scope from `?scope=`. Only owner/admin may see the `all` oversight view;
 *  a member is always pinned to `mine` (they can't see others' cards regardless, so this just keeps the
 *  contract explicit). Default = `mine` — the un-flooded personal feed. */
function inboxScope(url: URL, me: Member): 'mine' | 'all' {
  const want = url.searchParams.get('scope');
  if (want === 'all' && (me.role === 'owner' || me.role === 'admin')) return 'all';
  return 'mine';
}
/** Parse a stored `tags` JSON column into a string[] (empty on null/garbage). */
function parseTags(s: string | null): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function approvalView(a: ApprovalRequest) {
  return { id: a.id, runId: a.runId, level: a.level, capability: a.attempt.capabilityId, args: a.attempt.args, reason: a.reason };
}
/** The console view of a hosted app: its manifest fields + the supervisor's live runtime status. */
function appView(a: AppManifest, appSup?: AppSupervisor) {
  const st = appSup?.statusOf(a.id) ?? { status: 'cold' as const };
  return {
    id: a.id, name: a.name, icon: a.icon, entry: a.entry, lifecycle: a.lifecycle,
    idleTimeoutSec: a.idleTimeoutSec, capabilities: a.capabilities, owner: a.owner,
    createdBy: a.createdBy, published: !!a.published, domains: a.domains ?? [], version: a.version,
    status: st.status, uptimeMs: st.uptimeMs, lastError: st.lastError,
  };
}
/** Strip the webhook secret for non-admins; give admins the ready-to-paste hook URL instead. */
function automationView(a: Automation, req: http.IncomingMessage, admin: boolean, canManage = true) {
  const { secret, ...rest } = a;
  return {
    ...rest,
    hookUrl: admin && a.type === 'webhook' && secret ? hookUrlFor(req, a.id, secret) : undefined,
    // When it fires next: an enabled cron computes its next matching minute; a pending one-shot carries
    // its scheduled runAt. Event triggers (webhook/slack/discord) have no schedule, so it stays absent.
    nextRunAt: nextRunAtFor(a),
    // Whether THIS caller may delete/edit it — mirrors the server-side guard so the console can hide the
    // controls (owner override, else creator-only). Machine-created ones (`agent:`/`automation`) → owner-only.
    canManage,
  };
}
/** Server-side ownership guard for automations: owner manages any (break-glass); everyone else only their
 *  own. Shared by the DELETE/PATCH gate and the list view's `canManage` flag so UI and API never diverge. */
function canManageAuto(me: Member, a: Automation): boolean {
  return me.role === 'owner' || a.createdBy === me.id;
}
function nextRunAtFor(a: Automation): number | undefined {
  if (!a.enabled) return undefined;
  if (a.type === 'cron' && a.schedule) {
    try { return nextCronRun(a.schedule) ?? undefined; } catch { return undefined; }
  }
  if (a.type === 'once' && a.runAt) return a.runAt;
  return undefined;
}
function hookUrlFor(req: http.IncomingMessage, id: string, secret: string): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}/hooks/${id}?key=${secret}`;
}

/** The public login-free URL for an artifact's share token — same host/proto derivation as invite links. */
function sharedLinkFor(req: http.IncomingMessage, token: string): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}/shared/${token}`;
}

/**
 * Stream an artifact file to the response with inline disposition and byte-range support. Shared by the
 * authenticated console raw route and the public `/shared/<token>` route — <video>/<audio> scrubbing
 * (and Safari playback at all) depends on 206 Partial Content, and it keeps large downloads resumable.
 */
function streamArtifactFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  resolved: { absPath: string; mime: string; filename: string },
  opts: { sandbox?: boolean } = {},
): void {
  let total: number;
  try { total = fs.statSync(resolved.absPath).size; } catch { return sendJson(res, 404, { error: 'file not found' }); }
  const disposition = `inline; filename="${resolved.filename.replace(/"/g, '')}"`;
  // Public-share hardening: the file is served as a TOP-LEVEL document on the app's own origin, so an
  // HTML/SVG artifact would otherwise run script with real same-origin privileges (cookies, /api). The
  // console dodges this by rendering HTML in an iframe sandboxed WITHOUT allow-same-origin; we reproduce
  // that for the public route with `Content-Security-Policy: sandbox` (an opaque origin — scripts run but
  // can't read cookies or call same-origin APIs), plus nosniff so a mislabeled file can't be sniffed into
  // executable HTML. Rendering of images/pdf/video/markdown/text is unaffected.
  const extra: Record<string, string> = opts.sandbox
    ? { 'content-security-policy': 'sandbox allow-scripts allow-popups allow-forms allow-downloads', 'x-content-type-options': 'nosniff' }
    : {};
  const range = req.headers['range'];
  const m = typeof range === 'string' ? range.match(/^bytes=(\d*)-(\d*)$/) : null;
  if (m && (m[1] || m[2]) && total > 0) {
    let start = m[1] ? parseInt(m[1], 10) : NaN;
    let end = m[2] ? parseInt(m[2], 10) : NaN;
    if (Number.isNaN(start)) { start = total - end; end = total - 1; }   // suffix range: bytes=-N
    else if (Number.isNaN(end)) end = total - 1;                          // open range:   bytes=N-
    if (start > end || start < 0 || start >= total) {
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    const stream = fs.createReadStream(resolved.absPath, { start, end });
    stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read failed' }); else res.end(); });
    res.writeHead(206, {
      'content-type': resolved.mime,
      'content-disposition': disposition,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...extra,
    });
    stream.pipe(res);
    return;
  }
  const stream = fs.createReadStream(resolved.absPath);
  stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read failed' }); else res.end(); });
  res.writeHead(200, {
    'content-type': resolved.mime,
    'content-disposition': disposition,
    'accept-ranges': 'bytes',
    'content-length': total,
    ...extra,
  });
  stream.pipe(res);
}

// ── auth helpers ─────────────────────────────────────────────────────────────
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds — matches the DB session TTL
function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(sid: string): string {
  return `aos_sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}
function clearCookie(): string {
  return 'aos_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
function memberFor(os: AgentOS, req: http.IncomingMessage): Member | undefined {
  return os.team.resolveSession(parseCookies(req)['aos_sid'] || '');
}

// In-memory throttle for the public /api/auth/request-link route: at most LINK_REQ_MAX attempts per
// key (email OR client IP) within LINK_REQ_WINDOW_MS. Bounds link-minting + DM spam and slows any
// enumeration-by-timing. Process-local (fine — this is a per-tenant single process); resets on restart.
const LINK_REQ_WINDOW_MS = 15 * 60 * 1000;
const LINK_REQ_MAX = 3;
const linkReqHits = new Map<string, number[]>();
function allowLinkRequest(email: string, req: http.IncomingMessage): boolean {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  let ok = true;
  for (const key of [`e:${email}`, `ip:${ip}`]) {
    if (!key.slice(2)) continue; // skip an empty ip
    const hits = (linkReqHits.get(key) || []).filter((t) => now - t < LINK_REQ_WINDOW_MS);
    if (hits.length >= LINK_REQ_MAX) ok = false;
    hits.push(now);
    linkReqHits.set(key, hits);
  }
  return ok;
}

// ── per-member GitHub OAuth state (Phase 2 — docs/per-member-github-plan.md) ───
// The single-use CSRF `state` for the browser round-trip. Held in-process (the OAuth hop is seconds;
// a restart mid-flow just makes the member retry). Keyed by the random state string, so it's safe
// across tenants; we still bind {tenant, memberId} and re-check them at the callback.
const GH_STATE_TTL_MS = 10 * 60 * 1000;
const githubOauthStates = new Map<string, { tenant: string; memberId: string; exp: number; returnTo?: string }>();
function newGithubState(tenant: string, memberId: string, returnTo?: string): string {
  const state = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  // Opportunistically evict expired entries so the map can't grow unbounded.
  for (const [k, v] of githubOauthStates) if (v.exp < now) githubOauthStates.delete(k);
  githubOauthStates.set(state, { tenant, memberId, exp: now + GH_STATE_TTL_MS, returnTo });
  return state;
}
/** Consume a state (single-use): returns the stored entry only if present, unexpired, and bound to
 *  this tenant + member; else null. */
function takeGithubState(state: string, tenant: string, memberId: string): { returnTo?: string } | null {
  const hit = githubOauthStates.get(state);
  if (!hit) return null;
  githubOauthStates.delete(state);
  if (hit.exp >= Date.now() && hit.tenant === tenant && hit.memberId === memberId) return { returnTo: hit.returnTo };
  return null;
}
/** Build a post-OAuth redirect to a SAFE in-app hash route (open-redirect guard), tagged with the flag. */
function githubReturnRedirect(returnTo: string | undefined, flag: string): string {
  const safe = returnTo && /^#\/[\w/-]*$/.test(returnTo) ? returnTo : '#/connectors';
  return `/${safe}?github=${flag}`;
}
/** This server's public origin (`proto://host`), honouring an nginx/Tailscale X-Forwarded-Proto/Host. */
function publicOrigin(req: http.IncomingMessage): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1').split(',')[0];
  return `${proto}://${host}`;
}
/** The absolute OAuth callback URL, honouring an nginx X-Forwarded-Proto/Host in front of us. */
function githubRedirectUri(req: http.IncomingMessage): string {
  return `${publicOrigin(req)}/api/github/callback`;
}
/**
 * The GitHub App **manifest** we hand to the one-click create flow — pre-fills everything the
 * per-member OAuth path needs so the admin can't misconfigure it: our callback + manifest-redirect URLs,
 * least-privilege repo permissions (Contents + Pull requests write, Metadata read), no webhook, and no
 * OAuth-on-install (we run the per-member OAuth separately). Private app, installable org-wide.
 * See docs/per-member-github-plan.md.
 */
function githubAppManifest(req: http.IncomingMessage, os: AgentOS): Record<string, unknown> {
  const origin = publicOrigin(req);
  // NB: do NOT include `hook_attributes` — GitHub requires `hook_attributes.url` whenever the object is
  // present (even with `active:false`), so sending `{active:false}` makes GitHub reject the whole manifest
  // with "url wasn't supplied". Omitting it entirely = no webhook, which is exactly what we want.
  return {
    name: `Agent OS — ${os.tenantName}`,
    url: origin,
    redirect_url: `${origin}/api/github/manifest-callback`,
    callback_urls: [`${origin}/api/github/callback`],
    setup_on_update: false,
    request_oauth_on_install: false,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  };
}

// ── per-member terminal reverse proxy (Phase A, flag on) ───────────────────────
/** Extract `<space>` from `/terminal/<space>/…` (query stripped). null if it doesn't match. */
function terminalSpace(rawUrl: string | undefined): string | null {
  const pathOnly = (rawUrl || '/').split('?')[0];
  const m = pathOnly.match(/^\/terminal\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : null;
}
/** Resolve the cookie → member and the path → member's ttyd port, enforcing attach authz. */
function terminalTarget(os: AgentOS, tm: TerminalManager, req: http.IncomingMessage): { port: number } | { error: number } {
  const me = memberFor(os, req);
  if (!me) return { error: 401 };
  const space = terminalSpace(req.url);
  if (!space) return { error: 404 };
  const port = tm.proxyPortFor(space, me);
  return port ? { port } : { error: 403 };
}
/** Proxy a normal HTTP request (the ttyd page + its static assets) to a ttyd on `port`. */
function pipeHttpToTtyd(port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('terminal upstream unavailable'); });
  req.pipe(up);
}
/** Proxy a ttyd WebSocket upgrade to a ttyd on `port` (hand-rolled — reconstruct the 101 response). */
function pipeUpgradeToTtyd(port: number, req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers });
  up.on('upgrade', (pr, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${pr.statusCode || 101} ${pr.statusMessage || 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(pr.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  up.on('error', () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
}
/** Proxy a normal HTTP request (the ttyd page + its static assets) to the member's ttyd. */
function terminalProxy(os: AgentOS, tm: TerminalManager, req: http.IncomingMessage, res: http.ServerResponse): void {
  const t = terminalTarget(os, tm, req);
  if ('error' in t) return end(res, t.error);
  pipeHttpToTtyd(t.port, req, res);
}
/** Proxy the ttyd WebSocket upgrade to the member's ttyd. */
function terminalUpgrade(os: AgentOS, tm: TerminalManager, req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
  const t = terminalTarget(os, tm, req);
  if ('error' in t) return void socket.destroy();
  pipeUpgradeToTtyd(t.port, req, socket, head);
}

// ── shared-ttyd terminal proxy (flag off / local, no nginx) ──────────────────────
/** Login-gate a request to the single shared ttyd, enforcing per-session attach authz when the
 *  browser targets one (`?arg=aos-<id>`). ttyd's own static assets carry no arg → a valid login is
 *  enough. This is the same check nginx's auth_request performs in production. */
function sharedTerminalAuthz(os: AgentOS, tm: TerminalManager, req: http.IncomingMessage): boolean {
  const me = memberFor(os, req);
  if (!me) return false;
  const arg = new URL(req.url || '/', 'http://localhost').searchParams.get('arg');
  if (!arg) return true; // ttyd asset/probe — no targeted session, so a valid login suffices
  const id = arg.replace(/^aos-/, '');
  return !!tm.sessionAgent(id) && tm.canViewSession(id, me);
}
// ── hosted-app reverse proxy (/apps/<slug>/…) ──────────────────────────────────
/** Extract `<slug>` from `/apps/<slug>` or `/apps/<slug>/…` (query stripped). null if it doesn't match. */
function appSlug(rawUrl: string | undefined): string | null {
  const pathOnly = (rawUrl || '/').split('?')[0];
  const m = pathOnly.match(/^\/apps\/([a-z0-9-]+)(?:\/|$)/);
  return m ? m[1] : null;
}
/** Rewrite `/apps/<slug>/rest?q` → `/rest?q` (the path the app sees). Root `/apps/<slug>` → `/`. */
function appSubPath(rawUrl: string, slug: string): string {
  const [pathPart, query] = rawUrl.split('?');
  let rest = pathPart.slice(`/apps/${slug}`.length);
  if (!rest.startsWith('/')) rest = '/' + rest;
  return query ? `${rest}?${query}` : rest;
}
/** The headers handed to the app: drop hop-by-hop + any client-supplied identity spoof, then inject
 *  the proxy-trusted prefix + who's-logged-in. The app can rely on these being authoritative. */
function appHeaders(headers: http.IncomingHttpHeaders, slug: string, me: Member): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = { ...headers };
  // A client must never be able to forge the identity the app trusts, or the mount prefix.
  for (const k of Object.keys(out)) {
    if (/^x-aos-member$|^x-aos-role$|^x-forwarded-prefix$/i.test(k)) delete out[k];
  }
  out['x-forwarded-prefix'] = `/apps/${slug}`;
  out['x-aos-member'] = me.email;
  out['x-aos-role'] = me.role;
  return out;
}
/** Proxy an HTTP request to a hosted app on `port`, rewriting the path to strip the mount prefix. */
function pipeHttpToApp(port: number, subPath: string, headers: http.IncomingHttpHeaders, req: http.IncomingMessage, res: http.ServerResponse): void {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: subPath, headers }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers);
    pr.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('app upstream unavailable'); });
  req.pipe(up);
}
/** The /apps/<slug> HTTP proxy: login-gate, resolve the app's live port (cold-start if needed), then
 *  pipe with the prefix stripped + identity injected. */
async function appProxy(os: AgentOS, apps: AppSupervisor, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const me = memberFor(os, req);
  if (!me) return end(res, 401);
  const slug = appSlug(req.url);
  if (!slug) return end(res, 404);
  // A proposed (unpublished) app is reachable ONLY by an owner/admin — the pre-publish preview. Everyone
  // else sees a published app only (ensureReady rejects unpublished).
  const allowUnpublished = me.role === 'owner' || me.role === 'admin';
  let port: number;
  try {
    port = await apps.ensureReady(slug, { allowUnpublished });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sendJson(res, /no such app|not published/.test(msg) ? 404 : 502, { error: msg });
  }
  pipeHttpToApp(port, appSubPath(req.url || '/', slug), appHeaders(req.headers, slug, me), req, res);
}
/** Headers for a custom-domain (public) app request: strip any client-supplied identity spoof, mount at
 *  the domain ROOT (empty prefix), and carry NO logged-in member — the app is reached without a console
 *  login, so it's on its own for auth. */
function appDomainHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = { ...headers };
  for (const k of Object.keys(out)) if (/^x-aos-member$|^x-aos-role$|^x-forwarded-prefix$/i.test(k)) delete out[k];
  out['x-forwarded-prefix'] = '';
  return out;
}
/** Serve a bound custom domain: the whole domain maps to one published app at its root, public (no login).
 *  Cold-starts the app if needed. Separate origin from the console → the app can't reach the console. */
async function serveAppDomain(apps: AppSupervisor, slug: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let port: number;
  try { port = await apps.ensureReady(slug); }
  catch (e) { return sendJson(res, /no such app|not published/.test(String(e)) ? 404 : 502, { error: 'app unavailable' }); }
  pipeHttpToApp(port, req.url || '/', appDomainHeaders(req.headers), req, res);
}
/** WebSocket upgrade twin of {@link serveAppDomain}. */
async function serveAppDomainUpgrade(apps: AppSupervisor, slug: string, req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): Promise<void> {
  let port: number;
  try { port = await apps.ensureReady(slug); } catch { return void socket.destroy(); }
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: appDomainHeaders(req.headers) });
  up.on('upgrade', (pr, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${pr.statusCode || 101} ${pr.statusMessage || 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(pr.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket); socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  up.on('error', () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
}
/** The /apps/<slug> WebSocket upgrade proxy — the upgrade twin of {@link appProxy}. */
async function appUpgrade(os: AgentOS, apps: AppSupervisor | undefined, req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): Promise<void> {
  if (!apps) return void socket.destroy();
  const me = memberFor(os, req);
  const slug = appSlug(req.url);
  if (!me || !slug) return void socket.destroy();
  let port: number;
  try { port = await apps.ensureReady(slug); } catch { return void socket.destroy(); }
  const subPath = appSubPath(req.url || '/', slug);
  const headers = appHeaders(req.headers, slug, me);
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: subPath, headers });
  up.on('upgrade', (pr, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${pr.statusCode || 101} ${pr.statusMessage || 'Switching Protocols'}`];
    for (const [k, v] of Object.entries(pr.headers)) {
      if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
      else if (v !== undefined) lines.push(`${k}: ${v}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
  });
  up.on('error', () => socket.destroy());
  if (head && head.length) up.write(head);
  up.end();
}

/** Proxy /terminal/ HTTP to the single shared ttyd (local mode). */
function sharedTerminalProxy(os: AgentOS, tm: TerminalManager, port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!sharedTerminalAuthz(os, tm, req)) return end(res, memberFor(os, req) ? 403 : 401);
  pipeHttpToTtyd(port, req, res);
}
/** Proxy the /terminal/ WebSocket upgrade to the single shared ttyd (local mode). */
function sharedTerminalUpgrade(os: AgentOS, tm: TerminalManager, port: number, req: http.IncomingMessage, socket: import('stream').Duplex, head: Buffer): void {
  if (!(req.url || '').startsWith('/terminal/') || !sharedTerminalAuthz(os, tm, req)) return void socket.destroy();
  pipeUpgradeToTtyd(port, req, socket, head);
}
/** Mask a secret for display: keep only the last 4 chars. '' when unset. */
function redactSecret(v: string): string {
  if (!v) return '';
  return v.length > 4 ? '••••' + v.slice(-4) : '••••';
}
/** The integrations settings view — never returns a raw secret, only set flags + a masked hint. */
function integrationsView(os: AgentOS): {
  composio: { set: boolean; hint: string };
  webhook: { set: boolean };
  slack: { appToken: boolean; botToken: boolean; configured: boolean };
  discord: { botToken: boolean; configured: boolean };
  github: { clientId: boolean; clientSecret: boolean; configured: boolean; slug: string; installUrl: string; appId: boolean; privateKey: boolean; botReady: boolean };
  image: { openRouter: boolean; atlas: boolean; backend: 'openrouter' | 'atlas' | null; defaultModel: string; configured: boolean };
  video: { fal: boolean; atlas: boolean; backend: 'fal' | 'atlas' | null; defaultModel: string; configured: boolean };
  chatRouter: boolean;
  chatIdleTimeoutMin: number;
  updatedAt?: number;
  updatedBy?: string;
} {
  const meta = os.settings.composioMeta();
  const slack = os.settings.slackMeta();
  const discord = os.settings.discordMeta();
  const gh = new GithubIdentity(os);
  const image = os.settings.imageGenMeta();
  const video = os.settings.videoGenMeta();
  return {
    composio: { set: meta.set, hint: redactSecret(os.settings.composioApiKey()) },
    webhook: { set: os.settings.composioWebhookSet() },
    slack: { appToken: slack.appToken, botToken: slack.botToken, configured: os.settings.slackConfigured() },
    discord: { botToken: discord.botToken, configured: os.settings.discordConfigured() },
    github: { clientId: !!gh.clientId(), clientSecret: !!gh.clientSecret(), configured: gh.configured(), slug: gh.appSlug(), installUrl: gh.appSlug() ? `https://github.com/apps/${gh.appSlug()}/installations/new` : '', appId: !!gh.appId(), privateKey: !!gh.privateKey(), botReady: !!gh.loadBotToken() },
    image: { openRouter: image.openRouter, atlas: image.atlas, backend: image.backend, defaultModel: image.defaultModel, configured: os.settings.imageGenConfigured() },
    video: { fal: video.fal, atlas: video.atlas, backend: video.backend, defaultModel: video.defaultModel, configured: os.settings.videoGenConfigured() },
    chatRouter: os.settings.chatRouterEnabled(),
    chatIdleTimeoutMin: os.settings.chatIdleTimeoutMinutes(),
    updatedAt: meta.updatedAt,
    updatedBy: meta.updatedBy,
  };
}

/** Redact an embeddings config for the console (the API key becomes a boolean). */
function embeddingsView(e?: EmbeddingsConfig): EmbeddingsView | undefined {
  return e ? { provider: e.provider ?? 'openai', url: e.url ?? '', model: e.model ?? '', dimensions: e.dimensions, apiKeySet: !!e.apiKey } : undefined;
}
/** Build an embeddings config from a console submission, preserving a blank (unchanged) API key. */
function parseEmbeddings(eb: any, ep?: EmbeddingsConfig): EmbeddingsConfig | undefined {
  if (!eb || eb.enabled === false) return undefined;
  const apiKey = (typeof eb.apiKey === 'string' && eb.apiKey.trim()) || ep?.apiKey || undefined;
  const dimensions = eb.dimensions != null ? Number(eb.dimensions) : ep?.dimensions;
  return {
    provider: eb.provider === 'ollama' ? 'ollama' : 'openai',
    url: String(eb.url ?? ep?.url ?? '').trim(),
    model: String(eb.model ?? ep?.model ?? '').trim(),
    ...(apiKey ? { apiKey } : {}),
    ...(dimensions != null ? { dimensions } : {}),
  };
}

/**
 * The Settings → Memory view: the stored backend config with every secret redacted to a boolean
 * (`…Set`), plus who last changed it. Reflects the saved DB config; when none is saved yet, returns
 * a `sqlite` skeleton (the file default may differ, but the form edits the DB layer).
 */
/**
 * The stable migration horizon: the timestamp the active external backend became active. Local `memories`
 * rows OLDER than this were written under the previous backend and aren't in the current one — the orphans
 * the migrate button copies up. Anchoring to the switch (not a per-run `Date.now()`) is what makes the
 * migration resume-safe. `null` → no switch on record → treat the ledger as already consistent.
 */
function memoryOrphanHorizon(os: AgentOS): number | null {
  return os.settings.memorySwitchedAt() ?? null;
}

/** Count local rows written before `horizon` for this tenant — the un-migrated orphans. */
function countOrphans(os: AgentOS, horizon: number): number {
  return Number(os.db.prepare('SELECT count(*) AS n FROM memories WHERE tenant = ? AND created_at < ?').get<{ n: number }>(os.tenant, horizon)?.n ?? 0);
}

function memoryView(os: AgentOS): MemorySettingsView {
  const cfg = os.settings.memoryConfig() ?? { backend: 'sqlite' as const };
  const view: MemorySettingsView = { backend: cfg.backend, ...os.settings.memoryMeta() };
  if (cfg.sqlite) view.sqlite = { embeddings: embeddingsView(cfg.sqlite.embeddings) };
  if (cfg.libsql) view.libsql = { url: cfg.libsql.url ?? '', authTokenSet: !!cfg.libsql.authToken, embeddings: embeddingsView(cfg.libsql.embeddings) };
  if (cfg.automem) view.automem = { endpoint: cfg.automem.endpoint ?? '', tokenSet: !!cfg.automem.token };
  if (cfg.ranking) view.ranking = { halfLifeDays: cfg.ranking.halfLifeDays, weightByImportance: !!cfg.ranking.weightByImportance, weightByUsage: !!cfg.ranking.weightByUsage };
  if (cfg.maintenance) view.maintenance = { ...cfg.maintenance };
  view.sharedWrites = cfg.sharedWrites === 'curated' ? 'curated' : 'open';
  if (cfg.preload?.enabled) view.preload = { enabled: true, count: cfg.preload.count ?? 8 };
  return view;
}

/** Is an `ollama` executable on the server's PATH? (Best-effort: lets us say "not running" vs "not installed".) */
function ollamaInstalled(): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']);
  return dirs.some((d) => d && fs.existsSync(path.join(d, 'ollama')));
}

/** Probe an Ollama server: reachable? version? which models are pulled? plus the install hint above. */
async function probeOllama(target: string): Promise<{ reachable: boolean; url: string; installed: boolean; version?: string; models?: string[] }> {
  const base = target.replace(/\/$/, '');
  const installed = ollamaInstalled();
  const get = async (pathName: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch(base + pathName, { signal: ctrl.signal });
      return r.ok ? await r.json() : null;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const v = await get('/api/version');
    if (!v) return { reachable: false, url: base, installed };
    const tags = (await get('/api/tags').catch(() => null)) as { models?: { name?: string; model?: string }[] } | null;
    const models = (tags?.models ?? []).map((m) => String(m.name ?? m.model ?? '')).filter(Boolean);
    return { reachable: true, url: base, installed, version: String((v as { version?: string }).version ?? ''), models };
  } catch {
    return { reachable: false, url: base, installed };
  }
}

/**
 * The Atlas catalog, split into the text-to-image and text-to-video model ids the default-model
 * pickers offer (a `{ model, displayName, categories }[]` under `data`). Cached per key for a few
 * minutes so opening Settings doesn't re-hit Atlas each render; a key change misses the cache (keyed
 * by the key itself) and refetches. Best-effort: any failure returns empty lists (the field stays a
 * plain free-text input).
 */
// `priceUsd` is Atlas's effective (post-discount) base price — per image for TEXT-TO-IMAGE, per second
// for TEXT-TO-VIDEO — so the console can show a cost hint next to each model. null when Atlas omits it.
type AtlasModel = { id: string; label: string; priceUsd: number | null };
const atlasModelCache = new Map<string, { at: number; image: AtlasModel[]; video: AtlasModel[] }>();
const ATLAS_MODEL_TTL_MS = 5 * 60 * 1000;
type AtlasPrice = { actual?: { base_price?: string | number }; origin?: { base_price?: string | number } };
function atlasPriceUsd(price?: AtlasPrice): number | null {
  const raw = price?.actual?.base_price ?? price?.origin?.base_price;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}
async function fetchAtlasModels(key: string): Promise<{ image: AtlasModel[]; video: AtlasModel[] }> {
  const cached = atlasModelCache.get(key);
  if (cached && Date.now() - cached.at < ATLAS_MODEL_TTL_MS) return { image: cached.image, video: cached.video };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch('https://api.atlascloud.ai/api/v1/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!r.ok) return cached ? { image: cached.image, video: cached.video } : { image: [], video: [] };
    const body = (await r.json()) as { data?: Array<{ model?: string; displayName?: string; categories?: string[]; price?: AtlasPrice }> };
    const rows = Array.isArray(body?.data) ? body.data : [];
    const pick = (cat: string): AtlasModel[] =>
      rows
        .filter((m) => m.model && Array.isArray(m.categories) && m.categories.includes(cat))
        .map((m) => ({ id: String(m.model), label: String(m.displayName || m.model), priceUsd: atlasPriceUsd(m.price) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    const out = { at: Date.now(), image: pick('TEXT-TO-IMAGE'), video: pick('TEXT-TO-VIDEO') };
    atlasModelCache.set(key, out);
    return { image: out.image, video: out.video };
  } catch {
    return cached ? { image: cached.image, video: cached.video } : { image: [], video: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a console submission into a full MemoryConfig, carrying forward any secret the client left
 * blank (it never sees stored secrets, so a blank field means "unchanged"). `prev` is the currently
 * stored config for the same workspace.
 */
function buildMemoryConfig(body: Record<string, any>, prev: MemoryConfig | null): MemoryConfig {
  const backend = body.backend === 'libsql' || body.backend === 'automem' ? body.backend : 'sqlite';
  let cfg: MemoryConfig;
  if (backend === 'libsql') {
    const b = body.libsql ?? {};
    const p = prev?.backend === 'libsql' ? prev.libsql : undefined;
    cfg = { backend, libsql: { url: String(b.url ?? p?.url ?? '').trim() } };
    const tok = typeof b.authToken === 'string' ? b.authToken.trim() : '';
    if (tok || p?.authToken) cfg.libsql!.authToken = tok || p?.authToken;
    const emb = parseEmbeddings(b.embeddings, p?.embeddings);
    if (emb) cfg.libsql!.embeddings = emb;
  } else if (backend === 'automem') {
    const b = body.automem ?? {};
    const p = prev?.backend === 'automem' ? prev.automem : undefined;
    const token = (typeof b.token === 'string' && b.token.trim()) || p?.token || '';
    cfg = { backend, automem: { endpoint: String(b.endpoint ?? p?.endpoint ?? '').trim(), token } };
  } else {
    const emb = parseEmbeddings(body.sqlite?.embeddings, prev?.sqlite?.embeddings);
    cfg = emb ? { backend: 'sqlite', sqlite: { embeddings: emb } } : { backend: 'sqlite' };
  }
  // Recall ranking + maintenance + shared-write policy are backend-independent — carry them on every config.
  const ranking = parseRanking(body.ranking);
  if (ranking) cfg.ranking = ranking;
  const maintenance = parseMaintenance(body.maintenance);
  if (maintenance) cfg.maintenance = maintenance;
  if (body.sharedWrites === 'curated') cfg.sharedWrites = 'curated';
  const preload = parsePreload(body.preload);
  if (preload) cfg.preload = preload;
  return cfg;
}

/** Parse the launch-time recall-preamble control; undefined unless it's explicitly enabled. */
function parsePreload(pb: any): MemoryPreload | undefined {
  if (!pb || typeof pb !== 'object' || !pb.enabled) return undefined;
  const count = Number(pb.count);
  return { enabled: true, count: Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), 25) : 8 };
}

/** Parse the recall-ranking controls; returns undefined when neither knob is on (→ no re-ranking). */
function parseRanking(rb: any): MemoryRanking | undefined {
  if (!rb || typeof rb !== 'object') return undefined;
  const r: MemoryRanking = {};
  const half = Number(rb.halfLifeDays);
  if (Number.isFinite(half) && half > 0) r.halfLifeDays = half;
  if (rb.weightByImportance) r.weightByImportance = true;
  if (rb.weightByUsage) r.weightByUsage = true;
  return r.halfLifeDays || r.weightByImportance || r.weightByUsage ? r : undefined;
}

/** Parse the maintenance controls; returns undefined unless prune or dedupe is actually enabled. */
function parseMaintenance(mb: any): MemoryMaintenance | undefined {
  if (!mb || typeof mb !== 'object') return undefined;
  const m: MemoryMaintenance = {};
  const after = Number(mb.pruneAfterDays);
  if (Number.isFinite(after) && after > 0) m.pruneAfterDays = after;
  const keep = Number(mb.keepImportance);
  if (Number.isFinite(keep) && keep >= 0 && keep <= 1) m.keepImportance = keep;
  const dq = Number(mb.dedupeThreshold);
  if (Number.isFinite(dq) && dq > 0 && dq <= 1) m.dedupeThreshold = dq;
  const every = Number(mb.everyHours);
  if (Number.isFinite(every) && every > 0) m.everyHours = every;
  return m.pruneAfterDays || m.dedupeThreshold != null ? m : undefined; // keep/every alone don't enable upkeep
}
/** Read the unparsed request body as a string (needed for webhook signature verification). */
function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}
/** Collect the request body as raw bytes (binary-safe — used for file uploads). */
function readRawBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
function isAdmin(m: Member): boolean {
  return m.role === 'owner' || m.role === 'admin';
}
function roleOf(v: unknown): Role | undefined {
  return v === 'owner' || v === 'admin' || v === 'member' ? v : undefined;
}
/** Validate a profile-picture upload: a base64 data-URL of a common image type, size-capped. Returns
 *  an error string, or null when acceptable. ~1.5 MB of base64 ≈ ~1.1 MB of image — the console
 *  resizes to a small square first, so this only guards against a hand-crafted oversized request. */
function validateAvatar(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return 'avatar is required';
  if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return 'avatar must be a base64 image data URL';
  if (v.length > 1_500_000) return 'image too large (max ~1MB)';
  return null;
}
/** Build an absolute magic-link, honouring an nginx X-Forwarded-Proto in front of us. */
function linkFor(req: http.IncomingMessage, token: string): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}/accept?token=${token}`;
}
function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}
function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
/** Black or white — whichever reads better on the given `#rrggbb` background (WCAG relative luminance). */
function readableOn(hex: string): '#000' | '#fff' {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}
/**
 * The interstitial shown by GET /accept. A plain confirm page — no auto-submit — so a link
 * preview / mail-scanner that renders it never consumes the token; only the "Continue" POST does.
 * Self-contained (no app bundle) and theme-aware so it works before the SPA/session exists.
 */
function acceptLandingHtml(email: string, token: string, accent?: string): string {
  const safeEmail = escapeHtml(email);
  const action = `/accept?token=${encodeURIComponent(token)}`;
  // Tenant accent (validated `#rrggbb`): tint the logo chip + Continue button so even the invite
  // interstitial matches the tenant's console colour. Overrides both light + dark defaults.
  const brand = accent && /^#[0-9a-fA-F]{6}$/.test(accent)
    ? `<style>.logo,.card button{background:${accent}!important;color:${readableOn(accent)}!important}
       .card button:hover{filter:brightness(.92)}</style>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in — Agent OS</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f6f7f9; color: #0b0d12; }
  .card { width: 100%; max-width: 380px; background: #fff; border: 1px solid #e6e8ec; border-radius: 14px;
    padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.05); text-align: center; }
  .logo { width: 40px; height: 40px; margin: 0 auto 16px; border-radius: 10px; display: grid; place-items: center;
    background: #0b0d12; color: #fff; font-weight: 700; font-size: 18px; }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { margin: 0 0 20px; color: #5b6470; font-size: 14px; }
  .email { color: #0b0d12; font-weight: 600; }
  button { width: 100%; padding: 11px 16px; border: 0; border-radius: 9px; background: #0b0d12; color: #fff;
    font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #23262e; }
  .foot { margin: 16px 0 0; font-size: 12px; color: #8a94a3; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0d12; color: #f3f5f8; }
    .card { background: #14171d; border-color: #262b33; box-shadow: none; }
    .logo { background: #f3f5f8; color: #0b0d12; }
    .email { color: #f3f5f8; }
    p { color: #9aa4b2; }
    button { background: #f3f5f8; color: #0b0d12; }
    button:hover { background: #dfe3e9; }
  }
</style>${brand}</head>
<body><div class="card">
  <div class="logo">A</div>
  <h1>Sign in to Agent OS</h1>
  <p>You're accepting an invitation as <span class="email">${safeEmail}</span>.</p>
  <form method="POST" action="${action}">
    <button type="submit">Continue</button>
  </form>
  <p class="foot">If this wasn't you, you can safely close this page.</p>
</div></body></html>`;
}

// ── file-browser containment ───────────────────────────────────────────────────
/** The home root, symlinks resolved (falls back to a lexical resolve if it doesn't exist yet). */
function realRootOf(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}
/** Resolve `rel` under `root`, rejecting anything that escapes it — lexically, and (for paths
 *  that exist) again after resolving symlinks, so an in-home symlink can't point outside. */
function safeResolve(root: string, rel: string): string | null {
  const realRoot = realRootOf(root);
  const contained = (pth: string) => pth === realRoot || pth.startsWith(realRoot + path.sep);
  const target = path.resolve(realRoot, rel.replace(/^[/\\]+/, ''));
  if (!contained(target)) return null;
  if (fs.existsSync(target)) {
    let real: string;
    try { real = fs.realpathSync(target); } catch { return target; }
    return contained(real) ? real : null;
  }
  return target;
}
/** Path of `abs` relative to the home root, forward-slashed; '' for the root itself. */
function relOf(root: string, abs: string): string {
  return path.relative(realRootOf(root), abs).split(path.sep).join('/');
}

// ── http helpers ─────────────────────────────────────────────────────────────
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function sendFile(res: http.ServerResponse, file: string, contentType: string): void {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: `file not found: ${path.basename(file)}` });
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });
}
function end(res: http.ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}
function mime(file: string): string {
  const e = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  };
  return map[e] || 'application/octet-stream';
}
function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

if (require.main === module) startServer();
