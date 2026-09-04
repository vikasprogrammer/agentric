/**
 * Composio Tool Router envelope unwrapping — the gate's blind spot on the fleet's biggest egress surface.
 *
 * A normal MCP connector exposes one tool per action, so the gate hook's tool→capability routing sees
 * `mcp__github__create_issue` and `normalize.ts` can resolve it to `repo.issue.create`. Composio's Tool
 * Router does NOT work that way: however many apps an entity has connected, the session exposes exactly
 * SIX meta-tools, and every real action is a payload inside one of them. Verified against the live
 * endpoint (2026-09-03) — a session with Gmail, Sheets, Stripe, ClickUp and Bitbucket connected lists
 * only:
 *
 *   COMPOSIO_SEARCH_TOOLS · COMPOSIO_GET_TOOL_SCHEMAS   — discovery, read-only
 *   COMPOSIO_MULTI_EXECUTE_TOOL                          — runs 1..50 real tools by slug
 *   COMPOSIO_REMOTE_BASH_TOOL                            — arbitrary bash on Composio's sandbox
 *   COMPOSIO_REMOTE_WORKBENCH                            — arbitrary Python on a persistent sandbox
 *   COMPOSIO_MANAGE_CONNECTIONS                          — initiates/replaces OAuth connections
 *
 * So `args.tool` is always the ENVELOPE name and the real action lives at `input.tools[].tool_slug`.
 * Every downstream governance plane keys off `args.tool`, which means all of them were blind:
 * `resolveCapability` never fired (`payments.refund`, `email.send`, …), the enricher's `emailSend`
 * fact was never set so recipients were never judged, and `briefFor` rendered an approval card reading
 * "Write to Composio multi execute tool". Observed live on expresstech `ses_cbfa67534ca42d6b`: two
 * GMAIL_SEND_EMAIL calls, both audited as `connector.call` / allow / green / "no rule matched".
 *
 * This module restores the invariant by rewriting the gate's raw args to the REAL action before any
 * plane looks at them. It is purely structural — it computes no facts and makes no decision; the gate
 * re-enriches and classifies whatever comes back exactly as it would a first-class connector tool.
 *
 * Two envelopes cannot be unwrapped to a named action, and both are code execution:
 *   - `COMPOSIO_REMOTE_BASH_TOOL` is a shell.
 *   - `COMPOSIO_REMOTE_WORKBENCH` is a Python cell that can itself call `run_composio_tool(tool_slug=…)`
 *     — i.e. any Composio action, from inside a string. There is no static unwrap for that.
 * Both are therefore promoted to `shell.exec`, with the code as `command`, so the shell rules, the
 * semantic guard and the workspace's custom enrich patterns all apply to them. They additionally carry
 * `composioRemote: true` so a workspace can write one rule that governs (or denies) remote execution
 * as a class — the honest posture for a channel whose payload we cannot statically read.
 *
 * BATCH SEMANTICS. `tools` accepts up to 50 actions "executed in parallel", so one envelope can carry
 * several distinct effects while the gate returns a single verdict (one capability, one approval card,
 * one gateId — the hook polls exactly one). Collapsing is therefore forced, and we collapse to the
 * RISKIEST action: the batch is governed at the risk of its worst member, and every slug in it is
 * recorded on `composioActions` so the audit row and the approval card name the whole batch rather than
 * just the one that set the tier. Allowing the batch is thus allowing its maximum — never a weaker
 * member standing in for a stronger one.
 */
import { enrichArgs } from '../governance/enricher';
import { resolveCapability } from './normalize';

/** The structural capability the gate hook assigns any MCP/connector tool. */
const CONNECTOR_CALL = 'connector.call';

/** Split a namespaced MCP tool name into its server prefix and the bare tool name.
 *  `mcp__composio-company__COMPOSIO_MULTI_EXECUTE_TOOL` → `['mcp__composio-company', 'COMPOSIO_MULTI_EXECUTE_TOOL']`.
 *  The prefix is preserved on every synthetic tool we build, because it is what identifies WHICH
 *  Composio identity the action runs under — `emailIdentityDenial` reads it to refuse a member-scoped
 *  run reaching for the company email account. */
function splitTool(tool: string): { prefix: string; name: string } {
  const at = tool.lastIndexOf('__');
  return at > 0 ? { prefix: tool.slice(0, at), name: tool.slice(at + 2) } : { prefix: '', name: tool };
}

/** Is this bare tool name one of the Tool Router's meta-tools we rewrite? */
function envelopeKind(name: string): 'execute' | 'bash' | 'workbench' | 'connections' | null {
  switch (name.toUpperCase()) {
    case 'COMPOSIO_MULTI_EXECUTE_TOOL': return 'execute';
    case 'COMPOSIO_REMOTE_BASH_TOOL': return 'bash';
    case 'COMPOSIO_REMOTE_WORKBENCH': return 'workbench';
    case 'COMPOSIO_MANAGE_CONNECTIONS': return 'connections';
    default: return null;
  }
}

/** One real action carried inside a `COMPOSIO_MULTI_EXECUTE_TOOL` envelope. */
interface Action {
  slug: string;
  args: Record<string, unknown>;
}

/** Read the `tools: [{ tool_slug, arguments }]` array, defensively — a malformed entry is skipped, not
 *  trusted. An envelope we cannot read yields no actions and is left alone (governed as it is today). */
