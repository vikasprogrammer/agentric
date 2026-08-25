// Agentric gate — the AUTHENTIC path for the `opencode` runtime.
//
// The Claude Code / Codex counterpart is terminal/gate-hook.sh; read that first, this is the same
// contract expressed in a different mechanism. opencode has NO command-hook facility: its only
// pre-execution extension point is a JS plugin whose `tool.execute.before` runs before every tool
// call and BLOCKS BY THROWING. So the shell hook cannot be shared here, and this file re-implements
// the same three things it does — route tool → capability, POST /api/gate, honour the decision —
// against the identical server contract. A governance change must land in BOTH files.
//
// CONTRACT (fail-closed, same as the shell hook):
//   allow    → return (the tool proceeds)
//   deny     → throw (opencode aborts the call and shows the reason to the model)
//   pending  → poll /api/gate/<id> until a human decides; an UNATTENDED run bounds the wait
//              (AOS_UNATTENDED_APPROVAL_WAIT_S, default 180s) and then FAILS CLOSED (throws).
//   gate unreachable → retry forever, never fall through to allow.
//
// Env (exported by opencode-launch.sh): AOS_URL, SESSION, AGENT, AOS_SECRET, AOS_TENANT, UNATTENDED.

const AOS_URL = process.env.AOS_URL || "";
const SESSION = process.env.SESSION || "";
const AGENT = process.env.AGENT || "";
const SECRET = process.env.AOS_SECRET || "";
const TENANT = process.env.AOS_TENANT || "";
const UNATTENDED = process.env.UNATTENDED === "1";
const APPROVAL_WAIT_S = Number(process.env.AOS_UNATTENDED_APPROVAL_WAIT_S || "180");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Route a tool to an Agentric capability. Structural only — all riskiness/destructiveness
 * classification happens server-side in the enricher + policy, exactly as in the shell hook.
 *
 * Tool ids verified against the opencode 1.17 binary: bash, edit, write, read, patch, grep, glob,
 * list, task, webfetch, websearch, todowrite, skill.
 *
 * Returns null for a tool that is not a world side effect (read-only navigation), which the gate
 * ignores — the same meaning as the shell hook's `*) exit 0` arm.
 */
function capabilityFor(tool) {
  const t = String(tool || "");
  // The OS's own MCP server is internal (memory, ask/report, policy preview) and never touches the
  // outside world, so it bypasses the gate — same carve-out the shell hook makes. Accept both the
  // `mcp__server__tool` and bare `server__tool` spellings.
  if (/^(mcp__)?agentos__/.test(t)) return null;
  switch (t) {
    case "bash":
      return "shell.exec";
    // Every write path opencode exposes. Unlike Codex — where only `apply_patch` reaches the hook and
    // the OS sandbox is the real containment — the plugin sees all of these directly.
    case "edit":
    case "write":
    case "patch":
    case "multiedit":
      return "file.write";
    // Network reads the agent drives itself. `bash` already covers curl/git; these are the built-in
    // equivalents and would otherwise be an ungoverned egress path.
    case "webfetch":
    case "websearch":
      return "net.fetch";
    // Read-only / in-session bookkeeping: not a world side effect.
    case "read":
    case "grep":
    case "glob":
    case "list":
    case "todowrite":
    case "todoread":
    case "skill":
      return null;
    default:
      break;
  }
  // Connector (MCP) calls. INITIATE_CONNECTION starts an OAuth grant that gives the whole fleet
  // access to an app, so it is the owner/admin-gated `connector.connect`; everything else is a
  // normal connector call. Mirrors the shell hook's ordering.
  if (/INITIATE_CONNECTION/.test(t)) return "connector.connect";
  if (/^(mcp__|[A-Za-z0-9_-]+__)/.test(t)) return "connector.call";
  // Unknown tool. The shell hook allows here, and that is right for a CLI whose tool list we have
  // enumerated. opencode ships new tools faster than we can track, and an unrecognised one may well
  // reach the world, so route it through the gate as a shell-class effect rather than waving it
  // through. Policy decides; a benign tool simply gets allowed.
  return "shell.exec";
}

