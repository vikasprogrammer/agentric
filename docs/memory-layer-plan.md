# Agent OS Memory Layer — Implementation Plan

> **Status (2026-06-13): Phase 1 + the console UI shipped.** Provider interface + SQLite (FTS5) and
> automem REST drivers + factory, kernel wiring, `memories` tables, the OS-owned memory MCP server
> (always in the per-session `.mcp.json`), public session-scoped + member-auth HTTP routes, launcher
> tool-allow, and the **console Memory page** (browse/search/curate per agent + backend-health badge)
> are all built, typechecked, and smoke-tested.
>
> **Design correction (supersedes §5c/§5d below):** memory is delivered **purely as a per-agent MCP
> server** — `recall`/`remember` tools. The orchestrator injects **nothing** into the prompt (no
> standing instructions, no auto-recalled "recent memory"). When/whether to recall or remember is the
> agent's decision, guided by the tools' own descriptions and the agent's `CLAUDE.md`. This matches how
> automem reaches the CEO (MCP server + per-agent CLAUDE.md guidance), keeps the orchestrator
> unopinionated, and spends no context unless the agent chooses to.
>
> Pending: automatic session-end episodes / SQLite embeddings (Phase 3). Not yet deployed to prod.


Ship a persistent memory layer for Agent OS agents, **like automem**, that works
in-the-box with zero infra and can be upgraded to the automem graph+vector backend.

- **Backend:** pluggable provider — native SQLite by default, automem REST driver optional.
- **Isolation:** one shared store; each agent namespaced by an `agent:<id>` tag (single
  automem container / single SQLite table — no per-agent provisioning).
- **Delivery:** agents get a `remember` / `recall` MCP tool (OS-owned), plus relevant
  memory auto-injected into the opening prompt; the console can browse/curate.

---

## 0. Background — what we're modeling

automem (used by `~/agents/ceo`) is a Flask REST API over FalkorDB (graph) + Qdrant
(vectors), reached by agents through an MCP server (`@verygoodplugins/mcp-automem`)
exposing `store_memory` / `recall_memory` / `associate_memories` / …. Its memory model
is a single record: `{content, tags[], type, importance, metadata, timestamp}` with
hybrid semantic+keyword+graph+temporal recall (`GET /recall?query=…&tags=…`).

Agent OS already has the two things that make this cheap:

1. **A connector mechanism** (`src/connectors/connectors.ts`) that materializes enabled
   MCP servers into a per-session `.mcp.json` and hands it to claude-code
   (`terminal.ts:writeMcpConfig` → `claude-launch.sh --mcp-config`). This is exactly how
   automem reaches the CEO — so a memory tool is just another MCP server in that file.
2. **A dead-but-intended scaffold** (`src/state/stores.ts`, now removed): it held `MemoryStore`
   (episodic) + `KnowledgeStore` (semantic) interfaces, in-memory and unwired. Replaced by the one
   automem-shaped `MemoryProvider`.

We adopt **automem's unified record model** (not the split episodic/semantic) so the
automem driver is a near 1:1 mapping.

---

## 1. The provider interface  *(new: `src/memory/provider.ts`)*

```ts
export type MemoryType =
  | 'Decision' | 'Pattern' | 'Preference' | 'Style'
  | 'Habit' | 'Insight' | 'Context';

export interface MemoryRecord {
  id: string;
  tenant: string;
  agentId: string;            // namespacing key
  content: string;
  tags: string[];
  type?: MemoryType;
  importance?: number;        // 0..1
  metadata?: Record<string, unknown>;
  ts: number;
  score?: number;             // recall relevance (provider-defined)
}

export interface StoreInput {
  tenant: string;
  agentId: string;
  content: string;
  tags?: string[];
  type?: MemoryType;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface RecallQuery {
  tenant: string;
  agentId: string;
  query?: string;
  tags?: string[];
  limit?: number;             // default 8
}

export interface MemoryProvider {
  store(input: StoreInput): Promise<MemoryRecord>;
  recall(q: RecallQuery): Promise<MemoryRecord[]>;
  health(): Promise<{ ok: boolean; backend: string; detail?: string }>;
}

export interface MemoryConfig {
  backend: 'sqlite' | 'automem';
  automem?: { endpoint: string; token: string };
}

export function createMemoryProvider(cfg: MemoryConfig, db: Db): MemoryProvider {
  return cfg.backend === 'automem'
    ? new AutomemMemoryProvider(cfg.automem!)
    : new SqliteMemoryProvider(db);
}
```

