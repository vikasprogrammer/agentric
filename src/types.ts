/**
 * Agentric — core types.
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
 * Per-member notification preferences — which session events raise an in-app notification for THIS
 * person, and through which channels. The inbox card itself is always written (audience-scoped as
 * before); these prefs only decide what pings the member: the console bell/toast counts (client-side
 * filtering) and whether the same event also DMs them on Slack/Discord (server-side, read by the
 * session-event notifier). Stored per member in `member_prefs`; every field defaults ON except the DM
 * push and sound, which are opt-in to avoid noise. Approvals/questions already DM their approver/owner
 * regardless — the `dm` toggle here governs the newer complete/waiting pushes.
 */
export interface NotificationPrefs {
  /** Which event kinds count toward this member's bell + surface a toast. */
  events: {
    completed: boolean;
    waiting: boolean;
    crashed: boolean;
    approval: boolean;
    question: boolean;
  };
  /** Show a transient toast when a new notification arrives while the console is open. */
  toasts: boolean;
  /** Play a short chime alongside a new toast. */
  sound: boolean;
  /** Also DM this member on Slack/Discord when one of their sessions completes or starts waiting. */
  dm: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  events: { completed: true, waiting: true, crashed: true, approval: true, question: true },
  toasts: true,
  sound: false,
  dm: false,
};

/** Merge a partial (possibly untrusted JSON) prefs object over the defaults so a stored row that
 *  predates a new field, or a bad payload, can never drop a setting. Unknown keys are ignored. */
export function sanitizeNotificationPrefs(input: unknown): NotificationPrefs {
  const p = (input && typeof input === 'object' ? input : {}) as Partial<NotificationPrefs>;
  const e = (p.events && typeof p.events === 'object' ? p.events : {}) as Partial<NotificationPrefs['events']>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const d = DEFAULT_NOTIFICATION_PREFS;
  return {
    events: {
      completed: bool(e.completed, d.events.completed),
      waiting: bool(e.waiting, d.events.waiting),
      crashed: bool(e.crashed, d.events.crashed),
      approval: bool(e.approval, d.events.approval),
      question: bool(e.question, d.events.question),
    },
    toasts: bool(p.toasts, d.toasts),
    sound: bool(p.sound, d.sound),
    dm: bool(p.dm, d.dm),
  };
}

/**
 * Which secondary nav items a member has pinned to the sidebar's primary ("Main") section — a
 * per-member preference stored alongside notification prefs in `member_prefs`. Values are opaque
 * nav-item keys owned by the console (`goals`, `tasks`, `memory`, …); the server only validates
 * shape (array of short, deduped strings). `null` means "never set" so the client falls back to its
 * default pin layout; `[]` means the member explicitly pinned nothing. The Inbox + Agents anchors
 * are not pinnable and never appear here.
 */
