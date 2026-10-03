import type { GovernorDecision } from '@mb/core';
import { ManualClock, MemoryKv } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createCache } from '../src/index';
import { deferred } from './helpers';

function setupCache() {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock);
  const cache = createCache({ kv, clock });
  const decisions: GovernorDecision[] = [];
  const note = (d: GovernorDecision): void => {
    decisions.push(d);
  };
  return { clock, kv, cache, decisions, note };
}

describe('cache', () => {
  it('cache miss loads, then a hit returns the stored value with a cache_hit decision', async () => {
    const { cache, decisions, note } = setupCache();
    let loads = 0;
    const load = async () => {
      loads++;
      return { sku: 'CHAI-250', stock: 42 };
    };

    const miss = await cache.wrap('t1:org1:item:1', 60_000, load, note);
    expect(miss).toEqual({ value: { sku: 'CHAI-250', stock: 42 }, cached: false });
    expect(decisions).toEqual([]);

    const hit = await cache.wrap('t1:org1:item:1', 60_000, load, note);
    expect(hit).toEqual({ value: { sku: 'CHAI-250', stock: 42 }, cached: true });
    expect(decisions).toEqual([{ type: 'cache_hit' }]);
    expect(loads).toBe(1);
  });

  it('cache entries expire after their TTL', async () => {
    const { cache, clock } = setupCache();
    let loads = 0;
    const load = async () => ++loads;

    expect(await cache.wrap('k', 60_000, load)).toEqual({ value: 1, cached: false });
    clock.advance(59_999);
    expect(await cache.wrap('k', 60_000, load)).toEqual({ value: 1, cached: true });
    clock.advance(1);
    expect(await cache.wrap('k', 60_000, load)).toEqual({ value: 2, cached: false });
  });

  it('cache coalescing: 10 concurrent wraps run one load', async () => {
    const { cache, decisions, note } = setupCache();
    const gate = deferred<{ id: string }>();
    let loads = 0;
    const load = () => {
      loads++;
      return gate.promise;
    };

    const all = Promise.all(Array.from({ length: 10 }, () => cache.wrap('k', 60_000, load, note)));
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve({ id: 'one' });
    const results = await all;

    expect(loads).toBe(1);
    expect(results.every((r) => r.value.id === 'one' && !r.cached)).toBe(true);
    expect(decisions).toEqual(Array.from({ length: 9 }, () => ({ type: 'coalesced' })));
  });

  it('load errors are not cached and reach every coalesced caller', async () => {
    const { cache } = setupCache();
    const gate = deferred<string>();
    let loads = 0;
    const failing = () => {
      loads++;
      return gate.promise;
    };

    const pending = Array.from({ length: 3 }, () => cache.wrap('k', 60_000, failing));
    await new Promise((resolve) => setImmediate(resolve));
    gate.reject(new Error('upstream down'));
    const settled = await Promise.allSettled(pending);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(loads).toBe(1);

    await expect(cache.wrap('k', 60_000, async () => 'fresh')).resolves.toEqual({
      value: 'fresh',
      cached: false,
    });
  });

  it('ttl 0 never stores but still coalesces', async () => {
    const { cache, kv } = setupCache();
    let loads = 0;
    const load = async () => ++loads;

    const [a, b] = await Promise.all([cache.wrap('k', 0, load), cache.wrap('k', 0, load)]);
    expect(a).toEqual({ value: 1, cached: false });
    expect(b).toEqual({ value: 1, cached: false });
    expect(await kv.get('cache:k')).toBeNull();
    expect(await cache.wrap('k', 0, load)).toEqual({ value: 2, cached: false });
  });

  it('keys are independent (tenant is part of the key)', async () => {
    const { cache } = setupCache();
    await cache.wrap('tenant-a:org:item:1', 60_000, async () => 'A');
    const other = await cache.wrap('tenant-b:org:item:1', 60_000, async () => 'B');
    expect(other).toEqual({ value: 'B', cached: false });
  });

  it('a corrupt stored entry is treated as a miss', async () => {
    const { cache, kv } = setupCache();
    await kv.set('cache:k', '{not json', { ttlMs: 60_000 });
    expect(await cache.wrap('k', 60_000, async () => 'reloaded')).toEqual({
      value: 'reloaded',
      cached: false,
    });
  });
});
