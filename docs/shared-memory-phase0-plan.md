# Shared-Scope Memory (Phase 0 toward KB) — Implementation Plan

> **Status (2026-06-23): ✅ shipped.** Implemented as planned — `scope` column, recall visibility union
> (own ∪ tenant-shared), `remember(shared)` MCP arg + routes, and the console scope filter / share
> checkbox / badge. Deviations from this doc, all noted inline below: a `(tenant, agent_id, scope)`
> consolidation guard was added (so maintenance can't silently change a memory's scope — not in the
> original plan); libsql has full parity (recall union + store), automem carries `scope` but tenant
> sharing there stays deferred. A migration-ordering fix was needed: the `idx_mem_scope` index must be
> created AFTER the idempotent `addColumn`, else an existing DB throws "no such column: scope" on startup.
>
> **Round-out (also shipped):** the step-6 deferrals are done. **Human curation** — owners/admins edit or
> remove ANY memory (`UpdateInput/DeleteInput.admin`, set from role server-side); the console hides
> edit/delete on memories a member can't touch. **Shared-write governance** — `memory.sharedWrites` =
> `open` (default) | `curated`; under curated an agent's `remember(shared)` is stored private (the MCP
> tells it a human must publish), toggled in Settings → Memory. Full blocking-approval per shared write
> was considered and deliberately not built — the curated setting is the lighter, sufficient Phase-0 control.
>
> This was the cheap first step the KB discussion landed on (see `docs/knowledge-base-plan.md`): before
> building a full Knowledge Base plane, give the existing Memory plane a **tenant-wide scope** so durable
> knowledge can be *shared* across all of a tenant's agents — and find out whether shared knowledge
> actually accrues and gets reused before committing to documents, revisions, and a wiki UI.

## Goal

Today every memory is hard-namespaced `(tenant, agentId)` — an agent only ever recalls its own
(`src/memory/sqlite-provider.ts:14`, `src/types.ts:250`). Phase 0 adds one axis: a memory can be
**agent-scoped** (default, unchanged) or **tenant-scoped** (visible to every agent in the tenant).
That's the whole feature. It's a one-column migration plus a recall-filter change, with matching
touches in the providers, the write path, the MCP `remember` tool, and the console.

It is deliberately **not** a KB. See "Boundary" below for what it is *not* and when to graduate.

---

## 1. Data model change

### 1.1 Schema — `src/state/db.ts`

Add a `scope` column to `memories`. New DBs get it from the `CREATE TABLE`; existing DBs get it from
the idempotent `addColumn` pass (same convention as the inbox columns at `db.ts:243`):

```sql
-- in the CREATE TABLE memories (...) block:
scope TEXT NOT NULL DEFAULT 'agent'   -- 'agent' (private to agent_id) | 'tenant' (shared tenant-wide)

-- idempotent for older DBs:
addColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'agent'");

-- recall unions an agent's own rows with the tenant's shared rows; index both access paths:
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(tenant, scope, created_at);
```

`agent_id` keeps its meaning even for tenant-scoped rows: it records the **author** (who wrote the
shared fact). Scope governs *visibility*; `agent_id` stays *provenance*. Existing rows default to
`'agent'`, so behavior is unchanged until something writes a tenant-scoped memory.

The FTS5 virtual table (`memories_fts`) and its triggers are unchanged — `scope` lives only on the
base table and is applied as a normal `WHERE` predicate alongside the FTS join.

### 1.2 Types — `src/types.ts`

```ts
export type MemoryScope = 'agent' | 'tenant';

export interface MemoryRecord {
  // …existing fields…
  scope: MemoryScope;          // NEW — 'agent' (default) | 'tenant'
}

export interface StoreInput {
  // …existing fields…
  scope?: MemoryScope;         // NEW — defaults to 'agent'
}

export interface RecallQuery {
  // …existing fields…
  /** NEW — what an agent can see. Default 'all' = own agent rows ∪ tenant-shared rows.
   *  'agent' = only own; 'tenant' = only shared. */
  scope?: 'all' | 'agent' | 'tenant';
}
```

