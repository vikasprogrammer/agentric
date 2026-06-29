# Agent OS Knowledge Base (KB) — Implementation Plan

> **Status (2026-06-23): backend shipped ✅ · console UI pending.** Built per this design: `kb_pages`/
> `kb_revisions`/`kb_fts` (`db.ts`), `KbStore` (`src/state/kb.ts`, wired as `os.kb`), the loopback +
> console routes (`src/server.ts`), and the `kb_search`/`kb_read`/`kb_write` MCP tools (`memory-mcp.ts`,
> allowlisted in `claude-launch.sh`). Decisions held: auto-apply + audit (no gate), markdown-on-disk +
> SQLite/FTS mirror, section/slug pages with a full revision chain + revert. **Tested:** 13/13 store
> assertions (create→edit→history→revert→search→tenant-isolation→remove) + a live loopback smoke
> (agent write→search→read, on-disk `kb/<section>/<slug>.md` mirror confirmed). The **self-learning
> layer already writes to it** (see §5 + `src/edge/dreaming.ts`). The **console Knowledge page** (§6) is
> now shipped too — a section/page tree + search on the left, rendered markdown with an Edit toggle, and
> a revision list with per-rev view + one-click revert (data path verified end-to-end with auth).
> **Remaining (not v1):** a side-by-side rev **diff** view, deeper hierarchy, and a `kb-gardener` example
> automation (§5.2 — the richer LLM synthesis layered on the deterministic Dreamer).

Ship a **company wiki** for each tenant that agents and humans co-author. Unlike Memory (private,
per-agent scratch state) it is **shared, tenant-wide, living state** — pages that get continuously
rewritten over time so the company accumulates an up-to-date KB **without humans touching it unless
something needs review**.

## 0. Where KB sits relative to Memory and Artifact

KB is *not* "Memory but bigger." The three planes differ on the axes that drive the design:

| | Memory | Artifact | **KB** |
|---|---|---|---|
| Scope | per-agent `(tenant, agentId)` | per-session snapshot | **tenant-wide, shared** |
| Mutability | append + curate | immutable | **living, rewritten in place** |
| Writers | one agent (its own) | one agent | **many agents + humans** |
| History | none | none | **full revision chain + rollback** |
| Storage | SQLite rows (+ optional vec) | file on disk + SQLite meta | **markdown on disk + SQLite meta/FTS** |
| Governance | OS-owned, ungated | OS-owned, ungated | **OS-owned, ungated (auto-apply + audit)** |

The shared+mutable+multi-writer nature is the whole story. We make every write safe **not** by gating
it behind approvals (decision below) but by making it **non-destructive**: every edit creates a new
revision, the old body is retained, and any human (or agent) can revert. Trust comes from
reversibility + audit, not from a human in the loop.

## Decisions (locked)

1. **Governance: auto-apply, audit only.** Agents write freely, like Memory — no approval gate, no
   gateway. Humans notice changes via the audit log and the per-page revision history, and revert if
   needed. Maximum autonomy; this is the "without humans touching it" requirement taken literally. The
   safety net is the revision chain (§2), not approvals. *(If we later want a brake, it's a one-line
   policy hook in `kbWrite` — see §7 "Future".)*
2. **Storage: markdown on disk + SQLite metadata/FTS.** Page bodies live as
   `<home>/kb/<section>/<slug>.md`; SQLite holds metadata, the FTS5 search index, and the revision
   history. Agents edit markdown naturally, we get git-style diffs for free, and it matches the
   skills-library (`skills/<name>/SKILL.md`) and Artifact patterns already in the repo.
3. **Structure: section folders + tagged pages.** A page belongs to one **section** (a flat folder
   namespace, e.g. `engineering/`, `sales/`), and carries a `title`, `tags[]`, and a markdown body
   with `[[wiki-links]]` to other pages. No deep nesting in v1; richer hierarchy can come later.

---

## 1. Data model

### 1.1 On disk — the data home (`src/home.ts`)

```
<home>/kb/<section>/<slug>.md      # one file per page, current body (system-of-record body text)
```

`<home>/kb/` is created lazily on first write, like `<home>/artifacts/`. All paths are validated to
stay **contained under `<home>/kb/`** (lexical + symlink-resolved), reusing the `containedPath()`
guard already in `src/state/artifacts.ts` — so a bad `section`/`slug` can never escape the KB root.

### 1.2 SQLite — `src/state/db.ts` `migrate()`

Add to the idempotent `CREATE TABLE IF NOT EXISTS` block (and an `addColumn` pass for older DBs, same
convention as the inbox columns):

