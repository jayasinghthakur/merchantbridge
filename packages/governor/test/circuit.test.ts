import type { GovernorDecision, GovernorScope } from '@mb/core';
import { ManualClock, MemoryKv, zohoRateProfile } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createGovernor, governorKeys } from '../src/index';
import { deferred, rejection, setup, tick, upstream } from './helpers';

describe('breaker', () => {
  it('breaker opens after consecutive failures, half-opens for one probe, and closes on success', async () => {
    const { governor, scope, clock } = setup(); // threshold 5, open 30 s, 2 retries
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls++;
      throw upstream.server(500);
    };

    for (let i = 0; i < 4; i++) {
      const err = await rejection(governor.schedule(scope, failing));
      expect(err.retryAfterS).toBeUndefined();
    }
    expect((await governor.snapshot(scope)).circuit).toBe('closed');

    const fifth: GovernorDecision[] = [];
    const opening = await rejection(governor.schedule(scope, failing, (d) => fifth.push(d)));
    expect(calls).toBe(15); // 5 calls x 3 attempts
    expect(opening.code).toBe('UPSTREAM_ERROR');
    expect(opening.retryAfterS).toBe(30);
    expect(opening.message).toMatch(/paused for 30 s/);
    expect(fifth.at(-1)).toEqual({
      type: 'circuit_open',
      until_ms: clock.now() + 30_000,
      reason: 'breaker',
    });
    const snap = await governor.snapshot(scope);
    expect(snap.circuit).toBe('open');
    expect(snap.circuit_open_until).toBe(new Date(clock.now() + 30_000).toISOString());

    // Open: instant rejection, no upstream attempt.
    clock.advance(10_000);
    const whileOpen = await rejection(governor.schedule(scope, failing));
    expect(whileOpen.code).toBe('UPSTREAM_ERROR');
    expect(whileOpen.retryAfterS).toBe(20);
    expect(calls).toBe(15);

    // Half-open: exactly one probe; a failed probe re-opens without retries.
    clock.advance(20_000);
    expect((await governor.snapshot(scope)).circuit).toBe('half_open');
    const probeGate = deferred();
    const probe = governor.schedule(scope, async () => {
      calls++;
      await probeGate.promise;
      throw upstream.server(502);
    });
    await tick();
    const concurrent = await rejection(governor.schedule(scope, async () => 'not the probe'));
    expect(concurrent.code).toBe('UPSTREAM_ERROR');
    expect(concurrent.retryAfterS).toBe(2);
    probeGate.resolve();
    const probeErr = await rejection(probe);
    expect(probeErr.code).toBe('UPSTREAM_ERROR');
    expect(probeErr.retryAfterS).toBe(30);
    expect(calls).toBe(16); // one probe attempt, no retries
    expect((await governor.snapshot(scope)).circuit).toBe('open');

    // Next half-open probe succeeds → closed; normal traffic resumes.
    clock.advance(30_000);
    expect((await governor.snapshot(scope)).circuit).toBe('half_open');
    await expect(governor.schedule(scope, async () => 'probe ok')).resolves.toBe('probe ok');
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
    await expect(governor.schedule(scope, async () => 'normal')).resolves.toBe('normal');
  });

  it('a half-open probe that retries on 1070 keeps the single probe slot across attempts', async () => {
    const { governor, scope, clock, kv } = setup({ breakerThreshold: 1, maxRetries5xx: 0 });
    await rejection(
      governor.schedule(scope, async () => {
        throw upstream.server(500);
      }),
    );
    clock.advance(30_000);
    expect((await governor.snapshot(scope)).circuit).toBe('half_open');

    const secondAttempt = deferred();
    const probe = governor.schedule(scope, async (attempt) => {
      if (attempt === 1) throw upstream.concurrency();
      await secondAttempt.promise;
      return 'probe ok';
    });
    for (let i = 0; i < 5; i++) await tick();
    // Renewed on attempt 2: queue 10 s + request 10 s + longest backoff 10 s + 5 s slack.
    expect(await kv.pttl(governorKeys(scope.key).probe)).toBe(35_000);
    const other = await rejection(governor.schedule(scope, async () => 'second probe?'));
    expect(other.message).toMatch(/a test request is in progress/);

    secondAttempt.resolve();
    await expect(probe).resolves.toBe('probe ok');
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
    expect(await kv.get(governorKeys(scope.key).probe)).toBeNull();
  });

  it('a breaker opening during a code-44 block never shortens the block', async () => {
    const { governor, scope, clock } = setup({ breakerThreshold: 1, maxRetries5xx: 0 });
    let calls = 0;
    const gate = deferred();
    const inFlight = governor.schedule(scope, async () => {
      calls++;
      await gate.promise;
      throw upstream.server(503);
    });
    await tick();
    // Zoho blocks the org for 60 s while the first call is still in flight.
    await rejection(
      governor.schedule(scope, async () => {
        calls++;
        throw upstream.minute();
      }),
    );
    gate.resolve();
    // Its terminal 5xx reaches the breaker threshold (30 s) inside the 60 s block.
    const late = await rejection(inFlight);
    expect(late.code).toBe('UPSTREAM_ERROR');
    expect(late.retryAfterS).toBe(60);

    clock.advance(31_000);
    const blocked = await rejection(
      governor.schedule(scope, async () => {
        calls++;
        return 'sent while Zoho still blocks the org';
      }),
    );
    expect(blocked.code).toBe('RATE_LIMITED');
    expect(blocked.retryAfterS).toBe(29);
    expect(calls).toBe(2);
  });

  it('a success that completes after a concurrent failure breaks the failure streak', async () => {
    const { governor, scope } = setup({ breakerThreshold: 2, maxRetries5xx: 0 });
    const gate = deferred();
    const slowOk = governor.schedule(scope, async () => {
      await gate.promise;
      return 'ok';
    });
    await tick();
    await rejection(
      governor.schedule(scope, async () => {
        throw upstream.server(500);
      }),
    );
    gate.resolve();
    await expect(slowOk).resolves.toBe('ok'); // completes after the failure: streak broken
    await rejection(
      governor.schedule(scope, async () => {
        throw upstream.server(500);
      }),
    );
    // Failure, success, failure: never two consecutive failures.
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
  });

  it('a call that queued while the breaker went half-open must win the probe slot first', async () => {
    /** ManualClock that runs a hook while a caller sleeps (what other workers do meanwhile). */
    class HookClock extends ManualClock {
      onSleep: (() => Promise<void>) | null = null;
      override async sleep(ms: number): Promise<void> {
        await super.sleep(ms);
        const hook = this.onSleep;
        this.onSleep = null;
        if (hook) await hook();
      }
    }
    const clock = new HookClock();
    const kv = new MemoryKv(clock);
    const governor = createGovernor({ kv, clock, random: () => 0.5 });
    const profile = { ...zohoRateProfile('free'), perMinute: 1, queueTimeoutMs: 120_000 };
    const scope: GovernorScope = { key: 'demo:probe', profile };
    const keys = governorKeys(scope.key);
    await governor.schedule(scope, async () => 'fills the minute bucket');

    // While the next call waits for the minute bucket, the breaker trips, its open period passes
    // and another worker takes the single half-open probe.
    clock.onSleep = async () => {
      for (let i = 0; i < profile.breakerThreshold; i++) await kv.incr(keys.fails);
      await kv.set(keys.probe, 'other-worker', { ttlMs: 60_000 });
    };
    let called = false;
    const err = await rejection(
      governor.schedule(scope, async () => {
        called = true;
        return 'a second probe';
      }),
    );
    expect(called).toBe(false);
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.message).toMatch(/a test request is in progress/);
  });

  it('a success resets the consecutive-failure count', async () => {
    const { governor, scope } = setup({ breakerThreshold: 2, maxRetries5xx: 0 });
    await rejection(
      governor.schedule(scope, async () => {
        throw upstream.timeout();
      }),
    );
    await governor.schedule(scope, async () => 'ok');
    await rejection(
      governor.schedule(scope, async () => {
        throw upstream.timeout();
      }),
    );
    expect((await governor.snapshot(scope)).circuit).toBe('closed');
  });
});

