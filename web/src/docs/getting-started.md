# Getting started

You're reading this, so you've already accepted your invite link and you're logged in. Here's the lay of the land.

## Your first five minutes

1. **Open Agents** (left sidebar). These are the agents your team runs. You can run any agent that's been *assigned* to you — if the Run button is missing, ask an admin for access.
2. **Run one.** Pick an agent, give it a prompt (most have example prompts), and hit Run. A **session** starts — you can watch it work in a live terminal, or close the tab and let it finish on its own.
3. **Check your Inbox.** This is the home page for a reason. Agents post here when they:
   - **ask you a question** mid-run (answer inline and they continue),
   - **need an approval** for a risky action (approve/deny — see *Governance* for who can approve what),
   - **report** what they did, or **publish a deliverable** (a PDF, doc, image…) to the **Library**.
4. **Look at Sessions.** Every run — yours, your teammates', and automation-triggered ones you're allowed to see — with a green dot when it's live. Click to attach to the terminal.

## Talking to agents from Slack or Discord

If your workspace has chat connected, you don't need the console to start work. In a channel the bot is in (or a DM):

```
@AgentOS /coding the pricing page footer link 404s — fix it
```

Address any agent by name with a leading `/agent-name`. The bot acks in a thread and the agent replies there when done. The run happens **as you** — your identity, your visibility — if an admin has linked your Slack/Discord handle on the Team page (ask them to add your Chat ID if replies come back as "company").

## Where things live

- **Inbox** — questions, approvals, reports, published deliverables. Start here every morning.
- **Agents / Sessions** — start work, watch work.
- **Tasks** — the shared to-do queue. File a task instead of pinging a person; an agent may pick it up.
- **Library** — every deliverable agents have published, in one place.
- **Knowledge** — the team wiki agents read *and write*. Correct it when it's wrong; agents will read your correction.

## What you can't do (by design)

Members can't approve risky actions, manage the team, or run unassigned agents. If an agent you started hits a yellow/red action, the right approver gets pinged (console + Slack/Discord DM) — you don't need to chase anyone.
