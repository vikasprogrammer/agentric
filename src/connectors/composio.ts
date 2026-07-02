/**
 * Composio — the one connector whose endpoint is MINTED, not stored.
 *
 * A Slack/GitHub stdio connector has a fixed launch command; a generic remote connector has a fixed
 * URL. Composio's Tool Router is different: the MCP endpoint is a per-user, pre-signed session URL
 * that you create on demand by POSTing the user's id to Composio's API. So the user only ever gives
 * us their Composio API key — at each agent-session launch we exchange it (scoped to the launching
 * member) for a fresh session URL and write THAT into the per-session `.mcp.json`.
 *
 * This module is deliberately Composio-specific (a connector plugin, not core). The blocking
 * `curl` call mirrors `terminal/gate-hook.sh`: it keeps the launch path synchronous — no async
 * ripple through createSession / the server / automations — and adds no runtime dependency.
 */
import { spawnSync } from 'child_process';
import { createHmac, timingSafeEqual } from 'crypto';

/** The connector `type` whose URL is minted at launch rather than stored. */
export const COMPOSIO_TYPE = 'composio';

/** Header the Composio API key is carried in (both on the connector and on the mint request). */
export const COMPOSIO_KEY_HEADER = 'x-api-key';

/** Does this connector type resolve its endpoint dynamically (mint at launch) instead of storing a URL? */
export function mintsUrl(type: string): boolean {
  return type === COMPOSIO_TYPE;
}

/** Read the Composio API key out of a connector's headers, case-insensitively. */
export function apiKeyOf(headers: Record<string, string>): string {
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === COMPOSIO_KEY_HEADER);
  return hit ? headers[hit].trim() : '';
}

/** Where Composio's Tool Router API lives. Overridable so tests can point at a local stub. */
function apiBase(): string {
  return (process.env.COMPOSIO_API_BASE || 'https://backend.composio.dev').replace(/\/+$/, '');
}

export type MintResult = { url: string } | { error: string };

/** The fixed Composio entity that owns COMPANY-wide connections (shared by every agent), distinct
 *  from a member's personal connections (which use the member's email as the user_id). */
export function serviceUserId(tenant: string): string {
  return `service:${tenant}`;
}

/** One connected app on Composio (read from the connected-accounts API; never includes secrets). */
export interface ComposioConnection {
  id: string;
  toolkit: string;
  status: string;
  createdAt: string;
  userId: string;
  /** A human-distinguishable label for THIS connection (so two Gmail accounts aren't both just "gmail").
   *  The account's real address isn't in the list payload — this is the user-set `alias` if any, else
   *  Composio's auto handle (`word_id`, e.g. `gmail_comma-hugh`), else the connection id. */
  name: string;
}

/** One Composio toolkit (app) from the catalog — what a user can connect. */
export interface ComposioToolkit {
  slug: string;
  name: string;
}

// In-process cache for the toolkit catalog: it's a big, slow-changing list shared by everyone, so we
// fetch it once per key and reuse for an hour rather than hitting Composio on every console load.
let toolkitCache: { key: string; at: number; items: ComposioToolkit[] } | null = null;
const TOOLKIT_TTL_MS = 60 * 60 * 1000;

/**
 * The full Composio toolkit catalog (~1000+ apps), paginated through and cached. Returns [] on any
 * error so the console degrades to the static suggestions. Each item is the slug you connect by + a
 * friendly name.
 */
