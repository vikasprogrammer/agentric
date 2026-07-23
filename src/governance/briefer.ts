/**
 * The BRIEFER — turns an enriched attempt + its policy decision into a {@link DecisionBrief}, the
 * human-legible account every governance consumer reads (approval card · audit narrative · later the
 * failure detector). Sibling of the enricher: `enrichArgs` computes the FACTS, `briefFor` renders the
 * STORY over them. Pure, deterministic, no I/O and no model call — templates keyed on (verb, target,
 * risk). See docs/decision-brief-layer-plan.md §4–§6.
 *
 * It reuses facts the enricher already produced (`destructive`, `risky`, `outsideWorkdir`, `amountUsd`,
 * `deleteCount`, the host facts) plus, for a shell call, Claude's OWN `tool_input.description` — which
 * is already a one-line human summary of the command, so we prefer it for the headline.
 */
import { ActionVerb, BriefTarget, Decision, DecisionBrief } from '../types';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** The tool_input object (a connector's input / a Bash `{command,description}`), best-effort. */
function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : args;
}

/** The leading program of a shell command — skips `cd …`, `sudo`, `VAR=…` prefixes and `&&`/`;` joins,
 *  so `cd /x && FOO=1 sudo curl …` fingerprints as `curl`. Used for the signature + a command label. */
function commandHead(command: string): string {
  const first = command.replace(/\s+/g, ' ').trim();
  // Walk tokens, skipping env-assignments and a few wrappers, until the first real program token.
  for (const tok of first.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].split(' ')) {
    if (!tok) continue;
    if (tok === 'cd' || tok === 'sudo' || tok === 'command' || tok === 'exec' || tok === 'time') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // FOO=bar
    const base = tok.split('/').pop() ?? tok;
    if (/^[A-Za-z0-9._-]+$/.test(base)) return base;
    break;
  }
  return '';
}

/** Coarse family for a file path — the extension (`.ts`) or, failing that, the parent dir — so many
 *  edits to the same kind/place collapse to one signature without being byte-identical. */
function pathFamily(p: string): string {
  const base = p.split('/').pop() ?? p;
  const dot = base.lastIndexOf('.');
  if (dot > 0) return base.slice(dot); // ".ts", ".md"
  const dir = p.slice(0, p.length - base.length).replace(/\/+$/, '');
  return dir.split('/').pop() || base;
}

function verbFor(capability: string, args: Record<string, unknown>): ActionVerb {
  if (args.destructive === true) return 'delete';
  switch (capability) {
    case 'file.write': return 'write';
    case 'net.connect': return 'network';
    case 'ssh.exec': return 'execute';
    case 'email.send': return 'send';
    case 'secret.put': return 'grant';
    case 'connector.connect': return 'grant';
    case 'shell.exec': {
      const cmd = `${str(args.command)} ${str(inputOf(args).command)}`;
      if (/\b(deploy|kubectl|systemctl|terraform|helm)\b/i.test(cmd)) return 'deploy';
      return 'execute';
    }
    case 'connector.call':
      if (num(args.amountUsd) !== undefined) return 'pay';
      return 'write';
    default:
      if (capability.startsWith('image') || capability.startsWith('video')) return 'other';
      return 'other';
  }
}

function targetFor(capability: string, args: Record<string, unknown>, input: Record<string, unknown>): BriefTarget {
  const host = str(args.host);
  if (capability === 'net.connect' || capability === 'ssh.exec' || (host && args.netEgress === true)) {
    const proto = str(args.netProtocol) || (capability === 'ssh.exec' ? 'ssh' : 'net');
    return { kind: 'host', label: host ? `${host} (${proto})` : `remote host (${proto})`, host: host || undefined };
  }
  if (capability === 'file.write') {
    const p = str(input.file_path) || str(input.path) || str(input.notebook_path);
    const label = p ? (p.split('/').pop() || p) : 'a file';
    return { kind: 'file', label, outsideWorkdir: args.outsideWorkdir === true };
  }
  if (capability === 'email.send') {
    const to = Array.isArray(args.emailRecipients) ? (args.emailRecipients as unknown[]).map(String) : [];
    return { kind: 'recipient', label: to.length ? truncate(to.join(', '), 60) : 'a recipient', count: to.length || undefined };
  }
  const amountUsd = num(args.amountUsd);
  if (amountUsd !== undefined) return { kind: 'money', label: `$${amountUsd.toFixed(2)}`, amountUsd };
  const deleteCount = num(args.deleteCount);
  if (deleteCount !== undefined && deleteCount > 0) {
    return { kind: capability === 'connector.call' ? 'resource' : 'db', label: `${deleteCount} item${deleteCount === 1 ? '' : 's'}`, count: deleteCount };
  }
  if (capability === 'connector.call' || capability === 'connector.connect') {
    const tool = str(args.tool);
    return { kind: 'resource', label: tool ? prettyTool(tool) : 'a connector' };
  }
  if (capability === 'secret.put') return { kind: 'resource', label: str(input.key) || 'a secret' };
  if (capability === 'shell.exec') {
    const head = commandHead(str(args.command) || str(input.command));
    return { kind: 'command', label: head || 'a shell command' };
  }
  return { kind: 'unknown', label: capability };
}

