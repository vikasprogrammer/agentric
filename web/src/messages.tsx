// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Messages — talk to agents the way you talk to teammates.
//
// A contact list on the left, one endless conversation per contact on the right. There are no
// sessions, terminals or runs on this page: the server keeps a governed session alive behind each
// conversation (src/edge/direct-messages.ts) and hands back plain messages. What the agent DID to
// produce a reply is one click away ("N steps"), never in the way.
//
// Approvals and questions are the one piece of machinery that must surface — they are the trust
// boundary — so they appear inline as cards, rendered by the same component the rest of the console
// uses (passed in as `renderPending`, so this file imports nothing from App.tsx).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, Zap, FileText, MoreHorizontal, TerminalSquare, Hash, Users, LogOut, Pencil, Paperclip, Square, Loader2, ArrowRightLeft, Clock, Info, Workflow, GitMerge, MessageSquareReply, Bell, BellOff, AtSign, Plus, Search, Send, UserMinus, RotateCcw, Check, X, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { chatSocket } from '@/lib/chat-socket'
import { api, type NotificationPrefs, type NotifyLevel, type ThreadView, type DmContact, type DmDirectoryAgent, type DmMessage, type DmPresence, type DmStep, type DmJob, type DmHandoff, type ChatFile, type ChatArtifactRef, type DmThread, type RoomThread, type Member, type Msg, type RoomPerson, type RoomSummary } from '@/lib/api'

/** Search people/agents by NAME first; a description match only ranks after every name match — otherwise
 *  typing "engin" lists half the fleet (anything whose blurb says "engineer") above the Engineer. */
function rankAgents<T extends { id: string; description?: string; category?: string }>(agents: T[], q: string): T[] {
  const s = q.trim().toLowerCase()
  if (!s) return agents
  const name = (a: T) => `${a.id} ${a.id.replace(/[-_]+/g, ' ')}`.toLowerCase()
  const byName = agents.filter((a) => name(a).includes(s))
  // Once a name matches, that is what was meant: drop the description-only hits entirely.
  if (byName.length) return [...byName.filter((a) => name(a).startsWith(s)), ...byName.filter((a) => !name(a).startsWith(s))]
  return agents.filter((a) => (a.description || '').toLowerCase().includes(s) || (a.category || '').toLowerCase().includes(s))
}

const prettyAgent = (id: string): string => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** A stable, pleasant colour per agent — the avatar tile is how you tell contacts apart at a glance. */
const TILES = ['bg-sky-500/15 text-sky-700 dark:text-sky-300', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', 'bg-amber-500/15 text-amber-700 dark:text-amber-300', 'bg-violet-500/15 text-violet-700 dark:text-violet-300', 'bg-rose-500/15 text-rose-700 dark:text-rose-300', 'bg-teal-500/15 text-teal-700 dark:text-teal-300', 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300', 'bg-orange-500/15 text-orange-700 dark:text-orange-300']
const tileOf = (id: string): string => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TILES[h % TILES.length] }

type IconRenderer = (icon: string | undefined, className: string) => ReactNode

function Avatar({ agent, icon, renderIcon, size = 'md', presence }: { agent: string; icon?: string; renderIcon: IconRenderer; size?: 'sm' | 'md' | 'lg'; presence?: DmPresence }) {
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-9 w-9 rounded-lg'
  const glyph = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'
  return (
    <span className={`relative flex shrink-0 items-center justify-center ${box} ${tileOf(agent)}`}>
      {renderIcon(icon, glyph)}
      {presence && <PresenceDot presence={presence} className="absolute -bottom-0.5 -right-0.5 ring-2 ring-background" />}
    </span>
  )
}

function PresenceDot({ presence, className = '' }: { presence: DmPresence; className?: string }) {
  const cls = presence === 'working' ? 'bg-amber-400 animate-pulse' : presence === 'online' ? 'bg-emerald-500' : 'border border-muted-foreground/60 bg-background'
  const title = presence === 'working' ? 'Working' : presence === 'online' ? 'Active' : 'Away — will pick up when you message'
  return <span title={title} className={`h-2 w-2 shrink-0 rounded-full ${cls} ${className}`} />
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()
function dayLabel(ts: number): string {
  const d = new Date(ts), now = new Date()
  if (sameDay(ts, now.getTime())) return 'Today'
  if (sameDay(ts, now.getTime() - 86_400_000)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}
const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
function shortWhen(ts: number): string {
  if (sameDay(ts, Date.now())) return clock(ts)
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The work behind a reply — collapsed to a single quiet line until someone wants to look. */
function Steps({ steps, live = false, took }: { steps: DmStep[]; live?: boolean; took?: number }) {
  const [open, setOpen] = useState(false)
  const done = steps.filter((s) => s.t === 'do')
  // A reply with no steps still says how long it took, once that is long enough to be worth saying.
  if (steps.length === 0) return took && took >= 5000 ? <div className="mt-1 text-[11px] text-muted-foreground">took {span(took)}</div> : null
  const failed = done.filter((s) => s.status === 'error').length
  return (
    <div className="mt-1">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {live ? 'Show progress' : `${done.length || steps.length} step${(done.length || steps.length) === 1 ? '' : 's'}`}
        {!live && took ? <span> · {span(took)}</span> : null}
        {failed > 0 && <span className="text-amber-600"> · {failed} retried</span>}
      </button>
      {open && (
        <ol className="mt-1 space-y-1 border-l pl-3">
          {steps.map((s, i) => s.t === 'do' ? (
            <li key={i} className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.status === 'error' ? 'bg-amber-500' : s.status === 'ok' ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
              <span className="shrink-0 font-medium">{s.text}</span>
              {s.detail && <span className="truncate font-mono text-[11px] opacity-70" title={s.detail}>{s.detail}</span>}
            </li>
          ) : (
            <li key={i} className="whitespace-pre-wrap text-[12px] italic text-muted-foreground">{s.text}</li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** "42s" / "3m 05s" — how long something has taken. */
const span = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }

/** A live count of how long an agent has been at it. Ticks locally; `since` comes from the server. */
function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t) }, [])
  if (!since) return null
  return <span className="tabular-nums text-muted-foreground">· {span(Date.now() - since)}</span>
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((d) => <span key={d} className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />)}
    </span>
  )
}

/** Something an agent showed with its message: an image, a video or audio clip drawn in place, any
 *  other file as a tile. Opens the file itself — the people in a conversation can all read what was
 *  shown there, whether or not it is in their Library. */
function Media({ a }: { a: ChatArtifactRef }) {
  if (a.isImage) return <a href={a.raw} target="_blank" rel="noreferrer" title={a.title} className="block overflow-hidden rounded-lg border bg-card"><img src={a.raw} alt={a.title} loading="lazy" className="max-h-72 max-w-full object-contain sm:max-w-sm" /></a>
  if (a.isVideo) return <video src={a.raw} controls preload="metadata" title={a.title} className="max-h-72 max-w-full rounded-lg border bg-black sm:max-w-sm" />
  if (a.mime.startsWith('audio/')) return <audio src={a.raw} controls preload="metadata" title={a.title} className="max-w-full" />
  return (
    <a href={a.raw} target="_blank" rel="noreferrer" className="flex max-w-[20rem] items-center gap-2.5 rounded-lg border bg-card px-3 py-2 transition hover:border-primary">
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{a.title}</span><span className="block truncate text-[11px] text-muted-foreground">{a.filename}</span></span>
    </a>
  )
}

/** One row of the conversation. Consecutive messages from the same author within a few minutes are
 *  GROUPED: only the first carries the avatar + name, the rest sit flush under it with a hover time. */
function MessageRow({ m, grouped, name, avatar, onThread, onAction, replying }: { m: DmMessage; grouped: boolean; name: string; avatar: ReactNode; /** open this message's thread (absent inside a thread) */ onThread?: () => void; /** send one of the agent's quick replies — given only for the newest message, so stale ones can't be tapped */ onAction?: (text: string) => void; /** agents answering in this message's thread right now */ replying?: string[] }) {
  const body = m.authorKind === 'agent'
    ? <div className="md max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown></div>
    : <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>
  return (
    <div className={`group relative flex gap-3 px-5 hover:bg-muted/40 ${grouped ? 'py-0.5' : 'pb-0.5 pt-2'} ${m.pending ? 'opacity-60' : ''}`}>
      {onThread && !m.pending && (
        <button onClick={onThread} title="Reply in thread" aria-label="Reply in thread" className="absolute -top-2 right-5 hidden items-center gap-1 rounded-md border bg-background px-1.5 py-1 text-[11px] text-muted-foreground shadow-sm hover:text-foreground group-hover:flex"><MessageSquareReply className="h-3.5 w-3.5" /> Reply</button>
      )}
      <div className="w-9 shrink-0">
        {grouped
          ? <span className="hidden pt-1 text-right text-[10px] leading-5 text-muted-foreground group-hover:block">{clock(m.createdAt)}</span>
          : avatar}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{name}</span>
            <span className="text-[11px] text-muted-foreground">{clock(m.createdAt)}</span>
          </div>
        )}
        {m.tag === 'summary' && <span className="mb-0.5 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary"><GitMerge className="h-2.5 w-2.5" />Combined answer</span>}
        {m.tag === 'automation' && <span className="mb-0.5 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"><Zap className="h-2.5 w-2.5" />Automation</span>}
        {m.tag === 'bg' && <span className="mb-0.5 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"><Loader2 className="h-2.5 w-2.5" />{m.authorKind === 'agent' ? 'Background result' : 'Sent to the background'}</span>}
        {m.body ? body : null}
        {m.artifacts && <div className="mt-1.5 flex flex-wrap items-start gap-2">{m.artifacts.map((a) => <Media key={a.id} a={a} />)}</div>}
        {m.files && <div className="mt-1 flex flex-wrap gap-1">{m.files.map((f, i) => <span key={i} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"><Paperclip className="h-3 w-3" />{f}</span>)}</div>}
        {(m.steps || m.took) && <Steps steps={m.steps ?? []} took={m.took} />}
        {onAction && m.actions && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {m.actions.map((a, i) => <button key={i} onClick={() => onAction(a)} className="rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-xs font-medium text-primary transition hover:bg-primary hover:text-primary-foreground">{a}</button>)}
          </div>
        )}
        {onThread && (!!m.replies || !!replying?.length) && (
          <button onClick={onThread} className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-primary hover:bg-primary/10">
            <MessageSquareReply className="h-3.5 w-3.5" /> {m.replies ?? 0} {m.replies === 1 ? 'reply' : 'replies'}
            {/* Work happening in a thread is shown ON the thread, not in the room's typing line. */}
            {replying?.length ? <span className="flex items-center gap-1 font-normal text-muted-foreground">· <TypingDots /> {replying.map(prettyAgent).join(', ')} replying…</span>
              : m.lastReplyAt ? <span className="font-normal text-muted-foreground">· last {shortWhen(m.lastReplyAt)}</span> : null}
          </button>
        )}
      </div>
    </div>
  )
}

/** Browse the agents you can talk to and add them as contacts. */
function Directory({ agents, renderIcon, onAdd, onClose, hasContacts }: { agents: DmDirectoryAgent[]; renderIcon: IconRenderer; onAdd: (id: string) => void; onClose?: () => void; hasContacts: boolean }) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => rankAgents(agents, q), [agents, q])
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3 px-6 py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{hasContacts ? 'Add a teammate' : 'Who do you want to work with?'}</h2>
          <p className="text-sm text-muted-foreground">Add an agent to your contacts and message them like anyone else on the team. They remember the conversation and work under the same approvals as everyone.</p>
        </div>
        {onClose && <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or what they do…" className="h-9 pl-8 text-sm" />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {shown.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-lg border p-2.5">
            <Avatar agent={a.id} icon={a.icon} renderIcon={renderIcon} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{prettyAgent(a.id)}</span>
                {a.category && <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{a.category}</span>}
              </div>
              <div className="truncate text-xs text-muted-foreground">{a.description}</div>
            </div>
            <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-xs" onClick={() => onAdd(a.id)}><Plus className="h-3.5 w-3.5" /> Add</Button>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            {agents.length === 0 ? (hasContacts ? 'Everyone you can work with is already in your contacts.' : 'No agents are assigned to you yet — ask an admin to add you to one.') : `Nobody matches “${q}”.`}
          </p>
        )}
      </div>
    </div>
  )
}

