import { isConnectorError } from '@mb/core';
import { z } from 'zod';
import type { ZohoApi, ZohoQuery } from '../client';
import { toInvoiceSummary, toPayment, toShipments, isoDate } from '../mappers';
import { invoiceSummarySchema, paymentSchema, shipmentSchema } from '../schemas';
import { SCOPE } from '../scopes';
import type { UpstreamInvoice } from '../upstream';
import { envelopes, parseUpstream } from '../upstream';
import { READ_ONLY, defineTool } from './shared';

export const REFERENCE_KINDS = [
  'razorpay_payment',
  'razorpay_order',
  'razorpay_refund',
  'upi_utr',
  'other',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export function classifyReference(ref: string): ReferenceKind {
  if (/^pay_[A-Za-z0-9]{4,40}$/.test(ref)) return 'razorpay_payment';
  if (/^order_[A-Za-z0-9]{4,40}$/.test(ref)) return 'razorpay_order';
  if (/^rfnd_[A-Za-z0-9]{4,40}$/.test(ref)) return 'razorpay_refund';
  if (/^\d{12}$/.test(ref)) return 'upi_utr';
  return 'other';
}

const MAX_UPSTREAM_CALLS = 5;
const MAX_MATCHES = 5;

const str = z.string().nullable();

const linkedInvoiceSchema = invoiceSummarySchema.extend({
  salesorder: z.object({ salesorder_id: z.string(), salesorder_number: str }).nullable(),
});

const matchSchema = z.object({
  confidence: z
    .enum(['exact', 'partial'])
    .describe('exact = reference equals the input; partial = contains it.'),
  matched_on: z.enum(['customer_payment.reference_number', 'invoice.reference_number']),
  payment: paymentSchema.nullable(),
  invoices: z
    .array(linkedInvoiceSchema)
    .describe('Invoices fetched for this match (the payment lists all it paid).'),
  sales_order: z
    .object({
      salesorder_id: z.string(),
      salesorder_number: str,
      status: str,
      date: str,
      shipments: z.array(shipmentSchema),
    })
    .nullable(),
  resolved: z
    .boolean()
    .describe('False when the call budget ran out before invoices / sales order were fetched.'),
});

type Match = z.output<typeof matchSchema>;

const output = z.object({
  reference: z.string(),
  kind: z.enum(REFERENCE_KINDS),
  matches: z.array(matchSchema),
  upstream_calls: z.number().int(),
  notes: z.array(z.string()),
});

const input = z.object({
  reference: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_\-./]+$/, 'letters, digits, _ - . / only')
    .describe(
      'Razorpay payment id (pay_…), order id (order_…), refund id (rfnd_…), 12-digit UPI UTR, or other reference.',
    ),
});

/** Counts upstream calls so the tool never exceeds its documented budget. */
class Budget {
  used = 0;
  constructor(private readonly client: ZohoApi) {}
  get left(): number {
    return MAX_UPSTREAM_CALLS - this.used;
  }
  async get(path: string, query?: ZohoQuery): Promise<unknown> {
    this.used += 1;
    return (await this.client.get(path, query)).body;
  }
}

/**
 * A record linked from a match can be deleted in Zoho after the link was made. Its absence is reported as a
 * note; failing the whole call would also throw away the payment that did match.
 */
async function unlessGone<T>(work: Promise<T>, notes: string[], what: string): Promise<T | null> {
  try {
    return await work;
  } catch (e) {
    if (!isConnectorError(e) || e.code !== 'NOT_FOUND') throw e;
    const note = `A linked ${what} no longer exists in Zoho; the chain stops there.`;
    if (!notes.includes(note)) notes.push(note);
    return null;
  }
}

async function linkInvoice(
  budget: Budget,
  invoiceId: string,
  notes: string[],
): Promise<{ invoice: UpstreamInvoice } | null> {
  if (budget.left < 1) return null;
  const body = await unlessGone(budget.get(`invoices/${invoiceId}`), notes, 'invoice');
  return body === null ? null : { invoice: parseUpstream(envelopes.invoice, body).invoice };
}

async function resolveChain(
  budget: Budget,
  match: Match,
  invoiceIds: string[],
  notes: string[],
): Promise<void> {
  const firstId = invoiceIds[0];
  if (firstId === undefined) {
    match.resolved = true;
    return;
  }
  const linked = await linkInvoice(budget, firstId, notes);
  if (!linked) return;
  const inv = linked.invoice;
  const soId = inv.salesorder_id;
  match.invoices.push({
    ...toInvoiceSummary(inv),
    salesorder:
      soId === null ? null : { salesorder_id: soId, salesorder_number: inv.salesorder_number },
  });
  if (soId === null) {
    match.resolved = invoiceIds.length === 1;
    return;
  }
  if (budget.left < 1) return;
  const soBody = await unlessGone(budget.get(`salesorders/${soId}`), notes, 'sales order');
  if (soBody === null) return;
  const so = parseUpstream(envelopes.salesorder, soBody).salesorder;
  match.sales_order = {
    salesorder_id: so.salesorder_id,
    salesorder_number: so.salesorder_number,
    status: so.status,
    date: isoDate(so.date),
    shipments: toShipments(so),
  };
  match.resolved = invoiceIds.length === 1;
}

