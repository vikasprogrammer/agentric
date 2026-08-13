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
  injectText: (_s, tmux, text, submit) => { typed.push({ tmux, text, submit }); return true; },
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

m = mk();
pane = URL_SCREEN;
s = m.start('claude-code', 'badcode');
s = m.poll(s.id);
m.submitCode(s.id, 'nope');
pane = 'Invalid code provided. Please try again.';
s = m.poll(s.id);
assert(s.phase === 'failed' && /rejected that code/.test(s.error), 'a rejected code is surfaced instead of waiting out the timeout', JSON.stringify(s));

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

console.log('\n\x1b[1m3) Guards on what may be started at all\x1b[0m');
m = mk();
const boom = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
assert(/already exists/.test(boom(() => m.start('claude-code', 'overflow-1'))), 'a name already in the pool is refused');
assert(/letters, numbers/.test(boom(() => m.start('claude-code', '../escape'))), 'a name that would escape the accounts dir is refused');
assert(/required/.test(boom(() => m.start('claude-code', '   '))), 'an empty name is refused');
fs.mkdirSync(path.join(accountsDir, 'claude-code', 'squatted'), { recursive: true });
writeLogin('squatted');
assert(/already holds a login/.test(boom(() => m.start('claude-code', 'squatted'))),
  'a dir that already holds someone else\'s login is refused (it would "succeed" instantly against the wrong account)');
assert(m.supported('codex').ok === false, 'a runtime whose login flow has not been walked is not offered');
assert(m.supported('claude-code').ok === true, 'claude-code is offered');

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
