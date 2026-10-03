import { z } from 'zod';
import { toItemDetail } from '../mappers';
import { itemDetailSchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import { ITEMS_TTL_MS, READ_ONLY, defineTool, exactlyOne, idInput, orgCurrency } from './shared';

const MAX_IDS = 25;
const MAX_SKUS = 5;

const input = z
  .object({
    item_ids: z
      .array(idInput('Zoho item_id'))
      .min(1)
      .max(MAX_IDS)
      .optional()
      .describe(`Up to ${MAX_IDS} item_ids from zoho_search_items.`),
    skus: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(MAX_SKUS)
      .optional()
      .describe(`Up to ${MAX_SKUS} exact SKUs.`),
  })
  .refine(exactlyOne(['item_ids', 'skus']), 'Provide exactly one of item_ids or skus.');

const output = z.object({
  items: z.array(itemDetailSchema.omit({ description: true, item_type: true })),
  not_found: z.array(z.string()).describe('Requested item_ids or SKUs that do not exist.'),
});

export const checkStock = defineTool({
  name: 'zoho_check_stock',
  title: 'Check stock',
  description:
    'Returns stock on hand and available per warehouse/location, reorder level and selling price for several ' +
    `known items in one call: up to ${MAX_IDS} item_ids or up to ${MAX_SKUS} exact SKUs. Use for multi-item ` +
    "availability checks (e.g. every line of a cart). Don't use for a single item (use zoho_get_item) or to " +
    `discover items by name (use zoho_search_items). ${READ_ONLY}`,
  input,
  output,
  scopes: [SCOPE.items, SCOPE.settings],
  async handler(args, ctx) {
    const client = ctx.client;
    const notFound: string[] = [];
    let ids = [...new Set(args.item_ids ?? [])];

    if (args.skus) {
      const skus = [...new Set(args.skus)];
      const lookups = await Promise.all(
        skus.map(async (sku) => {
          const res = await client.get(
            'items',
            { sku, per_page: 10 },
            { cacheTtlMs: ITEMS_TTL_MS },
          );
          const hit = parseUpstream(envelopes.items, res.body).items.find(
            (it) => (it.sku ?? '').toLowerCase() === sku.toLowerCase(),
          );
          return { sku, id: hit?.item_id };
        }),
      );
      for (const l of lookups) {
        if (l.id === undefined) notFound.push(l.sku);
        else ids.push(l.id);
      }
      ids = [...new Set(ids)];
    }

    if (ids.length === 0) return { data: { items: [], not_found: notFound }, upstreamUrl: null };

    const [currency, res] = await Promise.all([
      orgCurrency(client),
      client.get('itemdetails', { item_ids: ids.join(',') }, { cacheTtlMs: ITEMS_TTL_MS }),
    ]);
    const items = parseUpstream(envelopes.items, res.body).items;
    const found = new Set(items.map((it) => it.item_id));
    if (args.item_ids) notFound.push(...ids.filter((id) => !found.has(id)));
    return {
      data: {
        items: items.map((it) => {
          const { description: _d, item_type: _t, ...rest } = toItemDetail(it, currency);
          return rest;
        }),
        not_found: notFound,
      },
      upstreamUrl: null,
      cached: res.cached,
    };
  },
});
