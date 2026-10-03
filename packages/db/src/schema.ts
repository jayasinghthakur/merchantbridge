import type { ConnectionStatus, TenantKind, UsageEvent, ZohoPlan } from '@mb/core';
import type { SQLWrapper } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Only type imports from @mb/core here: drizzle-kit loads this file on its own to diff the schema, so it must
 * not pull workspace source at runtime. The tuples below are checked against the core types with `satisfies`
 * (and for exhaustiveness in test/postgres.test.ts).
 */
export const TENANT_KINDS = ['live', 'demo'] as const satisfies readonly TenantKind[];
export const CONNECTION_STATUSES = [
  'active',
  'needs_reconnect',
  'revoked',
] as const satisfies readonly ConnectionStatus[];
export const ZOHO_PLANS = [
  'free',
  'standard',
  'professional',
  'premium',
  'enterprise',
] as const satisfies readonly ZohoPlan[];
export const USAGE_STATUSES = ['ok', 'error'] as const satisfies readonly UsageEvent['status'][];

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

function oneOf(column: SQLWrapper, values: readonly string[]) {
  // Values are compile-time constants above, never user input.
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind', { enum: TENANT_KINDS }).notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [check('tenants_kind_check', oneOf(t.kind, TENANT_KINDS))],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key; the key itself is never stored. */
    hash: text('hash').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    lastUsedAt: tstz('last_used_at'),
  },
  (t) => [unique('api_keys_hash_unique').on(t.hash), index('api_keys_tenant_idx').on(t.tenantId)],
);

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['zoho_inventory'] }).notNull(),
    dc: text('dc').notNull(),
    accountsServer: text('accounts_server').notNull(),
    apiDomain: text('api_domain').notNull(),
    organizationId: text('organization_id').notNull(),
    organizationName: text('organization_name'),
    plan: text('plan', { enum: ZOHO_PLANS }),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** AES-256-GCM ciphertext from @mb/auth; never the plaintext refresh token. */
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    status: text('status', { enum: CONNECTION_STATUSES }).notNull().default('active'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
    lastSuccessAt: tstz('last_success_at'),
    lastErrorAt: tstz('last_error_at'),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    unique('connections_tenant_provider_org_unique').on(t.tenantId, t.provider, t.organizationId),
    check('connections_status_check', oneOf(t.status, CONNECTION_STATUSES)),
    check('connections_plan_check', oneOf(t.plan, ZOHO_PLANS)),
  ],
);

/**
 * Append-only audit trail, one row per tool call. No FK to tenants on purpose: batched inserts must never fail
 * because a tenant row is missing or was deleted, and retention is managed by `ts`, not by tenant lifecycle.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: tstz('ts').notNull(),
    requestId: text('request_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: text('organization_id'),
    connector: text('connector').notNull(),
    tool: text('tool').notNull(),
    clientName: text('client_name'),
    demo: boolean('demo').notNull(),
    status: text('status', { enum: USAGE_STATUSES }).notNull(),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms').notNull(),
    upstreamCalls: integer('upstream_calls').notNull(),
    cacheHits: integer('cache_hits').notNull(),
    retries: integer('retries').notNull(),
    resultTokens: integer('result_tokens').notNull(),
    argsMasked: jsonb('args_masked')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    // Matches recent()'s `ORDER BY ts DESC, id DESC` exactly (DESC defaults to NULLS FIRST), so the
    // newest-N read is an index range scan with no sort step.
    index('usage_events_tenant_ts_idx').on(
      t.tenantId,
      t.ts.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('usage_events_ts_idx').on(t.ts),
    check('usage_events_status_check', oneOf(t.status, USAGE_STATUSES)),
  ],
);

export type TenantRow = typeof tenants.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
