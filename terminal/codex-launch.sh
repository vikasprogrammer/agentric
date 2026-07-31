#!/usr/bin/env bash
# Real-Codex launcher — opens an OpenAI Codex session DIRECTLY IN THE AGENT'S FOLDER, governed by
# Agent OS. The Claude Code counterpart is claude-launch.sh; read that one first, this is the same
# shape with the runtime-specific bits swapped.
#
# HOW THE INVARIANT IS UPHELD HERE (it differs from the Claude lane, deliberately):
#   1. shell.exec — Codex's PreToolUse hook fires on the `shell` tool, so every command (including
#      curl / git / npm, i.e. all network egress the agent drives) goes through terminal/gate-hook.sh
#      → POST /api/gate → Policy/Approvals/Budget/Audit. Same hook file as Claude; $AOS_RUNTIME picks
#      the tool→capability routing table.
#   2. file.write — Codex applies most edits by piping `apply_patch` through the shell tool, so those
#      are already covered by (1). Anything that ISN'T is contained STRUCTURALLY instead: the sandbox
#      is `workspace-write` with `writable_roots` pinned to the agent folder, so a write outside the
#      agent's own directory is impossible at the OS level rather than merely denied by policy.
#   3. connector.call — Codex's hook coverage for MCP tools isn't guaranteed, so those are governed
#      SERVER-SIDE: every OS tool is a loopback call to /api/* that derives identity from the session
#      row and enforces the real governance there (secret_put still blocks for approval, memory is
#      namespaced to this agent, …). Composio connector calls likewise mint per-session, per-identity
#      Tool Router URLs. Nothing reaches the world on a bare token the agent holds.
#   4. approval_policy = "never" — Agent OS is the SOLE authority, exactly as the Claude lane sets
#      --dangerously-skip-permissions. It removes Codex's OWN prompts (which nobody is there to
#      answer), NOT our gate: the PreToolUse hook still runs and still blocks for inbox approval.
#
# Env (exported by the server when it spawns the tmux session):
#   AOS_URL        base url of the agent-os server   (e.g. http://127.0.0.1:3010)
#   SESSION        session id
#   AGENT          agent id (matches the manifest / its folder name)
#   AGENT_DIR      the agent's folder — codex opens here and writes its scratch here
#   TASK_FILE      path to the opening prompt (TASK_B64 is the legacy inline fallback)
#   HOOK           absolute path to gate-hook.sh (the PreToolUse gate)
#   AOS_RUNTIME    "codex" — selects the hook's routing table
#   AOS_CODEX_HOME per-session $CODEX_HOME the server created (0700); holds our generated config
#   MCP_CONFIG     path to the session's mcpServers JSON (converted to TOML below)
#   COMPANY_FILE   workspace Company context markdown (folded into AGENTS.md below)
#   CODEX_MODEL / CODEX_EFFORT   resolved runtime tuning ("" → inherit the CLI default)
#   UNATTENDED     "1" → an automation/cron/task run: an attachable TUI torn down by the server at
#                  turn end (Stop hook → /api/turn-idle), same contract as the Claude lane
#   RESUME         "1" → continue RUNTIME_SESSION_ID instead of starting fresh
#   FORK_FROM      branch a new conversation off this rollout id (first launch only)
set -u

