# Voice channel — implementation plan

> **The idea (2026-08-01):** humans talk to agents by **voice** — a low-latency voice stack
> (smallest.ai and peers) as a front door to the fleet.
>
> **The shape:** voice is a **modality, not architecture.** It is the *fourth* instance of a chat
> ingress pattern this codebase has already generalized three times (Slack → Discord → ClickUp).
> Most of this plan is filling in a fourth column. **Two things genuinely break the analogy** —
> turn-taking latency (§2.1) and, seriously, **authentication** (§2.2). Get those wrong and voice
> becomes the weakest link in the one mechanism the product exists to protect.

---

## 1. The pattern already exists (three times over)

Every chat channel reduces to the same five seams. Voice is a new row, not a new design:

| Seam | Slack | Discord | ClickUp | **Voice (this plan)** |
|---|---|---|---|---|
| Ingress | `src/edge/slack-socket.ts` (Socket Mode WS) | `src/edge/discord-socket.ts` (Gateway WS) | `src/edge/clickup-ingress.ts` (webhook) | vendor webhook / callback |
| Run-as resolution | identity map `slack` → member (then profile email) | identity map `discord` (no email fallback) | identity map | identity map `voice` → member |
| Reply binding | `slack_threads` (channel + `thread_ts`) | `discord_threads` (channel + `message_id`) | `clickup_threads` (task + comment) | `voice_threads` (call/session id) |
| Agent egress tool | `slack_reply` (`SLACK_REPLY=1`) | `discord_reply` (`DISCORD_REPLY=1`) | `clickup_reply` (`CLICKUP_REPLY=1`) | `voice_reply` (`VOICE_REPLY=1`) |
| Front door | `routeChat` / `spawnChatAgent` — shared | shared | shared | shared, unchanged |

The critical property is already in place and carries over for free: **the binding is written
server-side and read server-side.** Each `*_threads` table's comment says it explicitly — the agent
is never handed, and cannot spoof, a channel id. A voice-triggered session gets the same treatment.

Equally important: a voice-triggered run is **governed identically**. It spawns through
`spawnChatAgent` like any chat run — same PreToolUse gate, same policy, same budget, same audit,
run-as the resolved human. Voice adds a door; it does not add a bypass.

## 2. What actually breaks the analogy

### 2.1 — Latency: voice is synchronous, every existing channel is not

Slack, Discord and ClickUp are **async and threaded**: a session can take four minutes and the
medium absorbs it. A phone call cannot. Sub-second turn-taking is the entire product expectation of
voice, and a governed claude-code session is seconds-to-minutes by construction.

**The resolution is a split, and the precedent is already in the codebase:** Cockpit runs two
code-provisioned `System` agents — `concierge` (read-only, answers *about* the workspace) and
`operator` (acts, via governed `task_create` / `automation_propose`), both in
`src/edge/concierge.ts`. Voice wants the same split under a hard real-time constraint:

- a **fast conversational front-end** holds the line, understands intent, answers cheap read-only
  questions immediately, and confirms what it's about to do;
- the **governed worker** is spawned for anything consequential, and the caller is told so
  explicitly ("I've started that — I'll call you back / it's in your inbox").

Do **not** try to make a governed session meet a voice latency budget. That pressure is exactly how
gates get skipped. The front-end absorbs latency by *narrating* it, not by removing governance.

### 2.2 — Authentication: the part that must not be got wrong

This is not hypothetical, because **out-of-band resolution already ships**:

- `question_dms` — binds an `ask_human` question to the DM we sent, so a human can answer by
  **replying in that DM**.
- `approval_dms` — the approval-side twin: binds an approval card to the DM sent to each approver,
  so a human can **approve/reject by replying in that DM**, and the reply resolves the gate.

Both are keyed `(id, provider, external_id)` where `external_id` is a **Slack/Discord user id** — a
real, platform-authenticated account. That is what makes DM-reply approval defensible today.

**A phone call is not that.** Caller ID is trivially spoofable, and voice cloning is a solved,
commodity problem in 2026. So:

> **Voice must not be added as a fourth `provider` on `approval_dms`.** It looks like a one-line
> change and it is a genuine security regression in `canApprove` — the highest-value authorization
> surface in the product, reachable by anyone who can spoof a number and imitate a voice.

The honest split:

| Out-of-band action | Nature | Voice? |
|---|---|---|
| `ask_human` answer (`question_dms`) | supplying **information** to a running agent | ✅ yes — the natural fit |
| Status / digest / "how's the fleet doing" | **read-only** | ✅ yes |
| Starting work (spawn a chat run) | consequential, but **fully re-gated downstream** | ✅ yes, run-as the identified member |
| Approval resolution (`approval_dms`) | **authorization** — the crown jewel | ⛔ not on voice identity alone (see §4, Slice 3) |

Note the asymmetry that makes this coherent: *starting* a run over voice is safe because everything
that run then attempts is still gated — a spoofed caller gets an agent that still can't act. But
*resolving an approval* IS the gate. There is nothing downstream to catch it.

### 2.3 — Transcription error is a new upstream surface

ASR output flows into a governed session prompt. Two consequences: the front-end should **read back**
any consequential instruction before acting on it, and the transcript should be stored verbatim
alongside the session so an audit answers "what did the OS think it heard?", not just "what did it
do."

## 3. The refactor the fourth instance forces (do this first)

Three places grow **linearly per platform**, and at N=4 that stops being acceptable:

1. `spawnChatAgent(agentId, task, opts)` carries one optional field per platform —
   `slack?: {channel, threadTs}`, `discord?: {channel, messageId}`, `clickup?: {taskId, commentId}`
   — and `routeChat` threads all of them through by hand.
