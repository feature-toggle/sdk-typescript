import { INVALID_RESPONSE_STATUS, NETWORK_ERROR_STATUS } from "./constants.js";
import type { FeatureStore } from "./feature-store.js";
import { type FetchFn, fetchFeatures } from "./fetch-features.js";
import type { FetchFeaturesResult } from "./types.js";

export type LoadFeaturesOptions = {
  throwOnError: boolean;
  on401: () => void;
  on403?: (message?: string) => void;
  /** Skip conditional header when SSE proves a newer version. */
  omitIfNoneMatch?: boolean;
  /** Bust CloudFront edge cache on SSE-driven refresh. */
  streamFeaturesVersion?: number;
};

function failMessage(status: number): string {
  if (status === INVALID_RESPONSE_STATUS) {
    return "FeatureToggle: invalid features response";
  }
  return `FeatureToggle: failed to fetch features (HTTP ${status})`;
}

export function applyFetchResult(
  store: FeatureStore,
  result: FetchFeaturesResult,
  options: LoadFeaturesOptions,
): void {
  if (!result.ok) {
    if (result.status === 401) {
      options.on401();
      if (options.throwOnError) {
        throw new Error("FeatureToggle: failed to fetch features (HTTP 401)");
      }
      return;
    }

    if (result.status === 403) {
      options.on403?.(result.errorMessage);
      if (options.throwOnError) {
        throw new Error(
          result.errorMessage ??
            "FeatureToggle: failed to fetch features (HTTP 403)",
        );
      }
      return;
    }

    if (options.throwOnError) {
      throw new Error(failMessage(result.status));
    }

    const reason =
      result.status === INVALID_RESPONSE_STATUS
        ? "invalid features response"
        : `HTTP ${result.status}`;
    console.warn(
      `FeatureToggle: failed to fetch features (${reason}), using cached values`,
    );
    return;
  }

  if (result.notModified) return;

  store.update(result.features, result.etag);
}

export async function loadFeatures(
  fetchFn: FetchFn,
  apiKey: string,
  store: FeatureStore,
  options: LoadFeaturesOptions,
): Promise<FetchFeaturesResult> {
  let result: FetchFeaturesResult;
  try {
    result = await fetchFeatures(
      fetchFn,
      apiKey,
      options.omitIfNoneMatch
        ? { featuresVersion: options.streamFeaturesVersion }
        : { ifNoneMatch: store.getEtag() },
    );
  } catch {
    if (options.throwOnError) {
      throw new Error(
        "FeatureToggle: failed to fetch features (network error)",
      );
    }

    console.warn(
      "FeatureToggle: failed to fetch features (network error), using cached values",
    );
    return { ok: false, status: NETWORK_ERROR_STATUS };
  }

  applyFetchResult(store, result, options);
  return result;
}
