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
 *
 * This is the EVENT half only. A filter may also carry a `when` clause over the payload — see
 * {@link parseFilter} / {@link evaluateFilter}, which is what callers should use.
 */
export function matchesFilter(filter: string | undefined, event: string): boolean {
  const raw = parseFilter(filter).events;
  if (!raw || raw === '*') return true;
  const ev = event.trim().toLowerCase();
  if (!ev) return false;
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((pat) => (pat.endsWith('*') ? ev.startsWith(pat.slice(0, -1)) : ev === pat));
}

/* ────────────────────────────────────────────────────────────────────────────────
 * Payload predicates — the `when` clause
 *
 * The event name alone cannot express the two things that actually waste money on a real
 * source, because both are properties of the BODY, not of the event type:
 *
 *   - **the echo.** An agent posts a note on a ticket; the source emits `convo.note.created`;
 *     the automation fires; a whole session spawns to discover the note was its own and exit.
 *     Every note the agent writes buys a session to un-decide it. On instawp's FreeScout hook this
 *     was 79 of 177 runs in a week — 45% of the agent's spawns.
 *   - **the tombstone.** Events keep arriving for a conversation that was merged away or closed,
 *     where there is nothing left to work.
 *
 * Both are one field comparison. Without one, the cheapest decision in the system ("this event
 * is mine, ignore it") is made by a Claude session instead of by a filter — and a gate written
 * into the agent's PROMPT cannot help, because it runs after the spawn it was meant to prevent.
 *
 * Grammar, deliberately small:
 *
 *     <events> [ when <preds> ] [ unless <preds> ]
 *     <preds> := <path> <op> <value> [ and <path> <op> <value> ]…
 *     op := ==   !=   ~ (contains)   !~ (does not contain)
 *
 * `and` is the only connective inside a clause. Predicates ANDed with no `or` and no parens means
 * there is no precedence to get wrong — the failure mode of a richer grammar is a filter that reads
 * as if it drops something it doesn't. Values may be quoted (`"a b"`), and comparison is
 * case-insensitive on strings, matching the event half.
 *
 * **`when` requires; `unless` rejects.** `when` fires only if EVERY predicate holds; `unless` drops
 * only if EVERY predicate holds. The second form exists because the thing you actually need to drop
 * is usually a CONJUNCTION of properties, and `when` alone can only negate one at a time. The real
 * case: on FreeScout an echo is `thread.source.type == "api" AND thread.source.via == "user"` —
 * neither half is safe on its own, because customers also arrive over `api` (26 genuine tickets in
 * one week's sample) and humans also post `user` notes (20 more). Only the pair is the agent talking
 * to itself, and `unless` is how you say that without inventing operator precedence.
 *
 * ⚠ **A missing path reads as ''.** So `state != "deleted"` PASSES when there is no `state` field,
 * and `source.type == "api"` FAILS. That asymmetry is deliberate — the `!=` form (drop the known-bad)
 * degrades toward firing, the `==` form (fire only on the known-good) degrades toward silence. Prefer
 * `!=` for cost filters, and know that a typo'd path in a `==` predicate drops EVERY event. The
 * rejecting predicate is named in the `trigger.webhook` audit row so that is greppable rather than
 * mysterious, and {@link validateFilter} rejects malformed clauses at save time.
 *
 * ⚠ **Author the path against a real delivery, not against the vendor's field names.** Measured on 40
 * live FreeScout deliveries while building this: the obvious-looking `source.type != "api"` does NOT
 * identify the echo, because a conversation-level `source` describes how the CONVERSATION started, not
 * who posted the note that fired this event — `api` appeared on both the echoes and the genuine
 * tickets. Nor is `state != "deleted"` safe there: agents do real work on merged-away conversations.
 * The author of the triggering message generally lives one level down, on the newest thread. A
 * predicate written from the schema instead of from the traffic drops real work silently, which is a
 * far worse failure than the spend it was meant to save.
 * ──────────────────────────────────────────────────────────────────────────────── */

export type PredicateOp = '==' | '!=' | '~' | '!~';

export interface FilterPredicate {
  path: string;
  op: PredicateOp;
  value: string;
  /** The clause as written, for audit + error messages. */
  source: string;
}

export interface ParsedFilter {
  /** The event-name list, i.e. everything before the first `when`/`unless`. */
  events: string;
  /** `when` — every one must hold or the delivery is dropped. */
  predicates: FilterPredicate[];
  /** `unless` — if every one holds, the delivery is dropped. Empty ⇒ nothing is rejected. */
  reject: FilterPredicate[];
  /** Clauses that are not a valid predicate. Non-empty ⇒ the filter is malformed. */
  invalid: string[];
}

