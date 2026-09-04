/**
 * Native Slack — a thin, zero-dependency client for the slice of Slack's API the OS needs to run a
 * company Slack app over **Socket Mode**: open the outbound WebSocket, post replies, and resolve a
 * triggering Slack user to their email (so we can map them to an Agentric member for run-as).
 *
 * Why Socket Mode and not a webhook: the app keeps the trust/governance model identical to the rest
 * of the OS while needing **no public URL** — the Node server dials OUT to Slack over a WebSocket, so
 * a Tailscale-private / on-prem box that can reach `*.slack.com` outbound works with zero ingress.
 *
 * One company app, configured once, is shared across the whole workspace: the bot is a single shared
 * identity (egress), it receives the workspace's events (ingress), and each inbound event names the
 * Slack user — which is how we get per-member behaviour on top of one shared app (see slack-socket.ts).
 *
 * This module is deliberately Slack-specific (a connector plugin, not core). All calls use the global
 * `fetch`/`WebSocket` (Node 22+) — no runtime dependency, matching the Composio connector's stance.
 */

const SLACK_API = 'https://slack.com/api';

/** Open a Socket-Mode connection: exchange the app-level token (`xapp-…`) for a single-use WSS URL.
 *  Returns the URL to dial, or `{ error }` (never throws) so a flaky network degrades gracefully. */
export async function openSocketConnection(appToken: string): Promise<{ url: string } | { error: string }> {
  if (!appToken) return { error: 'no Slack app-level token' };
  try {
    const res = await fetch(`${SLACK_API}/apps.connections.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded' },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok && typeof j.url === 'string') return { url: j.url };
    return { error: String(j?.error || `apps.connections.open failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'apps.connections.open failed' };
  }
}

/** Post a message as the bot. `threadTs` keeps replies in-thread (the natural place to answer a mention). */
export async function postMessage(
  botToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ok: true; ts: string } | { error: string }> {
  if (!botToken) return { error: 'no Slack bot token' };
  try {
    const body: Record<string, unknown> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok) return { ok: true, ts: String(j.ts || '') };
    // Slack returns the specific missing scope in `needed` on a `missing_scope` error — keep it so the
    // egress layer can tell the agent exactly which scope to have an admin add.
    const code = String(j?.error || `chat.postMessage failed (${res.status})`);
    const needed = j?.needed ? ` (needed: ${j.needed})` : '';
    return { error: code + needed };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'chat.postMessage failed' };
  }
}

/**
 * Turn a raw Slack API error into a one-line, ACTIONABLE hint an unattended agent can act on itself —
 * instead of stranding on a human. Derived from real fleet friction: a `compass` agent that produced a
 * report but hit `missing_scope`/`not_in_channel` posting to a private channel had no recourse but to
 * `ask` a human (repeatedly). The raw code is preserved (agents/audit still see it) and a remedy appended.
 */
export function explainSlackError(error: string, channelRef?: string): string {
  const where = channelRef ? ` "${channelRef}"` : '';
  const code = error.split(' ')[0]; // strip any appended "(needed: …)" for the match
  switch (code) {
    case 'not_in_channel':
    case 'is_private':
      return `${error} — the bot isn't a member of${where} and can't self-join it (private/restricted). ` +
        `Ask a human to \`/invite\` the bot to that channel, or post to a public channel / DM the person instead.`;
    case 'missing_scope':
      return `${error} — the Slack app is missing a required OAuth scope. Ask an admin to add it in ` +
        `Settings → Integrations and reinstall the app; then retry.`;
    case 'channel_not_found':
      return `${error} — no channel${where} is visible to the bot. Double-check the id/name, or the bot ` +
        `may need to be invited to a private channel first.`;
    case 'is_archived':
      return `${error} — channel${where} is archived; pick a live channel.`;
    case 'restricted_action':
    case 'cant_post_message':
      return `${error} — workspace policy blocks the bot from posting${where}. Escalate to a human.`;
    default:
      return error;
  }
}

/** Open (or fetch) the DM channel with a Slack user, returning its channel id to post into. Used to
 *  DM an approver a notification. Returns `{ error }` (never throws) so a flaky call degrades quietly. */
export async function openDmChannel(botToken: string, userId: string): Promise<{ channel: string } | { error: string }> {
  if (!botToken || !userId) return { error: 'missing token or user' };
  try {
    const res = await fetch(`${SLACK_API}/conversations.open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ users: userId }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok && j.channel?.id) return { channel: String(j.channel.id) };
    return { error: String(j?.error || `conversations.open failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'conversations.open failed' };
  }
}

