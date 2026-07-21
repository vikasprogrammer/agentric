#!/usr/bin/env bash
# glm-review.sh — a fast, one-shot CROSS-MODEL code review using z.ai's GLM models
# (via their Anthropic-compatible API). An independent second opinion alongside your
# primary reviewer. Reviews a diff from the CURRENT git repo — run it from inside the
# checkout you're working in.
#
# Requires: $ZAI_API_KEY in the environment (z.ai API key); `curl` + `jq`; `gh` only for --pr.
#
# Usage:
#   glm-review.sh                  # review uncommitted changes (git diff HEAD)
#   glm-review.sh --staged         # review staged changes
#   glm-review.sh --base <branch>  # review <branch>...HEAD (e.g. your feature branch vs main)
#   glm-review.sh --pr <N>         # review a GitHub PR (needs gh)
#   glm-review.sh --model <name>   # override model (default: glm-4.6; e.g. glm-5.2, glm-4.7)
#   glm-review.sh --json           # print the raw API JSON instead of just the review text
set -euo pipefail

MODEL="glm-4.6"; MODE="uncommitted"; BASE=""; PR=""; JSON=0
ENDPOINT="${ZAI_ANTHROPIC_URL:-https://api.z.ai/api/anthropic}/v1/messages"
while [ $# -gt 0 ]; do
  case "$1" in
    --staged)  MODE="staged"; shift ;;
    --base)    MODE="base"; BASE="${2:?--base needs a branch}"; shift 2 ;;
    --pr)      MODE="pr"; PR="${2:?--pr needs a number}"; shift 2 ;;
    --model)   MODEL="${2:?--model needs a name}"; shift 2 ;;
    --json)    JSON=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
done

: "${ZAI_API_KEY:?set ZAI_API_KEY (z.ai API key) in the environment}"
command -v jq   >/dev/null || { echo "glm-review needs jq" >&2; exit 3; }
command -v curl >/dev/null || { echo "glm-review needs curl" >&2; exit 3; }

case "$MODE" in
  uncommitted) DIFF="$(git diff HEAD)" ;;
  staged)      DIFF="$(git diff --staged)" ;;
  base)        DIFF="$(git diff "${BASE}...HEAD")" ;;
  pr)          command -v gh >/dev/null || { echo "glm-review --pr needs gh" >&2; exit 3; }
               DIFF="$(gh pr diff "$PR")" ;;
esac

# Nothing to review?
if [ -z "${DIFF//[$'\t\r\n ']}" ]; then echo "glm-review: no diff to review (mode=$MODE)"; exit 0; fi
# Cap the diff so a huge changeset still fits the request.
DIFF="$(printf '%s' "$DIFF" | head -c 120000)"

SYS='You are a senior code reviewer giving a fast, cross-model second opinion. Review ONLY the provided diff. Report concrete correctness bugs, security issues, missed edge cases / callers, and clear simplifications — most-severe first, each with a file:line and a one-line fix. Be terse; skip praise. If the diff is clean, say "no blocking issues".'

REQ="$(jq -n --arg m "$MODEL" --arg s "$SYS" --arg d "Review this diff:"$'\n\n'"$DIFF" \
  '{model:$m, max_tokens:2048, system:$s, messages:[{role:"user", content:$d}]}')"

RESP="$(curl -sS --max-time 180 "$ENDPOINT" \
  -H "x-api-key: ${ZAI_API_KEY}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d "$REQ")"

if [ "$JSON" = 1 ]; then echo "$RESP"; exit 0; fi
echo "── GLM review (${MODEL}) ─────────────────────────────────────────"
echo "$RESP" | jq -r '.content[0].text // .error.message // ("unexpected response: " + (.|tostring))'
