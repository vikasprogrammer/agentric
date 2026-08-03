# Trackers — the fourth state plane (design)

**Status:** Proposed (2026-07-14). Author: agent-author. Motivated by the legacy `~/agents` fleet audit
(see `docs/globex-ops-migration-plan.md` §9 and the port-planning matrix).
**One-liner:** a named, keyed store of *operational state that accretes across runs* — the current status
of a set of entities and how it changed — distinct from Tasks, Memory, and KB.

---

## 0. Why this exists

The migration plan ports agents, policy, skills, memory, and KB well. Three capabilities have no home;
this doc designs the one with **no prior art at all**: Trackers.

The legacy fleet keeps ~15 persistent state stores, in three incompatible storage styles, that Agent OS
has no primitive for:

| Legacy tracker | Storage | Keyed entity | Fields it tracks |
|---|---|---|---|
| watchdog site health | `history.json` + a **Google Sheet** | domain | status, http_code, response_time, ssl_days, server_ip; trend Healthy→Warning |
| migration-agent | **SQLite** (`sites`,`migrations`,…) | migration_id | source/dest, status, phases(JSON), **tokens_in/out, cost_usd** |
| server-troubleshooter | **SQLite** `blocked-ips.db` (258 rows) | ip | server, attack_type, abuse_score, request_count |
| supportagent | `scan-state.json` | scan cursor | last page, completed ids, rate-limit window |
| prahari self-heal | `orchestrator-state.json` + `escalations.jsonl` | (server,site,kind) | status monitoring/healed/escalated, attempts |
| CEO zram rollout | `zram-tracker.md` | server | persistent / runtime / foreign |
| CEO orphan monitor | `orphan-monitor/latest.json` | — (snapshot) | candidates, orphans, zombies, corruption counts over time |
| CEO canary health | `canary-health-snapshots.jsonl` | — (snapshot) | per-server load/mem/cpu time series |
| CEO agency outreach | `agency_outreach_tracking.json` | recipient | status pending/sent |
| CEO wpcloud fleet | 14× `wpcloud-sites-YYYY-MM-DD.json` | — (snapshot) | fleet size over time |

Two clear shapes fall out: **entity trackers** (revisit a keyed thing, upsert its state) and **snapshot
trackers** (append a metric row over time). One store handles both.

The bonus: **per-session cost/token metering** — a gap in *both* the old and new systems — is just a
built-in snapshot tracker fed at session end.

## 1. Where it sits in the model (Plane C)

`docs/ARCHITECTURE.md` already names four state lifecycles and says the "Database/Tracker" is *task state*.
That was true when Tasks were the only structured store. Trackers split the difference Tasks can't cover:

| Store | Lifecycle | Shape | Read model |
|---|---|---|---|
| **Tasks** | churn — `todo→done`, then it stops | discrete unit of work | queue |
| **Memory** | accrete + decay | free-text episodes, ranked | fuzzy recall |
| **KB** | curated | markdown docs, versioned | search/read |
| **Trackers** *(new)* | standing state — never "done", keeps changing | keyed rows / snapshots, typed fields | exact query |

A task is one unit of work that reaches `done`. A tracker **row** is a standing entity (a domain, an IP)
whose status keeps changing forever. A memory is ranked, decaying, fuzzy; a tracker row is exact, current,
and overwritten in place. Trackers are the missing "current state + trend" plane.

## 2. Data model

Per-tenant SQLite (`node:sqlite`), mirroring the `tasks` / `task_events` and `kb_pages` / `kb_revisions`
shape already in `src/state/`. New store: `src/state/trackers.ts` (`TrackerStore`, `os.trackers`).

