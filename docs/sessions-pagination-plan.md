# Sessions pagination plan

`GET /api/sessions` returns **all** non-archived sessions (~950 on globex) and the console's global
1.5 s poll re-fetches the whole list every tick — the Tasks page fetches it a second time on its own 5 s
timer. The console-perf arc so far (#525 clip → #530 gzip+ETag+304 → #532 client render-skip → #533
per-row cache → #535 in-query task clip) made each tick cheap **when nothing changed**, but on a busy
tenant the list changes constantly and the server still builds + ships ~950 rows. Pagination is the
structural fix. See [[console-list-payload-perf]] for the measured baseline.

## Why naive `?limit&offset` on the poll breaks things

The 1.5 s poll's `sessions` array is a **client-wide all-sessions cache**, not just the list view's data.
Consumers in `web/src/App.tsx`:

- **Counts / tab-title badge** — `runningSessions` (~L1307); Overview's `blocked` / `live` / `doneToday`
  / per-agent-online tallies (`OverviewPage`, ~L7531-7540).
- **Sessions list view** — client-side filter over status/agent/source/mode/owner/mine **+ full-text
  search** on `title·agent·id·task·spawnedByLabel·runAsLabel` (~L3259-3271), facet dropdowns
  (`agentOptions`/`ownerOptions`) built from the full set (~L3246-3253), multi-key sort, and bulk
  select "over the filtered view" (~L3285-3304).
- **Tab management** — live/ended tab strips (~L3385-3386).
- **By-id / by-tmux lookups** — notification→open, `SessionFacts`, rename (~L1199, L1285, L1487-1493).
- **Tasks page** — a second full fetch to map `task.lastSessionId → isLive` (~L7912, L7939-7940).

And there is **no `GET /api/sessions/:id`** today — every by-id read is served from that array. So if the
poll stops carrying all rows, counts, cross-view lookups, and search all break unless we restructure
first.

## The insight

Almost every consumer needs one of two cheap things, **not** 950 rows:
- **aggregate counts**, or
- **the LIVE subset** — small, bounded by the concurrency cap (~20).

Only the **Sessions list view** needs a filtered/sorted page of arbitrary (mostly terminal) rows — and
it's open only some of the time. So the fix is not "paginate the poll," it's **split the poll from the
list**.

## Target architecture

1. **`GET /api/sessions/:id`** (+ batch `?ids=a,b,c`) — the missing by-id fetch. Backs notification-open,
   `SessionFacts`, and the Tasks `lastSessionId` lookups without the full array. Viewer-scoped
   (`canViewRow`), reuses the same derived-row builder as the list.
2. **`GET /api/sessions/summary`** — cheap: aggregate counts + the full **live** rows + blocked ids, with
   the same ETag/304 the poll already uses. The 1.5 s poll fetches **this** instead of ~950 rows. Drives
   badge, Overview, tab strip, "my live sessions."
3. **`GET /api/sessions` gains pagination** — `limit` + cursor + **server-side** filter/sort/search +
   facet lists. The list view fetches pages **on demand** (open + filter/sort/scroll), not on the tick.

## Phasing (each independently shippable, low→high risk)

| Phase | Work | Risk | Win |
|---|---|---|---|
| **1** | `GET /api/sessions/:id` + `?ids=`; migrate the Tasks page to fetch only its referenced session ids (drop its 2nd full poll) | S | Removes the 5 s duplicate ~950-row fetch on the Tasks page; lands the by-id infra Phase 2 needs |
| **2** | `GET /api/sessions/summary` (counts + live rows + blocked ids, ETag); point the 1.5 s poll + badge + Overview + tab strip at it | M | **Core win — the hot poll stops shipping ~950 rows.** Badge/bells are load-bearing; migrate carefully |
| **3** | Server-side pagination + filter/sort/search + facets on `/api/sessions`; rewrite the list view to fetch pages (debounced search, pager/infinite-scroll); retire client-side filter-over-full-array | L | List view scales past a few thousand sessions |

Order is **1 → 2 → 3**: Phase 1 is the prerequisite (once the poll drops the full list, by-id lookups
need a home). Phase 2 delivers the measured perf win. Phase 3 is the largest client change and can wait.

## Decisions to make (before Phase 3)

- **Search backend.** `term_sessions` has **no FTS table** (unlike `tasks`/`kb`/`memories`). At ~950–5k
  rows a `LIKE`-based server filter is fine; a `term_sessions_fts` mirror is only worth it if the corpus
  grows large. → *Recommend LIKE first, revisit with size.*
- **Pagination style.** Keyset/**cursor** on `(created_at, id)` (immutable, stable under a live-mutating
  list) over `offset`.
- **Bulk select-all across pages.** "Select all matching filter" vs "select visible page" — a product
  call. Today's select-all operates over the full filtered array; server pagination forces the choice.
- **Sort on derived columns** (cost/tokens/activeMs). Materialized columns now, so server-side sort is
  fine.

## Invariants to preserve

- **Viewer scoping** (`TerminalManager.canViewRow`) must hold on every new surface — a member sees only
  sessions they spawned + automations they created; owner/admin see all. Never widen it.
- **The badge/bells derive from the poll** — Phase 2's summary must carry everything they read
  (`blocked`, live rows, counts) or the "waiting on you" nudge goes stale. This is the one load-bearing
  correctness risk in the whole plan.
- **ETag/304 + gzip** stay on every new GET (they ride the shared `sendBody`).

## Status

- Phase 1 — **shipped** v0.294.0 (#539).
- Phase 2 — **shipped** v0.296.0 (#542). Live globex: poll payload 265 KB → 19.5 KB gzipped (950 → 83
  rows) off the list routes.
- Phase 3 — **decided, deferred** (2026-08-03). Split into **3a** (client row virtualization — low-risk,
  fixes the render jank while keeping all client-side filtering; do first) and **3b** (server-side
  pagination — the big rewrite below, deferred until a tenant's non-archived session count clears ~3–5k,
  since the full-list *fetch* is already gzipped-small post-Phase-2 and the acute pain is the DOM render).
  Tracked in `TODO.md` → "Console performance". The server-pagination design in the table above remains
  the plan of record for 3b.
