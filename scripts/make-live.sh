#!/usr/bin/env bash
# "Make it live" — deploy origin/main to this deployment's tenant services, local and remote.
#
# A live service runs from a DEDICATED checkout (never the shared primary that several sessions edit
# concurrently) and is supervised by launchd (com.agentos.<tenant> → scripts/run-tenant.sh <tenant> …
# :<port>). Deploying is always the same five steps — sync, install if deps moved, build both bundles,
# restart, verify — so they live here instead of being retyped.
#
#   scripts/make-live.sh                 # deploy origin/main to every configured tenant
#   scripts/make-live.sh --only <tenant> # …to one of them
#   scripts/make-live.sh --dry-run       # show what WOULD deploy, change nothing
#   scripts/make-live.sh --skip-tests    # skip the governance suite gate
#   scripts/make-live.sh --force         # discard local changes in a live checkout
#
# WHICH tenants belong to your box is your deployment's business, not this repo's — it comes from an
# untracked env file (see below). Either form works:
#   AOS_LIVE_TARGETS="acme:$HOME/agent-os-live:3010 beta:$HOME/agent-os-beta:3030"
#       one entry per tenant, `tenant:checkout:port[:label]` (label defaults to com.agentos.<tenant>).
#   AOS_LIVE_TENANT / AOS_LIVE_CHECKOUT / AOS_LIVE_LABEL / AOS_LIVE_PORT / AOS_LIVE_LOG
#       the older single-tenant form, still honoured when AOS_LIVE_TARGETS is unset.
#
# A tenant on ANOTHER box (Linux/systemd, reached over ssh) goes in a second list — the mechanics differ
# enough (ssh, systemctl instead of launchctl, the box's own node on a non-login PATH) that mixing them
# into one loop would obscure both:
#   AOS_LIVE_REMOTE_TARGETS="acme:user@your-remote-box.example.com:/home/agent-os/tools/agent-os:3012:agent-os-acme"
#       one entry per tenant, `tenant:ssh:checkout:port[:unit]` (unit defaults to agent-os-<tenant>,
#       and is restarted with `sudo systemctl restart <unit>`).
#   AOS_LIVE_REMOTE_NODE_BIN   node/npm dir prepended to PATH on the remote box (nvm installs are not on
#       a non-login PATH). Default: $HOME/.nvm/versions/node/v22.22.0/bin on the REMOTE side.
#
# Remote targets obey the same ordering guarantee as local ones: every checkout — local and remote —
# is synced, built and tested before ANY service is restarted.
#
# Two tenants may share one checkout (each still has its own home, DB, port and launchd job). The
# checkout is then synced/built ONCE and each service restarted — which is also why the phases below
# are ordered build-everything-then-restart-everything.
#
# Safety properties worth keeping:
#  - Nothing is restarted until every checkout's build AND tests pass, so a broken commit leaves every
#    running server untouched (each holds its old code in memory).
#  - The restart is `launchctl kickstart`, never `pkill -f "dist/cli.js serve"` — that command line is
#    shared by every tenant process on this box and killing it took prod down on 2026-08-01.
#  - A failed health check prints the exact rollback command rather than guessing.
#  - Restarts happen one tenant at a time and stop at the first failure, so a bad deploy takes down at
#    most one service; the report at the end says which tenants moved and which never got there.
#  - A remote box is only ever reached with `ssh -o BatchMode=yes` — a deploy that would sit waiting on a
#    password prompt fails fast in preflight instead of hanging.
set -euo pipefail

ENV_FILE="${AOS_LIVE_ENV:-$HOME/.agentric-live.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

REF="${AOS_LIVE_REF:-origin/main}"

DRY=0; SKIP_TESTS=0; FORCE=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --force)      FORCE=1 ;;
    --only)       shift; ONLY="${1:?--only needs a tenant slug}" ;;
    --only=*)     ONLY="${1#--only=}" ;;
    -h|--help)    sed -n '2,48p' "$0"; exit 0 ;;
    *)            echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── the target list ──────────────────────────────────────────────────────────────
