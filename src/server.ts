/**
 * Agent OS — local web tool. Zero-dependency HTTP server (Node's built-in `http`) that
 * exposes the OS as a JSON API, serves the browser console, and now hosts terminal-native
 * agent sessions: each session is a real tmux shell, attachable in the browser via ttyd,
 * with every side effect gated through the same Agent OS gateway.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { AgentOS, loadAgentOS } from './kernel';
import { exampleCapabilities } from './capabilities/examples';
import { greeterBehavior, refunderBehavior, refundDeskBehavior, opsBehavior } from './runtime/mock-adapter';
import { evaluate } from './observability/evaluation';
import { TerminalManager } from './terminal';
import { ApprovalRequest, Run } from './types';

const CONSOLE_HTML = path.resolve(__dirname, '../public/console.html');
const WEB_DIST = path.resolve(__dirname, '../web/dist');

/** Agents available for terminal sessions = whatever manifests this instance loaded. */
function terminalAgents(os: AgentOS): { id: string; description: string; runtime: string }[] {
  return [...os.agents.values()].map((a) => ({ id: a.id, description: a.description, runtime: a.runtime }));
}

export function bootstrap(baseDir: string = path.resolve(__dirname, '..')): AgentOS {
  const os = loadAgentOS('config/agent-os.config.json', baseDir);
  os.registerCapabilities(exampleCapabilities);
  os.registerMockBehavior('example-greeter', greeterBehavior);
  os.registerMockBehavior('example-refunder', refunderBehavior);
  os.registerMockBehavior('refund-desk', refundDeskBehavior);
  os.registerMockBehavior('ops', opsBehavior);
  return os;
}

export function createHttpServer(os: AgentOS, tm: TerminalManager): http.Server {
  return http.createServer((req, res) => {
    handle(os, tm, req, res).catch((err) =>
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
    );
  });
}

export function startServer(port = Number(process.env.PORT) || 3010): http.Server {
  const os = bootstrap();
  const paths = os.paths!;
  // Per-instance runtime lives UNDER the data home, so multiple instances never collide.
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.audit, { recursive: true });
  // ttyd defaults to PORT+1 so a single PORT override fully separates two instances.
  const ttydPort = Number(process.env.TTYD_PORT) || port + 1;
  const baseUrl = `http://127.0.0.1:${port}`;
  const tm = new TerminalManager(os, baseUrl, paths.tmuxSocket);
  const ttyd = launchTtyd(paths.tmuxSocket, ttydPort);
  const server = createHttpServer(os, tm);
  server.listen(port, () => {
    console.log(`\n  Agent OS console → http://localhost:${port}`);
    console.log(`  tenant=${os.tenant}  policy=${os.policy.id}  home=${paths.home}`);
    console.log(`  agents: ${terminalAgents(os).map((a) => `${a.id}(${a.runtime})`).join(', ') || '(none)'}`);
    console.log(`  tmux socket: ${paths.tmuxSocket}${ttyd ? '  (ttyd on :' + ttydPort + ')' : '  (ttyd not running)'}\n`);
  });
  server.on('close', () => ttyd?.kill());
  return server;
}

function launchTtyd(tmuxSocket: string, ttydPort: number): ChildProcess | null {
  try {
    // -a: let the browser pass the tmux session name as ?arg=aos-xxxx ; -W: writable (intervene)
    const child = spawn(
      'ttyd',
      ['-p', String(ttydPort), '-i', '127.0.0.1', '-b', '/terminal', '-a', '-W',
       '-t', 'disableLeaveAlert=true', '-t', 'fontSize=14',
       'tmux', '-S', tmuxSocket, 'attach', '-t'],
      { stdio: 'ignore' },
    );
    child.on('error', () => console.log('  (ttyd failed to start — browser terminal disabled)'));
    return child;
  } catch {
    return null;
  }
}

