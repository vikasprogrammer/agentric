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

import { VendorError, retryableStatus, timedFetch, withRetry, vendorErrorInfo, sleep } from './vendor-fetch';

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

/** Edit, upscale, or run a named preset on an EXISTING image. `images` are already-resolved inputs the
 *  vendor accepts inline (data: URLs or http URLs). Mode precedence: `operation` (a named preset like
 *  'remove-background') ⇒ that preset; else `scale` (>1) ⇒ upscale (uses the upscaler model, `prompt`
 *  ignored); else a prompt-guided edit (image-to-image). */
export interface ImageEditRequest {
  images: string[];
  prompt?: string;
  model?: string;
  size?: string;
  scale?: number;
  operation?: 'remove-background';
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
    const url = entry.url;
    // Download with a timeout + bounded retry: a hung/interrupted body read is transient. The whole read
    // lives inside the retried fn so a stalled arrayBuffer() (aborted by the signal) also retries.
    const { buf, ct } = await withRetry(async () => {
      try {
        const res = await timedFetch(url, {}, DOWNLOAD_TIMEOUT_MS, 'image download');
        if (!res.ok) throw new VendorError(`fetching generated image failed (${res.status})`, retryableStatus(res.status), 'image download', res.status);
        const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, ct };
      } catch (e) {
        if (e instanceof VendorError) throw e;
        throw new VendorError(`image download failed (${e instanceof Error ? e.message : String(e)})`, true, 'image download');
      }
    });
    return { bytes: buf, ext: sniffExt(buf, EXT_BY_MIME[ct] || extFromUrl(url) || 'png') };
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

// ── network resilience: timeouts + bounded retry (shared helpers in ./vendor-fetch) ──────────────────
const SUBMIT_TIMEOUT_MS = 30_000; // POST generate / submit
const POLL_TIMEOUT_MS = 15_000; // one prediction poll
const DOWNLOAD_TIMEOUT_MS = 60_000; // pull the finished image bytes (can be large)

/** Back-compat alias for `TerminalManager` (image path); identical to the shared `vendorErrorInfo`. */
export const imageErrorInfo = vendorErrorInfo;

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
    const d = await withRetry(async () => {
      const res = await timedFetch('https://openrouter.ai/api/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, SUBMIT_TIMEOUT_MS, 'OpenRouter');
      const j = (await res.json().catch(() => ({}))) as OpenRouterResponse;
      if (!res.ok) throw new VendorError(errMsg(j, res.status), retryableStatus(res.status), 'OpenRouter', res.status);
      const entries = j.data ?? j.images ?? [];
      if (!entries.length) throw new VendorError('OpenRouter returned no images', true, 'OpenRouter');
      return j;
    });
    const entries = d.data ?? d.images ?? [];
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
const ATLAS_BG_REMOVE_MODEL = 'youchuan/v8.1/remove-background';

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
    const bgRemove = req.operation === 'remove-background';
    const upscale = !bgRemove && typeof req.scale === 'number' && req.scale > 1;
    const model = req.model?.trim() || (bgRemove ? ATLAS_BG_REMOVE_MODEL : upscale ? this.upscaleModel : this.editModel);
    const fallback = bgRemove ? ATLAS_BG_REMOVE_MODEL : upscale ? ATLAS_UPSCALE_MODEL : ATLAS_BUILTIN_EDIT_MODEL;
    // All three modes ride the SAME generateImage submit+poll — only the body shape differs: an upscaler
    // and background-removal take a single `image` (bg-remove returns a transparent PNG, no prompt); an
    // image-to-image edit takes `images[]` + a `prompt`.
    const build = (m: string): Record<string, unknown> => bgRemove
      ? { model: m, image: req.images[0] }
      : upscale
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
    // Submit with a timeout + bounded retry (transient network/429/5xx). A 4xx (incl. a rejected model,
    // which the model-fallback path then handles by message) throws on the first try and surfaces as-is.
    const sbody = await withRetry(async () => {
      const res = await timedFetch(`${this.base}/api/v1/model/generateImage`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, SUBMIT_TIMEOUT_MS, 'Atlas');
      const b = (await res.json().catch(() => ({}))) as { data?: AtlasPrediction; message?: string } & AtlasPrediction;
      if (!res.ok) throw new VendorError(atlasErr(b, res.status), retryableStatus(res.status), 'Atlas', res.status);
      if (!(b.data?.id ?? b.id)) throw new VendorError('Atlas accepted the request but returned no prediction id', true, 'Atlas');
      return b;
    });
    const id = sbody.data?.id ?? sbody.id!;

    const start = Date.now();
    const deadline = start + 90_000;
    for (;;) {
      await sleep(2000);
      let pbody: { data?: AtlasPrediction; message?: string; msg?: string } & AtlasPrediction;
      try {
        const pres = await timedFetch(`${this.base}/api/v1/model/prediction/${id}`, { headers: this.headers() }, POLL_TIMEOUT_MS, 'Atlas');
        pbody = (await pres.json().catch(() => ({}))) as typeof pbody;
        if (!pres.ok) {
          if (retryableStatus(pres.status) && Date.now() < deadline) continue; // transient 5xx/429 → keep polling
          throw new VendorError(atlasErr(pbody, pres.status), false, 'Atlas', pres.status); // terminal
        }
      } catch (e) {
        // A single poll that hit a network error / timeout is not fatal — keep polling until the deadline;
        // only a terminal (retryable=false) error or the clock running out gives up.
        if (e instanceof VendorError && e.retryable && Date.now() < deadline) continue;
        throw e;
      }
      const d: AtlasPrediction = pbody.data ?? pbody;
      const st = (d.status || '').toLowerCase();
      if (st === 'failed' || st === 'error' || st === 'cancelled' || st === 'canceled') {
        throw new VendorError(d.error || pbody.message || pbody.msg || `Atlas image ${st || 'failed'}`, false, 'Atlas'); // a real answer — never retry
      }
      if (st === 'completed' || st === 'succeeded') {
        const urls = (d.outputs || []).filter((o): o is string => typeof o === 'string');
        if (!urls.length) throw new VendorError('Atlas completed but returned no image URL', true, 'Atlas');
        const images = await Promise.all(urls.map((url) => toBytes({ url })));
        return { images, model, costUsd: undefined }; // Atlas doesn't return cost in-band → caller estimates
      }
      if (Date.now() > deadline) {
        const waited = Math.round((Date.now() - start) / 1000);
        throw new VendorError(`Atlas image timed out after ${waited}s waiting for the render — the prediction (${id}) may still be in flight; try again shortly or check the Library before regenerating.`, true, 'Atlas');
      }
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
