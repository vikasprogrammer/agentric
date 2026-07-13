/**
 * Connectors page — the "integrations marketplace".
 *
 * Two surfaces, one mental model ("tools an agent can use"):
 *   1. Add an integration — a searchable tile gallery over native MCP templates (the catalog:
 *      Resend, custom local/remote, …) AND Composio's ~1000 hosted apps. Picking a native template
 *      opens <AddConnectorDialog>; picking a Composio app kicks off its hosted OAuth.
 *   2. Connected — one unified, filterable list (All / Company / Mine) of everything already wired:
 *      MCP connector rows, company Composio apps, the native Slack/Discord bots, and each member's
 *      own personal apps + servers.
 *
 * Every tool call an agent makes here still passes the gateway gate — this page only decides what
 * tools exist and who they belong to. Extracted into its own file to keep App.tsx from growing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Plug, Globe, Plus, Trash2, X, Search, Building2, User as UserIcon, ExternalLink, Server, SquareTerminal, Database, Pencil } from 'lucide-react'
import type { IconType } from 'react-icons'
import {
  SiGmail, SiGithub, SiGoogledrive, SiDiscord, SiResend, SiHetzner, SiNotion, SiLinear,
  SiJira, SiHubspot, SiGooglesheets, SiGooglecalendar, SiGooglecloud, SiStripe, SiAsana,
  SiTrello, SiZendesk, SiClickup, SiAirtable, SiGoogle,
} from 'react-icons/si'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  api, type Member, type CatalogEntry, type Connector, type ConnectorScope, type AddConnectorReq,
  type IntegrationsOverview, type ConnectionsResp, type GithubMe,
  type Host, type HostProtocol, type HostPosture, type AddHostReq,
} from '@/lib/api'

// ── brand icons ────────────────────────────────────────────────────────────────────
/** Known brands → their simple-icons glyph + brand colour. Anything not here (incl. Slack/Composio,
 *  which aren't in simple-icons, and the long tail of Composio apps) falls back to a lettermark. */
const BRAND: Record<string, { Icon: IconType; color: string }> = {
  gmail: { Icon: SiGmail, color: '#EA4335' },
  github: { Icon: SiGithub, color: '#181717' },
  googledrive: { Icon: SiGoogledrive, color: '#0066DA' },
  discord: { Icon: SiDiscord, color: '#5865F2' },
  resend: { Icon: SiResend, color: '#000000' },
  hetzner: { Icon: SiHetzner, color: '#D50C2D' },
  notion: { Icon: SiNotion, color: '#000000' },
  linear: { Icon: SiLinear, color: '#5E6AD2' },
  jira: { Icon: SiJira, color: '#0052CC' },
  hubspot: { Icon: SiHubspot, color: '#FF7A59' },
  googlesheets: { Icon: SiGooglesheets, color: '#34A853' },
  googlecalendar: { Icon: SiGooglecalendar, color: '#4285F4' },
  googlecloud: { Icon: SiGooglecloud, color: '#4285F4' },
  stripe: { Icon: SiStripe, color: '#635BFF' },
  asana: { Icon: SiAsana, color: '#F06A6A' },
  trello: { Icon: SiTrello, color: '#0052CC' },
  zendesk: { Icon: SiZendesk, color: '#03363D' },
  clickup: { Icon: SiClickup, color: '#7B68EE' },
  airtable: { Icon: SiAirtable, color: '#18BFFF' },
  google: { Icon: SiGoogle, color: '#4285F4' },
}

/** Normalise a connector type / Composio toolkit slug to a BRAND key (folding common aliases). */
function brandKey(name: string): string {
  const k = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const alias: Record<string, string> = {
    slackbot: 'slack', gdrive: 'googledrive', googledocs: 'googledrive', drive: 'googledrive',
    gcloud: 'googlecloud', gcp: 'googlecloud', googlesheet: 'googlesheets', gcal: 'googlecalendar',
  }
  return alias[k] ?? k
}

