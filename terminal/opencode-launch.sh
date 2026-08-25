#!/usr/bin/env bash
# opencode launcher — opens an opencode session DIRECTLY IN THE AGENT'S FOLDER, governed by Agentric.
# The Claude Code counterpart is claude-launch.sh and the Codex one is codex-launch.sh; read either
# first, this is the same shape with the runtime-specific bits swapped.
#
# HOW THE INVARIANT IS UPHELD HERE (it differs from both other lanes, deliberately):
#   1. There is NO command-hook mechanism in opencode. Its only pre-execution extension point is a
#      JS PLUGIN, so the shared terminal/gate-hook.sh cannot be used. $HOOK points at
#      terminal/opencode-gate-plugin.js, which we copy into this session's plugin dir; its
#      `tool.execute.before` routes every tool to a capability, POSTs /api/gate, and BLOCKS BY
#      THROWING on a deny. Same server contract, same fail-closed posture.
#   2. shell.exec / file.write / net.fetch / connector.call — all reach that one hook, because
#      opencode fires it for EVERY tool (bash, edit/write/patch, webfetch/websearch, mcp__*). So
#      unlike the Codex lane there is no reliance on an OS sandbox for writes.
#   3. Sub-agents are DISABLED (`tools.task = false` here, plus a refusal in the plugin). opencode's
#      plugin hooks are not confirmed to fire for a sub-agent's own tool calls
#      (anomalyco/opencode#6396), and an un-hooked sub-agent would act with no gate and no audit.
#      Belt and braces: config removes the tool, the plugin refuses it if it ever reappears.
#   4. permission.* = "allow" — Agentric is the SOLE authority, exactly as the Claude lane sets
#      --dangerously-skip-permissions and the Codex lane sets approval_policy = "never". It removes
#      opencode's OWN prompts (which nobody is there to answer), NOT our gate: anything reaching
#      opencode's permission layer has already passed the plugin.
#
# Env (exported by the server when it spawns the tmux session):
#   AOS_URL        base url of the agent-os server   (e.g. http://127.0.0.1:3010)
#   SESSION        session id
#   AGENT          agent id (matches the manifest / its folder name)
#   AGENT_DIR      the agent's folder — opencode opens here and writes its scratch here
#   TASK_FILE      path to the opening prompt (TASK_B64 is the legacy inline fallback)
#   HOOK           absolute path to opencode-gate-plugin.js (the gate)
#   AOS_RUNTIME    "opencode"
#   MCP_CONFIG     path to the session's mcpServers JSON (converted to opencode's schema below)
#   COMPANY_FILE   workspace Company context markdown (folded into AGENTS.md below)
#   OPENCODE_MODEL resolved runtime tuning, `provider/model` ("" → inherit the CLI default)
#   UNATTENDED     "1" → an automation/cron/task run: one-shot `opencode run`, exits at turn end
#   RESUME         "1" → continue RUNTIME_SESSION_ID instead of starting fresh
#   FORK_FROM      branch a new conversation off this session id (first launch only)
set -u

# RESUME path: the ttyd attach wrapper re-launches us against a session whose tmux shell was killed.
# The new tmux session does NOT inherit the original launch env, so recover it first.
if [ "${RESUME:-}" = "1" ] && [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

# `opencode` is commonly installed under a node prefix or homebrew bin; make sure it's findable even
# when the parent process (e.g. a hardened systemd unit) ships a minimal PATH.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# The opening task prompt. Prefer TASK_FILE (a path the server materialised) over the inline TASK_B64
# env — LocalSessionBackend puts every env var on the `tmux new-session` command line, which tmux caps
# at ~16KB, so a large base64 task there makes new-session fail and the run never launches.
if [ -n "${TASK_FILE:-}" ] && [ -f "${TASK_FILE}" ]; then
  TASK=$(cat "${TASK_FILE}")
else
  TASK=$(printf '%s' "${TASK_B64:-}" | base64 -d 2>/dev/null)
fi

cyan() { printf '\033[36m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }

cd "$AGENT_DIR" 2>/dev/null || { red "agent folder not found: $AGENT_DIR"; exec bash; }

notify_ended_early() {
  curl -s -X POST "$AOS_URL/api/ended" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}

# Park the pane on a fatal pre-flight problem. Unattended runs must EXIT so tmux drops the pane and
# the pile-up guard releases; an interactive session holds the pane (so the operator can read the
# message) but never drops to a shell — a raw tmux shell has no gate and no containment.
park() {
  notify_ended_early
  [ "${UNATTENDED:-}" = "1" ] && exit 1
  while true; do
    dim "Press [q] to close this tab."
    key=""
    IFS= read -rsn1 key || { sleep 5; continue; }
    case "$key" in q|Q) exit 1 ;; *) : ;; esac
  done
}

