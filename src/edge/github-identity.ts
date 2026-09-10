/**
 * Per-member GitHub identity (Phase 2 — docs/per-member-github-plan.md).
 *
 * Wraps the secrets vault + settings to store, resolve, and refresh each member's own GitHub **user
 * access token** — the credential a run-as session injects as `GH_TOKEN` so git/PRs are authored as the
 * actual human. The token blob lives in the vault under `principal = <member id>`, key `github_user`
 * (encrypted at rest, isolated per member, NEVER in the tenant-wide `*` scope — so no agent can read
 * another member's token via `secret_get`). The App's OAuth client credentials are workspace-wide:
 * the client id is a plain setting; the client secret sits in the vault under `*`.
 *
 * Constructed on demand from the pieces the caller already holds (`os.secrets`, `os.settings`,
 * `os.tenant`) — no kernel wiring, so the blast radius stays small.
 */
import { authorizeUrl, exchangeUserCode, refreshUserToken, githubUser, UserToken, listInstallations, mintInstallationToken, appMetadata } from '../connectors/github';
import { GithubInstallationRecord } from '../types';

/** The vault key (per-member principal) holding the JSON token blob. */
const USER_BLOB_KEY = 'github_user';
/** The vault key (tenant-wide `*` principal) holding the App's OAuth client secret. */
const CLIENT_SECRET_KEY = 'github_client_secret';
/** The vault key (tenant-wide `*`) holding the App's RSA private key — the company-bot minter's credential. */
const PRIVATE_KEY_KEY = 'github_private_key';
/**
 * The vault key (tenant-wide `*`) caching an installation (bot) token so launch reads it sync. The App
 * can be installed on SEVERAL orgs and each install mints its own org-scoped token, so the cache is
 * keyed PER INSTALLATION: `github_bot_token:<installationId>`. The bare, unsuffixed key is the legacy
 * single-org slot — read once and migrated onto the primary's suffixed key (`migrateLegacyBotToken`),
 * never written again. See docs/github-multi-org-plan.md.
 */
const BOT_TOKEN_KEY = 'github_bot_token';
const botTokenKey = (installationId: string | number): string => `${BOT_TOKEN_KEY}:${installationId}`;
/** Refresh an expiring token this many ms before it actually expires. */
const REFRESH_SKEW_MS = 10 * 60_000;
/** The bot (installation) token lasts ~1 h; refresh with a wide skew so an injected token has plenty of life. */
const BOT_REFRESH_SKEW_MS = 25 * 60_000;

/** The stored per-member credential. Only `token`/`refreshToken` are secret; `login`/`expiresAt` are metadata. */
export interface MemberGithub {
  token: string;
  refreshToken?: string;
  /** Epoch ms the access token expires, or undefined for a non-expiring token. */
  expiresAt?: number;
  login: string;
  connectedAt: number;
}

/** The cached company-bot installation token — an org-scoped credential every session can use as GH_TOKEN. */
export interface BotToken {
  token: string;
  expiresAt: number;
}

/** The minimal slice of AgentOS this store needs — kept structural so it's trivial to construct/test. */
interface GithubDeps {
  tenant: string;
  secrets: {
    getSync(tenant: string, principal: string, key: string): string | undefined;
    set(tenant: string, key: string, value: string, opts?: { principal?: string; updatedBy?: string }): void;
    delete(tenant: string, key: string, principal?: string): boolean;
  };
  settings: {
    githubClientId(): string;
    setGithubClientId(v: string, by?: string): void;
    githubAppSlug(): string;
    setGithubAppSlug(v: string, by?: string): void;
    githubAppId(): string;
    setGithubAppId(v: string, by?: string): void;
    githubInstallationId(): string;
    setGithubInstallationId(v: string, by?: string): void;
    githubInstallations(): GithubInstallationRecord[];
    setGithubInstallations(list: GithubInstallationRecord[], by?: string): GithubInstallationRecord[];
  };
}

export class GithubIdentity {
  constructor(private readonly os: GithubDeps) {}

