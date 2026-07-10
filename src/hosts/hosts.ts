/**
 * Host connections — the "Host" shape of the access model (docs/host-connections-plan.md).
 *
 * A Host connection names a reachable destination an agent may talk to — an SSH box, an internal HTTP
 * service, a database — as a first-class, governed thing instead of opaque Bash text. This file is
 * **Phase 2a**: the store + data model only. The governance that reads these rows (host-extraction in
 * the enricher, the `net.connect`/`ssh.exec` reclassification, the allow-list check) is Phase 2b, and
 * credential injection at launch is Phase 2c — neither is wired yet, so a host here is inert data.
 *
 * Deliberately mirrors ConnectorStore: same org/personal/shared ownership model, same console-listing
 * filter, same redaction-before-the-browser posture. See src/connectors/connectors.ts.
 */
import { Db } from '../state/db';

export type HostScope = 'org' | 'personal';
export type HostProtocol = 'ssh' | 'http' | 'postgres' | 'any';
/** The default governance tier for reaching this host (Phase 2b turns these into policy outcomes). */
export type HostPosture = 'allow' | 'ask' | 'never';

export interface Host {
  id: string;
  name: string;
  /** Destination matcher: a hostname glob (`*.internal.example.com`), CIDR (`10.0.0.0/8`), or exact
   *  `host[:port]`. Stored in the DB column `pattern` (`match` is a SQLite keyword). */
  match: string;
  protocol: HostProtocol;
  /** A vault reference (`secret:KEY`) to an SSH key / password, injected at launch in Phase 2c. '' if none. */
  credential: string;
  posture: HostPosture;
  enabled: boolean;
  scope: HostScope;
  ownerMemberId?: string;
  shared: boolean;
  createdAt: number;
}

export interface AddHostInput {
  name: string;
  match: string;
  protocol?: HostProtocol;
  credential?: string;
  posture?: HostPosture;
  scope?: HostScope;
  ownerMemberId?: string;
}

interface HostRow {
  id: string;
  name: string;
  pattern: string;
  protocol: string;
  credential: string;
  posture: string;
  enabled: number;
  scope: string | null;
  owner_member_id: string | null;
  shared: number | null;
  created_at: number;
}

const PROTOCOLS: HostProtocol[] = ['ssh', 'http', 'postgres', 'any'];
const POSTURES: HostPosture[] = ['allow', 'ask', 'never'];
const asProtocol = (v: unknown): HostProtocol => (PROTOCOLS as string[]).includes(v as string) ? (v as HostProtocol) : 'any';
const asPosture = (v: unknown): HostPosture => (POSTURES as string[]).includes(v as string) ? (v as HostPosture) : 'ask';

