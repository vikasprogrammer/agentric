# Composio connector

**Status:** shipped. **Kind:** egress tool-hub (hundreds of SaaS apps) + webhook ingress.
**Code:** `src/connectors/composio.ts` (mint + API) · `src/connectors/composio-shares.ts` (team sharing) ·
`src/connectors/connectors.ts` (the generic connector store) · `POST /triggers/composio` (`src/server.ts`).
**See also:** `docs/composio-connection-request-plan.md`,
`docs/tool-marketplace-eval-monid-vs-composio.md`.

Composio is how an agent reaches the long tail of SaaS — Gmail, Google Drive, Linear, Notion, Salesforce
and the rest — without Agentric shipping a client per app. It is also **the one connector whose endpoint
is minted, not stored.**

## The mint

A Slack/GitHub stdio connector has a fixed launch command; a generic remote connector has a fixed URL.
Composio's **Tool Router** is different: the MCP endpoint is a **per-user, pre-signed session URL**
created on demand by POSTing the user's id to Composio's API. So the workspace only ever stores the
**Composio API key**; at each session launch we exchange it — **scoped to the launching identity** — for
a fresh session URL and write *that* into the per-session `.mcp.json`.

Two transports for the same mint (`mintsUrl(type)` is true only for `composio`):
- `mintToolRouterSession` — blocking `curl` (mirrors `terminal/gate-hook.sh`), for callers already off the
  hot path;
- `mintToolRouterSessionAsync` — `fetch`, for the session-launch path. Blocking the event loop for ~1.5 s
  per launch stalled every other request on this single-threaded server.

The API key is read case-insensitively out of the connector's `x-api-key` header (`apiKeyOf`).
`COMPOSIO_API_BASE` overrides the endpoint so tests can point at a local stub.

## Whose identity a mint runs as

The Composio `user_id` is **per connector, not per session**:

| Connector class | Composio `user_id` |
|---|---|
| **service** (stored `scope = 'org'`) | a fixed entity — `serviceUserId(tenant)` = `service:<tenant>` |
| **personal** (private or shared) | the connector **owner's** email — a shared connector still acts as its owner, never the borrower |

Selection at launch is `(service) ∪ (shared personal) ∪ (run-as member's own personal)`. Personal
connectors should prefer Composio precisely because **no durable token lands on disk** — only a
short-lived minted URL.

## Sharing one connected account with the team (`composio_shares`)

Two facts, both verified against the live API, force the design:

- a connected account's **`user_id` is immutable** — there is no transfer API, so sharing cannot be a move;
- a Tool Router session may **only pin accounts belonging to its own `user_id`** ("Could not find connected
  account(s) … belonging to user …"), so a teammate's app cannot be pulled into your session.

So sharing is a **local marker** — `composio_shares` holds `(connection id, toolkit, owning entity,
owner member, name, sharedBy)` — that the launcher enforces. `ComposioShareStore.mintsFor(actingMember)`
groups every *other* member's shares by owner, and `buildMcpConfigJson` mints **one extra Tool Router
session per owner**: under that owner's entity, but restricted to
`{ toolkits: { enable: […] }, connected_accounts: { … }, manage_connections: { enable: false } }`.

A borrower therefore reaches exactly the shared connections and nothing else of that person's Composio
account, and cannot add or revoke connections under an entity that isn't theirs. Verified live: asked to
"list files in Google Drive", an unrestricted session offers `googledrive` tools while the borrowed one
can only offer the shared `gmail`.

Consequences worth keeping:

- **Nothing changes on composio.dev in either direction** — sharing and un-sharing are reversible and need
  no re-authorisation (`POST /api/connections/share {id, shared}`).
- **Granting is owner-only and verified remotely** (the account must appear under the caller's own entity),
  so nobody publishes a teammate's — or the company's — connection by guessing an id.
- **Revoking is local-only and never gated on the key**, so a cleared or broken Composio key can't leave
  the team stuck with a share they can't take back. Owner *or* admin may revoke; only the owner may grant.
- A share dies with its connection, with its owner (member removal), and is pruned when the account is
  revoked straight on composio.dev.
- An automation/system spawn (no run-as member) **does** get shared apps — the owner opted in explicitly,
  the same rule as a `personal + shared` connector.

## Console routes

`GET /api/composio/toolkits` (`listToolkits`) · `GET /api/connections` (`listConnectedAccounts`) ·
`POST /api/connections/connect` (`initiateConnection`) · `POST /api/connections/disconnect`
(`deleteConnectedAccount`) · `POST /api/connections/share` · `GET /api/connections/requests` (an agent
asking a human to connect an app it needs).

Settings keys: `composio_api_key`, `composio_webhook_secret`.

## Ingress — `POST /triggers/composio`

Composio is also the **webhook ingress lane** (Slack/Discord/Telegram are socket-native; ClickUp is its
own webhook). The route verifies the payload against the workspace webhook secret
(`verifyComposioWebhook`, HMAC + `timingSafeEqual`), normalises it (`parseComposioEvent` →
`{ triggerSlug, toolkit, … }`), and `Automations.fireComposio` dispatches it to matching `composio`
automations. Audit: `trigger.composio` `{ trigger, toolkit, fired }`.

## Governance

Every Composio tool call is an `mcp__*` call, so it hits the gate hook → policy → audit like everything
else. Rules key off the capability id **and** the args (the gate is handed the tool input), e.g.
`email.send` to a recipient outside the org → `yellow`/`red`.

### The envelope (`src/capabilities/composio-envelope.ts`)

That only holds because the gate **unwraps the Tool Router envelope first**. However many apps an entity
has connected, a minted session exposes exactly **six** meta-tools — verified against the live endpoint:

| Meta-tool | What it really is | Governed as |
|---|---|---|
| `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_GET_TOOL_SCHEMAS` | discovery, read-only | left alone |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | runs 1–50 real tools by slug | the real slug (`GMAIL_SEND_EMAIL` → `email.send`, `STRIPE_REFUND` → `payments.refund`, …) |
| `COMPOSIO_REMOTE_BASH_TOOL` | arbitrary bash on Composio's sandbox | `shell.exec` + `composioRemote` |
| `COMPOSIO_REMOTE_WORKBENCH` | arbitrary Python on a persistent sandbox | `shell.exec` + `composioRemote` |
| `COMPOSIO_MANAGE_CONNECTIONS` | initiates — or with `reinitiate_all`, **replaces** — an OAuth connection | `connector.connect` |

So `args.tool` is always the envelope's name and the real action lives at `input.tools[].tool_slug`.
Before the unwrap, every plane that keys on `args.tool` was reading the wrapper: `resolveCapability`
never fired, the enricher never set `emailSend` so recipients were never judged, and the approval card
read *"Write to Composio multi execute tool"*. The unwrap runs in `TerminalManager.gate` (and mirrored in
`policyCheck`) **before** `enrichArgs`, so it covers claude-code, codex and opencode at once — all three
hooks post the same `{tool, input}` to `/api/gate`. It emits `gate.composio.unwrapped`.

Two things worth knowing about it:

- **A batch is governed at the risk of its worst member.** `tools` takes up to 50 actions but the gate
  returns one verdict (one capability, one approval card, one `gateId` — the hook polls exactly one), so
  collapsing is forced. Every slug is recorded on `composioActions` and the brief names the rest, so an
  approver is never shown one action and given many.
- **The two remote-code envelopes cannot be unwrapped to a named action** — the workbench's Python can
  call `run_composio_tool(tool_slug=…)`, i.e. any Composio action, from inside a string. They are
  governed as the code execution they are, and carry `composioRemote: true` so a workspace can write one
  rule for remote execution as a class. Their auto-approve signature is namespaced separately, so an
  "always approve" for a local command can never clear the same command on Composio's sandbox.

## Whose account is it, really? (`src/connectors/composio-identity.ts`)

**A Composio `user_id` is a SHELF, not an identity.** `service:<tenant>` means "the company's shelf"
and an email means "that member's shelf" — neither says which third-party account was actually OAuth'd
onto it. On expresstech the *company* Google Sheets connection turned out to be one teammate's personal
Google account, so an agent acting "as the company" created a spreadsheet in that person's Drive, and
nothing anywhere said so: the console displayed the opaque `googlesheets_seba-artal`.

It cannot be read off the connection record — `data.id_token` and every other credential field come
back as the literal string `REDACTED`. But the Tool Router discloses it: `COMPOSIO_MANAGE_CONNECTIONS`
with a toolkit list returns `results[<toolkit>].current_user_info` (`{ email, … }` for Google, the
account object for Stripe, a `login` for GitHub-likes). That is cached in **`composio_identities`** and
surfaced in three places:

- the **console** — a row reads `googlesheets — zubair@expresstech.io`, not a word-id;
- every agent's **prompt** — `TerminalManager.composioContext` lists each namespace, whose shelf it is,
  and the resolved account per app, plus the instruction to `ask` rather than act when the account that
  would act is not the one the task implies;
- `GET /api/connections`, as `account` on each row.

> ⚠ **Never probe a toolkit with no ACTIVE connection.** `COMPOSIO_MANAGE_CONNECTIONS` does not report
> "none" for one — it **initiates** a connection and returns an OAuth link. `activeToolkits()` derives
> the probe list from a `listConnectedAccounts` result and is the only supported way to build it.

The refresh is a mint plus two MCP round trips per entity, so it is deliberately **off the launch path**:
a launch fires it in the background at most every 6h per entity (`composioIdentityStale`), the console's
**Check accounts** button runs it on demand, and a session never waits on it. A failed probe degrades to
"we learned nothing this time" — it never blanks a label already cached, because "unknown" and "wrong"
are very different things for a prompt to say.

### The prompt is the point

Before this, an agent saw two indistinguishable MCP servers called `composio` and `composio-company`,
and the Tool Router auto-selects tools by relevance — so **which identity acted was decided by ranking,
not intent**. The same live run that created the sheet under a teammate's Google account then sent mail
through `composio` (the run-as member's own Gmail), because the company shelf had no Gmail at all. Both
were reasonable guesses from a name alone. Names are not identities, so the prompt states the identities.

## Expired connections — mark, tell, and prune only what is superseded

An expired connection is silent by construction: the agent finds the app missing and works around it.
Company ClickUp on expresstech had three expired accounts and **zero** live ones for two weeks with
nothing anywhere saying so.

- **Status is cached on every refresh**, and a newly-expired connection posts a `connection.expired`
  card (audited `connector.expired`) to whoever can reauthorise it — the shelf's member, or the admins
  tier for the company shelf. Deduped per connection for a week. The card distinguishes the two cases,
  because only one needs anyone to act: *reconnected already, this is the old row* vs *nothing else is
  connected for this app, so agents cannot use it at all*.
- **The console** shows an expired row with a **Reconnect** button (the same hosted OAuth), and hides
  the "Share with team" control — lending out a dead account helps nobody.
- **`POST /api/connections/prune`** (owner/admin) deletes only **superseded** expired connections: an
  expired account for an (entity, toolkit) that also has a live one, older than 7 days. Reconnecting
  leaves the old row behind, and those rows are the real clutter.

> **Why not delete every expired connection.** An expired connection with no live replacement is the
> only record that a capability is missing. Sweeping it away would erase precisely the thing that tells
> a human to reconnect, turning a visible to-do into a silent gap — which is the failure mode this whole
> section exists to fix.

## Gotchas

- **The endpoint is minted per launch** — there is no stored URL to inspect or curl. Debug a bad session
  by re-minting, not by looking for a saved endpoint.
- **A borrowed session acts as its owner.** Surface that in any "share with team" UI: lending an app means
  teammates act *as you*.
- **Sharing is local state.** A connection revoked directly on composio.dev leaves a stale row until it is
  pruned.
