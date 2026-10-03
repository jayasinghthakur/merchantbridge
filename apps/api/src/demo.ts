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
/** Response header on /mcp/demo: the faults actually applied (comma list, or `none`). */
export const APPLIED_FAULTS_HEADER = 'x-mb-applied-faults';

/** Human-readable session rule, used in 400 messages. */
export const SESSION_RULE =
  "X-MB-Session must be 8-64 characters from [A-Za-z0-9_-] and must not start with 'ip-' " +
  '(ip- ids are reserved for server-assigned per-IP sessions)';

const FAULT_SET: ReadonlySet<string> = new Set(DEMO_FAULTS);

function single(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.join(',');
  return value ?? undefined;
}

export type FaultsParse = { ok: true; faults: DemoFault[] } | { ok: false; unknown: string[] };

/** Comma list of fault names; empty or absent means none. Unknown names are reported, never dropped. */
export function parseFaults(raw: string | undefined): FaultsParse {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = [...new Set(parts.filter((p) => !FAULT_SET.has(p)))];
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, faults: [...new Set(parts)].sort() as DemoFault[] };
}

export function ipSessionId(ip: string): string {
  return `${IP_SESSION_PREFIX}${createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 16)}`;
}

/** Echoes at most 5 rejected names, each truncated and quoted, so a 400 never reflects a large header. */
function namesForMessage(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((n) => JSON.stringify(n.slice(0, 40)));
  return names.length > 5 ? `${shown.join(', ')} (and ${names.length - 5} more)` : shown.join(', ');
}

export type DemoSessionResult = { ok: true; session: DemoSession } | { ok: false; message: string };

/**
 * Session from `X-MB-Session` (validated, `ip-` reserved) or, for external MCP clients that send none, a stable
 * hash of the caller's IP bucket. Faults from `X-MB-Faults` apply only to an explicit client session: an IP session
 * is shared by everyone behind that NAT or egress range (all Claude.ai connector traffic arrives from a few
 * Anthropic IPs), and a fault such as `daily_quota_45` would otherwise lock all of them out until UTC midnight.
 *
 * A fault header is never silently ignored: unknown fault names, or faults without a valid client session, return
 * `ok: false` with a message for a 400. Without faults, an invalid or `ip-` session header falls back to the
 * caller's own IP session (a client can never name someone else's). Header names are matched case-insensitively.
 */
export function resolveDemoSession(
  get: (name: string) => string | string[] | null | undefined,
  clientIpKey: string,
): DemoSessionResult {
  const header = single(get(SESSION_HEADER));
  const validSession = header !== undefined && SESSION_ID_RE.test(header);
  const parsed = parseFaults(single(get(FAULTS_HEADER)));
  const problems: string[] = [];
  if (!parsed.ok) {
    problems.push(
      `X-MB-Faults has unknown fault name(s): ${namesForMessage(parsed.unknown)}. ` +
        `Valid faults (comma-separated): ${DEMO_FAULTS.join(', ')}.`,
    );
  }
  const wantsFaults = !parsed.ok || parsed.faults.length > 0;
  if (wantsFaults && !validSession) {
    problems.push(
      `X-MB-Faults needs your own demo session: ${header === undefined ? 'X-MB-Session is missing' : 'X-MB-Session is invalid'}. ` +
        `${SESSION_RULE}. Faults never apply to the shared per-IP session.`,
    );
  }
  if (problems.length > 0) return { ok: false, message: problems.join(' ') };
  const faults = parsed.ok ? parsed.faults : [];
  if (validSession) return { ok: true, session: { id: header, faults } };
  return { ok: true, session: { id: ipSessionId(clientIpKey), faults: [] } };
}

/** Value of the X-MB-Applied-Faults response header. */
export function appliedFaultsHeader(faults: readonly DemoFault[]): string {
  return faults.length === 0 ? 'none' : faults.join(',');
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
