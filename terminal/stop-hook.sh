#!/usr/bin/env bash
# Claude Code Stop hook — fires when claude finishes a turn. For an UNATTENDED run (automation/cron/task)
# this is the end-of-run signal: beacon the server so it can tear the session down at turn-end (kill the
# pane → tmux drops → the automations pile-up guard releases), the parity replacement for the old
# `claude -p` process exit. The server (markTurnIdle) does nothing UNLESS the run is unattended and
# nobody has taken it over / is watching / it's blocked on a person — so this beacon is harmless for a
# member's own interactive session or a claimed take-over. Dumb transport, like notify-hook.sh: a Stop
# hook must never wedge the turn, so this is best-effort / fail-open (always exit 0, never `decision:block`).
#
# Env: AOS_URL, SESSION, AOS_SECRET, AOS_TENANT  (exported when the claude session is launched)
set -u
cat >/dev/null 2>&1 || true   # drain the hook's JSON stdin; we key off SESSION, not the payload

payload=$(SESSION="$SESSION" node -e 'console.log(JSON.stringify({session:process.env.SESSION}))' 2>/dev/null) || exit 0

curl -s --max-time 10 -X POST "$AOS_URL/api/turn-idle" -H 'content-type: application/json' \
  -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" -d "$payload" >/dev/null 2>&1 || true
exit 0
