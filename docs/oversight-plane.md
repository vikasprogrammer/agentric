# The Oversight plane — the fleet's leadership layer

> **The question (2026-08-01):** should Agent OS add "God-level agents" — watchers / strategy /
> leadership agents that guide other agents *and* humans toward company success? Is that a new
> primitive, and is it something bigger than Goals?
>
> **The verdict: no new primitive.** The leadership team is already built — ten pieces doing
> exactly that work, scattered across `src/edge/` with no shared spine. What's missing is one
> unifying concept, one genuinely primitive-shaped object (**`Intervention`**, §3.2), one governed
> **scope** (`fleet:read`, §3.1), and — for the "master agents that automatically run and fix
> things" instinct — a **bounded autonomy grant** (**Leadership mode**, §5), whose Tier 1 is mostly
> a scheduler over fix endpoints that already ship. This doc is the consolidation plan.

---

## 1. What already exists (the roster is real)

Every one of these ships today. Read down the right-hand column: this **is** a leadership team.

| Piece | File | Leadership role |
|---|---|---|
| **strategist** | `src/edge/strategist.ts` | Goal → a filed plan of linked tasks. Planning. |
| **analyst** | `src/edge/diagnosis.ts` | *Why* is this agent failing — root-cause a struggling agent's recent failed runs. |
| **improver** | `src/edge/improver.ts` | Drafts a better `CLAUDE.md` for a struggling agent. Coaching. |
| **skill-scout** | `src/edge/skill-scout.ts` | Spots a recurring manual procedure across the fleet → proposes a skill. L&D. |
| **consolidator** | `src/edge/consolidation.ts` | Abstracts episodes + lessons into shared memories / KB pages. Institutional memory. |
| **Dreamer** | `src/edge/dreaming.ts` | Deterministic reflection → guidance injected into every prompt + config recommendations. |
| **Insights / Improvements** | `src/edge/insights.ts`, `improvements.ts` | Per-agent scorecard, friction map, per-domain "what to fix" tiles. The board deck. |
| **Measurement** | `src/edge/measurement.ts` | Success-rate trend + per-intervention before/after with a verdict. "Is it working?" |
| **Reliability monitor** | `src/edge/reliability.ts` | Online failure-pattern detection (no-progress loop) → an advisory `instruct` nudge mid-run. |
| **Digest** | `src/edge/digest.ts` | The daily standup — Needs-you · threads · honest tally. Comms. |

Five of these are already **code-provisioned `System`-category agents** — `consolidator`,
`analyst`, `improver`, `skill-scout`, `strategist` (the `BUILT_IN_AGENTS` set in
`improvements.ts`) — governed headless claude-code sessions through the same gate and audit as any
other agent, spawned on demand. The category exists. It just isn't *presented* as a team.

Adding a "God agent" on top of this would be a **tenth** thing, not the unifying one.

## 2. Why it doesn't feel like a leadership team

Three concrete deficits, each fixable and none requiring a new primitive-in-the-abstract:

1. **No shared concept.** Ten pieces, ten mental models. The owner meets them one button at a time
   (Diagnose · Plan this goal · Reflect now · Improve), never as a standing function.
2. **No shared data scope.** Each meta-agent needs its own edge module to hand-curate a slice of
   the DB into its spawn prompt — which is precisely why there are five near-identical
   provision-and-spawn files. No agent can *ask* how the fleet is doing.
3. **No accountability loop.** `measurement.ts` computes real before/after verdicts, but the only
   thing it recognizes as an intervention is an applied Dreaming recommendation
   (`SELECT … WHERE type = 'recommendation.applied' … LIMIT 10`). Every other change a human
   ratifies is invisible to it. The measurement arm is real and nearly blind.

## 3. The three candidates, assessed

### §3.1 — `fleet:read` — the real enabling gap (**a scope, not a primitive**)

- **Exists:** every agent-facing tool is self-scoped by design and that default is correct.
  `session_history` / `session_open` are gated server-side to the caller's own agent; `agent_update`
  / `agent_history` / `agent_revert` are self-only; memory is `agent | tenant`. The deterministic
  engines (`dreaming`, `insights`, `measurement`, `improvements`) read the whole DB — but they are
  *engine code*, not agents. No agent can reason across the fleet.
