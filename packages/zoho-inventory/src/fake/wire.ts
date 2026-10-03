/**
 * Zoho Inventory wire shapes emitted by FakeZoho, transcribed from docs/vendor/zoho/*.yml (detail responses).
 * Only a documented subset of each record is modelled; fields NOT in the vendored OpenAPI are marked UNVERIFIED.
 * List responses are projections of these records (see LIST_FIELDS in server.ts).
 */

export interface CustomField {
  customfield_id: string | null;
  label: string | null;
  value: string | null;
}

export interface WireAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  fax: string;
}

export interface WireOrganization {
  organization_id: string;
  name: string;
  contact_name: string;
  email: string;
  is_default_org: boolean;
  /** organizations.yml: plan_name/plan_type appear on the list response only. */
  plan_type: number;
  plan_name: string;
  plan_period: string;
  language_code: string;
  fiscal_year_start_month: number;
  account_created_date: string;
  time_zone: string;
  date_format: string;
  is_org_active: boolean;
  currency_id: string;
  currency_code: string;
  currency_symbol: string;
  currency_format: string;
  price_precision: number;
  industry_type: string;
  address: {
    street_address1: string;
    street_address2: string;
    city: string;
    state: string;
    country: string;
    zip: string;
  };
}

export interface WireLocation {
  type: string;
  email: string;
  phone: string;
  address: {
    city: string;
    state: string;
    country: string;
    attention: string | null;
    state_code: string;
    street_address1: string;
    street_address2: string;
  };
  location_id: string;
  location_name: string;
  tax_settings_id: string;
  parent_location_id: string;
  is_all_users_selected: boolean;
  associated_users: { user_id: string; user_name: string }[];
}

export interface WireItemLocation {
  location_id: string;
  location_name: string;
  status: string;
  is_primary: boolean;
  /** items.yml types these three as strings. */
  location_stock_on_hand: string;
  location_available_stock: string;
  location_actual_available_stock: string;
}

export interface WireItem {
  item_id: string;
  name: string;
  status: 'active' | 'inactive';
  source: string | null;
  unit: string;
  item_type: string;
  product_type: string;
  can_be_sold: boolean;
  can_be_purchased: boolean;
  track_inventory: boolean;
  is_taxable: boolean;
  tax_id: string;
  tax_name: string;
  tax_percentage: number;
  description: string;
  purchase_description: string;
  rate: number;
  pricebook_rate: number;
  purchase_rate: number;
  reorder_level: number;
  is_combo_product: boolean;
  is_linked_with_zohocrm: boolean;
  sku: string;
  hsn_or_sac: string;
  locations: WireItemLocation[];
  /** UNVERIFIED: not in items.yml for /items or /items/{id}; real responses are believed to include it. */
  stock_on_hand: number;
  /** UNVERIFIED (see stock_on_hand). */
  available_stock: number;
  /** UNVERIFIED (see stock_on_hand). */
  actual_available_stock: number;
  created_time: string;
  last_modified_time: string;
  custom_fields: CustomField[];
}

export interface WireContactPerson {
  salutation: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  mobile: string;
  is_primary_contact: boolean;
}

export interface WireContact {
  contact_id: string;
  contact_name: string;
  company_name: string;
  has_transaction: boolean;
  contact_type: 'customer' | 'vendor';
  status: 'active' | 'inactive';
  payment_terms: number;
  payment_terms_label: string;
  currency_id: string;
  currency_code: string;
  currency_symbol: string;
  outstanding_receivable_amount: number;
  unused_credits_receivable_amount: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  mobile: string;
  website: string;
  billing_address: WireAddress & { attention: string; street2: string };
  shipping_address: WireAddress & { attention: string; street2: string };
  contact_persons: WireContactPerson[];
  notes: string;
  created_time: string;
  last_modified_time: string;
  custom_fields: CustomField[];
}

export interface WireSalesOrderLine {
  item_id: string;
  line_item_id: string;
  name: string;
  description: string;
  item_order: number;
  bcy_rate: number;
  rate: number;
  quantity: number;
  quantity_invoiced: number;
  quantity_packed: number;
  quantity_shipped: number;
  unit: string;
  tax_id: string;
  tax_name: string;
  tax_type: string;
  tax_percentage: number;
  item_total: number;
  is_invoiced: boolean;
  location_id: string;
  location_name: string;
}

/** Package summary embedded in GET /salesorders/{id} (salesorders.yml `packages`). */
export interface WireSalesOrderPackage {
  package_id: string;
  package_number: string;
  status: string;
  detailed_status: string;
  status_message: string;
  shipment_id: string;
  shipment_number: string;
  shipment_status: string;
  carrier: string;
  service: string;
  tracking_number: string;
  shipment_date: string;
  delivery_days: string;
  delivery_guarantee: boolean;
}

export interface WireSalesOrderInvoice {
  invoice_id: string;
  invoice_number: string;
  status: string;
  date: string;
  due_date: string;
  total: number;
  balance: number;
}

