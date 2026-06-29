# Agent OS — v1 (MVP) scope — re-planned for `main`

The authoritative IN/OUT + milestone tracker for the first internal release (Globex's own team
dogfooding). This is a **re-plan**: it merges the frozen chat-channels v1 scope (developed on a
separate branch) with what *this* repo (`main`) has actually shipped — memory, knowledge base,
self-learning, multi-tenancy, and native Slack via Socket Mode. Graded against the code on
2026-06-29. `docs/PILLARS.md` tracks per-pillar maturity; `docs/connectors-and-triggers.md` and
`docs/phase-a-scope.md` carry the detailed build notes.

> **Why a re-plan.** The original frozen v1 lived on the `agent-os-1-chat-channels` branch and built
> chat channels via HTTP **trigger adapters** (`POST /triggers/slack` HMAC, `/triggers/discord`
> Ed25519) plus an identity map. This `main` tree diverged: it solved Slack ingress a different (and
> better) way — **Socket Mode** — and independently shipped Memory / KB / Dreaming / multi-tenancy,
> which the frozen plan had listed as *deferred*. This document re-bases the milestones on `main`'s
> real state: features already here move to "done"; the identity map, Discord, and audit viewer that
> the other branch finished are "not started" here.

## Decisions locked (2026-06-29, with Vikas)

1. **Per-member OS isolation is IN.** Ship with `AOS_UID_ISOLATION=1` — each member's sessions run as
   their own Unix uid. The Phase A code is complete in this tree; what remains is **deploy + a real e2e**.
2. **Front door = console + cron/webhook + Slack + Discord.** Members reach the fleet from chat, not
   just the console. Email ingress and conversational DM/gateway threads are OUT of v1.
3. **Agents can act as an individual member** (their Gmail / their Slack / their Discord), not only as
   the company. Personal-connector identity already works for console spawns; v1 adds the generalized
   `runAs` override + `shared` flag + identity map so *triggered* runs act as the right person.
4. **Slack stays on Socket Mode** (`src/edge/slack-socket.ts`) — NOT the other branch's HTTP
   `/triggers/slack` adapter. Socket Mode opens an outbound WebSocket to Slack, so it needs **no public
   URL** and works on a Tailscale-private / on-prem box. This is the chosen transport for v1.
5. **Discord follows the Slack pattern.** Prefer a Socket-Mode-style gateway for consistency and the
   "no public URL" property; the branch's HTTP Interactions-endpoint + Ed25519 design is the documented
   fallback if a gateway path proves impractical. (Decision **D-Discord** below.)

## In v1 / Out of v1

| In v1 | Out of v1 (deferred) |
|---|---|
| Agents, sessions, inbox, team/roles/login, policy engine+editor (pillars 1–5) — ✅ shipped | Email **ingress** (Mailgun) |
| Phase A uid isolation **deployed** (`AOS_UID_ISOLATION=1`) | Conversational DM / gateway chat threads (multi-turn) |
| Connectors with **service + personal + shared** identity | Per-agent connector/skill grant matrices |
| **Slack** ingress (Socket Mode, run-as member) + egress — ✅ shipped | Agent-built Tools/Apps (pillar 13) |
| **Discord** ingress + egress | Secrets vault (connector creds stay plaintext in DB — documented debt) |
| **Act-as-member** email — agent acts under the individual's accounts (UC5) | Foreign CLIs (Codex/Gemini runtimes) |
| Cron + webhook automations — ✅ shipped | Email invite delivery, SSO |
| Audit viewer + chat approval notifications | |
| **Already shipped here** (was deferred in the frozen plan): Memory layer (9), Knowledge Base (15), Dreaming / self-learning (10), Multi-tenancy | |

## Channel matrix (v1)

| Channel | Ingress (→ agent) | Egress (agent →) | v1 status |
|---|---|---|---|
| **Console** | spawn / automations UI | n/a | ✅ today |
| **Cron** | scheduled fire | n/a | ✅ today |
| **Webhook** | `POST /hooks/<id>?key=` | n/a | ✅ today |
| **Slack** | **Socket Mode** @mention/DM, run-as member | post / DM via bot (service) or member (personal) | ✅ shipped (`src/edge/slack-socket.ts`) |
| **Discord** | **Gateway** @mention/DM, run-as member (identity map) | post / reply via bot (service) | 🟡 code-complete (`src/edge/discord-socket.ts`) |
| **Email** | — | send-as-member via Composio Gmail (UC5) | egress 🟡 (works for console spawns; needs policy rules); ingress OUT |

## Milestones — status vs. this repo

Verified against source 2026-06-29. Legend: ✅ done · 🟡 partial · ⬜ not started.

