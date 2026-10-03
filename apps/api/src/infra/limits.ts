import { BlockList, isIP } from 'node:net';
import type { Clock, Kv } from '@mb/core';

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterS: number;
}

/** Fixed-window counter over Kv (one INCR per check). Good enough for abuse protection, not for billing. */
export async function hitWindow(
  kv: Kv,
  clock: Clock,
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  const window = Math.floor(clock.now() / windowMs);
  const count = await kv.incr(`lim:${key}:${window}`, windowMs + 1_000);
  const retryAfterS = Math.max(1, Math.ceil(((window + 1) * windowMs - clock.now()) / 1000));
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterS };
}

/**
 * Reads a `hitWindow` counter without incrementing it (one GET): for limits that only count failures, checked
 * before the expensive work they protect.
 */
export async function peekWindow(
  kv: Kv,
  clock: Clock,
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  const window = Math.floor(clock.now() / windowMs);
  const raw = await kv.get(`lim:${key}:${window}`);
  const count = raw === null ? 0 : Number(raw) || 0;
  const retryAfterS = Math.max(1, Math.ceil(((window + 1) * windowMs - clock.now()) / 1000));
  return { allowed: count < limit, remaining: Math.max(0, limit - count), retryAfterS };
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Trusted egress ranges (e.g. Anthropic's MCP connector IPs) share a larger /mcp/demo bucket instead of per-IP. */
export function createEgressMatcher(cidrs: string[]): (ip: string) => boolean {
  if (cidrs.length === 0) return () => false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [addr, bits] = cidr.split('/');
    const family = isIP(addr ?? '');
    if (!addr || !bits || family === 0) continue;
    list.addSubnet(addr, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
  }
  return (raw) => {
    // A dual-stack socket reports IPv4 peers as `::ffff:a.b.c.d`; match those against the IPv4 ranges.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
    const ip = mapped?.[1] ?? raw;
    const family = isIP(ip);
    if (family === 0) return false;
    return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}
