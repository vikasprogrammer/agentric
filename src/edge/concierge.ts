/**
 * The **concierge** — a code-provisioned System agent that answers freeform questions ABOUT this
 * workspace for Cockpit's `ask` tier. It exists so `ask` can answer questions that need reasoning/tools
 * WITHOUT depending on a separately-configured LLM API key: the native "LLM" in Agent OS is a claude
 * session (authenticated via the agents' subscription), and every session already gets the OS MCP tools
 * (recall / kb_search / session_history / task_list / list_capabilities / directory_lookup). So the
 * concierge answers by querying real state, not a hand-assembled context snapshot.
 *
 * It's spawned as an ordinary one-shot chat run (governed, run-as the asker), and Cockpit renders its
 * reply inline. Category `System` keeps it out of the agent ROUTER (you never get "routed to the
 * concierge" for work) and out of the fleet picker. Provisioning mirrors the consolidator: idempotent,
 * writes a manifest + persona under the home's agents dir, registers a live claude-code runtime.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentManifest } from '../types';
import { AgentOS } from '../kernel';

export const CONCIERGE_ID = 'concierge';

const MANIFEST: AgentManifest = {
  id: CONCIERGE_ID,
  version: '1.0.0',
  description: 'Workspace concierge — answers questions about this Agent OS workspace using its own tools.',
  category: 'System',
  principal: 'svc-concierge',
  policyContext: 'default@v3',
  runtime: 'claude-code',
  budget: { usdCap: 0.5, tokenCap: 150_000, wallClockMs: 300_000 },
};

const CLAUDE_MD = `# Workspace concierge

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

/** Ensure the concierge agent exists on disk + is registered as a live runtime. Idempotent; safe to call
 *  on every `ask` that needs it. Mirrors the consolidator's self-provisioning. */
export function ensureConcierge(os: AgentOS): void {
  if (os.agents.get(CONCIERGE_ID)?.dir) return;
  const base = os.paths?.userAgents ?? path.join(process.cwd(), 'data', 'agents');
  const dir = path.join(base, CONCIERGE_ID);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'agent.json');
  if (!fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2));
  if (!fs.existsSync(path.join(dir, 'CLAUDE.md'))) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), CLAUDE_MD);
  os.registerAgent({ ...MANIFEST, dir });
}
