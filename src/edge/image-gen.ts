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
  fallbackFrom?: string; // set when the requested model was rejected and we retried with a built-in default
}

export interface ImageGenRequest {
  prompt: string;
  model?: string;
  size?: string; // e.g. '1024x1024'; passed through, vendor clamps
  n: number;
}

/** Edit or upscale an EXISTING image. `images` are already-resolved inputs the vendor accepts inline
 *  (data: URLs or http URLs). `scale` set (>1) ⇒ upscale mode (uses the upscaler model, `prompt` ignored);
 *  otherwise it's a prompt-guided edit (image-to-image). */
export interface ImageEditRequest {
  images: string[];
  prompt?: string;
  model?: string;
  size?: string;
  scale?: number;
}

export interface ImageBackend {
  readonly name: 'openrouter' | 'atlas';
  readonly defaultModel: string;
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  /** Edit/upscale an existing image (image-to-image). Not every backend supports it — those throw. */
  editImage(req: ImageEditRequest): Promise<ImageGenResult>;
}

/** What the factory needs from Settings — passed in (not the whole store) to keep this testable. */
export interface ImageBackendConfig {
  openRouterKey?: string;
  atlasKey?: string;
  atlasBaseUrl?: string; // override; default below
  defaultModel?: string; // workspace override for the default model
}

/** Pick a backend from configured keys. Atlas is PRIMARY when set (one Atlas interface covers image +
 *  video); OpenRouter is the fallback. */
export function resolveImageBackend(cfg: ImageBackendConfig): ImageBackend | undefined {
  if (cfg.atlasKey && cfg.atlasKey.trim()) {
    return new AtlasBackend(cfg.atlasKey.trim(), cfg.atlasBaseUrl, cfg.defaultModel);
  }
  if (cfg.openRouterKey && cfg.openRouterKey.trim()) {
    return new OpenRouterBackend(cfg.openRouterKey.trim(), cfg.defaultModel);
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

/** Turn one vendor image entry (a URL or inline base64) into raw bytes + a file extension. The ext is
 *  sniffed from the actual bytes (magic numbers) first — vendors mislabel format (e.g. return JPEG on a
 *  model we'd otherwise assume is PNG), and the ext drives both the filename and the stored mime, so
 *  trusting a content-type/URL hint would persist a wrong `.png`/`image/png` over real JPEG. */
async function toBytes(entry: { url?: string; b64_json?: string; b64?: string }): Promise<GeneratedImage> {
  const b64 = entry.b64_json ?? entry.b64;
  if (b64) {
    const comma = b64.indexOf(','); // tolerate a data: URI prefix
    const raw = comma >= 0 && b64.slice(0, comma).includes('base64') ? b64.slice(comma + 1) : b64;
    const bytes = Buffer.from(raw, 'base64');
    return { bytes, ext: sniffExt(bytes, 'png') };
  }
  if (entry.url) {
    const res = await fetch(entry.url);
    if (!res.ok) throw new Error(`fetching generated image failed (${res.status})`);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, ext: sniffExt(buf, EXT_BY_MIME[ct] || extFromUrl(entry.url) || 'png') };
  }
  throw new Error('vendor returned an image with neither a url nor base64 data');
}

/** Detect the real image format from the leading magic bytes, falling back to a hint when unknown. */
function sniffExt(buf: Buffer, fallback: string): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  return fallback;
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

  async editImage(_req: ImageEditRequest): Promise<ImageGenResult> {
    throw new Error('image editing requires an Atlas Cloud key (the OpenRouter image API is text-to-image only)');
  }
}

// ── Atlas Cloud ──────────────────────────────────────────────────────────────
// Atlas is NOT OpenAI-compatible for media — it's a custom ASYNC API shared by image + video:
// POST /api/v1/model/generateImage → a prediction id (data.id), then poll
// GET /api/v1/model/prediction/{id} until data.status is completed/failed (image url at data.outputs[0]).
// Image renders in seconds, so we submit + poll-to-completion INSIDE generate() to keep the sync
// ImageBackend contract. (Video uses the same endpoints via its own async job model in video-gen.ts.)

interface AtlasPrediction {
  id?: string;
  status?: string;
  outputs?: unknown[] | null;
  error?: string;
}

// A built-in, known-good default per operation — the anchor we fall back to when a configured/passed
// model id is rejected by Atlas (e.g. a half-typed "google/" default silently breaking every run).
const ATLAS_BUILTIN_IMAGE_MODEL = 'google/nano-banana-2/text-to-image';
const ATLAS_BUILTIN_EDIT_MODEL = 'google/nano-banana-2/edit';
const ATLAS_UPSCALE_MODEL = 'atlascloud/image-upscaler';

/** Does this error look like "the model id is wrong" (vs a transient/other failure)? Only these are
 *  worth retrying with the built-in default — a real content/timeout error should surface as-is. */
function isModelRejected(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /not found|no such model|unknown model|invalid model|model.*(not found|invalid|unsupported)|does not exist/.test(m);
}

