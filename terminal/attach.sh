#!/usr/bin/env bash
# ttyd runs this once per browser terminal connection, IN PLACE of a bare `tmux attach`.
# It makes "press Enter to reconnect" resurrect a stopped/ended session instead of looping
# against a dead tmux session: if the session is gone, we re-launch claude in the agent's
# folder resuming the SAME claude session id (claude --resume), governed by the same hook.
#
# Args (ttyd appends the browser's ?arg=aos-xxxx as the last argument):
#   $1  tmux socket path   (fixed, set when ttyd was launched)
#   $2  tmux session name   (aos-<id>, supplied by the browser)
# Env:
#   AOS_SESSION_DIR  dir holding the per-session launch env files (session-<id>.env)
set -u
SOCK="${1:-}"
NAME="${2:-}"

# No target (e.g. a ttyd asset probe) → nothing to attach to; exit cleanly.
[ -z "$SOCK" ] || [ -z "$NAME" ] && exit 0

# `tmux -u` on every attach/new-session below: this client is ttyd's xterm.js, which is always UTF-8,
# but ttyd is launched by the (launchd/systemd) server that may carry no locale — without -u tmux would
# infer non-UTF-8 from the empty LANG and mangle claude's wide chars (box-drawing / emoji / spinner).
# Alive → ordinary attach (the common case: open / re-open a running session).
if tmux -S "$SOCK" has-session -t "$NAME" 2>/dev/null; then
  exec tmux -u -S "$SOCK" attach -t "$NAME"
fi

# Not alive (yet). This is EITHER a brand-new session whose server-side `tmux new-session` simply
# hasn't landed (a race: the browser opens the terminal the instant spawn returns), OR a session
# that was stopped/ended. Wait out a short grace window for the spawn to appear before deciding —
# otherwise we'd "resume" a fresh session that has no transcript yet and claude would print
# "No conversation found with session ID …" (which surfaces to the user as a spurious not-found).
i=0
while [ "$i" -lt 12 ]; do
  sleep 0.25
  if tmux -S "$SOCK" has-session -t "$NAME" 2>/dev/null; then
    exec tmux -u -S "$SOCK" attach -t "$NAME"
  fi
  i=$((i + 1))
done

# Still gone after ~3s → it was genuinely stopped. Resurrect from the persisted launch context, if
# we have it. The launcher (RESUME=1) sources ENV_FILE to recover AGENT_DIR / CLAUDE_SESSION_ID /
# secrets, then `claude --resume`.
ID="${NAME#aos-}"
LAUNCHER="$(cd "$(dirname "$0")" && pwd)/claude-launch.sh"
ENV_FILE="${AOS_SESSION_DIR:-}/session-$ID.env"

# A DELIBERATE stop (the console Stop button → stopSession) drops a sentinel here. ttyd re-runs us the
# instant the pane dies (auto-reconnect), so WITHOUT this guard a stopped session would `claude --resume`
# itself straight back to life. Skip resurrection while the sentinel is present; re-opening the session
# from the console (attachUrl / the Resume button) clears it, so a deliberate resume still works.
if [ -n "${AOS_SESSION_DIR:-}" ] && [ -f "${AOS_SESSION_DIR}/session-$ID.stopped" ]; then
  exec tmux -u -S "$SOCK" attach -t "$NAME"   # fails cleanly (no such session) → ttyd shows disconnected
fi

if [ -n "${AOS_SESSION_DIR:-}" ] && [ -f "$ENV_FILE" ] && [ -f "$LAUNCHER" ]; then
  # new-session -A: attach if it raced back to life, else create running the resume launcher.
  exec tmux -u -S "$SOCK" new-session -A -s "$NAME" \
    "RESUME=1 ENV_FILE='$ENV_FILE' exec bash '$LAUNCHER'"
fi

# No context to resume from (e.g. a deleted session, or a mock/agent-runner session) → behave
# like before: a plain attach, which fails cleanly and shows ttyd's disconnect.
exec tmux -u -S "$SOCK" attach -t "$NAME"
