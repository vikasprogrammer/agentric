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
#   HEADLESS   "1" → run non-interactively (`claude -p`) and exit when done (automations);
#              unset/empty → interactive attachable TUI that stays live (manual spawns)
#   LOG_DIR    where to tee the headless run transcript (headless only)
set -u
# RESUME path: ttyd's attach wrapper (attach.sh) re-launches us against a session whose tmux shell
# was killed (stopped/ended). The new tmux session does NOT inherit the original launch env, so
# recover it from the persisted file before doing anything else. Sets AGENT_DIR/HOOK/AOS_*/
# MCP_CONFIG/COMPANY_FILE/CLAUDE_SESSION_ID exactly as the first launch had them.
if [ "${RESUME:-}" = "1" ] && [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
# The `claude` CLI is commonly installed under ~/.local/bin; make sure it's findable even
# when the parent process (e.g. a hardened systemd unit) ships a minimal PATH.
export PATH="$HOME/.local/bin:$PATH"
TASK=$(printf '%s' "${TASK_B64:-}" | base64 -d 2>/dev/null)

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

cd "$AGENT_DIR" 2>/dev/null || { red "agent folder not found: $AGENT_DIR"; exec bash; }

# Wire the gate as a project-local PreToolUse hook. claude inherits AOS_URL/SESSION/AGENT from
# this shell's env, so the hook can reach the gateway and tag the right session. We regenerate
# the settings each launch so the hook path is always correct (and portable across machines).
# Pre-allow EVERY OS-owned tool so they're friction-free in interactive sessions — a single
# `mcp__agentos` entry approves all tools that server exposes (present and future: memory, KB, tasks,
# inbox, schedule, agent_*, secret_*, the conditional slack/discord tools, …). They're internal and
# safe to pre-allow at Claude's permission layer: every one goes through the loopback API, which derives
# identity from the session row and enforces the REAL governance server-side (e.g. secret_put still
# blocks for human approval; memory reads/writes only this agent's own namespace) — so approving them
# here only silences Claude's own prompt, it does NOT bypass Agent OS policy. The gate hook likewise
# `exit 0`s mcp__agentos__* (they aren't world side effects), so without this pre-allow the tools NOT
# on the old explicit list (revise/forget/update/check_inbox/schedule/agent_*/secret_*/…) prompted in
# interactive sessions. Enumerating a partial list caused exactly that gap; the server name covers all.
# The Notification hook lives beside the gate hook; derive its path so it's correct on every machine.
NOTIFY_HOOK="$(dirname "$HOOK")/notify-hook.sh"
# The Agent OS status line renderer (native claude statusLine) lives beside the hooks too.
STATUSLINE="$(dirname "$HOOK")/statusline.js"
# NO OS-level Bash sandbox. Governance is the gate hook (PreToolUse), which is now the SOLE
# authority: it emits an authoritative `permissionDecision` per Bash/connector call, so we don't
# also wrap the shell in Seatbelt/bubblewrap. The old sandbox was never a real boundary anyway —
# it walled the filesystem but NOT network egress (Claude's sandbox default is "prompt-then-allow"
# per domain, so `curl https://anywhere` returned 200), so it mostly added confusing double-denials
# (it blocked reads the policy allowed, e.g. an agent's own `~/.ssh` key for a sanctioned prod SSH)
# while giving a false sense of containment. Real OS containment, where we want it, is the Linux
# per-user uid-isolation path (src/edge/launcher.ts, AOS_UID_ISOLATION) — not this.
#
# We DO keep a small set of `permissions.deny` Read rules for crown-jewel paths. These govern the
# BUILT-IN Read/Glob/Grep tools (which the gate hook deliberately defers to Claude's own permission
# layer — they aren't world side effects). Bash reads are governed by the gate hook's intent check,
# not by a filesystem wall. We can't blanket-deny $HOME for the Read tool — the agent folder lives
# under it and a deny would block the agent reading its OWN files — so we deny only crown-jewel
# paths that never overlap the agent folder.
H="${HOME#/}"
DENYS="\"Read(//$H/.ssh/**)\", \"Read(//$H/.aws/**)\", \"Read(//$H/.gnupg/**)\", \"Read(//$H/.claude/**)\""
DATA_HOME="$(cd "$AGENT_DIR/../.." 2>/dev/null && pwd)"
if [ -n "$DATA_HOME" ]; then
  DH="${DATA_HOME#/}"
  DENYS="$DENYS, \"Read(//$DH/connectors/**)\", \"Read(//$DH/control/**)\", \"Read(//$DH/tenants/**)\", \"Read(//$DH/agent-os.db*)\""
fi
DENY_LINE=", \"deny\": [ $DENYS ]"
mkdir -p .claude
# Write to a NON-auto-discovered filename and load it via the `--settings` FLAG (see COMMON_ARGS below).
# Claude's workspace-TRUST gate ignores the permissions.allow entries of an AUTO-DISCOVERED
# .claude/settings.json in an untrusted folder — and agent folders are freshly created and never get the
# interactive trust dialog, so it printed "Ignoring N permissions.allow entries" and the OS tools
# (recall/remember/…) lost their pre-allow (prompting in interactive sessions). Settings provided via the
# --settings flag are NOT trust-gated, so the pre-allows are honored. (Hooks + deny rules apply either
# way — only `allow` is gated — verified.) Clear any stale auto-discovered file from older launches.
rm -f .claude/settings.json
cat > .claude/aos-settings.json <<JSON
{
  "permissions": {
    "allow": ["mcp__agentos"]$DENY_LINE
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*", "hooks": [ { "type": "command", "command": "bash '$HOOK'" } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command", "command": "bash '$NOTIFY_HOOK'" } ] }
    ]
  },
  "statusLine": { "type": "command", "command": "node '$STATUSLINE'", "padding": 1, "refreshInterval": 5 }
}
JSON

