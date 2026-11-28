#!/usr/bin/env node
/**
 * Pins terminal/antigravity-mcp-hub.js — the one global MCP entry an `antigravity` session talks to.
 *
 *   1. tools from every downstream server are listed as `<server>__<tool>` (the names the gate adapter
 *      turns into `mcp__<server>__<tool>`, exactly as on Claude Code)
 *   2. a call is routed to the right server with the ORIGINAL tool name, and the result comes back
 *   3. stdio AND Streamable HTTP (plain JSON and SSE-framed responses, with Mcp-Session-Id) both work
 *   4. a server that fails to start does not take the others down
 *   5. outside a session ($MCP_CONFIG unset) the hub answers with no tools rather than failing
 */
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const HUB = path.resolve(__dirname, '../terminal/antigravity-mcp-hub.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-agy-hub-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

// A tiny stdio MCP server.
const stdioSrv = path.join(tmp, 'stdio-srv.js');
fs.writeFileSync(stdioSrv, `
const rl=require('readline').createInterface({input:process.stdin});
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
rl.on('line',l=>{const m=JSON.parse(l);
 if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'s',version:'1'}}});
 else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'recall',description:'r',inputSchema:{type:'object'}}]}});
 else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'stdio:'+m.params.name+':'+JSON.stringify(m.params.arguments)+':'+process.env.WHO}]}});
});`);

// A Streamable-HTTP MCP server: JSON for initialize/list, SSE for tools/call; insists on its session id.
let sawSession = false;
const httpSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const m = JSON.parse(b);
    if (req.headers['x-key'] !== 'k1') { res.statusCode = 401; return res.end('nope'); }
    if (m.method === 'initialize') { res.setHeader('mcp-session-id', 'sess-9'); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'h', version: '1' } } })); }
    if (m.id === undefined) { res.statusCode = 202; return res.end(); }
    if (req.headers['mcp-session-id'] === 'sess-9') sawSession = true;
    if (m.method === 'tools/list') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'GMAIL_SEND', inputSchema: { type: 'object' } }] } })); }
    if (m.method === 'tools/call') {
      res.setHeader('content-type', 'text/event-stream');
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'http:' + m.params.name }] } })}\n\n`);
    }
  });
});

function hub(env) {
  const child = spawn(process.execPath, [HUB], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let id = 1;
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  const req = (method, params = {}) => new Promise((r) => { const i = id++; waiting.set(i, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { req, close: () => child.kill() };
}

(async () => {
  await new Promise((r) => httpSrv.listen(0, '127.0.0.1', r));
  const cfg = path.join(tmp, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: {
    agentos: { command: process.execPath, args: [stdioSrv], env: { WHO: 'session-s1' } },
    'composio-company': { type: 'http', url: `http://127.0.0.1:${httpSrv.address().port}/mcp`, headers: { 'x-key': 'k1' } },
    broken: { command: '/nonexistent/binary' },
    legacy: { type: 'sse', url: 'http://127.0.0.1:1/sse', headers: {} },
  } }));
  const h = hub({ MCP_CONFIG: cfg });
  const init = await h.req('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'agy' } });
  assert.strictEqual(init.result.serverInfo.name, 'agentric');
  const list = await h.req('tools/list');
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['agentos__recall', 'composio-company__GMAIL_SEND'], 'prefixed tools from the live servers only');
  const a = await h.req('tools/call', { name: 'agentos__recall', arguments: { query: 'x' } });
  assert.strictEqual(a.result.content[0].text, 'stdio:recall:{"query":"x"}:session-s1', 'original name + args + env reach the stdio server');
  const b = await h.req('tools/call', { name: 'composio-company__GMAIL_SEND', arguments: {} });
  assert.strictEqual(b.result.content[0].text, 'http:GMAIL_SEND', 'SSE-framed HTTP response is unwrapped');
  assert.ok(sawSession, 'Mcp-Session-Id is echoed back');
  const c = await h.req('tools/call', { name: 'nope__x' });
  assert.ok(c.error, 'unknown server → JSON-RPC error');
  h.close();

  // Outside a session: an empty, healthy server.
  const env = { ...process.env }; delete env.MCP_CONFIG;
  const h2 = hub({ MCP_CONFIG: '' });
  await h2.req('initialize', { protocolVersion: '2025-03-26' });
  const l2 = await h2.req('tools/list');
  assert.deepStrictEqual(l2.result.tools, []);
  h2.close();

  httpSrv.close();
  console.log('antigravity-mcp-hub-test: ok');
})().catch((e) => { console.error(e); process.exit(1); });
