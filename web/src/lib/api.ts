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
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']
/** Per-agent / workspace runtime tuning for claude-code sessions. Each field optional → inherit. */
export interface RuntimeTuning {
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
}

export interface AgentInfo {
  id: string
  description: string
  runtime: 'mock' | 'claude-code'
  /** True when the agent lives under the data home (user-created) and can be deleted. */
  deletable?: boolean
  /** Per-agent runtime tuning (claude-code only); undefined fields inherit the workspace default. */
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  /** Suggested first tasks shown as clickable chips on the spawn card. */
  examplePrompts?: string[]
}
export interface StateResp {
  tenant: string
  /** Human label for the tenant (branding); falls back to the tenant id server-side. */
  tenantName?: string
  policy: string
  home?: string
  me: Member
  terminalAgents: string[]
  agents: AgentInfo[]
  capabilities: { id: string; description: string; defaultRisk: string }[]
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
  status: 'running' | 'idle'
  spawnedBy?: string
  spawnedByLabel?: string
  createdAt: number
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
  apply?: { runtimeDefaults?: { model?: string; effort?: string; permissionMode?: string } }
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

export interface Msg {
  id: string
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact'
  sessionId: string
  agent: string
  title: string
  body: string
  status: 'open' | 'pending' | 'approved' | 'rejected' | 'answered'
  approvalId?: string
  capability?: string
  args?: unknown
  level?: 'head' | 'owner'
  source?: string
  questionId?: string
  answer?: string
  outcome?: string
  /** approval: the policy's reason this needs sign-off (vs `body`, the agent's own reasoning). */
  policyReason?: string
  /** approval/question: who resolved/answered it (email) — shown on the resolved card. */
  resolvedBy?: string
  answeredBy?: string
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
export interface MemoryRanking { halfLifeDays?: number; weightByImportance?: boolean }
export interface MemoryMaintenance { pruneAfterDays?: number; keepImportance?: number; dedupeThreshold?: number; everyHours?: number }
export interface MemorySettings {
  backend: MemoryBackend
  sqlite?: { embeddings?: EmbeddingsView }
  libsql?: { url: string; authTokenSet: boolean; embeddings?: EmbeddingsView }
  automem?: { endpoint: string; tokenSet: boolean }
  ranking?: MemoryRanking
  maintenance?: MemoryMaintenance
  sharedWrites?: 'open' | 'curated'
  health?: MemoryHealth
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
}
export interface SkillDetail extends SkillSummary {
  content: string
}
export interface SkillsResp {
  enabled: boolean
  skills: SkillSummary[]
  error?: string
}

export interface CompanySettings {
  companyMd: string
  updatedAt?: number
  updatedBy?: string
  error?: string
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

export type RiskClass = 'green' | 'yellow' | 'red' | 'deny'
export type PolicyOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'
export interface PolicyRule {
  match: { capability: string; when?: { arg: string; op: PolicyOp; value: number | string | boolean } }
  risk: RiskClass
}
export interface PolicyDocument {
  id: string
  description?: string
  defaultRisk: RiskClass
  approvalRouting: { yellow: 'head' | 'owner'; red: 'head' | 'owner' }
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

  state: () => call<StateResp>('GET', '/api/state'),
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  messages: () => call<Msg[]>('GET', '/api/messages'),
  run: (agent: string, task: string) => call<{ id: string; tmux: string; error?: string }>('POST', '/api/sessions', { agent, task }),
  stopSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/stop`),
  deleteSession: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/sessions/' + id),
  attach: (id: string) => call<{ url?: string; error?: string }>('GET', `/api/sessions/${id}/attach`),
  resolve: (id: string, approved: boolean) => call<{ ok: boolean; error?: string }>('POST', '/api/approvals/' + id, { approved }),
  answerQuestion: (id: string, answer: string) => call<{ ok: boolean; error?: string }>('POST', '/api/questions/' + id, { answer }),
  dismissMessage: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/messages/${id}/dismiss`),

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