The `MemoryProvider` interface signature is unchanged — only the input/record shapes grow, and every
new field is optional/defaulted, so existing callers compile untouched.

---

## 2. Recall semantics (the one behavioral change)

When an agent recalls, it should see **its own agent-scoped memories ∪ all tenant-scoped memories in
the tenant**. In `SqliteMemoryProvider.recall` (`sqlite-provider.ts:65`) the visibility predicate
changes in all three query paths (lexical bm25, the recency fallback, and — implicitly — the JS
cosine scan which currently filters `tenant = ? AND agent_id = ?`):

```sql
-- before:  AND m.tenant = ? AND m.agent_id = ?
-- after (default 'all'):
            AND m.tenant = ? AND (m.agent_id = ? OR m.scope = 'tenant')
```

with `scope: 'agent'` collapsing to the old predicate and `scope: 'tenant'` to
`m.tenant = ? AND m.scope = 'tenant'`. The cosine brute-force scan
(`sqlite-provider.ts:95`) widens its `SELECT … WHERE` the same way — the candidate set grows from one
agent's rows to one agent's rows plus the tenant-shared set, still small enough for an in-JS scan.

Ranking, recency decay, importance bias, and reciprocal-rank fusion are all untouched — a tenant-shared
memory just competes in the same ranked pool. `recall_count`/`last_recalled_at` bookkeeping
(`sqlite-provider.ts:123`) is unchanged; a shared memory accrues recall credit whoever surfaces it.

**Write/edit isolation stays authorship-based.** `update`/`delete` keep their
`WHERE id = ? AND tenant = ? AND agent_id = ?` guard (`sqlite-provider.ts:188,200`): an agent can edit
or remove only what it authored, *even if shared*. No agent can clobber another agent's shared memory.
This is intentional — concurrent multi-writer editing with conflict handling is exactly the problem
the full KB plane solves with revisions; Phase 0 sidesteps it by keeping shared memories
single-author + append-style. Humans can edit anything via the console (below).

---

## 3. Write path

### 3.1 Provider — `SqliteMemoryProvider.store`

`store` (`sqlite-provider.ts:41`) sets `scope: input.scope ?? 'agent'` on the record and includes the
column in the `INSERT`. One-line change.

### 3.2 Session-scoped route — `POST /api/memory/remember` (`server.ts:307`)

Accept an optional `scope` (or a friendlier `shared: boolean`) in the body and pass it through to
`os.memory.store({ …, scope })`. Default `'agent'` preserves today's behavior. Tag the audit event
so a shared write is visible in the trail:

```ts
os.audit.append({ …, type: 'memory.stored', data: { id: rec.id, tags: rec.tags, scope: rec.scope } });
```

`agentId` is still derived server-side from the session (`tm.sessionAgent(session)`, `server.ts:310`)
— never trusted from the agent — so authorship of a shared memory is trustworthy.

---

## 4. Agent-facing MCP tool — `src/memory/memory-mcp.ts`

Add one optional property to the existing `remember` tool (`memory-mcp.ts:64`) rather than a new tool
— keeps the surface minimal:

```jsonc
// remember.inputSchema.properties:
"shared": {
  "type": "boolean",
  "description": "Set true to store this as SHARED, company-wide knowledge every agent in the workspace can recall — a stable fact, policy, or convention others will reuse. Default false = private to you. Only share durable, broadly-useful facts; keep run-specific notes private."
}
```

`shared: true` maps to `scope: 'tenant'` in the `POST /api/memory/remember` body. Update the `recall`
tool description (`memory-mcp.ts:50`) to note results now also include shared company knowledge, and
reinforce the private-vs-shared line in agent `CLAUDE.md` guidance.

**MCP tool changes need `npm run build` + relaunching the session** — claude spawns the MCP server
fresh per session, so a live session keeps the old tool list until respawned (per CLAUDE.md).

