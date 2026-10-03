import { ConnectorError } from '@mb/core';
import { z } from 'zod';
import { toInvoiceDetail } from '../mappers';
import { invoiceDetailSchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import { READ_ONLY, defineTool, exactlyOne, idInput, namedNotFound } from './shared';

const input = z
  .object({
    invoice_id: idInput('Zoho invoice_id').optional(),
    invoice_number: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Invoice number, e.g. "INV-00005".'),
  })
  .refine(
    exactlyOne(['invoice_id', 'invoice_number']),
    'Provide exactly one of invoice_id or invoice_number.',
  );

export const getInvoice = defineTool({
  name: 'zoho_get_invoice',
  title: 'Get invoice',
  description:
    'Returns one invoice by invoice_id or invoice number: status, dates, total, amount paid, balance due ' +
    '(minor units), line items, notes and the linked sales order when Zoho provides it. Use when the user ' +
    "asks about a specific invoice or you need its line items or sales order link. Don't use to filter many " +
    'invoices (use zoho_list_invoices) or to resolve a payment id (use zoho_find_by_payment_reference). Pass ' +
    `exactly one of invoice_id or invoice_number. ${READ_ONLY}`,
  input,
  output: invoiceDetailSchema,
  scopes: [SCOPE.invoices],
  async handler(args, ctx) {
    const client = ctx.client;
    let id = args.invoice_id;
    if (id === undefined) {
      const number = args.invoice_number ?? '';
      const res = await client.get('invoices', { invoice_number: number, per_page: 10 });
      const hit = parseUpstream(envelopes.invoices, res.body).invoices.find(
        (inv) => (inv.invoice_number ?? '').toUpperCase() === number.toUpperCase(),
      );
      if (!hit) {
        throw new ConnectorError('NOT_FOUND', `No invoice numbered ${number} was found.`, {
          hint: 'Check the number, or use zoho_list_invoices with a customer_id.',
        });
      }
      id = hit.invoice_id;
    }
    const res = await namedNotFound(
      client.get(`invoices/${id}`),
      `No invoice with invoice_id ${id} was found.`,
    );
    const invoice = parseUpstream(envelopes.invoice, res.body).invoice;
    return {
      data: toInvoiceDetail(invoice),
      upstreamUrl: client.webUrl('invoice', invoice.invoice_id),
    };
  },
});
