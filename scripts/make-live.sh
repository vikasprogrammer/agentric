#!/usr/bin/env bash
# "Make it live" — deploy origin/main to the northwind tenant on this Mac Mini.
#
# The live service runs from a DEDICATED checkout (~/agent-os-live), decoupled from the
# shared primary checkout that several sessions edit concurrently, and is supervised by launchd
# (com.agentos.northwind → scripts/run-tenant.sh northwind … :3010). Deploying is always the same
# five steps — sync, install if deps moved, build both bundles, restart, verify — so they live here
# instead of being retyped.
#
#   scripts/make-live.sh                 # deploy origin/main
#   scripts/make-live.sh --dry-run       # show what WOULD deploy, change nothing
#   scripts/make-live.sh --skip-tests    # skip the governance suite gate
#   scripts/make-live.sh --force         # discard local changes in the live checkout
#
# Deliberately northwind-only: every other tenant on this box (and every Linux box) has its own
# service, home and port. Override via env if that ever changes:
#   AOS_LIVE_CHECKOUT  AOS_LIVE_LABEL  AOS_LIVE_PORT  AOS_LIVE_LOG  AOS_LIVE_REF
#
# Safety properties worth keeping:
#  - Nothing is restarted until the build AND the tests pass, so a broken commit leaves the running
#    server untouched (it holds the old code in memory).
#  - The restart is `launchctl kickstart`, never `pkill -f "dist/cli.js serve"` — that command line is
#    shared by every tenant process on this box and killing it took prod down on 2026-08-01.
#  - A failed health check prints the exact rollback command rather than guessing.
set -euo pipefail

CHECKOUT="${AOS_LIVE_CHECKOUT:-$HOME/agent-os-live}"
LABEL="${AOS_LIVE_LABEL:-com.agentos.northwind}"
PORT="${AOS_LIVE_PORT:-3010}"
LOG="${AOS_LIVE_LOG:-$HOME/agent-os-data/northwind/server.log}"
REF="${AOS_LIVE_REF:-origin/main}"

DRY=0; SKIP_TESTS=0; FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --force)      FORCE=1 ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *)            echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$CHECKOUT/.git" ] || fail "no live checkout at $CHECKOUT (set AOS_LIVE_CHECKOUT)"
command -v launchctl >/dev/null || fail "launchctl not found — this script is for the macOS box"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || fail "launchd job $LABEL is not loaded (launchctl load -w ~/Library/LaunchAgents/$LABEL.plist)"

cd "$CHECKOUT"
git fetch -q origin
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "$REF")"

# What's about to land — the operator should see this before anything restarts.
if [ "$OLD" = "$NEW" ]; then
  say "already at $(git rev-parse --short "$NEW") — rebuilding + restarting anyway"
else
  say "deploying $(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW")"
  git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/  /'
fi

# A dedicated checkout should never be dirty; if it is, someone edited the live tree by hand and a
# reset would silently destroy that work. Show it and stop.
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ] && [ "$FORCE" -ne 1 ]; then
  echo "$DIRTY" | sed 's/^/  /'
  fail "live checkout has local changes (above) — rerun with --force to discard them"
fi

if [ "$DRY" -eq 1 ]; then say "dry run — nothing changed"; exit 0; fi

START=$(date +%s)
git reset --hard -q "$NEW"

# Dependencies only when the lockfiles actually moved (a full install on every deploy is ~30s of
# nothing). `git diff --quiet` between the two commits is the honest test.
if [ "$OLD" != "$NEW" ]; then
  if ! git diff --quiet "$OLD" "$NEW" -- package-lock.json package.json; then
    say "root deps changed → npm install"
    npm install --no-audit --no-fund >/dev/null
  fi
  if ! git diff --quiet "$OLD" "$NEW" -- web/package-lock.json web/package.json; then
    say "web deps changed → npm install"
    (cd web && npm install --no-audit --no-fund >/dev/null)
  fi
fi

# Build output is captured, not streamed: tsc says nothing on success and vite writes its chunk-size
# advice to stderr on every run. On failure the log is printed, so nothing is actually hidden.
BUILD_LOG=/tmp/aos-make-live-build.log
say "building server"
npm run build >"$BUILD_LOG" 2>&1 \
  || { tail -30 "$BUILD_LOG" >&2; fail "server build failed — live server untouched, still on $(git rev-parse --short "$OLD")"; }
say "building console"
(cd web && npm run build >"$BUILD_LOG" 2>&1) \
  || { tail -30 "$BUILD_LOG" >&2; fail "web build failed — live server untouched, still on $(git rev-parse --short "$OLD")"; }

if [ "$SKIP_TESTS" -eq 1 ]; then
  say "skipping governance suite (--skip-tests)"
else
  say "running governance suite"
  npm run test:governance >/tmp/aos-make-live-tests.log 2>&1 \
    || { tail -20 /tmp/aos-make-live-tests.log >&2; fail "governance suite failed — NOT restarting (still serving $(git rev-parse --short "$OLD"))"; }
  tail -1 /tmp/aos-make-live-tests.log
fi

VERSION="$(node -p "require('$CHECKOUT/package.json').version")"
say "restarting $LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# Verify the running process actually reports the version we just built — the single check that tells
# "the change took effect" apart from "a long-running server is still holding the old code".
LIVE=""
for _ in $(seq 1 30); do
  sleep 1
  LIVE="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  case "$LIVE" in *"\"version\":\"$VERSION\""*) break ;; esac
done

case "$LIVE" in
  *"\"version\":\"$VERSION\""*)
    say "live: $LIVE"
    say "done in $(( $(date +%s) - START ))s — $(git rev-parse --short "$NEW") @ v$VERSION"
    ;;
  *)
    echo "--- last 30 lines of $LOG ---" >&2
    tail -30 "$LOG" >&2 || true
    fail "health check never reported v$VERSION (last response: ${LIVE:-none}).
Roll back with:
  git -C $CHECKOUT reset --hard $OLD && (cd $CHECKOUT && npm run build && cd web && npm run build) && launchctl kickstart -k gui/$(id -u)/$LABEL"
    ;;
esac
