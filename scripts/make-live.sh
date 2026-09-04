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
# Checkouts are synced/built/tested in PARALLEL (phase 1b) and restarted one at a time (phase 2). The
# ordering guarantee is unchanged — nothing restarts until every job has passed — but the wall clock is
# now the slowest checkout instead of the sum of all of them. Each job's output is captured and replayed
# whole, in target order, rather than three builds interleaving into an unreadable transcript.
#
# Safety properties worth keeping:
#  - Nothing is restarted until every checkout's build AND tests pass, so a broken commit leaves every
#    running server untouched (each holds its old code in memory). Parallel jobs don't weaken this: the
#    wait loop collects every exit code and one failure anywhere stops the deploy before phase 2.
#  - The restart is `launchctl kickstart`, never `pkill -f "dist/cli.js serve"` — that command line is
#    shared by every tenant process on this box and killing it took prod down on 2026-08-01.
#  - A failed health check prints the exact rollback command rather than guessing.
#  - Restarts happen one tenant at a time and stop at the first failure, so a bad deploy takes down at
#    most one service; the report at the end says which tenants moved and which never got there.
#  - A remote box is only ever reached with `ssh -o BatchMode=yes` — a deploy that would sit waiting on a
#    password prompt fails fast in preflight instead of hanging.
#  - EVERY checkout lands on the SAME commit: $REF is resolved once, up front, and each checkout is
#    pinned to that sha. Resolving per-checkout raced whoever was merging — a box that fetched a second
#    later deployed a different commit, and the run still reported success.
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
# `-n` is load-bearing, not tidiness: every remote loop below is a `while read … done <<EOF`, and an
# ssh that inherits that stdin SLURPS the rest of the heredoc. With one remote target nothing showed;
# adding a second one made the first ssh swallow it, so preflight and phase 1a silently skipped it and
# the parallel build phase (background subshells, which do not share that stdin) then died on the
# state file phase 1a never wrote — "No such file or directory", naming a tenant nothing had mentioned.
SSH="ssh -n -o BatchMode=yes -o ConnectTimeout=10"
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

# ── phase 0b: resolve ONE commit for the whole deploy ────────────────────────────
# Every checkout used to fetch and then resolve $REF for ITSELF. That is a race with whoever is merging:
# a checkout that fetches after a merge lands resolves a different commit than its siblings that fetched
# a second earlier. On 2026-09-03 one tenant went live on 0.419.2 while the other two went live on
# 0.419.1 — out of a single run that reported success for all three, because each box was verified
# against the version it had itself built. A deploy is one commit everywhere or it is not a deploy, so
# $REF is resolved exactly ONCE, here, and every checkout is pinned to that sha.
#
# The pin is read from the first local checkout, or the first remote when this box deploys only remotes.
PIN_SRC="$(printf '%s' "$CHECKOUTS" | awk '{print $1}')"
if [ -n "$PIN_SRC" ]; then
  git -C "$PIN_SRC" fetch -q origin
  TARGET="$(git -C "$PIN_SRC" rev-parse --verify -q "$REF^{commit}")" \
    || fail "cannot resolve $REF in $PIN_SRC"
else
  PIN_SSHT="$(printf '%s' "$REMOTES" | head -1 | cut -d: -f2)"
  PIN_CO="$(printf '%s' "$REMOTES" | head -1 | cut -d: -f3)"
  on_remote "$PIN_SSHT" "git -C '$PIN_CO' fetch -q origin"
  TARGET="$(on_remote "$PIN_SSHT" "git -C '$PIN_CO' rev-parse --verify -q '$REF^{commit}'")" \
    || fail "cannot resolve $REF on $PIN_SSHT:$PIN_CO"
fi
say "deploy target: $REF @ ${TARGET:0:7} — every checkout is pinned to this commit"

say "targets: $(printf '%s%s' "$TARGETS" "$REMOTES" | cut -d: -f1 | tr '\n' ' ')"

