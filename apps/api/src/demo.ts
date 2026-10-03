import { createHash } from 'node:crypto';
import type { Clock, DemoFault } from '@mb/core';
import { DEMO_FAULTS } from '@mb/core';
import type { DemoDataset, FakeZoho } from '@mb/zoho-inventory';
import { createDemoDataset, createFakeZoho } from '@mb/zoho-inventory';
import { utcDay } from './infra/limits';

/** Public demo session: scopes governor/cache keys (`demo:{id}`) and carries the playground's fault toggles. */
export interface DemoSession {
  id: string;
  faults: DemoFault[];
}

/** Prefix of server-derived (per-IP) session ids; reserved, so no client can name another caller's IP session. */
export const IP_SESSION_PREFIX = 'ip-';

/** A client-chosen demo session id (X-MB-Session / `session_id`). The `ip-` prefix is reserved for the server. */
export const SESSION_ID_RE = /^(?!ip-)[A-Za-z0-9_-]{8,64}$/;
export const SESSION_HEADER = 'x-mb-session';
export const FAULTS_HEADER = 'x-mb-faults';

const FAULT_SET: ReadonlySet<string> = new Set(DEMO_FAULTS);

function single(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value ?? undefined;
}

/** Comma list of known faults; anything unknown (or a malformed list) is ignored entirely. */
export function parseFaults(raw: string | undefined): DemoFault[] {
  if (!raw) return [];
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > DEMO_FAULTS.length) return [];
  if (!parts.every((p) => FAULT_SET.has(p))) return [];
  return [...new Set(parts)].sort() as DemoFault[];
}

export function ipSessionId(ip: string): string {
  return `${IP_SESSION_PREFIX}${createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Session from `X-MB-Session` (validated, `ip-` reserved) or, for external MCP clients that send none, a stable
 * hash of the caller's IP bucket. Faults from `X-MB-Faults` apply only to an explicit client session: an IP session
 * is shared by everyone behind that NAT or egress range (all Claude.ai connector traffic arrives from a few
 * Anthropic IPs), and a fault such as `daily_quota_45` would otherwise lock all of them out until UTC midnight.
 * Header names are matched case-insensitively by both callers.
 */
export function demoSessionFrom(
  get: (name: string) => string | string[] | null | undefined,
  clientIpKey: string,
): DemoSession {
  const header = single(get(SESSION_HEADER));
  if (header && SESSION_ID_RE.test(header)) {
    return { id: header, faults: parseFaults(single(get(FAULTS_HEADER))) };
  }
  return { id: ipSessionId(clientIpKey), faults: [] };
}

/** The demo dataset, rebuilt lazily once per UTC day so relative dates ("due this week") stay true. */
export function createDemoDatasetProvider(clock: Clock): () => DemoDataset {
  let day = '';
  let dataset: DemoDataset | null = null;
  return () => {
    const today = utcDay(clock.now());
    if (dataset === null || day !== today) {
      dataset = createDemoDataset({ now: clock.now() });
      day = today;
    }
    return dataset;
  };
}

interface FakeEntry {
  fake: FakeZoho;
  dataset: DemoDataset;
  faultsKey: string;
  faults: ReadonlySet<DemoFault>;
}

/**
 * Per-session FakeZoho instances (small LRU). FakeZoho keeps token and fault state per instance: an
 * `expired_token` fault expires every token issued before the fault was first seen, so the first call after the
 * toggle gets 401 → refresh → success and later calls in the session succeed directly; `concurrency_1070` and
 * `server_5xx` fire for the first requests after the toggle only. Keeping one instance per session (rebuilt when
 * the fault set or the daily dataset changes) gives exactly that behaviour across calls, and re-arms a fault when
 * the user toggles it off and on again.
 */
export class DemoFakes {
  private readonly entries = new Map<string, FakeEntry>();

  constructor(
    private readonly dataset: () => DemoDataset,
    private readonly maxSessions = 1_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  forSession(session: DemoSession): FakeZoho {
    const dataset = this.dataset();
    const faultsKey = [...session.faults].sort().join(',');
    let entry = this.entries.get(session.id);
    if (!entry || entry.dataset !== dataset || entry.faultsKey !== faultsKey) {
      const faults: ReadonlySet<DemoFault> = new Set(session.faults);
      const fake = createFakeZoho({ dataset, faults: () => faults });
      entry = { fake, dataset, faultsKey, faults };
    }
    // Re-insert so Map order is least-recently-used first.
    this.entries.delete(session.id);
    this.entries.set(session.id, entry);
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.fake;
  }
}
