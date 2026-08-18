// v2 view-model adapters — turn the live API shapes (@/lib/api) into what the agent-first
// console renders. Pure functions, no fetching (App.tsx owns the requests + caching).

import type { AgentInfo, Session } from '@/lib/api'

export type Status = 'run' | 'wait' | 'block' | 'idle'

/** One agent as the rail + workspace render it. Its own live/recent sessions ride along so the
 *  rail dot and Overview don't each re-scan the full sessions list. */
export interface AgentVM {
  id: string
  handle: string
  status: Status
  statusText: string
  blurb: string
  system: boolean
  sessions: Session[] // this agent's sessions, newest first
}

const DAY = 86_400_000

/** Compact relative time: "now" / "12m" / "3h" / "2d" / "5w". */
export function relTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.round(d / 7)}w`
}

export function fmtUsd(n: number | undefined): string {
  if (!n) return '$0'
  if (n < 1) return `$${n.toFixed(2)}`
  if (n < 1000) return `$${n.toFixed(n < 100 ? 1 : 0)}`
  return `$${(n / 1000).toFixed(1)}k`
}

/** How the source is labelled on a session subline. */
export function sourceLabel(s: Session): string {
  switch (s.sourceKind) {
    case 'manual': return 'console'
    case 'cron': return 'cron'
    case 'webhook': return 'webhook'
    case 'slack': return 'slack'
    case 'discord': return 'discord'
    case 'telegram': return 'telegram'
    case 'composio': return 'composio'
    case 'scheduled': return 'scheduled'
    case 'task': return 'task'
    case 'chat': return 'chat'
    case 'system': return 'system'
    default: return s.headless ? 'unattended' : 'session'
  }
}

function isLive(s: Session): boolean {
  return s.alive === true || s.status === 'running'
}

/** Rail dot + one-word status for an agent, derived from its live sessions. */
export function deriveStatus(sessions: Session[], system: boolean): { status: Status; statusText: string } {
  const live = sessions.filter(isLive)
  if (live.some((s) => s.blocked)) return { status: 'wait', statusText: 'waiting on you' }
  if (live.some((s) => s.working)) return { status: 'run', statusText: 'running' }
  if (live.length) return { status: 'run', statusText: 'live' }
  return { status: 'idle', statusText: system ? 'system · idle' : 'idle' }
}

/** One recent-sessions row: a live tag OR a finished verdict. */
export interface SessionRow {
  key: string
  t: string
  d: string
  when: string
  tag?: Status
  tagText?: string
  verdict?: 'ok' | 'warn' | 'bad'
  verText?: string
}

export function sessionRow(s: Session, now = Date.now()): SessionRow {
  const t = s.title?.trim() || s.task?.trim() || '(untitled run)'
  const d = [sourceLabel(s), s.runAsLabel ? `run-as ${s.runAsLabel}` : ''].filter(Boolean).join(' · ')
  const when = relTime(s.updatedAt || s.createdAt, now)
  const base = { key: s.id, t, d, when }
  if (isLive(s)) {
    if (s.blocked) return { ...base, tag: 'wait', tagText: 'blocked on you' }
    return { ...base, tag: 'run', tagText: s.working ? 'running' : 'live' }
  }
  const outcome = s.outcome
  if (s.status === 'crashed') return { ...base, verdict: 'bad', verText: '✗ crashed' }
  if (s.status === 'stopped') return { ...base, verdict: 'warn', verText: '■ stopped' }
  if (outcome === 'failure') return { ...base, verdict: 'bad', verText: '✗ failed' }
  if (outcome === 'partial') return { ...base, verdict: 'warn', verText: '~ partial' }
  return { ...base, verdict: 'ok', verText: '✓ done' }
}

/** Build the fleet view models from /api/state agents + /api/sessions rows. */
export function buildAgents(agents: AgentInfo[], sessions: Session[]): AgentVM[] {
  const byAgent = new Map<string, Session[]>()
  for (const s of sessions) {
    const arr = byAgent.get(s.agent)
    if (arr) arr.push(s)
    else byAgent.set(s.agent, [s])
  }
  return agents.map((a) => {
    const mine = (byAgent.get(a.id) || []).slice().sort((x, y) => (y.updatedAt || y.createdAt) - (x.updatedAt || x.createdAt))
    const system = !!(a.builtIn && a.id === 'consolidator') || mine.some((s) => s.system)
    const { status, statusText } = deriveStatus(mine, system)
    return {
      id: a.id,
      handle: `agent:${a.id}`,
      status,
      statusText,
      blurb: a.description || 'No description yet.',
      system,
      sessions: mine,
    }
  })
}

/** Overview stat tiles, all derived from the agent's own sessions (no extra requests). */
export function overviewStats(sessions: Session[], now = Date.now()) {
  const wk = sessions.filter((s) => (s.updatedAt || s.createdAt) > now - 7 * DAY)
  const cost = wk.reduce((sum, s) => sum + (s.costUsd || 0), 0)
  const live = sessions.filter(isLive)
  const needs = live.filter((s) => s.blocked).length
  return {
    runs: String(wk.length),
    cost: fmtUsd(cost),
    live: String(live.length),
    needs: String(needs),
  }
}
