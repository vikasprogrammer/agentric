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
  match: { capability: string; when?: { arg: string; op: Op; value: number | string } };
  risk: RiskClass;
}

export interface PolicyDocument {
  id: string;
  description?: string;
  defaultRisk: RiskClass;
  approvalRouting: { yellow: 'head' | 'owner'; red: 'head' | 'owner' };
  rules: PolicyRule[];
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
  readonly id: string;
  constructor(private readonly doc: PolicyDocument) {
    this.id = doc.id;
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
