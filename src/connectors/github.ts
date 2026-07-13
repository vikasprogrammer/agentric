/**
 * Native GitHub — a thin, zero-dependency client for the slice of GitHub's App API the OS needs to
 * mint short-lived **installation access tokens** for agents. One company GitHub App, registered once
 * (Settings → Integrations) and installed on the org's repos, is the single credential source for both
 * consumption paths:
 *   - the shell (`gh` / `git`) — the minted token is exported as `GH_TOKEN` at launch, and
 *   - governed API tools — the same token is a valid bearer for a GitHub MCP connector.
 *
 * Why an App (not a static PAT): the installation token is org-scoped, carries only the App's
 * fine-grained per-repo permissions, and **expires hourly** — minted on demand, so nothing long-lived
 * is ever handed to an agent. The App's private key never leaves the server (vault), and the JWT we
 * sign to obtain a token lives ≤10 min.
 *
 * All calls use the global `fetch` (Node 22+) and `node:crypto` for the RS256 signature — no runtime
 * dependency, matching the Slack/Composio connectors' stance. Every call returns `{ error }` rather
 * than throwing, so a flaky network or bad credential degrades gracefully at the call site.
 */
import { createSign } from 'crypto';

const GH_API = 'https://api.github.com';
const UA = 'agent-os';
/** Standard headers for the REST v3 JSON API (minus auth, which each call adds). */
const BASE_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': UA };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign a GitHub **App JWT** (RS256) — the credential used to call the App-level endpoints (list
 * installations, mint an installation token). `iss` is the App id; the token is short-lived (GitHub
 * rejects an `exp` more than 10 min out). We back-date `iat` 30 s to tolerate clock skew between us
 * and GitHub. `privateKeyPem` is the App's RSA private key (PKCS#1 or PKCS#8 PEM).
 *
 * Pure + synchronous — the launch path and the offline test both call it directly. `nowMs` is
 * injectable so the test can assert exact claims without wall-clock flake.
 */
export function appJwt(appId: string | number, privateKeyPem: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 30; // clock-skew cushion
  const exp = iat + 9 * 60; // 9 min — comfortably inside GitHub's 10-min ceiling
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-member user-to-server OAuth (Phase 2 — docs/per-member-github-plan.md)
//
// The company App's client_id/secret drive the browser OAuth web flow that yields a **user access
// token** — the credential that authors git/PRs AS the actual human (run-as), not the bot. Same three
// primitives for a classic OAuth App or a GitHub App; the only difference is a GitHub App can issue an
// EXPIRING user token (+ refresh token), which `refreshUserToken` renews.
// ─────────────────────────────────────────────────────────────────────────────

const GH_OAUTH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GH_OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

/**
 * Build the GitHub authorize URL the member's browser is redirected to. `scope` defaults to `repo`
 * (push + PRs on an OAuth App); a GitHub App ignores it and governs access via its own per-repo
 * permissions, so it's harmless either way. `state` is our single-use CSRF token.
 */
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; scope?: string }): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    state: o.state,
    scope: o.scope ?? 'repo',
    allow_signup: 'false',
  });
  return `${GH_OAUTH_AUTHORIZE}?${q.toString()}`;
}

/** A user access token from the OAuth exchange/refresh. Expiry fields are present only for expiring tokens. */
export interface UserToken {
  token: string;
  refreshToken?: string;
  /** Epoch ms the access token expires, or undefined for a non-expiring token. */
  expiresAt?: number;
  /** Epoch ms the refresh token expires (GitHub App expiring-token mode), or undefined. */
  refreshExpiresAt?: number;
  /** The scopes granted (OAuth App); '' for a GitHub App (permissions govern instead). */
  scope?: string;
}

/** Shared parser for the token endpoint's JSON response (used by both exchange + refresh). */
function parseTokenResponse(j: any, nowMs: number): UserToken | { error: string } {
  if (j?.error) return { error: `${j.error}${j.error_description ? `: ${j.error_description}` : ''}` };
  if (typeof j?.access_token !== 'string') return { error: 'token response had no access_token' };
  const out: UserToken = { token: j.access_token };
  if (typeof j.refresh_token === 'string') out.refreshToken = j.refresh_token;
  if (Number.isFinite(Number(j.expires_in))) out.expiresAt = nowMs + Number(j.expires_in) * 1000;
  if (Number.isFinite(Number(j.refresh_token_expires_in))) out.refreshExpiresAt = nowMs + Number(j.refresh_token_expires_in) * 1000;
  if (typeof j.scope === 'string') out.scope = j.scope;
  return out;
}

