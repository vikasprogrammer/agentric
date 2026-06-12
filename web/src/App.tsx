import { useEffect, useState, type ReactNode } from 'react'
import { Inbox as InboxIcon, TerminalSquare, Play, Plus, Check, X, Rocket } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type StateResp, type AgentInfo, type Session, type Msg } from '@/lib/api'

type Route = 'inbox' | 'sessions' | 'spawn'
type Selected = { tmux: string; title: string } | null

const exampleTask = (a?: AgentInfo): string =>
  !a
    ? ''
    : a.runtime === 'claude-code'
      ? 'List the files in this folder and tell me what this agent is for.'
      : 'Run the agent and handle its actions.'

function RuntimeBadge({ runtime }: { runtime: AgentInfo['runtime'] }) {
  const claude = runtime === 'claude-code'
  return (
    <Badge variant={claude ? 'default' : 'secondary'} className="px-1.5 py-0 text-[10px] font-normal">
      {claude ? 'claude' : 'mock'}
    </Badge>
  )
}

/** Minimal hash router — #/inbox · #/sessions · #/spawn. No dependency. */
function useHashRoute(): [Route, (r: Route) => void] {
  const parse = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return h === 'sessions' || h === 'spawn' ? h : 'inbox'
  }
  const [route, setRoute] = useState<Route>(parse())
  useEffect(() => {
    const on = () => setRoute(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [route, (r: Route) => { window.location.hash = '/' + r }]
}

export default function App() {
  const [state, setState] = useState<StateResp | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [messages, setMessages] = useState<Msg[]>([])
  const [agent, setAgent] = useState('')
  const [task, setTask] = useState('')
  const [selected, setSelected] = useState<Selected>(null)
  const [hint, setHint] = useState('')
  const [route, nav] = useHashRoute()

  useEffect(() => {
    api.state().then((s) => {
      setState(s)
      const first = s.agents[0]
      setAgent(first?.id ?? '')
      setTask(exampleTask(first))
    })
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

  const pick = (id: string) => {
    setAgent(id)
    setTask(exampleTask(state?.agents.find((x) => x.id === id)))
  }
  const spawnFor = (id: string) => {
    pick(id)
    nav('spawn')
  }
  const openTerminal = (tmux: string, title: string) => {
    setSelected({ tmux, title })
    nav('sessions')
  }
  const run = async () => {
    if (!task.trim()) return setHint('⚠ enter a task')
    setHint('spawning tmux session…')
    const r = await api.run(agent, task)
    if (r.error) return setHint('⚠ ' + r.error)
    setHint('session ' + r.id + ' started')
    openTerminal(r.tmux, agent + ' · ' + r.id)
  }

  const pendingApprovals = messages.filter((m) => m.type === 'approval' && m.status === 'pending').length
  const runningSessions = sessions.filter((s) => s.status === 'running').length
  // A live terminal takes the whole content area (no padding/scroll wrapper).
  const fullBleed = route === 'sessions' && !!selected

  return (
    <div className="flex h-screen bg-muted/30 text-foreground">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r bg-background p-4">
        <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold">⚙️ Agent OS</div>

        <nav className="space-y-1">
          <NavItem icon={<InboxIcon className="h-4 w-4" />} label="Inbox" active={route === 'inbox'} badge={pendingApprovals || undefined} onClick={() => nav('inbox')} />
          <NavItem icon={<TerminalSquare className="h-4 w-4" />} label="Sessions" active={route === 'sessions'} badge={runningSessions || undefined} onClick={() => nav('sessions')} />
          <NavItem icon={<Rocket className="h-4 w-4" />} label="Spawn agent" active={route === 'spawn'} onClick={() => nav('spawn')} />
        </nav>

        <Separator className="my-4" />

        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Agents</div>
        {state?.agents.map((a) => (
          <div key={a.id} className="mb-3">
            <div className="flex items-center justify-between">
              <button className="flex items-center gap-1.5 text-sm font-medium hover:underline" onClick={() => spawnFor(a.id)} title="spawn a session">
                {a.id}
                <RuntimeBadge runtime={a.runtime} />
              </button>
              <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={() => spawnFor(a.id)} title="new session">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-1 space-y-0.5">
              {sessions.filter((s) => s.agent === a.id).map((s) => (
                <button
                  key={s.id}
                  onClick={() => openTerminal(s.tmux, s.agent + ' · ' + s.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted ${
                    selected?.tmux === s.tmux && route === 'sessions' ? 'bg-muted font-medium text-primary' : ''
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                  <span className="truncate">{s.title}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="mb-1 mt-6 text-[11px] uppercase tracking-wider text-muted-foreground">Team</div>
        <div className="text-xs text-muted-foreground">— invite later —</div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h1 className="text-lg font-semibold">
            {route === 'inbox' ? 'Inbox' : route === 'sessions' ? 'Sessions' : 'Spawn agent'}
          </h1>
          {state && (
            <span className="text-xs text-muted-foreground">
              tenant={state.tenant} · policy={state.policy}
              {state.home ? ' · home=' + state.home : ''}
            </span>
          )}
        </div>

        <div className={`min-h-0 flex-1 ${fullBleed ? '' : 'overflow-y-auto p-6'}`}>
          {route === 'spawn' && (
            <SpawnPage state={state} agent={agent} task={task} setTask={setTask} pick={pick} run={run} hint={hint} />
          )}
          {route === 'sessions' && <SessionsPage sessions={sessions} selected={selected} onOpen={openTerminal} onSpawn={() => nav('spawn')} onClose={() => setSelected(null)} />}
          {route === 'inbox' && <InboxPage messages={messages} onOpen={openTerminal} />}
        </div>
      </main>
    </div>
  )
}

function NavItem({ icon, label, active, badge, onClick }: { icon: ReactNode; label: string; active: boolean; badge?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted ${active ? 'bg-muted font-medium text-primary' : 'text-foreground'}`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{badge}</Badge> : null}
    </button>
  )
}

// ── Spawn ──────────────────────────────────────────────────────────────────────
function SpawnPage({
  state, agent, task, setTask, pick, run, hint,
}: {
  state: StateResp | null
  agent: string
  task: string
  setTask: (s: string) => void
  pick: (id: string) => void
  run: () => void
  hint: string
}) {
  const info = state?.agents.find((a) => a.id === agent)
  return (
    <Card className="max-w-3xl">
      <CardContent className="p-4">
        <div className="grid grid-cols-[220px_1fr] items-end gap-3">
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Agent</label>
            <Select value={agent} onValueChange={(v) => v && pick(v)}>
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {state?.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-1.5">
                      {a.id}
                      <RuntimeBadge runtime={a.runtime} />
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Task</label>
            <Textarea value={task} onChange={(e) => setTask(e.target.value)} className="mt-1 min-h-[42px]" />
          </div>
        </div>
        {info && <div className="mt-2 text-xs text-muted-foreground">{info.description}</div>}
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={run}>
            <Play className="mr-1 h-4 w-4" />
            Run
          </Button>
          {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

// ── Sessions ───────────────────────────────────────────────────────────────────
function SessionsPage({
  sessions, selected, onOpen, onSpawn, onClose,
}: {
  sessions: Session[]
  selected: Selected
  onOpen: (tmux: string, title: string) => void
  onSpawn: () => void
  onClose: () => void
}) {
  // A terminal is open → fill the whole area: a slim switcher bar + the iframe taking the rest.
  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 overflow-x-auto border-b bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300">
          <TerminalSquare className="h-4 w-4 shrink-0" />
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded px-2 py-1 ${
                selected.tmux === s.tmux ? 'bg-neutral-700 text-white' : 'hover:bg-neutral-800'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-neutral-500'}`} />
              <span className="max-w-[180px] truncate">{s.title}</span>
            </button>
          ))}
          <button className="ml-auto shrink-0 px-2 py-1 text-neutral-400 underline hover:text-neutral-200" onClick={onClose}>
            close
          </button>
        </div>
        <iframe
          title="terminal"
          src={`/terminal/?arg=${encodeURIComponent(selected.tmux)}`}
          className="min-h-0 w-full flex-1 border-0 bg-black"
        />
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
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)}
          className="rounded-lg border p-3 text-left hover:bg-muted"
        >
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
            <span className="truncate text-sm font-medium">{s.title}</span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{s.agent} · {s.status}</div>
        </button>
      ))}
    </div>
  )
}

// ── Inbox ──────────────────────────────────────────────────────────────────────
function InboxPage({ messages, onOpen }: { messages: Msg[]; onOpen: (tmux: string, title: string) => void }) {
  return (
    <>
      <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">tasks · updates · approvals</div>
      {messages.length === 0 && <div className="text-sm text-muted-foreground">No messages yet. Spawn an agent to start.</div>}
      <div className="space-y-3">
        {messages.map((m) => (
          <MessageCard key={m.id} m={m} onOpen={onOpen} />
        ))}
      </div>
    </>
  )
}

function MessageCard({ m, onOpen }: { m: Msg; onOpen: (tmux: string, title: string) => void }) {
  const [busy, setBusy] = useState(false)
  const resolve = async (approved: boolean) => {
    setBusy(true)
    await api.resolve(m.approvalId!, approved)
  }

  if (m.type === 'approval') {
    const done = m.status === 'approved' || m.status === 'rejected'
    return (
      <Card className="border-amber-300 bg-amber-50/40">
        <CardContent className="flex justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant={m.level === 'owner' ? 'destructive' : 'secondary'}>{m.level} approval</Badge>
              <span className="text-sm font-medium">{m.title}</span>
            </div>
            <div className="break-all font-mono text-xs text-muted-foreground">{JSON.stringify(m.args ?? {})}</div>
            <div className="mt-1 text-xs text-muted-foreground">{m.body}</div>
          </div>
          <div className="shrink-0">
            {done ? (
              <Badge variant={m.status === 'approved' ? 'default' : 'destructive'}>{m.status}</Badge>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => resolve(true)}>
                  <Check className="mr-1 h-4 w-4" />
                  Approve
                </Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => resolve(false)}>
                  <X className="mr-1 h-4 w-4" />
                  Reject
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div>
          <div className="text-sm font-medium">{m.title}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">{m.body}</div>
        </div>
        {m.type === 'task' && (
          <Button size="sm" variant="secondary" onClick={() => onOpen('aos-' + m.sessionId, m.agent + ' · ' + m.sessionId)}>
            Open
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
