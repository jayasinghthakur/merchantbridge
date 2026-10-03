import { ConnectorError } from '@mb/core';
import { z } from 'zod';
import { toSalesOrderDetail } from '../mappers';
import { salesOrderDetailSchema } from '../schemas';
import { SCOPE } from '../scopes';
import { envelopes, parseUpstream } from '../upstream';
import {
  READ_ONLY,
  SCAN_MAX_PAGES,
  SCAN_PAGE_SIZE,
  defineTool,
  exactlyOne,
  idInput,
  namedNotFound,
  scanSalesOrders,
} from './shared';

const input = z
  .object({
    salesorder_id: idInput('Zoho salesorder_id').optional(),
    salesorder_number: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_\-/]{0,49}$/, 'e.g. SO-00012')
      .optional()
      .describe('Sales order number as shown to humans, e.g. "SO-00012".'),
  })
  .refine(
    exactlyOne(['salesorder_id', 'salesorder_number']),
    'Provide exactly one of salesorder_id or salesorder_number.',
  );

export const getSalesOrder = defineTool({
  name: 'zoho_get_sales_order',
  title: 'Get sales order',
  description:
    'Returns one sales order with its line items, shipments (package, carrier, tracking number, shipment date, ' +
    'delivered flag, courier status) and linked invoices (status, due date, balance), all in one upstream call. ' +
    'Use when the user asks about a specific order, what was shipped, tracking or delivery status, or to build ' +
    "dispute evidence after zoho_find_by_payment_reference. Don't use to list or filter many orders (use " +
    'zoho_list_sales_orders). Pass exactly one of salesorder_id or salesorder_number; lookup by number scans ' +
    `the ${SCAN_MAX_PAGES * SCAN_PAGE_SIZE} most recent orders. ${READ_ONLY}`,
  input,
  output: salesOrderDetailSchema,
  scopes: [SCOPE.salesorders],
  async handler(args, ctx) {
    const client = ctx.client;
    let id = args.salesorder_id;
    if (id === undefined) {
      const wanted = (args.salesorder_number ?? '').toUpperCase();
      const isWanted = (n: string | null): boolean => (n ?? '').toUpperCase() === wanted;
      const scan = await scanSalesOrders(client, {}, (batch) =>
        batch.some((so) => isWanted(so.salesorder_number)),
      );
      const hit = scan.rows.find((so) => isWanted(so.salesorder_number));
      if (!hit) {
        throw new ConnectorError('NOT_FOUND', `No sales order numbered ${wanted} was found.`, {
          hint: scan.complete
            ? 'Check the number; it does not exist in this organization.'
            : `Only the ${SCAN_MAX_PAGES * SCAN_PAGE_SIZE} most recent orders were checked; pass salesorder_id if known.`,
        });
      }
      id = hit.salesorder_id;
    }
    const res = await namedNotFound(
      client.get(`salesorders/${id}`),
      `No sales order with salesorder_id ${id} was found.`,
    );
    const so = parseUpstream(envelopes.salesorder, res.body).salesorder;
    return {
      data: toSalesOrderDetail(so),
      upstreamUrl: client.webUrl('salesorder', so.salesorder_id),
    };
  },
});
