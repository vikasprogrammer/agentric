# Your identity, chat & GitHub

When an agent runs **as you**, it should *be* you — act with your visibility, in your voice, commit
under your name. That connection is set up once, mostly on your **Profile** page (the sidebar profile
row, or the gear on the notification bell). The **Team** page is for managing *other* people; your
Profile is for *you*.

## My context — standing instructions for runs as you

**My context** (Profile → My context) is free text that gets added to the system prompt of **every
session that runs as you** — your working style, standing preferences, the domain notes you'd otherwise
repeat. "I prefer terse summaries." "Our fiscal year starts in April." "Always CC me before emailing a
customer."

It sits *below* the task and the fleet-wide **Company context** — it colors how your runs behave, it
doesn't override the job or company rules. It's yours: only you edit it, and it only rides on runs that
act as you. (For facts the *whole team* needs, use **Knowledge**; for the *whole fleet's* standing
instructions, that's **Company context**, set by an admin.)

## Chat IDs — so chat runs act as you

Address an agent from Slack or Discord and the run should act **as you**, not as a faceless "company"
identity. That match happens through your **Chat IDs** (Profile → your Slack / Discord / email
handles). Link them and a `@AgentOS /support …` from you runs with your identity and your visibility.
If chat replies come back as "company", your handle isn't linked yet — add it on your Profile (you can
edit your own; admins can also set them on the Team page).

## GitHub — commits and PRs authored as you

By default, agents that touch git commit as the workspace's shared bot. **Connect your own GitHub** and
that flips: any session running as you authors its commits and pull requests under **your** name, so
the history reflects who the work was actually for. The bot stays the fallback for runs with no
connected human.

- **You:** **Connections → Connected → Mine → Connect GitHub** (one click, OAuth). Do this once. If an
  agent tries to do git work as you before you've connected, it'll nudge you to.
- **Owner/admin, once per workspace:** set up the company GitHub App first — **Connections → Creds →
  GitHub → Create GitHub App** walks it in one click (App-manifest flow), then **Install the App** on
  the repos agents may touch. After that, each teammate connects their own account as above.

Your token is stored under **your** identity (never shared), used only for runs that act as you, and —
like every credential — never appears in prompts, audit, or approval cards.

## Where this lives

| You want to… | Go to |
| --- | --- |
| Set how *your* runs behave | **Profile → My context** |
| Have chat runs act as you | **Profile → Chat IDs** |
| Have git commits authored as you | **Connections → Connected → Mine → Connect GitHub** |
| Manage *other people* (roles, access, invites) | **Team** |
