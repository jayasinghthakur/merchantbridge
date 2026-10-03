/** Why a circuit is open: Zoho blocked the org for a minute (code 44), or our consecutive-failure breaker. */
export type OpenReason = 'minute_block' | 'breaker';

export interface OpenRecord {
  /** Epoch ms when the circuit stops rejecting. */
  until: number;
  reason: OpenReason;
}

export function encodeOpen(record: OpenRecord): string {
  return JSON.stringify(record);
}

/** Returns null for a missing or corrupt record (a corrupt record must not wedge the circuit open). */
export function decodeOpen(raw: string | null): OpenRecord | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { until, reason } = v as { until?: unknown; reason?: unknown };
    if (typeof until !== 'number' || (reason !== 'minute_block' && reason !== 'breaker'))
      return null;
    return { until, reason };
  } catch {
    return null;
  }
}