export interface WireSalesOrder {
  salesorder_id: string;
  salesorder_number: string;
  date: string;
  status: string;
  shipment_date: string;
  shipment_days: number;
  reference_number: string;
  customer_id: string;
  customer_name: string;
  currency_id: string;
  currency_code: string;
  currency_symbol: string;
  exchange_rate: number;
  discount_amount: number;
  discount: string;
  is_discount_before_tax: boolean;
  discount_type: string;
  delivery_method: string;
  is_inclusive_tax: boolean;
  sales_channel: string;
  is_dropshipped: boolean;
  is_backordered: boolean;
  line_items: WireSalesOrderLine[];
  location_id: string;
  location_name: string;
  shipping_charge: number;
  adjustment: number;
  sub_total: number;
  tax_total: number;
  total: number;
  bcy_total: number;
  taxes: { tax_name: string; tax_amount: number }[];
  price_precision: number;
  is_emailed: boolean;
  quantity: number;
  quantity_invoiced: number;
  quantity_packed: number;
  quantity_shipped: number;
  packages: WireSalesOrderPackage[];
  invoices: WireSalesOrderInvoice[];
  billing_address: WireAddress;
  shipping_address: WireAddress;
  notes: string;
  terms: string;
  custom_fields: CustomField[];
  created_time: string;
  last_modified_time: string;
}

export interface WireInvoiceLine {
  line_item_id: string;
  item_id: string;
  name: string;
  description: string;
  item_order: number;
  bcy_rate: number;
  rate: number;
  quantity: number;
  unit: string;
  discount_amount: number;
  discount: number;
  tax_id: string;
  tax_name: string;
  tax_type: string;
  tax_percentage: number;
  item_total: number;
  location_id: string;
  location_name: string;
}

export interface WireInvoice {
  invoice_id: string;
  invoice_number: string;
  date: string;
  status: string;
  payment_terms: number;
  payment_terms_label: string;
  due_date: string;
  due_days: string;
  payment_expected_date: string;
  last_payment_date: string;
  reference_number: string;
  customer_id: string;
  customer_name: string;
  currency_id: string;
  currency_code: string;
  exchange_rate: number;
  is_viewed_by_client: boolean;
  has_attachment: boolean;
  line_items: WireInvoiceLine[];
  location_id: string;
  location_name: string;
  shipping_charge: number;
  adjustment: number;
  sub_total: number;
  tax_total: number;
  total: number;
  taxes: { tax_name: string; tax_amount: number }[];
  payment_made: number;
  credits_applied: number;
  balance: number;
  write_off_amount: number;
  allow_partial_payments: boolean;
  price_precision: number;
  is_emailed: boolean;
  reminders_sent: number;
  billing_address: WireAddress;
  shipping_address: WireAddress;
  notes: string;
  terms: string;
  custom_fields: CustomField[];
  created_time: string;
  last_modified_time: string;
  /** UNVERIFIED: not in invoices.yml; believed present on invoices raised from a sales order (smoke probe). */
  salesorder_id: string;
  /** UNVERIFIED (see salesorder_id). */
  salesorder_number: string;
}

export interface WirePaymentInvoice {
  invoice_id: string;
  invoice_number: string;
  date: string;
  invoice_amount: number;
  amount_applied: number;
  balance_amount: number;
}

export interface WirePayment {
  payment_id: string;
  payment_number: string;
  payment_mode: string;
  amount: number;
  bcy_amount: number;
  amount_refunded: number;
  bank_charges: number;
  date: string;
  status: 'success' | 'failure';
  reference_number: string;
  description: string;
  customer_id: string;
  customer_name: string;
  email: string;
  tax_amount_withheld: number;
  invoices: WirePaymentInvoice[];
  exchange_rate: number;
  currency_id: string;
  currency_code: string;
  currency_symbol: string;
  account_id: string;
  account_name: string;
  unused_amount: number;
  location_id: string;
  location_name: string;
  custom_fields: CustomField[];
}

export interface WireShipmentOrderRef {
  carrier: string;
  delivery_days: number;
  delivery_guarantee: boolean;
  delivery_method: string;
  detailed_status: string;
  notes: string;
  service: string;
  shipment_id: string;
  shipment_number: string;
  shipment_rate: number;
  shipping_date: string;
  status: 'shipped' | 'delivered';
  tracking_number: string;
}

export interface WirePackageLine {
  line_item_id: string;
  so_line_item_id: string;
  item_id: string;
  item_order: number;
  name: string;
  description: string;
  sku: string;
  quantity: number;
  unit: string;
  is_invoiced: boolean;
}

/** GET /packages/{id} — packages.yml wraps the detail record in a `package` array. */
export interface WirePackage {
  package_id: string;
  package_number: string;
  salesorder_id: string;
  salesorder_number: string;
  date: string;
  customer_id: string;
  customer_name: string;
  email: string;
  phone: string;
  mobile: string;
  notes: string;
  is_emailed: boolean;
  total_quantity: number;
  line_items: WirePackageLine[];
  billing_address: WireAddress & { phone: string };
  shipping_address: WireAddress & { phone: string };
  /** null while the package has not been shipped. */
  shipment_order: WireShipmentOrderRef | null;
  created_time: string;
  last_modified_time: string;
  custom_fields: CustomField[];
}
