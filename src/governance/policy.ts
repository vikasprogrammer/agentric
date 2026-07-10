/**
 * Policy — the rule engine. Policy is DATA (a JSON ruleset); the engine is generic.
 * It classifies an action attempt directly as allow / ask / never and maps that to a Decision.
 *
 * One vocabulary, three outcomes (what an operator reads in Settings → Governance):
 *   - allow → runs immediately, no human.
 *   - ask   → pauses for a human; `approver` says who may approve (admin or owner).
 *   - never → refused outright, regardless of who approves (irreversible actions). The `never`
 *             rules read the caps in Settings → Governance ($moneyCapUsd / $bulkDeleteCount).
 *
 * Policy decides. It does not record (that's Audit) and does not run the approval
 * workflow (that's Approvals).
 */
import { ActionAttempt, ApprovalLevel, Decision, PolicyEngine, RunContext, riskClassForLevel } from '../types';

type Op = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';
export type PolicyAction = 'allow' | 'ask' | 'never';
export type Approver = 'admin' | 'owner';

/** The decision a rule (or the default) yields. `approver` is required only when action is `ask`. */
interface PolicyOutcome {
  action: PolicyAction;
  approver?: Approver;
}

interface PolicyRule extends PolicyOutcome {
  match: { capability: string; when?: { arg: string; op: Op; value: number | string | boolean } };
}

export interface PolicyDocument {
  id: string;
  description?: string;
  /** Outcome when no rule matches. */
  default: PolicyOutcome;
  rules: PolicyRule[];
}

const ACTIONS: PolicyAction[] = ['allow', 'ask', 'never'];
const APPROVERS: Approver[] = ['admin', 'owner'];
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'];

/** `admin` approves at the internal `head` level; `owner` at `owner`. (See canApprove in types.ts.) */
function toLevel(approver: Approver | undefined): ApprovalLevel {
  return approver === 'owner' ? 'owner' : 'head';
}

const OP_PHRASE: Record<Op, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' };

/**
 * The human `reason` a decision carries — names the rule + the CONDITION that tripped it, so an approver
 * reads *why*, not "matched rule 3". A `when` clause becomes a legible fact ("deleteCount > 25", or just
 * "destructive" for a `== true` boolean); no clause → the bare capability; no rule → the default.
 */
function describeMatch(rule: PolicyRule | undefined, thresholds: Record<string, number>): string {
  if (!rule) return 'default policy (no rule matched)';
  const cap = rule.match.capability === '*' ? 'any action' : rule.match.capability;
  const w = rule.match.when;
  if (!w) return cap;
  const resolved = resolveValue(w.value, thresholds);
  const val = resolved === undefined ? w.value : resolved;
  // A boolean flag reads cleaner as the flag name alone (`destructive`, not `destructive = true`).
  if ((w.op === 'eq' && val === true) || (w.op === 'ne' && val === false)) return `${cap}: ${w.arg}`;
  return `${cap}: ${w.arg} ${OP_PHRASE[w.op]} ${val}`;
}

/** Validate one outcome block (a rule or the document default). Returns an error message, or null. */
function validateOutcome(o: Partial<PolicyOutcome> | undefined, where: string): string | null {
  if (!o || typeof o !== 'object') return `${where}: an outcome (action) is required`;
  if (!ACTIONS.includes(o.action as PolicyAction)) return `${where}: action must be one of allow|ask|never`;
  if (o.action === 'ask' && !APPROVERS.includes(o.approver as Approver)) {
    return `${where}: an "ask" outcome needs approver = admin|owner`;
  }
  return null;
}

/**
 * Validate an untrusted policy document (e.g. from the console editor) before it's persisted and
 * loaded into the engine. Returns an error message, or null if the document is well-formed.
 */
