#!/usr/bin/env bash
# Run ONE self-contained Agent OS tenant as its own process.
#
# Each tenant = a distinct data home + tenant id + port. Nothing is shared between tenants except the
# software (this repo) — DB, tmux socket, ttyd, audit, cron and Slack are all per-home, so the
# processes are fully isolated. This is the process-per-tenant model (docs/process-per-tenant.md).
#
#   scripts/run-tenant.sh <slug> <home-dir> <port> [owner-email]
#
# Example:
#   scripts/run-tenant.sh acme   ~/aos/acme   3010  you@acme.com
#   scripts/run-tenant.sh globex ~/aos/globex 3020  you@globex.com
set -euo pipefail

SLUG="${1:?usage: run-tenant.sh <slug> <home-dir> <port> [owner-email]}"
HOME_DIR="${2:?home dir required}"
PORT="${3:?port required}"
OWNER="${4:-owner@${SLUG}.local}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$REPO/dist/cli.js" ] || { echo "build first: npm run build" >&2; exit 1; }
mkdir -p "$HOME_DIR"

export AGENT_OS_HOME="$HOME_DIR"
export AGENT_OS_TENANT="$SLUG"          # this process's self-contained tenant id
export AGENT_OS_OWNER_EMAIL="$OWNER"
export PORT="$PORT"
export TTYD_PORT="$((PORT + 1))"        # one ttyd per process, alongside its server

echo "▶ tenant=$SLUG  home=$HOME_DIR  port=$PORT  ttyd=$TTYD_PORT  owner=$OWNER"
exec node "$REPO/dist/cli.js" serve --port="$PORT"
