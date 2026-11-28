#!/usr/bin/env bash
# Antigravity CLI (`agy`) launcher — opens Google's Antigravity agent IN THE AGENT'S FOLDER, governed by
# Agentric. Same shape as codex-launch.sh (read claude-launch.sh first); everything runtime-specific was
# verified against agy 1.5.18/1.5.19 on 2026-11-28 — see docs/antigravity-runtime.md for the probe log.
#
# HOW THE INVARIANT IS UPHELD HERE:
#   1. ONE gate for every effect. agy runs a PreToolUse command hook before EVERY tool call — shell,
#      file writes, MCP calls, and subagents' calls too — and treats a hook that crashes, times out or
#      prints no decision as a DENY. terminal/antigravity-gate-hook.sh translates agy's wire into the
#      shared gate-hook.sh, and denies any tool it does not recognise.
#   2. --dangerously-skip-permissions, because a hook `allow` does NOT bypass agy's own permission
#      engine (headless auto-denies, the TUI prompts a human a second time). In 1.5.x the flag still
#      runs hooks (a public write-up saying otherwise was about 1.1.21) — so, exactly as on the Claude
#      lane, Agentric is the sole authority and the hook is the gate.
#   3. The hook lives in the GLOBAL ~/.gemini/config/hooks.json, not the workspace one: a global hook
#      fires even in an UNTRUSTED workspace, while a workspace hook does not load there at all — and an
#      untrusted TUI still runs its `-i` prompt behind the trust dialog. So a missed trust seed below
#      degrades to "governed, waiting on a dialog", never to "ungoverned".
#   4. The global entries are SESSION-AGNOSTIC: hook and MCP processes inherit agy's environment, so
#      each one finds its session through $AOS_AGY_GATE / $AOS_AGY_HUB / $MCP_CONFIG. Concurrent sessions,
#      agents and tenants on one box never write per-session data into a shared file. Outside an
#      Agentric session (the box owner running agy for themselves) both entries step aside.
#   5. GEMINI_API_KEY / AGY_ADC_AUTH are STRIPPED: hooks were reported not firing under API-key and ADC
#      auth (google-antigravity/antigravity-cli#893, #1310). Only the Google sign-in is used.
#
# Env (exported by the server when it spawns the tmux session):
#   AOS_URL SESSION AGENT AGENT_DIR TASK_FILE HOOK(=antigravity-gate-hook.sh) AOS_RUNTIME MCP_CONFIG
#   COMPANY_FILE AGY_MODEL AGY_EFFORT UNATTENDED RESIDENT RESUME RUNTIME_SESSION_ID ENV_FILE
set -u

RESUMED_FROM_ENV=
if [ "${RESUME:-}" = "1" ] && [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  RESUMED_FROM_ENV=1
fi

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -n "${TASK_FILE:-}" ] && [ -f "${TASK_FILE}" ]; then
  TASK=$(cat "${TASK_FILE}")
else
  TASK=$(printf '%s' "${TASK_B64:-}" | base64 -d 2>/dev/null)
fi

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

notify_ended() {
  curl -s -X POST "$AOS_URL/api/ended" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}
notify_resumed() {
  curl -s -X POST "$AOS_URL/api/resumed" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}
# Refuse to start, with the fix spelled out. Unattended runs EXIT (so tmux drops the pane and the pile-up
# guard releases); an interactive pane holds so the operator can read why — but never drops to a shell,
# which would have no gate at all.
refuse() {
  notify_ended
  [ "${UNATTENDED:-}" = "1" ] && exit 1
  while true; do
    dim "Press [q] to close this tab."
    key=""
    IFS= read -rsn1 key || { sleep 5; continue; }
    case "$key" in q|Q) exit 1 ;; *) : ;; esac
  done
}

cd "$AGENT_DIR" 2>/dev/null || { red "agent folder not found: $AGENT_DIR"; refuse; }

if ! command -v agy >/dev/null 2>&1; then
  red "the 'agy' CLI (Antigravity) is not on PATH — install it from Settings → Runtime → Runtimes,"
  red "or as this user:  curl -fsSL https://antigravity.google/cli/install.sh | sh"
  red "the session cannot start ungoverned, so it will not start at all."
  refuse
fi

