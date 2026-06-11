/**
 * Demo — drives four runs through the gateway to show the trust layer working:
 *   1. GREEN happy path + idempotent retry (effect fires once)
 *   2. APPROVALS — yellow (head approves) vs red (owner declines)
 *   3. BUDGET — hard-stop when per-run cap is hit
 *   4. POLICY DENY — a forbidden capability never executes
 *
 * Everything below is auditable: each run prints the exact append-only audit trail
 * the gateway wrote, plus the Evaluation signal computed from it.
 *
 *   $ npm run demo
 */
import { AgentOS, loadAgentOS } from './kernel';
import { exampleCapabilities } from './capabilities/examples';
import {
  greeterBehavior,
  refunderBehavior,
  spenderBehavior,
  MockBehavior,
} from './runtime/mock-adapter';
import { evaluate } from './observability/evaluation';
import { AuditEvent, Budget, Run, RunRequest } from './types';

const TENANT = 'acme';
const FULL_BUDGET: Budget = { usdCap: 1.0, tokenCap: 200000, wallClockMs: 300000 };

/** Tries a forbidden prod action, then a harmless one — shows deny doesn't crash the run. */
const opsBehavior: MockBehavior = async (_ctx, act) => {
  const denied = await act({ capabilityId: 'prod.restart', args: { service: 'api' }, reasoning: 'restart prod api' });
  await act({ capabilityId: 'echo.run', args: { message: 'carrying on after the denial' }, reasoning: 'note' });
  return { outcome: denied.ok ? 'success' : 'failure', result: { prodRestart: denied.ok } };
};

async function main(): Promise<void> {
  const os = loadAgentOS();
  os.registerCapabilities(exampleCapabilities);

  // Plugin code: agent behaviors.
  os.registerMockBehavior('example-greeter', greeterBehavior);
  os.registerMockBehavior('example-refunder', refunderBehavior);
  os.registerMockBehavior('example-spender', spenderBehavior);
  os.registerMockBehavior('example-ops', opsBehavior);

  // Two agents registered in code; the other two are loaded from config/agents/*.
  os.registerAgent({ id: 'example-spender', version: '1.0.0', description: 'spends until budget stops it', principal: 'svc-worker', policyContext: 'default@v1', runtime: 'mock', budget: FULL_BUDGET });
  os.registerAgent({ id: 'example-ops', version: '1.0.0', description: 'tries a forbidden prod action', principal: 'svc-ops', policyContext: 'default@v1', runtime: 'mock', budget: FULL_BUDGET });

  // Simulate humans at the approval queue: heads approve; the owner (you) declines the big refund.
  os.approvals.setAutoResolver((req) => req.level === 'head');

  divider('1. GREEN — echo + Slack, with an idempotent retry (effect fires once)');
  printRun(os, await os.submit(run('example-greeter', { name: 'Vikas' })));

  divider('2. APPROVALS — $49 refund (yellow→head ✅) vs $5000 refund (red→owner ❌)');
  printRun(os, await os.submit(run('example-refunder', { customer: 'cus_42' })));

  divider('3. BUDGET — $0.02 cap; each action costs $0.01 → hard-stop on the 3rd');
  printRun(os, await os.submit({ ...run('example-spender', {}), budget: { usdCap: 0.02 } }));

  divider('4. POLICY DENY — prod.* is denied outright; the effect never fires');
  printRun(os, await os.submit(run('example-ops', {})));

  divider('CONSOLE SNAPSHOT');
  console.log(`  pending approvals: ${os.approvals.pending(TENANT).length}`);
  console.log(`  live runs:         ${os.monitor.live().length} (all finalized)`);
  console.log(`  total audit events: ${os.memoryAudit.events.length} (also written to data/audit/${TENANT}/)`);
}

function run(agentId: string, inputs: Record<string, unknown>): RunRequest {
  return { tenant: TENANT, agentId, trigger: { type: 'manual' }, inputs };
}

function divider(title: string): void {
  console.log('\n' + '═'.repeat(74));
  console.log('  ' + title);
  console.log('═'.repeat(74));
}

function printRun(os: AgentOS, r: Run): void {
  const events = os.memoryAudit.forRun(r.id);
  console.log(`\n  run ${r.id.slice(0, 8)} · agent=${r.agent.id}@${r.agent.version} · principal=${r.principal}`);
  console.log(`  status=${r.status}  outcome=${r.outcome}  cost=$${r.cost.usd.toFixed(4)} / ${r.cost.tokens} tok`);
  console.log('  audit trail:');
  for (const e of events) console.log(`    ${e.type.padEnd(20)} ${summarize(e)}`);
  const s = evaluate(r, events);
  console.log(
    `  eval → attempted=${s.effectsAttempted} succeeded=${s.effectsSucceeded} ` +
      `approvalsRejected=${s.approvalsRejected} budgetStops=${s.budgetStops} suspicious=${s.suspicious}`,
  );
}

function summarize(e: AuditEvent): string {
  const d = e.data;
  switch (e.type) {
    case 'action.attempt': return `${d.capability} ${json(d.args)}`;
    case 'policy.decision': return effect(d.decision);
    case 'approval.requested': return `level=${d.level}`;
    case 'approval.resolved': return d.approved ? 'APPROVED' : 'REJECTED';
    case 'budget.exceeded': return String(d.reason);
    case 'idempotency.hit': return 'deduped — effect already performed';
    case 'action.result': return `ok=${d.ok} cost=${json(d.cost)}`;
    case 'action.error': return String(d.error);
    case 'run.completed': return `outcome=${d.outcome} cost=${json(d.cost)}`;
    case 'agent.log': return String(d.message);
    default: return '';
  }
}

function effect(decision: unknown): string {
  const dec = decision as { effect: string; level?: string; reason?: string };
  if (dec.effect === 'approve') return `approve (${dec.level}) — ${dec.reason}`;
  if (dec.effect === 'deny') return `DENY — ${dec.reason}`;
  return 'allow';
}

function json(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
