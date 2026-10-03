/**
 * Static copy of the Tier-1 tool surface (docs/PLAN.md §4), shown on /docs when the live /api/tools call fails.
 * The live list from the API is authoritative.
 */
export interface StaticTool {
  name: string;
  summary: string;
}

export const STATIC_TOOLS: readonly StaticTool[] = [
  {
    name: 'zoho_find_by_payment_reference',
    summary: 'Razorpay payment reference (pay_ / order_ / rfnd_) to the customer payment and invoices it settled.',
  },
  {
    name: 'zoho_get_connection_status',
    summary: 'Organization, data center, plan, granted scopes, remaining daily budget and circuit state.',
  },
  { name: 'zoho_get_invoice', summary: 'One invoice: balance, due date, line items and payment references.' },
  { name: 'zoho_get_item', summary: 'One item by id or exact SKU: price, stock per location, reorder level.' },
  {
    name: 'zoho_get_sales_order',
    summary: 'One sales order with line items, packages, tracking and invoices embedded.',
  },
  { name: 'zoho_list_invoices', summary: 'Invoices filtered by status, customer, due date or reference number.' },
  { name: 'zoho_list_sales_orders', summary: 'Sales orders, newest first, with bounded server-side filtering.' },
  { name: 'zoho_search_customers', summary: 'Customers by name, company, email or phone (contact details masked).' },
  { name: 'zoho_search_items', summary: 'Items by text, SKU or name, including low-stock and per-location filters.' },
];
