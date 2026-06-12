/**
 * Agent OS — local web tool. A zero-dependency HTTP server (Node's built-in `http`)
 * that exposes the OS as a small JSON API and serves the browser console.
 *
 * Endpoints:
 *   GET  /                      → the console (public/console.html)
 *   GET  /health                → liveness
 *   GET  /api/state             → tenant, policy, agents, capabilities
 *   GET  /api/runs              → all runs (newest first)
 *   POST /api/runs              → { agentId, inputs } → starts a run, returns { id }
 *   GET  /api/runs/:id          → run + its audit trail + evaluation signal
 *   GET  /api/approvals         → pending approvals (the human queue)
 *   POST /api/approvals/:id     → { approved: boolean } → resolve one
 *
 * No auto-resolver is set here: approvals are YOUR decision, made in the console.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { AgentOS, loadAgentOS } from './kernel';
import { exampleCapabilities } from './capabilities/examples';
import {
  greeterBehavior,
  refunderBehavior,
  refundDeskBehavior,
  opsBehavior,
} from './runtime/mock-adapter';
import { evaluate } from './observability/evaluation';
import { ApprovalRequest, AuditEvent, Run } from './types';

const CONSOLE_HTML = path.resolve(__dirname, '../public/console.html');

/** Build the OS and register the bundled demo world (capabilities + mock agents). */
export function bootstrap(baseDir: string = path.resolve(__dirname, '..')): AgentOS {
  const os = loadAgentOS('config/agent-os.config.json', baseDir);
  os.registerCapabilities(exampleCapabilities);
  os.registerMockBehavior('example-greeter', greeterBehavior);
  os.registerMockBehavior('example-refunder', refunderBehavior);
  os.registerMockBehavior('refund-desk', refundDeskBehavior);
  os.registerMockBehavior('ops', opsBehavior);
  return os;
}

export function createHttpServer(os: AgentOS): http.Server {
  return http.createServer((req, res) => {
    handle(os, req, res).catch((err) =>
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

export function startServer(port = Number(process.env.PORT) || 3010, os: AgentOS = bootstrap()): http.Server {
  const server = createHttpServer(os);
  server.listen(port, () => {
    console.log(`\n  Agent OS console → http://localhost:${port}`);
    console.log(`  tenant=${os.tenant}  policy=${os.policy.id}`);
    console.log(`  agents: ${[...os.agents.keys()].join(', ')}`);
    console.log(`  (approvals are decided by you in the console)\n`);
  });
  return server;
}

async function handle(os: AgentOS, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && (p === '/' || p === '/index.html')) return sendFile(res, CONSOLE_HTML, 'text/html; charset=utf-8');
  if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, tenant: os.tenant });
  if (method === 'GET' && p === '/favicon.ico') return end(res, 204);

  if (method === 'GET' && p === '/api/state') return sendJson(res, 200, state(os));

  if (method === 'GET' && p === '/api/runs') return sendJson(res, 200, os.orchestrator.listRuns().map(runView));
  if (method === 'POST' && p === '/api/runs') {
    const body = await readBody(req);
    const agentId = String(body.agentId || '');
    if (!os.agents.has(agentId)) return sendJson(res, 400, { error: `unknown agent: ${agentId}` });
    const run = os.orchestrator.start({
      tenant: os.tenant,
      agentId,
      trigger: { type: 'manual' },
      inputs: (body.inputs && typeof body.inputs === 'object') ? body.inputs : {},
    });
    return sendJson(res, 200, { id: run.id });
  }

  const runMatch = p.match(/^\/api\/runs\/([\w-]+)$/);
  if (method === 'GET' && runMatch) {
    const run = os.orchestrator.getRun(runMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'run not found' });
    const events = os.memoryAudit.forRun(run.id);
    return sendJson(res, 200, { run: runView(run), events, eval: evaluate(run, events) });
  }

  if (method === 'GET' && p === '/api/approvals') return sendJson(res, 200, os.approvals.pending(os.tenant).map(approvalView));
  const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
  if (method === 'POST' && apMatch) {
    const body = await readBody(req);
    os.approvals.resolve(apMatch[1], !!body.approved, 'console-user');
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: 'not found' });
}

// ── view models ──────────────────────────────────────────────────────────────

function state(os: AgentOS) {
  return {
    tenant: os.tenant,
    policy: os.policy.id,
    agents: [...os.agents.values()].map((m) => ({
      id: m.id,
      description: m.description,
      principal: m.principal,
      budget: m.budget,
    })),
    capabilities: os.registry.list().map((c) => ({ id: c.id, description: c.description, defaultRisk: c.defaultRisk })),
  };
}

function runView(r: Run) {
  return {
    id: r.id,
    agent: r.agent.id,
    version: r.agent.version,
    principal: r.principal,
    status: r.status,
    outcome: r.outcome,
    cost: r.cost,
    inputs: r.inputs,
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function approvalView(a: ApprovalRequest) {
  return {
    id: a.id,
    runId: a.runId,
    level: a.level,
    capability: a.attempt.capabilityId,
    args: a.attempt.args,
    reasoning: a.attempt.reasoning,
    reason: a.reason,
    createdAt: a.createdAt,
  };
}

// ── http helpers ─────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendFile(res: http.ServerResponse, file: string, contentType: string): void {
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: `file not found: ${path.basename(file)}` });
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });
}

function end(res: http.ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

if (require.main === module) startServer();