export function validatePolicyDocument(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return 'policy must be an object';
  const d = doc as Partial<PolicyDocument>;
  if (!d.id || typeof d.id !== 'string') return 'id (string) is required';
  const defErr = validateOutcome(d.default, 'default');
  if (defErr) return defErr;
  if (!Array.isArray(d.rules)) return 'rules must be an array';
  for (let i = 0; i < d.rules.length; i++) {
    const r = d.rules[i] as PolicyRule | undefined;
    if (!r || !r.match || typeof r.match.capability !== 'string' || !r.match.capability.trim()) {
      return `rule ${i + 1}: match.capability (non-empty string) is required`;
    }
    const outErr = validateOutcome(r, `rule ${i + 1}`);
    if (outErr) return outErr;
    if (r.match.when) {
      const w = r.match.when;
      if (typeof w.arg !== 'string' || !w.arg.trim()) return `rule ${i + 1}: when.arg (string) is required`;
      if (!OPS.includes(w.op)) return `rule ${i + 1}: when.op must be one of ${OPS.join('|')}`;
      if (w.value === undefined || w.value === null || !['number', 'string', 'boolean'].includes(typeof w.value)) {
        return `rule ${i + 1}: when.value must be a number, string, or boolean`;
      }
    }
  }
  return null;
}

/**
 * The engine enforces exactly ONE loaded ruleset and `classify()` deliberately ignores per-agent
 * `RunContext.policyContext` — so an agent whose manifest `policyContext` names a *different* ruleset is
 * silently NOT governed by the policy it claims (a footgun: relabel the tenant's policy, or point an
 * agent at a ruleset that has none of the red-line rules, and its guardrails vanish with no signal).
 * Returns a human-readable warning when the declared context and the enforced ruleset disagree, or `null`
 * when they match (or nothing is declared). Pure — the kernel calls it from `registerAgent` to surface the
 * drift at load instead of leaving it silent.
 */
export function policyContextMismatch(
  agentId: string,
  declared: string | undefined,
  enforced: string,
): string | null {
  if (!declared || declared === enforced) return null;
  return (
    `[policy] agent "${agentId}" declares policyContext "${declared}" but the enforced ruleset is ` +
    `"${enforced}". Per-agent policy selection is not implemented, so this agent is governed by ` +
    `"${enforced}", NOT "${declared}". Set its policyContext to "${enforced}" (or load the "${declared}" ` +
    `ruleset) to remove this warning.`
  );
}

/** Glob where `*` matches any run of characters; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Does an UNCONDITIONAL `never` rule (no `when`) match `capabilityId`? Such a rule is an absolute deny,
 * and "Always approve" refuses to shadow it. Note that CONDITIONAL nevers (the default policy's
 * `* when destructive` / `* when amountUsd > cap` / `* when deleteCount > cap`) are deliberately NOT
 * hard denies here: they're preserved by inserting the new allow AFTER all never rules (see
 * {@link withAlwaysAllow}), so they still fire for a destructive/over-cap attempt.
 */
export function hasHardDeny(doc: PolicyDocument, capabilityId: string): boolean {
  return doc.rules.some((r) => r.action === 'never' && !r.match.when && globToRegExp(r.match.capability).test(capabilityId));
}

/**
 * The "Always approve" learn step: return a NEW document that allows `capabilityId` from now on.
 *
 * `classify` is first-match, so placement is the whole safety story. We insert the unconditional `allow`
 * rule immediately AFTER the last `never` rule — never before it. That keeps every deny guardrail in
 * force (a destructive or over-cap attempt of this capability still hits its conditional `never`), while
 * the new allow shadows the `ask` rule that raised the card, so the routine case stops prompting. The
 * common policy lists nevers first, then asks, so this shadows exactly the intended `ask` and nothing more.
 * - Refuses (`{ error }`) when an UNCONDITIONAL `never` matches — that's an absolute deny we won't erase.
 * - Idempotent: if an identical allow rule already exists, returns `added: false`.
 * Callers persist + hot-reload the returned doc and surface `added`/`error` to the human.
 */
