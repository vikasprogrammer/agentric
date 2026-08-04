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

export type Intent = 'work' | 'ask' | 'action' | 'social';

/** The friendly reply to a bare greeting / chit-chat — instead of dumping the agent roster. */
export const SOCIAL_REPLY =
  "👋 Happy to help — ask me a question about your workspace, or tell me what you need done and I'll get the right agent on it.";

export interface IntentResult {
  intent: Intent;
  /** For `action`: which primitive surface the request maps to. */
  surface?: 'automations' | 'tasks';
}

// A request to stand up a recurring/scheduled run, or an explicit "create a task" → an OS primitive.
// A scheduling VERB or recurrence, or an explicit "create/set up an automation/cron". Deliberately does
// NOT match the bare noun "automation(s)" — "what's an automation?" / "how do automations work?" are
// questions (→ ask), not requests to build one (which need a verb: "schedule …", "automate …",
// "set up an automation", or a recurrence like "every morning").
const SCHEDULE_RE = /\b(schedul(e|ing)|automate|recurring|every\s+(morning|day|night|week|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|hourly|nightly|each\s+(day|morning|week)|remind\s+me)\b|\b(create|set\s*up|add|make|configure)\s+(a\s+|an\s+|the\s+)?(automation|cron(\s*job)?|schedule)\b/i;
const TASK_RE = /\b(create|add|open|file|make|log)\s+(a\s+|an\s+|the\s+)?(task|to-?do|ticket|work\s*item)\b/i;

// Meta-nouns that mean "about the agent-os / this workspace" rather than a domain topic an agent works on.
const OS_NOUN_RE = /\b(agent|agents|fleet|session|sessions|automation|automations|task|tasks|memory|memories|polic(y|ies)|approval|approvals|budget|spend|cost|costs|audit|team|member|members|skill|skills|connector|connectors|integration|integrations|knowledge\s*base|\bkb\b|agent\s*-?\s*os|this\s+(system|workspace|console)|the\s+(system|fleet|workspace))\b/i;
// Question-shaped openers (also matched by a trailing '?').
const QUESTION_RE = /^(how|what|which|why|when|who|whose|where|is|are|am|do|does|did|can|could|should|would|will|list|show|tell\s+me|explain|describe|give\s+me|summar(y|ise|ize)|status)\b/i;
// A bare greeting / thanks / small-talk — no task, no workspace question. Only `social` when it ALSO has
// no OS meta-noun ("good morning, how many tasks?" is a real question, not chit-chat — see classifyIntent).
const GREETING_RE = /^(hi+|hey+|hello|yo|sup|howdy|hiya|gm|gn|good\s+(morning|afternoon|evening|night)|thank(s| you)|thx|ty|cheers)\b|^(how\s+are\s+you|how'?s\s+it\s+going|what'?s\s+up|wass?up|greetings)\b/i;

/** Classify a message. Pure, synchronous, LLM-free. */
export function classifyIntent(text: string): IntentResult {
  const t = (text || '').trim();
  if (!t) return { intent: 'work' };

  // 1) Action — an explicit request to operate a primitive. Checked first: "schedule …" is unambiguous.
  if (TASK_RE.test(t)) return { intent: 'action', surface: 'tasks' };
  if (SCHEDULE_RE.test(t)) return { intent: 'action', surface: 'automations' };

  // Greeting / chit-chat with no workspace content → a friendly reply, not routing or a roster dump. Only
  // a SHORT pure greeting counts — "hello, I need help reviewing a PR" is a request wearing a greeting.
  if (GREETING_RE.test(t) && !OS_NOUN_RE.test(t) && t.split(/\s+/).filter(Boolean).length <= 5) return { intent: 'social' };

  // 2) Ask — a question that's ABOUT the workspace (question-shaped or '?'-terminated, AND references an
  //    OS meta-noun). "how do I fix my pod" is question-shaped but about a DOMAIN thing (pod) → stays
  //    `work` (an agent answers). "which agents are idle" references an OS noun → `ask`.
  const questionish = QUESTION_RE.test(t) || /\?\s*$/.test(t);
  if (questionish && OS_NOUN_RE.test(t)) return { intent: 'ask' };

  // 3) Default — hand it to an agent.
  return { intent: 'work' };
}
