# Agent capabilities plan — what an agent can reach at runtime

An agent inside Agent OS is a `claude-code` session launched in the agent's folder. Today it can use
**connectors** and **memory** (`recall`/`remember`) as MCP tools, can **ask** the operator and
**report** completion, inherits the **company context** in its system prompt, and is governed by the
**PreToolUse gate**. This plan adds the remaining capabilities so an agent can also see its policy
limits, read its own inbox thread, manage its own automations, and discover/delegate to peer agents —
**without ever weakening the one invariant**: every side effect passes through the single mediated
gateway (Policy → Approvals → Audit).

## Status

| Phase | Capability | State |
|------|------------|-------|
| 1 | Policy introspection (`list_capabilities`, `policy_check`) | **shipped** |
| 2 | Inbox read (`read_inbox`, own-session scope) | planned |
| 3 | Automations CRUD (`list/create/update/delete_automation`, gated writes) | planned |
| 4 | Agent directory + delegation (`list_agents`, `delegate_to_agent`, `check_delegation`) | planned |

## The shared pattern (every feature reuses this)

Each capability is a tool on the OS-owned `agentos` MCP server (`src/memory/memory-mcp.ts`), backed by
a **session-scoped loopback endpoint** that sits *before* the member-auth gate in
`src/server.ts` (the block beginning at the `── session-scoped agent endpoints ──` comment). The
non-negotiable rules:

1. **Identity is derived from a real session row, never trusted from the agent.** The endpoint resolves
   the agent via `tm.sessionAgent(session)` (`terminal.ts`). A bogus/expired `session` → 404. This is
   the same loopback-trust model `/api/memory/*`, `/api/ask`, `/api/report` already use.
2. **Reads are free; every write goes through `tm.gate()`.** Listing/checking creates no approval.
   Anything that mutates the world (create automation, delegate to another agent) is classified by
   `os.policy.classify`, which produces an inbox approval card + audit trail, and only acts on approval.
3. **Writes are non-blocking and deferred-on-approval.** The endpoint runs the gate; on `allow` it acts
   synchronously; on `pending` it binds the action to the approval's `settle` promise (`terminal.ts`
   `gate()`), returns `{ pending, gateId }`, and the MCP tool polls the existing `GET /api/gate/{id}`
   to report "done / awaiting approval / denied" back to the agent. (Same restart caveat as today's
   gate waiter — documented, acceptable.)
4. **Pre-allow each new tool** in the `.claude/settings.json` allow-list (`terminal/claude-launch.sh`)
   so agents aren't permission-prompted. Server-side policy is the real control for writes.
5. **Per-workspace opt-in** (phase 3+): a `SettingsStore` toggle gates the autonomy-expanding writes;
   default is reads-on, writes-off/approval-required.

### New tools → endpoints → governance

| Tool (`mcp__agentos__…`) | Endpoint (pre-auth, session-scoped) | Gate |
|---|---|---|
| `list_capabilities`, `policy_check` | `GET /api/agent/policy`, `POST /api/agent/policy/check` | none (pure `classify`) |
| `read_inbox` | `GET /api/agent/inbox` | none (own-session scope) |
| `list_automations` | `GET /api/agent/automations` | none |
| `create/update/delete_automation` | `POST/PATCH/DELETE /api/agent/automations` | **`automation.write`** |
| `list_agents` | `GET /api/agent/peers` | none |
| `delegate_to_agent`, `check_delegation` | `POST /api/agent/delegate`, `GET /api/agent/delegate/{sid}` | **`agent.delegate`** |

---

## Phase 1 — Policy introspection *(shipped)*

The agent learns its limits proactively instead of discovering them when the gate blocks it.

- **Tools:** `list_capabilities` (the registered capability catalog + the default policy verdict for
  each) and `policy_check({capability, args})` (dry-run one specific attempt, works for *any*
  capability string — not just registered ones — since `classify` falls back to `defaultRisk`).
- **Endpoints:** `GET /api/agent/policy` and `POST /api/agent/policy/check`. Both call
  `tm.policyCheck()` → `os.policy.classify(attempt, ctx)`, which is **pure** (`policy.ts`): no approval,
  no audit, no side effect. `GET` enumerates `os.registry.list()` (populated in `serve` via
  `server.ts` `registerCapabilities(exampleCapabilities)`).
- **Why first:** ~zero governance surface, no new state, and it de-risks phases 3–4 because the agent
  can self-check before attempting a gated write.