- **Delta:** a declared, policy-classified, audited **`fleet:read`** scope that unlocks a small
  read-only tool set over what `GET /api/insights` + `GET /api/agents/stats` already compute —
  cross-agent outcomes, approval/friction rates, goal progress, task aging, budget burn. Declared
  per agent in the manifest (alongside `shellSecrets`), resolved at launch, visible in the console.
- **Touch-points:** `AgentAccess` / manifest in `src/types.ts`; the tool set in
  `src/memory/memory-mcp.ts` + its `/api/*` handlers (server-side scope check, never a client
  claim); `docs/access-model.md` (this is a new rung on `Creds → Connections → Capabilities`);
  `docs/agent-mcp-tools.md` (the tool↔route↔store matrix).
- **Done when:** a `System` agent gets its fleet context from **tools**, not from a bespoke edge
  module baking a prompt — and the five provision-and-spawn files collapse toward one shape.
- **This is on-thesis, not a detour.** An agent that can read every session transcript is a
  privilege escalation and an exfiltration vector. Making that a *visible, classified, audited
  scope* rather than ambient god-mode is exactly the product's job. **Never** an implicit grant.

### §3.2 — `Intervention` — the one primitive-shaped hole

- **Exists:** `measurement.ts` already has the machinery — `InterventionEffect { id, title, at,
  before, after, deltaPp, verdict }` with `verdict ∈ improved | declined | flat | insufficient`,
  a 14-day before/after window, `MIN_N = 8` below which it withholds a verdict, and `THRESH_PP = 5`.
  It is honest about being correlational, not a controlled A/B. All of that is good and stays.
- **Delta:** promote "intervention" from *"an applied Dreaming recommendation"* to a **first-class
  durable record of any human-ratified change to how the fleet operates**, and let the same
  before/after scorer read all of them:

  | Ratified change | Today's audit event | Counts as an intervention? |
  |---|---|---|
  | Applied recommendation | `recommendation.applied` | ✅ yes (the only one) |
  | Published a proposed skill | skill publish | ❌ |
  | Applied an improver prompt rewrite | agent revision | ❌ |
  | Approved a policy proposal / "Always approve" | `policy.rule.added` | ❌ |
  | Retired an idle agent | — | ❌ |
  | Changed workspace runtime defaults | `runtimeDefaults` set | partial |

  Each carries `{ what changed, expected effect, scope (fleet | agent | capability), window }` and
  earns a verdict on the same rails. Scope-aware: an agent-level rewrite is measured against **that
  agent's** sessions, not the fleet average — the current fleet-wide comparison would drown it.
- **Touch-points:** `src/edge/measurement.ts` (source the list from an intervention record, not one
  audit type; drop the `LIMIT 10`); a small store or an audit convention for the record; the
  Insights page renders verdicts per intervention.
- **Done when:** an owner can ask *"of the last 20 changes we made to this fleet, which ones
  actually helped?"* and get an honest answer, including "not enough data to say."
- **Why this is the one worth building:** it's the difference between a leadership team and a
  motivational poster. It also passes the plan's own design test (`docs/agent-os-plan.md`) on
  **explainable** and **easier to operate**, where "an agent that advises" fails it outright.

### §3.3 — "something bigger than Goals" — there is no object there

The instinct is right; the shape isn't an object. What sits above a goal in a company is an
**arbitration function** — priority between competing goals, where budget goes, what to stop doing.
In this system that function's *output* is a decision, and decisions already have homes: Approvals,
the propose-family, and the recommendation rail. The unstructured version already exists as Company
context + `learned_guidance`.

If structure above Goals is wanted, the cheapest honest move is **goal priority + an explicit
trade-off note on the Goal object** — not a new plane. Do not build a "Mission"/"Strategy" plane on
top of `goals-plan.md` until goals themselves are being actively contested in practice.

## 4. Non-negotiables

These are guardrails on anything built here, not preferences.

1. **Propose-don't-apply is the default, and the only thing that may override it is the §5 tier
   test.** The pattern is already eight tools deep — `goal_propose`, `policy_propose`,
   `agent_propose_update`, `skill_propose`, `automation_propose`, `host_propose`,
   `connection_request`, `secret_request`. An oversight agent gets **read** breadth and **propose**
   authority by default; it earns auto-apply only for a *named, reversible, effect-inert* action on
   the Tier 1/2 list (§5), never as a blanket privilege and never for anything in Tier 3.
