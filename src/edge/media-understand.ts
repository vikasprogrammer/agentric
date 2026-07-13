/**
 * Media UNDERSTANDING (video/image → text) — the inverse of the generation tools. Claude can't natively
 * watch a video, so this delegates to one of Atlas's video-capable multimodal LLMs (input modalities
 * text+image+video) via the OpenAI-compatible chat endpoint: a message carrying a `video_url` content
 * part (a URL or a base64 `data:` URL) + a text question returns a text answer the agent reads directly.
 *
 * Verified live: `{type:'video_url', video_url:{url}}` is the content shape Atlas's video LLMs accept
 * (qwen3.5, glm-5v, kimi-k2…); a `{type:'video'}` shape is silently ignored by the model.
 */

/** A solid default: mid-size, reliably describes motion/content. Overridable per call. */
export const DEFAULT_VIDEO_UNDERSTAND_MODEL = 'qwen/qwen3.5-27b';

export interface UnderstandRequest {
  atlasKey: string;
  baseUrl?: string;
  model?: string;
  /** A URL or base64 data: URL for the media. */
  mediaUrl: string;
  /** 'video' or 'image' — selects the content-part type. */
  kind: 'video' | 'image';
  prompt: string;
}

export interface UnderstandResult {
  text: string;
  model: string;
  costUsd?: number; // when the vendor reports usage cost (rare); else undefined → caller estimates
}

function errText(body: unknown, status: number): string {
  const b = body as { error?: { message?: string } | string; message?: string; msg?: string } | undefined;
  const e = b?.error;
  const msg = (typeof e === 'string' ? e : e?.message) || b?.message || b?.msg;
  return msg ? `Atlas understand error (${status}): ${msg}` : `Atlas understand error (${status})`;
}

export async function understandMedia(req: UnderstandRequest): Promise<UnderstandResult> {
  const base = (req.baseUrl?.trim() || 'https://api.atlascloud.ai').replace(/\/+$/, '');
  const model = req.model?.trim() || DEFAULT_VIDEO_UNDERSTAND_MODEL;
  const partType = req.kind === 'video' ? 'video_url' : 'image_url';
  const content = [
    { type: 'text', text: req.prompt },
    { type: partType, [partType]: { url: req.mediaUrl } },
  ];
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${req.atlasKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  const d = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    usage?: { cost?: number };
  } & Record<string, unknown>;
  if (!res.ok) throw new Error(errText(d, res.status));
  const text = d.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('the model returned no text');
  return { text, model, costUsd: typeof d.usage?.cost === 'number' ? d.usage.cost : undefined };
}