```sql
-- A KB page: shared, tenant-wide, living. One row per current page; body also on disk at rel_path.
CREATE TABLE IF NOT EXISTS kb_pages (
  id           TEXT PRIMARY KEY,          -- short uuid (8)
  tenant       TEXT NOT NULL,
  section      TEXT NOT NULL,             -- folder namespace, e.g. 'engineering'
  slug         TEXT NOT NULL,             -- url-safe; unique within (tenant, section)
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL,             -- JSON string[]
  body         TEXT NOT NULL,             -- current markdown (mirror of the .md file for FTS + speed)
  rel_path     TEXT NOT NULL,             -- kb/<section>/<slug>.md
  rev          INTEGER NOT NULL,          -- current revision number (starts at 1)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL              -- member id | agent:<id> | automation:<id>
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_slug ON kb_pages(tenant, section, slug);

-- Every prior version of a page. Append-only; this is the rollback + audit backbone.
CREATE TABLE IF NOT EXISTS kb_revisions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  tags       TEXT NOT NULL,
  body       TEXT NOT NULL,               -- full snapshot (pages are small; cheap + simple)
  summary    TEXT,                        -- one-line "what changed" from the writer
  author     TEXT NOT NULL,               -- member id | agent:<id> | automation:<id>
  created_at INTEGER NOT NULL,
  UNIQUE(page_id, rev)
);
CREATE INDEX IF NOT EXISTS idx_kb_rev_page ON kb_revisions(page_id, rev);

-- FTS5 over title+tags+body for ranked search (mirrors memories_fts exactly).
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  title, tags, body, content='kb_pages', content_rowid='rowid'
);
-- + the three ai/ad/au triggers keeping kb_fts in sync (copy memories_ai/ad/au).
```

Why store the body **both** on disk and in the `body` column: disk is the human/git-friendly
system-of-record and what an agent edits; the column feeds FTS5 and lets the API serve a page without
a file read. The store writes both in one operation and they never diverge (single writer path).

### 1.3 Types — `src/types.ts`

```ts
export interface KbPage {
  id: string;
  tenant: string;
  section: string;
  slug: string;
  title: string;
  tags: string[];
  body: string;
  relPath: string;
  rev: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface KbRevision {
  id: string; pageId: string; rev: number;
  title: string; tags: string[]; body: string;
  summary?: string; author: string; createdAt: number;
}

export interface KbWriteInput {
  tenant: string;
  section: string;
  slug: string;            // identifies the page; created if absent
  title?: string;          // required on create
  body: string;
  tags?: string[];
  summary?: string;        // one-line change note → stored on the revision
  author: string;          // member id | agent:<id> | automation:<id>
}

export interface KbSearchQuery { tenant: string; query?: string; section?: string; tags?: string[]; limit?: number; }
```

---

## 2. The store — `src/state/kb.ts`

A `KbStore` class mirroring `ArtifactStore` (constructed with `(db, dir?)`, `enabled = !!dir`):

- `write(input: KbWriteInput): KbPage` — the one mutating path. Upsert by `(tenant, section, slug)`:
  - resolve+validate the path under the KB root (`containedPath`);
  - bump `rev` (1 on create, `+1` on edit);
  - **append a `kb_revisions` row** with the *previous* body before overwriting (so rev N's snapshot
    is always retrievable) — on create, rev 1 is the first snapshot;
  - write the `.md` file and update `kb_pages` (body, title, tags, rev, updated_*);
  - FTS5 stays in sync via triggers.
- `search(q: KbSearchQuery): KbPage[]` — bm25 over `kb_fts`, optional `section`/`tags` filter,
  recency tiebreak. Same shape as the memory provider's `recall`. Empty query → most-recently-updated.
- `read(section, slug): KbPage | null`, `get(id)`, `list({section?})`.
- `history(pageId): KbRevision[]` and `revert(pageId, rev, author): KbPage` — revert is just a
  `write()` of an old revision's body with `summary: "revert to rev N"`, so it too is auditable and
  itself revertable. **Nothing is ever truly deleted.**
- `remove(id, author)` — soft path: write a tombstone revision + drop from `kb_pages` (keeps history),
  or hard-delete the file. Owner/admin only at the route layer. (Decide at build time; soft preferred.)

Wire it into the kernel exactly like Artifact (`src/kernel.ts`):

```ts
readonly kb: KbStore;
// in constructor:
this.kb = new KbStore(this.db, opts.paths?.kb);   // opts.paths.kb = <home>/kb
```

`src/home.ts` resolves and returns the `kb` dir alongside `artifacts`.

---

## 3. Server routes — `src/server.ts`

Two tiers, identical to Memory/Artifact:

### 3.1 Session-scoped loopback (agents, `sessionSecretOk` + `x-aos-secret`)

```
GET  /api/kb/search?session=&q=&section=&tags=&limit=   → { pages }
GET  /api/kb/read?session=&section=&slug=               → { page }
POST /api/kb/write   { session, section, slug, title?, body, tags?, summary? }
                                                         → { ok, id, rev }   + audit 'kb.written'
```

`author` is derived server-side as `agent:<agentId>` from the session row (never trusted from the
agent). **New loopback routes need `npm run build` + a server restart** to take effect — per the
CLAUDE.md stale-server note (a fresh route 404→falls through to the login gate and looks like a 401
auth bug until you restart).

### 3.2 Member-scoped console (humans, cookie session)

