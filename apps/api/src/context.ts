import Anthropic from '@anthropic-ai/sdk';
import type { AccessTokenProvider, StateSigner, TokenVault, ZohoOAuthClient } from '@mb/auth';
import {
  createAccessTokenProvider,
  createStateSigner,
  createTokenVault,
  createZohoOAuthClient,
} from '@mb/auth';
import type { Cache, Clock, Governor, Kv, Logger } from '@mb/core';
import { MemoryKv, systemClock } from '@mb/core';
import type { DbHandle, MbStores } from '@mb/db';
import {
  DEMO_TENANT_ID,
  createDbStores,
  createMemoryStores,
  createPostgresDb,
  ensureDemoTenant,
} from '@mb/db';
import { createCache, createGovernor } from '@mb/governor';
import type { DemoDataset } from '@mb/zoho-inventory';
import type { AppConfig, LlmSettings } from './config';
import { resolveLlmSettings } from './config';
import { DemoFakes, createDemoDatasetProvider } from './demo';
import type { AppLogger } from './infra/logger';
import { createLogger, toCoreLogger } from './infra/logger';
import { RedisKv } from './infra/redis-kv';
import type { Metrics } from './metrics';
import { createMetrics } from './metrics';
import type { LlmRuntime } from './playground/provider';
import type { UsageEmitter } from './usage';
import { createUsageEmitter } from './usage';
import { API_VERSION } from './version';

/** Zoho OAuth + token pieces; present only when the Zoho client and the vault key are configured. */
export interface AuthPieces {
  vault: TokenVault;
  oauth: ZohoOAuthClient;
  tokens: AccessTokenProvider;
  /** Null when MB_STATE_SECRET is missing (connect is then disabled). */
  stateSigner: StateSigner | null;
  clientId: string;
  redirectUri: string;
}

export interface AppContextOverrides {
  /** All outbound Zoho + Zoho Accounts (+ Turnstile) traffic. Tests pass a fake; never real network in tests. */
  fetch?: typeof fetch;
  /** Factory for the Anthropic client used by the playground (selects the anthropic provider when none is set). */
  anthropic?: () => Anthropic;
  /** Transport for the OpenAI-compatible LLM provider. Defaults to `fetch` (so tests never reach the network). */
  llmFetch?: typeof fetch;
  clock?: Clock;
  kv?: Kv;
  stores?: MbStores;
  log?: AppLogger;
  /** Governor jitter source; tests pass `() => 0` so retries do not sleep. */
  governorRandom?: () => number;
  usageFlushMs?: number;
}

export interface AppContext {
  config: AppConfig;
  version: string;
  clock: Clock;
  log: AppLogger;
  coreLog: Logger;
  kv: Kv;
  kvMode: 'memory-kv' | 'redis';
  stores: MbStores;
  storageMode: 'memory' | 'postgres';
  governor: Governor;
  cache: Cache;
  fetch: typeof fetch;
  auth: AuthPieces | null;
  demoDataset: () => DemoDataset;
  demoFakes: DemoFakes;
  usage: UsageEmitter;
  metrics: Metrics;
  /** Null when no Anthropic key (or override) is configured; used only by the anthropic provider. */
  anthropic: (() => Anthropic) | null;
  /** The playground's LLM settings after provider selection (model, provider, base URL; no secrets). */
  llmSettings: LlmSettings;
  /** The playground's model connection; null when the selected provider has no key (playground disabled). */
  llm: LlmRuntime | null;
  /** Readiness probes for /health/ready. */
  pingKv(): Promise<boolean>;
  pingStore(): Promise<boolean>;
  close(): Promise<void>;
}

function buildAuth(
  config: AppConfig,
  deps: { kv: Kv; clock: Clock; stores: MbStores; fetch: typeof fetch; log: Logger },
): AuthPieces | null {
  const env = config.env;
  if (
    !env.ZOHO_CLIENT_ID ||
    !env.ZOHO_CLIENT_SECRET ||
    !env.ZOHO_REDIRECT_URI ||
    !env.MB_ENCRYPTION_KEY
  ) {
    return null;
  }
  const vault = createTokenVault(env.MB_ENCRYPTION_KEY);
  const oauth = createZohoOAuthClient({
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    redirectUri: env.ZOHO_REDIRECT_URI,
    fetch: deps.fetch,
    log: deps.log,
  });
  const tokens = createAccessTokenProvider({
    kv: deps.kv,
    clock: deps.clock,
    vault,
    connections: deps.stores.connections,
    oauth,
    log: deps.log,
  });
  const stateSigner = env.MB_STATE_SECRET
    ? createStateSigner({ secret: env.MB_STATE_SECRET, kv: deps.kv, clock: deps.clock })
    : null;
  return {
    vault,
    oauth,
    tokens,
    stateSigner,
    clientId: env.ZOHO_CLIENT_ID,
    redirectUri: env.ZOHO_REDIRECT_URI,
  };
}

