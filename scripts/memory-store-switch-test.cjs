#!/usr/bin/env node
/* The migration horizon must move when the STORE moves — not only when the backend TYPE changes.
 *
 * Why this exists: switching backends leaves every existing memory behind in the old store, so
 * `memory_backend_switched_at` marks which local mirror rows still need migrating up (docs/
 * memory-backend-migration-plan.md). Pointing `automem` at a DIFFERENT endpoint has exactly the same
 * effect — the new deployment is empty, recall goes blind, and the Memory hub keeps counting the mirror —
 * but it used to be filed as a "same-backend re-save" and stamped nothing, so the reconcile flow reported
 * "already consistent" over a store that had none of the tenant's memories in it. Found while moving
 * instapods off its remote automem pod (2026-08-30).
 *
 * The opposite error is just as bad, so both directions are pinned: a token / ranking / preload re-save on
 * the SAME endpoint must NOT move the horizon, or already-migrated rows look like orphans again and
 * re-migrate as duplicates. Endpoints here point at a closed port — no network, no backend needed. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-memstore-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.AGENT_OS_OWNER_EMAIL = 'owner@test.local';
delete process.env.AGENT_OS_SECRET_KEY;

const { startServer } = require('../dist/server');
const { loadAgentOS } = require('../dist/kernel');

const server = startServer(0);
server.on('listening', async () => {
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // Owner cookie: the seeded owner + a session row (the login-link dance needs a mail hop we don't want here).
  const aos = loadAgentOS();
  const owner = aos.db.prepare("SELECT id FROM members WHERE role='owner' LIMIT 1").get();
  const now = Date.now();
  aos.db.prepare('INSERT INTO auth_sessions (sid, member_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
    .run('testsid', owner.id, now, now + 86_400_000, now);
  const H = { 'content-type': 'application/json', cookie: 'aos_sid=testsid' };
  const save = (body) => fetch(`${base}/api/settings/memory`, { method: 'PUT', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
  const stamp = () => Number(aos.db.prepare("SELECT value FROM settings WHERE key='memory_backend_switched_at'").get()?.value || 0);

  const A = { backend: 'automem', automem: { endpoint: 'http://127.0.0.1:1/', token: 'tok-a' } };
  await save(A);
  const first = stamp();
  assert.ok(first > 0, 'sqlite → automem stamps the horizon (the case that already worked)');

  // Same store, different credential: NOT a switch — re-stamping would re-migrate migrated rows.
  await save({ backend: 'automem', automem: { endpoint: 'http://127.0.0.1:1', token: 'tok-b' } });
  assert.strictEqual(stamp(), first, 'a token re-save on the same endpoint must not move the horizon');
  await save({ backend: 'automem', automem: { endpoint: 'http://127.0.0.1:1' }, ranking: { halfLifeDays: 30 }, preload: { enabled: true, count: 5 } });
  assert.strictEqual(stamp(), first, 'ranking/preload edits must not move the horizon');
  // A trailing slash is the same endpoint, not a new store.
  await save({ backend: 'automem', automem: { endpoint: 'http://127.0.0.1:1/' } });
  assert.strictEqual(stamp(), first, 'a trailing slash is the same store');

  // Different endpoint = a different, EMPTY store: the whole mirror is an orphan again.
  await save({ backend: 'automem', automem: { endpoint: 'http://127.0.0.1:2', token: 'tok-b' } });
  const moved = stamp();
  assert.ok(moved > first, `moving automem to another endpoint must stamp a new horizon (${first} → ${moved})`);

  // And the audit says what happened, with both stores named.
  const ev = aos.db.prepare("SELECT data FROM audit_events WHERE type='memory.backend.changed' ORDER BY ts DESC LIMIT 1").get();
  const d = JSON.parse(ev.data);
  assert.ok(String(d.fromStore).includes('127.0.0.1:1') && String(d.store).includes('127.0.0.1:2'), 'the audit event names both stores');

  server.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('memory-store-switch-test: ok (endpoint move stamps the horizon; token/ranking re-saves do not)');
  process.exit(0);
});
setTimeout(() => { console.error('memory-store-switch-test: server never listened'); process.exit(1); }, 20_000).unref();
