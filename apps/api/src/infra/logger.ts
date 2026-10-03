import type { DestinationStream } from 'pino';
import { pino } from 'pino';
import type { Logger } from '@mb/core';

/** Paths that must never reach logs, even if a caller logs a whole request or config object. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'authorization',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.client_secret',
  '*.clientSecret',
  '*.code',
  '*.token',
  '*.apiKey',
  '*.api_key',
  'ANTHROPIC_API_KEY',
  'ZOHO_CLIENT_SECRET',
  'MB_ENCRYPTION_KEY',
  'MB_STATE_SECRET',
];

/** Drops the query string: the OAuth callback carries `code` and `state` there. */
export function pathOnly(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

interface RawRequestLike {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Request serializer used for every `req` Fastify logs (it replaces Fastify's default one, which logs the full
 * URL). Only method and path: no query string, no headers.
 */
function safeReq(req: RawRequestLike): Record<string, unknown> {
  return { method: req.method, url: pathOnly(req.url) };
}

/**
 * `err` serializer for every logger in the process (Fastify, ToolRuntime and the packages log through it). Query
 * errors (Drizzle's DrizzleQueryError, or anything carrying `query`/`params`) embed the SQL parameters in their
 * message and as an enumerable `params` field: key hashes, refresh-token ciphertext, tenant ids. For those only the
 * names/codes of the error and its cause are kept; every other error uses pino's standard serializer.
 */
export function safeErr(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  if ('params' in value || 'query' in value) {
    const cause: unknown = value.cause;
    const causeCode = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
    return {
      type: value.name,
      message: '[query error: message withheld, it embeds SQL parameters]',
      ...(cause instanceof Error ? { cause_type: cause.name } : {}),
      ...(typeof causeCode === 'string' || typeof causeCode === 'number'
        ? { cause_code: causeCode }
        : {}),
    };
  }
  return pino.stdSerializers.err(value);
}

export function createLogger(level: string, pretty = false, destination?: DestinationStream) {
  const options = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'merchantbridge-api' },
    serializers: { req: safeReq, err: safeErr },
    ...(pretty ? {} : { timestamp: pino.stdTimeFunctions.isoTime }),
  };
  return destination ? pino(options, destination) : pino(options);
}

export type AppLogger = ReturnType<typeof createLogger>;

/** Narrow pino to the @mb/core Logger interface. */
export function toCoreLogger(log: AppLogger): Logger {
  return {
    debug: (obj, msg) => log.debug(obj, msg),
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
}
