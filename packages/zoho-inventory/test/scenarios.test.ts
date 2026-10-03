import { DEMO_IDS, SCENARIOS } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { createDemoDataset } from '../src/fake/dataset';
import { NOW, TODAY, addDays, dataOf, harness } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose access into JSON results under test
type Json = Record<string, any>;

describe('demo dataset backs every playground scenario', () => {
  it('is deterministic for a given now and has the planned volumes', () => {
    const a = createDemoDataset({ now: NOW });
    expect(createDemoDataset({ now: NOW })).toEqual(a);
    expect(a.organization.name).toBe(DEMO_IDS.orgName);
    expect(a.organization.currency_code).toBe('INR');
    expect(a.items).toHaveLength(40);
    expect(a.contacts).toHaveLength(12);
    expect(a.salesorders).toHaveLength(25);
    expect(a.invoices).toHaveLength(15);
    expect(a.customerpayments).toHaveLength(10);
    const carriers = new Set(a.packages.map((p) => p.shipment_order?.carrier).filter(Boolean));
    expect(carriers).toEqual(new Set(['Delhivery', 'Blue Dart', 'Ekart']));
    expect(new Set(a.salesorders.map((s) => s.status))).toEqual(
      new Set(['draft', 'confirmed', 'shipped', 'fulfilled', 'void']),
    );
    for (const c of a.contacts) expect(c.email).toMatch(/@([a-z]+\.)?example\.com$/);
  });

  it('dates move with now, so "due this week" stays true on the live site', () => {
    const later = createDemoDataset({ now: NOW + 30 * 86_400_000 });
    const base = createDemoDataset({ now: NOW });
    expect(later.invoices[0]?.due_date).toBe(addDays(base.invoices[0]?.due_date ?? '', 30));
  });

  it('Dispute Responder: pay_DEMO8xK2 → invoice → sales order with a delivered, tracked shipment', async () => {
    const h = harness();
    const res = await h.call('zoho_find_by_payment_reference', { reference: DEMO_IDS.paymentRef });
    const data = dataOf<Json>(res);
    expect(data.kind).toBe('razorpay_payment');
    expect(data.upstream_calls).toBeLessThanOrEqual(5);
    expect(res.usage.upstream_calls).toBeLessThanOrEqual(5);
    const m = data.matches[0];
    expect(m).toMatchObject({ confidence: 'exact', resolved: true });
    expect(m.payment.reference_number).toBe(DEMO_IDS.paymentRef);
    expect(m.invoices[0]).toMatchObject({
      status: 'paid',
      balance: { amount_minor: 0, currency: 'INR' },
    });
    expect(m.sales_order.salesorder_number).toBe(m.invoices[0].salesorder.salesorder_number);
    const ship = m.sales_order.shipments[0];
    expect(ship).toMatchObject({ delivered: true, carrier: 'Delhivery' });
    expect(ship.tracking_number).toMatch(/^\d{10,}$/);
    expect((res.structuredContent as Json).meta.zoho_url).toContain('#/paymentsreceived/');

    const so = dataOf<Json>(
      await h.call('zoho_get_sales_order', { salesorder_id: m.sales_order.salesorder_id }),
    );
    expect(so.shipments[0]).toMatchObject({
      delivered: true,
      tracking_number: ship.tracking_number,
    });
    expect(so.invoices[0].invoice_number).toBe(m.invoices[0].invoice_number);
  });

  it('COD Confirmation: CHAI-250 is in stock in Bengaluru at ₹180', async () => {
    const h = harness();
    const item = dataOf<Json>(await h.call('zoho_get_item', { sku: DEMO_IDS.sku }));
    expect(item.name).toBe('Masala Chai 250g');
    expect(item.rate).toEqual({ amount_minor: 18000, currency: 'INR' });
    const blr = item.locations.find((l: Json) =>
      String(l.location_name).includes(DEMO_IDS.location),
    );
    expect(blr.stock_on_hand).toBeGreaterThan(0);
    expect(blr.available_stock).toBeGreaterThan(0);
  });

  it('RTO Shield: Rohan Mehta has void orders, a void invoice and one open order', async () => {
    const h = harness();
    const customers = dataOf<Json>(
      await h.call('zoho_search_customers', { name_contains: DEMO_IDS.rtoCustomer }),
    ).customers;
    expect(customers).toHaveLength(1);
    const id = customers[0].contact_id;
    const voids = dataOf<Json>(
      await h.call('zoho_list_sales_orders', { customer_id: id, status: 'void' }),
    );
    expect(voids.sales_orders.length).toBeGreaterThanOrEqual(3);
    expect(voids.scan).toMatchObject({ bounded: true, more_beyond_scan: false });
    const open = dataOf<Json>(
      await h.call('zoho_list_sales_orders', { customer_id: id, status: 'confirmed' }),
    );
    expect(open.sales_orders).toHaveLength(1);
    const inv = dataOf<Json>(
      await h.call('zoho_list_invoices', { customer_id: id, status: 'void' }),
    );
    expect(inv.invoices.length).toBeGreaterThanOrEqual(1);
  });

  it('Settlement Insights: at least two unpaid invoices are due within the next 7 days', async () => {
    const h = harness();
    const data = dataOf<Json>(
      await h.call('zoho_list_invoices', {
        status: 'unpaid',
        due_from: TODAY,
        due_to: addDays(TODAY, 7),
      }),
    );
    expect(data.invoices.length).toBeGreaterThanOrEqual(2);
    for (const inv of data.invoices) {
      expect(inv.balance.amount_minor).toBeGreaterThan(0);
      expect(inv.due_date >= TODAY && inv.due_date <= addDays(TODAY, 7)).toBe(true);
    }
    const overdue = dataOf<Json>(await h.call('zoho_list_invoices', { status: 'overdue' }));
    expect(overdue.invoices.length).toBeGreaterThanOrEqual(2);
  });

  it('Refusal card: SO-00012 exists and is open', async () => {
    const h = harness();
    const so = dataOf<Json>(
      await h.call('zoho_get_sales_order', { salesorder_number: DEMO_IDS.salesOrderNumber }),
    );
    expect(so).toMatchObject({ salesorder_number: DEMO_IDS.salesOrderNumber, status: 'confirmed' });
    expect(so.customer_name).toBe(DEMO_IDS.rtoCustomer);
  });

  it('every scenario references only tools this connector provides', () => {
    const h = harness();
    const names = new Set(h.runtime.listTools().map((t) => t.name));
    for (const s of SCENARIOS) for (const t of s.expectedTools) expect(names.has(t), t).toBe(true);
  });
});