# ── phase 1: sync + build every checkout (no service is restarted in here) ───────
#
# Split in two on purpose:
#   1a  sequential, cheap and INFORMATIVE — fetch, resolve the target commit, refuse a dirty tree, and
#       print what each checkout is about to move to. None of it takes real time, and doing it up front
#       means a dirty checkout or an unreachable box costs nothing.
#   1b  parallel, and where all the time actually goes — reset, install, build, test. Checkouts are
#       independent until phase 2, so running them one after another made the wall clock the SUM of
#       work that could have overlapped: on this 3-tenant box, three builds of the same commit, one at
#       a time. Each job's output is captured and replayed WHOLE, in target order, once everything is
#       done — three interleaved build logs would be unreadable, and a deploy is not a thing you watch
#       character by character.
#
# The governance suite is ~90% of a deploy (88s of a 95s local pass, and 3 of its 88 scripts are 70% of
# that — they sleep). It is a property of the COMMIT, not of the checkout: running it once per local
# checkout re-proved the same shas on the same node on the same box. It now runs ONCE across the local
# checkouts when they're all landing on the same commit — and in every one of them when they aren't,
# which is the only case where the second run could say something new. Each REMOTE still runs its own:
# a different node major and a different libc is exactly where portable-SQL bugs surface (see
# CLAUDE.md → SQLite differs local vs CI/boxes). Remotes are deduped only when they share BOTH a host
# and a commit.
#
# Per-job log/build/test files are keyed by checkout. They used to be fixed /tmp paths, which two
# parallel builds would write over each other.

# ---- phase 1a (local): fetch, resolve, refuse a dirty tree ----------------------
LOCAL_JOBS=""
LOCAL_NEWS=""
for CHECKOUT in $CHECKOUTS; do
  cd "$CHECKOUT"
  git fetch -q origin
  OLD="$(git rev-parse HEAD)"
  NEW="$TARGET"
  git rev-parse --verify -q "$NEW^{commit}" >/dev/null \
    || fail "$CHECKOUT: $REF pinned to $NEW, but that commit is not here after a fetch"
  K="$(key_for "$CHECKOUT")"
  echo "$OLD" >"$STATE/$K.old"
  echo "$NEW" >"$STATE/$K.new"

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

  LOCAL_JOBS="$LOCAL_JOBS $CHECKOUT"
  LOCAL_NEWS="$LOCAL_NEWS$NEW
"
done

# One distinct target commit across every local checkout ⇒ one suite run covers all of them.
LOCAL_UNIQ="$(printf '%s' "$LOCAL_NEWS" | sort -u | grep -c . || true)"
SUITE_FIRST=1
for CHECKOUT in $LOCAL_JOBS; do
  K="$(key_for "$CHECKOUT")"
  if [ "$SUITE_FIRST" -eq 1 ] || [ "$LOCAL_UNIQ" != "1" ]; then : >"$STATE/$K.suite"; fi
  SUITE_FIRST=0
done

# ---- phase 1a (remote): same, over ssh ------------------------------------------
REMOTE_SEEN=""
while IFS=: read -r TENANT SSHT CHECKOUT PORT UNIT; do
  [ -n "$TENANT" ] || continue
  OLD="$(on_remote "$SSHT" "git -C '$CHECKOUT' rev-parse HEAD")"
  on_remote "$SSHT" "git -C '$CHECKOUT' fetch -q origin"
  NEW="$TARGET"
  on_remote "$SSHT" "git -C '$CHECKOUT' rev-parse --verify -q '$NEW^{commit}' >/dev/null" \
    || fail "$TENANT: $REF pinned to $NEW, but that commit is not on $SSHT:$CHECKOUT after a fetch"
  K="$(key_for "$SSHT$CHECKOUT")"
  echo "$OLD" >"$STATE/$K.old"
  echo "$NEW" >"$STATE/$K.new"

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

  # A remote's suite run is skipped only by another remote on the SAME host at the SAME commit.
  case " $REMOTE_SEEN " in
    *" $SSHT|$NEW "*) ;;
    *) : >"$STATE/$K.suite"; REMOTE_SEEN="$REMOTE_SEEN $SSHT|$NEW" ;;
  esac
done <<EOF
$REMOTES
EOF

if [ "$DRY" -eq 1 ]; then say "dry run — nothing changed"; exit 0; fi

# ---- phase 1b: the expensive half, one job per checkout, all at once ------------