# RESUME path: the ttyd attach wrapper re-launches us against a session whose tmux shell was killed.
# The new tmux session does NOT inherit the original launch env, so recover it first.
RESUMED_FROM_ENV=
if [ "${RESUME:-}" = "1" ] && [ -n "${ENV_FILE:-}" ] && [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  RESUMED_FROM_ENV=1
fi

# `codex` is commonly installed under a node prefix bin; make sure it's findable even when the parent
# process (e.g. a hardened systemd unit) ships a minimal PATH.
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

if ! command -v codex >/dev/null 2>&1; then
  red "the 'codex' CLI is not on PATH — install it (npm i -g @openai/codex) or adjust PATH."
  red "the session cannot start ungoverned, so this pane will idle."
  exec bash
fi

# ── per-session CODEX_HOME ────────────────────────────────────────────────────────────────────────
# Everything Codex reads (config.toml, hooks.json) and writes (sessions/) is redirected into a
# per-session 0700 dir the server created. Two payoffs: (a) our generated config can't disturb the
# operator's own ~/.codex, and (b) `sessions/` then contains EXACTLY ONE rollout file, which is how
# we discover the id Codex minted (it has no --session-id to pin, unlike claude).
export CODEX_HOME="${AOS_CODEX_HOME:-$AGENT_DIR/.aos-codex}"
mkdir -p "$CODEX_HOME"
chmod 700 "$CODEX_HOME" 2>/dev/null || true

# Auth: Codex keeps its credentials in $CODEX_HOME, which we've just pointed at a throwaway per-session
# dir — so every credential store has to be linked back to the REAL home or it dies with the session.
#   • auth.json     — the account login (`codex login`).
#   • mcp_oauth.age — OAuth tokens for REMOTE MCP servers (`codex mcp login <name>`). Without this an
#     OAuth-backed connector can NEVER work under Codex: each run starts with an empty store, the server
#     answers 401, and rmcp logs `AuthRequired … token is null or empty` into the pane. (Seen live with
#     a DataForSEO connector that works fine under Claude Code, which has its own persisted OAuth store.)
# Symlinks, not copies, so a re-login or a token refresh performed in ANY session is picked up by all of
# them and no credential is duplicated onto disk. The OAuth link is made even when the target doesn't
# exist yet: writing through a dangling symlink creates the real file, so a login lands in the shared
# home rather than being thrown away with the session.
REAL_CODEX_HOME="${AOS_REAL_CODEX_HOME:-$HOME/.codex}"
mkdir -p "$REAL_CODEX_HOME" 2>/dev/null || true
if [ -f "$REAL_CODEX_HOME/auth.json" ] && [ ! -e "$CODEX_HOME/auth.json" ]; then
  ln -s "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME/auth.json" 2>/dev/null || true
fi
if [ ! -e "$CODEX_HOME/mcp_oauth.age" ]; then
  ln -s "$REAL_CODEX_HOME/mcp_oauth.age" "$CODEX_HOME/mcp_oauth.age" 2>/dev/null || true
fi

# PRE-FLIGHT: refuse to start unauthenticated. Codex's fallback when it finds no credentials is an
# INTERACTIVE "Sign in with ChatGPT" menu that waits on a keypress, and that is harmful in both lanes:
#   - unattended: nobody is at the pane, so the run parks on the menu forever — the same permanent-hang
#     class as the Claude lane's folder-trust dialog (see CLAUDE.md).
#   - interactive: a human CAN complete it, but `codex login` writes auth.json into whatever $CODEX_HOME
#     is current — which here is the PER-SESSION dir. The credential is then thrown away with the
#     session's files, the next run prompts again, and it looks like the login "didn't take". (Exactly
#     what happened on the first live run: the login landed in session-<id>.codex/auth.json.)
# So fail closed with the fix spelled out, and never let the login flow appear inside an agent session.
# API-key mode needs no auth.json, so an injected OPENAI_API_KEY (shellSecret / assignment) counts.
if [ ! -e "$CODEX_HOME/auth.json" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  red "Codex is not authenticated — refusing to start."
  echo
  dim "Agent OS looked for credentials at:  $REAL_CODEX_HOME/auth.json"
  dim "Fix it ONCE, from a normal shell as this user (NOT inside an agent session):"
  echo
  cyan "    codex login"
  echo
  dim "…then re-run this agent. Every session symlinks that file, so one login covers the fleet."
  dim "Alternatively give this agent an OPENAI_API_KEY (Settings → Secrets) for usage-based billing."
  dim "Do NOT run 'codex login' in here: \$CODEX_HOME is per-session, so the credential would be discarded."
  echo
  notify_ended_early() {
    curl -s -X POST "$AOS_URL/api/ended" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
      -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
  }
  notify_ended_early
  # Unattended runs must EXIT so tmux drops the pane and the pile-up guard releases. An interactive
  # session holds the pane (so the operator can read this) but never drops to a shell — a raw tmux
  # shell has no gate hook and no sandbox.
  [ "${UNATTENDED:-}" = "1" ] && exit 1
  while true; do
    dim "Press [q] to close this tab."
    key=""
    IFS= read -rsn1 key || { sleep 5; continue; }
    case "$key" in q|Q) exit 1 ;; *) : ;; esac
  done
