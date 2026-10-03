import { UpstreamError } from '@mb/core';

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Real timers. Kept apart from Clock on purpose: ManualClock.sleep() resolves instantly, so racing an
 * attempt against clock.sleep() would time out every attempt in tests. */
export interface Timers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

/**
 * Runs one upstream attempt with a per-attempt timeout. On timeout the signal is aborted and the attempt
 * rejects with UpstreamError('timeout'), even if the task ignores the signal.
 */
export async function runWithTimeout<T>(
  task: (attempt: number, signal: AbortSignal) => Promise<T>,
  attempt: number,
  timeoutMs: number,
  timers: Timers,
): Promise<T> {
  const controller = new AbortController();
  let handle: TimerHandle | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    handle = timers.set(() => {
      const err = new UpstreamError(
        { kind: 'timeout' },
        `upstream attempt timed out after ${timeoutMs} ms`,
      );
      // Reject before aborting so the race settles on the timeout, not on the task's own AbortError.
      reject(err);
      controller.abort(err);
    }, timeoutMs);
  });
  // Wrapping turns a synchronous throw into a rejection.
  const running = Promise.resolve().then(() => task(attempt, controller.signal));
  // After a timeout nobody awaits `running`; keep its late rejection from going unhandled.
  running.catch(() => undefined);
  try {
    return await Promise.race([running, timedOut]);
  } finally {
    if (handle !== undefined) timers.clear(handle);
  }
}
