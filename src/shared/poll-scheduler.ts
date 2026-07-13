import type { VisibilitySource } from "./visibility.js";

export class PollScheduler {
  private intervalSec = 0;
  private onTick: (() => Promise<void>) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private paused = false;
  private visibilityHandler: (() => void) | null = null;

  constructor(private readonly visibility: VisibilitySource | null) {}

  isRunning(): boolean {
    return !this.stopped && this.onTick !== null;
  }

  start(intervalSec: number, onTick: () => Promise<void>): void {
    this.stop();
    this.stopped = false;
    this.intervalSec = intervalSec;
    this.onTick = onTick;
    this.paused = this.visibility?.hidden ?? false;
    this.attachVisibilityListener();
    if (!this.paused) {
      this.scheduleNext();
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearScheduledTimeout();
    this.detachVisibilityListener();
    this.onTick = null;
  }

  reschedule(intervalSec: number): void {
    if (this.stopped || !this.onTick) return;
    if (intervalSec === this.intervalSec) return;
    this.intervalSec = intervalSec;
    if (!this.paused) {
      this.clearScheduledTimeout();
      this.scheduleNext();
    }
  }

  private attachVisibilityListener(): void {
    if (!this.visibility || this.visibilityHandler) return;

    this.visibilityHandler = () => {
      if (this.stopped || !this.onTick) return;
      if (this.visibility?.hidden) {
        this.paused = true;
        this.clearScheduledTimeout();
        return;
      }
      this.paused = false;
      this.scheduleNext();
    };

    this.visibility.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private detachVisibilityListener(): void {
    if (!this.visibility || !this.visibilityHandler) return;
    this.visibility.removeEventListener(
      "visibilitychange",
      this.visibilityHandler,
    );
    this.visibilityHandler = null;
  }

  private clearScheduledTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped || this.paused || !this.onTick) return;
    this.clearScheduledTimeout();
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      void this.runTick();
    }, this.intervalSec * 1000);
  }

  private async runTick(): Promise<void> {
    if (this.stopped || this.paused || !this.onTick) return;
    const tick = this.onTick;
    try {
      await tick();
    } finally {
      if (!this.stopped && !this.paused) {
        this.scheduleNext();
      }
    }
  }
}
