# Messages — direct messages with agents

The console's **Messages** page (`#/chat`) lets a member talk to an agent the way they talk to a
teammate: a contact list, one endless conversation per contact, presence, unread counts. No sessions,
terminals or runs appear on the page.

It replaces the older **Chat** page (one session per conversation, a list of chats to manage), which is
deprecated: its code is still in `web/src/App.tsx` (`ChatPage`) and renders only for a `#/chat/ses_…`
deep link, which Cockpit's chat launch still produces. `#/dm`, Messages' first address, redirects.

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

Owners and admins keep an escape hatch: the conversation menu's *Open the session behind this*.

## Not built yet

- **Rooms** — several members and agents in one conversation. The tables are already room-shaped
  (room → authored messages → per-member read cursor); it needs a new `kind`, a membership table, and
  a rule for which agent a message addresses.
- **Member ↔ member DMs**, threads, reactions, mentions, search, file attachments
  (`stageInboundFiles` is the path — `attachFile` needs a live pane).
- **Agent-initiated messages** — an agent posting into its DM with a member unprompted (a cron report,
  a finished delegated task). Today a message only arrives as a reply.
- **Push** — the page polls (0.9 s while a reply is in flight, 3 s idle).
