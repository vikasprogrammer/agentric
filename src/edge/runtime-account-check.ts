/**
 * Validate a Claude Code subscription OAuth token (from `claude setup-token`, `sk-ant-oat01-…`) and read
 * its remaining usage — the add-time / Refresh check for the runtime-account pool (see `RuntimeAccountStore`).
 *
 * WHY NOT `/api/oauth/usage`: that dedicated endpoint needs the `user:profile` scope, which a
 * `claude setup-token` (the paste-token the fleet uses) does NOT carry — it 403s. So it only works for an
 * interactive `claude login` credential and is useless for the fleet's tokens.
 *
 * WHAT WORKS FOR SETUP-TOKENS: a minimal `POST /v1/messages` call (cheapest model, 1 token, "hi"). Claude
 * returns the subscription usage as `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset,status}` response
 * HEADERS, which ride on ANY inference call — so they're readable with just the `user:inference` scope every
 * subscription token has. (Approach cross-checked against the community "Claude Usage Tracker" and verified
 * live against our own setup-tokens.) `utilization` is a 0.0–1.0 fraction; `reset` is a unix-seconds epoch;
 * `status` is `allowed`/`rejected`. The headers are present even on a 429 (at-limit) response — exactly when
 * you most want them — so we parse those too.
 *
 * Outcomes: 401 → invalid/revoked/expired (reject before it enters the pool). 200/429-with-headers → valid,
 * with usage. Anything else → "couldn't verify" (add anyway, badge it) — never wedge on a transient blip.
 *
 * Cost: one 1-token inference per check (add + manual Refresh only — infrequent), a fraction of a cent.
 * Consistency: this token exists solely to run `claude`, and a 1-token probe mirrors Claude Code's own
 * startup call — same lane as the actual use, not a side-channel. Never let a check throw into a handler.
 */
import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { RuntimeUsage, RuntimeUsageWindow } from '../state/runtime-accounts';
import { CodingRuntimeId, CODING_RUNTIMES } from '../types';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const OAUTH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';
// A claude-code UA keeps us out of the aggressively-throttled bucket; only the prefix matters.
const CLAUDE_CODE_UA = 'claude-code/2.1.5';
// Cheapest model — we only want the rate-limit headers, so max_tokens:1 keeps the call ~free.
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

export interface RuntimeCheckResult {
  /** true = authenticated (usable), false = rejected (401, definitively bad), null = couldn't verify. */
  ok: boolean | null;
  /** Short human-readable status for the console badge / the reject message. */
  note: string;
  usage?: RuntimeUsage;
  /** When a usage window is fully consumed / rejected, the epoch ms it resets — caller parks it limited. */
  limitedUntil?: number;
}

/** One usage window from the `anthropic-ratelimit-unified-<w>-*` headers (`5h` = session, `7d` = weekly).
 *  `utilization` is a 0.0–1.0 fraction → 0–100%; `reset` is unix seconds → epoch ms. */
const headerWindow = (headers: Headers, w: '5h' | '7d'): RuntimeUsageWindow | undefined => {
  const util = headers.get(`anthropic-ratelimit-unified-${w}-utilization`);
  if (util == null) return undefined;
  const frac = Number.parseFloat(util);
  const resetSec = Number.parseInt(headers.get(`anthropic-ratelimit-unified-${w}-reset`) ?? '', 10);
  return {
    usedPct: Number.isFinite(frac) ? Math.round(frac * 100) : undefined,
    resetsAt: Number.isFinite(resetSec) ? resetSec * 1000 : undefined,
  };
};

const parseUsage = (headers: Headers): RuntimeUsage | undefined => {
  const session = headerWindow(headers, '5h');
  const weekly = headerWindow(headers, '7d');
  return session || weekly ? { session, weekly } : undefined;
};

/** A window is exhausted when its `-status` header is `rejected` or utilization ≥100%; return the soonest
 *  reset among exhausted windows so the caller can park the account limited until then. */
const exhaustedUntil = (headers: Headers, u: RuntimeUsage): number | undefined => {
  const hits: number[] = [];
  for (const [w, win] of [['5h', u.session], ['7d', u.weekly]] as const) {
    if (!win) continue;
    const rejected = headers.get(`anthropic-ratelimit-unified-${w}-status`) === 'rejected';
    if ((rejected || (win.usedPct ?? 0) >= 100) && win.resetsAt) hits.push(win.resetsAt);
  }
  return hits.length ? Math.min(...hits) : undefined;
};

const describe = (u: RuntimeUsage): string => {
  const parts: string[] = [];
  if (u.weekly?.usedPct != null) parts.push(`weekly ${u.weekly.usedPct}%`);
  if (u.session?.usedPct != null) parts.push(`session ${u.session.usedPct}%`);
  return parts.length ? `valid · ${parts.join(' · ')} used` : 'valid';
};

