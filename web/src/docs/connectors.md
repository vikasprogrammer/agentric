# Connectors — reaching the outside world

An agent that can only be started from the console is half a teammate. **Connectors** are how the
outside world reaches your agents, and how your agents reach back out — chat, task comments, GitHub,
and ~1000 SaaS apps. Owners and admins set them up once, on **Connections → Creds**; everyone else
just uses them.

Two directions, and it's worth keeping them apart:

- **In** — something out there *starts* a run: a Slack mention, a Telegram command, a comment on a
  ClickUp task, an app event.
- **Out** — an agent *acts*: posts a reply, DMs a person, opens a PR, sends mail from your Gmail.

Usually it's the same app doing both. The bot that hears you in Slack is the bot that answers.

## What to connect, and why

| Connector | Connect it when you want… | Setup |
|---|---|---|
| **Slack** | your team to reach agents where they already talk | two tokens |
| **Discord** | the same, in a Discord server | one bot token |
| **Telegram** | the same, from phones — the fastest of the three to set up | one bot token |
| **ClickUp** | agents that answer on a task, in the task | API token + a ClickUp Automation |
| **GitHub** | agents to commit and open PRs **as the real person** | a company GitHub App |
| **Composio** | Gmail, Notion, Linear, Drive, Stripe… without a custom integration | one API key |

You don't need all of them. One chat channel plus Composio covers most teams.

## Chat: Slack, Discord, Telegram

All three work the same way from your side, and none of them needs a public URL — the server dials
*out* to Slack/Discord/Telegram, so this works on a private or on-prem box with nothing exposed to the
internet.

**Talk to any agent by name.** In a channel the bot is in, or a DM:

```
@Agentric /coding the pricing page footer link 404s — fix it
```

The leading `/agent-name` picks the agent. No automation, no configuration per agent — connect the bot
once and the **whole fleet** is reachable. Get the name wrong (or leave it off) and the bot replies
with the list of agents you can address.

**It runs as you.** If an admin has linked your chat handle on the **Team** page (Chat IDs), the run
acts under *your* identity — your connected apps, your visibility, your approvals. Unlinked people get
the company identity instead, which is why replies sometimes come back looking anonymous. That's the
first thing to check.

**Replies stay in the thread.** Slack answers in a thread, Discord branches a real thread off your
message, Telegram replies in the same chat. Better: a follow-up in that thread **continues the same
conversation** — the agent still has the context, it isn't starting over. Ask it to adjust something
and it just does.

Per-channel setup lives in the console (Connections → Creds walks you through each one), so here are
only the things that quietly bite:

- **Slack** — the app's **App Home → Messages Tab** must be on, or the bot can't do DMs at all. And
  scopes are add-*then-reinstall*: an app created before a scope existed silently lacks it.
- **Discord** — you must enable the **MESSAGE CONTENT** intent in the Discord Developer Portal. Skip
  it and messages arrive empty, so nothing happens and nothing errors. Use the console's one-click
  invite button rather than building the URL yourself.
- **Telegram** — a bot in a group only sees commands, @mentions, and replies to itself unless you turn
  **Group Privacy off** in @BotFather. Mentions work either way; plain follow-ups (that thread
  continuity above) need privacy off.

## ClickUp — an agent in the task

ClickUp is the one channel that works by webhook, because ClickUp has no live connection to dial. The
effect is the same: comment `/agent-os <agent> your request` (or just `/<agent> …`) on a task and that
agent picks it up, then answers as a comment on the same task. Follow-up comments continue the same
conversation.

Setup is a company ClickUp API token in Connections → Creds, then pasting the generated webhook URL
into a ClickUp Automation (**Automations → Add → When a comment is posted → Webhook (POST)**). The
console shows you the exact URL once the token is saved.

Two things to expect:

- **Only `/command` comments do anything.** A task's comment section is a shared human space, so
  ordinary chatter is ignored on purpose — the agent isn't reading over your shoulder.
- **The agent reads the whole task, not just your comment.** On ClickUp the description usually *is*
  the request, so a bare `/support have a look` works.

You'll see a 👀 reaction on your comment when it's been picked up. The actual answer arrives as a
comment. (ClickUp comments are plain text, so don't expect formatting.)

## GitHub — commits with the right name on them

Connect the company **GitHub App** once, and each person links their own GitHub account from
**Connections**. After that an agent working on your behalf commits and opens PRs **as you**, not as a
shared bot — the credential it uses is minted fresh and expires within the hour, so nothing long-lived
is ever handed to an agent.

Runs with no linked person fall back to the company bot. If PRs are showing up authored by the bot
when you expected your name, that's the reason: link your account, or check that the run is running as
you. See *Your identity & GitHub* for the full walkthrough.

## Composio — the long tail

One Composio API key (an admin adds it) unlocks connectors for roughly a thousand apps. Then two
flavours:

- **Company apps** — connected once, available to everyone. The shared company Gmail, the team
  Slackbot.
- **Your apps** — you connect your own Gmail/Notion/Drive from **Connections**, and they're injected
  only into runs acting as *you*. This is what makes "email that person" go out from your real
  mailbox, landing in your real Sent — not a spoofed From header.

You can also **share** one of your connected apps with the team. Worth understanding before you flip
that switch: a shared app still acts **as you**. Teammates borrow the connection, they don't get your
account — they reach exactly what you shared and nothing else of yours, and they can't add or revoke
connections under your name. Unsharing is instant and needs no re-authorisation.

## It's all still governed

Connecting an app doesn't widen what agents may do. Every outbound action — a Slack post, an email, a
commit — goes through the same gateway as everything else: policy classifies it, risky actions wait in
somebody's **Inbox** for approval, and all of it lands in the audit log. An automation firing at 3am
can still stop and wait for a human.

The one thing connectors *do* change is **whose name is on the action** — company or yours. That's the
whole point of linking your identity.

## When something isn't working

| Symptom | Usually |
|---|---|
| Bot ignores you in Slack/Discord | not in the channel, or (Discord) MESSAGE CONTENT intent is off |
| Bot answers but replies read as "company" | your Chat ID isn't linked on the Team page |
| Slack DMs don't work at all | App Home → Messages Tab is off |
| Telegram follow-ups ignored, mentions fine | Group Privacy still on in @BotFather |
| Nothing happens on a ClickUp comment | comment didn't start with `/agent-name`, or the ClickUp Automation isn't on that space |
| PRs authored by the bot | the run has no linked run-as person |
| "Connecting apps needs a company Composio key" | an admin hasn't added the key yet |
