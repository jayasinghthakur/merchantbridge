import { ConnectorError } from '@mb/core';
import { z } from 'zod';
import { toItemDetail } from '../mappers';
import { itemDetailSchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import {
  ITEMS_TTL_MS,
  READ_ONLY,
  defineTool,
  exactlyOne,
  idInput,
  namedNotFound,
  orgCurrency,
} from './shared';

const input = z
  .object({
    item_id: idInput('Zoho item_id').optional(),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Exact SKU, e.g. "CHAI-250" (case-insensitive).'),
  })
  .refine(exactlyOne(['item_id', 'sku']), 'Provide exactly one of item_id or sku.');

export const getItem = defineTool({
  name: 'zoho_get_item',
  title: 'Get item',
  description:
    'Returns one item by item_id or exact SKU: name, selling price (minor units), stock on hand and available ' +
    'per warehouse/location, reorder level, low-stock flag and description. Use when the user gives a SKU or ' +
    'asks "is X in stock at <warehouse>?" or "what does X cost?". Don\'t use for loose name searches (use ' +
    'zoho_search_items) or for many items at once (use zoho_check_stock). Pass exactly one of item_id or sku. ' +
    READ_ONLY,
  input,
  output: itemDetailSchema,
  scopes: [SCOPE.items, SCOPE.settings],
  async handler(args, ctx) {
    const client = ctx.client;
    let itemId = args.item_id;
    if (itemId === undefined) {
      const sku = args.sku ?? '';
      const res = await client.get('items', { sku, per_page: 10 }, { cacheTtlMs: ITEMS_TTL_MS });
      const match = parseUpstream(envelopes.items, res.body).items.find(
        (it) => it.sku !== null && it.sku.toLowerCase() === sku.toLowerCase(),
      );
      if (!match) {
        throw new ConnectorError('NOT_FOUND', `No item with SKU "${sku}" was found.`, {
          hint: 'Check the SKU, or use zoho_search_items with a name or partial SKU.',
        });
      }
      itemId = match.item_id;
    }
    const [currency, res] = await Promise.all([
      orgCurrency(client),
      namedNotFound(
        client.get(`items/${itemId}`, undefined, { cacheTtlMs: ITEMS_TTL_MS }),
        `No item with item_id ${itemId} was found.`,
      ),
    ]);
    const item = parseUpstream(envelopes.item, res.body).item;
    return {
      data: toItemDetail(item, currency),
      upstreamUrl: client.webUrl('item', item.item_id),
      cached: res.cached,
    };
  },
});
