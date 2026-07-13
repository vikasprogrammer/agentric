/**
 * Shared vendor-call resilience for the media backends (image-gen, video-gen): explicit timeouts +
 * bounded retry with exponential backoff + jitter. A hung socket must never hang a tool, and TRANSIENT
 * failures (network reset, timeout, 429, 5xx) are retried; a 4xx / content-policy rejection / explicit
 * vendor `failed` status is a REAL answer, surfaced as-is. `VendorError.retryable` is the single source of
 * truth both the retry loop and the surfaced message consult.
 */

/** A vendor-call error that knows its HTTP status, which vendor raised it, and whether retrying could
 *  plausibly help. Carried out to TerminalManager so the tool response can tell the agent what to do. */
export class VendorError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly vendor: string, readonly status?: number) {
    super(message);
    this.name = 'VendorError';
  }
}

/** 429 (rate limit) and 5xx (vendor-side) are transient; every other status is a definitive answer. */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter (~0.2–0.4s, ~0.4–0.8s, … capped at 4s) to avoid synchronized retries. */
export function backoffMs(attempt: number): number {
  const base = Math.min(4000, 400 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/** One fetch with an explicit timeout, normalizing a network error / timeout into a RETRYABLE VendorError. */
export async function timedFetch(url: string, init: RequestInit, timeoutMs: number, vendor: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const detail = e instanceof Error ? e.message : String(e);
    throw new VendorError(
      timedOut ? `${vendor} request timed out after ${Math.round(timeoutMs / 1000)}s` : `${vendor} request failed (${detail})`,
      true,
      vendor,
    );
  }
}

/** Run a vendor call up to `attempts` times, retrying ONLY on a retryable VendorError (transient
 *  network/timeout/429/5xx). A terminal error (4xx, content policy, `failed` status, bad model) throws on
 *  its first occurrence so it surfaces as-is. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e instanceof VendorError && e.retryable;
      if (!retryable || attempt === attempts - 1) throw e;
      await sleep(backoffMs(attempt));
    }
  }
  throw last;
}

/** Normalize any thrown error into { message, retryable, vendor } for the caller (TerminalManager → the
 *  tool response), so the agent is told which subsystem failed and whether a plain retry is worthwhile. */
export function vendorErrorInfo(e: unknown): { message: string; retryable?: boolean; vendor?: string } {
  if (e instanceof VendorError) return { message: e.message, retryable: e.retryable, vendor: e.vendor };
  return { message: e instanceof Error ? e.message : String(e) };
}
