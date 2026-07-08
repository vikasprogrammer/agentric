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
import { Plug, Globe, Plus, Trash2, X, Search, Building2, User as UserIcon, ExternalLink } from 'lucide-react'
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
  type IntegrationsOverview, type ConnectionsResp,
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
  if (key === 'custom' || key === 'customremote') {
    const Glyph = key === 'customremote' ? Globe : Plug
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
          {!keySet && ' Connecting Composio apps needs a company Composio key (an admin adds it in Settings → Integrations).'}
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

/** A native chat-bot row (Slack / Discord) — status only; setup lives in Settings → Integrations. */
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
        ? <a href="#/settings/integrations" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline hover:text-foreground">Settings <ExternalLink className="h-3 w-3" /></a>
        : <span className="text-[11px] text-muted-foreground">managed by an admin</span>}
    />
  )
}

function ConnectedList({ me, connectors, ov, conns, busy, onToggle, onRemove, onShare, onDisconnectComposio }: {
  me: Member | null
  connectors: Connector[]
  ov: IntegrationsOverview | null
  conns: ConnectionsResp | null
  busy: string
  onToggle: (id: string, enabled: boolean) => void
  onRemove: (id: string) => void
  onShare: (id: string, shared: boolean) => void
  onDisconnectComposio: (id: string, scope: 'company' | 'personal', label: string) => void
}) {
  const isAdmin = isAdminRole(me)
  const [filter, setFilter] = useState<'all' | 'company' | 'mine'>('all')

  // Company = org connectors + shared personal ones + company Composio apps + native bots. Company
  // apps come from /api/connections (carries each connection's distinguishing name), not the overview.
  const orgConnectors = connectors.filter((c) => c.scope === 'org' || (c.scope === 'personal' && c.shared))
  const companyApps = conns?.company ?? []
  // Mine = the viewer's own personal connectors + their own Composio apps.
  const myConnectors = connectors.filter((c) => c.scope === 'personal' && c.ownerMemberId === me?.id)
  const myApps = conns?.mine ?? []

  const companyCount = orgConnectors.length + companyApps.length + 2 // +2 for the native bot rows
  const mineCount = myConnectors.length + myApps.length
  const showCompany = filter === 'all' || filter === 'company'
  const showMine = filter === 'all' || filter === 'mine'

  const cardProps = { me, busy, onToggle, onRemove, onShare }

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
        </div>
      )}

      {showMine && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <UserIcon className="h-3.5 w-3.5" /> Mine — only load in sessions you start
            {conns?.me && <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]" title="your Composio user_id">{conns.me}</code>}
          </div>
          {!conns?.keySet && myConnectors.length === 0 && (
            <p className="text-xs text-muted-foreground">Connecting your own apps needs a company Composio key (an admin sets it in Settings → Integrations).</p>
          )}
          {conns?.keySet && myApps.length === 0 && myConnectors.length === 0 && (
            <p className="text-xs text-muted-foreground">You haven’t connected any personal apps or servers yet.</p>
          )}
          {myApps.map((a) => (
            <ComposioRow key={a.id} app={a} canRemove busy={busy === a.id} onRemove={() => onDisconnectComposio(a.id, 'personal', a.toolkit)} />
          ))}
          {myConnectors.map((c) => <ConnectorRow key={c.id} c={c} {...cardProps} />)}
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

// ── page ─────────────────────────────────────────────────────────────────────────────
export function ConnectorsPage({ me }: { me: Member | null }) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [ov, setOv] = useState<IntegrationsOverview | null>(null)
  const [conns, setConns] = useState<ConnectionsResp | null>(null)
  const [adding, setAdding] = useState<{ template: CatalogEntry; scope: ConnectorScope } | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [busy, setBusy] = useState('')

  const loadConnectors = () =>
    api.connectors().then((d) => {
      setConnectors(Array.isArray(d?.connectors) ? d.connectors : [])
      setCatalog(Array.isArray(d?.catalog) ? d.catalog : [])
    }).catch(() => {})
  const loadOverview = () => api.integrationsOverview().then(setOv).catch(() => {})
  const loadConnections = () => api.connections().then(setConns).catch(() => {})
  const reloadAll = () => { loadConnectors(); loadOverview(); loadConnections() }
  useEffect(() => { reloadAll() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const withBusy = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); await fn(); await loadConnectors(); setBusy('')
  }
  const toggle = (id: string, enabled: boolean) => withBusy(id, () => api.toggleConnector(id, enabled))
  const remove = (id: string) => withBusy(id, () => api.deleteConnector(id))
  const share = (id: string, shared: boolean) => withBusy(id, () => api.shareConnector(id, shared))

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
        Connectors give your claude-code agents real tools. <b>Company</b> integrations are shared by every agent;
        <b> your</b> connections only load in sessions you start. Every call still passes the gate, so risky actions
        land in the Inbox for approval.
      </p>

      {!showAdd && (
        <div className="flex justify-end">
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
        ov={ov}
        conns={conns}
        busy={busy}
        onToggle={toggle}
        onRemove={remove}
        onShare={share}
        onDisconnectComposio={disconnectComposio}
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
    </div>
  )
}