/** Exchange an OAuth `code` (from the callback) for a user access token. Returns `{ error }` on failure. */
export async function exchangeUserCode(
  o: { clientId: string; clientSecret: string; code: string; redirectUri: string },
  nowMs: number = Date.now(),
): Promise<UserToken | { error: string }> {
  try {
    const res = await fetch(GH_OAUTH_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri }),
    });
    if (!res.ok) return { error: `POST oauth/access_token → ${res.status} ${await res.text().catch(() => '')}`.trim() };
    return parseTokenResponse(await res.json().catch(() => ({})), nowMs);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'OAuth code exchange failed' };
  }
}

/** Renew an expiring user token with its refresh token (GitHub App expiring-token mode). */
export async function refreshUserToken(
  o: { clientId: string; clientSecret: string; refreshToken: string },
  nowMs: number = Date.now(),
): Promise<UserToken | { error: string }> {
  try {
    const res = await fetch(GH_OAUTH_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'refresh_token', refresh_token: o.refreshToken }),
    });
    if (!res.ok) return { error: `POST oauth/refresh → ${res.status} ${await res.text().catch(() => '')}`.trim() };
    return parseTokenResponse(await res.json().catch(() => ({})), nowMs);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'OAuth token refresh failed' };
  }
}

/** What a GitHub App **manifest conversion** yields — GitHub creates the App and hands back its
 *  credentials in one shot, so the user never copy-pastes a client id/secret. */
export interface ConvertedApp {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  htmlUrl: string;
  /** Present because the manifest flow always generates them; unused by the per-member OAuth path. */
  webhookSecret?: string;
  pem?: string;
}

/**
 * Exchange the temporary `code` from GitHub's App-manifest redirect for a fully-created App
 * (`POST /app-manifests/:code/conversions`). This is the one-click setup path: our manifest pre-fills
 * name/callback/permissions, GitHub creates the App, and this returns its client id + secret (which we
 * persist) so the admin never handles them by hand. The `code` is single-use and expires in ~1 h.
 */
export async function convertAppManifest(code: string): Promise<ConvertedApp | { error: string }> {
  try {
    const res = await fetch(`${GH_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { ...BASE_HEADERS },
    });
    if (!res.ok) return { error: `POST app-manifests/conversions → ${res.status} ${await res.text().catch(() => '')}`.trim() };
    const j = (await res.json().catch(() => ({}))) as any;
    if (typeof j?.client_id !== 'string') return { error: 'manifest conversion response had no client_id' };
    return {
      appId: Number(j.id),
      slug: String(j.slug ?? ''),
      clientId: j.client_id,
      clientSecret: String(j.client_secret ?? ''),
      htmlUrl: String(j.html_url ?? ''),
      webhookSecret: typeof j.webhook_secret === 'string' ? j.webhook_secret : undefined,
      pem: typeof j.pem === 'string' ? j.pem : undefined,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'manifest conversion failed' };
  }
}

/** Look up the authenticated user's `login` + numeric `id` (`GET /user`) for the connected token. */
export async function githubUser(token: string): Promise<{ login: string; id: number } | { error: string }> {
  try {
    const res = await fetch(`${GH_API}/user`, { headers: { ...BASE_HEADERS, authorization: `Bearer ${token}` } });
    if (!res.ok) return { error: `GET /user → ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as any;
    if (typeof j?.login !== 'string') return { error: 'GET /user had no login' };
    return { login: j.login, id: Number(j.id) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'GET /user failed' };
  }
}

/** A GitHub App installation — one org/user the App is installed on. `account` is the org/user login. */
export interface GithubInstallation {
  id: number;
  account: string;
  /** The repository selection the installer granted: `all` or `selected`. */
  repositorySelection?: string;
}

/**
 * List the App's installations (`GET /app/installations`) — for the settings UI to confirm/pick which
 * installation to mint tokens against, and to validate the App id + private key are correct (a bad key
 * → 401 here). Returns `{ error }` on any non-2xx or network failure.
 */
export async function listInstallations(
  appId: string | number,
  privateKeyPem: string,
): Promise<{ installations: GithubInstallation[] } | { error: string }> {
  let jwt: string;
  try {
    jwt = appJwt(appId, privateKeyPem);
  } catch (e) {
    return { error: `could not sign App JWT (check the private key): ${e instanceof Error ? e.message : e}` };
  }
  try {
    const res = await fetch(`${GH_API}/app/installations`, { headers: { ...BASE_HEADERS, authorization: `Bearer ${jwt}` } });
    if (!res.ok) return { error: `GET /app/installations → ${res.status} ${await res.text().catch(() => '')}`.trim() };
    const arr = (await res.json().catch(() => [])) as any[];
    const installations = (Array.isArray(arr) ? arr : []).map((i) => ({
      id: Number(i?.id),
      account: String(i?.account?.login ?? i?.account?.slug ?? '?'),
      repositorySelection: i?.repository_selection ? String(i.repository_selection) : undefined,
    }));
    return { installations };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'GET /app/installations failed' };
  }
}