export async function listToolkits(apiKey: string): Promise<ComposioToolkit[]> {
  if (!apiKey) return [];
  if (toolkitCache && toolkitCache.key === apiKey && Date.now() - toolkitCache.at < TOOLKIT_TTL_MS) {
    return toolkitCache.items;
  }
  const out: ComposioToolkit[] = [];
  const seen = new Set<string>();
  try {
    let cursor = '';
    for (let page = 0; page < 8; page++) {
      // eslint-disable-line no-constant-condition
      const url = `${apiBase()}/api/v3/toolkits?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await fetch(url, { headers: { [COMPOSIO_KEY_HEADER]: apiKey } });
      if (!res.ok) break;
      const j: any = await res.json().catch(() => ({}));
      const items: any[] = j.items || j.data || (Array.isArray(j) ? j : []);
      for (const t of items) {
        const slug = String(t.slug ?? t.key ?? t.name ?? '').toLowerCase().trim();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        out.push({ slug, name: String(t.name ?? t.meta?.name ?? slug) });
      }
      cursor = String(j.next_cursor ?? j.nextCursor ?? '');
      if (!cursor) break;
    }
  } catch {
    return toolkitCache?.items ?? [];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  if (out.length) toolkitCache = { key: apiKey, at: Date.now(), items: out };
  return out;
}

/**
 * List the apps connected on composio.dev under `userId` (a member's email, or the service entity).
 * Read-only status view for the console. Returns [] on any error so the UI degrades gracefully.
 */
export async function listConnectedAccounts(apiKey: string, userId: string): Promise<ComposioConnection[]> {
  if (!apiKey || !userId) return [];
  try {
    const url = `${apiBase()}/api/v3/connected_accounts?user_ids=${encodeURIComponent(userId)}`;
    const res = await fetch(url, { headers: { [COMPOSIO_KEY_HEADER]: apiKey } });
    if (!res.ok) return [];
    const j: any = await res.json().catch(() => ({}));
    const items: any[] = j.items || j.data || (Array.isArray(j) ? j : []);
    return items.map((a) => ({
      id: String(a.id ?? ''),
      toolkit: String(a.toolkit?.slug ?? a.toolkit ?? a.app_name ?? '?'),
      status: String(a.status ?? a.state ?? 'UNKNOWN'),
      createdAt: String(a.created_at ?? a.createdAt ?? ''),
      userId: String(a.user_id ?? a.userId ?? userId),
      name: String(a.alias || a.word_id || a.wordId || a.id || ''),
    }));
  } catch {
    return [];
  }
}

/** Disconnect (delete) a connected account on Composio by its id. Returns ok / an error message. */
export async function deleteConnectedAccount(apiKey: string, id: string): Promise<{ ok: true } | { error: string }> {
  if (!apiKey) return { error: 'no Composio API key' };
  if (!id) return { error: 'no connection id' };
  try {
    const res = await fetch(`${apiBase()}/api/v3/connected_accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { [COMPOSIO_KEY_HEADER]: apiKey },
    });
    if (res.ok) return { ok: true };
    const j: any = await res.json().catch(() => ({}));
    return { error: String(j?.error?.message || j?.message || `delete failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'delete failed' };
  }
}

/**
 * Initiate connecting `toolkit` under `userId` and return the hosted OAuth link to complete it.
 * Uses the Tool Router's `COMPOSIO_MANAGE_CONNECTIONS` (the same call an agent makes), so a keyless
 * managed connection works with no custom auth config. `userId` decides scope: the service entity
 * (company) or a member's email (personal). The caller enforces who may target which scope.
 */
export async function initiateConnection(
  apiKey: string,
  userId: string,
  toolkit: string,
): Promise<{ redirectUrl: string; status: string } | { error: string }> {
  if (!apiKey) return { error: 'no Composio API key' };
  const minted = mintToolRouterSession(apiKey, userId);
  if ('error' in minted) return { error: minted.error };
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [COMPOSIO_KEY_HEADER]: apiKey,
    };
    let sid: string | undefined;
    const rpc = async (body: unknown): Promise<any> => {
      const r = await fetch(minted.url, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
      const got = r.headers.get('mcp-session-id');
      if (got) sid = got;
      const text = await r.text();
      const line = text.split('\n').map((l) => l.replace(/^data:\s*/, '').trim()).filter((l) => l.startsWith('{')).pop();
      return line ? JSON.parse(line) : null;
    };
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-os', version: '1' } } });
    const call = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_MANAGE_CONNECTIONS', arguments: { toolkits: [toolkit] } } });
    const content: string = (call?.result?.content || []).map((c: any) => c.text || '').join('\n');
    let parsed: any;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    const res = parsed?.data?.results?.[toolkit];
    if (res?.redirect_url) return { redirectUrl: res.redirect_url, status: res.status || 'initiated' };
    if (parsed?.data && !res) return { error: `"${toolkit}" may already be connected, or is not a valid toolkit slug` };
    return { error: String(parsed?.error || content || 'could not initiate connection').slice(0, 200) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'connection initiation failed' };
  }
}

/**
 * Mint a Tool Router session for `userId` and return its MCP endpoint URL. The session is scoped to
 * that user, so the agent only sees the apps that user has connected on composio.dev — and Tool
 * Router auto-selects the relevant tools from them. Returns `{ error }` (never throws) so a flaky
 * network or a bad key degrades to "this connector is skipped this launch", not a dead session.
 */
export function mintToolRouterSession(apiKey: string, userId: string): MintResult {
  if (!apiKey) return { error: 'no Composio API key' };
  const url = `${apiBase()}/api/v3.1/tool_router/session`;
  const body = JSON.stringify({ user_id: userId });
  const res = spawnSync(
    'curl',
    ['-sS', '--max-time', '20', '-X', 'POST', url,
     '-H', `${COMPOSIO_KEY_HEADER}: ${apiKey}`, '-H', 'content-type: application/json',
     '-d', body],
    { encoding: 'utf8' },
  );
  if (res.error) return { error: `curl failed: ${res.error.message}` };
  if (res.status !== 0) return { error: `curl exited ${res.status}: ${(res.stderr || '').trim()}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout || '{}');
  } catch {
    return { error: `unexpected response: ${(res.stdout || '').slice(0, 200)}` };
  }
  const mcpUrl = (parsed as { mcp?: { url?: string } })?.mcp?.url;
  if (typeof mcpUrl === 'string' && mcpUrl) return { url: mcpUrl };
  const apiErr = (parsed as { error?: { message?: string }; message?: string })?.error?.message
    || (parsed as { message?: string })?.message;
  return { error: apiErr || `no mcp.url in response: ${JSON.stringify(parsed).slice(0, 200)}` };
}

