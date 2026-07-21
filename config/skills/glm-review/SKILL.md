---
name: glm-review
description: Get a fast CROSS-MODEL code review of the current git diff (or a GitHub PR) from z.ai's GLM model — an independent second opinion alongside your primary reviewer. Use before opening or merging a PR, when the user asks to "review with GLM / z.ai / a different model", or to sanity-check a Claude review. Requires ZAI_API_KEY in the environment.
license: MIT
---

# GLM code review

A fast, **one-shot cross-model** review of a code diff using z.ai's GLM models (via their
Anthropic-compatible API) — a cheap second opinion that catches what a single reviewer misses.
Different model, different blind spots: agreement across models raises confidence; disagreement
flags a spot worth a closer look.

It reviews the diff of the **current git repo**, so run it from inside the checkout you're working in.

## Requirements
- **`ZAI_API_KEY`** in the environment (a z.ai API key). Without it the tool exits with a clear error.
- `curl` + `jq` on PATH; `gh` only for `--pr`.
- Optional: `ZAI_ANTHROPIC_URL` to point at a different Anthropic-compatible base (default `https://api.z.ai/api/anthropic`).

## Use it
Run the bundled script from your repo:

```bash
bash .claude/skills/glm-review/glm-review.sh              # review uncommitted changes (git diff HEAD)
bash .claude/skills/glm-review/glm-review.sh --staged     # staged changes
bash .claude/skills/glm-review/glm-review.sh --base main  # main...HEAD (your feature branch)
bash .claude/skills/glm-review/glm-review.sh --pr 2310    # a GitHub PR (needs gh)
bash .claude/skills/glm-review/glm-review.sh --model glm-5.2   # pick a model (default: glm-4.6)
bash .claude/skills/glm-review/glm-review.sh --json       # raw API JSON instead of just the text
```

It prints GLM's review — concrete bugs, security issues, missed edge-cases/callers, and clear
simplifications, most-severe first with `file:line` + a one-line fix (or "no blocking issues").

## How to use the result
Treat it as a **second opinion, not a verdict**: verify each point against the code before acting.
It pairs well with a primary review (e.g. the host's own `/code-review`) — run both and reconcile.
The gateway still governs any change you make as a result; this skill only reads a diff and calls an API.
