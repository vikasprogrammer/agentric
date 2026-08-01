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
import { readFileSync } from 'fs';
import { join } from 'path';
import { RuntimeUsage, RuntimeUsageWindow } from '../state/runtime-accounts';

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

/** Best-effort read of the OAuth access token from a `claude login` credential dir's `.credentials.json`
 *  (the `oauth` account kind). `claude` keeps this token fresh on disk, so a live read is current.
 *  Returns undefined when the dir/file/shape isn't present. */
export function readConfigDirToken(dir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
    return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? undefined;
  } catch { return undefined; }
}

/** Probe a Claude subscription OAuth token via a 1-token Messages call and read the usage headers. Never
 *  throws — a network/timeout/parse problem returns `ok:null`. Works for setup-tokens AND login tokens. */
export async function checkClaudeToken(token: string, timeoutMs = 12000): Promise<RuntimeCheckResult> {
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
    if (r.status === 401) return { ok: false, note: 'rejected (401) — not a valid Claude subscription token; re-run `claude setup-token` and paste the full sk-ant-oat01-… value' };
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
