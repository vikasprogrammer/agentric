# Core concepts

The vocabulary, and — most importantly — how to decide **what should be an agent vs. a skill**.

## Agent — a *who*

An agent is an **identity that accumulates accountability**: its own access, policy envelope, budget cap, memory, and the set of humans allowed to run it. Think of it as a role you could point to when something goes wrong. `coding`, `support`, `consolidator` — each answers *who did this and under what rules*.

## Skill — a *how*

A skill is a **procedure or body of knowledge**: "how to write an SEO brief", "how to add a 1-click app", "how to triage a pod error". Skills are stateless, have no identity, and are **shared by the whole fleet** — every agent gets the skills library at launch. A skill can't be held accountable; it's just know-how.

### The split test

Create a **separate agent** only when at least one of these must differ:

1. **Permission envelope** — different red lines (deploying to prod ≠ drafting a doc).
2. **Accountability chain** — different humans assigned, different approvers.
3. **Memory hygiene** — its context would pollute (or be polluted by) another agent's.
4. **Trigger surface / budget** — its own schedule, SLA, or spend cap.

If none of those differ, it's a **skill** of an existing agent. A good heuristic: *create an agent when a different human would be accountable if it misbehaves; create a skill when it's just another thing the same agent should know how to do.*

## Session — a *run*

One execution of an agent. Sessions separate **provenance** (what started it — you, an automation, a chat message) from **run-as** (whose identity it acts under). A Slack-triggered run is *started by* the automation but *acts as* — and is visible to — the person who sent the message.

## Automation — a *trigger*

A standing rule that starts an agent without a human: a cron schedule, a webhook, a Slack/Discord mention. Automations answer *when does work start*; agents answer *who does it*.

## Task — a *unit of work*

A durable item in the shared queue between "something should happen" and "a session ran". Tasks have a status (`todo → doing → blocked → done`), an assignee (human **or** agent), and an owner. Assigning a task to an agent with auto-dispatch is how agents delegate to each other — support files a task, coding picks it up, and the accountable human carries through the hand-off.

## Library — where *deliverables* live

A file an agent published — report, PDF, image, doc — is a **deliverable**. Snapshots, kept forever, listed under **Library**.

## Memory vs. Knowledge

Both persist, but they're different organs — see **Memory, Knowledge & Tasks** for when each applies. Short version: **Memory** is what an *agent* remembers (its own notes); **Knowledge** is what the *company* knows (the shared wiki both humans and agents edit).

## Approval — a *pause*

When policy classifies an action yellow or red, the session freezes mid-step until a human with the right role decides. Approvals are the guardrail working, not the system failing.
