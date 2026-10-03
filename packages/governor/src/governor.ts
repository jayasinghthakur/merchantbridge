import { randomUUID } from 'node:crypto';
import type {
  Clock,
  ConnectorError,
  Governor,
  GovernorDecision,
  GovernorScope,
  GovernorSnapshot,
  Kv,
  Logger,
  RateProfile,
  UpstreamError,
} from '@mb/core';
import { isUpstreamError, noopLogger } from '@mb/core';
import type { Timers } from './attempt';
import { runWithTimeout } from './attempt';
import { BACKOFF_CAP_MS, backoffCeiling, fullJitterBackoff } from './backoff';
import type { OpenReason } from './circuit';
import { decodeOpen, encodeOpen } from './circuit';
import type { GovernorKeys } from './keys';
import {
  DAY_KEY_TTL_MS,
  FAILS_TTL_MS,
  WINDOW_MS,
  dailyBudget,
  governorKeys,
  secondsFromMs,
  secondsUntil,
  toCount,
  utcMidnightAfter,
} from './keys';
import { FifoLock } from './lock';
import { createMessages } from './messages';
import { minuteWait, pruneWindow } from './window';

/*
 * Concurrency model. Kv offers no Lua/transactions, so "count, then add" is not atomic across processes.
 * Within one process every admission for a key runs under a FIFO lock, which makes the per-minute ceiling,
 * concurrency leases and daily budget exact. Across processes (several API machines sharing Redis) two
 * admissions can interleave and briefly overshoot by the number of racing processes; the 80/min ceiling sits
 * below Zoho's 100/min to absorb that. The same applies to the read-then-write circuit record and the
 * consecutive-failure streak (a success only sees failures recorded by this process since its attempt began).
 */

export interface GovernorDeps {
  kv: Kv;
  clock: Clock;
  log?: Logger;
  /** Jitter source in [0, 1); inject a constant in tests. */
  random?: () => number;
  /** Real timer for per-attempt timeouts and slot waits (never the Clock; see attempt.ts). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Upstream name used in agent-facing messages. */
  upstreamName?: string;
}

/** Poll step when the window is full of other processes' admissions (their times are unknown). */
const MINUTE_POLL_MS = 1_000;
/** Poll step when every lease is held by another process or a crashed worker. */
const LEASE_POLL_MS = 250;
const CONCURRENCY_RETRY_AFTER_S = 2;
const PROBE_BUSY_RETRY_S = 2;
const PROBE_SLACK_MS = 5_000;
/** Longer upstream Retry-After values are passed to the agent instead of being slept on. */
const MAX_HONORED_RETRY_AFTER_S = 10;

/**
 * Lifetime of the half-open probe key, renewed on every probe attempt: one queue wait + one attempt + the
 * longest backoff before the next attempt. A crashed probe therefore frees the slot within this time.
 */
function probeTtlMs(profile: RateProfile): number {
  const longestBackoffMs = Math.max(BACKOFF_CAP_MS, MAX_HONORED_RETRY_AFTER_S * 1000);
  return profile.queueTimeoutMs + profile.requestTimeoutMs + longestBackoffMs + PROBE_SLACK_MS;
}

type QueueReason = 'minute_bucket' | 'concurrency';

interface KeyState {
  readonly lock: FifoLock;
  /** Calls currently inside schedule() for this key; the idle sweep only drops states with none. */
  users: number;
  /** Leases held by this process. */
  inFlight: number;
  /** Count of local lease releases; detects a release that happened while the lock holder was counting. */
  releases: number;
  /** Count of local terminal failures; a success that saw it change must reset the failure streak. */
  failureSeq: number;
  /** This process's admission times still inside the window, ascending. */
  readonly admissions: number[];
  /** Set by the lock holder while it waits for one of this process's leases to be released. */
  releaseWaiter: (() => void) | null;
  /** What the lock holder is waiting for, so callers queued behind it can report a 'queued' decision. */
  waiting: { reason: QueueReason; untilMs: number } | null;
}

