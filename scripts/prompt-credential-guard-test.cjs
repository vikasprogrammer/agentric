#!/usr/bin/env node
/* Human-typed credential guard + commit attribution setting (fleet-insights 2026-10-26).
 * (1) detectPastedCredential — vendor/labelled shapes held, look-alikes (shas, UUIDs, URL slugs, masked
 *     values, env-var references) let through, `[allow-secret]` overrides;
 * (2) TerminalManager.holdHumanPrompt — holds a human prompt, audits KIND only (never the value), and never
 *     holds text the server itself delivered (the launch task, a pane injection);
 * (3) terminal/lifecycle-hook.sh — prints claude's `decision: block` only when the server says hold, and
 *     lets the prompt through when the server is unreachable (run under the system bash: 3.2 on macOS);
 * (4) commit attribution — default keeps the session-link brief, `none` swaps it and is stored.
 * Isolated home; no tmux. Every "credential" below is synthetic. */
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cred-guard-test-'));
process.env.AGENT_OS_HOME = HOME; process.env.AGENT_OS_TENANT = 'testco'; process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { detectPastedCredential, credentialHoldMessage, ALLOW_SECRET_MARKER } = require(path.join(ROOT, 'dist/governance/prompt-secrets.js'));

(async () => {
  console.log('\n\x1b[1m1) detectPastedCredential\x1b[0m');
  const fake = (n, set = 'Ab1') => Array.from({ length: n }, (_, i) => set[i % set.length]).join('');
  const held = [
    ['openrouter', `key store -> sk-or-v1-${fake(64, 'a1b2c3')}`],
    ['anthropic', `use sk-ant-api03-${fake(40)} for it`],
    ['openai', `sk-proj-${fake(48)}`],
    ['github', `export GH_TOKEN=ghp_${fake(36)}`],
    ['slack', `xoxb-${fake(12, '1234')}-${fake(24)}`],
    ['aws', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['stripe', `sk_live_${fake(24)}`],
    ['google api key', 'AIza' + fake(35)],
    ['linkedin secret', `ln app abc123, WPL_AP1.${fake(16)}`],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----'],
    ['env-style', `OPENROUTER_API_KEY=${fake(30)}`],
    ['prose password', 'the wp admin password: Hunter2!Hunter2'],
    ['access token, no separator', `access token ${fake(40)}`],
  ];
  for (const [name, text] of held) assert(detectPastedCredential(text) !== null, `held: ${name}`, JSON.stringify(detectPastedCredential(text)));
  const passed = [
    ['commit sha', 'merge 4f9d2e81c07b3a5566e1d9f0a2b4c6e8d1f3a5b7 into main'],
    ['uuid', 'session 3b8f6c2a-91d4-4e7a-b0c5-7d2e9f1a6b34 is stuck'],
    ['product URL slug starting sk-', 'https://shop.example.com/products/sk-129-pu-salon-chair-with-gold-finish-and-hydraulic-pump'],
    ['password as a word', 'the password reset email never arrives'],
    ['env reference', 'export GH_TOKEN=$GH_TOKEN and retry'],
    ['masked value', 'ADMIN_PASSWORD dzM***************** is set'],
    ['placeholder', 'API_KEY=<your-key-here>'],
    ['token talk', 'my GitHub token has expired, refresh it'],
    ['clickup id', 'check https://app.clickup.com/t/9000001/abc123xyz please'],
    ['plain chat', 'send 15 from ana@ and 10 from sales@'],
  ];
  for (const [name, text] of passed) assert(detectPastedCredential(text) === null, `passed: ${name}`, JSON.stringify(detectPastedCredential(text)));
  assert(detectPastedCredential(`${ALLOW_SECRET_MARKER} sk-or-v1-${fake(64, 'a1b2')}`) === null, `${ALLOW_SECRET_MARKER} sends it as-is`);
  const msg = credentialHoldMessage('OpenRouter API key', 'social-media');
  assert(/Settings → Secrets/.test(msg) && /secret_request/.test(msg) && msg.includes(ALLOW_SECRET_MARKER), 'hold message names the safe path + the override');

  console.log('\n\x1b[1m2) TerminalManager.holdHumanPrompt\x1b[0m');
  const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
  const { TerminalManager, commitAttributionBrief } = require(path.join(ROOT, 'dist/terminal.js'));
  const aos = loadAgentOS();
  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  const typed = [];
  tm.backend.aliveNames = () => new Set(['aos-ts_1']);
  tm.backend.hasClient = () => true;
  tm.backend.injectText = (_s, _t, text) => { typed.push(text); return true; };
  const key = `sk-or-v1-${fake(64, 'a1b2c3')}`;
  const task = `Ingest this webhook. Customer wrote: WP Password: Puddin${fake(10)}!`;
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,run_as,spawned_by,created_at,updated_at) VALUES ('ts_1','social-media','t',?,'aos-ts_1','running',0,0,'m_alice','m_alice',?,?)").run(task, Date.now(), Date.now());

  const hold = tm.holdHumanPrompt('ts_1', `Let's use OpenRouter. key store -> ${key}`, 'tui');
  assert(typeof hold === 'string' && /OpenRouter API key/.test(hold), 'a pasted key in the TUI is held, naming its kind');
  const row = aos.db.prepare("SELECT data FROM audit_events WHERE type='prompt.credential.held' ORDER BY ts DESC LIMIT 1").get();
  assert(!!row && JSON.parse(row.data).kind === 'OpenRouter API key', 'the hold is audited as prompt.credential.held');
  assert(!!row && !row.data.includes(key.slice(10)), 'the audit row never carries the value');
  assert(tm.holdHumanPrompt('ts_1', task, 'tui') === null, 'the launch task (server text) is never held, credential or not');
  const injected = `[task discussion] qa: token ghp_${fake(36)} leaked in CI output`;
  tm.injectToSession('ts_1', injected, true, 'system');
  assert(typed.includes(injected), 'injectToSession still types the text');
  assert(tm.holdHumanPrompt('ts_1', injected, 'tui') === null, 'text the server injected into the pane is never held');
  assert(tm.holdHumanPrompt('ts_1', `${injected} and also sk-proj-${fake(48)}`, 'tui') !== null, 'a human adding a key to delivered text is still held');
  assert(tm.holdHumanPrompt('ts_1', 'deploy it on the staging site', 'tui') === null, 'ordinary prompts pass');
  assert(typeof tm.holdHumanPrompt('ts_1', `here: ${key}`, 'reply', 'alice@x') === 'string', 'console reply path holds too');

  console.log('\n\x1b[1m3) lifecycle-hook.sh honours a hold, fails open\x1b[0m');
  const HOOK = path.join(ROOT, 'terminal/lifecycle-hook.sh');
  let answer = { ok: true };
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let d = ''; req.on('data', (c) => d += c).on('end', () => { bodies.push(d); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const runHook = (aosUrl, prompt) => {
    // async server + sync child: run the hook in a child that we await via a promise
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const p = spawn('/bin/bash', [HOOK], { env: { ...process.env, AOS_URL: aosUrl, SESSION: 'ts_1', AOS_SECRET: 's', AOS_TENANT: 'testco' } });
      let out = ''; p.stdout.on('data', (c) => out += c);
      p.on('close', (code) => resolve({ code, out }));
      p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
    });
  };
  answer = { ok: true, hold: 'Agentric held this message' };
  let r = await runHook(url, 'hello');
  let parsed = null; try { parsed = JSON.parse(r.out); } catch {}
  assert(r.code === 0 && parsed && parsed.decision === 'block' && parsed.reason === 'Agentric held this message', 'server hold → hook prints decision:block with the reason', r.out);
  assert(bodies.length && JSON.parse(bodies[bodies.length - 1]).prompt === 'hello', 'the hook forwards the prompt for UserPromptSubmit');
  answer = { ok: true };
  r = await runHook(url, 'hello');
  assert(r.code === 0 && r.out === '', 'no hold → no output (prompt proceeds)', r.out);
  r = await runHook('http://127.0.0.1:1', 'hello');
  assert(r.code === 0 && r.out === '', 'server unreachable → fails open', r.out);
  const big = 'x'.repeat(400_000);
  answer = { ok: true };
  r = await runHook(url, big);
  assert(r.code === 0 && JSON.parse(bodies[bodies.length - 1]).prompt.length === big.length, 'a 400 KB pasted prompt is delivered (body on stdin, not argv)');
  srv.close();

  console.log('\n\x1b[1m4) commit attribution\x1b[0m');
  assert(aos.settings.commitAttribution() === 'session-link', 'default is session-link');
  assert(/AOS_SESSION_URL/.test(commitAttributionBrief('session-link')), 'default brief asks for the session link');
  aos.settings.setCommitAttribution('none', 'owner@x');
  assert(aos.settings.commitAttribution() === 'none', '`none` is stored');
  const none = commitAttributionBrief('none');
  assert(!/AOS_SESSION_URL/.test(none) && /Co-Authored-By/.test(none), '`none` brief drops the link and says no AI trailer');
  const launch = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
  assert(/CLAUDE_ATTRIBUTION/.test(launch) && /"attribution": \{ "commit": "", "pr": "" \}/.test(launch), 'claude-launch.sh hides the CLI trailer on CLAUDE_ATTRIBUTION=none');

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}CREDENTIAL GUARD + ATTRIBUTION: ${pass}/${pass + fail} passed\x1b[0m`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
