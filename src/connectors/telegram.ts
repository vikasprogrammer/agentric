/**
 * Native Telegram — a thin, zero-dependency client for the slice of the Telegram Bot API the OS needs
 * to run a company Telegram bot over **long polling** (`getUpdates`): resolve the bot's own identity,
 * fetch inbound updates, post replies, and normalise an inbound message into an event we can map to an
 * Agent OS member for run-as.
 *
 * Why long polling and not a webhook: it keeps the trust/governance model identical to Slack Socket
 * Mode and the Discord Gateway — the Node server dials OUT to `api.telegram.org` over plain HTTPS
 * (`getUpdates` holds the connection open up to `timeout` seconds), so a Tailscale-private / on-prem box
 * that can reach Telegram outbound works with **no public URL** and zero ingress. This mirrors
 * `connectors/discord.ts`; Telegram is actually simpler — one bot token (from @BotFather), no gateway
 * heartbeat, no app-level token.
 *
 * One company bot, configured once, is shared across the whole workspace: a single shared identity
 * (egress), it receives the chats' message updates (ingress), and each inbound update names the Telegram
 * user — the seam for per-member behaviour on top of one shared app (see `edge/telegram-socket.ts`).
 *
 * Privacy-mode note: by default a Telegram bot in a GROUP only receives messages that are commands
 * (`/cmd`), @-mention it, or reply to one of its messages. Plain follow-ups (thread continuity) require
 * **Group Privacy disabled** in @BotFather. Mention/command ingress works either way; only continuity
 * needs privacy off.
 *
 * All calls use the global `fetch` (Node 22+) — no runtime dependency, matching the Slack/Discord stance.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Escape a string for safe inclusion in a RegExp (bot usernames are `[A-Za-z0-9_]` but be defensive). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve the bot's own id + username (and validate the token en route). Returns `{ error }` (never
 *  throws) so a flaky network / bad token degrades gracefully. The username is needed to detect an
 *  @-mention in a group; the id to ignore the bot's own / other bots' messages. */
export async function getMe(botToken: string): Promise<{ id: string; username: string } | { error: string }> {
  if (!botToken) return { error: 'no Telegram bot token' };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`);
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.ok && j?.result?.id) return { id: String(j.result.id), username: String(j.result.username || '') };
    return { error: String(j?.description || `getMe failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'getMe failed' };
  }
}

/** Long-poll for updates. `offset` confirms everything below it (Telegram then drops those from the
 *  queue) and asks for the next batch; `timeoutSec` is how long Telegram holds the connection when idle
 *  (0 = return immediately, used for the startup drain). `signal` lets the socket abort an in-flight
 *  long-poll on shutdown. Returns the raw updates array, or `{ error }` (never throws). */
export async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<{ updates: any[] } | { error: string }> {
  if (!botToken) return { error: 'no Telegram bot token' };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, timeout: timeoutSec, allowed_updates: ['message'] }),
      signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.ok && Array.isArray(j.result)) return { updates: j.result };
    return { error: String(j?.description || `getUpdates failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'getUpdates failed' };
  }
}

/** Post a message as the bot. `replyToMessageId` renders it as a reply to the triggering message
 *  (Telegram's analogue of Slack's `thread_ts`); `messageThreadId` targets a forum-topic thread in a
 *  supergroup. Plain text (no `parse_mode`) so agent output never trips Telegram's MarkdownV2 escaping.
 *  Returns the new message id, or `{ error }` (never throws). */
export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  opts?: { replyToMessageId?: string; messageThreadId?: string },
): Promise<{ ok: true; id: string } | { error: string }> {
  if (!botToken) return { error: 'no Telegram bot token' };
  if (!chatId) return { error: 'no chat id' };
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (opts?.replyToMessageId) body.reply_to_message_id = Number(opts.replyToMessageId);
    if (opts?.messageThreadId) body.message_thread_id = Number(opts.messageThreadId);
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.ok && j?.result?.message_id) return { ok: true, id: String(j.result.message_id) };
    return { error: String(j?.description || `sendMessage failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'sendMessage failed' };
  }
}

/**
 * Normalise an agent id into a Telegram bot-command name. Telegram commands are constrained to
 * `[a-z0-9_]{1,32}` (BotFather + `setMyCommands` reject anything else, and the client stops parsing a
 * command at the first out-of-set char), so a hyphenated agent id like `agent-author` can't be a command
 * verbatim. We lowercase, map every disallowed char to `_`, collapse/trim underscores, and cap at 32.
 * The socket registers these names via `setMyCommands` and reverses the mapping on an inbound `/name`,
 * so tapping the menu entry reaches the real agent. Returns '' when nothing usable survives (skip it).
 */
