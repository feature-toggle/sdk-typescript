import { describe, expect, test } from "bun:test";
import { parseSseChunk, readFeaturesVersionFromEventData } from "../src/shared/sse-parse.js";

describe("parseSseChunk", () => {
  test("parses features-changed event", () => {
    const chunk =
      'event: features-changed\ndata: {"featuresVersion":42}\n\n';
    const { events, remainder } = parseSseChunk(chunk);
    expect(remainder).toBe("");
    expect(events).toEqual([
      {
        event: "features-changed",
        data: { featuresVersion: 42 },
      },
    ]);
  });

  test("buffers partial events", () => {
    const { events, remainder } = parseSseChunk(
      'event: ping\ndata: {}\n\nevent: features-changed\ndata: {"featuresVersion":2}',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("ping");
    expect(remainder).toContain("features-changed");
  });
});

describe("readFeaturesVersionFromEventData", () => {
  test("reads numeric version", () => {
    expect(readFeaturesVersionFromEventData({ featuresVersion: 3 })).toBe(3);
  });

  test("rejects invalid payload", () => {
    expect(readFeaturesVersionFromEventData({ featuresVersion: "x" })).toBeNull();
    expect(readFeaturesVersionFromEventData(null)).toBeNull();
  });
});
