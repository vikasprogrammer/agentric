#!/usr/bin/env bash
#
# Install (or check) the native commands Agent OS needs to run agent sessions.
#
# This is the ZERO-DEPENDENCY bootstrap shortcut: it works on a fresh checkout BEFORE `npm run build`
# (nothing here needs dist/), so it's the first thing to run on a new box. `npm run install-deps` maps
# to it. Once the server is built and running, the same check is available in the console under
# Settings → System, and from the built CLI (`agent-os deps` / `agent-os install-deps`).
#
# Native deps (matches src/edge/deps.ts):
#   tmux   — backs every agent session (persistent panes)          [required, pkg]
#   ttyd   — serves the in-browser terminal                        [required, pkg]
#   claude — the agent runtime each session launches               [required, npm i -g @anthropic-ai/claude-code]
#   git    — powers self-update                                    [optional, pkg]
#
# Portable to bash 3.2 + BSD userland (the macOS default) as well as Linux — see CLAUDE.md. Pass
# `--check` to only report status (no install, exit 1 if a required dep is missing).
set -u

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

# ── resolve the package manager (first present wins; brew preferred on macOS) ──
MANAGER=""
if [ "$(uname -s)" = "Darwin" ]; then
  command -v brew >/dev/null 2>&1 && MANAGER="brew"
else
  for m in apt-get dnf yum pacman zypper brew; do
    if command -v "$m" >/dev/null 2>&1; then MANAGER="$m"; break; fi
  done
fi

# The install command for a given package manager + package list ($1 = pkgs).
install_cmd() {
  case "$MANAGER" in
    brew)    echo "brew install $1" ;;
    apt-get) echo "sudo apt-get update && sudo apt-get install -y $1" ;;
    dnf)     echo "sudo dnf install -y $1" ;;
    yum)     echo "sudo yum install -y $1" ;;
    pacman)  echo "sudo pacman -S --noconfirm $1" ;;
    zypper)  echo "sudo zypper install -y $1" ;;
    *)       echo "" ;;
  esac
}

# ── check each dep; collect the missing package-manager-installable ones ──
MISSING_PKGS=""
MISSING_REQUIRED=0

check_one() { # bin  label  required(0/1)  pkg(or "")  hint(or "")  versionArg(default --version)
  local bin="$1" label="$2" required="$3" pkg="$4" hint="$5" varg="${6:---version}"
  if command -v "$bin" >/dev/null 2>&1; then
    local ver
    ver="$("$bin" "$varg" 2>&1 | head -n1)"
    printf "  \342\234\223 %-12s %s\n" "$label" "$ver"
  else
    if [ "$required" = "1" ]; then MISSING_REQUIRED=1; fi
    if [ -n "$pkg" ] && [ -n "$MANAGER" ]; then
      MISSING_PKGS="$MISSING_PKGS $pkg"
      printf "  \342\234\227 %-12s missing\n" "$label"
    else
      printf "  \342\234\227 %-12s missing \342\200\224 %s\n" "$label" "${hint:-install manually}"
    fi
  fi
}

echo "Native dependencies:"
check_one tmux   "tmux"        1 "tmux" "" "-V"
check_one ttyd   "ttyd"        1 "ttyd" ""
check_one claude "Claude Code" 1 ""     "npm install -g @anthropic-ai/claude-code"
check_one git    "git"         0 "git"  ""
echo ""

# Trim leading whitespace from the accumulated package list.
MISSING_PKGS="$(echo "$MISSING_PKGS" | sed 's/^ *//')"

if [ -z "$MISSING_PKGS" ]; then
  if [ "$MISSING_REQUIRED" = "1" ]; then
    echo "Some required dependencies are missing and can't be installed automatically — see the hints above."
    exit 1
  fi
  echo "All required dependencies are installed."
  exit 0
fi

CMD="$(install_cmd "$MISSING_PKGS")"

if [ "$CHECK_ONLY" = "1" ] || [ -z "$MANAGER" ]; then
  if [ -z "$MANAGER" ]; then
    echo "No supported package manager found (brew/apt/dnf/yum/pacman/zypper)."
    echo "Install the missing tools by hand:$MISSING_PKGS"
  else
    echo "Missing:$MISSING_PKGS"
    echo "Install with:"
    echo "  $CMD"
  fi
  [ "$MISSING_REQUIRED" = "1" ] && exit 1
  exit 0
fi

echo "Installing:$MISSING_PKGS"
echo "  $CMD"
echo ""
sh -c "$CMD"
STATUS=$?

echo ""
if [ "$STATUS" = "0" ]; then
  echo "Done. Re-run 'npm run install-deps -- --check' to verify."
else
  echo "Install failed (exit $STATUS) — run the command above by hand to see why."
fi
exit "$STATUS"
