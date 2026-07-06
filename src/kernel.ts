/**
 * Kernel — assembles an Agent OS instance from its parts. This is the composition root:
 * the one place where Policy, Budget, Approvals, Identity, Idempotency and Audit are
 * wired into the Gateway, and the Gateway + adapters into the Orchestrator.
 *
 * `loadAgentOS()` builds one from the declarative config (policy + agent manifests).
 * Capability implementations and mock behaviors are plugin CODE you register after.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentManifest,
  AuditSink,
  Capability,
  MemoryConfig,
  MemoryMaintenanceResult,
  MemoryProvider,
  PolicyEngine,
  RunRequest,
  RuntimeAdapter,
} from './types';
import { createMemoryProvider } from './memory';
import { CapabilityRegistry } from './capabilities/registry';
import { ConnectorStore } from './connectors/connectors';
import { Gateway } from './gateway/gateway';
import { InMemoryAuditSink, JsonlAuditSink, SqliteAuditSink, TeeAuditSink } from './governance/audit';
import { InMemoryBudgetLedger } from './governance/budget';
import { SqliteApprovals } from './governance/approvals';
import { TeamStore } from './governance/team';
import { SettingsStore } from './governance/settings';
import { SkillsStore } from './governance/skills';
import { Db, openDb } from './state/db';
import { ArtifactStore } from './state/artifacts';
import { KbStore } from './state/kb';
import { TaskStore } from './state/tasks';
import { StubIdentity } from './governance/identity';
import { InMemoryIdempotencyStore } from './gateway/idempotency';
import { JsonPolicyEngine, PolicyDocument } from './governance/policy';
import { EnvSecretsVault, SqliteSecretsVault } from './edge/secrets';
import { resolveMasterKey } from './edge/secret-crypto';
import { ensureAgentAuthor } from './edge/agent-author';
import { HealthMonitor } from './observability/monitor';
import { MockAdapter, MockBehavior } from './runtime/mock-adapter';
import { ClaudeCodeAdapter } from './runtime/claude-code-adapter';
import { Orchestrator } from './core/orchestrator';
import { Paths, resolvePaths } from './home';

export interface AgentOSOptions {
  tenant: string;
  /** Optional human label for the tenant (e.g. "Northwind"); defaults to `tenant`. Display only. */
  tenantName?: string;
  policy: PolicyEngine;
  /** Durable audit dir; pass null to keep audit in-memory only (tests/demo). */
  auditDir?: string | null;
  /** Resolved instance paths (data home + derived). Optional for tests/demo. */
  paths?: Paths;
  /** Which memory backend to use. Default: sqlite (no external services). */
  memory?: MemoryConfig;
}

export class AgentOS {
  readonly tenant: string;
  /** Human-facing tenant label (branding); falls back to the tenant id. */
  readonly tenantName: string;
  readonly registry = new CapabilityRegistry();
  readonly memoryAudit = new InMemoryAuditSink();
  readonly audit: AuditSink;
  readonly budget = new InMemoryBudgetLedger();
  /** Per-workspace SQLite database shared by the team, connectors, approvals & audit stores. */
  readonly db: Db;
  readonly approvals: SqliteApprovals;
  /** The humans with access to this workspace, their roles, sessions and agent assignments. */
  readonly team: TeamStore;
  /** Workspace-wide settings — incl. the Company context injected into every claude-code agent. */
  readonly settings: SettingsStore;
  /** Global skills library — Claude Code Skills materialised into every claude-code agent at launch. */
  readonly skills: SkillsStore;
  /** The deliverables gallery — artifacts agents publish (PDF/Markdown/image), snapshotted + governed. */
  readonly artifacts: ArtifactStore;
  /** The company knowledge base — the shared, living wiki agents + humans co-author (revision-chained). */
  readonly kb: KbStore;
  /** The shared work queue — durable tasks humans + agents create, claim, and drain (auto-dispatchable). */
  readonly tasks: TaskStore;
  readonly identity = new StubIdentity();
  readonly idempotency = new InMemoryIdempotencyStore();
  /** The secrets vault: encrypted-at-rest in the workspace DB, with the env vault as a fallback. */
  readonly secrets: SqliteSecretsVault;
  readonly monitor = new HealthMonitor();
  readonly policy: PolicyEngine;
  readonly mock = new MockAdapter();
  readonly agents = new Map<string, AgentManifest>();
  /** User-registered connectors (MCP servers) the claude-code runtime exposes to agents. */
  readonly connectors: ConnectorStore;
  /**
   * Persistent agent memory (recall across sessions). SQLite by default; libsql/automem optional.
   * Mutable so Settings → Memory can hot-swap the backend live (new requests use the new provider).
   */
  memory: MemoryProvider;
  readonly adapters = new Map<AgentManifest['runtime'], RuntimeAdapter>();
  readonly gateway: Gateway;
  readonly orchestrator: Orchestrator;
  /** Where this instance's user-owned data lives (set when built from config). */
  readonly paths?: Paths;