interface Call {
  readonly scope: GovernorScope;
  readonly keys: GovernorKeys;
  readonly st: KeyState;
  readonly id: string;
  readonly emit: (d: GovernorDecision) => void;
  /** True while this call holds the half-open probe slot. */
  probe: boolean;
}

interface Lease {
  id: string;
  waitedMs: number;
}

interface RetryBudget {
  queuedMs: number;
  retries429: number;
  retries5xx: number;
}

interface RetryPlan {
  backoffMs: number;
  reason: string;
}

/** Breaker state as seen when an attempt started; lets a success skip the reset write when nothing failed. */
interface BreakerView {
  failures: number;
  failureSeq: number;
}

/** Retry-After comes from an upstream header: ignore anything that is not a finite, non-negative number. */
function usableRetryAfter(s: number | undefined): number | undefined {
  return s !== undefined && Number.isFinite(s) && s >= 0 ? s : undefined;
}

export function createGovernor(deps: GovernorDeps): Governor {
  const { kv, clock } = deps;
  const log = deps.log ?? noopLogger;
  const random = deps.random ?? Math.random;
  const msg = createMessages(deps.upstreamName ?? 'Zoho');
  // Resolved per call so test fake timers installed after construction still apply.
  const timers: Timers = {
    set: (fn, ms) => (deps.setTimeoutFn ?? setTimeout)(fn, ms),
    clear: (handle) => (deps.clearTimeoutFn ?? clearTimeout)(handle),
  };

  const states = new Map<string, KeyState>();
  let lastSweep = clock.now();

  function enter(key: string): KeyState {
    const now = clock.now();
    if (now - lastSweep >= WINDOW_MS) {
      lastSweep = now;
      for (const [k, s] of states) {
        pruneWindow(s.admissions, now);
        if (s.users === 0 && s.admissions.length === 0) states.delete(k);
      }
    }
    let st = states.get(key);
    if (!st) {
      st = {
        lock: new FifoLock(),
        users: 0,
        inFlight: 0,
        releases: 0,
        failureSeq: 0,
        admissions: [],
        releaseWaiter: null,
        waiting: null,
      };
      states.set(key, st);
    }
    st.users++;
    return st;
  }

  function emitterFor(scopeKey: string, onDecision?: (d: GovernorDecision) => void) {
    return (d: GovernorDecision): void => {
      if (!onDecision) return;
      try {
        onDecision(d);
      } catch (err) {
        log.warn({ err, scope: scopeKey }, 'governor: onDecision callback threw');
      }
    };
  }

  /** Emits the 'rejected' decision for governor rejections and returns the error for `throw`. */
  function rejectWith(call: Call, err: ConnectorError): ConnectorError {
    if (err.code === 'RATE_LIMITED' || err.code === 'DAILY_QUOTA_EXHAUSTED') {
      call.emit({
        type: 'rejected',
        code: err.code,
        ...(err.retryAfterS === undefined ? {} : { retry_after_s: err.retryAfterS }),
      });
    }
    return err;
  }

  /**
   * Instant checks before any wait: daily budget, open circuit, half-open probe. Returns the breaker view
   * so a success can reset the failure streak without an extra read.
   */
  async function gate(call: Call): Promise<BreakerView> {
    const { keys } = call;
    const profile = call.scope.profile;
    const now = clock.now();
    // Taken before the reads so a failure recorded while they are in flight is noticed.
    const failureSeq = call.st.failureSeq;
    const [exhausted, usedToday, openRaw, failsRaw] = await Promise.all([
      kv.get(keys.exhausted),
      kv.get(keys.day(now)),
      kv.get(keys.open),
      kv.get(keys.fails),
    ]);

    const budget = dailyBudget(profile);
    if (exhausted !== null || toCount(usedToday) >= budget) {
      const retryAfterS = secondsUntil(now, utcMidnightAfter(now));
      throw rejectWith(call, msg.dailyExhausted(budget, retryAfterS, exhausted !== null));
    }

    const open = decodeOpen(openRaw);
    if (open !== null && open.until > now) {
      const retryAfterS = secondsUntil(now, open.until);
      if (open.reason === 'minute_block') throw rejectWith(call, msg.minuteBlocked(retryAfterS));
      // 'rejected' cannot carry UPSTREAM_ERROR in the core contract, so the trace shows the open circuit.
      call.emit({ type: 'circuit_open', until_ms: open.until, reason: 'breaker_open' });
      throw msg.breakerOpen(retryAfterS);
    }

    const failures = toCount(failsRaw);
    if (call.probe) {
      // Renew per attempt so a probe that backs off between attempts never loses the slot to a second probe.
      await kv.set(keys.probe, call.id, { ttlMs: probeTtlMs(profile) });
    } else if (failures >= profile.breakerThreshold) {
      const ttlMs = probeTtlMs(profile);
      const acquired = await kv.set(keys.probe, call.id, { nx: true, ttlMs });
      if (!acquired) {
        call.emit({
          type: 'circuit_open',
          until_ms: now + PROBE_BUSY_RETRY_S * 1000,
          reason: 'half_open_probe_in_flight',
        });
        throw msg.probeInFlight(PROBE_BUSY_RETRY_S);
      }
      call.probe = true;
    }
    return { failures, failureSeq };
  }

  function waitForRelease(st: KeyState, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const handle = timers.set(() => {
        st.releaseWaiter = null;
        resolve(false);
      }, ms);
      st.releaseWaiter = () => {
        timers.clear(handle);
        st.releaseWaiter = null;
        resolve(true);
      };
    });
  }

  /**
   * Waits for room in the per-minute window and a concurrency lease, then counts the attempt against the
   * daily budget. Runs under the key's FIFO lock; the holder waits while holding it, so callers behind it
   * are served in arrival order. A caller waits for the lock at most as long as the holders ahead of it
   * may wait; a retry whose remaining queue budget is smaller than theirs can therefore overrun its own
   * budget by up to one queueTimeoutMs before it is admitted or rejected.
   */
  async function admit(call: Call, budgetMs: number): Promise<Lease> {
    const { st, keys } = call;
    const profile = call.scope.profile;
    const start = clock.now();
    const reported = new Set<QueueReason>();
    const queued = (reason: QueueReason, waitMs: number): void => {
      if (reported.has(reason)) return;
      reported.add(reason);
      call.emit({ type: 'queued', reason, wait_ms: Math.max(0, Math.round(waitMs)) });
    };

    if (st.waiting) queued(st.waiting.reason, st.waiting.untilMs - start);
    // Re-run the instant checks once we had to wait: the circuit may have opened meanwhile.
    let recheck = st.lock.size > 0;
    const unlock = await st.lock.acquire();
    try {
      for (;;) {
        if (recheck) {
          // Full gate, probe included: the breaker may have gone half-open while we waited.
          await gate(call);
          recheck = false;
        }
        const now = clock.now();
        const remaining = budgetMs - (now - start);

        // 1. Sliding per-minute window.
        await kv.zremrangebyscore(keys.minute, 0, now - WINDOW_MS);
        const used = await kv.zcard(keys.minute);
        pruneWindow(st.admissions, now);
        if (used >= profile.perMinute) {
          const { waitMs, exact } = minuteWait(st.admissions, used, profile.perMinute, now);
          if (exact ? waitMs > remaining : remaining <= 0) {
            throw rejectWith(
              call,
              msg.minuteQueueTimeout(profile.perMinute, secondsFromMs(waitMs)),
            );
          }
          queued('minute_bucket', waitMs);
          const step = exact ? waitMs : Math.min(waitMs, MINUTE_POLL_MS, remaining);
          st.waiting = { reason: 'minute_bucket', untilMs: now + waitMs };
          try {
            await clock.sleep(step);
          } finally {
            st.waiting = null;
          }
          recheck = true;
          continue;
        }

        // 2. Concurrency leases (expired leases of crashed workers are purged first).
        const releasesBefore = st.releases;
        await kv.zremrangebyscore(keys.leases, 0, now);
        const inFlight = await kv.zcard(keys.leases);
        if (inFlight >= profile.concurrency) {
          // A local release landed while we were counting: its wake-up was missed, so count again.
          if (st.releases !== releasesBefore) continue;
          if (remaining <= 0) {
            throw rejectWith(call, msg.concurrencyQueueTimeout(CONCURRENCY_RETRY_AFTER_S));
          }
          const estimate = Math.min(remaining, profile.requestTimeoutMs);
          queued('concurrency', estimate);
          st.waiting = { reason: 'concurrency', untilMs: now + estimate };
          try {
            if (st.inFlight > 0) {
              // One of our own leases will be released (its attempt has a real-time timeout).
              if (!(await waitForRelease(st, remaining))) {
                throw rejectWith(call, msg.concurrencyQueueTimeout(CONCURRENCY_RETRY_AFTER_S));
              }
            } else {
              // Held elsewhere (another process or a crashed worker): poll until it frees or expires.
              await clock.sleep(Math.min(LEASE_POLL_MS, remaining));
            }
          } finally {
            st.waiting = null;
          }
          recheck = true;
          continue;
        }

        // 3. Daily budget: every admitted attempt counts.
        const budget = dailyBudget(profile);
        const usedToday = await kv.incr(keys.day(now), DAY_KEY_TTL_MS);
        if (usedToday > budget) {
          const retryAfterS = secondsUntil(now, utcMidnightAfter(now));
          throw rejectWith(call, msg.dailyExhausted(budget, retryAfterS, false));
        }

        const id = randomUUID();
        // Stamp the admission after the Kv checks, not at the top of the loop: with a remote Kv those
        // round trips take real time, and a stale stamp would let the window free up before the send ages.
        const at = clock.now();
        await kv.zadd(keys.minute, at, id);
        st.admissions.push(at);
        await kv.zadd(keys.leases, at + profile.leaseMs, id);
        st.inFlight++;
        return { id, waitedMs: at - start };
      }
    } finally {
      unlock();
    }
  }

  async function releaseLease(call: Call, lease: Lease): Promise<void> {
    try {
      await kv.zrem(call.keys.leases, lease.id);
    } catch (err) {
      log.warn({ err, scope: call.scope.key }, 'governor: lease release failed; it will expire');
    }
    // Only after the zrem: until then the lease still counts in Kv, and a lock holder that sees a full
    // slot set must know a local release is coming (and wait for it) rather than poll.
    call.st.inFlight--;
    call.st.releases++;
    call.st.releaseWaiter?.();
  }

  async function releaseProbe(call: Call): Promise<void> {
    if (!call.probe) return;
    call.probe = false;
    try {
      // Only delete our own probe (it may have expired and been taken by another call).
      if ((await kv.get(call.keys.probe)) === call.id) await kv.del(call.keys.probe);
    } catch (err) {
      log.warn({ err, scope: call.scope.key }, 'governor: probe release failed; it will expire');
    }
  }

  /**
   * Opens the circuit for `openMs`, or keeps a record that is already open for longer: a breaker opening
   * (30 s) inside a code-44 block (60 s) must not let calls through while the upstream still blocks the org.
   * Returns when the circuit actually closes.
   */
  async function openCircuit(
    call: Call,
    reason: OpenReason,
    openMs: number,
    decisionReason: string,
  ): Promise<number> {
    const now = clock.now();
    const current = decodeOpen(await kv.get(call.keys.open));
    let until = now + openMs;
    if (current !== null && current.until >= until) {
      until = current.until;
    } else {
      await kv.set(call.keys.open, encodeOpen({ until, reason }), { ttlMs: openMs });
    }
    call.emit({ type: 'circuit_open', until_ms: until, reason: decisionReason });
    log.warn(
      { scope: call.scope.key, reason: decisionReason, open_ms: until - now },
      'governor: circuit opened',
    );
    return until;
  }

  async function recordSuccess(call: Call, seen: BreakerView): Promise<void> {
    // Nothing to reset unless a failure was counted before, or recorded locally during, this attempt.
    if (seen.failures === 0 && !call.probe && call.st.failureSeq === seen.failureSeq) return;
    try {
      await kv.del(call.keys.fails);
      if (call.probe) {
        await releaseProbe(call);
        log.info({ scope: call.scope.key }, 'governor: circuit closed after a successful probe');
      }
    } catch (err) {
      log.warn({ err, scope: call.scope.key }, 'governor: could not reset breaker state');
    }
  }

  /**
   * Counts a terminal server/timeout/network failure. Returns when the circuit closes again if this failure
   * opened the breaker, otherwise null.
   */
  async function recordFailure(call: Call): Promise<number | null> {
    const profile = call.scope.profile;
    call.st.failureSeq++;
    const failures = await kv.incr(call.keys.fails, FAILS_TTL_MS);
    // Exactly at the threshold: later concurrent failures must not keep extending the open period.
    if (failures !== profile.breakerThreshold) return null;
    return openCircuit(call, 'breaker', profile.breakerOpenMs, 'breaker');
  }

  function plan429(
    call: Call,
    err: UpstreamError,
    budget: RetryBudget,
    kind: 'concurrency' | 'other',
  ): RetryPlan {
    const profile = call.scope.profile;
    const hinted = usableRetryAfter(err.retryAfterS);
    if (hinted !== undefined && hinted > MAX_HONORED_RETRY_AFTER_S) {
      throw rejectWith(call, msg.upstreamRateLimited(kind, Math.ceil(hinted)));
    }
    if (budget.retries429 >= profile.maxRetries429) {
      const retryAfterS =
        hinted !== undefined
          ? Math.max(1, Math.ceil(hinted))
          : secondsFromMs(backoffCeiling(budget.retries429));
      throw rejectWith(call, msg.upstreamRateLimited(kind, retryAfterS));
    }
    const backoffMs =
      hinted !== undefined
        ? Math.round(hinted * 1000)
        : fullJitterBackoff(budget.retries429, random);
    budget.retries429++;
    return {
      backoffMs,
      reason: kind === 'concurrency' ? 'upstream_concurrency' : 'upstream_429',
    };
  }

  async function planServerFailure(
    call: Call,
    err: UpstreamError,
    attempt: number,
    budget: RetryBudget,
    reason: string,
  ): Promise<RetryPlan> {
    const profile = call.scope.profile;
    if (call.probe) {
      // Half-open: the single probe failed, so re-open without retrying.
      const until = await openCircuit(
        call,
        'breaker',
        profile.breakerOpenMs,
        'breaker_probe_failed',
      );
      throw msg.upstreamFailed(err.failure, attempt, secondsUntil(clock.now(), until));
    }
    if (budget.retries5xx >= profile.maxRetries5xx) {
      const until = await recordFailure(call);
      throw msg.upstreamFailed(
        err.failure,
        attempt,
        until === null ? undefined : secondsUntil(clock.now(), until),
      );
    }
    const backoffMs = fullJitterBackoff(budget.retries5xx, random);
    budget.retries5xx++;
    return { backoffMs, reason };
  }

  /** Decides what an upstream failure means: returns a retry plan or throws the agent-facing error. */
  async function planRetry(
    call: Call,
    err: UpstreamError,
    attempt: number,
    budget: RetryBudget,
  ): Promise<RetryPlan> {
    const profile = call.scope.profile;
    const failure = err.failure;
    switch (failure.kind) {
      case 'rate_limit_minute': {
        const until = await openCircuit(
          call,
          'minute_block',
          profile.minuteBlockOpenMs,
          'upstream_minute_block',
        );
        throw rejectWith(call, msg.minuteBlocked(secondsUntil(clock.now(), until)));
      }
      case 'rate_limit_daily': {
        const now = clock.now();
        const midnight = utcMidnightAfter(now);
        await kv.set(call.keys.exhausted, '1', { ttlMs: midnight - now });
        log.warn({ scope: call.scope.key }, 'governor: upstream daily quota exhausted');
        throw rejectWith(
          call,
          msg.dailyExhausted(dailyBudget(profile), secondsUntil(now, midnight), true),
        );
      }
      case 'concurrency':
        return plan429(call, err, budget, 'concurrency');
      case 'server':
        if (failure.status === 429) return plan429(call, err, budget, 'other');
        return planServerFailure(call, err, attempt, budget, `upstream_${failure.status}`);
      case 'timeout':
        return planServerFailure(call, err, attempt, budget, 'upstream_timeout');
      case 'network':
        return planServerFailure(call, err, attempt, budget, 'upstream_network');
    }
  }

  async function run<T>(
    call: Call,
    task: (attempt: number, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const profile = call.scope.profile;
    const budget: RetryBudget = { queuedMs: 0, retries429: 0, retries5xx: 0 };
    for (let attempt = 1; ; attempt++) {
      const seen = await gate(call);
      const lease = await admit(call, profile.queueTimeoutMs - budget.queuedMs);
      budget.queuedMs += lease.waitedMs;
      call.emit({ type: 'admitted', waited_ms: lease.waitedMs });

      let failure: UpstreamError;
      try {
        const value = await runWithTimeout(task, attempt, profile.requestTimeoutMs, timers);
        await recordSuccess(call, seen);
        return value;
      } catch (err) {
        // ConnectorError (NOT_FOUND, RECONNECT_REQUIRED…) and unknown errors: no retry, no breaker count.
        if (!isUpstreamError(err)) throw err;
        failure = err;
      } finally {
        await releaseLease(call, lease);
      }

      // Leases are released before backing off so a sleeping retry never holds a slot.
      const plan = await planRetry(call, failure, attempt, budget);
      call.emit({
        type: 'retried',
        attempt: attempt + 1,
        reason: plan.reason,
        backoff_ms: plan.backoffMs,
      });
      await clock.sleep(plan.backoffMs);
    }
  }

  return {
    async schedule<T>(
      scope: GovernorScope,
      task: (attempt: number, signal: AbortSignal) => Promise<T>,
      onDecision?: (d: GovernorDecision) => void,
    ): Promise<T> {
      const st = enter(scope.key);
      const call: Call = {
        scope,
        keys: governorKeys(scope.key),
        st,
        id: randomUUID(),
        emit: emitterFor(scope.key, onDecision),
        probe: false,
      };
      try {
        return await run(call, task);
      } finally {
        st.users--;
        await releaseProbe(call);
      }
    },

    async snapshot(scope: GovernorScope): Promise<GovernorSnapshot> {
      const keys = governorKeys(scope.key);
      const profile = scope.profile;
      const now = clock.now();
      await Promise.all([
        kv.zremrangebyscore(keys.minute, 0, now - WINDOW_MS),
        kv.zremrangebyscore(keys.leases, 0, now),
      ]);
      const [used, inFlight, usedToday, exhausted, openRaw, failsRaw] = await Promise.all([
        kv.zcard(keys.minute),
        kv.zcard(keys.leases),
        kv.get(keys.day(now)),
        kv.get(keys.exhausted),
        kv.get(keys.open),
        kv.get(keys.fails),
      ]);
      const budget = dailyBudget(profile);
      const open = decodeOpen(openRaw);
      const isOpen = open !== null && open.until > now;
      const circuit: GovernorSnapshot['circuit'] = isOpen
        ? 'open'
        : toCount(failsRaw) >= profile.breakerThreshold
          ? 'half_open'
          : 'closed';
      return {
        budget_remaining_today: exhausted !== null ? 0 : Math.max(0, budget - toCount(usedToday)),
        daily_budget: budget,
        used_this_minute: used,
        in_flight: inFlight,
        circuit,
        ...(isOpen ? { circuit_open_until: new Date(open.until).toISOString() } : {}),
      };
    },
  };
}
