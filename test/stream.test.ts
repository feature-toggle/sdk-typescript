import { afterEach, describe, expect, mock, test } from "bun:test";
import { FeatureToggle } from "../src/index.js";
import { createMockFetch, createVisibility, feature, jsonResponse } from "./helpers.js";

function sseResponse(events: string): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("FeatureToggle stream", () => {
  afterEach(() => {
    mock.restore();
  });

  test("default fetch opens stream without illegal invocation", async () => {
    const rawFetch = globalThis.fetch;
    let streamCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        streamCalls += 1;
        return Promise.resolve(sseResponse(""));
      }
      return Promise.resolve(
        jsonResponse(
          { features: [feature({ key: "alpha" })] },
          { headers: { ETag: '"1"' } },
        ),
      );
    }) as typeof fetch;

    try {
      const ft = new FeatureToggle({
        apiKey: "ft_test_key",
        stream: "auto",
      });

      await ft.init();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(streamCalls).toBeGreaterThanOrEqual(1);
      ft.close();
    } finally {
      globalThis.fetch = rawFetch;
    }
  });

  test("stream auto refreshes on features-changed", async () => {
    let featureCalls = 0;
    let refreshHeaders: Headers | null = null;
    let refreshUrl = "";
    const fetchFn = createMockFetch((input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return sseResponse(
          'event: features-changed\ndata: {"featuresVersion":2}\n\n',
        );
      }

      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha" })] },
          { headers: { ETag: '"1"' } },
        );
      }

      refreshUrl = url;
      refreshHeaders = new Headers(init?.headers);
      return jsonResponse(
        { features: [feature({ key: "beta" })] },
        { headers: { ETag: '"2"' } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "auto",
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ft.isEnabled("beta")).toBe(true);
    expect(refreshHeaders?.get("If-None-Match")).toBeNull();
    expect(refreshUrl).toContain("_v=2");
    ft.close();
  });

  test("stream refetches when event version equals cached etag", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch((input) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return sseResponse(
          'event: features-changed\ndata: {"featuresVersion":2}\n\n',
        );
      }

      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha", value: "old" })] },
          { headers: { ETag: '"2"' } },
        );
      }

      return jsonResponse(
        { features: [feature({ key: "alpha", value: "new" })] },
        { headers: { ETag: '"2"' } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "auto",
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(featureCalls).toBe(2);
    expect(ft.getValue("alpha")).toBe("new");
    ft.close();
  });

  test("stream connected event catches up stale cache after reconnect", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch((input) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return sseResponse(
          'event: connected\ndata: {"featuresVersion":2}\n\n',
        );
      }

      featureCalls += 1;
      if (featureCalls === 1) {
        return jsonResponse(
          { features: [feature({ key: "alpha" })] },
          { headers: { ETag: '"1"' } },
        );
      }

      return jsonResponse(
        { features: [feature({ key: "beta" })] },
        { headers: { ETag: '"2"' } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "auto",
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ft.isEnabled("beta")).toBe(true);
    ft.close();
  });

  test("stream notify fires subscribe without auto refresh", async () => {
    let featureCalls = 0;
    const fetchFn = createMockFetch((input) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return sseResponse(
          'event: features-changed\ndata: {"featuresVersion":2}\n\n',
        );
      }

      featureCalls += 1;
      return jsonResponse(
        { features: [feature({ key: "alpha" })] },
        { headers: { ETag: '"1"' } },
      );
    });

    const ft = new FeatureToggle({
      apiKey: "ft_test_key",
      fetch: fetchFn,
      stream: "notify",
    });

    let notifications = 0;
    ft.subscribe(() => {
      notifications += 1;
    });

    await ft.init();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(notifications).toBeGreaterThanOrEqual(1);
    expect(featureCalls).toBe(1);
    expect(ft.isEnabled("alpha")).toBe(true);
    ft.close();
  });

  test("focus refetch when poll interval is zero", async () => {
    const visibility = createVisibility(false);
    let featureCalls = 0;
    const fetchFn = createMockFetch((input) => {
      const url = String(input);
      if (url.endsWith("/v1/features/stream")) {
        return sseResponse("");
      }

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

    expect(featureCalls).toBeGreaterThanOrEqual(2);
    ft.close();
  });
});
