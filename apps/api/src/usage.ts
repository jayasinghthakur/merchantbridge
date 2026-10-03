import type { Logger, UsageEvent, UsageStore } from '@mb/core';

/**
 * Buffered writer for usage events (one per tool call; ToolRuntime emits them). Tool calls never wait on the
 * database: events are queued and written in batches every `flushMs` or every `batchSize` events.
 */
export interface UsageEmitter {
  /** Queues an event. Never throws. */
  emit(event: UsageEvent): void;
  /** Writes everything queued so far (resolves even when the write fails). */
  flush(): Promise<void>;
  /** Stops the timer and flushes once more. */
  close(): Promise<void>;
  /** Events waiting to be written. */
  readonly pending: number;
}

export interface UsageEmitterOptions {
  store: UsageStore;
  log: Logger;
  flushMs?: number;
  batchSize?: number;
  /** Consecutive failed writes of the same batch before it is dropped. */
  maxAttempts?: number;
  /** Hard cap on queued events; the oldest are dropped beyond it. */
  maxBuffered?: number;
  /** Called for every accepted event (metrics). */
  onEvent?: (event: UsageEvent) => void;
}

export const CLIENT_NAME_MAX = 64;
export const ARGS_MASKED_MAX_BYTES = 2048;

/** Bounds attacker-influenced fields before they reach the database. */
export function sanitizeUsageEvent(e: UsageEvent): UsageEvent {
  const clientName = e.client_name === null ? null : e.client_name.slice(0, CLIENT_NAME_MAX);
  let args = e.args_masked;
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    serialized = '';
    args = {};
  }
  if (Buffer.byteLength(serialized, 'utf8') > ARGS_MASKED_MAX_BYTES) {
    args = { _truncated: true, _keys: Object.keys(e.args_masked).length };
  }
  return { ...e, client_name: clientName, args_masked: args };
}

/**
 * Keeps only argument NAMES the tool declares. `maskArgs` (packages/core) masks values but copies keys verbatim,
 * and tool inputs accept unknown keys, so `{"ravi@example.com": 1}` would land in the audit table. Unknown keys
 * are dropped and only counted. With no allow-list (unknown tool) every key is treated as unknown.
 */
export function restrictArgKeys(
  e: UsageEvent,
  allowed: ReadonlySet<string> | undefined,
): UsageEvent {
  const kept: Record<string, unknown> = {};
  let unknown = 0;
  for (const [k, v] of Object.entries(e.args_masked)) {
    if (allowed?.has(k)) kept[k] = v;
    else unknown += 1;
  }
  if (unknown > 0) kept._unknown_keys = unknown;
  return { ...e, args_masked: kept };
}

/** Declared top-level input property names per tool, from the advertised JSON Schema. */
export function argKeysByTool(
  tools: ReadonlyArray<{ name: string; inputJsonSchema: Record<string, unknown> }>,
): Map<string, ReadonlySet<string>> {
  return new Map(
    tools.map((t) => {
      const props = t.inputJsonSchema.properties;
      const names = typeof props === 'object' && props !== null ? Object.keys(props) : [];
      return [t.name, new Set(names)] as const;
    }),
  );
}

export function createUsageEmitter(opts: UsageEmitterOptions): UsageEmitter {
  const flushMs = opts.flushMs ?? 2_000;
  const batchSize = opts.batchSize ?? 100;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxBuffered = opts.maxBuffered ?? 10_000;
  const { store, log } = opts;

  let queue: UsageEvent[] = [];
  let inflight: Promise<void> | null = null;
  let failures = 0;
  let closed = false;

  const timer = setInterval(() => {
    void flush();
  }, flushMs);
  timer.unref();

  async function writeOnce(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.slice(0, batchSize);
      try {
        await store.insertMany(batch);
        queue = queue.slice(batch.length);
        failures = 0;
      } catch (err) {
        failures += 1;
        const name = err instanceof Error ? err.name : typeof err;
        if (failures >= maxAttempts) {
          queue = queue.slice(batch.length);
          failures = 0;
          log.error(
            { dropped: batch.length, err_name: name },
            'usage events dropped after repeated write failures',
          );
          continue;
        }
        log.warn({ pending: queue.length, err_name: name }, 'usage event write failed; will retry');
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (inflight) return inflight;
    if (queue.length === 0) return Promise.resolve();
    inflight = writeOnce()
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    emit(event) {
      try {
        const clean = sanitizeUsageEvent(event);
        queue.push(clean);
        if (queue.length > maxBuffered) {
          const dropped = queue.length - maxBuffered;
          queue = queue.slice(dropped);
          log.error({ dropped }, 'usage buffer full; oldest events dropped');
        }
        try {
          opts.onEvent?.(clean);
        } catch {
          // metrics must never break a tool call
        }
        if (queue.length >= batchSize && !closed) void flush();
      } catch (err) {
        log.error({ err_name: err instanceof Error ? err.name : typeof err }, 'usage emit failed');
      }
    },
    flush,
    async close() {
      closed = true;
      clearInterval(timer);
      if (inflight) await inflight;
      await flush();
    },
    get pending() {
      return queue.length;
    },
  };
}
