#!/usr/bin/env node
/* secret rotation test — the third `secret_request` mode. An agent that HOLDS a credential whose value
 * is being rejected (expired/revoked upstream) used to hit the `exists` short-circuit ("you already have
 * this"), which is useless precisely when the value it has is the broken thing; the only route was a
 * human deleting and re-adding the key. This pins:
 *   • rotate:true is the ONLY way past `exists` (a plain request still short-circuits, so a forgetful
 *     agent can't nag a human), and it outranks `access` (an agent can hold a key by SHELL INJECTION
 *     without secret_get rights — that agent must still be able to report the value as dead),
 *   • a rotate for a key the vault doesn't hold degrades to `provide` — there is nothing to replace,
 *   • fulfilling a rotation overwrites EVERY principal holding the key (a half-rotated secret is worse
 *     than a missing one: whoever resolves the stale copy fails against a credential that LOOKS present),
 *     and MERGES the shell-injection assignment instead of replacing it (which would un-inject others),
 *   • a `secret_put` over an existing shared key is announced to the approver as a REPLACEMENT.
 * Isolated home; no ttyd. */
const fs = require('fs'); const os = require('os'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-secret-rotate-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const check = (name, ok, d) => ok ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  tm.backend.aliveNames = () => new Set();
  tm.backend.kill = () => {}; tm.backend.hasClient = () => false;
  tm.backend.spawn = () => {}; tm.backend.capturePane = () => null;
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const dir = path.join(aos.paths.userAgents, 'pay-bot');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { id: 'pay-bot', version: '1.0.0', description: 'billing', principal: 'svc-pay-bot', policyContext: 'default@v3', runtime: 'claude-code' };
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# pay\n');
  aos.registerAgent({ ...manifest, dir });

  const session = tm.createSession('pay-bot', 'rotation test', 'task');
  const SID = session.id;
  const cards = () => aos.db.prepare("SELECT id, title, status, args FROM messages WHERE type='secret.request' ORDER BY created_at").all()
    .map((r) => ({ ...r, args: JSON.parse(r.args || '{}') }));
  const clearCards = () => aos.db.prepare("DELETE FROM messages WHERE type='secret.request'").run();

  // ── 1) a readable key: plain request short-circuits, rotate does not ────────────────────────────
  console.log('\n\x1b[1m1) rotate is the only way past the `exists` short-circuit\x1b[0m');
  aos.secrets.set('testco', 'STRIPE_KEY', 'sk_live_old', { principal: '*', updatedBy: 'owner@x.io' });
  const plain = tm.requestSecret(SID, 'pay-bot', 'STRIPE_KEY', 'need it');
  check('a plain request for a key it can read still says `exists`', plain.ok && plain.status === 'exists', JSON.stringify(plain));
  check('...and posts no card for a human', cards().length === 0);
  const rot = tm.requestSecret(SID, 'pay-bot', 'STRIPE_KEY', 'stripe returns 401 invalid_api_key', { rotate: true });
  check('rotate:true is accepted as a request', rot.ok && rot.status === 'requested', JSON.stringify(rot));
  check('...tagged mode=rotate', rot.mode === 'rotate');
  check('...carrying the principals it would overwrite', Array.isArray(rot.locations) && rot.locations.join() === '*', JSON.stringify(rot.locations));
  const rotCard = cards()[0];
  check('the card reads as a rotation, not a first-time ask', /rotation requested/i.test(rotCard.title), rotCard && rotCard.title);
  check('...and the agent\'s error text reaches the human', rotCard.args.mode === 'rotate' && cards()[0].args.key === 'STRIPE_KEY');

  console.log('\n\x1b[1m2) dedupe + degrade\x1b[0m');
  const dupe = tm.requestSecret(SID, 'pay-bot', 'STRIPE_KEY', 'again', { rotate: true });
  check('a second rotation while one is open is a duplicate', dupe.ok && dupe.status === 'duplicate', JSON.stringify(dupe));
  const nothing = tm.requestSecret(SID, 'pay-bot', 'NEVER_STORED', 'need it', { rotate: true });
  check('a rotate for a key the vault does not hold degrades to provide', nothing.ok && nothing.mode === 'provide', JSON.stringify(nothing));

  // ── 3) injected-but-unreadable: rotate must outrank access ──────────────────────────────────────
  console.log('\n\x1b[1m3) rotate outranks access (a key held only by shell injection)\x1b[0m');
  aos.secrets.set('testco', 'OPS_TOKEN', 'tok_old', { principal: 'ops-bot', updatedBy: 'owner@x.io' });
  const acc = tm.requestSecret(SID, 'pay-bot', 'OPS_TOKEN', 'need it');
  check('without rotate, an unreadable existing key is an access request', acc.ok && acc.mode === 'access', JSON.stringify(acc));
  clearCards();
  const accRot = tm.requestSecret(SID, 'pay-bot', 'OPS_TOKEN', 'the injected value 403s', { rotate: true });
  check('with rotate, the same key is a rotation (it can hold it via injection)', accRot.ok && accRot.mode === 'rotate', JSON.stringify(accRot));

  // ── 4) fulfilling a rotation ────────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m4) fulfilling a rotation overwrites every copy and keeps assignments\x1b[0m');
  clearCards();
  // The same key stored twice — the shape that makes a half-rotation dangerous.
  aos.secrets.set('testco', 'SHARED_KEY', 'v_old', { principal: '*', updatedBy: 'owner@x.io' });
  aos.secrets.set('testco', 'SHARED_KEY', 'v_old', { principal: 'ops-bot', updatedBy: 'owner@x.io' });
  aos.secrets.setAssignedAgents('testco', '*', 'SHARED_KEY', ['ops-bot']);
  const multi = tm.requestSecret(SID, 'pay-bot', 'SHARED_KEY', 'both copies are dead', { rotate: true });
  check('locations lists every principal holding the key', (multi.locations || []).slice().sort().join() === '*,ops-bot', JSON.stringify(multi.locations));

  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const fulfill = (id, body) => fetch(`${base}/api/secrets/requests/${id}/fulfill`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const open = () => cards().find((c) => c.status === 'open' && c.args.key === 'SHARED_KEY');

  const noValue = await fulfill(open().id, { inject: true });
  check('a rotation with no replacement value is refused', noValue.status === 400, String(noValue.status));

  const listed = await (await fetch(`${base}/api/secrets/requests`, { headers: { cookie } })).json();
  const row = (listed.requests || []).find((r) => r.key === 'SHARED_KEY');
  check('the console lists the rotation with its live blast radius', row && row.mode === 'rotate' && (row.locations || []).length === 2, JSON.stringify(row));

  const done = await (await fulfill(open().id, { value: 'v_new', inject: true })).json();
  check('an owner fulfils the rotation', done.ok === true && done.rotated === 2, JSON.stringify(done));
  check('the shared copy is replaced', aos.secrets.getSync('testco', 'nobody', 'SHARED_KEY') === 'v_new');
  check('the other agent\'s copy is replaced too — nobody is left on the stale value', aos.secrets.getSync('testco', 'ops-bot', 'SHARED_KEY') === 'v_new');
  const assigned = aos.secrets.assignedAgents('testco', '*', 'SHARED_KEY').slice().sort().join();
  check('the requester is ADDED to the injection list, not swapped in for the others', assigned === 'ops-bot,pay-bot', assigned);
  check('the card is closed', !open());
  const audited = aos.db.prepare("SELECT data FROM audit_events WHERE type='secret.request.rotated'").all().map((r) => JSON.parse(r.data));
  check('the rotation is audited with its principals and no value', audited.length === 1 && audited[0].principals.length === 2 && !JSON.stringify(audited[0]).includes('v_new'), JSON.stringify(audited));

  console.log('\n\x1b[1m5) a rotation whose key vanished before a human got to it\x1b[0m');
  clearCards();
  aos.secrets.set('testco', 'GONE_KEY', 'x', { principal: '*' });
  tm.requestSecret(SID, 'pay-bot', 'GONE_KEY', 'dead', { rotate: true });
  aos.secrets.delete('testco', 'GONE_KEY', '*');
  const vanished = await fulfill(cards().find((c) => c.status === 'open').id, { value: 'y' });
  check('fulfilling it 404s rather than resurrecting the key', vanished.status === 404, String(vanished.status));

  // ── 6) secret_put over an existing key is announced as a replacement ────────────────────────────
  console.log('\n\x1b[1m6) secret_put over a live key reads as REPLACE on the approval card\x1b[0m');
  const put = tm.putSecret(SID, 'pay-bot', 'STRIPE_KEY', 'sk_live_new', 'rotating the stripe key');
  await new Promise((r) => setTimeout(r, 50));
  const appr = aos.db.prepare("SELECT title, body, args, approval_id FROM messages WHERE type='approval' ORDER BY created_at DESC").all()
    .map((r) => ({ ...r, args: JSON.parse(r.args || '{}') }))[0];
  let replacedFlag, storedStatus;
  if (appr) {
    check('the approver is told this REPLACES a live secret', /REPLACE/.test(appr.title), appr.title);
    check('...with the prior setter in the body', /last set/.test(appr.body || ''), appr.body);
    check('...and `replaced` is in the gated args, so policy can rule on it', appr.args.replaced === true);
    aos.approvals.resolve(appr.approval_id, true, owner.email);
  } else {
    check('the approver is told this REPLACES a live secret', false, 'no approval card was posted');
  }
  const putRes = await put;
  storedStatus = putRes.status; replacedFlag = putRes.replaced;
  check('the put lands', storedStatus === 'stored', JSON.stringify(putRes));
  check('...reported back to the agent as a replacement', replacedFlag === true);
  check('...and the vault holds the new value', aos.secrets.getSync('testco', 'pay-bot', 'STRIPE_KEY') === 'sk_live_new');
  const putAudit = aos.db.prepare("SELECT data FROM audit_events WHERE type='secret.put'").all().map((r) => JSON.parse(r.data));
  check('the audit records the replacement without the value', putAudit.some((a) => a.replaced === true) && !JSON.stringify(putAudit).includes('sk_live_new'));

  // A first-time put must NOT read as a replacement.
  const fresh = tm.putSecret(SID, 'pay-bot', 'BRAND_NEW_KEY', 'v1', 'first store');
  await new Promise((r) => setTimeout(r, 50));
  const freshCard = aos.db.prepare("SELECT title, approval_id FROM messages WHERE type='approval' ORDER BY created_at DESC").all()[0];
  if (freshCard && /BRAND_NEW_KEY/.test(freshCard.title)) {
    check('a first-time put still reads as a plain store', !/REPLACE/.test(freshCard.title), freshCard.title);
    aos.approvals.resolve(freshCard.approval_id, true, owner.email);
  }
  const freshRes = await fresh;
  check('...and reports replaced=false', freshRes.status === 'stored' && freshRes.replaced === false, JSON.stringify(freshRes));

  server.close();
  registry.stopAll();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
