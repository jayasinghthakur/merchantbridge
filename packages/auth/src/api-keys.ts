import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Agent → MerchantBridge bearer keys. The full key is shown to the merchant once; only its SHA-256 hash and a
 * 12-char display prefix are stored (ApiKeyStore). High-entropy random keys make a plain hash sufficient.
 */
export const API_KEY_PREFIX = 'mb_live_';
const BODY_LENGTH = 32;
const DISPLAY_PREFIX_LENGTH = 12;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 62 below 256; bytes at or above it are rejected so every character is uniform. */
const UNBIASED_LIMIT = 248;
const API_KEY_RE = /^mb_live_[0-9A-Za-z]{32}$/;

export interface GeneratedApiKey {
  /** `mb_live_` + 32 base62 chars. Show once; never store or log. */
  key: string;
  /** First 12 chars, for display (e.g. `mb_live_ab12`). */
  prefix: string;
  /** SHA-256 hex of the key; the only form persisted. */
  hash: string;
}

function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < UNBIASED_LIMIT) out += ALPHABET[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBase62(BODY_LENGTH)}`;
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

/** Cheap shape check before hashing/looking up a bearer token. */
export function looksLikeApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_RE.test(value);
}

/**
 * Timing-safe invite-code check. Comparing fixed-length digests avoids leaking the expected code's length.
 * An unset/empty expected code disables connect entirely (always false).
 */
export function verifyInviteCode(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