if ! command -v opencode >/dev/null 2>&1; then
  red "the 'opencode' CLI is not on PATH — install it from Settings → Runtimes, or run:"
  echo
  cyan "    npm i -g opencode-ai"
  echo
  red "the session cannot start ungoverned, so this pane will idle."
  park
fi

# ── auth pre-flight ───────────────────────────────────────────────────────────────────────────────
# opencode keeps credentials at $XDG_DATA_HOME/opencode/auth.json (default ~/.local/share). Rotation
# may point XDG_DATA_HOME at a pooled account dir; otherwise we use the box default. Refuse to start
# unauthenticated: opencode's fallback is an interactive provider picker that waits on a keypress,
# which parks an unattended run forever — the same permanent-hang class as the Claude lane's
# folder-trust dialog and the Codex sign-in menu.
OC_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
if [ ! -s "$OC_DATA_HOME/opencode/auth.json" ] && [ -z "${OPENCODE_API_KEY:-}" ]; then
  red "opencode is not authenticated — refusing to start."
  echo
  dim "Agentric looked for credentials at:  $OC_DATA_HOME/opencode/auth.json"
  dim "Fix it ONCE, from a normal shell as this user (NOT inside an agent session):"
  echo
  cyan "    opencode auth login"
  echo
  dim "Alternatively give this agent an OPENCODE_API_KEY (Settings → Secrets), or a provider key"
  dim "such as ANTHROPIC_API_KEY / OPENAI_API_KEY, for usage-based billing."
  echo
  park
fi

# ── the gate plugin ───────────────────────────────────────────────────────────────────────────────
# opencode auto-discovers `.opencode/plugin/*.js` from the project root. Copy (not symlink) so the
# session keeps working if the repo moves mid-run, and refuse to start if it cannot be placed — an
# opencode session without this file is an UNGOVERNED agent.
PLUGIN_DIR="$AGENT_DIR/.opencode/plugin"
mkdir -p "$PLUGIN_DIR" || { red "cannot create $PLUGIN_DIR — refusing to start ungoverned."; park; }
# The `.js` extension is LOAD-BEARING: opencode discovers `.opencode/plugin/*.js` and silently
# ignores `.mjs`/`.ts` — a renamed plugin never loads and never warns. Pinned by
# scripts/opencode-gate-test.cjs.
if ! cp "$HOOK" "$PLUGIN_DIR/aos-gate.js"; then
  red "failed to install the Agentric gate plugin — refusing to start ungoverned."
  park
fi

