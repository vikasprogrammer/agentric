/**
 * Idempotency — stops a retried effect from firing twice (the classic "send invoice"
 * double-fire). The key is derived from (run trigger key, capability, args).
 */
import { createHash } from 'crypto';
import { CapabilityResult, IdempotencyStore } from '../types';

/** Stable hash of args regardless of key order. */
export function stableHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v as Record<string, unknown>)
          .sort()
          .reduce((acc, k) => ((acc[k] = (v as Record<string, unknown>)[k]), acc), {} as Record<string, unknown>)
      : v,
  );
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, CapabilityResult>();
  seen(key: string): boolean {
    return this.store.has(key);
  }
  get(key: string): CapabilityResult | undefined {
    return this.store.get(key);
  }
  remember(key: string, result: CapabilityResult): void {
    this.store.set(key, result);
  }
}
