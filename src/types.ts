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

// ─────────────────────────────────────────────────────────────────────────────
// Team — the humans with access to a workspace, and what each role may do
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace roles. `owner` runs the show; `admin` can approve `head`-level requests and manage
 * the team & agent assignments; `member` can only run the agents they're assigned, never approve.
 */
export type Role = 'owner' | 'admin' | 'member';

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** `invited` until they accept a magic link; then `active`. */
  status: 'invited' | 'active';
  createdAt: number;
}

/** Which roles / members may run a given agent. Empty/absent → owner & admin only. */
export interface AgentAccess {
  allowedRoles: Role[];
  allowedMembers: string[];
}

/** Can a role resolve an approval routed to `level`? owner→any, admin→head only, member→never. */
export function canApprove(role: Role, level: ApprovalLevel): boolean {
  if (role === 'owner') return true;
  if (role === 'admin') return level === 'head';
  return false;
}

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
  /** Persistent memory for this agent (recall past context, remember durable facts). */
  memory?: MemoryProvider;
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
// Memory — persistent recall across an agent's sessions (automem-shaped)
// ─────────────────────────────────────────────────────────────────────────────

/** Automem's record kinds. Free-text in practice; this enum just documents the common ones. */
export type MemoryType = 'Decision' | 'Pattern' | 'Preference' | 'Style' | 'Habit' | 'Insight' | 'Context';

/**
 * Visibility of a memory. `agent` (default) → private to its author (`agentId`). `tenant` → shared
 * with every agent in the workspace. `agentId` is always the AUTHOR; scope governs who can read it.
 */
export type MemoryScope = 'agent' | 'tenant';

/** One stored memory. `agentId` is the author; `scope` decides who can recall it. */
export interface MemoryRecord {
  id: string;
  tenant: string;
  agentId: string;
  content: string;
  tags: string[];
  type?: MemoryType;
  /** 0..1 — provider may use it to bias ranking/retention. */
  importance?: number;
  metadata?: Record<string, unknown>;
  ts: number;
  /** Visibility: 'agent' (private) | 'tenant' (shared workspace-wide). */
  scope: MemoryScope;
  /** Relevance for a recall result (provider-defined; higher = more relevant). */
  score?: number;
}

export interface StoreInput {
  tenant: string;
  agentId: string;
  content: string;
  tags?: string[];
  type?: MemoryType;
  importance?: number;
  metadata?: Record<string, unknown>;
  /** Visibility; defaults to 'agent' (private). 'tenant' shares it workspace-wide. */
  scope?: MemoryScope;
}

export interface RecallQuery {
  tenant: string;
  agentId: string;
  /** Free-text query; omit/empty for "most recent". */
  query?: string;
  /** Extra tag filters (beyond the implicit per-agent namespace). */
  tags?: string[];
  /** Default 8. */
  limit?: number;
  /**
   * Which memories are visible. Default 'all' = the agent's own ∪ the tenant's shared. 'agent' = only
   * the agent's own; 'tenant' = only shared. (Read visibility; authorship is unaffected.)
   */
  scope?: 'all' | 'agent' | 'tenant';
}

/** Edit an existing memory. Scoped by (tenant, agentId, id) — an agent can only touch its own. */
export interface UpdateInput {
  tenant: string;
  agentId: string;
  id: string;
  content?: string;
  tags?: string[];
  type?: MemoryType;
  importance?: number;
  /** Human curation (owner/admin): match by (tenant, id) only — edit ANY memory, incl. another agent's
   *  shared one. The author guard otherwise stands. Set server-side from the caller's role, never trusted. */
  admin?: boolean;
}

export interface DeleteInput {
  tenant: string;
  agentId: string;
  id: string;
  /** Human curation (owner/admin): delete ANY memory by (tenant, id), bypassing the author guard. */
  admin?: boolean;
}

/**
 * The memory plane. One interface, swappable backends: a zero-infra SQLite store ships in the
 * box; an automem (FalkorDB + Qdrant) REST driver drops in for hybrid graph/vector recall.
 * Per-agent isolation is the provider's job (a column or an `agent:<id>` tag).
 */
export interface MemoryProvider {
  store(input: StoreInput): Promise<MemoryRecord>;
  recall(q: RecallQuery): Promise<MemoryRecord[]>;
  /** Edit a memory's fields; returns the updated record, or null if it isn't this agent's. */
  update(input: UpdateInput): Promise<MemoryRecord | null>;
  /** Remove a memory; returns true if one was deleted (and it belonged to this agent). */
  delete(input: DeleteInput): Promise<boolean>;
  /**
   * Delete an agent's PRIVATE (`scope: 'agent'`) memories — called when the agent itself is deleted,
   * so its recall residue doesn't outlive it. SHARED (`scope: 'tenant'`) memories it authored persist
   * as company knowledge (provenance only). Returns how many were removed. Optional: a backend may no-op.
   */
  forgetAgent?(tenant: string, agentId: string): Promise<number>;
  health(): Promise<{ ok: boolean; backend: string; detail?: string }>;
  /**
   * Optional periodic upkeep: prune stale/never-recalled memories and merge near-duplicates. Returns
   * what it did. Backends that consolidate server-side (automem) may no-op. Safe to call repeatedly.
   */
  maintain?(opts: MemoryMaintenance): Promise<MemoryMaintenanceResult>;
}

