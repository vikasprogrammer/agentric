/**
 * Native Discord — a thin, zero-dependency client for the slice of Discord's API the OS needs to run
 * a company Discord bot over the **Gateway** (Discord's equivalent of Slack's Socket Mode): resolve
 * the outbound gateway URL, post replies, and normalise an inbound message event so we can map the
 * author to an Agent OS member for run-as.
 *
 * Why the Gateway and not an HTTP Interactions webhook: it keeps the trust/governance model identical
 * to the rest of the OS while needing **no public URL** — the Node server dials OUT to Discord over a
 * WebSocket, so a Tailscale-private / on-prem box that can reach `discord.com` / `gateway.discord.gg`
 * outbound works with zero ingress. This mirrors `connectors/slack.ts` one-for-one; the only real
 * difference is Discord's gateway is heartbeat-driven (the lifecycle lives in `edge/discord-socket.ts`).
 *
 * One company bot, configured once, is shared across the whole workspace: it is a single shared
 * identity (egress), it receives the guilds' message events (ingress), and each inbound event names the
 * Discord user — the seam for per-member behaviour on top of one shared app (see discord-socket.ts).
 *
 * All calls use the global `fetch`/`WebSocket` (Node 22+) — no runtime dependency, matching the Slack
 * and Composio connectors' stance.
 */

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Gateway intents we subscribe to (a bitfield). GUILD_MESSAGES (1<<9) + DIRECT_MESSAGES (1<<12) so we
 * see channel messages + DMs, and MESSAGE_CONTENT (1<<15) so the message `content` is populated.
 * MESSAGE_CONTENT is a **privileged** intent — it must be enabled in the Discord Developer Portal
 * (Bot → Privileged Gateway Intents), or messages arrive with empty `content`.
 */
export const GATEWAY_INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // 37376

/** Discord gateway opcodes (the subset we handle). */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Resolve the bot's gateway WSS URL (and validate the token en route). `Bot <token>` auth.
 *  Returns the URL to dial, or `{ error }` (never throws) so a flaky network degrades gracefully. */
export async function getGatewayUrl(botToken: string): Promise<{ url: string } | { error: string }> {
  if (!botToken) return { error: 'no Discord bot token' };
  try {
    const res = await fetch(`${DISCORD_API}/gateway/bot`, {
      headers: { authorization: `Bot ${botToken}` },
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && typeof j?.url === 'string') return { url: `${j.url}?v=10&encoding=json` };
    return { error: String(j?.message || `GET /gateway/bot failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'GET /gateway/bot failed' };
  }
}

/** Post a message as the bot. `replyToMessageId` renders it as an in-channel reply to that message —
 *  the natural place to answer a mention (Discord's analogue of Slack's `thread_ts`). */
export async function postMessage(
  botToken: string,
  channelId: string,
  content: string,
  replyToMessageId?: string,
): Promise<{ ok: true; id: string } | { error: string }> {
  if (!botToken) return { error: 'no Discord bot token' };
  try {
    const body: Record<string, unknown> = { content };
    if (replyToMessageId) body.message_reference = { message_id: replyToMessageId, fail_if_not_exists: false };
    const res = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.id) return { ok: true, id: String(j.id) };
    return { error: String(j?.message || `POST messages failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'POST messages failed' };
  }
}

/** Open (or fetch) the DM channel with a Discord user, returning its channel id to post into. Used to
 *  DM an approver a notification. Returns `{ error }` (never throws). */
export async function openDmChannel(botToken: string, userId: string): Promise<{ channel: string } | { error: string }> {
  if (!botToken || !userId) return { error: 'missing token or user' };
  try {
    const res = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.id) return { channel: String(j.id) };
    return { error: String(j?.message || `create DM failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'create DM failed' };
  }
}

/** A normalized inbound Discord message, parsed from a `MESSAGE_CREATE` dispatch payload. */
export interface DiscordMessageEvent {
  /** The event kind for filtering/labels: `direct_message` (DM to the bot) or `mention` (@bot in a guild). */
  eventType: string;
  /** Channel id the message arrived in (where a reply should be posted). */
  channel: string;
  /** Guild id, or '' for a DM. */
  guildId: string;
  /** The message id (used as the reply target — Discord's analogue of Slack's thread root `ts`). */
  messageId: string;
  /** The author's Discord user id (the join key for member run-as). '' for system/webhook messages. */
  user: string;
  /** The author's display handle (global_name → username), for the inbox/task label. */
  username: string;
  /** The message text (requires the MESSAGE_CONTENT privileged intent to be non-empty). */
  text: string;
  /** Whether the author is a bot/webhook (caller should skip these to avoid loops). */
  fromBot: boolean;
  /** The full inner message object (capped when injected into a task template). */
  raw: any;
}

/**
 * Normalise a `MESSAGE_CREATE` payload into a routed message event, or null when it isn't one we act
 * on. We route exactly two cases — mirroring Slack's `app_mention` + DM `message`:
 *   • a **DM** to the bot (no `guild_id`), or
 *   • a **guild** message that **@-mentions the bot** (`mentions[]` contains the bot's user id).
 * Defensive: Discord's shapes vary, so every field is best-effort.
 */
export function parseDiscordMessage(d: any, botUserId: string): DiscordMessageEvent | null {
  if (!d || typeof d !== 'object') return null;
  const fromBot = !!d.author?.bot || !!d.webhook_id || !d.author?.id;
  const guildId = String(d.guild_id || '');
  const isDM = !guildId;
  const mentionsBot = Array.isArray(d.mentions) && botUserId
    ? d.mentions.some((m: any) => String(m?.id) === botUserId)
    : false;
  if (!isDM && !mentionsBot) return null; // a guild message that didn't @ us — ignore
  return {
    eventType: isDM ? 'direct_message' : 'mention',
    channel: String(d.channel_id || ''),
    guildId,
    messageId: String(d.id || ''),
    user: String(d.author?.id || ''),
    username: String(d.author?.global_name || d.author?.username || ''),
    text: String(d.content || ''),
    fromBot,
    raw: d,
  };
}
