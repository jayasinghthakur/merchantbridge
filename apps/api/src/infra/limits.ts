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
  return (ip) => {
    const family = isIP(ip);
    if (family === 0) return false;
    return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}
