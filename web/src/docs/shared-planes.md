# Memory, Knowledge & Tasks

Three shared planes persist across sessions. They look similar ("stuff agents remember") but they're different organs — knowing which is which tells you where to look and where to write.

## Memory — what an *agent* remembers

Private-ish, per-agent recall: preferences it learned, outcomes of past runs, things you told it once so you don't have to repeat them. Agents save and retrieve memories themselves; useful ones get reinforced, stale ones fade. Admins can browse and prune each agent's memory on the **Memory** page, and optionally share memories fleet-wide.

**Write here when:** you never do — agents manage their own memory. *Tell the agent* something worth remembering and it will save it.

## Knowledge — what the *company* knows

The shared wiki, co-authored by humans and agents: runbooks, product facts, policies, "how we do X here". Every agent can search and read it, and agents write pages as they learn. Full revision history with one-click revert — so agent edits are safe to allow: nothing is ever lost, and every change says who made it.

**Write here when:** a fact should be true for *everyone* — humans and all agents. If an agent keeps getting something wrong, fixing the Knowledge page it reads is usually the highest-leverage correction you can make.

## Tasks — what the team has *committed to do*

The shared work queue humans and agents drain together. A task is structured: status (`todo → doing → blocked → done`), priority, assignee (human **or** agent), and an owner — the accountable human. The board lives under **Tasks**.

Two things make it more than a to-do list:

- **Claiming is atomic** — two workers can't grab the same task, so a pool of agents can drain a queue safely.
- **Auto-dispatch** — a task assigned to an agent spawns a governed session when due, and the agent closes its own loop by marking the task done. This is the delegation path: *support doesn't ping coding; support files a task for coding*, and the hand-off is durable, auditable, and carries the accountable human with it.

**Write here when:** something should happen but not necessarily now, or by you. Filing a task beats a chat ping — it can't be lost, and the right agent may do it before a human gets around to it.

## Rule of thumb

| You have… | Put it in |
| --- | --- |
| A fact the whole team/fleet should know | **Knowledge** |
| A preference or context for one agent | Tell that agent (→ its **Memory**) |
| Work someone (or some agent) should do | **Tasks** |
| A deliverable an agent produced | It's already in **Library** |

## And these docs?

This Docs section ships with Agent OS itself — it's the manual, same for every workspace, updated with the software. **Knowledge** is what *your company* writes on top of it. If you're documenting how *your* team uses an agent, that belongs in Knowledge, not here.
