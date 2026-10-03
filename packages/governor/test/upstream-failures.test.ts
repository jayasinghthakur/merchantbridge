import { ConnectorError } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { kinds, rejection, setup, upstream } from './helpers';

const SECONDS_TO_UTC_MIDNIGHT = 15 * 3600; // ManualClock starts at 2026-10-03T09:00:00Z

describe('code 44 (upstream per-minute block)', () => {
  it('code 44 opens the circuit, rejects instantly while open, and recovers after 60 s', async () => {
    const { governor, scope, clock, decisions, note } = setup();
    let calls = 0;

    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          throw upstream.minute();
        },
        note,
      ),
    );
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(60);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe(
      'Zoho temporarily blocked this organization for exceeding its per-minute request limit; retry after 60 s.',
    );
    expect(err.hint).toMatch(/retry_after_s/);
    expect(calls).toBe(1); // never retried
    expect(decisions).toEqual([
      { type: 'admitted', waited_ms: 0 },
      { type: 'circuit_open', until_ms: clock.now() + 60_000, reason: 'upstream_minute_block' },
      { type: 'rejected', code: 'RATE_LIMITED', retry_after_s: 60 },
    ]);
    expect((await governor.snapshot(scope)).circuit).toBe('open');

    clock.advance(20_000);
    const during: typeof decisions = [];
    const blocked = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          return 'unreachable';
        },
        (d) => during.push(d),
      ),
    );
    expect(blocked.code).toBe('RATE_LIMITED');
    expect(blocked.retryAfterS).toBe(40);
    expect(calls).toBe(1); // no upstream attempt while open
    expect(during).toEqual([{ type: 'rejected', code: 'RATE_LIMITED', retry_after_s: 40 }]);
    expect(clock.sleeps).toEqual([]); // instant: no queueing

    clock.advance(40_000);
    await expect(governor.schedule(scope, async () => 'recovered')).resolves.toBe('recovered');
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
  });
});

describe('code 45 (upstream daily quota)', () => {
  it('code 45 marks the key exhausted until UTC midnight and is never retried', async () => {
    const { governor, scope, clock, decisions, note } = setup();
    let calls = 0;

    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          throw upstream.daily();
        },
        note,
      ),
    );
    expect(err.code).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err.retryAfterS).toBe(SECONDS_TO_UTC_MIDNIGHT);
    expect(err.message).toMatch(/resets? at 00:00 UTC, in about 15 h/);
    expect(calls).toBe(1);
    expect(kinds(decisions)).toEqual(['admitted', 'rejected']);
    expect((await governor.snapshot(scope)).budget_remaining_today).toBe(0);

    // Still exhausted one second before midnight, with no upstream call.
    clock.advance(SECONDS_TO_UTC_MIDNIGHT * 1000 - 1_000);
    const late = await rejection(governor.schedule(scope, async () => calls++));
    expect(late.code).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(late.retryAfterS).toBe(1);
    expect(calls).toBe(1);

    clock.advance(1_000);
    await expect(governor.schedule(scope, async () => 'new day')).resolves.toBe('new day');
    expect((await governor.snapshot(scope)).budget_remaining_today).toBe(499);
  });
});

describe('code 1070 and other 429s', () => {
  it('1070 backs off with full jitter, then succeeds', async () => {
    const { governor, scope, clock, decisions, note } = setup();
    const attempts: number[] = [];

    const value = await governor.schedule(
      scope,
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) throw upstream.concurrency();
        return 'ok';
      },
      note,
    );
    expect(value).toBe('ok');
    expect(attempts).toEqual([1, 2]);
    // random() = 0.5 → 0.5 * min(cap, 500 * 2^0) = 250 ms
    expect(clock.sleeps).toEqual([250]);
    expect(decisions).toEqual([
      { type: 'admitted', waited_ms: 0 },
      { type: 'retried', attempt: 2, reason: 'upstream_concurrency', backoff_ms: 250 },
      { type: 'admitted', waited_ms: 0 },
    ]);
  });

  it('1070 retry exhaustion → RATE_LIMITED with retry_after_s', async () => {
    const { governor, scope, clock, decisions, note } = setup();
    let calls = 0;

    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          throw upstream.concurrency();
        },
        note,
      ),
    );
    expect(calls).toBe(4); // 1 + maxRetries429 (3)
    expect(clock.sleeps).toEqual([250, 500, 1000]);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(4); // ceiling of the next backoff step: 500 * 2^3 ms
    expect(err.message).toMatch(/too many requests for this organization were in progress/);
    expect(decisions.at(-1)).toEqual({ type: 'rejected', code: 'RATE_LIMITED', retry_after_s: 4 });
    expect(kinds(decisions).filter((k) => k === 'retried')).toHaveLength(3);
  });

  it('honors an upstream Retry-After of up to 10 s instead of jitter', async () => {
    const { governor, scope, clock } = setup();
    const value = await governor.schedule(scope, async (attempt) => {
      if (attempt === 1) throw upstream.concurrency(3);
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(clock.sleeps).toEqual([3000]);
  });

  it('does not sleep on a Retry-After above 10 s; passes it to the agent', async () => {
    const { governor, scope, clock } = setup();
    let calls = 0;
    const err = await rejection(
      governor.schedule(scope, async () => {
        calls++;
        throw upstream.concurrency(30);
      }),
    );
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterS).toBe(30);
  });

  it.each([Number.NaN, -30, Number.POSITIVE_INFINITY])(
    'ignores a malformed upstream Retry-After (%s) and backs off with full jitter instead',
    async (retryAfterS) => {
      const { governor, scope, clock, decisions, note } = setup();
      const t0 = clock.now();
      const value = await governor.schedule(
        scope,
        async (attempt) => {
          if (attempt === 1) throw upstream.concurrency(retryAfterS);
          return 'ok';
        },
        note,
      );
      expect(value).toBe('ok');
      expect(clock.sleeps).toEqual([250]);
      expect(clock.now() - t0).toBe(250);
      expect(decisions[1]).toEqual({
        type: 'retried',
        attempt: 2,
        reason: 'upstream_concurrency',
        backoff_ms: 250,
      });
    },
  );

  it('a malformed Retry-After never reaches the agent as retry_after_s', async () => {
    for (const bad of [Number.NaN, -30, Number.POSITIVE_INFINITY]) {
      const { governor, scope } = setup();
      const err = await rejection(
        governor.schedule(scope, async () => {
          throw upstream.concurrency(bad);
        }),
      );
      expect(err.code).toBe('RATE_LIMITED');
      expect(err.retryAfterS).toBe(4);
      expect(err.toBody().error.retry_after_s).toBe(4);
      expect(err.message).toMatch(/retry after 4 s\.$/);
    }
  });

  it('treats an unclassified HTTP 429 like 1070', async () => {
    const { governor, scope, decisions, note } = setup();
    const value = await governor.schedule(
      scope,
      async (attempt) => {
        if (attempt === 1) throw upstream.server(429);
        return 'ok';
      },
      note,
    );
    expect(value).toBe('ok');
    expect(decisions[1]).toEqual({
      type: 'retried',
      attempt: 2,
      reason: 'upstream_429',
      backoff_ms: 250,
    });
  });
});

