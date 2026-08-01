/**
 * Tiny chat-completion helper, shared by the router's near-tie tie-break and the Cockpit `ask` tier
 * (answering questions about the workspace). Two backends, resolved in priority order:
 *   1. **Native Anthropic** (`/v1/messages`) — used whenever an Anthropic key is configured (Settings →
 *      Integrations, or the `ANTHROPIC_API_KEY` env var). First-party Claude, defaults to Haiku — fast +
 *      cheap for a lightweight workspace Q&A. Raw `fetch`, no SDK dependency.
 *   2. **OpenAI-compatible** (`/chat/completions`) — the fallback, from `router_config.llm` or the memory
 *      embedder's endpoint.
 * Returns null on any failure (no config, network, non-200, malformed) so every caller degrades
 * gracefully rather than throwing (→ the concierge run, then routing).
 */
import { AgentOS } from '../kernel';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5'; // fastest + cheapest; ample for the ask tier.

export type LlmConfig =
  | { provider: 'anthropic'; apiKey: string; model: string }
  | { provider: 'openai'; url: string; apiKey?: string; model: string };

/** Resolve the chat LLM. Native Anthropic first (a key present ⇒ use it), else an OpenAI-compatible
 *  endpoint (`router_config.llm`, falling back to the resolved embedder). Null when neither is set. */
export function resolveLlm(os: AgentOS): LlmConfig | null {
  const key = os.settings.anthropicKey();
  if (key) return { provider: 'anthropic', apiKey: key, model: os.settings.anthropicModel() };
  const rc = os.settings.routerConfig();
  const emb = rc.embeddings ?? os.settings.memoryConfig()?.sqlite?.embeddings;
  const url = (rc.llm?.url || emb?.url || '').replace(/\/$/, '');
  const apiKey = rc.llm?.apiKey || emb?.apiKey;
  const model = rc.llm?.model;
  return url && model ? { provider: 'openai', url, apiKey, model } : null;
}

/** Run a completion against the resolved backend; return the assistant text (trimmed) or null. */
export async function chatComplete(
  llm: LlmConfig,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<string | null> {
  return llm.provider === 'anthropic' ? anthropicComplete(llm, messages, opts) : openaiComplete(llm, messages, opts);
}

// Native Anthropic Messages API. `system` is a top-level field there (not a message role), so we split
// system turns out. No `thinking`/`effort` — Haiku doesn't support them, and a short factual answer
// doesn't need them. Auth is `x-api-key` + the required `anthropic-version` header.
async function anthropicComplete(
  llm: { apiKey: string; model: string },
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string | null> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''); // SDK-convention override (also lets tests point at a stub)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15000);
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: llm.model, max_tokens: opts?.maxTokens ?? 400, ...(system ? { system } : {}), messages: turns }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI-compatible /chat/completions.
async function openaiComplete(
  llm: { url: string; apiKey?: string; model: string },
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15000);
  try {
    const res = await fetch(`${llm.url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
      body: JSON.stringify({ model: llm.model, temperature: opts?.temperature ?? 0, max_tokens: opts?.maxTokens ?? 400, messages }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = (json.choices?.[0]?.message?.content || '').trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
