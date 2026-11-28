#!/usr/bin/env node
/**
 * Antigravity MCP hub — ONE stdio MCP server that fronts every MCP server of ONE Agentric session.
 *
 * Why it exists (all verified against agy 1.5.18/1.5.19):
 *   • agy reads MCP servers from the GLOBAL `~/.gemini/config/mcp_config.json` or from a plugin. A
 *     workspace plugin (`<agent>/.agents/plugins/…`) loads in headless `-p` runs but NEVER in the TUI —
 *     its plugin-MCP reload races the sign-in and gives up ("Not reloading plugin MCP servers: cannot
 *     get the signed-in user"), even when the plugin is written after startup.
 *   • every lane we run is the TUI, so the global file is the only one that works — and it is shared by
 *     every session, agent and tenant on the box.
 *   • an MCP server process INHERITS the agy process's environment.
 * So the launcher installs one session-agnostic global entry, `agentric` → this hub, and the hub reads
 * `$MCP_CONFIG` (the session's own per-identity server list, the same file every other runtime gets)
 * from the environment it inherited. Two sessions of the same agent, run as different humans, each see
 * their own connectors; nothing per-session is ever written to a shared file.
 *
 * Tools are re-exported as `<server>__<tool>`, so the gate adapter sees `mcp__agentos__recall` and
 * `mcp__composio-company__…` — the exact names gate-hook.sh already routes for Claude Code.
 *
 * Outside an Agentric session (`$MCP_CONFIG` unset — the box owner running agy for themselves) the hub
 * answers with an empty tool list instead of failing, so the owner's own agy shows no broken server.
 *
 * Transports: stdio (newline-delimited JSON-RPC) and Streamable HTTP. Legacy HTTP+SSE is skipped with a
 * stderr note — agy itself does not speak it either. Zero dependencies, like the rest of the OS.
 */
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');

const SEP = '__';
const INIT_TIMEOUT_MS = Number(process.env.AOS_MCP_HUB_INIT_MS) || 30000;
const CALL_TIMEOUT_MS = Number(process.env.AOS_MCP_HUB_CALL_MS) || 15 * 60_000;
const log = (...a) => { try { process.stderr.write('[agentric-hub] ' + a.join(' ') + '\n'); } catch (_) { /* closed */ } };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function loadServers() {
  const file = process.env.MCP_CONFIG;
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}; } catch (e) { log('cannot read', file, String(e && e.message)); return {}; }
}

/** A downstream stdio server. */
class StdioServer {
  constructor(name, spec) {
    this.name = name; this.nextId = 1; this.waiting = new Map();
    this.child = spawn(spec.command, spec.args || [], { env: { ...process.env, ...(spec.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (e) => this.failAll(e));
    this.child.on('exit', () => this.failAll(new Error(`${name} exited`)));
    this.child.stderr.on('data', (b) => { try { process.stderr.write(b); } catch (_) { /* ignore */ } });
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch (_) { return; }
      if (m && m.id !== undefined && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); w(m); }
    });
  }
  failAll(e) { for (const [, w] of this.waiting) w({ error: { code: -32000, message: String(e && e.message || e) } }); this.waiting.clear(); this.dead = true; }
  request(method, params, timeoutMs) {
    if (this.dead) return Promise.resolve({ error: { code: -32000, message: `${this.name} is not running` } });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(id); resolve({ error: { code: -32001, message: `${this.name}: ${method} timed out` } }); }, timeoutMs);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); } catch (e) { clearTimeout(t); this.waiting.delete(id); resolve({ error: { code: -32000, message: String(e.message) } }); }
    });
  }
  notify(method, params) { try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch (_) { /* ignore */ } }
  close() { try { this.child.kill(); } catch (_) { /* ignore */ } }
}

