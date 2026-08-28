# Per-agent context allowlists (`skills` / `tools`)

Two optional `AgentManifest` fields that narrow what an agent is **offered**, and nothing else:

| Field | Narrows | Default when absent |
|---|---|---|
| `skills` | which global library skills are materialised into `<agent>/.claude/skills/` at launch | every skill whose own audience admits this agent |
| `tools` | which `mcp__agentos__*` tools the OS-owned MCP server lists | the full always-on set |

Both are **context shaping, not permission**. They change what the model reads; they change nothing
about what an effect is allowed to do. The gateway — policy, approvals, budget, identity, idempotency,
audit — is untouched by either list, and `tools/call` is deliberately left unfiltered. To stop an agent
doing something, write a policy rule; withholding the tool only stops it being *suggested*.

## Why they exist

A skill contributes its name + description to a skills index, and a tool contributes its whole JSON
schema. Both are pinned in the system prompt and re-read on **every turn of every run**. Measured on
the live instawp fleet (2026-08-27):

| | |
|---|---|
| skills materialised per agent | 50–59, from a 60-skill library |
| skill index in the prompt | ~31.7 KB ≈ 8k tokens |
| agentos tool schemas | 68 tools ≈ 19k tokens |
| distinct tools a real 103-call run used | 11 |
| baseline context before the first tool call | ~85k tokens |
| context re-read across that one run | 12.7M tokens |

So roughly **32k of an 85k-token baseline was skills and tools the agent never touched**, paid once
per turn, on every run, fleet-wide. A watchdog agent was carrying `pptx`, `xlsx`, `marketing-plan`
and `aso`.

## Semantics

**Empty means everything, never nothing.** An absent, empty, or all-typo list reads as "no opinion" —
the pre-existing behaviour. This is load-bearing: every agent in every live tenant is uncurated today,
so a default that narrowed anything would silently take capability away from the whole fleet on
upgrade.

**`skills` is ANDed with the skill-side audience.** A skill already has its own audience
(`skill_assignments`, edited in Settings → Skills; empty ⇒ all agents). A skill is materialised only
when its audience admits the agent **and** the agent's list is empty or names it. Neither side can
override the other: a skill owner scoping their skill and an agent owner keeping their agent lean are
independent decisions that compose.

This is the same dual-control shape as secrets — `shellSecrets` is the agent-side list,
`secret_assignments` the admin-side one — deliberately, so there is one pattern to learn.

**`tools` can never strand a run.** `AGENT_CORE_TOOLS` (`src/memory/memory-mcp.ts`) — `report`,
`update`, `ask_human`, `check_inbox`, `notify`, `recall`, `remember` — is always added back. A typo
must cost you the context saving, never the agent's ability to report, ask for help, or record what it
learned; a run that cannot report still burns quota and goes dark to its human. The
capability-gated conditional tools (chat replies, egress, media) keep their own env gating and are not
filtered — withholding a chat-triggered session's own reply tool would break the path it was launched
for.

**Names that match nothing are inert.** A skill that left the library, or a misspelled tool, simply
matches nothing. No error, no launch failure.

**Hand-authored skills are unaffected.** A skill the agent owns under its own `.claude/skills/` is
never managed by the library and always applies.

## Setting them

- **Console** — the agent's Settings card: *Skills it carries* and *Agentric tools it is offered*.
  Space- or comma-separated; blank for everything.
- **API** — `PUT /api/agents/:id/config` with `skills: [...]` / `tools: [...]`. Owner/admin.
- **Manifest** — `skills` / `tools` arrays in `agent.json`.
- **The agent itself** — `agent_update` accepts both. Self-narrowing is safe by construction: an agent
  can only reduce its own offer, never widen a capability, because the lists don't grant anything.

Changes apply at the **next launch**. Curating an agent down also prunes what a previous, wider launch
left in its `.claude/skills/`.

## Verifying

`skills.materialized` audit events carry the count actually applied (and `allowlist` when one was in
play), so "why is my skill not there" is answerable from the trail rather than by reading two tables.

`scripts/per-agent-context-test.cjs` is the falsifier for both properties above — the empty-means-
everything default and the narrow-never-widen rule — and runs in `npm run test:governance`.
