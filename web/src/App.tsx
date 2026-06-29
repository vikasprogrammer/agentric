import { useEffect, useState, type ReactNode } from 'react'
import { Inbox as InboxIcon, TerminalSquare, Play, Plus, Check, X, Square, Rocket, Plug, Trash2, Users, User, LogOut, Copy, Zap, Brain, Building2, ChevronDown, SlidersHorizontal, Pencil, FileText, HelpCircle, CheckCircle2, XCircle, Clock, Send, LayoutGrid, List, ArrowLeft, Bot, FolderTree, Folder, File as FileIcon, Save, ChevronRight, Sparkles, Package, Image as ImageIcon, Download, BookText, History as HistoryIcon, ScrollText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { api, EFFORTS, PERMISSION_MODES, type StateResp, type AgentInfo, type Session, type Msg, type ConnectorsResp, type CatalogEntry, type AddConnectorReq, type Connector, type ConnectorScope, type Member, type Role, type TeamResp, type MemberIdentity, type IdentityProvider, IDENTITY_PROVIDERS, type Automation, type MemoryRecord, type MemoryHealth, type MemoryBackend, type MemorySettings, type MemorySettingsReq, type OllamaStatus, type KbPage, type KbRevision, type Recommendation, type PolicyDocument, type PolicyRule, type RiskClass, type PolicyOp, type DirListing, type FileContent, type Artifact, type SkillSummary, type SkillsResp, type IntegrationsResp, type SlackStatus, type DiscordStatus, type AuditEvent, type ConnectionsResp, type IntegrationsOverview, type Effort, type PermissionMode, type RuntimeTuning } from '@/lib/api'

type Route = 'inbox' | 'sessions' | 'agents' | 'new-agent' | 'connectors' | 'team' | 'automations' | 'memory' | 'kb' | 'skills' | 'files' | 'artifacts' | 'settings' | 'audit' | 'agent'
type Selected = { tmux: string; title: string } | null

/** Mirror of the server rule: owner approves anything, admin approves head-level only. */
const canApprove = (role: Role, level: 'head' | 'owner'): boolean =>
  role === 'owner' || (role === 'admin' && level === 'head')

const ROLE_LABEL: Record<Role, string> = { owner: 'owner', admin: 'admin', member: 'member' }

function RoleBadge({ role }: { role: Role }) {
  const variant = role === 'owner' ? 'destructive' : role === 'admin' ? 'default' : 'secondary'
  return <Badge variant={variant} className="px-1.5 py-0 text-[10px] font-normal">{ROLE_LABEL[role]}</Badge>
}

/** Prefill the spawn box with the agent's first starter prompt, if it defines any. Otherwise the box
 *  starts empty and shows its "Describe the task…" placeholder — no generic filler. */
const exampleTask = (a?: AgentInfo): string => a?.examplePrompts?.[0] ?? ''

function RuntimeBadge({ runtime }: { runtime: AgentInfo['runtime'] }) {
  const claude = runtime === 'claude-code'
  return (
    <Badge variant={claude ? 'default' : 'secondary'} className="px-1.5 py-0 text-[10px] font-normal">
      {claude ? 'claude' : 'mock'}
    </Badge>
  )
}

/** The model / effort / permission-mode trio, reused by the create form, the agent editor, and the
 *  workspace defaults panel. Empty model/effort/permission = "inherit" (the placeholder/option says so).
 *  These map 1:1 to `claude --model/--effort/--permission-mode`; Agent OS's gate-hook governs underneath. */
function TuningFields({ tuning, onChange, modelPlaceholder = 'inherit', inheritLabel = 'inherit' }: {
  tuning: RuntimeTuning
  onChange: (t: RuntimeTuning) => void
  modelPlaceholder?: string
  inheritLabel?: string
}) {
  const selCls = 'h-8 w-full rounded-md border bg-background px-2 text-xs'
  return (
    <div className="grid gap-3 sm:grid-cols-3">
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
        <label className="text-xs font-medium">Permission</label>
        <select className={selCls} value={tuning.permissionMode ?? ''} onChange={(e) => onChange({ ...tuning, permissionMode: (e.target.value || undefined) as PermissionMode | undefined })}>
          <option value="">{inheritLabel}</option>
          {PERMISSION_MODES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
    </div>
  )
}

/** Minimal hash router — #/inbox · #/agents · #/sessions. No dependency. */
function useHashRoute(): [Route, (r: Route) => void] {
  const parse = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '')
    return h === 'sessions' || h === 'agents' || h === 'new-agent' || h === 'connectors' || h === 'team' || h === 'automations' || h === 'memory' || h === 'kb' || h === 'skills' || h === 'files' || h === 'artifacts' || h === 'settings' || h === 'agent' ? h : 'inbox'
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
  // undefined = checking, null = not logged in (show Login), Member = authed.
  const [me, setMe] = useState<Member | null | undefined>(undefined)
  useEffect(() => {
    api.me().then(setMe)
  }, [])

  if (me === undefined) return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>
  if (me === null) return <LoginScreen />
  return <Console me={me} />
}

function Console({ me }: { me: Member }) {
  const [state, setState] = useState<StateResp | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [messages, setMessages] = useState<Msg[]>([])
  const [selected, setSelected] = useState<Selected>(null)
  const [editAgent, setEditAgent] = useState('')
  const [route, nav] = useHashRoute()

  // Secondary "Manage" nav is collapsed by default so the Agents list stays high; it auto-opens
  // when you're on one of its pages.
  const manageRoutes: Route[] = ['automations', 'memory', 'skills', 'connectors', 'team', 'files', 'settings']
  const onManage = manageRoutes.includes(route)
  const [manageOpen, setManageOpen] = useState(onManage)
  useEffect(() => { if (onManage) setManageOpen(true) }, [onManage])

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

  const refreshState = () => api.state().then(setState)
  const deleteAgent = async (id: string) => {
    if (!confirm(`Delete agent "${id}"? Its folder (agent.json + CLAUDE.md) is permanently removed. Its memory and audit history are kept.`)) return
    const r = await api.deleteAgent(id)
    if (r.error) { alert(r.error); return }
    await refreshState()
  }
  const openAgent = (id: string) => {
    setEditAgent(id)
    nav('agent')
  }
  const openTerminal = (tmux: string, title: string) => {
    setSelected({ tmux, title })
    nav('sessions')
  }
  // Deep-link from an inbox 'artifact' card into the gallery, pre-opening that artifact's preview.
  const [artifactFocus, setArtifactFocus] = useState<string | undefined>(undefined)
  const openArtifact = (id: string) => { setArtifactFocus(id); nav('artifacts') }
  const stopSession = async (id: string) => {
    await api.stopSession(id)
    setSessions(await api.sessions())
  }
  const deleteSession = async (id: string, tmux: string) => {
    if (!confirm('Delete this session? Its inbox messages and transcript files are removed; the audit log is kept.')) return
    await api.deleteSession(id)
    if (selected?.tmux === tmux) setSelected(null)
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
    if (selected && tmuxes.has(selected.tmux)) setSelected(null)
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

  const pendingApprovals = messages.filter((m) => (m.type === 'approval' || m.type === 'question') && m.status === 'pending').length
  const runningSessions = sessions.filter((s) => s.status === 'running').length
  // The sidebar is a switcher over the sessions *I* started (spawnedBy is the member id),
  // running first, then newest first.
  const mySessions = sessions
    .filter((s) => s.spawnedBy === me.id)
    .sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'running' ? -1 : 1))
  // A live terminal takes the whole content area (no padding/scroll wrapper).
  const fullBleed = route === 'sessions' && !!selected

  return (
    <div className="flex h-screen bg-muted/30 text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-background">
        {/* Top: brand + primary nav (fixed) */}
        <div className="p-4 pb-2">
          <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold">⚙️ Agent OS</div>
          <nav className="space-y-1">
            <NavItem icon={<InboxIcon className="h-4 w-4" />} label="Inbox" active={route === 'inbox'} badge={pendingApprovals || undefined} onClick={() => nav('inbox')} />
            <NavItem icon={<Bot className="h-4 w-4" />} label="Agents" active={route === 'agents' || route === 'agent'} onClick={() => nav('agents')} />
            <NavItem icon={<Package className="h-4 w-4" />} label="Artifacts" active={route === 'artifacts'} onClick={() => nav('artifacts')} />
          </nav>
        </div>

        {/* Middle: my sessions — the working surface, a flat running-first switcher. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Sessions</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setSelected(null); nav('sessions') }}
                className={`flex items-center gap-1 text-[11px] uppercase tracking-wider hover:text-foreground ${route === 'sessions' ? 'text-primary' : 'text-muted-foreground'}`}
                title="all sessions"
              >
                All{runningSessions ? <span className="rounded-full bg-emerald-500/15 px-1 text-[10px] font-medium text-emerald-600">{runningSessions}</span> : null}
              </button>
              <Button size="icon" variant="ghost" className="h-5 w-5 text-emerald-600" onClick={() => nav('agents')} title="spawn an agent"><Plus className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          {mySessions.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No sessions yet. <button className="text-primary underline" onClick={() => nav('agents')}>Spawn an agent</button>.
            </div>
          )}
          <div className="space-y-0.5">
            {mySessions.map((s) => {
              const active = selected?.tmux === s.tmux && route === 'sessions'
              return (
                <button
                  key={s.id}
                  onClick={() => openTerminal(s.tmux, s.agent + ' · ' + s.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted ${active ? 'bg-muted' : ''}`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] leading-tight ${active ? 'font-medium text-primary' : ''}`}>{s.title}</span>
                    <span className="block truncate text-[11px] leading-tight text-muted-foreground">{s.agent}</span>
                  </span>
                </button>
              )
            })}
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
              <NavItem icon={<Zap className="h-4 w-4" />} label="Automations" active={route === 'automations'} onClick={() => nav('automations')} />
              <NavItem icon={<BookText className="h-4 w-4" />} label="Knowledge" active={route === 'kb'} onClick={() => nav('kb')} />
              <NavItem icon={<Brain className="h-4 w-4" />} label="Memory" active={route === 'memory'} onClick={() => nav('memory')} />
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<Sparkles className="h-4 w-4" />} label="Skills" active={route === 'skills'} onClick={() => nav('skills')} />
              )}
              <NavItem icon={<Plug className="h-4 w-4" />} label="Connectors" active={route === 'connectors'} onClick={() => nav('connectors')} />
              <NavItem icon={<Users className="h-4 w-4" />} label="Team" active={route === 'team'} onClick={() => nav('team')} />
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<FolderTree className="h-4 w-4" />} label="Files" active={route === 'files'} onClick={() => nav('files')} />
              )}
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<ScrollText className="h-4 w-4" />} label="Audit" active={route === 'audit'} onClick={() => nav('audit')} />
              )}
              {(me.role === 'owner' || me.role === 'admin') && (
                <NavItem icon={<Building2 className="h-4 w-4" />} label="Settings" active={route === 'settings'} onClick={() => nav('settings')} />
              )}
            </nav>
          )}

          <Separator className="my-3" />
          <div className="flex items-center justify-between">
            <button className="flex min-w-0 items-center gap-2 text-left hover:underline" onClick={() => nav('team')} title="manage team">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">{me.name.slice(0, 1)}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium leading-tight">
                  <span className="truncate">{me.name}</span>
                  <RoleBadge role={me.role} />
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{me.email}</span>
              </span>
            </button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="log out" onClick={async () => { await api.logout(); window.location.reload() }}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h1 className="text-lg font-semibold">
            {route === 'inbox' ? 'Inbox' : route === 'sessions' ? 'Sessions' : route === 'connectors' ? 'Connectors' : route === 'team' ? 'Team' : route === 'automations' ? 'Automations' : route === 'memory' ? 'Memory' : route === 'kb' ? 'Knowledge Base' : route === 'skills' ? 'Skills' : route === 'files' ? 'Files' : route === 'artifacts' ? 'Artifacts' : route === 'audit' ? 'Audit log' : route === 'settings' ? 'Company settings' : route === 'new-agent' ? 'New agent' : route === 'agent' ? `Agent · ${editAgent}` : 'Agents'}
          </h1>
          {state && (
            <span className="text-xs text-muted-foreground">
              tenant={state.tenantName || state.tenant} · policy={state.policy}
              {state.home ? ' · home=' + state.home : ''}
            </span>
          )}
        </div>

        <div className={`min-h-0 flex-1 ${fullBleed ? '' : 'overflow-y-auto p-6'}`}>
          {route === 'agents' && <AgentsPage me={me} agents={state?.agents ?? []} run={runAgent} onEdit={openAgent} onNew={() => nav('new-agent')} onDelete={deleteAgent} />}
          {route === 'new-agent' && <NewAgentPage me={me} onCreated={async (id) => { await refreshState(); openAgent(id) }} />}
          {route === 'sessions' && <SessionsPage sessions={sessions} selected={selected} onOpen={openTerminal} onSpawn={() => nav('agents')} onClose={() => setSelected(null)} onStop={stopSession} onDelete={deleteSession} onBulkStop={stopSessions} onBulkDelete={deleteSessions} />}
          {route === 'inbox' && <InboxPage messages={messages} me={me} onOpen={openTerminal} onOpenArtifact={openArtifact} />}
          {route === 'connectors' && <ConnectorsPage me={me} />}
          {route === 'team' && <TeamPage me={me} />}
          {route === 'automations' && <AutomationsPage me={me} agents={state?.agents ?? []} onOpen={openTerminal} />}
          {route === 'memory' && <MemoryPage agents={state?.agents ?? []} me={me} />}
          {route === 'kb' && <KnowledgeBasePage me={me} />}
          {route === 'skills' && <SkillsPage />}
          {route === 'files' && <FilesPage />}
          {route === 'artifacts' && <ArtifactsPage me={me} initialId={artifactFocus} />}
          {route === 'audit' && <AuditPage />}
          {route === 'settings' && <SettingsPage me={me} />}
          {route === 'agent' && editAgent && <AgentPage agentId={editAgent} agents={state?.agents ?? []} />}
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

// ── Agents ─────────────────────────────────────────────────────────────────────
/** Spawning, ChatGPT-style: one big centered composer. Pick an agent from the dropdown,
 *  type a task, hit Run to spawn a live session. Owner/admin can tune the selected agent's
 *  Settings (CLAUDE.md + runtime), delete it, or create a new one — all the catalog actions,
 *  just scoped to the chosen agent instead of a grid of cards. */
function AgentsPage({
  me, agents, run, onEdit, onNew, onDelete,
}: {
  me: Member
  agents: AgentInfo[]
  run: (agentId: string, task: string) => Promise<string | null>
  onEdit: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const canEdit = me.role === 'owner' || me.role === 'admin'
  const [agentId, setAgentId] = useState('')
  const [task, setTask] = useState('')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  // Keep the selection valid as the agent list loads/changes; default to the first agent.
  useEffect(() => {
    if (agents.length === 0) { if (agentId) setAgentId(''); return }
    if (!agents.some((a) => a.id === agentId)) setAgentId(agents[0].id)
  }, [agents, agentId])

  const agent = agents.find((a) => a.id === agentId)
  // Switching agents prefills its first starter prompt and clears any stale hint.
  useEffect(() => { setTask(exampleTask(agent)); setHint('') }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps

  const spawn = async () => {
    if (!agent || !task.trim()) return
    setBusy(true); setHint('spawning…')
    const err = await run(agent.id, task)
    setBusy(false)
    setHint(err ? '⚠ ' + err : '')
  }

  if (agents.length === 0) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">{canEdit ? 'No agents yet — create one to get started.' : 'No agents assigned to you.'}</p>
        {canEdit && <Button size="sm" className="gap-1" onClick={onNew}><Plus className="h-4 w-4" /> New agent</Button>}
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center">
      <div className="w-full max-w-2xl space-y-5">
        <h1 className="text-center text-xl font-semibold tracking-tight">What should an agent do?</h1>

        <Card className="shadow-sm">
          <CardContent className="flex flex-col gap-3 p-4">
            {/* agent picker + per-agent actions */}
            <div className="flex items-center gap-2">
              <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
                <SelectTrigger className="h-9 min-w-0 flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-1.5">{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {canEdit && agent?.runtime === 'claude-code' && (
                <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => onEdit(agent.id)} title="agent settings — runtime tuning, starter prompts, CLAUDE.md">
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              )}
              {canEdit && agent?.deletable && (
                <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-destructive" onClick={() => onDelete(agent.id)} title="delete agent (removes its folder)">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
              {canEdit && (
                <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={onNew} title="new agent">
                  <Plus className="h-4 w-4" />
                </Button>
              )}
            </div>

            {agent?.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}

            {agent?.examplePrompts && agent.examplePrompts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {agent.examplePrompts.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setTask(p)}
                    title={p}
                    className="max-w-full truncate rounded-full border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
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
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">Run spawns a live session — every effect still passes the gate.</p>
      </div>
    </div>
  )
}

// ── Sessions ───────────────────────────────────────────────────────────────────
/** Who started a session — a person icon + name for members, a bot icon for automations. */
function StartedBy({ label, className = '' }: { label?: string; className?: string }) {
  if (!label) return <span className={`flex items-center gap-1 text-xs text-muted-foreground/60 ${className}`}>—</span>
  const isAuto = label.startsWith('Automation')
  return (
    <span className={`flex items-center gap-1 text-xs text-muted-foreground ${className}`} title={`started by ${label}`}>
      {isAuto ? <Bot className="h-3 w-3 shrink-0" /> : <User className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  )
}

/** The live terminal iframe. It asks the server for the attach URL — which is the shared
 *  /terminal/?arg=… (uid-isolation off) or a per-member /terminal/<space>/?arg=… that the app
 *  reverse-proxies to that member's own ttyd (on). Fetching also brings the member's ttyd up. */
function TerminalFrame({ session, tmux }: { session?: Session; tmux: string }) {
  const [src, setSrc] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    setSrc(''); setErr('')
    if (!session?.id) { setSrc(`/terminal/?arg=${encodeURIComponent(tmux)}`); return }
    api.attach(session.id).then((r) => {
      if (!alive) return
      if (r.url) setSrc(r.url)
      else setErr(r.error || 'could not open terminal')
    })
    return () => { alive = false }
  }, [session?.id, tmux])
  if (err) return <div className="flex flex-1 items-center justify-center bg-black text-sm text-red-400">⚠ {err}</div>
  if (!src) return <div className="flex flex-1 items-center justify-center bg-black text-sm text-neutral-500">opening terminal…</div>
  return <iframe title="terminal" src={src} className="min-h-0 w-full flex-1 border-0 bg-black" />
}

function SessionsPage({
  sessions, selected, onOpen, onSpawn, onClose, onStop, onDelete, onBulkStop, onBulkDelete,
}: {
  sessions: Session[]
  selected: Selected
  onOpen: (tmux: string, title: string) => void
  onSpawn: () => void
  onClose: () => void
  onStop: (id: string) => void
  onDelete: (id: string, tmux: string) => void
  onBulkStop: (ids: string[]) => void
  onBulkDelete: (ids: string[]) => void
}) {
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('aos_sessions_view') === 'list' ? 'list' : 'grid'))
  const setMode = (v: 'grid' | 'list') => { localStorage.setItem('aos_sessions_view', v); setView(v) }

  // Multi-select for bulk stop/delete. Kept in sync with the live list: ids that vanish (deleted
  // elsewhere, or by our own bulk delete) are pruned so the toolbar count never lies.
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
  const allSelected = sessions.length > 0 && sel.size === sessions.length
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(sessions.map((s) => s.id)))
  const selectedRunning = sessions.filter((s) => sel.has(s.id) && s.status === 'running')
  const bulkStop = () => onBulkStop(selectedRunning.map((s) => s.id))
  const bulkDelete = () => { onBulkDelete([...sel]); setSel(new Set()) }

  // A terminal is open → fill the whole area: a slim switcher bar + the iframe taking the rest.
  if (selected) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b bg-neutral-900 px-2 py-1.5 text-xs text-neutral-300">
          <TerminalSquare className="h-4 w-4 shrink-0" />
          {/* Only the tabs scroll; the "All sessions" button stays pinned right so it's always reachable. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`group/tab flex shrink-0 items-center gap-1.5 rounded px-2 py-1 ${
                  selected.tmux === s.tmux ? 'bg-neutral-700 text-white' : 'hover:bg-neutral-800'
                }`}
              >
                <button onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)} title={s.spawnedByLabel ? `started by ${s.spawnedByLabel}` : undefined} className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-neutral-500'}`} />
                  <span className="max-w-[180px] truncate">{s.title}</span>
                </button>
                {/* per-tab controls — stop (running only) + delete, revealed on hover or when active */}
                <span className={`flex items-center gap-1 ${selected.tmux === s.tmux ? '' : 'opacity-0 group-hover/tab:opacity-100'}`}>
                  {s.status === 'running' && (
                    <button className="rounded p-0.5 text-amber-400 hover:bg-neutral-600 hover:text-amber-300" onClick={() => onStop(s.id)} title="stop — kill this session's shell">
                      <Square className="h-3 w-3" />
                    </button>
                  )}
                  <button className="rounded p-0.5 text-red-400 hover:bg-neutral-600 hover:text-red-300" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <button
            className="flex shrink-0 items-center gap-1 rounded bg-neutral-800 px-2 py-1 font-medium text-neutral-200 hover:bg-neutral-700"
            onClick={onClose}
            title="exit the terminal and go back to the sessions list"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All sessions
          </button>
        </div>
        <TerminalFrame key={selected.tmux} session={sessions.find((s) => s.tmux === selected.tmux)} tmux={selected.tmux} />
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
            {sel.size > 0 ? `${sel.size} selected` : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
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

      {view === 'grid' ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sessions.map((s) => (
            <div key={s.id} className={`group relative flex flex-col rounded-lg border p-3 hover:bg-muted ${sel.has(s.id) ? 'ring-1 ring-primary' : ''}`}>
              <input
                type="checkbox"
                checked={sel.has(s.id)}
                onChange={() => toggle(s.id)}
                title="select"
                className={`absolute right-2 top-2 h-3.5 w-3.5 cursor-pointer accent-primary transition-opacity ${sel.has(s.id) ? '' : 'opacity-0 group-hover:opacity-100'}`}
              />
              <button onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)} className="pr-6 text-left">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                  <span className="truncate text-sm font-medium">{s.title}</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{s.agent} · {s.status}</div>
                <div className="mt-1"><StartedBy label={s.spawnedByLabel} /></div>
              </button>
              <div className="mt-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {s.status === 'running' && (
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-amber-600" onClick={() => onStop(s.id)} title="kill this session's shell">
                    <X className="h-3 w-3" /> Stop
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-xs text-destructive" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {sessions.map((s) => (
            <div key={s.id} className={`group flex items-center gap-3 px-3 py-2 hover:bg-muted ${sel.has(s.id) ? 'bg-muted' : ''}`}>
              <input
                type="checkbox"
                checked={sel.has(s.id)}
                onChange={() => toggle(s.id)}
                title="select"
                className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
              />
              <button onClick={() => onOpen(s.tmux, s.agent + ' · ' + s.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className={`h-2 w-2 shrink-0 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
                <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground sm:block">{s.agent}</span>
                <StartedBy label={s.spawnedByLabel} className="w-40 shrink-0" />
                <span className="w-16 shrink-0 text-xs text-muted-foreground">{s.status}</span>
              </button>
              <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {s.status === 'running' && (
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-amber-600" onClick={() => onStop(s.id)} title="stop — kill this session's shell">
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => onDelete(s.id, s.tmux)} title="delete session + its messages/files">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Inbox ──────────────────────────────────────────────────────────────────────
const SEEN_KEY = 'aos_inbox_seen'
/** An item needs the human: an unresolved approval or an unanswered question. */
const isActionRequired = (m: Msg): boolean =>
  (m.type === 'approval' || m.type === 'question') && m.status === 'pending'

function InboxPage({ messages, me, onOpen, onOpenArtifact }: { messages: Msg[]; me: Member; onOpen: (tmux: string, title: string) => void; onOpenArtifact: (id: string) => void }) {
  const [seen, setSeen] = useState<number>(() => Number(localStorage.getItem(SEEN_KEY) || 0))
  // Optimistically hide dismissed items; roll back on error. The server filters them from the next
  // poll anyway, so the set just bridges the gap until then.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const dismiss = async (id: string) => {
    setDismissed((s) => new Set(s).add(id))
    const r = await api.dismissMessage(id)
    if (r.error) { setDismissed((s) => { const n = new Set(s); n.delete(id); return n }); alert(r.error) }
  }
  const action = messages.filter(isActionRequired)
  const activity = messages.filter((m) => !isActionRequired(m) && !dismissed.has(m.id))
  const unread = activity.filter((m) => m.createdAt > seen).length
  const markRead = () => {
    const latest = messages.reduce((mx, m) => Math.max(mx, m.createdAt), seen)
    localStorage.setItem(SEEN_KEY, String(latest)); setSeen(latest)
  }

  if (messages.length === 0) return <div className="text-sm text-muted-foreground">No messages yet. Spawn an agent to start.</div>

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          Action required {action.length > 0 && <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">{action.length}</Badge>}
        </div>
        {action.length === 0 ? (
          <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Nothing waiting on you. 🎉</div>
        ) : (
          <div className="space-y-3">
            {action.map((m) => <MessageCard key={m.id} m={m} me={me} onOpen={onOpen} onOpenArtifact={onOpenArtifact} unread={m.createdAt > seen} />)}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Activity{unread > 0 ? ` · ${unread} new` : ''}</span>
          {unread > 0 && <button className="text-[11px] text-muted-foreground underline hover:text-foreground" onClick={markRead}>mark all read</button>}
        </div>
        <div className="space-y-2">
          {activity.map((m) => (
            <div key={m.id} className="group relative">
              <MessageCard m={m} me={me} onOpen={onOpen} onOpenArtifact={onOpenArtifact} unread={m.createdAt > seen} />
              <button
                className="absolute right-1 top-1 hidden rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground group-hover:block"
                onClick={() => dismiss(m.id)}
                title="dismiss from inbox"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
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

function MessageCard({ m, me, onOpen, onOpenArtifact, unread }: { m: Msg; me: Member; onOpen: (tmux: string, title: string) => void; onOpenArtifact?: (id: string) => void; unread?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const open = () => onOpen('aos-' + m.sessionId, m.agent + ' · ' + m.sessionId)
  const dot = unread ? <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /> : null

  // ── Artifact (a published deliverable) ──
  if (m.type === 'artifact') {
    const meta = (m.args ?? {}) as { artifactId?: string; filename?: string }
    return (
      <Card>
        <CardContent className="flex items-start justify-between gap-4 p-3">
          <div className="flex min-w-0 gap-2">
            {dot}
            <Package className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{m.agent} published</span>
                {meta.filename && <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{meta.filename}</Badge>}
              </div>
              <div className="mt-0.5 truncate text-sm text-muted-foreground">{m.body}</div>
            </div>
          </div>
          {meta.artifactId && onOpenArtifact
            ? <Button size="sm" variant="secondary" onClick={() => onOpenArtifact(meta.artifactId!)}>View</Button>
            : <Button size="sm" variant="secondary" onClick={open}>Open</Button>}
        </CardContent>
      </Card>
    )
  }

  // ── Approval (action required) ──
  if (m.type === 'approval') {
    const done = m.status === 'approved' || m.status === 'rejected'
    const mayApprove = canApprove(me.role, (m.level ?? 'head') as 'head' | 'owner')
    const resolve = async (approved: boolean) => { setBusy(true); const r = await api.resolve(m.approvalId!, approved); if (r.error) setBusy(false) }
    return (
      <Card className={done ? '' : 'border-amber-300 bg-amber-50/40'}>
        <CardContent className="flex justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <Badge variant={m.level === 'owner' ? 'destructive' : 'secondary'}>{m.level === 'owner' ? 'owner' : 'admin'} approval</Badge>
              <span className="text-sm font-medium">{m.title}</span>
            </div>
            <div className="break-all font-mono text-xs text-muted-foreground">{JSON.stringify(m.args ?? {})}</div>
            {m.body && <div className="mt-1 text-xs text-muted-foreground">{m.body}</div>}
            {m.policyReason && (
              <div className="mt-1 text-xs text-muted-foreground"><span className="text-amber-700">why:</span> {m.policyReason}</div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {done ? (
              <>
                <Badge variant={m.status === 'approved' ? 'default' : 'destructive'}>{m.status}</Badge>
                {m.resolvedBy && <span className="text-[10px] text-muted-foreground">by {m.resolvedBy}</span>}
              </>
            ) : mayApprove ? (
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => resolve(true)}><Check className="mr-1 h-4 w-4" />Approve</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => resolve(false)}><X className="mr-1 h-4 w-4" />Reject</Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{m.level === 'owner' ? 'owner' : 'admin'} approval required</span>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Question (ask-human) ──
  if (m.type === 'question') {
    const answered = m.status === 'answered'
    const send = async () => { if (!answer.trim()) return; setBusy(true); const r = await api.answerQuestion(m.questionId!, answer.trim()); if (r.error) setBusy(false) }
    return (
      <Card className={answered ? '' : 'border-sky-300 bg-sky-50/40'}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4 shrink-0 text-sky-600" />
            <span className="text-sm font-medium">{m.agent} asks</span>
            <button className="ml-auto text-xs text-muted-foreground underline hover:text-foreground" onClick={open}>open session</button>
          </div>
          <div className="mt-1 text-sm">{m.body}</div>
          {answered ? (
            <div className="mt-2 rounded-md bg-muted px-3 py-2 text-sm"><span className="text-xs text-muted-foreground">{m.answeredBy ? `${m.answeredBy} answered: ` : 'answer: '}</span>{m.answer}</div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Input value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Type your answer — the agent is waiting…" />
              <Button size="sm" disabled={busy || !answer.trim()} onClick={send}><Send className="mr-1 h-3.5 w-3.5" />Reply</Button>
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  // ── Completed ──
  if (m.type === 'completed') {
    const o = OUTCOME_STYLE[m.outcome ?? 'unknown'] ?? OUTCOME_STYLE.unknown
    const Icon = m.outcome === 'failure' ? XCircle : CheckCircle2
    return (
      <Card>
        <CardContent className="flex items-start justify-between gap-4 p-3">
          <div className="flex min-w-0 gap-2">
            {dot}
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${m.outcome === 'failure' ? 'text-red-600' : 'text-emerald-600'}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{m.agent} finished</span>
                <Badge variant="outline" className={`px-1.5 py-0 text-[10px] font-normal ${o.cls}`}>{o.label}</Badge>
              </div>
              <div className="mt-0.5 text-sm text-muted-foreground">{m.body}</div>
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={open}>Open</Button>
        </CardContent>
      </Card>
    )
  }

  // ── Task (started) + Update (progress) ──
  const started = m.type === 'task'
  const provenance = started ? (m.source?.startsWith('automation:') ? '⏱ automation' : 'manual') : null
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-3">
        <div className="flex min-w-0 gap-2">
          {dot}
          {started ? <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{started ? `${m.agent} started` : `${m.agent} update`}</span>
              {provenance && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{provenance}</Badge>}
            </div>
            <div className="mt-0.5 truncate text-sm text-muted-foreground">{m.body}</div>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={open}>Open</Button>
      </CardContent>
    </Card>
  )
}

// ── Connectors ───────────────────────────────────────────────────────────────────
const TYPE_ICON: Record<string, string> = { slack: '💬', github: '🐙', gdrive: '📁', gmail: '✉️', composio: '🧩', custom: '🔌', 'custom-remote': '🌐' }

/** One connector row — reused across the Company / My / team-members sections. */
function ConnectorCard({ c, me, busy, onToggle, onRemove, onShare }: { c: Connector; me?: Member | null; busy: string; onToggle: (id: string, enabled: boolean) => void; onRemove: (id: string) => void; onShare?: (id: string, shared: boolean) => void }) {
  const isAdmin = me?.role === 'owner' || me?.role === 'admin'
  // The owner of a personal connector (or an admin) may share it with the whole team.
  const canShare = c.scope === 'personal' && !!onShare && (isAdmin || c.ownerMemberId === me?.id)
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span>{TYPE_ICON[c.type] ?? '🔌'}</span>
            <span className="text-sm font-medium">{c.label}</span>
            <Badge variant={c.enabled ? 'default' : 'secondary'} className="px-1.5 py-0 text-[10px]">
              {c.enabled ? 'enabled' : 'disabled'}
            </Badge>
            {c.scope === 'personal' && c.shared && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-emerald-600" title="Shared with the whole team — runs as you">shared with team</Badge>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.description}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {c.transport === 'stdio'
              ? `${c.command} ${c.args.join(' ')}${c.envKeys.length ? ` · ${c.envKeys.join(', ')}` : ''}`
              : `${c.transport} · ${c.url || 'per-user session, auto-minted at launch'}${c.headerKeys.length ? ` · ${c.headerKeys.join(', ')}` : ''}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canShare && (
            <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => onShare!(c.id, !c.shared)} title={c.shared ? 'Stop sharing with the team' : 'Share with the whole team (agents act as you)'}>
              {c.shared ? 'Unshare' : 'Share with team'}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => onToggle(c.id, !c.enabled)}>
            {c.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === c.id} onClick={() => onRemove(c.id)} title="remove">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** A clickable catalog tile that opens the add dialog at the given scope. */
function CatalogTile({ t, onPick }: { t: CatalogEntry; onPick: () => void }) {
  return (
    <button onClick={onPick} className="rounded-lg border p-3 text-left hover:bg-muted">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span>{TYPE_ICON[t.type] ?? '🔌'}</span>
        {t.label}
        <Plus className="ml-auto h-4 w-4 text-emerald-600" />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
    </button>
  )
}

/** Initiate connecting an app via Composio → opens the hosted OAuth link. Company scope is gated to
 *  owner/admin by the server; personal scope is the member's own. */
// The Composio toolkit catalog (~1000 apps) for the connect autocomplete — fetched once per page load
// and shared by every ConnectApp instance via a module-level promise.
let toolkitsPromise: Promise<{ slug: string; name: string }[]> | null = null
function useComposioToolkits(): { slug: string; name: string }[] {
  const [list, setList] = useState<{ slug: string; name: string }[]>([])
  useEffect(() => {
    if (!toolkitsPromise) toolkitsPromise = api.composioToolkits().then((r) => r.toolkits ?? []).catch(() => [])
    let alive = true
    toolkitsPromise.then((t) => { if (alive) setList(t) })
    return () => { alive = false }
  }, [])
  return list
}
const FALLBACK_TOOLKITS = ['slackbot', 'slack', 'gmail', 'github', 'googledrive', 'googlesheets', 'googlecalendar', 'notion', 'linear', 'jira', 'hubspot']

function ConnectApp({ scope, onDone }: { scope: 'company' | 'personal'; onDone: () => void }) {
  const [toolkit, setToolkit] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const toolkits = useComposioToolkits()
  const connect = async () => {
    const t = toolkit.trim().toLowerCase()
    if (!t) return
    setBusy(true); setHint('')
    const r = await api.connectApp({ toolkit: t, scope })
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    if (r.redirectUrl) {
      window.open(r.redirectUrl, '_blank', 'noopener')
      setToolkit(''); setHint('Authorize in the opened tab, then Refresh.')
    }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input
        list="composio-toolkits"
        value={toolkit}
        onChange={(e) => setToolkit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && connect()}
        placeholder={`connect ${scope === 'company' ? 'a company' : 'your'} app — type to search ${toolkits.length || ''} apps…`}
        className="h-8 w-[280px] rounded-md border bg-background px-2 text-sm"
      />
      <datalist id="composio-toolkits">
        {(toolkits.length ? toolkits : FALLBACK_TOOLKITS.map((s) => ({ slug: s, name: s }))).map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
      </datalist>
      <Button size="sm" onClick={connect} disabled={busy || !toolkit.trim()}>Connect</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>Refresh</Button>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/** Live Composio connections (read from composio.dev) — company-wide + the member's own apps. */
/** A small chip for a connected app / server (toolkit or label + a status badge + optional remove). */
function AppChip({ name, badge, badgeVariant = 'secondary', onRemove, removing }: { name: string; badge?: string; badgeVariant?: 'secondary' | 'outline'; onRemove?: () => void; removing?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 text-sm">
      <span className="font-medium capitalize">{name}</span>
      {badge && <Badge variant={badgeVariant} className="px-1.5 py-0 text-[10px]">{badge}</Badge>}
      {onRemove && (
        <button onClick={onRemove} disabled={removing} title="disconnect" className="-mr-1 ml-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

/**
 * The COMPANY section — everything wired at the company level, shared by every agent: Composio company
 * apps, the native Slack app, and custom MCP servers. Owner/admin get the edit controls; members see
 * the same picture read-only. One place, no duplication.
 */
function CompanySection({ me, custom, catalog, cardProps, onPickCatalog }: {
  me: Member | null
  custom: Connector[]
  catalog: CatalogEntry[]
  cardProps: { me: Member | null; busy: string; onToggle: (id: string, enabled: boolean) => void; onRemove: (id: string) => void; onShare: (id: string, shared: boolean) => void }
  onPickCatalog: (t: CatalogEntry) => void
}) {
  const isAdmin = me?.role === 'owner' || me?.role === 'admin'
  const [ov, setOv] = useState<IntegrationsOverview | null>(null)
  const [showCustom, setShowCustom] = useState(false)
  const [busyId, setBusyId] = useState('')
  const reload = () => api.integrationsOverview().then(setOv).catch(() => {})
  useEffect(() => { reload() }, [])
  const disconnect = async (id: string, label: string) => {
    if (!window.confirm(`Disconnect ${label} for the whole company? Every agent loses access.`)) return
    setBusyId(id)
    const r = await api.disconnectApp({ id, scope: 'company' })
    setBusyId('')
    if (r.error) return window.alert('Could not disconnect: ' + r.error)
    reload()
  }
  return (
    <section className="space-y-5 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Company</span>
        <span className="text-[11px] text-muted-foreground">— shared by every agent{isAdmin ? '' : ' · read-only'}</span>
      </div>

      {/* Composio apps (company entity) */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Apps via Composio</span>
          {ov?.composio.keySet && <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title="Composio user_id for company-wide apps">{ov.composio.entity}</code>}
        </div>
        {!ov ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !ov.composio.keySet ? (
          <p className="text-xs text-muted-foreground">No Composio API key yet{isAdmin ? ' — add one in Settings → Integrations to connect company apps.' : ' (an admin sets this up in Settings).'}</p>
        ) : ov.composio.apps.length === 0 ? (
          <p className="text-xs text-muted-foreground">No company apps connected yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ov.composio.apps.map((a) => (
              <AppChip
                key={a.id}
                name={a.toolkit}
                badge={a.status.toLowerCase()}
                badgeVariant={a.status === 'ACTIVE' ? 'secondary' : 'outline'}
                onRemove={isAdmin ? () => disconnect(a.id, a.toolkit) : undefined}
                removing={busyId === a.id}
              />
            ))}
          </div>
        )}
        {isAdmin && ov?.composio.keySet && <ConnectApp scope="company" onDone={reload} />}
      </div>

      {/* Native Slack */}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">Slack (native)</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Slack app</span>
          {ov?.slack.connected
            ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600">connected{ov.slack.botUserId ? ` · ${ov.slack.botUserId}` : ''}</Badge>
            : ov?.slack.configured
              ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-amber-600">configured · not connected</Badge>
              : <Badge variant="outline" className="px-1.5 py-0 text-[10px]">not configured</Badge>}
          {isAdmin
            ? <a href="#/settings" className="text-[11px] text-muted-foreground underline hover:text-foreground">set up in Settings → Integrations</a>
            : <span className="text-[11px] text-muted-foreground">managed by an admin</span>}
        </div>
      </div>

      {/* Native Discord */}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">Discord (native)</div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Discord bot</span>
          {ov?.discord?.connected
            ? <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-emerald-600">connected{ov.discord.botUserId ? ` · ${ov.discord.botUserId}` : ''}</Badge>
            : ov?.discord?.configured
              ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-amber-600">configured · not connected</Badge>
              : <Badge variant="outline" className="px-1.5 py-0 text-[10px]">not configured</Badge>}
          {isAdmin
            ? <a href="#/settings" className="text-[11px] text-muted-foreground underline hover:text-foreground">set up in Settings → Integrations</a>
            : <span className="text-[11px] text-muted-foreground">managed by an admin</span>}
        </div>
      </div>

      {/* Custom MCP servers (org scope) — collapsed by default; the power-user escape hatch for
          anything not in Composio (internal/self-hosted servers). Hidden for members with none. */}
      {(isAdmin || custom.length > 0) && (
        <div>
          <button
            type="button"
            onClick={() => setShowCustom((v) => !v)}
            className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {showCustom ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Custom MCP servers{custom.length ? ` (${custom.length})` : ''}
          </button>
          {showCustom && (
            <div className="mt-2">
              {isAdmin ? (
                <>
                  <p className="mb-2 text-xs text-muted-foreground">For anything Composio doesn’t cover — an internal or self-hosted MCP server (a local command or a remote URL). Added <b>company-wide</b> (every agent gets it).</p>
                  {custom.length > 0 && <div className="mb-2 space-y-2">{custom.map((c) => <ConnectorCard key={c.id} c={c} {...cardProps} />)}</div>}
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {catalog.map((t) => <CatalogTile key={t.type} t={t} onPick={() => onPickCatalog(t)} />)}
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {custom.map((c) => <AppChip key={c.id} name={c.label} badge={c.enabled ? c.type : `${c.type} · off`} badgeVariant="outline" />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** The MINE section — the member's own Composio connections; they only load in sessions they start. */
function MyConnections() {
  const [data, setData] = useState<ConnectionsResp | null>(null)
  const [busyId, setBusyId] = useState('')
  const reload = () => api.connections().then(setData).catch(() => {})
  useEffect(() => { reload() }, [])
  const disconnect = async (id: string, label: string) => {
    if (!window.confirm(`Disconnect your ${label} connection?`)) return
    setBusyId(id)
    const r = await api.disconnectApp({ id, scope: 'personal' })
    setBusyId('')
    if (r.error) return window.alert('Could not disconnect: ' + r.error)
    reload()
  }
  return (
    <section className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Mine</span>
        <span className="text-[11px] text-muted-foreground">— your own apps, only load in sessions you start</span>
        {data?.me && <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground" title="your Composio user_id">{data.me}</code>}
      </div>
      {!data ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !data.keySet ? (
        <p className="text-xs text-muted-foreground">Connecting your own apps needs a company Composio key (an admin adds it in Settings → Integrations).</p>
      ) : (
        <>
          {data.mine.length === 0 ? (
            <p className="text-xs text-muted-foreground">You haven’t connected any personal apps yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.mine.map((c) => <AppChip key={c.id} name={c.toolkit} badge={c.status.toLowerCase()} badgeVariant={c.status === 'ACTIVE' ? 'secondary' : 'outline'} onRemove={() => disconnect(c.id, c.toolkit)} removing={busyId === c.id} />)}
            </div>
          )}
          <ConnectApp scope="personal" onDone={reload} />
        </>
      )}
    </section>
  )
}

function ConnectorsPage({ me }: { me: Member | null }) {
  const [data, setData] = useState<ConnectorsResp | null>(null)
  const [adding, setAdding] = useState<{ template: CatalogEntry; scope: ConnectorScope } | null>(null)
  const [busy, setBusy] = useState('')

  // Coerce any non-conforming response (e.g. a 404 from an older server build) into an empty,
  // well-shaped value so the page degrades gracefully instead of crashing on `.length`/`.map`.
  const load = () =>
    api.connectors().then((d) =>
      setData({
        connectors: Array.isArray(d?.connectors) ? d.connectors : [],
        catalog: Array.isArray(d?.catalog) ? d.catalog : [],
        native: Array.isArray(d?.native) ? d.native : [],
      }),
    )
  useEffect(() => { load() }, [])

  const remove = async (id: string) => {
    setBusy(id)
    await api.deleteConnector(id)
    await load()
    setBusy('')
  }
  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id)
    await api.toggleConnector(id, enabled)
    await load()
    setBusy('')
  }
  const share = async (id: string, shared: boolean) => {
    setBusy(id)
    await api.shareConnector(id, shared)
    await load()
    setBusy('')
  }

  const conns = data?.connectors ?? []
  // The only connector ROWS are bespoke custom MCP servers (the escape hatch); Composio apps + native
  // Slack are surfaced live inside <CompanySection/> and <MyConnections/>.
  const custom = conns.filter((c) => c.type === 'custom' || c.type === 'custom-remote')
  const cardProps = { me, busy, onToggle: toggle, onRemove: remove, onShare: share }

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Connectors give your claude-code agents real tools. <b>Company</b> integrations are shared by every agent;
        <b> your</b> connections only load in sessions you start. Every call still passes the gate, so risky actions
        land in the Inbox for approval.
      </p>

      <CompanySection me={me} custom={custom} catalog={data?.catalog ?? []} cardProps={cardProps} onPickCatalog={(t) => setAdding({ template: t, scope: 'org' })} />

      <MyConnections />

      {adding && (
        <AddConnectorDialog
          template={adding.template}
          scope={adding.scope}
          onClose={() => setAdding(null)}
          onAdded={async () => { setAdding(null); await load() }}
        />
      )}
    </div>
  )
}

function AddConnectorDialog({ template, scope, onClose, onAdded }: { template: CatalogEntry; scope: ConnectorScope; onClose: () => void; onAdded: () => void }) {
  const isStdioCustom = template.type === 'custom'
  const isRemoteCustom = template.type === 'custom-remote'
  const isCustom = isStdioCustom || isRemoteCustom
  const isRemote = template.transport !== 'stdio'
  const [vals, setVals] = useState<Record<string, string>>({}) // structured field values, keyed by field.key
  const [label, setLabel] = useState(isCustom ? '' : template.label)
  const [command, setCommand] = useState(template.command ?? 'npx')
  const [argsText, setArgsText] = useState((template.args ?? []).join(' '))
  const [url, setUrl] = useState('')
  const [customEnv, setCustomEnv] = useState('') // KEY=value per line (stdio custom)
  const [customHeaders, setCustomHeaders] = useState('') // Name: value per line (remote custom)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setHint('')
    const req: AddConnectorReq = { type: template.type, label: label || undefined, transport: template.transport, scope }
    if (isStdioCustom) {
      const env: Record<string, string> = {}
      for (const line of customEnv.split('\n')) {
        const i = line.indexOf('=')
        if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      req.command = command
      req.args = argsText.split(/\s+/).filter(Boolean)
      req.env = env
    } else if (isRemoteCustom) {
      const headers: Record<string, string> = {}
      for (const line of customHeaders.split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      req.url = url
      req.headers = headers
    } else {
      // A structured template (slack/github/composio/…): route each field's value by its target.
      const env: Record<string, string> = {}
      const headers: Record<string, string> = {}
      for (const f of template.fields) {
        const v = vals[f.key]
        if (!v) continue
        if (f.target === 'url') req.url = v
        else if (f.target === 'header') headers[f.key] = v
        else env[f.key] = v
      }
      if (Object.keys(env).length) req.env = env
      if (Object.keys(headers).length) req.headers = headers
    }
    const res = await api.addConnector(req)
    setBusy(false)
    if ('error' in res) return setHint('⚠ ' + res.error)
    onAdded()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{TYPE_ICON[template.type] ?? '🔌'}</span> Add {template.label}
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{scope === 'personal' ? 'personal · only you' : 'company · whole team'}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{template.description}</p>

          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={template.label} />
          </Field>

          {isStdioCustom ? (
            <>
              <Field label="Command">
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </Field>
              <Field label="Arguments">
                <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @scope/server-name" />
              </Field>
              <Field label="Environment (KEY=value per line)">
                <Textarea value={customEnv} onChange={(e) => setCustomEnv(e.target.value)} className="min-h-[72px] font-mono text-xs" placeholder={'API_TOKEN=…\nWORKSPACE=…'} />
              </Field>
            </>
          ) : isRemoteCustom ? (
            <>
              <Field label="Server URL" help="The MCP server's HTTP/SSE endpoint">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
              </Field>
              <Field label="Headers (Name: value per line)">
                <Textarea value={customHeaders} onChange={(e) => setCustomHeaders(e.target.value)} className="min-h-[72px] font-mono text-xs" placeholder={'Authorization: Bearer …\nX-API-Key: …'} />
              </Field>
            </>
          ) : (
            template.fields.map((f) => (
              <Field key={f.key} label={f.label} help={f.help}>
                <Input
                  value={vals[f.key] ?? ''}
                  onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  type={f.target === 'url' ? 'text' : /token|secret|key|password/i.test(f.key) ? 'password' : 'text'}
                />
              </Field>
            ))
          )}
          <p className="text-[11px] text-muted-foreground">
            {isRemote ? (
              <>Connects to a remote MCP endpoint over <span className="font-mono">{template.transport}</span>.</>
            ) : (
              <>Runs <span className="font-mono">{isStdioCustom ? command || 'npx' : template.command} {isStdioCustom ? argsText : (template.args ?? []).join(' ')}</span>.</>
            )}{' '}
            Credentials are stored locally in your data home.
          </p>
        </div>

        <DialogFooter>
          {hint && <span className="mr-auto self-center font-mono text-xs text-destructive">{hint}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy}><Plug className="mr-1 h-4 w-4" />Connect</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
 *  home root; this is just navigation (folders/breadcrumb) + a text editor for the open file. */
function FilesPage() {
  const [dir, setDir] = useState('')
  const [listing, setListing] = useState<DirListing | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [file, setFile] = useState<FileContent | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  const loadDir = (rel: string) => {
    setHint('')
    api.files.list(rel).then((d) => {
      if (d.error) return setHint('⚠ ' + d.error)
      setListing(d); setDir(d.path)
    })
  }
  useEffect(() => { loadDir('') }, [])

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

  const segments = dir ? dir.split('/') : []
  const parent = segments.slice(0, -1).join('/')
  const dirty = file?.content !== undefined && content !== file.content

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Browse and edit files in this instance's data home
        {listing && <> (<span className="font-mono text-xs">{listing.root}</span>)</>} — its agents, policy,
        audit logs and connector configs. Confined to the home; you can view and save text files (no create or delete).
      </p>

      {/* breadcrumb */}
      <div className="flex flex-wrap items-center gap-0.5 text-sm">
        <button className="rounded px-1.5 py-0.5 font-medium hover:bg-muted" onClick={() => loadDir('')}>home</button>
        {segments.map((s, i) => (
          <span key={i} className="flex items-center gap-0.5">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => loadDir(segments.slice(0, i + 1).join('/'))}>{s}</button>
          </span>
        ))}
      </div>
      {hint && <div className="font-mono text-xs text-muted-foreground">{hint}</div>}

      <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
        {/* directory listing */}
        <div className="h-fit divide-y rounded-lg border">
          {dir && (
            <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => loadDir(parent)}>
              <Folder className="h-4 w-4 shrink-0" /> ..
            </button>
          )}
          {listing && listing.entries.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">Empty folder.</div>}
          {listing?.entries.map((e) => {
            const isOpen = openPath === join(e.name)
            return (
              <button
                key={e.name}
                disabled={e.type === 'other'}
                onClick={() => (e.type === 'dir' ? loadDir(join(e.name)) : open(e.name))}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50 ${isOpen ? 'bg-muted' : ''}`}
              >
                {e.type === 'dir'
                  ? <Folder className="h-4 w-4 shrink-0 text-sky-600" />
                  : <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <span className={`min-w-0 flex-1 truncate ${isOpen ? 'font-medium text-primary' : ''}`}>{e.name}</span>
                {e.type === 'file' && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(e.size)}</span>}
              </button>
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

function ArtifactIcon({ a, className }: { a: Artifact; className?: string }) {
  if (isPdfMime(a.mime)) return <FileText className={className ?? 'h-4 w-4 text-red-500'} />
  if (isImageMime(a.mime)) return <ImageIcon className={className ?? 'h-4 w-4 text-sky-500'} />
  if (isMarkdownArt(a)) return <FileText className={className ?? 'h-4 w-4 text-violet-500'} />
  return <FileIcon className={className ?? 'h-4 w-4 text-muted-foreground'} />
}

/** Renders an artifact's contents by type: image inline, PDF in an iframe, Markdown rendered,
 *  text/JSON in a pre, anything else a download prompt. */
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

function ArtifactsPage({ me, initialId }: { me: Member; initialId?: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [enabled, setEnabled] = useState(true)
  const [sel, setSel] = useState<string | undefined>(initialId)
  const [agentFilter, setAgentFilter] = useState('')
  const [hint, setHint] = useState('')

  const load = () => api.artifacts().then((r) => { setArtifacts(r.artifacts ?? []); setEnabled(r.enabled !== false) })
  useEffect(() => { load() }, [])
  useEffect(() => { if (initialId) setSel(initialId) }, [initialId])

  const agents = Array.from(new Set(artifacts.map((a) => a.agent))).sort()
  const shown = agentFilter ? artifacts.filter((a) => a.agent === agentFilter) : artifacts
  const selected = artifacts.find((a) => a.id === sel)

  const remove = async (id: string) => {
    if (!confirm('Delete this artifact? Its snapshotted file is permanently removed (the audit log is kept).')) return
    const r = await api.deleteArtifact(id)
    if (r.error) { setHint('⚠ ' + r.error); return }
    if (sel === id) setSel(undefined)
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
          {shown.length === 0 && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No artifacts yet. When an agent calls its <span className="font-mono">publish</span> tool, the deliverable shows up here.</div>}
          {shown.map((a) => {
            const active = a.id === sel
            return (
              <button key={a.id} onClick={() => setSel(a.id)} className={`w-full overflow-hidden rounded-lg border text-left transition hover:border-primary/50 ${active ? 'border-primary ring-1 ring-primary/30' : ''}`}>
                <div className="flex items-start gap-2.5 p-2.5">
                  {isImageMime(a.mime)
                    ? <img src={api.artifactRawUrl(a.id)} alt="" className="h-10 w-10 shrink-0 rounded border object-cover" />
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
              </button>
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
                      <span>· {fmtSize(selected.bytes)}</span>
                      <span>· session <span className="font-mono">{selected.sessionId}</span></span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <a href={api.artifactRawUrl(selected.id)} download={selected.filename}><Button size="sm" variant="secondary"><Download className="mr-1 h-4 w-4" />Download</Button></a>
                    {(me.role === 'owner' || me.role === 'admin' || selected.source === me.id) && (
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(selected.id)}><Trash2 className="h-4 w-4" /></Button>
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
function LoginScreen() {
  const [value, setValue] = useState('')
  const invalid = /[?&]login=invalid/.test(window.location.href)
  // Accept either a full magic link or a bare token; navigate to the server-side /accept route.
  const go = () => {
    const v = value.trim()
    if (!v) return
    const token = v.includes('token=') ? v.split('token=')[1].split(/[&\s]/)[0] : v
    window.location.href = '/accept?token=' + encodeURIComponent(token)
  }
  return (
    <div className="flex h-screen items-center justify-center bg-muted/30">
      <Card className="w-full max-w-md">
        <CardContent className="p-6">
          <div className="mb-1 flex items-center gap-2 text-lg font-semibold">⚙️ Agent OS</div>
          <p className="mb-4 text-sm text-muted-foreground">
            Access is by invite. Paste the magic-link (or token) you were sent to sign in. The
            workspace owner can mint one from the Team page, or from the box with{' '}
            <span className="font-mono text-xs">agent-os invite</span>.
          </p>
          {invalid && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">That link is invalid or expired — ask for a fresh one.</div>}
          <Field label="Magic link or token">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…/accept?token=…" onKeyDown={(e) => e.key === 'Enter' && go()} />
          </Field>
          <Button className="mt-4 w-full" onClick={go} disabled={!value.trim()}>Sign in</Button>
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
// (no public URL), the bot scopes the OS needs, and the two events we route. Pasted into the manifest
// editor, or pre-filled via the create-app deep link below (?new_app=1&manifest_json=…).
const SLACK_MANIFEST_OBJ = {
  display_information: { name: 'Agent OS' },
  features: { bot_user: { display_name: 'Agent OS', always_online: true } },
  oauth_config: {
    scopes: {
      bot: ['app_mentions:read', 'chat:write', 'users:read', 'users:read.email', 'im:history', 'im:read'],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
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
            The manifest already enables <strong>Socket Mode</strong> and subscribes to <code className="text-[11px]">app_mention</code> +
            <code className="text-[11px]"> message.im</code> — nothing else to configure. No request URL or public endpoint is needed; the server dials out to Slack.
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
            <li>
              <strong>Invite the bot</strong> to your server: OAuth2 → URL Generator → scopes <code className="text-[11px]">bot</code>,
              permissions <em>View Channels · Send Messages · Read Message History</em> — or use this link template (swap in your
              application id):
              <div className="mt-2"><CopyBlock text={`https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`} label="Copy invite URL" /></div>
            </li>
            <li><strong>Save</strong> below. The status badge flips to <strong className="text-emerald-600">connected</strong> within a second or two. Then add a <strong>Discord message</strong> automation on the Automations page.</li>
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
  useEffect(() => { setVals(Object.fromEntries(IDENTITY_PROVIDERS.map((p) => [p, current(p)]))) }, [identities]) // eslint-disable-line react-hooks/exhaustive-deps
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

function TeamPage({ me }: { me: Member }) {
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

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Members sign in with a one-time magic link. <strong>Owners</strong> run everything and approve
        red (owner) requests; <strong>admins</strong> approve yellow (admin) requests and manage the team;
        <strong> members</strong> can only run the agents they're assigned and never approve.
      </p>

      {/* Members */}
      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Members</div>
        <div className="space-y-2">
          {data.members.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium uppercase">{m.name.slice(0, 1)}</span>
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
                  <div className="mb-1 text-[11px] text-muted-foreground">Send this one-time link to the invitee:</div>
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
          <p className="mb-2 text-xs text-muted-foreground">Owners and admins can run every agent. Grant <strong>members</strong> access below — by role (all members) or individually.</p>
          <div className="space-y-2">
            {data.agents.map((a) => {
              const acc = access(a.id)
              return (
                <Card key={a.id}>
                  <CardContent className="flex flex-wrap items-center gap-2 p-3">
                    <span className="mr-1 flex items-center gap-1.5 text-sm font-medium">{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                    <Chip on={acc.allowedRoles.includes('member')} onClick={() => toggleRole(a.id, 'member')}>all members</Chip>
                    {plainMembers.map((m) => (
                      <Chip key={m.id} on={acc.allowedMembers.includes(m.id)} onClick={() => toggleMember(a.id, m.id)}>{m.name}</Chip>
                    ))}
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

// ── Automations ──────────────────────────────────────────────────────────────────
function AutomationsPage({ me, agents, onOpen }: { me: Member; agents: AgentInfo[]; onOpen: (tmux: string, title: string) => void }) {
  const [items, setItems] = useState<Automation[] | null>(null)
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  // create form
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [type, setType] = useState<'cron' | 'webhook' | 'composio' | 'slack' | 'discord'>('cron')
  const [mode, setMode] = useState<'interactive' | 'headless'>('headless')
  const [schedule, setSchedule] = useState('*/30 * * * *')
  const [filter, setFilter] = useState('')
  const [task, setTask] = useState('')

  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const load = () => api.automations().then((r) => setItems(r.automations ?? []))
  useEffect(() => { load() }, [])
  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id) }, [agents, agentId])

  const create = async () => {
    setHint('')
    const r = await api.addAutomation({ name, agentId, type, mode, schedule: type === 'cron' ? schedule : undefined, filter: type === 'composio' || type === 'slack' || type === 'discord' ? filter : undefined, task })
    if (r.error) return setHint('⚠ ' + r.error)
    setName(''); setTask('')
    load()
  }
  const setItemMode = async (a: Automation, m: 'interactive' | 'headless') => { setBusy(a.id); await api.updateAutomation(a.id, { mode: m }); await load(); setBusy('') }
  const toggle = async (a: Automation) => { setBusy(a.id); await api.updateAutomation(a.id, { enabled: !a.enabled }); await load(); setBusy('') }
  const remove = async (a: Automation) => { setBusy(a.id); await api.deleteAutomation(a.id); await load(); setBusy('') }
  const runNow = async (a: Automation) => {
    setBusy(a.id); setHint('')
    const r = await api.runAutomation(a.id)
    setBusy('')
    if (!r.ok) return setHint('⚠ ' + (r.reason || r.error || 'failed'))
    await load()
    if (r.sessionId) onOpen('aos-' + r.sessionId, a.agentId + ' · ' + r.sessionId)
  }

  if (!items) return <div className="text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Automations run agents without you: on a <strong>cron schedule</strong>, when an external service hits a
        <strong> webhook</strong>, on a <strong>Composio event</strong>, or on a <strong>Slack</strong> / <strong>Discord
        message</strong> (the company bot @-mentioned or DMed → run an agent, as the member who sent it). Each firing spawns a normal
        session — its task lands in the Inbox and any risky action still waits for approval.
      </p>

      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Configured</div>
        {items.length === 0 && <div className="text-sm text-muted-foreground">No automations yet{isAdmin ? ' — create one below.' : '.'}</div>}
        <div className="space-y-2">
          {items.map((a) => (
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
                    {a.type === 'cron' && <span className="ml-2 font-mono">{a.schedule}</span>}
                    {(a.type === 'composio' || a.type === 'slack' || a.type === 'discord') && <span className="ml-2 font-mono">{a.filter || 'any event'}</span>}
                    {a.lastFiredAt ? <span className="ml-2">last fired {new Date(a.lastFiredAt).toLocaleString()}</span> : <span className="ml-2">never fired</span>}
                  </div>
                  {a.type === 'cron' && a.mode === 'interactive' && (
                    <div className="mt-1 text-[11px] text-amber-600">Interactive sessions stay open until closed — this cron won't re-fire while its last run is still running.</div>
                  )}
                  <div className="mt-1 truncate text-xs text-muted-foreground">{a.task}</div>
                  {a.hookUrl && <div className="mt-2 w-full max-w-xl"><CopyLink link={a.hookUrl} /></div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="secondary" disabled={busy === a.id} onClick={() => runNow(a)} title="fire once now">
                    <Play className="mr-1 h-3.5 w-3.5" />Run now
                  </Button>
                  {isAdmin && (
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
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === a.id} onClick={() => remove(a)} title="remove">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {hint && <div className="mt-2 font-mono text-xs text-destructive">{hint}</div>}
      </section>

      {isAdmin && (
        <section>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">New automation</div>
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning site check" /></Field>
                <Field label="Agent">
                  <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          <span className="flex items-center gap-1.5">{a.id}<RuntimeBadge runtime={a.runtime} /></span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Trigger">
                  <Select value={type} onValueChange={(v) => v && setType(v as 'cron' | 'webhook' | 'composio' | 'slack' | 'discord')}>
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
                  <Select value={mode} onValueChange={(v) => v && setMode(v as 'interactive' | 'headless')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="headless">Headless (recommended)</SelectItem>
                      <SelectItem value="interactive">Interactive</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {type === 'cron' ? (
                  <Field label="Schedule" help="5-field cron — e.g. */30 * * * * (every 30 min), 0 9 * * 1-5 (9:00 weekdays)">
                    <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} className="font-mono" />
                  </Field>
                ) : type === 'webhook' ? (
                  <Field label="Webhook" help="A secret URL is generated on create — POST to it to fire this automation.">
                    <Input disabled value="URL generated after create" />
                  </Field>
                ) : type === 'slack' ? (
                  <Field label="Trigger filter" help="Scope to an event type (app_mention / message) or a channel id (e.g. C0123…). Blank = any Slack message the app receives. Needs Slack tokens in Settings → Integrations.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="app_mention  ·  or a channel id  (blank = any)" />
                  </Field>
                ) : type === 'discord' ? (
                  <Field label="Trigger filter" help="Scope to an event type (mention / direct_message) or a channel id. Blank = any Discord message the bot receives. Needs a bot token in Settings → Integrations.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="mention  ·  or a channel id  (blank = any)" />
                  </Field>
                ) : (
                  <Field label="Trigger filter" help="Composio trigger slug to match — e.g. SLACK_DIRECT_MESSAGE_RECEIVED. Blank = any Composio event. Needs a webhook secret in Settings → Integrations.">
                    <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono" placeholder="SLACK_DIRECT_MESSAGE_RECEIVED  (blank = any)" />
                  </Field>
                )}
              </div>
              <Field label="Task">
                <Textarea value={task} onChange={(e) => setTask(e.target.value)} className="min-h-[64px]" placeholder="What should the agent do each time this fires? (Webhook payloads are appended automatically.)" />
              </Field>
              <div className="flex items-center gap-3">
                <Button onClick={create} disabled={!name.trim() || !task.trim() || !agentId}><Plus className="mr-1 h-4 w-4" />Create</Button>
                {hint && <span className="font-mono text-xs text-destructive">{hint}</span>}
              </div>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}

// ── Memory ─────────────────────────────────────────────────────────────────────
/** Internal namespace tags the OS adds (agent:<id> / tenant:<t>) aren't shown to the user. */
const visibleTags = (tags: string[]): string[] => tags.filter((t) => !t.startsWith('agent:') && !t.startsWith('tenant:'))

function KnowledgeBasePage({ me }: { me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [pages, setPages] = useState<KbPage[] | null>(null)
  const [sections, setSections] = useState<string[]>([])
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
    setCreating(false); setNSection(''); setNSlug(''); setNTitle(''); setNBody(''); setNTags(''); await load(); if (r.page) open(r.page.id)
  }
  const revert = async (rev: number) => { if (!sel || !window.confirm(`Revert to rev ${rev}? This creates a new revision.`)) return; const r = await api.kbRevert(sel.id, rev); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed')); open(sel.id); load() }
  const remove = async () => { if (!sel || !window.confirm('Delete this page? Its revision history is kept.')) return; const r = await api.kbDelete(sel.id); if (r.error || !r.ok) return setHint('⚠ ' + (r.error ?? 'failed')); setSel(null); load() }

  return (
    <div className="flex gap-4">
      {/* left: search + section/page tree */}
      <div className="w-64 shrink-0 space-y-3">
        <div className="flex gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="search the wiki…" className="h-8 text-xs" />
          <Button size="sm" variant="outline" className="h-8 shrink-0 px-2" onClick={() => load()}>Go</Button>
        </div>
        <Button size="sm" className="w-full" onClick={() => { setCreating(true); setSel(null); setEditing(false) }}><Plus className="mr-1 h-3.5 w-3.5" />New page</Button>
        <div className="space-y-3">
          {pages === null && <div className="text-xs text-muted-foreground">Loading…</div>}
          {pages !== null && pages.length === 0 && <div className="text-xs text-muted-foreground">No pages yet. Agents and you write them; the self-learning pass also keeps an <code className="text-[10px]">operations/fleet-learnings</code> page.</div>}
          {sections.map((s) => (
            <div key={s}>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{s}</div>
              <div className="space-y-0.5">
                {(pages ?? []).filter((p) => p.section === s).map((p) => (
                  <button key={p.id} onClick={() => open(p.id)} className={`block w-full truncate rounded px-2 py-1 text-left text-xs ${sel?.id === p.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`} title={`${p.section}/${p.slug}`}>{p.title}</button>
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
              <Field label="Section" help="folder, e.g. engineering"><Input value={nSection} onChange={(e) => setNSection(e.target.value)} placeholder="engineering" className="font-mono text-xs" /></Field>
              <Field label="Slug" help="url id, e.g. deploy-runbook"><Input value={nSlug} onChange={(e) => setNSlug(e.target.value)} placeholder="deploy-runbook" className="font-mono text-xs" /></Field>
              <Field label="Title"><Input value={nTitle} onChange={(e) => setNTitle(e.target.value)} placeholder="Deploy Runbook" /></Field>
            </div>
            <Field label="Body (markdown)"><Textarea value={nBody} onChange={(e) => setNBody(e.target.value)} className="min-h-[240px] font-mono text-xs" placeholder="# Deploy Runbook&#10;&#10;Steps…  Link pages with [[section/slug]]." /></Field>
            <Field label="Tags" help="comma-separated"><Input value={nTags} onChange={(e) => setNTags(e.target.value)} placeholder="deploy, ops" /></Field>
            <div className="flex gap-2">
              <Button onClick={create} disabled={busy || !nSection.trim() || !nSlug.trim()}><Check className="mr-1 h-4 w-4" />Create</Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </CardContent></Card>
        ) : sel ? (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">{sel.title}</div>
                <div className="text-[11px] text-muted-foreground"><code>{sel.section}/{sel.slug}</code> · rev {sel.rev} · updated {new Date(sel.updatedAt).toLocaleString()} by {sel.updatedBy}</div>
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

function MemoryPage({ agents, me }: { agents: AgentInfo[]; me: Member }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MemoryRecord[] | null>(null)
  const [health, setHealth] = useState<MemoryHealth | null>(null)
  const [scopeFilter, setScopeFilter] = useState<'all' | 'agent' | 'tenant'>('all')
  // add form
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [shareNew, setShareNew] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => { if (!agentId && agents[0]) setAgentId(agents[0].id) }, [agents, agentId])
  useEffect(() => { api.memoryHealth().then(setHealth).catch(() => {}) }, [])

  const load = (q = query) => {
    if (!agentId) return
    api.memory(agentId, q, 50, scopeFilter).then((r) => setItems(r.memories ?? [])).catch(() => setItems([]))
  }
  // Reload whenever the selected agent or the scope filter changes (keeps the current search).
  useEffect(() => { setItems(null); load(query) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agentId, scopeFilter])

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

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Each agent keeps a persistent memory across its sessions — decisions, fixes, gotchas, preferences. Agents
        <span className="font-mono text-xs"> recall</span> it themselves — when a task calls for it — and
        <span className="font-mono text-xs"> remember</span> new facts as they work. Browse and curate that memory
        here; what you add is recalled just like what the agent stored.
      </p>

      {/* Agent picker + search + backend health */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[220px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Agent</label>
          <Select value={agentId} onValueChange={(v) => v && setAgentId(v)}>
            <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="flex items-center gap-1.5">{a.id}<RuntimeBadge runtime={a.runtime} /></span>
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
            <TabButton on={scopeFilter === 'tenant'} onClick={() => setScopeFilter('tenant')}>Shared</TabButton>
          </div>
        </div>
        {health && (
          <Badge variant={health.ok ? 'default' : 'destructive'} className="mb-1.5 px-1.5 py-0 text-[10px] font-normal" title={health.detail}>
            {health.backend}{health.detail ? ` · ${health.detail}` : ''}
          </Badge>
        )}
      </div>

      {/* Memories */}
      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          {query ? 'Matches' : 'Recent'}
        </div>
        {items === null && <div className="text-sm text-muted-foreground">Loading…</div>}
        {items !== null && items.length === 0 && (
          <div className="text-sm text-muted-foreground">
            {query ? 'No memories match that search.' : 'No memories yet — the agent will accrete them as it works, or add one below.'}
          </div>
        )}
        <div className="space-y-2">
          {items?.map((m) => (
            <MemoryCard key={m.id} m={m} agentId={agentId} me={me} onChanged={() => load()} />
          ))}
        </div>
      </section>

      {/* Add a memory (curated knowledge — same store the agent recalls from) */}
      <section>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Add a memory</div>
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
  return (
    <Card className="group">
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm">{m.content}</div>
          {canEdit && (
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
              <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="edit" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="delete" disabled={busy} onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {m.scope === 'tenant' && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-sky-600" title={`shared workspace-wide · authored by ${m.agentId}`}>shared</Badge>
          )}
          {m.type && <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{m.type}</Badge>}
          {tagsShown.map((t) => (
            <Badge key={t} variant="outline" className="px-1.5 py-0 text-[10px] font-normal">{t}</Badge>
          ))}
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
    const r = await api.createAgent({ id: slug, description: description.trim(), claudeMd, examplePrompts, ...tuning })
    setBusy(false)
    if (!r.ok || r.error) return setHint('⚠ ' + (r.error || 'failed to create agent'))
    onCreated(r.id || slug)
  }

  return (
    <div className="max-w-3xl space-y-4">
      <button onClick={() => { window.location.hash = '/agents' }} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Agents
      </button>
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
function AgentTuningCard({ agentId }: { agentId: string }) {
  const [tuning, setTuning] = useState<RuntimeTuning>({})
  const [saved, setSaved] = useState<RuntimeTuning>({})
  const [prompts, setPrompts] = useState('')
  const [savedPrompts, setSavedPrompts] = useState('')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  useEffect(() => {
    api.agentConfig(agentId).then((r) => {
      if (r.error) return
      const t: RuntimeTuning = { model: r.model, effort: r.effort, permissionMode: r.permissionMode }
      const p = (r.examplePrompts ?? []).join('\n')
      setTuning(t); setSaved(t); setPrompts(p); setSavedPrompts(p)
    }).catch(() => {})
  }, [agentId])

  const dirty = JSON.stringify(tuning) !== JSON.stringify(saved) || prompts !== savedPrompts
  const save = async () => {
    setBusy(true); setHint('')
    const examplePrompts = prompts.split('\n').map((s) => s.trim()).filter(Boolean)
    const r = await api.saveAgentConfig(agentId, { ...tuning, examplePrompts })
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    const t: RuntimeTuning = { model: r.model, effort: r.effort, permissionMode: r.permissionMode }
    const p = (r.examplePrompts ?? []).join('\n')
    setTuning(t); setSaved(t); setPrompts(p); setSavedPrompts(p); setHint('saved — applies on the next session'); setTimeout(() => setHint(''), 2500)
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-xs font-medium"><SlidersHorizontal className="h-3.5 w-3.5" /> Runtime tuning</div>
        <TuningFields tuning={tuning} onChange={setTuning} />
        <div className="space-y-1">
          <label className="text-xs font-medium">Starter prompts</label>
          <Textarea value={prompts} onChange={(e) => setPrompts(e.target.value)} className="min-h-[70px] text-sm" placeholder={'One per line — clickable chips on the spawn card (up to 6).'} />
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

function AgentPage({ agentId, agents }: { agentId: string; agents: AgentInfo[] }) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const info = agents.find((a) => a.id === agentId)

  useEffect(() => {
    setLoaded(false)
    api.agentClaude(agentId).then((r) => {
      if (r.error) { setHint('⚠ ' + r.error); return }
      setContent(r.content ?? ''); setSaved(r.content ?? ''); setLoaded(true)
    }).catch(() => {})
  }, [agentId])

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
      <button onClick={() => { window.location.hash = '/agents' }} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Agents
      </button>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{agentId}</span>
        {info && <RuntimeBadge runtime={info.runtime} />} — this agent's <span className="font-mono text-xs">CLAUDE.md</span> is its
        system prompt: its role, conventions, and how it should use its tools (including when to
        <span className="font-mono text-xs"> recall</span>/<span className="font-mono text-xs">remember</span>). Applied on the agent's next session.
      </p>
      {info?.runtime === 'claude-code' && <AgentTuningCard agentId={agentId} />}
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
    </div>
  )
}

// ── Skills (the global Claude Code Skills library) ──────────────────────────────────
/** The workspace skills library: native `.claude/skills` SKILL.md playbooks synced into every
 *  claude-code agent at launch. Per-agent skills live in the agent's own folder (see Files). */
function SkillsPage() {
  const [resp, setResp] = useState<SkillsResp | null>(null)
  const [creating, setCreating] = useState(false)
  const load = () => api.skills().then(setResp).catch(() => setResp({ enabled: false, skills: [] }))
  useEffect(() => { load() }, [])

  if (!resp) return <div className="text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Skills are reusable, named playbooks in Claude Code's native <span className="font-mono text-xs">.claude/skills</span> format.
        Every skill here is synced into <span className="font-medium text-foreground">every claude-code agent</span> at launch — an agent
        auto-invokes one when its <span className="font-mono text-xs">description</span> matches the task, or you can call it with <span className="font-mono text-xs">/name</span>.
        To give just one agent a skill, drop it in that agent's folder (browse via{' '}
        <button className="underline hover:text-foreground" onClick={() => { window.location.hash = '/files' }}>Files</button>); a same-named agent skill shadows the global one.
      </p>

      {!resp.enabled && (
        <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          Skills need a data home — none is configured for this instance.
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Library · {resp.skills.length}</div>
          {resp.enabled && !creating && (
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="mr-1 h-4 w-4" />New skill</Button>
          )}
        </div>
        {creating && <NewSkillForm onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); load() }} />}
        {resp.skills.length === 0 && !creating && (
          <div className="text-sm text-muted-foreground">No skills yet — add one to give every agent a shared playbook.</div>
        )}
        <div className="space-y-2">
          {resp.skills.map((s) => <SkillCard key={s.name} s={s} onChanged={load} />)}
        </div>
      </section>
    </div>
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

function SkillCard({ s, onChanged }: { s: SkillSummary; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
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
            </div>
            <div className="mt-1 text-sm text-muted-foreground">{s.description || <span className="italic">no description</span>}</div>
          </button>
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="edit" onClick={editing ? () => setEditing(false) : open}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="delete" disabled={busy} onClick={remove}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
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
        {!editing && hint && <div className="mt-1 font-mono text-xs text-destructive">{hint}</div>}
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
function DreamingSettings({ me }: { me: Member }) {
  const isAdmin = me.role === 'owner' || me.role === 'admin'
  const [everyHours, setEveryHours] = useState('0')
  const [last, setLast] = useState<number | undefined>(undefined)
  const [apply, setApply] = useState(true)
  const [guidance, setGuidance] = useState('')
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const [result, setResult] = useState<string>('')

  const refresh = () => api.dreaming().then((r) => { if (r.error) return; setEveryHours(String(r.everyHours ?? 0)); setLast(r.lastDreamedAt); setApply(r.applyLearnings !== false); setGuidance(r.guidance ?? ''); setRecs(r.recommendations ?? []) }).catch(() => {})
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
    setResult(r.skipped ? 'No new activity since the last pass — nothing to learn.' : `Reflected on ${r.sessions ?? 0} sessions / ${r.episodes ?? 0} episodes → updated the KB page${r.insightId ? ' + a shared memory insight' : ''}${r.guidance ? ' + refreshed the agent guidance below' : ''}.`)
    refresh()
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        The OS reflects on what its agents have been doing — the per-session <strong>episodes</strong> they wrote, run
        <strong> outcomes</strong>, and <strong>friction</strong> (approvals rejected, budget stops, errors) — and distils it
        into a shared <strong>memory insight</strong> every agent recalls, plus a living Knowledge page
        (<a className="underline" href="#/kb">operations/fleet-learnings</a>) that's rewritten each pass and revision-chained.
      </p>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-end gap-3">
            <Field label="Run automatically every (hours)" help="0 = off (manual only). The pass is cheap; daily (24) is a sensible default.">
              <Input value={everyHours} onChange={(e) => setEveryHours(e.target.value)} className="w-28 font-mono text-xs" placeholder="0" />
            </Field>
            <Button onClick={save} disabled={busy}>Save</Button>
            <Button variant="outline" onClick={runNow} disabled={busy}><Sparkles className="mr-1 h-4 w-4" />Run now</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {last ? `Last pass: ${new Date(last).toLocaleString()}.` : 'No pass has run yet.'}
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
                        : r.link && <Button size="sm" variant="outline" onClick={() => { window.location.hash = r.link!.replace(/^#/, '') }}>Review</Button>}
                      <Button size="sm" variant="ghost" onClick={() => dismissRec(r.id)} disabled={busy}>Dismiss</Button>
                    </div>
                  </div>
                </div>
              ))}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">This pass is deterministic aggregation (zero cost). A richer LLM "gardener" — a scheduled agent that synthesizes prose into the KB via its <code className="text-[10px]">kb_write</code> tool — can layer on top later.</p>
    </div>
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
          <Select value={type || '__all'} onValueChange={(v) => { const t = !v || v === '__all' ? '' : v; setType(t); load({ type: t }) }}>
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

function SettingsPage({ me }: { me: Member }) {
  const [tab, setTab] = useState<'company' | 'runtime' | 'integrations' | 'memory' | 'dreaming' | 'policy' | 'governance'>('company')
  if (me.role !== 'owner' && me.role !== 'admin') return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex gap-1 rounded-lg border bg-background p-1 w-fit">
        <TabButton on={tab === 'company'} onClick={() => setTab('company')}>Company context</TabButton>
        <TabButton on={tab === 'runtime'} onClick={() => setTab('runtime')}>Runtime defaults</TabButton>
        <TabButton on={tab === 'integrations'} onClick={() => setTab('integrations')}>Integrations</TabButton>
        <TabButton on={tab === 'memory'} onClick={() => setTab('memory')}>Memory</TabButton>
        <TabButton on={tab === 'dreaming'} onClick={() => setTab('dreaming')}>Self-learning</TabButton>
        <TabButton on={tab === 'governance'} onClick={() => setTab('governance')}>Governance</TabButton>
        <TabButton on={tab === 'policy'} onClick={() => setTab('policy')}>Policy</TabButton>
      </div>
      {tab === 'company' ? <CompanySettings me={me} />
        : tab === 'runtime' ? <RuntimeDefaultsSettings me={me} />
        : tab === 'integrations' ? <IntegrationsSettings me={me} />
        : tab === 'memory' ? <MemorySettings me={me} />
        : tab === 'dreaming' ? <DreamingSettings me={me} />
        : tab === 'governance' ? <GovernanceSettings me={me} />
        : <PolicyEditor me={me} />}
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
  const canEdit = me.role === 'owner' || me.role === 'admin'

  useEffect(() => {
    api.governance().then((r) => {
      if (r.error) return
      const v = { moneyCapUsd: r.moneyCapUsd, bulkDeleteCount: r.bulkDeleteCount }
      setT(v); setSaved(v); setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy })
    }).catch(() => {})
  }, [])

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
  )
}

/** Settings → Runtime defaults — the fleet-wide model / effort / permission-mode that every
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
    const t: RuntimeTuning = { model: r.model, effort: r.effort, permissionMode: r.permissionMode }
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
        <TuningFields tuning={tuning} onChange={setTuning} modelPlaceholder="CLI default" inheritLabel="CLI default" />
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
  // maintenance
  const [pruneDays, setPruneDays] = useState('0') // 0 = never prune
  const [keepImp, setKeepImp] = useState('0.5')
  const [dedupeOn, setDedupeOn] = useState(false)
  const [dedupeThresh, setDedupeThresh] = useState('0.95')
  const [everyHours, setEveryHours] = useState('24')
  const [maintBusy, setMaintBusy] = useState(false)
  const [maintMsg, setMaintMsg] = useState('')
  const [curated, setCurated] = useState(false) // shared-write policy: only humans publish shared
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
    const m = v.maintenance
    setPruneDays(String(m?.pruneAfterDays ?? 0))
    setKeepImp(String(m?.keepImportance ?? 0.5))
    setDedupeOn(m?.dedupeThreshold != null)
    if (m?.dedupeThreshold != null) setDedupeThresh(String(m.dedupeThreshold))
    setEveryHours(String(m?.everyHours ?? 24))
    setCurated(v.sharedWrites === 'curated')
  }
  useEffect(() => { api.memorySettings().then((v) => { if (v.error) return setHint('⚠ ' + v.error); apply(v) }).catch(() => {}) }, [])

  // Preset the embedding defaults when toggling provider (the two stacks use different models/dims/ports).
  const pickProvider = (pv: 'openai' | 'ollama') => {
    setProvider(pv)
    if (pv === 'ollama') { setEmbUrl('http://localhost:11434'); setModel('nomic-embed-text'); setDims('768') }
    else { setEmbUrl('https://api.openai.com/v1'); setModel('text-embedding-3-small'); setDims('1536') }
  }

  const emb = () => ({ enabled: embedOn, provider, url: embUrl.trim(), model: model.trim(), dimensions: Number(dims) || undefined, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
  const ranking = () => ({ halfLifeDays: Number(halfLife) || 0, weightByImportance: weightImp })
  const maintenance = () => ({ pruneAfterDays: Number(pruneDays) || 0, keepImportance: Number(keepImp), everyHours: Number(everyHours) || 24, ...(dedupeOn ? { dedupeThreshold: Number(dedupeThresh) } : {}) })
  const sharedWrites = (): 'open' | 'curated' => (curated ? 'curated' : 'open')
  const body = (): MemorySettingsReq => {
    if (backend === 'libsql') {
      return { backend, libsql: { url: url.trim(), ...(authToken.trim() ? { authToken: authToken.trim() } : {}), embeddings: emb() }, ranking: ranking(), maintenance: maintenance(), sharedWrites: sharedWrites() }
    }
    if (backend === 'automem') return { backend, automem: { endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) }, sharedWrites: sharedWrites() }
    return { ...(embedOn ? { backend: 'sqlite', sqlite: { embeddings: emb() } } : { backend: 'sqlite' }), ranking: ranking(), maintenance: maintenance(), sharedWrites: sharedWrites() }
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
    setBusy(true); setHint(''); setTestResult(null)
    const r = await api.saveMemorySettings(body())
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setApiKey(''); setToken(''); setAuthToken('')
    apply(r)
    setHint('saved — applied live'); setTimeout(() => setHint(''), 1800)
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
  const [meta, setMeta] = useState<{ updatedAt?: number; updatedBy?: string }>({})
  const [key, setKey] = useState('')
  const [wh, setWh] = useState('')
  const [appTok, setAppTok] = useState('')
  const [botTok, setBotTok] = useState('')
  const [discordTok, setDiscordTok] = useState('')
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
    setMeta({ updatedAt: r.updatedAt, updatedBy: r.updatedBy })
  }
  const loadStatus = () => {
    api.slackStatus().then((s) => { if (s && !s.error) setSlackState(s) }).catch(() => {})
    api.discordStatus().then((s) => { if (s && !s.error) setDiscordState(s) }).catch(() => {})
  }
  useEffect(() => {
    api.integrations().then((r) => {
      if (r.error) return setHint('⚠ ' + r.error)
      apply(r)
    }).catch(() => {})
    loadStatus()
  }, [])

  const save = async (body: { composioApiKey?: string; composioWebhookSecret?: string; slackAppToken?: string; slackBotToken?: string; discordBotToken?: string }, label: string) => {
    setBusy(true); setHint('')
    const r = await api.saveIntegrations(body)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setKey(''); setWh(''); setAppTok(''); setBotTok(''); setDiscordTok('')
    apply(r)
    setHint(label); setTimeout(() => setHint(''), 1500)
    // The Socket-Mode / Gateway connection re-dials on the server when tokens change — poll the new state.
    if (body.slackAppToken !== undefined || body.slackBotToken !== undefined || body.discordBotToken !== undefined) setTimeout(loadStatus, 1200)
  }

  if (!isAdmin) return <div className="text-sm text-muted-foreground">Owner or admin access required.</div>

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Workspace <strong>integration credentials</strong> — stored once and used by your connectors. The
        <strong> Composio</strong> API key powers Composio-backed connectors: one company key, with each member's
        apps scoped to their own account (their email is the Composio <code className="text-xs">user_id</code>).
      </p>

      <Card>
        <CardContent className="space-y-3 p-4">
          <Field label="Composio API key">
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={composio.set ? `${composio.hint} (saved) — type a new key to replace` : 'comp_…  (Composio dashboard → Settings → API Keys)'}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={() => save({ composioApiKey: key.trim() }, 'saved')} disabled={busy || !key.trim()}>Save</Button>
            {composio.set && <Button variant="ghost" onClick={() => save({ composioApiKey: '' }, 'removed')} disabled={busy}>Remove</Button>}
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
            <div className="text-sm font-medium">Composio webhook secret</div>
            <p className="text-xs text-muted-foreground">
              Lets app events <strong>trigger agents</strong> (Slack message/DM → run an agent). In Composio, create a webhook
              pointing at <code className="text-xs">{`<this-host>`}/triggers/composio</code>, then paste its signing secret
              (<code className="text-xs">whsec_…</code>) here. Then add a <strong>Composio</strong> trigger on the Automations page.
            </p>
          </div>
          <Field label="Signing secret">
            <Input
              type="password"
              value={wh}
              onChange={(e) => setWh(e.target.value)}
              placeholder={webhook.set ? '•••• (saved) — type a new secret to replace' : 'whsec_…'}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={() => save({ composioWebhookSecret: wh.trim() }, 'saved')} disabled={busy || !wh.trim()}>Save</Button>
            {webhook.set && <Button variant="ghost" onClick={() => save({ composioWebhookSecret: '' }, 'removed')} disabled={busy}>Remove</Button>}
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
          <Field label="Bot token" help="OAuth & Permissions → Bot User OAuth Token. Scopes: app_mentions:read, chat:write, users:read, users:read.email, im:history.">
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
        </CardContent>
      </Card>
    </div>
  )
}

function TabButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-md px-3 py-1 text-sm transition-colors ${on ? 'bg-muted font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
      {children}
    </button>
  )
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

// ── Policy editor ──────────────────────────────────────────────────────────────
const OPS: PolicyOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']

// The UI speaks plain outcomes instead of risk colors + a routing table. Each outcome maps onto the
// engine's (risk + fixed routing): Allow=green, Ask admin=yellow→head, Ask owner=red→owner, Block=deny.
type Outcome = 'allow' | 'ask-admin' | 'ask-owner' | 'block'
const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: 'allow', label: 'Allow' },
  { key: 'ask-admin', label: 'Ask admin' },
  { key: 'ask-owner', label: 'Ask owner' },
  { key: 'block', label: 'Block' },
]
const POLICY_OUTCOME_STYLE: Record<Outcome, string> = {
  'allow': 'border-emerald-300 bg-emerald-50 text-emerald-700',
  'ask-admin': 'border-amber-300 bg-amber-50 text-amber-700',
  'ask-owner': 'border-red-300 bg-red-50 text-red-700',
  'block': 'border-neutral-400 bg-neutral-100 text-neutral-700',
}
const CANON_ROUTING = { yellow: 'head' as const, red: 'owner' as const } // Ask admin→yellow, Ask owner→red
function riskToOutcome(risk: RiskClass, routing: { yellow: 'head' | 'owner'; red: 'head' | 'owner' }): Outcome {
  if (risk === 'green') return 'allow'
  if (risk === 'deny') return 'block'
  const level = risk === 'yellow' ? routing.yellow : routing.red
  return level === 'owner' ? 'ask-owner' : 'ask-admin'
}
function outcomeToRisk(o: Outcome): RiskClass {
  return o === 'allow' ? 'green' : o === 'block' ? 'deny' : o === 'ask-admin' ? 'yellow' : 'red'
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
  const routing = doc.approvalRouting ?? CANON_ROUTING
  const set = (patch: Partial<PolicyDocument>) => setDoc({ ...doc, ...patch })
  const setRule = (i: number, r: PolicyRule) => set({ rules: doc.rules.map((x, j) => (j === i ? r : x)) })
  const addRule = () => set({ rules: [...doc.rules, { match: { capability: '' }, risk: 'yellow' }], approvalRouting: CANON_ROUTING })
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
    if (idx >= 0) return { outcome: riskToOutcome(doc.rules[idx].risk, routing), fromDefault: false }
    return { outcome: riskToOutcome(doc.defaultRisk, routing), fromDefault: true }
  }
  const setPerm = (perm: { cap: string; risky: boolean }, outcome: Outcome) => {
    const risk = outcomeToRisk(outcome)
    const rules = [...doc.rules]
    const idx = permRuleIndex(rules, perm)
    if (idx >= 0) {
      rules[idx] = { ...rules[idx], risk }
    } else {
      const rule: PolicyRule = { match: { capability: perm.cap, ...(perm.risky ? { when: { arg: 'risky', op: 'eq', value: true } } : {}) }, risk }
      if (perm.risky) {
        const broad = rules.findIndex((r) => r.match.capability === perm.cap && !r.match.when)
        rules.splice(broad >= 0 ? broad : 0, 0, rule)
      } else rules.push(rule)
    }
    set({ rules, approvalRouting: CANON_ROUTING })
  }
  const setDefault = (outcome: Outcome) => set({ defaultRisk: outcomeToRisk(outcome) })

  const save = async () => {
    setBusy(true); setHint('')
    const normalized: PolicyDocument = { ...doc, approvalRouting: CANON_ROUTING }
    const r = await api.savePolicy(normalized)
    setBusy(false)
    if (r.error) return setHint('⚠ ' + r.error)
    setDoc(normalized); setSaved(JSON.stringify(normalized)); setHint('saved — applied live to all sessions')
    setTimeout(() => setHint(''), 2500)
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        What your agents may do on their own — and what needs a human. <strong>Allow</strong> runs immediately,
        <strong> Ask</strong> pauses for an admin or owner to approve in the Inbox, <strong>Block</strong> never runs.
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
            <OutcomeSelect value={riskToOutcome(doc.defaultRisk, routing)} disabled={!canEdit} onChange={setDefault} />
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
                    <OutcomeSelect value={riskToOutcome(r.risk, routing)} disabled={!canEdit} onChange={(v) => setRule(i, { ...r, risk: outcomeToRisk(v) })} />
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
