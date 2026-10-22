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

import { VendorError, retryableStatus, timedFetch, withRetry } from './vendor-fetch';

/** Conservative per-second + duration defaults for the pre-render policy gate (the money-cap rule). The
 *  audit records the actual cost when a backend reports it, else this estimate. */
export const DEFAULT_VIDEO_COST_PER_SEC_USD = 0.1;
export const DEFAULT_VIDEO_DURATION_SEC = 5;

// Timeouts for the vendor calls (retry/backoff via ./vendor-fetch). Submit is a single POST; each poll is
// one status check — a transient poll failure is NOT fatal (the background tick just re-polls next round).
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;

export interface VideoGenRequest {
  prompt: string;
  model?: string;
  durationSec?: number;
  imageUrl?: string; // optional image-to-video seed
  /** Reference images for a reference-to-video model — mapped onto whatever list field the model's schema
   *  names (`reference_images` / `images` / `refers` …). Already-resolved URLs or data URLs. */
  referenceImageUrls?: string[];
  /** Output aspect ratio ("9:16", "16:9", "1:1", …) — mapped onto the model's ratio/aspect/resolution field. */
  aspectRatio?: string;
  /** Model-specific fields, sent verbatim and winning over everything derived above (never `model`). */
  params?: Record<string, unknown>;
}

