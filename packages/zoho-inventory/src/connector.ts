import { defineConnector } from '@mb/core';
import type { ZohoApi } from './client';
import { ZOHO_SCOPES } from './scopes';
import { checkStock } from './tools/check-stock';
import { findByPaymentReference } from './tools/find-by-payment-reference';
import { getConnectionStatus } from './tools/get-connection-status';
import { getInvoice } from './tools/get-invoice';
import { getItem } from './tools/get-item';
import { getSalesOrder } from './tools/get-sales-order';
import { listInvoices } from './tools/list-invoices';
import { listSalesOrders } from './tools/list-sales-orders';
import { searchCustomers } from './tools/search-customers';
import { searchItems } from './tools/search-items';

export const zohoInventoryConnector = defineConnector<ZohoApi>({
  id: 'zoho_inventory',
  name: 'Zoho Inventory',
  scopes: ZOHO_SCOPES,
  tools: [
    getConnectionStatus,
    searchItems,
    getItem,
    checkStock,
    listSalesOrders,
    getSalesOrder,
    searchCustomers,
    listInvoices,
    getInvoice,
    findByPaymentReference,
  ],
});
