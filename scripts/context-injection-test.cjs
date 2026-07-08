#!/usr/bin/env node
/*
 * Context-injection conformance test — verifies EXACTLY what an agent receives at session launch:
 *   1. The assembled system prompt (buildCompanyMd): operating notes, the self-improvement subsection,
 *      the conditional native-Slack/Discord steer, and the launch-time recall preamble (Settings→Memory).
 *   2. The OS-owned MCP tool list actually advertised by dist/memory/memory-mcp.js (always-on set +
 *      the conditional slack/discord tools), and the discord_dm description parity fix.
 *   3. The launch script's permission pre-allow uses the `mcp__agentos` wildcard (no partial list).
 *
 * Runs fully isolated: AGENT_OS_HOME points at a throwaway scratch dir (see the CLAUDE.md warning —
 * a bare loadAgentOS() would otherwise write into the LIVE ./data home). No server, no tmux, no claude.
 *
 * Usage:  node scripts/context-injection-test.cjs        (build first: npm run build)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ctx-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
// Keep the vault master key inside the scratch home too (a stray secret.key in ./data would leak).
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0,
  fail = 0;
const ok = (name) => {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  fail++;
  console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? `\n      ${detail}` : ''}`);
};
const assert = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

async function main() {
  const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

  const aos = loadAgentOS();
  // A peer agent so the fleet roster has something, and OUR agent under test.
  aos.agents.set('peer', { id: 'peer', runtime: 'claude-code', description: 'A peer agent', category: 'ops', dir: path.join(HOME, 'agents/peer') });
  aos.agents.set('tester', { id: 'tester', runtime: 'claude-code', description: 'The agent under test', dir: path.join(HOME, 'agents/tester') });

  const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
  const build = (agent) => tm.buildCompanyMd(agent); // private, but reachable from JS

  console.log('\n\x1b[1m1) System prompt assembly (buildCompanyMd)\x1b[0m');

  // --- default (no chat configured, preload off) ---
  const base = build('tester');
  assert(base.includes('# You are running inside Agent OS'), 'operating notes present');
  assert(base.includes('a fact (memory) vs. your standing instructions (CLAUDE.md)'), 'self-improvement subsection present');
  assert(/agent_update\b/.test(base) && /change to how you ALWAYS operate → your CLAUDE\.md/.test(base), 'self-improvement explains agent_update vs remember vs both');
  assert(base.includes('agent:peer') && !base.includes('agent:tester'), 'fleet roster lists peers, excludes self');
  assert(!base.includes('Messaging — use the native integration first'), 'no native-messaging block when Slack/Discord unconfigured');
  assert(!base.includes('What you already know'), 'no recall preamble when preload is off');

  // --- native Slack + Discord configured ---
  aos.settings.setSlackAppToken('xapp-test');
  aos.settings.setSlackBotToken('xoxb-test');
  aos.settings.setDiscordBotToken('bot-test');
  const chat = build('tester');
  assert(chat.includes('Messaging — use the native integration first'), 'native-messaging block appears when configured');
  assert(/\*\*Slack\*\* is native/.test(chat) && /slack_send/.test(chat) && /Do NOT use a Composio Slack action/.test(chat), 'Slack steer: prefer native over Composio');
  assert(/\*\*Discord\*\* is native/.test(chat) && /discord_send/.test(chat) && /Do NOT use a Composio Discord action/.test(chat), 'Discord steer: prefer native over Composio');

  // Only-Slack: the Discord bullet must NOT appear (never advertise a tool the session lacks).
  aos.settings.setDiscordBotToken('');
  const slackOnly = build('tester');
  assert(/\*\*Slack\*\* is native/.test(slackOnly) && !/\*\*Discord\*\* is native/.test(slackOnly), 'per-platform: only Slack listed when only Slack configured');

  console.log('\n\x1b[1m2) Launch-time recall preamble (Settings → Memory)\x1b[0m');

  // Seed memories: two private to `tester`, one tenant-shared (from a peer), one private to another agent (must NOT leak).
  await aos.memory.store({ tenant: aos.tenant, agentId: 'tester', content: 'PRIVATE-DEPLOY-GOTCHA restart after build', importance: 0.9 });
  await aos.memory.store({ tenant: aos.tenant, agentId: 'tester', content: 'low-value note', importance: 0.2 });
  await aos.memory.store({ tenant: aos.tenant, agentId: 'peer', content: 'SHARED-COMPANY-FACT the db is the tenant boundary', importance: 0.8, scope: 'tenant' });
  await aos.memory.store({ tenant: aos.tenant, agentId: 'other', content: 'OTHERS-PRIVATE-SECRET should never surface', importance: 0.99 });

  const preloadOff = build('tester');
  assert(!preloadOff.includes('What you already know'), 'preamble still absent while preload disabled');

  aos.settings.setMemoryConfig({ backend: 'sqlite', preload: { enabled: true, count: 8 } });
  const preloadOn = build('tester');
  assert(preloadOn.includes('What you already know — your most salient memories'), 'preamble present when preload enabled');
  assert(preloadOn.includes('PRIVATE-DEPLOY-GOTCHA'), "preamble includes the agent's own memories");
  assert(preloadOn.includes('SHARED-COMPANY-FACT'), 'preamble includes tenant-shared memories');
  assert(!preloadOn.includes('OTHERS-PRIVATE-SECRET'), "preamble does NOT leak another agent's private memories");
  // Importance ordering: the 0.9 private fact should sort above the 0.2 note (both present, high first).
  assert(preloadOn.indexOf('PRIVATE-DEPLOY-GOTCHA') < preloadOn.indexOf('low-value note'), 'preamble ranks by importance (high before low)');

  // count clamp
  aos.settings.setMemoryConfig({ backend: 'sqlite', preload: { enabled: true, count: 1 } });
  const one = build('tester');
  const bullets = (one.split('What you already know')[1] || '').split('\n').filter((l) => l.startsWith('- ')).length;
  assert(bullets === 1, 'preamble honours the count (1 requested → 1 bullet)', `got ${bullets}`);

  console.log('\n\x1b[1m3) OS-owned MCP tool list (dist/memory/memory-mcp.js)\x1b[0m');
  const always = await mcpTools({});
  const alwaysNames = always.map((t) => t.name);
  const EXPECTED_ALWAYS = ['recall', 'remember', 'revise', 'forget', 'kb_search', 'kb_write', 'ask', 'report', 'update', 'publish', 'schedule', 'task_create', 'task_update', 'agent_update', 'secret_put', 'secret_get', 'check_inbox'];
  const missing = EXPECTED_ALWAYS.filter((n) => !alwaysNames.includes(n));
  assert(missing.length === 0, `always-on tools all present (${alwaysNames.length} total)`, `missing: ${missing.join(', ')}`);
  assert(!alwaysNames.some((n) => /slack|discord/.test(n)), 'no slack/discord tools without egress flags');

  const dm = always.find((t) => t.name === 'discord_dm');
  // discord_dm is conditional, so pull the egress set to check its description parity.
  const egress = await mcpTools({ SLACK_EGRESS: '1', DISCORD_EGRESS: '1' });
  const eNames = egress.map((t) => t.name);
  ['slack_send', 'slack_dm', 'discord_send', 'discord_dm'].forEach((n) => assert(eNames.includes(n), `egress tool ${n} appears with *_EGRESS=1`));
  const ddm = egress.find((t) => t.name === 'discord_dm');
  const sdm = egress.find((t) => t.name === 'slack_dm');
  assert(ddm && /Reach anyone in the workspace/.test(ddm.description), 'discord_dm description brought to parity with slack_dm');
  assert(ddm && sdm && ddm.description.length >= sdm.description.length * 0.6, 'discord_dm no longer a terse stub', `ddm=${ddm && ddm.description.length} sdm=${sdm && sdm.description.length}`);

  const reply = await mcpTools({ SLACK_REPLY: '1', DISCORD_REPLY: '1' });
  const rNames = reply.map((t) => t.name);
  assert(rNames.includes('slack_reply') && rNames.includes('discord_reply'), 'reply tools appear with *_REPLY=1');

  console.log('\n\x1b[1m4) Launch-script permission pre-allow (claude-launch.sh)\x1b[0m');
  const launch = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
  assert(/"allow": \["mcp__agentos"\]/.test(launch), 'allow-list uses the mcp__agentos wildcard');
  assert(!/mcp__agentos__task_update"/.test(launch), 'old partial enumerated allow-list removed');

  console.log(`\n\x1b[1mResult:\x1b[0m ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/** Spawn the MCP server, initialize, call tools/list, return the tool array. */
function mcpTools(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(ROOT, 'dist/memory/memory-mcp.js')], {
      env: { ...process.env, AOS_URL: 'http://127.0.0.1:0', SESSION: 'test', AGENT: 'tester', AOS_SECRET: 'x', ...extraEnv },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mcp server timeout')); }, 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) { clearTimeout(timer); child.kill(); resolve(msg.result.tools); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
}

main()
  .catch((e) => { console.error(e); fail++; })
  .finally(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
