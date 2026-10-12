#!/usr/bin/env node
/*
 * A remote MCP connector that lost its authorization: caught at the gate, carded to the admins.
 *
 * When a remote MCP server 401s at session start, Claude Code replaces its tools with OAuth stubs
 * (`mcp__<server>__authenticate` / `__complete_authentication`). Live, this was DataForSEO's hosted URL
 * with no auth header (an OAuth grant that expired) and initech's `composio-company` Tool Router. Each
 * time an unattended agent found an `authenticate` tool, could not finish a browser login, and nothing
 * told an admin. The fix has two halves, pinned here:
 *   1. the gate refuses a stub call on an unattended run with a reason the agent can act on, and posts
 *      ONE admin card per connector per cooldown (an attended session passes, since its human can log in);
 *   2. DataForSEO gets catalog entries that run the official server locally over stdio with the API
 *      login from the vault, PINNED (v2→v3 renamed every tool), and npx connectors are pre-fetched
 *      so a cold install (21–35s measured) can't time out a session's MCP startup.
 *
 * Usage:  npm run build && node scripts/connector-auth-stub-test.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-authstub-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const bad = (n, d) => { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m${d ? `\n      ${d}` : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

async function main() {
  const { parseAuthStub, isHostedDataForSeo, authStubRemedy } = require(path.join(ROOT, 'dist/connectors/mcp-auth-stub.js'));
  const { npxSpec, warmNpxConnectors } = require(path.join(ROOT, 'dist/connectors/npx-warm.js'));
  const { CATALOG } = require(path.join(ROOT, 'dist/connectors/connectors.js'));

  console.log('\n\x1b[1m1) Recognising the stub\x1b[0m');
  assert(JSON.stringify(parseAuthStub('mcp__dataforseo__authenticate')) === '{"server":"dataforseo","step":"authenticate"}', 'mcp__dataforseo__authenticate → server dataforseo');
  assert(parseAuthStub('mcp__composio-company__complete_authentication')?.server === 'composio-company', 'a hyphenated server name parses whole');
  assert(parseAuthStub('mcp__dataforseo__serp_organic_live_advanced') === null, 'a real tool is not a stub');
  assert(parseAuthStub('mcp__agentos__authenticate') === null, "the OS's own server is never treated as a connector");
  assert(parseAuthStub(undefined) === null && parseAuthStub('authenticate') === null, 'no tool / bare name → null');
  assert(isHostedDataForSeo('https://mcp.dataforseo.com/v3/mcp') && isHostedDataForSeo('https://mcp.dataforseo.com/mcp'), 'both hosted DataForSEO URLs are recognised');
  assert(!isHostedDataForSeo('https://evil.example/mcp.dataforseo.com') && !isHostedDataForSeo(''), '…and nothing else is');
  assert(/catalog/.test(authStubRemedy({ url: 'https://mcp.dataforseo.com/mcp' })), 'the hosted-DataForSEO remedy points at the catalog entry');

  console.log('\n\x1b[1m2) DataForSEO catalog entries run locally, pinned, with vault creds\x1b[0m');
  for (const [type, ver] of [['dataforseo', /^3\./], ['dataforseo-v2', /^2\./]]) {
    const e = CATALOG.find((c) => c.type === type);
    const spec = e && npxSpec({ transport: e.transport, command: e.command, args: e.args });
    const m = spec && /^dataforseo-mcp-server@(\d+\.\d+\.\d+)$/.exec(spec);
    assert(e?.transport === 'stdio' && m && ver.test(m[1]), `${type}: stdio, exact pinned version (${spec})`);
    assert(e?.fields.map((f) => f.key).join() === 'DATAFORSEO_LOGIN,DATAFORSEO_PASSWORD' && e.fields.every((f) => /secret:/.test(f.placeholder || '')), `${type}: API login + password fields, vault refs suggested`);
  }

  console.log('\n\x1b[1m3) npx pre-fetch\x1b[0m');
  assert(npxSpec({ transport: 'stdio', command: 'npx', args: ['-y', 'resend-mcp'] }) === 'resend-mcp', 'reads the spec after -y');
  assert(npxSpec({ transport: 'stdio', command: 'node', args: ['x.js'] }) === undefined, 'not npx → nothing to warm');
  assert(npxSpec({ transport: 'stdio', command: 'npx', args: ['--registry', 'r', 'pkg'] }) === undefined, 'an option it does not model → no guess');
  const ran = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fake = (spec) => { ran.push(spec); return gate.then(() => true); };
  const conn = (id, args, enabled = true) => ({ id, transport: 'stdio', command: 'npx', args, enabled });
  const started = warmNpxConnectors([conn('a', ['-y', 'p@1.0.0']), conn('b', ['-y', 'p@1.0.0']), conn('c', ['-y', 'q@2.0.0'], false)], undefined, fake);
  assert(started.join() === 'p@1.0.0' && ran.length === 1, 'one fetch per spec; disabled connectors skipped');
  assert(warmNpxConnectors([conn('a', ['-y', 'p@1.0.0'])], undefined, fake).length === 0, 'a spec already in flight is not fetched twice');
  release(); await gate; await new Promise((r) => setImmediate(r));
  assert(warmNpxConnectors([conn('a', ['-y', 'p@1.0.0'])], undefined, fake).length === 1, '…and can be fetched again once it finished');

  console.log('\n\x1b[1m4) The gate\x1b[0m');
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
  const registry = new TenantRegistry(ROOT, 0);
  registry.bootAll();
  const osx = registry.get('testco').os;
  const tm = new TerminalManager(osx, 'http://127.0.0.1:1', path.join(HOME, 'tmux.sock'));
  const db = osx.db;
  osx.connectors.add({ type: 'custom-remote', label: 'DataforSEO', transport: 'http', url: 'https://mcp.dataforseo.com/mcp' });
  const mkSession = (id, headless, claimedBy = null) => db.prepare(
    'INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, secret, headless, claimed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'seo', id, '', id, 'running', 'automation:x', null, 's', headless, claimedBy, Date.now(), Date.now());
  mkSession('s_unattended', 1);
  mkSession('s_unattended2', 1);
  mkSession('s_attended', 0);
  mkSession('s_claimed', 1, 'owner@testco.example');
  const call = (sid, tool) => tm.gate(sid, 'seo', 'connector.call', { tool, input: {} }, 'test');
  const cards = (server) => db.prepare("SELECT title, body, status FROM messages WHERE session_id = ? ORDER BY created_at").all(`system:connector-auth:${server}`);
  const audits = (type) => db.prepare('SELECT data FROM audit_events WHERE type = ?').all(type).map((r) => JSON.parse(r.data));

  const r1 = call('s_unattended', 'mcp__dataforseo__authenticate');
  assert(r1.decision === 'deny' && /lost its authorization/.test(r1.reason) && /Do not retry/.test(r1.reason), 'unattended run: the stub is refused with a reason the agent can act on', JSON.stringify(r1));
  const c1 = cards('dataforseo');
  assert(c1.length === 1 && /DataforSEO \(dataforseo\)/.test(c1[0].title) && /catalog/.test(c1[0].body), 'one admin card naming the connector and the catalog fix', JSON.stringify(c1));
  const lost = audits('connector.auth.lost');
  assert(lost.length === 1 && lost[0].connector === 'dataforseo' && lost[0].unattended === true && lost[0].url === 'https://mcp.dataforseo.com/mcp', 'audited as connector.auth.lost with the URL');

  call('s_unattended2', 'mcp__dataforseo__complete_authentication');
  assert(cards('dataforseo').length === 1, 'a second hit inside the cooldown does not post a second card');
  assert(audits('connector.auth.lost').length === 2, '…but is still audited');

  const r3 = call('s_attended', 'mcp__composio-company__authenticate');
  assert(r3.decision !== 'deny' || !/lost its authorization/.test(r3.reason || ''), 'attended session: not refused by the stub check (its human can log in)', JSON.stringify(r3));
  const cc = cards('composio-company');
  assert(cc.length === 1 && /Composio API key/.test(cc[0].body), '…but the admins still get a card, with the Composio remedy');

  const r4 = call('s_claimed', 'mcp__other__authenticate');
  assert(!/lost its authorization/.test(r4.reason || ''), 'a taken-over (claimed) run counts as attended');

  const r5 = call('s_unattended', 'mcp__dataforseo__serp_organic_live_advanced');
  assert(!/lost its authorization/.test(r5.reason || ''), 'a real connector tool is untouched');

  console.log(`\n${fail === 0 ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m  ${pass} passed, ${fail} failed`);
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); fs.rmSync(HOME, { recursive: true, force: true }); process.exit(1); });
