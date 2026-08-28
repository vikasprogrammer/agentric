/**
 * Setup wizard — the first thing a new install should show an owner.
 *
 * A fresh instance boots into a console that works and does nothing useful: no runtime credential, no
 * company context, no connectors, no teammates. All of those were already settable — spread across six
 * Settings tabs, with nothing saying which ones matter or in what order. This page is that ordering,
 * made checkable.
 *
 * It owns no settings of its own: each step reads `GET /api/setup` for its status and writes through
 * the endpoint that already owns the setting (`saveCompany`, `saveIntegrations`, `invite`, the runtime
 * guided-login flow, the agent catalog). Two consequences worth keeping: a step completed elsewhere
 * (CLI, another admin, a config file) shows as done here without any sync, and nothing here can drift
 * out of agreement with the Settings page behind it.
 *
 * Skipping is first-class. "I don't want Slack" is a decision, not an omission, and an operator who
 * can't record it learns to ignore the banner instead — so a skipped step stops blocking while still
 * reporting its true status.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Check, Circle, AlertTriangle, ExternalLink, Loader2, ArrowRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  api, type Member, type Role, type SetupStatus, type SetupStep, type SetupStepId,
  type RuntimeLogin, type IntegrationsResp, type CatalogAgent, type MemorySettings, type MemorySettingsReq,
} from '@/lib/api'
import { createGithubApp } from '@/lib/github-app'

// ── shared bits ──────────────────────────────────────────────────────────────────
function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-muted-foreground">{children}</p>
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline hover:text-foreground">
      {children}<ExternalLink className="h-3 w-3" />
    </a>
  )
}

/** Saved-state feedback shared by every step: a transient line under the form, never a toast that
 *  vanishes before it's read on a slow box. */
function useSaveHint() {
  const [hint, setHint] = useState('')
  const say = (msg: string, ms = 5000) => { setHint(msg); if (ms) setTimeout(() => setHint(''), ms) }
  return { hint, say }
}

const STATUS_ICON = {
  done: <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
  unknown: <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
  todo: <Circle className="h-4 w-4 text-muted-foreground" />,
} as const