```sql
-- a named tracker
CREATE TABLE trackers (
  id          TEXT PRIMARY KEY,     -- tr_<rand>
  name        TEXT NOT NULL,        -- unique per tenant, e.g. "site-health", "blocked-ips", "session-cost"
  kind        TEXT NOT NULL,        -- 'entity' | 'snapshot'
  scope       TEXT NOT NULL,        -- 'agent' | 'tenant'  (who can read/write, like memory scope)
  owner       TEXT,                 -- creating principal (agent id / member)
  schema_hint TEXT,                 -- optional JSON: declared field names + types, for the console table
  labels      TEXT,                 -- JSON string[]
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- one row per keyed entity (entity kind) OR one row per append (snapshot kind)
CREATE TABLE tracker_rows (
  id          TEXT PRIMARY KEY,     -- trr_<rand>
  tracker_id  TEXT NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  key         TEXT,                 -- entity: the upsert key (domain/ip/id). snapshot: NULL
  status      TEXT,                 -- free-text status token, e.g. healthy|warning|critical|sent|healed
  fields      TEXT NOT NULL,        -- JSON blob of typed fields
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(tracker_id, key)           -- entity upsert target; snapshot rows have key NULL (no conflict)
);
CREATE INDEX trr_tracker_status ON tracker_rows(tracker_id, status);
CREATE INDEX trr_tracker_updated ON tracker_rows(tracker_id, updated_at);

-- append-only change log — the safety net, so writes need no approval gate (like task_events)
CREATE TABLE tracker_events (
  id          TEXT PRIMARY KEY,
  row_id      TEXT NOT NULL REFERENCES tracker_rows(id) ON DELETE CASCADE,
  tracker_id  TEXT NOT NULL,
  event       TEXT NOT NULL,        -- 'created' | 'updated' | 'status_changed' | 'appended'
  delta       TEXT,                 -- JSON of changed fields (old→new) + prev/next status
  actor       TEXT,                 -- run-as identity
  ts          INTEGER NOT NULL
);
CREATE INDEX tre_row_ts ON tracker_events(row_id, ts);
```

Notes:
- **Snapshot kind** never upserts — every `tracker_snapshot` inserts a fresh row with `key = NULL`, so the
  `UNIQUE(tracker_id, key)` constraint doesn't collide (SQLite treats NULLs as distinct). Reads are ordered
  by `created_at`. This is the metrics/time-series path.
- **`fields` is schema-light** — a JSON blob. `schema_hint` is advisory, only to let the console render a
  sensible column set and types; it is not enforced. This is deliberate: the 15 legacy trackers have wildly
  different shapes and we don't want a migration per tracker.
- **No FTS** — trackers are exact/queryable, not searched. If a tracker grows large, index on the hot
  status/label. (Memory/KB own fuzzy search.)

## 3. Agent MCP tools

Session-secret-gated loopback calls to `/api/*` routes that sit before the member-auth gate — the exact
pattern of `task_*` (`src/memory/memory-mcp.ts` + the route matrix in `docs/agent-mcp-tools.md`). All
auto-apply + audit; no policy gate (the event log is the safety net).

| Tool | Route | Does |
|---|---|---|
| `tracker_create` | `POST /api/trackers` | Define a named tracker (name, kind, scope, schema_hint). Idempotent on name. Optional — first `tracker_upsert`/`tracker_snapshot` to an unknown name auto-creates with inferred kind. |
| `tracker_upsert` | `POST /api/trackers/:name/rows` | Entity kind. Upsert a row by `key`; merge `fields`; set `status`. Auto-appends a `tracker_events` row with the field delta; emits `status_changed` when status flips. |
| `tracker_snapshot` | `POST /api/trackers/:name/snapshots` | Snapshot kind. Append a timestamped row. |
| `tracker_get` | `GET /api/trackers/:name/rows/:key` | One row, exact. |
| `tracker_list` | `GET /api/trackers/:name/rows?status=&label=&limit=` | Filtered rows (entity) or latest-N (snapshot). Deterministic order, not ranked. |
| `tracker_history` | `GET /api/trackers/:name/rows/:key/events` | The event log for a row — powers trend/Healthy→Critical detection and per-row sparklines. |

Console-only (humans): `DELETE` a tracker or row (destructive → gated like other deletes), rename, edit
`schema_hint`.

**Audit event names:** `tracker.create`, `tracker.upsert`, `tracker.snapshot`, `tracker.row.delete`.

## 4. Governance

- **Writes auto-apply + audit**, no approval gate — parity with Tasks and KB, justified by the append-only
  `tracker_events` log (nothing is lost; every change is attributable to a run-as actor).
- **Scope** (`agent` | `tenant`) governs read/write visibility, reusing the memory-scope idea: an
  agent-scoped tracker is private to its owner; a tenant-scoped one is fleet-shared (watchdog site-health,
  session-cost).