# Pre-accept the workspace-TRUST dialog for this agent folder. Freshly-created agent folders have
# never been trusted, so an INTERACTIVE claude would open with "Do you trust the files in this
# folder?" (headless already dodges it via --dangerously-skip-permissions). Trust is stored
# per-directory in ~/.claude.json under projects["<dir>"].hasTrustDialogAccepted; seed it so the
# dialog never fires. Keyed off the REAL $HOME of whatever user/lane runs this (local or uid-isolated).
# Idempotent (only writes on first launch of each agent), atomic (temp+rename), and never fatal —
# a failure here must not block the session. NOTE: this only bypasses the one-time TRUST gate; the
# PreToolUse gate hook + deny rules above still govern every effect, so security posture is unchanged.
if command -v node >/dev/null 2>&1; then
  AOS_TRUST_DIR="$AGENT_DIR" node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = process.env.AOS_TRUST_DIR;
    if (!dir) process.exit(0);
    const p = path.join(os.homedir(), ".claude.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { /* missing/empty/corrupt → start fresh */ }
    if (typeof cfg !== "object" || cfg === null) cfg = {};
    cfg.projects = cfg.projects || {};
    const cur = cfg.projects[dir] || {};
    if (cur.hasTrustDialogAccepted === true) process.exit(0);   // already trusted — nothing to do
    cur.hasTrustDialogAccepted = true;
    cfg.projects[dir] = cur;
    const tmp = p + ".aos-" + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);   // atomic replace
  ' 2>/dev/null || true
fi

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

