# The `antigravity` runtime

Fourth coding runtime, alongside `claude-code`, `codex` and `opencode`: Google's **Antigravity CLI**
(`agy`). The invariant is unchanged: **every side effect passes through the gateway**. This page maps
what differs from the other runtimes and why, in the same spirit as `docs/codex-runtime.md` and
`docs/opencode-runtime.md`.

Pick it per agent in the console (**Agents → \<agent\> → Runtime tuning → Runtime**). It applies on the
agent's next session.

Every behaviour below was **verified against agy 1.5.18 / 1.5.19 on 2026-11-28** with a signed-in CLI,
not read off docs. The docs embedded in the binary are wrong in at least one load-bearing place: they
name tools by internal step type (`view_file`), but the hook actually receives `read_file`. When agy
updates, re-run the probes in *Re-verifying after an agy upgrade* below.

## How the invariant is held here

agy has a real **PreToolUse command hook** (`hooks.json`), but its wire format is its own:

```
stdin   {"hookEventName":"PreToolUse","toolCall":{"name":"run_command","args":{"CommandLine":"…"}},
         "conversationId":"…","artifactDirectoryPath":"…","cwd":"…", …}
stdout  {"decision":"allow"|"deny","reason":"…"}
```

`terminal/antigravity-gate-hook.sh` is an **adapter**, not a second gate. It translates that wire into
the Claude-shaped event the shared `terminal/gate-hook.sh` already speaks, runs the shared hook, and
translates the answer back. So the fail-closed retry, the approval wait and the unattended timeout stay
in one file.

| agy tool | routed as | capability |
|---|---|---|
| `run_command` (`CommandLine`) | `Bash` | `shell.exec` |
| `manage_task` with `Input` (input to a background task) | `Bash` | `shell.exec` |
| `write_file` (`Path`, `Content`) | `Write` | `file.write` |
| `edit_file` (`Path`, `Target`, `Replacement`) | `Edit` | `file.write` |
| `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`) | `mcp__<server>__<tool>` | `connector.call` (OS tools exempt) |
| `read_file` | `Read` | local protected-path check |
| `search_web`, `update_steps`, `send_message`, `manage_subagents`, `invoke_subagent` | — | allowed, no gate call |
| `schedule`, `swarm`, `run_workflow`, `define_subagent`, `ask_question` | — | **denied**, with the governed alternative |
| anything else | — | **denied** |

Two deliberate differences from the Claude table:

- **An unknown tool is denied.** `gate-hook.sh` ends in `*) exit 0` because a new Claude Code
  built-in is usually a read. agy ships about 100 internal tools across releases, several of which
  reach outside the session: its own cron scheduler, a swarm, script runners, browser automation, Cloud
  SQL, Firebase deploys. Allowing them by default would be wrong.
- **Routing goes by argument shape before name.** A call carrying `CommandLine` is a shell call, and
  one carrying `ServerName` + `ToolName` is a connector call, whatever the tool is named. A tool
  renamed in a future release still lands in the right lane instead of slipping through.

### Facts the design rests on (all verified)

