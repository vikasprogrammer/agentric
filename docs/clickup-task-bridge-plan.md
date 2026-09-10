# `/agentric` — one ClickUp ticket, one Agentric task

**Status:** proposed (not built). Requested by an InstaWP operator, 2026-09-10, alongside the board
filters that shipped in v0.430.0.

## What exists today

A ClickUp Automation ("comment added") POSTs `/hooks/clickup?key=…&task_id=…`; `ClickupIngress.dispatch`
fetches the latest comment and routes it:

- a comment that isn't a `/command` is **ignored** (a ClickUp comment section is a shared human space, so
  the `/command` gate is the addressing rule — deliberately unlike Slack/Discord, where *having spoken in
  a thread* is enough);
- `/agentname <request>` reaches the shared `/agent` front door and spawns a governed session bound to the
  ClickUp task (`clickup_threads`), so `clickup_reply` answers on the same ticket;
- a follow-up `/command` on a bound ticket **resumes that session** (`continueClickupThread`).

So today a ClickUp ticket maps to *sessions*. It does not map to anything durable: nothing on the Agentric
side outlives the run, and a second `/command` after the session is gone starts over.

## What's asked for

> `/agentric` in a ClickUp comment should create an Agentric task titled `#<ticketId> <ticket heading>`
> with the ticket description as the body — and if that task already exists, put the new comment into its
> discussion instead of creating a second one, so the same Agentric task is the place the work lives.

That is the missing durable half: the ticket maps to a **Task**, and sessions hang off the task the way
they already do everywhere else on the board.

## Design

### 1. A reserved command, intercepted before routing

`/agentric` is handled in `ClickupIngress.dispatch` **before** `continueClickupThread` / `fireClickup` —
it is not an agent name and must never fall through to the "unknown agent" help list. Add a small reserved
set (`agentric`, plus the existing `agent-os` prefix `normalizeChatCommand` already strips) and refuse to
create an agent whose id collides with it.

Grammar:

```
/agentric <text>                 → link this ticket to a task; add <text> to its discussion
/agentric <agent-id> <request>   → the same, and dispatch <agent-id> on that task
```

### 2. The idempotency key: a new `tasks.external_key`

Find-or-create needs a stable link, and none of the existing columns provide one (labels aren't unique;
`clickup_threads` binds *sessions*). Add:

```sql
ALTER TABLE tasks ADD COLUMN external_key TEXT;
CREATE UNIQUE INDEX tasks_external_key ON tasks (tenant, external_key) WHERE external_key IS NOT NULL;
```

Value: `clickup:<clickup task id>`. `TaskStore.byExternalKey(key)` + an `externalKey` field on
`TaskCreateInput`; the unique index makes a racing double webhook a constraint violation to swallow, not a
duplicate task. This generalises deliberately — FreeScout tickets and Slack threads want the same column,
and "replace ClickUp eventually" is only credible if an Agentric task can *be* the external record.

### 3. Title, body, attachments

The comment webhook carries neither the ticket's name nor its description, so add `fetchTask(token, id)`
to `src/connectors/clickup.ts` (`GET /task/<id>` → `name`, `description`, `custom_id`, `url`, `status`).

- **Title** — `#<custom_id ?? id> <name>`, exactly as asked. `custom_id` is the human-facing `#ABC-123`
  when the ClickUp workspace has custom task ids on; fall back to the raw id.
- **Body** — the ticket description, with the ticket URL as the first line (the backlink is what makes the
  Agentric task usable without ClickUp open).
- **Attachments** — `dispatch` already downloads a comment's files (presigned, expiring). On this path
  there is no session to stage them into, so attach them to the task (`TaskStore.attach`).

### 4. Repeat comments become discussion, not tasks

Second and later `/agentric` comments on the same ticket resolve the existing task by `external_key` and
append the comment through the same path `POST /api/tasks/say` uses — author = the resolved member, else
`clickup`. Nothing else changes: status, assignee and priority stay whatever a human or agent set on the
board.

### 5. Identity

Run-as resolution is unchanged (commenter email → member, else company identity). It matters more here
than in the session path because the task ROW records it:

- `owner` = the resolved member (so a later dispatch runs as the human who asked);
- `createdBy` = that member, else `clickup`.

`createdBy` is what the board's **Filed by** lens reads, so a ticket-born task is distinguishable from
both a hand-filed one and an agent-filed sub-task without any extra field.

### 6. Reply, once

First link: one ClickUp comment carrying the Agentric task URL (and `remember()` its id, so our own
comment doesn't re-trigger the webhook). Repeats: the 👀 reaction only — a comment per comment would
double the noise on a shared ticket.

### 7. Governance

None of this is a new trust surface. Task creation and edits are auto-apply + audited (the safety net is
the append-only `task_events` log, exactly as for the console and the MCP tools); only a *dispatched*
session's effects reach the gateway, through the gate every other session uses. New audit events:
`clickup.task.linked`, `clickup.task.discussed`.

## Work

| | |
|---|---|
| `src/state/db.ts` | `external_key` column + partial unique index |
| `src/state/tasks.ts` | `externalKey` on create; `byExternalKey()` |
| `src/connectors/clickup.ts` | `fetchTask()` |
| `src/edge/clickup-ingress.ts` | reserved `/agentric` branch: find-or-create, discuss, attach, backlink |
| `scripts/clickup-task-bridge-test.cjs` | pins: create → repeat → discussion (no second task); racing duplicate webhook; unmapped commenter → `clickup` author |

Roughly half a day, plus the test. No console work — the resulting task is an ordinary task.

## Open questions

1. **Status sync.** Out of scope here (one-way: ClickUp → Agentric). Closing the Agentric task does not
   close the ticket. Worth doing next if the bridge sticks, and it is where a two-way loop-guard gets
   genuinely fiddly.
2. **Which agent, if none is named.** `/agentric <text>` deliberately does *not* dispatch. Auto-routing it
   would make a ticket comment spend money without anyone choosing to — the explicit
   `/agentric <agent-id> …` form is the opt-in.
3. **Retitling.** If the ticket is renamed in ClickUp, the task title goes stale. Cheap fix: refresh title
   + body on each `/agentric` comment; skipped for now because it would silently overwrite a title someone
   edited on the board.
