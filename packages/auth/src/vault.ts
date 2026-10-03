import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for refresh tokens (at rest in Postgres) and cached access tokens (in Redis).
 * Format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version prefix leaves room for key rotation.
 */
export interface TokenVault {
  encrypt(plain: string): string;
  /** Throws on any malformed, truncated or tampered input. */
  decrypt(ciphertext: string): string;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL = /^[A-Za-z0-9_-]*$/;
const B64_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/;

function parseKey(base64Key: string): Buffer {
  const key = B64_KEY.test(base64Key) ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    // Never echo the key material.
    throw new Error(
      'Token vault key must be base64 encoding exactly 32 bytes (openssl rand -base64 32).',
    );
  }
  return key;
}

function rejected(): Error {
  return new Error('Token vault: ciphertext is malformed or was tampered with.');
}

/** Decodes only the canonical encoding, so a part whose unused trailing bits were changed is rejected. */
function decodePart(part: string): Buffer {
  if (!B64URL.test(part)) throw rejected();
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw rejected();
  return bytes;
}

export function createTokenVault(base64Key: string): TokenVault {
  const key = parseKey(base64Key);

  return {
    encrypt(plain: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, ...[iv, tag, ct].map((b) => b.toString('base64url'))].join('.');
    },

    decrypt(ciphertext: string): string {
      const parts = ciphertext.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw rejected();
      const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
      const iv = decodePart(ivB64);
      const tag = decodePart(tagB64);
      const ct = decodePart(ctB64);
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw rejected();
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        throw rejected();
      }
    },
  };
}