/** A freshly minted installation token: the bearer + when it expires (epoch ms) for cache eviction. */
export interface InstallationToken {
  token: string;
  expiresAt: number;
}

/**
 * Mint a 1 h **installation access token**
 * (`POST /app/installations/:id/access_tokens`) — the credential handed to the agent (as `GH_TOKEN`
 * and/or an MCP bearer). Optionally narrow it to specific `repositories` / `permissions` (a subset of
 * what the installation granted) for least-privilege; omitted → the installation's full grant.
 * Returns `{ error }` on any failure (the caller then leaves `GH_TOKEN` unset rather than acting on a
 * bad credential).
 */
export async function mintInstallationToken(
  appId: string | number,
  privateKeyPem: string,
  installationId: string | number,
  opts: { repositories?: string[]; permissions?: Record<string, string> } = {},
): Promise<InstallationToken | { error: string }> {
  let jwt: string;
  try {
    jwt = appJwt(appId, privateKeyPem);
  } catch (e) {
    return { error: `could not sign App JWT (check the private key): ${e instanceof Error ? e.message : e}` };
  }
  const body: Record<string, unknown> = {};
  if (opts.repositories?.length) body.repositories = opts.repositories;
  if (opts.permissions && Object.keys(opts.permissions).length) body.permissions = opts.permissions;
  try {
    const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...BASE_HEADERS, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return { error: `POST access_tokens → ${res.status} ${await res.text().catch(() => '')}`.trim() };
    const j = (await res.json().catch(() => ({}))) as any;
    if (typeof j?.token !== 'string') return { error: 'access_tokens response had no token' };
    const expiresAt = j?.expires_at ? Date.parse(j.expires_at) : Date.now() + 55 * 60_000;
    return { token: j.token, expiresAt };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'POST access_tokens failed' };
  }
}

/**
 * A tiny in-memory installation-token cache: mint once, reuse until ~5 min before expiry, so a burst
 * of session launches doesn't hammer the mint endpoint (nor exhaust GitHub's rate limit). Keyed by
 * installation id + the repo/permission narrowing, since those change the token's scope. Process-local
 * by design — tokens are short-lived and must not outlive a restart.
 */
export class InstallationTokenCache {
  private readonly cache = new Map<string, InstallationToken>();
  /** Evict this many ms before the real expiry so a token handed out now is still valid for a while. */
  private readonly skewMs = 5 * 60_000;

  constructor(
    private readonly appId: string | number,
    private readonly privateKeyPem: string,
  ) {}

  /** Return a live token for `installationId` (minting/refreshing as needed), or `{ error }`. */
  async get(
    installationId: string | number,
    opts: { repositories?: string[]; permissions?: Record<string, string> } = {},
    nowMs: number = Date.now(),
  ): Promise<InstallationToken | { error: string }> {
    const key = `${installationId}|${(opts.repositories ?? []).join(',')}|${JSON.stringify(opts.permissions ?? {})}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - this.skewMs > nowMs) return hit;
    const minted = await mintInstallationToken(this.appId, this.privateKeyPem, installationId, opts);
    if ('error' in minted) return minted;
    this.cache.set(key, minted);
    return minted;
  }

  /** Drop all cached tokens — call when the App credentials change. */
  clear(): void {
    this.cache.clear();
  }
}
