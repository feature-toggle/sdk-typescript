import {
  MAX_FEATURE_COUNT,
  MAX_FEATURES_RESPONSE_BYTES,
} from "./constants.js";
import type { FeatureResponse, FeatureType } from "./types.js";

const FEATURE_TYPES = new Set<FeatureType>([
  "boolean",
  "string",
  "number",
  "json",
]);

export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function parseFeatureEntry(raw: unknown): FeatureResponse | null {
  if (typeof raw !== "object" || raw === null) return null;

  const entry = raw as Record<string, unknown>;
  if (typeof entry.key !== "string" || entry.key.length === 0) return null;
  if (typeof entry.type !== "string" || !FEATURE_TYPES.has(entry.type as FeatureType)) {
    return null;
  }
  if (typeof entry.enabled !== "boolean") return null;
  if (typeof entry.deprecated !== "boolean") return null;
  if (!("value" in entry)) return null;

  const feature: FeatureResponse = {
    key: entry.key,
    type: entry.type as FeatureType,
    value: entry.value,
    enabled: entry.enabled,
    deprecated: entry.deprecated,
  };

  if (entry.inFavorOf !== undefined) {
    if (typeof entry.inFavorOf !== "string") return null;
    feature.inFavorOf = entry.inFavorOf;
  }

  return feature;
}

export function parseFeaturesBulkBody(text: string): FeatureResponse[] | null {
  if (new TextEncoder().encode(text).byteLength > MAX_FEATURES_RESPONSE_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const featuresRaw = (parsed as Record<string, unknown>).features;
  if (!Array.isArray(featuresRaw)) return null;
  if (featuresRaw.length > MAX_FEATURE_COUNT) return null;

  const byKey = new Map<string, FeatureResponse>();
  for (const raw of featuresRaw) {
    const feature = parseFeatureEntry(raw);
    if (feature) byKey.set(feature.key, feature);
  }

  return [...byKey.values()];
}
