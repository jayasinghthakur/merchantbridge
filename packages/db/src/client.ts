import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgresJs } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Driver-agnostic Drizzle handle accepted by createDbStores (postgres.js in prod, PGlite in tests). */
export type MbDatabase = PgDatabase<PgQueryResultHKT>;

export interface DbHandle {
  db: MbDatabase;
  close(): Promise<void>;
}

/** packages/db/drizzle, resolved from this source file (workspace packages run as TS source). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export interface PostgresDbOptions {
  /** Pool size. Neon's free tier has a low connection ceiling and Fly runs one always-on machine. */
  max?: number;
}

export interface MigrateOptions {
  /** Override when the package is bundled and the drizzle/ folder is copied elsewhere. */
  migrationsFolder?: string;
}

function postgresClient(url: string, max: number) {
  return postgres(url, {
    // Neon's pooled endpoint is PgBouncer in transaction mode, which cannot hold prepared statements.
    prepare: false,
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    // Default is console.log; migrations emit "already exists, skipping" notices.
    onnotice: () => undefined,
  });
}

export function createPostgresDb(url: string, opts: PostgresDbOptions = {}): DbHandle {
  const client = postgresClient(url, opts.max ?? 5);
  return {
    db: drizzlePostgres({ client }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Applies pending migrations from the drizzle/ folder. Run once per deploy (release command), not on every boot:
 * Drizzle's migrator takes no lock, so concurrent runners could race. Prefer Neon's direct (unpooled) URL here.
 */
export async function migratePostgres(url: string, opts: MigrateOptions = {}): Promise<void> {
  const client = postgresClient(url, 1);
  try {
    await migratePostgresJs(drizzlePostgres({ client }), {
      migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_FOLDER,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * In-memory Postgres (PGlite) with all migrations applied: the same SQL as production, for tests and local dev.
 * Imported lazily because @electric-sql/pglite is a dev dependency and must not load in production.
 */
export async function createPgliteDb(opts: MigrateOptions = {}): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }, { migrate }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  const client = new PGlite();
  const db = drizzle({ client });
  try {
    await migrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_FOLDER });
  } catch (e) {
    await client.close();
    throw e;
  }
  return { db, close: () => client.close() };
}
