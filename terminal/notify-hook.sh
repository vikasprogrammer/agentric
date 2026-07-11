#!/usr/bin/env bash
# Claude Code Notification hook — surfaces "Claude needs you" events into the Agent OS inbox as a
# per-session bell. Fires when claude is blocked waiting on the human: a permission prompt in the TUI
# (notification_type=permission_prompt), idle waiting for input (idle_prompt), or agent_needs_input.
# Dumb transport, like
# gate-hook.sh: read the event, ship {kind, message} to the server, which posts the inbox card and
# filters out the noise kinds. The Notification hook CANNOT block, so this is best-effort / fail-open —
# a transport failure must never wedge the session.
#
# Env: AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

# Build the loopback payload from the event in one node pass (no tab-splitting — message is free text).
payload=$(printf '%s' "$EVENT" | SESSION="$SESSION" AGENT="$AGENT" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");console.log(JSON.stringify({sessionId:process.env.SESSION,agent:process.env.AGENT,kind:e.notification_type||"",message:e.message||""}))})') || exit 0

curl -s --max-time 10 -X POST "$AOS_URL/api/notify" -H 'content-type: application/json' \
  -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" -d "$payload" >/dev/null 2>&1 || true
exit 0
