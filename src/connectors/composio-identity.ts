/**
 * Which real account is behind a Composio connection — and what to do when one expires.
 *
 * Composio's `user_id` is a SCOPE, not an identity. `service:<tenant>` means "the company's shelf" and
 * an email means "that member's shelf"; neither says which third-party account was actually OAuth'd
 * onto it. Nothing in the connected-accounts API closes that gap either — `data.id_token` and every
 * other credential field come back as the literal string `REDACTED`, so the account cannot be read from
 * the connection record. The result was a real incident: a company Google Sheets connection turned out
 * to be one team member's personal Google account, so an agent acting "as the company" created a
 * spreadsheet owned by a person who had no idea, while the console showed only `googlesheets_seba-artal`.
 *
 * The Tool Router does disclose it. `COMPOSIO_MANAGE_CONNECTIONS`, called with a toolkit list, returns
 * `results[toolkit].current_user_info` — `{ email, … }` for Google, the account object for Stripe, and
 * so on. That is what this module reads, caches in `composio_identities`, and hands to the console and
 * to every agent's prompt.
 *
 * THE TRAP, and the reason `resolveIdentities` takes an explicit toolkit list: for a toolkit with NO
 * active connection, `COMPOSIO_MANAGE_CONNECTIONS` does not report "none" — it INITIATES one and returns
 * an OAuth link. Probing blindly would litter the account with half-finished connections. So the caller
 * must pass only toolkits it has already seen an ACTIVE account for (`activeToolkits` below does this
 * from a `listConnectedAccounts` result, and is the only supported way to build the list).
 */
import { Db } from '../state/db';
import { COMPOSIO_KEY_HEADER, mintToolRouterSessionAsync, type ComposioConnection } from './composio';

/** One cached answer to "what is this connection, really?" */
export interface ComposioIdentity {
  /** The Composio connected-account id (`ca_…`). */
  id: string;
  /** The entity it sits under — the SCOPE (company service entity, or a member's email). */
  userId: string;
  toolkit: string;
  /** The real account behind it: an email where the provider gives one, else a login / account name. */
  account: string;
  /** Status as of `checkedAt` (`ACTIVE`, `EXPIRED`, …). */
  status: string;
  checkedAt: number;
  /** When a human was last told this one had expired — so the card is posted once, not every launch. */
  notifiedAt?: number;
}

interface Row {
  id: string;
  user_id: string;
  toolkit: string;
  account: string;
  status: string;
  checked_at: number;
  notified_at: number | null;
}

const toIdentity = (r: Row): ComposioIdentity => ({
  id: r.id,
  userId: r.user_id,
  toolkit: r.toolkit,
  account: r.account || '',
  status: r.status || '',
  checkedAt: r.checked_at,
  ...(r.notified_at ? { notifiedAt: r.notified_at } : {}),
});

/**
 * Pull a human-readable account out of whatever `current_user_info` a provider returns. Google gives
 * `{ email }`, Stripe a whole account object, GitHub-likes a `login`. Falls back through the plausible
 * fields and returns '' when none is present — an empty label is honest, a guessed one is not.
 */
export function accountLabel(info: unknown): string {
  if (!info || typeof info !== 'object') return '';
  const o = info as Record<string, unknown>;
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  const profile = o.business_profile && typeof o.business_profile === 'object'
    ? (o.business_profile as Record<string, unknown>)
    : undefined;
  const profileName = profile && typeof profile.name === 'string' ? profile.name.trim() : '';
  return pick('email') || pick('login') || pick('username') || pick('user_name') || pick('handle')
    || pick('name') || profileName || pick('id');
}

/** The toolkits of an entity that have at least one ACTIVE account — the ONLY safe probe list (see the
 *  module note: probing a toolkit with no active connection creates one). */
export function activeToolkits(accounts: ComposioConnection[]): string[] {
  return [...new Set(accounts.filter((a) => a.status.toUpperCase() === 'ACTIVE').map((a) => a.toolkit))]
    .filter((t) => t && t !== '?');
}

/** What one probe learned: the connection the Tool Router says is live for a toolkit, and whose it is. */
export interface ResolvedIdentity {
  connectionId: string;
  toolkit: string;
  account: string;
}

/**
 * Ask the Tool Router who each of `toolkits` is connected as, under `userId`. Returns [] on any failure
 * — an unresolved label degrades to "we don't know yet", never to a wrong one. `toolkits` MUST come from
 * {@link activeToolkits}; passing a toolkit with no active connection makes Composio initiate one.
 */
export async function resolveIdentities(
  apiKey: string,
  userId: string,
  toolkits: string[],
): Promise<ResolvedIdentity[]> {
  if (!apiKey || !userId || !toolkits.length) return [];
  const minted = await mintToolRouterSessionAsync(apiKey, userId, { toolkits });
  if ('error' in minted) return [];
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [COMPOSIO_KEY_HEADER]: apiKey,
    };
    let sid: string | undefined;
    const rpc = async (body: unknown): Promise<any> => {
      const r = await fetch(minted.url, {
        method: 'POST',
        headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      const got = r.headers.get('mcp-session-id');
      if (got) sid = got;
      const text = await r.text();
      const line = text.split('\n').map((l) => l.replace(/^data:\s*/, '').trim()).filter((l) => l.startsWith('{')).pop();
      return line ? JSON.parse(line) : null;
    };
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-os', version: '1' } } });
    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits } } });
    const content: string = (call?.result?.content || []).map((c: any) => c.text || '').join('\n');
    return parseIdentityResults(content);
  } catch {
    return [];
  }
}

