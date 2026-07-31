/**
 * Validate a Claude Code subscription OAuth token (from `claude setup-token`, `sk-ant-oat01-…`) and read
 * its remaining usage — the add-time / Refresh check for the runtime-account pool (see `RuntimeAccountStore`).
 *
 * We hit the SAME endpoint Claude Code's own status line uses — `GET /api/oauth/usage` on api.anthropic.com,
 * with the token as a Bearer, the `oauth-2025-04-20` beta header, and a `claude-code/…` User-Agent (without
 * that UA the endpoint drops you into an aggressively rate-limited bucket → persistent 429). The call is
 * read-only and does NOT consume usage quota.
 *
 * Status code IS the validation, and there are THREE meaningful outcomes (all verified against live tokens):
 *   • 200 → valid AND the token carries the `user:profile` scope → body has the weekly/session usage numbers.
 *     This is what an interactive `claude login` credential (the `oauth` credential-dir kind) yields.
 *   • 403 `permission_error` (scope `user:profile`) → the token is VALID and authenticated, it just lacks the
 *     profile scope the usage endpoint needs. This is what `claude setup-token` mints (it can run inference
 *     but not read usage) — so the fleet's paste-token accounts land here: valid, but no usage readout.
 *   • 401 → invalid / revoked / expired — the definitively-bad case we must reject before it enters the pool.
 * A 429 or anything else is "couldn't verify" — add anyway and badge it; never wedge on a transient blip.
 *
 * Consistency with the runtime: this token exists solely to run `claude` (the launcher injects it as
 * CLAUDE_CODE_OAUTH_TOKEN), and this probe mirrors what Claude Code itself does — so validating here is in
 * the same lane as the actual use, not a side-channel. Endpoint is undocumented/reverse-engineered — never
 * let a check throw into a request handler.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { RuntimeUsage, RuntimeUsageWindow } from '../state/runtime-accounts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
// The endpoint 429s hard without a claude-code UA prefix; the exact version isn't validated, only the prefix.
const CLAUDE_CODE_UA = 'claude-code/2.1.0';

export interface RuntimeCheckResult {
  /** true = authenticated (usable), false = rejected (401, definitively bad), null = couldn't verify. */
  ok: boolean | null;
  /** Short human-readable status for the console badge / the reject message. */
  note: string;
  usage?: RuntimeUsage;
  /** When usage shows a window fully consumed, the epoch ms it resets — caller parks the account limited. */
  limitedUntil?: number;
}

const toWindow = (o: unknown): RuntimeUsageWindow | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const util = (o as { utilization?: unknown }).utilization;
  const resets = (o as { resets_at?: unknown }).resets_at;
  if (typeof util !== 'number') return undefined;
  const resetsAt = typeof resets === 'string' ? Date.parse(resets) : NaN;
  return { usedPct: Math.round(util), resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
};

const parseUsage = (body: unknown): RuntimeUsage => ({
  session: toWindow((body as { five_hour?: unknown })?.five_hour),
  weekly: toWindow((body as { seven_day?: unknown })?.seven_day),
});

/** A window counts as exhausted at ≥100% utilization; return the soonest reset among any exhausted window. */
const exhaustedUntil = (u: RuntimeUsage): number | undefined => {
  const hits: number[] = [];
  for (const w of [u.weekly, u.session]) {
    if (w && (w.usedPct ?? 0) >= 100 && w.resetsAt) hits.push(w.resetsAt);
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
 *  (the `oauth` account kind). These login tokens carry the `user:profile` scope, so — unlike a paste-token —
 *  they DO return usage. Returns undefined when the dir/file/shape isn't present. */
export function readConfigDirToken(dir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
    return j?.claudeAiOauth?.accessToken ?? j?.accessToken ?? undefined;
  } catch { return undefined; }
}

/** Probe a Claude OAuth token. Never throws — a network/timeout/parse problem returns `ok:null`. */
export async function checkClaudeToken(token: string, timeoutMs = 8000): Promise<RuntimeCheckResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(USAGE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA, 'user-agent': CLAUDE_CODE_UA },
      signal: ctrl.signal,
    });
    if (r.status === 401) return { ok: false, note: 'rejected (401) — not a valid Claude subscription token; re-run `claude setup-token` and paste the full sk-ant-oat01-… value' };
    if (r.status === 403) {
      // Authenticated but scope-limited: valid token, no usage readout. `setup-token` accounts live here.
      const body = await r.text().catch(() => '');
      const scoped = /permission_error|scope/i.test(body);
      return { ok: scoped ? true : null, note: scoped ? 'valid · usage n/a (setup-token lacks the user:profile scope)' : `could not verify (HTTP 403)` };
    }
    if (r.status === 429) return { ok: null, note: 'could not verify (rate-limited) — added without a usage check; try Refresh in a few minutes' };
    if (!r.ok) return { ok: null, note: `could not verify (HTTP ${r.status})` };
    const body = await r.json().catch(() => null);
    const usage = parseUsage(body);
    return { ok: true, note: describe(usage), usage, limitedUntil: exhaustedUntil(usage) };
  } catch (e) {
    const why = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network error';
    return { ok: null, note: `could not verify (${why}) — added without a usage check` };
  } finally {
    clearTimeout(timer);
  }
}
