export type Role = 'owner' | 'admin' | 'member'
export interface Member {
  id: string
  email: string
  name: string
  role: Role
  status: 'invited' | 'active'
  createdAt: number
  /** Profile picture as a `data:image/…;base64,…` URL; absent → show the member's initial. */
  avatar?: string
  /** This member's pinned sidebar nav (secondary items promoted to Main). Client-only: delivered on
   *  /api/auth/me for `me`, never populated for other members. `null`/absent → apply the default layout;
   *  `[]` → the member explicitly pinned nothing. */
  navPins?: string[] | null
}
export type IdentityProvider = 'slack' | 'discord' | 'email' | 'github'
export const IDENTITY_PROVIDERS: IdentityProvider[] = ['slack', 'discord', 'email', 'github']
export interface MemberIdentity {
  memberId: string
  provider: IdentityProvider
  externalId: string
  createdAt: number
  createdBy?: string
}
export interface AgentAccess {
  allowedRoles: Role[]
  allowedMembers: string[]
}
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** `claude --permission-mode` choices. Interactive lane only; the gate hook governs regardless. */
export type PermissionMode = 'auto' | 'plan' | 'acceptEdits' | 'manual' | 'dontAsk' | 'bypassPermissions'
export const PERMISSION_MODES: PermissionMode[] = ['auto', 'plan', 'acceptEdits', 'manual', 'dontAsk', 'bypassPermissions']
/** Per-agent / workspace runtime tuning for claude-code sessions. Each field optional → inherit
 *  (permissionMode's floor is `auto`). */
export interface RuntimeTuning {
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
}

/** Whole-box concurrency cap state (Settings → Runtime). `value` = operator override (null = unset);
 *  `resolved` = effective cap the scheduler enforces (0 = unlimited); `derived` = the RAM-based default;
 *  `source` = which of the three won; `envLocked` = pinned by the AOS_MAX_CONCURRENT_SESSIONS env var;
 *  `alive` = live running-session count right now. */
export interface Concurrency {
  value: number | null
  resolved: number
  derived: number
  source: 'env' | 'setting' | 'derived'
  envLocked: boolean
  alive: number
  /** Auto-close a detached member session idle past this many hours (0 = off; default 48). */
  idleHours: number
}

export interface AgentInfo {
  id: string
  description: string
  /** Organisational grouping label (e.g. "Engineering", "Marketing"); undefined = uncategorised. */
  category?: string
  runtime: 'mock' | 'claude-code'
  /** True when the agent lives under the data home (user-created) and can be deleted. */
  deletable?: boolean
  /** True for an agent Agent OS ships and provisions itself (a department generalist, the
   *  agent-author, or the consolidator) — labelled as built-in in the chooser. */
  builtIn?: boolean
  /** Per-agent runtime tuning (claude-code only); undefined fields inherit the workspace default. */
  model?: string
  effort?: Effort
  /** Suggested first tasks shown as clickable chips on the spawn card. */
  examplePrompts?: string[]
  /** Cosmetic per-agent icon: a built-in library id (a lucide name) or raw custom `<svg>` markup. */
  icon?: string
}
export interface StateResp {
  tenant: string
  /** Human label for the tenant (branding); falls back to the tenant id server-side. */
  tenantName?: string
  /** Software version (package.json), shown in the sidebar so a browser and the box can be compared. */
  version?: string
  /** IANA timezone the server runs in — cron automations fire in this local time; the UI labels times with it. */
  serverTz?: string
  policy: string
  home?: string
  me: Member
  terminalAgents: string[]
  agents: AgentInfo[]
  capabilities: { id: string; description: string; defaultRisk: string }[]
  /** OS-owned operating notes appended to every claude-code agent's system prompt. Read-only. */
  operatingNotes?: string
}
/** Self-update status — the deploy is a git checkout, so this reflects "is the box behind origin?". */
export interface UpdateStatus {
  current: string
  latest: string
  behind: number
  updateAvailable: boolean
  branch: string
  upstream: string
  /** Uncommitted changes on the box — an ff-only apply would fail, so the button is disabled. */
  dirty: boolean
  checkedAt: number
  /** Newest-first commit subjects that would land (a lightweight changelog preview). */
  log: string[]
  error?: string
  /** True only for the owner — gates the "Update & restart" button. */
  canApply: boolean
}
export interface UpdateApplyResult {
  ok: boolean
  steps: { cmd: string; ok: boolean; out: string }[]
  restarting: boolean
  error?: string
}
/** Plain restart (no pull/rebuild) — bounces the process the service manager respawns. */
export interface RestartResult {
  ok: boolean
  restarting: boolean
  error?: string
}
export interface TeamResp {
  me: Member
  members: Member[]
  assignments: Record<string, AgentAccess>
  /** member id → their linked external accounts (Slack/Discord/email/github), for chat run-as. */
  identities: Record<string, MemberIdentity[]>
  agents: AgentInfo[]
}
/** Host resource snapshot (GET /api/system). Bytes for memory; fractions 0–1 for percentages. */
export interface SystemMetrics {
  mem: { total: number; free: number; used: number; usedPct: number }
  cpu: { count: number; model: string; usagePct: number; loadAvg: number[] }
  process: { rss: number; heapUsed: number; heapTotal: number; uptime: number }
  host: { platform: string; arch: string; release: string; hostname: string; uptime: number }
  runningSessions: number
  /** Per-session resident memory (bytes). `available:false` under uid-isolation (unmeasurable). RSS is
   *  approximate — shared library pages are counted once per process, so the sum slightly over-reports. */
  sessions: { available: boolean; totalRss: number; sessions: { id: string; agent: string; title: string; rss: number }[] }
  error?: string
}
export interface Session {
  id: string
  agent: string
  title: string
  task: string
  tmux: string
  status: 'running' | 'done' | 'stopped' | 'crashed'
  /** True when the tmux pane is alive now, regardless of the stored lifecycle `status` (an interactive
   *  session that reported `done` keeps a live pane). Undefined when the server couldn't poll tmux. */
  alive?: boolean
  /** True when this session can be resurrected in place via `claude --resume` on re-open (interactive
   *  session with a persisted launch env). Headless runs are never resumable. */
  resumable?: boolean
  /** True when this session can be FORKED — branched into a new independent session that inherits its
   *  full conversation (`claude --resume <parent> --fork-session`). Requires a claude-code runtime and a
   *  persisted conversation. Unlike `resumable`, a finished/headless run is forkable too. */
  forkable?: boolean
  spawnedBy?: string
  spawnedByLabel?: string
  /** Normalized origin category — how this session was initiated. `manual` = a console member; the
   *  automation family splits by trigger (`cron`/`webhook`/`slack`/`discord`/`composio`/`scheduled`);
   *  `task` = the Tasks dispatcher; `chat` = the `/agent` chat router; `system` = an internal principal.
   *  Server-resolved (the automation sub-type needs a join the raw `spawnedBy` can't give). */
  sourceKind?: 'manual' | 'cron' | 'webhook' | 'slack' | 'discord' | 'composio' | 'scheduled' | 'task' | 'chat' | 'system'
  /** True when the run launched unattended (an automation/cron/task run). These now run as an attachable
   *  interactive TUI a human can take over live; the list badges them as unattended vs. a member session. */
  headless?: boolean
  /** The member id who "took over" (claimed) this unattended run — set means it's sticky (won't be
   *  auto-closed at turn-end) and the Take-over affordance is hidden. Undefined = unclaimed. */
  claimedBy?: string
  /** The member id this session runs AS (run_as). A task/chat-triggered run is spawnedBy `task:`/
   *  `automation:` but runs as a member — the sidebar keys "my sessions" off this too. */
  runAs?: string
  /** Human-readable owner: the run-as member's name/email. Undefined when the session has no run-as
   *  identity. Drives the sessions-list Owner filter. */
  runAsLabel?: string
  createdAt: number
  /** Last time the session's status changed (report/end/stop/resume/crash); = createdAt until the
   *  first transition. Sortable "Updated" column on the sessions list. */
  updatedAt: number
  /** Human verdict on the finished run — 👍 ('up') / 👎 ('down'); feeds the agent maturity score. */
  rating?: 'up' | 'down'
  ratedBy?: string
  ratedByLabel?: string
  ratedAt?: number
}
export interface AuditEvent {
  id: number
  ts: number
  runId: string
  type: string
  principal?: string
  data: Record<string, unknown>
}
export interface AuditResp {
  events: AuditEvent[]
  types: string[]
  error?: string
}
/** One classified primitive-use in a session's activity timeline (from /api/sessions/:id/activity). */
export interface ActivityEvent {
  ts: number
  category: 'action' | 'operator' | 'memory' | 'knowledge' | 'tasks' | 'scheduling' | 'agents' | 'approval' | 'other'
  /** OS tool name (remember/ask/task_create…) or, for a governed effect, the capability id. */
  primitive: string
  summary: string
  /** For governed actions/approvals: how the gate classified it, or the outcome. */
  effect?: 'allow' | 'approve' | 'deny' | 'error'
}
export interface ActivitySummaryRow {
  primitive: string
  category: ActivityEvent['category']
  count: number
}
export interface SessionActivityResp {
  events: ActivityEvent[]
  summary: ActivitySummaryRow[]
  total: number
  error?: string
}
export interface AppCapabilities {
  dispatchAgents?: string[]
  egress?: boolean
  secrets?: string[]
  dependencies?: 'stdlib' | 'vendored' | 'npm'
}
export interface AppFile { path: string; bytes: number }
export interface AppInfo {
  id: string
  name: string
  icon?: string
  entry: string
  lifecycle: 'scale-to-zero' | 'resident'
  idleTimeoutSec?: number
  capabilities: AppCapabilities
  owner?: string
  createdBy?: string
  published: boolean
  domains?: string[]
  version?: number
  status: 'cold' | 'starting' | 'ready' | 'crashed'
  uptimeMs?: number
  lastError?: string
}

