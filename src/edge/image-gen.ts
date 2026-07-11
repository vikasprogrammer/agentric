/**
 * Image generation — the backend behind the OS-owned `image_generate` MCP tool.
 *
 * Claude can't draw natively, so this is a first-class capability: an agent asks for an image, the
 * bytes are snapshotted into the Artifacts gallery, and the run is governed (policy-classified on the
 * estimated cost, audited with the real cost). This module is ONLY the vendor call — it takes a prompt,
 * returns image bytes + the real USD cost when the vendor reports it. Governance/artifact wiring lives
 * in `TerminalManager.generateImage`.
 *
 * The vendor is behind a small `ImageBackend` interface with two adapters, picked by whichever key is
 * configured (Settings → Integrations):
 *  - **OpenRouter** (default) — one Bearer POST reaches 30+ models via a normalized `model` param, and
 *    every response's `usage.cost` is the exact USD we debit. No static price table.
 *  - **Atlas Cloud** — OpenAI-compatible images endpoint; also covers video later under one key. Cost
 *    isn't guaranteed in the response, so we fall back to the per-image estimate for metering.
 *
 * Both normalize the two return shapes (a URL to download, or inline base64) into raw bytes, since the
 * gallery stores bytes and vendor URLs (e.g. FLUX's) can expire within minutes.
 */

/** A conservative default per-image cost, used ONLY for the pre-generation policy gate (the money-cap
 *  rule) when the backend can't be asked ahead of time. The AUDIT records the real cost when known. */
export const DEFAULT_IMAGE_COST_USD = 0.05;

export interface GeneratedImage {
  bytes: Buffer;
  ext: string; // 'png' | 'jpg' | 'webp' — drives the artifact filename + mime
}

export interface ImageGenResult {
  images: GeneratedImage[];
  model: string; // the model actually used (as reported/requested)
  costUsd?: number; // real USD cost when the vendor reports it (OpenRouter usage.cost); else undefined
}

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  size?: string; // e.g. '1024x1024'; passed through, vendor clamps
  n: number;
}

export interface ImageBackend {
  readonly name: 'openrouter' | 'atlas';
  readonly defaultModel: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}

/** What the factory needs from Settings — passed in (not the whole store) to keep this testable. */
export interface ImageBackendConfig {
  openRouterKey?: string;
  atlasKey?: string;
  atlasBaseUrl?: string; // override; default below
  defaultModel?: string; // workspace override for the default model
}

/** Pick a backend from configured keys. OpenRouter wins when both are set (verified cost telemetry). */
export function resolveImageBackend(cfg: ImageBackendConfig): ImageBackend | undefined {
  if (cfg.openRouterKey && cfg.openRouterKey.trim()) {
    return new OpenRouterBackend(cfg.openRouterKey.trim(), cfg.defaultModel);
  }
  if (cfg.atlasKey && cfg.atlasKey.trim()) {
    return new AtlasBackend(cfg.atlasKey.trim(), cfg.atlasBaseUrl, cfg.defaultModel);
  }
  return undefined;
}

// ── shared helpers ──────────────────────────────────────────────────────────

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Turn one vendor image entry (a URL or inline base64) into raw bytes + a file extension. */
async function toBytes(entry: { url?: string; b64_json?: string; b64?: string }): Promise<GeneratedImage> {
  const b64 = entry.b64_json ?? entry.b64;
  if (b64) {
    const comma = b64.indexOf(','); // tolerate a data: URI prefix
    const raw = comma >= 0 && b64.slice(0, comma).includes('base64') ? b64.slice(comma + 1) : b64;
    return { bytes: Buffer.from(raw, 'base64'), ext: 'png' };
  }
  if (entry.url) {
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`fetching generated image failed (${res.status})`);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = EXT_BY_MIME[ct] || extFromUrl(entry.url) || 'png';
    return { bytes: buf, ext };
  }
  throw new Error('vendor returned an image with neither a url nor base64 data');
}

function extFromUrl(url: string): string | undefined {
  const m = /\.(png|jpe?g|webp|gif)(?:\?|#|$)/i.exec(url);
  if (!m) return undefined;
  const e = m[1].toLowerCase();
  return e === 'jpeg' ? 'jpg' : e;
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

interface OpenRouterResponse {
  data?: { url?: string; b64_json?: string }[];
  images?: { url?: string; b64_json?: string }[];
  usage?: { cost?: number };
  error?: { message?: string } | string;
}

class OpenRouterBackend implements ImageBackend {
  readonly name = 'openrouter' as const;
  readonly defaultModel: string;
  constructor(private readonly key: string, defaultModel?: string) {
    this.defaultModel = defaultModel?.trim() || 'google/gemini-3.1-flash-image-preview';
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model?.trim() || this.defaultModel;
    const body: Record<string, unknown> = { model, prompt: req.prompt, n: req.n };
    if (req.size) body.size = req.size;
    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = (await res.json().catch(() => ({}))) as OpenRouterResponse;
    if (!res.ok) throw new Error(errMsg(d, res.status));
    const entries = d.data ?? d.images ?? [];
    if (!entries.length) throw new Error('OpenRouter returned no images');
    const images = await Promise.all(entries.map(toBytes));
    return { images, model, costUsd: typeof d.usage?.cost === 'number' ? d.usage.cost : undefined };
  }
}

// ── Atlas Cloud (OpenAI-compatible images endpoint) ──────────────────────────

class AtlasBackend implements ImageBackend {
  readonly name = 'atlas' as const;
  readonly defaultModel: string;
  private readonly base: string;
  constructor(private readonly key: string, baseUrl?: string, defaultModel?: string) {
    this.base = (baseUrl?.trim() || 'https://api.atlascloud.ai/v1').replace(/\/+$/, '');
    this.defaultModel = defaultModel?.trim() || 'flux.2';
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model?.trim() || this.defaultModel;
    const body: Record<string, unknown> = { model, prompt: req.prompt, n: req.n };
    if (req.size) body.size = req.size;
    const res = await fetch(`${this.base}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = (await res.json().catch(() => ({}))) as OpenRouterResponse;
    if (!res.ok) throw new Error(errMsg(d, res.status));
    const entries = d.data ?? d.images ?? [];
    if (!entries.length) throw new Error('Atlas returned no images');
    const images = await Promise.all(entries.map(toBytes));
    // Atlas doesn't reliably report cost in-band; caller falls back to the per-image estimate.
    return { images, model, costUsd: typeof d.usage?.cost === 'number' ? d.usage.cost : undefined };
  }
}

function errMsg(d: OpenRouterResponse, status: number): string {
  const e = d.error;
  const msg = typeof e === 'string' ? e : e?.message;
  return msg ? `image backend error (${status}): ${msg}` : `image backend error (${status})`;
}
