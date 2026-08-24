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
const { staleUsageAccounts, refreshStaleUsage, USAGE_STALE_MS, BACKGROUND_USAGE_STALE_MS } = require(path.join(ROOT, 'dist/edge/runtime-account-usage.js'));
const { configDirCanRefresh, checkClaudeToken } = require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));

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

  console.log('\n\x1b[1m6) The SCHEDULER TICK refreshes the snapshot with no human read\x1b[0m');
  // The bug this pins: refreshStaleUsage was reachable ONLY from GET /api/runtime-accounts, so on an
  // unattended box the snapshot froze and pick() kept dispatching to an account that had already hit its
  // weekly wall. Measured on the instawp tenant: ~20% of inbound support tickets silently dropped over
  // three days, each discovered by burning a real customer ticket. Automations.tick now sweeps too.
  reset();
  mk('e');
  // A snapshot that is fresh for the BACKGROUND window must not be probed by the tick...
  store.recordCheck('claude-code', 'e', { ok: true, note: 'valid', usage: usage(20, 5), now: NOW - 60_000 });
  let probed = 0;
  r = refreshStaleUsage(aos, { staleMs: BACKGROUND_USAGE_STALE_MS, probe: async () => { probed++; return { ok: true, note: 'valid', usage: usage(20, 5) }; } });
  await r.done;
  assert(probed === 0, 'a snapshot inside the background window costs nothing on a 20s tick');

  // ...but one older than the background window is re-probed, and an exhausted reading parks the account
  // BEFORE the next pick() can hand it live work.
  const eReset = NOW + 7200_000;
  store.recordCheck('claude-code', 'e', { ok: true, note: 'valid', usage: usage(20, 5), now: NOW - BACKGROUND_USAGE_STALE_MS - 1 });
  r = refreshStaleUsage(aos, {
    staleMs: BACKGROUND_USAGE_STALE_MS,
    probe: async () => { probed++; return { ok: true, note: 'valid · weekly 100% used', usage: { weekly: { usedPct: 100, resetsAt: eReset } }, limitedUntil: eReset }; },
  });
  await r.done;
  assert(probed === 1, 'a snapshot older than the background window IS probed without any console read');
  assert(store.get('claude-code', 'e').usage?.weekly?.usedPct === 100, 'the tick applies the fresh reading');
  const spent = store.get('claude-code', 'e');
  assert(spent.status === 'limited' && spent.limitedUntil === eReset,
    'an exhausted account is parked by the background sweep, not by a dropped ticket', `status=${spent.status}`);

  assert(BACKGROUND_USAGE_STALE_MS > USAGE_STALE_MS,
    'the background window is longer than the read window (nobody is watching a screen)');

  console.log('\n\x1b[1m7) An EXPIRED access token is not mistaken for a dead credential\x1b[0m');
  // A revoked token and a merely-expired one 401 identically. `claude` swaps the refreshToken for a new
  // access token on its next launch, so the expired case is self-healing — but the probe used to brand it
  // "not a valid Claude subscription token; re-run `claude setup-token`". Live cost: the `tools` account sat
  // mislabelled for days, which also hid the REAL state underneath (it was simply at its weekly cap).
  const credDir = (name, blob) => {
    const d = path.join(HOME, 'cred-shape-' + name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify(blob));
    return d;
  };
  const future = Date.now() + 30 * 86400_000, past = Date.now() - 86400_000;
  assert(configDirCanRefresh(credDir('live', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: future } })),
    'a live refreshToken makes the account refreshable');
  assert(!configDirCanRefresh(credDir('expired', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: past } })),
    'an EXPIRED refreshToken is genuinely dead — a human must re-auth');
  assert(!configDirCanRefresh(credDir('none', { claudeAiOauth: { accessToken: 'a' } })),
    'no refreshToken at all is genuinely dead');
  assert(!configDirCanRefresh(path.join(HOME, 'cred-shape-missing')),
    'an unreadable credential dir is not treated as refreshable');
  assert(configDirCanRefresh(credDir('noexp', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } })),
    'a refreshToken with no stated expiry is assumed usable');

  // The 401 branch itself: same status, two verdicts, decided by the credential dir.
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 401, headers: new Headers(), text: async () => '' });
  try {
    const dead = await checkClaudeToken('sk-ant-oat01-x', 5000, {});
    assert(dead.ok === false && /setup-token/.test(dead.note),
      'a 401 with no credential dir is still reported as a dead credential');
    const refreshable = await checkClaudeToken('sk-ant-oat01-x', 5000,
      { configDir: credDir('live2', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: future } }) });
    assert(refreshable.ok === null && /expired/.test(refreshable.note),
      'a 401 on a refreshable dir is "couldn\'t verify", NOT a dead credential', JSON.stringify(refreshable));
    assert(!/setup-token/.test(refreshable.note),
      'and it does NOT tell the operator to re-run setup-token');
  } finally { globalThis.fetch = orig; }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
