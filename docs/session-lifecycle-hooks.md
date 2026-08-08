# Session lifecycle — the Claude Code hooks Agent OS listens to

The console's session status (`working` / `ready` / `needs you` / `done` …) is only as honest as the
signals underneath it. This is the full map of which Claude Code hook event drives which piece of state,
what it writes, and why each one is needed.

Reference for the events themselves: <https://code.claude.com/docs/en/hooks>.

## The contract

| Hook event | Script | Route | What it does |
|---|---|---|---|
| `PreToolUse` | `terminal/gate-hook.sh` | `/api/gate` | **The invariant** — every governed effect passes the gateway. Unrelated to status; listed so the table is the whole picture. |
| `Notification` | `terminal/notify-hook.sh` | `/api/notify` | `permission_prompt` / `idle_prompt` / `agent_needs_input` → an inbox card + the per-session "needs you" bell, **and a turn-END** (blocked on a human is not generating). Other `notification_type`s (auth, elicitation, `agent_completed`) are dropped. |
| `UserPromptSubmit` | `terminal/lifecycle-hook.sh` | `/api/session-event` | **Turn START** → `markTurnBusy` (stamps `busy_since`). |
| `Stop` | `terminal/stop-hook.sh` | `/api/turn-idle` | **Turn END** → `markTurnIdle`: clears `busy_since` for every lane, and for an *unattended* run tears the pane down (the pile-up guard releases). |
| `StopFailure` | `terminal/lifecycle-hook.sh` | `/api/session-event` | **Turn END, errored** (`rate_limit`, `overloaded`, `server_error`, …) → same as `Stop`, plus a `session.turn.failed` audit carrying `error_type`. |
| `SessionEnd` | `terminal/lifecycle-hook.sh` | `/api/session-event` | **Run over**, with claude's `reason`. Always clears `busy_since`; marks the row terminal (`markEnded`) only for `prompt_input_exit` / `logout` / `bypass_permissions_disabled`. |

`Stop` keeps a dedicated script rather than folding into the lifecycle hook because it carries the
unattended-teardown decision and `codex-launch.sh` wires that one too (Codex has its own event names).

### Why `StopFailure` matters

Claude fires **no `Stop`** when a turn dies on an API error. Without a handler the turn never ends
server-side: the run keeps reading "working", the automations pile-up guard keeps holding the slot, and an
unattended run parks as a zombie until a 24-hour reaper finds it — the shape behind the recurring
"weekly-limit zombie sessions" incidents.

### There is no interrupt hook — the bell stands in for one

When a human hits **Esc** (or Ctrl-C) mid-turn, Claude Code fires **nothing**: no `Stop`, no
`StopFailure`, no `SessionEnd`. A `UserInterrupt` event has been requested
([anthropics/claude-code#9516](https://github.com/anthropics/claude-code/issues/9516)) and does not exist.
So an interrupted turn used to sit on the console reading "working" until the 2h ceiling.

The signal we *do* get is the `Notification` hook: the TUI parks at its prompt — including the
`Interrupted · What should Claude do instead?` prompt — and claude raises `idle_prompt` (159 of them on
the live northwind box). `notify()` therefore **ends the turn** as well as posting the bell, and the
session reads `needs you`, which is the honest state: claude is waiting for you to say what to do
instead. Typing the next prompt fires `UserPromptSubmit`, which retires the waiting card and puts the
spinner back — the other half of the loop.

Note this makes the teardown deliberate: an interrupted **unattended** run is left alive rather than
reaped, because a human stopped it on purpose and now owns it.

### Why `SessionEnd`'s reason must be read, not assumed

`clear`, `resume` and `compact` are **mid-run** events. Treating any `SessionEnd` as terminal would mark a
session done every time someone typed `/clear`.

## `busy_since` — the flag behind "working"

`term_sessions.busy_since` = when the current turn started, `NULL` between turns. It is what the console
spins on (`Session.working`), because a warm pane outlives the turn it answered, so `alive` cannot mean
"working".

Set by: `UserPromptSubmit`, a server-side delivery (`chatSend` / inject), a resident spawn.
Cleared by: `clearTurnBusy`, called from `markTurnIdle` (Stop), `StopFailure`, `SessionEnd`, and every
terminal status transition (`done` / `stopped` / `crashed`).

**It used to be a one-way latch.** The clear lived inside `markTurnIdle`'s `resident` branch only, so a
member's own interactive session returned before reaching it and never cleared — the console drew a
spinner on finished sessions forever. Live northwind carried the flag on 72 of 520 rows, 66 of them
`done`/`stopped`/`crashed`.

`TerminalManager.isWorking` is the single reader, and it is deliberately defensive — five conditions, so
that no missed signal can strand a spinner:

1. `busy_since` is set;
2. the row is not `stopped`/`crashed` (`done` still counts — an agent that calls `report` flips its row
   mid-turn and keeps working);
3. the runtime is still there (a pane that died mid-turn leaves the flag set);
4. no turn-END was recorded after the turn started (`last_activity > busy_since`) — this is what heals
   rows latched by an older build, with no migration needed;
5. the turn is younger than `MID_TURN_MAX_MS` (2h) — past that it is wedged, not working.

A one-time migration in `src/state/db.ts` also NULLs the already-latched rows (terminal ones, plus any
turn older than the 2h ceiling); a genuinely in-flight turn is untouched, so it is safe on a live box.

## Testing

`scripts/turn-lifecycle-test.cjs` (in `npm run test:governance`) pins the whole machine against a stubbed
backend: the interactive-lane clear, the turn-start signal, `StopFailure` teardown, each `SessionEnd`
reason, all five `isWorking` clauses, and the ignore-unknown-events rule.

## Gotcha

Hook settings are written into the agent folder **at launch** (`.claude/aos-settings.json`), so a change
here reaches a session only when it is next launched. Already-running sessions keep the old hook set —
which is exactly why `isWorking` has to self-heal rather than rely on a beacon arriving.
