import type { ZohoPlan } from './governor';
import type { UsageEvent } from './telemetry';

/**
 * Persistence contracts. Implemented by @mb/db (Postgres/PGlite) and by in-memory versions for local dev/tests.
 * Every method is tenant-scoped: implementations must filter by tenantId in the query itself.
 */

export type TenantKind = 'live' | 'demo';

export interface TenantRecord {
  id: string;
  name: string;
  kind: TenantKind;
  createdAt: string;
}

export interface TenantStore {
  create(input: { name: string; kind: TenantKind }): Promise<TenantRecord>;
  get(tenantId: string): Promise<TenantRecord | null>;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  /** First 12 chars of the key (e.g. `mb_live_ab12`) for display; never the full key. */
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface ApiKeyStore {
  /** Stores only the SHA-256 hash of the key. */
  create(input: { tenantId: string; prefix: string; hash: string }): Promise<ApiKeyRecord>;
  /** Lookup for bearer auth; returns null for unknown or revoked keys. */
  findActiveByHash(hash: string): Promise<ApiKeyRecord | null>;
  revoke(tenantId: string, keyId: string): Promise<void>;
  touch(keyId: string): Promise<void>;
}

export type ConnectionStatus = 'active' | 'needs_reconnect' | 'revoked';

export interface ConnectionRecord {
  id: string;
  tenantId: string;
  provider: 'zoho_inventory';
  /** Zoho data-center key from serverinfo, e.g. `in`, `us`, `eu`. */
  dc: string;
  /** e.g. `https://accounts.zoho.in` — validated against the known Zoho host allow-list. */
  accountsServer: string;
  /** e.g. `https://www.zohoapis.in` — from the token response `api_domain`. */
  apiDomain: string;
  organizationId: string;
  organizationName: string | null;
  plan: ZohoPlan | null;
  scopes: string[];
  /** AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ct>`); never the plaintext refresh token. */
  refreshTokenEnc: string;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
}

export type NewConnection = Omit<
  ConnectionRecord,
  'id' | 'createdAt' | 'updatedAt' | 'lastSuccessAt' | 'lastErrorAt' | 'lastErrorCode' | 'status'
>;

export interface ConnectionStore {
  get(tenantId: string, connectionId: string): Promise<ConnectionRecord | null>;
  getActiveForTenant(tenantId: string): Promise<ConnectionRecord | null>;
  /** Replaces any existing connection for the same tenant + provider + organization. */
  upsert(input: NewConnection): Promise<ConnectionRecord>;
  markNeedsReconnect(tenantId: string, connectionId: string, errorCode: string): Promise<void>;
  markRevoked(tenantId: string, connectionId: string): Promise<void>;
  touchSuccess(tenantId: string, connectionId: string): Promise<void>;
}

export interface UsageStore {
  insertMany(events: UsageEvent[]): Promise<void>;
  recent(tenantId: string, limit: number): Promise<UsageEvent[]>;
  /** Retention job: deletes events older than the cutoff; returns rows deleted. */
  deleteOlderThan(cutoffIso: string): Promise<number>;
}
