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
 * `AOS_REAL_CODEX_HOME`/`OPENAI_API_KEY` for codex). When one is detected as limited it's parked until its
 * reset and the next launch rotates to another of the SAME runtime; only when every account for that
 * runtime is limited does the scheduler defer. A future runtime slots in with zero changes here — it just
 * declares its two env vars in the spec.
 *
 * INERT BY DEFAULT: with no accounts for a runtime `pick()` returns null and the launcher sets no
 * credential env, so the CLI uses the box's default single account — exactly today's behavior.
 * Per-workspace DB = the tenant boundary (no tenant column, like HostStore / AutoApprovalStore).
 */
import { Db } from './db';
import { CodingRuntimeId } from '../types';

export type RuntimeAccountKind = 'oauth' | 'apikey';

export interface RuntimeAccount {
  /** The coding runtime this account authenticates (claude-code | codex | …). */
  runtime: CodingRuntimeId;
  /** Operator-chosen label, unique per runtime (composite PK with `runtime`). */
  name: string;
  /** 'oauth' → a credential DIRECTORY (configDir); 'apikey' → a usage-billed key held in the vault. */
  kind: RuntimeAccountKind;
  /** kind=oauth: dir exported via the runtime's `configDirVar` (holds .credentials.json / auth.json). */
  configDir?: string;
  /** kind=apikey: the secrets-vault key whose value is exported via the runtime's `apiKeyVar`. */
  apiKeyRef?: string;
  enabled: boolean;
  status: 'available' | 'limited';
  /** epoch ms the usage limit resets (parsed from the limit message); cleared when it lapses. */
  limitedUntil?: number;
  lastUsedAt?: number;
  createdAt: number;
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
}

const toAccount = (r: Row): RuntimeAccount => ({
  runtime: r.runtime as CodingRuntimeId,
  name: r.name,
  kind: r.kind === 'apikey' ? 'apikey' : 'oauth',
  configDir: r.config_dir ?? undefined,
  apiKeyRef: r.api_key_ref ?? undefined,
  enabled: r.enabled === 1,
  status: r.status === 'limited' ? 'limited' : 'available',
  limitedUntil: r.limited_until ?? undefined,
  lastUsedAt: r.last_used_at ?? undefined,
  createdAt: r.created_at,
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
   *  (0 → inert, use the box default). */
  enabledCount(runtime: CodingRuntimeId): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM runtime_accounts WHERE runtime = ? AND enabled = 1').get<{ n: number }>(runtime);
    return r?.n ?? 0;
  }

  add(a: { runtime: CodingRuntimeId; name: string; kind: RuntimeAccountKind; configDir?: string; apiKeyRef?: string }): RuntimeAccount {
    const name = a.name.trim();
    if (!name) throw new Error('account name required');
    if (a.kind === 'oauth' && !a.configDir) throw new Error('oauth account needs a configDir');
    if (a.kind === 'apikey' && !a.apiKeyRef) throw new Error('apikey account needs an apiKeyRef');
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

  /** Select the account to launch the next `runtime` session under — least-recently-used among enabled +
   *  available — and stamp its last_used_at. Returns null when there are NO accounts for the runtime (caller
   *  → box default) or every enabled one is currently limited (caller → box default for a member launch; the
   *  scheduler defers cron). Auto-recovers accounts whose limit has lapsed first. */
  pick(runtime: CodingRuntimeId, now: number = Date.now()): RuntimeAccount | null {
    this.recover(now);
    const r = this.db.prepare("SELECT * FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'available' ORDER BY last_used_at IS NOT NULL, last_used_at ASC LIMIT 1").get<Row>(runtime);
    if (!r) return null;
    this.db.prepare('UPDATE runtime_accounts SET last_used_at = ? WHERE runtime = ? AND name = ?').run(now, runtime, r.name);
    return toAccount({ ...r, last_used_at: now });
  }

  /** Is the whole pool for a runtime exhausted right now — non-empty, and every enabled account limited?
   *  Returns the earliest reset time so the scheduler knows when to resume. `{ limited:false }` when the pool
   *  is empty (rotation inert) or at least one account is available. */
  allLimited(runtime: CodingRuntimeId, now: number = Date.now()): { limited: boolean; until: number | null } {
    this.recover(now);
    if (this.enabledCount(runtime) === 0) return { limited: false, until: null };
    const avail = this.db.prepare("SELECT COUNT(*) AS n FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'available'").get<{ n: number }>(runtime);
    if ((avail?.n ?? 0) > 0) return { limited: false, until: null };
    const soonest = this.db.prepare("SELECT MIN(limited_until) AS t FROM runtime_accounts WHERE runtime = ? AND enabled = 1 AND status = 'limited'").get<{ t: number | null }>(runtime);
    return { limited: true, until: soonest?.t ?? null };
  }
}
