import { useEffect, useMemo, useRef, useState, type ReactNode, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { Inbox as InboxIcon, TerminalSquare, Play, Plus, Check, X, Square, Rocket, Plug, Trash2, Users, User, LogOut, Copy, Zap, Brain, Building2, ChevronDown, SlidersHorizontal, Pencil, FileText, HelpCircle, CheckCircle2, XCircle, Clock, Send, LayoutGrid, List, ArrowLeft, Bot, FolderTree, Folder, File as FileIcon, Save, ChevronRight, Sparkles, Package, Image as ImageIcon, Film, Download, Search, BookText, BookOpen, History as HistoryIcon, ScrollText, Bell, AlertTriangle, Activity, Upload, FolderPlus, ListChecks, PanelLeftClose, PanelLeftOpen, RefreshCw, ThumbsUp, ThumbsDown } from 'lucide-react'
import { Wrench, Code2, Bug, MessageSquare, Mail, Megaphone, PenTool, Database, Server, Cloud, Shield, Calendar, LineChart, BarChart3, DollarSign, ShoppingCart, Headphones, Cog, Compass, Flag, Heart, Star, Globe, GitBranch, Palette, Camera, Music, Feather, Wand2, Boxes, Terminal, Webhook, CalendarClock, Hash, Cpu, type LucideIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, EFFORTS, PERMISSION_MODES, type PermissionMode, type StateResp, type AgentInfo, type Session, type Msg, type Member, type Role, type TeamResp, type MemberIdentity, type IdentityProvider, IDENTITY_PROVIDERS, type Automation, type Task, type TaskEvent, type TaskAttachment, type TaskStatus, type AddTaskReq, type MemoryRecord, type MemoryHealth, type MemoryBackend, type MemorySettings, type MemorySettingsReq, type OllamaStatus, type KbPage, type KbRevision, type AgentRevision, type AgentStats, type Recommendation, type PolicyDocument, type PolicyRule, type PolicyOutcome, type PolicyOp, type DirListing, type FileEntry, type FileContent, type Artifact, type SkillSummary, type SkillsResp, type CatalogSkill, type CatalogAgent, type SkillSource, type RemoteSkill, type SkillshHit, type IntegrationsResp, type SlackStatus, type DiscordStatus, type AuditEvent, type Effort, type RuntimeTuning, type SecretMeta, type UpdateStatus, type UpdateApplyResult, type ActivityEvent, type ActivitySummaryRow } from '@/lib/api'
import { type Branding, type PublicBranding } from '@/lib/api'
import { applyAccent, applyFavicon, faviconDataUri, readableOn } from '@/lib/branding'
import { ConnectorsPage } from '@/connectors'
import { docPages } from '@/docs'
import { Xterm } from './Xterm'

// Terminal font-size bounds (shared by TerminalFrame's state and the ImageDropZone stepper).
const TERM_FONT_MIN = 8, TERM_FONT_MAX = 40

type Route = 'inbox' | 'sessions' | 'agents' | 'new-agent' | 'connectors' | 'team' | 'automations' | 'tasks' | 'memory' | 'kb' | 'skills' | 'files' | 'artifacts' | 'settings' | 'audit' | 'agent' | 'docs'
// The full set of pages, used by the hash router to validate the URL on load. Keep in sync with Route.
const ROUTES: Route[] = ['inbox', 'sessions', 'agents', 'new-agent', 'connectors', 'team', 'automations', 'tasks', 'memory', 'kb', 'skills', 'files', 'artifacts', 'settings', 'audit', 'agent', 'docs']
type Selected = { tmux: string; title: string } | null

/** Mirror of the server rule: owner approves anything, admin approves head-level only. */
const canApprove = (role: Role, level: 'head' | 'owner'): boolean =>
  role === 'owner' || (role === 'admin' && level === 'head')

/** A session is "live" when its tmux pane is alive now (`alive`), OR — when the server couldn't poll
 *  tmux (`alive` undefined) — when its stored status is still `running`. This is the source of truth
 *  for the green dot: an interactive session that reported `done` but keeps an attachable pane is live. */
const isLive = (s: Session): boolean => Boolean(s.alive) || s.status === 'running'

/** Status dot colour for a session: live=emerald, done=muted, stopped=amber, crashed=red. */
const statusDot = (s: Session): string =>
  isLive(s) ? 'bg-emerald-500'
    : s.status === 'stopped' ? 'bg-amber-500'
    : s.status === 'crashed' ? 'bg-red-500'
    : 'bg-muted-foreground/40' // done (and any unknown legacy value)

/** The status word shown next to the dot. A live pane whose stored status is a terminal state (a
 *  `done` interactive session still running) reads "live" so the label never contradicts a green dot. */
const statusLabel = (s: Session): string => (isLive(s) && s.status !== 'running' ? 'live' : s.status)

/** A stopped/ended/crashed interactive session that can be resurrected in place: re-opening its
 *  terminal runs `claude --resume` (via terminal/attach.sh), picking the conversation back up. Shown
 *  as a Resume affordance. Requires a persisted launch env (`resumable`) and no live pane — a live
 *  session is just "open", not "resume". */
const canResume = (s: Session): boolean => Boolean(s.resumable) && !isLive(s)

/** Resume a stopped session from the console: lift the server-side stop-block, THEN open/focus its
 *  terminal. A plain stop leaves the block in place so ttyd's silent auto-reconnect can't revive the
 *  session; a Resume click is the deliberate act that clears it. We clear it explicitly (not just via
 *  the iframe's attach fetch) because the tab may already be open and not remount. */
const resumeAndOpen = (s: Session, onOpen: (tmux: string, title: string) => void): void => {
  void api.resumeSession(s.id).finally(() => onOpen(s.tmux, s.agent + ' · ' + s.id))
}

/** A headless run (automation/cron/chat/task) is `claude -p` — non-interactive, and it writes no resurrect
 *  env, so it's never `resumable`. It CAN be "taken over": relaunched as an attachable interactive session
 *  (`claude --resume` under the same pinned id) so a human can watch and steer. Offered while it's live
 *  (streaming) or after it finished (continue the transcript). Interactive runs already have a live/Resume
 *  path, so they never show this. Server re-checks it's a claude-code run with a resumable transcript. */
const canGoInteractive = (s: Session): boolean =>
  !s.resumable && (isLive(s) || s.status === 'done' || s.status === 'crashed')

/** Take over a headless run: convert it to an interactive session server-side (kills the in-flight `-p`
 *  turn if still streaming), THEN open/focus its terminal so the user lands in the live, attachable TUI. */
const takeOverAndOpen = (s: Session, onOpen: (tmux: string, title: string) => void): void => {
  void api.goInteractive(s.id).finally(() => onOpen(s.tmux, s.agent + ' · ' + s.id))
}

/** Coarse provenance category of a session, from its raw `spawnedBy` (`automation:`/`task:`/`chat:`
 *  prefixes, else a member started it directly). Drives the Source filter on the sessions list. */
type SessionSource = 'member' | 'automation' | 'task' | 'chat'
const sessionSource = (s: Session): SessionSource => {
  const by = s.spawnedBy ?? ''
  return by.startsWith('automation:') ? 'automation'
    : by.startsWith('task:') ? 'task'
    : by.startsWith('chat:') ? 'chat'
    : 'member'
}

/** Session-list status filter. `live` matches any session with a live pane (regardless of stored
 *  status); the terminal states match only when NOT live, so a live pane reporting `done` reads as
 *  Live, never Done — the same rule `statusLabel` uses for the dot. */
type SessionStatusFilter = 'all' | 'live' | 'done' | 'stopped' | 'crashed'
const matchesStatus = (s: Session, f: SessionStatusFilter): boolean =>
  f === 'all' ? true : f === 'live' ? isLive(s) : !isLive(s) && s.status === f

// Filter labels — shared by the dropdown options AND the collapsed trigger (base-ui's SelectValue
// renders the raw value unless given a formatter, so the two must read from one source).
const SESSION_STATUS_LABELS: Record<SessionStatusFilter, string> =
  { all: 'All statuses', live: 'Live', done: 'Done', stopped: 'Stopped', crashed: 'Crashed' }
const SESSION_SOURCE_LABELS: Record<'all' | SessionSource, string> =
  { all: 'All sources', member: 'Member', automation: 'Automation', task: 'Task', chat: 'Chat' }

/** The mode axis of the sessions list: interactive (attachable TUI) vs headless (`claude -p`, exits when
 *  done). Independent of who/what started it — an automation can be either, a manual spawn is always
 *  interactive. */
type SessionModeFilter = 'all' | 'interactive' | 'headless'
const SESSION_MODE_LABELS: Record<SessionModeFilter, string> =
  { all: 'Any mode', interactive: 'Interactive', headless: 'Headless' }

/** Presentation for each normalized {@link Session.sourceKind} — the icon + short chip label the
 *  sessions list badges every distinct way a session gets initiated. The server resolves the kind
 *  (splitting the automation family by trigger); the client only maps it to a glyph. Falls back to
 *  `system` for an unknown/missing kind. */
const ORIGIN_META: Record<NonNullable<Session['sourceKind']>, { icon: LucideIcon; label: string }> = {
  manual: { icon: User, label: 'Manual' },
  cron: { icon: Clock, label: 'Cron' },
  webhook: { icon: Webhook, label: 'Webhook' },
  slack: { icon: MessageSquare, label: 'Slack' },
  discord: { icon: Hash, label: 'Discord' },
  composio: { icon: Plug, label: 'Composio' },
  scheduled: { icon: CalendarClock, label: 'Scheduled' },
  task: { icon: ListChecks, label: 'Task' },
  chat: { icon: Send, label: 'Chat' },
  system: { icon: Cpu, label: 'System' },
}
const originMeta = (kind?: Session['sourceKind']) => ORIGIN_META[kind ?? 'system'] ?? ORIGIN_META.system

/** Sortable columns of the sessions list. `updated` is the default (most recently active first); it's
 *  the omitted value in the URL, so a clean `#/sessions` shows the freshest sessions on top. */
type SessionSortKey = 'created' | 'title' | 'agent' | 'id' | 'startedBy' | 'status' | 'updated'
type SortDir = 'asc' | 'desc'
const SESSION_SORT_KEYS: SessionSortKey[] = ['created', 'title', 'agent', 'id', 'startedBy', 'status', 'updated']
const DEFAULT_SORT_KEY: SessionSortKey = 'updated'
/** Status ordering for the Status-column sort: live → done → stopped → crashed. */
const statusRank = (s: Session): number =>
  isLive(s) ? 0 : s.status === 'done' ? 1 : s.status === 'stopped' ? 2 : s.status === 'crashed' ? 3 : 4
/** Ascending comparison for a given column; direction is applied by the caller. */
const compareSessions = (a: Session, b: Session, key: SessionSortKey): number => {
  switch (key) {
    case 'created': return a.createdAt - b.createdAt
    case 'title': return a.title.localeCompare(b.title)
    case 'agent': return a.agent.localeCompare(b.agent)
    case 'id': return a.id.localeCompare(b.id)
    case 'startedBy': return (a.spawnedByLabel ?? '').localeCompare(b.spawnedByLabel ?? '')
    case 'status': return statusRank(a) - statusRank(b)
    case 'updated': return a.updatedAt - b.updatedAt
  }
}

/** The sessions-list view state (filters + sort), held in the URL hash query so it survives a
 *  refresh / deep-link. */
interface SessionFilters { q: string; status: SessionStatusFilter; agent: string; source: 'all' | SessionSource; mode: SessionModeFilter; owner: string; mine: boolean; sortKey: SessionSortKey; sortDir: SortDir }
const parseSessionFilters = (qs: string): SessionFilters => {
  const p = new URLSearchParams(qs)
  const status = p.get('status') ?? ''
  const source = p.get('source') ?? ''
  const mode = p.get('mode') ?? ''
  const sort = p.get('sort') ?? ''
  return {
    q: p.get('q') ?? '',
    status: (status in SESSION_STATUS_LABELS ? status : 'all') as SessionStatusFilter,
    agent: p.get('agent') ?? 'all',
    source: (source in SESSION_SOURCE_LABELS ? source : 'all') as 'all' | SessionSource,
    mode: (mode in SESSION_MODE_LABELS ? mode : 'all') as SessionModeFilter,
    owner: p.get('owner') ?? 'all',
    mine: p.get('mine') === '1',
    sortKey: (SESSION_SORT_KEYS.includes(sort as SessionSortKey) ? sort : DEFAULT_SORT_KEY) as SessionSortKey,
    sortDir: (p.get('dir') === 'asc' ? 'asc' : 'desc') as SortDir,
  }
}
/** Serialize the active (non-default) filters + sort back to a query param bag for the URL. */
const sessionFiltersToParams = (f: SessionFilters): Record<string, string> => {
  const p: Record<string, string> = {}
  if (f.q.trim()) p.q = f.q.trim()
  if (f.status !== 'all') p.status = f.status
  if (f.agent !== 'all') p.agent = f.agent
  if (f.source !== 'all') p.source = f.source
  if (f.mode !== 'all') p.mode = f.mode
  if (f.owner !== 'all') p.owner = f.owner
  // `mine` is serialized by the caller, not here: its default is role-dependent (ON for owner/admin,
  // OFF for members), so only a deviation from that per-viewer default is written to the URL.
  if (f.sortKey !== DEFAULT_SORT_KEY) p.sort = f.sortKey
  if (f.sortDir !== 'desc') p.dir = f.sortDir
  return p
}

const ROLE_LABEL: Record<Role, string> = { owner: 'owner', admin: 'admin', member: 'member' }

function RoleBadge({ role }: { role: Role }) {
  const variant = role === 'owner' ? 'destructive' : role === 'admin' ? 'default' : 'secondary'
  return <Badge variant={variant} className="px-1.5 py-0 text-[10px] font-normal">{ROLE_LABEL[role]}</Badge>
}

/** A member's profile picture — their uploaded avatar, or their initial in a muted circle. `className`
 *  carries the size (e.g. `h-8 w-8 text-xs`). */
function MemberAvatar({ member, className }: { member: Pick<Member, 'name' | 'avatar'>; className?: string }) {
  const cls = `shrink-0 rounded-full bg-muted ${className ?? ''}`
  return member.avatar
    ? <img src={member.avatar} alt="" className={`${cls} object-cover`} />
    : <span className={`grid place-items-center font-semibold uppercase text-foreground/70 ${cls}`}>{member.name.slice(0, 1)}</span>
}

/** Down-scale + center-crop a picked image into a small square JPEG data-URL, so avatars stay tiny in
 *  the DB and on every /api/team load. */
async function fileToAvatarDataUrl(file: File, size = 128): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('could not read image'))
      i.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = size; canvas.height = size
    const ctx = canvas.getContext('2d')!
    const scale = Math.max(size / img.width, size / img.height) // cover-fit the square
    const w = img.width * scale, h = img.height * scale
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The member avatar plus (when `canEdit`) a click-to-upload overlay and a remove control. */
function EditableAvatar({ member, canEdit, sizeClass, onChanged }: { member: Member; canEdit: boolean; sizeClass: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  if (!canEdit) return <MemberAvatar member={member} className={sizeClass} />
  const pick = async (file?: File | null) => {
    if (!file) return
    setBusy(true); setErr('')
    try {
      const r = await api.setAvatar(member.id, await fileToAvatarDataUrl(file))
      if ('error' in r && r.error) setErr(r.error); else onChanged()
    } catch { setErr('could not read that image') } finally { setBusy(false) }
  }
  const clear = async () => { setBusy(true); setErr(''); try { await api.clearAvatar(member.id); onChanged() } finally { setBusy(false) } }
  return (
    <div className="group relative" title={err || 'Change photo'}>
      <button type="button" className="block rounded-full disabled:cursor-default" onClick={() => inputRef.current?.click()} disabled={busy}>
        <MemberAvatar member={member} className={`${sizeClass} ${busy ? 'opacity-50' : ''} cursor-pointer`} />
        <span className="pointer-events-none absolute inset-0 grid place-items-center rounded-full bg-black/40 opacity-0 transition group-hover:opacity-100">
          <Camera className="h-3.5 w-3.5 text-white" />
        </span>
      </button>
      {member.avatar && (
        <button type="button" title="Remove photo" onClick={clear} disabled={busy}
          className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full border border-background bg-muted text-foreground/70 hover:text-destructive">
          <X className="h-2.5 w-2.5" />
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}

/** Resolve a "principal" string to a loaded member so its avatar can be shown. Sessions carry a raw
 *  member id (`runAs`); approvals/questions store the resolver's email (`resolvedBy`/`answeredBy`) — so
 *  match on id OR email. Returns undefined for non-member principals (agent:/automation:/task:/chat:/
 *  system) or anything not in the loaded list, in which case callers render text only. */
function memberOfPrincipal(id: string | undefined, members: Member[]): Member | undefined {
  if (!id || /^(agent|automation|task|chat):/.test(id) || id === 'system') return undefined
  return members.find((m) => m.id === id) || members.find((m) => m.email === id)
}

/** A person as a tiny avatar + text. Falls back to text only (no avatar) when the principal doesn't
 *  resolve to a loaded member, so nothing regresses for automations or before members load. */
function PrincipalTag({ id, label, members, avatarClass = 'h-3.5 w-3.5 text-[8px]' }: { id?: string; label?: string; members: Member[]; avatarClass?: string }) {
  const mem = memberOfPrincipal(id, members)
  const text = label ?? (mem ? mem.name || mem.email : id) ?? ''
  return <>{mem && <MemberAvatar member={mem} className={`${avatarClass} shrink-0`} />}{text}</>
}

/** Prefill the spawn box with the agent's first starter prompt, if it defines any. Otherwise the box
 *  starts empty and shows its "Describe the task…" placeholder — no generic filler. */
const exampleTask = (a?: AgentInfo): string => a?.examplePrompts?.[0] ?? ''
// Agents-page persistence (localStorage): the last agent you picked + a per-agent draft of the task
// box, so a refresh (or an accidental one) restores your place instead of resetting to defaults.
const LAST_AGENT_KEY = 'aos_last_agent'
const taskDraftKey = (agentId: string) => `aos_task_draft:${agentId}`
// Which agent-chooser layout the user prefers: a card gallery ('grid') or a list-rail + detail
// ('split'). Persisted so it sticks across visits; defaults to the compact list-rail split view.
const AGENTS_VIEW_KEY = 'aos_agents_view'
type AgentsView = 'grid' | 'split'

/** Bucket agents by their category label for the grouped picker. Uncategorised agents fall into a
 *  trailing "Uncategorized" group; named categories sort alphabetically, each group keeping list order. */
function groupByCategory(agents: AgentInfo[]): [string, AgentInfo[]][] {
  const UNCATEGORIZED = 'Uncategorized'
  const buckets = new Map<string, AgentInfo[]>()
  for (const a of agents) {
    const cat = a.category?.trim() || UNCATEGORIZED
    ;(buckets.get(cat) ?? buckets.set(cat, []).get(cat)!).push(a)
  }
  return [...buckets.entries()].sort(([a], [b]) => {
    if (a === UNCATEGORIZED) return 1
    if (b === UNCATEGORIZED) return -1
    return a.localeCompare(b)
  })
}

function RuntimeBadge({ runtime }: { runtime: AgentInfo['runtime'] }) {
  const claude = runtime === 'claude-code'
  return (
    <Badge variant={claude ? 'default' : 'secondary'} className="px-1.5 py-0 text-[10px] font-normal">
      {claude ? 'claude' : 'mock'}
    </Badge>
  )
}

/** Compact fleet-wide trust signal on an agent chip — the maturity score (0–100), coloured by band.
 *  Renders nothing until the agent has run (confidence 'none'), so an unproven agent isn't badged. */
function MaturityBadge({ s, className = '' }: { s?: AgentStats; className?: string }) {
  if (!s || s.confidence === 'none' || s.runs.total === 0) return null
  const m = Math.round(s.maturity * 100)
  const tone = s.maturity >= 0.66 ? 'text-emerald-600 border-emerald-500/40 dark:text-emerald-500' : s.maturity >= 0.33 ? 'text-amber-600 border-amber-500/40 dark:text-amber-500' : 'text-rose-600 border-rose-500/40 dark:text-rose-500'
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 py-0 text-[10px] font-medium tabular-nums ${tone} ${className}`}
      title={`maturity ${m}/100 · ${s.runs.total} run${s.runs.total === 1 ? '' : 's'} · ${Math.round(s.autonomy * 100)}% autonomous · ${s.confidence} confidence — trust to run with less oversight`}>
      <Shield className="h-2.5 w-2.5" /> {m}
    </span>
  )
}

/** Marks an agent that ships with Agent OS (a department generalist, the agent-author, the
 *  consolidator) so the chooser makes clear it's built-in rather than one the team authored. */
function BuiltInBadge() {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
      built-in
    </Badge>
  )
}

/** The curated built-in icon library — a lucide subset picked for agent roles. The key is stored in
 *  the manifest's `icon` field verbatim; the value is the component. Unknown/absent keys fall back to
 *  the default glyph (Bot) in AgentIcon, so the list can grow without breaking old manifests. */
const AGENT_ICONS: Record<string, LucideIcon> = {
  Bot, Sparkles, Wand2, Brain, Rocket, Zap, Boxes, Package,
  Code2, Bug, Terminal, GitBranch, Server, Database, Cloud, Cog, Wrench,
  Shield, Search, Compass, Globe, Activity, LineChart, BarChart3,
  MessageSquare, Mail, Megaphone, Send, Headphones, Users, Bell,
  FileText, ScrollText, BookText, BookOpen, PenTool, Feather, ListChecks, Calendar,
  DollarSign, ShoppingCart, Building2, Flag, Star, Heart, Palette, Camera, Music,
}
const ICON_NAMES = Object.keys(AGENT_ICONS)
const isCustomSvg = (v?: string) => !!v && /^\s*<svg[\s>]/i.test(v)

/** Renders an agent's icon: a custom uploaded SVG (via an `<img>` data-URI, so any embedded script is
 *  inert), a built-in library glyph, or — when unset/unknown — the default Bot. */
function AgentIcon({ icon, className }: { icon?: string; className?: string }) {
  if (isCustomSvg(icon)) {
    return <img src={'data:image/svg+xml,' + encodeURIComponent(icon!)} alt="" aria-hidden className={className} />
  }
  const Cmp = (icon && AGENT_ICONS[icon]) || Bot
  return <Cmp className={className} />
}

const MAX_SVG_BYTES = 20000 // mirrors the server-side cap in sanitizeSvgIcon

/** Icon chooser used by the create + edit forms: a preview, an SVG upload button, and the library
 *  grid. `value` is a library name or raw SVG; `onChange(undefined)` clears back to the default. */
function IconPicker({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState('')
  const custom = isCustomSvg(value)

  const onFile = async (f: File) => {
    setErr('')
    if (f.size > MAX_SVG_BYTES) return setErr(`SVG too large (max ${Math.round(MAX_SVG_BYTES / 1000)} KB)`)
    const text = await f.text()
    if (!/^\s*<svg[\s>]/i.test(text)) return setErr('not an SVG file')
    onChange(text)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <AgentIcon icon={value} className="h-5 w-5 text-foreground" />
        </div>
        <span className="text-[11px] text-muted-foreground">{custom ? 'Custom SVG' : (value || 'Default')}</span>
        <div className="ml-auto flex items-center gap-1">
          <input ref={fileRef} type="file" accept=".svg,image/svg+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
          <Button type="button" size="sm" variant="outline" className="gap-1" onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" /> Upload SVG</Button>
          {value && <Button type="button" size="sm" variant="ghost" onClick={() => { setErr(''); onChange(undefined) }}>Clear</Button>}
        </div>
      </div>
      {err && <p className="text-[11px] text-destructive">{err}</p>}
      <div className="grid grid-cols-12 gap-1">
        {ICON_NAMES.map((name) => {
          const Cmp = AGENT_ICONS[name]
          const active = value === name
          return (
            <button
              key={name}
              type="button"
              title={name}
              onClick={() => onChange(name)}
              className={'flex h-8 w-full items-center justify-center rounded-md border ' + (active ? 'border-primary bg-primary/10 text-primary' : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground')}
            >
              <Cmp className="h-4 w-4" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The model / effort / permission-mode trio, reused by the create form, the agent editor, and the
 *  workspace defaults panel. Empty model/effort = "inherit" (the placeholder/option says so). Model +
 *  effort map 1:1 to `claude --model/--effort`; permissionMode maps to `--permission-mode` on the
 *  INTERACTIVE lane only and its blank/floor is `auto` (the gate hook governs every side effect
 *  regardless of the mode — it only tunes the fallback for tools the hook leaves alone). */
function TuningFields({ tuning, onChange, modelPlaceholder = 'inherit', inheritLabel = 'inherit', permInheritLabel }: {
  tuning: RuntimeTuning
  onChange: (t: RuntimeTuning) => void
  modelPlaceholder?: string
  inheritLabel?: string
  permInheritLabel?: string
}) {
  const selCls = 'h-8 w-full rounded-md border bg-background px-2 text-xs'
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <label className="text-xs font-medium">Model</label>
        <Input value={tuning.model ?? ''} onChange={(e) => onChange({ ...tuning, model: e.target.value || undefined })} placeholder={modelPlaceholder} className="h-8 font-mono text-xs" />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Effort</label>
        <select className={selCls} value={tuning.effort ?? ''} onChange={(e) => onChange({ ...tuning, effort: (e.target.value || undefined) as Effort | undefined })}>
          <option value="">{inheritLabel}</option>
          {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium">Permission mode</label>
        <select className={selCls} value={tuning.permissionMode ?? ''} onChange={(e) => onChange({ ...tuning, permissionMode: (e.target.value || undefined) as PermissionMode | undefined })}>
          <option value="">{permInheritLabel ?? inheritLabel}</option>
          {PERMISSION_MODES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <p className="text-[11px] text-muted-foreground">Interactive only — headless stays fully skipped. The gate hook governs regardless.</p>
      </div>
    </div>
  )
}

/** Minimal hash router — `#/<page>` with an optional detail segment (`#/sessions/<tmux>`) so a
 *  deep-linked view (an open terminal, later other pages' selections) survives a refresh and
 *  back/forward. The detail is everything after the first slash, URL-decoded. No dependency. */
function useHashRoute(): { route: Route; detail: string; query: string; nav: (r: Route, detail?: string) => void; setQuery: (params: Record<string, string>) => void } {
  const parse = () => {
    // Strip an optional `?query` BEFORE splitting route/detail, so page state carried in the query
    // (e.g. the sessions filters) never leaks into the route head and mis-routes to the fallback.
    const raw = window.location.hash.replace(/^#\/?/, '')
    const qIdx = raw.indexOf('?')
    const path = qIdx === -1 ? raw : raw.slice(0, qIdx)
    const query = qIdx === -1 ? '' : raw.slice(qIdx + 1)
    const slash = path.indexOf('/')
    const head = slash === -1 ? path : path.slice(0, slash)
    const rest = slash === -1 ? '' : path.slice(slash + 1)
    const route = (ROUTES as string[]).includes(head) ? (head as Route) : 'inbox'
    return { route, detail: rest ? decodeDetail(rest) : '', query }
  }
  const [state, setState] = useState(parse)
  useEffect(() => {
    const on = () => setState(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const hashFor = (r: Route, detail?: string, query?: string) =>
    '/' + r + (detail ? '/' + encodeDetail(detail) : '') + (query ? '?' + query : '')
  const nav = (r: Route, detail?: string) => {
    // Preserve the query only within the same route (so opening/closing a session's terminal keeps
    // the active filters); switching pages drops it.
    const cur = parse()
    window.location.hash = hashFor(r, detail, r === cur.route ? cur.query : '')
  }
  // Replace the query part in place (no history entry per keystroke), keeping route + detail.
  const setQuery = (params: Record<string, string>) => {
    const cur = parse()
    const qs = new URLSearchParams(params).toString()
    if (qs === cur.query) return
    history.replaceState(null, '', window.location.pathname + window.location.search + '#' + hashFor(cur.route, cur.detail, qs))
    setState(parse())
  }
  return { route: state.route, detail: state.detail, query: state.query, nav, setQuery }
}

/** Build an in-app hash href (`#/agents/<id>`) so a navigation element can be a real anchor —
 *  which is the ONLY thing that gives the browser its native link affordances: right-click
 *  "open in new tab", ⌘/ctrl/middle-click, shift-click-new-window, and hover URL preview.
 *  Mirrors `hashFor` but always `#`-prefixed and without query (a new tab is a fresh context,
 *  so page-local state like filters is intentionally dropped). */
function navHref(r: Route, detail?: string): string {
  return '#/' + r + (detail ? '/' + encodeDetail(detail) : '')
}

/** A route `detail` may be a '/'-separated path — KB `section/slug` (with a NESTED section like
 *  `engineering/backend/deploy-runbook`) or Files `agents/<name>`. Encode/decode PER SEGMENT so real
 *  slashes stay readable in the URL (`#/kb/engineering/backend/deploy-runbook`) while special chars
 *  inside a segment are still escaped. Back-compat: an old whole-encoded `%2F` URL still decodes right
 *  — a segment carrying no literal '/' round-trips either way. */
function encodeDetail(detail: string): string {
  return detail.split('/').map(encodeURIComponent).join('/')
}
function decodeDetail(raw: string): string {
  try { return raw.split('/').map(decodeURIComponent).join('/') } catch { return raw }
}

/** Wrap a nav callback for use as an anchor's onClick: a plain left-click routes in place (via
 *  the callback, which keeps `nav()`'s query-preservation semantics), while ⌘/ctrl/shift/alt/
 *  middle-click fall through to the browser so the href opens in a new tab/window. Spread the
 *  returned handler onto an <a> that also carries the matching `navHref(...)`. */
function onNavClick(go: () => void) {
  return (e: ReactMouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    go()
  }
}

export default function App() {
  // undefined = checking, null = not logged in (show Login), Member = authed.
  const [me, setMe] = useState<Member | null | undefined>(undefined)
  const [accent, setAccent] = useState<string | undefined>(undefined)
  useEffect(() => {
    api.me().then(setMe)
  }, [])
  // Per-tenant branding — fetched from the PUBLIC endpoint so it themes the login screen + tab favicon
  // before any session exists. Runs once on mount, independent of auth.
  useEffect(() => {
    fetch('/api/branding')
      .then((r) => r.json() as Promise<PublicBranding>)
      .then((b) => {
        applyAccent(b.accentColor)
        applyFavicon(faviconDataUri(b.accentColor, b.badge, b.tenantName))
        setAccent(b.accentColor)
      })
      .catch(() => {})
  }, [])

  if (me === undefined) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
  if (me === null) return <LoginScreen accent={accent} />
  return <Console me={me} />
}

/** The per-session "Claude is waiting on you" indicator (shown in the sidebar + session lists).
 * `tone` picks the icon colour: the default indigo-600 reads on the light sidebar/list, but on the
 * dark terminal tab strip (bg-neutral-900/700) it's near-invisible — pass a lighter tone there. */
function WaitingBell({ className = 'h-3.5 w-3.5', tone = 'text-indigo-600' }: { className?: string; tone?: string }) {
  return (
    <span title="Claude is waiting for your input" className={`inline-flex shrink-0 ${tone}`}>
      <Bell className={className} />
    </span>
  )
}

/**
 * Self-update notice — polls `/api/update` (a cached `git fetch` behind the scenes) and, when the
 * checkout is behind origin, shows a pill in the sidebar. Clicking opens a panel with the changelog
 * preview and, for the owner, an "Update & restart" button that pulls + rebuilds + bounces the box;
 * the panel then waits for `/health` to report the new version and reloads the console.
 */
function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<UpdateApplyResult | null>(null)
  const [restarting, setRestarting] = useState(false)

  const check = (force = false) => api.checkUpdate(force).then(setStatus).catch(() => {})
  useEffect(() => {
    check()
    const t = setInterval(() => check(), 30 * 60_000) // re-poll every 30 min; the server caches the fetch
    return () => clearInterval(t)
  }, [])

  if (!status?.updateAvailable) return null

  const apply = async () => {
    setApplying(true); setResult(null)
    const r = await api.applyUpdate()
    setResult(r); setApplying(false)
    if (r.ok && r.restarting) {
      setRestarting(true)
      const started = Date.now()
      const tick = async () => {
        try {
          const h = await fetch('/health').then((x) => x.json())
          if (h?.version && h.version !== status.current) { window.location.reload(); return }
        } catch { /* server bouncing — keep waiting */ }
        if (Date.now() - started > 120_000) { window.location.reload(); return }
        setTimeout(tick, 3000)
      }
      setTimeout(tick, 5000)
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mt-1.5 flex w-full items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-left text-[11px] font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20"
        title={`Update available: v${status.latest} (${status.behind} commit${status.behind === 1 ? '' : 's'} behind)`}
      >
        <Download className="h-3 w-3 shrink-0" />
        <span className="truncate">Update available · v{status.latest}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !applying && !restarting && setOpen(false)}>
          <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <CardContent className="space-y-3 p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold"><Download className="h-4 w-4" /> Software update</div>
                {!applying && !restarting && (
                  <Button size="icon" variant="ghost" className="-mr-1 -mt-1 h-6 w-6 text-muted-foreground" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
                )}
              </div>

              <div className="text-xs text-muted-foreground">
                <span className="font-mono">v{status.current}</span> → <span className="font-mono font-semibold text-foreground">v{status.latest}</span>
                <span className="ml-1">· {status.behind} commit{status.behind === 1 ? '' : 's'} behind <span className="font-mono">{status.upstream}</span></span>
              </div>

              {status.log.length > 0 && !result && (
                <div className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-2">
                  <ul className="space-y-0.5 text-[11px] leading-snug text-muted-foreground">
                    {status.log.map((s, i) => <li key={i} className="truncate" title={s}>· {s}</li>)}
                  </ul>
                </div>
              )}

              {status.dirty && !result && (
                <div className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-[11px] text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>The box has uncommitted changes — commit or stash them before updating (a fast-forward pull can't run otherwise).</span>
                </div>
              )}

              {result && (
                <div className="max-h-64 space-y-1.5 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
                  {result.steps.map((s, i) => (
                    <div key={i}>
                      <div className={s.ok ? 'text-emerald-600' : 'text-red-600'}>{s.ok ? '✓' : '✗'} {s.cmd}</div>
                      {!s.ok && s.out && <pre className="mt-0.5 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">{s.out}</pre>}
                    </div>
                  ))}
                  {result.error && <div className="text-red-600">✗ {result.error}</div>}
                </div>
              )}

              {restarting ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Restarting the server… the console will reconnect automatically.</div>
              ) : (
                <div className="flex items-center justify-end gap-2">
                  {status.canApply ? (
                    <Button size="sm" disabled={applying || status.dirty} onClick={apply}>
                      {applying ? <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Updating…</> : <><Download className="mr-1.5 h-3.5 w-3.5" /> Update & restart</>}
                    </Button>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">Ask an owner to apply this update.</span>
                  )}
                </div>
              )}
              {applying && !result && (
                <div className="text-[11px] text-muted-foreground">Running <span className="font-mono">git pull</span> + rebuild + restart — this takes 1–3 minutes. Keep this tab open.</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}

function Console({ me }: { me: Member }) {
  const [state, setState] = useState<StateResp | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  // Tabs the user "closed" from the terminal switcher: hidden from the strip, but the session keeps
  // running — reopen it from All sessions. Persisted so a refresh doesn't resurrect closed tabs.
  const [hiddenTabs, setHiddenTabs] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('aos_hidden_tabs') || '[]') as string[]) } catch { return new Set() }
  })
  const persistHiddenTabs = (next: Set<string>) => {
    localStorage.setItem('aos_hidden_tabs', JSON.stringify([...next]))
    setHiddenTabs(next)
  }
  const [messages, setMessages] = useState<Msg[]>([])
  // Latest messages reachable from imperative event handlers (the terminal's click listener) without
  // re-binding them every render / going stale on the captured `messages`.
  const messagesRef = useRef<Msg[]>([])
  messagesRef.current = messages
  const { route, detail, query: urlQuery, nav, setQuery: setUrlQuery } = useHashRoute()
  // The open terminal is a URL detail (`#/sessions/<tmux>`), not local state, so a refresh /
  // back-forward reopens the same session. Title is best-effort from the loaded list (falls back to
  // the tmux for a link opened before the sessions have loaded).
  const selected: Selected =
    route === 'sessions' && detail
      ? { tmux: detail, title: sessions.find((s) => s.tmux === detail)?.title ?? detail }
      : null
  // The agent being edited is a URL detail (`#/agent/<id>`) so the editor survives a refresh instead
  // of falling back to a blank page.
  const editAgent = route === 'agent' ? detail : ''

  // Secondary "Manage" nav is collapsed by default so the Agents list stays high; it auto-opens
  // when you're on one of its pages.
  const manageRoutes: Route[] = ['automations', 'memory', 'skills', 'connectors', 'team', 'files', 'settings', 'docs']
  const onManage = manageRoutes.includes(route)
  const [manageOpen, setManageOpen] = useState(onManage)
  useEffect(() => { if (onManage) setManageOpen(true) }, [onManage])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('aos_sidebar_collapsed') === '1')
  // Sidebar session list: ended runs collapse behind a toggle so live work stays at the top.
  const [showEndedNav, setShowEndedNav] = useState(false)
  useEffect(() => { localStorage.setItem('aos_sidebar_collapsed', sidebarCollapsed ? '1' : '0') }, [sidebarCollapsed])

  useEffect(() => {
    api.state().then(setState)
  }, [])

  useEffect(() => {
    const poll = async () => {
      setSessions(await api.sessions())
      setMessages(await api.messages())
    }
    poll()
    const t = setInterval(poll, 1500)
    return () => clearInterval(t)
  }, [])

  // Browser-tab badge: a 🔔 + count of sessions where Claude is waiting on you (one open
  // notification per session), so the tab nags even when the console isn't focused. The tenant
  // name leads the title so several instances are distinguishable across browser tabs.
  useEffect(() => {
    const n = messages.filter((m) => m.type === 'notification' && m.status === 'open').length
    const base = `${state?.tenantName || state?.tenant ? `${state.tenantName || state.tenant} · ` : ''}Agent OS`
    document.title = n > 0 ? `🔔 (${n}) ${base}` : base
  }, [messages, state?.tenantName, state?.tenant])

  const refreshState = () => api.state().then(setState)
  // Team roster (with avatars) for attributing people across pages — the "run as" facet on a session
  // and the "resolved/answered by" line in the inbox. Loaded once; a member without a picture shows
  // their initial via MemberAvatar, so this only ever adds, never regresses.
  const [members, setMembers] = useState<Member[]>([])
  useEffect(() => { api.team().then((r) => setMembers(r.members ?? [])).catch(() => {}) }, [])
  const deleteAgent = async (id: string, builtIn?: boolean) => {
    const note = builtIn
      ? ` This is a built-in agent — you can re-add it later from the agent library.`
      : ''
    if (!confirm(`Delete agent "${id}"? Its folder (agent.json + CLAUDE.md) is permanently removed. Its memory and audit history are kept.${note}`)) return
    const r = await api.deleteAgent(id)
    if (r.error) { alert(r.error); return }
    await refreshState()
  }
  const duplicateAgent = async (id: string) => {
    const newId = prompt(`Duplicate "${id}" as a new agent. Enter an id for the copy:`, `${id}-copy`)
    if (newId == null) return
    const r = await api.duplicateAgent(id, newId.trim().toLowerCase())
    if (r.error || !r.id) { alert(r.error ?? 'could not duplicate agent'); return }
    await refreshState()
    openAgent(r.id) // jump into the clone's settings to tweak it
  }
  const openAgent = (id: string) => nav('agent', id)
  // Sync the registry with the agents folder on disk — picks up folders added/edited/removed
  // outside the console (git pull, scp, another agent) without a server restart.
  const rescanAgents = async () => {
    const r = await api.rescanAgents()
    if (r.error) { alert(r.error); return }
    await refreshState()
    const parts: string[] = []
    if (r.added.length) parts.push(`Added: ${r.added.join(', ')}`)
    if (r.updated.length) parts.push(`Updated: ${r.updated.join(', ')}`)
    if (r.removed.length) parts.push(`Removed: ${r.removed.join(', ')}`)
    if (r.errors.length) parts.push(`Skipped (bad agent.json): ${r.errors.map((e) => e.folder).join(', ')}`)
    alert(parts.length ? parts.join('\n') : 'No changes — the agents folder already matches.')
  }
  // Import an agent from an "AOS bundle" .zip (see the Docs → "Import into AOS" page): writes the agent
  // and replays its memory/knowledge/skills in one shot, then lands on the new agent.
  const importAgent = async (file: File): Promise<void> => {
    const r = await api.importAgentBundle(file)
    if (!r.ok || r.error) { alert(r.error || 'Import failed'); return }
    await refreshState()
    if (r.id) nav('agents', r.id)
    const bits = [`Imported "${r.id}"`, `${r.skills ?? 0} skill(s), ${r.memories ?? 0} memory(ies), ${r.knowledge ?? 0} KB page(s)`]
    if (r.warnings?.length) bits.push('', 'Warnings:', ...r.warnings.map((w) => '• ' + w))
    alert(bits.join('\n'))
  }
  // Attending to a session → clear its "waiting" bell, same as Dismiss. Optimistically drop the open
  // notifications from state so the icon/tab/badge update instantly; persist via dismiss. Reads the
  // latest messages from the ref so it's safe to call from the terminal's imperative click listener.
  const clearAlerts = (sid: string) => {
    const toClear = messagesRef.current.filter((m) => m.type === 'notification' && m.status === 'open' && m.sessionId === sid)
    if (toClear.length === 0) return
    setMessages((ms) => ms.filter((m) => !toClear.some((c) => c.id === m.id)))
    toClear.forEach((m) => { void api.dismissMessage(m.id) })
  }
  const openTerminal = (tmux: string, _title?: string) => {
    // The tmux lands in the URL (`#/sessions/<tmux>`); `selected` is derived from it above.
    nav('sessions', tmux)
    // Reopening a previously-closed tab brings it back to the strip.
    if (hiddenTabs.has(tmux)) { const n = new Set(hiddenTabs); n.delete(tmux); persistHiddenTabs(n) }
    // Opening a session means you're attending to it → clear its bell.
    clearAlerts(tmux.replace(/^aos-/, ''))
  }
  // "Close tab" — hide it from the switcher strip without touching the running session. If the open
  // one is closed, fall back to another visible live tab, else drop to the sessions list.
  const closeTab = (tmux: string) => {
    const n = new Set(hiddenTabs); n.add(tmux); persistHiddenTabs(n)
    if (selected?.tmux === tmux) {
      const next = sessions.find((s) => isLive(s) && s.tmux !== tmux && !n.has(s.tmux))
      if (next) nav('sessions', next.tmux)
      else nav('sessions')
    }
  }
  // Deep-link from an inbox 'artifact' card into the gallery, pre-opening that artifact's preview.
  const openArtifact = (id: string) => nav('artifacts', id)
  const stopSession = async (id: string) => {
    await api.stopSession(id)
    setSessions(await api.sessions())
  }
  // Human verdict on a finished run — feeds the agent maturity score. Clicking the active thumb clears it.
  const rateSession = async (id: string, rating: 'up' | 'down' | null) => {
    await api.rateSession(id, rating)
    setSessions(await api.sessions())
  }
  const deleteSession = async (id: string, tmux: string) => {
    if (!confirm('Delete this session? Its inbox messages and transcript files are removed; the audit log is kept.')) return
    await api.deleteSession(id)
    if (selected?.tmux === tmux) nav('sessions')
    setSessions(await api.sessions())
  }
  // Bulk variants for the Sessions list — stop/delete many in one go, single confirm, one refresh.
  const stopSessions = async (ids: string[]) => {
    if (ids.length === 0) return
    await Promise.all(ids.map((id) => api.stopSession(id)))
    setSessions(await api.sessions())
  }
  const deleteSessions = async (ids: string[]) => {
    if (ids.length === 0) return
    const n = ids.length
    if (!confirm(`Delete ${n} session${n === 1 ? '' : 's'}? Their inbox messages and transcript files are removed; the audit log is kept.`)) return
    const tmuxes = new Set(sessions.filter((s) => ids.includes(s.id)).map((s) => s.tmux))
    await Promise.all(ids.map((id) => api.deleteSession(id)))
    if (selected && tmuxes.has(selected.tmux)) nav('sessions')
    setSessions(await api.sessions())
  }
  // Spawn from an agent card on the Agents page; resolves to an error string, or null on success.
  const runAgent = async (agentId: string, task: string): Promise<string | null> => {
    if (!task.trim()) return 'enter a task'
    const r = await api.run(agentId, task)
    if (r.error) return r.error
    setSessions(await api.sessions())
    openTerminal(r.tmux, agentId + ' · ' + r.id)
    return null
  }

  const pendingApprovals = messages.filter(isActionRequired).length
  // Sessions where Claude is blocked waiting on the human — drives the per-session bell everywhere.
  const waiting = new Set(messages.filter((m) => m.type === 'notification' && m.status === 'open').map((m) => m.sessionId))
  const runningSessions = sessions.filter(isLive).length
  // The sidebar is a switcher over the sessions *I'm accountable for* — ones I started directly
  // (spawnedBy is my member id) OR ones a trigger spawned that run AS me (runAs): a Task I own that
  // auto-dispatched, a chat message I sent. Those have a `task:`/`automation:` provenance, so keying
  // only off spawnedBy hid them from their owner's sidebar. Running first, then newest first.
  const mySessions = sessions
    .filter((s) => s.spawnedBy === me.id || s.runAs === me.id)
    .sort((a, b) => {
      const rank = (s: Session) => (isLive(s) ? 0 : 1) // live first; all terminal (dead) states tie
      return rank(a) - rank(b) || b.createdAt - a.createdAt
    })
  // Sidebar split: live sessions always show; the open one shows even if ended; the rest of the ended
  // ones hide behind the "N ended" toggle so a pile of past runs doesn't push live work off-screen.
  const navLive = mySessions.filter(isLive)
  const navEnded = mySessions.filter((s) => !isLive(s))
  const selectedEndedNav = navEnded.find((s) => s.tmux === selected?.tmux)
  const collapsibleNav = navEnded.filter((s) => s.tmux !== selected?.tmux)
  const renderNavSession = (s: Session) => {
    const active = selected?.tmux === s.tmux && route === 'sessions'
    return (
      <a
        key={s.id}
        href={navHref('sessions', s.tmux)}
        onClick={onNavClick(() => openTerminal(s.tmux, s.agent + ' · ' + s.id))}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left no-underline text-foreground hover:bg-muted ${active ? 'bg-muted' : ''}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(s)}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`min-w-0 flex-1 truncate text-[13px] leading-tight ${active ? 'font-medium text-primary' : ''}`}>{s.title}</span>
            {waiting.has(s.id) && <WaitingBell className="h-3 w-3" />}
          </span>
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">{s.agent}</span>
        </span>
      </a>
    )
  }
  // A live terminal takes the whole content area (no padding/scroll wrapper).
  const fullBleed = route === 'sessions' && !!selected

  return (
    <div className="flex h-screen bg-muted/30 text-foreground">
      {sidebarCollapsed && (
        <aside className="relative flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-3">
          {/* Per-tenant accent strip — invisible until a tenant sets a brand colour (var(--brand)). */}
          <div className="absolute inset-x-0 top-0 h-1" style={{ background: 'var(--brand)' }} />
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" title="expand sidebar" onClick={() => setSidebarCollapsed(false)}>
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <div className="mt-1 text-base" title={state?.tenantName || state?.tenant || 'Agent OS'}>⚙️</div>
          <nav className="mt-2 flex flex-col items-center gap-1">
            <Button render={<a href={navHref('inbox')} />} size="icon" variant="ghost" className={`h-8 w-8 ${route === 'inbox' ? 'text-primary' : 'text-muted-foreground'}`} title="Inbox" onClick={onNavClick(() => nav('inbox'))}><InboxIcon className="h-4 w-4" /></Button>
            <Button render={<a href={navHref('agents')} />} size="icon" variant="ghost" className={`h-8 w-8 ${route === 'agents' || route === 'agent' ? 'text-primary' : 'text-muted-foreground'}`} title="Agents" onClick={onNavClick(() => nav('agents'))}><Bot className="h-4 w-4" /></Button>
            <Button render={<a href={navHref('tasks')} />} size="icon" variant="ghost" className={`h-8 w-8 ${route === 'tasks' ? 'text-primary' : 'text-muted-foreground'}`} title="Tasks" onClick={onNavClick(() => nav('tasks'))}><ListChecks className="h-4 w-4" /></Button>
            <Button render={<a href={navHref('artifacts')} />} size="icon" variant="ghost" className={`h-8 w-8 ${route === 'artifacts' ? 'text-primary' : 'text-muted-foreground'}`} title="Artifacts" onClick={onNavClick(() => nav('artifacts'))}><Package className="h-4 w-4" /></Button>
            <Button render={<a href={navHref('sessions')} />} size="icon" variant="ghost" className={`h-8 w-8 ${route === 'sessions' ? 'text-primary' : 'text-muted-foreground'}`} title="Sessions" onClick={onNavClick(() => nav('sessions'))}><TerminalSquare className="h-4 w-4" /></Button>
          </nav>
        </aside>
      )}
      <aside className={`${sidebarCollapsed ? 'hidden' : 'flex'} w-72 shrink-0 flex-col border-r bg-background`}>
        {/* Per-tenant accent strip — invisible until a tenant sets a brand colour (var(--brand)). */}
        <div className="h-1 shrink-0" style={{ background: 'var(--brand)' }} />
        {/* Top: brand + primary nav (fixed) */}
        <div className="p-4 pb-2">
          <div className="mb-4 flex items-start justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[15px] font-semibold">⚙️ Agent OS</div>
              {state && <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={`tenant${state.version ? ` · Agent OS v${state.version}` : ''}`}>{state.tenantName || state.tenant}{state.version ? ` · v${state.version}` : ''}</div>}
              <UpdateNotice />
            </div>
            <Button size="icon" variant="ghost" className="-mr-1 h-7 w-7 shrink-0 text-muted-foreground" title="collapse sidebar" onClick={() => setSidebarCollapsed(true)}>
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <nav className="space-y-1">
            <NavItem icon={<InboxIcon className="h-4 w-4" />} label="Inbox" active={route === 'inbox'} badge={pendingApprovals || undefined} href={navHref('inbox')} onClick={() => nav('inbox')} />
            <NavItem icon={<Bot className="h-4 w-4" />} label="Agents" active={route === 'agents' || route === 'agent'} href={navHref('agents')} onClick={() => nav('agents')} />
            <NavItem icon={<ListChecks className="h-4 w-4" />} label="Tasks" active={route === 'tasks'} href={navHref('tasks')} onClick={() => nav('tasks')} />
            <NavItem icon={<Package className="h-4 w-4" />} label="Artifacts" active={route === 'artifacts'} href={navHref('artifacts')} onClick={() => nav('artifacts')} />
          </nav>
        </div>

        {/* Middle: my sessions — the working surface, a flat running-first switcher. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Sessions</span>
            <div className="flex items-center gap-1">
              <a
                href={navHref('sessions')}
                onClick={onNavClick(() => nav('sessions'))}
                className={`flex items-center gap-1 text-[11px] uppercase tracking-wider no-underline hover:text-foreground ${route === 'sessions' ? 'text-primary' : 'text-muted-foreground'}`}
                title="all sessions"
              >
                All{runningSessions ? <span className="rounded-full bg-emerald-500/15 px-1 text-[10px] font-medium text-emerald-600">{runningSessions}</span> : null}
              </a>
              <Button render={<a href={navHref('agents')} />} size="icon" variant="ghost" className="h-5 w-5 text-emerald-600" onClick={onNavClick(() => nav('agents'))} title="spawn an agent"><Plus className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          {mySessions.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No sessions yet. <a href={navHref('agents')} className="text-primary underline" onClick={onNavClick(() => nav('agents'))}>Spawn an agent</a>.
            </div>
          )}
          <div className="space-y-0.5">
            {navLive.map(renderNavSession)}
            {selectedEndedNav && renderNavSession(selectedEndedNav)}
            {showEndedNav && collapsibleNav.map(renderNavSession)}
            {collapsibleNav.length > 0 && (
              <button
                onClick={() => setShowEndedNav((v) => !v)}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                title={showEndedNav ? 'hide ended sessions' : 'show stopped/ended sessions'}
              >
                <ChevronDown className={`h-3 w-3 transition-transform ${showEndedNav ? '' : '-rotate-90'}`} />
                {showEndedNav ? 'hide ended' : `${collapsibleNav.length} ended`}
              </button>
            )}
          </div>
        </div>

        {/* Bottom: collapsible Manage group + profile (fixed) */}
        <div className="border-t p-4 pt-3">
          <button
            onClick={() => setManageOpen((o) => !o)}
            className={`mb-1 flex w-full items-center gap-1.5 text-[11px] uppercase tracking-wider hover:text-foreground ${onManage && !manageOpen ? 'text-primary' : 'text-muted-foreground'}`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Manage</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${manageOpen ? '' : '-rotate-90'}`} />
          </button>
          {manageOpen && (
            <nav className="mb-1 space-y-1">
              <NavItem icon={<Zap className="h-4 w-4" />} label="Automations" active={route === 'automations'} href={navHref('automations')} onClick={() => nav('automations')} />
              <NavItem icon={<BookText className="h-4 w-4" />} label="Knowledge" active={route === 'kb'} href={navHref('kb')} onClick={() => nav('kb')} />
              <NavItem icon={<Brain className="h-4 w-4" />} label="Memory" active={route === 'memory'} href={navHref('memory')} onClick={() => nav('memory')} />
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<Sparkles className="h-4 w-4" />} label="Skills" active={route === 'skills'} href={navHref('skills')} onClick={() => nav('skills')} />
              )}
              <NavItem icon={<Plug className="h-4 w-4" />} label="Connections" active={route === 'connectors'} href={navHref('connectors')} onClick={() => nav('connectors')} />
              <NavItem icon={<Users className="h-4 w-4" />} label="Team" active={route === 'team'} href={navHref('team')} onClick={() => nav('team')} />
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<FolderTree className="h-4 w-4" />} label="Files" active={route === 'files'} href={navHref('files')} onClick={() => nav('files')} />
              )}
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<ScrollText className="h-4 w-4" />} label="Audit" active={route === 'audit'} href={navHref('audit')} onClick={() => nav('audit')} />
              )}
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<Building2 className="h-4 w-4" />} label="Settings" active={route === 'settings'} href={navHref('settings')} onClick={() => nav('settings')} />
              )}
              <NavItem icon={<BookOpen className="h-4 w-4" />} label="Docs" active={route === 'docs'} href={navHref('docs')} onClick={() => nav('docs')} />
            </nav>
          )}

          <Separator className="my-3" />
          <div className="flex items-center justify-between">
            <a href={navHref('team')} className="flex min-w-0 items-center gap-2 text-left text-foreground no-underline hover:underline" onClick={onNavClick(() => nav('team'))} title="manage team">
              <MemberAvatar member={state?.me ?? me} className="h-7 w-7 text-xs" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium leading-tight">
                  <span className="truncate">{me.name}</span>
                  <RoleBadge role={me.role} />
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{me.email}</span>
              </span>
            </a>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="log out" onClick={async () => { await api.logout(); window.location.reload() }}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-3">
          {route === 'sessions' && selected ? (
            /* Open session: a compact title over its facts row, so the facts read as a subline rather
               than crowding the terminal tab strip or the header's right edge. */
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-3">
                <h1 className="max-w-[60vw] truncate text-sm font-semibold">{selected.title}</h1>
                <Button render={<a href={navHref('sessions')} />} size="sm" variant="outline" className="h-6 gap-1 px-2 text-xs" onClick={onNavClick(() => nav('sessions'))} title="back to the full sessions list">
                  <ArrowLeft className="h-3.5 w-3.5" /> All sessions
                </Button>
              </div>
              <SessionFacts session={sessions.find((s) => s.tmux === selected.tmux)} members={members} />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="max-w-[60vw] truncate text-lg font-semibold">
                {route === 'inbox' ? 'Inbox' : route === 'sessions' ? 'Sessions' : route === 'connectors' ? 'Connections' : route === 'team' ? 'Team' : route === 'automations' ? 'Automations' : route === 'tasks' ? 'Tasks' : route === 'memory' ? 'Memory' : route === 'kb' ? 'Knowledge Base' : route === 'skills' ? 'Skills' : route === 'files' ? 'Files' : route === 'artifacts' ? 'Artifacts' : route === 'audit' ? 'Audit log' : route === 'settings' ? 'Company settings' : route === 'docs' ? 'Docs' : route === 'new-agent' ? 'New agent' : route === 'agent' ? `Agent · ${editAgent}` : 'Agents'}
              </h1>
            </div>
          )}
        </div>

        <div className={`min-h-0 flex-1 ${fullBleed ? '' : 'overflow-y-auto p-6'}`}>
          {route === 'agents' && <AgentsPage me={me} agents={state?.agents ?? []} selected={detail} onSelect={(id) => nav('agents', id)} run={runAgent} onEdit={openAgent} onNew={() => nav('new-agent')} onDelete={deleteAgent} onDuplicate={duplicateAgent} onRescan={rescanAgents} onImport={importAgent} onRefresh={refreshState} />}
          {route === 'new-agent' && <NewAgentPage me={me} onCreated={async (id) => { await refreshState(); nav('agents', id) }} />}
          {route === 'sessions' && <SessionsPage me={me} members={members} sessions={sessions} waiting={waiting} selected={selected} hiddenTabs={hiddenTabs} onOpen={openTerminal} onCloseTab={closeTab} onActivity={clearAlerts} onSpawn={() => nav('agents')} onStop={stopSession} onDelete={deleteSession} onRate={rateSession} onBulkStop={stopSessions} onBulkDelete={deleteSessions} urlQuery={urlQuery} onFiltersChange={setUrlQuery} />}
          {route === 'inbox' && <InboxPage messages={messages} me={me} members={members} onOpen={openTerminal} onOpenArtifact={openArtifact} onOpenTask={(id) => nav('tasks', id)} />}
          {route === 'connectors' && <ConnectionsPage me={me} tab={detail} onTab={(t) => nav('connectors', t)} />}
          {route === 'team' && <TeamPage me={me} onProfileChange={refreshState} />}
          {route === 'automations' && <AutomationsPage me={me} agents={state?.agents ?? []} serverTz={state?.serverTz} onOpen={openTerminal} nav={nav} />}
          {route === 'tasks' && <TasksPage me={me} agents={state?.agents ?? []} taskId={detail} onOpen={openTerminal} nav={nav} />}
          {route === 'memory' && <MemoryPage agents={state?.agents ?? []} me={me} />}
          {route === 'kb' && <KnowledgeBasePage me={me} permalink={detail} nav={nav} />}
          {route === 'skills' && <SkillsPage />}
          {route === 'files' && <FilesPage initialDir={detail} />}
          {route === 'artifacts' && <ArtifactsPage me={me} permalink={detail} nav={nav} />}
          {route === 'audit' && <AuditPage />}
          {route === 'docs' && <DocsPage selected={detail} onSelect={(slug) => nav('docs', slug)} />}
          {route === 'settings' && <SettingsPage me={me} state={state} tab={detail} onTab={(t) => nav('settings', t)} />}
          {route === 'agent' && editAgent && <AgentPage agentId={editAgent} agents={state?.agents ?? []} onSaved={refreshState} />}
        </div>
      </main>
    </div>
  )
}

function NavItem({ icon, label, active, badge, href, onClick }: { icon: ReactNode; label: string; active: boolean; badge?: number; href: string; onClick: () => void }) {
  return (
    <a
      href={href}
      onClick={onNavClick(onClick)}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm no-underline hover:bg-muted ${active ? 'bg-muted font-medium text-primary' : 'text-foreground'}`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{badge}</Badge> : null}
    </a>
  )
}

// ── Agents ─────────────────────────────────────────────────────────────────────
/** Spawning, ChatGPT-style: one big centered composer. Pick an agent from the dropdown,
 *  type a task, hit Run to spawn a live session. Owner/admin can tune the selected agent's
 *  Settings (CLAUDE.md + runtime), delete it, or create a new one — all the catalog actions,
 *  just scoped to the chosen agent instead of a grid of cards. */
function AgentsPage({
  me, agents, selected, onSelect, run, onEdit, onNew, onDelete, onDuplicate, onRescan, onImport, onRefresh,
}: {
  me: Member
  agents: AgentInfo[]
  selected: string
  onSelect: (id: string) => void
  run: (agentId: string, task: string) => Promise<string | null>
  onEdit: (id: string) => void
  onNew: () => void
  onDelete: (id: string, builtIn?: boolean) => void
  onDuplicate: (id: string) => void
  onRescan: () => Promise<void>
  onImport: (file: File) => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const canEdit = me.role === 'owner' || me.role === 'admin'
  const [rescanning, setRescanning] = useState(false)
  const rescan = async () => { setRescanning(true); try { await onRescan() } finally { setRescanning(false) } }
  const [importing, setImporting] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  const pickBundle = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.zip')) { alert('Pick an AOS bundle .zip'); return }
    setImporting(true)
    try { await onImport(file) } finally { setImporting(false); if (importInput.current) importInput.current.value = '' }
  }
  const [task, setTask] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<AgentsView>(() => (localStorage.getItem(AGENTS_VIEW_KEY) === 'grid' ? 'grid' : 'split'))
  const setViewPersist = (v: AgentsView) => { setView(v); localStorage.setItem(AGENTS_VIEW_KEY, v) }
  const [query, setQuery] = useState('')
  // Fleet-wide maturity, keyed by agent id — the trust-at-a-glance signal on each agent chip.
  const [maturity, setMaturity] = useState<Record<string, AgentStats>>({})
  useEffect(() => {
    let ok = true
    api.agentStatsAll().then((r) => { if (ok) setMaturity(Object.fromEntries(r.stats.map((s) => [s.agentId, s]))) }).catch(() => {})
    return () => { ok = false }
  }, [])

  // The chosen agent is driven by the URL (`#/agents/<id>`) so a refresh keeps it. When the URL names
  // no agent (a bare `#/agents`), fall back to the last one you used (remembered across visits) then
  // the first in the list — without rewriting the URL, so the default doesn't spam history.
  const has = (id: string) => agents.some((a) => a.id === id)
  const lastUsed = localStorage.getItem(LAST_AGENT_KEY)
  const agentId = has(selected) ? selected : (lastUsed && has(lastUsed) ? lastUsed : (agents[0]?.id ?? ''))
  const agent = agents.find((a) => a.id === agentId)
  const pick = (id: string) => { localStorage.setItem(LAST_AGENT_KEY, id); onSelect(id) }

  // When the selected agent changes, restore the draft you'd typed for it (persisted by `editTask`, so
  // an accidental refresh doesn't lose it) or fall back to its first starter prompt.
  useEffect(() => {
    if (!agentId) { setTask(''); return }
    const saved = localStorage.getItem(taskDraftKey(agentId))
    setTask(saved != null ? saved : exampleTask(agent))
    setHint('')
  }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the draft as you type (or pick a starter), keyed per agent; empty clears the key.
  const editTask = (v: string) => {
    setTask(v)
    if (!agentId) return
    if (v) localStorage.setItem(taskDraftKey(agentId), v)
    else localStorage.removeItem(taskDraftKey(agentId))
  }

  const spawn = async () => {
    if (!agent || !task.trim()) return
    setBusy(true); setHint('spawning…')
    const err = await run(agent.id, task)
    setBusy(false)
    setHint(err ? '⚠ ' + err : '')
    // A successful spawn consumes the draft — drop it so returning here shows the starter prompt again.
    if (!err) localStorage.removeItem(taskDraftKey(agent.id))
  }

  if (agents.length === 0) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{canEdit ? 'No agents yet — create one to get started.' : 'No agents assigned to you.'}</p>
        {canEdit && (
          <>
            <div className="flex items-center gap-2">
              <input ref={importInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => pickBundle(e.target.files)} />
              <Button size="sm" className="gap-1" onClick={onNew}><Plus className="h-4 w-4" /> New agent</Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setLibraryOpen(true)} title="browse the agent library — install a ready-made agent">
                <Package className="h-4 w-4" /> Library
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => importInput.current?.click()} disabled={importing} title="import an agent from an AOS bundle .zip">
                <Upload className={'h-4 w-4' + (importing ? ' animate-pulse' : '')} /> {importing ? 'Importing…' : 'Import bundle'}
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={rescan} disabled={rescanning} title="pick up agents added to the agents folder on disk">
                <RefreshCw className={'h-4 w-4' + (rescanning ? ' animate-spin' : '')} /> Rescan folder
              </Button>
            </div>
            <AgentLibrary open={libraryOpen} onOpenChange={setLibraryOpen} onInstalled={onRefresh} />
          </>
        )}
      </div>
    )
  }

  // Filter the fleet by the search box (id / description / category), then group for display. The
  // selected agent is resolved over the FULL list, so searching never deselects what you picked.
  const q = query.trim().toLowerCase()
  const filtered = q
    ? agents.filter((a) => a.id.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q) || (a.category ?? '').toLowerCase().includes(q))
    : agents
  const groups = groupByCategory(filtered)

  // The task composer for the selected agent — shared by both layouts (the gallery puts it below the
  // cards; the split view puts it in the right pane). Its per-agent Edit/Delete actions live here.
  const composer = !agent ? (
    <p className="py-10 text-center text-sm text-muted-foreground">Pick an agent to give it a task.</p>
  ) : (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <AgentIcon icon={agent.icon} className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-semibold">{agent.id}</span>
        <RuntimeBadge runtime={agent.runtime} />
        {agent.builtIn && <BuiltInBadge />}
        <div className="ml-auto flex items-center gap-1">
          {canEdit && agent.runtime === 'claude-code' && (
            <Button render={<a href={navHref('agent', agent.id)} />} size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground" onClick={onNavClick(() => onEdit(agent.id))} title="agent settings — runtime tuning, starter prompts, CLAUDE.md">
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          )}
          {canEdit && agent.runtime === 'claude-code' && (
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground" onClick={() => onDuplicate(agent.id)} title="duplicate agent — deep-copy its definition under a new id (fresh, no history carried over)">
              <Copy className="h-4 w-4" />
            </Button>
          )}
          {canEdit && agent.deletable && (
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-destructive" onClick={() => onDelete(agent.id, agent.builtIn)} title="delete agent (removes its folder)">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {agent.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}

      {agent.examplePrompts && agent.examplePrompts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.examplePrompts.map((p, i) => (
            <button key={i} type="button" onClick={() => editTask(p)} title={p} className="max-w-full truncate rounded-full border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
              {p}
            </button>
          ))}
        </div>
      )}

      <Textarea
        value={task}
        onChange={(e) => editTask(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') spawn() }}
        className="min-h-[140px] text-sm"
        placeholder="Describe the task…  (⌘/Ctrl+Enter to Run)"
      />

      <div className="flex items-center gap-3">
        <Button onClick={spawn} disabled={busy || !task.trim()}>
          <Play className="mr-1 h-4 w-4" /> Run
        </Button>
        {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
      </div>
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {/* title + layout toggle + fleet actions */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">What should an agent do?</h1>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center rounded-md border p-0.5">
            <button type="button" onClick={() => setViewPersist('grid')} title="Gallery view" aria-pressed={view === 'grid'} className={'flex h-7 w-7 items-center justify-center rounded ' + (view === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setViewPersist('split')} title="List + detail view" aria-pressed={view === 'split'} className={'flex h-7 w-7 items-center justify-center rounded ' + (view === 'split' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <List className="h-4 w-4" />
            </button>
          </div>
          {canEdit && (
            <>
              <input ref={importInput} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => pickBundle(e.target.files)} />
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={onNew} title="new agent"><Plus className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={() => setLibraryOpen(true)} title="agent library — install a ready-made agent that ships with Agent OS"><Package className="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={() => importInput.current?.click()} disabled={importing} title="import an agent from an AOS bundle .zip"><Upload className={'h-4 w-4' + (importing ? ' animate-pulse' : '')} /></Button>
              <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={rescan} disabled={rescanning} title="rescan the agents folder — pick up agents added on disk without a restart"><RefreshCw className={'h-4 w-4' + (rescanning ? ' animate-spin' : '')} /></Button>
            </>
          )}
        </div>
      </div>

      {/* the agent library — a modal opened by the Library button in the toolbar above */}
      {canEdit && <AgentLibrary open={libraryOpen} onOpenChange={setLibraryOpen} onInstalled={onRefresh} />}

      {/* search — only worth showing once the fleet is more than a glance */}
      {agents.length > 6 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search agents…" className="h-8 pl-7" />
        </div>
      )}

      {view === 'grid' ? (
        <div className="space-y-4">
          {groups.length === 0 && <p className="text-sm text-muted-foreground">No agents match “{query}”.</p>}
          {groups.map(([cat, list]) => (
            <div key={cat} className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{cat}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((a) => {
                  const active = a.id === agentId
                  return (
                    <a key={a.id} href={navHref('agents', a.id)} onClick={onNavClick(() => pick(a.id))} className={'flex flex-col gap-1.5 rounded-lg border p-3 text-left text-foreground no-underline transition hover:border-primary/40 hover:bg-muted/40 ' + (active ? 'border-primary bg-primary/5 ring-1 ring-primary' : '')}>
                      <span className="flex items-center gap-1.5">
                        <AgentIcon icon={a.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">{a.id}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <RuntimeBadge runtime={a.runtime} />
                        {a.builtIn && <BuiltInBadge />}
                        <MaturityBadge s={maturity[a.id]} />
                      </span>
                      {a.description && <span className="line-clamp-2 text-[11px] text-muted-foreground">{a.description}</span>}
                    </a>
                  )
                })}
              </div>
            </div>
          ))}
          {/* Docked composer: sits after the cards, but sticks to the bottom of the scroll viewport
              once the gallery is tall enough to overflow — so the task box stays reachable without
              scrolling past every card. Clamped to its container, so short fleets show no gap. */}
          <Card className="sticky bottom-0 z-10 shadow-lg"><CardContent className="p-4">{composer}</CardContent></Card>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(190px,230px)_1fr]">
          <aside className="space-y-3 md:max-h-[70vh] md:overflow-y-auto md:pr-1">
            {groups.length === 0 && <p className="px-1 text-sm text-muted-foreground">No matches.</p>}
            {groups.map(([cat, list]) => (
              <div key={cat} className="space-y-0.5">
                <div className="px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{cat}</div>
                {list.map((a) => {
                  const active = a.id === agentId
                  return (
                    <a key={a.id} href={navHref('agents', a.id)} onClick={onNavClick(() => pick(a.id))} title={a.description} className={'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm no-underline transition ' + (active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}>
                      <AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{a.id}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        <MaturityBadge s={maturity[a.id]} />
                        {a.builtIn && <BuiltInBadge />}
                      </span>
                    </a>
                  )
                })}
              </div>
            ))}
          </aside>
          <Card className="shadow-sm"><CardContent className="p-4">{composer}</CardContent></Card>
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground">Run spawns a live session — every effect still passes the gate.</p>
    </div>
  )
}

// ── Sessions ───────────────────────────────────────────────────────────────────
/** Who started a session — a person icon + name for members, a bot icon for automations. */
/** The origin of a session — how it was initiated — as a distinct per-kind icon + its human label.
 *  The icon comes from the server-resolved {@link Session.sourceKind} (so cron vs slack vs task vs chat
 *  are all visually distinct, not collapsed to a generic glyph); a manual run still shows the starting
 *  member's avatar. The text is `spawnedByLabel` (e.g. "Cron · Nightly digest · as Alice"). */
function OriginBadge({ s, members = [], className = '' }: { s: Session; members?: Member[]; className?: string }) {
  const label = s.spawnedByLabel
  if (!label) return <span className={`flex items-center gap-1 text-xs text-muted-foreground/60 ${className}`}>—</span>
  const meta = originMeta(s.sourceKind)
  const Icon = meta.icon
  // A manually-started run shows the member's avatar; every other kind shows its category glyph.
  const mem = s.sourceKind === 'manual' ? memberOfPrincipal(s.spawnedBy, members) : undefined
  return (
    <span className={`flex items-center gap-1 text-xs text-muted-foreground ${className}`} title={`${meta.label} · ${label}`}>
      {mem ? <MemberAvatar member={mem} className="h-3 w-3 text-[7px]" /> : <Icon className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  )
}

/** The run mode of a session — headless (`claude -p`, ran to completion and exited) vs interactive (an
 *  attachable TUI a human can watch and steer). A compact colored pill, shown alongside the origin so
 *  the list makes both axes — who started it AND how it runs — legible at a glance. */
function ModeBadge({ headless, className = '' }: { headless?: boolean; className?: string }) {
  return headless ? (
    <span title="headless — ran `claude -p` non-interactively and exited when done" className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20 ${className}`}>
      <Zap className="h-2.5 w-2.5 shrink-0" /> Headless
    </span>
  ) : (
    <span title="interactive — an attachable TUI you can watch and steer" className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-sky-50 text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/20 ${className}`}>
      <Terminal className="h-2.5 w-2.5 shrink-0" /> Interactive
    </span>
  )
}

/** "How to use the terminal" — a small modal of shortcuts and quirks. The terminal is a real remote TUI,
 *  so a few gestures aren't obvious (select-to-copy, Option-drag when an app owns the mouse, Esc cancels a
 *  selection). Reached from the ⍰ Help button on the terminal pane. */
function TerminalHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
  const mod = isMac ? '⌘' : 'Ctrl'
  const rows: { keys: string; desc: string }[] = [
    { keys: 'Drag', desc: 'Select text — it copies to your clipboard automatically (a ✓ flashes) and stays highlighted.' },
    { keys: `${isMac ? '⌥ Option' : 'Shift'} + drag`, desc: 'Force a precise text selection when a running app (like claude) is using the mouse.' },
    { keys: 'Esc', desc: 'Cancel the current selection (without sending Esc to the app).' },
    { keys: `${mod} + C`, desc: 'Copy the selection.' },
    { keys: `${mod} + V  ·  right-click`, desc: 'Paste into the terminal.' },
    { keys: 'Mouse wheel', desc: 'Scroll back through output. Inside a full-screen app (claude) it scrolls that app.' },
    { keys: 'Click a link', desc: 'URLs in the output are clickable — opens in a new tab.' },
    { keys: 'Paste / drop an image', desc: 'Sends the image to the agent (it can’t travel over the raw terminal).' },
  ]
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><TerminalSquare className="h-4 w-4" /> Using the terminal</DialogTitle></DialogHeader>
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.keys} className="flex items-baseline gap-3 py-2">
              <kbd className="shrink-0 whitespace-nowrap rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">{r.keys}</kbd>
              <span className="text-sm text-muted-foreground">{r.desc}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">This is a live tmux session — closing the tab leaves it running; reopen it any time to reattach.</p>
      </DialogContent>
    </Dialog>
  )
}

/** The live terminal pane. It asks the server for the attach URL — the shared /terminal/?arg=…
 *  (uid-isolation off) or a per-member /terminal/<space>/?arg=… (on) — and derives the ttyd WebSocket
 *  endpoint from it, which our first-party <Xterm> speaks directly (no iframe). */
function TerminalFrame({ session, tmux, onActivity }: { session?: Session; tmux: string; onActivity?: (sid: string) => void }) {
  const [wsUrl, setWsUrl] = useState('')
  const [err, setErr] = useState('')
  const [transcript, setTranscript] = useState<string | null>(null)
  // "Take over" state: converting a headless run to interactive re-launches it server-side, but the
  // `session` prop (and its `resumable`/`status`) only refreshes on the next poll. `overrideAttach`
  // forces the attach path immediately; `nonce` re-runs the attach fetch and remounts <Xterm> so it
  // reconnects to the freshly-spawned interactive pane. Reset when the viewed session changes.
  const [overrideAttach, setOverrideAttach] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [takingOver, setTakingOver] = useState(false)
  useEffect(() => { setOverrideAttach(false); setNonce(0); setTakingOver(false) }, [session?.id])
  // Terminal font size — lifted here so it drives BOTH the <Xterm> (a live prop) and the stepper in the
  // ImageDropZone chrome. Persisted so the choice sticks across sessions.
  const [fontSize, setFontSize] = useState(() => {
    const n = Number(localStorage.getItem('aos_terminal_font'))
    return n >= TERM_FONT_MIN && n <= TERM_FONT_MAX ? n : 14
  })
  useEffect(() => { localStorage.setItem('aos_terminal_font', String(fontSize)) }, [fontSize])
  // A finished headless run (and a crashed headless run) has no resurrectable pane — never resumable
  // and no longer live — so attaching would show a dead terminal. Show its captured transcript instead.
  // Interactive ended sessions stay resumable and keep the normal attach/resume path untouched. Once
  // taken over (overrideAttach), force the live attach path even before the prop reflects the new state.
  const ended = Boolean(session) && !isLive(session!) && !session!.resumable && !overrideAttach
  // A headless run can be promoted to an attachable interactive session (see canGoInteractive). Offer it
  // both while streaming (live) and after it ended (continue) — hidden once taken over.
  const showTakeover = Boolean(session) && !overrideAttach && canGoInteractive(session!)
  const takeOver = async () => {
    if (!session?.id || takingOver) return
    setTakingOver(true); setErr('')
    const r = await api.goInteractive(session.id)
    setTakingOver(false)
    if (!r.ok) { setErr(r.error || 'could not go interactive'); return }
    // Drop the read-only transcript (if any) and force a fresh attach to the new interactive pane.
    setTranscript(null); setOverrideAttach(true); setNonce((n) => n + 1)
  }
  useEffect(() => {
    let alive = true
    setWsUrl(''); setErr(''); setTranscript(null)
    if (session?.id && ended) {
      api.sessionTranscript(session.id).then((r) => {
        if (!alive) return
        if (r.text != null) setTranscript(r.text.replace(/\x1b\[[0-9;]*m/g, '')) // strip any stray ANSI color
        else setErr(r.error || 'no transcript for this session')
      })
      return () => { alive = false }
    }
    // Our own <Xterm> speaks ttyd's WebSocket protocol directly, so we need the WS endpoint, not the old
    // iframe page URL. ttyd serves it at <base>/ws — the attach URL is <base>/?arg=…, so swap `/?`→`/ws?`.
    if (!session?.id) { setWsUrl(`/terminal/ws?arg=${encodeURIComponent(tmux)}`); return }
    api.attach(session.id).then((r) => {
      if (!alive) return
      if (r.url) setWsUrl(r.url.replace(/\/\?/, '/ws?'))
      else setErr(r.error || 'could not open terminal')
    })
    return () => { alive = false }
  }, [session?.id, tmux, ended, nonce])
  if (transcript != null) return (
    <div className="flex min-h-0 flex-1 flex-col bg-black">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-800 px-3 py-1.5 text-xs text-neutral-500">
        <span>Session ended · headless transcript (read-only)</span>
        {showTakeover && (
          <button onClick={takeOver} disabled={takingOver}
            className="flex items-center gap-1 rounded border border-sky-800 px-2 py-0.5 text-sky-300 hover:bg-sky-950 disabled:opacity-50"
            title="continue this run in an interactive session you can watch and steer (claude --resume)">
            <Terminal className="h-3 w-3" /> {takingOver ? 'opening…' : 'Continue interactively'}
          </button>
        )}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-neutral-300">{transcript || '(no output captured)'}</pre>
    </div>
  )
  if (err) return <div className="flex flex-1 items-center justify-center bg-black text-sm text-red-400">⚠ {err}</div>
  if (!wsUrl) return <div className="flex flex-1 items-center justify-center bg-black text-sm text-neutral-500">opening terminal…</div>
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {showTakeover && (
        <button onClick={takeOver} disabled={takingOver}
          className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-sky-700 bg-neutral-900/90 px-3 py-1 text-xs text-sky-300 shadow hover:bg-sky-950 disabled:opacity-50"
          title="take over — this headless run is unattended; convert it to an interactive session you can type into (ends the current turn, then resumes)">
          <Terminal className="h-3.5 w-3.5" /> {takingOver ? 'taking over…' : 'Take over (go interactive)'}
        </button>
      )}
      <ImageDropZone session={session} onActivity={onActivity && session?.id ? () => onActivity(session.id) : undefined}
        fontSize={fontSize} setFontSize={setFontSize}>
        <Xterm key={nonce} wsUrl={wsUrl} fontSize={fontSize} copyOnSelect />
      </ImageDropZone>
    </div>
  )
}

/** Wraps the first-party terminal (<Xterm>) with the console chrome: the font stepper, the "how to use"
 *  help modal, and the paths to get an IMAGE into the remote session — which the pty can't carry. Three
 *  ways in: a 📎 button, drag-and-drop onto the pane, and Cmd/Ctrl+V (image paste). Each uploads the
 *  bytes; the server saves them in the agent's folder and types the path into the running claude. Now
 *  that the terminal is same-document (no iframe), drops/pastes over it bubble to our window handlers
 *  directly — no cross-document interception needed. */
function ImageDropZone({ session, children, onActivity, fontSize, setFontSize }: {
  session?: Session; children: ReactNode; onActivity?: () => void
  fontSize: number; setFontSize: (f: number | ((s: number) => number)) => void
}) {
  const [drag, setDrag] = useState(false)
  const [help, setHelp] = useState(false)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err' | 'busy'; text: string } | null>(null)
  const live = session?.status === 'running'
  const wrapRef = useRef<HTMLDivElement>(null)
  // Keep the latest upload closure reachable from imperative (addEventListener) handlers without
  // re-binding them every render.
  const uploadRef = useRef<(file: File) => void>(() => {})
  const FONT_MIN = TERM_FONT_MIN, FONT_MAX = TERM_FONT_MAX

  const upload = async (file: File) => {
    if (!session?.id) return
    if (!live) { setToast({ kind: 'err', text: 'session is not live — start it first' }); return }
    if (!file.type.startsWith('image/')) { setToast({ kind: 'err', text: 'only images can be attached' }); return }
    setToast({ kind: 'busy', text: `uploading ${file.name || 'image'}…` })
    try {
      const buf = await file.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
      const dataB64 = btoa(bin)
      const ext = (file.type.split('/')[1] || 'png').split('+')[0]
      const r = await api.attachFile(session.id, dataB64, ext)
      setToast(r.ok ? { kind: 'ok', text: `attached → ${r.path} (added to the prompt)` } : { kind: 'err', text: r.error || 'upload failed' })
    } catch (e) {
      setToast({ kind: 'err', text: e instanceof Error ? e.message : 'upload failed' })
    }
  }

  // Image paste. Capture phase so it runs BEFORE xterm's own textarea paste handler when the terminal is
  // focused (an image has no text, so xterm would do nothing with it anyway — but capturing lets us claim
  // it cleanly). A text paste has no image item, so it falls through to xterm untouched.
  useEffect(() => {
    if (!session?.id) return
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((it) => it.kind === 'file' && it.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) { e.preventDefault(); e.stopPropagation(); void upload(file) }
    }
    window.addEventListener('paste', onPaste, true)
    return () => window.removeEventListener('paste', onPaste, true)
  }, [session?.id, live])

  // Drag detection at the WINDOW level. The terminal iframe is a separate document that swallows
  // dragover/drop while the cursor is over it, so handlers UNDER the iframe never fire. Instead we
  // watch the window: when a file-drag enters, raise a transparent overlay ON TOP of the iframe (below)
  // which then catches the drop. We preventDefault on window dragover/drop too, so a near-miss drop
  // doesn't make the browser navigate to the image file.
  useEffect(() => {
    if (!session?.id) return
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setDrag(true) } }
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const onDropWin = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); setDrag(false) }
    const onLeaveWin = (e: DragEvent) => { if (e.relatedTarget === null) setDrag(false) } // left the window entirely
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDropWin)
    window.addEventListener('dragleave', onLeaveWin)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDropWin)
      window.removeEventListener('dragleave', onLeaveWin)
    }
  }, [session?.id])

  uploadRef.current = upload

  // Font size flows to <Xterm> as a live prop (it reflows internally), so no imperative poking needed —
  // and the terminal is same-document now, so image paste/drop bubble to the window handlers above.

  // auto-dismiss the toast (keep errors a touch longer)
  useEffect(() => {
    if (!toast || toast.kind === 'busy') return
    const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 5000 : 3500)
    return () => clearTimeout(t)
  }, [toast])

  return (
    <div ref={wrapRef} className="relative flex min-h-0 w-full flex-1" onMouseDown={() => onActivity?.()}>
      {children}
      {/* top-left: terminal font-size stepper + a help button (shortcuts / quirks) */}
      <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5">
        <div className="flex items-center overflow-hidden rounded bg-neutral-800/90 text-neutral-200 shadow">
          <button
            className="px-2 py-1 text-xs leading-none hover:bg-neutral-700 disabled:opacity-40"
            title="Decrease terminal font size" disabled={fontSize <= FONT_MIN}
            onClick={() => setFontSize((s) => Math.max(FONT_MIN, s - 1))}
          >A−</button>
          <span className="min-w-[2ch] px-1 text-center text-[11px] tabular-nums" title="Terminal font size">{fontSize}</span>
          <button
            className="px-2 py-1 text-sm leading-none hover:bg-neutral-700 disabled:opacity-40"
            title="Increase terminal font size" disabled={fontSize >= FONT_MAX}
            onClick={() => setFontSize((s) => Math.min(FONT_MAX, s + 1))}
          >A+</button>
        </div>
        <button
          className="flex items-center gap-1 rounded bg-neutral-800/90 px-2 py-1 text-xs text-neutral-200 shadow hover:bg-neutral-700"
          title="How to use the terminal — shortcuts & quirks"
          onClick={() => setHelp(true)}
        ><HelpCircle className="h-3.5 w-3.5" /> Help</button>
      </div>
      <TerminalHelpModal open={help} onClose={() => setHelp(false)} />
      {/* top-right session toolbar: browse the agent's folder + attach an image */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        {session?.agent && (
          <a
            href={navHref('files', 'agents/' + session.agent)}
            className="flex items-center gap-1 rounded bg-neutral-800/90 px-2 py-1 text-xs text-neutral-200 no-underline shadow hover:bg-neutral-700"
            title="browse this agent's folder in Files"
          >
            <FolderTree className="h-3.5 w-3.5" /> Files
          </a>
        )}
        {/* 📎 attach button — opens a file picker; always works regardless of focus */}
        <label
          className="flex cursor-pointer items-center gap-1 rounded bg-neutral-800/90 px-2 py-1 text-xs text-neutral-200 shadow hover:bg-neutral-700"
          title="attach an image to this session (or drag-drop / paste one onto the terminal)"
        >
          <ImageIcon className="h-3.5 w-3.5" /> Attach image
          <input type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.currentTarget.value = '' }} />
        </label>
      </div>
      {/* drag overlay — raised ON TOP of the iframe (z-30, interactive) only while a file-drag is in
          progress, so it catches the drop the iframe would otherwise swallow */}
      {drag && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-emerald-400/70 bg-black/60 text-sm font-medium text-emerald-300"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault(); setDrag(false)
            const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
            if (file) void upload(file)
          }}
        >
          Drop image to send it to the agent
        </div>
      )}
      {/* result toast */}
      {toast && (
        <div className={`absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded px-3 py-1.5 text-xs shadow ${
          toast.kind === 'ok' ? 'bg-emerald-700 text-emerald-50' : toast.kind === 'err' ? 'bg-red-700 text-red-50' : 'bg-neutral-700 text-neutral-100'
        }`}>
          {toast.text}
        </div>
      )}
    </div>
  )
}

/** 👍/👎 verdict on a finished run — the ground-truth signal that feeds the agent's maturity score.
 *  Clicking the already-active thumb clears the verdict. */
function RunRating({ session, onRate }: { session: Session; onRate: (id: string, r: 'up' | 'down' | null) => void }) {
  const r = session.rating
  const set = (v: 'up' | 'down') => onRate(session.id, r === v ? null : v)
  const rated = r ? `rated ${r === 'up' ? '👍' : '👎'}${session.ratedByLabel ? ' by ' + session.ratedByLabel : ''} — feeds agent maturity` : 'rate this run — feeds the agent maturity score'
  return (
    <span className="inline-flex items-center gap-0.5" title={rated}>
      <button onClick={(e) => { e.stopPropagation(); set('up') }} className={`rounded p-0.5 hover:bg-muted ${r === 'up' ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground'}`} title="thumbs up — this run did what I wanted" aria-label="rate up">
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button onClick={(e) => { e.stopPropagation(); set('down') }} className={`rounded p-0.5 hover:bg-muted ${r === 'down' ? 'text-rose-600 dark:text-rose-500' : 'text-muted-foreground'}`} title="thumbs down — this run didn't do what I wanted" aria-label="rate down">
        <ThumbsDown className="h-3 w-3" />
      </button>
    </span>
  )
}

function SessionsPage({
  me, members, sessions, waiting, selected, hiddenTabs, onOpen, onCloseTab, onActivity, onSpawn, onStop, onDelete, onRate, onBulkStop, onBulkDelete, urlQuery, onFiltersChange,
}: {
  me: Member
  members: Member[]
  sessions: Session[]
  waiting: Set<string>
  selected: Selected
  /** tmuxes the user closed from the tab strip — hidden there, session stays alive. */
  hiddenTabs: Set<string>
  /** Hide a tab from the strip without stopping its session (reopen from All sessions). */
  onCloseTab: (tmux: string) => void
  onOpen: (tmux: string, title: string) => void
  onActivity: (sid: string) => void
  onSpawn: () => void
  onStop: (id: string) => void
  onDelete: (id: string, tmux: string) => void
  onRate: (id: string, rating: 'up' | 'down' | null) => void
  onBulkStop: (ids: string[]) => void
  onBulkDelete: (ids: string[]) => void
  /** Current hash-query string — the persisted filter state, read once to seed the filters. */
  urlQuery: string
  /** Push the active filters back into the URL (replaceState) so a refresh restores them. */
  onFiltersChange: (params: Record<string, string>) => void
}) {
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('aos_sessions_view') === 'list' ? 'list' : 'grid'))
  const setMode = (v: 'grid' | 'list') => { localStorage.setItem('aos_sessions_view', v); setView(v) }
  // Terminal switcher bar: live tabs stay pinned; ended (stopped/done/crashed) ones collapse behind a
  // toggle so the bar doesn't accrete every past run. The open session always shows even if it ended.
  const [showEnded, setShowEnded] = useState(false)

  // The session whose agent-os primitive activity is open in the modal timeline (null = closed).
  const [inspect, setInspect] = useState<Session | null>(null)

  // Filters (client-side over the already-fetched list). Search spans title/agent/id/task/starter;
  // status/agent/source/owner narrow by dimension. All default to "show everything". Seeded ONCE from
  // the URL hash query (so a refresh / deep-link restores them) and mirrored back on every change.
  const seed = useRef(parseSessionFilters(urlQuery)).current
  const [query, setQuery] = useState(seed.q)
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>(seed.status)
  const [agentFilter, setAgentFilter] = useState(seed.agent)
  const [sourceFilter, setSourceFilter] = useState<'all' | SessionSource>(seed.source)
  const [modeFilter, setModeFilter] = useState<SessionModeFilter>(seed.mode) // interactive | headless | all
  const [ownerFilter, setOwnerFilter] = useState(seed.owner) // run-as member id, or 'all'
  // "My sessions" toggle. It narrows to the sessions the viewer is accountable for (spawned directly
  // OR runs as them) — same rule as the sidebar switcher's `mySessions`. It DEFAULTS ON for owner/admin
  // (whose visibility is fleet-wide, so their unfiltered list is every session in the workspace) and
  // OFF for a member (whose list is already only their own — narrowing it further could hide an
  // automation-fired run they're entitled to, and the toggle is hidden for them anyway). An explicit
  // `?mine=` in the URL wins over the default, so a deliberate choice survives a refresh / deep-link.
  const isFleetViewer = me.role === 'owner' || me.role === 'admin'
  const seedMineParam = useRef(new URLSearchParams(urlQuery).get('mine')).current
  const [mine, setMine] = useState(seedMineParam === null ? isFleetViewer : seedMineParam === '1')
  const [sortKey, setSortKey] = useState<SessionSortKey>(seed.sortKey)
  const [sortDir, setSortDir] = useState<SortDir>(seed.sortDir)
  useEffect(() => {
    const params = sessionFiltersToParams({ q: query, status: statusFilter, agent: agentFilter, source: sourceFilter, mode: modeFilter, owner: ownerFilter, mine, sortKey, sortDir })
    if (mine !== isFleetViewer) params.mine = mine ? '1' : '0' // only persist a deviation from the per-viewer default
    onFiltersChange(params)
    // onFiltersChange is a stable replaceState wrapper; depending on the filter/sort values only is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, statusFilter, agentFilter, sourceFilter, modeFilter, ownerFilter, mine, sortKey, sortDir])
  // Clicking a column header sorts by it; clicking the active column flips direction. A fresh column
  // starts ascending, except `created` (time) which reads best newest-first.
  const toggleSort = (key: SessionSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'created' ? 'desc' : 'asc') }
  }
  // A clickable column heading. `className` carries the column's width/visibility so the header stays
  // aligned to its rows; the caret shows on the active column and flips with direction.
  const sortHead = (col: SessionSortKey, label: string, className: string) => (
    <button
      type="button"
      onClick={() => toggleSort(col)}
      title={`sort by ${label.toLowerCase()}`}
      className={`flex items-center gap-1 text-left hover:text-foreground ${sortKey === col ? 'text-foreground' : ''} ${className}`}
    >
      <span className="truncate">{label}</span>
      {sortKey === col && <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
    </button>
  )
  const agentOptions = useMemo(() => [...new Set(sessions.map((s) => s.agent))].sort(), [sessions])
  // Distinct run-as owners present, id→label, sorted by label. A session with no run-as identity is
  // omitted (nothing to key an Owner filter on).
  const ownerOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sessions) if (s.runAs && s.runAsLabel) m.set(s.runAs, s.runAsLabel)
    return [...m].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [sessions])
  const ownerLabel = (id: string) => (id === 'all' ? 'All owners' : ownerOptions.find((o) => o.id === id)?.label ?? id)
  // `mine` counts as "active" only when it deviates from the per-viewer default (My for owner/admin,
  // All for members), so the default view doesn't spuriously show the Clear-filters affordance.
  const filtersActive = query.trim() !== '' || statusFilter !== 'all' || agentFilter !== 'all' || sourceFilter !== 'all' || modeFilter !== 'all' || ownerFilter !== 'all' || mine !== isFleetViewer
  const clearFilters = () => { setQuery(''); setStatusFilter('all'); setAgentFilter('all'); setSourceFilter('all'); setModeFilter('all'); setOwnerFilter('all'); setMine(isFleetViewer) }
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter((s) =>
      matchesStatus(s, statusFilter) &&
      (agentFilter === 'all' || s.agent === agentFilter) &&
      (sourceFilter === 'all' || sessionSource(s) === sourceFilter) &&
      (modeFilter === 'all' || (modeFilter === 'headless' ? !!s.headless : !s.headless)) &&
      (ownerFilter === 'all' || s.runAs === ownerFilter) &&
      (!mine || s.spawnedBy === me.id || s.runAs === me.id) &&
      (needle === '' || `${s.title} ${s.agent} ${s.id} ${s.task} ${s.spawnedByLabel ?? ''} ${s.runAsLabel ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [sessions, query, statusFilter, agentFilter, sourceFilter, modeFilter, ownerFilter, mine, me.id])
  // Sorted view (both grid + list render this). A stable tiebreak on createdAt keeps equal keys in a
  // deterministic order rather than letting the sort shuffle them.
  const shown = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const primary = compareSessions(a, b, sortKey)
      return primary !== 0 ? primary * dir : b.createdAt - a.createdAt
    })
  }, [filtered, sortKey, sortDir])

  // Multi-select for bulk stop/delete. Kept in sync with the live list: ids that vanish (deleted
  // elsewhere, or by our own bulk delete) are pruned so the toolbar count never lies. Select-all and
  // the header count operate over the FILTERED view, so bulk actions never touch hidden rows.
  const [sel, setSel] = useState<Set<string>>(new Set())
  useEffect(() => {
    setSel((prev) => {
      const live = new Set(sessions.map((s) => s.id))
      const next = new Set([...prev].filter((id) => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [sessions])
  const toggle = (id: string) =>
    setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = filtered.length > 0 && filtered.every((s) => sel.has(s.id))
  const toggleAll = () => setSel((prev) => {
    const n = new Set(prev)
    if (allSelected) filtered.forEach((s) => n.delete(s.id))
    else filtered.forEach((s) => n.add(s.id))
    return n
  })
  const selectedRunning = sessions.filter((s) => sel.has(s.id) && isLive(s))
  const bulkStop = () => onBulkStop(selectedRunning.map((s) => s.id))
  const bulkDelete = () => { onBulkDelete([...sel]); setSel(new Set()) }

  // A terminal is open → fill the whole area: a slim switcher bar + the iframe taking the rest.
  if (selected) {
    const renderTab = (s: Session) => (
      <div
        key={s.id}
        className={`group/tab flex shrink-0 items-center gap-1.5 rounded px-2 py-1 ${
          selected.tmux === s.tmux ? 'bg-neutral-700 text-white' : 'hover:bg-neutral-800'
        }`}
      >
        <a href={navHref('sessions', s.tmux)} onClick={onNavClick(() => onOpen(s.tmux, s.agent + ' · ' + s.id))} title={s.spawnedByLabel ? `started by ${s.spawnedByLabel}` : undefined} className="flex items-center gap-1.5 text-inherit no-underline">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDot(s)}`} />
          <span className="max-w-[180px] truncate">{s.title}</span>
          {waiting.has(s.id) && <WaitingBell className="h-3 w-3" tone="text-indigo-300" />}
        </a>
        {/* per-tab controls — resume (resumable + not live) / stop (running only) + delete, revealed on hover or when active */}
        <span className={`flex items-center gap-1 ${selected.tmux === s.tmux ? '' : 'opacity-0 group-hover/tab:opacity-100'}`}>
          {canResume(s) && (
            <button className="rounded p-0.5 text-emerald-400 hover:bg-neutral-600 hover:text-emerald-300" onClick={() => resumeAndOpen(s, onOpen)} title="resume — reopen and continue this session (claude --resume)">
              <Play className="h-3 w-3" />
            </button>
          )}
          {canGoInteractive(s) && (
            <button className="rounded p-0.5 text-sky-400 hover:bg-neutral-600 hover:text-sky-300" onClick={() => takeOverAndOpen(s, onOpen)} title="take over — convert this headless run to an interactive session you can watch and steer">
              <Terminal className="h-3 w-3" />
            </button>
          )}
          {isLive(s) && (
            <button className="rounded p-0.5 text-amber-400 hover:bg-neutral-600 hover:text-amber-300" onClick={() => onStop(s.id)} title="stop — kill this session's shell">
              <Square className="h-3 w-3" />
            </button>
          )}
          <button className="rounded p-0.5 text-red-400 hover:bg-neutral-600 hover:text-red-300" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
            <Trash2 className="h-3 w-3" />
          </button>
          <button className="rounded p-0.5 text-neutral-400 hover:bg-neutral-600 hover:text-neutral-100" onClick={() => onCloseTab(s.tmux)} title="close tab — hide from here (the session keeps running; reopen it from All sessions)">
            <X className="h-3 w-3" />
          </button>
        </span>
      </div>
    )
    // Live tabs pin left. The open session shows even when ended. Every other ended session hides
    // behind the "N ended" toggle so a workspace full of past runs doesn't bury the live ones.
    // A tab the user "closed" (hidden set) is dropped from the strip without stopping the session —
    // except the one currently open, which always stays visible so it can't orphan the iframe.
    const visible = (s: Session) => !hiddenTabs.has(s.tmux) || s.tmux === selected.tmux
    // Only the viewer's own runs auto-populate the strip — otherwise an owner/admin (who can see the
    // whole fleet via /api/sessions) gets a new tab popped in every time anyone else spawns a session.
    // The currently-open session stays force-visible so explicitly opening someone else's run (e.g. an
    // admin taking over) still shows its tab and can't orphan the iframe.
    const mine = (s: Session) => s.spawnedBy === me.id || s.runAs === me.id || s.tmux === selected.tmux
    const liveTabs = sessions.filter((s) => isLive(s) && visible(s) && mine(s))
    const endedTabs = sessions.filter((s) => !isLive(s))
    const selectedEnded = endedTabs.find((s) => s.tmux === selected.tmux)
    const collapsibleEnded = endedTabs.filter((s) => s.tmux !== selected.tmux && visible(s) && mine(s))
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300">
          <TerminalSquare className="h-4 w-4 shrink-0" />
          {/* Only the tabs scroll; the "ended" toggle stays pinned right so it's always reachable. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {liveTabs.map(renderTab)}
            {selectedEnded && renderTab(selectedEnded)}
            {showEnded && collapsibleEnded.map(renderTab)}
            {collapsibleEnded.length > 0 && (
              <>
                <span className="h-4 w-px shrink-0 bg-neutral-700" />
                <button
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                  onClick={() => setShowEnded((v) => !v)}
                  title={showEnded ? 'hide ended sessions' : 'show stopped/ended sessions'}
                >
                  <span className="whitespace-nowrap">{showEnded ? 'hide ended' : `${collapsibleEnded.length} ended`}</span>
                  <ChevronDown className={`h-3 w-3 transition-transform ${showEnded ? '' : '-rotate-90'}`} />
                </button>
              </>
            )}
          </div>
        </div>
        <TerminalFrame key={selected.tmux} session={sessions.find((s) => s.tmux === selected.tmux)} tmux={selected.tmux} onActivity={onActivity} />
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No sessions yet.{' '}
        <button className="text-primary underline" onClick={onSpawn}>Spawn an agent</button> to start one.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {/* header: select-all + count (or bulk toolbar) · grid/list view toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground" title={allSelected ? 'clear selection' : 'select all'}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="h-3.5 w-3.5 cursor-pointer accent-primary" />
            {sel.size > 0
              ? `${sel.size} selected`
              : filtersActive
                ? `${filtered.length} of ${sessions.length} session${sessions.length === 1 ? '' : 's'}`
                : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
          </label>
          {sel.size > 0 && (
            <div className="flex items-center gap-1">
              {selectedRunning.length > 0 && (
                <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-amber-600" onClick={bulkStop} title="kill the running sessions in the selection">
                  <Square className="h-3 w-3" /> Stop {selectedRunning.length}
                </Button>
              )}
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs text-destructive" onClick={bulkDelete} title="delete the selected sessions + their messages/files">
                <Trash2 className="h-3 w-3" /> Delete {sel.size}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setSel(new Set())}>Clear</Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 rounded-md border p-0.5">
          <button className={`rounded p-1 ${view === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setMode('grid')} title="grid view">
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button className={`rounded p-1 ${view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setMode('list')} title="list view">
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* filters: free-text search + status/agent/source narrowers, applied client-side over the list */}
      <div className="flex flex-wrap items-center gap-2">
        {/* My/All scope — only owner/admin see other people's sessions, so the toggle is meaningful
            just for them (a member's list is already only their own). */}
        {(me.role === 'owner' || me.role === 'admin') && (
          <div className="inline-flex h-8 overflow-hidden rounded-md border text-xs">
            <button onClick={() => setMine(false)} className={`px-2.5 ${!mine ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`} title="every session in the workspace">All</button>
            <button onClick={() => setMine(true)} className={`border-l px-2.5 ${mine ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`} title="only sessions you started or that run as you">My sessions</button>
          </div>
        )}
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions…" className="h-8 pl-7 text-sm" />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter((v ?? 'all') as SessionStatusFilter)}>
          <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue>{(v) => SESSION_STATUS_LABELS[(v ?? 'all') as SessionStatusFilter]}</SelectValue></SelectTrigger>
          <SelectContent>
            {(Object.keys(SESSION_STATUS_LABELS) as SessionStatusFilter[]).map((v) => (
              <SelectItem key={v} value={v}>{SESSION_STATUS_LABELS[v]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={agentFilter} onValueChange={(v) => setAgentFilter(v ?? 'all')}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue>{(v) => (v && v !== 'all' ? v : 'All agents')}</SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agentOptions.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={(v) => setSourceFilter((v ?? 'all') as 'all' | SessionSource)}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue>{(v) => SESSION_SOURCE_LABELS[(v ?? 'all') as 'all' | SessionSource]}</SelectValue></SelectTrigger>
          <SelectContent>
            {(Object.keys(SESSION_SOURCE_LABELS) as ('all' | SessionSource)[]).map((v) => (
              <SelectItem key={v} value={v}>{SESSION_SOURCE_LABELS[v]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={modeFilter} onValueChange={(v) => setModeFilter((v ?? 'all') as SessionModeFilter)}>
          <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue>{(v) => SESSION_MODE_LABELS[(v ?? 'all') as SessionModeFilter]}</SelectValue></SelectTrigger>
          <SelectContent>
            {(Object.keys(SESSION_MODE_LABELS) as SessionModeFilter[]).map((v) => (
              <SelectItem key={v} value={v}>{SESSION_MODE_LABELS[v]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Owner (run-as) filter — only when more than one distinct owner exists (a single-owner
            workspace has nothing to narrow). */}
        {ownerOptions.length > 1 && (
          <Select value={ownerFilter} onValueChange={(v) => setOwnerFilter(v ?? 'all')}>
            <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue>{(v) => ownerLabel((v ?? 'all') as string)}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {ownerOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {filtersActive && (
          <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-xs text-muted-foreground" onClick={clearFilters}>
            <X className="h-3 w-3" /> Clear filters
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          No sessions match these filters.{' '}
          <button className="text-primary underline" onClick={clearFilters}>Clear filters</button>
        </div>
      ) : view === 'grid' ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((s) => (
            <div key={s.id} className={`group relative flex flex-col rounded-lg border p-3 hover:bg-muted ${sel.has(s.id) ? 'ring-1 ring-primary' : ''}`}>
              <input
                type="checkbox"
                checked={sel.has(s.id)}
                onChange={() => toggle(s.id)}
                title="select"
                className={`absolute right-2 top-2 h-3.5 w-3.5 cursor-pointer accent-primary transition-opacity ${sel.has(s.id) ? '' : 'opacity-0 group-hover:opacity-100'}`}
              />
              <a href={navHref('sessions', s.tmux)} onClick={onNavClick(() => onOpen(s.tmux, s.agent + ' · ' + s.id))} className="block pr-6 text-left text-foreground no-underline">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${statusDot(s)}`} />
                  <span className="truncate text-sm font-medium">{s.title}</span>
                  {waiting.has(s.id) && <WaitingBell className="h-3.5 w-3.5" />}
                </div>
                <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                  <span className="truncate">{s.agent} · {statusLabel(s)} · <span className="font-mono">{s.id}</span></span>
                  <ModeBadge headless={s.headless} />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <OriginBadge s={s} members={members} />
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={new Date(s.updatedAt).toLocaleString()}>{timeAgo(s.updatedAt)} ago</span>
                </div>
              </a>
              {/* Human verdict — only for finished runs; stays visible once rated, faint-until-hover otherwise. */}
              {!isLive(s) && (
                <div className={`mt-1.5 transition-opacity ${s.rating ? '' : 'opacity-40 group-hover:opacity-100'}`}>
                  <RunRating session={s} onRate={onRate} />
                </div>
              )}
              <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {canResume(s) && (
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-emerald-600" onClick={() => resumeAndOpen(s, onOpen)} title="reopen and continue this session (claude --resume)">
                    <Play className="h-3 w-3" /> Resume
                  </Button>
                )}
                {canGoInteractive(s) && (
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-sky-600" onClick={() => takeOverAndOpen(s, onOpen)} title="take over — convert this headless run to an interactive session you can watch and steer">
                    <Terminal className="h-3 w-3" /> Take over
                  </Button>
                )}
                {isLive(s) && (
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-amber-600" onClick={() => onStop(s.id)} title="kill this session's shell">
                    <X className="h-3 w-3" /> Stop
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs" onClick={() => setInspect(s)} title="which agent-os primitives this session used">
                  <Activity className="h-3 w-3" /> Activity
                </Button>
                <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-destructive" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y overflow-hidden rounded-lg border">
          {/* column headings — click to sort; each mirrors its row column's width/visibility classes */}
          <div className="flex items-center gap-3 bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="h-2 w-2 shrink-0" aria-hidden />
              {sortHead('title', 'Session', 'min-w-0 flex-1')}
              {sortHead('agent', 'Agent', 'hidden w-32 shrink-0 sm:flex')}
              {sortHead('id', 'ID', 'hidden w-20 shrink-0 md:flex')}
              {sortHead('startedBy', 'Started by', 'w-40 shrink-0')}
              <span className="w-24 shrink-0">Mode</span>
              {sortHead('updated', 'Updated', 'w-20 shrink-0')}
              {sortHead('status', 'Status', 'w-16 shrink-0')}
            </div>
            <span className="w-32 shrink-0" aria-hidden />
          </div>
          {shown.map((s) => (
            <div key={s.id} className={`group flex items-center gap-3 px-3 py-2 hover:bg-muted ${sel.has(s.id) ? 'bg-muted' : ''}`}>
              <input
                type="checkbox"
                checked={sel.has(s.id)}
                onChange={() => toggle(s.id)}
                title="select"
                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
              />
              <button onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot(s)}`} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
                {waiting.has(s.id) && <WaitingBell className="h-3.5 w-3.5" />}
                <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">{s.agent}</span>
                <span className="hidden w-20 shrink-0 truncate font-mono text-xs text-muted-foreground md:block" title={s.id}>{s.id}</span>
                <OriginBadge s={s} members={members} className="w-40 shrink-0" />
                <span className="flex w-24 shrink-0 items-center"><ModeBadge headless={s.headless} /></span>
                <span className="w-20 shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(s.updatedAt).toLocaleString()}>{timeAgo(s.updatedAt)} ago</span>
                <span className="w-16 shrink-0 text-xs text-muted-foreground">{statusLabel(s)}</span>
              </button>
              {/* Human verdict — finished runs only; stays visible once rated, faint-until-hover otherwise. */}
              <div className={`shrink-0 transition-opacity ${!isLive(s) ? (s.rating ? '' : 'opacity-40 group-hover:opacity-100') : 'invisible'}`}>
                {!isLive(s) && <RunRating session={s} onRate={onRate} />}
              </div>
              <div className="flex w-32 shrink-0 items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {canResume(s) && (
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => resumeAndOpen(s, onOpen)} title="resume — reopen and continue this session (claude --resume)">
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canGoInteractive(s) && (
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-sky-600" onClick={() => takeOverAndOpen(s, onOpen)} title="take over — convert this headless run to an interactive session you can watch and steer">
                    <Terminal className="h-3.5 w-3.5" />
                  </Button>
                )}
                {isLive(s) && (
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-600" onClick={() => onStop(s.id)} title="stop — kill this session's shell">
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setInspect(s)} title="activity — which agent-os primitives this session used">
                  <Activity className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {inspect && <SessionActivity session={inspect} onClose={() => setInspect(null)} />}
    </div>
  )
}

// ── Inbox ──────────────────────────────────────────────────────────────────────
/** An item needs the human: an unresolved approval, an unanswered question, or a session that fired a
 *  Notification (Claude is blocked waiting on a permission prompt / idle input). */
const isActionRequired = (m: Msg): boolean =>
  ((m.type === 'approval' || m.type === 'question') && m.status === 'pending') ||
  (m.type === 'notification' && m.status === 'open')

/** An agent flagged a progress update as a key milestone / heads-up (carried in `args.important`). */
const isImportant = (m: Msg): boolean =>
  m.type === 'update' && !!(m.args as { important?: boolean } | undefined)?.important

/** Compact relative time for the feed: 12s · 5m · 3h · 2d · 4w. */
/** The open session's facts, rendered as a subline under the session title (owner/agent/started-by/
 *  age/status). Its own row, so every fact shows; it wraps on a narrow viewport rather than hiding. */
function SessionFacts({ session: s, members = [] }: { session?: Session; members?: Member[] }) {
  if (!s) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5" title={`status: ${statusLabel(s)}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${statusDot(s)}`} />
        <span className="text-foreground">{statusLabel(s)}</span>
      </span>
      {s.runAsLabel && (
        <span className="flex items-center gap-1" title={`runs as ${s.runAsLabel}`}>
          {memberOfPrincipal(s.runAs, members)
            ? <MemberAvatar member={memberOfPrincipal(s.runAs, members)!} className="h-3.5 w-3.5 text-[8px] shrink-0" />
            : <User className="h-3.5 w-3.5 shrink-0 opacity-60" />}
          <span className="max-w-[160px] truncate text-foreground">{s.runAsLabel}</span>
        </span>
      )}
      <span className="flex items-center gap-1" title={`agent ${s.agent}`}>
        <Bot className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="max-w-[160px] truncate">{s.agent}</span>
      </span>
      {s.spawnedByLabel && (
        <span className="flex max-w-[200px] items-center gap-1" title={`started by ${s.spawnedByLabel}`}>
          {memberOfPrincipal(s.spawnedBy, members)
            ? <MemberAvatar member={memberOfPrincipal(s.spawnedBy, members)!} className="h-3.5 w-3.5 text-[8px] shrink-0" />
            : <Play className="h-3.5 w-3.5 shrink-0 opacity-60" />}
          <span className="truncate">{s.spawnedByLabel}</span>
        </span>
      )}
      <span className="flex items-center gap-1" title={`created ${new Date(s.createdAt).toLocaleString()}`}>
        <Clock className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span>{timeAgo(s.createdAt)} ago</span>
      </span>
    </div>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

/** Compact "in 3h" / "in 2d" for a future timestamp — the forward-looking companion to timeAgo. */
function timeUntil(ts: number): string {
  const s = Math.max(0, Math.floor((ts - Date.now()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

/** The inbox heading for a message: the session's live display name, falling back to the agent id if a
 *  run hasn't been named yet. Every card leads with this; the agent is shown as a secondary line. */
// A 'task' card has no session — its headline is the event title; everything else leads with the
// session's live title (falling back to the agent id).
const sessionName = (m: Msg): string => m.type === 'task' ? (m.title || 'Task') : ((m.sessionTitle || '').trim() || m.agent)

/** Shared two-tier heading: the session name (primary) with the agent id as a secondary line below.
 *  Inline status badges/verb sit on the agent line so the session name always reads as the title. */
function MsgHeading({ m, children }: { m: Msg; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm font-medium leading-snug">{sessionName(m)}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <Bot className="h-3 w-3 shrink-0" />
        <span className="min-w-0 max-w-full truncate">{m.agent}</span>
        {children}
      </div>
    </div>
  )
}

function InboxPage({ messages: propMessages, me, members, onOpen, onOpenArtifact, onOpenTask }: { messages: Msg[]; me: Member; members: Member[]; onOpen: (tmux: string, title: string) => void; onOpenArtifact: (id: string) => void; onOpenTask: (id: string) => void }) {
  // Read state is now PER-MEMBER + server-backed (m.read): it syncs across this member's devices/tabs
  // and one admin marking read no longer touches another's badge. `readIds` optimistically bridges the
  // gap until the next poll reflects the server truth.
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set())
  // Optimistically hide dismissed items; roll back on error. The server filters them from the next
  // poll anyway (per-member now), so the set just bridges the gap until then.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  // Inbox scope. Default `mine` — only cards addressed to you (fed by the App-level poll, so the tab
  // badge stays personal). Owner/admin can flip to `all` to oversee every session's cards; that view is
  // fetched + polled LOCALLY here so switching to it doesn't spike the global badge.
  const isOverseer = me.role === 'owner' || me.role === 'admin'
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [allMsgs, setAllMsgs] = useState<Msg[] | null>(null)
  useEffect(() => {
    if (scope !== 'all') { setAllMsgs(null); return }
    let live = true
    const pull = async () => { const m = await api.messages('all'); if (live) setAllMsgs(m) }
    void pull()
    const t = setInterval(pull, 2000)
    return () => { live = false; clearInterval(t) }
  }, [scope])
  const messages = scope === 'all' ? (allMsgs ?? propMessages) : propMessages
  const dismiss = async (id: string) => {
    setDismissed((s) => new Set(s).add(id))
    const r = await api.dismissMessage(id)
    if (r.error) { setDismissed((s) => { const n = new Set(s); n.delete(id); return n }); alert(r.error) }
  }
  // `dismissed` is honored here too so a dismissed notification vanishes INSTANTLY (optimistic), instead
  // of lingering until the next 1.5s poll drops it server-side — the old code filtered `activity` but not
  // `action`, which is why dismissing a "Needs you" notification felt stuck.
  const action = messages.filter((m) => isActionRequired(m) && !dismissed.has(m.id))
  const activity = messages.filter((m) => !isActionRequired(m) && !dismissed.has(m.id))
  // Only open notifications in "Needs you" are dismissible — pending approvals/questions must be
  // resolved/answered, not swept away (the server refuses to dismiss them anyway).
  const dismissableAction = action.filter((m) => m.type === 'notification')
  const dismissAllAction = async () => {
    const ids = dismissableAction.map((m) => m.id)
    if (ids.length === 0) return
    setDismissed((s) => { const n = new Set(s); ids.forEach((id) => n.add(id)); return n })
    const results = await Promise.all(ids.map((id) => api.dismissMessage(id)))
    const failed = ids.filter((_, i) => results[i].error)
    if (failed.length) { setDismissed((s) => { const n = new Set(s); failed.forEach((id) => n.delete(id)); return n }); alert('Some notifications could not be dismissed') }
  }
  const dismissAll = async () => {
    const ids = activity.map((m) => m.id)
    if (ids.length === 0) return
    setDismissed((s) => { const n = new Set(s); ids.forEach((id) => n.add(id)); return n })
    const r = await api.dismissAllMessages(scope)
    if (r.error) { setDismissed((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n }); alert(r.error) }
  }
  const isUnread = (m: Msg): boolean => !m.read && !readIds.has(m.id)
  const unread = activity.filter(isUnread).length
  const markRead = async () => {
    const ids = activity.filter(isUnread).map((m) => m.id)
    if (ids.length === 0) return
    setReadIds((s) => { const n = new Set(s); ids.forEach((id) => n.add(id)); return n })
    const r = await api.markAllRead(scope)
    if (r.error) { setReadIds((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n }); alert(r.error) }
  }

  // The My/All scope toggle — owner/admin only (a member's feed is already just their own).
  const scopeToggle = isOverseer ? (
    <div className="inline-flex overflow-hidden rounded-md border text-[11px]">
      <button onClick={() => setScope('mine')} className={`px-2.5 py-1 ${scope === 'mine' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`} title="only cards addressed to you">My activity</button>
      <button onClick={() => setScope('all')} className={`border-l px-2.5 py-1 ${scope === 'all' ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`} title="every session's cards across the workspace">All</button>
    </div>
  ) : null

  if (messages.length === 0)
    return (
      <div className="mx-auto max-w-2xl">
        {scopeToggle && <div className="mb-4 flex justify-end">{scopeToggle}</div>}
        <div className="pt-10 text-center text-sm text-muted-foreground">{scope === 'all' ? 'No activity across the workspace yet.' : 'No messages addressed to you yet.'}</div>
      </div>
    )

  return (
    <div className="mx-auto max-w-2xl space-y-7">
      {scopeToggle && <div className="flex justify-end">{scopeToggle}</div>}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Needs you {action.length > 0 && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{action.length}</Badge>}
          </span>
          {dismissableAction.length > 0 && <button className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={dismissAllAction}>dismiss all</button>}
        </div>
        {action.length === 0 ? (
          <div className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">Nothing waiting on you. 🎉</div>
        ) : (
          <div className="space-y-2">
            {action.map((m) => <ActionItem key={m.id} m={m} me={me} onOpen={onOpen} onDismiss={dismiss} />)}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Activity{unread > 0 ? ` · ${unread} new` : ''}</span>
          <div className="flex items-center gap-3">
            {unread > 0 && <button className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={markRead}>mark all read</button>}
            {activity.length > 0 && <button className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={dismissAll}>dismiss all</button>}
          </div>
        </div>
        {activity.length === 0 ? (
          <div className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">No activity yet.</div>
        ) : (
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
            {activity.map((m) => <FeedItem key={m.id} m={m} members={members} onOpen={onOpen} onOpenArtifact={onOpenArtifact} onOpenTask={onOpenTask} onDismiss={dismiss} unread={isUnread(m)} />)}
          </div>
        )}
      </section>
    </div>
  )
}

const OUTCOME_STYLE: Record<string, { cls: string; label: string }> = {
  success: { cls: 'border-emerald-300 text-emerald-700', label: 'success' },
  failure: { cls: 'border-red-300 text-red-700', label: 'failure' },
  partial: { cls: 'border-amber-300 text-amber-700', label: 'partial' },
  unknown: { cls: 'border-neutral-300 text-neutral-600', label: 'ended' },
}

/** An action-required item (approval · question · waiting-notification) — a compact, coloured card with
 *  its controls inline. Pending only; once resolved the item drops into the read-only Activity feed. */
function ActionItem({ m, me, onOpen, onDismiss }: { m: Msg; me: Member; onOpen: (tmux: string, title: string) => void; onDismiss: (id: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const open = () => onOpen('aos-' + m.sessionId, m.agent + ' · ' + m.sessionId)
  const time = <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">{timeAgo(m.createdAt)}</span>

  // ── Notification (Claude is waiting on you — permission prompt / idle input) ──
  if (m.type === 'notification') {
    return (
      <div className="flex items-start gap-2.5 rounded-lg border border-indigo-300 bg-indigo-50/40 px-3 py-2.5">
        <Bell className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
        <div className="min-w-0 flex-1">
          <MsgHeading m={m}><span className="shrink-0 text-indigo-600">· waiting for you</span></MsgHeading>
          <div className="mt-1 whitespace-pre-line break-words text-xs text-muted-foreground">{m.body}</div>
        </div>
        {time}
        <div className="flex shrink-0 gap-1">
          <Button render={<a href={navHref('sessions', 'aos-' + m.sessionId)} />} size="sm" className="h-7 px-2.5 text-xs" onClick={onNavClick(open)}>Open</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onDismiss(m.id)}>Dismiss</Button>
        </div>
      </div>
    )
  }

  // ── Approval (pending) ──
  if (m.type === 'approval') {
    const mayApprove = canApprove(me.role, (m.level ?? 'head') as 'head' | 'owner')
    // Explicit risk bucket — falls back to level for pre-riskClass rows (head→yellow, owner→red).
    const rc = m.riskClass ?? (m.level === 'owner' ? 'red' : 'yellow')
    const approverLabel = m.level === 'owner' ? 'owner' : 'admin'
    const resolve = async (approved: boolean) => { setBusy(true); const r = await api.resolve(m.approvalId!, approved); if (r.error) setBusy(false) }
    // "Always approve" also teaches policy an allow rule for this capability — a policy edit, so owner-only.
    const always = async () => {
      setBusy(true)
      const r = await api.alwaysApprove(m.approvalId!)
      if (r.error) { setBusy(false); alert(r.error) }          // 403/404 — not resolved; leave the card
      else if (r.ruleAdded === false && r.note) alert(`Approved once — ${r.note}`)  // resolved, rule not added
    }
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50/40 px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <MsgHeading m={m}>
              {rc === 'red'
                ? <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">🔴 RED · {approverLabel} approval</Badge>
                : <Badge className="border-amber-300 bg-amber-100 px-1.5 py-0 text-[10px] text-amber-900 hover:bg-amber-100">🟡 YELLOW · {approverLabel} approval</Badge>}
            </MsgHeading>
            <div className="mt-1 break-words text-sm font-medium">{m.title}</div>
            {m.policyReason && <div className="mt-0.5 break-words text-xs text-muted-foreground"><span className="text-amber-700">why:</span> {m.policyReason}</div>}
            {m.body && <div className="mt-0.5 whitespace-pre-line break-words text-xs text-muted-foreground">{m.body}</div>}
            <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground/80">{JSON.stringify(m.args ?? {})}</div>
          </div>
          {time}
        </div>
        <div className="mt-2 flex justify-end gap-1.5">
          {mayApprove ? (
            <>
              <Button size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => resolve(true)}><Check className="mr-1 h-3.5 w-3.5" />Approve</Button>
              {me.role === 'owner' && (
                <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={busy} onClick={always} title={`Approve this and stop asking — adds an "allow ${m.capability ?? ''}" rule to policy`}><Shield className="mr-1 h-3.5 w-3.5" />Always</Button>
              )}
              <Button size="sm" variant="destructive" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => resolve(false)}><X className="mr-1 h-3.5 w-3.5" />Reject</Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">{m.level === 'owner' ? 'owner' : 'admin'} approval required</span>
          )}
        </div>
      </div>
    )
  }

  // ── Question (pending) ──
  const send = async () => { if (!answer.trim()) return; setBusy(true); const r = await api.answerQuestion(m.questionId!, answer.trim()); if (r.error) setBusy(false) }
  // Dismiss without answering: cancels the question so it leaves "Needs you" (and unblocks a live agent's `ask`).
  const dismissQ = async () => { setBusy(true); const r = await api.cancelQuestion(m.questionId!); if (r.error) { setBusy(false); alert(r.error) } }
  return (
    <div className="rounded-lg border border-sky-300 bg-sky-50/40 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
        <div className="min-w-0 flex-1">
          <MsgHeading m={m}><span className="shrink-0 text-sky-600">· asks</span></MsgHeading>
          <div className="mt-1 whitespace-pre-line break-words text-sm">{m.body}</div>
        </div>
        <a href={navHref('sessions', 'aos-' + m.sessionId)} className="shrink-0 pt-0.5 text-[11px] text-muted-foreground underline hover:text-foreground" onClick={onNavClick(open)}>open</a>
        {time}
      </div>
      <div className="mt-2 flex gap-1.5">
        <Input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Type your answer — the agent is waiting…" className="h-8 text-sm" />
        <Button size="sm" className="h-8 px-2.5 text-xs" disabled={busy || !answer.trim()} onClick={send}><Send className="mr-1 h-3.5 w-3.5" />Reply</Button>
        <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground" disabled={busy} onClick={dismissQ} title="Dismiss without answering — the agent stops waiting on this">Dismiss</Button>
      </div>
    </div>
  )
}

/** One read-only Activity-feed row — completion · artifact · progress update · resolved approval ·
 *  answered question · (legacy) start. Compact, the whole row opens the session (artifacts open the
 *  gallery); the timestamp swaps to a dismiss button on hover. */
function FeedItem({ m, members = [], onOpen, onOpenArtifact, onOpenTask, onDismiss, unread }: { m: Msg; members?: Member[]; onOpen: (tmux: string, title: string) => void; onOpenArtifact?: (id: string) => void; onOpenTask?: (id: string) => void; onDismiss?: (id: string) => void; unread?: boolean }) {
  const open = () => onOpen('aos-' + m.sessionId, m.agent + ' · ' + m.sessionId)
  const meta = (m.args ?? {}) as { artifactId?: string; filename?: string; taskId?: string; event?: string }
  const goArtifact = m.type === 'artifact' && meta.artifactId && onOpenArtifact ? () => onOpenArtifact(meta.artifactId!) : null
  // A 'task' card has no session — it deep-links to the board (its taskId), not a terminal.
  const goTask = m.type === 'task' && meta.taskId && onOpenTask ? () => onOpenTask(meta.taskId!) : null
  const rowAction = goArtifact ?? goTask ?? open
  // The new-tab target mirrors the click action — all three deep-link fully (artifact by id, task by
  // id, else the session terminal).
  const rowHref = goArtifact ? navHref('artifacts', meta.artifactId!) : goTask ? navHref('tasks', meta.taskId!) : navHref('sessions', 'aos-' + m.sessionId)

  let Icon = Clock
  let iconCls = 'text-muted-foreground'
  let verb: ReactNode = null      // the action, on the agent line ("finished", "published", …)
  let badge: ReactNode = null     // status/outcome badge, on the session-name line
  let detail: ReactNode = null    // the body / specifics, muted
  let extra: ReactNode = null     // optional block below (e.g. an answer)
  let highlight = false

  if (m.type === 'completed') {
    const o = OUTCOME_STYLE[m.outcome ?? 'unknown'] ?? OUTCOME_STYLE.unknown
    Icon = m.outcome === 'failure' ? XCircle : CheckCircle2
    iconCls = m.outcome === 'failure' ? 'text-red-600' : 'text-emerald-600'
    verb = 'finished'; detail = m.body
    badge = <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-normal ${o.cls}`}>{o.label}</Badge>
  } else if (m.type === 'artifact') {
    Icon = Package; iconCls = 'text-violet-600'
    verb = 'published'; detail = m.body
    badge = meta.filename ? <Badge variant="outline" className="max-w-[40%] px-1.5 py-0 text-[10px] font-normal">{meta.filename}</Badge> : null
  } else if (m.type === 'approval') {
    // cancelled = the session ended before a human decided — a neutral "never ran", not a rejection.
    const cancelledA = m.status === 'cancelled'
    Icon = m.status === 'approved' ? CheckCircle2 : XCircle
    iconCls = m.status === 'approved' ? 'text-emerald-600' : cancelledA ? 'text-muted-foreground' : 'text-red-600'
    verb = <>{m.title}{m.resolvedBy && !cancelledA && <span className="inline-flex items-center gap-1 text-muted-foreground"> · by <PrincipalTag id={m.resolvedBy} members={members} /></span>}</>
    badge = cancelledA
      ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">cancelled</Badge>
      : <Badge variant={m.status === 'approved' ? 'default' : 'destructive'} className="px-1.5 py-0 text-[10px]">{m.status}</Badge>
  } else if (m.type === 'question') {
    Icon = HelpCircle; iconCls = 'text-sky-600'
    const cancelled = m.status === 'cancelled'
    verb = cancelled ? 'asked — dismissed unanswered' : 'asked'; detail = m.body
    if (cancelled) badge = <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">dismissed</Badge>
    extra = m.answer ? <div className="mt-1 rounded bg-muted px-2 py-1 text-xs"><span className="mr-1 inline-flex items-center gap-1 text-muted-foreground">{m.answeredBy ? <><PrincipalTag id={m.answeredBy} members={members} />:</> : 'answer:'}</span>{m.answer}</div> : null
  } else if (isImportant(m)) {
    Icon = AlertTriangle; iconCls = 'text-amber-600'; highlight = true
    detail = m.body
    badge = <Badge variant="outline" className="border-amber-300 px-1.5 py-0 text-[10px] font-normal text-amber-700">important</Badge>
  } else if (m.type === 'skill.proposed') {
    Icon = Sparkles; iconCls = 'text-violet-600'; highlight = true
    verb = 'proposed a skill'; detail = m.body
    badge = <Badge variant="outline" className="border-violet-300 px-1.5 py-0 text-[10px] font-normal text-violet-700">review in Skills</Badge>
  } else if (m.type === 'update') {
    Icon = Activity; iconCls = 'text-muted-foreground'
    detail = m.body
  } else if (m.type === 'task' && meta.taskId) {
    // A Tasks lifecycle card (assigned to you / blocked / done). Headline = event title (via sessionName);
    // the muted line carries the task title (m.body). Blocked is highlighted — it needs a human.
    Icon = ListChecks; iconCls = meta.event === 'blocked' ? 'text-amber-600' : meta.event === 'done' ? 'text-emerald-600' : 'text-sky-600'
    highlight = meta.event === 'blocked'
    detail = m.body
    badge = <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">task</Badge>
  } else {
    // legacy 'task' (started) rows from older runs — kept renderable
    Icon = Rocket; iconCls = 'text-muted-foreground'
    verb = 'started'; detail = m.body
  }

  return (
    <div
      className={`group relative flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-muted/50 ${highlight ? 'bg-amber-50/40' : ''}`}
    >
      {/* Stretched-link overlay: makes the whole row a real anchor (right-click / ⌘-click / middle-
          click → open in new tab) while the dismiss button below opts back on top via `z-10`. */}
      <a href={rowHref} onClick={onNavClick(rowAction)} className="absolute inset-0 z-0" aria-label="open" />
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${unread ? 'bg-primary' : 'bg-transparent'}`} />
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconCls}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm leading-snug">
          <span className="min-w-0 truncate font-medium">{sessionName(m)}</span>
          {badge}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Bot className="h-3 w-3 shrink-0" />
          <span className="max-w-[50%] shrink-0 truncate">{m.agent}</span>
          {verb && <span className="min-w-0 truncate">· {verb}</span>}
          {detail && <span className="min-w-0 truncate">· {detail}</span>}
        </div>
        {extra}
      </div>
      <div className="relative z-10 shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
        <span className={onDismiss ? 'group-hover:invisible' : undefined}>{timeAgo(m.createdAt)}</span>
        {onDismiss && (
          <button
            className="absolute right-0 top-0 hidden rounded p-0.5 hover:bg-muted hover:text-foreground group-hover:block"
            onClick={(e) => { e.stopPropagation(); onDismiss(m.id) }}
            title="dismiss from inbox"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// Connectors UI lives in ./connectors.tsx (ConnectorsPage imported above). The "Connections" page
// wraps it with a **Creds** sub-tab — the workspace platform-credential editor (formerly Settings →
// Integrations) — so "what an agent can reach" and "the keys that power it" live in one place. The
// active sub-tab is the hash detail (`#/connectors/creds`), mirroring how SettingsPage tabs work.
function ConnectionsPage({ me, tab, onTab }: { me: Member | null; tab: string; onTab: (t: 'connected' | 'creds') => void }) {
  // Creds (the platform-credential editor) is owner/admin-only — as it was under Settings. Members see
  // only the Connected list, so a stray `#/connectors/creds` falls back rather than showing a dead tab.
  const isAdmin = me?.role === 'owner' || me?.role === 'admin'
  const active: 'connected' | 'creds' = tab === 'creds' && isAdmin ? 'creds' : 'connected'
  return (
    <div className="max-w-4xl space-y-4">
      {isAdmin && (
        <div className="inline-flex gap-1 rounded-lg border bg-background p-1">
          {([['connected', 'Connected'], ['creds', 'Creds']] as const).map(([v, label]) => (
            <a
              key={v}
              href={navHref('connectors', v)}
              onClick={onNavClick(() => onTab(v))}
              className={`rounded-md px-3 py-1 text-xs no-underline transition-colors ${active === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </a>
          ))}
        </div>
      )}
      {active === 'creds' && me ? <IntegrationsSettings me={me} /> : <ConnectorsPage me={me} />}
    </div>
  )
}
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
      {help && <div className="mt-1 text-[11px] text-muted-foreground">{help}</div>}
    </div>
  )
}

// ── Files ──────────────────────────────────────────────────────────────────────
const fmtSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** Browse + edit files in the instance's data home. The server confines every path to the
 *  home root; navigation (folders/breadcrumb) + a text editor, plus upload (button or drag-drop),
 *  download, new-folder and delete. */
function FilesPage({ initialDir }: { initialDir?: string }) {
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const loadDir = (rel: string, fallbackHome = false) => {
    setHint('')
    api.files.list(rel).then((d) => {
      if (d.error) {
        // A deep link to a folder that doesn't exist (e.g. a bundled agent living outside the
        // data home) still lands somewhere useful — drop to the home root and explain.
        if (fallbackHome && rel) {
          api.files.list('').then((r) => { if (!r.error) { setListing(r); setDir(r.path) } })
          return setHint(`⚠ ${rel}: ${d.error}`)
        }
        return setHint('⚠ ' + d.error)
      }
      setListing(d); setDir(d.path)
    })
  }
  // Open the deep-linked folder (`#/files/<path>`) on mount / when the link changes; '' = home root.
  useEffect(() => { loadDir(initialDir || '', true) }, [initialDir])
  const reload = () => loadDir(dir)

  const join = (name: string) => (dir ? `${dir}/${name}` : name)
  const open = (name: string) => {
    const rel = join(name)
    setHint('')
    api.files.read(rel).then((f) => {
      if (f.error) return setHint('⚠ ' + f.error)
      setOpenPath(rel); setFile(f); setContent(f.content ?? '')
    })
  }
  const save = async () => {
    if (!openPath) return
    setBusy(true); setHint('')
    const r = await api.files.write(openPath, content)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setFile((f) => (f ? { ...f, content } : f))
    setHint('saved'); setTimeout(() => setHint(''), 1500)
  }

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    // A folder pick (webkitdirectory) or a directory drag sets `webkitRelativePath` (e.g.
    // "runbooks/escalation.md") — forward it so the whole tree is recreated under `dir`.
    const withRel = list.map((f) => ({ f, rel: (f as File & { webkitRelativePath?: string }).webkitRelativePath || '' }))
    const foldered = withRel.some((x) => x.rel.includes('/'))
    setBusy(true); setHint(`uploading ${list.length} ${foldered ? 'item' : 'file'}${list.length === 1 ? '' : 's'}…`)
    let ok = 0; let err = ''
    for (const { f, rel } of withRel) {
      const r = await api.files.upload(dir, f, rel || undefined)
      if (r.error) err = r.error; else ok++
    }
    setBusy(false)
    setHint(err ? `⚠ ${err}` : `uploaded ${ok} file${ok === 1 ? '' : 's'}`)
    if (!err) setTimeout(() => setHint(''), 1500)
    reload()
  }

  const newFolder = async () => {
    const name = prompt('New folder name')?.trim()
    if (!name) return
    setBusy(true); setHint('')
    const r = await api.files.mkdir(join(name))
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    reload()
  }

  const newFile = async () => {
    const name = prompt('New file name')?.trim()
    if (!name) return
    const rel = join(name)
    setBusy(true); setHint('')
    const r = await api.files.create(rel)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    reload()
    // open the fresh (empty) file straight into the editor
    setOpenPath(rel); setFile({ path: rel, content: '', size: 0 }); setContent('')
  }

  const removeEntry = async (e: FileEntry) => {
    const what = e.type === 'dir' ? 'folder (and everything in it)' : 'file'
    if (!confirm(`Delete ${what} "${e.name}"? This cannot be undone.`)) return
    setBusy(true); setHint('')
    const rel = join(e.name)
    const r = await api.files.remove(rel)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    if (openPath === rel) { setOpenPath(null); setFile(null); setContent('') }
    reload()
  }

  const onDrop = (ev: ReactDragEvent) => {
    ev.preventDefault(); dragDepth.current = 0; setDragging(false)
    if (ev.dataTransfer.files?.length) void uploadFiles(ev.dataTransfer.files)
  }

  const segments = dir ? dir.split('/') : []
  const parent = segments.slice(0, -1).join('/')
  const dirty = file?.content !== undefined && content !== file.content

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Browse, edit and manage files in this instance's data home
        {listing && <> (<span className="font-mono text-xs">{listing.root}</span>)</>} — its agents, policy,
        audit logs and connector configs. Confined to the home; upload, download, create folders and delete here.
      </p>

      {/* breadcrumb + toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-0.5 text-sm">
          <button className="rounded px-1.5 py-0.5 font-medium hover:bg-muted" onClick={() => loadDir('')}>home</button>
          {segments.map((s, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <button className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => loadDir(segments.slice(0, i + 1).join('/'))}>{s}</button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={newFile} disabled={busy}>
            <FileIcon className="h-3.5 w-3.5" /> New file
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={newFolder} disabled={busy}>
            <FolderPlus className="h-3.5 w-3.5" /> New folder
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => fileInput.current?.click()} disabled={busy}>
            <Upload className="h-3.5 w-3.5" /> Upload
          </Button>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => folderInput.current?.click()} disabled={busy} title="upload a whole folder (its subfolders are recreated here)">
            <FolderPlus className="h-3.5 w-3.5" /> Upload folder
          </Button>
          <input ref={fileInput} type="file" multiple className="hidden"
            onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.currentTarget.value = '' }} />
          {/* webkitdirectory = OS folder picker; each File carries a webkitRelativePath the server rebuilds under `dir`. */}
          <input ref={folderInput} type="file" multiple className="hidden"
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.currentTarget.value = '' }} />
        </div>
      </div>
      {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}

      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        {/* directory listing — drop a file anywhere here to upload into the current folder */}
        <div
          className={`relative h-fit divide-y rounded-lg border ${dragging ? 'ring-2 ring-primary ring-offset-2' : ''}`}
          onDragEnter={(e) => { e.preventDefault(); dragDepth.current++; setDragging(true) }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDragLeave={(e) => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
          onDrop={onDrop}
        >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-primary/10 text-sm font-medium text-primary">
              <Upload className="mr-1.5 h-4 w-4" /> Drop to upload here
            </div>
          )}
          {dir && (
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => loadDir(parent)}>
              <Folder className="h-4 w-4 shrink-0" /> ..
            </button>
          )}
          {listing && listing.entries.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">Empty folder — drop files here to upload.</div>}
          {listing?.entries.map((e) => {
            const isOpen = openPath === join(e.name)
            return (
              <div key={e.name} className={`group flex items-center gap-1 pr-1.5 hover:bg-muted ${isOpen ? 'bg-muted' : ''}`}>
                <button
                  disabled={e.type === 'other'}
                  onClick={() => (e.type === 'dir' ? loadDir(join(e.name)) : open(e.name))}
                  className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm disabled:opacity-50"
                >
                  {e.type === 'dir'
                    ? <Folder className="h-4 w-4 shrink-0 text-sky-600" />
                    : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  <span className={`min-w-0 flex-1 truncate ${isOpen ? 'font-medium text-primary' : ''}`}>{e.name}</span>
                  {e.type === 'file' && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(e.size)}</span>}
                </button>
                <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                  {e.type === 'file' && (
                    <a href={api.files.downloadUrl(join(e.name))} download={e.name} title="download"
                      className="rounded p-1 text-muted-foreground hover:bg-neutral-200 hover:text-foreground dark:hover:bg-neutral-700">
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {e.type !== 'other' && (
                    <button title="delete" onClick={() => removeEntry(e)}
                      className="rounded p-1 text-muted-foreground hover:bg-neutral-200 hover:text-red-500 dark:hover:bg-neutral-700">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* viewer / editor */}
        <div className="min-w-0">
          {!openPath ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Select a file to view or edit.</div>
          ) : file?.binary ? (
            <div className="rounded-lg border p-4 text-sm text-muted-foreground">Binary file — {fmtSize(file.size)}. Not editable here.</div>
          ) : file?.tooLarge ? (
            <div className="rounded-lg border p-4 text-sm text-muted-foreground">File is {fmtSize(file.size)} — too large to edit (2 MB max).</div>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">{openPath}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(content.length)}</span>
                </div>
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (dirty) save() } }}
                  className="min-h-[460px] font-mono text-xs leading-relaxed"
                  spellCheck={false}
                />
                <Button size="sm" onClick={save} disabled={busy || !dirty}><Save className="mr-1 h-4 w-4" />{dirty ? 'Save' : 'Saved'}</Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Artifacts (the deliverables gallery) ────────────────────────────────────────
const isImageMime = (m: string) => m.startsWith('image/')
const isVideoMime = (m: string) => m.startsWith('video/')
const isPdfMime = (m: string) => m === 'application/pdf'
const isMarkdownArt = (a: Artifact) => a.mime.startsWith('text/markdown') || /\.(md|markdown)$/i.test(a.filename)
const isTextMime = (m: string) => m.startsWith('text/') || m === 'application/json'

/** Tailwind has no typography plugin here, so map Markdown elements to readable styled ones. */
const mdComponents = {
  h1: (p: any) => <h1 className="mb-3 mt-4 text-xl font-semibold" {...p} />,
  h2: (p: any) => <h2 className="mb-2 mt-4 text-lg font-semibold" {...p} />,
  h3: (p: any) => <h3 className="mb-2 mt-3 text-base font-semibold" {...p} />,
  p: (p: any) => <p className="my-2 leading-relaxed" {...p} />,
  ul: (p: any) => <ul className="my-2 list-disc space-y-1 pl-5" {...p} />,
  ol: (p: any) => <ol className="my-2 list-decimal space-y-1 pl-5" {...p} />,
  li: (p: any) => <li className="leading-relaxed" {...p} />,
  a: (p: any) => <a className="text-primary underline" target="_blank" rel="noreferrer" {...p} />,
  blockquote: (p: any) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...p} />,
  code: ({ inline, ...p }: any) => inline
    ? <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]" {...p} />
    : <code className="font-mono text-xs" {...p} />,
  pre: (p: any) => <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs" {...p} />,
  table: (p: any) => <table className="my-2 w-full border-collapse text-sm" {...p} />,
  th: (p: any) => <th className="border px-2 py-1 text-left font-medium" {...p} />,
  td: (p: any) => <td className="border px-2 py-1" {...p} />,
  img: (p: any) => <img className="my-2 max-w-full rounded" {...p} />,
}

/**
 * A collapsible folder tree built from a flat list of '/'-separated path strings. Folders are implicit
 * — one exists because an item lives in it (same model as KB sections). Selecting a folder calls
 * `onSelect(path)`; '' selects the root ("All"). Presentational: the parent owns the selection + does
 * the actual filtering. Shared by the Artifacts gallery and the Knowledge Base. Renders nothing when
 * nothing is filed into a folder yet (a flat, folderless store shows no tree).
 */
function FolderNav({ paths, selected, onSelect, rootLabel = 'All' }: {
  paths: string[]
  selected: string
  onSelect: (path: string) => void
  rootLabel?: string
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Every prefix of every path is a folder node.
  const nodes = new Set<string>()
  for (const p of paths) {
    if (!p) continue
    const segs = p.split('/')
    for (let i = 1; i <= segs.length; i++) nodes.add(segs.slice(0, i).join('/'))
  }
  const within = (base: string) => paths.filter((p) => p === base || p.startsWith(base + '/')).length
  const childrenOf = (parent: string) =>
    [...nodes].filter((n) => (parent === '' ? !n.includes('/') : n.startsWith(parent + '/') && !n.slice(parent.length + 1).includes('/'))).sort()
  const toggle = (n: string) => setCollapsed((c) => { const s = new Set(c); s.has(n) ? s.delete(n) : s.add(n); return s })

  const roots = childrenOf('')
  if (roots.length === 0) return null

  const Row = ({ node, depth }: { node: string; depth: number }) => {
    const kids = childrenOf(node)
    const open = !collapsed.has(node)
    const active = selected === node
    return (
      <div>
        <div className={`flex items-center gap-1 rounded pr-1 text-xs ${active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`} style={{ paddingLeft: depth * 12 }}>
          {kids.length > 0
            ? <button onClick={() => toggle(node)} className="flex h-5 w-4 shrink-0 items-center justify-center" title={open ? 'collapse' : 'expand'}><ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} /></button>
            : <span className="w-4 shrink-0" />}
          <button onClick={() => onSelect(node)} className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left" title={node}>
            <Folder className="h-3 w-3 shrink-0" /><span className="truncate">{node.split('/').pop()}</span>
            <span className="ml-auto shrink-0 text-[10px] opacity-60">{within(node)}</span>
          </button>
        </div>
        {open && kids.map((k) => <Row key={k} node={k} depth={depth + 1} />)}
      </div>
    )
  }

  return (
    <div className="space-y-0.5 rounded-lg border p-1.5">
      <button onClick={() => onSelect('')} className={`flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs ${selected === '' ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>
        <FolderTree className="h-3 w-3 shrink-0" /><span>{rootLabel}</span><span className="ml-auto text-[10px] opacity-60">{paths.length}</span>
      </button>
      {roots.map((r) => <Row key={r} node={r} depth={0} />)}
    </div>
  )
}

function ArtifactIcon({ a, className }: { a: Artifact; className?: string }) {
  if (isPdfMime(a.mime)) return <FileText className={className ?? 'h-4 w-4 text-red-500'} />
  if (isImageMime(a.mime)) return <ImageIcon className={className ?? 'h-4 w-4 text-sky-500'} />
  if (isVideoMime(a.mime)) return <Film className={className ?? 'h-4 w-4 text-orange-500'} />
  if (isMarkdownArt(a)) return <FileText className={className ?? 'h-4 w-4 text-violet-500'} />
  return <FileIcon className={className ?? 'h-4 w-4 text-muted-foreground'} />
}

/** Renders an artifact's contents by type: image inline, video in a player, PDF in an iframe,
 *  Markdown rendered, text/JSON in a pre, anything else a download prompt. */
function ArtifactBody({ a }: { a: Artifact }) {
  const raw = api.artifactRawUrl(a.id)
  const [text, setText] = useState<string | null>(null)
  const wantsText = isMarkdownArt(a) || isTextMime(a.mime)
  useEffect(() => {
    if (!wantsText) { setText(null); return }
    let live = true
    fetch(raw).then((r) => r.text()).then((t) => { if (live) setText(t) }).catch(() => { if (live) setText('(could not load file)') })
    return () => { live = false }
  }, [a.id])

  if (isImageMime(a.mime)) return <img src={raw} alt={a.title} className="max-h-[70vh] max-w-full rounded-lg border" />
  if (isVideoMime(a.mime)) return <video src={raw} controls className="max-h-[72vh] w-full rounded-lg border bg-black" />
  if (isPdfMime(a.mime)) return <iframe src={raw} title={a.title} className="h-[72vh] w-full rounded-lg border" />
  if (wantsText) {
    if (text === null) return <div className="text-sm text-muted-foreground">Loading…</div>
    if (isMarkdownArt(a)) return <div className="max-w-3xl text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown></div>
    return <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{text}</pre>
  }
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      <ArtifactIcon a={a} className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
      No inline preview for this file type.
      <div className="mt-3"><a href={raw} download={a.filename}><Button size="sm" variant="secondary"><Download className="mr-1 h-4 w-4" />Download {a.filename}</Button></a></div>
    </div>
  )
}

function ArtifactsPage({ me, permalink, nav }: { me: Member; permalink: string; nav: (r: Route, detail?: string) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [enabled, setEnabled] = useState(true)
  const [agentFilter, setAgentFilter] = useState('')
  const [folder, setFolder] = useState('')
  const [hint, setHint] = useState('')

  const load = () => api.artifacts().then((r) => { setArtifacts(r.artifacts ?? []); setEnabled(r.enabled !== false) })
  useEffect(() => { load() }, [])

  // The URL is the source of truth for the open artifact: `#/artifacts/<id>` deep-links to one
  // deliverable (shareable, back/forward, and the Inbox 'artifact' card links straight here).
  const sel = permalink || undefined
  const agents = Array.from(new Set(artifacts.map((a) => a.agent))).sort()
  const inFolder = (f: string) => folder === '' || f === folder || f.startsWith(folder + '/')
  const shown = artifacts.filter((a) => (!agentFilter || a.agent === agentFilter) && inFolder(a.folder || ''))
  const selected = artifacts.find((a) => a.id === sel)

  const remove = async (id: string) => {
    if (!confirm('Delete this artifact? Its snapshotted file is permanently removed (the audit log is kept).')) return
    const r = await api.deleteArtifact(id)
    if (r.error) { setHint('⚠ ' + r.error); return }
    if (sel === id) nav('artifacts')
    load()
  }

  const move = async (a: Artifact) => {
    const to = window.prompt('Move to folder (e.g. reports/2024; nest with "/", blank = root):', a.folder || '')
    if (to === null) return
    const r = await api.moveArtifact(a.id, to.trim())
    if (r.error || !r.ok) { setHint('⚠ ' + (r.error ?? 'move failed')); return }
    load()
  }

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Deliverables your agents have published — PDFs, Markdown, images. Each is a snapshot taken at
        publish time. {me.role === 'member' ? 'You see artifacts from sessions you started.' : 'Owners and admins see every artifact.'}
        {!enabled && <span className="text-amber-600"> (no data home configured — publishing is disabled)</span>}
      </p>

      {agents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setAgentFilter('')} className={`rounded-full border px-2.5 py-0.5 text-xs ${agentFilter === '' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>All</button>
          {agents.map((ag) => (
            <button key={ag} onClick={() => setAgentFilter(ag)} className={`rounded-full border px-2.5 py-0.5 text-xs ${agentFilter === ag ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>{ag}</button>
          ))}
        </div>
      )}
      {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}

      <div className="grid gap-3 lg:grid-cols-[minmax(260px,340px)_1fr]">
        {/* gallery list */}
        <div className="space-y-2">
          <FolderNav paths={artifacts.map((a) => a.folder || '')} selected={folder} onSelect={setFolder} rootLabel="All artifacts" />
          {folder && <div className="flex items-center gap-1 px-0.5 text-[11px] text-muted-foreground"><Folder className="h-3 w-3" /><span className="font-mono">{folder}/</span><button className="ml-auto underline hover:text-foreground" onClick={() => setFolder('')}>clear</button></div>}
          {shown.length === 0 && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{folder ? <>No artifacts in <span className="font-mono">{folder}/</span>.</> : <>No artifacts yet. When an agent calls its <span className="font-mono">publish</span> tool, the deliverable shows up here.</>}</div>}
          {shown.map((a) => {
            const active = a.id === sel
            return (
              <a key={a.id} href={navHref('artifacts', a.id)} onClick={onNavClick(() => nav('artifacts', a.id))} className={`block w-full overflow-hidden rounded-lg border text-left text-foreground no-underline transition hover:border-primary/50 ${active ? 'border-primary ring-1 ring-primary/30' : ''}`}>
                <div className="flex items-start gap-2.5 p-2.5">
                  {isImageMime(a.mime)
                    ? <img src={api.artifactRawUrl(a.id)} alt="" className="h-10 w-10 shrink-0 rounded border object-cover" />
                    : isVideoMime(a.mime)
                    ? <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border bg-black">
                        <video src={`${api.artifactRawUrl(a.id)}#t=0.1`} preload="metadata" muted className="h-full w-full object-cover" />
                        <Play className="absolute h-3.5 w-3.5 fill-white/90 text-white/90" />
                      </span>
                    : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted"><ArtifactIcon a={a} className="h-4 w-4 text-muted-foreground" /></span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{a.agent}</Badge>
                      <span className="truncate font-mono">{a.filename}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{fmtSize(a.bytes)} · {new Date(a.createdAt).toLocaleString()}</div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>

        {/* preview */}
        <div className="min-w-0">
          {selected ? (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><ArtifactIcon a={selected} className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate text-sm font-medium">{selected.title}</span></div>
                    {selected.description && <div className="mt-0.5 text-xs text-muted-foreground">{selected.description}</div>}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{selected.agent}</Badge>
                      <span className="font-mono">{selected.filename}</span>
                      {selected.folder && <span className="inline-flex items-center gap-0.5"><Folder className="h-3 w-3" /><span className="font-mono">{selected.folder}/</span></span>}
                      <span>· {fmtSize(selected.bytes)}</span>
                      <span>· session <span className="font-mono">{selected.sessionId}</span></span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <a href={api.artifactRawUrl(selected.id)} download={selected.filename}><Button size="sm" variant="secondary"><Download className="mr-1 h-4 w-4" />Download</Button></a>
                    {(me.role === 'owner' || me.role === 'admin' || selected.source === me.id) && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => move(selected)} title="Move to a folder"><FolderPlus className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(selected.id)}><Trash2 className="h-4 w-4" /></Button>
                      </>
                    )}
                  </div>
                </div>
                <ArtifactBody a={selected} />
              </CardContent>
            </Card>
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">Select an artifact to preview it.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Login ────────────────────────────────────────────────────────────────────────
function LoginScreen({ accent }: { accent?: string }) {
  // Tenant accent (when set) tints the primary Sign-in button so even the pre-login screen is
  // identifiable across several tenants; falls back to the default primary styling otherwise.
  const brandStyle = accent ? { backgroundColor: accent, color: readableOn(accent) } : undefined
  const [value, setValue] = useState('')
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)
  const invalid = /[?&]login=invalid/.test(window.location.href)
  // Accept either a full magic link or a bare token; navigate to the server-side /accept route.
  const go = () => {
    const v = value.trim()
    if (!v) return
    const token = v.includes('token=') ? v.split('token=')[1].split(/[&\s]/)[0] : v
    window.location.href = '/accept?token=' + encodeURIComponent(token)
  }
  // Self-service recovery. The server responds neutrally (no account enumeration), so we always show the
  // same "if that's a member, a link is on its way" confirmation.
  const requestLink = async () => {
    if (!email.trim() || sending) return
    setSending(true)
    try { await api.requestLink(email.trim()) } catch { /* neutral either way */ }
    setSending(false)
    setSent(true)
  }
  return (
    <div className="flex h-screen items-center justify-center bg-muted/30">
      <Card className="w-full max-w-md">
        <CardContent className="p-6">
          <div className="mb-1 flex items-center gap-2 text-lg font-semibold">⚙️ Agent OS</div>
          <p className="mb-4 text-sm text-muted-foreground">
            Access is by invite. Paste the magic-link (or token) you were sent to sign in — or, if you've
            signed in before, request a fresh link by email below.
          </p>
          {invalid && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">That link is invalid or expired — request a fresh one below.</div>}
          <Field label="Magic link or token">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/accept?token=…" onKeyDown={(e) => e.key === 'Enter' && go()} />
          </Field>
          <Button className="mt-4 w-full" style={brandStyle} onClick={go} disabled={!value.trim()}>Sign in</Button>

          <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />lost your link?<div className="h-px flex-1 bg-border" />
          </div>

          {sent ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              If <span className="font-medium">{email.trim()}</span> is a member, a fresh sign-in link is on its
              way to their linked Slack/Discord. Ask the workspace owner if nothing arrives.
            </div>
          ) : (
            <>
              <Field label="Send me a sign-in link">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" onKeyDown={(e) => e.key === 'Enter' && requestLink()} />
              </Field>
              <Button variant="outline" className="mt-3 w-full" onClick={requestLink} disabled={!email.trim() || sending}>{sending ? 'Sending…' : 'Email me a link'}</Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Team ─────────────────────────────────────────────────────────────────────────
function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={link} className="font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={async () => { await copyText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
      >
        <Copy className="mr-1 h-3.5 w-3.5" />{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** Copy to clipboard with a fallback for non-secure contexts (plain HTTP on a non-localhost host,
 *  e.g. a Tailscale hostname), where `navigator.clipboard` is undefined. Returns whether it worked. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CopyBlock({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  return (
    <div className="relative">
      <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 pr-20 font-mono text-[11px] leading-relaxed whitespace-pre">{text}</pre>
      <Button
        size="sm"
        variant="outline"
        className="absolute right-2 top-2 h-7"
        onClick={async () => { const ok = await copyText(text); setState(ok ? 'ok' : 'fail'); setTimeout(() => setState('idle'), 2000) }}
      >
        <Copy className="mr-1 h-3.5 w-3.5" />{state === 'ok' ? 'Copied' : state === 'fail' ? 'Select + ⌘C' : label}
      </Button>
    </div>
  )
}

// The Slack app manifest (JSON — https://docs.slack.dev/reference/app-manifest/). Enables Socket Mode
// (no public URL), the bot scopes the OS needs, and the events we route. Pasted into the manifest
// editor, or pre-filled via the create-app deep link below (?new_app=1&manifest_json=…).
//
// The `message.*` events (+ their `*:history` scopes) are what let a plain in-thread reply reach the
// bot — without them Slack only delivers explicit `app_mention`s, so a thread follow-up never arrives
// and thread-continuity can't fire. `channels:read`/`groups:read` back channel-name lookup, `channels:join`
// lets the bot auto-join a public channel to post, and `im:write` opens DMs.
const SLACK_MANIFEST_OBJ = {
  display_information: { name: 'Agent OS' },
  features: { bot_user: { display_name: 'Agent OS', always_online: true } },
  oauth_config: {
    scopes: {
      bot: [
        'app_mentions:read',
        'chat:write',
        'channels:read', 'channels:join', 'channels:history',
        'groups:read', 'groups:history',
        'im:write', 'im:history',
        'mpim:history',
        'users:read', 'users:read.email',
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim'],
    },
    interactivity: { is_enabled: false },
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
}
const SLACK_MANIFEST = JSON.stringify(SLACK_MANIFEST_OBJ, null, 2)
// Slack's create-from-manifest deep link: opens "Create New App" with this manifest pre-loaded.
const SLACK_NEW_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_MANIFEST_OBJ))}`

function SlackSetupGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        Setup steps — create the Slack app (~3 min)
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              <strong className="text-foreground">Create the app from the manifest.</strong> Click below — it opens Slack's
              "Create New App" with everything pre-filled; just pick your workspace and confirm.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a href={SLACK_NEW_APP_URL} target="_blank" rel="noreferrer">
                  <Button size="sm"><Plus className="mr-1 h-3.5 w-3.5" />Create Slack app</Button>
                </a>
                <span className="text-[11px]">— or paste the manifest manually at <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer" className="font-medium text-foreground underline">api.slack.com/apps</a> → Create New App → From a manifest (JSON):</span>
              </div>
              <div className="mt-2"><CopyBlock text={SLACK_MANIFEST} label="Copy JSON" /></div>
            </li>
            <li>Create the app, then <strong>Install to Workspace</strong> and approve. Invite the bot to any channel you want it to watch (<code className="text-[11px]">/invite @Agent OS</code>).</li>
            <li>
              <strong>Basic Information → App-Level Tokens → Generate Token</strong>. Add the <code className="text-[11px]">connections:write</code> scope.
              Copy the <code className="text-[11px]">xapp-…</code> token into <strong>App-level token</strong> below.
            </li>
            <li>
              <strong>OAuth &amp; Permissions → Bot User OAuth Token</strong>. Copy the <code className="text-[11px]">xoxb-…</code> token into <strong>Bot token</strong> below, then <strong>Save</strong>.
            </li>
            <li>The status badge above flips to <strong className="text-emerald-600">connected</strong> within a second or two. Then add a <strong>Slack message</strong> automation on the Automations page.</li>
          </ol>
          <p className="border-t pt-2">
            The manifest already enables <strong>Socket Mode</strong> and subscribes to <code className="text-[11px]">app_mention</code> plus the
            <code className="text-[11px]"> message.*</code> events — so plain replies inside a thread reach the bot too (not just @mentions),
            which is what lets it keep a conversation going. Remember to <strong>invite the bot to the channel</strong> — <code className="text-[11px]">message.channels</code> only
            fires where it's a member. No request URL or public endpoint is needed; the server dials out to Slack.
          </p>
        </div>
      )}
    </div>
  )
}

// Discord's analogue of the Slack setup guide. Discord has no app manifest deep-link, so it's a short
// portal walkthrough: create the app, enable the MESSAGE CONTENT privileged intent, copy the bot token,
// and invite the bot with the right scopes. The server then dials out over the Gateway — no public URL.
const DISCORD_BOT_PERMISSIONS = '274877991936' // View Channels + Send Messages + Read Message History
function DiscordSetupGuide() {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        Setup steps — create the Discord bot (~3 min)
      </button>
      {open && (
        <div className="space-y-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <ol className="list-decimal space-y-2 pl-4">
            <li>
              <strong className="text-foreground">Create the application.</strong> Open the
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="mx-1 font-medium text-foreground underline">Discord Developer Portal</a>
              → <strong>New Application</strong> → name it "Agent OS".
            </li>
            <li><strong>Bot</strong> tab → <strong>Reset Token</strong> → copy it into <strong>Bot token</strong> below.</li>
            <li>
              On the same <strong>Bot</strong> tab, under <strong>Privileged Gateway Intents</strong>, turn ON
              <strong> MESSAGE CONTENT INTENT</strong> (and Server Members if you'll map members later), then save. Without it the
              bot receives empty message text.
            </li>
            <li><strong>Save</strong> the bot token below. The status badge flips to <strong className="text-emerald-600">connected</strong> within a second or two.</li>
            <li>
              <strong>Invite the bot to your server</strong> with the <strong>Invite bot to your server</strong> button below (it
              appears once the bot connects — the application id is auto-detected — or paste the Application ID to invite before
              connecting). This grants <em>View Channels · Send Messages · Read Message History</em>. <span className="text-foreground">Skipping
              this is the usual "connected but nothing happens" cause</span> — the bot is on the Gateway but in no server, so it sees no messages.
            </li>
            <li>Finally, add a <strong>Discord message</strong> automation on the Automations page — the bot stays silent on a mention unless one matches.</li>
          </ol>
          <p className="border-t pt-2">
            The bot connects over Discord's <strong>Gateway</strong> (an outbound WebSocket) and routes <code className="text-[11px]">mention</code> +
            <code className="text-[11px]"> direct_message</code> events — no request URL or public endpoint needed; the server dials out to Discord.
          </p>
        </div>
      )}
    </div>
  )
}

const PROVIDER_META: Record<IdentityProvider, { label: string; placeholder: string }> = {
  slack: { label: 'Slack user ID', placeholder: 'U0123ABCD' },
  discord: { label: 'Discord user ID', placeholder: '123456789012345678' },
  email: { label: 'Alt email', placeholder: 'name@other.com' },
  github: { label: 'GitHub login', placeholder: 'octocat' },
}

// Per-member identity map editor: the external account ids (Slack/Discord/email/github) that let a chat
// trigger run AS this member. One handle per provider; saved on blur (empty clears it).
function IdentityEditor({ member, identities, onChange }: { member: Member; identities: MemberIdentity[]; onChange: () => void }) {
  const current = (p: IdentityProvider) => identities.find((i) => i.provider === p)?.externalId ?? ''
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(IDENTITY_PROVIDERS.map((p) => [p, current(p)])))
  const [busy, setBusy] = useState('')
  // Re-sync from the server ONLY when the identity VALUES change — not on every render. The parent passes
  // `data.identities?.[m.id] ?? []`, a fresh array each render, so depending on the array reference would
  // re-run this effect on any parent re-render and wipe what the user just typed (the "it clears immediately"
  // bug). Keying on the serialized values makes the reset fire only on a real change.
  const identKey = identities.map((i) => `${i.provider}=${i.externalId}`).sort().join('|')
  useEffect(() => { setVals(Object.fromEntries(IDENTITY_PROVIDERS.map((p) => [p, current(p)]))) }, [identKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (p: IdentityProvider) => {
    const v = (vals[p] ?? '').trim()
    if (v === current(p)) return // no change → skip the round-trip
    setBusy(p)
    await api.setIdentity(member.id, p, v)
    setBusy('')
    onChange()
  }
  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Chat identities — run-as for Slack / Discord triggers</div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {IDENTITY_PROVIDERS.map((p) => (
          <Field key={p} label={PROVIDER_META[p].label}>
            <Input
              value={vals[p] ?? ''}
              onChange={(e) => setVals((s) => ({ ...s, [p]: e.target.value }))}
              onBlur={() => save(p)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              placeholder={PROVIDER_META[p].placeholder}
              className="font-mono text-xs"
              disabled={busy === p}
            />
          </Field>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        When a Slack/Discord message triggers an automation, the OS runs it <strong>as the member whose handle matches the sender</strong>
        {' '}— their connectors + inbox. Slack also falls back to matching the sender's profile email.
      </p>
    </div>
  )
}

function TeamPage({ me, onProfileChange }: { me: Member; onProfileChange: () => void }) {
  const [data, setData] = useState<TeamResp | null>(null)
  const [links, setLinks] = useState<Record<string, string>>({})
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [inviteLink, setInviteLink] = useState('')
  const [hint, setHint] = useState('')
  const [identOpen, setIdentOpen] = useState<Record<string, boolean>>({})

  const load = () => api.team().then(setData)
  useEffect(() => { load() }, [])

  const isOwner = me.role === 'owner'
  const isAdmin = me.role === 'owner' || me.role === 'admin'

  const invite = async () => {
    setHint(''); setInviteLink('')
    const r = await api.invite(email.trim(), role)
    if ('error' in r && r.error) return setHint('⚠ ' + r.error)
    setInviteLink(r.link); setEmail(''); load()
  }
  const loginLink = async (id: string) => {
    const r = await api.loginLink(id)
    if (!('error' in r && r.error)) setLinks((p) => ({ ...p, [id]: r.link }))
  }
  const changeRole = async (id: string, r: Role) => { await api.setRole(id, r); load() }
  const remove = async (id: string) => { await api.removeMember(id); load() }

  const access = (agentId: string) => data!.assignments[agentId] ?? { allowedRoles: [], allowedMembers: [] }
  const toggleRole = async (agentId: string, r: Role) => {
    const cur = access(agentId)
    const allowedRoles = cur.allowedRoles.includes(r) ? cur.allowedRoles.filter((x) => x !== r) : [...cur.allowedRoles, r]
    await api.setAssignment(agentId, { allowedRoles, allowedMembers: cur.allowedMembers }); load()
  }
  const toggleMember = async (agentId: string, mid: string) => {
    const cur = access(agentId)
    const allowedMembers = cur.allowedMembers.includes(mid) ? cur.allowedMembers.filter((x) => x !== mid) : [...cur.allowedMembers, mid]
    await api.setAssignment(agentId, { allowedRoles: cur.allowedRoles, allowedMembers }); load()
  }

  if (!data) return <div className="text-sm text-muted-foreground">Loading…</div>
  const plainMembers = data.members.filter((m) => m.role === 'member')
  const fullAccessCount = data.members.filter((m) => m.role !== 'member').length

  // A one-line, human summary of who can run an agent, given its access row.
  const accessSummary = (agentId: string): string => {
    const acc = access(agentId)
    const parts: string[] = []
    if (fullAccessCount > 0) parts.push(`${fullAccessCount} owner/admin`)
    if (acc.allowedRoles.includes('member')) parts.push('all members')
    else if (acc.allowedMembers.length) parts.push(`${acc.allowedMembers.length} member${acc.allowedMembers.length > 1 ? 's' : ''}`)
    return parts.length ? `Runnable by ${parts.join(' · ')}` : 'Only owners & admins can run this'
  }

  return (
    <div className="max-w-4xl space-y-8">
      {/* Roles legend */}
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          { role: 'owner' as Role, blurb: 'Runs everything, approves red requests, manages the team.' },
          { role: 'admin' as Role, blurb: 'Runs every agent, approves yellow requests, manages the team.' },
          { role: 'member' as Role, blurb: 'Runs only assigned agents. Never approves.' },
        ].map((r) => (
          <div key={r.role} className="rounded-lg border bg-muted/30 p-3">
            <RoleBadge role={r.role} />
            <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{r.blurb}</p>
          </div>
        ))}
      </div>

      {/* Members */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Members</div>
          <div className="text-[11px] text-muted-foreground">{data.members.length} total</div>
        </div>
        <div className="space-y-2">
          {data.members.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <EditableAvatar member={m} canEdit={m.id === me.id || isAdmin} sizeClass="h-8 w-8 text-xs" onChanged={() => { load(); if (m.id === me.id) onProfileChange() }} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <span className="truncate">{m.name}</span>
                      <RoleBadge role={m.role} />
                      {m.status === 'invited' && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">invited</Badge>}
                      {m.id === me.id && <span className="text-[11px] text-muted-foreground">(you)</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isOwner && m.id !== me.id && (
                    <Select value={m.role} onValueChange={(v) => v && changeRole(m.id, v as Role)}>
                      <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="owner">owner</SelectItem>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="member">member</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => setIdentOpen((p) => ({ ...p, [m.id]: !p[m.id] }))}>Chat IDs</Button>
                  )}
                  {isAdmin && (
                    <Button size="sm" variant="outline" onClick={() => loginLink(m.id)}>Login link</Button>
                  )}
                  {isOwner && m.id !== me.id && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="remove" onClick={() => remove(m.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                {isAdmin && identOpen[m.id] && (
                  <div className="w-full">
                    <IdentityEditor member={m} identities={data.identities?.[m.id] ?? []} onChange={load} />
                  </div>
                )}
                {links[m.id] && <div className="w-full"><CopyLink link={links[m.id]} /></div>}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Invite */}
      {isAdmin && (
        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Invite a teammate</div>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="grid grid-cols-[1fr_140px_auto] items-end gap-3">
                <Field label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /></Field>
                <Field label="Role">
                  <Select value={role} onValueChange={(v) => v && setRole(v as Role)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">member</SelectItem>
                      {/* Only an owner can mint admins/owners. */}
                      {isOwner && <SelectItem value="admin">admin</SelectItem>}
                      {isOwner && <SelectItem value="owner">owner</SelectItem>}
                    </SelectContent>
                  </Select>
                </Field>
                <Button onClick={invite} disabled={!email.trim()}><Plus className="mr-1 h-4 w-4" />Invite</Button>
              </div>
              {hint && <div className="font-mono text-xs text-destructive">{hint}</div>}
              {inviteLink && (
                <div>
                  <div className="mb-1 text-[11px] text-muted-foreground">Send this one-time link to the invitee — they confirm on a landing page, so link previews won't consume it:</div>
                  <CopyLink link={inviteLink} />
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {/* Agent access */}
      {isAdmin && (
        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Agent access</div>
          <p className="mb-3 text-xs text-muted-foreground">
            Owners &amp; admins can run every agent. Grant <strong>members</strong> access per agent — toggle
            <span className="mx-1 rounded bg-muted px-1 py-0.5 font-medium text-foreground">All members</span>
            to open it to everyone, or pick people individually.
          </p>
          {data.agents.length === 0 && <div className="text-xs text-muted-foreground">No agents yet.</div>}
          <div className="space-y-2">
            {data.agents.map((a) => {
              const acc = access(a.id)
              const allMembers = acc.allowedRoles.includes('member')
              return (
                <Card key={a.id}>
                  <CardContent className="space-y-2.5 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium"><AgentIcon icon={a.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                      <span className="text-[11px] text-muted-foreground">{accessSummary(a.id)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip on={allMembers} onClick={() => toggleRole(a.id, 'member')}>All members</Chip>
                      <span className="mx-0.5 h-4 w-px bg-border" />
                      {/* Owners/admins always have access — shown as static, non-toggle pills. */}
                      {data.members.filter((m) => m.role !== 'member').map((m) => (
                        <span key={m.id} title={`${m.role}s run every agent`} className="inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/30 px-2.5 py-0.5 text-xs text-muted-foreground">
                          <Check className="h-3 w-3" />{m.name}
                        </span>
                      ))}
                      {/* Plain members — individually assignable (or covered by "All members"). */}
                      {plainMembers.map((m) => (
                        <Chip key={m.id} on={allMembers || acc.allowedMembers.includes(m.id)} onClick={() => toggleMember(a.id, m.id)}>{m.name}</Chip>
                      ))}
                      {plainMembers.length === 0 && <span className="text-[11px] text-muted-foreground">No members to assign yet — invite one above.</span>}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Tasks ──────────────────────────────────────────────────────────────────────
const TASK_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'Todo' },
  { status: 'doing', label: 'Doing' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
]
const PRIORITY_LABEL = ['Urgent', 'High', 'Normal', 'Low']
// Base UI's Select.Value shows the raw value unless the root gets an items map (value → label).
const PRIORITY_ITEMS: Record<string, string> = Object.fromEntries(PRIORITY_LABEL.map((l, i) => [String(i), l]))
const priorityTone = (p: number) => ['text-red-600', 'text-amber-600', 'text-muted-foreground', 'text-muted-foreground/70'][p] ?? 'text-muted-foreground'
// A colored left edge so priority reads at a glance on a dense board (urgent red → low none).
const priorityBorder = (p: number) => ['border-l-red-500', 'border-l-amber-500', 'border-l-transparent', 'border-l-transparent'][p] ?? 'border-l-transparent'

/** Friendly name for a task principal: agent id, member name, or a system/automation actor. */
function principalLabel(id: string | undefined, members: Member[]): string {
  if (!id) return 'Unassigned'
  if (id === 'system') return 'System'
  if (id.startsWith('agent:')) return id.slice('agent:'.length)
  if (id.startsWith('automation:')) return 'Automation'
  return members.find((m) => m.id === id)?.name || members.find((m) => m.id === id)?.email || id
}

/** Due-date presentation: a short relative label + tone, and whether it's overdue (open tasks only). */
function dueMeta(dueAt: number | undefined, status: TaskStatus): { label: string; overdue: boolean; soon: boolean } | null {
  if (!dueAt) return null
  const open = status !== 'done' && status !== 'cancelled'
  const day = 86_400_000
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(dueAt).setHours(0, 0, 0, 0) - startOfToday.getTime()) / day)
  const overdue = open && days < 0
  const soon = open && days >= 0 && days <= 1
  let label: string
  if (days < 0) label = `${-days}d overdue`
  else if (days === 0) label = 'Due today'
  else if (days === 1) label = 'Due tomorrow'
  else if (days <= 7) label = `Due in ${days}d`
  else label = new Date(dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return { label, overdue, soon }
}
/** epoch ms → yyyy-mm-dd for a <input type="date">. */
const toDateInput = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '')
/** yyyy-mm-dd (local) → epoch ms at local midnight, or null when cleared. */
const fromDateInput = (v: string): number | null => (v ? new Date(v + 'T00:00:00').getTime() : null)

function TasksPage({ me, agents, taskId, onOpen, nav }: { me: Member; agents: AgentInfo[]; taskId: string; onOpen: (tmux: string, title: string) => void; nav: (r: Route, detail?: string) => void }) {
  const [members, setMembers] = useState<Member[]>([])
  useEffect(() => { api.team().then((r) => setMembers(r.members ?? [])).catch(() => {}) }, [])
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [counts, setCounts] = useState<Record<TaskStatus, number>>({ todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 })
  const [q, setQ] = useState('')
  // Selection is URL-driven (#/tasks/<id>) so a task detail is a shareable permalink — pasting it opens
  // the modal automatically. Opening a card just navigates; closing clears the detail segment.
  const selId = taskId || null
  const openTask = (id: string) => nav('tasks', id)
  const closeTask = () => { setEditing(false); nav('tasks') }
  const [detail, setDetail] = useState<{ task: Task; events: TaskEvent[]; attachments: TaskAttachment[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  // view + filters
  const [view, setView] = useState<'board' | 'list'>('board')
  const [mine, setMine] = useState(false)
  const [fAssignee, setFAssignee] = useState('') // '' = all
  const [fLabel, setFLabel] = useState('')
  const [fPriority, setFPriority] = useState('') // '' = all
  const [fOverdue, setFOverdue] = useState(false)
  const [sort, setSort] = useState<'priority' | 'due' | 'updated'>('priority')
  // drag-and-drop
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null)
  // create form
  const [showNew, setShowNew] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState('') // '' = unassigned, else 'agent:<id>' or member id
  const [priority, setPriority] = useState(2)
  const [autoDispatch, setAutoDispatch] = useState(false)
  const [mode, setMode] = useState<'headless' | 'interactive'>('headless')
  const [due, setDue] = useState('')
  // drawer inline edit
  const [editing, setEditing] = useState(false)
  const [eTitle, setETitle] = useState('')
  const [eBody, setEBody] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)

  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const chatAgents = agents.filter((a) => a.runtime === 'claude-code')
  const nameOf = (id?: string) => principalLabel(id, members)
  // Assignee glyph: an AGENT shows its OWN icon (from the manifest); a member shows their avatar (or
  // their initial when they haven't uploaded one); anyone/anything else (system, automation, unknown
  // id) falls back to the person glyph.
  const assigneeIcon = (id: string | undefined, cls: string) => {
    if (id?.startsWith('agent:')) return <AgentIcon icon={agents.find((a) => a.id === id.slice('agent:'.length))?.icon} className={cls} />
    const mem = id ? members.find((m) => m.id === id) : undefined
    if (mem) return <MemberAvatar member={mem} className={`${cls} text-[8px]`} />
    return <User className={cls} />
  }
  // An assignee shown as a chip: its icon + friendly name. Used on cards, list rows, and select items.
  const assigneeChip = (id?: string, cls = 'h-3 w-3') => <span className="inline-flex items-center gap-1">{assigneeIcon(id, cls)}{nameOf(id)}</span>

  const load = async () => {
    const r = await api.tasks(q)
    setTasks(r.tasks ?? [])
    if (r.counts) setCounts(r.counts)
  }
  useEffect(() => { load() }, [q])
  // Live refresh so an agent closing its own loop moves the card without a manual reload. Pause while a
  // form/inline-edit is open so it can't clobber unsaved text.
  useEffect(() => {
    const paused = () => showNew || editing
    const t = setInterval(() => { if (!paused()) load() }, 5000)
    return () => clearInterval(t)
  }, [q, showNew, editing])
  useEffect(() => {
    if (!selId) { setDetail(null); return }
    if (editing) return // don't overwrite an in-progress edit on a background refresh
    api.task(selId).then((r) => { if (r.task) setDetail({ task: r.task, events: r.events ?? [], attachments: r.attachments ?? [] }) })
  }, [selId, tasks, editing])
  useEffect(() => { setEditing(false); setConfirmDel(false) }, [selId]) // fresh drawer per selection

  // Client-side filtering over the (≤500) board — cheap, and keeps the lens shareable via UI state.
  const labelsPresent = [...new Set((tasks ?? []).flatMap((t) => t.labels))].sort()
  const assigneesPresent = [...new Set((tasks ?? []).map((t) => t.assignee).filter(Boolean) as string[])]
  const visible = (tasks ?? []).filter((t) => {
    if (mine && t.assignee !== me.id) return false
    if (fAssignee && t.assignee !== fAssignee) return false
    if (fLabel && !t.labels.includes(fLabel)) return false
    if (fPriority !== '' && t.priority !== Number(fPriority)) return false
    if (fOverdue && !dueMeta(t.dueAt, t.status)?.overdue) return false
    return true
  })
  const filterActive = mine || fAssignee || fLabel || fPriority !== '' || fOverdue
  const clearFilters = () => { setMine(false); setFAssignee(''); setFLabel(''); setFPriority(''); setFOverdue(false) }

  const create = async () => {
    setHint('')
    const req: AddTaskReq = { title, body: body || undefined, assignee: assignee || undefined, priority, mode, autoDispatch: autoDispatch && assignee.startsWith('agent:'), dueAt: fromDateInput(due) ?? undefined }
    const r = await api.addTask(req)
    if (r.error) return setHint('⚠ ' + r.error)
    setTitle(''); setBody(''); setAssignee(''); setAutoDispatch(false); setPriority(2); setMode('headless'); setDue(''); setShowNew(false)
    load()
  }
  const patch = async (id: string, b: Parameters<typeof api.patchTask>[1]) => { setBusy(true); await api.patchTask(id, b); await load(); setBusy(false) }
  const dispatch = async (t: Task) => {
    setBusy(true); setHint('')
    const r = await api.dispatchTask(t.id)
    setBusy(false)
    if (!r.ok) return setHint('⚠ ' + (r.error || 'could not dispatch'))
    await load()
    if (r.sessionId) onOpen('aos-' + r.sessionId, 'Task · ' + t.title)
  }
  const remove = async (id: string) => { setBusy(true); await api.deleteTask(id); closeTask(); setConfirmDel(false); await load(); setBusy(false) }
  const onDropTo = async (status: TaskStatus) => {
    const id = dragId
    setDragId(null); setDragOverCol(null)
    const t = tasks?.find((x) => x.id === id)
    if (!t || !id || t.status === status) return
    await patch(id, { status })
  }
  const startEdit = () => { if (!detail) return; setETitle(detail.task.title); setEBody(detail.task.body); setEditing(true) }
  const saveEdit = async () => {
    if (!detail) return
    setBusy(true)
    await api.patchTask(detail.task.id, { title: eTitle, body: eBody })
    setEditing(false); setBusy(false)
    await load()
    const r = await api.task(detail.task.id); if (r.task) setDetail({ task: r.task, events: r.events ?? [], attachments: r.attachments ?? [] })
  }
  // Re-pull the open task's detail (events + attachments) after a mutation that doesn't move columns.
  const refreshDetail = async (id: string) => { const r = await api.task(id); if (r.task) setDetail({ task: r.task, events: r.events ?? [], attachments: r.attachments ?? [] }) }

  if (!tasks) return <div className="text-sm text-muted-foreground">Loading…</div>

  const card = (t: Task) => {
    const dm = dueMeta(t.dueAt, t.status)
    return (
      <div
        key={t.id}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragId(t.id) }}
        onDragEnd={() => { setDragId(null); setDragOverCol(null) }}
        onClick={() => openTask(t.id)}
        className={`w-full cursor-pointer rounded-md border border-l-[3px] p-2.5 text-left hover:bg-muted ${priorityBorder(t.priority)} ${selId === t.id ? 'ring-1 ring-primary' : ''} ${dragId === t.id ? 'opacity-50' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          <a href={navHref('tasks', t.id)} draggable={false} onClick={(e) => { e.stopPropagation(); onNavClick(() => openTask(t.id))(e) }} className={`truncate text-sm font-medium text-foreground no-underline hover:underline ${t.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>{t.title}</a>
          <span className={`shrink-0 text-[10px] font-medium ${priorityTone(t.priority)}`}>{PRIORITY_LABEL[t.priority]}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          {t.assignee && <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">{assigneeIcon(t.assignee, 'h-3 w-3')}{nameOf(t.assignee)}</Badge>}
          {t.autoDispatch && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">auto</Badge>}
          {dm && <span className={`inline-flex items-center gap-0.5 rounded px-1 text-[10px] ${dm.overdue ? 'bg-red-500/15 text-red-600' : dm.soon ? 'text-amber-600' : ''}`}><Clock className="h-2.5 w-2.5" />{dm.label}</span>}
          {t.labels.map((l) => <Badge key={l} variant="outline" className="px-1.5 py-0 text-[10px]">{l}</Badge>)}
          <span className="ml-auto font-mono text-[10px] opacity-60">{t.id}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-xl text-sm text-muted-foreground">
          The shared work queue humans and agents drain together. Assign to an agent with <strong>auto-dispatch</strong> and it
          spawns a governed session that works it and closes its own loop.
        </p>
        <div className="inline-flex overflow-hidden rounded-md border">
          <button onClick={() => setView('board')} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs ${view === 'board' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}><LayoutGrid className="h-3.5 w-3.5" />Board</button>
          <button onClick={() => setView('list')} className={`flex items-center gap-1 border-l px-2.5 py-1.5 text-xs ${view === 'list' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}><List className="h-3.5 w-3.5" />List</button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks…" className="h-8 w-48 pl-7" />
        </div>
        <Button size="sm" onClick={() => setShowNew((v) => !v)}><Plus className="mr-1 h-3.5 w-3.5" />New task</Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="inline-flex overflow-hidden rounded-md border">
          <button onClick={() => setMine(false)} className={`px-2.5 py-1 ${!mine ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>All</button>
          <button onClick={() => setMine(true)} className={`border-l px-2.5 py-1 ${mine ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>My tasks</button>
        </div>
        <Select items={{ all: 'Anyone', ...Object.fromEntries(assigneesPresent.map((a) => [a, nameOf(a)])) }} value={fAssignee || 'all'} onValueChange={(v) => setFAssignee(v === 'all' ? '' : v || '')}>
          <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Anyone</SelectItem>{assigneesPresent.map((a) => <SelectItem key={a} value={a}>{nameOf(a)}</SelectItem>)}</SelectContent>
        </Select>
        {labelsPresent.length > 0 && (
          <Select items={{ all: 'Any label', ...Object.fromEntries(labelsPresent.map((l) => [l, l])) }} value={fLabel || 'all'} onValueChange={(v) => setFLabel(v === 'all' ? '' : v || '')}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Any label</SelectItem>{labelsPresent.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <Select items={{ all: 'Any priority', ...PRIORITY_ITEMS }} value={fPriority === '' ? 'all' : fPriority} onValueChange={(v) => setFPriority(v === 'all' ? '' : v ?? '')}>
          <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Any priority</SelectItem>{PRIORITY_LABEL.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <button onClick={() => setFOverdue((v) => !v)} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${fOverdue ? 'border-red-500 bg-red-500/10 text-red-600' : 'text-muted-foreground'}`}><AlertTriangle className="h-3.5 w-3.5" />Overdue</button>
        {view === 'list' && (
          <Select items={{ priority: 'Sort: Priority', due: 'Sort: Due date', updated: 'Sort: Updated' }} value={sort} onValueChange={(v) => v && setSort(v as typeof sort)}>
            <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="priority">Sort: Priority</SelectItem><SelectItem value="due">Sort: Due date</SelectItem><SelectItem value="updated">Sort: Updated</SelectItem></SelectContent>
          </Select>
        )}
        {filterActive && <button onClick={clearFilters} className="text-muted-foreground underline-offset-2 hover:underline">Clear</button>}
        <span className="ml-auto text-muted-foreground">{visible.length} shown</span>
      </div>

      {showNew && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Fix null-deref in billing.ts" /></Field>
            <Field label="Details"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Context, acceptance criteria — enough for whoever works it." /></Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Assign to">
                <Select value={assignee || 'none'} onValueChange={(v) => setAssignee(!v || v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {chatAgents.map((a) => <SelectItem key={a.id} value={`agent:${a.id}`}><span className="flex items-center gap-1.5"><AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{a.id}</span></SelectItem>)}
                    {members.map((m) => <SelectItem key={m.id} value={m.id}><span className="flex items-center gap-1.5"><MemberAvatar member={m} className="h-4 w-4 text-[8px]" />{m.name || m.email}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Priority">
                <Select items={PRIORITY_ITEMS} value={String(priority)} onValueChange={(v) => v && setPriority(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{PRIORITY_LABEL.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-9" /></Field>
              <Field label="Auto-dispatch">
                <label className={`flex h-9 items-center gap-2 text-sm ${assignee.startsWith('agent:') ? '' : 'opacity-40'}`}>
                  <input type="checkbox" checked={autoDispatch} disabled={!assignee.startsWith('agent:')} onChange={(e) => setAutoDispatch(e.target.checked)} />
                  spawn a session
                </label>
              </Field>
            </div>
            {assignee.startsWith('agent:') && (
              <Field label="Run mode">
                <Select items={{ headless: 'Headless — works to completion, then exits', interactive: 'Interactive — attachable TUI you can watch/drive' }} value={mode} onValueChange={(v) => v && setMode(v as 'headless' | 'interactive')}>
                  <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="headless">Headless — works to completion, then exits</SelectItem>
                    <SelectItem value="interactive">Interactive — attachable TUI you can watch/drive</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!title.trim()} onClick={create}>Create task</Button>
              {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-4">
        {view === 'board' ? (
          <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TASK_COLUMNS.map((col) => {
              const inCol = visible.filter((t) => t.status === col.status || (col.status === 'done' && t.status === 'cancelled'))
              return (
                <div
                  key={col.status}
                  onDragOver={(e) => { e.preventDefault(); if (dragOverCol !== col.status) setDragOverCol(col.status) }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverCol((c) => (c === col.status ? null : c)) }}
                  onDrop={() => onDropTo(col.status)}
                  className={`min-w-0 rounded-md ${dragOverCol === col.status ? 'bg-primary/5 ring-1 ring-primary/40' : ''}`}
                >
                  <div className="mb-2 flex items-center justify-between px-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <span>{col.label}</span><span>{counts[col.status] + (col.status === 'done' ? counts.cancelled : 0)}</span>
                  </div>
                  <div className="space-y-2 px-1 pb-2">
                    {inCol.length === 0 && <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">{dragOverCol === col.status ? 'Drop here' : '—'}</div>}
                    {inCol.map(card)}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex-1 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Task</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Assignee</th>
                  <th className="px-3 py-2 text-left font-medium">Priority</th>
                  <th className="px-3 py-2 text-left font-medium">Due</th>
                  <th className="px-3 py-2 text-left font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {[...visible].sort((a, b) => sort === 'priority' ? a.priority - b.priority || b.updatedAt - a.updatedAt
                  : sort === 'due' ? (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)
                  : b.updatedAt - a.updatedAt).map((t) => {
                  const dm = dueMeta(t.dueAt, t.status)
                  return (
                    <tr key={t.id} onClick={() => openTask(t.id)} className={`cursor-pointer border-b border-l-[3px] last:border-b-0 hover:bg-muted ${priorityBorder(t.priority)} ${selId === t.id ? 'bg-muted' : ''}`}>
                      <td className="px-3 py-2"><a href={navHref('tasks', t.id)} onClick={(e) => { e.stopPropagation(); onNavClick(() => openTask(t.id))(e) }} className={`text-foreground no-underline hover:underline ${t.status === 'cancelled' ? 'line-through opacity-60' : ''}`}>{t.title}</a> {t.labels.map((l) => <Badge key={l} variant="outline" className="ml-1 px-1 py-0 text-[10px]">{l}</Badge>)}</td>
                      <td className="px-3 py-2 capitalize text-muted-foreground">{t.status}</td>
                      <td className="px-3 py-2 text-muted-foreground">{t.assignee ? assigneeChip(t.assignee, 'h-3.5 w-3.5') : '—'}</td>
                      <td className={`px-3 py-2 text-xs ${priorityTone(t.priority)}`}>{PRIORITY_LABEL[t.priority]}</td>
                      <td className="px-3 py-2 text-xs">{dm ? <span className={dm.overdue ? 'text-red-600' : dm.soon ? 'text-amber-600' : 'text-muted-foreground'}>{dm.label}</span> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(t.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  )
                })}
                {visible.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">No tasks match.</td></tr>}
              </tbody>
            </table>
          </div>
        )}

      </div>

      {detail && (
        <Dialog open onOpenChange={(o) => { if (!o) closeTask() }}>
          <DialogContent className="max-h-[88vh] w-full max-w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 pr-8">
                {editing ? 'Edit task' : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{detail.task.title}</span>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title="Edit" onClick={startEdit}><Pencil className="h-3.5 w-3.5" /></Button>
                  </>
                )}
              </DialogTitle>
            </DialogHeader>

            {editing ? (
              <div className="space-y-3">
                <Field label="Title"><Input value={eTitle} onChange={(e) => setETitle(e.target.value)} className="font-medium" /></Field>
                <Field label="Details (markdown)"><Textarea value={eBody} onChange={(e) => setEBody(e.target.value)} rows={10} className="font-mono text-xs" /></Field>
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={busy || !eTitle.trim()} onClick={saveEdit}><Save className="mr-1 h-3.5 w-3.5" />Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3.5">
                <div className="font-mono text-xs text-muted-foreground">{detail.task.id}{detail.task.owner ? ` · as ${nameOf(detail.task.owner)}` : ''}</div>
                {detail.task.body && <div className="max-h-56 overflow-y-auto break-words rounded-md border bg-muted/30 p-3 text-sm [&_pre]:whitespace-pre-wrap [&_pre]:break-words"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{detail.task.body}</ReactMarkdown></div>}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Status">
                    <Select value={detail.task.status} onValueChange={(v) => v && patch(detail.task.id, { status: v as TaskStatus })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>{(['todo', 'doing', 'blocked', 'done', 'cancelled'] as TaskStatus[]).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                  <Field label="Priority">
                    <Select items={PRIORITY_ITEMS} value={String(detail.task.priority)} onValueChange={(v) => v && patch(detail.task.id, { priority: Number(v) })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>{PRIORITY_LABEL.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="Assignee">
                    <Select value={detail.task.assignee || 'none'} onValueChange={(v) => patch(detail.task.id, { assignee: !v || v === 'none' ? null : v })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {chatAgents.map((a) => <SelectItem key={a.id} value={`agent:${a.id}`}><span className="flex items-center gap-1.5"><AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{a.id}</span></SelectItem>)}
                        {members.map((m) => <SelectItem key={m.id} value={m.id}><span className="flex items-center gap-1.5"><MemberAvatar member={m} className="h-4 w-4 text-[8px]" />{m.name || m.email}</span></SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Due date">
                    <Input type="date" value={toDateInput(detail.task.dueAt)} onChange={(e) => patch(detail.task.id, { dueAt: fromDateInput(e.target.value) })} className="h-8" />
                  </Field>
                </div>
                {(detail.task.assignee || '').startsWith('agent:') && (
                  <Field label="Run mode">
                    <Select items={{ headless: 'Headless — runs to completion, then exits', interactive: 'Interactive — attachable TUI you drive' }} value={detail.task.mode} onValueChange={(v) => v && patch(detail.task.id, { mode: v as 'headless' | 'interactive' })}>
                      <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="headless">Headless — runs to completion, then exits</SelectItem>
                        <SelectItem value="interactive">Interactive — attachable TUI you drive</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {(detail.task.assignee || '').startsWith('agent:') && (detail.task.status === 'todo' || detail.task.status === 'blocked') && (
                  <Button size="sm" className="w-full" disabled={busy} onClick={() => dispatch(detail.task)}>
                    <Play className="mr-1 h-3.5 w-3.5" />{detail.task.status === 'blocked' ? 'Re-dispatch' : 'Dispatch now'}
                  </Button>
                )}
                {detail.task.lastSessionId && (
                  <Button size="sm" variant="outline" className="w-full" onClick={() => onOpen('aos-' + detail.task.lastSessionId, 'Task · ' + detail.task.title)}>
                    <TerminalSquare className="mr-1 h-3.5 w-3.5" />View session
                  </Button>
                )}
                {hint && <div className="font-mono text-xs text-destructive">{hint}</div>}

                <CommentBox onSubmit={async (text) => { await api.commentTask(detail.task.id, text); await refreshDetail(detail.task.id) }} />

                <TaskAttachments
                  taskId={detail.task.id}
                  attachments={detail.attachments}
                  nameOf={nameOf}
                  onChange={() => refreshDetail(detail.task.id)}
                />


                <div>
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Activity</div>
                  <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                    {detail.events.length === 0 && <div className="text-xs text-muted-foreground">No activity yet.</div>}
                    {detail.events.slice().reverse().map((e) => (
                      <div key={e.id} className="rounded-md border bg-muted/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">{e.kind}</Badge>
                          <span className="text-[10px] text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
                        </div>
                        {e.body && <div className="mt-1 break-words text-xs leading-relaxed text-foreground">{e.body}</div>}
                        <div className="mt-0.5 text-[10px] text-muted-foreground">{nameOf(e.author)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {isAdmin && (
                  confirmDel
                    ? <div className="flex items-center gap-2">
                        <Button size="sm" variant="destructive" className="flex-1" disabled={busy} onClick={() => remove(detail.task.id)}>Confirm delete</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
                      </div>
                    : <Button size="sm" variant="ghost" className="w-full text-destructive" onClick={() => setConfirmDel(true)}>
                        <Trash2 className="mr-1 h-3.5 w-3.5" />Delete task
                      </Button>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function CommentBox({ onSubmit }: { onSubmit: (text: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-end gap-2">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Add a comment…" className="min-h-8 text-xs" />
      <Button size="sm" disabled={!text.trim() || busy} onClick={async () => { setBusy(true); await onSubmit(text); setText(''); setBusy(false) }}><Send className="h-3.5 w-3.5" /></Button>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Attachments section of the task drawer: upload (button/drop), list with download, delete. */
function TaskAttachments({ taskId, attachments, nameOf, onChange }: {
  taskId: string; attachments: TaskAttachment[]; nameOf: (id?: string) => string; onChange: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [drag, setDrag] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true); setHint('')
    for (const f of Array.from(files)) {
      const r = await api.uploadTaskAttachment(taskId, f)
      if (!r.ok) { setHint('⚠ ' + (r.error || `could not upload ${f.name}`)); break }
    }
    if (inputRef.current) inputRef.current.value = ''
    await onChange()
    setBusy(false)
  }
  const del = async (attId: string) => { setBusy(true); await api.deleteTaskAttachment(taskId, attId); await onChange(); setBusy(false) }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Attachments{attachments.length ? ` · ${attachments.length}` : ''}</div>
        <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Upload className="mr-1 h-3.5 w-3.5" />Upload
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => upload(e.target.files)} />
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files) }}
        className={`space-y-1 rounded-md border border-dashed p-2 ${drag ? 'border-primary bg-primary/10' : 'border-border'}`}
      >
        {attachments.length === 0 && <div className="py-1 text-center text-xs text-muted-foreground">Drop files here or use Upload.</div>}
        {attachments.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-md border bg-muted/20 p-2">
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <a href={api.taskAttachmentUrl(taskId, a.id)} target="_blank" rel="noreferrer" className="block truncate text-xs font-medium text-foreground hover:underline" title={a.filename}>{a.filename}</a>
              <div className="text-[10px] text-muted-foreground">{fmtBytes(a.bytes)} · {nameOf(a.uploadedBy)}</div>
            </div>
            <a href={api.taskAttachmentUrl(taskId, a.id)} download={a.filename} className="text-muted-foreground hover:text-foreground" title="Download"><Download className="h-3.5 w-3.5" /></a>
            <button disabled={busy} onClick={() => del(a.id)} className="text-muted-foreground hover:text-destructive" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
      {hint && <div className="mt-1 font-mono text-xs text-destructive">{hint}</div>}
    </div>
  )
}

// ── Automations ──────────────────────────────────────────────────────────────────
const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 2 hours', value: '0 */2 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Every day at midnight', value: '0 0 * * *' },
  { label: 'Every day at 9:00 AM', value: '0 9 * * *' },
  { label: 'Every day at 6:00 PM', value: '0 18 * * *' },
  { label: 'Weekdays at 9:00 AM', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 9:00 AM', value: '0 9 * * 1' },
  { label: 'First of the month at 9:00 AM', value: '0 9 1 * *' },
]

// Base UI's Select.Value shows the raw value unless the root is given an items map (value → label).
const SCHEDULE_ITEMS: Record<string, string> = {
  ...Object.fromEntries(CRON_PRESETS.map((p) => [p.value, p.label])),
  custom: 'Custom cron expression…',
}

// ── cron → human ("*/30 * * * *" → "Every 30 minutes") ──────────────────────────────
// Covers the shapes our builder + presets can produce; anything more exotic (ranges/lists in the
// time fields, month restrictions) falls back to the raw expression so we never lie about a schedule.
const DOW_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
function fmtClock(minute: number, hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}
/** Turn a comma-list of single-digit weekdays ("1,3,5") into "Every Mon, Wed, Fri" (or full name if one). */
function dowPhrase(dow: string): string | null {
  const nums: number[] = []
  for (const p of dow.split(',')) {
    if (!/^[0-7]$/.test(p)) return null
    nums.push(Number(p) % 7) // 7 ≡ 0 (Sunday)
  }
  if (!nums.length) return null
  if (nums.length === 1) return `Every ${DOW_FULL[nums[0]]}`
  return `Every ${nums.map((n) => DOW_ABBR[n]).join(', ')}`
}
function cronToHuman(expr?: string | null): string {
  if (!expr) return ''
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [mn, hr, dom, mon, dow] = parts
  const int = (s: string) => (/^\d+$/.test(s) ? Number(s) : null)
  let m: RegExpMatchArray | null
  // Interval shapes — no fixed time of day.
  if (mn === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute'
  if ((m = mn.match(/^\*\/(\d+)$/)) && hr === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} minutes`
  if (int(mn) !== null && hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return int(mn) === 0 ? 'Every hour' : `Hourly at :${String(int(mn)).padStart(2, '0')}`
  if (int(mn) !== null && (m = hr.match(/^\*\/(\d+)$/)) && dom === '*' && mon === '*' && dow === '*') return `Every ${m[1]} hours`
  // Fixed time of day — needs a concrete minute+hour, else it's too complex to phrase.
  const mmv = int(mn), hhv = int(hr)
  if (mmv === null || hhv === null || mon !== '*') return expr
  const at = fmtClock(mmv, hhv)
  const domStar = dom === '*', dowStar = dow === '*'
  if (domStar && dowStar) return `Every day at ${at}`
  if (domStar && !dowStar) {
    if (dow === '1-5') return `Weekdays at ${at}`
    if (dow === '0,6' || dow === '6,0' || dow === '6,7') return `Weekends at ${at}`
    const phrase = dowPhrase(dow)
    return phrase ? `${phrase} at ${at}` : expr
  }
  if (!domStar && dowStar) {
    const d = int(dom)
    return d !== null ? `Monthly on the ${ordinal(d)} at ${at}` : expr
  }
  return expr
}
/** Wall-clock in the server's zone (cron fires server-local), so "9 AM" reads as 9 AM regardless of the viewer's tz. */
function fmtInServerTz(ms: number, tz?: string): string {
  try { return new Date(ms).toLocaleString(undefined, tz ? { timeZone: tz } : undefined) } catch { return new Date(ms).toLocaleString() }
}
const TRIGGER_ITEMS: Record<string, string> = {
  cron: 'Schedule (cron)',
  webhook: 'Webhook',
  slack: 'Slack message (native)',
  discord: 'Discord message (native)',
  composio: 'Composio event',
}

function AutomationsPage({ me, agents, serverTz, onOpen, nav }: { me: Member; agents: AgentInfo[]; serverTz?: string; onOpen: (tmux: string, title: string) => void; nav: (r: Route, detail?: string) => void }) {
  const [items, setItems] = useState<Automation[] | null>(null)
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  const [openRuns, setOpenRuns] = useState<string | null>(null) // automation id whose Runs list is expanded
  const [runPrompt, setRunPrompt] = useState<Automation | null>(null) // "Run now" asks headless vs interactive first
  const [showForm, setShowForm] = useState(false) // the New-automation form is collapsed until requested
  const [editId, setEditId] = useState<string | null>(null) // when set, the form edits this automation instead of creating
  const formRef = useRef<HTMLDivElement>(null) // the create/edit form — scroll it into view when it opens (Edit sits below the fold)
  const [showSpent, setShowSpent] = useState(false) // reveal the collapsed "spent one-shots" section
  // create / edit form
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [type, setType] = useState<'cron' | 'webhook' | 'composio' | 'slack' | 'discord'>('cron')
  const [mode, setMode] = useState<'interactive' | 'headless'>('headless')
  const [schedule, setSchedule] = useState('*/30 * * * *')
  const [scheduleCustom, setScheduleCustom] = useState(false)
  const [filter, setFilter] = useState('')
  const [task, setTask] = useState('')

  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const load = () => api.automations().then((r) => setItems(r.automations ?? []))
  useEffect(() => { load() }, [])
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id) }, [agents, agentId])
  // The form mounts at the top of the section, but Edit buttons live on cards further down — scroll the
  // form into view when it opens (or when switching which automation is being edited) so it isn't missed.
  useEffect(() => { if (showForm) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [showForm, editId])

  const resetForm = () => { setName(''); setTask(''); setFilter(''); setType('cron'); setMode('headless'); setSchedule('*/30 * * * *'); setScheduleCustom(false); setEditId(null) }
  const startCreate = () => { resetForm(); setShowForm(true); setHint('') }
  const startEdit = (a: Automation) => {
    if (a.type === 'once') return // one-shot deferred runs aren't editable from the console
    setEditId(a.id)
    setName(a.name)
    setAgentId(a.agentId)
    setType(a.type)
    setMode(a.mode)
    setFilter(a.filter ?? '')
    if (a.type === 'cron') {
      const preset = CRON_PRESETS.some((p) => p.value === a.schedule)
      setScheduleCustom(!preset)
      setSchedule(a.schedule ?? '*/30 * * * *')
    }
    setTask(a.task)
    setShowForm(true); setHint('')
  }
  const closeForm = () => { setShowForm(false); setHint(''); resetForm() }
  const submit = async () => {
    setHint('')
    if (editId) {
      // agentId + type are immutable on edit; everything else is patchable. filter only for event triggers.
      const r = await api.updateAutomation(editId, { name, mode, schedule: type === 'cron' ? schedule : undefined, filter: type === 'composio' || type === 'slack' || type === 'discord' ? filter : undefined, task })
      if (r.error) return setHint('⚠ ' + r.error)
    } else {
      const r = await api.addAutomation({ name, agentId, type, mode, schedule: type === 'cron' ? schedule : undefined, filter: type === 'composio' || type === 'slack' || type === 'discord' ? filter : undefined, task })
      if (r.error) return setHint('⚠ ' + r.error)
    }
    closeForm()
    load()
  }
  const setItemMode = async (a: Automation, m: 'interactive' | 'headless') => { setBusy(a.id); await api.updateAutomation(a.id, { mode: m }); await load(); setBusy('') }
  const toggle = async (a: Automation) => { setBusy(a.id); await api.updateAutomation(a.id, { enabled: !a.enabled }); await load(); setBusy('') }
  const remove = async (a: Automation) => { setBusy(a.id); await api.deleteAutomation(a.id); await load(); setBusy('') }
  // Fire a one-off run in the chosen mode (overriding the automation's saved default just for this run).
  const runNow = async (a: Automation, mode: 'interactive' | 'headless') => {
    setRunPrompt(null); setBusy(a.id); setHint('')
    const r = await api.runAutomation(a.id, mode)
    setBusy('')
    if (!r.ok) return setHint('⚠ ' + (r.reason || r.error || 'failed'))
    await load()
    // A headless run exits into a dead terminal — don't drop the operator onto it. Send them to the
    // sessions list where the new run shows up; interactive runs open the attachable TUI to watch/steer.
    if (r.sessionId) {
      if (mode === 'headless') nav('sessions')
      else onOpen('aos-' + r.sessionId, a.agentId + ' · ' + r.sessionId)
    }
  }

  if (!items) return <div className="text-sm text-muted-foreground">Loading…</div>

  // A one-shot (`once`, scheduled via the agent `schedule` tool) that has already fired will never run
  // again — split those out so a page full of spent runs doesn't bury the live automations.
  const isSpent = (a: Automation) => a.type === 'once' && !!a.lastFiredAt
  const active = items.filter((a) => !isSpent(a))
  const spent = items.filter(isSpent)
  const clearSpent = async () => { setBusy('spent'); for (const a of spent) await api.deleteAutomation(a.id); await load(); setBusy('') }

  return (
    <div className="max-w-4xl space-y-6">
      {/* "Run now" asks headless vs interactive for this one-off run, without touching the saved default. */}
      <Dialog open={!!runPrompt} onOpenChange={(o) => { if (!o) setRunPrompt(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Play className="h-4 w-4" /> Run “{runPrompt?.name}” now</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            How should this one-off run behave? This doesn’t change the automation’s saved default
            {runPrompt ? <> (<span className="font-medium">{runPrompt.mode}</span>)</> : null}.
          </p>
          <div className="mt-1 grid gap-2">
            <button disabled={busy === runPrompt?.id} onClick={() => runPrompt && runNow(runPrompt, 'interactive')}
              className="rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:opacity-50">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Terminal className="h-4 w-4" /> Interactive — watch &amp; steer
                {runPrompt?.mode === 'interactive' && <span className="text-[11px] font-normal text-muted-foreground">· current default</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">Opens an attachable terminal you can type into to take over. Stays open until closed.</div>
            </button>
            <button disabled={busy === runPrompt?.id} onClick={() => runPrompt && runNow(runPrompt, 'headless')}
              className="rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:opacity-50">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Zap className="h-4 w-4" /> Headless — fire and forget
                {runPrompt?.mode === 'headless' && <span className="text-[11px] font-normal text-muted-foreground">· current default</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">Runs to completion unattended (<code>claude -p</code>) and exits; progress lands in the Inbox. You can still “Take over” a live headless run from Sessions.</div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <p className="text-sm text-muted-foreground">
        Automations run agents without you: on a <strong>cron schedule</strong>, when an external service hits a
        <strong> webhook</strong>, on a <strong>Composio event</strong>, or on a <strong>Slack</strong> / <strong>Discord
        message</strong> (the company bot @-mentioned or DMed → run an agent, as the member who sent it). Each firing spawns a normal
        session — its task lands in the Inbox and any risky action still waits for approval.
      </p>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Configured</div>
          {isAdmin && (
            <Button size="sm" variant={showForm ? 'ghost' : 'default'} onClick={() => (showForm ? closeForm() : startCreate())}>
              {showForm ? <><X className="mr-1 h-3.5 w-3.5" />Cancel</> : <><Plus className="mr-1 h-3.5 w-3.5" />New automation</>}
            </Button>
          )}
        </div>
        {isAdmin && showForm && (
          <Card ref={formRef} className="mb-3 border-primary/30">
            <CardContent className="space-y-3 p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{editId ? 'Edit automation' : 'New automation'}</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning site check" /></Field>
                <Field label="Agent" help={editId ? "The agent can't be changed after creation — delete and recreate to move it." : undefined}>
                  <Select value={agentId} disabled={!!editId} onValueChange={(v) => v && setAgentId(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span className="flex items-center gap-1.5"><AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Trigger" help={editId ? "The trigger type can't be changed after creation — delete and recreate to switch." : undefined}>
                  <Select items={TRIGGER_ITEMS} value={type} disabled={!!editId} onValueChange={(v) => v && setType(v as 'cron' | 'webhook' | 'composio' | 'slack' | 'discord')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cron">Schedule (cron)</SelectItem>
                      <SelectItem value="webhook">Webhook</SelectItem>
                      <SelectItem value="slack">Slack message (native)</SelectItem>
                      <SelectItem value="discord">Discord message (native)</SelectItem>
                      <SelectItem value="composio">Composio event</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Run mode" help={mode === 'headless' ? 'Headless: runs to completion and exits — unattended-correct.' : 'Interactive: attachable TUI that stays open until you close it.'}>
                  <Select items={{ headless: 'Headless (recommended)', interactive: 'Interactive' }} value={mode} onValueChange={(v) => v && setMode(v as 'interactive' | 'headless')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="headless">Headless (recommended)</SelectItem>
                      <SelectItem value="interactive">Interactive</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {type === 'cron' ? (
                  <Field label="Schedule" help={scheduleCustom ? '5-field cron — minute hour day-of-month month day-of-week. e.g. 0 9 * * 1-5 (9:00 weekdays).' : 'Pick a common schedule, or choose Custom to write a cron expression.'}>
                    <Select items={SCHEDULE_ITEMS} value={scheduleCustom ? 'custom' : schedule} onValueChange={(v) => { if (!v) return; if (v === 'custom') { setScheduleCustom(true) } else { setScheduleCustom(false); setSchedule(v) } }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CRON_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                        <SelectItem value="custom">Custom cron expression…</SelectItem>
                      </SelectContent>
                    </Select>
                    {scheduleCustom && <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="mt-2 font-mono" placeholder="*/30 * * * *" />}
                    {scheduleCustom && (() => { const h = cronToHuman(schedule); return (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {h && h !== schedule.trim() ? <>▸ <span className="text-foreground">{h}</span></> : 'Enter a valid 5-field cron expression.'}
                        {serverTz && <> · server time ({serverTz})</>}
                      </p>
                    ) })()}
                  </Field>
                ) : type === 'webhook' ? (
                  <Field label="Webhook" help="A secret URL is generated on create — POST to it to fire this automation.">
                    <Input disabled value="URL generated after create" />
                  </Field>
                ) : type === 'slack' ? (
                  <Field label="Trigger filter" help="Scope to an event type (app_mention / message) or a channel id (e.g. C0123…). Blank = any Slack message the app receives. Needs Slack tokens in Connections → Creds.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="app_mention  ·  or a channel id  (blank = any)" />
                  </Field>
                ) : type === 'discord' ? (
                  <Field label="Trigger filter" help="Scope to an event type (mention / direct_message) or a channel id. Blank = any Discord message the bot receives. Needs a bot token in Connections → Creds.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="mention  ·  or a channel id  (blank = any)" />
                  </Field>
                ) : (
                  <Field label="Trigger filter" help="Composio trigger slug to match — e.g. SLACK_DIRECT_MESSAGE_RECEIVED. Blank = any Composio event. Needs a webhook secret in Connections → Creds.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="SLACK_DIRECT_MESSAGE_RECEIVED  (blank = any)" />
                  </Field>
                )}
              </div>
              <Field label="Task">
                <Textarea value={task} onChange={(e) => setTask(e.target.value)} className="min-h-[64px]" placeholder="What should the agent do each time this fires? (Webhook payloads are appended automatically.)" />
              </Field>
              <div className="flex items-center gap-2">
                <Button onClick={submit} disabled={!name.trim() || !task.trim() || !agentId}>
                  {editId ? <><Check className="mr-1 h-4 w-4" />Save changes</> : <><Plus className="mr-1 h-4 w-4" />Create</>}
                </Button>
                <Button variant="ghost" onClick={closeForm}>Cancel</Button>
                {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
              </div>
            </CardContent>
          </Card>
        )}
        {active.length === 0 && !showForm && <div className="text-sm text-muted-foreground">No active automations{spent.length ? ' — only spent one-shot runs remain (below).' : isAdmin ? ' yet — click New automation to create one.' : '.'}</div>}
        <div className="space-y-2">
          {active.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Zap className={`h-4 w-4 shrink-0 ${a.enabled ? 'text-amber-500' : 'text-muted-foreground/40'}`} />
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{a.type}</Badge>
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{a.mode === 'headless' ? 'headless' : 'interactive'}</Badge>
                    {!a.enabled && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">disabled</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {a.agentId}
                    {a.type === 'cron' && a.schedule && <span className="ml-2" title={a.schedule}>{cronToHuman(a.schedule)}</span>}
                    {(a.type === 'composio' || a.type === 'slack' || a.type === 'discord') && <span className="ml-2 font-mono">{a.filter || 'any event'}</span>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    {a.nextRunAt ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600" title={serverTz ? `${fmtInServerTz(a.nextRunAt, serverTz)} (${serverTz})` : new Date(a.nextRunAt).toLocaleString()}>
                        <Clock className="h-3 w-3" />next in {timeUntil(a.nextRunAt)} · {fmtInServerTz(a.nextRunAt, serverTz)}{serverTz ? ` (${serverTz})` : ''}
                      </span>
                    ) : a.type === 'cron' && !a.enabled ? (
                      <span className="text-amber-600">paused — won't fire while disabled</span>
                    ) : a.type !== 'cron' ? (
                      <span>fires on {a.type === 'webhook' ? 'webhook' : `${a.type} message`} — no schedule</span>
                    ) : null}
                    <span title={a.lastFiredAt ? new Date(a.lastFiredAt).toLocaleString() : undefined}>
                      {a.lastFiredAt ? `last fired ${timeAgo(a.lastFiredAt)} ago` : 'never fired'}
                    </span>
                  </div>
                  {a.type === 'cron' && a.mode === 'interactive' && (
                    <div className="mt-1 text-[11px] text-amber-600">Interactive sessions stay open until closed — this cron won't re-fire while its last run is still running.</div>
                  )}
                  <div className="mt-1 truncate text-xs text-muted-foreground">{a.task}</div>
                  {a.hookUrl && <div className="mt-2 w-full max-w-xl"><CopyLink link={a.hookUrl} /></div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpenRuns((cur) => (cur === a.id ? null : a.id))} title="show past runs of this automation">
                    <HistoryIcon className="mr-1 h-3.5 w-3.5" />Runs
                    <ChevronDown className={`ml-1 h-3.5 w-3.5 transition-transform ${openRuns === a.id ? 'rotate-180' : ''}`} />
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => setRunPrompt(a)} title="fire once now — pick headless or interactive">
                    <Play className="mr-1 h-3.5 w-3.5" />Run now
                  </Button>
                  {/* Manage controls only for automations this member may edit: owner (any) or the creator.
                      `canManage !== false` keeps them for older payloads without the flag; the server enforces. */}
                  {isAdmin && a.canManage !== false && (
                    <>
                      <Select value={a.mode} onValueChange={(v) => v && v !== a.mode && setItemMode(a, v as 'interactive' | 'headless')}>
                        <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="headless">headless</SelectItem>
                          <SelectItem value="interactive">interactive</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => toggle(a)}>
                        {a.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy === a.id} onClick={() => startEdit(a)} title="edit name, schedule, task…">
                        <Pencil className="mr-1 h-3.5 w-3.5" />Edit
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === a.id} onClick={() => remove(a)} title="remove">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {isAdmin && a.canManage === false && (
                    <span className="text-[11px] text-muted-foreground" title="Only the creator or the owner can change this automation">created by another member</span>
                  )}
                </div>
              </CardContent>
              {openRuns === a.id && <AutomationRuns id={a.id} onOpen={onOpen} />}
            </Card>
          ))}
        </div>
        {hint && <div className="mt-2 font-mono text-xs text-destructive">{hint}</div>}
      </section>

      {spent.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <button className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground" onClick={() => setShowSpent((v) => !v)}>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showSpent ? 'rotate-180' : ''}`} />
              Spent one-shot runs ({spent.length})
            </button>
            {isAdmin && showSpent && (
              <Button size="sm" variant="ghost" className="text-destructive" disabled={busy === 'spent'} onClick={clearSpent}>
                <Trash2 className="mr-1 h-3.5 w-3.5" />Clear all
              </Button>
            )}
          </div>
          {showSpent && (
            <div className="space-y-2">
              {spent.map((a) => (
                <Card key={a.id} className="opacity-70">
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                        <span className="truncate text-sm font-medium">{a.name}</span>
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">once</Badge>
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">fired</Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {a.agentId}
                        {a.lastFiredAt && <span className="ml-2">ran {timeAgo(a.lastFiredAt)} ago · {new Date(a.lastFiredAt).toLocaleString()}</span>}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">{a.task}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setOpenRuns((cur) => (cur === a.id ? null : a.id))} title="show the run this fired">
                        <HistoryIcon className="mr-1 h-3.5 w-3.5" />Runs
                        <ChevronDown className={`ml-1 h-3.5 w-3.5 transition-transform ${openRuns === a.id ? 'rotate-180' : ''}`} />
                      </Button>
                      {isAdmin && a.canManage !== false && (
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === a.id} onClick={() => remove(a)} title="remove">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                  {openRuns === a.id && <AutomationRuns id={a.id} onOpen={onOpen} />}
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** The past runs of one automation — every session it spawned (provenance `automation:<id>`), newest
 *  first. Loaded lazily when the card's Runs row is expanded. Each row opens its session terminal, so a
 *  fired run is one click from its transcript/output. Visibility is server-gated (same as /api/sessions). */
function AutomationRuns({ id, onOpen }: { id: string; onOpen: (tmux: string, title: string) => void }) {
  const [runs, setRuns] = useState<Session[] | null>(null)
  useEffect(() => { api.automationRuns(id).then((r) => setRuns(r.runs ?? [])) }, [id])
  return (
    <div className="border-t bg-muted/30 px-4 py-3">
      {!runs ? (
        <div className="text-xs text-muted-foreground">Loading runs…</div>
      ) : runs.length === 0 ? (
        <div className="text-xs text-muted-foreground">No runs yet — this automation hasn't fired.</div>
      ) : (
        <div className="space-y-0.5">
          {runs.map((s) => (
            <button key={s.id} onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)} title={s.spawnedByLabel ? `started by ${s.spawnedByLabel}` : undefined}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(s)}`} />
              <span className="w-14 shrink-0 text-muted-foreground">{statusLabel(s)}</span>
              <Clock className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              <span className="shrink-0 text-muted-foreground">{new Date(s.createdAt).toLocaleString()}</span>
              {s.spawnedByLabel && <span className="ml-auto min-w-0 truncate text-muted-foreground/60">{s.spawnedByLabel}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Memory ─────────────────────────────────────────────────────────────────────
/** Internal namespace tags the OS adds (agent:<id> / tenant:<t>) aren't shown to the user. */
const visibleTags = (tags: string[]): string[] => tags.filter((t) => !t.startsWith('agent:') && !t.startsWith('tenant:'))

/** The display "kind" of a memory. Episodes (end-of-session recaps the OS writes) are called out
 *  specially; everything else falls back to its stored type (Insight / Decision / Context / …). */
function memoryKind(m: MemoryRecord): { key: string; label: string; episode: boolean } {
  if (m.tags.includes('episode')) return { key: 'episode', label: 'Episode', episode: true }
  if (m.tags.includes('lesson')) return { key: 'lesson', label: 'Lesson', episode: false }
  const t = (m.type || 'Note').trim() || 'Note'
  return { key: t.toLowerCase(), label: t, episode: false }
}

/** Tailwind text colour for an episode outcome, so success/failure/stopped read at a glance. */
function outcomeTone(outcome?: string): string {
  switch ((outcome || '').toLowerCase()) {
    case 'success': return 'text-emerald-600'
    case 'partial':
    case 'stopped': return 'text-amber-600'
    case 'failure':
    case 'error':
    case 'crashed': return 'text-red-600'
    default: return 'text-muted-foreground'
  }
}

/** A small pill toggle for the memory kind filter (Episode / Insight / …). */
function KindChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  )
}

/** Product manual bundled into the build (web/src/docs) — read-only, identical for every tenant,
 *  unlike the KB, which is the tenant's own living wiki. Adding a page = drop a .md in web/src/docs
 *  and register it in web/src/docs/index.ts. */
function DocsPage({ selected, onSelect }: { selected: string; onSelect: (slug: string) => void }) {
  // The selected page is a URL detail (`#/docs/<slug>`) so a refresh / shared link lands on the
  // same page instead of always resetting to the first one.
  const sel = docPages.find((p) => p.slug === selected) ?? docPages[0]
  return (
    <div className="flex gap-4">
      <div className="w-64 shrink-0 space-y-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Manual</div>
        <div className="space-y-0.5">
          {docPages.map((p) => (
            <a key={p.slug} href={navHref('docs', p.slug)} onClick={onNavClick(() => onSelect(p.slug))} className={`block w-full truncate rounded px-2 py-1 text-left text-xs no-underline ${sel.slug === p.slug ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}>{p.title}</a>
          ))}
        </div>
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          These docs ship with Agent OS. Your company's own pages live in <a href={navHref('kb')} className="text-primary underline">Knowledge</a>.
        </div>
      </div>
      <div className="min-w-0 max-w-3xl flex-1">
        <Card><CardContent className="p-6 text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{sel.body}</ReactMarkdown></CardContent></Card>
      </div>
    </div>
  )
}

function KnowledgeBasePage({ me, permalink, nav }: { me: Member; permalink: string; nav: (r: Route, detail?: string) => void }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [pages, setPages] = useState<KbPage[] | null>(null)
  const [sections, setSections] = useState<string[]>([])
  const [folder, setFolder] = useState('')
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState<KbPage | null>(null)
  const [history, setHistory] = useState<KbRevision[]>([])
  const [viewRev, setViewRev] = useState<KbRevision | null>(null)
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [showHist, setShowHist] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  // edit draft
  const [dTitle, setDTitle] = useState(''); const [dBody, setDBody] = useState(''); const [dTags, setDTags] = useState(''); const [dSummary, setDSummary] = useState('')
  // new-page form
  const [nSection, setNSection] = useState(''); const [nSlug, setNSlug] = useState(''); const [nTitle, setNTitle] = useState(''); const [nBody, setNBody] = useState(''); const [nTags, setNTags] = useState('')

  const load = (q = query) => api.kb(q).then((r) => { setPages(r.pages ?? []); setSections(r.sections ?? []) }).catch(() => setPages([]))
  useEffect(() => { load('') /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])

  // The URL is the source of truth for which page is open: `#/kb/<section>/<slug>` (section may nest).
  // Resolve the permalink against the loaded list and open it — this drives deep-links, back/forward,
  // and the initial cold load (once `pages` arrives). Clicking a page navigates; this effect opens it.
  useEffect(() => {
    if (pages === null) return                                  // wait for the list
    if (!permalink) { if (!creating) setSel(null); return }      // bare #/kb → landing
    if (sel && permalink === `${sel.section}/${sel.slug}`) return // already showing it
    const cut = permalink.lastIndexOf('/')
    const target = pages.find((p) => p.section === permalink.slice(0, cut) && p.slug === permalink.slice(cut + 1))
    if (target) open(target.id)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [permalink, pages])

  const open = (id: string) => {
    setCreating(false); setEditing(false); setViewRev(null); setShowHist(false); setHint('')
    api.kbPage(id).then((r) => setSel(r.page ?? null)).catch(() => {})
    api.kbHistory(id).then((r) => setHistory(r.revisions ?? [])).catch(() => setHistory([]))
  }
  const startEdit = () => { if (!sel) return; setDTitle(sel.title); setDBody(sel.body); setDTags(sel.tags.join(', ')); setDSummary(''); setViewRev(null); setEditing(true) }
  const saveEdit = async () => {
    if (!sel) return; setBusy(true); setHint('')
    const r = await api.kbPatch(sel.id, { title: dTitle.trim(), body: dBody, tags: dTags.split(',').map((t) => t.trim()).filter(Boolean), summary: dSummary.trim() || undefined })
    setBusy(false); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed'))
    setEditing(false); open(sel.id); load()
  }
  const create = async () => {
    setBusy(true); setHint('')
    const r = await api.kbCreate({ section: nSection.trim(), slug: nSlug.trim(), title: nTitle.trim() || nSlug.trim(), body: nBody, tags: nTags.split(',').map((t) => t.trim()).filter(Boolean) })
    setBusy(false); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed'))
    setCreating(false); setNSection(''); setNSlug(''); setNTitle(''); setNBody(''); setNTags(''); await load(); if (r.page) nav('kb', `${r.page.section}/${r.page.slug}`)
  }
  const revert = async (rev: number) => { if (!sel || !window.confirm(`Revert to rev ${rev}? This creates a new revision.`)) return; const r = await api.kbRevert(sel.id, rev); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed')); open(sel.id); load() }
  const remove = async () => { if (!sel || !window.confirm('Delete this page? Its revision history is kept.')) return; const r = await api.kbDelete(sel.id); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed')); setSel(null); nav('kb'); load() }

  return (
    <div className="flex gap-4">
      {/* left: search + section/page tree */}
      <div className="w-64 shrink-0 space-y-3">
        <div className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="search the wiki…" className="h-8 text-xs" />
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={() => load()}>Go</Button>
        </div>
        <Button size="sm" className="w-full" onClick={() => { setCreating(true); setSel(null); setEditing(false); setNSection(folder ? folder + '/' : ''); nav('kb') }}><Plus className="mr-1 h-3.5 w-3.5" />New page</Button>
        <FolderNav paths={(pages ?? []).map((p) => p.section)} selected={folder} onSelect={setFolder} rootLabel="All pages" />
        <div className="space-y-3">
          {pages === null && <div className="text-xs text-muted-foreground">Loading…</div>}
          {pages !== null && pages.length === 0 && <div className="text-xs text-muted-foreground">No pages yet. Agents and you write them; the self-learning pass also keeps an <code className="text-[10px]">operations/fleet-learnings</code> page.</div>}
          {sections.filter((s) => folder === '' || s === folder || s.startsWith(folder + '/')).map((s) => (
            <div key={s}>
              <div className="mb-1 truncate text-[10px] uppercase tracking-wider text-muted-foreground" title={s}>{s}</div>
              <div className="space-y-0.5">
                {(pages ?? []).filter((p) => p.section === s).map((p) => (
                  <a key={p.id} href={navHref('kb', `${p.section}/${p.slug}`)} onClick={onNavClick(() => nav('kb', `${p.section}/${p.slug}`))} className={`block w-full truncate rounded px-2 py-1 text-left text-xs no-underline ${sel?.id === p.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`} title={`${p.section}/${p.slug}`}>{p.title}</a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* right: viewer / editor / new */}
      <div className="min-w-0 flex-1">
        {hint && <div className="mb-2 font-mono text-xs text-destructive">{hint}</div>}

        {creating ? (
          <Card><CardContent className="space-y-3 p-4">
            <div className="text-sm font-medium">New page</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Section" help="folder path — nest with / e.g. engineering/backend"><Input list="kb-sections" value={nSection} onChange={(e) => setNSection(e.target.value)} placeholder="engineering/backend" className="font-mono text-xs" /><datalist id="kb-sections">{sections.map((s) => <option key={s} value={s} />)}</datalist></Field>
              <Field label="Slug" help="url id, e.g. deploy-runbook"><Input value={nSlug} onChange={(e) => setNSlug(e.target.value)} placeholder="deploy-runbook" className="font-mono text-xs" /></Field>
              <Field label="Title"><Input value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="Deploy Runbook" /></Field>
            </div>
            <Field label="Body (markdown)"><Textarea value={nBody} onChange={(e) => setNBody(e.target.value)} className="min-h-[240px] font-mono text-xs" placeholder="# Deploy Runbook&#10;&#10;Steps…  Link pages with [[section/slug]]." /></Field>
            <Field label="Tags" help="comma-separated"><Input value={nTags} onChange={(e) => setNTags(e.target.value)} placeholder="deploy, ops" /></Field>
            <div className="flex gap-2">
              <Button onClick={create} disabled={busy || !nSection.trim() || !nSlug.trim()}><Check className="mr-1 h-4 w-4" />Create</Button>
              <Button variant="ghost" onClick={() => { setCreating(false); nav('kb') }}>Cancel</Button>
            </div>
          </CardContent></Card>
        ) : sel ? (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">{sel.title}</div>
                <div className="text-[11px] text-muted-foreground"><a href={navHref('kb', `${sel.section}/${sel.slug}`)} onClick={onNavClick(() => nav('kb', `${sel.section}/${sel.slug}`))} className="text-inherit no-underline hover:underline" title="permalink — right-click to copy the link to this page"><code>{sel.section}/{sel.slug}</code></a> · rev {sel.rev} · updated {new Date(sel.updatedAt).toLocaleString()} by {sel.updatedBy} · <span title={sel.lastReadAt ? `last read by an agent ${new Date(sel.lastReadAt).toLocaleString()}` : 'no agent has fetched this page yet'}>{sel.readCount ? `read ${sel.readCount}× by agents` : 'never read by agents'}</span></div>
                {sel.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{sel.tags.map((t) => <Badge key={t} variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{t}</Badge>)}</div>}
              </div>
              {!editing && (
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => setShowHist((v) => !v)}><HistoryIcon className="mr-1 h-3.5 w-3.5" />History</Button>
                  <Button size="sm" variant="outline" onClick={startEdit}><Pencil className="mr-1 h-3.5 w-3.5" />Edit</Button>
                  {isAdmin && <Button size="sm" variant="ghost" className="text-destructive" onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
              )}
            </div>

            {editing ? (
              <Card><CardContent className="space-y-3 p-4">
                <Field label="Title"><Input value={dTitle} onChange={(e) => setDTitle(e.target.value)} /></Field>
                <Field label="Tags"><Input value={dTags} onChange={(e) => setDTags(e.target.value)} placeholder="comma-separated" /></Field>
                <Field label="Body (markdown)"><Textarea value={dBody} onChange={(e) => setDBody(e.target.value)} className="min-h-[320px] font-mono text-xs" /></Field>
                <Field label="What changed (one line)"><Input value={dSummary} onChange={(e) => setDSummary(e.target.value)} placeholder="e.g. add rollback step" /></Field>
                <div className="flex gap-2"><Button onClick={saveEdit} disabled={busy}><Save className="mr-1 h-4 w-4" />Save</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
              </CardContent></Card>
            ) : (
              <>
                {viewRev && (
                  <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
                    <span>Viewing rev {viewRev.rev} ({new Date(viewRev.createdAt).toLocaleString()}{viewRev.summary ? ` · ${viewRev.summary}` : ''})</span>
                    <span className="flex gap-2"><button className="underline" onClick={() => revert(viewRev.rev)}>Revert to this</button><button className="underline" onClick={() => setViewRev(null)}>Back to current</button></span>
                  </div>
                )}
                <Card><CardContent className="p-4"><div className="text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{viewRev ? viewRev.body : sel.body}</ReactMarkdown></div></CardContent></Card>
                {showHist && (
                  <Card><CardContent className="space-y-1 p-3">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Revisions</div>
                    {history.map((rv) => (
                      <div key={rv.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50">
                        <button className="min-w-0 flex-1 truncate text-left" onClick={() => setViewRev(rv.rev === sel.rev ? null : rv)} title="view this revision">
                          <span className="font-mono">rev {rv.rev}</span> · {new Date(rv.createdAt).toLocaleString()} · {rv.author}{rv.summary ? ` — ${rv.summary}` : ''}
                        </button>
                        {rv.rev !== sel.rev && <button className="shrink-0 text-muted-foreground underline hover:text-foreground" onClick={() => revert(rv.rev)}>revert</button>}
                      </div>
                    ))}
                  </CardContent></Card>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            The <strong>Knowledge Base</strong> is the shared, living company wiki — agents and humans co-author it; every edit is versioned and revertable. Pick a page, or create one. (Agents read/write it via <code className="text-xs">kb_search</code>/<code className="text-xs">kb_read</code>/<code className="text-xs">kb_write</code>.)
          </div>
        )}
      </div>
    </div>
  )
}

/** The Memory hub. Two tabs: **Memories** (the store — Capture + Recall) and **Self-learning** (the
 *  reflect loop — Distil + Apply). A slim stats strip headlines both for admins. See docs/memory-model.md. */
function MemoryPage({ agents, me }: { agents: AgentInfo[]; me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [tab, setTab] = useState<'browse' | 'learning'>('browse')
  return (
    <div className="space-y-4">
      {isAdmin && <MemoryStats />}
      <div className="flex gap-1 rounded-lg border bg-background p-1 w-fit">
        <TabButton on={tab === 'browse'} onClick={() => setTab('browse')}>Memories</TabButton>
        {isAdmin && <TabButton on={tab === 'learning'} onClick={() => setTab('learning')}>Self-learning</TabButton>}
      </div>
      {tab === 'learning' && isAdmin ? <DreamingSettings me={me} /> : <MemoryBrowse agents={agents} me={me} />}
    </div>
  )
}

/** A slim at-a-glance strip of the memory store — the counts that used to headline the Overview tab. */
function MemoryStats() {
  const [counts, setCounts] = useState<{ memories: number; episodes: number; lessons: number; shared: number; kbPages: number } | null>(null)
  useEffect(() => { api.memoryOverview().then((r) => { if (!r.error) setCounts(r.counts) }).catch(() => {}) }, [])
  if (!counts) return null
  const stats = [
    { label: 'Memories', value: counts.memories, hint: 'all durable memories across the fleet' },
    { label: 'Episodes', value: counts.episodes, hint: 'auto session recaps (Capture)' },
    { label: 'Lessons', value: counts.lessons, hint: 'notes agents deliberately kept (Capture)' },
    { label: 'Shared', value: counts.shared, hint: 'workspace-wide knowledge every agent recalls' },
    { label: 'KB pages', value: counts.kbPages, hint: 'living Knowledge-base pages' },
  ]
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {stats.map((s) => (
        <Card key={s.label} title={s.hint}>
          <CardContent className="p-3">
            <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** A short human label + tone for a learning-activity audit event. */
function learningLabel(type: string): ReactNode {
  const map: Record<string, { text: string; cls: string }> = {
    'episode.stored': { text: 'Episode', cls: 'text-violet-600' },
    'lesson.stored': { text: 'Lesson', cls: 'text-emerald-600' },
    'learning.dreamed': { text: 'Reflection', cls: 'text-sky-600' },
    'learning.consolidated': { text: 'Consolidation', cls: 'text-amber-600' },
  }
  const m = map[type] ?? { text: type, cls: 'text-muted-foreground' }
  return <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] font-normal ${m.cls}`}>{m.text}</Badge>
}

function learningDetail(e: { type: string; principal?: string; data: Record<string, unknown> }): string {
  const d = e.data || {}
  if (e.type === 'episode.stored') return `${e.principal ?? 'agent'} — outcome ${String(d.outcome ?? '?')} (via ${String(d.source ?? '?')})`
  if (e.type === 'lesson.stored') return `${e.principal ?? 'agent'} kept a lesson (outcome ${String(d.outcome ?? '?')})`
  if (e.type === 'learning.dreamed') return `reflected on ${Number(d.sessions ?? 0)} sessions / ${Number(d.episodes ?? 0)} episodes → pass ${Number(d.pass ?? 0)}`
  if (e.type === 'learning.consolidated') return `gardener spawned over ${Number(d.items ?? 0)} episodes/lessons`
  return ''
}

function MemoryBrowse({ agents, me }: { agents: AgentInfo[]; me: Member }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryRecord[] | null>(null)
  const [health, setHealth] = useState<MemoryHealth | null>(null)
  const [scopeFilter, setScopeFilter] = useState<'all' | 'agent' | 'tenant'>('all')
  const [kind, setKind] = useState('all') // client-side filter over the loaded set (Episode / Insight / …)
  // add form
  const [showAdd, setShowAdd] = useState(false)
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [shareNew, setShareNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id) }, [agents, agentId])
  useEffect(() => { api.memoryHealth().then(setHealth).catch(() => {}) }, [])

  const load = (q = query) => {
    if (!agentId) return
    api.memory(agentId, q, 100, scopeFilter).then((r) => setItems(r.memories ?? [])).catch(() => setItems([]))
  }
  // Reload whenever the selected agent or the scope filter changes (keeps the current search).
  useEffect(() => { setItems(null); setKind('all'); load(query) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agentId, scopeFilter])

  const add = async () => {
    if (!content.trim() || !agentId) return
    setBusy(true); setHint('')
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    const r = await api.addMemory({ agent: agentId, content: content.trim(), tags: tagList, shared: shareNew })
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setContent(''); setTags(''); setShareNew(false); load(query)
  }

  if (agents.length === 0) {
    return <div className="text-sm text-muted-foreground">No agents you can run yet — memory is scoped per agent.</div>
  }

  // Kind chips (Episode / Insight / …) with live counts, derived from the loaded set. Episodes sort first.
  const kindCounts = new Map<string, { label: string; count: number }>()
  for (const m of items ?? []) {
    const k = memoryKind(m)
    const cur = kindCounts.get(k.key) ?? { label: k.label, count: 0 }
    kindCounts.set(k.key, { label: cur.label, count: cur.count + 1 })
  }
  const kindChips = [...kindCounts.entries()].sort((a, b) =>
    a[0] === 'episode' ? -1 : b[0] === 'episode' ? 1 : b[1].count - a[1].count)
  const shown = (items ?? []).filter((m) => kind === 'all' || memoryKind(m).key === kind)
  const sharedCount = (items ?? []).filter((m) => m.scope === 'tenant').length

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each agent keeps a persistent memory across its sessions — decisions, fixes, gotchas, preferences. Agents
          <span className="font-mono text-xs"> recall</span> it themselves — when a task calls for it — and
          <span className="font-mono text-xs"> remember</span> new facts as they work. Browse and curate that memory
          here; what you add is recalled just like what the agent stored.
        </p>
        <Button size="sm" variant={showAdd ? 'secondary' : 'outline'} className="shrink-0" onClick={() => setShowAdd((v) => !v)}>
          <Plus className="mr-1 h-4 w-4" />Add memory
        </Button>
      </div>

      {/* Add a memory (curated knowledge — same store the agent recalls from) — opens at the top. */}
      {showAdd && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Field label="Content">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="min-h-[64px]"
                placeholder="A self-contained fact for this agent to recall — e.g. “Prod deploys require running migrate after merge to main.”"
              />
            </Field>
            <Field label="Tags" help="Comma-separated, e.g. deploy, gotcha">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="deploy, gotcha" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={shareNew} onChange={(e) => setShareNew(e.target.checked)} />
              Share with the whole workspace <span className="text-[11px] text-muted-foreground">— every agent can recall it (otherwise private to {agentId})</span>
            </label>
            <div className="flex items-center gap-3">
              <Button onClick={add} disabled={busy || !content.trim()}><Plus className="mr-1 h-4 w-4" />Remember</Button>
              {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent picker + search + backend health */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[220px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Agent</label>
          <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
            <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="flex items-center gap-1.5"><AgentIcon icon={a.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Search</label>
          <div className="mt-1 flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()}
              placeholder="recall by keyword — blank for most recent"
            />
            <Button variant="outline" className="shrink-0" onClick={() => load()}>Search</Button>
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Scope</label>
          <div className="mt-1 flex gap-1 rounded-lg border bg-background p-1 w-fit">
            <TabButton on={scopeFilter === 'all'} onClick={() => setScopeFilter('all')}>All</TabButton>
            <TabButton on={scopeFilter === 'agent'} onClick={() => setScopeFilter('agent')}>This agent</TabButton>
            <TabButton on={scopeFilter === 'tenant'} onClick={() => setScopeFilter('tenant')}>Shared (all agents)</TabButton>
          </div>
        </div>
        {health && (
          <Badge variant={health.ok ? 'default' : 'destructive'} className="mb-1.5 px-1.5 py-0 text-[10px] font-normal" title={health.detail}>
            {health.backend}{health.detail ? ` · ${health.detail}` : ''}
          </Badge>
        )}
      </div>

      {/* Kind filter chips — Episode / Insight / Decision / … with live counts over the loaded set. */}
      {items !== null && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <KindChip on={kind === 'all'} onClick={() => setKind('all')}>All <span className="opacity-60">{items.length}</span></KindChip>
          {kindChips.map(([key, v]) => (
            <KindChip key={key} on={kind === key} onClick={() => setKind(key)}>
              {v.label} <span className="opacity-60">{v.count}</span>
            </KindChip>
          ))}
          {sharedCount > 0 && <span className="ml-auto text-[11px] text-muted-foreground">{sharedCount} shared workspace-wide</span>}
        </div>
      )}

      {/* Memories */}
      <section>
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>{query ? 'Matches' : 'Recent'}</span>
          {items !== null && <span className="normal-case tracking-normal text-muted-foreground/70">· {shown.length} shown</span>}
        </div>
        {items === null && <div className="text-sm text-muted-foreground">Loading…</div>}
        {items !== null && items.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {query ? 'No memories match that search.' : 'No memories yet — the agent accretes them as it works (episodes at session end, facts it chooses to remember), or add one with “Add memory” above.'}
          </div>
        )}
        {items !== null && items.length > 0 && shown.length === 0 && (
          <div className="text-sm text-muted-foreground">No {kindCounts.get(kind)?.label ?? kind} memories in this view.</div>
        )}
        <div className="space-y-2">
          {shown.map((m) => (
            <MemoryCard key={m.id} m={m} agentId={agentId} me={me} onChanged={() => load()} />
          ))}
        </div>
      </section>

    </div>
  )
}

function MemoryCard({ m, agentId, me, onChanged }: { m: MemoryRecord; agentId: string; me: Member; onChanged: () => void }) {
  // Curation: edit/remove your assigned agent's own memories; owners/admins may curate ANY (incl. another
  // agent's shared one). Server enforces this too — this just hides controls that would 404 for members.
  const canEdit = m.agentId === agentId || me.role === 'owner' || me.role === 'admin'
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState(m.content)
  const [tags, setTags] = useState(visibleTags(m.tags).join(', '))
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const save = async () => {
    setBusy(true); setHint('')
    const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean)
    const r = await api.updateMemory(m.id, { agent: agentId, content: content.trim(), tags: tagList })
    setBusy(false)
    if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed'))
    setEditing(false); onChanged()
  }
  const remove = async () => {
    if (!confirm('Delete this memory?')) return
    setBusy(true)
    const r = await api.deleteMemory(m.id, agentId)
    setBusy(false)
    if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed'))
    onChanged()
  }

  if (editing) {
    return (
      <Card>
        <CardContent className="space-y-2 p-3">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[60px] text-sm" />
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags (comma-separated)" className="text-xs" />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || !content.trim()} onClick={save}><Check className="mr-1 h-3.5 w-3.5" />Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setContent(m.content); setTags(visibleTags(m.tags).join(', ')) }}>Cancel</Button>
            {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
          </div>
        </CardContent>
      </Card>
    )
  }

  const tagsShown = visibleTags(m.tags)
  const kind = memoryKind(m)
  const outcome = m.metadata && typeof m.metadata.outcome === 'string' ? m.metadata.outcome : ''
  const source = m.metadata && typeof m.metadata.source === 'string' ? m.metadata.source : ''
  const sal = m.metadata && typeof m.metadata.salience === 'object' && m.metadata.salience ? m.metadata.salience as Record<string, number> : null
  const impTitle = sal
    ? `importance ${(m.importance ?? 0).toFixed(2)} — graded by salience: ${sal.actions ?? 0} governed actions${sal.rejected ? `, ${sal.rejected} rejected` : ''}${sal.errors ? `, ${sal.errors} errors` : ''}${sal.budgetStops ? `, ${sal.budgetStops} budget stops` : ''}${sal.killswitch ? `, ${sal.killswitch} blocked` : ''}`
    : 'importance (how strongly this is weighted in recall)'
  return (
    <Card className="group">
      <CardContent className="p-3">
        {/* Header: kind + (episode) outcome + shared, with edit/delete on hover. */}
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge variant="secondary" className={`px-1.5 py-0 text-[10px] font-medium ${kind.episode ? 'text-violet-600' : ''}`}>{kind.label}</Badge>
            {kind.episode && outcome && (
              <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-normal ${outcomeTone(outcome)}`} title="session outcome">{outcome}</Badge>
            )}
            {m.scope === 'tenant' && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-sky-600" title={`shared workspace-wide · authored by ${m.agentId}`}>shared</Badge>
            )}
          </div>
          {canEdit && (
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="edit" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="delete" disabled={busy} onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          )}
        </div>
        {/* Content — whitespace-pre-wrap so multi-line episodes (Task / Outcome / summary) stay readable. */}
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.content}</div>
        {/* Footer: tags · importance · source · match · timestamp. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {tagsShown.map((t) => (
            <Badge key={t} variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{t}</Badge>
          ))}
          {typeof m.importance === 'number' && (
            <span title={impTitle}>imp {m.importance.toFixed(2)}</span>
          )}
          {kind.episode && source && <span title="how the episode was composed">via {source}</span>}
          {typeof m.score === 'number' && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-emerald-600" title="search relevance (keyword + vector, higher = better match)">
              match {m.score.toFixed(3)}
            </Badge>
          )}
          <span className="ml-auto">{new Date(m.ts).toLocaleString()}</span>
        </div>
        {hint && <div className="mt-1 font-mono text-xs text-destructive">{hint}</div>}
      </CardContent>
    </Card>
  )
}

// ── Agent CLAUDE.md editor ─────────────────────────────────────────────────────────
const NEW_AGENT_CLAUDE_TEMPLATE = `# Agent role

You are <one line: who this agent is and what it owns>.

## Scope
- What this agent should do.
- What it must NOT do.

## Conventions
- How to approach tasks; tools to prefer.

## Memory
Recall relevant context before non-trivial work; remember durable decisions, fixes, and gotchas with short tags.
`

/** Create a new claude-code agent: pick an id + describe it, write its CLAUDE.md. The server
 *  materialises a folder (agent.json + CLAUDE.md) under the data home, like any other agent. */
function NewAgentPage({ me, onCreated }: { me: Member; onCreated: (id: string) => void }) {
  const [id, setId] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [icon, setIcon] = useState<string | undefined>(undefined)
  const [tuning, setTuning] = useState<RuntimeTuning>({ model: 'claude-opus-4-8' })
  const [claudeMd, setClaudeMd] = useState(NEW_AGENT_CLAUDE_TEMPLATE)
  const [prompts, setPrompts] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  if (me.role !== 'owner' && me.role !== 'admin') {
    return <div className="text-sm text-muted-foreground">Creating agents requires owner or admin.</div>
  }

  const slug = id.trim().toLowerCase()
  const idOk = /^[a-z][a-z0-9-]{1,39}$/.test(slug)
  const canSubmit = idOk && claudeMd.trim().length > 0 && !busy

  const create = async () => {
    setBusy(true); setHint('')
    const examplePrompts = prompts.split('\n').map((s) => s.trim()).filter(Boolean)
    const r = await api.createAgent({ id: slug, description: description.trim(), category: category.trim(), icon, claudeMd, examplePrompts, ...tuning })
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed to create agent'))
    onCreated(r.id || slug)
  }

  return (
    <div className="max-w-3xl space-y-4">
      <a href={navHref('agents')} className="flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Agents
      </a>
      <p className="text-sm text-muted-foreground">
        A new agent is a folder under the data home holding an <span className="font-mono text-xs">agent.json</span> and a{' '}
        <span className="font-mono text-xs">CLAUDE.md</span>. It runs the real Claude (<span className="font-mono text-xs">claude-code</span>) in
        that folder, governed by the same gate as every other agent.
      </p>
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Agent id</label>
            <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. release-notes" className="font-mono text-sm" />
            <p className={`text-[11px] ${id && !idOk ? 'text-destructive' : 'text-muted-foreground'}`}>
              {id && !idOk ? 'lowercase letters, digits, hyphens; 2–40 chars, starts with a letter' : 'becomes the folder name — lowercase, hyphenated'}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="one line shown on the agent card" className="text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Category</label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Engineering, Marketing" className="text-sm" />
            <p className="text-[11px] text-muted-foreground">Optional. Groups the agent in the picker. Leave blank for “Uncategorized”.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Icon</label>
            <IconPicker value={icon} onChange={setIcon} />
            <p className="text-[11px] text-muted-foreground">Optional. Pick from the library or upload a custom SVG. Shown next to the agent everywhere it’s listed.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Starter prompts</label>
            <Textarea value={prompts} onChange={(e) => setPrompts(e.target.value)} className="min-h-[80px] text-sm" placeholder={'One per line — shown as clickable chips on the spawn card.\ne.g. Draft this week’s release notes from the merged PRs.\ne.g. Summarise open issues labelled bug.'} />
            <p className="text-[11px] text-muted-foreground">Optional. The first becomes the spawn box’s prefill; the rest are one-click chips. Up to 6.</p>
          </div>
          <div className="space-y-1">
            <TuningFields tuning={tuning} onChange={setTuning} modelPlaceholder="claude-opus-4-8" />
            <p className="text-[11px] text-muted-foreground">Per-agent overrides. Leave effort/permission on <span className="font-mono">inherit</span> to follow the workspace default (Settings → Runtime defaults). The gate-hook governs regardless of permission mode.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">CLAUDE.md <span className="text-destructive">*</span> — the agent's system prompt</label>
            <Textarea
              value={claudeMd}
              onChange={(e) => setClaudeMd(e.target.value)}
              className="min-h-[360px] font-mono text-xs leading-relaxed"
              placeholder={NEW_AGENT_CLAUDE_TEMPLATE}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={create} disabled={!canSubmit}>{busy ? 'Creating…' : 'Create agent'}</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** Per-agent model / effort / permission + starter prompts editor — rewrites agent.json; applies on
 *  the next session (prompts take effect immediately on the spawn card after the state refreshes). */
function AgentTuningCard({ agentId, onSaved }: { agentId: string; onSaved?: () => void }) {
  const [tuning, setTuning] = useState<RuntimeTuning>({})
  const [saved, setSaved] = useState<RuntimeTuning>({})
  const [description, setDescription] = useState('')
  const [savedDescription, setSavedDescription] = useState('')
  const [prompts, setPrompts] = useState('')
  const [savedPrompts, setSavedPrompts] = useState('')
  const [category, setCategory] = useState('')
  const [savedCategory, setSavedCategory] = useState('')
  const [icon, setIcon] = useState<string | undefined>(undefined)
  const [savedIcon, setSavedIcon] = useState<string | undefined>(undefined)
  const [secrets, setSecrets] = useState('')
  const [savedSecrets, setSavedSecrets] = useState('')
  const [netMode, setNetMode] = useState<'open' | 'allowlist'>('open')
  const [savedNetMode, setSavedNetMode] = useState<'open' | 'allowlist'>('open')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    api.agentConfig(agentId).then((r) => {
      if (r.error) return
      const t: RuntimeTuning = { model: r.model, effort: r.effort, permissionMode: r.permissionMode }
      const d = r.description ?? ''
      const p = (r.examplePrompts ?? []).join('\n')
      const c = r.category ?? ''
      const s = (r.shellSecrets ?? []).join(' ')
      const nm = r.netMode === 'allowlist' ? 'allowlist' : 'open'
      setTuning(t); setSaved(t); setDescription(d); setSavedDescription(d); setPrompts(p); setSavedPrompts(p); setCategory(c); setSavedCategory(c); setIcon(r.icon); setSavedIcon(r.icon); setSecrets(s); setSavedSecrets(s); setNetMode(nm); setSavedNetMode(nm)
    }).catch(() => {})
  }, [agentId])

  const dirty = JSON.stringify(tuning) !== JSON.stringify(saved) || description !== savedDescription || prompts !== savedPrompts || category !== savedCategory || icon !== savedIcon || secrets !== savedSecrets || netMode !== savedNetMode
  const save = async () => {
    setBusy(true); setHint('')
    const examplePrompts = prompts.split('\n').map((s) => s.trim()).filter(Boolean)
    const shellSecrets = secrets.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    // Always send `icon` (empty string clears it → server drops the manifest key).
    const r = await api.saveAgentConfig(agentId, { ...tuning, description: description.trim(), examplePrompts, shellSecrets, netMode, category: category.trim(), icon: icon ?? '' })
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    const t: RuntimeTuning = { model: r.model, effort: r.effort }
    const d = r.description ?? ''
    const p = (r.examplePrompts ?? []).join('\n')
    const c = r.category ?? ''
    const s = (r.shellSecrets ?? []).join(' ')
    const nm = r.netMode === 'allowlist' ? 'allowlist' : 'open'
    setTuning(t); setSaved(t); setDescription(d); setSavedDescription(d); setPrompts(p); setSavedPrompts(p); setCategory(c); setSavedCategory(c); setIcon(r.icon); setSavedIcon(r.icon); setSecrets(s); setSavedSecrets(s); setNetMode(nm); setSavedNetMode(nm); setHint('saved — applies on the next session'); setTimeout(() => setHint(''), 2500)
    onSaved?.()
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-xs font-medium"><SlidersHorizontal className="h-3.5 w-3.5" /> Runtime tuning</div>
        <TuningFields tuning={tuning} onChange={setTuning} />
        <div className="space-y-1">
          <label className="text-xs font-medium">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} className="text-sm" placeholder="one line shown on the agent card" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} className="text-sm" placeholder="e.g. Engineering, Marketing — blank for Uncategorized" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Icon</label>
          <IconPicker value={icon} onChange={setIcon} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Starter prompts</label>
          <Textarea value={prompts} onChange={(e) => setPrompts(e.target.value)} className="min-h-[70px] text-sm" placeholder={'One per line — clickable chips on the spawn card (up to 6).'} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Shell secrets</label>
          <Input value={secrets} onChange={(e) => setSecrets(e.target.value)} className="font-mono text-sm" placeholder="e.g. GH_TOKEN  (space/comma separated env-var names)" />
          <p className="text-[11px] text-muted-foreground">Vault keys exported as env vars into this agent's shell (so CLIs like <span className="font-mono">gh</span> authenticate). Store the value in <span className="font-medium">Settings → Secrets</span> (key = the name here; set its principal to <span className="font-mono">{agentId}</span> for a per-agent value, or leave tenant-wide). Resolved at launch, audited per key.</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium">Host access mode</label>
          <select value={netMode} onChange={(e) => setNetMode(e.target.value === 'allowlist' ? 'allowlist' : 'open')} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm">
            <option value="open">Open — govern only internal / listed hosts (default)</option>
            <option value="allowlist">Allowlist — lock to granted Host connections only</option>
          </select>
          <p className="text-[11px] text-muted-foreground">Only applies when <span className="font-medium">host governance</span> is on (Settings → Governance). <span className="font-mono">Open</span>: public-internet egress runs freely; internal-looking or listed <a href="#/connectors" className="underline hover:text-foreground">hosts</a> are gated. <span className="font-mono">Allowlist</span>: any reach to a host not granted to this agent pauses for approval.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={busy || !dirty}>{dirty ? 'Save' : 'Saved'}</Button>
          <span className="text-[11px] text-muted-foreground">Blank tuning = inherit the workspace default. Permission mode is the agent's posture; the gate-hook still blocks risky effects for approval.</span>
          {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

/** Trust & maturity — "can the system let this agent run with less oversight?" A read-only roll-up of
 *  the agent's real history: how autonomously it ran (vs. needing a human to approve), how often a human
 *  or policy said no, and its governed run outcomes. Maturity ≠ success rate — it weights autonomy,
 *  penalises denials, and discounts small samples so a handful of runs can't fake a track record. */
function AgentTrustCard({ agentId }: { agentId: string }) {
  const [s, setS] = useState<AgentStats | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setS(null); setErr('')
    api.agentStats(agentId).then((r) => setS(r.stats)).catch((e) => setErr(String(e?.message || e)))
  }, [agentId])

  if (err) return null // agent the caller can't see (403) — just hide the card
  const pct = (n: number) => Math.round(n * 100)
  // Maturity colour keys off confidence too: an unproven agent shows neutral, not alarming red.
  const tone = !s || s.confidence === 'none' ? 'muted' : s.maturity >= 0.66 ? 'good' : s.maturity >= 0.33 ? 'warn' : 'low'
  const barColor = tone === 'good' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : tone === 'low' ? 'bg-rose-500' : 'bg-muted-foreground/40'
  const confLabel: Record<AgentStats['confidence'], string> = { none: 'no runs yet', low: 'low confidence', medium: 'building trust', high: 'well-established' }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium"><Shield className="h-4 w-4 text-muted-foreground" /> Trust &amp; maturity</div>
          {s && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">{confLabel[s.confidence]}</Badge>}
        </div>
        {!s ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : s.runs.total === 0 ? (
          <div className="text-sm text-muted-foreground">No runs yet — trust is earned as this agent works. Metrics appear once it has run.</div>
        ) : (
          <>
            {/* Headline maturity score + bar */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold tabular-nums">{pct(s.maturity)}<span className="text-sm text-muted-foreground">/100</span></span>
                <span className="text-xs text-muted-foreground">maturity — autonomy, minus overrides, weighted by track record</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.max(2, pct(s.maturity))}%` }} />
              </div>
            </div>
            {/* Key metrics grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-1 sm:grid-cols-4">
              <Stat label="Runs" value={String(s.runs.total)} hint={`${s.runs.crashed} crashed`} />
              <Stat label="Autonomy" value={`${pct(s.autonomy)}%`} hint={`${s.actions.humanGated} needed a human`} />
              <Stat label="Overrides" value={String(s.deniedRuns)} hint={`${s.actions.rejected} rejected · ${s.actions.killswitch} killswitch`} tone={s.deniedRuns > 0 ? 'warn' : undefined} />
              <Stat label="Outcomes" value={s.successRate === null ? '—' : `${pct(s.successRate)}%`} hint={`${s.outcomes.success}✓ ${s.outcomes.failure}✗ ${s.outcomes.inconclusive}·`} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {(s.rated.up + s.rated.down) > 0 && (
                <span>Human verdicts: <span className="text-emerald-600 dark:text-emerald-500">{s.rated.up}👍</span> · <span className="text-rose-600 dark:text-rose-500">{s.rated.down}👎</span></span>
              )}
              {(s.tasks.done + s.tasks.blocked + s.tasks.cancelled) > 0 && (
                <span>Assigned tasks: {s.tasks.done} done · {s.tasks.blocked} blocked · {s.tasks.cancelled} cancelled</span>
              )}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A high outcome rate alone doesn't earn trust — an agent that needs a human to approve every action stays low-maturity
              by design. Denials (a human or policy saying “no”) and small samples both pull the score down. Rate a finished run
              👍/👎 from the Sessions list to feed the score a ground-truth verdict.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** One compact labelled metric for the trust card. */
function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''}`}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function AgentPage({ agentId, agents, onSaved }: { agentId: string; agents: AgentInfo[]; onSaved?: () => void }) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  // Bumped after a revert so both the tuning card (remounted via key) and the CLAUDE.md below re-fetch.
  const [revBump, setRevBump] = useState(0)
  const info = agents.find((a) => a.id === agentId)

  useEffect(() => {
    setLoaded(false)
    api.agentClaude(agentId).then((r) => {
      if (r.error) { setHint('⚠ ' + r.error); return }
      setContent(r.content ?? ''); setSaved(r.content ?? ''); setLoaded(true)
    }).catch(() => {})
  }, [agentId, revBump])

  const dirty = content !== saved
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveAgentClaude(agentId, content)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setSaved(content); setHint('saved — applies on the agent\'s next session'); setTimeout(() => setHint(''), 2500)
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <a href={navHref('agents')} className="flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Agents
        </a>
        {/* Open the Files browser scoped to this agent's folder (only for agents that live under the
            data home — bundled examples live outside it and aren't browsable here). */}
        {info?.deletable && (
          <Button render={<a href={navHref('files', 'agents/' + agentId)} />} size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" title="browse this agent's files">
            <FolderTree className="h-3.5 w-3.5" /> Files
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{agentId}</span>
        {info && <RuntimeBadge runtime={info.runtime} />} — this agent's <span className="font-mono text-xs">CLAUDE.md</span> is its
        system prompt: its role, conventions, and how it should use its tools (including when to
        <span className="font-mono text-xs"> recall</span>/<span className="font-mono text-xs">remember</span>). Applied on the agent's next session.
      </p>
      <AgentTrustCard agentId={agentId} />
      {info?.runtime === 'claude-code' && <AgentTuningCard key={revBump} agentId={agentId} onSaved={onSaved} />}
      <Card>
        <CardContent className="space-y-3 p-4">
          {!loaded && !hint ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="min-h-[420px] font-mono text-xs leading-relaxed"
                placeholder={'# Agent role\n\n## Conventions\n- ...\n\n## Memory\nRecall relevant context before non-trivial work; remember durable decisions, fixes, and gotchas with short tags.'}
              />
              <div className="flex items-center gap-3">
                <Button onClick={save} disabled={busy || !dirty}>{dirty ? 'Save' : 'Saved'}</Button>
                {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {info?.runtime === 'claude-code' && <AgentRevisionsCard agentId={agentId} onReverted={() => { setRevBump((n) => n + 1); onSaved?.() }} />}
    </div>
  )
}

/** Revision history for an agent's listing + CLAUDE.md — the human rollback for a self-editing agent.
 *  Every edit (by the agent via agent_update, or a human here) snapshots a full version; revert restores
 *  one and records a new revision, so nothing is ever lost. */
function AgentRevisionsCard({ agentId, onReverted }: { agentId: string; onReverted: () => void }) {
  const [revs, setRevs] = useState<AgentRevision[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const load = () => api.agentRevisions(agentId).then((r) => { if (!r.error) setRevs(r.revisions) }).catch(() => {})
  useEffect(() => { setRevs(null); setOpen(false); setHint('') }, [agentId])
  useEffect(() => { if (open && revs === null) load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const revert = async (rev: number) => {
    if (!window.confirm(`Revert ${agentId} to rev ${rev}?\n\nThis restores that revision's description, starter prompts, tuning, and CLAUDE.md, and records a new revision (so it too is reversible).`)) return
    setBusy(true); setHint('')
    const r = await api.agentRevert(agentId, rev)
    setBusy(false)
    if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed'))
    setHint(`reverted to rev ${rev}`); load(); onReverted(); setTimeout(() => setHint(''), 2500)
  }
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium"><HistoryIcon className="h-3.5 w-3.5" /> Revision history</div>
          <div className="flex items-center gap-3">
            {hint && <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>}
            <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</Button>
          </div>
        </div>
        {open && (
          revs === null ? <div className="text-xs text-muted-foreground">Loading…</div>
          : revs.length === 0 ? <div className="text-xs text-muted-foreground">No revisions yet — edits to this agent's listing or CLAUDE.md (by the agent itself or a human) will show up here.</div>
          : <div className="space-y-1">
              {revs.map((rv) => (
                <div key={rv.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50">
                  <span className="min-w-0 flex-1 truncate"><span className="font-mono">rev {rv.rev}</span> · {new Date(rv.createdAt).toLocaleString()} · {rv.author}{rv.summary ? ` — ${rv.summary}` : ''}</span>
                  {rv.rev !== revs[0].rev && <button className="shrink-0 text-muted-foreground underline hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => revert(rv.rev)}>revert</button>}
                </div>
              ))}
            </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Skills (the global Claude Code Skills library) ──────────────────────────────────
/** The workspace skills library: native `.claude/skills` SKILL.md playbooks synced into every
 *  claude-code agent at launch. Per-agent skills live in the agent's own folder (see Files). */
function SkillsPage() {
  const [resp, setResp] = useState<SkillsResp | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const load = () => api.skills().then(setResp).catch(() => setResp({ enabled: false, skills: [] }))
  useEffect(() => {
    load()
    api.state().then((s) => setAgents(s.agents.filter((a) => a.runtime === 'claude-code').map((a) => a.id))).catch(() => {})
  }, [])

  // Drag-and-drop / file-picker install: upload each dropped .zip, then refresh the library.
  const uploadZips = async (files: FileList | File[]) => {
    const zips = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.zip'))
    if (zips.length === 0) return setUploadMsg('⚠ drop a .zip skill file')
    setUploading(true); setUploadMsg('')
    const installed: string[] = []
    for (const f of zips) {
      const r = await api.uploadSkillZip(f).catch(() => ({ ok: false, error: 'upload failed' } as Awaited<ReturnType<typeof api.uploadSkillZip>>))
      if (!r.ok || r.error) { setUploading(false); load(); return setUploadMsg(`⚠ ${f.name}: ${r.error || 'upload failed'}`) }
      installed.push(...(r.skills || []).map((s) => s.name))
    }
    setUploading(false)
    setUploadMsg(installed.length ? `✓ Installed ${installed.join(', ')}` : '✓ Uploaded')
    load()
  }
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault(); setDragOver(false)
    if (e.dataTransfer?.files?.length) uploadZips(e.dataTransfer.files)
  }

  if (!resp) return <div className="text-sm text-muted-foreground">Loading…</div>

  // Proposals (skills agents drafted via `skill_propose`) are held back from the live library until a
  // human publishes them — surface them in their own review section, keep the Library to live skills.
  const proposed = resp.skills.filter((s) => s.proposed)
  const published = resp.skills.filter((s) => !s.proposed)

  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Skills are reusable, named playbooks in Claude Code's native <span className="font-mono text-xs">.claude/skills</span> format.
        A skill is synced into its assigned claude-code agents at launch — an agent auto-invokes one when its <span className="font-mono text-xs">description</span> matches
        the task, or you can call it with <span className="font-mono text-xs">/name</span>. By default a skill reaches <span className="font-medium text-foreground">every agent</span>;
        use <span className="font-medium text-foreground">Assign</span> on a skill to scope it to specific agents. (A hand-authored skill dropped in an agent's own folder via{' '}
        <a href={navHref('files')} className="underline hover:text-foreground">Files</a> still shadows the global one.)
      </p>

      {!resp.enabled && (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Skills need a data home — none is configured for this instance.
        </div>
      )}

      {proposed.length > 0 && (
        <section className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 p-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-violet-700">
            <Sparkles className="h-3.5 w-3.5" />Proposed by self-learning · {proposed.length}
          </div>
          <p className="text-xs text-muted-foreground">
            An agent drafted these via <span className="font-mono">skill_propose</span>. They are <span className="font-medium text-foreground">not live</span> —
            no agent can use one until you <span className="font-medium text-foreground">Publish</span> it. Review (and edit) the draft, then publish or dismiss.
          </p>
          <div className="space-y-2">
            {proposed.map((s) => <ProposedSkillCard key={s.name} s={s} onChanged={load} />)}
          </div>
        </section>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* Left: this tenant's installed library — also the drop target for skill .zips */}
        <section
          className={`relative min-w-0 rounded-lg transition-colors ${dragOver ? 'outline-dashed outline-2 outline-primary/60 bg-primary/5' : ''}`}
          onDragOver={resp.enabled ? (e) => { e.preventDefault(); setDragOver(true) } : undefined}
          onDragLeave={resp.enabled ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) } : undefined}
          onDrop={resp.enabled ? onDrop : undefined}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Library · {published.length}</div>
            {resp.enabled && !creating && (
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" accept=".zip,application/zip" multiple className="hidden"
                  onChange={(e) => { if (e.target.files?.length) uploadZips(e.target.files); e.target.value = '' }} />
                <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  <Upload className="mr-1 h-4 w-4" />{uploading ? 'Uploading…' : 'Upload skill'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="mr-1 h-4 w-4" />New skill</Button>
              </div>
            )}
          </div>
          {uploadMsg && <div className={`mb-2 text-xs ${uploadMsg.startsWith('⚠') ? 'text-destructive' : 'text-muted-foreground'}`}>{uploadMsg}</div>}
          {creating && <NewSkillForm onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); load() }} />}
          {published.length === 0 && !creating && (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No skills yet — drag a skill <span className="font-mono text-xs">.zip</span> here, use <span className="font-medium text-foreground">Upload skill</span>, install one from the right, or add your own.
            </div>
          )}
          <div className="space-y-2">
            {published.map((s) => <SkillCard key={s.name} s={s} agents={agents} onChanged={load} />)}
          </div>
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-background/70 text-sm font-medium text-foreground">
              <Upload className="mr-2 h-5 w-5" />Drop skill .zip to install
            </div>
          )}
        </section>

        {/* Right: add skills — bundled catalog + install straight from a repo */}
        {resp.enabled && (
          <aside className="min-w-0 space-y-3 lg:sticky lg:top-4">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Add skills</div>
            <SkillCatalog onInstalled={load} />
            <SkillshSearch onInstalled={load} />
            <RemoteSkillInstaller onInstalled={load} />
          </aside>
        )}
      </div>
    </div>
  )
}

/** The bundled skill library — skills that ship with the software, one-click installable into the
 *  tenant's own library. Collapsed by default; install copies the playbook (+ its files) into <home>/skills. */
/** The agent library — the catalog of ready-made agents that ships with Agent OS (`config/agents`).
 *  Install one to copy it into this workspace as a normal, editable agent. Distribution-only: the list
 *  is fixed by what ships, and the built-in fleet shows as already installed. Mirrors SkillCatalog. */
function AgentLibrary({ open, onOpenChange, onInstalled }: { open: boolean; onOpenChange: (o: boolean) => void; onInstalled: () => void | Promise<void> }) {
  const [catalog, setCatalog] = useState<CatalogAgent[] | null>(null)
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  const load = () => api.agentCatalog().then((r) => setCatalog(r.catalog ?? [])).catch(() => setCatalog([]))
  // Load (and refresh) whenever the dialog opens, so installed/available flags reflect current state.
  useEffect(() => { if (open) { setHint(''); load() } }, [open])

  const install = async (id: string) => {
    setBusy(id); setHint('')
    const r = await api.installAgentFromCatalog(id)
    setBusy('')
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed to install'))
    setHint(`Installed "${id}" — it's live in your fleet now.`); setTimeout(() => setHint(''), 3000)
    load(); await onInstalled()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full max-w-[calc(100%-2rem)] gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
            Agent library
          </DialogTitle>
          <div className="text-xs text-muted-foreground">Ready-made agents bundled with Agent OS. Install one to copy it into your fleet — then edit, tune, assign, or delete it like any other agent.</div>
        </DialogHeader>
        {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {!catalog ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : catalog.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">The agent library is empty.</p>
          ) : catalog.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex items-start justify-between gap-3 p-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <AgentIcon icon={c.icon} className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-sm font-medium">{c.id}</span>
                      {c.category && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{c.category}</Badge>}
                      {c.builtin && <BuiltInBadge />}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">{c.description || <span className="italic">no description</span>}</div>
                  </div>
                </div>
                {c.installed ? (
                  <Badge variant="secondary" className="shrink-0 gap-1"><Check className="h-3 w-3" />Installed</Badge>
                ) : (
                  <Button size="sm" variant="outline" className="shrink-0" disabled={!!busy} onClick={() => install(c.id)}>
                    <Download className="mr-1 h-3.5 w-3.5" />{busy === c.id ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SkillCatalog({ onInstalled }: { onInstalled: () => void }) {
  const [catalog, setCatalog] = useState<CatalogSkill[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  const load = () => api.skillCatalog().then((r) => setCatalog(r.catalog ?? [])).catch(() => setCatalog([]))
  useEffect(() => { load() }, [])

  const install = async (name: string) => {
    setBusy(name); setHint('')
    const r = await api.installSkill(name)
    setBusy('')
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed to install'))
    setHint(`Installed "${name}" — reaches its agents on their next session.`); setTimeout(() => setHint(''), 3000)
    load(); onInstalled()
  }

  if (!catalog || catalog.length === 0) return null
  const available = catalog.filter((c) => !c.installed).length

  return (
    <section className="rounded-md border bg-muted/30">
      <button className="flex w-full items-center justify-between gap-2 p-3 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4 text-muted-foreground" />
          Skill library
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{available} to install</Badge>
        </span>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t p-3">
          <p className="text-xs text-muted-foreground">Curated playbooks bundled with Agent OS. Install one to copy it into your library — then edit, assign, or delete it like any other skill.</p>
          {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}
          {catalog.map((c) => (
            <Card key={c.name}>
              <CardContent className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-sm font-medium">{c.name}</span>
                    {c.files.length > 0 && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">+{c.files.length} file{c.files.length > 1 ? 's' : ''}</Badge>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{c.description || <span className="italic">no description</span>}</div>
                </div>
                {c.installed ? (
                  <Badge variant="secondary" className="shrink-0 gap-1"><Check className="h-3 w-3" />Installed</Badge>
                ) : (
                  <Button size="sm" variant="outline" className="shrink-0" disabled={!!busy} onClick={() => install(c.name)}>
                    <Download className="mr-1 h-3.5 w-3.5" />{busy === c.name ? 'Installing…' : 'Install'}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}

/** Search the whole skills.sh directory (every indexed repo) and install any hit. Separate from the
 *  repo-browse panel: this is keyword search across thousands of skills, ranked by install count. */
function SkillshSearch({ onInstalled }: { onInstalled: () => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SkillshHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState('')
  const [err, setErr] = useState('')

  const search = async () => {
    if (!q.trim()) return
    setSearching(true); setErr(''); setHits(null)
    const r = await api.searchSkillsh(q)
    setSearching(false)
    if (r.error) return setErr('⚠ ' + r.error)
    setHits(r.hits)
  }
  const install = async (h: SkillshHit) => {
    setInstalling(h.source + '/' + h.skillId); setErr('')
    const r = await api.installRemoteSkill(h.source, '', h.skillId)
    setInstalling('')
    if (!r.ok || r.error) return setErr('⚠ ' + (r.error || 'install failed'))
    setHits((cur) => cur?.map((x) => x === h ? { ...x, installed: true } : x) ?? cur)
    onInstalled()
  }

  return (
    <section className="rounded-md border bg-muted/30">
      <button className="flex w-full items-center justify-between gap-2 p-3 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Search className="h-4 w-4 text-muted-foreground" />
          Search skills.sh
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">directory</Badge>
        </span>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Keyword-search the entire <a className="underline hover:text-foreground" href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a> directory
            (thousands of skills across every indexed repo), ranked by installs. Install pulls from the source repo on GitHub.
          </p>
          <div className="flex items-center gap-2">
            <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search() }}
              placeholder="search skills… (seo, copywriting, testing)" className="text-sm" />
            <Button size="sm" variant="outline" disabled={searching || !q.trim()} onClick={search}>{searching ? 'Searching…' : 'Search'}</Button>
          </div>
          {err && <div className="font-mono text-xs text-destructive">{err}</div>}
          {hits && hits.length === 0 && <div className="text-sm text-muted-foreground">No skills found for “{q}”.</div>}
          {hits && hits.length > 0 && (
            <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{hits.length} result{hits.length === 1 ? '' : 's'}</div>
              {hits.map((h) => (
                <Card key={h.source + '/' + h.skillId}>
                  <CardContent className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-medium">{h.name}</span>
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{h.installs.toLocaleString()} installs</Badge>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{h.source}</div>
                    </div>
                    {h.installed ? (
                      <Badge variant="secondary" className="shrink-0 gap-1"><Check className="h-3 w-3" />Installed</Badge>
                    ) : (
                      <Button size="sm" variant="outline" className="shrink-0" disabled={!!installing} onClick={() => install(h)}>
                        <Download className="mr-1 h-3.5 w-3.5" />{installing === h.source + '/' + h.skillId ? 'Installing…' : 'Install'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Install skills straight from a public GitHub repo — featured presets (the marketing set, a
 *  skills.sh starter) plus a free-form owner/repo box. Covers any skills.sh entry, since those are
 *  just GitHub repos. Browsing lists the repo's skills; each installs into this tenant's library. */
function RemoteSkillInstaller({ onInstalled }: { onInstalled: () => void }) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<SkillSource[]>([])
  const [repo, setRepo] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [result, setResult] = useState<{ repo: string; ref: string; repoDescription: string; skills: RemoteSkill[] } | null>(null)
  const [installing, setInstalling] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { if (open && presets.length === 0) api.skillSources().then((r) => setPresets(r.presets ?? [])).catch(() => {}) }, [open])

  const browse = async (r?: string) => {
    const target = (r ?? repo).trim()
    if (!target) return
    setRepo(target); setBrowsing(true); setErr(''); setResult(null)
    const resp = await api.browseSkillRepo(target)
    setBrowsing(false)
    if (resp.error) return setErr('⚠ ' + resp.error)
    setResult(resp)
  }
  const install = async (s: RemoteSkill) => {
    if (!result) return
    setInstalling(s.name); setErr('')
    const resp = await api.installRemoteSkill(result.repo, s.path, s.name)
    setInstalling('')
    if (!resp.ok || resp.error) return setErr('⚠ ' + (resp.error || 'install failed'))
    setResult({ ...result, skills: result.skills.map((x) => x.name === s.name ? { ...x, installed: true } : x) })
    onInstalled()
  }

  return (
    <section className="rounded-md border bg-muted/30">
      <button className="flex w-full items-center justify-between gap-2 p-3 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Download className="h-4 w-4 text-muted-foreground" />
          Install from a repo
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">GitHub · skills.sh</Badge>
        </span>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Pull skills from any public GitHub repo of <span className="font-mono">SKILL.md</span> folders — including every{' '}
            <a className="underline hover:text-foreground" href="https://skills.sh" target="_blank" rel="noreferrer">skills.sh</a> entry
            (those are just repos; paste <span className="font-mono">owner/repo</span>).
          </p>
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {presets.map((s) => (
                <button key={s.repo} title={s.description} onClick={() => browse(s.repo)}
                  className="rounded-md border bg-background px-2.5 py-1.5 text-left text-xs hover:border-foreground/30">
                  <div className="font-medium">{s.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{s.repo}</div>
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input value={repo} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') browse() }}
              placeholder="owner/repo  (e.g. coreyhaines31/marketingskills)" className="font-mono text-sm" />
            <Button size="sm" variant="outline" disabled={browsing || !repo.trim()} onClick={() => browse()}>
              {browsing ? 'Browsing…' : 'Browse'}
            </Button>
          </div>
          {err && <div className="font-mono text-xs text-destructive">{err}</div>}
          {browsing && <div className="text-sm text-muted-foreground">Fetching skills from GitHub…</div>}
          {result && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {result.repo}<span className="lowercase"> @ {result.ref}</span> · {result.skills.length} skill{result.skills.length === 1 ? '' : 's'}
              </div>
              {result.skills.length === 0 && <div className="text-sm text-muted-foreground">No SKILL.md folders found in this repo.</div>}
              {result.skills.map((s) => (
                <Card key={s.name}>
                  <CardContent className="flex items-start justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-medium">{s.name}</span>
                        {s.files.length > 0 && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">+{s.files.length} file{s.files.length > 1 ? 's' : ''}</Badge>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">{s.description || <span className="italic">no description</span>}</div>
                    </div>
                    {s.installed ? (
                      <Badge variant="secondary" className="shrink-0 gap-1"><Check className="h-3 w-3" />Installed</Badge>
                    ) : (
                      <Button size="sm" variant="outline" className="shrink-0" disabled={!!installing} onClick={() => install(s)}>
                        <Download className="mr-1 h-3.5 w-3.5" />{installing === s.name ? 'Installing…' : 'Install'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function NewSkillForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const slug = name.trim().toLowerCase()
  const idOk = /^[a-z][a-z0-9-]{1,39}$/.test(slug)

  const create = async () => {
    setBusy(true); setHint('')
    const r = await api.createSkill({ name: slug, description: description.trim() })
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed to create skill'))
    onCreated()
  }

  return (
    <Card className="mb-2">
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium">Skill name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. release-notes" className="font-mono text-sm" />
            <p className={`text-[11px] ${name && !idOk ? 'text-destructive' : 'text-muted-foreground'}`}>
              {name && !idOk ? 'lowercase letters, digits, hyphens; 2–40 chars, starts with a letter' : 'becomes the folder + the /command name'}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="when Claude should reach for this" className="text-sm" />
            <p className="text-[11px] text-muted-foreground">Claude matches on this to auto-invoke</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={create} disabled={busy || !idOk}>{busy ? 'Creating…' : 'Create skill'}</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

/** A skill an agent drafted via `skill_propose`, awaiting a human's review. Review opens the draft in an
 *  editable box (edits save to the same SKILL.md); Publish drops the `.aos-proposed` marker so it goes
 *  live on each agent's next session; Dismiss deletes the draft. Owner/admin only (the page is gated). */
function ProposedSkillCard({ s, onChanged }: { s: SkillSummary; onChanged: () => void }) {
  const [reviewing, setReviewing] = useState(false)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const open = async () => {
    setReviewing(true); setHint('')
    const r = await api.skill(s.name)
    if (r.error) return setHint('⚠ ' + r.error)
    setContent(r.content ?? ''); setSaved(r.content ?? '')
  }
  const dirty = content !== saved
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveSkill(s.name, content)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    setSaved(content); setHint('draft saved'); setTimeout(() => setHint(''), 2000)
  }
  const publish = async () => {
    setBusy(true); setHint('')
    const r = await api.publishSkill(s.name)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    onChanged()
  }
  const dismiss = async () => {
    if (!confirm(`Dismiss the proposed skill "${s.name}"? The draft is deleted.`)) return
    setBusy(true); setHint('')
    const r = await api.deleteSkill(s.name)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    onChanged()
  }

  return (
    <Card className="border-violet-200">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <button className="min-w-0 text-left" onClick={reviewing ? () => setReviewing(false) : open}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-sm font-medium">{s.name}</span>
              <Badge variant="outline" className="border-violet-300 px-1.5 py-0 text-[10px] font-normal text-violet-700">proposed</Badge>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">{s.description || <span className="italic">no description</span>}</div>
            {s.proposal && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                {s.proposal.agent ? <>by <span className="font-mono">{s.proposal.agent}</span></> : 'by an agent'}
                {s.proposal.at ? ` · ${timeAgo(s.proposal.at)}` : ''}
                {s.proposal.rationale ? <> · <span className="italic">“{s.proposal.rationale}”</span></> : null}
              </div>
            )}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="outline" disabled={busy} onClick={reviewing ? () => setReviewing(false) : open}>
              <Pencil className="mr-1 h-3.5 w-3.5" />Review
            </Button>
            <Button size="sm" disabled={busy} onClick={publish}><Check className="mr-1 h-3.5 w-3.5" />Publish</Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="dismiss" disabled={busy} onClick={dismiss}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        {reviewing && (
          <div className="mt-3 space-y-2">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[320px] font-mono text-xs leading-relaxed" />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={save} disabled={busy || !dirty}>{dirty ? 'Save draft' : 'Saved'}</Button>
              <Button size="sm" onClick={publish} disabled={busy}>Publish</Button>
              <Button size="sm" variant="ghost" onClick={() => setReviewing(false)}>Close</Button>
              {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            </div>
          </div>
        )}
        {!reviewing && hint && <div className="mt-1 font-mono text-xs text-destructive">{hint}</div>}
      </CardContent>
    </Card>
  )
}

function SkillCard({ s, agents, onChanged }: { s: SkillSummary; agents: string[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [sel, setSel] = useState<string[]>(s.agents)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const open = async () => {
    setEditing(true); setHint('')
    const r = await api.skill(s.name)
    if (r.error) return setHint('⚠ ' + r.error)
    setContent(r.content ?? ''); setSaved(r.content ?? '')
  }
  const dirty = content !== saved
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveSkill(s.name, content)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    setSaved(content); setHint("saved — applies on each agent's next session"); setTimeout(() => setHint(''), 2500); onChanged()
  }
  const remove = async () => {
    if (!confirm(`Delete skill "${s.name}"? It's removed from every agent on their next session.`)) return
    setBusy(true); setHint('')
    const r = await api.deleteSkill(s.name)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    onChanged()
  }
  const duplicate = async () => {
    const to = prompt(`Duplicate "${s.name}" as a new skill. Enter a name for the copy:`, `${s.name}-copy`)
    if (!to) return
    setBusy(true); setHint('')
    const r = await api.duplicateSkill(s.name, to.trim().toLowerCase())
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'could not duplicate skill'))
    setHint(`duplicated as "${r.skill?.name ?? to}"`); setTimeout(() => setHint(''), 2500); onChanged()
  }
  const openAssign = () => { setSel(s.agents); setAssigning((v) => !v); setHint('') }
  const toggle = (id: string) => setSel((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  // "Specific" with nothing checked = every agent (an empty assignment), so guard against that footgun.
  const all = sel.length === 0
  const saveAssign = async () => {
    setBusy(true); setHint('')
    const r = await api.setSkillAgents(s.name, sel)
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed'))
    setAssigning(false); setHint('audience saved'); setTimeout(() => setHint(''), 2000); onChanged()
  }

  return (
    <Card className="group">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <button className="min-w-0 text-left" onClick={editing ? () => setEditing(false) : open}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-sm font-medium">{s.name}</span>
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">/{s.name}</Badge>
              {s.files.length > 0 && (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">+{s.files.length} file{s.files.length > 1 ? 's' : ''}</Badge>
              )}
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal" title={s.agents.length ? s.agents.join(', ') : 'every claude-code agent'}>
                {s.agents.length === 0 ? 'All agents' : s.agents.length === 1 ? s.agents[0] : `${s.agents.length} agents`}
              </Badge>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {s.description ? (() => {
                const LIMIT = 140
                const long = s.description.length > LIMIT
                return (
                  <>
                    {long && !expanded ? s.description.slice(0, LIMIT).trimEnd() + '…' : s.description}
                    {long && (
                      <span role="button" tabIndex={0}
                        className="ml-1 font-medium text-foreground/70 underline underline-offset-2 hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}>
                        {expanded ? 'less' : 'more'}
                      </span>
                    )}
                  </>
                )
              })() : <span className="italic">no description</span>}
            </div>
          </button>
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="assign to agents" onClick={openAssign}><Bot className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="edit" onClick={editing ? () => setEditing(false) : open}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="duplicate — deep-copy this skill under a new name (assignments reset to all agents)" disabled={busy} onClick={duplicate}><Copy className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="delete" disabled={busy} onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        {assigning && (
          <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Assign to agents</div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={all} onChange={() => setSel([])} />
              <span>All agents <span className="text-muted-foreground">(default)</span></span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" checked={!all} onChange={() => setSel(agents.length ? [agents[0]] : [])} disabled={agents.length === 0} />
              <span>Specific agents</span>
            </label>
            {!all && (
              <div className="ml-6 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                {agents.map((id) => (
                  <label key={id} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={sel.includes(id)} onChange={() => toggle(id)} />
                    <span className="truncate font-mono text-xs" title={id}>{id}</span>
                  </label>
                ))}
                {agents.length === 0 && <span className="text-xs text-muted-foreground">no claude-code agents</span>}
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={saveAssign} disabled={busy}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setAssigning(false)}>Cancel</Button>
              {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            </div>
          </div>
        )}
        {editing && (
          <div className="mt-3 space-y-2">
            <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-[320px] font-mono text-xs leading-relaxed" />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={busy || !dirty}>{dirty ? 'Save' : 'Saved'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Close</Button>
              {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            </div>
          </div>
        )}
        {!editing && !assigning && hint && <div className="mt-1 font-mono text-xs text-destructive">{hint}</div>}
      </CardContent>
    </Card>
  )
}

// ── Settings (Company context + Policy) ────────────────────────────────────────────
/**
 * Settings → Self-learning. The OS periodically reflects on recent runs (episodes + outcomes + friction)
 * and writes a shared memory Insight + a living KB page (operations/fleet-learnings). Set a cadence to
 * automate it, or run a pass now.
 */
function DreamingSettings({ me, onChanged }: { me: Member; onChanged?: () => void }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [everyHours, setEveryHours] = useState('0')
  const [last, setLast] = useState<number | undefined>(undefined)
  const [apply, setApply] = useState(true)
  const [guidance, setGuidance] = useState('')
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [activity, setActivity] = useState<{ ts: number; type: string; principal?: string; data: Record<string, unknown> }[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [result, setResult] = useState<string>('')

  const refresh = () => {
    api.dreaming().then((r) => { if (r.error) return; setEveryHours(String(r.everyHours ?? 0)); setLast(r.lastDreamedAt); setApply(r.applyLearnings !== false); setGuidance(r.guidance ?? ''); setRecs(r.recommendations ?? []) }).catch(() => {})
    api.memoryOverview().then((r) => { if (!r.error) setActivity(r.activity ?? []) }).catch(() => {})
  }
  const applyRec = async (id: string) => { setBusy(true); const r = await api.applyRecommendation(id); setBusy(false); if (r.error) return setHint('⚠ ' + r.error); setHint('applied'); setTimeout(() => setHint(''), 1500); refresh() }
  const dismissRec = async (id: string) => { setBusy(true); await api.dismissRecommendation(id); setBusy(false); refresh() }
  useEffect(() => { refresh() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [])
  const toggleApply = async (on: boolean) => { setApply(on); await api.setApplyLearnings(on) }

  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.setDreaming(Number(everyHours) || 0)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setEveryHours(String(r.everyHours)); setHint('saved'); setTimeout(() => setHint(''), 1500)
  }
  const runNow = async () => {
    setBusy(true); setHint(''); setResult('')
    const r = await api.dreamingRun()
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    if (r.skipped) { setResult('No new activity since the last pass — nothing to learn.') }
    else {
      const c = r.consolidation
      const grew = c?.spawned
        ? ` Growing shared knowledge — memory-gardener spawned over ${c.items ?? 0} episodes/lessons (watch Sessions/Audit).`
        : ` No new material worth an agent run to consolidate${c?.reason ? ` (${c.reason})` : ''}.`
      setResult(`Reflected on ${r.sessions ?? 0} sessions / ${r.episodes ?? 0} episodes → refreshed guidance${r.insightId ? ' + a shared insight' : ''} + the KB page.${grew}`)
    }
    refresh(); onChanged?.()
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Reflect</div>
            <p className="text-xs text-muted-foreground">Each pass: <strong>tally</strong> recent episodes/outcomes/friction into the guidance below (instant, free), then spawn the <strong>memory gardener</strong> to distil recent episodes + lessons into <strong>shared memories + <a className="underline" href="#/kb">Knowledge</a> pages</strong> — only when there's new material worth an agent run.</p>
          </div>
          <div className="flex items-end gap-3">
            <Field label="Reflect automatically every (hours)" help="0 = off (manual only). Daily (24) is a sensible default.">
              <Input value={everyHours} onChange={(e) => setEveryHours(e.target.value)} className="w-28 font-mono text-xs" placeholder="0" />
            </Field>
            <Button onClick={save} disabled={busy}>Save</Button>
            <Button variant="outline" onClick={runNow} disabled={busy}><Sparkles className="mr-1 h-4 w-4" />Reflect now</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {last ? `Last reflected: ${new Date(last).toLocaleString()}.` : 'No pass has run yet.'}
            {Number(everyHours) > 0 ? ` Scheduled every ${Number(everyHours)}h.` : ' Automatic passes are off.'}
          </div>
          {result && <div className="rounded-md border bg-muted/40 p-2 text-xs">{result}</div>}
        </CardContent>
      </Card>

      {/* The closed loop: inject distilled guidance into every agent's prompt. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Apply learnings to agents <span className="text-[11px] font-normal text-muted-foreground">— closes the loop</span></div>
            <p className="text-xs text-muted-foreground">When on, the distilled guidance below is injected into <strong>every</strong> claude-code agent's system prompt at launch — so the fleet's experience shapes future behavior. It's prompting (visible + reversible), not auto-rewriting policy or budgets.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={apply} onChange={(e) => toggleApply(e.target.checked)} />
            Inject learned guidance into agent prompts
          </label>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Current guidance {apply ? '(active)' : '(saved, not applied)'}</div>
            {guidance.trim()
              ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed">{guidance}</pre>
              : <div className="text-xs text-muted-foreground">No guidance yet — run a pass (above) once agents have done some work.</div>}
          </div>
        </CardContent>
      </Card>

      {/* The config loop: human-gated tuning proposals derived from friction. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Recommendations <span className="text-[11px] font-normal text-muted-foreground">— config loop (you approve)</span></div>
            <p className="text-xs text-muted-foreground">Config changes the OS proposes from observed friction. Nothing is applied automatically — Apply makes a concrete, reversible change (audited); Dismiss hides it for good.</p>
          </div>
          {recs.length === 0
            ? <div className="text-xs text-muted-foreground">No recommendations right now. Run a pass — if agents are hitting friction (rejections, budget stops, low success), proposals appear here.</div>
            : recs.map((r) => (
                <div key={r.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium"><Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{r.kind}</Badge>{r.title}</div>
                      <p className="mt-1 text-xs text-muted-foreground">{r.rationale}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {r.apply
                        ? <Button size="sm" onClick={() => applyRec(r.id)} disabled={busy}><Check className="mr-1 h-3.5 w-3.5" />Apply</Button>
                        : r.link && <Button render={<a href={r.link.startsWith('#') ? r.link : '#' + r.link} />} size="sm" variant="outline">Review</Button>}
                      <Button size="sm" variant="ghost" onClick={() => dismissRec(r.id)} disabled={busy}>Dismiss</Button>
                    </div>
                  </div>
                </div>
              ))}
        </CardContent>
      </Card>

      {/* Recent learning activity — the loop, made legible (moved here from the old Overview tab). */}
      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Recent learning activity</div>
        <Card>
          <CardContent className="p-0">
            {activity.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">Nothing yet. As agents finish sessions they leave episodes/lessons; reflect + consolidation events show here.</div>
            ) : (
              <div className="divide-y">
                {activity.map((e, i) => (
                  <div key={i} className="flex items-start gap-3 px-3 py-2 text-xs">
                    <span className="w-32 shrink-0 text-muted-foreground">{new Date(e.ts).toLocaleString()}</span>
                    <span className="shrink-0">{learningLabel(e.type)}</span>
                    <span className="min-w-0 flex-1 text-muted-foreground">{learningDetail(e)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

// ── Session activity (which agent-os primitives a run used) ──────────────────────
/** Per-category visual style for the activity timeline — icon + accent, mirroring the OS planes. */
const ACTIVITY_STYLE: Record<ActivityEvent['category'], { icon: LucideIcon; label: string; cls: string }> = {
  action:     { icon: Zap,           label: 'Governed action', cls: 'text-amber-600' },
  operator:   { icon: MessageSquare, label: 'Operator',        cls: 'text-blue-600' },
  memory:     { icon: Brain,         label: 'Memory',          cls: 'text-violet-600' },
  knowledge:  { icon: BookText,      label: 'Knowledge',       cls: 'text-emerald-600' },
  tasks:      { icon: ListChecks,    label: 'Tasks',           cls: 'text-sky-600' },
  scheduling: { icon: Clock,         label: 'Scheduling',      cls: 'text-orange-600' },
  agents:     { icon: Bot,           label: 'Agents',          cls: 'text-pink-600' },
  approval:   { icon: Shield,        label: 'Approval',        cls: 'text-yellow-600' },
  other:      { icon: Activity,      label: 'Other',           cls: 'text-muted-foreground' },
}

const EFFECT_CLS: Record<NonNullable<ActivityEvent['effect']>, string> = {
  allow:   'border-emerald-500/40 text-emerald-600',
  approve: 'border-amber-500/40 text-amber-600',
  deny:    'border-red-500/40 text-red-600',
  error:   'border-red-500/40 text-red-600',
}

/** A modal timeline of the agent-os primitives a session used: grouped counts + a chronological feed,
 *  read from the run's audit stream via /api/sessions/:id/activity. */
function SessionActivity({ session, onClose }: { session: Session; onClose: () => void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [summary, setSummary] = useState<ActivitySummaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true)
    api.sessionActivity(session.id)
      .then((r) => { if (!live) return; if (r.error) setError(r.error); else { setEvents(r.events ?? []); setSummary(r.summary ?? []) } })
      .catch(() => { if (live) setError('Could not load activity') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [session.id])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[85vh] w-full max-w-[calc(100%-2rem)] gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{session.title}</span>
          </DialogTitle>
          <div className="text-xs text-muted-foreground">
            {session.agent} · <span className="font-mono">{session.id}</span> · primitives this session used
          </div>
        </DialogHeader>

        {/* grouped counts — the "recall ×3 · ask ×1 · report ×1" glance */}
        {summary.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {summary.map((s) => {
              const st = ACTIVITY_STYLE[s.category] ?? ACTIVITY_STYLE.other
              const Icon = st.icon
              return (
                <span key={s.primitive} title={st.label} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                  <Icon className={`h-3 w-3 ${st.cls}`} />
                  <span className="font-mono">{s.primitive}</span>
                  <span className="text-muted-foreground">×{s.count}</span>
                </span>
              )
            })}
          </div>
        )}

        {/* chronological timeline */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading activity…</div>
          ) : error ? (
            <div className="p-6 text-sm text-destructive">{error}</div>
          ) : events.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No governed primitives recorded for this session yet. Read-only tools (recall, searches, inbox
              checks) don't leave an audit trace.
            </div>
          ) : (
            <div className="divide-y">
              {events.map((e, i) => {
                const st = ACTIVITY_STYLE[e.category] ?? ACTIVITY_STYLE.other
                const Icon = st.icon
                return (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2 text-xs">
                    <span className="w-16 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground" title={new Date(e.ts).toLocaleString()}>
                      {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${st.cls}`} />
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 font-mono text-[10px]">{e.primitive}</Badge>
                    {e.effect && (
                      <Badge variant="outline" className={`shrink-0 px-1.5 py-0 text-[10px] ${EFFECT_CLS[e.effect]}`}>{e.effect}</Badge>
                    )}
                    <span className="min-w-0 flex-1 break-words text-muted-foreground" title={e.summary}>{e.summary}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {loading ? '' : `${events.length} primitive${events.length === 1 ? '' : 's'} · from the session's audit trail`}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [type, setType] = useState('')
  const [session, setSession] = useState('')
  const [principal, setPrincipal] = useState('')
  const [loading, setLoading] = useState(false)
  const load = (over: { type?: string } = {}) => {
    setLoading(true)
    api.audit({ type: over.type ?? type, session: session.trim(), principal: principal.trim(), limit: 300 })
      .then((r) => { if (!r.error) { setEvents(r.events ?? []); if (r.types?.length) setTypes(r.types) } })
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="max-w-5xl space-y-4">
      <p className="text-sm text-muted-foreground">
        The append-only <strong>audit trail</strong> — every gateway/gate decision, approval, and console mutation.
        The per-run JSONL is the durable system of record; this is its queryable mirror (owner/admin only).
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Type">
          <Select items={[{ value: '__all', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))]} value={type || '__all'} onValueChange={(v) => { const t = !v || v === '__all' ? '' : v; setType(t); load({ type: t }) }}>
            <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All types</SelectItem>
              {types.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Session"><Input value={session} onChange={(e) => setSession(e.target.value)} placeholder="session id" className="h-8 w-36 font-mono text-xs" /></Field>
        <Field label="Principal"><Input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="email / agent / system" className="h-8 w-48 font-mono text-xs" /></Field>
        <Button size="sm" variant="outline" onClick={() => load()} disabled={loading}>{loading ? 'Loading…' : 'Apply'}</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">{loading ? 'Loading…' : 'No matching audit events.'}</div>
          ) : (
            <div className="divide-y">
              {events.map((e) => (
                <div key={e.id} className="flex items-start gap-3 px-3 py-2 text-xs">
                  <span className="w-36 shrink-0 text-muted-foreground">{new Date(e.ts).toLocaleString()}</span>
                  <Badge variant="outline" className="shrink-0 px-1.5 py-0 font-mono text-[10px]">{e.type}</Badge>
                  <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={e.principal}>{e.principal || '—'}</span>
                  <span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={e.runId}>{e.runId === '-' ? '' : e.runId}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(e.data)}>{JSON.stringify(e.data)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">Showing up to 300 most-recent events{events.length ? ` · ${events.length} shown` : ''}.</p>
    </div>
  )
}

type SettingsTab = 'company' | 'runtime' | 'theme' | 'secrets' | 'memory' | 'policy' | 'governance' | 'system'
const SETTINGS_TABS: SettingsTab[] = ['company', 'runtime', 'theme', 'secrets', 'memory', 'policy', 'governance', 'system']

// The active sub-tab is a URL detail (`#/settings/<tab>`) so a refresh / shared link lands on the same
// tab. `tab` is the raw detail from the router; `onTab` writes it back into the hash.
function SettingsPage({ me, state, tab: tabParam, onTab }: { me: Member; state: StateResp | null; tab: string; onTab: (t: SettingsTab) => void }) {
  const tab: SettingsTab = (SETTINGS_TABS as string[]).includes(tabParam) ? (tabParam as SettingsTab) : 'company'
  const setTab = onTab
  if (me.role !== 'owner' && me.role !== 'admin') return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>
  return (
    <div className="flex gap-6">
      <div className="flex w-48 shrink-0 flex-col gap-1 rounded-lg border bg-background p-1 self-start [&_a]:text-left [&_button]:text-left">
        <TabButton on={tab === 'company'} href={navHref('settings', 'company')} onClick={() => setTab('company')}>Company context</TabButton>
        <TabButton on={tab === 'runtime'} href={navHref('settings', 'runtime')} onClick={() => setTab('runtime')}>Runtime defaults</TabButton>
        <TabButton on={tab === 'theme'} href={navHref('settings', 'theme')} onClick={() => setTab('theme')}>Theme</TabButton>
        <TabButton on={tab === 'secrets'} href={navHref('settings', 'secrets')} onClick={() => setTab('secrets')}>Secrets</TabButton>
        <TabButton on={tab === 'memory'} href={navHref('settings', 'memory')} onClick={() => setTab('memory')}>Memory backend</TabButton>
        <TabButton on={tab === 'governance'} href={navHref('settings', 'governance')} onClick={() => setTab('governance')}>Governance</TabButton>
        <TabButton on={tab === 'policy'} href={navHref('settings', 'policy')} onClick={() => setTab('policy')}>Policy</TabButton>
        <TabButton on={tab === 'system'} href={navHref('settings', 'system')} onClick={() => setTab('system')}>System</TabButton>
      </div>
      <div className="min-w-0 flex-1">
        {tab === 'company' ? <CompanySettings me={me} />
          : tab === 'runtime' ? <RuntimeDefaultsSettings me={me} />
          : tab === 'theme' ? <ThemeSettings me={me} state={state} />
          : tab === 'secrets' ? <SecretsSettings me={me} />
          : tab === 'memory' ? <MemorySettings me={me} />
          : tab === 'governance' ? <GovernanceSettings me={me} />
          : tab === 'system' ? <SystemSettings state={state} me={me} />
          : <PolicyEditor me={me} />}
      </div>
    </div>
  )
}

/** Settings → System — workspace runtime facts + the Software panel (version, self-update, restart). */
function SystemSettings({ state, me }: { state: StateResp | null; me: Member }) {
  if (!state) return <div className="text-sm text-muted-foreground">Loading…</div>
  const rows: [string, ReactNode][] = [
    ['Version', state.version ? <>v{state.version}</> : '—'],
    ['Tenant', <>{state.tenantName || state.tenant}{state.tenantName ? <span className="text-muted-foreground"> ({state.tenant})</span> : null}</>],
    ['Policy', state.policy],
    ['Data home', state.home || '—'],
  ]
  return (
    <div className="space-y-4">
      <SoftwarePanel me={me} />
      <Card>
        <CardContent className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            Workspace runtime facts for this instance. One data home + one port = one isolated tenant.
          </p>
          <dl className="divide-y rounded-md border">
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-4 px-3 py-2">
                <dt className="w-28 shrink-0 text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="min-w-0 break-all font-mono text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <p className="text-sm font-medium">Agent operating notes</p>
            <p className="text-sm text-muted-foreground">
              OS-owned orientation appended to <strong>every claude-code agent's</strong> system prompt,
              after your Company context. This is what the fleet is told about running inside Agent OS —
              it's built into the platform and read-only here.
            </p>
          </div>
          <Textarea
            value={state.operatingNotes ?? ''}
            readOnly
            className="min-h-[320px] font-mono text-xs leading-relaxed"
          />
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * Settings → System → Software — version + self-update + restart. Polls `/api/update` (a cached
 * `git fetch`): shows the running build, whether the checkout is behind origin, and — for the owner —
 * an "Update & restart" (pull + rebuild + bounce) or a plain "Restart" button. After either bounce it
 * waits for `/health` to come back (on the new version, for an update) then reloads the console.
 */
function SoftwarePanel({ me }: { me: Member }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<UpdateApplyResult | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [err, setErr] = useState('')

  const check = (force = false) => {
    setChecking(true); setErr('')
    return api.checkUpdate(force).then(setStatus).catch(() => setErr('Could not check for updates.')).finally(() => setChecking(false))
  }
  useEffect(() => { check() }, [])

  // Wait for the process to respawn, then reload. For an update, hold until the version actually changes.
  const waitForBounce = (fromVersion?: string) => {
    setRestarting(true)
    const started = Date.now()
    const tick = async () => {
      try {
        const h = await fetch('/health').then((x) => x.json())
        if (h?.version && (!fromVersion || h.version !== fromVersion)) { window.location.reload(); return }
      } catch { /* server bouncing — keep waiting */ }
      if (Date.now() - started > 120_000) { window.location.reload(); return }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 5000)
  }

  const apply = async () => {
    setApplying(true); setResult(null); setErr('')
    const r = await api.applyUpdate()
    setResult(r); setApplying(false)
    if (r.ok && r.restarting) waitForBounce(status?.current)
  }

  const restart = async () => {
    if (!confirm('Restart the server now? Running agent sessions keep going (tmux), but the console will briefly disconnect while the process respawns.')) return
    setErr('')
    const r = await api.restart()
    if (!r.ok) return setErr(r.error || 'Restart failed.')
    if (r.restarting) waitForBounce()
    else setErr('No restart command resolved on this box — restart the service by hand.')
  }

  const isOwner = me.role === 'owner'
  const upToDate = status && !status.updateAvailable && !status.error

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Package className="h-4 w-4" /> Software</div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={checking || applying || restarting} onClick={() => check(true)}>
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} /> Check
            </Button>
            {isOwner && (
              <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-xs" disabled={applying || restarting} onClick={restart}>
                <RefreshCw className="h-3.5 w-3.5" /> Restart
              </Button>
            )}
          </div>
        </div>

        {!status ? (
          <p className="text-sm text-muted-foreground">Checking for updates…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>Running <span className="font-mono font-semibold text-foreground">v{status.current}</span></span>
              <span className="text-muted-foreground/60">·</span>
              <span className="inline-flex items-center gap-1"><GitBranch className="h-3 w-3" /><span className="font-mono">{status.branch}</span> → <span className="font-mono">{status.upstream}</span></span>
              <span className="text-muted-foreground/60">·</span>
              <span>checked {timeAgo(status.checkedAt)}</span>
            </div>

            {status.error ? (
              <div className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-[11px] text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /><span>{status.error}</span>
              </div>
            ) : upToDate ? (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> Up to date.</div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">
                  <Download className="h-3.5 w-3.5 shrink-0" />
                  Update available · <span className="font-mono">v{status.latest}</span> ({status.behind} commit{status.behind === 1 ? '' : 's'} behind)
                </div>

                {status.log.length > 0 && !result && (
                  <div className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2">
                    <ul className="space-y-0.5 text-[11px] leading-snug text-muted-foreground">
                      {status.log.map((s, i) => <li key={i} className="truncate" title={s}>· {s}</li>)}
                    </ul>
                  </div>
                )}

                {status.dirty && !result && (
                  <div className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-[11px] text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/20">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                    <span>The box has uncommitted changes — commit or stash them before updating (a fast-forward pull can't run otherwise).</span>
                  </div>
                )}

                {result && (
                  <div className="max-h-64 space-y-1.5 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
                    {result.steps.map((s, i) => (
                      <div key={i}>
                        <div className={s.ok ? 'text-emerald-600' : 'text-red-600'}>{s.ok ? '✓' : '✗'} {s.cmd}</div>
                        {!s.ok && s.out && <pre className="mt-0.5 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">{s.out}</pre>}
                      </div>
                    ))}
                    {result.error && <div className="text-red-600">✗ {result.error}</div>}
                  </div>
                )}

                {!restarting && (
                  <div className="flex items-center gap-2">
                    {isOwner ? (
                      <Button size="sm" disabled={applying || status.dirty} onClick={apply}>
                        {applying ? <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Updating…</> : <><Download className="mr-1.5 h-3.5 w-3.5" /> Update & restart</>}
                      </Button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Ask an owner to apply this update.</span>
                    )}
                  </div>
                )}
                {applying && !result && (
                  <div className="text-[11px] text-muted-foreground">Running <span className="font-mono">git pull</span> + rebuild + restart — this takes 1–3 minutes. Keep this tab open.</div>
                )}
              </>
            )}

            {restarting && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Restarting the server… the console will reconnect automatically.</div>
            )}
            {err && <div className="text-[11px] text-red-600">{err}</div>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Settings → Secrets — the encrypted-at-rest vault. Credentials are sealed (AES-256-GCM) under the
 *  workspace master key and read only INSIDE the gateway by capabilities; agents never see raw values.
 *  The console can set/replace/delete a secret but can never read one back — only its key + provenance. */
function SecretsSettings({ me }: { me: Member }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [key, setKey] = useState('')
  const [principal, setPrincipal] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const canEdit = me.role === 'owner' || me.role === 'admin'

  const refresh = () => api.secrets().then((r) => { if (!r.error) setSecrets(r.secrets); setLoading(false) }).catch(() => setLoading(false))
  useEffect(() => { refresh() }, [])

  const save = async () => {
    const k = key.trim()
    if (!k || !value) return
    setBusy(true); setHint('')
    const r = await api.setSecret(k, value, principal.trim() || undefined)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setKey(''); setPrincipal(''); setValue(''); setHint('saved'); setTimeout(() => setHint(''), 2500)
    refresh()
  }
  const del = async (s: SecretMeta) => {
    if (!confirm(`Delete secret "${s.key}"${s.principal !== '*' ? ` (${s.principal})` : ''}? This can't be undone.`)) return
    const r = await api.deleteSecret(s.key, s.principal === '*' ? undefined : s.principal)
    if (!r.error) refresh()
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            Credentials are <strong>encrypted at rest</strong> (AES-256-GCM) in the workspace database and read only{' '}
            <em>inside the gateway</em> by governed capabilities — <strong>agents never see raw values</strong>. The console
            can set, replace, or delete a secret, but can <strong>never read one back</strong>. Leave{' '}
            <span className="font-mono text-xs">principal</span> blank for a tenant-wide secret, or scope it to one agent/member.
          </p>
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label="Key" help="e.g. STRIPE_API_KEY — how a capability looks it up.">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="STRIPE_API_KEY" disabled={!canEdit} />
            </Field>
            <Field label="Principal (optional)" help="Blank = tenant-wide. Else an agent/member id to scope it to.">
              <Input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="* (tenant-wide)" disabled={!canEdit} />
            </Field>
          </div>
          <Field label="Value" help="Write-only — stored sealed, never shown again.">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="paste the secret value" disabled={!canEdit}
              onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={!canEdit || busy || !key.trim() || !value}>Save secret</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            : secrets.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No secrets stored yet.</p>
            : <div className="divide-y">
                {secrets.map((s) => (
                  <div key={`${s.principal}:${s.key}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{s.key}</span>
                        {s.principal !== '*' && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.principal}</span>}
                      </div>
                      <span className="text-[11px] text-muted-foreground">
                        updated {timeAgo(s.updatedAt)}{s.updatedBy ? ` by ${s.updatedBy}` : ''}
                      </span>
                    </div>
                    {canEdit && (
                      <button onClick={() => del(s)} className="shrink-0 text-muted-foreground hover:text-destructive" title="Delete secret">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>}
        </CardContent>
      </Card>
    </div>
  )
}

/** Settings → Governance — the numeric caps the policy's "never" tier enforces. A single payment at or
 *  below the money cap, or a delete of at most the bulk count, can still be approved; anything above is
 *  refused outright (no approver can override). Editing these retunes the deny rules live — no restart. */
function GovernanceSettings({ me }: { me: Member }) {
  const [t, setT] = useState<{ moneyCapUsd: number; bulkDeleteCount: number }>({ moneyCapUsd: 500, bulkDeleteCount: 25 })
  const [saved, setSaved] = useState(t)
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [hostGov, setHostGov] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const canEdit = me.role === 'owner' || me.role === 'admin'
  const isOwner = me.role === 'owner'

  useEffect(() => {
    api.governance().then((r) => {
      if (r.error) return
      const v = { moneyCapUsd: r.moneyCapUsd, bulkDeleteCount: r.bulkDeleteCount }
      setT(v); setSaved(v); setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy }); setHostGov(!!r.hostGovernanceEnabled)
    }).catch(() => {})
  }, [])

  const toggleHostGov = async () => {
    setHostBusy(true)
    const next = !hostGov
    const r = await api.saveGovernance({ ...saved, hostGovernanceEnabled: next })
    setHostBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setHostGov(!!r.hostGovernanceEnabled)
  }

  const dirty = JSON.stringify(t) !== JSON.stringify(saved)
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveGovernance(t)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    const v = { moneyCapUsd: r.moneyCapUsd, bulkDeleteCount: r.bulkDeleteCount }
    setT(v); setSaved(v); setHint('saved — applies to the policy immediately'); setTimeout(() => setHint(''), 3000)
  }

  return (
    <div className="space-y-4">
      <KillSwitchCard me={me} />
      <Card>
        <CardContent className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            The caps the policy's <strong>never</strong> tier enforces. At or below the limit an action can still be{' '}
            <em>approved</em> by a human; <strong>above</strong> it the action is <strong>refused outright</strong> — no approver,
            attended or not, can override. These feed the deny rules as <span className="font-mono text-xs">$moneyCapUsd</span> /{' '}
            <span className="font-mono text-xs">$bulkDeleteCount</span> and apply live.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Money cap (USD)" help="A single payment/refund above this is never allowed.">
              <Input type="number" min={0} value={t.moneyCapUsd}
                onChange={(e) => setT({ ...t, moneyCapUsd: Number(e.target.value) })} disabled={!canEdit} />
            </Field>
            <Field label="Bulk-delete cap (items)" help="A delete of more than this many items is never allowed.">
              <Input type="number" min={0} value={t.bulkDeleteCount}
                onChange={(e) => setT({ ...t, bulkDeleteCount: Number(e.target.value) })} disabled={!canEdit} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={!canEdit || busy || !dirty}>{dirty ? 'Save caps' : 'Saved'}</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            {!hint && meta.updatedBy && <span className="text-[11px] text-muted-foreground">last set by {meta.updatedBy}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={hostGov} disabled={!isOwner || hostBusy} onChange={toggleHostGov} />
            <span className="text-sm">
              <span className="font-medium">Govern host access (SSH / internal network / databases)</span>
              <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">beta</span>
              <p className="mt-1 text-xs text-muted-foreground">
                When on, an agent's shell reaches to a <a href="#/connectors" className="underline hover:text-foreground">Host connection</a> —
                or to any internal-looking host (private IPs, <span className="font-mono">.internal</span>) — are classified as
                <span className="font-mono"> net.connect</span>/<span className="font-mono">ssh.exec</span> and gated by policy (unlisted or
                unrecognised hosts pause for approval; a host set to <em>never</em> is refused). Public-internet egress stays ungoverned unless an
                agent is set to <span className="font-mono">allowlist</span> mode. Best-effort command parsing — a governance + audit layer, not a
                firewall. Owner-only.
              </p>
            </span>
          </label>
        </CardContent>
      </Card>
    </div>
  )
}

/** The workspace emergency stop. Engaging it makes the gate deny EVERY agent action fleet-wide (and,
 *  by default, halts running sessions). Reversible — release it and agents can run again. */
function KillSwitchCard({ me }: { me: Member }) {
  const [engaged, setEngaged] = useState(false)
  const [reason, setReason] = useState('')
  const [halt, setHalt] = useState(true)
  const [by, setBy] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const canEdit = me.role === 'owner' || me.role === 'admin'

  const refresh = () => api.killSwitch().then((r) => { if (!r.error) { setEngaged(r.engaged); setReason(r.reason || ''); setBy(r.updatedBy) } }).catch(() => {})
  useEffect(() => { refresh() }, [])

  const toggle = async (next: boolean) => {
    setBusy(true); setHint('')
    const r = await api.setKillSwitch(next, reason, halt)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setEngaged(r.engaged); setBy(r.updatedBy)
    setHint(next ? `engaged${r.halted ? ` — halted ${r.halted} session(s)` : ''}` : 'released'); setTimeout(() => setHint(''), 4000)
  }

  return (
    <Card className={engaged ? 'border-red-500 bg-red-50' : 'border-red-200'}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={engaged ? 'text-red-700' : 'text-red-600'}>⛔ Emergency stop</span>
              {engaged && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">engaged</span>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              While engaged, the gate <strong>denies every agent action</strong> across the whole workspace — the hard stop above all policy.
            </p>
          </div>
          <Button variant={engaged ? 'outline' : 'destructive'} disabled={!canEdit || busy} onClick={() => toggle(!engaged)}>
            {engaged ? 'Release' : 'Engage'}
          </Button>
        </div>
        {!engaged && (
          <div className="space-y-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional — recorded in the audit log)" disabled={!canEdit} className="h-8 text-xs" />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={halt} onChange={(e) => setHalt(e.target.checked)} disabled={!canEdit} />
              Also halt running sessions immediately (otherwise they stop at their next gated action)
            </label>
          </div>
        )}
        {engaged && reason && <p className="text-xs text-red-700">Reason: {reason}</p>}
        <div className="flex items-center gap-3">
          {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          {!hint && by && <span className="text-[11px] text-muted-foreground">last changed by {by}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

/** Settings → Runtime defaults — the fleet-wide model / effort that every
 *  claude-code agent inherits unless its own manifest overrides the field. Retune the whole fleet
 *  from one place; per-agent overrides live on each agent's page. */
function RuntimeDefaultsSettings({ me }: { me: Member }) {
  const [tuning, setTuning] = useState<RuntimeTuning>({})
  const [saved, setSaved] = useState<RuntimeTuning>({})
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const canEdit = me.role === 'owner' || me.role === 'admin'

  useEffect(() => {
    api.runtimeDefaults().then((r) => {
      if (r.error) return
      const t: RuntimeTuning = { model: r.model, effort: r.effort, permissionMode: r.permissionMode }
      setTuning(t); setSaved(t); setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy })
    }).catch(() => {})
  }, [])

  const dirty = JSON.stringify(tuning) !== JSON.stringify(saved)
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveRuntimeDefaults(tuning)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    const t: RuntimeTuning = { model: r.model, effort: r.effort }
    setTuning(t); setSaved(t); setHint('saved — applies to every agent that doesn\'t override the field'); setTimeout(() => setHint(''), 3000)
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          The workspace-wide <strong>model</strong>, <strong>effort</strong>, and <strong>permission mode</strong> applied to every{' '}
          <span className="font-mono text-xs">claude-code</span> agent. An agent that sets the field in its own page overrides this;
          a blank field here means each unset agent falls through to the <span className="font-mono text-xs">claude</span> CLI's own default.
          Applies on each agent's next session.
        </p>
        <TuningFields tuning={tuning} onChange={setTuning} modelPlaceholder="CLI default" inheritLabel="CLI default" permInheritLabel="auto (default)" />
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={!canEdit || busy || !dirty}>{dirty ? 'Save defaults' : 'Saved'}</Button>
          {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          {!hint && meta.updatedBy && <span className="text-[11px] text-muted-foreground">last set by {meta.updatedBy}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Settings → Memory — pick the persistent-memory backend for every agent and apply it live.
 *   sqlite  — zero-infra default (FTS5 keyword recall), ships in the box.
 *   libsql  — local file with native vector search; hybrid keyword + semantic recall. Embeddings
 *             via OpenAI-compatible API or a local Ollama (free, on-box). Omit embeddings → keyword-only.
 *   automem — external REST service (graph + vectors).
 * Secrets are write-only (shown as "saved"; blank = keep). Test runs a health check before you save;
 * Save hot-swaps the live backend — no restart.
 */
function MemorySettings({ me }: { me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [backend, setBackend] = useState<MemoryBackend>('sqlite')
  const [view, setView] = useState<MemorySettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [testResult, setTestResult] = useState<MemoryHealth | null>(null)
  // libsql fields
  const [url, setUrl] = useState('file:./data/memory.libsql.db')
  const [embedOn, setEmbedOn] = useState(false)
  const [provider, setProvider] = useState<'openai' | 'ollama'>('ollama')
  const [embUrl, setEmbUrl] = useState('http://localhost:11434')
  const [model, setModel] = useState('nomic-embed-text')
  const [dims, setDims] = useState('768')
  const [apiKey, setApiKey] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [ollama, setOllama] = useState<OllamaStatus | null>(null)
  // automem fields
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')

  // Probe the local Ollama whenever it's the chosen embedder (debounced — the URL changes per keystroke).
  useEffect(() => {
    if (!embedOn || provider !== 'ollama') { setOllama(null); return }
    let live = true
    const t = setTimeout(() => { api.ollamaStatus(embUrl.trim()).then((s) => { if (live) setOllama(s) }).catch(() => {}) }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [embedOn, provider, embUrl])

  const [halfLife, setHalfLife] = useState('0') // recall recency half-life in days; 0 = off
  const [weightImp, setWeightImp] = useState(false)
  const [weightUse, setWeightUse] = useState(false)
  // maintenance
  const [pruneDays, setPruneDays] = useState('0') // 0 = never prune
  const [keepImp, setKeepImp] = useState('0.5')
  const [dedupeOn, setDedupeOn] = useState(false)
  const [dedupeThresh, setDedupeThresh] = useState('0.95')
  const [everyHours, setEveryHours] = useState('24')
  const [maintBusy, setMaintBusy] = useState(false)
  const [maintMsg, setMaintMsg] = useState('')
  const [curated, setCurated] = useState(false) // shared-write policy: only humans publish shared
  const [preloadOn, setPreloadOn] = useState(false) // launch-time recall preamble
  const [preloadCount, setPreloadCount] = useState('8')
  const apply = (v: MemorySettings) => {
    setView(v)
    setBackend(v.backend)
    if (v.libsql) setUrl(v.libsql.url || 'file:./data/memory.libsql.db')
    if (v.automem) setEndpoint(v.automem.endpoint)
    const e = v.libsql?.embeddings ?? v.sqlite?.embeddings // embeddings live under whichever backend is active
    setEmbedOn(!!e)
    if (e) { setProvider(e.provider); setEmbUrl(e.url); setModel(e.model); if (e.dimensions != null) setDims(String(e.dimensions)) }
    setHalfLife(String(v.ranking?.halfLifeDays ?? 0))
    setWeightImp(!!v.ranking?.weightByImportance)
    setWeightUse(!!v.ranking?.weightByUsage)
    const m = v.maintenance
    setPruneDays(String(m?.pruneAfterDays ?? 0))
    setKeepImp(String(m?.keepImportance ?? 0.5))
    setDedupeOn(m?.dedupeThreshold != null)
    if (m?.dedupeThreshold != null) setDedupeThresh(String(m.dedupeThreshold))
    setEveryHours(String(m?.everyHours ?? 24))
    setCurated(v.sharedWrites === 'curated')
    setPreloadOn(!!v.preload?.enabled)
    if (v.preload?.count != null) setPreloadCount(String(v.preload.count))
  }
  useEffect(() => { api.memorySettings().then((v) => { if (v.error) return setHint('⚠ ' + v.error); apply(v) }).catch(() => {}) }, [])

  // Backend-switch reconcile: the local ledger has rows the active external store doesn't (see the drift banner).
  const [reconBusy, setReconBusy] = useState(false)
  const [reconSkipEp, setReconSkipEp] = useState(false) // migrate all by default; opt in to skipping raw episodes
  const [reconMsg, setReconMsg] = useState('')
  const [reconcileOpen, setReconcileOpen] = useState(false) // the at-switch interstitial
  const refreshView = () => api.memorySettings().then((v) => { if (!v.error) apply(v) }).catch(() => {})
  // Batched migrate: loop the endpoint (each call moves ≤ a batch) passing back the server's `before`
  // horizon until it reports `done`, showing progress. Safe to resume — a failed batch leaves rows put.
  // Batched migrate. Each call moves one batch of orphans (rows written before the backend switch) and
  // reports how many are left; the server anchors the orphan set to the switch time, so this loop is
  // resume-safe — if you leave the tab mid-migration, just re-open and click again and it picks up exactly
  // where it stopped (no duplicates, no false "done"). No client-side horizon to thread anymore.
  const doMigrate = async () => {
    setReconBusy(true); setReconMsg('Migrating…')
    let migrated = 0, skipped = 0
    for (let guard = 0; guard < 10000; guard++) {
      const r = await api.migrateMemory({ skipEpisodes: reconSkipEp })
      if (r.error) { setReconBusy(false); return setReconMsg('⚠ ' + r.error) }
      migrated += r.migrated ?? 0; skipped += r.skipped ?? 0
      if (r.done) break
      setReconMsg(`Migrating… ${migrated} moved${skipped ? ` / ${skipped} skipped` : ''}, ${r.remaining ?? 0} left`)
    }
    setReconBusy(false)
    setReconMsg(`Migrated ${migrated}${skipped ? `, skipped ${skipped} episode(s)` : ''}; local ledger reconciled.`)
    setReconcileOpen(false)
    refreshView()
  }
  const doClear = async () => {
    if (!confirm('Delete ALL local memory rows for this workspace? This resets the local ledger (and what the reflection loop can look back on). Cannot be undone.')) return
    setReconBusy(true); setReconMsg('')
    const r = await api.clearMemoryLedger()
    setReconBusy(false)
    if (r.error) return setReconMsg('⚠ ' + r.error)
    setReconMsg(`Cleared ${r.cleared ?? 0} local rows.`)
    setReconcileOpen(false)
    refreshView()
  }

  // Preset the embedding defaults when toggling provider (the two stacks use different models/dims/ports).
  const pickProvider = (pv: 'openai' | 'ollama') => {
    setProvider(pv)
    if (pv === 'ollama') { setEmbUrl('http://localhost:11434'); setModel('nomic-embed-text'); setDims('768') }
    else { setEmbUrl('https://api.openai.com/v1'); setModel('text-embedding-3-small'); setDims('1536') }
  }

  const emb = () => ({ enabled: embedOn, provider, url: embUrl.trim(), model: model.trim(), dimensions: Number(dims) || undefined, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
  const ranking = () => ({ halfLifeDays: Number(halfLife) || 0, weightByImportance: weightImp, weightByUsage: weightUse })
  const maintenance = () => ({ pruneAfterDays: Number(pruneDays) || 0, keepImportance: Number(keepImp), everyHours: Number(everyHours) || 24, ...(dedupeOn ? { dedupeThreshold: Number(dedupeThresh) } : {}) })
  const sharedWrites = (): 'open' | 'curated' => (curated ? 'curated' : 'open')
  const preload = () => ({ enabled: preloadOn, count: Math.max(1, Math.min(Number(preloadCount) || 8, 25)) })
  const body = (): MemorySettingsReq => {
    if (backend === 'libsql') {
      return { backend, libsql: { url: url.trim(), ...(authToken.trim() ? { authToken: authToken.trim() } : {}), embeddings: emb() }, ranking: ranking(), maintenance: maintenance(), sharedWrites: sharedWrites(), preload: preload() }
    }
    if (backend === 'automem') return { backend, automem: { endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) }, sharedWrites: sharedWrites(), preload: preload() }
    return { ...(embedOn ? { backend: 'sqlite', sqlite: { embeddings: emb() } } : { backend: 'sqlite' }), ranking: ranking(), maintenance: maintenance(), sharedWrites: sharedWrites(), preload: preload() }
  }

  // Run a maintenance pass now (uses the SAVED policy — save first if you just changed the knobs).
  const runMaintenance = async () => {
    setMaintBusy(true); setMaintMsg('')
    const r = await api.maintainMemory()
    setMaintBusy(false)
    setMaintMsg(r.error ? '⚠ ' + r.error : `pruned ${r.pruned ?? 0}, merged ${r.merged ?? 0}`)
    setTimeout(() => setMaintMsg(''), 4000)
  }

  const test = async () => {
    setBusy(true); setHint(''); setTestResult(null)
    const r = await api.testMemorySettings(body())
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setTestResult(r.health ?? null)
  }
  const save = async () => {
    const prevBackend = view?.backend
    setBusy(true); setHint(''); setTestResult(null)
    const r = await api.saveMemorySettings(body())
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setApiKey(''); setToken(''); setAuthToken('')
    apply(r)
    setHint('saved — applied live'); setTimeout(() => setHint(''), 1800)
    // At-switch interstitial: a backend CHANGE that left local rows the new store lacks → prompt to reconcile.
    if (r.backend !== prevBackend && (r.drift ?? 0) > 0) { setReconSkipEp(false); setReconMsg(''); setReconcileOpen(true) }
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>

  const BACKENDS: { id: MemoryBackend; title: string; blurb: string }[] = [
    { id: 'sqlite', title: 'SQLite', blurb: 'Zero-infra default. Keyword recall — add embeddings for semantic too.' },
    { id: 'libsql', title: 'libSQL + vectors', blurb: 'Local file, native vector search. Hybrid keyword + semantic recall.' },
    { id: 'automem', title: 'Automem', blurb: 'External REST service (graph + vectors).' },
  ]

  // The embeddings sub-form, shared by the sqlite (in-JS cosine) and libsql (native) backends — both
  // turn text into vectors the same way. Off → keyword-only (bm25).
  const savedApiKeySet = backend === 'libsql' ? !!view?.libsql?.embeddings?.apiKeySet : !!view?.sqlite?.embeddings?.apiKeySet
  // Is the chosen model among those Ollama has pulled? (tags carry a ":latest" tag we ignore.)
  const modelReady = (s: OllamaStatus, m: string) => (s.models ?? []).some((x) => x === m || x.split(':')[0] === m.split(':')[0])
  const embeddingsBlock = (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={embedOn} onChange={(e) => setEmbedOn(e.target.checked)} />
        Enable semantic search (embeddings) <span className="text-[11px] text-muted-foreground">— off = keyword-only (bm25)</span>
      </label>
      {embedOn && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="flex gap-1 rounded-lg border bg-background p-1 w-fit">
            <TabButton on={provider === 'ollama'} onClick={() => pickProvider('ollama')}>Ollama (local, free)</TabButton>
            <TabButton on={provider === 'openai'} onClick={() => pickProvider('openai')}>OpenAI-compatible</TabButton>
          </div>
          {provider === 'ollama' && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-muted-foreground">Ollama:</span>
              {!ollama ? <span className="text-muted-foreground">checking…</span>
                : ollama.reachable ? <>
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600">running{ollama.version ? ` · v${ollama.version}` : ''}</Badge>
                    {modelReady(ollama, model)
                      ? <span className="text-emerald-600">{model} ✓</span>
                      : <span className="text-amber-600">model “{model}” not pulled — <code className="text-[10px]">ollama pull {model}</code></span>}
                  </>
                : ollama.installed
                  ? <span className="text-amber-600">installed but not running — <code className="text-[10px]">brew services start ollama</code></span>
                  : <span className="text-muted-foreground">not installed — <code className="text-[10px]">brew install ollama</code></span>}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Endpoint"><Input value={embUrl} onChange={(e) => setEmbUrl(e.target.value)} className="font-mono text-xs" /></Field>
            <Field label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" /></Field>
            <Field label="Dimensions" help="Fixes the vector width — keep stable. nomic-embed-text=768, text-embedding-3-small=1536.">
              <Input value={dims} onChange={(e) => setDims(e.target.value)} className="font-mono text-xs" />
            </Field>
            {provider === 'openai' && (
              <Field label="API key"><Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={savedApiKeySet ? '•••• (saved) — type to replace' : 'sk-…'} className="font-mono text-xs" /></Field>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">Each remember/recall calls the embedding endpoint (a few ms, fractions of a cent). Ollama keeps it local and free.</p>
        </div>
      )}
    </>
  )

  return (
    <div className="max-w-3xl space-y-4">
      {/* At-switch interstitial: pops right after a backend change that left local rows behind. */}
      {reconcileOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !reconBusy && setReconcileOpen(false)}>
          <div className="w-full max-w-lg space-y-3 rounded-lg border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium">Switched to {view?.backend} — reconcile the {view?.localCount ?? 0} existing {(view?.localCount ?? 0) === 1 ? 'memory' : 'memories'}?</div>
            <p className="text-xs text-muted-foreground">Agents now recall from {view?.backend}, which has {view?.backendCount ?? 0}. Your {view?.drift ?? 0} pre-switch {(view?.drift ?? 0) === 1 ? 'memory' : 'memories'} aren't in it yet. <strong>Migrate</strong> copies them into {view?.backend} (resume-safe — you can leave and continue later); <strong>Start fresh</strong> clears the local ledger; <strong>Later</strong> leaves them (the drift banner stays until you reconcile).</p>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><input type="checkbox" checked={reconSkipEp} onChange={(e) => setReconSkipEp(e.target.checked)} />durable only — skip raw session episodes</label>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={doMigrate} disabled={reconBusy}><Upload className="mr-1 h-3.5 w-3.5" />Migrate to {view?.backend}</Button>
              <Button size="sm" variant="outline" onClick={doClear} disabled={reconBusy}><Trash2 className="mr-1 h-3.5 w-3.5" />Start fresh</Button>
              <Button size="sm" variant="ghost" onClick={() => setReconcileOpen(false)} disabled={reconBusy}>Later</Button>
              {reconMsg && <span className="font-mono text-[11px] text-muted-foreground">{reconMsg}</span>}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          The <strong>persistent memory</strong> every agent recalls across sessions. Changing the backend applies
          <strong> live</strong> — running agents pick it up on their next recall. Secrets are write-only.
        </p>
        {view?.health && (
          <Badge variant={view.health.ok ? 'default' : 'destructive'} className="shrink-0 px-1.5 py-0 text-[10px] font-normal" title={view.health.detail}>
            live: {view.health.backend}
          </Badge>
        )}
      </div>

      {/* drift banner — local ledger has rows the active external store doesn't (migrate or clear) */}
      {(view?.drift ?? 0) > 0 && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <div className="font-medium text-amber-700">{view!.drift} {view!.drift === 1 ? 'memory was' : 'memories were'} written before you switched to {view?.backend} and {view!.drift === 1 ? 'isn\'t' : 'aren\'t'} in it yet.</div>
              <div className="mt-0.5 text-muted-foreground">Agents recall from {view?.backend} ({view?.backendCount ?? 0} there), so they can't see these {view?.drift ?? 0} older rows. Migrate copies them up, or clear the ledger to drop them. Migration is resume-safe — you can leave this tab and click Migrate again later to continue where it stopped.</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-6">
            <Button size="sm" onClick={doMigrate} disabled={reconBusy}><Upload className="mr-1 h-3.5 w-3.5" />Migrate to {view?.backend}</Button>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><input type="checkbox" checked={reconSkipEp} onChange={(e) => setReconSkipEp(e.target.checked)} />durable only (skip raw episodes)</label>
            <Button size="sm" variant="outline" onClick={doClear} disabled={reconBusy}><Trash2 className="mr-1 h-3.5 w-3.5" />Clear local ledger</Button>
            {reconBusy && <span className="text-[11px] text-muted-foreground">working…</span>}
            {reconMsg && <span className="font-mono text-[11px] text-muted-foreground">{reconMsg}</span>}
          </div>
        </div>
      )}

      {/* backend picker */}
      <div className="grid gap-2 sm:grid-cols-3">
        {BACKENDS.map((b) => (
          <button
            key={b.id}
            onClick={() => { setBackend(b.id); setTestResult(null) }}
            className={`rounded-lg border p-3 text-left transition-colors ${backend === b.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
          >
            <div className="text-sm font-medium">{b.title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{b.blurb}</div>
          </button>
        ))}
      </div>

      {backend === 'libsql' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Field label="Database URL" help="A local file (file:./data/memory.libsql.db) or a remote/Turso-Cloud URL (libsql://…).">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="file:./data/memory.libsql.db" className="font-mono text-xs" />
            </Field>
            {url.trim().startsWith('libsql://') && (
              <Field label="Auth token" help="For a remote/Turso-Cloud URL. Not needed for a local file.">
                <Input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={view?.libsql?.authTokenSet ? '•••• (saved) — type to replace' : 'eyJ…'} className="font-mono text-xs" />
              </Field>
            )}
            {embeddingsBlock}
            <p className="text-[11px] text-muted-foreground">Needs the optional <code className="text-xs">@libsql/client</code> package on the server (<code className="text-xs">npm i @libsql/client</code>).</p>
          </CardContent>
        </Card>
      )}

      {backend === 'automem' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <Field label="Endpoint" help="Base URL of the automem REST API (FalkorDB graph + Qdrant vectors).">
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://automem.internal:8001" className="font-mono text-xs" />
            </Field>
            <Field label="Bearer token">
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={view?.automem?.tokenSet ? '•••• (saved) — type to replace' : 'token'} className="font-mono text-xs" />
            </Field>
          </CardContent>
        </Card>
      )}

      {backend === 'sqlite' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">
              Keyword recall (FTS5) works out of the box with zero setup. Add embeddings for <strong>hybrid</strong> recall —
              keyword + semantic — computed in-process; vectors live in the workspace DB. Still zero extra dependencies.
            </p>
            {embeddingsBlock}
          </CardContent>
        </Card>
      )}

      {/* Recall ranking — backend-independent (sqlite/libsql); automem ranks server-side. */}
      {backend !== 'automem' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div>
              <div className="text-sm font-medium">Recall ranking</div>
              <p className="text-xs text-muted-foreground">A nudge on top of relevance — favour fresher and/or more important memories. Off by default; never drops results, just reorders.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Recency half-life (days)" help="A memory's weight halves every N days. 0 = no recency decay.">
                <Input value={halfLife} onChange={(e) => setHalfLife(e.target.value)} className="font-mono text-xs" placeholder="0" />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={weightImp} onChange={(e) => setWeightImp(e.target.checked)} />
                Weight by importance <span className="text-[11px] text-muted-foreground">— uses each memory's 0–1 score</span>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={weightUse} onChange={(e) => setWeightUse(e.target.checked)} />
                Reinforce by usage <span className="text-[11px] text-muted-foreground">— boost frequently-recalled memories; recency counts from last use</span>
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Maintenance — prune stale + consolidate duplicates (sqlite/libsql). */}
      {backend !== 'automem' && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Maintenance</div>
                <p className="text-xs text-muted-foreground">Periodically prune stale memories and merge duplicates. Conservative + opt-in. Saved policy runs on a schedule; run it now to preview.</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {maintMsg && <span className="font-mono text-[11px] text-muted-foreground">{maintMsg}</span>}
                <Button size="sm" variant="outline" onClick={runMaintenance} disabled={maintBusy}>Run now</Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Prune after (days)" help="Delete memories older than this that were never recalled and aren't important. 0 = never prune.">
                <Input value={pruneDays} onChange={(e) => setPruneDays(e.target.value)} className="font-mono text-xs" placeholder="0" />
              </Field>
              <Field label="Keep importance ≥" help="Memories at/above this importance are never pruned, regardless of age.">
                <Input value={keepImp} onChange={(e) => setKeepImp(e.target.value)} className="font-mono text-xs" placeholder="0.5" />
              </Field>
              <Field label="Run every (hours)" help="How often the scheduler runs a pass.">
                <Input value={everyHours} onChange={(e) => setEveryHours(e.target.value)} className="font-mono text-xs" placeholder="24" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={dedupeOn} onChange={(e) => setDedupeOn(e.target.checked)} />
              Merge duplicates
              {dedupeOn && (
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  — cosine ≥ <Input value={dedupeThresh} onChange={(e) => setDedupeThresh(e.target.value)} className="h-6 w-16 font-mono text-xs" />
                  {backend === 'libsql' ? '(libSQL: exact-text only for now)' : '(needs embeddings for near-duplicates)'}
                </span>
              )}
            </label>
          </CardContent>
        </Card>
      )}

      {/* Shared-memory governance — who may publish tenant-wide knowledge. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Shared memory</div>
            <p className="text-xs text-muted-foreground">Agents can publish facts every agent recalls (<code className="text-xs">remember(shared)</code>). Owners/admins can edit or remove any shared memory from the Memory page regardless of this setting.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={curated} onChange={(e) => setCurated(e.target.checked)} />
            Curated <span className="text-[11px] text-muted-foreground">— agents' shared writes are stored private; only humans publish shared. Off = any agent may publish (audited).</span>
          </label>
        </CardContent>
      </Card>

      {/* Launch-time recall preamble — seed each new session with the agent's most salient memories. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Session preload</div>
            <p className="text-xs text-muted-foreground">Inject each agent's most salient memories into its system prompt at launch, so a cold session doesn't start blind (instead of relying on it to call <code className="text-xs">recall</code>). Ranked by importance then recency-of-use; includes the agent's own memories and tenant-shared ones.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={preloadOn} onChange={(e) => setPreloadOn(e.target.checked)} />
            Preload memories on launch
            {preloadOn && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                — top <Input value={preloadCount} onChange={(e) => setPreloadCount(e.target.value)} className="h-6 w-16 font-mono text-xs" /> (1–25)
              </span>
            )}
          </label>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy}>Save &amp; apply</Button>
        {(backend !== 'sqlite' || embedOn) && <Button variant="outline" onClick={test} disabled={busy}>Test</Button>}
        {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
        {testResult && (
          <Badge variant={testResult.ok ? 'default' : 'destructive'} className="px-1.5 py-0 text-[10px] font-normal" title={testResult.detail}>
            test: {testResult.ok ? 'ok' : 'failed'}{testResult.detail ? ` · ${testResult.detail}` : ''}
          </Badge>
        )}
        {view?.updatedAt && (
          <span className="ml-auto text-[11px] text-muted-foreground">updated {new Date(view.updatedAt).toLocaleString()}{view.updatedBy ? ` by ${view.updatedBy}` : ''}</span>
        )}
      </div>
    </div>
  )
}

function IntegrationsSettings({ me }: { me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [composio, setComposio] = useState<IntegrationsResp['composio']>({ set: false, hint: '' })
  const [webhook, setWebhook] = useState<{ set: boolean }>({ set: false })
  const [slack, setSlack] = useState<IntegrationsResp['slack']>({ appToken: false, botToken: false, configured: false })
  const [slackState, setSlackState] = useState<SlackStatus | null>(null)
  const [discord, setDiscord] = useState<IntegrationsResp['discord']>({ botToken: false, configured: false })
  const [discordState, setDiscordState] = useState<DiscordStatus | null>(null)
  const [chatRouter, setChatRouter] = useState(true)
  const [chatIdle, setChatIdle] = useState(30)
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [key, setKey] = useState('')
  const [wh, setWh] = useState('')
  const [appTok, setAppTok] = useState('')
  const [botTok, setBotTok] = useState('')
  const [discordTok, setDiscordTok] = useState('')
  const [discordAppId, setDiscordAppId] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  // Defensive defaults so an older backend (one that predates a field) never white-screens the page.
  const SLACK_DEFAULT = { appToken: false, botToken: false, configured: false }
  const DISCORD_DEFAULT = { botToken: false, configured: false }
  const apply = (r: IntegrationsResp) => {
    if (r.composio) setComposio(r.composio)
    if (r.webhook) setWebhook(r.webhook)
    setSlack(r.slack ?? SLACK_DEFAULT)
    setDiscord(r.discord ?? DISCORD_DEFAULT)
    if (typeof r.chatRouter === 'boolean') setChatRouter(r.chatRouter)
    if (typeof r.chatIdleTimeoutMin === 'number') setChatIdle(r.chatIdleTimeoutMin)
    setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy })
  }
  const loadStatus = () => {
    api.slackStatus().then((s) => { if (s && !s.error) setSlackState(s) }).catch(() => {})
    api.discordStatus().then((s) => { if (s && !s.error) setDiscordState(s) }).catch(() => {})
  }
  // After a token change the server re-dials the Socket-Mode / Gateway connection live (no restart) —
  // but the handshake (auth check → WebSocket → READY) can take several seconds. A single poll would
  // catch a mid-handshake "Disconnected" and make the panel look broken (and tempt a needless server
  // restart). So poll with backoff until the touched platform(s) settle: connected, or intentionally
  // cleared (unconfigured stays down = terminal).
  const pollReconnect = (want: { slack: boolean; discord: boolean }) => {
    let tries = 0
    const settled = (s?: { configured: boolean; connected: boolean } | null) => !!s && (!s.configured || s.connected)
    const tick = async () => {
      tries++
      let slackDone = !want.slack, discordDone = !want.discord
      if (want.slack) {
        const s = await api.slackStatus().catch(() => null)
        if (s && !s.error) { setSlackState(s); slackDone = settled(s) }
      }
      if (want.discord) {
        const d = await api.discordStatus().catch(() => null)
        if (d && !d.error) { setDiscordState(d); discordDone = settled(d) }
      }
      if ((slackDone && discordDone) || tries >= 8) return
      setTimeout(tick, 1500)
    }
    setTimeout(tick, 800)
  }
  useEffect(() => {
    api.integrations().then((r) => {
      if (r.error) return setHint('⚠ ' + r.error)
      apply(r)
    }).catch(() => {})
    loadStatus()
  }, [])

  const save = async (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string; chatRouter?: boolean; chatIdleTimeoutMin?: number }, label: string) => {
    setBusy(true); setHint('')
    const r = await api.saveIntegrations(body)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setKey(''); setWh(''); setAppTok(''); setBotTok(''); setDiscordTok('')
    apply(r)
    setHint(label); setTimeout(() => setHint(''), 1500)
    // The Socket-Mode / Gateway connection re-dials on the server when tokens change — poll until the
    // reconnect settles so the panel reflects reality rather than a mid-handshake "Disconnected".
    const wantSlack = body.slackAppToken !== undefined || body.slackBotToken !== undefined
    const wantDiscord = body.discordBotToken !== undefined
    if (wantSlack || wantDiscord) pollReconnect({ slack: wantSlack, discord: wantDiscord })
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        <strong>Creds</strong> — the workspace platform credentials stored once and used by your connections. The
        <strong> Composio</strong> API key powers Composio-backed connections: one company key, with each member's
        apps scoped to their own account (their email is the Composio <code className="text-xs">user_id</code>). For
        arbitrary secrets an agent reads at runtime, use the <a href="#/settings/secrets" className="underline hover:text-foreground">Secrets vault</a>.
      </p>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="text-sm font-medium">Composio</div>
            <p className="text-xs text-muted-foreground">
              The <strong>API key</strong> powers Composio-backed connectors. The optional <strong>webhook secret</strong> lets
              app events <strong>trigger agents</strong> (Slack message/DM → run an agent): in Composio, create a webhook pointing
              at <code className="text-xs">{`<this-host>`}/triggers/composio</code>, paste its signing secret
              (<code className="text-xs">whsec_…</code>) here, then add a <strong>Composio</strong> trigger on the Automations page.
            </p>
          </div>

          <Field label="API key">
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={composio.set ? `${composio.hint} (saved) — type a new key to replace` : 'comp_…  (Composio dashboard → Settings → API Keys)'}
              className="font-mono text-xs"
            />
            {composio.set && (
              <button type="button" className="mt-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={() => save({ composioApiKey: '' }, 'removed')} disabled={busy}>Remove key</button>
            )}
          </Field>

          <Field label="Webhook secret" help="Optional — only needed for Composio triggers.">
            <Input
              type="password"
              value={wh}
              onChange={(e) => setWh(e.target.value)}
              placeholder={webhook.set ? '•••• (saved) — type a new secret to replace' : 'whsec_…'}
              className="font-mono text-xs"
            />
            {webhook.set && (
              <button type="button" className="mt-1 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50" onClick={() => save({ composioWebhookSecret: '' }, 'removed')} disabled={busy}>Remove secret</button>
            )}
          </Field>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => save({ ...(key.trim() ? { composioApiKey: key.trim() } : {}), ...(wh.trim() ? { composioWebhookSecret: wh.trim() } : {}) }, 'saved')}
              disabled={busy || (!key.trim() && !wh.trim())}
            >Save</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            {meta.updatedAt && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                updated {new Date(meta.updatedAt).toLocaleString()}{meta.updatedBy ? ` by ${meta.updatedBy}` : ''}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              Slack (native, Socket Mode)
              {slackState && (slackState.connected
                ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600">connected{slackState.botUserId ? ` · ${slackState.botUserId}` : ''}</Badge>
                : slack.configured
                  ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-amber-600">configured · not connected</Badge>
                  : <Badge variant="outline" className="px-1.5 py-0 text-[10px]">not configured</Badge>)}
            </div>
            <p className="text-xs text-muted-foreground">
              One company Slack app, configured once and shared across the workspace — no public URL needed (the server
              dials out to Slack). When the bot is @-mentioned or DMed, matching <strong>Slack</strong> automations run,
              <strong> as the member who sent the message</strong> (matched by their Slack email → their connectors).
            </p>
            {slackState?.lastError && <p className="mt-1 font-mono text-[11px] text-destructive">last error: {slackState.lastError}</p>}
          </div>
          <SlackSetupGuide />
          <Field label="App-level token" help="Basic Information → App-Level Tokens. Scope: connections:write.">
            <Input
              type="password"
              value={appTok}
              onChange={(e) => setAppTok(e.target.value)}
              placeholder={slack.appToken ? '•••• (saved) — type a new token to replace' : 'xapp-…'}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Bot token" help="OAuth & Permissions → Bot User OAuth Token. Scopes: app_mentions:read, chat:write, channels:read/join/history, groups:read/history, im:write/history, mpim:history, users:read, users:read.email.">
            <Input
              type="password"
              value={botTok}
              onChange={(e) => setBotTok(e.target.value)}
              placeholder={slack.botToken ? '•••• (saved) — type a new token to replace' : 'xoxb-…'}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => save({ ...(appTok.trim() ? { slackAppToken: appTok.trim() } : {}), ...(botTok.trim() ? { slackBotToken: botTok.trim() } : {}) }, 'saved')}
              disabled={busy || (!appTok.trim() && !botTok.trim())}
            >Save</Button>
            {(slack.appToken || slack.botToken) && (
              <Button variant="ghost" onClick={() => save({ slackAppToken: '', slackBotToken: '' }, 'removed')} disabled={busy}>Remove</Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              Discord (native, Gateway)
              {discordState && (discordState.connected
                ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600">connected{discordState.botUserId ? ` · ${discordState.botUserId}` : ''}</Badge>
                : discord.configured
                  ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-amber-600">configured · not connected</Badge>
                  : <Badge variant="outline" className="px-1.5 py-0 text-[10px]">not configured</Badge>)}
            </div>
            <p className="text-xs text-muted-foreground">
              One company Discord bot, configured once and shared across the workspace — no public URL needed (the server
              dials out to Discord over the Gateway). When the bot is @-mentioned or DMed, matching <strong>Discord</strong>
              automations run. <span className="text-foreground">Note:</span> Discord can't expose a user's email, so triggered
              runs currently act as the <strong>company identity</strong> (per-member run-as lands with the identity map).
            </p>
            {discordState?.lastError && <p className="mt-1 font-mono text-[11px] text-destructive">last error: {discordState.lastError}</p>}
          </div>

          {/* Generic /agent chat router — shared by Slack + Discord. When on, a message that matches no
              automation reaches ANY agent by name (/pod-troubleshooter …); unknown/unaddressed gets a help list. */}
          <label className="flex items-start gap-2 rounded-md border bg-muted/20 p-3 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={chatRouter}
              disabled={busy}
              onChange={(e) => { setChatRouter(e.target.checked); save({ chatRouter: e.target.checked }, e.target.checked ? 'router on' : 'router off') }}
            />
            <span>
              <span className="font-medium text-foreground">Generic <code className="text-[11px]">/agent</code> router</span> (Slack + Discord) —
              when no automation matches a message, let the sender reach <strong>any agent by name</strong>
              {' '}(e.g. <code className="text-[11px]">/pod-troubleshooter why is pod X down?</code>). An unaddressed or unknown name gets a
              help list of available agents. Runs go through the same gate + run-as as everything else. No per-agent automation needed.
            </span>
          </label>

          {/* Warm (resident) Slack thread session: how long to keep a thread's claude alive between turns
              so follow-ups reply fast. The idle reaper kills it after this many minutes; a later reply
              revives it (context preserved). 0 disables residence (every reply cold-starts). */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-3 text-xs">
            <span className="font-medium text-foreground">Keep Slack threads warm for</span>
            <Input
              type="number"
              min={0}
              max={1440}
              value={chatIdle}
              disabled={busy}
              onChange={(e) => setChatIdle(Number(e.target.value))}
              onBlur={() => save({ chatIdleTimeoutMin: chatIdle }, 'warm-thread timeout saved')}
              className="h-7 w-20 text-xs"
            />
            <span>minutes.</span>
            <span className="text-muted-foreground">
              A Slack thread keeps ONE live agent session this long between messages, so follow-ups reply fast (no
              cold reload). After the idle window it's reaped; the next reply revives it with full context. <code className="text-[11px]">0</code> = off (every reply cold-starts).
            </span>
          </div>

          <DiscordSetupGuide />
          <Field label="Bot token" help="Discord Developer Portal → your app → Bot → Reset/Copy Token. Enable the MESSAGE CONTENT privileged intent on the same page.">
            <Input
              type="password"
              value={discordTok}
              onChange={(e) => setDiscordTok(e.target.value)}
              placeholder={discord.botToken ? '•••• (saved) — type a new token to replace' : 'bot token (MTI…/…)'}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => save({ discordBotToken: discordTok.trim() }, 'saved')}
              disabled={busy || !discordTok.trim()}
            >Save</Button>
            {discord.botToken && (
              <Button variant="ghost" onClick={() => save({ discordBotToken: '' }, 'removed')} disabled={busy}>Remove</Button>
            )}
          </div>

          {/* Invite the bot. A bot's user id IS its application (client) id, so once it connects we build
              the invite link with zero extra input; before the first connect, the admin can paste the
              Application ID to invite early. Without this step the bot is on the Gateway but in no server,
              so it receives no messages — the most common "connected but nothing happens" trap. */}
          {(() => {
            const inviteClientId = (discordState?.botUserId || discordAppId).trim()
            const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${inviteClientId}&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`
            return (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                <div className="text-xs font-medium text-foreground">Invite the bot to a server</div>
                {!discordState?.botUserId && (
                  <Field label="Application ID" help="Developer Portal → your app → General Information → Application ID. Auto-detected once the bot connects (a bot's user id is its application id).">
                    <Input
                      value={discordAppId}
                      onChange={(e) => setDiscordAppId(e.target.value.trim())}
                      placeholder="123456789012345678"
                      className="font-mono text-xs"
                    />
                  </Field>
                )}
                {inviteClientId ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={inviteUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm' })}>
                      Invite bot to your server ↗
                    </a>
                    <span className="text-[11px] text-muted-foreground">
                      Grants View Channels · Send Messages · Read Message History{discordState?.botUserId ? ' · app id auto-detected' : ''}
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">Save the bot token so it connects (app id auto-detected), or paste the Application ID above, to enable the invite link.</p>
                )}
              </div>
            )
          })()}
        </CardContent>
      </Card>
    </div>
  )
}

function TabButton({ on, onClick, href, children }: { on: boolean; onClick: () => void; href?: string; children: ReactNode }) {
  const cls = `rounded-md px-3 py-1 text-sm no-underline transition-colors ${on ? 'bg-muted font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`
  // A deep-linkable tab (one whose state lives in the URL hash) passes `href`, so it renders as a
  // real anchor — right-click "open in new tab" works. Purely-local tabs omit href and stay buttons.
  return href
    ? <a href={href} onClick={onNavClick(onClick)} className={cls}>{children}</a>
    : <button onClick={onClick} className={cls}>{children}</button>
}

function CompanySettings({ me }: { me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [md, setMd] = useState('')
  const [saved, setSaved] = useState('')
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    api.settings().then((s) => {
      if (s.error) return setHint('⚠ ' + s.error)
      setMd(s.companyMd ?? ''); setSaved(s.companyMd ?? ''); setMeta({ updatedAt: s.updatedAt, updatedBy: s.updatedBy })
    }).catch(() => {})
  }, [])

  const dirty = md !== saved
  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveCompany(md)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setSaved(md); setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy }); setHint('saved')
    setTimeout(() => setHint(''), 1500)
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        The <strong>Company context</strong> is one shared document — voice, facts, conventions, links, how this
        workspace works — appended to the system prompt of <strong>every claude-code agent</strong> you spawn. Edit it
        once here instead of repeating it in each agent's CLAUDE.md. (Leave it blank to inject nothing.)
      </p>

      <Card>
        <CardContent className="space-y-3 p-4">
          <Field label="Company context (markdown)">
            <Textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              className="min-h-[320px] font-mono text-xs leading-relaxed"
              placeholder={'# Acme Inc.\n\n## Voice\nConcise, friendly, no emoji in customer-facing copy.\n\n## Facts\n- Support hours: 9–5 ET, Mon–Fri\n- Billing runs on Stripe\n\n## Conventions\n- Recall relevant context before non-trivial work; remember durable decisions, fixes, and gotchas.'}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy || !dirty}>
              {dirty ? 'Save' : 'Saved'}
            </Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            {meta.updatedAt && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                last updated {new Date(meta.updatedAt).toLocaleString()}{meta.updatedBy ? ` by ${meta.updatedBy}` : ''}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** Settings → Theme — the per-tenant accent colour + favicon badge, so several tenants running in
 *  parallel are distinguishable at a glance (sidebar strip, browser-tab favicon, login screen). */
function ThemeSettings({ me, state }: { me: Member; state: StateResp | null }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [accent, setAccent] = useState('')      // '' = no accent (default theme)
  const [badge, setBadge] = useState('')
  const [saved, setSaved] = useState<Branding>({})
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    api.branding().then((b) => {
      if (b.error) return setHint('⚠ ' + b.error)
      setAccent(b.accentColor ?? ''); setBadge(b.badge ?? '')
      setSaved({ accentColor: b.accentColor, badge: b.badge }); setMeta({ updatedAt: b.updatedAt, updatedBy: b.updatedBy })
    }).catch(() => {})
  }, [])

  const validHex = /^#[0-9a-fA-F]{6}$/.test(accent)
  const cur: Branding = { accentColor: validHex ? accent.toLowerCase() : undefined, badge: badge.trim() || undefined }
  const dirty = cur.accentColor !== saved.accentColor || cur.badge !== saved.badge
  const tenantName = state?.tenantName || state?.tenant
  const previewFavicon = faviconDataUri(cur.accentColor, cur.badge, tenantName)

  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.saveBranding(cur)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setSaved({ accentColor: r.accentColor, badge: r.badge }); setMeta({ updatedAt: Date.now(), updatedBy: me.email })
    // Go live immediately — no reload — for this browser.
    applyAccent(r.accentColor); applyFavicon(faviconDataUri(r.accentColor, r.badge, tenantName))
    setAccent(r.accentColor ?? ''); setBadge(r.badge ?? '')
    setHint('saved'); setTimeout(() => setHint(''), 1500)
  }
  const clear = () => { setAccent(''); setBadge('') }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Give this tenant a <strong>colour + favicon badge</strong> so it's instantly recognisable when you're
        running several consoles side by side. The accent tints the sidebar strip, active nav item and focus
        rings; the badge becomes the browser-tab favicon. Applies to <strong>this tenant only</strong>. Leave
        the colour blank for the default look.
      </p>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-5">
            <Field label="Accent colour">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={validHex ? accent : '#7c3aed'}
                  onChange={(e) => setAccent(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded border bg-background p-0.5"
                  aria-label="accent colour"
                />
                <Input
                  value={accent}
                  onChange={(e) => setAccent(e.target.value.trim())}
                  placeholder="#7c3aed"
                  className="w-32 font-mono text-xs"
                />
              </div>
            </Field>
            <Field label="Favicon badge" help="An emoji or 1–3 letters. Blank → the tenant's initial.">
              <Input
                value={badge}
                onChange={(e) => setBadge(e.target.value)}
                placeholder={tenantName ? tenantName.charAt(0).toUpperCase() : '🟣'}
                className="w-28"
              />
            </Field>
          </div>

          {accent && !validHex && <div className="text-xs text-amber-600">Enter a 6-digit hex colour like <span className="font-mono">#7c3aed</span> (or clear it).</div>}

          {/* Live preview — favicon tile + a mock sidebar showing the accent strip and active nav item. */}
          <div className="flex flex-wrap items-center gap-5 rounded-lg border bg-muted/30 p-4">
            <div className="flex flex-col items-center gap-1">
              <img src={previewFavicon} alt="favicon preview" className="h-12 w-12 rounded-[10px] shadow-sm" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">favicon</span>
            </div>
            <div className="w-44 overflow-hidden rounded-md border bg-background">
              <div className="h-1" style={{ background: cur.accentColor || 'transparent' }} />
              <div className="p-2">
                <div className="mb-1.5 text-[11px] font-semibold">⚙️ {tenantName || 'Agent OS'}</div>
                <div
                  className="rounded px-2 py-1 text-[11px] font-medium"
                  style={cur.accentColor ? { background: cur.accentColor, color: readableOn(cur.accentColor) } : { background: 'var(--sidebar-primary)', color: 'var(--sidebar-primary-foreground)' }}
                >Inbox</div>
                <div className="px-2 py-1 text-[11px] text-muted-foreground">Agents</div>
                <div className="px-2 py-1 text-[11px] text-muted-foreground">Tasks</div>
              </div>
            </div>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">sidebar</span>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy || !dirty}>{dirty ? 'Save' : 'Saved'}</Button>
            {(accent || badge) && <Button variant="ghost" onClick={clear} disabled={busy}>Clear</Button>}
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
            {meta.updatedAt && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                last updated {new Date(meta.updatedAt).toLocaleString()}{meta.updatedBy ? ` by ${meta.updatedBy}` : ''}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Policy editor ──────────────────────────────────────────────────────────────
const OPS: PolicyOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']

// The UI speaks the exact three outcomes the policy now stores: allow / ask (admin|owner) / never.
type Outcome = 'allow' | 'ask-admin' | 'ask-owner' | 'never'
const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: 'allow', label: 'Allow' },
  { key: 'ask-admin', label: 'Ask admin' },
  { key: 'ask-owner', label: 'Ask owner' },
  { key: 'never', label: 'Never' },
]
const POLICY_OUTCOME_STYLE: Record<Outcome, string> = {
  'allow': 'border-emerald-300 bg-emerald-50 text-emerald-700',
  'ask-admin': 'border-amber-300 bg-amber-50 text-amber-700',
  'ask-owner': 'border-red-300 bg-red-50 text-red-700',
  'never': 'border-neutral-400 bg-neutral-100 text-neutral-700',
}
function outcomeOf(o: PolicyOutcome): Outcome {
  if (o.action === 'allow') return 'allow'
  if (o.action === 'never') return 'never'
  return o.approver === 'owner' ? 'ask-owner' : 'ask-admin'
}
function toPolicyOutcome(o: Outcome): PolicyOutcome {
  if (o === 'allow') return { action: 'allow' }
  if (o === 'never') return { action: 'never' }
  return { action: 'ask', approver: o === 'ask-owner' ? 'owner' : 'admin' }
}

// The capabilities real (claude-code) agents actually emit — the curated, plain-English surface that
// covers ~all real governance. Everything else lives under Advanced rules.
const PERMISSIONS: { key: string; label: string; help: string; cap: string; risky: boolean }[] = [
  { key: 'shell-risky', label: 'Risky shell commands', help: 'rm, deploy, prod, stripe, kubectl, DROP …', cap: 'shell.exec', risky: true },
  { key: 'shell', label: 'Shell commands', help: 'anything else the agent runs in a terminal', cap: 'shell.exec', risky: false },
  { key: 'tool-write', label: 'Send / write via tools', help: 'send, create, update, delete, post …', cap: 'connector.call', risky: true },
  { key: 'tool-read', label: 'Read via tools', help: 'get, list, search, read …', cap: 'connector.call', risky: false },
  { key: 'connect', label: 'Connect a company-wide app', help: 'wire shared access to a new app for the whole team', cap: 'connector.connect', risky: false },
]
function permRuleIndex(rules: PolicyRule[], perm: { cap: string; risky: boolean }): number {
  return rules.findIndex((r) => r.match.capability === perm.cap && !!r.match.when === perm.risky)
}

/** "true"/"false" → boolean, numeric → number, else the raw string. Mirrors how the engine compares. */
function coerceValue(s: string): number | string | boolean {
  const t = s.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return s
}

function PolicyEditor({ me }: { me: Member }) {
  const [doc, setDoc] = useState<PolicyDocument | null>(null)
  const [saved, setSaved] = useState('')
  const [editable, setEditable] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const canEdit = me.role === 'owner'

  useEffect(() => {
    api.policy().then((r) => {
      if (r.error) return setHint('⚠ ' + r.error)
      setEditable(r.editable)
      if (r.document) { setDoc(r.document); setSaved(JSON.stringify(r.document)) }
    }).catch(() => {})
  }, [])

  if (!editable) return <div className="text-sm text-muted-foreground">The active policy engine isn't editable from the console.</div>
  if (!doc) return <div className="text-sm text-muted-foreground">Loading…</div>

  const dirty = JSON.stringify(doc) !== saved
  const set = (patch: Partial<PolicyDocument>) => setDoc({ ...doc, ...patch })
  const setRule = (i: number, r: PolicyRule) => set({ rules: doc.rules.map((x, j) => (j === i ? r : x)) })
  const addRule = () => set({ rules: [...doc.rules, { match: { capability: '' }, action: 'ask', approver: 'admin' }] })
  const removeRule = (i: number) => set({ rules: doc.rules.filter((_, j) => j !== i) })
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= doc.rules.length) return
    const next = [...doc.rules]
    ;[next[i], next[j]] = [next[j], next[i]]
    set({ rules: next })
  }

  // Permissions (simple view): each maps to one rule signature (capability + risky?). Reading derives
  // the outcome from that rule (or the default when it's absent); writing updates/inserts it, keeping a
  // risky variant ahead of its broad sibling so first-match-wins stays correct.
  const permOutcome = (perm: { cap: string; risky: boolean }): { outcome: Outcome; fromDefault: boolean } => {
    const idx = permRuleIndex(doc.rules, perm)
    if (idx >= 0) return { outcome: outcomeOf(doc.rules[idx]), fromDefault: false }
    return { outcome: outcomeOf(doc.default), fromDefault: true }
  }
  const setPerm = (perm: { cap: string; risky: boolean }, outcome: Outcome) => {
    const out = toPolicyOutcome(outcome)
    const rules = [...doc.rules]
    const idx = permRuleIndex(rules, perm)
    if (idx >= 0) {
      // Rebuild from match + the new outcome so a stale `approver` never lingers when switching to allow/never.
      rules[idx] = { match: rules[idx].match, ...out }
    } else {
      const rule: PolicyRule = { match: { capability: perm.cap, ...(perm.risky ? { when: { arg: 'risky', op: 'eq', value: true } } : {}) }, ...out }
      if (perm.risky) {
        const broad = rules.findIndex((r) => r.match.capability === perm.cap && !r.match.when)
        rules.splice(broad >= 0 ? broad : 0, 0, rule)
      } else rules.push(rule)
    }
    set({ rules })
  }
  const setDefault = (outcome: Outcome) => set({ default: toPolicyOutcome(outcome) })

  const save = async () => {
    setBusy(true); setHint('')
    const r = await api.savePolicy(doc)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setSaved(JSON.stringify(doc)); setHint('saved — applied live to all sessions')
    setTimeout(() => setHint(''), 2500)
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        What your agents may do on their own — and what needs a human. <strong>Allow</strong> runs immediately,
        <strong> Ask</strong> pauses for an admin or owner to approve in the Inbox, <strong>Never</strong> is refused outright.
        {canEdit ? ' Changes apply live to every running session.' : ' Only an owner can edit the policy.'}
      </p>

      {/* Simple: the permissions real agents actually use */}
      <div className="mb-2 mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Permissions</div>
      <Card>
        <CardContent className="divide-y p-0">
          {PERMISSIONS.map((perm) => {
            const { outcome, fromDefault } = permOutcome(perm)
            return (
              <div key={perm.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{perm.label}</div>
                  <div className="text-xs text-muted-foreground">{perm.help}{fromDefault ? ' · using the default' : ''}</div>
                </div>
                <OutcomeSelect value={outcome} disabled={!canEdit} onChange={(v) => setPerm(perm, v)} />
              </div>
            )
          })}
          <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Anything else</div>
              <div className="text-xs text-muted-foreground">any action no rule above matches</div>
            </div>
            <OutcomeSelect value={outcomeOf(doc.default)} disabled={!canEdit} onChange={setDefault} />
          </div>
        </CardContent>
      </Card>

      {/* Advanced: the raw rule list (globs, value conditions, ordering) for power users */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="mt-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Advanced rules ({doc.rules.length})
      </button>
      {showAdvanced && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-muted-foreground">
            The raw ruleset behind the permissions above — capability globs (e.g. <code>stripe.*</code>, <code>*.delete</code>)
            with optional value conditions (e.g. amount &gt; 1000), evaluated top-down, first match wins. The Permissions
            cards edit specific rows here; add your own for finer control.
          </p>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Rules — first match wins</div>
            {canEdit && <Button size="sm" variant="outline" onClick={addRule}><Plus className="mr-1 h-3.5 w-3.5" />Add rule</Button>}
          </div>
          <div className="space-y-2">
            {doc.rules.map((r, i) => (
              <Card key={i}>
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-center text-[11px] text-muted-foreground">{i + 1}</span>
                    <Input
                      value={r.match.capability}
                      disabled={!canEdit}
                      onChange={(e) => setRule(i, { ...r, match: { ...r.match, capability: e.target.value } })}
                      placeholder="capability glob — e.g. stripe.* or *.delete"
                      className="font-mono text-xs"
                    />
                    <OutcomeSelect value={outcomeOf(r)} disabled={!canEdit} onChange={(v) => setRule(i, { match: r.match, ...toPolicyOutcome(v) })} />
                    {canEdit && (
                      <div className="flex shrink-0 items-center">
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="up" onClick={() => move(i, -1)}>↑</Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="down" onClick={() => move(i, 1)}>↓</Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="remove" onClick={() => removeRule(i)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    )}
                  </div>
                  {/* Optional value condition */}
                  <div className="flex items-center gap-2 pl-7 text-xs">
                    {r.match.when ? (
                      <>
                        <span className="text-muted-foreground">when arg</span>
                        <Input value={r.match.when.arg} disabled={!canEdit} onChange={(e) => setRule(i, { ...r, match: { ...r.match, when: { ...r.match.when!, arg: e.target.value } } })} placeholder="amountUsd" className="h-7 w-32 font-mono text-xs" />
                        <select
                          value={r.match.when.op}
                          disabled={!canEdit}
                          onChange={(e) => setRule(i, { ...r, match: { ...r.match, when: { ...r.match.when!, op: e.target.value as PolicyOp } } })}
                          className="h-7 rounded-md border bg-background px-1 text-xs disabled:opacity-60"
                        >
                          {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <Input
                          value={String(r.match.when.value)}
                          disabled={!canEdit}
                          onChange={(e) => setRule(i, { ...r, match: { ...r.match, when: { ...r.match.when!, value: coerceValue(e.target.value) } } })}
                          placeholder="1000 / true / text"
                          className="h-7 w-28 font-mono text-xs"
                        />
                        {canEdit && <button className="text-muted-foreground underline hover:text-foreground" onClick={() => setRule(i, { ...r, match: { capability: r.match.capability } })}>remove condition</button>}
                      </>
                    ) : (
                      canEdit && <button className="text-muted-foreground underline hover:text-foreground" onClick={() => setRule(i, { ...r, match: { ...r.match, when: { arg: '', op: 'eq', value: '' } } })}>+ add condition</button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={save} disabled={busy || !dirty}>{dirty ? 'Save policy' : 'Saved'}</Button>
          {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">id: {doc.id}</span>
        </div>
      )}
    </>
  )
}

function OutcomeSelect({ value, onChange, disabled }: { value: Outcome; onChange: (v: Outcome) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Outcome)} className={`h-8 w-32 shrink-0 rounded-md border px-2 text-xs font-medium disabled:opacity-60 ${POLICY_OUTCOME_STYLE[value]}`}>
      {OUTCOMES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30 text-muted-foreground hover:bg-muted'}`}
    >
      {children}
    </button>
  )
}
