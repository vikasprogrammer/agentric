#!/usr/bin/env node
/* Capability-gap test — a request nobody can take must LEAVE A TRACE, without flooding the Inbox.
 *
 * The two failure modes this pins are opposites and both real. Without recording, every unmatched
 * request evaporates into a "pick one of these" roster and the fleet never learns which agent it is
 * missing. With naive recording, the same signal becomes one Inbox card per miss — the flood that has
 * already been diagnosed twice on live tenants — so the rolling card is asserted to stay singular no
 * matter how many gaps arrive, and to push a DM only on the first.
 *
 * Isolated home; no tmux, no ttyd, no network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gap-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { recordCapabilityGap, recentGaps, GAP_WINDOW_MS } = require(path.join(ROOT, 'dist/edge/capability-gap.js'));

const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos, tm } = registry.get('testco');

const pushes = [];
tm.setReviewNotifier((n) => pushes.push(n));

const cards = () => aos.db
  .prepare("SELECT id, title, body, status, audience_kind FROM messages WHERE session_id = 'system:capability-gap' ORDER BY id")
  .all();
const openCards = () => cards().filter((c) => c.status === 'open');
const gapEvents = () => aos.db
  .prepare("SELECT principal, data FROM audit_events WHERE type = 'router.gap' ORDER BY id").all();

console.log('\n\x1b[1m1) One unmatched request is recorded and surfaced\x1b[0m');
recordCapabilityGap(aos, tm, { text: 'translate our docs into Japanese', requester: 'm_alice', source: 'cockpit' });
assert(gapEvents().length === 1, 'the miss lands in the audit trail as router.gap');
assert(JSON.parse(gapEvents()[0].data).text === 'translate our docs into Japanese', 'the request text is kept verbatim — it IS the evidence');
assert(JSON.parse(gapEvents()[0].data).source === 'cockpit', 'the front door it came through is recorded');
assert(gapEvents()[0].principal === 'm_alice', 'the requester is the audit principal');
assert(openCards().length === 1, 'one open admin card');
assert(openCards()[0].audience_kind === 'admins', 'the card is addressed to admins, not to a session');
assert(openCards()[0].body.includes('translate our docs into Japanese'), 'the card names the request');
assert(pushes.length === 1 && pushes[0].audience.kind === 'admins', 'the first gap pushes one DM');
assert(pushes[0].link && pushes[0].link.page === 'agents', 'the DM points at Agents, not the update page it defaults to');

console.log('\n\x1b[1m2) Repeat misses refresh ONE card — they never flood the inbox\x1b[0m');
recordCapabilityGap(aos, tm, { text: 'file our VAT return', requester: 'm_bob', source: 'chat' });
recordCapabilityGap(aos, tm, { text: 'design a logo', requester: 'm_bob', source: 'chat' });
assert(gapEvents().length === 3, 'every miss is still recorded individually in audit');
assert(openCards().length === 1, 'still exactly one OPEN card after three gaps');
assert(cards().filter((c) => c.status === 'cancelled').length === 2, 'each superseded card is closed, not left open');
const latest = openCards()[0];
assert(latest.title.includes('3 requests'), 'the card counts the window');
assert(['translate our docs into Japanese', 'file our VAT return', 'design a logo'].every((t) => latest.body.includes(t)), 'the card lists each distinct request');
assert(pushes.length === 1, 'only the FIRST gap in the window pushed a DM — later ones refresh silently');

console.log('\n\x1b[1m3) The same ask twice is one line, not two\x1b[0m');
recordCapabilityGap(aos, tm, { text: 'Design a Logo', requester: 'm_cara', source: 'cockpit' });
assert(gapEvents().length === 4, 'the repeat is still audited (who asked, and how often, is the signal)');
const body = openCards()[0].body;
assert((body.match(/design a logo/gi) || []).length === 1, 'but the card de-duplicates it case-insensitively');

console.log('\n\x1b[1m4) Nothing is recorded for an empty request\x1b[0m');
const before = gapEvents().length;
recordCapabilityGap(aos, tm, { text: '   ', requester: 'm_alice', source: 'cockpit' });
assert(gapEvents().length === before, 'a blank message is not a capability gap');

console.log('\n\x1b[1m5) The window is honoured\x1b[0m');
aos.db.prepare("UPDATE audit_events SET ts = ? WHERE type = 'router.gap'").run(Date.now() - GAP_WINDOW_MS - 60_000);
assert(recentGaps(aos).length === 0, 'gaps older than the window drop out of the rolling view');
assert(gapEvents().length === before, 'they stay in the audit trail — ageing out is a view, not a delete');

registry.stopAll();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
