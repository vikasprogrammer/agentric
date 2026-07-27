# Semantic guard — prompt-injection / exfiltration screening

The gate already classifies what an action *is* (destructive, over-cap, external email…). The semantic
guard adds one more fact: does this action look like the agent has been **steered** (a prompt-injection
directive) or is **exfiltrating** (a secret read wired to an outbound channel, a remote script piped to a
shell)? It sets a boolean fact — `injectionSuspect` — that the gate gates on, exactly like `destructive`
or `emailExternal`. Governance principle 3: the classifier is split from the policy.

Origin: a comparative analysis of [Prismor](https://github.com/PrismorSec/prismor), a runtime firewall
for coding agents. Prismor's most valuable idea over our regex enricher is its **hybrid semantic guard**
— a cheap heuristic pre-screen that escalates only *uncertain* inputs to an LLM. We are not adopting
Prismor (Python, out-of-process, overlaps only one of the gateway's seven planes); we are re-implementing
that one idea natively.

## Three tiers

| Tier | What | Where | Status |
|---|---|---|---|
| 1 | Pure, synchronous heuristic pre-screen. Clear-cut shapes → `injectionSuspect`; softer signals → `injectionUncertain`. | `src/governance/semantic-guard.ts` → set in `enrichArgs` | **shipped** |
| 2 | Async escalation: an `uncertain` + already-risky action calls a local classifier (Ollama/OpenAI-compatible, a `Classifier` sibling of the memory `Embedder`) that flips `injectionSuspect`. Promotes `gate()` to async (the `/api/gate` handler already awaits). | `gate()` in `terminal.ts` | planned |
| 3 | Ingestion-side screen of untrusted content the agent *read* (a web fetch, a file, an MCP result) — a PostToolUse surface, reusing this same module. | new PostToolUse hook | planned |

## Tier 1 (this PR)

- **`screenInjection(text)`** → `'clear' | 'suspect' | 'uncertain'`. Pure, ~0ms.
  - `suspect` (clear-cut, high precision — near-zero FP): a secret file (`.env`, `id_rsa`, `*.credentials`)
    or env dump (`printenv`) on the **same command as** an outbound transfer (`curl`/`nc`/`scp`…); or a
    remote script piped straight into a shell (`curl … | bash`).
  - `uncertain` (softer, higher recall — the Tier-2 escalation hook, **no consumer yet**): classic steer
    directives ("ignore all previous instructions"), persona overrides, base64-decode-to-shell.
  - `clear`: everything else.
- **Enricher** (`enrichArgs`) screens the **raw** haystack (payloads intact — the opposite of
  `sanitizeForIntent`, which strips them for intent classification) and sets `injectionSuspect` /
  `injectionUncertain`. **Skips `file.write`**: a file whose *content* mentions `curl … | bash` is not an
  exfil the agent is performing (same reasoning as the destructive-content skip).
- **Enforcement is engine-level**, not a JSON rule: `gate()` combines `injectionDecision(args)` via
  `stricterDecision`, exactly like host governance. This is deliberate — a rule added to
  `default.policy.json` reaches only *fresh* tenants, because an existing tenant's persisted policy
  override no-ops new default rules (see the `default-policy-rules-dont-reach-existing-tenants` lesson).
  Engine-level reaches the whole live fleet.
- It is an **`ask`, never a `deny`**: the guard is a heuristic, so a false positive must be recoverable by
  a human, not a hard block. The `never` tier (a destructive exfil) still wins via `stricterDecision`, so
  it stays blocked, not downgraded.
- **Toggle: `Settings → Governance → Semantic guard`, OFF by default** (owner-only; `semantic_guard_enabled`
  settings key). The enricher *always* computes the fact — the fact is inert until an owner flips the
  switch — so the patterns can bake against the live fleet's audit trail before they start pausing work.

## Guardrails / open questions for Tier 2

- **Cost/latency:** only escalate on `uncertain` **and** already-risky; memoize verdicts per
  `(session, sha256(text))`; attribute the classifier call to the session budget; timeout → fail-closed
  to `ask`.
- **Auto-approvals interaction:** an owner can "always approve" an injection-flagged action shape by brief
  signature (v0.268.0). Decide whether `injectionSuspect` actions should be exempt from the auto-approval
  list (treat like the never tier). Deferred — the toggle-off default makes it non-urgent.
- **False-positive tuning:** the whole point of the off-by-default bake period is to watch
  `gate.decision` audit rows for `injectionSuspect` on benign commands and tighten the CLEAR-CUT set
  before any tenant turns it on.

## Test surface

- `test/governance/conformance.json`: 7 cases (exfil pipe, `curl | bash`, env dump → suspect; plain
  download, read-without-egress, steer-phrasing-alone, file.write content → not suspect). Run
  `node scripts/governance-conformance.cjs`.
- The pure screen + decision composition + settings roundtrip are covered by an in-process smoke script.
