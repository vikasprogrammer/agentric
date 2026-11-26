# Messages — direct messages with agents

The console's **Messages** page (`#/chat`) lets a member talk to an agent the way they talk to a
teammate: a contact list, one endless conversation per contact, presence, unread counts. No sessions,
terminals or runs appear on the page.

It replaces the older **Chat** page (one session per conversation, a list of chats to manage), which is
deprecated: its code is still in `web/src/App.tsx` (`ChatPage`) and renders only for an old `#/chat/ses_…`
deep link — nothing in the console links there any more (Cockpit's chat launch sends a message here). `#/dm`, Messages' first address, redirects.

Governance is unchanged. Behind every conversation is an ordinary governed session (provenance
`chat:<member>`, run-as the member, gate hook, approvals). This page only hides the plumbing.

## Model

| Table | Holds |
|---|---|
| `chat_rooms` | One row per conversation. `kind = 'dm'` → one member + one agent (the member's *contact*). Points at the session currently carrying it (`session_id`) and a sync cursor into that session's transcript. |
| `chat_messages` | The conversation itself — author, body, and (agent messages) the `steps` behind the reply. |
| `chat_reads` | Per-member read cursor → unread counts. |
| `term_sessions.dm_room` | Stamps every session a room has ever used, so the Sessions lists hide it (`Session.dm`). |

Store: `src/state/chat-rooms.ts` (`os.chatRooms`). Engine: `src/edge/direct-messages.ts`. Page:
`web/src/messages.tsx`. Routes: `GET /api/dm`, `POST /api/dm/contacts`, `GET|DELETE /api/dm/:agent`,
`POST /api/dm/:agent/send` (`{message}` or `{retry:true}`), `POST /api/dm/:agent/reset`.

## How the session stays hidden

- **Messages live in the room, not the transcript.** The session can be reaped, resumed or replaced
  and the conversation does not change.
- **Send** delivers into the warm session, cold-resumes a reaped one (`TerminalManager.chatSend`), and
  starts a NEW session — seeded with a recap of the last 12 messages — when the old one is gone, never
  wrote a transcript, or its transcript passed 6 MB.
- **A turn becomes one message.** `sync` folds the transcript into the room: everything the agent did
  between two human messages collapses into ONE message (its last prose) with the tool calls and interim
  notes kept as expandable `steps`. Mid-turn the reader sees a typing indicator instead.
- **Only agent prose is read from the transcript.** Human messages are stored when sent, so
  harness-injected "user" text (compaction summaries, wake-ups, reminders) never shows as theirs.
- **Folding waits for quiet.** The session's `working` flag can read false for a moment mid-turn, so a
  reply is folded only after the transcript has been still for 2.5 s — otherwise an interim note
  becomes "the message" and the steps are lost.
- **Approvals and questions surface inline** — the one piece of machinery a conversation must show.
  **A typed reply answers an open question:** while an agent is blocked on a question the reader may
  answer, the thread carries `answering` and the composer says so; the next message goes to the question
  (`TerminalManager.answerFromMessages`, audited `question.answered.viaMessages`) and is NOT typed into the
  pane, where it would queue behind the wait. It applies only when exactly one such question is open, in a
  room only when the message is for nobody else, and — for a question that outlives its run (a deadline
  or a default) — only while that turn is still running. `plain: true` on the send opts out. Approvals are
  never taken from typed text: the card's buttons are the decision. The approval card shows the decision
  brief and, by role, *Always* / *Trust host* (owner) or "waiting on an admin/owner" for a reader who
  cannot clear it.
- **The sidebar says who is waiting.** `waiting` on a contact or room counts the questions the reader may
  answer and the approvals they may clear on any session the conversation has used (`chatWaiting`, two
  queries for the whole list).
- **Silence is reported.** A sent message with no reply and nothing running reads `stalled`, and the
  page offers *Try again* (re-delivers without posting twice).

- **`/new` starts a new session.** Typed alone it posts a "New session" marker; `/new <text>` also sends
  the text. The history stays on screen, but the marker is the recap boundary — the new session is told
  nothing from before it. The command never reaches the agent. Same as the menu's *New session*.

Owners and admins keep an escape hatch: the conversation menu's *Open the session behind this*.

## Rooms and group messages

A room (`chat_rooms.kind = 'room'`) holds several members and agents; `chat_participants` lists them.
With a `name` it is a **room**, without one a **group message** — the same thing otherwise.

- **Access is membership.** Only participants can read or post. Any participant can add people or
  agents (an agent only if the adder may run it); the creator and admins can remove others; anyone can
  leave; the last person leaving deletes the room.
- **An agent runs only when addressed** — `@agent-id` (the composer autocompletes it). The one
  exception is a room of one person and one agent, where there is nobody else to mean. Everything else
  is people talking, and no agent runs for it.
- **Each agent has its own session per room** (its *lane*: `chat_participants.session_id` + sync
  cursor). When addressed it is shown what was said since its last turn (`seen_seq`), then the message.
- **The agent acts for whoever addressed it** — run-as is the sender, and the sender must be allowed to
  run that agent. A member who can't gets their message posted with a note, and the agent stays asleep.
- **An agent's reply never wakes another agent.** Two agents mentioning each other is an unattended loop.
- `/new` resets every agent's session in the room.

Routes: `POST /api/rooms`, `GET|PATCH /api/rooms/:id`, `POST /api/rooms/:id/send`,
`POST|DELETE /api/rooms/:id/participants`. `GET /api/dm` also returns `rooms` and `people`.

### Direct messages between people

A person-to-person DM is not a third kind of conversation: it is an unnamed room holding exactly two
members and no agent. `createRoom` returns the existing one for that pair (`ChatRoomStore.directBetween`)
so "Message" from the directory always reopens the same conversation, from either side. No session ever
runs behind it. Every message pings the other person when they are away (`notify` treats two people and
no agent as one-to-one). Adding a third person or an agent turns it into an ordinary group, after which
messaging that teammate starts a fresh pair.

## Comms primitives

Everything below works the same in a DM and in a room.

| Primitive | What it is | Where |
|---|---|---|
| **Cards in the stream** | The inbox messages raised by ANY session the conversation has used (`term_sessions.dm_room` → `cardSessionIds`) are interleaved by time: an open approval/question/proposal with its controls, a settled one as a single line, a deliverable as a tile. | `chatCard` in `web/src/App.tsx` |
| **Stop** | Interrupts the turn in flight — Escape in the pane; the session stays. No hook fires for an interrupt, so `interruptTurn` clears the working stamp itself. | `TerminalManager.interruptTurn` |
| **Background runs** | `/bg <request>` starts a separate UNATTENDED session (hidden, run-as the sender) tracked in `chat_jobs`; when it ends its last prose is posted back tagged `bg`. The conversation's own session is untouched. | `command`, `sweepJobs` |
| **Reminders** | `/remind <30m\|2h\|1d> <what>` — at the due time a marker is posted AND the text is handed to the agent as the person who set it. | `sweepJobs` |
| **Agents write first** | The `message_send` agent tool posts into the agent's DM with a person (default: whoever the run acts for) or a room it is in. `thread` (a message number — a reply's number resolves to its thread) posts under that message, and the result names the number just posted so a later update can go under it. Posting runs nothing; refused from the session that is already answering that conversation (its reply posts itself). ≤30 per session. Audited `chat.message.sent`. | `agentPost`, `POST /api/agent/message` |
| **Away-pings** | An agent message in a DM pings the person on Slack/Discord — skipped while they have the conversation open, and not repeated until they've read it (`chat_rooms.pinged_at`). DMs only. Audited `chat.pinged`. | `ping`, `setChatPinger` |
| **Hand-off cards** | Work the conversation's agent delegated (tasks, `ask_agent`) shows as a status card — read from the existing session chain, nothing new stored. | `handoffs` |
| **Agent → agent** | In a room, an agent's reply that `@mentions` another agent is passed on — as the same person, at most `MAX_AGENT_HOPS` (2) times before a human has to step in (`chat_participants.hop`/`acting`). | `relay` |
| **Commands** | `/new` `/bg` `/stop` `/task` `/remind` `/status` `/help`. An unknown `/word` is an ordinary message (a path must stay sayable). `/status` and `/help` answer privately. | `command` |
| **Attachments** | Files sent with a message are staged into each addressed agent's `.inbox/`; the agent gets the paths, the conversation shows the names. | `stageFilesForAgent` |

**The sweep.** Replies are folded into a room when someone looks at it — which is exactly when nobody
needs a ping. So the scheduler tick calls `DirectMessages.sweep()` (self-throttled to 8 s): it folds
finished replies, relays mentions, finishes background runs and fires reminders with nobody watching.

**The socket.** `GET /api/chat/ws` (`src/edge/chat-socket.ts`, zero-dependency WebSocket). A connection
says which conversation it is watching; the server pushes the thread and the sidebar when they change —
at once on a new message (`chatBus`), and off a 0.9 s timer for what only a look reveals (a transcript
growing). Payloads are identical to the REST routes, which remain the fallback: if the upgrade can't get
through a proxy the page keeps polling. Cookie-authenticated, same-origin only.
The same socket carries "I'm typing" from a person in a room to the others there (`peopleTyping`; expires after
5 s, cleared on send). It has no REST fallback — without the socket nobody sees it, and nothing breaks.

## The room orchestrator

A room message that addresses nobody (no `@agent`, no `@person`, not the one-person-one-agent case, not
a thread with a single agent in it) goes to `orchestrate` (`chat_rooms.orchestrate`: `auto` default /
`suggest` / `off`, set from the room's details panel):

0. **Named** — the message contains an agent's name as a whole word (`infra-ops` ← "infraops", "infra
   ops") → delivered to it. Deterministic, no model call; works in `suggest` too.
1. **Sticky** — the previous message in that stream was an agent's, under 10 minutes ago → this is the
   next line of that exchange. Delivered synchronously, no model call.
2. **Route** — one call to the router's own brain (`routerBrain`: the tenant's LLM, else a tool-less
   `claude -p` on Haiku) with the room's agents + descriptions, the last 12 messages and the new one. It
   answers `{agents, confidence, reason}`.
   - `auto` and confidence ≥ 0.6 → handed to ≤2 agents; a system line says who picked it up and why.
   - otherwise, confidence ≥ 0.35 → a system line with quick-action pills (`@agent can you take this?`).
   - below that, or "nobody" → nothing at all.

It never widens access: only agents the SENDER may run are candidates, the run acts as the sender, at
hop 0. One decision in flight per room. The message is posted before the model is asked, so a slow or
failed call costs nothing but the routing. Tests inject the brain with `setRoomBrain`.

**Fan-out and merge.** When one message reaches two or more agents — the router fanned it out, or the
person `@mentioned` several — it records a `fanout` job
(`chat_jobs.data = { seq, replies }`). Each agent's reply is noted as it is folded in (`fanoutReply`);
when all have answered — or 10 minutes pass with at least two — one model call writes the combined
answer, posted by `orchestrator` (tag `summary`). The individual answers stay in the room.

**Stuck detection** (`watch`, off the sweep). A lane working > 10 min whose transcript has been still
for > 4 gets one orchestrator message per turn with a `/stop` pill (DMs and rooms). In a room, a
question or approval pending > 3 min gets one message per ask that `@mentions` the person the lane is
acting for — a real mention, so they are pinged. Both are skipped in a room set to `off`.

**Rolling summary** (`summarise`, off the sweep). Every 30 new main-stream messages, all but the latest
10 are folded into `chat_rooms.summary` (`summary_seq` = last message covered). It is shown in the
room's details, returned by `/summary`, and given to an agent whose `seen_seq` predates it in place of
the messages it covers.

`orchestrator` is an author id, not an agent: it has no session, runs nothing, and is never a mention
target. Not built: routing an agent's follow-up to another agent.

## Quick actions

An agent ends a message with one line — `[[actions: Go ahead | Show me the plan | Not now]]` — and
`postAgent` peels it off into `meta.actions` (≤4, ≤80 chars each; only a TRAILING line on a message that
has other text). The page shows them as pills on the newest message only; tapping one sends that text as
the reader's next message (in the thread, if that is where it was offered). Agents learn the syntax from
their opening prompt (`ACTIONS_HINT`) and the `message_send` tool description.

## Threads

Any main-stream message can carry a thread: replies are `chat_messages` rows with `thread_id` = that
message's `seq`. The main stream shows only `thread_id IS NULL` rows, each with its reply count; the
thread opens in a panel beside the conversation. Works the same in DMs and rooms.

**How an agent's reply finds its thread.** Every message handed to an agent ends with a tag —
`[[main]]` or `[[thread:<seq>]]` — and the transcript keeps it. When `syncLane` folds a reply back in,
it reads the tag of the user turn the reply answers (an untagged turn, e.g. a harness wake-up, inherits
the last one). No queue, no per-lane "current thread" state to desync when a turn is interrupted.
In a room, a reply in a thread with no `@mention` goes to the one agent already talking there.

## Automations that report into a conversation

An automation can carry a destination — **Post results to** on its form, `postTo` on the API
(`{ kind: 'dm', member } | { kind: 'room', room }`, plus `thread: 'own' | <message number>`). It is
checked at save time by `checkDest`, which also puts the agent in a room it is pointed at.

When the automation fires, `openDest` resolves the conversation and three things follow:

- the run's task gains a `[Where the results go]` line, so the prompt never has to name a destination;
- the session is bound to it (`term_sessions.chat_dest`), which makes a bare `message_send({ text })`
  land there. This is NOT `dm_room`: the run stays an ordinary, visible run;
- when the run ends, `runResult` posts its `report` summary there (tag `automation`) — unless the agent
  already posted there itself, in which case its own write-up stands alone. A failure is labelled and
  linked to the run; a crash or a run that ends with no report always says so.

`thread: 'own'` gives the automation ONE standing thread: the first run posts a root naming the
automation, its number is kept on the automation (`threadSeq`), and every later run replies under it.
A root that has gone is reopened; re-saving the same destination keeps the thread. A destination that
no longer resolves (room deleted, member removed) is audited `automation.post.unresolved` and the run
goes ahead without one.

### Replying to an automation's post

Every message an automation run posts (its own `message_send`, or the summary `runResult` posts for it)
carries the run's session id (`meta.run`). A person's reply is routed by `runBehind`:

- **in a thread** — to the NEWEST run that posted in that thread, so in a standing thread a reply always
  reaches the latest run;
- **in a DM's main stream** — to the run whose post is the very last thing said (anything else in
  between and the message is ordinary conversation again; `/new` also breaks it).

