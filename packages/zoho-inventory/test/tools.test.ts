import { describe, expect, it } from 'vitest';
import { DEMO_INJECTION } from '../src/fake/dataset';
import { classifyReference } from '../src/tools/find-by-payment-reference';
import { MapCache, dataOf, errorOf, harness } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose access into JSON results under test
type Json = Record<string, any>;

describe('classifyReference', () => {
  it.each([
    ['pay_DEMO8xK2', 'razorpay_payment'],
    ['pay_29QQoUBi66xm2f', 'razorpay_payment'],
    ['order_DEMO4Kp7', 'razorpay_order'],
    ['rfnd_FP8QHiV938haTz', 'razorpay_refund'],
    ['412345678901', 'upi_utr'],
    ['41234567890', 'other'],
    ['CHQ-004512', 'other'],
    ['pay_', 'other'],
  ])('%s → %s', (ref, kind) => {
    expect(classifyReference(ref)).toBe(kind);
  });
});

describe('zoho_find_by_payment_reference', () => {
  it('returns partial matches for a fragment', async () => {
    const data = dataOf<Json>(
      await harness().call('zoho_find_by_payment_reference', { reference: 'DEMO8xK' }),
    );
    expect(data.matches[0]).toMatchObject({ confidence: 'partial' });
  });

  it('falls back to invoice reference numbers (Razorpay order recorded on an unpaid invoice)', async () => {
    const data = dataOf<Json>(
      await harness().call('zoho_find_by_payment_reference', { reference: 'order_DEMO6Hy2' }),
    );
    expect(data.kind).toBe('razorpay_order');
    expect(data.matches[0]).toMatchObject({
      confidence: 'exact',
      matched_on: 'invoice.reference_number',
      payment: null,
    });
    expect(data.matches[0].invoices[0].balance.amount_minor).toBeGreaterThan(0);
    expect(data.matches[0].sales_order.shipments[0].delivered).toBe(false);
  });

  it('resolves UPI UTRs and unapplied Razorpay order advances', async () => {
    const h = harness();
    const utr = dataOf<Json>(
      await h.call('zoho_find_by_payment_reference', { reference: '412345678901' }),
    );
    expect(utr).toMatchObject({
      kind: 'upi_utr',
      matches: [{ confidence: 'exact', resolved: true }],
    });
    const adv = dataOf<Json>(
      await h.call('zoho_find_by_payment_reference', { reference: 'order_DEMO4Kp7' }),
    );
    expect(adv.matches[0].payment.invoices).toEqual([]);
    expect(adv.matches[0].payment.unused_amount).toEqual({ amount_minor: 500000, currency: 'INR' });
  });

  it('reports no match without failing and never exceeds 5 upstream calls', async () => {
    const h = harness();
    for (const reference of ['pay_NOPE1234', 'rfnd_NOPE1234', 'DEMO', '2']) {
      const res = await h.call('zoho_find_by_payment_reference', {
        reference: reference.padEnd(3, '0'),
      });
      expect(res.usage.upstream_calls).toBeLessThanOrEqual(5);
    }
    const none = dataOf<Json>(
      await h.call('zoho_find_by_payment_reference', { reference: 'pay_NOPE1234' }),
    );
    expect(none.matches).toEqual([]);
    expect(none.notes.join(' ')).toMatch(/No customer payment/);
  });
});

