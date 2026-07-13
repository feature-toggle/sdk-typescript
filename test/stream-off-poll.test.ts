import { afterEach, describe, expect, mock, test } from "bun:test";
import { FeatureToggle } from "../src/index.js";
import { createMockFetch, createVisibility, feature, jsonResponse } from "./helpers.js";

describe("FeatureToggle stream-off poll", () => {
  afterEach(() => {
    mock.restore();
  });

  test("stream off with default polls on interval", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch(() => {
      featureCalls += 1;
      return jsonResponse(
        { features: [feature({ key: `k${featureCalls}` })] },
        {
          headers: {
            ETag: `"${featureCalls}"`,
            "X-FeatureToggle-Poll-Interval-Sec": "0",
          },
        },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 1,
    });

    await ft.init();
    expect(featureCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    ft.close();

    expect(featureCalls).toBe(2);
  });

  test("stream off with pollInterval 0 uses focus refetch not timer", async () => {
    const visibility = createVisibility(false);
    let featureCalls = 0;
    const fetchFn = createMockFetch(() => {
      featureCalls += 1;
      return jsonResponse(
        { features: [feature({ key: `k${featureCalls}` })] },
        { headers: { "X-FeatureToggle-Poll-Interval-Sec": "0", ETag: `"${featureCalls}"` } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 0,
      visibility,
    });

    await ft.init();
    visibility.setHidden(true);
    visibility.setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ft.close();

    expect(featureCalls).toBeGreaterThanOrEqual(2);
  });

  test("stream off does not focus refetch when poll timer active", async () => {
    const visibility = createVisibility(false);
    let featureCalls = 0;
    const fetchFn = createMockFetch(() => {
      featureCalls += 1;
      return jsonResponse(
        { features: [feature({ key: "alpha" })] },
        { headers: { "X-FeatureToggle-Poll-Interval-Sec": "0", ETag: '"1"' } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 30,
      visibility,
    });

    await ft.init();
    visibility.setHidden(true);
    visibility.setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ft.close();

    expect(featureCalls).toBe(1);
  });

  test("server header overrides client poll interval", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch(() => {
      featureCalls += 1;
      return jsonResponse(
        { features: [feature({ key: "alpha" })] },
        {
          headers: {
            ETag: '"1"',
            "X-FeatureToggle-Poll-Interval-Sec": "1",
          },
        },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 30,
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    ft.close();

    expect(featureCalls).toBe(2);
  });

  test("pollInterval on auto warns once and does not poll", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn;

    let featureCalls = 0;
    const fetchFn = createMockFetch((input) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return new Response(new ReadableStream(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      featureCalls += 1;
      return jsonResponse({ features: [feature({ key: "alpha" })] });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "auto",
      pollInterval: 1,
    });

    try {
      await ft.init();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      ft.close();

      expect(warn).toHaveBeenCalledWith(
        "FeatureToggle: pollInterval is only used when stream is 'off'",
      );
      expect(featureCalls).toBe(1);
    } finally {
      console.warn = original;
    }
  });

  test("concurrent refresh shares one in-flight fetch", async () => {
    let featureCalls = 0;
    let resolveFetch: (() => void) | null = null;
    const fetchFn = createMockFetch(
      () =>
        new Promise<Response>((resolve) => {
          featureCalls += 1;
          resolveFetch = () =>
            resolve(jsonResponse({ features: [feature({ key: "alpha" })] }));
        }),
    );

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 0,
    });

    const first = ft.refresh();
    const second = ft.refresh();
    resolveFetch?.();
    await Promise.all([first, second]);

    expect(featureCalls).toBe(1);
    ft.close();
  });

  test("401 on poll tick stops scheduler", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch(() => {
      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse({ features: [feature({ key: "alpha" })] });
      }
      return new Response(null, { status: 401 });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 1,
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(featureCalls).toBe(2);
    expect(ft.isEnabled("alpha")).toBe(false);
    ft.close();
  });

  test("304 without poll header keeps last server override interval", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch((input, init) => {
      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha" })] },
          {
            headers: {
              ETag: '"1"',
              "X-FeatureToggle-Poll-Interval-Sec": "1",
            },
          },
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
      stream: "off",
      pollInterval: 30,
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    ft.close();

    expect(featureCalls).toBe(2);
  });

  test("304 with poll header 0 falls back to client poll interval", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch((input, init) => {
      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha" })] },
          {
            headers: {
              ETag: '"1"',
              "X-FeatureToggle-Poll-Interval-Sec": "1",
            },
          },
        );
      }

      return new Response(null, {
        status: 304,
        headers: {
          ETag: '"1"',
          "X-FeatureToggle-Poll-Interval-Sec": "0",
        },
      });
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "off",
      pollInterval: 1,
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    ft.close();

    expect(featureCalls).toBe(2);
  });
});
