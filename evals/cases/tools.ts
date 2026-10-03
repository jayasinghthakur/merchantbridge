import type { EvalCase } from '../src/case';
import { RUPEE_AMOUNT } from './patterns';

/**
 * Tool-specific cases: one question per capability a scenario card does not already exercise the same way.
 * Facts come from the FakeZoho demo dataset and are re-checked against real tool results in CI
 * (test/scripted-paths.test.ts).
 */

/** Partial name → Ishita Banerjee (Mumbai). */
export const toolSearchCustomers: EvalCase = {
  id: 'tool-search-customers-partial',
  kind: 'tool',
  title: 'Search customers by partial name',
  prompt:
    'Find the customer whose name contains "Banerj". What is their full name, which city are they in, and how much do they owe us?',
  expect: {
    tools: ['zoho_search_customers'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'finds Ishita Banerjee', pattern: /\bIshita Banerjee\b/i },
      { type: 'matches', label: 'gives the city (Mumbai)', pattern: /\bMumbai\b/i },
    ],
  },
};

/** INV-00004 (overdue 9 days) and INV-00009 (overdue 3 days). */
export const toolListOverdueInvoices: EvalCase = {
  id: 'tool-list-overdue-invoices',
  kind: 'tool',
  title: 'List overdue invoices',
  prompt:
    'List every overdue invoice with its customer, the balance still due and how many days overdue it is.',
  expect: {
    tools: ['zoho_list_invoices'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'lists INV-00004', pattern: /\bINV-00004\b/ },
      { type: 'matches', label: 'lists INV-00009', pattern: /\bINV-00009\b/ },
      { type: 'matches', label: 'gives balances in rupees', pattern: RUPEE_AMOUNT },
    ],
  },
};

/** SO-00016: shipped with Blue Dart (11-digit tracking starting with 8), in transit, not delivered. */
export const toolGetSalesOrder: EvalCase = {
  id: 'tool-get-sales-order',
  kind: 'tool',
  title: 'Get a sales order by its number',
  prompt:
    "What's the status of sales order SO-00016? Which carrier has it, what's the tracking number, and has it been delivered yet?",
  expect: {
    tools: ['zoho_get_sales_order'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'names the carrier (Blue Dart)', pattern: /\bBlue ?Dart\b/i },
      {
        type: 'matches',
        label: 'gives the Blue Dart tracking number',
        pattern: /\b8\d{10}\b/,
      },
      {
        type: 'matches',
        label: 'says it is in transit / not delivered yet',
        pattern:
          /\bin[- ]transit\b|\bnot (?:yet )?(?:been )?delivered\b|n't (?:yet )?(?:been )?delivered\b|\bundelivered\b/i,
      },
    ],
  },
};

/** UPI UTR 412345678901 → Kavya Nair's payment that settled INV-00002 (SO-00002). */
export const toolPaymentByUtr: EvalCase = {
  id: 'tool-payment-by-utr',
  kind: 'tool',
  title: 'Payment lookup by UPI UTR',
  prompt:
    'A customer says they paid us by UPI and gave the UTR 412345678901. Which invoice did that payment settle, and who is the customer?',
  expect: {
    tools: ['zoho_find_by_payment_reference'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'names the invoice INV-00002', pattern: /\bINV-00002\b/ },
      { type: 'matches', label: 'names the customer (Kavya Nair)', pattern: /\bKavya Nair\b/i },
    ],
  },
};

/** Active items at or below reorder level: DARJ-FF-100, OOLONG-50, SAFF-1, KETTLE-CI. */
export const toolLowStockItems: EvalCase = {
  id: 'tool-low-stock-items',
  kind: 'tool',
  title: 'Low-stock items',
  prompt:
    'Which active items are at or below their reorder level right now? Give the SKU and stock on hand for each.',
  expect: {
    tools: ['zoho_search_items'],
    maxToolCalls: 4,
    text: [
      {
        type: 'mentions_at_least',
        label: 'names all 4 low-stock items',
        min: 4,
        patterns: [
          /\bDARJ-FF-100\b|\bDarjeeling First Flush\b/i,
          /\bOOLONG-50\b|\bKangra Oolong\b/i,
          /\bSAFF-1\b|\bSaffron 1 ?g\b/i,
          /\bKETTLE-CI\b|\bCast Iron Kettle\b/i,
        ],
      },
    ],
  },
};

/** Demo org "Chai & Co (DEMO)"; demo free plan budget is 500 calls/day (50% of 1,000), fresh per session. */
export const toolConnectionStatus: EvalCase = {
  id: 'tool-connection-status',
  kind: 'tool',
  title: 'Connection status and budget',
  prompt:
    "Which Zoho Inventory organization is this agent connected to, and how many Zoho API calls are left in today's budget?",
  expect: {
    tools: ['zoho_get_connection_status'],
    maxToolCalls: 2,
    text: [
      {
        type: 'matches',
        label: 'names the organization (Chai & Co)',
        pattern: /\bChai\s*&\s*Co\b/i,
      },
      {
        type: 'matches',
        label: "gives today's remaining call budget (≈500)",
        pattern: /\b(?:4\d\d|500)\b/,
      },
    ],
  },
};

/** Bulk stock check: CHAI-250 has 38 available at Bengaluru; ASSAM-500 is also stocked there. */
export const toolCheckStock: EvalCase = {
  id: 'tool-check-stock',
  kind: 'tool',
  title: 'Bulk stock check for a cart',
  prompt:
    'A customer wants CHAI-250 and ASSAM-500 in one order. How many units of each are available at the Bengaluru Warehouse right now?',
  expect: {
    tools: ['zoho_check_stock'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'covers CHAI-250', pattern: /\bCHAI-250\b|\bMasala Chai\b/i },
      { type: 'matches', label: 'covers ASSAM-500', pattern: /\bASSAM-500\b|\bAssam CTC\b/i },
      { type: 'matches', label: 'gives the CHAI-250 Bengaluru count (38)', pattern: /\b38\b/ },
    ],
  },
};

/** INV-00004: Arjun Reddy, overdue, ₹1,533.32 balance, for SO-00005. */
export const toolGetInvoice: EvalCase = {
  id: 'tool-get-invoice',
  kind: 'tool',
  title: 'Get an invoice by its number',
  prompt:
    'Pull up invoice INV-00004. Who is the customer, how much is still due, and which sales order is it for?',
  expect: {
    tools: ['zoho_get_invoice'],
    maxToolCalls: 3,
    text: [
      { type: 'matches', label: 'names the customer (Arjun Reddy)', pattern: /\bArjun Reddy\b/i },
      { type: 'matches', label: 'gives the balance (₹1,533.32)', pattern: /1,?533\.32/ },
      { type: 'matches', label: 'names the sales order SO-00005', pattern: /\bSO-00005\b/ },
    ],
  },
};

export const toolCases: readonly EvalCase[] = [
  toolSearchCustomers,
  toolListOverdueInvoices,
  toolGetSalesOrder,
  toolPaymentByUtr,
  toolLowStockItems,
  toolConnectionStatus,
  toolCheckStock,
  toolGetInvoice,
];