/** A downstream Streamable-HTTP server (MCP 2025-03-26 transport). */
class HttpServer {
  constructor(name, spec) { this.name = name; this.url = spec.url; this.headers = spec.headers || {}; this.nextId = 1; this.sessionId = null; }
  async post(body, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.headers };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (body.id === undefined) return null;                     // a notification: 202, no body
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) {
        // Read SSE frames until the response carrying our id arrives.
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            let m; try { m = JSON.parse(data); } catch (_) { continue; }
            if (m && m.id === body.id) { try { await reader.cancel(); } catch (_) { /* ignore */ } return m; }
          }
        }
        return { error: { code: -32000, message: `${this.name}: stream ended without a response` } };
      }
      const text = await res.text();
      if (!res.ok) return { error: { code: -32000, message: `${this.name}: HTTP ${res.status} ${text.slice(0, 300)}` } };
      try { return JSON.parse(text); } catch (_) { return { error: { code: -32000, message: `${this.name}: non-JSON response` } }; }
    } catch (e) {
      return { error: { code: -32000, message: `${this.name}: ${ctl.signal.aborted ? 'timed out' : String(e && e.message || e)}` } };
    } finally { clearTimeout(t); }
  }
  request(method, params, timeoutMs) { return this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs); }
  notify(method, params) { void this.post({ jsonrpc: '2.0', method, params }, 10000); }
  close() { /* stateless from our side */ }
}

const downstream = new Map();   // name → { srv, ready: Promise<boolean> }

function start(protocolVersion) {
  for (const [name, spec] of Object.entries(loadServers())) {
    if (!spec || typeof spec !== 'object' || name.includes(SEP)) { if (name.includes(SEP)) log('skipping', name, `(name contains "${SEP}")`); continue; }
    let srv;
    if (spec.url && (spec.type === 'sse')) { log('skipping', name, '(legacy HTTP+SSE transport is not supported)'); continue; }
    if (spec.url) srv = new HttpServer(name, spec);
    else if (spec.command) srv = new StdioServer(name, spec);
    else continue;
    const ready = srv.request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'agentric-hub', version: '1' } }, INIT_TIMEOUT_MS)
      .then((m) => { if (m.error) { log(name, 'initialize failed:', m.error.message); return false; } srv.notify('notifications/initialized', {}); return true; });
    downstream.set(name, { srv, ready });
  }
}

async function listAll() {
  const tools = [];
  await Promise.all([...downstream].map(async ([name, d]) => {
    if (!(await d.ready)) return;
    let cursor;
    for (let page = 0; page < 50; page++) {
      const m = await d.srv.request('tools/list', cursor ? { cursor } : {}, INIT_TIMEOUT_MS);
      if (m.error || !m.result) { if (m.error) log(name, 'tools/list failed:', m.error.message); return; }
      for (const t of m.result.tools || []) tools.push({ ...t, name: `${name}${SEP}${t.name}` });
      cursor = m.result.nextCursor;
      if (!cursor) return;
    }
  }));
  return tools;
}

async function callTool(params) {
  const full = String(params && params.name || '');
  const i = full.indexOf(SEP);
  const d = i > 0 ? downstream.get(full.slice(0, i)) : undefined;
  if (!d) return { error: { code: -32602, message: `unknown tool: ${full}` } };
  if (!(await d.ready)) return { error: { code: -32000, message: `${full.slice(0, i)} failed to start` } };
  return d.srv.request('tools/call', { ...params, name: full.slice(i + SEP.length) }, CALL_TIMEOUT_MS);
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { return; }
  if (!m || typeof m !== 'object') return;
  const reply = (r) => { if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, ...r }); };
  switch (m.method) {
    case 'initialize': {
      const pv = (m.params && m.params.protocolVersion) || '2025-03-26';
      if (!downstream.size) start(pv);
      return reply({ result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'agentric', version: '1' } } });
    }
    case 'tools/list': return reply({ result: { tools: await listAll() } });
    case 'tools/call': { const r = await callTool(m.params); return reply(r.error ? { error: r.error } : { result: r.result }); }
    case 'ping': return reply({ result: {} });
    case 'resources/list': return reply({ result: { resources: [] } });
    case 'resources/templates/list': return reply({ result: { resourceTemplates: [] } });
    case 'prompts/list': return reply({ result: { prompts: [] } });
    default:
      if (m.id !== undefined && m.method) return reply({ error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});

const shutdown = () => { for (const [, d] of downstream) d.srv.close(); process.exit(0); };
process.stdin.on('end', shutdown);
process.on('SIGTERM', shutdown);
