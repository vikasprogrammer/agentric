export type Role = 'owner' | 'admin' | 'member'
export interface Member {
  id: string
  email: string
  name: string
  role: Role
  status: 'invited' | 'active'
  createdAt: number
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
  spawnedBy?: string
  spawnedByLabel?: string
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
export interface Artifact {
  id: string
  sessionId: string
  agent: string
  source?: string
  kind: string
  title: string
  description?: string
  filename: string
  relPath: string
  mime: string
  bytes: number
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
  kind: 'comment' | 'status' | 'claim' | 'dispatch' | 'assign' | 'link'
  body?: string
  author: string
  sessionId?: string
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
  mode?: 'headless' | 'interactive'
  autoDispatch?: boolean
  dueAt?: number
}

export interface Msg {
  id: string
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact' | 'notification' | 'skill.proposed'
  sessionId: string
  agent: string
  title: string
  body: string
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'answered'
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

export type ExecMode = 'interactive' | 'headless'
export interface Automation {
  id: string
  agentId: string
  name: string
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord'
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

export interface CompanySettings {
  companyMd: string
  updatedAt?: number
  updatedBy?: string
  error?: string
}

/** A stored secret's identity + provenance — the value is NEVER returned by the API. */
export interface SecretMeta {
  principal: string
  key: string
  updatedAt: number
  updatedBy?: string
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
  /** Generic `/agent` chat router: when on, an unmatched Slack/Discord message reaches any agent by name. */
  chatRouter: boolean
  /** Warm (resident) Slack thread session idle-kill, minutes. 0 = residence off (every reply cold-starts). */
  chatIdleTimeoutMin: number
  updatedAt?: number
  updatedBy?: string
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
    return (await res.json()).member as Member
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
  messages: () => call<Msg[]>('GET', '/api/messages'),
  run: (agent: string, task: string) => call<{ id: string; tmux: string; error?: string }>('POST', '/api/sessions', { agent, task }),
  stopSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/stop`),
  deleteSession: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/sessions/' + id),
  attach: (id: string) => call<{ url?: string; error?: string }>('GET', `/api/sessions/${id}/attach`),
  sessionTranscript: (id: string) => call<{ text?: string; error?: string }>('GET', `/api/sessions/${id}/transcript`),
  /** The agent-os primitives this session used — a classified timeline + grouped counts. */
  sessionActivity: (id: string) => call<SessionActivityResp>('GET', `/api/sessions/${id}/activity`),
  /** Upload a pasted/dropped image into a live session; the server saves it in the agent's folder and
   *  types the path into the running claude. `dataB64` is base64 (no data: prefix); `ext` e.g. 'png'. */
  attachFile: (id: string, dataB64: string, ext: string) =>
    call<{ ok: boolean; path?: string; error?: string }>('POST', `/api/sessions/${id}/attach-file`, { dataB64, ext }),
  resolve: (id: string, approved: boolean) => call<{ ok: boolean; error?: string }>('POST', '/api/approvals/' + id, { approved }),
  /** Approve this attempt AND add a persistent policy `allow` rule for its capability (owner-only). */
  alwaysApprove: (id: string) => call<{ ok: boolean; ruleAdded?: boolean; note?: string; error?: string }>('POST', `/api/approvals/${id}/always`),
  answerQuestion: (id: string, answer: string) => call<{ ok: boolean; error?: string }>('POST', '/api/questions/' + id, { answer }),
  dismissMessage: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/messages/${id}/dismiss`),
  dismissAllMessages: () => call<{ ok: boolean; dismissed?: number; error?: string }>('POST', '/api/messages/dismiss-all'),
  markRead: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/messages/${id}/read`),
  markAllRead: () => call<{ ok: boolean; read?: number; error?: string }>('POST', '/api/messages/read-all'),

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
  setAssignment: (agentId: string, access: AgentAccess) => call<{ ok: boolean; assignment: AgentAccess }>('PUT', '/api/team/assignments/' + agentId, access),
  setIdentity: (id: string, provider: IdentityProvider, externalId: string) => call<{ ok: boolean; identities: MemberIdentity[]; error?: string }>('POST', `/api/team/${id}/identities`, { provider, externalId }),
  clearIdentity: (id: string, provider: IdentityProvider) => call<{ ok: boolean; identities: MemberIdentity[]; error?: string }>('DELETE', `/api/team/${id}/identities/${provider}`),

  automations: () => call<{ automations: Automation[] }>('GET', '/api/automations'),
  addAutomation: (a: AddAutomationReq) => call<Automation & { error?: string }>('POST', '/api/automations', a),
  updateAutomation: (id: string, patch: Partial<Pick<Automation, 'name' | 'mode' | 'schedule' | 'task' | 'enabled'>>) =>
    call<Automation & { error?: string }>('PATCH', '/api/automations/' + id, patch),
  deleteAutomation: (id: string) => call<{ ok: boolean }>('DELETE', '/api/automations/' + id),
  runAutomation: (id: string) => call<{ ok: boolean; sessionId?: string; reason?: string; error?: string }>('POST', `/api/automations/${id}/run`),
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
  migrateMemory: (opts: { skipEpisodes: boolean; before?: number; limit?: number }) => call<{ ok: boolean; done?: boolean; before?: number; migrated?: number; skipped?: number; remaining?: number; note?: string; error?: string }>('POST', '/api/settings/memory/migrate', opts),
  clearMemoryLedger: () => call<{ ok: boolean; cleared?: number; error?: string }>('POST', '/api/settings/memory/clear'),

  kb: (q = '', section = '') => call<{ pages: KbPage[]; sections: string[]; enabled: boolean }>('GET', `/api/kb?q=${encodeURIComponent(q)}&section=${encodeURIComponent(section)}`),
  kbPage: (id: string) => call<{ page?: KbPage; error?: string }>('GET', `/api/kb/page/${id}`),
  kbHistory: (id: string) => call<{ revisions: KbRevision[] }>('GET', `/api/kb/page/${id}/history`),
  kbCreate: (b: { section: string; slug: string; title: string; body: string; tags?: string[] }) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', '/api/kb/page', b),
  kbPatch: (id: string, b: { title?: string; body?: string; tags?: string[]; summary?: string }) => call<{ ok: boolean; page?: KbPage; error?: string }>('PATCH', `/api/kb/page/${id}`, b),
  kbRevert: (id: string, rev: number) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', `/api/kb/page/${id}/revert`, { rev }),
  kbDelete: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/kb/page/${id}`),