# Normalised to one `tenant:checkout:port:label` line per tenant, so everything below iterates over a
# single shape whichever env form configured it.
TARGETS=""
if [ -n "${AOS_LIVE_TARGETS:-}" ]; then
  for spec in $AOS_LIVE_TARGETS; do
    t="${spec%%:*}"; rest="${spec#*:}"
    c="${rest%%:*}"; rest="${rest#*:}"
    p="${rest%%:*}"
    l="${rest#*:}"; [ "$l" = "$p" ] && l="com.agentos.$t"
    [ -n "$t" ] && [ -n "$c" ] && [ -n "$p" ] || fail "bad AOS_LIVE_TARGETS entry: $spec (want tenant:checkout:port[:label])"
    TARGETS="$TARGETS$t:$c:$p:$l
"
  done
elif [ -z "${AOS_LIVE_REMOTE_TARGETS:-}" ]; then
  # Only fall back to the single-tenant form when NOTHING else is configured — a deployment whose only
  # tenants are remote must not have a phantom local `acme` invented for it.
  t="${AOS_LIVE_TENANT:-acme}"
  TARGETS="$t:${AOS_LIVE_CHECKOUT:-$HOME/agent-os-live}:${AOS_LIVE_PORT:-3010}:${AOS_LIVE_LABEL:-com.agentos.$t}
"
fi

# Remote tenants: `tenant:ssh:checkout:port[:unit]`, normalised the same way.
REMOTES=""
for spec in ${AOS_LIVE_REMOTE_TARGETS:-}; do
  t="${spec%%:*}"; rest="${spec#*:}"
  h="${rest%%:*}"; rest="${rest#*:}"
  c="${rest%%:*}"; rest="${rest#*:}"
  p="${rest%%:*}"
  u="${rest#*:}"; [ "$u" = "$p" ] && u="agent-os-$t"
  [ -n "$t" ] && [ -n "$h" ] && [ -n "$c" ] && [ -n "$p" ] \
    || fail "bad AOS_LIVE_REMOTE_TARGETS entry: $spec (want tenant:ssh:checkout:port[:unit])"
  REMOTES="$REMOTES$t:$h:$c:$p:$u
"
done

REMOTE_NODE_BIN="${AOS_LIVE_REMOTE_NODE_BIN:-\$HOME/.nvm/versions/node/v22.22.0/bin}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
# Every remote command runs through one wrapper so the node PATH and `set -e` are never forgotten.
on_remote() { # <ssh-target> <command…>
  local host="$1"; shift
  # shellcheck disable=SC2029  # the PATH expansion is deliberately remote-side
  $SSH "$host" "export PATH=\"$REMOTE_NODE_BIN:\$PATH\"; set -e; $*"
}

if [ -n "$ONLY" ]; then
  PICKED="$(printf '%s' "$TARGETS" | grep "^$ONLY:" || true)"
  PICKED_R="$(printf '%s' "$REMOTES" | grep "^$ONLY:" || true)"
  [ -n "$PICKED" ] || [ -n "$PICKED_R" ] \
    || fail "--only $ONLY: not in the configured targets ($(printf '%s%s' "$TARGETS" "$REMOTES" | cut -d: -f1 | tr '\n' ' '))"
  TARGETS="$PICKED"; [ -n "$TARGETS" ] && TARGETS="$TARGETS
"
  REMOTES="$PICKED_R"; [ -n "$REMOTES" ] && REMOTES="$REMOTES
"
fi

# launchctl is only needed for LOCAL tenants — a box that deploys nothing but remotes doesn't need it.
if [ -n "$TARGETS" ]; then
  command -v launchctl >/dev/null || fail "launchctl not found — local targets need the macOS box"
fi

