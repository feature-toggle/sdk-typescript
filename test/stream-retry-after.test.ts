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

const CONNECTED = "event: connected\ndata: {}\n\n";
const PING = "event: ping\ndata: {}\n\n";
/** Held open for 4 pings (~1 min), long enough to reset the backoff. */
const HEALTHY_STREAM = CONNECTED + PING.repeat(4);

/** A client whose every stream answers 200 with `body`, then closes. */
function repeatingClient(body: string) {
  const fetchFn = (() =>
    Promise.resolve(
      new Response(body, { status: 200 }),
    )) as unknown as typeof fetch;
  return new FeatureStreamClient(fetchFn, "ft_live_key", {
    onFeaturesChanged: () => {},
  });
}

/** Starts the client, then fires each retry `reconnects` times. */
async function runReconnects(
  clock: ReturnType<typeof fakeClock>,
  client: FeatureStreamClient,
  reconnects: number,
) {
  client.start();
  await flush();
  for (let i = 0; i < reconnects; i++) {
    clock.timers.at(-1)?.fn();
    await flush();
  }
}

/** A stream that sends `connected`, then fails mid-read. */
function readErrorAfterConnected() {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new Error("connection reset"));
        return;
      }
      sent = true;
      controller.enqueue(new TextEncoder().encode(CONNECTED));
    },
  });
  return new Response(body, { status: 200 });
}

const earlyCloseWarnings = () =>
  warnings.filter((args) => String(args[0]).includes("closing early"));

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
    for (const retryAfter of ["2592000", "9".repeat(20)]) {
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
    // Never reached `connected`, so it isn't an early close.
    expect(earlyCloseWarnings()).toHaveLength(0);
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
      () =>
        new Response(HEALTHY_STREAM, {
          status: 200,
        }),
    ]);

    client.start();
    await flush();
    expect(allowanceWarnings()).toHaveLength(1);

    // Allowance reset: the stream connects, then ends.
    await fireNext(clock, 0, 60_000);
    expect(calls()).toBe(2);

    // Runs out again: the user hears about it again. The pings reset the
    // backoff, so the retry comes after 1 s (2 s without the reset).
    await fireNext(clock, 1, 1_000);
    expect(calls()).toBe(3);
    expect(allowanceWarnings()).toHaveLength(2);
    client.close();
  });

  test("`connected` alone re-arms the warning but not the backoff reset", async () => {
    const clock = fakeClock();
    const { client } = sequenceClient([
      limited,
      () => new Response("event: connected\ndata: {}\n\n", { status: 200 }),
    ]);

    client.start();
    await flush();
    await fireNext(clock, 0, 60_000);
    // No `ping`, so the backoff wasn't reset: 2 s, not 1 s.
    await fireNext(clock, 1, 2_000);
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
    // No `ping`, so the backoff kept growing.
    await fireNext(clock, 1, 2_000);
    expect(calls()).toBe(3);
    expect(allowanceWarnings()).toHaveLength(1);
    client.close();
  });

  test("a stream that closes after `connected` but before a `ping` keeps backing off", async () => {
    const clock = fakeClock();
    const fetchFn = (() =>
      Promise.resolve(
        new Response("event: connected\ndata: {}\n\n", { status: 200 }),
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

  test("a stream cut before ~1 min of pings keeps backing off", async () => {
    const clock = fakeClock();
    const client = repeatingClient(CONNECTED + PING.repeat(3));
    await runReconnects(clock, client, 2);
    expect(clock.timers.map((timer) => timer.ms)).toEqual([
      1_000, 2_000, 4_000,
    ]);
    client.close();
  });

  test("a stream held open for ~1 min of pings resets the backoff", async () => {
    const clock = fakeClock();
    const client = repeatingClient(HEALTHY_STREAM);
    await runReconnects(clock, client, 2);
    expect(clock.timers.map((timer) => timer.ms)).toEqual([
      1_000, 1_000, 1_000,
    ]);
    expect(earlyCloseWarnings()).toHaveLength(0);
    client.close();
  });

  test("warns once after three early closes in a row; a healthy stream clears the count", async () => {
    const clock = fakeClock();
    const ok = (body: string) => () => new Response(body, { status: 200 });
    const { client } = sequenceClient([
      ok(CONNECTED),
      ok(CONNECTED),
      ok(HEALTHY_STREAM),
      ok(CONNECTED),
      // A read error after `connected` counts like a clean close.
      readErrorAfterConnected,
      ok(CONNECTED),
      ok(CONNECTED),
    ]);
    const closes = [0, 0, 0, 0, 0, 1, 1];

    client.start();
    await flush();
    expect(earlyCloseWarnings()).toHaveLength(closes[0] as number);
    for (const expected of closes.slice(1)) {
      clock.timers.at(-1)?.fn();
      await flush();
      expect(earlyCloseWarnings()).toHaveLength(expected);
    }
    client.close();
  });

  test("a 429 between early closes clears the count", async () => {
    const clock = fakeClock();
    const ok = (body: string) => () => new Response(body, { status: 200 });
    // Two early closes, an allowance outage, then one more early close:
    // never three in a row, so no warning.
    const { client } = sequenceClient([
      ok(CONNECTED),
      ok(CONNECTED),
      limited,
      ok(CONNECTED),
    ]);
    await runReconnects(clock, client, 3);
    expect(earlyCloseWarnings()).toHaveLength(0);
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

  test("rejects values too large to represent", () => {
    // Infinity when parsed, and finite seconds that overflow in milliseconds.
    expect(parseRetryAfterMs("9".repeat(309))).toBeNull();
    expect(parseRetryAfterMs("9".repeat(306))).toBeNull();
  });
});
