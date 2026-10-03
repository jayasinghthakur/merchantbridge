import type { GovernorScope, Kv } from '@mb/core';
import { ManualClock, MemoryKv, zohoRateProfile } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createGovernor, governorKeys } from '../src/index';
import {
  deferred,
  maxInAnyWindow,
  mulberry32,
  recordAdmissions,
  rejection,
  setup,
  tick,
  upstream,
} from './helpers';

/** Kv whose every round trip takes a random 0–39 ms of fake time, like a remote Redis. */
function jitteryKv(clock: ManualClock, seed: number): Kv {
  const inner = new MemoryKv(clock);
  const random = mulberry32(seed);
  const roundTrip = <T>(op: () => Promise<T>): Promise<T> => {
    clock.advance(Math.floor(random() * 40));
    return op();
  };
  return {
    get: (k) => roundTrip(() => inner.get(k)),
    set: (k, v, o) => roundTrip(() => inner.set(k, v, o)),
    del: (k) => roundTrip(() => inner.del(k)),
    incr: (k, ttl) => roundTrip(() => inner.incr(k, ttl)),
    pttl: (k) => roundTrip(() => inner.pttl(k)),
    zadd: (k, s, m) => roundTrip(() => inner.zadd(k, s, m)),
    zrem: (k, m) => roundTrip(() => inner.zrem(k, m)),
    zremrangebyscore: (k, min, max) => roundTrip(() => inner.zremrangebyscore(k, min, max)),
    zcard: (k) => roundTrip(() => inner.zcard(k)),
  };
}

