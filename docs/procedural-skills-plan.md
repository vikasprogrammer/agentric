# Procedural skills — Lever 6 of the learning loop

**Status:** **Phase 1 shipped** (v0.37.0) — the defaults this spec recommends: fleet-wide `skill_propose`
+ gardener remit · draft-in-library (`.aos-proposed`) staging · a `skill.proposed` inbox card to
owner/admins · human-gated publish only. Phase 2 (opt-in `skills_autopublish`, usage-based retirement,
auto-scoping) remains future work. Closes the last open gap in the memory chapter: the fleet learned
*facts* but not yet *procedures*.

**What shipped:** `SkillsStore.propose`/`publish` + the `proposed` flag & `materialize()` skip
(`src/governance/skills.ts`); the always-on `skill_propose` MCP tool (`src/memory/memory-mcp.ts`) →
loopback `POST /api/skills/propose` + owner/admin `POST /api/skills/:name/publish`, dismiss via the
existing `DELETE /api/skills/:name` (`src/server.ts`); `TerminalManager.proposeSkill` posting the
`skill.proposed` inbox card + audit; the procedure encoding-trigger in the operating notes and the
gardener remit (`src/terminal.ts`, `src/edge/consolidation.ts`); and the Skills-page **"Proposed by
self-learning"** review/publish/dismiss section (`web/src`).

## The gap

Levers 1–5 close the **episodic → semantic** loop — episodes, lessons, salience, the consolidation
gardener, retrieval reinforcement — but every output is a *fact*: a memory or a KB page. The skills
library (`src/governance/skills.ts`) is the OS's **procedural** store (a reusable multi-step *how-to*,
materialised into every agent at launch), yet nothing ever *writes* to it from experience. Skills only
arrive three ways, all external to the fleet's own work: hand-authored in the console, installed from
the bundled catalog (`config/skills`), or pulled from a GitHub repo / skills.sh (`skill-registry.ts`).

This is precisely the layer Nous Research's **Hermes Agent** leads with — its "procedural memory": when
the agent solves a hard problem or repeats a workflow, it *writes its own `SKILL.md`* so it never
re-derives it. We have the store, the materialisation path, the editor, and a governance model they
don't — we're just missing the pipe from *"the fleet did this successfully, more than once"* to *"here
is a skill for it."*

**Lever 6 builds that pipe — and keeps it governed:** a proposed skill is a *draft*, never live, until a
human reviews and publishes it.

## Design principle — compose two patterns we already ship

Nothing here is novel infrastructure; it's the two proven learning-loop patterns pointed at a new output:

1. **Quality synthesis via a governed headless agent** — exactly the consolidation gardener
   (`src/edge/consolidation.ts`). Real-Claude synthesis over a batch of episodes, reusing all
   governance/audit, no in-process LLM client. The gardener already reads the recurring signal; we give
   it a third output channel.
2. **Human-gated rollout** — exactly the Dreaming *recommendations* flow (`deriveRecommendations` →
   `settings.recommendations()` → console **Apply / Dismiss**). A generated skill is a *proposal*; a
   human publishes it (or dismisses it). This preserves the invariant that **nothing changes how the
   fleet works without a human's ok** — and even after publish, the PreToolUse gate still governs every
   effect the skill drives (a skill packages *how* an agent works, never *what it may do*).

## Two producers, one review queue

A skill-worthy procedure surfaces in two places; both feed the same gated queue:

- **(a) At the point of experience — any agent, post-task.** A new always-on MCP tool `skill_propose`
  (sibling of `report` / `remember`), guided by an operating-notes trigger: *"When you complete a
  reusable, multi-step procedure that a teammate could follow verbatim, propose it as a skill."* This is
  Lever 1/2's encoding-trigger idea applied to **procedures** — and it mirrors Hermes's "solved a hard
  problem → writes a skill." Safe fleet-wide because every call lands as a **proposal**, not a live skill.
- **(b) Across the batch — the gardener.** Extend the consolidator's remit from *"episode → fact
  (memory/KB)"* to *"distil each episode into the right artifact"*: a durable **fact** → `remember`
  (shared) / `kb_write` (unchanged), a **repeatable procedure seen ≥ N times** → `skill_propose`. One
  governed run over the same watermarked batch, same dedup discipline (check existing skills first).

Producer (a) catches the one-off brilliant solution immediately; (b) catches the pattern that only
emerges across many sessions. Together they match Hermes's "writes after a hard problem" **and** its
"after enough similar tasks" triggers — with a review gate neither of theirs has.

## Staging model — draft-in-library (recommended)

A proposal must be **reviewable and editable** before it goes live (auto-drafts need a human polish),
and skills already have a first-class console editor. So stage a proposal as a **real skill folder in the
library, flagged not-yet-published** — reusing the entire existing read/edit/save/delete surface:

- `SkillsStore.propose(input)` writes `<home>/skills/<name>/SKILL.md` **plus a `.aos-proposed` marker**
  (sibling to `.aos-managed`) and stamps `x-aos-origin: auto` + source provenance into the frontmatter.
- `materialize()` **skips any folder carrying `.aos-proposed`** — so a proposed skill is invisible to
  agents until published. (One-line filter alongside the existing managed/hand-authored logic.)
