/**
 * In-process FIFO mutex. The governor's Kv check-then-act steps (count, then add) are not atomic, so every
 * admission for one key runs under this lock; that makes a single process exact.
 */
export class FifoLock {
  private tail: Promise<void> = Promise.resolve();
  private holdersAndWaiters = 0;

  /** Holders plus waiters; 0 when idle. */
  get size(): number {
    return this.holdersAndWaiters;
  }

  /** Resolves with a release function once every earlier caller has released. */
  acquire(): Promise<() => void> {
    this.holdersAndWaiters++;
    let open!: () => void;
    const mine = new Promise<void>((resolve) => {
      open = resolve;
    });
    const previous = this.tail;
    this.tail = mine;
    let released = false;
    return previous.then(() => () => {
      if (released) return;
      released = true;
      this.holdersAndWaiters--;
      open();
    });
  }
}
