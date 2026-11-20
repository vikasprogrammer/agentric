/**
 * Member two-factor sign-in (TOTP authenticator app + single-use recovery codes).
 *
 * Login is magic-link, so the link IS the first factor — and a link can leak: it is DM'd to Slack/
 * Discord and written to server.log (the self-service recovery path), both places other people and
 * processes can read. A second factor bound to a device the human holds means a leaked link alone no
 * longer signs anyone in.
 *
 * Flow: a member with 2FA on who consumes a link gets a PENDING session (TeamStore, 10-minute TTL,
 * refused by resolveSession) that only unlocks POST /api/auth/2fa/verify; a right code swaps it for a
 * full session. Enrolment is two-step (setup → a pending secret; enable → proves the app has it), so a
 * half-finished setup never locks anyone out.
 *
 * At rest: the TOTP secret is sealed under the vault master key and recovery codes are SHA-256 hashes —
 * the DB is readable by an agent's shell running as the same OS user, so neither may sit in plaintext.
 *
 * The reminder ("nag") cadence for members who haven't turned it on is workspace policy
 * (`SettingsStore.twoFactorPolicy`): on every new login, and/or every N days.
 */
import { Db, tokenAtRest } from '../state/db';
import { seal, open } from '../edge/secret-crypto';
import { generateTotpSecret, verifyTotp, otpauthUri, generateRecoveryCodes, normalizeRecoveryCode } from './totp';
import { qrSvg } from './qr';

const PENDING_SETUP_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TwoFactorPolicy {
  /** Remind a member without 2FA once per new login (each magic-link sign-in). */
  nagOnLogin: boolean;
  /** …and again every N days while they still haven't (0 = no periodic reminder). */
  nagEveryDays: number;
}
export const DEFAULT_TWO_FACTOR_POLICY: TwoFactorPolicy = { nagOnLogin: true, nagEveryDays: 7 };
export function sanitizeTwoFactorPolicy(raw: unknown): TwoFactorPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const days = Number(r.nagEveryDays);
  return {
    nagOnLogin: typeof r.nagOnLogin === 'boolean' ? r.nagOnLogin : DEFAULT_TWO_FACTOR_POLICY.nagOnLogin,
    nagEveryDays: Number.isFinite(days) ? Math.max(0, Math.min(365, Math.floor(days))) : DEFAULT_TWO_FACTOR_POLICY.nagEveryDays,
  };
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt?: number;
  recoveryRemaining: number;
}

interface MfaRow {
  member_id: string;
  secret: string | null;
  enabled_at: number | null;
  last_step: number | null;
  recovery: string;
  pending_secret: string | null;
  pending_at: number | null;
  nag_dismissed_at: number | null;
}

export type VerifyResult = { ok: true; via: 'totp' | 'recovery'; recoveryRemaining: number } | { ok: false };

export class MfaStore {
  constructor(private readonly db: Db, private readonly key: Buffer, private readonly issuer: () => string) {}

  private row(memberId: string): MfaRow | undefined {
    return this.db.prepare('SELECT * FROM member_mfa WHERE member_id = ?').get<MfaRow>(memberId);
  }
  private ensureRow(memberId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO member_mfa (member_id) VALUES (?)').run(memberId);
  }
  private openSecret(sealed: string | null): string | null {
    if (!sealed) return null;
    try { return open(this.key, sealed); } catch { return null; }
  }

  enabled(memberId: string): boolean {
    const r = this.row(memberId);
    return !!(r?.enabled_at && r.secret);
  }
  status(memberId: string): TwoFactorStatus {
    const r = this.row(memberId);
    const on = !!(r?.enabled_at && r.secret);
    return { enabled: on, enabledAt: on ? r!.enabled_at! : undefined, recoveryRemaining: on ? parseHashes(r!.recovery).length : 0 };
  }
  /** Member ids with 2FA on — the Team page's adoption column. */
  enabledMemberIds(): string[] {
    return this.db
      .prepare('SELECT member_id FROM member_mfa WHERE enabled_at IS NOT NULL AND secret IS NOT NULL')
      .all<{ member_id: string }>()
      .map((r) => r.member_id);
  }

  /** Step 1 of enrolment: a fresh secret held PENDING (the live one, if any, is untouched). */
  beginSetup(memberId: string, account: string): { secret: string; uri: string; qrSvg: string } {
    this.ensureRow(memberId);
    const secret = generateTotpSecret();
    this.db.prepare('UPDATE member_mfa SET pending_secret = ?, pending_at = ? WHERE member_id = ?').run(seal(this.key, secret), Date.now(), memberId);
    const uri = otpauthUri(this.issuer(), account, secret);
    return { secret, uri, qrSvg: qrSvg(uri) };
  }

