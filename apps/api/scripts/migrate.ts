/**
 * Release-phase migration entrypoint: applies pending Drizzle migrations (packages/db/drizzle) to Postgres.
 *
 * Fly runs it once per deploy as `[deploy] release_command` (apps/api/fly.toml), in a temporary Machine that has the
 * app's secrets, before any app Machine is updated. A non-zero exit aborts the deploy. It is not run on boot because
 * Drizzle's migrator takes no lock, so concurrent runners could race (see `migratePostgres` in @mb/db).
 *
 * URL: `DATABASE_URL`, or `DATABASE_URL_UNPOOLED` when set (optional; @mb/db prefers Neon's direct endpoint for
 * migrations). Locally: `DATABASE_URL=... pnpm --filter @mb/api exec tsx scripts/migrate.ts`.
 *
 * Never logs the connection string: errors are reduced to name/code/message with the URL masked out.
 */
import { migratePostgres } from '@mb/db';
import { createLogger } from '../src/infra/logger';

const log = createLogger(process.env.LOG_LEVEL ?? 'info');

const source = process.env.DATABASE_URL_UNPOOLED?.trim() ? 'DATABASE_URL_UNPOOLED' : 'DATABASE_URL';
const url = process.env[source]?.trim();

/**
 * Error summary that is safe to log: no extra own properties (e.g. a URL TypeError's `input`), URL masked.
 * The key is `error_code`, not `code`, because the logger redacts `*.code` (OAuth authorization codes).
 */
function describe(err: unknown, secret: string, depth = 0): Record<string, unknown> {
  const mask = (s: string) => (secret ? s.split(secret).join(`[${source}]`) : s);
  if (!(err instanceof Error)) return { message: mask(String(err)) };
  const code = (err as { code?: unknown }).code;
  return {
    name: err.name,
    ...(typeof code === 'string' ? { error_code: code } : {}),
    message: mask(err.message),
    // Drizzle wraps the driver error (the useful part, e.g. a SQLSTATE) in `cause`.
    ...(err.cause !== undefined && depth < 3
      ? { cause: describe(err.cause, secret, depth + 1) }
      : {}),
  };
}

if (!url) {
  log.fatal('DATABASE_URL is not set; refusing to migrate');
  process.exitCode = 1;
} else {
  const started = Date.now();
  log.info({ source }, 'applying migrations');
  try {
    await migratePostgres(url);
    log.info({ source, duration_ms: Date.now() - started }, 'migrations applied');
  } catch (err) {
    log.fatal({ source, error: describe(err, url) }, 'migration failed');
    process.exitCode = 1;
  }
}
