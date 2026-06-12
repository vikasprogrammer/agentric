#!/usr/bin/env bash
# Real-Claude launcher — opens an interactive `claude` session DIRECTLY IN THE AGENT'S FOLDER,
# governed by Agent OS. This is the authentic path: a real agent in a real shell, but every
# Bash tool call passes through the gateway via a PreToolUse hook (risky ones pause for inbox
# approval), so even a fully autonomous claude can't do anything risky un-approved.
#
# Env (exported by the server when it spawns the tmux session):
#   AOS_URL    base url of the agent-os server   (e.g. http://127.0.0.1:3010)
#   SESSION    session id
#   AGENT      agent id (matches the manifest / its folder name)
#   TASK_B64   base64-encoded task text (becomes claude's opening prompt)
#   AGENT_DIR  the agent's folder — claude opens here and writes its memory/scratch here
#   HOOK       absolute path to gate-hook.sh (the PreToolUse gate)
set -u
TASK=$(printf '%s' "${TASK_B64:-}" | base64 -d 2>/dev/null)

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

cd "$AGENT_DIR" 2>/dev/null || { red "agent folder not found: $AGENT_DIR"; exec bash; }

# Wire the gate as a project-local PreToolUse hook. claude inherits AOS_URL/SESSION/AGENT from
# this shell's env, so the hook can reach the gateway and tag the right session. We regenerate
# the settings each launch so the hook path is always correct (and portable across machines).
mkdir -p .claude
cat > .claude/settings.json <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "bash '$HOOK'" } ] }
    ]
  }
}
JSON

clear
cyan "┌─ Agent OS · governed claude ────────────────────────────────"
cyan "│ agent:   $AGENT"
cyan "│ session: $SESSION"
cyan "│ folder:  $AGENT_DIR"
cyan "│ task:    $TASK"
cyan "└─────────────────────────────────────────────────────────────"
echo
dim "Real claude, opened in this agent's folder. Every Bash call is gated by Agent OS;"
dim "risky ones pause here and surface as an inbox approval. Attach and type to take over."
echo

if ! command -v claude >/dev/null 2>&1; then
  red "the 'claude' CLI is not on PATH — install it or adjust PATH, then re-run."
  exec bash
fi

# Interactive session in this folder, seeded with the task, governed by the local hook.
exec claude --settings .claude/settings.json "$TASK"
