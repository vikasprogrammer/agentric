# TODO — Agentric plan execution

Working checklist for the plan in [`docs/agent-os-plan.md`](docs/agent-os-plan.md). The wedge is the
**mediation plane behind existing MCP gateways** — own the enforced primitive (suspend-for-a-human +
budget + tamper-evident record), don't build a competing gateway. Keep this file current as work ships.

_Last updated: 2026-08-04._

## Shipped

- [x] **Second coding runtime (Codex)** — `runtime: "codex"` runs a real, governed Codex TUI at parity
      with Claude Code (attachable + resident via pre-seeded hook trust, one shared gate hook, sandbox
      write containment, transcript/cost reader, runtime picker) · v0.272.0–v0.284.1 · PR #478–#510
- [x] **Canonical plan doc** — `docs/agent-os-plan.md` (thesis + landscape + roadmap) · PR #493, #506
- [x] **§4.3 Policy v2 — Tier A** — set-membership (`in`/`nin`) + cross-arg (`argRef`) conditions in the
      pure rule engine; monotonicity proof kept sound · v0.284.0 · PR #498
- [x] **§4.2 Capability Registry** — normalize connector tool names → canonical capabilities
      (`STRIPE_REFUND → payments.refund`) so one policy rule governs an action across surfaces ·
      v0.286.0 · PR #514
- [x] **Gateway spike** — verdict: no native indefinite hold; suspend = deny-with-"pending" → retry;
      ContextForge is the first adapter target (folded into §4.1)

## Next (open fork — pick one)

- [ ] **§4.3 Policy v2 — Tier B (stateful/relational guard)** — the "was this order already refunded?"
      / wrong-entity-type checks. Engine-level (NOT JSON — a persisted policy override would never see a
      new JSON rule), folded via `stricterDecision` like the Tier-1 injection guard. Needs a
      `FactProvider`: `hasSettled(op, key)` over the audit index + `entityType(kind, id)` over the
      KB/directory. **Unblocked now** that §4.2 gives it canonical capabilities to key on.
- [ ] **ContextForge adapter (hands-on)** — stand up IBM ContextForge, wire `tool_pre_invoke` → our
      decision, prove the **deny-with-"pending" → idempotency-keyed retry** loop end-to-end against an
      unmodified gateway. Settle the two open unknowns: agentgateway backend-timeout override on the
      guardrails channel, and the agent's own **client-side MCP request timeout** (the true outer bound
      on any synchronous hold).

## Backlog (from the plan, not yet started)

- [ ] **§4.1 Mediation Plane** — build `src/mediation/*`: the `EffectIntent → Decision` hook (with a
      first-class **`pending`** outcome: allow / ask / deny / pending) + the ContextForge adapter, then
      agentgateway (`ExtMcp` gRPC) second. Tool-drift / poisoning quarantine.
- [ ] **§4.2 grow coverage** — add provider mappings to `src/capabilities/normalize.ts` as the plane
      sees more tools; a console catalog view off `knownCapabilities()`.
- [ ] **§4.4 Flight Recorder** — hash-chained (tamper-evident) audit events; per-run immutable record;
      explain-every-decision on `allow`, not just `deny`. Emit OTel GenAI conventions (~70% exists).
- [ ] **Identity & delegation** — make sub-agent authority = intersection over the FULL delegation
      chain (delegation only reduces authority; kills privilege laundering).
