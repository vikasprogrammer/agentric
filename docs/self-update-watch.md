# Self-update watch — the box tells you when it has fallen behind

## The problem this exists for

`src/edge/updater.ts` has been able to answer "is this checkout behind origin?" and to apply an update
(ff-pull → rebuild both bundles → detached restart) for a long time. What it never had was **anyone
asking**. Its only callers were console routes, so the check ran exactly when a human had the console
open — which on a headless remote box is never.

The observable result, repeatedly, across the real fleet: boxes sitting 13+ versions behind for weeks,
with nothing anywhere saying so. A drift you only see when you go looking is a drift you find late.

Two modes close that, and they are deliberately different asks:

| mode | what it does | who it is for |
|---|---|---|
| `off` | nothing | a box someone else deploys on a schedule |
| **`notify`** (default) | periodic check → Inbox card + DM to the owner when behind. Applies nothing. | every box; this is the drift alarm |
| `ask` | additionally raises an **owner approval**; approving it pulls, rebuilds and restarts that box | remote boxes you would otherwise ssh into |

Configured per box in **Settings → System → Software**, owner-only (`POST /api/update/watch`).

## Why unattended apply is NOT a mode here

Applying without a human needs two things this does not yet have:

1. **A soak.** Taking `origin/main`'s HEAD the moment it moves means a bad merge reaches every box at
   once. What a fleet wants is "a commit that has been live on a canary for N hours".
2. **Post-restart verification with rollback.** `applyUpdate` schedules a restart and returns; nothing
   checks the box came back on the new version. A build that crash-loops is respawned into brokenness
   forever by the supervisor. `scripts/make-live.sh` verifies `/health` and prints the rollback — the
   in-process updater does not.

Neither is a prerequisite for `notify` or `ask`, which is why those ship first.

## Governance

Applying an update is a side effect on the world, so `ask` mode routes it through the usual planes:
Policy classifies **`os.update`**, Approvals suspends for a human, Audit records each step. Two
properties are load-bearing:

- **The decision is floored at ask/owner** (`stricterDecision` against a constant `ASK_OWNER`). A
  permissive tenant policy — one whose default is `allow`, which live tenants have — can never turn a
  self-update into something that applies unattended. Policy can only tighten it.
- **A hard `never` on `os.update` disables the apply lane but not the warning.** Knowing you are behind
  is not the same permission as changing the box, so a denying tenant still gets a notification card.

Audit vocabulary: `update.available` · `update.blocked` · `update.requested` · `update.gate.decision` ·
`update.denied` · `update.rejected` · `update.applying` · `update.applied` · `update.failed` ·
`update.notice.retired` · `update.check.failed` · `update.watch.configured`.

## One card per update

Notifications dedupe on the **upstream commit** (`UpdateStatus.head`), not the version string or the
behind-count: `latest` repeats across commits and `behind` changes every time origin moves, so either
would re-card a busy box on every tick. When origin moves on, the previous card is *superseded*
(`cancelled`) rather than left to stack; when the update lands, any open card is retired.

Cards are session-less — a `system:update` sentinel `session_id` with an explicit `approvers`/`owner`
Audience, exactly like a Tasks notification. Visibility comes entirely from the audience.

## The blocked case is a feature, not an error

A dirty tree already blocked `applyUpdate` (correctly — an ff-only pull would fail half-way). What was
missing was anyone being **told**. A box hand-patched months ago silently stops updating and looks
identical to a box that is current.

So a dirty tree gets its own card, naming the files in the way — in `ask` mode too, where there is
nothing to approve. This is a real recurring case: one tenant carried an out-of-tree 41-line patch to
`web/src/Xterm.tsx` across two deploys, re-stashed by hand each time.

## Where it runs

**Box-scoped, not per-tenant.** The git checkout is one thing shared by every runtime in the process, so
N tenants would card N times about one fact. The timer in `startServer` runs it against the **seed
tenant** — whose owner is the person with shell on the box and the only one who can act on it. It ticks
every 15 min and the watcher's own cadence (`everyHours`, default 6) decides whether to do work.

## Known limit — shared checkouts

`applyUpdate` restarts **one** service (`AOS_RESTART_CMD`, else this tenant's launchd label / systemd
unit). Where two tenants share a checkout — the Mac's `agent-os-live` serves both `instapods` and
`personal` — updating from one leaves the other running old code out of the same freshly-built
directory. That is precisely the bug `AOS_LIVE_TARGETS` fixed for `scripts/make-live.sh`.