  tasks: (q = '', status = '') => call<{ tasks: Task[]; counts: Record<TaskStatus, number>; agents: string[] }>('GET', `/api/tasks?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  task: (id: string) => call<{ task?: Task; events?: TaskEvent[]; error?: string }>('GET', `/api/tasks/${id}`),
  addTask: (b: AddTaskReq) => call<{ ok: boolean; task?: Task; error?: string }>('POST', '/api/tasks', b),
  patchTask: (id: string, b: { title?: string; body?: string; status?: TaskStatus; assignee?: string | null; priority?: number; labels?: string[]; mode?: 'headless' | 'interactive'; dueAt?: number | null; note?: string }) => call<{ ok: boolean; task?: Task; error?: string }>('PATCH', `/api/tasks/${id}`, b),
  commentTask: (id: string, body: string) => call<{ ok: boolean; task?: Task; error?: string }>('POST', `/api/tasks/${id}/comment`, { body }),
  dispatchTask: (id: string) => call<{ ok: boolean; sessionId?: string; error?: string }>('POST', `/api/tasks/${id}/dispatch`),
  deleteTask: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/tasks/${id}`),
  dreaming: () => call<{ everyHours: number; lastDreamedAt?: number; applyLearnings?: boolean; guidance?: string; recommendations?: Recommendation[]; error?: string }>('GET', '/api/dreaming'),
  applyRecommendation: (id: string) => call<{ ok: boolean; applied?: unknown; error?: string }>('POST', `/api/dreaming/recommendation/${id}/apply`),
  dismissRecommendation: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/dreaming/recommendation/${id}/dismiss`),
  setDreaming: (everyHours: number) => call<{ ok: boolean; everyHours: number; error?: string }>('PUT', '/api/dreaming', { everyHours }),
  setApplyLearnings: (applyLearnings: boolean) => call<{ ok: boolean; applyLearnings: boolean; error?: string }>('PUT', '/api/dreaming', { applyLearnings }),
  // One "reflect" pass: cheap deterministic tally + the memory-gardener over new material (nested `consolidation`).
  dreamingRun: () => call<{ ok: boolean; skipped?: boolean; sessions?: number; episodes?: number; kbPageId?: string; insightId?: string; guidance?: string; consolidation?: { spawned?: boolean; reason?: string; sessionId?: string; items?: number }; error?: string }>('POST', '/api/dreaming/run'),

  createAgent: (input: { id: string; description: string; category?: string; claudeMd: string; examplePrompts?: string[]; shellSecrets?: string[]; icon?: string } & RuntimeTuning) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/agents', input),
  deleteAgent: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  duplicateAgent: (id: string, newId: string) => call<{ ok: boolean; id?: string; error?: string }>('POST', `/api/agents/${encodeURIComponent(id)}/duplicate`, { newId }),
  agentCatalog: () => call<AgentCatalogResp>('GET', '/api/agents/catalog'),
  installAgentFromCatalog: (id: string) => call<{ ok: boolean; id?: string; error?: string }>('POST', `/api/agents/catalog/${encodeURIComponent(id)}/install`),
  rescanAgents: () => call<{ ok: boolean; added: string[]; updated: string[]; removed: string[]; errors: { folder: string; error: string }[]; error?: string }>('POST', '/api/agents/rescan'),
  agentClaude: (id: string) => call<{ agent: string; runtime: string; exists: boolean; content: string; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/claude`),
  saveAgentClaude: (id: string, content: string) => call<{ ok: boolean; error?: string }>('PUT', `/api/agents/${encodeURIComponent(id)}/claude`, { content }),
  agentConfig: (id: string) => call<{ agent: string; error?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; category?: string; icon?: string } & RuntimeTuning>('GET', `/api/agents/${encodeURIComponent(id)}/config`),
  saveAgentConfig: (id: string, patch: RuntimeTuning & { description?: string; examplePrompts?: string[]; shellSecrets?: string[]; category?: string; icon?: string }) => call<{ ok: boolean; error?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; category?: string; icon?: string } & RuntimeTuning>('PUT', `/api/agents/${encodeURIComponent(id)}/config`, patch),
  agentRevisions: (id: string) => call<{ agent: string; revisions: AgentRevision[]; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/revisions`),
  agentRevert: (id: string, rev: number) => call<{ ok: boolean; id?: string; toRev?: number; rev?: number; error?: string }>('POST', `/api/agents/${encodeURIComponent(id)}/revert`, { rev }),
  runtimeDefaults: () => call<RuntimeTuning & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/runtime-defaults'),
  saveRuntimeDefaults: (tuning: RuntimeTuning) => call<{ ok: boolean; error?: string } & RuntimeTuning>('PUT', '/api/settings/runtime-defaults', tuning),

  governance: () => call<GovernanceThresholds & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/governance'),
  saveGovernance: (t: GovernanceThresholds) => call<{ ok: boolean; error?: string } & GovernanceThresholds>('PUT', '/api/settings/governance', t),

  // Secrets vault — metadata only on the way out; values only ever travel inbound.
  secrets: () => call<{ secrets: SecretMeta[]; error?: string }>('GET', '/api/secrets'),
  setSecret: (key: string, value: string, principal?: string) => call<{ ok: boolean; error?: string }>('POST', '/api/secrets', { key, value, principal }),
  deleteSecret: (key: string, principal?: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/secrets', { key, principal }),
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
  saveIntegrations: (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string; chatRouter?: boolean; chatIdleTimeoutMin?: number }) => call<IntegrationsResp & { ok: boolean }>('PUT', '/api/settings/integrations', body),
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
  /** Direct URL to an artifact's bytes (for <img>/<iframe>/download). `file` selects a sibling (sites). */
  artifactRawUrl: (id: string, file?: string) => `/api/artifacts/${id}/raw${file ? `?file=${encodeURIComponent(file)}` : ''}`,

  connectors: () => call<ConnectorsResp>('GET', '/api/connectors'),
  addConnector: (c: AddConnectorReq) => call<Connector | { error: string }>('POST', '/api/connectors', c),
  deleteConnector: (id: string) => call<{ ok: boolean }>('DELETE', '/api/connectors/' + id),
  toggleConnector: (id: string, enabled: boolean) => call<Connector>('PATCH', '/api/connectors/' + id, { enabled }),
  shareConnector: (id: string, shared: boolean) => call<Connector>('PATCH', '/api/connectors/' + id, { shared }),
}
