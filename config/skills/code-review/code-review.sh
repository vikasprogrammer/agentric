#!/usr/bin/env bash
# code-review.sh — a fast, one-shot CROSS-MODEL code review, provider-agnostic.
#
# An independent second opinion alongside your primary reviewer. Reviews a diff from the
# CURRENT git repo — run it from inside the checkout you're working in. The reviewer
# model/provider is CONFIG, not hardcoded: point it at any OpenAI-compatible API
# (OpenAI, z.ai, local Ollama, …) or any Anthropic-compatible API (Claude, z.ai coding
# plan) with three env vars. It asks the model for STRUCTURED output (verdict + findings)
# and maps the verdict to an exit code, so a caller / CI / pre-push hook can gate on it.
#
# Config (env):
#   REVIEW_BASE_URL  API base. Default: https://api.z.ai/api/anthropic (z.ai GLM).
#                    Examples: https://api.openai.com/v1  ·  http://localhost:11434/v1
#                              https://api.z.ai/api/paas/v4  ·  https://api.anthropic.com
#   REVIEW_MODEL     Model id. Default: glm-4.6  (e.g. gpt-5.1, qwen2.5-coder, claude-…)
#   REVIEW_API_KEY   API key. Falls back to $ZAI_API_KEY, then $OPENAI_API_KEY.
#                    Optional for a keyless local endpoint (e.g. Ollama).
#   REVIEW_WIRE      Wire protocol: openai | anthropic. Default: auto-detected from the
#                    base URL (an /api/anthropic or api.anthropic.com base ⇒ anthropic,
#                    everything else ⇒ openai). Set explicitly to override.
#   REVIEW_MAX_DIFF    Cap the diff at N bytes (default 120000).
#   REVIEW_MAX_TOKENS  Model output cap (default 4096).
#   REVIEW_JSON_MODE   openai wire only: 1 (default) asks for response_format json_object;
#                      set 0 for providers/models that reject it (parser is tolerant either way).
#   REVIEW_FAIL_ON     Verdict that yields a non-zero exit: block (default) | warn | never.
#
# Diff modes:
#   code-review.sh                  # uncommitted changes (git diff HEAD)
#   code-review.sh --staged         # staged changes
#   code-review.sh --base <branch>  # <branch>...HEAD (three-dot; your feature branch)
#   code-review.sh --pr <N>         # a GitHub PR (needs gh)
# Options:
#   code-review.sh --model <name>   # override REVIEW_MODEL for this run
#   code-review.sh --json           # print the normalized structured object, not the human render
#
# Requires: curl + jq; gh only for --pr.
#
# Exit: 0 = pass/warn (or clean), non-zero (2) = the verdict crossed REVIEW_FAIL_ON,
#       3 = missing dependency / usage error, 4 = the API call itself failed.
set -euo pipefail

MODE="uncommitted"; BASE=""; PR=""; JSON=0; MODEL_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --staged)  MODE="staged"; shift ;;
    --base)    MODE="base"; BASE="${2:?--base needs a branch}"; shift 2 ;;
    --pr)      MODE="pr"; PR="${2:?--pr needs a number}"; shift 2 ;;
    --model)   MODEL_OVERRIDE="${2:?--model needs a name}"; shift 2 ;;
    --json)    JSON=1; shift ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 3 ;;
  esac
done

command -v jq   >/dev/null || { echo "code-review needs jq" >&2; exit 3; }
command -v curl >/dev/null || { echo "code-review needs curl" >&2; exit 3; }

# ── Provider config (all overridable via env) ────────────────────────────────
BASE_URL="${REVIEW_BASE_URL:-https://api.z.ai/api/anthropic}"
BASE_URL="${BASE_URL%/}"                                   # trim trailing slash
MODEL="${MODEL_OVERRIDE:-${REVIEW_MODEL:-glm-4.6}}"
API_KEY="${REVIEW_API_KEY:-${ZAI_API_KEY:-${OPENAI_API_KEY:-}}}"
MAX_DIFF="${REVIEW_MAX_DIFF:-120000}"
MAX_TOKENS="${REVIEW_MAX_TOKENS:-4096}"
JSON_MODE="${REVIEW_JSON_MODE:-1}"
FAIL_ON="${REVIEW_FAIL_ON:-block}"