  constructor(opts: AgentOSOptions) {
    this.tenant = opts.tenant;
    this.tenantName = opts.tenantName || opts.tenant;
    this.policy = opts.policy;
    this.paths = opts.paths;
    // The per-workspace DB backs everything user-facing. No paths (tests/demo) → ephemeral in-memory.
    this.db = openDb(opts.paths?.db ?? ':memory:');
    this.secrets = new SqliteSecretsVault(this.db, resolveMasterKey(opts.paths?.home), new EnvSecretsVault());
    this.connectors = new ConnectorStore(this.db);
    this.approvals = new SqliteApprovals(this.db);
    this.team = new TeamStore(this.db);
    this.settings = new SettingsStore(this.db);
    this.skills = new SkillsStore(opts.paths?.skills, this.db, opts.paths?.bundledSkills);
    this.artifacts = new ArtifactStore(this.db, opts.paths?.artifacts);
    this.kb = new KbStore(this.db, opts.paths?.kb);
    this.tasks = new TaskStore(this.db); // db-only (structured state, no on-disk mirror — see tasks-plan.md §Decision 2)
    this.memory = createMemoryProvider(opts.memory ?? { backend: 'sqlite' }, this.db);

    const sinks: AuditSink[] = [this.memoryAudit, new SqliteAuditSink(this.db)];
    if (opts.auditDir) sinks.push(new JsonlAuditSink(opts.auditDir));
    this.audit = new TeeAuditSink(sinks);

    this.gateway = new Gateway({
      registry: this.registry,
      policy: this.policy,
      budget: this.budget,
      approvals: this.approvals,
      identity: this.identity,
      idempotency: this.idempotency,
      killSwitch: () => this.settings.killSwitch().engaged,
    });

    this.adapters.set('mock', this.mock);
    this.adapters.set('claude-code', new ClaudeCodeAdapter());

    this.orchestrator = new Orchestrator({
      gateway: this.gateway,
      audit: this.audit,
      secrets: this.secrets,
      monitor: this.monitor,
      agents: this.agents,
      adapters: this.adapters,
    });
  }

  /** Build a memory provider from a config without swapping the live one (for a pre-save Test). */
  buildMemory(cfg: MemoryConfig): MemoryProvider {
    return createMemoryProvider(cfg, this.db);
  }
  /** Hot-swap the live memory backend. Throws on invalid config (missing required fields). */
  applyMemory(cfg: MemoryConfig): MemoryProvider {
    this.memory = createMemoryProvider(cfg, this.db);
    return this.memory;
  }

