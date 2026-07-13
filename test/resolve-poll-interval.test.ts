import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
} from "../src/shared/constants.js";
import {
  clampPollIntervalSec,
  coalesceServerPollHeader,
  parsePollIntervalHeader,
  resolvePollIntervalSec,
} from "../src/shared/resolve-poll-interval.js";

describe("parsePollIntervalHeader", () => {
  test("parses positive, zero, missing, and invalid values", () => {
    expect(parsePollIntervalHeader("60")).toBe(60);
    expect(parsePollIntervalHeader("0")).toBe(0);
    expect(parsePollIntervalHeader(null)).toBeNull();
    expect(parsePollIntervalHeader("abc")).toBeNull();
    expect(parsePollIntervalHeader("-5")).toBeNull();
    expect(parsePollIntervalHeader("999999")).toBe(MAX_POLL_INTERVAL_SEC);
  });
});

describe("coalesceServerPollHeader", () => {
  test("stores override when header > 0", () => {
    expect(coalesceServerPollHeader(60, null)).toEqual({
      serverHeaderSec: 60,
      lastServerOverrideSec: 60,
    });
  });

  test("header 0 clears override for this response only", () => {
    expect(coalesceServerPollHeader(0, 60)).toEqual({
      serverHeaderSec: null,
      lastServerOverrideSec: 60,
    });
  });

  test("missing header reuses last override", () => {
    expect(coalesceServerPollHeader(null, 60)).toEqual({
      serverHeaderSec: 60,
      lastServerOverrideSec: 60,
    });
  });
});

describe("resolvePollIntervalSec", () => {
  test("returns 0 when stream is not off", () => {
    expect(
      resolvePollIntervalSec({
        stream: "auto",
        pollInterval: 10,
        serverHeaderSec: 60,
      }),
    ).toBe(0);
    expect(
      resolvePollIntervalSec({
        stream: "notify",
        pollInterval: 10,
        serverHeaderSec: 60,
      }),
    ).toBe(0);
  });

  test("pollInterval 0 opts out on stream off", () => {
    expect(
      resolvePollIntervalSec({
        stream: "off",
        pollInterval: 0,
        serverHeaderSec: 60,
      }),
    ).toBe(0);
  });

  test("server header wins over client default when > 0", () => {
    expect(
      resolvePollIntervalSec({
        stream: "off",
        serverHeaderSec: 60,
      }),
    ).toBe(60);
  });

  test("header 0 falls through to constructor", () => {
    expect(
      resolvePollIntervalSec({
        stream: "off",
        pollInterval: 15,
        serverHeaderSec: 0,
      }),
    ).toBe(15);
  });

  test("header 0 falls through to env then default", () => {
    expect(
      resolvePollIntervalSec({
        stream: "off",
        envPollInterval: "45",
        serverHeaderSec: 0,
      }),
    ).toBe(45);
    expect(
      resolvePollIntervalSec({
        stream: "off",
        serverHeaderSec: 0,
      }),
    ).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test("clamps server header", () => {
    expect(
      resolvePollIntervalSec({
        stream: "off",
        serverHeaderSec: 999_999,
      }),
    ).toBe(MAX_POLL_INTERVAL_SEC);
  });
});

describe("clampPollIntervalSec", () => {
  test("floors and caps", () => {
    expect(clampPollIntervalSec(0)).toBe(MIN_POLL_INTERVAL_SEC);
    expect(clampPollIntervalSec(MAX_POLL_INTERVAL_SEC + 1)).toBe(
      MAX_POLL_INTERVAL_SEC,
    );
  });
});
