import { parseFeaturesVersionFromEtag } from "./etag-version.js";
import { filterFeatures } from "./filter-features.js";
import type { FeatureResponse, GetFeaturesOptions } from "./types.js";

export class FeatureStore {
  private featuresByKey = new Map<string, FeatureResponse>();
  private featuresList: FeatureResponse[] = [];
  private etag: string | null = null;
  private warnedKeys = new Set<string>();

  isEnabled(key: string): boolean {
    const feature = this.featuresByKey.get(key);
    if (feature) this.warnDeprecated(feature);
    return feature !== undefined;
  }

  getValue<T>(key: string): T | undefined {
    const feature = this.featuresByKey.get(key);
    if (!feature) return undefined;
    this.warnDeprecated(feature);
    return feature.value as T;
  }

  getFeatures(options?: GetFeaturesOptions): FeatureResponse[] {
    return [...filterFeatures(this.featuresList, options)];
  }

  getEtag(): string | null {
    return this.etag;
  }

  getFeaturesVersion(): number | null {
    return parseFeaturesVersionFromEtag(this.etag);
  }

  update(features: FeatureResponse[], etag: string | null): void {
    const valid = features.filter(
      (feature) => typeof feature.key === "string" && feature.key.length > 0,
    );
    this.featuresList = valid;
    this.featuresByKey = new Map(
      valid.map((feature) => [feature.key, feature]),
    );
    this.etag = etag;
  }

  clear(): void {
    this.featuresByKey.clear();
    this.featuresList = [];
    this.etag = null;
    this.warnedKeys.clear();
  }

  private warnDeprecated(feature: FeatureResponse): void {
    if (!feature.deprecated || this.warnedKeys.has(feature.key)) return;
    this.warnedKeys.add(feature.key);

    if (feature.inFavorOf) {
      console.warn(
        `[FeatureToggle] Feature "${feature.key}" is deprecated — use "${feature.inFavorOf}" instead.`,
      );
      return;
    }

    console.warn(`[FeatureToggle] Feature "${feature.key}" is deprecated.`);
  }
}
