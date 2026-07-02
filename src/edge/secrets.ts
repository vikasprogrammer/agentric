/**
 * Secrets vault — stores/injects credentials, namespaced by tenant + principal so
 * brands are isolated. This is the VAULT, not the Identity (who acts). Capabilities
 * read secrets inside the gateway boundary; agents never see raw keys.
 *
 * Env lookup order:  <TENANT>__<PRINCIPAL>__<KEY>  →  <TENANT>__<KEY>  →  <KEY>
 * (principal/tenant upper-cased, non-alphanumerics → underscore)
 */
import { SecretsVault } from '../types';
import { Db } from '../state/db';
import { open, seal } from './secret-crypto';

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export class EnvSecretsVault implements SecretsVault {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  /** Synchronous core — env lookup is inherently sync; `get` just wraps it for the async interface. */
  getSync(tenant: string, principal: string, key: string): string | undefined {
    const candidates = [
      `${norm(tenant)}__${norm(principal)}__${norm(key)}`,
      `${norm(tenant)}__${norm(key)}`,
      norm(key),
    ];
    for (const c of candidates) if (this.env[c] !== undefined) return this.env[c];
    return undefined;
  }
  async get(tenant: string, principal: string, key: string): Promise<string | undefined> {
    return this.getSync(tenant, principal, key);
  }
}

/** Metadata about a stored secret — its identity + provenance, NEVER the value. */
export interface SecretMeta {
  principal: string;
  key: string;
  updatedAt: number;
  updatedBy?: string;
}

/**
 * The real vault: credentials encrypted at rest in the workspace DB (`secrets` table) under the
 * workspace master key (see secret-crypto.ts). `get()` resolves in the same widening order as the
 * env vault — principal-specific → tenant-wide (`*`) — then falls through to `fallback` (the env
 * vault), so secrets injected via `<TENANT>__…` env vars keep working alongside stored ones.
 *
 * The blocking decision: a stored value always wins over env when both exist for the exact same
 * (principal, key) — the console-managed secret is the source of truth once set.
 */
export class SqliteSecretsVault implements SecretsVault {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    private readonly fallback?: EnvSecretsVault,
  ) {}

  /**
   * Synchronous resolution — `node:sqlite` and GCM open are both sync, so the real work is sync.
   * The connector-cred launch path (`buildMcpConfigJson`) is synchronous and calls this; `get`
   * just awaits the same logic for the async `SecretsVault` interface.
   */
  getSync(tenant: string, principal: string, key: string): string | undefined {
    for (const p of [principal, '*']) {
      const row = this.db
        .prepare('SELECT value_enc FROM secrets WHERE tenant = ? AND principal = ? AND key = ?')
        .get(tenant, p, key) as { value_enc: string } | undefined;
      if (row) {
        try {
          return open(this.masterKey, row.value_enc);
        } catch {
          // Wrong/rotated master key or a tampered blob: don't silently fall through to a stale
          // env value — surface it as "unset" so the caller fails closed rather than acting on
          // the wrong credential.
          return undefined;
        }
      }
    }
    return this.fallback?.getSync(tenant, principal, key);
  }

  async get(tenant: string, principal: string, key: string): Promise<string | undefined> {
    return this.getSync(tenant, principal, key);
  }

  /** Store (or replace) a secret. `principal` defaults to '*' (tenant-wide). */
  set(tenant: string, key: string, value: string, opts: { principal?: string; updatedBy?: string } = {}): void {
    const principal = opts.principal || '*';
    this.db
      .prepare(
        `INSERT INTO secrets (tenant, principal, key, value_enc, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant, principal, key)
         DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(tenant, principal, key, seal(this.masterKey, value), Date.now(), opts.updatedBy ?? null);
  }

  /** Remove a secret. Returns true if a row was deleted. */
  delete(tenant: string, key: string, principal = '*'): boolean {
    const res = this.db
      .prepare('DELETE FROM secrets WHERE tenant = ? AND principal = ? AND key = ?')
      .run(tenant, principal, key);
    return Number(res.changes) > 0;
  }

  /** List a tenant's secrets — metadata only, never the values. */
  list(tenant: string): SecretMeta[] {
    const rows = this.db
      .prepare(
        'SELECT principal, key, updated_at, updated_by FROM secrets WHERE tenant = ? ORDER BY principal, key',
      )
      .all(tenant) as Array<{ principal: string; key: string; updated_at: number; updated_by: string | null }>;
    return rows.map((r) => ({
      principal: r.principal,
      key: r.key,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by ?? undefined,
    }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vault references — how a connector env/header value points at a vault secret
// instead of storing the plaintext. Resolved to the real value at session launch
// (inside the mediated boundary), so the DB holds only a reference.
// ─────────────────────────────────────────────────────────────────────────────

/** The sentinel prefix marking a value as a vault reference rather than a literal credential. */
export const SECRET_REF_PREFIX = 'secret:';

/** True if a stored connector value is a vault reference (`secret:KEY` / `secret:PRINCIPAL/KEY`). */
export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

/**
 * Parse a reference into `{principal?, key}`:
 *   `secret:STRIPE_KEY`            → { key: 'STRIPE_KEY' }            (principal defaults at resolve time)
 *   `secret:billing-agent/API_KEY` → { principal: 'billing-agent', key: 'API_KEY' }
 * Returns undefined for a non-reference or an empty body.
 */
export function parseSecretRef(value: string): { principal?: string; key: string } | undefined {
  if (!isSecretRef(value)) return undefined;
  const body = value.slice(SECRET_REF_PREFIX.length).trim();
  if (!body) return undefined;
  const slash = body.indexOf('/');
  if (slash === -1) return { key: body };
  const principal = body.slice(0, slash).trim();
  const key = body.slice(slash + 1).trim();
  if (!key) return undefined;
  return { principal: principal || undefined, key };
}
