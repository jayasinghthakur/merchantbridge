import { randomUUID } from 'node:crypto';
import type {
  ApiKeyRecord,
  ApiKeyStore,
  ConnectionRecord,
  ConnectionStore,
  TenantRecord,
  UsageEvent,
  UsageStore,
} from '@mb/core';
import { systemClock } from '@mb/core';
import { StoreError } from './errors';
import type { MbStores, StoreOptions, TenantSeedStore } from './shared';
import {
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

/** Runs synchronously but reports through a promise, so a throw becomes a rejection like the DB store's. */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

interface StoredKey {
  record: ApiKeyRecord;
  hash: string;
}

interface StoredEvent {
  event: UsageEvent;
  tsMs: number;
  seq: number;
}

const copyConnection = (r: ConnectionRecord): ConnectionRecord => ({ ...r, scopes: [...r.scopes] });

/**
 * getActiveForTenant's ORDER BY updated_at DESC, created_at DESC, id DESC. ISO strings from toIso() and
 * lower-case uuids sort lexically the way Postgres sorts timestamptz and uuid.
 */
function newerConnection(a: ConnectionRecord, b: ConnectionRecord): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * In-memory stores for local dev without Postgres and for other packages' tests. Same semantics as
 * createDbStores (verified by the shared contract suite): uuid ids, FK and uniqueness checks, revoked keys
 * invisible, tenant-scoped lookups, ISO timestamps, newest-first usage.
 */
export function createMemoryStores(opts: StoreOptions = {}): MbStores {
  const clock = opts.clock ?? systemClock;
  const nowIso = () => toIso(clock.now());
  let seq = 0;

  const tenantRows = new Map<string, TenantRecord>();
  const keyRows = new Map<string, StoredKey>();
  const keyIdByHash = new Map<string, string>();
  const connectionRows = new Map<string, ConnectionRecord>();
  let eventRows: StoredEvent[] = [];

  function requireTenant(tenantId: string, constraint: string): void {
    if (!tenantRows.has(tenantId)) {
      throw new StoreError('foreign_key_violation', `tenant ${tenantId} does not exist.`, {
        constraint,
      });
    }
  }

  function findConnection(tenantId: string, connectionId: string): ConnectionRecord | null {
    const t = normId(tenantId);
    const c = normId(connectionId);
    if (t === null || c === null) return null;
    const row = connectionRows.get(c);
    return row && row.tenantId === t ? row : null;
  }

  const tenants: TenantSeedStore = {
    create: (input) =>
      run(() => {
        const { name, kind } = normalizeTenantInput(input);
        const record: TenantRecord = { id: randomUUID(), name, kind, createdAt: nowIso() };
        tenantRows.set(record.id, record);
        return { ...record };
      }),

    get: (tenantId) =>
      run(() => {
        const id = normId(tenantId);
        const row = id === null ? undefined : tenantRows.get(id);
        return row ? { ...row } : null;
      }),

    ensure: (input) =>
      run(() => {
        const id = requireId(input.id, 'id');
        const { name, kind } = normalizeTenantInput(input);
        let row = tenantRows.get(id);
        if (!row) {
          row = { id, name, kind, createdAt: nowIso() };
          tenantRows.set(id, row);
        }
        return { ...row };
      }),
  };

  const apiKeys: ApiKeyStore = {
    create: (input) =>
      run(() => {
        const { tenantId, prefix, hash } = normalizeApiKeyInput(input);
        if (keyIdByHash.has(hash)) {
          throw new StoreError('unique_violation', 'api key hash already exists.', {
            constraint: 'api_keys_hash_unique',
          });
        }
        requireTenant(tenantId, 'api_keys_tenant_id_tenants_id_fk');
        const record: ApiKeyRecord = {
          id: randomUUID(),
          tenantId,
          prefix,
          createdAt: nowIso(),
          revokedAt: null,
          lastUsedAt: null,
        };
        keyRows.set(record.id, { record, hash });
        keyIdByHash.set(hash, record.id);
        return { ...record };
      }),

    findActiveByHash: (hash) =>
      run(() => {
        const h = normHash(hash);
        const id = h === null ? undefined : keyIdByHash.get(h);
        const row = id === undefined ? undefined : keyRows.get(id);
        return row && row.record.revokedAt === null ? { ...row.record } : null;
      }),

    revoke: (tenantId, keyId) =>
      run(() => {
        const t = normId(tenantId);
        const k = normId(keyId);
        if (t === null || k === null) return;
        const row = keyRows.get(k);
        if (row && row.record.tenantId === t && row.record.revokedAt === null) {
          row.record.revokedAt = nowIso();
        }
      }),

    touch: (keyId) =>
      run(() => {
        const k = normId(keyId);
        const row = k === null ? undefined : keyRows.get(k);
        if (row && row.record.revokedAt === null) row.record.lastUsedAt = nowIso();
      }),
  };

  const connections: ConnectionStore = {
    get: (tenantId, connectionId) =>
      run(() => {
        const row = findConnection(tenantId, connectionId);
        return row ? copyConnection(row) : null;
      }),

    getActiveForTenant: (tenantId) =>
      run(() => {
        const t = normId(tenantId);
        if (t === null) return null;
        let best: ConnectionRecord | null = null;
        for (const row of connectionRows.values()) {
          if (row.tenantId !== t || row.status !== 'active') continue;
          if (best === null || newerConnection(row, best)) best = row;
        }
        return best ? copyConnection(best) : null;
      }),

    upsert: (input) =>
      run(() => {
        const c = normalizeNewConnection(input);
        requireTenant(c.tenantId, 'connections_tenant_id_tenants_id_fk');
        const t = nowIso();
        let existing: ConnectionRecord | undefined;
        for (const r of connectionRows.values()) {
          if (
            r.tenantId === c.tenantId &&
            r.provider === c.provider &&
            r.organizationId === c.organizationId
          ) {
            existing = r;
            break;
          }
        }
        const record: ConnectionRecord = {
          ...c,
          id: existing?.id ?? randomUUID(),
          createdAt: existing?.createdAt ?? t,
          status: 'active',
          updatedAt: t,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
        };
        connectionRows.set(record.id, record);
        return copyConnection(record);
      }),

    markNeedsReconnect: (tenantId, connectionId, errorCode) =>
      run(() => {
        const code = normalizeErrorCode(errorCode);
        const row = findConnection(tenantId, connectionId);
        if (!row || row.status === 'revoked') return;
        const t = nowIso();
        Object.assign(row, {
          status: 'needs_reconnect',
          lastErrorAt: t,
          lastErrorCode: code,
          updatedAt: t,
        });
      }),

    markRevoked: (tenantId, connectionId) =>
      run(() => {
        const row = findConnection(tenantId, connectionId);
        if (!row || row.status === 'revoked') return;
        Object.assign(row, { status: 'revoked', updatedAt: nowIso() });
      }),

    touchSuccess: (tenantId, connectionId) =>
      run(() => {
        const row = findConnection(tenantId, connectionId);
        if (row) row.lastSuccessAt = nowIso();
      }),
  };

  const usage: UsageStore = {
    insertMany: (events) =>
      run(() => {
        const normalized = events.map(normalizeUsageEvent);
        for (const event of normalized) {
          eventRows.push({ event, tsMs: Date.parse(event.ts), seq: ++seq });
        }
      }),

    recent: (tenantId, limit) =>
      run(() => {
        const t = normId(tenantId);
        const n = clampLimit(limit);
        if (t === null || n === 0) return [];
        return eventRows
          .filter((r) => r.event.tenant_id === t)
          .sort((a, b) => b.tsMs - a.tsMs || b.seq - a.seq)
          .slice(0, n)
          .map((r) => structuredClone(r.event));
      }),

    deleteOlderThan: (cutoffIso) =>
      run(() => {
        const cutoff = parseInstant(cutoffIso, 'cutoffIso').getTime();
        const before = eventRows.length;
        eventRows = eventRows.filter((r) => r.tsMs >= cutoff);
        return before - eventRows.length;
      }),
  };

  return { tenants, apiKeys, connections, usage };
}