fi

# ── config.toml ───────────────────────────────────────────────────────────────────────────────────
# Generated fresh each launch (so hook paths are always correct and portable across machines), from
# the session's MCP JSON. Codex's schema is `[mcp_servers.<name>]` with command/args + a nested
# `.env` table for stdio servers, or url + a nested `.http_headers` table for streamable HTTP —
# verified against `codex mcp add` output and re-parsed under `--strict-config`.
AOS_MCP_CONFIG="${MCP_CONFIG:-}" \
AOS_AGENT_DIR="$AGENT_DIR" \
AOS_MODEL="${CODEX_MODEL:-}" \
AOS_EFFORT="${CODEX_EFFORT:-}" \
node -e '
  const fs = require("fs");
  const q = (v) => JSON.stringify(String(v));            // TOML basic string ⊂ JSON string
  const out = [];
  if (process.env.AOS_MODEL)  out.push(`model = ${q(process.env.AOS_MODEL)}`);
  if (process.env.AOS_EFFORT) out.push(`model_reasoning_effort = ${q(process.env.AOS_EFFORT)}`);
  // Agent OS is the sole authority (see header note 4); the gate hook still blocks for approval.
  out.push(`approval_policy = "never"`);
  out.push(`sandbox_mode = "workspace-write"`);
  out.push("");
  out.push("[sandbox_workspace_write]");
  // Structural containment for any write that does not pass through the shell tool. The workdir is
  // already writable implicitly; naming it here is explicit and survives a future cwd change.
  out.push(`writable_roots = [${q(process.env.AOS_AGENT_DIR)}]`);
  // Egress via the shell IS governed (the hook sees every shell call), so the sandbox does not need
  // to cut the network — doing so would break git push / npm install for every agent.
  out.push("network_access = true");
  // NOTE: do NOT write `[features] codex_hooks = true`. There is no such key — `codex features list`
  // names the flag `hooks`, and it is already stage=stable/enabled by default, so the bogus key was
  // silently ignored and gave a false sense that hooks had been switched on.
  // Pre-accept the workspace-TRUST gate for this agent folder — the exact analogue of the
  // `~/.claude.json` hasTrustDialogAccepted seed on the Claude lane, and the same failure mode if
  // missing: agent folders are freshly created and are NOT git repos, so without this the TUI parks
  // on a "Not inside a trusted directory" / trust prompt nobody
  // is there to answer. (Verified against codex 0.145 in a dry run.) Trust only bypasses that
  // one-time gate; the PreToolUse hook and the sandbox still govern every effect.
  out.push("");
  out.push(`[projects.${q(process.env.AOS_AGENT_DIR)}]`);
  out.push(`trust_level = "trusted"`);
  const file = process.env.AOS_MCP_CONFIG;
  if (file && fs.existsSync(file)) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { cfg = {}; }
    for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;      // TOML bare key; skip anything exotic
      out.push("", `[mcp_servers.${name}]`);
      if (s && s.url) {
        out.push(`url = ${q(s.url)}`);
      } else if (s && s.command) {
        out.push(`command = ${q(s.command)}`);
        out.push(`args = [${(s.args || []).map(q).join(", ")}]`);
      } else {
        out.pop(); out.pop(); continue;                   // neither shape → drop the empty table
      }
      // Give the OS server room to boot under load; the default is tight enough to flake on a cold
      // node start, and a dropped agentos server means the agent silently loses all its OS tools.
      out.push("startup_timeout_sec = 30");
      const env = (s && s.env) || {};
      if (Object.keys(env).length) {
        out.push("", `[mcp_servers.${name}.env]`);
        for (const [k, v] of Object.entries(env)) if (/^[A-Za-z0-9_]+$/.test(k)) out.push(`${k} = ${q(v)}`);
      }
      const headers = (s && s.headers) || {};
      if (Object.keys(headers).length) {
        out.push("", `[mcp_servers.${name}.http_headers]`);
        for (const [k, v] of Object.entries(headers)) out.push(`${q(k)} = ${q(v)}`);
      }
    }
  }
  fs.writeFileSync(process.env.CODEX_HOME + "/config.toml", out.join("\n") + "\n", { mode: 0o600 });
