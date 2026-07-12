import { describe, expect, mock, test } from "bun:test";
import { FeatureToggleServer } from "../src/server.js";
import { MAX_FEATURE_COUNT, MAX_POLL_INTERVAL_SEC, NETWORK_ERROR_STATUS } from "../src/shared/constants.js";
import { filterFeatures } from "../src/shared/filter-features.js";
import { FeatureStore } from "../src/shared/feature-store.js";
import { fetchFeatures } from "../src/shared/fetch-features.js";
import { applyFetchResult, loadFeatures } from "../src/shared/load-features.js";
import {
  isJsonContentType,
  parseFeaturesBulkBody,
} from "../src/shared/parse-features-response.js";
import { createMockFetch, feature, jsonResponse } from "./helpers.js";

describe("filterFeatures", () => {
  const features = [
    feature({ key: "a", type: "boolean", deprecated: false }),
    feature({ key: "b", type: "string", value: "x", deprecated: true }),
  ];

  test("returns all features without options", () => {
    expect(filterFeatures(features)).toHaveLength(2);
  });

  test("filters by type", () => {
    expect(filterFeatures(features, { type: "string" })).toEqual([features[1]]);
  });

  test("filters by deprecated", () => {
    expect(filterFeatures(features, { deprecated: false })).toEqual([features[0]]);
  });
});

