#!/usr/bin/env bash
# Antigravity CLI (`agy`) hook ADAPTER — the gate for `runtime: antigravity` agents.
#
# agy has a real PreToolUse command hook, but its wire and tool vocabulary are its own:
#   stdin   {"hookEventName":"PreToolUse","toolCall":{"name":"run_command","args":{"CommandLine":"…"}},
#            "conversationId":"…","artifactDirectoryPath":"…",…}            (protojson → camelCase)
#   stdout  {"decision":"allow"|"deny","reason":"…"}                          (decision REQUIRED)
# This script translates that into the Claude-shaped event the SHARED terminal/gate-hook.sh already
# speaks (`tool_name`/`tool_input` in, `hookSpecificOutput.permissionDecision` out), runs it, and
# translates the answer back. One gate implementation on purpose: the fail-closed retry, the approval
# wait and the unattended timeout must never be fixed in one runtime and missed in another.
#
# Everything below was verified against agy 1.5.18/1.5.19 (2026-11-28), not read off docs — the
# docs embedded in the binary name tools by internal step type (`view_file`), which is NOT what the
# hook receives (`read_file`). See docs/antigravity-runtime.md for the probe log.
#
# FAIL-CLOSED PROPERTIES this script relies on (all verified):
#   • agy treats a hook that crashes, times out, exits non-zero, or prints no `decision` as a DENY.
#   • a hook `allow` does NOT bypass agy's own permission engine — so the launcher runs agy with
#     --dangerously-skip-permissions (which, in 1.5.x, still runs hooks) and this hook is the sole gate.
#   • subagents' tool calls reach the hook too, under the child's conversation id.
#
# WHAT IS DIFFERENT FROM THE CLAUDE TABLE: gate-hook.sh ends in `*) exit 0` (an unknown Claude tool is
# assumed harmless). agy exposes ~100 internal tools across releases, several of which reach outside
# the session (`schedule`, `swarm`, `run_workflow`, browser automation, Cloud SQL, Firebase deploys).
# So here an UNKNOWN tool is DENIED, and the capability is picked by what the ARGUMENTS carry
# (`CommandLine` → shell, `ServerName` → connector, a `Path` + write verb → file) before the name, so a
# renamed tool still lands in the right lane instead of slipping through.
#
# THE CONFIG IS SELF-DEFENDING: agy HOT-RELOADS hooks.json, and a workspace `.agents/hooks.json`
# declaring `{"agentric":{"enabled":false}}` switches the global gate off mid-session (verified). So any
# write, edit or shell command that names an agy customization root (`.agents/`, `.agent/`, `_agents/`,
# `_agent/`) or `~/.gemini` is refused here — locally, before the gateway — except the current
# conversation's own artifact directory, which agy writes its plans/tasks into.
#
# Env (inherited from the agy process, which inherits the session's launch env):
#   AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT, AOS_GATE_HOOK (path to gate-hook.sh)
set -u
EVENT=$(cat)
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${AOS_GATE_HOOK:-$HERE/gate-hook.sh}"

# Which event is this? (the global hooks.json routes SessionStart / PreToolUse / Stop here)
EV=$(printf '%s' "$EVENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d||"{}").hookEventName||""))}catch(e){}})' 2>/dev/null)

case "$EV" in
  SessionStart)
    # agy mints the conversation id; report it so resume (`--conversation <id>`) and the transcript reader
    # can find it. The server keeps the FIRST write, so a subagent's own SessionStart can't re-point it.
    cid=$(printf '%s' "$EVENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d||"{}").conversationId||""))}catch(e){}})' 2>/dev/null)
    if [ -n "$cid" ] && [ -n "${SESSION:-}" ]; then
      curl -s --max-time 10 -X POST "$AOS_URL/api/runtime-session" \
        -H 'content-type: application/json' -H "x-aos-secret: ${AOS_SECRET:-}" -H "x-aos-tenant: ${AOS_TENANT:-}" \
        -d "$(node -e 'console.log(JSON.stringify({session:process.argv[1],runtimeSessionId:process.argv[2]}))' "$SESSION" "$cid")" \
        >/dev/null 2>&1 || true
    fi
    echo '{}'
    exit 0 ;;
  Stop)
    # Turn end → the server may tear down an unattended run (same contract as Claude's Stop hook).
    # Best-effort; never ask agy to continue.
    printf '%s' "$EVENT" | bash "$HERE/stop-hook.sh" >/dev/null 2>&1 || true
    echo '{}'
    exit 0 ;;
  PreToolUse) : ;;
  *) echo '{}'; exit 0 ;;
esac

