import type { DemoFault } from '@mb/core';
import { DEMO_IDS } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { DEMO_ORGANIZATION_ID, createDemoDataset } from '../src/fake/dataset';
import { FAKE_ZOHO_API_DOMAIN, createFakeZoho } from '../src/fake/server';
import { NOW, TODAY, addDays } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose access into JSON results under test
type Json = Record<string, any>;

function setup(faults = new Set<DemoFault>()) {
  const dataset = createDemoDataset({ now: NOW });
  const fake = createFakeZoho({ dataset, faults: () => faults });
  const req = async (path: string, query: Record<string, string> = {}, init: RequestInit = {}) => {
    const url = new URL(`${FAKE_ZOHO_API_DOMAIN}/inventory/v1/${path}`);
    const withOrg = path.startsWith('organizations')
      ? query
      : { organization_id: DEMO_ORGANIZATION_ID, ...query };
    for (const [k, v] of Object.entries(withOrg)) url.searchParams.set(k, v);
    const token = await fake.tokens.get();
    return fake.fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, ...init });
  };
  const get = async (path: string, query: Record<string, string> = {}): Promise<Json> => {
    const res = await req(path, query);
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
  };
  return { dataset, fake, faults, req, get };
}

describe('FakeZoho wire format', () => {
  it('paginates with page/per_page and page_context', async () => {
    const { get } = setup();
    const p1 = await get('items', { per_page: '15' });
    expect(p1.code).toBe(0);
    expect(p1.items).toHaveLength(15);
    expect(p1.page_context).toEqual({ page: 1, per_page: 15, has_more_page: true });
    const p3 = await get('items', { per_page: '15', page: '3' });
    expect(p3.items).toHaveLength(10);
    expect(p3.page_context.has_more_page).toBe(false);
    const big = await get('items', { per_page: '1000' });
    expect(big.page_context.per_page).toBe(200);
  });

  it('honours list vs detail shapes from the OpenAPI examples', async () => {
    const { get, dataset } = setup();
    const items = await get('items', { sku: DEMO_IDS.sku });
    expect(items.items[0]).not.toHaveProperty('locations');
    const item = await get(`items/${items.items[0].item_id}`);
    expect(item.item.locations[0]).toHaveProperty('location_stock_on_hand');

    const contacts = await get('contacts');
    expect(contacts.contacts[0]).toHaveProperty('email');
    expect(contacts.contacts[0]).not.toHaveProperty('notes');
    const contact = await get(`contacts/${contacts.contacts[0].contact_id}`);
    expect(contact.contact).toHaveProperty('notes');
    expect(contact.contact).toHaveProperty('contact_persons');
    expect(contact.contact).not.toHaveProperty('email');

    const sos = await get('salesorders');
    expect(sos.salesorders[0]).not.toHaveProperty('line_items');
    const so = await get(`salesorders/${sos.salesorders[0].salesorder_id}`);
    expect(so.salesorder).toHaveProperty('line_items');
    expect(so.salesorder).toHaveProperty('packages');
    expect(so.salesorder).toHaveProperty('invoices');

    const pays = await get('customerpayments');
    expect(pays.customerpayments[0]).toHaveProperty('invoice_number');
    expect(pays.customerpayments[0]).not.toHaveProperty('invoices');
    const pay = await get(`customerpayments/${pays.customerpayments[0].payment_id}`);
    expect(pay.payment).toHaveProperty('invoices');

    const pkgs = await get('packages');
    expect(Array.isArray(pkgs.package)).toBe(true);
    const pkg = await get(`packages/${dataset.packages[0]?.package_id}`);
    expect(Array.isArray(pkg.package)).toBe(true);
    expect(pkg.package[0].shipment_order).toHaveProperty('tracking_number');

    const shipmentId = dataset.packages[0]?.shipment_order?.shipment_id ?? '';
    const shipment = await get(`shipmentorders/${shipmentId}`);
    expect(shipment.shipment_order).toMatchObject({ shipment_id: shipmentId });
    expect(Array.isArray(shipment.shipment_order.billing_address)).toBe(true);

    const orgs = await get('organizations');
    expect(orgs.organizations[0]).toMatchObject({
      organization_id: DEMO_ORGANIZATION_ID,
      name: DEMO_IDS.orgName,
    });
    const org = await get(`organizations/${DEMO_ORGANIZATION_ID}`);
    expect(org.organization.currency_code).toBe('INR');
    const locations = await get('locations');
    expect(locations.locations.map((l: Json) => l.location_name).join()).toMatch(
      /Bengaluru.*Mumbai/,
    );
  });

  it('implements the documented item filters', async () => {
    const { get } = setup();
    expect((await get('items', { sku: DEMO_IDS.sku })).items).toHaveLength(1);
    expect((await get('items', { search_text: 'chai' })).items.length).toBeGreaterThan(2);
    expect((await get('items', { name_contains: 'kettle' })).items).toHaveLength(1);
    const low = (await get('items', { filter_by: 'Status.Lowstock' })).items;
    expect(low.length).toBeGreaterThanOrEqual(3);
    for (const it of low) expect(it.stock_on_hand).toBeLessThanOrEqual(it.reorder_level);
    expect((await get('items', { status: 'inactive' })).items).toHaveLength(1);
    const ids = (await get('items', { per_page: '3' })).items.map((i: Json) => i.item_id).join(',');
    expect((await get('itemdetails', { item_ids: ids })).items).toHaveLength(3);
  });

  it('implements the documented contact filters', async () => {
    const { get } = setup();
    expect((await get('contacts', { contact_name_contains: 'rohan' })).contacts).toHaveLength(1);
    expect((await get('contacts', { company_name_contains: 'tea room' })).contacts).toHaveLength(1);
    expect((await get('contacts', { email_contains: 'priya' })).contacts).toHaveLength(1);
    expect((await get('contacts', { phone_contains: '98450 10001' })).contacts).toHaveLength(1);
    expect((await get('contacts', { search_text: 'doorstep' })).contacts).toHaveLength(1);
  });

  it('implements the documented invoice filters', async () => {
    const { get, dataset } = setup();
    const unpaid = (await get('invoices', { status: 'unpaid' })).invoices;
    expect(unpaid.length).toBeGreaterThan(0);
    for (const inv of unpaid) expect(inv.balance).toBeGreaterThan(0);
    const dueSoon = (
      await get('invoices', {
        status: 'unpaid',
        due_date_start: TODAY,
        due_date_end: addDays(TODAY, 7),
      })
    ).invoices;
    for (const inv of dueSoon)
      expect(inv.due_date >= TODAY && inv.due_date <= addDays(TODAY, 7)).toBe(true);
    expect((await get('invoices', { status: 'overdue' })).invoices.length).toBeGreaterThanOrEqual(
      2,
    );
    expect((await get('invoices', { reference_number: 'order_DEMO6Hy2' })).invoices).toHaveLength(
      1,
    );
    expect((await get('invoices', { invoice_number: 'INV-00005' })).invoices).toHaveLength(1);
    const rohan =
      dataset.contacts.find((c) => c.contact_name === DEMO_IDS.rtoCustomer)?.contact_id ?? '';
    const rohanInv = (await get('invoices', { customer_id: rohan })).invoices;
    expect(rohanInv.every((i: Json) => i.customer_id === rohan)).toBe(true);
  });

  it('implements customer payment and package filters', async () => {
    const { get } = setup();
    expect(
      (await get('customerpayments', { reference_number_contains: 'DEMO8xK' })).customerpayments,
    ).toHaveLength(1);
    expect(
      (await get('customerpayments', { reference_number: DEMO_IDS.paymentRef })).customerpayments,
    ).toHaveLength(1);
    expect(
      (await get('customerpayments', { search_text: 'order_DEMO' })).customerpayments,
    ).toHaveLength(1);
    const delivered = (await get('packages', { filter_by: 'Status.Delivered' })).package;
    const shipped = (await get('packages', { filter_by: 'Status.Shipped' })).package;
    const notShipped = (await get('packages', { filter_by: 'Status.NotShipped' })).package;
    expect(delivered.length).toBeGreaterThan(0);
    expect(shipped.length).toBeGreaterThan(0);
    expect(notShipped).toHaveLength(1);
    const recent = (
      await get('packages', { shipment_date_start: addDays(TODAY, -3), shipment_date_end: TODAY })
    ).package;
    expect(recent.length).toBeGreaterThan(0);
  });

  it('documents no sales order filters, so it ignores them', async () => {
    const { get } = setup();
    const res = await get('salesorders', { status: 'void', customer_id: '1' });
    expect(res.salesorders).toHaveLength(25);
  });
});

