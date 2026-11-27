/**
 * Which goal (and bet) a session is WORKING FOR — resolved from its provenance, so every task the run
 * files lands under that goal without the agent having to name it (docs/tasks-plan.md §8d).
 *
 * Why a resolver and not "pass goalId down": on the live fleet agents almost never pass `goalId`
 * themselves (globex: 44 of 1,981 agent-filed tasks over 60 days carried one), but the server already
 * KNOWS the context of most runs — a goal-room/plan run says so in its provenance, a dispatched task run
 * points at a task that may carry a goal and a bet, and an automation can now declare the goal it serves.
 * One function reads all of them, so the rule is the same on every path that files work.
 *
 * Deliberately NOT inferred: a member's chat run has no goal unless the member started it from one, and
 * an automation with no goal is operational work. Guessing a goal from a title would pollute the goal's
 * progress with work that doesn't serve it — an unlinked task is honest, a mislinked one is not.
 */
import type { Db } from '../state/db';

export interface WorkContext {
  goalId?: string;
  betId?: string;
  /** Where it came from — logged on the task's link event so an inherited goal is never a mystery. */
  via?: string;
}

/** Resolve a session's work context from its provenance (`spawned_by`). Never throws; {} when unknown. */
export function workContextFor(db: Db, provenance: string | undefined, depth = 0): WorkContext {
  const p = provenance ?? '';
  if (!p || depth > 3) return {};
  try {
    if (p.startsWith('goal:')) {
      const id = p.slice('goal:'.length);
      return goalExists(db, id) ? { goalId: id, via: 'goal room' } : {};
    }
    if (p.startsWith('task:')) {
      const id = p.slice('task:'.length);
      const t = db.prepare('SELECT goal_id, bet_id FROM tasks WHERE id = ?').get<{ goal_id: string | null; bet_id: string | null }>(id);
      return t?.goal_id ? { goalId: t.goal_id, ...(t.bet_id ? { betId: t.bet_id } : {}), via: `task:${id}` } : {};
    }
    if (p.startsWith('automation:')) {
      const id = p.slice('automation:'.length);
      const a = db.prepare('SELECT goal_id FROM automations WHERE id = ?').get<{ goal_id: string | null }>(id);
      return a?.goal_id && goalExists(db, a.goal_id) ? { goalId: a.goal_id, via: `automation:${id}` } : {};
    }
    if (p.startsWith('bet:')) {
      const id = p.slice('bet:'.length);
      const b = db.prepare('SELECT goal_id FROM bets WHERE id = ?').get<{ goal_id: string }>(id);
      return b ? { goalId: b.goal_id, betId: id, via: `bet:${id}` } : {};
    }
    // A poke resumes the CALLER with a delegate's result; its source names that delegate (`task:<id>`,
    // `bet:<id>`, …), whose context is the caller's own — it filed the delegate for that work.
    if (p.startsWith('poke:')) return workContextFor(db, p.slice('poke:'.length), depth + 1);
  } catch { /* advisory: an unresolved context just means the task is filed unlinked */ }
  return {};
}

function goalExists(db: Db, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM goals WHERE id = ?').get(id);
}