export function sanitizeNavPins(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (s && s.length <= 32 && !out.includes(s)) out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * A member-defined prompt shortcut — a named canned prompt they can fire into a live terminal session
 * with one click (the console's Quick Shortcuts strip). Purely a personal convenience stored in
 * `member_prefs`; the text is injected into the running claude exactly as if the human typed it, so
 * every effect it triggers is still governed by the gate. `id` is a stable client-minted handle used
 * only to key the list for edit/delete.
 */
export interface PromptShortcut {
  id: string;
  label: string;
  prompt: string;
}

export const PROMPT_SHORTCUT_MAX = 20;
export const PROMPT_SHORTCUT_LABEL_MAX = 40;
export const PROMPT_SHORTCUT_PROMPT_MAX = 2000;

/** Validate/normalize an untrusted shortcuts payload: drop anything malformed, trim + cap each field,
 *  synthesize a stable id when one is missing, and bound the list length. A shortcut with an empty
 *  label or empty prompt is dropped (both are required to be useful). */
export function sanitizePromptShortcuts(input: unknown): PromptShortcut[] {
  if (!Array.isArray(input)) return [];
  const out: PromptShortcut[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<PromptShortcut>;
    const label = String(r.label ?? '').trim().slice(0, PROMPT_SHORTCUT_LABEL_MAX);
    const prompt = String(r.prompt ?? '').trim().slice(0, PROMPT_SHORTCUT_PROMPT_MAX);
    if (!label || !prompt) continue;
    let id = String(r.id ?? '').trim().slice(0, 40);
    if (!id || seen.has(id)) id = `s${out.length + 1}`;
    seen.add(id);
    out.push({ id, label, prompt });
    if (out.length >= PROMPT_SHORTCUT_MAX) break;
  }
  return out;
}

/**
 * The external accounts a member is known by on other platforms — the join key that lets a chat
 * trigger (Slack/Discord) run AS the right person. One external id maps to at most one member
 * (enforced by the table's `(provider, external_id)` primary key), so run-as is never ambiguous.
 */
export type IdentityProvider = 'slack' | 'discord' | 'telegram' | 'email' | 'github';

/** The set of providers the identity map accepts — used to validate API input. */
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['slack', 'discord', 'telegram', 'email', 'github'];

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
  /**
   * Private-to-owners: when true, ONLY the owner role can run/see this agent — admins are
   * excluded and the role/member grants are void (the tightest tier, below the owner+admin
   * default). Only an owner may set or clear this flag. Absent/false → the default owner+admin floor.
   */
  ownerOnly?: boolean;
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
  type: 'cron' | 'webhook' | 'slack' | 'telegram' | 'email' | 'agent' | 'manual';
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

// ─────────────────────────────────────────────────────────────────────────────
// Decision Brief — the human-legible account of a gated effect (docs/decision-brief-layer-plan.md).
//
// One structured artifact, computed once at gate time next to `classify()`, that every governance
// consumer reads: the approval CARD body, the AUDIT narrative, and (later) the behavioural-failure
// detector + a richer policy match surface. It replaces "here is the raw tool JSON" with "here is what
// the agent is trying to do, on what, and why the gate cares". Deterministic — no LLM on the hot path.
// ─────────────────────────────────────────────────────────────────────────────

/** The coarse kind of action, for icon/wording. Derived from the capability + enriched facts. */
export type ActionVerb =
  | 'read' | 'write' | 'delete' | 'execute' | 'network' | 'deploy'
  | 'pay' | 'send' | 'grant' | 'other';

/** What the action acts ON — the object a human actually cares about (a host, a path, an amount). */
export interface BriefTarget {
  kind: 'file' | 'host' | 'db' | 'resource' | 'money' | 'recipient' | 'command' | 'unknown';
  /** Human label: "deploy.yml", "198.51.100.42 (ssh)", "$42.00", "3 rows". */
  label: string;
  /** When kind === 'host' — the bare egress host, the handle host-trust learning keys on (phase 2). */
  host?: string;
  /** For a file write, whether the target is outside the agent's own folder. */
  outsideWorkdir?: boolean;
  /** deleteCount / recipients / affected rows, when known. */
  count?: number;
  amountUsd?: number;
}

/** A human-legible account of a single gated effect. Every field is computable from the enriched
 *  attempt + decision — no I/O, no model call. See {@link ActionAttempt}, {@link Decision}. */
export interface DecisionBrief {
  /** One line: "Run a deploy-status check against Globex/docs on GitHub." */
  headline: string;
  verb: ActionVerb;
  target: BriefTarget;
  /** Why the gate cares (or didn't): "target host is not yet trusted", "writes to a production path". */
  rationale: string;
  riskClass: RiskClass;
  /** What a human most likely wants. `trust-host` (phase 2) turns a recurring host ask into a one-time
   *  trust decision; today the briefer only emits allow/approve/deny. */
  suggestedAction: 'allow' | 'approve' | 'trust-host' | 'deny';
  /** Stable, arg-normalised fingerprint of the action SHAPE (verb + capability + target family), NOT the
   *  exact bytes — the key the failure plane (phase 3) counts on to detect a loop. */
  signature: string;
  /** Optional raw facts for the card's "raw" drill-down / power users. Omitted when the facts already
   *  travel alongside the brief (e.g. embedded in a message's `args`). */
  facts?: Record<string, unknown>;
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
  /** Pending approvals that have sat past the escalation threshold and haven't been re-nudged yet — the
   *  source for the scheduler's stale-prompt reminder sweep. `minAgeMs`/`maxAgeMs` bound the window (older
   *  than min so a fresh gate isn't nagged; younger than max so an ancient/abandoned one isn't re-alarmed
   *  in a burst on the first sweep). Oldest first. */
  staleForEscalation(minAgeMs: number, maxAgeMs: number, now: number, tenant?: string): ApprovalRequest[];
  /** Stamp an approval's one-time escalation marker; true only the FIRST time, so the reminder fires once. */
  markEscalated(id: string, now: number): boolean;
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
/**
 * Auto-router tuning (Settings → Chat; stored as JSON under `router_config`). The router infers the
 * best-fit agent for an unaddressed chat/ticket message — see src/edge/router.ts. All fields optional;
 * sane defaults live in the router. A wrong SILENT route is the only bad outcome, so the thresholds
 * govern when to route silently vs. ask the human to disambiguate.
 */
export interface RouterConfig {
  /** Master switch. Unset → follows `chatRouterEnabled` (auto-route rides on the `/agent` front door).
   *  Explicit `false` keeps the classic name-only router with no inference. */
  enabled?: boolean;
  /** Viability floor (0..1 confidence) a candidate must clear to be considered at all. Below it → help
   *  list. Default 0.22. */
  minScore?: number;
  /** How strong the top candidate must be (0..1 confidence) to route SILENTLY. Viable but below this →
   *  ask the human. This is what keeps a weak-but-relatively-ahead match from silently mis-routing.
   *  Default 0.5. */
  routeConfidence?: number;
  /** Relative gap `(top-second)/top` (on the RAW score) the winner must ALSO clear to route silently.
   *  Below it → disambiguate. Default 0.15. */
  margin?: number;
  /** The router's OWN embedder for the semantic blend (cosine of message vs. agent profile). Falls back
   *  to the memory backend's local embedder (`memory.sqlite.embeddings`) when omitted — set this to route
   *  semantically on a tenant whose memory backend is automem/libsql (no local `Embedder`). Omit both →
   *  keyword-only. */
  embeddings?: EmbeddingsConfig;
  /** Optional cheap chat model for the near-tie tie-break (OpenAI-compatible `/chat/completions`).
   *  `url`/`apiKey` default to the resolved embedder's endpoint when omitted. No model → no LLM tie-break
   *  (near-ties just disambiguate). */
  llm?: { model: string; url?: string; apiKey?: string };
}

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
  /** Only meaningful while `status === 'blocked'` — see {@link TaskBlockedOn}. Absent = unstated. */
  blockedOn?: TaskBlockedOn;
  priority: number; // 0 urgent … 3 low
  labels: string[];
  assignee?: string; // member id | 'agent:<id>'
  owner?: string; // member id → run_as of the dispatched session; undefined → company identity
  parentId?: string;
  mode: 'headless' | 'interactive'; // how a dispatched session runs (default headless: work-to-completion)
  model?: string; // override the assignee agent's model for the dispatched session (undefined → agent/workspace default)
  effort?: Effort; // override the assignee agent's reasoning effort for the dispatched session
  autoDispatch: boolean;
  goalId?: string; // the strategic Goal this task advances (Slice 2 linkage)
  criteria?: string; // single-line acceptance condition; drives a headless run under a `/goal` on dispatch
  dependsOn?: string[]; // task ids this task is blocked by — it won't dispatch until they're done/cancelled
  callerAgent?: string; // 'agent:<id>' that delegated this task and wants a poke-back on completion
  callerClaudeId?: string; // the caller's pinned claude transcript id — resumed to deliver the poke
  pokeOnDone?: boolean; // wake the caller (resume its transcript) when this task reaches done/blocked
  dueAt?: number;
  attempts: number;
  lastSessionId?: string;
  createdBy: string; // member id | 'agent:<id>'
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

/**
 * Is this task still a **draft** — filed, but never acted on? True only when nothing has ever run for it:
 * no dispatch attempt, no `lastSessionId`, and no session linked to it (`runCount`, from
 * `TerminalManager.taskRuns`). A draft is just a note its author wrote — there is no run history to
 * erase, no cost attributed to it, and nobody downstream waiting on it — which is what lets its AUTHOR
 * delete it without an admin, and what the console labels so the looser rule reads as deliberate rather
 * than as a hole in the delete gate. The moment a session touches the task it stops being a draft,
 * permanently: a re-dispatch bumps `attempts` and the run stays in `taskRuns` even when archived.
 */
export function isDraftTask(task: Pick<Task, 'attempts' | 'lastSessionId'>, runCount: number): boolean {
  return task.attempts === 0 && !task.lastSessionId && runCount === 0;
}

/**
 * Why a task can't be dispatched right now (`Automations.canDispatch`). A code, not just prose, because a
 * surface reacts differently per case: `unassigned` needs an assignee picker, `live` needs an attach link,
 * `deps` is a wait not a fault, and `closed` means don't offer a run control at all.
 */
export type TaskDispatchBlock =
  | 'missing' | 'closed' | 'blocked' | 'unassigned' | 'unknown-agent' | 'live' | 'pool' | 'attempts' | 'deps';

/** Per-task run state for a surface that offers dispatch (the goal room's task list). `live` is a run whose
 *  pane is still up — the case where the right control is "attach", not "run again". */
export interface TaskRunState {
  can: boolean; // this member can dispatch it right now
  reason?: string; // why not, when `can` is false
  code?: TaskDispatchBlock;
  attempts: number;
  live?: { sessionId: string; agent: string; since: number };
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

/**
 * One entry in a task's **Discussion** — the merged conversation+activity timeline the task-detail view
 * renders (see `docs/task-rooms-plan.md`). Two shapes interleaved by time: a `chat` entry (a human/agent
 * message, from the `messages` store with `audience_kind:'task'`, plus folded-in legacy `comment` events)
 * and an `event` entry (a state transition from the append-only `task_events` log — status/claim/dispatch/
 * assign/link/attach). `author` is a member id | `agent:<id>` | `automation:<id>` | `system`.
 */
export type TaskTimelineEntry =
  | { kind: 'chat'; id: string; author: string; agentId?: string; body: string; mentions: string[]; at: number }
  | { kind: 'event'; id: string; eventKind: TaskEvent['kind']; body?: string; author: string; at: number };

/** Per-task Discussion rollup for the board/list cards: unread count for the viewer, the last message
 *  (preview), and the set of participants (humans + agents) — see `docs/task-rooms-plan.md`. */
export interface TaskDiscussionSummary {
  unread: number;
  last?: { body: string; author: string; agentId?: string };
  participants: string[]; // member id | 'agent:<id>' | 'system'
}

/**
 * One RUN of a task — a session that worked it. A task is a durable unit of work and a session is one
 * attempt at it, so the relationship has always been one-to-MANY: every dispatch, re-dispatch after a
 * crash, mention-spawned run and human take-over spawns its own session. Only the newest was reachable
 * (`Task.lastSessionId`, the pile-up guard's pointer), so a task that succeeded on attempt #3 looked
 * like it had always been fine. This is the full list, oldest-first — see {@link TerminalManager.taskRuns}.
 */
export interface TaskRun {
  id: string; // session id
  agent: string;
  status: string; // running | done | stopped | crashed
  outcome?: string; // success | failure | partial | … (from the run's own `report`)
  summary?: string; // the report's one-line summary
  createdAt: number;
  endedAt?: number; // last activity (undefined while running)
  costUsd?: number;
  turns?: number;
  /** How this session came to work the task: `dispatch` = spawned FOR it (`task:<id>` provenance);
   *  `linked` = a session that touched it from elsewhere (an agent's `task_claim`, a discussion run). */
  link: 'dispatch' | 'linked';
  current: boolean; // this is the task's `lastSessionId` — the run the guard/reconciler tracks
  alive: boolean; // its pane is still live right now
  archived: boolean; // soft-archived out of the Sessions list (still part of the task's history)
}

/**
 * What happened to a plain human message posted into a task's Discussion, BEYOND storing it: the room is
 * where work is watched, so a reply there should reach the run doing the work. See
 * `Automations.postTaskDiscussion`.
 *
 * - `none` — no live run on the task; the message is just the record (the agent reads it on its next
 *   `task_get`, or when the task is re-dispatched).
 * - `delivered` — typed into the live pane (runs now if the agent is idle, queues to the next turn if busy).
 * - `answered` — the run was BLOCKED on an `ask`; the message answered it, which unblocks the turn.
 * - `choose` — MORE THAN ONE live run, so nothing was delivered: the human picks which one they meant and
 *   the client re-posts the delivery with `deliverTo`. Never guessed — the wrong pick talks to the wrong worker.
 * - `stale` — an explicit `deliverTo` whose run has ended since the choice was offered.
 * - `undeliverable` — the run is alive but the keystrokes didn't land (unreadable pane / dead socket).
 */
export interface TaskDiscussionDelivery {
  status: 'none' | 'delivered' | 'answered' | 'choose' | 'stale' | 'undeliverable';
  sessionId?: string;
  agent?: string;
  /** Only on `choose`: the live runs to pick between. */
  runs?: { sessionId: string; agent: string; blocked: boolean }[];
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
  model?: string; // override the dispatched session's model (validated via sanitizeRuntimeTuning at the API edge)
  effort?: Effort; // override the dispatched session's reasoning effort
  autoDispatch?: boolean;
  goalId?: string; // link to a strategic Goal (Slice 2)
  criteria?: string; // single-line acceptance condition → `/goal` convergence on a headless dispatch
  dependsOn?: string[]; // task ids this task is blocked by (won't dispatch until they finish)
  callerAgent?: string; // 'agent:<id>' delegating this task — poked back on completion (poke-on-done)
  callerClaudeId?: string; // the caller's pinned claude transcript id (for the resume-poke)
  pokeOnDone?: boolean; // resume the caller's transcript when this task reaches done/blocked
  dueAt?: number;
  createdBy: string; // member id | 'agent:<id>'
}

/**
 * What a `blocked` task is waiting on — declared by the delegate that blocked it, never inferred from its
 * note. It decides WHO gets woken: `human` routes the wake-up to the task's owner alone (the inbox card +
 * DM they already get), because waking the caller AGENT for a decision only a person can make just spends
 * a resumed run restating that it is blocked. `agent`/`external` keep the caller wake — there the caller
 * can actually re-scope, route around, or chase the blocker.
 *
 * Measured on northwind 2026-08-17 before this existed: `tsk_f81b27d7` ("blocked on human approval for the
 * merge") woke prod-monitor, which replied "Leaving this blocked — I am not merging it and neither should
 * any agent" and ended; `tsk_5aa0fd20` ("no deletions without founder sign-off") woke agent-author the same
 * way. Both correct, both a wasted resume on a large transcript.
 */
export type TaskBlockedOn = 'human' | 'agent' | 'external';

export const TASK_BLOCKED_ON: readonly TaskBlockedOn[] = ['human', 'agent', 'external'];

export interface TaskUpdateInput {
  title?: string;
  body?: string;
  status?: TaskStatus;
  assignee?: string | null; // null clears the assignee
  priority?: number;
  labels?: string[];
  mode?: 'headless' | 'interactive';
  goalId?: string | null; // link/unlink (null) the strategic Goal
  criteria?: string | null; // set/clear (null) the acceptance condition
  dependsOn?: string[]; // replace the dependency set (task ids this task is blocked by); [] clears it
  dueAt?: number | null; // epoch ms soft deadline; null clears it
  blockedOn?: TaskBlockedOn | null; // with status:'blocked' — what it waits on; null clears it
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
// Goals — the strategic layer work ladders up to (Goal → Task → Session). Human-owned,
// tenant-wide, persistent; agents read + propose, humans decide. See docs/goals-plan.md.
// ─────────────────────────────────────────────────────────────────────────────

export type GoalStatus = 'draft' | 'active' | 'achieved' | 'abandoned';

export interface Goal {
  id: string;
  tenant: string;
  title: string;
  body: string; // markdown "what / why" narrative
  status: GoalStatus;
  target?: string; // free-text target caption (v1); numeric/derived metrics come later
  owner?: string; // member id accountable for the goal
  parentId?: string; // hierarchy: strategy → objective → key result
  labels: string[];
  dueAt?: number; // optional soft horizon (epoch ms)
  createdBy: string; // member id | 'agent:<id>'
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  // `ready` = every linked task finished; the derived completion signal, and the once-guard for its notice.
  // `task` = a MILESTONE on a task linked to this goal (filed / started / blocked / done / cancelled),
  //          derived at read time from `task_events` — never a stored `goal_events` row. See
  //          {@link GoalStore.timeline}: the work under a goal is most of the goal's story, and a copy
  //          written at mutation time would both duplicate state and miss every task that moved before
  //          the feature existed.
  kind: 'status' | 'comment' | 'edit' | 'link' | 'ready' | 'task';
  body?: string;
  author: string; // member id | 'agent:<id>' | 'system'
  createdAt: number;
  /** Set only on `kind: 'task'` — which linked task moved, and how. */
  task?: GoalEventTask;
}

/** The task a `kind: 'task'` timeline entry is about. `verb` is the milestone, normalised from the task's
 *  own event (a `dispatch` row and a `→doing` transition both mean "work started"). */
export interface GoalEventTask {
  id: string;
  title: string;
  status: TaskStatus; // the task's status NOW (the entry says what it did THEN)
  verb: 'filed' | 'started' | 'blocked' | 'done' | 'cancelled' | 'reopened';
  /** The session the milestone happened in, when the task event carried one — the way into the run. */
  sessionId?: string;
}

export interface GoalCreateInput {
  tenant: string;
  title: string;
  body?: string;
  status?: GoalStatus; // default 'active' (console) — the agent propose path passes 'draft'
  target?: string;
  owner?: string;
  parentId?: string;
  labels?: string[];
  dueAt?: number;
  createdBy: string; // member id | 'agent:<id>'
}

export interface GoalUpdateInput {
  title?: string;
  body?: string;
  status?: GoalStatus;
  target?: string | null; // null clears the target caption
  owner?: string | null; // null clears the owner
  parentId?: string | null; // null detaches from a parent
  labels?: string[];
  dueAt?: number | null; // null clears the horizon
  note?: string; // free-text comment → appended as a goal_event
  by: string; // author (member id | 'agent:<id>')
}

export interface GoalQuery {
  tenant: string;
  status?: GoalStatus;
  ownerId?: string;
  parentId?: string;
  query?: string; // FTS over title/body/labels
  limit?: number;
}

/** A goal's progress, DERIVED from the tasks linked to it (never hand-maintained). */
export interface GoalProgress {
  total: number; // all linked tasks
  done: number; // linked tasks in `done`
  counted: number; // total minus cancelled (the denominator for percent)
  percent: number; // done ÷ counted, 0–100 (0 when nothing linked)
  byStatus: Record<TaskStatus, number>;
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

/** How much prose a session spends on its own narration. `normal` is the runtime's own voice;
 *  `terse` appends a compression brief to the system prompt (see `TERSE_OUTPUT_BRIEF`) that strips
 *  filler from the agent's reasoning and commentary while leaving code, commands, errors and every
 *  durable artifact byte-exact. Output tokens are the priciest per token AND become input + cache-write
 *  on the next turn, so terser narration compounds — but it is a PROMPT instruction, not an enforced
 *  transform: treat the saving as measured (Settings → Runtime defaults), never as assumed. */
export type Verbosity = 'normal' | 'terse';
export const VERBOSITIES: readonly Verbosity[] = ['normal', 'terse'];

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
  /** Narration verbosity. Undefined → `normal` once resolved. Rides the appended system prompt (both
   *  runtimes), not a CLI flag — so it applies wherever `buildCompanyMd` reaches. */
  verbosity?: Verbosity;
}

/** Every runtime an agent manifest may declare. `mock` is the in-process demo adapter (no CLI, no
 *  tmux); the others are real coding CLIs. */
export type RuntimeId = 'mock' | 'claude-code' | 'codex';
/** The runtimes that spawn a real CLI in a governed tmux pane — everything except `mock`. */
export type CodingRuntimeId = Exclude<RuntimeId, 'mock'>;

/**
 * What a coding runtime can actually do.
 *
 * These differ enough between CLIs that call sites MUST probe a capability rather than compare
 * runtime ids — `runtime === 'claude-code'` was the old shorthand for "a real agent", and widening
 * the union turned every one of those into a latent bug. Use {@link isCodingRuntime} for the
 * "is this a real agent at all" question and a named flag for anything finer.
 *
 * The two governance flags (`fileWriteGate`, `mcpGate`) describe how the invariant is upheld, NOT
 * whether it is: Claude Code intercepts file writes and MCP calls at the PreToolUse hook, while
 * Codex's hook only sees the `shell` tool — so a Codex session instead confines writes with an OS
 * sandbox (`writable_roots`) and relies on the loopback API to govern MCP calls server-side. Both
 * routes close the hole; only the mechanism changes.
 */
export interface RuntimeCapabilities {
  /** Can the OS CHOOSE the transcript id up front? Claude takes `--session-id <uuid>`; Codex mints
   *  its own rollout id, so the launcher has to capture and report it back after the fact. */
  pinnedSessionId: boolean;
  /** Can a prior conversation be continued by id? */
  resume: boolean;
  /** Can a conversation be branched, leaving the parent transcript intact? */
  fork: boolean;
  /** Does an UNATTENDED run stay attachable so a human can take it over mid-turn? True when the
   *  unattended lane is an interactive TUI torn down by the server at turn-end (Claude); false when
   *  it is a one-shot process that exits on its own (Codex `exec`). */
  attachableUnattended: boolean;
  /** Can a warm chat session be kept resident and fed follow-ups via tmux send-keys? Needs an
   *  interactive TUI that survives a turn — so it tracks `attachableUnattended`. */
  residentChat: boolean;
  /** Does the OS know how to parse this CLI's transcript into cost + engaged-time + a chat timeline? */
  transcript: boolean;
  /** Native Agent Skills discovered from a project directory (`.claude/skills`). */
  nativeSkills: boolean;
  /** Native in-process sub-agents (`.claude/agents`). */
  nativeSubagents: boolean;
  /** A custom status line renderer. */
  statusLine: boolean;
  /** Honours {@link RuntimeTuning.permissionMode}. */
  permissionMode: boolean;
  /** Does the PreToolUse hook intercept FILE WRITES? False → containment is the OS sandbox instead. */
  fileWriteGate: boolean;
  /** Does the PreToolUse hook intercept MCP/connector tool calls? False → those are governed
   *  server-side at the loopback API, which every OS tool already goes through. */
  mcpGate: boolean;
  /** Can the gate steer the model on an ALLOW (Claude's `additionalContext`)? Codex's hook contract
   *  acts on `deny` only, so the `instruct` verb degrades to a plain allow there. */
  steerOnAllow: boolean;
}

/** How a pooled runtime account carries its credential: 'oauth' → a credential DIRECTORY produced by the
 *  CLI's own login; 'apikey' → a usage-billed key in the vault; 'token' → a long-lived OAuth token in the
 *  vault. Declared here (not in the store) because {@link CodingRuntimeSpec.liveCredentialKinds} is what
 *  decides which of them a runtime can actually be launched with. */
export type RuntimeAccountKind = 'oauth' | 'apikey' | 'token';

/** Static description of a coding runtime: which binary drives it, which launch script + gate hook
 *  wire it to the gateway, and what it supports. The single place a new CLI is declared. */
export interface CodingRuntimeSpec {
  id: CodingRuntimeId;
  /** Human-facing name for the console + error messages. */
  label: string;
  /** The executable that must be on PATH for a session to launch. */
  bin: string;
  /** Basename of the launcher under `terminal/`. */
  launchScript: string;
  /** Basename of the PreToolUse gate hook under `terminal/`. */
  gateHook: string;
  /** How to point a session at a SPECIFIC account's credentials, for launch-time account rotation across a
   *  pool (see `RuntimeAccountStore`). `configDirVar` is the env var that relocates the runtime's credential
   *  directory — claude reads `$CLAUDE_CONFIG_DIR/.credentials.json`; codex's launcher symlinks `auth.json`
   *  from `$AOS_REAL_CODEX_HOME`. `apiKeyVar` is the usage-billed API-key env (`ANTHROPIC_API_KEY` /
   *  `OPENAI_API_KEY`). Rotation exports ONE of these per session; both unset → the runtime uses the box's
   *  default single account, i.e. today's behavior. Generic so a third runtime slots in by declaring its
   *  own two vars — no rotation code changes. `tokenVar` (optional) is a long-lived OAuth-token env the
   *  runtime accepts for headless auth (claude: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) — the
   *  cleanest rotation credential (a vault-stored token, no config dir); a runtime without one (codex) omits it. */
  credentialEnv: { configDirVar: string; apiKeyVar: string; tokenVar?: string;
    /** The credential file the config dir must actually contain (`.credentials.json` / `auth.json`).
     *  A dir naming a file that isn't there is not a usable account: the CLI doesn't fall back to the
     *  box login, it opens its interactive login picker and the session hangs there. */
    configDirFile: string };
  /**
   * Which account KINDS actually authenticate this runtime **in the lane the OS launches it in** — an
   * attachable interactive TUI for every run, unattended included (see `attachableUnattended`). Declaring a
   * credential env var is NOT the same as that credential working: `claude` honours
   * `CLAUDE_CODE_OAUTH_TOKEN` in print mode (`claude -p`) only. In the TUI it ignores the env token and
   * silently runs on whatever `~/.claude/.credentials.json` holds — while its splash still prints
   * "Claude API", so the substitution looks like it worked. Verified on the globex box 2026-08-04 against a
   * pool token at weekly 9% and a box account at weekly 100%: print mode answered, the TUI refused with the
   * BOX account's limit + reset time, and token-plus-empty-config-dir dropped to the login picker (so there
   * is no env-token auth path at all). `pick()` filters on this, so an account of an unlisted kind is never
   * selected — better an honest box-default launch than a stamped rotation that didn't happen.
   */
  liveCredentialKinds: readonly RuntimeAccountKind[];
  /** Can the console drive this runtime's own login to PRODUCE a credential dir (see
   *  `src/edge/runtime-login.ts`)? True only where the flow has been walked end to end — it presses Enter
   *  on prompts it recognises, so claiming it for an unverified CLI would strand operators mid-flow.
   *  False → the console still accepts a credential dir added by path. */
  guidedLogin: boolean;
  /** A few known-good model ids, offered as suggestions in the console. NOT an allowlist — a custom or
   *  newer id must still be settable, so validation only rejects ids that clearly belong to ANOTHER
   *  runtime (see `foreignModel`). */
  suggestedModels: readonly string[];
  /** Matches a model id belonging to a DIFFERENT runtime. This is the one model mistake worth blocking:
   *  agents carry a pinned `model`, so flipping a Claude agent to Codex would silently hand
   *  `claude-opus-4-8` to `codex --model` and break every run. Deliberately narrow — it rejects the
   *  obvious cross-family id and lets anything else through. */
  foreignModel: RegExp;
  capabilities: RuntimeCapabilities;
}

export const CODING_RUNTIMES: Readonly<Record<CodingRuntimeId, CodingRuntimeSpec>> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    bin: 'claude',
    launchScript: 'claude-launch.sh',
    gateHook: 'gate-hook.sh',
    credentialEnv: { configDirVar: 'CLAUDE_CONFIG_DIR', apiKeyVar: 'ANTHROPIC_API_KEY', tokenVar: 'CLAUDE_CODE_OAUTH_TOKEN', configDirFile: '.credentials.json' },
    // Credential-dir ONLY. `tokenVar` stays declared because `claude -p` honours it (and the add-time probe
    // uses the same token), but no OS lane runs print mode — see liveCredentialKinds. `ANTHROPIC_API_KEY` is
    // left out for the same reason it was never proven: an unverified kind must not be silently selectable.
    liveCredentialKinds: ['oauth'],
    guidedLogin: true,
    suggestedModels: ['claude-opus-4-8', 'claude-sonnet-4-8', 'claude-haiku-4-5'],
    foreignModel: /^(gpt|o[0-9]|codex|glm|kimi|deepseek)\b/i,
    capabilities: {
      pinnedSessionId: true, resume: true, fork: true, attachableUnattended: true,
      residentChat: true, transcript: true, nativeSkills: true, nativeSubagents: true,
      statusLine: true, permissionMode: true, fileWriteGate: true, mcpGate: true,
      steerOnAllow: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    launchScript: 'codex-launch.sh',
    // Same hook binary as Claude Code: Codex 0.145 uses identical PreToolUse stdin fields
    // (`tool_name`/`tool_input`/`agent_type`) and an identical decision wire, so only the
    // tool→capability routing table differs — selected inside the hook by $AOS_RUNTIME. Sharing the
    // file keeps the fail-closed retry + approval-wait logic in ONE place; two copies would let a
    // security fix land in one runtime and silently miss the other.
    gateHook: 'gate-hook.sh',
    // Codex reads auth.json from the dir the launcher symlinks (AOS_REAL_CODEX_HOME → $CODEX_HOME/auth.json);
    // OPENAI_API_KEY is the usage-billed alternative the launcher already accepts.
    credentialEnv: { configDirVar: 'AOS_REAL_CODEX_HOME', apiKeyVar: 'OPENAI_API_KEY', configDirFile: 'auth.json' },
    // Both are read by codex-launch.sh itself (it symlinks auth.json from AOS_REAL_CODEX_HOME and passes
    // OPENAI_API_KEY through), so unlike claude's token var these are wired by OUR launcher rather than
    // hoped for from the CLI. No tokenVar to list.
    liveCredentialKinds: ['oauth', 'apikey'],
    // `codex login` has its own prompt sequence; nobody has walked it through this flow yet.
    guidedLogin: false,
    suggestedModels: ['gpt-5-codex', 'gpt-5.6-sol'],
    // Bare ALIASES matter as much as full ids: the workspace default is often just `opus`,
    // and Codex answers `The 'opus' model is not supported` — seen live. Anchor on a word
    // boundary so `opus` and `claude-opus-4-8` are both caught but a hypothetical
    // `opusgpt-x` custom id is not.
    foreignModel: /^(claude|opus|sonnet|haiku|fable)\b/i,
    capabilities: {
      // Codex mints its own rollout id (`codex exec resume <id>` / `codex fork <id>`), so the id is
      // captured after launch rather than pinned. The unattended lane is `codex exec`, which exits at
      // turn end — no Stop hook needed, but also nothing to attach to, which rules out resident chat.
      pinnedSessionId: false, resume: true, fork: true,
      // Attachable since v0.281.0. Codex refuses to run a hook whose hash it hasn't recorded as trusted,
      // and `--dangerously-bypass-hook-trust` is ignored in TUI mode (openai/codex#24093), which used to
      // force every run down `codex exec`. The launcher now PRE-SEEDS the trust hash, so the TUI runs
      // fully governed — and `guardHookTrust` kills any session that still shows the review prompt, so a
      // stale hash after a Codex upgrade fails loud instead of letting someone opt out of the gate.
      attachableUnattended: true, residentChat: true,
      // Codex's rollout JSONL is parsed by src/edge/codex-transcript.ts, so cost / engaged time /
      // turns / tool calls and the friendly chat timeline all work.
      transcript: true, nativeSkills: false, nativeSubagents: false,
      statusLine: false, permissionMode: false,
      // PreToolUse covers Bash, apply_patch AND mcp__* — verified empirically against codex 0.145 (its
      // hook reports Claude's exact tool names). So the gate, not just the sandbox, governs writes and
      // connector calls; the sandbox's `writable_roots` is now defence in depth rather than the only line.
      fileWriteGate: true, mcpGate: true,
      // Codex 0.145's PreToolUse output wire matches Claude's: permissionDecision allow|deny|ask plus
      // `additionalContext` (verified against the JSON schema embedded in the binary), so the gate's
      // `instruct` verb carries over unchanged.
      steerOnAllow: true,
    },
  },
};

/** Is this a real CLI-backed agent (as opposed to the `mock` demo adapter)? This is what almost every
 *  former `runtime === 'claude-code'` check actually meant. */
export function isCodingRuntime(runtime: RuntimeId | undefined): runtime is CodingRuntimeId {
  return runtime === 'claude-code' || runtime === 'codex';
}

/** The spec for a runtime, or undefined for `mock`/unknown. */
export function codingRuntime(runtime: RuntimeId | undefined): CodingRuntimeSpec | undefined {
  return isCodingRuntime(runtime) ? CODING_RUNTIMES[runtime] : undefined;
}

/** Does `runtime` support `cap`? False for `mock` and unknown runtimes. */
export function runtimeSupports(runtime: RuntimeId | undefined, cap: keyof RuntimeCapabilities): boolean {
  return codingRuntime(runtime)?.capabilities[cap] ?? false;
}


/** Reject a model id that plainly belongs to another runtime. Returns an error string, or undefined
 *  when the id is acceptable (including any unknown/custom id — this is a guard, not an allowlist). */
export function validateModelForRuntime(runtime: RuntimeId | undefined, model: string): string | undefined {
  const spec = codingRuntime(runtime);
  if (!spec || !model) return undefined;
  if (!spec.foreignModel.test(model)) return undefined;
  return `"${model}" is not a ${spec.label} model. Try one of: ${spec.suggestedModels.join(', ')} — or clear the field to inherit the workspace default.`;
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
  /** Which coding CLI drives this agent. `mock` is the in-process demo adapter; the rest are real
   *  CLIs launched in a tmux pane and governed by a PreToolUse gate hook. See {@link CODING_RUNTIMES}
   *  for what each one can actually do — capabilities differ, so probe rather than compare ids. */
  runtime: RuntimeId;
  budget: Budget;
  /** Coding-runtime extras. */
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
  /** Opt-in list of OTHER fleet agent ids this agent may spawn as **native Claude Code sub-agents**
   *  (the built-in `Agent`/Task tool). At launch each named agent's manifest + persona (its CLAUDE.md)
   *  is materialised into this agent's `.claude/agents/<id>.md`, so the running claude can delegate a
   *  slice of its OWN turn to a teammate in-process (sub-second, no separate governed session) — the
   *  lightweight counterpart to `task_dispatch`. Every effect the sub-agent has still passes the
   *  PreToolUse gate hook (attributed to THIS session's principal + budget, tagged with the sub-agent's
   *  `agent_type`), and the sub-agent's toolset is capped to {@link SUBAGENT_DEFAULT_TOOLS} — never the
   *  egress/secret tools. Undefined/empty → this agent spawns no fleet sub-agents. Self-references and
   *  non-claude-code / unknown ids are ignored. See docs/subagents-plan.md. */
  usableSubagents?: string[];
  /** Consent to being spawned as another agent's native sub-agent (Lever: `usableSubagents`). Default
   *  `true`. Set `false` to mark this agent **internal** — it is NEVER materialised into any other
   *  agent's `.claude/agents/`, so no one can adopt its persona as a sub-agent, regardless of the
   *  fleet-wide `subagentDefault` posture OR another agent's explicit `usableSubagents` list (the
   *  opt-out is absolute — a hard "don't spawn me"). Use for governance-sensitive personas (trust &
   *  safety, a destructive migrator) you don't want silently run under someone else's identity/budget. */
  spawnableAsSubagent?: boolean;
  /** The inverse of {@link spawnableAsSubagent}: this agent is reachable ONLY as a sub-agent, never as a
   *  task assignee. Default `false` (both paths open).
   *
   *  For a delegate whose only reason to be separate is a FRESH CONTEXT — a reviewer, a second opinion, a
   *  critic — a whole governed session is the expensive way to buy that. A sub-agent already gives the
   *  isolation (its own context, capped toolset, no sight of the caller's reasoning) in-process, without
   *  a launch, an MCP boot, a CLAUDE.md reload or a tmux pane. Measured on the live instawp fleet: the
   *  `code-reviewer` agent was documented in engineer's own prompt as a sub-agent AND still received 12
   *  task hand-offs in 7 days, which spawned 8 governed sessions costing **$111** to do what the
   *  sub-agent path does for a fraction of that.
   *
   *  Set `true` only when a fresh context is the ONLY thing the separation buys. It is the wrong flag for
   *  a delegate that needs its own CREDENTIALS (a sub-agent runs under the caller's principal and budget),
   *  that runs LONG or on shared infrastructure (it would hold the caller's turn open — instawp's `qa`
   *  averages 20 minutes provisioning sandboxes and contending for a devX lock), that must survive the
   *  caller's turn, or that must observe the work INDEPENDENTLY over time rather than answer one question.
   *
   *  Enforced on the agent lane only (`POST /api/tasks/create`): a human deliberately dispatching a
   *  session from the console is a considered act, not the reflex this guards. */
  subagentOnly?: boolean;
  /** Whether this agent is reachable from the OPEN chat router — a `/agent-os <id>` / `/<id>` message on
   *  Slack, Discord, or a ClickUp task comment. Default `true`. Set `false` to keep the agent OFF the
   *  external front door (excluded from `routeChat` + the addressable-agent help list), so a comment can't
   *  invoke it. It can still be run from the console, tasks, delegation, or an explicitly-configured
   *  automation — this only closes the open `/agentname` router. Use for supervisor/ops personas (e.g. a
   *  `ceo` triage agent) you don't want anyone spawning from a shared comment thread. */
  chatReachable?: boolean;
  /** The agent's visual icon. Either a built-in library id (a lucide icon name like `"Bot"`) or a raw
   *  custom `<svg>…</svg>` markup string the user uploaded. Undefined → the console falls back to a
   *  default glyph. Purely cosmetic. Rendered in an `<img>` so inline SVG can't execute scripts. */
  icon?: string;
  /** Absolute folder the manifest was loaded from — the cwd a claude-code session opens in. Set at load. */
  dir?: string;
}

/** An **App** — a small server-side app (a mini-CRM, an internal mini-tool) hosted inside a tenant,
 *  built by agents + humans (never seeded). Reached at `/apps/<slug>/…` through the authenticated
 *  reverse-proxy the terminal uses; run as a supervised, (on Linux) uid-isolated Node process with its
 *  own SQLite. See docs/apps-plan.md. The manifest lives at `<home>/apps/<slug>/app.json`; the source
 *  it runs is `<home>/apps/<slug>/<entry>`, and its private data is `<home>/apps/<slug>/data.db`. */
export interface AppManifest {
  /** DNS-safe slug — the `/apps/<slug>` path segment and the app's principal (`app:<slug>`). */
  id: string;
  /** Human-facing name shown in the console + nav. */
  name: string;
  /** Cosmetic icon — a lucide id or raw `<svg>` markup, same convention as an agent's `icon`. */
  icon?: string;
  /** Node entry, relative to the app folder. The process MUST bind `process.env.PORT` and honour the
   *  injected `X-Forwarded-Prefix` when building absolute URLs. Default `app/server.js`. */
  entry: string;
  /** `scale-to-zero` (default): cold-start on first request, idle-killed after `idleTimeoutSec`.
   *  `resident`: kept warm (restart-on-crash), never idle-killed. */
  lifecycle: 'scale-to-zero' | 'resident';
  /** Idle seconds before a scale-to-zero app is torn down (no effect when `resident`). Default 900. */
  idleTimeoutSec?: number;
  /** The governance contract — default-deny. Enforced at the boundary (proxy + `/api/app/*`), never by
   *  trusting the app's own code. */
  capabilities: AppCapabilities;
  /** The accountable human (email) — the default `run_as` for a background agent dispatch. */
  owner?: string;
  /** Provenance of authorship (e.g. `agent:app-builder` or a member email). Display/audit only. */
  createdBy?: string;
  /** Whether this app has been published (routable + launchable). A proposed app stays inert until an
   *  owner/admin publishes it — the code-review gate. Undefined/false → proposed. */
  published?: boolean;
  /** Custom domains bound to this app (`my.tool.com`). A request whose Host matches serves THIS app at
   *  the domain root — a separate origin from the console, so it is reached WITHOUT a console login
   *  (public). Only a published app's domains are live. DNS + TLS are external (point a record at the
   *  box). Owner/admin only. See docs/apps-plan.md §9. */
  domains?: string[];
  /** Bumped per saved revision (the rollback backbone). */
  version?: number;
  /** Absolute folder the manifest was loaded from. Set at load; never persisted. */
  dir?: string;
}

/** An App's declared, default-deny capabilities. Anything not listed is denied at the boundary. */
export interface AppCapabilities {
  /** Agent ids this app may trigger in the background via `/api/app/dispatch`. Empty ⇒ none. */
  dispatchAgents?: string[];
  /** Outbound network. Default false ⇒ (on Linux) the process runs with egress denied. */
  egress?: boolean;
  /** Vault keys injected into the app's env at launch + readable via `/api/app/secret/get`. */
  secrets?: string[];
  /** Dependency posture: `stdlib` (Node built-ins + provided helpers, default), `vendored` (curated
   *  allowlist), or `npm` (arbitrary deps — a reviewed capability, installed at build not runtime). */
  dependencies?: 'stdlib' | 'vendored' | 'npm';
}

/** A DNS-safe app slug: lowercase alphanumeric + single hyphens, 1–32 chars, no leading/trailing/double
 *  hyphen. Same shape as a tenant slug — it becomes a URL segment and a process principal. */
export function isValidAppSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug) && !slug.includes('--');
}

/** Normalize+validate an App capabilities payload (API body / config file). Never throws; drops junk
 *  and clamps to the known shape so a malformed manifest can't silently widen the default-deny grant. */
export function sanitizeAppCapabilities(input: unknown): AppCapabilities {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const out: AppCapabilities = {};
  if (Array.isArray(raw.dispatchAgents)) {
    const agents = raw.dispatchAgents.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
    if (agents.length) out.dispatchAgents = [...new Set(agents)];
  }
  if (raw.egress === true) out.egress = true;
  if (Array.isArray(raw.secrets)) {
    const keys = raw.secrets.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
    if (keys.length) out.secrets = [...new Set(keys)];
  }
  if (raw.dependencies === 'vendored' || raw.dependencies === 'npm') out.dependencies = raw.dependencies;
  else out.dependencies = 'stdlib';
  return out;
}

/** Normalize a custom-domains payload: lowercase, trim, strip a scheme/port/path if pasted, keep only
 *  syntactically valid hostnames (a dotted DNS name — no bare `localhost`, no IPs), dedupe, cap at 10.
 *  Never throws; drops junk so a malformed entry can't shadow the console or another app by accident. */
export function sanitizeAppDomains(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    let h = raw.trim().toLowerCase();
    h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0].trim(); // strip scheme/path/port if pasted
    // A real dotted hostname: labels of alphanumerics/hyphens, at least one dot, valid TLD-ish tail.
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out.slice(0, 10);
}

/**
 * Build the sanitize input for a PARTIAL tuning edit: **an absent key keeps the agent's current value;
 * a present one (including `''`/null) replaces it.** Every other field on the agent-config route already
 * works this way (`'examplePrompts' in b ? … : ag.examplePrompts`); the tuning fields did not, so a body
 * carrying one knob silently cleared the rest — a `{verbosity:'terse'}` save unpinned an agent's model
 * and dropped it onto the fleet default, with nothing in the response to say so. Found live on the
 * northwind consolidator.
 *
 * "Clear to inherit" still works, and is now explicit rather than a side effect of omission: send the
 * key as `''`. Callers that render a whole form (the console's runtime card) should send every field
 * they own, empties included — note `JSON.stringify` DROPS `undefined` values, so spreading a
 * `RuntimeTuning` with cleared fields transmits no key at all and would otherwise read as "don't touch".
 *
 * `fields` limits which knobs a caller may patch: the agent self-edit path passes model/effort/verbosity
 * only, so an agent can't hand itself a permission mode (governance-sensitive — humans set that).
 * `dropModel` covers the runtime switch: a pinned `claude-*` model can't run on Codex, so when the
 * runtime changes and the body doesn't name a replacement, the inherited one is dropped rather than
 * carried into a validation error the human didn't cause.
 */
export function runtimeTuningPatch(
  body: Partial<Record<keyof RuntimeTuning, unknown>>,
  current: RuntimeTuning,
  opts: { fields?: ReadonlyArray<keyof RuntimeTuning>; dropModel?: boolean } = {},
): Partial<Record<keyof RuntimeTuning, unknown>> {
  const fields = opts.fields ?? (['model', 'effort', 'permissionMode', 'verbosity'] as const);
  const out: Partial<Record<keyof RuntimeTuning, unknown>> = {};
  for (const f of fields) {
    if (f in body) out[f] = body[f];
    else if (f === 'model' && opts.dropModel) continue; // switching runtime — don't carry a foreign model
    else out[f] = current[f];
  }
  return out;
}

/** Normalize+validate a runtime-tuning payload (from an API body or config file): drops empty
 *  strings to undefined and rejects out-of-set effort values. Returns the clean tuning plus any
 *  validation error (so callers can 400). Unknown model strings pass through — the CLI validates
 *  those, and aliases evolve faster than we'd want to hard-code. */
export function sanitizeRuntimeTuning(
  input: Partial<Record<keyof RuntimeTuning, unknown>>,
  /** The runtime the tuning will run under. Supplied by the agent-config route so a model or a
   *  permission-mode that runtime can't honour is rejected at the edge rather than silently ignored
   *  (or, for a cross-family model, passed to the CLI and breaking every run). */
  runtime?: RuntimeId,
): { tuning: RuntimeTuning; error?: string } {
  const tuning: RuntimeTuning = {};
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model) {
    const bad = validateModelForRuntime(runtime, model);
    if (bad) return { tuning, error: bad };
    tuning.model = model;
  }
  const effort = typeof input.effort === 'string' ? input.effort.trim() : '';
  if (effort) {
    if (!EFFORTS.includes(effort as Effort)) return { tuning, error: `effort must be one of: ${EFFORTS.join(', ')}` };
    tuning.effort = effort as Effort;
  }
  const mode = typeof input.permissionMode === 'string' ? input.permissionMode.trim() : '';
  if (mode) {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) return { tuning, error: `permissionMode must be one of: ${PERMISSION_MODES.join(', ')}` };
    // Silently storing a mode a runtime ignores is worse than refusing it: the console would show a
    // posture that isn't in force anywhere.
    if (runtime && !runtimeSupports(runtime, 'permissionMode')) {
      return { tuning, error: `${codingRuntime(runtime)?.label ?? runtime} has no permission mode — Agentric is its sole authority. Leave it on inherit.` };
    }
    tuning.permissionMode = mode as PermissionMode;
  }
  const verbosity = typeof input.verbosity === 'string' ? input.verbosity.trim() : '';
  if (verbosity) {
    if (!VERBOSITIES.includes(verbosity as Verbosity)) return { tuning, error: `verbosity must be one of: ${VERBOSITIES.join(', ')}` };
    // An explicit `normal` is kept, not folded back to "inherit": with a terse workspace default it's
    // the only way an agent whose prose humans actually read opts OUT. Empty string is still inherit.
    tuning.verbosity = verbosity as Verbosity;
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

/** Normalize a `usableSubagents` payload (API body or config file): coerce to an array of well-formed
 *  agent ids (the fleet-teammate ids this agent may spawn as native sub-agents), dedupe order-preserving,
 *  cap the list at 16. Existence / claude-code / self-reference filtering happens at materialisation time
 *  against the live fleet, so this only enforces the id SHAPE. Undefined when empty → no manifest key. */
export function sanitizeUsableSubagents(input: unknown): string[] | undefined {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/) // accept a comma/space/newline-separated string from a UI field too
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const id = x.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 16) break;
  }
  return out.length ? out : undefined;
}

