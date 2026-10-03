import type { AccessTokenProvider } from '@mb/auth';
import { getDataCenter, isKnownApiDomain, isSupportedDc, reconnectRequiredError } from '@mb/auth';
import type {
  Cache,
  CallOptions,
  ConnectionStore,
  Governor,
  GovernorDecision,
  GovernorScope,
  Logger,
  ResolvedTenant,
  ToolRuntime,
  UsageEvent,
  ZohoPlan,
} from '@mb/core';
import {
  ConnectorError,
  DEMO_IDS,
  ZOHO_DAILY_LIMITS,
  createToolRuntime,
  zohoRateProfile,
} from '@mb/core';
import { DEMO_TENANT_ID } from '@mb/db';
import type { ZohoApi } from '@mb/zoho-inventory';
import {
  DEMO_ORGANIZATION_ID,
  FAKE_ZOHO_API_DOMAIN,
  createZohoApi,
  zohoInventoryConnector,
} from '@mb/zoho-inventory';
import type { AppContext } from './context';
import type { DemoFakes, DemoSession } from './demo';
import { argKeysByTool, restrictArgKeys } from './usage';

export const DEMO_ORG_NAME: string = DEMO_IDS.orgName;
const DEMO_DC = 'in';

/** Used when a demo call arrives without a session (in-process callers that set no header). */
const FALLBACK_DEMO_SESSION: DemoSession = { id: 'anonymous', faults: [] };

async function budgetOf(governor: Governor, scope: GovernorScope): Promise<number | null> {
  try {
    return (await governor.snapshot(scope)).budget_remaining_today;
  } catch {
    return null;
  }
}

// ---------- demo: FakeZoho only; this path has no access to stores, the vault or the token provider ----------

export interface DemoResolverDeps {
  fakes: DemoFakes;
  governor: Governor;
  cache: Cache;
  log: Logger;
}

