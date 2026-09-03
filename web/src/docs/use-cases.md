# Use cases — what to automate first

New installs almost always ask the same two questions: *what can I actually automate with this?* and
*what agent should I create first?* This page answers both. It is a catalog of the agent shapes that
have proven durable in day-to-day production use, organised by the department that owns them.

Nothing here is exotic. Every entry is the same three decisions:

1. **A job** — a narrow, repeated piece of work a person is doing today.
2. **A trigger** — what wakes the agent up (a schedule, an inbound event, a chat message, a person).
3. **A safety posture** — what the agent is allowed to *finish* versus what it must hand to a human.

The third decision is the one that determines whether an agent survives its first month. Get it right
and the agent runs unattended for months. Get it wrong and it either does nothing useful or does
something you have to undo. [The six postures are listed below](#the-six-safety-postures) — pick one
before you write a word of the agent's prompt.

> **Start narrow.** The agents that work are the ones whose description you can say in one sentence
> without the word "and". A generalist called "ops" that does everything will disappoint you; three
> specialists that each do one thing will not.

---

## Support

The highest-value starting point for most teams, and the easiest to make safe: support work is mostly
*investigation*, and investigation is read-only.

### Ticket diagnostician

Reads an incoming support ticket, works out who the customer is, investigates the problem read-only
across your systems (application database, logs, their account state), then posts an internal note with
the root cause and a **draft** reply for a human to send.

- **Trigger:** webhook from your helpdesk on new ticket, plus a scheduled sweep every few hours to catch
  anything the webhook missed.
- **Posture:** Draft, never send.
- **Why it works:** the slow part of support is not writing the reply, it is the fifteen minutes of
  digging that precedes it. The agent does the digging and shows its work; the human keeps the voice
  and the judgment.

```
Read the newest unresolved tickets. For each one: identify the customer, investigate the
reported problem read-only, post an internal note with what you found and the most likely
root cause, and add a draft reply in our support voice. Do not send anything. Escalate
anything that needs a code change or a production action by filing a task.
```

```create-agent
Create an agent called "ticket-diagnostician".

Job: read each incoming support ticket, work out who the customer is, investigate the reported
problem read-only across our systems (application database, logs, their account state), then post an
internal note with the root cause and a draft reply for a human to send.

Trigger: a webhook from our helpdesk on a new ticket, plus a scheduled sweep every few hours to catch
anything the webhook missed.

Safety posture: Draft, never send. It must never send a customer-facing message, and must escalate
anything needing a code change or a production action by filing a task.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Support quality reviewer

Reads yesterday's resolved conversations and reports what they say about the product — recurring
confusion, undocumented behaviour, questions that should have been answered by a docs page.

- **Trigger:** daily schedule.
- **Posture:** Read-only analyst.
- **Why it works:** it converts support volume, which everyone already has, into a product backlog,
  which most teams lack the time to write.

```create-agent
Create an agent called "support-quality-reviewer".

Job: read yesterday's resolved support conversations and report what they say about the product —
recurring confusion, undocumented behaviour, and questions that should have been answered by a docs
page.

Trigger: a daily schedule.

Safety posture: Read-only analyst. It writes nothing anywhere; the output is a report.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Backlog groomer

Weekly pass over tickets that have gone quiet — stale, waiting-on-customer, or silently abandoned.
Proposes a disposition for each; a human confirms in bulk.

- **Trigger:** weekly schedule, start of the week.
- **Posture:** Draft, never send.

```create-agent
Create an agent called "backlog-groomer".

Job: a weekly pass over support tickets that have gone quiet — stale, waiting-on-customer, or
silently abandoned — proposing a disposition for each so a human can confirm them in bulk.

Trigger: a weekly schedule at the start of the week.

Safety posture: Draft, never send. It proposes dispositions; it never closes a ticket or messages a
customer itself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### SLA radar

Checks response and resolution times against the commitment you have made — first reply within N hours,
resolution within N days — and reports only the items that have breached or are about to.

- **Trigger:** twice-daily schedule, plus a monthly trend report.
- **Posture:** Read-only analyst, and deliberately **internal**: it never contacts the customer whose
  ticket is late.
- **Why it works:** the breach list is short and unarguable, and it arrives while the ticket can still be
  saved. Keep the two jobs separate — the radar that measures the SLA must not also be the agent that
  replies to tickets, or it grades its own homework.

```create-agent
Create an agent called "sla-radar".

Job: check support response and resolution times against our stated SLA, and report only the items
that have breached or are about to. Also produce a monthly trend report on compliance.

Trigger: a twice-daily schedule, plus a monthly schedule for the trend report.

Safety posture: Read-only analyst, and strictly internal. It must NEVER reply to, email or otherwise
contact a customer — it reports to us only.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Infrastructure and operations

The largest run volume in mature installs. Ops work is a natural fit because the expensive skill is
*knowing where to look*, and that is exactly what a well-written agent prompt encodes.

### Fleet health monitor

Sweeps your servers and services on a schedule — disk, memory, service liveness, certificate expiry,
error-log deltas, queue depth, capacity headroom — and reports **what changed** since the last sweep as
a severity-ranked findings list. For anything broken it proposes the exact remediation command, and
does not run it.

- **Trigger:** every few hours on a schedule.
- **Posture:** Diagnose and propose; a human runs the fix.
- **Why it works:** "what changed" is the important word. A monitor that reports absolute state is
  noise you learn to ignore; a monitor that reports deltas gets read.

```
Sweep every host in the fleet. Check disk, memory, load, service status, TLS expiry, and the
last 24h of error logs. Compare against your notes from the previous sweep and report only
what CHANGED, ranked by severity. For each finding, give the exact command that would fix it
— do not run it. If nothing changed, say so in one line.
```

```create-agent
Create an agent called "fleet-health-monitor".

Job: sweep our servers and services — disk, memory, service liveness, certificate expiry, error-log
deltas, queue depth, capacity headroom — and report what CHANGED since the last sweep as a
severity-ranked findings list. Deltas, not absolute state.

Trigger: a schedule, every few hours.

Safety posture: Diagnose and propose. For anything broken it gives the exact remediation command and
does not run it; a human runs the fix.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Incident diagnostician

Given one failing thing — a server, a site, a customer environment, a stuck job — pins the root cause
from logs and state, then reports a plain-English explanation plus the fix.

- **Trigger:** a person, from chat or the console, when something breaks.
- **Posture:** Read-first. Any write to a production system pauses for approval.
- **Why it works:** it is the single best "first agent" for an ops team, because you invoke it exactly
  when you are already stressed and it costs nothing when idle.

```create-agent
Create an agent called "incident-diagnostician".

Job: given one failing thing — a server, a site, a customer environment, a stuck job — pin the root
cause from logs and state, then report a plain-English explanation plus the fix.

Trigger: a person, from chat or the console, when something breaks.

Safety posture: Read-first. Any write to a production system pauses for approval.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Exception monitor

Sweeps your production error logs every few hours, compares against a stored watermark so it only ever
looks at what is new, groups raw errors into distinct problems, and reports the ones that are actually
new or newly frequent.

- **Trigger:** schedule every few hours. Silent when nothing new has appeared.
- **Posture:** Read-only analyst. It files a task for anything that needs a code change; it does not fix.
- **Why it works:** error logs are already collected everywhere and read almost nowhere, because the
  volume is hostile to humans. The watermark is the whole trick — without it the agent re-reports the
  same hundred exceptions every run and the channel dies in a week.

```create-agent
Create an agent called "exception-monitor".

Job: sweep our production error logs every few hours. Keep a stored watermark of where the last
successful run stopped so you only ever process what is new. Group raw errors into distinct problems
and report the ones that are new or newly frequent, with a count and a first-seen time.

Trigger: a schedule every few hours. Stay SILENT when nothing new has appeared.

Safety posture: Read-only analyst. File a task for anything needing a code change; never fix it
yourself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Record reconciler

Compares two systems that are supposed to agree — what your platform bills against what is actually
running, what your app database says exists against what the infrastructure really has — and reports
every record that is in one and not the other.

- **Trigger:** daily schedule.
- **Posture:** Read-only analyst. It reports drift; a human (or the cleanup agent, per item) resolves it.
- **Why it works:** drift between two systems of record is invisible until it is expensive — an orphaned
  resource nobody bills for, a paying account with nothing running. Nobody schedules this check by hand
  because it is boring, which is exactly the argument for an agent.

```create-agent
Create an agent called "record-reconciler".

Job: compare two systems that are supposed to agree — our application records against what actually
exists in the infrastructure — and report every record that is in one and not the other, with enough
detail to act on.

Trigger: a daily schedule.

Safety posture: Read-only analyst. Report the drift; never delete or create anything to resolve it.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Cleanup / reclamation agent

Builds an evidence-backed list of things that should no longer exist — orphaned resources, records with
no matching object, expired temporary environments — gets explicit sign-off **per item**, then deletes
one at a time and verifies the capacity came back.

- **Trigger:** a person, monthly or when you are short on capacity.
- **Posture:** Per-item explicit sign-off.
- **Why it works:** deletion is the most dangerous thing an agent can do, so it gets the strictest
  posture. Evidence first, approval per item, verification after — never a batch delete.

```create-agent
Create an agent called "cleanup-agent".

Job: build an evidence-backed list of things that should no longer exist — orphaned resources,
records with no matching object, expired temporary environments — then, after sign-off, delete them
one at a time and verify the capacity came back.

Trigger: a person, monthly or when we are short on capacity.

Safety posture: Per-item explicit sign-off. Evidence first, approval for EACH item, verification
after — never a batch delete.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Migration / cutover runner

Runs a scripted move of a workload from one place to another inside a maintenance window: read-only
preflight, wait for a human OK, execute the real cutover, verify, then draft the customer comms for a
human to send.

- **Trigger:** a person, scheduled into a window.
- **Posture:** Per-item explicit sign-off, with a mandatory dry-run first.

```create-agent
Create an agent called "cutover-runner".

Job: run a scripted move of a workload from one place to another inside a maintenance window —
read-only preflight, wait for a human OK, execute the cutover, verify it, then draft the customer
comms for a human to send.

Trigger: a person, scheduled into a window.

Safety posture: Per-item explicit sign-off, with a mandatory dry-run first. It never sends the
customer comms itself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### New-host onboarder

Takes a freshly provisioned machine from bare to serving: verifies the hardware, hardens it, runs the
full bootstrap, registers it, and proves it serves real traffic before it is put in rotation.

- **Trigger:** a person, when a new machine arrives.
- **Posture:** Diagnose and propose for anything destructive; execute the additive bootstrap.

```create-agent
Create an agent called "host-onboarder".

Job: take a freshly provisioned machine from bare to serving — verify the hardware, harden it, run
the full bootstrap, register it, and prove it serves real traffic before it goes into rotation.

Trigger: a person, when a new machine arrives.

Safety posture: Diagnose and propose for anything destructive; execute the additive bootstrap
itself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Engineering

Engineering agents work well precisely because engineering already has a review gate. The agent stops
at the pull request and the existing human process takes over — no new trust needs to be invented.

### Bug fixer

Turns a production exception from your monitoring tool into a minimal, reviewed fix: diagnoses the root
cause from the stack trace and the source, ships **one small pull request per bug**, files a tracking
task, and closes the loop on the monitoring issue.

- **Trigger:** webhook when a new exception is opened, plus a scheduled backlog triage pass.
- **Posture:** Pull request only; a human merges.
- **Why it works:** the scope is bounded by the stack trace. "One small PR per bug" is the load-bearing
  constraint — an agent allowed to fix three things at once produces a PR nobody wants to review.

```
Take the newest unresolved production exception. Reproduce the failure path in the source,
find the minimal correct fix, and open one small pull request against a fresh branch. Include
the stack trace and your reasoning in the PR body. File a tracking task and link the PR. Do
not touch production and do not merge.
```

```create-agent
Create an agent called "bug-fixer".

Job: turn a production exception from our monitoring tool into a minimal, reviewed fix — diagnose the
root cause from the stack trace and the source, ship ONE small pull request per bug, file a tracking
task, and close the loop on the monitoring issue.

Trigger: a webhook when a new exception is opened, plus a scheduled backlog triage pass.

Safety posture: Pull request only. One small PR per bug is load-bearing — it must not fix three things
at once. It never touches production and never merges.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Independent code reviewer

Reviews a diff or pull request **in isolation** — only the work product, never the author's session —
with a correctness-and-security pass and a spec-adherence pass, returning a severity-tiered verdict.

- **Trigger:** webhook on pull request opened, or a person asking.
- **Posture:** Advisory only. It gates the decision; a human merges.
- **Why it works:** isolation is the whole point. A reviewer that can see how the code was written
  inherits the author's assumptions and stops being a second opinion.

```create-agent
Create an agent called "code-reviewer".

Job: review a diff or pull request in isolation — only the work product, never the author's session —
with a correctness-and-security pass and a spec-adherence pass, returning a severity-tiered verdict.

Trigger: a webhook on pull request opened, or a person asking.

Safety posture: Advisory only. It gates the decision; a human merges. Isolation is the point — it must
never read how the code was written.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### End-to-end QA agent

Validates a fix or a feature for real: checks out the code under test, spins up a **throwaway**
environment, drives the actual user flow in a real browser, captures screenshots, and posts a pass/fail
verdict with evidence.

- **Trigger:** webhook on pull request ready for review, or a person.
- **Posture:** Sandbox first — never touches production, and the environment is disposable.
- **Why it works:** this is the agent that converts "the tests pass" into "the feature works", and it is
  safe by construction because everything it touches is thrown away afterwards.

```create-agent
Create an agent called "qa-agent".

Job: validate a fix or a feature for real — check out the code under test, spin up a THROWAWAY
environment, drive the actual user flow in a real browser, capture screenshots, and post a pass/fail
verdict with evidence.

Trigger: a webhook on pull request ready for review, or a person.

Safety posture: Sandbox first. It never touches production, and every environment it creates is
disposable.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Release shepherd

Verifies a change is promotion-ready, cherry-picks the exact commits onto a fresh branch off the
production branch, opens a correctly-scoped promotion pull request as a draft, watches CI, and reports
post-deploy health plus the rollback path.

- **Trigger:** a person, at release time.
- **Posture:** Pull request only. It never merges, never deploys, never touches production.

```create-agent
Create an agent called "release-shepherd".

Job: verify a change is promotion-ready, cherry-pick the exact commits onto a fresh branch off the
production branch, open a correctly-scoped promotion pull request as a draft, watch CI, and report
post-deploy health plus the rollback path.

Trigger: a person, at release time.

Safety posture: Pull request only. It never merges, never deploys, never touches production.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Build failure sweep

Sweeps your build and packaging pipelines daily for things that are broken and have stayed broken — a
failing image build, a package that no longer publishes, a scheduled job that has silently errored for
days — and makes sure a human actually hears about it.

- **Trigger:** daily schedule.
- **Posture:** Diagnose and propose. It reads the failing logs and says what broke; it does not push a fix.
- **Why it works:** CI shouts loudly the moment a build breaks and then never mentions it again. The
  failures that cost you are the ones that broke three weeks ago in a pipeline nobody watches.

```create-agent
Create an agent called "build-sweep".

Job: sweep our build and packaging pipelines daily for anything broken and still broken — failing
image builds, packages that no longer publish, scheduled jobs that have been erroring for days. Read
the failing logs, say what broke and since when, and make sure a human hears about it.

Trigger: a daily schedule.

Safety posture: Diagnose and propose. Never push a fix or re-run a deploy yourself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Documentation writer

Reads what actually shipped — merged pull requests, changelog entries — since the last sync, finds the
user-facing gaps, and opens a documentation pull request. Optionally drafts the customer-facing
"what's new" entry.

- **Trigger:** daily schedule, or a webhook on merge to the main branch.
- **Posture:** Pull request only.
- **Why it works:** documentation drift is the classic never-urgent task. An agent that opens a draft
  PR converts it from "write the docs" to "review this doc PR", which people will actually do.

```create-agent
Create an agent called "docs-writer".

Job: read what actually shipped since the last sync — merged pull requests, changelog entries — find
the user-facing gaps, and open a documentation pull request. Optionally draft the customer-facing
"what's new" entry.

Trigger: a daily schedule, or a webhook on merge to the main branch.

Safety posture: Pull request only. It never publishes and never merges.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Marketing, SEO and content

The department with the widest agent variety, because so much of the work is research followed by a
draft. Almost all of it is safe: the output is a document, and publishing stays behind a human.

### Daily marketing operator

Pulls the day's numbers from your analytics, search console and SEO tooling, analyses what moved,
produces or updates content against the plan, and delivers a morning briefing to your chat channel.

- **Trigger:** daily schedule, weekday mornings.
- **Posture:** Draft, never send — for outbound email and ads. Publishing to your own site can be
  allowed once the agent has a track record.
- **Why it works:** it turns several dashboards nobody opens into one message everybody reads.

```
Every weekday morning: pull yesterday's traffic, search performance, and ranking changes.
Compare against the trailing 7-day and 28-day averages. Identify the three biggest movers and
say why each moved. Then post a short briefing to the marketing channel — numbers, what
changed, and the single highest-leverage action for today.
```

```create-agent
Create an agent called "marketing-operator".

Job: pull yesterday's traffic, search performance and ranking changes, compare against the trailing
7-day and 28-day averages, identify the three biggest movers and why each moved, then post a short
briefing to our marketing channel with the single highest-leverage action for today.

Trigger: a daily schedule, weekday mornings.

Safety posture: Draft, never send for outbound email and ads. It may post the internal briefing to our
own chat channel.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Content optimiser

Takes an existing published page, audits the pages currently outranking it, rewrites for search intent
and answer-engine retrieval while preserving every existing link, and pushes a publish-ready draft.

- **Trigger:** a person, or a weekly schedule over a prioritised page list.
- **Posture:** Draft, never publish.

```create-agent
Create an agent called "content-optimiser".

Job: take an existing published page, audit the pages currently outranking it, and rewrite for search
intent and answer-engine retrieval while preserving every existing link — then push a publish-ready
draft.

Trigger: a person, or a weekly schedule over a prioritised page list.

Safety posture: Draft, never publish.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Search performance analyst

Pulls search-console data and returns a **ranked, specific** list of the highest-leverage actions to
grow clicks and click-through rate — not a dashboard, a to-do list.

- **Trigger:** weekly schedule.
- **Posture:** Read-only analyst.

```create-agent
Create an agent called "search-analyst".

Job: pull search-console data and return a ranked, specific list of the highest-leverage actions to
grow clicks and click-through rate. Not a dashboard — a to-do list.

Trigger: a weekly schedule.

Safety posture: Read-only analyst.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Audience listener

Sweeps the public places where your users actually talk — forums, communities, review sites — clusters
what they ask and complain about into evidence-backed themes, and files content briefs.

- **Trigger:** weekly schedule.
- **Posture:** Read-only. It listens; it never posts.
- **Why it works:** the "never posts" rule is what makes it deployable. Listening is pure upside;
  automated posting is a brand risk nobody needs.

```create-agent
Create an agent called "audience-listener".

Job: sweep the public places where our users actually talk — forums, communities, review sites —
cluster what they ask and complain about into evidence-backed themes, and file content briefs.

Trigger: a weekly schedule.

Safety posture: Read-only. It listens; it NEVER posts anywhere public. That rule is what makes it
deployable.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Newsletter and campaign drafter

Researches what genuinely shipped, writes the copy, and stages a **draft** campaign in your email tool
with a test send for QA.

- **Trigger:** schedule matching your send cadence.
- **Posture:** Draft, never send. The agent must not be able to reach the real list.

```create-agent
Create an agent called "campaign-drafter".

Job: research what genuinely shipped, write the copy, and stage a draft campaign in our email tool
with a test send for QA.

Trigger: a schedule matching our send cadence.

Safety posture: Draft, never send. It must not be able to reach the real list at all.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Asset producers

Narrow, high-repetition production jobs, each its own agent: header images, product screenshots and
mockups, short feature videos, screencast tutorials recorded in a disposable demo environment, video
scripts.

- **Trigger:** a person, or a task filed by another agent.
- **Posture:** Sandbox first for anything that records a live product; output is files, a human places
  them.

```create-agent
Create an agent called "asset-producer".

Job: one narrow, high-repetition production job — pick ONE of: header images, product screenshots and
mockups, short feature videos, screencast tutorials recorded in a disposable demo environment, or
video scripts. One agent per job, not a generalist.

Trigger: a person, or a task filed by another agent.

Safety posture: Sandbox first for anything that records a live product. The output is files; a human
places them.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Customer success and lifecycle

Where agents make the most *revenue* difference, and where the safety posture matters most, because the
output is an email to a real customer.

### Onboarding first-touch

Each day finds users who signed up a few days ago, triages them by what they have actually done in the
product, and drafts a genuinely personalised first email to the ones worth a real conversation — then a
small number of follow-ups if there is no reply. **Stops the instant they answer** and hands off to a
human.

- **Trigger:** daily schedule.
- **Posture:** Draft, never send — until you have read a few weeks of drafts and trust it.
- **Why it works:** personalisation at volume is the thing humans cannot do and agents can. The three
  non-negotiable rules: never mass-mail, never email the same person twice for the same reason, stop on
  reply.

```
Find users who signed up 3 days ago and verified. For each, look at what they actually did in
the product — not just that they signed up. Skip anyone who is clearly not evaluating
seriously. For the rest, draft a short, specific first email that references what they built.
No template language. Draft only; do not send. Skip anyone already contacted.
```

```create-agent
Create an agent called "onboarding-first-touch".

Job: each day, find users who signed up a few days ago and verified, triage them by what they have
actually DONE in the product, and draft a short, specific first email to the ones worth a real
conversation — referencing what they built, with no template language. Then a small number of
follow-ups if there is no reply.

Trigger: a daily schedule.

Safety posture: Draft, never send. Three non-negotiable rules: never mass-mail, never email the same
person twice for the same reason, and stop the instant they reply and hand off to a human.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Pipeline status reporter

Keeps the shared tracking sheet or CRM honest — reads the real state of each account or deal from the
source systems and updates the status, last-touch and next-step columns so the pipeline everyone reads
in the morning matches reality.

- **Trigger:** daily schedule, early.
- **Posture:** Writes to your internal tracker only. It never contacts a customer, and never changes a
  record in the system it reads from.
- **Why it works:** the status sheet is the artefact a whole team steers by, and it is always the first
  thing to go stale because updating it is nobody's actual job.

```create-agent
Create an agent called "pipeline-status".

Job: keep our shared tracking sheet honest — read the real state of each account from the source
systems and update the status, last-touch and next-step columns so the pipeline matches reality.

Trigger: a daily schedule, early in the morning.

Safety posture: Writes to our internal tracker ONLY. It must never contact a customer, and never
modify a record in the systems it reads from.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Churn investigator

Finds accounts that just cancelled or removed their last active resource, reconstructs *why* from the
event trail and their account state, drafts a personal "what happened?" note for review, and — more
valuably — surfaces the recurring failure patterns worth fixing in the product.

- **Trigger:** daily schedule.
- **Posture:** Draft, never send.
- **Why it works:** the per-customer email is the visible output; the pattern report is the one that
  changes the roadmap.

```create-agent
Create an agent called "churn-investigator".

Job: find accounts that just cancelled or removed their last active resource, reconstruct WHY from
the event trail and their account state, draft a personal "what happened?" note for review, and —
more valuably — report the recurring failure patterns worth fixing in the product.

Trigger: a daily schedule.

Safety posture: Draft, never send.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Trial and credit lifecycle

Finds users who exhausted a trial or free allowance, works out what they were trying to do, and drafts
a genuine question about their use case rather than a discount blast.

- **Trigger:** daily schedule.
- **Posture:** Draft, never send.

```create-agent
Create an agent called "trial-lifecycle".

Job: find users who exhausted a trial or free allowance, work out what they were trying to do, and
draft a genuine question about their use case — not a discount blast.

Trigger: a daily schedule.

Safety posture: Draft, never send.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Sales research analyst

Answers customer and segment questions from your production data, read-only, and builds targeted lead
lists to a specification. Given one lead, researches their account context and public presence, scores
them against your ideal customer profile, and drafts personalised outreach.

- **Trigger:** a person, from chat.
- **Posture:** Read-only analyst; drafts only for anything outbound.

```create-agent
Create an agent called "sales-research-analyst".

Job: answer customer and segment questions from our production data read-only, and build targeted
lead lists to a specification. Given one lead, research their account context and public presence,
score them against our ideal customer profile, and draft personalised outreach.

Trigger: a person, from chat.

Safety posture: Read-only analyst; drafts only for anything outbound.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Finance and billing

The strictest read-only postures in the catalog, and worth it — the findings are denominated in money.

### Billing reconciler

Compares your ledgers against each other — what was served, what was invoiced, what was actually
collected — and reports every disagreement **ranked by dollars at risk**. Finds unbilled usage, missed
webhooks, failed credit applications, and worker output errors.

- **Trigger:** weekly schedule.
- **Posture:** Read-only on money. It never voids, refunds, charges, or writes to a billing table.
- **Why it works:** reconciliation is high-value, purely analytical, and something no one does often
  enough by hand. Ranking by dollars at risk is what makes the report actionable in five minutes.

```create-agent
Create an agent called "billing-reconciler".

Job: compare our ledgers against each other — what was served, what was invoiced, what was actually
collected — and report every disagreement RANKED BY DOLLARS AT RISK. Find unbilled usage, missed
webhooks, failed credit applications, and worker output errors.

Trigger: a weekly schedule.

Safety posture: Read-only on money. It never voids, refunds, charges, or writes to a billing table.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Spend analyst

Reads your corporate card and bank accounts to answer where the money went: spend by vendor, category
and person, burn and runway, unusual charges, month-over-month drift.

- **Trigger:** monthly schedule, plus a person asking.
- **Posture:** Read-only on money; a human moves it.

```create-agent
Create an agent called "spend-analyst".

Job: read our corporate card and bank accounts to answer where the money went — spend by vendor,
category and person, burn and runway, unusual charges, month-over-month drift.

Trigger: a monthly schedule, plus a person asking.

Safety posture: Read-only on money; a human moves it.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Subscription investigator

Audits subscriptions, reconciles invoices against usage, investigates charge disputes, and explains in
plain English what a given customer is paying and why.

- **Trigger:** a person, usually from a support escalation.
- **Posture:** Read-only. Prepares money movement; a human executes it.

```create-agent
Create an agent called "subscription-investigator".

Job: audit subscriptions, reconcile invoices against usage, investigate charge disputes, and explain
in plain English what a given customer is paying and why.

Trigger: a person, usually from a support escalation.

Safety posture: Read-only. It prepares money movement; a human executes it.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Security and trust

### Vulnerability watch

Sweeps authoritative feeds for new vulnerabilities affecting your stack, assesses **how exposed you
actually are**, maps each to a concrete mitigation you can apply, and submits a prioritised go/no-go
report.

- **Trigger:** daily sweep that stays **silent unless something lands**, plus a weekly digest.
- **Posture:** Read-only and advisory. It never remediates on its own.
- **Why it works:** the silent-unless-something-lands rule is what keeps the weekly digest credible.
  A daily "nothing to report" email trains people to filter the channel.

```create-agent
Create an agent called "vulnerability-watch".

Job: sweep authoritative feeds for new vulnerabilities affecting our stack, assess how exposed we
ACTUALLY are, map each to a concrete mitigation we can apply, and submit a prioritised go/no-go
report.

Trigger: a daily sweep that stays SILENT unless something lands, plus a weekly digest.

Safety posture: Read-only and advisory. It never remediates on its own. The silent-unless-something-
lands rule is what keeps the digest credible.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Abuse and phishing triage

Triages inbound abuse reports, confirms the resource is yours, checks reputation against public threat
feeds, and suspends what is confirmed malicious.

- **Trigger:** webhook from your abuse mailbox, or a person.
- **Posture:** Per-item explicit sign-off — suspension is destructive and pauses for approval. It
  documents and notifies either way.

```create-agent
Create an agent called "abuse-triage".

Job: triage inbound abuse reports, confirm the resource is ours, check reputation against public
threat feeds, and suspend what is confirmed malicious.

Trigger: a webhook from our abuse mailbox, or a person.

Safety posture: Per-item explicit sign-off — suspension is destructive and pauses for approval. It
documents and notifies either way.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Edge protection tuner

Reviews what your WAF, CDN or bot protection blocked in the last day, separates real attacks from
legitimate traffic caught by an over-broad rule, and proposes rule changes with the evidence for each.

- **Trigger:** daily schedule.
- **Posture:** Diagnose and propose. Every rule change is a proposal; a human applies it.
- **Why it works:** edge rules are set once and then quietly block paying customers for months. The
  agent's real output is not the attack list — it is the false-positive list, which nobody was going to
  find by hand.

```create-agent
Create an agent called "edge-tuner".

Job: review what our WAF/CDN/bot protection blocked in the last day, separate real attacks from
legitimate traffic caught by an over-broad rule, and propose rule changes with the evidence for each.
Call out false positives first — blocked customers matter more than blocked attackers.

Trigger: a daily schedule.

Safety posture: Diagnose and propose. Every rule change is a proposal a human applies; change nothing
yourself.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Fraud detection

Detects fraudulent and abusive accounts — duplicate identities, resource mining, stolen payment
instruments — contains what it can reversibly, documents the evidence, and **stages** the irreversible
cleanup for a human.

- **Trigger:** daily schedule.
- **Posture:** Per-item explicit sign-off for anything irreversible.

```create-agent
Create an agent called "fraud-detection".

Job: detect fraudulent and abusive accounts — duplicate identities, resource mining, stolen payment
instruments — contain what it can reversibly, document the evidence, and STAGE the irreversible
cleanup for a human.

Trigger: a daily schedule.

Safety posture: Per-item explicit sign-off for anything irreversible.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Running the fleet itself

Once you have more than a handful of agents, some of the work is about the agents.

### Agent author

Interviews you about a role, drafts the agent's system prompt and capability list, and creates it live.

- **Trigger:** a person.
- **Posture:** Creates agents; changes to *other* agents are proposals a human approves.
- **Why it works:** this is the agent most new installs should create second (after their first real
  one). Writing a good agent prompt is a skill, and this is how you avoid needing it.

### Router / front door

Reads an incoming request from a shared channel, works out which specialist should own it, and delegates
via the shared task queue. Handles trivial asks itself; never does the specialist work.

- **Trigger:** chat message or inbound webhook.
- **Posture:** Delegate only.
- **Why it works:** it gives humans a single place to ask for things. **Caveat:** a router is only worth
  it once you have enough specialists that people cannot remember which to call. Before that it is a
  layer of indirection that spends tokens deciding to do nothing.

```create-agent
Create an agent called "router".

Job: read an incoming request from a shared channel, work out which specialist should own it, and
delegate via the shared task queue. Handle trivial asks itself; never do the specialist work.

Trigger: a chat message or an inbound webhook.

Safety posture: Delegate only.

Only worth creating once we have enough specialists that people cannot remember which to call — if we
do not, tell me so instead of creating it.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Attention digest

Scans your project tracker and delivers a short, prioritised "needs your attention" digest — decisions
waiting, blockers, at-risk deadlines, unowned work.

- **Trigger:** weekday-morning schedule.
- **Posture:** Read-only analyst.

```create-agent
Create an agent called "attention-digest".

Job: scan our project tracker and deliver a short, prioritised "needs your attention" digest —
decisions waiting, blockers, at-risk deadlines, unowned work.

Trigger: a weekday-morning schedule.

Safety posture: Read-only analyst.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Goal planner

Turns a stated company goal into a reviewable plan of tasks assigned across the fleet.

- **Trigger:** a person, at planning time.
- **Posture:** Proposes a plan; a human approves before anything dispatches.

```create-agent
Create an agent called "goal-planner".

Job: turn a stated company goal into a reviewable plan of tasks assigned across the fleet.

Trigger: a person, at planning time.

Safety posture: Proposes a plan; a human approves before anything dispatches.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Pipeline watchdog

A liveness check on a chain of agents. Confirms the queue another agent works from is still moving —
something was picked up, something was finished — and if the chain has stalled, says so and re-kicks it.

- **Trigger:** schedule, more often than the pipeline it watches.
- **Posture:** Checks liveness and re-dispatches; it never does the work itself.
- **Why it works:** an unattended chain fails silently. Nothing errors, nothing alerts, work simply stops
  moving and you find out days later. **Keep it dumb** — the moment the watchdog starts doing the stalled
  work itself you have two agents doing the same job and no one watching either.

```create-agent
Create an agent called "pipeline-watchdog".

Job: be the liveness check for a chain of agents. Confirm the queue they work from is still moving —
something picked up, something finished, within the expected window. If it has stalled, say so and
re-dispatch it.

Trigger: a schedule that runs more often than the pipeline it watches.

Safety posture: Liveness check and re-dispatch only. It must NEVER do the stalled work itself — if
the pipeline is stuck for a reason it cannot fix, it reports and stops.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

### Output quality reviewer

Scores what your agents produced yesterday against a written rubric — were the drafts accurate, was the
evidence real, did the recommendation follow from it — and reports the patterns, not the individual marks.

- **Trigger:** daily or weekly schedule.
- **Posture:** Read-only analyst. It grades; it never edits another agent or its output.
- **Why it works:** it is the only cheap way to find out whether an unattended agent is still good, and
  it must be a **different agent** than the one being graded. An agent scoring its own work reports
  success indefinitely.

```create-agent
Create an agent called "quality-reviewer".

Job: score what our agents produced in the last period against a written rubric — accuracy, whether
the evidence is real and checkable, whether the recommendation follows from it. Report the recurring
patterns and the worst examples, not a mark for every item.

Trigger: a daily or weekly schedule.

Safety posture: Read-only analyst. It grades output; it never edits another agent, its prompt, or its
work. It must never be asked to grade its own output.

Write the system prompt yourself and set its capabilities to match that posture, then create
it. If you need to know which tools we use or where that data lives, ask me before you create
anything.
```

---

## Pre-registered readbacks

The habit that separates a fleet that ships from a fleet that reports. When an agent makes a change
meant to move a number — a page rewrite, a pricing tweak, a fix deployed to production, a campaign sent
— it **books its own follow-up before it finishes**: a one-off run scheduled for 14, 28 or 30 days out
that comes back, measures the same number the same way, and writes down the verdict.

Any agent can do this: the `schedule` tool defers a future run of itself, and the deferred prompt
carries the task id so the follow-up rejoins the same thread of work.

Why it earns its own section:

- **It is written before the result is known.** Deciding the success criterion in advance is what stops
  the readback from being a story assembled around whatever happened. Put the criterion in the task, not
  in the follow-up prompt.
- **It closes the loop nobody closes by hand.** A human ships a change, intends to check it in a month,
  and does not. The agent's calendar does not have that failure mode.
- **It is where "did this work?" comes from.** A stack of readbacks is a real record of which changes
  moved a number and which did not — the only honest input to the question of what your fleet is worth.

What a good readback looks like:

| Part | Rule |
|---|---|
| **When** | Fixed at ship time, matched to how long the metric needs to settle — not "in a while" |
| **What** | The same query, the same window length, the same source as the baseline |
| **Baseline** | Recorded before the change, in the task, not reconstructed afterwards |
| **Verdict** | Explicitly allowed to be "no effect" or "made it worse", and closes the task either way |
| **Self-contained** | The follow-up prompt assumes nothing is remembered — a run a month later is a fresh session |

Two failure modes to design out. A readback that only ever reports success is measuring the reporting,
not the change — the same trap as an agent grading its own work. And a change with no readback booked is
a change nobody will ever be able to defend; if the metric is not worth a follow-up, say so at ship time
rather than leaving the question open forever.

---

## The six safety postures

Every agent above is one of these. Choose the strictest one that still gets the job done, and only
loosen it after the agent has a track record you have personally reviewed.

| Posture | The rule | Use it for |
|---|---|---|
| **Read-only analyst** | Never writes anywhere. Output is a report. | Finance, traffic, churn, quality analysis |
| **Draft, never send** | Produces the artefact; a human presses send. | Every email, every customer-facing reply |
| **Diagnose and propose** | Reports the cause *and the exact fix command*, runs nothing. | Infrastructure, production incidents |
| **Pull request only** | Ships code as a PR; never merges, never deploys. | All engineering work |
| **Sandbox first** | Only ever touches a disposable environment. | QA, demos, recordings, experiments |
| **Per-item sign-off** | Evidence, then approval for *each* item, then verify. | Deletions, suspensions, migrations, refunds |

The postures are conventions you write into the agent's prompt. What **enforces** them is the policy
layer — capabilities the agent may use, which ones stop for a human, and at what approval level. Write
the posture into the prompt so the agent understands its job, and into policy so the boundary holds even
if the prompt is ignored. See [Governance & approvals](#/docs/governance).

---

## The trigger catalog

Six ways an agent starts. Most mature installs use all six, and the mix shifts over time — early on
almost everything is a person clicking Run; later, schedules and agent-to-agent delegation dominate.

| Trigger | Shape | Good for |
|---|---|---|
| **Schedule** | Daily sweep · every few hours · weekly grooming · weekday-morning digest · monthly report | Anything that should happen whether or not someone remembers |
| **Webhook** | Inbound ticket · new exception · merge to main · abuse report | Reacting to another system in seconds |
| **Chat** | Someone addresses an agent by name in Slack or Discord | Ad-hoc asks, the low-friction front door |
| **Console** | A person picks an agent and gives it a task | Exploration, one-offs, anything new |
| **Delegation** | One agent files a task for another and optionally waits for the result | Specialist hand-offs — the front door routes, the specialist works |
| **Deferred self-schedule** | An agent books a one-off future run of itself — a follow-up check days or weeks out | Pre-registered readbacks: did the change we shipped actually work? |

Two rules learned the hard way:

- **A scheduled sweep should be silent when there is nothing to say.** An agent that reports "all
  clear" daily gets filtered within two weeks, and then the one real alert is filtered too.
- **Watch delegation.** Agent-to-agent hand-offs become the largest source of runs faster than you
  expect. That is healthy when a specialist does real work, and pure cost when an agent is delegating to
  a colleague who will decide there is nothing to do. If a chain of agents keeps concluding "no action
  needed", the fix is a tighter trigger, not a smarter agent.

---

## What ships in the box

Agentric installs with a starter fleet you can run on day one and specialise later. Each one is a
**generalist** for its function — deliberately, because on a fresh install nobody knows your business yet
— and each carries an explicit safety posture already written into its prompt:

| Agent | Function | Posture |
|---|---|---|
| `support` | Triage, investigate, reply | Draft, never send |
| `engineer` | Code, debugging, fixes | Pull request only |
| `reviewer` | Independent review of a change, plan or claim | Advisory only |
| `ops` | Running systems, incidents, health | Diagnose and propose |
| `data-analyst` | Metrics, investigations, reporting | Read-only analyst |
| `finance` | Bookkeeping, reconciliation, budgets | Read-only on money |
| `researcher` | Open questions, sourced answers | Read-only |
| `marketer` | Copy, campaigns, repurposing | Draft, never send |
| `sales` | Qualification, outreach, proposals | Draft, never send |
| `writer` | Long-form, docs, editing | Draft, never publish |
| `designer` | UX, UI, critique | Advisory |
| `product-manager` | Specs, scoping, sequencing | Propose, don't dispatch |
| `app-builder` | Small internal tools that run in the console | A human publishes |
| `agent-author` | Builds and refines the rest of the fleet | Proposes edits to other agents |

Use them as-is to find out what you actually need, then have `agent-author` turn the ones you lean on
into the narrow specialists above — a `support` agent that has learned your product is worth more than
any prompt shipped by us.

## Picking your first three

A sequence that works for most teams:

1. **An on-demand diagnostician for your most painful system.** Support tickets or production
   incidents, whichever wakes you up more. Read-only, invoked by a person from chat. Costs nothing when
   idle, and you will learn what your agents actually need access to.
2. **One scheduled sweep.** Take the diagnostician that just proved itself and give it a schedule —
   a daily support pass, or a fleet health check every few hours. This is where unattended running
   starts, so keep the posture strict and read the output every day for the first week.
3. **The agent author.** By now you know what a good prompt looks like for your business. Let it build
   the next ten.

After that, follow the pain. The best fourth agent is whatever your team complained about most this
week — not whatever sounds most impressive.

## What does not work

Honest failure modes, so you can skip them:

- **The generalist.** An agent whose description contains three "and"s will do all three badly. Split it.
- **The agent that emails customers unsupervised, early.** Draft-only is not a training-wheels phase you
  graduate from in week two. Read a few weeks of its drafts first.
- **The daily "all clear" report.** See above — silence is a feature.
- **A router with nobody to route to.** Build specialists first.
- **A cleanup agent with batch approval.** Per item, or not at all.
- **Automating a process nobody has written down.** If no human can describe the steps, the agent will
  invent them. Write the playbook first — then the agent's prompt is mostly that playbook, and it works
  on the first try.

---

## Related

| Page | What it covers |
|---|---|
| [Governance & approvals](#/docs/governance) | Policy, approvals, budgets, identity — what enforces a posture |
| [Working with agents](#/docs/working-with-agents) | Every tool an agent can call, and its governance notes |
| [Automations](#/docs/automations) | Wiring schedules, webhooks and chat triggers |
| [Memory, Knowledge & Tasks](#/docs/shared-planes) | The task queue and the delegation model, and how an agent gets better at its job over time |
