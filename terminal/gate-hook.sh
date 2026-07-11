#!/usr/bin/env bash
# Claude Code PreToolUse hook — the AUTHENTIC path.
#
# Wire this in a session's settings.json (see terminal/claude-settings.json) so a REAL
# `claude` agent running in tmux is governed by Agent OS: before every tool call, Claude
# runs this hook. The server decides: allow / ask (create an inbox approval and BLOCK here
# until a human decides) / never (denied outright).
#
# Contract (AUTHORITATIVE-DECISION mode): for the capabilities Agent OS governs (Bash,
# connector.*), the hook emits a PreToolUse `permissionDecision` on stdout and exits 0.
# `permissionDecision:"allow"` makes Agent OS the SOLE authority — it BYPASSES Claude Code's
# own permission engine (the `auto`-mode classifier never runs, so there's no second, hidden
# denial layered on top of ours). `"deny"` blocks the call. An approval that's still pending
# blocks the hook synchronously (polling) until a human resolves it, then emits allow/deny —
# so an interactive run is governed identically to one with NO `--dangerously-skip-permissions`
# (there's no prompt to answer; the hook itself is the gate). An UNATTENDED run (automation/cron/task)
# has nobody at the terminal by default, so it waits only a bounded window
# (AOS_UNATTENDED_APPROVAL_WAIT_S, default 180s) and then FAILS CLOSED (deny) — it never falls through
# to allow; the approval stays pending in the inbox for a human to act on and re-run (#138). (A human can
# still "take over" the run and approve within the window — see docs/attachable-sessions-plan.md.)
# Built-in Read/Glob/Grep and the OS-owned mcp__agentos__* tools aren't world side effects, so
# the hook stays silent (bare exit 0) and defers to Claude's normal permission flow — that's
# what keeps the crown-jewel `permissions.deny` Read rules in force for the built-in Read tool.
#
# Env: AOS_URL, SESSION, AGENT  (exported when the claude session is launched)
set -u
EVENT=$(cat)

# Emit an authoritative PreToolUse decision and exit 0. $1 = allow|deny, $2 = reason (shown to Claude).
emit() {
  node -e 'const[d,r]=process.argv.slice(1);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:d,permissionDecisionReason:r}}))' "$1" "$2"
  exit 0
}

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
  # File writes go through the gateway too (the enricher decides inside-vs-outside the agent's folder
  # from the path in tool_input). The hook stays dumb transport — it only names the capability.
  Edit|Write|MultiEdit|NotebookEdit) CAP="file.write" ;;
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
    allow) emit allow "Agent OS: allowed by policy." ;;
    deny)  emit deny "Agent OS policy: denied — this action is blocked (irreversible or not permitted)." ;;
    pending) break ;;
    *) echo "Agent OS: gate unreachable — blocking this action until it responds…" >&2; sleep 2 ;;
  esac
done

echo "Agent OS: this action needs approval — see the inbox. Waiting…" >&2
# Interactive runs wait indefinitely for a human. An UNATTENDED run has nobody at the terminal, so bound
# the wait and FAIL CLOSED (deny) — we only ever stop THIS blocked call, never fall through to allow, and
# the approval row stays pending in the inbox for a human to resolve + re-run.
APPROVAL_WAIT_S="${AOS_UNATTENDED_APPROVAL_WAIT_S:-180}"
waited=0
while :; do
  sleep 1
  st=$(curl -s --max-time 10 "$AOS_URL/api/gate/$gid" -H "x-aos-tenant: ${AOS_TENANT:-}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.status||"")})')
  [ "$st" = "allow" ] && emit allow "Agent OS: approved by human."
  [ "$st" = "deny" ]  && emit deny "Agent OS: rejected by human."
  # any other status (pending / empty / gate momentarily unreachable) → keep waiting, never proceed
  if [ "${UNATTENDED:-}" = "1" ]; then
    waited=$((waited + 1))
    if [ "$waited" -ge "$APPROVAL_WAIT_S" ]; then
      emit deny "Agent OS: no operator approved this within ${APPROVAL_WAIT_S}s on an unattended run — blocked (fail-closed). The approval is still in the inbox; a human can approve and re-run. Wrap up: report what you did and end the run."
    fi
  fi
done
