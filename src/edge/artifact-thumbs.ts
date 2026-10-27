/**
 * Library thumbnails — small cached previews of image/video artifacts so the Library grid never pulls
 * full-size files just to draw a card (a live tenant's PNGs run to ~2 MB each; the old list fetched every
 * one, at full size, to paint a 40px square).
 *
 * Zero-dependency on purpose: Node has no image codec, so we shell out to whatever the box already has —
 * `ffmpeg` (images AND a video frame) then macOS `sips` (images only), both to JPEG. Neither
 * is required: with no tool on PATH an image falls back to its raw bytes (the console lazy-loads those, so
 * it still never loads the whole Library up front) and a video reports no thumb (the card shows an icon).
 *
 * Cached under `<artifacts>/.thumbs/` — OUTSIDE each artifact's id-dir, because `readPath`/the public
 * share route serve anything inside that dir. A thumb is stale when the source's mtime is newer (an edit
 * rewrites the entry file in place). Generation is bounded: at most {@link MAX_PARALLEL} encoder processes
 * box-wide, and concurrent requests for the same thumb share one job — a grid scroll asks for ~30 at once.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

/** Longest edge of a generated thumb, px. Cards render ≤ ~280 CSS px wide; 2× for retina. */
export const THUMB_EDGE = 560;
const MAX_PARALLEL = 2;
const ENCODE_TIMEOUT_MS = 20_000;

export type ThumbResult =
  | { kind: 'thumb'; absPath: string; mime: string }
  | { kind: 'raw' }      // no encoder (or the encode failed) — serve the original image
  | { kind: 'none' };    // nothing previewable (a video with no ffmpeg, a non-visual type)

// Resolved once per process (a box doesn't grow an ffmpeg mid-run often enough to matter). The fixed dirs
// cover a launchd/systemd PATH that omits Homebrew's prefix.
const resolved = new Map<string, string | null>();
function toolPath(bin: string): string | null {
  if (resolved.has(bin)) return resolved.get(bin)!;
  let hit: string | null = null;
  for (const d of (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); hit = p; break; } catch { /* next */ }
  }
  resolved.set(bin, hit);
  return hit;
}
const hasTool = (bin: string) => toolPath(bin) !== null;

let running = 0;
const waiting: Array<() => void> = [];
function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      fn().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); });
    };
    if (running < MAX_PARALLEL) go(); else waiting.push(go);
  });
}
function run(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(toolPath(bin) ?? bin, args, { timeout: ENCODE_TIMEOUT_MS, windowsHide: true }, (err) => resolve(!err));
  });
}
function nonEmpty(p: string): boolean {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}

/** Encode one JPEG thumb at `out`. ffmpeg first (images and a video frame; any transparency is flattened
 *  onto white, since JPEG has no alpha and a transparent PNG would otherwise go black), then macOS sips.
 *  JPEG rather than WebP because a stock Homebrew/apt ffmpeg often ships without libwebp. */
async function encode(src: string, out: string, video: boolean): Promise<boolean> {
  const tmp = out + '.tmp.jpg';
  const done = () => { try { if (fs.statSync(tmp).size > 0) { fs.renameSync(tmp, out); return true; } } catch { /* fall through */ } return false; };
  const scale = `scale='if(gt(iw,ih),min(${THUMB_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${THUMB_EDGE},ih))'`;
  const graph = `[0:v]${scale},format=rgba,split[a][b];[a]lutrgb=r=255:g=255:b=255:a=255[bg];[bg][b]overlay=format=auto,format=yuvj420p`;
  const ffmpeg = (pre: string[]) => run('ffmpeg', ['-v', 'error', '-y', ...pre, '-i', src, '-filter_complex', graph, '-frames:v', '1', '-q:v', '5', tmp]);
  try {
    if (hasTool('ffmpeg')) {
      if (await ffmpeg(video ? ['-ss', '0.5'] : []) && done()) return true;
      // A clip shorter than the seek has no frame there — retry from the first frame.
      if (video && await ffmpeg([]) && done()) return true;
    }
    if (!video && hasTool('sips')) {
      if (await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', String(THUMB_EDGE), src, '--out', tmp]) && done()) return true;
    }
    return false;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** Remembered encode failures (by source path + mtime) so a file ffmpeg can't read isn't re-tried on every card paint. */
const failed = new Set<string>();
const inflight = new Map<string, Promise<ThumbResult>>();

/**
 * Resolve (generating on first ask) the thumbnail for one artifact's entry file. `thumbsDir` is
 * `<artifacts>/.thumbs`; `id` names the cache file. SVG is already tiny + resolution-free → raw.
 */
export function artifactThumb(thumbsDir: string, id: string, src: { absPath: string; mime: string }): Promise<ThumbResult> {
  const image = src.mime.startsWith('image/');
  const video = src.mime.startsWith('video/');
  if (!image && !video) return Promise.resolve({ kind: 'none' });
  if (src.mime.startsWith('image/svg')) return Promise.resolve({ kind: 'raw' });
  let srcMtime = 0;
  try { srcMtime = fs.statSync(src.absPath).mtimeMs; } catch { return Promise.resolve({ kind: 'none' }); }
  const out = path.join(thumbsDir, id + '.jpg');
  try {
    if (fs.statSync(out).mtimeMs >= srcMtime) return Promise.resolve({ kind: 'thumb', absPath: out, mime: 'image/jpeg' });
  } catch { /* not cached */ }
  const failKey = `${src.absPath}:${srcMtime}`;
  const fallback: ThumbResult = image ? { kind: 'raw' } : { kind: 'none' };
  if (failed.has(failKey)) return Promise.resolve(fallback);
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = slot(async (): Promise<ThumbResult> => {
    try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch { return fallback; }
    if (!(await encode(src.absPath, out, video))) { failed.add(failKey); return fallback; }
    return { kind: 'thumb', absPath: out, mime: 'image/jpeg' };
  }).finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
