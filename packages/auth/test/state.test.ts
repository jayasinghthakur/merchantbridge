import { ManualClock, MemoryKv } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createStateSigner } from '../src/index';
import { STATE_SECRET } from './fakes';

function setup() {
  const clock = new ManualClock();
  const kv = new MemoryKv(clock);
  const signer = createStateSigner({ secret: STATE_SECRET, kv, clock });
  return { clock, kv, signer };
}

/** Flips one base64url character at `index` of `s` to a different valid one. */
function flip(s: string, index: number): string {
  const c = s[index] === 'A' ? 'B' : 'A';
  return `${s.slice(0, index)}${c}${s.slice(index + 1)}`;
}

describe('OAuth state signer', () => {
  it('round-trips the payload once', async () => {
    const { clock, signer } = setup();
    const state = signer.sign({ dc: 'in', tenantId: 'tenant_a', purpose: 'connect' });
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const out = await signer.verifyAndConsume(state);
    expect(out).toEqual({
      ok: true,
      payload: {
        dc: 'in',
        tenantId: 'tenant_a',
        purpose: 'connect',
        expiresAt: clock.now() + 10 * 60_000,
      },
    });
  });

  it('omits tenantId when not given and uses a fresh nonce per state', async () => {
    const { signer } = setup();
    const a = signer.sign({ dc: 'eu', purpose: 'connect' });
    const b = signer.sign({ dc: 'eu', purpose: 'connect' });
    expect(a).not.toBe(b);
    const out = await signer.verifyAndConsume(a);
    expect(out.ok && out.payload).toEqual(
      expect.objectContaining({ dc: 'eu', purpose: 'connect' }),
    );
    expect(out.ok && 'tenantId' in out.payload).toBe(false);
  });

  it('rejects a replayed state', async () => {
    const { signer } = setup();
    const state = signer.sign({ dc: 'in', purpose: 'connect' });
    expect((await signer.verifyAndConsume(state)).ok).toBe(true);
    expect(await signer.verifyAndConsume(state)).toEqual({ ok: false, error: 'replayed' });
  });

  it('rejects an expired state (11 minutes later)', async () => {
    const { clock, signer } = setup();
    const state = signer.sign({ dc: 'in', purpose: 'connect' });
    clock.advance(11 * 60_000);
    expect(await signer.verifyAndConsume(state)).toEqual({ ok: false, error: 'expired' });
  });

  it('accepts a state just before expiry', async () => {
    const { clock, signer } = setup();
    const state = signer.sign({ dc: 'in', purpose: 'connect' });
    clock.advance(10 * 60_000 - 1);
    expect((await signer.verifyAndConsume(state)).ok).toBe(true);
  });

  it('rejects tampered body or MAC without consuming the genuine state', async () => {
    const { signer } = setup();
    const state = signer.sign({ dc: 'in', purpose: 'connect' });
    const [body, mac] = state.split('.') as [string, string];
    expect(await signer.verifyAndConsume(`${flip(body, 3)}.${mac}`)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    expect(await signer.verifyAndConsume(`${body}.${flip(mac, 5)}`)).toEqual({
      ok: false,
      error: 'bad_signature',
    });

    // A body re-encoded with a different DC keeps its old MAC → rejected.
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...decoded, dc: 'us' })).toString('base64url');
    expect(await signer.verifyAndConsume(`${forged}.${mac}`)).toEqual({
      ok: false,
      error: 'bad_signature',
    });

    expect((await signer.verifyAndConsume(state)).ok).toBe(true);
  });

  it('rejects a MAC re-encoded with different unused trailing bits, without consuming the state', async () => {
    const { signer } = setup();
    const state = signer.sign({ dc: 'in', purpose: 'connect' });
    const [body, mac] = state.split('.') as [string, string];
    // 32-byte MAC → 43 chars whose last char carries 2 unused bits.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(mac.at(-1) ?? '');
    const forgedMac = `${mac.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(forgedMac, 'base64url')).toEqual(Buffer.from(mac, 'base64url'));
    expect(await signer.verifyAndConsume(`${body}.${forgedMac}`)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
    expect((await signer.verifyAndConsume(state)).ok).toBe(true);
  });

  it('rejects a state signed with another secret', async () => {
    const { kv, clock, signer } = setup();
    const other = createStateSigner({ secret: `${STATE_SECRET}-other`, kv, clock });
    const state = other.sign({ dc: 'in', purpose: 'connect' });
    expect(await signer.verifyAndConsume(state)).toEqual({ ok: false, error: 'bad_signature' });
  });

  it.each(['', 'abc', 'a.b.c', 'not base64!.xx', `${'a'.repeat(2000)}.b`])(
    'rejects malformed %#',
    async (s) => {
      const { signer } = setup();
      const out = await signer.verifyAndConsume(s);
      expect(out.ok).toBe(false);
    },
  );

  it('rejects secrets shorter than 32 bytes', () => {
    const clock = new ManualClock();
    expect(() => createStateSigner({ secret: 'short', kv: new MemoryKv(clock), clock })).toThrow(
      /32 bytes/,
    );
  });
});
