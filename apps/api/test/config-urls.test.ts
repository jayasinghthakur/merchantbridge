import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeConnectionUrl } from '../src/config';

const PG =
  'postgresql://owner:npg_secret@ep-x-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const REDIS = 'rediss://default:AbCdSecret@crisp-cat-12345.upstash.io:6379';

describe('normalizeConnectionUrl', () => {
  it('passes clean URLs through', () => {
    expect(normalizeConnectionUrl(PG, 'postgres')).toEqual({ ok: true, value: PG });
    expect(normalizeConnectionUrl(REDIS, 'redis')).toEqual({ ok: true, value: REDIS });
    expect(normalizeConnectionUrl(undefined, 'redis')).toEqual({ ok: true, value: undefined });
  });

  it("extracts the URL from a pasted redis-cli command and keeps TLS ('--tls' → rediss://)", () => {
    const pasted = 'redis-cli --tls -u redis://default:AbCdSecret@crisp-cat-12345.upstash.io:6379';
    expect(normalizeConnectionUrl(pasted, 'redis')).toEqual({ ok: true, value: REDIS });
  });

  it('extracts the URL from a quoted psql command', () => {
    expect(normalizeConnectionUrl(`psql '${PG}'`, 'postgres')).toEqual({ ok: true, value: PG });
    expect(normalizeConnectionUrl(`"${REDIS}"`, 'redis')).toEqual({ ok: true, value: REDIS });
  });

  it('rejects the Upstash REST URL and other non-URLs with a helpful reason', () => {
    const rest = normalizeConnectionUrl('https://crisp-cat-12345.upstash.io', 'redis');
    expect(rest.ok).toBe(false);
    expect(rest.ok ? '' : rest.reason).toMatch(/rediss:\/\//);
    expect(normalizeConnectionUrl('not a url', 'postgres').ok).toBe(false);
  });
});

describe('loadConfig connection URLs', () => {
  it('normalizes a pasted redis-cli command in REDIS_URL', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: PG,
      REDIS_URL: 'redis-cli --tls -u redis://default:AbCdSecret@crisp-cat-12345.upstash.io:6379',
    });
    expect(cfg.env.REDIS_URL).toBe(REDIS);
  });

  it('names the bad variable without echoing its value', () => {
    let message = '';
    try {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: PG,
        REDIS_URL: 'https://x.upstash.io?token=SECRETVALUE',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('REDIS_URL');
    expect(message).not.toContain('SECRETVALUE');
  });
});