/**
 * Where claude actually keeps a credential dir's login on macOS.
 *
 * On Linux it writes `<dir>/.credentials.json`. On macOS it writes the **login Keychain** instead —
 * one generic-password item per config dir, named `Claude Code-credentials-<first 8 hex of
 * sha256(configDir)>` (the bare `Claude Code-credentials` is the default `~/.claude` login). That is
 * why the pool still rotates correctly on a Mac — each account's dir maps to its own Keychain item —
 * and why every "is this dir logged in?" check that only stats a file answers **no** on macOS for a dir
 * that is perfectly signed in. That mismatch stranded the guided login: the sign-in succeeded, the pane
 * said "Logged in as …", and the poll waited out its grace for a file the platform never writes.
 *
 * The VALUE is readable too — see {@link readKeychainCredentials}. We long believed it wasn't, because
 * `security find-generic-password -w` exits **36** and 36 was read as "the item's ACL only trusts claude".
 * It isn't an ACL refusal: 36 is `errSecInteractionRequired`, which is what EVERY keychain read gets from a
 * **Background** security session — an ssh shell, a LaunchDaemon — where the login keychain is still locked.
 * The same command in the **Aqua** session (`launchctl managername` = `Aqua`, which is where a LaunchAgent
 * like `com.agentos.<tenant>` runs) returns the credential JSON with exit 0. So the pool's usage probe works
 * on a Mac after all, and the "signed in via the Keychain, can't be probed from here" badge was describing
 * the developer's ssh session, not the server's.
 *
 * ⚠ The same 36 is what `claude` itself gets, and it treats it as "not logged in". So a credential dir that
 * is perfectly signed in reports `Not logged in · Please run /login` from an ssh shell and authenticates
 * normally from the server — worth knowing before concluding a pooled account is dead.
 *
 * ⚠⚠ And it does NOT fall back to the plaintext `.credentials.json` here. Claude Code's credential store
 * classifies keychain failures, and the locked/interaction-not-allowed family is TRANSIENT: its own
 * `primary_transient_skip_fallback` path skips the plaintext file rather than reading (or writing) it. A
 * locked login keychain is therefore a hard stop for every claude run on the box — see
 * {@link credentialReadiness}, which exists because presence and readability are different questions.
 */
