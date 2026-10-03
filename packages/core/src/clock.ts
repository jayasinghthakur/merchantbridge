/** Injected everywhere time matters so governor/auth tests can use fake time. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Deterministic clock for tests: sleep() advances time immediately. */
export class ManualClock implements Clock {
  private t: number;
  readonly sleeps: number[] = [];

  constructor(start = Date.UTC(2026, 9, 3, 9, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  }
}