```
GET    /api/kb                         → { pages, sections, enabled }   (any logged-in member)
GET    /api/kb/page/{id}               → { page }
GET    /api/kb/page/{id}/history       → { revisions }
POST   /api/kb/page          { section, slug, title, body, tags }   → human create (author = member id)
PATCH  /api/kb/page/{id}     { title?, body?, tags?, summary? }     → human edit
POST   /api/kb/page/{id}/revert  { rev }                            → { ok, rev }
DELETE /api/kb/page/{id}     (owner/admin only)                     → audit 'kb.deleted'
```

KB is tenant-wide, so reads are open to any member of the tenant (no `canRun`/`canViewSpawn` filter
like Memory/Artifact — those are per-agent/per-spawn; KB is the shared company wiki). Writes are open
to any member; destructive delete is owner/admin.

Audit events: `kb.written` (agent or human), `kb.reverted`, `kb.deleted` — flowing to the same
TeeAuditSink (JSONL + `audit_events` mirror) as everything else.

---

## 4. Agent-facing MCP tools — `src/memory/memory-mcp.ts`

Add three tools to the existing OS-owned MCP server (so every claude-code session gets them with no
new server wiring — the launcher already injects `agentos`). They follow the `recall`/`remember`
pattern and call the loopback routes above:

- **`kb_search({ query, section?, tags?, limit? })`** → ranked page list (slug, title, section,
  snippet). "Search the company knowledge base before answering or starting work."
- **`kb_read({ section, slug })`** → full page markdown.
- **`kb_write({ section, slug, body, title?, tags?, summary? }`)** → create or update a page.
  "Record durable, company-wide knowledge others will reuse. Editing an existing page is encouraged —
  your change is versioned and revertable."

Tool guidance must draw the **KB-vs-Memory line** explicitly in the descriptions, or agents will
conflate them: *Memory = your own private notes for your own future runs; KB = shared canonical
company knowledge for everyone.* Reinforce in agent `CLAUDE.md` guidance.

**MCP tool changes need `npm run build` + relaunching the session** (claude spawns the MCP server
fresh per session) — per CLAUDE.md.

---

## 5. The autonomy loop — "no humans touch it unless necessary"

Two mechanisms make the KB self-maintain:

1. **In-flight capture.** Because `kb_write` is just a tool, any agent doing real work writes back what
   it learned (a runbook it followed, a decision it made, a fact it discovered). The tool description
   nudges this. This is the steady-state drip that keeps pages fresh.

2. **A scheduled "KB gardener" Automation** (`src/edge/automations.ts`, cron trigger → headless
   session). On a cadence (e.g. nightly) a gardener agent:
   - `kb_search`es for stale/thin pages and scans recent sessions/Memory for new durable knowledge;
   - **dedupes against existing pages before writing** (search first, then update-in-place rather than
     create-duplicate — the single most important behavior to prompt hard);
   - updates pages with a clear `summary`, links related pages with `[[wiki-links]]`, and flags genuine
     conflicts it can't resolve by posting an inbox card (`report`) for a human.

Humans only engage when the gardener escalates or when they spot something in the revision history.
Everything else accrues silently. The revision chain means a bad autonomous edit is a one-click revert,
which is what makes "let agents write freely" safe without an approval gate.

---

## 6. Console UI — `web/src`

A new **Knowledge Base** page (sibling to the Memory/Artifacts pages), client types in
`web/src/lib/api.ts` mirroring the `Artifact` block:

- left: section tree + page list (search box hits `/api/kb`);
- center: rendered markdown view of the selected page, with an **Edit** toggle (textarea → `PATCH`);
- right / drawer: **revision history** with diff + one-click **Revert**, showing `author` and
  `summary` per rev (this is where a human audits what agents have been doing).

Web-only changes: `cd web && npm run build`, reload — no server restart (Node serves `web/dist` off
disk).

---

## 7. Build order & validation

1. `db.ts` migration (tables + FTS triggers) → `src/types.ts` types.
2. `src/state/kb.ts` `KbStore` + kernel/home wiring.
3. Server routes (session + member tiers) + audit events.
4. MCP tools in `memory-mcp.ts` + launcher tool-allow (mirror how `remember`/`recall` are allowlisted).
5. Console KB page + revision/diff/revert UI.
6. A `kb-gardener` example automation + agent `CLAUDE.md` guidance.

Validate the usual way (no test runner): `npm run typecheck`, `cd web && npm run build`, `npm run demo`,
and a small in-process Node script that spins `createHttpServer` on an ephemeral port and drives the
`/api/kb/*` routes with `fetch` (write → read → history → revert → search). Update `docs/PILLARS.md`
when KB lands.

### Future (not v1)
- **Optional policy brake.** If "auto-apply everything" ever proves too loose, gate `kb_write` through
  `Policy.classify()` in the route handler: green auto-applies, yellow (large rewrite / `protected`
  tag) suspends for approval, red (delete / `compliance` tag) needs owner — turning KB into a gated
  capability without touching the store. Designed for, deliberately off in v1.
- Semantic recall (reuse the memory `Embedder` over page bodies), deeper hierarchy, page-level
  access scoping, export to a static site (`kind:'site'` artifact).
