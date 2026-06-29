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

# Classify the attempt into an Agent OS capability + two flags the policy routes on:
#   risky       → mutation that needs human approval (yellow/red)
#   destructive → IRREVERSIBLE op that the never-tier denies outright (drop db, delete site, rm -rf…)
# Matching is case-INSENSITIVE (SQL/flags are written in any case): `drop database` must catch `DROP`.
# NOTE: we only see the Bash command string and the MCP tool NAME here — not MCP call arguments, so
# destructive SQL passed *inside* a tool like db_query/execute_php is not yet caught. That argument-aware
# classification is the server-side enricher (governance PR #2); this hook is the first, name/command cut.
RISKY=false
DESTRUCTIVE=false
shopt -s nocasematch 2>/dev/null || true
case "$TOOL" in
  Bash)
    CAP="shell.exec"
    case "$CMD" in
      *"drop database"*|*"drop table"*|*"drop schema"*|*truncate*|*"rm -rf"*|*"rm -fr"*|*"rm -r "*|*mkfs*|*"dd if="*|*"dd of="*|*"terraform destroy"*|*"kubectl delete"*|*"git push --force"*|*"git push -f"*) DESTRUCTIVE=true ;;
    esac
    case "$CMD" in
      *stripe*|*refund*|*" rm "*|*deploy*|*prod*|*drop*|*delete*|*kubectl*|*systemctl*|*shutdown*) RISKY=true ;;
    esac
    ;;
  mcp__*)
    # A connector tool (Slack / GitHub / Composio / …). We can't see inside the call, so we classify
    # by the tool NAME: mutation verbs (create/send/update/delete/…) are writes → need approval; the
    # rest (get/list/search/read/…) are reads → auto-allow. Composio names tools like SLACK_SEND_MESSAGE.
    CAP="connector.call"
    UPPER=$(printf '%s' "$TOOL" | tr '[:lower:]' '[:upper:]')
    # Irreversible by name: deleting a whole site or dropping a database → never tier.
    case "$UPPER" in
      *DELETE_SITE*|*DROP_DATABASE*|*DROP_TABLE*|*DROP_SCHEMA*) DESTRUCTIVE=true ;;
    esac
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
shopt -u nocasematch 2>/dev/null || true

payload=$(node -e 'const[s,a,cap,t,c,r,d]=process.argv.slice(1);console.log(JSON.stringify({sessionId:s,agent:a,capability:cap,args:{tool:t,command:c,risky:r==="true",destructive:d==="true"},reasoning:"claude PreToolUse: "+t+(c?" "+c:"")}))' "$SESSION" "$AGENT" "$CAP" "$TOOL" "$CMD" "$RISKY" "$DESTRUCTIVE")

# FAIL-CLOSED classify. Retry the gate until it returns a usable decision; a transient failure (server
# restart, network blip, the documented stale-server 401/404 window) must NEVER fall through to "allow".
# The agent simply waits here, ungoverned action impossible, until the gate answers.
while :; do
  resp=$(curl -s --max-time 10 -X POST "$AOS_URL/api/gate" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" -d "$payload")
  dec=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.decision||"")})')
  gid=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.gateId||"")})')
  case "$dec" in
    allow) exit 0 ;;
    deny)  echo "Agent OS policy: denied — this action is blocked (irreversible or not permitted)." >&2; exit 2 ;;
    pending) break ;;
    *) echo "Agent OS: gate unreachable — blocking this action until it responds…" >&2; sleep 2 ;;
  esac
done

echo "Agent OS: this action needs approval — see the inbox. Waiting…" >&2
while :; do
  sleep 1
  st=$(curl -s --max-time 10 "$AOS_URL/api/gate/$gid" -H "x-aos-tenant: ${AOS_TENANT:-}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.status||"")})')
  [ "$st" = "allow" ] && exit 0
  [ "$st" = "deny" ]  && { echo "Agent OS: rejected by human." >&2; exit 2; }
  # any other status (pending / empty / gate momentarily unreachable) → keep waiting, never proceed
done