### Files touched (phase 1)

- `src/terminal.ts` — `policyCheck(session, agent, capability, args): Decision` (wraps `classify` with
  the session `ctx`; no side effect).
- `src/server.ts` — `GET /api/agent/policy`, `POST /api/agent/policy/check` (in the session-scoped block).
- `src/memory/memory-mcp.ts` — `list_capabilities` + `policy_check` tools, handlers, dispatch.
- `terminal/claude-launch.sh` — allow-list the two new tools.

---

## Phase 2 — Inbox read *(planned)*

- **Tool:** `read_inbox` — returns this session's thread (the task, operator `update`/`say` messages,
  answered questions). Headline use case: a **headless** agent polling for mid-run operator guidance it
  otherwise can't see.
- **Endpoint:** `GET /api/agent/inbox?session=…` → messages `WHERE session_id = ?`. **Scoped to the
  agent's own session** by default — reading the shared workspace inbox is cross-agent disclosure, so a
  broader read stays admin/console-only (or a later, gated, opt-in tool).
- **Files:** `memory-mcp.ts` (1 tool), `server.ts` (1 endpoint), `terminal.ts`
  (`sessionMessages(id)` reader).

## Phase 3 — Automations CRUD *(planned)*

`Automations` already has full CRUD (`src/edge/automations.ts`); this exposes it to agents safely.

- **Tools:** `list_automations` (read) + `create/update/delete_automation` (gated writes).
- **Scope guard:** an agent may only create automations targeting **itself**
  (`agentId = sessionAgent`) and only modify ones it created — prevents an agent scheduling *other*
  agents (that is phase 4's job, with higher friction).
- **Governance:** writes call `tm.gate(session, agent, 'automation.write', {…}, reasoning)`. Scheduling
  recurring/future runs is a persistence/privilege vector → approval by default. On approval the
  deferred `settle.then` performs `autos.add/update/remove`; `createdBy` is stamped `agent:<id>`.
- **Small refactor:** extend `gate()` (or add `gateDeferred`) so the endpoint can bind its action to
  the approval's `settle` promise without duplicating the inbox-card logic.
- **Files:** `memory-mcp.ts`, `server.ts`, `terminal.ts` (gate refactor), `config/policy` (default rule
  for `automation.write`), capability registry entry, `settings.ts` (opt-in toggle).

## Phase 4 — Agent directory + agent-to-agent *(planned)*

The `'agent'` `TriggerRef` type already exists (`types.ts`) as the intended hook but is unimplemented.

**(a) Directory** — `list_agents` → `GET /api/agent/peers` returns the registry (`kernel.ts` `agents`):
id, description, runtime, and a short "how to reach me" blurb. Read-only, low-risk; can be scoped to
peers this agent is allowed to see.

**(b) Delegation via gated spawn** — the concrete path; it is what `Automations.fire()` already does
(`automations.ts`): spawn a governed child session.
- **Tool:** `delegate_to_agent({agent, task})` → `POST /api/agent/delegate`, gated by **`agent.delegate`**
  (approval by default). On approval, `tm.createSession(target, …, spawnedBy: 'agent:<id>:<session>')`.
  Returns the child `sessionId` as a handle.
- **`check_delegation(sid)`** → `GET /api/agent/delegate/{sid}` lets the parent poll the child's status
  / `report` outcome (same poll model as `ask`) — synchronous "A waits for B" with no new transport.
- **Loop/fan-out safety (critical):** walk the `spawnedBy` `agent:<id>:<session>` chain to compute
  delegation depth; refuse beyond a cap (e.g. depth 3) and a per-session fan-out cap. Every hop audited.
- **Async mailbox (optional, later):** a `to_agent` recipient column on `messages` (or a small
  `agent_mail` table) so A can leave a message B reads on its next run — lighter than live RPC.

---

## Cross-cutting (do once, covers phases 3–4)

- **Capability registry + policy defaults:** register `automation.write` and `agent.delegate`, and add
  **fail-safe** default rules in `config/policy` so both require approval out of the box.
- **Per-workspace opt-in:** a `SettingsStore` toggle (`agentSelfService: { policyRead, inboxRead,
  automations, delegation }`); default reads-on, writes-off. Endpoints check it before acting.
- **Console:** delegated sessions and agent-created automations already render (they are
  sessions/automations) — just label the `agent:` provenance; add the toggles to the Settings page.