# Connectors: if the OS materialised an .mcp.json for this session, hand it to claude so the
# agent gains the user's Slack/Gmail/etc. tools. --strict-mcp-config = use ONLY this config.
MCP_ARGS=()
if [ -n "${MCP_CONFIG:-}" ] && [ -f "${MCP_CONFIG}" ]; then
  MCP_ARGS=(--mcp-config "$MCP_CONFIG" --strict-mcp-config)
  dim "connectors: $(grep -o '"[a-z0-9-]*": {' "$MCP_CONFIG" | tr -d '":{ ' | paste -sd, -)"
fi

# Company context: the workspace-wide CLAUDE.md (voice, facts, conventions) every agent inherits.
# Appended to claude's system prompt so it doesn't have to live in each agent's folder.
SYS_ARGS=()
if [ -n "${COMPANY_FILE:-}" ] && [ -s "${COMPANY_FILE}" ]; then
  SYS_ARGS=(--append-system-prompt-file "$COMPANY_FILE")
  dim "company context: applied"
fi

# Skills: the OS synced the global skills library into .claude/skills/ before launch (there's no
# per-invocation skills flag — claude auto-discovers project-level .claude/skills/<name>/SKILL.md).
if [ -d .claude/skills ]; then
  # Portable directory listing — BSD `find` (macOS) has no GNU `-printf`, so iterate with a shell glob.
  SKILLS=$(cd .claude/skills 2>/dev/null && for d in */; do [ -d "$d" ] && printf '%s\n' "${d%/}"; done | sort | paste -sd, -)
  [ -n "$SKILLS" ] && dim "skills: $SKILLS"
fi

# Tell Agent OS the run ended → the Inbox shows a completion card (unless the agent already
# reported a richer outcome via the `report` tool) and the session is marked idle.
notify_ended() {
  curl -s -X POST "$AOS_URL/api/ended" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}

# Tell Agent OS a stopped session was reconnected → flip the row back to running in the console.
notify_resumed() {
  curl -s -X POST "$AOS_URL/api/resumed" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}

# Per-agent runtime tuning, resolved by the server (agent manifest → workspace default) and passed
# in as env. Model + effort apply to both lanes (COMMON_ARGS below). An empty var means "inherit" — we
# add no flag, so the claude CLI's own default stands. CLAUDE_PERMISSION_MODE is handled separately,
# AFTER the headless branch exits, so `--permission-mode` lands on the INTERACTIVE lane only. It doesn't
# weaken governance: the gate hook still emits an authoritative PreToolUse decision for every governed
# tool (which bypasses Claude's own permission engine); the mode only tunes the fallback for the tools
# the hook leaves alone (Read/WebFetch/…), and `auto` keeps an idle pane from hanging on a native prompt.
RUNTIME_ARGS=()
[ -n "${CLAUDE_MODEL:-}" ]  && RUNTIME_ARGS+=(--model "$CLAUDE_MODEL")
[ -n "${CLAUDE_EFFORT:-}" ] && RUNTIME_ARGS+=(--effort "$CLAUDE_EFFORT")
[ -n "${CLAUDE_MODEL:-}${CLAUDE_EFFORT:-}" ] && \
  dim "tuning: model=${CLAUDE_MODEL:-default} effort=${CLAUDE_EFFORT:-default}"

# bash 3.2 (macOS default) errors on expanding an EMPTY array under `set -u`; the `[@]+` guard
# expands to nothing when MCP_ARGS/SYS_ARGS are empty instead of tripping "unbound variable".
COMMON_ARGS=(--settings .claude/aos-settings.json "${MCP_ARGS[@]+"${MCP_ARGS[@]}"}" "${SYS_ARGS[@]+"${SYS_ARGS[@]}"}" "${RUNTIME_ARGS[@]+"${RUNTIME_ARGS[@]}"}")

if [ "${HEADLESS:-}" = "1" ]; then
  # Headless lane (automations): run the task to completion non-interactively, then EXIT. The pane
  # dies → tmux drops the session → Agent OS marks it idle and the pile-up guard releases, so the
  # next cron/webhook firing isn't skipped. No TUI, so the interactive-scroll issues don't apply.
  #
  # --dangerously-skip-permissions: there's no human to answer permission prompts here, and in -p
  # mode an unapproved tool would otherwise ABORT the run. The SAME PreToolUse gate hook still runs
  # and still BLOCKS risky Bash for inbox approval even under this flag — so Bash stays governed;
  # the flag only removes the prompts claude can't ask non-interactively.
  LOG="${LOG_DIR:-/tmp}/session-$SESSION.log"
  # Create the transcript 0600 before writing — it can contain connector output / secrets, so it must
  # not be world-readable (matches the 0600 .mcp.json the server writes). umask in a subshell so the
  # restriction applies only to this file, not to anything claude writes during the run.
  ( umask 077; : > "$LOG" ) 2>/dev/null || true
  dim "headless run — transcript → $LOG. This pane closes when the task completes."
  echo
  claude -p "$TASK" --dangerously-skip-permissions "${COMMON_ARGS[@]}" 2>&1 | tee -a "$LOG"
  notify_ended
  exit 0
fi

# INTERACTIVE lane only (the headless branch above already exited). Add the permission mode here — NOT
# in COMMON_ARGS — so it never touches the headless `-p --dangerously-skip-permissions` run. Defaults to
# `auto` if the env is unset (e.g. resuming a session launched before this knob existed).
COMMON_ARGS+=(--permission-mode "${CLAUDE_PERMISSION_MODE:-auto}")
dim "permission mode: ${CLAUDE_PERMISSION_MODE:-auto} (gate hook still governs every side effect)"

# Fullscreen rendering for the TUI. Inside tmux, claude's normal renderer degrades — the scrollbar
# vanishes and the mouse wheel scrolls the input history instead of the conversation. Fullscreen mode
# draws to the alternate screen and restores proper scroll + selection in the browser terminal.
# Harmless in the headless lane above (no TUI), so exporting it here in the interactive path keeps it
# scoped to the sessions that actually render a TUI.
export CLAUDE_CODE_NO_FLICKER=1

# Clipboard: copy has to go THROUGH ttyd's xterm.js, and this ttyd (1.7.7) copies ONLY off its own
# `onSelectionChange` (it runs document.execCommand("copy") on the xterm.js selection). It registers
# NO OSC 52 handler, so claude's own copy-on-select escape is silently dropped — letting claude capture
# the mouse means xterm.js never gets a selection and nothing reaches the browser clipboard at all.
# So we must hand selection to xterm.js. DISABLE_MOUSE_CLICKS (not full DISABLE_MOUSE) keeps claude's
# WHEEL capture — so in-app scroll still works — while releasing click/drag to the terminal. But while
# mouse events are active xterm.js disables its selection service, and the ONLY way to override that is
# its `shouldForceSelection` modifier: on macOS that's OPTION held during the drag, and ONLY when the
# xterm option `macOptionClickForcesSelection` is on (Shift is the non-Mac modifier — it does nothing on
# a Mac). ttyd doesn't set that option by default, so we pass it via `-t macOptionClickForcesSelection`
# in launchTtyd (src/tenant-registry.ts). Net: in-app scroll works, and OPTION+drag selects in xterm.js,
# which ttyd copies to the user's machine (✂ overlay). For the copy to actually land the terminal iframe
# must carry `allow="clipboard-write"` (web/src/App.tsx) or the browser blocks execCommand in the frame.
export CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1

# Interactive session in this folder, governed by the local hook. We pin claude to a session id
# WE chose (CLAUDE_SESSION_ID) so a stopped session can later be resumed in-place by that id.
# NOTE: do NOT `exec` claude. When claude exits we fall back to a live shell so the tmux session
# stays alive — otherwise the pane dies and ttyd would loop showing "Reconnecting".
if [ "${RESUME:-}" = "1" ] && [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  # Reconnect to a stopped session: reopen the SAME conversation (no task re-seed — it's already
  # in the transcript). If resume fails (e.g. claude never persisted a turn before it was stopped),
  # fall back to a fresh session under the same id, seeded with the original task.
  notify_resumed
  dim "resuming claude session $CLAUDE_SESSION_ID …"
  echo
  claude --resume "$CLAUDE_SESSION_ID" "${COMMON_ARGS[@]}" \
    || claude --session-id "$CLAUDE_SESSION_ID" "${COMMON_ARGS[@]}" "$TASK"
elif [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  claude --session-id "$CLAUDE_SESSION_ID" "${COMMON_ARGS[@]}" "$TASK"
else
  claude "${COMMON_ARGS[@]}" "$TASK"
fi
notify_ended

# SECURITY: do NOT drop to a raw shell when claude exits. A tmux shell is NOT Seatbelt-sandboxed and
# has NO PreToolUse gate hook, so `exec bash` here would hand whoever is attached full, ungoverned
# access as the app user — reading ~/.ssh, the workspace DB, every tenant's data, the network — a
# complete bypass of BOTH the sandbox and the approval gate. (On Linux the uid-isolation path confines
# even a fallback shell; this is the macOS local-mode equivalent.) Keep the pane alive — so ttyd doesn't
# loop "Reconnecting" — with a no-shell holding prompt that can ONLY re-open claude (resume) or close.
echo
while true; do
  dim "claude session ended — press [r] to resume, [q] to close the tab."
  key=""
  IFS= read -rsn1 key || { sleep 2; continue; }   # blocked read is fine; EOF/detached → idle, no spin
  case "$key" in
    r|R)
      notify_resumed
      claude --resume "${CLAUDE_SESSION_ID:-}" "${COMMON_ARGS[@]}" \
        || claude --session-id "${CLAUDE_SESSION_ID:-}" "${COMMON_ARGS[@]}" "$TASK"
      notify_ended
      ;;
    q|Q) exit 0 ;;
    *) : ;;   # ignore any other key — never spawn a shell
  esac
done
