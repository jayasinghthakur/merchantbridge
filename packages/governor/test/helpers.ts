import type { GovernorDecision, GovernorScope, RateProfile } from '@mb/core';
import { ConnectorError, ManualClock, MemoryKv, UpstreamError, zohoRateProfile } from '@mb/core';
import { createGovernor } from '../src/index';

export function setup(overrides: Partial<RateProfile> = {}, key = 'demo:test') {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock);
  const governor = createGovernor({ kv, clock, random: () => 0.5 });
  const profile: RateProfile = { ...zohoRateProfile('free'), ...overrides };
  const scope: GovernorScope = { key, profile };
  const decisions: GovernorDecision[] = [];
  const note = (d: GovernorDecision): void => {
    decisions.push(d);
  };
  return { clock, kv, governor, profile, scope, decisions, note };
}

/** Awaits a promise that must reject with a ConnectorError and returns that error. */
export async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectorError) return e;
    throw e;
  }
  throw new Error('expected the promise to reject');
}

export const upstream = {
  minute: () => new UpstreamError({ kind: 'rate_limit_minute' }, 'HTTP 429 code 44'),
  daily: () => new UpstreamError({ kind: 'rate_limit_daily' }, 'HTTP 429 code 45'),
  concurrency: (retryAfterS?: number) =>
    new UpstreamError({ kind: 'concurrency' }, 'HTTP 429 code 1070', retryAfterS),
  server: (status = 503) =>
    new UpstreamError({ kind: 'server', status }, `HTTP ${status} <html>secret-body</html>`),
  timeout: () => new UpstreamError({ kind: 'timeout' }, 'timeout'),
  network: () => new UpstreamError({ kind: 'network' }, 'ECONNRESET 10.0.0.1'),
};

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yields to the event loop so pending microtasks and I/O callbacks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic PRNG for agent think-times. */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largest number of admissions inside any half-open 60 s window. */
export function maxInAnyWindow(times: number[], windowMs = 60_000): number {
  const sorted = [...times].sort((a, b) => a - b);
  let max = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while ((sorted[hi] ?? 0) - (sorted[lo] ?? 0) >= windowMs) lo++;
    max = Math.max(max, hi - lo + 1);
  }
  return max;
}

export const kinds = (ds: GovernorDecision[]) => ds.map((d) => d.type);

/**
 * Records the admission times the governor writes into its per-minute window (the zset scores). Tests use
 * these rather than clock.now() inside a task: with ManualClock, another agent's sleep() can advance time
 * between admission and the task starting, which real time never does by more than microseconds.
 */
export function recordAdmissions(kv: MemoryKv): number[] {
  const times: number[] = [];
  const zadd = kv.zadd.bind(kv);
  kv.zadd = (key: string, score: number, member: string) => {
    if (key.endsWith(':minute')) times.push(score);
    return zadd(key, score, member);
  };
  return times;
}
