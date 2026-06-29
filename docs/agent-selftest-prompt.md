# Agent self-test prompt

A copy-pasteable task that exercises everything an agent can reach **today** — persistent
memory, the policy preview (`list_capabilities` / `policy_check`), the approval gate, and the
operator loop (`ask` / `report`) — and self-reports a PASS/FAIL table.

## How to run

Spawn a session for any agent whose `runtime` is `claude-code` (so it actually gets the
`agentos` MCP tools + the PreToolUse gate hook — a `mock` agent won't) and paste the prompt
below as its task. The agent will pause twice waiting on you in the **Inbox**; approve/answer
there and it continues.

> **Heads up:** this prompt blocks on a human (step 6 = approval gate, step 7 = `ask`), so run
> it **interactive**, not headless — a headless run would just hang waiting on the operator.
> For the same reason it's a poor fit for a cron/webhook automation.

## The prompt

```
You are a self-test agent for Agent OS. Run the steps below IN ORDER, using your
agentos MCP tools. Do NOT do anything destructive — only echo-level shell. After each
step, record the literal tool response and a PASS/FAIL judgement. Two steps will PAUSE
waiting on the human operator (in their Inbox) — that pause is the feature working, not
a failure; wait for them.

1) POLICY CATALOG — call `list_capabilities`. Expect a list of governed capabilities,
   each labelled allowed / needs-approval / DENIED. PASS if you get a non-empty list.

2) POLICY DRY-RUN — call `policy_check` for each of these and confirm the verdicts differ
   by rule and by argument value (nothing is actually performed):
     - capability "echo.run"                              → expect ALLOWED
     - capability "stripe.refund", args {"amountUsd":50}  → expect NEEDS APPROVAL (head)
     - capability "stripe.refund", args {"amountUsd":5000}→ expect NEEDS APPROVAL (owner)
     - capability "deploy.ship"                           → expect NEEDS APPROVAL (owner)
     - capability "prod.restart"                          → expect DENIED
   PASS if the small vs large refund route to DIFFERENT levels and prod is denied.

3) MEMORY WRITE — call `remember` with content
   "selftest-marker <pick a random 6-digit number>: the policy gate routes refunds over
   $1000 to owner approval", tags ["selftest"], type "Insight". Expect a "Remembered (id …)".

4) MEMORY READ (round-trip) — call `recall` with query "selftest-marker refunds owner
   approval". PASS if your step-3 fact comes back.

5) MEMORY MISS — call `recall` with query "xyzzy-nonexistent-topic-9999". PASS if it
   returns no results gracefully (no error/crash).

6) APPROVAL GATE — run exactly this shell command (harmless, but matches a risky pattern
   so it must be gated):  echo "pretend-deploy dry run — no real effect"
   Expect the action to PAUSE and an approval card to appear in the operator's Inbox.
   Wait. PASS if it resumes after the operator approves (or is cleanly blocked if denied).

7) ASK THE OPERATOR — call `ask` with question "Self-test: reply with the word 'confirmed'
   so I can verify the ask→answer loop." Wait for the answer. PASS if you receive their reply.

8) REPORT — call `report` with outcome "success" (or "partial" if anything failed) and a
   one-line summary. Then print a final markdown table: Capability | Tool | Expected |
   Actual | PASS/FAIL for steps 1–7.
```

## What this does and doesn't cover

- **Covered (wired today):** `recall` / `remember` (memory), `list_capabilities` / `policy_check`
  (Phase 1 policy preview), `ask` / `report` (operator loop), and the PreToolUse approval gate.
- **Not covered (not built yet):** inbox-read (Phase 2), automations CRUD (Phase 3), agent
  directory + delegation (Phase 4) — see [agent-capabilities-plan.md](agent-capabilities-plan.md).
  Add steps here as those phases land.
- **Connectors:** if any are enabled, the agent will also see their MCP tools. To confirm that
  wiring, add a step like *"list any non-`agentos` tools available and call one read-only one."*

## Maintenance

- Step 2's expected verdicts assume the bundled `config/policy/default.policy.json` (refund
  tiers, `deploy.* → red`, `prod.* → deny`). If you edit the policy, update the expectations.
- Step 6's `echo "…deploy…"` trips the gate because `deploy` matches a risky pattern in
  `terminal/gate-hook.sh`. If you change those patterns, swap in a string that matches the
  current ones (`stripe`, `refund`, ` rm `, `prod`, `kubectl`, `systemctl`, …).
