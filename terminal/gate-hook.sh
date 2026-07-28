#!/usr/bin/env bash
# PreToolUse hook — the AUTHENTIC path. Shared by every coding runtime.
#
# Wire this in a session's runtime config (Claude Code: `.claude/aos-settings.json`, written by
# claude-launch.sh; Codex: `$CODEX_HOME/hooks.json`, written by codex-launch.sh) so a REAL agent
# running in tmux is governed by Agent OS: before every tool call, the CLI runs this hook. The server
# decides: allow / ask (create an inbox approval and BLOCK here until a human decides) / never
# (denied outright).
#
# MULTI-RUNTIME: $AOS_RUNTIME (`claude-code` | `codex`, default `claude-code`) selects the
# tool→capability routing table below. Everything else — the fail-closed gate call, the approval
# wait, the decision wire — is identical, because Codex 0.145 uses the same PreToolUse stdin fields
# (`tool_name`/`tool_input`/`agent_type`) and the same `permissionDecision` allow|deny|ask +
# `additionalContext` output wire as Claude Code (verified against the schema embedded in the codex
# binary). One file on purpose: a governance fix must never land for one runtime and miss the other.
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
# Env: AOS_URL, SESSION, AGENT, AOS_RUNTIME  (exported when the session is launched)
set -u
EVENT=$(cat)

# Emit an authoritative PreToolUse decision and exit 0. $1 = allow|deny, $2 = reason (shown to Claude).
emit() {
  node -e 'const[d,r]=process.argv.slice(1);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:d,permissionDecisionReason:r}}))' "$1" "$2"
  exit 0
}

# Emit an ALLOW that also injects an advisory note into the model's next context — the `instruct` verb
# (phase 3). `additionalContext` is the ONE PreToolUse field verified to reach the model on an allow
# (docs/decision-brief-layer-plan.md §8a); permissionDecisionReason on allow is audit-only. $1 = reason,
# $2 = note. Used for a reliability nudge (e.g. a detected loop) — soft; the model may ignore it.
emit_allow_note() {
  node -e 'const[r,c]=process.argv.slice(1);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:r,additionalContext:c}}))' "$1" "$2"
  exit 0
}

# This hook is now DUMB TRANSPORT (governance PR #2): it only routes the tool to a capability and ships
# the FULL tool_input to the server, which enriches it into facts (case-insensitive, argument-aware —
# it sees the SQL inside db_query/execute_php, the dollar amount, the delete count) and classifies.
# Tab-separated so the JSON input survives `read` on one line (JSON.stringify escapes tabs/newlines).
# `agent_type`/`agent_id` are present ONLY when this tool call comes from a native sub-agent (the
# Agent/Task tool). We forward them so the server can attribute the governed effect to which sub-agent
# produced it. The fields are separated by U+001F (unit separator), NOT a tab: a tab is IFS-whitespace,
# so `read` would COLLAPSE the empty agent_type/agent_id fields of a normal top-level call and shove the
# JSON into the wrong variable. U+001F is non-whitespace (no collapsing, empty fields preserved) and can
# never appear literally in INPUT because JSON.stringify escapes all control chars < 0x20.
IFS=$'\x1f' read -r TOOL SUBTYPE SUBID INPUT <<<"$(printf '%s' "$EVENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const e=JSON.parse(d||"{}");const S="\x1f";process.stdout.write([e.tool_name||"",e.agent_type||"",e.agent_id||"",JSON.stringify(e.tool_input||{})].join(S))})')"

# The OS-owned tools (memory recall/remember, ask/report, policy preview) are internal and never
# touch the outside world, so they bypass the gate entirely. Claude namespaces MCP tools
# `mcp__<server>__<tool>`; Codex may present the bare `<server>__<tool>` — accept both spellings so the
# OS's own server is never gated under either runtime.
case "$TOOL" in
  mcp__agentos__*|agentos__*) exit 0 ;;
esac

# Route the tool to an Agent OS capability (structural — the only thing the hook still decides). All
# riskiness/destructiveness classification now happens server-side in the enricher + policy.
#
# ONE table for every runtime, because the tool names are the SAME. Verified empirically against codex
# 0.145: its PreToolUse emits `Bash`, `apply_patch` and `mcp__<server>__<tool>` — Claude Code's exact
# spellings, not the `shell`/`local_shell` names its internal protocol uses. An earlier codex-specific
# table keyed on `shell` therefore matched NOTHING and every shell command fell through to the
# allow-by-default arm, ungoverned. Keeping one table makes that class of bug impossible: a runtime whose
# names diverge fails loudly at the `*)` arm rather than silently allowing.
case "$TOOL" in
  Bash|shell|local_shell|exec_command|unified_exec) CAP="shell.exec" ;;
  # File writes go through the gateway too (the enricher decides inside-vs-outside the agent's folder
  # from the path in tool_input). The hook stays dumb transport — it only names the capability.
  # `apply_patch` is Codex's editor tool and DOES fire PreToolUse (verified), so writes are gated there
  # as well as contained by the sandbox.
  Edit|Write|MultiEdit|NotebookEdit|apply_patch) CAP="file.write" ;;
  mcp__composio-company__*INITIATE_CONNECTION*|*INITIATE_CONNECTION*)
    # INITIATE_CONNECTION starts an OAuth grant that gives the whole fleet access to an app — the actual
    # privilege-bearing op, so it's an owner/admin call (connector.connect).
    CAP="connector.connect" ;;
  # MANAGE_CONNECTIONS is a management/STATUS tool — in practice agents call it to LIST/check connections
  # (`{toolkits:["gmail"]}`), a benign read that was needlessly owner-gated. Route it to connector.call
  # (allowed) like any other connector tool; a real grant goes through INITIATE_CONNECTION above.
  mcp__*) CAP="connector.call" ;;
  *) exit 0 ;;  # any other built-in tool (Read/Glob/Grep/…) isn't a world side effect → allow
esac

payload=$(node -e 'const[s,a,cap,t,inp,st,si]=process.argv.slice(1);let input={};try{input=JSON.parse(inp||"{}")}catch(e){};const o={sessionId:s,agent:a,capability:cap,args:{tool:t,input},reasoning:(process.env.AOS_RUNTIME||"claude-code")+" PreToolUse: "+t};if(st){o.subagentType=st;if(si)o.subagentId=si;}console.log(JSON.stringify(o))' "$SESSION" "$AGENT" "$CAP" "$TOOL" "$INPUT" "$SUBTYPE" "$SUBID")

# FAIL-CLOSED classify. Retry the gate until it returns a usable decision; a transient failure (server
# restart, network blip, the documented stale-server 401/404 window) must NEVER fall through to "allow".
# The agent simply waits here, ungoverned action impossible, until the gate answers.
while :; do
  resp=$(curl -s --max-time 10 -X POST "$AOS_URL/api/gate" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" -d "$payload")
  dec=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.decision||"")})')
  gid=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.gateId||"")})')
  # An `instruct`: the gate allowed the effect but attached an advisory note (e.g. a detected loop).
  note=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");process.stdout.write(o.note||"")})')
  case "$dec" in
    allow) if [ -n "$note" ]; then emit_allow_note "Agent OS: allowed by policy." "$note"; else emit allow "Agent OS: allowed by policy."; fi ;;
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
