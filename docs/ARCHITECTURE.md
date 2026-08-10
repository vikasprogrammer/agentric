# Agentric — Architecture

> A generic operating system for running autonomous agents safely, unattended, across multiple brands.
> Open-core: the **mechanisms** (kernel, governance, observability) are generic and shippable; the
> **agents, policies, connectors, and data** are brand-private plugins.

![Agentric architecture](https://share.globex.com/CFWZ1myP)

---

## 1. What this is, and the one idea that holds it together

You have ~20 named components. Listed flat, they look like a pile of services. They are not. They
organize into **three concentric responsibilities**, and the whole design follows one rule:

> **Every side effect an agent has on the outside world passes through one mediated boundary that the
> OS controls.** Policy is checked there. Budget is debited there. Identity is asserted there.
> Idempotency is enforced there. Audit is written there.

This is the kernel/syscall boundary of the Agentric. It is the single most important decision in the
whole framework, because **without it, Policy, Budgets, Approvals, Audit, and Evaluation are all
unenforceable** — they become documentation, not controls. (See §4. Today you run agents with
`--permission-mode bypassPermissions` and let them call `Bash`/`curl`/MCP directly — i.e. there is no
boundary yet. That is the central thing to fix.)

The three responsibilities, from inside out:

```
        ┌──────────────────────────────────────────────────────────┐
        │  TRUST + LEARNING  (what makes it safe + improving)        │
        │  Policy · Approvals · Budgets · Audit · Identity ·         │
        │  Monitoring · Evaluation · Console · Dreaming              │
        │   ┌────────────────────────────────────────────────────┐  │
        │   │  EXECUTION SUBSTRATE  (how agents do work)          │  │
        │   │  Orch · Agent Folders · Skills · Tools ·            │  │
        │   │  Workspace · Memory · Knowledge · Tasks             │  │
        │   │    ┌─────────────────────────────────────────────┐ │  │
        │   │    │  EDGE  (how the world reaches in / out)      │ │  │
        │   │    │  Triggers · Comms(in) · Connectors(out) ·    │ │  │
        │   │    │  Secrets                                     │ │  │
        │   │    └─────────────────────────────────────────────┘ │  │
        │   └────────────────────────────────────────────────────┘  │
        └──────────────────────────────────────────────────────────┘
```

Your original 9 are almost entirely the inner two rings — the capability substrate. The advisor's
critique is correct: the outer ring (trust + learning) is the hard, valuable, missing part, and it is
the part that lets you walk away from a running agent.

---

## 2. Design principles (the spine)

These are the load-bearing decisions. Everything else is implementation.

1. **Everything is a Run.** One execution primitive (§3). Cron, webhook, Slack, email, or another agent
   all produce the *same* object. Nothing downstream cares how a run started.

2. **One mediated effect boundary (the gateway).** No agent touches Slack/Stripe/DB/the shell directly.
   Side-effecting capability is exposed only through OS-owned tools, and a `PreToolUse` enforcement hook
   gates the rest. Policy/Budget/Identity/Idempotency/Audit all hang off this one chokepoint (§4).

3. **The audit log is the event store, not a log file.** It is append-only and authoritative. Monitoring,
   Evaluation, the Console, and Dreaming are all *readers* of it. You already started this:
   `data/job-logs/<jobId>.jsonl`. Promote it from "debug log" to "system of record."

4. **Policy is data; the engine is generic.** Brands ship rule files, not forks. Default risk taxonomy:
   `green` (auto), `yellow` (head approves), `red` (you approve). The engine classifies; **Approvals** is
   a separate workflow that routes and *captures the decision*. Policy decides; Audit records; Approvals
   is the human in between.

5. **Capabilities are plugins behind manifests.** Connectors, Tools, Skills, Triggers, and Agents all
   register through a typed manifest. The core never imports a brand's code. This is what makes it
   open-sourceable and multi-brand.

6. **Identity ≠ Secrets.** The agent *acts as* a principal (a service account). Secrets is just the vault
   that mints short-lived credentials for that principal. Audit records the principal, not the key.

7. **Reproducibility by construction.** A run records the exact versions it used (agent vN, skill vM,
   policy vK, model, prompt hash). You can replay why an agent did a thing six months later.

8. **Multi-tenant from line one.** Every object is stamped with a `tenant` (brand). Secrets, policy,
   budget, audit, and memory are isolated per tenant. Retrofitting tenancy is the most expensive thing
   you can skip now.

---

## 3. The Run — the single execution primitive

A **Run** is the OS's "process." It is what your `JobStatus` is today, plus the governance fields.

```jsonc
{
  "run_id": "uuid",
  "tenant": "globex",                  // NEW: brand isolation
  "agent": { "id": "ceo", "version": "1.4.0" },
  "trigger": { "type": "cron|webhook|slack|email|agent", "ref": "...", "idempotency_key": "..." },
  "principal": "svc-ceo@globex",       // NEW: identity the run acts as
  "inputs": { "...": "..." },
  "budget": { "usd_cap": 2.00, "token_cap": 400000, "wall_clock_ms": 1800000 }, // NEW
  "policy_context": "ceo@v7",           // NEW: which ruleset bound this run
  "workspace": "/runs/<run_id>",        // ephemeral scratch
  "session": "claude-session-id",       // conversation continuity (you have this)
  "status": "pending|running|waiting_approval|completed|failed|timeout|cancelled",
  "outcome": "success|failure|unknown", // you have this via [OUTCOME:...]
  "cost": { "usd": 0.83, "tokens": 151000 }, // NEW: actuals, debited at the gateway
  "audit_stream": "job-logs/<run_id>.jsonl"  // you have this
}
```

Note the new state: **`waiting_approval`**. A run can suspend mid-execution when it hits a `yellow`/`red`
action and resume when a human decides. That single status is what turns "fire and hope" into "safe to
leave running."

---

## 4. The mediated effect boundary (the heart of the trust layer)

Today:

```
Agent (claude --print, bypassPermissions) ──► Bash/curl/MCP ──► Stripe, Slack, DB, prod servers
                                              (no chokepoint — nothing can stop "send invoice" twice)
```

Target:

```
                      ┌──────────────── THE GATEWAY (OS-owned) ───────────────┐
Agent wants to act ──►│ 1. Policy.classify(action) → green | yellow | red     │
  (PreToolUse hook    │ 2. if yellow/red → Approvals.enqueue() → suspend run   │──► external system
   or OS-fronted MCP  │ 3. Budget.check_and_debit(cost)  (hard-stop if over)   │     (effect happens
   tool call)         │ 4. Identity.assume(principal) → short-lived creds      │      exactly once)
                      │ 5. Idempotency.guard(key)  (dedupe retried effects)    │
                      │ 6. Resilience.execute_with_retry()                     │
                      │ 7. Audit.append(action, reasoning, result)             │
                      └───────────────────────────────────────────────────────┘
```

How to realize it in the Claude Code substrate you already run on:

- **High-risk effects become OS-fronted tools.** Don't give the CEO agent raw `Bash` to
  `curl …stripe…`. Give it a `refund_customer` tool served by an **OS-owned MCP gateway** that runs
  steps 1–7. The agent literally cannot do the dangerous thing except through the front door.
- **Everything else is gated by a `PreToolUse` hook.** Claude Code hooks can allow/deny/ask before a
  tool runs. The hook calls Policy and writes Audit. This replaces `bypassPermissions` with
  *governed* permissions — and your existing per-agent `allowedTools` becomes the coarse first filter,
  Policy the fine one.
- **Idempotency key rides on the trigger** (e.g. the inbound email `Message-Id`, the ClickUp
  `comment_id`, a webhook delivery id — all of which you already thread through). The gateway dedupes so
  a retried run can't double-fire a side effect. This is the concrete fix for "a retried *send invoice*
  firing twice."

This boundary is the difference between "9 components that run agents" and "an OS you can trust."

---

## 5. The plane model — every component, where it lives, what it must NOT own

Boundaries matter more than definitions here; the advisor's whole critique was about conflated
responsibilities. The **"Not this"** column is the important one.

### Plane A — Edge (world ↔ system)

| Component | Owns | Not this | Today |
|---|---|---|---|
| **Triggers / Scheduler / Event bus** | Deciding *when* a run starts: cron, webhook, event. Emits a Run. | Executing the run (that's Orch). | `src/schedules/*` + `src/webhooks/*` — exists, tangled with Comms. |
| **Comms (inbound)** | *Listening*: Gmail inbox, Slack events, inbound webhooks. The system's ears. | Sending replies (that's a Connector). | Mixed into `webhooks/` (mailgun, clickup, freescout). |
| **Connectors (outbound)** | *Acting on* external systems: post Slack, write ClickUp, send email, query DB. The mouth/hands. | Listening; storing creds. | Scattered in agent `tools/*.php` + bot. Must move behind the gateway. |
| **Secrets** | Vault: store + inject credentials, short-lived where possible. | *Being* the identity; deciding who may use a key. | Flat `.env`, shared, no per-agent/tenant scope. **Real gap.** |

> Edge insight: **Comms-in and Connectors-out are different concerns that happen to talk to the same
> SaaS.** Listening on Slack ≠ posting to Slack. Keep them apart; the gateway sits in front of
> Connectors only.

### Plane B — Execution substrate (how agents do work)

| Component | Owns | Not this | Today |
|---|---|---|---|
| **Orch (kernel)** | Run lifecycle: accept → schedule → execute → suspend/resume → finalize. Concurrency, kill, crash recovery. | Deciding *when* to start (Triggers); *whether* an action is allowed (Policy). | `AgentManager` — solid: submit/execute/kill/persist/concurrency. |
| **Agent Folders** | Unit of deployment: a dir + manifest + `CLAUDE.md`. Versioned, pinnable. | Runtime state; secrets. | `path:"../x"` + `CLAUDE.md`. Add a manifest + version. |
| **Skills** | Reusable capability modules an agent mounts. | Long-term knowledge (that's KB). | Not formalized; Claude Code skills fit directly. |
| **Tools** | Local deterministic capabilities the agent invokes. | External-system effects (Connectors, gated). | `allowedTools` + agent `tools/`. |
| **Workspace** | Per-run scratch FS (ephemeral) + per-agent durable working dir. | System of record (Audit); knowledge (KB). | Agent dir is reused as workspace — no per-run isolation. |

### Plane C — State & knowledge (three *different* stores — do not merge)

| Component | Owns | Not this | Today |
|---|---|---|---|
| **Tasks / Trackers / DB** | *Operational* state: what work exists, its status, the queue. | What happened historically; how to do the work. | `data/jobs.json` + `JobStatus` map. |
| **Memory (episodic)** | *What happened*: past runs, outcomes, decisions, per agent + cross-agent. | SOPs / rules / facts. | Per-agent `remember`/`recall` store (`MemoryProvider`), queryable + ranked, with **auto session-end episodes**, recency/importance ranking, and a shared `scope` (agent\|tenant). **Done.** |
| **Knowledge base (semantic)** | *Durable facts*: SOPs, brand voice, customer history, playbooks. Retrievable. | Run state; episodic history. | A real **KB plane** (`KbStore`, `os.kb`): shared tenant-wide *living* wiki — markdown+FTS, revision chain + revert, agent `kb_*` tools + console page; the **self-learning** pass auto-maintains pages. Memory is also semantically retrievable (hybrid vectors). **Done** (no diff/wiki-hierarchy yet). |

> The advisor's sharpest catch: your "Database/Tracker" is **task state**, not Memory or Knowledge.
> Three stores, three lifecycles. Tasks churn; Memory accretes; Knowledge is curated.

### Plane D — Trust / governance (the critical missing layer)

| Component | Owns | Not this | Today |
|---|---|---|---|
| **Policy** | Classifying actions → green/yellow/red; enforcing constraints. Declarative rules. | Recording (Audit); the approval workflow (Approvals). | Only `allowedTools` + `bypassPermissions` (the *opposite* of policy). **Biggest gap.** |
| **Approvals / HITL** | The queue, routing (yellow→head, red→you), and **decision capture**. | Classifying risk (Policy). | Seed exists: `slack/learnings-approval.ts`. Generalize it. |
| **Budgets / cost** | Per-agent/tenant $ + token caps, hard-stops, model routing. | Wall-clock timeout only. | `timeout`/`maxTurns`/`maxConcurrentJobs` — resource caps, **no $**. |
| **Identity** | The principal a run acts as; least privilege per agent; non-repudiation. | Storing keys (Secrets). | None — runs are anonymous. **Gap.** |
| **Team / Membership** | The *humans* with access: members + roles (owner/admin/member), invite-token login, agent assignment. Gives Policy's `head`/`owner` levels real people behind them. | The service-account a run acts *as* (Identity). | `governance/team.ts` over the per-workspace SQLite DB; magic-link login + cookie sessions; `head`→admin, `owner`→owner approval authority. |
| **Audit log** | Append-only record of every action + reasoning + result. System of record. | Deciding/allowing (Policy). | `appendJobLog` → `*.jsonl`, now mirrored into the SQLite `audit_events` table for queries. |

> **Per-workspace SQLite (`<home>/agent-os.db`).** Everything the live console touches — members &
> login sessions, agent assignments, connectors, terminal sessions, the inbox feed, approvals, and an
> audit mirror — persists in one DB per data home (Node's built-in `node:sqlite`, zero new deps). One DB
> per home keeps instances isolated, exactly like the tmux socket and audit dir.

### Plane E — Observability & learning (the differentiator)

| Component | Owns | Not this | Today |
|---|---|---|---|
| **Monitoring / health** | Liveness: is the daemon alive? Dead-agent/stuck-run detection. Heartbeats. The silent-failure catcher. | Whether an action *worked* (Evaluation). | `getActiveProcesses` + `kill-stale-claude.sh`. Partial. |
| **Evaluation** | Did the action achieve its goal? The outcome signal that feeds learning. | Liveness (Monitoring). | Seed exists: `[OUTCOME:success/failure]` markers → `job.outcome`. **Build out.** |
| **Console** | Human cockpit: approvals, activity feed, spend, health — for you + brand heads. | Being the data store (it reads Audit). | `public/` dashboard + `analytics/`. Good base. |
| **Dreaming / self-learning** | Offline synthesis of new Skills/Knowledge from episodes + eval signal. | Online execution. | `learnings-approval` hints at it. **Defer to last.** |

---

## 6. Where you are today → the gap

You are ~60% built — but almost all of it is the inner two rings. Honest scorecard:

| Layer | State | Note |
|---|---|---|
| Orch / Run primitive | **Strong** | `AgentManager` + `JobStatus`. Add tenant/principal/budget/cost fields. |
| Triggers (cron + webhook) | **Strong** | `schedules/` + `webhooks/`. Separate Comms-in from Connectors-out. |
| Agent folders / Tools / Skills | **Good** | Add manifests + versioning. |
| Audit (event store) | **Seeded** | JSONL per run exists — promote to authoritative, make immutable. |
| Evaluation | **Seeded** | `[OUTCOME:…]` markers — wire into a real outcome pipeline. |
| Approvals | **Seeded** | `learnings-approval.ts` — generalize to any action class. |
| Console | **Seeded** | Dashboard exists — add approvals queue + spend + health. |
| Resilience | **Partial** | `retryAttempts`, autosave, crash-reload, graceful kill. Add **idempotency**. |
| Monitoring | **Partial** | Process listing + stale-kill. Add heartbeats + dead-daemon alerting. |
| **Policy** | **Missing** | `bypassPermissions` = no enforcement. The #1 gap. |
| **The gateway / effect boundary** | **Missing** | Agents call effects directly. Without this, Policy/Budget/Approvals can't bind. |
| **Budgets ($)** | **Missing** | No cost accounting or hard-stop. Non-negotiable for always-on. |
| **Identity** | **Missing** | Runs are anonymous; shared `.env`. |
| **Memory / KB (shared)** | **Missing** | Knowledge trapped in per-agent `CLAUDE.md`. |
| **Multi-tenancy** | **Missing** | Single-brand assumptions throughout. |
| Dreaming | **Missing (correctly deferred)** | Needs Evaluation data first. |

The pattern repeats your advisor's observation: **the capability substrate is the easy part and it's
mostly done. The trust layer barely exists, and it's the entire reason to build an OS instead of just
running scripts.**

---

## 7. Build sequence (dependency-ordered, not wishlist-ordered)

Each phase has a single theme and a gate you can't skip.

**Phase 0 — Substrate (mostly done).** Orch, Agent folders, Tools, Connectors, Workspace, Secrets.
*You are here.* Add: per-run workspace isolation, agent manifests + versions.

**Phase 1 — Make it safe to leave running. (THE GATE.)**
Build the **gateway** (§4) first; nothing else in this phase binds without it.
Then: Policy (declarative green/yellow/red) · Approvals (route + capture) · Budgets ($ hard-stop) ·
Identity (per-agent principals) · Audit (promote JSONL to authoritative) · Idempotency · Monitoring
(heartbeats + dead-daemon alert) · **Kill switch** (global + per-agent circuit breaker).
> Exit criterion: you can enable an always-on agent and *trust* it overnight.

**Phase 2 — Make it act unprompted, cleanly.**
Formalize Triggers/Event-bus; split **Comms-in** from Connectors-out. Now autonomy is safe because
Phase 1 fences it.

**Phase 3 — Make it observable & improving.**
Evaluation (real outcome pipeline off the audit stream) · Memory + shared Knowledge base ·
Console v2 (approvals queue, spend, health, replay).

**Phase 4 — Make it self-improving.**
Dreaming: offline synthesis of Skills/Knowledge from episodes + eval signal, **gated through Approvals**
before anything it proposes goes live. Build last — it is worthless until Evaluation has produced data.

---

## 8. Open-source vs internal — the split that makes this shippable

This is the same model as Kubernetes (open core) vs your workloads (private). Ship the **mechanism**,
keep the **content**.

| Open-source core (generic) | Brand-private (your repos) |
|---|---|
| Run kernel / Orch | The agents themselves (CEO, watchdog, bug-fixer…) |
| Gateway + Policy **engine** | Policy **rules** (what's green/yellow/red for you) |
| Approvals workflow engine | Routing (who is "the head", who is "you") |
| Budget accounting + hard-stop | Budget numbers |
| Audit event store + schema | The audit data |
| Plugin **interfaces** for Connectors/Tools/Triggers/Skills | The connector **implementations** (Globex DBs, ClickUp, Mailgun) |
| Console framework | Brand dashboards, KB content, brand voice |
| Identity + Secrets interface | The actual service accounts + vault contents |

Rule of thumb: **if it encodes a decision or a fact about your business, it's private; if it's a
mechanism for enforcing/recording/routing, it's open.** That boundary is also exactly the
multi-tenant boundary — which is why getting tenancy right (principle 8) and getting the OSS split right
are the same task.

---

## 9. Cross-cutting concerns to name now (cheap now, expensive later)

Not separate planes — properties every plane must respect. Missing from both your list and the critique:

- **Multi-tenancy / brand isolation.** Stamp `tenant` on every Run, secret, policy, budget, audit
  record, memory. Required by "use internally for all brands" *and* by open-sourcing.
- **Versioning / reproducibility.** Pin agent/skill/policy/model versions per run; enables rollback and
  "why did it do that in March?" replay.
- **Kill switch / circuit breaker.** Global + per-agent emergency stop, and auto-trip on anomaly
  (error rate, spend spike). The big red button is part of trust, not a nice-to-have.
- **Data governance / retention.** Audit + Memory will hold customer PII and agent reasoning. Decide
  redaction + retention up front, especially before open-sourcing anything that touches real data.
- **Pre-deployment eval ≠ online Evaluation.** "Does this agent change regress?" (offline test suite,
  CI gate) is distinct from "did this action work?" (online outcome). Both exist; the critique's
  Evaluation is the online one. Build a thin offline harness too — it's how you change an agent without
  fear.

---

## 10. Minimal interfaces (so the core stays generic)

Sketches, not final — the point is that the core depends only on these, never on a brand's code.

```ts
// A capability the OS can govern. Connectors, dangerous Tools register as these.
interface Capability {
  id: string;                       // "stripe.refund"
  riskClass: 'green' | 'yellow' | 'red';   // default; Policy may override per-context
  invoke(args: unknown, ctx: RunContext): Promise<Result>;  // called ONLY via the gateway
}

// Policy is data; this is the engine contract.
interface PolicyEngine {
  classify(action: ActionAttempt, ctx: RunContext): Decision; // allow | deny | approve(level)
}

// A trigger emits Runs; the OS doesn't care what kind it is.
interface Trigger { onFire(emit: (run: RunRequest) => void): void; }

// Everything observable reads this; nothing else is the source of truth.
interface AuditSink { append(event: AuditEvent): void; }  // append-only, immutable, per-tenant
```

The gateway is the only code that calls `Capability.invoke`, and it is the only place
`PolicyEngine.classify`, `Budget.debit`, `Identity.assume`, and `AuditSink.append` are wired together.
Keep that true and the whole system stays governable.

---

## 11. One-paragraph summary

Organize the ~20 components into three rings — Edge, Execution substrate, Trust+Learning — and bind
them with one rule: **every external effect flows through a single OS-owned gateway** where Policy
classifies, Budget debits, Identity asserts, Idempotency dedupes, and Audit records. You've built the
inner two rings already (Orch, triggers, agent folders, plus *seeds* of audit, evaluation, approvals,
and a console). The work that remains — and the reason to build an OS at all — is the outer ring:
the gateway, Policy, Budgets, Identity, real Audit/Evaluation, shared Memory/Knowledge, and tenancy.
Build the gateway first (Phase 1 gate), defer Dreaming to last, and split open-source (mechanism) from
brand-private (decisions, data) along the multi-tenant seam.
