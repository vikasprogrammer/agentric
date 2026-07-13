# Fleet concurrency cap — plan (too many live sessions)

**Problem.** Every live session holds a tmux pane + a `claude` process (several hundred MB each). Enough
concurrent ones and the box swaps / OOMs. Automations, tasks, chat mentions, thread follow-ups, and
console clicks can all spawn — but only the *scheduler* honours a cap. The event-driven chat paths pour
straight in ungated.

**Decision (chosen):** *Chat admission gate + turn the cap on; humans still pass; queue-and-ack for the
rest.* Minimal scope — no per-agent/tenant fairness or adaptive reaping in this pass (noted as futures).

---

## What already exists (reuse it)

- **Cap + defer-and-retry** — `AOS_MAX_CONCURRENT_SESSIONS` (`automations.ts:267`), enforced only in
  `tick()` (`automations.ts:720-763`): over cap → a cron/`once`/task isn't stamped `lastFiredAt`, so it
  re-fires next tick. Clean backpressure, no queue.
- **Global live count** — `aliveSessionCount()` (`terminal.ts:701`): `status='running'` rows confirmed
  alive in tmux.
- **Per-trigger pile-up guards** — `isAlive(lastSessionId)` on automations/tasks (`automations.ts:424,469`).
- **Reclamation** — headless Stop-hook teardown, resident idle reaper (~30 min), crash sweep.

## The three holes

1. **Cap is off by default** (`0` = unlimited) → nothing protects the box today.
2. **Chat/event spawns bypass the cap.** `fireSlack`/`fireDiscord`/`fireComposio`/`fireWebhook` and the
   `/agent` router `spawnChatAgent` call `fire(..., {guard:false})` — the cap is never consulted (it lives
   in `tick()`, not `fire()`). This is the actual flood path: @mentions + fresh chats fan out unbounded,
   each leaving a resident session for ~30 min.
3. **`aliveSessionCount()` fail-opens.** When the backend can't poll tmux (`aliveNames()===null` — always
   true on the Linux `LauncherSessionBackend`; transient `spawnSync` errors on local) it returns `0`, so
   the cap silently disables under exactly the load it's for.

Note: `continueSlackThread` (`automations.ts:629`) delivers into an existing session (send-keys) or revives
the same row — **no new session**, so it correctly stays ungated. Only *brand-new* spawns queue.

---

## Phase 1 — turn the cap on, correctly  ✅ SHIPPED (v0.143.0)

1. **Default is no longer 0.** Resolve `maxConcurrent` as `env override → Settings runtime default →
   RAM-derived default`. Derived: `Math.max(3, Math.floor(totalMemGB / 1.5))` (2 GB droplet → 3; 32 GB
   Mac Mini → ~21). Adapts per box, env still wins for tuning. Expose it as a **Settings → runtime**
   value alongside the existing runtime defaults so it's tunable from the console without a restart.
2. **Fix the fail-open.** When `aliveNames()` returns `null`, `aliveSessionCount()` should fall back to a
   pure DB count of `status='running'` rows instead of `0`, so the cap engages on launcher backends and
   through transient poll failures. The crash sweep already reaps stale `running` rows, so the DB count is
   a safe proxy. (Keep the count cheap — it runs every tick and per admission check.)

**As shipped:**
- `derivedConcurrencyCap(totalBytes?)` (`automations.ts`, exported) = `max(3, floor(GB/1.5))`.
- `Automations.concurrencyCap()` — the single source of truth resolver (env → Settings → derived);
  `tick()` and `sweepStuckGoals()` now read it (the old `private readonly maxConcurrent` field is gone).
- `Settings.maxConcurrentSessions()` / `setMaxConcurrentSessions()` — operator override (`null` = unset →
  derived; `0` = unlimited; `N>0` = cap), key `max_concurrent_sessions`.
- `TerminalManager.aliveSessionCount()` now falls back to the new `runningSessionCount()` (DB count) when
  `aliveNames()` is null, instead of returning 0.
- `GET/PUT /api/settings/concurrency` (owner/admin; audited `settings.concurrency.updated`) → console
  **Settings → Runtime defaults → Concurrency cap** panel: shows `alive` running / effective cap + source,
  editable unless env-pinned.
- Verified by `scripts/` logic test (derived math, Settings semantics, resolver order, DB fallback).

