import { FeatureStore } from "./shared/feature-store.js";
import { FeatureStreamClient } from "./shared/feature-stream.js";
import { defaultFetch, type FetchFn } from "./shared/fetch-features.js";
import { loadFeatures } from "./shared/load-features.js";
import { PollScheduler } from "./shared/poll-scheduler.js";
import {
  coalesceServerPollHeader,
  resolvePollIntervalSec,
} from "./shared/resolve-poll-interval.js";
import { createScopeWarner } from "./shared/scope-warn.js";
import type {
  FeatureResponse,
  FetchFeaturesResult,
  GetFeaturesOptions,
} from "./shared/types.js";
import {
  getVisibilitySource,
  type VisibilitySource,
} from "./shared/visibility.js";

export type { FeatureResponse } from "./shared/types.js";

export type FeatureToggleOptions = {
  apiKey: string;
  /** SSE transport — default `auto`. */
  stream?: "auto" | "notify" | "off";
  /** Poll interval in seconds — only when `stream: 'off'`; `0` disables timer. */
  pollInterval?: number;
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
  private readonly pollIntervalOption?: number;
  private readonly store = new FeatureStore();
  private readonly visibility: VisibilitySource | null;
  private readonly pollScheduler: PollScheduler;
  private readonly warnScopeOnce = createScopeWarner();
  private readonly listeners = new Set<() => void>();

  private visibilityHandler: (() => void) | null = null;
  private transportStopped = false;
  private streamClient: FeatureStreamClient | null = null;
  private lastStreamVersion: number | null = null;
  private loadInFlight: Promise<FetchFeaturesResult> | null = null;
  private effectivePollIntervalSec = 0;
  private serverPollIntervalSec: number | null = null;
  private transportActive = false;
  private warnedPollIntervalIgnored = false;
  private warnedInvalidPollInterval = false;

  constructor(options: FeatureToggleOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? defaultFetch;
    this.streamMode = options.stream ?? "auto";
    this.pollIntervalOption = this.normalizePollIntervalOption(
      options.pollInterval,
    );
    this.visibility =
      options.visibility === undefined
        ? getVisibilitySource()
        : options.visibility;
    this.pollScheduler = new PollScheduler(this.visibility);

    if (
      options.pollInterval !== undefined &&
      this.streamMode !== "off" &&
      !this.warnedPollIntervalIgnored
    ) {
      this.warnedPollIntervalIgnored = true;
      console.warn(
        "FeatureToggle: pollInterval is only used when stream is 'off'",
      );
    }

    if (options.initialFeatures !== undefined) {
      this.store.update(options.initialFeatures, options.initialEtag ?? null);
    }
  }

  async init(): Promise<void> {
    this.transportStopped = false;
    this.serverPollIntervalSec = null;
    const result = await this.loadFeatures({ throwOnError: true });
    this.startTransport(result);
    this.transportActive = true;
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
    this.transportActive = false;
    this.pollScheduler.stop();
    this.removeVisibilityListener();
    this.streamClient?.close();
    this.streamClient = null;
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private normalizePollIntervalOption(
    value: number | undefined,
  ): number | undefined {
    if (value === undefined) return undefined;
    if (value === 0) return 0;
    if (!Number.isFinite(value) || value < 0) {
      if (!this.warnedInvalidPollInterval) {
        this.warnedInvalidPollInterval = true;
        console.warn(
          "FeatureToggle: invalid pollInterval; falling back to default resolution",
        );
      }
      return undefined;
    }
    return value;
  }

  private getEnvPollInterval(): string | undefined {
    const proc = (
      globalThis as { process?: { env?: Record<string, string | undefined> } }
    ).process;
    return proc?.env?.FT_POLL_INTERVAL;
  }

  private resolveIntervalFromResponse(pollIntervalSec: number | null): number {
    const coalesced = coalesceServerPollHeader(
      pollIntervalSec,
      this.serverPollIntervalSec,
    );
    this.serverPollIntervalSec = coalesced.lastServerOverrideSec;

    return resolvePollIntervalSec({
      stream: this.streamMode,
      pollInterval: this.pollIntervalOption,
      envPollInterval: this.getEnvPollInterval(),
      serverHeaderSec: coalesced.serverHeaderSec,
    });
  }

  private syncPollTransport(intervalSec: number): void {
    if (this.streamMode !== "off" || this.transportStopped) return;

    const unchanged =
      intervalSec === this.effectivePollIntervalSec &&
      (intervalSec === 0
        ? !this.pollScheduler.isRunning()
        : this.pollScheduler.isRunning());

    if (unchanged) {
      if (intervalSec === 0) {
        this.setupVisibilityListener();
      }
      return;
    }

    this.effectivePollIntervalSec = intervalSec;

    if (intervalSec > 0) {
      this.removeVisibilityListener();
      if (this.pollScheduler.isRunning()) {
        this.pollScheduler.reschedule(intervalSec);
      } else {
        this.pollScheduler.start(intervalSec, async () => {
          await this.loadFeatures({ throwOnError: false });
        });
      }
      return;
    }

    this.pollScheduler.stop();
    this.setupVisibilityListener();
  }

  private applyPollIntervalFromResult(result: FetchFeaturesResult): void {
    if (!result.ok) return;
    const next = this.resolveIntervalFromResponse(result.pollIntervalSec);
    this.syncPollTransport(next);
  }

  private loadFeatures(options: {
    throwOnError: boolean;
    omitIfNoneMatch?: boolean;
    streamFeaturesVersion?: number;
  }): Promise<FetchFeaturesResult> {
    if (this.loadInFlight) {
      return this.loadInFlight;
    }

    this.loadInFlight = this.doLoadFeatures(options).finally(() => {
      this.loadInFlight = null;
    });
    return this.loadInFlight;
  }

  private async doLoadFeatures(options: {
    throwOnError: boolean;
    omitIfNoneMatch?: boolean;
    streamFeaturesVersion?: number;
  }): Promise<FetchFeaturesResult> {
    const result = await loadFeatures(this.fetchFn, this.apiKey, this.store, {
      throwOnError: options.throwOnError,
      omitIfNoneMatch: options.omitIfNoneMatch,
      streamFeaturesVersion: options.streamFeaturesVersion,
      on401: () => this.handle401(),
      on403: (message) => this.warnScopeOnce(message),
    });

    if (result.ok && this.transportActive) {
      this.applyPollIntervalFromResult(result);
    }

    if (result.ok && !result.notModified) {
      this.notifyListeners();
    }

    return result;
  }

  private handle401(): void {
    console.warn("FeatureToggle: API key unauthorized; cache cleared");
    this.store.clear();
    this.transportStopped = true;
    this.transportActive = false;
    this.pollScheduler.stop();
    this.removeVisibilityListener();
    this.streamClient?.close();
    this.streamClient = null;
    this.notifyListeners();
  }

  private startTransport(initResult?: FetchFeaturesResult): void {
    this.pollScheduler.stop();
    this.removeVisibilityListener();

    if (this.transportStopped) return;

    if (this.streamMode === "off") {
      const headerSec =
        initResult?.ok === true ? initResult.pollIntervalSec : null;
      const interval = this.resolveIntervalFromResponse(headerSec);
      this.syncPollTransport(interval);
      return;
    }

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
    if (
      this.lastStreamVersion !== null &&
      featuresVersion <= this.lastStreamVersion
    ) {
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

  private shouldUseFocusRefetch(): boolean {
    if (!this.visibility) return false;
    if (this.streamMode !== "off") return true;
    return this.effectivePollIntervalSec === 0;
  }

  private setupVisibilityListener(): void {
    const visibility = this.visibility;
    if (
      !visibility ||
      !this.shouldUseFocusRefetch() ||
      this.visibilityHandler
    ) {
      return;
    }

    this.visibilityHandler = () => {
      if (visibility.hidden) return;
      void this.refresh();
    };

    visibility.addEventListener("visibilitychange", this.visibilityHandler);
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