/** `path op value`, value optionally quoted. Paths are dot paths, incl. array indices (`threads.0.type`). */
const PREDICATE_RE = /^([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*(==|!=|!~|~)\s*(.*)$/;

const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
};

/** Parse one `and`-joined predicate clause, pushing anything unparseable onto `invalid`. */
function parseClause(clause: string, invalid: string[]): FilterPredicate[] {
  const out: FilterPredicate[] = [];
  for (const part of clause.split(/\s+and\s+/i)) {
    const s = part.trim();
    if (!s) continue;
    const pm = s.match(PREDICATE_RE);
    const value = pm ? unquote(pm[3]) : '';
    if (!pm || !value) { invalid.push(s); continue; }
    out.push({ path: pm[1], op: pm[2] as PredicateOp, value, source: s });
  }
  return out;
}

/**
 * Split a filter into its event list, its `when` predicates and its `unless` predicates. A filter
 * with neither keyword parses to zero of both, so every existing automation keeps its exact behaviour.
 * Either keyword may come first, and each may appear once; a repeat is reported as invalid rather than
 * silently overwriting the earlier one.
 */
export function parseFilter(filter: string | undefined): ParsedFilter {
  const raw = (filter || '').trim();
  // Standalone `when` / `unless` tokens. Event names are dotted tokens and predicate paths never
  // stand alone, so a bare keyword between whitespace is unambiguous.
  const kw = [...raw.matchAll(/(^|[\s,])(when|unless)(\s|$)/gi)];
  if (!kw.length) return { events: raw, predicates: [], reject: [], invalid: [] };

  const events = raw.slice(0, kw[0].index).trim().replace(/,\s*$/, '');
  const invalid: string[] = [];
  const sections: Record<string, string> = {};
  kw.forEach((m, i) => {
    const key = m[2].toLowerCase();
    const from = m.index! + m[0].length;
    const to = i + 1 < kw.length ? kw[i + 1].index! : raw.length;
    const body = raw.slice(from, to).trim();
    if (sections[key] !== undefined) { invalid.push(`${key} (repeated)`); return; }
    sections[key] = body;
  });

  const predicates = sections.when !== undefined ? parseClause(sections.when, invalid) : [];
  const reject = sections.unless !== undefined ? parseClause(sections.unless, invalid) : [];
  // A keyword with nothing after it is a mistake worth naming — it would otherwise read as a
  // clause that quietly does nothing (`when` ⇒ vacuously true) or drops everything (`unless`).
  for (const [k, v] of Object.entries(sections)) if (!v.trim()) invalid.push(`${k} (empty clause)`);
  return { events, predicates, reject, invalid };
}

/** Evaluate one predicate against the parsed body. Comparison is case-insensitive, like the event half. */
function testPredicate(p: FilterPredicate, payload: unknown): boolean {
  const actual = readPath(payload, p.path).toLowerCase();
  const want = p.value.toLowerCase();
  switch (p.op) {
    case '==': return actual === want;
    case '!=': return actual !== want;
    case '~': return actual.includes(want);
    case '!~': return !actual.includes(want);
  }
}

export type FilterVerdict =
  | { ok: true }
  | { ok: false; reason: 'event' }
  | { ok: false; reason: 'payload'; predicate: string };

/**
 * The whole filter decision: the event list, then `when` (all must hold), then `unless` (all holding
 * is a rejection).
 *
 * **A malformed predicate fires anyway.** This filter exists to save money, and the cost of losing a
 * real customer ticket dwarfs the cost of one extra session — so a filter we cannot understand must
 * never be the reason an event is dropped. {@link parseFilter}'s `invalid` list carries the offending
 * clauses so the caller can audit them; {@link validateFilter} is what stops them being saved at all.
 */
export function evaluateFilter(filter: string | undefined, event: string, payload: unknown): FilterVerdict {
  if (!matchesFilter(filter, event)) return { ok: false, reason: 'event' };
  const { predicates, reject } = parseFilter(filter);
  for (const p of predicates) {
    if (!testPredicate(p, payload)) return { ok: false, reason: 'payload', predicate: p.source };
  }
  // `unless` rejects only on the FULL conjunction — one predicate holding is not enough, which is the
  // whole reason this clause exists rather than another `when`.
  if (reject.length && reject.every((p) => testPredicate(p, payload))) {
    return { ok: false, reason: 'payload', predicate: 'unless ' + reject.map((p) => p.source).join(' and ') };
  }
  return { ok: true };
}

/**
 * Save-time validation: the error string for a filter that cannot be honoured, or '' when it is fine.
 * Runtime fails OPEN on a bad predicate, so this is the only place a typo is actually caught — which
 * is why it names the clause rather than just refusing.
 */
export function validateFilter(filter: string | undefined): string {
  const { events, predicates, reject, invalid } = parseFilter(filter);
  if (invalid.length) {
    return `filter: could not parse ${invalid.map((s) => JSON.stringify(s)).join(', ')} — expected \`path == value\` (ops: == != ~ !~), joined by \`and\``;
  }
  if ((predicates.length || reject.length) && !events) {
    // `when …` with nothing before it is almost certainly a mistake, and it silently means
    // "every event, then these predicates" — legal, but worth making the operator write it.
    return 'filter: a `when`/`unless` clause needs an event list before it (use `*` for every event)';
  }
  return '';
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