| Behaviour | Consequence |
|---|---|
| A hook that crashes, times out, exits non-zero or prints no `decision` → **deny** | The hook fails closed on its own |
| A hook `allow` does **not** bypass agy's permission engine (headless auto-denies, the TUI prompts again) | We run with `--dangerously-skip-permissions`; the hook is the sole gate, as on the Claude lane |
| `--dangerously-skip-permissions` **still runs hooks** in 1.5.x | A [public write-up](https://agenticcontrolplane.com/blog/antigravity-acp-integration) saying otherwise was about 1.1.21 |
| `permissionOverrides` in a hook answer grants nothing in headless | Not used |
| Subagents' tool calls reach the hook, under the child's conversation id | `invoke_subagent` is allowed (unlike opencode, where sub-agents are disabled) |
| Default `agentMode` is now **Auto**, which approves commands with **no hook at all** | `--settings '{"agentMode":""}'` pins Default. Irrelevant while the hook runs, but it must never be what decides |

## Where the config lives, and why it's global

| Fact (verified) | Consequence |
|---|---|
| A **global** hook (`~/.gemini/config/hooks.json`) fires even in an **untrusted** workspace | The gate is global |
| A **workspace** hook (`<agent>/.agents/hooks.json`) does **not load** in an untrusted workspace, and the TUI **still runs its `-i` prompt behind the trust dialog**, executing commands ungoverned | A missed trust seed must not be the only thing between the agent and the world |
| A workspace **plugin**'s MCP servers load in headless `-p` but **never in the TUI**: the reload races the sign-in and gives up | MCP goes in the global `mcp_config.json` too |
| Hook and MCP processes **inherit agy's environment** | The global entries can be session-agnostic |

So the launcher merges two **session-agnostic** entries into the box user's global config, preserving
everything else there and rewriting only when content changes:

- `hooks.json` → `agentric`: `SessionStart`, `PreToolUse` (matcher `*`, timeout 86400 s so an approval
  can be waited on) and `Stop`. Each one runs `$AOS_AGY_GATE`, inherited from the session.
- `mcp_config.json` → `agentric`: runs `$AOS_AGY_HUB`. That's `terminal/antigravity-mcp-hub.js`, a
  zero-dependency stdio MCP server that reads the session's own `$MCP_CONFIG` (agentos + connectors,
  per run-as identity) and re-exports every tool as `<server>__<tool>`. It speaks stdio and Streamable
  HTTP; legacy HTTP+SSE is skipped, as agy itself does.

Outside an Agentric session the env vars are unset. The box owner's own `agy` then gets a hook that
answers `allow` and an MCP server with no tools, so nothing breaks for them. Concurrent sessions,
agents and tenants never write per-session data into a shared file.