# ── translate agy → Claude-shaped event, or decide locally ────────────────────────────────────────
# Output: `LOCAL<US><agy response json>` or `GATE<US><claude event json>` (U+001F separator, which
# JSON.stringify can never emit literally).
XLATE=$(printf '%s' "$EVENT" | node -e '
const path = require("path");
let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
  const US = "\x1f";
  const out = (kind, o) => { process.stdout.write(kind + US + JSON.stringify(o)); };
  const allow = () => out("LOCAL", { decision: "allow" });
  const deny = (r) => out("LOCAL", { decision: "deny", reason: "Agentric: " + r });
  const gate = (tool_name, tool_input) => out("GATE", { tool_name, tool_input });
  let e = {};
  try { e = JSON.parse(d || "{}"); } catch (_) { return deny("could not parse the hook payload — blocked (fail-closed)."); }
  const t = e.toolCall || {}; const name = String(t.name || ""); const a = (t.args && typeof t.args === "object") ? t.args : {};
  const cwd = typeof e.cwd === "string" && e.cwd ? e.cwd : process.cwd();
  const real = (p) => { const fs = require("fs"); try { return fs.realpathSync(p); } catch (_) { const dd = path.dirname(p); return dd === p ? p : path.join(real(dd), path.basename(p)); } };
  const abs = (p) => real(path.resolve(cwd, String(p)));
  const artifacts = typeof e.artifactDirectoryPath === "string" && e.artifactDirectoryPath ? real(e.artifactDirectoryPath) : "";
  const inArtifacts = (p) => !!artifacts && (p === artifacts || p.startsWith(artifacts + "/")) && !/\/\.system_generated(\/|$)/.test(p);
  // agy writes each MCP tool’s schema under ~/.gemini/antigravity-cli/mcp/ and READS it back before the
  // first call — reading there is how the agent learns a tool, so it stays readable.
  const mcpSchemas = real(path.join(require("os").homedir(), ".gemini", "antigravity-cli", "mcp"));
  // A customization root agy loads hooks/plugins/MCP servers/skills from, or agy’s own state dir.
  const ROOT_SEG = /(?:^|\/)(?:\.agents?|_agents?)(?:\/|$)|(?:^|\/)\.gemini(?:\/|$)/;
  const ROOT_TXT = /(?:^|[\s\/"\x27=:(<>|;&`$])(?:\.agents?|_agents?)(?:\/|\s|$|["\x27])|\.gemini\b/;
  const protectedWrite = (p) => ROOT_SEG.test(p) && !inArtifacts(p);
  const protectedRead = (p) => ROOT_SEG.test(p) && /(?:^|\/)\.gemini(?:\/|$)/.test(p) && !inArtifacts(p) && !(p === mcpSchemas || p.startsWith(mcpSchemas + "/"));
  const cfgDeny = "that path is agent-runtime configuration (an .agents/ customization root or ~/.gemini). It is refused for every agent: editing it can switch the governance hook off. Work in your own folder; ask a human with ask_human if you need it changed.";
  const shell = (cmd, extra) => {
    if (typeof cmd !== "string" || !cmd.trim()) return deny(name + " carried no command — blocked.");
    if (ROOT_TXT.test(cmd)) return deny("this command names agent-runtime configuration (.agents/ or ~/.gemini) — " + cfgDeny);
    return gate("Bash", Object.assign({ command: cmd }, extra || {}));
  };
  const pathArg = a.Path || a.TargetFile || a.AbsolutePath || a.FilePath || a.File;

  // 1) Shape first — a renamed or new tool that carries these still lands in the right lane.
  if (typeof a.CommandLine === "string") return shell(a.CommandLine, a.Cwd ? { cwd: String(a.Cwd) } : undefined);
  if (typeof a.ServerName === "string" && typeof a.ToolName === "string") {
    // Our hub multiplexes every per-session MCP server behind ONE global entry named `agentric`, and
    // names each tool `<server>__<tool>` — so the gate sees `mcp__agentos__recall` and
    // `mcp__composio-company__…` exactly as it does on Claude Code. Any other ServerName is an MCP
    // server the box owner configured in ~/.gemini; it is governed as a connector call like any other.
    const srv = a.ServerName === "agentric" ? "" : String(a.ServerName);
    const tool = srv ? `mcp__${srv}__${a.ToolName}` : `mcp__${a.ToolName}`;
    let input = a.Arguments;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch (_) { input = { raw: input }; } }
    return gate(tool, input && typeof input === "object" ? input : {});
  }

  // 2) By name.
  switch (name) {
    case "write_file": {
      if (!pathArg) return deny("write_file without a Path — blocked.");
      const p = abs(pathArg);
      if (protectedWrite(p)) return deny(cfgDeny);
      if (inArtifacts(p)) return allow();          // agy’s own plan/task scratch for THIS conversation
      return gate("Write", { file_path: p, content: typeof a.Content === "string" ? a.Content : "" });
    }
    case "edit_file": {
      if (!pathArg) return deny("edit_file without a Path — blocked.");
      const p = abs(pathArg);
      if (protectedWrite(p)) return deny(cfgDeny);
      if (inArtifacts(p)) return allow();
      return gate("Edit", { file_path: p, old_string: String(a.Target ?? ""), new_string: String(a.Replacement ?? "") });
    }
    case "read_file": {
      if (!pathArg) return allow();
      const p = abs(pathArg);
      if (protectedRead(p)) return deny("~/.gemini holds the Antigravity login and every other conversation’s transcript; it is not readable by an agent.");
      return gate("Read", { file_path: p });   // the shared hook’s protected-path arm decides locally
    }
    case "manage_task":
      // Input written to a running background task is shell input — govern it as such.
      if (typeof a.Input === "string" && a.Input) return shell(a.Input);
      return allow();                               // status / kill of the agent’s own background task
    case "search_web":                              // parity: Claude’s WebSearch/WebFetch are ungated reads
    case "update_steps":                            // the TUI’s plan checklist
    case "send_message":                            // subagent ⇄ parent messaging, in-process
    case "manage_subagents":                        // list / kill the agent’s own subagents
    case "invoke_subagent":                         // verified: a subagent’s calls reach this hook too
      return allow();
    case "ask_question":
      return deny("ask_question is not wired to Agentric (nobody may be at this terminal). Use the `ask` tool instead — it reaches the right human through the inbox, Slack or Discord.");
    case "schedule":
      return deny("Antigravity’s own scheduler runs future work outside Agentric’s gate and audit trail. Use the `schedule` tool from the agentric MCP server instead — it books a governed run of this agent.");
    case "define_subagent":
      return deny("defining a persistent subagent writes Antigravity configuration shared by every agent on this machine. Use invoke_subagent with an inline Role/Prompt instead.");
    case "swarm":
      return deny("swarm workers are not verified to pass through the governance hook. Use invoke_subagent (verified) or task_create to hand work to another governed agent.");
    case "run_workflow":
      return deny("run_workflow executes a script the gate cannot see. Run it with run_command instead (e.g. `python3 script.py`), which is gated on its text.");
  }

  // 3) Last-resort shape: a Path plus a write-ish name is a write.
  if (pathArg && /(write|edit|replace|delete|move|rename|create|patch|append|remove)/i.test(name)) {
    const p = abs(pathArg);
    if (protectedWrite(p)) return deny(cfgDeny);
    return gate("Write", { file_path: p, content: typeof a.Content === "string" ? a.Content : "" });
  }
  return deny(`the Antigravity tool "${name}" is not recognised by the governance adapter, so it is blocked (an unknown tool may reach outside this session). Use run_command / write_file / edit_file / an MCP tool instead, or ask a human to extend terminal/antigravity-gate-hook.sh.`);
});' 2>/dev/null)

