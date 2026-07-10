# The Inbox — audit, gaps, and roadmap

The **Inbox** is the human↔agent message surface: the feed of approvals, questions, completions,
progress updates, notifications, artifacts, and skill proposals that agents and automations produce and
humans consume in the console. It is where the governed fleet *talks to people* — the counterpart to the
gateway (where agents *act on the world*).

This doc is the standing audit of that surface: how it's wired, the gaps found, what's shipped, and the
roadmap. Update the status tags as reality changes.

---

## 1. The spine (what's solid)

One `messages` table is the feed. Every row is one card. Two consumer surfaces read it:

- **Console** — `GET /api/messages` → `TerminalManager.listMessages(viewer)`, polled every 1.5s. The
  whole tenant feed, visibility-scoped per member.
- **Agent** — `GET /api/inbox` → `sessionInbox(sessionId)`, the agent's own session feed (the
  `check_inbox` MCP tool), so a run can read back answers/approvals/updates on itself.

Three design choices make it robust:

1. **Live status by join, not by copy.** An `approval`/`question` card doesn't store its own resolution
   — `listMessages` LEFT JOINs the `approvals`/`questions` tables at read time. So the card's status is
   always the single source of truth, and it **self-heals across a restart** even though the in-memory
   blocking waiter doesn't survive one. (`toMessage` derives `status` from the joined row.)
2. **Visibility = provenance + identity.** `canViewRow(spawned_by, run_as, viewer)`: owner/admin see all;
   a member sees what they spawned, what an automation they own fired, **and** any run that acted *as*
   them (`run_as`). A chat-triggered run is owned by the automation for provenance yet visible to — and
   owned by — the person it ran as.
3. **Per-member state.** Read + dismiss live in a `message_state(message_id, member_id, read_at,
   dismissed_at)` join keyed to the viewer, not as columns on the shared row (see §4.3).

### Message types

| type | written by | terminal? | needs human? |
|---|---|---|---|
| `approval` | the gate (policy → `approve`) | no | **yes** (approve/reject) |
| `question` | `ask` MCP tool | no | **yes** (answer) |
| `notification` | Claude `Notification` hook (permission/idle) | no | **yes** (attend) |
| `completed` | `report` MCP tool | yes | no |
| `update` | `update` MCP tool | no | no |
| `artifact` | `publish` MCP tool | no | no |
| `skill.proposed` | `skill_propose` MCP tool | no | review (in Skills) |
| `task` | Tasks lifecycle (`TaskStore` notifier) + legacy start rows | no | no (deep-links to the board) |

The first three are **"Needs you"**; the rest are **"Activity"**.

