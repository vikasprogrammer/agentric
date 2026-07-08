# Agent-facing MCP tools — coverage matrix

The OS injects one stdio MCP server (`agent-os`) into every claude-code session, defined in
`src/memory/memory-mcp.ts`. Each tool is a thin loopback `fetch` to a session-scoped `/api/*` route
(session-secret + tenant gated, sitting *before* the member-auth gate in `src/server.ts`). The agent
can only ever act as its own session; the namespace/tenant/policy are enforced server-side.

## Tools ↔ routes ↔ stores

| Tool | Route | Server-side | Read/Write | Notes |
|---|---|---|---|---|
| `recall` | `GET /api/memory/recall` | `MemoryProvider.recall` | R | returns each memory's `id` (handle for revise/forget) |
| `remember` | `POST /api/memory/remember` | `MemoryProvider.store` | W | `shared:true` may be downgraded in a curated workspace |
| `revise` | `POST /api/memory/revise` | `MemoryProvider.update` | W | author-guarded; audited `memory.revised` |
| `forget` | `POST /api/memory/forget` | `MemoryProvider.delete` | W | author-guarded; audited `memory.forgotten` |
| `kb_search` | `GET /api/kb/search` | `KbStore.search` | R | |
| `kb_read` | `GET /api/kb/read` | `KbStore.read` | R | |
| `kb_write` | `POST /api/kb/write` | `KbStore.write` | W | versioned; author `agent:<id>` |
| `kb_history` | `GET /api/kb/history` | `KbStore.history` | R | newest-first revisions |
| `kb_revert` | `POST /api/kb/revert` | `KbStore.revert` | W | itself a new revision; audited `kb.reverted` |
| `ask` | `POST /api/ask` + poll | questions | W (blocking) | blocks ~1h polling for the human answer |
| `check_inbox` | `GET /api/inbox` | `TerminalManager.sessionInbox` | R | non-blocking pull of this session's feed |
| `report` | `POST /api/report` | messages | W | `outcome` enum |
| `update` | `POST /api/update` | messages | W | non-blocking progress note |
| `publish` | `POST /api/publish` | `ArtifactStore` | W | snapshots the file |
| `skill_propose` | `POST /api/skills/propose` | `SkillsStore.propose` + messages | W | drafts a `.aos-proposed` skill (never materialised) + posts a `skill.proposed` inbox card to owner/admins; audited `skill.proposed`. Human publishes via `POST /api/skills/:name/publish` (owner/admin) or dismisses via `DELETE /api/skills/:name` |
| `artifacts_list` | `GET /api/agent/artifacts` | `ArtifactStore.list` | R | scoped to the agent's own deliverables |
| `schedule` | `POST /api/agent/schedule` | `Automations.schedule` (`type:'once'`) | W | one-shot deferred self-run; same agent + run-as; bounded 1 min–30 days, ≤25 pending/agent |
| `unschedule` | `POST /api/agent/schedule/cancel` | `Automations.cancelScheduled` | W | cancel a pending one, scoped to the agent |
| `list_capabilities` | `GET /api/agent/policy` | policy preview | R | |
| `policy_check` | `POST /api/agent/policy/check` | policy preview | R | dry-run, no side effects |
| `directory_lookup` | `GET /api/agent/directory` | `TeamStore` | R | people + their chat identities |
| `task_create` | `POST /api/tasks/create` | `TaskStore.create` | W | files a unit of work; author `agent:<id>`; owner = run-as (delegation passthrough); `mode` headless/interactive for the dispatched run |
| `task_list` | `GET /api/tasks/list` | `TaskStore.list` | R | `assignee:"me"` → self; board query/FTS |
| `task_get` | `GET /api/tasks/get` | `TaskStore.withEvents` | R | task + full activity timeline |
| `task_claim` | `POST /api/tasks/claim` | `TaskStore.claim` | W | atomic take (→ doing); loses if already claimed |
| `task_update` | `POST /api/tasks/update` | `TaskStore.update` | W | status/note/reassign; closes a dispatched loop |
| `agent_create` | `POST /api/agents/create` | `AgentOS.registerAgent` | W | writes `<home>/agents/<id>/{agent.json,CLAUDE.md}` + registers live; author `agent:<id>`; audited `agent.created` |
| `agent_update` | `POST /api/agents/update` | `AgentOS.registerAgent` | W | rewrites manifest (+CLAUDE.md); user-home agents only; audited `agent.config.updated` |
| `secret_put` | `POST /api/agent/secret/put` | `TerminalManager.putSecret` | W | shared-scope (`*`) vault write; **approval-gated** (policy `secret.put`, blocks until decided); value NEVER in audit/approval-card/policy args; audited `secret.put` (key only); `updated_by=agent:<id>` |
| `secret_get` | `POST /api/agent/secret/get` | `TerminalManager.getSecret` | R | returns plaintext to caller; allow+audit (a policy `deny`/`ask` on `secret.get` refuses — reads never hang); audited `secret.get` (key + found, never value) |
| `secret_list` | `GET /api/agent/secret/list` | `TerminalManager.listSecrets` | R | shared (`*`) secret KEYS + metadata only, never values |
| `slack_reply` | `POST /api/agent/slack/reply` | SlackSocket | W | only when `SLACK_REPLY=1` (chat-triggered) |
| `discord_reply` | `POST /api/agent/discord/reply` | DiscordSocket | W | only when `DISCORD_REPLY=1` (chat-triggered) |

