/**
 * Capability normalization (§4.2 of docs/agent-os-plan.md — the "moat").
 *
 * The gate hook assigns a STRUCTURAL capability by tool shape: every MCP/connector call collapses to
 * the single literal `connector.call`, with the real vendor action surviving only in `args.tool`
 * (e.g. `mcp__composio-company__STRIPE_REFUND`, `mcp__github__create_issue`). That means the same
 * real-world action wears a different name on every surface and policy can't target it portably.
 *
 * This module normalizes that raw tool name to ONE canonical, provider-independent capability
 * (`payments.refund`, `repo.pr.create`, …) so a single policy rule governs the action across Stripe /
 * a REST call / an SDK call identically. It is a NAME normalizer, not the execution `CapabilityRegistry`
 * (registry.ts, the plugin table) — the two are unrelated.
 *
 * Deliberately narrow, per the plan: seed ONLY the actions the mediation plane actually sees, and grow
 * the table as coverage grows — no universal registry up front. An unmapped tool falls through with its
 * structural capability unchanged (no rejection), so this can only ADD granularity, never remove
 * governance. `resolveCapability` is called AFTER `enrichArgs` in the gate, so the enricher still sees
 * `connector.call` and sets its facts (destructive/risky/amountUsd/…); only the id that classify and the
 * audit see is upgraded.
 */

/** Metadata a canonical capability carries — the durable security abstraction policy targets. `risk`
 *  and `effects` are descriptive today (for the console + future Tier-B guards); only `id` drives
 *  classification. */
export interface CapabilityDescriptor {
  id: string;
  effects: string[];
  risk: 'low' | 'medium' | 'high';
  /** Human-readable examples of the provider actions that normalize here (documentation, not matched). */
  providers: string[];
}

/** A first-match rule: when the structural capability is `from`, a raw tool name matching `tool`
 *  normalizes to the canonical id `to`. */
interface NormalizeRule {
  from: string;
  tool: RegExp;
  to: string;
}

const DESCRIPTORS: CapabilityDescriptor[] = [
  { id: 'payments.refund', effects: ['financial', 'external_write'], risk: 'high', providers: ['STRIPE_REFUND', 'stripe.Refund.create', 'refund_payment'] },
  { id: 'payments.charge', effects: ['financial', 'external_write'], risk: 'high', providers: ['STRIPE_CREATE_CHARGE', 'create_payment_intent', 'capture_payment'] },
  { id: 'payments.payout', effects: ['financial', 'external_write'], risk: 'high', providers: ['STRIPE_CREATE_PAYOUT', 'create_payout'] },
  { id: 'repo.pr.create', effects: ['code', 'external_write'], risk: 'medium', providers: ['GITHUB_CREATE_PULL_REQUEST', 'create_pull_request'] },
  { id: 'repo.issue.create', effects: ['code', 'external_write'], risk: 'low', providers: ['GITHUB_CREATE_ISSUE', 'create_issue'] },
  { id: 'messaging.post', effects: ['communication', 'external_write'], risk: 'medium', providers: ['SLACK_POST_MESSAGE', 'send_message', 'chat_postMessage'] },
  // email.send is a canonical capability too, but it's already resolved in the gate via the enricher's
  // `emailSend` fact (recipient-aware), so it's listed here for the catalog, not matched by a rule below.
  { id: 'email.send', effects: ['communication', 'external_write'], risk: 'medium', providers: ['GMAIL_SEND_EMAIL', 'send_email'] },
];

const DESCRIPTOR_BY_ID = new Map(DESCRIPTORS.map((d) => [d.id, d]));

/**
 * Ordered, first-match. Every rule keys off `connector.call` (the structural id the gate hook assigns
 * an MCP/connector tool) and matches the raw tool NAME — never the input args, so a `Bash` command that
 * merely echoes "refund" can't trip it (its structural capability is `shell.exec`, not `connector.call`).
 * Payment rules come before the generic ones; `refund`/`payout` precede `charge`.
 */
