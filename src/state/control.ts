/**
 * The control plane — the registry of TENANTS a single process serves. This is the ONE store that
 * is NOT per-tenant: it lives in its own SQLite DB at `<home>/control/control.db`, separate from
 * every tenant's `agent-os.db`, and simply lists which workspaces exist. The TenantRegistry reads
 * it at boot to build one full runtime per tenant; superadmin provisioning writes to it.
 *
 * A tenant's `slug` becomes its subdomain (`<slug>.<baseDomain>`), so slugs are DNS-label-safe.
 */
import { randomBytes } from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';

export interface TenantRecord {
  slug: string;
  displayName: string;
  ownerEmail: string;
  status: 'active' | 'suspended';
  createdAt: number;
}

interface TenantRow {
  slug: string;
  display_name: string;
  owner_email: string;
  status: 'active' | 'suspended';
  created_at: number;
}

/** Reserved subdomains that can never be a tenant slug (they route to the control plane / assets). */
const RESERVED = new Set(['www', 'admin', 'api', 'app', 'control', 'localhost', 'static', 'assets']);
/** A DNS label: 1–63 chars, lowercase alnum + internal hyphens. Becomes a subdomain. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeSlug(raw: string): string {
  return String(raw || '').trim().toLowerCase();
}

/** Validate a candidate slug. Returns an error string, or null if OK. */
export function validateSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return 'slug must be a DNS label: lowercase letters, digits, hyphens (1–63 chars)';
  if (RESERVED.has(slug)) return `slug "${slug}" is reserved`;
  return null;
}

export class TenantStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        slug         TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        owner_email  TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   INTEGER NOT NULL
      );
    `);
  }

  list(): TenantRecord[] {
    return this.db.prepare('SELECT * FROM tenants ORDER BY created_at').all<TenantRow>().map(toRecord);
  }
  get(slug: string): TenantRecord | undefined {
    const r = this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get<TenantRow>(normalizeSlug(slug));
    return r ? toRecord(r) : undefined;
  }

  /**
   * Create a tenant. Throws on an invalid/reserved/duplicate slug. `skipValidation` is for the seed
   * default tenant whose slug comes from config (it may legitimately be a reserved-ish word).
   */
  create(input: { slug: string; ownerEmail: string; displayName?: string; skipValidation?: boolean }): TenantRecord {
    const slug = normalizeSlug(input.slug);
    if (!input.skipValidation) {
      const err = validateSlug(slug);
      if (err) throw new Error(err);
    }
    if (this.get(slug)) throw new Error(`tenant "${slug}" already exists`);
    const rec: TenantRecord = {
      slug,
      displayName: input.displayName?.trim() || slug,
      ownerEmail: input.ownerEmail.trim().toLowerCase(),
      status: 'active',
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO tenants (slug, display_name, owner_email, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(rec.slug, rec.displayName, rec.ownerEmail, rec.status, rec.createdAt);
    return rec;
  }

  remove(slug: string): boolean {
    const r = this.db.prepare('DELETE FROM tenants WHERE slug = ?').run(normalizeSlug(slug));
    return r.changes > 0;
  }
}

function toRecord(r: TenantRow): TenantRecord {
  return { slug: r.slug, displayName: r.display_name, ownerEmail: r.owner_email, status: r.status, createdAt: r.created_at };
}

/** A short opaque id helper (kept here so callers don't reach for crypto directly). */
export function randomId(prefix = ''): string {
  return prefix + randomBytes(8).toString('hex');
}
