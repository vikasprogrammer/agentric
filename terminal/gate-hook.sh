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

# Decide riskiness of a Bash command by simple pattern (extend as needed).
RISKY=false
case " $CMD " in
  *stripe*|*refund*|*" rm "*|*deploy*|*prod*|*DROP*|*DELETE*|*kubectl*|*systemctl*|*shutdown*) RISKY=true ;;
esac
[ "$TOOL" != "Bash" ] && RISKY=false   # only gate shell in this demo; everything else allowed

resp=$(curl -s -X POST "$AOS_URL/api/gate" -H 'content-type: application/json' \
  -d "$(node -e 'const[s,a,t,c,r]=process.argv.slice(1);console.log(JSON.stringify({sessionId:s,agent:a,capability:"shell.exec",args:{tool:t,command:c,risky:r==="true"},reasoning:"claude PreToolUse: "+c}))' "$SESSION" "$AGENT" "$TOOL" "$CMD" "$RISKY")")
gid=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.gateId||"")})')
dec=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.decision||"")})')

case "$dec" in
  allow) exit 0 ;;
  deny)  echo "Agent OS policy: denied." >&2; exit 2 ;;
  pending)
    echo "Agent OS: this action needs approval — see the inbox. Waiting…" >&2
    while :; do
      sleep 1
      st=$(curl -s "$AOS_URL/api/gate/$gid" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.status||"")})')
      [ "$st" = "allow" ] && exit 0
      [ "$st" = "deny" ]  && { echo "Agent OS: rejected by human." >&2; exit 2; }
    done ;;
  *) exit 0 ;;  # fail-open in demo; flip to exit 2 to fail-closed
esac