/** Opaque, JSON-serialised handle stored in video_jobs.provider_ref and round-tripped to poll(). */
export interface VideoSubmitResult {
  providerRef: string;
  /** Things the agent should know about how its input was mapped (e.g. a param the schema doesn't list). */
  notes?: string[];
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

function withoutModel(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {};
  const { model: _drop, ...rest } = params;
  return rest;
}

// ── Atlas model schemas ──────────────────────────────────────────────────────

/** The part of an Atlas model's published JSON schema (`components.schemas.Input`) that we read. */
export interface AtlasInputSchema {
  properties: Record<string, AtlasSchemaProp>;
  required?: string[];
}
interface AtlasSchemaProp {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: { type?: string; properties?: Record<string, unknown> };
}

const SCHEMA_TTL_MS = 6 * 3600_000;
const SCHEMA_MISS_TTL_MS = 5 * 60_000; // a failed lookup is retried soon, not pinned for hours
let atlasIndex: { at: number; base: string; urls: Map<string, string> } | undefined;
const atlasSchemas = new Map<string, { at: number; schema: AtlasInputSchema | null }>();

/** A model's Input schema, cached. The public `/api/v1/models` list maps each model to a schema URL.
 *  Never throws — `null` means "unknown", and the caller falls back to the historical field names. */
export async function atlasInputSchema(base: string, model: string): Promise<AtlasInputSchema | null> {
  const key = `${base} ${model}`;
  const hit = atlasSchemas.get(key);
  if (hit && Date.now() - hit.at < (hit.schema ? SCHEMA_TTL_MS : SCHEMA_MISS_TTL_MS)) return hit.schema;
  let schema: AtlasInputSchema | null = null;
  try {
    if (!atlasIndex || atlasIndex.base !== base || Date.now() - atlasIndex.at > SCHEMA_TTL_MS) {
      const res = await timedFetch(`${base}/api/v1/models`, {}, POLL_TIMEOUT_MS, 'Atlas');
      const j = (await res.json()) as { data?: { model?: string; schema?: unknown }[] };
      const urls = new Map<string, string>();
      for (const m of j.data ?? []) if (m.model && typeof m.schema === 'string') urls.set(m.model, m.schema);
      if (urls.size) atlasIndex = { at: Date.now(), base, urls };
    }
    const url = atlasIndex?.urls.get(model);
    if (url) {
      const res = await timedFetch(url, {}, POLL_TIMEOUT_MS, 'Atlas');
      const doc = (await res.json()) as { components?: { schemas?: { Input?: AtlasInputSchema } } };
      const input = doc.components?.schemas?.Input;
      if (input?.properties) schema = input;
    }
  } catch { /* unknown schema — fall back */ }
  atlasSchemas.set(key, { at: Date.now(), schema });
  return schema;
}

const SEED_FIELDS = ['image', 'image_url', 'first_image', 'start_image'];
const REF_FIELDS = ['reference_images', 'images', 'refers', 'image_urls', 'reference_image_urls'];
const RATIO_FIELDS = ['ratio', 'aspect_ratio'];
/** `resolution` presets that encode an aspect (LTX quality: portrait_9_16 …), best first. */
const RATIO_PRESETS: Record<string, string[]> = {
  '9:16': ['portrait_9_16'], '16:9': ['landscape_16_9'], '3:4': ['portrait_3_4'], '4:3': ['landscape_4_3'], '1:1': ['square_hd', 'square'],
};

function fail(msg: string): never {
  throw new VendorError(msg, false, 'Atlas', 400);
}

/**
 * Map a request onto one Atlas model's Input schema. Every input the caller supplied must land in a field
 * the model reads, or this throws naming the fields it does read — a silently dropped image is how a
 * reference-to-video call rendered an unrelated chair. Then: enum fields left unset get their schema
 * default (some models reject a missing `resolution` despite documenting a default, and LTX quality can't
 * price a request without one), and `params` goes on last, verbatim.
 */
export function buildAtlasVideoBody(req: VideoGenRequest, model: string, schema: AtlasInputSchema | null): { body: Record<string, unknown>; notes: string[] } {
  const body: Record<string, unknown> = { model, prompt: req.prompt };
  const notes: string[] = [];
  const params = withoutModel(req.params);
  if (!schema) {
    if (req.durationSec) body.duration = req.durationSec;
    if (req.imageUrl) body.image = req.imageUrl; // URL, Base64 data URL, or asset://<id>
    if (req.referenceImageUrls?.length) body.reference_images = req.referenceImageUrls;
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    if (req.referenceImageUrls?.length || req.aspectRatio) notes.push(`couldn't read ${model}'s schema, so references/aspect used the common field names — pass \`params\` if the model names them differently`);
    return { body: { ...body, ...params }, notes };
  }
  const P = schema.properties;
  const fields = () => Object.keys(P).filter((k) => k !== 'model').join(', ');

  // Seed image + reference images. A reference-only model (no seed field) takes the seed as its first
  // reference; a seed-only model takes a single reference as its seed.
  const seedField = SEED_FIELDS.find((f) => P[f]);
  const refField = REF_FIELDS.find((f) => P[f]?.type === 'array')
    ?? Object.keys(P).find((k) => P[k].type === 'array' && /image|refer/i.test(k) && !/video|audio/i.test(k));
  let seed = req.imageUrl;
  let refs = [...(req.referenceImageUrls ?? [])];
  if (seed && !seedField) {
    if (!refField) fail(`${model} takes no input image (its fields: ${fields()})`);
    refs = [seed, ...refs];
    seed = undefined;
  }
  if (refs.length && !refField) {
    if (!seedField || refs.length > 1 || seed) fail(`${model} takes no reference images${seedField ? ` — only one \`image\`` : ''} (its fields: ${fields()})`);
    seed = refs[0];
    refs = [];
  }
  if (seed && seedField) body[seedField] = seed;
  if (refs.length && refField) {
    const max = P[refField].maxItems;
    if (max && refs.length > max) fail(`${model} takes at most ${max} reference images, got ${refs.length}`);
    const item = P[refField].items;
    body[refField] = item?.type === 'object'
      ? refs.map((url) => (item.properties && 'type' in item.properties ? { url, type: 'image' } : { url }))
      : refs;
  }

  // Duration: snap to the model's allowed values, or derive a frame count (LTX takes 8k+1 frames at 24fps).
  if (req.durationSec) {
    const d = P.duration;
    if (d) {
      const allowed = (d.enum ?? []).filter((v): v is number => typeof v === 'number' && v > 0);
      let v = allowed.length ? allowed.reduce((a, b) => (Math.abs(b - req.durationSec!) < Math.abs(a - req.durationSec!) ? b : a)) : req.durationSec;
      if (!allowed.length) v = Math.min(d.maximum ?? v, Math.max(d.minimum ?? v, v));
      if (v !== req.durationSec) notes.push(`${model} can't do ${req.durationSec}s — rendering ${v}s`);
      body.duration = d.type === 'integer' ? Math.round(v) : v;
    } else if (P.num_frames) {
      const f = P.num_frames;
      const lo = f.minimum ?? 25, hi = f.maximum ?? 257;
      const frames = Math.min(hi, Math.max(lo, Math.round((req.durationSec * 24 - 1) / 8) * 8 + 1));
      body.num_frames = frames - ((frames - 1) % 8);
    }
  }

