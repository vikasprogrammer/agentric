/**
 * FILE-WRITE GUARD — engine-level governance for where an agent writes.
 *
 * Why this isn't a JSON policy rule: `default@v3` ships **no `file.write` rules at all** and defaults to
 * allow, so today every agent on every tenant can write anywhere the OS lets it. Adding a rule to
 * `config/policy/default.policy.json` would only reach FRESH tenants — a tenant with a persisted policy
 * override (which the live ones have) would silently keep the old, ungated ruleset. So this is applied
 * by the ENGINE and folded in with `stricterDecision`, exactly like host governance and the semantic
 * guard, and therefore reaches every tenant regardless of its stored policy.
 *
 * Two tiers, deliberately different in how they default:
 *
 *   1. CROWN JEWELS → `never`, ALWAYS ON. Writing into `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude`,
 *      `~/.codex`, the workspace DB, or the data home's `connectors/` `control/` `tenants/` dirs is
 *      credential or control-plane tampering. There is no legitimate agent workflow that does it, so
 *      there's nothing to break and nothing to bake — it denies from the moment it ships. (Note the
 *      Claude launcher already blocks READS of these paths via `permissions.deny`; this closes the
 *      write side, which nothing covered.)
 *
 *   2. ANYTHING ELSE OUTSIDE THE AGENT'S OWN FOLDER → `ask`, OFF BY DEFAULT behind a workspace toggle.
 *      This one genuinely can break real work — agents legitimately write to repos they've cloned,
 *      scratch dirs, and each other's outputs — so turning it on fleet-wide unannounced would flood the
 *      Inbox. Same posture as `semanticGuardEnabled`: the fact is always computed and audited, and an
 *      operator flips the gate on once they've seen what it would have caught.
 */
import * as os from 'os';
import * as path from 'path';
import { ApprovalLevel, Decision, riskClassForLevel } from '../types';

const ALLOW: Decision = { effect: 'allow', riskClass: 'green', reason: 'no file-write concern' };

/** Dot-dirs under the SERVICE USER's home that hold credentials or agent-runtime state. */
const SENSITIVE_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.claude', '.codex', '.config/gcloud'];
/** Sub-paths of the DATA HOME that are the OS's own state, never an agent's working material.
 *  `agents/` is deliberately absent — that's where every agent's folder lives. */
const SENSITIVE_DATA_DIRS = ['connectors', 'control', 'tenants', 'secret.key'];

/** Is `target` inside `root` (or the root itself)? Both must already be absolute + resolved. */
function within(root: string, target: string): boolean {
  if (!root) return false;
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The crown-jewel roots a write must never touch. Computed per call rather than at module load so a
 * test (or a second tenant in the same process) gets the right data home.
 */
export function sensitiveWriteRoots(dataHome?: string): string[] {
  const home = os.homedir();
  const roots = SENSITIVE_HOME_DIRS.map((d) => path.join(home, d));
  // `~/.claude.json` is a FILE in the home root (the folder-trust store), not a dir — guard it by name.
  roots.push(path.join(home, '.claude.json'));
  if (dataHome) {
    for (const d of SENSITIVE_DATA_DIRS) roots.push(path.join(dataHome, d));
    // The workspace DB (+ its WAL/SHM sidecars) — matched by prefix, hence no extension here.
    roots.push(path.join(dataHome, 'agent-os.db'));
  }
  return roots;
}

/**
 * Engine-level verdict for a `file.write`. Combined with the policy's own decision via
 * `stricterDecision`, so it can only ever tighten.
 *
 * `writeTargets` is the enricher's list of resolved absolute paths this call writes to (from
 * `file_path`/`notebook_path`, or parsed out of a Codex `apply_patch` envelope). An opaque write — one
 * where we couldn't see a path — is treated as outside the workdir by the enricher and handled by tier
 * 2; we deliberately do NOT deny it, because "we can't tell" is not "it's malicious".
 */
export function fileGovernanceDecision(
  capability: string,
  facts: Record<string, unknown>,
  opts: { dataHome?: string; askOutsideWorkdir: boolean; level?: ApprovalLevel },
): Decision {
  if (capability !== 'file.write') return ALLOW;

  const targets = Array.isArray(facts.writeTargets)
    ? (facts.writeTargets as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  // Tier 1 — crown jewels. Always on. A single offending target taints the whole call: a patch that
  // edits one innocent file and one key store is exactly the shape we're guarding against.
  const roots = sensitiveWriteRoots(opts.dataHome);
  for (const t of targets) {
    const abs = path.resolve(t);
    for (const root of roots) {
      // startsWith covers the `agent-os.db-wal` / `-shm` sidecars; `within` covers the directories.
      if (within(root, abs) || abs.startsWith(root)) {
        return {
          effect: 'deny',
          riskClass: 'deny',
          reason: `writes to a protected path (${path.basename(root)}) — credentials or workspace state`,
        };
      }
    }
  }

  // Tier 2 — anything else outside the agent's own folder. Opt-in.
  if (opts.askOutsideWorkdir && facts.outsideWorkdir === true) {
    const level: ApprovalLevel = opts.level ?? 'head';
    return {
      effect: 'approve',
      level,
      riskClass: riskClassForLevel(level),
      reason: 'writes outside the agent\'s own folder',
    };
  }

  return ALLOW;
}