describe('5xx, timeout, network', () => {
  it('5xx is retried twice, then UPSTREAM_ERROR', async () => {
    const { governor, scope, clock, decisions, note } = setup();
    let calls = 0;

    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          throw upstream.server(503);
        },
        note,
      ),
    );
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([250, 500]);
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterS).toBeUndefined();
    expect(err.message).toBe('Zoho returned a server error (HTTP 503) on 3 attempts.');
    expect(JSON.stringify(err.toBody())).not.toContain('secret-body');
    expect(decisions).toEqual([
      { type: 'admitted', waited_ms: 0 },
      { type: 'retried', attempt: 2, reason: 'upstream_503', backoff_ms: 250 },
      { type: 'admitted', waited_ms: 0 },
      { type: 'retried', attempt: 3, reason: 'upstream_503', backoff_ms: 500 },
      { type: 'admitted', waited_ms: 0 },
    ]);
  });

  it('5xx then success returns the value', async () => {
    const { governor, scope } = setup();
    const value = await governor.schedule(scope, async (attempt) => {
      if (attempt < 3) throw upstream.server(502);
      return attempt;
    });
    expect(value).toBe(3);
  });

  it('timeout: each attempt is aborted after requestTimeoutMs and retried, then UPSTREAM_ERROR', async () => {
    const { governor, scope, decisions, note } = setup({ requestTimeoutMs: 20 });
    const signals: AbortSignal[] = [];

    const err = await rejection(
      governor.schedule(
        scope,
        (_attempt, signal) => {
          signals.push(signal);
          return new Promise<never>(() => undefined); // hangs and ignores the signal
        },
        note,
      ),
    );
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).toBe('Zoho did not respond in time on 3 attempts.');
    expect(decisions.filter((d) => d.type === 'retried').map((d) => d.reason)).toEqual([
      'upstream_timeout',
      'upstream_timeout',
    ]);
    // Leases were released even though the tasks never settled.
    expect((await governor.snapshot(scope)).in_flight).toBe(0);
  });

  it('timeout uses real timers: ManualClock.sleep inside a task does not trip it', async () => {
    const { governor, scope, clock } = setup();
    const value = await governor.schedule(scope, async () => {
      await clock.sleep(60_000); // advances fake time far beyond requestTimeoutMs
      return 'slow but fine';
    });
    expect(value).toBe('slow but fine');
  });

  it('network errors are retried and can recover', async () => {
    const { governor, scope, decisions, note } = setup();
    const value = await governor.schedule(
      scope,
      async (attempt) => {
        if (attempt < 3) throw upstream.network();
        return 'reconnected';
      },
      note,
    );
    expect(value).toBe('reconnected');
    expect(decisions.filter((d) => d.type === 'retried').map((d) => d.reason)).toEqual([
      'upstream_network',
      'upstream_network',
    ]);
  });

  it('network errors exhaust retries → UPSTREAM_ERROR without leaking details', async () => {
    const { governor, scope } = setup();
    const err = await rejection(
      governor.schedule(scope, async () => {
        throw upstream.network();
      }),
    );
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).toBe('Could not reach Zoho on 3 attempts (network error).');
    expect(err.message).not.toContain('10.0.0.1');
  });
});

describe('non-upstream errors', () => {
  it('NOT_FOUND is rethrown immediately, not retried, not counted by the breaker', async () => {
    const { governor, scope, clock, decisions, note } = setup({ breakerThreshold: 1 });
    const notFound = new ConnectorError('NOT_FOUND', 'No item with id 42.');
    let calls = 0;

    const err = await rejection(
      governor.schedule(
        scope,
        async () => {
          calls++;
          throw notFound;
        },
        note,
      ),
    );
    expect(err).toBe(notFound);
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect(kinds(decisions)).toEqual(['admitted']);
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
  });

  it('unknown errors are rethrown as-is without retry', async () => {
    const { governor, scope } = setup();
    let calls = 0;
    const boom = new TypeError('mapper bug');
    await expect(
      governor.schedule(scope, () => {
        calls++;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
    expect((await governor.snapshot(scope)).in_flight).toBe(0);
  });
});
