import { DrizzleQueryError } from 'drizzle-orm';

export type StoreErrorCode =
  | 'unique_violation'
  | 'foreign_key_violation'
  | 'check_violation'
  | 'invalid_input'
  | 'database_error';

export interface StoreErrorOptions {
  constraint?: string;
  sqlState?: string;
  retryable?: boolean;
}

/**
 * The only error the stores throw, from both the Postgres and the in-memory implementation. It never carries
 * query parameters or the driver error (Drizzle puts every bound param, e.g. key hashes and token ciphertext,
 * into its error message), so it is safe to log.
 */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** Constraint name for violations, e.g. `api_keys_hash_unique`. */
  readonly constraint: string | undefined;
  /** Postgres SQLSTATE, only when the error came from the database server. */
  readonly sqlState: string | undefined;
  /**
   * True for transient failures (lost connection, serialization failure, deadlock, server restart) where the
   * same call may succeed later. Constraint and input errors are never retryable.
   */
  readonly retryable: boolean;

  constructor(code: StoreErrorCode, message: string, opts: StoreErrorOptions = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.constraint = opts.constraint;
    this.sqlState = opts.sqlState;
    this.retryable = opts.retryable ?? false;
  }
}

export function isStoreError(e: unknown): e is StoreError {
  return e instanceof StoreError;
}

const SQLSTATE_CODES: Record<string, StoreErrorCode> = {
  '23505': 'unique_violation',
  '23503': 'foreign_key_violation',
  '23514': 'check_violation',
  '23502': 'invalid_input', // not_null_violation
  '22P02': 'invalid_input', // invalid_text_representation (e.g. bad uuid)
  '22003': 'invalid_input', // numeric_value_out_of_range
  '22007': 'invalid_input', // invalid_datetime_format
  '22008': 'invalid_input', // datetime_field_overflow
  '22021': 'invalid_input', // character_not_in_repertoire (NUL in text)
  '22P05': 'invalid_input', // untranslatable_character (\u0000 in jsonb)
};

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** SQLSTATEs where retrying the same statement can succeed. Class 08 (connection exception) is added below. */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** postgres.js connection errors and Node socket errors (they also use `code`, but it is not a SQLSTATE). */
const TRANSIENT_DRIVER_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
]);

function stringField(obj: object, key: string): string | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Converts a driver/Drizzle error into a param-free StoreError. postgres.js and PGlite name fields differently;
 * both set `severity` on errors sent by the server, which is how a SQLSTATE is told apart from a socket code.
 */
export function toStoreError(e: unknown): StoreError {
  if (isStoreError(e)) return e;
  const driver = e instanceof DrizzleQueryError && e.cause ? e.cause : e;
  if (!(driver instanceof Error))
    return new StoreError('database_error', 'Database operation failed.');

  const rawCode = stringField(driver, 'code');
  const fromServer = stringField(driver, 'severity') !== undefined;
  const sqlState =
    fromServer && rawCode !== undefined && SQLSTATE_RE.test(rawCode) ? rawCode : undefined;
  const constraint = stringField(driver, 'constraint_name') ?? stringField(driver, 'constraint');
  const code = (sqlState === undefined ? undefined : SQLSTATE_CODES[sqlState]) ?? 'database_error';
  const retryable =
    sqlState !== undefined
      ? sqlState.startsWith('08') || TRANSIENT_SQLSTATES.has(sqlState)
      : rawCode !== undefined && TRANSIENT_DRIVER_CODES.has(rawCode);
  // A DrizzleQueryError without a driver cause still has params in its message; never surface it.
  const message =
    driver instanceof DrizzleQueryError
      ? 'Database query failed.'
      : driver.message || 'Database error.';
  return new StoreError(code, sqlState ? `${sqlState}: ${message}` : message, {
    retryable,
    ...(constraint === undefined ? {} : { constraint }),
    ...(sqlState === undefined ? {} : { sqlState }),
  });
}

/** Runs a store operation and rethrows any failure as a StoreError. */
export async function guard<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw toStoreError(e);
  }
}
