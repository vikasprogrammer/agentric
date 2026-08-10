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
# Dumb transport, like gate-hook.sh / notify-hook.sh: none of these events may block or wedge a turn, so
# every path is best-effort and always exits 0.
#
# Env: AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

# One node pass builds the loopback payload — the fields are free text, so no shell splitting.
payload=$(printf '%s' "$EVENT" | SESSION="$SESSION" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");console.log(JSON.stringify({session:process.env.SESSION,event:e.hook_event_name||"",reason:e.reason||"",errorType:e.error_type||""}))})') || exit 0

curl -s --max-time 10 -X POST "$AOS_URL/api/session-event" -H 'content-type: application/json' \
  -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" -d "$payload" >/dev/null 2>&1 || true
exit 0
