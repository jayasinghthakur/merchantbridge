import { z } from 'zod';
import { toItemSummary } from '../mappers';
import { itemSummarySchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import {
  ITEMS_TTL_MS,
  READ_ONLY,
  cursorInput,
  defineTool,
  fingerprint,
  idInput,
  limitInput,
  orgCurrency,
  pageRows,
  readPageCursor,
  searchText,
} from './shared';

const input = z.object({
  query: searchText(
    'Free-text search over item name, SKU and other searchable fields, e.g. "masala chai".',
  ).optional(),
  sku: z.string().trim().min(1).max(100).optional().describe('Exact SKU, e.g. "CHAI-250".'),
  name_contains: searchText('Only items whose name contains this text.').optional(),
  low_stock_only: z
    .boolean()
    .optional()
    .describe('Only active items at or below their reorder level.'),
  status: z.enum(['active', 'inactive']).optional().describe('Item status; omit for both.'),
  location_id: idInput(
    'Only items stocked at this location_id (from zoho_get_item locations)',
  ).optional(),
  limit: limitInput,
  cursor: cursorInput,
});

export const searchItems = defineTool({
  name: 'zoho_search_items',
  title: 'Search items',
  description:
    'Searches the Zoho Inventory product catalogue and returns matching items: item_id, name, SKU, selling ' +
    'price (minor units), total stock on hand and available, reorder level and a low-stock flag. Use when the ' +
    'user names a product loosely ("masala chai", "kettle"), asks what is low on stock, or you need an item_id. ' +
    "Don't use when you have an exact SKU or item_id and need per-warehouse stock (use zoho_get_item) or several " +
    'known items at once (use zoho_check_stock). Up to 100 per page; paginate with cursor. ' +
    READ_ONLY,
  input,
  output: z.object({ items: z.array(itemSummarySchema) }),
  scopes: [SCOPE.items, SCOPE.settings],
  async handler(args, ctx) {
    const { limit, cursor, ...filters } = args;
    const state = readPageCursor(cursor, limit, fingerprint(filters));
    const currency = await orgCurrency(ctx.client);
    const res = await ctx.client.get(
      'items',
      {
        page: state.page,
        per_page: state.perPage,
        search_text: filters.query,
        sku: filters.sku,
        name_contains: filters.name_contains,
        filter_by: filters.low_stock_only ? 'Status.Lowstock' : undefined,
        status: filters.status,
        location_id: filters.location_id,
      },
      { cacheTtlMs: ITEMS_TTL_MS },
    );
    const body = parseUpstream(envelopes.items, res.body);
    const { rows, page } = pageRows(
      state,
      body.items.map((it) => toItemSummary(it, currency)),
      body.page_context.has_more_page,
    );
    // The org currency is a side lookup; `cached` describes the items themselves.
    return { data: { items: rows }, page, upstreamUrl: null, cached: res.cached };
  },
});