  // ── company App OAuth config ────────────────────────────────────────────────
  clientId(): string {
    return this.os.settings.githubClientId();
  }
  clientSecret(): string {
    return this.os.secrets.getSync(this.os.tenant, '*', CLIENT_SECRET_KEY) ?? '';
  }
  setClientSecret(value: string, by?: string): void {
    const v = value.trim();
    if (v) this.os.secrets.set(this.os.tenant, CLIENT_SECRET_KEY, v, { principal: '*', updatedBy: by });
    else this.os.secrets.delete(this.os.tenant, CLIENT_SECRET_KEY, '*');
  }
  /** The created App's slug (manifest flow) → the "Install on your repos" link. */
  appSlug(): string {
    return this.os.settings.githubAppSlug();
  }
  /** The GitHub install page for this App, or '' if the slug isn't known yet. */
  installUrl(): string {
    const slug = this.appSlug();
    return slug ? `https://github.com/apps/${slug}/installations/new` : '';
  }
  /**
   * Resolve + cache the App slug from `GET /app` when we have the App credentials but no slug yet — so an
   * App configured by hand (no slug from the manifest flow) still gets an "Install the App" link. One-shot:
   * returns immediately once the slug is known; needs the bot creds (App id + private key).
   */
  async ensureAppSlug(by?: string): Promise<string> {
    const existing = this.appSlug();
    if (existing || !this.botConfigured()) return existing;
    const meta = await appMetadata(this.appId(), this.privateKey());
    if ('error' in meta || !meta.slug) return '';
    this.os.settings.setGithubAppSlug(meta.slug, by);
    return meta.slug;
  }
  /** Persist a freshly-created App's credentials in one shot (the manifest-conversion result). */
  saveApp(app: { clientId: string; clientSecret: string; slug: string }, by?: string): void {
    this.os.settings.setGithubClientId(app.clientId, by);
    this.setClientSecret(app.clientSecret, by);
    this.os.settings.setGithubAppSlug(app.slug, by);
  }

  // ── company-bot (installation token) — the universal git baseline ────────────
  // The App's App ID (setting) + RSA private key (vault) let us mint short-lived, org-scoped
  // **installation access tokens** that act as the App bot on every installed repo — the credential a
  // session uses when the run-as human hasn't linked their own GitHub and the agent has no PAT. Minting
  // is a network call, but the launch path is synchronous, so we cache the current token in the vault
  // (like member tokens) and read it sync at launch, refreshing in the background — see loadBotToken /
  // ensureBotToken. Deleting the private key drops the cache too.
  appId(): string {
    return this.os.settings.githubAppId();
  }
  setAppId(v: string, by?: string): void {
    this.os.settings.setGithubAppId(v, by);
  }
  privateKey(): string {
    return this.os.secrets.getSync(this.os.tenant, '*', PRIVATE_KEY_KEY) ?? '';
  }
  setPrivateKey(value: string, by?: string): void {
    const v = value.trim();
    if (v) {
      this.os.secrets.set(this.os.tenant, PRIVATE_KEY_KEY, v, { principal: '*', updatedBy: by });
    } else {
      // Clearing the key detaches the bot entirely — drop EVERY cached token (one per installation,
      // plus the legacy unsuffixed slot) and the whole resolved registry.
      this.os.secrets.delete(this.os.tenant, PRIVATE_KEY_KEY, '*');
      this.os.secrets.delete(this.os.tenant, BOT_TOKEN_KEY, '*');
      for (const inst of this.installations()) this.os.secrets.delete(this.os.tenant, botTokenKey(inst.id), '*');
      const primary = this.os.settings.githubInstallationId();
      if (primary) this.os.secrets.delete(this.os.tenant, botTokenKey(primary), '*');
      this.os.settings.setGithubInstallations([], by);
      this.os.settings.setGithubInstallationId('', by);
    }
  }
  /** App id + private key present — the minimum to mint an installation (bot) token. */
  botConfigured(): boolean {
    return !!this.appId() && !!this.privateKey();
  }

  // ── the installation registry (multi-org) ───────────────────────────────────
  // One App, potentially many orgs. `github_installations` is the whole set; `github_installation_id`
  // keeps its original meaning as the PRIMARY — the install whose token is injected as GH_TOKEN at
  // launch. A one-org tenant never notices any of this.