export interface Artifact {
  id: string
  sessionId: string
  agent: string
  source?: string
  kind: string
  title: string
  description?: string
  folder: string
  filename: string
  relPath: string
  mime: string
  bytes: number
  /** USD this artifact cost to generate (image/video); absent for published (non-generated) files. */
  costUsd?: number
  createdAt: number
}

export interface KbPage {
  id: string
  tenant: string
  section: string
  slug: string
  title: string
  tags: string[]
  body: string
  relPath: string
  rev: number
  createdAt: number
  updatedAt: number
  updatedBy: string
  readCount: number
  lastReadAt?: number
}
export interface Recommendation {
  id: string
  kind: 'runtime' | 'policy' | 'budget'
  title: string
  rationale: string
  apply?: { runtimeDefaults?: { model?: string; effort?: string; permissionMode?: PermissionMode } }
  link?: string
  createdAt: number
}
export interface DreamingReview { day: string; ts: number; sessions: number; success: number; failure: number; stopped: number; rejected: number; budgetStops: number; errors: number; topics: string[] }
export interface DreamingState {
  firstPass?: number
  passes?: number
  totals?: { sessions: number; success: number; failure: number; partial: number; stopped: number; unknown: number; rejected: number; budgetStops: number; errors: number }
  recent?: DreamingReview[]
}
export interface AgentScore { agent: string; runs: number; success: number; failed: number; stopped: number; crashed: number; chats: number; rate: number | null; focus: string[]; diagnosis?: { at: number; slug: string } }
export interface RejectedCapability { capability: string; count: number }
export interface FrictionMap { rejections: RejectedCapability[]; pendingApprovals: number; oldestPendingAgeMs: number | null }
export interface Insights { windowDays: number; agents: AgentScore[]; friction: FrictionMap }
export type ImprovementDomain = 'agents' | 'kb' | 'goals' | 'skills' | 'memory' | 'automations'
export interface ImprovementTile { domain: ImprovementDomain; count: number; title: string; detail: string; actionLabel: string; href: string }
export interface CleanupPruneItem { id: string; agent: string; snippet: string; ageDays: number; importance: number | null }
export interface CleanupMergeGroup { agent: string; keepSnippet: string; drop: number }
export interface MemoryCleanupPlan { opts: { pruneAfterDays: number; keepImportance: number; dedupeThreshold?: number }; prune: { total: number; sample: CleanupPruneItem[] }; merge: { groups: number; drops: number; sample: CleanupMergeGroup[] } }
export interface KbTidyItem { id: string; section: string; slug: string; title: string; ageDays: number; lastReadDays: number | null }
export interface KbTidyPlan { deadAfterDays: number; staleAfterDays: number; dead: { total: number; sample: KbTidyItem[] }; stale: { total: number; sample: KbTidyItem[] } }
export interface StuckGoal { id: string; title: string; days: number }
export interface TroubledAutomation { id: string; name: string; type: string; reason: 'errored' | 'idle'; detail: string }
export interface MeasureTrendBucket { start: number; label: string; total: number; success: number; rate: number | null }
export interface MeasureIntervention { id: string; title: string; at: number; before: { n: number; rate: number | null }; after: { n: number; rate: number | null }; deltaPp: number | null; verdict: 'improved' | 'declined' | 'flat' | 'insufficient' }
export interface Measurement {
  trend: MeasureTrendBucket[]
  interventions: MeasureIntervention[]
  recent: { n: number; rate: number | null }
  prior: { n: number; rate: number | null }
  deltaPp: number | null
}
export interface DigestConfig {
  enabled: boolean
  channel: string
  discordChannel?: string
  hour: number
  slackConfigured?: boolean
  discordConfigured?: boolean
  lastPostedAt?: number
}
export interface DigestModel {
  iso: string
  label: string
  total: number
  buckets: { success: number; partial: number; failure: number; stopped: number; running: number; other: number }
  byAgent: { agent: string; lines: { title: string; outcome: string; importance: number; count?: number }[]; more: number }[]
  signals: { tasksCreated: number; tasksCompleted: number; approvals: number; rejected: number; errors: number; budgetStops: number }
  guidance: string[]
  recommendations: string[]
}
export interface KbRevision {
  id: string
  pageId: string
  rev: number
  title: string
  tags: string[]
  body: string
  summary?: string
  author: string
  createdAt: number
}

export interface AgentRevision {
  id: string
  rev: number
  description: string
  category?: string
  icon?: string
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  examplePrompts: string[]
  shellSecrets: string[]
  claudeMd: string
  summary?: string | null
  author: string
  createdAt: number
}

/** Per-agent trust / maturity stats (mirror of src/state/agent-stats.ts AgentStats). */
export interface AgentStats {
  agentId: string
  runs: { total: number; running: number; done: number; stopped: number; crashed: number }
  outcomes: { success: number; failure: number; inconclusive: number }
  actions: { governed: number; humanGated: number; autoApproved: number; denied: number; rejected: number; killswitch: number; errors: number; budgetStops: number }
  tasks: { done: number; blocked: number; cancelled: number }
  rated: { up: number; down: number }
  deniedRuns: number
  questions: number
  firstRunAt: number | null
  lastRunAt: number | null
  autonomy: number
  denialRate: number
  successRate: number | null
  volumeConfidence: number
  maturity: number
  confidence: 'none' | 'low' | 'medium' | 'high'
}

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
export interface Task {
  id: string
  tenant: string
  title: string
  body: string
  status: TaskStatus
  priority: number
  labels: string[]
  assignee?: string
  owner?: string
  parentId?: string
  goalId?: string
  criteria?: string
  dependsOn?: string[]
  mode: 'headless' | 'interactive'
  autoDispatch: boolean
  dueAt?: number
  attempts: number
  lastSessionId?: string
  createdBy: string
  createdAt: number
  updatedAt: number
  updatedBy: string
}
export interface TaskEvent {
  id: string
  taskId: string
  kind: 'comment' | 'status' | 'claim' | 'dispatch' | 'assign' | 'link' | 'attach'
  body?: string
  author: string
  sessionId?: string
  createdAt: number
}
export interface TaskAttachment {
  id: string
  taskId: string
  tenant: string
  filename: string
  relPath: string
  mime: string
  bytes: number
  uploadedBy: string
  createdAt: number
}
export interface AddTaskReq {
  title: string
  body?: string
  assignee?: string
  owner?: string
  priority?: number
  labels?: string[]
  parentId?: string
  goalId?: string
  criteria?: string
  dependsOn?: string[]
  mode?: 'headless' | 'interactive'
  autoDispatch?: boolean
  dueAt?: number
}

export type GoalStatus = 'draft' | 'active' | 'achieved' | 'abandoned'
export interface Goal {
  id: string
  tenant: string
  title: string
  body: string
  status: GoalStatus
  target?: string
  owner?: string
  parentId?: string
  labels: string[]
  dueAt?: number
  createdBy: string
  createdAt: number
  updatedAt: number
  updatedBy: string
}
export interface GoalEvent {
  id: string
  goalId: string
  kind: 'status' | 'comment' | 'edit' | 'link'
  body?: string
  author: string
  createdAt: number
}
export type GoalCounts = Record<GoalStatus, number>
export interface GoalProgress {
  total: number
  done: number
  counted: number
  percent: number
  byStatus: Record<TaskStatus, number>
}
export interface AddGoalReq {
  title: string
  body?: string
  status?: GoalStatus
  target?: string
  owner?: string
  parentId?: string
  labels?: string[]
  dueAt?: number
}

export interface Msg {
  id: string
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact' | 'notification' | 'skill.proposed' | 'goal.proposed' | 'skill.request' | 'secret.request' | 'host.proposed'
  sessionId: string
  agent: string
  title: string
  body: string
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'answered' | 'cancelled' | 'fulfilled'
  approvalId?: string
  capability?: string
  args?: unknown
  level?: 'head' | 'owner'
  /** approval: explicit risk bucket (yellow = admin, red = owner) — the card's severity badge. */
  riskClass?: 'green' | 'yellow' | 'red' | 'deny'
  source?: string
  questionId?: string
  answer?: string
  outcome?: string
  /** approval: the policy's reason this needs sign-off (vs `body`, the agent's own reasoning). */
  policyReason?: string
  /** approval/question: who resolved/answered it (email) — shown on the resolved card. */
  resolvedBy?: string
  answeredBy?: string
  /** The session's live display name — the inbox leads with this; `agent` is the secondary line. */
  sessionTitle?: string
  /** Whether THIS member has marked the message read (per-member, server-backed). */
  read?: boolean
  createdAt: number
}

/** Per-member notification preferences (mirrors src/types.ts NotificationPrefs). Which session events
 *  ping ME in the console bell + toast, and whether they also chime / DM me on Slack/Discord. */
