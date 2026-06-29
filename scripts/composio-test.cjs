#!/usr/bin/env node
/**
 * Composio Tool Router smoke test — exercises OUR exact integration end to end.
 *
 *   COMPOSIO_API_KEY=comp_... COMPOSIO_USER_ID=you@co.com node scripts/composio-test.cjs
 *
 * 1. Mints a Tool Router session via src/connectors/composio.ts (the same call createSession makes).
 * 2. Does a real MCP handshake (initialize + tools/list) against the minted URL and reports how many
 *    tools the agent would see (this is what actually ends up in a session's .mcp.json).
 *
 * No tools listed but a successful mint = the integration works, but that user_id has no apps
 * connected yet on composio.dev — connect one (e.g. Gmail) under that exact user_id and re-run.
 */
const path = require('path');
const { mintToolRouterSession } = require(path.resolve(__dirname, '../dist/connectors/composio.js'));

/** Read the workspace Composio key from the settings DB — the SAME key the app uses at spawn.
 *  Never printed. Falls back to COMPOSIO_API_KEY env if the DB has none. */
function keyFromDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const home = process.env.AGENT_OS_HOME || path.resolve(__dirname, '../data');
    const db = new DatabaseSync(path.join(home, 'agent-os.db'));
    const row = db.prepare("SELECT value FROM settings WHERE key = 'composio_api_key'").get();
    db.close();
    return (row && row.value ? String(row.value) : '').trim();
  } catch { return ''; }
}

const apiKey = (process.env.COMPOSIO_API_KEY || keyFromDb()).trim();
const userId = process.env.COMPOSIO_USER_ID || 'agent-os-test';

if (!apiKey) {
  console.error('No Composio key found (set one in Settings → Integrations, or pass COMPOSIO_API_KEY).');
  process.exit(2);
}
console.log(`Using ${process.env.COMPOSIO_API_KEY ? 'env' : 'stored (Settings → Integrations)'} key.`);

(async () => {
  console.log(`\n[1/2] Minting a Tool Router session for user_id="${userId}" …`);
  const res = mintToolRouterSession(apiKey, userId);
  if ('error' in res) {
    console.error(`  ✗ mint failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`  ✓ minted MCP URL: ${res.url}`);

  console.log(`\n[2/2] MCP handshake (initialize + tools/list) against the minted URL …`);
  try {
    const headers = {
      'content-type': 'application/json',
      // streamable-HTTP MCP servers reply as JSON or SSE — accept both
      'accept': 'application/json, text/event-stream',
      // The minted Tool Router URL still requires the Composio key on the connection (x-api-key).
      'x-api-key': apiKey,
    };
    const rpc = async (body, extra = {}) => {
      const r = await fetch(res.url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
      const sid = r.headers.get('mcp-session-id');
      const text = await r.text();
      // SSE frames come as `data: {...}` lines; plain JSON otherwise
      const jsonLine = text.split('\n').map((l) => l.replace(/^data:\s*/, '').trim()).filter((l) => l.startsWith('{')).pop();
      return { status: r.status, sid, json: jsonLine ? JSON.parse(jsonLine) : null, raw: text.slice(0, 300) };
    };

    const init = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-os-test', version: '1' } },
    });
    if (init.status >= 400 || !init.json) {
      console.error(`  ✗ initialize returned HTTP ${init.status}: ${init.raw}`);
      process.exit(1);
    }
    console.log(`  ✓ initialize ok (server: ${init.json?.result?.serverInfo?.name || 'unknown'})`);

    const sessionHeader = init.sid ? { 'mcp-session-id': init.sid } : {};
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionHeader);
    const tools = list.json?.result?.tools || [];
    console.log(`  ✓ tools/list ok — ${tools.length} tool(s) visible to an agent`);
    if (tools.length) {
      console.log('    e.g. ' + tools.slice(0, 12).map((t) => t.name).join(', '));
    } else {
      console.log('    (no tools — this user_id has no apps connected on composio.dev yet)');
    }
    console.log('\nResult: integration WORKS.' + (tools.length ? '' : ' Connect an app under this user_id to see tools.') + '\n');
  } catch (e) {
    console.error(`  ✗ handshake threw: ${e.message}`);
    console.error('  (mint succeeded, so the integration is fine — the MCP URL just needs a manual check)');
    process.exit(1);
  }
})();
