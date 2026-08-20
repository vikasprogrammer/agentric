#!/usr/bin/env node
/* Guided runtime-account login test — the console-driven `claude login` that produces a credential dir
 * (src/edge/runtime-login.ts). Drives the state machine against a STUB backend with scripted pane
 * output: deterministic, offline, no tmux and no real CLI.
 *
 * The invariant under test: completion is decided by the credential FILE the runtime wrote, never by
 * what was on screen. Screen text only decides when to press Enter and which URL to show — so if the
 * CLI's prompts change, the flow fails closed instead of registering an account that can't launch. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-login-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_UID_ISOLATION;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { RuntimeLoginManager } = require(path.join(ROOT, 'dist/edge/runtime-login.js'));

const aos = loadAgentOS();
const accountsDir = path.join(HOME, 'runtime-accounts');

// ── stub backend: scripted screens in, recorded keystrokes out ───────────────────────────────────
let pane = '';                 // what capturePane returns (null = pane gone)
const typed = [];              // every injectText call
const spawned = [], killed = [];
const backend = {
  spawn: (_s, spec) => spawned.push(spec),
  capturePane: () => pane,
  injectText: (_s, tmux, text, submit, _verify, enterPresses) => { typed.push({ tmux, text, submit, enterPresses }); return true; },
  kill: (_s, tmux) => killed.push(tmux),
};
const audits = [];
const mk = () => new RuntimeLoginManager({ backend, accountsDir, accounts: aos.runtimeAccounts, audit: (type, data) => audits.push({ type, data }) });

const THEME = 'Let\'s get started.\nChoose the text style that looks best with your terminal\n 1. Auto  2. Dark mode';
const METHOD = 'Select login method:\n 1. Claude account with subscription · Pro, Max, Team, or Enterprise\n 2. Anthropic Console account';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference&code_challenge=abc&state=xyz';
const URL_SCREEN = `Browser didn't open? Use the url below to sign in (c to copy)\n${URL}\n Paste code here if prompted >`;
const credFile = (name) => path.join(accountsDir, 'claude-code', name, '.credentials.json');
const writeLogin = (name) => fs.writeFileSync(credFile(name), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'r', expiresAt: Date.now() + 864e5 } }));

console.log('\n\x1b[1m1) The happy path: prompts answered, URL surfaced, code relayed, file registers the account\x1b[0m');
let m = mk();
pane = THEME;
let s = m.start('claude-code', 'overflow-1');
assert(s.phase === 'starting' && spawned.length === 1, 'start() spawns the runtime with its config dir pointed at a fresh dir');
assert(spawned[0].env.CLAUDE_CONFIG_DIR === path.join(accountsDir, 'claude-code', 'overflow-1'), 'the credential dir is inside the tenant home', JSON.stringify(spawned[0].env));
assert(spawned[0].argv.join(' ') === 'claude', 'it runs the vendor CLI alone — no launch script, no task, no gate env', spawned[0].argv.join(' '));
assert(spawned[0].cols >= 600, 'the pane is spawned wide so the CLI does not hard-wrap the authorize URL', String(spawned[0].cols));
assert(fs.existsSync(spawned[0].env.CLAUDE_CONFIG_DIR), 'the dir exists before the CLI needs it');

m.poll(s.id);
assert(typed.length === 1 && typed[0].submit === true, 'the theme prompt is answered by accepting its default');
pane = METHOD;
m.poll(s.id);
assert(typed.length === 2, 'the login-method prompt is answered too');
m.poll(s.id);
assert(typed.length === 2, 'and neither is answered twice, however often the console polls');

pane = URL_SCREEN;
s = m.poll(s.id);
assert(s.phase === 'awaiting-code' && s.url === URL, 'the authorize URL is surfaced for the human', JSON.stringify(s));

s = m.submitCode(s.id, '  code-from-browser#xyz  ');
assert(s.phase === 'exchanging', 'submitting a code moves it to exchanging');
assert(typed[2].text === 'code-from-browser#xyz' && typed[2].submit === true, 'the code is typed into the pane, trimmed', JSON.stringify(typed[2]));
assert(!JSON.stringify(audits).includes('code-from-browser'), 'the one-time code is NEVER audited');

writeLogin('overflow-1');   // the CLI completes the exchange and writes its own credential file
s = m.poll(s.id);
assert(s.phase === 'done', 'the credential file — not the screen — completes the login', JSON.stringify(s));
const acct = aos.runtimeAccounts.get('claude-code', 'overflow-1');
assert(acct && acct.kind === 'oauth' && acct.configDir === path.join(accountsDir, 'claude-code', 'overflow-1'), 'the account is registered as a credential dir', JSON.stringify(acct));
assert(aos.runtimeAccounts.pick('claude-code')?.name === 'overflow-1', 'and it is immediately selectable by the launcher');
assert(killed.length === 1, 'the pane is killed once the login lands');
assert(fs.existsSync(credFile('overflow-1')), 'the credential dir survives (it IS the account)');

console.log('\n\x1b[1m2) Failure modes fail closed — never a registered account that cannot launch\x1b[0m');
m = mk();
pane = URL_SCREEN;
s = m.start('claude-code', 'gone');
pane = null;                 // pane died (CLI exited / crashed)
s = m.poll(s.id);
assert(s.phase === 'failed' && /no longer running/.test(s.error), 'a dead pane fails the login', JSON.stringify(s));
assert(!aos.runtimeAccounts.get('claude-code', 'gone'), 'nothing is registered');
assert(!fs.existsSync(path.join(accountsDir, 'claude-code', 'gone')), 'and the empty credential dir is cleaned up');

// A rejected code is RECOVERABLE, and getting this wrong is what made the live failure self-perpetuating:
// the CLI parks on "Press Enter to retry", and any Enter there re-runs the whole flow with a NEW PKCE
// challenge. So a stray press (the composer's default double-Enter) silently invalidated the link the
// human already had open, and their next code was rejected for a reason nothing on screen explained.
m = mk();
pane = URL_SCREEN;
s = m.start('claude-code', 'badcode');
s = m.poll(s.id);
const beforeSubmit = typed.length;
m.submitCode(s.id, 'nope');
assert(typed[beforeSubmit].enterPresses === 1, 'the code is submitted with exactly ONE Enter — a second lands on the retry prompt and re-arms the flow');
pane = 'OAuth error: Request failed with status code 400\n Press Enter to retry.';
const beforeRetry = typed.length;
s = m.poll(s.id);
assert(s.phase === 'starting' && !s.url, 'a rejected code re-arms the login instead of ending it', JSON.stringify(s));
assert(/rejected/.test(s.notice || ''), 'and says so, telling the human the earlier link is dead', JSON.stringify(s));
assert(s.codeAttempts === 1, 'the rejection is counted');
assert(typed.length === beforeRetry + 1 && typed[beforeRetry].enterPresses === 1, 'exactly one Enter is pressed on the retry prompt');
assert(audits.some((a) => a.type === 'runtime.account.login.code.rejected'), 'the rejection is audited');
// The retry prints a FRESH url — that, not the stale one, is what the console must show.
const URL2 = URL.replace('state=xyz', 'state=fresh2');
pane = `Browser didn't open? Use the url below to sign in (c to copy)\n${URL2}\n Paste code here if prompted >`;
s = m.poll(s.id);
assert(s.phase === 'awaiting-code' && s.url === URL2, 'the fresh link replaces the dead one', JSON.stringify(s));
m.submitCode(s.id, 'nope2');
assert(!m.poll(s.id).notice, 'submitting again clears the stale notice');
// …but it does not loop forever: a code that keeps failing ends with the manual fallback.
for (let i = 0; i < 4 && m.poll(s.id).phase !== 'failed'; i++) {
  pane = 'OAuth error: Request failed with status code 400\n Press Enter to retry.';
  s = m.poll(s.id);
  if (s.phase === 'starting') { pane = URL_SCREEN.replace('state=xyz', `state=r${i}`); s = m.poll(s.id); m.submitCode(s.id, 'nope'); }
}
assert(s.phase === 'failed' && /sign in on the box/.test(s.error), 'repeated rejections stop and hand over the manual path', JSON.stringify(s));
assert(!aos.runtimeAccounts.get('claude-code', 'badcode'), 'nothing is registered from a failed login');

m = mk();
pane = THEME;
s = m.start('claude-code', 'stale');
s = m.poll(s.id);
assert(s.phase !== 'failed', 'a fresh login is not timed out');

// A URL clipped at the pane's wrap point is what a too-narrow pane produced against the real CLI. Sending
// the human to a truncated authorize request would fail in the browser and read as a product bug — so a
// clipped URL is NEVER shown. But a first capture can simply be mid-render, so an incomplete URL waits for
// a whole one rather than failing on sight, and only fails if it stays clipped past the settle window.
m = mk();
pane = URL_SCREEN.replace(URL, URL.slice(0, 90));
s = m.start('claude-code', 'clipped');
s = m.poll(s.id);
assert(s.phase === 'starting' && !s.url, 'a clipped sign-in link is not shown — the poll waits for a whole one', JSON.stringify(s));
m.logins.get(s.id).urlSeenAt -= 9000;   // pretend the settle window elapsed with the URL still clipped
s = m.poll(s.id);
assert(s.phase === 'failed' && /incomplete/.test(s.error), 'a URL that stays clipped past the settle window fails closed', JSON.stringify(s));

// The CLI can print the authorize URL wrapped across rows (e.g. a bordered box whose borders capture-pane
// -J won't rejoin). It must be reassembled to the WHOLE URL, not clipped at the first row's fragment.
m = mk();
pane = [
  "Browser didn't open? Use the url below to sign in (c to copy)",
  '│ ' + URL.slice(0, 70) + '  │',
  '│ ' + URL.slice(70) + '  │',
  ' Paste code here if prompted >',
].join('\n');
s = m.start('claude-code', 'wrapped');
s = m.poll(s.id);
assert(s.phase === 'awaiting-code' && s.url === URL, 'a URL wrapped across rows is reassembled and surfaced whole', JSON.stringify(s));

console.log('\n\x1b[1m2b) macOS keeps the login in the Keychain, not in the dir\x1b[0m');
const { keychainServiceFor, credentialDirHasLogin } = require(path.join(ROOT, 'dist/edge/runtime-account-check.js'));
// Pinned against the real items on a live Mac: claude names the item after sha256(configDir)[0..8]. Get
// this wrong and every Mac login strands — the CLI signs in, and we wait out the grace for a file that
// platform never writes.
assert(keychainServiceFor('/Users/vmini/agent-os-data/instapods/runtime-accounts/claude-code/tools') === 'Claude Code-credentials-3cd0e6be',
  'the Keychain service name is Claude Code-credentials-<sha256(dir)[0..8]>', keychainServiceFor('/tmp'));
assert(keychainServiceFor('/a') !== keychainServiceFor('/b'), 'each config dir gets its own item — which is what makes rotation work on a Mac');
const fileDir = path.join(HOME, 'has-file');
fs.mkdirSync(fileDir, { recursive: true });
fs.writeFileSync(path.join(fileDir, '.credentials.json'), '{}');
assert(credentialDirHasLogin('claude-code', fileDir), 'a dir with the credential file counts as signed in (the Linux shape)');
assert(!credentialDirHasLogin('claude-code', path.join(HOME, 'nothing-here')), 'an empty dir does not');

console.log('\n\x1b[1m3) Guards on what may be started at all\x1b[0m');
m = mk();
const boom = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
assert(/already exists/.test(boom(() => m.start('claude-code', 'overflow-1'))), 'a name already in the pool is refused');
assert(/letters, numbers/.test(boom(() => m.start('claude-code', '../escape'))), 'a name that would escape the accounts dir is refused');
assert(/required/.test(boom(() => m.start('claude-code', '   '))), 'an empty name is refused');
// A dir an account in the pool POINTS AT is refused by name — reusing it would "succeed" instantly
// against that account's credentials without the operator ever seeing the browser step.
fs.mkdirSync(path.join(accountsDir, 'claude-code', 'in-use'), { recursive: true });
writeLogin('in-use');
aos.runtimeAccounts.add({ runtime: 'claude-code', name: 'by-path', kind: 'oauth', configDir: path.join(accountsDir, 'claude-code', 'in-use') });
assert(/"by-path" account/.test(boom(() => m.start('claude-code', 'in-use'))),
  'a dir another account already uses is refused, naming that account', boom(() => m.start('claude-code', 'in-use')));
assert(fs.existsSync(credFile('in-use')), 'and that account\'s credentials are left exactly where they are');

// An ORPHANED login — a dir left behind by an account the operator already removed — must NOT wedge the
// name forever (that dead end could only be cleared by ssh'ing to the box). It is moved aside, not deleted:
// the dir still holds the transcripts of the runs made under it.
fs.mkdirSync(path.join(accountsDir, 'claude-code', 'orphan'), { recursive: true });
writeLogin('orphan');
pane = THEME;
const orphanStart = m.start('claude-code', 'orphan');
assert(orphanStart.phase === 'starting', 'an orphaned credential dir does not block a fresh login under the same name', JSON.stringify(orphanStart));
assert(!fs.existsSync(credFile('orphan')), 'the new dir is clean — the old login cannot complete this flow instantly');
const archived = fs.readdirSync(path.join(accountsDir, 'claude-code')).filter((d) => d.startsWith('orphan.orphan-'));
assert(archived.length === 1 && fs.existsSync(path.join(accountsDir, 'claude-code', archived[0], '.credentials.json')),
  'the orphan is archived beside it, never deleted', JSON.stringify(archived));
assert(audits.some((a) => a.type === 'runtime.account.login.orphan.archived'), 'and the move is audited');
m.cancel(orphanStart.id);

assert(m.supported('codex').ok === false, 'a runtime whose login flow has not been walked is not offered');
assert(m.supported('claude-code').ok === true, 'claude-code is offered');

console.log('\n\x1b[1m3b) A login completes on the platform own storage\x1b[0m');
// The completion check goes through credentialDirHasLogin, so a runtime that stores its login anywhere
// that function recognises finishes the flow. Here: the file shape (portable); the Keychain shape is
// pinned by its service-name vector above, since a test can't write another process's Keychain ACL.
m = mk();
pane = URL_SCREEN;
s = m.start('claude-code', 'stored');
s = m.poll(s.id);
m.submitCode(s.id, 'good-code');
writeLogin('stored');
s = m.poll(s.id);
assert(s.phase === 'done', 'the credential appearing completes the login', JSON.stringify(s));
assert(!!aos.runtimeAccounts.get('claude-code', 'stored'), 'and the account is registered');

console.log('\n\x1b[1m4) Cancel leaves nothing behind\x1b[0m');
m = mk();
pane = THEME;
s = m.start('claude-code', 'abandoned');
const before = killed.length;
m.cancel(s.id);
assert(killed.length === before + 1, 'the pane is killed');
assert(!fs.existsSync(path.join(accountsDir, 'claude-code', 'abandoned')), 'the half-built credential dir is removed');
assert(m.poll(s.id) === null, 'and the login is forgotten');

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail === 0 ? 0 : 1);