export const findByPaymentReference = defineTool({
  name: 'zoho_find_by_payment_reference',
  title: 'Find by payment reference',
  description:
    'Traces a payment reference to Zoho records: customer payment → invoice(s) it paid → the sales order with ' +
    'its shipments (carrier, tracking, delivered flag). Accepts Razorpay pay_/order_/rfnd_ ids, 12-digit UPI ' +
    'UTRs or any reference; searches customer payments (reference contains) and falls back to invoice ' +
    'reference numbers. Each match has confidence exact|partial. Use first for disputes, chargebacks, refunds ' +
    "or settlement questions that start from a payment id. Don't use when you already have an invoice or " +
    'sales order (use zoho_get_invoice / zoho_get_sales_order). At most 5 upstream calls; fully resolves the ' +
    `best match only. ${READ_ONLY}`,
  input,
  output,
  scopes: [SCOPE.customerpayments, SCOPE.invoices, SCOPE.salesorders],
  async handler(args, ctx) {
    const ref = args.reference;
    const kind = classifyReference(ref);
    const budget = new Budget(ctx.client);
    const notes: string[] = [];
    const matches: Match[] = [];

    const list = parseUpstream(
      envelopes.customerpayments,
      await budget.get('customerpayments', { reference_number_contains: ref, per_page: 25 }),
    );
    const hits = list.customerpayments
      .filter((p) => (p.reference_number ?? '').toLowerCase().includes(ref.toLowerCase()))
      .sort((a, b) => Number(b.reference_number === ref) - Number(a.reference_number === ref))
      .slice(0, MAX_MATCHES);

    for (const [i, p] of hits.entries()) {
      const match: Match = {
        confidence: p.reference_number === ref ? 'exact' : 'partial',
        matched_on: 'customer_payment.reference_number',
        payment: toPayment(p, null),
        invoices: [],
        sales_order: null,
        resolved: false,
      };
      matches.push(match);
      // Only the best match gets the full chain; the next one gets its payment detail if budget remains.
      if (i > 1 || budget.left < 1) continue;
      const detailBody = await unlessGone(
        budget.get(`customerpayments/${p.payment_id}`),
        notes,
        'customer payment',
      );
      if (detailBody === null) continue;
      const detail = parseUpstream(envelopes.payment, detailBody).payment;
      match.payment = toPayment(detail, null);
      if (i === 0)
        await resolveChain(
          budget,
          match,
          detail.invoices.map((inv) => inv.invoice_id),
          notes,
        );
    }

    if (hits.length === 0) {
      const byInvoice = parseUpstream(
        envelopes.invoices,
        await budget.get('invoices', { reference_number: ref, per_page: 25 }),
      ).invoices.filter((inv) => inv.reference_number === ref);
      for (const [i, inv] of byInvoice.slice(0, MAX_MATCHES).entries()) {
        const match: Match = {
          confidence: 'exact',
          matched_on: 'invoice.reference_number',
          payment: null,
          invoices: [],
          sales_order: null,
          resolved: false,
        };
        matches.push(match);
        if (i === 0) await resolveChain(budget, match, [inv.invoice_id], notes);
        else match.invoices.push({ ...toInvoiceSummary(inv), salesorder: null });
      }
    }

    if (kind === 'razorpay_refund')
      notes.push('Refund ids (rfnd_) are rarely recorded in Zoho; absence is not proof.');
    if (kind === 'upi_utr')
      notes.push(
        '12-digit numbers may be UPI UTRs or unrelated references; check partial matches.',
      );
    if (matches.length === 0)
      notes.push('No customer payment or invoice in Zoho references this value.');
    if (matches.some((m) => !m.resolved)) {
      notes.push(
        'Some matches were not fully resolved; use zoho_get_invoice / zoho_get_sales_order for details.',
      );
    }

    const best = matches[0];
    const upstreamUrl = best?.payment
      ? ctx.client.webUrl('payment', best.payment.payment_id)
      : best?.invoices[0]
        ? ctx.client.webUrl('invoice', best.invoices[0].invoice_id)
        : null;
    return {
      data: { reference: ref, kind, matches, upstream_calls: budget.used, notes },
      upstreamUrl,
    };
  },
});
