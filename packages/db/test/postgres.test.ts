import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { UsageEvent } from '@mb/core';
import { ManualClock, ZOHO_DAILY_LIMITS } from '@mb/core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import type { DrizzleSnapshotJSON } from 'drizzle-kit/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../src/schema';
import type { DbHandle } from '../src/index';
import {
  INSERT_CHUNK_SIZE,
  MIGRATIONS_FOLDER,
  StoreError,
  createDbStores,
  createPgliteDb,
  guard,
  toStoreError,
} from '../src/index';

interface Journal {
  entries: { idx: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as Journal;

async function rows<T>(client: PGlite, query: string): Promise<T[]> {
  return (await client.query<T>(query)).rows;
}

describe('migrations', () => {
  it('apply cleanly on a fresh PGlite and are idempotent', async () => {
    const client = new PGlite();
    try {
      const db = drizzle({ client });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const tables = await rows<{ table_name: string }>(
        client,
        `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
      );
      expect(tables.map((t) => t.table_name)).toEqual([
        'api_keys',
        'connections',
        'tenants',
        'usage_events',
      ]);

      const constraints = await rows<{ conname: string }>(
        client,
        `select conname from pg_constraint where connamespace = 'public'::regnamespace order by 1`,
      );
      expect(constraints.map((c) => c.conname)).toEqual(
        expect.arrayContaining([
          'api_keys_hash_unique',
          'api_keys_tenant_id_tenants_id_fk',
          'connections_tenant_provider_org_unique',
          'connections_status_check',
          'connections_plan_check',
          'connections_tenant_id_tenants_id_fk',
          'tenants_kind_check',
          'usage_events_status_check',
        ]),
      );

      const indexes = await rows<{ indexname: string; indexdef: string }>(
        client,
        `select indexname, indexdef from pg_indexes where tablename = 'usage_events'`,
      );
      const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
      expect(byName.get('usage_events_tenant_ts_idx')).toMatch(/\(tenant_id, ts DESC, id DESC\)/);
      expect(byName.get('usage_events_ts_idx')).toMatch(/\(ts\)/);

      const applied = await rows<{ n: number }>(
        client,
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(applied[0]?.n).toBe(journal.entries.length);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('are in sync with src/schema.ts (run drizzle-kit generate after schema changes)', async () => {
    const last = journal.entries.at(-1);
    expect(last).toBeDefined();
    const snapshot = JSON.parse(
      readFileSync(
        join(MIGRATIONS_FOLDER, 'meta', `${String(last!.idx).padStart(4, '0')}_snapshot.json`),
        'utf8',
      ),
    ) as DrizzleSnapshotJSON;
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });

  it('schema enums match the core types', () => {
    expect([...schema.ZOHO_PLANS].sort()).toEqual(Object.keys(ZOHO_DAILY_LIMITS).sort());
  });
});

describe('postgres store specifics', () => {
  let pg: DbHandle;
  const clock = new ManualClock();

  beforeAll(async () => {
    pg = await createPgliteDb();
  }, 30_000);
  afterAll(() => pg.close());
  beforeEach(async () => {
    await pg.db.execute(
      `truncate table usage_events, api_keys, connections, tenants restart identity cascade`,
    );
  });

  function event(tenantId: string, ts: number, requestId = 'req'): UsageEvent {
    return {
      ts: new Date(ts).toISOString(),
      request_id: requestId,
      tenant_id: tenantId,
      organization_id: null,
      connector: 'zoho_inventory',
      tool: 'zoho_list_items',
      client_name: null,
      demo: true,
      status: 'ok',
      error_code: null,
      duration_ms: 5,
      upstream_calls: 0,
      cache_hits: 1,
      retries: 0,
      result_tokens: 50,
      args_masked: {},
    };
  }

  it('deleteOlderThan works through the table in bounded batches', async () => {
    const stores = createDbStores(pg.db, { clock, deleteBatchSize: 7 });
    const t = await stores.tenants.create({ name: 'Acme', kind: 'live' });
    const base = clock.now();
    await stores.usage.insertMany([
      ...Array.from({ length: 20 }, (_, i) => event(t.id, base - 100_000 + i)),
      ...Array.from({ length: 3 }, (_, i) => event(t.id, base + i)),
    ]);
    expect(await stores.usage.deleteOlderThan(new Date(base).toISOString())).toBe(20);
    expect(await stores.usage.recent(t.id, 100)).toHaveLength(3);
  });

  it('insertMany is atomic across chunks', async () => {
    const stores = createDbStores(pg.db, { clock });
    const t = await stores.tenants.create({ name: 'Acme', kind: 'live' });
    const events = Array.from({ length: INSERT_CHUNK_SIZE + 10 }, (_, i) =>
      event(t.id, clock.now() + i),
    );
    // Validation now repairs every value Postgres would reject, so inject the failure server side: a trigger
    // that raises on one row of the second chunk.
    events[INSERT_CHUNK_SIZE + 5] = event(t.id, clock.now(), 'boom');
    const client = (pg.db as unknown as { $client: PGlite }).$client;
    await client.exec(`
      create function mb_test_boom() returns trigger language plpgsql as $$
      begin
        if new.request_id = 'boom' then raise exception 'boom' using errcode = '40001'; end if;
        return new;
      end $$;
      create trigger mb_test_boom before insert on usage_events
        for each row execute function mb_test_boom();
    `);
    try {
      const err: unknown = await stores.usage.insertMany(events).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      // The serialization-failure SQLSTATE survives the transaction wrapper, so a flusher may retry.
      expect(err).toMatchObject({ sqlState: '40001', retryable: true });
      expect(await stores.usage.recent(t.id, 1000)).toEqual([]);
    } finally {
      await client.exec('drop trigger mb_test_boom on usage_events; drop function mb_test_boom();');
    }

    await stores.usage.insertMany(events);
    expect(await stores.usage.recent(t.id, 1000)).toHaveLength(INSERT_CHUNK_SIZE + 10);
  });

  it('recent() reads newest-first straight from the index, with no sort step', async () => {
    const stores = createDbStores(pg.db, { clock });
    const t = await stores.tenants.create({ name: 'Acme', kind: 'live' });
    await stores.usage.insertMany(
      Array.from({ length: 50 }, (_, i) => event(t.id, clock.now() + (i % 10))),
    );
    // Capture the SQL recent() issues by routing a second store through a logging drizzle instance.
    const client = (pg.db as unknown as { $client: PGlite }).$client;
    let captured: { sql: string; params: unknown[] } | undefined;
    const logged = drizzle({
      client,
      logger: { logQuery: (q, params) => void (captured ??= { sql: q, params }) },
    });
    await createDbStores(logged, { clock }).usage.recent(t.id, 20);
    expect(captured?.sql).toMatch(/order by .*"ts" desc, .*"id" desc limit/i);

    await client.exec('set enable_seqscan = off');
    try {
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `explain ${captured!.sql}`,
        captured!.params,
      );
      const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(text).toContain('usage_events_tenant_ts_idx');
      expect(text).not.toMatch(/\bSort\b/);
    } finally {
      await client.exec('reset enable_seqscan');
    }
  });

  it('maps raw constraint errors to StoreError without leaking bound params', async () => {
    const stores = createDbStores(pg.db, { clock });
    const t = await stores.tenants.create({ name: 'Acme', kind: 'live' });
    const err: unknown = await guard(() =>
      pg.db.insert(schema.connections).values({
        tenantId: t.id,
        provider: 'zoho_inventory',
        dc: 'in',
        accountsServer: 'https://accounts.zoho.in',
        apiDomain: 'https://www.zohoapis.in',
        organizationId: '1',
        refreshTokenEnc: 'v1.SECRET-CIPHERTEXT',
        status: 'bogus' as never,
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({
      code: 'check_violation',
      constraint: 'connections_status_check',
      sqlState: '23514',
    });
    expect(JSON.stringify(err)).not.toContain('SECRET');
    expect((err as Error).message).not.toContain('SECRET');
    expect(err).toMatchObject({ retryable: false });
    expect(toStoreError('weird')).toMatchObject({ code: 'database_error', retryable: false });
  });
});

describe('toStoreError classification', () => {
  /** Shape of a server error from postgres.js (PostgresError) or PGlite (DatabaseError). */
  function serverError(code: string, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(`server says ${code}`), { severity: 'ERROR', code, ...extra });
  }

  it('takes sqlState only from server errors, never from driver/network codes', () => {
    // postgres.js connection errors and Node socket errors also carry `code`, but it is not a SQLSTATE.
    const timeout = Object.assign(new Error('write CONNECT_TIMEOUT db.example:5432'), {
      code: 'CONNECT_TIMEOUT',
      errno: 'CONNECT_TIMEOUT',
    });
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: -61,
      syscall: 'connect',
    });
    // EPIPE is five upper-case letters, like a SQLSTATE; only `severity` marks a server error.
    const pipe = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
      errno: -32,
      syscall: 'write',
    });
    for (const e of [timeout, refused, pipe]) {
      const se = toStoreError(e);
      expect(se.code).toBe('database_error');
      expect(se.sqlState).toBeUndefined();
      expect(se.retryable).toBe(true);
    }
    expect(
      toStoreError(serverError('23505', { constraint_name: 'api_keys_hash_unique' })),
    ).toMatchObject({
      code: 'unique_violation',
      sqlState: '23505',
      constraint: 'api_keys_hash_unique',
    });
  });

  it('marks transient failures retryable and constraint/input failures not retryable', () => {
    const transient = [
      serverError('40001'), // serialization_failure
      serverError('40P01'), // deadlock_detected
      serverError('08006'), // connection_failure
      serverError('57P01', { severity: 'FATAL' }), // admin_shutdown (Neon restart)
      serverError('53300', { severity: 'FATAL' }), // too_many_connections
      Object.assign(new Error('write CONNECTION_CLOSED db:5432'), { code: 'CONNECTION_CLOSED' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }),
    ];
    for (const e of transient) expect(toStoreError(e).retryable, e.message).toBe(true);

    const permanent = [
      serverError('23505'),
      serverError('23514'),
      serverError('22P02'),
      serverError('42P01'), // undefined_table: a deploy bug, retrying will not help
      new Error('something else'),
    ];
    for (const e of permanent) expect(toStoreError(e).retryable, e.message).toBe(false);
  });

  it('classifies the driver cause of a DrizzleQueryError without leaking its params', () => {
    const wrapped = new DrizzleQueryError(
      'insert into api_keys ...',
      ['SECRET-HASH'],
      serverError('40001'),
    );
    const se = toStoreError(wrapped);
    expect(se).toMatchObject({ code: 'database_error', sqlState: '40001', retryable: true });
    expect(se.message).not.toContain('SECRET');
    expect(toStoreError(new DrizzleQueryError('select 1', ['SECRET']))).toMatchObject({
      code: 'database_error',
      retryable: false,
    });
    expect(toStoreError(new DrizzleQueryError('select 1', ['SECRET'])).message).not.toContain(
      'SECRET',
    );
  });
});
