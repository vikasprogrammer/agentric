/**
 * Identity — the agent acts AS a principal (a service account), not as "whoever holds
 * the key". This is distinct from Secrets (the vault). Audit records the principal.
 *
 * The default impl is a no-op stub: it just echoes the principal. A real impl would
 * mint a short-lived, least-privilege credential (e.g. STS token, scoped OAuth) for
 * the (tenant, principal) pair and hand it to the Secrets vault.
 */
import { Identity } from '../types';

export class StubIdentity implements Identity {
  async assume(principal: string, _tenant: string): Promise<{ principal: string }> {
    return { principal };
  }
}
