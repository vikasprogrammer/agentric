# Agent library — a browsable catalog of importable agents

**Status:** **Phase 1 shipped** (v0.49.0). The pattern this spec mirrors already ships for *skills*: a
**local bundled catalog** (`config/skills` → Settings → Skills → Install). The agent library is the
agent-side twin of it — a **distribution-only** catalog: the entries are fixed by what ships in
`config/agents/`, an owner installs *from* it, and (per the ratified scope) users cannot add to it. A
one-off agent still arrives via the existing bundle importer.

**What shipped:** the catalog module `src/edge/agent-catalog.ts` (`readAgentCatalog` / `installAgentFromCatalog`
/ `seedBuiltinAgents` + `BUILTIN_SEED_IDS`); the console routes `GET /api/agents/catalog` +
`POST /api/agents/catalog/:id/install` (`src/server.ts`, owner/admin, audited `agent.installed`); the
**Agent library** collapsible section on the Agents page (`web/src/App.tsx`, mirroring `SkillCatalog`);
and the migration that proves it out — the five built-in agents (`agent-author`, `engineer`, `support`,
`marketer`, `researcher`) moved out of the hardcoded `src/edge/generalists.ts` / `src/edge/agent-author.ts`
(both deleted) into `config/agents/<id>/{agent.json,CLAUDE.md}` as catalog data, plus two install-on-demand
library agents (`sales`, `ops`) so the library has something to actually import. Boot now seeds the
built-in fleet from the catalog (`seedBuiltinAgents`) and no longer auto-registers catalog entries into
the live fleet (`kernel.ts`).

**Cut (per the distribution-only decision):** the remote GitHub registry (an `agent-registry.ts` clone of
`skill-registry.ts` that would let users install agents from arbitrary repos). The library is what we
ship, full stop. Marketplace-format export + an A2A card remain possible future interop work.

## The gap

A workspace ships with five built-in agents, and **every one of them is TypeScript, not data**:

- `src/edge/agent-author.ts` → the `agent-author` system agent (manifest + `CLAUDE.md` as string literals).
- `src/edge/generalists.ts` → `engineer`, `support`, `marketer`, `researcher` (four more, same shape).

They are *code-provisioned* at boot: `ensureAgentAuthor(os)` / `ensureGeneralists(os)` (`src/kernel.ts:303-304`)
idempotently write `<home>/agents/<id>/{agent.json,CLAUDE.md}` on every start. `config/agents/` exists as
a load path (`src/home.ts:86`, `loadAgentsFrom` at `src/kernel.ts:298`) but ships **empty**.

Contrast that with skills, which arrive **three** ways, all as data an operator can browse and choose:

1. Hand-authored in the console.
2. Installed from the **bundled catalog** — `config/skills/` → `SkillsStore.catalog()`/`install()`
   (`src/governance/skills.ts:234,251`), surfaced at `GET /api/skills/catalog` +
   `POST /api/skills/catalog/:name/install` (`src/server.ts:2266,2270`), with an "Install / Installed"
   UI on the Skills page.
3. Pulled from a **remote GitHub repo** — `src/edge/skill-registry.ts` (trees API + `raw.githubusercontent.com`,
   zero-dep, owner/admin-gated, file-count/size capped), with featured `PRESET_SOURCES`.

So the console can present a *library of skills to import*, but there is no library of *agents* to import.
Getting a new agent in means: hand-author it, self-create it via the `agent_create` MCP tool, or import a
one-off **bundle** zip (`POST /api/agents/import`, `src/governance/bundle-import.ts`). All three produce
**one** agent; none is a browsable, curated, installable **catalog**.

**This plan builds that catalog** — and closes the loop by making the built-in fleet the catalog's first
entries instead of compiled-in strings.

## Design principle — compose two patterns we already ship

Nothing here is new infrastructure. It's the two proven skills-distribution patterns pointed at a new
payload (a whole agent bundle instead of a `SKILL.md` folder), reusing the importer we already have:

1. **Local bundled catalog** — exactly `SkillsStore.catalog()`/`install()` over `config/skills`. We add
   `config/agents/` as the software's read-only **agent** catalog and give `AgentStore` the same
   `catalog()` / `installFromCatalog(name)` pair.
2. **Remote registry** — exactly `skill-registry.ts` over a public GitHub repo. An agent library repo is
   a repo of bundle folders (`<agent-id>/{agent.json,CLAUDE.md,memory.jsonl,skills/,knowledge/}`) plus a
   small `library.json` index. Detection mirrors "any dir with a `SKILL.md`": **any dir with an
   `agent.json`** is an installable agent.

