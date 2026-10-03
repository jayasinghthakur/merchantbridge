import type {
  ApiKeyStore,
  Clock,
  ConnectionStore,
  ErrorCode,
  NewConnection,
  TenantKind,
  TenantRecord,
  TenantStore,
  UsageEvent,
  UsageStore,
} from '@mb/core';
import { ERROR_CODES } from '@mb/core';
import { StoreError } from './errors';
import { TENANT_KINDS, USAGE_STATUSES, ZOHO_PLANS } from './schema';

/*
 * Validation and normalization shared by the Postgres and in-memory stores, so both reject and reshape input
 * identically. Anything the database would reject is rejected here first with the same StoreError code.
 */

export interface TenantSeedStore extends TenantStore {
  /** Idempotent create with a caller-chosen id (fixed seed tenants such as the demo tenant). */
  ensure(input: { id: string; name: string; kind: TenantKind }): Promise<TenantRecord>;
}

export interface MbStores {
  tenants: TenantSeedStore;
  apiKeys: ApiKeyStore;
  connections: ConnectionStore;
  usage: UsageStore;
}

export interface StoreOptions {
  /** Source of every timestamp the stores write; inject a ManualClock in tests. */
  clock?: Clock;
}

/** Upper bound for `usage.recent()` so a caller cannot pull the whole table. */
export const MAX_RECENT_EVENTS = 1000;
/** Rows per multi-row INSERT in `usage.insertMany()`. */
export const INSERT_CHUNK_SIZE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INT32_MAX = 2_147_483_647;
/** SHA-256 hex digest, the only key form @mb/auth persists (`hashApiKey`). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
/** Display prefix length from the ApiKeyRecord contract (`mb_live_ab12`). */
export const API_KEY_PREFIX_MAX = 12;
/** Vault ciphertext shape from @mb/auth: `v<n>.<iv>.<tag>.<ct>`, each part base64url. */
const CIPHERTEXT_RE = /^v[1-9][0-9]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** ISO 8601 with an explicit offset; a bare local time would depend on the server's time zone. */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Unpaired UTF-16 surrogates. The Postgres drivers encode them as U+FFFD; jsonb rejects them outright. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = '\u0000';
/** U+FFFD, written as a code point so the source has no invisible characters. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Canonical (lower-case) uuid, or null if the string is not one. Postgres would throw on a bad uuid. */
export function normId(id: string): string | null {
  return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export function requireId(id: string, field: string): string {
  const n = normId(id);
  if (n === null) throw new StoreError('invalid_input', `${field} must be a uuid.`);
  return n;
}

/** Canonical (lower-case) SHA-256 hex, or null if the string is not one. */
export function normHash(hash: string): string | null {
  return typeof hash === 'string' && SHA256_HEX_RE.test(hash) ? hash.toLowerCase() : null;
}

export function toIso(value: Date | number): string {
  return new Date(value).toISOString();
}

export function parseInstant(value: string, field: string): Date {
  const m = typeof value === 'string' ? ISO_INSTANT_RE.exec(value) : null;
  const d = m ? new Date(value) : new Date(Number.NaN);
  // V8 rolls impossible dates over (Feb 30 → Mar 2); Postgres would reject them.
  const calendar = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (
    Number.isNaN(d.getTime()) ||
    !calendar ||
    calendar.getUTCMonth() !== Number(m?.[2]) - 1 ||
    calendar.getUTCDate() !== Number(m?.[3])
  ) {
    throw new StoreError('invalid_input', `${field} must be an ISO timestamp with an offset.`);
  }
  return d;
}

/** What Postgres stores for a JS string: lone surrogates become U+FFFD. */
function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE_RE, REPLACEMENT);
}

/** Text Postgres can store, or invalid_input. NUL is rejected (Postgres text cannot hold it). */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new StoreError('invalid_input', `${field} must be a string.`);
  if (value.includes(NUL))
    throw new StoreError('invalid_input', `${field} must not contain NUL characters.`);
  return wellFormed(value);
}

function optionalText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : requireText(value, field);
}

/**
 * Usage events carry attacker-chosen text (MCP clientInfo, raw tool-arg keys) and are written in shared batches,
 * so unstorable characters are replaced rather than rejected: one hostile call must not fail everyone's batch.
 */
function telemetryText(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new StoreError('invalid_input', `${field} must be a string.`);
  return wellFormed(value.replaceAll(NUL, REPLACEMENT));
}

function optionalTelemetryText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : telemetryText(value, field);
}

/** Recursively applies telemetryText to every key and string in a JSON value. */
function cleanJson(value: unknown): unknown {
  if (typeof value === 'string') return telemetryText(value, 'args_masked');
  if (Array.isArray(value)) return value.map(cleanJson);
  if (typeof value === 'object' && value !== null) {
    // fromEntries defines own properties, so a `__proto__` key stays a key (as in jsonb).
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [telemetryText(k, 'args_masked'), cleanJson(v)]),
    );
  }
  return value;
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  constraint: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new StoreError('check_violation', `${field} must be one of: ${allowed.join(', ')}.`, {
      constraint,
    });
  }
  return value as T;
}

