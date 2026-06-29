# Agent OS — The Governance & Policy Model

This is the design north star for the trust layer: *what the governance layer is meant to be*, stated
as principles, with each current gap mapped to the principle it violates. It sits above the
implementation — `src/gateway/gateway.ts`, `src/governance/policy.ts`, `src/governance/approvals.ts`,
and the real enforcement path `terminal/gate-hook.sh` — and exists so that feature work has something
to check itself against. When you change the trust layer, change it *toward* these principles, and
update this doc if a principle itself moves.

The one invariant restated: **every side effect an agent has on the world passes through a single
mediated gateway.** Everything below is what that gateway must actually do to be worth having.

---

## The core reframing

Most of the layer's current problems are one problem wearing different masks: **the decision collapses
four separate questions into a single heuristic.** Today the brain is effectively `classify(action)` —
a capability string mapped to a risk colour by a substring match. Pull the questions apart and the
right architecture falls out of them.

A governance decision is a function of **four inputs**, not one:

```
decide( action, actor, context, target ) → allow | approve(level) | deny
```

- **Action** — the capability *and its real arguments*: the SQL inside `db_query`, the dollar amount,
  the payload — not just a tool name.
- **Actor** — who set this in motion: a human with a role (and whether that role can already approve),
  or an autonomous trigger (cron / Slack / webhook).
- **Context** — attended vs unattended, budget remaining, rate, environment posture, time.
- **Target** — *what* it touches: prod vs staging, the blast radius of the specific resource.

Nearly every policy you will ever want to write is a sentence over those four nouns — *"a member's
unattended agent may not run a destructive verb against prod."* You cannot express that today because
three of the four nouns never reach the decision (`classify(attempt, _ctx)` discards the context
entirely). Wiring the missing nouns in is the central piece of work; the principles below are what that
buys you.

---

## Principle 1 — The master axis is reversibility, not "risk"

Green / yellow / red asks "how scared am I," which nobody can calibrate consistently. Replace it with
the axis that actually determines the correct control: **can this be undone?**

| Reversibility | Examples | Control |
|---|---|---|
| **Reversible** | reads, drafts, staging writes | allow, just record it |
| **Recoverable** | spends money, mutates prod but restorable from backup | approve (human in the loop) |
| **Irreversible** | drop database, delete account, unclawbackable spend | **deny / out-of-band** — never a one-click inbox card |

This single reframing makes the two recurring questions consistent:

- *"Should the owner approve their own agent's action?"* — fine for the **recoverable** tier (it's just
  a confirmation you can grant yourself); forbidden for the **irreversible** tier (a second pair of
  eyes is the whole point, and you can't undo it).
- *"What if an agent mistakenly deletes prod?"* — that lands in the **irreversible** tier, which is
  `deny`, not `approve`. Recovery is a deliberate out-of-band human action, never an inbox click made
  by a tired operator.

You don't need a courage rating. You need to know whether you can take it back.

---

## Principle 2 — Defense in depth: policy is one layer, never the only one

An agent should be able to perform action *X* **only if all of these hold**:

1. it *holds a credential* that can do *X* — **identity / least privilege**
2. policy *permits* *X* in this context — **the rule engine**
3. a human *approved*, if *X* requires it — **approvals**
4. *X* is *recoverable* if 1–3 all failed — **backups / soft-delete / dry-run-first**

Each layer assumes the others may fail. The strongest guarantee that "an agent never deletes prod" is
not a clever rule — it is that **the agent never holds a prod-destructive credential**, with policy as
the backstop and recoverability as the floor. Today only layer 2 exists in practice, and (see
Principle 4) it fails open — so the entire guarantee rests on one shell `case` statement. That is the
structural weakness, not any individual missing rule.

---

## Principle 3 — Split the classifier from the policy

Policy-as-data (the JSON ruleset) is the right call: it keeps `src/core` and the kernel generic and
open-sourceable, and lets an owner edit rules live. Keep it. But *"what is this action, really?"* —
parsing destructive SQL out of `db_query`, telling prod from staging, computing reversibility and
amount — **cannot** live in declarative JSON, and must not live in a bash heuristic. So two components
with a clean seam between them:

- **Enricher** — deterministic, server-side, unit-testable code that turns a raw tool call into
  *facts*: `{ verb: "delete", target: "prod-db", reversible: false, amountUsd: 0, … }`. This is where
  case-insensitivity, SQL/argument inspection, and environment resolution live.
- **Policy** — the declarative ruleset, mapping `facts + actor + context → decision`.

The bash hook's job then shrinks to **dumb, fail-closed transport**: ship the raw call to the server,
obey the verdict. All the brittleness collapses into one tested function instead of being smeared
across substring matches in a shell script.

---

## Principle 4 — One chokepoint, and it fails closed — or the layer is theatre

The value proposition is "every side effect passes through one mediated boundary." That is only true
when:

- **There is exactly one decision brain.** Today there are two — the clean `gateway.ts` (used by the
  mock/demo path) and the real `gate-hook.sh` (used by live claude-code agents) — and they do not share
  a classifier. Two brains means two policies means the guarantee is fiction for whichever path is
  weaker. Unify them onto one decision function.
- **Every path fails closed.** A governance layer with a single fail-open branch provides *zero*
  guarantee, because any accident or adversary simply steers toward that branch. The hook's current
  `*) exit 0 ;;  # fail-open` fallback — which also triggers during the documented stale-server restart
  window when the gate route 404s→401 — must become deny-on-error and deny-on-unknown. Pair it with a
  "gate unreachable → blocked, retrying" UX so a flaky network degrades safely instead of silently
  opening.

Auditability is the other half of trustworthiness: every decision must emit a record of
`(facts, rule matched, decision, actor)` so the gateway is provable after the fact, not just hopeful in
the moment. Audit-at-every-step already exists in `gateway.ts`; the hook path must reach the same bar.

---

## Principle 5 — Humans handle exceptions, not operations

The layer's job is to let the routine flow and route only the genuinely exceptional to a person. If a
human is asked to approve everything, they approve nothing — **alarm fatigue is itself a security
failure**, which is why self-approval spam is a real problem and not merely an annoyance. The tuning
target:

> **Deny the catastrophic. Allow the routine. Ask a human only on genuine ambiguity.**

Two consequences:

- **Context-aware routing.** When the actor is a human who *already* holds approval authority for the
  required level and the run is attended, a recoverable action is theirs to take without a self-
  addressed approval card — but this shortcut is **fenced out of the irreversible tier** (Principle 1).
  The `spawned_by` initiator signal already exists on every session; the decision just has to read it.
- **Learn what's routine.** What counts as "ambiguous" should shrink over time as the system observes
  outcomes. The Dreaming engine (`src/edge/dreaming.ts`) is the natural home for that feedback loop —
  proposing (human-applied) policy refinements rather than silently widening what agents may do.

And keep the layer **legible to the agent**: `policy_check` / dry-run (already in `memory-mcp.ts`) lets
an agent ask "can I?" before it acts, so the gate is a planning aid, not a surprise — which cuts the
blocked-then-retry waste that itself pushes agents toward edge cases.

---

## Where we are vs. the north star

The hard parts already exist: a single conceptual gateway, policy-as-data with a live console editor,
audit-at-every-step, idempotency, and an initiator signal (`term_sessions.spawned_by`). Most gaps were
*"a principle not yet wired,"* not *"a layer that needs inventing"* — and three PRs have now wired them:

| Gap | Principle | Status |
|---|---|---|
| `classify` ignored context | Core reframing | ✅ the decision *pipeline* now uses all four inputs — `enrichArgs` derives action/target facts, `attendedApprover` adds actor/context; `classify` itself stays a pure facts→risk function |
| No `deny` tier — worst case was `approve(owner)` | P1 reversibility | ✅ PR #1 — never-tier deny rules in `default.policy.json`, refused regardless of approver |
| Owner asked to approve their own attended agent | P1 + P5 | ✅ PR #3 — `autoClearsApproval` clears the `ask` tier for an attended owner/admin, fenced out of the never tier |
| Classification by tool *name* — `db_query`/`execute_php` args unseen | P3 classifier split | ✅ PR #2 — `src/governance/enricher.ts` inspects arguments (the SQL inside the call, the amount, the count) |
| Case-sensitive substring matching in the shell | P3 + P4 | ✅ PR #2 — classification moved off bash into the deterministic, case-insensitive enricher |
| Two decision paths (`gateway.ts` vs `gate-hook.sh`) | P4 one chokepoint | ✅ both paths now classify over `enrichArgs` — one brain everywhere, pinned by the conformance suite. (The gateway enriches for the decision only; execution/idempotency/audit keep the original args.) |
| `*) exit 0` fail-open fallback | P4 fail-closed | ✅ PR #1 — retries until the gate answers; never falls through to allow |
| Agents hold the same creds regardless of environment | P2 defense in depth | ⬜ open — least privilege / environment-scoped identity (future) |

The brain is now testable and pinned: **`test/governance/conformance.json`** is a golden table of
`(call → decision)` and `(approval context → auto-clear?)` cases; `node scripts/governance-conformance.cjs`
(`npm run test:governance`) drives the exact functions the live gate uses and fails CI on any drift.
Add a case there before changing the enricher or the default policy.

What remains is genuinely additive: environment-scoped least privilege (P2), hash-chained audit, and
the kill switch — none a rewrite.

---

## The v1 policy framework (decided)

The model above is the *why*; this is the *what we are building*, with the open choices now locked.

**One function, three outcomes, on the reversibility axis:**

```
decide(action, actor, context, target) → allow | ask(level) | never
```

- **allow** — reversible (reads, drafts, staging writes). Runs; just audited.
- **ask(level)** — recoverable (spends money, mutates prod but restorable). Pauses for a human.
- **never** — irreversible. Refused, full stop.

**Two invariants:**
1. **`never` always wins** over any `allow`/`ask` (Cedar's forbid-overrides). Structural — no rule,
   role, or approver overrides it.
2. **`ask` auto-satisfies only when** the actor is a *human who can approve that level* **and** the run
   is *attended*. Never applies to the `never` tier.

**Locked decisions (2026-06-29):**

| Choice | Decision |
|---|---|
| Self-approval | **Auto-approve attended** — owner *or* admin driving an attached session clears their own `ask`-tier actions (audited as auto-approved by them). Unattended/automation runs always pause for a human. |
| Gate failure mode | **Fail-closed** — gate unreachable/error/unknown ⇒ block + retry; never run ungoverned. Replaces the `*) exit 0` fallback. |
| Scope | **One global ruleset** for v1, reshaped to this model. Per-agent / per-environment overlays are a later additive layer. |
| `never` tier | Prod DB destruction · bulk content/site deletion · destructive infra/shell · large/irreversible money. |

**Starter `never`-tier rules** (exact patterns/thresholds to be confirmed; enricher inspects arguments
incl. SQL inside `db_query`/`execute_php`, case-insensitive):

```jsonc
{ "when": { "verb": "db.destroy",   "target.env": "prod" }, "then": "never" },  // DROP/TRUNCATE DATABASE|TABLE, schema delete
{ "when": { "verb": "site.delete" },                        "then": "never" },  // delete a WP/Globex site
{ "when": { "verb": "content.delete", "count": { "gt": 25 } }, "then": "never" }, // mass content/user delete
{ "when": { "verb": "fs.destroy" },                         "then": "never" },  // rm -rf data paths, mkfs, dd
{ "when": { "verb": "infra.destroy" },                      "then": "never" },  // terraform destroy, kubectl delete, force-push main
{ "when": { "verb": "secret.delete", "target.env": "prod" }, "then": "never" },
{ "when": { "verb": "payment", "amountUsd": { "gt": 500 } }, "then": "never" }  // above the cap; at/below → ask(owner)
```

Everything not matched by a `never` or `ask` rule falls through to `allow` for reversible verbs and
`ask(head)` for anything the enricher can't prove safe (a safe default that won't flood the inbox once
the common reversible verbs are explicitly `allow`ed).

---

## Prior art & alignment

This model was checked against the public agent-governance landscape (Microsoft's Agent Governance
Toolkit; the `awesome-ai-governance` index — Cedar, OPA, the OWASP/NIST/CSA standards, the MCP-gateway
projects). The short version: **the model holds**, the convergence is strong enough to be reassuring,
and the external work supplies a few concrete, low-dependency upgrades rather than any rethink.

### Convergence (we are not alone, and not wrong)

Microsoft's **Agent Governance Toolkit (AGT)** independently arrived at the same architecture — to the
point of shipping a subpackage literally named **"Agent OS"** ("kernel-level governance with
POSIX-inspired primitives"), with an `Agent → Policy → Identity → Audit` pipeline that is our 7-step
gateway minus budget/idempotency. Its thesis — make violations *"structurally impossible rather than
relying on probabilistic prompt-level safety"* — restates our one invariant. AWS's **Cedar** evaluates
authorization over **Principal · Action · Resource · Context**, which is exactly our
`f(action, actor, context, target)` (the four-input reframing above), with the same default-deny and a
`forbid`-always-wins rule that *is* our irreversible tier. We re-derived these independently; that they
match is evidence the shape is right.

### Mapping to the OWASP Agentic threat taxonomy

The OWASP Agentic Security Initiative's threat list names several risks this model already targets —
useful both as a checklist and as external vocabulary when explaining the layer:

| OWASP agentic threat | Addressed by |
|---|---|
| **Overwhelming Human-in-the-Loop** (approval fatigue) | Principle 5 — deny the catastrophic, allow the routine, ask only on ambiguity |
| **Tool Misuse** | Principle 3 — argument-aware enricher (sees the SQL inside `db_query`, not just the name) |
| **Privilege Compromise** | Principle 2 — least privilege / environment-scoped identity |
| **Repudiation & Untraceability** | Principle 4 — fail-closed + tamper-evident audit |
| **Identity Spoofing** | the *actor* input — initiator resolved from `term_sessions.spawned_by` |

That approval fatigue is a *named threat in the standard* is the external validation of why "the owner
approving their own agent" is a real problem and not a nicety.

### Borrowed primitives (low-dependency, on the roadmap)

Four things worth taking from the landscape, none of which compromise the zero-dependency, generic core:

1. **A shared conformance suite.** AGT defines its policy by a golden table of `(call → expected
   decision)` tested across implementations. We adopt the *idea*: one fixture both enforcement paths
   (`gateway.ts` and the `gate-hook.sh` server endpoint) must satisfy — the structural fix for the
   "two brains" gap (P4), and cheap in our in-process Node test style.
2. **Hash-chained audit.** Signed Decision Receipts (IETF) / Merkle audit logs / Ed25519 receipts all
   point the same way. We can get tamper-evidence with *zero deps* — each audit event carries the hash
   of the previous one (`crypto`), so the JSONL system-of-record becomes append-only-provable (P4 / the
   Repudiation threat).
3. **Kill switch + denylist.** AGT's runtime has a global stop-all and a hard command denylist. The
   denylist *is* the irreversible tier (P1); the kill switch is an operational control we lack.
4. **`require_approval` as a first-class action + richer conditions.** AGT's YAML treats approval as a
   policy outcome with expressive conditions (`action.type in ['drop','delete','truncate']`). Our JSON
   `when` (single arg, one comparison) should grow toward this. Note Cedar *cannot* express an approval
   workflow (it is pure allow/deny), so the human-in-the-loop tier stays ours regardless of engine.

### Deliberately out of scope (for now)

SPIFFE/DIDs, TEE / confidential compute (cMCP, OPAQUE), on-chain trust scoring, and RL-with-violation
training are real but overkill for a single-box Tailscale deployment. Revisit only if Agent OS goes
multi-org or into a regulated setting. We also keep the JSON policy engine as the zero-dep default
rather than taking Cedar/OPA as a hard dependency — Cedar may later be offered as a *pluggable* advanced
engine (same pattern as the swappable memory backends), but the generic core must run with no external
policy runtime.