/** A stable, pleasant hue for a name — so lettermark fallbacks are consistent per app. */
function hueOf(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** A square brand tile: a real logo on a light chip for known brands, a lucide glyph for the custom
 *  escape hatches, and a coloured lettermark for everything else. `box` is the tile size in px. */
function BrandIcon({ name, box = 36 }: { name: string; box?: number }) {
  const key = brandKey(name)
  const tile = 'inline-flex shrink-0 items-center justify-center rounded-lg'
  // Non-brand glyphs: the custom-MCP escape hatches + the host-connection protocols (Server/terminal/db).
  const GLYPH: Record<string, typeof Plug> = {
    custom: Plug, customremote: Globe, host: Server, network: Server, ssh: SquareTerminal,
    http: Globe, postgres: Database,
  }
  if (GLYPH[key]) {
    const Glyph = GLYPH[key]
    return (
      <span className={`${tile} border bg-muted text-muted-foreground`} style={{ width: box, height: box }}>
        <Glyph style={{ width: box * 0.5, height: box * 0.5 }} />
      </span>
    )
  }
  const b = BRAND[key]
  if (b) {
    const Icon = b.Icon
    return (
      <span className={`${tile} border bg-white`} style={{ width: box, height: box }}>
        <Icon size={box * 0.56} color={b.color} />
      </span>
    )
  }
  const ch = (name.trim()[0] || '?').toUpperCase()
  return (
    <span
      className={`${tile} font-semibold text-white`}
      style={{ width: box, height: box, background: `hsl(${hueOf(name)} 52% 46%)`, fontSize: box * 0.44 }}
    >
      {ch}
    </span>
  )
}

// ── shared bits ──────────────────────────────────────────────────────────────────────
function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="mt-1">{children}</div>
      {help && <div className="mt-1 text-[11px] text-muted-foreground">{help}</div>}
    </div>
  )
}

