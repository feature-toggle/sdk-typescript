export const API_BASE_URL = "https://api.featuretoggle.com";

/** Max bulk response body size (1 MiB). */
export const MAX_FEATURES_RESPONSE_BYTES = 1_048_576;

/** Max features accepted from a single bulk response. */
export const MAX_FEATURE_COUNT = 10_000;

/** Max server-driven poll interval (24 hours). */
export const MAX_POLL_INTERVAL_SEC = 86_400;

/** Synthetic status when a 200 response body fails validation. */
export const INVALID_RESPONSE_STATUS = 502;

/** Synthetic status when fetch rejects (network error). */
export const NETWORK_ERROR_STATUS = 503;

