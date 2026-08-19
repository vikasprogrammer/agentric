import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api, type ChatTurn, type ConversationResp, type Session } from '@/lib/api'
import { fmtUsd } from './data'

// Our own read-only session viewer — not the tmux terminal, not a chat box. It renders the friendly
// conversation timeline from /api/sessions/:id/conversation: the human's prompts, the agent's replies
// (markdown), and classified activity (governed tool actions with status + inline artifact/KB/app cards).

function clock(ts: number): string {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}
function fmtDuration(ms: number | undefined): string | null {
  if (!ms || ms < 1000) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function isLive(s: Session): boolean { return s.alive === true || s.status === 'running' }

function headStatus(s: Session): { cls: string; text: string } {
  if (isLive(s)) {
    if (s.blocked) return { cls: 'wait', text: 'blocked on you' }
    return { cls: 'run', text: s.working ? 'running' : 'live' }
  }
  if (s.status === 'crashed') return { cls: 'block', text: 'crashed' }
  if (s.outcome === 'failure') return { cls: 'block', text: 'failed' }
  if (s.outcome === 'partial') return { cls: 'wait', text: 'partial' }
  return { cls: 'idle', text: s.status === 'stopped' ? 'stopped' : 'done' }
}

function ActivityCards({ t }: { t: Extract<ChatTurn, { kind: 'activity' }> }) {
  return (
    <>
      {t.artifacts?.length ? (
        <div className="v-cards">
          {t.artifacts.map((a) => (
            <a className="v-card" key={a.id} href={a.raw} target="_blank" rel="noreferrer">
              {a.isImage ? <img src={a.raw} alt={a.title} /> : <span className="v-card-kind">{a.kind || 'file'}</span>}
              <span className="v-card-title">{a.title}</span>
            </a>
          ))}
        </div>
      ) : null}
      {t.kbPages?.length ? (
        <div className="v-cards">
          {t.kbPages.map((k) => <span className="v-chip" key={`${k.section}/${k.slug}`}>📄 {k.title}</span>)}
        </div>
      ) : null}
      {t.apps?.length ? (
        <div className="v-cards">
          {t.apps.map((ap) => <span className="v-chip" key={ap.id}>▦ {ap.name}{ap.published ? '' : ' · draft'}</span>)}
        </div>
      ) : null}
    </>
  )
}

function Turn({ t, agentId }: { t: ChatTurn; agentId: string }) {
  if (t.kind === 'user') {
    return (
      <div className="v-turn v-user">
        <div className="v-who">You <span className="v-time">{clock(t.ts)}</span></div>
        <div className="v-body v-pre">{t.text}</div>
      </div>
    )
  }
  if (t.kind === 'assistant') {
    return (
      <div className="v-turn v-assistant">
        <div className="v-who">{agentId} <span className="v-time">{clock(t.ts)}</span></div>
        <div className="v-body md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{t.text}</ReactMarkdown></div>
      </div>
    )
  }
  // activity
  const dotCls = t.status === 'error' ? 'block' : t.status === 'running' ? 'run' : 'idle'
  return (
    <div className="v-turn v-activity">
      <span className={`dot ${dotCls}`} style={t.status === 'running' ? undefined : { boxShadow: 'none' }} />
      <div className="grow">
        <div className="v-act-line"><span className="v-tool">{t.tool}</span> {t.label}</div>
        {t.detail ? <div className="v-act-detail">{t.detail}</div> : null}
        <ActivityCards t={t} />
      </div>
      <span className="v-time">{clock(t.ts)}</span>
    </div>
  )
}

export default function SessionViewer({ session, onBack }: { session: Session; onBack: () => void }) {
  const [convo, setConvo] = useState<ConversationResp | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setConvo(null)
    api.conversation(session.id)
      .then((r) => { if (!cancelled) { setConvo(r); setLoading(false) } })
      .catch(() => { if (!cancelled) { setConvo({ turns: [], found: false }); setLoading(false) } })
    return () => { cancelled = true }
  }, [session.id])

  const st = headStatus(session)
  const agentId = convo?.agent || session.agent
  const dur = fmtDuration(session.activeMs)
  const meta: string[] = []
  if (session.costUsd != null) meta.push(fmtUsd(session.costUsd))
  if (dur) meta.push(dur)
  if (session.turns) meta.push(`${session.turns} turn${session.turns === 1 ? '' : 's'}`)
  if (session.model) meta.push(session.model)

  const live = isLive(session)
  const turns = convo?.turns ?? []

  return (
    <main className="workspace viewer">
      <button className="v-back" onClick={onBack}>← {agentId}</button>
      <div className="v-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="v-title">{session.title?.trim() || session.task?.trim() || '(untitled run)'}</div>
          <div className="v-meta">
            <span className={`status-pill ${st.cls}`}>{st.cls === 'idle' ? '●' : null} {st.text}</span>
            {meta.map((m, i) => <span className="v-metabit mono" key={i}>{m}</span>)}
          </div>
        </div>
        {live ? <a className="btn ghost" href={`/?session=${encodeURIComponent(session.id)}`}>Open terminal →</a> : null}
      </div>

      {session.summary ? <div className="v-summary">{session.summary}</div> : null}

      {loading ? (
        <div className="empty">Loading conversation…</div>
      ) : turns.length === 0 ? (
        <div className="empty">
          No readable transcript for this run.
          {live ? <><br /><br />It’s still running — <a href={`/?session=${encodeURIComponent(session.id)}`}>open the live terminal</a>.</> : null}
        </div>
      ) : (
        <div className="v-timeline">
          {turns.map((t, i) => <Turn key={i} t={t} agentId={agentId} />)}
          {live ? <div className="v-live-note">● still running — this is the conversation so far</div> : null}
        </div>
      )}
    </main>
  )
}