/** A tiny segmented control (used for the add-scope and the Connected filter). */
function Segmented<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; disabled?: boolean }[]
}) {
  return (
    <div className="inline-flex gap-1 rounded-lg border bg-background p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-40 ${
            value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const isAdminRole = (m: Member | null) => m?.role === 'owner' || m?.role === 'admin'

// The Composio toolkit catalog (~1000 apps) for search — fetched once per page load, shared via a
// module-level promise so remounts don't refetch.
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
const FALLBACK_TOOLKITS = ['slackbot', 'gmail', 'github', 'googledrive', 'googlesheets', 'googlecalendar', 'notion', 'linear', 'jira', 'hubspot', 'stripe', 'airtable']

// ── add: the marketplace ───────────────────────────────────────────────────────────────
/** A clickable tile in the "Add an integration" gallery. */
function IntegrationTile({ name, label, sub, onClick, busy }: {
  name: string; label: string; sub: string; onClick: () => void; busy?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:opacity-50"
    >
      <BrandIcon name={name} box={36} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium capitalize">{label}</div>
        <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
      </div>
    </button>
  )
}

function AddIntegration({ me, catalog, keySet, onPickTemplate, onConnected, onClose }: {
  me: Member | null
  catalog: CatalogEntry[]
  keySet: boolean
  onPickTemplate: (t: CatalogEntry, scope: ConnectorScope) => void
  onConnected: () => void
  onClose?: () => void
}) {
  const isAdmin = isAdminRole(me)
  const toolkits = useComposioToolkits()
  const [scope, setScope] = useState<'company' | 'personal'>(isAdmin ? 'company' : 'personal')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState('')
  const query = q.trim().toLowerCase()

  // A member may only instantiate real catalog templates with their own creds — never the free-form
  // custom escape hatch (that runs an arbitrary command under the shared service account).
  const templates = catalog.filter((t) => isAdmin || (t.type !== 'custom' && t.type !== 'custom-remote'))
  const matchedTemplates = templates.filter((t) => !query || t.label.toLowerCase().includes(query) || t.type.includes(query))

  const pool = toolkits.length ? toolkits : FALLBACK_TOOLKITS.map((s) => ({ slug: s, name: s }))
  // The whole catalog (~1000 apps) is in `pool` — but we can't render a thousand tiles. Without a
  // query show a small featured preview and nudge to search; a query narrows the list, so render a
  // generous cap and surface how many more matched so nothing looks silently dropped.
  const allApps = keySet
    ? (query ? pool.filter((a) => a.slug.includes(query) || a.name.toLowerCase().includes(query)) : pool)
    : []
  const appCap = query ? 60 : 12
  const matchedApps = allApps.slice(0, appCap)
  const moreApps = allApps.length - matchedApps.length

  const connectComposio = async (slug: string) => {
    setBusy(slug); setHint('')
    const r = await api.connectApp({ toolkit: slug, scope })
    setBusy('')
    if (r.error) return setHint('⚠ ' + r.error)
    if (r.redirectUrl) {
      window.open(r.redirectUrl, '_blank', 'noopener')
      setHint('Authorize in the opened tab — it appears under Connected once done.')
      onConnected()
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Add an integration</div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Adding for</span>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'company', label: 'Company · team', disabled: !isAdmin },
              { value: 'personal', label: 'Just me' },
            ]}
          />
          {onClose && (
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose} title="close">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search native servers${keySet ? ` + ${toolkits.length || ''} Composio apps` : ''}…`}
          className="pl-8"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {matchedTemplates.map((t) => (
          <IntegrationTile
            key={t.type}
            name={t.type}
            label={t.label}
            sub={t.type === 'custom' || t.type === 'custom-remote' ? 'custom MCP server' : 'native server'}
            onClick={() => onPickTemplate(t, scope === 'company' ? 'org' : 'personal')}
          />
        ))}
        {matchedApps.map((a) => (
          <IntegrationTile
            key={a.slug}
            name={a.slug}
            label={a.name}
            sub="via Composio"
            busy={busy === a.slug}
            onClick={() => connectComposio(a.slug)}
          />
        ))}
      </div>

      {moreApps > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {query
            ? `Showing ${matchedApps.length} of ${allApps.length} matches — refine your search to narrow it down.`
            : `Showing ${matchedApps.length} of ${allApps.length} Composio apps — type to search the rest.`}
        </p>
      )}

      {matchedTemplates.length === 0 && matchedApps.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {query ? `No integrations match “${q}”.` : 'No integrations available.'}
          {!keySet && ' Connecting Composio apps needs a company Composio key (an admin adds it in Connections → Creds).'}
        </p>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </section>
  )
}

// ── connected: the unified list ─────────────────────────────────────────────────────────
/** One presentational row — a brand tile, a title + badges, a subtitle, and right-aligned actions. */
function Row({ name, title, subtitle, badges, right }: {
  name: string; title: string; subtitle?: string; badges?: ReactNode; right?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <BrandIcon name={name} box={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium capitalize">{title}</span>
          {badges}
        </div>
        {subtitle && <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

function statusBadge(text: string, tone: 'ok' | 'warn' | 'muted' = 'muted') {
  const cls = tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : ''
  return <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${cls}`}>{text}</Badge>
}

/** A single MCP connector row (native catalog server or custom), with its governed actions. */
function ConnectorRow({ c, me, busy, onToggle, onRemove, onShare }: {
  c: Connector; me: Member | null; busy: string
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onShare: (id: string, shared: boolean) => void
}) {
  const isAdmin = isAdminRole(me)
  const canManage = isAdmin || (c.scope === 'personal' && c.ownerMemberId === me?.id)
  const canShare = c.scope === 'personal' && canManage
  const detail = c.transport === 'stdio'
    ? `${c.command} ${c.args.join(' ')}${c.envKeys.length ? ` · ${c.envKeys.join(', ')}` : ''}`
    : `${c.transport} · ${c.url || 'per-user session'}${c.headerKeys.length ? ` · ${c.headerKeys.join(', ')}` : ''}`
  return (
    <Row
      name={c.type}
      title={c.label}
      subtitle={detail}
      badges={
        <>
          {statusBadge(c.enabled ? 'enabled' : 'disabled', c.enabled ? 'ok' : 'muted')}
          {c.scope === 'personal' && c.shared && statusBadge('shared with team', 'ok')}
        </>
      }
      right={canManage ? (
        <>
          {canShare && (
            <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => onShare(c.id, !c.shared)}>
              {c.shared ? 'Unshare' : 'Share'}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => onToggle(c.id, !c.enabled)}>
            {c.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === c.id} onClick={() => onRemove(c.id)} title="remove">
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      ) : undefined}
    />
  )
}

/** A live Composio-connected app row (company or personal). Shows the connection's distinguishing
 *  handle/alias so multiple accounts of the same app (e.g. two Gmails) are told apart. */
function ComposioRow({ app, canRemove, busy, onRemove }: {
  app: { id: string; toolkit: string; status: string; name?: string }
  canRemove: boolean; busy: boolean; onRemove: () => void
}) {
  // The auto handle is like `gmail_comma-hugh`; drop the redundant toolkit prefix for display. A
  // user-set alias (which won't carry the prefix) is shown as-is.
  const handle = app.name && app.name !== app.toolkit
    ? app.name.replace(new RegExp(`^${app.toolkit}[_-]`, 'i'), '')
    : ''
  return (
    <Row
      name={app.toolkit}
      title={app.toolkit}
      subtitle={handle ? `${handle} · via Composio` : 'via Composio'}
      badges={statusBadge(app.status.toLowerCase(), app.status === 'ACTIVE' ? 'ok' : 'warn')}
      right={canRemove ? (
        <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy} onClick={onRemove} title="disconnect">
          <X className="h-4 w-4" />
        </Button>
      ) : undefined}
    />
  )
}

