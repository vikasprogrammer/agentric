/**
 * Orchestrator — the kernel. Owns the Run lifecycle: accept → execute → finalize.
 * It does NOT decide when to start (Triggers) or whether an action is allowed (Policy);
 * it wires a run to its runtime adapter and hands the adapter a gateway-bound `act`.
 */
import {
  Act,
  AgentManifest,
  AuditEvent,
  AuditSink,
  Run,
  RunContext,
  RunRequest,
  RuntimeAdapter,
  SecretsVault,
} from '../types';
import { Gateway } from '../gateway/gateway';
import { HealthMonitor } from '../observability/monitor';
import { newRun } from './run';

export interface OrchestratorDeps {
  gateway: Gateway;
  audit: AuditSink;
  secrets: SecretsVault;
  monitor: HealthMonitor;
  agents: Map<string, AgentManifest>;
  adapters: Map<AgentManifest['runtime'], RuntimeAdapter>;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async submit(req: RunRequest): Promise<Run> {
    const manifest = this.deps.agents.get(req.agentId);
    if (!manifest) throw new Error(`unknown agent: ${req.agentId}`);
    const adapter = this.deps.adapters.get(manifest.runtime);
    if (!adapter) throw new Error(`no runtime adapter for: ${manifest.runtime}`);

    const run = newRun(req, manifest);
    const ctx: RunContext = {
      run,
      secrets: this.deps.secrets,
      audit: this.deps.audit,
      log: (message, data) =>
        this.deps.audit.append(event(run, 'agent.log', { message, ...(data ?? {}) })),
    };
    const act: Act = this.deps.gateway.actorFor(ctx);

    this.deps.audit.append(
      event(run, 'run.created', {
        agent: run.agent,
        trigger: run.trigger,
        budget: run.budget,
        policyContext: run.policyContext,
      }),
    );

    run.status = 'running';
    run.updatedAt = Date.now();
    this.deps.monitor.beat(run.id, manifest.id);
    this.deps.audit.append(event(run, 'run.started', {}));

    try {
      const { outcome, result } = await adapter.run(run, ctx, act, manifest);
      run.outcome = outcome;
      run.status = 'completed';
      run.updatedAt = Date.now();
      this.deps.audit.append(event(run, 'run.completed', { outcome, cost: run.cost, result }));
    } catch (err) {
      run.status = 'failed';
      run.outcome = 'failure';
      run.error = err instanceof Error ? err.message : String(err);
      run.updatedAt = Date.now();
      this.deps.audit.append(event(run, 'run.failed', { error: run.error }));
    } finally {
      this.deps.monitor.clear(run.id);
    }
    return run;
  }
}

function event(run: Run, type: string, data: Record<string, unknown>): AuditEvent {
  return { ts: Date.now(), runId: run.id, tenant: run.tenant, principal: run.principal, type, data };
}
