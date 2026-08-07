# SOPs — pre-learned department playbooks with enforced stages

> **Status: PROPOSED.** Adds the missing *how good work gets done* layer above Tasks. Ships an
> opinionated bundled set (engineering, marketing, sales, support, research) so a fresh tenant produces
> quality output on day one, without anyone authoring a process first.
>
> **Hard prerequisite:** stage sequencing is built on the task dependency edge in
> `docs/task-dependencies-plan.md` (`tasks.blocked_by`), which is **not yet shipped**. That plan lands
> first; this one is its first real consumer.

## 0. The gap

The fleet has **procedural memory** (`src/governance/skills.ts` — a `SKILL.md` library materialised into
every agent at launch, and since Lever 6 the fleet writes its own via `skill_propose`). It has **durable
work** (`src/state/tasks.ts` — a `todo → doing → blocked → done | cancelled` machine). It has **strategy**
(`src/state/goals.ts`). It does not have the thing between them: a *sequence with quality gates*.

A skill and an SOP are different shapes:

| | Skill | SOP |
|---|---|---|
| cardinality | one agent, one invocation | many agents, many sessions |
| state | none (a prompt fragment) | long-lived (which stage, what's produced) |
| enforcement | none — advice the model may ignore | order + ownership + evidence, server-side |
| analogy | a function | a state machine |

So "scope it, implement it, verify it, release it" can only exist today as **prose in a CLAUDE.md or a
skill body**. An agent that skips the verify step produces no signal at all — the task closes `done`, the
audit log records a clean run, and the quality loss is invisible. That silent skip is the whole problem
this plan targets.

## 1. The ladder (and why the word is not "workflow")

```
Goal        why the work matters      strategic, human-owned      src/state/goals.ts
  SOP       HOW good work is done     the stage sequence + bar    ← this plan
  Task      WHAT the work is          durable unit of work        src/state/tasks.ts
  Session   the governed run          ephemeral                   src/terminal.ts
  Automation  WHEN it fires           trigger                     src/edge/automations.ts
```

**"Workflow" is rejected as the noun.** The codebase already fixed its vocabulary — *Automation* is the
user-facing object, *Trigger* the firing condition, *Orchestrator* the internal run engine
(`docs/connectors-and-triggers.md`). "Workflow" reads as a synonym for Automation to every user who meets
both, and we would spend the product's life explaining the difference. "Playbook" is also taken — the
skills surface calls itself that throughout. **SOP** is unclaimed, and it is what a department head
already calls this thing.

## 2. The central design constraint — deterministic scaffold, non-deterministic judgment

The instinct to keep the file human-maintainable and the instinct to make it enforceable pull apart. They
are reconciled by splitting *what is checked* from *what is judged*:

- **The server enforces structure.** Four facts, and only four:
  1. **order** — stage N+1 cannot dispatch until stage N is `done`
  2. **ownership** — a `peer` stage's assignee must differ from the previous stage's closer
  3. **evidence** — closing a stage requires a pointer to a produced artifact, and that pointer must
     *resolve* to something that exists
  4. **signoff class** — `auto` (the agent closes it) vs `human` (an owner/admin closes it)
- **The model judges quality.** Everything under a stage's `**Done when:**` line is prose. The server
  never parses it, never scores it. The model decides *whether* the bar was met; the server only requires
  *that* a judgment was recorded with a resolvable artifact behind it.

This is the lesson `verbosity` already taught (`src/edge/verbosity.ts`): a prompt instruction with no
enforced counterpart is unfalsifiable and rots. It is also the lesson from the opposite direction — a
fully declarative process engine becomes a programming language nobody in marketing can edit.

**Corollary, locked: an SOP is a LINEAR stage list.** No conditionals, no loops, no branching in the file.
The moment `if` is expressible, the format is a DSL and the target user (a content lead, a sales lead)
stops maintaining it. Branching stays the model's job — it may skip an `optional: true` stage, or file a
sub-task.

---

## Decisions (locked for v1)

1. **Format is `SOP.md` — frontmatter + prose, not YAML.** Same shape as `SKILL.md`, same library
   mechanics (`<home>/sops/<name>/SOP.md`), so the existing editor pattern, the `.aos-managed` /
   `.aos-proposed` marker convention, and `skill_propose`'s human-gated staging all transfer. The
   frontmatter is ~6 lines; the body is the part a human writes and reads.
2. **No new run engine. A stage is a child task.** Starting an SOP creates a parent task plus one child
   per stage, chained with `blockedBy` (`docs/task-dependencies-plan.md`). The existing dispatcher, tick
   sweep, pile-up guard, `TASK_MAX_ATTEMPTS` ceiling, run-as passthrough, gateway and audit all apply
   unchanged. If this plan ever needs an interpreter, the design went wrong.
3. **Enforcement lives in one place — `TaskStore.update()`.** A stage task carries `sop` + `sop_stage`;
   closing it runs the gate check. Refused closes return `{ ok:false, error }` like any other invalid
   update — the agent gets a typed refusal, not a scolding in prose.
4. **Evidence is a resolvable pointer, not a description.** `task_update({ status:'done', evidence })`
   where `evidence` names a kb slug, artifact id, attachment, or URL. The server resolves it; an
   unresolvable pointer fails the close. The model cannot satisfy the gate by asserting it did the work.
5. **Adoption is a ramp: `mode: advisory | enforced`, default `advisory`.** An advisory SOP injects its
   prose and records stage progress but blocks nothing. Skip rate is measured from day one. Gates get
   turned on where the data shows the skipped stage mattered. This makes the deterministic half
   opt-in *and* makes it earn itself.
6. **No new trust surface.** An SOP packages *how* an agent works, never *what it may do* — the same
   framing skills already carry. Every effect inside every stage still passes the PreToolUse gate. SOP
   edits are auto-apply + audit (safety net = the file's revision chain), matching KB and Tasks, not the
   approval gateway.

---

## 3. The file format

```markdown
---
name: engineering-feature
department: engineering
mode: advisory                       # advisory | enforced
stages: [scope, implement, verify, release]
gates:
  scope:     { produces: kb,       signoff: auto }
  implement: { produces: artifact, signoff: auto }
  verify:    { produces: report,   signoff: auto, by: peer }
  release:   { produces: artifact, signoff: human }
---

## Scope
Write the problem before the solution. Name the non-goals — they cut more scope than the goals add.
Acceptance criteria a stranger could check without asking you what you meant.

**Done when:** a spec page exists in the KB with testable acceptance criteria and stated non-goals.

## Implement
The smallest change that satisfies the criteria. No drive-by refactors — file them as separate tasks.

**Done when:** a branch is pushed, typecheck and build are clean.

## Verify
Trace every acceptance criterion to a specific check. A criterion with no check is a fail, not a note.
You did not write this code; do not assume the author's reading of the criteria.

**Done when:** each criterion is mapped to pass/fail with the evidence that decided it.

## Release
**Done when:** CHANGELOG line added, version bumped, and the change is live where it was promised.
```

**Frontmatter vocabulary (the whole of it):**

- `stages` — ordered ids. The only sequencing primitive.
- `gates.<stage>.produces` — `kb` | `artifact` | `report` | `note`. Determines what a resolvable
  `evidence` pointer must resolve *to*.
- `gates.<stage>.signoff` — `auto` (assignee closes) | `human` (owner/admin closes; the stage task parks
  and an Inbox card goes to `sessionOwner`).
- `gates.<stage>.by` — `peer` (assignee must differ from the previous stage's closer) | omitted (any).
- `gates.<stage>.optional: true` — the stage may be skipped with a recorded reason.

Anything not in that list is prose. That ceiling is deliberate and should be defended in review — every
key added to this table is a key a marketing lead has to learn.

## 4. The quality lever is the peer stage, not the sequence

Most of the value is not the linear steps — teams mostly know their steps. It is the **mandated
adversarial stage with a rubric, worked by a different agent than the producer**. Engineering has this
by accident (tests, review). Marketing and sales have nothing equivalent, which is exactly why their
agent output reads plausible and lands flat.

So every bundled SOP carries a `by: peer` verify stage. Self-review is impossible by construction, not by
instruction.

**Peer resolution.** At dispatch, a `by: peer` stage assigns to an agent that is (a) not the previous
stage's closer, and (b) capable of the department. Order of preference: an explicit `assignee` on the
stage, then another agent in the same department by `AgentManifest`, then — if the tenant has exactly one
capable agent — the stage **escalates to `signoff: human`** rather than silently self-reviewing. A
one-agent tenant gets a human reviewer or an honest gap; it never gets fake peer review.

## 5. Data model

### 5.1 Library on disk — `src/governance/sops.ts` (new, mirrors `SkillsStore`)

`<home>/sops/<name>/SOP.md`, bundled defaults in `config/sops/` (same software-vs-data split as
`config/agents` + `config/policy`; a tenant edit forks the bundled copy into its home, bundled stays
pristine). `.aos-managed` and `.aos-proposed` markers carry over verbatim from `SkillsStore`, so the
gated-proposal flow of `docs/procedural-skills-plan.md` applies to SOPs with no new governance concept.

Unlike skills, an SOP is **not** materialised into `.claude/skills/` — it is not a thing claude
auto-selects. It is read by the OS when a task starts, and its stage prose is injected into that stage's
task prompt (`buildTaskPrompt`).

### 5.2 SQLite — `src/state/db.ts`

Two `addColumn()` calls on `tasks` (existing rows default to no SOP, so nothing changes for anyone):

```ts
// The SOP this task runs under. On a parent task: the SOP being executed. On a child: the SOP whose
// stage this task IS. NULL for ordinary tasks — the overwhelming majority.
addColumn(db, 'tasks', 'sop', 'TEXT');
// Which stage id of that SOP this child task is. NULL on the parent.
addColumn(db, 'tasks', 'sop_stage', 'TEXT');
```

Evidence is **not** a new column — it lands as a `task_events` row (`kind:'evidence'`, body = the
pointer), so the append-only timeline stays the record and the reverse query ("what did stage N
produce?") is the existing event read. No new table.

### 5.3 Types — `src/types.ts`

```ts
export interface Task {
  // … existing …
  sop?: string;        // SOP name this task runs under
  sopStage?: string;   // stage id (children only)
}

export type SopProduces = 'kb' | 'artifact' | 'report' | 'note';
export type SopSignoff  = 'auto' | 'human';

export interface SopStageGate {
  produces?: SopProduces;
  signoff: SopSignoff;
  by?: 'peer';
  optional?: boolean;
}

export interface Sop {
  name: string;
  department: string;
  mode: 'advisory' | 'enforced';
  stages: string[];
  gates: Record<string, SopStageGate>;
  /** Per-stage prose, keyed by stage id — the `## <stage>` sections of the body. */
  sections: Record<string, string>;
  proposed: boolean;
}
```

## 6. Starting an SOP — the task graph

`TaskStore.startSop(name, input)` (or `task_create({ sop })`) expands to:

```
parent  "Ship dark mode"                    sop=engineering-feature, no stage
  ├─ "scope · Ship dark mode"               sop_stage=scope,     blockedBy=[]
  ├─ "implement · Ship dark mode"           sop_stage=implement, blockedBy=[scope]
  ├─ "verify · Ship dark mode"              sop_stage=verify,    blockedBy=[implement], by:peer
  └─ "release · Ship dark mode"             sop_stage=release,   blockedBy=[verify], signoff:human
```

Every child carries the parent's `owner` (run-as passthrough — the accountable human survives the whole
chain), the parent's `goalId` if set, and `autoDispatch` inherited from the parent. Sequencing is then
**entirely** the existing dependency gate: the tick sweep dispatches `scope`, and each completion makes
the next child eligible on the following sweep. No completion hook, no scheduler change, no new engine —
this is the payoff of Decision 2.

The parent closes when its last child closes (a small check in `update()`'s completion path, reusing the
existing child scan).

`buildTaskPrompt()` (`src/edge/automations.ts`) gains one branch: when `t.sopStage` is set, prepend the
SOP's stage section — the prose, the `**Done when:**` line, and, on an enforced SOP, an explicit note that
closing requires an `evidence` pointer of the declared kind.

## 7. The gate — `TaskStore.update()`

One function, called on any transition to `done`:

```ts
/** Why a stage close was refused, or null if it may proceed. `advisory` SOPs always return null but
 *  still record the violation as a `task_events` row, so skip rate is measurable before enforcement. */
private sopGate(t: Task, input: TaskUpdateInput, sop: Sop): string | null {
  const gate = sop.gates[t.sopStage!];
  if (!gate) return null;
  // 1. order — a prior stage still open. (Belt to the dependency gate's braces: the dependency edge
  //    stops DISPATCH, this stops a human or agent closing out of order from the board.)
  // 2. evidence — `gate.produces` set ⇒ input.evidence must be present AND resolve.
  // 3. signoff — `human` ⇒ the actor must be a member who canApprove-level, not `agent:*`.
  // 4. peer — `by:'peer'` ⇒ this task's closer ≠ the previous stage's closer.
}
```

Resolution of an evidence pointer, per `produces`:

| `produces` | pointer shape | resolved against |
|---|---|---|
| `kb` | `kb:<section>/<slug>` | `KbStore.read()` — page must exist |
| `artifact` | `artifact:<id>` or a URL | `artifacts` table, or a syntactically valid absolute URL |
| `report` | `report:<messageId>` | `messages` row from the stage's session |
| `note` | free text ≥ N chars | length only — the weak gate, for stages with no durable output |

`note` exists so a stage that genuinely produces nothing durable isn't forced to fake an artifact. It is
deliberately the weakest rung; a bundled SOP should use it rarely, and a review should push back when a
new one does.

**Advisory mode records, never refuses.** Same code path, verdict written to `task_events`
(`kind:'sop'`, body = the refusal that *would* have fired), status change allowed. That is what makes the
ramp in Decision 5 honest — the numbers exist before anyone flips the switch.

## 8. Falsifier — what makes this measurable

Ships with its own metrics or it is theater (the `verbositySavings()` precedent):

- **Stage-skip attempts** — advisory-mode `sop` events, per SOP, per stage. The primary adoption signal:
  a stage nobody skips does not need a gate; a stage everyone skips is either the wrong stage or the one
  that matters most.
- **Verify rejection rate** — share of `verify` stages that sent work back. **If it is ~0, the rubric is
  theater** and the SOP should be flagged in the console, not celebrated.
- **Rework rate** — a stage re-entered after being closed.
- **Per-stage duration + attempts** — surfaces the stage that is actually expensive versus the one people
  assumed was.

Surface on the SOP detail page and as one line on **Insights**. A tenant should be able to answer "is
this SOP helping?" without reading the audit log.

## 9. Bundled set — ship 6, opinionated

In `config/sops/`. Each is one screen. **Draft each from real fleet sessions in that department, not from
first principles** — a marketing SOP written by an engineer reads like an engineering SOP and will be
ignored by the people it is for.

| SOP | stages | peer stage |
|---|---|---|
| `engineering-feature` | scope · implement · verify · release | verify |
| `engineering-incident` | triage · contain · fix · postmortem | postmortem (`kb`, so the lesson outlives the incident) |
| `content-strategy` | thesis · outline · draft · edit · publish · track | edit |
| `sales-lead` | qualify · research · outreach · follow-up | outreach (human signoff before anything is sent) |
| `support-escalation` | reproduce · classify · resolve-or-delegate | classify |
| `research-brief` | question · sources · synthesis · contradiction-check | contradiction-check |

Two notes on the non-engineering ones, since they are the point of the plan:

- **`content-strategy` `track`** is a real stage, not a wish: it closes by scheduling a follow-up via the
  existing `schedule` MCP tool (a `type:'once'` automation), with the scheduled run's id as its evidence.
  "We track our content" becomes a row in the DB instead of a value on a wall.
- **`sales-lead` `outreach`** is `signoff: human` in the bundled default and should stay that way. An
  agent drafting outbound is useful; an agent sending outbound unreviewed is a brand incident with an
  audit trail.

## 10. Agent-facing tools — `src/memory/memory-mcp.ts`

Deliberately small. Most SOP mechanics should be invisible to the agent — it receives stage prose in its
prompt and closes its task.

- **`task_create`** gains `sop?: string` (expand into the stage graph) — the primary entry point.
- **`task_update`** gains `evidence?: string` (the pointer). Description must state that on an enforced
  stage this is required and must resolve.
- **`sop_find`** — list installed SOPs + their stages, so an agent can pick the right one for work it is
  filing. Mirrors `skill_find`.
- **`sop_propose`** — draft or amend an SOP from repeat friction, landing as a `.aos-proposed` draft plus
  an `sop.proposed` inbox card. Byte-for-byte the `skill_propose` pattern; an owner publishes. This is
  how a bundled default becomes *this tenant's* SOP without anyone opening an editor.

No `sop_advance` / `sop_skip` tool: advancing is closing the stage task, and skipping an `optional` stage
is `task_update({ status:'cancelled', note })`. Adding stage-machine verbs would leak the state machine
into the agent's head, which is the thing this design is trying to avoid.

> **Rebuild rule (CLAUDE.md).** Changed tool **schemas** need `npm run build` + **session relaunch**;
> changed `/api/*` **handlers** need the **server restart**. Until the server restarts a new loopback
> route 404s-then-falls-through to the member gate → **401 "not authenticated"**, which looks like an
> auth bug and is not. Check: `curl -XPOST localhost:3010/api/sops/propose -d '{"session":"nope"}'` → 404.

## 11. Server routes — `src/server.ts`

- `GET /api/sops` · `GET /api/sops/:name` — list/read (any member).
- `PUT /api/sops/:name` · `DELETE /api/sops/:name` — owner/admin; each write snapshots a revision
  (reuse the `policy_revisions` / `agent_revisions` pattern) so a bad edit is one click back.
- `POST /api/sops/propose` — **loopback, pre-auth, session-secret gated** (agent tool).
- `POST /api/sops/:name/publish` · `POST /api/sops/:name/dismiss` — owner/admin, drops/removes the
  `.aos-proposed` marker.
- `POST /api/tasks` and the loopback `POST /api/tasks/create` accept `sop`; `POST /api/tasks/update` and
  its loopback accept `evidence`.
- `GET /api/sops/:name/metrics` — §8 numbers.

Audit: `sop.started`, `sop.stage.closed`, `sop.stage.refused`, `sop.stage.skipped`, `sop.proposed`,
`sop.published`, `sop.edited`, `sop.reverted`.

## 12. Console — `web/src`

The editor is the thing that decides whether anyone maintains these, so it is not a raw text box:

- **SOPs page** (under Agents, near Skills): cards per department, `advisory`/`enforced` pill, live
  metrics strip.
- **Editor**: stage list is **drag-to-reorder rows**, each with two dropdowns (`produces`, `signoff`) and
  a `peer` checkbox. The prose is a plain textarea per stage. **Frontmatter is never shown** — it is
  generated. A "view raw" toggle exposes the `SOP.md` for the people who prefer it, matching the policy
  page's raw-JSON escape hatch.
- **Proposed section** — same Review / Publish / Dismiss as the Skills page.
- **Tasks board**: a task with a `sop` shows a **stage rail** (`scope › implement › verify › release`,
  current stage lit, closed stages ticked). This is where the feature becomes obvious to a human — one
  glance says which stage the work is parked in.

## 13. Build order

0. **`docs/task-dependencies-plan.md` ships first** (`tasks.blocked_by` + the dispatcher honouring it).
   Without it, §6 has no sequencing primitive and this plan would grow one — the exact duplication
   Decision 2 exists to prevent.
1. `src/governance/sops.ts` — parse/list/read/write + markers, modelled on `SkillsStore`. Bundled
   `config/sops/` with the six drafts.
2. `src/types.ts` + `db.ts` columns.
3. `TaskStore.startSop()` (graph expansion) + `sopGate()` in `update()` + evidence events.
4. `buildTaskPrompt()` stage-prose injection.
5. Peer resolution at dispatch (`src/edge/automations.ts`).
6. Server routes + audit.
7. MCP: `task_create.sop`, `task_update.evidence`, `sop_find`, `sop_propose`.
8. Console: SOPs page, editor, stage rail.
9. Metrics + the Insights line.
10. Docs: `docs/PILLARS.md` row, `docs/agent-mcp-tools.md` entries, `CHANGELOG.md`, minor version bump.

**Validation (no test runner — the house method).** `npm run typecheck`, `cd web && npm run build`,
`npm run demo`, `npm run test:governance`, then an **isolated** in-process script (`export
AGENT_OS_HOME=<scratch>` first — a bare `loadAgentOS()` writes into the LIVE `./data`) driving
`createHttpServer` on an ephemeral port:

- **Expansion** — `task_create({ sop:'engineering-feature' })` → assert 1 parent + 4 children, correct
  `blockedBy` chain, owner propagated to every child.
- **Order** — `tick()` once → only `scope` dispatched. Close `scope` → next tick dispatches `implement`.
- **Evidence, enforced** — close `scope` with no `evidence` → refused. With `evidence:'kb:specs/nope'`
  (no such page) → refused. With a real page → accepted.
- **Evidence, advisory** — same close with no evidence → **accepted**, and a `sop` event recorded holding
  the refusal that would have fired.
- **Peer** — `verify` assigned to the same agent that closed `implement` → refused; a different agent →
  accepted. Single-agent tenant → stage escalates to `signoff: human`, not self-review.
- **Human signoff** — `agent:*` closing `release` → refused; an owner → accepted.
- **Parent close** — last child `done` → parent `done`.
- **Guards intact** — `isAlive` pile-up guard and `TASK_MAX_ATTEMPTS` behave unchanged across a 4-stage
  chain.

## 14. Risks

- **Ceremony on trivial work.** A 4-stage SOP on a typo fix is worse than no SOP. Mitigation: SOPs are
  opt-in per task; agents are told (in the tool description) to file ordinary tasks for ordinary work.
  A `sop: none` bypass on an agent whose manifest defaults to one must be **audited, never silent** —
  a bypass nobody can count becomes the default path within a month.
- **Wrong-shape SOPs.** See §9 — draft from real sessions per department.
- **Gate theater.** A `note`-only SOP with `signoff: auto` everywhere enforces nothing while looking
  governed. The §8 metrics are the defense; a verify stage that never rejects should be surfaced as a
  problem in the console.
- **Format creep.** Every frontmatter key added past §3 moves this toward YAML-as-DSL. The linear-only
  rule and the closed key list are the load-bearing constraints of the whole design.

## 15. Futures (not this plan)

- **Branching.** Deliberately excluded. If it is ever genuinely needed, the shape is a *sub-SOP started
  from a stage*, not an `if` in the file.
- **SOP ↔ Goal binding.** A Goal declaring the SOP its tasks must run under, so strategy carries method.
- **Cross-tenant SOP registry.** The skills.sh analogue — shared department SOPs, installed like skills
  (`skill_request`'s remote-repo path already proves the mechanics).
- **Dreaming-proposed amendments.** The gardener already reads friction across episodes; pointing it at
  `sop_propose` closes the loop from *"this stage always gets skipped"* to *"here is the amended SOP."*
  Deliberately deferred until the §8 metrics exist to propose *from*.
- **Rubric files.** A stage referencing a scored rubric (`rubrics/<name>.md`) instead of inline prose,
  once we know which stages actually need one.
