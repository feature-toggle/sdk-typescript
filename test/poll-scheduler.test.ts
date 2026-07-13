import { afterEach, describe, expect, test } from "bun:test";
import { PollScheduler } from "../src/shared/poll-scheduler.js";
import { createVisibility } from "./helpers.js";

describe("PollScheduler", () => {
  afterEach(() => {
    // allow pending timers to clear between tests
  });

  test("runs onTick after interval", async () => {
    let ticks = 0;
    const scheduler = new PollScheduler(null);
    scheduler.start(1, async () => {
      ticks += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    scheduler.stop();

    expect(ticks).toBe(1);
  });

  test("pauses while tab hidden and resumes with fresh delay", async () => {
    const visibility = createVisibility(false);
    let ticks = 0;
    const scheduler = new PollScheduler(visibility);
    scheduler.start(1, async () => {
      ticks += 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(ticks).toBe(1);

    visibility.setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(ticks).toBe(1);

    visibility.setHidden(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    scheduler.stop();

    expect(ticks).toBe(2);
  });

  test("reschedule changes interval", async () => {
    let ticks = 0;
    const scheduler = new PollScheduler(null);
    scheduler.start(2, async () => {
      ticks += 1;
    });

    scheduler.reschedule(1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    scheduler.stop();

    expect(ticks).toBe(1);
  });

  test("stop prevents further ticks", async () => {
    let ticks = 0;
    const scheduler = new PollScheduler(null);
    scheduler.start(1, async () => {
      ticks += 1;
    });

    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(ticks).toBe(0);
  });
});