And the import itself is **already written**: `parseBundle()` + the sanitize/rebuild path behind
`POST /api/agents/import` (`src/server.ts`) turn one bundle into a live, governed agent — validating the
id, re-deriving `principal`/`policyContext`/`budget` with safe defaults, installing `skills/`, replaying
`memory.jsonl` and `knowledge/`, and auditing `agent.imported`. The catalog and registry are just
**sources that feed bytes into that same pipe.**

## The on-disk shape (aligns with the Claude Code marketplace standard)

The ecosystem has consolidated on the Claude Code *marketplace* format — a repo with
`.claude-plugin/marketplace.json` listing `plugins/<name>/` folders. We deliberately keep the agent-os
**bundle** as canonical (it is *richer* — it carries `memory.jsonl`, `knowledge/`, `budget`,
`policyContext`, `principal`, `shellSecrets`, which a plain Claude Code agent `.md` has nowhere to hold),
and treat marketplace-format as an **export/interop** target, not the source of truth. A bundled catalog
entry is just a bundle folder that lives in the software instead of a zip:

```
config/agents/                         # the software's agent catalog (paths.bundledAgents)
  engineer/
    agent.json                         # manifest (id, description, category, icon, budget, model?…)
    CLAUDE.md                          # system prompt
    memory.jsonl                       # optional — seed memories (one JSON fact per line) [future]
    skills/<name>/SKILL.md             # optional — bundled procedures [future]
    knowledge/<section>/<slug>.md      # optional — seed KB pages [future]
  support/ marketer/ researcher/ agent-author/   # seeded built-ins
  sales/ ops/                          # install-on-demand library agents
```

**No index file.** The catalog is derived directly by scanning the folders (`readAgentCatalog` reads each
`<id>/agent.json`) — there's no `library.json`/`marketplace.json` to hand-sync (the "generated vs authored"
decision, resolved in favour of neither: derive it live, like the skills catalog does). The five built-in
folders carry only `agent.json` + `CLAUDE.md` today; `installAgentFromCatalog` deep-copies the whole
folder, so richer bundle content (`memory.jsonl` replay, `skills/`, `knowledge/`) is a documented future
add — the one-off bundle importer already handles those for a rich agent.

## The migration — built-ins become catalog data

This is the change that proves the catalog and deletes prompt strings from the codebase:

1. **Author `config/agents/<id>/`** for `engineer`, `support`, `marketer`, `researcher`, `agent-author`
   — `agent.json` + `CLAUDE.md` lifted verbatim out of `generalists.ts` / `agent-author.ts`.
2. **Replace `ensureGeneralists`/`ensureAgentAuthor` with `seedBuiltinAgents`.** It keeps their *contract* —
   "a fresh home boots with the built-in fleet, idempotently, user edits survive, a deleted one is
   restored on the next boot" — but the source of truth moves from string literals to `config/agents/<id>/`:
   on boot, for each `BUILTIN_SEED_ID` whose `<home>/agents/<id>/` folder is absent, deep-copy it out of the
   catalog. The two old files (`generalists.ts`, `agent-author.ts`) are **deleted**.
3. **Net effect:** the same five agents ship, but now they are (a) editable data, (b) rows of a browsable
   catalog, and (c) removable/re-installable from the console like any other library agent. Prompts stop
   being TypeScript.

