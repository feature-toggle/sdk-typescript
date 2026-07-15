import { FeatureStore } from "./shared/feature-store.js";
import { defaultFetch, type FetchFn } from "./shared/fetch-features.js";
import { loadFeatures } from "./shared/load-features.js";
import { createScopeWarner } from "./shared/scope-warn.js";
import type { FeatureResponse, GetFeaturesOptions } from "./shared/types.js";

export type { FeatureResponse } from "./shared/types.js";

export type FeatureToggleServerOptions = {
  apiKey: string;
  fetch?: FetchFn;
};

export class FeatureToggleServer {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly store = new FeatureStore();
  private readonly warnScopeOnce = createScopeWarner();

  constructor(options: FeatureToggleServerOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? defaultFetch;
  }

  async init(): Promise<void> {
    await this.loadFeatures({ throwOnError: true });
  }

  async refresh(): Promise<void> {
    await this.loadFeatures({ throwOnError: false });
  }

  isEnabled(key: string): boolean {
    return this.store.isEnabled(key);
  }

  getValue<T>(key: string): T | undefined {
    return this.store.getValue<T>(key);
  }

  getFeatures(options?: GetFeaturesOptions): FeatureResponse[] {
    return this.store.getFeatures(options);
  }

  private async loadFeatures(options: {
    throwOnError: boolean;
  }): Promise<void> {
    await loadFeatures(this.fetchFn, this.apiKey, this.store, {
      throwOnError: options.throwOnError,
      on401: () => this.handle401(),
      on403: (message) => this.warnScopeOnce(message),
    });
  }

  private handle401(): void {
    console.warn("FeatureToggle: API key unauthorized; cache cleared");
    this.store.clear();
  }
}
