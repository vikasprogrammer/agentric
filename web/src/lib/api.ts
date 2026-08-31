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
/** A member-defined canned prompt fired into a live session from the Quick Shortcuts strip. */
export interface PromptShortcut {
  id: string
  label: string
  prompt: string
}
export type IdentityProvider = 'slack' | 'discord' | 'telegram' | 'email' | 'github'
export const IDENTITY_PROVIDERS: IdentityProvider[] = ['slack', 'discord', 'telegram', 'email', 'github']
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
  /** Private-to-owners: only the owner role runs/sees this agent (admins excluded). Owner-settable only. */
  ownerOnly?: boolean
}
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** `claude --permission-mode` choices. Interactive lane only; the gate hook governs regardless. */
export type PermissionMode = 'auto' | 'plan' | 'acceptEdits' | 'manual' | 'dontAsk' | 'bypassPermissions'
export const PERMISSION_MODES: PermissionMode[] = ['auto', 'plan', 'acceptEdits', 'manual', 'dontAsk', 'bypassPermissions']
/** Per-agent / workspace runtime tuning for claude-code sessions. Each field optional → inherit
 *  (permissionMode's floor is `auto`, outputStyle's is `Default`). */
export interface RuntimeTuning {
  model?: string
  effort?: Effort
  permissionMode?: PermissionMode
  /** Claude Code output style — a built-in name or a workspace library style. Sets the system prompt's
   *  role/tone/response shape. claude-code only. */
  outputStyle?: string
}
/** Wire form of a PARTIAL tuning edit (the agent-config route): an omitted key keeps the agent's current
 *  value, `''` clears the knob to inherit. Distinct from RuntimeTuning, whose `undefined` already means
 *  "inherit" — `JSON.stringify` drops undefined, so it can't express "clear this" over the wire. */
export type RuntimeTuningPatch = {
  model?: string
  effort?: Effort | ''
  permissionMode?: PermissionMode | ''
  outputStyle?: string
}

/** A Claude Code output style: a built-in, or a custom one in the workspace library. */
export interface OutputStyleInfo {
  name: string
  description: string
  /** Set on custom styles. FALSE means the style REPLACES Claude Code's software-engineering
   *  instructions (the frontmatter default) — worth showing, because the CLI never says so. */
  keepCodingInstructions?: boolean
  bytes?: number
  updatedAt?: number
  /** Why this style won't take effect on this box (e.g. the CLI is too old). */
  warning?: string
}
export interface OutputStylesResp {
  builtin: OutputStyleInfo[]
  custom: OutputStyleInfo[]
  /** False when there is no data home, so custom styles can't be stored. */
  enabled: boolean
  error?: string
}
export interface OutputStyleDetail extends OutputStyleInfo {
  content: string
  error?: string
}

/** Which output styles the fleet is running — counts only. Two ancestors of this reported COST
 *  (`VerbositySavings`, retired v0.389.0, and the terse adoption panel): `output_tokens` is ~85%
 *  tool-call arguments, so neither ever measured the narration a style acts on. Whether a style works
 *  is answered by `npm run bench:output-style`, never by a query over live traffic. */
export interface OutputStyleAdoption {
  windowDays: number
  sessions: { byStyle: Array<{ style: string; count: number }>; unstamped: number }
  byAgent: Array<{ agent: string; styles: Array<{ style: string; count: number }> }>
  error?: string
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
  /** Hard runtime ceiling (hours) for a headless/unattended run — the stuck-mid-turn backstop (0 = off; default 24). */
  unattendedMaxHours: number
  /** Reap a headless run that never made a tool call after this many minutes — never-started net (0 = off; default 30). */
  unattendedNoProgressMinutes: number
  /** Close an interactive session waiting this many hours on an unanswered question/approval (0 = off; default 72). */
  blockedMaxHours: number
  /** Expire a take-over claim untouched for this many hours, so a claimed session stops being immortal (0 = off; default 72). */
  claimedMaxHours: number
}

/** One credential set in the runtime rotation pool (never carries the api-key value, only its vault ref). */
export type RuntimeAccountKind = 'oauth' | 'apikey' | 'token'
export interface RuntimeUsageWindow { usedPct?: number; resetsAt?: number }
export interface RuntimeUsage { weekly?: RuntimeUsageWindow; session?: RuntimeUsageWindow }
export interface RuntimeAccount {
  runtime: string
  name: string
  kind: RuntimeAccountKind
  configDir?: string
  apiKeyRef?: string
  enabled: boolean
  status: 'available' | 'limited'
  limitedUntil?: number
  lastUsedAt?: number
  createdAt: number
  lastCheckedAt?: number
  checkOk?: boolean
  checkNote?: string
  usage?: RuntimeUsage
}
export interface RuntimeSpecInfo {
  id: string
  label: string
  credentialEnv: { configDirVar: string; apiKeyVar: string; tokenVar?: string; configDirFile: string }
  /** Kinds this runtime can actually be LAUNCHED with — the others are refused on add and never selected
   *  (claude ignores an injected CLAUDE_CODE_OAUTH_TOKEN outside print mode, so it's credential-dir only). */
  liveCredentialKinds: RuntimeAccountKind[]
  /** Can the console produce a credential dir itself by driving the runtime's own sign-in on this box? */
  guidedLogin?: boolean
}

/** A guided sign-in in flight: the console starts it, shows `url` for the human to authorize, takes the
 *  code back, and the runtime's own CLI writes the credential dir. */
export type LoginPhase = 'starting' | 'awaiting-code' | 'exchanging' | 'done' | 'failed'
export interface RuntimeLogin {
  id: string; runtime: string; name: string; phase: LoginPhase; url?: string; error?: string
  /** A recoverable hiccup while the flow CONTINUES — a rejected code, with a fresh link on the way.
   *  Distinct from `error`, which ends the login. */
  notice?: string
  /** Codes rejected so far in this login. */
  codeAttempts?: number
  startedAt: number
}
/** `refreshing` = `<runtime>/<name>` for each account whose usage snapshot is being re-probed in the
 *  background right now (the read kicked it — see src/edge/runtime-account-usage.ts). The `accounts` in
 *  THIS response are the pre-probe reading, so a non-empty list means "read again shortly for fresh %". */
/** A runtime as the agent picker sees it: what it supports, and whether this box actually HAS its
 *  CLI — `installed:false` means every session on it would park, so the picker offers to install. */
export interface RuntimePickerInfo {
  id: string
  label: string
  suggestedModels: string[]
  capabilities: Record<string, boolean>
  bin: string
  /** Display form of the install command, e.g. `npm install -g opencode-ai`. */
  install: string
  installed: boolean
  version?: string
}
/** Presence of every coding runtime on this box (Settings → Runtimes). */
export interface RuntimePresence { id: string; label: string; bin: string; installed: boolean; version?: string; install: string }

export interface RuntimeAccountsResp { accounts: RuntimeAccount[]; runtimes: RuntimeSpecInfo[]; logins?: RuntimeLogin[]; refreshing?: string[]; error?: string }

