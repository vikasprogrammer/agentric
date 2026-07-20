# Fleet agents as native sub-agents

**Status:** shipped v0.232.0 (materialisation + gate attribution + config route). UI opt-in editor: TODO.

## The idea

Claude Code already has a native, in-process sub-agent runtime: the built-in `Agent`/Task tool spawns
a child defined by a `.claude/agents/<name>.md` file (frontmatter + persona), runs it to completion,
and returns its result inline — sub-second, no separate process. Each Agent OS session *is* a
claude-code process, so we let a running agent spawn **one of our own fleet teammates** as such a
sub-agent: the parent opts in via `usableSubagents`, and at launch we render each named teammate into
its `.claude/agents/<id>.md`.

This is the lightweight sibling of task delegation:

| | Native sub-agent (`usableSubagents`) | `task_dispatch` / `task_wait` |
|---|---|---|
| Runtime | in-process, sub-second, ephemeral | a new governed tmux session |
| Identity / budget / audit | **rolls up to the parent** run | a **distinct principal**, separately accountable |
| Console | invisible (a sub-run of the parent) | first-class session + Kanban card |
| Use it for | "help me finish *my* turn" | "hand off to an accountable teammate" |

Two intents, two tools. Neither replaces the other.

## Why the invariant still holds

Agent OS's one invariant: *every effect an agent has on the world passes the mediated gateway.* A
native sub-agent runs **in the same process** as the parent session, so the **PreToolUse gate hook
fires for the sub-agent's tool calls too** (confirmed against the Claude Code hooks docs). Every
sub-agent effect is therefore still classified / approved / budgeted / audited — there is no ungoverned
path. What changes is only *topology and attribution*:

- The sub-agent acts under the **parent session's principal, run-as identity, and budget** — it is not
  a separate citizen. So the real guardrails on "how much can a session amplify itself" are the two
  knobs below, not a separate governance context.
- Claude Code tags the PreToolUse hook input with `agent_type` + `agent_id` (present *only* for
  sub-agent calls). `terminal/gate-hook.sh` forwards them to `POST /api/gate`, and `TerminalManager.gate`
  stamps `gate.attempt` / `gate.decision` with `subagent` / `subagentId` — so the audit trail shows
  *which* sub-agent produced a governed effect, even though it rolls up to the parent run.

## The two guardrails

1. **`usableSubagents` allow-list** (per parent manifest). Empty/undefined ⇒ the agent spawns no fleet
   sub-agents. Self-references, unknown ids, and non-`claude-code` teammates are ignored at
   materialisation time. Owner/admin-only to set (the agent config route); a self-editing agent can't
   widen its own reach.
2. **Capped toolset** (`SUBAGENT_DEFAULT_TOOLS` in `src/edge/subagents.ts`), written into each
   sub-agent's `tools:` frontmatter: read/search + gated `Bash`/`Edit`/`Write` + memory *recall*.
   Deliberately **excludes** proactive egress (`slack_send`/`discord_send`), the secrets tools,
   `publish`, and the `ask`/`report` operator surface — a delegate has no business reaching those under
   the parent's identity.

## Implementation

- `src/types.ts` — `usableSubagents?: string[]` on `AgentManifest`; `sanitizeUsableSubagents()`.
- `src/edge/subagents.ts` — `materializeSubagents(claudeDir, parent, fleet)` renders each allowed
  teammate to `.claude/agents/<id>.md` (persona = the teammate's `CLAUDE.md`). Idempotent: tracks its
  own files in `.aos-managed.json`, deletes deselected ones, and never touches hand-authored `*.md`.
  Mirrors the skills-materialisation pattern.
- `src/terminal.ts` — `launchClaudeCode` calls `materializeSubagents` right after `materializeSkills`;
  `gate()` takes an optional `subagent` and threads it into the two audit events.
- `terminal/gate-hook.sh` — extracts `agent_type`/`agent_id` (U+001F-separated, so the empty fields of
  a top-level call don't collapse) and forwards them as `subagentType`/`subagentId`.
- `src/server.ts` — `/api/gate` reads those; the agent config route (`GET`/`PUT /api/agents/:id/config`)
  reads/writes `usableSubagents`.

## Follow-ups

- **Console editor.** The config route round-trips `usableSubagents`, but the agent settings UI has no
  picker yet — today you set it by editing `agent.json` (or via `PUT /api/agents/:id/config`). Add a
  multi-select of fleet teammates.
- **Per-parent tool scoping.** One global default toolset today. A parent (or a per-delegate entry)
  could narrow it further.
- **Nesting visibility.** `agent_id` is captured in audit but the console doesn't yet render a sub-run
  tree. A "N sub-agent calls" badge on the session view would make the topology legible.
- **A live-refresh path** (à la `refreshAgentSkills`) so toggling `usableSubagents` reaches a resident
  interactive session without a relaunch. Headless runs pick it up next launch already.
