#!/usr/bin/env node
/* Rotate-on-reload test — reloading a session onto ANOTHER pooled account must actually move it, and must
 * not cost the user the conversation.
 *
 * Why this exists: credentials bind ONCE, at launch — `applyRuntimeAccount` writes them into
 * `session-<id>.env` and `attach.sh` replays that same file on every resurrect. So a plain Reload always
 * comes back on the account that just hit its limit, which reads as "rotation is broken" (2026-08-13,
 * globex: two of three pooled accounts limited, every reload landing back on the limited one). The fix is
 * an explicit rotate, and it has two failure modes worth pinning:
 *   1. the env file still naming the old account (rotation that didn't rotate), and
 *   2. claude coming up with "No conversation found with session ID …" — each pooled account is a whole
 *      CONFIG DIR with its OWN `projects/`, so a resume under a different dir can't see the transcript
 *      unless it is carried across.
 * Isolated home; no tmux, no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-rotate-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
// The transcript reader falls back to the SERVER's own config dir; point it somewhere empty so the test
// can never accidentally read (or write into) the developer's real ~/.claude.
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'box-claude');

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { findTranscript, registerTranscriptRoot } = require(path.join(ROOT, 'dist/edge/conversation.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const store = aos.runtimeAccounts;

/** A credential dir that looks logged-in — `credentialDirHasLogin` requires the FILE, not just the path. */
const credDir = (name) => {
  const dir = path.join(HOME, 'accounts', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-' + name, refreshToken: 'r', expiresAt: Date.now() + 864e5 } }));
  return dir;
};
const dirA = credDir('acct-a');
const dirB = credDir('acct-b');

const PROJECT = '-home-agent-os-agents-website-bot'; // claude's escaped-cwd project dir name
/** Write a transcript where a session launched under `dir` would have written it. */
const seedTranscript = (dir, claudeId) => {
  const d = path.join(dir, 'projects', PROJECT);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${claudeId}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  return path.join(d, `${claudeId}.jsonl`);
};

let n = 0;
/** A resumable session: a DB row + the persisted launch env attach.sh replays. */
const mkSession = (account, envExtra = '') => {
  const id = 'ts_' + (++n);
  const claudeId = `11111111-0000-4000-8000-00000000000${n}`;
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES (?,?,?,?,?,'running',0,0,'m_alice',?,?,?,?)")
    .run(id, 'website-bot', 't', 'x', 'aos-' + id, claudeId, account, Date.now(), Date.now());
  fs.mkdirSync(aos.paths.connectors, { recursive: true });
  fs.writeFileSync(path.join(aos.paths.connectors, `session-${id}.env`),
    `export AGENT_DIR='/tmp/agent'\nexport CLAUDE_SESSION_ID='${claudeId}'\nexport CLAUDE_CONFIG_DIR='${account === 'a' ? dirA : dirB}'\n${envExtra}`);
  return { id, claudeId };
};
const envOf = (id) => fs.readFileSync(path.join(aos.paths.connectors, `session-${id}.env`), 'utf8');
const acctOf = (id) => aos.db.prepare('SELECT runtime_account a FROM term_sessions WHERE id=?').get(id).a;
const auditMark = () => aos.db.prepare('SELECT MAX(id) m FROM audit_events').get().m ?? 0;
const auditSince = (m) => aos.db.prepare('SELECT type FROM audit_events WHERE id > ?').all(m).map((r) => r.type);
const reset = () => { for (const a of store.list()) store.remove(a.runtime, a.name); };

console.log('\n\x1b[1m1) pick(exclude) is what makes a rotation a rotation\x1b[0m');
reset();
store.add({ runtime: 'claude-code', name: 'a', kind: 'oauth', configDir: dirA });
store.add({ runtime: 'claude-code', name: 'b', kind: 'oauth', configDir: dirB });
assert(store.pick('claude-code', Date.now(), { exclude: 'a' })?.name === 'b', 'excluding the current account hands back the other one');
store.markLimited('claude-code', 'b', Date.now() + 6e5);
assert(store.pick('claude-code', Date.now(), { exclude: 'a' }) === null,
  'no OTHER account free → null (never silently re-picks the account we are rotating away from)');
assert(store.pick('claude-code')?.name === 'a', 'without exclude the same pool still selects normally');
assert(store.allLimited('claude-code').limited === false, 'allLimited stays false while one account is available');

console.log('\n\x1b[1m2) A rotated session\'s transcript is findable at all\x1b[0m');
const orphan = '22222222-0000-4000-8000-000000000001';
seedTranscript(dirB, orphan);
assert(findTranscript(orphan) === undefined, 'a pooled account dir is invisible until it is registered (the old blank-conversation bug)');
registerTranscriptRoot(dirB);
assert(findTranscript(orphan)?.startsWith(dirB), 'once registered, the reader finds transcripts written under a pooled account');

console.log('\n\x1b[1m3) Reload WITHOUT rotate keeps the account (the behaviour that surprised us)\x1b[0m');
reset();
store.add({ runtime: 'claude-code', name: 'a', kind: 'oauth', configDir: dirA });
store.add({ runtime: 'claude-code', name: 'b', kind: 'oauth', configDir: dirB });
const plain = mkSession('a');
seedTranscript(dirA, plain.claudeId);
const plainRes = tm.reloadSession(plain.id, 'me@example.com');
assert(plainRes.ok && !plainRes.account, 'plain reload reports no account change');
assert(envOf(plain.id).includes(`CLAUDE_CONFIG_DIR='${dirA}'`), 'the persisted launch env still names the ORIGINAL account dir');
assert(acctOf(plain.id) === 'a', 'the session row still points at the original account');

console.log('\n\x1b[1m4) Reload WITH rotate moves the account and carries the conversation\x1b[0m');
const rot = mkSession('a', "export ANTHROPIC_API_KEY='stale-key'\nexport CLAUDE_CODE_OAUTH_TOKEN='stale-token'\n");
const srcFile = seedTranscript(dirA, rot.claudeId);
const mark = auditMark();
const res = tm.reloadSession(rot.id, 'me@example.com', { rotate: true });
assert(res.ok && res.account === 'b', `rotated onto the other account (got ${JSON.stringify(res)})`);
assert(envOf(rot.id).includes(`CLAUDE_CONFIG_DIR='${dirB}'`), 'the launch env attach.sh replays now names the NEW account dir');
assert(!envOf(rot.id).includes(dirA), 'no trace of the old credential dir is left in the env file');
assert(!/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/.test(envOf(rot.id)),
  'stale credential vars of OTHER kinds are stripped (a leftover key would be preferred over the new dir)');
assert(envOf(rot.id).includes("AGENT_DIR='/tmp/agent'"), 'non-credential launch env (AGENT_DIR, CLAUDE_SESSION_ID) survives the rewrite');
assert(envOf(rot.id).includes(`CLAUDE_SESSION_ID='${rot.claudeId}'`), 'the same claude session id is resumed — it is the SAME conversation');
assert(fs.existsSync(path.join(dirB, 'projects', PROJECT, `${rot.claudeId}.jsonl`)),
  'the transcript is now under the new account, so `claude --resume` can find it');
assert(fs.existsSync(srcFile), 'the original account keeps its copy (copied, not moved — a half-done rotation loses nothing)');
assert(acctOf(rot.id) === 'b', 'the session row is stamped with the account it will actually run under');
assert(auditSince(mark).includes('runtime.account.rotated'), 'the move is audited');

console.log('\n\x1b[1m5) Nowhere to rotate → an honest note, and nothing is touched\x1b[0m');
store.markLimited('claude-code', 'a', Date.now() + 6e5);
const stuck = mkSession('b');
seedTranscript(dirB, stuck.claudeId);
const stuckRes = tm.reloadSession(stuck.id, 'me@example.com', { rotate: true });
assert(stuckRes.ok && !stuckRes.account && !!stuckRes.note, `the reload still happens, with a reason (got ${JSON.stringify(stuckRes)})`);
assert(envOf(stuck.id).includes(`CLAUDE_CONFIG_DIR='${dirB}'`), 'a failed rotation leaves the launch env exactly as it was');
assert(acctOf(stuck.id) === 'b', 'and leaves the stamped account alone');

console.log('\n\x1b[1m6) No pool at all → rotation is inert, not an error\x1b[0m');
reset();
const nopool = mkSession('a');
const nopoolRes = tm.reloadSession(nopool.id, 'me@example.com', { rotate: true });
assert(nopoolRes.ok && !nopoolRes.account && /pool/.test(nopoolRes.note || ''), 'says there is no pool rather than failing the reload');

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
