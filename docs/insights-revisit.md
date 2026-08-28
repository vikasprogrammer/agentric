# Insights — revisit (audit + rebuild from scratch)

> **Status (2026-08-08): audit complete, rebuild not started.** Insights shipped in 2026-06 as the
> self-learning loop ([`self-learning-plan.md`](./self-learning-plan.md)) and has accreted six more
> engines since. This document measures what it has actually produced on the two busiest live tenants,
> names why, and sequences a rebuild **one step at a time** — each step independently shippable, each
> gated on live evidence before the next begins.
>
> Headline: the whole stack is built on a self-reported outcome signal with **one recorded failure in
> 329 reports**, and its only auto-applied output currently tells every agent in the fleet to "slow
> down" about a failure rate that does not exist in the data.

## 1. What exists today

One admin-only page (`DreamingSettings` in `web/src/App.tsx`, ~800 lines) rendering **14 blocks**:

| Block | Source | Kind |
|---|---|---|
| What it figured out (injected guidance) | `dreaming.ts` `deriveGuidance` | auto-applied, fleet-wide |
| Things to consider (recommendations) | `dreaming.ts` `deriveRecommendations` | human-gated |
| Review history | `dreaming_state.recent` | passive |
| Fleet scorecard | `insights.ts` `buildInsights` | passive |
| Friction | `insights.ts` | passive |
| Is it working? | `measurement.ts` `measureLearning` | passive |
| Improvement tiles | `improvements.ts` / `improver.ts` | action |
| Memory cleanup / KB tidy / task reconcile / library declutter / session archive | `memory-cleanup.ts`, `kb-tidy.ts`, `task-reconcile.ts`, `library-tidy.ts`, `session-tidy.ts` | janitorial (5 blocks) |
| Stuck goals | `strategist.ts` | action |
| Troubled automations | `insights.ts` / `reliability.ts` | action |
| Daily digest config + preview | `digest.ts` | push surface |
| Alerts toggle + cadence + settings | `alerts.ts`, `dreaming.ts` | config |

Backing modules: `dreaming.ts` (612 lines), `insights.ts`, `measurement.ts`, `improvements.ts`,
`improver.ts`, `diagnosis.ts`, `alerts.ts` — ~1000 lines beyond dreaming.

## 2. The evidence

Measured 2026-08-08 against the live DBs (queries in §6). Two tenants: **northwind** (Mac Mini,
`~/agent-os-data/northwind`) and **globex** (203.0.113.13, the busiest).

### 2a. Human actions taken — near zero

| Signal | northwind | globex |
|---|---|---|
| Reflect passes | 27 | 22 |
| Sessions folded | 635 | 1830 |
| Open recommendations (now) | **0** | **0** |
| Recommendations dismissed (ever) | **0** | **0** |
| `recommendation.applied` (ever) | **1** | **0** |
| `insights.improve.applied` (ever) | **1** | 0 |
| Janitorial applies, 30d (all five) | **0** | — |
| `digest.posted` | **26** | — |

The only surface with sustained consumption is the **pushed** one (the digest), not the page.

### 2b. Alerts fire; nothing is proposed

globex `insights.alert` by key (lifetime):

```
agent-crash:website-bot   8      agent-crash:customer-bot  8
agent-crash:infra-ops     8      agent-crash:engineer      5
agent-crash:gsc-analyst   8      pending-approvals         2
agent-crash:docs-bot      8      agent-low:docs-bot        1
```

**40 of 48 alerts are one class — five agents crash-looping — and the recommendation engine produced
zero cards about it.** The system noticed the fleet's biggest operational problem and had nothing to
propose. Alerts (`alerts.ts`) and recommendations (`dreaming.ts`) are two disconnected engines over
the same data.

### 2c. The outcome signal is not a signal

northwind `session.reported` outcomes, lifetime:

```
success 281 · partial 46 · failure 1 · completed 1
```

**One reported failure, ever.** globex: 6 failures across 1830 sessions. Agents grade their own
homework and effectively never write "failure".

Worse, ~40% of terminated sessions never report at all. northwind, last 30d:

```
session.ended with no outcome   334
session.reported                302
term_sessions terminated        499
```

`deriveGuidance` computes `success / sessions` where `sessions` includes **unknown and stopped**. So
the shipped number means *"share of runs that called `report()` and said success"*, not *"share of
work that succeeded"*. Both tenants land at 54–57%, and both therefore inject:

> Recent success rate is 57% — slow down, confirm assumptions, and prefer asking over guessing on
> anything ambiguous.

into **every agent's system prompt, permanently**. The 2026-07-31 correction (`self-learning-plan.md`
§Correction) added a denominator to *approval* friction and missed the identical bug in the *outcome*
metric it was written next to.

### 2d. Topic extraction: three versions, 22 resets, still wrong

