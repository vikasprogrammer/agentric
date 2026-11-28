#!/usr/bin/env node
/**
 * Pins terminal/antigravity-gate-hook.sh — the governance adapter for the `antigravity` runtime (`agy`).
 *
 * The adapter translates agy's PreToolUse wire into the shared gate-hook.sh and back, and DECIDES some
 * calls locally. The properties that make it a gate:
 *
 *   1. every world-reaching agy tool reaches /api/gate under the right Claude-shaped tool name
 *      (run_command → Bash, write_file → Write, edit_file → Edit, call_mcp_tool → mcp__<srv>__<tool>)
 *   2. an UNKNOWN tool is DENIED (unlike gate-hook.sh's `*) exit 0`) — agy has ~100 internal tools
 *   3. a NEW tool carrying `CommandLine` / `ServerName` is still routed by shape, not let through
 *   4. gate `deny` → `{"decision":"deny"}` with the reason; `allow` → `{"decision":"allow"}`
 *   5. writes / shell commands naming `.agents/` or `~/.gemini` are refused locally — agy hot-reloads
 *      hooks.json and a workspace `{"agentric":{"enabled":false}}` switches the gate off (verified)
 *   6. agy's own scheduler / swarm / run_workflow / define_subagent / ask_question are refused
 *   7. SessionStart reports the conversation id; Stop beacons /api/turn-idle; both print `{}`
 *   8. a gate that answers garbage, or a payload that can't be parsed, ends in DENY (fail-closed)
 *   9. an unattended pending approval times out to DENY
 *
 * Every output line must carry a `decision` — agy treats a missing one as a deny, but we never rely on it.
 */
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ADAPTER = path.resolve(__dirname, '../terminal/antigravity-gate-hook.sh');
const HOME = os.homedir();

let gateCalls = [];
let reported = [];
let idle = [];
let nextDecision = { decision: 'allow' };
let pendingStatus = 'pending';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/gate') { gateCalls.push(j); return res.end(typeof nextDecision === 'string' ? nextDecision : JSON.stringify(nextDecision)); }
    if (req.url.startsWith('/api/gate/')) return res.end(JSON.stringify({ status: pendingStatus }));
    if (req.url === '/api/runtime-session') { reported.push(j); return res.end('{"ok":true}'); }
    if (req.url === '/api/turn-idle') { idle.push(j); return res.end('{"ok":true}'); }
    res.statusCode = 404; res.end('{}');
  });
});