  /** Step 2: the typed code proves the app holds the pending secret → 2FA on, fresh recovery codes
   *  returned ONCE (only their hashes are kept). Null when the code is wrong or setup expired. */
  confirmSetup(memberId: string, code: string): { recoveryCodes: string[] } | null {
    const r = this.row(memberId);
    if (!r?.pending_secret || !r.pending_at || Date.now() - r.pending_at > PENDING_SETUP_TTL_MS) return null;
    const secret = this.openSecret(r.pending_secret);
    if (!secret) return null;
    const step = verifyTotp(secret, code);
    if (step == null) return null;
    const codes = generateRecoveryCodes();
    this.db
      .prepare('UPDATE member_mfa SET secret = ?, enabled_at = ?, last_step = ?, recovery = ?, pending_secret = NULL, pending_at = NULL WHERE member_id = ?')
      .run(r.pending_secret, Date.now(), step, JSON.stringify(codes.map(tokenAtRest)), memberId);
    return { recoveryCodes: codes };
  }

  /**
   * Check a sign-in code: a 6-digit TOTP (each step usable once) or a recovery code (burned on use).
   * Never throws; a member without 2FA always fails.
   */
  verify(memberId: string, code: string, nowMs = Date.now()): VerifyResult {
    const r = this.row(memberId);
    if (!r?.enabled_at || !r.secret) return { ok: false };
    const typed = String(code ?? '').trim();
    if (/^\d[\d\s]*$/.test(typed)) {
      const secret = this.openSecret(r.secret);
      if (!secret) return { ok: false };
      const step = verifyTotp(secret, typed, { nowMs, afterStep: r.last_step ?? undefined });
      if (step == null) return { ok: false };
      this.db.prepare('UPDATE member_mfa SET last_step = ? WHERE member_id = ?').run(step, memberId);
      return { ok: true, via: 'totp', recoveryRemaining: parseHashes(r.recovery).length };
    }
    const norm = normalizeRecoveryCode(typed);
    if (!norm) return { ok: false };
    const hashes = parseHashes(r.recovery);
    const h = tokenAtRest(norm);
    if (!hashes.includes(h)) return { ok: false };
    const left = hashes.filter((x) => x !== h);
    this.db.prepare('UPDATE member_mfa SET recovery = ? WHERE member_id = ?').run(JSON.stringify(left), memberId);
    return { ok: true, via: 'recovery', recoveryRemaining: left.length };
  }

  /** Replace the recovery codes (caller has already verified a code). Returned once. */
  regenerateRecovery(memberId: string): string[] | null {
    if (!this.enabled(memberId)) return null;
    const codes = generateRecoveryCodes();
    this.db.prepare('UPDATE member_mfa SET recovery = ? WHERE member_id = ?').run(JSON.stringify(codes.map(tokenAtRest)), memberId);
    return codes;
  }

  /** Turn 2FA off (self, after a code; or an admin reset for a lost device). Keeps the nag clock. */
  disable(memberId: string): void {
    this.db
      .prepare("UPDATE member_mfa SET secret = NULL, enabled_at = NULL, last_step = NULL, recovery = '[]', pending_secret = NULL, pending_at = NULL WHERE member_id = ?")
      .run(memberId);
  }

  // ── the reminder ────────────────────────────────────────────────────────────────
  /**
   * Should this member be reminded to turn on 2FA right now? Only while it's off. `sessionSeen` = this
   * login already showed (and had dismissed) the reminder. Never dismissed → always due.
   */
  nagDue(memberId: string, policy: TwoFactorPolicy, sessionSeen: boolean, nowMs = Date.now()): boolean {
    if (this.enabled(memberId)) return false;
    if (policy.nagOnLogin && !sessionSeen) return true;
    if (policy.nagEveryDays > 0) {
      const last = this.row(memberId)?.nag_dismissed_at;
      if (!last) return true;
      return nowMs - last >= policy.nagEveryDays * DAY_MS;
    }
    return false;
  }
  dismissNag(memberId: string, nowMs = Date.now()): void {
    this.ensureRow(memberId);
    this.db.prepare('UPDATE member_mfa SET nag_dismissed_at = ? WHERE member_id = ?').run(nowMs, memberId);
  }
}

function parseHashes(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
