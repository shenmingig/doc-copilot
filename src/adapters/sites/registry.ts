// ============================================================
// Site Adapter Registry - Matches URL to adapter
// ============================================================

import { ISiteAdapter } from './types';

class SiteAdapterRegistry {
  private adapters: ISiteAdapter[] = [];

  register(adapter: ISiteAdapter): void {
    if (this.adapters.some(a => a.id === adapter.id)) {
      console.warn(`[Doc Copilot] Site adapter ${adapter.id} already registered, skipping`);
      return;
    }
    this.adapters.push(adapter);
    console.log(`[Doc Copilot] Registered site adapter: ${adapter.id} (${adapter.name})`);
  }

  /**
   * Find matching adapter for current page.
   * Returns the first matching adapter (higher priority ones should be registered first).
   * Falls back to GenericSiteAdapter if no specific adapter matches.
   */
  match(url: string, doc: Document): ISiteAdapter {
    for (const adapter of this.adapters) {
      if (adapter.matches(url, doc)) {
        console.log(`[Doc Copilot] Matched site adapter: ${adapter.id} (${adapter.name})`);
        return adapter;
      }
    }
    // Should never reach here as GenericSiteAdapter should match everything
    throw new Error('[Doc Copilot] No site adapter matched the current page');
  }

  /** Get all registered adapters */
  getAll(): ISiteAdapter[] {
    return [...this.adapters];
  }
}

// Global singleton instance
const registry = new SiteAdapterRegistry();

export { registry as siteAdapterRegistry, SiteAdapterRegistry };