/** POST the classify request. Returns the parsed body, or null on any transport failure. */
async function classify(payload) {
  try {
    const res = await fetch(`${AOS_URL}/api/gate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-aos-secret": SECRET, "x-aos-tenant": TENANT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** Poll a pending approval's status. Returns "allow" | "deny" | "" (still pending / unreachable). */
async function pollStatus(gateId) {
  try {
    const res = await fetch(`${AOS_URL}/api/gate/${gateId}`, {
      headers: { "x-aos-tenant": TENANT },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    return body.status || "";
  } catch (_) {
    return "";
  }
}

function denyMessage(reason, capability) {
  let msg = "Agentric policy: denied";
  if (capability) msg += ` [${capability}]`;
  if (reason) msg += ` — ${reason}`;
  msg +=
    ". This is a hard block, not a pending approval; no human can approve it as-is. If you believe it" +
    " should be permitted, use policy_check to see the governing rule, then policy_propose or ask a" +
    " human to change it — do not attempt to route around the gate.";
  return msg;
}

/**
 * opencode mints its own session id, so — exactly like Codex's rollout id — the OS has to learn it
 * after the fact to support resume/fork. The plugin is the cleanest place to read it: every hook
 * carries `sessionID`, so there is no log scraping or file watching to race. Reported once per
 * process, fire-and-forget (a failure here must never delay or break a tool call).
 */
let reportedSession = false;
function reportRuntimeSession(sessionID) {
  if (reportedSession || !sessionID) return;
  reportedSession = true;
  fetch(`${AOS_URL}/api/runtime-session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-aos-secret": SECRET, "x-aos-tenant": TENANT },
    body: JSON.stringify({ session: SESSION, runtimeSessionId: sessionID }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

export const AgentricGate = async () => {
  return {
    "chat.message": async (input) => {
      reportRuntimeSession(input.sessionID);
    },

    "tool.execute.before": async (input, output) => {
      reportRuntimeSession(input.sessionID);
      const capability = capabilityFor(input.tool);
      if (!capability) return;

      // `task` spawns a sub-agent, and opencode's plugin hooks are NOT confirmed to fire for a
      // sub-agent's own tool calls (anomalyco/opencode#6396 reports plugin hooks and config `deny`
      // rules being bypassed for SDK/sub-agent invocations). An un-hooked sub-agent would reach the
      // world with no gate, no audit and no run-as identity — the one outcome the invariant never
      // allows — so the spawn itself is refused here rather than gambling on coverage. Revisit by
      // proving interception end to end, then flip `nativeSubagents` in CODING_RUNTIMES.
      if (input.tool === "task") {
        throw new Error(
          "Agentric: sub-agents are disabled on the opencode runtime. Tool calls made by an opencode" +
            " sub-agent are not guaranteed to reach the gate, so spawning one could take ungoverned" +
            " action. Do this work in the current session, or delegate with task_create so the run is" +
            " governed and attributed.",
        );
      }

      const payload = {
        sessionId: SESSION,
        agent: AGENT,
        capability,
        args: { tool: input.tool, input: output.args ?? {} },
        reasoning: `opencode tool.execute.before: ${input.tool}`,
      };

      // FAIL-CLOSED classify. Retry until the gate returns a usable decision; a transient failure
      // (server restart, network blip, the stale-server 401/404 window) must NEVER become an allow.
      let gateId = "";
      for (;;) {
        const body = await classify(payload);
        const decision = body && body.decision;
        if (decision === "allow") return; // `note` (the instruct verb) has no channel here — see steerOnAllow.
        if (decision === "deny") throw new Error(denyMessage(body.reason, body.capability));
        if (decision === "pending") {
          gateId = body.gateId || "";
          break;
        }
        // Unreachable or an unrecognised decision: wait and ask again. The agent blocks here;
        // ungoverned action is impossible.
        console.error("Agentric: gate unreachable — blocking this action until it responds…");
        await sleep(2000);
      }

      console.error("Agentric: this action needs approval — see the inbox. Waiting…");
      let waited = 0;
      for (;;) {
        await sleep(1000);
        const status = await pollStatus(gateId);
        if (status === "allow") return;
        if (status === "deny") throw new Error("Agentric: rejected by human.");
        // Any other status (pending / empty / momentarily unreachable) → keep waiting.
        if (UNATTENDED) {
          waited += 1;
          if (waited >= APPROVAL_WAIT_S) {
            throw new Error(
              `Agentric: no operator approved this within ${APPROVAL_WAIT_S}s on an unattended run —` +
                " blocked (fail-closed). The approval is still in the inbox; a human can approve and" +
                " re-run. Wrap up: report what you did and end the run.",
            );
          }
        }
      }
    },

    // opencode's own permission engine would otherwise raise a second, hidden prompt on top of our
    // decision — and on an unattended run nobody is there to answer it. Agentric is the sole
    // authority (the same posture as `--dangerously-skip-permissions` / `approval_policy = "never"`),
    // so anything that reaches this hook is auto-allowed: it has ALREADY passed the gate above.
    //
    // This is also the half of the fail-closed design that lives in the CONFIG: opencode-launch.sh
    // writes every permission as "ask" and relies on THIS hook to relax it. So if the plugin ever
    // fails to load — opencode ignores any plugin file that is not `.js`, silently — the session
    // degrades to prompting rather than to an ungoverned agent. Do not "simplify" this by setting
    // the config to allow.
    "permission.ask": async (_input, output) => {
      output.status = "allow";
    },
  };
};
