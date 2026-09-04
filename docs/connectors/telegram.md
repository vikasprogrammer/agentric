# Telegram connector

**Status:** shipped. **Kind:** ingress (long polling) + egress (reply).
**Code:** `src/connectors/telegram.ts` (Bot API client) · `src/edge/telegram-socket.ts` (poll loop +
dispatch) · `telegram_threads` (`src/state/db.ts`).

The third native chat channel, mirroring `DiscordSocket` one-for-one. One company bot from **@BotFather**,
one token, and the same trust model as Slack/Discord: the server dials **out**, so **no public URL** and
zero ingress.

## Why long polling

`getUpdates` holds an HTTPS connection open for up to `timeout` seconds (25 s here) and returns the next
batch. That keeps the posture identical to Socket Mode / the Gateway on a Tailscale-private box, and it is
*simpler* than both: no WebSocket, no heartbeat, no opcodes, no app-level token — just an abortable
in-flight request in a loop with 1 s → 30 s backoff on error. `offset` confirms everything below it (so
Telegram drops those from the queue) and asks for the next batch; startup does a `timeout=0` drain.

## Setup

Owner/admin, **Settings → Integrations → Telegram**: one bot token from @BotFather
(`telegram_bot_token`, `<botid>:<hash>`; `telegramConfigured()` = token present). `getMe` validates the
token and returns the bot's id + username (the id ignores its own/other bots' messages; the username
detects an @-mention in a group).

The socket registers per-agent slash commands with `setMyCommands` (`telegramCommandName(agentId)`), so
agents show up in Telegram's command menu.

**⚠ Group Privacy.** By default a Telegram bot in a group only sees messages that are commands (`/cmd`),
@-mention it, or reply to one of its messages. Mention/command ingress works either way — but **plain
follow-ups (thread continuity) require Group Privacy disabled in @BotFather**.

## Ingress

`parseTelegramUpdate` normalises an update into a `TelegramMessageEvent`. A message fires when it
@-mentions the bot in a group or is sent in a private chat. Run-as resolves the Telegram user id through
the **identity map** (`member_identities`, provider `telegram`) — Telegram exposes no email, so as with
Discord there is no email fallback; unmapped senders run as the company identity.

Then the usual: continuity first, then `telegram` automations, then the shared `/agent` router. The ack
**names the agent that picked the message up** (`chatAck`, shared with Slack and Discord) — where the
auto-router, not the sender, chose, an anonymous "On it" leaves the sender unable to tell who answered.

Audit: `telegram.connected` `{ botId, username }`; `trigger.telegram` per dispatch.

### Attachments (v0.419.0)

`parseTelegramUpdate` used to return **null for any message with no text**, and an uncaptioned photo is
the most natural way a person reports a bug — so the message was dropped whole, the worst version of this
defect across the four chat lanes. A message with no text but with files now routes.

Each media kind is its own top-level field (`photo`, `document`, `video`, `audio`, `voice`) and **`photo`
is an array of the same image at ascending sizes** — the last entry is the largest and the only one worth
reading. Telegram gives a photo no filename, so one is synthesized from its `file_unique_id`.

Telegram hands out an opaque **`file_id`, never a URL**, so every file costs a `getFile` before the bytes
can be fetched (≤5 files, ≤8 MB each, into the agent's own `.inbox/`). The resolved path is valid for
about an hour, which is why the bytes are taken at dispatch. ⚠ **The download URL embeds the bot token in
its path** (`/file/bot<token>/<path>`) — it must never be logged, put in an audit row, or shown to an
agent; only the bytes leave `downloadTelegramFile`. Audit: `telegram.file.received` / `.failed` /
`.skipped`. Pinned by `scripts/chat-attachments-test.cjs`.

## Threading

Telegram bots can't branch a thread off a message in a normal group (forum topics need admin rights), so
unlike Discord there is no per-mention thread. Replies go back into the **same chat**, as a reply to the
triggering message. Continuity is keyed on **chat id (+ forum topic id when present)** — the Discord
per-channel model:

```sql
CREATE TABLE IF NOT EXISTS telegram_threads (session_id, chat_id, message_thread_id, message_id, …);
CREATE INDEX idx_telegram_threads_chat ON telegram_threads (chat_id, message_thread_id);
```

## Egress

`telegram_reply` — exposed only on Telegram-triggered sessions (`TELEGRAM_REPLY=1`), routed via
`POST /api/agent/telegram/reply`. Chat + reply target come from the server-side binding; the agent sends
text only.

Messages are sent **without a `parse_mode`**, i.e. plain text — so `src/governance/chat-links.ts` renders
links as `label: url` for `telegram` (same as ClickUp) instead of masked markup.

## Gotchas

- **Group Privacy on = no continuity.** Only commands/mentions/replies reach the bot.
- **No email → the identity map is mandatory** for per-member run-as.
- Forum topics: continuity keys on `(chat_id, message_thread_id)`, so the same chat's topics stay separate.
- **The file download URL contains the bot token.** Never log it, audit it, or hand it to an agent.
- **`photo` is an array**, smallest-first. Taking `photo[0]` gets a thumbnail, not the screenshot.