`learning.topics.reset`: northwind **10**, globex **12** — each reset is a `TOPICS_VERSION` bump
discarding the cumulative map. Live guidance on globex today:

> The fleet frequently works on: **total, billing, usage, auto, updates**.

Live `dreaming_state.topics` samples: `statusrunning`, `partof`, `no-op`, `cover`, `ship`, `artemii`,
`mesibalend`, `d3z43nq`, `addarecordtoroute53job`, `min-w-0`. A bag-of-words extractor with a
stop-list and a proper-noun shape test cannot name a workstream — and its output rides in every
prompt.

### 2e. The measurement loop cannot answer its own question

`measureLearning` defines an *intervention* as a `recommendation.applied` audit event. There is **1
in the fleet's entire history**. "Is it working?" measures its own never-taken actions.

### 2f. The recommendations panel is parked — and now says so (2026-08-27)

`recommendation.applied`: **1 in the fleet's entire history** (instapods, 2026-06-25). Two months on,
`learned_recommendations.open` is `[]` on both live tenants and has been throughout.

That is not a bug. Step 0 retired `runtime.effort.high` because it fired off `success / sessions`, and
what remains can only fire on two narrow, observable conditions:

| id | fires when |
| --- | --- |
| `policy.review` | ≥3 rejected approvals in the recent window **and** ≥20% rejection rate |
| `budget.review` | ≥2 budget stops in the recent window |

Neither tenant crosses either — instapods ran 14 rejections and 12 budget stops *lifetime*, spread
thin enough that no recent window qualifies. So the correct state of this surface is empty.

The defect was the **empty-state copy**, which read "if agents start hitting friction — rejected
actions, budget limits, *low success* — suggestions appear here". `low success` cannot be produced any
more; the panel was promising a signal Step 0 deleted, so an empty panel read as "all clear" rather
than "two narrow conditions, neither met". It now names both conditions with their thresholds and says
plainly that quality-keyed suggestions are absent until a derived outcome replaces the self-grade.

**Deliberately NOT done:** inventing new thresholds to fill the panel. Every candidate considered —
"upkeep is disabled", "preload is off", "this agent stores runs but not lessons" — was either a setup
nudge that belongs in the install wizard, or a quality claim resting on the same self-graded outcome
Step 0 removed. Checked against live data, the lesson-drought idea also had no subject: the worst
agent in either fleet stores 43% lessons, and the one that looked starved (`check-resolve-tickets`,
2 of 8 preamble slots) turned out to be the *most* lesson-rich at 87% — its thin preamble was the
177-way duplicate flood, fixed by the cleanup, not a content gap. A panel filled with plausible
non-signals is the exact failure this document exists to correct.

## 3. Root causes, ranked

1. **Built on telemetry that doesn't exist.** Self-graded outcome, near-zero variance, 40% missing.
   Every consumer — guidance, recommendations, measurement, scorecard, alerts — inherits it.
2. **Blast radius is inverted.** The auto-applied, fleet-wide, ungated output (guidance) got the least
   scrutiny; the human-gated output (recommendations) that never fires got the design attention.
3. **The recommendation engine has three hardcoded rules, one applyable**, and its triggers
   (rejection rate ≥20%, budget stops) are ~zero on real tenants. The list is empty by construction,
   so the page has nothing to do, so nobody opens it.
4. **Detection and proposal are not wired together** (§2b). The most valuable card the OS could write
   was already detected 40 times and never written.
5. **Measurement is self-referential** (§2e) — it should measure *outcomes*, not *our own apply clicks*.
6. **Wrong tool for topics** (§2d). An LLM consolidator already reads the same corpus every pass;
   naming three workstreams is its job, not a regex's.
7. **Pull surface, push consumption.** Admin-only page behind nav, nothing routes you there with a
   reason. The digest and alert DMs are the only things read.
8. **Junk drawer.** 5 of 14 blocks are janitorial previews with 0 applies in 30 days. Maintenance is
   not intelligence; it dilutes the page and the concept.
9. **No telemetry on the telemetry page.** No record of opens or clicks — we cannot distinguish a bad
   page from an unvisited one.

One sentence: **we built an analytics product on a metric nobody produces, and injected its
conclusions into every prompt.**

## 4. Rebuild — one thing at a time

Principles for the rebuild, each a direct inversion of a root cause:

- **A signal earns its place by producing one decision a human takes.** No block ships without a
  named action and a way to see whether it was taken.
- **Nothing is auto-injected into prompts until it survives as a human-facing card first.** Guidance
  is the highest-blast-radius channel in the OS; it goes last, not first.
- **Every number carries a denominator, a sample size, and a falsifier** (the standing lesson from
  the 2026-07-31 correction — restated here because we broke it in the adjacent metric).
- **One step at a time.** A step ships, then is measured on live data, then the next begins. Steps do
  not run in parallel.

