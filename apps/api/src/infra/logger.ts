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

export function createLogger(level: string, pretty = false) {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'merchantbridge-api' },
    ...(pretty ? {} : { timestamp: pino.stdTimeFunctions.isoTime }),
  });
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
