# Journal — the day-by-day record, promoted out of Insights

> **Status (2026-08-11): planned, not started.** This is the concrete instantiation of Step 3 of
> [`insights-revisit.md`](./insights-revisit.md) ("deliver where humans already look"), plus the front
> half of its Step 6 ("retire what didn't earn its place").
>
> Headline: **the day-by-day changelog already exists and is the only Insights surface anyone consumes.**
> The work is not to build one — it is to give it its own page, let it read backwards in time, put an
> honest outcome behind its verdicts, and only then add a written narrative on top.

## 1. Why — the evidence already decided this

From `insights-revisit.md` §2a, measured 2026-08-08 on the two busiest live tenants (lifetime):

| Signal | northwind | globex |
|---|---|---|
| Open recommendations (now) | 0 | 0 |
| Recommendations dismissed (ever) | 0 | 0 |
| `recommendation.applied` (ever) | 1 | 0 |
| Janitorial applies, 30d (all five) | 0 | — |
| **`digest.posted`** | **26** | — |

Fourteen blocks on one admin-only page produced ~one human action, ever. The one surface with sustained
consumption is the **pushed** one — the daily digest — and it is currently a *config panel* buried as
block 4 of that page (`DreamingSettings`, `web/src/App.tsx:13431`), with a preview of **today only**.

Everything below follows from that: promote what is read, put the rest behind it, and add capability to
the read thing rather than to the unread page.

## 2. What already exists (this is mostly a promotion, not a build)

| Piece | Where | State |
|---|---|---|
| Per-day model — needs-you, cross-agent threads, per-agent lines, signals, cost | `buildDigest` (`src/edge/digest.ts:77`) | ships |
| Dated, revisioned, browsable page per day | `Digest.refresh` → `os.kb.write({ slug: 'daily/<iso>' })` (`src/edge/digest.ts:519`) | ships |
| Per-session line, written free at teardown | `composeEpisode` (`src/terminal.ts`) | ships |
| Chat delivery (Slack + Discord), EOD-gated | `renderSlack` / `renderDiscord` / `maybePostEod` | ships |
| Derived, non-self-graded outcome | `measureOutcomes` (`src/edge/outcome.ts:417`) | ships (v0.330.0) |
| Direct Anthropic key + a completion helper | `os.settings.anthropicKey()`, `chatComplete` (`src/edge/llm.ts:33`) | ships |

`buildDigest(os, now)` already takes a date, and every past day is already rendered on disk as a KB page.
Reading backwards in time is a query parameter and a route, not a feature.

**Net new code for the whole plan:** a nav route, a day-reader page, one `/api/journal/*` route pair, a
rewire of the model's verdict source, and one bounded LLM call.

## 3. Name — **Journal**

Not "Updates": `src/edge/updater.ts` / `UpdateStatus` / Settings → Updates is the OS self-update, and a
second "Updates" in primary nav is a genuine ambiguity on a page whose whole job is to be skimmed.
Not "Changelog": `CHANGELOG.md` is the release log, and the two would be confused in every conversation
about "what changed". **Journal** is unclaimed in this repo, and the durable artifact is already a
*journal page* (`operations/daily/<iso>`) — the name follows the data.

## 4. The surface

```
Journal  (primary nav, admin+ — same gate the digest preview has today)
  ├ day picker / scroll back      ← KB operations/daily/*  +  live build for today
  ├ ✍️  what actually happened     ← the AI paragraph (§7), absent until §6 lands
  ├ ⏳ Needs you                   ← ships (the only to-do section)
  ├ 🔗 Threads                     ← ships (cross-agent incident clustering)
  ├ per-agent lines                ← ships, rewired in §6
  └ signals + cost                 ← ships, corrected in §6
```

One page, one vertical scroll, newest day first. The **chat post keeps its caps** (`PER_AGENT`,
`MAX_NEEDS`, `MAX_INCIDENTS`) because a Slack message must fit; the **page shows the full day**.

**Trap:** those caps are applied in `buildDigest` today (`byAgent … slice(0, PER_AGENT)`), i.e. in the
*model*, so the console preview is truncated too and the overflow is only a `+N more` count. Move the
capping into `renderSlack`/`renderDiscord` and let the model carry the complete day. Same for `needs`
and `incidents`. This is a prerequisite for the page being worth opening at all.

## 5. Day history — read the frozen page, don't re-derive the day

Two sources, and the split matters for correctness:

- **Today** → `buildDigest(os, new Date())`, live, rebuilt on each load (as now).
- **Any past day** → read the KB page `operations/daily/<iso>` via `KbStore` (`src/state/kb.ts:127`).

**Do not rebuild a past day from `buildDigest(os, thatDate)`.** The session/episode/audit queries are
correctly windowed, but two fields are not: `guidance` comes from `os.settings.learnedGuidance()` and
`recommendations` from `os.settings.recommendations()` — both read **now**. Re-rendering 2026-07-04
would staple today's distilled guidance onto that day's page and silently rewrite history in a
revisioned store. The KB page is the record precisely because it was frozen at EOD.

