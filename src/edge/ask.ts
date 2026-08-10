/**
 * Cockpit `ask` tier — Band 1: answer the common structured lookups ("which agents are idle?",
 * "what's running?", "how many open tasks?") **deterministically from live state** — instant, no LLM,
 * no session, no API key. A lot of "ask" isn't LLM-shaped at all; it's a query the console already
 * knows. Returns a markdown answer, or null to fall through to the freeform path (a direct LLM, or the
 * ephemeral concierge run). System agents (concierge/consolidator/…) are excluded — a member asks
 * about their teammates, not the machinery.
 */
import { isCodingRuntime } from '../types';
import type { Member } from '../types';
import type { AgentOS } from '../kernel';
import type { TerminalManager } from '../terminal';
import type { Automations } from './automations';
import { resolveLlm, chatComplete } from './llm';

export function answerFromState(os: AgentOS, tm: TerminalManager, autos: Automations, me: Member | undefined, text: string): string | null {
  const t = text.toLowerCase();
  const has = (re: RegExp) => re.test(t);
  const userAgents = [...os.agents.values()].filter((a) => isCodingRuntime(a.runtime) && a.category !== 'System');
  const sessions = tm.listSessions(me);
  const live = sessions.filter((s) => s.alive);
  const fmt = (ids: string[]) => ids.map((x) => `\`${x}\``).join(', ');

  // Idle / inactive agents → those with no live session.
  if (has(/\bagents?\b/) && has(/\b(idle|inactive|unused|not\s+(running|active|busy)|doing nothing)\b/)) {
    if (!userAgents.length) return null;
    const busy = new Set(live.map((s) => s.agent));
    const idle = userAgents.filter((a) => !busy.has(a.id));
    return idle.length
      ? `${idle.length} of ${userAgents.length} agents have no live session right now: ${fmt(idle.map((a) => a.id))}.`
      : `All ${userAgents.length} agents currently have a live session.`;
  }
  // Running / active sessions.
  if (/what('?s| is)\s+(running|going on|happening)/.test(t) || (has(/\b(running|active|live|in\s?progress)\b/) && has(/\b(session|agent|run|now)\b/))) {
    if (!live.length) return 'Nothing is running right now — 0 live sessions.';
    const byAgent: Record<string, number> = {};
    for (const s of live) byAgent[s.agent] = (byAgent[s.agent] || 0) + 1;
    const parts = Object.entries(byAgent).map(([a, n]) => `\`${a}\`${n > 1 ? ` ×${n}` : ''}`);
    return `${live.length} session${live.length > 1 ? 's' : ''} running now: ${parts.join(', ')}.`;
  }
  // Tasks.
  if (has(/\btasks?\b/) && has(/\b(how many|open|list|what|which|status|left|pending|in\s?progress|blocked|to-?do)\b/)) {
    const c = os.tasks.counts(os.tenant);
    return `Tasks: ${c.todo} to-do, ${c.doing} in progress, ${c.blocked} blocked, ${c.done} done.`;
  }
  // Automations.
  if (has(/\b(automations?|schedules?|crons?)\b/) && has(/\b(how many|list|what|which|enabled|active|running|do i have)\b/)) {
    const all = autos.list();
    if (!all.length) return 'No automations configured yet.';
    const on = all.filter((a) => a.enabled);
    return `${all.length} automation${all.length > 1 ? 's' : ''} (${on.length} enabled)${on.length ? `: ${fmt(on.slice(0, 15).map((a) => a.name))}` : ''}.`;
  }
  // List agents (roster) — ENUMERATION only ("list my agents", "how many agents", "what agents do I
  // have"). Deliberately NOT "which agent can help me build a feature" / "which agent handles billing" —
  // those are recommendation questions; they fall through to the LLM (which sees agent descriptions and
  // recommends the right one) rather than getting a raw roster dump that ignores the task.
  if (/\b(list|show)\b.*\bagents?\b/.test(t) || /\bhow many\s+agents?\b/.test(t) || /\bagents?\b.*\b(do i have|are there|(are\s+)?available|exist)\b/.test(t)) {
    if (!userAgents.length) return 'No agents yet.';
    return `You have ${userAgents.length} agents: ${fmt(userAgents.map((a) => a.id))}.`;
  }
  return null;
}

const ASK_SYSTEM =
  'You are the assistant for this Agentric workspace. Answer the question ONLY from the CONTEXT below — ' +
  'the live state of this workspace. Be concise (2–5 sentences). If the answer is not in the context, say ' +
  'you do not have that information and suggest the relevant console page. Never invent agents, numbers, or names.';

/** A compact, factual snapshot of the workspace — the ONLY ground the `ask` LLM may answer from. Kept
 *  small (agents + live counts + KB sections) and derived live, so answers reflect the real fleet, not a
 *  hallucination. Member-scoped where it matters (sessions the viewer can see). */
export function cockpitWorkspaceContext(os: AgentOS, tm: TerminalManager, autos: Automations, me: Member | undefined): string {
  const agents = [...os.agents.values()].filter((a) => isCodingRuntime(a.runtime));
  const agentLines = agents.map((a) => `  - ${a.id}: ${(a.description || '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n');
  const sessions = tm.listSessions(me);
  const live = sessions.filter((s) => s.alive).length;
  const waiting = sessions.filter((s) => s.blocked).length;
  const tc = os.tasks.counts(os.tenant);
  const autoList = autos.list();
  const autoOn = autoList.filter((a) => a.enabled);
  const autoNames = autoOn.slice(0, 20).map((a) => a.name).join(', ');
  const sections = os.kb.sections(os.tenant);
  return [
    `Workspace: ${os.tenantName} (tenant ${os.tenant}).`,
    `Agents (${agents.length}):\n${agentLines || '  (none)'}`,
    `Sessions: ${sessions.length} total, ${live} running, ${waiting} blocked/waiting on a human.`,
    `Tasks: ${tc.todo} todo, ${tc.doing} in progress, ${tc.blocked} blocked, ${tc.done} done.`,
    `Automations: ${autoList.length} total, ${autoOn.length} enabled${autoNames ? ` (${autoNames})` : ''}.`,
    `Knowledge Base sections: ${sections.join(', ') || '(none)'}.`,
  ].join('\n');
}

/**
 * The Cockpit `ask` answer, session-free: Band 1 structured lookups (from live state), else Band 2a a
 * direct LLM over a compact workspace context. Returns null when no inline answer is possible (no state
 * match + no LLM configured) — the caller then falls back (the web route → an ephemeral concierge run;
 * the Slack/Discord front door → route the question to an agent). Shared by `/api/router/preview` and
 * `Automations.routeUnmatched` so both answer questions the exact same way.
 */
export async function answerAsk(
  os: AgentOS,
  tm: TerminalManager,
  autos: Automations,
  me: Member | undefined,
  text: string,
): Promise<{ answer: string; source: 'state' | 'llm' } | null> {
  const state = answerFromState(os, tm, autos, me, text);
  if (state) return { answer: state, source: 'state' };
  const llm = resolveLlm(os);
  if (llm) {
    const answer = await chatComplete(
      llm,
      [
        { role: 'system', content: ASK_SYSTEM },
        { role: 'user', content: `CONTEXT:\n${cockpitWorkspaceContext(os, tm, autos, me)}\n\nQUESTION: ${text}` },
      ],
      { maxTokens: 500, timeoutMs: 15000 },
    );
    if (answer) return { answer, source: 'llm' };
  }
  return null;
}