The launcher also pre-seeds `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, under both
the given and the real path. That's the analogue of Claude's `hasTrustDialogAccepted` seed. With the
global hook, a miss leaves the run governed but parked on the dialog, never ungoverned.

### The config defends itself

agy **hot-reloads** `hooks.json`. Removing our entry mid-session ungoverned the very next command. A
workspace `.agents/hooks.json` declaring `{"agentric":{"enabled":false}}` switches the global gate off by
name. Both were verified. So the following are refused:

- **In the adapter (agy sessions):** any write, edit or shell command naming a customization root
  (`.agents/`, `.agent/`, `_agents/`, `_agent/`) or `~/.gemini`. Reads of `~/.gemini` are refused too,
  since it holds the login and every other conversation's transcript. Two exceptions: the current
  conversation's own artifact directory, where agy writes its plans and tasks, and agy's MCP tool-schema
  cache.
- **Engine-level, for every runtime:** `~/.gemini` is a crown-jewel write root in `file-guard.ts`, and any
  `.agents/hooks.json` / `mcp_config.json` / `plugins/` write is denied wherever it sits. agy's login,
  `brain/`, `conversations/`, `settings.json` and `config/` are shell-protected roots in
  `protected-read.ts`. A Claude agent on the same box could otherwise switch the gate off for every agy
  session.
- **At launch:** the launcher refuses to start if the global entry is missing or disabled, or if the
  agent folder already contains a workspace `hooks.json`.

The usual caveat applies: this is an intent check, not a wall. An obfuscated path gets past it; the real
containment is `AOS_UID_ISOLATION`, which agy, like every non-Claude runtime, doesn't support yet.

## Credentials

- **Google sign-in only.** The launcher sets `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`. Otherwise agy picks
  the macOS Keychain or a token file depending on whether it *thinks* it's in an ssh session, so a
  launchd-spawned pane could be signed out while your shell is signed in. The file is
  `~/.gemini/antigravity-cli/antigravity-oauth-token`. The launcher refuses to start without it, because
  agy's fallback is an interactive sign-in that would park an unattended run. One-time setup, as the
  service user, from a normal shell:

  ```bash
  AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy     # complete the Google sign-in, then /exit
  ```
- **`GEMINI_API_KEY` and `AGY_ADC_AUTH` are stripped** from the session environment. Hooks were reported
  not firing under API-key and ADC auth
  ([#893](https://github.com/google-antigravity/antigravity-cli/issues/893),
  [#1310](https://github.com/google-antigravity/antigravity-cli/issues/1310), the latter still open on
  1.4.4). It's not worth an ungoverned run to find out whether they're fixed. The trade-off: an agent
  that needs a Gemini key for its own scripts won't see one in its shell.
- **No account pool.** There's no environment variable that relocates agy's credential directory short
  of `HOME`, so a pooled account can't be swapped in per session (`liveCredentialKinds: []`). The
  Runtime accounts page doesn't offer Antigravity.
- **No self-update.** `AGY_CLI_DISABLE_AUTO_UPDATE=1`, because agy updated itself mid-probe. Install
  and upgrade go through **Settings → Runtime → Runtimes** (Google's installer, which verifies the
  SHA-512 against Google's manifest) or by hand.

## Sessions, transcript, cost

- **Ids are minted by agy.** The `SessionStart` hook reports `conversationId` to `/api/runtime-session`;
  the first write wins, so a subagent's own `SessionStart` can't re-point it. `--conversation <id>`
  resumes (with `-i <task>` for a follow-up). There's no fork.
- **Every lane is the TUI.** It survives a turn, `Stop` beacons `/api/turn-idle` (so unattended runs are
  torn down at turn end and stay attachable until then), and follow-ups typed with `send-keys` work. So
  take-over and resident chat work, unlike opencode.
- **agy outlives its pane.** Like the pane-less `claude` that took globex down, `agy` ignores the loss of
  its terminal: a tmux kill left it and the MCP hub running. The launcher runs agy as a waited child so
  its HUP/TERM trap can fire and kill it. As a backstop it passes `--log-file
  <connectors>/session-<id>.agy.log` first in argv, which lets `process-janitor.ts` reap an agy whose
  pane is gone.
- **Transcript:** `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`,
  parsed by `src/edge/antigravity-transcript.ts` into turns, per-step tokens (summed; `input_tokens`
  excludes the cached part), tool calls, engaged time and the console timeline.
- **Cost is priced only for the Claude models agy serves.** Gemini and gpt-oss runs record real tokens,
  turns and time, but `cost_usd = 0`: these boxes run agy on a Google subscription, and an invented
  per-token rate would mean nothing.

## Models

Ids are what `agy models` lists, with the effort level baked in: `gemini-4-carbon-high`,
`gemini-3.8-flash-medium`, `claude-sonnet-5-5-high`. `--effort` is forwarded too. Foreign ids are refused at
the API edge and cleared by the picker: bare aliases (`opus`), suffix-less Claude ids
(`claude-opus-4-8`), GPT/Codex ids, and opencode's `provider/model`. Conversely, a `gemini-*` id is now
foreign to the other three runtimes.

## Where it degrades

Declared in `CODING_RUNTIMES.antigravity.capabilities`:

- `fork: false`: agy has no fork.
- `nativeSkills: false`: agy discovers `.agents/skills`, and every `.agents/` write is refused, so
  skills aren't materialised yet. That's the main follow-up; it needs the skills dir carved out of the
  self-defence above without re-opening `hooks.json`.
- `steerOnAllow: false`: a hook `reason` reaches the model only on a deny.
- `permissionMode` / `outputStyle` / `statusLine`: Claude Code knobs with no analogue.
- **Local lane only:** refused under `AOS_UID_ISOLATION`, like codex and opencode.

## Re-verifying after an agy upgrade

The adapter's allowlist and every fact above are version-coupled. After upgrading `agy`:

1. `agy -p "List the exact function names of every tool you can call, with argument names." --dangerously-skip-permissions`.
   Diff against the table above. A new tool is denied until it's added deliberately.
2. In a scratch git repo with a logging `PreToolUse` hook, confirm that a deny still blocks under
   `--dangerously-skip-permissions`, that a global hook still fires in an untrusted folder, and that
   hook processes still inherit the environment.
3. `node scripts/antigravity-gate-test.cjs && node scripts/antigravity-mcp-hub-test.cjs`.
