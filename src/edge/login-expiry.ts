/**
 * Login expiry — warn BEFORE a Claude Code login dies, not after.
 *
 * Every `claude login` credential carries a refresh token with a FIXED lifetime
 * (`claudeAiOauth.refreshTokenExpiresAt`). Using the account does not extend it: on instapods the `tools`
 * account refreshed its access token all day on 2026-10-02 and its refresh expiry stayed at exactly
 * 2026-10-13 13:03 UTC. When that moment passes, the next refresh fails and Claude Code wipes the record
 * down to `expiresAt: 0` — and from then on the launch pre-flight refuses every run that would use it.
 * That is how the expresstech box default died on 2026-10-02 23:14 while running 6–30 sessions a day, and
 * how the instapods `tools2-new` pool account died on 2026-09-26. Both were found by the refusal card,
 * i.e. after runs had already stopped, though the date had been sitting in the credential file all along.
 *
 * So this reads that date for every login a launch can use — the box default and each enabled
 * credential-dir pool account — and raises ONE standing admin card per login as it approaches, re-raised
 * only when it crosses a nearer threshold (7 → 3 → 1 day) so a login that needs renewing is a short series
 * of escalating notices rather than an hourly drip. The once-guard is the `runtime.login.expiring` audit
 * event, so a restart never re-alarms. When someone signs the login in again its expiry jumps forward,
 * the card is closed and `runtime.login.renewed` is recorded.
 *
 * Spawn-free and cheap (a file read, or a Keychain read on macOS): it runs off the scheduler tick,
 * throttled to hourly. Claude Code only — no other runtime's credential states an expiry we can read.
 */
import { createHash } from 'crypto';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import { credentialDirHasLogin, defaultClaudeDir, readCredentialRecord } from './runtime-account-check';

const DAY = 86_400_000;
/** Days-left thresholds, nearest last. A login is carded on entering each band, and never again in it. */
export const LOGIN_EXPIRY_STAGES = [7, 3, 1] as const;

export interface LoginExpiry {
  /** When the login's refresh token stops working, epoch ms. Undefined when the record doesn't say. */
  refreshExpiresAt?: number;
  /** The login is already unusable: no refresh token left, or its stated expiry has passed. */
  dead: boolean;
  /** Claude Code has already wiped the tokens (a failed refresh). */
  wiped: boolean;
}

/** Read a credential dir's login expiry. Undefined when there is no readable login to judge. */
export function loginExpiry(dir: string, now = Date.now()): LoginExpiry | undefined {
  const rec = readCredentialRecord(dir);
  if (!rec) return undefined;
  const o = rec.claudeAiOauth ?? rec;
  const rt = typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt > 0 ? o.refreshTokenExpiresAt : undefined;
  const dead = !o.refreshToken || (rt !== undefined && rt <= now);
  return { refreshExpiresAt: rt, dead, wiped: !o.refreshToken };
}

/** Which band a login is in: the nearest threshold it is inside, 0 once it has lapsed, null when it is
 *  further out than the widest threshold (nothing to say). */
export function expiryStage(refreshExpiresAt: number, now = Date.now()): number | null {
  const daysLeft = (refreshExpiresAt - now) / DAY;
  if (daysLeft <= 0) return 0;
  let stage: number | null = null;
  for (const s of LOGIN_EXPIRY_STAGES) if (daysLeft <= s) stage = s;
  return stage;
}

/** One login a launch on this box can authenticate through. */
interface Login { dir: string; label: string; account?: string }

function loginsToWatch(os: AgentOS): Login[] {
  const out: Login[] = [];
  const box = defaultClaudeDir();
  // The box default is what every launch falls back to — and the ONLY login on a box with no pool.
  if (credentialDirHasLogin('claude-code', box)) out.push({ dir: box, label: `this box's default Claude Code login` });
  for (const a of os.runtimeAccounts.list()) {
    if (a.runtime !== 'claude-code' || a.kind !== 'oauth' || !a.enabled || !a.configDir || a.configDir === box) continue;
    out.push({ dir: a.configDir, label: `runtime account "${a.name}"`, account: a.name });
  }
  return out;
}

const topicFor = (dir: string) => `login-expiry-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`;

/** The stage this login was last carded at, or undefined if it has never been (or was renewed since). */
function lastStage(os: AgentOS, dir: string): number | undefined {
  const row = os.db
    .prepare("SELECT type, data FROM audit_events WHERE tenant = ? AND type IN ('runtime.login.expiring','runtime.login.renewed') AND data LIKE ? ORDER BY ts DESC, id DESC LIMIT 1")
    .get<{ type: string; data: string }>(os.tenant, `%"dir":${JSON.stringify(dir)}%`);
  if (!row || row.type === 'runtime.login.renewed') return undefined;
  try { const s = (JSON.parse(row.data) as { stage?: unknown }).stage; return typeof s === 'number' ? s : undefined; } catch { return undefined; }
}

