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

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['run', '-s', 'test:governance:run'], {
  stdio: 'inherit',
  env: { ...process.env, CLAUDE_CONFIG_DIR: dir, AOS_NO_TTYD: process.env.AOS_NO_TTYD || '1' },
});
fs.rmSync(dir, { recursive: true, force: true });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status ?? 1);
