/**
 * Two-factor sign-in in the console (server: src/governance/mfa.ts, routes in src/server.ts).
 *
 *   TwoFactorChallenge — the second login step, shown when the magic link was used but a code is owed.
 *   TwoFactorNag       — the "turn it on" reminder, on the workspace cadence (every login / every N days).
 *   TwoFactorSection   — Profile: enrol (QR + key), recovery codes, move device, turn off.
 *   TwoFactorPolicyCard — Settings → Governance: the reminder cadence + adoption.
 */
import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, Copy, Download, KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { api, type Member, type TwoFactorStatus, type TwoFactorPolicy } from '@/lib/api'
import { readableOn } from '@/lib/branding'

const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

function ErrorNote({ text }: { text?: string }) {
  if (!text) return null
  return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{text}</div>
}

/** Six-digit code input: numeric keypad on phones, OS one-time-code autofill, Enter submits. */
function CodeInput({ value, onChange, onEnter, autoFocus, recovery }: { value: string; onChange: (v: string) => void; onEnter: () => void; autoFocus?: boolean; recovery?: boolean }) {
  return (
    <Input
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(recovery ? e.target.value : e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
      onKeyDown={(e) => e.key === 'Enter' && onEnter()}
      inputMode={recovery ? 'text' : 'numeric'}
      autoComplete={recovery ? 'off' : 'one-time-code'}
      placeholder={recovery ? 'xxxx-xxxx' : '123456'}
      className="font-mono tracking-widest"
    />
  )
}

// ── login step 2 ────────────────────────────────────────────────────────────────
export function TwoFactorChallenge({ email, accent, onDone }: { email: string; accent?: string; onDone: () => void }) {
  const brandStyle = accent ? { backgroundColor: accent, color: readableOn(accent) } : undefined
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [expired, setExpired] = useState(false)
  const ready = recovery ? code.trim().length >= 8 : code.length === 6
  const submit = async () => {
    if (!ready || busy) return
    setBusy(true); setError(undefined)
    try {
      const r = await api.verifyTwoFactor(code)
      if (r.ok) return onDone()
      if (r.expired) setExpired(true)
      setError(r.error + (r.remaining != null ? ` — ${r.remaining} ${r.remaining === 1 ? 'try' : 'tries'} left` : ''))
      setCode('')
    } catch {
      setError('Could not reach the server — try again.')
    } finally {
      setBusy(false)
    }
  }
  const startOver = async () => { try { await api.logout() } catch { /* clear either way */ } window.location.href = '/' }
  return (
    <div className="flex h-screen items-center justify-center bg-muted/30">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5" /> Two-factor sign-in</div>
          <p className="text-sm text-muted-foreground">
            Signing in as <span className="font-medium text-foreground">{email}</span>.{' '}
            {recovery ? 'Enter one of the recovery codes you saved when you set up two-factor. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
          </p>
          <ErrorNote text={error} />
          {expired ? (
            <Button className="w-full" style={brandStyle} onClick={startOver}>Back to sign-in</Button>
          ) : (
            <>
              <CodeInput value={code} onChange={setCode} onEnter={submit} autoFocus recovery={recovery} />
              <Button className="w-full" style={brandStyle} onClick={submit} disabled={!ready || busy}>{busy ? 'Checking…' : 'Verify'}</Button>
              <div className="flex items-center justify-between text-xs">
                <button className="text-muted-foreground underline hover:text-foreground" onClick={() => { setRecovery(!recovery); setCode(''); setError(undefined) }}>
                  {recovery ? 'Use my authenticator app' : 'Use a recovery code'}
                </button>
                <button className="text-muted-foreground hover:text-foreground" onClick={startOver}>Cancel</button>
              </div>
              <p className="text-[11px] text-muted-foreground">Lost your phone and your recovery codes? Ask a workspace owner or admin to reset your two-factor from the Team page.</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── the reminder ────────────────────────────────────────────────────────────────
/** Shown once per page load while /api/auth/me says it's due. "Set it up" goes to Profile; either button
 *  records the dismissal (quiet for the rest of this login, and the every-N-days clock restarts). */
export function TwoFactorNag({ me }: { me: Member }) {
  const [open, setOpen] = useState(!!me.twoFactor?.nag && !me.twoFactor?.enabled)
  const dismiss = () => { setOpen(false); api.dismissTwoFactorNag().catch(() => {}) }
  const setup = () => {
    dismiss()
    window.location.hash = '#/profile'
    // The Profile page mounts after the hash change; give it a tick, then bring the section into view.
    setTimeout(() => document.getElementById('pf-2fa')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) dismiss() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-amber-500" />Turn on two-factor sign-in</DialogTitle>
          <DialogDescription>
            Your account can run agents that act on real systems. Right now anyone holding one of your sign-in links can get in —
            links travel through chat DMs and server logs. A code from an authenticator app on your phone closes that gap. It takes about a minute.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>Not now</Button>
          <Button onClick={setup}>Set it up</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── recovery codes ──────────────────────────────────────────────────────────────
function RecoveryCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const text = `Agentric recovery codes for ${email}\nEach code signs you in once if you lose your authenticator.\n\n${codes.join('\n')}\n`
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* non-secure context: the codes are on screen */ }
  }
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = 'agentric-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="text-sm font-medium">Save your recovery codes</div>
      <p className="text-xs text-muted-foreground">
        If you lose your phone, each of these signs you in once. This is the only time they're shown — store them in a password manager.
      </p>
      <div className="grid grid-cols-2 gap-1 rounded-md bg-background p-3 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={copy}><Copy className="mr-1 h-3.5 w-3.5" />{copied ? 'Copied' : 'Copy'}</Button>
        <Button size="sm" variant="outline" onClick={download}><Download className="mr-1 h-3.5 w-3.5" />Download</Button>
        <Button size="sm" className="ml-auto" onClick={onDone}>I've saved them</Button>
      </div>
    </div>
  )
}

// ── Profile section ─────────────────────────────────────────────────────────────
type Action = 'recovery' | 'move' | 'disable'
const ACTION_LABEL: Record<Action, string> = { recovery: 'New recovery codes', move: 'Move to a new phone', disable: 'Turn off' }

export function TwoFactorSection({ me }: { me: Member }) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null)
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const load = () => api.twoFactor().then((s) => { if (!s.error) setStatus(s) }).catch(() => {})
  useEffect(() => { load() }, [])

  const reset = () => { setCode(''); setError(undefined) }
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { await fn() } catch { setError('Could not reach the server — try again.') } finally { setBusy(false) }
  }
  const begin = (current?: string) => run(async () => {
    const r = await api.twoFactorSetup(current)
    if (r.error || !r.secret || !r.qrSvg) return setError(r.error || 'Could not start setup.')
    setSetup({ secret: r.secret, qrSvg: r.qrSvg }); setAction(null); setCode('')
  })
  const enable = () => run(async () => {
    const r = await api.twoFactorEnable(code)
    if (!r.ok) return setError(r.error || 'That code is not right.')
    setSetup(null); setCode(''); setCodes(r.recoveryCodes ?? null); setStatus(r)
  })
  const confirmAction = () => run(async () => {
    if (action === 'move') return begin(code)
    if (action === 'disable') {
      const r = await api.twoFactorDisable(code)
      if (!r.ok) return setError(r.error || 'That code is not right.')
      setStatus(r); setAction(null); setCode('')
      return
    }
    const r = await api.twoFactorRecovery(code)
    if (!r.ok) return setError(r.error || 'That code is not right.')
    setStatus(r); setCodes(r.recoveryCodes ?? null); setAction(null); setCode('')
  })

  const grouped = setup?.secret.match(/.{1,4}/g)?.join(' ') ?? ''
  return (
    <section id="pf-2fa" className="space-y-2 scroll-mt-4">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Two-factor sign-in</div>
      <p className="text-sm text-muted-foreground">
        After you open a sign-in link, also ask for a code from an authenticator app (1Password, Google Authenticator, Authy, …) —
        so a forwarded or leaked link alone can't get into your account.
      </p>
      <ErrorNote text={error} />
      {codes ? (
        <RecoveryCodes codes={codes} email={me.email} onDone={() => setCodes(null)} />
      ) : setup ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="text-sm font-medium">1. Scan this with your authenticator app</div>
            <div className="flex flex-wrap items-center gap-4">
              {/* Server-rendered SVG (src/governance/qr.ts) — no user content in it but the otpauth URI. */}
              <div className="rounded-md bg-white p-2" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
              <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
                <div>Can't scan? Enter this key instead:</div>
                <div className="break-all font-mono text-sm text-foreground">{grouped}</div>
                <div>Time-based · 6 digits · 30 seconds</div>
              </div>
            </div>
            <div className="text-sm font-medium">2. Enter the 6-digit code it shows</div>
            <div className="flex max-w-xs gap-2">
              <CodeInput value={code} onChange={setCode} onEnter={enable} autoFocus />
              <Button onClick={enable} disabled={code.length !== 6 || busy}>{busy ? '…' : 'Turn on'}</Button>
            </div>
            <button className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => { setSetup(null); reset() }}>Cancel</button>
          </CardContent>
        </Card>
      ) : !status ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : status.enabled ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              <span className="font-medium">On</span>
              <span className="text-muted-foreground">since {fmtDate(status.enabledAt)} · {status.recoveryRemaining} recovery {status.recoveryRemaining === 1 ? 'code' : 'codes'} left</span>
            </div>
            {status.recoveryRemaining <= 2 && <div className="text-xs text-amber-600 dark:text-amber-400">You're running low on recovery codes — make new ones.</div>}
            {action ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">{ACTION_LABEL[action]}: confirm with a current code from your authenticator (or a recovery code).</div>
                <div className="flex max-w-sm gap-2">
                  <Input value={code} autoFocus onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirmAction()} placeholder="123456" className="font-mono tracking-widest" autoComplete="one-time-code" />
                  <Button variant={action === 'disable' ? 'destructive' : 'default'} onClick={confirmAction} disabled={!code.trim() || busy}>Confirm</Button>
                  <Button variant="ghost" onClick={() => { setAction(null); reset() }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(['recovery', 'move', 'disable'] as Action[]).map((a) => (
                  <Button key={a} size="sm" variant="outline" className={a === 'disable' ? 'text-destructive' : ''} onClick={() => { setAction(a); reset() }}>{ACTION_LABEL[a]}</Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <span className="flex-1 text-sm">Off — your sign-in link is the only thing protecting this account.</span>
            <Button size="sm" onClick={() => begin()} disabled={busy}><KeyRound className="mr-1 h-3.5 w-3.5" />Set up two-factor</Button>
          </CardContent>
        </Card>
      )}
    </section>
  )
}

// ── Settings → Governance ───────────────────────────────────────────────────────
export function TwoFactorPolicyCard({ me }: { me: Member }) {
  const [p, setP] = useState<TwoFactorPolicy | null>(null)
  const [saved, setSaved] = useState<TwoFactorPolicy | null>(null)
  const [adoption, setAdoption] = useState<{ enabled: number; members: number }>()
  const [msg, setMsg] = useState<string>()
  useEffect(() => {
    api.twoFactorPolicy().then((r) => {
      if (r.error) return
      const pol = { nagOnLogin: r.nagOnLogin, nagEveryDays: r.nagEveryDays }
      setP(pol); setSaved(pol); setAdoption(r.adoption)
    }).catch(() => {})
  }, [])
  if (me.role !== 'owner' && me.role !== 'admin') return null
  if (!p) return null
  const dirty = JSON.stringify(p) !== JSON.stringify(saved)
  const save = async () => {
    const r = await api.saveTwoFactorPolicy(p)
    if (r.error) return setMsg(r.error)
    const pol = { nagOnLogin: r.nagOnLogin, nagEveryDays: r.nagEveryDays }
    setP(pol); setSaved(pol); setMsg('Saved'); setTimeout(() => setMsg(undefined), 2000)
  }
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">Two-factor reminders</p>
          {adoption && <span className="text-xs text-muted-foreground">{adoption.enabled} of {adoption.members} active members have two-factor on</span>}
        </div>
        <p className="text-sm text-muted-foreground">
          Members without two-factor sign-in get a reminder to turn it on. Each member sets it up from their Profile; an owner or admin can
          reset someone who lost their phone from the Team page.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={p.nagOnLogin} onChange={() => setP({ ...p, nagOnLogin: !p.nagOnLogin })} />
          Remind on every new sign-in
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.nagEveryDays > 0} onChange={() => setP({ ...p, nagEveryDays: p.nagEveryDays > 0 ? 0 : 7 })} />
          Remind every
          <Input type="number" min={1} max={365} className="h-7 w-20" disabled={p.nagEveryDays === 0} value={p.nagEveryDays || ''} onChange={(e) => setP({ ...p, nagEveryDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
          days until they do
        </label>
        <p className="text-[11px] text-muted-foreground">Sign-ins last 30 days and renew while someone stays active, so a periodic reminder is what reaches people who never sign out.</p>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={!dirty}>Save</Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