KIND="${XLATE%%$'\x1f'*}"
BODY="${XLATE#*$'\x1f'}"

if [ "$KIND" = "LOCAL" ] && [ -n "$BODY" ]; then
  printf '%s\n' "$BODY"
  exit 0
fi
if [ "$KIND" != "GATE" ] || [ -z "$BODY" ]; then
  echo '{"decision":"deny","reason":"Agentric: the governance adapter failed to translate this call — blocked (fail-closed)."}'
  exit 0
fi

# ── run the shared gate, translate its answer back ────────────────────────────────────────────────
# gate-hook.sh answers with Claude's wire: a `hookSpecificOutput.permissionDecision` JSON on stdout, or
# SILENCE + exit 0 for "not my business" (its Read arm on an unprotected path, the OS's own MCP tools).
# Silence maps to allow ONLY because we pre-filtered: every call that reaches here was deliberately
# routed. Anything unparsable maps to deny.
ANS=$(printf '%s' "$BODY" | AOS_RUNTIME=antigravity bash "$GATE")
rc=$?
printf '%s' "$ANS" | AOS_RC="$rc" node -e '
let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
  const rc = Number(process.env.AOS_RC || 0);
  const s = d.trim();
  if (rc !== 0) { console.log(JSON.stringify({ decision: "deny", reason: "Agentric: the gate exited with an error — blocked (fail-closed)." })); return; }
  if (!s) { console.log(JSON.stringify({ decision: "allow" })); return; }
  let o; try { o = JSON.parse(s.split("\n").filter(Boolean).pop()); } catch (_) { o = null; }
  const h = o && o.hookSpecificOutput;
  const dec = h && h.permissionDecision;
  if (dec === "allow") { console.log(JSON.stringify({ decision: "allow" })); return; }
  if (dec === "deny") { console.log(JSON.stringify({ decision: "deny", reason: String(h.permissionDecisionReason || "Agentric: denied by policy.") })); return; }
  if (h && !dec && h.additionalContext) { console.log(JSON.stringify({ decision: "allow" })); return; }   // an `instruct` note: allow (no steer channel)
  console.log(JSON.stringify({ decision: "deny", reason: "Agentric: unrecognised gate answer — blocked (fail-closed)." }));
});'
exit 0
