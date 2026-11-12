import { afterEach, describe, expect, test } from "bun:test";
import {
  FeatureStreamClient,
  parseRetryAfterMs,
} from "../src/shared/feature-stream.js";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realNow = Date.now;

type Timer = { fn: () => void; ms: number };

function fakeClock() {
  let now = 1_000_000;
  const timers: Timer[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  Date.now = () => now;
  return {
    timers,
    advanceTo(ms: number) {
      now = ms;
    },
    start: now,
  };
}

const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

function rateLimitedClient(retryAfter: string) {
  let calls = 0;
  const fetchFn = (() => {
    calls += 1;
    return Promise.resolve(
      new Response('{"error":"limit"}', {
        status: 429,
        headers: { "Retry-After": retryAfter },
      }),
    );
  }) as unknown as typeof fetch;
  const client = new FeatureStreamClient(fetchFn, "ft_live_key", {
    onFeaturesChanged: () => {},
  });
  return { client, calls: () => calls };
}

describe("stream 429", () => {
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realNow;
  });

  test("waits for Retry-After before reconnecting", async () => {
    const clock = fakeClock();
    const { client, calls } = rateLimitedClient("120");

    client.start();
    await flush();
    expect(calls()).toBe(1);
    expect(clock.timers.at(-1)?.ms).toBe(120_000);

    // Fired early (e.g. a throttled timer): re-arms instead of connecting.
    clock.advanceTo(clock.start + 119_000);
    clock.timers.at(-1)?.fn();
    await flush();
    expect(calls()).toBe(1);

    clock.advanceTo(clock.start + 120_000);
    clock.timers.at(-1)?.fn();
    await flush();
    expect(calls()).toBe(2);
    client.close();
  });

  test("a 30-day Retry-After doesn't overflow setTimeout", async () => {
    const clock = fakeClock();
    const { client, calls } = rateLimitedClient("2592000");

    client.start();
    await flush();
    expect(clock.timers.at(-1)?.ms).toBe(2_147_483_647);

    clock.advanceTo(clock.start + 25 * 86_400_000);
    clock.timers.at(-1)?.fn();
    await flush();
    expect(calls()).toBe(1);

    clock.advanceTo(clock.start + 30 * 86_400_000);
    clock.timers.at(-1)?.fn();
    await flush();
    expect(calls()).toBe(2);
    client.close();
  });

  test("without a valid Retry-After it falls back to backoff", async () => {
    const clock = fakeClock();
    const { client } = rateLimitedClient("soon");

    client.start();
    await flush();
    expect(clock.timers.at(-1)?.ms).toBe(1_000);
    client.close();
  });
});

describe("parseRetryAfterMs", () => {
  test("parses seconds and rejects junk", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("-1")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });
});