interface Outgoing { key: number; text: string; at: number; error?: string }

/** What a conversation is with: one agent (a DM), or a room / group of people and agents. */
type Target = { kind: 'dm'; contact: DmContact } | { kind: 'room'; room: RoomSummary }
/** Both kinds of thread, in the one shape the conversation renders. */
interface View {
  messages: DmMessage[]
  typing: { agent: string; label: string; steps: DmStep[]; thread?: number | null; since?: number }[]
  threadView?: ThreadView | null
  sessionIds: string[]
  stalled: boolean
  working: boolean
  room?: RoomSummary
  /** Every session the conversation has used — the inbox cards of these belong in the stream. */
  cardSessionIds: string[]
  jobs: DmJob[]
  handoffs: DmHandoff[]
  /** Other people typing in the room right now. */
  peopleTyping: string[]
}

const roomView = (r: RoomThread): View => ({ threadView: r.threadView, messages: r.messages, typing: r.typing, sessionIds: r.sessionIds, stalled: false, working: r.typing.length > 0, room: r.room, cardSessionIds: r.cardSessionIds ?? r.sessionIds, jobs: r.jobs ?? [], handoffs: r.handoffs ?? [], peopleTyping: r.peopleTyping ?? [] })
const dmView = (id: string, r: DmThread): View => ({
  threadView: r.threadView,
  messages: r.messages, typing: r.typing ? [{ agent: id, ...r.typing }] : [], sessionIds: r.sessionId ? [r.sessionId] : [], stalled: !!r.stalled, working: r.presence === 'working',
  cardSessionIds: r.cardSessionIds ?? (r.sessionId ? [r.sessionId] : []), jobs: r.jobs ?? [], handoffs: r.handoffs ?? [], peopleTyping: [],
})

/** A pushed thread from the chat socket — `data` is exactly what the REST thread route returns. */
export interface PushedThread { key: string; data?: DmThread | RoomThread; error?: string }

const COMMANDS: { name: string; usage: string; help: string }[] = [
  { name: 'new', usage: '/new', help: 'Start a new session — a clean slate' },
  { name: 'bg', usage: '/bg <request>', help: 'Run it in the background; the result is posted here' },
  { name: 'stop', usage: '/stop', help: 'Stop what the agent is doing right now' },
  { name: 'task', usage: '/task <title>', help: 'File a task on the board' },
  { name: 'remind', usage: '/remind <30m|2h|1d> <what>', help: 'Bring this up again later' },
  { name: 'status', usage: '/status', help: 'What is running here' },
  { name: 'summary', usage: '/summary', help: 'The room so far, in a few lines' },
  { name: 'help', usage: '/help', help: 'List the commands' },
]

