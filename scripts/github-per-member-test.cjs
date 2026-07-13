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
  me = await (await call('GET', '/api/github/me')).json();
  assert(me.connected === true && me.login === 'octocat', '/me now reports connected as octocat');
  assert(!('token' in me), '/me never leaks the token');

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

  server.close();
  registry.forEach && registry.forEach((x) => { try { x.tm.shutdown && x.tm.shutdown(); } catch { /* */ } });

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}PER-MEMBER GITHUB: ${pass}/${pass + fail} passed\x1b[0m\n`);
  // Best-effort scratch cleanup.
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* */ } process.exit(1); });
