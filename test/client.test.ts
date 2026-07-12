import { afterEach, describe, expect, mock, test } from "bun:test";
import { FeatureToggle } from "../src/index.js";
import { createDefaultMockFetch, feature, jsonResponse } from "./helpers.js";

describe("FeatureToggle", () => {
  afterEach(() => {
    mock.restore();
  });

  test("init throws on first fetch failure", async () => {
    const fetchFn = createDefaultMockFetch(() => new Response(null, { status: 500 }));
    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await expect(ft.init()).rejects.toThrow("HTTP 500");
  });

  test("init throws on fetch rejection", async () => {
    const fetchFn = createDefaultMockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await expect(ft.init()).rejects.toThrow("network error");
  });

  test("init throws on 401", async () => {
    const fetchFn = createDefaultMockFetch(() => new Response(null, { status: 401 }));
    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await expect(ft.init()).rejects.toThrow("HTTP 401");
  });

  test("304 keeps existing cache", async () => {
    let calls = 0;
    const fetchFn = createDefaultMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha" })] },
          { headers: { ETag: '"1"' } },
        );
      }
      return new Response(null, {
        status: 304,
        headers: { ETag: '"1"' },
      });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await ft.init();
    await ft.refresh();

    expect(ft.isEnabled("alpha")).toBe(true);
  });

  test("refresh keeps cache on fetch rejection", async () => {
    let calls = 0;
    const fetchFn = createDefaultMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      throw new TypeError("fetch failed");
    });

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await ft.init();
    await ft.refresh();

    try {
      expect(ft.isEnabled("alpha")).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "FeatureToggle: failed to fetch features (network error), using cached values",
      );
    } finally {
      console.warn = original;
    }
  });

  test("401 on refresh clears cache and stops transport", async () => {
    let calls = 0;
    const fetchFn = createDefaultMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      return new Response(null, { status: 401 });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await ft.init();
    await ft.refresh();

    expect(ft.isEnabled("alpha")).toBe(false);
  });

  test("init after 401 recovery repopulates cache", async () => {
    let calls = 0;
    const fetchFn = createDefaultMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      if (calls === 2) {
        return new Response(null, { status: 401 });
      }
      return jsonResponse({ features: [feature({ key: "beta" })] });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await ft.init();
    await ft.refresh();
    expect(ft.isEnabled("alpha")).toBe(false);

    await ft.init();
    expect(ft.isEnabled("beta")).toBe(true);
  });

  test("getFeatures filters client-side", async () => {
    const fetchFn = createDefaultMockFetch(() =>
      jsonResponse({
        features: [
          feature({ key: "a", type: "boolean" }),
          feature({ key: "b", type: "string", value: "x" }),
        ],
      }),
    );

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
    });

    await ft.init();

    expect(ft.getFeatures({ type: "string" })).toEqual([
      feature({ key: "b", type: "string", value: "x" }),
    ]);
  });

  test("initialFeatures seeds cache before init", async () => {
    const fetchFn = createDefaultMockFetch(() =>
      jsonResponse({ features: [feature({ key: "live" })] }),
    );

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      initialFeatures: [feature({ key: "seeded" })],
      initialEtag: '"1"',
    });

    expect(ft.isEnabled("seeded")).toBe(true);

    let notifications = 0;
    ft.subscribe(() => {
      notifications += 1;
    });

    await ft.init();

    expect(ft.isEnabled("live")).toBe(true);
    expect(notifications).toBe(1);
    ft.close();
  });

  test("close stops transport", async () => {
    const fetchFn = createDefaultMockFetch(() =>
      jsonResponse({ features: [feature({ key: "alpha" })] }),
    );

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
    });

    await ft.init();
    ft.close();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchFn.callCount()).toBe(1);
  });
});