export interface NotificationPrefs {
  events: { completed: boolean; waiting: boolean; crashed: boolean; approval: boolean; question: boolean }
  toasts: boolean
  sound: boolean
  dm: boolean
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  events: { completed: true, waiting: true, crashed: true, approval: true, question: true },
  toasts: true,
  sound: false,
  dm: false,
}

export type ExecMode = 'interactive' | 'headless'
export interface Automation {
  id: string
  agentId: string
  name: string
  /** `once` = a one-shot deferred run scheduled by an agent (not creatable from the console). */
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord'
  mode: ExecMode
  schedule?: string
  /** composio: trigger slug. slack: event type (app_mention/message) or channel id. '' = any. */
  filter?: string
  task: string
  enabled: boolean
  createdAt: number
  lastFiredAt?: number
  lastSessionId?: string
  /** Member id (or `agent:`/`automation`) that created it — drives the delete/edit ownership guard. */
  createdBy?: string
  /** Whether the current caller may delete/edit it (owner override, else creator-only). Mirrors the API
   *  guard so the console can hide the controls on automations you didn't create. */
  canManage?: boolean
  /** When it fires next (epoch ms): computed for an enabled cron, or the pending runAt for a one-shot.
   *  Absent for event triggers (webhook/slack/discord) and disabled automations. */
  nextRunAt?: number
  /** Ready-to-paste webhook URL — present for admins on webhook automations only. */
  hookUrl?: string
}
export interface AddAutomationReq {
  agentId: string
  name: string
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord'
  mode: ExecMode
  schedule?: string
  filter?: string
  task: string
}

export type Transport = 'stdio' | 'http' | 'sse'
export type ConnectorScope = 'org' | 'personal'
export interface Connector {
  id: string
  kind: 'mcp'
  type: string
  label: string
  description: string
  transport: Transport
  command: string
  args: string[]
  url: string
  enabled: boolean
  scope: ConnectorScope
  ownerMemberId?: string
  /** personal-only: shared with the whole team (injected into everyone's sessions, as the owner). */
  shared: boolean
  createdAt: number
  envKeys: string[]
  headerKeys: string[]
}
export interface CatalogField {
  key: string
  label: string
  placeholder?: string
  help?: string
  target?: 'env' | 'header' | 'url'
}
export interface CatalogEntry {
  type: string
  label: string
  description: string
  transport: Transport
  command?: string
  args?: string[]
  fields: CatalogField[]
}
export interface NativeCap {
  id: string
  description: string
  defaultRisk: string
}
export interface ConnectorsResp {
  connectors: Connector[]
  catalog: CatalogEntry[]
  native: NativeCap[]
}
export interface AddConnectorReq {
  type: string
  label?: string
  description?: string
  transport?: Transport
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  scope?: ConnectorScope
}

// ── Host connections (the "Host" shape — docs/host-connections-plan.md, Phase 2a) ──
export type HostProtocol = 'ssh' | 'http' | 'postgres' | 'any'
export type HostPosture = 'allow' | 'ask' | 'never'
export interface Host {
  id: string
  name: string
  match: string                 // hostname glob | CIDR | host[:port]
  protocol: HostProtocol
  credential: string            // redacted: a `secret:KEY` ref, '••••' (raw, masked), or ''
  posture: HostPosture
  enabled: boolean
  scope: ConnectorScope         // org | personal (same ownership model as connectors)
  ownerMemberId?: string
  shared: boolean
  createdAt: number
  proposed: boolean             // proposed by an agent (host_propose), inactive until published
  proposedBy?: string           // the proposing agent (agent:<id>)
  proposedReason?: string
}
export interface HostsResp { hosts: Host[] }
export interface AddHostReq {
  name: string
  match: string
  protocol?: HostProtocol
  credential?: string
  posture?: HostPosture
  scope?: ConnectorScope
}

export interface MemoryRecord {
  id: string
  tenant: string
  agentId: string
  content: string
  tags: string[]
  type?: string
  importance?: number
  metadata?: Record<string, unknown>
  ts: number
  /** 'agent' (private to its author) | 'tenant' (shared workspace-wide). */
  scope?: 'agent' | 'tenant'
  /** Recall relevance (higher = more relevant); absent when listing by recency. */
  score?: number
}
export interface MemoryHealth {
  ok: boolean
  backend: string
  detail?: string
}
export type MemoryBackend = 'sqlite' | 'libsql' | 'automem'
export interface EmbeddingsView { provider: 'openai' | 'ollama'; url: string; model: string; dimensions?: number; apiKeySet: boolean }
export interface EmbeddingsReq { enabled?: boolean; provider?: 'openai' | 'ollama'; url: string; model: string; dimensions?: number; apiKey?: string }
/** Settings → Memory view — stored backend config with secrets redacted to `…Set` booleans + live health. */
export interface MemoryRanking { halfLifeDays?: number; weightByImportance?: boolean; weightByUsage?: boolean }
export interface MemoryMaintenance { pruneAfterDays?: number; keepImportance?: number; dedupeThreshold?: number; everyHours?: number }
export interface MemorySettings {
  backend: MemoryBackend
  sqlite?: { embeddings?: EmbeddingsView }
  libsql?: { url: string; authTokenSet: boolean; embeddings?: EmbeddingsView }
  automem?: { endpoint: string; tokenSet: boolean }
  ranking?: MemoryRanking
  maintenance?: MemoryMaintenance
  sharedWrites?: 'open' | 'curated'
  preload?: { enabled: boolean; count?: number }
  health?: MemoryHealth
  /** Rows in the local `memories` ledger vs. the active external store — drives the migrate/clear banner. */
  localCount?: number
  backendCount?: number | null
  /** Local rows the active external backend doesn't have (0 for sqlite). */
  drift?: number
  updatedAt?: number
  updatedBy?: string
  error?: string
}
/** Probe result for a local Ollama (embeddings UI). */
export interface OllamaStatus {
  reachable: boolean
  url: string
  installed: boolean
  version?: string
  models?: string[]
  error?: string
}
/** What the console submits — blank secret = "keep the stored one". */
export interface MemorySettingsReq {
  backend: MemoryBackend
  sqlite?: { embeddings?: EmbeddingsReq }
  libsql?: { url: string; authToken?: string; embeddings?: EmbeddingsReq }
  automem?: { endpoint: string; token?: string }
  ranking?: MemoryRanking
  maintenance?: MemoryMaintenance
  sharedWrites?: 'open' | 'curated'
  preload?: { enabled: boolean; count?: number }
}
export interface AddMemoryReq {
  agent: string
  content: string
  tags?: string[]
  type?: string
  importance?: number
  /** true → store as shared (tenant-scoped) workspace-wide knowledge. */
  shared?: boolean
}

export interface SkillSummary {
  name: string
  description: string
  bytes: number
  updatedAt: number
  /** Supporting files alongside SKILL.md (templates/scripts), names only. */
  files: string[]
  /** Agent ids this skill is scoped to. Empty = every agent (the default). */
  agents: string[]
  /** True when this is a not-yet-published proposal (invisible to agents until published). */
  proposed: boolean
  /** Provenance of a proposal (present only when `proposed`). */
  proposal?: { agent?: string; session?: string; rationale?: string; at: number }
}
export interface SkillDetail extends SkillSummary {
  content: string
}
export interface SkillsResp {
  enabled: boolean
  skills: SkillSummary[]
  error?: string
}
export interface CatalogSkill {
  name: string
  description: string
  bytes: number
  files: string[]
  /** True when this tenant's library already has a skill of this name. */
  installed: boolean
}
export interface CatalogResp {
  catalog: CatalogSkill[]
  error?: string
}
/** One agent-library entry: a ready-made agent that ships with the software (`config/agents`), with
 *  whether this workspace already has it installed and whether it's a seeded built-in. */
export interface CatalogAgent {
  id: string
  description: string
  category?: string
  icon?: string
  model?: string
  effort?: string
  examplePrompts?: string[]
  installed: boolean
  builtin: boolean
}
export interface AgentCatalogResp {
  catalog: CatalogAgent[]
  error?: string
}
/** A featured remote source (a GitHub repo of skills) shown as a one-click preset. */
export interface SkillSource { repo: string; label: string; description: string }
export interface SkillSourcesResp { presets: SkillSource[]; error?: string }
/** One skill discovered in a remote repo, with whether this tenant already has it. */
export interface RemoteSkill { name: string; description: string; path: string; files: string[]; installed?: boolean }
export interface RemoteCatalogResp {
  repo: string
  ref: string
  repoDescription: string
  skills: RemoteSkill[]
  error?: string
}
/** A skills.sh directory hit — a skill in some repo, with its install count and source owner/repo. */
export interface SkillshHit { skillId: string; name: string; installs: number; source: string; installed?: boolean }
export interface SkillshResp { query: string; hits: SkillshHit[]; error?: string }

/** An agent's pending request to have a catalog skill installed (via `skill_request`). */
export interface SkillRequest { id: string; skill: string; source: string; agent: string; rationale?: string; createdAt: number }
export interface SkillRequestsResp { requests: SkillRequest[]; error?: string }

/** An agent's `secret_request` awaiting a human. `mode`: 'provide' (enter a new value) or 'access'
 *  (grant the agent an existing vault key — no value typed). No secret value is ever in play here. */
