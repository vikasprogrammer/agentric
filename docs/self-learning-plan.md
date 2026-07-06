# Agent OS Self-Learning ("Dreaming") — Implementation Notes

> **Status (2026-06-23): shipped ✅.** Closes the long-standing gap "an eval signal is computed per run
> but nothing consumes it" (Pillar 10). A periodic, deterministic pass reflects on what the fleet has
> done, **compounds** it into durable knowledge, and **closes the loop** on both agent *behavior* and
> *configuration*. Zero-cost (no LLM); the richer LLM "kb-gardener" is the optional follow-up.

## The loop (five stages)

```
1. OBSERVE     recent episodes + run/session outcomes + friction (from memory + audit)
2. COMPOUND    fold the new window into persisted cumulative state (settings: dreaming_state)
3. EMIT        a living KB page (operations/fleet-learnings) + a tenant-shared memory Insight
4. ADJUST BEHAVIOR   distil guidance → injected into EVERY agent's system prompt at launch
5. ADJUST CONFIG     propose runtime/policy/budget tuning → a human Applies/Dismisses (gated)
```

Each pass advances a watermark (the last `learning.dreamed` audit ts), so it only ever processes **new**
activity — incremental *and* compounding.

## 1. Signals consumed  (`src/edge/dreaming.ts`)

Per pass, over `(since, now]` where `since` = last `learning.dreamed` ts (first run: last 7 days):
- **Episodes** — the per-session summaries the OS already writes (`memories` rows tagged `episode`; see
  `src/terminal.ts` `writeEpisode`/`composeEpisode`). The richest "what agents did" signal.
- **Outcomes** — audit `session.reported` / `session.ended` / `session.stopped` / `run.completed`
  (read `data.outcome`; a stop counts as `stopped`).
- **Friction** — audit `approval.resolved` (rejected), `budget.exceeded`, `episode.error`.

If the window has no episodes and no outcomes → the pass is **skipped** (no state change).

## 2. Compounding state  (`settings: dreaming_state`)

The pass folds the window into a structured cumulative object (persisted via
`SettingsStore.dreamingState`/`setDreamingState`):
- `totals` — running tallies (sessions, success/failure/partial/stopped, episodes, rejected, budgetStops, errors).
- `topics` — `{ keyword → { count, lastSeen } }`, built from episode task-lines (deduped per episode,
  stop-worded). Counts **merge across passes** — the recurring-topic understanding sharpens over time.
- `recent` — a rolling log of the last ~12 passes.
- `firstPass`, `passes`.