- `list()` / `read()` surface `proposed: boolean` so the console can separate them.
- **Publish** = `SkillsStore.publish(name)` removes the marker → the skill materialises to agents on
  their next session. **Dismiss** = the existing `remove(name)`.

This beats a settings-blob "recommendation card" (the Dreaming pattern) because a `SKILL.md` is a
first-class file that wants the real editor, not a one-shot Apply button. *(Alternative if we want the
proposal to sit next to config recommendations on the **Insights** page: a `skill_proposals` settings
blob holding `{name, description, body, source, createdAt}`, Apply = `create()`. Rejected as the default
— it duplicates the skill editor and can't hold supporting files. Kept as a fallback.)*

To keep staging simple, **auto-generated proposals are a single `SKILL.md`** (no supporting
scripts/templates) — the store's `installFiles` path stays reserved for the remote installer.

## Governance

- **Proposals never materialise.** The `.aos-proposed` gate is the whole safety story: unreviewed skills
  can't reach an agent.
- **Publish is owner/admin.** Skill mutations are already owner/admin in `server.ts`; publish/dismiss
  join them. Proposing (by an agent) is a session-secret loopback call *before* the member gate, like
  every other agent tool.
- **Audit:** `skill.proposed` (principal = the proposing agent + source session), `skill.published` /
  `skill.proposal.dismissed` (principal = the human). Reuses the audit sink + the Audit page.
- **Anti-flood:** cap open proposals (e.g. ≤ 25/tenant); dedupe by name; the gardener must `list` existing
  skills first and prefer *refining* an existing one over a near-duplicate (same discipline its CLAUDE.md
  already enforces for `recall`/`kb_search`).
- **Opt-in auto-publish (phase 2, default OFF).** Mirror `consolidate_auto`: a `skills_autopublish`
  setting that publishes *gardener* proposals without review, for teams that trust the loop. Ships off.

## Surfaces to build

**Store (`src/governance/skills.ts`)**
- `propose(input): SkillDetail` — create folder + `.aos-proposed` + origin frontmatter.
- `publish(name): boolean` — delete the marker (idempotent; false if unknown/not-proposed).
- `proposed` flag on `SkillSummary`/`SkillDetail`; `materialize()` excludes proposed folders.
- `remove()` already covers dismiss (drops the folder + assignment rows).

**Agent tool (`src/memory/memory-mcp.ts` + `src/server.ts`)**
- `skill_propose { name, description, body, rationale? }` → loopback `POST /api/skill/propose`
  (session-secret gated, pre-auth), → `SkillsStore.propose` + `skill.proposed` audit. Always-on tool.
- Operating notes (`AGENT_OS_OPERATING_NOTES` in `terminal.ts`): add the procedure encoding trigger.
- **Schema change ⇒ rebuild + relaunch sessions; handler ⇒ rebuild + restart server** (per CLAUDE.md).

**Gardener (`src/edge/consolidation.ts`)**
- Extend `CLAUDE_MD` method: add "repeatable procedure → `skill_propose` (check existing skills first;
  refine over duplicate)"; expose `skill_propose` to the consolidator session. No new run — same batch.

**Server routes (`src/server.ts`)**
- `POST /api/skills/:name/publish` (owner/admin) → `publish` + `skill.published` audit.
- Dismiss reuses `DELETE /api/skills/:name`. Proposals list via the existing `GET /api/skills` (now
  carrying `proposed`), or a dedicated `GET /api/skills/proposed`.

**Console (`web/src`)**
- Skills page: a **"Proposed by self-learning"** section — each card → **Review** (opens the existing
  editor prefilled, editable) → **Publish** or **Dismiss**; an `auto` badge + source-session link.
- **Insights** page: a small **"N skills proposed"** count linking to that section (keeps the learning
  loop's outputs — guidance, config recs, *and now skills* — visible in one place).

**Docs / release**
- Fold Lever 6 into `docs/memory-encoding-and-consolidation.md` + this plan; update `docs/PILLARS.md`
  and the self-learning row; `CHANGELOG.md` under Unreleased; minor version bump on the feature PR.

## Phasing

- **Phase 1 (MVP):** `skill_propose` (fleet + gardener) → draft-in-library staging → Skills-page
  Review/Publish/Dismiss → audit. Human-gated only. This alone closes the Hermes gap.
- **Phase 2:** opt-in `skills_autopublish` for gardener proposals; usage-based **retirement** proposals
  (skills carry an invocation/materialise counter, like memory `recall_count`; the gardener proposes
  retiring never-used auto-skills — the procedural analogue of Lever 5's prune-the-never-recalled);
  auto-suggested per-agent scoping (`skill_assignments`) from which agents' episodes produced it.

## Decisions to confirm before building

1. **Who may propose** — whole fleet (any agent post-task, recommended) vs gardener-only. Fleet-wide is
   safe because of the gate and matches Hermes; gardener-only is narrower/quieter.
2. **Staging** — draft-in-library via `.aos-proposed` (recommended, reuses the editor) vs a settings-blob
   card on the **Insights** page.
3. **Auto-publish** — gated-only for v1 (recommended) vs ship the opt-in `skills_autopublish` now.

Defaults in this spec: **fleet-wide propose · draft-in-library · gated-only v1.**