/** What one maintenance pass changed. */
export interface MemoryMaintenanceResult {
  pruned: number;
  merged: number;
}

/**
 * Memory upkeep policy (sqlite/libsql; automem does its own). All knobs are opt-in — an empty object
 * is a no-op. Prune is conservative (old AND never-recalled AND not important); consolidation merges
 * duplicates, preferring exact-content matches and, with embeddings, near-duplicates by cosine.
 */
export interface MemoryMaintenance {
  /** Delete memories older than this many days that were never recalled. Omit/0 → never prune. */
  pruneAfterDays?: number;
  /** Importance at or above which a memory is never pruned, regardless of age. Default 0.5. */
  keepImportance?: number;
  /** Merge near-duplicate memories with cosine ≥ this (0..1), needs embeddings. Omit → exact-content only. */
  dedupeThreshold?: number;
  /** How often the scheduler runs a pass, in hours. Default 24. */
  everyHours?: number;
}

/** Which memory backend an instance uses. Default: sqlite (no external services). */
export interface MemoryConfig {
  backend: 'sqlite' | 'automem' | 'libsql';
  /** Optional tuning for the default sqlite backend. */
  sqlite?: SqliteMemoryConfig;
  /** Required when backend = 'automem'. */
  automem?: { endpoint: string; token: string };
  /** Required when backend = 'libsql'. */
  libsql?: LibsqlMemoryConfig;
  /** Optional recall re-ranking (recency decay + importance weighting). Applies to sqlite/libsql. */
  ranking?: MemoryRanking;
  /** Optional upkeep policy (prune + consolidate). Applies to sqlite/libsql; automem self-maintains. */
  maintenance?: MemoryMaintenance;
  /**
   * Who may publish tenant-shared memories. 'open' (default) — any agent via `remember(shared)`.
   * 'curated' — agents' shared writes are downgraded to private; only humans (owner/admin) publish shared.
   */
  sharedWrites?: 'open' | 'curated';
}

/**
 * Recall re-ranking applied AFTER relevance (sqlite/libsql backends): nudge results toward memories
 * that are fresh and/or marked important, instead of pure relevance. Off by default — omit and recall
 * is unchanged. Never reorders a no-query (recency) listing. A ranking nudge, not a hard filter.
 */
export interface MemoryRanking {
  /** Recency half-life in days — a memory's weight halves every `halfLifeDays`. Omit/0 → no decay. */
  halfLifeDays?: number;
  /** Also weight by each memory's `importance` (0..1; unset = neutral). Default false. */
  weightByImportance?: boolean;
}

/**
 * sqlite backend tuning. With `embeddings` set, recall is hybrid (bm25 + in-JS cosine) with zero new
 * dependencies — vectors live in a BLOB column in the workspace DB. Without it, keyword-only.
 */
export interface SqliteMemoryConfig {
  embeddings?: EmbeddingsConfig;
}

/**
 * libSQL backend: native in-file vector search (Turso's production SQLite fork). Local file or
 * remote/Turso-Cloud URL. With `embeddings` set, recall is hybrid (bm25 + cosine); without it,
 * lexical-only — same behaviour as the sqlite backend, on a libSQL file.
 */
export interface LibsqlMemoryConfig {
  /** Connection: a local file (`file:./data/memory.libsql.db`) or remote (`libsql://…`). */
  url: string;
  /** Auth token for a remote/Turso-Cloud URL; omit for local files. */
  authToken?: string;
  /** Optional embeddings for semantic recall. Omit → lexical-only (bm25). */
  embeddings?: EmbeddingsConfig;
}