const RULES: NormalizeRule[] = [
  { from: 'connector.call', tool: /refund/i, to: 'payments.refund' },
  { from: 'connector.call', tool: /payout/i, to: 'payments.payout' },
  { from: 'connector.call', tool: /charge|payment[_-]?intent|capture[_-]?payment|create[_-]?charge/i, to: 'payments.charge' },
  { from: 'connector.call', tool: /create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|\bcreate[_-]?pr\b/i, to: 'repo.pr.create' },
  { from: 'connector.call', tool: /create[_-]?issue|issue[_-]?create/i, to: 'repo.issue.create' },
  { from: 'connector.call', tool: /slack[a-z_]*(post|send|message)|(post|send)[_-]?message|chat[_-]?post/i, to: 'messaging.post' },
];

/**
 * Normalize a structural capability + raw tool name to its canonical capability id. Returns the input
 * `capability` unchanged when nothing matches (unmapped tool, no tool name, or a capability that isn't a
 * generic connector call) — so this only ever adds granularity. Pure and side-effect-free.
 */
export function resolveCapability(capability: string, toolName: string | undefined): string {
  if (!toolName) return capability;
  for (const rule of RULES) {
    if (rule.from !== capability) continue;
    if (rule.tool.test(toolName)) return rule.to;
  }
  return capability;
}

/** The descriptor for a canonical capability id, or undefined if it isn't a registered one. */
export function capabilityDescriptor(id: string): CapabilityDescriptor | undefined {
  return DESCRIPTOR_BY_ID.get(id);
}

/** The full catalog of canonical capabilities the registry knows (for a console / catalog view). */
export function knownCapabilities(): CapabilityDescriptor[] {
  return [...DESCRIPTORS];
}

/** One entry in the governed-capability surface: the id policy targets + why it's governed. */
export interface GovernedCapability {
  id: string;
  description: string;
}

/**
 * The STRUCTURAL capabilities the gate hook assigns purely by tool shape (terminal/gate-hook.sh) plus
 * the two the terminal gate reclassifies host egress into (net.connect / ssh.exec). These are the real
 * ids an agent's tool calls collapse to before the policy classifies them — independent of any tenant's
 * connector plugins.
 */
const STRUCTURAL: GovernedCapability[] = [
  { id: 'shell.exec', description: 'Run a shell command (the Bash tool). The command is parsed into facts — destructive flags, delete counts, host egress via ssh/curl — so a risky command can be gated or denied even though the tool is just "Bash".' },
  { id: 'file.write', description: 'Create or edit a file (Edit/Write/apply_patch). Writes to protected paths (credentials, workspace state) are denied; writes outside your own folder may be gated when the file-write guard is on.' },
  { id: 'connector.connect', description: 'Start an OAuth grant that connects a third-party app for the whole workspace (INITIATE_CONNECTION). Owner-gated.' },
  { id: 'connector.call', description: 'Call a connected third-party tool over MCP. Payment / PR / messaging actions normalize to the canonical capabilities below so one rule governs them across providers.' },
  { id: 'email.send', description: 'Send an outbound email. Gated by recipient — internal (your org domains) is lighter than external.' },
  { id: 'net.connect', description: 'Open a network connection to a host (host-egress governance, when enabled). An unknown or un-granted host pauses for approval; a host with a "never" posture is denied.' },
  { id: 'ssh.exec', description: 'Run a command on a remote host over SSH (host-egress governance, when enabled). An unknown or un-granted host pauses for owner approval; a host with a "never" posture is denied.' },
];

/**
 * The REAL governed capability surface an agent faces: the structural capabilities above plus the
 * canonical (provider-independent) capabilities the normalizer resolves connector calls to. This — NOT
 * the demo execution registry (src/capabilities/examples.ts, whose echo.run/stripe.refund/… only exist
 * so the zero-dependency demo runs) — is what `list_capabilities` reports on a live tenant. Deduped so
 * email.send (both structural and canonical) appears once.
 */
export function governedCapabilities(): GovernedCapability[] {
  const seen = new Set(STRUCTURAL.map((s) => s.id));
  const canonical = DESCRIPTORS
    .filter((d) => !seen.has(d.id))
    .map((d) => ({
      id: d.id,
      description: `Canonical ${d.effects.join('/')} action (${d.risk} risk) — normalized from e.g. ${d.providers.slice(0, 2).join(', ')}.`,
    }));
  return [...STRUCTURAL, ...canonical];
}
