/**
 * The SEMANTIC GUARD — prompt-injection / exfiltration screening, Tier 1 (the pure, synchronous
 * heuristic pre-screen). Sibling of the enricher: `enrichArgs` computes the FACTS an action really
 * carries; this decides whether those facts look like the agent has been STEERED (a classic injection
 * directive) or is EXFILTRATING (a secret read wired to an outbound channel, a remote script piped to a
 * shell). It sets one boolean fact — `injectionSuspect` — that the gate gates on, exactly like
 * `destructive`/`emailExternal`. No I/O, no model call, ~0ms: governance principle 3 (classifier split
 * from policy), same contract as the rest of `governance/`.
 *
 * THREE tiers, mirroring a hybrid firewall (heuristic <1ms → escalate uncertain → verdict):
 *   - Tier 1 (here): `screenInjection` returns 'suspect' for CLEAR-CUT, high-precision signatures →
 *     the enricher sets `injectionSuspect`; the gate (engine-level, when the workspace toggle is on)
 *     combines an `ask` into the decision. This file. Pure + shipped independently.
 *   - Tier 2 (later): 'uncertain' surfaces `injectionUncertain` for an async LLM escalation in the gate
 *     — computed here so the hook exists, but NOTHING consumes it yet (no async on this path today).
 *   - Tier 3: the escalation verdict flips `injectionSuspect`; `classify()` runs unchanged.
 *
 * Precision over recall — DELIBERATELY. A false positive pauses real work on an approval card (the
 * storm we just spent commits killing), so CLEAR-CUT patterns are near-zero-FP shapes (a `.env` read
 * PIPED to `curl`, `curl … | bash`), never a lone scary word. Softer signals ("ignore previous
 * instructions" phrasing on its own) go to the 'uncertain' tier for Tier 2 to adjudicate, not to a block.
 * Known limit (same as the enricher): we only see what we're given. Injection arriving through content
 * the agent READ (a web fetch, a file, an MCP result) is a PostToolUse surface — a fast-follow reusing
 * this module — not this PreToolUse slot, which catches injection that has already steered the agent
 * into an outbound/exec effect (the last line before the damage).
 */
import { ApprovalLevel, Decision, riskClassForLevel } from '../types';

// A file that names a credential (dotenv, SSH/cloud keys, token/secret files). Bare read is fine — it's
// only a CLEAR-CUT signal when the SAME command also reaches the network (OUTBOUND, below).
const SECRET_FILE =
  /(^|[\s'"=/])(\.env(\.[\w.-]+)?|id_[rd]sa\b|\.ssh\/[\w.-]+|\.aws\/credentials|\.netrc|\.npmrc|\.pgpass|[\w.-]*(secret|credential|token|apikey|api_key)s?\.(json|ya?ml|txt|env))\b/i;
// A secret-dumping command (whole-environment / keychain export) — the payload half of an env-exfil.
const SECRET_DUMP = /\b(printenv|env)\b(?![-\w])|\bset\b\s*(\||>|$)|security\s+find-generic-password|\bcat\s+[^|&;]*\b(token|secret|credential)/i;
// An OUTBOUND network egress verb — where exfiltrated bytes would leave. Kept tight (a transfer tool
// with a URL/host), so an inbound `curl` that only FETCHES doesn't trip on its own.
const OUTBOUND_NET =
  /\b(curl|wget|nc|ncat|netcat|scp|sftp|rsync|ssh)\b[^|&;]*\b([a-z0-9.-]+\.[a-z]{2,}|(\d{1,3}\.){3}\d{1,3}|https?:\/\/)/i;
// A remote script piped straight into an interpreter — `curl … | bash`, `wget -O- … | sh`. The
// single highest-signal supply-chain / injection execution shape.
const REMOTE_EXEC =
  /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|ksh|dash|python[0-9.]*|node|ruby|perl|php)\b/i;

// ── Tier 2 (uncertain) — softer signals: real hooks, no consumer yet ──
// Classic steer directives. High-recall / lower-precision (they appear in quoted DATA, docs, a PR body),
// so on their OWN they only escalate, never block. Tier 2's LLM pass adjudicates.
const STEER_DIRECTIVE =
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all\s+)?(previous|prior|earlier|above|the\s+system|your)\b[^.\n]{0,20}\b(instructions?|prompt|rules?|directives?)\b/i;
const STEER_PERSONA = /\byou\s+are\s+now\b|\bnew\s+instructions?\s*:|\bsystem\s+override\b|\bact\s+as\s+(if\s+you\s+are\s+)?(an?\s+)?unrestricted\b/i;
// A base64 blob decoded straight into a shell — obfuscated execution.
const B64_EXEC = /\bbase64\b[^|]*-{0,2}d[^|]*\|\s*(bash|sh|zsh|python[0-9.]*|node)\b|\|\s*base64\s+-{0,2}d\s*\|\s*(bash|sh)\b/i;

/**
 * Tier-1 screen. Pure. Returns:
 *   'suspect'   — a CLEAR-CUT injection/exfiltration shape → `injectionSuspect` (the gate acts on it).
 *   'uncertain' — a softer signal → `injectionUncertain` (Tier-2 escalation hook; no consumer yet).
 *   'clear'     — nothing matched.
 * `suspect` dominates `uncertain` (a command can hit both).
 */
export function screenInjection(text: string): 'clear' | 'suspect' | 'uncertain' {
  if (!text) return 'clear';
  const secretExfil = (SECRET_FILE.test(text) || SECRET_DUMP.test(text)) && OUTBOUND_NET.test(text);
  if (secretExfil || REMOTE_EXEC.test(text)) return 'suspect';
  if (STEER_DIRECTIVE.test(text) || STEER_PERSONA.test(text) || B64_EXEC.test(text)) return 'uncertain';
  return 'clear';
}

/**
 * The engine-level decision for a suspected-injection action — applied by the gate via `stricterDecision`
 * (NOT expressed as a JSON rule, so it reaches EVERY tenant regardless of a persisted policy override,
 * like host governance). An `ask`, never a `deny`: this is a heuristic, and a false positive must be
 * recoverable by a human, not a hard block on real work. Level defaults to `head` (admin) — the operator
 * hardens to `owner` if they want the top approver on every flag. Only meaningful when `injectionSuspect`.
 */
export function injectionDecision(facts: Record<string, unknown>, level: ApprovalLevel = 'head'): Decision {
  if (facts.injectionSuspect !== true) return { effect: 'allow', riskClass: 'green', reason: 'no injection signal' };
  return { effect: 'approve', level, riskClass: riskClassForLevel(level), reason: 'possible prompt-injection / secret-exfiltration pattern' };
}
