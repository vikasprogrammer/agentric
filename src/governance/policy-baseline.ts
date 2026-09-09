/**
 * Baseline drift — what a tenant's persisted ruleset has silently STOPPED sharing with the product's
 * bundled default.
 *
 * ## The gap this closes
 *
 * `<home>/policy/default.policy.json` is a full SNAPSHOT. The moment a tenant has one — every workspace
 * whose owner ever hit Save in the console Policy editor — it stops tracking `config/policy/default.policy.json`
 * forever, in BOTH directions:
 *
 *   - a guardrail the product ADDS never arrives (the 2026-07-10 host-governance dogfood: "Govern host
 *     access" was ON and an ungranted `ssh` was still ALLOWED, because the live tenant ran a `default@v2`
 *     that predated the rules);
 *   - a rule the product RETIRES never leaves — and that one has now cost real money three times. The
 *     blunt `shell.exec` + `risky` → ask-owner rule was dropped from the bundled default in **v0.17.0**
 *     (`578d047`) because it fires on any command merely MENTIONING deploy/prod/drop/delete — ordinary
 *     English in a commit message or a changelog. It kept firing on instawp (~70 approvals/14d, cleared
 *     by hand 2026-07-27), on instapods (15 in 30d, **11/11 approved** — zero signal, cleared by hand
 *     2026-09-07) and, at the time of writing, still fires on expresstech.
 *
 * Nobody found any of those from the product: each took a human auditing the approvals table by hand,
 * months late. That invisibility — not the rule itself — is the defect this module fixes.
 *
 * ## Why detection, and not an automatic rewrite
 *
 * The ADD direction is already solved and deliberately NOT solved here: a new guardrail belongs in the
 * ENGINE, combined most-restrictive via `stricterDecision`, the way `hostGovernanceDecision`,
 * `fileGovernanceDecision` and `injectionDecision` are — that reaches every tenant regardless of its
 * document. `missing` below is therefore a REPORT, never an action: it is the falsifier that says "this
 * baseline rule is not reaching this tenant, and no engine-level guard covers it".
 *
 * The RETIRE direction cannot use `stricterDecision` at all — by construction that only ever tightens.
 * It is also the direction where an automatic rewrite would be genuinely dangerous, because it LOOSENS
 * governance on a live tenant with no human in the loop. The fleet says so plainly: the identical stale
 * rule is pure noise on instapods (11/11 approved, 0 rejected) and a guardrail somebody is actually
 * USING on expresstech (26 in 60d — 7 approved, **5 rejected**, 14 cancelled). Same rule, same text,
 * opposite verdicts. So a retired rule is surfaced with its evidence and dropped only when an OWNER
 * clicks, through the same `applyPolicyDocument` path as any edit — snapshotted to `policy_revisions`,
 * hot-reloaded, audited, one-click revertable.
 *
 * ## The safety property
 *
 * A rule counts as retired only when it is **deep-equal** to the signature as the product shipped it.
 * An owner who edited that rule — retargeted the approver, narrowed the `when` — no longer matches, so
 * it is classified as tenant-authored and never offered for removal. Inherited product text is
 * retirable; a human's intent is not, and the two are told apart by exact match rather than by guessing.
 */
import { PolicyDocument, PolicyRule } from './policy';

/** A rule the product deliberately removed from the bundled default, with the receipt for WHY. */
export interface RetiredRule {
  /** The rule EXACTLY as it shipped. Deep-equality against this is what makes a match safe. */
  rule: PolicyRule;
  /** Version that dropped it from `config/policy/default.policy.json`. */
  since: string;
  /** Why it was dropped — shown verbatim to the owner deciding whether to drop it here too. */
  reason: string;
}

/**
 * The retirement ledger. Append-only, code-reviewed, and pinned by `scripts/policy-baseline-test.cjs`,
 * which fails if any entry is still present in the bundled default (shipping a rule you also declare
 * retired is a contradiction).
 *
 * Adding an entry does NOT remove anything from any tenant — it only makes the stale rule visible, with
 * this `reason` attached, to that tenant's owner.
 */
