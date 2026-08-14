#!/usr/bin/env node
/* Lazy usage-refresh test — reading the runtime-account pool re-probes a STALE usage snapshot in the
 * background, and applies the result the same way the manual Refresh button does.
 *
 * Why this exists: the pool's LIMIT state self-heals (recover() runs inside list()/get()/pick()), but the
 * usage percentages were only ever written at add-time and by a human clicking Refresh — so the console
 * showed a frozen reading, and an account that hit its wall outside our own teardown detector still looked
 * comfortable. The invariants pinned here: only enabled Claude subscription accounts are probed, a fresh
 * snapshot is left alone, an exhausted window parks the account, a clean probe clears a stale limit, a
 * disabled account is never silently revived, and a concurrent read never double-probes.
 * Isolated home; the probe is injected, so no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-usage-refresh-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { staleUsageAccounts, refreshStaleUsage, USAGE_STALE_MS } = require(path.join(ROOT, 'dist/edge/runtime-account-usage.js'));

const aos = loadAgentOS();
const store = aos.runtimeAccounts;

// A credential dir holding a login token — what an `oauth` account is probed with.
const mkDir = (name) => {
  const dir = path.join(HOME, 'cred-' + name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-' + name } }));
  return dir;
};
const reset = () => { for (const a of store.list()) store.remove(a.runtime, a.name); };
const mk = (name) => store.add({ runtime: 'claude-code', name, kind: 'oauth', configDir: mkDir(name) });
const usage = (weeklyPct, sessionPct) => ({ weekly: { usedPct: weeklyPct }, session: { usedPct: sessionPct } });
const auditMark = () => aos.db.prepare('SELECT MAX(id) m FROM audit_events').get().m ?? 0;
const auditSince = (m) => aos.db.prepare('SELECT type FROM audit_events WHERE id > ?').all(m).map((r) => r.type);
const NOW = Date.now();

(async () => {
  console.log('\n\x1b[1m1) Only accounts with a usable, stale snapshot are selected\x1b[0m');
  reset();
  mk('fresh'); store.recordCheck('claude-code', 'fresh', { ok: true, note: 'valid', usage: usage(10, 5), now: NOW });
  mk('stale'); store.recordCheck('claude-code', 'stale', { ok: true, note: 'valid', usage: usage(90, 5), now: NOW - USAGE_STALE_MS - 1 });
  mk('never');
  mk('off'); store.setEnabled('claude-code', 'off', false);
  aos.secrets.set(aos.tenant, 'k-apikey', 'sk-x', { principal: '*' });
  store.add({ runtime: 'claude-code', name: 'billed', kind: 'apikey', apiKeyRef: 'k-apikey' });
  const picked = staleUsageAccounts(store.list(NOW), NOW).map((a) => a.name).sort();
  assert(JSON.stringify(picked) === JSON.stringify(['never', 'stale']), 'stale + never-checked are selected', picked.join(','));
  assert(!picked.includes('fresh'), 'a snapshot inside the staleness window is not re-probed');
  assert(!picked.includes('off'), 'a DISABLED account is never probed (a background probe must not revive one)');
  assert(!picked.includes('billed'), 'an api-key account is skipped — usage-billed, no subscription window');

  console.log('\n\x1b[1m2) A clean probe refreshes the snapshot and clears a stale limit\x1b[0m');
  reset();
  mk('a');
  store.markLimited('claude-code', 'a', NOW + 3600_000);
  assert(store.get('claude-code', 'a').status === 'limited', 'account starts parked with a future reset');
  let m = auditMark();
  const seen = [];
  let r = refreshStaleUsage(aos, { probe: async (t) => { seen.push(t); return { ok: true, note: 'valid · weekly 42% used', usage: usage(42, 8) }; } });
  assert(r.refreshing.includes('claude-code/a'), 'the read reports the account as refreshing');
  await r.done;
  const a1 = store.get('claude-code', 'a');
  assert(seen[0] === 'sk-ant-oat01-a', 'the credential dir\'s own login token was probed', seen[0]);
  assert(a1.usage?.weekly?.usedPct === 42, 'the usage snapshot is updated');
  assert(a1.status === 'available' && a1.limitedUntil == null,
    'a probe that authenticates with no exhausted window clears the stale limit (the frozen "limited · resets …" bug)');
  assert(auditSince(m).includes('runtime.account.checked'), 'the status change is audited');

  console.log('\n\x1b[1m3) An exhausted window parks the account; an unchanged result is silent\x1b[0m');
  reset();
  mk('b');
  const resetsAt = NOW + 7200_000;
  r = refreshStaleUsage(aos, { probe: async () => ({ ok: true, note: 'valid · weekly 100% used', usage: { weekly: { usedPct: 100, resetsAt } }, limitedUntil: resetsAt }) });
  await r.done;
  const b1 = store.get('claude-code', 'b');
  assert(b1.status === 'limited' && b1.limitedUntil === resetsAt, 'an exhausted weekly window parks it until its reset');
  m = auditMark();
  // Same result again on a now-fresh account: nothing to probe, so nothing to audit.
  r = refreshStaleUsage(aos, { probe: async () => { throw new Error('should not be probed'); } });
  await r.done;
  assert(r.refreshing.length === 0, 'a just-probed account is fresh — the next read kicks nothing');
  assert(auditSince(m).length === 0, 'a no-op sweep writes no audit noise');

  console.log('\n\x1b[1m4) Concurrent reads never double-probe the same account\x1b[0m');
  reset();
  mk('c');
  let calls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = refreshStaleUsage(aos, { probe: async () => { calls++; await gate; return { ok: true, note: 'valid', usage: usage(7, 3) }; } });
  const second = refreshStaleUsage(aos, { probe: async () => { calls++; return { ok: true, note: 'valid', usage: usage(7, 3) }; } });
  assert(second.refreshing.includes('claude-code/c'), 'the second read still reports it as refreshing (so the console keeps polling)');
  release();
  await Promise.all([first.done, second.done]);
  assert(calls === 1, 'the in-flight probe is de-duped — one probe, not one per reader', `calls=${calls}`);

  console.log('\n\x1b[1m5) A failing probe leaves the last known snapshot intact\x1b[0m');
  reset();
  mk('d'); store.recordCheck('claude-code', 'd', { ok: true, note: 'valid', usage: usage(55, 11), now: NOW - USAGE_STALE_MS - 1 });
  r = refreshStaleUsage(aos, { probe: async () => { throw new Error('network down'); } });
  await r.done;
  assert(store.get('claude-code', 'd').usage?.weekly?.usedPct === 55, 'the previous reading survives a probe that throws');
  assert(store.get('claude-code', 'd').enabled === true, 'a failed probe never disables an account');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
