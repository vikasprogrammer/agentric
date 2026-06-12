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
  PolicyEngine,
  RunRequest,
  RuntimeAdapter,
} from './types';
import { CapabilityRegistry } from './capabilities/registry';
import { Gateway } from './gateway/gateway';
import { InMemoryAuditSink, JsonlAuditSink, TeeAuditSink } from './governance/audit';
import { InMemoryBudgetLedger } from './governance/budget';
import { InMemoryApprovals } from './governance/approvals';
import { StubIdentity } from './governance/identity';
import { InMemoryIdempotencyStore } from './gateway/idempotency';
import { JsonPolicyEngine, PolicyDocument } from './governance/policy';
import { EnvSecretsVault } from './edge/secrets';
import { HealthMonitor } from './observability/monitor';
import { MockAdapter, MockBehavior } from './runtime/mock-adapter';
import { ClaudeCodeAdapter } from './runtime/claude-code-adapter';
import { Orchestrator } from './core/orchestrator';
import { Paths, resolvePaths } from './home';

export interface AgentOSOptions {
  tenant: string;
  policy: PolicyEngine;
  /** Durable audit dir; pass null to keep audit in-memory only (tests/demo). */
  auditDir?: string | null;
  /** Resolved instance paths (data home + derived). Optional for tests/demo. */
  paths?: Paths;
}

export class AgentOS {
  readonly tenant: string;
  readonly registry = new CapabilityRegistry();
  readonly memoryAudit = new InMemoryAuditSink();
  readonly audit: AuditSink;
  readonly budget = new InMemoryBudgetLedger();
  readonly approvals = new InMemoryApprovals();
  readonly identity = new StubIdentity();
  readonly idempotency = new InMemoryIdempotencyStore();
  readonly secrets = new EnvSecretsVault();
  readonly monitor = new HealthMonitor();
  readonly policy: PolicyEngine;
  readonly mock = new MockAdapter();
  readonly agents = new Map<string, AgentManifest>();
  readonly adapters = new Map<AgentManifest['runtime'], RuntimeAdapter>();
  readonly gateway: Gateway;
  readonly orchestrator: Orchestrator;
  /** Where this instance's user-owned data lives (set when built from config). */
  readonly paths?: Paths;

  constructor(opts: AgentOSOptions) {
    this.tenant = opts.tenant;
    this.policy = opts.policy;
    this.paths = opts.paths;

    const sinks: AuditSink[] = [this.memoryAudit];
    if (opts.auditDir) sinks.push(new JsonlAuditSink(opts.auditDir));
    this.audit = new TeeAuditSink(sinks);

    this.gateway = new Gateway({
      registry: this.registry,
      policy: this.policy,
      budget: this.budget,
      approvals: this.approvals,
      identity: this.identity,
      idempotency: this.idempotency,
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

  registerCapabilities(caps: Capability[]): this {
    this.registry.registerAll(caps);
    return this;
  }
  registerAgent(manifest: AgentManifest): this {
    this.agents.set(manifest.id, manifest);
    return this;
  }
  registerMockBehavior(agentId: string, behavior: MockBehavior): this {
    this.mock.register(agentId, behavior);
    return this;
  }
  submit(req: RunRequest) {
    return this.orchestrator.submit(req);
  }
}

interface RootConfig {
  tenant: string;
  /** User data home (env AGENT_OS_HOME overrides). Default: ./data. */
  home?: string;
  /** Bundled example agents that ship with the software. Default: config/agents. */
  agentsDir?: string;
  /** Bundled default policy dir. Default: config/policy. */
  policyDir?: string;
}

/**
 * Build an AgentOS from the config tree.
 *   - The SOFTWARE's bundled examples (agents + default policy) come from the repo (`baseDir`).
 *   - The USER's data — their agents, their policy override, audit — comes from the data home
 *     (`$AGENT_OS_HOME` / config `home` / `./data`). User agents win on id collision.
 */
export function loadAgentOS(configPath = 'config/agent-os.config.json', baseDir = process.cwd()): AgentOS {
  const cfg = readJson<RootConfig>(path.resolve(baseDir, configPath));
  const paths = resolvePaths(baseDir, cfg);
  const policyDoc = readJson<PolicyDocument>(paths.policyFile);

  const os = new AgentOS({
    tenant: cfg.tenant,
    policy: new JsonPolicyEngine(policyDoc),
    auditDir: paths.audit,
    paths,
  });

  // Bundled examples first, then the user's agents (which override examples by id).
  loadAgentsFrom(os, paths.bundledAgents);
  loadAgentsFrom(os, paths.userAgents);
  return os;
}

/** Register every `<dir>/<id>/agent.json` found, tagging each manifest with its absolute folder. */
function loadAgentsFrom(os: AgentOS, dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(dir, entry.name);
    const manifestPath = path.join(folder, 'agent.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = readJson<AgentManifest>(manifestPath);
    os.registerAgent({ ...manifest, dir: folder });
  }
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}
