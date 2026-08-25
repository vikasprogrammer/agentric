#!/usr/bin/env node
/**
 * Pins the opencode gate plugin — the governance bridge for the `opencode` runtime.
 *
 * opencode has no command-hook facility, so terminal/opencode-gate-plugin.js is a SECOND, independent
 * implementation of what terminal/gate-hook.sh does for claude-code/codex. Two implementations of one
 * invariant is exactly the shape where a fix lands in one and silently misses the other, so the
 * properties that make it a gate are asserted here:
 *
 *   1. every world-reaching tool routes to a capability (nothing reaches the world unclassified)
 *   2. an unknown/new tool FAILS TOWARDS the gate, never to a silent allow
 *   3. `deny` throws; `allow` returns
 *   4. a gate that is unreachable BLOCKS (retries) — it never degrades to allow
 *   5. an unattended run bounded on a pending approval FAILS CLOSED (throws), never allows
 *   6. the `task` tool (sub-agent spawn) is refused — opencode's hooks are not confirmed to fire for a
 *      sub-agent's own calls, so a spawn is the one way to get an ungoverned effect
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_PATH = path.resolve(__dirname, '../terminal/opencode-gate-plugin.js');
// The plugin ships as `.js` because that is the ONLY extension opencode's plugin discovery loads
// (verified against 1.17: a `.mjs`/`.ts` copy is ignored silently, which would leave the session
// ungoverned). This repo is not `type: module`, so Node itself refuses to import that same `.js` as
// ESM — copy it to a `.mjs` in a temp dir purely to load it HERE. The shipped extension is asserted
// separately below; do not "fix" this by renaming the real file.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-oc-gate-'));
const PLUGIN = pathToFileURL(path.join(tmp, 'plugin.mjs')).href;
fs.copyFileSync(PLUGIN_PATH, path.join(tmp, 'plugin.mjs'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

/** Load the plugin fresh with a controlled env + a stubbed fetch. */
async function load({ unattended = false, responses = [], statuses = [] } = {}) {
  process.env.AOS_URL = 'http://127.0.0.1:9';
  process.env.SESSION = 's1';
  process.env.AGENT = 'a1';
  process.env.AOS_SECRET = 'sek';
  process.env.AOS_TENANT = 'acme';
  process.env.UNATTENDED = unattended ? '1' : '';
  process.env.AOS_UNATTENDED_APPROVAL_WAIT_S = '2';
  const calls = { classify: 0, status: 0, reported: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/runtime-session')) { calls.reported.push(JSON.parse(init.body)); return { json: async () => ({ ok: true }) }; }
    if (u.includes('/api/gate/')) {
      const s = statuses[Math.min(calls.status, statuses.length - 1)];
      calls.status += 1;
      if (s === 'THROW') throw new Error('unreachable');
      return { json: async () => ({ status: s }) };
    }
    const r = responses[Math.min(calls.classify, responses.length - 1)];
    calls.classify += 1;
    if (r === 'THROW') throw new Error('unreachable');
    return { json: async () => r };
  };
  // Cache-bust so each case gets a fresh module (the session-report latch is module state).
  const mod = await import(`${PLUGIN}?t=${Math.random()}`);
  const hooks = await mod.AgentricGate({});
  return { hooks, calls };
}

const before = (hooks, tool, args = {}) =>
  hooks['tool.execute.before']({ tool, sessionID: 'oc-1', callID: 'c1' }, { args });

