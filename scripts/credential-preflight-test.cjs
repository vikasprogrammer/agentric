#!/usr/bin/env node
/* Launch-time credential readiness (fail-closed on a locked macOS Keychain).
 *
 * Why this exists — instapods, 2026-09-01: the login keychain auto-locked overnight and the server kept
 * spawning sessions for ~17 hours. Every existing check passed, because a Keychain item's PRESENCE is
 * readable (metadata lookup, exit 0) while its VALUE is not, and claude's credential store treats a locked
 * keychain as a TRANSIENT failure that skips the plaintext fallback entirely. Result: 8 runs, all $0 and
 * one turn, 3 left `running`, no alert.
 *
 * Pinned here: readability is asked separately from presence; a locked keychain is the ONLY state that
 * blocks a launch (a missing dir keeps its fail-open behaviour); an apikey/token environment needs no dir
 * at all; the BOX DEFAULT dir is probed under the bare service name, not a path-hashed one. `spawnSync` is
 * stubbed, so this runs identically on a Linux CI box. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-preflight-test-'));
process.env.HOME = HOME;                     // os.homedir() follows $HOME on posix
delete process.env.CLAUDE_CONFIG_DIR;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const realPlatform = process.platform;
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });
setPlatform('darwin');

// Arg-aware `security` stub: a metadata lookup and a secret read are DIFFERENT questions, and the whole
// bug is that they can disagree. `-w` reads the value; without it the call only proves the item exists.
const realSpawnSync = child.spawnSync;
let items = new Map();            // service → { exists, secret|null }  (secret null = present but unreadable)
child.spawnSync = (cmd, args, opts) => {
  if (cmd !== 'security') return realSpawnSync(cmd, args, opts);
  const svc = args[args.indexOf('-s') + 1];
  const it = items.get(svc);
  if (!it || !it.exists) return { status: 44, stdout: '' };            // errSecItemNotFound
  if (!args.includes('-w')) return { status: 0, stdout: '' };
  return it.secret == null ? { status: 36, stdout: '' } : { status: 0, stdout: it.secret };
};

const { credentialReadiness, preflightCredential, keychainServiceFor, launchCredentialDir } =
  require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));

const CRED = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-x' } });
const mkDir = (name, withFile) => {
  const dir = path.join(HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withFile) fs.writeFileSync(path.join(dir, '.credentials.json'), CRED);
  return dir;
};

console.log('\nCredential readiness');
{
  items = new Map();
  const dir = mkDir('with-file', true);
  const r = credentialReadiness('claude-code', dir);
  assert(r.ok === true && r.via === 'file', 'a plaintext .credentials.json is usable without touching the Keychain');
}
{
  const dir = mkDir('kc-readable');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: CRED }]]);
  const r = credentialReadiness('claude-code', dir);
  assert(r.ok === true && r.via === 'keychain', 'a readable Keychain login is usable');
}
{
  const dir = mkDir('kc-locked');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: null }]]);
  const r = credentialReadiness('claude-code', dir);
  assert(r.ok === false && r.reason === 'keychain_locked', 'a Keychain login whose VALUE will not read is keychain_locked, not usable',
    JSON.stringify(r));
}
{
  const dir = mkDir('kc-empty');
  items = new Map();
  const r = credentialReadiness('claude-code', dir);
  assert(r.ok === false && r.reason === 'missing', 'no file and no Keychain item is plain missing');
}
{
  // codex is file-only: an absent auth.json is missing, and the Keychain is never consulted for it.
  const dir = mkDir('codex-empty');
  let asked = 0;
  const prev = child.spawnSync;
  child.spawnSync = (cmd, a, o) => { if (cmd === 'security') asked++; return prev(cmd, a, o); };
  const r = credentialReadiness('codex', dir);
  child.spawnSync = prev;
  assert(r.ok === false && r.reason === 'missing' && asked === 0, 'a non-claude runtime is file-only — the Keychain is never consulted');
}

console.log('\nLaunch pre-flight');
{
  const dir = mkDir('pf-locked');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: null }]]);
  const b = preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: dir });
  assert(b && b.dir === dir && b.service === keychainServiceFor(dir), 'a locked pool credential dir BLOCKS the launch', JSON.stringify(b));
}
{
  const dir = mkDir('pf-ok');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: CRED }]]);
  assert(preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: dir }) === null, 'a readable credential dir does not block');
}
{
  const dir = mkDir('pf-missing');
  items = new Map();
  assert(preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: dir }) === null,
    'a MISSING credential stays fail-open — only an unreadable one is certain enough to refuse');
}
{
  // An api-key / token account carries its credential in the environment: there is no dir to probe, and a
  // locked keychain is irrelevant to it.
  const dir = mkDir('pf-key');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: null }]]);
  assert(launchCredentialDir('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-x' }) === null, 'an ANTHROPIC_API_KEY environment needs no credential dir');
  assert(preflightCredential('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-x' }) === null, 'an api-key launch is never blocked by the Keychain');
  assert(preflightCredential('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }) === null, 'a token launch is never blocked by the Keychain');
}
{
  // The box default: no CLAUDE_CONFIG_DIR in the launch env at all. Its Keychain item carries the BARE
  // service name — probing it under a path-hashed name would report "no login" for a signed-in box, and
  // the 17-hour incident ran precisely on such a default-shaped credential.
  const def = path.join(HOME, '.claude');
  fs.mkdirSync(def, { recursive: true });
  assert(keychainServiceFor(def) === 'Claude Code-credentials', 'the box default dir maps to the bare Keychain service name');
  assert(keychainServiceFor(path.join(HOME, 'pool-1')) !== 'Claude Code-credentials', 'a pool dir maps to a path-hashed service name');
  items = new Map([['Claude Code-credentials', { exists: true, secret: null }]]);
  const b = preflightCredential('claude-code', {});
  assert(b && b.dir === def, 'a locked BOX DEFAULT login blocks the launch too — rotation is not what makes this fatal', JSON.stringify(b));
}
{
  // Off darwin there is no Keychain: nothing may be refused on its account.
  setPlatform('linux');
  const dir = mkDir('linux-empty');
  items = new Map([[keychainServiceFor(dir), { exists: true, secret: null }]]);
  assert(preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: dir }) === null, 'off darwin the Keychain is never consulted and never blocks');
  setPlatform('darwin');
}

console.log('\nResume path (attach.sh → claude-launch.sh)');
{
  // The resume lane re-execs the launcher directly from a persisted env file — no server decision in the
  // middle — so the launch pre-flight never sees it. These pin the contract that closes that gap without
  // a SECOND implementation of "is this credential readable" living in bash.
  const server = fs.readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8');
  const launcher = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');

  const route = server.slice(server.indexOf("p === '/api/credential-check'"), server.indexOf("p === '/api/resumed'"));
  assert(route.length > 0, 'the server exposes POST /api/credential-check');
  assert(route.includes('sessionSecretOk(session)'), 'the route is gated by the session secret, like every other loopback route');
  assert(route.includes('checkResumeCredentials'), 'the route delegates to the ONE shared readiness check');

  assert(/preflight_credentials\(\)/.test(launcher), 'the launcher defines a resume pre-flight');
  assert(/RESUMED_FROM_ENV" = "1" \] && ! preflight_credentials/.test(launcher),
    'the pre-flight runs on the RESUME lane only — a fresh spawn was already checked server-side');
  // Fail-open is the whole safety argument for putting a network call in front of every resurrection.
  const fn = launcher.slice(launcher.indexOf('preflight_credentials() {'), launcher.indexOf('if [ "$RESUMED_FROM_ENV"'));
  assert((fn.match(/return 0/g) || []).length >= 4, 'every failure mode inside the pre-flight returns 0 (proceed)', `${(fn.match(/return 0/g) || []).length} found`);
  assert(fn.includes('-m 5'), 'the probe is time-bounded, so an unresponsive server cannot hang a resurrection');
  assert(fn.includes('j.ok === false'), 'only an EXPLICIT ok:false refuses — an unparseable answer proceeds');
  assert(/! preflight_credentials; then\n(.|\n)*?exec bash/.test(launcher),
    'a refusal holds the pane open with a shell rather than exiting into ttyd\'s reconnect loop');
}

setPlatform(realPlatform);
child.spawnSync = realSpawnSync;
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
