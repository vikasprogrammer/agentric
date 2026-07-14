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

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Agent-proposed policy changes (owner-approved). An agent can PROPOSE a constrained, typed change to
// the ruleset via the `policy_propose` MCP tool; only an owner applies it. The whole safety story is that
// a proposal may only ever TIGHTEN — never loosen an existing guardrail, never touch a hard-deny, never
// change the default. `applyProposal` produces the candidate document and refuses anything that isn't a
// strict tightening, verified two ways: by construction (the three ops are shaped to tighten) AND by an
// exhaustive monotonicity sweep (`firstLoosening`) over the finite arg space the policy can branch on.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The three constrained shapes an agent may propose. `tighten`/`add` carry a new `outcome`; `reorder`
 *  lifts an existing conditional rule above the unconditional allow rules (the stripe-refund fix). */
export type PolicyProposalKind = 'tighten' | 'reorder' | 'add';

export interface PolicyDelta {
  kind: PolicyProposalKind;
  /** Targets the rule to tighten/reorder, or defines the rule to add. Matched by capability (+ when). */
  match: { capability: string; when?: PolicyRule['match']['when'] };
  /** The new outcome — required for `tighten` (must be strictly stricter) and `add` (ask|never only). */
  outcome?: PolicyOutcome;
}

/** Strictness order for an outcome: allow(0) < ask:admin(1) < ask:owner(2) < never(3). Higher = stricter. */
function outcomeRank(o: PolicyOutcome): number {
  if (o.action === 'allow') return 0;
  if (o.action === 'never') return 3;
  return o.approver === 'owner' ? 2 : 1; // ask
}

/** Strictness order for a live Decision (same scale as {@link outcomeRank}). */
function decisionRank(d: Decision): number {
  if (d.effect === 'allow') return 0;
  if (d.effect === 'deny') return 3;
  // approve
  return d.level === 'owner' ? 2 : 1;
}

/** Find the index of the rule matching a delta's target (exact capability + when equality), or -1. */
function findRuleIndex(doc: PolicyDocument, match: PolicyDelta['match']): number {
  const cap = match.capability.trim();
  const wantWhen = JSON.stringify(match.when ?? null);
  return doc.rules.findIndex((r) => r.match.capability === cap && JSON.stringify(r.match.when ?? null) === wantWhen);
}

/** Index of the first UNCONDITIONAL `allow` rule (no `when`), or -1. */
function firstUnconditionalAllowIndex(doc: PolicyDocument): number {
  return doc.rules.findIndex((r) => r.action === 'allow' && !r.match.when);
}

/** Normalise a rule so an `approver` is present iff the action is `ask` (keeps the doc well-formed). */
function withApprover(rule: PolicyRule, outcome: PolicyOutcome): PolicyRule {
  const next: PolicyRule = { ...rule, action: outcome.action };
  if (outcome.action === 'ask') next.approver = outcome.approver;
  else delete next.approver;
  return next;
}

/** Every UNCONDITIONAL `never` (red-line deny) present in `before` is still present in `after`. A proposal
 *  that removed or weakened a hard-deny fails this — the `firstLoosening` sweep catches shadowing on top. */
function hardDeniesPreserved(before: PolicyDocument, after: PolicyDocument): boolean {
  return before.rules
    .filter((r) => r.action === 'never' && !r.match.when)
    .every((r) => after.rules.some((a) => a.action === 'never' && !a.match.when && a.match.capability === r.match.capability));
}

/** A synthetic capability id that matches ONLY `*` rules (used to exercise the wildcard guardrails). */
const WILDCARD_PROBE = 'aos.__wildcard_probe__';

/** Concrete capability ids to test: every literal (glob-free) capability named in either doc, plus a
 *  wildcard probe for the `*` rules. This is the full set of ids whose classification the rules can key on. */
function sampleCapabilities(before: PolicyDocument, after: PolicyDocument): string[] {
  const caps = new Set<string>([WILDCARD_PROBE]);
  for (const doc of [before, after]) {
    for (const r of doc.rules) {
      const c = r.match.capability.trim();
      if (c && c !== '*' && !c.includes('*')) caps.add(c);
    }
  }
  return [...caps];
}