**Namespacing rule (single store, per-agent tag):** every `store()` adds `agent:<agentId>`
to the record's tags; every `recall()` constrains to that tag. SQLite enforces via an
`agent_id` column; automem via `tags=agent:<id>` + `tag_mode=all`. This lets one automem
collection (or one SQLite table) serve all agents with no per-agent provisioning.

---

## 2. Driver A — SQLite (default, zero infra)  *(new: `src/memory/sqlite-provider.ts`)*

Follows the `ConnectorStore` / `TeamStore` `constructor(db)` pattern. Adds tables in
`src/state/db.ts` `migrate()`:

```sql
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  tenant     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL,        -- JSON string[]
  type       TEXT,
  importance REAL,
  metadata   TEXT,                 -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_agent ON memories(tenant, agent_id, created_at);
```

**Recall ranking:** SQLite **FTS5** (`CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, content='memories', content_rowid=…)` + sync triggers, `bm25()` ranking). ✅ **Verified available** in `node:sqlite`'s `DatabaseSync` on this build (Node v22.22.0 — `MATCH` + `bm25()` confirmed working), so Phase 1 ships with proper ranked recall, not a substring fallback. Recall is filtered by `tenant` + `agent_id` and ordered by `bm25()` score then recency, `limit` applied. (`LIKE`+recency remains the trivial degrade path if a future runtime lacks FTS5.)

**Optional later:** semantic embeddings (store a vector blob column, cosine in JS, or
`sqlite-vec`) — phase 3, behind the same interface, no API change.

---

## 3. Driver B — automem REST  *(new: `src/memory/automem-provider.ts`)*

Thin client over the automem REST API (the same endpoints the `mcp-automem` package wraps):

- `store()` → `POST {endpoint}/memory` with `Authorization: Bearer {token}`, body
  `{content, tags:[...input.tags, 'agent:'+agentId, 'tenant:'+tenant], type, importance, metadata, timestamp}`. Returns `{memory_id}` → map to `MemoryRecord`.
- `recall()` → `GET {endpoint}/recall?query=…&tags=agent:<id>&tags=tenant:<t>&tag_mode=all&limit=…`.
  Map `results[].memory` + `final_score` → `MemoryRecord[]`.
- `health()` → `GET {endpoint}/health` (no auth).