/** Resolve an email → its Slack user id, so an agent can DM a person it only knows by email. Uses
 *  `users.lookupByEmail` (needs the `users:read.email` scope). Returns `{ error }` (never throws). */
export async function lookupUserByEmail(botToken: string, email: string): Promise<{ user: string } | { error: string }> {
  if (!botToken || !email) return { error: 'missing token or email' };
  try {
    const res = await fetch(`${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { authorization: `Bearer ${botToken}` },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok && j.user?.id) return { user: String(j.user.id) };
    return { error: String(j?.error || `users.lookupByEmail failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'users.lookupByEmail failed' };
  }
}

/** Resolve a channel NAME (e.g. `general`, leading `#` optional) → its channel id, so an agent can
 *  post to a channel it knows by name. Walks `conversations.list` (public + private) with a bounded
 *  number of pages. Returns `{ error }` when not found / on failure (never throws). */
export async function lookupChannelByName(botToken: string, name: string): Promise<{ channel: string } | { error: string }> {
  if (!botToken || !name) return { error: 'missing token or channel name' };
  const want = name.trim().replace(/^#/, '').toLowerCase();
  let cursor = '';
  try {
    for (let page = 0; page < 10; page++) { // ≤10 pages × 1000 = 10k channels, plenty for a workspace
      const qs = new URLSearchParams({ types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000' });
      if (cursor) qs.set('cursor', cursor);
      const res = await fetch(`${SLACK_API}/conversations.list?${qs.toString()}`, {
        headers: { authorization: `Bearer ${botToken}` },
      });
      const j: any = await res.json().catch(() => ({}));
      if (!j?.ok) return { error: String(j?.error || `conversations.list failed (${res.status})`) };
      const hit = (j.channels || []).find((c: any) => String(c?.name || '').toLowerCase() === want);
      if (hit?.id) return { channel: String(hit.id) };
      cursor = String(j.response_metadata?.next_cursor || '');
      if (!cursor) break;
    }
    return { error: `no channel named "${want}"` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'conversations.list failed' };
  }
}

/** Best-effort join a public channel so the bot can post into it (`chat.postMessage` fails with
 *  `not_in_channel` otherwise). No-op-ish for private channels (returns the error). Never throws. */
export async function joinChannel(botToken: string, channelId: string): Promise<{ ok: true } | { error: string }> {
  if (!botToken || !channelId) return { error: 'missing token or channel' };
  try {
    const res = await fetch(`${SLACK_API}/conversations.join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: channelId }),
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok) return { ok: true };
    return { error: String(j?.error || `conversations.join failed (${res.status})`) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'conversations.join failed' };
  }
}

/** Resolve a Slack user id (e.g. `U123`) to their profile email — the join key for member run-as.
 *  Returns '' on any error/missing email (the dispatcher then falls back to the company identity). */
export async function lookupUserEmail(botToken: string, userId: string): Promise<string> {
  if (!botToken || !userId) return '';
  try {
    const res = await fetch(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${botToken}` },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.ok) return String(j.user?.profile?.email || '').trim().toLowerCase();
    return '';
  } catch {
    return '';
  }
}

/** Resolve the bot's own user id (so the dispatcher can ignore the bot's own messages / @self loops). */
export async function lookupBotUserId(botToken: string): Promise<string> {
  if (!botToken) return '';
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${botToken}` } });
    const j: any = await res.json().catch(() => ({}));
    return j?.ok ? String(j.user_id || '') : '';
  } catch {
    return '';
  }
}

/** A file attached to an inbound Slack message, normalized for download + hand-off to an agent. */
export interface SlackFileRef {
  id: string;
  name: string;
  mimetype: string;
  /** Bytes, as Slack reports them (0 when unknown) — the cheap pre-check before we spend a download. */
  size: number;
  /** The authenticated download URL (`url_private_download`); needs the bot token in an Authorization header. */
  url: string;
}

/** A normalized inbound Slack message event, parsed from a Socket-Mode `events_api` envelope. */
export interface SlackMessageEvent {
  /** The Slack event type — `app_mention` (bot @-mentioned in a channel) or `message` (DM/IM). */
  eventType: string;
  /** Channel id the message arrived in (where a reply should be posted). */
  channel: string;
  /** Channel kind: `im` (DM to the bot), `channel`/`group`/`mpim`, or '' if unknown. */
  channelType: string;
  /** The Slack user id who sent it (the join key for member run-as). '' for bot/system messages. */
  user: string;
  /** The message text (mention tokens left intact; the agent gets the raw text). */
  text: string;
  /** The thread to reply in: an existing `thread_ts`, else the message's own `ts` (start a thread). */
  threadTs: string;
  /** Whether this looks like the bot's own message / a bot message (caller should skip these). */
  fromBot: boolean;
  /** Files attached to the message (images, PDFs, logs). Empty when there are none. */
  files: SlackFileRef[];
  /** The full inner event object (capped when injected into a task template). */
  raw: any;
}

/**
 * Parse a Socket-Mode `events_api` envelope into a normalized message event, or null when the inner
 * event isn't a user-facing message we route (we only care about `app_mention` and DM `message`s).
 * Defensive: Slack's event shapes vary, so every field is best-effort.
 */
export function parseSlackEvent(envelope: any): SlackMessageEvent | null {
  const ev = envelope?.payload?.event;
  if (!ev || typeof ev !== 'object') return null;
  const eventType = String(ev.type || '');
  if (eventType !== 'app_mention' && eventType !== 'message') return null;
  // Slack message-changed/deleted/joined carry a `subtype`; we only route plain user messages + mentions.
  // `file_share` is the exception that used to cost us every screenshot: a message a human sends WITH an
  // attachment carries that subtype, so blanket-dropping subtyped messages silently swallowed the whole
  // event — text and all — and the sender saw the bot ignore them. It is an ordinary user message that
  // happens to have files, so it routes like one.
  if (eventType === 'message' && ev.subtype && ev.subtype !== 'file_share') return null;
  const fromBot = !!ev.bot_id || ev.subtype === 'bot_message' || !ev.user;
  return {
    eventType,
    channel: String(ev.channel || ev.channel_id || ''),
    channelType: String(ev.channel_type || ''),
    user: String(ev.user || ''),
    text: String(ev.text || ''),
    threadTs: String(ev.thread_ts || ev.ts || ''),
    fromBot,
    files: parseSlackFiles(ev.files),
    raw: ev,
  };
}

/** Normalize the `files` array Slack attaches to a message (`file_share` / a mention with an upload).
 *  Entries without a private download URL (a deleted or externally-hosted file) are skipped. */
export function parseSlackFiles(files: unknown): SlackFileRef[] {
  if (!Array.isArray(files)) return [];
  const out: SlackFileRef[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const rec = f as Record<string, unknown>;
    const url = String(rec.url_private_download || rec.url_private || '');
    if (!url) continue;
    out.push({
      id: String(rec.id || ''),
      name: String(rec.name || rec.title || 'file'),
      mimetype: String(rec.mimetype || ''),
      size: Number(rec.size) || 0,
      url,
    });
  }
  return out;
}

/**
 * Download a Slack-hosted file as the bot. `url_private_download` is NOT public — it answers with the
 * login page (HTML, status 200) unless the bot token rides in an Authorization header, which is the
 * classic way this silently "works" and yields a 40KB HTML file instead of the screenshot. Needs the
 * `files:read` scope. Bounded by `maxBytes`; returns `{ error }` (never throws).
 */
export async function downloadSlackFile(
  botToken: string,
  url: string,
  maxBytes: number,
): Promise<{ data: Buffer; contentType: string } | { error: string }> {
  if (!botToken) return { error: 'no Slack bot token' };
  if (!/^https:\/\/[\w.-]*\bslack\.com\//.test(url)) return { error: 'refusing to download a non-Slack URL' };
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` }, redirect: 'follow' });
    if (!res.ok) return { error: `download failed (${res.status})` };
    const contentType = String(res.headers.get('content-type') || '');
    // Slack answers an unauthenticated/unscoped fetch with its sign-in page rather than a 401.
    if (/^text\/html/i.test(contentType)) return { error: 'download returned Slack HTML — the app likely lacks the `files:read` scope' };
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > maxBytes) return { error: `file is ${declared} bytes, over the ${maxBytes}-byte limit` };
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) return { error: `file is ${data.length} bytes, over the ${maxBytes}-byte limit` };
    return { data, contentType };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'download failed' };
  }
}

