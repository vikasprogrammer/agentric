# Webhook ingress

How `POST /hooks/<id>` turns a source's event stream into agent runs, and why it is shaped the way it
is. Code: `src/edge/webhook-ingress.ts` (the pure decisions), `Automations.fireWebhook`
(`src/edge/automations.ts`), the route in `src/server.ts`. Falsifier:
`scripts/webhook-ingress-test.cjs`, wired into `npm run test:governance`.

## The problem it fixes

The generic hook lane was built for a hand-rolled trigger: POST anything, spawn a run. Pointed at a
real product webhook it failed in four ways at once, and the first one lost data:

```
fireWebhook() → fire(a, { guard: true })
                            └── previous run still alive? → 429, nothing queued
```

A product webhook does not retry a 4xx. So every event that arrived while the agent was still working
was **gone** — and the busier the agent, the more it dropped. For a source sending ~100–150 events/day
into an agent whose runs last minutes, that is the normal case, not an edge case. The guard was doing
what it was written for (no pile-ups on a *cron*, where the next occurrence is equivalent to this one)
applied where it does not hold: two webhook events are two different pieces of work.

Alongside that: a webhook automation had **no event filter**, so it woke for every event of every kind
and most runs existed only to read the payload and exit. There was **no dedupe**, so a re-delivery ran
the work twice. And authentication was a **key in the URL** — which lands in logs, referrer headers and
browser history — while nearly every source also signs the body and we ignored it.

## The shape now

```
POST /hooks/<id>?key=…
  ├── 404 unknown hook · 403 bad key · 409 disabled          ← caller errors, still 4xx
  ├── signature configured? verify HMAC over the RAW body → 401
  ├── filter: is this event one this automation is about?  → 200 {skipped:'filter'}
  ├── dedupe: have we already claimed this delivery?       → 200 {skipped:'duplicate'}
  ├── continuity: is a live run already handling this
  │   conversation? → deliver into it                      → 200 {continued:true}
  └── otherwise spawn, UNGUARDED                           → 200 {sessionId}
```

**Everything we decline answers 200.** A sender reads 4xx/5xx as "retry, or disable this endpoint";
neither is right for "not subscribed to that event" or "already handled". Those are successful
acknowledgements of an event we correctly did nothing about. Only genuine caller errors — unknown hook,
bad key, bad signature, disabled automation — answer 4xx.

**Volume is handled before spawning, not by refusing to spawn.** Filter removes what the automation was
never about, dedupe removes what we already did, continuity folds a follow-up into the run that owns
that conversation. What survives all three is genuinely concurrent work on *different* conversations,
which is exactly what should run in parallel — so it spawns unguarded, like every other event-driven
ingress (`fireSlack`, `fireDiscord`, `fireClickup` all use `guard: false`).

## Configuration

Per webhook automation (Automations → Edit, or `POST`/`PATCH /api/automations`):

| Field | What it does | Blank means |
|---|---|---|
| `filter` | Comma-separated event names; `prefix.*` matches a family. Optionally `… when <path> <op> <value> [and …]` over the payload — see below | every event fires a run |
| `threadPath` | Dot path to the source's conversation id (`conversation.id`) | a run per accepted event |
| `signingSecret` | Secret the source signs the body with | the URL key is the only credential |

All three are absent on an automation created before this shipped, and every default is the previous
behaviour — an existing hook keeps firing on everything, unsigned, with no continuity.

`signingSecret` is **write-only**: it is stripped in `automationView` and never sent to a client. The
console sees only `signed: true|false`, so an empty field on edit means "leave it alone" and clearing it
is an explicit action.

## The `when` clause — filtering on the body

An event name alone cannot express the single biggest source of waste on a live hook: **the echo.**
The agent posts a note on a ticket; the source emits `convo.note.created`; the automation fires; a
whole session spawns, reads the thread, discovers the note was its own, and exits. Every reply the
agent writes buys a second session to un-decide it. Measured on instawp's FreeScout hook over one
week: **93 of 177 runs (53%) did no work at all, and 79 of them were triggered by the agent's own
note** — $224 spent to produce nothing.

That decision is one field comparison, and it belongs at the ingress. A gate written into the agent's
**prompt cannot help**, because it runs *after* the spawn it was supposed to prevent — it can shorten a
session but never avoid one. So the filter grew a payload clause:

```
convo.created, convo.note.created  when state != deleted and threads.0.createdBy.type != user
```

    <events> when <path> <op> <value> [ and <path> <op> <value> ]…
    op := ==   !=   ~ (contains)   !~ (does not contain)