export const RETIRED_RULES: RetiredRule[] = [
  {
    rule: {
      match: { capability: 'shell.exec', when: { arg: 'risky', op: 'eq', value: true } },
      action: 'ask',
      approver: 'owner',
    },
    since: '0.17.0',
    reason:
      'Fires on any command merely MENTIONING deploy/prod/drop/delete/kubectl/systemctl — ordinary ' +
      'English in a commit message, changelog or PR body, not an executed action. Dropped from the ' +
      'bundled default in v0.17.0. Measured since: 11/11 approved on instapods and ~70 in 14 days on ' +
      'instawp, both pure false positives. The real guardrails are separate rules that remain in force ' +
      '(destructive / over-cap / bulk-delete → never), and shell commands are still classified by the ' +
      'enricher, so dropping this does not un-govern the shell.',
  },
];

/** One rule of a tenant's document, with where it sits (index is the handle for a precise removal). */
export interface DriftRule {
  index: number;
  rule: PolicyRule;
}

/** A retired rule a tenant is still carrying, carrying the ledger's receipt. */
export interface RetiredHit extends DriftRule {
  since: string;
  reason: string;
}

export interface PolicyDrift {
  /** Retired product rules the tenant still enforces. The only actionable half. */
  retired: RetiredHit[];
  /**
   * Bundled-baseline rules this tenant does NOT have. Diagnostic only — never auto-applied, because
   * inserting a rule changes first-match ORDER and a new guardrail belongs in the engine anyway.
   */
  missing: PolicyRule[];
  /** Rules that match neither the baseline nor the ledger: the owner's own. Reported, never touched. */
  tenant: DriftRule[];
  /** True when the tenant tracks the bundle exactly — nothing to show. */
  clean: boolean;
}

/** Order-insensitive structural equality (a rule is small, plain JSON — no cycles, no undefined keys). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/**
 * Classify every rule in `doc` against the product's current `baseline` and the retirement ledger.
 *
 * Pure and side-effect free: it reads two documents and returns a report. Nothing here rewrites a
 * tenant's policy — see {@link dropRetiredRules} for the (owner-triggered) producer.
 */
export function baselineDrift(
  doc: PolicyDocument,
  baseline: PolicyDocument,
  ledger: RetiredRule[] = RETIRED_RULES,
): PolicyDrift {
  const retired: RetiredHit[] = [];
  const tenant: DriftRule[] = [];

  doc.rules.forEach((rule, index) => {
    if (baseline.rules.some((b) => same(b, rule))) return;          // still shipping — in step
    const hit = ledger.find((r) => same(r.rule, rule));
    if (hit) retired.push({ index, rule, since: hit.since, reason: hit.reason });
    else tenant.push({ index, rule });                              // the owner's own, or a pre-ledger edit
  });

  const missing = baseline.rules.filter((b) => !doc.rules.some((r) => same(r, b)));
  return { retired, missing, tenant, clean: retired.length === 0 && missing.length === 0 };
}

/**
 * The producer behind the owner's click: `doc` minus the rules at `indices`.
 *
 * Removal only — it can never introduce a rule, reorder the survivors, or touch `default`, so the
 * result is exactly the input document with some rules deleted. Indices that are out of range or not
 * currently retired are IGNORED rather than trusted: the caller passes indices from a report that may
 * be seconds stale, and deleting rule 3 because the document changed underneath would be the same
 * clobber class as a stale-read prompt edit. Returns the new document plus what it actually dropped.
 */
export function dropRetiredRules(
  doc: PolicyDocument,
  indices: number[],
  baseline: PolicyDocument,
  ledger: RetiredRule[] = RETIRED_RULES,
): { doc: PolicyDocument; dropped: PolicyRule[] } {
  const retirable = new Set(baselineDrift(doc, baseline, ledger).retired.map((r) => r.index));
  const kill = new Set(indices.filter((i) => retirable.has(i)));
  const dropped = doc.rules.filter((_, i) => kill.has(i));
  return { doc: { ...doc, rules: doc.rules.filter((_, i) => !kill.has(i)) }, dropped };
}