describe('zoho_list_sales_orders', () => {
  it('pages through all orders with an opaque cursor (no filters → upstream pagination)', async () => {
    const h = harness();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await h.call('zoho_list_sales_orders', {
        limit: 10,
        ...(cursor ? { cursor } : {}),
      });
      const sc = res.structuredContent as Json;
      seen.push(...sc.data.sales_orders.map((s: Json) => s.salesorder_number));
      expect(sc.data.scan).toBeNull();
      cursor = sc.page.next_cursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(25);
  });

  it('applies filters client-side over a bounded scan and paginates by offset', async () => {
    const h = harness();
    const first = await h.call('zoho_list_sales_orders', { status: 'void', limit: 2 });
    const sc = first.structuredContent as Json;
    expect(sc.data.sales_orders).toHaveLength(2);
    expect(sc.data.scan).toEqual({
      bounded: true,
      scanned: 25,
      max_scanned: 600,
      more_beyond_scan: false,
    });
    const second = dataOf<Json>(
      await h.call('zoho_list_sales_orders', {
        status: 'void',
        limit: 2,
        cursor: sc.page.next_cursor,
      }),
    );
    expect(second.sales_orders).toHaveLength(2);
    expect(second.sales_orders.every((s: Json) => s.status === 'void')).toBe(true);
  });

  it('rejects a cursor replayed against different filters or tampered with', async () => {
    const h = harness();
    const sc = (await h.call('zoho_list_sales_orders', { status: 'void', limit: 1 }))
      .structuredContent as Json;
    expect(
      errorOf(
        await h.call('zoho_list_sales_orders', { status: 'draft', cursor: sc.page.next_cursor }),
      ).code,
    ).toBe('INVALID_INPUT');
    expect(errorOf(await h.call('zoho_list_invoices', { cursor: 'eyJ2IjoyfQ' })).code).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('items, customers and stock', () => {
  it('low_stock_only returns only low-stock items', async () => {
    const data = dataOf<Json>(await harness().call('zoho_search_items', { low_stock_only: true }));
    expect(data.items.length).toBeGreaterThanOrEqual(3);
    expect(data.items.every((i: Json) => i.low_stock === true)).toBe(true);
  });

  it('wraps item descriptions and customer notes as untrusted text', async () => {
    const h = harness();
    const item = dataOf<Json>(await h.call('zoho_get_item', { sku: 'KAHWA-100' }));
    expect(item.description.untrusted_text).toContain(DEMO_INJECTION);
    const c = dataOf<Json>(await h.call('zoho_search_customers', { name_contains: 'Priya' }));
    expect(c.customers[0].notes.untrusted_text).toContain(DEMO_INJECTION);
    expect(c.customers[0].email).toBe('p***@example.com');
    expect(c.customers[0].phone).toMatch(/^\*\*\*\d{4}$/);
  });

  it('only enriches small customer result sets with notes', async () => {
    const data = dataOf<Json>(await harness().call('zoho_search_customers', {}));
    expect(data.customers.length).toBeGreaterThan(3);
    expect(data.customers.every((c: Json) => c.notes === null)).toBe(true);
  });

  it('check_stock reports unknown SKUs and per-location stock', async () => {
    const data = dataOf<Json>(
      await harness().call('zoho_check_stock', { skus: ['CHAI-250', 'SAFF-1', 'NOPE-1'] }),
    );
    expect(data.not_found).toEqual(['NOPE-1']);
    expect(data.items).toHaveLength(2);
    expect(data.items[0].locations).toHaveLength(2);
  });

  it('caches item and org reads across calls when a cache is supplied', async () => {
    const h = harness({ cache: new MapCache() });
    await h.call('zoho_get_item', { sku: 'CHAI-250' });
    const before = h.fake.calls;
    const res = await h.call('zoho_get_item', { sku: 'CHAI-250' });
    expect(h.fake.calls).toBe(before);
    expect((res.structuredContent as Json).meta.cached).toBe(true);
    expect(res.usage.cache_hits).toBe(3);
  });
});

describe('faults through the full tool path', () => {
  it('expired_token: refresh once and the tool still succeeds', async () => {
    const h = harness({ faults: new Set(['expired_token']) });
    const res = await h.call('zoho_get_sales_order', { salesorder_number: 'SO-00012' });
    expect(res.isError).toBe(false);
  });

  it('concurrency_1070 with governor retries: retried calls visibly succeed', async () => {
    const h = harness({ faults: new Set(['concurrency_1070']), retries: 3 });
    const res = await h.call('zoho_list_invoices', {});
    expect(res.isError).toBe(false);
    expect(res.usage.retries).toBe(2);
  });

  it('malformed: a non-retryable UPSTREAM_ERROR result, not a throw', async () => {
    const h = harness({ faults: new Set(['malformed']) });
    const err = errorOf(await h.call('zoho_list_invoices', {}));
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
  });

  it('connection status reports an unreachable upstream as data', async () => {
    const h = harness({ faults: new Set(['daily_quota_45']) });
    const data = dataOf<Json>(await h.call('zoho_get_connection_status', {}));
    expect(data.upstream.reachable).toBe(false);
    expect(data.scopes_missing).toEqual([]);
    expect(data.read_only).toBe(true);
  });
});