async function handle(os: AgentOS, tm: TerminalManager, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    const idx = path.join(WEB_DIST, 'index.html');
    return sendFile(res, fs.existsSync(idx) ? idx : CONSOLE_HTML, 'text/html; charset=utf-8');
  }
  if (method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true, tenant: os.tenant });
  // static assets from the built React app (web/dist)
  if (method === 'GET' && (p.startsWith('/assets/') || /\.(js|css|svg|png|ico|woff2?|json|map)$/.test(p))) {
    const file = path.join(WEB_DIST, p.replace(/^\/+/, ''));
    if (file.startsWith(WEB_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(res, file, mime(file));
    return end(res, 404);
  }
  if (method === 'GET' && p === '/favicon.ico') return end(res, 204);

  if (method === 'GET' && p === '/api/state') {
    const agents = terminalAgents(os);
    return sendJson(res, 200, {
      tenant: os.tenant,
      policy: os.policy.id,
      home: os.paths?.home,
      terminalAgents: agents.map((a) => a.id), // back-compat: existing UI lists ids
      agents, // richer: { id, description, runtime }
      capabilities: os.registry.list().map((c) => ({ id: c.id, description: c.description, defaultRisk: c.defaultRisk })),
    });
  }

  // ── terminal-native sessions ────────────────────────────────────────────────
  if (method === 'GET' && p === '/api/sessions') return sendJson(res, 200, tm.listSessions());
  if (method === 'POST' && p === '/api/sessions') {
    const b = await readBody(req);
    const agent = String(b.agent || '').trim();
    const task = String(b.task || '').trim();
    if (!agent || !task) return sendJson(res, 400, { error: 'agent and task are required' });
    const s = tm.createSession(agent, String(b.title || task), task);
    return sendJson(res, 200, { id: s.id, tmux: s.tmux });
  }
  const sayMatch = p.match(/^\/api\/sessions\/([\w-]+)\/say$/);
  if (method === 'POST' && sayMatch) {
    const b = await readBody(req);
    tm.say(sayMatch[1], String(b.body || ''));
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/messages') return sendJson(res, 200, tm.listMessages());

  if (method === 'POST' && p === '/api/gate') {
    const b = await readBody(req);
    const result = tm.gate(
      String(b.sessionId || ''),
      String(b.agent || ''),
      String(b.capability || ''),
      (b.args && typeof b.args === 'object') ? b.args : {},
      String(b.reasoning || ''),
    );
    return sendJson(res, 200, result);
  }
  const gateMatch = p.match(/^\/api\/gate\/([\w-]+)$/);
  if (method === 'GET' && gateMatch) return sendJson(res, 200, { status: tm.gateStatus(gateMatch[1]) });

  // ── approvals (shared with the console) ──────────────────────────────────────
  if (method === 'GET' && p === '/api/approvals') return sendJson(res, 200, os.approvals.pending(os.tenant).map(approvalView));
  const apMatch = p.match(/^\/api\/approvals\/([\w-]+)$/);
  if (method === 'POST' && apMatch) {
    const b = await readBody(req);
    os.approvals.resolve(apMatch[1], !!b.approved, 'console-user');
    return sendJson(res, 200, { ok: true });
  }

  // ── classic mock runs (kept for the demo) ────────────────────────────────────
  if (method === 'GET' && p === '/api/runs') return sendJson(res, 200, os.orchestrator.listRuns().map(runView));
  const runMatch = p.match(/^\/api\/runs\/([\w-]+)$/);
  if (method === 'GET' && runMatch) {
    const run = os.orchestrator.getRun(runMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'run not found' });
    const events = os.memoryAudit.forRun(run.id);
    return sendJson(res, 200, { run: runView(run), events, eval: evaluate(run, events) });
  }

  sendJson(res, 404, { error: 'not found' });
}

function runView(r: Run) {
  return { id: r.id, agent: r.agent.id, status: r.status, outcome: r.outcome, cost: r.cost, createdAt: r.createdAt };
}
function approvalView(a: ApprovalRequest) {
  return { id: a.id, runId: a.runId, level: a.level, capability: a.attempt.capabilityId, args: a.attempt.args, reason: a.reason };
}

// ── http helpers ─────────────────────────────────────────────────────────────
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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
function mime(file: string): string {
  const e = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
    '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  };
  return map[e] || 'application/octet-stream';
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