### Step 0 — stop the harm (no new capability) ✅ shipped v0.320.1

Retire every channel that broadcasts `success / sessions`. Scoping this by *channel* rather than by
call site turned up **four**, not the two originally listed — the same number was also reaching agents
through the tenant-shared memory Insight they `recall`, and reaching humans as a DM'd alert:

| Channel | Reaches | Action |
|---|---|---|
| `deriveGuidance` success-rate line | every agent's system prompt, always | deleted |
| `deriveRecommendations` → `runtime.effort.high` | owner, as an applyable config change | deleted; `recommendationResolved` now retires persisted ones at read time |
| Tenant-shared memory Insight summary | any agent that calls `recall` | rate replaced with raw counts incl. "never reported an outcome" |
| `alerts.ts` → `success-drop` | a DM to a human | deleted (also drops a full `measureLearning` scan per alert tick) |

`agent-low` is deliberately **kept**: it gates on `a.failed >= 2`, i.e. real reported failures, so it
has evidence behind it that `success-drop` never had. The KB fleet-learnings page keeps its counts but
no longer derives a percentage from them, and states that outcome is self-reported.

- **Exit:** live `learned_guidance` on northwind + globex no longer asserts a success rate. Regenerates
  on the next reflect pass after deploy (≤2h northwind, ≤24h globex) — no migration needed.
- **Pin:** `scripts/insights-signal-test.cjs` (in `npm run test:governance`) — 19 assertions across all
  four channels, verified to fail 10 of them against the pre-fix build. Its `noRateWithoutFailures`
  case is the fixture Step 1 must satisfy: two states differing **only** in how many runs reported,
  with identical real failures, must produce identical guidance.

### Step 1 — an outcome that isn't self-graded ✅ closed at v0.330.0 (see Step 1b)

`src/edge/outcome.ts`. Rules over facts the OS observed itself, ordered, each carrying the `basis` that
decided it so any number traces back to its evidence. Live 30-day northwind corpus, 443 conversations:

| | conversations | note |
|---|---|---|
| scorable | **309** | the denominator |
| success | 186 | |
| partial | 37 | |
| failure | **28** | against **1** self-reported failure in the same corpus |
| noop | 30 | ran, called nothing — previously invisible |
| incomplete | 8 | someone else had to pick the task up |
| **unknown** | **20 = 6%** | was ~40% |
| unscorable | 134 | a person's own interactive session — outside the denominator, not counted as not-success |

Two framing decisions did more work than any rule: **the unit is a conversation** (a `poke:` resume
continues a transcript — scoring rows counts one job several times), and **not everything is scorable**
(a human closing their own pane is not a failure).

- **Exit — met.** `unknown` 6% (bar: <10%). Failure rate has variance: 9% derived vs 0.3% self-reported,
  and non-success is 40% where the old metric's complement was mostly non-reporting.
- **Falsifier — run, and it bit.** 35 conversations sampled stratified by basis, labelled blind from
  transcripts only (`scripts/outcome-label-sample.cjs` → `outcome-labels.json` → `outcome-label-score.cjs`).
  **v1 scored 50% exact against a 43% always-success baseline** — beating the baseline, but not by enough
  to build on. The disagreements were clustered and diagnostic, and bought two rules:
  - **`died-early`.** Unattended runs split by wall-clock: 2m+ → 96% report, 30–120s → 84%, **<30s → 0 of
    44**. Those are quota/auth deaths (`You've hit your weekly limit`, `401 … token has expired`) — this
    fleet's most common real failure, structurally invisible to the agent because the agent is what
    stopped existing. 19 found in 30 days.
  - **`human-session`.** v1 called a person closing their own pane `abandoned`; the labels called four of
    those successes. The OS has no verdict on an interactive session — same posture as chat.
  After both, **63% exact against a 32% baseline** (19 judged, 9 declared unscorable, 7 unlabelable for
  lack of a transcript on this box).
- **⚠ The 63% is not a clean number.** The labels were blind, but the rules were revised *after* seeing
  which rows v1 got wrong, so it is partly fitted to 28 rows. The honest, unfitted number is v1's 50%.

#### Round 2 — the re-validation, and what it says (2026-08-09)

32 conversations round 1 never touched (`--exclude`), stratified across all 9 bases, labelled blind,
scored against the rules **exactly as shipped in v0.323.0** — nothing changed after seeing the result.

| | exact | baseline | sign |
|---|---|---|---|
| round 1, v1 rules | 50% | 43% | — |
| round 1, after tuning | 63% | 32% | 74% |
| **round 2, out of sample** | **52%** | **43%** | **78%** |

**The 63% was fitting.** True out-of-sample accuracy is ~52% — nine points above "call everything a
success". Sign agreement (did work land, yes or no) holds up better at 78%, which is the number Step 2
would actually lean on, but the verdict-level signal is weak.