  /** Every installation the App has, as last resolved. Empty when we've never asked GitHub. */
  installations(): GithubInstallationRecord[] {
    return this.os.settings.githubInstallations();
  }

  /** The installation for an org/user login (case-insensitive), or undefined when the App isn't on it. */
  installationFor(org: string): GithubInstallationRecord | undefined {
    const want = org.trim().toLowerCase();
    if (!want) return undefined;
    return this.installations().find((i) => i.account.toLowerCase() === want);
  }

  /** The primary installation record, when the primary id resolves to one we know about. */
  primaryInstallation(): GithubInstallationRecord | undefined {
    const id = this.os.settings.githubInstallationId();
    return id ? this.installations().find((i) => String(i.id) === id) : undefined;
  }

  /** The org/user logins the bot can reach — what an agent is told it has git access to. */
  orgs(): string[] {
    return this.installations().map((i) => i.account);
  }

  /**
   * Re-resolve the App's installations from GitHub and persist the set. Also settles the PRIMARY: it is
   * left alone while it still names a live installation, and otherwise adopts the first (which is what
   * the old single-installation code did unconditionally — the difference is that now the rest of the
   * set is recorded, so a second org is visible instead of silently unreachable). Returns the stored
   * list, or the last-known one when GitHub can't be reached.
   */
  async refreshInstallations(by?: string): Promise<GithubInstallationRecord[]> {
    if (!this.botConfigured()) return this.installations();
    const li = await listInstallations(this.appId(), this.privateKey());
    if ('error' in li) return this.installations();
    const list = this.os.settings.setGithubInstallations(li.installations, by);
    const primary = this.os.settings.githubInstallationId();
    const stillThere = primary && list.some((i) => String(i.id) === primary);
    if (!stillThere) this.os.settings.setGithubInstallationId(list.length ? String(list[0].id) : '', by);
    return list;
  }

  /**
   * Resolve which installation a request means: a named org (undefined when the App isn't installed on
   * it — the caller must NOT silently fall through to another org's token), or the primary when no org
   * is named. Falls back to the bare primary id even when the registry is empty, so a tenant that has
   * never refreshed still mints exactly as it did before.
   */
  private resolveInstallationId(org?: string): string {
    if (org) {
      const inst = this.installationFor(org);
      return inst ? String(inst.id) : '';
    }
    return this.os.settings.githubInstallationId();
  }

  /**
   * One-shot migration of the pre-multi-org cache: a token stored under the bare `github_bot_token` key
   * belongs to whatever installation was primary at the time, so move it onto that installation's
   * suffixed key. Idempotent, and a no-op once the legacy slot is empty.
   */
  private migrateLegacyBotToken(): void {
    const legacy = this.os.secrets.getSync(this.os.tenant, '*', BOT_TOKEN_KEY);
    if (!legacy) return;
    const primary = this.os.settings.githubInstallationId();
    if (primary && !this.os.secrets.getSync(this.os.tenant, '*', botTokenKey(primary))) {
      this.os.secrets.set(this.os.tenant, botTokenKey(primary), legacy, { principal: '*' });
    }
    this.os.secrets.delete(this.os.tenant, BOT_TOKEN_KEY, '*');
  }

  /**
   * Read a cached bot token (sync — the launch path reads it synchronously). `org` picks an
   * installation by account login; omitted means the primary. Returns undefined when that installation
   * has no cached token — or, for a named org, when the App isn't installed on it at all.
   */
  loadBotToken(org?: string): BotToken | undefined {
    this.migrateLegacyBotToken();
    const id = this.resolveInstallationId(org);
    if (!id) return undefined;
    const raw = this.os.secrets.getSync(this.os.tenant, '*', botTokenKey(id));
    if (!raw) return undefined;
    try {
      const j = JSON.parse(raw) as BotToken;
      return typeof j?.token === 'string' && typeof j?.expiresAt === 'number' ? j : undefined;
    } catch {
      return undefined;
    }
  }
  botNeedsRefresh(blob: BotToken, nowMs: number = Date.now()): boolean {
    return blob.expiresAt - BOT_REFRESH_SKEW_MS <= nowMs;
  }