const VERB_WORD: Record<ActionVerb, string> = {
  read: 'Read', write: 'Write to', delete: 'Delete', execute: 'Run', network: 'Connect to',
  deploy: 'Deploy via', pay: 'Pay', send: 'Send to', grant: 'Grant', other: 'Use',
};

/** A shell command — including one reclassified to ssh.exec/net.connect by host governance. All three
 *  originate from a Bash call, so they carry the `{command, description}` shape. */
const isShellish = (cap: string): boolean => cap === 'shell.exec' || cap === 'ssh.exec' || cap === 'net.connect';

/** Turn a raw MCP tool id into a human label: `mcp__composio-company__STRIPE_REFUND` → "Stripe refund". */
function prettyTool(tool: string): string {
  const tail = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool;
  const words = tail.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool;
}

function headlineFor(capability: string, args: Record<string, unknown>, input: Record<string, unknown>, verb: ActionVerb, target: BriefTarget): string {
  // A Bash-origin call carries Claude's own one-line `description` — already a human summary; prefer it.
  const desc = str(input.description);
  if (isShellish(capability) && desc) return truncate(desc, 120);
  if (capability === 'connector.call' || capability === 'connector.connect') {
    const tool = str(args.tool);
    return truncate(tool ? `${VERB_WORD[verb]} ${prettyTool(tool)}` : `${VERB_WORD[verb]} a connector`, 120);
  }
  if (isShellish(capability)) {
    const cmd = str(args.command) || str(input.command);
    return truncate(cmd ? `Run: ${cmd}` : `${VERB_WORD[verb]} ${target.label}`, 120);
  }
  return truncate(`${VERB_WORD[verb]} ${target.label}`, 120);
}

/** Humanise the terse policy reason + add the target risk note a human wants ("outside its folder"). */
function rationaleFor(decision: Decision, args: Record<string, unknown>, target: BriefTarget): string {
  const raw = decision.reason || '';
  let base = raw;
  if (/host is not a granted connection|host could not be identified/i.test(raw)) {
    base = `The target host ${target.host ? `\`${target.host}\` ` : ''}isn't on the trusted list yet.`;
  } else if (/default policy \(no rule matched\)/i.test(raw)) {
    base = 'No policy rule flagged this action.';
  }
  const notes: string[] = [];
  if (args.destructive === true) notes.push('irreversible');
  if (target.outsideWorkdir === true) notes.push("writes outside the agent's own folder");
  if (target.amountUsd !== undefined) notes.push(`moves ${target.label}`);
  if (target.count !== undefined && target.kind !== 'recipient') notes.push(`affects ${target.count}`);
  return notes.length ? `${base} (${notes.join('; ')})` : base;
}

function signatureFor(capability: string, verb: ActionVerb, target: BriefTarget, args: Record<string, unknown>, input: Record<string, unknown>): string {
  let key = '';
  if (target.host) key = target.host;
  else if (capability === 'file.write') key = pathFamily(str(input.file_path) || str(input.path) || '');
  else if (capability === 'shell.exec') key = commandHead(str(args.command) || str(input.command));
  else if (capability.startsWith('connector')) key = str(args.tool);
  return `${capability}|${verb}|${target.kind}|${key}`.toLowerCase();
}

/**
 * Render the brief. `args` is the ENRICHED attempt args (enricher output: the raw `{tool,input}` plus
 * the computed facts). `decision` is the policy verdict. Pure.
 */
export function briefFor(capability: string, args: Record<string, unknown>, decision: Decision): DecisionBrief {
  const input = inputOf(args);
  const verb = verbFor(capability, args);
  const target = targetFor(capability, args, input);
  const headline = headlineFor(capability, args, input, verb, target);
  const rationale = rationaleFor(decision, args, target);
  // For a host approval we can offer a durable "trust this host" resolution (phase 2) instead of a
  // one-off approve — only when the target host is actually known (else there's nothing to trust).
  const suggestedAction: DecisionBrief['suggestedAction'] =
    decision.effect === 'deny' ? 'deny'
      : decision.effect === 'approve' ? (target.kind === 'host' && target.host ? 'trust-host' : 'approve')
      : 'allow';
  const signature = signatureFor(capability, verb, target, args, input);
  return { headline, verb, target, rationale, riskClass: decision.riskClass, suggestedAction, signature };
}
