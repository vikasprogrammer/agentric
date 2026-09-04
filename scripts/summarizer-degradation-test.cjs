#!/usr/bin/env node
/* The out-of-band session summarizer: pool credentials, a reported reason, and an alert when it degrades.
 *
 * ROOT CAUSE this pins. `summarizeConversation` spawns a throwaway `claude -p` and, when that fails,
 * returns a deterministic recap instead. It ran on `{...process.env}` — i.e. always the BOX DEFAULT
 * account — while every governed launch goes through `applyRuntimeAccount` → `runtimeAccounts.pick()`
 * and rotates off an exhausted one. On live instawp that split degraded the feature for three weeks:
 * `runtime.usage_limited` ran 2026-07-30 → 08-15, `runtime.account.limited` from 08-04, and across that
 * band 43 of 97 `session.summarized` events came back `via:'fallback'` while sessions kept working fine.
 * The failure reason was discarded by a bare `catch {}`, so nothing said why, and nothing alerted.
 *
 * Pins: the resolver skips a LIMITED account (the actual fix — `pick()` is what rotates); it fails OPEN
 * when the pool is empty or unusable, so this call never breaks; a fallback carries a classified
 * `reason`; and the alert has a denominator, a sample floor and a present-tense window — it stays quiet
 * on a small sample and on a healthy rate, and names the dominant cause when it does fire.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-summarizer-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 250) : ''}`));

const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
const { summarizeConversation, classify } = require(path.join(ROOT, 'dist/edge/summarize.js'));
const { detectAlerts } = require(path.join(ROOT, 'dist/edge/alerts.js'));

const DAY = 24 * 3600_000;

(async () => {
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const { os: aos, tm } = registry.get('testco');

  // ── 1. the resolver routes around a limited account ──────────────────────────────────────────────
  assert(tm.outOfBandCredentialEnv() === null, 'an empty pool fails open — the caller keeps the box default');

  // claude-code's `liveCredentialKinds` is ['oauth'] — only a credential DIR is ever picked for it, so a
  // pool account here is a dir holding a real `.credentials.json` (an empty dir is deliberately refused:
  // it drops a run onto the interactive login picker rather than falling back).
  const dirFor = (name) => {
    const d = path.join(HOME, 'accounts', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-' + name } }));
    return d;
  };
  aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'acct-a', kind: 'oauth', configDir: dirFor('acct-a') });

  const picked = tm.outOfBandCredentialEnv();
  assert(picked && picked.account === 'acct-a', 'a healthy pool account is selected for the out-of-band call', picked);
  assert(picked && picked.vars.CLAUDE_CONFIG_DIR === path.join(HOME, 'accounts', 'acct-a'), 'its credential dir is resolved into env vars', picked && picked.vars);

  // THE fix: a limited account must not be handed to the summarizer. This is the exact condition that
  // degraded instawp for three weeks — sessions rotated away from it, this call did not.
  aos.runtimeAccounts.markLimited('claude-code', 'acct-a', Date.now() + DAY);
  assert(tm.outOfBandCredentialEnv() === null, 'a LIMITED account is skipped — the call no longer rides an exhausted credential');

  aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'acct-b', kind: 'oauth', configDir: dirFor('acct-b') });
  const rotated = tm.outOfBandCredentialEnv();
  assert(rotated && rotated.account === 'acct-b', 'it rotates to the healthy account instead', rotated);

  // ── 2. a fallback says WHY ───────────────────────────────────────────────────────────────────────
  const convo = { found: true, turns: [{ kind: 'user', text: 'do the thing', ts: Date.now() }, { kind: 'assistant', text: 'done', ts: Date.now() }] };
  // Force a real ENOENT: runClaude prepends `$HOME/.local/bin` to PATH, so BOTH have to point somewhere
  // without a `claude` on it, or this machine's own install answers and the assertion tests nothing.
  const realPath = process.env.PATH, realHome = process.env.HOME;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-empty-path-'));
  process.env.PATH = empty;
  process.env.HOME = empty;
  const out = await summarizeConversation(convo, { account: 'acct-b' });
  process.env.PATH = realPath;
  process.env.HOME = realHome;
  assert(out.via === 'fallback', 'an unrunnable CLI still returns a usable summary', out.via);
  assert(out.reason === 'not_installed', 'and reports a classified reason instead of swallowing it', out.reason);
  assert(out.account === 'acct-b', 'the account it ran under is carried on the result', out.account);
  assert(typeof out.summary === 'string' && out.summary.length > 0, 'the deterministic recap is non-empty');

  // `usage_limit` is the classification the alert acts on — the quota refusal arrives as CLI OUTPUT with
  // an unremarkable exit, so the text scan is the only thing standing between a rotation problem and
  // another silent three weeks.
  assert(classify({ stderr: "Claude usage limit reached. Your limit will reset at 3pm." }) === 'usage_limit', 'a quota refusal on stderr classifies as usage_limit');
  assert(classify({ stdout: "You've hit your weekly limit for Claude Opus." }) === 'usage_limit', 'the same refusal on stdout classifies as usage_limit');
  assert(classify({ code: 'ENOENT' }) === 'not_installed', 'a missing binary classifies as not_installed');
  assert(classify({ killed: true, signal: 'SIGTERM' }) === 'timeout', 'the 90s ceiling classifies as timeout');
  assert(classify({ stderr: 'Invalid API key · Please run /login' }) === 'auth', 'a rejected credential classifies as auth');
  assert(classify({ stderr: 'segfault' }) === 'error', 'anything unrecognised stays a plain error, never a guess');

  const nothing = await summarizeConversation({ found: false, turns: [] });
  assert(nothing.found === false && nothing.reason === undefined, 'no transcript is not a failure — no reason is invented', nothing);

  // ── 3. the alert: denominator, sample floor, present-tense window ────────────────────────────────
  const ev = (ago, via, reason, found = true) => aos.db
    .prepare("INSERT INTO audit_events (ts, run_id, tenant, principal, type, data) VALUES (?,?,?,?,?,?)")
    .run(Date.now() - ago, 'ses_x', aos.tenant, 'agent:qa', 'session.summarized', JSON.stringify({ via, found, reason }));
  const alertNow = () => detectAlerts(aos, Date.now()).find((a) => a.key.startsWith('summarizer-degraded'));

  ev(1 * DAY, 'fallback', 'usage_limit');
  ev(1 * DAY, 'fallback', 'usage_limit');
  assert(!alertNow(), 'two failures is not a signal — below the sample floor it stays quiet');

  for (let i = 0; i < 3; i++) ev(1 * DAY, 'fallback', 'usage_limit');
  const hot = alertNow();
  assert(!!hot, 'past the sample floor a 100% fallback rate alerts', hot && hot.key);
  assert(hot && hot.key === 'summarizer-degraded:usage_limit', 'the dominant reason rides the key, so a different cause re-alerts', hot && hot.key);
  assert(hot && /quota/i.test(hot.body) && /Runtime accounts/.test(hot.body), 'the body names the cause and where to fix it');

  // A healthy majority must clear it — the rate needs a real denominator, not a count of failures.
  for (let i = 0; i < 12; i++) ev(1 * DAY, 'ai', undefined);
  assert(!alertNow(), 'a healthy success majority clears the alert (rate over attempts, not raw failures)');

  // An alert claims the PRESENT: the same failures outside the window must not keep it firing.
  aos.db.prepare("DELETE FROM audit_events WHERE type = 'session.summarized'").run();
  for (let i = 0; i < 6; i++) ev(30 * DAY, 'fallback', 'usage_limit');
  assert(!alertNow(), 'a resolved outage stops alerting once it falls out of the 7-day window');

  // "Nothing to summarize" must never count toward the rate.
  aos.db.prepare("DELETE FROM audit_events WHERE type = 'session.summarized'").run();
  for (let i = 0; i < 8; i++) ev(1 * DAY, 'fallback', undefined, false);
  assert(!alertNow(), 'runs with no transcript are excluded from the denominator');

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
