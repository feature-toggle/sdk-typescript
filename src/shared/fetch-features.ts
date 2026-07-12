import {
  API_BASE_URL,
  INVALID_RESPONSE_STATUS,
  MAX_POLL_INTERVAL_SEC,
} from "./constants.js";
import {
  isJsonContentType,
  parseFeaturesBulkBody,
} from "./parse-features-response.js";
import type { FetchFeaturesResult } from "./types.js";

export type FetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Wraps global fetch so it stays callable when stored and invoked later (browser Illegal invocation). */
export const defaultFetch: FetchFn = (input, init) => fetch(input, init);

function parsePollIntervalSec(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number.parseInt(header, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed > MAX_POLL_INTERVAL_SEC) return MAX_POLL_INTERVAL_SEC;
  return parsed;
}

export type FetchFeaturesRequest = {
  ifNoneMatch?: string | null;
  /** CloudFront cache-bust query param on SSE-driven refresh. */
  featuresVersion?: number;
};

function normalizeFetchRequest(
  request?: string | null | FetchFeaturesRequest,
): FetchFeaturesRequest {
  if (request === null || request === undefined || typeof request === "string") {
    return { ifNoneMatch: request ?? undefined };
  }
  return request;
}

export async function fetchFeatures(
  fetchFn: FetchFn,
  apiKey: string,
  request?: string | null | FetchFeaturesRequest,
): Promise<FetchFeaturesResult> {
  const { ifNoneMatch, featuresVersion } = normalizeFetchRequest(request);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };

  if (ifNoneMatch) {
    headers["If-None-Match"] = ifNoneMatch;
  }

  const url = new URL(`${API_BASE_URL}/v1/features`);
  if (featuresVersion !== undefined) {
    url.searchParams.set("_v", String(featuresVersion));
  }

  const response = await fetchFn(url.toString(), { headers });
  const pollIntervalSec = parsePollIntervalSec(
    response.headers.get("X-FeatureToggle-Poll-Interval-Sec"),
  );

  if (response.status === 304) {
    return {
      ok: true,
      notModified: true,
      features: [],
      etag: ifNoneMatch ?? response.headers.get("ETag"),
      pollIntervalSec,
    };
  }

  if (!response.ok) {
    let errorMessage: string | undefined;
    if (response.status === 403) {
      try {
        const text = await response.text();
        const parsed = JSON.parse(text) as { error?: string };
        if (typeof parsed.error === "string") {
          errorMessage = parsed.error;
        }
      } catch {
        // ignore parse errors
      }
    }
    return { ok: false, status: response.status, errorMessage };
  }

  const contentType = response.headers.get("Content-Type");
  if (!isJsonContentType(contentType)) {
    return { ok: false, status: INVALID_RESPONSE_STATUS };
  }

  const text = await response.text();
  const features = parseFeaturesBulkBody(text);
  if (features === null) {
    return { ok: false, status: INVALID_RESPONSE_STATUS };
  }

  return {
    ok: true,
    notModified: false,
    features,
    etag: response.headers.get("ETag"),
    pollIntervalSec,
  };
}
