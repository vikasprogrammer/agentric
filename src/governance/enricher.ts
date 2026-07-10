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
 *   - outsideWorkdir → for a file.write, whether the target path is OUTSIDE the agent's own folder
 *                    (in-folder edits are the agent's own work; writing elsewhere is a real side effect).
 *
 * Detection is deliberately CONSERVATIVE on the numeric facts: we'd rather miss a fact (and fall back
 * to the risky→approval path) than fabricate one and deny legitimate work. Caller-supplied facts win
 * if already truthy, so a structured caller (a test, the policy_check tool) can assert them directly.
 *
 * Known limit (documented): we still can't see what we're not given. If a tool hides destructive
 * intent behind opaque/encoded arguments, only the executing layer truly knows — defense in depth
 * (least privilege, recoverability) remains the backstop, not this one function.
 */
import * as path from 'node:path';
import { ApprovalLevel, EnrichPattern, Role, canApprove } from '../types';
import { computeHostFacts, type HostGrant } from './host-match';

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
// Risky-shell keywords, but NOT when they're part of a hyphenated flag or compound token: the lookarounds
// exclude a leading/trailing `-` so `gh pr merge --delete-branch`, `deploy-preview`, `--prod` don't trip
// (a flag name isn't a destructive verb — #139), while `drop table`, `sudo systemctl restart`, `kubectl
// delete` still match. `\w` in the lookarounds just mirrors the word-boundary these keywords already had.
const RISKY_SHELL = /(?<![-\w])(stripe|refund|deploy|prod|drop|delete|kubectl|systemctl|shutdown)(?![-\w])/i;
const AMOUNT_KEY = /amount.*usd|usd.*amount|amountusd|amount_usd/i;
const PAYMENT_TOOL = /refund|payment|charge|payout|\bpay\b/i;
const PAYMENT_AMOUNT_KEY = /^(amount|total|amount_cents|amountcents)$/i;
const DELETE_VERB = /delete|remove|purge|destroy|truncate|drop/i;
// An outbound email send — Composio Gmail (`GMAIL_SEND_EMAIL`), a gmail connector's `send_email`, etc.
// Matched on the TOOL NAME only (recipient parsing is separate), so `Bash` echoing "send_email" can't trip it.
const EMAIL_SEND_TOOL = /gmail[a-z_]*send|send[a-z_]*e?mail|sendmail/i;
// Recipient-bearing fields on an email tool's input. `from`/`sender` are deliberately excluded.
const EMAIL_TO_KEY = /^(to|cc|bcc|recipient|recipients|recipient_email|to_email|to_recipients)$/i;

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The domain of an email address (lowercased), or '' if it doesn't look like one. */
const emailDomain = (addr: string): string => {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).trim().toLowerCase() : '';
};

