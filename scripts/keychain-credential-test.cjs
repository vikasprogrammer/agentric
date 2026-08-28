#!/usr/bin/env node
/* macOS Keychain credential-resolution test.
 *
 * Why this exists: the pool believed a Keychain-stored `claude login` could be DETECTED but never READ
 * ("the item's ACL only trusts claude"), so every credential-dir account signed in on a Mac showed a frozen
 * usage snapshot and a "can't be probed from here" badge. The real cause of the exit-36 refusal is the
 * security SESSION, not an ACL: 36 is errSecInteractionRequired, which is what a Background session (an ssh
 * shell) gets from a locked login keychain, while the Aqua session the server's LaunchAgent runs in reads
 * the same item with exit 0.
 *
 * Pinned here: the credential record resolves from the plaintext file FIRST and falls back to the Keychain;
 * the Keychain payload is accepted both as text and as `security`'s hex form; a 36 (or any non-zero) exit is
 * a plain miss, never a throw; and off darwin the Keychain is not consulted at all. `spawnSync` is stubbed,
 * so this runs identically on a Linux CI box. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-keychain-test-'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

// Pretend to be macOS regardless of where the suite runs, and drive `security` from a script-owned stub.
const realPlatform = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });
setPlatform('darwin');

const realSpawnSync = child.spawnSync;
let calls = [];
let response = { status: 1, stdout: '' };
child.spawnSync = (cmd, args, opts) => {
  if (cmd !== 'security') return realSpawnSync(cmd, args, opts);
  calls.push(args);
  return response;
};

const { readCredentialRecord, readKeychainCredentials, readConfigDirToken, configDirCanRefresh, keychainServiceFor } =
  require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));

const CRED = (over) => JSON.stringify({ claudeAiOauth: Object.assign({
  accessToken: 'sk-ant-oat01-keychain', refreshToken: 'sk-ant-ort01-keychain',
  expiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
}, over) });

const mkDir = (name, file) => {
  const dir = path.join(HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  if (file) fs.writeFileSync(path.join(dir, '.credentials.json'), file);
  return dir;
};

console.log('\nKeychain credential resolution');

// 1. The plaintext file wins and short-circuits the Keychain entirely.
{
  calls = []; response = { status: 0, stdout: CRED() };
  const dir = mkDir('with-file', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-file' } }));
  assert(readConfigDirToken(dir) === 'sk-ant-oat01-file', 'plaintext .credentials.json is preferred');
  assert(calls.length === 0, 'the Keychain is not consulted when the file is readable');
}

// 2. No file → the Keychain item, read as plain text.
{
  calls = []; response = { status: 0, stdout: CRED() + '\n' };
  const dir = mkDir('keychain-only');
  assert(readConfigDirToken(dir) === 'sk-ant-oat01-keychain', 'falls back to the Keychain item');
  assert(calls.length === 1 && calls[0].includes('-w') && calls[0].includes(keychainServiceFor(dir)),
    'reads the per-dir service name with -w', JSON.stringify(calls[0]));
  assert(configDirCanRefresh(dir) === true, 'a Keychain login reports its refresh token');
}

// 3. `security` prints a non-printable secret as hex — accept that form too.
{
  response = { status: 0, stdout: Buffer.from(CRED(), 'utf8').toString('hex') };
  const dir = mkDir('keychain-hex');
  assert(readConfigDirToken(dir) === 'sk-ant-oat01-keychain', 'hex-encoded Keychain payload is decoded');
}

// 4. Exit 36 (Background session, locked keychain) is a miss, not a throw — and neither is garbage.
{
  response = { status: 36, stdout: '' };
  const dir = mkDir('locked');
  assert(readKeychainCredentials(dir) === undefined, 'exit 36 resolves to undefined');
  assert(readConfigDirToken(dir) === undefined, 'a locked keychain yields no token');
  assert(configDirCanRefresh(dir) === false, 'a locked keychain cannot claim refreshability');
  response = { status: 0, stdout: 'not json at all' };
  assert(readCredentialRecord(dir) === undefined, 'an unparseable payload is a miss, not a throw');
}

// 5. An expired refresh token is genuinely dead even when the record reads fine.
{
  response = { status: 0, stdout: CRED({ refreshTokenExpiresAt: Date.now() - 1000 }) };
  const dir = mkDir('stale-refresh');
  assert(configDirCanRefresh(dir) === false, 'an expired refresh token is not refreshable');
}

// 6. Off darwin the Keychain is never shelled out to.
{
  setPlatform('linux');
  calls = []; response = { status: 0, stdout: CRED() };
  const dir = mkDir('linux-no-file');
  assert(readConfigDirToken(dir) === undefined, 'no Keychain fallback off darwin');
  assert(calls.length === 0, '`security` is not invoked off darwin');
  setPlatform(realPlatform);
}

child.spawnSync = realSpawnSync;
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
