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
| `kb_search` | `GET /api/kb/search` | `KbStore.search` + `KbStore.sections` | R | also returns the existing section/folder tree so a new page files into the established structure (discovery) |
| `kb_read` | `GET /api/kb/read` | `KbStore.read` | R | |
| `kb_write` | `POST /api/kb/write` | `KbStore.write` | W | versioned; author `agent:<id>`; `section` may nest with `/` (`engineering/backend`) → folder tree |
| `kb_history` | `GET /api/kb/history` | `KbStore.history` | R | newest-first revisions |
| `kb_revert` | `POST /api/kb/revert` | `KbStore.revert` | W | itself a new revision; audited `kb.reverted` |
| `ask_human` | `POST /api/ask` + poll | questions | W (blocking) | blocks ~1h polling for the human answer; DMs the addressee out-of-band (`question.notified`) + mirrors to the chat thread so it isn't missed. The human answers **either from the web console Inbox** (`POST /api/questions/:id/answer`, cookie-gated) **or by REPLYING to the Slack/Discord DM** — the notifier binds the question to that DM (`question_dms`), and an inbound reply from that user is matched to the newest pending bound question and recorded as the answer (`answerQuestionFromChat`, attributed to their member email, `canViewQuestion`-gated; audited `question.answered.viaDm`), then acked in-thread. A DM that isn't answering a pending question falls through to the normal chat router. Default addressee = the run's operator (`sessionOwner`); optional `to` (name/email) routes the question to a SPECIFIC other member instead (card + DM target them, and `canViewQuestion` grants them the answer) — the "ask a teammate for info / a confirmation" channel. (Renamed from `ask`; `ask` still accepted as a hidden alias.) |
| `ask_agent` | `POST /api/ask-agent` + poll | `TerminalManager.askAgent`/`agentAskStatus` + `agent_asks` | W (blocking) | **synchronous agent→agent Q&A**, the machine sibling of `ask_human`: spawns the target agent as a one-off HEADLESS delegate (provenance `ask:<caller>`, run-as passthrough, every effect still gated) primed with the question, then long-polls `GET /api/ask-agent/:id` until it answers. Returns the answer inline. Optional single-line `goal` opens the delegate under a `/goal` convergence condition (it works to the objective before answering — the taskless "delegate WITH a goal" path). NO task row / board / inbox surface — an ephemeral request/response. Self-heals: a delegate that dies without answering (past a grace) → `failed` so the caller unblocks. Same wait envelope as `task_wait` (`AOS_TASK_WAIT_S`, max 6h); audited `agent.asked` |
| `answer` | `POST /api/agent/answer` | `TerminalManager.answerAgentAsk` + `agent_asks` | W | delegate-only (exposed when `ASK_ANSWER=1`, keyed on the `ask:` provenance): returns the delegate's result to the agent that asked and ends its run. The server resolves WHICH ask from the delegate's session, so it can't spoof the target; audited `agent.answered` |
| `check_inbox` | `GET /api/inbox` | `TerminalManager.sessionInbox` | R | non-blocking pull of this session's feed |
| `report` | `POST /api/report` | messages | W | `outcome` enum |
| `update` | `POST /api/update` | messages | W | non-blocking progress note (session-owner scoped) |
| `notify` | `POST /api/notify` | messages + member DM | W | notify ONE named teammate (`to` = name/email); inbox card addressed to them + Slack/Discord DM; the escape hatch from session-owner scoping — see below |
| `publish` | `POST /api/publish` | `ArtifactStore` | W | snapshots the file to the **Library**; optional `folder` path (`reports/2024`) files it into a Library folder |
| `skill_propose` | `POST /api/skills/propose` | `SkillsStore.propose` + messages | W | drafts a `.aos-proposed` skill (never materialised) + posts a `skill.proposed` inbox card to owner/admins; audited `skill.proposed`. Human publishes via `POST /api/skills/:name/publish` (owner/admin) or dismisses via `DELETE /api/skills/:name` |
| `host_propose` | `POST /api/hosts/propose` | `HostStore.propose` + messages | W | drafts an INACTIVE, credential-less org Host connection (`proposed=1, enabled=0` — excluded from every grant set until published) + posts a `host.proposed` inbox card to owner/admins; audited `host.proposed`. Human publishes via `POST /api/hosts/:id/publish` (owner/admin, flips it active) or dismisses via `DELETE /api/hosts/:id`. The agent CANNOT set a credential — the admin attaches the vault ref |
| `skill_find` | `GET /api/skills/discover` | `TerminalManager.requestableSkills` (+ `searchSkillsh` when `q`) | R | the caller's installed library (each flagged `active` for this agent) + the bundled catalog — what's installable to ask for; with a `query` also returns matching **community** skills from the skills.sh directory, each with its `source` (`owner/repo`) |
| `skill_request` | `POST /api/skills/request` | `TerminalManager.requestSkill` + messages | W | **asks** an owner/admin to install a skill (never installs itself). `source` omitted ⇒ the bundled catalog (validated against it); `source: 'owner/repo'` ⇒ a **remote GitHub repo** (`browseRepo` resolves the skill + its path at request time so a typo fails fast). Dedupes an open request for the same skill+source, posts a `skill.request` card to owner/admins; audited `skill.requested`. Human installs via `POST /api/skills/requests/:id/approve` (owner/admin; catalog → `SkillsStore.install`, remote → `fetchSkill` + `installFiles`; optional `scope:'agent'`) or dismisses via `POST /api/skills/requests/:id/dismiss`. On approve, `TerminalManager.refreshAgentSkills` delivers same-session to the requester's LIVE interactive sessions (materialise into the watched `.claude/skills` + inject `/reload-skills`, claude ≥2.1.152); headless/next-launch otherwise |
| `library_list` | `GET /api/agent/artifacts` | `ArtifactStore.list` + `ArtifactStore.folders` | R | list scoped to the agent's own deliverables in the Library; also returns the tenant-wide Library folders so a `publish` files into the existing tree (discovery) |
| `schedule` | `POST /api/agent/schedule` | `Automations.schedule` (`type:'once'`) | W | one-shot deferred self-run; same agent + run-as; **resumes the scheduling conversation by default** (`resume_claude_id` → `--resume` the transcript; `resume:false` = fresh session); bounded 1 min–30 days, ≤25 pending/agent |
| `unschedule` | `POST /api/agent/schedule/cancel` | `Automations.cancelScheduled` | W | cancel a pending one, scoped to the agent |
| `stop` | `POST /api/agent/stop` | `TerminalManager.stopSession` (`by` = agent id) | W | the session ends ITSELF — same halt as the console kill (kills tmux, cancels its pending questions/approvals, blocks auto-resume, writes a `stopped` episode). Server acks then halts ~150ms later so the reply flushes first; audited `session.stopped` with the agent id + optional `reason` |
| `list_capabilities` | `GET /api/agent/policy` | policy preview | R | |
| `policy_check` | `POST /api/agent/policy/check` | policy preview | R | dry-run, no side effects |
| `directory_lookup` | `GET /api/agent/directory` | `TeamStore` | R | people + their chat identities |
| `task_create` | `POST /api/tasks/create` | `TaskStore.create` | W | files a unit of work; author `agent:<id>`; owner = run-as (delegation passthrough); `mode` headless/interactive for the dispatched run; optional `due` (ISO date) soft deadline; optional `goalId` (link to a strategic goal; a sub-task inherits its parent's `goalId` when omitted) + single-line `goal`/`criteria` (synonyms — the objective that drives a headless dispatch under a `/goal` convergence condition — Slice 2) + `dependsOn` (task ids this is blocked by — won't dispatch until they're done; cycle/self/missing rejected). **Async poke-back**: `poke_on_done:true` (agent→agent hand-off only) stamps the caller's agent id + pinned claude transcript on the task (`caller_agent`/`caller_claude_id`); on the delegate closing the loop (done/blocked) the task notifier `--resume`s the caller's transcript with the outcome (`Automations.pokeCaller`, provenance `poke:<task>`, guarded against a still-live caller; audited `agent.poked`) — the fire-and-forget counterpart to `wait` (which blocks). Implies `autoDispatch` |
| `task_list` | `GET /api/tasks/list` | `TaskStore.list` | R | `assignee:"me"` → self; board query/FTS |
| `task_get` | `GET /api/tasks/get` | `TaskStore.withEvents` | R | task + full activity timeline |
| `task_claim` | `POST /api/tasks/claim` | `TaskStore.claim` | W | atomic take (→ doing); loses if already claimed |
| `task_update` | `POST /api/tasks/update` | `TaskStore.update` | W | status/note/reassign/reprioritise/`due` (ISO date, or "" to clear); link/unlink `goalId`, set/clear `criteria`, replace `dependsOn` (`[]` clears); closes a dispatched loop |
| `task_wait` | `POST /api/tasks/wait` | `Automations.dispatchTask` + `TaskStore.get`/`latestNote` | W | **synchronous handoff**: long-polls until a task hits done/cancelled/blocked, then returns its closing note. Kicks a guarded immediate dispatch each poll if the task is stalled (not terminal, not `blocked`, agent-assigned, nothing live on it) so waiting DRIVES the work + auto-retries a crashed run (bounded by `TASK_MAX_ATTEMPTS`). Caller session stays alive on the pending call and resumes on completion (same shape as `ask`). Headless parks after `AOS_TASK_WAIT_S` (default 900s), interactive waits longer |
| `task_attach` | `POST /api/tasks/attach` | `TerminalManager.attachTaskFile` → `TaskStore.attachFromPath` | W | snapshots a file from the caller's OWN working folder onto a task (path resolved strictly under the agent folder, like `publish`); logs an `attach` event; audited `task.attached` |
| `task_dispatch` | `POST /api/tasks/dispatch` | `Automations.dispatchTask` | W | spawns a governed session NOW for an agent-assigned task (async hand-off, distinct from `task_claim`); `guard:true` (no pile-up) + `TASK_MAX_ATTEMPTS` ceiling; run-as = task owner; audited `task.dispatched` (`by:agent:<id>`) |
| `goal_list` | `GET /api/goals/list` | `GoalStore.list` | R | the strategic layer (company goals); filter by `status`/`query`; read-only |
| `goal_get` | `GET /api/goals/get` | `GoalStore.withEvents` + `.progress` + `TaskStore.tasksForGoal` | R | one goal + its full activity timeline + **derived progress** (% from linked tasks) + the linked tasks |
| `goal_propose` | `POST /api/goals/propose` | `GoalStore.create` (status `draft`) + `TerminalManager.postGoalCard` | W | drafts a NOT-YET-ACTIVE goal + posts a `goal.proposed` inbox card to admins; owner = run-as; auto-apply + audited `goal.proposed`. Agents READ + PROPOSE only — activating/editing a goal is a human owner/admin console action (no agent write path) |
| `agent_create` | `POST /api/agents/create` | `AgentOS.registerAgent` | W | writes `<home>/agents/<id>/{agent.json,CLAUDE.md}` + registers live; author `agent:<id>`; audited `agent.created` |
| `agent_update` | `POST /api/agents/update` | `AgentOS.registerAgent` + `AgentRevisions.commit` | W | **self-only** (edits the caller's OWN manifest/CLAUDE.md — a body `id` must equal the session's agent); user-home agents only; snapshots a revision; audited `agent.config.updated` |
| `agent_history` | `POST /api/agents/history` | `AgentRevisions.list` | R | the caller's own listing revisions (rev/author/summary/date), newest first |
| `agent_revert` | `POST /api/agents/revert` | `AgentRevisions` + `AgentOS.registerAgent` | W | **self-only**; restores a prior revision (description/prompts/tuning/CLAUDE.md), records the revert as a new revision; audited `agent.config.reverted` |
| `app_create` | `POST /api/apps/create` | `AppStore.scaffold` | W | builds a hosted app (single-file `server.js` for v1) under `<home>/apps/<slug>/`; lands **proposed** (`published:false`, inert until a human publishes); posts an `app.proposed` review card; audited `app.created` |
| `app_list` | `GET /api/apps/list` | `AppStore.list` + `AppSupervisor.statusOf` | R | the workspace's apps + live status (published?, cold/ready) so an agent can build on / not duplicate |
| `app_update` | `POST /api/apps/update` | `AppStore.save` | W | edits an app's manifest/source; **editing a published app unpublishes it** (`AppSupervisor.kill`) + posts a re-review card — app code never goes live without human re-publish; audited `app.updated` |
| `app_files` | `GET /api/apps/files` | `AppStore.listFiles`/`readFile` | R | lists an app's source tree (paths + sizes), or reads one file with `path` — for building on / editing a multi-file app |
| `app_write_file` | `POST /api/apps/file/write` | `AppStore.writeFile` | W | create/overwrite ONE source file (multi-file apps: `app/routes/…`, `app/lib/…`); path sandboxed under the app folder, manifest + `data.db` protected; editing a live app unpublishes it; audited `app.file.written` |
| `app_delete_file` | `POST /api/apps/file/delete` | `AppStore.deleteFile` | W | delete a source file (never the entry/manifest/runtime state); audited `app.file.deleted` |
| `secret_put` | `POST /api/agent/secret/put` | `TerminalManager.putSecret` | W | shared-scope (`*`) vault write; **approval-gated** (policy `secret.put`, blocks until decided); value NEVER in audit/approval-card/policy args; audited `secret.put` (key only); `updated_by=agent:<id>` |
| `secret_get` | `POST /api/agent/secret/get` | `TerminalManager.getSecret` | R | returns plaintext to caller; allow+audit (a policy `deny`/`ask` on `secret.get` refuses — reads never hang); audited `secret.get` (key + found, never value) |
| `secret_list` | `GET /api/agent/secret/list` | `TerminalManager.listSecrets` | R | shared (`*`) secret KEYS + metadata only, never values |
| `secret_request` | `POST /api/agent/secret/request` | `TerminalManager.requestSecret` + messages | W | an agent **asks a human about a credential KEY** — carrying only the KEY + reason, never a value, so nothing sensitive hits the transcript. **Auto-detects `mode`:** `provide` (key not in vault → human types the value; the inverse of `secret_put`) or `access` (key EXISTS but scoped away → human grants; the server re-scopes the existing sealed value to the agent, no re-type). Short-circuits `exists` if the agent can already `getSync` the key, `duplicate` on an open request for the same key+agent (dedup via `json_extract`), else posts a `secret.request` card to owner/admins; audited `secret.requested` (+`mode`). Human resolves via `POST /api/secrets/requests/:id/fulfill` (owner/admin): **provide** seals a typed value under the agent's principal (default; or `*`); **access** copies the existing value to the agent's principal (`grantRead`, default on) — agent-scoped, not widened. Both can `setAssignedAgents` to inject into the agent's shell at launch; VALUE never audited (only key/principal/mode/injected). Dismiss via `…/dismiss`. Delivery: `secret_get` immediately, or the injected shell env var next session |
| `github_refresh` | `POST /api/agent/github/refresh` | `GithubIdentity.forceRefresh` | W | recover a live run whose injected `GH_TOKEN` (the run-as member's ~8h user token) went bad mid-flight. FORCES a refresh now (unlike the launch-time `ensureFresh`, which only fires within the expiry skew) via the stored `ghr_` refresh token, and RETURNS the fresh token so the agent can `export GH_TOKEN=…` (env can't be mutated from outside the process; the git credential helper + `gh` read `$GH_TOKEN` at call time). The token is the run's OWN identity, already injected at launch — no new exposure. Run-as-scoped: resolves the member from the session (`no_member` for company/bot runs). Typed non-ok statuses tell the agent to STOP retrying and have the human re-link GitHub: `not_connected`/`no_refresh_token`/`not_configured`/`failed`. Audited `github.token.refreshed` / `github.token.refresh_failed` (`via:'agent'`, never the token) |
| `slack_reply` | `POST /api/agent/slack/reply` | SlackSocket | W | only when `SLACK_REPLY=1` (chat-triggered) |
| `discord_reply` | `POST /api/agent/discord/reply` | DiscordSocket | W | only when `DISCORD_REPLY=1` (chat-triggered) |
| `slack_send` | `POST /api/agent/slack/send` | `SlackSocket.sendToChannel` | W | proactive post to any channel by id/name; auto-joins public channels; audited `slack.send`; only when `SLACK_EGRESS=1` (Slack configured) |
| `slack_dm` | `POST /api/agent/slack/dm` | `SlackSocket.dmMember` | W | proactive DM by Slack user id or email; audited `slack.dm`; only when `SLACK_EGRESS=1` |
| `discord_send` | `POST /api/agent/discord/send` | `DiscordSocket.sendToChannel` | W | proactive post to any channel by id; audited `discord.send`; only when `DISCORD_EGRESS=1` (Discord configured) |
| `discord_dm` | `POST /api/agent/discord/dm` | `DiscordSocket.dmMember` | W | proactive DM by Discord user id; audited `discord.dm`; only when `DISCORD_EGRESS=1` |
| `image_generate` | `POST /api/agent/image/generate` | `TerminalManager.generateImage` → `ImageBackend` + `ArtifactStore.ingest` | W | text→image (Claude can't draw natively). Governed as capability `image.generate` with `amountUsd`=estimate (the money-cap `never` rule applies), then the vendor call (OpenRouter default / Atlas alt, `resolveImageBackend`); each image is `ingest`ed into the Library (`kind:'image'`, folder `generated-images`) + an owner-scoped inbox card; audited `image.generated` with the REAL cost (OpenRouter `usage.cost`) else the estimate. Only when `IMAGE_GEN=1` (a backend key set in Settings → Integrations) |
| `video_generate` | `POST /api/agent/video/generate` | `TerminalManager.generateVideo` → `VideoBackend` + `VideoJobStore` + `ArtifactStore.ingest` | W | text→video (async). Governed as capability `video.generate` with `amountUsd`=per-second×duration estimate (money-cap rule applies), then SUBMITS to the vendor (fal.ai default / Atlas alt, `resolveVideoBackend`) and persists an opaque job handle to `video_jobs`. Renders take minutes: a brief in-call poll catches the fast case, else returns `{status:'rendering', jobId}`; the **Automations-tick poller** (`pollVideoJobs`) finishes it — downloads the mp4, `ingest`s it (`kind:'video'`, folder `generated-videos`) + an owner inbox card, audits `video.generated` (cost = estimate; video is per-second, rarely in-band). Only when `VIDEO_GEN=1` (fal/Atlas key set) |

44 always-on tools + 8 conditional. Read-only tools carry `annotations.readOnlyHint`; `forget`
carries `destructiveHint`. All schemas set `additionalProperties:false`; enum fields (`type`,
`outcome`) and numeric bounds (`importance`, `limit`) are constrained in-schema.

### Media tool resilience — timeouts + retries (`image_generate` / `image_edit` / `video_generate`)

Both media backends share `src/edge/vendor-fetch.ts` (`timedFetch` + `withRetry` + `VendorError`) and
treat every vendor call as fallible:

- **Timeouts (`AbortSignal.timeout`).** No call can hang a tool: **30s** on submit, **15s** per prediction
  poll, **60s** on the media download. A hung socket aborts and becomes a retryable error.
- **Bounded retry with backoff + jitter (3 attempts).** The submit and the download are retried on
  **transient** failures only — a network error/timeout, a **429**, or a **5xx**. Backoff is exponential
  with full jitter (~0.2s → ~4s cap).
- **Poll blips are tolerated, not fatal.** For images, a transient poll error keeps polling until the 90s
  render deadline. For **video** (polled across Automations ticks), a transient poll error returns
  `rendering` so the job survives and the **next tick re-polls** (bounded by `VIDEO_MAX_POLLS` / TTL),
  instead of the old behavior where one blip marked the whole render `failed`.
- **What is NOT retried (a real answer, surfaced as-is).** Any **4xx** (bad request / content-policy
  rejection), an explicit vendor **`failed`/`error`/`cancelled`** prediction status, or a **rejected model
  id**. Retryability is decided in one place — `VendorError.retryable` — and the image model-fallback path
  (`withModelFallback`) keys off the same error, so a bad default model still falls back to the built-in
  rather than being retried blindly.
- **Actionable image timeout.** When the 90s image render deadline is hit, the error says how long it
  waited and that the prediction (by id) *may still be in flight* — "check the Library before
  regenerating" — not a bare "timed out".
- **Error attribution.** A failure carries the **vendor** and a **retryable** flag out through
  `TerminalManager.generateImage`/`editImage`/`generateVideo` to the tool response, which prefixes the
  **actual tool** name (`image_generate error: …` / `video_generate error: …`, not `memory error: …`) and
  appends whether a plain retry is worthwhile. So the agent retries the transient ones and fixes the input
  on the terminal ones instead of guessing.

### `notify` — deliberately looping in one teammate (inbox scoping)

Every session's inbox cards — an agent's `update`/`report`, its `ask` question, a `notification`
("Claude is waiting"), a published `artifact`, and the approval card the gate raises — are **addressed
to the session's owner** (its `run_as`, else the member who spawned it) via the `sessionOwner`
audience, not left un-addressed. This is what stops an owner/admin from being flooded by *every*
member's and admin's session activity: the default Inbox (`GET /api/messages`, scope `mine`) shows a
viewer only the cards addressed to them, so a session is "allocated" to one human. Owner/admin can flip
to `scope=all` for the oversight view (every session's cards); a plain member always sees only their
own. Approval cards/DMs route through `approvalAudience` (`src/governance/recipients.ts`): the session
owner alone when they hold approval authority for the level (an admin self-approving their own run),
else they escalate to the full approver tier — so admins stop DMing each other about self-approvable
sessions.

`notify` is the **escape hatch**: when a run genuinely needs someone *other* than its owner to know,
the agent calls `notify({ to, message, important? })` with a teammate's name or email. It writes an
inbox card addressed to that one member (`member` audience → lands in their `mine` feed) and DMs them
on their linked Slack/Discord (`TerminalManager.setMemberNotifier` → `notifyMember` in the registry).
It is **one named recipient only** — there is deliberately no team-wide broadcast — and it's
allow+audit (`member.notified`), no policy gate, same posture as `slack_send`.

### `secret_request` — ask a human about a credential KEY (no paste)

When an agent needs a credential, it `secret_request`s the KEY (with a reason) rather than asking a
human to paste the value into chat — where it would land in the transcript. The request never carries
a value, so nothing sensitive touches the transcript, audit, or the card. It **auto-detects two modes**
so the agent doesn't have to know which case it's in, and posts a `secret.request` card to owner/admins
(Inbox + a **Secrets → Agent requests** review section):

- **provide** — the vault doesn't have the key (the inverse of `secret_put`). The human types the value
  into a password field; it is sealed under the requesting agent's principal (default — only that agent
  can `secret_get` it) or tenant-wide `*`.
- **access** — the key already **exists** in the vault but under a principal this agent can't read
  (another agent, or a person). The human **grants** access: the server reads the existing sealed value
  inside the process and writes a copy under the requesting agent's principal (`grantRead`, default on)
  — the value is never re-typed or shown, and the grant is **agent-scoped**, not widened to everyone.

Either mode can also inject the value into the agent's shell at launch (reusing `secret_assignments`).
It short-circuits `exists` if the agent can already resolve the key, and `duplicate` on an open request
for the same key. Delivery: `secret_get` once resolved, or the shell env var on its next session if
injected. (Caveat, same as the rest of the vault's per-principal model: an access grant copies the
value, so a later rotation of the source secret does not propagate to the granted copy.)

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

Complementary admin path (not an agent tool): from **Settings → Secrets** an owner/admin can *assign* a
stored secret to specific agents (`PUT /api/secrets/agents`, `secret_assignments` table), and the OS
injects it as a shell env var into each assigned agent's session at launch — the central-grant inverse of
a manifest's `shellSecrets`, so a plain CLI (`gh`, `psql`) authenticates. Injection only: an assignment
does **not** widen `secret_get` read access.

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

### `agent_create` / `agent_update` / `agent_history` / `agent_revert` — governance model

`agent_create` is the **agent-author's** build tool (the default *System* agent provisioned by
`src/edge/agent-author.ts`), though — like the Tasks tools — it's the general **delegation surface**
available to any agent. Creating an agent **definition escalates nothing**: the new agent still passes
every side effect through the gate, and only a **human** can run or assign it (spawn is role-gated). So
it follows the same **auto-apply + audited** posture as `kb_write` / `task_create` — no approval card —
emitting `agent.created` with `principal: agent:<id>`. Guard: strict id validation + collision check.

`agent_update` / `agent_history` / `agent_revert` are the **self-improvement** loop — an agent refining
its OWN listing (description, starter prompts, category, icon, tuning) and CLAUDE.md system prompt when it
notices a recurring gap. They are **self-only**: the target is always the calling session's agent (a body
`id` must equal it), so **no agent can rewrite another agent's prompt or tuning** — that cross-agent side
effect would skip the gate. A human edits any agent from the console. Safety here is not an approval card
but **reversibility** (like the KB): every edit — by the agent or a human console edit — snapshots a full
revision into `agent_revisions` (`src/state/agent-revisions.ts`), so any change is auditable
(`agent.config.updated` / `agent.config.reverted`) and one-click / one-tool revertable; the console
**agent page → Revision history** panel is the human rollback. `agent_update` only touches agents under the
data home (bundled examples can't be edited) and rewrites only the fields the caller supplied. A future
tightening could classify CLAUDE.md/model self-edits through Policy for workspaces that want sign-off.

## Remaining gaps (not yet exposed)

- **Delegation / sub-agents.** Largely closed by the **Tasks** plane: an agent files a task assigned to
  `agent:<id>` and either lets the scheduler tick spawn a governed session (with `autoDispatch`) or kicks
  it immediately with **`task_dispatch`** — async, durable, human-passthrough run-as (the task `owner`),
  guarded (no pile-up) + attempt-ceilinged. What's still missing is **synchronous** delegation (an agent
  blocking on another's result) and per-run budget attribution + recursion-depth limiting on the
  agent-triggered spawn path (`docs/tasks-plan.md` §9).
- **Episodic self-query.** Memory is semantic-only; an agent can't query its own past runs
  (`/api/runs` exists but is member-gated). "Have I done this before, how did it go?"
- **`ask` rigidity.** Timeout hardcoded ~1h; no `timeoutSeconds` and no non-blocking ask-then-collect
  (partially mitigated now by `check_inbox`). The question now DMs the run-as human + mirrors to the chat
  thread on ask, but there's still **no server-side timeout/escalation**: if the agent's poll gives up, the
  `questions` row stays `pending` forever and a late answer reaches a run that already moved on. No reminder
  on stale approvals/questions either — tracked as a follow-up (inbox batch 2).
- **Cross-agent artifact/KB read of file contents.** `library_list` returns metadata only and is
  scoped to the agent's own outputs; reading a sibling agent's published file back has no tool.
- **No generic "perform capability" tool** — by design. Effects flow through real tools + the
  PreToolUse gate hook; `policy_check`/`list_capabilities` are preview-only.
