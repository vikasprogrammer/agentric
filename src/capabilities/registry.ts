/**
 * Capability registry — the plugin table. Connectors and dangerous tools register here.
 * The core never imports a brand's connector; it only knows the Capability interface.
 */
import { Capability } from '../types';

export class CapabilityRegistry {
  private caps = new Map<string, Capability>();

  register(cap: Capability): this {
    if (this.caps.has(cap.id)) throw new Error(`capability already registered: ${cap.id}`);
    this.caps.set(cap.id, cap);
    return this;
  }

  registerAll(caps: Capability[]): this {
    for (const c of caps) this.register(c);
    return this;
  }

  get(id: string): Capability | undefined {
    return this.caps.get(id);
  }

  list(): Capability[] {
    return [...this.caps.values()];
  }
}
