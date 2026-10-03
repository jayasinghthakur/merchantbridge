import type {
  ApiKeyRecord,
  ApiKeyStore,
  ConnectionRecord,
  ConnectionStore,
  ErrorCode,
  NewConnection,
  TenantKind,
  TenantRecord,
  UsageEvent,
  UsageStore,
} from '@mb/core';
import { systemClock } from '@mb/core';
import { and, desc, eq, inArray, isNull, lt, ne } from 'drizzle-orm';
import type { MbDatabase } from './client';
import { StoreError, guard } from './errors';
import type { ApiKeyRow, ConnectionRow, TenantRow, UsageEventRow } from './schema';
import { apiKeys, connections, tenants, usageEvents } from './schema';
import type { MbStores, StoreOptions, TenantSeedStore } from './shared';
import {
  INSERT_CHUNK_SIZE,
  chunk,
  clampLimit,
  normHash,
  normId,
  normalizeApiKeyInput,
  normalizeErrorCode,
  normalizeNewConnection,
  normalizeTenantInput,
  normalizeUsageEvent,
  parseInstant,
  requireId,
  toIso,
} from './shared';

export interface DbStoreOptions extends StoreOptions {
  /** Rows deleted per statement by `usage.deleteOlderThan()`, to keep each delete short. */
  deleteBatchSize?: number;
}

const isoOrNull = (d: Date | null): string | null => (d === null ? null : toIso(d));

function toTenant(r: TenantRow): TenantRecord {
  return { id: r.id, name: r.name, kind: r.kind, createdAt: toIso(r.createdAt) };
}

function toApiKey(r: ApiKeyRow): ApiKeyRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    prefix: r.prefix,
    createdAt: toIso(r.createdAt),
    revokedAt: isoOrNull(r.revokedAt),
    lastUsedAt: isoOrNull(r.lastUsedAt),
  };
}

function toConnection(r: ConnectionRow): ConnectionRecord {
  return {
    id: r.id,
    tenantId: r.tenantId,
    provider: r.provider,
    dc: r.dc,
    accountsServer: r.accountsServer,
    apiDomain: r.apiDomain,
    organizationId: r.organizationId,
    organizationName: r.organizationName,
    plan: r.plan,
    scopes: r.scopes,
    refreshTokenEnc: r.refreshTokenEnc,
    status: r.status,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
    lastSuccessAt: isoOrNull(r.lastSuccessAt),
    lastErrorAt: isoOrNull(r.lastErrorAt),
    lastErrorCode: r.lastErrorCode,
  };
}

function toUsageEvent(r: UsageEventRow): UsageEvent {
  return {
    ts: toIso(r.ts),
    request_id: r.requestId,
    tenant_id: r.tenantId,
    organization_id: r.organizationId,
    connector: r.connector,
    tool: r.tool,
    client_name: r.clientName,
    demo: r.demo,
    status: r.status,
    // Written only from UsageEvent.error_code, so the column holds ErrorCode values.
    error_code: r.errorCode as ErrorCode | null,
    duration_ms: r.durationMs,
    upstream_calls: r.upstreamCalls,
    cache_hits: r.cacheHits,
    retries: r.retries,
    result_tokens: r.resultTokens,
    args_masked: r.argsMasked,
  };
}

function toUsageInsert(e: UsageEvent): typeof usageEvents.$inferInsert {
  return {
    ts: new Date(e.ts),
    requestId: e.request_id,
    tenantId: e.tenant_id,
    organizationId: e.organization_id,
    connector: e.connector,
    tool: e.tool,
    clientName: e.client_name,
    demo: e.demo,
    status: e.status,
    errorCode: e.error_code,
    durationMs: e.duration_ms,
    upstreamCalls: e.upstream_calls,
    cacheHits: e.cache_hits,
    retries: e.retries,
    resultTokens: e.result_tokens,
    argsMasked: e.args_masked,
  };
}

function first<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new StoreError('database_error', `${what} returned no row.`);
  return row;
}