**Multi-tenant caveat (document, don't fix here):** each tenant runtime has its own `Automations` +
`TerminalManager` + tmux socket, so the cap is **per-tenant**, not per-box. On the shared mac-mini
process, N hot tenants can still oversubscribe. A true box-wide cap needs a shared cross-tenant counter in
`tenant-registry.ts` — listed under Futures.

## Phase 2 — admission gate + chat queue (the core)

**One admission decision.** A small classifier at the spawn boundary:

- **interactive human** (console `POST /api/sessions`) → **always admit**, never queue (someone's waiting;
  few of them). Phase 3 surfaces capacity but doesn't block.
- **chat / webhook / composio** (event-driven, no natural retry) → subject to cap. Under cap → fire now
  (unchanged). Over cap → **enqueue + ack**.
- **cron / `once` / task** → already deferred by `tick()`; leave as-is.

**Durable queue.** New `pending_spawns` table (+ migration in `state/db.ts`) so a restart resumes draining:

| column | note |
|---|---|
| `id`, `tenant`, `enqueued_at` | |
| `agent`, `title`, `task` | the full built prompt (`extra`) |
| `spawned_by` | provenance (`automation:<id>` / `chat:<agent>`) |
| `run_as` | accountable member |
| `headless`, `resident` | lane flags |
| `slack_channel`/`slack_thread`, `discord_channel`/`discord_message` | thread binding for the reply |
| `resume_claude_id` | for self-scheduled follow-ups |
| `source` | `chat` / `webhook` / `composio` (for audit + drain ordering) |

**API surface (in `Automations`):**
- `private admit(): boolean` — `cap<=0 || aliveSessionCount() < cap` (single source of truth; `tick()`
  reuses it too).
- `private enqueueSpawn(row)` — insert; returns queue depth for the ack. Bounded by `MAX_PENDING_SPAWNS`
  (e.g. 50) — over that, reject with "at capacity, try again shortly" rather than grow unbounded.
- Drain in `tick()` (see Phase-2 ordering) — FIFO, up to remaining budget, dropping entries older than
  `PENDING_SPAWN_TTL` (e.g. 15 min) so a queued reply never fires hours later out of context (drop →
  best-effort "took too long, ask again" back to the thread).

**Wire the event paths.** In `fireSlack`/`fireDiscord`/`fireComposio`/`fireWebhook` and `spawnChatAgent`:
replace the direct `fire()`/`createSession()` with `admit() ? fire()/createSession() : enqueueSpawn(...)`.
When enqueued, return an ack string:
- Slack/Discord: fold "🕒 You're in line (~N ahead) — I'll start shortly" into the in-thread ack the socket
  already posts on mention.
- Webhook/composio HTTP: `202 { queued: true, position: N }` instead of `200 { sessionId }`.

**Drain (`tick()` ordering)** — after the existing cron/`once` loop, before `dispatchTasks`, so humans
waiting in chat aren't starved behind the task board:
1. cron / `once` (time-critical) — unchanged
2. **`drainPendingSpawns(remaining)`** — FIFO, TTL-pruned
3. `dispatchTasks(remaining)` — unchanged

All three share the one `cap - running` budget already computed in `tick()`.

**Observability.** Audit `spawn.queued` (on enqueue) and `spawn.drained` (on drain), and extend the
existing `scheduler.deferred` line. Optional: a "N queued" counter on the console header next to the
version.

## Phase 3 — console stays passing but honest

`POST /api/sessions` (`server.ts:1698`) never blocks a human, but returns a `capacity: { alive, cap }`
hint so the UI can show "fleet busy — 11/12 running" and the operator understands why automated work is
lagging. No queue, no new gate.

---

## Interactions / edge cases

- **Resident chat dwell.** A resident Slack session counts against the cap for ~30 min. Cap + idle reaper
  together bound the pool; if a low cap + many warm chats makes everything queue, the RAM-derived default
  is meant to be generous, and both the cap and `chatIdleTimeoutMinutes` are tunable in Settings.
- **Thread follow-ups never queue** — `continueSlackThread` reuses the bound session (no new spawn), so an
  in-flight conversation always flows even at capacity. Only first-message spawns are gated.
- **Restart** — persisted queue resumes draining; boot prunes entries past TTL.

## Futures (out of scope this pass)

- Per-agent / per-tenant sub-caps (fairness — one hot agent can't eat every slot).
- Pressure-aware reaping (shorten resident idle timeout as we approach the cap).
- True **box-wide** cap across tenants (shared counter in `tenant-registry.ts`).

## Test / validation

Per CLAUDE.md (no test runner): `npm run typecheck`; `cd web && npm run build`; an isolated in-process
Node script (`export AGENT_OS_HOME=<scratch>`) that sets a low `AOS_MAX_CONCURRENT_SESSIONS`, drives
`fireSlack` past the cap, and asserts: (1) over-cap calls enqueue + return an ack, (2) `tick()` drains
FIFO as `aliveSessionCount()` drops, (3) TTL/`MAX_PENDING_SPAWNS` bounds hold, (4) interactive
`POST /api/sessions` never queues. Add a governance-suite case if one fits.

## Touch list

- `src/edge/automations.ts` — `maxConcurrent` resolution, `admit()`, `enqueueSpawn`, `drainPendingSpawns`,
  wire `fireSlack`/`fireDiscord`/`fireComposio`/`fireWebhook`/`spawnChatAgent`, `tick()` drain step.
- `src/terminal.ts` — `aliveSessionCount()` DB fallback; a `runningSessionCount()` helper.
- `src/state/db.ts` — `pending_spawns` table + migration.
- `src/governance/settings.ts` — optional `maxConcurrent` runtime default.
- `src/server.ts` — `capacity` hint on `POST /api/sessions`; `202` on queued webhook/composio.
- `src/edge/slack-socket.ts` / `discord-socket.ts` — surface the queued ack in the mention reply.
- `web/src` — capacity indicator (optional).
- `CHANGELOG.md` + version bump on the shipping PR.
</content>
</invoke>