const ago = (ts: number): string => { const m = Math.max(1, Math.round((Date.now() - ts) / 60_000)); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h` }

function readFile(f: File): Promise<ChatFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve({ name: f.name || 'pasted-file', dataB64: String(r.result).split(',')[1] ?? '' })
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })
}

/** Work the agent handed to another agent — a quiet status card in the stream. */
function HandoffCard({ h, renderIcon, onOpenSession }: { h: DmHandoff; renderIcon: IconRenderer; onOpenSession?: (id: string) => void }) {
  const state = h.blocked ? 'needs someone' : h.working ? 'working' : h.status === 'done' ? 'done' : h.status === 'crashed' ? 'failed' : h.status === 'stopped' ? 'stopped' : h.status === 'running' ? 'waiting' : h.status
  const dot = h.blocked ? 'bg-amber-500' : h.working ? 'bg-amber-400 animate-pulse' : h.status === 'done' ? 'bg-emerald-500' : h.status === 'crashed' ? 'bg-destructive' : 'bg-muted-foreground/50'
  return (
    <div className="max-w-xl rounded-lg border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">{h.kind === 'answer' ? 'Asked' : 'Handed to'}</span>
        <Avatar agent={h.agent} renderIcon={renderIcon} size="sm" />
        <span className="font-medium">{prettyAgent(h.agent)}</span>
        <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} /><span className="shrink-0 text-muted-foreground">{state}</span>
      </div>
      {h.title && <div className="mt-1 truncate text-sm" title={h.title}>{h.title}</div>}
      {h.summary && <div className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{h.summary}</div>}
      {onOpenSession && <button onClick={() => onOpenSession(h.sessionId)} className="mt-1 text-[11px] text-primary hover:underline">Open the run</button>}
    </div>
  )
}

const isRoomId = (s: string): boolean => s.startsWith('room_')
/** A room's display name: its own, or — for an unnamed group — everyone in it but you. */
function roomTitle(r: RoomSummary, meId: string): string {
  if (r.name) return r.name
  const names = [...r.members.filter((m) => m.id !== meId).map((m) => m.name.split(' ')[0]), ...r.agents.map((a) => prettyAgent(a.id))]
  return names.join(', ') || 'Just you'
}

/** Someone the `@` picker can insert: a room's agent, a person in it, or everyone. `id` is the text after the @. */
interface MentionTarget { id: string; title: string; icon?: string; person?: { name: string; avatar?: string }; everyone?: boolean }
function mentionTargets(room: RoomSummary | undefined, meId: string): MentionTarget[] {
  if (!room) return []
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const others = room.members.filter((m) => m.id !== meId)
  const firsts = others.map((m) => squash(m.name.split(/\s+/)[0]))
  return [
    ...room.agents.map((a) => ({ id: a.id, title: prettyAgent(a.id), icon: a.icon })),
    // A first name when it is unambiguous here, the whole name otherwise — both forms the server resolves.
    ...others.map((m, i) => ({ id: firsts.filter((f) => f === firsts[i]).length === 1 && firsts[i] ? firsts[i] : squash(m.name), title: m.name, person: m })).filter((t) => t.id),
    ...(others.length > 1 ? [{ id: 'everyone', title: 'Everyone in this room', everyone: true }] : []),
  ]
}
function MentionGlyph({ t, renderIcon }: { t: MentionTarget; renderIcon: IconRenderer }) {
  if (t.person) return <PersonAvatar p={t.person} className="h-6 w-6 rounded-md text-[10px]" />
  if (t.everyone) return <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted"><Users className="h-3.5 w-3.5 text-muted-foreground" /></span>
  return <Avatar agent={t.id} icon={t.icon} renderIcon={renderIcon} size="sm" />
}

function PersonAvatar({ p, className = 'h-9 w-9 rounded-lg text-sm' }: { p: { name: string; avatar?: string }; className?: string }) {
  return p.avatar
    ? <img src={p.avatar} alt="" className={`shrink-0 object-cover ${className}`} />
    : <span className={`flex shrink-0 items-center justify-center bg-muted font-semibold text-muted-foreground ${className}`}>{(p.name || '?').slice(0, 1).toUpperCase()}</span>
}

function RoomGlyph({ room, size = 'md' }: { room: RoomSummary; size?: 'sm' | 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-14 w-14 rounded-2xl' : size === 'sm' ? 'h-6 w-6 rounded-md' : 'h-9 w-9 rounded-lg'
  const glyph = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5'
  return <span className={`flex shrink-0 items-center justify-center ${box} ${tileOf(room.id)}`}>{room.name ? <Hash className={glyph} /> : <Users className={glyph} />}</span>
}

/** Pick people and agents — used to create a room and to add to one. */
function Picker({ people, agents, renderIcon, pickedPeople, pickedAgents, onPeople, onAgents }: {
  people: RoomPerson[]; agents: DmDirectoryAgent[]; renderIcon: IconRenderer
  pickedPeople: string[]; pickedAgents: string[]; onPeople: (v: string[]) => void; onAgents: (v: string[]) => void
}) {
  const [q, setQ] = useState('')
  const s = q.trim().toLowerCase()
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
  const row = (on: boolean, onClick: () => void, icon: ReactNode, title: string, sub?: string) => (
    <button key={title + (sub ?? '')} type="button" onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-lg border p-2 text-left ${on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60'}`}>
      {icon}
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{title}</span>{sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}</span>
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'border-primary bg-primary text-primary-foreground' : ''}`}>{on && <Check className="h-3 w-3" />}</span>
    </button>
  )
  const ps = people.filter((p) => !s || p.name.toLowerCase().includes(s))
  const as = rankAgents(agents, q)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people and agents…" className="h-9 pl-8 text-sm" />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {ps.length > 0 && <div className="space-y-1"><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">People</div>
          {ps.map((p) => row(pickedPeople.includes(p.id), () => onPeople(toggle(pickedPeople, p.id)), <PersonAvatar p={p} className="h-8 w-8 rounded-lg text-xs" />, p.name))}</div>}
        {as.length > 0 && <div className="space-y-1"><div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Agents</div>
          {as.map((a) => row(pickedAgents.includes(a.id), () => onAgents(toggle(pickedAgents, a.id)), <Avatar agent={a.id} icon={a.icon} renderIcon={renderIcon} />, prettyAgent(a.id), a.description))}</div>}
        {ps.length + as.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nobody matches “{q}”.</p>}
      </div>
    </div>
  )
}

function NewRoom({ me, people, agents, renderIcon, onCreated, onClose }: { me: Member; people: RoomPerson[]; agents: DmDirectoryAgent[]; renderIcon: IconRenderer; onCreated: (id: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [pp, setPp] = useState<string[]>([])
  const [aa, setAa] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true); setErr('')
    const r = await api.roomCreate({ name: name.trim() || undefined, members: pp, agents: aa })
    setBusy(false)
    if (r.error || !r.id) { setErr(r.error || 'could not create the room'); return }
    onCreated(r.id)
  }
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col gap-3 px-6 py-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">New room or group message</h2>
          <p className="text-sm text-muted-foreground">Bring people and agents into one conversation. Give it a name to make it a room; leave the name empty for a group message. Agents join in when someone @mentions them.</p>
        </div>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      <div className="relative">
        <Hash className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Room name (optional) — e.g. launch-week" maxLength={60} className="h-9 pl-8 text-sm" />
      </div>
      <Picker people={people.filter((p) => p.id !== me.id)} agents={agents} renderIcon={renderIcon} pickedPeople={pp} pickedAgents={aa} onPeople={setPp} onAgents={setAa} />
      <div className="flex shrink-0 items-center justify-between gap-3">
        <span className="text-xs text-destructive">{err}</span>
        <Button disabled={busy || pp.length + aa.length === 0} onClick={create}>{name.trim() ? 'Create room' : 'Start group message'}{pp.length + aa.length > 0 ? ` · ${pp.length + aa.length + 1}` : ''}</Button>
      </div>
    </div>
  )
}

/** Who is in the room, with add / remove / rename / leave. */
function RoomDetails({ me, room, people, agents, renderIcon, onChanged, onLeft, onClose }: {
  me: Member; room: RoomSummary; people: RoomPerson[]; agents: DmDirectoryAgent[]; renderIcon: IconRenderer
  onChanged: () => void; onLeft: () => void; onClose: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [pp, setPp] = useState<string[]>([])
  const [aa, setAa] = useState<string[]>([])
  const [name, setName] = useState(room.name ?? '')
  const [err, setErr] = useState('')
  const canRemove = room.createdBy === me.id || me.role !== 'member'
  const act = async (fn: () => Promise<{ error?: string }>) => { setErr(''); const r = await fn(); if (r.error) setErr(r.error); else onChanged() }
  const x = (onClick: () => void, label: string) => <button onClick={onClick} title={label} aria-label={label} className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 border-l px-4 py-3">
      <div className="flex items-center justify-between"><span className="text-sm font-semibold">Details</span><Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label="Close details"><X className="h-4 w-4" /></Button></div>
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); act(() => api.roomRename(room.id, name)) }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this room" maxLength={60} className="h-8 text-sm" />
        <Button type="submit" size="sm" variant="outline" className="h-8" disabled={name.trim() === (room.name ?? '')}><Pencil className="h-3.5 w-3.5" /></Button>
      </form>
      {!adding && room.summary && (
        <div className="shrink-0 rounded-lg border bg-muted/30 p-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Workflow className="h-3 w-3" /> So far</div>
          <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{room.summary}</div>
        </div>
      )}
      {!adding && room.agents.length > 0 && (
        <label className="block shrink-0 text-xs text-muted-foreground">
          When nobody is @mentioned, agents
          <select value={room.orchestrate ?? 'auto'} onChange={(e) => act(() => api.roomOrchestrate(room.id, e.target.value as 'auto' | 'suggest' | 'off'))} className="mt-1 block h-8 w-full rounded-md border bg-background px-2 text-sm text-foreground">
            <option value="auto">join in when it's clearly theirs</option>
            <option value="suggest">are suggested — I choose</option>
            <option value="off">stay quiet (only when @mentioned)</option>
          </select>
        </label>
      )}
      {adding ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <Picker people={people.filter((p) => !room.members.some((m) => m.id === p.id))} agents={agents.filter((a) => !room.agents.some((r) => r.id === a.id))} renderIcon={renderIcon} pickedPeople={pp} pickedAgents={aa} onPeople={setPp} onAgents={setAa} />
          <div className="flex shrink-0 gap-2">
            <Button size="sm" className="flex-1" disabled={pp.length + aa.length === 0} onClick={() => act(async () => { const r = await api.roomAdd(room.id, { members: pp, agents: aa }); if (!r.error) { setAdding(false); setPp([]); setAa([]) } return r })}>Add {pp.length + aa.length || ''}</Button>
            <Button size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div className="space-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">People · {room.members.length}</div>
            {room.members.map((p) => (
              <div key={p.id} className="group flex items-center gap-2 rounded px-1 py-1 text-sm">
                <PersonAvatar p={p} className="h-6 w-6 rounded-md text-[10px]" /><span className="min-w-0 flex-1 truncate">{p.name}{p.id === me.id ? ' (you)' : ''}</span>
                {canRemove && p.id !== me.id && x(() => act(() => api.roomRemove(room.id, 'member', p.id)), `Remove ${p.name}`)}
              </div>
            ))}
          </div>
          <div className="space-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Agents · {room.agents.length}</div>
            {room.agents.map((a) => (
              <div key={a.id} className="group flex items-center gap-2 rounded px-1 py-1 text-sm">
                <Avatar agent={a.id} icon={a.icon} renderIcon={renderIcon} size="sm" /><span className="min-w-0 flex-1 truncate">{prettyAgent(a.id)}</span><PresenceDot presence={a.presence} />
                {canRemove && x(() => act(() => api.roomRemove(room.id, 'agent', a.id)), `Remove ${prettyAgent(a.id)}`)}
              </div>
            ))}
            {room.agents.length === 0 && <p className="px-1 text-xs text-muted-foreground">No agents here yet.</p>}
          </div>
          <Button size="sm" variant="outline" className="w-full gap-1" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add people or agents</Button>
        </div>
      )}
      {err && <p className="text-xs text-destructive">{err}</p>}
      {!adding && <Button size="sm" variant="ghost" className="shrink-0 justify-start gap-2 text-destructive hover:text-destructive" onClick={async () => { const r = await api.roomRemove(room.id, 'member', me.id); if (r.error) setErr(r.error); else onLeft() }}><LogOut className="h-3.5 w-3.5" /> Leave</Button>}
    </aside>
  )
}

/** A thread, beside the conversation: the message it hangs off, the replies under it, and a reply box
 *  with everything the main one has — attachments, `/` commands, `@` to bring a room's agent in. */
function ThreadPanel({ view, typing, nameOf, avatarOf, agents, renderIcon, onClose, onSend }: {
  view: ThreadView | null | undefined
  typing: { agent: string; label: string; since?: number }[]
  nameOf: (m: DmMessage) => string
  avatarOf: (m: DmMessage) => ReactNode
  /** The room's agents, for `@` — empty in a DM. */
  agents: MentionTarget[]
  renderIcon: IconRenderer
  onClose: () => void
  onSend: (text: string, files: File[]) => Promise<{ error?: string; notes?: string[] }>
}) {
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState('')
  const [info, setInfo] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [pick, setPick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const count = view?.replies.filter((m) => m.authorKind !== 'system').length ?? 0
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight }, [view?.replies.length, typing.length])
  useEffect(() => { inputRef.current?.focus() }, [view?.root.seq])
  const addFiles = (list: FileList | File[] | null) => { if (list) setFiles((f) => [...f, ...Array.from(list)].slice(0, 6)) }
  const send = async (text: string) => {
    if ((!text.trim() && files.length === 0) || busy) return
    const sending = files
    setBusy(true); setErr(''); setInfo([]); setDraft(''); setFiles([])
    const r = await onSend(text.trim(), sending)
    setBusy(false)
    if (r.error) { setErr(r.error); setDraft(text); setFiles(sending) } else if (r.notes?.length) setInfo(r.notes)
  }
  // One menu at a time: `/` at the very start → commands; `@word` at the end → the room's agents.
  const slash = /^\/([a-z]*)$/i.exec(draft)
  const at = !slash && agents.length ? /(^|\s)@([\w.-]*)$/.exec(draft) : null
  const commands = slash ? COMMANDS.filter((c) => c.name.startsWith(slash[1].toLowerCase())) : []
  const mentions = at ? agents.filter((a) => a.id.includes(at[2].toLowerCase()) || a.title.toLowerCase().includes(at[2].toLowerCase())) : []
  const menu = commands.length || mentions.length
  const choose = (i: number) => {
    if (commands.length) setDraft(`/${commands[i].name} `)
    else if (at) setDraft(`${draft.slice(0, draft.length - at[2].length - 1)}@${mentions[i].id} `)
    setPick(0); inputRef.current?.focus()
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (menu) {
      const i = Math.min(pick, menu - 1)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick((i + (e.key === 'ArrowDown' ? 1 : -1) + menu) % menu); return }
      if (e.key === 'Enter' && !e.shiftKey && commands.length && !commands[i].usage.includes('<')) { e.preventDefault(); send(`/${commands[i].name}`); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); choose(i); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft) }
  }
  const last = view?.replies[view.replies.length - 1]
  return (
    <aside className="flex w-[26rem] shrink-0 flex-col border-l">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold"><MessageSquareReply className="h-4 w-4" /> Thread</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose} aria-label="Close thread"><X className="h-4 w-4" /></Button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
        {view === undefined && <p className="px-4 pt-6 text-center text-sm text-muted-foreground">Loading…</p>}
        {view === null && <p className="px-4 pt-6 text-center text-sm text-muted-foreground">This thread no longer exists.</p>}
        {view && (
          <>
            <MessageRow m={view.root} grouped={false} name={nameOf(view.root)} avatar={avatarOf(view.root)} onAction={view.replies.length === 0 ? (t) => send(t) : undefined} />
            <div className="my-2 flex items-center gap-3 px-5 text-[11px] text-muted-foreground"><span>{count} {count === 1 ? 'reply' : 'replies'}</span><div className="h-px flex-1 bg-border" /></div>
            {view.replies.map((m, i) => {
              if (m.authorKind === 'system') return <div key={m.seq} className="my-2 flex items-center gap-3 px-5 text-[11px] text-muted-foreground"><div className="h-px flex-1 border-t border-dashed" />{m.body}<div className="h-px flex-1 border-t border-dashed" /></div>
              const prev = view.replies[i - 1]
              const grouped = !!prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000
              return <MessageRow key={m.seq} m={m} grouped={grouped} name={nameOf(m)} avatar={avatarOf(m)} onAction={m === last ? (t) => send(t) : undefined} />
            })}
          </>
        )}
      </div>
      <div className="min-h-[1.25rem] shrink-0 px-4">
        {typing.map((t) => <div key={t.agent} className="flex items-center gap-2 pb-1 text-xs text-muted-foreground"><TypingDots /><span><span className="font-medium text-foreground">{prettyAgent(t.agent)}</span> is replying…</span><Elapsed since={t.since} /></div>)}
      </div>
      <div className="relative shrink-0 px-4 pb-4" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files) } }}>
        {menu > 0 && (
          <div className="absolute bottom-full left-4 right-4 z-10 mb-1 overflow-hidden rounded-lg border bg-popover shadow-md">
            {commands.map((c, i) => (
              <button key={c.name} onMouseDown={(e) => { e.preventDefault(); choose(i) }} className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm ${i === Math.min(pick, menu - 1) ? 'bg-muted' : ''}`}>
                <span className="shrink-0 font-mono text-[12px] font-medium">{c.usage}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.help}</span>
              </button>
            ))}
            {!commands.length && mentions.map((a, i) => (
              <button key={a.id} onMouseDown={(e) => { e.preventDefault(); choose(i) }} className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${i === Math.min(pick, menu - 1) ? 'bg-muted' : ''}`}>
                <MentionGlyph t={a} renderIcon={renderIcon} /><span className="min-w-0 flex-1 truncate font-medium">{a.title}</span><span className="shrink-0 font-mono text-[11px] text-muted-foreground">@{a.id}</span>
              </button>
            ))}
          </div>
        )}
        <div className="rounded-xl border bg-background focus-within:border-primary/60">
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2.5 pt-2">
              {files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px]">
                  <Paperclip className="h-3 w-3 text-muted-foreground" />{f.name || 'pasted file'}
                  <button onClick={() => setFiles((x) => x.filter((_, k) => k !== i))} aria-label="Remove attachment" className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
          <div className="flex items-end gap-1 p-1.5">
            <Textarea ref={inputRef} value={draft} onChange={(e) => { setDraft(e.target.value); setPick(0) }} rows={1} placeholder="Reply in thread" onKeyDown={onKey}
              onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); addFiles(fs) } }}
              className="max-h-40 min-h-[36px] resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0" />
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 text-muted-foreground" onClick={() => fileRef.current?.click()} title="Attach files (or paste / drop them)" aria-label="Attach files"><Paperclip className="h-3.5 w-3.5" /></Button>
            <Button size="icon" className="h-7 w-7 shrink-0" disabled={(!draft.trim() && files.length === 0) || busy || !view} onClick={() => send(draft)} aria-label="Send reply"><Send className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        {err && <p className="pt-1 text-xs text-destructive">{err}</p>}
        {info.length > 0 && <div className="mt-1 space-y-0.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">{info.map((n, i) => <div key={i} className="break-words">{n}</div>)}</div>}
      </div>
    </aside>
  )
}

function chime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx(), o = ctx.createOscillator(), g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = 880
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4)
    o.onended = () => { void ctx.close() }
  } catch { /* no audio — fine */ }
}

interface ChatToast { id: number; key: string; title: string; text: string; mention: boolean }

/**
 * App-wide message notifications — mounted once by the console, on every page. Listens to the sidebar
 * the chat socket pushes and, when a conversation gains something you haven't seen, tells you: a toast
 * (click to open), a chime if you turned sound on, and a desktop notification when the tab is in the
 * background. Respects each conversation's level (`all` / `mentions` / `mute`), your toast + sound
 * preferences, and stays quiet about the conversation you are looking at.
 */
export function ChatNotifier({ me, openKey, onOpen, onUnread }: { me: Member; /** the conversation on screen right now ('' = none) */ openKey: string; onOpen: (key: string) => void; onUnread: (n: number) => void }) {
  const [toasts, setToasts] = useState<ChatToast[]>([])
  const prefs = useRef<NotificationPrefs | null>(null)
  const seen = useRef<Map<string, { unread: number; mentions: number }> | null>(null)
  const openRef = useRef(openKey)
  openRef.current = openKey
  const n = useRef(0)
  useEffect(() => { api.notificationPrefs().then((p) => { if (!(p as { error?: string }).error) prefs.current = p }).catch(() => {}) }, [])
  useEffect(() => chatSocket.subscribe((m) => {
    if (m.t !== 'list' || !m.data) return
    const d = m.data as { contacts: DmContact[]; rooms?: RoomSummary[] }
    const rows = [
      ...d.contacts.map((c) => ({ key: c.agent, title: prettyAgent(c.agent), text: c.lastText ?? '', unread: c.unread, mentions: 0, level: c.notify ?? 'all' })),
      ...(d.rooms ?? []).map((r) => ({ key: r.id, title: `${r.lastAuthor ? r.lastAuthor + ' · ' : ''}${r.name ? '#' + r.name : roomTitle(r, me.id)}`, text: r.lastText ?? '', unread: r.unread, mentions: r.mentions ?? 0, level: r.notify ?? 'all' })),
    ]
    const looking = document.visibilityState === 'visible' ? openRef.current : ''
    onUnread(rows.reduce((t, r) => t + (r.key === looking || r.level === 'mute' ? 0 : r.unread), 0))
    const prev = seen.current
    const next = new Map(rows.map((r) => [r.key, { unread: r.unread, mentions: r.mentions }]))
    seen.current = next
    if (!prev) return // the first sidebar is the baseline, not news
    for (const r of rows) {
      const was = prev.get(r.key) ?? { unread: 0, mentions: 0 }
      const mention = r.mentions > was.mentions
      if (r.unread <= was.unread && !mention) continue
      if (r.key === looking || r.level === 'mute' || (r.level === 'mentions' && !mention)) continue
      const p = prefs.current
      if (p?.sound) chime()
      if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        try { const note = new Notification(mention ? `${r.title} mentioned you` : r.title, { body: r.text, tag: `agentric-chat-${r.key}` }); note.onclick = () => { window.focus(); onOpen(r.key); note.close() } } catch { /* blocked */ }
      }
      if (p && !p.toasts) continue
      const id = ++n.current
      setToasts((t) => [...t.filter((x) => x.key !== r.key), { id, key: r.key, title: r.title, text: r.text, mention }].slice(-3))
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000)
    }
  }), [])
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => { onOpen(t.key); setToasts((x) => x.filter((y) => y.id !== t.id)) }} className="pointer-events-auto rounded-xl border bg-popover p-3 text-left shadow-lg transition hover:border-primary">
          <div className="flex items-center gap-1.5 text-sm font-semibold">{t.mention ? <AtSign className="h-3.5 w-3.5 text-destructive" /> : <Bell className="h-3.5 w-3.5 text-muted-foreground" />}<span className="min-w-0 flex-1 truncate">{t.title}</span></div>
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.text}</div>
        </button>
      ))}
    </div>
  )
}

function Conversation({ me, target, messages, people, agents, renderIcon, renderCard, onChanged, onRemoved, onOpenSession, pushed, connected, onTyping, openThread, onThread, notify }: {
  me: Member
  target: Target
  messages: Msg[]
  people: RoomPerson[]
  agents: DmDirectoryAgent[]
  renderIcon: IconRenderer
  renderCard: (m: Msg) => ReactNode
  onChanged: () => void
  onRemoved: () => void
  onOpenSession?: (sessionId: string) => void
  /** The latest thread the chat socket pushed, and whether the socket is up (then polling backs off). */
  pushed: PushedThread | null
  connected: boolean
  /** Tell the others in the room that I'm typing (sent over the socket). */
  onTyping: () => void
  /** The thread panel: which message's thread is open (0 = none), and how to open/close one. */
  openThread: number
  onThread: (seq: number) => void
  /** My notification level for this conversation. */
  notify: NotifyLevel
}) {
  const isRoom = target.kind === 'room'
  const id = isRoom ? target.room.id : target.contact.agent
  const [view, setView] = useState<View | null>(null)
  const [older, setOlder] = useState<DmMessage[]>([])
  const [noMore, setNoMore] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(`dmDraft:${id}`) || '')
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [err, setErr] = useState('')
  const [info, setInfo] = useState<string[]>([])
  const [files, setFiles] = useState<File[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const [details, setDetails] = useState(false)
  const [mention, setMention] = useState<{ q: string; at: number; pick: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true) // stay pinned to the bottom unless the reader scrolled up
  const seq = useRef(0)

  useEffect(() => { localStorage.setItem(`dmDraft:${id}`, draft) }, [id, draft])
  useEffect(() => { inputRef.current?.focus() }, [id])
  // After a mention is inserted the caret belongs right behind it — set synchronously with the new text,
  // or the next keystroke lands at the end of the box instead.
  const caretTo = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (caretTo.current == null) return
    const pos = caretTo.current; caretTo.current = null
    inputRef.current?.focus(); inputRef.current?.setSelectionRange(pos, pos)
  }, [draft])

  // The room as the thread last reported it (fresher than the sidebar's copy).
  const room = isRoom ? view?.room ?? target.room : undefined
  const title = isRoom ? roomTitle(room!, me.id) : prettyAgent(id)
  const live = !!view?.working || outgoing.some((o) => !o.error)
  const load = async () => {
    const read = document.visibilityState === 'visible'
    if (isRoom) {
      const r = await api.roomThread(id, { read, thread: openThread || undefined })
      if (r.error) { if (/not in this room|not found/.test(r.error)) onRemoved(); return }
      setView(roomView(r))
    } else {
      const r = await api.dmThread(id, { read, thread: openThread || undefined })
      if (r.error) return
      setView(dmView(id, r))
    }
  }
  // The socket pushes this conversation's thread whenever it changes — same payload as the fetch above.
  useEffect(() => {
    if (!pushed || pushed.key !== id) return
    if (pushed.error) { if (isRoom && /not in this room|not found/.test(pushed.error)) onRemoved(); return }
    if (pushed.data) setView(isRoom ? roomView(pushed.data as RoomThread) : dmView(id, pushed.data as DmThread))
  }, [pushed])
  // Poll: quick while a reply is on its way (that gap IS the perceived latency), calm otherwise.
  useEffect(() => {
    let stop = false
    const tick = async () => { if (!stop) await load() }
    tick()
    // With the socket up, this is only a safety net.
    const t = setInterval(tick, connected ? 20_000 : live ? 900 : 3000)
    return () => { stop = true; clearInterval(t) }
  }, [id, live, connected, openThread])

  const all = useMemo(() => {
    const server = [...older, ...(view?.messages ?? [])]
    // The socket can deliver the stored message BEFORE the send request returns. An optimistic bubble
    // whose text has already come back from the server is that same message — show it once.
    const landed = (o: Outgoing) => !o.error && server.some((m) => m.authorKind === 'member' && m.authorId === me.id && m.createdAt >= o.at - 3000 && m.body === o.text)
    const mine: DmMessage[] = outgoing.filter((o) => !landed(o)).map((o) => ({ seq: -o.key, authorKind: 'member', authorId: me.id, body: o.text, createdAt: o.at, pending: true }))
    return [...server, ...mine]
  }, [older, view, outgoing, me.id])

  const lastSeq = view?.messages.length ? view.messages[view.messages.length - 1].seq : 0
  const typingSig = (view?.typing ?? []).map((t) => `${t.agent}:${t.label}:${t.steps.length}`).join('|')
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastSeq, outgoing.length, typingSig])
  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const loadOlder = async () => {
    const first = all[0]
    if (!first || first.seq <= 0) return
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const r = isRoom ? await api.roomThread(id, { before: first.seq }) : await api.dmThread(id, { before: first.seq })
    if (r.error) return
    if (r.messages.length === 0) { setNoMore(true); return }
    setOlder((o) => [...r.messages, ...o])
    requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - prevHeight })
  }

  const send = async (text: string, retryKey?: number) => {
    const body = text.trim()
    const sending = retryKey == null ? files : []
    if (!body && sending.length === 0) return
    setErr(''); setInfo([])
    let payload: ChatFile[] | undefined
    if (sending.length) {
      if (sending.reduce((n, f) => n + f.size, 0) > 15 * 1024 * 1024) { setErr('Attachments are too large — 15 MB per message at most.'); return }
      try { payload = await Promise.all(sending.map(readFile)) } catch { setErr('Could not read an attachment.'); return }
      setFiles([])
    }
    // A command is not something you said — don't show it as a pending message.
    const isCommand = /^\/(new|bg|stop|task|remind|status|summary|help)\b/i.test(body)
    const key = retryKey ?? ++seq.current
    if (!isCommand) setOutgoing((o) => [...o.filter((x) => x.key !== key), { key, text: body || '(see attached)', at: Date.now() }])
    stick.current = true
    const r: { error?: string; held?: boolean; notes?: string[] } = isRoom ? await api.roomSend(id, body, payload) : await api.dmSend(id, body, payload)
    if (r.error) {
      // Held = it carried a credential: hand the text back to edit rather than leave a failed bubble.
      if (r.held || isCommand) { setOutgoing((o) => o.filter((x) => x.key !== key)); setDraft(body); setErr(r.error); return }
      setOutgoing((o) => o.map((x) => (x.key === key ? { ...x, error: r.error } : x)))
      return
    }
    if (r.notes?.length) setInfo(r.notes)
    await load()
    setOutgoing((o) => o.filter((x) => x.key !== key))
    onChanged()
  }
  const submit = () => { const t = draft; setDraft(''); setMention(null); send(t) }
  const addFiles = (list: FileList | File[] | null) => { if (list) setFiles((f) => [...f, ...Array.from(list)].slice(0, 6)) }
  const stopNow = async () => { const r = isRoom ? await api.roomStop(id) : await api.dmStop(id); if (r.error) setErr(r.error); load() }
  // "/" at the very start, still on its first word → the command menu.
  const slash = /^\/([a-z]*)$/i.exec(draft)
  const commands = slash ? COMMANDS.filter((c) => c.name.startsWith(slash[1].toLowerCase())) : []
  const [cmdPick, setCmdPick] = useState(0)
  const applyCommand = (name: string) => { setDraft(`/${name} `); setCmdPick(0); inputRef.current?.focus() }

  // @mention autocomplete (rooms): the word being typed at the caret, matched against the room's agents.
  const targets = useMemo(() => mentionTargets(room, me.id), [room, me.id])
  const mentionable = useMemo(() => targets.filter((a) => !mention || a.id.includes(mention.q) || a.title.toLowerCase().includes(mention.q)), [targets, mention?.q])
  const typedAt = useRef(0)
  const onDraft = (value: string, caret: number) => {
    setDraft(value)
    if (!isRoom) return
    // At most one "typing" signal every 2.5 s, and none for an emptied box or a command.
    if (value.trim() && !value.startsWith('/') && Date.now() - typedAt.current > 2500) { typedAt.current = Date.now(); onTyping() }
    const m = /(^|\s)@([\w.-]*)$/.exec(value.slice(0, caret))
    setMention(m ? { q: m[2].toLowerCase(), at: caret - m[2].length - 1, pick: 0 } : null)
  }
  const applyMention = (agentId: string) => {
    if (!mention) return
    const el = inputRef.current
    const caret = el?.selectionStart ?? draft.length
    const next = `${draft.slice(0, mention.at)}@${agentId} ${draft.slice(caret)}`
    caretTo.current = mention.at + agentId.length + 2
    setDraft(next); setMention(null)
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (commands.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setCmdPick((p) => (p + (e.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length); return }
      const c = commands[Math.min(cmdPick, commands.length - 1)]
      // Enter on a command that needs nothing more runs it; otherwise it is completed for typing.
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && c.usage.includes('<'))) { e.preventDefault(); applyCommand(c.name); return }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setDraft(''); send(`/${c.name}`); return }
    }
    if (mention && mentionable.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const d = e.key === 'ArrowDown' ? 1 : -1; setMention({ ...mention, pick: (mention.pick + d + mentionable.length) % mentionable.length }); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionable[Math.min(mention.pick, mentionable.length - 1)].id); return }
      if (e.key === 'Escape') { setMention(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const sessionIds = view?.sessionIds ?? []
  // Quick replies are offered only on the newest message, and not once I've started answering.
  const newestSeq = outgoing.length === 0 && all.length ? all[all.length - 1].seq : 0
  // Everything in the stream, in the order it happened: what was said, the cards the conversation's
  // sessions raised (approvals, questions, deliverables, proposals) and the hand-offs its agent made.
  type Item = { at: number; key: string; msg?: DmMessage; card?: Msg; handoff?: DmHandoff }
  const stream = useMemo(() => {
    const ids = new Set(view?.cardSessionIds ?? [])
    // A deliverable already drawn under the message that produced it doesn't need its card as well.
    const shown = new Set(all.flatMap((m) => (m.artifacts ?? []).map((a) => a.id)))
    const first = all.find((m) => m.seq > 0)?.createdAt ?? 0
    const items: Item[] = all.map((m) => ({ at: m.pending ? Number.MAX_SAFE_INTEGER - 1000 + -m.seq : m.createdAt, key: `m${m.seq}`, msg: m }))
    // Cards older than the loaded page would all pile up at the top — leave them to "Load earlier".
    for (const c of messages) if (ids.has(c.sessionId) && c.createdAt >= first && !(c.type === 'artifact' && shown.has(String((c.args as { artifactId?: string } | undefined)?.artifactId)))) items.push({ at: c.createdAt, key: `c${c.id}`, card: c })
    for (const h of view?.handoffs ?? []) items.push({ at: h.createdAt, key: `h${h.sessionId}`, handoff: h })
    return items.sort((a, b) => a.at - b.at)
  }, [all, messages, view?.cardSessionIds, view?.handoffs])
  const presence: DmPresence = isRoom ? 'away' : view ? (view.working ? 'working' : sessionIds.length && target.contact.presence !== 'away' ? 'online' : target.contact.presence) : target.contact.presence
  const iconOf = (agentId: string, hint?: string) => hint ?? (isRoom ? room!.agents.find((a) => a.id === agentId)?.icon : target.contact.icon)
  const nameOf = (m: DmMessage) => (m.authorKind === 'agent' ? m.authorName ?? prettyAgent(m.authorId) : m.authorId === me.id ? me.name || 'You' : m.authorName ?? 'Someone')
  const avatarOf = (m: DmMessage) => m.authorKind === 'agent' && m.authorId === 'orchestrator'
    ? <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Workflow className="h-5 w-5" /></span>
    : m.authorKind === 'agent'
    ? <Avatar agent={m.authorId} icon={iconOf(m.authorId, m.authorIcon)} renderIcon={renderIcon} />
    : <PersonAvatar p={m.authorId === me.id ? { name: me.name || me.email, avatar: me.avatar } : { name: m.authorName ?? '?', avatar: m.authorAvatar }} />
  const description = isRoom ? '' : target.contact.description

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b px-5 py-2.5">
          {isRoom ? <RoomGlyph room={room!} size="sm" /> : <Avatar agent={id} icon={target.contact.icon} renderIcon={renderIcon} size="sm" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{title}</span>
              {!isRoom && <><PresenceDot presence={presence} /><span className="text-[11px] text-muted-foreground">{presence === 'working' ? 'Working' : presence === 'online' ? 'Active' : 'Away'}</span></>}
            </div>
            {isRoom
              ? <button onClick={() => setDetails((d) => !d)} className="truncate text-[11px] text-muted-foreground hover:text-foreground hover:underline">{room!.members.length} {room!.members.length === 1 ? 'person' : 'people'}{room!.agents.length ? ` · ${room!.agents.length} agent${room!.agents.length === 1 ? '' : 's'}` : ''}</button>
              : <div className="truncate text-[11px] text-muted-foreground">{description}</div>}
          </div>
          {isRoom && <Button size="sm" variant="ghost" className="h-7 shrink-0 gap-1.5 text-xs text-muted-foreground" onClick={() => setDetails((d) => !d)}><Users className="h-3.5 w-3.5" /> {room!.members.length + room!.agents.length}</Button>}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Conversation options" />}>
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => send('/new')}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" /> New session (or type /new)
              </DropdownMenuItem>
              {isRoom ? (
                <DropdownMenuItem onClick={() => setDetails(true)}><Users className="mr-2 h-3.5 w-3.5" /> People and agents</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={async () => { await api.dmRemoveContact(id); onRemoved() }}>
                  <UserMinus className="mr-2 h-3.5 w-3.5" /> Remove from contacts
                </DropdownMenuItem>
              )}
              {(['all', 'mentions', 'mute'] as NotifyLevel[]).map((lv) => (
                <DropdownMenuItem key={lv} onClick={async () => { await api.chatNotify(id, lv); onChanged() }}>
                  {lv === 'mute' ? <BellOff className="mr-2 h-3.5 w-3.5" /> : lv === 'mentions' ? <AtSign className="mr-2 h-3.5 w-3.5" /> : <Bell className="mr-2 h-3.5 w-3.5" />}
                  {lv === 'all' ? 'Notify me: every message' : lv === 'mentions' ? 'Notify me: only @mentions' : 'Mute this conversation'}{notify === lv ? '  ✓' : ''}
                </DropdownMenuItem>
              ))}
              {onOpenSession && sessionIds.map((sid, i) => (
                <DropdownMenuItem key={sid} onClick={() => onOpenSession(sid)}>
                  <TerminalSquare className="mr-2 h-3.5 w-3.5" /> Open the session behind this{sessionIds.length > 1 ? ` (${i + 1})` : ''}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pb-3">
          {view && all.length >= 100 && !noMore && (
            <div className="py-2 text-center"><button onClick={loadOlder} className="text-xs text-primary hover:underline">Load earlier messages</button></div>
          )}
          {view && (noMore || all.length < 100) && (
            <div className="px-5 pb-2 pt-8">
              {isRoom ? <RoomGlyph room={room!} size="lg" /> : <Avatar agent={id} icon={target.contact.icon} renderIcon={renderIcon} size="lg" />}
              <h3 className="mt-3 text-lg font-semibold">{title}</h3>
              <p className="max-w-xl text-sm text-muted-foreground">
                {isRoom
                  ? <>This is the start of {room!.name ? <>the <span className="font-medium text-foreground">{room!.name}</span> room</> : 'this group conversation'}. {room!.agents.length > 0 ? <>Type <kbd className="rounded border px-1 font-sans text-xs">@</kbd> to bring an agent in — they answer only when addressed.</> : 'Add an agent from the people list to bring one in.'}</>
                  : <>This is the start of your conversation with <span className="font-medium text-foreground">{title}</span>.</>}
              </p>
            </div>
          )}
          {stream.map((it, i) => {
            if (it.card) { const node = renderCard(it.card); return node ? <div key={it.key} className="px-5 py-1.5 pl-[4.25rem]">{node}</div> : null }
            if (it.handoff) return <div key={it.key} className="px-5 py-1.5 pl-[4.25rem]"><HandoffCard h={it.handoff} renderIcon={renderIcon} onOpenSession={onOpenSession} /></div>
            const m = it.msg!
            // Group with the previous MESSAGE only when nothing (a card, a hand-off) came between them.
            const before = stream[i - 1]
            const prev = before?.msg
            let j = i - 1
            while (j >= 0 && !stream[j].msg) j--
            const lastMsg = j >= 0 ? stream[j].msg : undefined
            const newDay = !lastMsg || !sameDay(lastMsg.createdAt, m.createdAt)
            const grouped = !newDay && !!prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000
            const failed = m.pending ? outgoing.find((o) => -o.key === m.seq)?.error : undefined
            return (
              <div key={it.key}>
                {newDay && (
                  <div className="relative my-3 flex items-center px-5">
                    <div className="h-px flex-1 bg-border" />
                    <span className="mx-3 rounded-full border bg-background px-3 py-0.5 text-[11px] font-medium text-muted-foreground">{dayLabel(m.createdAt)}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {m.authorKind === 'system' ? (
                  <div className="my-3 flex items-center gap-3 px-5 text-[11px] text-muted-foreground">
                    <div className="h-px flex-1 border-t border-dashed" />{m.body === 'New session' && <RotateCcw className="h-3 w-3" />} {m.body} · {clock(m.createdAt)}
                    {m.actions && m.seq === newestSeq && m.actions.map((a, k) => <button key={k} onClick={() => send(a)} className="rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5 font-medium text-primary hover:bg-primary hover:text-primary-foreground">{a.split(' ')[0]}</button>)}
                    <div className="h-px flex-1 border-t border-dashed" />
                  </div>
                ) : <MessageRow m={m} grouped={grouped} name={nameOf(m)} avatar={avatarOf(m)} onThread={m.seq > 0 ? () => onThread(m.seq) : undefined} onAction={m.seq === newestSeq && !m.replies ? (t) => send(t) : undefined} replying={(view?.typing ?? []).filter((t) => t.thread === m.seq).map((t) => t.agent)} />}
                {failed && (
                  <div className="flex items-center gap-2 pl-[4.25rem] text-xs text-destructive">
                    <CircleAlert className="h-3.5 w-3.5" /> {failed}
                    <button className="font-medium underline" onClick={() => send(m.body, -m.seq)}>Retry</button>
                    <button className="text-muted-foreground underline" onClick={() => setOutgoing((o) => o.filter((x) => -x.key !== m.seq))}>Discard</button>
                  </div>
                )}
              </div>
            )
          })}
          {view?.stalled && outgoing.length === 0 && (
            <div className="flex items-center gap-2 pl-[4.25rem] pt-1 text-xs text-muted-foreground">
              <CircleAlert className="h-3.5 w-3.5 text-amber-500" /> {title} didn’t pick that up.
              <button className="font-medium text-primary hover:underline" onClick={async () => { const r = await api.dmRetry(id); if (r.error) setErr(r.error); load() }}>Try again</button>
            </div>
          )}
        </div>

        {/* What is in flight: background runs and reminders, then who is typing (with a way to stop them) */}
        <div className="min-h-[1.5rem] shrink-0 px-5">
          {(view?.jobs ?? []).map((j) => (
            <div key={j.id} className="mb-1 flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
              {j.kind === 'remind' ? <Clock className="h-3.5 w-3.5 shrink-0" /> : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              <span className="min-w-0 flex-1 truncate">
                {j.kind === 'fanout' ? <>Waiting for <span className="font-medium text-foreground">{j.agent.split(',').map(prettyAgent).join(' and ')}</span> — their answers will be combined into one</> : j.kind === 'bg' ? <><span className="font-medium text-foreground">{prettyAgent(j.agent)}</span> is working in the background · {ago(j.createdAt)} — {j.request}</> : <>Reminder {j.dueAt ? new Date(j.dueAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''} — {j.request}</>}
              </span>
              <button className="shrink-0 hover:text-foreground hover:underline" onClick={async () => { const r = await api.chatJobCancel(j.id); if (r.error) setErr(r.error); load() }}>Cancel</button>
            </div>
          ))}
          {(view?.peopleTyping.length ?? 0) > 0 && (
            <div className="flex items-center gap-2 pb-1 text-xs text-muted-foreground">
              <TypingDots />
              <span><span className="font-medium text-foreground">{view!.peopleTyping.slice(0, 3).join(', ')}{view!.peopleTyping.length > 3 ? ` and ${view!.peopleTyping.length - 3} more` : ''}</span> {view!.peopleTyping.length === 1 ? 'is' : 'are'} typing…</span>
            </div>
          )}
          {(view?.typing ?? []).filter((t) => !t.thread).map((t, i) => (
            <div key={t.agent} className="pb-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TypingDots />
                <span><span className="font-medium text-foreground">{prettyAgent(t.agent)}</span> is {t.label === 'Writing' ? 'writing…' : t.label === 'Thinking' ? 'thinking…' : 'working on it…'}</span>
                <Elapsed since={t.since} />
                {i === 0 && <button onClick={stopNow} className="ml-1 inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] hover:bg-muted hover:text-foreground" title="Stop what the agent is doing (the conversation stays)"><Square className="h-2.5 w-2.5 fill-current" /> Stop</button>}
              </div>
              <Steps steps={t.steps} live />
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="relative shrink-0 px-5 pb-4" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files) } }}>
          {commands.length > 0 && (
            <div className="absolute bottom-full left-5 z-10 mb-1 w-96 overflow-hidden rounded-lg border bg-popover shadow-md">
              {commands.map((c, i) => (
                <button key={c.name} onMouseDown={(e) => { e.preventDefault(); applyCommand(c.name) }} className={`flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm ${i === Math.min(cmdPick, commands.length - 1) ? 'bg-muted' : ''}`}>
                  <span className="shrink-0 font-mono text-[12px] font-medium">{c.usage}</span><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.help}</span>
                </button>
              ))}
            </div>
          )}
          {mention && mentionable.length > 0 && (
            <div className="absolute bottom-full left-5 z-10 mb-1 w-72 overflow-hidden rounded-lg border bg-popover shadow-md">
              {mentionable.map((a, i) => (
                <button key={a.id} onMouseDown={(e) => { e.preventDefault(); applyMention(a.id) }} className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${i === Math.min(mention.pick, mentionable.length - 1) ? 'bg-muted' : ''}`}>
                  <MentionGlyph t={a} renderIcon={renderIcon} /><span className="min-w-0 flex-1 truncate font-medium">{a.title}</span><span className="shrink-0 font-mono text-[11px] text-muted-foreground">@{a.id}</span>
                </button>
              ))}
            </div>
          )}
          <div className="rounded-xl border bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1 px-2.5 pt-2">
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px]">
                    <Paperclip className="h-3 w-3 text-muted-foreground" />{f.name || 'pasted file'}
                    <button onClick={() => setFiles((x) => x.filter((_, k) => k !== i))} aria-label="Remove attachment" className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            <Textarea
              onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); addFiles(fs) } }}
              ref={inputRef}
              value={draft}
              onChange={(e) => onDraft(e.target.value, e.target.selectionStart ?? e.target.value.length)}
              onKeyDown={onKey}
              onBlur={() => setMention(null)}
              placeholder={isRoom ? `Message ${room!.name ? '#' + room!.name : title}` : `Message ${title}`}
              rows={1}
              className="max-h-48 min-h-[44px] resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between px-2 pb-1.5">
              <span className="pl-1 text-[10px] text-muted-foreground"><kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line{isRoom ? <> · <kbd className="font-sans">@</kbd> to mention someone</> : null} · <kbd className="font-sans">/</kbd> for commands</span>
              <span className="flex shrink-0 items-center gap-1">
                <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" onClick={() => fileRef.current?.click()} title="Attach files (or paste / drop them)" aria-label="Attach files"><Paperclip className="h-3.5 w-3.5" /></Button>
                <Button size="icon" className="h-7 w-7" disabled={!draft.trim() && files.length === 0} onClick={submit} aria-label="Send"><Send className="h-3.5 w-3.5" /></Button>
              </span>
            </div>
          </div>
          {err && <p className="pt-1 text-xs text-destructive">{err}</p>}
          {info.length > 0 && (
            <div className="mt-1 flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1 space-y-0.5">{info.map((n, i) => <div key={i} className="break-words">{n}</div>)}</div>
              <button onClick={() => setInfo([])} aria-label="Dismiss" className="shrink-0 hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
        </div>
      </div>
      {openThread > 0 && (
        <ThreadPanel
          view={view?.threadView} typing={(view?.typing ?? []).filter((t) => t.thread === openThread)} nameOf={nameOf} avatarOf={avatarOf}
          onClose={() => onThread(0)}
          agents={targets} renderIcon={renderIcon}
          onSend={async (text, attached) => {
            let payload: ChatFile[] | undefined
            if (attached.length) {
              if (attached.reduce((n, f) => n + f.size, 0) > 15 * 1024 * 1024) return { error: 'Attachments are too large — 15 MB per message at most.' }
              try { payload = await Promise.all(attached.map(readFile)) } catch { return { error: 'Could not read an attachment.' } }
            }
            const r: { error?: string; notes?: string[] } = isRoom ? await api.roomSend(id, text, payload, openThread) : await api.dmSend(id, text, payload, openThread)
            if (!r.error) { await load(); onChanged() }
            return r
          }}
        />
      )}
      {isRoom && details && openThread === 0 && <RoomDetails me={me} room={room!} people={people} agents={agents} renderIcon={renderIcon} onChanged={() => { load(); onChanged() }} onLeft={onRemoved} onClose={() => setDetails(false)} />}
    </div>
  )
}