/** The history scope a conversation type needs. Slack splits them by conversation kind, which is the
 *  whole trap: an app with `channels:history` works in every public channel and fails in every private
 *  one, so the feature looks installed until the first private thread. */
export function historyScopeFor(channelType: string): string {
  if (channelType === 'group') return 'groups:history';
  if (channelType === 'mpim') return 'mpim:history';
  if (channelType === 'im') return 'im:history';
  return 'channels:history';
}

/**
 * The line the bot posts IN the thread when it could not read that thread — deterministic, written by
 * the server, never by the model.
 *
 * The agent is told the same thing in its prompt, but a prompt is a request: the model may relay it,
 * paraphrase it into something wrong, or answer as though nothing were missing. The one case that
 * matters is exactly the case where the agent has the least context to notice, so the warning cannot
 * depend on the agent noticing. Returns '' when there is nothing to warn about.
 */
export function threadReadWarning(channelType: string, error?: string): string {
  if (!error) return '';
  const scope = historyScopeFor(channelType);
  if (error === 'missing_scope' || error === 'not_allowed_token_type') {
    return `⚠️ I can only see the message that tagged me — I can't read this thread's earlier messages. ` +
      `The Agentric Slack app is missing the \`${scope}\` scope for this conversation. ` +
      `An admin adds it in the Slack app config (OAuth & Permissions → Bot Token Scopes) and reinstalls the app.`;
  }
  if (error === 'not_in_channel' || error === 'channel_not_found') {
    return `⚠️ I can only see the message that tagged me — I can't read this thread's earlier messages ` +
      `(Slack: \`${error}\`). Invite the bot to this channel so it can read the conversation it is asked about.`;
  }
  return `⚠️ I can only see the message that tagged me — reading this thread failed (Slack: \`${error}\`).`;
}

