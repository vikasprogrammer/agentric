/**
 * Terminal-native sessions. Each agent session is a real tmux shell on the box (attachable
 * in the browser via ttyd). Every side effect the session takes is routed through the SAME
 * Agent OS gateway as the console — so even a raw shell can't act on anything risky without
 * a human approving it in the inbox.
 *
 * Governance over a real terminal = the agent-runner / Claude PreToolUse hook calls
 * POST /api/gate before each effect; risky ones become inbox approval cards and BLOCK.
 */
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { AgentOS } from './kernel';
import { ActionAttempt, AuditEvent, Decision, RunContext } from './types';

export interface Session {
  id: string;
  agent: string;
  title: string;
  task: string;
  tmux: string;
  status: 'running' | 'idle';
  createdAt: number;
}

export interface FeedMessage {
  id: string;
  type: 'task' | 'update' | 'approval';
  sessionId: string;
  agent: string;
  title: string;
  body: string;
  status: 'open' | 'pending' | 'approved' | 'rejected';
  approvalId?: string;
  capability?: string;
  args?: unknown;
  level?: string;
  createdAt: number;
}

type GateStatus = 'pending' | 'allow' | 'deny';
type GateResult = { decision: 'allow' | 'deny' | 'pending'; gateId?: string };

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private messages: FeedMessage[] = [];
  private gates = new Map<string, GateStatus>();
  /** Scripted demo runner — for `runtime: mock` agents. */
  private readonly runner = path.resolve(__dirname, '../terminal/agent-runner.sh');
  /** Real-Claude launcher — for `runtime: claude-code` agents. Opens claude in the agent's folder. */
  private readonly launcher = path.resolve(__dirname, '../terminal/claude-launch.sh');
  /** PreToolUse gate hook the launched claude is wired to. */
  private readonly hook = path.resolve(__dirname, '../terminal/gate-hook.sh');

  constructor(
    private readonly os: AgentOS,
    private readonly baseUrl: string,
    private readonly tmuxSocket: string,
  ) {}

  listSessions(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  listMessages(): FeedMessage[] {
    return [...this.messages].sort((a, b) => b.createdAt - a.createdAt);
  }

  createSession(agent: string, title: string, task: string): Session {
    const id = randomUUID().slice(0, 8);
    const tmux = `aos-${id}`;
    const session: Session = { id, agent, title, task, tmux, status: 'running', createdAt: Date.now() };
    this.sessions.set(id, session);
    this.addMessage({ type: 'task', sessionId: id, agent, title: `(New Session) ${agent}`, body: task, status: 'open' });

    // Pick the runtime from the agent's manifest: claude-code → real claude in its folder;
    // anything else (incl. unknown/demo names) → the scripted mock runner.
    const manifest = this.os.agents.get(agent);
    const runtime = manifest?.runtime ?? 'mock';
    this.audit(id, agent, 'session.created', { tmux, task, runtime, dir: manifest?.dir });

    const env =
      `AOS_URL='${this.baseUrl}' SESSION='${id}' AGENT='${agent.replace(/'/g, '')}' ` +
      `TASK_B64='${Buffer.from(task, 'utf8').toString('base64')}'`;

    let cmd: string;
    if (runtime === 'claude-code' && manifest?.dir) {
      // Open a REAL claude session in the agent's own folder, governed by the gate hook.
      cmd = `${env} AGENT_DIR='${manifest.dir}' HOOK='${this.hook}' bash '${this.launcher}'`;
    } else {
      cmd = `${env} bash '${this.runner}'`;
    }

    const args = ['-S', this.tmuxSocket, 'new-session', '-d', '-s', tmux, '-x', '203', '-y', '50', cmd];
    const child = spawn('tmux', args, { stdio: 'ignore' });
    child.on('error', (e) => this.audit(id, agent, 'session.error', { error: String(e) }));
    return session;
  }

  say(sessionId: string, body: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.addMessage({ type: 'update', sessionId, agent: s.agent, title: `Task Update (${s.agent})`, body, status: 'open' });
  }

  /** The gate. Same policy brain as the console — green allows, risky → inbox approval + block. */
  gate(sessionId: string, agent: string, capability: string, args: Record<string, unknown>, reasoning: string): GateResult {
    const attempt: ActionAttempt = { capabilityId: capability, args, reasoning };
    const decision: Decision = this.os.policy.classify(attempt, this.ctx(sessionId, agent));
    this.audit(sessionId, agent, 'gate.attempt', { capability, args, reasoning });
    this.audit(sessionId, agent, 'gate.decision', { capability, decision });

    if (decision.effect === 'allow') return { decision: 'allow' };
    if (decision.effect === 'deny') return { decision: 'deny' };

    const { req, decision: settle } = this.os.approvals.request({
      runId: sessionId,
      tenant: this.os.tenant,
      level: decision.level,
      attempt,
      reason: decision.reason,
    });
    this.gates.set(req.id, 'pending');
    this.addMessage({
      type: 'approval',
      sessionId,
      agent,
      title: `Approval needed — ${capability}`,
      body: reasoning,
      status: 'pending',
      approvalId: req.id,
      capability,
      args,
      level: decision.level,
    });
    this.audit(sessionId, agent, 'approval.requested', { approvalId: req.id, level: decision.level, capability });

    settle.then((approved) => {
      this.gates.set(req.id, approved ? 'allow' : 'deny');
      const m = this.messages.find((x) => x.approvalId === req.id);
      if (m) m.status = approved ? 'approved' : 'rejected';
      this.audit(sessionId, agent, 'approval.resolved', { approvalId: req.id, approved });
    });
    return { decision: 'pending', gateId: req.id };
  }

  gateStatus(id: string): GateStatus {
    return this.gates.get(id) ?? 'deny';
  }

  private addMessage(m: Omit<FeedMessage, 'id' | 'createdAt'>): void {
    this.messages.push({ ...m, id: randomUUID().slice(0, 8), createdAt: Date.now() });
  }

  private audit(sessionId: string, principal: string, type: string, data: Record<string, unknown>): void {
    const ev: AuditEvent = { ts: Date.now(), runId: sessionId, tenant: this.os.tenant, principal, type, data };
    this.os.audit.append(ev);
  }

  /** The JSON policy engine ignores ctx; provide a minimal stand-in to satisfy the type. */
  private ctx(sessionId: string, agent: string): RunContext {
    return {
      run: { id: sessionId, tenant: this.os.tenant, principal: agent } as never,
      secrets: this.os.secrets,
      audit: this.os.audit,
      log: () => undefined,
    } as RunContext;
  }
}
