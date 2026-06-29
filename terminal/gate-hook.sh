#!/usr/bin/env bash
# Claude Code PreToolUse hook — the AUTHENTIC path.
#
# Wire this in a session's settings.json (see terminal/claude-settings.json) so a REAL
# `claude` agent running in tmux is governed by Agent OS: before every tool call, Claude
# runs this hook. The server decides: allow → exit 0; ask → create an inbox approval and
# BLOCK here until a human decides (then exit 0/2); never → exit 2 (denied outright).
#
# Contract: PreToolUse hook reads a JSON event on stdin; exit 0 lets the tool run, exit 2
# blocks it (reason on stderr is shown to Claude).
#
# Env: AOS_URL, SESSION, AGENT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

# This hook is now DUMB TRANSPORT (governance PR #2): it only routes the tool to a capability and ships
# the FULL tool_input to the server, which enriches it into facts (case-insensitive, argument-aware —
# it sees the SQL inside db_query/execute_php, the dollar amount, the delete count) and classifies.
# Tab-separated so the JSON input survives `read` on one line (JSON.stringify escapes tabs/newlines).
IFS=$'\t' read -r TOOL INPUT <<<"$(printf '%s' "$EVENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");process.stdout.write((e.tool_name||"")+"\t"+JSON.stringify(e.tool_input||{}))})')"

# The OS-owned tools (memory recall/remember, ask/report, policy preview) are internal and never
# touch the outside world, so they bypass the gate entirely.
case "$TOOL" in
  mcp__agentos__*) exit 0 ;;
esac

# Route the tool to an Agent OS capability (structural — the only thing the hook still decides). All
# riskiness/destructiveness classification now happens server-side in the enricher + policy.
case "$TOOL" in
  Bash) CAP="shell.exec" ;;
  mcp__composio-company__*MANAGE_CONNECTION*|mcp__composio-company__*INITIATE_CONNECTION*)
    # Managing a COMPANY-wide connection grants the whole fleet access to an app — an owner/admin call.
    CAP="connector.connect" ;;
  mcp__*) CAP="connector.call" ;;
  *) exit 0 ;;  # any other built-in tool (Read/Glob/Grep/…) isn't a world side effect → allow
esac

payload=$(node -e 'const[s,a,cap,t,inp]=process.argv.slice(1);let input={};try{input=JSON.parse(inp||"{}")}catch(e){};console.log(JSON.stringify({sessionId:s,agent:a,capability:cap,args:{tool:t,input},reasoning:"claude PreToolUse: "+t}))' "$SESSION" "$AGENT" "$CAP" "$TOOL" "$INPUT")

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
