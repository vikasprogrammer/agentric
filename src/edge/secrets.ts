/**
 * Secrets vault — stores/injects credentials, namespaced by tenant + principal so
 * brands are isolated. This is the VAULT, not the Identity (who acts). Capabilities
 * read secrets inside the gateway boundary; agents never see raw keys.
 *
 * Env lookup order:  <TENANT>__<PRINCIPAL>__<KEY>  →  <TENANT>__<KEY>  →  <KEY>
 * (principal/tenant upper-cased, non-alphanumerics → underscore)
 */
import { SecretsVault } from '../types';

function norm(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

export class EnvSecretsVault implements SecretsVault {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(tenant: string, principal: string, key: string): Promise<string | undefined> {
    const candidates = [
      `${norm(tenant)}__${norm(principal)}__${norm(key)}`,
      `${norm(tenant)}__${norm(key)}`,
      norm(key),
    ];
    for (const c of candidates) if (this.env[c] !== undefined) return this.env[c];
    return undefined;
  }
}
