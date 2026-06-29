/**
 * The ENRICHER — turns a raw tool call into the *facts* the policy rules read.
 *
 * Governance principle 3 (docs/governance-model.md): split the classifier from the policy. Policy is
 * declarative data ("amountUsd > $cap → never"); deciding *what an action really is* — parsing
 * destructive SQL, telling a bulk delete from a single one, finding the dollar amount — is code, and
 * it must be case-insensitive and look INSIDE arguments. That code lives here, server-side and
 * unit-tested (scripts/governance-conformance.cjs), NOT smeared across the bash gate-hook.
 *
 * The gate-hook is now dumb transport: it sends `{ tool, input }` (the raw Claude tool name + full
 * tool_input) and `enrichArgs` computes the booleans/numbers the JSON ruleset matches on:
 *   - destructive  → irreversible op (the never tier denies it): drop/truncate db, DELETE without
 *                    WHERE, rm -rf, mkfs, dd, terraform destroy, kubectl delete, force-push; and by
 *                    name a connector delete_site / drop_*.
 *   - risky        → a mutation that needs approval (create/send/update/delete/pay/… verbs, or a
 *                    shell command touching stripe/deploy/prod/…).
 *   - amountUsd    → a USD figure pulled from the call (for the money cap).
 *   - deleteCount  → how many items a delete affects (for the bulk-delete cap).
 *
 * Detection is deliberately CONSERVATIVE on the numeric facts: we'd rather miss a fact (and fall back
 * to the risky→approval path) than fabricate one and deny legitimate work. Caller-supplied facts win
 * if already truthy, so a structured caller (a test, the policy_check tool) can assert them directly.
 *
 * Known limit (documented): we still can't see what we're not given. If a tool hides destructive
 * intent behind opaque/encoded arguments, only the executing layer truly knows — defense in depth
 * (least privilege, recoverability) remains the backstop, not this one function.
 */
import { ApprovalLevel, Role, canApprove } from '../types';

const DESTRUCTIVE: RegExp[] = [
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, // DELETE FROM ... with no WHERE → whole-table wipe
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brm\s+-r\b/i, // rm -rf / -fr / -r
  /\bmkfs\b/i,
  /\bdd\s+(if|of)=/i,
  /\bterraform\s+destroy\b/i,
  /\bkubectl\s+delete\b/i,
  /\bgit\s+push\s+(--force|-f)\b/i,
];
const DESTRUCTIVE_TOOL = /delete_site|drop_database|drop_table|drop_schema/i;
const MUTATION_TOOL = /create|send|update|delete|remove|write|post|put|patch|merge|publish|upload|deploy|pay|refund|archive|invite|execute/i;
const RISKY_SHELL = /\b(stripe|refund|deploy|prod|drop|delete|kubectl|systemctl|shutdown)\b/i;
const AMOUNT_KEY = /amount.*usd|usd.*amount|amountusd|amount_usd/i;
const PAYMENT_TOOL = /refund|payment|charge|payout|\bpay\b/i;
const PAYMENT_AMOUNT_KEY = /^(amount|total|amount_cents|amountcents)$/i;
const DELETE_VERB = /delete|remove|purge|destroy|truncate|drop/i;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Flatten a tool_input one level (plus array element scalars) into a text blob + the raw entries. */
function scan(input: unknown): { text: string; entries: [string, unknown][] } {
  if (!input || typeof input !== 'object') return { text: typeof input === 'string' ? input : '', entries: [] };
  const entries = Object.entries(input as Record<string, unknown>);
  const parts: string[] = [];
  for (const [, v] of entries) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
    else if (v != null && typeof v !== 'object') parts.push(String(v));
  }
  return { text: parts.join(' \n '), entries };
}

/**
 * Compute governance facts and return a NEW args object (original + facts). Pure; no I/O.
 * `args` is what the gate received: `{ tool?, input?, command?, ...callerFacts }`.
 */
export function enrichArgs(capability: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = typeof args.tool === 'string' ? args.tool : '';
  const input = (args.input && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
  // Text to pattern-match: an explicit shell command (Bash) and/or the connector input's string values.
  const command = typeof args.command === 'string' ? args.command : typeof input.command === 'string' ? input.command : '';
  const { text: inputText, entries } = scan(input);
  const haystack = `${command}\n${inputText}`;

  let destructive = args.destructive === true;
  if (!destructive) {
    destructive = DESTRUCTIVE.some((re) => re.test(haystack)) || (!!tool && DESTRUCTIVE_TOOL.test(tool));
  }

  let risky = args.risky === true || destructive;
  if (!risky) {
    if (capability === 'shell.exec') risky = RISKY_SHELL.test(haystack);
    else if (capability.startsWith('connector')) risky = !!tool && MUTATION_TOOL.test(tool);
  }

  // amountUsd: explicit fact → a *_usd key → for a payment tool, a bare amount/total (treated as USD).
  let amountUsd = num(args.amountUsd);
  if (amountUsd === undefined) {
    for (const [k, v] of entries) {
      if (AMOUNT_KEY.test(k) && num(v) !== undefined) { amountUsd = num(v); break; }
    }
  }
  if (amountUsd === undefined && tool && PAYMENT_TOOL.test(tool)) {
    for (const [k, v] of entries) {
      if (PAYMENT_AMOUNT_KEY.test(k) && num(v) !== undefined) { amountUsd = num(v); break; }
    }
  }

  // deleteCount: explicit fact → for a delete-ish call, the longest array's length (e.g. ids: [...]),
  // else a numeric count/limit field.
  let deleteCount = num(args.deleteCount);
  if (deleteCount === undefined && (destructive || (!!tool && DELETE_VERB.test(tool)))) {
    let maxArr = -1;
    for (const [, v] of entries) if (Array.isArray(v)) maxArr = Math.max(maxArr, v.length);
    if (maxArr >= 0) deleteCount = maxArr;
    else for (const [k, v] of entries) if (/^(count|limit)$/i.test(k) && num(v) !== undefined) { deleteCount = num(v); break; }
  }

  const facts: Record<string, unknown> = { ...args, destructive, risky };
  if (amountUsd !== undefined) facts.amountUsd = amountUsd;
  if (deleteCount !== undefined) facts.deleteCount = deleteCount;
  return facts;
}

/**
 * The CONTEXT rule for the `ask` tier (governance principle 5). An approval auto-clears — flows without
 * a self-addressed inbox card — only when the run is ATTENDED (a human started it, not an automation)
 * AND that human already holds approval authority for this level. Never applies to the `never` tier
 * (deny is decided before approval) — so this can't auto-clear an irreversible action.
 */
export function autoClearsApproval(level: ApprovalLevel, ctx: { initiatorRole?: Role | null; attended: boolean }): boolean {
  if (!ctx.attended || !ctx.initiatorRole) return false;
  return canApprove(ctx.initiatorRole, level);
}