# ── credentials ───────────────────────────────────────────────────────────────────────────────────
# File storage, always. agy otherwise picks the macOS Keychain or a token file depending on whether it
# THINKS it is in an ssh session — so the same box could be "signed in" for one lane and not another
# (a launchd-spawned pane has no SSH_* vars). The file is also what the pre-flight below can see.
export AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1
# Agentric pins the CLI; an in-pane self-update replaces the binary every other session is running and
# changes governance-relevant behaviour under us (agy updated itself mid-probe, 1.5.18 → 1.5.19).
export AGY_CLI_DISABLE_AUTO_UPDATE=1
unset GEMINI_API_KEY AGY_ADC_AUTH
AGY_DIR="${AOS_REAL_AGY_DIR:-$HOME/.gemini/antigravity-cli}"
if [ ! -s "$AGY_DIR/antigravity-oauth-token" ]; then
  red "Antigravity is not signed in — refusing to start."
  echo
  dim "Agentric looked for the sign-in at:  $AGY_DIR/antigravity-oauth-token"
  dim "Fix it ONCE, from a normal shell as this user (NOT inside an agent session):"
  echo
  cyan "    AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy      # complete the Google sign-in, then /exit"
  echo
  dim "Every session reads that file, so one sign-in covers the fleet. API-key and ADC auth are"
  dim "deliberately not used: the governance hook is not reliably run under them."
  refuse
fi

# ── protected read paths (the shared gate hook's Read arm) ────────────────────────────────────────
# Same list as claude-launch.sh: agy's read_file is translated to a `Read` and judged locally against it.
# (The adapter separately refuses ~/.gemini reads outside this conversation's artifacts + MCP schemas.)
H="$HOME"
PROTECTED="$H/.ssh
$H/.aws
$H/.gnupg
$H/.claude
$H/.codex/auth.json"
DATA_HOME="$(cd "$AGENT_DIR/../.." 2>/dev/null && pwd)"
if [ -n "$DATA_HOME" ]; then
  PROTECTED="$PROTECTED
$DATA_HOME/connectors
$DATA_HOME/control
$DATA_HOME/tenants
$DATA_HOME/agent-os.db
$DATA_HOME/agent-os.db-wal
$DATA_HOME/agent-os.db-shm
$DATA_HOME/secret.key"
fi
export AOS_PROTECTED_PATHS="$PROTECTED"

# ── global hook + MCP entries (session-agnostic, idempotent) ──────────────────────────────────────
TERM_DIR="$(cd "$(dirname "$HOOK")" && pwd)"
export AOS_AGY_GATE="$HOOK"
export AOS_GATE_HOOK="$TERM_DIR/gate-hook.sh"
export AOS_AGY_HUB="$TERM_DIR/antigravity-mcp-hub.js"
AOS_AGENT_DIR="$AGENT_DIR" node -e '
  const fs = require("fs"), path = require("path"), os = require("os");
  const cfgDir = path.join(os.homedir(), ".gemini", "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  // Merge OUR key into a JSON file, keeping everything else, and only touch the file when the content
  // changes — agy hot-reloads these, so a rewrite on every launch would churn every live session.
  const merge = (file, mutate) => {
    let j = {};
    // agy itself creates mcp_config.json as an EMPTY file on first run — that is "no servers", not corrupt.
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (raw.trim()) { try { j = JSON.parse(raw); } catch (e) { throw new Error(file + " is not valid JSON — fix or remove it: " + e.message); } }
    if (!j || typeof j !== "object" || Array.isArray(j)) j = {};
    const before = JSON.stringify(j);
    mutate(j);
    if (JSON.stringify(j) === before) return;
    const tmp = file + ".aos-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // In a session $AOS_AGY_GATE names this tenant`s adapter; outside one, step aside for the box owner.
  const hook = (fallback) => "if [ -n \"${AOS_AGY_GATE:-}\" ]; then exec bash \"${AOS_AGY_GATE}\"; fi; printf %s \x27" + fallback + "\x27";
  merge(path.join(cfgDir, "hooks.json"), (j) => {
    j.agentric = {
      SessionStart: [{ type: "command", command: hook("{}") }],
      // A pending approval blocks inside the hook until a human decides (unattended runs time out to a
      // deny on their own), so the hook timeout must outlast it — agy kills a timed-out hook and denies.
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook("{\"decision\":\"allow\"}"), timeout: 86400 }] }],
      Stop: [{ type: "command", command: hook("{}") }],
    };
  });
  const idle = "require(\"readline\").createInterface({input:process.stdin}).on(\"line\",l=>{let m;try{m=JSON.parse(l)}catch(e){return}if(m.id===undefined)return;const r=m.method===\"initialize\"?{protocolVersion:(m.params||{}).protocolVersion||\"2025-03-26\",capabilities:{tools:{}},serverInfo:{name:\"agentric\",version:\"1\"}}:m.method===\"tools/list\"?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:\"2.0\",id:m.id,result:r})+\"\\n\")})";
  merge(path.join(cfgDir, "mcp_config.json"), (j) => {
    j.mcpServers = j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
    j.mcpServers.agentric = { command: "sh", args: ["-c", "if [ -n \"${AOS_AGY_HUB:-}\" ]; then exec node \"${AOS_AGY_HUB}\"; fi; exec node -e \x27" + idle + "\x27"] };
  });
  // Pre-accept the folder-trust dialog (the analogue of Claude`s hasTrustDialogAccepted seed). Seeded
  // under the REAL path too: a home reached through a symlink otherwise misses and the TUI parks on it.
  const settings = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  merge(settings, (j) => {
    const list = Array.isArray(j.trustedWorkspaces) ? j.trustedWorkspaces : [];
    const dir = process.env.AOS_AGENT_DIR;
    let realDir = dir; try { realDir = fs.realpathSync(dir); } catch (_) {}
    for (const d of new Set([dir, realDir])) if (!list.includes(d)) list.push(d);
    j.trustedWorkspaces = list;
  });
