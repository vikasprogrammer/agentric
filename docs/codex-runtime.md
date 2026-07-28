# The Codex runtime

Agent OS can drive **OpenAI Codex** as well as Claude Code. An agent picks its runtime in its manifest:

```json
{ "id": "my-agent", "runtime": "codex", "...": "..." }
```

`runtime` is one of `mock` | `claude-code` | `codex`. An unrecognised value is warned about loudly at
registration (it would otherwise silently fall back to the scripted mock runner).

Requires `codex` on PATH (`npm i -g @openai/codex`) and a logged-in account (`codex login`, or
`OPENAI_API_KEY`). Verified against **codex-cli 0.145.0**.

---

## How the invariant holds

The one invariant is that *every side effect passes through the gateway*. Claude Code upholds it with a
single mechanism — a PreToolUse hook that intercepts `Bash`, file writes and MCP calls. **Codex's hook
does not reliably cover all three**, so containment is assembled from three complementary parts. The
invariant is unchanged; only the mechanism differs.

| Effect | Claude Code | Codex |
| --- | --- | --- |
| Shell (incl. all `curl`/`git`/`npm` egress) | PreToolUse hook → `/api/gate` | **same hook, same gate** |
| File writes | PreToolUse hook (`Edit`/`Write`/…) | OS sandbox: `writable_roots` = the agent folder |
| MCP / connectors | PreToolUse hook (`mcp__*`) | server-side at the loopback `/api/*` routes |
| The CLI's own prompts | `--dangerously-skip-permissions` | `approval_policy = "never"` |

Notes:

- Codex applies most edits by piping `apply_patch` **through the shell tool**, so those are already
  covered by the gate. The sandbox is the backstop for anything that isn't — and it is *structural*: a
  write outside the agent folder is impossible at the OS level, not merely denied by policy.
- `network_access` stays **true**. Egress driven from the shell is already gated, and cutting it would
  break `git push` / `npm install` for every agent.
- `approval_policy = "never"` removes Codex's *own* prompts (nobody is at the pane to answer them). It
  does **not** touch our gate: the hook still runs and still blocks for inbox approval.

### One shared hook

`terminal/gate-hook.sh` serves both runtimes. Codex 0.145 uses the same PreToolUse stdin fields
(`tool_name` / `tool_input` / `agent_type`) and the same output wire (`permissionDecision` of
`allow|deny|ask`, plus `additionalContext` — so the `instruct` verb carries over) as Claude Code.
Only the tool→capability routing table differs, selected by `$AOS_RUNTIME`.

This is deliberate: two copies would let a governance fix land for one runtime and silently miss the
other.

---

## What the launcher generates