The KB page is a **pure render** of this state — so it **rebuilds cumulatively even if a human deletes
it** (the learning isn't lost; deleting is a reset of the *page*, not the *state*).

## 3. Emits

- **KB page** `operations/fleet-learnings` (revision-chained via `os.kb.write`): cumulative totals,
  a **recurring-topics** table, and the recent-passes log. Rewritten in place each pass — its revision
  history is the record of how the fleet evolved.
- **Tenant-shared memory Insight** (`os.memory.store`, `scope: 'tenant'`, tags `dreaming`/`learned`) —
  so any agent that `recall`s gets the latest fleet summary.
- Audit `learning.dreamed` (advances the watermark) + `kb.written`.

## 4. Closed loop A — behavior (`deriveGuidance` → every agent's prompt)

`deriveGuidance(state)` distils the cumulative state into a few **actionable imperatives** (not stats),
stored in `settings: learned_guidance`:
- always: *recall + kb_search before non-trivial work*;
- recurring topics → *read/keep the KB runbook for X, Y, Z*;
- `rejected ≥ 2` → *policy_check before risky effects; never retry a rejected action*;
- `budgetStops ≥ 1` → *scope tightly; ask rather than burn budget*;
- `errors ≥ 2` → *verify before finishing; report honestly*;
- low success rate (≥5 sessions, <70%) → *slow down, confirm, prefer asking*.

**Injection:** `TerminalManager.buildCompanyMd()` appends this block to every claude-code agent's
`--append-system-prompt-file` payload (after Company context + OS operating notes). Gated by
`SettingsStore.applyLearnings()` (default on; toggle in Settings → Self-learning). It's **prompting,
not auto-rewriting** — visible, reversible, and toggleable. So the fleet's experience shapes each new
session → new outcomes → next pass refines the guidance.

## 5. Closed loop B — configuration (`deriveRecommendations` → human-gated apply)

`deriveRecommendations(state, currentEffort)` proposes config changes from friction — **never
auto-applied**. Stored in `settings: learned_recommendations` as `{ open[], dismissed[] }`; each pass
recomputes `open` from current signals **minus** dismissed ids (so a dismissed proposal never returns;
a resolved signal drops off on its own).
- **`runtime.effort.high`** — *applyable*: low success rate + effort not already high → a reversible
  `runtimeDefaults` patch. Applying it calls `setRuntimeDefaults` (audited).
- **`policy.review`** — *advisory*: frequent approval rejections → "review your policy" (link).
- **`budget.review`** — *advisory*: repeated budget stops → "review default budgets" (link).

Routes: `POST /api/dreaming/recommendation/:id/apply` (applyable → reversible settings change, audit
`recommendation.applied`) and `/dismiss` (audit `recommendation.dismissed`). Policy/budget stay
**human-edited** — the OS only programmatically touches the safe, reversible runtime-defaults lever.

## 6. Scheduling + control (`src/server.ts`, kernel)

- **Manual:** `POST /api/dreaming/run` (owner/admin) — the Settings "Run now" button.
- **Auto:** an hourly `setInterval` in `startServer` runs a pass when due per
  `SettingsStore.dreamingEveryHours()` (0 = off; default off). No-op unless opted in.
- `GET /api/dreaming` returns `{ everyHours, lastDreamedAt, applyLearnings, guidance, recommendations }`;
  `PUT /api/dreaming` sets `everyHours` and/or `applyLearnings`.

## 7. Console (`web/src` — Settings → Self-learning)

Cadence + **Run now** (shows what it learned); an **Apply learnings to agents** toggle with a live
read-only preview of the injected guidance; and a **Recommendations** list (Apply / Review-link /
Dismiss per proposal).

## 8. Settings keys + audit events

Keys: `dreaming_every_hours`, `dreaming_state`, `learned_guidance`, `learned_guidance_apply`,
`learned_recommendations`. Audit: `learning.dreamed`, `kb.written`, `recommendation.applied`,
`recommendation.dismissed` (+ `memory.stored` from the Insight).

## 9. Verification (no test runner — in-process scripts)

Confirmed: compounding (totals 2→3→4 across passes; topic counts merge; page rev increments; survives a
page delete → rebuilt cumulative); guidance derivation per friction scenario + **injection** via
`buildCompanyMd` toggling on/off; recommendation derivation (applyable vs advisory; suppressed when
effort already high; dismissed don't reappear) + a live apply that flips the workspace runtime default.
Plus `npm run typecheck`, `cd web && npm run build`, `npm run demo`.

## 10. Not built / next

- **LLM "kb-gardener"** — ✅ **shipped** as the consolidation gardener (lever 4). A governed headless
  `consolidator` agent reads recent episodes+lessons and synthesises shared memories + KB pages via its
  own tools. Now the second half of one **"reflect"** pass (`POST /api/dreaming/run` + the scheduled
  tick run the deterministic pass then the gardener) — no separate button/toggle. See
  [`memory-encoding-and-consolidation.md`](./memory-encoding-and-consolidation.md), which documents the
  full learning loop this reflection pass sits inside (encoding → reflection → consolidation → reinforcement).
- **Programmatic policy/budget tuning** — today advisory only; would need its own reversible setter +
  approval-gating (the runtime-defaults lever is the proven pattern).
- **Multi-tenancy:** the deployment model is **instance-per-tenant** (a separate `agent-os serve` process
  per tenant — distinct `AGENT_OS_HOME` + `AGENT_OS_TENANT` + `PORT`). So the single-`os` schedulers in
  `startServer` are already correct: each process owns exactly one tenant's `os`, and `dream()` keys on
  `os.tenant` throughout. **No per-tenant fan-out needed** — nothing to change here.
