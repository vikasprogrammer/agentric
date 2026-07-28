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
| Shell | PreToolUse hook → `/api/gate` | **same hook, same gate** (`Bash`) |
| File writes | PreToolUse hook | **same hook** (`apply_patch`) + OS sandbox as defence in depth |
| MCP / connectors | PreToolUse hook | **same hook** (`mcp__<server>__<tool>`) |
| The CLI's own prompts | `--dangerously-skip-permissions` | `approval_policy = "never"` |

**Codex reports Claude's exact tool names.** Verified against 0.145: PreToolUse hands the hook
`Bash`, `apply_patch` and `mcp__<server>__<tool>` — *not* the `shell` / `local_shell` names its internal
protocol uses. So there is ONE routing table in `gate-hook.sh` for both runtimes. An earlier
Codex-specific table keyed on `shell` matched nothing, and every shell command fell through the
allow-by-default arm **ungoverned**; a single table makes that class of bug impossible, because a
runtime whose names diverge fails loudly at the `*)` arm instead of silently allowing.

**`apply_patch` carries its target inside the patch envelope**, not a `file_path` field:

```
*** Begin Patch
*** Add File: demo.txt
+apple
*** End Patch
```

`applyPatchTargets()` in `src/governance/enricher.ts` parses the four verbs (`Add`/`Update`/`Delete
File:` and `Move to:`) so `outsideWorkdir` is computed correctly. Without it the enricher saw no path
and fail-safed to "outside" for *every* edit — technically safe, but it would pause a human approval on
every file an agent writes. `Move to:` counts as a target in its own right: moving a file OUT of the
workdir is exactly the escape worth catching.

`network_access` stays **true** — shell egress is already gated, and cutting it would break
`git push` / `npm install` for every agent.

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

## Hook trust — why Codex is `codex exec` only

Codex will not run a hook whose hash it has not recorded as trusted. An untrusted hook is **silently
skipped** — no warning, no error, the run just proceeds ungoverned. `--dangerously-bypass-hook-trust`
lifts that, but only "for that invocation", and it is **ignored in TUI mode**
([openai/codex#24093](https://github.com/openai/codex/issues/24093)).

Both halves were verified locally:

```
codex exec WITHOUT --dangerously-bypass-hook-trust  → hook skipped   (trust is load-bearing)
codex exec WITH    --dangerously-bypass-hook-trust  → hook fires on Bash / apply_patch / mcp__*
```

So **every** Codex run — console, automation, task, chat — goes down `codex exec`, the one lane where
the gate provably runs. The cost is that a Codex session is not attachable or take-over-able
(`attachableUnattended: false`, `residentChat: false`). That is a feature gap; an interactive session
with no PreToolUse hook would be a security hole, and we take the gap.

**Re-enabling the interactive TUI requires pre-seeding hook trust** — Codex stores it as a
`trusted_hash` on the hook entry, but the hashing scheme is not documented and the docs say trust is
recorded only through the interactive `/hooks` review. That is the blocker for attachable Codex
sessions.

> Do **not** write `[features] codex_hooks = true`. There is no such key — `codex features list` names
> the flag `hooks`, and it is already stage=stable and enabled by default. The bogus key was silently
> ignored and gave a false impression that hooks had been switched on.

Two trust gates have to be pre-accepted or every session hangs or dies — the same class of bug as the
Claude lane's `~/.claude.json` seed:

- `[projects."<dir>"] trust_level = "trusted"` — agent folders are freshly created and are **not git
  repos**, so without it `codex exec` fails with *"Not inside a trusted directory"* and the TUI parks on
  a trust prompt. `--skip-git-repo-check` is passed to `exec` as well (it is an exec-only flag).
- `--dangerously-bypass-hook-trust` — Codex refuses a `hooks.json` whose hash it hasn't seen. Ours is
  regenerated every launch from the OS's own hook path, so the hash legitimately changes and there is no
  human to confirm it. Without this the gate would simply never run, which is the unsafe outcome.

---


## Reading a Codex transcript

`src/edge/codex-transcript.ts` is the Codex half of `conversation.ts` + `session-cost.ts`. Four things
differ from Claude Code, and each one is a trap if assumed away:

- **Location.** Claude's transcripts sit in a global `~/.claude/projects/<cwd>/<id>.jsonl`, findable by
  filename. Codex writes `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, and every run has
  its OWN `$CODEX_HOME` — so the reader walks that one session dir.
- **Shape.** One record per line: `{timestamp, type, payload}`, with the interesting variants nested
  under `payload.type` (`event_msg` → `user_message` / `agent_message` / `token_count` / `task_complete`;
  `response_item` → `message` / `custom_tool_call` / `custom_tool_call_output`).
- **Usage is CUMULATIVE.** Claude reports per-request usage that we sum; Codex's `token_count` carries a
  running `total_token_usage` for the whole session. Take the LAST one — summing would multiply the bill
  by the number of turns.
- **`input_tokens` includes the cached portion**, where Anthropic reports them separately. Uncached input
  is `input_tokens - cached_input_tokens`, which is what the input rate applies to.

The timeline is built from `event_msg`, not `response_item`: the response items also carry the
developer/system preamble Codex injects (permissions instructions, plugin lists), which is machinery
rather than conversation and would swamp the view.

One thing to expect: Codex often batches several shell commands into a single `exec` tool call that
scripts `tools.exec_command` internally. So a run's `toolCalls` can read 1 while the gate recorded 3
governed `Bash` effects. Both are right — they measure tool invocations and governed effects
respectively.

## Capabilities and what degrades

`CODING_RUNTIMES` in `src/types.ts` is the single declaration of what each runtime supports. Probe it
with `runtimeSupports(runtime, cap)`; use `isCodingRuntime(runtime)` for "is this a real CLI agent".

| Capability | claude-code | codex | Why |
| --- | --- | --- | --- |
| `pinnedSessionId` | ✅ | ❌ | Codex mints its own rollout UUID; no `--session-id` |
| `resume` / `fork` | ✅ | ✅ | `codex resume <id>` / `codex fork <id>` |
| `attachableUnattended` | ✅ | ❌ | exec-only lane, forced by hook trust — see above |
| `residentChat` | ✅ | ❌ | needs a TUI that survives a turn |
| `transcript` (cost, engaged time, chat timeline) | ✅ | ✅ | `src/edge/codex-transcript.ts` reads the rollout JSONL |
| `nativeSkills` / `nativeSubagents` | ✅ | ❌ | `.claude/skills` + `.claude/agents` are Claude conventions |
| `statusLine` / `permissionMode` | ✅ | ❌ | no equivalent |
| `fileWriteGate` / `mcpGate` | ✅ | ✅ | PreToolUse covers `apply_patch` and `mcp__*` (verified) |
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