# Auto-detect the wire protocol from the base URL unless pinned.
if [ -n "${REVIEW_WIRE:-}" ]; then
  WIRE="$REVIEW_WIRE"
elif printf '%s' "$BASE_URL" | grep -Eiq '(/api/anthropic|api\.anthropic\.com)'; then
  WIRE="anthropic"
else
  WIRE="openai"
fi

# ── Gather the diff ──────────────────────────────────────────────────────────
case "$MODE" in
  uncommitted) DIFF="$(git diff HEAD)" ;;
  staged)      DIFF="$(git diff --staged)" ;;
  base)        DIFF="$(git diff "${BASE}...HEAD")" ;;
  pr)          command -v gh >/dev/null || { echo "code-review --pr needs gh" >&2; exit 3; }
               DIFF="$(gh pr diff "$PR")" ;;
esac

if [ -z "${DIFF//[$'\t\r\n ']}" ]; then echo "code-review: no diff to review (mode=$MODE)"; exit 0; fi
DIFF="$(printf '%s' "$DIFF" | head -c "$MAX_DIFF")"

# ── Prompts ──────────────────────────────────────────────────────────────────
SYS='You are a senior code reviewer giving a fast, cross-model second opinion on a diff.
Review ONLY the provided diff. Hunt for REAL problems in three areas and nothing else:
  1. Correctness bugs — logic errors, null/undefined, off-by-one, wrong async handling,
     broken/omitted error handling, edge cases, and every CALLER the change affects.
  2. Security — injection, authz/authn gaps, secret/PII exposure, unsafe input, SSRF, path traversal.
  3. Spec/intent adherence and clear simplifications that reduce real risk.
Explicitly DO NOT report style, formatting, naming, import order, or subjective preference —
those keep the signal high. If the diff is clean, return verdict "pass" with an empty findings list.
Respond with a SINGLE JSON object, no prose, no markdown fences, in exactly this shape:
{"verdict":"block|warn|pass",
 "findings":[{"file":"path","line":0,"severity":"blocker|important|nit|question",
              "category":"correctness|security|edge-case|spec|simplification",
              "summary":"one sentence","fix":"one-line concrete fix"}]}
verdict = block if any blocker, warn if any important, else pass. Order findings most-severe first.'

USER="Review this diff:"$'\n\n'"$DIFF"

# ── Call the model ───────────────────────────────────────────────────────────
HTTP=""; RESP=""
if [ "$WIRE" = "anthropic" ]; then
  [ -n "$API_KEY" ] || { echo "code-review: no API key (set REVIEW_API_KEY or ZAI_API_KEY)" >&2; exit 3; }
  REQ="$(jq -n --arg m "$MODEL" --argjson mt "$MAX_TOKENS" --arg s "$SYS" --arg u "$USER" \
    '{model:$m, max_tokens:$mt, temperature:0, system:$s, messages:[{role:"user",content:$u}]}')"
  RESP="$(curl -sS --max-time 180 -w $'\n%{http_code}' "${BASE_URL}/v1/messages" \
    -H "x-api-key: ${API_KEY}" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
    -d "$REQ")" || { echo "code-review: request to ${BASE_URL} failed" >&2; exit 4; }
  HTTP="${RESP##*$'\n'}"; RESP="${RESP%$'\n'*}"
  TEXT="$(printf '%s' "$RESP" | jq -r '.content[0].text // empty' 2>/dev/null)"
  ERR="$(printf '%s' "$RESP" | jq -r '.error.message // empty' 2>/dev/null)"
