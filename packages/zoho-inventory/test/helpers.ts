import type {
  Cache,
  DemoFault,
  Governor,
  GovernorDecision,
  GovernorScope,
  GovernorSnapshot,
  Logger,
  ToolCallResult,
  UsageEvent,
} from '@mb/core';
import {
  DEMO_IDS,
  ManualClock,
  createToolRuntime,
  isUpstreamError,
  noopLogger,
  zohoRateProfile,
} from '@mb/core';
import type { ZohoApi, ZohoApiDeps } from '../src/client';
import { createZohoApi } from '../src/client';
import { zohoInventoryConnector } from '../src/connector';
import type { DemoDataset } from '../src/fake/dataset';
import { DEMO_ORGANIZATION_ID, createDemoDataset } from '../src/fake/dataset';
import { FAKE_ZOHO_API_DOMAIN, createFakeZoho } from '../src/fake/server';
import { ZOHO_SCOPES } from '../src/scopes';

export const NOW = Date.UTC(2026, 9, 3, 9, 0, 0);
export const TODAY = '2026-10-03';
export const WEB_BASE = 'https://inventory.zoho.in';

/**
 * Minimal Governor for tests: admits every attempt immediately and optionally retries UpstreamErrors
 * (never code 45). Deliberately independent of @mb/governor, which is built in parallel.
 */
export class StubGovernor implements Governor {
  attempts = 0;
  constructor(private readonly opts: { retries?: number; signal?: () => AbortSignal } = {}) {}

  async schedule<T>(
    _scope: GovernorScope,
    task: (attempt: number, signal: AbortSignal) => Promise<T>,
    onDecision?: (d: GovernorDecision) => void,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      this.attempts += 1;
      onDecision?.({ type: 'admitted', waited_ms: 0 });
      try {
        return await task(attempt, this.opts.signal?.() ?? new AbortController().signal);
      } catch (e) {
        const retryable = isUpstreamError(e) && e.failure.kind !== 'rate_limit_daily';
        if (!retryable || attempt > (this.opts.retries ?? 0)) throw e;
        onDecision?.({ type: 'retried', attempt, reason: e.failure.kind, backoff_ms: 0 });
      }
    }
  }

  snapshot(_scope: GovernorScope): Promise<GovernorSnapshot> {
    return Promise.resolve({
      budget_remaining_today: 480,
      daily_budget: 500,
      used_this_minute: this.attempts,
      in_flight: 0,
      circuit: 'closed',
    });
  }
}

/** In-memory read-through cache without expiry (tests never outlive a TTL). */
export class MapCache implements Cache {
  readonly store = new Map<string, unknown>();

  async wrap<T>(
    key: string,
    _ttlMs: number,
    load: () => Promise<T>,
    onDecision?: (d: GovernorDecision) => void,
  ): Promise<{ value: T; cached: boolean }> {
    if (this.store.has(key)) {
      onDecision?.({ type: 'cache_hit' });
      return { value: this.store.get(key) as T, cached: true };
    }
    const value = await load();
    this.store.set(key, value);
    return { value, cached: false };
  }
}

export interface CapturedLog {
  level: string;
  obj: object;
  msg?: string;
}

export function captureLogger(): { log: Logger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const push = (level: string) => (obj: object, msg?: string) => {
    lines.push({ level, obj, ...(msg === undefined ? {} : { msg }) });
  };
  return {
    log: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    lines,
  };
}

export function apiDeps(
  overrides: Partial<ZohoApiDeps> & Pick<ZohoApiDeps, 'fetch' | 'tokens'>,
): ZohoApiDeps {
  return {
    apiDomain: FAKE_ZOHO_API_DOMAIN,
    organizationId: DEMO_ORGANIZATION_ID,
    governor: new StubGovernor(),
    scope: { key: 'demo:test', profile: zohoRateProfile() },
    cacheKeyPrefix: 'demo:test:',
    note: () => undefined,
    webBaseUrl: WEB_BASE,
    connection: {
      mode: 'demo',
      dc: 'in',
      scopes: ZOHO_SCOPES,
      organizationName: DEMO_IDS.orgName,
      plan: 'free',
    },
    ...overrides,
  };
}

export function harness(
  opts: {
    faults?: Set<DemoFault>;
    retries?: number;
    cache?: Cache;
    dataset?: DemoDataset;
    /** Wraps FakeZoho's fetch, e.g. to rewrite a response the fake cannot produce. */
    wrapFetch?: (inner: typeof fetch) => typeof fetch;
  } = {},
) {
  const faults = opts.faults ?? new Set<DemoFault>();
  const dataset = opts.dataset ?? createDemoDataset({ now: NOW });
  const fake = createFakeZoho({ dataset, faults: () => faults });
  const upstreamFetch = opts.wrapFetch ? opts.wrapFetch(fake.fetch) : fake.fetch;
  const governor = new StubGovernor({ retries: opts.retries ?? 0 });
  const events: UsageEvent[] = [];
  const makeApi = (note: (d: GovernorDecision) => void): ZohoApi =>
    createZohoApi(
      apiDeps({
        fetch: upstreamFetch,
        tokens: fake.tokens,
        governor,
        note,
        ...(opts.cache ? { cache: opts.cache } : {}),
      }),
    );
  const runtime = createToolRuntime<ZohoApi>({
    connector: zohoInventoryConnector,
    resolve: (_o, onDecision) =>
      Promise.resolve({
        client: makeApi(onDecision),
        organizationId: DEMO_ORGANIZATION_ID,
        budgetRemaining: () => Promise.resolve(480),
      }),
    emit: (e) => {
      events.push(e);
    },
    log: noopLogger,
    clock: new ManualClock(NOW),
  });
  let n = 0;
  const call = (name: string, args: unknown): Promise<ToolCallResult> =>
    runtime.callTool(name, args, { tenantId: 'demo:test', requestId: `req-${++n}`, demo: true });
  return { dataset, fake, faults, governor, events, runtime, call, makeApi };
}

/** structuredContent.data of a successful call, failing loudly with the error body otherwise. */
export function dataOf<T = Record<string, unknown>>(res: ToolCallResult): T {
  if (res.isError) throw new Error(`expected success, got ${res.text}`);
  return (res.structuredContent as { data: T }).data;
}

export function errorOf(res: ToolCallResult): {
  code: string;
  message: string;
  retryable: boolean;
  hint?: string;
} {
  if (!res.isError) throw new Error(`expected an error, got ${res.text.slice(0, 200)}`);
  return (res.structuredContent as { error: { code: string; message: string; retryable: boolean } })
    .error;
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
