#!/usr/bin/env node
/*
 * Per-member GitHub (run-as git) conformance test — docs/per-member-github-plan.md.
 *
 * Covers, fully isolated (scratch AGENT_OS_HOME; a stubbed global.fetch for every GitHub call, so no
 * network + no live DB pollution — see the CLAUDE.md warning):
 *   1. OAuth primitives (connectors/github): authorizeUrl params; code exchange + refresh parsing; GET /user.
 *   2. GithubIdentity store: client-secret vault round-trip, configured(), blob save/load/clear,
 *      needsRefresh, and ensureFresh() actually refreshing + persisting an expiring token.
 *   3. Launch injection precedence: a run-as member's token OVERRIDES a pre-set agent bot GH_TOKEN;
 *      no run-as / unlinked member leaves the bot token untouched.
 *   4. The HTTP flow end-to-end: PUT creds → /connect (state) → /callback (stubbed exchange) → /me →
 *      identity recorded → CSRF-bad state rejected → /disconnect clears everything.
 *
 * Usage:  npm run build && node scripts/github-per-member-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ghpm-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY; // keep the vault master key inside the scratch home

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m${d ? `\n      ${d}` : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

// ── Stub GitHub's HTTP surface. Everything else falls through to a 404 so an unrelated background
//    fetch can't crash the run (there shouldn't be any during these routes). ──────────────────────
let refreshCount = 0;
let botMintCount = 0;
let installState = 'installed'; // 'installed' | 'none' — toggles the /user/installations stub
const realFetch = global.fetch.bind(global); // the test drives the local server over REAL http
global.fetch = async (urlIn, opts = {}) => {
  const url = String(urlIn);
  const body = opts.body ? JSON.parse(opts.body) : {};
  const json = (obj, status = 200) => ({ ok: status < 400, status, async json() { return obj; }, async text() { return JSON.stringify(obj); } });
  if (url === 'https://github.com/login/oauth/access_token') {
    if (body.grant_type === 'refresh_token') {
      refreshCount++;
      return json({ access_token: 'gho_refreshed_' + refreshCount, refresh_token: 'ghr_new', expires_in: 28800, token_type: 'bearer' });
    }
    return json({ access_token: 'gho_access_1', refresh_token: 'ghr_1', expires_in: 28800, token_type: 'bearer', scope: 'repo' });
  }
  if (url === 'https://api.github.com/user') return json({ login: 'octocat', id: 583231 });
  // App-installation status — `installState` lets a test toggle installed vs authorized-but-not-installed.
  if (/\/user\/installations\?/.test(url)) {
    return json(installState === 'none'
      ? { installations: [] }
      : { installations: [{ id: 77, account: { login: 'Globex' }, app_slug: 'x' }] });
  }
  if (/\/user\/installations\/\d+\/repositories/.test(url)) return json({ total_count: 5, repositories: [] });
  // Company-bot minter: list App installations, then mint an installation (bot) token.
  if (url === 'https://api.github.com/app') return json({ slug: 'agent-os-northwind', name: 'Agent OS', html_url: 'https://github.com/apps/agent-os-northwind' });
  if (url === 'https://api.github.com/app/installations') return json([{ id: 555, account: { login: 'Globex' }, repository_selection: 'all' }]);
  if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
    botMintCount++;
    return json({ token: 'ghs_bot_' + botMintCount, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }
  if (/\/app-manifests\/[^/]+\/conversions$/.test(url)) {
    return json({ id: 42, slug: 'agent-os-northwind', client_id: 'Iv1.manifest', client_secret: 'manifest-secret', html_url: 'https://github.com/apps/agent-os-northwind', webhook_secret: 'whsec_x', pem: '-----BEGIN-----' });
  }
  // Everything else (the test's own calls to the local server) → the real network stack.
  return realFetch(urlIn, opts);
};

async function main() {
  const gh = require(path.join(ROOT, 'dist/connectors/github.js'));
  const { GithubIdentity } = require(path.join(ROOT, 'dist/edge/github-identity.js'));
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

  // ─── 1) OAuth primitives ───────────────────────────────────────────────────
  console.log('\n\x1b[1m1) OAuth primitives (connectors/github)\x1b[0m');
  const authUrl = gh.authorizeUrl({ clientId: 'Iv1.abc', redirectUri: 'https://h/api/github/callback', state: 'st8' });
  assert(authUrl.startsWith('https://github.com/login/oauth/authorize?'), 'authorizeUrl points at GitHub authorize');
  assert(authUrl.includes('client_id=Iv1.abc') && authUrl.includes('state=st8') && authUrl.includes('scope=repo'), 'authorizeUrl carries client_id + state + scope');
  assert(authUrl.includes('redirect_uri=https%3A%2F%2Fh%2Fapi%2Fgithub%2Fcallback'), 'authorizeUrl url-encodes the redirect_uri');

  const now = 1_000_000_000_000;
  const exch = await gh.exchangeUserCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' }, now);
  assert(exch.token === 'gho_access_1' && exch.refreshToken === 'ghr_1', 'exchangeUserCode returns access + refresh token');
  assert(exch.expiresAt === now + 28800 * 1000, 'exchangeUserCode computes expiresAt from expires_in');
  const who = await gh.githubUser('gho_access_1');
  assert(who.login === 'octocat' && who.id === 583231, 'githubUser returns login + id');
  const refreshed = await gh.refreshUserToken({ clientId: 'c', clientSecret: 's', refreshToken: 'ghr_1' }, now);
  assert(refreshed.token.startsWith('gho_refreshed_'), 'refreshUserToken returns a new access token');

  // ─── boot one tenant runtime + HTTP server on an ephemeral port ──────────────
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const rt = registry.get('testco');
  const osx = rt.os;
  const server = createHttpServer(registry);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  // Mint an owner session (cookie) directly through the team store.
  const inv = osx.team.invite({ email: 'owner@test', role: 'owner' });
  const acc = osx.team.acceptToken(inv.token);
  const ownerId = acc.member.id;
  const cookie = `aos_sid=${acc.sid}`;
  const base = `http://127.0.0.1:${port}`;
  const call = (m, p, b, extra = {}) => fetch(base + p, {
    method: m, redirect: 'manual',
    headers: { cookie, 'content-type': 'application/json', ...extra },
    body: b ? JSON.stringify(b) : undefined,
  });

  // ─── 2) GithubIdentity store + refresh ──────────────────────────────────────
  console.log('\n\x1b[1m2) GithubIdentity (vault store + refresh)\x1b[0m');
  const gid = new GithubIdentity(osx);
  osx.settings.setGithubClientId('Iv1.client', 'owner@test');
  gid.setClientSecret('shh-secret', 'owner@test');
  assert(gid.clientId() === 'Iv1.client' && gid.clientSecret() === 'shh-secret', 'client id (setting) + secret (vault) round-trip');
  assert(gid.configured() === true, 'configured() true once id + secret set');
  assert(osx.secrets.getSync('testco', '*', 'github_client_secret') === 'shh-secret', 'client secret sits in the vault under *');

  gid.save(ownerId, { token: 'gho_x', refreshToken: 'ghr_x', expiresAt: now + 28800000, login: 'octocat', connectedAt: now });
  const blob = gid.load(ownerId);
  assert(blob && blob.token === 'gho_x' && blob.login === 'octocat', 'save/load round-trips a token blob');
  assert(osx.secrets.getSync('testco', '*', 'github_user') === undefined, 'member blob is NOT in the shared * scope (agent isolation)');
  assert(gid.needsRefresh({ token: 't' }) === false, 'needsRefresh false for a non-expiring token');
  assert(gid.needsRefresh({ token: 't', expiresAt: Date.now() + 60_000 }) === true, 'needsRefresh true when near expiry');

  // Expiring token → ensureFresh refreshes + persists.
  refreshCount = 0;
  gid.save(ownerId, { token: 'gho_old', refreshToken: 'ghr_old', expiresAt: Date.now() - 1000, login: 'octocat', connectedAt: now });
  const fresh = await gid.ensureFresh(ownerId);
  assert(refreshCount === 1 && fresh.token.startsWith('gho_refreshed_'), 'ensureFresh refreshes an expired token');
  assert(gid.load(ownerId).token === fresh.token, 'ensureFresh persists the refreshed token');
  gid.clear(ownerId);
  assert(gid.load(ownerId) === undefined, 'clear() removes the blob');

  // ─── 3) Injection precedence (TerminalManager private method, reachable from JS) ──
  console.log('\n\x1b[1m3) Launch injection precedence\x1b[0m');
  const tm = new TerminalManager(osx, base, path.join(HOME, 'tmux.sock'));
  gid.save(ownerId, { token: 'gho_member', login: 'octocat', connectedAt: now });
  const env1 = { GH_TOKEN: 'gho_BOT' }; // pretend injectShellSecrets already set the bot token
  tm.injectMemberGithub(env1, 'coder', ownerId, 'sess1');
  assert(env1.GH_TOKEN === 'gho_member' && env1.GITHUB_TOKEN === 'gho_member', 'member token OVERRIDES the agent bot GH_TOKEN');
  const env2 = { GH_TOKEN: 'gho_BOT' };
  tm.injectMemberGithub(env2, 'coder', undefined, 'sess2'); // no run-as
  assert(env2.GH_TOKEN === 'gho_BOT' && env2.GITHUB_TOKEN === undefined, 'no run-as → bot token untouched');
  const env3 = { GH_TOKEN: 'gho_BOT' };
  tm.injectMemberGithub(env3, 'coder', 'nobody-else', 'sess3'); // unlinked member
  assert(env3.GH_TOKEN === 'gho_BOT', 'unlinked run-as member → bot token untouched');
  gid.clear(ownerId);

  // ─── 4) HTTP flow: creds → connect → callback → me → disconnect ──────────────
  console.log('\n\x1b[1m4) HTTP flow (connect → callback → me → disconnect)\x1b[0m');
  // Clear creds via the API then re-set through the integrations PUT, exercising that path too.
  gid.setClientSecret('', 'owner@test');
  osx.settings.setGithubClientId('', 'owner@test');
  let r = await call('PUT', '/api/settings/integrations', { githubClientId: 'Iv1.web', githubClientSecret: 'web-secret' });
  let view = await r.json();
  assert(r.status === 200 && view.github && view.github.configured === true, 'PUT integrations sets + reports github.configured');

  r = await call('GET', '/api/github/me');
  let me = await r.json();
  assert(me.configured === true && me.connected === false, '/me: configured, not yet connected');

  r = await call('GET', '/api/github/connect');
  const conn = await r.json();
  assert(r.status === 200 && conn.redirectUrl && conn.redirectUrl.includes('client_id=Iv1.web'), '/connect returns a GitHub authorize URL');
  const state = new URL(conn.redirectUrl).searchParams.get('state');
  assert(!!state, '/connect embeds a CSRF state');

  // Bad state → rejected (CSRF guard), no connection made.
  r = await call('GET', `/api/github/callback?code=abc&state=WRONG`);
  assert(r.status === 302 && (r.headers.get('location') || '').includes('github=error'), 'callback with a bad state is rejected');
  me = await (await call('GET', '/api/github/me')).json();
  assert(me.connected === false, 'a rejected callback did not connect anything');

  // Good state → exchange (stubbed) → connected.
  r = await call('GET', `/api/github/callback?code=abc&state=${state}`);
  assert(r.status === 302 && (r.headers.get('location') || '').includes('github=connected'), 'valid callback redirects with github=connected');
  assert((r.headers.get('location') || '') === '/#/connectors?github=connected', 'default connect returns to Connections');
  // Return path: connecting from the profile page comes back to the profile (open-redirect-guarded).
  r = await call('GET', '/api/github/connect?return=' + encodeURIComponent('#/profile'));
  const st2 = new URL((await r.json()).redirectUrl).searchParams.get('state');
  r = await call('GET', `/api/github/callback?code=abc&state=${st2}`);
  assert((r.headers.get('location') || '') === '/#/profile?github=connected', 'connect with return=#/profile comes back to the profile');
  // Open-redirect guard: a hostile return is ignored, falling back to Connections.
  r = await call('GET', '/api/github/connect?return=' + encodeURIComponent('https://evil.example/x'));
  const st3 = new URL((await r.json()).redirectUrl).searchParams.get('state');
  r = await call('GET', `/api/github/callback?code=abc&state=${st3}`);
  assert((r.headers.get('location') || '').startsWith('/#/connectors'), 'a non-local return path is rejected (no open redirect)');
  me = await (await call('GET', '/api/github/me')).json();
  assert(me.connected === true && me.login === 'octocat', '/me now reports connected as octocat');
  assert(!('token' in me), '/me never leaks the token');
  // Installed case: /me reports the real installation status (installed + repo count + accounts).
  assert(me.install && me.install.installed === true && me.install.repos === 5 && me.install.accounts.includes('Globex'),
    '/me surfaces App-installation status (installed, repos, accounts)');
  // Authorized-but-not-installed: the trap. Same connected token, but no installation → installed:false.
  installState = 'none';
  const meNI = await (await call('GET', '/api/github/me')).json();
  assert(meNI.connected === true && meNI.install && meNI.install.installed === false && meNI.install.repos === 0,
    'authorized-but-not-installed → connected:true but install.installed:false (no false green)');
  installState = 'installed';

  // State is single-use: replaying it fails.
  r = await call('GET', `/api/github/callback?code=abc&state=${state}`);
  assert((r.headers.get('location') || '').includes('github=error'), 'state is single-use (replay rejected)');

  // The login was recorded as the member's github identity.
  const idents = osx.team.externalIdsFor(ownerId);
  assert(idents.some((i) => i.provider === 'github' && i.externalId === 'octocat'), 'github login recorded in member_identities');
  // And the token is stored under the member principal.
  const stored = osx.secrets.getSync('testco', ownerId, 'github_user');
  assert(stored && JSON.parse(stored).token === 'gho_access_1', 'token blob stored under the member principal');

  // Disconnect clears both the token and the identity.
  r = await call('POST', '/api/github/disconnect');
  assert((await r.json()).ok === true, '/disconnect returns ok');
  me = await (await call('GET', '/api/github/me')).json();
  assert(me.connected === false, '/me reports disconnected');
  assert(osx.secrets.getSync('testco', ownerId, 'github_user') === undefined, 'token blob removed from the vault');
  assert(!osx.team.externalIdsFor(ownerId).some((i) => i.provider === 'github'), 'github identity cleared');

  // ─── 5) One-click App-manifest setup ────────────────────────────────────────
  console.log('\n\x1b[1m5) App-manifest one-click setup\x1b[0m');
  // Clear any creds so we can prove the manifest flow sets them.
  gid.setClientSecret('', 'owner@test'); osx.settings.setGithubClientId('', 'owner@test'); osx.settings.setGithubAppSlug('', 'owner@test');
  r = await call('GET', '/api/github/manifest');
  const man = await r.json();
  assert(r.status === 200 && man.postUrl && man.postUrl.startsWith('https://github.com/settings/apps/new?state='), 'manifest returns GitHub form-POST url + state (personal)');
  const manifestObj = JSON.parse(man.manifest);
  assert(Array.isArray(manifestObj.callback_urls) && manifestObj.callback_urls[0].endsWith('/api/github/callback'), 'manifest carries our OAuth callback URL');
  assert(manifestObj.redirect_url.endsWith('/api/github/manifest-callback'), 'manifest carries the manifest-callback URL');
  assert(manifestObj.default_permissions.contents === 'write' && manifestObj.default_permissions.pull_requests === 'write', 'manifest requests least-privilege Contents + PR write');
  assert(manifestObj.hook_attributes.active === false && manifestObj.public === false, 'manifest disables webhook + keeps the App private');
  const mState = new URL(man.postUrl).searchParams.get('state');

  const rOrg = await call('GET', '/api/github/manifest?org=acme-inc');
  const manOrg = await rOrg.json();
  assert((manOrg.postUrl || '').startsWith('https://github.com/organizations/acme-inc/settings/apps/new?state='), 'org param targets the org App-create URL');

  // Bad state → rejected.
  r = await call('GET', '/api/github/manifest-callback?code=c&state=WRONG');
  assert((r.headers.get('location') || '').includes('github=error'), 'manifest-callback with a bad state is rejected');

  // Good state → conversion (stubbed) → creds saved + slug/install link surfaced.
  r = await call('GET', `/api/github/manifest-callback?code=goodcode&state=${mState}`);
  assert(r.status === 302 && (r.headers.get('location') || '').includes('github=created'), 'valid manifest-callback redirects with github=created');
  const iv = await (await call('GET', '/api/settings/integrations')).json();
  assert(iv.github.configured === true && iv.github.slug === 'agent-os-northwind', 'App creds + slug persisted from the conversion');
  assert(iv.github.installUrl === 'https://github.com/apps/agent-os-northwind/installations/new', 'install-on-repos link derived from the slug');
  assert(osx.settings.githubClientId() === 'Iv1.manifest' && gid.clientSecret() === 'manifest-secret', 'client id (setting) + secret (vault) stored');

  // A non-admin cannot create an App.
  const minv = osx.team.invite({ email: 'member@test', role: 'member' });
  const macc = osx.team.acceptToken(minv.token);
  r = await fetch(base + '/api/github/manifest', { headers: { cookie: `aos_sid=${macc.sid}` } });
  assert(r.status === 403, 'non-admin is forbidden from the manifest setup');

  // ─── 6) Launch-context git-identity steer (buildCompanyMd) ──────────────────
  console.log('\n\x1b[1m6) Launch-context git steer (unconnected member is pointed at the fix)\x1b[0m');
  osx.agents.set('coder', { id: 'coder', runtime: 'claude-code', description: 'A coding agent', dir: '/tmp/x' });
  // App configured (from section 5) but the owner hasn't linked → steer to the 1-click connect.
  gid.clear(ownerId);
  let md = tm.buildCompanyMd('coder', ownerId);
  assert(/Git identity — you are not yet acting as a person on GitHub/.test(md), 'configured + unlinked → "connect your GitHub" steer');
  assert(/Connect GitHub/.test(md) && !/Create GitHub App/.test(md), 'unlinked steer points at the 1-click member connect, not the admin setup');

  // App NOT configured → steer to ask an owner/admin to set it up.
  osx.settings.setGithubClientId('', 'owner@test'); gid.setClientSecret('', 'owner@test');
  md = tm.buildCompanyMd('coder', ownerId);
  assert(/GitHub is not set up for this workspace/.test(md) && /Create GitHub App/.test(md), 'unconfigured → "ask an owner/admin to set up the App" steer');

  // Connected member → no steer at all (their token is injected and just works).
  osx.settings.setGithubClientId('Iv1.x', 'owner@test'); gid.setClientSecret('sec', 'owner@test');
  gid.save(ownerId, { token: 'gho_live', login: 'octocat', connectedAt: Date.now() });
  md = tm.buildCompanyMd('coder', ownerId);
  assert(!/Git identity/.test(md), 'connected member → no git-identity steer');

  // No run-as identity (pure automation) → no personal steer.
  md = tm.buildCompanyMd('coder');
  assert(!/Git identity/.test(md), 'no run-as member → no git-identity steer');
  gid.clear(ownerId);

  // ─── 7) git credential helper (plain `git`, not just `gh`) ──────────────────
  console.log('\n\x1b[1m7) git credential helper (git + gh both authenticate)\x1b[0m');
  const genv = { GH_TOKEN: 'gho_abc' };
  tm.configureGitCredentials(genv);
  assert(genv.GIT_CONFIG_COUNT === '2', 'sets GIT_CONFIG_COUNT for two entries');
  assert(genv.GIT_CONFIG_KEY_0 === 'credential.https://github.com.helper' && genv.GIT_CONFIG_VALUE_0 === '', 'entry 0 resets any inherited github.com helper');
  assert(genv.GIT_CONFIG_KEY_1 === 'credential.https://github.com.helper' && /username=x-access-token/.test(genv.GIT_CONFIG_VALUE_1) && /\$GH_TOKEN/.test(genv.GIT_CONFIG_VALUE_1), 'entry 1 is a github.com helper that echoes x-access-token + $GH_TOKEN');
  const noTok = {};
  tm.configureGitCredentials(noTok);
  assert(noTok.GIT_CONFIG_COUNT === undefined, 'no GH_TOKEN → no git credential config (nothing to authenticate with)');

  // ─── 8) Company-bot installation token (Model C) ────────────────────────────
  console.log('\n\x1b[1m8) Company-bot installation token (the universal baseline)\x1b[0m');
  const gid2 = new GithubIdentity(osx);
  assert(gid2.botConfigured() === false, 'bot not configured until App ID + private key set');
  // A real RSA key so appJwt can actually sign (the stub doesn't verify the signature).
  const { generateKeyPairSync } = require('crypto');
  const { privateKey: pem } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  gid2.setAppId('4286232', 'owner@test');
  gid2.setPrivateKey(pem, 'owner@test');
  assert(gid2.botConfigured() === true, 'botConfigured once App ID + private key present');
  assert(gid2.privateKey().includes('BEGIN RSA'), 'private key stored in the vault');
  botMintCount = 0;
  const bot = await gid2.ensureBotToken();
  assert(bot && bot.token.startsWith('ghs_bot_') && botMintCount === 1, 'ensureBotToken mints an installation token');
  assert(osx.settings.githubInstallationId() === '555', 'installation id auto-resolved + stored from listInstallations');
  assert(gid2.loadBotToken().token === bot.token, 'bot token cached in the vault (sync-readable at launch)');
  const bot2 = await gid2.ensureBotToken();
  assert(botMintCount === 1 && bot2.token === bot.token, 'a fresh cached token is reused (no re-mint)');

  // Injection precedence: bot fills GH_TOKEN when unset; an explicit agent PAT wins; a member overrides.
  const be1 = {};
  tm.injectGithubBaseline(be1, 'coder', 'sessB1');
  assert(be1.GH_TOKEN === bot.token && be1.GITHUB_TOKEN === bot.token, 'bot token injected as GH_TOKEN when no agent credential');
  const be2 = { GH_TOKEN: 'gho_agentPAT' };
  tm.injectGithubBaseline(be2, 'coder', 'sessB2');
  assert(be2.GH_TOKEN === 'gho_agentPAT', 'explicit agent GH_TOKEN wins over the bot baseline');
  // Member override still trumps the bot: baseline sets bot, then member token replaces it.
  gid2.save(ownerId, { token: 'gho_member', login: 'octocat', connectedAt: Date.now() });
  const be3 = {};
  tm.injectGithubBaseline(be3, 'coder', 'sessB3');
  tm.injectMemberGithub(be3, 'coder', ownerId, 'sessB3');
  assert(be3.GH_TOKEN === 'gho_member', 'connected member token overrides the bot baseline (attribution)');

  // installUrl self-heal: authorized-but-not-installed + bot creds present → /me resolves the App slug
  // from GET /app so the warning links to the real install page (no manifest slug needed).
  osx.settings.setGithubAppSlug('', 'owner@test');
  gid2.save(ownerId, { token: 'gho_ni', login: 'octocat', connectedAt: Date.now() });
  installState = 'none';
  const meNI2 = await (await call('GET', '/api/github/me')).json();
  assert(meNI2.install && meNI2.install.installed === false && (meNI2.installUrl || '').includes('/apps/agent-os-northwind/installations/new'),
    '/me self-heals the App slug → a real install link when authorized-but-not-installed');
  // Resolves even when ALREADY installed (so the admin "install on more repos" button is available too).
  osx.settings.setGithubAppSlug('', 'owner@test');
  installState = 'installed';
  const meInst = await (await call('GET', '/api/github/me')).json();
  assert((meInst.installUrl || '').includes('/apps/agent-os-northwind/installations/new'), 'App slug resolves regardless of install state');
  // And the admin Creds view (GET /api/settings/integrations) self-heals + exposes the install button.
  osx.settings.setGithubAppSlug('', 'owner@test');
  const iv2 = await (await call('GET', '/api/settings/integrations')).json();
  assert(iv2.github && (iv2.github.installUrl || '').includes('/apps/agent-os-northwind/installations/new'), 'Creds view resolves the slug → install button URL');
  gid2.clear(ownerId);
  // Removing the private key drops the cached bot token + resolved installation.
  gid2.setPrivateKey('', 'owner@test');
  assert(gid2.loadBotToken() === undefined && osx.settings.githubInstallationId() === '', 'clearing the private key drops the cached token + installation id');

  server.close();
  registry.forEach && registry.forEach((x) => { try { x.tm.shutdown && x.tm.shutdown(); } catch { /* */ } });

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}PER-MEMBER GITHUB: ${pass}/${pass + fail} passed\x1b[0m\n`);
  // Best-effort scratch cleanup.
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
