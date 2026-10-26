/**
 * "You keep typing this" — suggestions drawn from the requests a member starts sessions with.
 *
 * Mining 30 days of fleet chats (2026-10-26) found the same people opening session after session with the
 * same standing instruction, by hand: one member wrote "do not create any unnecessary tasks" in 19
 * sessions, another "do not edit anything" in 24, a third started 22 of 30 days with "send 15 from ana@
 * and 10 from sales@". The product already has a place for each — personal context (injected into every
 * session that runs as you; two other members had filled theirs to the 8,000-character cap) and
 * Automations — and none of those three members had used either.
 *
 * So this reads a member's own recent console-started sessions and proposes:
 *   - `context`  — a recurring CONSTRAINT clause ("do not …", "always …", "keep it …") not already in their
 *                  personal context, to add to it once instead of retyping it;
 *   - `routine`  — a near-identical request to the same agent on several different days, to turn into an
 *                  automation.
 * Read-side only and computed on request: nothing is stored, nothing is applied, and the member decides.
 * Clauses are compared after stripping URLs, ids and numbers, so "check task <url>. do not edit anything"
 * and the same with another URL count as one instruction.
 */

export interface StandingSuggestion {
  kind: 'context' | 'routine';
  /** context: the clause as the member last wrote it; routine: their most recent request of that shape. */
  text: string;
  /** Distinct sessions it appeared in, and distinct calendar days (UTC) across them. */
  sessions: number;
  days: number;
  /** routine only: the agent those requests went to. */
  agent?: string;
}

export interface SessionStart { task: string; agent: string; createdAt: number }

const CONTEXT_MIN_SESSIONS = 4;
const ROUTINE_MIN_DAYS = 4;
const MAX_EACH = 5;

// A clause worth keeping as a standing preference says how to work, not what to work on.
const CONSTRAINT_CUE = /\b(do not|don'?t|dont|never|always|avoid|make sure|keep (it|them|the)|only|without|no need|remember|in (plain|simple)|step by step|before (you|making|merging))\b/i;

/** Lower-case words with URLs, ids, emails, numbers and file refs removed — the comparable core. */
function core(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+|\S+@\S+\.\S+|\.inbox\/\S+|<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/\b(?:tsk|ses|goal|art|m|au)_[a-z0-9]+\b|#?\b[a-z]*\d[\w-]*\b/g, ' ')
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clauses(task: string): { raw: string; key: string }[] {
  const out: { raw: string; key: string }[] = [];
  for (const piece of task.split(/(?<=[.!?])\s+|\n+|;\s+/)) {
    const raw = piece.replace(/\s+/g, ' ').trim().replace(/[.!?;,]+$/, '');
    const key = core(raw);
    const words = key ? key.split(' ').length : 0;
    if (words >= 3 && words <= 16 && CONSTRAINT_CUE.test(raw)) out.push({ raw, key });
  }
  return out;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const wordSet = (s: string) => new Set(core(s).split(' ').filter((w) => w.length > 2));
function jaccard(a: Set<string>, b: Set<string>): number {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
}

/** Is this clause already said, near enough, in the member's personal context? */
function alreadyCovered(key: string, contextCore: string): boolean {
  if (!contextCore) return false;
  if (contextCore.includes(key)) return true;
  const words = key.split(' ').filter((w) => w.length > 2);
  const hits = words.filter((w) => contextCore.includes(w)).length;
  return words.length > 0 && hits / words.length >= 0.8;
}

/**
 * Suggestions for one member from the sessions they started (newest last is not required). `context` is
 * their current personal context, so nothing already there is proposed again.
 */
export function standingSuggestions(starts: SessionStart[], context: string): StandingSuggestion[] {
  const sorted = [...starts].filter((s) => s.task && !s.task.startsWith('/goal ')).sort((a, b) => a.createdAt - b.createdAt);
  const contextCore = core(context);

  // ── context: recurring constraint clauses ──
  const byKey = new Map<string, { raw: string; sessions: number; days: Set<string> }>();
  for (const s of sorted) {
    const seen = new Set<string>();
    for (const c of clauses(s.task)) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const e = byKey.get(c.key) ?? { raw: c.raw, sessions: 0, days: new Set<string>() };
      e.raw = c.raw;            // keep the member's latest wording
      e.sessions++;
      e.days.add(dayOf(s.createdAt));
      byKey.set(c.key, e);
    }
  }
  const context_: StandingSuggestion[] = [...byKey.entries()]
    .filter(([key, e]) => e.sessions >= CONTEXT_MIN_SESSIONS && e.days.size >= 2 && !alreadyCovered(key, contextCore))
    .sort((a, b) => b[1].sessions - a[1].sessions)
    // a shorter clause inside a longer kept one is the same instruction — keep the more common/first
    .filter(([key], i, arr) => !arr.slice(0, i).some(([k]) => k.includes(key) || key.includes(k)))
    .slice(0, MAX_EACH)
    .map(([, e]) => ({ kind: 'context' as const, text: e.raw, sessions: e.sessions, days: e.days.size }));

  // ── routine: the same request to the same agent on several days ──
  const routines: StandingSuggestion[] = [];
  const byAgent = new Map<string, SessionStart[]>();
  for (const s of sorted) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
  for (const [agent, list] of byAgent) {
    const used = new Set<number>();
    for (let i = list.length - 1; i >= 0; i--) {          // newest first, so `text` is the latest wording
      if (used.has(i)) continue;
      const a = wordSet(list[i].task);
      if (a.size < 3) continue;
      const cluster = [i];
      for (let j = i - 1; j >= 0; j--) {
        if (!used.has(j) && jaccard(a, wordSet(list[j].task)) >= 0.5) cluster.push(j);
      }
      const days = new Set(cluster.map((k) => dayOf(list[k].createdAt)));
      // Same words but a different link each time ("review PR <url> and give a verdict") is a TEMPLATE
      // over changing inputs, not a routine a schedule could run — leave those out.
      const links = new Set(cluster.map((k) => (list[k].task.match(/https?:\/\/\S+/g) ?? []).sort().join(' ')));
      if (days.size >= ROUTINE_MIN_DAYS && links.size <= 1) {
        cluster.forEach((k) => used.add(k));
        routines.push({ kind: 'routine', text: list[i].task.replace(/\s+/g, ' ').trim().slice(0, 300), sessions: cluster.length, days: days.size, agent });
      }
    }
  }
  routines.sort((a, b) => b.days - a.days);

  return [...context_, ...routines.slice(0, MAX_EACH)];
}
