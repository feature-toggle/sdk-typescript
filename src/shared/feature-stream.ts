import { API_BASE_URL } from "./constants.js";
import type { FetchFn } from "./fetch-features.js";
import {
  type ParsedSseEvent,
  parseSseChunk,
  readFeaturesVersionFromEventData,
} from "./sse-parse.js";

export type FeatureStreamCallbacks = {
  onEvent?: (event: ParsedSseEvent) => void;
  onFeaturesChanged: (featuresVersion: number) => void;
  onDisconnect?: () => void;
};

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
/** setTimeout fires immediately above this, so longer waits are re-armed. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** `Retry-After` in seconds, as the Feature API sends it; null if invalid. */
export function parseRetryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  // 0 would reconnect at once and loop on 429s; fall back to backoff instead.
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export class FeatureStreamClient {
  private readonly fetchFn: FetchFn;
  private readonly apiKey: string;
  private readonly callbacks: FeatureStreamCallbacks;
  private abortController: AbortController | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private closed = false;
  private running = false;
  private warnedRateLimited = false;

  constructor(
    fetchFn: FetchFn,
    apiKey: string,
    callbacks: FeatureStreamCallbacks,
  ) {
    this.fetchFn = fetchFn;
    this.apiKey = apiKey;
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.closed || this.running) return;
    this.running = true;
    void this.connectLoop();
  }

  close(): void {
    this.closed = true;
    this.running = false;
    this.clearReconnect();
    this.abortController?.abort();
    this.abortController = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /** Reconnects after `retryAfterMs` when given, otherwise with backoff. */
  private scheduleReconnect(retryAfterMs: number | null = null): void {
    if (this.closed || !this.running) return;
    this.clearReconnect();
    if (retryAfterMs !== null) {
      this.reconnectAt(Date.now() + retryAfterMs);
      return;
    }
    this.reconnectAt(Date.now() + this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      MAX_RECONNECT_MS,
    );
  }

  private reconnectAt(at: number): void {
    const remaining = Math.max(0, at - Date.now());
    this.reconnectTimeout = setTimeout(
      () => {
        this.reconnectTimeout = null;
        if (Date.now() < at) {
          this.reconnectAt(at);
          return;
        }
        void this.connectLoop();
      },
      Math.min(remaining, MAX_TIMEOUT_MS),
    );
  }

  private async connectLoop(): Promise<void> {
    if (this.closed || !this.running) return;

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    let retryAfterMs: number | null = null;

    try {
      const response = await this.fetchFn(
        `${API_BASE_URL}/v1/features/stream`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: abortController.signal,
        },
      );

      if (!response.ok || !response.body) {
        // Sync allowance used up: wait until it resets instead of retrying.
        if (response.status === 429) {
          retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
          if (!this.warnedRateLimited) {
            this.warnedRateLimited = true;
            console.warn(
              "FeatureToggle: sync allowance used up; live updates paused until it resets",
            );
          }
        }
        return; // `finally` reconnects.
      }

      this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!this.closed && this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.remainder;

        for (const event of parsed.events) {
          this.callbacks.onEvent?.(event);
          if (
            event.event === "features-changed" ||
            event.event === "connected"
          ) {
            const version = readFeaturesVersionFromEventData(event.data);
            if (version !== null) {
              this.callbacks.onFeaturesChanged(version);
            }
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.warn("FeatureToggle: feature stream disconnected", error);
    } finally {
      if (!this.closed && this.running && !abortController.signal.aborted) {
        this.callbacks.onDisconnect?.();
        this.scheduleReconnect(retryAfterMs);
      }
    }
  }
}