  /**
   * Run one memory-maintenance pass (prune + consolidate) using the saved `maintenance` policy, and
   * audit it if anything changed. No-op when the backend doesn't support it or no policy is set.
   */
  async runMemoryMaintenance(by = 'system'): Promise<MemoryMaintenanceResult> {
    const opts = this.settings.memoryConfig()?.maintenance;
    if (!this.memory.maintain || !opts) return { pruned: 0, merged: 0 };
    const res = await this.memory.maintain(opts);
    if (res.pruned || res.merged) {
      this.audit.append({ ts: Date.now(), runId: '-', tenant: this.tenant, principal: by, type: 'memory.maintained', data: { ...res } });
    }
    return res;
  }

  registerCapabilities(caps: Capability[]): this {
    this.registry.registerAll(caps);
    return this;
  }
  registerAgent(manifest: AgentManifest): this {
    this.agents.set(manifest.id, manifest);
    return this;
  }
  /** Drop an agent from the live registry (the on-disk folder is removed by the caller). */
  deregisterAgent(id: string): boolean {
    return this.agents.delete(id);
  }
  /**
   * Re-scan the agent folders on disk and sync the live registry — the on-demand counterpart of
   * the boot scan, for agents dropped into `<home>/agents/` outside the console (git pull, scp,
   * an agent writing a sibling) while the server runs. Disk is the source of truth: new folders
   * register, changed manifests re-register, and disk-loaded agents whose folder vanished
   * deregister. Programmatic registrations (no `dir` — demo/tests) are left alone. Removal here
   * is registry-only — assignments and memories are kept so a folder restored later (git revert)
   * comes back intact; full cleanup stays with the delete route.
   */
  rescanAgents(): AgentRescanResult {
    const added: string[] = [], updated: string[] = [], removed: string[] = [];
    const errors: { folder: string; error: string }[] = [];
    if (!this.paths) return { added, updated, removed, errors };
    // Same precedence as boot: bundled examples first, then the user's agents (user wins by id).
    const onDisk = new Map<string, AgentManifest>();
    for (const dir of [this.paths.bundledAgents, this.paths.userAgents]) {
      for (const found of scanAgentDir(dir)) {
        if (found.manifest) onDisk.set(found.manifest.id, found.manifest);
        else errors.push({ folder: found.folder, error: found.error! });
      }
    }
    for (const [id, manifest] of onDisk) {
      const current = this.agents.get(id);
      if (!current) added.push(id);
      else if (JSON.stringify(current) !== JSON.stringify(manifest)) updated.push(id);
      else continue;
      this.agents.set(id, manifest);
    }
    for (const [id, current] of this.agents) {
      if (current.dir && !onDisk.has(id)) {
        this.agents.delete(id);
        removed.push(id);
      }
    }
    return { added, updated, removed, errors };
  }
  registerMockBehavior(agentId: string, behavior: MockBehavior): this {
    this.mock.register(agentId, behavior);
    return this;
  }
  submit(req: RunRequest) {
    return this.orchestrator.submit(req);
  }
}

export interface RootConfig {
  /** The SEED/DEFAULT tenant id. In multi-tenant mode this is the slug of the legacy un-nested home. */
  tenant: string;
  /** Base domain for subdomain routing (e.g. `agent-os.example.com`); tenants live at `<slug>.<base>`. */
  baseDomain?: string;
  /** User data home (env AGENT_OS_HOME overrides). Default: ./data. */
  home?: string;
  /** Bundled example agents that ship with the software. Default: config/agents. */
  agentsDir?: string;
  /** Bundled default policy dir. Default: config/policy. */
  policyDir?: string;
  /** Memory backend. Default: sqlite (no external services). */
  memory?: MemoryConfig;
}

/**
 * Build an AgentOS from the config tree.
 *   - The SOFTWARE's bundled examples (agents + default policy) come from the repo (`baseDir`).
 *   - The USER's data — their agents, their policy override, audit — comes from the data home
 *     (`$AGENT_OS_HOME` / config `home` / `./data`). User agents win on id collision.
 */
