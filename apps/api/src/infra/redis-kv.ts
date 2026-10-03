import { Redis } from 'ioredis';
import type { Kv } from '@mb/core';

/**
 * Kv over Redis (Upstash in production). Plain commands only — no Lua or MULTI — so it runs on any Redis-compatible
 * service. Each method is a single round trip except incr-with-TTL (INCR then PEXPIRE when the key is new).
 */
export class RedisKv implements Kv {
  constructor(private readonly redis: Redis) {}

  static fromUrl(url: string): RedisKv {
    const redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableAutoPipelining: true,
      lazyConnect: false,
    });
    return new RedisKv(redis);
  }

  get client(): Redis {
    return this.redis;
  }

  get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, opts: { ttlMs?: number; nx?: boolean } = {}): Promise<boolean> {
    let res: string | null;
    if (opts.ttlMs !== undefined && opts.nx) res = await this.redis.set(key, value, 'PX', opts.ttlMs, 'NX');
    else if (opts.ttlMs !== undefined) res = await this.redis.set(key, value, 'PX', opts.ttlMs);
    else if (opts.nx) res = await this.redis.set(key, value, 'NX');
    else res = await this.redis.set(key, value);
    return res === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1 && ttlMs !== undefined) await this.redis.pexpire(key, ttlMs);
    return n;
  }

  pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.redis.zadd(key, score, member);
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.redis.zrem(key, member);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<void> {
    await this.redis.zremrangebyscore(key, min, max);
  }

  zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}
