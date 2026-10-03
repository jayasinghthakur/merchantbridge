import type { Cache, Clock, GovernorDecision, Kv, Logger } from '@mb/core';
import { noopLogger } from '@mb/core';

export interface CacheDeps {
  kv: Kv;
  clock: Clock;
  log?: Logger;
}

interface Stored {
  v: unknown;
  /** Epoch ms; checked against the injected clock in case the Kv TTL is coarse. */
  exp: number;
}

function decodeStored(raw: string | null, now: number): { value: unknown } | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { v, exp } = parsed as Partial<Stored>;
    if (typeof exp !== 'number' || exp <= now) return null;
    return { value: v };
  } catch {
    return null;
  }
}

/**
 * Read-through JSON cache over Kv with in-process coalescing of identical in-flight loads. Keys must already
 * include the tenant (and org); they are stored as `cache:<key>`. A `ttlMs` ≤ 0 skips Kv but still coalesces.
 * Values are shared between coalesced callers: treat them as immutable. Load errors are never cached.
 */
export function createCache(deps: CacheDeps): Cache {
  const { kv, clock } = deps;
  const log = deps.log ?? noopLogger;
  const inflight = new Map<string, Promise<unknown>>();

  async function read(key: string): Promise<{ value: unknown } | null> {
    try {
      return decodeStored(await kv.get(`cache:${key}`), clock.now());
    } catch (err) {
      // A cache outage degrades to a miss rather than failing the tool call.
      log.warn({ err }, 'cache: read failed; loading from upstream');
      return null;
    }
  }

  async function write(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (value === undefined) return;
    const stored: Stored = { v: value, exp: clock.now() + ttlMs };
    try {
      await kv.set(`cache:${key}`, JSON.stringify(stored), { ttlMs });
    } catch (err) {
      log.warn({ err }, 'cache: write failed; value not cached');
    }
  }

  return {
    async wrap<T>(
      key: string,
      ttlMs: number,
      load: () => Promise<T>,
      onDecision?: (d: GovernorDecision) => void,
    ): Promise<{ value: T; cached: boolean }> {
      const emit = (d: GovernorDecision): void => {
        try {
          onDecision?.(d);
        } catch (err) {
          log.warn({ err }, 'cache: onDecision callback threw');
        }
      };

      const join = async (pending: Promise<unknown>) => {
        emit({ type: 'coalesced' });
        return { value: (await pending) as T, cached: false };
      };

      const pending = inflight.get(key);
      if (pending) return join(pending);

      if (ttlMs > 0) {
        const hit = await read(key);
        if (hit) {
          emit({ type: 'cache_hit' });
          return { value: hit.value as T, cached: true };
        }
        // Another caller may have started the load while we were reading Kv.
        const raced = inflight.get(key);
        if (raced) return join(raced);
      }

      const loading = (async () => {
        const value = await load();
        if (ttlMs > 0) await write(key, value, ttlMs);
        return value;
      })();
      inflight.set(key, loading);
      try {
        return { value: await loading, cached: false };
      } finally {
        if (inflight.get(key) === loading) inflight.delete(key);
      }
    },
  };
}