  memory: (agent: string, q = '', limit = 50, scope: 'all' | 'agent' | 'tenant' = 'all') =>
    call<{ memories: MemoryRecord[] }>('GET', `/api/memory?agent=${encodeURIComponent(agent)}&q=${encodeURIComponent(q)}&limit=${limit}&scope=${scope}`),
  addMemory: (m: AddMemoryReq) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/memory', m),
  updateMemory: (id: string, m: { agent: string; content?: string; tags?: string[]; type?: string; importance?: number }) =>
    call<{ ok: boolean; memory?: MemoryRecord; error?: string }>('PATCH', '/api/memory/' + id, m),
  deleteMemory: (id: string, agent: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/memory/${id}?agent=${encodeURIComponent(agent)}`),
  memoryHealth: () => call<MemoryHealth>('GET', '/api/memory/health'),
  memorySettings: () => call<MemorySettings>('GET', '/api/settings/memory'),
  saveMemorySettings: (body: MemorySettingsReq) => call<MemorySettings & { ok: boolean }>('PUT', '/api/settings/memory', body),
  testMemorySettings: (body: MemorySettingsReq) => call<{ ok: boolean; health?: MemoryHealth; error?: string }>('POST', '/api/settings/memory/test', body),
  ollamaStatus: (url: string) => call<OllamaStatus>('GET', '/api/settings/memory/ollama?url=' + encodeURIComponent(url)),
  maintainMemory: () => call<{ ok: boolean; pruned?: number; merged?: number; error?: string }>('POST', '/api/settings/memory/maintain'),

  kb: (q = '', section = '') => call<{ pages: KbPage[]; sections: string[]; enabled: boolean }>('GET', `/api/kb?q=${encodeURIComponent(q)}&section=${encodeURIComponent(section)}`),
  kbPage: (id: string) => call<{ page?: KbPage; error?: string }>('GET', `/api/kb/page/${id}`),
  kbHistory: (id: string) => call<{ revisions: KbRevision[] }>('GET', `/api/kb/page/${id}/history`),
  kbCreate: (b: { section: string; slug: string; title: string; body: string; tags?: string[] }) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', '/api/kb/page', b),
  kbPatch: (id: string, b: { title?: string; body?: string; tags?: string[]; summary?: string }) => call<{ ok: boolean; page?: KbPage; error?: string }>('PATCH', `/api/kb/page/${id}`, b),
  kbRevert: (id: string, rev: number) => call<{ ok: boolean; page?: KbPage; error?: string }>('POST', `/api/kb/page/${id}/revert`, { rev }),
  kbDelete: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/kb/page/${id}`),
  dreaming: () => call<{ everyHours: number; lastDreamedAt?: number; applyLearnings?: boolean; guidance?: string; recommendations?: Recommendation[]; error?: string }>('GET', '/api/dreaming'),
  applyRecommendation: (id: string) => call<{ ok: boolean; applied?: unknown; error?: string }>('POST', `/api/dreaming/recommendation/${id}/apply`),
  dismissRecommendation: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/dreaming/recommendation/${id}/dismiss`),
  setDreaming: (everyHours: number) => call<{ ok: boolean; everyHours: number; error?: string }>('PUT', '/api/dreaming', { everyHours }),
  setApplyLearnings: (applyLearnings: boolean) => call<{ ok: boolean; applyLearnings: boolean; error?: string }>('PUT', '/api/dreaming', { applyLearnings }),
  dreamingRun: () => call<{ ok: boolean; skipped?: boolean; sessions?: number; episodes?: number; kbPageId?: string; insightId?: string; guidance?: string; error?: string }>('POST', '/api/dreaming/run'),

  createAgent: (input: { id: string; description: string; claudeMd: string; examplePrompts?: string[] } & RuntimeTuning) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/agents', input),
  deleteAgent: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/agents/${encodeURIComponent(id)}`),
  agentClaude: (id: string) => call<{ agent: string; runtime: string; exists: boolean; content: string; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/claude`),
  saveAgentClaude: (id: string, content: string) => call<{ ok: boolean; error?: string }>('PUT', `/api/agents/${encodeURIComponent(id)}/claude`, { content }),
  agentConfig: (id: string) => call<{ agent: string; error?: string; examplePrompts?: string[] } & RuntimeTuning>('GET', `/api/agents/${encodeURIComponent(id)}/config`),
  saveAgentConfig: (id: string, patch: RuntimeTuning & { examplePrompts?: string[] }) => call<{ ok: boolean; error?: string; examplePrompts?: string[] } & RuntimeTuning>('PUT', `/api/agents/${encodeURIComponent(id)}/config`, patch),
  runtimeDefaults: () => call<RuntimeTuning & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/runtime-defaults'),
  saveRuntimeDefaults: (tuning: RuntimeTuning) => call<{ ok: boolean; error?: string } & RuntimeTuning>('PUT', '/api/settings/runtime-defaults', tuning),

  governance: () => call<GovernanceThresholds & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/governance'),
  saveGovernance: (t: GovernanceThresholds) => call<{ ok: boolean; error?: string } & GovernanceThresholds>('PUT', '/api/settings/governance', t),
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
  saveIntegrations: (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string }) => call<IntegrationsResp & { ok: boolean }>('PUT', '/api/settings/integrations', body),
  slackStatus: () => call<SlackStatus>('GET', '/api/settings/slack/status'),
  discordStatus: () => call<DiscordStatus>('GET', '/api/settings/discord/status'),

  skills: () => call<SkillsResp>('GET', '/api/skills'),
  skill: (name: string) => call<SkillDetail & { error?: string }>('GET', '/api/skills/' + encodeURIComponent(name)),
  createSkill: (input: { name: string; description?: string; content?: string }) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('POST', '/api/skills', input),
  saveSkill: (name: string, content: string) =>
    call<{ ok: boolean; skill?: SkillDetail; error?: string }>('PUT', '/api/skills/' + encodeURIComponent(name), { content }),
  deleteSkill: (name: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/skills/' + encodeURIComponent(name)),

  policy: () => call<PolicyResp>('GET', '/api/policy'),
  savePolicy: (document: PolicyDocument) => call<{ ok: boolean; document?: PolicyDocument; error?: string }>('PUT', '/api/policy', { document }),

  files: {
    list: (path = '') => call<DirListing>('GET', `/api/files/list?path=${encodeURIComponent(path)}`),
    read: (path: string) => call<FileContent>('GET', `/api/files/read?path=${encodeURIComponent(path)}`),
    write: (path: string, content: string) => call<{ ok: boolean; error?: string }>('PUT', '/api/files/write', { path, content }),
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