' || { red "failed to generate codex config — refusing to start ungoverned."; exec bash; }

# ── hooks.json + PRE-SEEDED TRUST ─────────────────────────────────────────────────────────────────
# Two hooks:
#   PreToolUse (matcher ".*") — the gate. Every tool reaches it and OUR routing table decides.
#   Stop       (NO matcher)   — beacons /api/turn-idle so the server can tear down an unattended run at
#                               turn end, exactly as the Claude lane does.
#
# TRUST IS THE HARD PART. Codex refuses to run a hook whose hash it hasn't recorded as trusted, and
# `--dangerously-bypass-hook-trust` is ignored in TUI mode (openai/codex#24093) — which is why every
# Codex run used to be forced down `codex exec`. We now compute the trust hash ourselves and write it
# into config.toml, so an interactive/attachable TUI runs GOVERNED with no human ever seeing a prompt.
#
# The hash (codex-rs/hooks/src/engine/discovery.rs `command_hook_hash` → config/src/fingerprint.rs
# `version_for_toml`): build the identity, serialize TOML→JSON (so absent/None fields vanish),
# RECURSIVELY SORT every object's keys, compact-JSON it, sha256, prefix `sha256:`.
#
# Two details that are easy to get wrong and fail SILENTLY-ish:
#   • the serde name is `timeout`, not `timeout_sec`, and its default (600) is baked into the hash even
#     though it never appears in hooks.json;
#   • `matcher` is part of the identity for PreToolUse but is DROPPED for Stop (Stop takes no matcher),
#     so the Stop identity must omit the key entirely.
# Both hashes below are verified against values Codex itself wrote after an interactive `/hooks` trust.
#
# If a Codex upgrade changes this, the TUI shows "Hooks need review" instead of silently skipping — and
# TerminalManager's pane guard kills the session on sight, so a human can never answer that prompt with
# "continue without trusting". Stale trust therefore fails LOUD, never ungoverned.
STOP_HOOK="$(dirname "$HOOK")/stop-hook.sh"
AOS_HOOK="$HOOK" AOS_STOP_HOOK="$STOP_HOOK" node -e '
  const fs = require("fs"), crypto = require("crypto");
  const home = process.env.CODEX_HOME;
  const gate = `bash ${JSON.stringify(process.env.AOS_HOOK)}`;
  const stop = `bash ${JSON.stringify(process.env.AOS_STOP_HOOK)}`;
  fs.writeFileSync(home + "/hooks.json", JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: gate }] }],
      Stop: [{ hooks: [{ type: "command", command: stop }] }],
    },
  }, null, 2), { mode: 0o600 });

  const canon = (v) => Array.isArray(v) ? v.map(canon)
    : (v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const hash = (identity) =>
    "sha256:" + crypto.createHash("sha256").update(JSON.stringify(canon(identity))).digest("hex");
  const handler = (command) => ({ type: "command", command, timeout: 600, async: false });
  const hooksJson = home + "/hooks.json";
  const rows = [
    // key = <hooks.json path>:<event label>:<matcher-group index>:<handler index>
    [`${hooksJson}:pre_tool_use:0:0`, hash({ event_name: "pre_tool_use", matcher: ".*", hooks: [handler(gate)] })],
    [`${hooksJson}:stop:0:0`,         hash({ event_name: "stop",                        hooks: [handler(stop)] })],
  ];
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const toml = rows.map(([k, h]) => `\n[hooks.state."${esc(k)}"]\ntrusted_hash = "${h}"\n`).join("");
  fs.appendFileSync(home + "/config.toml", toml);
' || { red "failed to write the gate hook config — refusing to start ungoverned."; exec bash; }

# ── AGENTS.md (system prompt) ─────────────────────────────────────────────────────────────────────
# Codex has no `--append-system-prompt-file`; it discovers AGENTS.md from the workspace root. So the
# OS composes one from the agent's own persona (CLAUDE.md, which is the runtime-neutral persona file
# every agent already has) plus the workspace Company context. Regenerated each launch and clearly
# marked, so a human editing it knows it is not hand-maintained.
node -e '
  const fs = require("fs");
  const [persona, company, dest] = process.argv.slice(1);
  const read = (p) => { try { return p && fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : ""; } catch (_) { return ""; } };
  const parts = ["<!-- Generated by Agent OS at launch. Edits are overwritten; change the agent or Company context instead. -->"];
  const p = read(persona), c = read(company);
  if (p) parts.push(p);
  if (c) parts.push(c);
  if (p || c) fs.writeFileSync(dest, parts.join("\n\n") + "\n");
' "$AGENT_DIR/CLAUDE.md" "${COMPANY_FILE:-}" "$AGENT_DIR/AGENTS.md" 2>/dev/null || true

# ── report the rollout id back to the server ──────────────────────────────────────────────────────
# Codex mints its own session UUID (there is no --session-id to pin), but we need it for resume/fork.
# Because CODEX_HOME is per-session, sessions/ holds exactly one rollout file named
# `rollout-<ts>-<uuid>.jsonl` — so watch for it, POST the id once, and exit. Backgrounded so it never
# delays the run; bounded so it can't linger if the session dies early.
report_runtime_id() {
  local i=0 f id
  while [ "$i" -lt 120 ]; do
    f=$(find "$CODEX_HOME/sessions" -name 'rollout-*.jsonl' -type f 2>/dev/null | head -1)
    if [ -n "$f" ]; then
      id=$(basename "$f" .jsonl | sed -n 's/.*-\([0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}\)$/\1/p')
      if [ -n "$id" ]; then
        curl -s --max-time 10 -X POST "$AOS_URL/api/runtime-session" \
          -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
          -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1],runtimeSessionId:process.argv[2]}))' "$SESSION" "$id")" \
          >/dev/null 2>&1
        return 0
      fi
    fi
    i=$((i + 1))
    sleep 1
  done
}
REPORTER_PID=
if [ "${RESUME:-}" != "1" ]; then
  report_runtime_id >/dev/null 2>&1 &
  REPORTER_PID=$!
