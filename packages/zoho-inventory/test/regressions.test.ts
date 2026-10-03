import { DEMO_IDS, MAX_RESULT_TOKENS, encodeCursor, estimateTokens } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createZohoApi } from '../src/client';
import type { DemoDataset } from '../src/fake/dataset';
import { DEMO_ORGANIZATION_ID, createDemoDataset } from '../src/fake/dataset';
import { FAKE_ZOHO_API_DOMAIN, createFakeZoho } from '../src/fake/server';
import { toShipments } from '../src/mappers';
import { fingerprint } from '../src/tools/shared';
import { envelopes, parseUpstream } from '../src/upstream';
import { MapCache, NOW, apiDeps, dataOf, errorOf, harness } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose access into JSON results under test
type Json = Record<string, any>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Zoho allows long contact names; real Indian B2B names routinely run past 60 characters. */
const LONG_NAME =
  'Sri Lakshmi Venkateswara Tea Traders and Distributors Private Limited (Wholesale Division)';

function grow<T>(rows: T[], n: number, edit: (row: T, i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => edit(rows[i % rows.length] as T, i));
}

/** A merchant with 150 of everything and long names: every list tool is exercised at limit 100. */
function bigDataset(): DemoDataset {
  const ds = createDemoDataset({ now: NOW });
  ds.items = grow(ds.items, 150, (r, i) => ({
    ...r,
    item_id: `${r.item_id}${i}`,
    name: `${r.name} - ${LONG_NAME}`.slice(0, 100),
  }));
  ds.contacts = grow(ds.contacts, 150, (r, i) => ({
    ...r,
    contact_id: `${r.contact_id}${i}`,
    contact_name: `${LONG_NAME} ${i}`,
    company_name: LONG_NAME,
  }));
  ds.invoices = grow(ds.invoices, 150, (r, i) => ({
    ...r,
    invoice_id: `${r.invoice_id}${i}`,
    invoice_number: `INV-${String(i).padStart(6, '0')}`,
    customer_name: LONG_NAME,
    reference_number: `pay_29QQoUBi66xm2f / ${r.reference_number}`,
  }));
  ds.salesorders = grow(ds.salesorders, 150, (r, i) => ({
    ...r,
    salesorder_id: `${r.salesorder_id}${i}`,
    salesorder_number: `SO-${String(i).padStart(6, '0')}`,
    customer_name: LONG_NAME,
    reference_number: `marketplace-order-${r.reference_number}-${i}`,
  }));
  return ds;
}

describe('list results stay within the 10K-token budget at limit 100 (long names, 150 rows)', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['zoho_search_items', {}, 'items'],
    ['zoho_search_customers', {}, 'customers'],
    ['zoho_list_invoices', {}, 'invoices'],
    ['zoho_list_sales_orders', {}, 'sales_orders'],
    ['zoho_list_sales_orders', { date_from: '2000-01-01' }, 'sales_orders'],
  ];

  it.each([
    ['zoho_search_customers', 'customers'],
    ['zoho_list_invoices', 'invoices'],
  ])('%s trims an oversized page and resumes inside the same upstream page', async (tool, key) => {
    const h = harness({ dataset: bigDataset() });
    const first = (await h.call(tool, { limit: 100 })).structuredContent as Json;
    const firstRows = first.data[key] as Json[];
    expect(firstRows.length).toBeLessThan(100);
    expect(first.page.has_more).toBe(true);
    const second = (await h.call(tool, { limit: 100, cursor: first.page.next_cursor }))
      .structuredContent as Json;
    // The resumed call returns the rest of upstream page 1, not page 2.
    expect((second.data[key] as Json[]).length).toBe(100 - firstRows.length);
  });

  it.each(cases)('%s %j never fails as too large', async (tool, args) => {
    const h = harness({ dataset: bigDataset() });
    const res = await h.call(tool, { ...args, limit: 100 });
    expect(res.isError, res.text.slice(0, 300)).toBe(false);
    expect(estimateTokens(res.text)).toBeLessThanOrEqual(MAX_RESULT_TOKENS);
  });

  it.each(cases)(
    '%s %j pages through every row exactly once when a page is trimmed',
    async (tool, args, key) => {
      const h = harness({ dataset: bigDataset() });
      const seen: string[] = [];
      let cursor: string | undefined;
      let calls = 0;
      do {
        const res = await h.call(tool, { ...args, limit: 100, ...(cursor ? { cursor } : {}) });
        const sc = res.structuredContent as Json;
        expect(res.isError, res.text.slice(0, 300)).toBe(false);
        for (const row of sc.data[key] as Json[]) {
          seen.push(String(row.item_id ?? row.contact_id ?? row.invoice_id ?? row.salesorder_id));
        }
        cursor = sc.page.next_cursor ?? undefined;
        calls += 1;
      } while (cursor && calls < 20);
      expect(seen).toHaveLength(150);
      expect(new Set(seen).size).toBe(150);
    },
  );
});