export function withAlwaysAllow(doc: PolicyDocument, capabilityId: string): { doc: PolicyDocument; added: boolean } | { error: string } {
  const cap = capabilityId.trim();
  if (!cap) return { error: 'no capability to allow' };
  if (hasHardDeny(doc, cap)) return { error: `"${cap}" is hard-denied by a policy rule and can't be allowed from the inbox — edit policy directly if you really mean to` };
  const exists = doc.rules.some((r) => r.action === 'allow' && !r.match.when && r.match.capability === cap);
  if (exists) return { doc, added: false };
  let insertAt = 0;
  doc.rules.forEach((r, i) => { if (r.action === 'never') insertAt = i + 1; });
  const rule: PolicyRule = { match: { capability: cap }, action: 'allow' };
  const rules = [...doc.rules.slice(0, insertAt), rule, ...doc.rules.slice(insertAt)];
  return { doc: { ...doc, rules }, added: true };
}

/**
 * A `when.value` of the form `"$name"` is a reference to a named governance threshold (e.g.
 * `"$moneyCapUsd"`), resolved live from the engine's thresholds provider at classify time. This keeps
 * the numeric caps editable in Settings → Governance without rewriting policy rules. The kernel always
 * wires a provider backed by defaults (500 / 25), so a reference normally resolves; an UNwired engine
 * (e.g. an isolated test) yields `undefined`, in which case the rule simply does not match and the
 * attempt flows on through the remaining rules (mutations still hit their ask/never rule). We
 * deliberately don't treat "unknown cap" as match-and-never, since the same `$ref` mechanism may feed
 * non-never rules; the cap is guaranteed present in the real system.
 */
function resolveValue(value: number | string | boolean, thresholds: Record<string, number>): number | string | boolean | undefined {
  if (typeof value === 'string' && value.startsWith('$')) {
    const resolved = thresholds[value.slice(1)];
    return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : undefined;
  }
  return value;
}

function evalWhen(
  when: NonNullable<PolicyRule['match']['when']>,
  args: Record<string, unknown>,
  thresholds: Record<string, number>,
): boolean {
  const actual = args[when.arg];
  const { op } = when;
  const value = resolveValue(when.value, thresholds);
  if (value === undefined) return false; // unresolved threshold ref → fail closed (no match)
  if (op === 'eq') return actual === value;
  if (op === 'ne') return actual !== value;
  const a = Number(actual);
  const b = Number(value);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b; // 'lte'
}

export class JsonPolicyEngine implements PolicyEngine {
  private doc: PolicyDocument;
  /** Live provider for named numeric thresholds (`$moneyCapUsd`, …). Wired by the kernel after the
   *  AgentOS (and thus its settings store) exists; until then rules referencing thresholds fail closed. */
  private thresholdsProvider: () => Record<string, number> = () => ({});
  constructor(doc: PolicyDocument) {
    this.doc = doc;
  }

  /** Inject the threshold resolver (e.g. `() => os.settings.governanceThresholds()`). */
  setThresholds(fn: () => Record<string, number>): void {
    this.thresholdsProvider = fn;
  }

  /** Ruleset id — read live so a hot reload is reflected everywhere `os.policy.id` is used. */
  get id(): string {
    return this.doc.id;
  }

  /** The current ruleset (for the console editor). */
  get document(): PolicyDocument {
    return this.doc;
  }

  /** Swap the ruleset in place. The gateway + terminal gate hold this same instance, so the new
   *  rules take effect immediately for every subsequent classify — no restart. */
  update(doc: PolicyDocument): void {
    this.doc = doc;
  }

  classify(attempt: ActionAttempt, _ctx: RunContext): Decision {
    const thresholds = this.thresholdsProvider();
    const rule = this.doc.rules.find((r) => {
      if (!globToRegExp(r.match.capability).test(attempt.capabilityId)) return false;
      if (r.match.when && !evalWhen(r.match.when, attempt.args, thresholds)) return false;
      return true;
    });
    const outcome: PolicyOutcome = rule ?? this.doc.default;
    const reason = describeMatch(rule, thresholds);

    switch (outcome.action) {
      case 'allow':
        return { effect: 'allow', riskClass: 'green', reason };
      case 'never':
        return { effect: 'deny', riskClass: 'deny', reason };
      case 'ask': {
        const level = toLevel(outcome.approver);
        return { effect: 'approve', level, riskClass: riskClassForLevel(level), reason };
      }
    }
  }
}