fi
# The poller MUST be reaped before this script exits. It inherits the pane's stdout/stderr, so a
# still-running child keeps the pane's pipes open — which on the UNATTENDED lane means tmux never
# drops the session at turn end, the liveness sweep keeps seeing it alive, and the automations
# pile-up guard never releases. (Found exactly this way in a stub-codex dry run.)
stop_reporter() { [ -n "${REPORTER_PID:-}" ] && kill "$REPORTER_PID" 2>/dev/null; return 0; }
trap stop_reporter EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
trap 'exit 130' INT

notify_ended() {
  curl -s -X POST "$AOS_URL/api/ended" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}
notify_resumed() {
  curl -s -X POST "$AOS_URL/api/resumed" -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
    -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1]}))' "$SESSION")" >/dev/null 2>&1 || true
}

clear
cyan "┌─ Agent OS · governed codex ─────────────────────────────────"
cyan "│ agent:   $AGENT"
cyan "│ session: $SESSION"
cyan "│ folder:  $AGENT_DIR"
cyan "│ task:    $TASK"
cyan "└─────────────────────────────────────────────────────────────"
echo
dim "Real codex, opened in this agent's folder. Every shell call is gated by Agent OS;"
dim "risky ones pause here and surface as an inbox approval. Writes are sandboxed to this folder."
[ -f "$CODEX_HOME/auth.json" ] || dim "note: no codex auth found at $REAL_CODEX_HOME/auth.json — run 'codex login' as this user."
[ -n "${CODEX_MODEL:-}${CODEX_EFFORT:-}" ] && dim "tuning: model=${CODEX_MODEL:-default} effort=${CODEX_EFFORT:-default}"
MCP_NAMES=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(c.mcpServers||{}).join(", "))}catch(e){}' "${MCP_CONFIG:-/nonexistent}" 2>/dev/null)
[ -n "$MCP_NAMES" ] && dim "connectors: $MCP_NAMES"
echo

