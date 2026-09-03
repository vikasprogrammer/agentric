# Discord connector

**Status:** shipped. **Kind:** ingress (Gateway) + egress (reply, proactive send/DM, digest, DMs).
**Code:** `src/connectors/discord.ts` (API client) · `src/edge/discord-socket.ts` (connection + dispatch) ·
`discord_threads` + `discord_bot_messages` (`src/state/db.ts`).

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

The ack **names the agent that picked the message up** (`chatAck`, shared with Slack and Telegram) — in a
guild where several agents are reachable and the auto-router, not the sender, chose one, an anonymous
"On it" leaves the sender unable to tell who answered.

### Attachments (v0.417.0)

Discord never *dropped* a message with files — there is no `file_share` subtype — but `attachments[]`
landed in the raw payload and nowhere else, so an agent told "see the screenshot" had no screenshot.
`parseDiscordFiles` normalises the array and `downloadDiscordFile` fetches the bytes (≤5 files, ≤8 MB
each) into the agent's own **`.inbox/`**, with `attachmentNote` naming each by the relative path it will
have.

Two differences from Slack, both load-bearing: the CDN URL is **signed and needs no Authorization
header** — and must not be sent one, since the bot token has no business reaching the CDN host — and it
**expires**, which is why the bytes are fetched at dispatch rather than handed to the agent as a link to
open later. The host is checked against `cdn.discordapp.com` / `media.discordapp.net` (the URL arrives
inside an untrusted event). Audit: `discord.file.received` / `.failed` / `.skipped`.

### Replying to what an agent posted (v0.417.0)

`discord_threads` is keyed by **channel**, which covers a branched thread and cannot cover a proactive
`discord_send`: that posts into a channel with no thread, and binding the whole channel would drag every
unrelated message in it into the run. So a reply under a cron report was dropped as guild chatter — the
bot ignoring you in the conversation it started.

Discord marks a reply with **`message_reference.message_id`**, and having *written* that message is the
targeting signal. **`discord_bot_messages`** records every message an agent posts (`discord_reply`,
`discord_send`, and the ack itself); `sessionForDiscordMessage` resolves a reply back to that run, and
`continueDiscordThread` now tries the channel binding first and the reply reference second. When the
original run is past resuming, the message is routed to *that message's agent* (`fallbackAgent`) rather
than being re-classified or answered with a roster. A plain guild message with no @mention, and a reply
to somebody *else's* message, are both still ignored in full silence.

Pinned by `scripts/discord-ingress-test.cjs`.

### Addressing an agent

Discord has **no slash interception** — an unknown `/command` sends as plain text — so the Slack problem
that motivated the `/agentric` command does not exist here. The shared aliases apply anyway, since both
platforms route through the same front door: `@support-ops …`, `support-ops: …` and a bare
`support-ops …` all reach the agent, guarded on the first token being a real agent id.

## Egress

| Tool | Exposed when | Does |
|---|---|---|
| `discord_reply` | `DISCORD_REPLY=1` (Discord-triggered session) | replies in the bound thread/channel |
| `discord_send` | `DISCORD_EGRESS=1` (Discord configured) | posts to any channel by id |
| `discord_dm` | `DISCORD_EGRESS=1` | DMs any person by Discord user id |

Audit-only, no policy gate: `discord.send` / `discord.dm` `{ channel|to, id, chars }`. Discord is also a
carrier for approval/question/task DMs and the EOD digest (`digest_discord_channel`).

## Data model

```sql
CREATE TABLE IF NOT EXISTS discord_threads      (session_id PRIMARY KEY, channel, message_id, …);
CREATE TABLE IF NOT EXISTS discord_bot_messages (channel, message_id, session_id, …);  -- PK (channel, message_id)
```
`discord_threads` is bound at `createSession` and read back by `discord_reply` — one reply target per
run, keyed by the channel/thread. `discord_bot_messages` is the message-level index of everything an
agent said, so a reply to a threadless proactive post can still find the run behind it.

## Gotchas

- **MESSAGE_CONTENT is privileged.** Forget it and every message body is empty — the failure is silent,
  not an error.
- **No email → the identity map is mandatory** for per-member run-as. An unlinked person's runs act as the
  company, with the company's connectors.
- Sub-second gaps around a reconnect can drop events (no RESUME, by design).
- **The CDN URL expires.** Never store an attachment link and fetch it later — take the bytes at dispatch.
- **Binding a whole channel is not the Discord answer to Slack threading.** It would make every unrelated
  message in that channel continue the run; the reply reference is the narrow signal that replaces it.
