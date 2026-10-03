import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenVault } from '../src/index';
import { VAULT_KEY } from './fakes';

const FORMAT = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Changes the lowest bit of the last char: for a part with unused trailing bits, the decoded bytes stay equal. */
function flipUnusedBit(part: string): string {
  const last = B64URL.indexOf(part.at(-1) ?? '');
  return `${part.slice(0, -1)}${B64URL[last ^ 1]}`;
}

describe('token vault (AES-256-GCM)', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const vault = createTokenVault(VAULT_KEY);
    for (const plain of ['1000.refresh.token', '', 'ünïcødé ✓']) {
      const ct = vault.encrypt(plain);
      expect(ct).toMatch(FORMAT);
      if (plain) expect(ct).not.toContain(plain);
      expect(vault.decrypt(ct)).toBe(plain);
    }
    expect(vault.encrypt('same')).not.toBe(vault.encrypt('same'));
  });

  it('throws on tampering of any part', () => {
    const vault = createTokenVault(VAULT_KEY);
    const ct = vault.encrypt('1000.refresh.token');
    const parts = ct.split('.');
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i] as string;
      const flipped = [...parts];
      flipped[i] = `${p[0] === 'A' ? 'B' : 'A'}${p.slice(1)}`;
      expect(() => vault.decrypt(flipped.join('.'))).toThrow(/tampered/);
    }
    expect(() => vault.decrypt(ct.replace(/^v1/, 'v2'))).toThrow();
    expect(() => vault.decrypt(ct.split('.').slice(0, 3).join('.'))).toThrow();
    expect(() => vault.decrypt('garbage')).toThrow();
  });

  it('throws when only the unused low bits of a part are changed (non-canonical base64url)', () => {
    const vault = createTokenVault(VAULT_KEY);
    // 1-byte plaintext → 2-char ciphertext part with 4 unused bits; the 16-byte tag also ends in 4 unused bits.
    const ct = vault.encrypt('x');
    const [v, iv, tag, body] = ct.split('.') as [string, string, string, string];
    for (const forged of [
      [v, iv, flipUnusedBit(tag), body].join('.'),
      [v, iv, tag, flipUnusedBit(body)].join('.'),
    ]) {
      expect(forged).not.toBe(ct);
      expect(() => vault.decrypt(forged)).toThrow(/tampered/);
    }
    expect(vault.decrypt(ct)).toBe('x');
  });

  it('cannot decrypt with another key', () => {
    const ct = createTokenVault(VAULT_KEY).encrypt('secret');
    expect(() => createTokenVault(randomBytes(32).toString('base64')).decrypt(ct)).toThrow();
  });

  it('rejects keys that are not exactly 32 bytes, without echoing them', () => {
    for (const n of [0, 16, 31, 33, 64]) {
      const key = randomBytes(n).toString('base64');
      let message = '';
      try {
        createTokenVault(key);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/32 bytes/);
      if (key) expect(message).not.toContain(key);
    }
    expect(() => createTokenVault('this is not base64 at all, but long enough!!')).toThrow();
  });

  it('accepts base64url keys', () => {
    const vault = createTokenVault(randomBytes(32).toString('base64url'));
    expect(vault.decrypt(vault.encrypt('x'))).toBe('x');
  });
});
