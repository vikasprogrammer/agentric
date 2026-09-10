#!/usr/bin/env node
/*
 * Multi-org GitHub bot conformance test — docs/github-multi-org-plan.md, phases 1 + 2.
 *
 * The defect this pins: `ensureBotToken` used to persist ONE `github_installation_id` and, when unset,
 * resolve it as `installations[0]` — whichever install GitHub returned first — caching one token under
 * one vault key. With the App on two orgs the bot acted on one of them and 404'd every repo in the
 * other, with nothing failing at launch (the token is valid, it just doesn't cover that repo).
 *
 * Covers, fully isolated (scratch AGENT_OS_HOME; a stubbed global.fetch so no network and no live DB
 * pollution — see the CLAUDE.md warning):
 *   1. The registry: both installations recorded, org lookup (case-insensitive), primary settled.
 *   2. Per-installation token cache: distinct vault keys, no cross-org bleed, no needless re-mints.
 *   3. Legacy migration: a pre-multi-org `github_bot_token` lands on the primary's suffixed key.
 *   4. An org the App is NOT installed on yields nothing (never another org's token).
 *   5. Launch: the PRIMARY token is what gets injected, plus AOS_GH_ORG / AOS_GH_ORGS.
 *   6. Reinstall churn: a vanished primary is replaced; a surviving primary is left alone.
 *   7. Clearing the private key drops EVERY cached token, not just the primary's.
 *   8. Phase 3 — the per-repo git credential helper: its shape, and REAL `git credential fill` runs
 *      against the real loopback route (primary org costs no round trip; a second org gets its own
 *      token; an uninstalled org and a member-identity run both fall back to $GH_TOKEN).
 *
 * Usage:  npm run build && node scripts/github-multi-org-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ghmo-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1'; // a TenantRegistry spawns a ttyd per tenant; don't leak one (CLAUDE.md)
delete process.env.AGENT_OS_SECRET_KEY; // keep the vault master key inside the scratch home

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m${d ? `\n      ${d}` : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

// ── Stub the App-level GitHub surface. `installs` is what GET /app/installations answers with, so a
//    test can simulate an install, an uninstall, or a reinstall by reassigning it. Each mint records
//    which installation it was for, which is the whole point of the exercise. ────────────────────
let installs = [
  { id: 555, account: { login: 'Northwind' }, repository_selection: 'all' },
  { id: 777, account: { login: 'Globex' }, repository_selection: 'selected' },
];
let mints = []; // [{ installationId }] in order
let listCount = 0;
const realFetch = global.fetch.bind(global);
global.fetch = async (urlIn, opts = {}) => {
  const url = String(urlIn);
  const json = (obj, status = 200) => ({ ok: status < 400, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } });
  if (url === 'https://api.github.com/app') return json({ slug: 'agent-os-northwind', name: 'Agentric', html_url: 'https://github.com/apps/agent-os-northwind' });
  if (url === 'https://api.github.com/app/installations') { listCount++; return json(installs); }
  const m = url.match(/\/app\/installations\/(\d+)\/access_tokens$/);
  if (m) {
    if (!installs.some((i) => String(i.id) === m[1])) return json({ message: 'Not Found' }, 404);
    mints.push({ installationId: m[1] });
    return json({ token: `ghs_${m[1]}_${mints.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  return realFetch(urlIn, opts);
};

async function main() {
  const { execFile } = require('child_process');
  const { GithubIdentity } = require(path.join(ROOT, 'dist/edge/github-identity.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const { generateKeyPairSync } = require('crypto');

  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const osx = registry.get('testco').os;
  const tm = new TerminalManager(osx, 'http://127.0.0.1:1', path.join(HOME, 'tmux.sock'));
  const vault = (key) => osx.secrets.getSync('testco', '*', key);

  const gid = new GithubIdentity(osx);
  const { privateKey: pem } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  gid.setAppId('4286232', 'owner@test');
  gid.setPrivateKey(pem, 'owner@test');

  // ─── 1) The installation registry ───────────────────────────────────────────
  console.log('\n\x1b[1m1) The installation registry\x1b[0m');
  const list = await gid.refreshInstallations('owner@test');
  assert(list.length === 2, 'both installations recorded (not just the first)');
  assert(gid.orgs().join(',') === 'Northwind,Globex', 'orgs() names every account the App is installed on');
  assert(osx.settings.githubInstallationId() === '555', 'primary settled on the first installation (the old behaviour, now explicit)');
  assert(gid.primaryInstallation().account === 'Northwind', 'primaryInstallation() resolves the record');
  assert(gid.installationFor('globex').id === 777, 'installationFor() is case-insensitive on the account login');
  assert(gid.installationFor('  Globex ').id === 777, 'installationFor() trims');
  assert(gid.installationFor('hooli') === undefined, 'an org the App is not installed on resolves to nothing');
  assert(osx.settings.githubInstallations().length === 2, 'the registry survives a re-read from the settings row');

  // ─── 2) A token cache per installation ──────────────────────────────────────
  console.log('\n\x1b[1m2) A token cache per installation\x1b[0m');
  mints = [];
  const primary = await gid.ensureBotToken();
  assert(mints.length === 1 && mints[0].installationId === '555', 'the default mint targets the PRIMARY installation');
  const globex = await gid.ensureBotToken(Date.now(), 'owner@test', 'Globex');
  assert(mints.length === 2 && mints[1].installationId === '777', 'a named org mints against ITS OWN installation');
  assert(primary.token !== globex.token, 'the two orgs hold different tokens');
  assert(vault('github_bot_token:555') && vault('github_bot_token:777'), 'each installation caches under its own vault key');
  assert(gid.loadBotToken().token === primary.token, 'loadBotToken() with no org reads the primary');
  assert(gid.loadBotToken('Globex').token === globex.token, 'loadBotToken(org) reads that org — no cross-org bleed');
  const again = await gid.ensureBotToken(Date.now(), 'owner@test', 'Globex');
  assert(mints.length === 2 && again.token === globex.token, 'a fresh cached org token is reused (no re-mint)');

  // ─── 3) An org with no installation ─────────────────────────────────────────
  console.log('\n\x1b[1m3) An org the App is not installed on\x1b[0m');
  const before = mints.length;
  const hooli = await gid.ensureBotToken(Date.now(), 'owner@test', 'Hooli');
  assert(hooli === undefined, 'no token for an org with no installation');
  assert(mints.length === before, 'and nothing was minted — never silently another org’s token');
  assert(gid.loadBotToken('Hooli') === undefined, 'loadBotToken() for an uninstalled org is empty, not the primary');

  // ─── 4) Legacy single-org cache migrates onto the primary ───────────────────
  console.log('\n\x1b[1m4) Legacy cache migration\x1b[0m');
  const legacy = JSON.stringify({ token: 'ghs_legacy', expiresAt: Date.now() + 3600_000 });
  osx.secrets.delete('testco', 'github_bot_token:555', '*');
  osx.secrets.set('testco', 'github_bot_token', legacy, { principal: '*' });
  const migrated = gid.loadBotToken();
  assert(migrated && migrated.token === 'ghs_legacy', 'a pre-multi-org token is still readable after the upgrade');
  assert(vault('github_bot_token:555') !== undefined && vault('github_bot_token') === undefined, 'it moves onto the primary’s suffixed key and the legacy slot is cleared');
  assert(gid.loadBotToken('Globex').token === globex.token, 'migration does not disturb another org’s cache');

  // ─── 5) Launch injection ────────────────────────────────────────────────────
  console.log('\n\x1b[1m5) Launch injection\x1b[0m');
  const env = {};
  tm.injectGithubBaseline(env, 'coder', 'sessMO');
  assert(env.GH_TOKEN === 'ghs_legacy' && env.GITHUB_TOKEN === env.GH_TOKEN, 'the PRIMARY org’s token is what a session gets');
  assert(env.AOS_GH_ORG === 'Northwind', 'AOS_GH_ORG names the org that token actually covers');
  assert(env.AOS_GH_ORGS === 'Northwind,Globex', 'AOS_GH_ORGS names the full reach, so the gap is legible');
  const md = tm.buildCompanyMd('coder');
  assert(/several GitHub orgs/.test(md) && /Northwind/.test(md) && /Globex/.test(md), 'the prompt warns that a second org exists');
  assert(/scoped to \*\*Northwind\*\* only/.test(md), 'and names which org the injected credential covers');

  // ─── 6) Reinstall churn ─────────────────────────────────────────────────────
  console.log('\n\x1b[1m6) Reinstall churn\x1b[0m');
  listCount = 0;
  await gid.refreshInstallations('owner@test');
  assert(osx.settings.githubInstallationId() === '555' && listCount === 1, 'a primary that still exists is left alone on refresh');
  installs = [{ id: 777, account: { login: 'Globex' }, repository_selection: 'selected' }]; // Northwind uninstalled
  await gid.refreshInstallations('owner@test');
  assert(osx.settings.githubInstallationId() === '777', 'a primary that has vanished is replaced by a surviving installation');
  assert(gid.orgs().join(',') === 'Globex', 'the uninstalled org leaves the registry');
  installs = [
    { id: 555, account: { login: 'Northwind' }, repository_selection: 'all' },
    { id: 777, account: { login: 'Globex' }, repository_selection: 'selected' },
  ];
  await gid.refreshInstallations('owner@test');
  assert(osx.settings.githubInstallationId() === '777', 'a reinstall does not silently move the primary back');

  // ─── 7) Clearing the private key ────────────────────────────────────────────
  console.log('\n\x1b[1m7) Clearing the private key detaches every org\x1b[0m');
  await gid.ensureBotToken(Date.now(), 'owner@test', 'Northwind');
  assert(vault('github_bot_token:555') && vault('github_bot_token:777'), 'both orgs cached before the clear');
  gid.setPrivateKey('', 'owner@test');
  assert(vault('github_bot_token:555') === undefined && vault('github_bot_token:777') === undefined, 'EVERY installation’s token is dropped, not just the primary’s');
  assert(gid.installations().length === 0 && osx.settings.githubInstallationId() === '', 'the registry and the primary are cleared too');
  assert(gid.loadBotToken() === undefined, 'nothing is readable afterwards');

  // ─── 8) Phase 3 — the per-repo git credential helper ────────────────────────
  console.log('\n\x1b[1m8) Per-repo git credentials (phase 3)\x1b[0m');
  // Re-arm the bot (§7 cleared it) and boot the real HTTP server so `git` talks to the real route.
  gid.setPrivateKey(pem, 'owner@test');
  await gid.refreshInstallations('owner@test');
  await gid.ensureBotToken(Date.now(), 'owner@test');                       // Northwind = primary
  await gid.ensureBotToken(Date.now(), 'owner@test', 'Globex');
  const primaryTok = gid.loadBotToken().token;
  const globexTok = gid.loadBotToken('Globex').token;

  const single = { GH_TOKEN: 'ghs_x' };
  tm.configureGitCredentials(single);
  assert(single.GIT_CONFIG_COUNT === '2' && single.GIT_CONFIG_KEY_2 === undefined, 'single-org tenants keep the plain two-entry helper');
  assert(!/AOS_GH_ORG/.test(single.GIT_CONFIG_VALUE_1), 'and its helper never reaches for an org');
  const multi = { GH_TOKEN: 'ghs_x' };
  tm.configureGitCredentials(multi, { multiOrg: true });
  assert(multi.GIT_CONFIG_COUNT === '3', 'multi-org adds a third config entry');
  assert(multi.GIT_CONFIG_KEY_2 === 'credential.https://github.com.useHttpPath' && multi.GIT_CONFIG_VALUE_2 === 'true',
    'useHttpPath is on — without it git never tells the helper which repo it is authenticating for');
  assert(/AOS_GH_ORG/.test(multi.GIT_CONFIG_VALUE_1) && /github\/credential/.test(multi.GIT_CONFIG_VALUE_1), 'the helper resolves the org against the loopback route');

  // The real thing: boot the server, register a session, and let git drive the helper. `execFile`
  // (async) rather than execFileSync — a sync child would block this process's event loop and the
  // in-process server could never accept the helper's request.
  const registryServer = createHttpServer(registry);
  await new Promise((r) => registryServer.listen(0, r));
  const port = registryServer.address().port;
  const now = Date.now();
  osx.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, secret, run_as, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sessGit', 'coder', 't', '', 'sessGit', 'running', 'sekret', null, now, now);
  const helperEnv = {
    ...process.env, ...multi, GH_TOKEN: primaryTok,
    AOS_URL: `http://127.0.0.1:${port}`, AOS_SECRET: 'sekret', AOS_TENANT: 'testco', SESSION: 'sessGit', AOS_GH_ORG: 'Northwind',
  };
  const ask = (repoPath, env = helperEnv) => new Promise((resolve) => {
    const child = execFile('git', ['credential', 'fill'], { env }, (err, stdout) => resolve(err ? '' : (String(stdout).match(/password=(.*)/) || [])[1] || ''));
    child.stdin.end(`protocol=https\nhost=github.com\npath=${repoPath}\n\n`);
  });
  mints = [];
  assert((await ask('Northwind/api.git')) === primaryTok, 'a repo in the PRIMARY org authenticates with the ambient token');
  assert(mints.length === 0, 'and costs no round trip — the common case is untouched');
  assert((await ask('Globex/site.git')) === globexTok, 'a repo in ANOTHER org gets that org’s own token — the whole point');
  assert((await ask('Hooli/x.git')) === primaryTok, 'an org the App is not installed on falls back to $GH_TOKEN rather than breaking git');
  const noRoute = { ...helperEnv, AOS_URL: 'http://127.0.0.1:1' };
  assert((await ask('Globex/site.git', noRoute)) === primaryTok, 'an unreachable route degrades to the pre-multi-org behaviour, never a broken git');

  // The member guard: a run whose run-as human has linked GitHub must NEVER be handed a bot token,
  // or their commits get re-authored as the App bot the moment they touch a second org.
  const teamMember = osx.team.acceptToken(osx.team.invite({ email: 'dev@test', role: 'admin' }).token).member.id;
  gid.save(teamMember, { token: 'gho_member', login: 'octocat', connectedAt: Date.now() });
  osx.db.prepare('UPDATE term_sessions SET run_as = ? WHERE id = ?').run(teamMember, 'sessGit');
  const asMember = await (await fetch(`http://127.0.0.1:${port}/api/agent/github/credential`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': 'sekret', 'x-aos-tenant': 'testco' },
    body: JSON.stringify({ session: 'sessGit', org: 'Globex' }),
  })).json();
  assert(asMember.status === 'member_identity' && !asMember.token, 'a run with a linked member identity is refused a bot token (authorship stays theirs)');
  assert((await ask('Globex/site.git')) === primaryTok, 'and the helper falls back rather than substituting the bot');
  osx.db.prepare('UPDATE term_sessions SET run_as = NULL WHERE id = ?').run('sessGit');

  const post = (body, headers = { 'x-aos-secret': 'sekret' }) => fetch(`http://127.0.0.1:${port}/api/agent/github/credential`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-tenant': 'testco', ...headers }, body: JSON.stringify(body),
  });
  assert((await post({ session: 'nope', org: 'Globex' })).status === 404, 'an unknown session is rejected');
  assert((await post({ session: 'sessGit', org: 'Globex' }, { 'x-aos-secret': 'wrong' })).status === 403, 'a bad session secret is rejected');
  assert((await (await post({ session: 'sessGit', org: '' })).json()).status === 'no_org', 'a missing org is a typed answer, not a token');
  assert((await (await post({ session: 'sessGit', org: 'Hooli' })).json()).status === 'not_installed', 'an uninstalled org is named as such');
  registryServer.close();

  try { registry.stopAll && registry.stopAll(); } catch { /* */ }
  try { tm.shutdown && tm.shutdown(); } catch { /* */ }
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}MULTI-ORG GITHUB: ${pass}/${pass + fail} passed\x1b[0m\n`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
