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
import { AgentOS, loadAgentOS } from './kernel';
import { TenantRegistry, TenantRuntime } from './tenant-registry';
import { exampleCapabilities } from './capabilities/examples';
import { evaluate } from './observability/evaluation';
import { TerminalManager } from './terminal';
import { Automation, Automations } from './edge/automations';
import { SlackSocket } from './edge/slack-socket';
import { DiscordSocket } from './edge/discord-socket';
import { DreamingEngine } from './edge/dreaming';
import { Consolidation } from './edge/consolidation';
import { CATALOG, redact } from './connectors/connectors';
import { listConnectedAccounts, deleteConnectedAccount, listToolkits, serviceUserId, initiateConnection, verifyComposioWebhook, parseComposioEvent } from './connectors/composio';
import { JsonPolicyEngine, PolicyDocument, validatePolicyDocument } from './governance/policy';
import { PRESET_SOURCES, browseRepo, fetchSkill, searchSkillsh } from './governance/skill-registry';
import { extractSkillsFromZip } from './governance/skill-zip';
import { AgentManifest, ApprovalRequest, EmbeddingsConfig, IDENTITY_PROVIDERS, IdentityProvider, Member, MemoryConfig, MemoryMaintenance, MemoryRanking, MemoryType, Role, Run, sanitizeCategory, sanitizeExamplePrompts, sanitizeRuntimeTuning, TaskStatus } from './types';

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
  updatedAt?: number;
  updatedBy?: string;
}

const CONSOLE_HTML = path.resolve(__dirname, '../public/console.html');
const WEB_DIST = path.resolve(__dirname, '../web/dist');

/** Agents available for terminal sessions = whatever manifests this instance loaded.
 *  `deletable` = lives under the data home (user-created), so it can be removed; the bundled
 *  examples that ship with the software are read-only. */
function terminalAgents(os: AgentOS): { id: string; description: string; category?: string; runtime: string; deletable: boolean; model?: string; effort?: string; examplePrompts?: string[] }[] {
  const userRoot = os.paths ? path.resolve(os.paths.userAgents) + path.sep : null;
  return [...os.agents.values()].map((a) => ({
    id: a.id,
    description: a.description,
    // Organisational grouping label (Engineering / Marketing / …); undefined = uncategorised.
    category: a.category,
    runtime: a.runtime,
    deletable: !!userRoot && !!a.dir && (path.resolve(a.dir) + path.sep).startsWith(userRoot),
    // Per-agent runtime tuning (claude-code only) — surfaced so the console can show/edit it.
    model: a.model,
    effort: a.effort,
    // Suggested first tasks for the spawn card (clickable chips that prefill the box).
    examplePrompts: a.examplePrompts,
  }));
}

export function bootstrap(baseDir: string = path.resolve(__dirname, '..')): AgentOS {
  const os = loadAgentOS('config/agent-os.config.json', baseDir);
  os.registerCapabilities(exampleCapabilities);
  return os;
}

/** Phase A: when on, the app reverse-proxies /terminal/<member>/ to that member's own ttyd. */
const UID_ISOLATION = process.env.AOS_UID_ISOLATION === '1';

/** Resolve which tenant runtime a request belongs to: explicit `x-aos-tenant` (loopback agent calls)
 *  wins, else the Host subdomain; no signal → the default tenant. */
function resolveRuntime(registry: TenantRegistry, req: http.IncomingMessage): TenantRuntime | undefined {
  const explicit = String(req.headers['x-aos-tenant'] || '').trim().toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  const slug = explicit || registry.slugForHost(host);
  return slug ? registry.get(slug) : registry.default();
}