function int32(value: unknown, field: string): number {
  // Rounded rather than rejected: these are measurements (ms, token estimates), not identifiers.
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n) || n < -INT32_MAX - 1 || n > INT32_MAX) {
    throw new StoreError('invalid_input', `${field} must be a 32-bit integer.`);
  }
  return n;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'args_masked must be a JSON object.');
  }
  // Same round trip jsonb applies: drops undefined, turns Dates into strings, copies the object.
  return cleanJson(JSON.parse(JSON.stringify(value))) as Record<string, unknown>;
}

function errorCode(value: unknown): ErrorCode | null {
  if (value === null || value === undefined) return null;
  if (!(ERROR_CODES as readonly unknown[]).includes(value)) {
    throw new StoreError('invalid_input', `error_code must be one of: ${ERROR_CODES.join(', ')}.`);
  }
  return value as ErrorCode;
}

export function normalizeTenantInput(input: { name: string; kind: TenantKind }): {
  name: string;
  kind: TenantKind;
} {
  return {
    name: requireText(input.name, 'name'),
    kind: requireOneOf(input.kind, TENANT_KINDS, 'kind', 'tenants_kind_check'),
  };
}

/**
 * The store is the last line before a secret hits disk: it only accepts a SHA-256 digest as the hash and a
 * display-length prefix, so a caller that passes the raw `mb_live_…` key gets invalid_input, not a stored key.
 * Messages never echo the rejected value.
 */
export function normalizeApiKeyInput(input: { tenantId: string; prefix: string; hash: string }): {
  tenantId: string;
  prefix: string;
  hash: string;
} {
  const tenantId = requireId(input.tenantId, 'tenantId');
  const hash = normHash(input.hash);
  if (hash === null) throw new StoreError('invalid_input', 'hash must be a SHA-256 hex digest.');
  const prefix = requireText(input.prefix, 'prefix');
  if (prefix === '' || prefix.length > API_KEY_PREFIX_MAX) {
    throw new StoreError(
      'invalid_input',
      `prefix must be 1-${API_KEY_PREFIX_MAX} characters (a display prefix, never the key).`,
    );
  }
  return { tenantId, prefix, hash };
}

export function normalizeNewConnection(input: NewConnection): NewConnection {
  if (!Array.isArray(input.scopes)) {
    throw new StoreError('invalid_input', 'scopes must be an array of strings.');
  }
  const refreshTokenEnc = requireText(input.refreshTokenEnc, 'refreshTokenEnc');
  if (!CIPHERTEXT_RE.test(refreshTokenEnc)) {
    // Shape check only (the store cannot decrypt): catches a plaintext Zoho token passed by mistake.
    throw new StoreError(
      'invalid_input',
      'refreshTokenEnc must be vault ciphertext (v1.<iv>.<tag>.<ct>).',
    );
  }
  return {
    tenantId: requireId(input.tenantId, 'tenantId'),
    provider: requireOneOf(input.provider, ['zoho_inventory'] as const, 'provider', 'provider'),
    dc: requireText(input.dc, 'dc'),
    accountsServer: requireText(input.accountsServer, 'accountsServer'),
    apiDomain: requireText(input.apiDomain, 'apiDomain'),
    organizationId: requireText(input.organizationId, 'organizationId'),
    organizationName: optionalText(input.organizationName, 'organizationName'),
    plan:
      input.plan === null || input.plan === undefined
        ? null
        : requireOneOf(input.plan, ZOHO_PLANS, 'plan', 'connections_plan_check'),
    scopes: input.scopes.map((s) => requireText(s, 'scopes[]')),
    refreshTokenEnc,
  };
}

/** Error codes recorded by markNeedsReconnect (e.g. `invalid_grant`). */
export function normalizeErrorCode(value: string): string {
  return requireText(value, 'errorCode');
}

/** Validates one event and returns it in the exact shape `usage.recent()` will return it. */
export function normalizeUsageEvent(e: UsageEvent): UsageEvent {
  return {
    ts: parseInstant(e.ts, 'ts').toISOString(),
    request_id: telemetryText(e.request_id, 'request_id'),
    tenant_id: requireId(e.tenant_id, 'tenant_id'),
    organization_id: optionalTelemetryText(e.organization_id, 'organization_id'),
    connector: telemetryText(e.connector, 'connector'),
    tool: telemetryText(e.tool, 'tool'),
    client_name: optionalTelemetryText(e.client_name, 'client_name'),
    demo: e.demo === true,
    status: requireOneOf(e.status, USAGE_STATUSES, 'status', 'usage_events_status_check'),
    error_code: errorCode(e.error_code),
    duration_ms: int32(e.duration_ms, 'duration_ms'),
    upstream_calls: int32(e.upstream_calls, 'upstream_calls'),
    cache_hits: int32(e.cache_hits, 'cache_hits'),
    retries: int32(e.retries, 'retries'),
    result_tokens: int32(e.result_tokens, 'result_tokens'),
    args_masked: jsonObject(e.args_masked),
  };
}

/** Clamps `recent()`'s limit to [0, MAX_RECENT_EVENTS]. */
export function clampLimit(limit: number): number {
  if (typeof limit !== 'number' || Number.isNaN(limit)) return 0;
  return Math.max(0, Math.min(MAX_RECENT_EVENTS, Math.floor(limit)));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
