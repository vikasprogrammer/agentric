import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type AgentInfo, type Automation, type MemoryRecord, type Member, type RuntimeTuning, type Session } from '@/lib/api'
import { buildAgents, overviewStats, relTime, sessionRow, type AgentVM, type Status } from './data'
import './v2.css'

// Agentric v2 — the agent-first console, wired to live data. Each agent carries its own
// automations, insights, memory and settings; the classic multi-page app lives untouched at "/".
//
// Data: /api/state (roster + me), /api/sessions (status + recent runs), /api/automations (per agent),
// and lazily /api/memory, /api/agents/:id/{config,claude,stats}. All reads for this cut — actions
// (send, run, edit) link back to the classic app for now.

function toggleTheme() {
  const root = document.documentElement
  const cur = root.getAttribute('data-theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark')
}

const TAB_KEYS = ['overview', 'automations', 'insights', 'memory', 'settings'] as const
type TabKey = (typeof TAB_KEYS)[number]

function StatePill({ status, text }: { status: Status; text: string }) {
  return <span className={`status-pill ${status}`}>{status === 'idle' ? '●' : null} {text}</span>
}

/* ─────────────────────────── Overview (chat-first) ─────────────────────────── */

function Overview({ agent }: { agent: AgentVM }) {
  const now = Date.now()
  const stats = overviewStats(agent.sessions, now)
  const recent = agent.sessions.slice(0, 6)
  return (
    <div className="panel">
      <p className="thesis">Everything about this agent lives here — no hunting across a dozen global pages.</p>
      <div className="console">
        <div className="prompt">
          <textarea rows={1} placeholder={`Message ${agent.id}…  ask it to do something, or start a session`} />
          <a className="send" title="Open a session in the classic console" href={`/?spawn=${encodeURIComponent(agent.id)}`}>↑</a>
        </div>
        <div className="row2">
          <span className="chip">▤ Create a task</span>
          <span className="chip">◈ run-as: you</span>
          <a className="chip" href={`/?spawn=${encodeURIComponent(agent.id)}`}>◱ Open live session</a>
        </div>
      </div>
      <div className="stat-row">
        <div className="stat"><div className="k">Runs · 7d</div><div className="v">{stats.runs}</div><div className="sub">across all triggers</div></div>
        <div className="stat"><div className="k">Cost · 7d</div><div className="v">{stats.cost}</div><div className="sub">sum of run cost</div></div>
        <div className="stat"><div className="k">Live now</div><div className="v">{stats.live}</div><div className="sub">sessions alive</div></div>
        <div className="stat"><div className="k">Needs you</div><div className="v">{stats.needs}</div><div className="sub">blocked on a human</div></div>
      </div>
      <div className="section-title"><h3>Recent sessions</h3><a href="/">All sessions →</a></div>
      {recent.length === 0
        ? <div className="empty">No sessions yet — message this agent above to start one.</div>
        : (
          <div className="list">
            {recent.map((s) => {
              const r = sessionRow(s, now)
              return (
                <div className="item" key={r.key}>
                  <span className={`dot ${r.tag || 'idle'}`} style={r.tag ? undefined : { opacity: 0.4 }} />
                  <span className="grow"><div className="t">{r.t}</div><div className="d">{r.d}</div></span>
                  {r.tag
                    ? <span className={`tag ${r.tag}`}>{r.tagText}</span>
                    : <span className={`verdict ${r.verdict === 'ok' ? 'ok' : 'warn'}`}>{r.verText}</span>}
                  <span className="when">{r.when}</span>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

/* ─────────────────────────── Automations ─────────────────────────── */

function autoDetail(a: Automation): string {
  const bits: string[] = [a.type]
  if (a.type === 'cron' && a.schedule) bits.push(a.schedule)
  else if (a.filter) bits.push(a.filter)
  return bits.join(' · ')
}
function Automations({ items, loading }: { items: Automation[] | undefined; loading: boolean }) {
  if (loading || !items) return <div className="panel"><div className="empty">Loading automations…</div></div>
  if (!items.length) {
    return (
      <div className="panel">
        <div className="empty">
          No automations yet. This agent only runs when you message it or hand it a task.
          <br /><br />
          <a className="btn ghost" href="/">＋ Add a trigger in the classic console</a>
        </div>
      </div>
    )
  }
  return (
    <div className="panel">
      <div className="section-title"><h3>Triggers that wake this agent</h3><a href="/">＋ Add trigger</a></div>
      <div className="list">
        {items.map((a) => (
          <div className="item" key={a.id}>
            <span className={`dot ${a.enabled ? 'run' : 'idle'}`} style={a.enabled ? { boxShadow: 'none' } : { opacity: 0.4 }} />
            <span className="grow"><div className="t">{a.name}</div><div className="d">{autoDetail(a)}</div></span>
            <span className="when">{a.lastFiredAt ? `${relTime(a.lastFiredAt)} ago` : (a.nextRunAt ? 'scheduled' : 'idle')}</span>
            <span className={`tag ${a.enabled ? 'run' : ''}`}>{a.enabled ? 'on' : 'off'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── Insights (this agent's real stats) ─────────────────────────── */

function pct(n: number): string { return `${Math.round(n * 100)}%` }

function Insights({ stats, loading }: { stats: import('@/lib/api').AgentStats | undefined; loading: boolean }) {
  if (loading || !stats) return <div className="panel"><div className="empty">Reading this agent’s track record…</div></div>
  if (stats.confidence === 'none' || stats.runs.total === 0) {
    return <div className="panel"><div className="empty">No signal yet — insights build up once this agent has some graded runs.</div></div>
  }
  const rows: { t: string; d: string; when: string }[] = [
    { t: `Maturity ${pct(stats.maturity)} · ${stats.confidence} confidence`, d: `Autonomy ${pct(stats.autonomy)}, denial rate ${pct(stats.denialRate)}, over ${stats.runs.total} runs (${stats.runs.done} done, ${stats.runs.crashed} crashed).`, when: stats.lastRunAt ? `${relTime(stats.lastRunAt)} ago` : '' },
    { t: `Human ratings: ${stats.rated.up}↑ / ${stats.rated.down}↓`, d: stats.successRate != null ? `Self-reported success rate ${pct(stats.successRate)} across ${stats.outcomes.success + stats.outcomes.failure + stats.outcomes.inconclusive} reported runs.` : 'Not enough reported outcomes to rate success yet.', when: '' },
    { t: `Gate: ${stats.actions.autoApproved} auto-approved, ${stats.actions.humanGated} sent to a human, ${stats.actions.denied} denied`, d: `${stats.actions.governed} governed effects total. ${stats.deniedRuns} run(s) hit a hard deny.`, when: '' },
  ]
  return (
    <div className="panel">
      <p className="thesis">Learned from this agent’s own runs — the fleet-wide Insights page folds into each agent.</p>
      <div className="list">
        {rows.map((x, i) => (
          <div className="item" key={i}>
            <span className="grow" style={{ padding: '2px 0' }}><div className="t">{x.t}</div><div className="d">{x.d}</div></span>
            {x.when ? <span className="when">{x.when}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────── Memory ─────────────────────────── */

function Memory({ items, loading }: { items: MemoryRecord[] | undefined; loading: boolean }) {
  if (loading || !items) return <div className="panel"><div className="empty">Loading memory…</div></div>
  if (!items.length) return <div className="panel"><div className="empty">This agent hasn’t remembered anything yet.</div></div>
  const now = Date.now()
  return (
    <div className="panel">
      <div className="section-title"><h3>What this agent remembers</h3><a href="/">Search memory →</a></div>
      {items.map((m) => (
        <div className="memory-card" key={m.id}>
          <div className="body">{m.content}</div>
          <div className="foot">
            <span className="kind">{m.type || 'note'}</span>
            {m.scope === 'tenant' ? <span className="kind">shared</span> : null}
            <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>{relTime(m.ts, now)} ago</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─────────────────────────── Settings (real tuning, read-only this cut) ─────────────────────────── */

function Seg({ current, opts }: { current?: string; opts: string[] }) {
  return (
    <div className="seg">
      {opts.map((o) => <button key={o} className={o === current ? 'on' : ''}>{o}</button>)}
    </div>
  )
}

function Settings({ config, prompt, loading }: { config: (RuntimeTuning & { description?: string }) | undefined; prompt: string | undefined; loading: boolean }) {
  if (loading || !config) return <div className="panel"><div className="empty">Loading settings…</div></div>
  return (
    <div className="panel">
      <p className="thesis">Reflecting this agent’s live config. Editing lands next — for now, changes are made in the classic console.</p>
      <div className="field">
        <div className="lbl">Model<div className="h">The engine this agent runs on</div></div>
        <Seg current={config.model || 'workspace default'} opts={['haiku-4.5', 'sonnet-5', 'opus-4.8', config.model || 'workspace default'].filter((v, i, a) => a.indexOf(v) === i)} />
      </div>
      <div className="field">
        <div className="lbl">Reasoning effort<div className="h">Depth vs. speed &amp; cost</div></div>
        <Seg current={config.effort || 'inherit'} opts={['low', 'medium', 'high', 'xhigh', 'max']} />
      </div>
      <div className="field">
        <div className="lbl">Verbosity<div className="h">Terse compresses narration only — never artifacts</div></div>
        <Seg current={config.verbosity || 'normal'} opts={['normal', 'terse']} />
      </div>
      <div className="field">
        <div className="lbl">System prompt<div className="h">CLAUDE.md · this agent’s identity</div></div>
        <div className="prompt-box">{prompt && prompt.trim() ? prompt : 'No CLAUDE.md for this agent.'}</div>
      </div>
    </div>
  )
}

/* ─────────────────────────── Workspace ─────────────────────────── */

interface Detail {
  automations?: Automation[]
  memory?: MemoryRecord[]
  stats?: import('@/lib/api').AgentStats
  config?: RuntimeTuning & { description?: string }
  prompt?: string
}

function Workspace({ agent, tab, onTab, detail, loadingTab }: {
  agent: AgentVM; tab: TabKey; onTab: (t: TabKey) => void; detail: Detail; loadingTab: boolean
}) {
  const counts: Record<string, number | undefined> = {
    automations: detail.automations?.length,
    memory: detail.memory?.length,
  }
  return (
    <main className="workspace">
      <div className="ws-head">
        <div style={{ flex: 1 }}>
          <div className="ws-title">{agent.id} <StatePill status={agent.status} text={agent.statusText} /></div>
          <div className="ws-handle">{agent.handle}</div>
          <div className="ws-blurb">{agent.blurb}</div>
        </div>
        <a className="btn" href={`/?spawn=${encodeURIComponent(agent.id)}`}>Run agent</a>
      </div>
      <nav className="subnav">
        {TAB_KEYS.map((k) => (
          <button key={k} className={k === tab ? 'active' : ''} onClick={() => onTab(k)}>
            {k[0].toUpperCase() + k.slice(1)}
            {counts[k] != null ? <span className="count">{counts[k]}</span> : null}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview agent={agent} />}
      {tab === 'automations' && <Automations items={detail.automations} loading={loadingTab} />}
      {tab === 'insights' && <Insights stats={detail.stats} loading={loadingTab} />}
      {tab === 'memory' && <Memory items={detail.memory} loading={loadingTab} />}
      {tab === 'settings' && <Settings config={detail.config} prompt={detail.prompt} loading={loadingTab} />}
    </main>
  )
}

/* ─────────────────────────── App ─────────────────────────── */

export default function App() {
  const [me, setMe] = useState<Member | null | undefined>(undefined) // undefined = still checking
  const [agentsInfo, setAgentsInfo] = useState<AgentInfo[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [tenant, setTenant] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [filter, setFilter] = useState('')

  // Per-agent lazy detail cache, keyed by agent id.
  const [details, setDetails] = useState<Record<string, Detail>>({})
  const [loadingTab, setLoadingTab] = useState(false)
  const inflight = useRef<Set<string>>(new Set())

  // Initial load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const m = await api.me()
      if (cancelled) return
      setMe(m)
      if (!m) return
      try {
        const [state, sess] = await Promise.all([api.state(), api.sessions()])
        if (cancelled) return
        setTenant(state.tenantName || state.tenant)
        setAgentsInfo(state.agents || [])
        setSessions(Array.isArray(sess) ? sess : [])
        setSelectedId((state.agents && state.agents[0]?.id) || null)
      } catch {
        if (!cancelled) setError('Could not load the fleet. Is the server reachable?')
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const agents = useMemo(() => buildAgents(agentsInfo, sessions), [agentsInfo, sessions])
  const shown = useMemo(
    () => agents.filter((a) => a.id.toLowerCase().includes(filter.toLowerCase())),
    [agents, filter],
  )
  const agent = agents.find((a) => a.id === selectedId) || agents[0] || null

  // Lazy-load the detail a tab needs, once per (agent, tab), cached.
  const loadDetail = useCallback(async (agentId: string, which: TabKey) => {
    if (which === 'overview') return
    const key = `${agentId}:${which}`
    const have = details[agentId]
    if (which === 'automations' && have?.automations) return
    if (which === 'memory' && have?.memory) return
    if (which === 'insights' && have?.stats) return
    if (which === 'settings' && have?.config) return
    if (inflight.current.has(key)) return
    inflight.current.add(key)
    setLoadingTab(true)
    try {
      const patch: Detail = {}
      if (which === 'automations') {
        const r = await api.automations()
        patch.automations = (r.automations || []).filter((a) => a.agentId === agentId)
      } else if (which === 'memory') {
        const r = await api.memory(agentId, '', 40)
        patch.memory = r.memories || []
      } else if (which === 'insights') {
        const r = await api.agentStats(agentId)
        patch.stats = r.stats
      } else if (which === 'settings') {
        const [cfg, cl] = await Promise.all([api.agentConfig(agentId), api.agentClaude(agentId)])
        patch.config = cfg
        patch.prompt = cl.content || ''
      }
      setDetails((prev) => ({ ...prev, [agentId]: { ...prev[agentId], ...patch } }))
    } catch {
      /* leave the tab in its loading-fallback empty state */
    } finally {
      inflight.current.delete(key)
      setLoadingTab(false)
    }
  }, [details])

  useEffect(() => {
    if (agent) void loadDetail(agent.id, tab)
  }, [agent, tab, loadDetail])

  function selectAgent(id: string) { setSelectedId(id); setTab('overview') }

  // ── render gates ──
  if (me === undefined || (!ready && me)) {
    return <div className="app"><div style={{ padding: 40, color: 'var(--ink-faint)' }} className="mono">Loading…</div></div>
  }
  if (me === null) {
    return (
      <div className="app">
        <div style={{ maxWidth: 380, margin: '18vh auto', textAlign: 'center' }}>
          <div className="brand" style={{ justifyContent: 'center', fontSize: 18 }}><span className="mark" aria-hidden="true" /> Agentric</div>
          <p style={{ color: 'var(--ink-dim)', marginTop: 16 }}>Sign in to view your fleet.</p>
          <a className="btn" style={{ display: 'inline-block', marginTop: 8, textDecoration: 'none' }} href="/">Go to sign in →</a>
        </div>
      </div>
    )
  }

  const needsYou = sessions.filter((s) => (s.alive || s.status === 'running') && s.blocked).length

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true" /> Agentric</div>
        <span className="tenant-pill"><span className="dot run" style={{ width: 6, height: 6, boxShadow: 'none' }} /> {tenant || '…'}</span>
        <div className="spacer" />
        <a className="topbar-link" href="/">Classic view →</a>
        <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>◐</button>
        <a className="icon-btn" href="/" title={needsYou ? `${needsYou} need you` : 'Inbox'} style={{ textDecoration: 'none' }}>
          Inbox {needsYou ? <span className="badge">{needsYou}</span> : null}
        </a>
      </div>

      <div className="layout">
        <aside className="rail">
          <div className="rail-head">
            <span className="eyebrow">Fleet</span>
            <span className="eyebrow">{shown.length} agent{shown.length === 1 ? '' : 's'}</span>
          </div>
          <div className="rail-search">
            <input placeholder="Search agents…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {error ? <div className="empty" style={{ margin: 8 }}>{error}</div> : null}
          {shown.length === 0 && !error
            ? <div className="empty" style={{ margin: 8 }}>No agents.</div>
            : shown.map((a) => (
              <button key={a.id} className={`agent-row ${a.id === selectedId ? 'active' : ''}`} onClick={() => selectAgent(a.id)}>
                <span className={`dot ${a.status}`} />
                <span className="col">
                  <div className="nm">{a.id}</div>
                  <div className="meta">{a.statusText}</div>
                </span>
              </button>
            ))}
          <a className="new-agent" href="/" style={{ textDecoration: 'none', display: 'block' }}>＋  New agent</a>
          <div className="rail-sep" />
          <div className="rail-mini">
            <span className="eyebrow" style={{ paddingLeft: 9 }}>Fleet-wide</span>
            <a href="/">◱  Sessions</a>
            <a href="/">▤  Tasks</a>
            <a href="/">◈  Audit</a>
            <a href="/">⚙  Settings &amp; Team</a>
          </div>
        </aside>

        {agent
          ? <Workspace agent={agent} tab={tab} onTab={setTab} detail={details[agent.id] || {}} loadingTab={loadingTab} />
          : <main className="workspace"><div className="empty" style={{ marginTop: 40 }}>No agents to show yet.</div></main>}
      </div>
    </div>
  )
}