31 always-on tools + 2 conditional. Read-only tools carry `annotations.readOnlyHint`; `forget`
carries `destructiveHint`. All schemas set `additionalProperties:false`; enum fields (`type`,
`outcome`) and numeric bounds (`importance`, `limit`) are constrained in-schema.

### `secret_put` / `secret_get` — the shared credential handoff

The A2A way to pass a password/API key/token between agents **without the value ever touching a
durable plane**. Agent A `secret_put`s a value under a KEY (stored tenant-wide, encrypted at rest);
it tells agent B the key NAME (in a task/message/report — a handle, never the value); B `secret_get`s
it and uses it read-once. The design invariant: the plaintext lives only in the vault row and the
live `secret_get` response — it is deliberately kept out of `gate.attempt`/audit, the approval card,
and the policy args (all of which persist). `secret_put` is **approval-gated** (`secret.put` → `ask`
admin in the default policy) and blocks the call until a human decides, unless an owner/admin is
already attending the run (governance P5 auto-clear). `secret_get`/`secret_list` are allow+audit.
Because the scope is shared (tenant-wide `*`), any agent can read any stored key — only put things
meant for the team, and manage/rotate them from the console **Secrets** page (agent-written keys show
`updated_by = agent:<id>`). Not yet done: generic cross-plane redaction (scrubbing a leaked value out
of memory/KB/inbox if an agent ignores the read-once guidance) — tracked as a follow-up.

### `schedule` — governance model

A scheduled run is a **time-shift of work the agent is already authorized to do**: same agent, same
run-as identity, just later. So it takes **no fresh approval** — but it's bounded against runaway use:
1 minute ≤ horizon ≤ 30 days, and ≤25 pending (enabled, unfired) one-shots per agent
(`SCHEDULE_*` in `automations.ts`). Each one is a normal `type:'once'` automation row, so it's
**transparent** (shows in the console Automations page), **auditable** (`automation.scheduled` /
`automation.fired`), and **reversible** (a human, or the agent via `unschedule`, can cancel it). The
scheduler `tick()` fires it once when due, then disables it. Recurring (cron) schedules remain
human-only. A future tightening could classify `schedule` through Policy for workspaces that want
sign-off on deferred runs.

### `agent_create` / `agent_update` — governance model

These are the **agent-author's** build tools (the default *System* agent provisioned by
`src/edge/agent-author.ts`), though — like the Tasks tools — they're the general **delegation surface**
available to any agent. Creating an agent **definition escalates nothing**: the new agent still passes
every side effect through the gate, and only a **human** can run or assign it (spawn is role-gated). So
they follow the same **auto-apply + audited** posture as `kb_write` / `task_create` — no approval card —
emitting `agent.created` / `agent.config.updated` with `principal: agent:<id>`. Guards: strict id
validation + collision check on create; `agent_update` only touches agents that live under the data home
(the read-only bundled examples can't be edited) and rewrites only the fields the caller supplied. A
future tightening could classify agent creation through Policy for workspaces that want sign-off.

## Remaining gaps (not yet exposed)

- **Delegation / sub-agents.** Partially closed by the **Tasks** plane: an agent files a task assigned
  to `agent:<id>` (with `autoDispatch`) and the scheduler tick spawns a governed session that works it —
  async, durable, human-passthrough run-as (the task `owner`), guarded + attempt-ceilinged. What's still
  missing is **synchronous** delegation (an agent blocking on another's result) and an agent-triggered
  `task_dispatch` (today agents `claim` into their own session; direct spawn stays human/tick-only). Both
  still want budget attribution + recursion-depth limiting before they ship (`docs/tasks-plan.md` §9).
- **Proactive person-to-person DM.** `directory_lookup` finds a teammate's Slack/Discord id and the
  server has `dmUser` (the approval notifier path), but the only outbound chat tools (`slack_reply`/
  `discord_reply`) post to the *triggering* thread. An agent can't DM a specific person off-thread.
- **Episodic self-query.** Memory is semantic-only; an agent can't query its own past runs
  (`/api/runs` exists but is member-gated). "Have I done this before, how did it go?"
- **`ask` rigidity.** Timeout hardcoded ~1h; no `timeoutSeconds` and no non-blocking ask-then-collect
  (partially mitigated now by `check_inbox`).
- **Cross-agent artifact/KB read of file contents.** `artifacts_list` returns metadata only and is
  scoped to the agent's own outputs; reading a sibling agent's published file back has no tool.
- **No generic "perform capability" tool** — by design. Effects flow through real tools + the
  PreToolUse gate hook; `policy_check`/`list_capabilities` are preview-only.
