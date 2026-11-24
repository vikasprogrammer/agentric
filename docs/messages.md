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

## Comms primitives

Everything below works the same in a DM and in a room.

| Primitive | What it is | Where |
|---|---|---|
| **Cards in the stream** | The inbox messages raised by ANY session the conversation has used (`term_sessions.dm_room` → `cardSessionIds`) are interleaved by time: an open approval/question/proposal with its controls, a settled one as a single line, a deliverable as a tile. | `chatCard` in `web/src/App.tsx` |
| **Stop** | Interrupts the turn in flight — Escape in the pane; the session stays. No hook fires for an interrupt, so `interruptTurn` clears the working stamp itself. | `TerminalManager.interruptTurn` |
| **Background runs** | `/bg <request>` starts a separate UNATTENDED session (hidden, run-as the sender) tracked in `chat_jobs`; when it ends its last prose is posted back tagged `bg`. The conversation's own session is untouched. | `command`, `sweepJobs` |
| **Reminders** | `/remind <30m\|2h\|1d> <what>` — at the due time a marker is posted AND the text is handed to the agent as the person who set it. | `sweepJobs` |
| **Agents write first** | The `message_send` agent tool posts into the agent's DM with a person (default: whoever the run acts for) or a room it is in. Posting runs nothing; refused from the session that is already answering that conversation (its reply posts itself). ≤30 per session. Audited `chat.message.sent`. | `agentPost`, `POST /api/agent/message` |
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

## Threads

Any main-stream message can carry a thread: replies are `chat_messages` rows with `thread_id` = that
message's `seq`. The main stream shows only `thread_id IS NULL` rows, each with its reply count; the
thread opens in a panel beside the conversation. Works the same in DMs and rooms.

**How an agent's reply finds its thread.** Every message handed to an agent ends with a tag —
`[[main]]` or `[[thread:<seq>]]` — and the transcript keeps it. When `syncLane` folds a reply back in,
it reads the tag of the user turn the reply answers (an untagged turn, e.g. a harness wake-up, inherits
the last one). No queue, no per-lane "current thread" state to desync when a turn is interrupted.
In a room, a reply in a thread with no `@mention` goes to the one agent already talking there.

## Notifications

| Where | What you get |
|---|---|
| **In the app** (`ChatNotifier`, mounted on every page) | A toast (click to open), a chime if sound is on in your preferences, a desktop notification when the tab is in the background (opt-in button in the Messages sidebar). Never for the conversation you are looking at. |
| **Sidebar** | Unread count; a red `@n` when you were mentioned; a muted bell on muted conversations. |
| **Outside the app** (Slack/Discord DM) | One-to-one conversations (a DM with an agent, or two people with no agent): every message. Rooms: only when you are `@mentioned` (`@first`, `@first-last`, `@everyone`/`@here`). Skipped while you have it open; once per unread stretch (`chat_reads.pinged_at`). |

Each person sets a level per conversation — every message / only @mentions / mute
(`chat_reads.notify`, `PUT /api/chat/notify`) — which narrows all three. People mentioned are stored on
the message (`chat_messages.mentions`).

## Not built yet

- Browsable/joinable public rooms.
- Reactions, search, inline image previews for attachments, attachments and commands inside a thread.
