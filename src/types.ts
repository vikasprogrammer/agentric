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
  /** Profile picture as a self-contained `data:image/…;base64,…` URL (small, square). Absent → the
   *  UI falls back to the member's initial. Members set their own; owners/admins may set anyone's. */
  avatar?: string;
}

/**
 * The external accounts a member is known by on other platforms — the join key that lets a chat
 * trigger (Slack/Discord) run AS the right person. One external id maps to at most one member
 * (enforced by the table's `(provider, external_id)` primary key), so run-as is never ambiguous.
 */
export type IdentityProvider = 'slack' | 'discord' | 'email' | 'github';

/** The set of providers the identity map accepts — used to validate API input. */
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['slack', 'discord', 'email', 'github'];

export interface MemberIdentity {
  memberId: string;
  provider: IdentityProvider;
  /** The provider-side id/handle (e.g. a Slack `U…` id, a Discord snowflake, a secondary email). */
  externalId: string;
  createdAt: number;
  createdBy?: string;
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

/**
 * A policy decision. Every decision carries an explicit {@link RiskClass} — the single, legible
 * bucket a human reads ("why am I being asked?") — plus a `reason` naming the rule/condition that put
 * it there. The class is pinned to the effect: allow→green, approve@head→yellow, approve@owner→red,
 * deny→deny. It's surfaced on the approval card, the audit trail, and the approver DM.
 */
export type Decision =
  | { effect: 'allow'; riskClass: 'green'; reason: string }
  | { effect: 'deny'; riskClass: 'deny'; reason: string }
  | { effect: 'approve'; level: ApprovalLevel; riskClass: 'yellow' | 'red'; reason: string };

/** The risk bucket for an `ask` at a given approval level (yellow = admin/head, red = owner). */
export function riskClassForLevel(level: ApprovalLevel): 'yellow' | 'red' {
  return level === 'owner' ? 'red' : 'yellow';
}

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
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
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
  /** Cancel a still-pending request (the session it gated ended, so no one can decide). Settles the
   *  waiter as denied so a live gateway/gate-hook unblocks, and marks the row `cancelled`. Returns
   *  whether a pending request was actually cancelled. */
  cancel(id: string, by: string): boolean;
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
  /** How many times an actual query has surfaced this memory (retrieval reinforcement). */
  recallCount?: number;
  /** When it was last surfaced by a query (ms). Drives usage-aware recency decay. */
  lastRecalledAt?: number;
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
   * Optional: how many memories the backend holds (for the backend-switch **drift banner** — compared
   * against the local `memories` table). SQLite/libsql count their table for the tenant; automem reports
   * its whole-instance count (exact for a dedicated per-tenant instance). Returns null if unknown.
   */
  count?(tenant: string): Promise<number | null>;
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
  /**
   * Launch-time recall preamble: seed each new session's system prompt with the agent's most salient
   * memories, so a cold start isn't blind (vs. relying on the agent to call `recall` itself). Off by
   * default. Reads the local `memories` ledger the same store recall ranks over.
   */
  preload?: MemoryPreload;
}

/** Launch-time recall preamble config (Settings → Memory). See MemoryConfig.preload. */
export interface MemoryPreload {
  enabled: boolean;
  /** How many memories to inject (1..25; default 8). Ranked by importance then recency-of-use. */
  count?: number;
}

/**
 * Recall re-ranking applied AFTER relevance (sqlite/libsql backends): nudge results toward memories
 * that are fresh and/or marked important, instead of pure relevance. Off by default — omit and recall
 * is unchanged. Never reorders a no-query (recency) listing. A ranking nudge, not a hard filter.
 */
