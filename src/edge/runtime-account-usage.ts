/**
 * LAZY USAGE REFRESH for the runtime-account pool.
 *
 * The pool's LIMIT state already self-heals: `RuntimeAccountStore.recover()` runs inside
 * `list()`/`get()`/`pick()`, so a parked account un-parks itself the moment its reset time passes. The
 * USAGE SNAPSHOT (`wk 96%` / `5h 35%`) did not: it was written only at add-time and by the console's
 * manual Refresh button, so the numbers on the Runtime accounts table were a frozen reading from whenever
 * a human last clicked — and an account that hit its wall in a run the teardown detector missed (or under
 * a different process) kept showing a comfortable percentage.
 *
 * This module closes that gap from two directions. Whoever READS the pool (the owner-only
 * `GET /api/runtime-accounts`) kicks a background probe of every enabled Claude account whose snapshot is
 * older than {@link USAGE_STALE_MS}, and the response says which accounts are refreshing so the console can
 * re-read once they land. The probe is one 1-token Haiku call per account (see `runtime-account-check.ts`)
 * and in-flight probes are de-duped, so the cost is bounded by the staleness window, not by how often the
 * page is polled.
 *
 * ⚠ The read path ALONE was not enough, because it is driven by a human opening Settings. On a box nobody
 * is watching, the snapshot simply froze: `last_checked_at` sat days old while the pool kept dispatching to
 * an account that had already hit its wall. So `Automations.tick` ALSO calls {@link refreshStaleUsage},
 * with the longer {@link BACKGROUND_USAGE_STALE_MS} window — the pool now learns an account is spent from a
 * cheap probe instead of from a dropped customer ticket.
 *
 * Deliberately NOT done here: re-enabling a DISABLED account. `enabled = 0` means either a human removed it
 * from rotation or a live 401 auto-disabled it; a background probe silently putting either back into
 * rotation is a surprise. The manual Refresh button remains the way to revive one.
 */
import type { AgentOS } from '../kernel';
import { RuntimeAccount } from '../state/runtime-accounts';
import { checkClaudeToken, readConfigDirToken, RuntimeCheckResult } from './runtime-account-check';

/** A snapshot older than this is re-probed on the next read. Long enough that opening Settings twice in a
 *  row costs nothing, short enough that the number on screen is about the current quota window. */
export const USAGE_STALE_MS = 10 * 60_000;
/**
 * The same, for the BACKGROUND sweep on the scheduler tick (see {@link refreshStaleUsage}'s caller in
 * `Automations.tick`). Longer than the read-path window because nobody is looking at a screen: this only
 * has to be short relative to how fast an account can burn through its quota unnoticed.
 *
 * 30 minutes, from the live failure it exists to prevent: on 2026-08-23 the `vikasprogrammer` account went
 * from 58% to 100% of its weekly window across an evening (~4 runs at $7–13 each). Between the read-path
 * refresh — which only fires when a human opens Settings → Runtime accounts — and the teardown limit
 * detector, which the pane is too volatile to make reliable (it caught 3 of 31 real quota deaths; see
 * `TerminalManager.detectUsageLimit`), a spent account kept advertising a comfortable percentage and
 * `pick()` kept handing it live work. On the instawp tenant that silently dropped ~20% of inbound support
 * tickets over three days, each one discovered only by burning a real customer ticket on it.
 */
export const BACKGROUND_USAGE_STALE_MS = 30 * 60_000;
/** Most accounts probed per sweep — a bound on the cost of one page load, not a pool size limit. The rest
 *  are picked up by the next read (they stay stale, so nothing is skipped permanently). */
export const MAX_PER_SWEEP = 8;

/** The probe used to read an account's usage — injectable so the sweep is testable without network. */
export type UsageProbe = (token: string, configDir?: string) => Promise<RuntimeCheckResult>;

/** In-flight probes across every tenant, keyed `<tenant>:<runtime>/<name>`. Module-level on purpose: the
 *  same account must not be probed twice concurrently no matter which request kicked it. */
const inflight = new Set<string>();

const keyOf = (tenant: string, a: RuntimeAccount) => `${tenant}:${a.runtime}/${a.name}`;

/** Which accounts want a fresh usage reading. Claude-only (it is the only runtime with a usage probe),
 *  enabled-only, and never an `apikey` account (usage-billed — it has no subscription window to report). */
export function staleUsageAccounts(accounts: RuntimeAccount[], now = Date.now(), staleMs = USAGE_STALE_MS): RuntimeAccount[] {
  return accounts.filter((a) => a.runtime === 'claude-code' && a.enabled && a.kind !== 'apikey'
    && (a.lastCheckedAt == null || now - a.lastCheckedAt >= staleMs));
}

