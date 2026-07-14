# Plan: SDK-driven chat runtime (native chat v2)

**Status:** proposed — not started. This is the "do it right" successor to the hardened v1 chat
surface (`src/edge/conversation.ts` + the Chat page + `TerminalManager.chatSend`). Greenlight before
building.

## Why

The v1 Chat page drives Claude the only way agent-os currently can: it spawns a real `claude` CLI in a
detached **tmux** pane, seeds each turn as a resume prompt, and **reads the internal transcript JSONL**
for display. That works, but it inherits three structural limits:

1. **Fragile driver.** Keeping a live TUI pane warm and injecting turns is racy (the 2026-07-14 stuck
   "thinking…" bug). v1 hardens this by making every turn a self-terminating headless resume — reliable,
   but it **cold-starts Claude per turn** (no warm latency) and can never token-stream.
2. **No streaming.** Display is message-level polling (2 s). Non-technical users read a chat app; live
   typing would feel materially better.
3. **Volatile display source.** The transcript JSONL under `~/.claude/projects/**` is undocumented and
   Anthropic-internal — it can change shape without notice, and it has **no approval hook** (a tool is
   already executed by the time it lands in the transcript; agent-os only governs it because the
   *separate* PreToolUse gate hook fired first).

The **Claude Agent SDK** (TS/Python, officially supported) removes all three: a typed, documented event
stream with token deltas (`includePartialMessages`) and a first-class programmatic approval callback
(`canUseTool`). See `docs/agent-mcp-tools.md` and the research notes in the v1 PR.

## Principle preserved

The one invariant does not move: **every side effect still passes one mediated gateway.** Today that
choke point is the gate-hook script → `/api/gate` → the 7-step gateway. In v2 it becomes the SDK's
`canUseTool(tool, input)` callback → the **same** `gateway.ts` (Policy → Approvals → Budget → Identity →
Idempotency → Audit) → allow/deny. Mechanism changes from a shell hook to an in-process callback; the
trust boundary is identical.

## Architecture — a second runtime, beside the CLI one (not a replacement)

The CLI+tmux runtime stays: it's what gives **attachable terminals** (ttyd take-over, the shared proxy,
the real TUI for engineers). The SDK runtime is **additive**, selected only for the chat surface:

```
Chat page ──SSE── /api/chat/stream ──▶ SdkChatRuntime (new)
                                        │  @anthropic-ai/claude-agent-sdk `query()`
                                        │  includePartialMessages → stream deltas out as SSE
                                        │  canUseTool ─────────────▶ gateway.ts (unchanged core)
                                        │  mcpServers/env ◀──────── reuse per-session injection
                                        └─ typed messages → the fuller renderer (Phase 2 of v1)
```

- **Sessions:** an `SdkChatRuntime` holds one SDK `query()` conversation per chat session (resumable via
  the SDK's session id), replacing the tmux pane + resume-per-turn. No pane lifecycle, no reaper.
- **Streaming out:** a new `GET /api/chat/:id/stream` SSE endpoint forwards `stream_event` deltas
  (`content_block_delta` text/tool-input) so the browser renders live typing and tool cards as they form.
- **Governance in:** `canUseTool` awaits the gateway. A `pending` (needs a human) suspends the promise
  and posts the **same** approval card the console already renders inline — no second approval system.
- **Identity / secrets / MCP:** reuse the existing per-session wiring (`injectShellSecrets`,
  `injectMemberGithub`, `buildMcpConfigJson`) but feed it to the SDK via `options.env` + `options.mcpServers`
  instead of the launcher env. This is the bulk of the porting work.
- **Rendering:** the SDK's typed message stream feeds the completeness pass (thinking, diffs, todos,
  sub-agents, images) — the renderer becomes provider-stable instead of scraping JSONL.

## Risks / open questions (resolve during a spike)

1. **`canUseTool` parity with the gate hook** — confirm it fires for *every* governed surface (Bash,
   file writes, each MCP tool) and can enforce the crown-jewel **deny** rules. This is the gating risk;
   if a tool class bypasses `canUseTool`, governance regresses. Spike this first.
