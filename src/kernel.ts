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

export interface AgentOSOptions {
  tenant: string;
  policy: PolicyEngine;
  /** Durable audit dir; pass null to keep audit in-memory only (tests/demo). */
  auditDir?: string | null;
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

  constructor(opts: AgentOSOptions) {
    this.tenant = opts.tenant;
    this.policy = opts.policy;

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
  policyDir: string;
  agentsDir: string;
  auditDir: string;
}

/** Build an AgentOS from the config tree. Paths in the config are resolved against `baseDir`. */
export function loadAgentOS(configPath = 'config/agent-os.config.json', baseDir = process.cwd()): AgentOS {
  const cfg = readJson<RootConfig>(path.resolve(baseDir, configPath));
  const policyDoc = readJson<PolicyDocument>(path.resolve(baseDir, cfg.policyDir, 'default.policy.json'));

  const os = new AgentOS({
    tenant: cfg.tenant,
    policy: new JsonPolicyEngine(policyDoc),
    auditDir: path.resolve(baseDir, cfg.auditDir),
  });

  const agentsDir = path.resolve(baseDir, cfg.agentsDir);
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(agentsDir, entry.name, 'agent.json');
      if (fs.existsSync(manifestPath)) os.registerAgent(readJson<AgentManifest>(manifestPath));
    }
  }
  return os;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}
