/**
 * Agent OS — core types.
 *
 * One file on purpose: these are the contracts every plane depends on. The kernel
 * core imports only from here — never from a brand's plugin code. Keeping the
 * surface small is what makes the OS generic and open-sourceable.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Risk + governance vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** Default risk taxonomy. Policy assigns one of these to every action attempt. */
export type RiskClass = 'green' | 'yellow' | 'red' | 'deny';

/** Who must approve. yellow → head, red → owner (you). Configurable per policy. */
export type ApprovalLevel = 'head' | 'owner';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export type Outcome = 'success' | 'failure' | 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// The Run — the single execution primitive (the OS "process")
// ─────────────────────────────────────────────────────────────────────────────

export interface Budget {
  /** Hard ceiling in USD for this run. null = unlimited. */
  usdCap: number | null;
  /** Hard ceiling in model tokens for this run. null = unlimited. */
  tokenCap: number | null;
  /** Wall-clock ceiling in ms. null = unlimited. */
  wallClockMs: number | null;
}

export interface Cost {
  usd: number;
  tokens: number;
}

export interface TriggerRef {
  type: 'cron' | 'webhook' | 'slack' | 'email' | 'agent' | 'manual';
  ref?: string;
  /** Dedupe key for exactly-once side effects (e.g. email Message-Id, webhook delivery id). */
  idempotencyKey?: string;
}

/** What a trigger emits / a caller submits. */
export interface RunRequest {
  tenant: string;
  agentId: string;
  trigger: TriggerRef;
  inputs: Record<string, unknown>;
  /** Override the agent's default principal / budget if needed. */
  principal?: string;
  budget?: Partial<Budget>;
}

export interface Run {
  id: string;
  tenant: string;
  agent: { id: string; version: string };
  trigger: TriggerRef;
  /** The service account this run acts as. Recorded in every audit event. */
  principal: string;
  inputs: Record<string, unknown>;
  budget: Budget;
  /** Which policy ruleset bound this run (for reproducibility). */
  policyContext: string;
  /** Per-run scratch workspace path. */
  workspace: string;
  status: RunStatus;
  outcome: Outcome;
  /** Actuals, accumulated at the gateway as effects fire. */
  cost: Cost;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions + capabilities (what flows through the gateway)
// ─────────────────────────────────────────────────────────────────────────────

/** An agent's attempt to perform a side effect. This is what the gateway receives. */
export interface ActionAttempt {
  capabilityId: string;
  args: Record<string, unknown>;
  /** The agent's stated reason — captured verbatim in the audit log. */
  reasoning?: string;
}

export type Decision =
  | { effect: 'allow' }
  | { effect: 'deny'; reason: string }
  | { effect: 'approve'; level: ApprovalLevel; reason: string };

export interface CapabilityResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** Actual cost incurred; falls back to the estimate if omitted. */
  cost?: Partial<Cost>;
}

/**
 * A governable side effect. Connectors and dangerous tools register as Capabilities.
 * `invoke` is called ONLY by the gateway — never directly by an agent.
 */
export interface Capability {
  id: string;
  description: string;
  defaultRisk: RiskClass;
  estimateCost?(args: Record<string, unknown>): Partial<Cost>;
  invoke(args: Record<string, unknown>, ctx: RunContext): Promise<CapabilityResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run context — the services a capability/adapter may touch
// ─────────────────────────────────────────────────────────────────────────────

export interface RunContext {
  run: Run;
  secrets: SecretsVault;
  audit: AuditSink;
  log(message: string, data?: Record<string, unknown>): void;
}

/** Bound entry point an agent runtime uses to request a side effect. */
export type Act = (attempt: ActionAttempt) => Promise<CapabilityResult>;

// ─────────────────────────────────────────────────────────────────────────────
// Plane interfaces (the seams the core depends on; impls are swappable)
// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyEngine {
  /** Which ruleset this engine represents (recorded on the run). */
  readonly id: string;
  classify(attempt: ActionAttempt, ctx: RunContext): Decision;
}

export interface BudgetLedger {
  /** Would adding `cost` exceed this run's caps? */
  check(run: Run, cost: Cost): { ok: boolean; reason?: string };
  /** Record actual spend against the run. */
  debit(run: Run, cost: Cost): void;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  tenant: string;
  level: ApprovalLevel;
  attempt: ActionAttempt;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedBy?: string;
}

export interface Approvals {
  /** Enqueue an approval; returns the request and a promise that settles on decision. */
  request(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): {
    req: ApprovalRequest;
    decision: Promise<boolean>;
  };
  resolve(id: string, approved: boolean, by: string): void;
  pending(tenant?: string): ApprovalRequest[];
}

export interface Identity {
  /** Assume a principal for the duration of an effect. Returns short-lived context. */
  assume(principal: string, tenant: string): Promise<{ principal: string }>;
}

export interface IdempotencyStore {
  seen(key: string): boolean;
  get(key: string): CapabilityResult | undefined;
  remember(key: string, result: CapabilityResult): void;
}

export interface SecretsVault {
  /** Mint/fetch a credential for a principal. Never exposed to the agent directly. */
  get(tenant: string, principal: string, key: string): Promise<string | undefined>;
}

export interface AuditEvent {
  ts: number;
  runId: string;
  tenant: string;
  /** e.g. run.created, action.attempt, policy.decision, budget.debit, approval.requested */
  type: string;
  principal?: string;
  data: Record<string, unknown>;
}

export interface AuditSink {
  append(event: AuditEvent): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent + runtime
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentManifest {
  id: string;
  version: string;
  description: string;
  principal: string;
  policyContext: string;
  runtime: 'mock' | 'claude-code';
  budget: Budget;
  /** claude-code runtime extras. */
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  path?: string;
  /** Absolute folder the manifest was loaded from — the cwd a claude-code session opens in. Set at load. */
  dir?: string;
}

/** A runtime drives an agent and routes its side effects through `act`. */
export interface RuntimeAdapter {
  readonly kind: AgentManifest['runtime'];
  run(
    run: Run,
    ctx: RunContext,
    act: Act,
    manifest: AgentManifest,
  ): Promise<{ outcome: Outcome; result?: unknown }>;
}
