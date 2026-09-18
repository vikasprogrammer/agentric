#!/usr/bin/env bash
# Cursor Agent gate hook — maps Cursor project hooks → Agentric /api/gate.
#
# Wired from `.cursor/hooks.json` as beforeShellExecution / beforeMCPExecution / preToolUse.
# Cursor feeds JSON on stdin (includes hook_event_name) and expects:
#   { "permission": "allow"|"deny"|"ask", "agent_message"?: "...", "user_message"?: "..." }
# Exit 2 also denies. We set failClosed:true on the hook definitions so crashes never fail-open.
#
# Env (from cursor-launch.sh / the session): AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT, UNATTENDED
set -u
EVENT=$(cat)

emit() {
  # $1 = allow|deny  $2 = message for the agent
  node -e 'const[p,m]=process.argv.slice(1);console.log(JSON.stringify({permission:p,agent_message:m||undefined,user_message:m||undefined}))' "$1" "$2"
  exit 0
}

# Parse Cursor hook payload → capability + tool label + args JSON.
parsed=$(printf '%s' "$EVENT" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let e={}; try{e=JSON.parse(d||"{}")}catch(_){}
    const ev=String(e.hook_event_name||"");
    let cap="", tool="", input={};
    if(ev==="beforeShellExecution"){
      cap="shell.exec";
      tool="Shell";
      input={command:e.command||"", cwd:e.cwd||""};
    } else if(ev==="beforeMCPExecution"){
      const server=String(e.mcp_server_name||"");
      const name=String(e.tool_name||"");
      // Agentric loopback MCP — internal, never a world side-effect.
      if(server==="agentos" || /^agentos$/i.test(server)){ console.log(["SKIP","","{}"].join("\x1f")); return; }
      cap="connector.call";
      tool="mcp__"+server+"__"+name;
      let tin=e.tool_input;
      if(typeof tin==="string"){ try{tin=JSON.parse(tin)}catch(_){tin={raw:tin}} }
      input=tin&&typeof tin==="object"?tin:{};
      input.mcp_server_name=server;
    } else if(ev==="preToolUse"){
      const name=String(e.tool_name||"");
      const tin=(e.tool_input&&typeof e.tool_input==="object")?e.tool_input:{};
      if(name==="Shell"||name==="shell"){ cap="shell.exec"; tool="Shell"; input=tin; }
      else if(name==="Write"||name==="Delete"||name==="Edit"||name==="StrReplace"){ cap="file.write"; tool=name; input=tin; }
      else if(name.startsWith("MCP:")||name.startsWith("mcp__")){
        if(/agentos/i.test(name)){ console.log(["SKIP","","{}"].join("\x1f")); return; }
        cap="connector.call"; tool=name; input=tin;
      } else {
        // Read/Grep/etc. — not world side effects for the gate.
        console.log(["SKIP","","{}"].join("\x1f")); return;
      }
    } else {
      console.log(["SKIP","","{}"].join("\x1f")); return;
    }
    console.log([cap, tool, JSON.stringify(input)].join("\x1f"));
  });
')

IFS=$'\x1f' read -r CAP TOOL INPUT <<<"$parsed"
[ "$CAP" = "SKIP" ] || [ -z "$CAP" ] && exit 0

payload=$(node -e 'const[s,a,cap,t,inp]=process.argv.slice(1);let input={};try{input=JSON.parse(inp||"{}")}catch(e){};console.log(JSON.stringify({sessionId:s,agent:a,capability:cap,args:{tool:t,input},reasoning:"cursor "+cap+": "+t}))' \
  "$SESSION" "$AGENT" "$CAP" "$TOOL" "$INPUT")

while :; do
  resp=$(curl -s --max-time 10 -X POST "$AOS_URL/api/gate" \
    -H 'content-type: application/json' \
    -H "x-aos-secret: ${AOS_SECRET:-}" \
    -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$payload")
  dec=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.decision||"")})')
  gid=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.gateId||"")})')
  reason=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");process.stdout.write(o.reason||"")})')
  dcap=$(printf '%s' "$resp" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");process.stdout.write(o.capability||"")})')
  case "$dec" in
    allow) emit allow "Agentric: allowed by policy." ;;
    deny)
      msg="Agentric policy: denied"
      [ -n "$dcap" ] && msg="$msg [$dcap]"
      [ -n "$reason" ] && msg="$msg — $reason"
      emit deny "$msg"
      ;;
    pending) break ;;
    *) echo "Agentric: gate unreachable — blocking until it responds…" >&2; sleep 2 ;;
  esac
done

echo "Agentric: this action needs approval — see the inbox. Waiting…" >&2
APPROVAL_WAIT_S="${AOS_UNATTENDED_APPROVAL_WAIT_S:-180}"
waited=0
while :; do
  sleep 1
  st=$(curl -s --max-time 10 "$AOS_URL/api/gate/$gid" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");console.log(o.status||"")})')
  [ "$st" = "allow" ] && emit allow "Agentric: approved by human."
  [ "$st" = "deny" ]  && emit deny "Agentric: rejected by human."
  if [ "${UNATTENDED:-}" = "1" ]; then
    waited=$((waited + 1))
    if [ "$waited" -ge "$APPROVAL_WAIT_S" ]; then
      emit deny "Agentric: no operator approved within ${APPROVAL_WAIT_S}s on an unattended run — blocked (fail-closed)."
    fi
  fi
done
