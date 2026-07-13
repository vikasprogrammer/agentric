/**
 * Video generation backends — behind the OS-owned `video_generate` MCP tool.
 *
 * Video is ASYNC: unlike an image (seconds, one call), a render lands minutes later, so this module
 * splits the vendor interaction into **submit** (accept the job → return an opaque handle) and **poll**
 * (advance the handle → rendering / done+url / failed). `TerminalManager.generateVideo` submits + polls
 * briefly for the fast case, then persists the handle to `video_jobs` and lets a background poller (the
 * Automations tick) finish it — so a paid render survives the poll cap and a restart.
 *
 * Two adapters, picked by whichever key is set (Settings → Integrations):
 *  - **fal.ai** (default, recommended) — the verified queue contract (`POST queue.fal.run/{model}` →
 *    `{request_id, status_url, response_url}`, poll `status_url` for IN_QUEUE/IN_PROGRESS/COMPLETED, then
 *    read the result from `response_url`). Reaches the whole video catalog (Veo 3, Kling, Seedance, …)
 *    via one key. fal hands us the poll + result URLs, so we never construct them.
 *  - **Atlas Cloud** — `POST /api/v1/model/generateVideo` → prediction id, poll
 *    `GET /api/v1/model/prediction/{id}` for completed/failed. Covers image + video under one key.
 *
 * Cost note: video is priced per-second and vendors don't reliably return the cost in-band, so unless a
 * poll surfaces one we meter the ESTIMATE (per-second × duration). The handle in `providerRef` is opaque
 * JSON, so `video_jobs` stays vendor-neutral.
 */

/** Conservative per-second + duration defaults for the pre-render policy gate (the money-cap rule). The
 *  audit records the actual cost when a backend reports it, else this estimate. */
export const DEFAULT_VIDEO_COST_PER_SEC_USD = 0.1;
export const DEFAULT_VIDEO_DURATION_SEC = 5;

export interface VideoGenRequest {
  prompt: string;
  model?: string;
  durationSec?: number;
  imageUrl?: string; // optional image-to-video seed
}

/** Opaque, JSON-serialised handle stored in video_jobs.provider_ref and round-tripped to poll(). */
export interface VideoSubmitResult {
  providerRef: string;
}

export interface VideoPollResult {
  status: 'rendering' | 'done' | 'failed';
  video?: { url: string; ext: string }; // present when status === 'done'
  costUsd?: number; // actual, when the backend reports it
  error?: string;
}

export interface VideoBackend {
  readonly name: 'fal' | 'atlas';
  readonly defaultModel: string;
  /** The model used when an image seed is supplied but no model is named (image-to-video variant). */
  readonly imageModel: string;
  submit(req: VideoGenRequest): Promise<VideoSubmitResult>;
  poll(providerRef: string): Promise<VideoPollResult>;
}

export interface VideoBackendConfig {
  falKey?: string;
  atlasKey?: string;
  atlasBaseUrl?: string;
  defaultModel?: string; // workspace override for the default video model id
}

/** Build a SPECIFIC backend by name (undefined if its key isn't set) — the poller reconstructs the
 *  exact backend a job used, since a job may be Atlas even when a fal key is also present. */
export function videoBackend(name: 'fal' | 'atlas', cfg: VideoBackendConfig): VideoBackend | undefined {
  if (name === 'fal' && cfg.falKey && cfg.falKey.trim()) return new FalVideoBackend(cfg.falKey.trim(), cfg.defaultModel);
  if (name === 'atlas' && cfg.atlasKey && cfg.atlasKey.trim()) return new AtlasVideoBackend(cfg.atlasKey.trim(), cfg.atlasBaseUrl, cfg.defaultModel);
  return undefined;
}

/** Pick a video backend from configured keys. fal wins when both are set (verified contract + catalog). */
export function resolveVideoBackend(cfg: VideoBackendConfig): VideoBackend | undefined {
  return videoBackend('fal', cfg) ?? videoBackend('atlas', cfg);
}

// ── shared ───────────────────────────────────────────────────────────────────

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v'];

/** Pull the first plausible video URL out of a vendor result body (shapes vary across models). */
function findVideoUrl(body: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (typeof val === 'string' && /^https?:\/\//.test(val) && VIDEO_EXTS.some((e) => val.split(/[?#]/)[0].toLowerCase().endsWith('.' + e))) return val;
    }
    // a common shape is { video: { url } } / { videos: [{ url }] } / { output: { video: {url} } }
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(val)) { for (const item of val) { const u = walk(item); if (u) return u; } }
      else if (val && typeof val === 'object') { const u = walk(val); if (u) return u; }
    }
    return undefined;
  };
  return walk(body);
}

function extFromUrl(url: string): string {
  const m = /\.(mp4|webm|mov|m4v)(?:\?|#|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'mp4';
}

function errText(body: unknown, status: number): string {
  const b = body as { error?: { message?: string } | string; detail?: string; message?: string; msg?: string } | undefined;
  const e = b?.error;
  const msg = (typeof e === 'string' ? e : e?.message) || b?.detail || b?.message || b?.msg; // Atlas uses `msg`
  return msg ? `video backend error (${status}): ${msg}` : `video backend error (${status})`;
}

// ── fal.ai ─────────────────────────────────────────────────────────────────────

interface FalSubmitResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}
interface FalStatusResponse {
  status?: string; // IN_QUEUE | IN_PROGRESS | COMPLETED
  response_url?: string;
}
interface FalRef {
  model: string;
  statusUrl: string;
  responseUrl: string;
}

