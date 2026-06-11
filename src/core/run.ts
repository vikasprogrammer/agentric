import { randomUUID } from 'crypto';
import { AgentManifest, Budget, Run, RunRequest } from '../types';

/** Build a fresh Run from a request + the agent's manifest. Caps come from the
 *  manifest unless the request overrides them. Records the versions it bound to. */
export function newRun(req: RunRequest, manifest: AgentManifest): Run {
  const budget: Budget = { ...manifest.budget, ...(req.budget ?? {}) };
  const now = Date.now();
  const id = randomUUID();
  return {
    id,
    tenant: req.tenant,
    agent: { id: manifest.id, version: manifest.version },
    trigger: req.trigger,
    principal: req.principal ?? manifest.principal,
    inputs: req.inputs,
    budget,
    policyContext: manifest.policyContext,
    workspace: `data/workspaces/${req.tenant}/${id}`,
    status: 'pending',
    outcome: 'unknown',
    cost: { usd: 0, tokens: 0 },
    createdAt: now,
    updatedAt: now,
  };
}
