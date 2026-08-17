#!/usr/bin/env node
/* Webhook ingress test — the generic /hooks/<id> lane must never silently DROP an event, and must never
 * spawn a run for one it was not asked about.
 *
 * The defect this pins: fireWebhook used to fire with `guard: true`, so any delivery arriving while the
 * previous run was still alive came back 429. A product webhook does not retry a 4xx, so a busy agent
 * lost real events — the busier it got, the more it lost. Volume now belongs to filter + dedupe +
 * conversation continuity, and genuinely concurrent conversations run in parallel.
 *
 * Covered here: the four pure resolvers (event / filter / delivery key / thread key), signature
 * verification across the encodings real sources send, and the fire path end to end — filter skip,
 * dedupe, continuity into a live run, concurrent deliveries, and the auth failures that must still 4xx.
 * Isolated home; deliver/spawn stubbed so no tmux or claude is needed. */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-webhook-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const wh = require(path.join(ROOT, 'dist/edge/webhook-ingress.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const Q = (s) => new URLSearchParams(s || '');

// ── 1. event resolution ───────────────────────────────────────────────────────────
console.log('\nevent resolution');
assert(wh.resolveEvent({}, Q('event=a.b'), {}) === 'a.b', 'query param wins');
assert(wh.resolveEvent({ 'x-freescout-event': 'convo.created' }, Q(), {}) === 'convo.created', 'x-<vendor>-event header');
assert(wh.resolveEvent({ 'x-github-event': 'issues' }, Q(), {}) === 'issues', 'a vendor we never coded for');
assert(wh.resolveEvent({ 'x-shopify-topic': 'orders/create' }, Q(), {}) === 'orders/create', 'x-<vendor>-topic too');
assert(wh.resolveEvent({}, Q(), { event: 'ticket.new' }) === 'ticket.new', 'payload field');
assert(wh.resolveEvent({}, Q(), { action: 'opened' }) === 'opened', 'payload action');
assert(wh.resolveEvent({}, Q(), { nested: { event: 'x' } }) === '', 'no guessing at nested fields');
assert(wh.resolveEvent({ 'x-a-event': 'h' }, Q('event=q'), { event: 'p' }) === 'q', 'precedence query > header > payload');

// ── 2. filter matching ────────────────────────────────────────────────────────────
console.log('\nfilter matching');
assert(wh.matchesFilter('', 'anything') === true, "'' is a catch-all (existing automations keep firing)");
assert(wh.matchesFilter('*', 'anything') === true, "'*' is a catch-all");
assert(wh.matchesFilter('convo.created', 'convo.created') === true, 'exact match');
assert(wh.matchesFilter('convo.created', 'convo.deleted') === false, 'non-match is refused');
assert(wh.matchesFilter('convo.created, convo.note.created', 'convo.note.created') === true, 'comma list');
assert(wh.matchesFilter('convo.*', 'convo.note.created') === true, 'prefix wildcard');
assert(wh.matchesFilter('convo.*', 'customer.created') === false, 'prefix wildcard does not over-match');
assert(wh.matchesFilter('CONVO.Created', 'convo.created') === true, 'case-insensitive');
// The load-bearing one: an event we could not identify must not sneak past a real filter.
assert(wh.matchesFilter('convo.created', '') === false, 'unidentifiable event fails a real filter');
assert(wh.matchesFilter('', '') === true, 'unidentifiable event still passes a catch-all');

// ── 2b. payload predicates (the `when` clause) ────────────────────────────────────
// The defect: an event-name filter cannot express the thing that actually wastes money on a live
// source — the agent's OWN note echoing back as a new event. On instawp's FreeScout hook that was
// 79 of 177 runs in a week, each spawning a full session to conclude "that note was mine".
// The payloads below are synthetic and only exercise the MECHANISM: which real field identifies an
// echo is a per-source question that must be answered from real traffic (see webhook-ingress.ts).
console.log('\npayload predicates');
const ECHO = { state: 'published', source: { type: 'api' }, createdBy: { type: 'user' } };
const HUMAN = { state: 'published', source: { type: 'email' }, createdBy: { type: 'customer' } };
const HUSK = { state: 'deleted', source: { type: 'email' } };

assert(wh.parseFilter('convo.created').predicates.length === 0, 'a filter with no `when` has no predicates');
assert(wh.parseFilter('convo.created').events === 'convo.created', 'and keeps its event list verbatim');
const pf = wh.parseFilter('convo.created, convo.note.created when state != deleted and source.type != "api"');
assert(pf.events === 'convo.created, convo.note.created', 'the event list stops at `when`');
assert(pf.predicates.length === 2, 'both clauses parse', JSON.stringify(pf.predicates));
assert(pf.predicates[1].value === 'api', 'a quoted value is unquoted');
assert(pf.invalid.length === 0, 'a well-formed clause reports nothing invalid');

const ev = (filter, event, payload) => wh.evaluateFilter(filter, event, payload);
const F = 'convo.created, convo.note.created when state != deleted and source.type != api';
assert(ev(F, 'convo.note.created', HUMAN).ok === true, 'a real customer event still fires');
assert(ev(F, 'convo.note.created', ECHO).ok === false, "the agent's own API-posted note is dropped");
assert(ev(F, 'convo.note.created', ECHO).predicate.includes('source.type'), 'and the audit names the predicate that rejected it');
assert(ev(F, 'convo.created', HUSK).ok === false, 'a deleted merge husk is dropped');
assert(ev(F, 'customer.created', HUMAN).reason === 'event', 'the event half still runs first');
// Case-insensitivity matches the event half.
assert(ev('* when state != DELETED', 'x', { state: 'deleted' }).ok === false, 'comparison is case-insensitive');
// Ops.
assert(ev('* when subject ~ invoice', 'x', { subject: 'Your INVOICE is due' }).ok === true, '~ is a contains test');
assert(ev('* when subject !~ invoice', 'x', { subject: 'Your invoice is due' }).ok === false, '!~ is its negation');
// The documented asymmetry on a missing field — the reason `!=` is the recommended form.
assert(ev('* when state != deleted', 'x', {}).ok === true, 'a missing path PASSES !=  (degrades toward firing)');
assert(ev('* when state == published', 'x', {}).ok === false, 'a missing path FAILS == (degrades toward silence)');
// Fail-open: a filter we cannot parse must never be the reason a real ticket is lost.
const junk = wh.parseFilter('convo.created when ???');
assert(junk.invalid.length === 1, 'an unparseable clause is reported');
assert(ev('convo.created when ???', 'convo.created', {}).ok === true, 'and is IGNORED at runtime, not treated as a drop');
// …because it is refused at save time instead.
assert(wh.validateFilter('convo.created when ???') !== '', 'validateFilter rejects it');
assert(wh.validateFilter('convo.created when state != deleted') === '', 'and accepts a good one');
assert(wh.validateFilter('convo.created') === '', 'a plain event list is always valid');
assert(wh.validateFilter('when state != deleted') !== '', 'a `when` with no event list is refused (write `*`)');
// matchesFilter keeps its old contract, now over the event half only.
assert(wh.matchesFilter('convo.created when state != deleted', 'convo.created') === true, 'matchesFilter ignores the when clause');

// ── 3. delivery + thread keys ─────────────────────────────────────────────────────
console.log('\ndelivery + thread keys');
assert(wh.deliveryKey({}, Q('delivery=d1'), 'body') === 'd1', 'query delivery id');
assert(wh.deliveryKey({ 'x-github-delivery': 'g1' }, Q(), 'body') === 'g1', 'header delivery id');
assert(wh.deliveryKey({ 'x-freescout-signature': 'sig' }, Q(), 'body') === 'sig', 'signature doubles as a delivery id');
const k1 = wh.deliveryKey({}, Q(), '{"a":1}');
assert(k1.startsWith('sha256:') && k1 === wh.deliveryKey({}, Q(), '{"a":1}'), 'body hash fallback is stable');
assert(k1 !== wh.deliveryKey({}, Q(), '{"a":2}'), 'body hash separates different bodies');
assert(wh.threadKey(Q(), { conversation: { id: 42 } }, 'conversation.id') === '42', 'dot path into the payload');
assert(wh.threadKey(Q('thread=t9'), { conversation: { id: 42 } }, 'conversation.id') === 't9', 'query overrides the path');
assert(wh.threadKey(Q(), { conversation: { id: 42 } }, '') === '', 'no path configured ⇒ no continuity');
assert(wh.threadKey(Q(), { a: { b: {} } }, 'a.b') === '', 'a non-scalar is not a thread key');

// ── 4. signature verification ─────────────────────────────────────────────────────
console.log('\nsignature verification');
const BODY = '{"conversation":{"id":7},"note":"hi"}';
const SEC = 'sh-secret';
const sha1b64 = crypto.createHmac('sha1', SEC).update(BODY).digest('base64');
const sha256hex = crypto.createHmac('sha256', SEC).update(BODY).digest('hex');
assert(wh.verifySignature(BODY, SEC, { 'x-freescout-signature': sha1b64 }) === true, 'hmac-sha1 base64 (the FreeScout shape)');
assert(wh.verifySignature(BODY, SEC, { 'x-hub-signature-256': `sha256=${sha256hex}` }) === true, 'prefixed hmac-sha256 hex (the GitHub shape)');
assert(wh.verifySignature(BODY, SEC, { 'x-any-signature': sha256hex }) === true, 'bare hex');
assert(wh.verifySignature(BODY, SEC, { 'x-freescout-signature': sha1b64.slice(0, -2) + 'xx' }) === false, 'a tampered signature fails');
assert(wh.verifySignature(BODY + ' ', SEC, { 'x-freescout-signature': sha1b64 }) === false, 'a tampered BODY fails');
assert(wh.verifySignature(BODY, 'other', { 'x-freescout-signature': sha1b64 }) === false, 'the wrong secret fails');
assert(wh.verifySignature(BODY, SEC, {}) === false, 'configured but unsigned is refused');
// A prefix pins the algorithm — a sha1 digest presented as sha256 must not be accepted.
assert(wh.verifySignature(BODY, SEC, { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha1', SEC).update(BODY).digest('hex')}` }) === false, 'a declared algorithm is enforced');
assert(wh.verifySignature(BODY, '', { }) === true, 'no secret configured ⇒ URL key is the credential');

// ── 5. the fire path ──────────────────────────────────────────────────────────────
console.log('\nfire path');
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

// Stub the two ends: spawning a real session needs tmux + claude; delivering needs a live pane.
let seq = 0;
const spawned = [];
const live = new Set();
const delivered = [];
autos.fire = (a, opts) => {
  const sessionId = `s${++seq}`;
  spawned.push({ automation: a.id, sessionId, extra: opts.extra, guard: opts.guard });
  return { ok: true, sessionId, tmux: sessionId };
};
tm.deliverToResident = (id, text) => live.has(id) ? (delivered.push({ id, text }), true) : false;

aos.agents.set('support', { id: 'support', name: 'Support', runtime: 'claude-code', dir: HOME });
const agentId = 'support';
const hook = autos.add({
  agentId, name: 'Inbound ticket', type: 'webhook',
  filter: 'convo.created, convo.note.created',
  threadPath: 'conversation.id',
  signingSecret: SEC,
  task: 'Work the ticket.',
});

assert(hook.mode === 'headless', 'a webhook automation defaults to headless, not an unattachable TUI');

const post = (body, headers = {}, query = '') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sign = { 'x-freescout-signature': crypto.createHmac('sha1', SEC).update(raw).digest('base64') };
  let json = {};
  try { const v = JSON.parse(raw || '{}'); if (v && typeof v === 'object') json = v; } catch {}
  return autos.fireWebhook(hook.id, hook.secret, json, { headers: { ...sign, ...headers }, query: Q(query), rawBody: raw });
};

// auth
assert(autos.fireWebhook('nope', 'k', {}, {}).status === 404, 'unknown hook → 404');
assert(autos.fireWebhook(hook.id, 'wrong-key', {}, {}).status === 403, 'bad URL key → 403');
const unsigned = autos.fireWebhook(hook.id, hook.secret, {}, { headers: {}, query: Q(), rawBody: '{}' });
assert(unsigned.status === 401, 'signing secret set + unsigned delivery → 401', `got ${unsigned.status}`);

// filter
const before = spawned.length;
const filtered = post({ conversation: { id: 1 } }, { 'x-freescout-event': 'customer.created' });
assert(filtered.status === 200 && filtered.body.skipped === 'filter', 'an unsubscribed event is acknowledged 200, not errored');
assert(spawned.length === before, 'an unsubscribed event spawns nothing');

// fire
const first = post({ conversation: { id: 7 }, subject: 'help' }, { 'x-freescout-event': 'convo.created', 'x-freescout-delivery': 'd-1' });
assert(first.status === 200 && !!first.body.sessionId, 'a subscribed event fires');
assert(spawned.at(-1).guard === false, 'it fires UNGUARDED — a busy agent must not drop the next ticket');
assert(String(spawned.at(-1).extra).includes('convo.created'), 'the event name reaches the agent prompt');

// dedupe
const dupe = post({ conversation: { id: 7 }, subject: 'help' }, { 'x-freescout-event': 'convo.created', 'x-freescout-delivery': 'd-1' });
assert(dupe.status === 200 && dupe.body.skipped === 'duplicate', 'a re-delivery is acknowledged, not re-run');

// THE regression: a second, different ticket arriving while the first run is still alive.
const secondTicket = post({ conversation: { id: 8 }, subject: 'other' }, { 'x-freescout-event': 'convo.created', 'x-freescout-delivery': 'd-2' });
assert(secondTicket.status === 200 && !!secondTicket.body.sessionId, 'a DIFFERENT ticket during a live run still fires (the 429 drop is gone)');
assert(secondTicket.body.sessionId !== first.body.sessionId, 'and it gets its own run');

// continuity: a follow-up on ticket 7, whose run is live, goes INTO that run
live.add(first.body.sessionId);
const followUp = post({ conversation: { id: 7 }, note: 'more info' }, { 'x-freescout-event': 'convo.note.created', 'x-freescout-delivery': 'd-3' });
assert(followUp.body.continued === true && followUp.body.sessionId === first.body.sessionId, 'a follow-up continues the run that owns that ticket');
assert(delivered.at(-1).text.includes('more info'), 'the follow-up payload is what gets delivered');
assert(String(delivered.at(-1).text).includes('convo.note.created'), 'and it carries its own event name');

// continuity is per conversation, not per automation
const other = post({ conversation: { id: 9 }, subject: 'third' }, { 'x-freescout-event': 'convo.created', 'x-freescout-delivery': 'd-4' });
assert(!!other.body.sessionId && !other.body.continued, 'an unrelated ticket does not get folded into a live run');

// a dead run does not swallow follow-ups forever
live.delete(first.body.sessionId);
const afterDeath = post({ conversation: { id: 7 }, note: 'later' }, { 'x-freescout-event': 'convo.note.created', 'x-freescout-delivery': 'd-5' });
assert(!afterDeath.body.continued && !!afterDeath.body.sessionId, 'once its run is gone, a follow-up starts a fresh one');

// the echo loop, end to end: the agent's own note must not buy a session to ignore itself
const echoHook = autos.add({
  agentId, name: 'Inbound (payload-filtered)', type: 'webhook',
  filter: 'convo.created, convo.note.created when state != deleted and source.type != api',
  threadPath: 'conversation.id', task: 'Work the ticket.',
});
const postEcho = (body, event, delivery) => autos.fireWebhook(echoHook.id, echoHook.secret, body,
  { headers: { 'x-freescout-event': event, 'x-freescout-delivery': delivery }, query: Q(), rawBody: JSON.stringify(body) });

const n0 = spawned.length;
const ownNote = postEcho({ conversation: { id: 20 }, state: 'published', source: { type: 'api' } }, 'convo.note.created', 'e-1');
assert(ownNote.status === 200 && ownNote.body.skipped === 'filter', "the agent's own note is acknowledged and dropped");
assert(spawned.length === n0, 'and spawns NOTHING — the whole point of the change');
const husk = postEcho({ conversation: { id: 21 }, state: 'deleted', source: { type: 'email' } }, 'convo.created', 'e-2');
assert(husk.body.skipped === 'filter' && spawned.length === n0, 'a deleted merge husk spawns nothing either');
const real = postEcho({ conversation: { id: 22 }, state: 'published', source: { type: 'email' } }, 'convo.created', 'e-3');
assert(!!real.body.sessionId && spawned.length === n0 + 1, 'a genuine customer ticket still fires');

// save-time validation is what keeps a typo out of the DB in the first place
let refused = '';
try { autos.add({ agentId, name: 'Bad', type: 'webhook', filter: 'convo.created when nonsense', task: 'x' }); }
catch (e) { refused = String(e.message); }
assert(refused.includes('could not parse'), 'add() refuses a malformed when clause', refused);
let refusedUpdate = '';
try { autos.update(echoHook.id, { filter: 'convo.created when ??' }); } catch (e) { refusedUpdate = String(e.message); }
assert(refusedUpdate.includes('could not parse'), 'update() refuses one too');
assert(autos.get(echoHook.id).filter.includes('source.type != api'), 'and the refused edit did not land');

// an automation with no filter/secret/threadPath behaves exactly as it always did
const legacy = autos.add({ agentId, name: 'Legacy', type: 'webhook', task: 'x' });
const legacyOut = autos.fireWebhook(legacy.id, legacy.secret, { anything: 1 }, { headers: {}, query: Q(), rawBody: '{"anything":1}' });
assert(legacyOut.status === 200 && !!legacyOut.body.sessionId, 'an unconfigured webhook fires on anything, unsigned (no behaviour change)');

// disabled
autos.update(legacy.id, { enabled: false });
assert(autos.fireWebhook(legacy.id, legacy.secret, {}, { rawBody: '{}' }).status === 409, 'a disabled automation → 409');

// the new webhook fields survive an unrelated edit, and are editable after creation
autos.update(hook.id, { name: 'Renamed' });
const kept = autos.get(hook.id);
assert(kept.signingSecret === SEC && kept.threadPath === 'conversation.id' && kept.filter.includes('convo.created'),
  'an unrelated edit does not wipe the ingress config');
const retuned = autos.update(hook.id, { filter: 'convo.*', threadPath: 'ticket.id', signingSecret: 'rotated' });
assert(retuned.filter === 'convo.*' && retuned.threadPath === 'ticket.id' && retuned.signingSecret === 'rotated',
  'filter / thread path / signing secret are all editable');
assert(autos.update(hook.id, { signingSecret: null }).signingSecret === undefined, 'the signing secret can be cleared back to URL-key auth');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
