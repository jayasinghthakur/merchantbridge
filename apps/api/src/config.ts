import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const LLM_PROVIDERS = ['openai', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Groq's free tier (OpenAI-compatible). Gemini's OpenAI endpoint, OpenRouter or a local Ollama also work. */
export const DEFAULT_LLM_BASE_URL = 'https://api.groq.com/openai/v1';

/** Playground model when MB_PLAYGROUND_MODEL is unset, per provider. */
export const DEFAULT_PLAYGROUND_MODELS: Readonly<Record<LlmProviderName, string>> = {
  openai: 'openai/gpt-oss-120b',
  anthropic: 'claude-haiku-4-5',
};

const optionalProvider = optionalString
  .transform((v) => v?.toLowerCase())
  .pipe(z.enum(LLM_PROVIDERS).optional());

const optionalUrl = optionalString.pipe(z.string().url().optional());

/**
 * Connection strings are often pasted from a provider's "Connect" panel as a whole command (`redis-cli --tls -u
 * redis://…`, `psql 'postgresql://…'`) or in quotes. Extract the URL, upgrade `redis://` to `rediss://` when the
 * command asked for TLS, and fail with a message that names the variable (never its value).
 */
export function normalizeConnectionUrl(
  raw: string | undefined,
  kind: 'postgres' | 'redis',
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  const pattern = kind === 'postgres' ? /postgres(?:ql)?:\/\/[^\s'"`]+/ : /rediss?:\/\/[^\s'"`]+/;
  const found = pattern.exec(raw)?.[0];
  if (!found) {
    return {
      ok: false,
      reason:
        kind === 'postgres'
          ? 'must be a postgres:// or postgresql:// connection URL'
          : 'must be a redis:// or rediss:// URL (for Upstash: rediss://default:<password>@<host>.upstash.io:6379, not the REST URL)',
    };
  }
  let value = found;
  if (kind === 'redis' && value.startsWith('redis://') && /(^|\s)--tls(\s|$)/.test(raw)) {
    value = `rediss://${value.slice('redis://'.length)}`;
  }
  try {
    const u = new URL(value);
    if (!u.hostname) throw new Error('no host');
  } catch {
    return { ok: false, reason: 'is not a parseable URL' };
  }
  return { ok: true, value };
}

function connectionUrl(kind: 'postgres' | 'redis') {
  return optionalString.transform((v, ctx) => {
    const r = normalizeConnectionUrl(v, kind);
    if (!r.ok) {
      ctx.addIssue({ code: 'custom', message: r.reason });
      return z.NEVER;
    }
    return r.value;
  });
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public base URL of this API, e.g. https://merchantbridge-api.vercel.app */
  MB_PUBLIC_API_URL: z.string().url().default('http://localhost:8787'),
  /** Public base URL of the web app, e.g. https://merchantbridge-web.vercel.app */
  MB_PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Extra hostnames accepted by the MCP Host-header check (the public API host is always included). */
  MB_ALLOWED_HOSTS: list,
  /** Browser origins allowed by CORS (the web URL is always included). Supports a trailing '*' wildcard. */
  MB_CORS_ORIGINS: list,
  DATABASE_URL: connectionUrl('postgres'),
  REDIS_URL: connectionUrl('redis'),
  /** base64 of 32 random bytes; AES-256-GCM key for refresh tokens. */
  MB_ENCRYPTION_KEY: optionalString,
  /** HMAC secret for OAuth state. */
  MB_STATE_SECRET: optionalString,
  MB_CONNECT_INVITE_CODE: optionalString,
  ZOHO_CLIENT_ID: optionalString,
  ZOHO_CLIENT_SECRET: optionalString,
  ZOHO_REDIRECT_URI: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  /**
   * LLM behind the playground: 'openai' (any OpenAI-compatible Chat Completions API; free tiers work) or
   * 'anthropic'. Default: 'openai' when MB_LLM_API_KEY is set, else 'anthropic' when ANTHROPIC_API_KEY is set.
   */
  MB_LLM_PROVIDER: optionalProvider,
  /** OpenAI-compatible base URL (default Groq). Ollama: http://localhost:11434/v1 */
  MB_LLM_BASE_URL: optionalUrl,
  /** Key for the OpenAI-compatible provider (Groq keys start with gsk_). Never logged. */
  MB_LLM_API_KEY: optionalString,
  MB_PLAYGROUND_ENABLED: bool,
  /** Model id; default per provider (DEFAULT_PLAYGROUND_MODELS). */
  MB_PLAYGROUND_MODEL: optionalString,
  /** Global cap on playground questions per UTC day. */
  MB_PLAYGROUND_DAILY_CAP: z.coerce.number().int().positive().default(300),
  TURNSTILE_SECRET_KEY: optionalString,
  TURNSTILE_SITE_KEY: optionalString,
  /** CIDR list whose callers (e.g. Anthropic's MCP egress) get the larger shared /mcp/demo bucket. */
  MB_TRUSTED_EGRESS_CIDRS: list,
  /**
   * Where the caller IP for rate limits comes from (see http-util.ts `resolveClientIp`). Defaults to
   * 'fly-client-ip' when running on Fly (FLY_APP_NAME is set on every Fly Machine), otherwise 'socket'.
   */
  MB_CLIENT_IP_SOURCE: z.enum(['socket', 'fly-client-ip', 'xff-last']).optional(),
  /** Set by Fly.io on every Machine; only used to pick the client-IP source. */
  FLY_APP_NAME: optionalString,
  /** Bearer token for GET /metrics. Without it /metrics is open in dev/test and disabled (404) in production. */
  MB_METRICS_TOKEN: optionalString,
});

export type ClientIpSource = 'socket' | 'fly-client-ip' | 'xff-last';

export type Env = z.infer<typeof envSchema>;

/** The LLM the playground would use. Secrets stay in `env`; this only says whether the key is there. */
export interface LlmSettings {
  /** Null when neither MB_LLM_PROVIDER nor any provider key is set. */
  provider: LlmProviderName | null;
  model: string;
  /** OpenAI-compatible base URL without a trailing slash (unused by the anthropic provider). */
  baseUrl: string;
  /** The selected provider's key is configured. */
  hasKey: boolean;
}

/**
 * Provider selection: an explicit MB_LLM_PROVIDER wins; otherwise 'openai' when MB_LLM_API_KEY is set, else
 * 'anthropic' when ANTHROPIC_API_KEY is set, else `fallback` (the app context passes 'anthropic' when a test
 * injects an Anthropic client), else none.
 */
export function resolveLlmSettings(
  env: Pick<
    Env,
    | 'MB_LLM_PROVIDER'
    | 'MB_LLM_API_KEY'
    | 'MB_LLM_BASE_URL'
    | 'ANTHROPIC_API_KEY'
    | 'MB_PLAYGROUND_MODEL'
  >,
  fallback: LlmProviderName | null = null,
): LlmSettings {
  const provider: LlmProviderName | null =
    env.MB_LLM_PROVIDER ??
    (env.MB_LLM_API_KEY ? 'openai' : env.ANTHROPIC_API_KEY ? 'anthropic' : fallback);
  const hasKey =
    provider === 'openai'
      ? Boolean(env.MB_LLM_API_KEY)
      : provider === 'anthropic'
        ? Boolean(env.ANTHROPIC_API_KEY)
        : false;
  return {
    provider,
    model: env.MB_PLAYGROUND_MODEL ?? DEFAULT_PLAYGROUND_MODELS[provider ?? 'openai'],
    baseUrl: (env.MB_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, ''),
    hasKey,
  };
}

export interface AppConfig {
  env: Env;
  isProd: boolean;
  /** Real Zoho OAuth is configured (otherwise /connect is disabled). */
  connectEnabled: boolean;
  /** MB_PLAYGROUND_ENABLED and the selected LLM provider has its key. */
  playgroundEnabled: boolean;
  llm: LlmSettings;
  allowedHosts: string[];
  corsOrigins: string[];
  clientIpSource: ClientIpSource;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';

  const connectEnabled = Boolean(
    env.ZOHO_CLIENT_ID &&
    env.ZOHO_CLIENT_SECRET &&
    env.ZOHO_REDIRECT_URI &&
    env.MB_ENCRYPTION_KEY &&
    env.MB_STATE_SECRET &&
    env.MB_CONNECT_INVITE_CODE,
  );

  if (isProd) {
    const missing = (['DATABASE_URL', 'REDIS_URL'] as const).filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(`Production requires: ${missing.join(', ')}`);
    }
  }

  const apiHost = new URL(env.MB_PUBLIC_API_URL).hostname;
  const allowedHosts = [...new Set([apiHost, 'localhost', '127.0.0.1', ...env.MB_ALLOWED_HOSTS])];
  const corsOrigins = [...new Set([env.MB_PUBLIC_WEB_URL, ...env.MB_CORS_ORIGINS])];

  const llm = resolveLlmSettings(env);

  return {
    env,
    isProd,
    connectEnabled,
    playgroundEnabled: env.MB_PLAYGROUND_ENABLED && llm.hasKey,
    llm,
    allowedHosts,
    corsOrigins,
    clientIpSource: env.MB_CLIENT_IP_SOURCE ?? (env.FLY_APP_NAME ? 'fly-client-ip' : 'socket'),
  };
}

/**
 * Matches an Origin against the allow-list; an entry may contain one '*' (e.g.
 * https://merchantbridge-*-team.vercel.app), which matches exactly one run of DNS-label characters: never a '.',
 * '/' or ':' so a wildcard cannot reach into another domain or label.
 */
export function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const [prefix, suffix] = entry.split('*', 2) as [string, string];
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) return false;
    const middle = origin.slice(prefix.length, origin.length - suffix.length);
    return origin.length > prefix.length + suffix.length && /^[A-Za-z0-9-]+$/.test(middle);
  });
}
