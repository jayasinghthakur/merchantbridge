import { createHash } from 'node:crypto';
import type { NewConnection, UsageEvent } from '@mb/core';
import { ManualClock } from '@mb/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MbStores } from '../src/index';
import { DEMO_TENANT_ID, MAX_RECENT_EVENTS, StoreError, ensureDemoTenant } from '../src/index';

/** U+FFFD REPLACEMENT CHARACTER, what Postgres stores for an unencodable code unit. */
const FFFD = String.fromCharCode(0xfffd);
/** SHA-256 hex, the only key form @mb/auth persists (hashApiKey). */
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * One behavioural contract for every store implementation. `fresh()` must return stores over empty state that
 * take their timestamps from `clock`.
 */
export interface StoreTarget {
  setup(): Promise<void>;
  fresh(clock: ManualClock): Promise<MbStores>;
  teardown(): Promise<void>;
}

const MISSING_ID = '11111111-1111-4111-8111-111111111111';

function newConnection(tenantId: string, overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    tenantId,
    provider: 'zoho_inventory',
    dc: 'in',
    accountsServer: 'https://accounts.zoho.in',
    apiDomain: 'https://www.zohoapis.in',
    organizationId: '60012345678',
    organizationName: 'Chai & Co',
    plan: 'free',
    scopes: ['ZohoInventory.items.READ', 'ZohoInventory.salesorders.READ'],
    refreshTokenEnc: 'v1.iv.tag.ciphertext-1',
    ...overrides,
  };
}

function usageEvent(tenantId: string, ts: number, i: number): UsageEvent {
  return {
    ts: new Date(ts).toISOString(),
    request_id: `req_${i}`,
    tenant_id: tenantId,
    organization_id: i % 2 === 0 ? '60012345678' : null,
    connector: 'zoho_inventory',
    tool: 'zoho_get_item',
    client_name: i % 3 === 0 ? 'claude-code' : null,
    demo: false,
    status: i % 5 === 0 ? 'error' : 'ok',
    error_code: i % 5 === 0 ? 'RATE_LIMITED' : null,
    duration_ms: 10 + i,
    upstream_calls: 1,
    cache_hits: 0,
    retries: i % 5 === 0 ? 2 : 0,
    result_tokens: 120,
    args_masked: { sku: 'CHAI-250', limit: 20, q: '<text:12>' },
  };
}

async function expectStoreError(
  p: Promise<unknown>,
  code: StoreError['code'],
): Promise<StoreError> {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StoreError);
  expect((err as StoreError).code).toBe(code);
  return err as StoreError;
}

