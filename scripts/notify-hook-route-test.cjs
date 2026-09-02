#!/usr/bin/env node
/* The Claude Code Notification hook must reach its handler.
 *
 * `terminal/notify-hook.sh` posts {sessionId, agent, kind, message} to POST /api/notify — that is how
 * "Claude needs you" (a permission prompt, an idle wait, `agent_needs_input`) becomes an inbox card.
 *
 * From 2026-07-10 (v0.95.0) the `notify` MCP tool added a SECOND POST /api/notify above it, reading
 * `b.session`. Routes match in order, so the tool's route swallowed every hook post, read an empty
 * session and returned 404 — and the hook is fail-open, so it was silent. Live instapods: `session.notified`
 * fired ZERO times in 30 days, and all 26 notification cards ever came from other paths.
 *
 * Retiring the unused `notify` tool removes the shadow. This pins that the hook's payload is handled, so
 * a future second route on the same path fails here instead of silently eating the signal again. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-notify-route-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));

(async () => {
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos } = registry.default();
  const secret = 'hooksecret';
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,secret,created_at,updated_at) VALUES ('ses_hook','engineer','t','t','aos-ses_hook','running',1,'m_o',?,?,?)")
    .run(secret, Date.now(), Date.now());

  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Exactly what terminal/notify-hook.sh sends.
  const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aos-secret': secret, 'x-aos-tenant': aos.tenant },
    body: JSON.stringify({ sessionId: 'ses_hook', agent: 'engineer', kind: 'agent_needs_input', message: 'Claude needs your input' }),
  });
  console.log('\nthe Notification hook reaches its handler\n');
  assert(res.status !== 404, 'the hook payload is not 404d by another route on the same path', `status ${res.status}`);
  assert(res.ok, 'the hook post succeeds', `status ${res.status}`);

  const audited = aos.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE run_id='ses_hook' AND type='session.notified'").get().n;
  assert(audited === 1, 'it audits session.notified — the trace that was missing for two months', `got ${audited}`);
  const card = aos.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='ses_hook' AND type='notification'").get().n;
  assert(card === 1, 'and raises the inbox card the operator is meant to see', `got ${card}`);

  await new Promise((r) => server.close(r));
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
