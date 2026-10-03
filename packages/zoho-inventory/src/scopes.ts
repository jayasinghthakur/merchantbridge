/** Every scope is requested on first consent: re-consents burn one of Zoho's 20 refresh tokens per user per client. */
export const ZOHO_SCOPES = [
  'ZohoInventory.settings.READ',
  'ZohoInventory.items.READ',
  'ZohoInventory.salesorders.READ',
  'ZohoInventory.invoices.READ',
  'ZohoInventory.contacts.READ',
  'ZohoInventory.packages.READ',
  'ZohoInventory.shipmentorders.READ',
  'ZohoInventory.customerpayments.READ',
] as const;

export type ZohoScope = (typeof ZOHO_SCOPES)[number];

export const SCOPE = {
  settings: 'ZohoInventory.settings.READ',
  items: 'ZohoInventory.items.READ',
  salesorders: 'ZohoInventory.salesorders.READ',
  invoices: 'ZohoInventory.invoices.READ',
  contacts: 'ZohoInventory.contacts.READ',
  packages: 'ZohoInventory.packages.READ',
  shipmentorders: 'ZohoInventory.shipmentorders.READ',
  customerpayments: 'ZohoInventory.customerpayments.READ',
} as const satisfies Record<string, ZohoScope>;