# ── opencode.json ─────────────────────────────────────────────────────────────────────────────────
# Generated fresh each launch (so paths are always correct and portable across machines), from the
# session's MCP JSON. Written to a per-session path and selected with $OPENCODE_CONFIG so the
# operator's own config is never disturbed.
OC_CONFIG="$AGENT_DIR/.opencode/aos-config.json"
AOS_MCP_CONFIG="${MCP_CONFIG:-}" \
AOS_MODEL="${OPENCODE_MODEL:-}" \
AOS_OC_CONFIG="$OC_CONFIG" \
node -e '
  const fs = require("fs");
  const cfg = {
    // FAIL-CLOSED BY CONSTRUCTION. These stay "ask" — they are NOT the posture we want at runtime,
    // and the gate plugin flips each one to "allow" from its `permission.ask` hook once it has
    // decided. The point is what happens when the plugin is NOT loaded: opencode discovers
    // `.opencode/plugin/*.js` and SILENTLY IGNORES any other extension (verified against 1.17 — a
    // `.mjs` or `.ts` copy of the same file never loads and prints no warning). Had this said
    // "allow", a plugin that failed to load would produce a fully ungoverned agent that looked
    // completely normal. With "ask", the same failure degrades to opencode prompting — which an
    // unattended run simply blocks on — so no ungoverned effect is possible either way.
    permission: { edit: "ask", bash: "ask", webfetch: "ask", doom_loop: "ask", external_directory: "ask" },
    // Sub-agents off — see header note 3. Config removes the tool; the plugin also refuses it.
    tools: { task: false },
    // Never let a session self-update or advertise an update: Agentric pins the CLI deliberately, and
    // an in-pane update prompt is another keypress-waiting hang on an unattended run.
    autoupdate: false,
    // A shared conversation would publish the agents transcript to a public URL. Off, always.
    share: "disabled",
  };
  if (process.env.AOS_MODEL) cfg.model = process.env.AOS_MODEL;
  const file = process.env.AOS_MCP_CONFIG;
  if (file && fs.existsSync(file)) {
    let src = {};
    try { src = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { src = {}; }
    const mcp = {};
    for (const [name, s] of Object.entries(src.mcpServers || {})) {
      if (!s) continue;
      if (s.url) {
        mcp[name] = { type: "remote", url: s.url, enabled: true, timeout: 30000 };
        if (s.headers && Object.keys(s.headers).length) mcp[name].headers = s.headers;
      } else if (s.command) {
        // opencode takes ONE `command` array (argv), not command + args like the Claude schema.
        mcp[name] = { type: "local", command: [s.command, ...(s.args || [])], enabled: true, timeout: 30000 };
        if (s.env && Object.keys(s.env).length) mcp[name].environment = s.env;
      }
    }
    if (Object.keys(mcp).length) cfg.mcp = mcp;
  }
  fs.writeFileSync(process.env.AOS_OC_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
' || { red "failed to generate the opencode config — refusing to start ungoverned."; park; }
export OPENCODE_CONFIG="$OC_CONFIG"

# ── AGENTS.md (system prompt) ─────────────────────────────────────────────────────────────────────
# opencode has no --append-system-prompt-file; like Codex it discovers AGENTS.md from the workspace
# root. CLAUDE.md is the runtime-neutral persona file every agent already has and is NOT auto-loaded
# by anything except Claude Code, so the OS composes AGENTS.md from it plus the workspace Company
# context. Regenerated each launch and clearly marked, so a human editing it knows it is not
# hand-maintained.
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

# ── launch ────────────────────────────────────────────────────────────────────────────────────────
# Session continuity: opencode mints its own id (reported back by the plugin, which sees `sessionID`
# on every hook). RESUME continues that transcript; FORK_FROM branches off it on a first launch.
# RESUME is checked first so a later reattach continues THIS branch instead of re-forking.
ARGS=()
[ -n "${OPENCODE_MODEL:-}" ] && ARGS+=(--model "$OPENCODE_MODEL")
if [ "${RESUME:-}" = "1" ] && [ -n "${RUNTIME_SESSION_ID:-}" ]; then
  ARGS+=(--session "$RUNTIME_SESSION_ID")
elif [ -n "${FORK_FROM:-}" ]; then
  ARGS+=(--session "$FORK_FROM" --fork)
fi

trap notify_ended_early EXIT

if [ "${UNATTENDED:-}" = "1" ]; then
  # Unattended: a one-shot `opencode run` that exits at turn end. There is no attachable TUI on this
  # lane (see CODING_RUNTIMES.opencode capabilities), so the server does not need the Stop-hook
  # teardown the Claude/Codex lanes use — the process exiting IS the turn boundary.
  # The message is a yargs POSITIONAL, not a flag operand — do NOT separate it with `--`, which
  # yargs may route into argv["--"] instead of the message array, leaving the run with no prompt.
  # NEVER add `--pure`: it runs opencode WITHOUT external plugins, i.e. without the gate.
  # bash 3.2 errors on expanding an empty array under `set -u`; guard it (see CLAUDE.md).
  exec opencode run "${ARGS[@]+"${ARGS[@]}"}" "$TASK"
fi

# Interactive: the TUI, with the opening task pre-loaded as the first prompt. Same `--pure` warning.
exec opencode "${ARGS[@]+"${ARGS[@]}"}" --prompt "$TASK"