  /**
   * Return a live bot token, minting + caching one if missing/expiring. `org` names an installation by
   * account login; omitted (the usual case, and every launch-path caller) means the PRIMARY.
   *
   * The registry is resolved on first use — and re-resolved whenever we're asked for an org we don't
   * know about, since the App may have been installed on it since we last looked. Returns undefined
   * when the bot isn't configured, the named org has no installation, or a mint fails hard (a stale
   * cached token is kept so callers can still try it). Async: the sync launch path fires-and-forgets
   * this while injecting the current cached token.
   */
  async ensureBotToken(nowMs: number = Date.now(), by?: string, org?: string): Promise<BotToken | undefined> {
    if (!this.botConfigured()) return undefined;
    const cached = this.loadBotToken(org);
    if (cached && !this.botNeedsRefresh(cached, nowMs)) return cached;
    let instId = this.resolveInstallationId(org);
    if (!instId) {
      // No primary yet, or an org we've not seen — ask GitHub and settle the registry.
      await this.refreshInstallations(by);
      instId = this.resolveInstallationId(org);
      if (!instId) return cached; // the App genuinely isn't installed there
    }
    const minted = await mintInstallationToken(this.appId(), this.privateKey(), instId);
    if ('error' in minted) {
      // A stale installation id (App reinstalled/uninstalled) → re-resolve once and retry.
      const before = instId;
      await this.refreshInstallations(by);
      const retryId = this.resolveInstallationId(org);
      if (!retryId || retryId === before) return cached;
      const retry = await mintInstallationToken(this.appId(), this.privateKey(), retryId);
      if ('error' in retry) return cached;
      return this.saveBotToken(retryId, retry, by);
    }
    return this.saveBotToken(instId, minted, by);
  }

  private saveBotToken(installationId: string | number, minted: { token: string; expiresAt: number }, by?: string): BotToken {
    const blob: BotToken = { token: minted.token, expiresAt: minted.expiresAt };
    this.os.secrets.set(this.os.tenant, botTokenKey(installationId), JSON.stringify(blob), { principal: '*', updatedBy: by });
    return blob;
  }
  /** Both halves present — the minimum to run the OAuth flow. */
  configured(): boolean {
    return !!this.clientId() && !!this.clientSecret();
  }

  // ── per-member token blob ───────────────────────────────────────────────────
  /** Load a member's stored token blob (sync — the launch path reads it synchronously). */
  load(memberId: string): MemberGithub | undefined {
    const raw = this.os.secrets.getSync(this.os.tenant, memberId, USER_BLOB_KEY);
    if (!raw) return undefined;
    try {
      const j = JSON.parse(raw) as MemberGithub;
      return typeof j?.token === 'string' ? j : undefined;
    } catch {
      return undefined;
    }
  }
  save(memberId: string, blob: MemberGithub, by?: string): void {
    this.os.secrets.set(this.os.tenant, USER_BLOB_KEY, JSON.stringify(blob), { principal: memberId, updatedBy: by });
  }
  clear(memberId: string): boolean {
    return this.os.secrets.delete(this.os.tenant, USER_BLOB_KEY, memberId);
  }

  // ── OAuth flow helpers ──────────────────────────────────────────────────────
  /** The GitHub authorize URL for `state` + our callback (empty when the App isn't configured). */
  authorizeUrl(redirectUri: string, state: string): string {
    return authorizeUrl({ clientId: this.clientId(), redirectUri, state });
  }

  /**
   * Complete the OAuth callback: exchange `code`, look up the member's login, and persist the blob.
   * Returns the resolved login (for the caller to record in `member_identities`) or `{ error }`.
   */
  async completeConnect(memberId: string, code: string, redirectUri: string, by?: string, nowMs: number = Date.now()): Promise<{ login: string } | { error: string }> {
    const tok = await exchangeUserCode({ clientId: this.clientId(), clientSecret: this.clientSecret(), code, redirectUri }, nowMs);
    if ('error' in tok) return tok;
    const who = await githubUser(tok.token);
    if ('error' in who) return who;
    this.save(memberId, this.toBlob(tok, who.login, nowMs), by);
    return { login: who.login };
  }

