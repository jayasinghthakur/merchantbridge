import type { Clock } from './clock';
import { systemClock } from './clock';

/**
 * Minimal key-value surface used by the governor, token cache, locks and rate limits. Deliberately limited to
 * commands that are cheap and supported everywhere (Upstash included): no Lua, no transactions. Production uses
 * a Redis implementation (apps/api); tests use MemoryKv with an injected clock.
 */
export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key already exists. */
  set(key: string, value: string, opts?: { ttlMs?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** INCR; when the key is new and ttlMs is given, also sets its expiry. */
  incr(key: string, ttlMs?: number): Promise<number>;
  /** Remaining TTL in ms; -1 if no expiry; -2 if missing. */
  pttl(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrem(key: string, member: string): Promise<void>;
  zremrangebyscore(key: string, min: number, max: number): Promise<void>;
  zcard(key: string): Promise<number>;
}

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryKv implements Kv {
  private readonly strings = new Map<string, Entry>();
  private readonly zsets = new Map<string, Map<string, number>>();

  constructor(private readonly clock: Clock = systemClock) {}

  private live(key: string): Entry | undefined {
    const e = this.strings.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= this.clock.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return e;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, opts: { ttlMs?: number; nx?: boolean } = {}): Promise<boolean> {
    if (opts.nx && this.live(key)) return Promise.resolve(false);
    const expiresAt = opts.ttlMs === undefined ? null : this.clock.now() + opts.ttlMs;
    this.strings.set(key, { value, expiresAt });
    return Promise.resolve(true);
  }

  del(key: string): Promise<void> {
    this.strings.delete(key);
    this.zsets.delete(key);
    return Promise.resolve();
  }

  incr(key: string, ttlMs?: number): Promise<number> {
    const e = this.live(key);
    const next = (e ? Number(e.value) : 0) + 1;
    const expiresAt = e
      ? e.expiresAt
      : ttlMs === undefined
        ? null
        : this.clock.now() + ttlMs;
    this.strings.set(key, { value: String(next), expiresAt });
    return Promise.resolve(next);
  }

  pttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return Promise.resolve(-2);
    if (e.expiresAt === null) return Promise.resolve(-1);
    return Promise.resolve(Math.max(0, e.expiresAt - this.clock.now()));
  }

  zadd(key: string, score: number, member: string): Promise<void> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    z.set(member, score);
    return Promise.resolve();
  }

  zrem(key: string, member: string): Promise<void> {
    this.zsets.get(key)?.delete(member);
    return Promise.resolve();
  }

  zremrangebyscore(key: string, min: number, max: number): Promise<void> {
    const z = this.zsets.get(key);
    if (z) for (const [m, s] of z) if (s >= min && s <= max) z.delete(m);
    return Promise.resolve();
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(this.zsets.get(key)?.size ?? 0);
  }
}
