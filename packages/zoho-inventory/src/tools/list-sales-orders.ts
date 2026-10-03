import { z } from 'zod';
import { isoDate, toSalesOrderSummary } from '../mappers';
import { salesOrderSummarySchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import type { UpstreamSalesOrder } from '../upstream';
import {
  READ_ONLY,
  SCAN_MAX_PAGES,
  SCAN_PAGE_SIZE,
  cursorInput,
  dateInput,
  defineTool,
  fingerprint,
  idInput,
  limitInput,
  offsetPage,
  pageRows,
  readOffsetCursor,
  readPageCursor,
  rowsWithinBudget,
  scanSalesOrders,
} from './shared';

/**
 * UNVERIFIED: salesorders.yml documents only page/per_page on GET /salesorders. Flip to true only after
 * scripts/smoke.ts shows Zoho honours customer_id / status / date_start / date_end there; until then filters
 * run client-side over a bounded scan.
 */
const SERVER_SIDE_SO_FILTERS = false;

export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partially_shipped',
  'shipped',
  'fulfilled',
  'closed',
  'void',
  'onhold',
] as const;

const input = z.object({
  customer_id: idInput(
    'Only orders of this customer (contact_id from zoho_search_customers)',
  ).optional(),
  status: z
    .enum(SALES_ORDER_STATUSES)
    .optional()
    .describe('Only orders in this status ("void" = cancelled).'),
  date_from: dateInput('Only orders dated on or after this date').optional(),
  date_to: dateInput('Only orders dated on or before this date').optional(),
  limit: limitInput,
  cursor: cursorInput,
});

const scanSchema = z
  .object({
    bounded: z.literal(true),
    scanned: z.number().int().describe('Most recent orders checked against the filters.'),
    max_scanned: z.number().int(),
    more_beyond_scan: z.boolean().describe('True when older orders exist that were not checked.'),
  })
  .nullable()
  .describe('Present when filters were applied by scanning recent orders.');

type Filters = Omit<z.output<typeof input>, 'limit' | 'cursor'>;

function matches(so: UpstreamSalesOrder, f: Filters): boolean {
  if (f.customer_id !== undefined && so.customer_id !== f.customer_id) return false;
  if (f.status !== undefined && (so.status ?? '').toLowerCase() !== f.status) return false;
  const d = isoDate(so.date);
  if (f.date_from !== undefined && (d === null || d < f.date_from)) return false;
  if (f.date_to !== undefined && (d === null || d > f.date_to)) return false;
  return true;
}

export const listSalesOrders = defineTool({
  name: 'zoho_list_sales_orders',
  title: 'List sales orders',
  description:
    'Lists sales orders newest first: salesorder_id, number, date, status, customer, total (minor units). ' +
    'Optional filters: customer_id, status (void = cancelled) and date range. Zoho documents no server-side ' +
    `filters for sales orders, so filtered queries only check the ${SCAN_MAX_PAGES * SCAN_PAGE_SIZE} most recent ` +
    'orders; data.scan.more_beyond_scan says when older orders were not checked. Use when the user asks for a ' +
    "customer's order history (get customer_id from zoho_search_customers first), cancellations, or orders in a " +
    "status/date range. Don't use for one order's line items, shipments or tracking (use zoho_get_sales_order). " +
    READ_ONLY,
  input,
  output: z.object({ sales_orders: z.array(salesOrderSummarySchema), scan: scanSchema }),
  scopes: [SCOPE.salesorders],
  async handler(args, ctx) {
    const { limit, cursor, ...filters } = args;
    const fp = fingerprint(filters);
    const filtered = Object.values(filters).some((v) => v !== undefined);

    if (!filtered || SERVER_SIDE_SO_FILTERS) {
      const state = readPageCursor(cursor, limit, fp);
      const res = await ctx.client.get('salesorders', {
        page: state.page,
        per_page: state.perPage,
        // UNVERIFIED parameter names; only sent when SERVER_SIDE_SO_FILTERS is enabled.
        customer_id: filters.customer_id,
        status: filters.status,
        date_start: filters.date_from,
        date_end: filters.date_to,
      });
      const body = parseUpstream(envelopes.salesorders, res.body);
      const { rows, page } = pageRows(
        state,
        body.salesorders.map(toSalesOrderSummary),
        body.page_context.has_more_page,
      );
      return { data: { sales_orders: rows, scan: null }, page, upstreamUrl: null };
    }

    const offset = readOffsetCursor(cursor, fp);
    const scan = await scanSalesOrders(ctx.client, {});
    const hits = scan.rows
      .filter((so) => matches(so, filters))
      .sort(
        (a, b) =>
          (b.date ?? '').localeCompare(a.date ?? '') ||
          (b.salesorder_number ?? '').localeCompare(a.salesorder_number ?? ''),
      );
    const window = hits.slice(offset, offset + limit).map(toSalesOrderSummary);
    const taken = window.slice(0, rowsWithinBudget(window));
    return {
      data: {
        sales_orders: taken,
        scan: {
          bounded: true as const,
          scanned: scan.rows.length,
          max_scanned: SCAN_MAX_PAGES * SCAN_PAGE_SIZE,
          more_beyond_scan: !scan.complete,
        },
      },
      page: offsetPage(offset, taken.length, hits.length, fp),
      upstreamUrl: null,
    };
  },
});
