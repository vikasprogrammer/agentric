# Attachable-unattended sessions — kill the `-p` lane

**Status:** in progress (slice 1). **Owner:** platform.

## Problem

"Unattended" runs (automations / cron / tasks / chat) launch as `claude -p` (print mode) — a
non-interactive process with **no attachable TTY**. So "take over" (`TerminalManager.goInteractive`)
has to **kill the running process and relaunch `claude --resume`**. That discards the in-flight turn and
drops the human onto an idle prompt — the run visibly "stops" the moment you take it over. You cannot
promote a live `-p` process into a TUI in place.

## The invariant we change

**Every claude-code session is an interactive TUI in a detached tmux pane.** Runs differ only in
*teardown policy* and *whether a human has claimed them* — never in process mode. "Take over" becomes a
metadata flip plus a plain ttyd attach: nothing is killed, nothing is resumed, no turn is lost.

The resident chat lane already proves this shape works unattended (interactive claude +
`--dangerously-skip-permissions`, detached in tmux, the PreToolUse gate hook still governing every
effect). We generalize it to all unattended runs.

## Hard constraint from Claude Code

The **Stop hook** fires once per turn but **cannot exit the process** — it can only beacon out (same as
`notify-hook.sh`). So teardown cannot live inside claude: the Stop hook POSTs a "turn ended" beacon to a
loopback route and the **server** decides whether to tear the pane down. The server is already the
authority that kills panes (`stopSession`, `reapIdleResidents`).

## Session model — three teardown policies, one process mode

| Origin | Launch | Teardown policy |
|---|---|---|
| Member spawn (interactive) | interactive TUI (unchanged) | **sticky** — lives until Stop-idle / close / stop |
| Chat (resident) | interactive TUI, warm (unchanged) | **idle-timeout** reap (unchanged) |
| Automation / cron / task | interactive TUI, `--dangerously-skip-permissions`, detached | **immediate** — torn down at turn-end IF no client attached & no pending ask |
| Any unattended run, **taken over** | no relaunch — just attach | flips to **sticky** (claimed) |

The `immediate` policy reproduces exactly what `-p` gives today (the pane vanishes the instant the run
completes → tmux drops → the pile-up guard `isAlive` releases), but because the pane is a real TUI the
whole time it is alive, a human can attach mid-run with zero disruption.

## Data model

Reuse existing columns; add two nullable ones (non-destructive `ALTER TABLE`):

- Keep `term_sessions.headless` (0/1) but re-read it as **"unattended, immediate-teardown"** — the launch
  just stops using `-p`.
- Add `claimed_by TEXT NULL`, `claimed_at INTEGER NULL` — set when a human takes over. Any session with
  `claimed_by` set is **sticky** (never auto-reaped by the immediate/idle policies); also gives the
  console a "taken over by X" badge and an audit trail.

## Control flow

1. **Spawn (automation/task)** — `createSession(..., headless=true)` keeps its call sites, but
   `launchClaudeCode` routes `headless` runs into the interactive-unattended lane instead of `-p`. Launch
   env: `UNATTENDED=1` (not `HEADLESS=1`).
2. **Turn ends** — `terminal/stop-hook.sh` (modeled on `notify-hook.sh`) POSTs `/api/turn-idle {session}`
   (session-secret gated). Server → `markTurnIdle(session)`:
   ```
   if unattended && !claimed && !hasClient(tmux) && noPendingQuestionOrApproval(session):
       capturePane → session-<id>.log     # preserve the "what did it do" transcript view
       markEnded(session)                  # clean status → 'done' + episode (parity with -p)
       backend.kill(tmux)                  # pane dies → pile-up guard releases now
   else:
       no-op                               # human is watching, or blocked on an ask → keep alive
   ```
3. **Take over** — `goInteractive` is replaced by `claimSession(id, by)`:
   ```
   UPDATE term_sessions SET headless=0, claimed_by=?, claimed_at=? WHERE id=?
   audit 'session.claimed'   # NO kill, NO relaunch — the live TUI keeps streaming
   ```
   `POST /api/sessions/:id/interactive` calls `claimSession`; the frontend then opens ttyd exactly as
   before. The user lands in the live pane, mid-work, and can type.
4. **Backstop reaper** — `reapIdleResidents` generalizes to `reapIdleSessions`: still reaps resident chats
   on idle-timeout, and additionally reaps any `immediate` session that is idle with **no client
   attached** (covers a missed Stop beacon, or a human who attached then detached without a further turn).
   Same guards: skip if `claimed_by` set, skip if pending question/approval.

## New primitive — attach detection

`SessionBackend.hasClient(space, tmuxName): boolean | null`:
- `LocalSessionBackend`: `tmux -S <sock> list-clients -t <name>` → count > 0.
- `LauncherSessionBackend`: `null` (uid-private socket, unknowable) → server treats `null` as "fall back
  to idle-timeout reaping," matching the launcher's existing liveness limitations.

The takeover race (agent finishes the turn a split-second before the browser attaches) is closed
structurally: `claimSession` sets `claimed_by` **before** ttyd opens, and both `markTurnIdle` and the
reaper honor `claimed_by`, so a claimed session is never reaped regardless of attach timing.

## `claude-launch.sh` changes

- Delete the `HEADLESS` `-p` branch.
- Unattended lane = the resident lane's shape (interactive `claude`, `--dangerously-skip-permissions`,
  seeded with `$TASK`) minus warm-hold semantics. On `UNATTENDED=1`, take the interactive path but use
  `--dangerously-skip-permissions` instead of `--permission-mode`.
- Add `tmux pipe-pane -o` (or `capture-pane` on teardown) so the console transcript view keeps working
  now that there is no `-p` stdout to tee.
- Wire `terminal/stop-hook.sh` into `aos-settings.json` under `hooks.Stop`, beside the `Notification` hook.

## Decisions (settled)

1. **Takeover permission mode** — a claimed session keeps `--dangerously-skip-permissions`; the gate hook
   still governs every effect (the real boundary). No native TUI prompts on takeover; accepted.
2. **Teardown speed** — Stop-hook fast-path + reaper backstop (near-instant guard release, `-p` parity).
3. **Resident chat** — left as-is (its idle-timeout policy is deliberately different); only the `-p`
   automation lane is unified.

## Files

- `terminal/claude-launch.sh` — remove `-p` lane; unified interactive-unattended launch; Stop-hook
  wiring; pane capture.
- `terminal/stop-hook.sh` — **new**, turn-end beacon → `/api/turn-idle`.
- `src/edge/session-backend.ts` — `hasClient()` on both backends.
- `src/terminal.ts` — `launchClaudeCode` routing; `markTurnIdle`; `claimSession` (replaces
  `goInteractive`); `reapIdleResidents` → `reapIdleSessions`; capture-pane on teardown.
- `src/server.ts` — `POST /api/turn-idle`; repoint `/api/sessions/:id/interactive` → `claimSession`.
- `src/state/db.ts` — `claimed_by` / `claimed_at` columns.
- `web/src/App.tsx` — copy/tooltip updates; optional "taken over by X" badge.

## Migration / compat

- Old `-p` sessions in flight at deploy finish under the old in-memory code; new automations go
  interactive after the server restart (server + launcher change → build + restart).
- Resource cost unchanged: an unattended run holds claude + MCP servers only for the run's duration
  (torn down at turn-end), the same window as `-p` — no warm-holding beyond the turn.
