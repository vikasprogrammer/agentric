# Agent OS — Plan

**Category:** Agent Control Plane. **One line:** *The enforcement layer for autonomous AI.*
**Objective:** Make it safe for an organization to let agents take consequential actions.

> This is the canonical strategy + build plan. Part I is the thesis (what we are and the one
> design choice). Part II is the sequenced build roadmap, grounded in what exists in the
> codebase today. Part III is what we deliberately defer and how we measure success.

---

# Part I — Thesis

## 1. What we are

Frameworks answer *"how do I build an agent?"* Agent OS answers *"how do I safely let it
act?"* We are the runtime governance layer — independent of model, framework, language, and
cloud. We do not build agents; we govern the effects they produce.

## 2. The invariant

**No consequential side effect passes without an Agent OS decision** — Identity → Policy →
Risk → (Allow / Approve / Deny) → Budget → Idempotency → Execute → Audit. Everything else
exists to make this real. Today this lives in `src/gateway/gateway.ts` (the 7-step mediated
boundary) enforced via the PreToolUse gate-hook inside sessions we host.

## 3. The honest boundary (the one design choice)

There are two enforcement postures and we name both openly:

- **Governed runtime** — we wrap the process (today's tmux + PreToolUse gate). *Complete*
  coverage, higher integration cost. This is what we have.
- **Transparent proxy** — customer swaps an MCP/model URL. *Trivial* adoption, covers only
  proxied effects.

We lead commercially with the proxy and **make the gap a feature**: every tenant sees a live
**Governance Coverage %** — "78% of effects governed; here are the 22% escaping the boundary."
We never let an availability or adoption shortcut silently turn a protected action into an
ungoverned one (**fail closed**). LLMs may *classify* context; LLMs are **never** the final
authority on a deterministic access decision.

**We speak the doorway, we own the room.** The official MCP spec standardizes the *doorway* —
OAuth 2.1 + PKCE authorization and a server registry (how a client proves identity and finds
servers). It says nothing about the *room behind it*: per-call policy, suspend-for-a-human,
budgets, idempotency, audit. We are spec-compliant on the doorway and proprietary-value in the
room. That division of labor is the whole positioning.

## 4. The wedge (build these, in order)

1. **Mediation Plane** — the product. The policy / suspend-for-human / budget / idempotency /
   audit step that plugs *behind* an existing MCP gateway. We own the room, not the doorway.
   Not another proxy.
2. **Capability Registry** — normalize raw tool names into portable capabilities. The moat.
3. **Policy v2** — deterministic decisions over `{capability, args, resource, principal,
   context}`, with set/cross-arg/stateful/relational checks. Includes the semantic-guard tiers.
4. **Flight Recorder** — immutable, replayable, tamper-evident record per run; every decision
   explained.

Part II details each with its codebase delta.

---

# Landscape & positioning (verified mid-2026)

A GitHub scan (star counts GitHub-API-verified 2026-07-28) of the six adjacent categories, and
what each means for where we build.

**Crowded — do not enter head-on:**

- **LLM gateways** — LiteLLM (55k) owns model-traffic routing; Kong AI Gateway, Portkey (13k).
  These govern *tokens/cost/provider*, not *effects on the world*. Position **downstream** of
  them (the tool/effect layer), never against them.
- **Agent observability / tracing** — Langfuse (32k), Arize Phoenix (11k), OpenLLMetry (7k),
  converging on **OpenTelemetry GenAI** conventions. Raw tracing is commoditized.
- **Authz engines** — OPA (12k), OpenFGA (5.5k), Cerbos (4.5k), Cedar. Mature, framework-neutral
  *decision points*. We **integrate on** these, we do not rebuild generic authz.
- **Guardrails** — Guardrails AI (7k), NeMo Guardrails (7k), Llama Guard / PurpleLlama (4k).
  Prompt/response-layer, framework-coupled; largely orthogonal to tool mediation.
- **Injection / tool-poisoning defense** — consolidating into security incumbents (Snyk bought
  Invariant/mcp-scan; garak → NVIDIA; Prompt Guard → Meta). Our Tier-1 semantic guard is a fine
  feature but **not a moat** — don't over-invest.

**Crowded but immature — a land-grab, no winner (this is where §4.1 lives):**

- **MCP gateways** — IBM ContextForge (4.2k), agentgateway (4.1k, Linux Foundation, CEL policy
  engine), MetaMCP (2.6k), Docker MCP Gateway (1.5k), Microsoft, Lunar/MCPX, Obot, plus
  mcp-firewall and others. **Almost all are routing / aggregation-first with OAuth + allow-deny
  bolted on.** Building a competing gateway means a 4-way fight over commodity routing.

**Thin — real whitespace (our thesis):**

- The **unified mediated-effect boundary**: one step that does classify **+ suspend-for-a-human
  + budget debit + idempotency + tamper-evident audit** over every effect. Nobody ships it as a
  coherent primitive — they each ship one slice.
- **Capability normalization** across surfaces (§4.2). The MCP *Registry* discovers servers; no
  one normalizes `stripe.refund` / `POST /v1/refunds` / SDK call → `payments.refund`.

**Framing consequences (baked into the plan below):**

1. **Play the gateway as a mediation plane, not a proxy** (§4.1) — plug the boundary *behind*
   agentgateway / ContextForge via their policy seams; ride their distribution.
2. **Don't lead with "control plane."** The phrase is marketing-saturated — Galileo Agent
   Control (OSS), the `agentic-control-plane` repo (its tagline is nearly verbatim our product
   promise), GitHub Enterprise AI Controls (GA Feb 2026), Microsoft Azure Agents Control Plane +
   agent-governance-toolkit, NVIDIA. Lead with the **specific enforced primitive**: *suspend any
   agent action for a human, with a budget and a tamper-evident record.* That sentence has no
   OSS owner.
3. **Emit OTel GenAI conventions** from the Flight Recorder (§4.4) rather than a bespoke format;
   keep the defensible angle (audit-as-byproduct-of-enforcement, tamper-evident, explained).
4. **Integrate the authz engines** (§4.3) — we differentiate on the stateful/relational semantic
   guard + monotonicity proof + propose-don't-apply, not on generic Rego/ReBAC.

---

# Part II — Build roadmap

Each item: **Exists today → Delta to build → Touch-points → Done when.**

## §4.1 — Mediation Plane, behind existing gateways  *(the wedge; build first)*

**Decision (2026-07-28): we do not build a competing MCP gateway.** The gateway layer is a
routing-first land-grab (§ Landscape). We ship the *mediation* — the room behind the doorway —
as a standalone plane that plugs into whoever wins the routing fight. We own the room; they own
the doorway.

**Spike verdict (2026-07-31): the bet is viable, with one constraint — no native indefinite
hold.** Both candidate gateways have the two ingredients we need — a real per-tool-call external
decision hook, and a structured reject that reaches the agent as a JSON-RPC error — but neither
can *park a call open* for a minutes-long human approval. Both are synchronous callouts on a
bounded timeout (agentgateway: ~10s hardcoded default, force-decided by fail-open/closed;
ContextForge: async, configurable, default 30s). So **suspend-for-a-human is implemented as a
protocol, not a blocking wait** (see Delta). Two unknowns still need a hands-on test: whether an
agentgateway backend-timeout override reaches the guardrails gRPC channel, and the agent's own
client-side MCP request timeout — the true outer bound on any synchronous hold, whichever gateway.

- **Exists:** the 7-step boundary (`src/gateway/gateway.ts`) + `policy.ts` classification +
  approvals + audit already mediate every effect **inside sessions we host** (via the PreToolUse
  gate-hook). `src/memory/memory-mcp.ts` is a stdio MCP server injected into *our* sessions.
  What's missing: any way to mediate effects flowing through a customer's **own** external MCP
  gateway — the boundary is trapped inside our runtime.
- **Delta:** expose the mediation as a **callable policy hook** the gateway invokes per tool call:
  classify → suspend-for-a-human → budget debit → idempotency → tamper-evident audit, plus
  **tool-drift / poisoning quarantine** (fingerprint schema + server identity; a changed version
  parks until an owner approves). Because there's no native hold, **suspend uses a
  deny-with-"pending" → retry protocol**: on first call we open the approval and reject with a
  structured, machine-readable `{status:"pending_approval", approval_id, retry_after}`; the agent
  (or a thin client shim) re-issues the same call, keyed by `approval_id` for idempotency, and we
  return `allow` once a human approves or a terminal `deny`. A sub-timeout approval can resolve as
  a synchronous hold on the same path. We speak the MCP Authorization doorway (OAuth 2.1 / PKCE) so
  we compose with their authn, and we **do not** rebuild transport, routing, or discovery.
- **Touch-points:** new `src/mediation/*` — the decision exposed as an out-of-process hook + thin
  per-gateway adapters. **First adapter: IBM ContextForge** (`tool_pre_invoke(payload, ctx) →
  ToolPreInvokeResult{continue_processing, violation, modified_payload}`) — Python, async,
  configurable timeout, and a return shape nearly identical to our existing PreToolUse gate-hook,
  so classify→approve→budget→audit ports with the least friction; its external-plugin transport
  (MCP/gRPC/UDS) keeps our plane out of their process. **Second: agentgateway** (`ExtMcp` gRPC —
  `CheckRequest`/`CheckResponse`, `Pass`/`Mutated`/`AuthorizationError`) — a cleaner MCP-native
  contract, but Rust + the ~10s deadline; revisit once the timeout-override unknown is settled.
  Reuse `gateway.ts` for the decision, `policy.ts` for classification, the audit sink for the
  record. Our own hosted path already calls the same core — *one core, external front doors added*.
- **Done when:** a tool call flowing through an **unmodified** ContextForge (then agentgateway)
  deployment hits our hook, a `RED` action is suspended for a human via the pending→retry protocol,
  the effect is budget-debited and recorded in a tamper-evident chain, and an upstream tool's
  schema change quarantines the new version — **all with zero change to the customer's agent code.**
- **Strategic risk (own it):** we now depend on those projects' extension points and roadmaps.
  Mitigate by keeping the hook contract gateway-agnostic — a clean `EffectIntent → Decision`
  interface where **`Decision` carries a first-class `pending` outcome** (allow / ask / deny /
  **pending**), not just the three we have today — so a third adapter, or our own thin proxy, is
  additive, never a rewrite.

## §4.2 — Capability Registry  *(the moat)*

- **Exists:** nothing. `policy.ts` classifies **raw** effect/tool names by glob
  (`stripe.refund`, `shell.exec`); the same real action wears a different name per surface
  (`POST /v1/refunds`, `stripe.Refund.create()`, `refundCustomer()`), so policy is not portable.
- **Delta:** a registry that normalizes those to a canonical capability
  (`payments.refund`) carrying `{effects, risk, arg schema, providers}`. **Seed it only from
  the tools the mediation plane actually sees** (via the hooked gateways) — do not attempt a
  universal registry up front; grow it as coverage grows.
- **Touch-points:** new `src/capabilities/*` (registry + provider→capability mapping table);
  `policy.ts` matches on capability id, not raw tool name; the mediation plane resolves each
  intent's capability before classifying.
- **Done when:** one policy rule on `payments.refund` governs a Stripe MCP call, a REST call,
  and an SDK call identically. **Hidden cost (do not skip):** every new provider mapping is
  hand-curated; that curation *is* the moat, not overhead to optimize away.

## §4.3 — Policy v2  *(deterministic decisions over the full context)*

Today `JsonPolicyEngine.classify()` (`src/governance/policy.ts`) is **stateless, first-match
glob** whose only predicate is `when: { arg, op, value }` — **one arg vs. one constant, one
arg at a time.** `classify` takes no store, so it sees only the current attempt's args. Tier-1
semantic guard (prompt-injection / exfiltration screen, commit `53b8eb3`, v0.269.0) already
established the guard-plane seam we reuse below. Three real error classes are inexpressible
today:

| Error | Nature | Needs |
|---|---|---|
| `status = "probably shipped"` (invalid enum) | single-arg, but **set** membership | `status ∈ {paid,shipped,refunded}` |
| payout `payee ≠ buyer` (wrong recipient) | **cross-arg** comparison | compare one arg to another arg |
| second refund on the same order | **stateful** — depends on history | look up prior settled effects |
| payout to a support-rep, not a customer | **relational** — entity-type disjointness | look up an entity's type |

### Tier A — smarter rules on the *current* request (pure engine, still JSON)

Add two things to a rule's `when`; **no state, still JSON, still first-match:**

- **Set membership** — new ops `in` / `nin` with an array `value`.
- **Cross-arg comparison** — an `argRef` so an arg compares to *another arg*, not a constant.

```ts
type Op = 'gt'|'gte'|'lt'|'lte'|'eq'|'ne' | 'in'|'nin';       // + set membership
interface When {
  arg: string;
  op: Op;
  value?: number|string|boolean|Array<string|number>;         // arrays for in/nin
  argRef?: string;                                            // compare to another arg
}
```

```ts
// evalWhen — the only behavioural change
const actual = args[when.arg];
const rhs = when.argRef !== undefined ? args[when.argRef]     // cross-arg
          : resolveValue(when.value, thresholds);             // constant / $threshold
if (when.op === 'in')  return Array.isArray(when.value) && when.value.includes(actual as never);
if (when.op === 'nin') return !Array.isArray(when.value) || !when.value.includes(actual as never);
if (when.op === 'eq')  return actual === rhs;
if (when.op === 'ne')  return actual !== rhs;
// …numeric ops unchanged, comparing actual vs rhs
```

The first two error cases become plain rules:

```jsonc
// invalid enum → hard deny
{ "match": { "capability": "order.setStatus",
             "when": { "arg": "status", "op": "nin", "value": ["paid","shipped","refunded"] }},
  "action": "never" },

// payout must go to the buyer → ask owner when payee ≠ buyer
{ "match": { "capability": "payout.send",
             "when": { "arg": "payee", "op": "ne", "argRef": "buyer" }},
  "action": "ask", "approver": "owner" },
```

**Non-obvious constraint (the real work, not `evalWhen`).** `applyProposal`'s safety proof is
an *exhaustive monotonicity sweep* (`firstLoosening` → `sampleArgDomains`). New ops the sampler
doesn't enumerate silently make that proof unsound. Tier A **must** teach `sampleArgDomains` to
emit each `in`/`nin` enum member and to pair `argRef` args, and extend `validatePolicyDocument`
(array values for `in`/`nin`, string `argRef`) and `OPS`.
**Touch-points:** `Op`, `OPS`, `When`, `evalWhen`, `validatePolicyDocument`, `sampleArgDomains`
(→ `firstLoosening` / `describeProposal`) — all in `src/governance/policy.ts`, no new plane.

### Tier B — rules that read *what already happened* (a stateful guard plane)

Double-refund and disjoint-entity are **irreducibly stateful** — they depend on history and
entity facts the pure engine deliberately can't see. Do this **engine-level, not JSON**
(JSON-only governance no-ops on tenants with a persisted policy override — new guardrails must
live in the engine, folded via `stricterDecision`). Reuse the Tier-1 guard seam.

```ts
interface FactProvider {                    // depends on contracts, not concrete stores
  entityType(kind: string, id: string): Promise<string | undefined>;   // KB / directory
  hasSettled(op: string, key: string): Promise<boolean>;               // audit index
}

interface SemanticGuard {
  evaluate(attempt: ActionAttempt, ctx: RunContext): Promise<Decision | null>; // null = abstain
}

class DomainConstraintGuard implements SemanticGuard {
  constructor(private facts: FactProvider) {}
  async evaluate(a: ActionAttempt): Promise<Decision | null> {
    if (a.capabilityId === 'order.refund' && await this.facts.hasSettled('refund', String(a.args.orderId)))
      return { effect: 'deny', riskClass: 'deny', reason: 'order already refunded (uniqueness guard)' };
    if (a.capabilityId === 'payout.send') {
      const t = await this.facts.entityType('party', String(a.args.payee));
      if (t === 'support_rep')                                   // OWL "disjoint" → engine fact
        return { effect: 'approve', level: 'owner', riskClass: riskClassForLevel('owner'),
                 reason: 'payee is a support rep, not a customer (disjoint-entity guard)' };
    }
    return null;
  }
}
```

```ts
// gateway.ts, right after Policy.classify
let decision = policy.classify(attempt, ctx);
const g = await semanticGuard?.evaluate(attempt, ctx);
if (g) decision = stricterDecision(decision, g);   // monotone: guard only tightens
```

**Invariants preserved:** `src/core` + kernel still import only `types.ts` (the guard depends
on the `SemanticGuard` / `FactProvider` *interfaces*; concrete providers injected at the
kernel); the guard is monotone (mirrors `applyProposal`); the human + audit remain the final
witness the guard routes *to*, never around. **Don't** reach for a full RDF/OWL stack — the KB
plane (`src/state/kb.ts`) is the tenant graph for entity facts; the audit mirror is the
"settled effects" index.

**Sequencing within Policy v2:** Tier A first — small, pure, one PR, highest value-to-risk once
the sampler learns the new ops. Tier B second — but **hold it until §4.2 (Capability Registry)
ships**, because `entityType` / `hasSettled` are only portable when keyed by a normalized
capability; against raw per-connector names they're exactly the brittleness the registry kills.

## §4.4 — Flight Recorder  *(explainable, replayable, tamper-evident audit)*

- **Exists:** JSONL is the durable system-of-record; `audit_events` is a queryable mirror
  (`GET /api/audit`, console Audit page). Approval records persist; the inbox derives status
  from the `approvals` table at read time. Policy edits snapshot to `policy_revisions`.
  **~70% here.**
- **Delta:** (a) a per-run **immutable, replayable record** binding inputs, agent revision,
  model/provider, tool-catalog versions, policy version, principal + delegation chain,
  decisions, effects, cost, outcome; (b) **hash-chained** events (`previous_event_hash` →
  `event_hash`) for tamper-evidence; (c) **explain-every-decision** on every allow/deny (rule
  id, inputs, reason) exposed via API + UI, not just deny.
- **Touch-points:** `src/governance/audit.ts` + `src/state/db.ts` (hash chain columns); a
  `run` record assembling the above; the gateway attaches the decision explanation to each
  event.
- **Done when:** for any past run you can answer *"why was this permitted on July 28"* against
  the policy version in force then, and verify the event chain wasn't altered.

## Identity & delegation (cross-cutting — extend, don't rebuild)

- **Exists:** run-as vs. provenance split (`spawned_by` vs. `run_as`), `member_identities`
  (chat run-as join key), and A2A task delegation with run-as passthrough.
- **Delta:** make sub-agent authority = `intersection(org, user, parent-agent, sub-agent
  policy)` explicit across the **full** chain, so delegation only *reduces* authority (kills
  privilege laundering: marketing-agent → finance-agent → refund). The gateway must evaluate the
  whole delegation chain, not just the immediate principal.

---

# Part III — Deferred & measurement

## Deliberately deferred (correct, but not now)

- **Model gateway, shadow eval, cost-per-task routing, owned inference** — a *different
  company*; do not let it pull build capacity off the boundary.
- **Trust scores, anomaly detection, change-correlation** — need fleet data first; advisory
  only, never overriding a deterministic decision.
- **Signed authorization tokens** — promote exactly when the executor splits from the control
  plane (distributed enforcement), not before; ceremony in the current in-process gateway.

## North-star

**Governed effects executed** → ultimately **% of a customer's autonomous actions governed by
Agent OS.** That number is whether we became infrastructure.

## Commercial line

Open-source the enforcement primitives (Effect Gateway, policy core, capability model, MCP
proxy core, framework adapters, self-hosted runtime) so no one has to trust a black box.
Monetize the control plane (fleet, SSO/SCIM, policy distribution, security center, cross-env
audit, approvals, private deploy, compliance).

## Design test

For any proposed feature: *does this make agents materially safer, more controllable, more
explainable, or easier to operate in production?* If no, don't build it. The strategic asset is
the enforcement boundary — protect it.

---

## Appendix — origin note

The semantic-guard tiers (§4.3) were seeded 2026-07-27 from Frank Coyle's talk *"Why Agentic
Systems Need Ontologies"*: probabilistic agents kept honest by a deterministic **symbolic**
layer (neuro-symbolic AI) that validates a proposed effect before it touches the world. It
mostly *validates* our design — the gateway + policy engine already are that symbolic layer —
and exposes exactly one capability gap (stateful/relational checks), which §4.3 closes. The
same axis reads as *discrimination over state, witnessed*: interpose deterministic
discrimination between the impulse to act (the raw tool call) and the world, with the human
approver + append-only audit as the final witness the guards route *to*, never around.
