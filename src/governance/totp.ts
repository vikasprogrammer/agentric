/**
 * TOTP (RFC 6238) + the base32 / recovery-code plumbing behind member two-factor sign-in. Zero
 * dependencies — HMAC-SHA1 from node:crypto, the same 30-second / 6-digit profile every authenticator
 * app (Google Authenticator, 1Password, Authy, …) defaults to.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit shared secret, base32 (the form an authenticator app is given). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The TOTP code for one 30-second step. */
export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Check a typed code against the secret, tolerating ±`window` steps of clock drift. Returns the step
 * that matched (the caller persists it and passes it back as `afterStep`, so a code observed over a
 * shoulder can't be replayed inside its own 90-second validity) — or null.
 */
export function verifyTotp(secretB32: string, code: string, opts: { nowMs?: number; window?: number; afterStep?: number } = {}): number | null {
  const typed = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(opts.nowMs);
  const window = opts.window ?? 1;
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (opts.afterStep != null && step <= opts.afterStep) continue;
    const expect = totpAt(secretB32, step);
    if (timingSafeEqual(Buffer.from(expect), Buffer.from(typed))) return step;
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans (as a QR code) or imports. */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Ten single-use recovery codes, `xxxx-xxxx` (lowercase base32 — no 0/1/8/9 ambiguity to mistype). */
export function generateRecoveryCodes(n = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = base32Encode(randomBytes(5)).toLowerCase(); // 40 bits → 8 chars
    out.push(`${s.slice(0, 4)}-${s.slice(4, 8)}`);
  }
  return out;
}

/** Canonical form of a typed recovery code: lowercase, dash/space-insensitive. */
export function normalizeRecoveryCode(code: string): string {
  const s = String(code ?? '').toLowerCase().replace(/[\s-]/g, '');
  return /^[a-z2-7]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
}