**This is not good enough to build Step 2 on.** The 11 disagreements cluster into three fixable causes,
and one of them reverses a decision made in Step 1:

1. **`no-evidence` → `unknown` on 5 conversations a human read in seconds** (4 successes, 1 partial) —
   runs that did substantial work and left no observable trace. This is exactly the residual the
   Stop-hook half was deferred over, and it is now the single largest error class. **That deferral was
   wrong; the hook is the fix, and Step 1 is not finished without it.**
2. **Quota deaths with zero tool calls read as `noop`** (3×). `died-early` requires `tool_calls > 0`, a
   guard round 1 bought to stop an agent replying "looks like a test message" being called a failure.
   Both shapes are an automation run, ~0 tools, a few seconds — the DB does not currently distinguish
   "died on the first API call" from "answered and stopped". It needs a fact neither has today.
3. **`task-retried` beat a later success** in a 4-run conversation (1×) — a fold-order bug, not a
   sensing problem, and the cheapest of the three to fix.

Two more disagreements were probably **my labels, not the rules**: I called two automation runs with no
assistant output at all `noop`, where `died-early` called them failures. An unattended run that produces
nothing is closer to a failure. Corrected, the exact number is ~57%.

- **Verdict: Step 1 stays open.** Step 2 does not start until (1) is closed and a third round clears
  60% out of sample on verdicts.

#### Step 1b — the three fixes, and round 3 ✅ closed at v0.330.0

The Stop-hook was still not the answer. Scanning every transcript in the corpus by current basis showed
the evidence was already on disk, 95% of the time:

```
died-early     17 of 19 carry an auth/quota signature   the rule was right about what it found
no-tool-calls  11 of 30 carry one                       scored `noop`; they are deaths
no-evidence     0 of 22 carry one — and all 22 end with a 600–3300 char closing summary
```

That last line is the finding. **There were no silent runs in the residual at all.** Every one had
finished, written a real hand-off, and simply never called `report`. A hook forcing a report would have
added a runtime change to the teardown path to re-derive something the transcript already stated — so
Step 1b reads the transcript instead, lazily, only for the runs the session row could not decide
(~50 of 477 conversations; the whole pass takes 40ms).

Three rules, each bought by a round-2 error:
- **`runtime-death`** — a quota/auth signature in the transcript *tail* → failure. Fixes the 3 deaths
  that read as `noop` because a run killed on its first API call also makes no tool calls.
- **`finished-clean`** — ended with a ≥200-char closing message and no error → success. Fixes the 5
  `no-evidence` misses.
- **fold order** — a conversation that *ends* in success is a success. Three attempts each look
  `incomplete` (that is all `task-retried` means) but the hand-off landed.

**Round 3 — 33 conversations neither earlier round touched, labelled blind, scored once:**

| | exact | baseline | sign |
|---|---|---|---|
| round 1, v1 rules | 50% | 43% | — |
| round 1, after tuning *(in-sample)* | 63% | 32% | 74% |
| round 2, out of sample | 52% | 43% | 78% |
| **round 3, out of sample** | **89%** | **46%** | **93%** |

Three disagreements in 28, all narrow: an `ask` run whose whole answer was "Answered: 42" (13 chars,
under the substantive floor); one run with no assistant output at all, where the OS says `noop` and I
say failure — the genuine ambiguity flagged in round 2; and one where the agent reported `partial` and
I read the transcript as success, i.e. the agent was harder on itself than I was.

Corpus after 1b: **unknown 1 of 328 scorable (0.3%)**, failure 39, noop 19, success 218.

- **Exit met** (bar was 60% out of sample). Step 1 is closed; Step 2 can start.
- **Standing caveat:** rounds 1 and 2 are permanently in-sample. Any future rule change needs a round 4
  on rows none of the three touched — that discipline is the only reason the 89% means anything.
- **Still not judged:** 130 interactive human sessions (28% of the corpus) and the ~5% of conversations
  with no transcript on the box.
- **Known coverage gap:** the OS declines to judge 134 of 443 conversations (30%) — every interactive
  human session. Fine for Steps 2–5, which are about unattended work; it would not be fine for a
  fleet-wide "how are we doing" claim.
- **Pinned:** `scripts/outcome-derivation-test.cjs` (23 assertions, in `test:governance`), including the
  property that the metric must move when work fails and *not* when reporting discipline changes.
- **Not done:** the Stop-hook half. See "What Step 1 did not do" below.

### Step 1 (original plan)

The blocking dependency for everything else. Derive a per-run outcome from **observable facts already
in the DB**, not from the agent's own `report`:

- task closed vs reopened / re-dispatched (`tasks`, `task_events`, `TASK_MAX_ATTEMPTS`)
- crash status (`term_sessions.status`)
- retry / re-dispatch count for the same task
- human 👍/👎 (`agent-stats.ts` ratings)
- approval rejected mid-run
- poke-back landed vs stranded