export interface MemoryRanking {
  /** Recency half-life in days — a memory's weight halves every `halfLifeDays`. Omit/0 → no decay.
   *  Recency counts from a memory's last *use* (recall) when it has one, else its creation — so a
   *  memory that keeps proving useful stays fresh, while the never-recalled fade. */
  halfLifeDays?: number;
  /** Also weight by each memory's `importance` (0..1; unset = neutral). Default false. */
  weightByImportance?: boolean;
  /** Also boost frequently-recalled memories (retrieval reinforcement). Default false. */
  weightByUsage?: boolean;
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
  readCount: number; // times an agent has fetched this page (feeds future auto-archive of dead pages)
  lastReadAt?: number; // when an agent last fetched it (epoch ms); undefined = never fetched
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
// Tasks — the shared, tenant-wide, durable UNIT OF WORK (vs. KB's document / memory's private note).
// A task has a lifecycle a human or agent acts on; an agent-assigned auto_dispatch task spawns a
// governed session that works it and closes its own loop. See docs/tasks-plan.md.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled';

export interface Task {
  id: string;
  tenant: string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number; // 0 urgent … 3 low
  labels: string[];
  assignee?: string; // member id | 'agent:<id>'
  owner?: string; // member id → run_as of the dispatched session; undefined → company identity
  parentId?: string;
  mode: 'headless' | 'interactive'; // how a dispatched session runs (default headless: work-to-completion)
  autoDispatch: boolean;
  dueAt?: number;
  attempts: number;
  lastSessionId?: string;
  createdBy: string; // member id | 'agent:<id>'
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  kind: 'comment' | 'status' | 'claim' | 'dispatch' | 'assign' | 'link' | 'attach';
  body?: string;
  author: string; // member id | 'agent:<id>' | 'automation:<id>' | 'system'
  sessionId?: string;
  createdAt: number;
}

/** A file attached to a task — a durable on-disk snapshot (mirrors {@link Artifact}, keyed to a task). */
export interface TaskAttachment {
  id: string;
  taskId: string;
  tenant: string;
  filename: string; // original basename (display + download name)
  relPath: string; // under <home>/task-attachments/ (<taskId>/<id>-<filename>)
  mime: string;
  bytes: number;
  uploadedBy: string; // member id | 'agent:<id>'
  createdAt: number;
}

export interface TaskCreateInput {
  tenant: string;
  title: string;
  body?: string;
  assignee?: string;
  owner?: string;
  priority?: number;
  labels?: string[];
  parentId?: string;
  mode?: 'headless' | 'interactive';
  autoDispatch?: boolean;
  dueAt?: number;
  createdBy: string; // member id | 'agent:<id>'
}

export interface TaskUpdateInput {
  title?: string;
  body?: string;
  status?: TaskStatus;
  assignee?: string | null; // null clears the assignee
  priority?: number;
  labels?: string[];
  mode?: 'headless' | 'interactive';
  dueAt?: number | null; // epoch ms soft deadline; null clears it
  note?: string; // free-text comment → appended as a task_event
  by: string; // author (member id | 'agent:<id>')
}

export interface TaskQuery {
  tenant: string;
  status?: TaskStatus;
  assignee?: string; // member id | 'agent:<id>'
  label?: string;
  query?: string; // FTS over title/body/labels
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent + runtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A workspace-defined governance pattern: a regex over a tool call that sets a boolean *fact* the
 * policy can gate on. It lets an operator mark their OWN dangerous operations — a prod-deploy path,
 * a `suspend-user` command, a money-moving CLI — without editing the enricher's built-in patterns.
 * Matched case-insensitively against the shell command + connector input text.
 */
export interface EnrichPattern {
  /** Regex source (JS). Tested case-insensitively; an invalid regex is ignored, never thrown. */
  pattern: string;
  /** Boolean fact name set to `true` on match (e.g. 'serverReboot'). Policy reads it as `when.arg`. */
  fact: string;
  /** Which calls it applies to: 'shell' (Bash), 'connector' (mcp__* tools), or 'any' (default: shell+connector). */
  scope?: 'shell' | 'connector' | 'any';
}

/** Reasoning effort for a claude-code session (`claude --effort <level>`). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Permission mode for a claude-code session (`claude --permission-mode <mode>`). These are the exact
 *  choices the CLI accepts. It matters ONLY on the interactive lane, and ONLY for tools the gate hook
 *  doesn't already decide: for `Bash`/`Edit`/`Write`/`mcp__*` the PreToolUse hook returns an
 *  authoritative `allow`/`deny`, which bypasses Claude's own permission engine (the classifier never
 *  runs). So the mode governs the *fallback* for tools the hook leaves alone (Read/Glob/Grep,
 *  WebFetch, …) — `auto` lets Claude's classifier auto-approve the safe ones instead of blocking on a
 *  native prompt no one answers in an idle tmux pane. It is NOT the OS sandbox (a separate switch we
 *  deliberately don't enable) and does NOT weaken the gate hook. */
export type PermissionMode = 'auto' | 'plan' | 'acceptEdits' | 'manual' | 'dontAsk' | 'bypassPermissions';
export const PERMISSION_MODES: readonly PermissionMode[] = ['auto', 'plan', 'acceptEdits', 'manual', 'dontAsk', 'bypassPermissions'];

/** The knobs that tune a claude-code session — settable per-agent (manifest) with a workspace-wide
 *  fallback (Settings → runtime defaults). An undefined field means "inherit". `model`/`effort` apply
 *  to both lanes; `permissionMode` is interactive-only (the headless lane keeps
 *  `--dangerously-skip-permissions`) and defaults to `auto` when unset at every level. The gate hook
 *  remains the sole authority for governed side effects regardless of the mode — see PermissionMode. */
export interface RuntimeTuning {
  /** Model alias or full id (`claude --model`). Undefined → the CLI's configured default. */
  model?: string;
  /** Reasoning effort (`claude --effort`). Undefined → the CLI default. */
  effort?: Effort;
  /** Permission mode (`claude --permission-mode`), interactive lane only. Undefined → `auto`. */
  permissionMode?: PermissionMode;
}

export interface AgentManifest extends RuntimeTuning {
  id: string;
  version: string;
  description: string;
  /** Free-text grouping label (e.g. "Engineering", "Marketing") so the console can bucket agents.
   *  Undefined → the agent shows under "Uncategorized". Purely organisational; no behavioural effect. */
  category?: string;
  principal: string;
  /** The policy ruleset this agent expects to be governed by. The engine enforces a single loaded ruleset
   *  (`os.policy.id`) and `classify()` ignores per-agent context, so this MUST match the enforced ruleset —
   *  a mismatch is warned at registration (see {@link policyContextMismatch}) because the agent would
   *  otherwise be governed by a different policy than it declares. */
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
  /** Opt-in list of vault keys to resolve and export as shell env vars into this agent's claude-code
   *  sessions (e.g. `["GH_TOKEN"]` so the `gh` CLI authenticates). Each string is BOTH the vault key
   *  and the env var name, so it must be a valid identifier. Resolved at launch with principal = the
   *  agent (widening to the tenant-wide `*` default), and audited per key. This is the only path a
   *  vault secret reaches the interactive shell — connectors get theirs via the MCP bag — so it's
   *  deliberately explicit per agent. Undefined/empty → nothing is exported. */
  shellSecrets?: string[];
  /** Host-egress governance posture (Phase 2b — docs/host-connections-plan.md). Only takes effect when
   *  workspace host governance is enabled. `'open'` (default): public-internet egress stays plain
   *  shell.exec; only internal-looking or explicitly-listed hosts are governed. `'allowlist'` (lockdown):
   *  ANY detected egress to a host not in this agent's grants pauses/denies. Undefined → 'open'. */
  netMode?: 'open' | 'allowlist';
  /** The agent's visual icon. Either a built-in library id (a lucide icon name like `"Bot"`) or a raw
   *  custom `<svg>…</svg>` markup string the user uploaded. Undefined → the console falls back to a
   *  default glyph. Purely cosmetic. Rendered in an `<img>` so inline SVG can't execute scripts. */
  icon?: string;
  /** Absolute folder the manifest was loaded from — the cwd a claude-code session opens in. Set at load. */
  dir?: string;
}

/** Normalize+validate a runtime-tuning payload (from an API body or config file): drops empty
 *  strings to undefined and rejects out-of-set effort values. Returns the clean tuning plus any
 *  validation error (so callers can 400). Unknown model strings pass through — the CLI validates
 *  those, and aliases evolve faster than we'd want to hard-code. */
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

/** Per-tenant web-console branding — a small visual stamp so several tenants running in parallel
 *  (even across machines) are distinguishable at a glance: it recolours the sidebar accent and the
 *  browser-tab favicon, and tints the pre-login screen. Display-only, no secrets — safe to serve
 *  unauthenticated so the client can theme itself before login. Empty fields → the default look. */
export interface Branding {
  /** Accent colour as a 6-digit hex (`#7c3aed`). Undefined/empty → no override (default theme). */
  accentColor?: string;
  /** Favicon badge: an emoji (`🟣`) or a 1–3 char initial (`IP`). Undefined → first letter of the
   *  tenant name is used. Purely cosmetic. */
  badge?: string;
}

/** Normalize+validate a branding payload (from an API body): keeps only a well-formed 6-digit hex
 *  accent (else dropped, not an error — clearing it is valid) and a short badge (≤ 3 chars after
 *  trimming, so a single emoji or a couple of initials). Never throws; returns a clean object. */
export function sanitizeBranding(input: Partial<Record<keyof Branding, unknown>>): Branding {
  const out: Branding = {};
  const accent = typeof input.accentColor === 'string' ? input.accentColor.trim() : '';
  if (/^#[0-9a-fA-F]{6}$/.test(accent)) out.accentColor = accent.toLowerCase();
  const badge = typeof input.badge === 'string' ? [...input.badge.trim()].slice(0, 3).join('') : '';
  if (badge) out.badge = badge;
  return out;
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

/** Valid POSIX-ish env var / vault key name: a letter or underscore, then letters/digits/underscores.
 *  A `shellSecrets` entry is used verbatim as both the vault key and the exported shell variable, so
 *  it must satisfy this or the shell can't reference it. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalize a `shellSecrets` payload (from an API body or config file): coerce to an array of
 *  trimmed strings, drop anything that isn't a valid env-var name, dedupe (order-preserving), cap
 *  each at 64 chars and the list at 32. Returns undefined when the result is empty so the manifest
 *  carries no `shellSecrets` key at all. */
export function sanitizeShellSecrets(input: unknown): string[] | undefined {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/) // accept a comma/space/newline-separated string from a UI field too
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const k = x.trim().slice(0, 64);
    if (!ENV_NAME.test(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 32) break;
  }
  return out.length ? out : undefined;
}

/** Normalize an agent category label (from an API body or config file): trim, collapse internal
 *  whitespace, cap at 40 chars. Returns undefined when empty so an uncategorised agent's manifest
 *  carries no `category` key at all. */
export function sanitizeCategory(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const out = input.trim().replace(/\s+/g, ' ').slice(0, 40);
  return out || undefined;
}

/** Normalize an agent icon (from an API body or config file). Two accepted forms:
 *   - a built-in library id — a bare lucide icon name (`Bot`, `Wrench`); kept as-is if it's a plain
 *     identifier (the console maps it to a component, falling back to a default if unknown).
 *   - raw custom SVG markup — sanitised defensively below and capped in size.
 *  Anything else → undefined (the manifest carries no `icon` key → default glyph). */
export function sanitizeIcon(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (!raw) return undefined;
  if (/^<svg[\s>]/i.test(raw)) return sanitizeSvgIcon(raw);
  // A built-in library id: PascalCase-ish lucide name. Reject anything with markup/odd chars.
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(raw) ? raw : undefined;
}

/** Defensively clean an uploaded inline SVG so it's safe to persist and embed. The console renders it
 *  via an `<img src="data:image/svg+xml,…">`, which already prevents script execution, but we strip
 *  active content here too (defence in depth) and cap the size so a manifest can't be bloated. Returns
 *  undefined if the result no longer looks like a lone `<svg>…</svg>` element. */
export function sanitizeSvgIcon(input: string): string | undefined {
  if (input.length > 20000) return undefined; // ~20 KB — plenty for an icon, guards manifest bloat
  let s = input
    .replace(/<\?xml[\s\S]*?\?>/gi, '')                       // XML prolog
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')                      // doctype
    .replace(/<!--[\s\S]*?-->/g, '')                          // comments
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')            // scripts
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '') // arbitrary HTML embed
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '') // on* event handlers
    .replace(/\s(?:xlink:href|href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '') // js: links
    .trim();
  return /^<svg[\s\S]*<\/svg\s*>$/i.test(s) ? s : undefined;
}

/** Resolve the effective tuning for a launch: each field is the agent's own value, else the
 *  workspace default, else undefined (CLI default) — except `permissionMode`, whose floor is `auto`
 *  (the interactive lane always runs with a mode; the built-in default is `auto`, not the CLI's own).
 *  Pure — used by the terminal launcher. */
export function resolveRuntimeTuning(agent: RuntimeTuning, defaults: RuntimeTuning): RuntimeTuning {
  return {
    model: agent.model ?? defaults.model,
    effort: agent.effort ?? defaults.effort,
    permissionMode: agent.permissionMode ?? defaults.permissionMode ?? 'auto',
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
