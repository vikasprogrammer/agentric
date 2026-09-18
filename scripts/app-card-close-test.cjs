#!/usr/bin/env node
/* An `app.proposed` review card must not outlive the review.
 *
 * The Apps routes act on the APP (publish / delete), never on the card, so before this fix nothing ever
 * closed one: a card whose app had been live for weeks still read "awaiting review" in Needs you — five
 * of them on one live tenant, the oldest two months old. Pins the three ways out:
 *   1. publishing the app closes its card (publishing IS what the card asks for);
 *   2. deleting the app closes it too — it can never be acted on again;
 *   3. UNPUBLISHING does not: an agent's edit to a live app unpublishes it and raises a re-review card,
 *      and that card is still waiting for a human;
 *   4. the boot sweep heals cards left open by the old routes, and leaves a genuinely pending one alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-app-card-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 400) : ''}`));

(async () => {
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const get = async (p) => (await fetch(base + p, { headers: { cookie } })).json();
  const post = async (p) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).json();
  const del = async (p) => (await fetch(base + p, { method: 'DELETE', headers: { cookie } })).json();

  // The NEWEST card for a slug, straight from the row — `status` is what "Needs you" keys on. Newest
  // because one app raises several cards over its life (proposed, then re-review after each agent edit).
  const cardStatus = (slug) => {
    const rows = aos.db.prepare(`SELECT args, status FROM messages WHERE type = 'app.proposed' ORDER BY created_at DESC, id DESC`).all();
    const row = rows.find((r) => { try { return JSON.parse(r.args || '{}').slug === slug; } catch { return false; } });
    return row ? row.status : null;
  };
  const propose = (slug) => {
    aos.apps.scaffold(slug, { name: slug, createdBy: 'agent:app-builder' });
    tm.postAppCard({ slug, agent: 'app-builder', title: `App proposed — ${slug}`, body: `app-builder built "${slug}". Review it and publish it to make it live.` });
  };

  console.log('\n\x1b[1m1) publishing the app closes its card\x1b[0m');
  propose('voice-notes');
  assert(cardStatus('voice-notes') === 'open', 'the card starts open — it is the review ask', cardStatus('voice-notes'));
  const inbox = await get('/api/messages');
  assert(inbox.some((m) => m.type === 'app.proposed' && m.args?.slug === 'voice-notes'), 'and an owner sees it in the inbox feed');
  const pub = await post('/api/apps/voice-notes/publish');
  assert(pub.ok === true && pub.app.published === true, 'publish succeeds', pub.error ?? pub.app?.published);
  assert(cardStatus('voice-notes') === 'approved', 'the card is resolved by the act it was asking for', cardStatus('voice-notes'));

  console.log('\n\x1b[1m2) unpublishing does NOT — a re-review card is still waiting\x1b[0m');
  tm.postAppCard({ slug: 'voice-notes', agent: 'app-builder', title: 'App edited — voice-notes', body: 'app-builder changed the live app; re-publish to make the change live.' });
  const unpub = await post('/api/apps/voice-notes/unpublish');
  assert(unpub.ok === true && unpub.app.published === false, 'unpublish succeeds', unpub.error);
  assert(cardStatus('voice-notes') === 'open', 'the re-review card stays open — nobody has reviewed the edit yet', cardStatus('voice-notes'));
  await post('/api/apps/voice-notes/publish');
  assert(cardStatus('voice-notes') === 'approved', 're-publishing closes it', cardStatus('voice-notes'));

  console.log('\n\x1b[1m3) deleting the app closes its card too\x1b[0m');
  propose('scratch-app');
  const gone = await del('/api/apps/scratch-app');
  assert(gone.ok === true, 'delete succeeds', gone.error);
  assert(cardStatus('scratch-app') === 'rejected', 'the card cannot be acted on again, so it is closed', cardStatus('scratch-app'));

  console.log('\n\x1b[1m4) the boot sweep heals cards the old routes left behind\x1b[0m');
  // Exactly the live shape: three cards, whose apps were published / deleted / left proposed outside the
  // console, all still marked open — what a tenant upgrading into this fix actually carries.
  propose('stale-published'); await post('/api/apps/stale-published/publish');
  propose('stale-deleted'); await del('/api/apps/stale-deleted');
  propose('still-pending');
  aos.db.prepare(`UPDATE messages SET status = 'open' WHERE type = 'app.proposed'`).run();
  server.close();
  await registry.stopAll?.();

  const registry2 = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry2.bootAll();
  const aos2 = registry2.default().os;
  const status2 = (slug) => {
    const rows = aos2.db.prepare(`SELECT args, status FROM messages WHERE type = 'app.proposed' ORDER BY created_at DESC, id DESC`).all();
    const row = rows.find((r) => { try { return JSON.parse(r.args || '{}').slug === slug; } catch { return false; } });
    return row ? row.status : null;
  };
  assert(status2('stale-published') === 'approved', 'a card whose app is live reads as approved', status2('stale-published'));
  assert(status2('stale-deleted') === 'rejected', 'a card whose app is gone reads as rejected', status2('stale-deleted'));
  assert(status2('still-pending') === 'open', 'a card whose app is still sitting unpublished is left alone — that one IS pending', status2('still-pending'));
  await registry2.stopAll?.();

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