# `--dangerously-bypass-hook-trust`: Codex refuses to run a hooks.json it has not seen before unless
# the config's hash is in its trust store. Ours is REGENERATED EVERY LAUNCH from the OS's own hook
# path, so the hash legitimately changes and there is no human at the pane to confirm it. This is
# precisely the documented "automation that already vets hook sources" case — the hook is ours. It
# does NOT weaken the gate; without it the gate would simply never run, which is the unsafe outcome.
# `--dangerously-bypass-hook-trust` is kept as belt-and-braces: it is INERT in TUI mode (that's the
# upstream bug that forced exec-only), but harmless, and it keeps the non-TUI fallback paths governed if
# one is ever reintroduced. The real mechanism is the pre-seeded `[hooks.state]` trust above.
COMMON_ARGS=(--dangerously-bypass-hook-trust -C "$AGENT_DIR")

# ── launch ────────────────────────────────────────────────────────────────────────────────────────
# Every lane is now the INTERACTIVE TUI, matching the Claude lane. This is only possible because trust
# is pre-seeded above; before that, the TUI ran with no PreToolUse hook at all and we were forced onto
# `codex exec`. Consequences:
#   • an UNATTENDED run is attachable — a human can take it over mid-run by simply attaching, no kill,
#     no resume, no lost turn. Teardown is SERVER-driven: the Stop hook beacons /api/turn-idle and
#     TerminalManager.markTurnIdle kills the pane, unless a human has taken it over / is watching / it's
#     blocked on a person. Exactly the Claude lane's contract.
#   • a RESIDENT (warm chat) run stays live for send-keys follow-ups until the idle reaper.
# `approval_policy = "never"` in the generated config is what removes Codex's own prompts (nobody is at
# the pane to answer them); the gate hook still blocks every governed effect for inbox approval.
if [ "${UNATTENDED:-}" = "1" ]; then
  dim "unattended run — attachable TUI (gate hook governs); take it over anytime. Closes at turn-end."
elif [ "${RESIDENT:-}" = "1" ]; then
  dim "resident warm chat session — kept warm for fast follow-ups (gate hook still governs)."
else
  dim "interactive session — every Bash / apply_patch / MCP call is gated by Agent OS."
fi
echo

if [ "${RESUME:-}" = "1" ] && [ -n "${RUNTIME_SESSION_ID:-}" ]; then
  notify_resumed
  dim "resuming codex session $RUNTIME_SESSION_ID …"
  echo
  # A browser reattach must NOT re-seed $TASK (it's already in the transcript); a server-driven
  # follow-up spawns a fresh pane with no ENV_FILE and a genuinely new $TASK, so that one does seed.
  if [ -n "${RESUMED_FROM_ENV:-}" ]; then
    codex resume "$RUNTIME_SESSION_ID" "${COMMON_ARGS[@]}" || codex "${COMMON_ARGS[@]}" ${TASK:+"$TASK"}
  else
    codex resume "$RUNTIME_SESSION_ID" "${COMMON_ARGS[@]}" ${TASK:+"$TASK"} || codex "${COMMON_ARGS[@]}" ${TASK:+"$TASK"}
  fi
elif [ -n "${FORK_FROM:-}" ]; then
  dim "forking codex session $FORK_FROM …"
  echo
  codex fork "$FORK_FROM" "${COMMON_ARGS[@]}" ${TASK:+"$TASK"} || codex "${COMMON_ARGS[@]}" "$TASK"
else
  codex "${COMMON_ARGS[@]}" "$TASK"
fi
notify_ended

# SECURITY: do NOT drop to a raw shell when codex exits. A tmux shell has NO PreToolUse gate hook and NO
# sandbox, so `exec bash` here would hand whoever is attached full, ungoverned access as the app user.
# Keep the pane alive (so ttyd doesn't loop "Reconnecting") with a holding prompt that can ONLY re-open
# codex or close.
echo
while true; do
  dim "codex session ended — press [r] to resume, [q] to close the tab."
  key=""
  IFS= read -rsn1 key || { sleep 2; continue; }
  case "$key" in
    r|R)
      notify_resumed
      if [ -n "${RUNTIME_SESSION_ID:-}" ]; then
        codex resume "$RUNTIME_SESSION_ID" "${COMMON_ARGS[@]}" || codex "${COMMON_ARGS[@]}" ${TASK:+"$TASK"}
      else
        codex "${COMMON_ARGS[@]}" ${TASK:+"$TASK"}
      fi
      notify_ended
      ;;
    q|Q) exit 0 ;;
    *) : ;;   # ignore any other key — never spawn a shell
  esac
done