export function runStoreContract(name: string, target: StoreTarget): void {
  describe(`store contract: ${name}`, () => {
    let clock: ManualClock;
    let s: MbStores;

    beforeAll(() => target.setup(), 60_000);
    afterAll(() => target.teardown());
    beforeEach(async () => {
      clock = new ManualClock();
      s = await target.fresh(clock);
    });

    describe('tenants', () => {
      it('creates and gets a tenant with an ISO createdAt from the clock', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        expect(t).toEqual({
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          name: 'Acme',
          kind: 'live',
          createdAt: new Date(clock.now()).toISOString(),
        });
        expect(await s.tenants.get(t.id)).toEqual(t);
        expect(await s.tenants.get(t.id.toUpperCase())).toEqual(t);
      });

      it('returns null for unknown or malformed ids and rejects an unknown kind', async () => {
        expect(await s.tenants.get(MISSING_ID)).toBeNull();
        expect(await s.tenants.get('not-a-uuid')).toBeNull();
        await expectStoreError(
          s.tenants.create({ name: 'x', kind: 'staging' as never }),
          'check_violation',
        );
      });

      it('ensure is idempotent and ensureDemoTenant seeds the fixed demo tenant', async () => {
        const first = await ensureDemoTenant(s);
        clock.advance(60_000);
        const again = await ensureDemoTenant(s);
        expect(again).toEqual(first);
        expect(first.id).toBe(DEMO_TENANT_ID);
        expect(first.kind).toBe('demo');
        expect(await s.tenants.get(DEMO_TENANT_ID)).toEqual(first);
      });

      it('ensureDemoTenant refuses to bind public routes to a live tenant under the demo id', async () => {
        await s.tenants.ensure({ id: DEMO_TENANT_ID, name: 'Real merchant', kind: 'live' });
        await expect(ensureDemoTenant(s)).rejects.toThrow(/not a demo tenant/);
        expect((await s.tenants.get(DEMO_TENANT_ID))?.kind).toBe('live');
      });

      it('rejects NUL in text and stores lone surrogates as U+FFFD, like Postgres', async () => {
        await expectStoreError(
          s.tenants.create({ name: 'Acme\u0000', kind: 'live' }),
          'invalid_input',
        );
        // A lone surrogate cannot be encoded as UTF-8; the Postgres drivers write U+FFFD instead.
        const t = await s.tenants.create({ name: 'Chai \ud800 & Co 🍵', kind: 'live' });
        expect(t.name).toBe(`Chai ${FFFD} & Co 🍵`);
        expect((await s.tenants.get(t.id))?.name).toBe(`Chai ${FFFD} & Co 🍵`);
      });
    });

    describe('api keys', () => {
      it('create → findActiveByHash → touch → revoke → not found', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const key = await s.apiKeys.create({
          tenantId: t.id,
          prefix: 'mb_live_ab12',
          hash: sha('k1'),
        });
        expect(key).toEqual({
          id: expect.any(String),
          tenantId: t.id,
          prefix: 'mb_live_ab12',
          createdAt: new Date(clock.now()).toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        });
        expect(key).not.toHaveProperty('hash');
        expect(await s.apiKeys.findActiveByHash(sha('k1'))).toEqual(key);
        expect(await s.apiKeys.findActiveByHash(sha('k1').toUpperCase())).toEqual(key);
        expect(await s.apiKeys.findActiveByHash(sha('k2'))).toBeNull();
        expect(await s.apiKeys.findActiveByHash('')).toBeNull();

        clock.advance(5_000);
        await s.apiKeys.touch(key.id);
        expect((await s.apiKeys.findActiveByHash(sha('k1')))?.lastUsedAt).toBe(
          new Date(clock.now()).toISOString(),
        );

        await s.apiKeys.revoke(t.id, key.id);
        expect(await s.apiKeys.findActiveByHash(sha('k1'))).toBeNull();
        // Revoking twice and touching a revoked key are harmless no-ops.
        await s.apiKeys.revoke(t.id, key.id);
        await s.apiKeys.touch(key.id);
        expect(await s.apiKeys.findActiveByHash(sha('k1'))).toBeNull();
      });

      it('enforces unique hashes (even after revoke), the tenant FK and uuid ids', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const secret = sha('secret');
        const key = await s.apiKeys.create({
          tenantId: t.id,
          prefix: 'mb_live_ab12',
          hash: secret,
        });
        const dup = await expectStoreError(
          s.apiKeys.create({ tenantId: t.id, prefix: 'mb_live_cd34', hash: secret }),
          'unique_violation',
        );
        expect(dup.constraint).toBe('api_keys_hash_unique');
        expect(dup.message).not.toContain(secret);

        await s.apiKeys.revoke(t.id, key.id);
        // Same digest in upper case is the same key.
        await expectStoreError(
          s.apiKeys.create({ tenantId: t.id, prefix: 'mb_live_cd34', hash: secret.toUpperCase() }),
          'unique_violation',
        );

        const fk = await expectStoreError(
          s.apiKeys.create({ tenantId: MISSING_ID, prefix: 'mb_live_x', hash: sha('fk') }),
          'foreign_key_violation',
        );
        expect(fk.constraint).toBe('api_keys_tenant_id_tenants_id_fk');
        await expectStoreError(
          s.apiKeys.create({ tenantId: 'tenant-a', prefix: 'mb_live_x', hash: sha('bad') }),
          'invalid_input',
        );
        // Malformed ids on lookups and updates are "not found", never a database error.
        await s.apiKeys.revoke('nope', 'nope');
        await s.apiKeys.touch('nope');
      });

      it('refuses to persist a plaintext key or refresh token in place of hash / ciphertext', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const rawKey = `mb_live_${'A1b2C3d4'.repeat(4)}`;
        // The full bearer key passed as the hash (caller forgot to hash it).
        const asHash = await expectStoreError(
          s.apiKeys.create({ tenantId: t.id, prefix: 'mb_live_A1b2', hash: rawKey }),
          'invalid_input',
        );
        expect(asHash.message).not.toContain(rawKey);
        // The full key passed as the display prefix.
        const asPrefix = await expectStoreError(
          s.apiKeys.create({ tenantId: t.id, prefix: rawKey, hash: sha(rawKey) }),
          'invalid_input',
        );
        expect(asPrefix.message).not.toContain(rawKey);
        expect(await s.apiKeys.findActiveByHash(rawKey)).toBeNull();

        // A Zoho refresh token (`1000.<hex>.<hex>`) instead of vault ciphertext (`v1.<iv>.<tag>.<ct>`).
        const zohoRefresh =
          '1000.0f1e2d3c4b5a69788796a5b4c3d2e1f0.00112233445566778899aabbccddeeff';
        const plain = await expectStoreError(
          s.connections.upsert(newConnection(t.id, { refreshTokenEnc: zohoRefresh })),
          'invalid_input',
        );
        expect(plain.message).not.toContain(zohoRefresh);
        expect(await s.connections.getActiveForTenant(t.id)).toBeNull();
      });
    });

    describe('connections', () => {
      it('upsert replaces the row for the same tenant + provider + organization', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const created = await s.connections.upsert(newConnection(t.id));
        const createdAt = new Date(clock.now()).toISOString();
        expect(created).toEqual({
          ...newConnection(t.id),
          id: expect.any(String),
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
        });
        expect(await s.connections.get(t.id, created.id)).toEqual(created);

        clock.advance(1_000);
        await s.connections.touchSuccess(t.id, created.id);
        await s.connections.markNeedsReconnect(t.id, created.id, 'invalid_grant');

        clock.advance(1_000);
        const replaced = await s.connections.upsert(
          newConnection(t.id, {
            refreshTokenEnc: 'v1.iv.tag.ciphertext-2',
            plan: 'standard',
            organizationName: null,
            scopes: ['ZohoInventory.items.READ'],
          }),
        );
        expect(replaced).toEqual({
          ...newConnection(t.id),
          refreshTokenEnc: 'v1.iv.tag.ciphertext-2',
          plan: 'standard',
          organizationName: null,
          scopes: ['ZohoInventory.items.READ'],
          id: created.id,
          status: 'active',
          createdAt,
          updatedAt: new Date(clock.now()).toISOString(),
          lastSuccessAt: null,
          lastErrorAt: null,
          lastErrorCode: null,
        });

        clock.advance(1_000);
        const otherOrg = await s.connections.upsert(
          newConnection(t.id, { organizationId: '60099999999' }),
        );
        expect(otherOrg.id).not.toBe(created.id);
        expect((await s.connections.getActiveForTenant(t.id))?.id).toBe(otherOrg.id);
      });

      it('markNeedsReconnect / touchSuccess / markRevoked update status and timestamps', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const c = await s.connections.upsert(newConnection(t.id));
        expect((await s.connections.getActiveForTenant(t.id))?.id).toBe(c.id);

        clock.advance(1_000);
        await s.connections.touchSuccess(t.id, c.id);
        const touched = await s.connections.get(t.id, c.id);
        expect(touched?.lastSuccessAt).toBe(new Date(clock.now()).toISOString());
        expect(touched?.updatedAt).toBe(c.updatedAt);

        clock.advance(1_000);
        await s.connections.markNeedsReconnect(t.id, c.id, 'invalid_grant');
        const broken = await s.connections.get(t.id, c.id);
        expect(broken).toMatchObject({
          status: 'needs_reconnect',
          lastErrorCode: 'invalid_grant',
          lastErrorAt: new Date(clock.now()).toISOString(),
          updatedAt: new Date(clock.now()).toISOString(),
          lastSuccessAt: touched?.lastSuccessAt,
        });
        expect(await s.connections.getActiveForTenant(t.id)).toBeNull();

        clock.advance(1_000);
        await s.connections.markRevoked(t.id, c.id);
        const revoked = await s.connections.get(t.id, c.id);
        expect(revoked).toMatchObject({
          status: 'revoked',
          updatedAt: new Date(clock.now()).toISOString(),
        });

        // Revoked is terminal: a later failure does not resurrect it as needs_reconnect.
        clock.advance(1_000);
        await s.connections.markNeedsReconnect(t.id, c.id, 'later_error');
        await s.connections.markRevoked(t.id, c.id);
        expect(await s.connections.get(t.id, c.id)).toEqual(revoked);
        expect(await s.connections.getActiveForTenant(t.id)).toBeNull();
      });

      it('rejects connections for unknown tenants and invalid plans', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const fk = await expectStoreError(
          s.connections.upsert(newConnection(MISSING_ID)),
          'foreign_key_violation',
        );
        expect(fk.constraint).toBe('connections_tenant_id_tenants_id_fk');
        await expectStoreError(
          s.connections.upsert(newConnection(t.id, { plan: 'gold' as never })),
          'check_violation',
        );
        await expectStoreError(s.connections.upsert(newConnection('t-1')), 'invalid_input');
        expect(await s.connections.get('t-1', 'c-1')).toBeNull();
        expect(await s.connections.getActiveForTenant('t-1')).toBeNull();
      });

      it('rejects NUL bytes in connection text the same way in every store', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        await expectStoreError(
          s.connections.upsert(newConnection(t.id, { organizationName: 'Chai\u0000' })),
          'invalid_input',
        );
        await expectStoreError(
          s.connections.upsert(newConnection(t.id, { scopes: ['ZohoInventory.items.READ\u0000'] })),
          'invalid_input',
        );
        const c = await s.connections.upsert(newConnection(t.id));
        await expectStoreError(
          s.connections.markNeedsReconnect(t.id, c.id, 'invalid_grant\u0000'),
          'invalid_input',
        );
        expect((await s.connections.get(t.id, c.id))?.status).toBe('active');
      });

      it('getActiveForTenant breaks updatedAt ties identically (createdAt, then id)', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const a = await s.connections.upsert(newConnection(t.id, { organizationId: 'A' }));
        clock.advance(1_000);
        const b = await s.connections.upsert(newConnection(t.id, { organizationId: 'B' }));
        clock.advance(1_000);
        // Same millisecond: both rows now share updatedAt; B was created later.
        await s.connections.upsert(newConnection(t.id, { organizationId: 'B' }));
        await s.connections.upsert(newConnection(t.id, { organizationId: 'A' }));
        expect((await s.connections.getActiveForTenant(t.id))?.id).toBe(b.id);
        expect(a.id).not.toBe(b.id);

        // Full tie on both timestamps: the larger id wins.
        const u = await s.tenants.create({ name: 'Tie', kind: 'live' });
        const x = await s.connections.upsert(newConnection(u.id, { organizationId: 'X' }));
        const y = await s.connections.upsert(newConnection(u.id, { organizationId: 'Y' }));
        await s.connections.upsert(newConnection(u.id, { organizationId: 'X' }));
        const larger = x.id > y.id ? x.id : y.id;
        expect((await s.connections.getActiveForTenant(u.id))?.id).toBe(larger);
      });
    });

    describe('tenant isolation', () => {
      it("tenant B can neither read nor change tenant A's rows", async () => {
        const a = await s.tenants.create({ name: 'A', kind: 'live' });
        const b = await s.tenants.create({ name: 'B', kind: 'live' });
        const conn = await s.connections.upsert(newConnection(a.id));
        const key = await s.apiKeys.create({
          tenantId: a.id,
          prefix: 'mb_live_aaaa',
          hash: sha('ka'),
        });
        await s.usage.insertMany([usageEvent(a.id, clock.now(), 1)]);

        expect(await s.connections.get(b.id, conn.id)).toBeNull();
        expect(await s.connections.getActiveForTenant(b.id)).toBeNull();
        expect(await s.usage.recent(b.id, 10)).toEqual([]);

        clock.advance(1_000);
        await s.connections.markNeedsReconnect(b.id, conn.id, 'x');
        await s.connections.markRevoked(b.id, conn.id);
        await s.connections.touchSuccess(b.id, conn.id);
        await s.apiKeys.revoke(b.id, key.id);

        expect(await s.connections.get(a.id, conn.id)).toEqual(conn);
        expect(await s.apiKeys.findActiveByHash(sha('ka'))).toEqual(key);
        expect(await s.usage.recent(a.id, 10)).toHaveLength(1);
      });
    });

    describe('usage', () => {
      it('inserts 1200 events, returns them newest first, and deletes by cutoff', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const other = await s.tenants.create({ name: 'Other', kind: 'live' });
        const base = clock.now();
        const events = Array.from({ length: 1200 }, (_, i) =>
          usageEvent(t.id, base + i * 1_000, i),
        );
        await s.usage.insertMany(events);
        await s.usage.insertMany([usageEvent(other.id, base, 0)]);

        const top = await s.usage.recent(t.id, 5);
        expect(top).toEqual(events.slice(-5).reverse());

        const capped = await s.usage.recent(t.id, 5_000);
        expect(capped).toHaveLength(MAX_RECENT_EVENTS);
        for (let i = 1; i < capped.length; i++) {
          expect(Date.parse(capped[i - 1]!.ts)).toBeGreaterThan(Date.parse(capped[i]!.ts));
        }
        expect(capped.every((e) => e.tenant_id === t.id)).toBe(true);
        expect(await s.usage.recent(t.id, 0)).toEqual([]);
        expect(await s.usage.recent(t.id, -3)).toEqual([]);

        // Deletes strictly older than the cutoff, across all tenants.
        const cutoff = new Date(base + 1_000 * 1_000).toISOString();
        expect(await s.usage.deleteOlderThan(cutoff)).toBe(1_000 + 1);
        const left = await s.usage.recent(t.id, 1_000);
        expect(left).toHaveLength(200);
        expect(left.at(-1)?.ts).toBe(cutoff);
        expect(await s.usage.recent(other.id, 10)).toEqual([]);
        expect(await s.usage.deleteOlderThan(cutoff)).toBe(0);
      });

      it('round-trips every field and breaks ts ties by insertion order', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const ts = clock.now();
        const first = usageEvent(t.id, ts, 3);
        const second = { ...usageEvent(t.id, ts, 4), tenant_id: t.id.toUpperCase() };
        await s.usage.insertMany([first]);
        await s.usage.insertMany([second]);
        expect(await s.usage.recent(t.id, 10)).toEqual([{ ...second, tenant_id: t.id }, first]);

        // Normalisation: offsets become UTC ISO, measurements become integers.
        await s.usage.insertMany([
          { ...usageEvent(t.id, ts, 5), ts: '2026-10-03T15:00:00.000+05:30', duration_ms: 12.6 },
        ]);
        const [norm] = await s.usage.recent(t.id, 10);
        expect(norm?.ts).toBe('2026-10-03T09:30:00.000Z');
        expect(norm?.duration_ms).toBe(13);
        expect(await s.usage.recent(t.id, 10)).toHaveLength(3);
      });

      it('validates the whole batch before writing anything', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const good = usageEvent(t.id, clock.now(), 1);
        await expectStoreError(
          s.usage.insertMany([good, { ...good, tenant_id: 'demo:session-1' }]),
          'invalid_input',
        );
        await expectStoreError(
          s.usage.insertMany([good, { ...good, status: 'maybe' as never }]),
          'check_violation',
        );
        await expectStoreError(s.usage.insertMany([{ ...good, ts: 'yesterday' }]), 'invalid_input');
        await expectStoreError(s.usage.deleteOlderThan('not a date'), 'invalid_input');
        expect(await s.usage.recent(t.id, 10)).toEqual([]);
        await s.usage.insertMany([]);
      });

      it('accepts only ISO timestamps with an explicit offset (no server-timezone guessing)', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const good = usageEvent(t.id, clock.now(), 1);
        // Offset-less: would be read in the server's local zone (IST on a laptop, UTC on Fly).
        await expectStoreError(
          s.usage.insertMany([{ ...good, ts: '2026-10-03T00:00:00' }]),
          'invalid_input',
        );
        await expectStoreError(s.usage.deleteOlderThan('2026-10-03T00:00:00'), 'invalid_input');
        // Non-ISO strings that V8 still parses ('1' is 2001-01-01; Feb 30 rolls into March).
        await expectStoreError(s.usage.deleteOlderThan('1'), 'invalid_input');
        await expectStoreError(s.usage.deleteOlderThan('Oct 3, 2026'), 'invalid_input');
        await expectStoreError(
          s.usage.insertMany([{ ...good, ts: '2026-02-30T09:00:00.000Z' }]),
          'invalid_input',
        );
        expect(await s.usage.deleteOlderThan('2026-10-03T09:00:00Z')).toBe(0);
        await s.usage.insertMany([{ ...good, ts: '2026-10-03T09:00:00.123456Z' }]);
        expect((await s.usage.recent(t.id, 1))[0]?.ts).toBe('2026-10-03T09:00:00.123Z');
      });

      it('rejects an error_code that is not a core ErrorCode', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const good = usageEvent(t.id, clock.now(), 5);
        await expectStoreError(
          s.usage.insertMany([{ ...good, error_code: 'invalid_grant' as never }]),
          'invalid_input',
        );
        expect(await s.usage.recent(t.id, 10)).toEqual([]);
      });

      it('one event with hostile client text (NUL, lone surrogates) cannot fail the batch', async () => {
        const a = await s.tenants.create({ name: 'A', kind: 'live' });
        const b = await s.tenants.create({ name: 'B', kind: 'demo' });
        const ts = clock.now();
        // client_name comes from MCP _meta and args_masked keys from raw tool args: both attacker-chosen.
        const hostile: UsageEvent = {
          ...usageEvent(b.id, ts, 2),
          client_name: 'evil\u0000client\ud800 🤖',
          args_masked: { 'k\u0000': 1, '\udc00x': 'v\u0000', ok: '<text:3>' },
        };
        await s.usage.insertMany([usageEvent(a.id, ts, 1), hostile]);

        expect(await s.usage.recent(a.id, 10)).toHaveLength(1);
        const stored = await s.usage.recent(b.id, 10);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.client_name).toBe(`evil${FFFD}client${FFFD} 🤖`);
        expect(stored[0]?.args_masked).toEqual({
          [`k${FFFD}`]: 1,
          [`${FFFD}x`]: `v${FFFD}`,
          ok: '<text:3>',
        });
      });

      it('returns copies, so callers cannot mutate stored state', async () => {
        const t = await s.tenants.create({ name: 'Acme', kind: 'live' });
        const c = await s.connections.upsert(newConnection(t.id));
        await s.usage.insertMany([usageEvent(t.id, clock.now(), 1)]);
        const [e] = await s.usage.recent(t.id, 1);
        e!.args_masked.sku = 'MUTATED';
        c.scopes.push('ZohoInventory.everything.ALL');
        expect((await s.usage.recent(t.id, 1))[0]?.args_masked.sku).toBe('CHAI-250');
        expect((await s.connections.get(t.id, c.id))?.scopes).toHaveLength(2);
      });
    });
  });
}