// ── ingress: Composio Webhook Triggers V2 ───────────────────────────────────────────
/**
 * Verify a Composio webhook delivery (Svix scheme): headers `webhook-id`/`webhook-timestamp`/
 * `webhook-signature`, HMAC-SHA256 over `id.timestamp.rawBody`, base64; the header carries one or
 * more space-separated `v1,<sig>` entries. The secret is a Svix `whsec_<base64>` — the HMAC key is
 * the base64-decoded part. Rejects deliveries outside a 300s window (replay protection).
 */
export function verifyComposioWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): boolean {
  if (!secret) return false;
  const h = (k: string): string => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : String(v ?? '');
  };
  const id = h('webhook-id');
  const ts = h('webhook-timestamp');
  const sigHeader = h('webhook-signature');
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  const expBuf = Buffer.from(expected);
  for (const part of sigHeader.split(' ')) {
    const comma = part.indexOf(',');
    const sig = comma >= 0 ? part.slice(comma + 1) : part;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) return true;
  }
  return false;
}

export interface ComposioEvent {
  /** The trigger slug, upper-cased — e.g. SLACK_DIRECT_MESSAGE_RECEIVED. '' if absent. */
  triggerSlug: string;
  /** Toolkit slug — e.g. slackbot / gmail. */
  toolkit: string;
  /** The user_id (Composio entity) the connected account belongs to, if present. */
  userId: string;
  /** A compact, human-readable line for the agent's task (text/channel/user when present). */
  summary: string;
  /** The raw event payload (capped when injected into a task). */
  raw: unknown;
}

/** Parse a Composio V2 webhook body into the fields a dispatch + task template needs. Defensive: the
 *  payload shape varies by toolkit, so every field is best-effort. */
export function parseComposioEvent(body: any): ComposioEvent {
  const triggerSlug = String(
    body?.type || body?.trigger_slug || body?.triggerSlug || body?.metadata?.trigger_slug || body?.metadata?.triggerName || '',
  ).toUpperCase();
  const data = body?.data ?? body?.payload ?? body ?? {};
  const ev = data.event ?? data;
  const toolkit = String(
    body?.toolkit?.slug || body?.toolkit || data.toolkit || (triggerSlug.split('_')[0] || ''),
  ).toLowerCase();
  const userId = String(body?.user_id || body?.userId || data.user_id || body?.metadata?.user_id || '');
  const text = ev.text || ev.message || data.text || '';
  const channel = ev.channel || ev.channel_id || data.channel || '';
  const user = ev.user || ev.user_id || data.user || '';
  const bits: string[] = [];
  if (user) bits.push(`from ${user}`);
  if (channel) bits.push(`in ${channel}`);
  if (text) bits.push(`: ${String(text).slice(0, 500)}`);
  const summary = bits.join(' ') || triggerSlug || 'event';
  return { triggerSlug, toolkit, userId, summary, raw: body };
}