Keep `report` as one input among several, never the sole one. Separately, close the 40% hole: the
Stop hook already beacons `/api/turn-idle` — make a terminal outcome mandatory there so `unknown`
becomes rare rather than modal.

- **Exit:** on the live northwind corpus, `unknown` drops below 10% of terminated sessions, and the
  derived failure rate is **non-trivially different from 0.3%** — i.e. the metric has variance.
- **Falsifier:** hand-label 30 random runs from the live DB and compare against the derived outcome;
  publish the confusion counts in the PR. If the derived signal doesn't beat "always success", stop
  and rethink before Step 2.

#### What Step 1 did not do

**The Stop-hook half was not built, and the reason is the evidence rather than the effort.** The plan
assumed the 40% hole had to be closed at the source — make unattended runs report. Once the runs were
classified it turned out most of the hole was not missing information at all:

- 134 conversations were a person's own interactive session — never scorable, hook or no hook;
- 30 called no tool at all, and 19 died in seconds — both fully decidable from what the OS already
  recorded, and *neither could ever have self-reported* (a run killed by a quota limit has nothing left
  to report with).

That left `unknown` at 6%, under the exit bar, without touching the hook. Building it anyway would have
added a runtime change to the teardown path for a residual the derivation already handles — so it is
**deferred, not cancelled**: if Step 2's cards turn out to be blocked by those 20 conversations, the
hook is the fix, and this paragraph is the record of why it was skipped.

One thing the residual does say: those 20 are runs that did substantial work (11–95 tool calls) and left
no verdict. They are the most interesting runs in the corpus, and no observable fact decides them.

> **Reversed by round 2, then settled by Step 1b (2026-08-10).** The hook was never built: the evidence
> turned out to be on disk already (see Step 1b). What follows is the round-2 reasoning that reopened it.
>
> **Round 2 (2026-08-09).** The reasoning above is sound and the conclusion was wrong. A 6%
> residual looked negligible against the whole corpus, but those conversations are not distributed like
> the rest — they are concentrated in exactly the runs a human can judge instantly and the OS cannot, and
> they produced **5 of the 11 out-of-sample errors**. Measuring the residual by its *share* rather than by
> its share *of the mistakes* is the error. The hook is back in scope.

### Step 2 — one signal, one card, one action ✅ shipped v0.337.0 (quota/auth deaths)

The signal chosen was **runs the runtime killed** rather than repeat agent crashes: it is what the new
outcome kept surfacing, and it is costing runs now. Building it turned up a bug worth more than the card.

**The OS already knew how to fix this.** `detectUsageLimit` has always run at teardown, parking an
exhausted account (`markLimited`, self-heals at the reset) and retiring a dead token (`markInvalid`), so
the pool rotates away from it. It reads the **tmux pane** — which a run killed on its first API call has
usually already lost. Measured on the live corpus:

| | |
|---|---|
| quota/auth deaths the derived outcome finds (from the transcript) | **31** |
| of those the pane-scan detector fired on | **3** |
| `runtime.account.limited` / `.invalid` events in 30 days | **0** |

So remediation was right and simply wasn't being reached, ~90% of the time. Step 2 feeds the same
machinery from the **durable** source: when the pane says nothing, read the transcript tail. The
`usage` vs `auth` split is preserved end to end, and **auth wins a tie** — both banners often appear
together, and parking a dead token is the dangerous mistake (it "self-heals" at a reset that will never
fix it, then rejoins the pool still broken). Every detection audit now carries `via: 'pane' | 'transcript'`,
so the coverage this claims to fix is itself measurable.

**The card.** Grouped by **runtime account**, not by agent — that is what a human acts on, and the
per-agent view misleads: the top "offender" was simply the automation that runs every two hours, while
23 of 31 deaths traced to one shared account. Fires at ≥3 deaths in 48h with one in the last 12h;
different body when there is no pool account at all (add rotation, rather than re-link this one).

Present tense by construction — deaths arrive in **bursts** (22 of 31 inside two days), so a long window
would re-alert for a month about a token replaced on day three. Verified against the live corpus: the
card fires when evaluated during the burst (`19 runs killed by the "…" account in 48h`) and is silent
when evaluated today.

- **Pinned:** `scripts/runtime-death-alert-test.cjs` (13 assertions, in `test:governance`).
- **Not built:** buttons on the card. It deep-links to Settings → Runtime, where the actions already
  live; adding a bespoke action API before knowing whether anyone clicks through is the mistake this
  rebuild exists to stop. Whether the click-through happens is Step 4's measurement, and the
  `via` stamp plus `runtime.account.*` audits are enough to answer it without new plumbing.

### Step 2 (original plan)

Pick the single highest-evidence problem in the live data — **repeat agent crashes** (§2b) — and
build the whole vertical for it only:

