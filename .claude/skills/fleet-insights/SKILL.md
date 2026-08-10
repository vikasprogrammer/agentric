---
name: fleet-insights
description: Analyze agent sessions across the northwind, globex, and initech tenants to find product-improvement insights and ship the resulting codebase changes as a PR. Use when asked to review fleet/session usage, mine sessions for insights, learn from real usage, or improve agent-os from how the fleet is actually behaving.
license: MIT
---

# fleet-insights

Mine real agent-session usage across all three production tenants, turn the friction into
ranked product insights, then **implement the highest-signal changes and open one PR**. This is a
**maintainer** skill: it runs from this repo checkout, reads the live tenant databases read-only,
and improves the agent-os codebase itself. It is NOT a fleet agent — it sees every tenant and edits
the OS source, which governed in-tenant agents cannot.

Full loop: **collect → analyze → synthesize insights → implement top changes in a worktree → PR.**

## The three tenants (read-only sources)

| Tenant | Host | agent-os.db path | Access |
|---|---|---|---|
| **northwind** | this Mac Mini (local) | `~/agent-os-data/northwind/agent-os.db` | direct |
| **globex** | jump-server droplet | `~/tools/agent-os/data/agent-os.db` | `ssh user@203.0.113.11` |
| **initech** | et droplet | `~/tools/agent-os/data/agent-os.db` | `ssh user@203.0.113.12` |

Remote node (nvm, not on non-login PATH): `/home/agent-os/.nvm/versions/node/v22.22.0/bin/node`.
The tenants run **different agent-os versions**, so the collector is schema-defensive — trust it to
degrade, not to match every column.

> Safety: never write to a live tenant DB. The collector opens read-only and runs SELECT/PRAGMA only.
> Collected bundles and transcripts may contain **customer data** — keep them in the scratchpad,
> never commit them, and reason over aggregates + samples, not by pasting raw customer content into
> code, commits, or PR text.

## Step 1 — Collect

Run `collect.mjs` (in this skill dir) against each tenant into your scratchpad. It emits one JSON
bundle per tenant (aggregates + qualitative samples). Default window is 30 days; widen with a third
arg when a box is quiet.

```bash
SKILL=.claude/skills/fleet-insights
OUT="$SCRATCHPAD"                 # your session scratchpad dir; make it if unset
DAYS=30

# northwind — local
node "$SKILL/collect.mjs" ~/agent-os-data/northwind/agent-os.db northwind $DAYS > "$OUT/northwind.json"

# globex + initech — ship the collector over, run with the box's node, capture JSON
for H in 203.0.113.11:globex 203.0.113.12:initech; do
  IP="${H%%:*}"; T="${H##*:}"
  scp -q "$SKILL/collect.mjs" "vikas@$IP:/tmp/aos-collect.mjs"
  ssh "vikas@$IP" "/home/agent-os/.nvm/versions/node/v22.22.0/bin/node /tmp/aos-collect.mjs ~/tools/agent-os/data/agent-os.db $T $DAYS" > "$OUT/$T.json"
done
```

If a box's node lacks `node:sqlite` readOnly (older node), the collector falls back automatically. If
`ssh` is refused, add your key first (see the deploy notes in memory); do not switch to writing to the DB.

## Step 2 — Read the bundles

Read all three JSON bundles. Each has:

- **`sessions`** — `total`, `byStatus`, `byAgent` (with `crashed`/`stopped`), `provenance`
  (member/automation/task/chat). High `stopped`/`crashed` ratio for an agent = friction.
- **`failedSessions`** / **`recentTasks`** — session `id` + truncated `task`; the roster for deep-dives
  and workflow clustering.
- **`audit`** — `byType` (volume), `sampleByType` (one raw `data` blob per type so you can see the real
  JSON shape for this version), `gateDecisions` (`capability → effect × n`), `friction` (errors, budget
  stops, killswitch, resolved approvals, asks).
- **`approvals`** — `byCapabilityStatus`: capabilities repeatedly routed to humans.
- **`questions`** — `byStatus` (`pending` = **unanswered**, agents left blocked) + samples.
- **`outcomes`** — completion success/partial/failure counts.
- **`topEpisodes`** — highest-importance (= highest friction/effort) end-of-run recaps, with
  `outcome`, `salience`, `sessionId`, and `content`. **The qualitative core.**
- **`topLessons`** — deliberate `report` lessons agents recorded.
- **`memoryHealth`** — `total`, `neverRecalled`, `avgRecall`. All-never-recalled = the self-learning
  loop isn't surfacing.