describe('FakeZoho errors', () => {
  it('returns 404-style Zoho errors for unknown ids', async () => {
    const { req } = setup();
    for (const path of [
      'items/999',
      'invoices/999',
      'salesorders/999',
      'contacts/999',
      'customerpayments/999',
      'packages/999',
    ]) {
      const res = await req(path);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Json;
      expect(body.code).not.toBe(0);
      expect(body.message).toMatch(/does not exist/);
    }
  });

  it('rejects missing or foreign organization_id', async () => {
    const { fake } = setup();
    const token = await fake.tokens.get();
    const headers = { Authorization: `Zoho-oauthtoken ${token}` };
    expect(
      (await fake.fetch(`${FAKE_ZOHO_API_DOMAIN}/inventory/v1/items`, { headers })).status,
    ).toBe(400);
    expect(
      (
        await fake.fetch(`${FAKE_ZOHO_API_DOMAIN}/inventory/v1/items?organization_id=1`, {
          headers,
        })
      ).status,
    ).toBe(400);
  });

  it('rejects missing or unknown tokens with 401', async () => {
    const { fake } = setup();
    const url = `${FAKE_ZOHO_API_DOMAIN}/inventory/v1/items?organization_id=${DEMO_ORGANIZATION_ID}`;
    expect((await fake.fetch(url)).status).toBe(401);
    expect(
      (await fake.fetch(url, { headers: { Authorization: 'Zoho-oauthtoken nope' } })).status,
    ).toBe(401);
  });

  it('is read-only: non-GET methods get 405', async () => {
    const { req } = setup();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await req('items', {}, { method })).status).toBe(405);
    }
  });

  it('returns 404 for unknown routes and for a shipmentorders list', async () => {
    const { req } = setup();
    expect((await req('users')).status).toBe(404);
    expect((await req('shipmentorders')).status).toBe(404);
  });

  it('counts calls', async () => {
    const { fake, req } = setup();
    await req('items');
    await req('contacts');
    expect(fake.calls).toBe(2);
  });

  it('honours abort signals while simulating latency', async () => {
    const fake = createFakeZoho({ dataset: createDemoDataset({ now: NOW }), latencyMs: 500 });
    const token = await fake.tokens.get();
    const p = fake.fetch(
      `${FAKE_ZOHO_API_DOMAIN}/inventory/v1/items?organization_id=${DEMO_ORGANIZATION_ID}`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        signal: AbortSignal.timeout(5),
      },
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('FakeZoho faults', () => {
  const codeOf = async (res: Response): Promise<number | null> => {
    try {
      return ((await res.json()) as Json).code as number;
    } catch {
      return null;
    }
  };

  it('rate_limit_44 → 429 code 44 on every request', async () => {
    const { req } = setup(new Set(['rate_limit_44']));
    for (let i = 0; i < 3; i++) {
      const res = await req('items');
      expect(res.status).toBe(429);
      expect(await codeOf(res)).toBe(44);
    }
  });

  it('daily_quota_45 → 429 code 45', async () => {
    const { req } = setup(new Set(['daily_quota_45']));
    const res = await req('items');
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe(45);
  });

  it('concurrency_1070 → 429 code 1070 for the first two requests, then normal', async () => {
    const { req } = setup(new Set(['concurrency_1070']));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await req('items')).status);
    expect(statuses).toEqual([429, 429, 200, 200]);
  });

  it('server_5xx → 503 on the first request, then normal', async () => {
    const { req } = setup(new Set(['server_5xx']));
    expect((await req('items')).status).toBe(503);
    expect((await req('items')).status).toBe(200);
  });

  it('malformed → 200 with an invalid JSON body', async () => {
    const { req } = setup(new Set(['malformed']));
    const res = await req('items');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(() => JSON.parse(text) as unknown).toThrow();
  });

  it('expired_token → the stale token gets 401 and is revoked; a refreshed token works', async () => {
    const faults = new Set<DemoFault>();
    const { fake, req } = setup(faults);
    expect((await req('items')).status).toBe(200);
    const stale = await fake.tokens.get();
    faults.add('expired_token');
    const first = await req('items');
    expect(first.status).toBe(401);
    expect(await codeOf(first)).toBe(57);
    expect((await req('items')).status).toBe(401); // revoked
    const fresh = await fake.tokens.refreshAfterUnauthorized(stale);
    expect(fresh).not.toBe(stale);
    expect(await fake.tokens.refreshAfterUnauthorized(stale)).toBe(fresh); // single-flight
    expect((await req('items')).status).toBe(200);
  });

  it('reads the active fault set on every request', async () => {
    const faults = new Set<DemoFault>();
    const { req } = setup(faults);
    expect((await req('items')).status).toBe(200);
    faults.add('rate_limit_44');
    expect((await req('items')).status).toBe(429);
    faults.delete('rate_limit_44');
    expect((await req('items')).status).toBe(200);
  });
});
