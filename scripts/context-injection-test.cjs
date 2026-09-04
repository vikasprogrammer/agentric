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
  assert(base.includes('# You are running inside Agentric'), 'operating notes present');
  assert(base.includes('a fact (memory) vs. your standing instructions (CLAUDE.md)'), 'self-improvement subsection present');
  assert(/agent_update\b/.test(base) && /change to how you ALWAYS operate → your CLAUDE\.md/.test(base), 'self-improvement explains agent_update vs remember vs both');
  assert(base.includes('agent:peer') && !base.includes('agent:tester'), 'fleet roster lists peers, excludes self');

  // MEMORY vs KB. The old rule split them by AUDIENCE — "facts only you reuse" vs "the whole fleet" —
  // which asks the agent to predict who will need a fact, at the moment it cannot know. Reading 22 live
  // runs that wrote to BOTH stores showed what agents actually do, and it is decidable at write time:
  // the KB gets the FINDING (a root cause, a measured result, a runbook — 'proven end-to-end against
  // production', 'measured on 1026/1026 zones'), memory gets the TECHNIQUE (dev10 is the only box with
  // Stripe keys; psysh evaluates line by line; a `return 404` guard cannot be canaried by status code).
  // 19 of 22 pairs were complementary, 1 a pointer, 2 near-duplicates. The prompt now states the rule
  // they had already converged on.
  assert(base.includes('Memory or the Knowledge Base?'), 'the memory-vs-KB rule is stated');
  assert(/The finding goes in the KB/.test(base) && /The technique goes in memory/.test(base), 'and it splits by KIND of knowledge, not audience');
  assert(!/Memory is for facts only \*you\* reuse/.test(base), 'the old audience-based rule is gone — it was not decidable at write time');
  // `shared: true` is no longer advertised: 22 of 2,523 memories on one live tenant and 37 of 10,907 on
  // another used it, while kb_write did the same job. The capability remains in the tool schema; we just
  // stop offering a third destination nobody picks. Every choice offered is a chance to choose wrong.
  assert(!/shared: ?true/.test(base), 'the unused shared-memory channel is no longer advertised in the prompt');
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
  // v0.399.0 moved the preamble OUT of buildCompanyMd: it is I/O (a recall), so the async launcher
  // resolves it and hands it in, keeping prompt assembly synchronous. These assertions still called the
  // old one-arg shape and had been failing ever since — invisibly, because this file was never wired into
  // `npm run test:governance`. Both are fixed below: build the preamble the way the launcher does, and
  // the file now runs in CI so it cannot rot again.
  const withPreamble = async (agent, task) => tm.buildCompanyMd(agent, undefined, false, await tm.memoryPreamble(agent, task));

  // The preamble is one section of a longer prompt, and later sections use "- " too — so bound the count
  // to the preamble's own block (up to the next heading) rather than everything after its title.
  const preambleBullets = (md) => {
    const i = md.indexOf('What you already know');
    if (i < 0) return 0;
    const rest = md.slice(i);
    const end = rest.indexOf('\n#', 1);
    return (end > 0 ? rest.slice(0, end) : rest).split('\n').filter((l) => l.startsWith('- ')).length;
  };
  aos.settings.setMemoryConfig({ backend: 'sqlite', preload: { enabled: true, count: 8 } });
  const preloadOn = await withPreamble('tester', 'deploy the service and restart it after the build');
  assert(preloadOn.includes('What you already know'), 'preamble present when preload enabled');
  assert(preloadOn.includes('PRIVATE-DEPLOY-GOTCHA'), "preamble includes the agent's own memories");
  assert(preloadOn.includes('SHARED-COMPANY-FACT'), 'preamble includes tenant-shared memories');
  assert(!preloadOn.includes('OTHERS-PRIVATE-SECRET'), "preamble does NOT leak another agent's private memories");
  // Selection is now by RELEVANCE to the task (v0.399.0), not importance — and an irrelevant memory is
  // not ranked last, it is not seeded AT ALL. That is the stronger property, so assert it directly: the
  // deploy gotcha is in, the unrelated note is out, for a deploy task.
  assert(!preloadOn.includes('low-value note'), 'a memory irrelevant to the task is not seeded at all');

  // count clamp. Needs TWO task-relevant memories, or the cap is untestable — with only one relevant
  // memory a count of 1 and a count of 8 both yield one bullet, and the assertion would pass for the
  // wrong reason.
  await aos.memory.store({ tenant: aos.tenant, agentId: 'tester', content: 'SECOND-DEPLOY-FACT the build step must run before the restart', importance: 0.7 });
  aos.settings.setMemoryConfig({ backend: 'sqlite', preload: { enabled: true, count: 8 } });
  const two = await withPreamble('tester', 'deploy the service and restart it after the build');
  assert(preambleBullets(two) >= 2, 'both task-relevant memories are seeded when the count allows', 'got ' + preambleBullets(two));
  aos.settings.setMemoryConfig({ backend: 'sqlite', preload: { enabled: true, count: 1 } });
  const one = await withPreamble('tester', 'deploy the service and restart it after the build');
  assert(preambleBullets(one) === 1, 'preamble honours the count (1 requested → 1 bullet)', 'got ' + preambleBullets(one));

  console.log('\n\x1b[1m3) OS-owned MCP tool list (dist/memory/memory-mcp.js)\x1b[0m');
  const always = await mcpTools({});
  const alwaysNames = always.map((t) => t.name);
  const EXPECTED_ALWAYS = ['recall', 'remember', 'revise', 'forget', 'kb_search', 'kb_write', 'ask_human', 'report', 'update', 'publish', 'schedule', 'task_create', 'task_update', 'agent_update', 'secret_put', 'secret_get', 'check_inbox'];
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

  // EVERY TOOL THE PROMPT NAMES MUST EXIST. `ask` was renamed `ask_human`, and the prompt kept telling
  // agents to call `ask` — in the operating notes twice and in the unattended-turn brief once. Nothing
  // caught it: this file is the only thing that checks the prompt, and it was never wired into
  // `npm run test:governance`, so it had been failing silently since the signature change in v0.399.0.
  // A prompt that names a tool which does not exist is a prompt that teaches agents to fail.
  console.log('\n\x1b[1m2b) Every tool the prompt names exists\x1b[0m');
  {
    const { AGENT_OS_OPERATING_NOTES } = require(path.join(ROOT, 'dist/terminal.js'));
    const { UNATTENDED_TURN_BRIEF } = require(path.join(ROOT, 'dist/edge/background-work.js'));
    const prose = AGENT_OS_OPERATING_NOTES + '\n' + (UNATTENDED_TURN_BRIEF || '');
    // Field names and statuses are also backticked, so only check identifiers that look like tool calls:
    // snake_case, or a known bare-word tool. Anything else is prose and is skipped deliberately.
    const cited = [...new Set((prose.match(/`([a-z][a-z0-9_]{2,})`/g) || []).map((x) => x.slice(1, -1)))]
      .filter((x) => x.includes('_') || ['recall', 'remember', 'revise', 'forget', 'report', 'update', 'publish', 'notify', 'schedule', 'unschedule', 'stop'].includes(x));
    const unknown = cited.filter((c) => !alwaysNames.includes(c) && !eNames.includes(c) && !rNames.includes(c));
    assert(unknown.length === 0, 'every tool named in the prompt is actually exposed', unknown.join(', '));
  }


  console.log('\n\x1b[1m4) Launch-script permission pre-allow (claude-launch.sh)\x1b[0m');
  const launch = fs.readFileSync(path.join(ROOT, 'terminal/claude-launch.sh'), 'utf8');
  assert(/"allow": \["mcp__agentos"\]/.test(launch), 'allow-list uses the mcp__agentos wildcard');
  assert(!/mcp__agentos__task_update"/.test(launch), 'old partial enumerated allow-list removed');
  // Cross-session messaging (claude ≥2.1.224) reaches every session owned by the same OS user on the
  // box — the whole fleet, across tenants — through a channel the gate hook has no capability row for.
  // Refused at the settings layer; the tools themselves stay (SendMessage also serves subagents/teams).
  assert(/"crossSessionInbound": "refuse"/.test(launch), 'cross-session inbound messages are refused');
  assert(/"isolatePeerMachines": true/.test(launch), 'cross-machine sends require explicit approval');
  assert(
    !/"deny":[^\n]*SendMessage/.test(launch),
    'SendMessage is NOT deny-listed (that would also kill subagents / agent teams)',
  );

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