export interface SecretRequest { id: string; key: string; agent: string; mode: 'provide' | 'access'; reasoning?: string; createdAt: number }
export interface SecretRequestsResp { requests: SecretRequest[]; error?: string }

export interface CompanySettings {
  companyMd: string
  updatedAt?: number
  updatedBy?: string
  error?: string
}

/** Per-tenant web-console branding — accent colour + favicon badge. Display-only. */
export interface Branding {
  /** Accent colour as `#rrggbb`; empty/undefined → default theme. */
  accentColor?: string
  /** Favicon badge: an emoji or a 1–3 char initial; undefined → tenant initial. */
  badge?: string
}
/** The public GET /api/branding payload (served unauthenticated so the login screen themes too). */
export interface PublicBranding extends Branding {
  tenant: string
  tenantName?: string
}

/** A stored secret's identity + provenance — the value is NEVER returned by the API. */
export interface SecretMeta {
  principal: string
  key: string
  updatedAt: number
  updatedBy?: string
  /** Agent ids this secret is injected into (as a shell env var) at launch — the assignment list. */
  agents: string[]
}

/** Numeric governance caps the never-tier policy rules read ($moneyCapUsd / $bulkDeleteCount). */
export interface GovernanceThresholds {
  moneyCapUsd: number
  bulkDeleteCount: number
}

export interface IntegrationsResp {
  /** Never the raw key — only whether it's set and a masked hint (••••last4). */
  composio: { set: boolean; hint: string }
  /** Composio webhook signing secret — set flag only, never the value. */
  webhook: { set: boolean }
  /** Native Slack (Socket Mode) — which tokens are set; never the tokens. */
  slack: { appToken: boolean; botToken: boolean; configured: boolean }
  /** Native Discord (Gateway) — whether the bot token is set; never the token. */
  discord: { botToken: boolean; configured: boolean }
  /** Per-member GitHub App OAuth — whether the client id / secret are set (never the secret itself),
   *  plus the created App's slug + the install-on-repos link (empty until an App is created). */
  github: { clientId: boolean; clientSecret: boolean; configured: boolean; slug: string; installUrl: string; appId: boolean; privateKey: boolean; botReady: boolean }
  /** Image generation backend — which keys are set (never the keys), the active backend, default model. */
  image: { openRouter: boolean; atlas: boolean; backend: 'openrouter' | 'atlas' | null; defaultModel: string; configured: boolean }
  /** Video generation backend — which keys are set (never the keys), the active backend, default model. */
  video: { fal: boolean; atlas: boolean; backend: 'fal' | 'atlas' | null; defaultModel: string; configured: boolean }
  /** Generic `/agent` chat router: when on, an unmatched Slack/Discord message reaches any agent by name. */
  chatRouter: boolean
  /** Warm (resident) Slack thread session idle-kill, minutes. 0 = residence off (every reply cold-starts). */
  chatIdleTimeoutMin: number
  updatedAt?: number
  updatedBy?: string
  error?: string
}

/** The viewer's own GitHub link state — whether the company App is configured + their connected login. */
export interface GithubMe {
  configured: boolean
  connected: boolean
  login?: string
  expiresAt?: number
  /** Real App-installation status for the connected token — undefined when not connected or the check
   *  couldn't run. `installed:false` means authorized-but-not-installed (connected yet can't touch a repo). */
  install?: { installed: boolean; count: number; accounts: string[]; repos: number }
  /** GitHub install page for the App (`…/apps/<slug>/installations/new`), or '' if the slug isn't known. */
  installUrl?: string
  error?: string
}

export interface SlackStatus {
  configured: boolean
  connected: boolean
  botUserId: string
  lastError?: string
  error?: string
}

/** Live Discord Gateway status — same shape as SlackStatus. */
export type DiscordStatus = SlackStatus

export interface ComposioConnection {
  id: string
  toolkit: string
  status: string
  createdAt: string
  userId: string
  /** Distinguishing label for this connection (user alias, else Composio's auto handle). */
  name: string
}
export interface ConnectionsResp {
  keySet: boolean
  company: ComposioConnection[]
  mine: ComposioConnection[]
  me?: string
  companyEntity?: string
  error?: string
}

/** Read-only overview of everything wired at the COMPANY level (any member can read; no secrets). */
export interface IntegrationsOverview {
  composio: { keySet: boolean; entity: string; apps: { id: string; toolkit: string; status: string }[] }
  slack: { configured: boolean; connected: boolean; botUserId: string }
  discord: { configured: boolean; connected: boolean; botUserId: string }
  custom: { label: string; type: string; enabled: boolean }[]
  error?: string
}

export interface FileEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
}
export interface DirListing {
  root: string
  path: string
  entries: FileEntry[]
  error?: string
}
export interface FileContent {
  path: string
  size: number
  /** Absent when binary/tooLarge. */
  content?: string
  binary?: boolean
  tooLarge?: boolean
  error?: string
}

export type PolicyOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'
export type PolicyAction = 'allow' | 'ask' | 'never'
export type Approver = 'admin' | 'owner'
/** A rule (or the document default) yields one outcome; `approver` is set only when action is `ask`. */
export interface PolicyOutcome {
  action: PolicyAction
  approver?: Approver
}
export interface PolicyRule extends PolicyOutcome {
  match: { capability: string; when?: { arg: string; op: PolicyOp; value: number | string | boolean } }
}
export interface PolicyDocument {
  id: string
  description?: string
  default: PolicyOutcome
  rules: PolicyRule[]
}
export interface PolicyResp {
  editable: boolean
  canEdit?: boolean
  document?: PolicyDocument
  id?: string
  error?: string
}
/** A tighten-only change an agent proposed to the ruleset (awaiting owner approval). */
export interface PolicyDelta {
  kind: 'tighten' | 'reorder' | 'add'
  match: { capability: string; when?: { arg: string; op: PolicyOp; value: number | string | boolean } }
  outcome?: PolicyOutcome
}
export interface PolicyProposal { id: string; agent: string; delta: PolicyDelta; rationale?: string; preview?: string; createdAt: number }
export interface PolicyProposalsResp { proposals: PolicyProposal[]; canApply?: boolean; error?: string }
export interface PolicyRevision { id: string; rev: number; document: PolicyDocument; summary: string | null; author: string; createdAt: number }
export interface PolicyRevisionsResp { revisions: PolicyRevision[]; canRevert?: boolean; error?: string }

/** One entry in the non-technical chat timeline (mirrors src/edge/conversation.ts). */
export type ChatTurn =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number }
  | { kind: 'activity'; tool: string; label: string; detail?: string; status: 'running' | 'ok' | 'error'; ts: number }
export interface ConversationResp {
  agent?: string
  turns: ChatTurn[]
  found: boolean
  error?: string
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json() as Promise<T>
}