2. **No oversight agent writes the guidance-injection channel.** `deriveGuidance` →
   `buildCompanyMd` → *every agent's system prompt* is the highest-blast-radius surface in the
   product, and it has already shipped garbage twice (v0.280.0: the topic line reading "handed,
   really, read-only"; and a `policy.review` recommendation that was backwards on a tenant with
   ~100% approvals). The lesson recorded there — **a signal riding in every prompt needs a
   denominator and a shape test** — is one an LLM watcher cannot satisfy by construction. That
   channel stays deterministic.
3. **`fleet:read` is a declared privilege**, classified by policy and audited, never ambient.
4. **An LLM is never the final authority on a deterministic decision** (`docs/agent-os-plan.md`
   §3). "Guides other agents and humans" is authority-shaped language; the implementation must not
   be.
5. **Surface naming is settled: this lives on Insights.** Don't mint a new nav page, and don't call
   it "the Operator" — `operator` is already a `System` agent (Cockpit's action tier, alongside
   `concierge` in `src/edge/concierge.ts`). *Oversight plane* is the internal/engine name; the
   console word stays **Insights**.

## 5. Leadership mode — bounded autonomy

> *"Master agents with more access that automatically run and fix things."*

The instinct is right and most of it is already built. Leadership mode decomposes into three parts,
and **two of them ship today**:

| Part | Status |
|---|---|
| **Detect** — what is wrong, stale, or underperforming | ✅ `insights.ts`, `improvements.ts`, `measurement.ts`, `reliability.ts` |
| **Act** — a governed agent that can fix it | ✅ the `System` agents (`analyst`, `improver`, `skill-scout`, `strategist`, `consolidator`) |
| **Permission to act unasked** | ❌ the only real gap |

So the missing piece is **not access**. It is an **autonomy grant**.

### 5.1 The reframe: bound by blast radius, not by trust level

"More access" is the wrong axis — it is vague, unauditable, and it converts one bad LLM turn into
an incident. The grant is instead a **named list of pre-approved actions**, and the test for
membership is mechanical:

> **An action may auto-apply only if it is (a) reversible *and* (b) effect-inert — undoing it
> actually undoes it.**

Both halves are load-bearing, and (b) is the one that is easy to miss. Applying an improver proposal
is *technically* reversible — `os.agentRevisions.commit` snapshots it and it rolls back. But the
rewritten prompt changes what that agent does on every run until someone notices, and reverting the
file does **not** undo those runs. **Reversibility of the artifact is not reversibility of its
effects.** Archiving a dead KB page has no downstream behaviour; rewriting a system prompt does.

### 5.2 The three tiers

**Tier 1 — janitorial: auto-run.** Reversible *and* effect-inert. These already exist as
human-triggered buttons, and they are already the right shape — each is a **deterministic
plan/apply split** (`GET` previews with no mutation, `POST` applies), each is reversible by
construction (soft-archive, history retained, restore from the UI), each is audited and owner/admin
gated:

| Endpoint | Fix |
|---|---|
| `/api/insights/memory/cleanup` | prune + merge dead memories |
| `/api/insights/kb/tidy` | archive never-read, aged pages |
| `/api/insights/tasks/reconcile` | close finished-but-open tasks (run succeeded, agent never closed it) |
| `/api/insights/library/tidy` | soft-archive orphaned artifacts |
| `/api/insights/sessions/tidy` | soft-archive old settled sessions |

**Putting these five on a schedule *is* Leadership mode v1**, and it is nearly free — the plan
functions already produce the would-do list, so a scheduled run can log exactly what it intends
before doing it.

**Tier 2 — corrective: auto-apply, announced, one-click revert, always writes an `Intervention`.**
Reversible but behaviour-affecting, so it ships only where the change is *provably* in the safe
direction. The canonical case is a **policy tightening**: `applyProposal` already refuses any
loosening by construction plus an exhaustive monotonicity sweep, so auto-applying a tightening is
already proven safe — a proof built for a different reason that pays off exactly here. Tier 2
requires an announcement to the owner and a revert affordance; it never runs silently.