/** The OAuth token to probe an account with: the vaulted setup-token for a `token` account, the live login
 *  token inside the credential dir for an `oauth` one. Undefined when neither is readable (a moved dir, a
 *  vault sealed under a rotated master key) — the caller just skips it, exactly like the manual Refresh.  */
export function accountProbeToken(os: AgentOS, a: RuntimeAccount): string | undefined {
  try {
    if (a.kind === 'token') return a.apiKeyRef ? os.secrets.getSync(os.tenant, '*', a.apiKeyRef) ?? undefined : undefined;
    if (a.kind === 'oauth') return a.configDir ? readConfigDirToken(a.configDir) : undefined;
  } catch { /* an unreadable credential is a skip, never a throw into a request handler */ }
  return undefined;
}

/** Apply one probe result to an account: refresh the health + usage snapshot, then reconcile the limit the
 *  same way the manual Refresh does — an exhausted window parks it, a clean authentication clears a stale
 *  limit (`recordCheck` only touches the snapshot, so without this a healthy probe updates the % and leaves
 *  "limited · resets …" frozen). Audited only when something actually CHANGED, so a sweep that finds
 *  everything healthy writes no audit noise every ten minutes. */
export function applyUsageCheck(os: AgentOS, a: RuntimeAccount, check: RuntimeCheckResult): boolean {
  os.runtimeAccounts.recordCheck(a.runtime, a.name, { ok: check.ok, note: check.note, usage: check.usage });
  if (check.limitedUntil) os.runtimeAccounts.markLimited(a.runtime, a.name, check.limitedUntil);
  else if (check.ok === true) os.runtimeAccounts.clearLimit(a.runtime, a.name);
  const after = os.runtimeAccounts.get(a.runtime, a.name);
  const changed = !!after && (after.status !== a.status || after.checkOk !== a.checkOk);
  if (changed) {
    os.audit.append({
      ts: Date.now(), runId: '-', tenant: os.tenant, principal: 'system', type: 'runtime.account.checked',
      data: { runtime: a.runtime, name: a.name, ok: check.ok, note: check.note, auto: true, status: after!.status },
    });
  }
  return changed;
}

/**
 * Kick a background refresh of every stale account and return the names currently being refreshed
 * (`<runtime>/<name>`) — the ones this call started PLUS any already in flight, so a caller polling while a
 * probe runs keeps being told to re-read. Never throws and never blocks the caller: `done` is exposed for
 * tests, the request path ignores it.
 */
export function refreshStaleUsage(
  os: AgentOS,
  opts: { now?: number; staleMs?: number; probe?: UsageProbe; max?: number } = {},
): { refreshing: string[]; done: Promise<void> } {
  const now = opts.now ?? Date.now();
  // `configDir` rides along so a 401 on an expired-but-refreshable access token is classified as
  // "refreshes on next run" instead of "dead credential" (see configDirCanRefresh).
  const probe = opts.probe ?? ((t: string, dir?: string) => checkClaudeToken(t, undefined, { configDir: dir }));
  let stale: RuntimeAccount[] = [];
  try { stale = staleUsageAccounts(os.runtimeAccounts.list(now), now, opts.staleMs); } catch { return { refreshing: [], done: Promise.resolve() }; }

  const already = stale.filter((a) => inflight.has(keyOf(os.tenant, a)));
  const todo = stale.filter((a) => !inflight.has(keyOf(os.tenant, a)))
    .map((a) => ({ a, token: accountProbeToken(os, a) }))
    .filter((x): x is { a: RuntimeAccount; token: string } => !!x.token)
    .slice(0, opts.max ?? MAX_PER_SWEEP);
  for (const { a } of todo) inflight.add(keyOf(os.tenant, a));

  // Sequential: a pool is a handful of accounts and the probes are not latency-critical, so one at a time
  // keeps us far away from the provider's own rate limiter (a burst of probes is exactly what would earn a
  // 429 on the account we are trying to measure).
  const done = (async () => {
    for (const { a, token } of todo) {
      try {
        const check = await probe(token, a.configDir);
        applyUsageCheck(os, a, check);
      } catch { /* a probe failure leaves the previous snapshot; the next read retries */ }
      finally { inflight.delete(keyOf(os.tenant, a)); }
    }
  })();

  return { refreshing: [...already, ...todo.map((x) => x.a)].map((a) => `${a.runtime}/${a.name}`), done };
}
