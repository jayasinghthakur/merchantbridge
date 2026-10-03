import type { Money, UntrustedText } from '@mb/core';
import { maskEmail, maskPhone, toMoney, untrusted } from '@mb/core';
import type {
  Customer,
  InvoiceDetail,
  InvoiceSummary,
  ItemDetail,
  ItemSummary,
  Payment,
  SalesOrderDetail,
  SalesOrderSummary,
  Shipment,
} from './schemas';
import type {
  UpstreamContact,
  UpstreamInvoice,
  UpstreamItem,
  UpstreamPayment,
  UpstreamSalesOrder,
} from './upstream';

/** Upper bound on embedded line items, so one huge order cannot blow the 10K-token result budget. */
export const MAX_LINE_ITEMS = 50;

export function money(amount: number | null, currency: string | null): Money | null {
  if (amount === null || currency === null) return null;
  return toMoney(amount, currency);
}

const MAX_PII_SCAN_CHARS = 2_000;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Ten or more digits, optionally grouped by single spaces/hyphens, with an optional +country prefix. */
const PHONE_IN_TEXT = /(?:\+\d{1,3}[\s-]?)?\d(?:[\s-]?\d){9,}/g;

/**
 * Masks emails and phone numbers embedded in names and free text exactly like the dedicated fields: Zoho
 * contacts imported from marketplaces are often *named* by their email, and notes carry alternate numbers.
 * Never applied to identifiers (reference numbers, UTRs, tracking numbers), which agents match on.
 */
export function maskPii(text: string | null): string | null {
  if (text === null) return null;
  // Outputs keep at most 500 chars of free text, so scanning more only costs regex time on huge notes.
  const bounded = text.length > MAX_PII_SCAN_CHARS ? text.slice(0, MAX_PII_SCAN_CHARS) : text;
  return bounded
    .replace(EMAIL_IN_TEXT, (m) => maskEmail(m) ?? '***')
    .replace(PHONE_IN_TEXT, (m) => maskPhone(m) ?? '***');
}

function untrustedText(text: string | null, maxChars?: number): UntrustedText | null {
  return untrusted(maskPii(text), maxChars);
}

/** Zoho dates are `yyyy-mm-dd` (or timestamps starting with it); anything else becomes null. */
export function isoDate(s: string | null): string | null {
  if (s === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
  return m?.[1] ?? null;
}

const sumOrNull = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
};

function stockTotals(item: UpstreamItem): { onHand: number | null; available: number | null } {
  // Per-location stock is documented; item-level totals on /items are UNVERIFIED, so prefer locations.
  const onHand = sumOrNull(item.locations.map((l) => l.location_stock_on_hand));
  const available = sumOrNull(item.locations.map((l) => l.location_available_stock));
  return {
    onHand: onHand ?? item.stock_on_hand,
    available: available ?? item.available_stock ?? item.actual_available_stock,
  };
}

export function toItemSummary(item: UpstreamItem, currency: string | null): ItemSummary {
  const { onHand, available } = stockTotals(item);
  return {
    item_id: item.item_id,
    name: item.name,
    sku: item.sku,
    status: item.status,
    unit: item.unit,
    rate: money(item.rate, currency),
    stock_on_hand: onHand,
    available_stock: available,
    reorder_level: item.reorder_level,
    low_stock: onHand === null || item.reorder_level === null ? null : onHand <= item.reorder_level,
  };
}

export function toItemDetail(item: UpstreamItem, currency: string | null): ItemDetail {
  return {
    ...toItemSummary(item, currency),
    item_type: item.item_type,
    description: untrustedText(item.description),
    locations: item.locations.map((l) => ({
      location_id: l.location_id,
      location_name: l.location_name,
      is_primary: l.is_primary,
      stock_on_hand: l.location_stock_on_hand,
      available_stock: l.location_available_stock,
      actual_available_stock: l.location_actual_available_stock,
    })),
  };
}

export function toCustomer(
  c: UpstreamContact,
  fallbackCurrency: string | null,
  withNotes: boolean,
): Customer {
  const primary = c.contact_persons.find((p) => p.is_primary_contact) ?? c.contact_persons[0];
  return {
    contact_id: c.contact_id,
    name: maskPii(c.contact_name),
    company_name: maskPii(c.company_name),
    contact_type: c.contact_type,
    status: c.status,
    email: maskEmail(c.email ?? primary?.email),
    phone: maskPhone(c.phone ?? primary?.phone),
    mobile: maskPhone(c.mobile ?? primary?.mobile),
    city: c.billing_address?.city ?? null,
    outstanding_receivable: money(
      c.outstanding_receivable_amount,
      c.currency_code ?? fallbackCurrency,
    ),
    notes: withNotes ? untrustedText(c.notes) : null,
  };
}