**Tier 3 — structural: propose-only, permanently.** Irreversible, privilege-bearing, or unbounded
in effect: rewriting another agent's prompt (§5.1), creating or retiring agents, **any** policy
loosening, spending money, anything touching secrets, and — per §4.2 — the guidance-injection
channel.

### 5.3 Why `Intervention` (§3.2) becomes load-bearing here

Autonomy without a record is the version that gets switched off in week two: *"the system changed
things while I slept."* With every auto-fix writing an `Intervention`, the same feature reads as
*"the OS made 40 moves this week — here they are, what each was meant to do, and which ones
helped."* **§3.2 is a prerequisite for Tier 2, not a parallel track.** Tier 1 can ship before it;
Tier 2 must not.

### 5.4 Kill switch

One master toggle (Settings, default **off**), plus per-tier and per-action toggles. A tenant that
turns Leadership mode off returns to today's behaviour exactly — every Tier 1/2 action remains
available as the human-triggered button it is now. Nothing here removes a manual path.

## 6. Sequenced build

1. **Name and unify the roster** — present the ten pieces as one standing function on the existing
   Insights page. Zero engine work; pure coherence. This is the change that actually delivers the
   feeling the "God agent" idea was reaching for, and it should ship first precisely because it
   costs nothing to reverse.
2. **Leadership mode Tier 1** (§5.2) — schedule the five existing tidy/cleanup/reconcile endpoints
   behind an off-by-default toggle. The cheapest real autonomy in the product; no new fix logic.
3. **Generalize `Intervention`** (§3.2) — the machinery exists; this makes advice accountable, and
   gates Tier 2.
4. **Leadership mode Tier 2** (§5.2) — starting with auto-applied policy tightenings, announced and
   revertable.
5. **Add `fleet:read`** (§3.1) — unlocks real cross-fleet reasoning and collapses the five bespoke
   provision-and-spawn modules toward one shape.
6. *(Only if 1–5 land and the gap is still felt)* a single **watcher** `System` agent with
   `fleet:read` + propose-only authority. Note that by this point it is a **manifest and a trigger**
   — every capability it needs already exists. That is the proof it was never a primitive.

## 7. Deliberately not building

- **A God agent with authority over other agents.** Bounded autonomy (§5) is a *named list of
  reversible, effect-inert actions*; it is not authority over other agents, and the distinction is
  the whole point. An agent that can rewrite another agent's prompt or loosen policy on its own
  inverts the product's invariant, whatever the toggle is called.
- **Supervisor/manager-agent framing.** That is the crowded framework narrative (LangGraph
  supervisor, CrewAI hierarchical, AutoGen GroupChat) and walks off the whitespace
  `docs/agent-os-plan.md` identified. Our version is differentiated precisely because it is
  *governed oversight with measured interventions* — nobody ships "the governance layer tells you
  what to change and then proves whether it worked."
- **A new top-level console surface.** See §4.5.
- **An LLM stall-sensor wired into Dreaming.** Already assessed and deferred in `goals-plan.md`
  (Slice 3, Phase 3); nothing here changes that.

## 8. Open decisions

1. **Intervention storage** — a dedicated table + event log (Tasks/KB shape), or an audit-event
   convention plus a view? Leaning table: verdicts need a stable id to attach to and to re-score.
2. **`fleet:read` granularity** — one scope, or split `fleet:stats` (aggregates only) from
   `fleet:transcripts` (session bodies)? Leaning split — reading every transcript is a materially
   larger grant than reading counts, and the split is much easier to give than to retract.
3. **Tier 1 announcement** — does a scheduled janitorial run post anything (a digest line), or stay
   silent? Leaning **one digest line**: silence is what makes autonomy feel uncontrolled, and the
   digest already exists as the daily surface.
4. **Does Tier 1 write an `Intervention`?** Leaning no for v1 — janitorial actions are effect-inert
   by definition, so there is no outcome to score, and scoring noise would dilute the Tier 2
   verdicts that matter. Revisit if a tidy ever correlates with a regression.
5. **Whether step 6 is ever taken.** Deliberately left open; steps 1–5 stand on their own merits and
   may well dissolve the original ask.