`and` is the only connective — no `or`, no parens, so there is no precedence to misread. Paths are the
same dot paths `threadPath` uses (array indices included). Values may be quoted; comparison is
case-insensitive, like the event half. A filter with no `when` parses to zero predicates, so **every
existing automation is byte-for-byte unaffected**.

### Two traps, both load-bearing

**A missing path reads as `''`.** So `state != "deleted"` *passes* when there is no `state` field, and
`source.type == "api"` *fails*. The asymmetry is deliberate: `!=` (drop the known-bad) degrades toward
firing, `==` (fire only on the known-good) degrades toward silence. **Prefer `!=`** — a wrong path in an
`==` clause matches nothing and silently drops every event.

**Write the predicate from real traffic, not from the vendor's field names.** Measured while building
this, across 40 live FreeScout deliveries: the obvious-looking `source.type != "api"` does *not*
identify the echo — a conversation-level `source` says how the *conversation* started, not who posted
the note that fired *this* event, and `api` appeared on the genuine tickets too. `state != "deleted"`
was no safer: agents do real work on merged-away conversations. The author of the triggering message
generally lives one level down, on the newest thread. Read a recent run's prompt (it carries the
payload) before choosing a path.

Because a mistake here is silent, the runtime **fails open**: a `when` clause that cannot be parsed is
ignored and the delivery fires anyway, with a `filter-invalid` audit row naming the clause. Losing a
real customer ticket costs far more than one extra session. Malformed clauses are refused at *save*
time instead (`add`/`update` throw), which is the only place a typo is genuinely caught.

## Vendor neutrality

There is no per-source branching anywhere in this path, and adding a new integration should need no
code here. Sources differ in spelling, not in shape, so we match on the shape:

- **Event name** — `?event=`, else any `x-…-event` / `x-…-topic` header, else a top-level `event` /
  `event_type` / `type` / `action` field.
- **Delivery id** — `?delivery=`, else any `x-…-delivery` / `x-…-id` / `x-…-signature` header, else a
  hash of the raw body.
- **Signature** — any `x-…-signature` header, accepting `sha256=<hex>` / `sha1=<hex>` prefixed, bare
  hex, or bare base64, in either algorithm. A prefix, when present, **pins** the algorithm. Every branch
  is a keyed HMAC of the exact bytes received: the tolerance is over *encoding*, never over whether the
  caller proved knowledge of the secret.

That covers the two shapes worth naming as examples — the base64 HMAC-SHA1 style and the
`sha256=<hex>` style — plus sources nobody here has seen.

An event we cannot identify (`''`) passes **only** a catch-all filter. Anything else would be a guess,
and guessing wrong spawns a run per unrelated event.

## Signatures need the raw bytes

The route reads the body with `readRawBody` and parses a copy. An HMAC is computed over exactly what
the source sent, so re-serializing a parsed object can never reproduce it — key order and whitespace are
gone. A body that is not JSON still authenticates and still fires; it just has no readable fields.

## State

Two tables, both keyed by `(automation_id, …)`:

- **`webhook_deliveries`** — claimed deliveries. The INSERT's primary key *is* the lock: two simultaneous
  copies of one event race on it and exactly one wins. Pruned on write past `DEDUPE_TTL_MS` (15 min).
  This is a retry-absorbing window, not a ledger — the audit trail is the durable record.
- **`webhook_threads`** — which session owns a source-side conversation, valid for `THREAD_TTL_MS`
  (30 days). The webhook analogue of `slack_threads` / `clickup_threads`, keyed by the source's id
  rather than ours. If the bound run is no longer live, the follow-up starts a fresh one.

## Audit

Every delivery appends `trigger.webhook` with an `outcome` of `fired` · `continued` · `filtered` ·
`duplicate` · `bad-signature` · `refused` · `filter-invalid`, plus the event name and (where relevant)
the thread key and session. So "did that event reach an agent, and if not why not" is one audit query,
which is what the old 429 could never tell you.

A `filtered` row carries `by: 'event' | 'payload'`, and a payload rejection names the exact `predicate`
that rejected it — so a `when` clause that is quietly dropping more than you meant shows up as a count
per predicate rather than as an agent that mysteriously stopped working.

## Setting one up

1. Create the automation (Automations → New → Webhook), set the event filter, and — if the source
   signs — paste the signing secret. Copy the generated hook URL.
2. Point the source at it. Subscribe it to only the events you filtered for; the filter is a safety net,
   not a substitute for configuring the source.
3. Fire a real event and check Audit for `trigger.webhook` → `fired`, then that the run did the work.
4. Fire an event you did **not** subscribe to and confirm `filtered` with no session.
5. Send two events for different conversations close together and confirm both get runs — that is the
   regression the old `guard: true` would have failed.
