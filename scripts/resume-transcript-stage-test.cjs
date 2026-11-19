#!/usr/bin/env node
/* Resume-preparation test — a resume must land on an account that can sign in, and find its conversation
 * wherever it ended up on disk.
 *
 * Live incident (instawp, 2026-11-10): a pooled account's login expired, the operator re-added it under the
 * same name, and the guided login moved the old credential dir aside to `<name>.orphan-<ts>` — taking the
 * transcript of a 4-day, 102-turn session with it. `claude --resume` only looks under
 * `$CLAUDE_CONFIG_DIR/projects/`, nothing pointed at the archived dir, so the launcher fell back to
 * `--session-id` and the session re-opened as a BLANK conversation under its own id.
 *
 * Pins: archived dirs are transcript roots; staging copies the conversation into the dir the resume runs
 * under; it never overwrites a copy already there; it never writes outside dirs the server vouches for;
 * and the launcher stages before it resumes. Isolated home; no tmux, no network. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stage-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
// Keep the reader (and any write) away from the developer's real ~/.claude.
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'box-claude');

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const ACCTS = path.join(HOME, 'runtime-accounts', 'claude-code');
const PROJECT = '-home-agent-os-agents-ceo';
const CLAUDE_ID = '22222222-0000-4000-8000-000000000001';
const REAL = ['{"type":"user","message":{"role":"user","content":"turn 1"}}', '{"type":"assistant","message":{"role":"assistant","content":"reply"}}', '{"type":"user","message":{"role":"user","content":"turn 2"}}'].join('\n') + '\n';

const credDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'r', expiresAt: Date.now() + 864e5 } }));
  return dir;
};
const transcriptAt = (dir) => path.join(dir, 'projects', PROJECT, `${CLAUDE_ID}.jsonl`);

// The incident's disk state, built BEFORE the server boots: the old `vikas` dir holding the real
// conversation has been archived, and a fresh `vikas` dir (the re-add) holds a login but no transcript.
const archived = path.join(ACCTS, 'vikas.orphan-1794293493060');
fs.mkdirSync(path.dirname(transcriptAt(archived)), { recursive: true });
fs.writeFileSync(transcriptAt(archived), REAL);
const dirV = credDir(path.join(ACCTS, 'vikas'));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { findTranscript } = require(path.join(ROOT, 'dist/edge/conversation.js'));

const aos = loadAgentOS();
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'vikas', kind: 'oauth', configDir: dirV });
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES ('ses_1','ceo','t','x','aos-ses_1','crashed',0,0,'m_alice',?,'vikas',?,?)")
  .run(CLAUDE_ID, Date.now(), Date.now());
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,created_at,updated_at) VALUES ('ses_2','ceo','t','x','aos-ses_2','crashed',0,0,'m_alice','33333333-0000-4000-8000-000000000009',?,?)")
  .run(Date.now(), Date.now());
const auditTypes = () => aos.db.prepare("SELECT type FROM audit_events WHERE type LIKE 'session.transcript.%'").all().map((r) => r.type);

console.log('\n\x1b[1m1) an archived credential dir is still a transcript root\x1b[0m');
const found = findTranscript(CLAUDE_ID);
assert(found && found.startsWith(archived), 'findTranscript reaches the copy inside `<name>.orphan-<ts>`', String(found));

console.log('\n\x1b[1m2) staging carries the conversation into the dir the resume runs under\x1b[0m');
assert(!fs.existsSync(transcriptAt(dirV)), 'precondition: the re-added dir has no transcript (the blank-resume state)');
assert(tm.stageResumeTranscript('ses_1', dirV) === 'staged', 'stage → staged');
assert(fs.existsSync(transcriptAt(dirV)) && fs.readFileSync(transcriptAt(dirV), 'utf8') === REAL, 'the full conversation is now where `claude --resume` looks');
assert(fs.readFileSync(transcriptAt(archived), 'utf8') === REAL, 'copied, not moved: the archived copy is untouched');
assert(auditTypes().includes('session.transcript.staged'), 'audited session.transcript.staged');

console.log('\n\x1b[1m3) a copy already in the target is never overwritten\x1b[0m');
fs.appendFileSync(transcriptAt(dirV), '{"type":"user","message":{"role":"user","content":"turn 3, made after staging"}}\n');
const before = fs.readFileSync(transcriptAt(dirV), 'utf8');
assert(tm.stageResumeTranscript('ses_1', dirV) === 'present', 'second stage → present');
assert(fs.readFileSync(transcriptAt(dirV), 'utf8') === before, 'the newer turn survives');

console.log('\n\x1b[1m3b) an EMPTY copy in the target does not block staging\x1b[0m');
// Live incident (globex, 2026-11-19): the re-added dir held a copy with no conversation in it, so staging
// answered "present", `claude --resume` said "No conversation found", and the `--session-id` fallback said
// "Session ID … is already in use". The session could not be reopened at all.
const { transcriptHasTurns } = require(path.join(ROOT, 'dist/edge/conversation.js'));
const EMPTY_ID = '44444444-0000-4000-8000-000000000004';
const STUB = '{"type":"permission-mode","permissionMode":"auto"}\n{"type":"file-history-snapshot","snapshot":{}}\n';
const at = (dir, id) => path.join(dir, 'projects', PROJECT, `${id}.jsonl`);
fs.mkdirSync(path.dirname(at(archived, EMPTY_ID)), { recursive: true });
fs.writeFileSync(at(archived, EMPTY_ID), REAL);
fs.writeFileSync(at(dirV, EMPTY_ID), STUB); // newer mtime, in the preferred root
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES ('ses_3','ceo','t','x','aos-ses_3','crashed',0,0,'m_alice',?,'vikas',?,?)")
  .run(EMPTY_ID, Date.now(), Date.now());
assert(!transcriptHasTurns(at(dirV, EMPTY_ID)) && transcriptHasTurns(at(archived, EMPTY_ID)), 'transcriptHasTurns tells the empty copy from the real one');
const pick = findTranscript(EMPTY_ID);
assert(pick && pick.startsWith(archived + path.sep), 'findTranscript skips an empty copy, even the newest one', String(pick));
const pinned = findTranscript(EMPTY_ID, { preferRoot: dirV });
assert(pinned && pinned.startsWith(dirV + path.sep), 'but preferRoot still wins outright (account-blame judges a run by its OWN copy)', String(pinned));
assert(tm.stageResumeTranscript('ses_3', dirV) === 'staged', 'stage over an empty copy → staged');
assert(fs.readFileSync(at(dirV, EMPTY_ID), 'utf8') === REAL, 'the real conversation is now where `claude --resume` looks');
const asideFiles = fs.readdirSync(path.dirname(at(dirV, EMPTY_ID))).filter((f) => f.startsWith(`${EMPTY_ID}.jsonl.empty-`));
assert(asideFiles.length === 1 && fs.readFileSync(path.join(path.dirname(at(dirV, EMPTY_ID)), asideFiles[0]), 'utf8') === STUB, 'the empty copy is set aside, not deleted');
assert(auditTypes().includes('session.transcript.empty-replaced'), 'audited session.transcript.empty-replaced');
assert(tm.stageResumeTranscript('ses_3', dirV) === 'present', 'staging again → present (idempotent)');
// An empty copy with no real one anywhere is left alone — there is nothing better to put there.
const LONE_ID = '55555555-0000-4000-8000-000000000005';
fs.writeFileSync(at(dirV, LONE_ID), STUB);
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES ('ses_4','ceo','t','x','aos-ses_4','crashed',0,0,'m_alice',?,'vikas',?,?)")
  .run(LONE_ID, Date.now(), Date.now());
assert(tm.stageResumeTranscript('ses_4', dirV) === 'present', 'an empty copy with no real one elsewhere → present, untouched');
assert(fs.readFileSync(at(dirV, LONE_ID), 'utf8') === STUB, 'it is not renamed away');
// Empty copies in TWO roots: nothing better exists, so nothing is renamed.
const TWO_ID = '66666666-0000-4000-8000-000000000006';
fs.mkdirSync(path.dirname(at(archived, TWO_ID)), { recursive: true });
fs.writeFileSync(at(dirV, TWO_ID), STUB);
fs.writeFileSync(at(archived, TWO_ID), STUB);
fs.utimesSync(at(archived, TWO_ID), new Date(), new Date(Date.now() + 60e3)); // the OTHER root's empty copy is newest
aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES ('ses_5','ceo','t','x','aos-ses_5','crashed',0,0,'m_alice',?,'vikas',?,?)")
  .run(TWO_ID, Date.now(), Date.now());
assert(tm.stageResumeTranscript('ses_5', dirV) === 'present', 'empty copies in two roots → present');
assert(fs.readFileSync(at(dirV, TWO_ID), 'utf8') === STUB && !fs.readdirSync(path.dirname(at(dirV, TWO_ID))).some((f) => f.startsWith(`${TWO_ID}.jsonl.empty-`)), 'nothing renamed aside');
// An UNREADABLE copy in the target may be the newest real conversation: never set it aside.
if (process.getuid && process.getuid() !== 0) {
  const LOCK_ID = '77777777-0000-4000-8000-000000000007';
  fs.mkdirSync(path.dirname(at(archived, LOCK_ID)), { recursive: true });
  fs.writeFileSync(at(archived, LOCK_ID), REAL);
  fs.writeFileSync(at(dirV, LOCK_ID), REAL + '{"type":"user","message":{"role":"user","content":"newest turn"}}\n');
  fs.utimesSync(at(archived, LOCK_ID), new Date(), new Date(Date.now() + 60e3)); // so the other root's copy is what staging would pick
  fs.chmodSync(at(dirV, LOCK_ID), 0o000);
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES ('ses_6','ceo','t','x','aos-ses_6','crashed',0,0,'m_alice',?,'vikas',?,?)")
    .run(LOCK_ID, Date.now(), Date.now());
  assert(transcriptHasTurns(at(dirV, LOCK_ID)) === undefined, 'an unreadable copy reads as UNKNOWN, not empty');
  assert(tm.stageResumeTranscript('ses_6', dirV) === 'present', 'an unreadable copy in the target → present');
  fs.chmodSync(at(dirV, LOCK_ID), 0o600);
  assert(fs.readFileSync(at(dirV, LOCK_ID), 'utf8').includes('newest turn'), 'and it is left in place, newest turn intact');
} else console.log('  # skip unreadable-copy case under root');

console.log('\n\x1b[1m4) never writes outside a dir the server vouches for\x1b[0m');
const rogue = path.join(HOME, 'somewhere-else');
assert(tm.stageResumeTranscript('ses_1', rogue) === 'skipped', 'a path that is neither a pool dir nor the box default → skipped');
assert(!fs.existsSync(path.join(rogue, 'projects')), 'nothing written there');
assert(tm.stageResumeTranscript('ses_1', '') === 'staged', 'empty configDir = the box default, which IS vouched for');
assert(fs.existsSync(transcriptAt(process.env.CLAUDE_CONFIG_DIR)), 'staged into the box default dir');

console.log('\n\x1b[1m5) nothing to stage is said out loud\x1b[0m');
assert(tm.stageResumeTranscript('ses_2', dirV) === 'missing', 'a conversation found nowhere → missing');
assert(auditTypes().includes('session.transcript.missing'), 'audited session.transcript.missing');
assert(tm.stageResumeTranscript('ses_nope', dirV) === 'skipped', 'unknown session → skipped');

console.log('\n\x1b[1m6) a resume pinned to an account that can no longer sign in moves to one that can\x1b[0m');
const { credentialReadiness } = require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));
const dirT = credDir(path.join(ACCTS, 'tools'));
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'tools', kind: 'oauth', configDir: dirT });
// The incident's re-added dir: a `.credentials.json` holding only MCP-server OAuth — no sign-in at all.
const dirHalf = path.join(ACCTS, 'half');
fs.mkdirSync(dirHalf, { recursive: true });
fs.writeFileSync(path.join(dirHalf, '.credentials.json'), JSON.stringify({ mcpOAuth: { 'some-server': { accessToken: 'x' } } }));
const r0 = credentialReadiness('claude-code', dirHalf);
assert(!r0.ok && r0.reason === 'expired', 'a credentials file with no access/refresh token is NOT a usable login', JSON.stringify(r0));
assert(credentialReadiness('claude-code', dirT).ok, 'a real login still reads as usable');
const envFile = (id) => path.join(aos.paths.connectors, `session-${id}.env`);
const mkResumable = (id, dir, account) => {
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,claude_session_id,runtime_account,created_at,updated_at) VALUES (?,'ceo','t','x',?,'crashed',0,0,'m_alice',?,?,?,?)")
    .run(id, 'aos-' + id, CLAUDE_ID, account, Date.now(), Date.now());
  fs.mkdirSync(aos.paths.connectors, { recursive: true });
  fs.writeFileSync(envFile(id), `export CLAUDE_SESSION_ID='${CLAUDE_ID}'\nexport CLAUDE_CONFIG_DIR='${dir}'\n`);
};
// (a) pinned to a dir no pool account owns any more
const gone = path.join(ACCTS, 'gone');
credDir(gone);
mkResumable('ses_gone', gone, 'gone');
const moved = tm.repinResumeAccount('ses_gone', gone);
assert(moved && fs.realpathSync(moved) !== fs.realpathSync(gone), 'an account removed from the pool → moved', String(moved));
assert(fs.readFileSync(envFile('ses_gone'), 'utf8').includes(moved), 'the persisted launch env now names the new dir (so the NEXT resurrect lands there too)');
assert(aos.db.prepare("SELECT runtime_account a FROM term_sessions WHERE id='ses_gone'").get().a !== 'gone', 'the row names the new account');
const rot = aos.db.prepare("SELECT data FROM audit_events WHERE run_id='ses_gone' AND type='runtime.account.rotated'").get();
assert(rot && JSON.parse(rot.data).reason === 'resume: not in the account pool', 'audited runtime.account.rotated with the reason', rot && rot.data);
// (b) a pool account whose dir holds no sign-in
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'half', kind: 'oauth', configDir: dirHalf });
mkResumable('ses_half', dirHalf, 'half');
const moved2 = tm.repinResumeAccount('ses_half', dirHalf);
assert(moved2 && fs.realpathSync(moved2) !== fs.realpathSync(dirHalf), 'a pool account with no sign-in in its dir → moved', String(moved2));
// (c) healthy and box-default resumes are left alone
mkResumable('ses_ok', dirT, 'tools');
assert(tm.repinResumeAccount('ses_ok', dirT) === null, 'a healthy pinned account → left alone');
assert(fs.readFileSync(envFile('ses_ok'), 'utf8').includes(dirT), 'its env is untouched');
assert(tm.repinResumeAccount('ses_ok', '') === null, 'the box default (no dir) → left alone');

console.log('\n\x1b[1m7) the launcher prepares before the pre-flight and before it resumes, on both lanes\x1b[0m');
const sh = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
const call = sh.indexOf('then prepare_resume; fi');
const preflight = sh.indexOf('! preflight_credentials; then');
assert(call > 0 && call < preflight, 'prepare_resume runs before the credential pre-flight (it can change the dir)');
const lanes = sh.indexOf('if [ "${RESIDENT:-}" = "1" ] || [ "${UNATTENDED:-}" = "1" ]; then');
const firstResume = sh.search(/^\s+claude --resume "\$CLAUDE_SESSION_ID"/m);
assert(call > 0 && call < lanes, 'prepare_resume runs before the unattended/interactive split');
assert(call < firstResume, 'prepare_resume runs before any `claude --resume`');
const rKey = sh.indexOf('    r|R)');
assert(rKey > 0 && /prepare_resume/.test(sh.slice(rKey, sh.indexOf('claude --resume', rKey))), 'the [r] key prepares before it resumes too');
const srv = fs.readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8');
const route = srv.indexOf("p === '/api/resume-prepare'");
assert(route > 0 && srv.slice(route, route + 600).includes('sessionSecretOk(session)'), '/api/resume-prepare is session-secret gated');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
