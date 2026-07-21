/**
 * Agent router — automatic agent selection from a natural-language message.
 *
 * The `/agent-name` chat router (Automations.routeChat) requires the sender to KNOW which agent they
 * want and prefix it. This module is the automatic counterpart: given an unaddressed message ("my pod
 * is down", "refund on invoice 4821"), it infers the best-fit claude-code agent so a Slack/Discord/web
 * message — or a support ticket — reaches the right teammate without anyone naming one.
 *
 * Matching is **deterministic first** (idf-weighted token overlap over each agent's id + description +
 * example prompts), with two opt-in upgrades that only ever run when configured:
 *   - **embedding blend** — when a memory embedder is configured, cosine(message, agent-profile) is
 *     min-max blended with the keyword score for nuance the bag-of-words misses.
 *   - **LLM tie-break** — on a near-tie, a cheap chat model picks the winner; absent/unsure, we fall
 *     through to disambiguation (asking the human), never a coin-flip.
 *
 * The design **fails safe**: a confident win routes silently, a near-tie or weak match asks the human
 * to disambiguate, and nothing-scored falls back to the `/agent` help list. A wrong SILENT route is the
 * only bad outcome, and it's gated behind a clear score margin. The router only PICKS an id — the spawn
 * is still fully governed downstream (provenance, run-as, gate hook), so routing carries no privilege.
 */
import { AgentManifest, RouterConfig } from '../types';
import { AgentOS } from '../kernel';

export interface RouterCandidate {
  agentId: string;
  score: number;
}

/** The router's verdict for one message. `route` → spawn it; `disambiguate` → ask the human to pick
 *  among `candidates`; `none` → nothing scored, fall back to the help list. */
export type RouteDecision =
  | { kind: 'route'; agentId: string; score: number; runnerUp?: RouterCandidate; method: 'keyword' | 'embedding' | 'llm' }
  | { kind: 'disambiguate'; candidates: RouterCandidate[] }
  | { kind: 'none' };

const DEFAULTS = { minScore: 0.5, margin: 0.3 };

// Common words that carry no routing signal — dropped from both the message and agent profiles so the
// idf weighting isn't diluted. Deliberately small: idf already suppresses fleet-wide-common terms.
const STOPWORDS = new Set(
  ('a an and the is are was were be been being to of in on for with at by from as it its this that these those ' +
    'i you he she we they me my your our their can could would should will shall do does did done have has had ' +
    'not no yes please help need want get got make made about into out up down over under again then than so ' +
    'what why how when where who which whom whose there here just now new use used using via each any all some ' +
    'if or but because while during before after').split(/\s+/),
);

/** Lowercase, split on non-alphanumerics, drop stopwords and <3-char tokens. */
export function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** The routing corpus for one agent: its id (de-slugged), description, category and example prompts —
 *  everything the agent advertises about what it's for. */
function agentProfile(a: AgentManifest): string {
  return [a.id.replace(/[-_]+/g, ' '), a.description || '', a.category || '', ...(a.examplePrompts || [])].join(' \n ');
}

/**
 * Deterministic keyword scoring: idf-weighted overlap between the message tokens and each agent's
 * profile tokens, normalized by message length so scores are comparable across messages. Rare-to-the-
 * fleet terms ("billing", "kubernetes") discriminate; terms every agent shares contribute ~0. Pure and
 * synchronous — the unit-testable core. Returns candidates sorted best-first.
 */
export function scoreAgents(text: string, agents: AgentManifest[]): RouterCandidate[] {
  const msgTokens = [...new Set(tokenize(text))];
  if (msgTokens.length === 0 || agents.length === 0) return [];
  const profiles = agents.map((a) => ({ id: a.id, tokens: new Set(tokenize(agentProfile(a))) }));
  const N = profiles.length;
  const df = new Map<string, number>();
  for (const p of profiles) for (const t of p.tokens) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t: string) => Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
  const norm = Math.sqrt(msgTokens.length);
  return profiles
    .map((p) => {
      let s = 0;
      for (const t of msgTokens) if (p.tokens.has(t)) s += idf(t);
      return { agentId: p.id, score: s / norm };
    })
    .sort((x, y) => y.score - x.score);
}