## Step 3 — Deep-dive the highest-signal sessions

Pick the ~5–10 sessions that dominate the friction (failed/stopped, low outcome, high-importance
episodes with a `failure`/`partial` outcome, or the source of a recurring question). For each, pull
the real transcript and audit trail:

```bash
# transcript (headless runs only) — tail the tail, it can be large
# local:  ~/agent-os-data/northwind/connectors/session-<id>.log
# remote: ssh user@<ip> "tail -c 200000 ~/tools/agent-os/data/connectors/session-<id>.log"
```

Read the episode `content` and `salience` first (cheap, already in the bundle); only open transcripts
when you need the actual failure mechanism. You want the *why*, not a log dump.

## Step 4 — Synthesize insights

Cluster across tenants. For each insight capture: **evidence** (counts + which tenants + sample
session ids), **root-cause hypothesis**, **proposed change** (concrete files/areas), and
**confidence + risk**. Prioritize signals that recur across ≥2 tenants or dominate one.

Map friction to the agent-os surface it implicates:

- **Repeated approvals for one capability** (`file.write → approve ×N`) → a policy default in
  `config/policy` / `src/governance/policy.ts`, or an "always approve" affordance gap.
- **Recurring agent `questions` / many `pending`** → missing context the product should inject
  (`buildCompanyMd`, agent CLAUDE.md, a starter prompt), or a blocking-`ask` UX gap.
- **A capability erroring / denied a lot** → a gate/gateway bug (`src/gateway`), a bad policy rule,
  or a broken MCP tool (`src/memory/memory-mcp.ts`, its `/api/*` handler in `src/server.ts`).
- **Recurring task/prompt clusters** → a first-class feature, an Automation, or a new **global
  skill** (`config/skills/<name>/SKILL.md`) so the fleet stops reinventing it.
- **Crashed/stopped sessions** → launch/terminal robustness (`src/terminal.ts`,
  `terminal/claude-launch.sh` — mind the bash-3.2/BSD macOS gotchas in CLAUDE.md).
- **`memoryHealth` all-never-recalled / never-used tools** → recall relevance, injection, or a
  dead surface to prune. Cross-check `docs/PILLARS.md` maturity before investing.
- **Automation/chat provenance skew, unattended failures** → `src/edge/automations.ts`.

## Step 5 — Implement the top changes and open a PR (full auto)

Ship the changes that are **well-evidenced and low-risk** (recurring, clear root cause, localized).
For large/architectural or uncertain insights, **do not** speculatively rewrite — write them up as a
"Proposed, not implemented" section in the PR body (or an issue) for a human to weigh. Full-auto means
*ship the safe wins and surface the rest*, not *rewrite the kernel on a hunch*.

Follow the repo's standing workflow (see CLAUDE.md + memory) — **never edit the primary checkout**:

1. `scripts/wt.sh new fleet-insights-<yyyy-mm-dd>` — develop in the worktree, not `~/Projects/agent-os`.
2. Make the surgical changes. Match surrounding code; keep `src/core` + kernel importing only `src/types.ts`.
3. Validate: `npm run typecheck` · `cd web && npm run build` · `npm run test:governance` (from repo
   **root**) · `npm run demo` if you touched governance.
4. Bump version (minor for a feature, patch for a fix) + move a CHANGELOG line under a new heading.
5. Commit (with the `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer), push, open **one**
   consolidated PR with `gh ... --repo vikasprogrammer/agentric`, then `gh pr merge --squash`.

Batching several branches? Use `scripts/wt.sh integrate` and one PR, per the shared-checkout rule.

## Step 6 — Report

Print (and save to scratchpad) a ranked insights report: for each insight — evidence, hypothesis,
the change, confidence/risk, and status (**shipped in PR #N** / **proposed**). Lead with the PR link
and a one-line summary of what changed and why. Note anything you deliberately left un-shipped and why.

## Notes

- The gate `data.decision` is a nested object (`{effect, level, riskClass, reason}`); the collector
  already extracts `.effect`. Use `sampleByType` to confirm any other field's shape before querying it.
- northwind also exists as a *seed/nested* tenant on the globex box (`data/tenants/northwind`) — ignore
  it; the real northwind is the local Mac Mini DB.
- Re-run cheaply anytime. This complements the in-tenant Dreaming/consolidation loop (which improves a
  tenant's *shared memory*); this skill improves the *product*.