/** An OpenAI-compatible or Ollama embeddings endpoint used to vectorize memory content + queries. */
export interface EmbeddingsConfig {
  /** 'openai' (OpenAI-compatible `/v1/embeddings`) or 'ollama' (local `/api/embed`). Default 'openai'. */
  provider?: 'openai' | 'ollama';
  /** Base URL. openai: `https://api.openai.com/v1` · ollama: `http://localhost:11434`. */
  url: string;
  /** Model id. openai: `text-embedding-3-small` · ollama: `nomic-embed-text`. */
  model: string;
  /** Bearer key for openai-style providers; unused by ollama. */
  apiKey?: string;
  /** Vector dimensions (fixes the F32_BLOB width — keep stable). Default 1536; nomic-embed-text = 768. */
  dimensions?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-learning → configuration recommendations (the config loop — human-gated)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A config change the self-learning pass PROPOSES from observed friction. Never auto-applied: a human
 * Applies it (a concrete, reversible settings change) or Dismisses it. `apply` present → directly
 * applyable (today: a workspace runtime-defaults patch); absent → advisory (review via `link`).
 */
export interface Recommendation {
  id: string;            // stable key, e.g. 'runtime.effort.high' (so it doesn't duplicate across passes)
  kind: 'runtime' | 'policy' | 'budget';
  title: string;
  rationale: string;     // why, with the evidence numbers
  apply?: { runtimeDefaults?: RuntimeTuning };
  link?: string;         // advisory: where the human acts (a console hash route)
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base — the shared, tenant-wide, LIVING wiki (vs. memory's private per-agent state)
// ─────────────────────────────────────────────────────────────────────────────

/** A KB page: shared, tenant-wide, continuously rewritten. Body mirrors `kb/<section>/<slug>.md`. */
export interface KbPage {
  id: string;
  tenant: string;
  section: string;
  slug: string;
  title: string;
  tags: string[];
  body: string;
  relPath: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string; // member id | agent:<id> | automation:<id>
}

/** A prior version of a page — the rollback + audit backbone (append-only). */
export interface KbRevision {
  id: string;
  pageId: string;
  rev: number;
  title: string;
  tags: string[];
  body: string;
  summary?: string;
  author: string;
  createdAt: number;
}

/** The one mutating input: upsert by (tenant, section, slug). */
export interface KbWriteInput {
  tenant: string;
  section: string;
  slug: string;
  title?: string; // required on create
  body: string;
  tags?: string[];
  summary?: string; // one-line change note → stored on the revision
  author: string; // member id | agent:<id> | automation:<id>
}

export interface KbSearchQuery {
  tenant: string;
  query?: string;
  section?: string;
  tags?: string[];
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent + runtime
// ─────────────────────────────────────────────────────────────────────────────

/** Reasoning effort for a claude-code session (`claude --effort <level>`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude permission mode for a session (`claude --permission-mode <mode>`). This is the agent's
 *  OWN permission posture; Agent OS's gateway/gate-hook is the separate, harder backstop underneath
 *  it (a risky Bash call is blocked for inbox approval even under `bypassPermissions`). */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

/** The three knobs that tune a claude-code session — settable per-agent (manifest) with a
 *  workspace-wide fallback (Settings → runtime defaults). An undefined field means "inherit". */
export interface RuntimeTuning {
  /** Model alias or full id (`claude --model`). Undefined → the CLI's configured default. */
  model?: string;
  /** Reasoning effort (`claude --effort`). Undefined → the CLI default. */
  effort?: Effort;
  /** Permission posture (`claude --permission-mode`). Undefined → `default`. */
  permissionMode?: PermissionMode;
}

export interface AgentManifest extends RuntimeTuning {
  id: string;
  version: string;
  description: string;
  principal: string;
  policyContext: string;
  runtime: 'mock' | 'claude-code';
  budget: Budget;
  /** claude-code runtime extras. */
  maxTurns?: number;
  allowedTools?: string[];
  path?: string;
  /** Suggested first tasks shown on the agent's spawn card (clickable chips that prefill the box).
   *  Per-agent so each agent advertises how it wants to be invoked, instead of a generic default. */
  examplePrompts?: string[];
  /** Absolute folder the manifest was loaded from — the cwd a claude-code session opens in. Set at load. */
  dir?: string;
}

/** Normalize+validate a runtime-tuning payload (from an API body or config file): drops empty
 *  strings to undefined and rejects out-of-set effort/permission values. Returns the clean tuning
 *  plus any validation error (so callers can 400). Unknown model strings pass through — the CLI
 *  validates those, and aliases evolve faster than we'd want to hard-code. */
export function sanitizeRuntimeTuning(input: Partial<Record<keyof RuntimeTuning, unknown>>): { tuning: RuntimeTuning; error?: string } {
  const tuning: RuntimeTuning = {};
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model) tuning.model = model;
  const effort = typeof input.effort === 'string' ? input.effort.trim() : '';
  if (effort) {
    if (!EFFORTS.includes(effort as Effort)) return { tuning, error: `effort must be one of: ${EFFORTS.join(', ')}` };
    tuning.effort = effort as Effort;
  }
  const mode = typeof input.permissionMode === 'string' ? input.permissionMode.trim() : '';
  if (mode) {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) return { tuning, error: `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}` };
    tuning.permissionMode = mode as PermissionMode;
  }
  return { tuning };
}

/** Normalize a starter-prompts payload (from an API body or config file): coerces to an array of
 *  trimmed, non-empty strings, caps each at 500 chars and the list at 6. Returns undefined when the
 *  result is empty so the manifest stays clean (the card just falls back to its placeholder). */
export function sanitizeExamplePrompts(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 6);
  return out.length ? out : undefined;
}

/** Resolve the effective tuning for a launch: each field is the agent's own value, else the
 *  workspace default, else undefined (CLI default). Pure — used by the terminal launcher. */
export function resolveRuntimeTuning(agent: RuntimeTuning, defaults: RuntimeTuning): RuntimeTuning {
  return {
    model: agent.model ?? defaults.model,
    effort: agent.effort ?? defaults.effort,
    permissionMode: agent.permissionMode ?? defaults.permissionMode,
  };
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
