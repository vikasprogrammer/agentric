#!/usr/bin/env node
/*
 * Gate tool coverage — every tool the hook ROUTES must also be MATCHED by the launcher, and every
 * exec-capable tool must be routed.
 *
 * Why this exists: claude-code's `Monitor` tool runs an arbitrary shell command (it streams a
 * long-running script's stdout as events). It was in neither `gate-hook.sh`'s routing table nor the
 * PreToolUse matcher in `claude-launch.sh`, so it was completely ungoverned — no policy, no approval,
 * no audit — and live transcripts show agents reaching remote hosts over ssh through it. The two lists
 * have to agree: a tool routed but not matched never reaches the hook (silent bypass), and a tool
 * matched but not routed hits the `*)` allow-by-default arm.
 *
 * Drives the REAL hook as a subprocess against a stub gate, so this pins the wire and not a copy of it.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'terminal/gate-hook.sh');
const LAUNCH = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
const HOOKSH = fs.readFileSync(HOOK, 'utf8');

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

// ── 1) the matcher covers every tool the routing table names ──────────────────
console.log('\n\x1b[1m1) the launcher matcher covers every routed tool\x1b[0m');
const matcher = (LAUNCH.match(/"matcher":\s*"([^"]+)"[^\n]*PreToolUse|"matcher":\s*"([^"]+)"/) || [])
  .slice(1).find(Boolean);
const m = LAUNCH.match(/"PreToolUse":\s*\[\s*\{\s*"matcher":\s*"([^"]+)"/);
assert(!!m, 'found the PreToolUse matcher in claude-launch.sh', matcher);
const re = new RegExp(`^(?:${m[1]})$`);

// Tools named on the left of a `CAP=` arm — the literal names, minus the wildcard arms.
const routed = new Set();
for (const line of HOOKSH.split('\n')) {
  const arm = line.match(/^\s{2}([A-Za-z|_*]+)\)\s*$/) || line.match(/^\s{2}([A-Za-z|_]+)\)\s+CAP=/);
  if (!arm) continue;
  for (const name of arm[1].split('|')) if (/^[A-Z][A-Za-z]+$/.test(name)) routed.add(name);
}
assert(routed.has('Monitor'), 'Monitor is routed by the hook (it runs a shell command)', [...routed].join(','));
assert(routed.has('Bash') && routed.has('Write'), 'the table was parsed (Bash + Write found)', [...routed].join(','));
for (const tool of [...routed].sort())
  assert(re.test(tool), `matcher reaches \`${tool}\` — a routed tool the matcher misses never hits the gate`);

// ── 2) end to end: the hook classifies Monitor as shell.exec ──────────────────
console.log('\n\x1b[1m2) the hook sends Monitor to the gate as shell.exec\x1b[0m');
(async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/gate') {
        seen.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow' }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const AOS_URL = `http://127.0.0.1:${server.address().port}`;

  // ASYNC on purpose: execFileSync would block this process's event loop, so the stub server above
  // could never accept the hook's curl — the hook would wait for a gate that cannot answer and the
  // test would hang instead of failing.
  const run = async (event) => {
    const child = execFileP('bash', [HOOK], {
      env: { ...process.env, AOS_URL, SESSION: 'ses_t', AGENT: 'tester', AOS_SECRET: 'x', AOS_RUNTIME: 'claude-code' },
      encoding: 'utf8',
      timeout: 30000,
    });
    child.child.stdin.end(JSON.stringify(event));
    return (await child).stdout;
  };

  const out = await run({ tool_name: 'Monitor', tool_input: { command: 'until ssh root@db.internal true; do sleep 2; done', description: 'wait', timeout_ms: 60000 } });
  const dec = JSON.parse(out).hookSpecificOutput;
  assert(dec.permissionDecision === 'allow', 'an allowed Monitor comes back allow', out.trim());
  const call = seen.find((s) => s.args?.tool === 'Monitor');
  assert(!!call, 'the hook actually called /api/gate for Monitor');
  assert(call && call.capability === 'shell.exec', 'classified as shell.exec', call && call.capability);
  assert(call && call.args.input.command.includes('ssh root@db.internal'),
    'the command text reaches the enricher (so host-egress facts are computable)');

  // The ws form has no command to classify → denied locally, never sent as a factless shell.exec.
  const wsOut = await run({ tool_name: 'Monitor', tool_input: { ws: { url: 'wss://evil.example.com/x' }, description: 'ws', timeout_ms: 60000 } });
  const wsDec = JSON.parse(wsOut).hookSpecificOutput;
  assert(wsDec.permissionDecision === 'deny', 'the ws form is denied', wsOut.trim());
  assert(!seen.some((s) => s.args?.input?.ws), 'and is never sent to the gate as an empty shell.exec');

  server.close();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