export const api = {
  /** Current member, or null if not authenticated (401). Drives the login gate. */
  me: async (): Promise<Member | null> => {
    const res = await fetch('/api/auth/me')
    if (res.status === 401) return null
    const body = await res.json()
    // navPins ships beside `member` on this payload — fold it onto the member so the sidebar has the
    // pinned layout at first paint without a second request.
    return { ...(body.member as Member), navPins: body.navPins ?? null }
  },
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),
  /** Self-service recovery: ask the server to send a fresh sign-in link. Always resolves ok (neutral
   *  response — a real member is DM'd/logged a link; an unknown email is a silent no-op). */
  requestLink: (email: string) => call<{ ok: boolean }>('POST', '/api/auth/request-link', { email }),

  state: () => call<StateResp>('GET', '/api/state'),
  /** Self-update: check whether the checkout is behind origin (`force` re-runs `git fetch`, owner/admin). */
  checkUpdate: (force = false) => call<UpdateStatus>('GET', '/api/update' + (force ? '?force=1' : '')),
  /** Owner-only: pull + rebuild + restart. Resolves with the step log; the process bounces after. */
  applyUpdate: () => call<UpdateApplyResult>('POST', '/api/update/apply'),
  /** Owner-only: plain restart, no pull/rebuild. The process bounces ~1.5s after the response. */
  restart: () => call<RestartResult>('POST', '/api/restart'),
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  /** Inbox feed. `scope='all'` is the owner/admin oversight view (every session's cards); the default
   *  `mine` is the personal feed — only cards addressed to you, so overseers aren't flooded. */
  messages: (scope: 'mine' | 'all' = 'mine') => call<Msg[]>('GET', `/api/messages${scope === 'all' ? '?scope=all' : ''}`),
  run: (agent: string, task: string) => call<{ id: string; tmux: string; error?: string }>('POST', '/api/sessions', { agent, task }),
  stopSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/stop`),
  /** Halt every running session tenant-wide (owner/admin). Softer sibling of the kill switch. */
  stopAllSessions: () => call<{ ok: boolean; halted?: number; error?: string }>('POST', '/api/sessions/stop-all'),
  /** Host resource snapshot for Settings → System (RAM / CPU / uptime). */
  system: () => call<SystemMetrics>('GET', '/api/system'),
  rateSession: (id: string, rating: 'up' | 'down' | null) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/rate`, { rating }),
  /** Give a session a human-chosen display title (overrides the auto/AI-generated one). */
  renameSession: (id: string, title: string) => call<{ ok: boolean; error?: string; title?: string }>('POST', `/api/sessions/${id}/rename`, { title }),
  /** Hand a session to another owner — reassign its run-as (the accountable human). Owner/admin, or the
   *  session's current owner handing off their own run. `to` is the target member id. */
  transferSession: (id: string, to: string) => call<{ ok: boolean; error?: string; runAs?: string }>('POST', `/api/sessions/${id}/transfer`, { to }),
  /** Lift the stop-block so a stopped session resurrects (claude --resume) on the next terminal open. */
  resumeSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/resume`),
  /** Take over a headless run: convert it to an attachable interactive session (claude --resume). Kills
   *  the in-flight `-p` turn if still streaming; then open the terminal to watch/steer. */
  goInteractive: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/interactive`),
  /** Fork a session into a NEW branch that inherits its full conversation; returns the new session's
   *  id/tmux so the caller can open its terminal. Optional `task` seeds the branch's first instruction. */
  forkSession: (id: string, task?: string) => call<{ id?: string; tmux?: string; error?: string }>('POST', `/api/sessions/${id}/fork`, { task }),
  deleteSession: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/sessions/' + id),
  attach: (id: string) => call<{ url?: string; error?: string }>('GET', `/api/sessions/${id}/attach`),
  sessionTranscript: (id: string) => call<{ text?: string; error?: string }>('GET', `/api/sessions/${id}/transcript`),
  /** The agent-os primitives this session used — a classified timeline + grouped counts. */
  sessionActivity: (id: string) => call<SessionActivityResp>('GET', `/api/sessions/${id}/activity`),
  /** Non-technical chat surface: the friendly conversation timeline for a session (poll it). */
  conversation: (id: string) => call<ConversationResp>('GET', `/api/sessions/${id}/conversation`),
  /** Start a chat with an agent — spawns a warm resident session. Returns its id. */
  startChat: (agent: string, message: string) =>
    call<{ id?: string; tmux?: string; error?: string }>('POST', '/api/chat/start', { agent, message }),
  /** Send the human's next turn into a chat session — a clean headless resume run. `busy` = a prior
   *  turn is still generating (keep the draft, resend shortly). */
  reply: (id: string, message: string) =>
    call<{ status?: 'sent' | 'busy'; error?: string }>('POST', `/api/sessions/${id}/reply`, { message }),
  /** Take a chat session over into the Terminal — makes it a live attachable interactive TUI; the caller
   *  then opens the terminal on it. */
  takeoverToTerminal: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/takeover-terminal`),
  /** Upload a pasted/dropped/picked file (ANY type) into a live session; the server saves it in the
   *  agent's folder and types the path into the running claude. `dataB64` is base64 (no data: prefix);
   *  `ext` e.g. 'pdf'; `name` is the original filename, preserved when given. */
  attachFile: (id: string, dataB64: string, ext: string, name?: string) =>
    call<{ ok: boolean; path?: string; error?: string }>('POST', `/api/sessions/${id}/attach-file`, { dataB64, ext, name }),
  resolve: (id: string, approved: boolean) => call<{ ok: boolean; error?: string }>('POST', '/api/approvals/' + id, { approved }),
  /** Approve this attempt AND add a persistent policy `allow` rule for its capability (owner-only). */
  alwaysApprove: (id: string) => call<{ ok: boolean; ruleAdded?: boolean; note?: string; error?: string }>('POST', `/api/approvals/${id}/always`),
  answerQuestion: (id: string, answer: string) => call<{ ok: boolean; error?: string }>('POST', '/api/questions/' + id, { answer }),
  /** Dismiss a pending question without answering (cancels it; unblocks a still-live agent's `ask`). */
  cancelQuestion: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/questions/${id}/cancel`),
  dismissMessage: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/messages/${id}/dismiss`),
  dismissAllMessages: (scope: 'mine' | 'all' = 'mine') => call<{ ok: boolean; dismissed?: number; error?: string }>('POST', `/api/messages/dismiss-all${scope === 'all' ? '?scope=all' : ''}`),
  markRead: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/messages/${id}/read`),
  markAllRead: (scope: 'mine' | 'all' = 'mine') => call<{ ok: boolean; read?: number; error?: string }>('POST', `/api/messages/read-all${scope === 'all' ? '?scope=all' : ''}`),
  /** This member's own notification preferences (bell/toast/sound/DM + which event kinds). */
  notificationPrefs: () => call<NotificationPrefs>('GET', '/api/me/prefs'),
  saveNotificationPrefs: (prefs: NotificationPrefs) => call<NotificationPrefs>('PUT', '/api/me/prefs', prefs),
  // This member's personal context (free-text injected into every session run as them).
  myContext: () => call<{ context: string }>('GET', '/api/me/context'),
  saveMyContext: (context: string) => call<{ context: string }>('PUT', '/api/me/context', { context }),
  /** Persist this member's pinned sidebar nav (the keys promoted to Main). Returns the resolved list. */
  saveNavPins: (pinned: string[]) => call<{ pinned: string[] }>('PUT', '/api/me/nav', { pinned }),

  team: () => call<TeamResp>('GET', '/api/team'),
  audit: (f: { session?: string; type?: string; principal?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (f.session) q.set('session', f.session)
    if (f.type) q.set('type', f.type)
    if (f.principal) q.set('principal', f.principal)
    if (f.limit) q.set('limit', String(f.limit))
    return call<AuditResp>('GET', '/api/audit' + (q.toString() ? `?${q}` : ''))
  },
  invite: (email: string, role: Role) => call<{ member: Member; link: string; error?: string }>('POST', '/api/team/invite', { email, role }),
  setRole: (id: string, role: Role) => call<Member | { error: string }>('POST', `/api/team/${id}/role`, { role }),
  removeMember: (id: string) => call<{ ok: boolean; reason?: string }>('DELETE', '/api/team/' + id),
  loginLink: (id: string) => call<{ link: string; error?: string }>('POST', `/api/team/${id}/login-link`),
  /** Set (POST a data-URL) or clear (DELETE) a member's profile picture. */
  setAvatar: (id: string, avatar: string) => call<{ ok: boolean; member?: Member; error?: string }>('POST', `/api/team/${id}/avatar`, { avatar }),
  clearAvatar: (id: string) => call<{ ok: boolean; member?: Member; error?: string }>('DELETE', `/api/team/${id}/avatar`),
  setAssignment: (agentId: string, access: AgentAccess) => call<{ ok: boolean; assignment: AgentAccess }>('PUT', '/api/team/assignments/' + agentId, access),
  setIdentity: (id: string, provider: IdentityProvider, externalId: string) => call<{ ok: boolean; identities: MemberIdentity[]; error?: string }>('POST', `/api/team/${id}/identities`, { provider, externalId }),
  clearIdentity: (id: string, provider: IdentityProvider) => call<{ ok: boolean; identities: MemberIdentity[]; error?: string }>('DELETE', `/api/team/${id}/identities/${provider}`),

  automations: () => call<{ automations: Automation[] }>('GET', '/api/automations'),
  addAutomation: (a: AddAutomationReq) => call<Automation & { error?: string }>('POST', '/api/automations', a),
  updateAutomation: (id: string, patch: Partial<Pick<Automation, 'name' | 'mode' | 'schedule' | 'filter' | 'task' | 'enabled'>>) =>
    call<Automation & { error?: string }>('PATCH', '/api/automations/' + id, patch),
  deleteAutomation: (id: string) => call<{ ok: boolean }>('DELETE', '/api/automations/' + id),
  /** Fire an automation once now. `mode` overrides its saved default for this run only (headless =
   *  fire-and-forget, interactive = watch/steer the live TUI); omit to keep the automation's own mode. */
  runAutomation: (id: string, mode?: 'interactive' | 'headless') => call<{ ok: boolean; sessionId?: string; reason?: string; error?: string }>('POST', `/api/automations/${id}/run`, mode ? { mode } : {}),
  automationRuns: (id: string) => call<{ runs: Session[]; error?: string }>('GET', `/api/automations/${id}/runs`),

  memory: (agent: string, q = '', limit = 50, scope: 'all' | 'agent' | 'tenant' = 'all') =>
    call<{ memories: MemoryRecord[] }>('GET', `/api/memory?agent=${encodeURIComponent(agent)}&q=${encodeURIComponent(q)}&limit=${limit}&scope=${scope}`),
  addMemory: (m: AddMemoryReq) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/memory', m),
  updateMemory: (id: string, m: { agent: string; content?: string; tags?: string[]; type?: string; importance?: number }) =>
    call<{ ok: boolean; memory?: MemoryRecord; error?: string }>('PATCH', '/api/memory/' + id, m),
  deleteMemory: (id: string, agent: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/memory/${id}?agent=${encodeURIComponent(agent)}`),
  memoryHealth: () => call<MemoryHealth>('GET', '/api/memory/health'),
  memoryOverview: () => call<{ counts: { memories: number; episodes: number; lessons: number; shared: number; kbPages: number }; activity: { ts: number; runId: string; type: string; principal?: string; data: Record<string, unknown> }[]; error?: string }>('GET', '/api/memory/overview'),
  memorySettings: () => call<MemorySettings>('GET', '/api/settings/memory'),
  saveMemorySettings: (body: MemorySettingsReq) => call<MemorySettings & { ok: boolean }>('PUT', '/api/settings/memory', body),
  testMemorySettings: (body: MemorySettingsReq) => call<{ ok: boolean; health?: MemoryHealth; error?: string }>('POST', '/api/settings/memory/test', body),
  ollamaStatus: (url: string) => call<OllamaStatus>('GET', '/api/settings/memory/ollama?url=' + encodeURIComponent(url)),
  maintainMemory: () => call<{ ok: boolean; pruned?: number; merged?: number; error?: string }>('POST', '/api/settings/memory/maintain'),
  // Batched: call with { skipEpisodes } first, then loop passing back the server-assigned `before` until `done`.
  migrateMemory: (opts: { skipEpisodes: boolean; limit?: number }) => call<{ ok: boolean; done?: boolean; migrated?: number; skipped?: number; remaining?: number; note?: string; error?: string }>('POST', '/api/settings/memory/migrate', opts),
  clearMemoryLedger: () => call<{ ok: boolean; cleared?: number; error?: string }>('POST', '/api/settings/memory/clear'),

  kb: (q = '', section = '') => call<{ pages: KbPage[]; sections: string[]; enabled: boolean }>('GET', `/api/kb?q=${encodeURIComponent(q)}&section=${encodeURIComponent(section)}`),
  kbPage: (id: string) => call<{ page?: KbPage; error?: string }>('GET', `/api/kb/page/${id}`),
  kbHistory: (id: string) => call<{ revisions: KbRevision[] }>('GET', `/api/kb/page/${id}/history`),
  kbCreate: (b: { section: string; slug: string; title: string; body: string; tags?: string[] }) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', '/api/kb/page', b),
  kbPatch: (id: string, b: { title?: string; body?: string; tags?: string[]; summary?: string }) => call<{ ok: boolean; page?: KbPage; error?: string }>('PATCH', `/api/kb/page/${id}`, b),
  kbRevert: (id: string, rev: number) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', `/api/kb/page/${id}/revert`, { rev }),
  kbDelete: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/kb/page/${id}`),

  tasks: (q = '', status = '') => call<{ tasks: Task[]; counts: Record<TaskStatus, number>; agents: string[] }>('GET', `/api/tasks?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  task: (id: string) => call<{ task?: Task; events?: TaskEvent[]; attachments?: TaskAttachment[]; dependents?: string[]; error?: string }>('GET', `/api/tasks/${id}`),
  addTask: (b: AddTaskReq) => call<{ ok: boolean; task?: Task; error?: string }>('POST', '/api/tasks', b),
  patchTask: (id: string, b: { title?: string; body?: string; status?: TaskStatus; assignee?: string | null; priority?: number; labels?: string[]; mode?: 'headless' | 'interactive'; goalId?: string | null; criteria?: string | null; dependsOn?: string[]; dueAt?: number | null; note?: string }) => call<{ ok: boolean; task?: Task; error?: string }>('PATCH', `/api/tasks/${id}`, b),
  commentTask: (id: string, body: string) => call<{ ok: boolean; task?: Task; error?: string }>('POST', `/api/tasks/${id}/comment`, { body }),
  dispatchTask: (id: string) => call<{ ok: boolean; sessionId?: string; error?: string }>('POST', `/api/tasks/${id}/dispatch`),
  deleteTask: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/tasks/${id}`),
  /** Upload a file onto a task (raw bytes). */
  uploadTaskAttachment: async (id: string, file: File): Promise<{ ok: boolean; attachment?: TaskAttachment; error?: string }> => {
    const r = await fetch(`/api/tasks/${id}/attachments?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', body: file })
    return r.json()
  },
  deleteTaskAttachment: (taskId: string, attId: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/tasks/${taskId}/attachments/${attId}`),
  /** Direct URL to an attachment's bytes (inline; for download/preview links). */
  taskAttachmentUrl: (taskId: string, attId: string) => `/api/tasks/${taskId}/attachments/${attId}/raw`,

  goals: (q = '', status = '') => call<{ goals: Goal[]; counts: GoalCounts; progress: Record<string, GoalProgress>; autoPlan?: boolean }>('GET', `/api/goals?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  setAutoPlanGoals: (on: boolean) => call<{ ok: boolean; autoPlan?: boolean; error?: string }>('POST', '/api/goals/autoplan', { on }),
  goal: (id: string) => call<{ goal?: Goal; events?: GoalEvent[]; tasks?: Task[]; progress?: GoalProgress; error?: string }>('GET', `/api/goals/${id}`),
  addGoal: (b: AddGoalReq) => call<{ ok: boolean; goal?: Goal; error?: string }>('POST', '/api/goals', b),
  patchGoal: (id: string, b: { title?: string; body?: string; status?: GoalStatus; target?: string | null; owner?: string | null; parentId?: string | null; labels?: string[]; dueAt?: number | null; note?: string }) => call<{ ok: boolean; goal?: Goal; error?: string }>('PATCH', `/api/goals/${id}`, b),
  commentGoal: (id: string, body: string) => call<{ ok: boolean; goal?: Goal; error?: string }>('POST', `/api/goals/${id}/comment`, { body }),
  deleteGoal: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/goals/${id}`),
  planGoal: (id: string) => call<{ ok: boolean; sessionId?: string; error?: string }>('POST', `/api/goals/${id}/plan`),
  dreaming: () => call<{ everyHours: number; lastDreamedAt?: number; applyLearnings?: boolean; guidance?: string; recommendations?: Recommendation[]; digest?: DigestConfig; state?: DreamingState; measurement?: Measurement; insights?: Insights; improvements?: ImprovementTile[]; proposals?: string[]; stuckGoals?: StuckGoal[]; troubledAutomations?: TroubledAutomation[]; alertsEnabled?: boolean; error?: string }>('GET', '/api/dreaming'),
  applyRecommendation: (id: string) => call<{ ok: boolean; applied?: unknown; error?: string }>('POST', `/api/dreaming/recommendation/${id}/apply`),
  dismissRecommendation: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/dreaming/recommendation/${id}/dismiss`),
  setDreaming: (everyHours: number) => call<{ ok: boolean; everyHours: number; error?: string }>('PUT', '/api/dreaming', { everyHours }),
  setApplyLearnings: (applyLearnings: boolean) => call<{ ok: boolean; applyLearnings: boolean; error?: string }>('PUT', '/api/dreaming', { applyLearnings }),
  setInsightAlerts: (alertsEnabled: boolean) => call<{ ok: boolean; error?: string }>('PUT', '/api/dreaming', { alertsEnabled }),
  // One "reflect" pass: cheap deterministic tally + the memory-gardener over new material (nested `consolidation`).
  dreamingRun: () => call<{ ok: boolean; skipped?: boolean; sessions?: number; episodes?: number; kbPageId?: string; insightId?: string; guidance?: string; consolidation?: { spawned?: boolean; reason?: string; sessionId?: string; items?: number }; error?: string }>('POST', '/api/dreaming/run'),
  // Daily digest — the "what got done today" standup (rides the Dreaming pass; posts to Slack at EOD).
  setDigest: (digest: { enabled?: boolean; channel?: string; discordChannel?: string; hour?: number }) => call<{ ok: boolean; digest: DigestConfig; error?: string }>('PUT', '/api/dreaming', { digest }),
  digestToday: () => call<DigestModel & { error?: string }>('GET', '/api/digest/today'),
  digestPost: () => call<{ ok: boolean; posted: boolean; reason?: string; total: number; iso: string; error?: string; platforms?: { platform: 'slack' | 'discord'; posted: boolean; channel: string; error?: string }[] }>('POST', '/api/digest/post'),
  // Clear & refresh today's digest — re-render the KB page + reset the once-per-day post guard.
  digestRefresh: () => call<DigestModel & { ok: boolean; error?: string }>('POST', '/api/digest/refresh'),
  // Spawn the analyst to diagnose why a struggling agent keeps failing (writes a KB page).
  diagnose: (agent: string) => call<{ ok: boolean; spawned: boolean; reason?: string; sessionId?: string; items?: number; slug?: string; error?: string }>('POST', '/api/insights/diagnose', { agent }),
  // Spawn the improver to DRAFT a better CLAUDE.md (lands as a review-gated proposal), then apply/dismiss it.
  improveAgent: (agent: string) => call<{ ok: boolean; spawned: boolean; reason?: string; sessionId?: string; items?: number; slug?: string; error?: string }>('POST', '/api/insights/improve', { agent }),
  applyProposal: (agent: string) => call<{ ok: boolean; rev?: number; error?: string }>('POST', `/api/insights/proposal/${encodeURIComponent(agent)}/apply`),
  dismissProposal: (agent: string) => call<{ ok: boolean; error?: string }>('POST', `/api/insights/proposal/${encodeURIComponent(agent)}/dismiss`),
  // Memory domain: preview exactly what a cleanup would prune + merge (no mutation), then apply the same plan.
  memoryCleanupPreview: () => call<{ ok: boolean; plan?: MemoryCleanupPlan; error?: string }>('GET', '/api/insights/memory/cleanup'),
  memoryCleanupApply: () => call<{ ok: boolean; pruned?: number; merged?: number; error?: string }>('POST', '/api/insights/memory/cleanup'),
  // Skills domain: spawn the scout to mine fleet runs for a recurring pattern and draft a skill (proposal-gated).
  draftSkill: () => call<{ ok: boolean; spawned: boolean; reason?: string; sessionId?: string; items?: number; error?: string }>('POST', '/api/insights/skills/draft'),
  // KB domain: preview which dead pages would be archived (no mutation), then apply (soft remove, revertable).
  kbTidyPreview: () => call<{ ok: boolean; plan?: KbTidyPlan; error?: string }>('GET', '/api/insights/kb/tidy'),
  kbTidyApply: () => call<{ ok: boolean; archived?: number; error?: string }>('POST', '/api/insights/kb/tidy'),

  createAgent: (input: { id: string; description: string; category?: string; claudeMd: string; examplePrompts?: string[]; shellSecrets?: string[]; icon?: string } & RuntimeTuning) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/agents', input),
  deleteAgent: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  duplicateAgent: (id: string, newId: string) => call<{ ok: boolean; id?: string; error?: string }>('POST', `/api/agents/${encodeURIComponent(id)}/duplicate`, { newId }),
  agentCatalog: () => call<AgentCatalogResp>('GET', '/api/agents/catalog'),
  installAgentFromCatalog: (id: string) => call<{ ok: boolean; id?: string; error?: string }>('POST', `/api/agents/catalog/${encodeURIComponent(id)}/install`),
  rescanAgents: () => call<{ ok: boolean; added: string[]; updated: string[]; removed: string[]; errors: { folder: string; error: string }[]; error?: string }>('POST', '/api/agents/rescan'),
  agentStats: (id: string) => call<{ stats: AgentStats }>('GET', `/api/agents/${encodeURIComponent(id)}/stats`),
  agentStatsAll: () => call<{ stats: AgentStats[] }>('GET', '/api/agents/stats'),
  presence: () => call<{ now: number; lastSeen: Record<string, number> }>('GET', '/api/presence'),
  agentClaude: (id: string) => call<{ agent: string; runtime: string; exists: boolean; content: string; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/claude`),
  saveAgentClaude: (id: string, content: string) => call<{ ok: boolean; error?: string }>('PUT', `/api/agents/${encodeURIComponent(id)}/claude`, { content }),
  agentConfig: (id: string) => call<{ agent: string; error?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; netMode?: 'open' | 'allowlist'; category?: string; icon?: string } & RuntimeTuning>('GET', `/api/agents/${encodeURIComponent(id)}/config`),
  saveAgentConfig: (id: string, patch: RuntimeTuning & { description?: string; examplePrompts?: string[]; shellSecrets?: string[]; netMode?: 'open' | 'allowlist'; category?: string; icon?: string }) => call<{ ok: boolean; error?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; netMode?: 'open' | 'allowlist'; category?: string; icon?: string } & RuntimeTuning>('PUT', `/api/agents/${encodeURIComponent(id)}/config`, patch),
  agentRevisions: (id: string) => call<{ agent: string; revisions: AgentRevision[]; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/revisions`),
  agentRevert: (id: string, rev: number) => call<{ ok: boolean; id?: string; toRev?: number; rev?: number; error?: string }>('POST', `/api/agents/${encodeURIComponent(id)}/revert`, { rev }),
  runtimeDefaults: () => call<RuntimeTuning & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/runtime-defaults'),
  saveRuntimeDefaults: (tuning: RuntimeTuning) => call<{ ok: boolean; error?: string } & RuntimeTuning>('PUT', '/api/settings/runtime-defaults', tuning),
  concurrency: () => call<Concurrency & { error?: string }>('GET', '/api/settings/concurrency'),
  saveConcurrency: (body: { value?: number | null; idleHours?: number }) => call<{ ok: boolean; error?: string; value?: number | null; resolved?: number; derived?: number; idleHours?: number }>('PUT', '/api/settings/concurrency', body),

  governance: () => call<GovernanceThresholds & { hostGovernanceEnabled?: boolean; updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/governance'),
  saveGovernance: (t: GovernanceThresholds & { hostGovernanceEnabled?: boolean }) => call<{ ok: boolean; error?: string; hostGovernanceEnabled?: boolean } & GovernanceThresholds>('PUT', '/api/settings/governance', t),

  // Per-tenant console branding (accent colour + favicon badge).
  branding: () => call<Branding & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/branding'),
  saveBranding: (b: Branding) => call<{ ok: boolean; error?: string } & Branding>('PUT', '/api/settings/branding', b),

  // Secrets vault — metadata only on the way out; values only ever travel inbound.
  secrets: () => call<{ secrets: SecretMeta[]; error?: string }>('GET', '/api/secrets'),
  setSecret: (key: string, value: string, principal?: string) => call<{ ok: boolean; error?: string }>('POST', '/api/secrets', { key, value, principal }),
  deleteSecret: (key: string, principal?: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/secrets', { key, principal }),
  setSecretAgents: (principal: string, key: string, agents: string[]) => call<{ ok: boolean; agents?: string[]; error?: string }>('PUT', '/api/secrets/agents', { principal, key, agents }),
  secretRequests: () => call<SecretRequestsResp>('GET', '/api/secrets/requests'),
  // provide mode: pass the typed `value` (+ optional principal). access (grant) mode: omit `value`,
  // pass `grantRead` (enable secret_get) and/or `inject`. `inject` applies to both modes.
  fulfillSecretRequest: (id: string, opts: { value?: string; principal?: string; inject?: boolean; grantRead?: boolean }) =>
    call<{ ok: boolean; injected?: boolean; granted?: boolean; error?: string }>('POST', '/api/secrets/requests/' + encodeURIComponent(id) + '/fulfill', opts),
  dismissSecretRequest: (id: string) =>
    call<{ ok: boolean; error?: string }>('POST', '/api/secrets/requests/' + encodeURIComponent(id) + '/dismiss'),
  killSwitch: () => call<{ engaged: boolean; reason?: string; updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/kill-switch'),
  setKillSwitch: (engaged: boolean, reason?: string, haltSessions?: boolean) => call<{ ok: boolean; engaged: boolean; reason?: string; halted?: number; updatedBy?: string; error?: string }>('POST', '/api/settings/kill-switch', { engaged, reason, haltSessions }),


  settings: () => call<CompanySettings>('GET', '/api/settings'),
  saveCompany: (companyMd: string) => call<CompanySettings & { ok: boolean; error?: string }>('PUT', '/api/settings/company', { companyMd }),
  connections: () => call<ConnectionsResp>('GET', '/api/connections'),
  integrationsOverview: () => call<IntegrationsOverview>('GET', '/api/integrations/overview'),
  composioToolkits: () => call<{ toolkits: { slug: string; name: string }[]; error?: string }>('GET', '/api/composio/toolkits'),
  connectApp: (body: { toolkit: string; scope: 'company' | 'personal' }) =>
    call<{ redirectUrl?: string; error?: string }>('POST', '/api/connections/connect', body),
  disconnectApp: (body: { id: string; scope: 'company' | 'personal' }) =>
    call<{ ok?: boolean; error?: string }>('POST', '/api/connections/disconnect', body),
  integrations: () => call<IntegrationsResp>('GET', '/api/settings/integrations'),
  atlasModels: () => call<{ configured: boolean; image: { id: string; label: string; priceUsd: number | null }[]; video: { id: string; label: string; priceUsd: number | null }[]; error?: string }>('GET', '/api/integrations/atlas/models'),
  saveIntegrations: (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string; githubClientId?: string; githubClientSecret?: string; githubAppId?: string; githubPrivateKey?: string; githubAppSlug?: string; openRouterKey?: string; atlasKey?: string; imageDefaultModel?: string; falKey?: string; videoDefaultModel?: string; chatRouter?: boolean; chatIdleTimeoutMin?: number }) => call<IntegrationsResp & { ok: boolean }>('PUT', '/api/settings/integrations', body),
  // Per-member GitHub (user-to-server OAuth): each member links their OWN account so run-as sessions
  // push / open PRs as the actual human. `connect` returns the authorize URL to navigate to.
  githubMe: () => call<GithubMe>('GET', '/api/github/me'),
  githubConnect: (returnTo?: string) => call<{ redirectUrl?: string; error?: string }>('GET', `/api/github/connect${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`),
  githubDisconnect: () => call<{ ok?: boolean; error?: string }>('POST', '/api/github/disconnect', {}),
  // One-click App setup: returns GitHub's form-POST target + the pre-filled manifest to submit to it.
  githubManifest: (org?: string) => call<{ postUrl?: string; manifest?: string; error?: string }>('GET', `/api/github/manifest${org ? `?org=${encodeURIComponent(org)}` : ''}`),
  slackStatus: () => call<SlackStatus>('GET', '/api/settings/slack/status'),
  discordStatus: () => call<DiscordStatus>('GET', '/api/settings/discord/status'),

  skills: () => call<SkillsResp>('GET', '/api/skills'),
  skill: (name: string) => call<SkillDetail & { error?: string }>('GET', '/api/skills/' + encodeURIComponent(name)),
  createSkill: (input: { name: string; description?: string; content?: string }) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills', input),
  saveSkill: (name: string, content: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('PUT', '/api/skills/' + encodeURIComponent(name), { content }),
  deleteSkill: (name: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/skills/' + encodeURIComponent(name)),
  duplicateSkill: (name: string, newName: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills/' + encodeURIComponent(name) + '/duplicate', { name: newName }),
  publishSkill: (name: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills/' + encodeURIComponent(name) + '/publish'),
  setSkillAgents: (name: string, agents: string[]) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('PUT', '/api/skills/' + encodeURIComponent(name) + '/agents', { agents }),
  skillRequests: () => call<SkillRequestsResp>('GET', '/api/skills/requests'),
  approveSkillRequest: (id: string, scope?: 'agent' | 'all') =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills/requests/' + encodeURIComponent(id) + '/approve', scope ? { scope } : {}),
  dismissSkillRequest: (id: string) =>
    call<{ ok: boolean; error?: string }>('POST', '/api/skills/requests/' + encodeURIComponent(id) + '/dismiss'),
  skillCatalog: () => call<CatalogResp>('GET', '/api/skills/catalog'),
  installSkill: (name: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills/catalog/' + encodeURIComponent(name) + '/install'),
  skillSources: () => call<SkillSourcesResp>('GET', '/api/skills/sources'),
  browseSkillRepo: (repo: string) =>
    call<RemoteCatalogResp>('GET', '/api/skills/sources/browse?repo=' + encodeURIComponent(repo)),
  installRemoteSkill: (repo: string, path: string, name?: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills/sources/install', { repo, path, name }),
  searchSkillsh: (q: string) => call<SkillshResp>('GET', '/api/skills/sources/search?q=' + encodeURIComponent(q)),
  /** Install one or more skills from an uploaded .zip (drag-and-drop or the Upload button). */
  uploadSkillZip: async (file: File): Promise<{ ok: boolean; skills?: SkillDetail[]; error?: string }> => {
    const res = await fetch('/api/skills/upload?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    })
    return res.json()
  },
  /** Import an agent from an "AOS bundle" .zip — writes the agent + replays its memory/knowledge/skills. */
  importAgentBundle: async (file: File): Promise<{ ok: boolean; id?: string; skills?: number; memories?: number; knowledge?: number; warnings?: string[]; error?: string }> => {
    const res = await fetch('/api/agents/import', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    })
    return res.json()
  },

  policy: () => call<PolicyResp>('GET', '/api/policy'),
  savePolicy: (document: PolicyDocument) => call<{ ok: boolean; document?: PolicyDocument; error?: string }>('PUT', '/api/policy', { document }),
  policyProposals: () => call<PolicyProposalsResp>('GET', '/api/policy/proposals'),
  approvePolicyProposal: (id: string) => call<{ ok: boolean; rev?: number; document?: PolicyDocument; error?: string }>('POST', '/api/policy/proposals/' + encodeURIComponent(id) + '/approve'),
  rejectPolicyProposal: (id: string, note?: string) => call<{ ok: boolean; error?: string }>('POST', '/api/policy/proposals/' + encodeURIComponent(id) + '/reject', { note }),
  policyRevisions: () => call<PolicyRevisionsResp>('GET', '/api/policy/revisions'),
  revertPolicy: (rev: number) => call<{ ok: boolean; rev?: number; document?: PolicyDocument; error?: string }>('POST', '/api/policy/revisions/' + rev + '/revert'),

  files: {
    list: (path = '') => call<DirListing>('GET', `/api/files/list?path=${encodeURIComponent(path)}`),
    read: (path: string) => call<FileContent>('GET', `/api/files/read?path=${encodeURIComponent(path)}`),
    write: (path: string, content: string) => call<{ ok: boolean; error?: string }>('PUT', '/api/files/write', { path, content }),
    create: (path: string, content = '') => call<{ ok: boolean; path?: string; error?: string }>('POST', '/api/files/create', { path, content }),
    mkdir: (path: string) => call<{ ok: boolean; path?: string; error?: string }>('POST', '/api/files/mkdir', { path }),
    remove: (path: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/files/delete?path=${encodeURIComponent(path)}`),
    rename: (from: string, to: string) => call<{ ok: boolean; path?: string; error?: string }>('POST', '/api/files/rename', { from, to }),
    /** Direct URL to a file's bytes as an attachment (for download links). */
    downloadUrl: (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`,
    /**
     * Upload raw bytes into `dir` under `name` (drag-drop / picker). Pass `rel` = the file's path within
     * a dropped folder (its `webkitRelativePath`) to recreate the folder tree server-side; intermediate
     * directories are created for you.
     */
    upload: async (dir: string, file: File, rel?: string): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const qs = `path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`
        + (rel ? `&rel=${encodeURIComponent(rel)}` : '')
      const r = await fetch(`/api/files/upload?${qs}`, { method: 'POST', credentials: 'same-origin', body: file })
      try { return await r.json() } catch { return { ok: r.ok, error: r.ok ? undefined : `upload failed (${r.status})` } }
    },
  },

  artifacts: () => call<{ artifacts: Artifact[]; enabled: boolean }>('GET', '/api/artifacts'),
  deleteArtifact: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/artifacts/' + id),
  moveArtifact: (id: string, folder: string) => call<{ ok: boolean; artifact?: Artifact; error?: string }>('PATCH', '/api/artifacts/' + id, { folder }),
  /** Direct URL to an artifact's bytes (for <img>/<iframe>/download). `file` selects a sibling (sites). */
  artifactRawUrl: (id: string, file?: string) => `/api/artifacts/${id}/raw${file ? `?file=${encodeURIComponent(file)}` : ''}`,

  // Hosted apps (owner/admin) — the management surface for small server-side apps.
  apps: () => call<{ apps: AppInfo[]; enabled: boolean }>('GET', '/api/apps'),
  createApp: (body: { id: string; name: string; icon?: string; capabilities?: AppCapabilities }) => call<{ ok?: boolean; app?: AppInfo; error?: string }>('POST', '/api/apps', body),
  getApp: (slug: string) => call<{ app: AppInfo; files: AppFile[]; source: string; log: string; secretsSet: string[] }>('GET', '/api/apps/' + slug),
  saveApp: (slug: string, body: { name?: string; icon?: string; lifecycle?: string; idleTimeoutSec?: number; capabilities?: AppCapabilities; domains?: string[]; source?: string }) => call<{ ok?: boolean; app?: AppInfo; error?: string }>('PUT', '/api/apps/' + slug, body),
  // Multi-file source: the tree + per-file read/write/delete (owner/admin).
  appFiles: (slug: string) => call<{ files: AppFile[] }>('GET', `/api/apps/${slug}/files`),
  readAppFile: (slug: string, filePath: string) => call<{ path: string; content: string; error?: string }>('GET', `/api/apps/${slug}/file?path=${encodeURIComponent(filePath)}`),
  writeAppFile: (slug: string, filePath: string, content: string) => call<{ ok?: boolean; files?: AppFile[]; error?: string }>('PUT', `/api/apps/${slug}/file`, { path: filePath, content }),
  deleteAppFile: (slug: string, filePath: string) => call<{ ok?: boolean; files?: AppFile[]; error?: string }>('DELETE', `/api/apps/${slug}/file?path=${encodeURIComponent(filePath)}`),
  // App secrets: store/clear a value for a declared key (write-only, sealed under app:<slug>).
  setAppSecret: (slug: string, key: string, value: string) => call<{ ok?: boolean; error?: string }>('PUT', `/api/apps/${slug}/secret`, { key, value }),
  clearAppSecret: (slug: string, key: string) => call<{ ok?: boolean; error?: string }>('DELETE', `/api/apps/${slug}/secret?key=${encodeURIComponent(key)}`),
  publishApp: (slug: string) => call<{ ok?: boolean; app?: AppInfo; error?: string }>('POST', `/api/apps/${slug}/publish`),
  unpublishApp: (slug: string) => call<{ ok?: boolean; app?: AppInfo; error?: string }>('POST', `/api/apps/${slug}/unpublish`),
  stopApp: (slug: string) => call<{ ok?: boolean }>('POST', `/api/apps/${slug}/stop`),
  deleteApp: (slug: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/apps/' + slug),
  /** The mounted URL a published app is served at (open in a new tab). */
  appUrl: (slug: string) => `/apps/${slug}/`,

  connectors: () => call<ConnectorsResp>('GET', '/api/connectors'),
  addConnector: (c: AddConnectorReq) => call<Connector | { error: string }>('POST', '/api/connectors', c),
  deleteConnector: (id: string) => call<{ ok: boolean }>('DELETE', '/api/connectors/' + id),
  toggleConnector: (id: string, enabled: boolean) => call<Connector>('PATCH', '/api/connectors/' + id, { enabled }),
  shareConnector: (id: string, shared: boolean) => call<Connector>('PATCH', '/api/connectors/' + id, { shared }),

  hosts: () => call<HostsResp>('GET', '/api/hosts'),
  addHost: (h: AddHostReq) => call<Host | { error: string }>('POST', '/api/hosts', h),
  updateHost: (id: string, patch: Partial<AddHostReq>) => call<Host | { error: string }>('PATCH', '/api/hosts/' + id, patch),
  toggleHost: (id: string, enabled: boolean) => call<Host>('PATCH', '/api/hosts/' + id, { enabled }),
  shareHost: (id: string, shared: boolean) => call<Host>('PATCH', '/api/hosts/' + id, { shared }),
  deleteHost: (id: string) => call<{ ok: boolean }>('DELETE', '/api/hosts/' + id),
  publishHost: (id: string) => call<Host | { error: string }>('POST', '/api/hosts/' + id + '/publish'),
}
