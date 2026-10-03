import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey, verifyInviteCode } from '../src/index';

describe('API keys', () => {
  it('generates mb_live_ + 32 base62 chars with a 12-char prefix and sha256 hash', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^mb_live_[0-9A-Za-z]{32}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(prefix.startsWith('mb_live_')).toBe(true);
    expect(hash).toBe(createHash('sha256').update(key).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(hash);
  });

  it('is random and uses the whole alphabet', () => {
    const keys = Array.from({ length: 500 }, () => generateApiKey().key);
    expect(new Set(keys).size).toBe(keys.length);
    const chars = new Set(keys.flatMap((k) => [...k.slice(8)]));
    expect(chars.size).toBe(62);
  });

  it('looksLikeApiKey checks the exact shape', () => {
    expect(looksLikeApiKey(generateApiKey().key)).toBe(true);
    for (const v of [
      'mb_live_short',
      `mb_test_${'a'.repeat(32)}`,
      `mb_live_${'a'.repeat(31)}!`,
      `mb_live_${'a'.repeat(33)}`,
      ` mb_live_${'a'.repeat(32)}`,
      undefined,
      null,
      42,
    ]) {
      expect(looksLikeApiKey(v)).toBe(false);
    }
  });
});

describe('verifyInviteCode', () => {
  it('matches only the exact code', () => {
    expect(verifyInviteCode('chai-2026', 'chai-2026')).toBe(true);
    expect(verifyInviteCode('chai-2025', 'chai-2026')).toBe(false);
    expect(verifyInviteCode('chai-2026 ', 'chai-2026')).toBe(false);
    expect(verifyInviteCode('chai', 'chai-2026')).toBe(false);
  });

  it('is always false when no invite code is configured or none is given', () => {
    expect(verifyInviteCode('', '')).toBe(false);
    expect(verifyInviteCode('anything', '')).toBe(false);
    expect(verifyInviteCode('anything', undefined)).toBe(false);
    expect(verifyInviteCode(undefined, 'chai-2026')).toBe(false);
    expect(verifyInviteCode(null, 'chai-2026')).toBe(false);
    expect(verifyInviteCode('', 'chai-2026')).toBe(false);
  });
});
