# Memory backend switch — migrate-or-clear

**Status:** Phase 1 (v0.24.0) + Phase 2 (v0.25.0) shipped. Hardening for the backend-swap flow that
shipped in v0.21.0 ([`memory-model.md`](./memory-model.md) → "Backends that self-consolidate"). Turns a
manual, scripted cleanup into a first-class Settings action: Phase 1 = the drift banner + migrate/clear
endpoints; Phase 2 = the **at-switch interstitial** (a reconcile prompt the moment you change backend)
+ **batched migration** (the endpoint moves a batch per call over a fixed `before` horizon; the client
loops with a live progress count, so a large ledger never blocks one request).

## The problem (observed live)

Switching a tenant's memory backend (Settings → Memory) is a config flip — but **the old store's
contents don't come along.** When northwind moved SQLite → automem:

- automem started **empty** (0 memories).
- the local `memories` table still held the **51 pre-switch rows**.
- Result: the Memory hub **counts read the local table** (`GET /api/memory/overview`) and showed 51,
  while **recall reads the backend** (`os.memory.recall` → automem) and returned nothing. Stats said 51,
  the browse was empty, and agents silently lost recall of everything they'd learned.

We reconciled it by hand — a script that migrated the 27 durable memories into automem (skipping 22 raw
episodes + 2 stale stat-snapshots) then deleted the 51 orphans. That judgement + plumbing should be a
button, not a one-off.

## The key insight — the local table is the universal migration source

After v0.21.0, the local `memories` table is *always* a complete local copy of what this OS has stored:
it **is** the store for SQLite, and it's a **mirror** of every write for external backends
(`MirroredMemoryProvider`, `src/memory/mirror.ts`). So migration never needs to *read* the old backend —
it replays the **local table** into the new backend's provider. That's exactly what the manual script
did, and it makes every transition uniform:

| Transition | Local table before | What's needed |
|---|---|---|
| SQLite → external | full (canonical) | **migrate** rows into the empty external store, or **clear** |
| external A → external B | full (mirror of A) | **migrate** the mirror into B, or **clear** |
| external → SQLite | full (mirror of ext) | **nothing** — the mirror already *is* the SQLite store; data's already local |

So the awkward direction is "into a fresh store" (the first two); the reverse just works because the
mirror kept a local copy all along.

## The feature — drift detection + reconcile

Rather than bolt the choice only onto the Save button, detect the mismatch and offer to fix it — which
covers both "just switched" and "switched a while ago, never reconciled" (our exact situation).

**Drift banner (Settings → Memory).** Compare the local table count (`memories WHERE tenant=?`) against
the active backend's count (`health().detail` / a `count()` probe). When they diverge:

> ⚠ **N memories are in this workspace's local ledger but not in the active `<backend>` store.** Agents
> recall from `<backend>`, so they can't see them. **[Migrate to `<backend>`]  [Clear local ledger]  [Dismiss]**

**At switch time.** When `PUT /api/settings/memory` changes the backend and the local table is non-empty,
the console interstitial offers the same three choices before/after applying:
- **Migrate** — copy the local memories into the new store (with an optional filter, below).
- **Start fresh (clear)** — drop the local ledger so counts match the empty new store.
- **Just switch (leave)** — today's behavior; orphans remain (counts overstate what's recallable).

## Migration mechanics

A new owner/admin endpoint **`POST /api/settings/memory/migrate`** that replicates the verified manual
flow, server-side (so it can preserve everything the HTTP `POST /api/memory` hack couldn't — `metadata`,
exact author, scope):

1. **Snapshot** the pre-existing local row ids for the tenant (the "orphans").
2. **Replay** each selected row through the *current* provider — `os.memory.store({tenant, agentId,
   content, tags, type, importance, metadata, scope})`. Post-switch that's the new backend + mirror, so
   each row lands in the new store **and** re-mirrors locally under a fresh id (author/scope/tags/
   importance/metadata preserved).
3. **Verify** the new store's count rose by the migrated total.
4. **Delete the snapshotted orphan ids** from the local table (a direct delete — the mirror's own
   `delete` won't touch them, since the backend never had them). Gated: **only delete if every row
   migrated** (a partial migration leaves everything intact for retry).
5. **Audit** `memory.migrated { from, to, migrated, skipped }`.

**Optional quality filter** (the "good ones only" we applied). Default: migrate everything. A checkbox
**"Durable only — skip raw session episodes"** drops `tag:episode` rows (the auto-recaps that consolidation
distills and that rebuild anyway). This is where 22 of our 24 drops came from; the other 2 were transient
`dreamer` stat-snapshots — leave those to the user's discretion rather than hard-coding a denylist.

**Bounded + resumable.** Batch the replay (e.g. 50/req) with a progress count for large stores; the
orphan-delete is one transaction with `busy_timeout` (safe alongside live sessions — validated during the
manual run with 3 sessions active).

## Clear mechanics

**`POST /api/settings/memory/clear`** (owner/admin) — delete the tenant's local `memories` rows, so the
ledger matches the (empty or external-only) active store. Audited `memory.cleared { count }`. Note in the
UI that this also resets what Dreaming/consolidation can reflect on (a genuine fresh start), and that it's
irreversible.

## Surfaces to build

- **Server** (`src/server.ts`): `POST /api/settings/memory/migrate` (opts: `skipEpisodes?`, `batch?`),
  `POST /api/settings/memory/clear`; extend `GET /api/settings/memory` to return `{ localCount,
  backendCount, drift }` for the banner. Reuses `os.memory.store` + a direct orphan-delete.
- **Backend count probe:** most providers expose a count (`automem` health `memory_count`; sqlite = the
  table). Add a tiny `count?(tenant)` to `MemoryProvider` (optional; falls back to health-parse).
- **Web** (`web/src/App.tsx` `MemorySettings`): the drift banner + the at-switch interstitial (Migrate /
  Clear / Leave), the "durable only" checkbox, a progress/result toast, and a confirm on Clear.
- **Docs:** fold into `memory-model.md` (replace the manual "no data migrates — starts empty" caveat with
  "migrate or clear on switch"); `CHANGELOG`.

## Edge cases / limits (document these)

- **Only OS-written memories are captured.** The local mirror holds what *this* OS stored; a shared
  external store written by other clients (automem is designed to be shared) won't be in the ledger, so
  migrate can't push what it never saw. Fine for our single-writer use; note it.
- **`sharedWrites: curated`.** Migrating `scope:tenant` rows must honor (or explicitly bypass, as an
  owner action) the shared-write policy so the 11 shared don't get downgraded to private.
- **Idempotency.** Re-running migrate would double-write; guard by only migrating rows whose ids are in
  the pre-switch snapshot (not the freshly-mirrored ones), exactly as the gated delete assumes.
- **Reverse (external → SQLite).** Offer "keep (already local)" rather than a pointless self-migrate.

## Phasing

- **Phase 1:** the two endpoints + the drift banner with **Migrate (all) / Clear**. Solves the observed
  problem for any tenant, retroactively.
- **Phase 2:** the at-switch interstitial + the "durable only" filter + batched progress for large stores.

## Decisions to confirm

1. **Default migrate scope** — all rows (faithful) vs "durable only" default-on (skips episodes). Recommend
   **migrate all by default, filter opt-in** — least surprising; the user saw us choose to skip episodes,
   but that's a judgement they should opt into.
2. **Auto-offer vs manual** — pop the interstitial automatically on every backend change, or only surface
   the passive drift banner. Recommend **both** (interstitial at switch, banner as the safety net).