`runDeliver` hands the reply to that run's own session with `chatSend` — typed in if the run is still up,
otherwise the same transcript is resumed — so the run answers with everything it found still in context.
It runs as the person who replied (`canChat` applies; someone who may not run the agent falls through to
the ordinary path). What the run says next is folded back by a job-backed lane (`chat_jobs.kind = 'run'`,
cursor in the job's `data`), which starts at the transcript's length at the moment of the reply, so
nothing the run said earlier is replayed. The lane closes once the session has gone away with nothing
left to fold; a later reply opens a new one. Audited `chat.run.reply`.

A reply that @mentions a DIFFERENT agent goes to that agent as usual. A run whose transcript is gone
(archived, deleted) falls back to the agent's everyday session for the conversation.

## Media in a conversation

An agent message can carry Library artifacts (`meta.art`, resolved to `artifacts` on the way out) — an
image is drawn in place, video and audio get a player, anything else is a file tile. Two ways in:

- **automatically** — whatever the turn `publish`ed or generated (`image_generate`, `video_generate`, …)
  is attached to that turn's reply, in whatever thread the reply lands in (`foldReply` collects the
  turn's `artifactIds`). The deliverable's inbox card is then hidden in that conversation, so it is not
  drawn twice;
- **explicitly** — a `[[show: art_…]]` line (comma-separated ids) in the message, stripped from the text.
  Works in a chat reply and in `message_send`, which is how an automation's report carries a chart.

An agent can show only its OWN artifacts (or team-shared ones), six per message. Showing one shares it
with the people in that conversation: `/api/artifacts/:id/raw` and `/thumb` also admit a member of a
conversation it was shown in (`ChatRoomStore.shownTo`) — it does not appear in their Library. Every
chat session's opening prompt says all this (`MEDIA_HINT`).

## Primitives in a conversation

Two mechanisms put the rest of the product inside the chat:

- **Cards from the feed** — approvals, questions, deliverables and proposals raised by the sessions in
  `cardSessionIds`: the conversation's own sessions, runs replying into it (`chat_jobs` `run`), and the
  runs its agent handed work to (the hand-off chain). They are the same Inbox cards, decidable in place.
- **Reference cards** (`refs` on a message, `ChatRef`) — a task, goal, bet, automation or Knowledge page
  the message is about. Sources: what the turn created or changed (`ChatTurn.entityIds` + `kbRefs`,
  folded into the message meta as `ent`), and what the text names — an id (`tsk_…`, `goal_…`, `bet_…`,
  `au_…`, `kbp_…`) or a `#/kb/<section>/<slug>` link. Hydrated on every read by `DirectMessages.refs`,
  so status is always current. Capped at `MAX_REFS` (4); only create/change tools contribute, never
  list/get; an id that does not resolve draws nothing. A card links to the primitive's own page.
- **Task cards are editable.** Status and assignee are menus on the card; they write through
  `PATCH /api/tasks/:id` (the Tasks board's own route — same audit, same proposal gate), and that route
  emits `chatBus` `changed` so every viewer's card redraws. The assignee menu offers the people and
  agents the member can already message. Other kinds stay read-only links.

## What a read costs

A conversation is read constantly — on open, on every socket tick while a reply is in flight, and the
sidebar every few seconds per open tab — so the read path is kept small on purpose:

- **Newest page only.** `thread`/`roomThread` return `THREAD_PAGE` (40) main-stream messages; the page
  asks for the page before (`?before=<seq>`) when the reader scrolls to the top. When a new message
  pushes an old one out of the pushed page, the client keeps the old one.
- **Steps on demand.** A message carries `stepSum` (`{ n, failed }`), not its steps; opening the
  collapsed line fetches them from `GET /api/chat/steps?key=&seq=` (membership-checked via `roomOf`).
  A turn in flight still streams its steps in `typing`.
- **Avatars once.** An avatar is an inline image. Messages and room member lists carry ids and names
  only; the page resolves avatars from the team list, which the socket sends when it changes rather than
  with every sidebar push (same for the agent directory).
- **Transcript lookups.** `sessionPulse` needs each conversation's transcript size/mtime, and finding the
  file probes every project dir under every account root. `TerminalManager.transcriptMark` remembers a
  FOUND path for 5 s (never a miss — a session about to write its first line must be seen at once), and
  `findTranscript` stats with `throwIfNoEntry: false` so a miss does not build an exception.
- **`term_sessions(dm_room)` is indexed** (partial) — "which sessions has this conversation used" ran as
  a table scan on every read.

Measure before changing any of this: time the endpoint AND record its payload size on a busy tenant.
A local copy of a tenant DB misleads on the transcript lookups (the account roots are paths that do not
exist on the copy's machine), so time those on the box itself.

## Notifications

| Where | What you get |
|---|---|
| **In the app** (`ChatNotifier`, mounted on every page) | A toast (click to open), a chime if sound is on in your preferences, a desktop notification when the tab is in the background (opt-in button in the Messages sidebar). Never for the conversation you are looking at. |
| **Sidebar** | Unread count; a red `@n` when you were mentioned; a muted bell on muted conversations. |
| **Outside the app** (Slack/Discord DM) | One-to-one conversations (a DM with an agent, or two people with no agent): every message. Rooms: only when you are `@mentioned` (`@first`, `@first-last`, `@everyone`/`@here`). Skipped while you have it open; once per unread stretch (`chat_reads.pinged_at`). |

Each person sets a level per conversation — every message / only @mentions / mute
(`chat_reads.notify`, `PUT /api/chat/notify`) — which narrows all three. People mentioned are stored on
the message (`chat_messages.mentions`).

### One notice per event

A session whose news already reaches people through Messages (`TerminalManager.chatHome`: `dm` = a
conversation's own session, `dest` = a run with a **Post results to** destination) raises no second,
session-side notice for the same thing:

| Session-side notice | For a Messages-homed session |
|---|---|
| Inbox "Completed" card | hidden from the feed (the row is still written — `hasCompleted` reads it) |
| "Completed — agent" Slack/Discord DM | not sent (audited `session.event.suppressed`) |
| "Waiting for your input" card + DM after a turn | not raised |
| Permission prompt card + DM | **kept** — nothing else would surface it |
| Crash card + DM | kept for `dm`; suppressed for `dest`, where `runResult` posts the crash into the conversation |
| Approval / question cards and their DMs | unchanged |

The trade: a result posted into a room pings nobody outside the app unless it @mentions them (a room is
not a pager), so the owner of a run that reports into a room is no longer DM'd when it finishes.

## Not built yet

- Browsable/joinable public rooms.
- Reactions, search, inline image previews for attachments.
- An agent choosing WHERE to reply: a reply always goes where the message it answers was said (thread →
  that thread, main → main). An agent cannot open a thread or move an answer out of one.