' || { red "failed to install the Antigravity governance hook — refusing to start ungoverned."; refuse; }

# Belt and braces: the hook must be in place BEFORE agy starts. If the file we just wrote does not carry
# our PreToolUse entry, something else owns it — do not start.
node -e '
  const j = JSON.parse(require("fs").readFileSync(require("os").homedir() + "/.gemini/config/hooks.json", "utf8"));
  const pre = j.agentric && j.agentric.enabled !== false && j.agentric.PreToolUse && j.agentric.PreToolUse[0];
  process.exit(pre && pre.matcher === "*" ? 0 : 1);
' 2>/dev/null || { red "~/.gemini/config/hooks.json does not carry the Agentric gate — refusing to start ungoverned."; refuse; }
# A workspace hooks.json can DISABLE a global hook by name (verified). Refuse to open a folder that has one.
for d in "$AGENT_DIR"/.agents "$AGENT_DIR"/.agent "$AGENT_DIR"/_agents "$AGENT_DIR"/_agent; do
  if [ -f "$d/hooks.json" ]; then
    red "$d/hooks.json exists. A workspace hooks file can switch the Agentric gate off, so this agent will"
    red "not start while it is there. Remove it (it is never written by Agentric) and re-run."
    refuse
  fi
done

# ── AGENTS.md (system prompt) ─────────────────────────────────────────────────────────────────────
# agy reads AGENTS.md / GEMINI.md from the workspace, never CLAUDE.md — so compose AGENTS.md from the
# agent's runtime-neutral persona (CLAUDE.md) + the workspace Company context, as the Codex launcher does.
node -e '
  const fs = require("fs");
  const [persona, company, dest] = process.argv.slice(1);
  const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch (_) { return ""; } };
  const parts = ["<!-- Generated by Agentric at launch. Edits are overwritten; change the agent or Company context instead. -->"];
  const p = read(persona), c = read(company);
  if (p) parts.push(p);
  if (c) parts.push(c);
  if (p || c) fs.writeFileSync(dest, parts.join("\n\n") + "\n");
' "$AGENT_DIR/CLAUDE.md" "${COMPANY_FILE:-}" "$AGENT_DIR/AGENTS.md" 2>/dev/null || true

clear
cyan "┌─ Agentric · governed Antigravity ───────────────────────────"
cyan "│ agent:   $AGENT"
cyan "│ session: $SESSION"
cyan "│ folder:  $AGENT_DIR"
cyan "│ task:    $TASK"
cyan "└─────────────────────────────────────────────────────────────"
echo
dim "Real Antigravity CLI, opened in this agent's folder. Every tool call — shell, file writes, MCP,"
dim "subagents — passes the Agentric gate; risky ones pause here and surface as an inbox approval."
[ -n "${AGY_MODEL:-}${AGY_EFFORT:-}" ] && dim "tuning: model=${AGY_MODEL:-default} effort=${AGY_EFFORT:-default}"
MCP_NAMES=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(c.mcpServers||{}).join(", "))}catch(e){}' "${MCP_CONFIG:-/nonexistent}" 2>/dev/null)
[ -n "$MCP_NAMES" ] && dim "connectors (via the agentric MCP server): $MCP_NAMES"
if [ "${UNATTENDED:-}" = "1" ]; then
  dim "unattended run — attachable TUI; take it over anytime. Closes at turn-end."
