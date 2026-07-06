# How the fleet learns — encoding, consolidation, reinforcement

> **Status (2026-07-02): shipped ✅.** Turns the memory plane from a passive store into a learning
> loop. Builds on [`memory-layer-plan.md`](./memory-layer-plan.md) (the store) and
> [`self-learning-plan.md`](./self-learning-plan.md) (the Dreaming reflection pass). Five "levers"
> ship here; each is small and independently reversible.

## The model — episodic vs. semantic

Human memory keeps two things apart, and so do we:

- **Episodic** — *what happened* in a session. The OS writes one automatically at the end of every
  session (`writeEpisode` in `src/terminal.ts`). Cheap, mechanical, per-session.
- **Semantic** — *the reusable lesson*, abstracted from experience. Written deliberately: an agent's
  `remember`, a `report`'s `lessons` field, or the consolidation gardener's shared memories.

The whole loop:

```
   episode (auto)  ─┐
   lesson (report) ─┤→  reflection (Dreaming)  →  guidance injected into every agent's prompt
   remember        ─┘         │
                              └→  consolidation (gardener)  →  SHARED memories + KB pages
                                            │
   recall  ←──────── reinforcement (rank ↑ what's used, decay/prune the rest) ←──────┘
```

An agent captures graded episodes + deliberate lessons; reflection distils recurring signal into
guidance that rides in every new prompt; the gardener consolidates episodes/lessons into shared
knowledge; and recall reinforces what proves useful while the never-recalled fade. Each pass feeds the
next.

## Lever 1 — give `remember` a *when*, not just a *what*

The `remember` tool used to describe *what* a memory is but never *when* to write one, so agents rarely
did. Now both the tool description (`src/memory/memory-mcp.ts`) and the OS operating notes injected into
every agent (`AGENT_OS_OPERATING_NOTES` in `src/terminal.ts`) name the **encoding moments**: you were
**surprised** (reality ≠ expectation), you spent real **effort**, you made a **decision** others will
reuse, or you hit a **gotcha / root cause** — and explicitly to skip routine steps and run-specific
trivia. Pure prompting; visible and reversible.

## Lever 2 — encode at `report` time (the `lessons` field)

`report` is the reflective moment ("I just finished — what would I tell my future self?"). The tool
gained an optional **`lessons`** field (`src/memory/memory-mcp.ts` → `/api/report` → `TerminalManager.report`
in `src/terminal.ts`). When present it's stored as a **deliberate semantic memory** — `type: Insight`,
tags `['lesson','session-end']`, importance `0.7`, private to the agent — separate from the mechanical
episode. Audited `lesson.stored` / `lesson.error`. A reported session thus yields *both* an episode
(what happened) and, when there's something to keep, a lesson (what was learned).

## Lever 3 — auto-salience (grade how memorable an episode is)

Episodes used to store at a flat importance. `episodeSalience()` (`src/terminal.ts`) now grades each one
from its own audit stream, so recall / Dreaming / consolidation weight the sessions that actually taught
something:

| term | signal | weight |
| --- | --- | --- |
| base | `report` source `0.55` · `audit` source `0.4` | — |
| effort | `gate.decision` count (governed actions) | +0.02 each, cap **+0.2** |
| friction | rejected approvals · errors · budget stops · kill-switch blocks | +0.15 each, cap **+0.3** |
| outcome | `failure` or `crashed` | +0.1 |

Clamped to **0.3–0.95**. The signal breakdown is persisted in the episode's `metadata.salience` and the
`episode.stored` audit; the Memory card's `imp` badge tooltip explains the score. (Spread from testing:
1-action stop → `0.42`, 13-action → `0.6`, 5-action + 2 errors + 1 rejection → `0.8`.)

## Lever 4 — consolidation (the memory gardener)

`src/edge/consolidation.ts` (`Consolidation`, wired at the server level because it needs both `os` and
the `TerminalManager`). It selects recent fleet **episodes + lessons** since a watermark (last
`learning.consolidated` audit) and, if there are ≥ 3, spawns a **governed headless `consolidator`
agent** that reads them and writes the recurring, durable patterns into **shared memories**
(`remember` with `shared: true`) + **KB pages** (`kb_write`) via its own tools. This is the plan doc's
"kb-gardener": Claude does the synthesis; no in-process LLM client is added.

- The `consolidator` agent is provisioned on first use into `<home>/agents/consolidator/` (isolated
  folder + `agent.json` + a `CLAUDE.md` that carries the method: check existing knowledge first, find
  recurring signal, be selective, report). It excludes its own prior runs to avoid recursion.