/** A native chat-bot row (Slack / Discord) — status only; setup lives in Connections → Creds. */
function NativeRow({ name, title, s, isAdmin }: {
  name: string; title: string; s?: { configured: boolean; connected: boolean; botUserId: string }; isAdmin: boolean
}) {
  return (
    <Row
      name={name}
      title={title}
      subtitle="native"
      badges={
        s?.connected ? statusBadge(`connected${s.botUserId ? ` · ${s.botUserId}` : ''}`, 'ok')
          : s?.configured ? statusBadge('configured · not connected', 'warn')
            : statusBadge('not configured')
      }
      right={isAdmin
        ? <a href="#/connectors/creds" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline hover:text-foreground">Creds <ExternalLink className="h-3 w-3" /></a>
        : <span className="text-[11px] text-muted-foreground">managed by an admin</span>}
    />
  )
}

/** A single Host connection row — a governed reachable destination (SSH / internal HTTP / DB). Phase
 *  2a is display + manage only; the gate doesn't read these yet (Phase 2b). */
function HostRow({ h, me, busy, onToggle, onRemove, onShare, onEdit }: {
  h: Host; me: Member | null; busy: string
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onShare: (id: string, shared: boolean) => void
  onEdit: (h: Host) => void
}) {
  const isAdmin = isAdminRole(me)
  const canManage = isAdmin || (h.scope === 'personal' && h.ownerMemberId === me?.id)
  const canShare = h.scope === 'personal' && canManage
  const proto = h.protocol === 'any' ? 'any' : h.protocol
  const detail = `${proto} · ${h.match}${h.credential ? ` · ${h.credential}` : ''}`
  const postureTone = h.posture === 'never' ? 'warn' : h.posture === 'allow' ? 'ok' : 'muted'
  return (
    <Row
      name={h.protocol === 'any' ? 'host' : h.protocol}
      title={h.name}
      subtitle={detail}
      badges={
        <>
          {statusBadge(h.enabled ? 'enabled' : 'disabled', h.enabled ? 'ok' : 'muted')}
          {statusBadge(h.posture, postureTone)}
          {h.scope === 'personal' && h.shared && statusBadge('shared with team', 'ok')}
        </>
      }
      right={canManage ? (
        <>
          <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy === h.id} onClick={() => onEdit(h)} title="edit"><Pencil className="h-4 w-4" /></Button>
          {canShare && (
            <Button size="sm" variant="outline" disabled={busy === h.id} onClick={() => onShare(h.id, !h.shared)}>{h.shared ? 'Unshare' : 'Share'}</Button>
          )}
          <Button size="sm" variant="outline" disabled={busy === h.id} onClick={() => onToggle(h.id, !h.enabled)}>{h.enabled ? 'Disable' : 'Enable'}</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === h.id} onClick={() => onRemove(h.id)} title="remove"><Trash2 className="h-4 w-4" /></Button>
        </>
      ) : undefined}
    />
  )
}

/** A host an agent PROPOSED (`host_propose`) — inactive until an owner/admin publishes it. Shows the
 *  proposing agent + reason, with Publish / Dismiss (admin-only). No credential (the admin adds one). */
