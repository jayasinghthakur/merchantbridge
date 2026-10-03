import type { RateProfile } from '@mb/core';

/** Sliding window length for the per-minute ceiling. */
export const WINDOW_MS = 60_000;
/** Daily counters outlive their UTC day a little so a late read never sees a fresh (empty) key. */
export const DAY_KEY_TTL_MS = 26 * 60 * 60 * 1000;
/** Consecutive-failure counters are dropped after a quiet day. */
export const FAILS_TTL_MS = 24 * 60 * 60 * 1000;

/** All Kv keys for one scope. `scopeKey` already carries the upstream org (`zoho:{dc}:{org}`) or `demo:{session}`. */
export interface GovernorKeys {
  /** zset: member = attempt id, score = admission time (sliding per-minute log). */
  minute: string;
  /** zset: member = lease id, score = lease expiry. */
  leases: string;
  /** string flag set when the upstream reports its daily quota exhausted (code 45); expires at UTC midnight. */
  exhausted: string;
  /** string JSON {until, reason}: circuit open record. */
  open: string;
  /** counter: consecutive server/timeout/network failures (after retries). */
  fails: string;
  /** string (NX): the single half-open probe holder. */
  probe: string;
  /** counter: admitted upstream attempts in the UTC day containing `ms`. */
  day(ms: number): string;
}

export function governorKeys(scopeKey: string): GovernorKeys {
  const p = `gov:${scopeKey}`;
  return {
    minute: `${p}:minute`,
    leases: `${p}:leases`,
    exhausted: `${p}:exhausted`,
    open: `${p}:circuit`,
    fails: `${p}:fails`,
    probe: `${p}:probe`,
    day: (ms) => `${p}:day:${utcDay(ms)}`,
  };
}

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first UTC midnight strictly after `ms` (the assumed daily-quota reset; see the governor ADR). */
export function utcMidnightAfter(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Whole seconds (≥ 1) an agent should wait; rounding up so it never retries early. */
export function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export function secondsUntil(now: number, until: number): number {
  return secondsFromMs(until - now);
}

/** This connector's share of the org's daily upstream limit. */
export function dailyBudget(profile: RateProfile): number {
  // Epsilon guards float products such as 100 * 0.29 = 28.999999999999996.
  return Math.max(0, Math.floor(profile.dailyLimit * profile.dailyShare + 1e-9));
}

/** Parses a Kv counter; missing or corrupt values count as 0. */
export function toCount(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
