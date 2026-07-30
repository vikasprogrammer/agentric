#!/usr/bin/env bash
# glm-review.sh — thin alias for the provider-agnostic `code-review` skill, pinned to z.ai's GLM.
#
# Kept for backwards compatibility: it forwards all args (--staged / --base / --pr / --model / --json)
# to code-review.sh with z.ai's Anthropic-compatible endpoint as the provider — i.e. the exact default
# code-review already ships. New work should call code-review.sh directly and configure the provider
# via REVIEW_BASE_URL / REVIEW_MODEL / REVIEW_API_KEY.
#
# Requires: $ZAI_API_KEY in the environment; curl + jq; gh only for --pr.
# Optional: $ZAI_ANTHROPIC_URL to point at a different Anthropic-compatible base.
set -euo pipefail

: "${ZAI_API_KEY:?set ZAI_API_KEY (z.ai API key) in the environment}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CR="$HERE/../code-review/code-review.sh"
[ -x "$CR" ] || { echo "glm-review: code-review.sh not found at $CR" >&2; exit 3; }

export REVIEW_BASE_URL="${ZAI_ANTHROPIC_URL:-https://api.z.ai/api/anthropic}"
export REVIEW_WIRE="anthropic"
export REVIEW_MODEL="${REVIEW_MODEL:-glm-4.6}"
export REVIEW_API_KEY="$ZAI_API_KEY"

exec "$CR" "$@"