export function createDemoResolver(deps: DemoResolverDeps) {
  function bind(
    opts: CallOptions,
    onDecision: (d: GovernorDecision) => void,
  ): ResolvedTenant<ZohoApi> {
    if (opts.tenantId !== DEMO_TENANT_ID) {
      // A demo call is always attributed to the demo tenant; anything else is a wiring bug.
      throw new ConnectorError('UPSTREAM_ERROR', 'Demo calls must use the demo tenant.', {
        retryable: false,
      });
    }
    const session = opts.demoSession
      ? { id: opts.demoSession.id, faults: [...opts.demoSession.faults] }
      : FALLBACK_DEMO_SESSION;
    const fake = deps.fakes.forSession(session);
    const scope: GovernorScope = { key: `demo:${session.id}`, profile: zohoRateProfile('free') };
    const client = createZohoApi({
      fetch: fake.fetch,
      apiDomain: FAKE_ZOHO_API_DOMAIN,
      organizationId: DEMO_ORGANIZATION_ID,
      tokens: fake.tokens,
      governor: deps.governor,
      scope,
      cache: deps.cache,
      cacheKeyPrefix: `demo:${session.id}:`,
      note: onDecision,
      webBaseUrl: getDataCenter(DEMO_DC).inventoryWebHost,
      connection: {
        mode: 'demo',
        dc: DEMO_DC,
        scopes: [...zohoInventoryConnector.scopes],
        organizationName: DEMO_ORG_NAME,
        plan: 'free',
      },
      log: deps.log,
    });
    return {
      client,
      organizationId: DEMO_ORGANIZATION_ID,
      budgetRemaining: () => budgetOf(deps.governor, scope),
    };
  }
  return function resolveDemo(
    opts: CallOptions,
    onDecision: (d: GovernorDecision) => void,
  ): Promise<ResolvedTenant<ZohoApi>> {
    try {
      return Promise.resolve(bind(opts, onDecision));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
}

// ---------- live: the tenant's own Zoho connection ----------

export interface LiveResolverDeps {
  connections: Pick<ConnectionStore, 'getActiveForTenant'>;
  tokens: AccessTokenProvider | null;
  governor: Governor;
  cache: Cache;
  fetch: typeof fetch;
  log: Logger;
}

function planOf(plan: string | null): ZohoPlan {
  return plan !== null && Object.hasOwn(ZOHO_DAILY_LIMITS, plan) ? (plan as ZohoPlan) : 'free';
}

export function createLiveResolver(deps: LiveResolverDeps) {
  return async function resolveLive(
    opts: CallOptions,
    onDecision: (d: GovernorDecision) => void,
  ): Promise<ResolvedTenant<ZohoApi>> {
    const conn = await deps.connections.getActiveForTenant(opts.tenantId);
    if (!conn) {
      throw new ConnectorError(
        'RECONNECT_REQUIRED',
        'No Zoho Inventory organization is connected for this key.',
        { hint: 'Ask the merchant to connect Zoho Inventory in MerchantBridge at /connect.' },
      );
    }
    if (conn.status !== 'active' || !isSupportedDc(conn.dc)) throw reconnectRequiredError();
    const tokens = deps.tokens;
    if (!tokens) {
      throw new ConnectorError(
        'UPSTREAM_ERROR',
        'Live Zoho connections are not configured on this server.',
        {
          retryable: false,
          hint: 'This is a server configuration problem; retrying will not help.',
        },
      );
    }
    const dc = getDataCenter(conn.dc);
    const apiDomain = isKnownApiDomain(conn.apiDomain) ? conn.apiDomain : dc.apiDomain;
    const key = `zoho:${conn.tenantId}:${conn.organizationId}`;
    const scope: GovernorScope = { key, profile: zohoRateProfile(planOf(conn.plan)) };
    const client = createZohoApi({
      fetch: deps.fetch,
      apiDomain,
      organizationId: conn.organizationId,
      tokens: {
        get: () => tokens.getAccessToken(conn),
        refreshAfterUnauthorized: (failed) => tokens.refreshAfterUnauthorized(conn, failed),
      },
      governor: deps.governor,
      scope,
      cache: deps.cache,
      cacheKeyPrefix: `${key}:`,
      note: onDecision,
      webBaseUrl: dc.inventoryWebHost,
      connection: {
        mode: 'live',
        dc: conn.dc,
        scopes: conn.scopes,
        organizationName: conn.organizationName,
        plan: conn.plan,
      },
      log: deps.log,
    });
    return {
      client,
      organizationId: conn.organizationId,
      budgetRemaining: () => budgetOf(deps.governor, scope),
    };
  };
}

export interface RuntimeDeps {
  demo: DemoResolverDeps;
  live: LiveResolverDeps;
  emit: (event: UsageEvent) => void;
  log: Logger;
  clock?: AppContext['clock'];
}

/**
 * The single ToolRuntime behind /mcp and /mcp/demo. `opts.demo` picks the resolver: the demo resolver is built
 * from FakeZoho pieces only and is never handed the connection store or the token provider.
 */
export function createRuntimeFrom(deps: RuntimeDeps): ToolRuntime {
  const resolveDemo = createDemoResolver(deps.demo);
  const resolveLive = createLiveResolver(deps.live);
  // Filled right after the runtime exists (descriptors are static); emit only runs later, during callTool.
  let argKeys = new Map<string, ReadonlySet<string>>();
  const runtime = createToolRuntime<ZohoApi>({
    connector: zohoInventoryConnector,
    resolve: (opts, onDecision) =>
      opts.demo ? resolveDemo(opts, onDecision) : resolveLive(opts, onDecision),
    emit: (event) => deps.emit(restrictArgKeys(event, argKeys.get(event.tool))),
    log: deps.log,
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  argKeys = argKeysByTool(runtime.listTools());
  return runtime;
}

export function createAppRuntime(ctx: AppContext): ToolRuntime {
  return createRuntimeFrom({
    demo: { fakes: ctx.demoFakes, governor: ctx.governor, cache: ctx.cache, log: ctx.coreLog },
    live: {
      connections: ctx.stores.connections,
      tokens: ctx.auth?.tokens ?? null,
      governor: ctx.governor,
      cache: ctx.cache,
      fetch: ctx.fetch,
      log: ctx.coreLog,
    },
    emit: (e) => ctx.usage.emit(e),
    log: ctx.coreLog,
    clock: ctx.clock,
  });
}