/** One earlier message in the thread a mention landed in, normalized for the prompt block. */
export interface SlackThreadMessage {
  /** Slack `ts` — also the message's identity, so the caller can drop the triggering message itself. */
  ts: string;
  /** Sender's Slack user id ('' for a bot/app post). */
  user: string;
  /** A display name when the payload carries one (bot posts do; human posts don't — the caller resolves). */
  name: string;
  text: string;
  bot: boolean;
}

/**
 * Read the messages already in a thread (`conversations.replies`).
 *
 * Why this exists: an @mention delivers ONLY the mention's own text. A human who tags the bot on the
 * fifth message of a thread is, in their head, handing over a conversation — and the agent, seeing one
 * line, either asks them to paste it all back or (worse) invents a reason it cannot see the rest. The
 * bot is a member of the channel and already receives the event, so the history is one authenticated
 * call away; we fetch it here and inject it into the prompt.
 *
 * Scope note: `channels:history` covers PUBLIC channels only. A private channel needs `groups:history`,
 * a group DM `mpim:history`, a DM `im:history` — a Slack app created before those were in the bundled
 * manifest answers `missing_scope`, which is surfaced verbatim so the operator is told to add the scope
 * and reinstall rather than the agent guessing.
 *
 * `oldest`-less and newest-last: Slack returns the thread in ascending order, so we take the LAST
 * `limit` entries (the parent plus recent turns matter; the middle of a 300-reply thread does not).
 */
export async function fetchThreadMessages(
  botToken: string,
  channel: string,
  threadTs: string,
  limit: number,
): Promise<{ messages: SlackThreadMessage[] } | { error: string }> {
  if (!botToken || !channel || !threadTs) return { error: 'missing token, channel or thread' };
  try {
    const url =
      `${SLACK_API}/conversations.replies?channel=${encodeURIComponent(channel)}` +
      `&ts=${encodeURIComponent(threadTs)}&limit=${Math.max(1, Math.min(200, limit))}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${botToken}` } });
    const j: any = await res.json().catch(() => ({}));
    if (!j?.ok) return { error: String(j?.error || `conversations.replies failed (${res.status})`) };
    const raw = Array.isArray(j.messages) ? j.messages : [];
    const messages: SlackThreadMessage[] = raw.map((m: any) => ({
      ts: String(m?.ts || ''),
      user: String(m?.user || ''),
      name: String(m?.bot_profile?.name || m?.username || ''),
      text: String(m?.text || ''),
      bot: !!m?.bot_id || m?.subtype === 'bot_message' || !m?.user,
    }));
    return { messages: messages.slice(-limit) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'conversations.replies failed' };
  }
}