// ── the page ─────────────────────────────────────────────────────────────────────
export function SetupPage({ me, step, onStep, onDone }: {
  me: Member
  /** Selected step id from the hash (`#/setup/company`); '' → the first unfinished one. */
  step: string
  onStep: (id: string) => void
  /** Called after a save so the shell can re-read state (agent list, tenant name, …). */
  onDone?: () => void
}) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const admin = me.role === 'owner' || me.role === 'admin'

  const load = async () => {
    const r = await api.setup()
    if (!r.error) setStatus(r)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  if (!admin) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">Setup is owner/admin only — ask an owner to finish configuring this workspace.</CardContent></Card>
  }
  if (loading || !status) {
    return <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking what's configured…</CardContent></Card>
  }

  const settled = (s: SetupStep) => s.status === 'done' || s.status === 'unknown' || s.skipped
  // Deep-linked step wins; otherwise land on the first thing that still needs a decision, so the page
  // opens on work rather than on a step the operator already finished.
  const current = status.steps.find((s) => s.id === step) ?? status.steps.find((s) => !settled(s)) ?? status.steps[0]

  const skip = async (id: SetupStepId, on: boolean) => { const r = await api.skipSetupStep(id, on); if (!r.error) setStatus(r) }
  const finish = async () => { const r = await api.dismissSetup(true); if (!r.error) setStatus(r); onDone?.(); window.location.hash = '#/overview' }

  const next = () => {
    const rest = status.steps.slice(status.steps.findIndex((s) => s.id === current.id) + 1)
    const target = rest.find((s) => !settled(s)) ?? rest[0]
    if (target) onStep(target.id); else finish()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="h-4 w-4" /> Set up your workspace</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {status.total} things decide whether this install is useful. Each one links to the setting that owns it —
            finish them here, or anywhere else, and this page notices either way.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{status.done} / {status.total} done</span>
          <Button variant="outline" onClick={finish}>{status.complete ? 'Finish' : 'Close setup'}</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* step rail */}
        <div className="space-y-1">
          {status.steps.map((s, i) => (
            <button
              key={s.id}
              onClick={() => onStep(s.id)}
              className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${s.id === current.id ? 'border-foreground/30 bg-muted' : 'border-transparent hover:bg-muted/50'}`}
            >
              <span className="mt-0.5">{s.skipped ? <Circle className="h-4 w-4 text-muted-foreground/50" /> : STATUS_ICON[s.status]}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{i + 1}. {s.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{s.skipped ? 'skipped' : s.detail}</span>
              </span>
              {s.required && !settled(s) && <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">needed</Badge>}
            </button>
          ))}
        </div>

        {/* step body */}
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-medium">{STATUS_ICON[current.status]} {current.title}</h3>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{current.why}</p>
              </div>
              {!current.required && (
                <button className="whitespace-nowrap text-xs text-muted-foreground hover:text-foreground" onClick={() => skip(current.id, !current.skipped)}>
                  {current.skipped ? 'Un-skip' : 'Not now'}
                </button>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">{current.detail}</div>

            {current.id === 'claude' && <ClaudeStep status={status} onChanged={load} />}
            {current.id === 'company' && <CompanyStep onChanged={load} />}
            {current.id === 'composio' && <ComposioStep onChanged={load} />}
            {current.id === 'chat' && <ChatStep onChanged={load} />}
            {current.id === 'github' && <GithubStep onChanged={load} />}
            {current.id === 'memory' && <MemoryStep onChanged={load} />}
            {current.id === 'team' && <TeamStep onChanged={load} />}
            {current.id === 'agents' && <AgentsStep onChanged={() => { load(); onDone?.() }} />}

            <div className="flex items-center justify-between border-t pt-3">
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={load}>Re-check</button>
              <Button onClick={next}>Next <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// ── 1. runtime credential ────────────────────────────────────────────────────────
/** Drives the SAME guided sign-in as Settings → Runtime accounts: the box runs the runtime's own login
 *  in a throwaway pane and the console relays the URL + code. The flow has no server-side timer — this
 *  poll IS its clock, so it must keep running until the login settles. */
function ClaudeStep({ status, onChanged }: { status: SetupStatus; onChanged: () => void }) {
  const [name, setName] = useState('main')
  const [login, setLogin] = useState<RuntimeLogin | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()

  useEffect(() => {
    if (!login || login.phase === 'done' || login.phase === 'failed') return
    const t = setInterval(async () => {
      const r = await api.pollRuntimeLogin(login.id)
      if (!r.login) return
      setLogin(r.login)
      if (r.login.phase === 'done') { setLogin(null); say(r.account?.checkNote ? `signed in · ${r.account.checkNote}` : 'signed in'); onChanged() }
    }, 2000)
    return () => clearInterval(t)
  }, [login?.id, login?.phase])

  const start = async () => {
    setBusy(true)
    const r = await api.startRuntimeLogin('claude-code', name.trim())
    setBusy(false)
    if (r.error || !r.login) return say('⚠ ' + (r.error ?? 'could not start'), 8000)
    setLogin(r.login)
  }
  const submit = async () => {
    setBusy(true)
    const r = await api.submitRuntimeLoginCode(login!.id, code.trim())
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setCode(''); if (r.login) setLogin(r.login)
  }
  const cancel = async () => { if (login) await api.cancelRuntimeLogin(login.id); setLogin(null); setCode('') }

  return (
    <div className="space-y-3">
      {!status.guidedLogin && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          Guided sign-in isn't available on this box{status.guidedLoginWhy ? ` — ${status.guidedLoginWhy}` : ''}. Run <span className="font-mono">claude login</span> on
          the box as the service user, then add the credential directory under <a className="underline" href="#/settings/runtime">Settings → Runtime</a>.
        </div>
      )}
      {status.guidedLogin && !login && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="account name" className="h-8 w-44 font-mono text-xs" />
            <Button onClick={start} disabled={busy || !name.trim()}>{busy ? 'Starting…' : 'Sign in to Claude'}</Button>
            {hint && <span className="font-mono text-xs text-muted-foreground">{hint}</span>}
          </div>
          <Hint>
            Signs in <em>on this box</em> and stores that account's own credential directory — the only credential an
            interactive session can actually launch with. You'll get a link to authorize; use a private browser window
            so it doesn't reuse an account you're already signed into. Adding several here gives you rotation when one
            hits its usage limit.
          </Hint>
        </div>
      )}
      {login && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">Signing in as <span className="font-mono">{login.name}</span></span>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={cancel}>Cancel</button>
          </div>
          {login.notice && <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">{login.notice}</p>}
          {login.phase === 'starting' && <Hint>{login.notice ? 'Preparing a fresh authorization link…' : "Starting the runtime's sign-in — the authorization link appears here in a moment…"}</Hint>}
          {login.phase === 'awaiting-code' && login.url && (
            <div className="space-y-2">
              <Hint>
                1. Open the link and authorize, then 2. paste the code it gives you — the WHOLE string, including the
                <span className="font-mono"> #…</span> tail. Each link is single-use: if a code is rejected, use the fresh
                link that appears here, not the page you already have open.
              </Hint>
              <Link href={login.url}>Open the authorization page</Link>
              <div className="flex items-center gap-2">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="paste code" className="h-8 w-72 font-mono text-xs" />
                <Button onClick={submit} disabled={busy || !code.trim()}>Submit</Button>
              </div>
            </div>
          )}
          {login.phase === 'failed' && <p className="text-xs text-red-600 dark:text-red-400">{login.error ?? 'sign-in failed'}</p>}
        </div>
      )}
      <Hint>Already signed in on the box? That works too — the pool is optional, and an empty pool means every session uses the box's own login.</Hint>
    </div>
  )
}

// ── 2. company context ───────────────────────────────────────────────────────────
/** The starter outline exists because "describe your company" in an empty textarea reliably produces
 *  either nothing or three vague lines; headings produce answers. */
const COMPANY_TEMPLATE = `# About us

What we do, who we sell to, and what we're currently trying to move.

# Product

The products/services, their names, and where each one lives (repo, dashboard, docs).

# Stack

Languages, frameworks, hosting, database, CI. Where the code lives.

# How we work

Working hours + timezone, how work arrives (tickets, Slack, standups), what "done" means,
and who to ask about what.

# House rules

Anything an agent must never do without asking (touch production, email customers, spend money).
`

function CompanyStep({ onChanged }: { onChanged: () => void }) {
  const [md, setMd] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()
  useEffect(() => { api.settings().then((r) => setMd(r.companyMd ?? '')).catch(() => {}) }, [])

  const save = async () => {
    setBusy(true)
    const r = await api.saveCompany(md)
    setBusy(false)
    say(r.error ? '⚠ ' + r.error : 'saved — every new session gets this context')
    if (!r.error) onChanged()
  }

  return (
    <div className="space-y-2">
      <Textarea value={md} onChange={(e) => setMd(e.target.value)} rows={14} className="font-mono text-xs" placeholder="Markdown — who you are, what you build, how you work…" />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save context'}</Button>
        {!md.trim() && <Button variant="outline" onClick={() => setMd(COMPANY_TEMPLATE)}>Start from an outline</Button>}
        <a className="text-xs text-muted-foreground underline hover:text-foreground" href="#/settings/company">Open in Settings</a>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Hint>
        Appended to every claude-code agent's system prompt, ahead of the agent's own instructions. Keep it factual and
        specific — names, URLs, repos, hours. It costs tokens on every run, so aim for a page, not a handbook.
      </Hint>
    </div>
  )
}

// ── 3. Composio ──────────────────────────────────────────────────────────────────
function ComposioStep({ onChanged }: { onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [resp, setResp] = useState<IntegrationsResp | null>(null)
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()
  const load = () => api.integrations().then((r) => { if (!r.error) setResp(r) }).catch(() => {})
  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true)
    const r = await api.saveIntegrations({ composioApiKey: key.trim() })
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setKey(''); say('saved'); load(); onChanged()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={resp?.composio.set ? `set (${resp.composio.hint}) — paste to replace` : 'composio API key'} className="h-8 w-96 font-mono text-xs" />
        <Button onClick={save} disabled={busy || !key.trim()}>{busy ? 'Saving…' : 'Save key'}</Button>
        <a className="text-xs text-muted-foreground underline hover:text-foreground" href="#/connectors">Open Connections</a>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Hint>
        Get a key at <Link href="https://app.composio.dev/developers">app.composio.dev → Developers</Link>. One workspace key
        covers everyone: each member then connects their own Gmail/Slack/Notion account from{' '}
        <a className="underline" href="#/connectors">Connections</a>, and a session only ever sees the accounts belonging to
        the person it runs as. Free tier is enough to try it.
      </Hint>
    </div>
  )
}

// ── 4. chat channel ──────────────────────────────────────────────────────────────
function ChatStep({ onChanged }: { onChanged: () => void }) {
  const [resp, setResp] = useState<IntegrationsResp | null>(null)
  const [slackApp, setSlackApp] = useState('')
  const [slackBot, setSlackBot] = useState('')
  const [discord, setDiscord] = useState('')
  const [telegram, setTelegram] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()
  const load = () => api.integrations().then((r) => { if (!r.error) setResp(r) }).catch(() => {})
  useEffect(() => { load() }, [])

  const save = async (body: Parameters<typeof api.saveIntegrations>[0], label: string) => {
    setBusy(true)
    const r = await api.saveIntegrations(body)
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setSlackApp(''); setSlackBot(''); setDiscord(''); setTelegram('')
    say(`${label} saved — the connection re-dials immediately`); load(); onChanged()
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs font-medium">Slack {resp?.slack.configured && <Badge variant="outline" className="ml-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">connected</Badge>}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={slackApp} onChange={(e) => setSlackApp(e.target.value)} type="password" placeholder={resp?.slack.appToken ? 'app token set — paste to replace' : 'xapp-… (app-level token)'} className="h-8 w-72 font-mono text-xs" />
          <Input value={slackBot} onChange={(e) => setSlackBot(e.target.value)} type="password" placeholder={resp?.slack.botToken ? 'bot token set — paste to replace' : 'xoxb-… (bot token)'} className="h-8 w-72 font-mono text-xs" />
          <Button onClick={() => save({ slackAppToken: slackApp.trim(), slackBotToken: slackBot.trim() }, 'Slack')} disabled={busy || (!slackApp.trim() && !slackBot.trim())}>Save</Button>
        </div>
        <Hint>
          Create an app at <Link href="https://api.slack.com/apps">api.slack.com/apps</Link>, enable <strong>Socket Mode</strong>, and copy
          both tokens. Socket Mode dials OUT to Slack, so this box needs no public URL. The full scope list + manifest is
          in <a className="underline" href="#/settings/integrations">Settings → Integrations</a>.
        </Hint>
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="text-xs font-medium">Discord {resp?.discord.configured && <Badge variant="outline" className="ml-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">connected</Badge>}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={discord} onChange={(e) => setDiscord(e.target.value)} type="password" placeholder={resp?.discord.botToken ? 'bot token set — paste to replace' : 'bot token'} className="h-8 w-96 font-mono text-xs" />
          <Button onClick={() => save({ discordBotToken: discord.trim() }, 'Discord')} disabled={busy || !discord.trim()}>Save</Button>
        </div>
        <Hint>One bot from <Link href="https://discord.com/developers/applications">discord.com/developers</Link>; enable the privileged <span className="font-mono">MESSAGE CONTENT</span> intent or it can't read what people write.</Hint>
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="text-xs font-medium">Telegram {resp?.telegram.configured && <Badge variant="outline" className="ml-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">connected</Badge>}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={telegram} onChange={(e) => setTelegram(e.target.value)} type="password" placeholder={resp?.telegram.botToken ? 'bot token set — paste to replace' : 'bot token'} className="h-8 w-96 font-mono text-xs" />
          <Button onClick={() => save({ telegramBotToken: telegram.trim() }, 'Telegram')} disabled={busy || !telegram.trim()}>Save</Button>
        </div>
        <Hint>Ask <Link href="https://t.me/BotFather">@BotFather</Link> for a token. Long-polling, so no public URL here either.</Hint>
      </div>

      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ── 5. GitHub ────────────────────────────────────────────────────────────────────
/**
 * The App is two credentials that do different jobs, and an install wants both: the OAuth pair lets a
 * member link their own account (so a PR is authored by the human the session runs as), and the App
 * id + private key mint the company-bot token every OTHER session pushes with. The one-click manifest
 * flow creates an App with both halves already correct — the manual fields exist for an App that
 * already exists.
 */
function GithubStep({ onChanged }: { onChanged: () => void }) {
  const [resp, setResp] = useState<IntegrationsResp | null>(null)
  const [org, setOrg] = useState('')
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()
  const load = () => api.integrations().then((r) => { if (!r.error) setResp(r) }).catch(() => {})
  useEffect(() => { load() }, [])
  const gh = resp?.github

  const create = async () => {
    setBusy(true)
    const err = await createGithubApp(org)   // on success the browser leaves for GitHub
    if (err) { setBusy(false); say('⚠ ' + err, 8000) }
  }
  const saveManual = async () => {
    setBusy(true)
    const r = await api.saveIntegrations({
      ...(id.trim() ? { githubClientId: id.trim() } : {}),
      ...(secret.trim() ? { githubClientSecret: secret.trim() } : {}),
    })
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setId(''); setSecret(''); say('saved'); load(); onChanged()
  }

  return (
    <div className="space-y-3">
      {!gh?.configured && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={org} onChange={(e) => setOrg(e.target.value.trim())} placeholder="your-org (optional)" className="h-8 w-56 font-mono text-xs" />
            <Button onClick={create} disabled={busy}>{busy ? 'Opening GitHub…' : 'Create GitHub App'}</Button>
          </div>
          <Hint>
            GitHub opens a confirmation with everything pre-filled — name, this server's callback URL, and least-privilege
            permissions (Contents + Pull requests, no webhook) — then hands the credentials straight back here. Nothing to
            copy. Leave the org blank to create it under your personal account; you must be signed in to GitHub in this browser.
          </Hint>
        </div>
      )}

      {gh?.installUrl && (
        <div className="space-y-1 rounded-md border bg-muted/20 p-3">
          <div className="text-xs font-medium">Install it on your repositories</div>
          <Hint>A GitHub App can only touch repos it is installed on — this is the step people miss, and it looks exactly like a broken token.</Hint>
          <Link href={gh.installUrl}>Install “{gh.slug}” on your repos</Link>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border p-2">
          <div className="text-xs font-medium">
            Per-member sign-in{' '}
            {gh?.configured
              ? <Badge variant="outline" className="ml-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">ready</Badge>
              : <Badge variant="outline" className="ml-1 text-[10px]">not set</Badge>}
          </div>
          <Hint>Each teammate connects their own account from <a className="underline" href="#/connectors">Connections</a>; a session running as them then commits and opens PRs under their name.</Hint>
        </div>
        <div className="rounded-md border p-2">
          <div className="text-xs font-medium">
            Company bot{' '}
            {gh?.botReady
              ? <Badge variant="outline" className="ml-1 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">active</Badge>
              : <Badge variant="outline" className="ml-1 text-[10px]">not set</Badge>}
          </div>
          <Hint>The fallback: an App id + private key mint a short-lived installation token so an unattended run with no linked human can still push. Add them in <a className="underline" href="#/settings/integrations">Settings → Integrations</a>.</Hint>
        </div>
      </div>

      <details className="rounded-md border" open={!gh?.configured}>
        <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
          {gh?.configured ? 'Replace the credentials manually' : 'Already have an App? Paste its credentials'}
        </summary>
        <div className="space-y-2 border-t p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder={gh?.clientId ? 'client id saved — type to replace' : 'client id'} className="h-8 w-64 font-mono text-xs" />
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder={gh?.clientSecret ? '•••• saved — type to replace' : 'client secret'} className="h-8 w-64 font-mono text-xs" />
            <Button onClick={saveManual} disabled={busy || (!id.trim() && !secret.trim())}>Save</Button>
          </div>
          <Hint>Set the app's authorization callback URL to this server's <span className="font-mono">/api/github/callback</span>.</Hint>
        </div>
      </details>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ── 6. memory layer ──────────────────────────────────────────────────────────────
/**
 * Two upgrades over the keyword-only default, and the choice is genuinely a trade: an embedder on the
 * built-in sqlite store is one API key and no new infrastructure; AutoMem is a real graph + vector
 * service — better recall, at the cost of running (or paying for) it. Everything else on Settings →
 * Memory (ranking, maintenance, preload, shared-write policy) is carried through untouched, because
 * `PUT /api/settings/memory` REPLACES the config: sending a bare backend would silently wipe them.
 */
function MemoryStep({ onChanged }: { onChanged: () => void }) {
  const [view, setView] = useState<MemorySettings | null>(null)
  const [choice, setChoice] = useState<'sqlite' | 'automem'>('sqlite')
  const [key, setKey] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()

  const load = () => api.memorySettings().then((r) => {
    if (r.error) return
    setView(r)
    if (r.backend === 'automem') { setChoice('automem'); setEndpoint(r.automem?.endpoint ?? '') }
  }).catch(() => {})
  useEffect(() => { load() }, [])

  /** Carry the backend-independent settings forward — see the note above. */
  const carry = (): Partial<MemorySettingsReq> => ({
    ...(view?.ranking ? { ranking: view.ranking } : {}),
    ...(view?.maintenance ? { maintenance: view.maintenance } : {}),
    ...(view?.sharedWrites ? { sharedWrites: view.sharedWrites } : {}),
    ...(view?.preload ? { preload: view.preload } : {}),
  })
  const body = (): MemorySettingsReq => choice === 'automem'
    ? { backend: 'automem', automem: { endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) }, ...carry() }
    : {
        backend: 'sqlite',
        sqlite: { embeddings: { enabled: true, provider: 'openai', url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: 1536, ...(key.trim() ? { apiKey: key.trim() } : {}) } },
        ...carry(),
      }

  const test = async () => {
    setBusy(true)
    const r = await api.testMemorySettings(body())
    setBusy(false)
    say(r.error ? '⚠ ' + r.error : `reachable — ${r.health?.backend ?? 'ok'}`, 8000)
  }
  const save = async () => {
    setBusy(true)
    const r = await api.saveMemorySettings(body())
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setKey(''); setToken(''); say('saved — recall switches over immediately, no restart'); load(); onChanged()
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {([
          { id: 'sqlite' as const, title: 'Built-in store + embeddings', blurb: 'One OpenAI key. Hybrid keyword + vector recall in the workspace DB — no new service to run.' },
          { id: 'automem' as const, title: 'AutoMem (recommended)', blurb: 'A real memory service (graph + vectors): better recall, consolidation, and relationships between memories.' },
        ]).map((o) => (
          <button
            key={o.id}
            onClick={() => setChoice(o.id)}
            className={`rounded-md border p-3 text-left text-xs transition-colors ${choice === o.id ? 'border-foreground/30 bg-muted' : 'hover:bg-muted/50'}`}
          >
            <div className="font-medium">
              {o.title}
              {view?.backend === o.id && <Badge variant="outline" className="ml-2 border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400">active</Badge>}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{o.blurb}</div>
          </button>
        ))}
      </div>

      {choice === 'sqlite' ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder={view?.sqlite?.embeddings?.apiKeySet ? 'key set — paste to replace' : 'sk-… (OpenAI API key)'} className="h-8 w-96 font-mono text-xs" />
            <Button onClick={save} disabled={busy || (!key.trim() && !view?.sqlite?.embeddings?.apiKeySet)}>{busy ? 'Saving…' : 'Turn on hybrid recall'}</Button>
          </div>
          <Hint>
            Embeds every memory with <span className="font-mono">text-embedding-3-small</span> (1536 dims) and ranks recall by
            keywords AND meaning. Vectors live in a column of this workspace's own database, so there is nothing else to run —
            embedding calls are billed by OpenAI and are cheap. Prefer a local embedder? Ollama is on{' '}
            <a className="underline" href="#/settings/memory">Settings → Memory</a>.
          </Hint>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://automem.internal:8001" className="h-8 w-72 font-mono text-xs" />
            <Input value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder={view?.automem?.tokenSet ? 'token set — paste to replace' : 'token'} className="h-8 w-52 font-mono text-xs" />
            <Button variant="outline" onClick={test} disabled={busy || !endpoint.trim()}>Test</Button>
            <Button onClick={save} disabled={busy || !endpoint.trim()}>{busy ? 'Saving…' : 'Use AutoMem'}</Button>
          </div>
          <Hint>
            AutoMem is a self-hostable REST service (FalkorDB graph + Qdrant vectors) —{' '}
            <Link href="https://github.com/verygoodplugins/mcp-automem">deploy it</Link>, then paste its base URL and token here.
            Test before you save: a wrong endpoint fails closed and every recall comes back empty. Existing memories stay in the
            local ledger — <a className="underline" href="#/settings/memory">Settings → Memory</a> migrates them up afterwards.
          </Hint>
        </div>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Hint>
        Either way the memories themselves are written by agents (<span className="font-mono">remember</span>) and by the nightly
        reflect pass — this only decides how well they are found again.
      </Hint>
    </div>
  )
}

// ── 7. team ──────────────────────────────────────────────────────────────────────
function TeamStep({ onChanged }: { onChanged: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const { hint, say } = useSaveHint()

  const invite = async () => {
    setBusy(true)
    const r = await api.invite(email.trim(), role)
    setBusy(false)
    if (r.error) return say('⚠ ' + r.error, 8000)
    setEmail(''); setLink(r.link); say('invited'); onChanged()
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className="h-8 w-72 text-xs" />
        <Select value={role} onValueChange={(v) => setRole((v as Role) ?? 'member')}>
          <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="member">member</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
            <SelectItem value="owner">owner</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={invite} disabled={busy || !email.trim()}>{busy ? 'Inviting…' : 'Invite'}</Button>
        <a className="text-xs text-muted-foreground underline hover:text-foreground" href="#/team">Open Team</a>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {link && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2">
          <Hint>Send them this one-time link — there's no email server involved:</Hint>
          <div className="break-all font-mono text-[11px]">{link}</div>
        </div>
      )}
      <Hint>
        <strong>owner</strong> approves anything and manages the team · <strong>admin</strong> approves the middle tier and runs
        any agent · <strong>member</strong> runs only the agents assigned to them and never approves. Roles are what make
        approvals meaningful, so invite at least one other approver — otherwise every red-tier action waits on you.
      </Hint>
    </div>
  )
}

// ── 8. agents ────────────────────────────────────────────────────────────────────
function AgentsStep({ onChanged }: { onChanged: () => void }) {
  const [catalog, setCatalog] = useState<CatalogAgent[]>([])
  const [busy, setBusy] = useState('')
  const { hint, say } = useSaveHint()
  const load = () => api.agentCatalog().then((r) => { if (!r.error) setCatalog(r.catalog) }).catch(() => {})
  useEffect(() => { load() }, [])

  const install = async (id: string) => {
    setBusy(id)
    const r = await api.installAgentFromCatalog(id)
    setBusy('')
    if (r.error) return say('⚠ ' + r.error, 8000)
    say(`${id} installed`); load(); onChanged()
  }

  const available = catalog.filter((c) => !c.installed).slice(0, 8)
  return (
    <div className="space-y-2">
      {available.length === 0 && <Hint>Nothing left in the catalog to install.</Hint>}
      <div className="grid gap-2 sm:grid-cols-2">
        {available.map((c) => (
          <div key={c.id} className="flex items-start justify-between gap-2 rounded-md border p-2">
            <div className="min-w-0">
              <div className="font-mono text-xs">{c.id}</div>
              <div className="line-clamp-2 text-[11px] text-muted-foreground">{c.description}</div>
            </div>
            <Button variant="outline" onClick={() => install(c.id)} disabled={busy === c.id}>{busy === c.id ? '…' : 'Install'}</Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <a className="text-xs underline hover:text-foreground" href="#/agents">Browse all agents</a>
        <a className="text-xs underline hover:text-foreground" href="#/agent/agent-author">Have agent-author build one for you</a>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <Hint>
        A catalog agent is a starting point, not a fixture — installing copies it into this workspace, and you (or the
        agent itself) can rewrite its prompt afterwards. For work the catalog doesn't cover, describe the job to
        <span className="font-mono"> agent-author</span> and it writes the agent.
      </Hint>
    </div>
  )
}

// ── the console-wide nudge ───────────────────────────────────────────────────────
/**
 * A one-line banner shown above every page until setup is finished or dismissed. Deliberately quiet:
 * one line, a count, two actions. Owner/admin only — a member can't fix any of it, so nagging them is
 * pure noise.
 */
export function SetupBanner({ me }: { me: Member }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const admin = me.role === 'owner' || me.role === 'admin'
  useEffect(() => {
    if (!admin) return
    api.setup().then((r) => {
      if (r.error) return
      setStatus(r)
      // First load of a browser session on an install that has never been through setup: open the
      // wizard instead of leaving an owner on an empty Overview wondering what to do. Once per session
      // and only while it has NEVER been dismissed — a banner is enough after that, and a page that
      // keeps grabbing the URL is worse than one nobody opens.
      if (!r.dismissedAt && r.blocking > 0 && !sessionStorage.getItem('aos.setup.autoOpened')) {
        sessionStorage.setItem('aos.setup.autoOpened', '1')
        window.location.hash = '#/setup'
      }
    }).catch(() => {})
  }, [admin])

  if (!admin || !status || status.complete || status.dismissedAt) return null
  const dismiss = async () => { const r = await api.dismissSetup(true); if (!r.error) setStatus(r) }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <span className="flex-1">
        <strong>Finish setting up</strong> — {status.done} of {status.total} done
        {status.blocking > 0 && <> · {status.blocking} still needed before agents can do real work</>}
      </span>
      <a className="underline hover:text-foreground" href="#/setup">Open setup</a>
      <button className="text-muted-foreground hover:text-foreground" onClick={dismiss}>Dismiss</button>
    </div>
  )
}