# Per-checkout scratch state (bash 3.2 on macOS has no associative arrays): one file per checkout,
# named after its path, holding the commit it was on before the sync — that's what a rollback needs.
STATE="$(mktemp -d)"
trap 'rm -rf "$STATE"' EXIT
key_for() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }

log_for() {  # tenant → its server.log (AOS_LIVE_LOG only names the single-tenant one)
  if [ -n "${AOS_LIVE_LOG:-}" ] && [ "$1" = "${AOS_LIVE_TENANT:-}" ]; then printf '%s' "$AOS_LIVE_LOG"
  else printf '%s' "$HOME/agent-os-data/$1/server.log"; fi
}

# ── phase 0: preflight every target before touching anything ─────────────────────
CHECKOUTS=""
while IFS=: read -r TENANT CHECKOUT PORT LABEL; do
  [ -n "$TENANT" ] || continue
  [ -d "$CHECKOUT/.git" ] || fail "$TENANT: no live checkout at $CHECKOUT"
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
    || fail "$TENANT: launchd job $LABEL is not loaded (launchctl load -w ~/Library/LaunchAgents/$LABEL.plist)"
  case " $CHECKOUTS " in *" $CHECKOUT "*) ;; *) CHECKOUTS="$CHECKOUTS $CHECKOUT" ;; esac
done <<EOF
$TARGETS
EOF

# Remote preflight: reachable without a prompt, checkout present, unit known. Done before ANY build so
# an unreachable box costs nothing.
while IFS=: read -r TENANT SSHT CHECKOUT PORT UNIT; do
  [ -n "$TENANT" ] || continue
  $SSH "$SSHT" true 2>/dev/null \
    || fail "$TENANT: cannot ssh to $SSHT without a prompt (BatchMode) — check your key/agent"
  on_remote "$SSHT" "[ -d '$CHECKOUT/.git' ]" \
    || fail "$TENANT: no checkout at $CHECKOUT on $SSHT"
  on_remote "$SSHT" "systemctl cat '$UNIT' >/dev/null 2>&1" \
    || fail "$TENANT: systemd unit $UNIT not found on $SSHT"
  on_remote "$SSHT" "command -v node >/dev/null" \
    || fail "$TENANT: no node on $SSHT at PATH $REMOTE_NODE_BIN (set AOS_LIVE_REMOTE_NODE_BIN)"
done <<EOF
$REMOTES
EOF

say "targets: $(printf '%s%s' "$TARGETS" "$REMOTES" | cut -d: -f1 | tr '\n' ' ')"

# ── phase 1: sync + build every checkout (no service is restarted in here) ───────
for CHECKOUT in $CHECKOUTS; do
  cd "$CHECKOUT"
  git fetch -q origin
  OLD="$(git rev-parse HEAD)"
  NEW="$(git rev-parse "$REF")"
  echo "$OLD" >"$STATE/$(key_for "$CHECKOUT").old"

  if [ "$OLD" = "$NEW" ]; then
    say "$CHECKOUT: already at $(git rev-parse --short "$NEW") — rebuilding + restarting anyway"
  else
    say "$CHECKOUT: deploying $(git rev-parse --short "$OLD") → $(git rev-parse --short "$NEW")"
    git --no-pager log --oneline "$OLD..$NEW" | sed 's/^/  /'
  fi

  # A dedicated checkout should never be dirty; if it is, someone edited the live tree by hand and a
  # reset would silently destroy that work. Show it and stop.
  DIRTY="$(git status --porcelain)"
  if [ -n "$DIRTY" ] && [ "$FORCE" -ne 1 ]; then
    echo "$DIRTY" | sed 's/^/  /'
    fail "$CHECKOUT has local changes (above) — rerun with --force to discard them"
  fi

  [ "$DRY" -eq 1 ] && continue

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
    || { tail -30 "$BUILD_LOG" >&2; fail "server build failed in $CHECKOUT — every live server untouched, still on its old code"; }
  say "building console"
  (cd web && npm run build >"$BUILD_LOG" 2>&1) \
    || { tail -30 "$BUILD_LOG" >&2; fail "web build failed in $CHECKOUT — every live server untouched, still on its old code"; }

  if [ "$SKIP_TESTS" -eq 1 ]; then
    say "skipping governance suite (--skip-tests)"
  else
    say "running governance suite"
    npm run test:governance >/tmp/aos-make-live-tests.log 2>&1 \
      || { tail -20 /tmp/aos-make-live-tests.log >&2; fail "governance suite failed in $CHECKOUT — NOTHING restarted"; }
    tail -1 /tmp/aos-make-live-tests.log
  fi
