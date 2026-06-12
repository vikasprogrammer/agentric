/**
 * Orchestrator — the kernel. Owns the Run lifecycle: accept → execute → finalize.
 * It does NOT decide when to start (Triggers) or whether an action is allowed (Policy);
 * it wires a run to its runtime adapter and hands the adapter a gateway-bound `act`.
 *
 * Two entry points:
 *   - submit(req): runs to completion and resolves with the final Run (demo/tests).
 *   - start(req):  returns the Run immediately and runs in the background (the server,
 *                  so an HTTP call doesn't block while a run waits for approval).
 * Runs are kept in an in-memory registry so the Console can list/inspect them.
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

interface Prepared {
  run: Run;
  manifest: AgentManifest;
  adapter: RuntimeAdapter;
}

export class Orchestrator {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Run to completion (used by the demo + tests). */
  async submit(req: RunRequest): Promise<Run> {
    const prepared = this.prepare(req);
    await this.execute(prepared);
    return prepared.run;
  }

  /** Fire-and-forget: return the Run immediately, execute in the background. */
  start(req: RunRequest): Run {
    const prepared = this.prepare(req);
    void this.execute(prepared).catch(() => undefined);
    return prepared.run;
  }

  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  listRuns(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private prepare(req: RunRequest): Prepared {
    const manifest = this.deps.agents.get(req.agentId);
    if (!manifest) throw new Error(`unknown agent: ${req.agentId}`);
    const adapter = this.deps.adapters.get(manifest.runtime);
    if (!adapter) throw new Error(`no runtime adapter for: ${manifest.runtime}`);

    const run = newRun(req, manifest);
    this.runs.set(run.id, run);
    this.deps.audit.append(
      event(run, 'run.created', {
        agent: run.agent,
        trigger: run.trigger,
        budget: run.budget,
        policyContext: run.policyContext,
      }),
    );
    return { run, manifest, adapter };
  }

  private async execute({ run, manifest, adapter }: Prepared): Promise<void> {
    const ctx: RunContext = {
      run,
      secrets: this.deps.secrets,
      audit: this.deps.audit,
      log: (message, data) =>
        this.deps.audit.append(event(run, 'agent.log', { message, ...(data ?? {}) })),
    };
    const act: Act = this.deps.gateway.actorFor(ctx);

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
  }
}

function event(run: Run, type: string, data: Record<string, unknown>): AuditEvent {
  return { ts: Date.now(), runId: run.id, tenant: run.tenant, principal: run.principal, type, data };
}
