/**
 * Agent router — automatic agent selection from a natural-language message.
 *
 * The `/agent-name` chat router (Automations.routeChat) requires the sender to KNOW which agent they
 * want and prefix it. This module is the automatic counterpart: given an unaddressed message ("my pod
 * is down", "refund on invoice 4821"), it infers the best-fit claude-code agent so a Slack/Discord/web
 * message — or a support ticket — reaches the right teammate without anyone naming one.
 *
 * Every signal is mapped onto a common **0..1 confidence** by *absolute saturation* (not min-max, which
 * makes the best-of-a-bad-batch look confident and would route "hello there" the moment embeddings turn
 * on). Matching is **deterministic first** (idf-weighted token overlap over each agent's id + description
 * + example prompts), with two opt-in upgrades that only run when configured:
 *   - **embedding blend** — cosine(message, agent-profile) averaged with the keyword confidence, closing
 *     the lexical gap ("refund" ≈ an agent whose description says "invoice/billing"). Uses the router's
 *     OWN embedder config, falling back to the memory embedder — so a tenant on the automem/libsql memory
 *     backend (whose embeddings aren't a local `Embedder`) can still route semantically.
 *   - **LLM tie-break** — on a near-tie, a cheap chat model picks the winner; absent/unsure, we fall
 *     through to disambiguation (asking the human), never a coin-flip.
 *
 * The design **fails safe**: a confident win routes silently, a near-tie or weak match asks the human
 * to disambiguate, and nothing-scored falls back to the `/agent` help list. A wrong SILENT route is the
 * only bad outcome, and it's gated behind a clear score margin. The router only PICKS an id — the spawn
 * is still fully governed downstream (provenance, run-as, gate hook), so routing carries no privilege.
 */
import { AgentManifest, EmbeddingsConfig, RouterConfig } from '../types';
import { AgentOS } from '../kernel';

export interface RouterCandidate {
  agentId: string;
  /** 0..1 confidence (smooth-saturated), used for the viability floor + the route-confidence gate. */
  score: number;
  /** Pre-saturation raw score, carried for the top-vs-second MARGIN test — saturation compresses the top
   *  (two strong-but-different candidates both approach 1), so margin is judged on the raw separation. */
  raw?: number;
}

/** The router's verdict for one message. `route` → spawn it; `disambiguate` → ask the human to pick
 *  among `candidates`; `none` → nothing scored, fall back to the help list. */
export type RouteDecision =
  | { kind: 'route'; agentId: string; score: number; runnerUp?: RouterCandidate; method: 'keyword' | 'embedding' | 'llm' }
  | { kind: 'disambiguate'; candidates: RouterCandidate[] }
  | { kind: 'none' };

// All scores live on a 0..1 confidence scale (smooth saturation, below), so the thresholds are
// scale-stable whether or not the embedder is on. Three bands: `minScore` = the floor to be a candidate
// at all; `routeConfidence` = how strong the winner must be to route SILENTLY (below it, but viable →
// ask); `margin` = the raw top-vs-second separation the winner must also clear to route.
const DEFAULTS = { minScore: 0.22, routeConfidence: 0.5, margin: 0.15 };

// Smooth saturation maps a raw score onto 0..1 (`raw/(raw+K)`) — monotonic, so it PRESERVES ordering (a
// raw 0 stays 0, so a no-signal message can't be normalized into a confident route; two strong-but-
// different candidates keep distinct scores, unlike a hard clamp that pins both to 1). The margin test
// still uses the RAW separation, where the true gap lives.
const KW_SAT = 1.5; //  a raw idf-overlap of 1.5 → keyword confidence 0.5; a clear multi-term intent → ~1.
const COS_LO = 0.22; // cosine below this is noise → 0.
const COS_HI = 0.55; // cosine at/above this → 1 (cosine's "clearly related text" band is ~0.22–0.55).

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothSat = (raw: number) => (raw > 0 ? raw / (raw + KW_SAT) : 0);

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
 * profile tokens, normalized by message length then saturated to a 0..1 confidence. Rare-to-the-fleet
 * terms ("billing", "kubernetes") discriminate; terms every agent shares contribute ~0. Pure and
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
      const raw = s / norm;
      return { agentId: p.id, score: smoothSat(raw), raw };
    })
    .sort((x, y) => y.score - x.score);
}

/**
 * Turn a sorted candidate list into a decision under the three confidence bands. Pure.
 *   - nothing clears `minScore` → none (help list).
 *   - one lone viable candidate → route it (asking to pick from a list of one is pointless).
 *   - top clears `routeConfidence` AND beats the runner-up by `margin` (on RAW) → route silently.
 *   - otherwise (viable but not confident, or a close top-two) → disambiguate.
 */