export interface AgentInfo {
  id: string
  description: string
  /** Organisational grouping label (e.g. "Engineering", "Marketing"); undefined = uncategorised. */
  category?: string
  runtime: 'mock' | 'claude-code'
  /** True when the agent lives under the data home (user-created) and can be deleted. */
  deletable?: boolean
  /** True for an agent Agentric ships and provisions itself (a department generalist, the
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
/** Box pressure behind the whole tenant — see src/edge/host-metrics.ts. `cpu` is null on the first sample. */
export interface HostMetrics {
  cpu: number | null
  /** In-use percent, where "in use" = total minus the kernel's AVAILABLE (not `freemem`). */
  mem: number
  availableMemMb: number
  load: number
  cores: number
  totalMemMb: number
}

/** One route's cost since collection started. `maxStallMs` is loop lag, NOT the route's own time. */
export interface RouteStat {
  route: string
  count: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  maxStallMs: number
  errors: number
}

/** The same timing, keyed by the agent-facing MCP tool that made the call (`x-aos-tool`). */
export interface ToolStat extends RouteStat {
  /** The tool waits on a human or a delegate by design (`ask_human`, `task_wait`) — its clock is not code. */
  blocking: boolean
}

/** Per-endpoint timings + independent event-loop lag — see src/edge/request-metrics.ts. */
export interface RequestMetricsSnapshot {
  since: number
  requests: number
  routes: RouteStat[]
  /** Per-MCP-tool timings; empty until an agent session has called one since the last restart. */
  tools?: ToolStat[]
  loop: { samples: number; maxMs: number; p95Ms: number; overOneSecond: number }
  error?: string
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
  /** Workspace-wide sessions-list money column preference: dollar cost, token total, or both. */
  sessionMetrics?: SessionMetrics
}
/** What the sessions list shows in its money column — a workspace-wide viewing preference. */
export type SessionMetrics = 'cost' | 'tokens' | 'both'
/** How the box behaves when it notices it has fallen behind origin.
 *  `off` — say nothing. `notify` — Inbox card + DM to the owner (the drift alarm; applies nothing).
 *  `ask` — additionally raise an OWNER approval whose approval applies the update on the box. */
export type UpdateWatchMode = 'off' | 'notify' | 'ask'
export interface UpdateWatchConfig { mode: UpdateWatchMode; everyHours: number }

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
  /** The tracked files behind `dirty`, so the UI can name what is in the way. */
  dirtyFiles?: string[]
  /** The upstream commit an update would land on — the watcher's dedupe key. */
  head?: string
  /** The self-update watcher's config on this box (see UpdateWatchConfig). */
  watch?: UpdateWatchConfig
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
/** One native command Agentric shells out to (GET /api/deps). */
export interface DepStatus {
  bin: string
  label: string
  purpose: string
  required: boolean
  /** Package name for the box's package manager; absent when installed another way (e.g. claude via npm). */
  pkg?: string
  /** Manual install hint, when there's no `pkg` or no package manager on the box. */
  hint?: string
  installed: boolean
  path?: string
  version?: string
  /** Resolved only via a fallback location — not on the server's PATH (sessions still launch). */
  offPath?: boolean
  /** npm package this dep ships from; present ⇒ it can be version-checked and updated in place. */
  npmPkg?: string
  /** Latest published version, when the registry answered. */
  latest?: string
  /** True when the installed version is behind `latest`. */
  updateAvailable?: boolean
  /** Why freshness couldn't be determined (offline box, registry error) — never fatal. */
  updateError?: string
}
/** Native-dependency report for Settings → System (GET /api/deps). */
export interface DepsReport {
  deps: DepStatus[]
  /** The runtime-CLI watcher's config on this box (see UpdateWatchConfig). */
  watch?: UpdateWatchConfig
  /** The `claude` version this box's gate-hook tool routing was last signed off against — stamped by an
   *  owner approving a runtime upgrade, or upgrading by hand. '' when nobody has yet. */
  gateReviewedVersion?: string
  /** True when every required dep is present — sessions can run. */
  ok: boolean
  /** Missing deps a package manager could install (drives the "Install now" button). */
  installable: string[]
  /** Resolved package manager, or null when the box has none (→ manual hints only). */
  manager: 'brew' | 'apt-get' | 'dnf' | 'yum' | 'pacman' | 'zypper' | null
  /** One-line command that installs the missing installable deps, or null when nothing's missing. */
  installCommand: string | null
  /** Zero-dependency bootstrap shortcut (works before a build). */
  shortcut: string
  platform: string
  /** Installed-but-stale npm deps (drives the per-row "Update" button). */
  outdated: string[]
  /** When the freshness probe last ran, or 0 if it hasn't. */
  updatesCheckedAt: number
}
/** Result of POST /api/deps/install — per-step logs plus the re-checked report. */
export interface DepsInstallResult {
  ok: boolean
  steps: { cmd: string; ok: boolean; out: string }[]
  report: DepsReport
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
  /** True when a TURN is in flight. A warm chat session keeps its pane between turns, so `alive` no
   *  longer implies "working" — this does. Cleared by the runtime's turn-end beacon. */
  working?: boolean
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
  sourceKind?: 'manual' | 'cron' | 'webhook' | 'slack' | 'discord' | 'telegram' | 'composio' | 'scheduled' | 'task' | 'chat' | 'system'
  /** True for a `category:'System'` machinery agent (the Cockpit concierge/operator, consolidator, …).
   *  Hidden from the Chat + Sessions lists to reduce clutter; still openable by id + in Audit. */
  system?: boolean
  /** CONVERSATION key — the claude transcript this run belongs to (its own id when there is none). A
   *  poke-back RESUMES a transcript, so several rows share one `threadId`; the list groups by it so a
   *  resumed conversation reads as ONE entry with N runs instead of N unrelated ones. */
  threadId?: string
  /** The `threadId` of the caller that delegated this run — the edge that turns the flat list into the
   *  hand-off tree. Equal to `threadId` for a poke (a caller waking itself) = treat as no parent. */
  parentThreadId?: string
  /** The task this run works (`task:`/`poke:`/`ask:` provenance) — the hand-off it belongs to. */
  taskId?: string
  /** True when the run launched unattended (an automation/cron/task run). These now run as an attachable
   *  interactive TUI a human can take over live; the list badges them as unattended vs. a member session. */
  headless?: boolean
  /** The member id who "took over" (claimed) this unattended run — set means it's sticky (won't be
   *  auto-closed at turn-end) and the Take-over affordance is hidden. Undefined = unclaimed. */
  claimedBy?: string
  /** True when a LIVE run is blocked on a human right now — a pending `ask` question or approval gate.
   *  Server-authoritative (the console no longer re-derives "waiting on you" from the message feed).
   *  Drives the "Blocked" list filter, the per-session waiting bell, and the Overview blocked count. */
  blocked?: boolean
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
  /** What the run cost in USD, from its transcript's token usage × model rates. Undefined while the run
   *  is still live or before it's been computed. */
  costUsd?: number
  /** Token breakdown behind `costUsd` (uncached input / output / cache-read / cache-write). */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** What the AGENT said happened, from its end-of-session `report` — 'success' | 'failure' | 'partial'
   *  | 'unknown' | … Orthogonal to `status`, which only says how the process ended: a `done` run can
   *  carry a `failure` outcome, and `unknown` on a finished run means nobody closed the loop. */
  outcome?: string
  /** The report's one-line summary — the "what came of it" behind `outcome`. */
  summary?: string
  /** ENGAGED milliseconds from the transcript, idle gaps excluded. The honest run duration — wall-clock
   *  (`updatedAt - createdAt`) isn't, since an interactive session idles between turns for hours. */
  activeMs?: number
  /** Real user prompts in the conversation (1 for a one-shot headless run, many for a steered one). */
  turns?: number
  /** Tool calls the agent issued — the true activity volume (`insights.actions` counts only the subset
   *  of effects the gate mediates, which is 0 for a run that never touched a governed capability). */
  toolCalls?: number
  /** Governance fingerprint: governed effects, human gates hit, denials, errors. Live rows carry the
   *  running tally; terminal rows the final stamped one. */
  insights?: { actions: number; approvals: number; denied: number; errors: number }
  /** Runtime tuning the run launched with — model id + reasoning effort (`session.tuning`). Undefined
   *  for whichever lane took the workspace default. Shown next to cost now that both are per-task
   *  overridable. */
  model?: string
  effort?: string
  /** Total ms the run sat BLOCKED on a human — approval gates + `ask` questions. The governed-OS
   *  latency nothing else surfaces; large next to a small `activeMs` = a run that mostly waited on
   *  people. Undefined until stamped; 0 when it never blocked. */
  blockedMs?: number
  /** Deliverables the run published to the Library (`artifacts` rows). Undefined until stamped. */
  artifacts?: number
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
  category: 'action' | 'operator' | 'memory' | 'knowledge' | 'tasks' | 'scheduling' | 'agents' | 'approval' | 'secrets' | 'skills' | 'policy' | 'other'
  /** OS tool name (remember/ask/task_create…) or, for a governed effect, the capability id. */
  primitive: string
  summary: string
  /** For governed actions/approvals: how the gate classified it, or the outcome. */
  effect?: 'allow' | 'approve' | 'deny' | 'error'
  /** The live object this entry opened, if any (a task, KB page, secret, proposal card). */
  target?: { kind: string; id: string }
  /** The object's CURRENT status, resolved from its live store — 'doing', 'done', 'pending', 'rev 4'… */
  status?: string
  /** How to tint the status chip. */
  statusTone?: 'open' | 'done' | 'blocked' | 'denied' | 'muted'
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
  /** Shared with the whole tenant — every member sees it in the Library. */
  sharedTeam?: boolean
  /** Whether a public login-free link exists (safe boolean, surfaced to every viewer). */
  public?: boolean
  /** The public share token — only returned to whoever may manage sharing (owner/admin/producer). */
  shareToken?: string
  /** Epoch ms when the public link auto-revokes (7 days after minting); present with `shareToken`. */
  shareExpiresAt?: number
  /** The resolved public URL (`/shared/<token>`) — present only when `shareToken` is. */
  shareUrl?: string
  createdAt: number
  /** Epoch ms when soft-archived (only present in the `?archived=1` view). */
  archivedAt?: number
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
export interface AgentScore { agent: string; runs: number; success: number; failed: number; stopped: number; crashed: number; chats: number; crashedRecent: number; runsSinceCrash: number; rate: number | null; focus: string[]; diagnosis?: { at: number; slug: string } }
export interface RejectedCapability { capability: string; count: number }
export interface FrictionMap { rejections: RejectedCapability[]; pendingApprovals: number; oldestPendingAgeMs: number | null }
export interface Insights { windowDays: number; agents: AgentScore[]; friction: FrictionMap }
export type ImprovementDomain = 'agents' | 'kb' | 'goals' | 'skills' | 'memory' | 'automations' | 'tasks' | 'library' | 'sessions' | 'idle-agents'
export interface ImprovementTile { domain: ImprovementDomain; count: number; title: string; detail: string; actionLabel: string; href: string }
export interface CleanupPruneItem { id: string; agent: string; snippet: string; ageDays: number; importance: number | null }
export interface CleanupMergeGroup { agent: string; keepSnippet: string; drop: number }
export interface MemoryCleanupPlan { opts: { pruneAfterDays: number; keepImportance: number; dedupeThreshold?: number }; prune: { total: number; sample: CleanupPruneItem[] }; merge: { groups: number; drops: number; sample: CleanupMergeGroup[] } }
export interface KbTidyItem { id: string; section: string; slug: string; title: string; ageDays: number; lastReadDays: number | null }
export interface KbTidyPlan { deadAfterDays: number; staleAfterDays: number; dead: { total: number; sample: KbTidyItem[] }; stale: { total: number; sample: KbTidyItem[] } }
export interface TaskDriftItem { id: string; title: string; assignee: string | null; owner: string | null; sessionId: string; sessionStatus: string; outcome: string; endedDaysAgo: number }
export interface TaskReconcilePlan { finished: { total: number; sample: TaskDriftItem[] }; stalled: { total: number; sample: TaskDriftItem[] } }
export interface LibraryTidyItem { id: string; title: string; kind: string; agent: string; ageDays: number; bytes: number }
export interface LibraryTidyPlan { deadAfterDays: number; staleAfterDays: number; dead: { total: number; bytes: number; sample: LibraryTidyItem[] }; stale: { total: number; sample: LibraryTidyItem[] } }
export interface SessionTidyItem { id: string; title: string; agent: string; status: string; outcome: string | null; ageDays: number }
export interface SessionTidyPlan { deadAfterDays: number; dead: { total: number; sample: SessionTidyItem[] }; stale: { total: number; sample: SessionTidyItem[] } }
export interface StuckGoal { id: string; title: string; days: number }
export interface TroubledAutomation { id: string; name: string; type: string; reason: 'errored' | 'idle'; detail: string }
export interface MeasureTrendBucket { start: number; label: string; total: number; success: number; rate: number | null; unknownShare: number | null }
/** A raised card and what happened next — counts of the signal, not rates (see src/edge/measurement.ts). */
export interface CardEffect { key: string; title: string; postedAt: number; actedAt: number | null; action: string | null; before: number; after: number; afterDays: number; verdict: 'resolved' | 'ongoing' | 'no-action' | 'too-early' }
export interface Measurement {
  trend: MeasureTrendBucket[]
  cards: CardEffect[]
  recent: { n: number; rate: number | null; unknownShare: number | null }
  prior: { n: number; rate: number | null; unknownShare: number | null }
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
  blocked: number
  hidden: number
  needs: { agent: string; title: string }[]
  incidents: { label: string; headline: string; outcome: string; agent: string; agents: string[]; updates: number }[]
  byAgent: { agent: string; lines: { title: string; outcome: string; importance: number; count?: number }[]; more: number }[]
  signals: { tasksCreated: number; tasksCompleted: number; approvals: number; rejected: number; errors: number; budgetStops: number; costUsd: number }
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

/** What a PROPOSING agent's maturity earns it on the cross-agent edit path (`agent_propose_update`) —
 *  mirror of src/types.ts AgentProposalTrust. Below `minMaturity` the proposal is refused; in between an
 *  owner reviews it; at/above `autoApplyAt` (when `autoApply`) it applies with no human in the loop. */
export interface AgentProposalTrust {
  minMaturity: number
  autoApplyAt: number
  autoApply: boolean
}

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
/** What a blocked task waits on, declared by the delegate that blocked it. `human` also routes the
 *  wake-up to the owner alone instead of resuming the agent that handed the work over. */
export type TaskBlockedOn = 'human' | 'agent' | 'external'
export interface Task {
  id: string
  tenant: string
  title: string
  body: string
  status: TaskStatus
  blockedOn?: TaskBlockedOn
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
/** A task SPAWNED by another (the `parentId` hand-off edge), as the detail route returns it — the
 *  server resolves these so a wide fan-out isn't under-counted by the board's bounded page. */
export interface TaskChild {
  id: string
  title: string
  status: TaskStatus
  assignee?: string
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
/** A pull request a task references. PARSED out of the task's body / activity log / Discussion (agents
 *  already paste the URL when they ship), then enriched with GitHub's open/merged/closed status — see
 *  src/edge/task-prs.ts. `state` absent = never fetched (no GitHub configured, or `error` says why). */
export interface TaskPr {
  owner: string
  repo: string
  number: number
  url: string
  source: 'body' | 'activity' | 'discussion'
  firstSeenAt: number
  state?: 'open' | 'closed' | 'merged'
  draft?: boolean
  title?: string
  author?: string
  mergedAt?: number
  updatedAt?: number
  fetchedAt?: number
  error?: string
}
/** Is a task still a DRAFT — filed but never acted on (no dispatch attempt, no session ever linked)?
 *  Mirrors `isDraftTask` in src/types.ts, which is what the server enforces; this copy only decides what
 *  the console OFFERS. A draft is its author's to edit or delete without an admin; the moment a session
 *  touches it, it stops being one — permanently. */
export function isDraftTask(task: { attempts: number; lastSessionId?: string }, runCount: number): boolean {
  return task.attempts === 0 && !task.lastSessionId && runCount === 0
}
export interface TaskPrSummary { total: number; merged: number; open: number; closed: number; draft: number }
/** One session that worked a task — a task's run history is one-to-many (retries, crashes, take-overs),
 *  where `Task.lastSessionId` only ever pointed at the newest. See TerminalManager.taskRuns. */
export interface TaskRun {
  id: string
  agent: string
  status: string
  outcome?: string
  summary?: string
  createdAt: number
  endedAt?: number
  costUsd?: number
  turns?: number
  link: 'dispatch' | 'linked'
  current: boolean
  alive: boolean
  archived: boolean
}
/** Which agents have actually WORKED a task — the card's rollup of its runs. Only sent for tasks worked
 *  by more than one agent (with one, the assignee badge already says it). See TerminalManager.taskWorkers. */
export interface TaskWorkers {
  agents: { id: string; runs: number; alive: boolean }[]
}
/** What happened to a plain discussion message beyond being stored — whether it REACHED the run working
 *  the task. `choose` = more than one live run, so nothing was delivered until the human picks one. */
export interface TaskDiscussionDelivery {
  status: 'none' | 'delivered' | 'answered' | 'choose' | 'stale' | 'undeliverable'
  sessionId?: string
  agent?: string
  runs?: { sessionId: string; agent: string; blocked: boolean }[]
}
/** One entry in a task's Discussion timeline (chat message or state event) — see docs/task-rooms-plan.md. */
export type TaskTimelineEntry =
  | { kind: 'chat'; id: string; author: string; agentId?: string; body: string; mentions: string[]; at: number }
  | { kind: 'event'; id: string; eventKind: TaskEvent['kind']; body?: string; author: string; at: number }
/** Per-task Discussion rollup for the board/list cards (unread, last message, participants). */
export interface TaskDiscussionSummary {
  unread: number
  last?: { body: string; author: string; agentId?: string }
  participants: string[]
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
  /** `ready` = all linked work finished. `task` = a milestone on a task under this goal, derived server-side
   *  from the task's own events (see GoalStore.timeline) — the work IS most of a goal's activity. */
  kind: 'status' | 'comment' | 'edit' | 'link' | 'ready' | 'task'
  body?: string
  author: string
  createdAt: number
  task?: GoalEventTask
}
/** Which linked task moved, and how — set only on a `kind: 'task'` timeline entry. */
export interface GoalEventTask {
  id: string
  title: string
  status: TaskStatus
  verb: 'filed' | 'started' | 'blocked' | 'done' | 'cancelled' | 'reopened'
  sessionId?: string
}
/** Why a task can't be dispatched right now — mirrors `TaskDispatchBlock` in src/types.ts. */
export type TaskDispatchBlock =
  | 'missing' | 'closed' | 'blocked' | 'unassigned' | 'unknown-agent' | 'live' | 'pool' | 'attempts' | 'deps'
/** Per-task run state for the goal room's task list: can I run it, why not, and is a run live now. */
export interface TaskRunState {
  can: boolean
  reason?: string
  code?: TaskDispatchBlock
  attempts: number
  live?: { sessionId: string; agent: string; since: number }
}
/** The goal room's warm chat conversation with the strategist (null until the first message). */
export interface GoalChatState {
  sessionId: string
  agent: string
  alive: boolean
  working: boolean
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

/** A human-legible account of a gated effect, computed server-side (src/governance/briefer.ts) and
 *  carried inside an approval card's `args` as `args.brief`. Mirrors `DecisionBrief` in src/types.ts. */
export interface Brief {
  headline: string
  verb: string
  target: { kind: string; label: string; host?: string; outsideWorkdir?: boolean; count?: number; amountUsd?: number }
  rationale: string
  riskClass: 'green' | 'yellow' | 'red' | 'deny'
  suggestedAction: 'allow' | 'approve' | 'trust-host' | 'deny'
  signature: string
}

/** An "always approve THIS action" rule — the durable, legible registry (Settings → Auto-approvals). */
export interface AutoApproval {
  id: string
  signature: string
  capability: string
  label: string
  example: string
  addedBy: string
  addedAt: number
  hits: number
  lastHitAt?: number
}

export interface Msg {
  id: string
  type: 'task' | 'update' | 'approval' | 'question' | 'completed' | 'artifact' | 'notification' | 'skill.proposed' | 'goal.proposed' | 'goal.ready' | 'goal.update.proposed' | 'skill.request' | 'secret.request' | 'host.proposed' | 'policy.proposal' | 'app.proposed' | 'automation.proposed' | 'agent.update.proposed'
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
  type: 'cron' | 'once' | 'webhook' | 'composio' | 'slack' | 'discord' | 'telegram' | 'clickup'
  mode: ExecMode
  schedule?: string
  /** composio: trigger slug. slack: event type (app_mention/message) or channel id, optionally
   *  followed by `when`/`unless` clauses over the message (`C0ABUSE1 when text ~ "abuse report"`);
   *  a channel-scoped filter also watches that channel for non-mention messages. webhook: a
   *  comma-separated event list (`convo.created, convo.note.*`). '' = any. */
  filter?: string
  /** webhook: dot path to the source's conversation id in the payload — follow-ups on the same
   *  conversation continue the run already handling it. '' / absent = a run per accepted event. */
  threadPath?: string
  /** webhook: whether a body-signing secret is configured. The secret ITSELF is never sent to the
   *  client — this is the only thing the console can know about it. */
  signed?: boolean
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
  /** Member id the fired session acts as — binds THAT member's connectors/Composio (e.g. personal
   *  ClickUp) instead of the company fallback. Empty/absent = company identity. */
  runAs?: string
}
/** An agent-proposed automation awaiting owner/admin approval — the spec lives in the review card until
 *  approved (then it's created via Automations.add). Mirrors PolicyProposal. */
export interface AutomationProposal {
  id: string
  agent: string
  spec: { agentId: string; name: string; type: Automation['type']; schedule?: string; filter?: string; task: string; mode?: ExecMode; runAs?: string }
  rationale?: string
  preview?: string
  createdAt: number
}
/** An agent-proposed edit to ANOTHER agent's listing / CLAUDE.md, awaiting owner sign-off. `fields` holds
 *  only the changed keys (the delta); `claudeMd`, when present, is the full replacement system prompt. */
export interface AgentUpdateProposal {
  id: string
  agent: string          // the proposing agent
  target: string         // the agent to be edited
  fields: { description?: string; claudeMd?: string; category?: string; model?: string; effort?: string; icon?: string; examplePrompts?: string[] }
  rationale?: string
  preview?: string
  createdAt: number
}
export interface GoalUpdateProposal {
  id: string
  agent: string          // the proposing agent
  goalId: string         // the goal to be edited
  fields: { status?: GoalStatus; title?: string; body?: string; target?: string | null; labels?: string[]; dueAt?: number | null }
  note?: string
  rationale?: string
  preview?: string
  createdAt: number
}
export interface AddAutomationReq {
  agentId: string
  name: string
  type: 'cron' | 'webhook' | 'composio' | 'slack' | 'discord' | 'telegram' | 'clickup'
  mode: ExecMode
  schedule?: string
  filter?: string
  /** webhook only — see Automation.threadPath / the write-only signing secret. */
  threadPath?: string
  signingSecret?: string | null
  task: string
  runAs?: string
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
  /** An agent-proposed EDIT awaiting review. The live skill is unchanged until it's applied. */
  pending?: { agent?: string; session?: string; rationale?: string; at: number; bytes: number }
}
export interface SkillDetail extends SkillSummary {
  content: string
  /** The proposed replacement text of a pending edit (present only when `pending` is). */
  pendingContent?: string
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

/** An agent's `secret_request` awaiting a human. `mode`: 'provide' (enter a new value), 'access' (grant
 *  the agent an existing vault key — no value typed) or 'rotate' (the agent holds the key but the value
 *  is being rejected — enter a replacement, which overwrites every `locations` principal). No secret
 *  value is ever in play here. */
export interface SecretRequest { id: string; key: string; agent: string; mode: 'provide' | 'access' | 'rotate'; locations?: string[]; reasoning?: string; createdAt: number }
export interface SecretRequestsResp { requests: SecretRequest[]; error?: string }

/** An agent's `connection_request` awaiting a human. `scope` 'personal' (the run's own member completes
 *  the OAuth for their own account) or 'company' (an owner/admin connects a shared app). `member` is the
 *  personal-scope owner's member id. No credential is ever in play — a human finishes the browser OAuth. */
export interface ConnectionRequest { id: string; toolkit: string; scope: 'personal' | 'company'; member: string; agent: string; reasoning?: string; createdAt: number }
export interface ConnectionRequestsResp { requests: ConnectionRequest[]; error?: string }

export interface CompanySettings {
  companyMd: string
  updatedAt?: number
  updatedBy?: string
  reviewMd: string
  reviewUpdatedAt?: number
  reviewUpdatedBy?: string
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

// ── install wizard ───────────────────────────────────────────────────────────────
export type SetupStepId = 'claude' | 'company' | 'composio' | 'chat' | 'github' | 'memory' | 'team' | 'agents'
export interface SetupStep {
  id: SetupStepId
  title: string
  why: string
  /** Required steps gate "setup complete" and drive the console banner. */
  required: boolean
  /** `unknown` = there is evidence of a credential but the launch path can't be proven from here. */
  status: 'done' | 'todo' | 'unknown'
  /** Evidence behind the status ("2 accounts in the rotation pool") — never a secret. */
  detail: string
  skipped: boolean
}
export interface SetupStatus {
  steps: SetupStep[]
  done: number
  total: number
  /** Required steps neither done nor skipped. */
  blocking: number
  complete: boolean
  dismissedAt: number | null
  /** Whether this box can drive a runtime sign-in from the console. */
  guidedLogin: boolean
  guidedLoginWhy?: string
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
  /** Native Telegram (long poll) — whether the bot token is set; never the token. */
  telegram: { botToken: boolean; configured: boolean }
  /** Native ClickUp (webhook) — token/secret set flags + the hook path (with key) to paste into a
   *  ClickUp Automation. `hookPath` is admin-only (it carries the inbound secret); '' until configured. */
  clickup: { token: boolean; hint: string; webhookSecret: boolean; configured: boolean; hookPath: string }
  /** Per-member GitHub App OAuth — whether the client id / secret are set (never the secret itself),
   *  plus the created App's slug + the install-on-repos link (empty until an App is created). */
  github: { clientId: boolean; clientSecret: boolean; configured: boolean; slug: string; installUrl: string; appId: boolean; privateKey: boolean; botReady: boolean }
  /** Image generation backend — which keys are set (never the keys), the active backend, default model. */
  image: { openRouter: boolean; atlas: boolean; backend: 'openrouter' | 'atlas' | null; defaultModel: string; configured: boolean }
  /** Video generation backend — which keys are set (never the keys), the active backend, default model. */
  video: { fal: boolean; atlas: boolean; backend: 'fal' | 'atlas' | null; defaultModel: string; configured: boolean }
  /** First-party Anthropic key for the Cockpit `ask` tier + router tie-break (direct /v1/messages, no
   *  session). `set` = a key is available; `source` = where (Settings vs `ANTHROPIC_API_KEY` env); the
   *  key itself is never returned. `model` = which Claude model the direct path uses (default Haiku). */
  anthropic: { set: boolean; source: 'settings' | 'env' | null; model: string }
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

/** Live Telegram long-poll status — SlackStatus + the bot's @username. */
export interface TelegramStatus extends SlackStatus {
  username: string
}

export interface ComposioConnection {
  id: string
  toolkit: string
  status: string
  createdAt: string
  userId: string
  /** Distinguishing label for this connection (user alias, else Composio's auto handle). */
  name: string
  /** Mine only: the owner marked it available to the whole team (composio_shares). */
  shared?: boolean
}
/** A teammate's connection they marked available to the team — borrowed, not owned. */
export interface SharedConnection {
  id: string
  toolkit: string
  status: string
  name: string
  /** The Composio entity it lives under = the sharing member's email. */
  ownerEmail: string
  ownerMemberId: string
}
export interface ConnectionsResp {
  keySet: boolean
  company: ComposioConnection[]
  mine: ComposioConnection[]
  /** Connections other members shared with the team (empty when nobody has shared). */
  teamShared?: SharedConnection[]
  me?: string
  companyEntity?: string
  error?: string
}

/** Read-only overview of everything wired at the COMPANY level (any member can read; no secrets). */
export interface IntegrationsOverview {
  composio: { keySet: boolean; entity: string; apps: { id: string; toolkit: string; status: string }[] }
  slack: { configured: boolean; connected: boolean; botUserId: string }
  discord: { configured: boolean; connected: boolean; botUserId: string }
  telegram: { configured: boolean; connected: boolean; username: string }
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

/** A viewer-safe Library artifact preview attached to a chat activity (mirrors src/edge/conversation.ts). */
export interface ChatArtifactRef {
  id: string
  title: string
  kind: string
  mime: string
  filename: string
  isImage: boolean
  isVideo: boolean
  /** Bytes URL (`/api/artifacts/<id>/raw`) for an inline <img>/<video>. */
  raw: string
}

/** A viewer-safe KB page preview attached to a chat activity (`kb_write`). Deep-links to #/kb/<section>/<slug>. */
export interface ChatKbRef {
  section: string
  slug: string
  title: string
}

/** A viewer-safe hosted-app preview attached to a chat activity (`app_create`/`app_update`). */
export interface ChatAppRef {
  id: string
  name: string
  icon?: string
  published: boolean
}

/** One entry in the non-technical chat timeline (mirrors src/edge/conversation.ts). */
export type ChatTurn =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'assistant'; text: string; ts: number }
  | { kind: 'activity'; tool: string; label: string; detail?: string; status: 'running' | 'ok' | 'error'; artifactIds?: string[]; artifacts?: ChatArtifactRef[]; kbPages?: ChatKbRef[]; apps?: ChatAppRef[]; ts: number }
export interface ConversationResp {
  agent?: string
  turns: ChatTurn[]
  found: boolean
  error?: string
}

/** One routed-to agent option in a Cockpit preview. */
export interface RouterCard {
  id: string
  description: string
  category?: string
  icon?: string
  /** 0..1 routing confidence (present for the suggested pick / ranked candidates). */
  score?: number
}
export interface RouterPreviewResp {
  /** The classified intent. `work` → route to an agent (see `kind`); `ask` → an inline `answer`;
   *  `action` → open the `surface`. Absent on older responses ⇒ treat as `work`. */
  intent?: 'work' | 'ask' | 'action'
  /** work only: `route` → confident single pick in `suggested`; `disambiguate` → choose from
   *  `candidates`; `none` → nothing matched, `candidates` is the runnable fleet to pick from. */
  kind?: 'route' | 'disambiguate' | 'none'
  method?: 'keyword' | 'embedding' | 'llm'
  suggested?: RouterCard
  candidates: RouterCard[]
  /** ask only: an inline answer that's ready immediately (band 1 = from live state, or a configured
   *  direct LLM). Rendered as-is. */
  answer?: string
  /** ask only: no instant answer was available, so a governed ephemeral concierge run was started —
   *  poll its conversation and render the reply inline. */
  run?: { sessionId: string }
  /** ask only: where the answer came from — `state` (deterministic lookup), `llm` (direct model),
   *  `concierge` (ephemeral claude run via `run`). */
  source?: 'state' | 'llm' | 'concierge'
  /** action only: the primitive surface this request maps to. */
  surface?: 'automations' | 'tasks'
  /** work only: this was classified `ask` but no LLM is configured, so it fell back to routing (show a
   *  "configure an LLM to answer here" hint). */
  askFallback?: boolean
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

/** Result of a conditional feed GET: either fresh `data`, or `notModified` (the server 304'd because
 *  nothing changed since our last ETag). Both carry the ETag to thread into the next call. */
export type FeedResult<T> = { notModified: true; etag: string | null } | { data: T; etag: string | null }
/** Conditional GET for the hot list feeds (sessions/messages) the global console poll re-fetches every
 *  1.5 s. The server already tags every response with an ETag (sendBody) and gzips it; here we take the
 *  extra step of handling the 304 IN THE CLIENT — sending our last ETag explicitly and, on a 304,
 *  resolving as `notModified` so the poll can skip setState. That's the piece browser auto-revalidation
 *  can't give us: without it a 304 still serves the cached body to JS and we'd re-parse + re-render the
 *  full ~1.6 MB list every tick. `cache:'no-store'` keeps the browser cache out of the loop so our
 *  explicit `If-None-Match` is authoritative (gzip still applies on a 200 — accept-encoding is
 *  independent of cache mode). An error tick (401/5xx → `{error}`) falls through as `data` with a null
 *  etag; the caller's array-shape guard drops it and the next poll retries unconditionally. */
async function callFeed<T>(path: string, etag: string | null): Promise<FeedResult<T>> {
  const res = await fetch(path, { cache: 'no-store', headers: etag ? { 'if-none-match': etag } : undefined })
  const next = res.headers.get('etag')
  if (res.status === 304) return { notModified: true, etag: next ?? etag }
  return { data: (await res.json()) as T, etag: next }
}

/** The Phase-2 summary poll payload: the always-on rows (live + the viewer's recent-ended tail) plus a
 *  global done-since-server-midnight count (the one always-on aggregate a live-only set can't derive). */
export interface SessionsSummary { rows: Session[]; doneToday: number }

/** Something in a chain node that can't move without a person: an unanswered `ask`, or an approval gate
 *  holding a run open. The rail resolves it in place via the same routes the Inbox uses. */
export interface ChainPending {
  kind: 'question' | 'approval'
  /** Question / approval id — `api.answerQuestion(id, …)` or `api.resolve(id, approved)`. */
  id: string
  sessionId: string
  agent: string
  /** The question text, or the policy's reason this action needs sign-off. */
  text: string
  capability?: string
  level?: string
  createdAt: number
}

/** One CONVERSATION in a hand-off chain: every run sharing a claude transcript folded into one entry
 *  (`runs` of them), placed in the delegation tree by `parentThreadId` + `depth`. */
export interface ChainNode {
  threadId: string
  parentThreadId?: string
  depth: number
  /** Newest run of the conversation — what opening this node attaches to. */
  sessionId: string
  tmux: string
  agent: string
  title: string
  summary?: string
  status: Session['status']
  alive?: boolean
  /** The newest run launched unattended — drawn as a hollow ring, like the sessions list. */
  headless?: boolean
  /** Live AND blocked on a human right now (its own pending ask/approval). Must not read as "working". */
  blocked?: boolean
  /** True when a TURN is in flight on the newest run — same `busy_since` signal as `Session.working`. */
  working?: boolean
  outcome?: string
  /** Session rows this conversation spans (>1 = it was resumed by pokes/continuations). */
  runs: number
  costUsd?: number
  createdAt: number
  updatedAt: number
  /** `root` = where the chain starts; `delegate` = dispatched for a task; `answer` = an ephemeral
   *  quick-answer run that never took the task over. */
  kind: 'root' | 'delegate' | 'answer'
  taskId?: string
  taskTitle?: string
  taskStatus?: TaskStatus
  /** Set when an earlier sibling already handed the SAME work to the SAME agent — holds that task id. */
  duplicateOf?: string
  pending: ChainPending[]
}

/** The hand-off tree a session belongs to. `nodes` is flat and in walk order (parents before children). */
export interface SessionChain {
  rootThreadId: string
  nodes: ChainNode[]
  agents: number
  totalCostUsd?: number
  startedAt: number
  updatedAt: number
}

// ── Unified activity feed (os.feed) — one stream over sessions/approvals/questions. See docs/feed-plan.md.
export type FeedFilter = 'all' | 'needsYou' | 'running' | 'done'
/** One line in the stream. A running/finished session, or a pending/resolved approval or question —
 *  all projected to this shape by the server's UNION view, with attribution joined onto every row. */
export interface FeedItem {
  uid: string // "<source>:<id>" — stable id + pagination tiebreak
  ts: number
  kind: string // session.running | session.done | approval.pending | question.pending | message.update | message.notification | …
  state: 'running' | 'done' | 'decision' | 'info'
  runId: string
  agent: string | null
  runAs: string | null // the accountable human (member id)
  spawnedBy: string | null // raw provenance: "automation:…" | "task:…" | a member id | null
  goal: { id: string; title: string } | null
  title: string
  ref: { table: string; id: string }
  capability: string | null
  level: string | null // head | owner (decisions)
  args: unknown | null
  status: string | null // pending | approved | rejected | cancelled | answered | <session status>
  costUsd: number | null
  tokens: number | null // input + output tokens (session lines)
  outcome: string | null
  rating: string | null
  hasTrail: boolean
  /** The live object this line is about — a click connects to it (task card → its task, not a dead run id). */
  target: { kind: 'session' | 'task' | 'goal' | 'artifact'; id: string } | null
  /** For a running session: the newest thing the agent just did (audit-derived), so you can watch progress. */
  lastActivity?: { primitive: string; summary: string; ts: number } | null
  /** Hand-off chain grouping — folds a conversation's runs and nests a delegated run under its caller. */
  threadId?: string
  parentThreadId?: string
}
export interface FeedCounts { needsYou: number; running: number; doneToday: number }
export interface FeedResponse { items: FeedItem[]; nextCursor: string | null; counts: FeedCounts }
/** One step of a line's history, rebuilt from the append-only logs (audit_events ⋃ task_events). */
export interface FeedTrailStep { ts: number; source: 'audit' | 'task'; kind: string; author: string | null; detail: unknown }

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
  /** Box CPU/RAM pressure for the sidebar chip. Cheap + DB-free; polled on a timer. */
  host: () => call<HostMetrics>('GET', '/api/host'),
  /** Per-endpoint timings, ranked by total time, plus event-loop lag (owner/admin). */
  requestMetrics: (limit = 40) => call<RequestMetricsSnapshot>('GET', `/api/metrics/requests?limit=${limit}`),
  /** Start a fresh measurement window (owner/admin). */
  resetRequestMetrics: () => call<{ ok?: boolean; error?: string }>('POST', '/api/metrics/requests/reset'),
  /** Self-update: check whether the checkout is behind origin (`force` re-runs `git fetch`, owner/admin). */
  checkUpdate: (force = false) => call<UpdateStatus>('GET', '/api/update' + (force ? '?force=1' : '')),
  /** Owner-only: pull + rebuild + restart. Resolves with the step log; the process bounces after. */
  applyUpdate: () => call<UpdateApplyResult>('POST', '/api/update/apply'),
  setRuntimeWatch: (body: Partial<UpdateWatchConfig>) => call<{ ok?: boolean; watch?: UpdateWatchConfig; error?: string }>('POST', '/api/runtime/watch', body),
  runRuntimeWatch: () => call<{ action?: string; installed?: string; latest?: string; error?: string }>('POST', '/api/runtime/watch/run'),
  setUpdateWatch: (body: Partial<UpdateWatchConfig>) => call<{ ok?: boolean; watch?: UpdateWatchConfig; error?: string }>('POST', '/api/update/watch', body),
  runUpdateWatch: () => call<{ action?: string; behind?: number; latest?: string; error?: string }>('POST', '/api/update/watch/run'),
  /** Owner-only: plain restart, no pull/rebuild. The process bounces ~1.5s after the response. */
  restart: () => call<RestartResult>('POST', '/api/restart'),
  sessions: (archived?: boolean) => call<Session[]>('GET', '/api/sessions' + (archived ? '?archived=1' : '')),
  /** The hand-off chain this session belongs to — the tree the chain rail renders (who delegated to whom,
   *  what came back, what's still waiting on a person). Derived server-side; viewer-scoped like the list. */
  sessionChain: (id: string) => call<SessionChain | { error: string }>('GET', `/api/sessions/${encodeURIComponent(id)}/chain`),
  /** One session by id, with the same derived fields the list carries. 404 → `{error}` when the caller
   *  can't see it (viewer-scoped server-side). The by-id fetch the console lacked (Sessions-pagination P1). */
  session: (id: string) => call<Session | { error: string }>('GET', `/api/sessions/${encodeURIComponent(id)}`),
  /** Batch by-id fetch — just the named sessions (viewer-scoped), so a consumer needing a handful (the
   *  Tasks board resolving `lastSessionId → isLive`) stops pulling the whole ~950-row list. Empty → []. */
  sessionsByIds: (ids: string[]) => (ids.length ? call<Session[]>('GET', `/api/sessions?ids=${ids.map(encodeURIComponent).join(',')}`) : Promise.resolve([] as Session[])),
  /** Conditional variant of the live sessions feed for the global 1.5 s poll — resolves `notModified` on a
   *  304 so idle tabs skip the re-parse + re-render. Non-feed callers keep `sessions()` (always full body). */
  sessionsFeed: (etag: string | null) => callFeed<Session[]>('/api/sessions', etag),
  /** The cheap poll payload (Sessions-pagination Phase 2): only the LIVE rows + the viewer's recent-ended
   *  tail + a global `doneToday` count, instead of the full ~950-row list. The global poll fetches this on
   *  every route EXCEPT the sessions/chat list views (which need the full list). */
  sessionsSummary: () => call<SessionsSummary>('GET', '/api/sessions/summary'),
  /** Conditional variant of `sessionsSummary` for the global poll — 304 on no change. */
  sessionsSummaryFeed: (etag: string | null) => callFeed<SessionsSummary>('/api/sessions/summary', etag),
  unarchiveSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/unarchive`),
  sessionTidyPreview: () => call<{ ok: boolean; plan?: SessionTidyPlan; error?: string }>('GET', '/api/insights/sessions/tidy'),
  sessionTidyApply: () => call<{ ok: boolean; archived?: number; error?: string }>('POST', '/api/insights/sessions/tidy'),
  /** Inbox feed. `scope='all'` is the owner/admin oversight view (every session's cards); the default
   *  `mine` is the personal feed — only cards addressed to you, so overseers aren't flooded. */
  messages: (scope: 'mine' | 'all' = 'mine') => call<Msg[]>('GET', `/api/messages${scope === 'all' ? '?scope=all' : ''}`),
  /** Conditional variant of the inbox feed for the global 1.5 s poll — `notModified` on a 304. */
  messagesFeed: (etag: string | null, scope: 'mine' | 'all' = 'mine') => callFeed<Msg[]>(`/api/messages${scope === 'all' ? '?scope=all' : ''}`, etag),
  run: (agent: string, task: string) => call<{ id: string; tmux: string; error?: string }>('POST', '/api/sessions', { agent, task }),
  stopSession: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/stop`),
  /** Restart a session's agent process in place (keeps the transcript, resumes the same claude id) so a
   *  newly-connected MCP server is picked up. The terminal must remount right after to re-attach.
   *  `rotate` brings it back on a different runtime account (the usage-limit escape hatch); the
   *  conversation is carried across, and `note` explains it when no other account was free. */
  reloadSession: (id: string, rotate = false) =>
    call<{ ok: boolean; error?: string; account?: string; note?: string }>('POST', `/api/sessions/${id}/reload`, { rotate }),
  /** Halt every running session tenant-wide (owner/admin). Softer sibling of the kill switch. */
  stopAllSessions: () => call<{ ok: boolean; halted?: number; error?: string }>('POST', '/api/sessions/stop-all'),
  /** Host resource snapshot for Settings → System (RAM / CPU / uptime). */
  system: () => call<SystemMetrics>('GET', '/api/system'),
  /** Native-dependency check for Settings → System — present? and, for npm-installed tools, up to date?
   *  The registry lookup is cached server-side for an hour; `force` re-asks. */
  deps: (force = false) => call<DepsReport>('GET', `/api/deps${force ? '?force=1' : ''}`),
  /** Install the missing package-manager-installable deps (owner-only). Returns step logs + fresh report. */
  installDeps: () => call<DepsInstallResult>('POST', '/api/deps/install'),
  /** Upgrade one npm-installed dep in place, e.g. `claude` (owner-only). Returns step logs + fresh report. */
  updateDep: (bin: string) => call<DepsInstallResult>('POST', '/api/deps/update', { bin }),
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
  /** Cockpit: classify a message's intent + preview the outcome (no spawn). `work` → an agent to launch
   *  (route/disambiguate/none as before); `ask` → an inline `answer`; `action` → a `surface` to open.
   *  `force:'work'` skips classification (the "route to an agent anyway" escape hatch). */
  routerPreview: (text: string, force?: 'work') =>
    call<RouterPreviewResp>('POST', '/api/router/preview', force ? { text, force } : { text }),
  /** Cockpit `action` execution: carry out a detected action (create a task / propose an automation) by
   *  starting the governed operator run. Returns its session id; poll `conversation` for the result. */
  routerAct: (text: string) =>
    call<{ sessionId?: string; error?: string }>('POST', '/api/router/act', { text }),
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
  alwaysApprove: (id: string) => call<{ ok: boolean; ruleAdded?: boolean; label?: string; note?: string; error?: string }>('POST', `/api/approvals/${id}/always`),
  /** The auto-approval list ("always approve THIS action" rules), owner/admin. */
  autoApprovals: () => call<{ rules: AutoApproval[]; error?: string }>('GET', '/api/auto-approvals'),
  revokeAutoApproval: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/auto-approvals/${id}`),
  /** Approve this attempt AND add a durable org host grant (posture allow) for its target host, so
   *  future reaches to it pass the gate without a card. Owner-only. */
  trustHost: (id: string) => call<{ ok: boolean; trusted?: boolean; host?: string; note?: string; error?: string }>('POST', `/api/approvals/${id}/trust-host`),
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
  /** This member's saved Quick Shortcuts (canned prompts for a live terminal session). */
  promptShortcuts: () => call<{ shortcuts: PromptShortcut[] }>('GET', '/api/me/shortcuts'),
  savePromptShortcuts: (shortcuts: PromptShortcut[]) => call<{ shortcuts: PromptShortcut[] }>('PUT', '/api/me/shortcuts', { shortcuts }),
  /** Type text into a LIVE session's pane as if the attached human typed it (Quick Shortcuts). `submit`
   *  defaults true (fire immediately). 409 = the session isn't live to type into. */
  injectToSession: (id: string, text: string, submit = true) =>
    call<{ ok: boolean; error?: string }>('POST', `/api/sessions/${id}/inject`, { text, submit }),
  /** Out-of-band summary of a session: reads its transcript and summarizes it in a throwaway claude —
   *  the target session is never touched. `via` = 'ai' | 'fallback'. */
  summarizeSession: (id: string) =>
    call<{ summary: string; via: 'ai' | 'fallback'; found: boolean; error?: string }>('POST', `/api/sessions/${id}/summarize`),

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
  // `signingSecret` is write-only and therefore not part of `Automation`: null removes it, a string sets
  // it, omitted leaves the stored one alone.
  updateAutomation: (id: string, patch: Partial<Pick<Automation, 'name' | 'mode' | 'schedule' | 'filter' | 'task' | 'enabled' | 'runAs' | 'threadPath'>> & { signingSecret?: string | null }) =>
    call<Automation & { error?: string }>('PATCH', '/api/automations/' + id, patch),
  deleteAutomation: (id: string) => call<{ ok: boolean }>('DELETE', '/api/automations/' + id),
  /** Fire an automation once now. `mode` overrides its saved default for this run only (headless =
   *  fire-and-forget, interactive = watch/steer the live TUI); omit to keep the automation's own mode. */
  runAutomation: (id: string, mode?: 'interactive' | 'headless') => call<{ ok: boolean; sessionId?: string; reason?: string; error?: string }>('POST', `/api/automations/${id}/run`, mode ? { mode } : {}),
  automationProposals: () => call<{ proposals: AutomationProposal[]; error?: string }>('GET', '/api/automations/proposals'),
  approveAutomationProposal: (id: string, runAs?: string) => call<{ ok: boolean; automation?: Automation; error?: string }>('POST', `/api/automations/proposals/${id}/approve`, runAs !== undefined ? { runAs } : {}),
  rejectAutomationProposal: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/automations/proposals/${id}/reject`),
  agentUpdateProposals: (target?: string) => call<{ proposals: AgentUpdateProposal[]; canApprove?: boolean; error?: string }>('GET', '/api/agents/proposals' + (target ? '?target=' + encodeURIComponent(target) : '')),
  approveAgentUpdateProposal: (id: string) => call<{ ok: boolean; target?: string; rev?: number; error?: string }>('POST', `/api/agents/proposals/${id}/approve`),
  rejectAgentUpdateProposal: (id: string, note?: string) => call<{ ok: boolean; error?: string }>('POST', `/api/agents/proposals/${id}/reject`, { note }),
  goalUpdateProposals: (goal?: string) => call<{ proposals: GoalUpdateProposal[]; canApprove?: boolean; error?: string }>('GET', '/api/goals/proposals' + (goal ? '?goal=' + encodeURIComponent(goal) : '')),
  approveGoalUpdateProposal: (id: string) => call<{ ok: boolean; goalId?: string; status?: GoalStatus; error?: string }>('POST', `/api/goals/proposals/${id}/approve`),
  rejectGoalUpdateProposal: (id: string, note?: string) => call<{ ok: boolean; error?: string }>('POST', `/api/goals/proposals/${id}/reject`, { note }),
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