> **Resolved — auto-seed vs install-on-demand:** the five built-ins are **auto-seeded** (preserve "useful
> the moment it boots"); everything *else* in the catalog (`sales`, `ops`, and future entries) is
> **install-on-demand**. To make that split real, boot no longer auto-registers `config/agents/` entries
> into the live fleet (the old `loadAgentsFrom(paths.bundledAgents)` is removed, and `rescanAgents` scans
> the data home only) — a catalog agent reaches the fleet only by being seeded or installed.

## Surface area

**Catalog module** — `src/edge/agent-catalog.ts` (not a new store class — agents are kernel-managed):
- `readAgentCatalog(catalogDir, userAgentsDir): CatalogAgent[]` — scan `config/agents/*/agent.json`, each
  flagged `installed` (does `<home>/agents/<id>/` exist?) and `builtin` (is it a seed id). `CatalogAgent` ≈
  `CatalogSkill` (id, description, category, icon, model, effort, examplePrompts, installed, builtin).
- `installAgentFromCatalog(catalogDir, userAgentsDir, id): AgentManifest` — deep-copy the catalog folder
  into `<home>/agents/<id>/` (throws if it already exists) and return the manifest tagged with its home
  dir; the route registers it live + audits `agent.installed { source: 'catalog' }`. Catalog agents are
  trusted software, so the manifest is copied as-is (no re-sanitize — that guards the *untrusted* bundle
  path).
- `seedBuiltinAgents(os)` — the boot seed; `BUILTIN_SEED_IDS` = the five.

**Remote registry — cut.** Per the distribution-only decision there is no `agent-registry.ts`; the library
is exactly what ships in `config/agents/`.

**Routes** (copy the skills-catalog routes, agent nouns):
- `GET  /api/agents/catalog` — the bundled catalog (owner/admin).
- `POST /api/agents/catalog/:id/install` — install one built-in/catalog agent.
- `POST /api/agents/registry/install` — `{ repo, id? }` remote install (owner/admin).
- (existing `POST /api/agents/import` for one-off zips stays as-is — the manual lane.)

**Console** — an **Agent Library** view (cards: icon, name, category, description, Install / Installed),
next to the existing "Import bundle" button on the Agents page. Same component shape as the Skills
catalog list; a "From GitHub" input mirrors the skills remote-source UI.

## The differentiator — a *governed* library

Public agent marketplaces (2,500+ Claude Code registries; directories with 100–200+ subagents) compete
on breadth. agent-os's edge is that **every imported agent lands behind the gateway** — policy, budget
caps, `principal`, audit — and the importer already refuses secrets / absolute paths / `.claude/`
internals and re-derives every governance field with safe defaults rather than trusting the bundle. The
registries enterprises actually adopt are converging on exactly what agent-os has natively: eval
signals, a promotion lifecycle, supply-chain visibility, and **security scanning before publish**
(prompt-injection / secret-exfil / dangerous-command checks). Because agent-os owns the *runtime*, not
just the listing, it can offer a "verified, sandboxed on install" library no gallery can match. That is
the story to lead with, and the sanitize path in `bundle-import.ts` is its first brick.

## Phasing

- **Phase 1 — bundled catalog + migration (shipped, v0.49.0).** `config/agents/` catalog, the
  `agent-catalog.ts` module, the two catalog routes, the Agent library console section, and the five
  built-ins moved out of TypeScript into `config/agents/` (+ `sales`/`ops` install-on-demand). Self-contained,
  no new external surface.
- **Phase 2 — remote registry: CUT.** The distribution-only scope means no install-from-arbitrary-repo
  lane. (If that scope ever changes, an `agent-registry.ts` clone of `skill-registry.ts` reusing the same
  install path is the shape.)
- **Phase 3 — interop & richer entries (future).** Marketplace-format **export** (`marketplace.json` +
  `plugins/`) and an A2A `/.well-known/agent-card.json` for external discovery; catalog entries that carry
  `memory.jsonl` / `skills/` / `knowledge/` and replay them on install (extract the bundle-import route's
  replay path so both lanes share it); optionally a `publish-with-scan` flow for a "verified" badge.

## Decisions (resolved)

1. **Format allegiance** — the agent-os bundle stays canonical (preserves budget/policy/principal the
   plugin format can't hold); marketplace-format export is a future interop target, not the source of truth.
2. **Auto-seed vs install-on-demand** — auto-seed the five built-ins; everything else install-on-demand.
3. **Index file** — none; the catalog is derived live by scanning the folders (no `library.json` to sync).
4. **Trust** — the library is distribution-only (trusted software), so catalog installs copy the manifest
   as-is; the re-sanitize path stays reserved for the untrusted one-off bundle importer.

## Touch points (reference)

| Concern | Skills (exists) | Agents (shipped) |
|---|---|---|
| Bundled catalog dir | `config/skills` (`home.ts:87` `bundledSkills`) | `config/agents` (`home.ts:86` `bundledAgents`) |
| Catalog logic | `SkillsStore.catalog()`/`install()` (`skills.ts:234,251`) | `agent-catalog.ts` `readAgentCatalog`/`installAgentFromCatalog` |
| Catalog routes | `GET /api/skills/catalog`, `POST …/catalog/:name/install` (`server.ts:2266,2270`) | `GET /api/agents/catalog`, `POST /api/agents/catalog/:id/install` |
| Remote registry | `src/edge/skill-registry.ts` (GitHub trees API, `PRESET_SOURCES`) | cut (distribution-only) |
| One-off import | — | `parseBundle()` + `POST /api/agents/import` (`bundle-import.ts`, reused) |
| Built-in provisioning | n/a | `seedBuiltinAgents` (`agent-catalog.ts`, called from `kernel.ts`) |
| Console UI | `SkillCatalog` section (Skills page) | `AgentLibrary` section (Agents page, `web/src/App.tsx`) |
| Manifest schema | `SKILL.md` frontmatter | `AgentManifest` (`types.ts:667-698`) |

See also `docs/procedural-skills-plan.md` (the skills-distribution patterns this mirrors) and
`web/src/docs/import-into-aos.md` (the bundle format).