2. `ChatPlatform = 'slack' | 'discord' | 'clickup'` (`src/governance/chat-links.ts`).
3. One `*_threads` table + one `*_reply` tool + one env flag per platform, all near-identical.

**Delta:** collapse (1) to a single `binding?: { platform: ChatPlatform; ref: Record<string,string> }`
and add `'voice'` to the union. Keep the per-platform tables (they're small, documented, and the
schema-level comments are load-bearing) — it's the *call-site fan-out* that hurts, not the storage.
Doing this **before** voice lands means voice adds a value, not a fourth branch everywhere.

## 4. Slices

Ordered so each ships standalone and the risky one is last (and optional).

### Slice 0 — egress only (no new trust surface)

- **Delta:** the fleet can *speak* — read out the daily digest, Needs-you items, and notifications.
  Outbound only; nothing inbound is trusted, nothing is resolved by voice.
- **Touch-points:** a `VoiceConnector` in `src/connectors/` alongside `slack.ts`/`discord.ts`;
  `deliverDM` in `src/governance/recipients.ts` gains a voice sink; digest render → speech.
- **Done when:** the EOD digest can be delivered as a call/voice note, and an approval **notification**
  reaches you by voice with a link to decide in the console.
- **Why first:** highest value-to-risk in the whole plan, and it is genuinely useful the day it ships.

### Slice 1 — ingress: talk to an agent

- **Delta:** `voice` joins `IdentityProvider` (`src/types.ts`, currently
  `'slack' | 'discord' | 'email' | 'github'`) so a member links a phone identity on the Team page's
  Chat IDs; a vendor webhook resolves the caller → member → `spawnChatAgent` with a `voice` binding;
  `voice_threads` binds the call; `voice_reply` (`VOICE_REPLY=1`) lets the agent speak back into the
  same call. `routeChat`'s `/agentname` front door, auto-routing and **disambiguation**
  (`takePending`/`matchDisambiguation`) all work unchanged — and disambiguation is *better* by voice
  than in text ("did you mean the deploy agent or the docs agent?").
- **Unmapped caller → refuse**, do not fall back to the company identity. Slack falls back via
  profile email and Discord via nothing; for voice the fallback must be *deny*, because the identity
  is the weakest of the four.
- **Done when:** a linked member calls, says "ask the pod troubleshooter why northwind is slow", and
  gets a spoken answer from a fully governed run attributed to them.

### Slice 2 — answer questions by voice

- **Delta:** `question_dms` gains `provider = 'voice'`; a voice reply to a pending `ask_human`
  resolves it, attributed to the member. This directly attacks the real bottleneck: a blocked agent
  waits on a human, and voice is the lowest-friction way to unblock one.
- **Done when:** an agent blocked on `ask_human` is unblocked from a phone, and the audit records who
  answered and by what channel.

### Slice 3 — approvals (gated; may never ship)

Only with a **second factor** that is not the voice channel: a console/mobile confirm, or a
per-approval one-time code delivered through a *different* linked identity. Voice becomes the
*prompt* and the *convenience*, never the sole proof. If that ceremony proves too heavy to be worth
it, the correct outcome is **not shipping this slice** — Slice 0's voice notification plus a console
tap already captures most of the practical benefit.

## 5. Non-negotiables

1. **Voice identity alone never resolves an approval** (§2.2). Not as a `provider` row, not "just
   for yellow", not behind a setting.
2. **An unmapped caller is denied**, never run as the company identity.
3. **The binding stays server-side** — a voice session is handed a session id, never a call id it
   could redirect.
4. **No latency exemption from the gate.** If a voice interaction feels slow because a run is
   governed, the front-end narrates the wait; it does not bypass.
5. **The verbatim transcript is retained** with the session (§2.3).

## 6. Evaluating a vendor

Requirements to test against any provider (smallest.ai or otherwise) — deliberately capability-based,
since this is a swappable layer:

- **Turn-taking latency** end to end, with barge-in/interruption support.
- **A webhook/callback seam** we can authenticate (signed requests), so ingress fits the ClickUp/
  Composio lane rather than needing a new socket runtime.
- **Verbatim transcript access** per turn, not just final intent.
- **Outbound calling / voice notes** for Slice 0.
- **No public-URL requirement** if possible — the Slack/Discord sockets deliberately work on a
  Tailscale-private box with outbound-only connectivity, and losing that property for voice would be
  a real deployment regression for the current fleet.

## 7. Applying the design test

`docs/agent-os-plan.md` asks: *does this make agents materially safer, more controllable, more
explainable, or easier to operate?* Voice passes on **easier to operate**, and for a sharper reason
than convenience: **suspend-for-a-human is only as good as how fast the human answers.** Approval
latency and blocked-on-`ask_human` time are the practical tax the whole governance model imposes.
Slices 0–2 attack exactly that tax without touching the authorization boundary. Slice 3 would trade
against it, which is why it is last and conditional.

## 8. Open decisions

1. **Ingress transport** — vendor webhook (preferred; matches ClickUp/Composio) vs. a persistent
   media stream we terminate ourselves (a much larger surface; likely a no).
2. **Whether the fast front-end is an Agentric `System` agent** (a third sibling to
   `concierge`/`operator`) or a vendor-side agent calling our API. Leaning `System` agent for
   consistency and governance, if latency permits — this needs a spike.
3. **Whether Slice 3 ever ships** (§4).
4. **Whether the §3 binding refactor lands as its own PR first** — recommended; it's small, and it
   is the difference between voice adding a value and voice adding a fourth branch in five places.