elif [ "${RESIDENT:-}" = "1" ]; then
  dim "resident warm chat session — kept warm for fast follow-ups."
fi
echo

# `agentMode: ""` pins Default mode. agy's default is now AUTO, which on its own approves commands with no
# hook at all (verified) — irrelevant while the hook runs, but it must never be the thing deciding.
# `--log-file <connectors>/session-<id>.agy.log` goes FIRST: besides keeping agy's log with the session's
# other files, it puts the session id at the front of agy's argv, which is how the process janitor finds an
# agy whose pane is gone (see process-janitor.ts) — argv truncation in `ps` would hide anything later.
ARGS=()
[ -n "${MCP_CONFIG:-}" ] && ARGS+=(--log-file "${MCP_CONFIG%.mcp.json}.agy.log")
ARGS+=(--dangerously-skip-permissions --settings '{"agentMode":""}')
[ -n "${AGY_MODEL:-}" ] && ARGS+=(--model "$AGY_MODEL")
[ -n "${AGY_EFFORT:-}" ] && ARGS+=(--effort "$AGY_EFFORT")

# agy does NOT exit when its terminal goes away (verified on 1.5.19: tmux kill-session left agy and the MCP
# hub running, orphaned). The server tears a session down by killing its pane, which HUPs this script — but
# bash defers a trap until a FOREGROUND child returns, so a plain `agy …` would never be signalled. Run it as
# a waited background child instead (`wait` IS interruptible by a trap), with the pane's terminal handed to
# it explicitly (`<&0` — a non-interactive shell would otherwise give a background job /dev/null).
AGY_PID=
stop_agy() { [ -n "${AGY_PID:-}" ] && kill -TERM "$AGY_PID" 2>/dev/null; sleep 1; [ -n "${AGY_PID:-}" ] && kill -KILL "$AGY_PID" 2>/dev/null; return 0; }
trap 'stop_agy; exit 129' HUP
trap 'stop_agy; exit 143' TERM
trap 'stop_agy; exit 130' INT
agy_run() { agy "$@" <&0 & AGY_PID=$!; wait "$AGY_PID"; local rc=$?; AGY_PID=; return $rc; }
run_fresh() { if [ -n "${TASK:-}" ]; then agy_run "${ARGS[@]}" -i "$TASK"; else agy_run "${ARGS[@]}"; fi; }

if [ "${RESUME:-}" = "1" ] && [ -n "${RUNTIME_SESSION_ID:-}" ]; then
  notify_resumed
  dim "resuming Antigravity conversation $RUNTIME_SESSION_ID …"
  # A browser reattach must NOT re-send $TASK (it is already in the conversation); a server-driven
  # follow-up spawns a fresh pane with no ENV_FILE and a genuinely new $TASK, so that one does.
  if [ -z "${RESUMED_FROM_ENV:-}" ] && [ -n "${TASK:-}" ]; then
    agy_run "${ARGS[@]}" --conversation "$RUNTIME_SESSION_ID" -i "$TASK" || run_fresh
  else
    agy_run "${ARGS[@]}" --conversation "$RUNTIME_SESSION_ID" || run_fresh
  fi
else
  run_fresh
fi
notify_ended

# SECURITY: never drop to a raw shell when agy exits — a tmux shell has no gate.
echo
while true; do
  dim "Antigravity session ended — press [r] to resume, [q] to close the tab."
  key=""
  IFS= read -rsn1 key || { sleep 2; continue; }
  case "$key" in
    r|R)
      notify_resumed
      if [ -n "${RUNTIME_SESSION_ID:-}" ]; then agy_run "${ARGS[@]}" --conversation "$RUNTIME_SESSION_ID" || run_fresh; else run_fresh; fi
      notify_ended
      ;;
    q|Q) exit 0 ;;
    *) : ;;
  esac
done
