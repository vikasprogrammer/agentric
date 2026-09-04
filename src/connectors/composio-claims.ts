/**
 * Claiming a company Composio connection back as one person's own — the exact inverse of sharing.
 *
 * The two directions exist for the same reason and are enforced the same way. A connected account's
 * owning entity is IMMUTABLE on Composio's side (no transfer API, and a Tool Router session may only pin
 * accounts belonging to its own `user_id`), so neither "lend mine to the team" nor "take this one back
 * out of the company shelf" can be a move. Both are markers Agentric enforces at mint time:
 *
 *   composio-shares.ts   personal account → reachable by everyone   (mint an EXTRA pinned session)
 *   composio-claims.ts   company account  → reachable by one member (mint the company session MINUS it)
 *
 * The case it is for: someone completes the hosted OAuth on the **company** shelf while signed in to
 * their own Google/Slack/whatever account. That happens by accident constantly, and the result is a
 * connection every agent in the tenant can act through, wearing one individual's identity — the exact
 * shape of the incident that started this work, where a company Google Sheets connection turned out to
 * be a specific teammate's personal account and an agent "acting as the company" wrote into their Drive.
 * Disconnecting and reconnecting on the right shelf is the only true fix, but it needs the person to be
 * at a browser and re-authorise; a claim is the instant, reversible one that stops the bleeding.
 *
 * ENFORCEMENT (see `TerminalManager.composioSessionPlan`). A claim narrows the COMPANY session of every
 * run that is not acting as the claimer — including automation and system runs, which have no member and
 * therefore no business acting as one:
 *
 *   - the claimed account is the only ACTIVE one of its toolkit on the shelf → `toolkits.disable`,
 *     because Composio rejects an empty account pin (`Array must contain at least 1 element`);
 *   - other active accounts of that toolkit remain → pin the session to exactly those.
 *
 * Both were verified against the live endpoint: a disabled toolkit is genuinely unreachable, and
 * `COMPOSIO_SEARCH_TOOLS` reports no connection for it rather than silently offering a dead one.
 *
 * Releasing deletes the row and the next session mints without it. Nothing on composio.dev changes in
 * either direction, so a claim needs no re-authorisation and can always be undone.
 */
import { Db } from '../state/db';

/** One company connection that is, in practice, a single person's account. */
export interface ComposioClaim {
  /** The Composio connected-account id (`ca_…`) on the COMPANY entity. */
  id: string;
  /** Toolkit slug (gmail, googlesheets, …) — what gets disabled or re-pinned for everyone else. */
  toolkit: string;
  /** The company service entity the account lives under. Unchanged by the claim; it cannot be moved. */
  userId: string;
  /** The member the account really belongs to — the only person whose runs still reach it. */
  memberId: string;
  /** The account the connection resolves to at claim time, for display without a live fetch. */
  account: string;
  /** Email of the owner/admin who filed the claim. */
  claimedBy: string;
  createdAt: number;
}

interface ClaimRow {
  id: string;
  toolkit: string;
  user_id: string;
  member_id: string;
  account: string;
  claimed_by: string;
  created_at: number;
}

const toClaim = (r: ClaimRow): ComposioClaim => ({
  id: r.id,
  toolkit: r.toolkit,
  userId: r.user_id,
  memberId: r.member_id,
  account: r.account || '',
  claimedBy: r.claimed_by,
  createdAt: r.created_at,
});

/** How to narrow one company session so it excludes the claims that are not the caller's. */
export interface ClaimExclusion {
  /** Toolkits to switch off entirely — every active account of theirs is claimed by someone else. */
  disableToolkits: string[];
  /** Toolkits to pin to their remaining unclaimed accounts. */
  connectedAccounts: Record<string, string[]>;
}

/**
 * Work out how to mint a company session for `actingMemberId` given the claims on the shelf and what is
 * actually ACTIVE on it. Pure — the caller supplies the live/cached account list.
 *
 * `activeByToolkit` maps a toolkit to the ids of its ACTIVE company accounts. A toolkit missing from it
 * is unknown to us, and an unknown toolkit with a claim is DISABLED rather than left open: over-
 * restricting a session is recoverable (the agent reports it cannot reach an app), while under-
 * restricting it silently hands someone else's mailbox to the whole fleet, which is the bug being fixed.
 */
export function exclusionFor(
  claims: ComposioClaim[],
  activeByToolkit: Map<string, string[]>,
  actingMemberId?: string,
): ClaimExclusion {
  const out: ClaimExclusion = { disableToolkits: [], connectedAccounts: {} };
  const foreign = claims.filter((c) => c.memberId !== actingMemberId);
  for (const toolkit of new Set(foreign.map((c) => c.toolkit))) {
    const claimedHere = new Set(foreign.filter((c) => c.toolkit === toolkit).map((c) => c.id));
    const active = activeByToolkit.get(toolkit);
    if (!active) { out.disableToolkits.push(toolkit); continue; }
    const remaining = active.filter((id) => !claimedHere.has(id));
    if (remaining.length) out.connectedAccounts[toolkit] = remaining;
    else out.disableToolkits.push(toolkit);
  }
  return out;
}

export class ComposioClaimStore {
  constructor(private readonly db: Db) {}

  list(): ComposioClaim[] {
    return this.db
      .prepare('SELECT * FROM composio_claims ORDER BY created_at')
      .all<ClaimRow>()
      .map(toClaim);
  }

  get(id: string): ComposioClaim | undefined {
    const r = this.db.prepare('SELECT * FROM composio_claims WHERE id = ?').get<ClaimRow>(id);
    return r ? toClaim(r) : undefined;
  }

  /** Claim a company connection for one member. Idempotent — re-claiming re-points it. */
  claim(c: Omit<ComposioClaim, 'createdAt'>): ComposioClaim {
    const existing = this.get(c.id);
    this.db
      .prepare(
        `INSERT INTO composio_claims (id, toolkit, user_id, member_id, account, claimed_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET toolkit = excluded.toolkit, user_id = excluded.user_id,
           member_id = excluded.member_id, account = excluded.account, claimed_by = excluded.claimed_by`,
      )
      .run(c.id, c.toolkit, c.userId, c.memberId, c.account, c.claimedBy, existing?.createdAt ?? Date.now());
    return this.get(c.id)!;
  }

  /** Back to the whole company. Returns whether a claim existed. */
  release(id: string): boolean {
    return this.db.prepare('DELETE FROM composio_claims WHERE id = ?').run(id).changes > 0;
  }

  /** Drop claims whose connection no longer exists on Composio — otherwise a deleted account would keep
   *  disabling a toolkit for the whole tenant forever, with nothing in the console to explain why. */
  pruneEntity(userId: string, liveIds: Set<string>): string[] {
    const gone = this.list().filter((c) => c.userId === userId && !liveIds.has(c.id)).map((c) => c.id);
    for (const id of gone) this.release(id);
    return gone;
  }

  /** A removed member's claims go back to the company — an account nobody owns must not stay walled off. */
  releaseByMember(memberId: string): string[] {
    const rows = this.db
      .prepare('SELECT id FROM composio_claims WHERE member_id = ?')
      .all<{ id: string }>(memberId);
    this.db.prepare('DELETE FROM composio_claims WHERE member_id = ?').run(memberId);
    return rows.map((r) => r.id);
  }
}