/**
 * Build an AgentOS for ONE tenant. `overrides` lets the multi-tenant registry point a single
 * config at a per-tenant `tenant` id + `paths` (its own home/DB/socket); omitted = the single-tenant
 * default (legacy behavior, used by the demo/CLI and the seed tenant).
 */
export function loadAgentOS(
  configPath = 'config/agent-os.config.json',
  baseDir = process.cwd(),
  overrides?: { tenant?: string; tenantName?: string; paths?: Paths },
): AgentOS {
  const cfg = readJson<RootConfig>(path.resolve(baseDir, configPath));
  const paths = overrides?.paths ?? resolvePaths(baseDir, cfg);
  const policyDoc = readJson<PolicyDocument>(paths.policyFile);

  const policyEngine = new JsonPolicyEngine(policyDoc);
  const os = new AgentOS({
    tenant: overrides?.tenant ?? cfg.tenant,
    tenantName: overrides?.tenantName ?? process.env.AGENT_OS_TENANT_NAME,
    policy: policyEngine,
    auditDir: paths.audit,
    paths,
    memory: cfg.memory,
  });

  // The never-tier rules reference governance caps by name ($moneyCapUsd / $bulkDeleteCount); resolve
  // them live from the settings store (editable in Settings → Governance) now that `os` exists.
  policyEngine.setThresholds(() => os.settings.governanceThresholds() as unknown as Record<string, number>);

  // A backend saved from Settings → Memory (DB) overrides the file default and survives restarts.
  // Build it synchronously here (no health check) so boot never blocks on a network call; a broken
  // stored config falls back to whatever the constructor already built from the file.
  const stored = os.settings.memoryConfig();
  if (stored) {
    try {
      os.applyMemory(stored);
    } catch (e) {
      console.error(`[memory] stored backend config invalid, using file default: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Bundled examples first, then the user's agents (which override examples by id).
  loadAgentsFrom(os, paths.bundledAgents);
  loadAgentsFrom(os, paths.userAgents);
  // Code-provisioned System agents that must exist in every home (materialised into the data home,
  // idempotently) even though they don't ship as a config/agents folder.
  ensureAgentAuthor(os);
  return os;
}

/** Register every `<dir>/<id>/agent.json` found, tagging each manifest with its absolute folder. */
function loadAgentsFrom(os: AgentOS, dir: string): void {
  for (const found of scanAgentDir(dir)) {
    if (found.manifest) os.registerAgent(found.manifest);
    else console.error(`[agents] skipping ${found.folder}: ${found.error}`);
  }
}

/** What one rescan changed in the live registry (ids), plus folders whose manifest didn't parse. */
export interface AgentRescanResult {
  added: string[];
  updated: string[];
  removed: string[];
  errors: { folder: string; error: string }[];
}

/** One agent folder found on disk: its manifest (tagged with the folder), or why it didn't load. */
interface ScannedAgent {
  folder: string;
  manifest?: AgentManifest;
  error?: string;
}

/**
 * Scan `<dir>/<id>/agent.json` folders. A malformed or id-less manifest is reported, not thrown —
 * one broken folder must never take down boot or a rescan alongside healthy agents.
 */
function scanAgentDir(dir: string): ScannedAgent[] {
  if (!fs.existsSync(dir)) return [];
  const out: ScannedAgent[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    const manifestPath = path.join(folder, 'agent.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = readJson<AgentManifest>(manifestPath);
      if (!manifest || typeof manifest.id !== 'string' || !manifest.id) throw new Error('manifest has no "id"');
      out.push({ folder, manifest: { ...manifest, dir: folder } });
    } catch (e) {
      out.push({ folder, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

/** Read the root config (tenant/home/baseDomain/memory) — used by the multi-tenant registry. */
export function readRootConfig(configPath = 'config/agent-os.config.json', baseDir = process.cwd()): RootConfig {
  return readJson<RootConfig>(path.resolve(baseDir, configPath));
}
