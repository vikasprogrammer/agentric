/**
 * The runtime account POOL — launch-time credential rotation, generic across coding runtimes.
 *
 * A box authenticates each runtime's CLI with ONE credential set: `claude` via a Max-subscription OAuth
 * token in `~/.claude/.credentials.json`, `codex` via `~/.codex/auth.json`. A subscription plan has a
 * WEEKLY usage cap; when it's exhausted every spawned session gets a "you've hit your limit" refusal, does
 * no work, and hangs (no completed turn → the reaper only clears it on the ceiling). During a limit window
 * every cron tick spawns another zombie.
 *
 * This store lets an operator register MORE than one account PER RUNTIME. At launch the selector hands out
 * an available account for that runtime, exported via the runtime's own credential env vars
 * (`CodingRuntimeSpec.credentialEnv` — `CLAUDE_CONFIG_DIR`/`ANTHROPIC_API_KEY` for claude,
 * `AOS_REAL_CODEX_HOME`/`OPENAI_API_KEY` for codex) — but ONLY for the kinds that runtime's launch lane
 * genuinely authenticates with (`CodingRuntimeSpec.liveCredentialKinds`; for claude-code, credential dirs
 * only — its TUI ignores an injected `CLAUDE_CODE_OAUTH_TOKEN`). When one is detected as limited it's parked until its
 * reset and the next launch rotates to another of the SAME runtime; only when every account for that
 * runtime is limited does the scheduler defer. A future runtime slots in with zero changes here — it just
 * declares its two env vars in the spec.
 *
 * INERT BY DEFAULT: with no accounts for a runtime `pick()` returns null and the launcher sets no
 * credential env, so the CLI uses the box's default single account — exactly today's behavior.
 * Per-workspace DB = the tenant boundary (no tenant column, like HostStore / AutoApprovalStore).
 */
import { Db } from './db';
import { CodingRuntimeId, CODING_RUNTIMES, RuntimeAccountKind } from '../types';

export type { RuntimeAccountKind };

/** The kinds a runtime can ACTUALLY be launched with (see `CodingRuntimeSpec.liveCredentialKinds`). Every
 *  selection path funnels through this, so a kind the launch lane can't honour is unselectable by
 *  construction rather than by each caller remembering to filter. */
const liveKinds = (runtime: CodingRuntimeId): RuntimeAccountKind[] =>
  [...(CODING_RUNTIMES[runtime]?.liveCredentialKinds ?? ['oauth'])];

/** A single usage window (subscription session = ~5h, weekly = 7d) as reported by the runtime provider.
 *  `usedPct` is 0..100 of the window consumed; `resetsAt` is when it rolls over. Either may be absent when
 *  the provider doesn't surface it — the UI renders what's present. */
export interface RuntimeUsageWindow {
  usedPct?: number;
  resetsAt?: number;
}
/** A cached usage snapshot for an account, shown per-key in the console. Provider-agnostic: the validator
 *  maps whatever the runtime exposes onto these two windows. */
export interface RuntimeUsage {
  weekly?: RuntimeUsageWindow;
  session?: RuntimeUsageWindow;
}

export interface RuntimeAccount {
  /** The coding runtime this account authenticates (claude-code | codex | …). */
  runtime: CodingRuntimeId;
  /** Operator-chosen label, unique per runtime (composite PK with `runtime`). */
  name: string;
  /** 'oauth' → a credential DIRECTORY (configDir); 'apikey' → a usage-billed key held in the vault;
   *  'token' → a long-lived OAuth token held in the vault, exported via the runtime's `tokenVar`
   *  (the `claude setup-token` path). Only kinds in the runtime's `liveCredentialKinds` are ever
   *  SELECTED — for claude-code that is 'oauth' alone, because its interactive TUI ignores an injected
   *  token. A row of any other kind stays in the table (visible + badged) but is never launched with. */
  kind: RuntimeAccountKind;
  /** kind=oauth: dir exported via the runtime's `configDirVar` (holds .credentials.json / auth.json). */
  configDir?: string;
  /** kind=apikey|token: the secrets-vault key whose value is exported via the runtime's `apiKeyVar`/`tokenVar`. */
  apiKeyRef?: string;
  enabled: boolean;
  status: 'available' | 'limited';
  /** epoch ms the usage limit resets (parsed from the limit message); cleared when it lapses. */
  limitedUntil?: number;
  lastUsedAt?: number;
  createdAt: number;
  /** Health cache from the last validation call (add-time / Refresh / teardown). */
  lastCheckedAt?: number;
  /** Did the last validation authenticate? undefined = never checked. */
  checkOk?: boolean;
  /** Human-readable status of the last check / reason an account was auto-disabled. */
  checkNote?: string;
  /** Last usage snapshot (weekly/session), when the provider reports it. */
  usage?: RuntimeUsage;
}