class FalVideoBackend implements VideoBackend {
  readonly name = 'fal' as const;
  readonly defaultModel: string;
  readonly imageModel: string;
  constructor(private readonly key: string, defaultModel?: string) {
    this.defaultModel = defaultModel?.trim() || 'fal-ai/veo3/fast';
    // fal exposes image-to-video as a sub-endpoint of the same family; veo3/fast/image-to-video is the
    // safe default when an image seed is given without an explicit model.
    this.imageModel = 'fal-ai/veo3/fast/image-to-video';
  }

  private headers(): Record<string, string> {
    return { Authorization: `Key ${this.key}`, 'content-type': 'application/json' };
  }

  async submit(req: VideoGenRequest): Promise<VideoSubmitResult> {
    const model = req.model?.trim() || (req.imageUrl ? this.imageModel : this.defaultModel);
    const body: Record<string, unknown> = { prompt: req.prompt };
    if (req.durationSec) body.duration = String(req.durationSec); // fal video models mostly take a string seconds
    if (req.imageUrl) body.image_url = req.imageUrl;
    const res = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as FalSubmitResponse & Record<string, unknown>;
    if (!res.ok) throw new Error(errText(d, res.status));
    if (!d.status_url || !d.response_url) throw new Error('fal did not return status/response URLs');
    const ref: FalRef = { model, statusUrl: d.status_url, responseUrl: d.response_url };
    return { providerRef: JSON.stringify(ref) };
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const ref = JSON.parse(providerRef) as FalRef;
    const sres = await fetch(ref.statusUrl, { headers: this.headers() });
    const s = (await sres.json().catch(() => ({}))) as FalStatusResponse;
    if (!sres.ok) return { status: 'failed', error: errText(s, sres.status) };
    const st = (s.status || '').toUpperCase();
    if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { status: 'rendering' };
    if (st && st !== 'COMPLETED') return { status: 'failed', error: `fal status ${st}` };
    // COMPLETED → fetch the result body and find the video URL
    const rres = await fetch(ref.responseUrl, { headers: this.headers() });
    const r = (await rres.json().catch(() => ({}))) as Record<string, unknown>;
    if (!rres.ok) return { status: 'failed', error: errText(r, rres.status) };
    const url = findVideoUrl(r);
    if (!url) return { status: 'failed', error: 'fal completed but no video URL in the result' };
    return { status: 'done', video: { url, ext: extFromUrl(url) } };
  }
}

// ── Atlas Cloud ──────────────────────────────────────────────────────────────

interface AtlasRef {
  predictionId: string;
  base: string;
}

/** The Atlas prediction object — nested under `data` in the poll response. */
interface AtlasPrediction {
  id?: string;
  status?: string; // rendering-ish | completed | succeeded | failed | error | cancelled
  outputs?: unknown[] | null;
  error?: string;
}

class AtlasVideoBackend implements VideoBackend {
  readonly name = 'atlas' as const;
  readonly defaultModel: string;
  readonly imageModel: string;
  private readonly base: string;
  constructor(private readonly key: string, baseUrl?: string, defaultModel?: string) {
    this.base = (baseUrl?.trim() || 'https://api.atlascloud.ai').replace(/\/+$/, '');
    this.defaultModel = defaultModel?.trim() || 'bytedance/seedance-2.0/text-to-video';
    this.imageModel = 'bytedance/seedance-2.0/image-to-video';
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' };
  }

  async submit(req: VideoGenRequest): Promise<VideoSubmitResult> {
    const model = req.model?.trim() || (req.imageUrl ? this.imageModel : this.defaultModel);
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.durationSec) body.duration = req.durationSec;
    // Atlas takes the seed frame as `image` (URL, Base64 data URL, or asset://<id>) — NOT `image_url`.
    if (req.imageUrl) body.image = req.imageUrl;
    const res = await fetch(`${this.base}/api/v1/model/generateVideo`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as { id?: string; prediction_id?: string; data?: { id?: string } };
    if (!res.ok) throw new Error(errText(d, res.status));
    const id = d.id || d.prediction_id || d.data?.id;
    if (!id) throw new Error('Atlas did not return a prediction id');
    const ref: AtlasRef = { predictionId: id, base: this.base };
    return { providerRef: JSON.stringify(ref) };
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const ref = JSON.parse(providerRef) as AtlasRef;
    const res = await fetch(`${ref.base}/api/v1/model/prediction/${ref.predictionId}`, { headers: this.headers() });
    const body = (await res.json().catch(() => ({}))) as { data?: AtlasPrediction } & AtlasPrediction & Record<string, unknown>;
    if (!res.ok) return { status: 'failed', error: errText(body, res.status) };
    // Atlas nests the prediction under `data` (status/error/outputs live there, NOT at the top level).
    const d: AtlasPrediction = body.data ?? body;
    const st = (d.status || '').toLowerCase();
    if (st === 'failed' || st === 'error' || st === 'cancelled' || st === 'canceled') {
      return { status: 'failed', error: d.error || (body as { message?: string }).message || `atlas status ${st || 'failed'}` };
    }
    if (st !== 'completed' && st !== 'succeeded') return { status: 'rendering' };
    // Atlas documents the result at data.outputs[0] — read it directly (a signed URL may lack a .mp4
    // extension, so don't rely on extension-sniffing); fall back to a recursive search.
    const direct = Array.isArray(d.outputs) ? d.outputs.find((o): o is string => typeof o === 'string' && /^https?:\/\//.test(o)) : undefined;
    const url = direct ?? findVideoUrl(d);
    if (!url) return { status: 'failed', error: 'atlas completed but no video URL in the result' };
    return { status: 'done', video: { url, ext: extFromUrl(url) } };
  }
}
