# Slack connector

**Status:** shipped. **Kind:** ingress (Socket Mode) + egress (reply, proactive send/DM, digest, DMs for
approvals/questions/tasks/login links).
**Code:** `src/connectors/slack.ts` (API client) · `src/edge/slack-socket.ts` (connection + dispatch) ·
`slack_threads` (`src/state/db.ts`).

One company Slack app serves the whole workspace in **both directions**: the same bot token that receives
events is the identity that posts. Per-member behaviour rides on top of that single app — each inbound
event names the Slack user, which is how a run gets the right human's identity.

## Why Socket Mode

The Node server dials **out** to Slack over a WebSocket (`apps.connections.open` → a single-use `wss://`
URL). **No public URL, no inbound port** — a Tailscale-private or on-prem box that can reach
`*.slack.com` outbound works with zero ingress. Reconnects use 1 s → 30 s backoff, and a `generation`
counter makes a stale socket's handlers no-op after a token change or restart. Zero dependency: the
global `WebSocket` (Node 22+), no `ws` package.

## Setup

Owner/admin, **Settings → Integrations → Slack**. Two tokens:

| Setting key | Token | Needed for |
|---|---|---|
| `slack_app_token` | app-level `xapp-…` (`connections:write`) | opening the Socket Mode connection |
| `slack_bot_token` | bot `xoxb-…` | `chat.postMessage`, `users.info`, `conversations.*` |

`slackConfigured()` requires **both**. The console's Integrations page carries the app **manifest** with
the current scope list — an app created before a scope was added needs the scope added *and* a reinstall.
DMs specifically need `im:write`. The socket re-dials automatically when either token changes.

Event subscriptions: `app_mention` covers @mentions. Plain in-thread replies and channel-watch messages
only arrive if the app also subscribes to `message.channels` / `message.groups` / `message.im` **and** the
bot is in the channel.

## Ingress — mention, DM, or watched channel

For each inbound user message the socket:

1. **Strips a leading bot mention** (`<@BOTID>`) so an `/agent` prefix parses.
2. **Resolves run-as** — the identity map (`member_identities`, provider `slack`) first, then the Slack
   profile **email** → `getMemberByEmail`. Unmapped → the company identity. `canRun` is enforced on the
   resolved principal.
3. **Acks in-thread immediately**, threading on `thread_ts ?? ts` — so a mention starts a thread.
4. **Continuity first** — a follow-up inside a thread already bound in `slack_threads` continues *that*
   conversation: `Automations.continueSlackThread` finds the newest session for `channel`+`thread_ts`
   (`TerminalManager.sessionForSlackThread`) and spawns a run that `claude --resume`s the **same
   transcript**. A busy agent gets a "pick this up next" note rather than an overlapping run. This needs
   the pinned claude id — unattended runs launch with `--session-id $CLAUDE_SESSION_ID`, stored in
   `term_sessions.claude_session_id`.
5. **Else fires `slack` automations**, then falls through to the shared `/agent` router.

Audit: `slack.connected` `{ botUserId }` on READY; `trigger.slack` per dispatch.

### Filters and channel watch (v0.390.0)

A `slack` automation's `filter` is `<scope> [when …] [unless …]`:

- **scope** — exact event type or channel id; `''` / `*` = any.
- **clauses** — the `webhook-ingress.ts` predicate grammar (`evaluatePredicates`) over the Slack event,
  with `text` = the mention-stripped body and `actor` = the resolved sender.

Naming a **channel id** also turns the automation into a **channel watch**: the socket stops dropping
non-mention messages there and calls `fireSlack(…, { channelWatch: true, router: false })`. Deliberately
narrow — only an *exactly channel-scoped* automation is woken (a `*` scope quietly eating every message in
every channel would multiply a live tenant's spend with nobody having edited anything), and the `/agent`
router never runs on a watch. Bot-posted messages are always dropped (`ev.fromBot`); an integration that
*posts* reports belongs on a webhook automation instead.

Slack filters are validated **at save time** — the predicate layer fails open at runtime, so that is the
only place a typo is caught. Pinned by `scripts/slack-content-filter-test.cjs`.

## Egress

| Tool | Exposed when | Does |
|---|---|---|
| `slack_reply` | `SLACK_REPLY=1` (Slack-triggered session) | replies on the bound thread — no channel id passed |
| `slack_send` | `SLACK_EGRESS=1` (Slack configured) | posts to **any** channel by id or name, auto-joining public channels |
| `slack_dm` | `SLACK_EGRESS=1` | DMs **any** person by Slack user id or email |

`slack_send`/`slack_dm` are proactive: off-thread, unattended, no policy gate — audit only
(`slack.send` / `slack.dm` with `{ channel|to, ts, chars }`), the same posture as `slack_reply`.

Slack is also the default carrier for out-of-band notifications: approval cards
(`setApprovalNotifier` → `notifyApprovers`), agent questions (`setQuestionNotifier`), Task events
(`notifyTaskEvent`), self-service login links (`notifyLoginLink`), and the end-of-day fleet digest
(`digest_enabled` + `digest_channel` + `digest_hour`). Every one resolves its recipients through the
single `resolveRecipients(os, audience)` in `src/governance/recipients.ts` and shares `deliverDM`.

## Data model

```sql
CREATE TABLE IF NOT EXISTS slack_threads (session_id, channel, thread_ts, …);
```
Bound at `createSession`; read back by `slack_reply` and by `sessionForSlackThread` for continuity.

## Gotchas

- **App Home → Messages Tab must be enabled** or the bot cannot receive or reply to DMs — check this
  before debugging DM routing.
- **Scopes are add-then-reinstall.** An older app silently lacks any scope added since it was installed.
- **`app_mention` is not enough for threads.** Plain replies need `message.*` subscriptions *and* the bot
  in-channel.
- A `*`-scoped automation is not a channel watch — only an exact channel id is (by design).