/** For each `when.arg` the rules branch on, the set of values worth testing. Booleans → {true,false};
 *  a numeric/threshold comparison → boundary values around the resolved cap. This is exhaustive because
 *  `classify` reads ONLY args named in a `when` clause — nothing else can change an outcome. */
function sampleArgDomains(before: PolicyDocument, after: PolicyDocument, thresholds: Record<string, number>): Map<string, Array<unknown>> {
  const domains = new Map<string, Set<unknown>>();
  const add = (arg: string, v: unknown) => { (domains.get(arg) ?? domains.set(arg, new Set()).get(arg)!).add(v); };
  for (const doc of [before, after]) {
    for (const r of doc.rules) {
      const w = r.match.when;
      if (!w) continue;
      // Always cover the boolean truth table for the flag.
      add(w.arg, true); add(w.arg, false);
      // For a numeric/threshold comparison, cover the boundary either side of the cap.
      if (['gt', 'gte', 'lt', 'lte'].includes(w.op)) {
        const resolved = resolveValue(w.value, thresholds);
        const n = typeof resolved === 'number' ? resolved : Number(resolved);
        if (Number.isFinite(n)) { add(w.arg, n - 1); add(w.arg, n); add(w.arg, n + 1); add(w.arg, 0); }
      } else if (typeof w.value !== 'boolean') {
        add(w.arg, w.value); // an eq/ne against a concrete string/number
      }
    }
  }
  const out = new Map<string, unknown[]>();
  for (const [k, v] of domains) out.set(k, [...v]);
  return out;
}

const MAX_SWEEP_COMBOS = 50_000;

/**
 * The authoritative safety gate: return a human description of the FIRST attempt whose classification
 * gets LOOSER (strictly less strict) from `before` to `after`, or null if the change only ever tightens.
 * Sweeps the cartesian product of every branch-arg's tested values across every candidate capability —
 * exhaustive over the arg space the ruleset can key on, so a `null` result is a real monotonicity proof
 * (up to that space). Falls back to a per-arg-independent sweep for the rare huge product.
 */
function firstLoosening(before: PolicyDocument, after: PolicyDocument, thresholds: Record<string, number>): string | null {
  const eB = new JsonPolicyEngine(before); eB.setThresholds(() => thresholds);
  const eA = new JsonPolicyEngine(after); eA.setThresholds(() => thresholds);
  const caps = sampleCapabilities(before, after);
  const domains = [...sampleArgDomains(before, after, thresholds).entries()];
  const ctx = {} as RunContext;
  const check = (cap: string, args: Record<string, unknown>): string | null => {
    const d1 = eB.classify({ capabilityId: cap, args } as ActionAttempt, ctx);
    const d2 = eA.classify({ capabilityId: cap, args } as ActionAttempt, ctx);
    return decisionRank(d2) < decisionRank(d1)
      ? `${cap} ${JSON.stringify(args)}: ${d1.effect}${d1.effect === 'approve' ? ':' + d1.level : ''} → ${d2.effect}${d2.effect === 'approve' ? ':' + d2.level : ''}`
      : null;
  };
  const combos = caps.length * domains.reduce((n, [, vals]) => n * vals.length, 1);
  if (combos <= MAX_SWEEP_COMBOS) {
    for (const cap of caps) {
      // Enumerate the cartesian product of all branch args.
      const total = domains.reduce((n, [, vals]) => n * vals.length, 1);
      for (let i = 0; i < total; i++) {
        const args: Record<string, unknown> = {};
        let idx = i;
        for (const [arg, vals] of domains) { args[arg] = vals[idx % vals.length]; idx = Math.floor(idx / vals.length); }
        const hit = check(cap, args); if (hit) return hit;
      }
    }
    return null;
  }
  // Fallback (rare): vary each arg independently against an all-false/zero baseline.
  for (const cap of caps) {
    const base: Record<string, unknown> = {};
    for (const [arg] of domains) base[arg] = false;
    const hit0 = check(cap, base); if (hit0) return hit0;
    for (const [arg, vals] of domains) for (const v of vals) { const hit = check(cap, { ...base, [arg]: v }); if (hit) return hit; }
  }
  return null;
}

