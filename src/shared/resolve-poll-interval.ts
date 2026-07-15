import {
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
} from "./constants.js";

export type StreamMode = "auto" | "notify" | "off";

export type ResolvePollIntervalInput = {
  stream: StreamMode;
  pollInterval?: number;
  envPollInterval?: string;
  serverHeaderSec: number | null;
};

export function clampPollIntervalSec(sec: number): number {
  return Math.min(Math.max(sec, MIN_POLL_INTERVAL_SEC), MAX_POLL_INTERVAL_SEC);
}

/** Parse `X-FeatureToggle-Poll-Interval-Sec` from a bulk features response. */
export function parsePollIntervalHeader(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number.parseInt(header, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed === 0) return 0;
  if (parsed < 0) return null;
  return clampPollIntervalSec(parsed);
}

function parseEnvPollInterval(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return clampPollIntervalSec(parsed);
}

/**
 * Coalesce per-response header with sticky last server override.
 * - `> 0` — new server override
 * - `0` — explicit no override on this response (fall through to client defaults)
 * - `null` (missing) — reuse last server override when present
 */
export function coalesceServerPollHeader(
  parsedHeaderSec: number | null,
  lastServerOverrideSec: number | null,
): { serverHeaderSec: number | null; lastServerOverrideSec: number | null } {
  if (parsedHeaderSec !== null && parsedHeaderSec > 0) {
    const clamped = clampPollIntervalSec(parsedHeaderSec);
    return {
      serverHeaderSec: clamped,
      lastServerOverrideSec: clamped,
    };
  }

  if (parsedHeaderSec === 0) {
    return {
      serverHeaderSec: null,
      lastServerOverrideSec: lastServerOverrideSec,
    };
  }

  return {
    serverHeaderSec: lastServerOverrideSec,
    lastServerOverrideSec: lastServerOverrideSec,
  };
}

/** Effective background poll interval in seconds; 0 means no timer. */
export function resolvePollIntervalSec(
  input: ResolvePollIntervalInput,
): number {
  if (input.stream !== "off") return 0;

  if (input.pollInterval === 0) return 0;

  if (input.serverHeaderSec !== null && input.serverHeaderSec > 0) {
    return clampPollIntervalSec(input.serverHeaderSec);
  }

  if (input.pollInterval !== undefined && input.pollInterval > 0) {
    return clampPollIntervalSec(input.pollInterval);
  }

  const envSec = parseEnvPollInterval(input.envPollInterval);
  if (envSec !== null) return envSec;

  return DEFAULT_POLL_INTERVAL_SEC;
}
