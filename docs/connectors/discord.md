# Discord connector

**Status:** shipped. **Kind:** ingress (Gateway) + egress (reply, proactive send/DM, digest, DMs).
**Code:** `src/connectors/discord.ts` (API client) · `src/edge/discord-socket.ts` (connection + dispatch) ·
`discord_threads` (`src/state/db.ts`).

A one-for-one mirror of the Slack path over Discord's **Gateway** — Discord's equivalent of Socket Mode.
One company bot, one token, outbound WebSocket, **no public URL**.

## Setup

Owner/admin, **Settings → Integrations → Discord**: a single bot token (`discord_bot_token`;
`discordConfigured()` = token present). Then:

1. In the Discord Developer Portal, **Bot → Privileged Gateway Intents → enable MESSAGE CONTENT.**
   Without it messages arrive with empty `content` and nothing routes.
2. Invite the bot with the console's **one-click invite button** — a bot's user id *is* its application
   id, so once the Gateway reaches READY the invite URL is built automatically (nothing to paste).

Intents subscribed: `GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)` = 37376.

## Connection lifecycle

Heartbeat-driven, unlike Slack: `getGatewayUrl` → connect → **HELLO** (server-chosen heartbeat interval)
→ **IDENTIFY** → **READY**, which hands back the bot's own user id (the analogue of Slack's `auth.test`)
so self/bot messages are ignored. Reconnect backoff is 1 s → 30 s with zombie detection (a missed
`HEARTBEAT_ACK`). Deliberately **no RESUME** — every reconnect re-IDENTIFYs, matching `SlackSocket`'s
stance; a reconnect may miss the handful of events in the gap, which is acceptable for trigger dispatch.

Audit: `discord.connected` `{ botUserId, guilds }` — the READY guild count is the "is it actually
installed anywhere" signal.

## Ingress and threading

Run-as resolution differs from Slack in one important way: **a Discord bot cannot read a user's email**,
so there is no email fallback. The Discord user id is mapped through the **identity map**
(`member_identities`, provider `discord`, `memberByExternalId`), populated on the Team page (Chat IDs).
Unmapped senders run as the company identity.

A leading `<@BOTID>` mention is stripped before routing, so the `/agent` prefix parses.

**Threading is real, not implied.** For a guild @mention the socket branches an actual Discord **thread**
off the user's message (`startThread`), binds the *thread* to the session, and keeps the ack and every
`discord_reply` inside it. DMs have no threads → the reply uses a message reference in the DM. A
thread-create failure falls back to the parent channel. Continuity is keyed on the bound channel/thread in
`discord_threads`.

## Egress

| Tool | Exposed when | Does |
|---|---|---|
| `discord_reply` | `DISCORD_REPLY=1` (Discord-triggered session) | replies in the bound thread/channel |
| `discord_send` | `DISCORD_EGRESS=1` (Discord configured) | posts to any channel by id |
| `discord_dm` | `DISCORD_EGRESS=1` | DMs any person by Discord user id |

Audit-only, no policy gate: `discord.send` / `discord.dm` `{ channel|to, id, chars }`. Discord is also a
carrier for approval/question/task DMs and the EOD digest (`digest_discord_channel`).

## Gotchas

- **MESSAGE_CONTENT is privileged.** Forget it and every message body is empty — the failure is silent,
  not an error.
- **No email → the identity map is mandatory** for per-member run-as. An unlinked person's runs act as the
  company, with the company's connectors.
- Sub-second gaps around a reconnect can drop events (no RESUME, by design).
