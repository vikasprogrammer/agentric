# Plan: `agent-os policy reconcile` — align agent `policyContext` to the enforced ruleset

## Problem

An agent manifest's `policyContext` names the ruleset the agent *expects* to be governed by, but the
engine enforces exactly one loaded ruleset (`os.policy.id`) and `classify()` ignores the per-agent
context (per-agent policy *selection* is not implemented). PR #136 made the drift **visible** — a
`console.warn` at registration when an agent's `policyContext` diverges from `os.policy.id`. But the
only way to *clear* that drift today is to hand-edit every agent manifest, per tenant, across every box.

That hand-editing is the actual source of the operational pain we hit:
- A tenant's enforced id changed (`default@v1` → `default@v2` → `default@v3-northwind` → `default@v3`)
  and left N agents mismatched; each fix was a manual `sed` sweep over `agents/*/agent.json`.
- Multi-tenant boxes multiply the work (each tenant home has its own agents and its own enforced id).
- Ad-hoc sweeps are error-prone (e.g. `perl` interpolating an `@v3` id into nothing).

There should be one governed command that reconciles the fleet to the enforced id.

## Command

```
agent-os policy reconcile [--tenant <slug>|--all] [--dry-run] [--yes]
```

- Default (no `--tenant`): operate on the **apex/default tenant** (`AGENT_OS_TENANT` ?? config `tenant`),
  matching how `agent-os tenant` resolves the default.
- `--tenant <slug>`: reconcile one named tenant.
- `--all`: reconcile every tenant in the control plane (`TenantStore.list()`).
- `--dry-run`: print the diff (agent → old → new) and exit 0 without writing. **Default is dry-run**;
  writing requires `--yes` (or an interactive confirm) — policy alignment is a fleet-wide edit.

### Behaviour, per tenant

1. Resolve the enforced id = the tenant's loaded ruleset id (home override
   `<home>/policy/default.policy.json` if present, else the bundled `config/policy/default.policy.json`) —
   read **live**, never hardcoded.
2. For each `<home>/agents/*/agent.json`, if `policyContext` is present and `!== enforced`, rewrite it
   to the enforced id (JSON round-trip via the manifest, not string substitution — avoids the `@`/regex
   footguns and preserves formatting via the existing manifest writer).
3. Leave manifests that already match, and manifests with no `policyContext`, untouched.
4. Emit a summary: `N reconciled, M already-aligned, tenant <slug> @ <enforced-id>`.

### Governance & safety

- **This edits agent manifests, not the policy** — so it is NOT an approval-gated effect; it's the same
  class as `agent-os invite`/`tenant` (a box-side admin action). It does, however, snapshot each changed
  manifest through the existing **agent-revisions** backbone (`src/state/agent-revisions.ts`) so a bad
  reconcile is one `agent_revert` away, and it appends an audit event per tenant:
  `policy.reconciled { tenant, enforced, changed: [{agent, from}] }`.
- **Never touches the policy document or its id.** Reconcile makes the agents match the policy, never the
  reverse — consistent with the guidance that the enforced id is a fixed contract agents conform to.
- **Live-server note:** manifests are read at agent registration, so a reconcile takes effect on the next
  registration/rescan/restart. The command prints that reminder. (A future `--reload` could re-register in
  place, but a restart is the reliable path today.)

## Where it lives

- CLI: a new `reconcile` sub-branch in `tenants()`-style dispatch, or a small `policy(rest)` handler in
  `src/cli.ts` (mirrors `tenant <sub>`). Pure filesystem + `TenantStore`; no server required, so it runs
  over SSH like `tenant remove`.
- Shared core: extract `reconcileTenant(paths, enforcedId): { changed, aligned }` into
  `src/governance/policy-reconcile.ts` (pure, unit-testable) so both the CLI and a future
  `POST /api/admin/policy/reconcile` (superadmin, the live mirror) call the same logic — the same
  CLI/API mirroring pattern as tenant provisioning.

## Console mirror (later)

The #136 warning could surface in the console **Policy** page as a banner: *"5 agents declare a
policyContext that doesn't match the enforced `default@v3` — [Reconcile]"*, wired to the API above. This
turns the passive warning into a one-click fix and is the natural home for the feature once the CLI exists.

## Test

`scripts/test-policy-reconcile.cjs`: build a temp home with a policy id `X` and agents at `X`, `Y`,
and none; assert reconcile rewrites only the `Y` agent to `X`, leaves the others, reports `1 reconciled /
1 aligned / 1 skipped`, and that `--dry-run` writes nothing. Run against `dist/` like the other governance
tests.

## Explicitly out of scope

- Actually *honoring* `policyContext` (selecting among multiple registered rulesets at classify time) —
  that's the larger "per-agent policy selection" feature PR #136 flagged as future work. Reconcile is the
  cheap, correct stopgap: make the declared context true by conforming it to the one enforced ruleset.