function ProposedHostRow({ h, me, busy, onPublish, onDismiss }: {
  h: Host; me: Member | null; busy: string
  onPublish: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const isAdmin = isAdminRole(me)
  const proto = h.protocol === 'any' ? 'any' : h.protocol
  const who = (h.proposedBy || '').replace(/^agent:/, '')
  return (
    <div className="rounded-lg border border-violet-300/60 bg-violet-50/40 p-3 dark:border-violet-800/50 dark:bg-violet-950/20">
      <div className="flex items-center gap-3">
        <BrandIcon name={h.protocol === 'any' ? 'host' : h.protocol} box={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium capitalize">{h.name}</span>
            {statusBadge('proposed', 'warn')}
            {statusBadge(h.posture, h.posture === 'never' ? 'warn' : h.posture === 'allow' ? 'ok' : 'muted')}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{proto} · {h.match}</div>
          {(who || h.proposedReason) && (
            <div className="mt-1 text-[11px] text-muted-foreground">{who && <>proposed by <b>{who}</b></>}{h.proposedReason ? <> — {h.proposedReason}</> : null}</div>
          )}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" disabled={busy === h.id} onClick={() => onPublish(h.id)}>Publish</Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" disabled={busy === h.id} onClick={() => onDismiss(h.id)} title="dismiss"><Trash2 className="h-4 w-4" /></Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** The viewer's own GitHub link — Connect/Disconnect their personal git identity (per-member run-as).
 *  Self-contained: fetches its own state so the Mine section can drop it in without threading props. */
export function GithubMineCard() {
  const [st, setSt] = useState<GithubMe | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const load = () => api.githubMe().then((r) => { if (!r.error) setSt(r) }).catch(() => {})
  useEffect(() => { load() }, [])
  // Reflect the callback's ?github= flag (set after the OAuth round-trip) then clean the URL.
  useEffect(() => {
    const m = window.location.hash.match(/[?&]github=(\w+)/)
    if (!m) return
    if (m[1] === 'connected') load()
    else setErr(m[1] === 'denied' ? 'GitHub authorization was cancelled.' : 'Could not connect GitHub — please try again.')
    window.history.replaceState(null, '', window.location.hash.replace(/[?&]github=\w+/, ''))
  }, [])
  const connect = async () => {
    setBusy(true); setErr('')
    // Return to the page the member started on (profile or Connections) after the OAuth round-trip.
    const returnTo = (window.location.hash || '#/connectors').split('?')[0]
    const r = await api.githubConnect(returnTo)
    setBusy(false)
    if (r.error) return setErr(r.error)
    if (r.redirectUrl) window.location.href = r.redirectUrl
  }
  const disconnect = async () => {
    setBusy(true); setErr('')
    await api.githubDisconnect()
    setBusy(false)
    load()
  }
  const Icon = BRAND.github.Icon
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon size={18} style={{ color: BRAND.github.color }} />
          <div>
            <div className="text-sm font-medium">GitHub — my git identity</div>
            <div className="text-[11px] text-muted-foreground">
              {st?.connected
                ? st.install?.installed
                  ? <>Connected as <code className="rounded bg-muted px-1 py-0.5">@{st.login}</code> — the App can act on {st.install.repos} repo{st.install.repos === 1 ? '' : 's'}{st.install.accounts.length ? ` (${st.install.accounts.join(', ')})` : ''}. Sessions you run push &amp; open PRs as you.</>
                  : <>Connected as <code className="rounded bg-muted px-1 py-0.5">@{st.login}</code>.</>
                : 'Link your GitHub so agents acting as you commit under your name (not a shared bot).'}
            </div>
          </div>
        </div>
        {st?.connected
          ? <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy}>Disconnect</Button>
          : <Button size="sm" onClick={connect} disabled={busy || !st?.configured}>Connect GitHub</Button>}
      </div>
      {/* Authorized but NOT installed — the trap: looks connected, but the App can't touch any repo. */}
      {st?.connected && st.install && !st.install.installed && (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠ You’re authorized, but the App isn’t <strong>installed</strong> on any repositories yet — so pushes will still fail. Authorizing and installing are separate steps: an owner needs to <strong>install the App</strong> on your org’s repos (Connections → Creds → Install the App). Until then, agents fall back to any configured token.
        </p>
      )}
      {!st?.configured && !st?.connected && (
        <p className="mt-2 text-[11px] text-muted-foreground">GitHub isn’t set up for this workspace yet — an owner/admin adds the App credentials in Connections → Creds.</p>
      )}
      {err && <p className="mt-2 text-[11px] text-destructive">{err}</p>}
    </div>
  )
}

function ConnectedList({ me, connectors, hosts, ov, conns, busy, onToggle, onRemove, onShare, onDisconnectComposio, onToggleHost, onRemoveHost, onShareHost, onEditHost, onPublishHost }: {
  me: Member | null
  connectors: Connector[]
  hosts: Host[]
  ov: IntegrationsOverview | null
  conns: ConnectionsResp | null
  busy: string
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onShare: (id: string, shared: boolean) => void
  onDisconnectComposio: (id: string, scope: 'company' | 'personal', label: string) => void
  onToggleHost: (id: string, enabled: boolean) => void
  onRemoveHost: (id: string) => void
  onShareHost: (id: string, shared: boolean) => void
  onEditHost: (h: Host) => void
  onPublishHost: (id: string) => void
}) {
  const isAdmin = isAdminRole(me)
  const [filter, setFilter] = useState<'all' | 'company' | 'mine'>('all')

  // Company = org connectors + shared personal ones + company Composio apps + native bots. Company
  // apps come from /api/connections (carries each connection's distinguishing name), not the overview.
  const orgConnectors = connectors.filter((c) => c.scope === 'org' || (c.scope === 'personal' && c.shared))
  const companyApps = conns?.company ?? []
  const orgHosts = hosts.filter((h) => !h.proposed && (h.scope === 'org' || (h.scope === 'personal' && h.shared)))
  // Mine = the viewer's own personal connectors + their own Composio apps + their own hosts.
  const myConnectors = connectors.filter((c) => c.scope === 'personal' && c.ownerMemberId === me?.id)
  const myApps = conns?.mine ?? []
  const myHosts = hosts.filter((h) => !h.proposed && h.scope === 'personal' && h.ownerMemberId === me?.id)
  // Agent-proposed hosts awaiting review (admin-only action).
  const proposedHosts = isAdmin ? hosts.filter((h) => h.proposed) : []

  const companyCount = orgConnectors.length + companyApps.length + orgHosts.length + 2 // +2 for the native bot rows
  const mineCount = myConnectors.length + myApps.length + myHosts.length
  const showCompany = filter === 'all' || filter === 'company'
  const showMine = filter === 'all' || filter === 'mine'

  const cardProps = { me, busy, onToggle, onRemove, onShare }
  const hostProps = { me, busy, onToggle: onToggleHost, onRemove: onRemoveHost, onShare: onShareHost, onEdit: onEditHost }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Connected</div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'company', label: `Company · ${companyCount}` },
            { value: 'mine', label: `Mine · ${mineCount}` },
          ]}
        />
      </div>

      {proposedHosts.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-violet-600 dark:text-violet-400">
            <Server className="h-3.5 w-3.5" /> Proposed by agents — review + publish to grant access
          </div>
          {proposedHosts.map((h) => <ProposedHostRow key={h.id} h={h} me={me} busy={busy} onPublish={onPublishHost} onDismiss={onRemoveHost} />)}
        </div>
      )}

      {showCompany && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" /> Company — shared by every agent{isAdmin ? '' : ' · read-only'}
          </div>
          <NativeRow name="slack" title="Slack" s={ov?.slack} isAdmin={isAdmin} />
          <NativeRow name="discord" title="Discord" s={ov?.discord} isAdmin={isAdmin} />
          {companyApps.map((a) => (
            <ComposioRow key={a.id} app={a} canRemove={isAdmin} busy={busy === a.id} onRemove={() => onDisconnectComposio(a.id, 'company', a.toolkit)} />
          ))}
          {orgConnectors.map((c) => <ConnectorRow key={c.id} c={c} {...cardProps} />)}
          {orgHosts.map((h) => <HostRow key={h.id} h={h} {...hostProps} />)}
        </div>
      )}

      {showMine && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <UserIcon className="h-3.5 w-3.5" /> Mine — only load in sessions you start
            {conns?.me && <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]" title="your Composio user_id">{conns.me}</code>}
          </div>
          <GithubMineCard />
          {!conns?.keySet && myConnectors.length === 0 && (
            <p className="text-xs text-muted-foreground">Connecting your own apps needs a company Composio key (an admin sets it in Connections → Creds).</p>
          )}
          {conns?.keySet && myApps.length === 0 && myConnectors.length === 0 && (
            <p className="text-xs text-muted-foreground">You haven’t connected any personal apps or servers yet.</p>
          )}
          {myApps.map((a) => (
            <ComposioRow key={a.id} app={a} canRemove busy={busy === a.id} onRemove={() => onDisconnectComposio(a.id, 'personal', a.toolkit)} />
          ))}
          {myConnectors.map((c) => <ConnectorRow key={c.id} c={c} {...cardProps} />)}
          {myHosts.map((h) => <HostRow key={h.id} h={h} {...hostProps} />)}
        </div>
      )}
    </section>
  )
}