detection → an owner-addressed Inbox card naming the agent, the count, the window, and the last
error → concrete actions on the card (diagnose · lower that agent's concurrency · disable) → an audit
event per action taken.

No new page. No second signal. Instrument the card: opened, action taken, dismissed.

- **Exit:** on globex, the five crash-looping agents produce **one card each**, and at least one card
  gets an action taken within a week.
- **Falsifier:** if cards are dismissed without action, the card is wrong — fix the card, do not add
  a second signal.

### Step 3 — deliver where humans already look → **the Journal** (`docs/journal-plan.md`)

The card from Step 2 rides the **digest** (26 posts of demonstrated readership) and the **Inbox**
(already audience-addressed, already DM-mirrored via `resolveRecipients`). The Insights page becomes
the archive/history view of cards, not the delivery mechanism.

Naming that concretely: the digest stops being block 4 of a page nobody opens and becomes **Journal**,
its own top-level surface — a day-by-day record, readable backwards in time. Planned in full in
[`journal-plan.md`](./journal-plan.md); the parts that belong to this step:

- **The delivery surface already exists and is already consumed** — the digest is the *only* block in §2a
  with sustained use, and it already writes a dated, revisioned KB page per day (`operations/daily/<iso>`).
  Reading backwards in time is a route and a query parameter, not a feature. Promoting it is therefore
  the cheapest possible test of this step's premise.
- **It carries the same broken signal Step 0 deleted elsewhere.** `buildDigest` derives its verdicts from
  `json_extract(m.metadata,'$.outcome')` — the agent's own `report()`. Step 1/1b built the replacement;
  the Journal is its first consumer (`journal-plan.md` §6), and that rewire lands **before** any narrative
  layer, because fluent prose over a signal with no variance is the original failure with better writing.
- **The AI layer is human-facing only.** The direct Anthropic key is now configurable in the console, so
  one bounded call per tenant per day can write "what actually happened" over the deterministic model
  (~$0.005/day at the Haiku default). It never reaches `buildCompanyMd` — guidance injection is the
  channel that turned a fake success rate into fleet-wide advice, and this step does not reopen it.
- **Instrumented as a before/after, not as a launch.** `journal.day.viewed` is recorded from the first
  shippable slice, so the narrative layer is measured against its own pre-narrative baseline and is
  allowed to come back negative.

- **Exit:** every card that reached a human did so without anyone opening the Insights page, and at least
  one person opens a Journal day that is not today within a week of it shipping.
- **Falsifier:** if only the current day is ever opened, the archive is not wanted — keep the today view,
  drop the day picker, and do not build the narrative layer on top of a page with no readers.

### Step 4 — measure the card, not our clicks ✅ shipped v0.339.0

Both halves of "Is it working?" were broken the same way, and this replaces both.

**The trend was still the discredited metric.** It counted a run as successful only if it self-reported
`outcome: success` — the number Step 0 deleted from every *broadcast* channel, still quietly driving the
page. It now reads the derived outcome, and carries the **undecidable share beside the rate**, so "the
work got worse" can never again be read off a number that moved because reporting discipline moved.

On the live corpus it produces a usable trend for the first time:

```
Jul 8  58%  n=31   undecidable 3%
Jul 15 54%  n=37   undecidable 3%
Jul 22 75%  n=77   undecidable 0%
Jul 29 58%  n=110  undecidable 0%
Aug 5  80%  n=162  undecidable 1%
```

**The interventions were our own Apply clicks** — `recommendation.applied`, one event in the fleet's
entire history, so the block could never answer anything. Replaced by: *a card was raised — did a human
do anything, and did the problem stop?* Counting **events, not rates**: "12 runs died, you replaced the
account, 0 died since" is a claim you can check, where a rate would hide it behind a denominator that
also moved.

Four verdicts, chosen so the uncomfortable one is reachable:

| verdict | meaning |
|---|---|
| `no-action` | **nobody acted.** A card nobody acts on is a failed card — this is the whole point |
| `resolved` | acted on, and the signal stopped |
| `ongoing` | acted on, and it kept happening |
| `too-early` | not enough time since to say |

A card whose recurrence we cannot count is **omitted entirely** rather than shown with a made-up
verdict. Today that means only `runtime-deaths:*` appears — Step 2's signal, the only one with a
countable recurrence. Live output is currently `[]`, correctly: the card shipped yesterday and the
condition is not firing.

- **Pinned:** `scripts/card-measurement-test.cjs` (16 assertions, in `test:governance`).
- **Note on Step 3:** satisfied by construction, not skipped. The card already rides `postInsightAlert`
  → the admins' Inbox + an out-of-band DM, which is the "deliver where humans already look" requirement.
  The page is where the *measurement* lives, which is the archive role Step 3 assigns it.

### Step 4 (original plan)

Replace `measureLearning`'s intervention model. The question is not "did an owner press Apply" but
**"did the problem stop recurring after the action?"** For each card: the signal's rate before the
action vs after, with sample sizes and a withheld verdict below `MIN_N` (that part of `measurement.ts`
was right — the subject was wrong).

- **Exit:** at least one card shows a real before/after on live data, with an honest "insufficient"
  where the sample is thin.

### Step 5 — second signal (only now)

Only after Steps 2–4 hold. Candidates, ranked by live evidence: **agent shape** (below — the largest
measured cost of any candidate here), pending-approval pile-ups, automations failing repeatedly
(`reliability.ts` already detects these), agents that never get used, stalled tasks. Each goes through
the identical vertical: detect → card → action → measure.

#### Candidate: **agent shape** — "this delegate does not need to be an agent"

**The evidence** (instawp, 7 days to 2026-08-17). Delegation, not human work, is what the fleet spends:

| lane | conversations | spend |
|---|---|---|
| agent→agent `task:` | 437 | **$8,640** |
| cron | 221 | $1,114 |
| **human-started** | **77** | **$1,027** |

**815 tasks were created by agents; 3 by humans.** A one-line question — *"can we disable bot detection
for route welcome"* — became **19 descendant sessions, depth 5, $600**. Every hop is a fresh session
paying a full context reload, which is why splitting work costs an agent fleet far more than it costs a
human team: a human hand-off is a two-minute conversation between people who already hold the context.

**The signal.** A delegate is separate for one of four reasons — its own **credentials**, **untrusted
input** isolation, **async/long-running** work, or an **independent fresh context**. Only the last is
satisfied by a sub-agent, and only knowledge (no isolation at all) is satisfied by a skill:

| tier | gives you | costs |
|---|---|---|
| skill | knowledge, loaded into the *current* context | ~nothing |
| sub-agent | a *fresh* context, in-process, caller's principal + budget | small |
| agent | own session, own credentials, own lifetime | ~$20 + a launch |

The card names delegates whose separation buys none of the top three — i.e. ones that should be a
sub-agent or a skill. Computable today from what the OS already stores:

| signal | source | what it rules out |
|---|---|---|
| own credentials | `shellSecrets` + `secret_assignments` | can't be a sub-agent (it runs under the caller's principal) |
| `active_ms` per session | `term_sessions` | long work can't be a sub-agent — it holds the caller's turn open |
| owns automations | `automations` | it's a trigger endpoint, not a delegation hop |
| hand-off volume + sources | `tasks` | whether there is anything to save |
| already reachable as a sub-agent | prompt refs + `.aos-managed.json` | both doors open ⇒ close the expensive one |
| open / in-flight work | `tasks`, live sessions | blocks any action until drained |

