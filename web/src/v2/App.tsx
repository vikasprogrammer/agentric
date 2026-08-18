import { useMemo, useState } from 'react'
import { AGENTS, TABS, type Agent, type SessionRow, type Status } from './data'
import './v2.css'

// Agentric v2 — an isolated, agent-first console. Each agent carries its own automations,
// insights, memory and settings; the classic multi-page console lives untouched at "/".
// This surface is chat-first: an agent's Overview opens on a prompt console.
//
// TODO(next): replace the mock AGENTS import with live data — GET /api/state for the roster,
// GET /api/sessions?agent=<id> for Recent sessions — using the same aos_sid cookie the classic
// app relies on. Keep the shape in data.ts as the adapter target.

function toggleTheme() {
  const root = document.documentElement
  const cur = root.getAttribute('data-theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark')
}

function StatePill({ status, text }: { status: Status; text: string }) {
  return (
    <span className={`status-pill ${status}`}>
      {status === 'idle' ? '●' : null} {text}
    </span>
  )
}

function SessionItem({ s }: { s: SessionRow }) {
  return (
    <div className="item">
      <span className={`dot ${s.tag || 'idle'}`} style={s.tag ? undefined : { opacity: 0.4 }} />
      <span className="grow">
        <div className="t">{s.t}</div>
        <div className="d">{s.d}</div>
      </span>
      {s.tag
        ? <span className={`tag ${s.tag}`}>{s.tagText}</span>
        : <span className={`verdict ${s.verdict}`}>{s.verText}</span>}
      <span className="when">{s.when}</span>
    </div>
  )
}

function Overview({ a }: { a: Agent }) {
  return (
    <div className="panel">
      <p className="thesis">Everything about this agent lives here — no hunting across a dozen global pages.</p>
      <div className="console">
        <div className="prompt">
          <textarea rows={1} placeholder={`Message ${a.id}…  ask it to do something, or start a session`} />
          <button className="send" title="Run">↑</button>
        </div>
        <div className="row2">
          <span className="chip">▤ Create a task</span>
          <span className="chip">◈ run-as: you</span>
          <span className="chip">◱ Open live session</span>
        </div>
      </div>
      <div className="stat-row">
        <div className="stat"><div className="k">Runs · 7d</div><div className="v">{a.stats.runs}</div><div className="sub">across all triggers</div></div>
        <div className="stat"><div className="k">Cost · 7d</div><div className="v">{a.stats.cost}</div><div className="sub">max-per-conversation</div></div>
        <div className="stat"><div className="k">Auto-approve</div><div className="v">{a.stats.approve}</div><div className="sub">gate outcomes</div></div>
        <div className="stat"><div className="k">Memories</div><div className="v">{a.stats.memories}</div><div className="sub">agent-scoped recall</div></div>
      </div>
      <div className="section-title"><h3>Recent sessions</h3><a>All sessions →</a></div>
      <div className="list">
        {a.sessions.map((s, i) => <SessionItem key={i} s={s} />)}
      </div>
    </div>
  )
}

