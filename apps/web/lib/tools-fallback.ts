/**
 * Static copy of the tool surface (docs/PLAN.md §4, Tier 1 plus zoho_check_stock), in tools/list order. Shown on
 * the home page and on /docs when the live /api/tools call fails. The live list from the API is authoritative.
 */
export interface StaticTool {
  name: string;
  summary: string;
}

export const STATIC_TOOLS: readonly StaticTool[] = [
  {
    name: 'zoho_check_stock',
    summary:
      'Stock per location, reorder level and price for several known items at once: up to 25 ids or 5 SKUs.',
  },
  {
    name: 'zoho_find_by_payment_reference',
    summary:
      'A Razorpay pay_ / order_ / rfnd_ id or UPI UTR to the payment, the invoices it paid and the order shipped.',
  },
  {
    name: 'zoho_get_connection_status',
    summary:
      'Organization, data center, plan, requested scopes, remaining daily budget and circuit state.',
  },
  {
    name: 'zoho_get_invoice',
    summary: 'One invoice: balance, due date, line items and the linked sales order.',
  },
  {
    name: 'zoho_get_item',
    summary: 'One item by id or exact SKU: price, stock per location, reorder level.',
  },
  {
    name: 'zoho_get_sales_order',
    summary: 'One sales order with line items, packages, tracking and invoices embedded.',
  },
  {
    name: 'zoho_list_invoices',
    summary: 'Invoices filtered by status, customer, due date or reference number.',
  },
  {
    name: 'zoho_list_sales_orders',
    summary:
      'Sales orders filtered by customer, status or date within the first 600 orders Zoho returns (believed newest first).',
  },
  {
    name: 'zoho_search_customers',
    summary: 'Customers by name, company, email or phone (contact details masked).',
  },
  {
    name: 'zoho_search_items',
    summary: 'Items by text, SKU or name, including low-stock and per-location filters.',
  },
];