describe('key isolation', () => {
  it('key isolation: demo:a, demo:b and a live key have independent limits, budgets and circuits', async () => {
    const clock = new ManualClock();
    const kv = new MemoryKv(clock);
    const governor = createGovernor({ kv, clock, random: () => 0.5 });
    const demoProfile = { ...zohoRateProfile('free'), dailyLimit: 4, dailyShare: 0.5 };
    const a: GovernorScope = { key: 'demo:a', profile: demoProfile };
    const b: GovernorScope = { key: 'demo:b', profile: demoProfile };
    const live: GovernorScope = { key: 'zoho:tenant-1:org-1', profile: zohoRateProfile('premium') };

    // Code 44 on demo:a opens only demo:a's circuit.
    await rejection(
      governor.schedule(a, async () => {
        throw upstream.minute();
      }),
    );
    expect((await rejection(governor.schedule(a, async () => 'x'))).code).toBe('RATE_LIMITED');
    await expect(governor.schedule(b, async () => 'b ok')).resolves.toBe('b ok');
    await expect(governor.schedule(live, async () => 'live ok')).resolves.toBe('live ok');

    // demo:b exhausts its own daily budget (2) without touching the others.
    await governor.schedule(b, async () => 'b again');
    expect((await rejection(governor.schedule(b, async () => 'x'))).code).toBe(
      'DAILY_QUOTA_EXHAUSTED',
    );
    await expect(governor.schedule(live, async () => 'still ok')).resolves.toBe('still ok');

    const [sa, sb, sl] = await Promise.all([
      governor.snapshot(a),
      governor.snapshot(b),
      governor.snapshot(live),
    ]);
    expect(sa).toMatchObject({ circuit: 'open', budget_remaining_today: 1, used_this_minute: 1 });
    expect(sb).toMatchObject({ circuit: 'closed', budget_remaining_today: 0, used_this_minute: 2 });
    expect(sl).toMatchObject({
      circuit: 'closed',
      daily_budget: 5000,
      budget_remaining_today: 4998,
      used_this_minute: 2,
    });

    clock.advance(60_000);
    await expect(governor.schedule(a, async () => 'a recovered')).resolves.toBe('a recovered');
  });

  it('two governors sharing one Kv share the same per-key state (multi-process view)', async () => {
    const clock = new ManualClock();
    const kv = new MemoryKv(clock);
    const g1 = createGovernor({ kv, clock });
    const g2 = createGovernor({ kv, clock });
    const scope: GovernorScope = { key: 'demo:shared', profile: zohoRateProfile('free') };
    await rejection(
      g1.schedule(scope, async () => {
        throw upstream.minute();
      }),
    );
    expect((await rejection(g2.schedule(scope, async () => 'x'))).code).toBe('RATE_LIMITED');
  });
});

