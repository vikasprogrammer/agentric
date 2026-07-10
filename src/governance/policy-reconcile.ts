/**
 * Reconcile agent manifests' `policyContext` to the enforced ruleset id.
 *
 * An agent's `policyContext` names the ruleset it expects to be governed by, but the engine enforces a
 * single loaded ruleset (`os.policy.id`) and ignores per-agent context (see {@link
 * ./policy.policyContextMismatch}). When a tenant's enforced id changes, every agent that declared the
 * old id drifts — the #136 warning surfaces it, and THIS reconciles it: rewrite the declared context to
 * the enforced id so the fleet conforms to the one policy actually applied. It never touches the policy
 * document — agents conform to the policy, never the reverse.
 *
 * Pure filesystem so a CLI can run it over SSH with no server. Rewrites are a JSON round-trip through the
 * manifest (not string substitution — avoids `@`/regex footguns) and preserve every other field plus the
 * app's `JSON.stringify(…, 2) + '\n'` on-disk format.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ReconcileChange {
  agent: string;
  from: string;
}

export interface ReconcileResult {
  enforced: string;
  /** Agents rewritten to the enforced id (or that WOULD be, when `dryRun`). */
  changed: ReconcileChange[];
  /** Agents whose `policyContext` already equals the enforced id. */
  aligned: string[];
  /** Agents with no `policyContext` to reconcile (nothing to do). */
  skipped: string[];
}

/**
 * Align every `<agentsDir>/<id>/agent.json`'s `policyContext` to `enforcedId`. With `dryRun`, computes
 * the diff without writing. A missing `agentsDir` yields an empty result (no agents installed yet).
 */
export function reconcileTenant(
  agentsDir: string,
  enforcedId: string,
  opts: { dryRun?: boolean } = {},
): ReconcileResult {
  const changed: ReconcileChange[] = [];
  const aligned: string[] = [];
  const skipped: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return { enforced: enforcedId, changed, aligned, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(agentsDir, entry.name, 'agent.json');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // no/invalid manifest — not an installed agent
    }
    const id = typeof manifest.id === 'string' ? manifest.id : entry.name;
    const current = manifest.policyContext;
    if (typeof current !== 'string' || current === '') {
      skipped.push(id);
      continue;
    }
    if (current === enforcedId) {
      aligned.push(id);
      continue;
    }
    changed.push({ agent: id, from: current });
    if (!opts.dryRun) {
      manifest.policyContext = enforcedId;
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    }
  }

  return { enforced: enforcedId, changed, aligned, skipped };
}