Corollary: `Digest.clearAndRefresh` (the "Clear & refresh today" button) must stay scoped to **today**.
If a "regenerate this day" affordance is ever added for past days, it re-renders only the windowed
sections and leaves `guidance`/`recommendations` as the revision stored them.

`GET /api/journal/:iso` returns `{ source: 'live' | 'kb', model? , markdown?, rev? }` — the live model
for today, the stored page (plus its revision) for anything older. A missing page for an old date is a
legitimate empty state ("no journal was written for this day"), not an error.

## 6. Put an honest outcome behind the verdicts — before any prose

The digest's verdicts are still the signal `insights-revisit.md` Step 0 spent a release deleting from
every other channel:

```sql
-- buildDigest, src/edge/digest.ts:104
const outcome = (r.outcome || (r.status === 'done' ? 'success' : r.status) || 'unknown')
```

`r.outcome` is `json_extract(m.metadata,'$.outcome')` on the end-of-session episode — i.e. **whatever the
agent passed to its own `report()`**. On the live northwind corpus that field carried *one* reported
failure in 329 reports. `digest.ts` already half-knows this (Fix A reclassifies "blocked" lines out of
the buckets on the strength of the line *text*, because "the ✓ was lying") — the fix is to stop reading
the field, not to keep patching around it.

Four changes, all sourced from `src/edge/outcome.ts`:

1. **Verdicts from `measureOutcomes(os, { since, until })`**, not from `report()`. Nine bases, each
   traceable to the fact that decided it; ~52–57% exact out-of-sample against a 43% always-success
   baseline, 78% sign agreement (rounds 1–3, `insights-revisit.md` Step 1/1b).
2. **The unit is a conversation, not a run.** `foldConversations` groups by `claude_session_id`; a
   `poke:` resume continues a transcript, so today's row-per-line count reports one job several times.
3. **Cost is `max` per conversation, not `sum`.** `signals.costUsd` accumulates `r.cost_usd` over every
   row in the day; `cost_usd` is per-transcript and **cumulative**, so a conversation resumed three times
   contributes its bill three times. This is the same folding rule `sessionChain` already applies. *Verify
   the magnitude on the live corpus before quoting a corrected number* — the rule is established, the size
   of the error on any given day is not.
4. **Deaths become visible.** A run killed by quota/auth exhaustion makes no report, so `isRealReport`
   drops it into `hidden` and the day looks clean. `outcome.ts` scores exactly these (`died-early`,
   `runtime-death`, `no-tool-calls`) — 31 in 30 days on the live corpus. They belong in the day's record,
   and Step 2's runtime-death card already depends on the same detection.

**Sequencing is not negotiable.** A fluent paragraph over a verdict field with no variance is the
original failure with better prose. §7 does not start until this lands and its counts reconcile against
`measureOutcomes` on the live corpus.

## 7. The AI layer

The key is already taken in the web UI (Settings → Integrations, `anthropic_api_key`, per-tenant DB), and
`chatComplete` (`src/edge/llm.ts:33`) already resolves Anthropic-first and **returns `null` on any
failure**. So the whole layer is one call with a null-check.

**One paragraph per day**, at the top of the page and at the top of the chat post: what actually happened,
what it means, what changed since yesterday.

### Four constraints, each an inversion of a named failure

1. **Human-facing only. It never touches `buildCompanyMd`.** Prompt injection is the highest-blast-radius
   channel in the OS — it is how a success rate that measured whether `report()` was called became "slow
   down" for every agent on every tenant. The Journal narrative is read by people or it is read by no one.
2. **Input is the deterministic `DigestModel`, never raw transcripts.** Bounded (~90 lines on a busy day),
   reproducible, auditable, and it inherits the model's own filtering (`selfMaint`, `askSession`,
   placeholder drops) rather than re-deriving it. Transcript summarization is unbounded in cost and
   unauditable in content.
3. **The output is a KB revision on the dated page, plus a cache.** Same store, same revert, same history
   as everything else the OS writes. Cached with the `iso` + a hash of the model it was generated from, so
   a page reload, a re-render, or three admins opening the same day cost nothing. Regeneration is explicit.
4. **Degradation is the default state, not an error path.** No key configured, network failure, non-200,
   malformed body → `chatComplete` returns `null` → the page is exactly the deterministic Journal. The AI
   layer is additive; nothing depends on it.

### Cadence and cost

**Not per session.** A 90-session day is 90 calls for content that `composeEpisode` already writes for
free, and the salience threshold exists precisely to keep that volume off the page. **One call per tenant
per day**, at the EOD tick that already runs (`maybePostEod`, `src/server.ts:404`), plus an explicit
"regenerate" button.

Spend the model where determinism can't reach: the day narrative, the diff against yesterday, and
(later, if it earns it) better thread merging than `refsOf`/`clusterIncidents`' regex heuristics.