else
  # OpenAI /v1/chat/completions — the lowest common denominator.
  # A key is required for a hosted provider; a local endpoint (Ollama) needs none.
  case "$BASE_URL" in
    *localhost*|*127.0.0.1*|*0.0.0.0*) : ;;
    *) [ -n "$API_KEY" ] || { echo "code-review: no API key for ${BASE_URL} (set REVIEW_API_KEY/ZAI_API_KEY, or point at a local endpoint)" >&2; exit 3; } ;;
  esac
  RF='{}'; [ "$JSON_MODE" = "1" ] && RF='{"response_format":{"type":"json_object"}}'
  REQ="$(jq -n --arg m "$MODEL" --argjson mt "$MAX_TOKENS" --arg s "$SYS" --arg u "$USER" --argjson rf "$RF" \
    '{model:$m, max_tokens:$mt, temperature:0, messages:[{role:"system",content:$s},{role:"user",content:$u}]} + $rf')"
  AUTH=(); [ -n "$API_KEY" ] && AUTH=(-H "Authorization: Bearer ${API_KEY}")
  RESP="$(curl -sS --max-time 180 -w $'\n%{http_code}' "${BASE_URL}/chat/completions" \
    "${AUTH[@]+"${AUTH[@]}"}" -H "content-type: application/json" -d "$REQ")" \
    || { echo "code-review: request to ${BASE_URL} failed" >&2; exit 4; }
  HTTP="${RESP##*$'\n'}"; RESP="${RESP%$'\n'*}"
  TEXT="$(printf '%s' "$RESP" | jq -r '.choices[0].message.content // empty' 2>/dev/null)"
  ERR="$(printf '%s' "$RESP" | jq -r '.error.message // .error // empty' 2>/dev/null)"
fi

if [ -z "$TEXT" ]; then
  echo "code-review: no review returned from ${MODEL} @ ${BASE_URL} (wire=${WIRE}, http=${HTTP:-?})" >&2
  [ -n "${ERR:-}" ] && echo "  provider error: ${ERR}" >&2
  exit 4
fi

# ── Tolerant parse: accept clean JSON, fenced JSON, or JSON embedded in prose ─
parse_json() {
  local t="$1" out stripped extracted
  if out="$(printf '%s' "$t" | jq -ec . 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
  stripped="$(printf '%s' "$t" | sed 's/```json//g; s/```//g')"
  if out="$(printf '%s' "$stripped" | jq -ec . 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
  # grab from first { to last } even across newlines (RS placeholder = 0x1e)
  extracted="$(printf '%s' "$stripped" | tr '\n' '\036' | sed -n 's/[^{]*\({.*}\)[^}]*/\1/p' | tr '\036' '\n')"
  if out="$(printf '%s' "$extracted" | jq -ec . 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
  return 1
}

if ! PARSED="$(parse_json "$TEXT")"; then
  # Provider didn't give us parseable JSON — don't crash, show what it said.
  echo "── code-review (${MODEL}) — unstructured output, printing raw ──"
  printf '%s\n' "$TEXT"
  exit 0
fi

# Normalize: derive verdict from findings when the model omitted/mismatched it.
NORM="$(printf '%s' "$PARSED" | jq -c '
  { verdict: ( (.verdict // "") as $v |
      if ($v|type)=="string" and ($v|ascii_downcase|test("block|warn|pass"))
      then ($v|ascii_downcase|capture("(?<x>block|warn|pass)").x)
      elif any((.findings // [])[]?; (.severity//"")=="blocker") then "block"
      elif any((.findings // [])[]?; (.severity//"")=="important") then "warn"
      else "pass" end ),
    findings: (.findings // []) }')"

VERDICT="$(printf '%s' "$NORM" | jq -r '.verdict')"

if [ "$JSON" = 1 ]; then
  printf '%s\n' "$NORM"
else
  printf '%s' "$NORM" | jq -r '
    def sevrank: {"blocker":0,"important":1,"nit":2,"question":3}[.] // 4;
    (.findings // []) as $f |
    "── code-review (verdict: " + (.verdict) + ", " + (($f|length)|tostring) + " finding(s)) ──",
    ( if ($f|length)==0 then "  no blocking issues"
      else ($f | sort_by(.severity|sevrank)[] |
        "  " + (.file // "?") + ":" + ((.line // 0)|tostring) + " — " +
        (.severity // "?") + " [" + (.category // "?") + "] " + (.summary // "") +
        (if (.fix // "") != "" then "  Fix: " + .fix else "" end))
      end )'
fi

# ── Verdict → exit code ──────────────────────────────────────────────────────
case "$FAIL_ON" in
  never) exit 0 ;;
  warn)  case "$VERDICT" in block|warn) exit 2 ;; *) exit 0 ;; esac ;;
  *)     case "$VERDICT" in block) exit 2 ;; *) exit 0 ;; esac ;;
esac