  tasks: (q = '', status = '') => call<{ tasks: Task[]; counts: Record<TaskStatus, number>; prCounts?: Record<string, TaskPrSummary>; agents: string[]; discussions?: Record<string, TaskDiscussionSummary>; workers?: Record<string, TaskWorkers> }>('GET', `/api/tasks?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  task: (id: string) => call<{ task?: Task; events?: TaskEvent[]; attachments?: TaskAttachment[]; dependents?: string[]; children?: TaskChild[]; runs?: TaskRun[]; prs?: TaskPr[]; discussion?: TaskTimelineEntry[]; unread?: number; choices?: { id: string; agentId: string; message: string }[]; error?: string }>('GET', `/api/tasks/${id}`),
  /** The task's PRs with their status refreshed from GitHub (stale-only unless `refresh`). Separate from
   *  the detail payload because it makes network calls — the detail's `prs` render instantly from cache. */
  taskPrs: (id: string, refresh?: boolean) => call<{ prs?: TaskPr[]; summary?: TaskPrSummary; error?: string }>('GET', `/api/tasks/${id}/prs${refresh ? '?refresh=1' : ''}`),
  postTaskMessage: (id: string, body: string) => call<{ ok: boolean; entry?: TaskTimelineEntry; mentioned?: string[]; agents?: { agent: string; status: string }[]; delivery?: TaskDiscussionDelivery; error?: string }>('POST', `/api/tasks/${id}/messages`, { body }),
  // Route an ALREADY-POSTED discussion message into one live run — the human's answer when several were
  // live and the post came back `choose`. Posts nothing new.
  deliverTaskMessage: (id: string, sessionId: string, body: string) => call<{ ok: boolean; delivery?: TaskDiscussionDelivery; error?: string }>('POST', `/api/tasks/${id}/deliver`, { sessionId, body }),
  readTaskDiscussion: (id: string) => call<{ ok: boolean }>('POST', `/api/tasks/${id}/read`),
  resolveTaskMention: (msgId: string, action: 'answer' | 'session' | 'dismiss') => call<{ ok: boolean; error?: string }>('POST', `/api/tasks/mention/${msgId}`, { action }),
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

  /** One page of the unified activity feed. `goalId` scopes to the goal lens; `cursor` is keyset pagination. */
  feed: (opts: { filter?: FeedFilter; goalId?: string; cursor?: string; limit?: number; since?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.filter && opts.filter !== 'all') qs.set('filter', opts.filter)
    if (opts.goalId) qs.set('goal', opts.goalId)
    if (opts.cursor) qs.set('cursor', opts.cursor)
    if (opts.limit) qs.set('limit', String(opts.limit))
    if (opts.since) qs.set('since', String(opts.since))
    const q = qs.toString()
    return call<FeedResponse>('GET', '/api/feed' + (q ? '?' + q : ''))
  },
  /** The step-by-step history behind one feed line, rebuilt from the append-only logs. */
  feedTrail: (runId: string) => call<{ steps: FeedTrailStep[] }>('GET', `/api/feed/${runId}/trail`),

  goals: (q = '', status = '') => call<{ goals: Goal[]; counts: GoalCounts; progress: Record<string, GoalProgress>; autoPlan?: boolean }>('GET', `/api/goals?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}`),
  setAutoPlanGoals: (on: boolean) => call<{ ok: boolean; autoPlan?: boolean; error?: string }>('POST', '/api/goals/autoplan', { on }),
  goal: (id: string) => call<{ goal?: Goal; events?: GoalEvent[]; tasks?: Task[]; runs?: Record<string, TaskRunState>; progress?: GoalProgress; chat?: GoalChatState | null; error?: string }>('GET', `/api/goals/${id}`),
  /** Send a message into the goal's chat — starts the conversation on the first call, continues the same
   *  warm one after that. `fresh` abandons a wedged conversation and opens a new one. 409 = still working. */
  goalChat: (id: string, message: string, fresh = false) =>
    call<{ ok: boolean; sessionId?: string; started?: boolean; status?: 'busy'; error?: string }>('POST', `/api/goals/${id}/chat`, { message, fresh }),
  addGoal: (b: AddGoalReq) => call<{ ok: boolean; goal?: Goal; error?: string }>('POST', '/api/goals', b),
  patchGoal: (id: string, b: { title?: string; body?: string; status?: GoalStatus; target?: string | null; owner?: string | null; parentId?: string | null; labels?: string[]; dueAt?: number | null; note?: string }) => call<{ ok: boolean; goal?: Goal; error?: string }>('PATCH', `/api/goals/${id}`, b),
  commentGoal: (id: string, body: string) => call<{ ok: boolean; goal?: Goal; error?: string }>('POST', `/api/goals/${id}/comment`, { body }),
  deleteGoal: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/goals/${id}`),
  planGoal: (id: string, steer?: { guidance?: string; maxTasks?: number; autoDispatch?: boolean }) => call<{ ok: boolean; sessionId?: string; error?: string }>('POST', `/api/goals/${id}/plan`, steer ?? {}),
  dreaming: () => call<{ everyHours: number; lastDreamedAt?: number; stale?: boolean; applyLearnings?: boolean; guidance?: string; recommendations?: Recommendation[]; digest?: DigestConfig; state?: DreamingState; measurement?: Measurement; insights?: Insights; improvements?: ImprovementTile[]; proposals?: string[]; stuckGoals?: StuckGoal[]; troubledAutomations?: TroubledAutomation[]; alertsEnabled?: boolean; error?: string }>('GET', '/api/dreaming'),
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
  taskReconcilePreview: () => call<{ ok: boolean; plan?: TaskReconcilePlan; error?: string }>('GET', '/api/insights/tasks/reconcile'),
  taskReconcileApply: () => call<{ ok: boolean; closed?: number; error?: string }>('POST', '/api/insights/tasks/reconcile'),