25s timeout, 3× retry on network/5xx with backoff — mirror the `mcp-automem` client.
Config (`endpoint`, `token`) comes from `agent-os.config.json` → `memory.automem`, secrets
living in the gitignored data home like connector secrets. **One shared automem container**
(reuse the CEO's at `:8001` with a dedicated collection, or run a single new one); per-agent
separation is the tag, not the container.

---

## 4. Wiring into the kernel  *(edit `src/kernel.ts`, `src/types.ts`, `src/home.ts`)*

- `kernel.ts` — in the `AgentOS` constructor, alongside `connectors`/`approvals`/`team`:
  ```ts
  this.memory = createMemoryProvider(opts.memory ?? { backend: 'sqlite' }, this.db);
  ```
  Expose `readonly memory: MemoryProvider`. Read `memory` from config in `loadAgentOS`.
- `types.ts` — add optional `memory?: MemoryProvider` to `RunContext` so capabilities and
  the (future) `ClaudeCodeAdapter` can use it. Add `memory?: MemoryConfig` to the config type.
- `home.ts` — no new `Paths` field needed (SQLite reuses `agent-os.db`; automem is a URL).
  Only surface the resolved `MemoryConfig` to the kernel.

---

## 5. Delivery to agents — the load-bearing part

### 5a. `remember` / `recall` as an OS-owned MCP tool  *(new: `src/memory/memory-mcp.ts` → built to `dist/`)*

A tiny stdio MCP server agent-os ships and injects into **every** claude-code session's
`.mcp.json` (not user-registered like connectors — always on). It exposes two tools:

- `recall({ query, limit })` — returns the agent's relevant memories.
- `remember({ content, tags?, type?, importance? })` — stores one memory.

It does **not** talk to a DB directly; it calls back into agent-os over loopback, scoped to
the session's agent, so the backend stays swappable and the `agent:<id>` tag is injected
server-side (the agent can neither see nor pollute other agents' memory). It reads
`AOS_URL`, `SESSION`, `AGENT` from its env (already exported to the launcher).

**Extend `terminal.ts:writeMcpConfig`** to always include this server (merging with any
enabled connectors), passing those env vars:

```jsonc
"memory": { "command": "node", "args": ["<dist>/memory-mcp.js"],
            "env": { "AOS_URL": "...", "SESSION": "...", "AGENT": "..." } }
```

So `writeMcpConfig` no longer early-returns when there are zero connectors — memory is
always materialized.

### 5b. Session-scoped HTTP routes  *(edit `src/server.ts`)*

Mirror the **gate** pattern: these are session-scoped and **exempt from the member-cookie
auth** (like `/api/gate`), because the in-session MCP server calls them as the agent:

- `POST /api/memory/remember` — body `{ session, agent, content, tags?, type?, importance? }`
  → resolves tenant from `os`, calls `os.memory.store({ tenant, agentId: agent, ... })`,
  audits `memory.stored`.
- `GET  /api/memory/recall?session=&agent=&q=&limit=` → `os.memory.recall(...)`, audits `memory.recalled`.

Separately, **member-auth'd** console routes for browsing/curation:

- `GET  /api/memory?agent=&q=&limit=` — search/list (for the console).
- `POST /api/memory` — manual add (curated knowledge).
- `GET  /api/memory/health`.

### 5c. Recall injection at session start  *(edit `src/terminal.ts:createSession`)*

Before spawning tmux, fetch the top memories for this agent against the task and prepend a
context block to the prompt:

```ts
const mems = await this.os.memory.recall({ tenant: this.os.tenant, agentId: agent, query: task, limit: 6 });
const preamble = mems.length
  ? `## Relevant memory (from past sessions)\n` +
    mems.map(m => `- ${m.content}${m.tags.length ? ` [${m.tags.join(', ')}]` : ''}`).join('\n') + `\n\n---\n\n`
  : '';
const fullTask = preamble + task;   // → TASK_B64
```

This makes `createSession` **async** — ✅ verified it has exactly **one** call site
(`server.ts:224`, inside the already-`async function handle(): Promise<void>` → just add
`await`; the other `createSession` greps are `team.ts`'s unrelated auth-session method).
Low blast radius.

**Recall timeout cap:** the start-of-session recall must be bounded — wrap it in a
~1.5s timeout that resolves to `[]` on expiry. SQLite recall is sub-ms, but the automem
backend measured **~1–1.2s** per `/recall` (verified against the live CEO namespace), and a
slow/down backend must never delay spawning the agent. This is the §11 Risk #4 "degrade
gracefully" requirement applied at the injection point.

### 5d. Behavioral rules  *(edit `terminal/claude-launch.sh`)*

Add a standard memory preamble to the seeded prompt (the automem playbook the CEO uses):
*recall at start (already injected), store after resolving anything non-obvious, store
gotchas/decisions/fixes, tag with `[bug-fix]`/`[decision]`/`[gotcha]`/etc.* Keep it short;
it just tells the agent the `remember` tool exists and when to use it.

---

## 6. Console UI  *(edit `web/` — phase 2)*

A **Memory** page: pick an agent → search box → list of memories (content, tags, type,
time) with manual add/edit/delete for curated knowledge. Reuses `GET/POST /api/memory`.
Optional health badge showing the active backend (sqlite vs automem).

---

## 7. Session-end episodes  *(✅ shipped — see §15)*

Both options shipped, layered:

- **Explicit (automem-style):** agents call `remember` per the §5d rules — the durable path.
- **Automatic:** the existing `session.ended` signal (`claude-launch.sh` → `/api/ended` →
  `TerminalManager.markEnded`) now also writes **one `Insight` episode** per session — the agent's
  own `report` summary if present, else a heuristic over the session's `audit_events`. See §15.

---

## 8. Config surface  *(`config/agent-os.config.json`)*

```jsonc
{
  // ...existing...
  "memory": {
    "backend": "sqlite",                         // default; zero infra
    // "backend": "automem",
    // "automem": { "endpoint": "http://localhost:8001", "token": "…" }
  }
}
```

---

## 9. Phasing

- **Phase 1 — in-the-box memory (MVP).** §1 interface, §2 SQLite driver + `db.ts` table,
  §4 kernel wiring, §5a memory MCP server + `writeMcpConfig`, §5b session-scoped routes,
  §5c recall injection, §5d behavioral preamble. Result: every claude-code agent remembers
  across sessions, no Docker/Qdrant/OpenAI. *Bulk of the value.*
- **Phase 2 — automem backend + console.** §3 automem driver, §8 config switch, §6 Memory
  page, ops doc for the single shared container. Same UX, hybrid recall.
- **Phase 3 — quality.** SQLite embeddings (semantic recall offline), automem `associate`
  + consolidation/decay, automatic session-end episodes.

---

## 10. Files touched

| File | Change |
|---|---|
| `src/memory/provider.ts` | **new** — interface, types, `createMemoryProvider` |
| `src/memory/sqlite-provider.ts` | **new** — default driver |
| `src/memory/automem-provider.ts` | **new** — automem REST driver (phase 2) |
| `src/memory/memory-mcp.ts` | **new** — OS-owned stdio MCP server (`remember`/`recall`) |
| `src/state/db.ts` | add `memories` (+ FTS5) tables to `migrate()` |
| `src/state/stores.ts` | **removed** — `MemoryStore`/`KnowledgeStore` scaffold (superseded) |
| `src/kernel.ts` | instantiate `this.memory`; read `memory` config |
| `src/types.ts` | `RunContext.memory?`; `MemoryConfig` on config type |
| `src/home.ts` | thread `MemoryConfig` through |
| `src/terminal.ts` | `createSession` async + recall injection; `writeMcpConfig` always adds memory server |
| `src/server.ts` | session-scoped `/api/memory/{remember,recall}` (gate-style, no cookie) + member-auth `/api/memory` console routes; `createSession` await |
| `terminal/claude-launch.sh` | memory behavioral preamble |
| `web/` | Memory page (phase 2) |
| `config/agent-os.config.json` | `memory` block |

---

## 11. Risks — verification status

Pre-flight checks run against this host (Node v22.22.0, live automem on `:8001`):

1. ✅ **FTS5 in `node:sqlite`** — **verified available** (`DatabaseSync` supports
   `CREATE VIRTUAL TABLE … fts5`, `MATCH`, and `bm25()`). Phase 1 ships ranked recall, not
   a fallback. `LIKE`+recency stays as a trivial degrade path only.
2. ✅ **`createSession` async ripple** — **verified one call site** (`server.ts:224`, already
   in an `async` handler). Add one `await`. No sync assumptions.
3. ✅ **automem tag isolation over REST** — **verified**: `tags=agent:<id>&tag_mode=all`
   filters correctly (`tag_match: prefix`, empty result for an unknown agent tag), so a
   single shared collection isolates agents by tag as designed — no per-agent container.
4. ⚠️ **Recall latency / availability** — automem `/recall` measured **~1–1.2s**; SQLite is
   sub-ms. Start-of-session recall is wrapped in a ~1.5s timeout → `[]` on expiry (§5c), and
   the driver degrades gracefully (recall `[]`, store best-effort) so a slow/down automem
   never blocks a session.
5. ☐ **Loopback trust for session-scoped routes** — same exposure model as the existing
   `/api/gate` (unauthenticated, session-tagged). Acceptable for a local single-box tool;
   document it. (Design choice to confirm at review, not a blocker.)
```

---

## 12. Decision (2026-06-23): add a `libsql` backend for local semantic recall

We evaluated **Turso** vs. the built-in `node:sqlite` memory store. Two distinct products carry the
"Turso" name: **libSQL** (the production C fork of SQLite) and **Turso Database** (the Rust rewrite,
ex-"Limbo", still **beta** with data-loss caveats). The Rust rewrite is rejected for a system-of-record
until it leaves beta and ships ANN vector indexing.

**libSQL is adopted as a third, opt-in backend** (`memory.backend = 'libsql'`) — *not* as a replacement
for the `node:sqlite` default. Why it earns its place: libSQL does **native vector search inside the
file** (`F32_BLOB`, `vector32()`, `vector_distance_cos()`), so an agent gets semantic recall from one
local `.db` with **no Qdrant/FalkorDB container** — collapsing the Phase 3 "SQLite embeddings" idea and
the automem vector lane into a single local file for single-box installs.

Design, as built (`src/memory/libsql-provider.ts`):

- **Hybrid recall** — bm25 (FTS5) ∪ cosine (vectors), blended by **reciprocal rank fusion** (K=60).
  Keyword precision for IDs/error-codes; semantic reach for synonyms.
- **Embeddings are optional + pluggable.** `embeddings.provider`: `openai` (OpenAI-compatible
  `/v1/embeddings` — OpenAI, LM Studio, llamafile) or `ollama` (local `/api/embed`, free, on-box,
  no key). Omit `embeddings` → lexical-only, i.e. behavioural parity with the `sqlite` backend.
  `embed()` never throws — any failure degrades that call to lexical.
- **Same isolation** as `sqlite`: every query scoped by `(tenant, agent_id)`; optional tag filter in JS.
- **Zero-dep stance preserved.** `@libsql/client` is an **optional dependency**, lazily imported only
  when this backend is selected (variable-specifier `import()` so tsc never resolves it). Core +
  default path stay dependency-free.

Config example (Ollama, local, free):
```jsonc
"memory": {
  "backend": "libsql",
  "libsql": {
    "url": "file:./data/memory.libsql.db",
    "embeddings": { "provider": "ollama", "url": "http://localhost:11434", "model": "nomic-embed-text", "dimensions": 768 }
  }
}
```
Or OpenAI:
```jsonc
"libsql": {
  "url": "file:./data/memory.libsql.db",
  "embeddings": { "provider": "openai", "url": "https://api.openai.com/v1", "model": "text-embedding-3-small", "apiKey": "sk-…" }
}
```
A remote `url: "libsql://…"` + `authToken` points at Turso Cloud instead of a local file (multi-box).

**Verification:** `npm run typecheck` clean; offline smoke test passes — lexical recall, `(tenant,
agent_id)` isolation, tag filter, recency fallback, and raw `F32_BLOB`/`vector32`/`vector_distance_cos`
nearest-neighbour ordering all confirmed against the installed libSQL build. The live embedding HTTP
call is unverified (no Ollama/key on this host), but the SQL it feeds is proven. **Caveat:**
`embeddings.dimensions` fixes the `F32_BLOB` width at table creation — keep it stable per data home.

---

## 13. Decision (2026-06-23): semantic recall on the DEFAULT sqlite backend (in-JS vectors)

The insight that drove this: the cost of vector search is the **embeddings** (a model call), not the
storage engine — any SQLite can hold and search vectors. So semantic recall doesn't actually require
libSQL. Three ways to do "SQLite + vectors": (A) **in-JS cosine** over a BLOB column on the built-in
`node:sqlite` — *zero new deps*; (B) the `sqlite-vec` loadable extension (`node:sqlite` exposes
`loadExtension`, confirmed on Node 24) — a native binary per OS; (C) libSQL (§12) — in-engine vectors
+ a real ANN index, one npm dep.

**Adopted: (A).** The `memories` table gains an optional `embedding BLOB` (packed `Float32`). When an
`Embedder` is configured, `SqliteMemoryProvider` embeds on store and, on recall, runs bm25 (keyword)
and an in-JS cosine scan over the agent's own (small) candidate set, blended by the **same** reciprocal
rank fusion the libsql backend uses. So the **out-of-the-box** backend now does hybrid semantic recall
just by adding an embedder — no container, no native binary, no dependency. The only thing given up vs.
(B)/(C) is a true ANN index, which doesn't earn its keep until per-namespace vectors hit the millions —
agent memory doesn't. libSQL (§12) remains the "outgrew it / want an ANN index / multi-box" path.

Shared code: `src/memory/embedding.ts` now holds the `Embedder`, cosine, `Float32` BLOB pack/unpack,
RRF `fuse`, and the FTS tokenizer — imported by **both** the sqlite and libsql providers, so they rank
identically (only *where* the cosine runs differs: JavaScript vs. in-engine).

Config (zero extra deps; Ollama shown — local + free):
```jsonc
"memory": {
  "backend": "sqlite",
  "sqlite": { "embeddings": { "provider": "ollama", "url": "http://localhost:11434", "model": "nomic-embed-text", "dimensions": 768 } }
}
```

UI: Settings → Memory shows an "Enable semantic search" toggle (with the Ollama / OpenAI switch) for
**both** the sqlite and libsql backends — the same embeddings sub-form.

**Verification:** typecheck + both builds clean; demo (default path) unaffected. Offline test passes —
`Float32` BLOB round-trip, cosine ordering (aligned > orthogonal), keyword-only mode, hybrid mode
(every row stores a 64-byte/16-dim BLOB; deploy memory outranks an irrelevant one; cross-tenant
excluded; fused scores descending), tag filter and recency fallback under hybrid, and the
`keyword-only` ↔ `hybrid:<embedder>` health label. A stub embedder stood in for the network call (the
embedder itself is the same proven `fetch` client). **Caveat:** the in-JS recall scans all of an
agent's embedded rows per query — fine at agent-memory scale; revisit (ANN / libSQL) only at millions.

---

## 14. Console: Settings → Memory, Ollama, and relevance display (2026-06-23)

The pieces that make the §12/§13 backends usable + observable from the console, all shipped:

- **Settings → Memory** (`SettingsStore.memoryConfig`, `AgentOS.buildMemory`/`applyMemory`, routes
  `GET/PUT /api/settings/memory` + `POST /api/settings/memory/test`). Owner/admin picks the backend
  (sqlite / libsql / automem) and, for sqlite/libsql, toggles embeddings (Ollama or OpenAI-compatible).
  Save **hot-swaps the live provider with no restart** (`os.memory` is mutable; new recall/remember
  calls use it immediately) and persists the full `MemoryConfig` (secrets included, redacted on read) to
  the DB, which **overrides the config-file default and survives restarts** (applied at boot in
  `loadAgentOS`). **Test** builds a candidate provider and health-checks it without swapping. Secrets are
  write-only (blank field = keep stored).
- **Ollama status** (`GET /api/settings/memory/ollama` → `probeOllama`). The embeddings form shows a live
  badge: `running · v… · <model> ✓`, or `installed but not running` / `not installed` with the exact
  `brew`/`ollama pull` hint. Probes whatever URL is typed (debounced); a PATH check distinguishes
  not-installed from not-running.
- **Relevance is visible.** The `recall` MCP tool now prefixes each result with `(relevance <score>)`
  (higher = better; absent for recency listings), and the console Memory page shows a `match <score>`
  badge per search result. Same scores from `MemoryRecord.score` — bm25-flip / cosine / RRF-fused
  depending on the path; comparable **within** a single recall, not as absolute thresholds.
- **Shared `src/memory/embedding.ts`** holds the `Embedder` (openai/ollama), cosine, `Float32` BLOB
  pack/unpack, RRF `fuse`, and the FTS tokenizer — imported by both the sqlite and libsql providers so
  they rank identically.

`@libsql/client` is an **optionalDependency**, lazily `import()`ed only when the libsql backend is
selected — the core + default path stay dependency-free. Verified end-to-end against a live `claude`
agent: it called `mcp__agentos__remember` ×3 then `mcp__agentos__recall`, and a no-shared-words query
("which database should I use here?") returned the SQLite-policy memory ranked #1 via Ollama embeddings.

---

## 15. Automatic session-end episodes (2026-06-23)

When a claude-code session ends, the OS now writes **one `Insight` memory** for its agent, so a later
session can `recall` what happened — agents accrue episodic memory without being asked.

- **Hooks (`src/terminal.ts`).** Both end paths write one: `markEnded(sessionId)` (the launcher's
  `/api/ended` when `claude` exits, headless + interactive) and `stopSession(sessionId, by)` (the console
  **Stop** button — which kills tmux, so `/api/ended` never fires and the episode must be captured here,
  with `outcome: 'stopped'`). Both call `writeEpisode()` *before* posting their end card, so any `completed`
  row it reads is the agent's real `report`, not the end note.
- **Content (`composeEpisode`, pure + unit-tested).** Prefers the agent's own end-of-session `report`
  summary (`Task / Outcome / <summary>`, `source: 'report'`, importance 0.7). Absent a report, distils the
  session's `audit_events` into a one-line activity summary (e.g. "2 governed actions, 1 fact remembered",
  `source: 'audit'`, importance 0.5). **Setup noise** (`session.*`, `connector.minted/…`) is excluded, so a
  session that did nothing yields **no episode**.
- **Stored** via the live `os.memory.store` (tags `['episode','session-end']`, `type: 'Insight'`,
  `metadata.sessionId/outcome/source`) — so episodes are recalled (and embedded, on a vector backend) like
  any memory. Fire-and-forget: never blocks the `/api/ended` response.
- **Idempotent** per session: an in-memory guard + an `episode.stored` audit marker (restart-safe), so a
  doubled `/api/ended` can't write two. Errors are swallowed to an `episode.error` audit event.

**Not changed:** `claude-launch.sh`/`server.ts` — the `/api/ended` → `markEnded` path already existed.

**Verification:** typecheck + build clean; demo unaffected. In-process test (real `TerminalManager`)
covers: reported session → episode from the summary (typed `Insight`, task + summary, `episode.stored`
audited); unreported-but-active → heuristic from the audit stream with setup events excluded; empty session
→ **no** episode; second `markEnded` → no duplicate; a later `recall` surfaces the episode; **Stop button on
a working session → heuristic episode with `Outcome: stopped`; Stop on an idle session → no episode.**

**Still open (per §9 Phase 3):** consolidation/decay + `associate` (merging related episodes, fading by
age) — the automem graph path. Episodes today are append-only.

---

## 16. Recall ranking — recency + importance (2026-06-23)

First slice of "consolidation/decay": a **re-ranking nudge** on top of relevance, so recall can favour
fresh and/or important memories — off by default, no data touched (a pure ranking change).

- **Shared (`src/memory/embedding.ts` → `rerank`).** Given a scored recall list, multiplies each score by
  `(importance weight) × (recency weight)`: importance maps 0..1 → ×[0.5,1.0] (unset = neutral 0.5);
  recency is `exp(−ln2·ageDays / halfLifeDays)` (weight halves every `halfLifeDays`). Base score is clamped
  ≥0 so a weight can't flip a poor match's sign. Imported by **both** the sqlite and libsql providers, so
  they rank identically; applied only on **scored** (query) paths — a no-query recency listing is left alone.
- **Config (`MemoryConfig.ranking: { halfLifeDays?, weightByImportance? }`).** Backend-independent, threaded
  through the factory to the sqlite/libsql providers (automem ranks server-side, so it's ignored there).
  Persisted + hot-applied via Settings → Memory like the rest; a **"Recall ranking"** card (half-life days +
  weight-by-importance toggle) shows for sqlite/libsql.
- **Agent guidance (`memory-mcp.ts`).** `remember`'s `importance` description now tells agents what the scale
  means and that it biases recall; `recall`'s description notes results may be nudged by recency/importance.

**Verification:** typecheck + both builds clean. In-process test (real `SqliteMemoryProvider`): equal-relevance
memories re-rank so the higher-`importance` one wins; under a half-life the newer one wins; **off by default**
leaves results unchanged; a no-query listing stays recency-ordered (not reranked); and decay is a nudge —
the older memory is still returned, just lower.

**Next in this track:** usage tracking (`last_recalled_at`/`recall_count`) → a prune sweep → near-duplicate
**consolidation** (merge by cosine ≥ threshold). See §9 Phase 3. — **shipped, see §17.**

---

## 17. Memory maintenance — usage tracking, prune, consolidation (2026-06-23)

Closes most of "consolidation/decay": the store now keeps itself healthy. All opt-in, conservative, audited.

- **Usage tracking (`db.ts`).** `memories` gains `recall_count` + `last_recalled_at`. A recall **with a query**
  bumps the rows it surfaced (a blank recency listing does not), so "never recalled" is a trustworthy signal.
- **`MemoryProvider.maintain(opts)`** (optional). sqlite + libsql implement it; automem omits it (self-maintains).
  - **Prune:** `DELETE … WHERE created_at < cutoff AND recall_count = 0 AND (importance IS NULL OR importance <
    keepImportance)`. Old **and** unused **and** unimportant — three guards, so it can't eat live memory.
  - **Consolidate:** a pure, shared planner (`planConsolidation` in `embedding.ts`) clusters an agent's memories
    greedily — the highest-value row (importance → recall_count → recency) anchors and absorbs exact-content
    duplicates, plus near-duplicates by **cosine ≥ `dedupeThreshold`** when both rows carry a vector. Merge keeps
    the anchor's text, takes max importance + summed recall_count, deletes the rest. sqlite loads vectors from the
    BLOB for near-dup; **libSQL does exact-content only** (its F32 vectors aren't pulled to JS yet).
- **Config (`MemoryConfig.maintenance: { pruneAfterDays?, keepImportance?, dedupeThreshold?, everyHours? }`).**
  Backend-independent; persisted + hot-applied via Settings → Memory. Enabled only when `pruneAfterDays` or
  `dedupeThreshold` is set.
- **Runs two ways.** `AgentOS.runMemoryMaintenance(by)` (reads the saved policy, audits `memory.maintained`):
  an **hourly scheduler** in `startServer` fires it when due per `everyHours` (default 24; no-op unless opted in),
  and a **`POST /api/settings/memory/maintain`** route powers the Settings → Memory **"Run now"** button (shows
  `pruned N, merged M`).

**Verification:** typecheck + both builds clean; server route mounted. In-process test (real `SqliteMemoryProvider`):
a query bumps usage and a blank listing doesn't; prune removes only the old+unrecalled+unimportant (keeping the
recent, the recalled, the important); 3 identical memories consolidate to 1 (max importance, summed recall_count);
two near-duplicates (distinct wording, same vector) merge while an unrelated memory stays; an empty policy is a no-op.

**Still open:** near-dup consolidation on libSQL (exact-only today); ANN index (§12/§14); shared cross-agent KB;
automem ops doc. The automem `associate` graph path remains the richer alternative to this in-provider upkeep.

---

## 18. Shared-scope memory — Phase 0 toward a KB (2026-06-23)

Full plan + as-built deviations: [`shared-memory-phase0-plan.md`](./shared-memory-phase0-plan.md) (✅ shipped).
Memory gained one axis: a `scope` — `agent` (private, default) or `tenant` (shared workspace-wide).

- **Schema (`db.ts`).** `memories.scope TEXT NOT NULL DEFAULT 'agent'` + `idx_mem_scope(tenant, scope,
  created_at)`. `agent_id` stays the **author** (provenance); `scope` governs **visibility**. *Migration
  gotcha:* the index must be created AFTER the idempotent `addColumn`, or an existing DB throws
  "no such column: scope" on startup.
- **Recall union (`sqlite` + `libsql`).** A `scopeWhere(q)` helper widens every visibility predicate
  (bm25, cosine, recency) from `agent_id = ?` to `(agent_id = ? OR scope = 'tenant')` by default;
  `q.scope` of `'agent'`/`'tenant'` narrows to own-only / shared-only. Ranking, decay, fusion, usage
  bookkeeping unchanged — a shared memory just competes in the same ranked pool.
- **Write stays authorship-locked.** `update`/`delete` keep the `agent_id` guard: an agent edits only what
  it authored, even when shared. `store` sets `scope = input.scope ?? 'agent'`.
- **Maintenance guard (beyond the plan).** Consolidation groups by `(tenant, agent_id, scope)` so a private
  and a shared copy never merge — which would silently change a memory's visibility.
- **Agent + console.** `remember(shared: true)` → `scope:'tenant'` via `/api/memory/remember` (audited with
  scope); `recall` description notes results include shared knowledge. Console Memory page: a *This agent /
  Shared / All* scope filter, a "Share with the whole workspace" checkbox on add, and a "shared" badge.
- **Parity.** libsql full (recall union + store + exact-dedupe by scope). automem carries `scope` on records
  but tenant sharing there (tag-based: write without the `agent:` tag, recall without the agent filter) is
  deferred. Human edit-any-shared (admin escape hatch) deferred.

**Posture:** shared writes are **ungated but audited + authorship-tracked + human-removable** — the cheap
Phase-0 bet to learn whether shared knowledge accrues before adding approval-gating or a full KB plane.

**Verification:** typecheck + both builds clean; demo OK (exercises the existing-DB migration). In-process
test (real `SqliteMemoryProvider`): A's private stays invisible to B; A's shared is visible to B; the
`agent`/`tenant`/`all` filters resolve correctly; a no-query listing respects the union; and consolidation
does **not** merge across scope. Loopback smoke: `remember(shared:true)` → `scope:'tenant'`, recall returns it.

**Graduate to the full KB** (`knowledge-base-plan.md`) when humans need a wiki of editable pages, knowledge
wants to be documents not snippets, or revision history/rollback is needed for trust.

**Round-out — curation + governance (2026-06-23).** Two safety/management pieces on top of Phase 0:
- **Human curation.** `UpdateInput/DeleteInput.admin` relaxes the per-author guard to `(tenant, id)` only;
  the console PATCH/DELETE set `admin = isAdmin(me)`, so owners/admins edit/remove **any** memory (incl.
  another agent's shared one). The Memory page hides edit/delete on memories a member can't touch (server
  enforces regardless). sqlite + libsql honor it; automem ignores the optional flag (parked).
- **Shared-write policy.** `MemoryConfig.sharedWrites` = `open` (default — any agent publishes shared,
  audited) | `curated` (an agent's `remember(shared)` is downgraded to private at `/api/memory/remember`,
  and the MCP tool tells it only a human can publish). A Settings → Memory toggle, persisted + hot-applied.
  Full blocking-approval per shared write was considered and **not** built — the curated knob is the lighter
  control for Phase 0.
- **Verified:** 6/6 provider assertions (admin edits/deletes another agent's shared memory; non-admin is
  author-guarded; the blocked write doesn't mutate; the normal own-memory path is intact). Loopback: under
  `curated`, an agent's `remember(shared:true)` returns `{scope:'agent', downgraded:true}`.
