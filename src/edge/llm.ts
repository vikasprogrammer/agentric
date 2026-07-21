/**
 * Tiny OpenAI-compatible chat-completion helper, shared by the router's near-tie tie-break and the
 * Cockpit `ask` tier (answering questions about the workspace). Endpoint/key/model resolve from the
 * router's own config first (`router_config.llm`), falling back to the router/memory embedder's endpoint
 * — so a workspace that configured either gets an LLM here for free. Returns null on any failure (no
 * config, network, non-200, malformed) so every caller degrades gracefully rather than throwing.
 */
import { AgentOS } from '../kernel';

export interface LlmConfig {
  url: string;
  apiKey?: string;
  model: string;
}

/** Resolve the chat LLM: `router_config.llm` (model required), with url/apiKey falling back to the
 *  resolved embedder (router-owned, else memory sqlite). Null when no model+endpoint is available. */
export function resolveLlm(os: AgentOS): LlmConfig | null {
  const rc = os.settings.routerConfig();
  const emb = rc.embeddings ?? os.settings.memoryConfig()?.sqlite?.embeddings;
  const url = (rc.llm?.url || emb?.url || '').replace(/\/$/, '');
  const apiKey = rc.llm?.apiKey || emb?.apiKey;
  const model = rc.llm?.model;
  return url && model ? { url, apiKey, model } : null;
}

/** POST /chat/completions; return the assistant text (trimmed) or null on any failure. */
export async function chatComplete(
  llm: LlmConfig,
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
