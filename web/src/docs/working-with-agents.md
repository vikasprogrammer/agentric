# Working with agents

The three ways work starts, and what to do while it runs.

## 1. From the console

**Agents → pick one → Run** with a prompt. You get a live terminal you can watch or type into — the agent may ask you things right there. Closing the tab doesn't kill the run; find it again under **Sessions** (green dot = still live) and re-attach any time. Interactive sessions that ended can often be **resumed** in place, picking the conversation back up.

## 2. From chat (Slack / Discord)

Mention the bot and address an agent by name:

```
@AgentOS /support customer says checkout 500s on the annual plan
```

- The bot acks in a **thread**; all agent replies land in that thread.
- The run acts **as you** (via your linked Chat ID on the Team page).
- No `/agent-name` prefix, or an unknown name? The bot replies with the list of agents you can address.

## 3. From automations and tasks

- **Automations** start agents on a schedule or webhook — no human in the loop at start, but the same guardrails apply during the run.
- **Tasks** assigned to an agent (with auto-dispatch) spawn a session when the scheduler picks them up. This is also how *agents delegate to each other*: an agent files a task for another agent instead of doing work outside its lane.
- Agents can also **schedule themselves** ("check this again in 2 hours") — bounded, visible under Automations.

## While it runs

- **Questions** — the agent may pause and ask you something; it lands in your Inbox (and the session terminal). Answer and it continues.
- **Approvals** — if the agent hits a yellow/red action, the right approver is pinged in the console and by Slack/Discord DM. The session waits; nothing happens until a decision.
- **Updates / reports** — agents post progress notes and a final report to the Inbox.
- **Library** — deliverables are published to the Library page, linked from the report.

## Good prompts for agents

Same rules as briefing a new teammate:

- **Give the goal, not the steps.** "Get the refund report to finance by noon" beats a 12-step recipe.
- **State the constraints.** "Don't email the customer yet", "draft only, I'll review".
- **Point at context.** Name the customer, ticket, page, or repo — agents can search Knowledge and their memory, but a direct pointer saves a detour.
- **Say what done looks like.** "Publish a markdown summary to the Library" gives the run a finish line.

## When something goes wrong

Stop a runaway session from **Sessions** (stop button). Every action it already took is in the **Audit** log — nothing is invisible. If an agent keeps making the same mistake, fix the **Knowledge** page it's reading or tell an admin to adjust its instructions; that's how the fleet learns.
