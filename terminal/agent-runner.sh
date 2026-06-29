#!/usr/bin/env bash
# Agent runner — a scripted "agent" that runs INSIDE a tmux session (a real terminal you
# can attach to). Every side effect goes through the Agent OS gateway via /api/gate, so
# even though this is a raw shell, risky actions pause and surface as an inbox approval.
#
# Env (set by the server when it spawns the tmux session):
#   AOS_URL   base url of the agent-os server   (e.g. http://127.0.0.1:3010)
#   SESSION   session id
#   AGENT     agent name
#   TASK_B64  base64-encoded task text
set -u
TASK=$(printf '%s' "${TASK_B64:-}" | base64 -d 2>/dev/null)

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

jsonget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const o=JSON.parse(d);console.log(o["'"$1"'"]??"")}catch{console.log("")}})'; }

say() { # post an update message to the inbox
  curl -s -X POST "$AOS_URL/api/sessions/$SESSION/say" -H 'content-type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({body:process.argv[1]}))' "$1")" >/dev/null 2>&1
}

# gate <capability> <args-json> <reasoning>  → 0 allowed, 1 blocked
gate() {
  local cap="$1" args="$2" reason="$3"
  dim "   → requesting: $cap $args"
  local resp; resp=$(curl -s -X POST "$AOS_URL/api/gate" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" \
    -d "$(node -e 'const[c,a,r,s,ag]=process.argv.slice(1);console.log(JSON.stringify({sessionId:s,agent:ag,capability:c,args:JSON.parse(a),reasoning:r}))' "$cap" "$args" "$reason" "$SESSION" "$AGENT")")
  local dec gid; dec=$(printf '%s' "$resp" | jsonget decision); gid=$(printf '%s' "$resp" | jsonget gateId)
  case "$dec" in
    allow) ok    "   ✅ $cap — allowed (green); executed"; return 0 ;;
    deny)  red   "   ⛔ $cap — DENIED by policy; not executed"; return 1 ;;
    pending)
      warn "   ⏸  $cap — needs human approval. Card sent to the inbox. Waiting…"
      while :; do
        sleep 1
        local st; st=$(curl -s "$AOS_URL/api/gate/$gid" | jsonget status)
        [ "$st" = "allow" ] && { ok  "   ✅ approved by human; executing $cap"; return 0; }
        [ "$st" = "deny" ]  && { red "   ⛔ rejected by human; skipping $cap"; return 1; }
      done ;;
    *) red "   ⚠ gate error: $resp"; return 1 ;;
  esac
}

clear
cyan "┌─ Agent OS session ──────────────────────────────────────────"
cyan "│ agent:   $AGENT"
cyan "│ session: $SESSION"
cyan "│ task:    $TASK"
cyan "└─────────────────────────────────────────────────────────────"
echo
dim "This is a real tmux shell. Every side effect is gated by Agent OS."
echo

# Scripted flows keyed to the mock agents' manifests (config/agents/<id>/agent.json).
case "$AGENT" in
  example-greeter)
    say "Starting: $TASK"
    echo "Saying hello and posting a status…"; sleep 1
    gate "slack.post"   '{"channel":"#general","text":"hi"}'     "post a status (all green — happy path)"
    say "Task Update: posted."
    ;;
  example-refunder)
    say "Starting: $TASK"
    echo "Small refund first (head approves)…"; sleep 1
    gate "stripe.refund" '{"customer":"cus_1","amountUsd":500}'  "issue a small refund (yellow)"
    echo "Now a large refund (owner approves)…"; sleep 1
    gate "stripe.refund" '{"customer":"cus_2","amountUsd":5000}' "issue a large refund (red)"
    say "Task Update: refunds handled."
    ;;
  refund-desk)
    say "Starting: $TASK"
    gate "stripe.refund" '{"customer":"cus_9","amountUsd":1500}' "issue the requested refund (routes by amount)"
    say "Task Update: refund awaited/handled."
    ;;
  ops)
    say "Starting: $TASK"
    echo "Attempting to restart a production service…"; sleep 1
    gate "prod.restart" '{"service":"api"}'                      "restart production (policy denies prod.*)"
    say "Task Update: blocked by policy."
    ;;
  *)
    say "Starting: $TASK"
    gate "slack.post"   '{"channel":"#general","text":"hi"}'     "post a status"
    gate "stripe.refund" '{"customer":"cus_9","amountUsd":5000}' "issue a large refund"
    say "Task Update: done."
    ;;
esac

echo
ok "Scripted work finished. This pane stays live — attach and type to take over."
exec bash
