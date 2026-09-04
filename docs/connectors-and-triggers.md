# Connectors & Triggers — ingress, egress, and identity

> **Per-connector reference:** [`docs/connectors/`](./connectors/) documents each shipped native connector
> as built — Slack, Discord, Telegram, ClickUp, GitHub, Composio — with setup, ingress path, egress tools,
> data model, audit events and gotchas. Start there for "how do I wire up X"; this doc is the design
> history and the identity model behind all of them.

> **⚠ As-built note (2026-06-29).** This is the *original design spec*; the shipped implementation on
> `main` **diverged** and is the source of truth. Differences: chat ingress is **native Socket Mode
> (Slack) / Gateway (Discord)** over an outbound WebSocket — **not** the HTTP `POST /triggers/slack`
> adapters, signing-secret HMAC, or `alias`/`run_as` columns described below. Run-as is backed by the
> **`member_identities`** table (P1 — built, generalised to `slack|discord|email|github`), reached via
> `TeamStore.memberByExternalId`, **not** `slack_user_id` columns on `members`. Reply targeting uses
> the **`slack_threads` / `discord_threads`** tables + the `slack_reply` / `discord_reply` MCP tools,
> **not** a `term_sessions.reply_to` JSON column. **P1–P4 have all landed** (identity map, `runAs` seam,
> `shared` connectors, `directory_lookup`). Beyond the frozen plan, the shipped tree adds a **generic
> `/agent` chat router** (reach any agent by name with no automation) and **threaded replies** (Discord
> branches a real thread) — see *"Shipped (diverges from the HTTP-adapter design above)"* under Layer A.
> See `docs/v1-mvp-scope.md` (the live tracker) and the modules `src/edge/{slack,discord}-socket.ts` +
> `src/connectors/{slack,discord}.ts`. The reframe + use cases below remain the useful conceptual map.

