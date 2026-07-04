# Governance: roles, approvals, budgets, audit

How Agent OS keeps autonomous agents accountable — without a human babysitting every step.

## Roles

| Role | Runs agents | Approves | Manages |
| --- | --- | --- | --- |
| **Owner** | any | everything, incl. **red** (owner-level) | team, roles, settings, policy |
| **Admin** | any | **yellow** (head-level) | team, assignments, connectors, automations |
| **Member** | only **assigned** agents | nothing | — |

Assignment is the member-facing access control: a member simply cannot start an agent they haven't been given. Role changes and member removal are owner-only.

## The traffic light

Every side effect an agent attempts is classified by policy **before it happens**:

- 🟢 **Green** — allowed, executed, audited. Most reads and low-risk writes.
- 🟡 **Yellow** — suspended until an **admin or owner** approves. Riskier writes, external sends.
- 🔴 **Red** — suspended until the **owner** approves. The irreversible stuff: money, deletion, production.

A suspended action *blocks the agent mid-step* — it isn't "flagged and done", it hasn't happened yet. Approvers are notified in the console Inbox and by Slack/Discord DM. Approvals survive restarts: a pending gate stays pending until someone decides.

Policy is a rule engine, not a hardcoded list — what's green vs. red is configuration your owner controls, per capability. Agents can preview it themselves (they have a *policy check* tool), so a well-behaved agent knows in advance which of its plans will need a human.

## Identity: provenance vs. run-as

Every session records two things:

- **Provenance** — what started it (a person, an automation, a chat message).
- **Run-as** — whose identity it *acts under*, which drives connector access and visibility.

So "the cron started it" and "it acted as Priya" are both true and both recorded. Chat-triggered runs act as the sender via the identity map (Team page → Chat IDs). A hand-off between agents carries the accountable human along — delegation never launders responsibility.

## Budgets

Every agent has caps — dollars, tokens, wall-clock — per run. A runaway agent runs out of budget before it runs out of ideas. Budgets are set per agent by admins.

## Audit

Everything lands in an append-only audit trail: every gated action, decision, approval, notification, spawn. The JSONL file on disk is the durable system of record; the **Audit** page (owner/admin) is a queryable mirror — filter by session, type, or principal. If a question ever starts with "wait, who did—", the answer is in there.

## The emergency brake

Owners can stop any live session immediately, and the whole fleet is subject to the gateway — there is no side-effect path around it. That invariant is the product.
