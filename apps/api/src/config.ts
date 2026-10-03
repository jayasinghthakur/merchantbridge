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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public base URL of this API, e.g. https://merchantbridge-api.fly.dev */
  MB_PUBLIC_API_URL: z.string().url().default('http://localhost:8787'),
  /** Public base URL of the web app, e.g. https://merchantbridge.vercel.app */
  MB_PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Extra hostnames accepted by the MCP Host-header check (the public API host is always included). */
  MB_ALLOWED_HOSTS: list,
  /** Browser origins allowed by CORS (the web URL is always included). Supports a trailing '*' wildcard. */
  MB_CORS_ORIGINS: list,
  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,
  /** base64 of 32 random bytes; AES-256-GCM key for refresh tokens. */
  MB_ENCRYPTION_KEY: optionalString,
  /** HMAC secret for OAuth state. */
  MB_STATE_SECRET: optionalString,
  MB_CONNECT_INVITE_CODE: optionalString,
  ZOHO_CLIENT_ID: optionalString,
  ZOHO_CLIENT_SECRET: optionalString,
  ZOHO_REDIRECT_URI: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  MB_PLAYGROUND_ENABLED: bool,
  MB_PLAYGROUND_MODEL: z.string().default('claude-haiku-4-5'),
  /** Global cap on playground questions per UTC day. */
  MB_PLAYGROUND_DAILY_CAP: z.coerce.number().int().positive().default(300),
  TURNSTILE_SECRET_KEY: optionalString,
  TURNSTILE_SITE_KEY: optionalString,
  /** CIDR list whose callers (e.g. Anthropic's MCP egress) get the larger shared /mcp/demo bucket. */
  MB_TRUSTED_EGRESS_CIDRS: list,
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  isProd: boolean;
  /** Real Zoho OAuth is configured (otherwise /connect is disabled). */
  connectEnabled: boolean;
  playgroundEnabled: boolean;
  allowedHosts: string[];
  corsOrigins: string[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
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

  return {
    env,
    isProd,
    connectEnabled,
    playgroundEnabled: env.MB_PLAYGROUND_ENABLED && Boolean(env.ANTHROPIC_API_KEY),
    allowedHosts,
    corsOrigins,
  };
}

/** Matches an Origin against the allow-list; entries may end with '*' (e.g. https://merchantbridge-*.vercel.app). */
export function originAllowed(origin: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (!entry.includes('*')) return entry === origin;
    const [prefix, suffix] = entry.split('*', 2) as [string, string];
    return origin.startsWith(prefix) && origin.endsWith(suffix) && origin.length > prefix.length + suffix.length;
  });
}