class AtlasBackend implements ImageBackend {
  readonly name = 'atlas' as const;
  readonly defaultModel: string;
  readonly editModel = ATLAS_BUILTIN_EDIT_MODEL; // image-to-image default when an edit names no model
  readonly upscaleModel = ATLAS_UPSCALE_MODEL;
  private readonly base: string;
  constructor(private readonly key: string, baseUrl?: string, defaultModel?: string) {
    this.base = (baseUrl?.trim() || 'https://api.atlascloud.ai').replace(/\/+$/, '');
    this.defaultModel = defaultModel?.trim() || ATLAS_BUILTIN_IMAGE_MODEL;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' };
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const model = req.model?.trim() || this.defaultModel;
    const build = (m: string): Record<string, unknown> => ({ model: m, prompt: req.prompt, ...(req.size ? { size: req.size } : {}) });
    return this.withModelFallback(model, ATLAS_BUILTIN_IMAGE_MODEL, build);
  }

  async editImage(req: ImageEditRequest): Promise<ImageGenResult> {
    if (!req.images.length) throw new Error('an input image is required');
    const upscale = typeof req.scale === 'number' && req.scale > 1;
    const model = req.model?.trim() || (upscale ? this.upscaleModel : this.editModel);
    const fallback = upscale ? ATLAS_UPSCALE_MODEL : ATLAS_BUILTIN_EDIT_MODEL;
    // Edit and upscale ride the SAME generateImage submit+poll — only the body shape differs: an upscaler
    // takes a single `image` + `outscale`; an image-to-image edit takes `images[]` + a `prompt`.
    const build = (m: string): Record<string, unknown> => upscale
      ? { model: m, image: req.images[0], outscale: req.scale, output_format: 'jpeg' }
      : { model: m, prompt: req.prompt ?? '', images: req.images, ...(req.size ? { size: req.size } : {}) };
    return this.withModelFallback(model, fallback, build);
  }

  /** Run `build(model)` through submit+poll; if the model id is REJECTED and differs from the known-good
   *  `fallback`, retry once with the fallback and tag the result so the caller can warn the operator. */
  private async withModelFallback(model: string, fallback: string, build: (m: string) => Record<string, unknown>): Promise<ImageGenResult> {
    try {
      return await this.submitAndPoll(build(model), model);
    } catch (e) {
      if (isModelRejected(e) && model !== fallback) {
        const res = await this.submitAndPoll(build(fallback), fallback);
        return { ...res, fallbackFrom: model };
      }
      throw e;
    }
  }

  /** Submit a generateImage body then poll the prediction to completion (image renders in seconds, so a
   *  bounded internal poll keeps the sync ImageBackend contract). Shared by generate + editImage. */
  private async submitAndPoll(body: Record<string, unknown>, model: string): Promise<ImageGenResult> {
    const sres = await fetch(`${this.base}/api/v1/model/generateImage`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const sbody = (await sres.json().catch(() => ({}))) as { data?: AtlasPrediction; message?: string } & AtlasPrediction;
    if (!sres.ok) throw new Error(atlasErr(sbody, sres.status));
    const id = sbody.data?.id ?? sbody.id;
    if (!id) throw new Error('Atlas did not return a prediction id');
    const deadline = Date.now() + 90_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const pres = await fetch(`${this.base}/api/v1/model/prediction/${id}`, { headers: this.headers() });
      const pbody = (await pres.json().catch(() => ({}))) as { data?: AtlasPrediction; message?: string } & AtlasPrediction;
      if (!pres.ok) throw new Error(atlasErr(pbody, pres.status));
      const d: AtlasPrediction = pbody.data ?? pbody;
      const st = (d.status || '').toLowerCase();
      if (st === 'failed' || st === 'error' || st === 'cancelled' || st === 'canceled') throw new Error(d.error || pbody.message || (pbody as { msg?: string }).msg || `Atlas image ${st || 'failed'}`);
      if (st === 'completed' || st === 'succeeded') {
        const urls = (d.outputs || []).filter((o): o is string => typeof o === 'string');
        if (!urls.length) throw new Error('Atlas completed but returned no image URL');
        const images = await Promise.all(urls.map((url) => toBytes({ url })));
        return { images, model, costUsd: undefined }; // Atlas doesn't return cost in-band → caller estimates
      }
      if (Date.now() > deadline) throw new Error('Atlas image timed out');
    }
  }
}

function atlasErr(body: { error?: string; message?: string; msg?: string }, status: number): string {
  const msg = body.error || body.message || body.msg; // Atlas uses `msg` for errors
  return msg ? `Atlas image error (${status}): ${msg}` : `Atlas image error (${status})`;
}

function errMsg(d: OpenRouterResponse, status: number): string {
  const e = d.error;
  const msg = typeof e === 'string' ? e : e?.message;
  return msg ? `image backend error (${status}): ${msg}` : `image backend error (${status})`;
}
