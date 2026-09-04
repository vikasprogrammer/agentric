# Native connectors — reference

How Agentric talks to the outside world, connector by connector. Each page documents the **as-built**
integration: setup, ingress path, egress tools, data model, audit events, and the gotchas that already
bit us.

| Connector | Ingress | Egress | Public URL needed? | Page |
|---|---|---|---|---|
| **Slack** | Socket Mode (outbound WS) | `slack_reply`, `slack_send`, `slack_dm`, digest, DMs | no | [slack.md](slack.md) |
| **Discord** | Gateway (outbound WS) | `discord_reply`, `discord_send`, `discord_dm`, digest, DMs | no | [discord.md](discord.md) |
| **Telegram** | long polling (`getUpdates`) | `telegram_reply` | no | [telegram.md](telegram.md) |
| **ClickUp** | webhook (`POST /hooks/clickup`) | `clickup_reply` | **yes** | [clickup.md](clickup.md) |
| **GitHub** | — (credential source) | `GH_TOKEN` in the shell + API bearer; `github_refresh` | no | [github.md](github.md) |
| **Composio** | webhook (`POST /triggers/composio`) | the SaaS long tail, via a minted Tool Router URL | for triggers only | [composio.md](composio.md) |

Design history and the five original use cases live in [`../connectors-and-triggers.md`](../connectors-and-triggers.md)
— note its as-built banner: the shipped tree diverged from that spec, and these pages are the current
source of truth.

## Two planes

The word "connector" used to smuggle together two opposite things. They are separate here:

- **Ingress (triggers)** — how the outside world *starts or feeds* an agent: a Slack mention, a Discord
  DM, a Telegram command, a ClickUp comment, a Composio webhook. Company-owned, configured once by an
  owner/admin.
- **Egress (connectors)** — what an agent *uses to act*: post a message, send mail, read a repo. Always an
  MCP tool call materialised into the session's `.mcp.json`, always through the gate hook.

The company app is usually **bidirectional**: the same Slack bot token that receives events is the
identity that posts.

## What every native channel shares

**One company app, per-member identity.** Each channel is configured once, workspace-wide. Per-member
behaviour rides on top of that single app: every inbound event names a sender, which is resolved to an
Agentric member and becomes the run's **run-as** identity (their personal connectors, their inbox), with
`canRun` enforced on that principal. Resolution order differs by channel:

| Channel | Sender → member |
|---|---|
| Slack | identity map (`slack`) → Slack profile **email** → `getMemberByEmail` |
| Discord | identity map (`discord`) only — a bot cannot read a user's email |
| Telegram | identity map (`telegram`) only — no email exposed |
| ClickUp | commenter **email** → `getMemberByEmail` |

Unmapped senders fall back to the company identity. The map is `member_identities`
(`IDENTITY_PROVIDERS = slack | discord | telegram | email | github`), edited on the Team page under
**Chat IDs**, one handle per provider, PK `(provider, external_id)`.

**Run-as vs provenance.** A session row separates `spawned_by` (provenance — `automation:<id>`,
`chat:<agent>`, or the console member) from `run_as` (the identity it acts under). A chat-triggered run is
owned by the automation for provenance yet acts as — and is visible to — the human who sent the message.

**The `/agent` router — automations are optional.** When an inbound message matches no automation,
`Automations.routeChat` / `routeUnmatched` parses a leading `/agent-name` and spawns that agent as a
one-off governed run. `/agent-os <agent> <request>` and the bare `/<agent> <request>` both work, on every
channel (the `/agent-os` namespace prefix is normalised away). An unaddressed or unknown name posts a help
list back. Toggle: `chatRouterEnabled` (Settings → Integrations, default on). So connecting a bot once
makes the **whole fleet** reachable; per-channel automations become overrides.

**Thread continuity.** A follow-up on a bound thread resumes the *same* transcript
(`claude --resume`, pinned via `term_sessions.claude_session_id`) instead of re-triggering. One binding
table per channel, all written at `createSession` and all read back by the reply tool so the agent never
supplies — or can spoof — a destination:

| Channel | Table | Thread key |
|---|---|---|
| Slack | `slack_threads` | channel + `thread_ts` |
| Discord | `discord_threads` | the branched thread (or channel/DM) |
| Telegram | `telegram_threads` | chat id (+ forum topic id) |
| ClickUp | `clickup_threads` | task id |

**Governance.** Every egress is an `mcp__*` call through the gate hook → policy → audit. Triggered runs
additionally obey `canRun(runAs, agentId)` before firing. The reply/send tools are session-secret-gated
loopback calls to `/api/*` routes that sit **before** the member-auth gate — see
[`../agent-mcp-tools.md`](../agent-mcp-tools.md) for the tool ↔ route ↔ store matrix. Chat egress is
audit-only, no policy gate (`slack.send`, `slack.dm`, `discord.send`, `discord.dm`, `clickup.reply`).

**Out-of-band notifications** — approvals, agent questions, task events, login links, the EOD digest —
resolve recipients in exactly one place, `resolveRecipients(os, audience)` in
`src/governance/recipients.ts` (`approvers` / `admins` / `member` / `sessionOwner`), and share `deliverDM`
(identity map → `dmUser`). Never re-derive members in a new notifier.

**Zero dependencies.** Every client uses the global `fetch` / `WebSocket` (Node 22+). No `ws`, no vendor
SDK. Every call returns `{ error }` rather than throwing, so a flaky network degrades gracefully.

## Generic MCP connectors

Beyond the native six, `src/connectors/connectors.ts` stores arbitrary MCP servers materialised into each
session's `.mcp.json`:

- **Transport** — `stdio` (a local launch command + `env`) or `http` / `sse` (a URL + `headers`).
- **Scope** — `org` (company-wide, one shared identity, fanned into every member's sessions) or `personal`
  (`ownerMemberId`; injected only into that member's own sessions), plus the `shared` flag that lends a
  personal connector to the team **acting as its owner**.
- **Composio is the exception**: `mintsUrl('composio')` is true, so its URL is minted per launch rather
  than stored.

Credentials for stored connectors live in the gitignored data home, not the repo. A multi-tenant
deployment should move those values into the vault.
