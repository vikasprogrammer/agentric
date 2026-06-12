import { useEffect, useState } from 'react'
import { Plus, TerminalSquare, Check, X, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type StateResp, type AgentInfo, type Session, type Msg } from '@/lib/api'

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

export default function App() {
  const [state, setState] = useState<StateResp | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [messages, setMessages] = useState<Msg[]>([])
  const [agent, setAgent] = useState('')
  const [task, setTask] = useState('')
  const [selected, setSelected] = useState<{ tmux: string; title: string } | null>(null)
  const [hint, setHint] = useState('')

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

  const run = async () => {
    if (!task.trim()) return setHint('⚠ enter a task')
    setHint('spawning tmux session…')
    const r = await api.run(agent, task)
    if (r.error) return setHint('⚠ ' + r.error)
    setHint('session ' + r.id + ' started')
    setSelected({ tmux: r.tmux, title: agent + ' · ' + r.id })
  }

  return (
    <div className="flex h-screen bg-muted/30 text-foreground">
      <aside className="w-72 shrink-0 overflow-y-auto border-r bg-background p-4">
        <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold">⚙️ Agent OS</div>
        <button className="mb-2 text-sm font-medium italic hover:underline" onClick={() => setSelected(null)}>
          Inbox
        </button>
        <Separator />
        <div className="mb-2 mt-4 text-[11px] uppercase tracking-wider text-muted-foreground">Agents</div>
        {state?.agents.map((a) => (
          <div key={a.id} className="mb-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {a.id}
                <RuntimeBadge runtime={a.runtime} />
              </span>
              <Button size="icon" variant="ghost" className="h-6 w-6 text-emerald-600" onClick={() => pick(a.id)} title="new session">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-1 space-y-0.5">
              {sessions.filter((s) => s.agent === a.id).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelected({ tmux: s.tmux, title: s.agent + ' · ' + s.id })}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-muted ${
                    selected?.tmux === s.tmux ? 'bg-muted font-medium text-primary' : ''
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

      <main className="flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Inbox</h1>
          {state && <span className="text-xs text-muted-foreground">tenant={state.tenant} · policy={state.policy}</span>}
        </div>

        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="grid grid-cols-[200px_1fr_auto] items-end gap-3">
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
              <Button onClick={run}>
                <Play className="mr-1 h-4 w-4" />
                Run
              </Button>
            </div>
            {hint && <div className="mt-2 font-mono text-xs text-muted-foreground">{hint}</div>}
          </CardContent>
        </Card>

        {selected && (
          <Card className="mb-4 overflow-hidden p-0">
            <div className="flex items-center justify-between bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
              <span className="flex items-center gap-2">
                <TerminalSquare className="h-4 w-4" />
                {selected.title}
              </span>
              <span className="text-neutral-400">
                live tmux — click in and type to take over ·{' '}
                <button className="underline" onClick={() => setSelected(null)}>
                  close
                </button>
              </span>
            </div>
            <iframe title="terminal" src={`/terminal/?arg=${encodeURIComponent(selected.tmux)}`} className="block h-[440px] w-full border-0 bg-black" />
          </Card>
        )}

        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Inbox — tasks · updates · approvals</div>
        {messages.length === 0 && <div className="text-sm text-muted-foreground">No messages yet. Run an agent above.</div>}
        <div className="space-y-3">
          {messages.map((m) => (
            <MessageCard key={m.id} m={m} onOpen={(tmux, title) => setSelected({ tmux, title })} />
          ))}
        </div>
      </main>
    </div>
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
