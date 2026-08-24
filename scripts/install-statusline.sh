#!/usr/bin/env bash
# Agentric status line — one-command install into ANY claude session on ANY machine.
#
#   curl -fsSL https://raw.githubusercontent.com/vikasprogrammer/agentric/main/scripts/install-statusline.sh | bash
#
# Drops `terminal/statusline.js` into the claude config dir and points settings.json `statusLine` at
# it, so a plain `claude` (no Agentric, no checkout, no npm install) gets the same bar the governed
# fleet TUIs run: branch, folder, model·effort, context meter, weekly usage, cost, diff churn — plus
# run-as + pending approvals when the session IS Agentric-launched (those env vars are absent here, so
# that half stays silent).
#
# The renderer is the SAME file the fleet uses — one source of truth, no forked copy to drift.
#
#   --uninstall   put back whatever `statusLine` was there before (or remove the key if none was)
#   --local       copy from this checkout instead of fetching from GitHub (for developing the bar)
#
# Honors $CLAUDE_CONFIG_DIR (default ~/.claude). Portable to bash 3.2 + BSD userland — this runs on
# other people's machines, which is exactly where the repo's macOS gotchas bite.
set -euo pipefail

RAW_URL="${AGENTRIC_STATUSLINE_URL:-https://raw.githubusercontent.com/vikasprogrammer/agentric/main/terminal/statusline.js}"
INSTALLER_URL="${AGENTRIC_INSTALLER_URL:-https://raw.githubusercontent.com/vikasprogrammer/agentric/main/scripts/install-statusline.sh}"
CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TARGET="$CFG_DIR/agentric-statusline.js"
SETTINGS="$CFG_DIR/settings.json"
PREV="$CFG_DIR/.agentric-statusline.prev.json"

MODE=install
SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) MODE=uninstall ;;
    --local) SRC="$(cd "$(dirname "$0")/.." && pwd)/terminal/statusline.js" ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || { echo "node not found — install Node 18+ first" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "node $NODE_MAJOR is too old — needs 18+" >&2; exit 1; }

mkdir -p "$CFG_DIR"

# Every settings.json edit goes through node: it is the user's real config (hooks, permissions, MCP
# servers) and a sed on JSON would eat it. Reads {} when the file is absent or corrupt-but-empty.
# Paths go in by ENV, not argv: `node -e` shifts process.argv (there is no script path), which is a
# quiet off-by-one that writes the wrong file rather than erroring.
patch_settings() { AOS_SL_SETTINGS="$SETTINGS" AOS_SL_PREV="$PREV" AOS_SL_TARGET="$TARGET" node -e "$1"; }

if [ "$MODE" = uninstall ]; then
  patch_settings '
    const fs = require("fs");
    const { AOS_SL_SETTINGS: settings, AOS_SL_PREV: prev } = process.env;
    let s = {};
    try { s = JSON.parse(fs.readFileSync(settings, "utf8")); } catch {}
    let restored = null;
    try { restored = JSON.parse(fs.readFileSync(prev, "utf8")); } catch {}
    if (restored && Object.keys(restored).length) s.statusLine = restored; else delete s.statusLine;
    fs.writeFileSync(settings, JSON.stringify(s, null, 2) + "\n");
    try { fs.unlinkSync(prev); } catch {}
    console.log(restored && Object.keys(restored).length
      ? "restored previous statusLine: " + JSON.stringify(restored)
      : "removed statusLine");
  '
  rm -f "$TARGET"
  echo "agentric status line uninstalled from $CFG_DIR"
  exit 0
fi

# Fetch (or copy) the renderer, then swap it in atomically so a half-written file never becomes the
# thing claude shells out to on every keystroke.
# Keep the .js extension on the temp file — `node --check` refuses an unknown extension.
TMP="$CFG_DIR/.agentric-statusline.tmp.$$.js"
trap 'rm -f "$TMP"' EXIT
if [ -n "$SRC" ]; then
  [ -f "$SRC" ] || { echo "no local renderer at $SRC" >&2; exit 1; }
  cp "$SRC" "$TMP"
else
  curl -fsSL "$RAW_URL" -o "$TMP" || { echo "could not fetch $RAW_URL" >&2; exit 1; }
fi
# A truncated download is the failure mode that leaves a blank bar with no error, so sanity-check the
# payload before it replaces a working renderer.
head -n1 "$TMP" | grep -q '^#!/usr/bin/env node' || { echo "downloaded file is not the renderer" >&2; exit 1; }
node --check "$TMP" || { echo "downloaded renderer does not parse" >&2; exit 1; }
mv "$TMP" "$TARGET"
chmod +x "$TARGET"

[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak"

patch_settings '
  const fs = require("fs");
  const { AOS_SL_SETTINGS: settings, AOS_SL_PREV: prev, AOS_SL_TARGET: target } = process.env;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settings, "utf8")); } catch (e) {
    if (fs.existsSync(settings) && fs.readFileSync(settings, "utf8").trim()) {
      console.error("settings.json exists but is not valid JSON — fix it first, nothing was changed");
      process.exit(1);
    }
  }
  const next = { type: "command", command: "node " + JSON.stringify(target), padding: 0, refreshInterval: 5 };
  const old = s.statusLine;
  // Only snapshot a statusLine that is not already ours, or a re-run would overwrite the real
  // previous value with our own and make --uninstall a no-op.
  if (old && !(old.command || "").includes("agentric-statusline.js")) {
    fs.writeFileSync(prev, JSON.stringify(old, null, 2) + "\n");
    console.log("replacing existing statusLine: " + JSON.stringify(old));
  }
  s.statusLine = next;
  fs.writeFileSync(settings, JSON.stringify(s, null, 2) + "\n");
'

echo "agentric status line installed"
echo "  renderer : $TARGET"
echo "  settings : $SETTINGS  (backup: $SETTINGS.bak)"
echo "  uninstall: curl -fsSL $INSTALLER_URL | bash -s -- --uninstall"
echo
echo "open a NEW claude session (or /statusline reload) to see it."
