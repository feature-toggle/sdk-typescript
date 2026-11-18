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
/** Longest wait a `Retry-After` can impose, so an upgrade resumes live updates within the hour. */
const MAX_RETRY_AFTER_MS = 3_600_000;
/** Pings (~16 s apart) a stream must last before the backoff resets: ~1 min. */
const PINGS_BEFORE_RESET = 4;
/** Early closes in a row before warning that something keeps cutting the stream. */
const EARLY_CLOSES_BEFORE_WARNING = 3;

/** `Retry-After` in whole seconds, as the Feature API sends it; null if invalid. */
export function parseRetryAfterMs(value: string | null): number | null {
  // HTTP's delay-seconds is decimal digits only; anything else gets backoff.
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  // 0 would reconnect at once and loop on 429s; fall back to backoff instead.
  return seconds > 0 ? seconds * 1000 : null;
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
  private earlyCloses = 0;

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

  /** Reconnects with backoff; `retryAfterMs` can lengthen the wait, up to an hour. */
  private scheduleReconnect(retryAfterMs: number | null = null): void {
    if (this.closed || !this.running) return;
    this.clearReconnect();
    const delayMs = Math.max(
      this.reconnectDelayMs,
      Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS),
    );
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.connectLoop();
    }, delayMs);
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      MAX_RECONNECT_MS,
    );
  }

  private async connectLoop(): Promise<void> {
    if (this.closed || !this.running) return;

    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    let retryAfterMs: number | null = null;
    let connected = false;
    let pings = 0;

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
          if (event.event === "connected") {
            connected = true;
            // Live again: warn if a new allowance runs out.
            this.warnedRateLimited = false;
          }
          // Held open ~1 min: reset the backoff. A stream cut sooner keeps
          // backing off, since each open costs a sync.
          if (event.event === "ping" && ++pings === PINGS_BEFORE_RESET) {
            this.reconnectDelayMs = INITIAL_RECONNECT_MS;
            this.earlyCloses = 0;
          }
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
        if (
          connected &&
          pings < PINGS_BEFORE_RESET &&
          ++this.earlyCloses === EARLY_CLOSES_BEFORE_WARNING
        ) {
          console.warn(
            "FeatureToggle: live connection keeps closing early (a proxy, a fetch timeout or a flaky network?); reconnects slowed to save syncs",
          );
        }
        this.callbacks.onDisconnect?.();
        this.scheduleReconnect(retryAfterMs);
      }
    }
  }
}