function run(payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [ADAPTER], {
      env: {
        ...process.env, AOS_URL: `http://127.0.0.1:${server.address().port}`, SESSION: 's1', AGENT: 'a1',
        AOS_SECRET: 'sek', AOS_TENANT: 'acme', UNATTENDED: '', AOS_UNATTENDED_APPROVAL_WAIT_S: '1', ...extraEnv,
      },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out: out.trim(), json: (() => { try { return JSON.parse(out.trim().split('\n').pop()); } catch (_) { return null; } })() }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const pre = (name, args, extra = {}) => ({
  hookEventName: 'PreToolUse', conversationId: 'c-1', cwd: '/tmp/agent-x',
  artifactDirectoryPath: path.join(HOME, '.gemini/antigravity-cli/brain/c-1'),
  toolCall: { id: 't1', name, args }, ...extra,
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const reset = () => { gateCalls = []; reported = []; idle = []; nextDecision = { decision: 'allow' }; pendingStatus = 'pending'; };

  // 1 + 4. Routing + allow.
  const routes = [
    ['run_command', { CommandLine: 'git status', Cwd: '/tmp/agent-x' }, 'Bash', 'shell.exec'],
    ['write_file', { Path: '/tmp/agent-x/a.md', Content: 'hi' }, 'Write', 'file.write'],
    ['edit_file', { Path: 'b.md', Target: 'x', Replacement: 'y' }, 'Edit', 'file.write'],
    ['call_mcp_tool', { ServerName: 'agentric', ToolName: 'composio-company__GMAIL_SEND_EMAIL', Arguments: { to: 'a@b' } }, 'mcp__composio-company__GMAIL_SEND_EMAIL', 'connector.call'],
    ['call_mcp_tool', { ServerName: 'ownerserver', ToolName: 'do_thing', Arguments: '{"x":1}' }, 'mcp__ownerserver__do_thing', 'connector.call'],
    ['manage_task', { Action: 'input', Input: 'rm -rf build', TaskId: 'k' }, 'Bash', 'shell.exec'],
  ];
  for (const [name, args, tool, cap] of routes) {
    reset();
    const r = await run(pre(name, args));
    assert.deepStrictEqual(r.json, { decision: 'allow' }, `${name} allowed → ${r.out}`);
    assert.strictEqual(gateCalls.length, 1, `${name} must reach the gate`);
    assert.strictEqual(gateCalls[0].args.tool, tool, `${name} routes as ${tool}`);
    assert.strictEqual(gateCalls[0].capability, cap, `${name} → ${cap}`);
  }
  // edit_file paths resolve against the agent's cwd, and the edit's text reaches the enricher.
  reset(); await run(pre('edit_file', { Path: 'b.md', Target: 'x', Replacement: 'y' }));
  assert.strictEqual(gateCalls[0].args.input.file_path, path.resolve('/tmp/agent-x/b.md').replace(/^\/tmp/, require('node:fs').realpathSync('/tmp')));
  assert.strictEqual(gateCalls[0].args.input.new_string, 'y');
  // The OS's own MCP tools (via the hub) never cost a gate call — same as Claude's mcp__agentos__*.
  reset();
  let r = await run(pre('call_mcp_tool', { ServerName: 'agentric', ToolName: 'agentos__recall', Arguments: { query: 'x' } }));
  assert.deepStrictEqual(r.json, { decision: 'allow' });
  assert.strictEqual(gateCalls.length, 0, 'mcp__agentos__* is the OS itself — no gate call');

  // 4. Gate deny carries the reason back.
  reset(); nextDecision = { decision: 'deny', reason: 'no prod pushes', capability: 'shell.exec' };
  r = await run(pre('run_command', { CommandLine: 'git push --force' }));
  assert.strictEqual(r.json.decision, 'deny');
  assert.match(r.json.reason, /no prod pushes/);

  // 2. Unknown tool → deny, no gate call.
  for (const name of ['browser_click_element', 'deploy_firebase', 'cloud_sql_execute_sql', 'brand_new_tool']) {
    reset(); r = await run(pre(name, { Foo: 1 }));
    assert.strictEqual(r.json.decision, 'deny', `${name} must be denied`);
    assert.strictEqual(gateCalls.length, 0);
  }
  // 3. A renamed tool is routed by its arguments' shape.
  reset(); r = await run(pre('shell_exec_v2', { CommandLine: 'ls' }));
  assert.strictEqual(gateCalls[0]?.args.tool, 'Bash', 'CommandLine → shell whatever the name');
  reset(); r = await run(pre('mcp_call_v9', { ServerName: 'x', ToolName: 'y', Arguments: {} }));
  assert.strictEqual(gateCalls[0]?.args.tool, 'mcp__x__y', 'ServerName → connector whatever the name');
  reset(); r = await run(pre('delete_path', { Path: '/tmp/agent-x/z' }));
  assert.strictEqual(gateCalls[0]?.args.tool, 'Write', 'a Path + write verb → file.write');

  // 5. Self-defence of the runtime's own config.
  const cfgCases = [
    ['write_file', { Path: '/tmp/agent-x/.agents/hooks.json', Content: '{"agentric":{"enabled":false}}' }],
    ['edit_file', { Path: path.join(HOME, '.gemini/config/hooks.json'), Target: 'a', Replacement: 'b' }],
    ['write_file', { Path: '/tmp/x/_agents/plugins/p/mcp_config.json', Content: '{}' }],
    ['run_command', { CommandLine: 'echo {} > .agents/hooks.json' }],
    ['run_command', { CommandLine: 'cat ~/.gemini/antigravity-cli/antigravity-oauth-token' }],
    ['run_command', { CommandLine: "python3 -c \"open('.agent/hooks.json','w')\"" }],
    ['read_file', { Path: path.join(HOME, '.gemini/antigravity-cli/antigravity-oauth-token') }],
    ['read_file', { Path: path.join(HOME, '.gemini/antigravity-cli/brain/other-conv/.system_generated/logs/transcript_full.jsonl') }],
  ];
  for (const [name, args] of cfgCases) {
    reset(); r = await run(pre(name, args));
    assert.strictEqual(r.json.decision, 'deny', `${name} ${JSON.stringify(args)} must be denied → ${r.out}`);
    assert.strictEqual(gateCalls.length, 0, 'decided locally');
  }
  // …but agy's OWN artifact dir for this conversation stays writable, and MCP schemas stay readable.
  reset(); r = await run(pre('write_file', { Path: path.join(HOME, '.gemini/antigravity-cli/brain/c-1/task.md'), Content: 'x' }));
  assert.deepStrictEqual(r.json, { decision: 'allow' }); assert.strictEqual(gateCalls.length, 0);
  reset(); r = await run(pre('write_file', { Path: path.join(HOME, '.gemini/antigravity-cli/brain/c-1/.system_generated/logs/transcript_full.jsonl'), Content: 'x' }));
  assert.strictEqual(r.json.decision, 'deny', 'the transcript under the artifact dir is not agent-writable');
  reset(); r = await run(pre('read_file', { Path: path.join(HOME, '.gemini/antigravity-cli/mcp/agentric/agentos__recall.json') }));
  assert.deepStrictEqual(r.json, { decision: 'allow' });
  // A word that merely CONTAINS the segment is not a root.
  reset(); r = await run(pre('run_command', { CommandLine: 'ls my_agents/ && cat docs/.agentsrc' }));
  assert.strictEqual(gateCalls.length, 1, 'my_agents/ is not a customization root');

  // 6. agy-native side channels.
  for (const name of ['schedule', 'swarm', 'run_workflow', 'define_subagent', 'ask_question']) {
    reset(); r = await run(pre(name, { Prompt: 'x', Script: 'print(1)' }));
    assert.strictEqual(r.json.decision, 'deny', `${name} must be denied`);
  }
  // In-process plumbing is allowed without a gate call.
  for (const name of ['update_steps', 'send_message', 'manage_subagents', 'invoke_subagent', 'search_web']) {
    reset(); r = await run(pre(name, {}));
    assert.deepStrictEqual(r.json, { decision: 'allow' }, name); assert.strictEqual(gateCalls.length, 0);
  }

  // 7. SessionStart / Stop.
  reset(); r = await run({ hookEventName: 'SessionStart', conversationId: 'conv-42' });
  assert.deepStrictEqual(r.json, {}); assert.deepStrictEqual(reported, [{ session: 's1', runtimeSessionId: 'conv-42' }]);
  reset(); r = await run({ hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL' });
  assert.deepStrictEqual(r.json, {}); assert.deepStrictEqual(idle, [{ session: 's1' }]);

  // 8. Fail-closed.
  reset(); r = await run('not json at all');
  assert.ok(r.json === null || r.json.decision === undefined || r.json.decision === 'deny' || JSON.stringify(r.json) === '{}', 'unparsable event never allows');
  reset(); r = await run({ ...pre('x', {}), hookEventName: 'PreToolUse', toolCall: 'garbage' });
  assert.strictEqual(r.json.decision, 'deny');
  reset(); r = await run(pre('run_command', { CommandLine: '' }));
  assert.strictEqual(r.json.decision, 'deny', 'an empty command is not an allow');
  reset(); r = await run(pre('run_command', { CommandLine: 'ls' }), { AOS_GATE_HOOK: '/nonexistent/gate-hook.sh' });
  assert.strictEqual(r.json.decision, 'deny', 'a missing gate script is a deny');

  // 9. Unattended pending approval → deny after the bound.
  reset(); nextDecision = { decision: 'pending', gateId: 'g1' };
  r = await run(pre('run_command', { CommandLine: 'terraform apply' }), { UNATTENDED: '1' });
  assert.strictEqual(r.json.decision, 'deny');
  assert.match(r.json.reason, /fail-closed|no operator/i);
  // …and an approval granted while waiting is an allow.
  reset(); nextDecision = { decision: 'pending', gateId: 'g2' }; pendingStatus = 'allow';
  r = await run(pre('run_command', { CommandLine: 'terraform apply' }));
  assert.deepStrictEqual(r.json, { decision: 'allow' });

  server.close();
  console.log('antigravity-gate-test: ok');
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