/**
 * Produce the candidate document for a proposed policy change, or an error. TIGHTEN-ONLY: refuses any
 * delta that loosens a guardrail, removes/weakens a hard-deny, or changes the default. Callers persist +
 * hot-reload the returned doc (owner-only) and surface `error` to the requester.
 *   - tighten: same match, strictly stricter outcome (allow→ask, ask→never, admin→owner, …).
 *   - reorder: lift an existing CONDITIONAL rule up to just before the unconditional allow rules, without
 *              crossing above any never/ask (the exact shape of the stripe-refund ordering fix).
 *   - add:     insert a NEW ask|never guardrail (never allow). A never goes on top; an ask goes below the
 *              stricter rules; the monotonicity sweep is the backstop that guarantees no loosening.
 */
export function applyProposal(
  doc: PolicyDocument,
  delta: PolicyDelta,
  thresholds: Record<string, number> = {},
): { doc: PolicyDocument } | { error: string } {
  let next: PolicyDocument;
  if (delta.kind === 'tighten') {
    if (!delta.outcome) return { error: 'tighten needs a new (stricter) outcome' };
    const outErr = validateOutcome(delta.outcome, 'outcome');
    if (outErr) return { error: outErr };
    const idx = findRuleIndex(doc, delta.match);
    if (idx < 0) return { error: 'no rule matches that capability/condition to tighten' };
    const cur = doc.rules[idx];
    if (cur.action === 'never') return { error: 'that rule is already a hard deny (never) — nothing stricter to tighten to' };
    if (outcomeRank(delta.outcome) <= outcomeRank(cur)) {
      return { error: 'the new outcome must be STRICTER than the current one (allow < ask:admin < ask:owner < never)' };
    }
    next = { ...doc, rules: doc.rules.map((r, i) => (i === idx ? withApprover(r, delta.outcome!) : r)) };
  } else if (delta.kind === 'reorder') {
    const idx = findRuleIndex(doc, delta.match);
    if (idx < 0) return { error: 'no rule matches that capability/condition to reorder' };
    if (!doc.rules[idx].match.when) return { error: 'only a conditional (when-carrying) rule can be reordered up — it targets specific attempts, so lifting it above the unconditional allows is a tightening' };
    const target = firstUnconditionalAllowIndex(doc);
    if (target < 0 || target >= idx) return { error: 'this rule already sits above the unconditional allow rules — nothing to reorder' };
    for (let i = target; i < idx; i++) {
      const r = doc.rules[i];
      if (!(r.action === 'allow' && !r.match.when)) {
        return { error: 'refusing to reorder: it would lift the rule above a non-allow rule (a never/ask), which could weaken a stricter guardrail. Only reordering above unconditional allow rules is allowed.' };
      }
    }
    const rules = [...doc.rules];
    const [moved] = rules.splice(idx, 1);
    rules.splice(target, 0, moved);
    next = { ...doc, rules };
  } else {
    // add
    if (!delta.outcome) return { error: 'add needs an outcome (ask or never)' };
    if (delta.outcome.action === 'allow') return { error: 'a proposal cannot add an allow rule (that loosens) — only a new ask or never guardrail. Ask an owner to add an allow directly.' };
    const outErr = validateOutcome(delta.outcome, 'outcome');
    if (outErr) return { error: outErr };
    const cap = delta.match.capability.trim();
    if (!cap) return { error: 'a capability is required' };
    const rule = withApprover({ match: { capability: cap, ...(delta.match.when ? { when: delta.match.when } : {}) }, action: delta.outcome.action }, delta.outcome);
    const dupe = doc.rules.some((r) => JSON.stringify(r) === JSON.stringify(rule));
    if (dupe) return { error: 'an identical rule already exists' };
    // Placement: a never can sit at the top; an ask goes just after the last never so it can't shadow one.
    let insertAt = 0;
    if (rule.action === 'ask') doc.rules.forEach((r, i) => { if (r.action === 'never') insertAt = i + 1; });
    next = { ...doc, rules: [...doc.rules.slice(0, insertAt), rule, ...doc.rules.slice(insertAt)] };
  }

  // ── common guardrails (apply to every kind) ──
  const vErr = validatePolicyDocument(next);
  if (vErr) return { error: `the change would produce an invalid policy: ${vErr}` };
  if (JSON.stringify(next.default) !== JSON.stringify(doc.default)) return { error: 'a proposal cannot change the default outcome' };
  if (!hardDeniesPreserved(doc, next)) return { error: 'a proposal cannot remove or weaken a hard-deny (never) rule' };
  const loosened = firstLoosening(doc, next, thresholds);
  if (loosened) return { error: `refused: this change would LOOSEN an existing guardrail (${loosened}). Proposals may only tighten — ask an owner to make this change directly.` };
  return { doc: next };
}