- **Not a separate action.** Consolidation is the second half of one **"reflect"** pass: `POST
  /api/dreaming/run` (the "Reflect now" button) and the scheduled tick both run the deterministic
  Dreaming pass then this gardener over new material (it no-ops below `MIN_ITEMS`, so cheap when there's
  little to do). There's no standalone "Consolidate" button or `consolidate_auto` toggle anymore — one
  concept, whether manual or scheduled.
- The watermark advances at kickoff so material isn't re-fed.

## Lever 5 — retrieval reinforcement (use it or lose it)

Recall already bumped `recall_count` / `last_recalled_at` for memories an actual query surfaces, and
maintenance already pruned the old + never-recalled + unimportant (`src/memory/sqlite-provider.ts`). The
missing half — making usage shape *ranking* — was added in `rerank()` (`src/memory/embedding.ts`):

- **`weightByUsage`** — boosts frequently-recalled memories, diminishing (rc 0 → ×1.0, 1 → ×1.25,
  → ×1.5 asymptote), so it nudges without dominating.
- **use-aware recency** — the half-life now decays from a memory's **last use**
  (`max(created, lastRecalledAt)`) rather than creation, so a memory that keeps proving useful stays
  fresh while the never-recalled fade. Pairs with prune, which deletes them outright.

New fields: `MemoryRecord.recallCount` / `lastRecalledAt`, `MemoryRanking.weightByUsage`. Toggle:
Settings → Memory backend → Recall ranking → **"Reinforce by usage."**

## The console — the Memory hub (`#/memory`)

`MemoryPage` in `web/src/App.tsx` is **two tabs** under a slim stats strip (memories · episodes ·
lessons · shared · KB pages, from `GET /api/memory/overview`, admin-only). See the one-page mental
model in [`memory-model.md`](./memory-model.md) — the hub is organised around its four verbs.

- **Memories** (Capture + Recall) — per-agent browse: `Add memory` (top-right), kind chips (Episode /
  Lesson / Insight / …), readable multi-line cards with outcome + source + `imp` (salience tooltip), and
  a **"Shared (all agents)"** scope (recall with `scope:'tenant'` returns shared knowledge across every
  author).
- **Self-learning** (Distil + Apply, owner/admin) — one **Reflect** card (cadence + a single **Reflect
  now** button that runs the deterministic pass then the gardener), the apply-guidance toggle with live
  preview, config recommendations, and the **learning-activity feed** (episode/lesson/reflection/
  consolidation events) that makes the loop legible.

## Data model & audit events

- **Memories** (`memories` table): episodes are tagged `episode`; lessons `lesson`; consolidated
  knowledge is `scope:'tenant'`. `metadata` carries `outcome` / `source` / `salience` for episodes.
- **Settings keys:** `dreaming_*` / `learned_*` (cadence, apply-guidance, guidance, recommendations).
  Ranking lives in the `memory_config` JSON (`ranking.weightByUsage`). *(The old `consolidate_auto`
  toggle is retired — a scheduled reflect always consolidates new material.)*
- **Audit types:** `episode.stored` / `episode.error`, `lesson.stored` / `lesson.error`,
  `learning.dreamed`, `learning.consolidated` (+ `memory.stored` / `kb.written` from the gardener's
  own tool calls).

## Activation & config caveat

The **ranking** halves of levers 3 and 5 only take effect when recall ranking is **enabled** — the live
`memory_config` ships with no `ranking` block, so `rerank` returns results unchanged until an operator
turns it on (Settings → Memory backend → Recall ranking). The **prune** half of lever 5, the episode
metadata, and everything in levers 1/2/4 work regardless. Recommended starting ranking: half-life
~30 days, Weight by importance ✓, Reinforce by usage ✓.

## Verification (no test runner — in-process scripts)

Confirmed per lever: `remember`/`report` schema + notes reach new sessions (a live headless session
filled `lessons`); salience grading spread (0.42 / 0.6 / 0.8); the gardener consolidated 8 episodes →
2 shared memories live and was appropriately selective; reinforcement reorders recall (rc-boost +
last-use recency) with ranking-off a no-op. Plus `npm run typecheck`, `cd web && npm run build`, and a
server bounce.

## Not built / next

- **Measurement** — nothing yet proves the injected guidance + consolidated knowledge actually move
  success rate over time. The signals exist (episodes carry outcome; Dreaming tracks per-pass success);
  a trend view / A-B of guidance-on vs -off is the natural next chapter.
- **Programmatic ranking defaults** — ranking is opt-in; a first-run sensible default (or a
  Dreaming *recommendation* to enable it) would activate levers 3/5 without a manual step.
