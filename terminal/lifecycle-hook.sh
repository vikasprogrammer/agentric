#!/usr/bin/env bash
# Claude Code LIFECYCLE hook — the turn/session state machine the console's status vocabulary runs on.
#
# One script wired to three events (claude passes the event in the payload's `hook_event_name`, so a
# single hook can serve all of them):
#
#   UserPromptSubmit  → a turn is STARTING (fires before claude processes the prompt). This is the signal
#                       Agentric never had: `busy_since` was only stamped when the SERVER delivered a
#                       message, so a human typing straight into an attached TUI ran a whole turn that
#                       the console couldn't see, and the row's `busy_since` — set once at spawn — was
#                       never renewed or cleared. That latch is why a finished session showed "working"
#                       forever.
#   StopFailure       → the turn ended because the API errored (rate_limit / overloaded / server_error /
#                       …). NO `Stop` fires in that case, so without this the turn never ends as far as
#                       the server is concerned: the pane spins, the pile-up guard stays held, and an
#                       unattended run parks as a zombie until a 24h reaper catches it. `error_type`
#                       rides along so the audit trail says WHY.
#   SessionEnd        → the session itself is over, with a `reason` claude tells us (`prompt_input_exit`
#                       = the human quit the TUI, `logout`, `clear`, `resume`, `compact`, `other`). We
#                       forward the reason verbatim; the server decides which reasons are terminal (a
#                       `/clear` or a compaction is NOT the end of a run).
#
# `Stop` (the plain turn-end) keeps its own dedicated hook — stop-hook.sh — because it carries the
# unattended teardown decision, and codex-launch.sh wires that one too.
#
# Dumb transport, like gate-hook.sh / notify-hook.sh: none of these events may wedge a turn, so every
# path is best-effort and always exits 0. The ONE thing it may do is HOLD a UserPromptSubmit: the prompt
# rides along, and when the server answers `{ hold: "<why>" }` (a human pasted a credential — see
# src/governance/prompt-secrets.ts) the hook prints claude's `decision: block`, so the text never reaches
# the model and the human sees why. Any failure (server down, bad JSON) lets the prompt through. When the
# server answers `{ context: "…" }` (the turn was sent by someone other than the run-as member — see
# TerminalManager.attributeTurn) it is handed to claude as `additionalContext` for that turn.
#
# Env: AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

# One node pass builds the loopback payload — the fields are free text, so no shell splitting. The prompt
# is only forwarded for UserPromptSubmit (the one event that can be held).
payload=$(printf '%s' "$EVENT" | SESSION="$SESSION" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");const ev=e.hook_event_name||"";const o={session:process.env.SESSION,event:ev,reason:e.reason||"",errorType:e.error_type||""};if(ev==="UserPromptSubmit"&&typeof e.prompt==="string")o.prompt=e.prompt;console.log(JSON.stringify(o))})') || exit 0

# Body on stdin, not argv: a pasted prompt can be far larger than an argument may be.
resp=$(printf '%s' "$payload" | curl -s --max-time 10 -X POST "$AOS_URL/api/session-event" -H 'content-type: application/json' \
  -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" --data-binary @- 2>/dev/null) || exit 0

case "$resp" in
  *'"hold"'*|*'"context"'*)
    printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);if(typeof r.hold==="string"&&r.hold)process.stdout.write(JSON.stringify({decision:"block",reason:r.hold}));else if(typeof r.context==="string"&&r.context)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:r.context}}))}catch{}})' 2>/dev/null || true
    ;;
esac
exit 0