export function telegramCommandName(agentId: string): string {
  return (agentId || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

/** Register the bot's command menu (the list Telegram shows when a user types `/`). Replaces the whole
 *  set each call. `description` is 1–256 chars. Returns `{ error }` (never throws). */
export async function setMyCommands(
  botToken: string,
  commands: { command: string; description: string }[],
): Promise<{ ok: true } | { error: string }> {
  if (!botToken) return { error: 'no Telegram bot token' };
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok && j?.ok) return { ok: true };
    return { error: String(j?.description || `setMyCommands failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'setMyCommands failed' };
  }
}

/** A normalized inbound Telegram message, parsed from an `update.message` payload. */
export interface TelegramMessageEvent {
  /** The event kind for filtering/labels: `direct_message` (private chat) or `mention` (group). */
  eventType: string;
  /** The chat id the message arrived in (where a reply is posted) — the run's binding + continuity key.
   *  For a private chat this equals the sender's user id; for a group it's the (negative) group id. */
  chatId: string;
  /** The chat type: `private` | `group` | `supergroup` | `channel`. */
  chatType: string;
  /** Forum-topic id inside a supergroup (only when this is a real topic message), else ''. Part of the
   *  continuity key so distinct topics in one forum are distinct conversations; also targets the reply. */
  messageThreadId: string;
  /** The message id (the reply target — Telegram's analogue of Slack's thread root `ts`). */
  messageId: string;
  /** The sender's Telegram user id (the join key for member run-as). '' for service messages. */
  user: string;
  /** The sender's display handle (@username → first/last name), for the inbox/task label. */
  username: string;
  /** The message text (or caption). */
  text: string;
  /** Whether the sender is a bot (caller should skip these to avoid loops). */
  fromBot: boolean;
  /** True when this is an explicit trigger — a private-chat message, or a group message that @-mentioned
   *  the bot / is a `/command` / replies to the bot. A group message that did NOT is still surfaced (for
   *  thread-continuity) with `mentioned:false`, so the dispatcher only lets it CONTINUE a bound chat. */
  mentioned: boolean;
  /** The full inner message object (capped when injected into a task template). */
  raw: any;
}

/**
 * Normalise an `update.message` payload into a routed message event (null when it's not a text/caption
 * message we handle). `mentioned` marks the cases that start a FRESH run — mirroring Discord's DM +
 * @mention: a **private chat** message, or a **group** message that @-mentions the bot, is a `/command`,
 * or replies to one of the bot's messages. A plain group message that did none of these is still returned
 * (`mentioned:false`) so the dispatcher can use it for thread-continuity; it never fires a fresh run on
 * its own. Defensive: every field is best-effort.
 */
export function parseTelegramUpdate(update: any, botId: string, botUsername: string): TelegramMessageEvent | null {
  const m = update?.message;
  if (!m || typeof m !== 'object') return null;
  const text = String(m.text ?? m.caption ?? '');
  if (!text) return null; // non-text (stickers, joins, …) — nothing to route
  const from = m.from || {};
  const chat = m.chat || {};
  const chatType = String(chat.type || '');
  const isPrivate = chatType === 'private';
  const fromBot = !!from.is_bot || !from.id;
  const mentionsBot = !!botUsername && new RegExp(`@${escapeRegex(botUsername)}\\b`, 'i').test(text);
  const isCommand =
    (Array.isArray(m.entities) && m.entities.some((e: any) => e?.type === 'bot_command' && e?.offset === 0)) ||
    /^\s*\//.test(text);
  const replyToBot = !!botId && String(m.reply_to_message?.from?.id || '') === String(botId);
  return {
    eventType: isPrivate ? 'direct_message' : 'mention',
    mentioned: isPrivate || mentionsBot || isCommand || replyToBot,
    chatId: String(chat.id || ''),
    chatType,
    // Only treat a real forum topic as a thread; a plain reply carries message_thread_id too but isn't
    // a distinct conversation, so keying on it there would fragment continuity.
    messageThreadId: m.is_topic_message ? String(m.message_thread_id || '') : '',
    messageId: String(m.message_id || ''),
    user: String(from.id || ''),
    username: String(from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || ''),
    text,
    fromBot,
    raw: m,
  };
}
