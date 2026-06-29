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
| **Discord** | run-as member (transport TBD — gateway preferred) | post / DM via bot (service) or member (personal) | ⬜ net-new |
| **Email** | — | send-as-member via Composio Gmail (UC5) | egress 🟡 (works for console spawns; needs policy rules); ingress OUT |

## Milestones — status vs. this repo

Verified against source 2026-06-29. Legend: ✅ done · 🟡 partial · ⬜ not started.

### M0 — Foundation (pillars 1–5) — ✅ Done
Agents & sessions, inbox, team/roles/login, connectors, policy engine + console editor, and
cron + webhook automations are all working end-to-end. No v1 work remains here.

### M1 — Identity groundwork — 🟡 Partial *(unblocks Discord + UC5; hardens Slack run-as)*
- **P1** `member_identities` table (provider ∈ slack|discord|email|github…) + `TeamStore.memberByExternalId`
  / `externalIdsFor` + admin map UI — ⬜ **absent**. Slack run-as currently works via Slack-email →
  `getMemberByEmail`; P1 is required once Discord lands and for non-email mapping.
- **P2** generalized `runAs` seam through `createSession`; select connectors / Composio identity by
  `runAs ?? memberOf(spawnedBy)`; audit both provenance + run-as principal — 🟡 **partial** (a narrow
  `runAs` exists in `src/edge/automations.ts` / `slack-socket.ts`, keyed off Slack email; not yet the
  general `createSession` seam).
- **P3** `connectors.shared` flag + generalize `boundTo`; per-connector Composio `user_id`
  (private/shared personal → owner email; service → `service:<tenant>`) — ⬜ **absent**.
- **P4** `directory_lookup` OS tool + loopback `GET /api/agent/directory?q=` — ⬜ **absent**.

### M2 — Slack channel — ✅ Done (Socket Mode)
Ingress + egress ship via `src/edge/slack-socket.ts`: one company Slack app (app-level `xapp-…` + bot
`xoxb-…` tokens in Settings → Integrations) opens an outbound WebSocket; on @mention/DM it fires
`slack` automations **as the member who sent the message** (Slack email → `getMemberByEmail`),
posts an in-thread ack, and the agent replies via its Slack egress tools.
- *Remaining:* back run-as with **M1/P1** for members whose Slack email doesn't resolve; confirm
  `canRun` gating on the run-as principal. (Decision D4 below is satisfied — Socket Mode chosen.)

### M3 — Discord channel — ⬜ Not started
Entirely net-new; rides **M1**'s identity plumbing (provider `discord`). Transport per decision
**D-Discord**: prefer a Socket-Mode-style gateway; HTTP Interactions endpoint (Ed25519 verify,
PING→PONG, 3-sec deferred ACK, follow-up via `PATCH …/@original`) is the documented fallback.
Egress: Discord connector (service = company bot; personal via Composio). Reply path shares the
Slack `reply_to` machinery with a `channel: 'slack'|'discord'` discriminator.

### M4 — Act-as-member email (UC5) — 🟡 Partial *(mostly falls out of M1)*
Personal Gmail via Composio (`user_id` = member email) already works for console spawns.
- *Remaining:* `email.send` policy rules (internal recipient green, external yellow/red); fail-closed
  when the run-as member hasn't connected Gmail; confirm e2e for a triggered (non-console) run.

### M5 — Audit viewer + chat approval notifications — ⬜ Not started
The audit **pipeline** is done (JSONL system-of-record + SQLite mirror; pillar 6 = pipeline ✅ /
surface 🟡); the **surface** is missing.
- `GET /api/audit` (filter by session / member / type) + an **Audit page** in the console.
- **Chat approval notifications**: when an action-required card lands, DM the approver via the service
  Slack (and later Discord) connector — reuses the Slack egress already here.

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
| M1 Identity map (P1/P2/P3/P4) | frozen plan | 🟡 P2 partial; P1/P3/P4 missing | build P1, P3, P4; generalize P2 |
| M2 Slack (Socket Mode) | this repo | ✅ done | back run-as with P1 |
| M3 Discord | frozen plan | ⬜ not started | full build on M1 |
| M4 Act-as-member email (UC5) | frozen plan | 🟡 partial | `email.send` rules + fail-closed |
| M5 Audit viewer + chat notify | frozen plan | ⬜ not started | API + page + DM-on-approval |
| M6 Phase A deploy | frozen plan | 🟡 code-complete | ops + 2-member e2e |
| Memory / KB / Dreaming / Multi-tenant | this repo | ✅ done | (was "OUT" in the frozen plan) |

## Build order

1. **M1** (identity groundwork — P1/P3/P4 + generalize P2) — foundation Discord + UC5 ride on.
2. **M4** (act-as-member email) — nearly free once M1 lands; add `email.send` policy rules.
3. **M5** (audit viewer + chat notifications) — reuses the Slack egress already here.
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
