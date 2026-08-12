/**
 * Webhook ingress — the pure decision layer in front of `Automations.fireWebhook`.
 *
 * The generic `/hooks/<id>` lane started life as "POST anything, spawn a run". That is fine for a
 * hand-rolled curl trigger and wrong for a real product webhook, which fires on EVERY event of every
 * kind, expects a fast 2xx, and does not retry. Four things were missing, and all four are decided
 * here so they stay testable without a server, a DB, or a tmux pane:
 *
 *   1. **Which events count.** A webhook automation had no `filter`, so a source sending ~150
 *      events/day booted ~150 sessions that each read the payload and exited. {@link matchesFilter}
 *      scopes an automation to named events; everything else is acknowledged and dropped for free.
 *   2. **Did we already handle this one.** Sources re-deliver (retries, at-least-once fan-out, a human
 *      mashing a button). {@link deliveryKey} derives a stable id per delivery so the caller can dedupe.
 *   3. **Who is calling.** A key in the URL leaks into logs, referrers and browser history. Most
 *      sources also sign the body; {@link verifySignature} checks that signature when the automation
 *      carries a signing secret, without the caller naming the vendor or the algorithm.
 *   4. **What conversation is this.** {@link threadKey} pulls a stable id (a ticket/conversation id)
 *      out of the payload so a follow-up event continues the run that already handled its sibling
 *      instead of starting a second one alongside it.
 *
 * Everything here is deliberately vendor-neutral: no product names, no per-source branching. Sources
 * differ in spelling, not in shape — they all put the event name in an `X-<vendor>-Event` header or a
 * top-level payload field, the delivery id in an `X-<vendor>-Delivery`-ish header, and the signature in
 * an `X-<vendor>-Signature` header. Matching on the SHAPE (`x-*-event`) covers sources we have never
 * seen, which is the point: the next integration should need no code here.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Header names are lowercased by Node; values may be string | string[] | undefined. */
export type Headers = Record<string, string | string[] | undefined>;

const header = (h: Headers, name: string): string => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

/** First header whose name matches `re`, in insertion order. Used for the `x-*-event` family. */
const headerMatching = (h: Headers, re: RegExp): string => {
  for (const k of Object.keys(h)) {
    if (!re.test(k)) continue;
    const v = h[k];
    const s = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    if (s) return s;
  }
  return '';
};

/** Read a dot path (`a.b.0.c`) out of parsed JSON. Returns '' for anything not a scalar. */
export function readPath(payload: unknown, path: string): string {
  if (!path) return '';
  let cur: any = payload;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return '';
    cur = cur[seg];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  return '';
}

/**
 * The event name for this delivery, in precedence order:
 *   1. `?event=` — the explicit escape hatch, for a source that sends the event only in the URL.
 *   2. any `x-…-event` header — the near-universal convention (`x-github-event`, `x-freescout-event`,
 *      `x-shopify-topic` is the exception and is covered by 3).
 *   3. a conventional top-level payload field.
 * '' means "this source doesn't name its events" — {@link matchesFilter} then only accepts a
 * catch-all filter, so a filtered automation never fires blind on an event it cannot identify.
 */
export function resolveEvent(headers: Headers, query: URLSearchParams, payload: unknown): string {
  const q = (query.get('event') || '').trim();
  if (q) return q;
  const h = headerMatching(headers, /^x-[a-z0-9_-]+-(event|topic)$/);
  if (h) return h.trim();
  for (const k of ['event', 'event_type', 'eventType', 'type', 'action']) {
    const v = readPath(payload, k);
    if (v) return v.trim();
  }
  return '';
}

/**
 * Does `event` pass this automation's filter? The filter is a comma/space separated list; '' and '*'
 * are catch-alls (the historical behaviour, so an existing automation keeps firing on everything).
 * A `*` suffix matches a prefix (`convo.*` covers `convo.created` + `convo.note.created`), which is
 * how these event names are namespaced in practice. Matching is case-insensitive.
 *
 * An unidentifiable event ('' — see {@link resolveEvent}) passes ONLY a catch-all filter. Anything
 * else would be a guess, and guessing wrong here spawns a session per unrelated event.
 */
