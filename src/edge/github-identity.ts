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
import { authorizeUrl, exchangeUserCode, refreshUserToken, githubUser, UserToken } from '../connectors/github';

/** The vault key (per-member principal) holding the JSON token blob. */
const USER_BLOB_KEY = 'github_user';
/** The vault key (tenant-wide `*` principal) holding the App's OAuth client secret. */
const CLIENT_SECRET_KEY = 'github_client_secret';
/** Refresh an expiring token this many ms before it actually expires. */
const REFRESH_SKEW_MS = 10 * 60_000;

/** The stored per-member credential. Only `token`/`refreshToken` are secret; `login`/`expiresAt` are metadata. */
export interface MemberGithub {
  token: string;
  refreshToken?: string;
  /** Epoch ms the access token expires, or undefined for a non-expiring token. */
  expiresAt?: number;
  login: string;
  connectedAt: number;
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