describe("FeatureStore", () => {
  test("getFeatures returns a copy that does not mutate cache", () => {
    const store = new FeatureStore();
    store.update([feature({ key: "a" })], '"1"');

    const returned = store.getFeatures();
    returned.push(feature({ key: "b" }));

    expect(store.getFeatures()).toHaveLength(1);
  });

  test("skips entries with empty key on update", () => {
    const store = new FeatureStore();
    store.update(
      [feature({ key: "a" }), feature({ key: "" })],
      '"1"',
    );

    expect(store.getFeatures()).toHaveLength(1);
    expect(store.isEnabled("a")).toBe(true);
  });

  test("parses features version from etag", () => {
    const store = new FeatureStore();
    store.update([feature({ key: "a" })], '"42"');
    expect(store.getFeaturesVersion()).toBe(42);
  });

  test("warns once per deprecated key", () => {
    const store = new FeatureStore();
    store.update(
      [
        feature({
          key: "old",
          deprecated: true,
          inFavorOf: "new",
        }),
      ],
      '"1"',
    );

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    try {
      expect(store.isEnabled("old")).toBe(true);
      expect(store.isEnabled("old")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("new");
    } finally {
      console.warn = original;
    }
  });
});

describe("parseFeaturesBulkBody", () => {
  test("accepts valid bulk response", () => {
    const parsed = parseFeaturesBulkBody(
      JSON.stringify({ features: [feature({ key: "a" })] }),
    );
    expect(parsed).toEqual([feature({ key: "a" })]);
  });

  test("rejects missing features array", () => {
    expect(parseFeaturesBulkBody(JSON.stringify({}))).toBeNull();
  });

  test("skips invalid entries and dedupes by key", () => {
    const parsed = parseFeaturesBulkBody(
      JSON.stringify({
        features: [
          feature({ key: "a" }),
          { key: "", type: "boolean", value: true, enabled: true, deprecated: false },
          feature({ key: "a", value: false }),
        ],
      }),
    );

    expect(parsed).toEqual([feature({ key: "a", value: false })]);
  });

  test("rejects feature count above limit", () => {
    const features = Array.from({ length: MAX_FEATURE_COUNT + 1 }, (_, i) =>
      feature({ key: `f-${i}` }),
    );
    expect(parseFeaturesBulkBody(JSON.stringify({ features }))).toBeNull();
  });
});

describe("isJsonContentType", () => {
  test("accepts application/json with charset", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  test("rejects non-json content types", () => {
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

describe("fetchFeatures", () => {
  test("sends Authorization and If-None-Match", async () => {
    let auth = "";
    let etag = "";
    let url = "";

    const fetchFn = createMockFetch((input, init) => {
      url = String(input);
      auth = init?.headers ? String(new Headers(init.headers).get("Authorization")) : "";
      etag = init?.headers ? String(new Headers(init.headers).get("If-None-Match")) : "";
      return jsonResponse({ features: [] }, { headers: { ETag: '"2"' } });
    });

    const result = await fetchFeatures(fetchFn, "ft_test_key", '"1"');

    expect(auth).toBe("Bearer ft_test_key");
    expect(etag).toBe('"1"');
    expect(url).not.toContain("_v=");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notModified).toBe(false);
      expect(result.etag).toBe('"2"');
    }
  });

  test("adds featuresVersion cache-bust query on SSE refresh", async () => {
    let url = "";
    const fetchFn = createMockFetch((input) => {
      url = String(input);
      return jsonResponse({ features: [] }, { headers: { ETag: '"2"' } });
    });

    await fetchFeatures(fetchFn, "ft_test_key", { featuresVersion: 2 });

    expect(url).toContain("_v=2");
  });

  test("handles 304 not modified", async () => {
    const fetchFn = createMockFetch(() =>
      new Response(null, {
        status: 304,
        headers: {
          ETag: '"1"',
          "X-FeatureToggle-Poll-Interval-Sec": "30",
        },
      }),
    );

    const result = await fetchFeatures(fetchFn, "ft_test_key", '"1"');

    expect(result.ok && result.notModified).toBe(true);
    expect(result.ok && result.pollIntervalSec).toBe(30);
  });

  test("rejects non-json content type on 200", async () => {
    const fetchFn = createMockFetch(() =>
      new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const result = await fetchFeatures(fetchFn, "ft_test_key");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });

  test("rejects invalid json body on 200", async () => {
    const fetchFn = createMockFetch(() =>
      new Response(JSON.stringify({ notFeatures: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await fetchFeatures(fetchFn, "ft_test_key");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });

  test("parses 403 error message from response body", async () => {
    const fetchFn = createMockFetch(() =>
      new Response(
        JSON.stringify({
          error:
            "Test keys are valid on localhost only. Use a live key for deployed apps.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await fetchFeatures(fetchFn, "ft_test_key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.errorMessage).toContain("localhost");
    }
  });

  test("caps server-driven poll interval header", async () => {
    const fetchFn = createMockFetch(() =>
      jsonResponse(
        { features: [] },
        { headers: { "X-FeatureToggle-Poll-Interval-Sec": "999999" } },
      ),
    );

    const result = await fetchFeatures(fetchFn, "ft_test_key");
    expect(result.ok && result.pollIntervalSec).toBe(MAX_POLL_INTERVAL_SEC);
  });
});

describe("loadFeatures", () => {
  test("throws on network error when throwOnError is true", async () => {
    const fetchFn = createMockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const store = new FeatureStore();

    await expect(
      loadFeatures(fetchFn, "ft_test_key", store, {
        throwOnError: true,
        on401: () => {},
      }),
    ).rejects.toThrow("network error");
  });

  test("warns once on 403 scope error", async () => {
    let calls = 0;
    const fetchFn = createMockFetch(() => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: "Live keys require a paid plan." }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    });

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;
    const store = new FeatureStore();

    try {
      await loadFeatures(fetchFn, "ft_live_key", store, {
        throwOnError: false,
        on401: () => {},
        on403: (message) => {
          if (!warn.mock.calls.length) {
            console.warn(message);
          }
        },
      });
      await loadFeatures(fetchFn, "ft_live_key", store, {
        throwOnError: false,
        on401: () => {},
        on403: (message) => {
          if (warn.mock.calls.length === 0) {
            console.warn(message);
          }
        },
      });

      expect(calls).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("paid plan");
    } finally {
      console.warn = original;
    }
  });

  test("retains cache and warns on network error when throwOnError is false", async () => {
    const store = new FeatureStore();
    store.update([feature({ key: "alpha" })], '"1"');

    const fetchFn = createMockFetch(() => {
      throw new TypeError("fetch failed");
    });

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    try {
      const result = await loadFeatures(fetchFn, "ft_test_key", store, {
        throwOnError: false,
        on401: () => {},
      });

      expect(result).toEqual({ ok: false, status: NETWORK_ERROR_STATUS });
      expect(store.isEnabled("alpha")).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "FeatureToggle: failed to fetch features (network error), using cached values",
      );
    } finally {
      console.warn = original;
    }
  });
});

describe("applyFetchResult", () => {
  test("invalid response keeps cache on refresh", () => {
    const store = new FeatureStore();
    store.update([feature({ key: "alpha" })], '"1"');

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    try {
      applyFetchResult(
        store,
        { ok: false, status: 502 },
        { throwOnError: false, on401: () => {} },
      );

      expect(store.isEnabled("alpha")).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "FeatureToggle: failed to fetch features (invalid features response), using cached values",
      );
    } finally {
      console.warn = original;
    }
  });
});

describe("FeatureToggleServer", () => {
  test("init loads features and refresh replaces cache", async () => {
    const fetchFn = createMockFetch(() =>
      jsonResponse({
        features: [feature({ key: "alpha", value: true })],
      }),
    );

    const ft = new FeatureToggleServer({ apiKey: "ft_test_key", fetch: fetchFn });
    await ft.init();

    expect(ft.isEnabled("alpha")).toBe(true);
    expect(ft.getValue<boolean>("alpha")).toBe(true);
    expect(ft.getFeatures()).toHaveLength(1);
  });

  test("refresh keeps cache on network failure", async () => {
    let calls = 0;
    const fetchFn = createMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      return new Response(null, { status: 500 });
    });

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    const ft = new FeatureToggleServer({ apiKey: "ft_test_key", fetch: fetchFn });
    await ft.init();
    await ft.refresh();

    try {
      expect(ft.isEnabled("alpha")).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = original;
    }
  });

  test("refresh keeps cache on fetch rejection", async () => {
    let calls = 0;
    const fetchFn = createMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      throw new TypeError("fetch failed");
    });

    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    const ft = new FeatureToggleServer({ apiKey: "ft_test_key", fetch: fetchFn });
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

  test("401 on refresh clears cache", async () => {
    let calls = 0;
    const fetchFn = createMockFetch(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      return new Response(null, { status: 401 });
    });

    const ft = new FeatureToggleServer({ apiKey: "ft_test_key", fetch: fetchFn });
    await ft.init();
    await ft.refresh();

    expect(ft.isEnabled("alpha")).toBe(false);
    expect(ft.getValue("alpha")).toBeUndefined();
  });
});