describe('decisions', () => {
  it('decisions are emitted in order across queueing, retries and admission', async () => {
    const { governor, scope, decisions, note } = setup({ perMinute: 1, queueTimeoutMs: 120_000 });
    await governor.schedule(scope, async () => 'first');

    const value = await governor.schedule(
      scope,
      async (attempt) => {
        if (attempt === 1) throw upstream.concurrency();
        return 'second';
      },
      note,
    );
    expect(value).toBe('second');
    expect(decisions).toEqual([
      { type: 'queued', reason: 'minute_bucket', wait_ms: 60_000 },
      { type: 'admitted', waited_ms: 60_000 },
      { type: 'retried', attempt: 2, reason: 'upstream_concurrency', backoff_ms: 250 },
      { type: 'queued', reason: 'minute_bucket', wait_ms: 59_750 },
      { type: 'admitted', waited_ms: 59_750 },
    ]);
  });

  it('a throwing onDecision callback does not break scheduling', async () => {
    const { governor, scope } = setup();
    const value = await governor.schedule(
      scope,
      async () => 'ok',
      () => {
        throw new Error('listener bug');
      },
    );
    expect(value).toBe('ok');
  });

  it('snapshot reports usage, in-flight requests and the remaining daily budget', async () => {
    const { governor, scope } = setup();
    const hold = deferred();
    const running = governor.schedule(scope, () => hold.promise);
    await tick();
    expect(await governor.snapshot(scope)).toEqual({
      budget_remaining_today: 499,
      daily_budget: 500,
      used_this_minute: 1,
      in_flight: 1,
      circuit: 'closed',
    });
    hold.resolve();
    await running;
    expect((await governor.snapshot(scope)).in_flight).toBe(0);
  });
});
