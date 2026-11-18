import { afterEach, describe, expect, test } from "bun:test";
import {
  FeatureStreamClient,
  parseRetryAfterMs,
} from "../src/shared/feature-stream.js";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realWarn = console.warn;
let warnings: unknown[][] = [];

type Timer = { fn: () => void; ms: number };

function fakeClock() {
  const timers: Timer[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    timers.push({ fn, ms });
    return timers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  warnings = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return { timers };
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
    console.warn = realWarn;
  });

  test("waits for Retry-After before reconnecting", async () => {
    const clock = fakeClock();
    const { client, calls } = rateLimitedClient("120");

    client.start();
    await flush();
    expect(calls()).toBe(1);
    expect(clock.timers.at(-1)?.ms).toBe(120_000);

    clock.timers.at(-1)?.fn();
    await flush();
    expect(calls()).toBe(2);
    // The second 429 doesn't warn again.
    expect(warnings).toHaveLength(1);
    client.close();
  });

  test("caps Retry-After at an hour, so an upgrade resumes live updates", async () => {
    for (const retryAfter of ["2592000", "9".repeat(309)]) {
      const clock = fakeClock();
      const { client, calls } = rateLimitedClient(retryAfter);

      client.start();
      await flush();
      expect(clock.timers.at(-1)?.ms).toBe(3_600_000);

      clock.timers.at(-1)?.fn();
      await flush();
      expect(calls()).toBe(2);
      client.close();
    }
  });

  test("a short Retry-After can't undercut the backoff", async () => {
    const clock = fakeClock();
    const { client } = rateLimitedClient("1");

    client.start();
    await flush();
    for (let i = 0; i < 3; i++) {
      clock.timers.at(-1)?.fn();
      await flush();
    }
    expect(clock.timers.map((timer) => timer.ms)).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    client.close();
  });

  test("a 200 that closes before `connected` doesn't reset the backoff", async () => {
    const clock = fakeClock();
    const fetchFn = (() =>
      Promise.resolve(
        new Response("", { status: 200 }),
      )) as unknown as typeof fetch;
    const client = new FeatureStreamClient(fetchFn, "ft_live_key", {
      onFeaturesChanged: () => {},
    });

    client.start();
    await flush();
    for (let i = 0; i < 2; i++) {
      clock.timers.at(-1)?.fn();
      await flush();
    }
    expect(clock.timers.map((timer) => timer.ms)).toEqual([
      1_000, 2_000, 4_000,
    ]);
    client.close();
  });

  const limited = () =>
    new Response("{}", { status: 429, headers: { "Retry-After": "60" } });

  function sequenceClient(responses: (() => Response)[]) {
    let calls = 0;
    const fetchFn = (() =>
      Promise.resolve(
        (responses[calls++] ?? limited)(),
      )) as unknown as typeof fetch;
    const client = new FeatureStreamClient(fetchFn, "ft_live_key", {
      onFeaturesChanged: () => {},
    });
    return { client, calls: () => calls };
  }

  const allowanceWarnings = () =>
    warnings.filter((args) => String(args[0]).includes("sync allowance"));

  /** Fires the newest timer, asserting it is new and has the expected delay. */
  async function fireNext(
    clock: ReturnType<typeof fakeClock>,
    timersBefore: number,
    ms: number,
  ) {
    expect(clock.timers.length).toBe(timersBefore + 1);
    expect(clock.timers.at(-1)?.ms).toBe(ms);
    clock.timers.at(-1)?.fn();
    await flush();
  }

  test("warns again if the allowance runs out after a successful reconnect", async () => {
    const clock = fakeClock();
    const { client, calls } = sequenceClient([
      limited,
      () => new Response("event: connected\ndata: {}\n\n", { status: 200 }),
    ]);

    client.start();
    await flush();
    expect(allowanceWarnings()).toHaveLength(1);

    // Allowance reset: the stream connects, then ends.
    await fireNext(clock, 0, 60_000);
    expect(calls()).toBe(2);

    // Runs out again: the user hears about it again. `connected` reset the
    // backoff, so the retry comes after 1 s (2 s without the reset).
    await fireNext(clock, 1, 1_000);
    expect(calls()).toBe(3);
    expect(allowanceWarnings()).toHaveLength(2);
    client.close();
  });

  test("a 200 that closes before `connected` doesn't re-arm the warning", async () => {
    const clock = fakeClock();
    const { client, calls } = sequenceClient([
      limited,
      () => new Response("", { status: 200 }),
    ]);

    client.start();
    await flush();
    await fireNext(clock, 0, 60_000);
    // No `connected`, so the backoff kept growing.
    await fireNext(clock, 1, 2_000);
    expect(calls()).toBe(3);
    expect(allowanceWarnings()).toHaveLength(1);
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
    expect(parseRetryAfterMs("0")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("-1")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
  });

  test("rejects fractional seconds so they can't loop sub-second", () => {
    expect(parseRetryAfterMs("0.5")).toBeNull();
    expect(parseRetryAfterMs("1.5")).toBeNull();
    expect(parseRetryAfterMs("1.0000000000000001")).toBeNull();
    expect(parseRetryAfterMs("1e-3")).toBeNull();
    expect(parseRetryAfterMs("1e3")).toBeNull();
    expect(parseRetryAfterMs("0x10")).toBeNull();
    expect(parseRetryAfterMs(" 120 ")).toBe(120_000);
  });
});
