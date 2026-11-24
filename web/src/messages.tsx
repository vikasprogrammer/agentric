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
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronRight, MoreHorizontal, TerminalSquare, Plus, Search, Send, UserMinus, RotateCcw, Check, X, CircleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api, type DmContact, type DmDirectoryAgent, type DmMessage, type DmPresence, type DmStep, type DmThread, type Member, type Msg } from '@/lib/api'

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
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? agents.filter((a) => a.id.toLowerCase().includes(s) || (a.description || '').toLowerCase().includes(s) || (a.category || '').toLowerCase().includes(s)) : agents
  }, [agents, q])
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

function Conversation({ me, contact, messages, renderIcon, renderPending, onChanged, onRemoved, onOpenSession }: {
  me: Member
  contact: DmContact
  messages: Msg[]
  renderIcon: IconRenderer
  renderPending: (m: Msg) => ReactNode
  onChanged: () => void
  onRemoved: () => void
  onOpenSession?: (sessionId: string) => void
}) {
  const agent = contact.agent
  const name = prettyAgent(agent)
  const [thread, setThread] = useState<DmThread | null>(null)
  const [older, setOlder] = useState<DmMessage[]>([])
  const [noMore, setNoMore] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(`dmDraft:${agent}`) || '')
  const [outgoing, setOutgoing] = useState<Outgoing[]>([])
  const [err, setErr] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true) // stay pinned to the bottom unless the reader scrolled up
  const seq = useRef(0)

  useEffect(() => { localStorage.setItem(`dmDraft:${agent}`, draft) }, [agent, draft])
  useEffect(() => { inputRef.current?.focus() }, [agent])

  const live = thread?.presence === 'working' || outgoing.some((o) => !o.error)
  const load = async () => {
    const r = await api.dmThread(agent, { read: document.visibilityState === 'visible' })
    if (!r.error) setThread(r)
  }
  // Poll: quick while a reply is on its way (that gap IS the perceived latency), calm otherwise.
  useEffect(() => {
    let stop = false
    const tick = async () => { if (!stop) await load() }
    tick()
    const t = setInterval(tick, live ? 900 : 3000)
    return () => { stop = true; clearInterval(t) }
  }, [agent, live])

  const all = useMemo(() => {
    const server = [...older, ...(thread?.messages ?? [])]
    const mine: DmMessage[] = outgoing.map((o) => ({ seq: -o.key, authorKind: 'member', authorId: me.id, body: o.text, createdAt: o.at, pending: true }))
    return [...server, ...mine]
  }, [older, thread, outgoing, me.id])

  const lastSeq = thread?.messages.length ? thread.messages[thread.messages.length - 1].seq : 0
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastSeq, outgoing.length, thread?.typing?.label, thread?.typing?.steps.length])
  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const loadOlder = async () => {
    const first = all[0]
    if (!first || first.seq <= 0) return
    const el = scrollRef.current
    const prevHeight = el?.scrollHeight ?? 0
    const r = await api.dmThread(agent, { before: first.seq })
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
    const r = await api.dmSend(agent, body)
    if (r.error) {
      // Held = it carried a credential: hand the text back to edit rather than leave a failed bubble.
      if (r.held) { setOutgoing((o) => o.filter((x) => x.key !== key)); setDraft(body); setErr(r.error); return }
      setOutgoing((o) => o.map((x) => (x.key === key ? { ...x, error: r.error } : x)))
      return
    }
    await load()
    setOutgoing((o) => o.filter((x) => x.key !== key))
    onChanged()
  }
  const submit = () => { const t = draft; setDraft(''); send(t) }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const pending = thread?.sessionId
    ? messages.filter((m) => m.sessionId === thread.sessionId && (m.type === 'approval' || m.type === 'question') && (m.status ?? 'pending') === 'pending')
    : []
  const typing = thread?.typing
  const presence = thread?.presence ?? contact.presence
  const myAvatar = me.avatar
    ? <img src={me.avatar} alt="" className="h-9 w-9 rounded-lg object-cover" />
    : <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">{(me.name || me.email || '?').slice(0, 1).toUpperCase()}</span>
  const agentAvatar = <Avatar agent={agent} icon={contact.icon} renderIcon={renderIcon} />

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-5 py-2.5">
        <Avatar agent={agent} icon={contact.icon} renderIcon={renderIcon} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            <PresenceDot presence={presence} />
            <span className="text-[11px] text-muted-foreground">{presence === 'working' ? 'Working' : presence === 'online' ? 'Active' : 'Away'}</span>
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{contact.description}</div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Conversation options" />}>
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={async () => { await api.dmReset(agent); load() }}>
              <RotateCcw className="mr-2 h-3.5 w-3.5" /> New session (or type /new)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={async () => { await api.dmRemoveContact(agent); onRemoved() }}>
              <UserMinus className="mr-2 h-3.5 w-3.5" /> Remove from contacts
            </DropdownMenuItem>
            {onOpenSession && thread?.sessionId && (
              <DropdownMenuItem onClick={() => onOpenSession(thread.sessionId!)}>
                <TerminalSquare className="mr-2 h-3.5 w-3.5" /> Open the session behind this
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pb-3">
        {thread && all.length >= 100 && !noMore && (
          <div className="py-2 text-center"><button onClick={loadOlder} className="text-xs text-primary hover:underline">Load earlier messages</button></div>
        )}
        {thread && (noMore || all.length < 100) && (
          <div className="px-5 pb-2 pt-8">
            <Avatar agent={agent} icon={contact.icon} renderIcon={renderIcon} size="lg" />
            <h3 className="mt-3 text-lg font-semibold">{name}</h3>
            <p className="max-w-xl text-sm text-muted-foreground">
              This is the start of your conversation with <span className="font-medium text-foreground">{name}</span>. {contact.description}
            </p>
          </div>
        )}
        {all.map((m, i) => {
          const prev = all[i - 1]
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt)
          const grouped = !newDay && !!prev && prev.authorKind === m.authorKind && m.createdAt - prev.createdAt < 5 * 60_000
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
                  <div className="h-px flex-1 border-t border-dashed" /><RotateCcw className="h-3 w-3" /> {m.body} · {clock(m.createdAt)}<div className="h-px flex-1 border-t border-dashed" />
                </div>
              ) : <MessageRow m={m} grouped={grouped} name={m.authorKind === 'agent' ? name : (me.name || 'You')} avatar={m.authorKind === 'agent' ? agentAvatar : myAvatar} />}
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
        {thread?.stalled && outgoing.length === 0 && (
          <div className="flex items-center gap-2 pl-[4.25rem] pt-1 text-xs text-muted-foreground">
            <CircleAlert className="h-3.5 w-3.5 text-amber-500" /> {name} didn’t pick that up.
            <button className="font-medium text-primary hover:underline" onClick={async () => { const r = await api.dmRetry(agent); if (r.error) setErr(r.error); load() }}>Try again</button>
          </div>
        )}
      </div>

      {/* Typing indicator — the only trace of a turn in flight */}
      <div className="min-h-[1.5rem] shrink-0 px-5">
        {typing && (
          <div className="pb-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <TypingDots />
              <span><span className="font-medium text-foreground">{name}</span> is {typing.label === 'Writing' ? 'writing…' : typing.label === 'Thinking' ? 'thinking…' : 'working on it…'}</span>
            </div>
            <Steps steps={typing.steps} live />
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 px-5 pb-4">
        <div className="rounded-xl border bg-background focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
          <Textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={`Message ${name}`}
            rows={1}
            className="max-h-48 min-h-[44px] resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="pl-1 text-[10px] text-muted-foreground"><kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line · <kbd className="font-sans">/new</kbd> starts a new session</span>
            <Button size="icon" className="h-7 w-7" disabled={!draft.trim()} onClick={submit} aria-label="Send"><Send className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
        {err && <p className="pt-1 text-xs text-destructive">{err}</p>}
      </div>
    </div>
  )
}

export function MessagesPage({ me, selected, onSelect, messages, renderIcon, renderPending, onUnread, onOpenSession }: {
  me: Member
  /** The open contact's agent id, or '' / 'add' for the directory. */
  selected: string
  onSelect: (agent: string) => void
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
  const [filter, setFilter] = useState('')

  const refresh = async () => {
    const r = await api.dmList()
    if (r.error) return
    setContacts(r.contacts); setDirectory(r.directory)
    onUnread?.(r.contacts.reduce((n, c) => n + (c.agent === selected ? 0 : c.unread), 0))
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [selected])

  const adding = selected === 'add'
  const active = contacts?.find((c) => c.agent === selected)
  // First visit lands on the most recent conversation, the way a chat app reopens where you left off.
  useEffect(() => {
    if (!selected && contacts && contacts.length > 0) onSelect(contacts[0].agent)
  }, [selected, contacts])

  const add = async (agent: string) => {
    const r = await api.dmAddContact(agent)
    if (r.error) return
    await refresh()
    onSelect(agent)
  }

  const shown = (contacts ?? []).filter((c) => !filter.trim() || prettyAgent(c.agent).toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <div className="flex h-full min-h-0">
      {/* Contacts */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Direct messages</span>
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => onSelect('add')} title="Add a teammate" aria-label="Add a teammate"><Plus className="h-4 w-4" /></Button>
        </div>
        {(contacts?.length ?? 0) > 7 && (
          <div className="px-2 pb-1"><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a conversation" className="h-7 text-xs" /></div>
        )}
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {shown.map((c) => {
            const on = c.agent === selected
            const unread = !on && c.unread > 0
            return (
              <button key={c.agent} onClick={() => onSelect(c.agent)} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted ${on ? 'bg-muted' : ''}`}>
                <Avatar agent={c.agent} icon={c.icon} renderIcon={renderIcon} presence={c.presence} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1">
                    <span className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-semibold' : 'font-medium'}`}>{prettyAgent(c.agent)}</span>
                    {c.lastText && <span className="shrink-0 text-[10px] text-muted-foreground">{shortWhen(c.lastAt)}</span>}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>
                      {c.presence === 'working' ? <span className="italic">working…</span> : c.lastText ? `${c.lastFromMe ? 'You: ' : ''}${c.lastText}` : 'Say hello'}
                    </span>
                    {unread && <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{c.unread}</span>}
                  </span>
                </span>
              </button>
            )
          })}
          {contacts && contacts.length === 0 && <p className="px-2 pt-3 text-xs text-muted-foreground">No contacts yet. Add an agent to start talking.</p>}
          <button onClick={() => onSelect('add')} className={`mt-1 flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground ${adding ? 'bg-muted text-foreground' : ''}`}>
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed"><Plus className="h-4 w-4" /></span>
            Add teammates
          </button>
        </div>
      </aside>

      {/* Conversation / directory */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active && !adding ? (
          <Conversation key={active.agent} me={me} contact={active} messages={messages} renderIcon={renderIcon} renderPending={renderPending} onOpenSession={onOpenSession} onChanged={refresh} onRemoved={async () => { await refresh(); onSelect('') }} />
        ) : contacts === null ? (
          <p className="pt-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : selected && !adding && !active ? (
          // A deep link to an agent that isn't a contact yet: offer the add in place.
          <div className="mx-auto flex max-w-sm flex-col items-center gap-3 pt-24 text-center">
            <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{prettyAgent(selected)}</span> isn’t in your contacts.</p>
            {directory.some((a) => a.id === selected)
              ? <Button size="sm" onClick={() => add(selected)}><Check className="mr-1 h-3.5 w-3.5" /> Add and start chatting</Button>
              : <Button size="sm" variant="outline" onClick={() => onSelect('add')}>Browse teammates</Button>}
          </div>
        ) : (
          <Directory agents={directory} renderIcon={renderIcon} onAdd={add} hasContacts={contacts.length > 0} onClose={contacts.length > 0 ? () => onSelect(contacts[0].agent) : undefined} />
        )}
      </section>
    </div>
  )
}
