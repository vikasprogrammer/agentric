# TODO — Agent OS plan execution

Working checklist for the plan in [`docs/agent-os-plan.md`](docs/agent-os-plan.md). The wedge is the
**mediation plane behind existing MCP gateways** — own the enforced primitive (suspend-for-a-human +
budget + tamper-evident record), don't build a competing gateway. Keep this file current as work ships.

_Last updated: 2026-08-03._

## Shipped

- [x] **Second coding runtime (Codex)** — `runtime: "codex"` runs a real, governed Codex TUI at parity
      with Claude Code (attachable + resident via pre-seeded hook trust, one shared gate hook, sandbox
      write containment, transcript/cost reader, runtime picker) · v0.272.0–v0.284.1 · PR #478–#510
- [x] **Canonical plan doc** — `docs/agent-os-plan.md` (thesis + landscape + roadmap) · PR #493, #506
- [x] **§4.3 Policy v2 — Tier A** — set-membership (`in`/`nin`) + cross-arg (`argRef`) conditions in the
      pure rule engine; monotonicity proof kept sound · v0.284.0 · PR #498
- [x] **§4.2 Capability Registry** — normalize connector tool names → canonical capabilities
      (`STRIPE_REFUND → payments.refund`) so one policy rule governs an action across surfaces ·
      v0.286.0 · PR #514
- [x] **Gateway spike** — verdict: no native indefinite hold; suspend = deny-with-"pending" → retry;
      ContextForge is the first adapter target (folded into §4.1)

## Next (open fork — pick one)

- [ ] **§4.3 Policy v2 — Tier B (stateful/relational guard)** — the "was this order already refunded?"
      / wrong-entity-type checks. Engine-level (NOT JSON — a persisted policy override would never see a
      new JSON rule), folded via `stricterDecision` like the Tier-1 injection guard. Needs a
      `FactProvider`: `hasSettled(op, key)` over the audit index + `entityType(kind, id)` over the
      KB/directory. **Unblocked now** that §4.2 gives it canonical capabilities to key on.
- [ ] **ContextForge adapter (hands-on)** — stand up IBM ContextForge, wire `tool_pre_invoke` → our
      decision, prove the **deny-with-"pending" → idempotency-keyed retry** loop end-to-end against an
      unmodified gateway. Settle the two open unknowns: agentgateway backend-timeout override on the
      guardrails channel, and the agent's own **client-side MCP request timeout** (the true outer bound
      on any synchronous hold).

## Backlog (from the plan, not yet started)

- [ ] **§4.1 Mediation Plane** — build `src/mediation/*`: the `EffectIntent → Decision` hook (with a
      first-class **`pending`** outcome: allow / ask / deny / pending) + the ContextForge adapter, then
      agentgateway (`ExtMcp` gRPC) second. Tool-drift / poisoning quarantine.
- [ ] **§4.2 grow coverage** — add provider mappings to `src/capabilities/normalize.ts` as the plane
      sees more tools; a console catalog view off `knownCapabilities()`.
- [ ] **§4.4 Flight Recorder** — hash-chained (tamper-evident) audit events; per-run immutable record;
      explain-every-decision on `allow`, not just `deny`. Emit OTel GenAI conventions (~70% exists).
- [ ] **Identity & delegation** — make sub-agent authority = intersection over the FULL delegation
      chain (delegation only reduces authority; kills privilege laundering).
- [ ] **Governance Coverage %** — surface the honest gap (which effects are/aren't governed) per tenant.

## Deferred (correct, but not now — per plan §7)

- [ ] Model gateway / shadow eval / cost-per-task routing / owned inference
- [ ] Trust scores, anomaly detection, change-correlation (need fleet data first)
- [ ] Signed authorization tokens (only once the executor splits from the control plane)

## Working notes

- **Sequencing:** Tier B is gated behind §4.2 (done). §4.1 build is gated behind the ContextForge
  adapter spike proving the suspend protocol.
- **Don't lead with "control plane"** — the phrase is a red ocean; lead with the enforced primitive.
- **Ship discipline:** branch → PR → squash-merge (`--repo vikasprogrammer/agent-os`); CI = `npm run
  test:governance`. Concurrent-shipping churn is heavy — **commit, then rebase right before merge.**