export function matchesFilter(filter: string | undefined, event: string): boolean {
  const raw = (filter || '').trim();
  if (!raw || raw === '*') return true;
  const ev = event.trim().toLowerCase();
  if (!ev) return false;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((pat) => (pat.endsWith('*') ? ev.startsWith(pat.slice(0, -1)) : ev === pat));
}

/**
 * A stable id for THIS delivery, so a re-delivery is recognised and skipped:
 *   1. `?delivery=` — explicit.
 *   2. any `x-…-(delivery|id|signature)` header — a delivery id when the source sends one, else the
 *      signature, which is itself a function of the body and therefore stable per delivery.
 *   3. a hash of the raw body — the universal fallback. Two genuinely distinct events with byte-identical
 *      bodies are indistinguishable to us, which is why the dedupe window is short (minutes, not days):
 *      it exists to absorb retries, not to be a permanent ledger.
 */
export function deliveryKey(headers: Headers, query: URLSearchParams, rawBody: string): string {
  const q = (query.get('delivery') || '').trim();
  if (q) return q.slice(0, 200);
  const h = headerMatching(headers, /^x-[a-z0-9_-]+-(delivery|delivery-id|id|signature)$/);
  if (h) return h.slice(0, 200);
  return 'sha256:' + createHash('sha256').update(rawBody).digest('hex');
}

/**
 * The conversation this delivery belongs to — a ticket id, a conversation id, an issue number.
 * `path` is the automation's configured dot path into the payload (`conversation.id`); `?thread=`
 * overrides it for a source that can only template into a URL. Empty ⇒ no continuity, every accepted
 * delivery spawns its own run (the correct default for a source with no conversation concept).
 */
export function threadKey(query: URLSearchParams, payload: unknown, path: string | undefined): string {
  const q = (query.get('thread') || '').trim();
  if (q) return q.slice(0, 200);
  return readPath(payload, (path || '').trim()).slice(0, 200);
}

/** Constant-time compare that tolerates differing lengths (timingSafeEqual throws on those). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the body signature against `secret`, accepting the shapes real sources actually send rather
 * than making the operator declare which one their vendor uses:
 *   - `sha256=<hex>` / `sha1=<hex>`  (prefixed, the GitHub style)
 *   - bare hex, either algorithm
 *   - bare base64, either algorithm  (the style that carries `+`/`/`/`=`)
 * A prefix, when present, pins the algorithm; without one we accept a match from either. Both are
 * keyed HMACs of the exact bytes received, so this is a real authenticity check in every branch — the
 * tolerance is over ENCODING, never over whether the caller proved knowledge of the secret.
 *
 * Returns false on a missing/blank signature: this is only ever called when a signing secret is
 * configured, and "configured but unsigned" is exactly the case we must refuse.
 */
export function verifySignature(rawBody: string, secret: string, headers: Headers): boolean {
  if (!secret) return true; // not configured → the URL key is the only credential (caller's choice)
  let sig = headerMatching(headers, /^x-[a-z0-9_-]*-?signature(-256)?$/) || header(headers, 'signature');
  sig = sig.trim();
  if (!sig) return false;

  let algos: Array<'sha256' | 'sha1'> = ['sha256', 'sha1'];
  const eq = sig.indexOf('=');
  if (eq > 0 && /^(sha1|sha256)$/i.test(sig.slice(0, eq))) {
    algos = [sig.slice(0, eq).toLowerCase() as 'sha256' | 'sha1'];
    sig = sig.slice(eq + 1).trim();
  }

  for (const algo of algos) {
    // A Hmac is single-use (digest() finalises it), so each encoding gets its own.
    if (safeEqual(sig, createHmac(algo, secret).update(rawBody).digest('hex'))) return true;
    if (safeEqual(sig, createHmac(algo, secret).update(rawBody).digest('base64'))) return true;
  }
  return false;
}

/** How long a delivery key is remembered for dedupe. Long enough to cover a source's retry ladder. */
export const DEDUPE_TTL_MS = 15 * 60 * 1000;

/** How long a thread binding stays warm. Past this a follow-up starts a fresh run. */
export const THREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