/** Postgres-backed stores. Every query that has a tenant in its signature filters by it in the WHERE clause. */
export function createDbStores(db: MbDatabase, opts: DbStoreOptions = {}): MbStores {
  const clock = opts.clock ?? systemClock;
  const deleteBatchSize = Math.max(1, opts.deleteBatchSize ?? 5000);
  const now = () => new Date(clock.now());

  const tenantStore: TenantSeedStore = {
    create: (input) =>
      guard(async () => {
        const { name, kind } = normalizeTenantInput(input);
        const rows = await db.insert(tenants).values({ name, kind, createdAt: now() }).returning();
        return toTenant(first(rows, 'insert tenant'));
      }),

    get: (tenantId) =>
      guard(async () => {
        const id = normId(tenantId);
        if (id === null) return null;
        const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
        return rows[0] ? toTenant(rows[0]) : null;
      }),

    ensure: (input: { id: string; name: string; kind: TenantKind }) =>
      guard(async () => {
        const id = requireId(input.id, 'id');
        const { name, kind } = normalizeTenantInput(input);
        await db
          .insert(tenants)
          .values({ id, name, kind, createdAt: now() })
          .onConflictDoNothing({ target: tenants.id });
        const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
        return toTenant(first(rows, 'ensure tenant'));
      }),
  };

  const apiKeyStore: ApiKeyStore = {
    create: (input) =>
      guard(async () => {
        const { tenantId, prefix, hash } = normalizeApiKeyInput(input);
        const rows = await db
          .insert(apiKeys)
          .values({ tenantId, prefix, hash, createdAt: now() })
          .returning();
        return toApiKey(first(rows, 'insert api key'));
      }),

    findActiveByHash: (hash) =>
      guard(async () => {
        const h = normHash(hash);
        if (h === null) return null;
        const rows = await db
          .select()
          .from(apiKeys)
          .where(and(eq(apiKeys.hash, h), isNull(apiKeys.revokedAt)))
          .limit(1);
        return rows[0] ? toApiKey(rows[0]) : null;
      }),

    revoke: (tenantId, keyId) =>
      guard(async () => {
        const t = normId(tenantId);
        const k = normId(keyId);
        if (t === null || k === null) return;
        await db
          .update(apiKeys)
          .set({ revokedAt: now() })
          .where(and(eq(apiKeys.id, k), eq(apiKeys.tenantId, t), isNull(apiKeys.revokedAt)));
      }),

    touch: (keyId) =>
      guard(async () => {
        const k = normId(keyId);
        if (k === null) return;
        await db
          .update(apiKeys)
          .set({ lastUsedAt: now() })
          .where(and(eq(apiKeys.id, k), isNull(apiKeys.revokedAt)));
      }),
  };

  /** WHERE for a single connection, always pinned to its tenant. */
  function connectionWhere(tenantId: string, connectionId: string) {
    const t = normId(tenantId);
    const c = normId(connectionId);
    if (t === null || c === null) return null;
    return and(eq(connections.id, c), eq(connections.tenantId, t)) ?? null;
  }

  const connectionStore: ConnectionStore = {
    get: (tenantId, connectionId) =>
      guard(async () => {
        const where = connectionWhere(tenantId, connectionId);
        if (where === null) return null;
        const rows = await db.select().from(connections).where(where).limit(1);
        return rows[0] ? toConnection(rows[0]) : null;
      }),

    getActiveForTenant: (tenantId) =>
      guard(async () => {
        const t = normId(tenantId);
        if (t === null) return null;
        const rows = await db
          .select()
          .from(connections)
          .where(and(eq(connections.tenantId, t), eq(connections.status, 'active')))
          // Fully deterministic (id last) so the memory store can reproduce the same pick.
          .orderBy(desc(connections.updatedAt), desc(connections.createdAt), desc(connections.id))
          .limit(1);
        return rows[0] ? toConnection(rows[0]) : null;
      }),

    upsert: (input: NewConnection) =>
      guard(async () => {
        const c = normalizeNewConnection(input);
        const t = now();
        // Everything but id and createdAt is replaced: a reconnect starts with a clean status and history.
        const replaced = {
          dc: c.dc,
          accountsServer: c.accountsServer,
          apiDomain: c.apiDomain,
          organizationName: c.organizationName,
          plan: c.plan,
          scopes: c.scopes,
          refreshTokenEnc: c.refreshTokenEnc,
          status: 'active' as const,
          updatedAt: t,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
        };
        const rows = await db
          .insert(connections)
          .values({
            ...replaced,
            tenantId: c.tenantId,
            provider: c.provider,
            organizationId: c.organizationId,
            createdAt: t,
          })
          .onConflictDoUpdate({
            target: [connections.tenantId, connections.provider, connections.organizationId],
            set: replaced,
          })
          .returning();
        return toConnection(first(rows, 'upsert connection'));
      }),

    markNeedsReconnect: (tenantId, connectionId, errorCode) =>
      guard(async () => {
        const code = normalizeErrorCode(errorCode);
        const where = connectionWhere(tenantId, connectionId);
        if (where === null) return;
        const t = now();
        // Revoked is terminal; only a fresh upsert (reconnect) brings a connection back.
        await db
          .update(connections)
          .set({
            status: 'needs_reconnect',
            lastErrorAt: t,
            lastErrorCode: code,
            updatedAt: t,
          })
          .where(and(where, ne(connections.status, 'revoked')));
      }),

    markRevoked: (tenantId, connectionId) =>
      guard(async () => {
        const where = connectionWhere(tenantId, connectionId);
        if (where === null) return;
        await db
          .update(connections)
          .set({ status: 'revoked', updatedAt: now() })
          .where(and(where, ne(connections.status, 'revoked')));
      }),

    touchSuccess: (tenantId, connectionId) =>
      guard(async () => {
        const where = connectionWhere(tenantId, connectionId);
        if (where === null) return;
        await db.update(connections).set({ lastSuccessAt: now() }).where(where);
      }),
  };

  const usageStore: UsageStore = {
    insertMany: (events) =>
      guard(async () => {
        if (events.length === 0) return;
        // Validate everything first so a bad event fails the call before any row is written.
        const rows = events.map((e) => toUsageInsert(normalizeUsageEvent(e)));
        const batches = chunk(rows, INSERT_CHUNK_SIZE);
        if (batches.length === 1) {
          await db.insert(usageEvents).values(rows);
          return;
        }
        // Atomic across chunks, so a caller can retry a failed flush without duplicating rows.
        await db.transaction(async (tx) => {
          for (const batch of batches) await tx.insert(usageEvents).values(batch);
        });
      }),

    recent: (tenantId, limit) =>
      guard(async () => {
        const t = normId(tenantId);
        const n = clampLimit(limit);
        if (t === null || n === 0) return [];
        const rows = await db
          .select()
          .from(usageEvents)
          .where(eq(usageEvents.tenantId, t))
          .orderBy(desc(usageEvents.ts), desc(usageEvents.id))
          .limit(n);
        return rows.map(toUsageEvent);
      }),

    deleteOlderThan: (cutoffIso) =>
      guard(async () => {
        const cutoff = parseInstant(cutoffIso, 'cutoffIso');
        let total = 0;
        for (;;) {
          const batch = db
            .select({ id: usageEvents.id })
            .from(usageEvents)
            .where(lt(usageEvents.ts, cutoff))
            .limit(deleteBatchSize);
          const deleted = await db
            .delete(usageEvents)
            .where(inArray(usageEvents.id, batch))
            .returning({ id: usageEvents.id });
          total += deleted.length;
          if (deleted.length < deleteBatchSize) return total;
        }
      }),
  };

  return {
    tenants: tenantStore,
    apiKeys: apiKeyStore,
    connections: connectionStore,
    usage: usageStore,
  };
}
