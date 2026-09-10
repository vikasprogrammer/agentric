#!/usr/bin/env node
/* The 2026-09-09 instawp outage, pinned end to end.
 *
 * What happened: one claude conversation was resumed across two credential dirs, so the SAME
 * `<id>.jsonl` existed twice — a live copy under the pooled `tools` account (a $14.93 run that worked)
 * and a stale 19-line copy in the box default `~/.claude` left by an earlier run that had died on
 * `authentication_failed · Login expired`. `findTranscript` searched the server's own dir FIRST and
 * returned the stale one, so teardown read someone else's failure, called `tools`'s token bad and
 * DISABLED it. That emptied the pool; every later session fell back to the box default, whose login
 * really had expired with no refresh token; 14 hours of runs died at $0 and one turn with no alert.
 *
 * Three independent guards, each of which alone would have contained it:
 *   1. findTranscript answers with the copy that describes the run being asked about (preferRoot, else
 *      newest) rather than the first root that happens to have one.
 *   2. transcript evidence older than the run itself is not evidence about that run (readTranscriptEnd
 *      reports the file's mtime).
 *   3. a dead-but-present login is a launch BLOCKER, not a fail-open fallback — expired + no refresh
 *      token is as certain as a locked keychain, and is refused and alerted instead of burning runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-misattrib-test-'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'box-default');
const { findTranscript, registerTranscriptRoot } = require(path.join(ROOT, 'dist/edge/conversation.js'));
const { readTranscriptEnd } = require(path.join(ROOT, 'dist/edge/outcome.js'));
const { credentialReadiness, preflightCredential } = require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));

const CONVO = 'ac6445de-56e1-4d15-9bf5-e6cfb9542415';
const PROJECT = '-home-agents-qa';

/** Write one copy of a conversation under a root, with a chosen last line and mtime. */
const writeCopy = (root, lines, mtimeMs) => {
  const dir = path.join(root, 'projects', PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${CONVO}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
};
const assistant = (text) => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } });

const BOX = path.join(HOME, 'box-default');
const POOL = path.join(HOME, 'accounts', 'tools');

const T_OLD = Date.parse('2026-09-09T14:52:00Z');   // the earlier run, on the box default, that died
const T_RUN_START = Date.parse('2026-09-09T15:07:53Z');
const T_NEW = Date.parse('2026-09-09T15:10:13Z');   // this run, under `tools`, that worked

// The stale copy: an auth death, in the root the server itself resolves from.
writeCopy(BOX, [assistant('Login expired · Please run /login')], T_OLD);
// The live copy: the same conversation resumed under the pool account, ending in real work.
const live = writeCopy(POOL, [assistant('Opened PR #4120 and left the review notes on the ticket. '.repeat(8))], T_NEW);
registerTranscriptRoot(POOL);

console.log('\nWhich copy of a resumed conversation answers for a run');
{
  assert(findTranscript(CONVO, { preferRoot: POOL }) === live,
    'the run\'s own credential dir wins over the server\'s default root', findTranscript(CONVO, { preferRoot: POOL }));
  assert(findTranscript(CONVO) === live,
    'with no preference, the most recently written copy wins (never "first root listed")', findTranscript(CONVO));
  assert(findTranscript(CONVO, { preferRoot: path.join(HOME, 'accounts', 'never-used') }) === live,
    'a preferred root with no copy falls back to newest rather than to nothing');
  assert(findTranscript('00000000-0000-0000-0000-000000000000') === undefined,
    'a conversation with no transcript anywhere is still undefined');
}

console.log('\nStale evidence is not evidence about this run');
{
  const find = (id) => findTranscript(id, { preferRoot: POOL });
  const end = readTranscriptEnd(CONVO, find);
  assert(end && end.died === false, 'the run that actually happened did not die', JSON.stringify(end));

  // Even when only the stale copy is reachable (preferRoot missing), its mtime dates it to before the run.
  const stale = readTranscriptEnd(CONVO, (id) => findTranscript(id, { preferRoot: BOX }));
  assert(stale && stale.died === true && stale.deathKind === 'auth', 'the stale copy does read as an auth death');
  assert(stale && stale.mtimeMs < T_RUN_START,
    'and it is dated BEFORE the run starts, so an attributor can reject it', stale && new Date(stale.mtimeMs).toISOString());
  assert(end && end.mtimeMs >= T_RUN_START, 'while the live copy is dated during the run');
}

console.log('\nA dead-but-present login blocks a launch instead of failing open onto it');
{
  const mkLogin = (name, cred) => {
    const dir = path.join(HOME, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: cred }));
    return dir;
  };
  const past = Date.now() - 60_000, future = Date.now() + 3_600_000;

  // The live instawp box default, verbatim in shape: expired, no refresh token.
  const dead = mkLogin('dead', { accessToken: 'sk-ant-oat01-x', expiresAt: 0 });
  const r = credentialReadiness('claude-code', dead);
  assert(r.ok === false && r.reason === 'expired', 'expired with no refresh token reads as expired, not usable', JSON.stringify(r));
  const b = preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: dead });
  assert(b && b.reason === 'expired' && b.dir === dead, 'and it blocks the launch', JSON.stringify(b));

  const refreshable = mkLogin('refreshable', { accessToken: 'x', expiresAt: past, refreshToken: 'r', refreshTokenExpiresAt: future });
  assert(credentialReadiness('claude-code', refreshable).ok === true,
    'an aged-out access token with a live refresh token is usable — claude renews it on launch');
  assert(preflightCredential('claude-code', { CLAUDE_CONFIG_DIR: refreshable }) === null, 'and never blocks a launch');

  const deadRefresh = mkLogin('dead-refresh', { accessToken: 'x', expiresAt: past, refreshToken: 'r', refreshTokenExpiresAt: past });
  assert(credentialReadiness('claude-code', deadRefresh).reason === 'expired',
    'an expired REFRESH token is dead too — nothing left to trade');

  const noExpiry = mkLogin('no-expiry', { accessToken: 'x' });
  assert(credentialReadiness('claude-code', noExpiry).ok === true,
    'a record that states no expiry is left alone (we only refuse on what the credential itself asserts)');

  assert(preflightCredential('claude-code', { ANTHROPIC_API_KEY: 'sk-ant-x' }) === null,
    'an api-key launch has no dir to be expired');
  assert(credentialReadiness('codex', dead).ok === false,
    'a runtime whose credential shape we cannot read is never called expired on a guess');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
