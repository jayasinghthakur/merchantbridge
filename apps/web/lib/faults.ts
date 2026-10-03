import type { DemoFault } from '@mb/core/telemetry';

export interface FaultInfo {
  id: DemoFault;
  label: string;
  description: string;
  /** Shown up front; the rest sit under "More faults". */
  primary: boolean;
}

export const FAULTS: readonly FaultInfo[] = [
  {
    id: 'rate_limit_44',
    label: 'Zoho 429 (code 44)',
    description:
      'Org-wide per-minute block: the governor opens a 60\u00a0s circuit and returns RATE_LIMITED.',
    primary: true,
  },
  {
    id: 'expired_token',
    label: 'Expired token',
    description: 'Upstream 401: one single-flight token refresh, then one retry.',
    primary: true,
  },
  {
    id: 'daily_quota_45',
    label: 'Daily quota (code 45)',
    description: 'Daily limit hit: DAILY_QUOTA_EXHAUSTED, never retried.',
    primary: false,
  },
  {
    id: 'concurrency_1070',
    label: 'Concurrency (code 1070)',
    description: 'Too many parallel calls: requeued with jittered backoff.',
    primary: false,
  },
  {
    id: 'server_5xx',
    label: 'Zoho 5xx',
    description: 'Server error: up to two retries, then UPSTREAM_ERROR.',
    primary: false,
  },
  {
    id: 'malformed',
    label: 'Malformed response',
    description: 'Unparseable upstream body: reported as UPSTREAM_ERROR, never passed through.',
    primary: false,
  },
];

export function toggleFault(faults: readonly DemoFault[], id: DemoFault): DemoFault[] {
  return faults.includes(id) ? faults.filter((f) => f !== id) : [...faults, id];
}
