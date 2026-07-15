import type { FeatureResponse, GetFeaturesOptions } from "./types.js";

export function filterFeatures(
  features: FeatureResponse[],
  options?: GetFeaturesOptions,
): FeatureResponse[] {
  if (!options) return features;

  return features.filter((feature) => {
    if (options.type !== undefined && feature.type !== options.type)
      return false;
    if (
      options.deprecated !== undefined &&
      feature.deprecated !== options.deprecated
    ) {
      return false;
    }
    return true;
  });
}