describe('page cursors resist tampering', () => {
  it.each([
    ['a skip past the page size', { p: 1, n: 20, s: 20 }],
    ['a negative skip', { p: 1, n: 20, s: -1 }],
    ['a fractional skip', { p: 1, n: 20, s: 1.5 }],
    ['a fractional page', { p: 1.5, n: 20 }],
  ])('rejects %s', async (_name, state) => {
    const cursor = encodeCursor({ ...state, f: fingerprint({}) });
    const res = await harness().call('zoho_list_invoices', { cursor });
    expect(errorOf(res).code).toBe('INVALID_INPUT');
  });
});

describe('zoho_check_stock at its max (25 item_ids)', () => {
  it('stays within the token budget', async () => {
    const h = harness();
    const ids = h.dataset.items.slice(0, 25).map((i) => i.item_id);
    const res = await h.call('zoho_check_stock', { item_ids: ids });
    expect(res.isError).toBe(false);
    expect(dataOf<Json>(res).items).toHaveLength(25);
    expect(estimateTokens(res.text)).toBeLessThanOrEqual(MAX_RESULT_TOKENS);
  });
});

describe('delivery status is not inferred from any text that merely mentions delivery', () => {
  it('only an explicit delivered status counts as delivered', () => {
    const so = parseUpstream(envelopes.salesorder, {
      salesorder: {
        salesorder_id: '1',
        packages: [
          { package_id: 'p1', status: 'shipped', status_message: 'Out for Delivery' },
          { package_id: 'p2', status: 'shipped', status_message: 'Undelivered' },
          { package_id: 'p3', status: 'shipped', status_message: 'Delivery attempted' },
          { package_id: 'p4', status: 'not_shipped', status_message: 'Not Delivered' },
          { package_id: 'p5', status: 'delivered', status_message: 'Delivered' },
          { package_id: 'p6', status: 'shipped', status_message: 'Delivered' },
        ],
      },
    }).salesorder;
    expect(toShipments(so).map((s) => s.delivered)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('zoho_get_connection_status', () => {
  it('checks reachability live instead of trusting a cached organization read', async () => {
    const h = harness({ cache: new MapCache() });
    expect(dataOf<Json>(await h.call('zoho_get_connection_status', {})).upstream.reachable).toBe(
      true,
    );
    h.faults.add('daily_quota_45');
    const after = dataOf<Json>(await h.call('zoho_get_connection_status', {}));
    expect(after.upstream.reachable).toBe(false);
    expect(after.upstream.error_code).not.toBeNull();
  });
});

describe('meta.cached describes the records returned, not a side lookup', () => {
  it('is false when only the organization currency came from cache', async () => {
    const h = harness({ cache: new MapCache() });
    await h.call('zoho_get_item', { sku: DEMO_IDS.sku }); // warms the organization cache
    const fresh = await h.call('zoho_search_items', { query: 'kettle' });
    expect((fresh.structuredContent as Json).meta.cached).toBe(false);
    const again = await h.call('zoho_search_items', { query: 'kettle' });
    expect((again.structuredContent as Json).meta.cached).toBe(true);

    const stock = await h.call('zoho_check_stock', { skus: [DEMO_IDS.sku] });
    expect((stock.structuredContent as Json).meta.cached).toBe(false);
  });
});

describe('PII embedded in names and free text is masked like the dedicated fields', () => {
  const ALIAS = 'rohan.m.1990@example.com';
  const PHONE = '98450 77777';

  function piiDataset(): DemoDataset {
    const ds = createDemoDataset({ now: NOW });
    const rohan = ds.contacts.find((c) => c.contact_name === DEMO_IDS.rtoCustomer);
    if (!rohan) throw new Error('fixture');
    // Marketplace-imported contacts are often named by their email address.
    rohan.contact_name = ALIAS;
    rohan.notes = `Alt number +91 ${PHONE}, or write to rohan.alt@example.com`;
    for (const r of [...ds.salesorders, ...ds.invoices, ...ds.customerpayments]) {
      if (r.customer_id === rohan.contact_id) r.customer_name = ALIAS;
    }
    for (const so of ds.salesorders) {
      if (so.customer_id === rohan.contact_id) so.notes = `Call ${PHONE.replace(' ', '')} first.`;
    }
    return ds;
  }

  it('never returns the raw email or phone from a name, note or courier text', async () => {
    const h = harness({ dataset: piiDataset() });
    const customers = await h.call('zoho_search_customers', { name_contains: 'rohan' });
    const customer = dataOf<Json>(customers).customers[0];
    expect(customer.name).toBe('r***@example.com');
    expect(customer.notes.untrusted_text).toContain('***7777');
    const id = customer.contact_id as string;

    const results = [
      customers,
      await h.call('zoho_list_sales_orders', { customer_id: id }),
      await h.call('zoho_list_invoices', { customer_id: id }),
      await h.call('zoho_get_sales_order', { salesorder_number: DEMO_IDS.salesOrderNumber }),
    ];
    for (const res of results) {
      expect(res.isError, res.text.slice(0, 200)).toBe(false);
      expect(res.text).not.toMatch(EMAIL_RE);
      expect(res.text).not.toContain(PHONE);
      expect(res.text).not.toContain(PHONE.replace(' ', ''));
    }
  });

  it('keeps identifiers intact (UTR references are 12 digits but not phones)', async () => {
    const data = dataOf<Json>(
      await harness().call('zoho_find_by_payment_reference', { reference: '412345678901' }),
    );
    expect(data.matches[0].payment.reference_number).toBe('412345678901');
  });
});

describe('zoho_find_by_payment_reference with a broken chain', () => {
  function chain(ds: DemoDataset) {
    const pay = ds.customerpayments.find((p) => p.reference_number === DEMO_IDS.paymentRef);
    const link = pay?.invoices[0];
    const inv = ds.invoices.find((i) => i.invoice_id === link?.invoice_id);
    if (!pay || !link || !inv) throw new Error('fixture');
    return { pay, link, inv };
  }

  it('keeps the payment and invoice when the linked sales order no longer exists', async () => {
    const ds = createDemoDataset({ now: NOW });
    chain(ds).inv.salesorder_id = '460000104999999';
    const res = await harness({ dataset: ds }).call('zoho_find_by_payment_reference', {
      reference: DEMO_IDS.paymentRef,
    });
    const data = dataOf<Json>(res);
    expect(data.matches[0].payment.reference_number).toBe(DEMO_IDS.paymentRef);
    expect(data.matches[0].invoices).toHaveLength(1);
    expect(data.matches[0].sales_order).toBeNull();
    expect(data.matches[0].resolved).toBe(false);
    expect(data.notes.join(' ')).toMatch(/no longer exists/);
  });

  it('keeps the payment when the invoice it paid no longer exists', async () => {
    const ds = createDemoDataset({ now: NOW });
    chain(ds).link.invoice_id = '460000106999999';
    const data = dataOf<Json>(
      await harness({ dataset: ds }).call('zoho_find_by_payment_reference', {
        reference: DEMO_IDS.paymentRef,
      }),
    );
    expect(data.matches[0].payment.reference_number).toBe(DEMO_IDS.paymentRef);
    expect(data.matches[0].invoices).toEqual([]);
    expect(data.matches[0].resolved).toBe(false);
  });
});

describe('ZohoClient cache scoping', () => {
  it('refuses a cache without a tenant-scoped key prefix', () => {
    const fake = createFakeZoho({ dataset: createDemoDataset({ now: NOW }) });
    const deps = { fetch: fake.fetch, tokens: fake.tokens, cache: new MapCache() };
    expect(() => createZohoApi(apiDeps({ ...deps, cacheKeyPrefix: '' }))).toThrow(/cacheKeyPrefix/);
    expect(() => createZohoApi(apiDeps({ ...deps, cacheKeyPrefix: '  ' }))).toThrow(
      /cacheKeyPrefix/,
    );
    expect(() => createZohoApi(apiDeps({ ...deps, cacheKeyPrefix: 'zoho:t1:o1:' }))).not.toThrow();
  });
});

describe('FakeZoho wire fidelity', () => {
  it('answers a malformed percent-encoded path with a Zoho 404, not a thrown error', async () => {
    const fake = createFakeZoho({ dataset: createDemoDataset({ now: NOW }) });
    const token = await fake.tokens.get();
    const res = await fake.fetch(
      `${FAKE_ZOHO_API_DOMAIN}/inventory/v1/items/%E0%A4%A?organization_id=${DEMO_ORGANIZATION_ID}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as Json).code).not.toBe(0);
  });
});
