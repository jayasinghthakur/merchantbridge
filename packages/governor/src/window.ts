import { WINDOW_MS } from './keys';

/** Drops admissions that have left the sliding window (age ≥ WINDOW_MS). `admissions` is ascending. */
export function pruneWindow(admissions: number[], now: number): void {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < admissions.length && (admissions[drop] ?? Infinity) <= cutoff) drop++;
  if (drop > 0) admissions.splice(0, drop);
}

export interface MinuteWait {
  waitMs: number;
  /** True when this process knows every admission in the window, so `waitMs` is exact. */
  exact: boolean;
}

/**
 * How long until the window has room again. The Kv surface has no ZRANGE, so admission times are mirrored
 * locally: exact for one process; with other processes it is a worst-case bound (their entries are unknown).
 *
 * @param admissions this process's admissions still in the window, ascending
 * @param used       entries in the shared window (all processes)
 */
export function minuteWait(
  admissions: readonly number[],
  used: number,
  perMinute: number,
  now: number,
): MinuteWait {
  const known = admissions.length;
  if (known >= used) {
    const t = admissions[known - perMinute];
    return { waitMs: t === undefined ? WINDOW_MS : t + WINDOW_MS - now, exact: true };
  }
  // `need` entries must leave; the need-th oldest known entry leaving guarantees it in the worst case.
  const need = used - perMinute + 1;
  const t = need <= known ? admissions[need - 1] : undefined;
  return { waitMs: t === undefined ? WINDOW_MS : t + WINDOW_MS - now, exact: false };
}