Set `AOS_RESTART_CMD` to bounce every label on a shared checkout, or keep such boxes on `notify` and
deploy them with `make-live.sh`.

## Falsifier

`scripts/update-watch-test.cjs` (in `npm run test:governance`) stubs the git-facing half and pins the
decisions: one card per head, supersede-not-stack, stale-card retirement, the blocked card naming its
files, owner-level approval driving the apply, rejection applying nothing, a failed apply getting its
own card, built-but-not-restarted getting its own card, the ask/owner floor holding against an `allow`
policy, deny killing apply but not notify, and `off` being silent.


---

# Runtime CLI update watch — the sibling, and why it is stricter

`src/edge/runtime-update-watch.ts` does the same job for the **`claude` CLI every session launches**.
The mechanism was already complete — `checkDepUpdates()` asks the npm registry for `latest`,
`updateNpmDep('claude')` upgrades in place — and, exactly as above, nothing ever asked on a timer. A box
pinned to a months-old runtime reports a green "all dependencies installed" and looks healthy.

Same three modes (`off` / **`notify`**, default, every 12h / `ask`), a **separate** setting, and one
important difference in posture.

## Why it is not the OS watcher pointed at npm

Updating Agentric moves code we wrote and gate with a test suite. Updating the runtime CLI can add
**tools** — and `terminal/gate-hook.sh`'s tool→capability table ends in `*) exit 0`, so a tool it has no
row for is treated as "not a world side effect" and runs ungoverned.

That is not hypothetical. claude **2.1.224** shipped cross-session messaging, whose
`SendMessage`/`ListAgents` reach every session owned by the same OS user on the machine — the whole
fleet, across tenants — with no policy check, no audit, and none of the run-as identity the governed
paths carry. It fell straight through the `*)` arm. `docs/codex-runtime.md` records the same stance from
the other direction: in-pane CLI self-update is switched off because Agentric pins the runtime.

So this watcher is shaped by that:

- **There is no unattended tier, and there should not be one.** The strongest mode is `ask`, floored at
  ask/owner like the OS watcher — an `allow` policy still only asks. An upgrade that can widen the
  ungoverned surface must not land while nobody is looking, however convenient that would be.
- **The approval names the risk in the specific.** The card says which version the gate routing was last
  signed off against and which version you are moving to — turning "assume new channels" into a diff
  someone can actually go and do, over a bounded release range.
- **Approving IS the review.** On approval the landed version is stamped into
  `settings.gateReviewedRuntimeVersion`, so the next card reports what has changed since a human last
  looked instead of repeating a warning everyone learns to scroll past. An owner upgrading by hand from
  Settings → System → Dependencies stamps the same value, so the two paths cannot disagree. A **failed**
  upgrade stamps nothing.
- **It stamps what LANDED, not what was carded.** An upgrade races the registry and can arrive on
  something newer than the card named.

## What an upgrade does to running work

Nothing immediately: a live session already spawned its `claude` and keeps that binary until it ends. The
new CLI applies to the NEXT session — which is also when a newly-added tool would first appear. The cards
say so, because "I upgraded and nothing changed" otherwise reads as a failed upgrade.

## Audit vocabulary

`runtime.update.available` · `runtime.gate.decision` · `runtime.update.requested` ·
`runtime.update.denied` · `runtime.update.rejected` · `runtime.update.applying` ·
`runtime.update.applied` · `runtime.update.failed` · `runtime.notice.retired` · `runtime.check.failed` ·
`runtime.watch.configured` (plus the existing `system.deps.updated` for a manual upgrade).

## Standing follow-up

The honest gap: nothing *checks* the tool surface — a human reads release notes. A real check would diff
the CLI's tool list against the gate hook's routing table and refuse (or flag) an upgrade that introduces
an unrouted tool. There is no stable machine-readable tool list to diff against today, which is why the
signed-off version is a stamp rather than an assertion. If one appears, that is the upgrade path for this
file, and it is the prerequisite for ever having an unattended tier here.

## Falsifier

`scripts/runtime-update-watch-test.cjs` (in `npm run test:governance`): the card naming both versions and
the precedent, dedupe per version, supersede-not-stack, retirement on up-to-date, missing-CLI deferring to
Settings → System, owner-level approval driving the upgrade, the landed-not-carded stamp, a failed upgrade
signing nothing off, the manual route stamping the same value, admin refused / owner allowed / bogus mode
400 / unauthenticated 401 on the routes, the ask/owner floor holding against an `allow` policy, deny
killing the upgrade but not the warning, and `off` silent.
