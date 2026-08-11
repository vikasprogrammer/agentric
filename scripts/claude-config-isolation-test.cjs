#!/usr/bin/env node
/* Per-tenant claude config dir (src/edge/config-isolation.ts) — the thing that keeps the box owner's
 * personal `~/.claude` (plugins, and every subagent / skill / SessionStart hook a plugin brings) from
 * applying to governed runs.
 *
 * Everything asserted here is a way the cure could be worse than the disease. An isolated dir with no
 * credential path hangs an unattended run on the login picker; transcripts written outside the box dir
 * blank the console's conversation view; and clobbering a real file where a symlink is expected throws
 * away whichever token is newer. All three are silent at launch and only show up on a live box, which is
 * exactly why they're pinned here. Also asserts the launcher declares the bypass-mode confirmation for
 * itself — an isolated dir starts with no user settings.json, so inheriting that acceptance is not an
 * option any more. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { isolateClaudeConfig } = require(path.join(ROOT, 'dist/edge/config-isolation.js'));

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfgiso-test-'));
const boxHome = path.join(TMP, 'boxhome');
const tenantHome = path.join(TMP, 'tenant');
const boxDir = path.join(boxHome, '.claude');
fs.mkdirSync(boxDir, { recursive: true });
fs.mkdirSync(tenantHome, { recursive: true });
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: 'box-token' } });
fs.writeFileSync(path.join(boxDir, '.credentials.json'), CREDS);
// The leak this whole change exists to close: a user-scope plugin enabled for the owner's own sessions.
fs.writeFileSync(path.join(boxDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'caveman@caveman': true } }));

console.log('\n\x1b[1m1) An isolated session reads a config layer Agentric owns, not the box owner\x1b[0m');
let r = isolateClaudeConfig(tenantHome, boxHome);
assert(r.isolated === true, 'isolation applies when the box has a credential file', r.reason);
assert(r.dir === path.join(tenantHome, 'claude-config'), 'the dir lives inside the TENANT data home', r.dir);
assert(!fs.existsSync(path.join(r.dir, 'settings.json')), "the owner's user settings — and their enabledPlugins — are NOT in the dir the session will read");

console.log('\n\x1b[1m2) Credentials come along, or an unattended run hangs on the login picker\x1b[0m');
const credLink = path.join(r.dir, '.credentials.json');
assert(fs.lstatSync(credLink).isSymbolicLink(), 'the credential file is a SYMLINK, not a copy (one token, so a refresh can never leave one side stale)');
assert(fs.readFileSync(credLink, 'utf8') === CREDS, 'it resolves to the box credential');
assert(r.credentials === 'linked', 'and reports linked');

console.log('\n\x1b[1m3) No box credential → do NOT isolate (a dead run beats a papercut)\x1b[0m');
const bareBox = path.join(TMP, 'barebox');
fs.mkdirSync(path.join(bareBox, '.claude'), { recursive: true });
const r2 = isolateClaudeConfig(path.join(TMP, 'tenant2'), bareBox);
assert(r2.isolated === false, 'an empty config dir would drop the session on the interactive login picker, so it falls back to the box default');
assert(!fs.existsSync(path.join(TMP, 'tenant2', 'claude-config')), 'and it leaves nothing half-built behind');

console.log('\n\x1b[1m4) Transcripts stay where the SERVER looks for them\x1b[0m');
// conversation.ts resolves transcripts from the server's own env (CLAUDE_CONFIG_DIR || ~/.claude), so a
// session writing them into the tenant dir would blank the conversation view and the hand-off chain.
const projLink = path.join(r.dir, 'projects');
assert(fs.lstatSync(projLink).isSymbolicLink(), 'projects/ is a symlink back to the box config dir');
assert(fs.realpathSync(projLink) === fs.realpathSync(path.join(boxDir, 'projects')), 'pointing at the dir findTranscript() scans', fs.readlinkSync(projLink));
fs.writeFileSync(path.join(projLink, 'session.jsonl'), 'x');
assert(fs.existsSync(path.join(boxDir, 'projects', 'session.jsonl')), 'a transcript written by the session lands in the box dir the server reads');

console.log('\n\x1b[1m5) Re-running is idempotent, and never clobbers something real\x1b[0m');
const again = isolateClaudeConfig(tenantHome, boxHome);
assert(again.isolated === true && again.credentials === 'linked' && again.projects === 'linked', 'a second launch re-links to the same targets');
assert(fs.readFileSync(credLink, 'utf8') === CREDS, 'and the credential still resolves');
// The replaced-symlink case: if claude ever rewrites the credential by temp+rename, our link becomes a
// REAL FILE holding a freshly refreshed token. Re-linking would throw that token away, so it's left alone
// and reported — the caller audits it rather than discovering the divergence a day later.
fs.rmSync(credLink);
fs.writeFileSync(credLink, JSON.stringify({ claudeAiOauth: { accessToken: 'refreshed-in-place' } }));
const detached = isolateClaudeConfig(tenantHome, boxHome);
assert(detached.credentials === 'detached', 'a REAL credential file where the symlink was is reported as detached');
assert(JSON.parse(fs.readFileSync(credLink, 'utf8')).claudeAiOauth.accessToken === 'refreshed-in-place', 'and is left untouched — the newer token survives');

console.log('\n\x1b[1m6) The launcher declares bypass-mode acceptance for itself\x1b[0m');
// An isolated dir has no user settings.json, so the owner's `skipDangerousModePermissionPrompt` no longer
// applies — without this the unattended lane (--dangerously-skip-permissions) parks on a confirmation
// dialog with nobody there to answer it.
const launcher = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
assert(/"skipDangerousModePermissionPrompt":\s*true/.test(launcher), 'aos-settings.json (the --settings layer) sets skipDangerousModePermissionPrompt');

console.log('\n\x1b[1m7) The launch wiring: opt-in, claude-only, and rotation wins\x1b[0m');
{
  // Isolated home — loadAgentOS() with no env resolves to the LIVE ./data home (see CLAUDE.md).
  process.env.AGENT_OS_HOME = path.join(TMP, 'tenant-home');
  process.env.AGENT_OS_TENANT = 'testco';
  delete process.env.AGENT_OS_SECRET_KEY;
  const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(TMP, 'tmux.sock'));
  const apply = (env, runtime = 'claude-code') => { tm.applyConfigIsolation(env, 'ses_iso', 'agent-author', runtime); return env; };

  delete process.env.AOS_CLAUDE_CONFIG_ISOLATION;
  assert(apply({}).CLAUDE_CONFIG_DIR === undefined, 'flag unset → nothing changes (the default is the behaviour every live box has today)');

  process.env.AOS_CLAUDE_CONFIG_ISOLATION = '1';
  const isolated = apply({});
  assert(isolated.CLAUDE_CONFIG_DIR === path.join(process.env.AGENT_OS_HOME, 'claude-config'), 'flag on → the session launches against the tenant config dir', isolated.CLAUDE_CONFIG_DIR);
  const stamped = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'claude.config.isolated'").all().map((r) => JSON.parse(r.data));
  assert(stamped.at(-1)?.credentials === 'linked' && stamped.at(-1)?.projects === 'linked', 'audited with both degradation modes visible', JSON.stringify(stamped.at(-1)));

  // Rotation runs FIRST and a pooled account IS a config dir — overwriting it would launch the run on the
  // wrong account, and the box's credentials rather than the pool's.
  const rotated = apply({ CLAUDE_CONFIG_DIR: '/pool/account-2' });
  assert(rotated.CLAUDE_CONFIG_DIR === '/pool/account-2', 'a rotated credential dir is left alone');

  assert(apply({}, 'codex').CLAUDE_CONFIG_DIR === undefined, 'codex is untouched — it reads a different config dir');
  delete process.env.AOS_CLAUDE_CONFIG_ISOLATION;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
