export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 8_000;

/** Upper bound of the jitter range for the n-th retry (0-based): min(cap, base * 2^n). */
export function backoffCeiling(
  retryIndex: number,
  baseMs = BACKOFF_BASE_MS,
  capMs = BACKOFF_CAP_MS,
): number {
  return Math.min(capMs, baseMs * 2 ** retryIndex);
}

/** "Full jitter" exponential backoff: uniform in [0, min(cap, base * 2^n)). */
export function fullJitterBackoff(
  retryIndex: number,
  random: () => number,
  baseMs = BACKOFF_BASE_MS,
  capMs = BACKOFF_CAP_MS,
): number {
  return Math.floor(random() * backoffCeiling(retryIndex, baseMs, capMs));
}
