import { describe, expect, test } from "bun:test";
import { FeatureToggle } from "../src/index.js";
import { FeatureStore } from "../src/shared/feature-store.js";
import { parseFeaturesBulkBody } from "../src/shared/parse-features-response.js";
import fixture from "./fixtures/features-bulk-200.json";
import { createDefaultMockFetch, jsonResponse } from "./helpers.js";

describe("golden fixture", () => {
  test("parse → store → single subscribe notification", async () => {
    const features = parseFeaturesBulkBody(JSON.stringify(fixture));
    expect(features).not.toBeNull();
    expect(features).toHaveLength(3);

    const store = new FeatureStore();
    store.update(features!, '"1"');

    expect(store.isEnabled("new-checkout")).toBe(true);
    expect(store.getValue<string>("theme-variant")).toBe("dark");
    expect(store.getFeatures({ deprecated: true })).toHaveLength(1);

    const fetchFn = createDefaultMockFetch(() =>
      jsonResponse(fixture, { headers: { ETag: '"1"' } }),
    );

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
    });

    let notifications = 0;
    ft.subscribe(() => {
      notifications += 1;
    });

    await ft.init();

    expect(notifications).toBe(1);
    expect(ft.isEnabled("new-checkout")).toBe(true);
    expect(ft.getValue<string>("theme-variant")).toBe("dark");
    ft.close();
  });
});
