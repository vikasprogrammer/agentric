#!/usr/bin/env node
/* Run the governance suite with the box's OWN Claude login out of reach.
 *
 * Every launch path runs a credential pre-flight, and with no pool account it checks the box default:
 * `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Most test scripts isolate AGENT_OS_HOME but not that, so they were
 * really testing whether the machine running them had a live Claude login. On instawp (2026-11-10) the box
 * default had long been dead (no tokens, refresh expired 2026-10-27, every real run on a pool account), so
 * `launch-window-test` saw `session.launch.refused` instead of a launch. The deploy gate failed on a box
 * whose code was fine, and it would have passed on any box that happened to be signed in.
 *
 * So the whole chain runs against a scratch config dir holding a well-formed, unexpired credential. Tests
 * that need a specific credential state still set CLAUDE_CONFIG_DIR themselves, which overrides this.
 * The token values are inert placeholders; nothing here talks to the network. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gov-claude-'));
const now = Date.now();
fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-governance-suite-placeholder',
    refreshToken: 'governance-suite-placeholder',
    expiresAt: now + 864e5,
    refreshTokenExpiresAt: now + 30 * 864e5,
  },
}), { mode: 0o600 });

// ── run the chain ────────────────────────────────────────────────────────────────────────────────
// `test:governance:run` in package.json stays the single list of suites (add yours there). It used to be
// executed as written — one `&&` chain, 169 scripts back to back, ~100 s — and that serial run was the
// whole wait of every deploy (each box gates its restart on it) and every PR. The suites are isolated
// by construction (own scratch home, ephemeral ports), so they run in a worker pool instead.
//
// Parallelism must never be able to turn the gate red on its own: a suite that fails in the pool is
// re-run ALONE, and only a failure that repeats there counts. `AOS_GOV_SERIAL=1` restores the old order.
const { spawn } = require('child_process');
const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, AOS_NO_TTYD: process.env.AOS_NO_TTYD || '1' };
const steps = require(path.join(__dirname, '..', 'package.json')).scripts['test:governance:run'].split('&&').map((x) => x.trim()).filter(Boolean);
const finish = (code) => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(code); };
const name = (cmd) => (/scripts\/([\w.-]+)\.cjs/.exec(cmd) || [, cmd])[1];

const runOne = (cmd) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(cmd, { shell: true, env, cwd: path.join(__dirname, '..') });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('error', (e) => resolve({ cmd, code: 1, out: out + String(e), ms: Date.now() - started }));
  child.on('close', (code) => resolve({ cmd, code: code ?? 1, out, ms: Date.now() - started }));
});

(async () => {
  const t0 = Date.now();
  const serial = process.env.AOS_GOV_SERIAL === '1';
  const width = serial ? 1 : Math.max(1, Math.min(Number(process.env.AOS_GOV_JOBS) || 8, os.cpus().length, steps.length));
  const results = [];
  let next = 0, asserts = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < steps.length) {
      const r = await runOne(steps[next++]);
      results.push(r);
      if (serial) process.stdout.write(r.out);
    }
  }));
  let failed = results.filter((r) => r.code !== 0);
  if (failed.length && !serial) {
    console.log(`\n${failed.length} suite(s) failed in the parallel pass — re-running each alone: ${failed.map((r) => name(r.cmd)).join(', ')}`);
    const again = [];
    for (const r of failed) again.push(await runOne(r.cmd));
    for (const r of again) if (r.code === 0) console.log(`  \x1b[33m~ ${name(r.cmd)} passes alone — it is sensitive to running alongside others; worth fixing\x1b[0m`);
    failed = again.filter((r) => r.code !== 0);
  }
  for (const r of results) { const m = /(\d+) passed/.exec(r.out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').reverse().find((l) => /\d+ passed/.test(l)) || ''); if (m) asserts += Number(m[1]); }
  for (const r of failed) console.log(`\n\x1b[31m✗ ${name(r.cmd)}\x1b[0m\n${r.out}`);
  const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => `${name(r.cmd)} ${(r.ms / 1000).toFixed(1)}s`).join(', ');
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (failed.length) { console.log(`\n\x1b[31m${failed.length} of ${steps.length} suites failed\x1b[0m (${secs}s)`); return finish(1); }
  console.log(`\x1b[32m${steps.length} suites passed, 0 failed\x1b[0m — ${asserts} assertions in ${secs}s${serial ? '' : `, ${width} at a time`} (slowest: ${slow})`);
  finish(0);
})().catch((e) => { console.error(e); finish(1); });
