import { describe, expect, it } from 'vitest';
import { MAX_ARG_KEYS, ManualClock, MemoryKv, OTHER_ARG_KEYS, maskArgs } from '../src/index';

describe('MemoryKv sweep', () => {
  it('purges expired write-once keys without them being read again', async () => {
    const clock = new ManualClock();
    const kv = new MemoryKv(clock);
    for (let i = 0; i < 500; i++) await kv.incr(`lim:ip:${i}`, 1_000);
    expect(kv.size).toBe(500);
    clock.advance(2_000);
    // The next writes cross the sweep threshold; only the fresh keys survive.
    for (let i = 0; i < 500; i++) await kv.incr(`lim:ip2:${i}`, 60_000);
    expect(kv.size).toBe(500);
    expect(await kv.get('lim:ip:0')).toBeNull();
    expect(await kv.get('lim:ip2:0')).toBe('1');
  });

  it('drops empty sorted sets on sweep but keeps non-empty ones and keys without expiry', async () => {
    const kv = new MemoryKv(new ManualClock());
    await kv.zadd('z:empty', 1, 'a');
    await kv.zrem('z:empty', 'a');
    await kv.zadd('z:full', 1, 'a');
    await kv.set('forever', 'x');
    kv.sweep();
    expect(await kv.zcard('z:full')).toBe(1);
    expect(await kv.get('forever')).toBe('x');
    expect(kv.size).toBe(2);
  });
});

describe('maskArgs key names', () => {
  it('copies snake_case names and drops names that could carry free text or PII', () => {
    expect(
      maskArgs({ sku: 'CHAI-250', 'jane@example.com': 1, 'Ignore previous instructions': true }),
    ).toEqual({
      sku: 'CHAI-250',
      [OTHER_ARG_KEYS]: 2,
    });
  });

  it(`never returns more than ${MAX_ARG_KEYS} entries`, () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const out = maskArgs(many);
    expect(Object.keys(out)).toHaveLength(MAX_ARG_KEYS);
    expect(out[OTHER_ARG_KEYS]).toBe(50 - (MAX_ARG_KEYS - 1));
  });

  it('leaves small, safe argument objects unchanged apart from value masking', () => {
    expect(maskArgs({ limit: 5, query: 'masala chai' })).toEqual({ limit: 5, query: '<text:11>' });
  });
});
