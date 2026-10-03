import { ConnectorError } from '@mb/core';
import { z } from 'zod';

/**
 * Lenient parsers for Zoho response bodies (shapes from docs/vendor/zoho/*.yml). They normalise the wire quirks
 * (numeric vs string ids, " " for empty, numbers as strings) and strip every field we do not use.
 */

const text = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s.trim() === '' ? null : s;
  });

const id = z.union([z.string(), z.number()]).transform((v) => String(v));

const num = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

const bool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);

const list = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);

export const pageContextSchema = z
  .object({ page: num, per_page: num, has_more_page: bool })
  .nullish()
  .transform((v) => ({ has_more_page: v?.has_more_page ?? false }));

// ---------- organizations ----------

export const zOrganization = z.object({
  organization_id: id,
  name: text,
  currency_code: text,
  time_zone: text,
  is_org_active: bool,
});

// ---------- items ----------

export const zItemLocation = z.object({
  location_id: id,
  location_name: text,
  status: text,
  is_primary: bool,
  location_stock_on_hand: num,
  location_available_stock: num,
  location_actual_available_stock: num,
});

export const zItem = z.object({
  item_id: id,
  name: text,
  sku: text,
  status: text,
  description: text,
  rate: num,
  unit: text,
  item_type: text,
  reorder_level: num,
  // UNVERIFIED on /items and /items/{id}: documented only on item variants/masters.
  stock_on_hand: num,
  available_stock: num,
  actual_available_stock: num,
  locations: list(zItemLocation),
});

export type UpstreamItem = z.output<typeof zItem>;

// ---------- contacts ----------

export const zContactPerson = z.object({
  email: text,
  phone: text,
  mobile: text,
  is_primary_contact: bool,
});

export const zContact = z.object({
  contact_id: id,
  contact_name: text,
  company_name: text,
  contact_type: text,
  status: text,
  currency_code: text,
  outstanding_receivable_amount: num,
  email: text,
  phone: text,
  mobile: text,
  notes: text,
  contact_persons: list(zContactPerson),
  billing_address: z.object({ city: text, state: text }).nullish(),
});

export type UpstreamContact = z.output<typeof zContact>;

// ---------- sales orders ----------

export const zSalesOrderLine = z.object({
  line_item_id: id,
  item_id: id.nullish(),
  name: text,
  description: text,
  rate: num,
  quantity: num,
  quantity_invoiced: num,
  quantity_packed: num,
  quantity_shipped: num,
  unit: text,
  item_total: num,
  location_name: text,
});

export const zSalesOrderPackage = z.object({
  package_id: id,
  package_number: text,
  status: text,
  detailed_status: text,
  status_message: text,
  shipment_id: text,
  shipment_number: text,
  carrier: text,
  service: text,
  tracking_number: text,
  shipment_date: text,
  delivery_days: num,
});

export const zSalesOrderInvoice = z.object({
  invoice_id: id,
  invoice_number: text,
  status: text,
  date: text,
  due_date: text,
  total: num,
  balance: num,
});

export const zSalesOrder = z.object({
  salesorder_id: id,
  salesorder_number: text,
  date: text,
  status: text,
  shipment_date: text,
  reference_number: text,
  customer_id: id.nullish(),
  customer_name: text,
  currency_code: text,
  total: num,
  sub_total: num,
  tax_total: num,
  shipping_charge: num,
  delivery_method: text,
  location_name: text,
  notes: text,
  line_items: list(zSalesOrderLine),
  packages: list(zSalesOrderPackage),
  invoices: list(zSalesOrderInvoice),
});

export type UpstreamSalesOrder = z.output<typeof zSalesOrder>;

// ---------- invoices ----------

export const zInvoiceLine = z.object({
  line_item_id: id,
  item_id: id.nullish(),
  name: text,
  rate: num,
  quantity: num,
  item_total: num,
});

export const zInvoice = z.object({
  invoice_id: id,
  invoice_number: text,
  status: text,
  date: text,
  due_date: text,
  reference_number: text,
  customer_id: id.nullish(),
  customer_name: text,
  currency_code: text,
  total: num,
  balance: num,
  payment_made: num,
  last_payment_date: text,
  notes: text,
  line_items: list(zInvoiceLine),
  // UNVERIFIED: not in invoices.yml (see fake/wire.ts WireInvoice.salesorder_id).
  salesorder_id: text,
  salesorder_number: text,
});

export type UpstreamInvoice = z.output<typeof zInvoice>;

// ---------- customer payments ----------

export const zPaymentInvoice = z.object({
  invoice_id: id,
  invoice_number: text,
  amount_applied: num,
  balance_amount: num,
});

export const zPayment = z.object({
  payment_id: id,
  payment_number: text,
  date: text,
  payment_mode: text,
  amount: num,
  unused_amount: num,
  reference_number: text,
  description: text,
  customer_id: id.nullish(),
  customer_name: text,
  currency_code: text,
  /** List rows carry a comma-separated `invoice_number`; detail rows carry `invoices[]`. */
  invoice_number: text,
  invoices: list(zPaymentInvoice),
});

export type UpstreamPayment = z.output<typeof zPayment>;

// ---------- envelopes ----------

export const envelopes = {
  organization: z.object({ organization: zOrganization }),
  items: z.object({ items: list(zItem), page_context: pageContextSchema }),
  item: z.object({ item: zItem }),
  contacts: z.object({ contacts: list(zContact), page_context: pageContextSchema }),
  contact: z.object({ contact: zContact }),
  salesorders: z.object({ salesorders: list(zSalesOrder), page_context: pageContextSchema }),
  salesorder: z.object({ salesorder: zSalesOrder }),
  invoices: z.object({ invoices: list(zInvoice), page_context: pageContextSchema }),
  invoice: z.object({ invoice: zInvoice }),
  customerpayments: z.object({ customerpayments: list(zPayment), page_context: pageContextSchema }),
  payment: z.object({ payment: zPayment }),
} as const;

/** Parses an upstream body; a shape mismatch is a non-retryable UPSTREAM_ERROR (never echoes the body). */
export function parseUpstream<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const res = schema.safeParse(body);
  if (!res.success) {
    throw new ConnectorError(
      'UPSTREAM_ERROR',
      'Zoho Inventory returned data in an unexpected shape.',
      {
        retryable: false,
        hint: 'This is a connector bug; try a different query or report it.',
      },
    );
  }
  return res.data;
}