  // Aspect ratio: a ratio field if the model has one, else an aspect-encoding resolution preset.
  if (req.aspectRatio) {
    const ar = req.aspectRatio;
    const ratioField = RATIO_FIELDS.find((f) => P[f]);
    if (ratioField) {
      const allowed = P[ratioField].enum;
      if (allowed && !allowed.includes(ar)) fail(`${model} doesn't support aspect ratio ${ar} (allowed: ${allowed.join(', ')})`);
      body[ratioField] = ar;
    } else {
      const preset = (RATIO_PRESETS[ar] ?? []).find((v) => P.resolution?.enum?.includes(v));
      if (!preset) fail(`${model} has no aspect-ratio setting for ${ar} (its fields: ${fields()}) — pass the model's own field in \`params\``);
      body.resolution = preset;
    }
  }

  for (const [k, prop] of Object.entries(P)) {
    if (k === 'model' || k === 'prompt' || k in body || k in params || prop.default === undefined) continue;
    if (prop.enum) body[k] = prop.default;
  }

  const unknown = Object.keys(params).filter((k) => !P[k]);
  if (unknown.length) notes.push(`${model}'s schema doesn't list ${unknown.join(', ')} — sent anyway; the model may ignore ${unknown.length > 1 ? 'them' : 'it'}`);
  return { body: { ...body, ...params }, notes };
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
    // fal has no schema we read up front; these are its common names, and `params` overrides them.
    if (req.referenceImageUrls?.length) body.image_urls = req.referenceImageUrls;
    if (req.aspectRatio) body.aspect_ratio = req.aspectRatio;
    Object.assign(body, withoutModel(req.params));
    const d = await withRetry(async () => {
      const res = await timedFetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, SUBMIT_TIMEOUT_MS, 'fal');
      const j = (await res.json().catch(() => ({}))) as FalSubmitResponse & Record<string, unknown>;
      if (!res.ok) throw new VendorError(errText(j, res.status), retryableStatus(res.status), 'fal', res.status);
      if (!j.status_url || !j.response_url) throw new VendorError('fal did not return status/response URLs', true, 'fal');
      return j;
    });
    const ref: FalRef = { model, statusUrl: d.status_url!, responseUrl: d.response_url! };
    return { providerRef: JSON.stringify(ref) };
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const ref = JSON.parse(providerRef) as FalRef;
    try {
      const sres = await timedFetch(ref.statusUrl, { headers: this.headers() }, POLL_TIMEOUT_MS, 'fal');
      const s = (await sres.json().catch(() => ({}))) as FalStatusResponse;
      if (!sres.ok) {
        if (retryableStatus(sres.status)) return { status: 'rendering' }; // transient → let the next tick re-poll
        return { status: 'failed', error: errText(s, sres.status) };
      }
      const st = (s.status || '').toUpperCase();
      if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { status: 'rendering' };
      if (st && st !== 'COMPLETED') return { status: 'failed', error: `fal status ${st}` };
      // COMPLETED → fetch the result body and find the video URL
      const rres = await timedFetch(ref.responseUrl, { headers: this.headers() }, POLL_TIMEOUT_MS, 'fal');
      const r = (await rres.json().catch(() => ({}))) as Record<string, unknown>;
      if (!rres.ok) {
        if (retryableStatus(rres.status)) return { status: 'rendering' };
        return { status: 'failed', error: errText(r, rres.status) };
      }
      const url = findVideoUrl(r);
      if (!url) return { status: 'failed', error: 'fal completed but no video URL in the result' };
      return { status: 'done', video: { url, ext: extFromUrl(url) } };
    } catch (e) {
      // A single poll that hit a network error / timeout is not fatal — the job stays 'rendering' and the
      // background tick re-polls (bounded by VIDEO_MAX_POLLS / TTL). Only a terminal status fails the job.
      if (e instanceof VendorError && e.retryable) return { status: 'rendering' };
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
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
    // Atlas models disagree on field names (`image` vs `image_url`, `reference_images` vs `refers`,
    // `ratio` vs `aspect_ratio` vs a `resolution` preset), and a field the model doesn't know is dropped
    // in silence — so read the model's own published schema and map onto it. Unreadable → the old shape.
    const schema = await atlasInputSchema(this.base, model);
    const { body, notes } = buildAtlasVideoBody(req, model, schema);
    await this.publishDataUrls(body);
    const d = await withRetry(async () => {
      const res = await timedFetch(`${this.base}/api/v1/model/generateVideo`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, SUBMIT_TIMEOUT_MS, 'Atlas');
      const j = (await res.json().catch(() => ({}))) as { id?: string; prediction_id?: string; data?: { id?: string } };
      if (!res.ok) throw new VendorError(errText(j, res.status), retryableStatus(res.status), 'Atlas', res.status);
      if (!(j.id || j.prediction_id || j.data?.id)) throw new VendorError('Atlas accepted the request but returned no prediction id', true, 'Atlas');
      return j;
    });
    const id = d.id || d.prediction_id || d.data?.id!;
    const ref: AtlasRef = { predictionId: id, base: this.base };
    return { providerRef: JSON.stringify(ref), notes: notes.length ? notes : undefined };
  }

  /** Swap inline data URLs for hosted ones (Atlas `uploadMedia`) everywhere except `image`/`last_image`,
   *  the only fields Atlas documents as taking Base64. Reference lists (Wan's `refers`) require a public
   *  URL, and `image_url` is `format: uri`. A failed upload leaves the data URL for the vendor to judge. */
  private async publishDataUrls(body: Record<string, unknown>): Promise<void> {
    const host = async (v: string): Promise<string> => (v.startsWith('data:') ? (await this.upload(v).catch(() => undefined)) ?? v : v);
    for (const [k, v] of Object.entries(body)) {
      if (k === 'image' || k === 'last_image') continue;
      if (typeof v === 'string') body[k] = await host(v);
      else if (Array.isArray(v)) {
        body[k] = await Promise.all(v.map(async (item) => {
          if (typeof item === 'string') return host(item);
          if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') return { ...item, url: await host((item as { url: string }).url) };
          return item;
        }));
      }
    }
  }

  private async upload(dataUrl: string): Promise<string | undefined> {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) return undefined;
    const mime = m[1] || 'application/octet-stream';
    const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `upload.${(mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')}`);
    const res = await timedFetch(`${this.base}/api/v1/model/uploadMedia`, { method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: form }, SUBMIT_TIMEOUT_MS, 'Atlas');
    const j = (await res.json().catch(() => ({}))) as { data?: { download_url?: string } };
    return res.ok ? j.data?.download_url : undefined;
  }

  async poll(providerRef: string): Promise<VideoPollResult> {
    const ref = JSON.parse(providerRef) as AtlasRef;
    try {
      const res = await timedFetch(`${ref.base}/api/v1/model/prediction/${ref.predictionId}`, { headers: this.headers() }, POLL_TIMEOUT_MS, 'Atlas');
      const body = (await res.json().catch(() => ({}))) as { data?: AtlasPrediction } & AtlasPrediction & Record<string, unknown>;
      if (!res.ok) {
        if (retryableStatus(res.status)) return { status: 'rendering' }; // transient → let the next tick re-poll
        return { status: 'failed', error: errText(body, res.status) };
      }
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
    } catch (e) {
      // A single poll that hit a network error / timeout is not fatal — stay 'rendering' and let the tick
      // poller re-poll (bounded by VIDEO_MAX_POLLS / TTL). Only a terminal status/error fails the job.
      if (e instanceof VendorError && e.retryable) return { status: 'rendering' };
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
  }
}