- **Row delete is destructive** → flows through the normal gate (`deleteCount > bulkDeleteCount` → never;
  single delete → audit), so the red-line "no deleting records without approval" is honored.
- A tracker never widens who can do anything — it is state, not a capability.

## 5. Console surface

A top-level **Trackers** page (under Agents, beside Tasks):
- Left: list of trackers (name, kind badge, row count, last-updated).
- Right: the selected tracker as a **table with status stripes** — one row per entity, colored by status
  (semantic good/warning/critical, separate from the accent). Snapshot trackers render as a table + a
  small area chart of the primary numeric field over time.
- Row detail: current `fields` + a **history sparkline** from `tracker_events`.

This is the in-platform replacement for watchdog's Google Sheet — the human-facing dashboard lives inside
the governed console, not a side channel. (`web/src`, served off disk — no server restart to iterate.)

## 6. The bridge — trackers detect, tasks act

A `status_changed` event to a threshold status can fan out through the **existing** notifier / audience
machinery (`src/governance/recipients.ts` + the Tasks notifier pattern), turning a passive tracker into the
front of the fleet's most valuable loop:

```
tracker_upsert(site-health, key=foo.com, status=critical)
   → status-transition notifier (audience: owner/admins or a named agent)
   → task_create({ assignee: "agent:infra-ops", autoDispatch: true })
   → governed session diagnoses + fixes (still fully gated)
```

That reproduces the legacy watchdog → down-site → fix loop **inside the gate**, and closes the
"crons should *detect and file a task*, humans/gated runs *act*" guidance from the migration plan (§12).
Threshold rules live in the tracker definition (`schema_hint` extension) or a small `tracker_alerts` config
— start with "notify on any status transition into a configurable set", defer richer rules.

## 7. Migrating the legacy trackers

| Legacy | New tracker (kind) | Key |
|---|---|---|
| watchdog `history.json` + Sheet | `site-health` (entity, tenant) | domain |
| server-troubleshooter `blocked-ips.db` | `blocked-ips` (entity, tenant) | ip |
| migration-agent `migrations` | `migrations` (entity, tenant) | migration_id (incl. cost fields) |
| prahari `orchestrator-state.json` | `prahari-heal` (entity, tenant) | server:site:kind |
| CEO `zram-tracker.md` | `zram-rollout` (entity, tenant) | server |
| CEO orphan / canary / wpcloud snapshots | `orphan-counts` / `canary-health` / `wpcloud-fleet` (snapshot) | — |
| CEO outreach tracking | `outreach-<campaign>` (entity, agent) | recipient |
| **new** per-session cost | `session-cost` (snapshot, tenant) | — |

migration-agent is the reference implementation — it already tracks per-run `tokens_in/out` and `cost_usd`;
its columns map straight onto a tracker `fields` blob.

## 8. Build order

1. `TrackerStore` + migrations in `src/state/trackers.ts` + `db.ts`; wire `os.trackers` in `kernel.ts`.
2. `/api/trackers*` routes (before the auth gate, loopback) + the six MCP tools in `memory-mcp.ts`
   (schema change → rebuild + relaunch session; handler change → restart server — see root `CLAUDE.md`).
3. Console **Trackers** page (`web/src`).
4. `session-cost` snapshot fed at session end (episodes already fire there — add the CLI's `total_cost_usd`
   + `usage`).
5. Status-transition notifier → `task_create` bridge.
6. Migrate watchdog + blocked-ips first (entity), then the CEO snapshots.

## 9. Open questions

- **Retention / rollup** for snapshot trackers — a raw append every minute (canary) grows unbounded. Add a
  per-tracker retention (keep-N or keep-days) + optional downsample, mirroring the orchestrator's 90-day job
  cleanup. Defer past v1; log what's dropped.
- **Threshold-rule richness** — start with status-set transitions; a fuller rule DSL (numeric thresholds,
  hysteresis like prahari's amber≥1s/red≥3s) is a follow-up.
- **Should `schema_hint` be enforced?** No for v1 (the 15 shapes differ too much); revisit if the console
  needs stronger typing.
- **Relationship to Memory's automem backend** — trackers are exact state, not embeddings; they stay in the
  SQLite table and do NOT go through the memory provider. Keep them separate.