export function toSalesOrderSummary(so: UpstreamSalesOrder): SalesOrderSummary {
  return {
    salesorder_id: so.salesorder_id,
    salesorder_number: so.salesorder_number,
    date: isoDate(so.date),
    status: so.status,
    customer_id: so.customer_id ?? null,
    customer_name: maskPii(so.customer_name),
    reference_number: so.reference_number,
    total: money(so.total, so.currency_code),
    shipment_date: isoDate(so.shipment_date),
  };
}

/**
 * Only an explicit "delivered" status counts: free text such as "Out for Delivery", "Undelivered" or
 * "Delivery attempted" mentions delivery without meaning it happened, and dispute evidence must not claim it.
 */
function isDelivered(status: string | null, message: string | null): boolean {
  const is = (s: string | null): boolean => (s ?? '').trim().toLowerCase() === 'delivered';
  return is(status) || is(message);
}

export function toShipments(so: UpstreamSalesOrder): Shipment[] {
  return so.packages.map((p) => ({
    package_id: p.package_id,
    package_number: p.package_number,
    status: p.status,
    delivered: isDelivered(p.status, p.status_message),
    shipment_id: p.shipment_id,
    shipment_number: p.shipment_number,
    carrier: p.carrier,
    service: p.service,
    tracking_number: p.tracking_number,
    shipment_date: isoDate(p.shipment_date),
    courier_status: untrustedText(p.detailed_status ?? p.status_message, 200),
  }));
}

export function toSalesOrderDetail(so: UpstreamSalesOrder): SalesOrderDetail {
  const currency = so.currency_code;
  return {
    ...toSalesOrderSummary(so),
    delivery_method: so.delivery_method,
    location_name: so.location_name,
    sub_total: money(so.sub_total, currency),
    tax_total: money(so.tax_total, currency),
    shipping_charge: money(so.shipping_charge, currency),
    line_items: so.line_items.slice(0, MAX_LINE_ITEMS).map((l) => ({
      line_item_id: l.line_item_id,
      item_id: l.item_id ?? null,
      name: l.name,
      quantity: l.quantity,
      quantity_shipped: l.quantity_shipped,
      quantity_invoiced: l.quantity_invoiced,
      rate: money(l.rate, currency),
      item_total: money(l.item_total, currency),
    })),
    line_items_truncated: so.line_items.length > MAX_LINE_ITEMS,
    shipments: toShipments(so),
    invoices: so.invoices.map((i) => ({
      invoice_id: i.invoice_id,
      invoice_number: i.invoice_number,
      status: i.status,
      date: isoDate(i.date),
      due_date: isoDate(i.due_date),
      total: money(i.total, currency),
      balance: money(i.balance, currency),
    })),
    notes: untrustedText(so.notes),
  };
}

export function toInvoiceSummary(inv: UpstreamInvoice): InvoiceSummary {
  return {
    invoice_id: inv.invoice_id,
    invoice_number: inv.invoice_number,
    status: inv.status,
    customer_id: inv.customer_id ?? null,
    customer_name: maskPii(inv.customer_name),
    date: isoDate(inv.date),
    due_date: isoDate(inv.due_date),
    reference_number: inv.reference_number,
    total: money(inv.total, inv.currency_code),
    balance: money(inv.balance, inv.currency_code),
  };
}

export function toInvoiceDetail(inv: UpstreamInvoice): InvoiceDetail {
  const currency = inv.currency_code;
  return {
    ...toInvoiceSummary(inv),
    payment_made: money(inv.payment_made, currency),
    last_payment_date: isoDate(inv.last_payment_date),
    salesorder:
      inv.salesorder_id === null
        ? null
        : { salesorder_id: inv.salesorder_id, salesorder_number: inv.salesorder_number },
    line_items: inv.line_items.slice(0, MAX_LINE_ITEMS).map((l) => ({
      line_item_id: l.line_item_id,
      item_id: l.item_id ?? null,
      name: l.name,
      quantity: l.quantity,
      rate: money(l.rate, currency),
      item_total: money(l.item_total, currency),
    })),
    line_items_truncated: inv.line_items.length > MAX_LINE_ITEMS,
    notes: untrustedText(inv.notes),
  };
}

export function toPayment(p: UpstreamPayment, fallbackCurrency: string | null): Payment {
  const currency = p.currency_code ?? fallbackCurrency;
  const invoices = p.invoices.map((i) => ({
    invoice_id: i.invoice_id,
    invoice_number: i.invoice_number,
    amount_applied: money(i.amount_applied, currency),
  }));
  return {
    payment_id: p.payment_id,
    payment_number: p.payment_number,
    date: isoDate(p.date),
    payment_mode: p.payment_mode,
    reference_number: p.reference_number,
    amount: money(p.amount, currency),
    unused_amount: money(p.unused_amount, currency),
    customer_id: p.customer_id ?? null,
    customer_name: maskPii(p.customer_name),
    invoices,
  };
}
