#!/usr/bin/env node
/* Git discovery is fenced at the agents folder.
 *
 * globex 2026-09-22: an engineer run did `cd <a work dir that no longer existed>` and then, unchained,
 * `git remote set-url origin …client-app` + `git reset --hard origin/<branch>`. The cd failed, git walked
 * up from the agent's folder to the agent-os checkout the data home lived in, and replaced the product's
 * own source with another repo — `terminal/` gone, every later session crashed on launch.
 *
 * Pins: every launch exports GIT_CEILING_DIRECTORIES = the agents folder; with it, git run in the agent's
 * folder finds NO repo even when an ancestor is one (and without it, it would — the test proves the walk
 * is real); a repo INSIDE the agent's folder still works. Isolated home; no tmux or claude needed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-git-ceiling-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'claude-config');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

let spawned;
const live = new Set();
tm.backend.aliveNames = () => new Set(live);
tm.backend.spawn = (_s, o) => { spawned = o; live.add(o.tmuxName); };
tm.backend.kill = (_s, t) => { live.delete(t); };
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

// Only git's own env should decide discovery in these probes.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, extra) => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: { ...cleanEnv, ...extra }, encoding: 'utf8' });

(async () => {
  const agent = aos.listAgents ? (aos.listAgents()[0]?.id) : undefined;
  const AGENT = agent || 'agent-author';
  tm.createSession(AGENT, 'probe', 'noop', 'automation:a1', true);
  await new Promise((r) => setTimeout(r, 50));

  const env = spawned?.env || {};
  const agentDir = env.AGENT_DIR;
  assert(!!agentDir, 'the launch carries AGENT_DIR', JSON.stringify(Object.keys(env)).slice(0, 200));
  assert(env.GIT_CEILING_DIRECTORIES === fs.realpathSync(path.dirname(agentDir)),
    'GIT_CEILING_DIRECTORIES is the (real) agents folder', `${env.GIT_CEILING_DIRECTORIES} vs ${agentDir}`);

  // Model the live layout: the data home inside a product checkout. Make the home's PARENT chain a repo.
  const product = fs.realpathSync(HOME);
  spawnSync('git', ['init', '-q', product]);
  const without = git(agentDir, {});
  assert(without.status === 0 && without.stdout.trim() === product,
    'control: WITHOUT the fence, git in the agent folder resolves to the enclosing checkout', without.stderr);
  const withFence = git(agentDir, { GIT_CEILING_DIRECTORIES: env.GIT_CEILING_DIRECTORIES });
  assert(withFence.status !== 0 && /not a git repository/.test(withFence.stderr),
    'WITH the fence, git in the agent folder finds no repo — a stray reset cannot reach the product', withFence.stdout);

  const inner = path.join(agentDir, 'repos', 'client-app');
  fs.mkdirSync(inner, { recursive: true });
  spawnSync('git', ['init', '-q', inner]);
  const own = git(inner, { GIT_CEILING_DIRECTORIES: env.GIT_CEILING_DIRECTORIES });
  assert(own.status === 0 && own.stdout.trim() === fs.realpathSync(inner), 'a repo inside the agent folder still works', own.stderr);

  console.log(`\ngit-ceiling-test: ${pass} passed, ${fail} failed`);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(fail ? 1 : 0);
})();