The build spec for how Agentric talks to the outside world in **both directions**, and whose name is
on each action. Pairs with `docs/scoping-model.md` (what's scoped to whom) and
`docs/per-user-isolation-plan.md` (the uid mechanism that makes personal privacy *real*). This doc
supersedes the connector half of the scoping doc's Decision #2: the old "org vs personal" split was
conflating two unrelated planes. They are separated here.

## The reframe: two planes, one identity question

The old word "connector" smuggled together two opposite things. Split them:

- **Triggers (ingress)** — how the outside world *starts/feeds* an agent: a Slack slash command, a
  Slack DM, an inbound email, a ClickUp/webhook POST. **Company-owned**, configured once by
  owner/admin. This is what the "company Slack/Gmail bot" is really for.
- **Connectors (egress)** — what an agent *uses to act*: post to Slack, send email, read a repo.
  Already an MCP server materialised into the session's `.mcp.json` (`connectors.ts`), already
  passing the gate hook (`terminal/gate-hook.sh` matches `mcp__*`).

Every *egress* action is the same shape — an MCP tool call through the gate — so the only real
variable is **whose identity it acts as**, which is exactly the connector's class:

| Class | Identity | Example | Selection |
|---|---|---|---|
| **service** (today's `org`) | the company bot — one shared account | "Agentric posts to #status" | always present |
| **personal** | one member's own account | "email from user@…" | only in that member's runs |
| **personal + shared** | the *owner's* account, lent to the team | "use my Salesforce seat" | any run; acts as the owner |

The **company app is bidirectional**: the same Slack bot token that *receives* slash commands and
DM events (ingress) is the `service` Slack connector that *sends* notifications (egress). One app,
two directions. Likewise one Mailgun domain receives inbound mail and sends company-identity mail.

## Foundational primitives (build these once; all five use cases need them)

### P1 — Identity map `member ↔ {slack_user_id, email}`

New table; supports both directions (Slack user → member for run-as; member → Slack id/email for
addressing). Extensible to more providers.

```sql
CREATE TABLE IF NOT EXISTS member_identities (
  member_id   TEXT NOT NULL,
  provider    TEXT NOT NULL,          -- 'slack' | 'email' | 'github' | …
  external_id TEXT NOT NULL,          -- Slack U0123, email addr (lowercased), …
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ident_member ON member_identities(member_id);
```
`email` is already on `members` (the natural email-ingress key); the table adds `slack_user_id` etc.
`TeamStore` gains `memberByExternalId(provider, id)` and `externalIdsFor(memberId)`.

### P2 — `runAs` threaded into the spawn

Today `TerminalManager.createSession(agent, title, task, spawnedBy, headless)` derives the member
from `spawnedBy` (`terminal.ts:388`) and Composio scopes to that member's email (`:425`). A
*triggered* run currently passes `automation:<id>` → no member → service connectors only.

Add an explicit run-as so a triggered run can act as a person:

```ts
createSession(agent, title, task, spawnedBy?, headless?, runAs?: string /* member id */)
```
`buildMcpConfigJson` uses `runAs ?? memberOf(spawnedBy)` to select connectors. `spawnedBy` stays the
*provenance* (`automation:<id>` / member id) for inbox visibility; `runAs` is the *identity* for
connector selection and audit principal. When they differ, audit records both.

### P3 — `service` class + `shared` personal connectors

Storage stays `scope IN ('org','personal')` (no rename migration); **`org` ≡ the service/company
class**. Add a `shared` flag so a personal connector can be lent to the team:

```sql
-- ALTER (via ensureColumn, db.ts:236):
ALTER TABLE connectors ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
```

`ConnectorStore.boundTo` (`connectors.ts:297`) generalises:
```ts
private boundTo(c, runAs?) {
  if (c.scope !== 'personal') return true;        // service: everyone
  if (c.shared) return true;                       // shared personal: any run, acts as owner
  return !!runAs && c.ownerMemberId === runAs;     // private personal: owner only
}
```

**Composio user_id becomes per-connector, not per-session.** `composioUserId` (`terminal.ts:420`)
must scope each minted Tool-Router session to the *connector's* identity:
- private/shared **personal** → the connector's **owner** email (a shared connector still acts as
  its owner, never the borrower);
- **service** → a fixed entity, `service:<tenant>`.

### P4 — Directory lookup (OS tool)

A new tool in the OS MCP server (`src/memory/memory-mcp.ts`, alongside `recall`/`ask`/`report`):
`directory_lookup(name|email)` → `{ memberId, name, email, slackUserId }`, backed by a session-secret
loopback route `GET /api/agent/directory?q=` (same `x-aos-secret` auth as the other agent routes,
`server.ts:193`). Lets an agent resolve "DM Bob" / "email Bob" → a real handle without hardcoding.

## Layer A — Triggers (ingress)

Generalises `src/edge/automations.ts`. An **Automation** = agent + task template + trigger; we add a
**dispatch alias** so name-routed channels (Slack/email) can find it, plus a **run-as policy**.

```sql
ALTER TABLE automations ADD COLUMN alias   TEXT;     -- 'migration-agent' (Slack cmd / email local-part)
ALTER TABLE automations ADD COLUMN run_as  TEXT NOT NULL DEFAULT 'trigger-user';
                                                     -- 'trigger-user' | 'owner' | 'service'
```

**Adapters** (new `src/edge/triggers/{slack,email}.ts`), each a thin translator → `Automations.fire`:

| Channel | Route (public) | Auth | Dispatch | Identity (run-as) |
|---|---|---|---|---|
| Slack slash | `POST /triggers/slack` | Slack signing secret (HMAC, 5-min window) | command name → `automations.alias` | `command.user_id` → member (P1) |
| Slack DM/mention | `POST /triggers/slack/events` | signing secret + URL-verify challenge | conversational (see UC3) | DM author → member |
| Email | `POST /triggers/email` | Mailgun HMAC (`timestamp+token`, 5-min) | `aos+<alias>@` local-part → `automations.alias` | verified `sender` → member |
| Webhook (ClickUp) | `POST /hooks/<id>?key=` *(exists)* | per-automation secret | URL identifies the automation | `run_as` (no human) → `owner`/`service` |

**run-as resolution** (the bridge to Layer B):
```
resolve(trigger, automation):
  m = mapHuman(trigger)                      // P1: slack_user_id / verified sender → member
  if m and canRun(m, automation.agentId):    // existing TeamStore.canRun — triggers obey access!
     return m
  if automation.run_as == 'owner':  return automation.created_by
  if automation.run_as == 'service': return null   // service connectors + service Composio entity only
  reject("not permitted")                    // mapped human lacks access, or no fallback
```
This is the one thing agent-orch never did: it captured `command.user_id`/`sender` and threw them
away (anyone could trigger anything). We *use* them — both to pick connectors and to enforce
`canRun`.

**Reply path & continuity.** Sessions gain a reply context and threads get a resumable session:
```sql
ALTER TABLE term_sessions ADD COLUMN reply_to TEXT;   -- JSON: {channel,'slack'|'email', …targeting}
CREATE TABLE IF NOT EXISTS trigger_threads (
  channel      TEXT NOT NULL,      -- 'slack' | 'email'
  external_key TEXT NOT NULL,      -- slack channel+thread_ts | email Message-Id thread root
  agent_id     TEXT NOT NULL,
  member_id    TEXT,
  session_id   TEXT,
  claude_session_id TEXT,          -- for `claude -p --resume`
  created_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_key)
);
```
One-shot triggers (UC2/UC4): the agent's `report(outcome, summary)` tool, when the session has
`reply_to`, also posts the summary back to the Slack thread / email reply (extend
`/api/report` in `server.ts:295`). Conversational triggers (UC3/email-reply): each inbound message
runs a headless turn `claude -p --resume <claude_session_id>` and posts the model's answer back —
the agent-orch `emailSessions`/`clickupSessions` pattern, on our headless lane
(`HEADLESS=1`, `claude-launch.sh`).

### Shipped (diverges from the HTTP-adapter design above)

The tree implemented chat ingress **natively over outbound WebSockets**, not the `POST /triggers/*`
HTTP adapters sketched above — **Slack via Socket Mode** (`src/edge/slack-socket.ts`) and **Discord via
the Gateway** (`src/edge/discord-socket.ts`). No public URL, so a Tailscale-private box works. run-as
resolution still holds (P1 identity map → member, else company); `canRun` is enforced on the run-as
principal. Reply continuity uses `slack_threads` / `discord_threads` (channel + thread/message bound at
spawn) rather than the `trigger_threads`/`reply_to` columns above; the agent replies via the
`slack_reply` / `discord_reply` MCP tools.

**Generic `/agent` router (no automation needed).** This is the shipped generalisation of the "dispatch
alias" idea: when an inbound Slack/Discord message matches **no** automation, `Automations.routeChat`
parses a leading `/agent-name`. A known claude-code agent is spawned by `spawnChatAgent` — provenance
`chat:<agent>`, run-as the sender, thread-bound, every effect still gated, labeled "Chat · <agent> · as
<member>" on the Sessions page + Inbox. An unaddressed or unknown name posts a **help list** of available
agents back to the channel. A leading bot-mention (`<@BOTID>`) is stripped so the `/agent` prefix parses.
Workspace toggle `chatRouterEnabled` (Settings → Integrations, default on). So connecting the bot once
makes the whole fleet reachable **without** a per-agent automation — automations become optional
per-channel/mention overrides.

**Threading.** Slack replies thread on `thread_ts ?? ts`, so a mention starts (or continues) a thread.
Discord has no implicit threads, so a **guild @mention** branches a real thread off the user's message
(`startThread` in `src/connectors/discord.ts`); the ack + all `discord_reply` output stay inside it. DMs
have no threads → reply-reference in the DM; a thread-create failure falls back to the parent channel.

**Setup nicety.** The console renders a one-click Discord invite button — a bot's user id *is* its
application id, so once the Gateway connects (`discord.connected` records the READY guild count) the
invite URL is built automatically (no pasting the application id).

**Native ClickUp ingress (webhook, v0.260.0).** The webhook-source twin of the Slack/Discord chat path,
for the one channel that is genuinely a webhook rather than a socket. A ClickUp Automation ("comment
posted" → `POST /hooks/clickup?key=…&task_id={id}`) drives it: the route
(`server.ts`, in the PUBLIC block beside `/triggers/composio`) authenticates the `?key=` against the
workspace ClickUp webhook secret, then `ClickupIngress.dispatch` (`src/edge/clickup-ingress.ts`) fetches
the latest comment via the API (the Automation payload has no text), **loop-guards** its own bot
comments, resolves run-as (commenter email → member, `getMemberByEmail`), and either
`continueClickupThread` (a follow-up on a task bound in `clickup_threads` → resume) or `fireClickup` → the
same `/agentname` front door (`routeUnmatched`) — so `/agent-os <agent> <request>` (or the bare
`/<agent>`; the `/agent-os` namespace prefix is normalised away and works on every channel) reaches any agent with no
per-agent automation. The agent replies with the `clickup_reply` MCP tool (gated `CLICKUP_REPLY=1`),
which posts back on the bound task — never handed a task id. Config lives in **Settings → Integrations →
ClickUp** (API token + the generated hook URL to paste into ClickUp); a `clickup` automation trigger type
exists for per-task-scoped overrides. This is the in-platform replacement for the agent-orch
`/ceoagent` command — same idea, but every effect on the mediated gateway.

## Layer B — Connectors (egress)

Unchanged machinery (`connectors.ts` → `.mcp.json` → gate hook), plus P3. Selection at launch:
`(service connectors) ∪ (shared personal) ∪ (run-as member's own personal)`, each Composio connector
minted to its own identity (P3). **Personal connectors should prefer Composio** so no durable token
lands on disk — only a short-lived minted URL — which keeps the pre-Tier-A privacy gap small (see
scoping doc Decision #5).

### Sharing a single Composio app with the team (`composio_shares`)

The P3 `shared` flag above is per *connector row*. A **Composio** app isn't a connector row — it's a
connected account living on composio.dev under a `user_id` — so "make my Gmail available to the team"
needed its own mechanism. Two constraints, both verified against the live API:

- a connected account's **`user_id` is immutable** (`PATCH /api/v3/connected_accounts/{id}` exposes
  `alias`, credentials and the shared-ACL block — no owner field), so sharing **cannot be a move**;
- a Tool Router session may **only pin accounts belonging to its own `user_id`** ("Could not find
  connected account(s) … belonging to user …"), so a teammate's app can't be pulled into your session.

Hence sharing is a **local marker** (`composio_shares`: connection id, toolkit, owning entity) that the
launcher enforces. `ComposioShareStore.mintsFor(actingMember)` groups every OTHER member's shares by
owner, and `buildMcpConfigJson` mints one extra Tool Router session per owner — under **that owner's**
entity, but `{toolkits:{enable:[…]}, connected_accounts:{…}, manage_connections:{enable:false}}`. So a
borrower reaches exactly the shared connections, nothing else of that person's Composio account, and
cannot add or revoke connections under an entity that isn't theirs. Confirmed live: asked to "list files
in Google Drive", an unrestricted session offers `googledrive` tools while the borrowed one can only
offer the shared `gmail`.

Consequences worth keeping:
- **Nothing changes on composio.dev in either direction** — sharing and un-sharing are reversible and
  need no re-authorisation. `POST /api/connections/share {id, shared}`.
- **Sharing is owner-only and verified remotely** (the account must appear under the caller's own
  entity), so nobody publishes a teammate's — or the company's — connection by guessing an id.
- **Revoking is local-only and never gated on the key**, so a cleared/broken Composio key can't leave
  the team stuck with a share they can't take back. Owner or admin may revoke; only the owner may grant.
- A share dies with its connection (disconnect), with its owner (member removal), and is pruned when
  the account is revoked straight on composio.dev.
- An automation/system spawn (no run-as member) **does** get shared apps — same rule as a
  `personal + shared` connector: the owner opted in explicitly.

---

## The five use cases

### UC1 — Agent → Slack channel / DM a user *(egress, company identity)*
A **service** Slack connector holding the company bot token; fanned into every session, so the agent
gets `slack post`/`slack dm` tools acting as the company. Recipient resolved via **P4** (`directory_lookup`
→ `slackUserId`). Reuses the **same bot token** as the Slack ingress app (one app).
*Policy:* `mcp__slack__post_message` → gate classifies — `#agent-status` green, `@channel`/customer
channel yellow. *Alt (locked-down):* expose only `slack_notify(channel,text)` as an OS tool over a
loopback route, instead of the full Slack toolset. **Build:** add a `service` Slack connector; no new
transport. Net-new only if choosing the OS-tool alt.

### UC2 — Slack → agent, one-shot *(ingress)*
`/migration-agent <prompt>` → `POST /triggers/slack` (signing-secret verified) → dispatch by alias →
`fire` with **run-as = the Slack user mapped to a member** (P1/P2), gated by `canRun`. Ack
synchronously ("on it 👍"); result posts to the thread via UC1's service connector / `report`.
**Build:** Slack adapter + alias + run-as resolution.

### UC3 — Chat with an agent in Slack DMs *(ingress + continuity)*
Subscribe to Events API `message.im` on the same app → `POST /triggers/slack/events`. `trigger_threads`
binds `(slack, channel)` → a resumable session; first DM starts it, each later DM runs a headless
`--resume` turn and posts the reply. run-as = the D'Ming member → the agent gets **their** connectors
(your personal assistant with your Gmail). Which agent a DM talks to: default a per-member assistant
agent, switchable via `/use <agent>`. **Build:** Events subscription + URL-verify + `trigger_threads`
+ turn-per-message loop (most net-new of the five).

### UC4 — Trigger via email *(ingress — already designed)*
Mailgun inbound → `POST /triggers/email` (HMAC + 5-min), dispatch by `aos+<alias>@`, **run-as =
verified sender → member**, reply on-thread (`In-Reply-To`/`References` → `trigger_threads` resume,
same as UC3). **Build:** email adapter; reuses everything from UC2/UC3.

### UC5 — Agent emails an org user *from the managing member* *(egress, member identity)*
**Already solved by P2+P3.** A **personal** Gmail connector OAuth'd as the member via Composio
(`user_id` = their email) → the agent's `send_email` goes out *genuinely from* `you@example.com`
and lands in his real Sent — not a spoofed header. Recipient resolved via P4. run-as picks whose
Gmail. Fails closed if the member hasn't connected Gmail.
*Why not set `From:` on company Mailgun?* That's in-domain spoofing — survives DKIM only if aligned,
breaks "lands in their Sent," gives no real mailbox. The member's own mailbox is the honest impl, and
it's the entire point of personal connectors. *Policy:* internal recipient green; external yellow/red.
**Build:** none beyond P2/P3/P4 + the per-connector Composio user_id fix.

**UC1 vs UC5 is the proof of the model:** same verb ("send a message"), opposite identity — company
vs member — riding *one* connector+gate system, distinguished only by `scope` and run-as.

## Governance

Every egress (UC1, UC5) and every triggered run flows the gate hook → policy → audit, because each is
an `mcp__*` call — the thing agent-orch's `--permission-mode bypassPermissions` skipped entirely.
Rules key off capability id **and args** (the gate passes tool input), e.g.:
- `mcp__slack__post_message` to a non-status channel → `yellow`.
- `email.send` (Composio Gmail / `send_email`) where recipient domain ∉ org → `yellow`/`red`.
- Triggered runs additionally obey `canRun(runAsMember, agentId)` *before* firing.

## Security notes

- **Ingress auth is per-channel and non-negotiable:** Slack signing-secret HMAC (+5-min replay
  window), Mailgun HMAC over `timestamp+token` (+5-min), per-automation key for raw webhooks. Lift
  agent-orch's exact recipes (`src/webhooks/mailgun.ts`, Slack Bolt).
- **sender→member trust:** email mapping is only as trustworthy as SPF/DKIM/DMARC on the sender's
  domain — require alignment before honouring a verified-sender run-as; otherwise fall back to
  `owner`/`service`. Slack user ids are authenticated by the signed request.
- **A shared personal connector acts as its OWNER, never the borrower** (P3 mint rule) — surface this
  in the "Share with team" UI so a member knows lending = others act as them.
- **Pre-Tier-A caveat still holds:** until per-member uids (`per-user-isolation-plan.md`), a
  member's shell could read another's session files; Composio-minted personal connectors (no durable
  token on disk) are the interim softener. The existing non-admin custom-connector guard
  (scoping doc Decision #2) stays.

## Build order

1. **P1 + P2 + P3** — identity map, `runAs` seam, `shared` flag + per-connector Composio user_id.
   Unlocks UC2/UC4/UC5 and is pure groundwork (no external app yet). *Lowest risk; do first.*
2. **P4** — `directory_lookup` OS tool. Small; UC1/UC5 addressing.
3. **UC5** — verify member-identity email end-to-end (mostly falls out of 1–2).
4. **Slack service connector (UC1)** + **Slack slash adapter (UC2)** — first external app; one Slack
   app configured by owner/admin.
5. **Email adapter (UC4)** — Mailgun inbound + reply.
6. **Slack DM chat (UC3)** — Events API + `trigger_threads` + turn loop. Most new surface; last.

## Open decisions to confirm

- **Default `run_as`** — spec assumes `trigger-user` (map the human; fall back to `owner`). Confirm vs
  defaulting to `owner`.
- **UC3 agent binding** — a default per-member "assistant" agent vs. always require `/use <agent>`.
- **UC1 transport** — full service Slack connector (recommended) vs. narrow `slack_notify` OS tool.
- **Rename `org`→`service` in storage?** Spec keeps `org` to avoid a migration; relabel in UI only.