/** Parse the `COMPOSIO_MANAGE_CONNECTIONS` payload into per-toolkit identities. Split out from the
 *  transport so it can be tested without a live Composio account. A toolkit that came back `initiated`
 *  carries no `connected_account_id` and is skipped — there is no account to label. */
export function parseIdentityResults(content: string): ResolvedIdentity[] {
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return []; }
  const results = parsed?.data?.results;
  if (!results || typeof results !== 'object') return [];
  const out: ResolvedIdentity[] = [];
  for (const [toolkit, entry] of Object.entries(results) as [string, any][]) {
    const connectionId = String(entry?.connected_account_id ?? '');
    if (!connectionId) continue;
    out.push({ connectionId, toolkit, account: accountLabel(entry?.current_user_info) });
  }
  return out;
}

export class ComposioIdentityStore {
  constructor(private readonly db: Db) {}

  /** Every cached identity for one entity. */
  forEntity(userId: string): ComposioIdentity[] {
    return this.db
      .prepare('SELECT * FROM composio_identities WHERE user_id = ? ORDER BY toolkit')
      .all<Row>(userId)
      .map(toIdentity);
  }

  /** Cached identities for several entities at once, keyed by connection id — what a prompt or a
   *  console list needs in one read. */
  byConnection(userIds: string[]): Map<string, ComposioIdentity> {
    const out = new Map<string, ComposioIdentity>();
    for (const u of new Set(userIds)) for (const i of this.forEntity(u)) out.set(i.id, i);
    return out;
  }

  /** Record what a live listing + probe found. `account` is only overwritten when we actually learned
   *  one, so a failed probe never blanks a label we already had. */
  upsert(rows: Array<{ id: string; userId: string; toolkit: string; account?: string; status: string }>): void {
    const now = Date.now();
    for (const r of rows) {
      if (!r.id) continue;
      this.db
        .prepare(
          `INSERT INTO composio_identities (id, user_id, toolkit, account, status, checked_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             user_id = excluded.user_id,
             toolkit = excluded.toolkit,
             account = CASE WHEN excluded.account <> '' THEN excluded.account ELSE composio_identities.account END,
             status = excluded.status,
             checked_at = excluded.checked_at`,
        )
        .run(r.id, r.userId, r.toolkit, r.account ?? '', r.status, now);
    }
  }

  /** Forget connections that no longer exist on Composio for this entity (revoked or pruned), so a dead
   *  id can't keep appearing in a prompt. */
  pruneEntity(userId: string, liveIds: Set<string>): number {
    const gone = this.forEntity(userId).filter((i) => !liveIds.has(i.id));
    for (const g of gone) this.db.prepare('DELETE FROM composio_identities WHERE id = ?').run(g.id);
    return gone.length;
  }

  /** Mark that a human has now been told about these expired connections. */
  markNotified(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) this.db.prepare('UPDATE composio_identities SET notified_at = ? WHERE id = ?').run(now, id);
  }

  /** Expired connections nobody has been told about yet (or not for `quietMs`). */
  unnotifiedExpired(userId: string, quietMs: number): ComposioIdentity[] {
    const cutoff = Date.now() - quietMs;
    return this.forEntity(userId).filter(
      (i) => i.status.toUpperCase() === 'EXPIRED' && (i.notifiedAt === undefined || i.notifiedAt < cutoff),
    );
  }
}

/**
 * The expired connections that are SUPERSEDED — an expired account for an (entity, toolkit) that also
 * has a live one. These are the genuine garbage of an ageing Composio account: reconnecting leaves the
 * old row behind, so they pile up while meaning nothing. Everything else that is expired is a to-do
 * (someone has to reauthorise it), which is why deletion is deliberately limited to this set: a
 * "delete everything expired" sweep would quietly erase the only record that a capability is missing.
 *
 * `minAgeMs` keeps a just-superseded row around long enough that a reconnect gone wrong is still visible.
 */
export function supersededExpired(
  accounts: ComposioConnection[],
  minAgeMs: number,
  now: number = Date.now(),
): ComposioConnection[] {
  const liveToolkits = new Set(
    accounts.filter((a) => a.status.toUpperCase() === 'ACTIVE').map((a) => `${a.userId}\0${a.toolkit}`),
  );
  return accounts.filter((a) => {
    if (a.status.toUpperCase() !== 'EXPIRED') return false;
    if (!liveToolkits.has(`${a.userId}\0${a.toolkit}`)) return false;
    const created = Date.parse(a.createdAt || '');
    // An unparseable date is treated as old enough: erring the other way would make the sweep silently
    // do nothing on a provider that formats its timestamps differently.
    return !Number.isFinite(created) || now - created >= minAgeMs;
  });
}