**⚠ The classifier is the hard part, and a plausible one is wrong.** Building the first two folds by
hand, three agents were classified from real data and **all three were wrong on the first pass**:

- `qa` — credentials byte-identical to `engineer`, so it read as pure ceremony (99 hand-offs/week). It
  is not: **20.6 min average, 76 tool calls, `active_ms` 19.9 of 20.6** — it provisions sandboxes/devX
  boxes, drives a real browser, and is the independent observer the branch-freeze protocol depends on.
- `apidocs-bot` — no secrets, so it read as collapsible. It owns a live webhook automation; folding it
  breaks the drift check.
- `code-reviewer` — proposed as a *skill*. Wrong tier: a skill loads into the caller's context and its
  entire value is **not seeing** the author's reasoning. It became `subagentOnly` (v0.361.0).

So the card must state **which signal disqualified an agent**, not just a verdict — the verdict alone
reproduces exactly the "detection without proposal" failure of §2b, with worse consequences, because
acting on it deletes a teammate. Note also §2's lesson that a naive per-agent view misleads: rank by
hand-offs **saved**, and show the denominator.

**One signal that does NOT work today.** The gate audit cannot classify read-vs-write: of 9,139
`gate.decision` events in the window, **8,573 are `shell.exec`** (then `file.write` 471,
`connector.call` 93, `secret.put` 2). The capability grain cannot tell a `git diff` from a deploy, so
"is this agent read-only?" is not derivable. Any classifier assuming otherwise is guessing.

**Not to be built: a one-click "fold agent → skill" button.** Same reasoning as Step 2's refusal to put
buttons on the runtime-death card, and stronger here. The mechanics are trivial (`CLAUDE.md` →
`SKILL.md`); the judgement is where all three hand-classifications failed, and the destination tier is
usually **sub-agent**, not skill — so a "→ skill" button bakes in the tier that fits least often. It is
also not done when the skill exists: it is done when **every caller stops delegating**, which means
editing other agents' `CLAUDE.md` — the clobber-prone path that already needed `assessClaudeMdEdit` +
`baseHash` guards after two live incidents. A button that creates a skill and leaves nine prompts still
calling `task_create(assignee:"agent:qa")` has added a duplicate and changed nothing.