2. **Subprocess vs in-process** — the SDK can run the agent loop in-process (Node) or spawn the CLI.
   In-process is cleanest for streaming but changes the failure/isolation model; the Linux uid-isolation
   path (`AOS_UID_ISOLATION`) assumes a spawned process. Decide per deployment.
3. **Two runtimes to maintain** — chat on the SDK, terminals on the CLI. Acceptable (different surfaces,
   different needs) but a real cost.
4. **No ttyd attach for SDK sessions** — a native chat doesn't need it, but "open in terminal" wouldn't
   apply to an SDK session. Keep the two surfaces distinct.

## Rollout

1. **Spike (1–2 d):** one agent, `query()` + `includePartialMessages` + `canUseTool` → log-only gateway
   call. Prove tool-call coverage/parity and streaming end-to-end. Kill-criteria: any governed tool that
   `canUseTool` can't see.
2. **Wire governance:** `canUseTool` → real `gateway.ts`; approvals suspend/resume via the existing store.
3. **Port per-session injection** (secrets/GitHub/MCP) to SDK options.
4. **SSE + renderer:** stream deltas to the Chat page; land the completeness renderer.
5. **Flag + coexist:** `AOS_SDK_CHAT` selects the SDK runtime for the chat surface only; CLI/tmux stays
   the default everywhere else. Graduate once parity is proven.

## Relationship to v1

v1 (hardened, transcript-driven) stays shippable and is the fallback. v2 swaps the **driver** and
**display source** under the same Chat page and the same gateway; the page, the approval cards, and the
session model are largely reused.

## Reference implementation — siteboon/claudecodeui (now "CloudCLI")

The closest open prior art, and worth reading before building (AGPL-3.0 — **study the pattern, don't
fork/embed the code**; the network-copyleft clause would reach our hosted multi-tenant service). It
rebranded to CloudCLI and **rewrote itself onto the Agent SDK** (`query()` + `canUseTool`) — independent
validation of this plan. Concrete lessons to carry over:

- **The bridge shape (server):** one `canUseTool(toolName, input, ctx)` choke point that short-circuits
  against allow/deny lists, else mints a `requestId`, pushes a `permission_request` frame to the browser,
  and `await`s a `pendingApprovals` promise resolved by the browser's response — returning SDK-native
  `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`. This is exactly our
  gateway→approval suspend/resume, expressed as an SDK callback. (`server/claude-sdk.js`.)
- **Interactive tools resolved through the SAME callback:** `AskUserQuestion` / `ExitPlanMode` are kept in
  a `TOOLS_REQUIRING_INTERACTION` set and answered by returning an **edited `updatedInput`** (the chosen
  answers) with an **indefinite (no-timeout) wait**, rendered as clickable option buttons. So the native
  multiple-choice picker becomes a web multiple-choice instead of a hang.
- **The caveat that matters most for us:** in `auto`/`bypassPermissions` permission modes the SDK
  **skips `canUseTool` entirely** — interactive tools must instead be caught by a **PreToolUse hook**
  (which runs before the mode check). **Agent OS already has that gate hook**, so we are actually better
  positioned than a pure-SDK app: our existing PreToolUse choke point can bridge interactive tools even
  under skip-permissions.
- **Reconnect resilience:** replay pending permission requests (by sequence number) on WS reconnect so an
  in-flight approval survives a page refresh — adopt for the SSE/WS layer.

### Stepping stone already shipped (v1.5)

Rather than intercept Claude's native `AskUserQuestion` (denied fleet-wide — it hangs unattended runs;
see CHANGELOG v0.195.1), Agent OS's own **`ask_human` now takes an optional `options[]`** that renders as
one-click buttons in the Inbox and Chat (the human's reply is the option they pick). This delivers the
multiple-choice UX through a governed tool with a real result — no native-tool interception, no hook
hackery — and is the pattern the SDK runtime will generalize via `canUseTool`/`updatedInput`.