- [ ] **Governance Coverage %** — surface the honest gap (which effects are/aren't governed) per tenant.

## Deferred (correct, but not now — per plan §7)

- [ ] Model gateway / shadow eval / cost-per-task routing / owned inference
- [ ] Trust scores, anomaly detection, change-correlation (need fleet data first)
- [ ] Signed authorization tokens (only once the executor splits from the control plane)

## Working notes

- **Sequencing:** Tier B is gated behind §4.2 (done). §4.1 build is gated behind the ContextForge
  adapter spike proving the suspend protocol.
- **Don't lead with "control plane"** — the phrase is a red ocean; lead with the enforced primitive.
- **Ship discipline:** branch → PR → squash-merge (`--repo vikasprogrammer/agentric`); CI = `npm run
  test:governance`. Concurrent-shipping churn is heavy — **commit, then rebase right before merge.**

---

# Console performance — sessions list (separate workstream)

Full arc + measurements in memory `console-list-payload-perf`; pagination design in
[`docs/sessions-pagination-plan.md`](docs/sessions-pagination-plan.md).

## Shipped (console-perf arc, all deployed to northwind · personal · globex)

- [x] List-payload clip (#525) · gzip + ETag + 304 (#530) · client render-skip on 304 (#532) ·
      per-row query cache (#533) · in-query task clip (#535)
- [x] **Sessions-pagination Phase 1** (#539, v0.294.0) — `GET /api/sessions/:id` + `?ids=`; Tasks board
      dropped its 2nd full-list poll.
- [x] **Sessions-pagination Phase 2** (#542, v0.296.0) — `GET /api/sessions/summary`; the 1.5 s poll
      switches source by route (full list only on the Sessions/Chat views, cheap summary everywhere
      else). Live globex: poll payload **265 KB → 19.5 KB gzipped, 950 → 83 rows** off the list routes.

## Next — Phase 3 (DECIDED: virtualize now, paginate later)

Decision (2026-08-03): the Sessions LIST view is the last place that still loads the full ~950 rows
(only when that view is open; the fetch is already gzipped-small post-Phase-2). The pain at scale is the
**render** (all rows to the DOM), not the fetch. So:

- [ ] **3a — Client row virtualization (do this first; low risk).** Render only the rows in the viewport
      in `SessionsPage` (`web/src/App.tsx`, the `shown` list ~L3306 + the grid/list render ~L3459+),
      keeping ALL existing client-side filter/sort/search/facets/multi-select **unchanged**. Zero API
      change. Fixes the 950-DOM-row jank. ~small, self-contained. Watch: the terminal **tab strip**
      (liveTabs/endedTabs ~L3417) is a separate small render — leave it; virtualize only the main list.
      Preserve keyboard/scroll-restore and the "N of M sessions" count (M = full filtered length, still
      known client-side).
- [ ] **3b — Server-side pagination (DEFERRED until the corpus grows into the low thousands).** Only
      warranted once the full-list FETCH itself is the bottleneck (not yet — ~950 rows, ~20–265 KB
      gzipped). It's a large, higher-risk rewrite: move filter/sort/search **server-side**, cursor
      pagination on `(created_at, id)`, server-computed facet lists, infinite scroll, and a bulk
      **select-all-across-pages** semantic (product call — "all N matching" vs "visible page"). At that
      point the poll can drop the route-switch and ALWAYS fetch the summary (SessionsPage/ChatPage
      self-fetch their own paged data). Search backend: LIKE first (no `term_sessions_fts` today).
      **Trigger to pick this up:** a tenant's non-archived session count clears ~3–5k, or the list-view
      fetch/parse becomes a measured drag.

Parallel cleanup candidate (not blocking): `FullTerminalView` (`#/term/<tmux>`, `web/src/App.tsx`
~L5526) still pulls all ~950 rows to resolve one tmux — swap for the Phase-1 by-id fetch.


# Telegram chat channel (separate workstream)

Native Telegram bot as the **third chat ingress** after Slack/Discord — part of the fleet-reachability
story in [`docs/agent-os-plan.md`](docs/agent-os-plan.md) (an agent is reachable from every channel a
human already lives in, all through the same gate + run-as). Long-poll (`getUpdates`), no public URL, one
@BotFather token. Mirrors the Discord path; see CLAUDE.md → `src/edge/telegram-socket.ts` /
`src/connectors/telegram.ts`.

## Shipped (all deployed to northwind · personal)

- [x] **Ingress + `telegram_reply` MVP** — long-poll socket, run-as via identity map (provider
      `telegram`), chat-id thread continuity, bound-chat reply tool, Settings→Integrations panel ·
      v0.300.0 · PR #552
- [x] **`/command` menu + DM threading** — agents as slash-commands (`setMyCommands`; hyphenated id →
      `_` for the menu, reversed on tap) + a private-chat follow-up continues the last run · v0.301.0 · PR #553
- [x] **`/new`** — end a conversation / start fresh (stop + unbind) · v0.304.0 · PR #556
- [x] **Helper commands** — `/help` · `/agents` · `/whoami` · v0.305.0 · PR #557

## Deferred (Telegram parity with Slack/Discord — the MVP boundary)

- [ ] **Proactive egress** — `telegram_send` / `telegram_dm` MCP tools (an agent messages a chat/person
      unprompted, e.g. a cron posting a daily summary). Gate on a `TELEGRAM_EGRESS` env flag; mirror
      `slack_send`/`slack_dm` (connector `sendToChannel`/`dmUser` + `/api/agent/telegram/{send,dm}` +
      the memory-mcp tools).
- [ ] **Approval + question DMs over Telegram** — the notifier fan-out: thread `telegram` through
      `deliverDM` + the `notify*` functions in `tenant-registry.ts`, and the `bindQuestionDm` /
      `bindApprovalDm` / `bindSessionDm` writers, so a gated action or an `ask_human` can be resolved
      right from the chat. The DM-binding provider unions are **already widened** for `telegram`, so this
      is a small addition. ⚠ **Identity-map trust only** — never resolve `canApprove` from a spoofable
      Telegram id (same hard constraint as [[voice-channel-plan]]): questions yes, approvals only for a
      mapped member whose role clears the level.
- [ ] **End-of-day digest → Telegram** — `digest.ts` platform union (`'slack'|'discord'` → add
      `'telegram'`) + a Telegram digest-channel setting.
- [ ] **Live command-menu refresh** — `setMyCommands` currently re-syncs only on (re)connect; refresh it
      when the agent roster changes (agent create/update/delete) so new agents appear without a bounce.

## Notes

- Live bot: **personal** tenant `@VikAgentricBot`; owner Telegram id `7024650475` → `owner@example.com`.
  **northwind** has the code but no token (socket `start()` no-ops until one is set).
- Group thread continuity needs **Group Privacy OFF** in @BotFather (mentions/commands work either way).
