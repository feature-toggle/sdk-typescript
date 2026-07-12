export type FeatureType = "boolean" | "string" | "number" | "json";

export type FeatureResponse = {
  key: string;
  type: FeatureType;
  value: unknown;
  enabled: boolean;
  deprecated: boolean;
  inFavorOf?: string;
};

export type FeaturesBulkResponse = {
  features: FeatureResponse[];
};

export type GetFeaturesOptions = {
  type?: FeatureType;
  deprecated?: boolean;
};

export type FetchFeaturesSuccess = {
  ok: true;
  notModified: boolean;
  features: FeatureResponse[];
  etag: string | null;
  pollIntervalSec: number | null;
};

export type FetchFeaturesFailure = {
  ok: false;
  status: number;
  errorMessage?: string;
};

export type FetchFeaturesResult = FetchFeaturesSuccess | FetchFeaturesFailure;