done

# ── phase 1b: sync + build every remote checkout (still nothing restarted) ───────
while IFS=: read -r TENANT SSHT CHECKOUT PORT UNIT; do
  [ -n "$TENANT" ] || continue
  OLD="$(on_remote "$SSHT" "git -C '$CHECKOUT' rev-parse HEAD")"
  on_remote "$SSHT" "git -C '$CHECKOUT' fetch -q origin"
  NEW="$(on_remote "$SSHT" "git -C '$CHECKOUT' rev-parse '$REF'")"
  echo "$OLD" >"$STATE/$(key_for "$SSHT$CHECKOUT").old"

  if [ "$OLD" = "$NEW" ]; then
    say "$SSHT:$CHECKOUT: already at ${NEW:0:7} — rebuilding + restarting anyway"
  else
    say "$SSHT:$CHECKOUT: deploying ${OLD:0:7} → ${NEW:0:7}"
    on_remote "$SSHT" "git -C '$CHECKOUT' --no-pager log --oneline '$OLD..$NEW'" | sed 's/^/  /'
  fi

  DIRTY="$(on_remote "$SSHT" "git -C '$CHECKOUT' status --porcelain")"
  if [ -n "$DIRTY" ] && [ "$FORCE" -ne 1 ]; then
    echo "$DIRTY" | sed 's/^/  /'
    fail "$SSHT:$CHECKOUT has local changes (above) — rerun with --force to discard them"
  fi

  [ "$DRY" -eq 1 ] && continue

  on_remote "$SSHT" "git -C '$CHECKOUT' reset --hard -q '$NEW'"

  if [ "$OLD" != "$NEW" ]; then
    if ! on_remote "$SSHT" "git -C '$CHECKOUT' diff --quiet '$OLD' '$NEW' -- package-lock.json package.json"; then
      say "$TENANT: root deps changed → npm install"
      on_remote "$SSHT" "cd '$CHECKOUT' && npm install --no-audit --no-fund >/dev/null"
    fi
    if ! on_remote "$SSHT" "git -C '$CHECKOUT' diff --quiet '$OLD' '$NEW' -- web/package-lock.json web/package.json"; then
      say "$TENANT: web deps changed → npm install"
      on_remote "$SSHT" "cd '$CHECKOUT/web' && npm install --no-audit --no-fund >/dev/null"
    fi
  fi

  say "$TENANT: building server"
  on_remote "$SSHT" "cd '$CHECKOUT' && npm run build >/tmp/aos-make-live-build.log 2>&1" \
    || { on_remote "$SSHT" "tail -30 /tmp/aos-make-live-build.log" >&2 || true; fail "$TENANT: server build failed on $SSHT — every live server untouched"; }
  say "$TENANT: building console"
  on_remote "$SSHT" "cd '$CHECKOUT/web' && npm run build >/tmp/aos-make-live-build.log 2>&1" \
    || { on_remote "$SSHT" "tail -30 /tmp/aos-make-live-build.log" >&2 || true; fail "$TENANT: web build failed on $SSHT — every live server untouched"; }

  if [ "$SKIP_TESTS" -eq 1 ]; then
    say "$TENANT: skipping governance suite (--skip-tests)"
  else
    say "$TENANT: running governance suite"
    # AOS_NO_TTYD: a suite run that builds a TenantRegistry spawns a ttyd per tenant and only
    # startServer's stopAll reaps it — on a live box those leak and pin every core.
    on_remote "$SSHT" "cd '$CHECKOUT' && AOS_NO_TTYD=1 npm run test:governance >/tmp/aos-make-live-tests.log 2>&1" \
      || { on_remote "$SSHT" "tail -20 /tmp/aos-make-live-tests.log" >&2 || true; fail "$TENANT: governance suite failed on $SSHT — NOTHING restarted"; }
    on_remote "$SSHT" "tail -1 /tmp/aos-make-live-tests.log"
  fi