interface Row {
  runtime: string;
  name: string;
  kind: string;
  config_dir: string | null;
  api_key_ref: string | null;
  enabled: number;
  status: string;
  limited_until: number | null;
  last_used_at: number | null;
  created_at: number;
  last_checked_at: number | null;
  check_ok: number | null;
  check_note: string | null;
  usage_json: string | null;
}

const parseUsage = (raw: string | null): RuntimeUsage | undefined => {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as RuntimeUsage; } catch { return undefined; }
};

const toAccount = (r: Row): RuntimeAccount => ({
  runtime: r.runtime as CodingRuntimeId,
  name: r.name,
  kind: r.kind === 'apikey' ? 'apikey' : r.kind === 'token' ? 'token' : 'oauth',
  configDir: r.config_dir ?? undefined,
  apiKeyRef: r.api_key_ref ?? undefined,
  enabled: r.enabled === 1,
  status: r.status === 'limited' ? 'limited' : 'available',
  limitedUntil: r.limited_until ?? undefined,
  lastUsedAt: r.last_used_at ?? undefined,
  createdAt: r.created_at,
  lastCheckedAt: r.last_checked_at ?? undefined,
  checkOk: r.check_ok == null ? undefined : r.check_ok === 1,
  checkNote: r.check_note ?? undefined,
  usage: parseUsage(r.usage_json),
});

export class RuntimeAccountStore {
  constructor(private db: Db) {}

  /** Every account across all runtimes, newest first — never exposes the api-key VALUE (only its vault ref). */
  list(): RuntimeAccount[] {
    return this.db.prepare('SELECT * FROM runtime_accounts ORDER BY runtime, created_at DESC').all<Row>().map(toAccount);
  }

  get(runtime: CodingRuntimeId, name: string): RuntimeAccount | null {
    const r = this.db.prepare('SELECT * FROM runtime_accounts WHERE runtime = ? AND name = ?').get<Row>(runtime, name);
    return r ? toAccount(r) : null;
  }

  /** Number of ENABLED accounts for a runtime — the "is rotation active?" flag the launcher gates on
   *  (0 → inert, use the box default). Counts only kinds this runtime can actually launch with unless
   *  `anyKind` is set; the raw count is what tells "you configured a pool, but none of it is usable"
   *  apart from "no pool at all". */
  enabledCount(runtime: CodingRuntimeId, opts?: { anyKind?: boolean }): number {
    const kinds = liveKinds(runtime);
    const sql = opts?.anyKind
      ? 'SELECT COUNT(*) AS n FROM runtime_accounts WHERE runtime = ? AND enabled = 1'
      : `SELECT COUNT(*) AS n FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND kind IN (${kinds.map(() => '?').join(',')})`;
    const r = this.db.prepare(sql).get<{ n: number }>(runtime, ...(opts?.anyKind ? [] : kinds));
    return r?.n ?? 0;
  }

  add(a: { runtime: CodingRuntimeId; name: string; kind: RuntimeAccountKind; configDir?: string; apiKeyRef?: string }): RuntimeAccount {
    const name = a.name.trim();
    if (!name) throw new Error('account name required');
    if (a.kind === 'oauth' && !a.configDir) throw new Error('oauth account needs a configDir');
    if (a.kind !== 'oauth' && !a.apiKeyRef) throw new Error(`${a.kind} account needs a vault ref`);
    this.db.prepare(`INSERT INTO runtime_accounts (runtime, name, kind, config_dir, api_key_ref, enabled, status, created_at)
                     VALUES (?, ?, ?, ?, ?, 1, 'available', ?)`)
      .run(a.runtime, name, a.kind, a.configDir ?? null, a.apiKeyRef ?? null, Date.now());
    return this.get(a.runtime, name)!;
  }

  remove(runtime: CodingRuntimeId, name: string): void {
    this.db.prepare('DELETE FROM runtime_accounts WHERE runtime = ? AND name = ?').run(runtime, name);
  }

  setEnabled(runtime: CodingRuntimeId, name: string, enabled: boolean): void {
    this.db.prepare('UPDATE runtime_accounts SET enabled = ? WHERE runtime = ? AND name = ?').run(enabled ? 1 : 0, runtime, name);
  }

  /** Clear the 'limited' flag on any account whose reset time has passed (or has no reset time recorded),
   *  across all runtimes. Called at the top of pick()/allLimited() so an expired limit self-heals. */
  private recover(now: number): void {
    this.db.prepare("UPDATE runtime_accounts SET status = 'available', limited_until = NULL WHERE status = 'limited' AND (limited_until IS NULL OR limited_until <= ?)")
      .run(now);
  }

