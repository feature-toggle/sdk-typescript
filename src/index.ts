import { defaultFetch, type FetchFn } from "./shared/fetch-features.js";
import { FeatureStreamClient } from "./shared/feature-stream.js";
import { FeatureStore } from "./shared/feature-store.js";
import { loadFeatures } from "./shared/load-features.js";
import { createScopeWarner } from "./shared/scope-warn.js";
import type { FeatureResponse, GetFeaturesOptions } from "./shared/types.js";
import {
  getVisibilitySource,
  type VisibilitySource,
} from "./shared/visibility.js";

export type { FeatureResponse } from "./shared/types.js";

export type FeatureToggleOptions = {
  apiKey: string;
  /** SSE transport — default `auto`. */
  stream?: "auto" | "notify" | "off";
  fetch?: FetchFn;
  visibility?: VisibilitySource | null;
  /** Seed cache before `init()` — hooks can start with data. */
  initialFeatures?: FeatureResponse[];
  initialEtag?: string;
};

export class FeatureToggle {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly streamMode: "auto" | "notify" | "off";
  private readonly store = new FeatureStore();
  private readonly visibility: VisibilitySource | null;
  private readonly warnScopeOnce = createScopeWarner();
  private readonly listeners = new Set<() => void>();

  private visibilityHandler: (() => void) | null = null;
  private transportStopped = false;
  private streamClient: FeatureStreamClient | null = null;
  private lastStreamVersion: number | null = null;

  constructor(options: FeatureToggleOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? defaultFetch;
    this.streamMode = options.stream ?? "auto";
    this.visibility =
      options.visibility === undefined
        ? getVisibilitySource()
        : options.visibility;

    if (options.initialFeatures !== undefined) {
      this.store.update(options.initialFeatures, options.initialEtag ?? null);
    }
  }

  async init(): Promise<void> {
    this.transportStopped = false;
    await this.loadFeatures({ throwOnError: true });
    this.startTransport();
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.transportStopped = true;
    this.removeVisibilityListener();
    this.streamClient?.close();
    this.streamClient = null;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async loadFeatures(options: {
    throwOnError: boolean;
    omitIfNoneMatch?: boolean;
    streamFeaturesVersion?: number;
  }): Promise<void> {
    const result = await loadFeatures(this.fetchFn, this.apiKey, this.store, {
      throwOnError: options.throwOnError,
      omitIfNoneMatch: options.omitIfNoneMatch,
      streamFeaturesVersion: options.streamFeaturesVersion,
      on401: () => this.handle401(),
      on403: (message) => this.warnScopeOnce(message),
    });

    if (result.ok && !result.notModified) {
      this.notifyListeners();
    }
  }

  private handle401(): void {
    console.warn("FeatureToggle: API key unauthorized; cache cleared");
    this.store.clear();
    this.transportStopped = true;
    this.removeVisibilityListener();
    this.streamClient?.close();
    this.streamClient = null;
    this.notifyListeners();
  }

  private startTransport(): void {
    this.removeVisibilityListener();
    this.setupVisibilityListener();
    this.startStream();
  }

  private startStream(): void {
    if (this.streamMode === "off" || this.transportStopped) return;

    this.lastStreamVersion = null;
    this.streamClient?.close();
    this.streamClient = new FeatureStreamClient(this.fetchFn, this.apiKey, {
      onFeaturesChanged: (featuresVersion) => {
        void this.handleStreamVersion(featuresVersion);
      },
    });
    this.streamClient.start();
  }

  private async handleStreamVersion(featuresVersion: number): Promise<void> {
    if (this.lastStreamVersion !== null && featuresVersion <= this.lastStreamVersion) {
      return;
    }
    this.lastStreamVersion = featuresVersion;

    const cachedVersion = this.store.getFeaturesVersion();
    if (cachedVersion !== null && featuresVersion < cachedVersion) {
      return;
    }

    if (this.streamMode === "auto") {
      await this.loadFeatures({
        throwOnError: false,
        omitIfNoneMatch: true,
        streamFeaturesVersion: featuresVersion,
      });
      return;
    }

    this.notifyListeners();
  }

  private setupVisibilityListener(): void {
    if (!this.visibility || this.visibilityHandler) return;

    this.visibilityHandler = () => {
      if (this.visibility?.hidden) return;
      void this.refresh();
    };

    this.visibility.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private removeVisibilityListener(): void {
    if (!this.visibility || !this.visibilityHandler) return;
    this.visibility.removeEventListener(
      "visibilitychange",
      this.visibilityHandler,
    );
    this.visibilityHandler = null;
  }
}
