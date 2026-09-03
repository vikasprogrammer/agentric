# ClickUp connector

**Status:** shipped (v0.260.0). **Kind:** ingress (webhook) + egress (comment).
**Code:** `src/connectors/clickup.ts` (API client) · `src/edge/clickup-ingress.ts` (dispatcher) ·
`/hooks/clickup` + `/api/agent/clickup/reply` (`src/server.ts`) · `clickup_threads` (`src/state/db.ts`).

ClickUp is the one native chat-like channel that is genuinely a **webhook**, not a socket. Slack dials
out over Socket Mode, Discord over the Gateway, Telegram long-polls — ClickUp has none of those, so a
ClickUp **Automation** POSTs to us instead. Everything downstream (run-as, `/agentname` routing, thread
continuity, the gate, audit) is the same machinery the socket channels use.

The product point: this is the in-platform replacement for the old agent-orch `/ceoagent` ClickUp
command — same "comment at an agent on a task" ergonomics, but every effect rides the mediated gateway.

## Setup

Owner/admin, **Settings → Integrations → ClickUp**:

1. **API token** — a ClickUp personal or team token (`pk_…`). One company token, shared workspace-wide;
   it both reads the triggering comment and posts the agent's replies.
2. **Webhook secret** — generated for you the moment a token is saved (`crypto.randomBytes(24)` hex) if
   one isn't already set. The console then shows the full hook path to paste into ClickUp.
3. In **ClickUp**, create an Automation on the space/folder/list you want covered:
   - *When*: **Comment posted**
   - *Then*: **Call webhook** → `POST https://<your-host>/hooks/clickup?key=<secret>&task_id={{task.id}}`

There is nothing to dial and nothing to restart — the integration is live as soon as the Automation
exists. Clearing the API token removes every `clickup` automation (the server reports
`removedClickupAutomations`).

Settings keys: `clickup_api_token`, `clickup_webhook_secret` (`src/governance/settings.ts`). Neither
value is ever returned by the API — `clickupMeta()` reports only presence + who last touched it, and the
integrations view returns a redacted hint.

## How an inbound comment becomes a session

`POST /hooks/clickup` sits in the **public** route block (it authenticates itself via `?key=`), placed
*before* the generic `/hooks/<id>` so the literal `clickup` isn't read as an automation id. Missing or
wrong key → 503/401; no `ClickupIngress` on the runtime → 503.

`ClickupIngress.dispatch(taskId, payload)` then:

1. **Fetches the comment.** The ClickUp Automation payload carries **no comment text**, so we call
   `GET /task/{id}/comment` and take the newest (`fetchLatestComment`).
2. **Loop-guard.** A comment id we already acted on or posted ourselves is skipped. Deliberately keyed on
   **comment id, not the token's user id** — the API token is usually a *personal* token, so the human
   running `/agentname` often *is* the token user; guarding by user id silently swallowed their commands
   (a real bug). The `handled` set is bounded (500 → trimmed to 300).
3. **Command gate, before continuity.** A ClickUp task's comment section is a **shared space**, not a
   dedicated bot thread, and every comment on a covered task fires the webhook. So only a comment matching
   `/^\s*\/[A-Za-z0-9]/` acts; anything else is `not a command` and is never delivered into a bound
   session. This also drops our own acks and replies for free.
4. **Marks handled, then reacts 👀.** The comment id is remembered *before* dispatch so a racing duplicate
   webhook can't double-spawn. The acknowledgement is an `eyes` reaction on the triggering comment, not an
   "on it" comment — quieter, and it can't re-trigger anything. ⚠ ClickUp wants the emoji **shortcode**
   (`eyes`), not the unicode character.
5. **Resolves run-as.** Commenter email → `TeamStore.getMemberByEmail` → that member. The session then runs
   as the actual human (their personal connectors, their inbox). Unmapped → the company identity. Same
   shape as Slack's user→email→member mapping.
6. **Continuity first.** `Automations.continueClickupThread` looks up the newest session bound to this task
   (`clickup_threads` → `TerminalManager.sessionForClickupThread`) and resumes that transcript rather than
   re-triggering. A still-busy agent gets a "pick this up next" note instead of an overlapping run.
7. **Else routes.** `Automations.fireClickup` fires every enabled `clickup` automation whose `filter`
   matches the task id (`''` / `*` = any); with no match it falls through to `routeUnmatched` — the shared
   `/agent` front door. So `/agent-os <agent> <request>`, or the bare `/<agent> <request>`, reaches any
   agent **with no per-agent automation**. (The `/agent-os` namespace prefix is normalised away and works
   on every channel.) A help-list / disambiguation reply is posted as a comment, and its id is remembered
   so the webhook it triggers is skipped.

The generated task prompt (`fireClickup`) tells the agent to fetch the full task first — on ClickUp the
**task description** usually holds the real request and the comment is just the trigger.

### Attachments (v0.419.0)

`comment_text` is the **flattened** text: a screenshot dropped on a task leaves no trace in it at all, so
the files live only in the structured `comment` block array (`{ type: 'attachment', attachment: {…} }`)
and, on some payload shapes, a sibling `attachments` array. `parseClickupAttachments` reads both and
de-duplicates by id; `downloadClickupFile` fetches the bytes (≤5 files, ≤8 MB each) into the agent's own
**`.inbox/`**, and `attachmentNote` names each by the relative path it will have.