/**
 * How much the CROSS-AGENT edit path (`agent_propose_update`) trusts the PROPOSING agent, keyed off its
 * maturity score (`src/state/agent-stats.ts`: autonomy × (1 − denialRate) × volumeConfidence).
 *
 * Three tiers, low to high:
 *   maturity < `minMaturity`   → the proposal is REFUSED outright (an unproven agent doesn't get to
 *                                rewrite a teammate's system prompt, not even into a human's queue).
 *   in between                 → today's behaviour: an owner-addressed review card, applied only on
 *                                owner approval.
 *   ≥ `autoApplyAt` (+ `autoApply`) → applied IMMEDIATELY, owner notified after the fact, revertable
 *                                from the revision it snapshots.
 *
 * The top tier deliberately removes the human from the loop, so note what makes it hard to reach:
 * maturity multiplies in `volumeConfidence = runs/(runs+8)`, so 0.8 is unreachable below ~32 runs and
 * needs near-perfect autonomy and a clean denial record on top. Set `autoApply:false` to keep every
 * proposal owner-gated (the two lower tiers still apply).
 */
export interface AgentProposalTrust {
  /** Floor to propose at all (0..1). Default 0.4. 0 lets any agent propose. */
  minMaturity: number;
  /** Maturity at/above which a proposal self-applies (0..1). Default 0.8. Ignored when `autoApply` is off. */
  autoApplyAt: number;
  /** Master switch for the auto-apply tier. Default true. */
  autoApply: boolean;
}