`terminal/codex-launch.sh` redirects Codex at a **per-session `$CODEX_HOME`** (`<home>/connectors/
session-<id>.codex/`, 0700, cleaned up with the rest of the session's files). That keeps our generated
config out of the operator's own `~/.codex`, and it means `sessions/` holds exactly one rollout file —
which is how we discover the id Codex minted.

It writes, fresh on every launch:

- **`config.toml`** — model / `model_reasoning_effort`, the sandbox + approval posture above,
  `features.codex_hooks = true`, the session's MCP servers translated from JSON to Codex's
  `[mcp_servers.<name>]` schema (with nested `.env` for stdio and `.http_headers` for streamable HTTP,
  so Composio's `x-api-key` survives), and a `[projects."<agent dir>"] trust_level = "trusted"` seed.
- **`hooks.json`** — `PreToolUse` with matcher `.*`, so every tool reaches the hook and *our* routing
  table decides what is governed.
- **`AGENTS.md`** in the agent folder — Codex has no `--append-system-prompt-file`, so the persona
  (`CLAUDE.md`, the runtime-neutral persona file every agent already has) and the workspace Company
  context are composed into the file Codex discovers. Regenerated each launch and marked as such.
- **`auth.json`** — symlinked from the real `$CODEX_HOME` so a re-login/token refresh is picked up and
  no credential is duplicated to disk.

**Authentication is a one-time, out-of-band step.** Run `codex login` **from a normal shell as the
service user**, never inside an agent session: `$CODEX_HOME` is per-session, so a login performed in a
pane is written to that session's scratch dir and thrown away with it. The launcher symlinks
`$REAL_CODEX_HOME/auth.json` (default `~/.codex/auth.json`) into each session, so one login covers the
whole fleet. If neither that file nor `OPENAI_API_KEY` is present the launcher **refuses to start** and
prints the fix — it will not let Codex's interactive sign-in menu appear inside an agent session.

Two trust gates have to be pre-accepted or every session hangs or dies — the same class of bug as the
Claude lane's `~/.claude.json` seed:

- `[projects."<dir>"] trust_level = "trusted"` — agent folders are freshly created and are **not git
  repos**, so without it `codex exec` fails with *"Not inside a trusted directory"* and the TUI parks on
  a trust prompt. `--skip-git-repo-check` is passed to `exec` as well (it is an exec-only flag).
- `--dangerously-bypass-hook-trust` — Codex refuses a `hooks.json` whose hash it hasn't seen. Ours is
  regenerated every launch from the OS's own hook path, so the hash legitimately changes and there is no
  human to confirm it. Without this the gate would simply never run, which is the unsafe outcome.

---

## Capabilities and what degrades

`CODING_RUNTIMES` in `src/types.ts` is the single declaration of what each runtime supports. Probe it
with `runtimeSupports(runtime, cap)`; use `isCodingRuntime(runtime)` for "is this a real CLI agent".

| Capability | claude-code | codex | Why |
| --- | --- | --- | --- |
| `pinnedSessionId` | ✅ | ❌ | Codex mints its own rollout UUID; no `--session-id` |
| `resume` / `fork` | ✅ | ✅ | `codex resume <id>` / `codex fork <id>` |
| `attachableUnattended` | ✅ | ❌ | unattended lane is `codex exec`, which exits at turn end |
| `residentChat` | ✅ | ❌ | needs a TUI that survives a turn |
| `transcript` (cost, engaged time, chat timeline) | ✅ | ❌ | the parser only reads Claude's JSONL |
| `nativeSkills` / `nativeSubagents` | ✅ | ❌ | `.claude/skills` + `.claude/agents` are Claude conventions |
| `statusLine` / `permissionMode` | ✅ | ❌ | no equivalent |
| `fileWriteGate` / `mcpGate` | ✅ | ❌ | contained by sandbox / server-side instead — see above |
| `steerOnAllow` | ✅ | ✅ | both support `additionalContext` |

**Session ids.** Because Codex won't take a pinned id, `codex-launch.sh` watches its per-session
`sessions/` dir for `rollout-<ts>-<uuid>.jsonl`, extracts the UUID and POSTs it to
`POST /api/runtime-session` (session-secret gated, first write wins). It is stored in the existing
`term_sessions.claude_session_id` column, which now holds the transcript id for whichever runtime drove
the run — left un-renamed to avoid a migration plus ~25 call sites for no behavioural gain.

**Not supported:** `AOS_UID_ISOLATION`. The Phase A launcher materialises a fixed set of files into the
member home and knows nothing about a per-session `$CODEX_HOME`, so the config and hooks would land
outside the member's reach. A Codex launch under the flag is **refused** and the session is marked
crashed with the reason — never spawned with the gate unwired.

---

## Testing it

`npm run test:governance` covers the shared policy engine. For the Codex path specifically, the check
that matters is that a Codex-shaped tool call reaches the gate and is classified correctly:

```
tool_name=shell, tool_input={"command":["bash","-lc","ls -la"]}                  → allow
tool_name=shell, tool_input={"command":["bash","-lc","rm -rf / --no-preserve-root"]} → deny
tool_name=read_file                                                             → silent exit 0
tool_name=agentos__recall                                                       → silent exit 0
```

Drive `terminal/gate-hook.sh` with `AOS_RUNTIME=codex` and that stdin, against a server booted on an
**isolated `AGENT_OS_HOME`**. Two traps when writing such a harness:

- Invoke the hook **asynchronously**. If the server is in-process, a synchronous `execFileSync` blocks
  Node's event loop and the hook's `curl` never gets a reply — which looks exactly like "gate unreachable".
- `loadAgentOS()` with no env resolves to the **live** `./data` home. Always set `AGENT_OS_HOME`.

### The bug this found

Codex sends `command` as an **argv array** (`["bash","-lc","…"]`); Claude sends a **string**. The
enricher's extraction was `typeof v === 'string' ? v : ''`, so every Codex shell call was classified
against an *empty* command — no destructive pattern could match and the gate allowed `rm -rf /`.
Fixed by `commandText()` in `src/governance/enricher.ts`, which normalises both shapes; the briefer uses
it too, so approval cards don't render an empty command. Any future runtime that sends argv arrays is
covered.