The presigned URL needs **no Authorization header** — and must not be sent one, since the API token has no
business reaching the attachment host — but it **expires**, which is why the bytes are taken at dispatch
rather than handed to the agent as a link. Host-checked against `*.clickup.com`. ClickUp's `title` usually
drops the extension, so it is re-appended from `extension` — an agent needs to know it is looking at a
`.png`. Audit: `clickup.file.received` / `.failed` / `.skipped`.

### What ClickUp deliberately does NOT get

The Slack/Discord fix for *untagged* replies does not transfer. There, a thread the bot opened is **ours**,
so having spoken in it is a safe targeting signal. A ClickUp task's comment section is a **shared human
workspace** that happens to have an agent in it: acting on every comment would spawn a run per comment on
every covered task. The `/command` gate stays the addressing rule, and it is the reason the loop-guard can
be as simple as it is.

The ack follows the same logic. A dispatch the commenter **steered** (`/support-ops …`) still posts no
"on it" comment — the 👀 reaction is enough and a second comment is noise on a shared task. But when the
**router** picked the agent (an automation, an auto-route, a resolved disambiguation) the commenter has no
way to know who took it, so that case posts a one-line `chatAck` naming them. Pinned by
`scripts/chat-attachments-test.cjs`.

Audit: `trigger.clickup` `{ task, status, sessions }` on every inbound POST, whatever the outcome.

## How an agent replies

`clickup_reply` — an MCP tool exposed **only** on ClickUp-triggered sessions (`CLICKUP_REPLY=1`, set by
`TerminalManager.launchAgentRuntime` when the session has a bound task). It takes text only:

```
clickup_reply({ text })  →  POST /api/agent/clickup/reply  →  ClickupIngress.reply(sessionId, text)
```

The task id comes from the server-side `clickup_threads` binding written at `createSession`, so the agent
never supplies — and cannot spoof — a task id. A non-ClickUp session has no binding and gets
`no ClickUp task bound to this session`. The reply's own comment id is remembered (loop-guard), so posting
doesn't re-trigger the ingress.

ClickUp comments are **plain text** — no markdown. `src/governance/chat-links.ts` renders links as
`label: url` for `clickup` (and `telegram`) rather than masked markup.

Audit: `clickup.reply` `{ task, chars }` / `clickup.reply.failed` `{ task, error }`. Never the body.

## Data model

```sql
CREATE TABLE IF NOT EXISTS clickup_threads (
  session_id TEXT, task_id TEXT, comment_id TEXT, created_at INTEGER
);
```
The ClickUp analogue of `slack_threads` / `discord_threads` / `telegram_threads`: the **task id is the
thread key** (the natural ClickUp "thread"), bound at spawn, read back by `clickup_reply` and by
`sessionForClickupThread` for continuity.

## Automations

A `clickup` trigger type exists (`Automation.type`) for **per-task-scoped overrides** — its `filter` is
matched against the task id (`''` / `*` = any). It is optional by design: the `/agent` router already
makes the whole fleet reachable, so automations are the exception, not the setup step.

## API surface (`src/connectors/clickup.ts`)

All calls use the global `fetch` (Node 22+), return `{ error }` instead of throwing, and hit
`https://api.clickup.com/api/v2`.

| Function | ClickUp endpoint | Used for |
|---|---|---|
| `fetchLatestComment(token, taskId)` | `GET /task/{id}/comment` | ingress enrichment (webhook has no text) + attachments |
| `parseClickupAttachments(comment)` | — | pull files out of the comment blocks (`comment_text` hides them) |
| `downloadClickupFile(url, maxBytes)` | the presigned attachment URL | fetch the bytes before the link expires |
| `addComment(token, taskId, text)` | `POST /task/{id}/comment` | the agent's reply + router help text |
| `addReaction(token, commentId, 'eyes')` | `POST /comment/{id}/reaction` | the 👀 "picked it up" ack |
| `authedUser(token)` | `GET /user` | Settings "test connection" |
| `taskUrl(taskId)` | — | `https://app.clickup.com/t/<id>` deep-links |

## Gotchas

- **The Automation payload has no comment text.** Anything that needs the body must re-fetch it. That's
  also why the hook URL must carry `task_id={{task.id}}`.
- **Guard by comment id, not user id** — personal tokens make the operator and the bot the same ClickUp
  user (see step 2).
- **Only `/command` comments act.** Plain task chatter is intentionally ignored; a ClickUp task comment
  section is shared with humans who are not talking to an agent.
- **Reactions take shortcodes**, not emoji characters.
- **Plain text only** — markdown will render literally in a ClickUp comment.
- **`comment_text` hides attachments.** A comment can carry a screenshot and read as pure text; only the
  structured `comment` blocks show it.
- **The attachment URL expires.** Never store one and fetch it later — take the bytes at dispatch.
- Digest reference-extraction treats `86xxxxxxx`-shaped ids as ClickUp tasks (`src/edge/digest.ts`).