done <<EOF
$REMOTES
EOF

if [ "$DRY" -eq 1 ]; then say "dry run — nothing changed"; exit 0; fi

# ── phase 2: restart + verify each service ───────────────────────────────────────
START=$(date +%s)
DEPLOYED=""
while IFS=: read -r TENANT CHECKOUT PORT LABEL; do
  [ -n "$TENANT" ] || continue
  OLD="$(cat "$STATE/$(key_for "$CHECKOUT").old")"
  VERSION="$(node -p "require('$CHECKOUT/package.json').version")"
  LOG="$(log_for "$TENANT")"

  say "restarting $LABEL (:$PORT)"
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
      DEPLOYED="$DEPLOYED $TENANT"
      ;;
    *)
      echo "--- last 30 lines of $LOG ---" >&2
      tail -30 "$LOG" >&2 || true
      [ -n "$DEPLOYED" ] && warn "already deployed before this failure:$DEPLOYED"
      fail "$TENANT: health check never reported v$VERSION (last response: ${LIVE:-none}).
Roll back with:
  git -C $CHECKOUT reset --hard $OLD && (cd $CHECKOUT && npm run build && cd web && npm run build) && launchctl kickstart -k gui/$(id -u)/$LABEL"
      ;;
  esac
done <<EOF
$TARGETS
EOF

while IFS=: read -r TENANT SSHT CHECKOUT PORT UNIT; do
  [ -n "$TENANT" ] || continue
  OLD="$(cat "$STATE/$(key_for "$SSHT$CHECKOUT").old")"
  VERSION="$(on_remote "$SSHT" "node -p \"require('$CHECKOUT/package.json').version\"")"

  say "restarting $UNIT on $SSHT (:$PORT)"
  on_remote "$SSHT" "sudo systemctl restart '$UNIT'"

  # Same check as the local lane: the RUNNING process must report the version we just built, else a
  # long-running server is still holding its old code in memory.
  LIVE=""
  for _ in $(seq 1 30); do
    sleep 1
    LIVE="$(on_remote "$SSHT" "curl -fsS --max-time 2 http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    case "$LIVE" in *"\"version\":\"$VERSION\""*) break ;; esac
  done

  case "$LIVE" in
    *"\"version\":\"$VERSION\""*)
      say "live: $LIVE"
      DEPLOYED="$DEPLOYED $TENANT"
      ;;
    *)
      echo "--- last 30 journal lines for $UNIT on $SSHT ---" >&2
      on_remote "$SSHT" "journalctl -u '$UNIT' -n 30 --no-pager" >&2 || true
      [ -n "$DEPLOYED" ] && warn "already deployed before this failure:$DEPLOYED"
      fail "$TENANT: health check never reported v$VERSION (last response: ${LIVE:-none}).
Roll back with:
  ssh $SSHT \"git -C $CHECKOUT reset --hard $OLD && cd $CHECKOUT && npm run build && (cd web && npm run build) && sudo systemctl restart $UNIT\""
      ;;
  esac
done <<EOF
$REMOTES
EOF

say "done in $(( $(date +%s) - START ))s —$DEPLOYED"