### M0 — Foundation (pillars 1–5) — ✅ Done
Agents & sessions, inbox, team/roles/login, connectors, policy engine + console editor, and
cron + webhook automations are all working end-to-end. No v1 work remains here.

### M1 — Identity groundwork — ✅ Done *(P1–P4 all landed)*
- **P1** `member_identities` table + `TeamStore.memberByExternalId` / `externalIdsFor` /
  `identitiesByMember` / `setIdentity` / `clearIdentity` + admin map UI — ✅ **done** (13/13 smoke
  tests). PK `(provider, external_id)` makes run-as unambiguous; one handle per provider per member;
  cascade-cleanup on member removal. Wired into run-as: **Discord** resolves the sender via
  `memberByExternalId('discord', id)`; **Slack** now prefers the identity map (`slack` handle) and
  falls back to its email match. Console: Team page per-member **Chat IDs** editor
  (slack/discord/email/github). Routes `POST /api/team/:id/identities`,
  `DELETE /api/team/:id/identities/:provider`, grouped into `GET /api/team`.
- **P2** generalized `runAs` seam through `createSession` — ✅ **done** (10/10 smoke tests). `createSession`
  takes an explicit `runAs`; `spawned_by` is now true **provenance** (`automation:<id>` / console member)
  and a new `term_sessions.run_as` column holds the **identity** the session acts under. Identity =
  `runAs ?? memberOf(spawnedBy)` drives connectors/Composio/**isolation uid**, and grants the run-as
  member **inbox + session + artifact visibility** (`canViewRow`) on top of the provenance rule.
  `session.created` audits both; the console label reads "Automation · X · as Alice". Behavior-preserving
  when `runAs` absent (a console spawn's identity is still the spawning member).
- **P3** `connectors.shared` flag + generalized `boundTo` — ✅ **done** (14/14 smoke tests).
  A member can **share their personal connector team-wide** (`setShared`; PATCH `/api/connectors/:id`
  `{shared}`, owner/admin; console **Share with team** toggle + badge): `boundTo` now binds org → all,
  personal+shared → all (acting as the owner via the stored creds, incl. system/automation spawns),
  private personal → owner only. `listForConsole` shows shared to the team; `removeByOwner` still purges
  shared creds on member removal. *(Per-connector Composio `user_id` is N/A here — Composio identity is
  Settings-key-driven, already split personal-vs-`service:<tenant>` in `terminal.ts`, not per connector row.)*
- **P4** `directory_lookup` OS tool + loopback `GET /api/agent/directory?q=` — ✅ **done** (8/8 smoke
  tests). `TeamStore.searchMembers` (name/email substring, LIKE-injection-safe) → session-secret route
  returns each match's email + role + identities (slack/discord/github); MCP `directory_lookup` tool
  (always on, pre-allowed in the launcher) so an agent can resolve *who to reach on which channel*.

### M2 — Slack channel — ✅ Done (Socket Mode)
Ingress + egress ship via `src/edge/slack-socket.ts`: one company Slack app (app-level `xapp-…` + bot
`xoxb-…` tokens in Settings → Integrations) opens an outbound WebSocket; on @mention/DM it fires
`slack` automations **as the member who sent the message** (Slack email → `getMemberByEmail`),
posts an in-thread ack, and the agent replies via its Slack egress tools.
- *Remaining:* back run-as with **M1/P1** for members whose Slack email doesn't resolve; confirm
  `canRun` gating on the run-as principal. (Decision D4 below is satisfied — Socket Mode chosen.)

### M3 — Discord channel — 🟡 Code-complete, untested live
Built as a **one-for-one mirror of the Slack Socket-Mode path** (decision **D-Discord = gateway**, not
the HTTP Interactions fallback). New `src/connectors/discord.ts` (REST + `parseDiscordMessage` + intents)
and `src/edge/discord-socket.ts` (the Gateway state machine: HELLO/heartbeat/IDENTIFY/READY/MESSAGE_CREATE,
reconnect backoff, zombie detection). Wired through every Slack touch point: `settings` (one bot token),
`discord_threads` table, `discord` automation type + `fireDiscord`, `createSession` binding, the
`discord_reply` MCP tool (`DISCORD_REPLY=1`), server routes (`/api/agent/discord/reply`,
`/api/settings/discord/status`, integrations PUT + views), the registry (build/start/stop), and the web
console (Integrations Discord card + `DiscordSetupGuide` + automation type).
- *Verified:* backend `tsc` + web build clean; unit smoke tests pass (intents bitfield, opcodes, message
  routing for DM / guild-mention / non-mention / bot / webhook; settings round-trip; `discord_threads`
  table; socket status).
- *Per-member run-as:* ✅ wired — `resolveMember` resolves the Discord sender via the M1/P1 identity map
  (`memberByExternalId('discord', id)`); map a member's Discord user id on the Team page (Chat IDs) and
  triggered runs act as them. Unmapped senders fall back to the company identity.
- *Remaining:* live e2e against a real Discord app (token + MESSAGE_CONTENT intent + invite).

### M4 — Act-as-member email (UC5) — 🟡 Partial *(mostly falls out of M1)*
Personal Gmail via Composio (`user_id` = member email) already works for console spawns.
- *Remaining:* `email.send` policy rules (internal recipient green, external yellow/red); fail-closed
  when the run-as member hasn't connected Gmail; confirm e2e for a triggered (non-console) run.

### M5 — Audit viewer + chat approval notifications — ✅ Done *(10/10 smoke tests)*
- **Audit viewer** — `GET /api/audit` (owner/admin; filters by session / type-prefix / principal, capped
  at 1000, returns distinct types for the dropdown) reads the `audit_events` SQLite mirror; console
  **Audit** page under Manage (time · type · principal · session · data, with filters).
- **Chat approval notifications** — `TerminalManager.setApprovalNotifier` fires off the gate's hot path
  when an approval card lands; the registry's `notifyApprovers` resolves who can approve
  (`canApprove(role, level)` — `head` → admins+owners, `owner` → owners), looks up each approver's
  **Slack/Discord handle in the identity map (P1)**, and DMs them (`dmUser` → `conversations.open` /
  Discord `POST /users/@me/channels` → post). Best-effort, audited once as `approval.notified`. Unmapped
  approvers are simply skipped (the Inbox card remains the source of truth).

### M6 — Phase A isolation deploy — 🟡 Code-complete, undeployed *(ops + e2e track)*
Code present (`src/edge/launcher.ts`, `session-backend.ts`, `deploy/`); running in single-user local
mode (`LocalSessionBackend`), flag off.
- Install `aos-launcher.service` (root) + socket; install dir group-readable by `aos`; `claude` on member PATH.
- Populate shared creds (decision **D1**).
- Reverse-proxy `/terminal/` to the app (per-member ttyd) — already handled on the Tailscale box.
- Flip `AOS_UID_ISOLATION=1`, run `deploy/BRINGUP.md`.
- Real e2e (2 members): distinct uids, cross-member `EACCES`, slice caps, console kill/delete reaps foreign uid.
- Accept known gap: precise liveness (launcher sessions flip to idle via `/api/ended` + `/api/report`).

## Status at a glance

| Milestone | Source | Status here | Remaining |
|---|---|---|---|
| M0 Foundation (pillars 1–5) | both | ✅ done | — |
| M1 Identity map (P1/P2/P3/P4) | frozen plan | ✅ done (P1–P4) | — |
| M2 Slack (Socket Mode) | this repo | ✅ done | back run-as with P1 |
| M3 Discord | frozen plan | 🟡 code-complete (Socket-Mode mirror) | live e2e; per-member run-as via M1 |
| M4 Act-as-member email (UC5) | frozen plan | 🟡 partial | `email.send` rules + fail-closed |
| M5 Audit viewer + chat notify | frozen plan | ✅ done (10/10 tests) | live e2e of DMs with a real app |
| M6 Phase A deploy | frozen plan | 🟡 code-complete | ops + 2-member e2e |
| Memory / KB / Dreaming / Multi-tenant | this repo | ✅ done | (was "OUT" in the frozen plan) |

## Build order

1. ~~**M1** (identity groundwork — P1/P2/P3/P4)~~ — ✅ **done**; foundation Discord + UC5 ride on.
2. **M4** (act-as-member email) — nearly free now M1 landed; add `email.send` policy rules.
3. ~~**M5** (audit viewer + chat notifications)~~ — ✅ **done**.
4. **M3** (Discord) — on the M1 plumbing; settle transport (D-Discord) first.
5. **M6** (Phase A deploy) — parallel ops track throughout; flip the flag for the final team e2e.

## Open decisions

- **D1 — Phase A shared credential:** company **API key + budget cap** (recommended) vs copied
  subscription login (seat/concurrency risk).
- **D2 — Default `run_as`:** `trigger-user` (map the human, fall back to owner) — recommended;
  implemented this way for Slack.
- **D-Discord — Discord transport:** **Socket-Mode-style gateway** (recommended — matches Slack, no
  public URL) vs the frozen plan's HTTP Interactions endpoint + Ed25519 (fallback).
- **D4 — Slack transport:** ✅ **resolved — Socket Mode.**
- **D5 — Storage label:** keep `org` in storage, relabel **service** in the UI only (no migration).