// ── add dialog (native catalog templates + custom servers) ──────────────────────────────
function AddConnectorDialog({ me, template, scope, onClose, onAdded }: { me: Member | null; template: CatalogEntry; scope: ConnectorScope; onClose: () => void; onAdded: () => void }) {
  const isStdioCustom = template.type === 'custom'
  const isRemoteCustom = template.type === 'custom-remote'
  const isCustom = isStdioCustom || isRemoteCustom
  const isRemote = template.transport !== 'stdio'
  const isAdmin = isAdminRole(me)
  // Owner/admin may add a custom server for the whole company OR just for themselves; the backend
  // already permits either (a personal connector is owned by the caller). The toggle only makes sense
  // for the custom escape hatch — curated catalog templates keep whatever scope they were opened at.
  const [chosenScope, setChosenScope] = useState<ConnectorScope>(scope)
  const scopeToggle = isCustom && isAdmin
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
    const req: AddConnectorReq = { type: template.type, label: label || undefined, transport: template.transport, scope: chosenScope }
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
      // A structured template (resend/slack/…): route each field's value by its target.
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
            <BrandIcon name={template.type} box={24} /> Add {template.label}
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{chosenScope === 'personal' ? 'personal · only you' : 'company · whole team'}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{template.description}</p>

          <Field label="Name">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={template.label} />
          </Field>

          {scopeToggle && (
            <Field label="Scope" help={chosenScope === 'personal' ? 'Only loads in sessions you start, acting as you.' : 'Shared by every agent in the workspace.'}>
              <Segmented
                value={chosenScope}
                onChange={setChosenScope}
                options={[{ value: 'org', label: 'Company · whole team' }, { value: 'personal', label: 'Personal · only me' }]}
              />
            </Field>
          )}

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
            Credentials are stored locally in your data home. Tip: enter{' '}
            <span className="font-mono">secret:KEY</span> (or <span className="font-mono">secret:PRINCIPAL/KEY</span>) to
            reference an encrypted value from the <a href="#/settings/secrets" className="underline hover:text-foreground">Secrets vault</a>{' '}
            instead of storing the raw credential here — it's decrypted only at session launch.
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

// ── add/edit a host connection ───────────────────────────────────────────────────────────
const HOST_PROTOCOLS: { value: HostProtocol; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'ssh', label: 'SSH' }, { value: 'http', label: 'HTTP' }, { value: 'postgres', label: 'Postgres' },
]
const HOST_POSTURES: { value: HostPosture; label: string }[] = [
  { value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'never', label: 'Never' },
]