# Build output is captured, not streamed: tsc says nothing on success and vite writes its chunk-size
# advice to stderr on every run. On failure the log is printed, so nothing is actually hidden.
build_local() { # <checkout> — runs in its own subshell; its whole output is one job log
  CHECKOUT="$1"
  K="$(key_for "$CHECKOUT")"
  OLD="$(cat "$STATE/$K.old")"; NEW="$(cat "$STATE/$K.new")"
  cd "$CHECKOUT"
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

  say "building server"
  npm run build >"$STATE/$K.build" 2>&1 \
    || { tail -30 "$STATE/$K.build" >&2; fail "server build failed in $CHECKOUT — every live server untouched, still on its old code"; }
  say "building console"
  (cd web && npm run build >"$STATE/$K.build" 2>&1) \
    || { tail -30 "$STATE/$K.build" >&2; fail "web build failed in $CHECKOUT — every live server untouched, still on its old code"; }

  if [ "$SKIP_TESTS" -eq 1 ]; then
    say "skipping governance suite (--skip-tests)"
  elif [ ! -f "$STATE/$K.suite" ]; then
    say "governance suite already run for ${NEW:0:7} — not repeating it here"
  else
    say "running governance suite"
    # AOS_NO_TTYD: a suite run that builds a TenantRegistry spawns a ttyd per tenant and only
    # startServer's stopAll reaps it — on a live box those leak and pin every core.
    AOS_NO_TTYD=1 npm run test:governance >"$STATE/$K.tests" 2>&1 \
      || { tail -20 "$STATE/$K.tests" >&2; fail "governance suite failed in $CHECKOUT — NOTHING restarted"; }
    tail -1 "$STATE/$K.tests"
  fi
}

build_remote() { # <tenant> <ssh-target> <checkout>
  TENANT="$1"; SSHT="$2"; CHECKOUT="$3"
  K="$(key_for "$SSHT$CHECKOUT")"
  OLD="$(cat "$STATE/$K.old")"; NEW="$(cat "$STATE/$K.new")"
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
  on_remote "$SSHT" "cd '$CHECKOUT' && npm run build >/tmp/aos-make-live-$K.build 2>&1" \
    || { on_remote "$SSHT" "tail -30 /tmp/aos-make-live-$K.build" >&2 || true; fail "$TENANT: server build failed on $SSHT — every live server untouched"; }
  say "$TENANT: building console"
  on_remote "$SSHT" "cd '$CHECKOUT/web' && npm run build >/tmp/aos-make-live-$K.build 2>&1" \
    || { on_remote "$SSHT" "tail -30 /tmp/aos-make-live-$K.build" >&2 || true; fail "$TENANT: web build failed on $SSHT — every live server untouched"; }

  if [ "$SKIP_TESTS" -eq 1 ]; then
    say "$TENANT: skipping governance suite (--skip-tests)"
  elif [ ! -f "$STATE/$K.suite" ]; then
    say "$TENANT: governance suite already run for ${NEW:0:7} on $SSHT — not repeating it"
  else
    say "$TENANT: running governance suite"
    on_remote "$SSHT" "cd '$CHECKOUT' && AOS_NO_TTYD=1 npm run test:governance >/tmp/aos-make-live-$K.tests 2>&1" \
      || { on_remote "$SSHT" "tail -20 /tmp/aos-make-live-$K.tests" >&2 || true; fail "$TENANT: governance suite failed on $SSHT — NOTHING restarted"; }
    on_remote "$SSHT" "tail -1 /tmp/aos-make-live-$K.tests"
  fi
}

JOB_KEYS=""
for CHECKOUT in $LOCAL_JOBS; do
  K="$(key_for "$CHECKOUT")"
  ( build_local "$CHECKOUT" ) >"$STATE/$K.log" 2>&1 &
  echo $! >"$STATE/$K.pid"
  JOB_KEYS="$JOB_KEYS $K"
done
while IFS=: read -r TENANT SSHT CHECKOUT PORT UNIT; do
  [ -n "$TENANT" ] || continue
  K="$(key_for "$SSHT$CHECKOUT")"
  ( build_remote "$TENANT" "$SSHT" "$CHECKOUT" ) >"$STATE/$K.log" 2>&1 &
  echo $! >"$STATE/$K.pid"
  JOB_KEYS="$JOB_KEYS $K"
done <<EOF
$REMOTES
EOF

say "building $(printf '%s' "$JOB_KEYS" | wc -w | tr -d ' ') checkout(s) in parallel"
JOB_FAILED=""
for K in $JOB_KEYS; do
  RC=0; wait "$(cat "$STATE/$K.pid")" || RC=$?
  cat "$STATE/$K.log"
  [ "$RC" -eq 0 ] || JOB_FAILED="$JOB_FAILED $K"
done
# One failure anywhere means NOTHING restarts — the whole point of building before restarting. The
# per-job logs are already printed above, so this line only has to name the casualties.
[ -z "$JOB_FAILED" ] || fail "build/test failed in$(printf '%s' "$JOB_FAILED") — every live server untouched, still on its old code"

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