**Explicit-audience cards (`audience_kind`/`audience_id`).** Most cards inherit their visibility from the
session that wrote them (`canViewRow` on the session's provenance/run-as). A card can instead **name its
recipient** via an Audience (`member`/`admins`/`approvers`/`sessionOwner`) — then `canViewMessageRow`
resolves it through the same `resolveRecipients` used to DM, so the card is visible to exactly whom it
would be pinged (owner/admin always see all). This is how a **session-less** card reaches the right person:
a **Tasks** notification has no session, so it carries `audience = {member: assignee|owner}` and a
`session_id = 'task:<id>'` sentinel. See §4.10.

**Owner-scoped session cards + `mine`/`all` scope (v0.95.0 — §4.11).** Every session card
(`question`/`completed`/`update`/`notification`/`artifact`) now carries `audience =
{sessionOwner: <session>}`, and approval cards carry the `approvalAudience` (owner-if-approver, else
`approvers`). Visibility (`canView*`) is unchanged — owner/admin *can* still see everything — but
`listMessages(viewer, scope)` adds a **`mine`** default that narrows the feed to cards *addressed to*
the viewer (role-neutral: `isAddressedTo`, no owner/admin blanket pass). Owner/admin request `scope=all`
for the oversight view; a member's `mine` and `all` are identical. This fixes the flood where an
owner/admin saw — and was DMed about — every other person's session. See §4.11.

---

## 2. Write paths

All agent writes are session-secret-gated loopback calls to `/api/*` routes that sit *before* the
member-auth gate (`src/memory/memory-mcp.ts` → `src/server.ts` → `TerminalManager`):

- `ask` → `POST /api/ask` → `askQuestion` — **blocking** (~1h client-side poll of `/api/ask/:id`).
- `report` → `POST /api/report` → `report` — completion + outcome; stores an optional lesson memory.
- `update` → `POST /api/update` → `progress` — non-blocking progress note (`important` highlights it).
- `publish` → `POST /api/publish` → `publishArtifact` — snapshots a deliverable.
- `skill_propose` → `POST /api/skills/propose` — drafts an `.aos-proposed` skill + a card.
- The **gate** itself writes `approval` cards when policy returns `approve` (`terminal.ts` `gate` /
  `putSecret`).

---

## 3. Read + resolve paths

- **List:** `GET /api/messages` (console, per-viewer) · `GET /api/inbox` (agent, per-session).
- **Approve/reject:** `POST /api/approvals/:id` — role-gated by `canApprove(role, level)`.
- **Answer:** `POST /api/questions/:id` — visibility-gated by `canViewQuestion`.
- **Read (per-member):** `POST /api/messages/:id/read` · `POST /api/messages/read-all`.
- **Dismiss (per-member):** `POST /api/messages/:id/dismiss` · `POST /api/messages/dismiss-all` —
  refuses to dismiss an item still waiting on the human.

---

## 4. Gaps (ranked) and status

The recurring theme of the audit: **the inbox is a well-built passive store with weak *push*.** Items
land correctly; getting a human or agent to *notice* and *act* on them in time is the consistent
weakness. Ranked by impact:

### 4.1 Questions notified nobody — ✅ SHIPPED (v0.39.0)
Approvals DM approvers out-of-band; `ask` did not. A blocking `ask` sat unseen until its ~1h poll timed
out. **Fixed:** a `questionNotifier` twin DMs the run-as human (else the spawning member; a pure
automation → owner/admins). Audited `question.notified`.

### 4.2 The chat loop didn't close — ✅ SHIPPED (v0.39.0)
A Slack/Discord-triggered run's `report`/`ask`/approval went to the console, not back to the thread the
human was watching. **Fixed:** a `chatMirror` sink mirrors completion, questions, and approval gates
back into the bound `slack_threads`/`discord_threads` thread; no-op for non-chat runs.

### 4.3 Read/dismiss were inconsistent for a team — ✅ SHIPPED (v0.39.0)
Unread was a browser-local `localStorage` timestamp (didn't sync across a member's devices); dismiss was
a **global** column (one admin dismissing hid the row for everyone). **Fixed:** both moved to the
per-member `message_state` join. Legacy global `dismissed_at` still honored as a dismissed-for-all
fallback.

### 4.4 "Always approve" — teach the policy from an approval — ✅ SHIPPED (v0.40.0)
Every approval used to be one-shot: the same capability re-prompted every run, forever. **Fixed:** an
**"Always approve"** action on the approval card (owner-only) approves *this* attempt **and** writes a
persistent `allow` rule into the policy override, so future matching attempts pass the gate without a
card. The inbox becomes the **policy-authoring** surface — the natural place to codify "we've decided
this is fine." See §5 for the safety design.

### 4.5 No server-side timeout / escalation on stale items — ⏳ BATCH 2
The agent's `ask` gives up client-side at ~1h, but the `questions` row stays `pending` **forever** — a
human answering at hour 2 succeeds into a void; the run already moved on. Approvals block the gate hook
indefinitely. No `timeoutSeconds`, no session-liveness check on answer, no "this run already gave up"
signal. **Plan:** configurable `ask` timeout; mark the question `expired` when the run dies; on answer,
check the run is still alive and tell the human if not.

### 4.6 Nothing re-pings or digests stale items — ⏳ BATCH 2
The approval/question DM fires **once**, best-effort, errors swallowed. If the approver was offline it
never re-pings; no second-approver escalation; no "N items waiting Nh" digest. **Plan:** a scheduled
reminder pass (reuse the automations tick) that re-DMs / digests items pending beyond a threshold, with
escalation to the next approver tier.

### 4.7 Everything polls; nothing scales — ⏳ BATCH 3
Console re-fetches the **entire** tenant feed every 1.5s (no `since` cursor, no pagination, all held in
memory); the agent polls `/api/ask` every 2s. Fine now, won't scale. **Plan:** `GET
/api/messages?since=<ts>` delta + SSE push; virtualize/paginate the feed.

### 4.8 UI friction + no feed tools — ⏳ BATCH 3
Approve/reply buttons just `disabled=busy` until the next 1.5s poll (no optimistic update); errors are
`alert()`. No filter/search/grouping/threading in the feed. **Plan:** optimistic action state +
toasts; per-agent/per-session grouping; type filter + search.

### 4.10 No global "who receives this?" + Tasks didn't notify — ✅ SHIPPED (v0.63.1 / v0.64.0)
"Who is the receiver of a notification?" was re-derived in each DM notifier, and anything without a
session (a **Task**) had nowhere to route — inbox visibility was inferred purely from a session's
provenance. **Fixed in two steps:** (1) one `Audience` vocabulary + `resolveRecipients`
(`src/governance/recipients.ts`) is the single answer to "who receives this," consulted by every notifier
(v0.63.1). (2) Messages gained an explicit `audience` (the pull face of the same resolver), and
`TaskStore` gained a notifier so create/assign/blocked/done events land an **audience-addressed** inbox
card + DM for the right human — assignee or owner (v0.64.0). See §4 header for the audience mechanics.

### 4.11 Owner/admin flooded by everyone's session cards — ✅ SHIPPED (v0.95.0)
Because session cards were **un-addressed**, `canViewMessageRow` fell through to `canViewRow`, whose
"owner/admin see everything" rule meant an owner was DMed + inbox-carded about *every* member's and
admin's session — and every approval broadcast to *all* approvers, so admins pinged each other about
self-approvable runs. **Fixed:** (1) every session card carries `audience = {sessionOwner}`; the two
approval cards + `notifyApprovers` share `approvalAudience` (session owner if they can clear the level,
else escalate) — card audience == DM audience. (2) `listMessages(viewer, scope)` defaults to **`mine`**
(cards addressed to the viewer, via the role-neutral `isAddressedTo`); owner/admin opt into `scope=all`
for oversight (`GET /api/messages?scope=all`, gated by `inboxScope`). (3) The **`notify`** MCP tool
(`POST /api/notify` → `TerminalManager.notifyMember` + `setMemberNotifier`) is the escape hatch: an
agent loops in ONE named teammate (inbox card addressed to them + DM) when a run concerns someone other
than its owner. Console: an **My activity / All** toggle on the Inbox (owner/admin only).

### 4.9 Agent can't be *pushed* an answer — ⏳ LATER
An agent only learns its question was answered by polling `ask` or remembering to `check_inbox`. No push,
no "N new replies since last check" cursor. Partially mitigated by `check_inbox`. **Plan:** an inbox
cursor per session; longer-term, a push channel into the run.

---

## 5. "Always approve" — design detail (§4.4)

**Trigger.** On a pending `approval` card, alongside *Approve* / *Reject*, an **"Always approve"** action
(shown only to a member who may approve that level).

**Effect** (`POST /api/approvals/:id/always`). Two steps in one call:
1. Resolve *this* approval as approved (unblocks the waiting run now) — always, even if the rule can't be
   added, since the run is what's urgent.
2. Add a persistent **`allow`** rule for the matched **capability** to the policy override, hot-reloaded
   (`os.policy.update`) so the next matching attempt returns `allow` and never lands a card.

**The safety story is rule *placement*** (`withAlwaysAllow` in `src/governance/policy.ts`). `classify` is
**first-match**, and the real policy's deny guardrails are *conditional* `never` rules on `*` (`when
destructive` / `when amountUsd > $moneyCapUsd` / `when deleteCount > $bulkDeleteCount`). So the new
`allow` rule is inserted **after all `never` rules**, never before them:
- a routine attempt of the capability now hits the `allow` → no card;
- a **destructive / over-cap / bulk-delete** attempt of the same capability still hits its conditional
  `never` first → **stays denied**. "Always approve email.send" stops prompting for ordinary sends but
  cannot send a destructive or over-budget one.

**Guardrails (non-negotiable).**
- **Placement preserves every `never`** — the allow goes after the last `never`, so no deny is shadowed
  (verified by the `withAlwaysAllow` smoke test: destructive/over-cap sends still deny post-rule).
- **Unconditional `never` refuses** — if a `never` with no `when` matches the capability (an absolute
  deny), the rule is *not* added; the attempt is still approved once, with a note to the human.
- **Owner-only** — adding a rule is a policy edit, so it takes the same `me.role === 'owner'` guard as
  `PUT /api/policy` (an admin may approve once but must not rewrite the ruleset). The button is
  owner-only in the UI, enforced server-side.
- **Idempotent** — a second "always approve" of the same capability is a no-op (returns `ruleAdded:false`).
- **Audited + reversible** — emits `policy.rule.added` (`from: inbox.always_approve`) + `policy.updated`;
  the rule shows in the console Policy editor where it can be removed.

**Why it belongs in the inbox.** The approval card is the exact moment a human forms the judgment "this
class of action is fine." Making them re-navigate to a Policy editor to codify it loses the intent. The
inbox becomes not just where policy *stops* the fleet, but where humans *teach* it — the governance
analogue of the memory/skill self-learning loop.

**Follow-ups.** v1 keys the rule on the capability id (workspace-wide). Later: narrow by agent or by an
arg predicate; visually distinguish a learned allow from a hand-authored one; let an admin propose an
always-rule for owner sign-off (mirrors `skill_propose`).

---

## 6. Roadmap summary

| Batch | Scope | Status |
|---|---|---|
| **1** | Question DMs · chat loop · per-member read/dismiss | ✅ v0.39.0 |
| **Always approve** | Learn a policy `allow` from an approval card (§4.4/§5) | ✅ v0.40.0 |
| **Recipient routing** | Global `Audience`/`resolveRecipients` + explicit-audience cards + Tasks→Inbox (§4.10) | ✅ v0.63.1/v0.64.0 |
| **2** | Server-side `ask` timeout/expiry · stale-item reminders + escalation | ⏳ |
| **3** | `since`-cursor + SSE push · feed filter/search/grouping · optimistic UI | ⏳ |
| **later** | Push answers to the agent · inbox cursor | ⏳ |

---

## 7. Key files

- `src/terminal.ts` — `listMessages` / `sessionInbox` / `toMessage`; `askQuestion` / `report` /
  `progress`; the `gate` (approval cards); the `approvalNotifier` / `questionNotifier` / `chatMirror`
  sinks; `markRead` / `markAllRead` / `dismissMessage` / `dismissAllMessages`.
- `src/tenant-registry.ts` — wires the sinks: `notifyApprovers`, `notifyQuestionAsked`,
  `notifyTaskOverdue`, chat mirror. Each declares an **`Audience`** and calls the shared `deliverDM`.
- `src/governance/recipients.ts` — the **global recipient resolver**: `Audience`
  (`approvers`/`admins`/`member`/`sessionOwner`) → `resolveRecipients(os, audience): Member[]`. The one
  answer to "who receives this," consulted by every out-of-band notifier (and the intended basis for a
  session-less card's visibility — §4/§7 of the tasks work).
- `src/server.ts` — the `/api/messages*`, `/api/ask`, `/api/approvals/:id`, `/api/questions/:id` routes.
- `src/state/db.ts` — `messages`, `questions`, `approvals`, `message_state` schema.
- `src/governance/policy.ts` — the rule engine "Always approve" will write into.
- `web/src/App.tsx` — `InboxPage` / `ActionItem` / `FeedItem`; `web/src/lib/api.ts` — the client.
