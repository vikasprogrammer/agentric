#!/usr/bin/env bash
# Claude Code PreToolUse hook — the AUTHENTIC path.
#
# Wire this in a session's settings.json (see terminal/claude-settings.json) so a REAL
# `claude` agent running in tmux is governed by Agent OS: before every tool call, Claude
# runs this hook. We classify the call; green → exit 0 (allow); risky → create an inbox
# approval and BLOCK here until a human decides, then exit 0 (allow) or 2 (deny).
#
# Contract: PreToolUse hook reads a JSON event on stdin; exit 0 lets the tool run, exit 2
# blocks it (reason on stderr is shown to Claude).
#
# Env: AOS_URL, SESSION, AGENT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

read -r TOOL CMD <<<"$(printf '%s' "$EVENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");const t=e.tool_name||"";const i=e.tool_input||{};const cmd=(i.command||i.file_path||i.url||"").toString().replace(/\s+/g," ");console.log(t+" "+cmd)})')"

# The OS-owned tools (memory recall/remember, ask/report, policy preview) are internal and never
# touch the outside world, so they bypass the gate entirely.
case "$TOOL" in
  mcp__agentos__*) exit 0 ;;
esac

# Classify the attempt into an Agent OS capability + a riskiness flag the policy routes on.
RISKY=false
case "$TOOL" in
  Bash)
    CAP="shell.exec"
    case " $CMD " in
      *stripe*|*refund*|*" rm "*|*deploy*|*prod*|*DROP*|*DELETE*|*kubectl*|*systemctl*|*shutdown*) RISKY=true ;;
    esac
    ;;
  mcp__*)
    # A connector tool (Slack / GitHub / Composio / …). We can't see inside the call, so we classify
    # by the tool NAME: mutation verbs (create/send/update/delete/…) are writes → need approval; the
    # rest (get/list/search/read/…) are reads → auto-allow. Composio names tools like SLACK_SEND_MESSAGE.
    CAP="connector.call"
    UPPER=$(printf '%s' "$TOOL" | tr '[:lower:]' '[:upper:]')
    case "$UPPER" in
      *CREATE*|*SEND*|*UPDATE*|*DELETE*|*REMOVE*|*WRITE*|*POST*|*PUT*|*PATCH*|*MERGE*|*PUBLISH*|*UPLOAD*|*DEPLOY*|*PAY*|*REFUND*|*ARCHIVE*|*INVITE*|*EXECUTE*) RISKY=true ;;
    esac
    # Managing/reconnecting a COMPANY-wide connection (the composio-company entity) grants the whole
    # fleet access to an app — an owner/admin decision. Route it to approval so a non-admin's agent
    # run can't silently wire or replace company-wide access. (Personal-entity connects stay as-is.)
    case "$TOOL" in
      mcp__composio-company__*MANAGE_CONNECTION*|mcp__composio-company__*INITIATE_CONNECTION*) CAP="connector.connect"; RISKY=true ;;
    esac
    ;;
  *) exit 0 ;;  # any other built-in tool (Read/Glob/Grep/…) isn't a world side effect → allow
esac

resp=$(curl -s -X POST "$AOS_URL/api/gate" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
  -d "$(node -e 'const[s,a,cap,t,c,r]=process.argv.slice(1);console.log(JSON.stringify({sessionId:s,agent:a,capability:cap,args:{tool:t,command:c,risky:r==="true"},reasoning:"claude PreToolUse: "+t+(c?" "+c:"")}))' "$SESSION" "$AGENT" "$CAP" "$TOOL" "$CMD" "$RISKY")")
gid=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.gateId||"")})')
dec=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.decision||"")})')

case "$dec" in
  allow) exit 0 ;;
  deny)  echo "Agent OS policy: denied." >&2; exit 2 ;;
  pending)
    echo "Agent OS: this action needs approval — see the inbox. Waiting…" >&2
    while :; do
      sleep 1
      st=$(curl -s "$AOS_URL/api/gate/$gid" -H "x-aos-tenant: ${AOS_TENANT:-}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.status||"")})')
      [ "$st" = "allow" ] && exit 0
      [ "$st" = "deny" ]  && { echo "Agent OS: rejected by human." >&2; exit 2; }
    done ;;
  *) exit 0 ;;  # fail-open in demo; flip to exit 2 to fail-closed
esac
