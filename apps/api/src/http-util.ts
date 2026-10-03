import { isIP } from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse } from '@mb/core';
import type { ClientIpSource } from './config';

declare module 'fastify' {
  interface FastifyRequest {
    /** Caller IP resolved once per request by buildApp's onRequest hook (see `resolveClientIp`). */
    mbClientIp: string;
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function socketIp(request: FastifyRequest): string {
  return request.raw.socket?.remoteAddress ?? request.ip;
}

/**
 * Caller IP for rate limits, Turnstile and IP-derived demo sessions. Fastify runs with `trustProxy: false`, so
 * nothing here trusts a header the client can set unless the deployment says a proxy overwrites it:
 *
 * - `socket` (default off Fly): the TCP peer. A client-sent X-Forwarded-For is ignored, so it cannot rotate
 *   its rate-limit bucket.
 * - `fly-client-ip` (default when FLY_APP_NAME is set): Fly's edge proxy sets `Fly-Client-IP` to the address it
 *   accepted the connection from. UNVERIFIED that Fly overwrites a client-supplied value (Fly documents the header
 *   as proxy-set); probe once in prod with `curl -H 'Fly-Client-IP: 192.0.2.1'` against /mcp/demo 61 times from
 *   one host — the 61st must still be 429. Missing or invalid values fall back to the socket address.
 * - `xff-last`: for a generic single reverse proxy that appends the peer to X-Forwarded-For; the RIGHT-most entry
 *   is the one that proxy wrote (left-most entries are client-controlled).
 */
export function resolveClientIp(request: FastifyRequest, source: ClientIpSource): string {
  if (source === 'fly-client-ip') {
    const v = singleHeader(request.headers['fly-client-ip']);
    if (v && isIP(v) !== 0) return v;
  } else if (source === 'xff-last') {
    const v = singleHeader(request.headers['x-forwarded-for'])?.split(',').at(-1)?.trim();
    if (v && isIP(v) !== 0) return v;
  }
  return socketIp(request);
}

/** The resolved caller IP (raw, for Turnstile `remoteip` and the egress CIDR match). */
export function clientIp(request: FastifyRequest): string {
  return request.mbClientIp || socketIp(request);
}

/** Parses a valid IPv6 literal into its 8 16-bit groups (embedded IPv4 tails included). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? '';
  if (isIP(s) !== 6) return null;
  let v4: number[] = [];
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const o = (tail[2] ?? '').split('.').map(Number) as [number, number, number, number];
    v4 = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    const head = tail[1] ?? '';
    s = head.endsWith('::') ? head : head.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - v4.length - left.length - right.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [
    ...left,
    ...Array<string>(halves.length === 2 ? fill : 0).fill('0'),
    ...right,
  ].map((h) => Number.parseInt(h, 16));
  const all = [...groups, ...v4];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? all
    : null;
}

/**
 * Rate-limit bucket for an IP. IPv4 as is; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as the IPv4 address; other IPv6
 * by /64, because a single host or VPS usually controls a whole /64 and could otherwise rotate source addresses
 * to get a fresh bucket per request.
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) === 4) return ip;
  const g = ipv6Groups(ip);
  if (!g) return ip;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  return `${[g0, g1, g2, g3].map((x) => x.toString(16)).join(':')}::/64`;
}

/** Bucketed caller IP for rate-limit keys and IP-derived demo sessions. */
export function clientIpKey(request: FastifyRequest): string {
  return ipBucket(clientIp(request));
}

/**
 * Routes that hijack the reply write `reply.raw` themselves, so headers set on the Fastify reply by hooks
 * (CORS, security headers) must be copied onto the raw response first.
 */
export function copyReplyHeadersToRaw(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) continue;
    reply.raw.setHeader(name, Array.isArray(value) ? value : String(value));
  }
}

export function sendRateLimited(
  reply: FastifyReply,
  retryAfterS: number,
  message: string,
): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterS))
    .send({
      error: { code: 'RATE_LIMITED', message, retry_after_s: retryAfterS },
    } satisfies ApiErrorResponse);
}
