/**
 * Cockpit `ask` tier — Band 1: answer the common structured lookups ("which agents are idle?",
 * "what's running?", "how many open tasks?") **deterministically from live state** — instant, no LLM,
 * no session, no API key. A lot of "ask" isn't LLM-shaped at all; it's a query the console already
 * knows. Returns a markdown answer, or null to fall through to the freeform path (a direct LLM, or the
 * ephemeral concierge run). System agents (concierge/consolidator/…) are excluded — a member asks
 * about their teammates, not the machinery.
 */
import { isCodingRuntime, Member } from '../types';
import { AgentOS } from '../kernel';
import { TerminalManager } from '../terminal';
import { Automations } from './automations';

export function answerFromState(os: AgentOS, tm: TerminalManager, autos: Automations, me: Member, text: string): string | null {
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
  // List agents (generic roster).
  if ((has(/\b(list|what|which|how many|show)\b/) && has(/\bagents?\b/)) || /\bagents?\b.*\b(do i have|are there|available)\b/.test(t)) {
    if (!userAgents.length) return 'No agents yet.';
    return `You have ${userAgents.length} agents: ${fmt(userAgents.map((a) => a.id))}.`;
  }
  return null;
}
