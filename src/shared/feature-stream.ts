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
/** Most a `Retry-After` wait is stretched at random, as a fraction of it. */
const RETRY_AFTER_SPREAD = 0.1;
/** Pings (~16 s apart) a stream must last before the backoff resets: ~1 min. */
const PINGS_BEFORE_RESET = 4;
/** Early closes in a row before warning that something keeps cutting the stream. */
const EARLY_CLOSES_BEFORE_WARNING = 3;
/** Longest API reason a `429` warning prints. */
const MAX_REASON_LENGTH = 200;

/** `Retry-After` in whole seconds, as the Feature API sends it; null if invalid. */
export function parseRetryAfterMs(value: string | null): number | null {
  // HTTP's delay-seconds is decimal digits only; anything else gets backoff.
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const ms = Number(value) * 1000;
  // 0 would reconnect at once and loop on 429s, and a huge value overflows
  // to Infinity; fall back to backoff for both.
  return ms > 0 && Number.isFinite(ms) ? ms : null;
}

/** The `error` text of a JSON error body, trimmed and capped; null if there's none. */
async function readErrorReason(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const error = (body as { error?: unknown }).error;
    if (typeof error !== "string") return null;
    return error.trim().slice(0, MAX_REASON_LENGTH) || null;
  } catch {
    return null;
  }
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
  /** A number in [0, 1); tests pass a fixed one. */
  private readonly random: () => number;

  constructor(
    fetchFn: FetchFn,
    apiKey: string,
    callbacks: FeatureStreamCallbacks,
    random: () => number = Math.random,
  ) {
    this.fetchFn = fetchFn;
    this.apiKey = apiKey;
    this.callbacks = callbacks;
    this.random = random;
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

  /**
   * Reconnects after a random wait, so clients dropped together don't all
   * return at once. The backoff uses equal jitter: between half and all of
   * the current step (1 s doubling to 30 s). A `Retry-After` is a floor:
   * the wait is at least what the server asked, up to 10% more at random,
   * and never over an hour.
   */
  private scheduleReconnect(retryAfterMs: number | null = null): void {
    if (this.closed || !this.running) return;
    this.clearReconnect();
    const stepMs = this.reconnectDelayMs;
    let delayMs = stepMs / 2 + (this.random() * stepMs) / 2;
    if (retryAfterMs !== null) {
      const spreadMs = Math.min(
        retryAfterMs * (1 + RETRY_AFTER_SPREAD * this.random()),
        MAX_RETRY_AFTER_MS,
      );
      delayMs = Math.max(delayMs, spreadMs);
    }
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.connectLoop();
    }, delayMs);
    // Advance the backoff unless a longer Retry-After set this wait.
    if ((retryAfterMs ?? 0) <= stepMs) {
      this.reconnectDelayMs = Math.min(stepMs * 2, MAX_RECONNECT_MS);
    }
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
        // Live updates paused: wait for Retry-After instead of retrying.
        if (response.status === 429) {
          retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
          // A 429 breaks any run of early closes.
          this.earlyCloses = 0;
          if (!this.warnedRateLimited) {
            this.warnedRateLimited = true;
            // Print the API's own reason, so new reasons need no SDK release.
            // Read off the loop, so a stalled body can't hold up the reconnect.
            void readErrorReason(response).then((reason) => {
              if (this.closed) return;
              console.warn(
                reason === null
                  ? "FeatureToggle: live updates paused (HTTP 429); retrying later"
                  : `FeatureToggle: live updates paused: ${reason}`,
              );
            });
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
            // Live again: warn on the next 429.
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
