#!/usr/bin/env node
/* Slack content filter + channel watch.
 *
 * Two defects this pins, both of which made "an abuse report lands in #trust-safety and an agent picks
 * it up" impossible to configure:
 *
 *   1. A slack automation could be scoped to a channel or an event type and nothing else. Whether the
 *      MESSAGE was the one the automation was about could only be decided inside the spawned session —
 *      i.e. by paying for a whole Claude run to conclude "not mine". A gate written into the agent's
 *      prompt runs after the spawn it was meant to prevent.
 *   2. A plain channel message with no @mention was dropped before it ever reached `fireSlack`, so a
 *      standing watch on a channel could not fire at all: it depended on whoever pasted the report
 *      remembering to summon the bot.
 *
 * The filter grammar is NOT new — a slack filter is now `<scope> [when …] [unless …]`, reusing the
 * predicate half `webhook-ingress.ts` already owns. So the load-bearing assertions here are the
 * backward-compatible ones: an existing filter must parse to exactly its old scope and keep firing, and
 * a channel-watch delivery must never wake a `*`-scoped automation (that would multiply a live tenant's
 * spend with nobody having edited anything).
 *
 * Isolated home; fire/createSession/postMessage stubbed so no tmux, claude or network is needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-slackfilter-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e && e.message ? e.message : 'threw'; } };

const wh = require(path.join(ROOT, 'dist/edge/webhook-ingress.js'));
const slackApi = require(path.join(ROOT, 'dist/connectors/slack.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));
const { SlackSocket } = require(path.join(ROOT, 'dist/edge/slack-socket.js'));

const CH = 'C0ABUSE1';      // the watched channel
const OTHER = 'C0RANDOM';   // a channel the bot also sits in

// ── 1. the grammar split: scope half vs predicate half ───────────────────────────
// If this regresses, EVERY existing slack automation breaks at once — the whole filter string would
// be compared against a channel id and match nothing.
console.log('\ngrammar split');
assert(wh.parseFilter(CH).events === CH, 'a filter with no clause is all scope');
assert(wh.parseFilter(`${CH} when text ~ "abuse report"`).events === CH, 'the scope half stops at `when`');
assert(wh.parseFilter(`${CH} unless actor == "Status Bot"`).events === CH, 'the scope half stops at `unless`');
assert(wh.parseFilter(`${CH} when text ~ "abuse"`).predicates.length === 1, 'the clause parses to a predicate');
assert(wh.evaluatePredicates(`${CH} when text ~ "abuse"`, { text: 'an abuse report' }).ok === true, 'evaluatePredicates: match');
assert(wh.evaluatePredicates(`${CH} when text ~ "abuse"`, { text: 'lunch?' }).ok === false, 'evaluatePredicates: refusal');
assert(wh.evaluatePredicates(CH, { text: 'anything' }).ok === true, 'no clause ⇒ nothing to refuse');
// The webhook lane must be untouched by the split — same call, same verdicts.
assert(wh.evaluateFilter('convo.created', 'convo.created', {}).ok === true, 'webhook regression: event still matches');
assert(wh.evaluateFilter('convo.created', 'customer.created', {}).ok === false, 'webhook regression: event still refuses');
assert(wh.evaluateFilter('convo.* when state != deleted', 'convo.x', { state: 'deleted' }).ok === false, 'webhook regression: predicate still refuses');

// ── 2. wiring ─────────────────────────────────────────────────────────────────────
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);
aos.agents.set('trust', { id: 'trust', name: 'Trust & Safety', runtime: 'claude-code', dir: HOME });

let seq = 0;
const spawned = [];  // automation fires
const routed = [];   // /agent chat-router spawns
autos.fire = (a, opts) => { const id = `s${++seq}`; spawned.push({ automation: a.id, sessionId: id, extra: opts.extra }); return { ok: true, sessionId: id, tmux: id }; };
tm.createSession = (agentId, title) => { const id = `r${++seq}`; routed.push({ agentId, title, id }); return { id, tmux: id }; };

const ev = (over = {}) => ({ eventType: 'app_mention', channel: CH, threadTs: '1.1', user: 'U1', actorLabel: 'Dana', text: 'abuse report: spam from acct 42', raw: { type: 'app_mention', channel: CH, user: 'U1', text: '<@B1> abuse report: spam from acct 42' }, ...over });
const since = () => spawned.length;
const fired = (n) => spawned.length - n;

(async () => {
  // ── 3. backward compatibility ──────────────────────────────────────────────────
  console.log('\nexisting filters keep working');
  const legacyType = autos.add({ agentId: 'trust', name: 'legacy-eventtype', type: 'slack', filter: 'app_mention', task: 't' });
  let n = since(); await autos.fireSlack(ev()); assert(fired(n) === 1, 'an event-type filter still fires on a mention');
  n = since(); await autos.fireSlack(ev({ eventType: 'message', channelType: 'im' })); assert(fired(n) === 0, 'and still refuses another event type');
  autos.remove(legacyType.id);

  const legacyChan = autos.add({ agentId: 'trust', name: 'legacy-channel', type: 'slack', filter: CH, task: 't' });
  n = since(); await autos.fireSlack(ev()); assert(fired(n) === 1, 'a channel filter still fires');
  n = since(); await autos.fireSlack(ev({ channel: OTHER })); assert(fired(n) === 0, 'and still refuses another channel');
  autos.remove(legacyChan.id);

  const wildcard = autos.add({ agentId: 'trust', name: 'wildcard', type: 'slack', filter: '', task: 't' });
  n = since(); await autos.fireSlack(ev({ channel: OTHER })); assert(fired(n) === 1, 'a blank filter is still a catch-all');

  // ── 4. the content filter ──────────────────────────────────────────────────────
  console.log('\ncontent filter');
  autos.remove(wildcard.id);
  const watch = autos.add({ agentId: 'trust', name: 'abuse-watch', type: 'slack', filter: `${CH} when text ~ "abuse report"`, task: 'Triage the report.' });
  n = since(); await autos.fireSlack(ev()); assert(fired(n) === 1, 'a matching message in the scoped channel fires');
  n = since();
  const miss = await autos.fireSlack(ev({ text: 'anyone up for lunch?', raw: { text: 'anyone up for lunch?' } }));
  assert(fired(n) === 0, 'a non-matching message in the SAME channel spawns nothing');
  assert(miss.dropped === 'text ~ "abuse report"', 'the refusing predicate is named for the audit row', String(miss.dropped));
  n = since(); await autos.fireSlack(ev({ channel: OTHER })); assert(fired(n) === 0, 'the channel scope still applies alongside the clause');

  // The predicate reads the mention-STRIPPED text — what a human reads, not `<@B1> …`.
  n = since();
  await autos.fireSlack(ev({ text: 'abuse report', raw: { text: '<@B1> abuse report' } }));
  assert(fired(n) === 1, '`text` is the stripped body, not the raw mention prefix');

  // `actor` is the resolved sender label — there is no path to it in the raw Slack event.
  autos.update(watch.id, { filter: `${CH} unless actor == "Status Bot"` });
  n = since(); await autos.fireSlack(ev({ actorLabel: 'Status Bot' })); assert(fired(n) === 0, '`unless actor == …` drops a known noisy sender');
  n = since(); await autos.fireSlack(ev({ actorLabel: 'Dana' })); assert(fired(n) === 1, 'and lets everyone else through');
  autos.update(watch.id, { filter: `${CH} when text ~ "abuse report"` });

  // ── 5. the channel watch ───────────────────────────────────────────────────────
  console.log('\nchannel watch (no @mention)');
  assert(autos.watchesSlackChannel(CH) === true, 'a channel-scoped automation is a watch');
  assert(autos.watchesSlackChannel(OTHER) === false, 'an unrelated channel is not watched');
  assert(autos.watchesSlackChannel('') === false, 'a blank channel is not watched');

  const plain = { eventType: 'message', channel: CH, threadTs: '2.1', user: 'U2', actorLabel: 'Reporter', text: 'abuse report: spam from acct 99', raw: { type: 'message', channel: CH, text: 'abuse report: spam from acct 99' } };
  n = since();
  const w = await autos.fireSlack(plain, undefined, { channelWatch: true, router: false });
  assert(fired(n) === 1, 'a plain channel message fires the channel-scoped watch');
  assert(w.fired === 1 && w.sessions.length === 1, 'and reports the session it started');

  const routedBefore = routed.length;
  n = since();
  await autos.fireSlack({ ...plain, text: 'anyone up for lunch?', raw: { text: 'anyone up for lunch?' } }, undefined, { channelWatch: true, router: false });
  assert(fired(n) === 0, 'ordinary chatter in a watched channel spawns nothing');
  assert(routed.length === routedBefore, 'and never reaches the /agent router (no help list spammed into the channel)');

  // THE regression to fear: an existing catch-all automation suddenly eating every channel message.
  const catchAll = autos.add({ agentId: 'trust', name: 'catch-all', type: 'slack', filter: '*', task: 't' });
  const evType = autos.add({ agentId: 'trust', name: 'mentions', type: 'slack', filter: 'app_mention', task: 't' });
  n = since();
  await autos.fireSlack(plain, undefined, { channelWatch: true, router: false });
  assert(fired(n) === 1, 'a channel watch wakes ONLY the channel-scoped automation — not `*`, not an event-type scope', `${fired(n)} fired`);
  // …while a real mention still wakes all three.
  n = since(); await autos.fireSlack(ev()); assert(fired(n) === 3, 'an @mention still fans out to every matching automation');
  autos.remove(catchAll.id); autos.remove(evType.id);

  // ── 6. save-time validation ────────────────────────────────────────────────────
  // The predicate layer fails OPEN at runtime, so save time is the only place a typo is caught. Without
  // this a mistyped clause reads as a working filter and silently fires on everything.
  console.log('\nsave-time validation');
  assert(throws(() => autos.add({ agentId: 'trust', name: 'bad', type: 'slack', filter: `${CH} when bogus`, task: 't' })).includes('could not parse'), 'add refuses a malformed clause');
  assert(throws(() => autos.add({ agentId: 'trust', name: 'bad2', type: 'slack', filter: 'when text ~ "x"', task: 't' })).includes('event list'), 'add refuses a clause with no scope before it');
  assert(throws(() => autos.update(watch.id, { filter: `${CH} when bogus` })).includes('could not parse'), 'update refuses one too');
  assert(throws(() => autos.add({ agentId: 'trust', name: 'ok', type: 'slack', filter: `${CH} when text ~ "x"`, task: 't' })) === '', 'a well-formed clause saves');

  // ── 7. the socket gate, end to end ─────────────────────────────────────────────
  // The three lines of glue in slack-socket.ts: watched channel ⇒ fire + ack; anything else ⇒ silence.
  console.log('\nsocket gate');
  const posts = [];
  slackApi.postMessage = async (_t, channel, text, thread) => { posts.push({ channel, text, thread }); return { ts: '9.9' }; };
  aos.settings.slackBotToken = () => 'xoxb-test';
  const sock = new SlackSocket(aos, autos);
  const envelope = (over = {}) => ({ payload: { event: { type: 'message', channel: CH, channel_type: 'channel', user: 'U9', ts: '3.1', text: 'abuse report: spam from acct 7', ...over } } });

  n = since(); const p0 = posts.length;
  await sock.dispatch(envelope());
  assert(fired(n) === 1, 'a non-mention message in a WATCHED channel now reaches fireSlack');
  assert(posts.length === p0 + 1 && posts[p0].thread === '3.1', 'and is acked in a thread under the report itself');

  n = since(); const p1 = posts.length;
  await sock.dispatch(envelope({ channel: OTHER }));
  assert(fired(n) === 0 && posts.length === p1, 'a non-mention message in an unwatched channel is still dropped silently');

  n = since(); const p2 = posts.length;
  await sock.dispatch(envelope({ text: 'anyone up for lunch?' }));
  assert(fired(n) === 0 && posts.length === p2, 'chatter in a watched channel is dropped with no ack');

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