function actionsOf(input: Record<string, unknown>): Action[] {
  const raw = input.tools;
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const slug = String((t as Record<string, unknown>).tool_slug ?? '').trim();
    if (!slug) continue;
    const a = (t as Record<string, unknown>).arguments;
    out.push({ slug, args: a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {} });
  }
  return out;
}

/**
 * Risk ordering used ONLY to pick which action of a batch sets the tier. It is deliberately a coarse
 * static ladder over the canonical capability rather than a second policy engine: the real verdict is
 * still the ruleset's, applied by the gate to whichever action this returns. Ranks track the harm of the
 * effect (irreversible money > identity/credentials > outbound communication > code > reads).
 */
const CAPABILITY_RANK: Record<string, number> = {
  'payments.refund': 100,
  'payments.payout': 100,
  'payments.charge': 95,
  'connector.connect': 90,
  'email.send': 70,
  'messaging.post': 50,
  'repo.pr.create': 40,
  'repo.issue.create': 30,
  [CONNECTOR_CALL]: 10,
};

/** Score one action: its canonical capability's rank, plus the facts that make the same capability
 *  worse (an external blast radius, a bigger amount, a bulk delete). Ties break on amount then on how
 *  many outsiders it reaches, so two email sends resolve to the one that leaves the org furthest. */
function score(slug: string, args: Record<string, unknown>, orgDomains: string[]): number {
  const facts = enrichArgs(CONNECTOR_CALL, { tool: slug, input: args }, orgDomains);
  const cap = facts.emailSend === true ? 'email.send' : resolveCapability(CONNECTOR_CALL, slug);
  let n = CAPABILITY_RANK[cap] ?? CAPABILITY_RANK[CONNECTOR_CALL];
  if (facts.destructive === true) n += 25;
  if (facts.emailExternal === true) n += 15;
  if (facts.risky === true) n += 5;
  const amount = typeof facts.amountUsd === 'number' ? facts.amountUsd : 0;
  const external = typeof facts.emailExternalCount === 'number' ? facts.emailExternalCount : 0;
  const deletes = typeof facts.deleteCount === 'number' ? facts.deleteCount : 0;
  // Tie-breakers are sub-unit so they can only order actions of equal capability + equal facts, never
  // promote a low-risk capability above a higher one on volume alone.
  return n + Math.min(amount, 1e6) / 1e7 + Math.min(external + deletes, 999) / 1e4;
}

/** What the gate should govern instead of the envelope. */
export interface UnwrappedEnvelope {
  /** The capability to classify — `connector.call` for a real action, `shell.exec` for remote code. */
  capability: string;
  /** Rewritten gate args: `tool` is the real (still server-prefixed) action, `input` its arguments. */
  args: Record<string, unknown>;
  /** Every action slug the envelope carried — for the audit row and the approval card. */
  actions: string[];
  /** Which meta-tool this came from, for the `gate.composio.unwrapped` audit event. */
  kind: 'execute' | 'bash' | 'workbench' | 'connections';
}

/**
 * Rewrite a Composio Tool Router envelope into the real effect underneath it, or return null when the
 * call is not an envelope (any other tool, including Composio's read-only discovery meta-tools, which
 * have no side effect to govern). Pure and side-effect free.
 *
 * `orgDomains` is only used to rank a batch's actions against each other; the gate re-enriches the
 * chosen action with the workspace's full context afterwards, so nothing here is load-bearing on facts.
 */
export function unwrapComposioEnvelope(
  capability: string,
  args: Record<string, unknown>,
  orgDomains: string[] = [],
): UnwrappedEnvelope | null {
  if (capability !== CONNECTOR_CALL) return null;
  const tool = typeof args.tool === 'string' ? args.tool : '';
  if (!tool) return null;
  const { prefix, name } = splitTool(tool);
  const kind = envelopeKind(name);
  if (!kind) return null;
  const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
  const namespaced = (slug: string): string => (prefix ? `${prefix}__${slug}` : slug);

  // A shell and a Python cell. Neither can be unwrapped to a named action — the workbench's code may
  // itself call `run_composio_tool(...)` — so both are governed as the code execution they are.
  if (kind === 'bash' || kind === 'workbench') {
    const code = kind === 'bash'
      ? String(input.command ?? '')
      : String(input.code_to_execute ?? '');
    return {
      capability: 'shell.exec',
      args: {
        ...args,
        tool,
        command: code,
        input,
        composioRemote: true,
        composioRuntime: kind === 'bash' ? 'bash' : 'python',
      },
      actions: [name],
      kind,
    };
  }

  // Connecting (or, with `reinitiate_all`, REPLACING) a third-party account is a credential grant, and
  // `connector.connect` is the capability the policy already has for it.
  if (kind === 'connections') {
    const toolkits = Array.isArray(input.toolkits) ? input.toolkits.map(String) : [];
    return {
      capability: 'connector.connect',
      args: { ...args, tool, input, toolkits, reinitiate: input.reinitiate_all === true },
      actions: [name],
      kind,
    };
  }

  const actions = actionsOf(input);
  if (!actions.length) return null; // unreadable envelope — leave it exactly as it is today
  let chosen = actions[0];
  let best = -Infinity;
  for (const a of actions) {
    const s = score(a.slug, a.args, orgDomains);
    if (s > best) { best = s; chosen = a; }
  }
  return {
    capability: CONNECTOR_CALL,
    args: {
      ...args,
      tool: namespaced(chosen.slug),
      input: chosen.args,
      composioActions: actions.map((a) => a.slug),
      ...(actions.length > 1 ? { composioBatch: actions.length } : {}),
    },
    actions: actions.map((a) => a.slug),
    kind,
  };
}
