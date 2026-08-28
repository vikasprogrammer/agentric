# Automations — starting work without a human

Most runs start because *you* clicked Run or messaged an agent. **Automations** are standing rules
that start a run when nobody's watching — on a schedule, on an inbound event, or on a chat message —
while keeping every guardrail the console gives you. Manage them on the **Automations** page.

An **Automation** is the rule; its **trigger** is what makes it fire. Agents answer *who does the
work*; automations answer *when the work starts*.

## The triggers

| Trigger | Fires when… | Good for |
|---|---|---|
| **Schedule (cron)** | a time rolls around | nightly reports, hourly health checks, a Monday digest |
| **Webhook** | an HTTP call hits its private URL | wiring up an external tool or a "when X happens in our app" hook |
| **Composio** | a connected third-party app emits an event | reacting to Stripe, GitHub, a form, etc. via Composio |
| **Slack message** | the bot is @mentioned or DM'd — or a **watched channel** gets a matching message | "hey @Agentric, /support look at this ticket"; abuse reports landing in #trust-safety |
| **Discord message** | the bot is @mentioned or DM'd | the same, in a Discord server or DM |

Slack and Discord run over an **outbound** connection, so there's no public URL to expose — set the
tokens once in **Connections → Creds**. Webhooks get a secret URL (the key in the link *is* the
auth); treat it like a password.

## An automated run is still a governed run

Firing an automation spawns a normal **session** — the same gateway, gate hook, approvals, budgets,
and audit apply. Two identities are tracked:

- **Provenance** — *the automation started this* (so you can trace it back to the rule).
- **Run-as** — *whose identity it acts under*. A chat trigger runs **as the person who sent the
  message** (matched via their Chat ID on the Team page); a schedule or webhook with no obvious
  person runs as the **company** identity.

So an unattended run can still hit a yellow/red action and **pause for approval** — the right person
is pinged in the console and by Slack/Discord DM, and nothing happens until they decide.

## Headless vs. interactive

- **Headless** (default) — the agent runs to completion and exits, then the session goes idle. Best
  for scheduled/triggered work you don't intend to watch. Risky actions are **still** gated and still
  wait for approval; "headless" doesn't mean "ungoverned".
- **Interactive** — keeps an attachable terminal you can jump into, like a console run.

A **pile-up guard** stops a schedule from re-firing while its previous run is still alive, so a slow
job never stacks copies of itself.

## Watching a Slack channel

A Slack automation's **trigger filter** is a scope, optionally followed by a condition:

```
<channel id | app_mention | message>  [ when … ]  [ unless … ]
```

Leave it blank and the automation fires on any Slack message the app receives. Name a **channel id**
and two things happen:

1. It fires only on that channel.
2. That channel becomes a **watch** — messages there fire it *without* anyone @mentioning the bot.

That second point is the difference between "an agent you summon" and "an agent that reads a
channel". A report someone pastes, forwards, or relays into `#trust-safety` is not addressed to
anybody; requiring an @mention would make the automation depend on the reporter remembering to
summon it. (Only an automation scoped to that exact channel is woken this way — a blank or
`*` filter keeps its old mention-and-DM behaviour, so turning this on for one channel can't change
what your existing automations do.)

### Conditions

A watched channel carries ordinary conversation too, and *every* message would otherwise start a
run. `when` / `unless` cut it down **before** a session is spawned:

```
C0ABUSE1 when text ~ "abuse report"
C0ABUSE1 when text ~ "abuse" and text !~ "resolved"
C0ABUSE1 unless actor == "Status Bot"
```

- `when` fires only if **every** condition holds; `unless` drops only if **every** condition holds.
- Operators: `==`, `!=`, `~` (contains), `!~` (does not contain), joined by `and`. Case-insensitive.
- `text` is the message with any bot mention stripped — what a human reads. `actor` is the sender's
  resolved name. Any other field of the Slack event is reachable by its dot path (`files.0.name`).

This is the same grammar webhook filters use, and it exists for the same reason: without it, the
cheapest decision in the system — *"this message isn't mine"* — is made by a whole Claude session
reading the prompt it was spawned with. An instruction in the agent's prompt can't help, because it
runs **after** the spawn it was meant to prevent.

> Messages posted by other **bots and apps** are ignored on every Slack path, watch included. If your
> reports are delivered by an integration rather than typed by a person, send them to a **webhook**
> automation instead — same conditions, full payload, real signature auth.

## You don't need an automation to reach an agent

If a Slack/Discord mention matches **no** automation, the bot still works: address any agent by name
and it spawns a one-off run as you.

```
@Agentric /support customer says checkout 500s on the annual plan
```

So the whole fleet is reachable out of the box — per-agent automations become optional shortcuts, not
a requirement. (No name, or one that doesn't exist? The bot replies with the agents you can address.)

## Agents scheduling themselves, and each other

- **Deferred self-runs.** An agent can say "check this again in 2 hours" and schedule a future run of
  itself. These are bounded (a floor and ceiling on the delay, a cap on how many can be pending) and
  show up under Automations like any other rule.
- **Delegation.** An agent hands work to another agent by filing a **Task** assigned to it with
  auto-dispatch — the scheduler starts that agent when it picks the task up. The accountable human
  carries through the hand-off. See **Memory, Knowledge & Tasks**.

## Where to look when one fires

Everything an automated run does lands in the same places as a console run: live under **Sessions**,
progress and reports in your **Inbox**, deliverables under **Library**, and every governed action in
the **Audit** log. An automation is never a black box.
