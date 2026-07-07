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
| **Slack message** | the bot is @mentioned or DM'd | "hey @AgentOS, /support look at this ticket" |
| **Discord message** | the bot is @mentioned or DM'd | the same, in a Discord server or DM |

Slack and Discord run over an **outbound** connection, so there's no public URL to expose — set the
tokens once in **Settings → Integrations**. Webhooks get a secret URL (the key in the link *is* the
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

## You don't need an automation to reach an agent

If a Slack/Discord mention matches **no** automation, the bot still works: address any agent by name
and it spawns a one-off run as you.

```
@AgentOS /support customer says checkout 500s on the annual plan
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
progress and reports in your **Inbox**, deliverables under **Artifacts**, and every governed action in
the **Audit** log. An automation is never a black box.