/** Turn a sorted candidate list into a decision under the confidence thresholds. Pure. */
export function decide(scored: RouterCandidate[], cfg: RouterConfig): RouteDecision {
  const minScore = cfg.minScore ?? DEFAULTS.minScore;
  const margin = cfg.margin ?? DEFAULTS.margin;
  const viable = scored.filter((c) => c.score > 0);
  const top = viable[0];
  const second = viable[1];
  if (!top || top.score < minScore) {
    // No candidate clears the floor. If two-plus at least registered, let the human pick; else help list.
    return viable.length >= 2 ? { kind: 'disambiguate', candidates: viable.slice(0, 3) } : { kind: 'none' };
  }
  if (!second) return { kind: 'route', agentId: top.agentId, score: top.score, method: 'keyword' };
  const gap = (top.score - second.score) / top.score;
  if (gap >= margin) return { kind: 'route', agentId: top.agentId, score: top.score, runnerUp: second, method: 'keyword' };
  return { kind: 'disambiguate', candidates: viable.slice(0, 3) };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
function cosine(a: number[], b: number[]): number {
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  return na && nb ? dot(a, b) / (na * nb) : 0;
}
/** Min-max scale a list to 0..1 (flat list → all 0). */
function minmax(xs: number[]): number[] {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const span = hi - lo;
  return span > 0 ? xs.map((x) => (x - lo) / span) : xs.map(() => 0);
}

/**
 * The full async router: deterministic scoring, an optional embedding blend when a memory embedder is
 * configured, and an optional LLM tie-break on a near-tie. Returns a fail-safe decision.
 */
export async function chooseAgent(os: AgentOS, text: string): Promise<RouteDecision> {
  const cfg = os.settings.routerConfig();
  const agents = [...os.agents.values()].filter((a) => a.runtime === 'claude-code');
  if (agents.length === 0) return { kind: 'none' };

  let scored = scoreAgents(text, agents);
  if (scored.length === 0) return { kind: 'none' };

  // Optional embedding blend: cosine(message, profile) min-max-blended with the keyword score. Only when
  // an embedder is configured AND the message embeds cleanly; any failure silently keeps the keyword rank.
  const embedded = await tryEmbeddingBlend(os, text, agents, scored);
  if (embedded) scored = embedded;

  const decision = decide(scored, cfg);

  // Near-tie → try the LLM tie-break before bothering the human. A clear pick routes; unsure → disambiguate.
  if (decision.kind === 'disambiguate' && cfg.llm?.model) {
    const pick = await llmTieBreak(os, text, decision.candidates, agents, cfg);
    if (pick) {
      const c = decision.candidates.find((x) => x.agentId === pick);
      if (c) return { kind: 'route', agentId: c.agentId, score: c.score, runnerUp: decision.candidates.find((x) => x.agentId !== pick), method: 'llm' };
    }
  }
  return decision;
}

async function tryEmbeddingBlend(
  os: AgentOS,
  text: string,
  agents: AgentManifest[],
  keyword: RouterCandidate[],
): Promise<RouterCandidate[] | null> {
  const emb = os.settings.memoryConfig()?.sqlite?.embeddings;
  if (!emb) return null;
  try {
    const { Embedder } = await import('../memory/embedding');
    const embedder = new Embedder(emb);
    const qv = await embedder.embed(text);
    if (!qv) return null;
    const byId = new Map(keyword.map((c) => [c.agentId, c.score]));
    const cos: { agentId: string; c: number }[] = [];
    for (const a of agents) {
      const av = await embedder.embed(agentProfile(a).slice(0, 2000));
      cos.push({ agentId: a.id, c: av ? cosine(qv, av) : 0 });
    }
    const kn = minmax(agents.map((a) => byId.get(a.id) ?? 0));
    const cn = minmax(cos.map((x) => x.c));
    return agents
      .map((a, i) => ({ agentId: a.id, score: (kn[i] + cn[i]) / 2 }))
      .sort((x, y) => y.score - x.score);
  } catch {
    return null;
  }
}

async function llmTieBreak(
  os: AgentOS,
  text: string,
  candidates: RouterCandidate[],
  agents: AgentManifest[],
  cfg: RouterConfig,
): Promise<string | null> {
  const emb = os.settings.memoryConfig()?.sqlite?.embeddings;
  const url = (cfg.llm?.url || emb?.url || '').replace(/\/$/, '');
  const apiKey = cfg.llm?.apiKey || emb?.apiKey;
  const model = cfg.llm?.model;
  if (!url || !model) return null;
  const roster = candidates
    .map((c) => {
      const a = agents.find((x) => x.id === c.agentId);
      return `- ${c.agentId}: ${(a?.description || '').slice(0, 200)}`;
    })
    .join('\n');
  const sys =
    'You route an incoming message to exactly one agent. Reply with ONLY the agent id from the list, ' +
    'or the single word UNSURE if none clearly fits. No punctuation, no explanation.';
  const user = `Agents:\n${roster}\n\nMessage:\n${text.slice(0, 1500)}\n\nBest agent id:`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 24, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = (json.choices?.[0]?.message?.content || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
    const hit = candidates.find((c) => c.agentId === raw);
    return hit ? hit.agentId : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
