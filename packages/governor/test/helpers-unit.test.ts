import { zohoRateProfile } from '@mb/core';
import { describe, expect, it } from 'vitest';
import {
  backoffCeiling,
  dailyBudget,
  fullJitterBackoff,
  governorKeys,
  utcDay,
  utcMidnightAfter,
} from '../src/index';
import { minuteWait, pruneWindow } from '../src/window';

describe('time helpers', () => {
  it('utcMidnightAfter returns the next UTC midnight, strictly after the input', () => {
    expect(utcMidnightAfter(Date.UTC(2026, 9, 3, 9, 0, 0))).toBe(Date.UTC(2026, 9, 4));
    expect(utcMidnightAfter(Date.UTC(2026, 9, 3))).toBe(Date.UTC(2026, 9, 4));
    expect(utcMidnightAfter(Date.UTC(2026, 9, 3, 23, 59, 59, 999))).toBe(Date.UTC(2026, 9, 4));
    expect(utcMidnightAfter(Date.UTC(2026, 11, 31, 12))).toBe(Date.UTC(2027, 0, 1));
  });

  it('utcDay formats the UTC date', () => {
    expect(utcDay(Date.UTC(2026, 9, 3, 23, 59))).toBe('2026-10-03');
  });
});

describe('backoff', () => {
  it('full jitter stays within min(cap, 500 * 2^n)', () => {
    expect(backoffCeiling(0)).toBe(500);
    expect(backoffCeiling(3)).toBe(4000);
    expect(backoffCeiling(10)).toBe(8000);
    expect(fullJitterBackoff(2, () => 0.5)).toBe(1000);
    expect(fullJitterBackoff(2, () => 0)).toBe(0);
    expect(fullJitterBackoff(2, () => 0.999999)).toBeLessThan(2000);
  });
});

describe('budget and keys', () => {
  it('daily budget is floor(limit * share), robust to float error', () => {
    expect(dailyBudget(zohoRateProfile('free'))).toBe(500);
    expect(dailyBudget({ ...zohoRateProfile('free'), dailyLimit: 100, dailyShare: 0.29 })).toBe(29);
    expect(dailyBudget({ ...zohoRateProfile('premium'), dailyShare: 0.33 })).toBe(3300);
  });

  it('keys are namespaced under gov:<scope.key>', () => {
    const keys = governorKeys('zoho:t1:org9');
    expect(keys.minute).toBe('gov:zoho:t1:org9:minute');
    expect(keys.leases).toBe('gov:zoho:t1:org9:leases');
    expect(keys.day(Date.UTC(2026, 9, 3, 12))).toBe('gov:zoho:t1:org9:day:2026-10-03');
  });
});

describe('sliding window math', () => {
  it('pruneWindow drops entries aged ≥ 60 s', () => {
    const xs = [0, 10, 59_999, 60_000];
    pruneWindow(xs, 60_000);
    expect(xs).toEqual([10, 59_999, 60_000]);
  });

  it('minuteWait is exact when this process knows every entry', () => {
    expect(minuteWait([1_000, 2_000, 3_000], 3, 2, 10_000)).toEqual({
      waitMs: 52_000,
      exact: true,
    });
  });

  it('minuteWait is a worst-case bound when other processes hold entries', () => {
    expect(minuteWait([5_000], 3, 3, 10_000)).toEqual({ waitMs: 55_000, exact: false });
    expect(minuteWait([], 3, 3, 10_000)).toEqual({ waitMs: 60_000, exact: false });
  });
});
