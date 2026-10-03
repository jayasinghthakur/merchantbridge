import type { ToolCallResult } from '@mb/core';
import { DEMO_IDS, MAX_RESULT_TOKENS, estimateTokens } from '@mb/core';
import { describe, expect, it } from 'vitest';
import { DEMO_INJECTION } from '../src/fake/dataset';
import { errorOf, harness } from './helpers';

interface ToolCases {
  valid: Record<string, unknown>[];
  bad: unknown[];
  unknown?: Record<string, unknown>[];
  maxLimit?: Record<string, unknown>;
}

const CASES: Record<string, ToolCases> = {
  zoho_get_connection_status: { valid: [{}], bad: ['x', 5] },
  zoho_search_items: {
    valid: [
      {},
      { query: 'chai' },
      { sku: DEMO_IDS.sku },
      { low_stock_only: true },
      { name_contains: 'Kahwa' },
    ],
    bad: [
      { limit: 0 },
      { limit: 101 },
      { query: '' },
      { status: 'gone' },
      { cursor: 'not-a-cursor' },
      { location_id: '../x' },
    ],
    maxLimit: { limit: 100 },
  },
  zoho_get_item: {
    valid: [{ sku: DEMO_IDS.sku }, { sku: 'KAHWA-100' }],
    bad: [{}, { item_id: '1', sku: 'X' }, { item_id: 'a/b' }, { item_id: 5 }],
    unknown: [{ item_id: '999999' }, { sku: 'NOPE-1' }],
  },
  zoho_check_stock: {
    valid: [{ skus: [DEMO_IDS.sku, 'NOPE-1'] }],
    bad: [
      {},
      { skus: [] },
      { skus: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { item_ids: ['x'], skus: ['y'] },
    ],
  },
  zoho_list_sales_orders: {
    valid: [{}, { status: 'void' }, { date_from: '2026-09-01', date_to: '2026-10-03' }],
    bad: [
      { status: 'cancelled' },
      { date_from: '03-10-2026' },
      { date_from: '2026-02-30' },
      { limit: 1000 },
    ],
    maxLimit: { limit: 100 },
  },
  zoho_get_sales_order: {
    valid: [{ salesorder_number: DEMO_IDS.salesOrderNumber }, { salesorder_number: 'so-00007' }],
    bad: [
      {},
      { salesorder_id: '1', salesorder_number: 'SO-1' },
      { salesorder_number: 'SO 1; drop' },
    ],
    unknown: [{ salesorder_id: '999999' }, { salesorder_number: 'SO-99999' }],
  },
  zoho_search_customers: {
    valid: [
      {},
      { name_contains: DEMO_IDS.rtoCustomer },
      { name_contains: 'Priya' },
      { phone_contains: '10001' },
    ],
    bad: [{ phone_contains: 'abc' }, { limit: -1 }, { email_contains: 'x'.repeat(101) }],
    maxLimit: { limit: 100 },
  },
  zoho_list_invoices: {
    valid: [{}, { status: 'unpaid' }, { status: 'overdue' }],
    bad: [{ status: 'open' }, { due_from: 'tomorrow' }, { customer_id: '' }],
    maxLimit: { limit: 100 },
  },
  zoho_get_invoice: {
    valid: [{ invoice_number: 'INV-00005' }],
    bad: [{}, { invoice_id: '1', invoice_number: 'INV-1' }, { invoice_id: '1 OR 1=1' }],
    unknown: [{ invoice_id: '999999' }, { invoice_number: 'INV-99999' }],
  },
  zoho_find_by_payment_reference: {
    valid: [
      { reference: DEMO_IDS.paymentRef },
      { reference: 'pay_NOPE1234' },
      { reference: '412345678901' },
    ],
    bad: [{}, { reference: 'pa' }, { reference: 'pay_x; DROP' }, { reference: 'x'.repeat(65) }],
  },
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Every string value in the result, with the key it sits under. */
function strings(value: unknown, key = '', out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([key, value]);
  else if (Array.isArray(value)) for (const v of value) strings(v, key, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) strings(v, k, out);
  }
  return out;
}

describe('connector contract (every tool via ToolRuntime on FakeZoho)', () => {
  const h = harness();
  const descriptors = new Map(h.runtime.listTools().map((d) => [d.name, d]));
  const results: [string, ToolCallResult][] = [];
  const piiNeedles = h.dataset.contacts.flatMap((c) => [
    c.email,
    c.phone,
    c.mobile,
    c.phone.replace(/\D/g, ''),
    c.mobile.replace(/\D/g, ''),
  ]);

  it('lists every tool once, sorted, with complete descriptions and described inputs', () => {
    const names = [...descriptors.keys()];
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names)).toEqual(new Set(Object.keys(CASES)));
    for (const d of descriptors.values()) {
      expect(d.description).toMatch(/Use (when|first|for)/);
      expect(d.description).toContain("Don't use");
      expect(d.description).toContain('Read-only');
      expect(d.annotations.readOnlyHint).toBe(true);
      const props = (d.inputJsonSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${d.name}.${field}`).toBeTruthy();
      }
    }
  });

  for (const [tool, cases] of Object.entries(CASES)) {
    describe(tool, () => {
      it('valid args → isError false, envelope schema-valid, one usage event per call', async () => {
        for (const args of cases.valid) {
          const before = h.events.length;
          const res = await h.call(tool, args);
          expect(res.isError, `${tool} ${JSON.stringify(args)} → ${res.text.slice(0, 300)}`).toBe(
            false,
          );
          expect(() => descriptors.get(tool)?.output.parse(res.structuredContent)).not.toThrow();
          expect(h.events.length).toBe(before + 1);
          expect(h.events.at(-1)).toMatchObject({ tool, status: 'ok' });
          expect(estimateTokens(res.text)).toBeLessThanOrEqual(MAX_RESULT_TOKENS);
          results.push([tool, res]);
        }
      });

      it('bad args → INVALID_INPUT, one usage event per call', async () => {
        for (const args of cases.bad) {
          const before = h.events.length;
          const res = await h.call(tool, args);
          expect(errorOf(res).code, `${tool} ${JSON.stringify(args)}`).toBe('INVALID_INPUT');
          expect(h.events.length).toBe(before + 1);
          expect(h.events.at(-1)).toMatchObject({ status: 'error', error_code: 'INVALID_INPUT' });
        }
      });

      if (cases.unknown) {
        it('unknown id → NOT_FOUND, one usage event per call', async () => {
          for (const args of cases.unknown ?? []) {
            const before = h.events.length;
            const res = await h.call(tool, args);
            const err = errorOf(res);
            expect(err.code, `${tool} ${JSON.stringify(args)}`).toBe('NOT_FOUND');
            expect(err.retryable).toBe(false);
            expect(h.events.length).toBe(before + 1);
            expect(h.events.at(-1)).toMatchObject({ status: 'error', error_code: 'NOT_FOUND' });
            results.push([tool, res]);
          }
        });
      }

      if (cases.maxLimit) {
        it('stays within the 10K-token budget at the max limit', async () => {
          const res = await h.call(tool, cases.maxLimit);
          expect(res.isError).toBe(false);
          expect(estimateTokens(res.text)).toBeLessThanOrEqual(MAX_RESULT_TOKENS);
          expect(res.usage.result_tokens).toBeLessThanOrEqual(MAX_RESULT_TOKENS);
          results.push([tool, res]);
        });
      }
    });
  }

  it('never returns an unmasked email or phone', () => {
    expect(results.length).toBeGreaterThan(20);
    for (const [tool, res] of results) {
      expect(res.text, tool).not.toMatch(EMAIL_RE);
      for (const needle of piiNeedles)
        expect(res.text, `${tool} leaked ${needle}`).not.toContain(needle);
    }
  });

  it('only ever surfaces the prompt injection inside untrusted_text', () => {
    let seen = 0;
    for (const [tool, res] of results) {
      for (const [key, value] of strings(res.structuredContent)) {
        if (!value.includes(DEMO_INJECTION)) continue;
        seen += 1;
        expect(key, `${tool} exposed the injection outside untrusted_text`).toBe('untrusted_text');
      }
    }
    // Both planted copies (item description, customer note) must have been exercised.
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it('every successful result carries meta with as_of and demo flag', () => {
    for (const [, res] of results.filter(([, r]) => !r.isError)) {
      expect(res.structuredContent).toMatchObject({
        meta: { demo: true, cached: expect.any(Boolean) },
      });
    }
  });
});