/** A compact, human-readable before→after summary of what a delta ACTUALLY changes — shown on the
 *  owner's approval card. Sweeps the candidate against the current doc and reports the first attempt whose
 *  classification tightens (preferring a concrete capability over the wildcard probe), so a reorder that
 *  only bites on the `shell.exec` path is described as "shell.exec …: allow → ask", not a no-op. Returns a
 *  "no effective change" note if nothing moves. */
export function describeProposal(doc: PolicyDocument, delta: PolicyDelta, thresholds: Record<string, number> = {}): { preview: string } | { error: string } {
  const res = applyProposal(doc, delta, thresholds);
  if ('error' in res) return { error: res.error };
  const eB = new JsonPolicyEngine(doc); eB.setThresholds(() => thresholds);
  const eA = new JsonPolicyEngine(res.doc); eA.setThresholds(() => thresholds);
  const fmt = (d: Decision) => (d.effect === 'approve' ? `ask ${d.level === 'owner' ? 'owner' : 'admin'}` : d.effect === 'deny' ? 'never' : 'allow');
  // Concrete capabilities first, then the wildcard probe — so we name a real action when one changed.
  const caps = sampleCapabilities(doc, res.doc).sort((a, b) => (a === WILDCARD_PROBE ? 1 : 0) - (b === WILDCARD_PROBE ? 1 : 0));
  const domains = [...sampleArgDomains(doc, res.doc, thresholds).entries()];
  const total = domains.reduce((n, [, vals]) => n * vals.length, 1);
  for (const cap of caps) {
    for (let i = 0; i < total && i < MAX_SWEEP_COMBOS; i++) {
      const args: Record<string, unknown> = {}; let idx = i;
      for (const [arg, vals] of domains) { args[arg] = vals[idx % vals.length]; idx = Math.floor(idx / vals.length); }
      const before = eB.classify({ capabilityId: cap, args } as ActionAttempt, {} as RunContext);
      const after = eA.classify({ capabilityId: cap, args } as ActionAttempt, {} as RunContext);
      if (decisionRank(after) > decisionRank(before)) {
        // Minimise: drop any flag whose default value preserves the same before→after change, so the
        // preview names only the condition that actually causes it (not incidental co-set flags).
        const min = { ...args };
        for (const k of Object.keys(min)) {
          if (min[k] === false || min[k] === 0) continue;
          const trial = { ...min, [k]: typeof min[k] === 'number' ? 0 : false };
          const b2 = eB.classify({ capabilityId: cap, args: trial } as ActionAttempt, {} as RunContext);
          const a2 = eA.classify({ capabilityId: cap, args: trial } as ActionAttempt, {} as RunContext);
          if (decisionRank(b2) === decisionRank(before) && decisionRank(a2) === decisionRank(after)) min[k] = trial[k];
        }
        const flags = Object.entries(min).filter(([, v]) => v !== false && v !== 0).map(([k, v]) => (v === true ? k : `${k}=${v}`));
        const label = (cap === WILDCARD_PROBE ? 'any action' : cap) + (flags.length ? ` when ${flags.join(', ')}` : '');
        return { preview: `${label}: ${fmt(before)} → ${fmt(after)}` };
      }
    }
  }
  return { preview: 'no effective change to any current outcome (the rule is already covered)' };
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
