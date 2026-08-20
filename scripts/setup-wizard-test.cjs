#!/usr/bin/env node
/* Setup-wizard test — the checklist must be DERIVED, never remembered.
 *
 * The failure mode this pins is the one every onboarding checklist grows: a step that stores "done" of
 * its own and then disagrees with the setting it claims to describe (configured elsewhere → still nags;
 * key later removed → still shows a tick). So every assertion here changes a setting through the store
 * that owns it and expects the wizard to notice with no wizard-side write at all.
 *
 * Also pinned: skip is a decision, not a completion (the step keeps reporting its real status while
 * stopping the nag), the routes are admin-gated, and the credential check never claims "not configured"
 * on a box that plainly is. Isolated home; no tmux, no ttyd, no network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-setup-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.ANTHROPIC_API_KEY;
// Point the box-credential probe at an empty dir and stub the Keychain lookup, so the test reads the same
// on a maintainer's Mac (which IS signed in) as in CI (which isn't) — otherwise the "no credential"
// branch is unassertable here and only ever runs in CI.
const FAKE_CLAUDE = path.join(HOME, 'box-claude');
fs.mkdirSync(FAKE_CLAUDE, { recursive: true });
const PROBES = { configDir: FAKE_CLAUDE, keychain: () => false };

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { buildSetupStatus, skipSetupStep, dismissSetup, claudeAuthEvidence, SETUP_STEP_IDS } = require(path.join(ROOT, 'dist/edge/setup.js'));

const registry = new TenantRegistry(ROOT, 0);
registry.bootAll();
const { os: aos } = registry.get('testco');

const mkMember = (email, role) => {
  const { member } = aos.team.invite({ email, role });
  aos.db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
  return aos.team.getMember(member.id);
};
// The seeded owner IS the one-member fresh install — inviting another would silently satisfy the team
// step before the first assertion runs.
const owner = aos.team.listMembers().find((m) => m.role === 'owner');

const status = (ownAgents = 0) => buildSetupStatus(aos, { ownAgents, guidedLogin: { ok: true }, probes: PROBES });
const step = (id, ownAgents = 0) => status(ownAgents).steps.find((s) => s.id === id);

console.log('\n\x1b[1m1) A fresh install reports honest work left\x1b[0m');
const fresh = status();
assert(fresh.steps.length === SETUP_STEP_IDS.length, 'every declared step is present');
assert(fresh.steps.map((s) => s.id).join(',') === SETUP_STEP_IDS.join(','), 'steps keep their declared order (credentials → context → reach)');
assert(!fresh.complete && fresh.done === 0, 'nothing is done yet');
assert(fresh.blocking === fresh.steps.filter((s) => s.required).length, 'every required step blocks while untouched');
assert(fresh.dismissedAt === null, 'the wizard has not been dismissed');
assert(fresh.steps.every((s) => !!s.why && !!s.detail), 'each step says why it matters and what it found');

console.log('\n\x1b[1m2) A step is derived from the store that owns it — not from wizard state\x1b[0m');
aos.settings.setCompany('# About us\nWe make widgets.', owner.email);
assert(step('company').status === 'done', 'writing the company doc through SettingsStore completes the step');
aos.settings.setCompany('   ', owner.email);
assert(step('company').status === 'todo', 'clearing it re-opens the step (no sticky "done")');
aos.settings.setCompany('# About us\nWe make widgets.', owner.email);

aos.settings.setComposioApiKey('ak_live_test', owner.email);
assert(step('composio').status === 'done', 'a Composio key set anywhere completes the step');
assert(!JSON.stringify(step('composio')).includes('ak_live_test'), 'the step never echoes the secret');
aos.settings.setComposioApiKey('', owner.email);
assert(step('composio').status === 'todo', 'removing the key re-opens it');

aos.settings.setDiscordBotToken('Bot abc.def', owner.email);
assert(step('chat').status === 'done' && step('chat').detail.includes('Discord'), 'any one chat channel satisfies the chat step and is named');
aos.settings.setDiscordBotToken('', owner.email);

assert(step('team').status === 'todo', 'a one-person install has the team step open');
const plain = mkMember('mem@testco.dev', 'member');
assert(step('team').status === 'done', 'inviting a teammate completes it');
assert(step('agents', 0).status === 'todo' && step('agents', 2).status === 'done', 'the agents step follows the non-builtin fleet count');

console.log('\n\x1b[1m3) Credentials: no false "not configured" on a box that has one\x1b[0m');
assert(claudeAuthEvidence(aos, PROBES).status === 'todo', 'an empty box config dir with no pool and no key reports todo');
const credDir = path.join(HOME, 'cred-a');
fs.mkdirSync(credDir, { recursive: true });
fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }));
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'main', kind: 'oauth', configDir: credDir });
assert(claudeAuthEvidence(aos, PROBES).status === 'done', 'an enabled credential-dir account in the pool is a credential');
assert(claudeAuthEvidence(aos, PROBES).detail.includes('main'), 'the evidence names the account, so a wrong pool is visible');
aos.runtimeAccounts.setEnabled('claude-code', 'main', false);
assert(claudeAuthEvidence(aos, PROBES).status === 'todo', 'a DISABLED account is not a credential (it is never selected)');
aos.runtimeAccounts.setEnabled('claude-code', 'main', true);
// A token-kind row can't launch claude's interactive TUI — counting it would recreate the exact bug the
// runtime-account pool test pins (a console showing healthy rotation while runs use the box login).
aos.runtimeAccounts.remove('claude-code', 'main');
aos.secrets.set(aos.tenant, 'runtime-token:claude-code:tok', 'sk-ant-oat01-y', { principal: '*' });
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'tok', kind: 'token', apiKeyRef: 'runtime-token:claude-code:tok' });
assert(claudeAuthEvidence(aos, PROBES).status === 'todo', 'a token-kind account does not count — the TUI cannot launch with it');
aos.runtimeAccounts.remove('claude-code', 'tok');
fs.writeFileSync(path.join(FAKE_CLAUDE, '.credentials.json'), '{}');
assert(claudeAuthEvidence(aos, PROBES).status === 'done', "the box's own login counts (an empty pool means sessions use it)");
fs.rmSync(path.join(FAKE_CLAUDE, '.credentials.json'));

console.log('\n\x1b[1m4) Skip is a decision, not a completion\x1b[0m');
skipSetupStep(aos, 'chat', true, owner.email);
const skipped = status();
const chat = skipped.steps.find((s) => s.id === 'chat');
assert(chat.skipped && chat.status === 'todo', 'a skipped step still reports its REAL status');
assert(skipped.done === status().steps.filter((s) => s.status === 'done').length, 'skipping does not inflate the done count');
skipSetupStep(aos, 'chat', false, owner.email);
assert(!step('chat').skipped, 'un-skip restores it');
assert(!status(0).complete, 'an install with required work left is not complete');

console.log('\n\x1b[1m5) Completion + dismissal are separate facts\x1b[0m');
for (const id of ['composio', 'chat', 'team']) skipSetupStep(aos, id, true, owner.email);
fs.writeFileSync(path.join(FAKE_CLAUDE, '.credentials.json'), '{}');
assert(status(1).complete, 'every step done or skipped = complete');
dismissSetup(aos, true, owner.email);
assert(typeof status(0).dismissedAt === 'number', 'dismissal is recorded');
assert(!status(0).complete, 'dismissing does NOT fake completion — the banner hides, the truth does not change');
dismissSetup(aos, false, owner.email);
assert(status(0).dismissedAt === null, 'setup can be re-opened');

console.log('\n\x1b[1mHTTP: gating + round trip\x1b[0m');
(async () => {
  const srv = createHttpServer(registry);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const ownerCookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const memberCookie = `aos_sid=${aos.team.createSession(plain.id)}`;
  const req = async (method, p, cookie, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const asOwner = await req('GET', '/api/setup', ownerCookie);
  assert(asOwner.status === 200 && Array.isArray(asOwner.body.steps), 'owner reads the checklist');
  assert((await req('GET', '/api/setup', memberCookie)).status === 403, 'a member cannot read it (they can fix none of it)');
  assert((await req('POST', '/api/setup/skip', memberCookie, { step: 'chat', skip: true })).status === 403, 'a member cannot skip a step');
  assert((await req('GET', '/api/setup', '')).status === 401, 'unauthenticated is refused');

  const bad = await req('POST', '/api/setup/skip', ownerCookie, { step: 'not-a-step', skip: true });
  assert(bad.status === 400, 'an unknown step id is rejected, not silently stored');

  const skipRes = await req('POST', '/api/setup/skip', ownerCookie, { step: 'composio', skip: true });
  assert(skipRes.status === 200 && skipRes.body.steps.find((s) => s.id === 'composio').skipped, 'skip returns the recomputed status (one round trip)');
  const unskip = await req('POST', '/api/setup/skip', ownerCookie, { step: 'composio', skip: false });
  assert(!unskip.body.steps.find((s) => s.id === 'composio').skipped, 'un-skip round trips');

  const dis = await req('POST', '/api/setup/dismiss', ownerCookie, { dismissed: true });
  assert(typeof dis.body.dismissedAt === 'number', 'dismiss round trips');
  await req('POST', '/api/setup/dismiss', ownerCookie, { dismissed: false });

  // The wizard writes settings through the endpoints that already own them; prove one end to end.
  await req('PUT', '/api/settings/company', ownerCookie, { companyMd: '# About us\nrewritten by the wizard' });
  const after = await req('GET', '/api/setup', ownerCookie);
  assert(after.body.steps.find((s) => s.id === 'company').status === 'done', 'saving through the OWNING endpoint completes the step');

  srv.close();
  registry.stopAll();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 1 && 0 : 1);
})();
