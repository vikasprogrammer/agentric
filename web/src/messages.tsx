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
import { ChevronRight, MoreHorizontal, TerminalSquare, Hash, Users, LogOut, Pencil, Plus, Search, Send, UserMinus, RotateCcw, Check, X, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api, type DmContact, type DmDirectoryAgent, type DmMessage, type DmPresence, type DmStep, type Member, type Msg, type RoomPerson, type RoomSummary } from '@/lib/api'

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
function Steps({ steps, live = false }: { steps: DmStep[]; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const done = steps.filter((s) => s.t === 'do')
  if (steps.length === 0) return null
  const failed = done.filter((s) => s.status === 'error').length
  return (
    <div className="mt-1">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {live ? 'Show progress' : `${done.length || steps.length} step${(done.length || steps.length) === 1 ? '' : 's'}`}
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

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 150, 300].map((d) => <span key={d} className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />)}
    </span>
  )
}

/** One row of the conversation. Consecutive messages from the same author within a few minutes are
 *  GROUPED: only the first carries the avatar + name, the rest sit flush under it with a hover time. */
function MessageRow({ m, grouped, name, avatar }: { m: DmMessage; grouped: boolean; name: string; avatar: ReactNode }) {
  const body = m.authorKind === 'agent'
    ? <div className="md max-w-none text-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown></div>
    : <div className="whitespace-pre-wrap break-words text-sm">{m.body}</div>
  return (
    <div className={`group flex gap-3 px-5 hover:bg-muted/40 ${grouped ? 'py-0.5' : 'pb-0.5 pt-2'} ${m.pending ? 'opacity-60' : ''}`}>
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
        {body}
        {m.steps && <Steps steps={m.steps} />}
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
  typing: { agent: string; label: string; steps: DmStep[] }[]
  sessionIds: string[]
  stalled: boolean
  working: boolean
  room?: RoomSummary
}

const isRoomId = (s: string): boolean => s.startsWith('room_')
/** A room's display name: its own, or — for an unnamed group — everyone in it but you. */
function roomTitle(r: RoomSummary, meId: string): string {
  if (r.name) return r.name
  const names = [...r.members.filter((m) => m.id !== meId).map((m) => m.name.split(' ')[0]), ...r.agents.map((a) => prettyAgent(a.id))]
  return names.join(', ') || 'Just you'
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

function Conversation({ me, target, messages, people, agents, renderIcon, renderPending, onChanged, onRemoved, onOpenSession }: {
  me: Member
  target: Target
  messages: Msg[]
  people: RoomPerson[]
  agents: DmDirectoryAgent[]
  renderIcon: IconRenderer
  renderPending: (m: Msg) => ReactNode
  onChanged: () => void
  onRemoved: () => void
  onOpenSession?: (sessionId: string) => void
}) {
  const isRoom = target.kind === 'room'
  const id = isRoom ? target.room.id : target.contact.agent
  const [view, setView] = useState<View | null>(null)
  const [older, setOlder] = useState<DmMessage[]>([])
  const [noMore, setNoMore] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(`dmDraft:${id}`) || '')
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [err, setErr] = useState('')
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
      const r = await api.roomThread(id, { read })
      if (r.error) { if (/not in this room|not found/.test(r.error)) onRemoved(); return }
      setView({ messages: r.messages, typing: r.typing, sessionIds: r.sessionIds, stalled: false, working: r.typing.length > 0, room: r.room })
    } else {
      const r = await api.dmThread(id, { read })
      if (r.error) return
      setView({ messages: r.messages, typing: r.typing ? [{ agent: id, ...r.typing }] : [], sessionIds: r.sessionId ? [r.sessionId] : [], stalled: !!r.stalled, working: r.presence === 'working' })
    }
  }
  // Poll: quick while a reply is on its way (that gap IS the perceived latency), calm otherwise.
  useEffect(() => {
    let stop = false
    const tick = async () => { if (!stop) await load() }
    tick()
    const t = setInterval(tick, live ? 900 : 3000)
    return () => { stop = true; clearInterval(t) }
  }, [id, live])

  const all = useMemo(() => {
    const server = [...older, ...(view?.messages ?? [])]
    const mine: DmMessage[] = outgoing.map((o) => ({ seq: -o.key, authorKind: 'member', authorId: me.id, body: o.text, createdAt: o.at, pending: true }))
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
    if (!body) return
    setErr('')
    const key = retryKey ?? ++seq.current
    setOutgoing((o) => [...o.filter((x) => x.key !== key), { key, text: body, at: Date.now() }])
    stick.current = true
    const r: { error?: string; held?: boolean; notes?: string[] } = isRoom ? await api.roomSend(id, body) : await api.dmSend(id, body)
    if (r.error) {
      // Held = it carried a credential: hand the text back to edit rather than leave a failed bubble.
      if (r.held) { setOutgoing((o) => o.filter((x) => x.key !== key)); setDraft(body); setErr(r.error); return }
      setOutgoing((o) => o.map((x) => (x.key === key ? { ...x, error: r.error } : x)))
      return
    }
    if (r.notes?.length) setErr(r.notes.join(' '))
    await load()
    setOutgoing((o) => o.filter((x) => x.key !== key))
    onChanged()
  }
  const submit = () => { const t = draft; setDraft(''); setMention(null); send(t) }

  // @mention autocomplete (rooms): the word being typed at the caret, matched against the room's agents.
  const mentionable = useMemo(() => (room?.agents ?? []).filter((a) => !mention || a.id.toLowerCase().includes(mention.q) || prettyAgent(a.id).toLowerCase().includes(mention.q)), [room, mention?.q])
  const onDraft = (value: string, caret: number) => {
    setDraft(value)
    if (!isRoom) return
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
    if (mention && mentionable.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const d = e.key === 'ArrowDown' ? 1 : -1; setMention({ ...mention, pick: (mention.pick + d + mentionable.length) % mentionable.length }); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionable[Math.min(mention.pick, mentionable.length - 1)].id); return }
      if (e.key === 'Escape') { setMention(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const sessionIds = view?.sessionIds ?? []
  const pending = messages.filter((m) => sessionIds.includes(m.sessionId) && (m.type === 'approval' || m.type === 'question') && (m.status ?? 'pending') === 'pending')
  const presence: DmPresence = isRoom ? 'away' : view ? (view.working ? 'working' : sessionIds.length && target.contact.presence !== 'away' ? 'online' : target.contact.presence) : target.contact.presence
  const iconOf = (agentId: string, hint?: string) => hint ?? (isRoom ? room!.agents.find((a) => a.id === agentId)?.icon : target.contact.icon)
  const nameOf = (m: DmMessage) => (m.authorKind === 'agent' ? m.authorName ?? prettyAgent(m.authorId) : m.authorId === me.id ? me.name || 'You' : m.authorName ?? 'Someone')
  const avatarOf = (m: DmMessage) => m.authorKind === 'agent'
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
                  : <>This is the start of your conversation with <span className="font-medium text-foreground">{title}</span>. {description}</>}
              </p>
            </div>
          )}
          {all.map((m, i) => {
            const prev = all[i - 1]
            const newDay = !prev || !sameDay(prev.createdAt, m.createdAt)
            const grouped = !newDay && !!prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000
            const failed = m.pending ? outgoing.find((o) => -o.key === m.seq)?.error : undefined
            return (
              <div key={m.seq}>
                {newDay && (
                  <div className="relative my-3 flex items-center px-5">
                    <div className="h-px flex-1 bg-border" />
                    <span className="mx-3 rounded-full border bg-background px-3 py-0.5 text-[11px] font-medium text-muted-foreground">{dayLabel(m.createdAt)}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {m.authorKind === 'system' ? (
                  <div className="my-3 flex items-center gap-3 px-5 text-[11px] text-muted-foreground">
                    <div className="h-px flex-1 border-t border-dashed" />{m.body === 'New session' && <RotateCcw className="h-3 w-3" />} {m.body} · {clock(m.createdAt)}<div className="h-px flex-1 border-t border-dashed" />
                  </div>
                ) : <MessageRow m={m} grouped={grouped} name={nameOf(m)} avatar={avatarOf(m)} />}
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
          {pending.map((m) => <div key={m.id} className="px-5 pl-[4.25rem] pt-2">{renderPending(m)}</div>)}
          {view?.stalled && outgoing.length === 0 && (
            <div className="flex items-center gap-2 pl-[4.25rem] pt-1 text-xs text-muted-foreground">
              <CircleAlert className="h-3.5 w-3.5 text-amber-500" /> {title} didn’t pick that up.
              <button className="font-medium text-primary hover:underline" onClick={async () => { const r = await api.dmRetry(id); if (r.error) setErr(r.error); load() }}>Try again</button>
            </div>
          )}
        </div>

        {/* Typing indicator — the only trace of a turn in flight */}
        <div className="min-h-[1.5rem] shrink-0 px-5">
          {(view?.typing ?? []).map((t) => (
            <div key={t.agent} className="pb-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <TypingDots />
                <span><span className="font-medium text-foreground">{prettyAgent(t.agent)}</span> is {t.label === 'Writing' ? 'writing…' : t.label === 'Thinking' ? 'thinking…' : 'working on it…'}</span>
              </div>
              <Steps steps={t.steps} live />
            </div>
          ))}
        </div>

        {/* Composer */}
        <div className="relative shrink-0 px-5 pb-4">
          {mention && mentionable.length > 0 && (
            <div className="absolute bottom-full left-5 z-10 mb-1 w-72 overflow-hidden rounded-lg border bg-popover shadow-md">
              {mentionable.map((a, i) => (
                <button key={a.id} onMouseDown={(e) => { e.preventDefault(); applyMention(a.id) }} className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm ${i === Math.min(mention.pick, mentionable.length - 1) ? 'bg-muted' : ''}`}>
                  <Avatar agent={a.id} icon={a.icon} renderIcon={renderIcon} size="sm" /><span className="min-w-0 flex-1 truncate font-medium">{prettyAgent(a.id)}</span><span className="shrink-0 font-mono text-[11px] text-muted-foreground">@{a.id}</span>
                </button>
              ))}
            </div>
          )}
          <div className="rounded-xl border bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
            <Textarea
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
              <span className="pl-1 text-[10px] text-muted-foreground"><kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line{isRoom && room!.agents.length > 0 ? <> · <kbd className="font-sans">@</kbd> an agent to bring them in</> : null} · <kbd className="font-sans">/new</kbd> starts a new session</span>
              <Button size="icon" className="h-7 w-7" disabled={!draft.trim()} onClick={submit} aria-label="Send"><Send className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          {err && <p className="pt-1 text-xs text-destructive">{err}</p>}
        </div>
      </div>
      {isRoom && details && <RoomDetails me={me} room={room!} people={people} agents={agents} renderIcon={renderIcon} onChanged={() => { load(); onChanged() }} onLeft={onRemoved} onClose={() => setDetails(false)} />}
    </div>
  )
}

export function MessagesPage({ me, selected, onSelect, messages, renderIcon, renderPending, onUnread, onOpenSession }: {
  me: Member
  /** The open conversation: an agent id (DM), a `room_…` id, or '' / 'add' / 'new-room'. */
  selected: string
  onSelect: (key: string) => void
  /** The console's inbox feed — pending approvals/questions of the open conversation are shown inline. */
  messages: Msg[]
  renderIcon: IconRenderer
  renderPending: (m: Msg) => ReactNode
  onUnread?: (n: number) => void
  /** Owner/admin escape hatch: open the governed session behind a conversation. */
  onOpenSession?: (sessionId: string) => void
}) {
  const [contacts, setContacts] = useState<DmContact[] | null>(null)
  const [directory, setDirectory] = useState<DmDirectoryAgent[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [people, setPeople] = useState<RoomPerson[]>([])
  const [filter, setFilter] = useState('')

  const refresh = async () => {
    const r = await api.dmList()
    if (r.error) return
    setContacts(r.contacts); setDirectory(r.directory); setRooms(r.rooms ?? []); setPeople(r.people ?? [])
    onUnread?.(r.contacts.reduce((n, c) => n + (c.agent === selected ? 0 : c.unread), 0) + (r.rooms ?? []).reduce((n, c) => n + (c.id === selected ? 0 : c.unread), 0))
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [selected])

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

  const item = (key: string, glyph: ReactNode, title: string, preview: ReactNode, at: number, unreadCount: number, hasPreview: boolean) => {
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
            {unread && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{unreadCount}</span>}
          </span>
        </span>
      </button>
    )
  }
  const roomItem = (r: RoomSummary) => item(r.id, <RoomGlyph room={r} />, roomTitle(r, me.id),
    r.agents.some((a) => a.presence === 'working') ? <span className="italic">working…</span> : r.lastText ? `${r.lastAuthor ? r.lastAuthor + ': ' : ''}${r.lastText}` : `${r.members.length + r.agents.length} in here`,
    r.lastAt, r.unread, !!r.lastText)
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
                  d.contact.lastAt, d.contact.unread, !!d.contact.lastText)
              : roomItem(d.room!))}
            {contacts && direct.length === 0 && <p className="px-2 pt-1 text-xs text-muted-foreground">No contacts yet. Add an agent to start talking.</p>}
            <button onClick={() => onSelect('add')} className={`mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground ${adding ? 'bg-muted text-foreground' : ''}`}>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed"><Plus className="h-4 w-4" /></span>
              Add teammates
            </button>
          </div>
        </div>
      </aside>

      {/* Conversation / directory / new room */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {creating ? (
          <NewRoom me={me} people={people} agents={allAgents} renderIcon={renderIcon} onCreated={async (id) => { await refresh(); onSelect(id) }} onClose={() => onSelect('')} />
        ) : activeRoom ? (
          <Conversation key={activeRoom.id} me={me} target={{ kind: 'room', room: activeRoom }} messages={messages} people={people} agents={allAgents} renderIcon={renderIcon} renderPending={renderPending} onOpenSession={onOpenSession} onChanged={refresh} onRemoved={async () => { await refresh(); onSelect('') }} />
        ) : activeContact && !adding ? (
          <Conversation key={activeContact.agent} me={me} target={{ kind: 'dm', contact: activeContact }} messages={messages} people={people} agents={allAgents} renderIcon={renderIcon} renderPending={renderPending} onOpenSession={onOpenSession} onChanged={refresh} onRemoved={async () => { await refresh(); onSelect('') }} />
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