function AddHostDialog({ me, host, scope, onClose, onSaved }: {
  me: Member | null; host?: Host | null; scope: ConnectorScope; onClose: () => void; onSaved: () => void
}) {
  const editing = !!host
  const isAdmin = isAdminRole(me)
  const [name, setName] = useState(host?.name ?? '')
  const [match, setMatch] = useState(host?.match ?? '')
  const [protocol, setProtocol] = useState<HostProtocol>(host?.protocol ?? 'any')
  const [posture, setPosture] = useState<HostPosture>(host?.posture ?? 'ask')
  const [credential, setCredential] = useState('') // never prefilled (redacted); blank on edit = keep existing
  const [chosenScope, setChosenScope] = useState<ConnectorScope>(host?.scope ?? scope)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true); setHint('')
    const body: AddHostReq = { name: name.trim(), match: match.trim(), protocol, posture }
    if (credential.trim()) body.credential = credential.trim()
    if (!editing) body.scope = isAdmin ? chosenScope : 'personal'
    const res = editing ? await api.updateHost(host!.id, body) : await api.addHost(body)
    setBusy(false)
    if (res && 'error' in res) return setHint('⚠ ' + res.error)
    onSaved()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BrandIcon name={protocol === 'any' ? 'host' : protocol} box={24} /> {editing ? 'Edit host' : 'Add a host'}
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{chosenScope === 'personal' ? 'personal · only you' : 'company · whole team'}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            A <b>host</b> is a reachable destination — an SSH box, an internal service, a database — your agents may talk to.
            When <b>host governance</b> is on (<a href="#/settings/governance" className="underline hover:text-foreground">Settings → Governance</a>),
            reaches here are gated by policy; an SSH credential below is injected into the agent's shell at launch, so a plain
            <span className="font-mono"> ssh</span> authenticates without the agent handling the key.
          </p>

          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prod database" /></Field>

          <Field label="Host match" help="A hostname (db.internal.example.com), a wildcard (*.internal.example.com), a CIDR (10.0.0.0/8), or host:port.">
            <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="db.prod.internal:5432" className="font-mono text-xs" />
          </Field>

          <Field label="Protocol"><Segmented value={protocol} onChange={setProtocol} options={HOST_PROTOCOLS} /></Field>

          <Field label="Default posture" help="allow = reach freely · ask = pause for approval · never = always refuse. Takes effect once host governance is enabled (Settings → Governance).">
            <Segmented value={posture} onChange={setPosture} options={HOST_POSTURES} />
          </Field>

          <Field label="Credential" help="Optional. A Secrets-vault reference (secret:KEY) to an SSH private key. For an SSH host it's materialised into a session-scoped ssh_config at launch (offered only to this host); blank for none. Non-SSH creds aren't injected yet.">
            <Input value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={editing && host?.credential ? `${host.credential} (saved) — type to replace` : 'secret:SSH_KEY'} className="font-mono text-xs" />
          </Field>

          {isAdmin && !editing && (
            <Field label="Scope" help={chosenScope === 'personal' ? 'Only loads in sessions you start.' : 'Available to every agent in the workspace.'}>
              <Segmented value={chosenScope} onChange={setChosenScope} options={[{ value: 'org', label: 'Company · whole team' }, { value: 'personal', label: 'Personal · only me' }]} />
            </Field>
          )}
        </div>

        <DialogFooter>
          {hint && <span className="mr-auto self-center font-mono text-xs text-destructive">{hint}</span>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !match.trim()}><Server className="mr-1 h-4 w-4" />{editing ? 'Save' : 'Add host'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────────────
export function ConnectorsPage({ me }: { me: Member | null }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [ov, setOv] = useState<IntegrationsOverview | null>(null)
  const [conns, setConns] = useState<ConnectionsResp | null>(null)
  const [adding, setAdding] = useState<{ template: CatalogEntry; scope: ConnectorScope } | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  // A host being added (null host + a default scope) or edited (the host).
  const [hostForm, setHostForm] = useState<{ host: Host | null; scope: ConnectorScope } | null>(null)
  const [busy, setBusy] = useState('')

  const loadConnectors = () =>
    api.connectors().then((d) => {
      setConnectors(Array.isArray(d?.connectors) ? d.connectors : [])
      setCatalog(Array.isArray(d?.catalog) ? d.catalog : [])
    }).catch(() => {})
  const loadHosts = () => api.hosts().then((d) => setHosts(Array.isArray(d?.hosts) ? d.hosts : [])).catch(() => {})
  const loadOverview = () => api.integrationsOverview().then(setOv).catch(() => {})
  const loadConnections = () => api.connections().then(setConns).catch(() => {})
  const reloadAll = () => { loadConnectors(); loadHosts(); loadOverview(); loadConnections() }
  useEffect(() => { reloadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const withBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); await fn(); await loadConnectors(); setBusy('')
  }
  const toggle = (id: string, enabled: boolean) => withBusy(id, () => api.toggleConnector(id, enabled))
  const remove = (id: string) => withBusy(id, () => api.deleteConnector(id))
  const share = (id: string, shared: boolean) => withBusy(id, () => api.shareConnector(id, shared))

  const withHostBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); await fn(); await loadHosts(); setBusy('')
  }
  const toggleHost = (id: string, enabled: boolean) => withHostBusy(id, () => api.toggleHost(id, enabled))
  const shareHost = (id: string, shared: boolean) => withHostBusy(id, () => api.shareHost(id, shared))
  const removeHost = (id: string) => {
    if (!window.confirm('Remove this host connection?')) return
    withHostBusy(id, () => api.deleteHost(id))
  }
  const publishHost = (id: string) => withHostBusy(id, () => api.publishHost(id))

  const disconnectComposio = async (id: string, scope: 'company' | 'personal', label: string) => {
    const who = scope === 'company' ? 'the whole company' : 'yourself'
    if (!window.confirm(`Disconnect ${label} for ${who}?${scope === 'company' ? ' Every agent loses access.' : ''}`)) return
    setBusy(id)
    const r = await api.disconnectApp({ id, scope })
    setBusy('')
    if (r.error) return window.alert('Could not disconnect: ' + r.error)
    scope === 'company' ? loadOverview() : loadConnections()
  }

  const keySet = !!(ov?.composio.keySet || conns?.keySet)

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-muted-foreground">
        <b>Connections</b> are what your claude-code agents can reach — tool <b>integrations</b> (MCP servers &amp; apps)
        and <b>hosts</b> (SSH boxes, internal services, databases). <b>Company</b> connections are shared by every
        agent; <b>your</b> connections only load in sessions you start. The keys that power them live under the
        <b> Creds</b> tab. Every call still passes the gate, so risky actions land in the Inbox for approval.
      </p>

      {!showAdd && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setHostForm({ host: null, scope: isAdminRole(me) ? 'org' : 'personal' })}><Server className="mr-1 h-4 w-4" />Add a host</Button>
          <Button onClick={() => setShowAdd(true)}><Plus className="mr-1 h-4 w-4" />Add an integration</Button>
        </div>
      )}
      {showAdd && (
        <AddIntegration
          me={me}
          catalog={catalog}
          keySet={keySet}
          onPickTemplate={(template, scope) => setAdding({ template, scope })}
          onConnected={reloadAll}
          onClose={() => setShowAdd(false)}
        />
      )}

      <ConnectedList
        me={me}
        connectors={connectors}
        hosts={hosts}
        ov={ov}
        conns={conns}
        busy={busy}
        onToggle={toggle}
        onRemove={remove}
        onShare={share}
        onDisconnectComposio={disconnectComposio}
        onToggleHost={toggleHost}
        onRemoveHost={removeHost}
        onPublishHost={publishHost}
        onShareHost={shareHost}
        onEditHost={(h) => setHostForm({ host: h, scope: h.scope })}
      />

      {adding && (
        <AddConnectorDialog
          me={me}
          template={adding.template}
          scope={adding.scope}
          onClose={() => setAdding(null)}
          onAdded={async () => { setAdding(null); reloadAll() }}
        />
      )}

      {hostForm && (
        <AddHostDialog
          me={me}
          host={hostForm.host}
          scope={hostForm.scope}
          onClose={() => setHostForm(null)}
          onSaved={async () => { setHostForm(null); loadHosts() }}
        />
      )}
    </div>
  )
}