export function MessagesPage({ me, selected, onSelect, messages, renderIcon, renderCard, onUnread, onOpenSession }: {
  me: Member
  /** The open conversation: an agent id (DM), a `room_…` id, or '' / 'add' / 'new-room'. */
  selected: string
  onSelect: (key: string) => void
  /** The console's inbox feed — pending approvals/questions of the open conversation are shown inline. */
  messages: Msg[]
  renderIcon: IconRenderer
  /** Render an inbox message as a card inside the conversation — null when it doesn't belong there. */
  renderCard: (m: Msg) => ReactNode
  onUnread?: (n: number) => void
  /** Owner/admin escape hatch: open the governed session behind a conversation. */
  onOpenSession?: (sessionId: string) => void
}) {
  const [contacts, setContacts] = useState<DmContact[] | null>(null)
  const [directory, setDirectory] = useState<DmDirectoryAgent[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [people, setPeople] = useState<RoomPerson[]>([])
  const [filter, setFilter] = useState('')

  type ListData = { contacts: DmContact[]; directory: DmDirectoryAgent[]; rooms?: RoomSummary[]; people?: RoomPerson[] }
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const applyList = (r: ListData) => {
    setContacts(r.contacts); setDirectory(r.directory); setRooms(r.rooms ?? []); setPeople(r.people ?? [])
    const open = selectedRef.current
    onUnread?.(r.contacts.reduce((n, c) => n + (c.agent === open ? 0 : c.unread), 0) + (r.rooms ?? []).reduce((n, c) => n + (c.id === open ? 0 : c.unread), 0))
  }
  const refresh = async () => { const r = await api.dmList(); if (!r.error) applyList(r) }

  // The chat socket (shared with the app-wide notifier): the server pushes the sidebar and the open
  // conversation when they change. If it can't connect (a proxy that drops upgrades) the page simply
  // keeps polling, as it always did.
  const [connected, setConnected] = useState(chatSocket.isConnected())
  const [pushed, setPushed] = useState<PushedThread | null>(null)
  const [openThread, setOpenThread] = useState(0)
  const watchKey = selected && selected !== 'add' && selected !== 'new-room' ? selected : ''
  useEffect(() => {
    const offStatus = chatSocket.onStatus(setConnected)
    const off = chatSocket.subscribe((m) => {
      if (m.t === 'list' && m.data) applyList(m.data as ListData)
      else if (m.t === 'thread' && m.key) setPushed({ key: m.key, data: m.data as PushedThread['data'], error: m.error })
    })
    return () => { off(); offStatus(); chatSocket.watch('') }
  }, [])
  useEffect(() => { setOpenThread(0) }, [watchKey])
  useEffect(() => { chatSocket.watch(watchKey, openThread) }, [watchKey, openThread, connected])
  const sayTyping = () => chatSocket.typing()

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, connected ? 30_000 : 4000)
    return () => clearInterval(t)
  }, [selected, connected])

  const [desktop, setDesktop] = useState<NotificationPermission | 'unsupported'>(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const adding = selected === 'add'
  const creating = selected === 'new-room'
  const activeContact = contacts?.find((c) => c.agent === selected)
  const activeRoom = rooms.find((r) => r.id === selected)
  // Every agent this member can talk to — the pool a room can draw from.
  const allAgents = useMemo<DmDirectoryAgent[]>(
    () => [...(contacts ?? []).map((c) => ({ id: c.agent, description: c.description, icon: c.icon })), ...directory].sort((a, b) => a.id.localeCompare(b.id)),
    [contacts, directory],
  )
  // First visit lands on the most recent conversation, the way a chat app reopens where you left off.
  useEffect(() => {
    if (selected || !contacts) return
    const latest = [...contacts.map((c) => ({ key: c.agent, at: c.lastAt })), ...rooms.map((r) => ({ key: r.id, at: r.lastAt }))].sort((a, b) => b.at - a.at)[0]
    if (latest) onSelect(latest.key)
  }, [selected, contacts, rooms])

  const add = async (agent: string) => {
    const r = await api.dmAddContact(agent)
    if (r.error) return
    await refresh()
    onSelect(agent)
  }

  const f = filter.trim().toLowerCase()
  const named = rooms.filter((r) => r.name && (!f || r.name.toLowerCase().includes(f)))
  // Direct messages = agent contacts + unnamed groups, most recent first.
  type Row = { key: string; at: number; contact?: DmContact; room?: RoomSummary }
  const direct: Row[] = [
    ...(contacts ?? []).filter((c) => !f || prettyAgent(c.agent).toLowerCase().includes(f)).map((c) => ({ key: c.agent, at: c.lastAt, contact: c })),
    ...rooms.filter((r) => !r.name && (!f || roomTitle(r, me.id).toLowerCase().includes(f))).map((r) => ({ key: r.id, at: r.lastAt, room: r })),
  ].sort((a, b) => b.at - a.at)
  const total = (contacts?.length ?? 0) + rooms.length

  const item = (key: string, glyph: ReactNode, title: string, preview: ReactNode, at: number, unreadCount: number, hasPreview: boolean, level: NotifyLevel = 'all', mentions = 0) => {
    const on = key === selected
    const unread = !on && unreadCount > 0
    return (
      <button key={key} onClick={() => onSelect(key)} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted ${on ? 'bg-muted' : ''}`}>
        {glyph}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1">
            <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-semibold' : 'font-medium'}`}>{title}</span>
            {hasPreview && <span className="shrink-0 text-[10px] text-muted-foreground">{shortWhen(at)}</span>}
          </span>
          <span className="flex items-center gap-1">
            <span className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>{preview}</span>
            {level === 'mute' && <BellOff className="h-3 w-3 shrink-0 text-muted-foreground/70" />}
            {!on && mentions > 0 && <span className="flex h-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">@{mentions}</span>}
            {unread && level !== 'mute' && mentions === 0 && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{unreadCount}</span>}
          </span>
        </span>
      </button>
    )
  }
  const roomItem = (r: RoomSummary) => item(r.id, <RoomGlyph room={r} />, roomTitle(r, me.id),
    r.agents.some((a) => a.presence === 'working') ? <span className="italic">working…</span> : r.lastText ? `${r.lastAuthor ? r.lastAuthor + ': ' : ''}${r.lastText}` : `${r.members.length + r.agents.length} in here`,
    r.lastAt, r.unread, !!r.lastText, r.notify ?? 'all', r.mentions ?? 0)
  const sectionHead = (label: string, onPlus: () => void, plusTitle: string) => (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onPlus} title={plusTitle} aria-label={plusTitle}><Plus className="h-4 w-4" /></Button>
    </div>
  )

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar: rooms, then direct messages */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        {total > 7 && <div className="px-2 pt-2"><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a conversation" className="h-7 text-xs" /></div>}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {sectionHead('Rooms', () => onSelect('new-room'), 'New room or group message')}
          <div className="space-y-0.5 px-2">
            {named.map(roomItem)}
            {named.length === 0 && <button onClick={() => onSelect('new-room')} className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Create a room for people and agents to work in together.</button>}
          </div>
          {sectionHead('Direct messages', () => onSelect('add'), 'Add a teammate')}
          <div className="space-y-0.5 px-2">
            {direct.map((d) => d.contact
              ? item(d.contact.agent, <Avatar agent={d.contact.agent} icon={d.contact.icon} renderIcon={renderIcon} presence={d.contact.presence} />, prettyAgent(d.contact.agent),
                  d.contact.presence === 'working' ? <span className="italic">working…</span> : d.contact.lastText ? `${d.contact.lastFromMe ? 'You: ' : ''}${d.contact.lastText}` : 'Say hello',
                  d.contact.lastAt, d.contact.unread, !!d.contact.lastText, d.contact.notify ?? 'all')
              : roomItem(d.room!))}
            {contacts && direct.length === 0 && <p className="px-2 pt-1 text-xs text-muted-foreground">No contacts yet. Add an agent to start talking.</p>}
            <button onClick={() => onSelect('add')} className={`mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground ${adding ? 'bg-muted text-foreground' : ''}`}>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed"><Plus className="h-4 w-4" /></span>
              Add teammates
            </button>
          </div>
        </div>
        {desktop === 'default' && (
          <button onClick={async () => setDesktop(await Notification.requestPermission())} className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Bell className="h-3.5 w-3.5 shrink-0" /> Turn on desktop notifications
          </button>
        )}
      </aside>

      {/* Conversation / directory / new room */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating ? (
          <NewRoom me={me} people={people} agents={allAgents} renderIcon={renderIcon} onCreated={async (id) => { await refresh(); onSelect(id) }} onClose={() => onSelect('')} />
        ) : activeRoom ? (
          <Conversation key={activeRoom.id} notify={activeRoom.notify ?? 'all'} me={me} target={{ kind: 'room', room: activeRoom }} messages={messages} people={people} agents={allAgents} renderIcon={renderIcon} renderCard={renderCard} pushed={pushed} connected={connected} onTyping={sayTyping} openThread={openThread} onThread={setOpenThread} onOpenSession={onOpenSession} onChanged={refresh} onRemoved={async () => { await refresh(); onSelect('') }} />
        ) : activeContact && !adding ? (
          <Conversation key={activeContact.agent} notify={activeContact.notify ?? 'all'} me={me} target={{ kind: 'dm', contact: activeContact }} messages={messages} people={people} agents={allAgents} renderIcon={renderIcon} renderCard={renderCard} pushed={pushed} connected={connected} onTyping={sayTyping} openThread={openThread} onThread={setOpenThread} onOpenSession={onOpenSession} onChanged={refresh} onRemoved={async () => { await refresh(); onSelect('') }} />
        ) : contacts === null ? (
          <p className="pt-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : selected && isRoomId(selected) ? (
          <p className="pt-24 text-center text-sm text-muted-foreground">This room no longer exists, or you’re not in it.</p>
        ) : selected && !adding ? (
          // A deep link to an agent that isn't a contact yet: offer the add in place.
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 pt-24 text-center">
            <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{prettyAgent(selected)}</span> isn’t in your contacts.</p>
            {directory.some((a) => a.id === selected)
              ? <Button size="sm" onClick={() => add(selected)}><Check className="mr-1 h-3.5 w-3.5" /> Add and start chatting</Button>
              : <Button size="sm" variant="outline" onClick={() => onSelect('add')}>Browse teammates</Button>}
          </div>
        ) : (
          <Directory agents={directory} renderIcon={renderIcon} onAdd={add} hasContacts={contacts.length > 0} onClose={total > 0 ? () => onSelect('') : undefined} />
        )}
      </section>
    </div>
  )
}