function Automations({ a }: { a: Agent }) {
  if (!a.automations.length) {
    return (
      <div className="panel">
        <div className="empty">
          No automations yet. This agent only runs when you message it or hand it a task.
          <br /><br />
          <button className="btn ghost">＋ Add a trigger</button>
        </div>
      </div>
    )
  }
  return (
    <div className="panel">
      <div className="section-title"><h3>Triggers that wake this agent</h3><a>＋ Add trigger</a></div>
      <div className="list">
        {a.automations.map((x, i) => (
          <div className="item" key={i}>
            <span className="dot run" style={{ boxShadow: 'none' }} />
            <span className="grow"><div className="t">{x.t}</div><div className="d">{x.d}</div></span>
            <span className="when">{x.when}</span>
            <span className={`tag ${x.tag}`}>{x.tagText}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Insights({ a }: { a: Agent }) {
  if (!a.insights.length) {
    return <div className="panel"><div className="empty">No insights yet — they appear once this agent has enough graded runs to learn from.</div></div>
  }
  return (
    <div className="panel">
      <p className="thesis">Learned from this agent’s own graded runs — the fleet-wide Insights page is gone; each agent carries its own.</p>
      <div className="list">
        {a.insights.map((x, i) => (
          <div className="item" key={i}>
            <span className="grow" style={{ padding: '2px 0' }}><div className="t">{x.t}</div><div className="d">{x.d}</div></span>
            <span className="when">{x.when}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Memory({ a }: { a: Agent }) {
  return (
    <div className="panel">
      <div className="section-title"><h3>What this agent remembers</h3><a>Search memory →</a></div>
      {a.memories.map((m, i) => (
        <div className="memory-card" key={i}>
          <div className="body">{m.body}</div>
          <div className="foot">
            <span className="kind">{m.kind}</span>
            <span className="mono" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>recalled {m.recalled} · {m.when} ago</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Seg({ current, opts }: { current: string; opts: string[] }) {
  return (
    <div className="seg">
      {opts.map((o) => <button key={o} className={o === current ? 'on' : ''}>{o}</button>)}
    </div>
  )
}

function Settings({ a }: { a: Agent }) {
  return (
    <div className="panel">
      <div className="field">
        <div className="lbl">Model<div className="h">The engine this agent runs on</div></div>
        <Seg current={a.model} opts={['haiku-4.5', 'sonnet-5', 'opus-4.8']} />
      </div>
      <div className="field">
        <div className="lbl">Reasoning effort<div className="h">Depth vs. speed &amp; cost</div></div>
        <Seg current={a.effort} opts={['low', 'medium', 'high']} />
      </div>
      <div className="field">
        <div className="lbl">Verbosity<div className="h">Terse compresses narration only — never artifacts</div></div>
        <Seg current={a.verbosity} opts={['normal', 'terse']} />
      </div>
      <div className="field">
        <div className="lbl">System prompt<div className="h">CLAUDE.md · this agent’s identity</div></div>
        <div className="prompt-box">{a.prompt}</div>
      </div>
      <div className="field">
        <div className="lbl" style={{ color: 'var(--block)' }}>Danger zone<div className="h">Delete this agent and its history</div></div>
        <div>
          <button className="btn ghost" style={{ borderColor: 'color-mix(in srgb, var(--block) 40%, transparent)', color: 'var(--block)' }}>Delete agent</button>
        </div>
      </div>
    </div>
  )
}

function Workspace({ agent, tab, onTab }: { agent: Agent; tab: string; onTab: (t: string) => void }) {
  const Panel = { overview: Overview, automations: Automations, insights: Insights, memory: Memory, settings: Settings }[tab] || Overview
  return (
    <main className="workspace">
      <div className="ws-head">
        <div style={{ flex: 1 }}>
          <div className="ws-title">{agent.id} <StatePill status={agent.status} text={agent.statusText} /></div>
          <div className="ws-handle">{agent.handle}</div>
          <div className="ws-blurb">{agent.blurb}</div>
        </div>
        <button className="btn">Run agent</button>
      </div>
      <nav className="subnav">
        {TABS.map((t) => (
          <button key={t.key} className={t.key === tab ? 'active' : ''} onClick={() => onTab(t.key)}>
            {t.label}{t.count ? <span className="count">{t.count(agent)}</span> : null}
          </button>
        ))}
      </nav>
      <Panel a={agent} />
    </main>
  )
}

export default function App() {
  const [selectedId, setSelectedId] = useState(AGENTS[0].id)
  const [tab, setTab] = useState('overview')
  const [filter, setFilter] = useState('')

  const shown = useMemo(
    () => AGENTS.filter((a) => a.id.toLowerCase().includes(filter.toLowerCase())),
    [filter],
  )
  const agent = AGENTS.find((a) => a.id === selectedId) || AGENTS[0]

  function selectAgent(id: string) {
    setSelectedId(id)
    setTab('overview')
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true" /> Agentric</div>
        <span className="tenant-pill"><span className="dot run" style={{ width: 6, height: 6, boxShadow: 'none' }} /> instapods</span>
        <div className="spacer" />
        <a className="topbar-link" href="/">Classic view →</a>
        <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>◐</button>
        <button className="icon-btn" title="Inbox — 2 need you">Inbox <span className="badge">2</span></button>
      </div>

      <div className="layout">
        <aside className="rail">
          <div className="rail-head">
            <span className="eyebrow">Fleet</span>
            <span className="eyebrow">{shown.length} agents</span>
          </div>
          <div className="rail-search">
            <input placeholder="Search agents…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          {shown.map((a) => (
            <button key={a.id} className={`agent-row ${a.id === selectedId ? 'active' : ''}`} onClick={() => selectAgent(a.id)}>
              <span className={`dot ${a.status}`} />
              <span className="col">
                <div className="nm">{a.id}</div>
                <div className="meta">{a.statusText}</div>
              </span>
            </button>
          ))}
          <button className="new-agent">＋  New agent</button>
          <div className="rail-sep" />
          <div className="rail-mini">
            <span className="eyebrow" style={{ paddingLeft: 9 }}>Fleet-wide</span>
            <a>◱  Sessions</a>
            <a>▤  Tasks</a>
            <a>◈  Audit</a>
            <a>⚙  Settings &amp; Team</a>
          </div>
        </aside>

        <Workspace agent={agent} tab={tab} onTab={setTab} />
      </div>
    </div>
  )
}
