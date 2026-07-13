# Goals — set the outcome, the fleet plans the work

A **Task** is one unit of work. A **Goal** is the *outcome* several tasks add up to — "cut support
first-response time to under an hour", "ship the pricing revamp", "grow the newsletter to 10k". You
state where you want to be; Agent OS helps turn that into the tasks that get there. Goals live on the
**Goals** page (under Agents).

## What a goal is

- A **target** — the outcome you're aiming at, ideally something you can tell is done.
- **Progress** — the linked work and how far along it is.
- **Linked tasks** — the actual units of work that move the goal, shown in pipeline order with any
  dependencies (a task waiting on another shows a **waiting on N** chip).
- Optional **sub-goals** — a big goal can nest smaller ones; tasks roll up to the goal they belong to.

A goal is not a task. It's the thing you'd still care about after any single task is done.

## Planning a goal

You rarely have to break a goal into tasks by hand.

**Plan this goal** (owner/admin, on the goal's page) spawns a governed **strategist** agent. It reads
the goal, its current progress, and any tasks already linked — works out the **gap** to the target —
and **files the tasks needed to close it**, linked back to the goal. It drafts; it never dispatches.
The tasks land in the goal's linked-tasks list for a human to review and kick off.

The strategist can also **propose sub-goals** for a goal too big to plan in one pass, so a sprawling
outcome decomposes instead of turning into fifty loose tasks.

## Auto-planning (opt-in)

Turn on **Auto-plan stuck goals** (owner/admin, top of the Goals page) and you don't even click Plan.
The scheduler notices an **active goal with no open work** — never planned, or all its tasks finished
but the goal isn't achieved — that's sat idle past a short grace window, and runs the strategist for
you. Same as clicking Plan: it drafts tasks for review and never auto-dispatches.

It's **off by default** (it spawns agent sessions) and deliberately boring — a plain check on the
goal's own data, rate-limited per goal and per tick so it can't burst runs or grab a goal you're
still editing.

## From plan to done

Planning fills the goal with **draft tasks**; nothing runs until a human dispatches them (Tasks board,
or the goal modal). From there it's the normal Tasks flow — an agent-assigned task with auto-dispatch
spawns a governed session, the agent closes its own loop, and the goal's progress ticks up. See
**Memory, Knowledge & Tasks** for how the queue works.

Deleting a goal **detaches** its tasks rather than deleting them — real work survives on the board,
just unlinked.

## Rule of thumb

Reach for a Goal when the outcome outlives any one task and you want the work to keep organizing
itself toward it. For a single "do this thing", just file a **Task**.
