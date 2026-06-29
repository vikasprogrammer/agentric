/**
 * Policy — the rule engine. Policy is DATA (a JSON ruleset); the engine is generic.
 * It classifies an action attempt as green/yellow/red/deny and maps that to a Decision.
 *
 * Policy decides. It does not record (that's Audit) and does not run the approval
 * workflow (that's Approvals).
 */
import { ActionAttempt, Decision, PolicyEngine, RiskClass, RunContext } from '../types';

type Op = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';

interface PolicyRule {
  match: { capability: string; when?: { arg: string; op: Op; value: number | string | boolean } };
  risk: RiskClass;
}

export interface PolicyDocument {
  id: string;
  description?: string;
  defaultRisk: RiskClass;
  approvalRouting: { yellow: 'head' | 'owner'; red: 'head' | 'owner' };
  rules: PolicyRule[];
}

const RISKS: RiskClass[] = ['green', 'yellow', 'red', 'deny'];
const LEVELS = ['head', 'owner'];
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'];

/**
 * Validate an untrusted policy document (e.g. from the console editor) before it's persisted and
 * loaded into the engine. Returns an error message, or null if the document is well-formed.
 */
export function validatePolicyDocument(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return 'policy must be an object';
  const d = doc as Partial<PolicyDocument>;
  if (!d.id || typeof d.id !== 'string') return 'id (string) is required';
  if (!RISKS.includes(d.defaultRisk as RiskClass)) return 'defaultRisk must be one of green|yellow|red|deny';
  if (!d.approvalRouting || !LEVELS.includes(d.approvalRouting.yellow) || !LEVELS.includes(d.approvalRouting.red)) {
    return 'approvalRouting.yellow and .red must each be head|owner';
  }
  if (!Array.isArray(d.rules)) return 'rules must be an array';
  for (let i = 0; i < d.rules.length; i++) {
    const r = d.rules[i] as PolicyRule | undefined;
    if (!r || !r.match || typeof r.match.capability !== 'string' || !r.match.capability.trim()) {
      return `rule ${i + 1}: match.capability (non-empty string) is required`;
    }
    if (!RISKS.includes(r.risk)) return `rule ${i + 1}: risk must be green|yellow|red|deny`;
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

/** Glob where `*` matches any run of characters; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function evalWhen(when: NonNullable<PolicyRule['match']['when']>, args: Record<string, unknown>): boolean {
  const actual = args[when.arg];
  const { op, value } = when;
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
  constructor(doc: PolicyDocument) {
    this.doc = doc;
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
    const rule = this.doc.rules.find((r) => {
      if (!globToRegExp(r.match.capability).test(attempt.capabilityId)) return false;
      if (r.match.when && !evalWhen(r.match.when, attempt.args)) return false;
      return true;
    });
    const risk = rule?.risk ?? this.doc.defaultRisk;
    const why = rule
      ? `matched rule "${rule.match.capability}" → ${risk}`
      : `no rule matched → defaultRisk ${risk}`;

    switch (risk) {
      case 'green':
        return { effect: 'allow' };
      case 'deny':
        return { effect: 'deny', reason: why };
      case 'yellow':
        return { effect: 'approve', level: this.doc.approvalRouting.yellow, reason: why };
      case 'red':
        return { effect: 'approve', level: this.doc.approvalRouting.red, reason: why };
    }
  }
}