export const DEFAULT_AGENT_PROPOSAL_TRUST: AgentProposalTrust = { minMaturity: 0.4, autoApplyAt: 0.8, autoApply: true };

/** Normalize a stored/API `AgentProposalTrust`: clamp both thresholds to 0..1, and keep the floor at or
 *  below the auto-apply bar (an inverted pair would make a band that refuses and self-applies at once —
 *  raise the auto-apply bar to the floor rather than silently reordering the tiers). */
export function sanitizeAgentProposalTrust(input: unknown): AgentProposalTrust {
  const b = (input ?? {}) as Partial<Record<keyof AgentProposalTrust, unknown>>;
  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
  };
  const minMaturity = num(b.minMaturity, DEFAULT_AGENT_PROPOSAL_TRUST.minMaturity);
  const autoApplyAt = Math.max(minMaturity, num(b.autoApplyAt, DEFAULT_AGENT_PROPOSAL_TRUST.autoApplyAt));
  return { minMaturity, autoApplyAt, autoApply: b.autoApply === undefined ? DEFAULT_AGENT_PROPOSAL_TRUST.autoApply : !!b.autoApply };
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

/** Resolve the effective tuning for a launch: each field is the per-launch `override` (e.g. a task's
 *  own model/effort), else the agent's own value, else the workspace default, else undefined (CLI
 *  default) — except `permissionMode`, whose floor is `auto` (the interactive lane always runs with a
 *  mode; the built-in default is `auto`, not the CLI's own). Pure — used by the terminal launcher. */