/** Pull every recipient address out of an email tool's input (string, comma/space list, or array). */
function extractRecipients(entries: [string, unknown][]): string[] {
  const out: string[] = [];
  const take = (s: string) => {
    for (const tok of s.split(/[,;\s]+/)) {
      const m = tok.match(/[^\s<>,;"']+@[^\s<>,;"']+/); // bare or `Name <a@b>` → the address
      if (m) out.push(m[0].toLowerCase());
    }
  };
  for (const [k, v] of entries) {
    if (!EMAIL_TO_KEY.test(k)) continue;
    if (typeof v === 'string') take(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') take(x);
  }
  return [...new Set(out)];
}

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
 * `orgDomains` are the workspace's internal email domains (lowercased, no `@`) — passed in by the
 * caller (no I/O here) so an email send can be judged internal (own domain) vs external.
 */
export function enrichArgs(
  capability: string,
  args: Record<string, unknown>,
  orgDomains: string[] = [],
  workdir?: string,
  patterns: EnrichPattern[] = [],
  hostGrants?: HostGrant[] | null,
): Record<string, unknown> {
  const tool = typeof args.tool === 'string' ? args.tool : '';
  const input = (args.input && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
  // Text to pattern-match: an explicit shell command (Bash) and/or the connector input's string values.
  const command = typeof args.command === 'string' ? args.command : typeof input.command === 'string' ? input.command : '';
  const { text: inputText, entries } = scan(input);
  const haystack = `${command}\n${inputText}`;

  // file.write is judged by WHERE it writes (see outsideWorkdir below), never by content: a file whose
  // TEXT happens to contain "DROP TABLE" or "rm -rf" is not a destructive DB/shell op. So skip the
  // content scan for it — otherwise the `*` destructive→never rule would wrongly deny a benign edit.
  const isFileWrite = capability === 'file.write';
  // For a Bash call the effect is the COMMAND itself; the sibling `description` field is a human-written
  // label ("Check deploy status") that must NOT drive classification. Scanning it flagged benign
  // read-only commands (a `gh run list` described as a deploy check) as risky and funneled needless
  // approvals to the owner. So shell.exec classifies on `command` only; connector calls still scan their
  // input VALUES (those ARE the effect) via `haystack`.
  const isShell = capability === 'shell.exec';
  const classifyText = isShell ? command : haystack;

  let destructive = args.destructive === true;
  if (!destructive && !isFileWrite) {
    destructive = DESTRUCTIVE.some((re) => re.test(classifyText)) || (!!tool && DESTRUCTIVE_TOOL.test(tool));
  }

  let risky = args.risky === true || destructive;
  if (!risky && !isFileWrite) {
    if (isShell) risky = RISKY_SHELL.test(command);
    else if (capability.startsWith('connector')) risky = !!tool && MUTATION_TOOL.test(tool);
  }

  // outsideWorkdir: for a file write, is the target OUTSIDE the agent's own working folder? Edits inside
  // the folder are the agent doing its job (allow); writing to ~/.claude, another agent's dir, or system
  // paths is a real side effect (the policy gates it). A caller-supplied boolean wins (tests/policy_check);
  // otherwise we derive it from the path in tool_input vs `workdir`. No path we can see → treat as outside
  // (opaque write needs a human). Left undefined when it's not a file write or no workdir was provided.
  let outsideWorkdir = typeof args.outsideWorkdir === 'boolean' ? (args.outsideWorkdir as boolean) : undefined;
  if (outsideWorkdir === undefined && isFileWrite && workdir) {
    const target = typeof input.file_path === 'string' ? input.file_path
      : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    if (!target) {
      outsideWorkdir = true;
    } else {
      const rel = path.relative(workdir, path.resolve(workdir, target));
      outsideWorkdir = rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
    }
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

  // email.send: an outbound email is its own governed capability (gated by recipient, not just the
  // send verb). Detect it by tool name for connector calls (and when already remapped to email.send),
  // then judge internal vs external against the workspace's own domains. No recipients parsed (opaque
  // args) → treated as EXTERNAL, the safe default (an unknown audience needs the human, not a free pass).
  const emailCapable = capability.startsWith('connector') || capability === 'email.send';
  let emailSend = args.emailSend === true;
  if (!emailSend && emailCapable && !!tool && EMAIL_SEND_TOOL.test(tool)) emailSend = true;
  let emailExternal: boolean | undefined;
  let emailExternalCount: number | undefined;
  let emailRecipients: string[] | undefined;
  if (emailSend) {
    emailRecipients = extractRecipients(entries);
    const org = new Set(orgDomains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
    // emailExternalCount = how many recipients are OUTSIDE the org — the fact the red bulk-external rule
    // reads (blasting many outsiders is the risk; internal fan-out isn't). emailExternal stays a boolean
    // for the yellow tier; unknown recipients (opaque args) count as external there but not as "bulk".
    const externalCount = emailRecipients.filter((a) => !org.has(emailDomain(a))).length;
    emailExternalCount = externalCount;
    emailExternal = args.emailExternal === true || emailRecipients.length === 0 || externalCount > 0;
  }

  // Host egress (Phase 2b): when host governance is ON, the caller passes the agent's granted host
  // matchers (an array, possibly empty; `null`/undefined = feature off). For a shell command we parse
  // the egress target and surface netEgress/host/hostAllowed/hostUnknown/hostPosture so the gate can
  // reclassify shell.exec → net.connect/ssh.exec and the policy can gate on the host. Parsing is
  // best-effort + fail-loud (host-match.ts) — never a firewall.
  let hostFacts: Record<string, unknown> | undefined;
  if (hostGrants && isShell && command) {
    const hf = computeHostFacts(command, hostGrants);
    if (hf.netEgress) hostFacts = hf as unknown as Record<string, unknown>;
  }

  const facts: Record<string, unknown> = { ...args, destructive, risky };
  if (hostFacts) Object.assign(facts, hostFacts);
  if (outsideWorkdir !== undefined) facts.outsideWorkdir = outsideWorkdir;
  if (amountUsd !== undefined) facts.amountUsd = amountUsd;
  if (deleteCount !== undefined) facts.deleteCount = deleteCount;
  if (emailSend) {
    facts.emailSend = true;
    facts.emailExternal = emailExternal;
    facts.emailExternalCount = emailExternalCount;
    if (emailRecipients) facts.emailRecipients = emailRecipients;
  }

  // Workspace-defined custom patterns (Settings → Governance): each sets a boolean fact the policy
  // gates on — the extension point for operator-specific dangerous ops without editing this file.
  // Applied to shell + connector calls only (never file.write, whose haystack is file *content*).
  for (const p of patterns) {
    if (!p || typeof p.pattern !== 'string' || typeof p.fact !== 'string' || !p.fact) continue;
    const scope = p.scope ?? 'any';
    const applies =
      scope === 'shell' ? capability === 'shell.exec'
      : scope === 'connector' ? capability.startsWith('connector')
      : capability === 'shell.exec' || capability.startsWith('connector');
    if (!applies || facts[p.fact] === true) continue;
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, 'i');
    } catch {
      continue; // bad regex → ignore, never throw inside the gate
    }
    // Match the TOOL NAME too (a connector's `STRIPE_REFUND` / `delete_site` is the action itself), not
    // just the command + input values in `haystack`. Harmless for shell, where `tool` is 'Bash'.
    if (re.test(`${tool}\n${haystack}`)) facts[p.fact] = true;
  }

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