describe('concurrency leases', () => {
  it('concurrency never exceeds the limit', async () => {
    const { governor, scope } = setup(); // free plan: 4
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        governor.schedule(scope, async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick();
          await tick();
          inFlight--;
          return i;
        }),
      ),
    );
    expect(results).toHaveLength(30);
    expect(maxInFlight).toBe(4);
    expect((await governor.snapshot(scope)).in_flight).toBe(0);
  });

  it('a crashed worker’s lease expires after leaseMs and frees the slot for a waiting call', async () => {
    const { governor, scope, kv, clock, decisions, note } = setup({ leaseMs: 5_000 });
    const keys = governorKeys(scope.key);
    // Another process admitted 4 requests and died without releasing.
    for (let i = 0; i < 4; i++) await kv.zadd(keys.leases, clock.now() + 5_000, `crashed-${i}`);
    expect((await governor.snapshot(scope)).in_flight).toBe(4);

    const value = await governor.schedule(scope, async () => 'ok', note);
    expect(value).toBe('ok');
    expect(decisions[0]).toMatchObject({ type: 'queued', reason: 'concurrency' });
    expect(decisions.at(-1)).toEqual({ type: 'admitted', waited_ms: 5_000 });
    expect((await governor.snapshot(scope)).in_flight).toBe(0);
  });

  it('crashed leases that outlive the queue timeout → RATE_LIMITED, then usable once expired', async () => {
    const { governor, scope, kv, clock } = setup(); // leaseMs 30 s > queueTimeoutMs 10 s
    const keys = governorKeys(scope.key);
    for (let i = 0; i < 4; i++) await kv.zadd(keys.leases, clock.now() + 30_000, `crashed-${i}`);

    const err = await rejection(governor.schedule(scope, async () => 'never'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(2);
    expect(err.message).toMatch(/already in progress/);

    clock.advance(20_000);
    await expect(governor.schedule(scope, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('queue timeout', () => {
  it('queue timeout on the minute bucket → RATE_LIMITED with retry_after_s, without waiting', async () => {
    const { governor, scope, clock, decisions, note } = setup({ perMinute: 2 });
    await governor.schedule(scope, async () => 1);
    await governor.schedule(scope, async () => 2);

    let called = false;
    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          called = true;
        },
        note,
      ),
    );
    expect(called).toBe(false);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(60);
    expect(err.message).toBe(
      'This organization reached its limit of 2 Zoho requests per minute; retry after 60 s.',
    );
    expect(decisions).toEqual([{ type: 'rejected', code: 'RATE_LIMITED', retry_after_s: 60 }]);
    expect(clock.sleeps).toEqual([]); // predicted wait > queueTimeoutMs: fail fast

    // 50 s later the wait is exactly the 10 s queue budget: it queues and is admitted.
    clock.advance(50_000);
    const later: typeof decisions = [];
    await governor.schedule(
      scope,
      async () => 3,
      (d) => later.push(d),
    );
    expect(later).toEqual([
      { type: 'queued', reason: 'minute_bucket', wait_ms: 10_000 },
      { type: 'admitted', waited_ms: 10_000 },
    ]);
  });

  it('queue timeout on concurrency → RATE_LIMITED with retry_after_s', async () => {
    const { governor, scope, decisions, note } = setup({ concurrency: 1, queueTimeoutMs: 30 });
    const hold = deferred();
    const first = governor.schedule(scope, () => hold.promise.then(() => 'first'));
    await tick();

    const err = await rejection(governor.schedule(scope, async () => 'second', note));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(2);
    expect(decisions).toEqual([
      { type: 'queued', reason: 'concurrency', wait_ms: 30 },
      { type: 'rejected', code: 'RATE_LIMITED', retry_after_s: 2 },
    ]);

    hold.resolve();
    await expect(first).resolves.toBe('first');
  });

  it('a call arriving while a lease release is still being written waits for it, not a poll', async () => {
    const { governor, scope, kv, decisions, note } = setup({ concurrency: 1 });
    const zremGate = deferred();
    let holdZrem = false;
    const zrem = kv.zrem.bind(kv);
    kv.zrem = async (key, member) => {
      if (holdZrem) await zremGate.promise;
      return zrem(key, member);
    };
    const hold = deferred();
    const first = governor.schedule(scope, () => hold.promise.then(() => 'first'));
    await tick();
    holdZrem = true;
    hold.resolve();
    await tick(); // the first task settled; its lease removal is still in flight
    const second = governor.schedule(scope, async () => 'second', note);
    await tick();
    zremGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(decisions.map((d) => d.type)).toEqual(['queued', 'admitted']);
  });

  it('a waiting call takes the slot as soon as a local lease is released', async () => {
    const { governor, scope, decisions, note } = setup({ concurrency: 1 });
    const hold = deferred();
    const first = governor.schedule(scope, () => hold.promise.then(() => 'first'));
    await tick();
    const second = governor.schedule(scope, async () => 'second', note);
    await tick();
    hold.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(decisions.map((d) => d.type)).toEqual(['queued', 'admitted']);
  });
});

describe('per-minute window', () => {
  it('200 concurrent tasks on one key: no 60 s window admits more than perMinute', async () => {
    const { governor, scope, kv } = setup({ queueTimeoutMs: 180_000 });
    const admittedAt = recordAdmissions(kv);

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => governor.schedule(scope, async () => i)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(admittedAt).toHaveLength(200);
    expect(maxInAnyWindow(admittedAt)).toBe(80);
    const t0 = admittedAt[0] ?? 0;
    expect(admittedAt.filter((t) => t === t0)).toHaveLength(80);
    expect(admittedAt.filter((t) => t === t0 + 60_000)).toHaveLength(80);
    expect(admittedAt.filter((t) => t === t0 + 120_000)).toHaveLength(40);
  });

  it('200 concurrent tasks with the default 10 s queue: 80 admitted, 120 RATE_LIMITED', async () => {
    const { governor, scope } = setup();
    let admitted = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, () =>
        governor.schedule(scope, async () => {
          admitted++;
        }),
      ),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(admitted).toBe(80);
    expect(rejected).toHaveLength(120);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ code: 'RATE_LIMITED', retryAfterS: 60 });
    }
  });

  it.each([1, 2, 3, 4, 5])(
    'sends measured inside the task stay at or under perMinute when Kv latency varies (seed %i)',
    async (seed) => {
      const clock = new ManualClock();
      const kv = jitteryKv(clock, seed);
      const governor = createGovernor({ kv, clock, random: () => 0.5 });
      const scope: GovernorScope = {
        key: 'demo:remote-kv',
        profile: { ...zohoRateProfile('free'), queueTimeoutMs: 600_000 },
      };
      const sentAt: number[] = [];
      await Promise.all(
        Array.from({ length: 200 }, () =>
          governor.schedule(scope, async () => {
            sentAt.push(clock.now());
          }),
        ),
      );
      expect(sentAt).toHaveLength(200);
      expect(maxInAnyWindow(sentAt)).toBeLessThanOrEqual(80);
    },
  );

  it('two parallel agents scheduling 100 tasks each stay at or under perMinute in every window', async () => {
    const { governor, scope, clock, kv } = setup();
    const admittedAt = recordAdmissions(kv);
    const think = mulberry32(42);
    let rejections = 0;
    let completed = 0;

    async function agent(tasks: number): Promise<void> {
      for (let i = 0; i < tasks; i++) {
        for (;;) {
          try {
            await governor.schedule(scope, async () => {
              completed++;
            });
            break;
          } catch (e) {
            expect(e).toMatchObject({ code: 'RATE_LIMITED' });
            rejections++;
            // A well-behaved agent waits retry_after_s before trying again.
            await clock.sleep(((e as { retryAfterS?: number }).retryAfterS ?? 1) * 1000);
          }
        }
        await clock.sleep(Math.floor(think() * 400));
      }
    }

    await Promise.all([agent(100), agent(100)]);
    expect(completed).toBe(200);
    expect(admittedAt).toHaveLength(200);
    expect(maxInAnyWindow(admittedAt)).toBe(80); // reaches the ceiling, never exceeds it
    expect(rejections).toBeGreaterThan(0);
    // The run spans several windows, so the sliding (not fixed) window is what is being exercised.
    expect(Math.max(...admittedAt) - Math.min(...admittedAt)).toBeGreaterThan(120_000);
  });
});

