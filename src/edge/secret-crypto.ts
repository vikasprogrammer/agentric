/**
 * Master-key resolution + authenticated encryption for the secrets vault.
 *
 * Values are sealed with AES-256-GCM (Node built-in `node:crypto`, zero-dependency) under a
 * single 32-byte master key. Each sealed value carries its own random 12-byte IV, so the stored
 * blob is self-describing: base64(iv ‖ authTag ‖ ciphertext). GCM's auth tag means a tampered or
 * truncated ciphertext fails to open rather than decrypting to garbage.
 *
 * Master-key resolution order:
 *   1. $AGENT_OS_SECRET_KEY  — 32 bytes as hex (64 chars) or base64. Prod-injectable; never on disk.
 *   2. <home>/secret.key     — auto-generated 0600 key file on first use. Zero-config local dev.
 *
 * Rotating the key invalidates every value sealed under the old one (they'll fail to open) — a
 * deliberate non-feature for now; key rotation + re-encryption is a later increment of the pillar.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/** Parse a 32-byte key from a hex (64-char) or base64 string. Throws if it isn't 32 bytes. */
function parseKey(raw: string): Buffer {
  const s = raw.trim();
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
  else buf = Buffer.from(s, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(`AGENT_OS_SECRET_KEY must be 32 bytes (hex or base64); got ${buf.length}`);
  }
  return buf;
}

/**
 * Resolve the master key: env var if set, else a generated key file at `<home>/secret.key`
 * (created 0600 on first use). `home` undefined (demo/tests with no data home) → ephemeral
 * in-process key, so sealed values don't survive the process — acceptable for the in-memory DB.
 */
export function resolveMasterKey(home?: string): Buffer {
  const fromEnv = process.env.AGENT_OS_SECRET_KEY;
  if (fromEnv) return parseKey(fromEnv);
  if (!home) return crypto.randomBytes(KEY_LEN);
  const keyFile = path.join(home, 'secret.key');
  try {
    return parseKey(fs.readFileSync(keyFile, 'utf8'));
  } catch {
    const key = crypto.randomBytes(KEY_LEN);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600); // enforce even if the file pre-existed with looser perms
    return key;
  }
}

/** Seal a plaintext value → base64(iv ‖ tag ‖ ciphertext). */
export function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Open a sealed value. Throws if the key is wrong or the blob was tampered with. */
export function open(key: Buffer, sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('sealed value too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
