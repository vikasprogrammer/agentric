#!/usr/bin/env node
/* CLI link-origin test.
 *
 * `agent-os invite` / `login-link` / `tenant create` print a magic link, and they are the recovery path
 * of last resort — the one that still works when NO chat platform is connected and the console's own
 * "email me a link" button has nowhere to deliver. They built that link from a hardcoded
 * `http://127.0.0.1:$PORT`, ignoring `AGENT_OS_PUBLIC_URL` / config `publicUrl`, so the link an operator
 * pasted to a locked-out teammate pointed at the teammate's OWN loopback and silently 404'd or, worse,
 * hit some unrelated local service. Pins that the CLI resolves the origin the way
 * `TenantRegistry.consoleOrigin` does. Isolated home; the CLI is spawned as a real process. */
const fs = require('fs'); const osMod = require('os'); const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(osMod.tmpdir(), 'aos-cli-link-test-'));
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const cli = (args, env) => execFileSync(process.execPath, [path.join(ROOT, 'dist/cli.js'), ...args], {
  encoding: 'utf8',
  env: { ...process.env, AGENT_OS_HOME: HOME, AGENT_OS_TENANT: 'testco', AOS_NO_TTYD: '1', ...env },
}).trim();

const PUBLIC = 'https://box.example.ts.net:8443';

console.log('\n\x1b[1m1) invite honours AGENT_OS_PUBLIC_URL\x1b[0m');
const invited = cli(['invite', 'tina@x.io', 'admin'], { AGENT_OS_PUBLIC_URL: PUBLIC });
assert(invited.includes(`${PUBLIC}/accept?token=`), 'invite link carries the pinned origin', invited);
assert(!/127\.0\.0\.1|localhost/.test(invited), 'and no loopback host survives', invited);

console.log('\n\x1b[1m2) login-link (the no-chat recovery path) honours it too\x1b[0m');
const link = cli(['login-link', 'tina@x.io'], { AGENT_OS_PUBLIC_URL: PUBLIC });
assert(link.includes(`${PUBLIC}/accept?token=`), 'login link carries the pinned origin', link);

console.log('\n\x1b[1m3) a trailing slash is normalised, not doubled\x1b[0m');
const slashed = cli(['login-link', 'tina@x.io'], { AGENT_OS_PUBLIC_URL: `${PUBLIC}/` });
assert(slashed.includes(`${PUBLIC}/accept?token=`) && !slashed.includes('//accept'), 'no `//accept`', slashed);

console.log('\n\x1b[1m4) unset → the loopback fallback still works (dev)\x1b[0m');
const local = cli(['login-link', 'tina@x.io'], { AGENT_OS_PUBLIC_URL: '', PORT: '3999' });
assert(local.includes('http://127.0.0.1:3999/accept?token='), 'falls back to 127.0.0.1:$PORT', local);

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