  createAgent: (input: { id: string; description: string; category?: string; claudeMd: string; examplePrompts?: string[]; shellSecrets?: string[]; skills?: string[]; tools?: string[]; icon?: string; runtime?: string } & RuntimeTuning) => call<{ ok: boolean; id?: string; error?: string }>('POST', '/api/agents', input),
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
  runtimes: () => call<{ runtimes?: RuntimePresence[]; error?: string }>('GET', '/api/runtimes'),
  installRuntime: (id: string) => call<{ ok?: boolean; version?: string; error?: string }>('POST', `/api/runtimes/${encodeURIComponent(id)}/install`),
  agentConfig: (id: string) => call<{ agent: string; error?: string; runtime?: string; runtimes?: RuntimePickerInfo[]; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; skills?: string[]; tools?: string[]; usableSubagents?: string[]; spawnableAsSubagent?: boolean; chatReachable?: boolean; netMode?: 'open' | 'allowlist'; category?: string; icon?: string } & RuntimeTuning>('GET', `/api/agents/${encodeURIComponent(id)}/config`),
  saveAgentConfig: (id: string, patch: RuntimeTuningPatch & { runtime?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; skills?: string[]; tools?: string[]; usableSubagents?: string[]; spawnableAsSubagent?: boolean; chatReachable?: boolean; netMode?: 'open' | 'allowlist'; category?: string; icon?: string }) => call<{ ok: boolean; error?: string; description?: string; examplePrompts?: string[]; shellSecrets?: string[]; skills?: string[]; tools?: string[]; usableSubagents?: string[]; spawnableAsSubagent?: boolean; chatReachable?: boolean; netMode?: 'open' | 'allowlist'; category?: string; icon?: string; runtime?: string } & RuntimeTuning>('PUT', `/api/agents/${encodeURIComponent(id)}/config`, patch),
  agentRevisions: (id: string) => call<{ agent: string; revisions: AgentRevision[]; error?: string }>('GET', `/api/agents/${encodeURIComponent(id)}/revisions`),
  agentRevert: (id: string, rev: number) => call<{ ok: boolean; id?: string; toRev?: number; rev?: number; error?: string }>('POST', `/api/agents/${encodeURIComponent(id)}/revert`, { rev }),
  runtimeDefaults: () => call<RuntimeTuning & { updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/runtime-defaults'),
  saveRuntimeDefaults: (tuning: RuntimeTuning) => call<{ ok: boolean; error?: string } & RuntimeTuning>('PUT', '/api/settings/runtime-defaults', tuning),
  outputStyleAdoption: (days = 30) => call<OutputStyleAdoption>('GET', `/api/settings/output-style-adoption?days=${days}`),
  outputStyles: () => call<OutputStylesResp>('GET', '/api/output-styles'),
  outputStyle: (name: string) => call<OutputStyleDetail>('GET', `/api/output-styles/${encodeURIComponent(name)}`),
  saveOutputStyle: (name: string, body: { content?: string; description?: string }) =>
    call<OutputStyleDetail & { ok: boolean }>('PUT', `/api/output-styles/${encodeURIComponent(name)}`, body),
  deleteOutputStyle: (name: string) =>
    call<{ ok: boolean; orphaned: string[]; error?: string }>('DELETE', `/api/output-styles/${encodeURIComponent(name)}`),
  subagentDefault: () => call<{ mode: 'all' | 'none'; error?: string }>('GET', '/api/settings/subagent-default'),
  saveSubagentDefault: (mode: 'all' | 'none') => call<{ ok: boolean; mode?: 'all' | 'none'; error?: string }>('PUT', '/api/settings/subagent-default', { mode }),
  agentProposalTrust: () => call<{ trust: AgentProposalTrust; error?: string }>('GET', '/api/settings/agent-proposal-trust'),
  saveAgentProposalTrust: (patch: Partial<AgentProposalTrust>) => call<{ ok: boolean; trust?: AgentProposalTrust; error?: string }>('PUT', '/api/settings/agent-proposal-trust', patch),
  saveSessionMetrics: (value: SessionMetrics) => call<{ ok: boolean; sessionMetrics?: SessionMetrics; error?: string }>('PUT', '/api/settings/session-metrics', { value }),
  concurrency: () => call<Concurrency & { error?: string }>('GET', '/api/settings/concurrency'),
  saveConcurrency: (body: { value?: number | null; idleHours?: number; unattendedMaxHours?: number; unattendedNoProgressMinutes?: number; blockedMaxHours?: number; claimedMaxHours?: number }) => call<{ ok: boolean; error?: string; value?: number | null; resolved?: number; derived?: number; idleHours?: number; unattendedMaxHours?: number; unattendedNoProgressMinutes?: number; blockedMaxHours?: number; claimedMaxHours?: number }>('PUT', '/api/settings/concurrency', body),
  runtimeAccounts: () => call<RuntimeAccountsResp>('GET', '/api/runtime-accounts'),
  addRuntimeAccount: (body: { runtime: string; name: string; kind: RuntimeAccountKind; configDir?: string; apiKeyRef?: string; token?: string }) => call<{ ok: boolean; error?: string; account?: RuntimeAccount }>('POST', '/api/runtime-accounts', body),
  setRuntimeAccountEnabled: (runtime: string, name: string, enabled: boolean) => call<{ ok: boolean; error?: string }>('PATCH', `/api/runtime-accounts/${encodeURIComponent(runtime)}/${encodeURIComponent(name)}`, { enabled }),
  removeRuntimeAccount: (runtime: string, name: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/runtime-accounts/${encodeURIComponent(runtime)}/${encodeURIComponent(name)}`),
  startRuntimeLogin: (runtime: string, name: string) => call<{ ok: boolean; error?: string; login?: RuntimeLogin }>('POST', '/api/runtime-accounts/login', { runtime, name }),
  pollRuntimeLogin: (id: string) => call<{ ok: boolean; error?: string; login?: RuntimeLogin; account?: RuntimeAccount | null }>('GET', `/api/runtime-accounts/login/${encodeURIComponent(id)}`),
  submitRuntimeLoginCode: (id: string, code: string) => call<{ ok: boolean; error?: string; login?: RuntimeLogin }>('POST', `/api/runtime-accounts/login/${encodeURIComponent(id)}/code`, { code }),
  cancelRuntimeLogin: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', `/api/runtime-accounts/login/${encodeURIComponent(id)}`),
  checkRuntimeAccount: (runtime: string, name: string) => call<{ ok: boolean; error?: string; account?: RuntimeAccount; check?: { ok: boolean | null; note: string } }>('POST', `/api/runtime-accounts/${encodeURIComponent(runtime)}/${encodeURIComponent(name)}/check`),

  governance: () => call<GovernanceThresholds & { hostGovernanceEnabled?: boolean; semanticGuardEnabled?: boolean; fileWriteGuardEnabled?: boolean; updatedAt?: number; updatedBy?: string; error?: string }>('GET', '/api/settings/governance'),
  saveGovernance: (t: GovernanceThresholds & { hostGovernanceEnabled?: boolean; semanticGuardEnabled?: boolean; fileWriteGuardEnabled?: boolean }) => call<{ ok: boolean; error?: string; hostGovernanceEnabled?: boolean; semanticGuardEnabled?: boolean; fileWriteGuardEnabled?: boolean } & GovernanceThresholds>('PUT', '/api/settings/governance', t),

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


  // Install wizard: one read-side roll-up of "what's still unconfigured". Fixing a step calls that
  // setting's own endpoint (saveCompany, saveIntegrations, invite, …) — these three only read, skip
  // and dismiss.
  setup: () => call<SetupStatus & { error?: string }>('GET', '/api/setup'),
  skipSetupStep: (step: SetupStepId, skip = true) => call<SetupStatus & { error?: string }>('POST', '/api/setup/skip', { step, skip }),
  dismissSetup: (dismissed = true) => call<SetupStatus & { error?: string }>('POST', '/api/setup/dismiss', { dismissed }),

  settings: () => call<CompanySettings>('GET', '/api/settings'),
  saveCompany: (companyMd: string) => call<CompanySettings & { ok: boolean; error?: string }>('PUT', '/api/settings/company', { companyMd }),
  saveReview: (reviewMd: string) => call<CompanySettings & { ok: boolean; error?: string }>('PUT', '/api/settings/review', { reviewMd }),
  connections: () => call<ConnectionsResp>('GET', '/api/connections'),
  integrationsOverview: () => call<IntegrationsOverview>('GET', '/api/integrations/overview'),
  composioToolkits: () => call<{ toolkits: { slug: string; name: string }[]; error?: string }>('GET', '/api/composio/toolkits'),
  connectApp: (body: { toolkit: string; scope: 'company' | 'personal' }) =>
    call<{ redirectUrl?: string; error?: string }>('POST', '/api/connections/connect', body),
  disconnectApp: (body: { id: string; scope: 'company' | 'personal' }) =>
    call<{ ok?: boolean; error?: string }>('POST', '/api/connections/disconnect', body),
  // Mark one of MY Composio apps available to the team (or take it back). Nothing moves on Composio —
  // the launcher mints a toolkit-allowlisted, account-pinned session under my entity for teammates.
  shareConnection: (body: { id: string; shared: boolean }) =>
    call<{ ok?: boolean; shared?: boolean; error?: string }>('POST', '/api/connections/share', body),
  // Agent connection requests (`connection_request`). List: admin sees all open; a member sees their own
  // personal ones. Fulfilling initiates the Composio OAuth and returns the hosted link to finish.
  connectionRequests: () => call<ConnectionRequestsResp>('GET', '/api/connections/requests'),
  fulfillConnectionRequest: (id: string) =>
    call<{ ok?: boolean; redirectUrl?: string; error?: string }>('POST', '/api/connections/requests/' + encodeURIComponent(id) + '/fulfill'),
  dismissConnectionRequest: (id: string) =>
    call<{ ok?: boolean; error?: string }>('POST', '/api/connections/requests/' + encodeURIComponent(id) + '/dismiss'),
  integrations: () => call<IntegrationsResp>('GET', '/api/settings/integrations'),
  atlasModels: () => call<{ configured: boolean; image: { id: string; label: string; priceUsd: number | null }[]; video: { id: string; label: string; priceUsd: number | null }[]; error?: string }>('GET', '/api/integrations/atlas/models'),
  saveIntegrations: (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string; telegramBotToken?: string; clickupToken?: string; clickupWebhookSecret?: string; githubClientId?: string; githubClientSecret?: string; githubAppId?: string; githubPrivateKey?: string; githubAppSlug?: string; openRouterKey?: string; atlasKey?: string; imageDefaultModel?: string; falKey?: string; videoDefaultModel?: string; anthropicApiKey?: string; anthropicModel?: string; chatRouter?: boolean; chatIdleTimeoutMin?: number }) => call<IntegrationsResp & { ok: boolean }>('PUT', '/api/settings/integrations', body),
  // Per-member GitHub (user-to-server OAuth): each member links their OWN account so run-as sessions
  // push / open PRs as the actual human. `connect` returns the authorize URL to navigate to.
  githubMe: () => call<GithubMe>('GET', '/api/github/me'),
  githubConnect: (returnTo?: string) => call<{ redirectUrl?: string; error?: string }>('GET', `/api/github/connect${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`),
  githubDisconnect: () => call<{ ok?: boolean; error?: string }>('POST', '/api/github/disconnect', {}),
  // One-click App setup: returns GitHub's form-POST target + the pre-filled manifest to submit to it.
  githubManifest: (org?: string) => call<{ postUrl?: string; manifest?: string; error?: string }>('GET', `/api/github/manifest${org ? `?org=${encodeURIComponent(org)}` : ''}`),
  slackStatus: () => call<SlackStatus>('GET', '/api/settings/slack/status'),
  discordStatus: () => call<DiscordStatus>('GET', '/api/settings/discord/status'),
  telegramStatus: () => call<TelegramStatus>('GET', '/api/settings/telegram/status'),

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
  /** Apply an agent-proposed edit — the parked text overwrites the live SKILL.md (owner/admin). */
  applySkillEdit: (name: string) =>
    call<{ ok: boolean; skill?: SkillDetail; reloaded?: number; error?: string }>('POST', '/api/skills/' + encodeURIComponent(name) + '/edit/apply'),
  /** Discard an agent-proposed edit — the live skill is untouched (owner/admin). */
  discardSkillEdit: (name: string) =>
    call<{ ok: boolean; error?: string }>('POST', '/api/skills/' + encodeURIComponent(name) + '/edit/discard'),
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

  artifacts: (archived?: boolean) => call<{ artifacts: Artifact[]; enabled: boolean }>('GET', '/api/artifacts' + (archived ? '?archived=1' : '')),
  deleteArtifact: (id: string) => call<{ ok: boolean; error?: string }>('DELETE', '/api/artifacts/' + id),
  unarchiveArtifact: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/artifacts/${id}/unarchive`),
  libraryTidyPreview: () => call<{ ok: boolean; plan?: LibraryTidyPlan; error?: string }>('GET', '/api/insights/library/tidy'),
  libraryTidyApply: () => call<{ ok: boolean; archived?: number; error?: string }>('POST', '/api/insights/library/tidy'),
  moveArtifact: (id: string, folder: string) => call<{ ok: boolean; artifact?: Artifact; error?: string }>('PATCH', '/api/artifacts/' + id, { folder }),
  /** Share an artifact with the tenant (`team`) and/or mint/revoke its public link (`public`). */
  shareArtifact: (id: string, body: { team?: boolean; public?: boolean }) => call<{ ok: boolean; artifact?: Artifact; error?: string }>('POST', `/api/artifacts/${id}/share`, body),
  /** Overwrite a text/markdown artifact's content in place (owner/admin or producer). */
  editArtifact: (id: string, content: string) => call<{ ok: boolean; artifact?: Artifact; error?: string }>('PUT', `/api/artifacts/${id}/content`, { content }),
  /** Direct URL to an artifact's bytes (for <img>/<iframe>/download). `file` selects a sibling (sites). */
  artifactRawUrl: (id: string, file?: string) => `/api/artifacts/${id}/raw${file ? `?file=${encodeURIComponent(file)}` : ''}`,
  /** Markdown artifacts only — the server renders the PDF on demand and sends it as an attachment. */
  artifactPdfUrl: (id: string) => `/api/artifacts/${id}/pdf`,

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