Bound, at `claude-haiku-4-5` ($1/M input, $5/M output — the `anthropicModel()` default):

```
~3k input tokens (a busy day's DigestModel) × $1/M   = $0.003
~400 output tokens (max_tokens, set explicitly)  × $5/M   = $0.002
                                                   ─────────
                                            ≈ $0.005 / tenant / day   (~$0.15/month)
```

A per-session layer at the same rate is ~$0.45/tenant/day — 90× the cost for content that already exists.
The only per-session call worth making is on a `failure` verdict, and that is a §10 candidate, not part of
this plan.

**Model choice stays `os.settings.anthropicModel()`** — a tenant that wants a stronger writer sets it in
Settings; the Journal does not hardcode a model.

### The prompt

Written down here because the failure mode is the prompt, not the plumbing: the paragraph must state what
the day's data says and nothing else. No advice, no "consider increasing", no percentages the model
computed itself — the numbers on the page are the deterministic ones, and the prose refers to them. If it
starts recommending, it has become the recommendations engine that produced zero applies in a year.

## 8. What moves, what dies, what stays

`DreamingSettings` (`web/src/App.tsx:12750`, ~800 lines, 14 blocks) is not deleted wholesale — it is three
different things wearing one page.

| Block(s) | Destination |
|---|---|
| Daily digest config + preview | **Journal** (preview) + **Settings → Dreaming** (config: channel, hour, enabled) |
| Reflect cadence, `applyLearnings`, alerts toggle | **Settings → Dreaming** — it is config, and always was |
| Janitorial ×5 (memory cleanup, KB tidy, task reconcile, library declutter, session archive) | A **Maintenance** surface, or auto-run with undo. 0 applies in 30 days says the page is not the problem — the framing is. `insights-revisit.md` Step 6 decides which. |
| Cards (Step 2's runtime-death card, and its successors) | **Inbox** for delivery; Insights becomes their archive/history view |
| Fleet scorecard, friction, "is it working?", review history, improvement tiles, stuck goals, troubled automations | Stay on Insights **pending Step 6's evidence** — this plan does not pre-empt that call |

The Journal takes the *record*; Insights keeps the *analysis*; Settings takes the *config*. That the three
were ever one page is the whole diagnosis.

## 9. Build order — four steps, each independently shippable and gated

**J1 — promote (no new capability).** Journal nav route; `GET /api/journal/:iso` (live today, KB page for
past days); day picker; move the caps out of the model into the chat renders; move digest config to
Settings → Dreaming. No AI, no outcome rewire.
*Exit:* the digest is reachable without opening Insights, and at least one person opens a day that is not
today within a week. `journal.day.viewed` audit (with `iso` and whether it was today) is the instrument —
and it is also the **baseline** J3 is measured against.
*Falsifier:* if only today is ever opened, the archive is not wanted — keep the today view, drop the day
picker, and stop here.

**J2 — honest verdicts.** §6, all four changes.
*Exit:* the Journal's per-day counts reconcile against `measureOutcomes` over the same window on the live
corpus, and a day containing a known quota death shows it. Pinned by a test script in `test:governance`,
alongside `scripts/chain-model-test.cjs`.

**J3 — the paragraph.** §7, once J2 holds.
*Exit:* page views on the days that have a narrative exceed the J1 baseline. This is a real before/after
with a denominator and a sample, per the rebuild's own principles — and it is allowed to come back
negative.
*Falsifier:* no lift → delete the layer, keep the deterministic page. Do not "improve the prompt" first;
one round of prompt iteration is allowed only if the paragraph is being read and is wrong.

**J4 — retire.** Execute §8's moves. Gated on `insights-revisit.md` Step 6's evidence, not on this plan.

## 10. Explicitly not building (yet)

- **Per-session AI summaries** — §7 cadence. Revisit only for `failure` verdicts, and only with a consumer.
- **LLM thread merging** — `clusterIncidents` is regex heuristics and could be better, but it is not
  currently the thing that makes the page unreadable. Measure first.
- **A non-admin Journal.** The digest is fleet-wide and its lines carry other members' work; the audience
  question (owner-scoped vs tenant-wide) is the same one `docs/inbox-plan.md` answers for cards, and it
  should be answered once, there, not twice.
- **Per-day retention/pruning.** KB pages are small markdown; a year of them is not a problem worth
  pre-solving.

## 11. Related

- [`insights-revisit.md`](./insights-revisit.md) — the audit and the sequenced rebuild; this is its Step 3.
- [`daily-digest-plan.md`](./daily-digest-plan.md) — the original digest design (capture, salience, EOD gate).
- [`self-learning-plan.md`](./self-learning-plan.md) — the reflect pass whose output the digest carries.
- [`knowledge-base-plan.md`](./knowledge-base-plan.md) — the store the dated pages live in.
- [`inbox-plan.md`](./inbox-plan.md) — the other half of Step 3's delivery (cards, audiences, DM mirror).