export function resolveRuntimeTuning(
  agent: RuntimeTuning,
  defaults: RuntimeTuning,
  override?: RuntimeTuning,
  /** The runtime this tuning will actually run under. When given, a resolved model that belongs to a
   *  DIFFERENT runtime is dropped rather than passed to the CLI. */
  runtime?: RuntimeId,
): RuntimeTuning {
  let model = override?.model ?? agent.model ?? defaults.model;
  // The workspace default spans every runtime, so it CANNOT be correct for all of them at once: a
  // fleet default of `opus` is right for Claude Code and fatal for Codex, which answers
  // `The 'opus' model is not supported`. The per-agent config route already rejects a cross-family
  // model, but nothing validated INHERITANCE — an agent with no model of its own silently picked up a
  // foreign one. Drop it here instead, so the run falls back to the CLI's own default (a working
  // session on a sensible model) rather than failing outright. Found live on a Codex run.
  if (model && runtime && validateModelForRuntime(runtime, model)) model = undefined;
  return {
    model,
    effort: override?.effort ?? agent.effort ?? defaults.effort,
    permissionMode: override?.permissionMode ?? agent.permissionMode ?? defaults.permissionMode ?? 'auto',
    // Same precedence as the rest, resolved (never left undefined) so callers branch on a real value
    // and the session row records what the run actually launched with — the join key for measurement.
    verbosity: override?.verbosity ?? agent.verbosity ?? defaults.verbosity ?? 'normal',
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