  /** Park an account as limited until `until` (epoch ms), keeping the FARTHEST reset if called repeatedly.
   *  `until` unknown → parked with no reset time, which recover() clears on the next pass (so a mis-detected
   *  limit can't wedge an account forever). */
  markLimited(runtime: CodingRuntimeId, name: string, until: number | null): void {
    this.db.prepare(`UPDATE runtime_accounts
                     SET status = 'limited', limited_until = CASE WHEN ? IS NULL THEN limited_until
                       WHEN limited_until IS NULL THEN ? ELSE MAX(limited_until, ?) END
                     WHERE runtime = ? AND name = ?`)
      .run(until, until, until, runtime, name);
  }

  /** Cache the outcome of a validation call (add-time / Refresh) — health + usage snapshot. Doesn't touch
   *  `enabled`/`status`; a usage-derived limit is applied by the caller via {@link markLimited}. `ok=null`
   *  (couldn't verify) leaves the previous check_ok untouched so a transient network blip doesn't clear a
   *  known-good badge — only a definitive true/false overwrites it. */
  recordCheck(runtime: CodingRuntimeId, name: string, r: { ok: boolean | null; note: string; usage?: RuntimeUsage; now?: number }): void {
    const now = r.now ?? Date.now();
    this.db.prepare(`UPDATE runtime_accounts
                     SET last_checked_at = ?, check_note = ?, usage_json = ?,
                         check_ok = CASE WHEN ? IS NULL THEN check_ok ELSE ? END
                     WHERE runtime = ? AND name = ?`)
      .run(now, r.note, r.usage ? JSON.stringify(r.usage) : null, r.ok === null ? null : 1, r.ok ? 1 : 0, runtime, name);
  }

  /** The credential is definitively bad (a live run authenticated with it and got a 401 / "invalid bearer
   *  token", or a Refresh returned 401): DISABLE it — unlike a usage limit it will NOT self-heal at a reset,
   *  so it must drop out of the pool until a human replaces the token. Records why, for the console badge. */
  markInvalid(runtime: CodingRuntimeId, name: string, note: string, now: number = Date.now()): void {
    this.db.prepare("UPDATE runtime_accounts SET enabled = 0, check_ok = 0, check_note = ?, last_checked_at = ? WHERE runtime = ? AND name = ?")
      .run(note, now, runtime, name);
  }

  /** Select the account to launch the next `runtime` session under — least-recently-used among enabled +
   *  available — and stamp its last_used_at. Returns null when there are NO usable accounts for the runtime
   *  (caller → box default) or every enabled one is currently limited (caller → box default for a member
   *  launch; the scheduler defers cron). Auto-recovers accounts whose limit has lapsed first. */
  pick(runtime: CodingRuntimeId, now: number = Date.now(), opts?: { kinds?: RuntimeAccountKind[] }): RuntimeAccount | null {
    this.recover(now);
    // The kind filter is ALWAYS on: a runtime's `liveCredentialKinds` are the only ones its launch lane
    // actually authenticates with (a claude `token` account, e.g., is silently ignored by the interactive
    // TUI — see the spec field). A caller may narrow further (a resident session drops static `token`
    // credentials, which can't refresh in-process and would hit /login mid-chat) but can never widen.
    const kinds = liveKinds(runtime).filter((k) => !opts?.kinds || opts.kinds.includes(k));
    if (!kinds.length) return null;
    const kindClause = ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    const r = this.db.prepare(`SELECT * FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'available'${kindClause} ORDER BY last_used_at IS NOT NULL, last_used_at ASC LIMIT 1`).get<Row>(runtime, ...kinds);
    if (!r) return null;
    this.db.prepare('UPDATE runtime_accounts SET last_used_at = ? WHERE runtime = ? AND name = ?').run(now, runtime, r.name);
    return toAccount({ ...r, last_used_at: now });
  }

  /** Is the whole pool for a runtime exhausted right now — non-empty, and every enabled account limited?
   *  Returns the earliest reset time so the scheduler knows when to resume. `{ limited:false }` when the pool
   *  is empty (rotation inert) or at least one account is available. */
  allLimited(runtime: CodingRuntimeId, now: number = Date.now()): { limited: boolean; until: number | null } {
    this.recover(now);
    // Same kind filter as pick(): an account the launcher can't authenticate with is not "an account the
    // scheduler can fall back on". Without this, one unusable-but-available row would mask an exhausted
    // pool and every deferred run would spawn onto the box default instead.
    const kinds = liveKinds(runtime);
    const inKinds = `kind IN (${kinds.map(() => '?').join(',')})`;
    if (this.enabledCount(runtime) === 0) return { limited: false, until: null };
    const avail = this.db.prepare(`SELECT COUNT(*) AS n FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'available' AND ${inKinds}`).get<{ n: number }>(runtime, ...kinds);
    if ((avail?.n ?? 0) > 0) return { limited: false, until: null };
    const soonest = this.db.prepare(`SELECT MIN(limited_until) AS t FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'limited' AND ${inKinds}`).get<{ t: number | null }>(runtime, ...kinds);
    return { limited: true, until: soonest?.t ?? null };
  }
}
