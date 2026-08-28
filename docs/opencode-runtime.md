# The `opencode` runtime

Third coding runtime, alongside `claude-code` and `codex`. Same invariant — **every side effect
passes through the gateway** — held by a *third* mechanism. This page is the map of what differs and
why, in the same spirit as `docs/codex-runtime.md`.

Pick it per agent in the console (**Agents → \<agent\> → Runtime tuning → Runtime**). It applies on
the agent's next session; a live conversation is not portable between runtimes.

## How the invariant is held here

opencode has **no command-hook facility at all**. There is no `PreToolUse` shell hook to point at
`terminal/gate-hook.sh`, which is why the shared hook the other two runtimes use could not be
reused. Its only pre-execution extension point is a **JS plugin**:

```
Hooks["tool.execute.before"](input: {tool, sessionID, callID}, output: {args}) → throw to BLOCK
```

So `terminal/opencode-gate-plugin.js` is a **second implementation of the same contract**: route the
tool to a capability, `POST /api/gate`, then allow / throw / block-until-approved / fail closed. It
talks to the identical server endpoints the shell hook does.

> **Two implementations of one invariant.** That is exactly the shape where a governance fix lands in
> one file and silently misses the other. `scripts/opencode-gate-test.cjs` pins the properties that
> make it a gate (routing coverage, deny throws, unreachable blocks, unattended fails closed,
> sub-agents refused). Change one file, re-read the other.

| Capability | claude-code | codex | opencode |
|---|---|---|---|
| `shell.exec` | PreToolUse hook | PreToolUse hook | plugin `tool.execute.before` |
| `file.write` | PreToolUse hook | OS sandbox (`writable_roots`) | plugin (`write`/`edit`/`patch`) |
| `connector.call` | PreToolUse hook | server-side loopback | plugin (`mcp__*`) + loopback |
| network reads | via `bash` | via `shell` | plugin (`webfetch`/`websearch`) + `bash` |

## Fail-closed by construction (the important bit)

opencode's plugin discovery loads **`.opencode/plugin/*.js` only**. A plugin named `.mjs` or `.ts` is
**ignored silently — no warning, no error** (verified against 1.17). A gate that fails to load would
otherwise produce a fully ungoverned agent that looks completely normal.

So the generated `opencode.json` deliberately writes every permission as **`"ask"`**, and the plugin
relaxes each to `allow` from its own `permission.ask` hook once the gate has decided:

- plugin **loaded** → it decides; opencode's own prompts never fire.
- plugin **missing** → opencode falls back to *asking*, which an unattended run simply blocks on.

Either way there is no ungoverned effect. **Do not "simplify" the config to `allow`** — that trades
a safe failure for a silent one. Both halves are asserted by the test.

Two related guards: the launcher must never pass **`--pure`** (it runs opencode *without* external
plugins, i.e. without the gate), and the plugin file extension is pinned.

## Sub-agents are disabled, deliberately

`tools: { task: false }` in the config **and** an explicit refusal in the plugin. opencode's plugin
hooks are **not confirmed** to fire for a sub-agent's own tool calls — anomalyco/opencode#6396
reports plugin hooks and config `deny` rules being bypassed for SDK/sub-agent invocations. An
un-hooked sub-agent would reach the world with no gate, no audit and no run-as identity.

Belt and braces on purpose: config removes the tool, the plugin refuses it if it ever reappears.
Delegation still works the governed way — `task_create` spawns a real, attributed session.

To revisit: prove interception end to end, then flip `nativeSubagents` in `CODING_RUNTIMES`.

## Where it degrades

Declared honestly in `CODING_RUNTIMES.opencode.capabilities`; the console renders the list under the
picker, so an operator sees the trade before saving.

- **`attachableUnattended: false` / `residentChat: false`** — the unattended lane is `opencode run`, a
  one-shot process that exits at turn end. Nothing to attach to, so no take-over and no warm chat.
  (This is the shape Codex's `exec` lane had before it became attachable.)
- **`transcript: false`** — **no cost, engaged time, or chat timeline for an opencode run.**
  `opencode export <sessionID>` is the intended source, but no parser exists yet, and claiming the
  capability would surface invented numbers. `readCostFor`/`sessionConversation` return
  "unknown"/empty rather than falling through to the Claude reader, which would resolve a foreign id
  against `~/.claude/projects` and answer confidently wrong. **This is the main follow-up.**
- **`nativeSkills: false`** — skills are materialised as `.claude/skills`, which opencode does not
  discover. It has its own mechanism; not wired.
- **`steerOnAllow: false`** — a throw is the plugin's only channel and it *aborts* the call. There is
  no field carrying an advisory note alongside an allow, so the gate's `instruct` verb degrades to a
  plain allow.
- **`permissionMode: false`** — a Claude Code flag with no analogue; Agentric is the sole authority.

## System prompt: `AGENTS.md`, not `CLAUDE.md`

**Only Claude Code auto-loads `CLAUDE.md`.** An agent's `CLAUDE.md` is the runtime-neutral persona
file, so — exactly as the Codex launcher does — `opencode-launch.sh` composes **`AGENTS.md`** in the
agent folder from that persona plus the workspace Company context, regenerated each launch and
marked as generated. opencode discovers `AGENTS.md` from the workspace root.

## Models, credentials, sessions

- **Models are `provider/model`** (`anthropic/claude-opus-4-8`, `openai/gpt-5-codex`). A bare
  `claude-opus-4-8` is rejected as foreign — the picker also clears a model that belongs to the
  runtime being left. Reasoning effort is a per-provider `--variant` rather than a portable scale, so
  the `effort` knob is not forwarded.
- **Credentials** live at `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share`), so
  `configDirVar` is `XDG_DATA_HOME` and the pool rotates by pointing it at an account dir.
  `OPENCODE_API_KEY` is the usage-billed alternative. Per-provider keys (`ANTHROPIC_API_KEY`, …)
  still work when injected as shell secrets — they are simply not the rotation var.
  The launcher **refuses to start unauthenticated**: opencode's fallback is an interactive provider
  picker that waits on a keypress, which parks an unattended run forever — the same permanent-hang
  class as the Claude folder-trust dialog and the Codex sign-in menu.
- **Session ids** are minted by opencode. The **plugin reports it back** to `/api/runtime-session`
  (every hook carries `sessionID`), which is cleaner than the file-watching the Codex launcher needs.
  `--session <id>` resumes; `--session <id> --fork` branches.

## Installing it

Settings → Runtime → **Runtimes** lists every runtime and whether its CLI is on this box, with a
one-click install (owner-only, audited `runtime.install.*`). The agent runtime picker shows the same
prompt when you select a runtime the box lacks, so you can't save a choice whose every session would
park on *"the 'opencode' CLI is not on PATH"*. Manual equivalent: `npm install -g opencode-ai`.

Presence is probed with the **same PATH a session gets**, or the console would report "missing" for a
CLI the agent would in fact find. Install trusts the **re-probe, not npm's exit code** — npm can exit
0 with the shim landing off PATH.