(async () => {
  // 1 + 3. Every governed tool class reaches the gate and an allow lets it through.
  for (const tool of ['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'mcp__composio__GMAIL_SEND']) {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await before(hooks, tool);
    assert.strictEqual(calls.classify, 1, `${tool} must be classified by the gate`);
  }

  // Read-only navigation is not a world side effect — it must NOT burn a gate call.
  for (const tool of ['read', 'grep', 'glob', 'list', 'todowrite']) {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await before(hooks, tool);
    assert.strictEqual(calls.classify, 0, `${tool} should bypass the gate`);
  }

  // The OS's own MCP server is internal (memory/ask/report) — bypassed under both spellings.
  for (const tool of ['mcp__agentos__recall', 'agentos__report']) {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await before(hooks, tool);
    assert.strictEqual(calls.classify, 0, `${tool} should bypass the gate`);
  }

  // 2. An unknown tool (a future opencode release) must still be classified, not waved through.
  {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await before(hooks, 'some_new_tool_we_have_never_seen');
    assert.strictEqual(calls.classify, 1, 'an unknown tool must fail towards the gate');
  }

  // 3. A deny THROWS (opencode aborts the call), and the message steers to the sanctioned path.
  {
    const { hooks } = await load({ responses: [{ decision: 'deny', reason: 'crown jewels', capability: 'file.write' }] });
    await assert.rejects(() => before(hooks, 'write'), /denied \[file\.write\].*crown jewels.*policy_propose/s);
  }

  // 6. Sub-agent spawn is refused outright, WITHOUT consulting the gate.
  {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await assert.rejects(() => before(hooks, 'task'), /sub-agents are disabled/);
    assert.strictEqual(calls.classify, 0, 'task must be refused before any gate call');
  }

  // 4. An unreachable gate BLOCKS and retries; it must never fall through to allow.
  {
    const { hooks, calls } = await load({ responses: ['THROW', 'THROW', { decision: 'allow' }] });
    await before(hooks, 'bash');
    assert.ok(calls.classify >= 3, 'an unreachable gate must be retried, not treated as allow');
  }

  // 5. Unattended + pending → FAIL CLOSED after the bounded wait.
  {
    const { hooks } = await load({ unattended: true, responses: [{ decision: 'pending', gateId: 'g1' }], statuses: ['pending'] });
    await assert.rejects(() => before(hooks, 'bash'), /fail-closed/);
  }

  // …and a human approving inside that window lets it through.
  {
    const { hooks } = await load({ unattended: true, responses: [{ decision: 'pending', gateId: 'g1' }], statuses: ['pending', 'allow'] });
    await before(hooks, 'bash');
  }

  // A human rejecting throws.
  {
    const { hooks } = await load({ unattended: true, responses: [{ decision: 'pending', gateId: 'g1' }], statuses: ['deny'] });
    await assert.rejects(() => before(hooks, 'bash'), /rejected by human/);
  }

  // The runtime session id is reported back (opencode mints its own; resume/fork need it).
  {
    const { hooks, calls } = await load({ responses: [{ decision: 'allow' }] });
    await hooks['chat.message']({ sessionID: 'oc-abc' });
    assert.deepStrictEqual(calls.reported, [{ session: 's1', runtimeSessionId: 'oc-abc' }]);
    await hooks['chat.message']({ sessionID: 'oc-abc' });
    assert.strictEqual(calls.reported.length, 1, 'the id is reported once per process');
  }

  // opencode's own permission layer must not raise a second prompt on top of our decision.
  {
    const { hooks } = await load({});
    const out = { status: 'ask' };
    await hooks['permission.ask']({}, out);
    assert.strictEqual(out.status, 'allow', 'Agentric is the sole authority');
  }

  // The shipped gate MUST be `.js`: opencode ignores any other plugin extension without warning, so a
  // rename would silently produce ungoverned sessions.
  assert.ok(fs.existsSync(PLUGIN_PATH), 'the gate plugin must ship as terminal/opencode-gate-plugin.js');

  // Fail-closed pairing: the launcher must write permissions as "ask" (the plugin relaxes them at
  // runtime). If this ever becomes "allow", a plugin that fails to load leaves a fully ungoverned
  // agent that looks completely normal — the exact failure this pairing exists to prevent.
  const launcher = fs.readFileSync(path.resolve(__dirname, '../terminal/opencode-launch.sh'), 'utf8');
  const permLine = launcher.split('\n').find((l) => l.includes('permission: {'));
  assert.ok(permLine, 'opencode-launch.sh must set a permission block');
  assert.ok(!/"allow"/.test(permLine), 'opencode-launch.sh permissions must default to "ask", not "allow"');
  for (const k of ['edit', 'bash', 'webfetch']) assert.ok(permLine.includes(`${k}: "ask"`), `${k} must default to "ask"`);
  // Sub-agents must also be off in the config, not only refused by the plugin (defence in depth).
  assert.ok(/tools:\s*\{\s*task:\s*false\s*\}/.test(launcher), 'opencode-launch.sh must disable the task (sub-agent) tool');
  // `--pure` runs opencode WITHOUT external plugins, i.e. without the gate. It must never be passed.
  assert.ok(!/\s--pure(\s|")/.test(launcher), 'opencode-launch.sh must never pass --pure (it disables the gate plugin)');

  console.log('opencode-gate-test: ok');
})().catch((e) => { console.error('opencode-gate-test FAILED:', e.message); process.exit(1); });
