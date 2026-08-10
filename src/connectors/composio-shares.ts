/**
 * Composio connection sharing — "is this app available to the team, or just me?"
 *
 * A Composio connected account lives under a `user_id` (a member's email for a personal app, the
 * service entity for a company one) and that owner is IMMUTABLE — Composio has no transfer API, and a
 * Tool Router session may only pin accounts belonging to its own `user_id`. So "make my Gmail
 * available to the team" cannot be a move; it has to be a marker Agentric enforces at mint time.
 *
 * That's this table. Marking a connection shared records `(connection id, toolkit, owning entity)`.
 * At launch `TerminalManager` mints ONE extra Tool Router session per sharing owner, under that
 * owner's `user_id` but **allowlisted to the shared toolkits and pinned to the shared connection ids**
 * — so a borrower reaches exactly the apps their teammate shared and none of the rest of that
 * teammate's Composio account. Connection management is disabled on those borrowed sessions, so a
 * borrower can't add or revoke connections under someone else's entity either.
 *
 * Unsharing deletes the row; the next session mints without it. Nothing on composio.dev changes in
 * either direction, so sharing is reversible and needs no re-authorisation.
 */
import { Db } from '../state/db';

/** One connection its owner has marked available to the whole team. */
export interface ComposioShare {
  /** The Composio connected-account id (`ca_…`) — the thing that gets pinned into a borrowed session. */
  id: string;
  /** Toolkit slug (gmail, linkedin, …) — the allowlist entry that goes with the pin. */
  toolkit: string;
  /** The Composio entity that owns the account (the owner's email). Sessions mint under THIS id. */
  userId: string;
  /** Our member id for that owner — so removing the member prunes their shares. */
  ownerMemberId: string;
  /** The connection's distinguishing handle/alias at share time, for display without a live fetch. */
  name: string;
  /** Email of whoever flipped the switch (the owner, or an admin unsharing). */
  sharedBy: string;
  createdAt: number;
}

interface ShareRow {
  id: string;
  toolkit: string;
  user_id: string;
  owner_member_id: string;
  name: string;
  shared_by: string;
  created_at: number;
}

function toShare(r: ShareRow): ComposioShare {
  return {
    id: r.id,
    toolkit: r.toolkit,
    userId: r.user_id,
    ownerMemberId: r.owner_member_id,
    name: r.name || '',
    sharedBy: r.shared_by,
    createdAt: r.created_at,
  };
}

/** What one borrowed Tool Router session needs: whose entity to mint under, and what to expose from it. */
export interface SharedMint {
  /** The owning member's id — used to name the MCP server entry and to skip the owner's own session. */
  ownerMemberId: string;
  /** The Composio entity to mint under (the owner's email). */
  userId: string;
  /** Toolkit allowlist — every shared toolkit of this owner. */
  toolkits: string[];
  /** Per-toolkit connected-account pins, so only the SHARED accounts are reachable. */
  connectedAccounts: Record<string, string[]>;
}

export class ComposioShareStore {
  constructor(private readonly db: Db) {}

  list(): ComposioShare[] {
    return this.db
      .prepare('SELECT * FROM composio_shares ORDER BY created_at')
      .all<ShareRow>()
      .map(toShare);
  }

  /** The shared connection ids belonging to one Composio entity (used to flag a member's own rows). */
  sharedIdsFor(userId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT id FROM composio_shares WHERE user_id = ?')
      .all<{ id: string }>(userId);
    return new Set(rows.map((r) => r.id));
  }

  get(id: string): ComposioShare | undefined {
    const r = this.db.prepare('SELECT * FROM composio_shares WHERE id = ?').get<ShareRow>(id);
    return r ? toShare(r) : undefined;
  }

  /** Mark a connection available to the team. Idempotent — re-sharing refreshes the display fields. */
  share(s: Omit<ComposioShare, 'createdAt'>): ComposioShare {
    const existing = this.get(s.id);
    this.db
      .prepare(
        `INSERT INTO composio_shares (id, toolkit, user_id, owner_member_id, name, shared_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET toolkit = excluded.toolkit, user_id = excluded.user_id,
           owner_member_id = excluded.owner_member_id, name = excluded.name, shared_by = excluded.shared_by`,
      )
      .run(s.id, s.toolkit, s.userId, s.ownerMemberId, s.name, s.sharedBy, existing?.createdAt ?? Date.now());
    return this.get(s.id)!;
  }

  /** Back to "just me". Returns whether a share existed. */
  unshare(id: string): boolean {
    return this.db.prepare('DELETE FROM composio_shares WHERE id = ?').run(id).changes > 0;
  }

  /** Drop this entity's shares whose connection no longer exists on Composio (revoked outside the
   *  console) — otherwise every launch would keep trying to pin a dead account id. */
  pruneEntity(userId: string, liveIds: Set<string>): string[] {
    const gone = this.list().filter((s) => s.userId === userId && !liveIds.has(s.id)).map((s) => s.id);
    for (const id of gone) this.unshare(id);
    return gone;
  }

  /** A removed member's shares go with them — their credentials must not outlive the account. */
  removeByOwner(memberId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM composio_shares WHERE owner_member_id = ?')
      .all<{ id: string }>(memberId);
    this.db.prepare('DELETE FROM composio_shares WHERE owner_member_id = ?').run(memberId);
    return rows.map((r) => r.id);
  }

  /**
   * The borrowed sessions to mint for a run acting as `actingMemberId` — one per OTHER member who has
   * shared something. The acting member is skipped: they already get an unrestricted session under
   * their own entity, so re-minting a pinned subset of it would only narrow what they can already
   * reach. An automation/system spawn (no acting member) borrows from everyone, exactly like a
   * `personal + shared` MCP connector: the owner opted in explicitly.
   */
  mintsFor(actingMemberId?: string): SharedMint[] {
    const byOwner = new Map<string, SharedMint>();
    for (const s of this.list()) {
      if (s.ownerMemberId === actingMemberId) continue;
      let m = byOwner.get(s.ownerMemberId);
      if (!m) {
        m = { ownerMemberId: s.ownerMemberId, userId: s.userId, toolkits: [], connectedAccounts: {} };
        byOwner.set(s.ownerMemberId, m);
      }
      if (!m.toolkits.includes(s.toolkit)) m.toolkits.push(s.toolkit);
      (m.connectedAccounts[s.toolkit] ??= []).push(s.id);
    }
    return [...byOwner.values()];
  }
}