function toHost(r: HostRow): Host {
  return {
    id: r.id,
    name: r.name,
    match: r.pattern,
    protocol: asProtocol(r.protocol),
    credential: r.credential || '',
    posture: asPosture(r.posture),
    enabled: !!r.enabled,
    scope: r.scope === 'personal' ? 'personal' : 'org',
    ownerMemberId: r.owner_member_id ?? undefined,
    shared: !!r.shared,
    createdAt: r.created_at,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

/** Strip a raw credential VALUE before sending to the browser: a `secret:KEY` vault reference is a
 *  safe pointer (kept), but a pasted raw value is masked. Mirrors connectors' `redact`. */
export function redactHost(h: Host): Host {
  const credential = h.credential.startsWith('secret:') ? h.credential : h.credential ? '••••' : '';
  return { ...h, credential };
}

export class HostStore {
  constructor(private readonly db: Db) {}

  list(): Host[] {
    return this.db.prepare('SELECT * FROM hosts ORDER BY created_at').all<HostRow>().map(toHost);
  }

  get(id: string): Host | undefined {
    const r = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get<HostRow>(id);
    return r ? toHost(r) : undefined;
  }

  add(input: AddHostInput): Host {
    const name = (input.name || '').trim();
    const match = (input.match || '').trim();
    if (!name) throw new Error('a name is required');
    if (!match) throw new Error('a host match (hostname, CIDR, or host:port) is required');

    // Ownership: personal hosts must name their owner; org hosts never carry one. Same as connectors.
    const scope: HostScope = input.scope === 'personal' ? 'personal' : 'org';
    if (scope === 'personal' && !input.ownerMemberId) throw new Error('a personal host requires an owner');
    const ownerMemberId = scope === 'personal' ? input.ownerMemberId : undefined;

    const existing = new Set(this.db.prepare('SELECT id FROM hosts').all<{ id: string }>().map((r) => r.id));
    const base = slug(name);
    let id = base;
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;

    const host: Host = {
      id,
      name,
      match,
      protocol: asProtocol(input.protocol),
      credential: (input.credential || '').trim(),
      posture: asPosture(input.posture),
      enabled: true,
      scope,
      ownerMemberId,
      shared: false,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO hosts (id, name, pattern, protocol, credential, posture, enabled, scope, owner_member_id, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(host.id, host.name, host.match, host.protocol, host.credential, host.posture, 1, host.scope, host.ownerMemberId ?? null, 0, host.createdAt);
    return host;
  }

  /** Edit the mutable fields of a host in place (name/match/protocol/credential/posture). Scope and
   *  ownership are immutable — recreate to move a host between org and personal. */
  update(id: string, patch: Partial<Pick<Host, 'name' | 'match' | 'protocol' | 'credential' | 'posture'>>): Host | undefined {
    const h = this.get(id);
    if (!h) return undefined;
    const name = patch.name !== undefined ? patch.name.trim() : h.name;
    const match = patch.match !== undefined ? patch.match.trim() : h.match;
    const protocol = patch.protocol !== undefined ? asProtocol(patch.protocol) : h.protocol;
    const posture = patch.posture !== undefined ? asPosture(patch.posture) : h.posture;
    const credential = patch.credential !== undefined ? patch.credential.trim() : h.credential;
    if (!name) throw new Error('a name is required');
    if (!match) throw new Error('a host match is required');
    this.db
      .prepare('UPDATE hosts SET name = ?, pattern = ?, protocol = ?, credential = ?, posture = ? WHERE id = ?')
      .run(name, match, protocol, credential, posture, id);
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): Host | undefined {
    const res = this.db.prepare('UPDATE hosts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return res.changes ? this.get(id) : undefined;
  }

  /** Share (or un-share) a PERSONAL host with the whole team. No-op (undefined) for org hosts. */
  setShared(id: string, shared: boolean): Host | undefined {
    const h = this.get(id);
    if (!h || h.scope !== 'personal') return undefined;
    this.db.prepare('UPDATE hosts SET shared = ? WHERE id = ?').run(shared ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM hosts WHERE id = ?').run(id).changes > 0;
  }

  /** Delete a member's PERSONAL hosts (their own stored credentials) when the member is removed, so
   *  their secrets don't outlive the account. Org hosts are untouched. Returns the removed ids. */
  removeByOwner(memberId: string): string[] {
    const rows = this.db.prepare("SELECT id FROM hosts WHERE scope = 'personal' AND owner_member_id = ?").all(memberId) as Array<{ id: string }>;
    this.db.prepare("DELETE FROM hosts WHERE scope = 'personal' AND owner_member_id = ?").run(memberId);
    return rows.map((r) => r.id);
  }

  /** What the viewer may see: every org host + shared personal + their own personal. Mirrors
   *  ConnectorStore.listForConsole. */
  listForConsole(viewerId: string, isAdmin: boolean): Host[] {
    return this.list().filter((h) => h.scope !== 'personal' || h.shared || isAdmin || h.ownerMemberId === viewerId);
  }

  /**
   * The ENABLED host grants that apply to a session running as `memberId` — org hosts (everyone) +
   * shared personal + that member's own personal. Mirrors ConnectorStore.boundTo. Reduced to the
   * matcher shape the enricher's host-fact computation needs (Phase 2b). Undefined member (system/
   * automation spawn) sees org + shared only.
   */
  grantsFor(memberId?: string): { match: string; protocol: HostProtocol; posture: HostPosture }[] {
    return this.list()
      .filter((h) => h.enabled)
      .filter((h) => h.scope !== 'personal' || h.shared || (!!memberId && h.ownerMemberId === memberId))
      .map((h) => ({ match: h.match, protocol: h.protocol, posture: h.posture }));
  }

  /**
   * Enabled, credential-bearing SSH hosts bound to `memberId` — the input to Phase 2c key injection.
   * Same binding as grantsFor, narrowed to hosts that (a) carry a credential and (b) speak ssh (or any).
   * Returns the RAW credential (a `secret:KEY` ref, resolved by the caller against the vault). Same
   * ownership binding as grantsFor.
   */
  sshCredsFor(memberId?: string): { id: string; name: string; match: string; credential: string }[] {
    return this.list()
      .filter((h) => h.enabled && h.credential && (h.protocol === 'ssh' || h.protocol === 'any'))
      .filter((h) => h.scope !== 'personal' || h.shared || (!!memberId && h.ownerMemberId === memberId))
      .map((h) => ({ id: h.id, name: h.name, match: h.match, credential: h.credential }));
  }
}