---

## 5. Other providers (parity)

The `MemoryProvider` contract is backend-agnostic; each backend implements the scope union itself:

- **libsql** (`src/memory/libsql-provider.ts`) — same `scope` column + the same widened `WHERE`
  predicate; mirrors the sqlite change since the SQL is nearly identical.
- **automem** (`src/memory/automem-provider.ts`) — isolation there is by **tags** (`agent:<id>` +
  `tenant:<t>`), not columns. Tenant scope = write with the `tenant:<t>` tag but **without** the
  `agent:<id>` tag (or with an explicit `scope:tenant` tag), and recall drops the `agent:<id>` filter
  so shared records surface for everyone in the tenant. Documented here; implement when/if automem is
  the active backend.

If a backend isn't updated, it simply ignores `scope` and behaves as today (everything agent-scoped)
— no breakage, just no sharing on that backend.

---

## 6. Console — `web/src`

Small additions to the existing Memory page (no new page):

- **List** (`GET /api/memory`, `server.ts:596`): include `scope` in the returned records and add a
  filter toggle — *This agent* / *Shared* / *All*. Pass it through to `recall({ …, scope })`.
- **Create/curate** (`POST`/`PATCH`): a "Share with the whole workspace" checkbox sets
  `scope: 'tenant'`. A human (owner/admin) curating can also promote an agent memory to shared or edit
  any shared memory — humans are the escape hatch the per-agent authorship guard leaves open.
- Add `scope` to the `MemoryRecord` type in `web/src/lib/api.ts` and a small badge in the row.

Web-only changes: `cd web && npm run build`, reload — no server restart (Node serves `web/dist` off
disk).

---

## 7. Boundary — what Phase 0 is NOT, and when to graduate

Phase 0 buys **shared facts**. It deliberately does **not** provide:

- **Documents.** Memories are atomic snippets, not editable markdown pages.
- **Revisions / rollback.** A shared memory has no version history; edits are in-place and
  authorship-locked.
- **Multi-writer editing.** Two agents can't co-author one record with conflict resolution.
- **A wiki UI.** It's a filtered list, not a browsable/linkable page tree.

**Graduate to the full KB plane (`docs/knowledge-base-plan.md`) when you hit any of these three
walls:** humans need to read/edit a wiki of pages; knowledge wants to live as documents rather than
snippets; or you need revision history + rollback for trust. Until then, shared-scope memory is the
cheaper bet and tells you whether the demand for shared knowledge is real.

The two stay complementary even after KB ships: **Memory is where knowledge is discovered**
(per-agent, raw, cheap), **KB is where the durable, shareable bits are promoted to canonical**. A
tenant-scoped memory is the natural raw material a future "KB gardener" automation promotes into a
page.

---

## 8. Build order & validation

1. `db.ts` migration (`scope` column + `addColumn` + index) → `src/types.ts` (`MemoryScope`, fields).
2. `SqliteMemoryProvider`: `store` writes `scope`; `recall` widens the visibility predicate (3 paths).
3. `POST /api/memory/remember` accepts `scope`/`shared`; audit records scope.
4. `remember` MCP tool gains `shared`; `recall` description updated.
5. Console: scope filter + share checkbox + badge + `api.ts` type.
6. (Deferred) libsql parity; automem tag-scope; tenant-scoped dedup grouping in `maintain`.

Validate the usual way (no test runner): `npm run typecheck`, `cd web && npm run build`, `npm run demo`,
and a small in-process Node script (`createHttpServer` on an ephemeral port) that: stores an
agent-scoped and a tenant-scoped memory as agent A, then recalls as agent B and asserts B sees only the
tenant-scoped one (plus its own). **Server/route changes need `npm run build` + a server restart** to
take effect (per CLAUDE.md — a fresh route otherwise 404s and falls through to the login gate, looking
like a 401). Note the maturity shift in `docs/PILLARS.md` if it tracks the memory plane.