export function createHttpServer(registry: TenantRegistry): http.Server {
  const server = http.createServer((req, res) => {
    // Superadmin control plane — host-independent (bearer-gated), so it sits before tenant routing.
    if ((req.url || '').split('?')[0].startsWith('/api/admin/')) {
      handleControl(registry, req, res).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    const rt = resolveRuntime(registry, req);
    if (!rt) return sendJson(res, 404, { error: 'no such workspace' });
    handle(rt.os, rt.tm, rt.autos, req, res, rt.ttydPort, rt.slack, rt.discord).catch((err) =>
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
  // Terminal (ttyd) WebSocket upgrades, routed into the request's tenant runtime. Flag on (Phase A):
  // route to each member's OWN ttyd, authz-checked. Flag off (local, no nginx): the app reverse-proxies
  // that tenant's shared ttyd itself, so the browser terminal is self-contained. In production nginx
  // fronts /terminal/ and the app never receives these upgrades, so the shared branch is inert there.
  server.on('upgrade', (req, socket, head) => {
    const rt = resolveRuntime(registry, req);
    if (!rt) return void socket.destroy();
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
  const reaper = setInterval(() => registry.forEach((rt) => { try { rt.tm.reapIdleSpaces(); } catch { /* never let the sweep crash */ } }), 60_000);
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
    if (everyHours && Date.now() - (lastDream.get(os.tenant) || 0) >= everyHours * 3_600_000) {
      lastDream.set(os.tenant, Date.now());
      void new DreamingEngine(os).dream('scheduler').catch(() => { /* never let the dreamer crash the server */ });
      // Opt-in: after each auto dream pass, spawn the memory-gardener to consolidate new episodes/lessons.
      if (os.settings.consolidateAuto()) {
        void new Consolidation(os, rt.tm).run('automation:consolidation').catch(() => { /* never crash the scheduler */ });
      }
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

async function handle(os: AgentOS, tm: TerminalManager, autos: Automations, req: http.IncomingMessage, res: http.ServerResponse, ttydPort?: number, slack?: SlackSocket, discord?: DiscordSocket): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  // /terminal/ → the ttyd browser terminal. Flag-on (Phase A): proxy to the member's OWN ttyd
  // (/terminal/<space>/…), authz-checked. Flag-off (local, no nginx): proxy the single shared ttyd so
  // the terminal works self-contained, with the same cookie + per-session attach authz nginx enforces.
  if (UID_ISOLATION && p.startsWith('/terminal/')) return terminalProxy(os, tm, req, res);
  if (!UID_ISOLATION && ttydPort && p.startsWith('/terminal/')) return sharedTerminalProxy(os, tm, ttydPort, req, res);

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const idx = path.join(WEB_DIST, 'index.html');
    return sendFile(res, fs.existsSync(idx) ? idx : CONSOLE_HTML, 'text/html; charset=utf-8');
  }
  if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, tenant: os.tenant, name: os.tenantName });
  // static assets from the built React app (web/dist)
  if (method === 'GET' && (p.startsWith('/assets/') || /\.(js|css|svg|png|ico|woff2?|json|map)$/.test(p))) {
    const file = path.join(WEB_DIST, p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, mime(file));
    return end(res, 404);
  }
  if (method === 'GET' && p === '/favicon.ico') return end(res, 204);

  // ── auth: magic-link landing + session introspection (the only PUBLIC /api routes) ──────────
  if (method === 'GET' && p === '/accept') {
    const accepted = os.team.acceptToken(url.searchParams.get('token') || '');
    if (!accepted) return redirect(res, '/?login=invalid');
    res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(accepted.sid) });
    res.end();
    return;
  }
  if (method === 'GET' && p === '/api/auth/me') {
    const m = memberFor(os, req);
    return m ? sendJson(res, 200, { member: m }) : sendJson(res, 401, { error: 'not authenticated' });
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
    return sendJson(res, 200, { policy: os.policy.id, capabilities });
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
    return sendJson(res, 200, { artifacts, enabled: os.artifacts.enabled });
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
    try {
      const a = autos.schedule({ agentId: agent, name: String(b.name || '').trim() || `Scheduled: ${task.slice(0, 40)}`, task, runAt, runAs: tm.sessionRunAs(session), createdBy: 'automation' });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: agent, type: 'automation.scheduled', data: { id: a.id, runAt, agent } });
      return sendJson(res, 200, { ok: true, id: a.id, runAt });
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

  // ask-human: the agent posts a question (→ inbox) and polls until a human answers it.
  if (method === 'POST' && p === '/api/ask') {
    const b = await readBody(req);
    const session = String(b.session || '');
    const agent = tm.sessionAgent(session);
    if (!agent) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const question = String(b.question || '').trim();
    if (!question) return sendJson(res, 400, { error: 'question is required' });
    return sendJson(res, 200, tm.askQuestion(session, agent, question));
  }
  const askMatch = p.match(/^\/api\/ask\/([\w-]+)$/);
  if (method === 'GET' && askMatch) return sendJson(res, 200, tm.questionStatus(askMatch[1]));

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
    const out = tm.publishArtifact(session, { path: filePath, title: String(b.title || ''), description: b.description ? String(b.description) : undefined });
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
  // launcher signal that the claude process exited (→ completion fallback + mark idle).
  if (method === 'POST' && p === '/api/ended') {
    const b = await readBody(req);
    const session = String(b.session || '');
    if (!tm.hasSession(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    tm.markEnded(session);
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
    return sendJson(res, 200, { pages });
  }
  if (method === 'GET' && p === '/api/kb/read') {
    const session = url.searchParams.get('session') || '';
    if (!tm.sessionAgent(session)) return sendJson(res, 404, { error: 'unknown session' });
    if (!sessionSecretOk(session)) return sendJson(res, 403, { error: 'bad session secret' });
    const page = os.kb.read(os.tenant, url.searchParams.get('section') || '', url.searchParams.get('slug') || '');
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
    try {
      // owner defaults to the creating session's run-as member — HUMAN PASSTHROUGH: a task filed by an
      // agent acting as Alice dispatches (later) as Alice too, so accountability ladders to the person.
      const task = os.tasks.create({
        tenant: os.tenant, title, body: b.body !== undefined ? String(b.body) : '',
        assignee: b.assignee === 'me' ? `agent:${agent}` : (typeof b.assignee === 'string' ? b.assignee : undefined),
        owner: tm.sessionRunAs(session),
        priority: typeof b.priority === 'number' ? b.priority : undefined,
        labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
        parentId: typeof b.parentId === 'string' ? b.parentId : undefined,
        mode: b.mode === 'interactive' ? 'interactive' : 'headless',
        autoDispatch: b.autoDispatch === true || b.autoDispatch === 'true',
        createdBy: `agent:${agent}`,
      });
      os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: 'task.created', data: { id: task.id, title: task.title, assignee: task.assignee ?? null } });
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
    return sendJson(res, found ? 200 : 404, found ?? { error: 'task not found' });
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
      note: typeof b.note === 'string' ? b.note : undefined,
      by: `agent:${agent}`,
    });
    if (!task) return sendJson(res, 200, { ok: false, error: 'task not found' });
    os.audit.append({ ts: Date.now(), runId: session, tenant: os.tenant, principal: `agent:${agent}`, type: task.status === 'done' ? 'task.completed' : 'task.updated', data: { id: task.id, status: task.status } });
    return sendJson(res, 200, { ok: true, task });
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
      policy: os.policy.id,
      home: os.paths?.home,
      me,
      terminalAgents: agents.map((a) => a.id), // back-compat: existing UI lists ids
      agents, // richer: { id, description, runtime }
      capabilities: os.registry.list().map((c) => ({ id: c.id, description: c.description, defaultRisk: c.defaultRisk })),
    });
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
  // the join key chat triggers use for run-as. Owner/admin only. The id segment excludes the literal
  // "identities"-suffixed paths from the single-segment member routes below.
  const teamIdentSet = p.match(/^\/api\/team\/([\w-]+)\/identities$/);
  if (method === 'POST' && teamIdentSet) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
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
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const provider = teamIdentDel[2] as IdentityProvider;
    if (!IDENTITY_PROVIDERS.includes(provider)) return sendJson(res, 400, { error: 'unknown provider' });
    os.team.clearIdentity(teamIdentDel[1], provider);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'identity.unlinked', data: { member: teamIdentDel[1], provider } });
    return sendJson(res, 200, { ok: true, identities: os.team.externalIdsFor(teamIdentDel[1]) });
  }
  const teamMember = p.match(/^\/api\/team\/([\w-]+)$/);
  if (method === 'DELETE' && teamMember) {
    if (me.role !== 'owner') return sendJson(res, 403, { error: 'owner required' });
    const out = os.team.removeMember(teamMember[1]);
    if (!out.ok) return sendJson(res, 400, out);
    // Close the residue loophole: a removed member's PERSONAL connectors (their own credentials) must
    // not outlive the account. Sessions, invites and assignment grants were cleared in removeMember.
    const connectorsRemoved = os.connectors.removeByOwner(teamMember[1]).length;
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'member.removed', data: { member: teamMember[1], connectorsRemoved } });
    return sendJson(res, 200, { ...out, connectorsRemoved });
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
    return sendJson(res, 200, { automations: autos.list().map((a) => automationView(a, req, isAdmin(me))) });
  }
  if (method === 'POST' && p === '/api/automations') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    try {
      const type = b.type === 'webhook' ? 'webhook' : b.type === 'composio' ? 'composio' : b.type === 'slack' ? 'slack' : b.type === 'discord' ? 'discord' : 'cron';
      const created = autos.add({
        agentId: String(b.agentId || ''),
        name: String(b.name || ''),
        type,
        mode: b.mode === 'headless' ? 'headless' : b.mode === 'interactive' ? 'interactive' : undefined,
        schedule: b.schedule ? String(b.schedule) : undefined,
        filter: b.filter !== undefined ? String(b.filter) : undefined,
        task: String(b.task || ''),
        createdBy: me.id,
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
    const r = autos.fire(a, { guard: false }); // explicit human action — no pile-up guard
    return sendJson(res, 200, r);
  }
  const autoMatch = p.match(/^\/api\/automations\/([\w-]+)$/);
  if (autoMatch && (method === 'PATCH' || method === 'DELETE')) {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    if (method === 'DELETE') {
      const ok = autos.remove(autoMatch[1]);
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    const b = await readBody(req);
    try {
      const updated = autos.update(autoMatch[1], {
        name: b.name !== undefined ? String(b.name) : undefined,
        mode: b.mode === 'headless' ? 'headless' : b.mode === 'interactive' ? 'interactive' : undefined,
        schedule: b.schedule !== undefined ? String(b.schedule) : undefined,
        task: b.task !== undefined ? String(b.task) : undefined,
        enabled: b.enabled !== undefined ? !!b.enabled : undefined,
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
  // Operator pasted/dropped a file (image) onto the open terminal: save it into the session's working
  // folder and type its path into the running claude. Body: { dataB64, ext }. Capped to keep a stray
  // huge paste from buffering unbounded (readBody has no limit of its own).
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
    const r = tm.attachFile(id, me.email, data, String(b.ext || 'png'));
    return sendJson(res, r.ok ? 200 : 400, r);
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
  // Permanently delete a session (kill tmux + cascade messages/questions/files) — same gate.
  const sessMatch = p.match(/^\/api\/sessions\/([\w-]+)$/);
  if (method === 'DELETE' && sessMatch) {
    const id = sessMatch[1];
    if (!tm.sessionAgent(id)) return sendJson(res, 404, { error: 'unknown session' });
    if (!tm.canViewSession(id, me)) return sendJson(res, 403, { error: 'not allowed to manage this session' });
    return sendJson(res, 200, { ok: tm.deleteSession(id, me.email) });
  }

  if (method === 'GET' && p === '/api/messages') return sendJson(res, 200, tm.listMessages(me));

  // Dismiss the whole Activity feed at once (soft hide). Leaves action-required items (pending
  // approvals/questions, waiting notifications) in place. Same per-viewer visibility as the feed.
  if (method === 'POST' && p === '/api/messages/dismiss-all') {
    return sendJson(res, 200, { ok: true, dismissed: tm.dismissAllMessages(me) });
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
  if (method === 'GET' && p === '/api/tasks') {
    const tasks = os.tasks.list({ tenant: os.tenant, status: (url.searchParams.get('status') as TaskStatus) || undefined, query: url.searchParams.get('q') || undefined, limit: 500 });
    return sendJson(res, 200, { tasks, counts: os.tasks.counts(os.tenant), agents: terminalAgents(os).map((a) => a.id) });
  }
  if (taskId && method === 'GET') {
    const found = os.tasks.withEvents(taskId[1]);
    return sendJson(res, found ? 200 : 404, found ?? { error: 'task not found' });
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
      status: typeof b.status === 'string' ? (b.status as TaskStatus) : undefined,
      assignee: b.assignee === null ? null : (typeof b.assignee === 'string' ? b.assignee : undefined),
      priority: typeof b.priority === 'number' ? b.priority : undefined,
      labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
      mode: b.mode === 'headless' || b.mode === 'interactive' ? b.mode : undefined,
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

  // ── self-learning (Dreaming): reflect on recent runs → a KB page + a shared memory Insight ──
  if (method === 'GET' && p === '/api/dreaming') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const last = os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.dreamed'").get<{ t: number | null }>();
    const lastCons = os.db.prepare("SELECT MAX(ts) AS t FROM audit_events WHERE type = 'learning.consolidated'").get<{ t: number | null }>();
    return sendJson(res, 200, { everyHours: os.settings.dreamingEveryHours(), lastDreamedAt: last?.t ?? undefined, applyLearnings: os.settings.applyLearnings(), guidance: os.settings.learnedGuidance(), recommendations: os.settings.recommendations().open, consolidateAuto: os.settings.consolidateAuto(), lastConsolidatedAt: lastCons?.t ?? undefined });
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
    if (typeof b.consolidateAuto === 'boolean') os.settings.setConsolidateAuto(b.consolidateAuto, me.email);
    return sendJson(res, 200, { ok: true, everyHours: os.settings.dreamingEveryHours(), applyLearnings: os.settings.applyLearnings(), consolidateAuto: os.settings.consolidateAuto() });
  }
  if (method === 'POST' && p === '/api/dreaming/run') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const result = await new DreamingEngine(os).dream(me.email);
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Lever 4 — consolidation: spawn the headless memory-gardener over recent episodes+lessons.
  if (method === 'POST' && p === '/api/dreaming/consolidate') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    try {
      const result = await new Consolidation(os, tm).run('automation:consolidation');
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
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
    const manifest: AgentManifest = {
      id,
      version: '1.0.0',
      description,
      ...(category ? { category } : {}),
      principal: `svc-${id}`,
      policyContext: 'default@v1',
      runtime: 'claude-code',
      ...tuning,
      ...(examplePrompts ? { examplePrompts } : {}),
      budget: { usdCap: 2.0, tokenCap: 400000, wallClockMs: 1800000 },
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), claudeMd);
    os.registerAgent({ ...manifest, dir: folder });
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.created', data: { agent: id, runtime: 'claude-code', dir: folder } });
    return sendJson(res, 200, { ok: true, id });
  }

  // ── delete a user-created agent: deregister + remove its folder — owner/admin only ──
  //    Only agents that live UNDER the data home can be deleted; the bundled examples that
  //    ship with the software are read-only (they'd reappear on restart anyway).
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
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.deleted', data: { agent: id, dir, memoriesForgotten } });
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
    fs.writeFileSync(file, String(b.content ?? ''));
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.claude.updated', data: { agent: ag.id, bytes: String(b.content ?? '').length } });
    return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 200, { agent: ag.id, description: ag.description, model: ag.model, effort: ag.effort, examplePrompts: ag.examplePrompts, category: ag.category });
    }
    const b = await readBody(req);
    const { tuning, error: tErr } = sanitizeRuntimeTuning(b);
    if (tErr) return sendJson(res, 400, { error: tErr });
    // Replace the tuning fields wholesale (sanitize already dropped empties to undefined → those
    // become "inherit"). Starter prompts + category are only touched when the body carries the field
    // (a tuning-only save from the runtime card leaves them as-is). Preserve everything else.
    const prompts = 'examplePrompts' in b ? sanitizeExamplePrompts(b.examplePrompts) : ag.examplePrompts;
    const category = 'category' in b ? sanitizeCategory(b.category) : ag.category;
    const description = 'description' in b ? String(b.description ?? '').trim() : ag.description;
    const next: AgentManifest = { ...ag, description, model: tuning.model, effort: tuning.effort, examplePrompts: prompts, category };
    const { dir: _dir, ...onDisk } = next; // `dir` is set at load, not persisted
    fs.writeFileSync(path.join(ag.dir, 'agent.json'), JSON.stringify(onDisk, null, 2) + '\n');
    os.registerAgent(next);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'agent.config.updated', data: { agent: ag.id, model: tuning.model, effort: tuning.effort, category } });
    return sendJson(res, 200, { ok: true, description, model: tuning.model, effort: tuning.effort, examplePrompts: prompts, category });
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

  // ── governance thresholds (the numeric caps the never-tier policy rules read) ──
  if (method === 'GET' && p === '/api/settings/governance') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { ...os.settings.governanceThresholds(), ...os.settings.governanceMeta() });
  }
  if (method === 'PUT' && p === '/api/settings/governance') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    const b = await readBody(req);
    const saved = os.settings.setGovernanceThresholds(
      { moneyCapUsd: Number(b.moneyCapUsd), bulkDeleteCount: Number(b.bulkDeleteCount), emailBulkCap: Number(b.emailBulkCap) },
      me.email,
    );
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'settings.governance.updated', data: { ...saved } });
    return sendJson(res, 200, { ok: true, ...saved });
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
    return sendJson(res, 200, integrationsView(os));
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
    // Generic `/agent` chat router toggle (Slack + Discord fallback when no automation matches).
    if (typeof b.chatRouter === 'boolean') os.settings.setChatRouterEnabled(b.chatRouter, me.email);
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

  // ── memory backend (sqlite / libsql / automem) — owner/admin, applied live without a restart ──
  if (method === 'GET' && p === '/api/settings/memory') {
    if (!isAdmin(me)) return sendJson(res, 403, { error: 'owner or admin required' });
    return sendJson(res, 200, { ...memoryView(os), health: await os.memory.health() });
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
    os.settings.setMemoryConfig(cfg, me.email);
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'memory.backend.changed', data: { backend: cfg.backend } });
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
    // DELETE
    const ok = os.skills.remove(name);
    if (ok) os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'skill.deleted', data: { skill: name } });
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
    if (method === 'POST' && p === '/api/files/upload') {
      const dirRel = url.searchParams.get('path') || '';
      const name = path.basename(url.searchParams.get('name') || '');
      if (!name || name === '.' || name === '..') return sendJson(res, 400, { error: 'invalid file name' });
      const dir = safeResolve(root, dirRel);
      if (!dir) return sendJson(res, 400, { error: 'path escapes the data home' });
      try { if (!fs.statSync(dir).isDirectory()) return sendJson(res, 400, { error: 'not a directory' }); }
      catch { return sendJson(res, 404, { error: 'directory not found' }); }
      const file = safeResolve(root, dirRel ? `${dirRel}/${name}` : name);
      if (!file) return sendJson(res, 400, { error: 'path escapes the data home' });
      const buf = await readRawBuffer(req);
      try { fs.writeFileSync(file, buf); }
      catch (e) { return sendJson(res, 500, { error: `write failed: ${(e as Error).message}` }); }
      os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'file.uploaded', data: { path: relOf(root, file), bytes: buf.length } });
      return sendJson(res, 200, { ok: true, path: relOf(root, file) });
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

  // ── artifacts (the deliverables gallery) ──────────────────────────────────────
  //    Any member, but scoped exactly like the inbox: owner/admin see all; a member sees only
  //    artifacts from sessions they spawned (or an automation they created). Unlike the raw file
  //    browser this exposes only curated, published deliverables — never the whole data home.
  if (method === 'GET' && p === '/api/artifacts') {
    const visible = os.artifacts.list().filter((a) => tm.canViewSpawn(a.source ?? null, me));
    return sendJson(res, 200, { artifacts: visible, enabled: os.artifacts.enabled });
  }
  const artRawMatch = p.match(/^\/api\/artifacts\/([\w-]+)\/raw$/);
  if (method === 'GET' && artRawMatch) {
    const a = os.artifacts.get(artRawMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    if (!tm.canViewSpawn(a.source ?? null, me)) return sendJson(res, 403, { error: 'forbidden' });
    const resolved = os.artifacts.readPath(a.id, url.searchParams.get('file') || undefined);
    if (!resolved) return sendJson(res, 404, { error: 'file not found' });
    const stream = fs.createReadStream(resolved.absPath);
    stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'read failed' }); else res.end(); });
    res.writeHead(200, { 'content-type': resolved.mime, 'content-disposition': `inline; filename="${resolved.filename.replace(/"/g, '')}"` });
    stream.pipe(res);
    return;
  }
  const artMatch = p.match(/^\/api\/artifacts\/([\w-]+)$/);
  if (method === 'DELETE' && artMatch) {
    const a = os.artifacts.get(artMatch[1]);
    if (!a) return sendJson(res, 404, { error: 'not found' });
    // Owner/admin delete any; a member may delete only their own session's artifacts.
    if (!isAdmin(me) && a.source !== me.id) return sendJson(res, 403, { error: 'forbidden' });
    os.artifacts.remove(a.id);
    os.audit.append({ ts: Date.now(), runId: a.sessionId, tenant: os.tenant, principal: me.email, type: 'artifact.deleted', data: { id: a.id, filename: a.filename } });
    return sendJson(res, 200, { ok: true });
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
    if (os.paths) {
      fs.mkdirSync(path.dirname(os.paths.policyOverride), { recursive: true });
      fs.writeFileSync(os.paths.policyOverride, JSON.stringify(doc, null, 2));
    }
    os.policy.update(doc); // hot reload — gateway + terminal gate share this instance
    os.audit.append({ ts: Date.now(), runId: '-', tenant: os.tenant, principal: me.email, type: 'policy.updated', data: { id: doc.id, rules: doc.rules.length } });
    return sendJson(res, 200, { ok: true, document: os.policy.document });
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
function approvalView(a: ApprovalRequest) {
  return { id: a.id, runId: a.runId, level: a.level, capability: a.attempt.capabilityId, args: a.attempt.args, reason: a.reason };
}
/** Strip the webhook secret for non-admins; give admins the ready-to-paste hook URL instead. */
function automationView(a: Automation, req: http.IncomingMessage, admin: boolean) {
  const { secret, ...rest } = a;
  return {
    ...rest,
    hookUrl: admin && a.type === 'webhook' && secret ? hookUrlFor(req, a.id, secret) : undefined,
  };
}
function hookUrlFor(req: http.IncomingMessage, id: string, secret: string): string {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}/hooks/${id}?key=${secret}`;
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
  chatRouter: boolean;
  updatedAt?: number;
  updatedBy?: string;
} {
  const meta = os.settings.composioMeta();
  const slack = os.settings.slackMeta();
  const discord = os.settings.discordMeta();
  return {
    composio: { set: meta.set, hint: redactSecret(os.settings.composioApiKey()) },
    webhook: { set: os.settings.composioWebhookSet() },
    slack: { appToken: slack.appToken, botToken: slack.botToken, configured: os.settings.slackConfigured() },
    discord: { botToken: discord.botToken, configured: os.settings.discordConfigured() },
    chatRouter: os.settings.chatRouterEnabled(),
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
function memoryView(os: AgentOS): MemorySettingsView {
  const cfg = os.settings.memoryConfig() ?? { backend: 'sqlite' as const };
  const view: MemorySettingsView = { backend: cfg.backend, ...os.settings.memoryMeta() };
  if (cfg.sqlite) view.sqlite = { embeddings: embeddingsView(cfg.sqlite.embeddings) };
  if (cfg.libsql) view.libsql = { url: cfg.libsql.url ?? '', authTokenSet: !!cfg.libsql.authToken, embeddings: embeddingsView(cfg.libsql.embeddings) };
  if (cfg.automem) view.automem = { endpoint: cfg.automem.endpoint ?? '', tokenSet: !!cfg.automem.token };
  if (cfg.ranking) view.ranking = { halfLifeDays: cfg.ranking.halfLifeDays, weightByImportance: !!cfg.ranking.weightByImportance, weightByUsage: !!cfg.ranking.weightByUsage };
  if (cfg.maintenance) view.maintenance = { ...cfg.maintenance };
  view.sharedWrites = cfg.sharedWrites === 'curated' ? 'curated' : 'open';
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
  return cfg;
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
