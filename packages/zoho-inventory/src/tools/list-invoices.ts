import { z } from 'zod';
import { toInvoiceSummary } from '../mappers';
import { invoiceSummarySchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import {
  READ_ONLY,
  cursorInput,
  dateInput,
  defineTool,
  fingerprint,
  idInput,
  limitInput,
  pageRows,
  readPageCursor,
} from './shared';

/** invoices.yml `status` allowed values. */
export const INVOICE_STATUSES = [
  'unpaid',
  'overdue',
  'partially_paid',
  'paid',
  'sent',
  'viewed',
  'draft',
  'void',
] as const;

const input = z.object({
  status: z
    .enum(INVOICE_STATUSES)
    .optional()
    .describe(
      'Invoice status. "unpaid" includes every issued invoice with a balance due (overdue included).',
    ),
  customer_id: idInput(
    'Only invoices of this customer (contact_id from zoho_search_customers)',
  ).optional(),
  due_from: dateInput('Only invoices due on or after this date').optional(),
  due_to: dateInput('Only invoices due on or before this date').optional(),
  invoice_number: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Exact invoice number, e.g. "INV-00005".'),
  reference_number: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Exact invoice reference number (sometimes a Razorpay pay_/order_ id or the sales order number).',
    ),
  limit: limitInput,
  cursor: cursorInput,
});

export const listInvoices = defineTool({
  name: 'zoho_list_invoices',
  title: 'List invoices',
  description:
    'Lists invoices with number, status, customer, invoice and due dates, reference number, total and balance ' +
    'due (minor units). Filters run in Zoho: status (unpaid/overdue/paid/...), customer_id, due date range, ' +
    'invoice_number, reference_number. Use for receivables questions ("unpaid invoices due this week"), a ' +
    "customer's invoices, or settlement checks. Don't use to trace a Razorpay payment id (use " +
    'zoho_find_by_payment_reference) or to see line items (use zoho_get_invoice). Up to 100 per page. ' +
    READ_ONLY,
  input,
  output: z.object({ invoices: z.array(invoiceSummarySchema) }),
  scopes: [SCOPE.invoices],
  async handler(args, ctx) {
    const { limit, cursor, ...filters } = args;
    const state = readPageCursor(cursor, limit, fingerprint(filters));
    const res = await ctx.client.get('invoices', {
      page: state.page,
      per_page: state.perPage,
      status: filters.status,
      customer_id: filters.customer_id,
      due_date_start: filters.due_from,
      due_date_end: filters.due_to,
      invoice_number: filters.invoice_number,
      reference_number: filters.reference_number,
    });
    const body = parseUpstream(envelopes.invoices, res.body);
    const { rows, page } = pageRows(
      state,
      body.invoices.map(toInvoiceSummary),
      body.page_context.has_more_page,
    );
    return { data: { invoices: rows }, page, upstreamUrl: null };
  },
});
