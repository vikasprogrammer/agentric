#!/usr/bin/env node
/* Runtime-account pool test — a pooled credential is only ever selected when the runtime's LAUNCH LANE
 * actually authenticates with it, and `term_sessions.runtime_account` is stamped only once that credential
 * is really in the session env.
 *
 * Why this exists: claude honours CLAUDE_CODE_OAUTH_TOKEN in print mode only. The interactive TUI the OS
 * launches ignores it and runs on the box's own ~/.claude login — while the console still showed the pooled
 * account as selected. Every session on the globex box drained one exhausted account for a day that way
 * (2026-08-04). The invariant here is: no selection the launcher can't honour, and no stamp without an
 * applied credential. Isolated home; no tmux, no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rtacct-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { CODING_RUNTIMES } = require(path.join(ROOT, 'dist/types.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const store = aos.runtimeAccounts;

// A credential dir that holds a real login, and one that is just an empty path.
const goodDir = path.join(HOME, 'cred-good');
fs.mkdirSync(goodDir, { recursive: true });
fs.writeFileSync(path.join(goodDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-test', refreshToken: 'r', expiresAt: Date.now() + 864e5 } }));
const emptyDir = path.join(HOME, 'cred-empty');
fs.mkdirSync(emptyDir, { recursive: true });

const reset = () => { for (const a of store.list()) store.remove(a.runtime, a.name); };
let n = 0;
const mkSession = () => {
  const id = 'ts_' + (++n);
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',1,0,'m_alice',?,?)")
    .run(id, 'website-bot', 't', 'x', 'aos-' + id, Date.now(), Date.now());
  return id;
};
const stampOf = (id) => aos.db.prepare('SELECT runtime_account a FROM term_sessions WHERE id=?').get(id).a;
// applyRuntimeAccount is private in TS; the compiled method is what the launcher calls on every spawn.
const apply = (env, sessionId, runtime, resident) => tm.applyRuntimeAccount(env, sessionId, 'website-bot', runtime, !!resident);
// Audit assertions read only rows written SINCE the mark — a stale row from an earlier case would
// otherwise satisfy (or falsify) the next one.
const auditMark = () => aos.db.prepare('SELECT MAX(id) m FROM audit_events').get().m ?? 0;
const auditSince = (m) => aos.db.prepare('SELECT type FROM audit_events WHERE id > ?').all(m).map((r) => r.type);

console.log('\n\x1b[1m1) The spec declares what a runtime can actually launch with\x1b[0m');
assert(JSON.stringify(CODING_RUNTIMES['claude-code'].liveCredentialKinds) === '["oauth"]',
  'claude-code is credential-dir only (its TUI ignores an injected token)');
assert(!!CODING_RUNTIMES['claude-code'].credentialEnv.tokenVar,
  'tokenVar stays declared (print-mode probe still uses it) even though no lane launches with it');
assert(CODING_RUNTIMES.codex.liveCredentialKinds.includes('apikey'),
  'codex keeps its api-key lane (the launcher wires it itself)');

console.log('\n\x1b[1m2) pick() never hands back a kind the lane cannot authenticate\x1b[0m');
reset();
aos.secrets.set(aos.tenant, 'runtime-token:claude-code:tok', 'sk-ant-oat01-x', { principal: '*' });
store.add({ runtime: 'claude-code', name: 'tok', kind: 'token', apiKeyRef: 'runtime-token:claude-code:tok' });
assert(store.pick('claude-code') === null, 'a token-only claude pool is unselectable (→ box default)');
assert(store.enabledCount('claude-code') === 0 && store.enabledCount('claude-code', { anyKind: true }) === 1,
  'enabledCount separates "no usable account" from "no pool at all"');
store.add({ runtime: 'claude-code', name: 'dir', kind: 'oauth', configDir: goodDir });
assert(store.pick('claude-code')?.name === 'dir', 'the credential-dir account is picked');
assert(store.pick('claude-code', Date.now(), { kinds: ['oauth', 'apikey'] })?.name === 'dir',
  'a resident launch narrows further and still gets the dir');
store.markLimited('claude-code', 'dir', Date.now() + 3600_000);
assert(store.pick('claude-code') === null, 'with the dir limited, the available token account is NOT a fallback');
assert(store.allLimited('claude-code').limited === true,
  'allLimited ignores the unusable token row, so the scheduler defers instead of spawning onto the box account');

console.log('\n\x1b[1m3) A stamp means the credential really went into the env\x1b[0m');
reset();
store.add({ runtime: 'claude-code', name: 'dir', kind: 'oauth', configDir: goodDir });
let env = {}; let sid = mkSession();
apply(env, sid, 'claude-code', false);
assert(env.CLAUDE_CONFIG_DIR === goodDir, 'a good credential dir is exported as CLAUDE_CONFIG_DIR');
assert(stampOf(sid) === 'dir', 'and the session records which account it ran on');

reset();
store.add({ runtime: 'claude-code', name: 'nologin', kind: 'oauth', configDir: emptyDir });
env = {}; sid = mkSession(); let mark = auditMark();
apply(env, sid, 'claude-code', false);
assert(env.CLAUDE_CONFIG_DIR === undefined, 'a dir with no .credentials.json is refused (it would hang on the login picker)');
assert(stampOf(sid) === null, 'and nothing is stamped');
assert(auditSince(mark).includes('runtime.account.unresolved'), 'the skip is audited');

reset();
store.add({ runtime: 'claude-code', name: 'tok', kind: 'token', apiKeyRef: 'runtime-token:claude-code:tok' });
env = {}; sid = mkSession(); mark = auditMark();
apply(env, sid, 'claude-code', false);
assert(env.CLAUDE_CODE_OAUTH_TOKEN === undefined && env.CLAUDE_CONFIG_DIR === undefined,
  'a token account injects nothing — the run falls through to the box default');
assert(stampOf(sid) === null, 'and is NOT stamped as the account the run used');
assert(auditSince(mark).includes('runtime.account.unusable'),
  'a configured-but-unusable pool is audited, not silently ignored like an empty one');

reset();
env = {}; sid = mkSession(); mark = auditMark();
apply(env, sid, 'claude-code', false);
assert(!auditSince(mark).includes('runtime.account.unusable'), 'an EMPTY pool stays silent (rotation is inert by design)');

console.log('\n\x1b[1m4) Other runtimes keep their own lanes\x1b[0m');
reset();
aos.secrets.set(aos.tenant, 'openai-key', 'sk-openai-test', { principal: '*' });
store.add({ runtime: 'codex', name: 'key', kind: 'apikey', apiKeyRef: 'openai-key' });
env = {}; sid = mkSession();
apply(env, sid, 'codex', false);
assert(env.OPENAI_API_KEY === 'sk-openai-test', 'a codex api-key account still applies');
assert(stampOf(sid) === 'key', 'and is stamped');

// ── 5) the add-time guardrail, over real HTTP ────────────────────────────────────────────────────
// A credential the launcher can't use must be refused where the operator can still act on it, not
// accepted and then quietly ignored. Both refusals return before any provider probe, so this stays offline.
(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const rt = registry.get('testco');
  const { token } = rt.os.team.invite({ email: 'owner2@test', role: 'owner' });
  const cookie = `aos_sid=${rt.os.team.acceptToken(token).sid}`;
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const add = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/runtime-accounts`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  console.log('\n\x1b[1m5) Adding a credential the launcher cannot use is refused up front\x1b[0m');
  let r = await add({ runtime: 'claude-code', name: 'pasted', kind: 'token', token: 'sk-ant-oat01-whatever' });
  assert(r.status === 400 && /print mode/.test(r.body.error || ''), 'a pasted claude subscription token is rejected', JSON.stringify(r));
  assert(/claude login/.test(r.body.error || ''), 'and the error hands over the exact command that works', r.body.error);
  r = await add({ runtime: 'claude-code', name: 'nologin', kind: 'oauth', configDir: emptyDir });
  assert(r.status === 400 && /\.credentials\.json/.test(r.body.error || ''), 'a credential dir with no login in it is rejected', JSON.stringify(r));
  assert(rt.os.runtimeAccounts.list().filter((a) => a.runtime === 'claude-code').length === 0, 'neither attempt left a row behind');

  server.close();
  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(fail === 0 ? 0 : 1);
})();
