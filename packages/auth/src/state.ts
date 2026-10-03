import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock, Kv } from '@mb/core';
import { z } from 'zod';
import type { ZohoDcKey } from './dc';
import { ZOHO_DC_KEYS } from './dc';

/**
 * OAuth `state`: an HMAC-SHA256-signed, expiring, single-use token. It carries the DC the merchant picked so the
 * callback can check Zoho's `accounts-server` against it, and optionally the tenant being re-connected.
 */
export interface StatePayload {
  dc: ZohoDcKey;
  tenantId?: string;
  purpose: 'connect';
}

export interface VerifiedState extends StatePayload {
  /** Epoch ms after which the state is no longer accepted. */
  expiresAt: number;
}

export type StateError = 'malformed' | 'bad_signature' | 'expired' | 'replayed';

export type StateVerification =
  { ok: true; payload: VerifiedState } | { ok: false; error: StateError };

export interface StateSigner {
  /** Opaque, URL-safe string to pass as the OAuth `state` param. */
  sign(payload: StatePayload): string;
  /** Verifies MAC and expiry, then consumes the nonce (SET NX) so a second use is rejected as `replayed`. */
  verifyAndConsume(state: string): Promise<StateVerification>;
}

export interface StateSignerOptions {
  /** At least 32 bytes; from a server-side secret (never shipped to the browser). */
  secret: string;
  kv: Kv;
  clock: Clock;
  /** Default 10 minutes. */
  ttlMs?: number;
}

export const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const MAX_STATE_LENGTH = 1024;
const MAC_BYTES = 32;
const NONCE_BYTES = 16;
/** Domain separation in case the same secret is (wrongly) reused for another MAC. */
const MAC_CONTEXT = 'mb.oauth-state.v1.';
const B64URL = /^[A-Za-z0-9_-]+$/;

const bodySchema = z.object({
  v: z.literal(1),
  p: z.literal('connect'),
  dc: z.enum(ZOHO_DC_KEYS),
  tid: z.string().min(1).max(128).optional(),
  n: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  exp: z.number().int().positive(),
});

type StateBody = z.output<typeof bodySchema>;

export function stateNonceKey(nonce: string): string {
  return `oauth:state:${nonce}`;
}

export function createStateSigner(opts: StateSignerOptions): StateSigner {
  if (Buffer.byteLength(opts.secret, 'utf8') < 32) {
    throw new Error('OAuth state secret must be at least 32 bytes.');
  }
  const ttlMs = opts.ttlMs ?? DEFAULT_STATE_TTL_MS;
  const { kv, clock } = opts;

  const mac = (encodedBody: string): Buffer =>
    createHmac('sha256', opts.secret).update(MAC_CONTEXT).update(encodedBody).digest();

  function sign(payload: StatePayload): string {
    const body: StateBody = {
      v: 1,
      p: payload.purpose,
      dc: payload.dc,
      ...(payload.tenantId === undefined ? {} : { tid: payload.tenantId }),
      n: randomBytes(NONCE_BYTES).toString('base64url'),
      exp: clock.now() + ttlMs,
    };
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new Error('Invalid OAuth state payload.');
    const encoded = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
    return `${encoded}.${mac(encoded).toString('base64url')}`;
  }

  async function verifyAndConsume(state: string): Promise<StateVerification> {
    if (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE_LENGTH) {
      return { ok: false, error: 'malformed' };
    }
    const parts = state.split('.');
    if (parts.length !== 2) return { ok: false, error: 'malformed' };
    const [encoded, macB64] = parts as [string, string];
    if (!B64URL.test(encoded) || !B64URL.test(macB64)) return { ok: false, error: 'malformed' };

    const provided = Buffer.from(macB64, 'base64url');
    if (provided.length !== MAC_BYTES) return { ok: false, error: 'bad_signature' };
    // Only the canonical encoding is ours; a re-encoding with different unused trailing bits is a tamper.
    if (provided.toString('base64url') !== macB64) return { ok: false, error: 'bad_signature' };
    if (!timingSafeEqual(provided, mac(encoded))) return { ok: false, error: 'bad_signature' };

    // Only parse attacker-supplied JSON after the MAC proves we produced it.
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, error: 'malformed' };
    }
    const body = bodySchema.safeParse(json);
    if (!body.success) return { ok: false, error: 'malformed' };

    const remainingMs = body.data.exp - clock.now();
    if (remainingMs <= 0) return { ok: false, error: 'expired' };

    // The nonce key only needs to outlive the state itself; after `exp` the expiry check rejects it anyway.
    const fresh = await kv.set(stateNonceKey(body.data.n), '1', {
      nx: true,
      ttlMs: remainingMs + 1000,
    });
    if (!fresh) return { ok: false, error: 'replayed' };

    return {
      ok: true,
      payload: {
        dc: body.data.dc,
        ...(body.data.tid === undefined ? {} : { tenantId: body.data.tid }),
        purpose: body.data.p,
        expiresAt: body.data.exp,
      },
    };
  }

  return { sign, verifyAndConsume };
}