export function decide(scored: RouterCandidate[], cfg: RouterConfig): RouteDecision {
  const minScore = cfg.minScore ?? DEFAULTS.minScore;
  const routeConf = cfg.routeConfidence ?? DEFAULTS.routeConfidence;
  const margin = cfg.margin ?? DEFAULTS.margin;
  const viable = scored.filter((c) => c.score >= minScore);
  const top = viable[0];
  const second = viable[1];
  if (!top) return { kind: 'none' };
  if (!second) return { kind: 'route', agentId: top.agentId, score: top.score, method: 'keyword' };
  const rTop = top.raw ?? top.score;
  const gap = rTop > 0 ? (rTop - (second.raw ?? second.score)) / rTop : 0;
  if (top.score >= routeConf && gap >= margin) {
    return { kind: 'route', agentId: top.agentId, score: top.score, runnerUp: second, method: 'keyword' };
  }
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

/** The router's embedder config: its OWN (`router_config.embeddings`) first, else the memory backend's
 *  local embedder (`memory.sqlite.embeddings`). The fallback means an sqlite-memory tenant needs no extra
 *  setup; the router-owned field is what lets an automem/libsql tenant (no local `Embedder`) route
 *  semantically. Returns undefined when neither is set → the embedding blend stays off. */
function resolveEmbeddings(os: AgentOS, cfg: RouterConfig): EmbeddingsConfig | undefined {
  return cfg.embeddings ?? os.settings.memoryConfig()?.sqlite?.embeddings;
}

// Agent-profile vectors change rarely (only on an agent edit), but a message routes often — so cache the
// per-agent embedding keyed by embedder + agent + a cheap profile hash. Steady state = ONE embed call per
// route (the message), not one-per-agent. Process-local, unbounded-but-tiny (fleet-sized).
const agentVecCache = new Map<string, number[]>();
function profileHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * The full async router: deterministic scoring, an optional embedding blend when an embedder is
 * configured, and an optional LLM tie-break on a near-tie. Returns a fail-safe decision.
 */
export async function chooseAgent(os: AgentOS, text: string): Promise<RouteDecision> {
  const cfg = os.settings.routerConfig();
  const agents = [...os.agents.values()].filter((a) => a.runtime === 'claude-code');
  if (agents.length === 0) return { kind: 'none' };

  let scored = scoreAgents(text, agents);
  if (scored.length === 0) return { kind: 'none' };

  // Optional embedding blend: cosine(message, profile) averaged with the keyword confidence. Only when an
  // embedder resolves AND the message embeds cleanly; any failure silently keeps the keyword rank.
  const embedded = await tryEmbeddingBlend(os, cfg, text, agents, scored);
  if (embedded) scored = embedded;

  const decision = decide(scored, cfg);

  // Near-tie → try the LLM tie-break before bothering the human. A clear pick routes; unsure → disambiguate.
  if (decision.kind === 'disambiguate' && cfg.llm?.model) {
    const pick = await llmTieBreak(os, cfg, text, decision.candidates, agents);
    if (pick) {
      const c = decision.candidates.find((x) => x.agentId === pick);
      if (c) return { kind: 'route', agentId: c.agentId, score: c.score, runnerUp: decision.candidates.find((x) => x.agentId !== pick), method: 'llm' };
    }
  }
  return decision;
}

async function tryEmbeddingBlend(
  os: AgentOS,
  cfg: RouterConfig,
  text: string,
  agents: AgentManifest[],
  keyword: RouterCandidate[],
): Promise<RouterCandidate[] | null> {
  const emb = resolveEmbeddings(os, cfg);
  if (!emb) return null;
  try {
    const { Embedder } = await import('../memory/embedding');
    const embedder = new Embedder(emb);
    const qv = await embedder.embed(text);
    if (!qv) return null;
    const byId = new Map(keyword.map((c) => [c.agentId, c.score]));
    const blended: RouterCandidate[] = [];
    for (const a of agents) {
      const profile = agentProfile(a).slice(0, 2000);
      const cacheKey = `${embedder.label}:${a.id}:${profileHash(profile)}`;
      let av = agentVecCache.get(cacheKey);
      if (!av) {
        const v = await embedder.embed(profile);
        if (v) agentVecCache.set(cacheKey, (av = v));
      }
      const cos01 = av ? clamp01((cosine(qv, av) - COS_LO) / (COS_HI - COS_LO)) : 0;
      const kw01 = byId.get(a.id) ?? 0;
      const score = (kw01 + cos01) / 2; // agreement between channels → toward 1
      blended.push({ agentId: a.id, score, raw: score }); // already 0..1 + continuous → margin on it directly
    }
    return blended.sort((x, y) => y.score - x.score);
  } catch {
    return null;
  }
}

async function llmTieBreak(
  os: AgentOS,
  cfg: RouterConfig,
  text: string,
  candidates: RouterCandidate[],
  agents: AgentManifest[],
): Promise<string | null> {
  const emb = resolveEmbeddings(os, cfg);
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
