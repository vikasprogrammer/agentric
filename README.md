# Agent OS

A generic operating system for running autonomous agents **safely, unattended, across multiple brands**.

Open-core: the **mechanisms** — kernel, governance, observability — are generic and shippable. Your
**agents, policies, connectors, and data** are brand-private plugins.

> Full design rationale: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## The one idea

> **Every side effect an agent has on the outside world passes through one mediated boundary — the
> gateway — that the OS controls.** Policy is checked there. Budget is debited there. Identity is
> asserted there. Idempotency is enforced there. Audit is written there.

Without that single chokepoint, Policy / Budgets / Approvals / Audit / Evaluation are unenforceable —
documentation, not controls. With it, you can leave an agent running and trust it. The rest of the
repo is built around making that boundary real.

```
Agent wants to act ──► [ GATEWAY ] ──► external system
                        1. Policy.classify  → green | yellow | red | deny
                        2. Approvals         → suspend run for yellow/red until a human decides
                        3. Budget            → hard-stop if over cap
                        4. Identity          → act as the run's principal
                        5. Idempotency       → dedupe retried effects (exactly-once)
                        6. Execute           → call the capability
                        7. Audit             → record action + reasoning + result
```

---

## Quickstart

```bash
npm install
npm run demo       # drives 4 runs through the gateway — no API keys needed
npm run typecheck  # tsc --noEmit
npm run dev        # boot the OS from config and report readiness
```

`npm run demo` exercises the whole trust layer against mock capabilities and prints the exact
append-only audit trail the gateway wrote for each run:

| Scenario | What it proves |
|---|---|
| **1. Green + retry** | Allowed actions run; an idempotent retry is **deduped** (effect fires once). |
| **2. Approvals** | `$49` refund → **yellow → head approves**; `$5000` refund → **red → owner declines** → blocked. |
| **3. Budget** | `$0.02` cap, `$0.01`/action → **hard-stop on the 3rd**. |
| **4. Policy deny** | `prod.*` is **denied outright**; the capability never executes. |

Durable audit is written to `data/audit/<tenant>/<run_id>.jsonl` — one append-only file per run.

---

## Repository layout

```
agent-os/
├── config/                     # DECLARATIVE — the brand's rules (policy + manifests)
│   ├── agent-os.config.json    #   tenant, dirs, defaults
│   ├── policy/default.policy.json   # green/yellow/red/deny rules (policy is DATA)
│   └── agents/<id>/            #   agent.json manifest + CLAUDE.md
│
├── src/
│   ├── types.ts                # the only contracts the core depends on
│   ├── kernel.ts               # composition root — wires everything (AgentOS, loadAgentOS)
│   ├── index.ts                # boot entrypoint
│   ├── demo.ts                 # the runnable demo above
│   │
│   ├── core/                   # ── Orchestrator: the Run lifecycle (the kernel)
│   │   ├── run.ts
│   │   └── orchestrator.ts
│   ├── gateway/                # ── THE mediated effect boundary
│   │   ├── gateway.ts          #    the 7-step pipeline
│   │   └── idempotency.ts
│   ├── governance/             # ── Trust plane
│   │   ├── policy.ts           #    rule engine (data-driven)
│   │   ├── approvals.ts        #    HITL queue + decision capture
│   │   ├── budget.ts           #    $/token caps + hard-stop
│   │   ├── identity.ts         #    act-as principal (≠ secrets)
│   │   └── audit.ts            #    append-only event store (system of record)
│   ├── observability/          # ── Did it stay alive? Did it work?
│   │   ├── monitor.ts          #    heartbeats / stale-run detection
│   │   └── evaluation.ts       #    outcome signal (feeds learning)
│   ├── capabilities/           # ── Plugin table: governable side effects
│   │   ├── registry.ts
│   │   └── examples.ts         #    echo / slack / stripe.refund / prod.restart (mocks)
│   ├── edge/                   # ── World ↔ system
│   │   ├── triggers.ts         #    WHEN a run starts (cron/webhook/manual)
│   │   └── secrets.ts          #    vault, namespaced per tenant+principal
│   ├── runtime/                # ── How an agent is driven
│   │   ├── mock-adapter.ts     #    deterministic, used by the demo
│   │   └── claude-code-adapter.ts  # reference sketch: claude --print + PreToolUse hook
│   └── state/
│       └── stores.ts           #    Tasks (state) · Memory (episodic) · Knowledge (semantic)
│
└── docs/ARCHITECTURE.md        # the full design
```

The split is deliberate and is also the **open-source seam**: `config/` + plugin implementations are
brand-private; everything in `src/` (minus the example plugins) is the generic core.

---

## Extending it

**Add a capability (a governable side effect).** Implement `Capability` and register it. The gateway
governs it automatically; the policy file decides its risk.

```ts
const sendInvoice: Capability = {
  id: 'billing.sendInvoice',
  description: 'Email an invoice to a customer',
  defaultRisk: 'yellow',
  estimateCost: () => ({ usd: 0.002, tokens: 0 }),
  async invoke(args, ctx) {
    const key = await ctx.secrets.get(ctx.run.tenant, ctx.run.principal, 'BILLING_API_KEY');
    // ... perform the effect using `key` ...
    return { ok: true, data: { invoiceId: 'inv_123' } };
  },
};
os.registerCapabilities([sendInvoice]);
```

**Change policy without touching code** — edit `config/policy/default.policy.json`:

```jsonc
{ "match": { "capability": "billing.sendInvoice", "when": { "arg": "amountUsd", "op": "gt", "value": 500 } }, "risk": "red" },
{ "match": { "capability": "billing.sendInvoice" }, "risk": "yellow" }
```

First match wins, so put the more specific (conditional) rule first.

**Add an agent** — drop `config/agents/<id>/agent.json` (+ `CLAUDE.md`) and register its behavior
(mock) or point it at the `claude-code` runtime.

**Wire a real agent** — implement the `claude-code` adapter (see `src/runtime/claude-code-adapter.ts`):
spawn `claude --print` *without* `bypassPermissions`, front dangerous tools via an OS-owned MCP server,
and gate the rest with a `PreToolUse` hook that calls `gateway.invoke`.

---

## Status — what's real vs. stubbed

This is a **starter**: the spine is real and runnable; the leaves are swappable stubs.

| Real & working | Reference stub (swap for prod) |
|---|---|
| Gateway 7-step pipeline | In-memory budget / approvals / idempotency (→ Postgres/Redis) |
| Policy engine (data-driven, glob + conditions) | `StubIdentity` (→ STS / scoped OAuth) |
| Append-only JSONL audit (per tenant/run) | `EnvSecretsVault` (→ Vault / SSM) |
| Run lifecycle + `waiting_approval` suspend/resume | In-memory Tasks/Memory/Knowledge (→ DB / vector store) |
| Budget hard-stop, idempotency dedupe | `ClaudeCodeAdapter` (reference sketch only) |
| Evaluation signal off the audit stream | Console is a snapshot (→ web cockpit) |
| Multi-tenant fields throughout | Triggers: manual only (→ cron/webhook/event bus) |

Deferred by design (build last, after Evaluation has data): **Dreaming / self-learning**.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §6–§7 for the maturity phases and the full gap map.

---

## License

MIT.