export function keychainServiceFor(dir: string): string {
  // The BOX DEFAULT login (`~/.claude`, i.e. no CLAUDE_CONFIG_DIR) is stored under the bare service name —
  // only a non-default config dir gets the path-hash suffix. Without this case a readiness probe of the
  // default dir looks up a service that cannot exist and reports "no login" for a box that is signed in.
  if (isDefaultClaudeDir(dir)) return 'Claude Code-credentials';
  return `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
}

/** The box's own `claude` config dir — the one a session gets when neither rotation nor config isolation
 *  put a `CLAUDE_CONFIG_DIR` in its environment. */
export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Same directory as {@link defaultClaudeDir}, compared through `realpath` so a symlinked home (macOS
 *  `/var/folders` → `/private/var/…`) doesn't read as a different dir. */
function isDefaultClaudeDir(dir: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  return real(dir) === real(join(homedir(), '.claude'));
}

/** Does the macOS Keychain hold a login for this config dir? Metadata-only lookup — no ACL prompt.
 *  Always false off darwin. */
export function keychainHasLogin(dir: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return spawnSync('security', ['find-generic-password', '-s', keychainServiceFor(dir)], { timeout: 4000, stdio: 'ignore' }).status === 0;
  } catch { return false; }
}

/** Remove a config dir's Keychain login. Called when a login is abandoned or its dir archived: leaving
 *  the item behind means a LATER login into the same path silently inherits the old account, which is the
 *  worst outcome available (a pool row labelled one account, authenticating as another). Best-effort —
 *  deletion can be refused by the item's ACL, so callers must not depend on it. */
export function keychainForget(dir: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return spawnSync('security', ['delete-generic-password', '-s', keychainServiceFor(dir)], { timeout: 4000, stdio: 'ignore' }).status === 0;
  } catch { return false; }
}

/** The stored OAuth credential record, in whichever of the two places `claude` put it — the shape is the
 *  same either way (`{ claudeAiOauth: { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, … } }`).
 *  Undefined when neither source yields one. Never throws: a caller is always inside a request handler. */
export interface StoredCredential {
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number };
  accessToken?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
}

/** Read a config dir's login out of the macOS Keychain (see {@link keychainServiceFor}). Exit 36 —
 *  `errSecInteractionRequired`, i.e. a Background security session with a locked login keychain — is a
 *  plain miss, not an error to surface. `security` prints the secret as text when it is printable and as
 *  hex when it is not, so both are accepted. Always undefined off darwin. */
export function readKeychainCredentials(dir: string): StoredCredential | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const r = spawnSync('security', ['find-generic-password', '-w', '-s', keychainServiceFor(dir)],
      { timeout: 4000, encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return undefined;
    const raw = r.stdout.trim();
    const text = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, 'hex').toString('utf8') : raw;
    return JSON.parse(text) as StoredCredential;
  } catch { return undefined; }
}

/** The credential record for a `claude login` dir: the plaintext `.credentials.json` claude writes on Linux
 *  (and as its macOS fallback), else the macOS Keychain item. File first — when both exist the file is the
 *  one claude's own fallback chain wrote most recently. */
export function readCredentialRecord(dir: string): StoredCredential | undefined {
  try {
    const j = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as StoredCredential;
    if (j) return j;
  } catch { /* no plaintext file — on macOS the login is normally in the Keychain instead */ }
  return readKeychainCredentials(dir);
}

/** Best-effort read of the OAuth access token from a `claude login` credential dir (the `oauth` account
 *  kind). `claude` keeps this token fresh at rest, so a live read is current. Undefined when the dir holds
 *  no readable login — which on macOS also covers "the keychain is locked in this security session". */
export function readConfigDirToken(dir: string): string | undefined {
  const j = readCredentialRecord(dir);
  return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? undefined;
}

/**
 * Can this credential dir REFRESH itself? An `oauth` credential file carries a `refreshToken` alongside the
 * short-lived `accessToken`, and `claude` swaps one for the other on its next launch — so an access token
 * that has merely aged out is a self-healing condition, not a dead account.
 *
 * This exists because the two are indistinguishable at the API: an expired access token 401s exactly like a
 * revoked one. Without this check the probe called a healthy account "not a valid Claude subscription token;
 * re-run `claude setup-token`" — advice that is both wrong and expensive (a full re-auth for a credential
 * that fixes itself on next use). Live case: the `tools` account sat mislabelled for days, which also masked
 * the REAL state underneath (it was simply at its weekly cap).
 *
 * Returns `false` when there is no refresh token, or when the refresh token itself has expired — those are
 * genuinely dead and a human does have to re-auth.
 */
export function configDirCanRefresh(dir: string, now = Date.now()): boolean {
  const j = readCredentialRecord(dir);
  const o = j?.claudeAiOauth ?? j;
  if (!o?.refreshToken) return false;
  const exp = o.refreshTokenExpiresAt;
  return typeof exp === 'number' ? exp > now : true; // no stated expiry → assume usable
}

/** Does this credential DIR actually hold the runtime's login (`.credentials.json` / `auth.json`, per the
 *  runtime's `credentialEnv.configDirFile`)? Runtime-agnostic, unlike {@link readConfigDirToken}, which
 *  parses Claude's file shape. A dir that fails this is not a usable account: pointing a session at it
 *  doesn't fall back to the box login, it drops the CLI into its interactive login picker and the run hangs
 *  there until the reaper — so both the add handler and the launcher refuse it. */
export function credentialDirHasLogin(runtime: CodingRuntimeId, dir: string): boolean {
  try {
    if (existsSync(join(dir, CODING_RUNTIMES[runtime].credentialEnv.configDirFile))) return true;
    // macOS keeps claude's login in the Keychain, not in the dir — see keychainServiceFor.
    return runtime === 'claude-code' && keychainHasLogin(dir);
  } catch { return false; }
}

/**
 * Is a `claude login` credential dir actually USABLE by a session we are about to spawn — not merely
 * "a login exists somewhere for it"?
 *
 * The distinction is the whole point. {@link credentialDirHasLogin} answers presence, and on macOS a
 * Keychain item's PRESENCE is readable (metadata lookup, exit 0) even when its VALUE is not. A locked
 * login keychain therefore passes every existing check and fails at the only moment that matters: inside
 * the spawned `claude`, which reads through the same locked keychain in the same security session.
 *
 * And it does NOT degrade to the plaintext file. Claude Code's credential store classifies keychain
 * errors, and `errSecInteractionNotAllowed` / `errSecAuthFailed` (its `keychain_locked` /
 * `interaction_not_allowed` cases) are TRANSIENT — the store's own `primary_transient_skip_fallback` path
 * skips the plaintext fallback rather than reading or writing it. So a locked keychain is a hard stop for
 * every claude run on the box, pool account and box default alike.
 *
 * Live incident (2026-09-01, instapods): the login keychain auto-locked overnight; the server kept
 * spawning sessions for ~17 hours. Eight runs, every one $0 and one turn, three left `running`, and no
 * alert anywhere — the pool badge still showed the last usage snapshot taken before the lock. Hence a
 * launch-time readiness probe that reads the VALUE, and a caller that refuses rather than fails open.
 */
export type CredentialReadiness =
  | { ok: true; via: 'file' | 'keychain' }
  /** No login in this dir at all — the pre-existing "empty credential dir" case. */
  | { ok: false; reason: 'missing' }
  /** A login EXISTS in the Keychain but its value can't be read from this security session. */
  | { ok: false; reason: 'keychain_locked'; service: string };

export function credentialReadiness(runtime: CodingRuntimeId, dir: string): CredentialReadiness {
  try {
    if (existsSync(join(dir, CODING_RUNTIMES[runtime].credentialEnv.configDirFile))) return { ok: true, via: 'file' };
    // Only claude-code keeps its login in the macOS Keychain; every other runtime is file-only, so an
    // absent file there is simply missing.
    if (runtime !== 'claude-code' || !keychainHasLogin(dir)) return { ok: false, reason: 'missing' };
    return readKeychainCredentials(dir)
      ? { ok: true, via: 'keychain' }
      : { ok: false, reason: 'keychain_locked', service: keychainServiceFor(dir) };
  } catch { return { ok: false, reason: 'missing' }; }
}

/** The credential dir a launch's environment will actually authenticate through: whatever rotation or
 *  config isolation put in the runtime's config-dir var, else the box default. Null when the environment
 *  carries a direct key/token instead (an `apikey`/`token` pool account), which needs no dir at all. */
export function launchCredentialDir(runtime: CodingRuntimeId, env: Record<string, string>): string | null {
  const { configDirVar, apiKeyVar, tokenVar } = CODING_RUNTIMES[runtime].credentialEnv;
  if ((apiKeyVar && env[apiKeyVar]) || (tokenVar && env[tokenVar])) return null;
  return env[configDirVar] || (runtime === 'claude-code' ? defaultClaudeDir() : null);
}

/**
 * Launch pre-flight: can this environment authenticate at all? Returns the blocking condition, or null
 * when the launch may proceed.
 *
 * Deliberately narrow — it refuses ONLY on `keychain_locked`, the state that is both certain (we just
 * failed the same read the child will make) and undiagnosable from the outside (a $0 one-turn run).
 * A `missing` dir keeps its long-standing fail-open behaviour: rotation already declines to select such an
 * account, and a box with no login at all fails visibly at the CLI's own login picker.
 */
export function preflightCredential(runtime: CodingRuntimeId, env: Record<string, string>):
  { dir: string; service: string } | null {
  const dir = launchCredentialDir(runtime, env);
  if (!dir) return null;
  const state = credentialReadiness(runtime, dir);
  return state.ok || state.reason !== 'keychain_locked' ? null : { dir, service: state.service };
}

/** Probe a Claude subscription OAuth token via a 1-token Messages call and read the usage headers. Never
 *  throws — a network/timeout/parse problem returns `ok:null`. Works for setup-tokens AND login tokens. */
export async function checkClaudeToken(token: string, timeoutMs = 12000, opts: { configDir?: string } = {}): Promise<RuntimeCheckResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': CLAUDE_CODE_UA,
        'anthropic-beta': OAUTH_BETA,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: ctrl.signal,
    });
    if (r.status === 401) {
      // An EXPIRED access token 401s identically to a revoked one. When the credential dir still holds a
      // live refreshToken, `claude` swaps it for a new access token on its next launch — so this account is
      // fine and must not be branded dead (see {@link configDirCanRefresh}). `ok: null` = couldn't verify:
      // the caller keeps the previous health, leaves the account enabled, and retries on the next sweep,
      // by which time a launch has usually refreshed it.
      if (opts.configDir && configDirCanRefresh(opts.configDir)) {
        return { ok: null, note: 'access token expired — refreshes automatically on this account\'s next run' };
      }
      return { ok: false, note: 'rejected (401) — not a valid Claude subscription token; re-run `claude setup-token` and paste the full sk-ant-oat01-… value' };
    }
    // Usage headers are present on 200 AND on a 429 (at-limit) — parse whenever we can, since an at-limit
    // account is exactly one we want to record + park. A 403/5xx/other with no headers is "couldn't verify".
    const usage = parseUsage(r.headers);
    if (r.status === 200 || (r.status === 429 && usage)) {
      return { ok: true, note: usage ? describe(usage) : (r.status === 429 ? 'valid · at rate limit' : 'valid'), usage, limitedUntil: usage ? exhaustedUntil(r.headers, usage) : undefined };
    }
    if (r.status === 429) return { ok: null, note: 'could not verify (rate-limited) — try Refresh shortly' };
    return { ok: null, note: `could not verify (HTTP ${r.status})` };
  } catch (e) {
    const why = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network error';
    return { ok: null, note: `could not verify (${why}) — added without a usage check` };
  } finally {
    clearTimeout(timer);
  }
}