describe('daily budget', () => {
  it('daily budget share: floor(dailyLimit * dailyShare) admitted attempts per UTC day', async () => {
    const { governor, scope, clock } = setup({ dailyLimit: 10, dailyShare: 0.5 });
    for (let i = 0; i < 5; i++) await governor.schedule(scope, async () => i);
    expect(await governor.snapshot(scope)).toMatchObject({
      daily_budget: 5,
      budget_remaining_today: 0,
    });

    let called = false;
    const err = await rejection(
      governor.schedule(scope, async () => {
        called = true;
      }),
    );
    expect(called).toBe(false);
    expect(err.code).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err.retryAfterS).toBe(15 * 3600);
    expect(err.message).toMatch(/today's budget of 5 Zoho API calls/);

    clock.advance(15 * 3600 * 1000);
    await expect(governor.schedule(scope, async () => 'tomorrow')).resolves.toBe('tomorrow');
    expect((await governor.snapshot(scope)).budget_remaining_today).toBe(4);
  });

  it('every retry counts against the daily budget', async () => {
    const { governor, scope } = setup({ dailyLimit: 10, dailyShare: 0.4 });
    await governor.schedule(scope, async (attempt) => {
      if (attempt < 3) throw upstream.server(500);
      return 'ok';
    });
    expect((await governor.snapshot(scope)).budget_remaining_today).toBe(1);
  });

  it('a retry that would exceed the budget is rejected before calling upstream', async () => {
    const { governor, scope } = setup({ dailyLimit: 2, dailyShare: 1 });
    let calls = 0;
    const err = await rejection(
      governor.schedule(scope, async () => {
        calls++;
        throw upstream.server(500);
      }),
    );
    expect(calls).toBe(2);
    expect(err.code).toBe('DAILY_QUOTA_EXHAUSTED');
  });
});