  /**
   * Return a live token for `memberId`, refreshing first if it's expiring and a refresh token exists.
   * Persists a refreshed blob. Returns undefined when the member isn't connected (or a refresh failed
   * hard — the stale token is kept so the caller can still try it). Async: callers that must not block
   * (the sync launch path) fire-and-forget this while injecting the current stored token.
   */
  async ensureFresh(memberId: string, nowMs: number = Date.now()): Promise<MemberGithub | undefined> {
    const blob = this.load(memberId);
    if (!blob) return undefined;
    if (!this.needsRefresh(blob, nowMs) || !blob.refreshToken || !this.configured()) return blob;
    const tok = await refreshUserToken({ clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: blob.refreshToken }, nowMs);
    if ('error' in tok) return blob; // keep the stale token; caller/next attempt retries
    const next = this.toBlob(tok, blob.login, nowMs, blob);
    this.save(memberId, next);
    return next;
  }

  /** True when an expiring token is within the refresh skew of expiry. Non-expiring tokens never are. */
  needsRefresh(blob: MemberGithub, nowMs: number = Date.now()): boolean {
    return blob.expiresAt !== undefined && blob.expiresAt - REFRESH_SKEW_MS <= nowMs;
  }

  /**
   * True when a token is ALREADY past its expiry — the harder condition `needsRefresh` deliberately
   * doesn't distinguish (that one fires inside the skew, while the token is still usable). The launch
   * path needs the distinction: a merely-stale token is still worth injecting, a dead one is not.
   * Shared by the member and bot blobs, both of which carry `expiresAt` in epoch ms.
   */
  isExpired(blob: { expiresAt?: number }, nowMs: number = Date.now()): boolean {
    return blob.expiresAt !== undefined && blob.expiresAt <= nowMs;
  }

  /**
   * On-demand refresh for a LIVE session (the `github_refresh` agent tool). Unlike `ensureFresh` — which
   * only fires within the expiry skew and is fire-and-forget at launch — this UNCONDITIONALLY exchanges
   * the stored refresh token for a new access token, because the agent only calls it after a token has
   * already gone bad mid-run (the launch-time refresh window is long past). Returns the fresh blob so the
   * caller can hand the new token back to the running process, or a typed reason it couldn't:
   *  - `not_connected`   — the member never linked GitHub (nothing to refresh).
   *  - `no_refresh_token` — no `ghr_` stored AND the current token is expiring; the App likely lacks
   *                         "Expire user authorization tokens", so re-linking is the only recovery.
   *  - `not_configured`  — the App's OAuth client id/secret aren't set, so we can't call GitHub.
   *  - `failed`          — GitHub rejected the refresh (revoked/invalid); the stale blob is kept.
   * When a refresh token is missing but the current token still has life, we return it as-is
   * (`refreshed:false`) rather than error — the agent can keep using it.
   */
  async forceRefresh(
    memberId: string,
    nowMs: number = Date.now(),
  ): Promise<
    | { status: 'ok'; blob: MemberGithub; refreshed: boolean }
    | { status: 'not_connected' }
    | { status: 'no_refresh_token' }
    | { status: 'not_configured' }
    | { status: 'failed'; detail: string }
  > {
    const blob = this.load(memberId);
    if (!blob) return { status: 'not_connected' };
    if (!blob.refreshToken) {
      return this.needsRefresh(blob, nowMs) ? { status: 'no_refresh_token' } : { status: 'ok', blob, refreshed: false };
    }
    if (!this.configured()) return { status: 'not_configured' };
    const tok = await refreshUserToken({ clientId: this.clientId(), clientSecret: this.clientSecret(), refreshToken: blob.refreshToken }, nowMs);
    if ('error' in tok) return { status: 'failed', detail: tok.error };
    const next = this.toBlob(tok, blob.login, nowMs, blob);
    this.save(memberId, next);
    return { status: 'ok', blob: next, refreshed: true };
  }

  /** Merge an OAuth token result into a stored blob (carrying the refresh token forward if a new one wasn't issued). */
  private toBlob(tok: UserToken, login: string, nowMs: number, prev?: MemberGithub): MemberGithub {
    return {
      token: tok.token,
      refreshToken: tok.refreshToken ?? prev?.refreshToken,
      expiresAt: tok.expiresAt,
      login,
      connectedAt: prev?.connectedAt ?? nowMs,
    };
  }
}
