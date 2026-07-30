---
name: code-review
description: Get a fast, provider-agnostic CROSS-MODEL code review of the current git diff (or a GitHub PR) — an independent second opinion alongside your primary reviewer, with a structured verdict (block/warn/pass) mapped to an exit code so a caller or CI can gate on it. The reviewer model/provider is config (z.ai GLM by default; any OpenAI- or Anthropic-compatible API via 3 env vars). Use before opening or merging a PR, or to sanity-check a Claude review.
license: MIT
---

# Cross-model code review (provider-agnostic)

A fast, **one-shot cross-model** review of a code diff — a cheap second opinion that catches what a
single reviewer misses. Different model, different blind spots: agreement across models raises
confidence; disagreement flags a spot worth a closer look.

The reviewer is **config, not hardcoded**. One code path speaks two wire protocols — OpenAI
`/v1/chat/completions` (the lowest common denominator: OpenAI, z.ai PAYG, local Ollama, …) and
Anthropic `/v1/messages` (Claude, z.ai coding plan) — auto-selected from the base URL. Point it at any
provider with three env vars. It asks the model for **structured output** and maps the verdict to an
**exit code**, so a caller / CI / pre-push hook can gate on it.

It reviews the diff of the **current git repo**, so run it from inside the checkout you're working in.

## Configure the provider (env)
| Var | Default | Notes |
|---|---|---|
| `REVIEW_BASE_URL` | `https://api.z.ai/api/anthropic` | API base. e.g. `https://api.openai.com/v1`, `http://localhost:11434/v1`, `https://api.z.ai/api/paas/v4`, `https://api.anthropic.com` |
| `REVIEW_MODEL` | `glm-4.6` | e.g. `gpt-5.1`, `qwen2.5-coder`, a `claude-…` id |
| `REVIEW_API_KEY` | falls back to `$ZAI_API_KEY`, then `$OPENAI_API_KEY` | optional for a keyless local endpoint (Ollama) |
| `REVIEW_WIRE` | auto | `openai` \| `anthropic`. Auto = anthropic for an `/api/anthropic` or `api.anthropic.com` base, else openai. Set to override. |
| `REVIEW_MAX_DIFF` | `120000` | cap the diff at N bytes |
| `REVIEW_MAX_TOKENS` | `4096` | model output cap |
| `REVIEW_JSON_MODE` | `1` | openai wire only: ask for `response_format: json_object`; set `0` if a model rejects it |
| `REVIEW_FAIL_ON` | `block` | verdict that yields a non-zero exit: `block` \| `warn` \| `never` |

> **Keys come from the agent-os secrets vault, never inline.** Have the provider key assigned to your
> agent (Settings → Secrets) so it lands in your shell at launch — as `REVIEW_API_KEY` for the configured
> provider, or as `ZAI_API_KEY` for the default z.ai GLM (the `code-reviewer` and `engineer` runtimes
> already carry a z.ai key, so the default works out of the box). Don't paste a key on the command line.

> **z.ai billing note:** our z.ai key is a *coding-plan* key — it has balance on the **Anthropic**
> endpoint (`/api/anthropic`, the default) but **not** on the OpenAI PAYG endpoint (`/api/paas/v4`),
> which returns *"insufficient balance"*. So the default deliberately uses the Anthropic wire. To drive
> z.ai over the OpenAI wire you'd need PAYG balance; any other OpenAI-compatible provider just needs its
> own key.

## Use it
Run the bundled script from your repo:

```bash
bash .claude/skills/code-review/code-review.sh              # uncommitted changes (git diff HEAD)
bash .claude/skills/code-review/code-review.sh --staged     # staged changes
bash .claude/skills/code-review/code-review.sh --base main  # main...HEAD (your feature branch)
bash .claude/skills/code-review/code-review.sh --pr 2310    # a GitHub PR (needs gh)
bash .claude/skills/code-review/code-review.sh --model glm-4.6   # override REVIEW_MODEL for this run
bash .claude/skills/code-review/code-review.sh --json       # the normalized structured object, not the human render
```

Switch provider by env only (nothing else changes):

```bash
# OpenAI
REVIEW_BASE_URL=https://api.openai.com/v1 REVIEW_MODEL=gpt-5.1 REVIEW_API_KEY="$OPENAI_API_KEY" \
  bash .claude/skills/code-review/code-review.sh --base main

# Local Ollama (no key)
REVIEW_BASE_URL=http://localhost:11434/v1 REVIEW_MODEL=qwen2.5-coder \
  bash .claude/skills/code-review/code-review.sh --base main
```

## Output
Human-readable, most-severe first:

```
── code-review (verdict: block, 2 finding(s)) ──
  src/user.js:2 — blocker [correctness] Assignment (=) used instead of comparison in find predicate.  Fix: use ===
  src/user.js:3 — blocker [correctness] Unsafe property access on a possibly-undefined result.  Fix: guard `if (!u) return null`
```

`--json` prints the normalized object:

```json
{ "verdict": "block|warn|pass",
  "findings": [ { "file": "", "line": 0,
                  "severity": "blocker|important|nit|question",
                  "category": "correctness|security|edge-case|spec|simplification",
                  "summary": "", "fix": "" } ] }
```

The review is scoped to **real bugs, security, and spec/intent adherence** — it deliberately ignores
style, formatting, and naming to keep the signal high.

## Exit codes (gate on the verdict)
| Code | Meaning |
|---|---|
| `0` | pass / warn, or nothing to review (or unstructured output printed raw) |
| `2` | the verdict crossed `REVIEW_FAIL_ON` (default: `block`) |
| `3` | usage / missing dependency (`jq`, `curl`, `gh` for `--pr`) |
| `4` | the API call itself failed (network, auth, provider error — the message is printed) |

So `code-review.sh --base main || echo "review flagged a blocker"` works in a pre-push hook or CI step.

## How to use the result
Treat it as a **second opinion, not a verdict**: verify each point against the code before acting. It
pairs well with a primary review (e.g. the host's own `/code-review`) — run both and reconcile. The
parser is tolerant: if a provider returns imperfect JSON, the raw text is printed instead of crashing
(and the verdict can't gate that run). The gateway still governs any change you make as a result; this
skill only reads a diff and calls an API.

## Follow-ups (out of scope for v1)
- N-model panel / multi-axis fan-out across several providers, reconciled.
- Autofix-in-a-VM (overlaps the `engineer` / `qa` agents — don't rebuild here).
