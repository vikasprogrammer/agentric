# Agent-driven Composio connection requests — default to personal

## Problem

An agent that needs a Composio app (Gmail, a Slack workspace, an analytics account) has **no governed
way to ask for it**. The only initiation path is a human opening **Settings → Connections** and clicking
Connect. Worse, that console path defaults to **company** scope (`src/server.ts` `/api/connections/connect`
— `scope === 'personal' ? 'personal' : 'company'`), so the default is a shared, everyone-can-use connection.

The desired posture: **an agent asks for a PERSONAL connection by default** (scoped to the human the run
acts as — their own Gmail/calendar), and only asks for a **company-wide** connection when the app is a
shared org resource the whole fleet would legitimately use.

## Design — mirror `secret_request`

This is the connection twin of `secret_request`: the agent carries only the *intent* (which toolkit, why,
what scope), never a credential; a human completes the OAuth. We reuse the whole review-card / notifier /
audit spine and add nothing to the schema beyond a new message `type`.

### The agent tool — `connection_request`

`connection_request({ toolkit, scope?, reasoning? })` (in `src/memory/memory-mcp.ts`):
- `toolkit` (required) — Composio toolkit slug, e.g. `gmail`, `slack`, `googlecalendar`.
- `scope` — `'personal'` (**default**) or `'company'`. The description tells the agent: default to
  personal (your own account, tied to the human you run as); request `company` **only** when the app is a
  shared org resource everyone would use (a team Slack, a shared analytics login), never a personal inbox.
- `reasoning` — one line for the human.

Loopback → `POST /api/agent/connection/request` (session-secret gated, before the member gate; agent is
derived from the session row, never trusted from the body — the standard preamble). The route:
1. Requires a Composio API key (`Settings → Integrations`), else a clear error.
2. **Personal scope needs a human owner.** Resolve the run's `run_as` member. If there is none (a pure
   automation / company-identity run), personal is meaningless → return an error telling the agent to
   request `scope:'company'` instead.
3. **Already-connected short-circuit.** `listConnectedAccounts(key, entity)` for the target entity
   (`serviceUserId(tenant)` for company, the member's email for personal); if the toolkit is already
   `ACTIVE` there → status `exists` (the agent already has it next launch).
4. Else `tm.requestConnection(...)` — dedupe an open request for the same `(toolkit, scope, agent)`, post
   the review card, audit `connection.requested`.

### Who the card reaches (the one new bit of plumbing)

A **company** request is an owner/admin act → addressed to the `admins` audience (exactly like every other
review card). A **personal** request must be completed by the *member whose account it is* (an admin can't
OAuth someone else's personal Gmail) → addressed to that member (`{kind:'member', id}`).

So `postReviewCard` gains an **optional** `audience?: Audience` (default stays `admins`, so the six existing
callers are unchanged), maps it onto the card's `audience_kind`/`audience_id`, and threads it onto the
`ReviewNotice` so the out-of-band DM reaches the right person. `notifyReview` honors
`notice.audience ?? {kind:'admins'}`.

### Fulfillment (human completes the OAuth)

Owner/admin console + the target member see open requests and act:
- `GET /api/connections/requests` — admin sees all open; a member sees personal ones addressed to them.
- `POST /api/connections/requests/:id/fulfill` — gate: **company** ⇒ owner/admin; **personal** ⇒ the
  target member only. Calls `initiateConnection(key, entity, toolkit)` (entity = service entity for
  company, the member's email for personal) and returns the hosted OAuth `redirectUrl` for the human to
  finish in their browser. Marks the card `fulfilled`, audits `connection.request.fulfilled`.
- `POST /api/connections/requests/:id/dismiss` — same gate; marks `rejected`, audits
  `connection.request.dismissed`.

Once the human finishes OAuth, the connection lives under the right Composio entity, and the agent picks it
up at its next launch (the personal `composio` session is minted for the run-as member; the company one for
`serviceUserId`) — no extra wiring.

### Data model

No new table. State is a row in `messages` with `type='connection.request'`, `status ∈ open|fulfilled|
rejected`, `args = { toolkit, scope, member?, reasoning? }` — identical shape to `secret.request`.

### Audit events

`connection.requested` (data: `toolkit, scope, reasoning`), `connection.request.fulfilled`
(`toolkit, scope, entity`), `connection.request.dismissed` (`toolkit, scope`).

## Touch list

- `src/terminal.ts` — `ReviewNotice` (+kind, +optional `audience`); `postReviewCard` (+optional
  `audience`); new `requestConnection` / `connectionRequestCard` / `setConnectionRequestStatus` /
  `openConnectionRequests`.
- `src/server.ts` — the four routes above.
- `src/tenant-registry.ts` — `REVIEW_PRESENTATION['connection.request']`; `notifyReview` honors
  `notice.audience`.
- `src/memory/memory-mcp.ts` — the `connection_request` tool (schema + dispatch + handler).
- `web/src/lib/api.ts` + `web/src/connectors.tsx` — an "Agent connection requests" review section on the
  Connections page (admins see all; members see their own personal ones), one card per request with
  Connect / Dismiss.
- `docs/agent-mcp-tools.md` — document the tool + routes.

## Non-goals (v1)

- No auto-completion of OAuth (a human always finishes the browser step — same as the console today).
- No "an admin marks it shareable" toggle at fulfillment time; the *agent* asserts scope, the human
  approves or dismisses. (A future admin-side "promote to company" is easy to add later.)
