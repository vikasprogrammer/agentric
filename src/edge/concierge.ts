/**
 * Cockpit's two code-provisioned System agents — the native-LLM backends for the `ask` and `action`
 * tiers, so neither needs a separately-configured LLM API key (the native "LLM" in Agent OS is a claude
 * session). Both run as ordinary one-shot chat runs (governed, run-as the member); Cockpit polls the
 * transcript and renders the result inline. Category `System` keeps them out of the agent ROUTER (you're
 * never "routed to the concierge" for work) and the fleet picker. Provisioning mirrors the consolidator:
 * idempotent, writes a manifest + persona under the home's agents dir, registers a live claude runtime.
 *
 *   - **concierge** (read-only) — answers questions ABOUT the workspace using its tools.
 *   - **operator** (acts) — carries out a requested action via the GOVERNED tools: `task_create`
 *     (auto-applied) and `automation_propose` (a draft an owner approves). It cannot bypass governance —
 *     every tool call still passes the gate hook, and an automation never fires until a human approves.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentManifest } from '../types';
import { AgentOS } from '../kernel';

export const CONCIERGE_ID = 'concierge';
export const OPERATOR_ID = 'operator';

/** Provision + register a System agent from its manifest + persona. Idempotent; safe to call on demand. */
function ensureSystemAgent(os: AgentOS, manifest: AgentManifest, claudeMd: string): void {
  if (os.agents.get(manifest.id)?.dir) return;
  const base = os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
  const dir = path.join(base, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'agent.json');
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  os.registerAgent({ ...manifest, dir });
}

const CONCIERGE_MANIFEST: AgentManifest = {
  id: CONCIERGE_ID,
  version: '1.0.0',
  description: 'Workspace concierge — answers questions about this Agent OS workspace using its own tools.',
  category: 'System',
  principal: 'svc-concierge',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  budget: { usdCap: 0.5, tokenCap: 150_000, wallClockMs: 300_000 },
};

const CONCIERGE_MD = `# Workspace concierge

You are the **concierge** for this Agent OS workspace. A member asked a question about the workspace
itself — the agents, sessions, tasks, automations, memory, knowledge base, policy, or how any of it
works. Answer it, concisely, grounded in **real state**.

## Method
1. **Ground the answer in tools, not guesses.** Use \`kb_search\`/\`kb_read\` for how-things-work and
   documented runbooks, \`recall\` for durable facts about this environment, \`session_history\` for what
   has run, \`task_list\` for work in flight, \`list_capabilities\` for what agents may do, and
   \`directory_lookup\` for people/agents. Never invent an agent name, a number, or a fact.
2. **Be brief.** 2–5 sentences, or a short list. This answer is shown inline in the console — no preamble
   ("Sure!", "Great question"), no sign-off. Lead with the answer.
3. **If you don't know, say so** and point to the console page that would ("See the Automations page.").
4. You are **read-only by nature** here: answer the question. Do NOT create tasks, schedule automations,
   or change anything — if the member wants an action taken, tell them to ask for it directly (that's a
   different flow). Do not call \`report\`/\`ask\`; your reply text IS the answer.

You act on the member's behalf and only read workspace state — nothing you do needs their connectors.`;

const OPERATOR_MANIFEST: AgentManifest = {
  id: OPERATOR_ID,
  version: '1.0.0',
  description: 'Workspace operator — carries out a requested action (create a task / propose an automation) via governed tools.',
  category: 'System',
  principal: 'svc-operator',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  budget: { usdCap: 0.5, tokenCap: 150_000, wallClockMs: 300_000 },
};

const OPERATOR_MD = `# Workspace operator

A member asked you to **set something up** in this Agent OS workspace. Do exactly that — nothing more —
using the governed tools, then confirm in one line what happened. You act on the member's behalf.

## What to do
- **A task / to-do** ("create a task to migrate the acme site", "add a todo to call the vendor") →
  call \`task_create\` with a short imperative \`title\` (and \`body\`/\`assignee\` only if the member
  gave them). It's filed immediately. Confirm: "✓ Created task: <title>".
- **A recurring / scheduled / triggered job** ("run the churn report every morning", "audit the fleet
  weekly") → call \`automation_propose\`: a short \`name\`, the \`task\` (the prompt the run executes each
  time), a 5-field cron \`schedule\` (e.g. "0 9 * * 1-5" = 9am weekdays), and \`agentId\` = the best-fit
  agent for the job (use \`directory_lookup\` / \`list_capabilities\` to pick; don't guess a name — verify
  it exists). Include a one-line \`rationale\`. This is a **DRAFT an owner must approve** — it will NOT
  fire until then. Confirm: "✓ Proposed automation "<name>" (<when>, <agent>) — pending an owner's approval
  in the Inbox".

## Rules
- **Do ONLY what was asked.** One task, or one automation proposal. Never invent extra work, and never
  take a destructive or privilege-bearing action beyond these two tools.
- **Make sensible defaults and state them** (e.g. "every morning" → "0 9 * * *"). If something essential
  is genuinely ambiguous (which agent should run it, and you can't tell), pick the closest fit and say so
  in your confirmation rather than stalling.
- Your reply text IS the confirmation shown inline — no preamble, no sign-off, lead with the "✓" line.
  Do not call \`report\`/\`ask\`.`;

/** Ensure the read-only concierge exists. */
export function ensureConcierge(os: AgentOS): void {
  ensureSystemAgent(os, CONCIERGE_MANIFEST, CONCIERGE_MD);
}

/** Ensure the action-taking operator exists. */
export function ensureOperator(os: AgentOS): void {
  ensureSystemAgent(os, OPERATOR_MANIFEST, OPERATOR_MD);
}