Ship the **recommendation read-only first**. An action follows only for the class the classifier earns
confidence on (no credentials, short sessions, no automations, no in-flight work), listing the blockers
and the referencing prompts before it acts.

**Honest sizing, so this is not oversold.** On instawp the confident class is ~2 agents and ~8
hand-offs/week. Two folds shipped by hand (`code-reviewer` → `subagentOnly`, plus the self-dispatch
refusal) are worth ~$1,440/week. The remaining **$7,300/week sits in `infra-ops` (221 hand-offs),
`engineer` (165) and `qa` (103)** — genuinely long, credentialed work that no fold can touch. That is
an argument for the card being *diagnostic* rather than an action surface, and for the delegation
budget (§ related) being the bigger lever.

**Measured how** (Step 4's rule — measure the card, not our clicks): the fold's whole point is fewer
sessions, so the outcome is `tasks` hand-offs to the named delegate before vs after, and the
`task.subagent_only.refused` / `task.self_dispatch.refused` audits give the counterfactual directly.

### Step 6 — retire what didn't earn its place

Decided by evidence at this point, not now:

- **Topic extractor** — delete; have the consolidator name workstreams in prose (§3.6).
- **Recommendations engine v1** — superseded by cards, or deleted.
- **Janitorial blocks (×5)** — move to a Maintenance surface, or auto-run with undo. Not Insights.
- **Fleet-wide guidance injection** — reconsider only with a per-agent, evidence-backed line. Today's
  two generic sentences are prompt real estate for no measured gain.

## 5. What "done" looks like

Not a richer page. A short list of cards that each name a real problem, reach the right human where
they already are, offer an action, and can show whether the action worked. If the fleet is healthy,
the surface is **empty** — and empty is the success state, not the failure state it reads as today.

## 6. Reproducing the evidence

```bash
# Human actions taken (both tenants)
sqlite3 <db> "select type,count(*) from audit_events
  where type like 'insights%' or type like 'recommendation%' or type like 'learning%'
  group by type order by 2 desc;"

# Alerts by key — detection without proposal
sqlite3 <db> "select json_extract(data,'\$.key') k, count(*), max(datetime(ts/1000,'unixepoch'))
  from audit_events where type='insights.alert' group by k order by 2 desc;"

# The outcome signal has no variance
sqlite3 <db> "select json_extract(data,'\$.outcome') o, count(*)
  from audit_events where type='session.reported' group by o order by 2 desc;"

# The 40% hole: terminated sessions vs sessions that reported (30d)
sqlite3 <db> "select (select count(*) from term_sessions
    where created_at>(strftime('%s','now')-30*86400)*1000 and status!='running') total,
  (select count(distinct run_id) from audit_events
    where type='session.reported' and ts>(strftime('%s','now')-30*86400)*1000) reported;"

# What is being injected into every prompt right now
sqlite3 <db> "select value from settings where key='learned_guidance';"
sqlite3 <db> "select value from settings where key='learned_recommendations';"
sqlite3 <db> "select json_extract(value,'\$.topics') from settings where key='dreaming_state';"
```

Live DB paths: northwind `~/agent-os-data/northwind/agent-os.db`; globex
`user@203.0.113.13:/home/ubuntu/tools/agent-os/data/agent-os.db`.

## 7. Related

- [`self-learning-plan.md`](./self-learning-plan.md) — what shipped, incl. the 2026-07-31 correction
  whose lesson ("a signal injected into every prompt needs a denominator and a shape test") this
  audit shows we broke again in the adjacent metric.
- [`memory-encoding-and-consolidation.md`](./memory-encoding-and-consolidation.md) — the learning loop
  Insights sits inside.
- [`journal-plan.md`](./journal-plan.md) — Step 3 in full: the digest promoted to its own day-by-day
  surface, rewired onto the Step 1b outcome, with a bounded human-facing narrative on top.
- [`daily-digest-plan.md`](./daily-digest-plan.md) — the push surface Step 3 rides.
- [`oversight-plane.md`](./oversight-plane.md) — the `Intervention` gap named there is the same gap
  Step 4 closes.
- [`subagents-plan.md`](./subagents-plan.md) — the sub-agent tier the **agent shape** candidate
  recommends folding into (`materializeSubagents`, `spawnableAsSubagent`, `usableSubagents`, and the
  `subagentOnly` inverse added for it in v0.361.0).
- [`webhook-ingress.md`](./webhook-ingress.md) — the sibling waste class found in the same pass: the
  agent's own reply echoing back as an event and buying a session to be ignored, now filterable at the
  ingress with `when`/`unless` instead of by a Claude session.
- [`PILLARS.md`](./PILLARS.md) — Pillar 10; update its grade when Step 4 lands, not before.