export async function createAppContext(
  config: AppConfig,
  overrides: AppContextOverrides = {},
): Promise<AppContext> {
  const clock = overrides.clock ?? systemClock;
  const log = overrides.log ?? createLogger(config.env.LOG_LEVEL, !config.isProd);
  const coreLog = toCoreLogger(log);
  const outboundFetch = overrides.fetch ?? globalThis.fetch.bind(globalThis);

  // ---- kv ----
  let kv: Kv;
  let kvMode: AppContext['kvMode'];
  let redis: RedisKv | null = null;
  if (overrides.kv) {
    kv = overrides.kv;
    kvMode = overrides.kv instanceof RedisKv ? 'redis' : 'memory-kv';
    if (overrides.kv instanceof RedisKv) redis = overrides.kv;
  } else if (config.env.REDIS_URL) {
    redis = RedisKv.fromUrl(config.env.REDIS_URL);
    kv = redis;
    kvMode = 'redis';
  } else {
    kv = new MemoryKv(clock);
    kvMode = 'memory-kv';
    log.warn(
      { kv: 'memory' },
      'REDIS_URL not set: using in-memory Kv (rate limits, governor and token cache are single-instance only)',
    );
  }

  // ---- stores ----
  let stores: MbStores;
  let storageMode: AppContext['storageMode'];
  let db: DbHandle | null = null;
  if (overrides.stores) {
    stores = overrides.stores;
    storageMode = 'memory';
  } else if (config.env.DATABASE_URL) {
    db = createPostgresDb(config.env.DATABASE_URL);
    stores = createDbStores(db.db, { clock });
    storageMode = 'postgres';
  } else {
    stores = createMemoryStores({ clock });
    storageMode = 'memory';
    log.warn(
      { storage: 'memory' },
      'DATABASE_URL not set: using in-memory stores (dev only; data is lost on restart)',
    );
  }
  await ensureDemoTenant(stores);

  const governor = createGovernor({
    kv,
    clock,
    log: coreLog,
    upstreamName: 'Zoho Inventory',
    ...(overrides.governorRandom ? { random: overrides.governorRandom } : {}),
  });
  const cache = createCache({ kv, clock, log: coreLog });
  const auth = buildAuth(config, { kv, clock, stores, fetch: outboundFetch, log: coreLog });

  const metrics = createMetrics({ defaultMetrics: config.env.NODE_ENV !== 'test' });
  const usage = createUsageEmitter({
    store: stores.usage,
    log: coreLog,
    onEvent: (e) => metrics.observeToolCall(e),
    ...(overrides.usageFlushMs === undefined ? {} : { flushMs: overrides.usageFlushMs }),
  });

  const demoDataset = createDemoDatasetProvider(clock);
  const demoFakes = new DemoFakes(demoDataset);

  let anthropic: (() => Anthropic) | null = null;
  if (overrides.anthropic) anthropic = overrides.anthropic;
  else if (config.env.ANTHROPIC_API_KEY) {
    const apiKey = config.env.ANTHROPIC_API_KEY;
    let client: Anthropic | null = null;
    anthropic = () => {
      client ??= new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
      return client;
    };
  }

  // Provider selection (config.ts): explicit MB_LLM_PROVIDER, else MB_LLM_API_KEY → openai, else Anthropic.
  const llmSettings =
    config.llm.provider === null && overrides.anthropic
      ? resolveLlmSettings(config.env, 'anthropic')
      : config.llm;
  let llm: LlmRuntime | null = null;
  if (llmSettings.provider === 'openai' && config.env.MB_LLM_API_KEY) {
    llm = {
      provider: 'openai',
      model: llmSettings.model,
      baseUrl: llmSettings.baseUrl,
      apiKey: config.env.MB_LLM_API_KEY,
      fetch: overrides.llmFetch ?? outboundFetch,
    };
  } else if (llmSettings.provider === 'anthropic' && anthropic) {
    llm = { provider: 'anthropic', model: llmSettings.model, anthropic };
  }

  let closed = false;
  return {
    config,
    version: API_VERSION,
    clock,
    log,
    coreLog,
    kv,
    kvMode,
    stores,
    storageMode,
    governor,
    cache,
    fetch: outboundFetch,
    auth,
    demoDataset,
    demoFakes,
    usage,
    metrics,
    anthropic,
    llmSettings,
    llm,
    async pingKv() {
      try {
        if (redis) return await redis.ping();
        await kv.get('health:ping');
        return true;
      } catch {
        return false;
      }
    },
    async pingStore() {
      try {
        return (await stores.tenants.get(DEMO_TENANT_ID)) !== null;
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await usage.close();
      if (redis) {
        try {
          await redis.quit();
        } catch {
          // already closed
        }
      }
      if (db) await db.close();
    },
  };
}