function when(ms: number, now: number): string {
  const at = new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const hours = Math.round((ms - now) / 3_600_000);
  return hours >= 48 ? `in ${Math.round(hours / 24)} days (${at})` : hours >= 1 ? `in ${hours} hours (${at})` : `at ${at}`;
}

function compose(l: Login, exp: number, stage: number, now: number): { title: string; body: string } {
  const command = `CLAUDE_CONFIG_DIR=${l.dir} claude /login`;
  const where = process.platform === 'darwin'
    ? `Run it from the Mac's own desktop session — an ssh shell cannot read the login Keychain, so claude reports "not logged in" there even when it is.`
    : `It works from an ssh shell on the box.`;
  const consequence = l.account
    ? `Rotation will skip it from then on, so the rest of the pool carries its load — or, if it is the last account standing, every run falls back to the box default.`
    : `Every run that uses it — on a box with no runtime-account pool, that is every run — will be refused until it is signed in again.`;
  const head = l.account ? `Runtime account "${l.account}"` : `This box's Claude Code login`;
  if (stage === 0) {
    return {
      title: `${head} has expired — sign it in again`,
      body: `The login in ${l.dir} reached the end of its refresh token's lifetime ${when(exp, now)} and can no longer renew itself. ${consequence}\n\nSign it in again on the box:\n\n    ${command}\n\n${where}`,
    };
  }
  return {
    title: `${head} expires ${stage === 1 ? 'within a day' : `in ${stage} days or less`} — sign it in again`,
    body: `The login in ${l.dir} stops working ${when(exp, now)}. Claude Code logins have a fixed lifetime — using the account does not extend it — so it has to be signed in again before then. ${consequence}\n\nSign it in again on the box now (the new login replaces the old one in place; nothing else changes):\n\n    ${command}\n\n${where}`,
  };
}

export interface LoginExpiryOutcome { dir: string; account?: string; refreshExpiresAt?: number; stage: number | null; carded: boolean; renewed: boolean }

/** Review every login this tenant's launches can use. Returns what was seen and done (read by the test). */
export function reviewLoginExpiry(os: AgentOS, tm: TerminalManager, now = Date.now()): LoginExpiryOutcome[] {
  const out: LoginExpiryOutcome[] = [];
  for (const l of loginsToWatch(os)) {
    let exp: LoginExpiry | undefined;
    try { exp = loginExpiry(l.dir, now); } catch { continue; }
    // No readable record, or one that states no expiry: nothing honest to say (a wiped record is the
    // launch pre-flight's job — it already refuses and alerts on that).
    if (!exp?.refreshExpiresAt) continue;
    // Already wiped: the launch path owns that state — rotation skips it with its own "signed out" card,
    // or the pre-flight refuses and alerts. A second card here would be the same news twice.
    if (exp.wiped) continue;
    const stage = expiryStage(exp.refreshExpiresAt, now);
    const prev = lastStage(os, l.dir);
    const topic = topicFor(l.dir);
    let carded = false, renewed = false;
    if (stage === null) {
      // Out of the warning window. If we had warned, the login has been renewed since — say so and clear.
      if (prev !== undefined) {
        try { tm.closeSystemCards(topic, 'approved'); } catch { /* advisory */ }
        os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: 'system', type: 'runtime.login.renewed', data: { dir: l.dir, account: l.account ?? null, refreshExpiresAt: exp.refreshExpiresAt } });
        renewed = true;
      }
    } else if (prev === undefined || stage < prev) {
      try {
        const { title, body } = compose(l, exp.refreshExpiresAt, stage, now);
        const id = tm.postSystemCard({
          topic, type: 'notification', title, body,
          audience: { kind: 'admins' },
          args: { dir: l.dir, account: l.account, refreshExpiresAt: exp.refreshExpiresAt, stage },
          link: { page: 'settings', detail: 'runtime', label: 'Settings → Runtime' },
        });
        tm.closeSystemCards(topic, 'cancelled', id);
        carded = true;
      } catch { /* the audit row below is the record */ }
      os.audit.append({ ts: now, runId: '-', tenant: os.tenant, principal: 'system', type: 'runtime.login.expiring', data: { dir: l.dir, account: l.account ?? null, refreshExpiresAt: exp.refreshExpiresAt, stage } });
    }
    out.push({ dir: l.dir, account: l.account, refreshExpiresAt: exp.refreshExpiresAt, stage, carded, renewed });
  }
  return out;
}
