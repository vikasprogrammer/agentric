/**
 * Cockpit intent classifier — decides what KIND of ask a free-text message is, so the front door does
 * the right thing instead of always spawning an agent session:
 *   - `work`   → the user wants an agent to DO something → route to an agent (Chat or Terminal).
 *   - `ask`    → a question ABOUT the workspace ("which agents are idle?", "how do automations work?")
 *                → answer inline (LLM over a compact workspace context), NO session.
 *   - `action` → a request to operate an OS primitive ("schedule the churn agent every morning", "create
 *                a task to…") → deep-link into that surface (Automations/Tasks); execution stays human-driven.
 *
 * Deterministic + fail-safe: classification needs no LLM (so it works on any workspace), and the default
 * is `work` — the safe fallback, since an agent can handle anything. Only a clear signal diverts to
 * `ask`/`action`. The `ask` ANSWER needs an LLM, but the CLASSIFICATION here never does.
 */

export type Intent = 'work' | 'ask' | 'action';

export interface IntentResult {
  intent: Intent;
  /** For `action`: which primitive surface the request maps to. */
  surface?: 'automations' | 'tasks';
}

// A request to stand up a recurring/scheduled run, or an explicit "create a task" → an OS primitive.
const SCHEDULE_RE = /\b(schedul(e|ing)|automat(e|ion)|recurring|every\s+(morning|day|night|week|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|hourly|nightly|each\s+(day|morning|week)|set\s+up\s+a?\s*(cron|automation|schedule)|remind\s+me)\b/i;
const TASK_RE = /\b(create|add|open|file|make|log)\s+(a\s+|an\s+|the\s+)?(task|to-?do|ticket|work\s*item)\b/i;

// Meta-nouns that mean "about the agent-os / this workspace" rather than a domain topic an agent works on.
const OS_NOUN_RE = /\b(agent|agents|fleet|session|sessions|automation|automations|task|tasks|memory|memories|polic(y|ies)|approval|approvals|budget|spend|cost|costs|audit|team|member|members|skill|skills|connector|connectors|integration|integrations|knowledge\s*base|\bkb\b|agent\s*-?\s*os|this\s+(system|workspace|console)|the\s+(system|fleet|workspace))\b/i;
// Question-shaped openers (also matched by a trailing '?').
const QUESTION_RE = /^(how|what|which|why|when|who|whose|where|is|are|am|do|does|did|can|could|should|would|will|list|show|tell\s+me|explain|describe|give\s+me|summar(y|ise|ize)|status)\b/i;

/** Classify a message. Pure, synchronous, LLM-free. */
export function classifyIntent(text: string): IntentResult {
  const t = (text || '').trim();
  if (!t) return { intent: 'work' };

  // 1) Action — an explicit request to operate a primitive. Checked first: "schedule …" is unambiguous.
  if (TASK_RE.test(t)) return { intent: 'action', surface: 'tasks' };
  if (SCHEDULE_RE.test(t)) return { intent: 'action', surface: 'automations' };

  // 2) Ask — a question that's ABOUT the workspace (question-shaped or '?'-terminated, AND references an
  //    OS meta-noun). "how do I fix my pod" is question-shaped but about a DOMAIN thing (pod) → stays
  //    `work` (an agent answers). "which agents are idle" references an OS noun → `ask`.
  const questionish = QUESTION_RE.test(t) || /\?\s*$/.test(t);
  if (questionish && OS_NOUN_RE.test(t)) return { intent: 'ask' };

  // 3) Default — hand it to an agent.
  return { intent: 'work' };
}
